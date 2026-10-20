"""WebSocket JSON-RPC client for an already-running local Codex app-server."""
import base64
import hashlib
import json
import logging
import os
import queue
import secrets
import socket
import stat
import struct
import threading
from pathlib import Path

from bridge.features.sessions.side_chat import SideChatError


_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
_MAX_HEADERS = 16 * 1024
_MAX_MESSAGE = 32 * 1024 * 1024
_READ_POLL_SECONDS = 0.25
_HANDSHAKE_TIMEOUT = 5
_EVENT_STOP = object()


def _accept_value(key):
    return base64.b64encode(hashlib.sha1((key + _ACCEPT_GUID).encode('ascii')).digest()).decode('ascii')


def _client_frame(opcode, payload, fin=True):
    """Return one masked RFC 6455 client frame."""
    if len(payload) > _MAX_MESSAGE:
        raise SideChatError('Codex 消息超过 32 MiB 限制')
    first = (0x80 if fin else 0) | opcode
    length = len(payload)
    mask = secrets.token_bytes(4)
    if length < 126:
        header = bytes((first, 0x80 | length))
    elif length <= 0xFFFF:
        header = bytes((first, 0x80 | 126)) + struct.pack('!H', length)
    else:
        header = bytes((first, 0x80 | 127)) + struct.pack('!Q', length)
    masked = bytes(byte ^ mask[index & 3] for index, byte in enumerate(payload))
    return header + mask + masked


class _Connection:
    def __init__(self, owner, stream, generation, leftover=b''):
        self.owner = owner
        self.stream = stream
        self.generation = generation
        self.buffer = bytearray(leftover)
        self.lock = threading.RLock()
        self.send_lock = threading.Lock()
        self.pending = {}
        self.counter = 0
        self.alive = True
        self.local_closing = False
        self.reader = threading.Thread(target=owner._read_loop, args=(self,),
                                       name=f'codex-shared-ws-{generation}', daemon=True)

    def recv_exact(self, length):
        while len(self.buffer) < length:
            with self.lock:
                if not self.alive:
                    raise EOFError('WebSocket connection closed')
            try:
                chunk = self.stream.recv(max(4096, length - len(self.buffer)))
            except socket.timeout:
                continue
            if not chunk:
                raise EOFError('WebSocket peer disconnected')
            self.buffer.extend(chunk)
        result = bytes(self.buffer[:length])
        del self.buffer[:length]
        return result

    def read_frame(self):
        first, second = self.recv_exact(2)
        if first & 0x70:
            raise ValueError('WebSocket extensions are not supported')
        if second & 0x80:
            raise ValueError('server WebSocket frames must not be masked')
        fin, opcode = bool(first & 0x80), first & 0x0F
        marker = second & 0x7F
        if marker == 126:
            length = struct.unpack('!H', self.recv_exact(2))[0]
            if length < 126:
                raise ValueError('non-canonical WebSocket frame length')
        elif marker == 127:
            raw_length = self.recv_exact(8)
            if raw_length[0] & 0x80:
                raise ValueError('invalid WebSocket frame length')
            length = struct.unpack('!Q', raw_length)[0]
            if length <= 0xFFFF:
                raise ValueError('non-canonical WebSocket frame length')
        else:
            length = marker
        if opcode >= 8 and (not fin or length > 125):
            raise ValueError('invalid WebSocket control frame')
        if length > _MAX_MESSAGE:
            raise ValueError('WebSocket message exceeds 32 MiB limit')
        if opcode not in (0, 1, 2, 8, 9, 10):
            raise ValueError('unknown WebSocket opcode')
        return fin, opcode, self.recv_exact(length)

    def read_message(self):
        fragments = None
        total = 0
        while True:
            fin, opcode, payload = self.read_frame()
            if opcode == 9:
                self.owner._send_control(self, 10, payload)
                continue
            if opcode == 10:
                continue
            if opcode == 8:
                return None
            if opcode == 2:
                raise ValueError('binary WebSocket messages are not supported')
            if opcode == 1:
                if fragments is not None:
                    raise ValueError('interleaved WebSocket data messages')
                if fin:
                    return payload.decode('utf-8')
                fragments, total = [payload], len(payload)
                continue
            if fragments is None:
                raise ValueError('unexpected WebSocket continuation frame')
            total += len(payload)
            if total > _MAX_MESSAGE:
                raise ValueError('WebSocket message exceeds 32 MiB limit')
            fragments.append(payload)
            if fin:
                return b''.join(fragments).decode('utf-8')


class _ProcessHealth:
    """Compatibility view for callers that check process.poll()."""
    def __init__(self, runtime):
        self.runtime = runtime

    def poll(self):
        return None if self.runtime.running else 1


