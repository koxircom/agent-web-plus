"""Focused protocol tests for the shared app-server WebSocket transport."""
import base64
import hashlib
import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge.clients.codex.shared_runtime import SharedRuntime
from bridge.features.sessions.side_chat import SideChatError


GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def _recv_exact(stream, length):
    result = bytearray()
    while len(result) < length:
        chunk = stream.recv(length - len(result))
        if not chunk:
            raise EOFError('client disconnected')
        result.extend(chunk)
    return bytes(result)


def _read_http_request(stream):
    result = bytearray()
    while b'\r\n\r\n' not in result:
        chunk = stream.recv(4096)
        if not chunk:
            raise EOFError('client closed before HTTP upgrade')
        result.extend(chunk)
        if len(result) > 16 * 1024:
            raise AssertionError('request headers exceeded bound')
    headers = result.split(b'\r\n\r\n', 1)[0].decode('ascii').split('\r\n')
    return {name.lower(): value.strip() for name, value in
            (line.split(':', 1) for line in headers[1:] if ':' in line)}


def _send_partial(stream, payload):
    stream.sendall(payload[:1])
    time.sleep(0.01)
    stream.sendall(payload[1:])


def _send_frame(stream, opcode, payload, fin=True, partial=False):
    first = (0x80 if fin else 0) | opcode
    length = len(payload)
    if length < 126:
        header = bytes((first, length))
    elif length <= 0xFFFF:
        header = bytes((first, 126)) + length.to_bytes(2, 'big')
    else:
        header = bytes((first, 127)) + length.to_bytes(8, 'big')
    frame = header + payload
    if partial:
        _send_partial(stream, frame)
    else:
        stream.sendall(frame)


def _read_client_frame(stream):
    first, second = _recv_exact(stream, 2)
    if not second & 0x80:
        raise AssertionError('client WebSocket frame was not masked')
    length = second & 0x7F
    if length == 126:
        length = int.from_bytes(_recv_exact(stream, 2), 'big')
    elif length == 127:
        length = int.from_bytes(_recv_exact(stream, 8), 'big')
    mask = _recv_exact(stream, 4)
    payload = _recv_exact(stream, length)
    payload = bytes(byte ^ mask[index & 3] for index, byte in enumerate(payload))
    return bool(first & 0x80), first & 0x0F, payload


def _read_client_json(stream):
    fin, opcode, payload = _read_client_frame(stream)
    if not fin or opcode != 1:
        raise AssertionError('expected one client text frame')
    return json.loads(payload.decode('utf-8'))


def _handshake(stream, valid=True, partial=False):
    request_headers = _read_http_request(stream)
    key = request_headers['sec-websocket-key']
    accept = base64.b64encode(hashlib.sha1((key + GUID).encode('ascii')).digest()).decode('ascii')
    if not valid:
        accept = 'invalid-accept-value'
    response = ('HTTP/1.1 101 Switching Protocols\r\n'
                'Upgrade: websocket\r\n'
                'Connection: Upgrade\r\n'
                f'Sec-WebSocket-Accept: {accept}\r\n\r\n').encode('ascii')
    if partial:
        _send_partial(stream, response)
    else:
        stream.sendall(response)


def _initialize(stream, partial_handshake=False):
    _handshake(stream, partial=partial_handshake)
    init = _read_client_json(stream)
    if init.get('method') != 'initialize':
        raise AssertionError('first JSON-RPC request was not initialize')
    if init.get('params', {}).get('clientInfo', {}).get('name') != 'pi_web_shared':
        raise AssertionError('shared client identity was not used')
    if init.get('params', {}).get('capabilities', {}).get('experimentalApi') is not True:
        raise AssertionError('experimentalApi was not enabled')
    _send_frame(stream, 1, json.dumps({'id': init['id'], 'result': {'ready': True}}).encode())
    initialized = _read_client_json(stream)
    if initialized != {'method': 'initialized'}:
        raise AssertionError('initialized notification was not sent')


class _UnixFixture:
    def __init__(self, handler):
        self.folder = tempfile.TemporaryDirectory(prefix='shared-ws-')
        self.path = str(Path(self.folder.name) / 'app-server.sock')
        self.listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.listener.bind(self.path)
        self.listener.listen(4)
        self.listener.settimeout(5)
        self.error = None

        def serve():
            stream = None
            try:
                stream, _address = self.listener.accept()
                stream.settimeout(5)
                handler(stream)
            except Exception as exc:
                self.error = exc
            finally:
                if stream is not None:
                    stream.close()

        self.thread = threading.Thread(target=serve, daemon=True)
        self.thread.start()

    def finish(self):
        self.thread.join(timeout=6)
        if self.thread.is_alive():
            raise AssertionError('local WebSocket fixture did not finish')
        if self.error is not None:
            raise self.error

    def cleanup(self):
        try:
            self.listener.close()
        finally:
            self.folder.cleanup()


