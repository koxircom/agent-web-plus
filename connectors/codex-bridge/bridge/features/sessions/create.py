"""Perform short-lived thread metadata operations for the desktop App.

The short-lived app-server never receives turn/start. It is shut down before
returning, so the desktop can become the sole execution owner.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlencode


class CreationError(RuntimeError):
    pass


class CreationUnavailable(CreationError):
    """The runtime never started, so no thread mutation could have happened."""


class ForkUnavailable(CreationUnavailable):
    """The capability check failed before any thread could be created."""


def _runtime_operation(executable, codex_home, cwd, operation, *, label='创建聊天'):
    if not executable:
        raise CreationUnavailable('找不到 Codex 运行时，请在电脑启动器的运行配置中指定路径')
    if not Path(cwd).is_dir():
        raise CreationUnavailable('项目目录不存在，请先在电脑 App 中检查项目')
    env = dict(os.environ, CODEX_HOME=str(codex_home))
    kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    try:
        process = subprocess.Popen([str(executable), 'app-server', '--listen', 'stdio://'],
                                   cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, text=True, encoding='utf-8', **kwargs)
    except OSError as exc:
        raise CreationUnavailable('无法启动 Codex 运行时，请检查运行配置中的程序路径、项目目录和访问权限后重试') from exc
    messages = queue.Queue()
    stop_reader = threading.Event()

    def read():
        try:
            while not stop_reader.is_set():
                line = process.stdout.readline()
                if not line:
                    break
                try:
                    messages.put(json.loads(line))
                except ValueError:
                    continue
        except OSError:
            if not stop_reader.is_set():
                raise
        finally:
            messages.put(None)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    counter = 0

    def request(method, params):
        nonlocal counter
        counter += 1
        process.stdin.write(json.dumps({'id': counter, 'method': method, 'params': params}) + '\n')
        process.stdin.flush()
        deadline = time.monotonic() + 25
        while True:
            try:
                result = messages.get(timeout=max(.01, deadline - time.monotonic()))
            except queue.Empty as exc:
                raise CreationError(label + '超时，请先检查桌面聊天列表，不要重复操作') from exc
            if result is None:
                raise CreationError(label + '的运行时已断开，请先检查桌面聊天列表')
            if result.get('id') != counter:
                if time.monotonic() >= deadline:
                    raise CreationError(label + '超时，请先检查桌面聊天列表')
                continue
            if 'error' in result:
                error = CreationError(result['error'].get('message', label + '失败'))
                error.rpc_error = result['error']
                raise error
            return result['result']

    try:
        request('initialize', {'clientInfo': {'name': 'codex_mobile_bridge', 'version': '0.2'},
                               'capabilities': {'experimentalApi': True}})
        process.stdin.write('{"method":"initialized"}\n')
        process.stdin.flush()
        result = operation(request)
    finally:
        # EOF flushes pending writes and releases the thread before App takeover.
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise CreationError(label + '辅助程序未正常退出，请先检查桌面聊天列表')
        finally:
            stop_reader.set()
            reader.join(timeout=1)
            if reader.is_alive() and os.name == 'nt':
                from bridge.platforms.windows.transport import cancel_thread_io
                cancel_thread_io(reader)
                reader.join(timeout=1)
            if reader.is_alive():
                raise CreationError(label + '辅助程序读取管道未退出，请先核对结果；没有重试操作')
            process.stdout.close()
    if process.returncode:
        raise CreationError(label + '辅助程序退出异常，请先检查桌面聊天列表')
    return result


def independent_directory(data_dir, request_id):
    """A durable per-chat workspace, without registering a desktop project."""
    uuid.UUID(request_id)
    root = Path(data_dir) / 'independent-chats'
    target = root / request_id
    try:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if root.is_symlink(): raise CreationUnavailable('独立聊天目录不可用')
        target.mkdir(mode=0o700, exist_ok=True)
        if target.is_symlink() or not target.is_dir(): raise CreationUnavailable('独立聊天目录不可用')
        return str(target.resolve())
    except OSError as exc:
        raise CreationUnavailable('独立聊天目录不可用') from exc


def create_empty(executable, codex_home, cwd, title):
    def create(request):
        result = request('thread/start', {'cwd': cwd, 'ephemeral': False})
        thread_id = result['thread']['id']
        uuid.UUID(thread_id)
        request('thread/name/set', {'threadId': thread_id, 'name': title})
        request('thread/read', {'threadId': thread_id, 'includeTurns': True})
        return thread_id
    return _runtime_operation(executable, codex_home, cwd, create)


def fork_copy(executable, codex_home, cwd, source_id, turn_id, title, settings):
    if not executable:
        raise ForkUnavailable('找不到 Codex 运行时，请在电脑启动器的运行配置中指定路径')
    # Check the bundled runtime, not a guessed version. Older servers can silently
    # ignore unknown fields; that must never copy later turns or start a goal.
    kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    with tempfile.TemporaryDirectory(prefix='fork-schema-') as folder:
        try:
            result = subprocess.run([str(executable), 'app-server', 'generate-json-schema', '--experimental', '--out', folder],
                                    capture_output=True, timeout=30, **kwargs)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ForkUnavailable('无法检查 Codex 运行时，请检查运行配置中的程序路径后重试') from exc
        paths = list(Path(folder).rglob('ThreadForkParams.json'))
        if result.returncode or not paths:
            raise ForkUnavailable('此 Codex 版本暂不支持安全分支，请更新电脑 Codex App')
        properties = json.loads(paths[0].read_text(encoding='utf-8')).get('properties', {})
        if not {'lastTurnId', 'deferGoalContinuation'} <= properties.keys():
            raise ForkUnavailable('此 Codex 版本暂不支持安全分支，请更新电脑 Codex App')
    def fork(request):
        result = request('thread/fork', {'threadId': source_id, 'lastTurnId': turn_id,
                                        'deferGoalContinuation': True, 'ephemeral': False,
                                        'cwd': cwd, **settings})
        thread = result['thread']
        uuid.UUID(thread['id'])
        if thread['id'] == source_id:
            raise CreationError('分支结果无效，请检查桌面聊天列表')
        turns = thread.get('turns', [])
        if not turns or turns[-1].get('id') != turn_id:
            raise CreationError('分支位置未确认，请检查桌面聊天列表，不要重复创建')
        if result.get('modelProvider') != settings['modelProvider']:
            raise CreationError('分支模型提供商不一致，请检查桌面聊天列表')
        request('thread/name/set', {'threadId': thread['id'], 'name': title})
        return thread['id']
    return _runtime_operation(executable, codex_home, cwd, fork)


def open_in_desktop(thread_id, host):
    uuid.UUID(thread_id)
    url = 'codex://threads/' + thread_id
    if host != 'local':
        url += '?' + urlencode({'hostId': host})
    if sys.platform == 'darwin':
        subprocess.run(['open', url], check=True, timeout=10,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    elif sys.platform == 'linux':
        try:
            subprocess.run(['xdg-open', url], check=True, timeout=10,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as exc:
            raise CreationError('无法打开桌面聊天，请在桌面登录会话中运行网关，并检查 xdg-open 和 codex:// 协议关联') from exc
    elif os.name == 'nt':
        os.startfile(url)
    else:
        raise CreationError('请在支持 Codex App 的 Mac 或 Windows 电脑运行网关')


def rename_thread(executable, codex_home, thread_id, title):
    uuid.UUID(thread_id)
    return _runtime_operation(executable, codex_home, str(codex_home),
                              lambda request: request('thread/name/set', {'threadId': thread_id, 'name': title}))


def delete_thread_metadata(executable, codex_home, cwd, thread_id):
    """Native deletion owns storage; never resume a turn or remove files here."""
    uuid.UUID(thread_id)
    expected_cwd = Path(cwd).resolve(strict=True)

    def delete(request):
        try:
            thread = request('thread/read', {'threadId': thread_id, 'includeTurns': False})['thread']
            if (thread.get('id') != thread_id
                    or Path(thread.get('cwd', '')).resolve(strict=True) != expected_cwd):
                raise CreationUnavailable('会话目录或身份已变化，尚未删除。')
            if (thread.get('status') or {}).get('type') not in ('idle', 'notLoaded'):
                raise CreationUnavailable('请先结束当前任务，再删除会话。')
            queued = request('thread/queue/list', {'threadId': thread_id, 'limit': 1})
            if not isinstance(queued.get('data'), list):
                raise CreationUnavailable('无法核对待发送消息，尚未删除会话。')
            if queued['data'] or queued.get('nextCursor') is not None:
                raise CreationUnavailable('会话还有待发送消息，请处理队列后再删除。')
        except CreationUnavailable:
            raise
        except (CreationError, KeyError, TypeError, OSError) as exc:
            raise CreationUnavailable('无法核对会话状态，尚未删除：' + str(exc)) from exc
        try:
            return request('thread/delete', {'threadId': thread_id})
        except CreationError as exc:
            if getattr(exc, 'rpc_error', None):
                raise CreationUnavailable('Codex 拒绝删除会话：' + str(exc)) from exc
            raise

    return _runtime_operation(executable, codex_home, cwd, delete, label='删除会话')