class SharedRuntime:
    """Attach to a same-user local app-server without owning its process."""
    shared = True

    def __init__(self, socket_path, event, home=None):
        self.socket_path = os.fsdecode(os.fspath(socket_path))
        self.event = event
        self.home = Path(home) if home is not None else None
        self.process = _ProcessHealth(self)
        self._lock = threading.RLock()
        self._start_lock = threading.RLock()
        self._active = None
        self._last = None
        self._generation = 0
        self._closed = False
        self._events = queue.Queue()
        self._event_thread = None

    @property
    def running(self):
        with self._lock:
            return self._active is not None and self._active.alive

    def _ensure_event_thread(self):
        if self._event_thread is None or not self._event_thread.is_alive():
            self._events = queue.Queue()
            self._event_thread = threading.Thread(target=self._dispatch_events,
                                                  name='codex-shared-ws-events', daemon=True)
            self._event_thread.start()

    def _dispatch_events(self):
        while True:
            value = self._events.get()
            if value is _EVENT_STOP:
                return
            connection, message = value
            with self._lock:
                current = (not connection.local_closing and
                           connection.generation == self._generation)
            if not current:
                continue
            try:
                self.event(message)
            except Exception:
                logging.exception('Shared Codex event callback failed')
                continue

    def _validate_socket_path(self):
        if not os.path.isabs(self.socket_path):
            raise SideChatError('Codex 控制 socket 必须使用本机绝对路径')
        if not hasattr(os, 'getuid'):
            raise SideChatError('无法验证 Codex 控制 socket 的本机用户')
        try:
            canonical = Path(self.socket_path).resolve(strict=True)
            details = canonical.stat()
        except OSError as exc:
            raise SideChatError('找不到本机 Codex 控制 socket') from exc
        if not stat.S_ISSOCK(details.st_mode):
            raise SideChatError('配置路径不是 Unix socket')
        if details.st_uid != os.getuid():
            raise SideChatError('Codex 控制 socket 所有者与当前用户不一致')
        return str(canonical)

    def _connect(self):
        path = self._validate_socket_path()
        stream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            stream.settimeout(_HANDSHAKE_TIMEOUT)
            stream.connect(path)
            if not hasattr(socket, 'SO_PEERCRED'):
                raise SideChatError('无法验证 Codex 控制 socket 的连接用户')
            credentials = stream.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
            _pid, uid, _gid = struct.unpack('3i', credentials)
            if uid != os.getuid():
                raise SideChatError('Codex 控制 socket 的连接用户与当前用户不一致')
            return stream
        except Exception:
            stream.close()
            raise

    @staticmethod
    def _read_upgrade(stream):
        response = bytearray()
        end = -1
        while end < 0:
            chunk = stream.recv(4096)
            if not chunk:
                raise SideChatError('Codex WebSocket 握手连接已关闭')
            response.extend(chunk)
            end = response.find(b'\r\n\r\n')
            if end < 0 and len(response) > _MAX_HEADERS:
                raise SideChatError('Codex WebSocket 握手响应超过大小限制')
            if end >= 0 and end + 4 > _MAX_HEADERS:
                raise SideChatError('Codex WebSocket 握手响应超过大小限制')
        end += 4
        raw_headers, leftover = bytes(response[:end]), bytes(response[end:])
        try:
            lines = raw_headers.decode('ascii').split('\r\n')
        except UnicodeDecodeError as exc:
            raise SideChatError('Codex WebSocket 握手响应格式无效') from exc
        if not lines or len(lines[0].split()) < 2 or lines[0].split()[1] != '101':
            raise SideChatError('Codex WebSocket 握手未升级连接')
        headers = {}
        for line in lines[1:]:
            if not line:
                continue
            if ':' not in line:
                raise SideChatError('Codex WebSocket 握手响应格式无效')
            name, value = line.split(':', 1)
            key = name.strip().lower()
            headers[key] = (headers[key] + ',' + value.strip()) if key in headers else value.strip()
        tokens = {part.strip().lower() for part in headers.get('connection', '').split(',')}
        if headers.get('upgrade', '').lower() != 'websocket' or 'upgrade' not in tokens:
            raise SideChatError('Codex WebSocket 握手响应缺少升级标记')
        return headers, leftover

    def _websocket_upgrade(self, stream):
        key = base64.b64encode(secrets.token_bytes(16)).decode('ascii')
        request = ('GET / HTTP/1.1\r\n'
                   'Host: localhost\r\n'
                   'Upgrade: websocket\r\n'
                   'Connection: Upgrade\r\n'
                   f'Sec-WebSocket-Key: {key}\r\n'
                   'Sec-WebSocket-Version: 13\r\n\r\n').encode('ascii')
        stream.sendall(request)
        headers, leftover = self._read_upgrade(stream)
        expected = _accept_value(key)
        if headers.get('sec-websocket-accept') != expected:
            raise SideChatError('Codex WebSocket 握手校验失败')
        if 'sec-websocket-extensions' in headers or 'sec-websocket-protocol' in headers:
            raise SideChatError('Codex WebSocket 握手返回了未请求的扩展')
        return leftover

    def start(self):
        with self._start_lock:
            with self._lock:
                if self._closed:
                    raise SideChatError('共享 Codex 连接已关闭')
                if self._active is not None and self._active.alive:
                    return
                previous = self._last
            if previous is not None and previous.reader is not threading.current_thread():
                previous.reader.join(timeout=2)
            stream = self._connect()
            try:
                leftover = self._websocket_upgrade(stream)
                stream.settimeout(_READ_POLL_SECONDS)
            except Exception as exc:
                stream.close()
                if isinstance(exc, SideChatError):
                    raise
                raise SideChatError('无法建立本机 Codex WebSocket 连接') from exc

            self._ensure_event_thread()
            with self._lock:
                self._generation += 1
                connection = _Connection(self, stream, self._generation, leftover)
                self._active = connection
                self._last = connection
            connection.reader.start()
            try:
                self._request_on(connection, 'initialize', {
                    'clientInfo': {'name': 'pi_web_shared', 'version': '0.1'},
                    'capabilities': {'experimentalApi': True},
                }, 30)
                self._write_on(connection, {'method': 'initialized'})
            except Exception:
                self._disconnect(connection, notify=True)
                raise

    def _write_on(self, connection, value):
        try:
            payload = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        except (ValueError, TypeError) as exc:
            raise SideChatError('Codex 请求数据无法序列化') from exc
        if len(payload) > _MAX_MESSAGE:
            raise SideChatError('Codex 消息超过 32 MiB 限制')
        frame = _client_frame(1, payload)
        try:
            with connection.send_lock:
                with connection.lock:
                    if not connection.alive:
                        raise SideChatError('共享 Codex 运行时已断开')
                connection.stream.sendall(frame)
        except SideChatError as error:
            error.dispatched = False
            raise
        except OSError as exc:
            self._disconnect(connection, notify=True)
            error = SideChatError('共享 Codex 运行时已断开')
            error.dispatched = True  # sendall may have partially/completely written.
            raise error from exc

    def write(self, value):
        with self._lock:
            connection = self._active
        if connection is None or not connection.alive:
            raise SideChatError('共享 Codex 运行时尚未连接')
        self._write_on(connection, value)

    def request(self, method, params, timeout=30):
        try:
            self.start()
        except Exception as error:
            error.dispatched = False  # This user operation has not been written.
            raise
        with self._lock:
            connection = self._active
        if connection is None or not connection.alive:
            raise SideChatError('共享 Codex 运行时已断开')
        return self._request_on(connection, method, params, timeout)

    def _request_on(self, connection, method, params, timeout):
        result = queue.Queue(maxsize=1)
        with connection.lock:
            if not connection.alive:
                raise SideChatError('共享 Codex 运行时已断开')
            connection.counter += 1
            identifier = f'{connection.generation}:{connection.counter}'
            connection.pending[identifier] = result
        try:
            self._write_on(connection, {'id': identifier, 'method': method, 'params': params})
            try:
                response = result.get(timeout=timeout)
            except queue.Empty as exc:
                raise SideChatError('共享 Codex 操作结果未确认，请刷新状态，不要重复发送') from exc
            if response is None:
                raise SideChatError('共享 Codex 运行时已断开')
            if 'error' in response:
                error = SideChatError('Codex 未完成共享会话操作，请检查请求和运行时版本')
                error.rpc_error = response['error']
                raise error
            return response.get('result') or {}
        finally:
            with connection.lock:
                connection.pending.pop(identifier, None)

    def _send_control(self, connection, opcode, payload):
        frame = _client_frame(opcode, payload)
        try:
            with connection.send_lock:
                with connection.lock:
                    if not connection.alive:
                        return
                connection.stream.sendall(frame)
        except OSError:
            self._disconnect(connection, notify=True)

    def _read_loop(self, connection):
        notify = False
        try:
            while True:
                raw = connection.read_message()
                if raw is None:
                    notify = True
                    break
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise ValueError('JSON-RPC message must be an object')
                if 'method' in value:
                    self._events.put((connection, value))
                    continue
                with connection.lock:
                    pending = connection.pending.get(value.get('id'))
                if pending is not None:
                    try:
                        pending.put_nowait(value)
                    except queue.Full:
                        pass
        except (EOFError, OSError, ValueError, UnicodeError, json.JSONDecodeError):
            notify = True
        finally:
            self._disconnect(connection, notify=notify and not connection.local_closing)

    def _disconnect(self, connection, notify):
        notify = notify and not connection.local_closing
        with connection.lock:
            if not connection.alive:
                return
            connection.alive = False
            pending = tuple(connection.pending.values())
            connection.pending.clear()
        with self._lock:
            if self._active is connection:
                self._active = None
        for result in pending:
            try:
                result.put_nowait(None)
            except queue.Full:
                pass
        try:
            connection.stream.close()
        except OSError:
            pass
        if notify:
            self._events.put((connection, {'method': 'bridge/disconnected'}))

    def close(self):
        with self._start_lock:
            with self._lock:
                if self._closed:
                    return
                self._closed = True
                connection = self._active or self._last
                if connection is not None:
                    connection.local_closing = True
                self._active = None
            if connection is not None:
                self._disconnect(connection, notify=False)
            self._events.put(_EVENT_STOP)
            event_thread = self._event_thread
        if connection is not None and connection.reader is not threading.current_thread():
            connection.reader.join(timeout=2)
        if event_thread is not None and event_thread is not threading.current_thread():
            event_thread.join(timeout=2)