class SharedRuntimeTests(unittest.TestCase):
    def test_handshake_and_outgoing_frames_are_valid_and_masked(self):
        observed = {}

        def server(stream):
            _initialize(stream, partial_handshake=True)
            observed['eof'] = stream.recv(1)

        fixture = _UnixFixture(server)
        runtime = SharedRuntime(fixture.path, lambda _event: None)
        try:
            runtime.start()
            self.assertTrue(runtime.running)
            self.assertTrue(runtime.shared)
            self.assertIsNone(runtime.process.poll())
            runtime.close()
            fixture.finish()
            self.assertEqual(observed['eof'], b'')
            self.assertNotEqual(runtime.process.poll(), None)
        finally:
            runtime.close()
            fixture.cleanup()

    def test_invalid_websocket_accept_is_rejected(self):
        fixture = _UnixFixture(lambda stream: _handshake(stream, valid=False))
        runtime = SharedRuntime(fixture.path, lambda _event: None)
        try:
            with self.assertRaises(SideChatError):
                runtime.start()
            fixture.finish()
        finally:
            runtime.close()
            fixture.cleanup()

    def test_partial_frames_fragmentation_and_ping_pong(self):
        request_seen = threading.Event()

        def server(stream):
            _handshake(stream)
            init = _read_client_json(stream)
            response = json.dumps({'id': init['id'], 'result': {'ready': True}}).encode()
            split = len(response) // 2
            _send_frame(stream, 1, response[:split], fin=False, partial=True)
            _send_frame(stream, 9, b'probe')
            fin, opcode, payload = _read_client_frame(stream)
            if not fin or opcode != 10 or payload != b'probe':
                raise AssertionError('client did not return the WebSocket ping as a masked pong')
            _send_frame(stream, 0, response[split:], partial=True)
            if _read_client_json(stream) != {'method': 'initialized'}:
                raise AssertionError('initialized notification was not sent')
            request = _read_client_json(stream)
            request_seen.set()
            result = {'id': request['id'], 'result': {'value': 'fragmented reply'}}
            encoded = json.dumps(result).encode()
            split = len(encoded) // 2
            _send_frame(stream, 1, encoded[:split], fin=False, partial=True)
            _send_frame(stream, 0, encoded[split:], partial=True)
            stream.recv(1)

        fixture = _UnixFixture(server)
        runtime = SharedRuntime(fixture.path, lambda _event: None)
        try:
            runtime.start()
            result = runtime.request('test/fragmented', {})
            self.assertEqual(result, {'value': 'fragmented reply'})
            self.assertTrue(request_seen.is_set())
            runtime.close()
            fixture.finish()
        finally:
            runtime.close()
            fixture.cleanup()

    def test_rpc_error_is_preserved(self):
        rpc_error = {'code': -32600, 'message': 'request rejected', 'data': {'reason': 'busy'}}

        def server(stream):
            _initialize(stream)
            request = _read_client_json(stream)
            _send_frame(stream, 1, json.dumps({'id': request['id'], 'error': rpc_error}).encode())
            stream.recv(1)

        fixture = _UnixFixture(server)
        runtime = SharedRuntime(fixture.path, lambda _event: None)
        try:
            runtime.start()
            with self.assertRaises(SideChatError) as caught:
                runtime.request('thread/resume', {'threadId': 'thread-id'})
            self.assertEqual(caught.exception.rpc_error, rpc_error)
            runtime.close()
            fixture.finish()
        finally:
            runtime.close()
            fixture.cleanup()

    def test_event_callback_can_make_a_request_without_reader_deadlock(self):
        holder = {}
        callback_result = []
        callback_done = threading.Event()

        def event(message):
            if message.get('method') == 'fixture/notification':
                callback_result.append(holder['runtime'].request('fixture/from-event', {}, timeout=2))
                callback_done.set()

        def server(stream):
            _initialize(stream)
            _send_frame(stream, 1, b'{"method":"fixture/notification"}')
            request = _read_client_json(stream)
            if request.get('method') != 'fixture/from-event':
                raise AssertionError('event callback request did not arrive')
            _send_frame(stream, 1, json.dumps({'id': request['id'], 'result': {'ok': True}}).encode())
            stream.recv(1)

        fixture = _UnixFixture(server)
        runtime = SharedRuntime(fixture.path, event)
        holder['runtime'] = runtime
        try:
            runtime.start()
            self.assertTrue(callback_done.wait(2), 'event callback blocked the WebSocket reader')
            self.assertEqual(callback_result, [{'ok': True}])
            runtime.close()
            fixture.finish()
        finally:
            runtime.close()
            fixture.cleanup()

    def test_old_generation_queued_events_and_disconnect_are_ignored_after_reconnect(self):
        folder = tempfile.TemporaryDirectory(prefix='shared-ws-generation-')
        path = str(Path(folder.name) / 'app-server.sock')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        listener.listen(2)
        listener.settimeout(5)
        server_errors = []
        callback_started = threading.Event()
        release_callback = threading.Event()
        current_event_seen = threading.Event()
        seen = []

        def server():
            try:
                first, _address = listener.accept()
                with first:
                    first.settimeout(5)
                    _initialize(first)
                    _send_frame(first, 1, b'{"method":"fixture/old-blocked"}')
                    _send_frame(first, 1, b'{"method":"fixture/old-queued"}')
                second, _address = listener.accept()
                with second:
                    second.settimeout(5)
                    _initialize(second)
                    _send_frame(second, 1, b'{"method":"fixture/current"}')
                    second.recv(1)
            except Exception as exc:
                server_errors.append(exc)

        def event(message):
            method = message.get('method')
            seen.append(method)
            if method == 'fixture/old-blocked':
                callback_started.set()
                release_callback.wait(5)
            elif method == 'fixture/current':
                current_event_seen.set()

        server_thread = threading.Thread(target=server, daemon=True)
        server_thread.start()
        runtime = SharedRuntime(path, event)
        try:
            runtime.start()
            self.assertTrue(callback_started.wait(2), 'first generation event was not dispatched')
            deadline = time.monotonic() + 2
            while runtime.running and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(runtime.running, 'first generation did not disconnect')

            runtime.start()
            release_callback.set()
            self.assertTrue(current_event_seen.wait(2), 'reconnected generation event was not dispatched')
            runtime.close()
            server_thread.join(timeout=6)
            self.assertFalse(server_thread.is_alive())
            self.assertEqual(server_errors, [])
            self.assertEqual(seen, ['fixture/old-blocked', 'fixture/current'])
        finally:
            release_callback.set()
            runtime.close()
            listener.close()
            server_thread.join(timeout=1)
            folder.cleanup()

    def test_disconnect_wakes_pending_request_and_emits_once(self):
        received = threading.Event()
        events = []

        def server(stream):
            _initialize(stream)
            _read_client_json(stream)
            received.set()
            stream.close()

        fixture = _UnixFixture(server)
        runtime = SharedRuntime(fixture.path, events.append)
        try:
            runtime.start()
            started = time.monotonic()
            with self.assertRaises(SideChatError):
                runtime.request('fixture/drop', {}, timeout=10)
            elapsed = time.monotonic() - started
            self.assertTrue(received.is_set())
            self.assertLess(elapsed, 2)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not events:
                time.sleep(0.01)
            runtime.close()
            fixture.finish()
            self.assertEqual(events, [{'method': 'bridge/disconnected'}])
            self.assertFalse(runtime.running)
            self.assertNotEqual(runtime.process.poll(), None)
        finally:
            runtime.close()
            fixture.cleanup()

    def test_reconnect_waits_for_explicit_start_and_does_not_replay_writes(self):
        folder = tempfile.TemporaryDirectory(prefix='shared-ws-reconnect-')
        path = str(Path(folder.name) / 'app-server.sock')
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(path)
        listener.listen(2)
        listener.settimeout(5)
        observed = []
        server_errors = []

        def server():
            try:
                first, _address = listener.accept()
                with first:
                    first.settimeout(5)
                    _initialize(first)
                    observed.append(_read_client_json(first)['method'])
                second, _address = listener.accept()
                with second:
                    second.settimeout(5)
                    _initialize(second)
                    request = _read_client_json(second)
                    observed.append(request['method'])
                    _send_frame(second, 1, json.dumps({'id': request['id'], 'result': {'fresh': True}}).encode())
                    second.recv(1)
            except Exception as exc:
                server_errors.append(exc)

        server_thread = threading.Thread(target=server, daemon=True)
        server_thread.start()
        runtime = SharedRuntime(path, lambda _event: None)
        try:
            runtime.start()
            with self.assertRaises(SideChatError):
                runtime.request('fixture/drop', {}, timeout=5)
            with self.assertRaises(SideChatError):
                runtime.write({'method': 'fixture/do-not-replay'})
            runtime.start()
            self.assertEqual(runtime.request('fixture/new', {}), {'fresh': True})
            runtime.close()
            server_thread.join(timeout=6)
            self.assertFalse(server_thread.is_alive())
            self.assertEqual(server_errors, [])
            self.assertEqual(observed, ['fixture/drop', 'fixture/new'])
        finally:
            runtime.close()
            listener.close()
            server_thread.join(timeout=1)
            folder.cleanup()

    def test_deliberate_close_sends_no_close_frame_and_keeps_server_listener(self):
        received = {}
        events = []

        def server(stream):
            _initialize(stream)
            received['eof'] = stream.recv(1)

        fixture = _UnixFixture(server)
        runtime = SharedRuntime(fixture.path, events.append)
        try:
            runtime.start()
            runtime.close()
            fixture.finish()
            self.assertEqual(received['eof'], b'')
            self.assertEqual(events, [])
            self.assertTrue(os.path.exists(fixture.path))
            self.assertGreaterEqual(fixture.listener.fileno(), 0)
            probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                probe.connect(fixture.path)
                accepted, _address = fixture.listener.accept()
                accepted.close()
            finally:
                probe.close()
        finally:
            runtime.close()
            fixture.cleanup()


if __name__ == '__main__':
    unittest.main()
