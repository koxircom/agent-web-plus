"""One explicitly enabled owner for idle CLI activation; status reads never restart."""
import fcntl
import json
import os
import re
import signal
import socket
import stat
import struct
import subprocess
import time
from pathlib import Path

from bridge.clients.codex.shared_runtime import SharedRuntime
from bridge.clients.codex.standalone_composer import goal_rpc_unsupported

VERSION = re.compile(r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')


def version(value):
    return value if isinstance(value, str) and VERSION.fullmatch(value) else None


class RuntimeUpdate:
    def __init__(self, executable, home=None, control_socket=None, options=None):
        self.executable = str(executable)
        self.home = Path(home) if home else None
        self.control_socket = str(control_socket) if control_socket else None
        options = options or {}
        self.enabled = options.get('enabled') is True
        self.quiet_seconds = max(15, min(300, int(options.get('quietSeconds', 30))))
        self.directory = Path(options['stateDirectory']) if options.get('stateDirectory') else None
        if self.enabled and (not self.home or not self.control_socket or not self.directory or not self.directory.is_absolute()):
            raise ValueError('自动切换需要明确的原生运行时目录、控制 socket 和状态目录')
        self.path = self.directory / 'activation.json' if self.directory else None

    def environment(self):
        return {**os.environ, **({'CODEX_HOME': str(self.home)} if self.home else {})}

    def command(self, args, *, timeout=3, env=None):
        return subprocess.run([self.executable, *args], stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, timeout=timeout, env=env or self.environment(), check=True)

    def probe(self):
        installed, running, status = None, None, 'unknown'
        try:
            match = re.fullmatch(r'codex-cli (\S+)', self.command(['--version']).stdout.strip())
            installed = version(match[1]) if match else None
        except (OSError, subprocess.SubprocessError):
            pass
        if self.home and self.control_socket:
            try:
                result = json.loads(self.command(['app-server', 'daemon', 'version']).stdout)
                # An absent process is different from an unreadable version.
                if Path(result.get('socketPath', '')).resolve() != Path(self.control_socket).resolve():
                    raise ValueError('运行时入口不一致')
                if result.get('status') == 'running':
                    running = version(result.get('appServerVersion'))
                    status = 'running' if running else 'unknown'
                elif result.get('status') in ('stopped', 'notRunning', 'not_running'):
                    status = 'stopped'
            except (OSError, ValueError, subprocess.SubprocessError):
                try:
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
                        stream.settimeout(1)
                        stream.connect(self.control_socket)
                except (FileNotFoundError, ConnectionRefusedError):
                    status = 'stopped'
                except OSError:
                    pass
        return {'installed': installed, 'running': running, 'status': status}

    def read(self):
        try:
            data = json.loads(self.path.read_text()) if self.path else {}
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def write(self, state):
        state = {**state, 'updatedAt': int(time.time())}
        temporary = self.path.with_suffix('.tmp')
        with temporary.open('w') as stream:
            os.chmod(temporary, 0o600)
            json.dump(state, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.path)
        return state

    def status(self, snapshot=None):
        snapshot = snapshot or self.probe()
        installed, running = snapshot['installed'], snapshot['running']
        phase, message = 'manual', '运行状态暂不可用'
        if installed and installed == running:
            phase, message = 'current', '已安装版本与运行中版本一致'
        elif snapshot['status'] == 'stopped':
            message = '原生运行时尚未启动'
        elif installed and running:
            phase = 'waiting_for_idle' if self.enabled else 'manual'
            message = '等待全部任务空闲后切换' if self.enabled else '已安装新版本，运行时尚未切换'
            saved = self.read()
            if saved.get('targetVersion') == installed and saved.get('phase') in ('waiting_for_idle', 'switching', 'error'):
                phase, message = saved['phase'], saved.get('message') or message
        return {'codexCliVersion': installed, 'codexCliInstalledVersion': installed,
                'codexCliRunningVersion': running, 'codexCliRuntimeStatus': snapshot['status'],
                'codexCliActivationState': phase, 'codexCliActivationMessage': message}

    def peer(self):
        configured = Path(self.control_socket)
        expected = self.home / 'app-server-control' / 'app-server-control.sock'
        if not configured.is_absolute() or configured != expected:
            raise ValueError('自动切换只能使用原生标准控制入口')
        # Native CLI aliases its standard path to an owned hashed /tmp socket.
        path = configured.resolve(strict=True)
        info = path.stat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('原生控制 socket 身份无法确认')
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
            stream.settimeout(3)
            stream.connect(str(path))
            pid, uid, _ = struct.unpack('3i', stream.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        proc = Path('/proc') / str(pid)
        if uid != os.getuid() or b'app-server' not in (proc / 'cmdline').read_bytes():
            raise ValueError('原生运行进程身份无法确认')
        return {'pid': pid, 'started': (proc / 'stat').read_text().split()[21]}

    def activity(self):
        identity = self.peer()
        client = SharedRuntime(self.control_socket, lambda _: None, home=self.home)
        try:
            client.start()
            cursor, seen = None, set()
            while True:
                page = client.request('thread/loaded/list', {'limit': 100, **({'cursor': cursor} if cursor else {})}, timeout=5)
                for thread_id in page['data']:
                    thread = client.request('thread/read', {'threadId': thread_id, 'includeTurns': False}, timeout=5)['thread']
                    if (thread.get('status') or {}).get('type') not in ('idle', 'notLoaded'):
                        return {'busy': True, 'message': '仍有原生任务正在执行或等待确认', 'peer': identity}
                    queued = client.request('thread/queue/list', {'threadId': thread_id, 'cursor': None}, timeout=5)
                    if queued.get('data'):
                        return {'busy': True, 'message': '仍有原生排队消息等待执行', 'peer': identity}
                    try:
                        goal = client.request('thread/goal/get', {'threadId': thread_id}, timeout=5).get('goal')
                    except Exception as error:
                        if not goal_rpc_unsupported(error):
                            raise
                        goal = None
                    if goal and goal.get('status') == 'active':
                        return {'busy': True, 'message': '仍有活动目标，等待目标完成或暂停', 'peer': identity}
                cursor = page.get('nextCursor')
                if not cursor:
                    break
                if cursor in seen:
                    raise ValueError('原生任务分页状态无法确认')
                seen.add(cursor)
            if self.peer() != identity:
                raise ValueError('检测期间原生进程已变化')
            return {'busy': False, 'message': '全部原生任务已空闲', 'peer': identity}
        finally:
            client.close()

    def restart(self, expected):
        # Recheck native activity immediately before handoff. Never use SIGKILL.
        activity = self.activity()
        if activity['busy'] or activity['peer'] != expected:
            return False
        identity = self.peer()
        if identity != expected:
            return False
        # Keep the existing owner's environment in memory only, including its
        # proxy/tool paths. Never log or persist credentials from that process.
        env = dict(part.split('=', 1) for part in (Path('/proc') / str(identity['pid']) / 'environ').read_bytes().decode().split('\0') if '=' in part)
        env['CODEX_HOME'] = str(self.home)
        try:
            self.command(['app-server', 'daemon', 'update', '--from-cli', '--yes'], timeout=45, env=env)
            return True
        except subprocess.CalledProcessError as error:
            detail = ((error.stdout or '') + (error.stderr or '')).lower()
            if not any(text in detail for text in ('not managed by codex app-server daemon', 'no daemon package is selected')):
                raise
        # An older Desktop-created owner is not managed by daemon. Adopt it
        # only after another idle + exact socket-peer identity confirmation.
        final = self.activity()
        if final['busy'] or final['peer'] != identity or self.peer() != identity:
            return False
        # Keep Desktop startup flags (for example code_mode_host) and working
        # directory when adopting a legacy owner. They stay in memory only.
        original_args = (Path('/proc') / str(identity['pid']) / 'cmdline').read_bytes().decode().split('\0')
        original_args = [arg for arg in original_args if arg]
        original_cwd = os.readlink(Path('/proc') / str(identity['pid']) / 'cwd')
        self.write({**self.read(), 'legacyOwner': True})
        os.kill(identity['pid'], signal.SIGTERM)
        deadline = time.monotonic() + 10
        proc = Path('/proc') / str(identity['pid'])
        while time.monotonic() < deadline:
            try:
                fields = (proc / 'stat').read_text().split()
            except FileNotFoundError:
                break
            if fields[2] == 'Z' or fields[21] != identity['started']:
                break
            time.sleep(.1)
        else:
            raise ValueError('原生进程尚未退出，未强制终止')
        log_path = self.home / 'app-server-control' / 'app-server.log'
        with log_path.open('a') as log:
            process = subprocess.Popen([self.executable, *original_args[1:]], cwd=original_cwd, env=env,
                                       stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise ValueError('新原生进程未能启动')
            try:
                if self.peer()['pid'] == process.pid:
                    return True
            except (OSError, ValueError):
                pass
            time.sleep(.1)
        raise ValueError('新原生进程入口尚未恢复')

    def step(self):
        if not self.enabled:
            return {'phase': 'manual', 'message': '未启用自动切换'}
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        with (self.directory / 'activation.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return self.read()
            snapshot = self.probe()
            base = {'targetVersion': snapshot['installed'], 'runningVersion': snapshot['running']}
            if snapshot['installed'] and snapshot['installed'] == snapshot['running']:
                return self.write({**base, 'phase': 'current', 'message': '已安装版本与运行中版本一致'})
            if not snapshot['installed'] or not snapshot['running']:
                previous = self.read()
                if snapshot['installed'] and snapshot['status'] == 'stopped' and previous.get('restartRequested') and not previous.get('legacyOwner'):
                    try:
                        self.command(['app-server', 'daemon', 'start'], timeout=30)
                        restored = self.probe()
                        if restored['running'] == snapshot['installed']:
                            return self.write({**base, 'runningVersion': restored['running'], 'phase': 'current', 'message': '运行时已恢复到已安装版本'})
                    except Exception:
                        pass
                return self.write({**base, **({k: previous[k] for k in ('restartRequested', 'legacyOwner') if previous.get(k)}),
                                   'phase': 'waiting_for_idle', 'message': '运行状态无法确认，暂不切换'})
            try:
                active = self.activity()
                previous = self.read()
                if active['busy']:
                    return self.write({**base, 'phase': 'waiting_for_idle', 'message': active['message']})
                if tuple(map(int, base['targetVersion'].split('-')[0].split('.'))) < tuple(map(int, snapshot['running'].split('-')[0].split('.'))):
                    return self.write({**base, 'phase': 'error', 'message': '已安装版本低于运行中版本，未自动降级'})
                target = str(Path(self.executable).resolve(strict=True))
                now = time.time()
                same = previous.get('targetVersion') == base['targetVersion'] and previous.get('peer') == active['peer'] and previous.get('target') == target
                idle_since = previous.get('idleSince', now) if same else now
                state = {**base, 'target': target, 'peer': active['peer'], 'idleSince': idle_since}
                if now - idle_since < self.quiet_seconds:
                    return self.write({**state, 'phase': 'waiting_for_idle', 'message': '任务已空闲，正在确认稳定空闲状态'})
                if str(Path(self.executable).resolve(strict=True)) != target:
                    return self.write({**base, 'phase': 'waiting_for_idle', 'message': 'CLI 入口已更新，重新确认空闲状态'})
                self.write({**state, 'restartRequested': True, 'phase': 'switching', 'message': '正在切换到已安装的 CLI 版本'})
                if not self.restart(active['peer']):
                    return self.write({**base, 'phase': 'waiting_for_idle', 'message': '检测到新任务，切换已延期'})
                actual = self.probe()
                if actual['running'] != snapshot['installed']:
                    raise ValueError('新运行时版本尚未确认')
                return self.write({**base, 'runningVersion': actual['running'], 'phase': 'current', 'message': '运行时已切换到已安装版本'})
            except Exception:
                # A failed observation or handoff never grants permission to
                # force-stop a process. Keep the pending transition explicit.
                return self.write({**base, **({k: self.read()[k] for k in ('restartRequested', 'legacyOwner') if self.read().get(k)}),
                                   'phase': 'error', 'message': '原生状态或版本切换尚未确认，将在下次检查时继续'})
