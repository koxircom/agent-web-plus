"""A server-owned Codex runtime. Browsers only observe durable web threads.

The optional history socket joins the configured WSL app-server only; no
Desktop IPC, host discovery, or SSH store is used.
The registry is the authority for which threads this entrypoint may operate.
"""
import copy
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from contextlib import nullcontext
from pathlib import Path
from bridge.features.sessions.model import async_requests, merge_turn_items, question_replies
from bridge.features.workspace.project_scopes import (
    browse_scoped_directories,
    create_scoped_worktree,
    get_scoped_worktree_info,
    remove_scoped_worktree,
    resolve_scoped_cwd,
)

from bridge.app.service import Bridge
from bridge.clients.codex.catalog import Catalog
from bridge.clients.codex.native_metadata import (
    execute_archive_action,
    execute_pin_action,
    execute_rename,
)
from bridge.clients.codex.native_queue import NativeQueue, merge as merge_native_queue
from bridge.clients.codex.errors import ActiveWriterConflict, is_active_writer_error
from bridge.clients.codex.wsl_history import WslHistory
from bridge.clients.codex.ipc import IPCError
from bridge.clients.codex.shared_runtime import SharedRuntime
from bridge.clients.codex.runtime_update import RuntimeUpdate
from bridge.features.sessions.side_chat import SideChat, SideRuntime, SideChatError, SideChats
from bridge.features.sessions.store import SessionStore
from bridge.features.sessions.timeline import Timeline
from bridge.features.sessions.goal import (goal_identity, goal_state_confirms_command,
    normalize_goal, plan_goal_command)
from bridge.clients.codex.standalone_composer import (
    composer_mode, composer_state, goal_rpc_unsupported, native_goal, submission_work_mode,
)
from bridge.features.workspace.uploads import Uploads
from bridge.features.workspace.workspace import operate as workspace_operation
from bridge.features.terminals.manager import TerminalManager


def private_json(path, value):
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def pending_submissions(submissions):
    """The main composer expects pending rows only, with attachment names."""
    return [{'id': row.get('nativeQueueId', key) if row.get('nativePromotion') else key, 'text': row['text'], 'status': row['status'], 'mode': row.get('mode', 'send'),
             'workMode': row.get('workMode', 'default'),
             **({'clientRequestId': row['clientRequestId']} if row.get('clientRequestId') else {}),
             'attachments': [a['name'] for a in row.get('attachments', [])],
             **({'error': row['error']} if row.get('error') else {})}
            for key, row in submissions.items() if row['status'] in ('unknown', 'queued', 'failed') and (row.get('queueOwner') != 'native' or row.get('nativePromotion', {}).get('stage') not in (None, 'done'))]


def async_submission_id(thread_id, request_id):
    """Keep one durable user-message identity for each native question request."""
    return str(uuid.uuid5(uuid.UUID(str(thread_id)), 'async-question:' + str(request_id)))


def terminal_turn_result(turn, items, authoritative=False):
    """Return whether a completed snapshot contains its visible terminal result."""
    if turn.get('error') or turn.get('status') in ('failed', 'interrupted', 'cancelled'):
        return True
    if authoritative:
        return any(item.get('type') in ('error', 'planImplementation') or
                   (item.get('type') in ('agentMessage', 'assistantMessage') and
                    item.get('phase') != 'commentary') for item in items)
    return any((item.get('type') in ('error', 'planImplementation') and item.get('_completed')) or
               (item.get('type') in ('agentMessage', 'assistantMessage') and
                item.get('phase') != 'commentary' and item.get('_completed')) for item in items)


def async_reply_text(questions, response):
    if not isinstance(response, dict) or set(response) != {'answers'}:
        raise ValueError('请回答所有问题')
    answers = response['answers']
    if not isinstance(answers, dict):
        raise ValueError('请回答所有问题')
    identifiers = [question.get('id') for question in questions]
    if (not identifiers or any(not isinstance(identifier, str) or not identifier for identifier in identifiers)
            or len(set(identifiers)) != len(identifiers) or set(answers) != set(identifiers)
            or any(not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], str)
                   or not value[0].strip() or len(value[0]) > 20000 for value in answers.values())):
        raise ValueError('请回答所有问题')
    replies = [{'questionItemId': question['id'], 'question': question['question'],
                'answer': answers[question['id']][0]} for question in questions]
    return ('<send_user_message_question_reply>\n'
            + json.dumps(replies, ensure_ascii=False, separators=(',', ':'))
            + '\n</send_user_message_question_reply>')


def prior_async_questions(row):
    replies = question_replies(row.get('text', '')) if isinstance(row, dict) else []
    if not replies or any(not isinstance(reply.get('questionItemId'), str)
                          or not isinstance(reply.get('question'), str)
                          for reply in replies):
        return []
    return [{'id': reply['questionItemId'], 'question': reply['question']} for reply in replies]


class Runtime(SideRuntime):
    def __init__(self, executable, home, cwd, event):
        # Keep project browsing and catalog reads from acquiring the Codex
        # runtime. Session operations explicitly start this server-owned owner.
        self.executable, self.home, self.cwd, self.event = executable, home, cwd, event
        self._runtime = None
        self._start_lock = threading.RLock()

    @property
    def process(self):
        return self._runtime.process if self._runtime is not None else None

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    def start(self):
        with self._start_lock:
            if self._runtime is not None:
                return
            runtime = SideRuntime(self.executable, self.home, self.cwd, self.event)
            self._runtime = runtime
            try:
                runtime.start()
            except Exception:
                self._runtime = None
                raise

    def request(self, method, params, timeout=30):
        self.start()
        try:
            return self._runtime.request(method, params, timeout)
        except SideChatError as original:
            if is_active_writer_error(original):
                raise ActiveWriterConflict() from original
            error = SideChatError('运行时操作结果未确认，请刷新状态；不要重复发送。')
            if hasattr(original, 'rpc_error'):
                error.rpc_error = original.rpc_error
                error.args = ('Codex 未完成操作：' + str(original.rpc_error.get('message', '运行时拒绝请求'))[:500],)
            raise error from original

    def write(self, value):
        if self._runtime is None:
            raise SideChatError('Codex 运行时尚未启动')
        return self._runtime.write(value)

    def close(self):
        with self._start_lock:
            runtime, self._runtime = self._runtime, None
        if runtime is not None:
            runtime.close()


class Clients:
    """The entrypoint offers exactly one enabled runtime; no process scanning."""
    def __init__(self, bridge):
        self.bridge = bridge

    def clients(self):
        running = self.bridge.runtime.running
        return {'gatewayRunning': True, 'computer': 'WSL Codex', 'clients': [
            {'id': 'codex', 'name': 'Codex', 'enabled': True, 'installed': True, 'configured': True,
             'selectable': False, 'setupStatus': 'ready', 'reason': 'WSL 独立后台服务',
             'running': running, 'connected': running, 'state': 'connected' if running else 'unavailable'}]}

    def require_enabled(self, provider):
        if provider != 'codex':
            raise ValueError('此入口仅管理 WSL Codex')

    def toggle_client(self, value):
        raise ValueError('此入口由后台服务管理，无需开关桌面应用')


class Projects:
    def __init__(self, workspaces):
        self.workspaces = workspaces

    def projects(self):
        return [{'key': item['key'], 'host': 'local', 'hostLabel': 'WSL Codex',
                 'name': item['name'], 'label': item['name'], 'cwd': str(item['path'])}
                for item in self.workspaces]

    def hosts(self):
        return {}


class Chat(SideChat):
    """Reuse native event parsing/send/approvals, with a persistent main thread."""
    supports_goal_mode = True

    def __init__(self, bridge, identifier, result, backend, entry=None):
        self.bridge, self.backend = bridge, backend
        self.id, self.parent = identifier, None
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.actions = threading.RLock()
        self.closed, self.ready, self.error = False, True, None
        self.viewers, self.sequence, self.touched = 0, 0, time.monotonic()
        self.timeline = Timeline()
        self.file_directory = None
        self.uploads = bridge.uploads
        self.queue_event = threading.Event()
        self.queue_worker = None
        self.completed_reads = set()
        self.pending_completions = {}
        entry = entry if entry is not None else bridge.records['threads'][identifier]
        self.submissions = copy.deepcopy(entry.get('submissions', {}))
        self.goal_known = bool(entry.get('goalKnown', False))
        self.goal_supported = entry.get('goalSupported') is not False
        self.goal_support_checked = bool(entry.get('goalSupportChecked', entry.get('goalSupported') is not None))
        for row in self.submissions.values():
            row['catalog'] = bridge.catalog_reader
        thread = result['thread']
        turns = copy.deepcopy(thread.get('turns', []))
        for turn in turns:
            turn['turnId'] = turn.get('turnId') or turn['id']
        sandbox = result.get('sandbox') or {'type': entry.get('sandboxType', 'workspaceWrite'), 'writableRoots': [entry['cwd']]}
        if isinstance(sandbox, str):
            sandbox = {'type': bridge._sandbox_type(sandbox)}
        self.turn_permissions = {'approvalPolicy': result.get('approvalPolicy') or entry.get('approvalPolicy', 'on-request'),
                                 'sandboxPolicy': copy.deepcopy(sandbox)}
        for key in ('approvalsReviewer', 'runtimeWorkspaceRoots'):
            if key in result:
                self.turn_permissions[key] = copy.deepcopy(result[key])
        self.shared = bool(getattr(backend, 'shared', False))
        self.bind_submission_on_turn_started = not self.shared
        self.shared_requests = {}
        collab = result.get('collaborationMode')
        collab_settings = (collab.get('settings') or {}) if isinstance(collab, dict) else {}
        if self.shared:
            model = collab_settings.get('model') or result.get('model') or entry.get('model')
            effort = collab_settings.get('reasoning_effort') or result.get('reasoningEffort') or entry.get('effort')
        else:
            model = collab_settings.get('model') or entry.get('model') or result.get('model')
            effort = collab_settings.get('reasoning_effort') or entry.get('effort') or result.get('reasoningEffort')
        self.state = {'id': identifier, 'title': entry['title'], 'cwd': entry['cwd'],
                      'latestModel': model,
                      'modelProvider': result.get('modelProvider', 'openai'),
                      'latestReasoningEffort': effort,
                      'latestCollaborationMode': copy.deepcopy(collab),
                      'latestThreadSettings': copy.deepcopy(self.turn_permissions),
                      'currentPermissions': copy.deepcopy(self.turn_permissions),
                      'threadGoal': copy.deepcopy(entry.get('threadGoal')) if self.goal_known else None,
                      'turns': turns, 'turnsPagination': copy.deepcopy(thread.get('turnsPagination') or {'hasLoadedOldest': True}),
                      'requests': [], 'threadRuntimeStatus': copy.deepcopy(thread.get('status') or {'type': 'idle'})}
        self.history_limit = 1
        class Journal:
            @property
            def process(inner):
                return backend.process

            def request(inner, method, params, timeout=30):
                if method in ('turn/start', 'turn/steer'):
                    self.persist()
                if self.shared and method == 'turn/start':
                    # A shared thread keeps the original owner's current policy.
                    params = {k: v for k, v in params.items() if k not in (
                        'approvalPolicy', 'sandboxPolicy', 'approvalsReviewer', 'runtimeWorkspaceRoots', 'permissions')}
                return backend.request(method, params, timeout)

            def write(inner, value):
                return backend.write(value)
        self.runtime = Journal()

    @property
    def connected(self):
        process = getattr(self.backend, 'process', None)
        return bool(self.ready and not self.closed and process is not None and process.poll() is None)

    def changed(self):
        self.sequence += 1
        self.touched = time.monotonic()
        self.condition.notify_all()

    def refresh_shared_state(self):
        if not self.shared:
            return
        # Explicit operations rejoin the same owner, never a second writer.
        result = self.backend.request('thread/resume', {'threadId': self.id, 'excludeTurns': True})
        if Path(result['thread']['cwd']).resolve() != Path(self.state['cwd']).resolve():
            raise PermissionError('共享运行时返回的工作区不一致')
        with self.condition:
            native_status = copy.deepcopy(result['thread'].get('status') or {'type': 'notLoaded'})
            has_pending = bool(self.pending_completions)
            if has_pending and native_status.get('type') == 'idle':
                current_type = self.state.get('threadRuntimeStatus', {}).get('type')
                native_status = copy.deepcopy(self.state['threadRuntimeStatus']) if current_type != 'idle' else {'type': 'active'}
            self.state['threadRuntimeStatus'] = native_status
            collab = result.get('collaborationMode')
            if collab and isinstance(collab, dict):
                self.state['latestCollaborationMode'] = copy.deepcopy(collab)
                collab_settings = collab.get('settings') or {}
                if collab_settings.get('model'):
                    self.state['latestModel'] = collab_settings['model']
                elif result.get('model'):
                    self.state['latestModel'] = result['model']
                if 'reasoning_effort' in collab_settings and collab_settings['reasoning_effort'] is not None:
                    self.state['latestReasoningEffort'] = collab_settings['reasoning_effort']
                elif 'reasoningEffort' in result:
                    self.state['latestReasoningEffort'] = result['reasoningEffort']
            else:
                if result.get('model'):
                    self.state['latestModel'] = result['model']
                if 'reasoningEffort' in result:
                    self.state['latestReasoningEffort'] = result['reasoningEffort']
            self.changed()

    def _sync_shared_requests(self):
        owned = {r.get('turnId') for r in self.submissions.values()
                 if r.get('status') in ('accepted', 'unknown') and r.get('turnId') and r.get('mode') != 'steer'}
        self.state['requests'] = [copy.deepcopy(r) for r in self.shared_requests.values()
                                  if r.get('params', {}).get('turnId') in owned]

    def _commit_completion(self, turn_id, source):
        super()._event({'method': 'turn/completed', 'params': {'threadId': self.id, 'turn': source}})
        self.pending_completions.pop(turn_id, None)
        self.completed_reads.discard(turn_id)
        if self.shared:
            self.shared_requests = {k: r for k, r in self.shared_requests.items()
                                    if r.get('params', {}).get('turnId') != turn_id}
        if self.pending_completions or any(t.get('status') == 'inProgress' for t in self.state.get('turns', [])):
            self.state['threadRuntimeStatus']['type'] = 'active'
        else:
            self.state['threadRuntimeStatus']['type'] = 'idle'
        self.persist()

    def settings(self, model, effort, catalog, timeout=10.0):
        if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,199}", model):
            raise ValueError("模型 ID 格式不正确")
        if effort not in ("none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"):
            raise ValueError("请选择有效的推理强度")
        known = next((m for m in catalog.get('models', []) if m['id'] == model), None)
        if known and known.get('efforts') and effort not in known['efforts']:
            raise ValueError("这个模型不支持所选推理强度")
        with self.actions:
            if not self.connected:
                raise SideChatError('侧边聊天已失效，请关闭后新建')
            params = {
                'threadId': self.id,
                'model': model,
                'effort': effort,
            }
            collab = copy.deepcopy(self.state.get('latestCollaborationMode'))
            if collab and isinstance(collab, dict) and 'mode' in collab:
                old_settings = copy.deepcopy(collab.get('settings') or {})
                collab_mode = collab.get('mode') or 'default'
                dev_instructions = old_settings.get('developer_instructions')
            else:
                collab_mode = 'default'
                dev_instructions = None
            params['collaborationMode'] = {
                'mode': collab_mode,
                'settings': {
                    'model': model,
                    'reasoning_effort': effort,
                    'developer_instructions': dev_instructions,
                }
            }
            deadline = time.monotonic() + min(timeout, 10.0)
            self.backend.request('thread/settings/update', params, timeout=min(5.0, timeout))
            confirmed = False
            last_observed_model = None

            while time.monotonic() < deadline:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                read_timeout = min(5.0, remaining)
                try:
                    read_result = self.backend.request('thread/resume', {'threadId': self.id, 'excludeTurns': True}, timeout=read_timeout)
                except Exception:
                    with self.condition:
                        self.condition.wait(min(0.25, max(0.01, deadline - time.monotonic())))
                    continue

                c_mode = read_result.get('collaborationMode')
                c_settings = (c_mode.get('settings') or {}) if isinstance(c_mode, dict) else {}
                r_model = c_settings.get('model') or read_result.get('model') or (read_result.get('thread') or {}).get('model')
                r_effort = c_settings.get('reasoning_effort') or read_result.get('reasoningEffort') or (read_result.get('thread') or {}).get('reasoningEffort')
                last_observed_model = r_model

                model_match = (r_model == model)
                effort_match = (r_effort == effort)
                collab_match = True
                expected_cm = params['collaborationMode']
                if c_mode and isinstance(c_mode, dict):
                    if c_mode.get('mode') != expected_cm.get('mode'):
                        collab_match = False
                    if c_settings.get('model') and c_settings.get('model') != model:
                        collab_match = False
                    if c_settings.get('reasoning_effort') and c_settings.get('reasoning_effort') != effort:
                        collab_match = False

                if model_match and effort_match and collab_match:
                    confirmed = True
                    break

                with self.condition:
                    rem_wait = min(0.25, max(0.01, deadline - time.monotonic()))
                    self.condition.wait(rem_wait)

            if not confirmed:
                raise SideChatError(f'模型设置未能在时限内确认生效（当前模型仍为 {last_observed_model or "未知"}），已取消确认')

            with self.lock:
                self.state['latestModel'] = model
                self.state['latestReasoningEffort'] = effort
                self.state['latestCollaborationMode'] = copy.deepcopy(params['collaborationMode'])
                self.persist()
            with self.condition:
                self.changed()
            return self.view()

    def _event(self, message):
        with self.condition:
            method, params = message.get('method'), message.get('params') or {}
            if params.get('threadId') and params.get('threadId') != self.id:
                return
            if self.closed or not self.ready:
                if method != 'bridge/disconnected':
                    return
            if self.shared and message.get('method') == 'bridge/disconnected':
                self.shared_requests.clear()
                self.state['requests'] = []
                self.changed()
                self.persist()
                return
            if self.shared and 'id' in message:
                turn_id = params.get('turnId')
                # Supplementing another client's turn does not transfer its
                # tool/approval request ownership to the web connector.
                owned = any(r.get('turnId') == turn_id and turn_id and r.get('mode') != 'steer' for r in self.submissions.values())
                in_flight = any(r.get('status') == 'unknown' and r.get('mode') != 'steer' for r in self.submissions.values())
                if turn_id and (owned or in_flight):
                    self.shared_requests[str(message['id'])] = copy.deepcopy(message)
                    self._sync_shared_requests()
                    self.changed()
                # Other clients' requests are neither answered nor exposed.
                return
            if self.shared and message.get('method') == 'serverRequest/resolved':
                self.shared_requests.pop(str((message.get('params') or {}).get('requestId')), None)
            if params.get('threadId') == self.id and method in ('item/started', 'item/completed'):
                item = copy.deepcopy(params.get('item') or {})
                message = {**message, 'params': {**params, 'item': item}}
                if method == 'item/completed':
                    item['_completed'] = True
                else:
                    item.pop('_completed', None)
                client_id = item.get('clientId') or item.get('clientUserMessageId') or item.get('client_id')
                row = self.submissions.get(client_id)
                if item.get('type') == 'userMessage' and row and row.get('queueOwner') == 'native':
                    row.update(status='accepted', turnId=params['turnId'], nativeQueueStage='delivered', nativeQueueConfirmed=True)
                    self._sync_shared_requests()
                    self.persist()
            if params.get('threadId') == self.id and method == 'thread/goal/updated':
                self.state['threadGoal'] = normalize_goal(params.get('goal'))
                self.goal_known = self.state['threadGoal'] is not None
                self.goal_supported = self.goal_support_checked = True
                self.persist()
            elif params.get('threadId') == self.id and method == 'thread/goal/cleared':
                self.state['threadGoal'] = None
                self.goal_known = True
                self.goal_supported = self.goal_support_checked = True
                self.persist()
            if params.get('threadId') == self.id and method == 'thread/settings/updated':
                self.condition.notify_all()
            if method == 'error':
                if params.get('threadId') and params.get('threadId') != self.id:
                    return
                # A failed model turn does not mean the backend connection died.
                if not params.get('willRetry'):
                    self.state['threadRuntimeStatus']['type'] = 'idle'
                    turn = next((t for t in reversed(self.state['turns']) if t.get('status') == 'inProgress'), None)
                    if turn:
                        turn['status'] = 'failed'
                        turn['error'] = (params.get('error') or {}).get('message', 'Codex 执行失败')
                        turn_id = turn.get('turnId') or turn.get('id')
                        self.pending_completions.pop(turn_id, None)
                        self.completed_reads.discard(turn_id)
                self.changed()
                return

            if method == 'turn/completed':
                if params.get('threadId') != self.id or not self.ready or self.closed:
                    return
                turn_source = params.get('turn') or {}
                turn_id = turn_source.get('id')
                if not turn_id:
                    return
                if self.shared and self.shared_requests:
                    self.shared_requests = {k: r for k, r in self.shared_requests.items()
                                            if r.get('params', {}).get('turnId') != turn_id}
                turn = self._turn(turn_id)
                items = turn.get('items', [])
                if turn_source.get('items'):
                    items = merge_turn_items(turn_source['items'], items)
                    turn['items'] = items
                if not self.shared:
                    self._commit_completion(turn_id, turn_source)
                    self.completed_reads.add(turn_id)
                    self.queue_event.set()
                elif (terminal_turn_result(turn_source, turn_source.get('items', []), authoritative=True)
                      or terminal_turn_result(turn_source, items, authoritative=False)):
                    self._commit_completion(turn_id, turn_source)
                    self.queue_event.set()
                else:
                    self.pending_completions[turn_id] = copy.deepcopy(turn_source)
                    self.state['threadRuntimeStatus']['type'] = 'active'
                    self.completed_reads.add(turn_id)
                    self.queue_event.set()
                self._release_handoff_turns()
                self.changed()
                return

            super()._event(message)
            self._release_handoff_turns()

            if self.pending_completions:
                turn_id = params.get('turnId')
                if turn_id and turn_id in self.pending_completions:
                    turn = self._turn(turn_id)
                    if terminal_turn_result(self.pending_completions[turn_id], turn.get('items', []), authoritative=False):
                        self._commit_completion(turn_id, self.pending_completions[turn_id])

            if message.get('method') == 'thread/status/changed':
                params = message.get('params') or {}
                if params.get('threadId') == self.id:
                    status = params.get('status') or {}
                    if status.get('type') == 'active':
                        self.state['threadRuntimeStatus']['type'] = 'active'
                    else:
                        if not self.pending_completions and not any(
                                turn.get('status') == 'inProgress' for turn in self.state['turns']):
                            self.state['threadRuntimeStatus']['type'] = 'idle'
                        self.queue_event.set()
            self.changed()
            if message.get('method') == 'bridge/disconnected':
                self.persist()

    def _refresh_completed(self):
        # Completion notifications can omit tools or the final message. The
        # runtime owns completed turns; the rollout file can still lag here.
        # Do not consume pending reads until a terminal native snapshot arrives.
        with self.lock:
            identifiers = set(self.completed_reads)
        if not identifiers:
            return
        if self.shared:
            authoritative, cursor = {}, None
            while True:
                page = self.backend.request('thread/turns/list', {
                    'threadId': self.id, 'limit': min(100, len(identifiers) + 1),
                    'sortDirection': 'desc', **({'cursor': cursor} if cursor else {})})
                authoritative.update((turn['id'], turn) for turn in page['data']
                                     if turn['id'] in identifiers)
                next_cursor = page.get('nextCursor')
                if identifiers <= authoritative.keys() or not next_cursor or next_cursor == cursor:
                    break
                cursor = next_cursor
        else:
            completed = self.backend.request('thread/read', {'threadId': self.id, 'includeTurns': True})['thread']['turns']
            authoritative = {turn['id']: turn for turn in completed if turn['id'] in identifiers}
        with self.condition:
            resolved, changed = set(), False
            for turn in self.state['turns']:
                turn_id = turn.get('turnId') or turn.get('id')
                source = authoritative.get(turn_id)
                if not source:
                    continue
                pending_meta = self.pending_completions.get(turn_id)
                if source.get('status') == 'inProgress':
                    continue
                if turn.get('status') == 'inProgress' and not pending_meta and source.get('status') not in ('completed', 'failed', 'interrupted', 'cancelled'):
                    continue
                # A sparse backfill must never delete items already observed
                # through the native event stream. Native IDs define identity.
                items = merge_turn_items(source.get('items', []), turn['items'])
                if items != turn['items']:
                    turn['items'] = items
                    changed = True
                # thread/turns/list can expose status=completed before its
                # final assistant item becomes readable. Keep this turn in the
                # existing bounded completion queue until the visible result
                # (or a terminal error) arrives; otherwise the browser settles
                # and closes SSE with only the last tool card on screen.
                if not self.shared or terminal_turn_result(source, items, authoritative=True):
                    resolved.add(turn_id)
                    terminal_source = source if source.get('status') in ('completed', 'failed', 'interrupted', 'cancelled') else (pending_meta or source)
                    self._commit_completion(turn_id, terminal_source)
                    changed = True
            self.completed_reads.difference_update(resolved)
            if changed:
                self.changed()

    def _queue_loop(self):
        while True:
            with self.lock:
                native_pending = any(row.get('queueOwner') == 'native' and (not row.get('nativeQueueConfirmed') or row.get('nativePromotion', {}).get('stage') not in (None, 'done'))
                                     and row['status'] in ('queued', 'unknown') for row in self.submissions.values())
                completion_pending = bool(self.completed_reads)
            self.queue_event.wait(timeout=5 if native_pending or completion_pending else None)
            self.queue_event.clear()
            with self.actions:
                with self.lock:
                    if self.closed:
                        return
                for row in self.submissions.values():
                    if row['status'] == 'queued' and row.get('mode') == 'queue' and row.get('workMode', 'default') == 'default' and not row.get('queueOwner'):
                        row.update(queueOwner='native', nativeQueueStage='prepared')
                        self.persist()
                from bridge.clients.codex.native_queue import reconcile_handoffs
                reconcile_handoffs(self)
                from bridge.clients.codex.native_promotion import reconcile as reconcile_promotions
                reconcile_promotions(self)
                try:
                    self._refresh_completed()
                except Exception:
                    logging.getLogger(__name__).exception('Completed Codex turn read failed')
                with self.lock:
                    if not self.view()['connected'] or self.state['threadRuntimeStatus']['type'] == 'active' or self.state['requests']:
                        continue
                    queued = next(((key, row) for key, row in self.submissions.items() if row['status'] == 'queued' and row.get('queueOwner') != 'native'), None)
                if queued:
                    try:
                        self._dispatch(*queued)
                    except Exception as error:
                        with self.lock:
                            if queued[1]['status'] == 'queued':
                                queued[1]['status'] = 'failed'
                                queued[1]['error'] = str(error)
                            self.persist()
                            self.changed()

    def persist(self, *, touch=True):
        # Snapshot and disk publication share the mutators' Chat lock. Releasing
        # it between them lets an older metadata save erase a newer queue row.
        with self.lock:
            model, effort = self.state.get('latestModel'), self.state.get('latestReasoningEffort')
            goal = copy.deepcopy(self.state.get('threadGoal'))
            goal_known, goal_supported = self.goal_known, self.goal_supported
            goal_support_checked = self.goal_support_checked
            submissions = {key: {k: v for k, v in row.items() if k != 'catalog'}
                           for key, row in self.submissions.items()}
            with self.bridge.registry_lock:
                entry = self.bridge.records['threads'].get(self.id)
                if entry is None:
                    return  # A read-only shared observer has no durable web record.
                update = dict(model=model, effort=effort, submissions=submissions,
                              goalKnown=goal_known, goalSupported=goal_supported,
                              goalSupportChecked=goal_support_checked)
                if goal_known:
                    update['threadGoal'] = goal
                if touch:
                    update['updatedAt'] = time.time()
                # Mode and native goal share one revision across GET, polling and
                # events. A stale pre-goal response must not clear a newer goal.
                goal_keys = ('threadGoal', 'goalKnown', 'goalSupported', 'goalSupportChecked')
                if any(key in update and entry.get(key) != update[key] for key in goal_keys):
                    entry['composerRevision'] = entry.get('composerRevision', 0) + 1
                if any(entry.get(key) != value for key, value in update.items()):
                    entry.update(update)
                    self.bridge.save()

    def refresh_native_goal(self):
        with self.condition:
            revision = self.composer_state()['revision']
        try:
            goal = native_goal(self.backend.request('thread/goal/get', {'threadId': self.id}, timeout=15))
        except Exception as error:
            # A transport/read failure says nothing about the confirmed goal.
            # Keep its durable snapshot through reconnects and observer reloads.
            if goal_rpc_unsupported(error):
                with self.condition:
                    if self.composer_state()['revision'] != revision:
                        return
                    self.goal_supported = False
                    self.goal_support_checked = True
                    self.persist(touch=False)
                    self.changed()
            return
        with self.condition:
            if self.composer_state()['revision'] != revision:
                return  # A goal event or user command overtook this read.
            self.goal_supported = True
            self.goal_support_checked = True
            self.goal_known = True
            self.state['threadGoal'] = goal
            self.persist(touch=False)
            self.changed()

    def composer_state(self):
        with self.bridge.registry_lock:
            entry = copy.deepcopy(self.bridge.records.get('threads', {}).get(self.id, {}))
        return composer_state(composer_mode(entry.get('composerMode', 'normal')),
                              self.state.get('threadGoal'), goal_known=self.goal_known,
                              goal_capable=self.goal_supported, revision=entry.get('composerRevision', 0))

    def _prepare_goal_submission(self, submission, row):
        objective = row.get('text', '').strip()
        if not objective or len(objective) > 4000:
            raise ValueError('目标内容需为 1 至 4000 字')
        marker = row.get('goalMutation')
        if marker:
            row['status'] = 'failed' if marker.get('state') == 'failed' else 'unknown'
            row['error'] = ('原生目标操作已失败，消息不会自动重试' if marker.get('state') == 'failed'
                            else '原生目标操作结果尚未确认，不会自动重试')
            self.persist()
            return False
        row['status'] = 'unknown'
        row['goalMutation'] = {'state': 'pending', 'objective': objective, 'at': time.time()}
        self.persist()
        try:
            current = native_goal(self.backend.request(
                'thread/goal/get', {'threadId': self.id}, timeout=15))
        except Exception as error:
            if goal_rpc_unsupported(error):
                self.goal_supported = False
                self.goal_support_checked = True
                row['status'] = 'failed'
                row['error'] = '当前 Codex 运行时不支持原生目标'
                row['goalMutation']['state'] = 'failed'
            else:
                row['error'] = '原生目标读取结果未确认；消息已保留且不会自动重试'
                row['goalMutation']['state'] = 'unknown'
            self.persist()
            return False
        self.goal_supported = True
        self.goal_support_checked = True
        with self.condition:
            self.state['threadGoal'] = current
            self.goal_known = True
            self.persist()
            self.changed()
        decision, error_message, _ = plan_goal_command('create', objective, current)
        if decision == 'invalid':
            row['status'] = 'failed'
            row['error'] = error_message
            row['goalMutation'].update(state='failed', before=current)
            self.persist()
            return False
        if decision == 'execute':
            row['goalMutation'].update(state='sent', before=current, sentAt=time.time())
            self.persist()
            try:
                self.backend.request('thread/goal/set', {
                    'threadId': self.id, 'objective': objective, 'status': 'active', 'origin': 'user'}, timeout=15)
            except Exception as error:
                if goal_rpc_unsupported(error):
                    self.goal_supported = False
                    row['status'] = 'failed'
                    row['error'] = '当前 Codex 运行时不支持原生目标'
                    row['goalMutation']['state'] = 'failed'
                elif getattr(error, 'rpc_error', None):
                    row['status'] = 'failed'
                    row['error'] = 'Codex 拒绝设置原生目标，消息已保留'
                    row['goalMutation']['state'] = 'failed'
                else:
                    row['error'] = '原生目标设置结果未确认；消息已保留且不会自动重试'
                    row['goalMutation']['state'] = 'unknown'
                self.persist()
                return False
            try:
                current = native_goal(self.backend.request(
                    'thread/goal/get', {'threadId': self.id}, timeout=15))
            except Exception as error:
                if goal_rpc_unsupported(error):
                    self.goal_supported = False
                row['error'] = '目标设置已发送，但原生状态未确认；消息已保留且不会自动重试'
                row['goalMutation']['state'] = 'unknown'
                self.persist()
                return False
            if not current or current['objective'] != objective or current['status'] != 'active':
                row['error'] = '目标设置已发送，但原生状态与请求不一致；消息已保留且不会自动重试'
                row['goalMutation']['state'] = 'unknown'
                self.persist()
                return False
        self.state['threadGoal'] = current
        self.goal_known = True
        self.goal_supported = True
        row['goalMutation'].update(state='confirmed', identity=goal_identity(current), confirmedAt=time.time())
        row.pop('error', None)
        self.persist()
        return True

    def _submission_input(self, row):
        if 'nativeQueueInput' in row:
            return copy.deepcopy(row['nativeQueueInput'])
        return super()._submission_input(row)

    def _dispatch(self, submission, row):
        # The base implementation sets unknown before issuing its RPC. Persist
        # that state before transport: a crash can never cause automatic resend.
        try:
            if self.shared:
                self.refresh_shared_state()
                if row['mode'] != 'steer' and self.state['threadRuntimeStatus']['type'] == 'active':
                    if row['mode'] == 'queue':
                        return {'id': submission, 'status': 'queued'}
                    raise ValueError('原会话正在运行任务，请选择完成后发送或补充当前任务')
            if row['mode'] != 'steer' and row.get('workMode') == 'goal':
                # Capture the input selection, independently of goal snapshot revisions.
                # A newer selection on either client must survive this request.
                with self.bridge.registry_lock:
                    entry = self.bridge.records['threads'][self.id]
                    row.setdefault('composerModeRevision', entry.get('composerModeRevision', 0))
                if not self._prepare_goal_submission(submission, row):
                    return {'id': submission, 'status': row['status'], 'error': row.get('error')}
                try:
                    result = super()._dispatch(submission, row)
                except Exception as error:
                    row['error'] = '原生目标已确认，但目标消息发送失败：' + str(error)
                    self.persist()
                    raise
                if result.get('status') == 'unknown':
                    row['error'] = '原生目标已确认，但目标消息发送结果未确认；消息已保留且不会自动重试'
                elif result.get('status') == 'failed':
                    row['error'] = '原生目标已确认，但目标消息发送失败；消息已保留'
                self.persist()
                return result
            return super()._dispatch(submission, row)
        finally:
            if self.shared:
                with self.condition:
                    self._sync_shared_requests()
            self.persist()
            with self.condition:
                self.changed()

    def send(self, *args, **kwargs):
        # HTTP retries reuse this ledger; the native queue is the only executor.
        from bridge.clients.codex.native_queue import handoff
        with self.actions:
            if kwargs.get('mode') == 'queue' and kwargs.get('work_mode', 'default') != 'default':
                raise ValueError('计划或目标模式请等待当前任务结束后发送；原文和附件将退回输入框')
            if kwargs.get('mode') == 'queue' and (self.state.get('latestCollaborationMode') or {}).get('mode', 'default') != 'default':
                raise ValueError('原生会话当前处于计划模式，请空闲后发送；原文和附件将退回输入框')
            try:
                result = super().send(*args, **kwargs)
                submission = str(args[1])
                row = self.submissions.get(submission)
                if row and row['mode'] == 'queue' and row['status'] == 'queued' and row.get('queueOwner') != 'native':
                    row.update(queueOwner='native', nativeQueueStage='prepared')
                    self.persist()
                    result = handoff(self, submission, row)
                elif row and row.get('nativeQueueConfirmed'):
                    result = {**result, 'nativeQueueConfirmed': True, 'nativeQueueId': row.get('nativeQueueId')}
                return result
            finally:
                self.persist()
                with self.condition:
                    self.changed()

    def view(self, *, include_turns=True):
        # Use native parsing, including attachments overlaid from the ledger.
        with self.lock:
            result = super().view(include_turns=include_turns)
            async_pending = async_requests(self.state)
            restored_async = []
            for request in async_pending:
                submission = self.submissions.get(async_submission_id(self.id, request['id']))
                if submission and submission.get('status') in ('queued', 'unknown', 'accepted'):
                    continue
                restored_async.append(request)
            result['requests'] = [request for request in result.get('requests', [])
                                  if request.get('method') != 'bridge/requestUserInputAsync'] + restored_async
        result = {**result, 'connected': self.connected, 'sequence': self.sequence,
                  'submissions': pending_submissions(self.submissions),
                  'connectionError': None if self.connected else ('原 WSL 服务连接已断开，请重连；待确认消息不会自动重发' if self.shared else 'WSL 运行时已停止，后台服务正在恢复'),
                  'connecting': False, 'activating': False, 'loadingHistory': False,
                  'host': 'local', 'hostLabel': 'WSL Codex', 'files': [],
                  'goalRuntimeAvailable': self.goal_supported, 'goalTransport': 'standalone', 'goalActivationIds': [],
                  'composerState': self.composer_state(),
                  'savedHistoryMore': False, 'forkedFrom': None}
        if not self.goal_known:
            result.pop('goal', None)
        return result


class StandaloneBridge(Bridge):
    standalone = True
    compatibility = json.loads((Path(__file__).resolve().parents[3] / "protocol.json").read_text())
    # These existing methods operate on the selected local store and native
    # workspace/upload modules. They do not connect to a Desktop owner.
    upload = Bridge.upload
    upload_thumb = Bridge.upload_thumb
    upload_preview = Bridge.upload_preview
    workspace = Bridge.workspace
    terminal = Bridge.terminal
    artifact = Bridge.artifact
    desktop_image_preview = Bridge.desktop_image_preview
    catalog = Bridge.catalog
    _annotate_upload_attachments = Bridge._annotate_upload_attachments

    def __init__(self, home, directory, root, executable, history_home=None, workspaces=None, history_socket=None, runtime_updates=None):
        # Do not call Bridge.__init__: that starts Desktop IPC/discovery workers.
        self.host, self.codex_home, self.data_dir = 'local', Path(home), Path(directory)
        self.root = Path(root).resolve(strict=True)
        configured = workspaces or [{'key': 'local|wsl', 'name': self.root.name, 'path': str(self.root)}]
        self.workspaces = [{'key': item['key'], 'name': item['name'],
                            'path': Path(item['path']).resolve(strict=True)} for item in configured]
        if len({item['key'] for item in self.workspaces}) != len(self.workspaces):
            raise ValueError('WSL 项目标识不能重复')
        self.workspace_by_key = {item['key']: item for item in self.workspaces}
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.data_dir / 'web-threads.json'
        self.records = json.loads(self.path.read_text()) if self.path.exists() else {'threads': {}, 'creations': {}}
        self.records.setdefault('threads', {})
        self.records.setdefault('creations', {})
        self.records.setdefault('titleOverrides', {})
        self.registry_lock = threading.RLock()
        self.goal_lock = threading.RLock()
        self.lock = threading.RLock()
        self.live = {}
        self.closed = threading.Event()
        self.host_errors = []
        self.hosts = Projects(self.workspaces)
        self.store = SessionStore(home)
        self.history_home = Path(history_home).resolve(strict=True) if history_home else None
        if history_socket and (not self.history_home or not Path(history_socket).is_absolute()):
            raise ValueError('共享历史运行时需要 historyHome 与本机绝对 socket 路径')
        self.history_socket = str(history_socket) if history_socket else None
        self.history = WslHistory(self.history_home, self.workspaces) if self.history_home else None
        # Offline web chats belong to this backend's Codex home. Read their
        # rollout metadata without resuming the runtime or consulting the
        # separately configured desktop-history home.
        self.web_history = WslHistory(self.store.home, self.workspaces)
        self.catalog_reader = Catalog(home, executable)
        self.uploads = Uploads(directory)
        self.terminals = TerminalManager()
        self.accounts = None
        self.clients = Clients(self)
        self.side_chats = SideChats(executable, home, directory, 'local')
        self.runtime = Runtime(executable, home, str(self.root), lambda m: self._runtime_event(m, 'web'))
        self.executable = executable
        self.cli_version_lock = threading.Lock()
        self.cli_version_cache = None
        self.runtime_updates = RuntimeUpdate(executable, self.history_home, self.history_socket, runtime_updates)
        self.history_runtime = None
        self.native_queue = None
        self.web_native_queue = None

    def cli_version(self):
        """Installed and running versions have separate authorities."""
        with self.cli_version_lock:
            now = time.monotonic()
            controller = getattr(self, 'runtime_updates', None) or RuntimeUpdate(self.executable)
            try:
                executable = Path(shutil.which(self.executable) or self.executable).resolve(strict=True)
                key = (str(executable), executable.stat().st_mtime_ns)
            except OSError:
                key = None
            cached = self.cli_version_cache
            if cached and cached[0] == key and cached[1] > now:
                return cached[2]
            value = controller.status()
            if not value['codexCliVersion']:
                value['codexCliVersionError'] = 'Codex CLI 版本暂不可用'
            self.cli_version_cache = (key, now + 5, value)
            return value

    def save(self):
        private_json(self.path, self.records)

    def _record(self, identifier):
        uuid.UUID(identifier)
        with self.registry_lock:
            entry = self.records['threads'].get(identifier)
            if entry is None:
                if self.history:
                    self.history.get(identifier)
                    raise PermissionError('此 WSL 会话尚未恢复')
                raise KeyError(identifier)
            cwd = Path(entry['cwd']).resolve(strict=True)
            if not any(cwd.is_relative_to(item['path']) for item in self.workspaces):
                raise PermissionError('会话目录不在此入口的项目范围内')
            return copy.deepcopy(entry)

    def _scoped_record(self, identifier):
        """Authorize local file operations from registry/history metadata only."""
        uuid.UUID(identifier)
        with self.registry_lock:
            registered = identifier in self.records['threads']
        if registered:
            return self._record(identifier)
        if not self.history:
            raise KeyError('找不到这个会话')
        meta = self.history.get(identifier)
        cwd = Path(meta['cwd']).resolve(strict=True)
        if not self.history.workspace(cwd):
            raise PermissionError('会话目录不在此入口的项目范围内')
        return {'title': meta.get('name') or meta.get('title') or '未命名聊天',
                'cwd': str(cwd), 'runtime': 'history', 'path': self.history.rollout_path(meta)}

    def _validated_rollout_path(self, value, home=None):
        if not isinstance(value, str) or not value:
            return None
        try:
            path = Path(value).resolve(strict=True)
            if not path.is_file():
                return None
            homes = [Path(home)] if home else [self.codex_home]
            if home is None and self.history_home:
                homes.append(self.history_home)
            for home in homes:
                for folder in ('sessions', 'archived_sessions'):
                    root = home / folder
                    try:
                        root = root.resolve(strict=True)
                    except OSError:
                        continue
                    if path.is_relative_to(root):
                        return str(path)
        except (OSError, RuntimeError, ValueError):
            pass
        return None

    def _thread_path(self, identifier, entry=None):
        entry = entry or {}
        runtime = entry.get('runtime')
        home = (self.history_home if runtime == 'history' else
                self.store.home if runtime == 'web' else None)
        path = self._validated_rollout_path(entry.get('path'), home)
        if path:
            return path
        history = (self.history if runtime == 'history' else
                   self.web_history if runtime == 'web' else self.history)
        if history:
            try:
                return history.rollout_path(history.get(identifier))
            except (KeyError, OSError, ValueError):
                pass
        return None

    def _title_override(self, identifier):
        with self.registry_lock:
            value = self.records.get('titleOverrides', {}).get(identifier)
        return value if isinstance(value, str) and value else None

    def _with_title_override(self, identifier, result):
        # Keep legacy saved overrides recoverable, but never let them obscure
        # a current native name (including a rename performed in Desktop).
        return result

    def _history_backend(self):
        if not self.history_home:
            raise PermissionError('未配置 WSL 历史运行时')
        if self.history_runtime is None:
            event = lambda message: self._runtime_event(message, 'history')
            self.history_runtime = (SharedRuntime(self.history_socket, event, home=self.history_home)
                                    if self.history_socket else
                                    Runtime(self.executable, self.history_home, str(self.root), event))
        self.history_runtime.start()
        return self.history_runtime

    def _native_queue(self, thread_id):
        entry = self._scoped_record(thread_id)
        if entry.get('runtime') == 'web':
            with self.lock:
                if self.web_native_queue is None:
                    self.web_native_queue = NativeQueue(self.runtime)
                return self.web_native_queue
        if not getattr(self, 'history_socket', None):
            return None
        # Only the configured original shared owner, never a new side runtime.
        with self.lock:
            if self.native_queue is None:
                self.native_queue = NativeQueue(self._history_backend())
            return self.native_queue

    def _native_queue_items(self, thread_id):
        native = self._native_queue(thread_id)
        return native.read(thread_id) if native else []

    def _resume_history(self, backend, identifier):
        params = {'threadId': identifier}
        if getattr(backend, 'shared', False):
            # Join metadata only; the scoped local store owns long histories.
            params['excludeTurns'] = True
        result = backend.request('thread/resume', params)
        if getattr(backend, 'shared', False):
            saved = self.history.session(identifier, full=False)
            with saved.condition:
                result = {**result, 'thread': {**result['thread'], 'turns': copy.deepcopy(saved.state['turns']),
                          'turnsPagination': copy.deepcopy(saved.state.get('turnsPagination', {'hasLoadedOldest': True}))}}
        return result

    def _observe_history(self, identifier):
        # Selecting an original session subscribes to its existing owner, so
        # native active/idle state and live items reach the same Pi front end.
        # No registry write or model turn is needed for observation.
        meta = self.history.get(identifier)
        expected = Path(meta['cwd']).resolve(strict=True)
        with self.lock:
            existing = self.live.get(identifier)
            if existing:
                return existing
            backend = self._history_backend()
            result = self._resume_history(backend, identifier)
            if Path(result['thread']['cwd']).resolve() != expected:
                raise PermissionError('共享运行时返回的工作区与历史记录不一致')
            entry = {**copy.deepcopy(self.records['threads'].get(identifier, {})),
                     'title': self._title_override(identifier) or meta.get('name') or meta.get('title') or '未命名聊天',
                     'cwd': str(expected), 'model': result.get('model'), 'effort': result.get('reasoningEffort')}
            chat = Chat(self, identifier, result, backend, entry=entry)
            self.live[identifier] = chat
            self._start_queue(chat)
            return chat

    @staticmethod
    def _sandbox_type(value):
        if isinstance(value, str) and value.startswith('{'):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        if isinstance(value, dict):
            value = value.get('type')
        aliases = {'danger-full-access': 'dangerFullAccess', 'workspace-write': 'workspaceWrite',
                   'read-only': 'readOnly'}
        return aliases.get(value, value or 'dangerFullAccess')

    def _adopt_record(self, identifier):
        try:
            return self._record(identifier)
        except PermissionError:
            pass
        with self.lock:
            with self.registry_lock:
                existing = self.records['threads'].get(identifier)
            if existing:
                return self._record(identifier)
            meta = self.history.get(identifier)
            expected = Path(meta['cwd']).resolve(strict=True)
            project = self.history.workspace(expected)
            if not project:
                raise PermissionError('会话目录不在此入口的项目范围内')
            backend = self._history_backend()
            # Resume with the thread id alone so Codex restores its original
            # model, approval and sandbox settings instead of broadening them.
            result = self._resume_history(backend, identifier)
            actual = Path(result.get('cwd') or result['thread'].get('cwd') or '').resolve(strict=True)
            if actual != expected:
                raise PermissionError('运行时返回的项目目录与历史记录不一致')
            entry = {
                'title': self._title_override(identifier) or meta.get('name') or meta.get('title') or '未命名聊天',
                'cwd': str(expected), 'createdAt': meta.get('created_at') or time.time(),
                'updatedAt': time.time(), 'runtime': 'history',
                'model': result.get('model') or meta.get('model'),
                'effort': result.get('reasoningEffort') or meta.get('reasoning_effort'),
                'approvalPolicy': result.get('approvalPolicy') or meta.get('approval_mode') or 'on-request',
                'sandboxType': self._sandbox_type(result.get('sandbox') or meta.get('sandbox_policy')),
            }
            path = self.history.rollout_path(meta)
            if path:
                entry['path'] = path
            with self.registry_lock:
                self.records['threads'][identifier] = entry
                self.save()
            chat = self.live.get(identifier)
            if chat and chat.connected:
                chat.persist()
            else:
                if chat:
                    with chat.condition:
                        chat.closed = True
                        chat.queue_event.set()
                chat = Chat(self, identifier, result, backend)
                self.live[identifier] = chat
                self._start_queue(chat)
            return copy.deepcopy(entry)

    def upload(self, thread_id, *args):
        self._scoped_record(thread_id)
        return self.uploads.put(thread_id, *args)

    def upload_thumb(self, thread_id, *args):
        self._scoped_record(thread_id)
        return self.uploads.set_thumb(thread_id, *args)

    def upload_preview(self, thread_id, *args):
        self._scoped_record(thread_id)
        return self.uploads.preview(thread_id, *args)

    def workspace(self, thread_id, *args):
        entry = self._scoped_record(thread_id)
        return workspace_operation(entry['cwd'], *args)

    def terminal(self, thread_id, *args):
        self._adopt_record(thread_id)
        return Bridge.terminal(self, thread_id, *args)

    def for_host(self, host):
        if host != 'local':
            raise PermissionError('此入口只连接指定的 WSL Codex')
        return self

    def _runtime_event(self, message, source='web'):
        method, params = message.get('method'), message.get('params') or {}
        backend = self.history_runtime if source == 'history' else self.runtime
        native = getattr(self, 'native_queue' if source == 'history' else 'web_native_queue', None)
        if native and method in ('thread/queue/changed', 'bridge/disconnected'):
            native.invalidate(params.get('threadId'))
        if method == 'bridge/disconnected':
            for chat in list(self.live.values()):
                if chat.backend is not backend:
                    continue
                if getattr(backend, 'shared', False):
                    with chat.condition:
                        chat.ready = False
                        chat.error = '原 WSL 服务连接已断开，请重连；待确认消息不会自动重发'
                chat._event(message)
            if not getattr(backend, 'shared', False):
                # Only an owned process failure restarts this gateway.
                self.closed.set()
            return
        chat = self.live.get(params.get('threadId'))
        if chat and chat.backend is backend:
            if method == 'thread/name/updated' and isinstance(params.get('threadName'), str):
                with chat.condition:
                    chat.state['name'] = params['threadName']
                    chat.state['title'] = params['threadName']
                    chat.changed()
            chat._event(message)
        elif 'id' in message and not getattr(backend, 'shared', False):
            backend.write({'id': message['id'], 'error': {'code': -32601, 'message': '此请求不属于网页管理的会话'}})

    def create_chat(self, project_key, title, request_id, cwd=None):
        uuid.UUID(str(request_id))
        project = self.workspace_by_key.get(project_key)
        if not project:
            raise ValueError('请选择 WSL 中的指定项目')
        if not isinstance(title, str) or not title.strip() or len(title) > 120:
            raise ValueError('请输入 1–120 字的聊天名称')
        title = title.strip()
        target_cwd = project['path']
        if cwd is not None:
            _, resolved_cwd = resolve_scoped_cwd(cwd, self.workspaces, must_exist=True)
            if not (resolved_cwd == project['path'] or resolved_cwd.is_relative_to(project['path'])):
                raise PermissionError('指定工作区超出所选项目授权范围')
            target_cwd = resolved_cwd
        with self.lock:
            with self.registry_lock:
                prior = copy.deepcopy(self.records['creations'].get(request_id))
            if prior:
                if prior['title'] != title:
                    raise ValueError('同一创建请求不能用于不同内容')
                prior_cwd = prior.get('cwd')
                if prior_cwd is None and prior.get('id'):
                    prior_cwd = self.records['threads'].get(prior['id'], {}).get('cwd')
                if prior_cwd is not None and str(target_cwd) != str(prior_cwd):
                    raise ValueError('同一创建请求不能用于不同工作区')
                if prior.get('deleted'):
                    raise ValueError('此创建请求对应的会话已删除，请重新新建聊天')
                if not prior.get('id'):
                    raise ValueError('上次创建结果未确认，请检查后台记录，避免重复创建')
                return {'id': prior['id'], 'host': 'local', 'opened': True}
            backend = self._history_backend() if self.history_socket else self.runtime
            backend.start()
            with self.registry_lock:
                self.records['creations'][request_id] = {'title': title, 'cwd': str(target_cwd)}
                self.save()
            result = backend.request('thread/start', {'cwd': str(target_cwd), 'persistExtendedHistory': True})
            identifier = result['thread']['id']
            thread_path = self._validated_rollout_path((result.get('thread') or {}).get('path'),
                                                       self.history_home if self.history_socket else self.store.home)
            with self.registry_lock:
                entry = {'title': title, 'cwd': str(target_cwd),
                         'runtime': 'history' if self.history_socket else 'web', 'createdAt': time.time(), 'updatedAt': time.time()}
                if thread_path:
                    entry['path'] = thread_path
                self.records['threads'][identifier] = entry
                self.records['creations'][request_id]['id'] = identifier
                self.save()
            chat = Chat(self, identifier, result, backend)
            self.live[identifier] = chat
            backend.request('thread/name/set', {'threadId': identifier, 'name': title})
            self._start_queue(chat)
            return {'id': identifier, 'host': 'local', 'opened': True, 'cwd': str(target_cwd), 'message': 'WSL 聊天已创建'}

    def worktree_info(self, cwd):
        ws, resolved = resolve_scoped_cwd(cwd, self.workspaces, must_exist=True)
        return get_scoped_worktree_info(resolved, ws)

    def create_worktree(self, cwd, branch):
        ws, resolved = resolve_scoped_cwd(cwd, self.workspaces, must_exist=True)
        return create_scoped_worktree(resolved, branch, ws)

    def remove_worktree(self, cwd, path, force=False):
        return remove_scoped_worktree(cwd, path, force=force)

    def browse_directories(self, path=None):
        if not path or path == '/':
            return {
                'path': '',
                'parentPath': None,
                'directories': [{'name': ws['name'], 'path': str(ws['path'])} for ws in self.workspaces]
            }
        ws, resolved = resolve_scoped_cwd(path, self.workspaces, must_exist=True)
        return browse_scoped_directories(resolved, ws)

    def validate_cwd(self, cwd):
        ws, resolved = resolve_scoped_cwd(cwd, self.workspaces, must_exist=True)
        info = get_scoped_worktree_info(resolved, ws)
        project_root = info.get('projectRoot') if info.get('isGit') else str(ws['path'])
        return {
            'success': True,
            'cwd': str(resolved),
            'projectRoot': project_root,
            'projectKey': ws['key'],
            'isGit': info.get('isGit', False)
        }

    @staticmethod
    def _start_queue(chat):
        chat.queue_worker = threading.Thread(target=chat._queue_loop, daemon=True)
        chat.queue_worker.start()
        chat.queue_event.set()

    def session(self, thread_id, attach=True, background=False, force=False):
        with self.registry_lock:
            owned = thread_id in self.records['threads']
        if not owned and self.history:
            if self.history_socket:
                try:
                    return self._observe_history(thread_id)
                except (SideChatError, OSError):
                    # History remains readable while the original owner is unavailable.
                    pass
            return self.history.session(thread_id, full=False)
        entry = self._record(thread_id)
        with self.lock:
            chat = self.live.get(thread_id)
            if chat:
                if not (attach and chat.shared and not chat.connected):
                    return chat
                # Explicit reconnect replaces this connection's observer only.
                with chat.condition:
                    chat.closed = True
                    chat.queue_event.set()
                del self.live[thread_id]
            if not attach:
                if entry.get('runtime') == 'history' and self.history_socket:
                    try:
                        return self._observe_history(thread_id)
                    except (SideChatError, OSError):
                        pass
                history = (self.history if entry.get('runtime') == 'history' else
                           self.web_history if entry.get('runtime') == 'web' else None)
                if history:
                    return history.session(thread_id, full=False)
                raise KeyError('此会话当前没有可读取的只读历史')
            # Only the registry can authorize a resume. No arbitrary UUIDs and
            # no scanning/importing of ~/.codex or desktop session databases.
            backend = self._history_backend() if entry.get('runtime') == 'history' else self.runtime
            backend.start()
            params = {'threadId': thread_id} if entry.get('runtime') == 'history' else {
                'threadId': thread_id, 'cwd': entry['cwd'],
                'persistExtendedHistory': True}
            result = (self._resume_history(backend, thread_id) if entry.get('runtime') == 'history'
                      else backend.request('thread/resume', params))
            if Path(result['thread']['cwd']).resolve() != Path(entry['cwd']).resolve():
                raise PermissionError('运行时返回的项目目录与网页登记不一致')
            chat = Chat(self, thread_id, result, backend)
            self.live[thread_id] = chat
            chat.refresh_native_goal()
            self._start_queue(chat)
            return chat

    def view(self, thread_id, **options):
        native_items = self._native_queue_items(thread_id)
        chat = self.session(thread_id, attach=False)
        with chat.condition:
            result = self._with_title_override(thread_id, chat.view(include_turns=not options.get('metadata', False)))
            if not isinstance(chat, Chat):
                with self.registry_lock:
                    entry = copy.deepcopy(self.records['threads'].get(thread_id))
                if entry is not None:
                    result['composerState'] = composer_state(
                        composer_mode(entry.get('composerMode', 'normal')),
                        entry.get('threadGoal'), goal_known=bool(entry.get('goalKnown')),
                        goal_capable=entry.get('goalSupported') is not False, revision=entry.get('composerRevision', 0))
            result['submissions'] = merge_native_queue(result.get('submissions', []), native_items, getattr(chat, 'submissions', {}))
            return result

    def set_composer_mode(self, thread_id, mode):
        uuid.UUID(str(thread_id))
        mode = composer_mode(mode)
        with self.registry_lock:
            registered = thread_id in self.records['threads']
        if not registered:
            self._adopt_record(thread_id)
        with self.registry_lock:
            entry = self.records['threads'].get(thread_id)
            if entry is None:
                raise KeyError(thread_id)
            cwd = Path(entry['cwd']).resolve(strict=True)
            if not any(cwd.is_relative_to(item['path']) for item in self.workspaces):
                raise PermissionError('会话目录不在此入口的项目范围内')
            if mode == 'goal' and entry.get('goalSupported') is False:
                raise ValueError('当前 Codex 运行时不支持原生目标')
            support_checked = bool(entry.get('goalSupportChecked', entry.get('goalSupported') is not None))
        if mode == 'goal' and not support_checked:
            with self.lock:
                existing_chat = self.live.get(thread_id)
            chat = self.session(thread_id)
            if existing_chat is chat and not chat.goal_support_checked:
                chat.refresh_native_goal()
            if not chat.goal_support_checked:
                raise ValueError('无法确认当前 Codex 运行时的原生目标能力，请稍后重试')
            if not chat.goal_supported:
                raise ValueError('当前 Codex 运行时不支持原生目标')
        with self.registry_lock:
            entry = self.records['threads'].get(thread_id)
            if entry is None:
                raise KeyError(thread_id)
            if mode == 'goal' and entry.get('goalSupported') is False:
                raise ValueError('当前 Codex 运行时不支持原生目标')
            if entry.get('composerMode', 'normal') != mode:
                entry['composerMode'] = mode
                entry['composerModeRevision'] = entry.get('composerModeRevision', 0) + 1
                entry['composerRevision'] = entry.get('composerRevision', 0) + 1
                self.save()
        return self.view(thread_id)

    def _goal_native(self, chat, method, params):
        try:
            result = chat.backend.request(method, params, timeout=15)
        except Exception as error:
            if goal_rpc_unsupported(error):
                chat.goal_supported = False
                chat.goal_support_checked = True
                chat.persist()
            raise
        chat.goal_supported = True
        chat.goal_support_checked = True
        return result

    @staticmethod
    def _store_goal_snapshot(chat, goal, *, known=True):
        if not known:
            return  # Unknown command outcome does not clear the confirmed goal.
        with chat.condition:
            chat.state['threadGoal'] = copy.deepcopy(goal)
            chat.goal_known = known
            chat.persist()
            chat.changed()

    def _goal_action(self, thread_id, request_id, action, *, status=None, expected=None):
        request_id = str(uuid.UUID(str(request_id)))
        if action not in ('pause', 'resume', 'cancel'):
            raise ValueError('目标操作无效')
        if expected is not None and not isinstance(expected, dict):
            raise ValueError('目标状态无效')
        if not isinstance(expected, dict):
            raise ValueError('目标状态已变化，请刷新后重试')
        identity = expected.get('goalIdentity') or expected.get('identity') or expected
        expected_status = expected.get('goalStatus', expected.get('status'))
        if not isinstance(identity, dict) or not identity.get('objective'):
            raise ValueError('目标状态已变化，请刷新后重试')
        expected = {**copy.deepcopy(identity), **({'status': expected_status} if expected_status is not None else {})}
        if action in ('pause', 'resume') and status != ('paused' if action == 'pause' else 'active'):
            raise ValueError('目标状态无效')
        chat = self.session(thread_id)
        key = str(request_id)
        fingerprint = json.dumps({'action': action, 'status': status,
                                  'expected': expected}, sort_keys=True, ensure_ascii=False)
        with self.goal_lock, chat.actions:
            entry = self._record(thread_id)
            receipts = entry.get('goalCommandReceipts', {})
            prior = receipts.get(key)
            if prior:
                if prior.get('fingerprint') != fingerprint:
                    raise ValueError('同一目标操作标识不能用于不同内容')
                if prior.get('state') == 'confirmed':
                    response = copy.deepcopy(prior.get('response') or {})
                    response['duplicate'] = True
                    return response
                if prior.get('state') in ('pending', 'sent', 'unknown'):
                    return {'status': 'unknown', 'confirmed': False, 'duplicate': True,
                            'error': prior.get('error') or '目标操作结果尚未确认，不会自动重试'}
                raise ValueError(prior.get('error') or '目标操作失败')

            receipt = {'fingerprint': fingerprint, 'action': action, 'status': status,
                       'expected': copy.deepcopy(expected), 'state': 'pending', 'at': time.time()}
            receipts[key] = receipt
            self._save_goal_receipt(thread_id, receipts)
            try:
                current = native_goal(self._goal_native(chat, 'thread/goal/get', {'threadId': thread_id}))
            except Exception as error:
                self._store_goal_snapshot(chat, None, known=False)
                receipt.update(state='unknown' if not getattr(error, 'rpc_error', None) else 'failed', error=str(error))
                self._save_goal_receipt(thread_id, receipts)
                raise
            self._store_goal_snapshot(chat, current)
            expected_identity = {'objective': str(expected.get('objective') or '').strip(),
                                 'createdAt': expected.get('createdAt')}
            if (goal_identity(current) != expected_identity or
                    (expected.get('status') is not None and (current or {}).get('status') != expected['status'])):
                receipt.update(state='failed', error='目标已发生变化，请刷新后重试')
                self._save_goal_receipt(thread_id, receipts)
                raise ValueError(receipt['error'])
            objective = current['objective']
            decision, message, _ = plan_goal_command(action, objective, current)
            if decision == 'invalid':
                receipt.update(state='failed', error=message)
                self._save_goal_receipt(thread_id, receipts)
                raise ValueError(message)
            if decision == 'duplicate':
                response = {'status': 'cancelled' if action == 'cancel' else status,
                            'confirmed': True, 'duplicate': True, 'result': current}
                receipt.update(state='confirmed', response=response, confirmedAt=time.time())
                self._save_goal_receipt(thread_id, receipts)
                return response

            command = {'action': action, 'objective': objective, 'status': status, 'before': current}
            receipt.update(state='sent', sent=True, before=current, sentAt=time.time())
            self._save_goal_receipt(thread_id, receipts)
            try:
                if action == 'cancel':
                    self._goal_native(chat, 'thread/goal/clear', {'threadId': thread_id, 'origin': 'user'})
                else:
                    self._goal_native(chat, 'thread/goal/set', {
                        'threadId': thread_id, 'status': status, 'origin': 'user'})
            except Exception as error:
                if not getattr(error, 'rpc_error', None):
                    self._store_goal_snapshot(chat, None, known=False)
                receipt.update(state='unknown' if not getattr(error, 'rpc_error', None) else 'failed', error=str(error))
                self._save_goal_receipt(thread_id, receipts)
                raise
            try:
                updated = native_goal(self._goal_native(chat, 'thread/goal/get', {'threadId': thread_id}))
            except Exception as error:
                self._store_goal_snapshot(chat, None, known=False)
                receipt.update(state='unknown', error='目标操作已发送，但原生状态未确认；不会自动重试')
                self._save_goal_receipt(thread_id, receipts)
                return {'status': 'unknown', 'confirmed': False, 'error': receipt['error']}
            if not goal_state_confirms_command(command, updated):
                self._store_goal_snapshot(chat, None, known=False)
                receipt.update(state='unknown', error='目标操作已发送，但原生状态与请求不一致；不会自动重试')
                self._save_goal_receipt(thread_id, receipts)
                return {'status': 'unknown', 'confirmed': False, 'error': receipt['error']}
            response = {'status': 'cancelled' if action == 'cancel' else status,
                        'confirmed': True, 'result': updated}
            receipt.update(state='confirmed', response=response, confirmedAt=time.time())
            self._save_goal_receipt(thread_id, receipts)
            self._store_goal_snapshot(chat, updated)
            return response

    def _save_goal_receipt(self, thread_id, receipts):
        # Confirmed/failed receipts are bounded; uncertain commands are never evicted.
        confirmed = [(key, row) for key, row in receipts.items()
                     if row.get('state') not in ('pending', 'sent', 'unknown')]
        while len(confirmed) > 64:
            key, _ = min(confirmed, key=lambda item: item[1].get('at', 0))
            receipts.pop(key, None)
            confirmed = [(k, row) for k, row in receipts.items()
                         if row.get('state') not in ('pending', 'sent', 'unknown')]
        with self.registry_lock:
            entry = self.records['threads'].get(thread_id)
            if entry is None:
                raise KeyError(thread_id)
            entry['goalCommandReceipts'] = receipts
            entry['updatedAt'] = time.time()
            self.save()

    def cancel_goal(self, thread_id, request_id, expected=None):
        return self._goal_action(thread_id, request_id, 'cancel', expected=expected)

    def set_goal_status(self, thread_id, status, request_id, ui_locale=None, expected=None):
        if status not in ('active', 'paused'):
            raise ValueError('目标状态无效')
        return self._goal_action(thread_id, request_id,
                                 'pause' if status == 'paused' else 'resume',
                                 status=status, expected=expected)

    def edit_goal(self, thread_id, objective, request_id, expected=None):
        raise ValueError('独立后台暂不支持修改原生目标内容')

    def activate(self, thread_id):
        return self.session(thread_id)

    def list(self, query='', limit=100, offset=0, archived=False):
        with self.registry_lock:
            entries = copy.deepcopy(self.records['threads'])
        # Read each configured native store. A stale registry entry must never
        # resurrect a thread deleted/archived/renamed by Desktop.
        rows_by_id = {}
        for store, shared in ((getattr(self, 'web_history', None), False), (self.history, True)):
            if store is None or (not shared and not any(entry.get('runtime') == 'web' for entry in entries.values())):
                continue
            for row in store.list(query, limit + offset, archived=archived):
                identifier = row['id']
                if not shared and (identifier not in entries or entries[identifier].get('runtime') != 'web'):
                    continue
                chat = self.live.get(identifier)
                rows_by_id[identifier] = {**row,
                    'connected': bool(chat and chat.connected),
                    'nativeMetadata': {**row.get('nativeMetadata', {}), 'desktopShared': shared}}
        rows = sorted(rows_by_id.values(), key=lambda row: (row['recency'], row['id']), reverse=True)
        return rows[offset:offset + limit]

    def activity(self, identifiers):
        if not isinstance(identifiers, list) or len(identifiers) > 500:
            raise ValueError('会话状态请求无效')
        # One scoped database snapshot, not one connection/query per thread.
        wanted = [identifier for identifier in identifiers if identifier not in self.records['threads']]
        history_rows = self.history.get_many(wanted) if self.history and wanted else {}
        rows = []
        for identifier in identifiers:
            if self.history and identifier not in self.records['threads']:
                entry = history_rows.get(identifier)
                if entry is None:
                    raise KeyError('找不到指定 WSL 工作区内的会话')
                rows.append({'id': identifier, 'host': 'local', 'recency': entry['updated_at'] * 1000,
                             'connected': False, 'status': 'idle', 'historyOnly': False,
                             'resumableHistory': True})
                continue
            entry = self._record(identifier)
            chat = self.live.get(identifier)
            view = chat.view(include_turns=False) if chat else {}
            rows.append({'id': identifier, 'host': 'local', 'recency': entry['updatedAt'] * 1000,
                         'connected': True if not chat else chat.connected,
                         'status': view.get('status', 'idle'),
                         'hasPendingRequests': bool(view.get('requests'))})
        return rows

    def navigation_index(self, thread_id):
        # Workspace validation happens in history.get; no session attach, runtime
        # ownership or long-lived chat condition is needed for a title index.
        if self.history:
            try:
                return self.history.navigation_index(thread_id)
            except KeyError:
                if thread_id not in self.records['threads']:
                    raise
        return {'available': False}

    def timeline_read(self, thread_id, mode='page', **options):
        native_items = self._native_queue_items(thread_id) if mode != 'detail' else []
        chat = self.session(thread_id, attach=False)
        with chat.condition:
            # Detail chunks belong to an already projected timeline. Reuse its
            # immutable text until a native event changes the sequence instead
            # of normalizing every loaded turn for each 16 KB chunk.
            if mode == 'detail' and chat.timeline.sequence == chat.sequence:
                return {**chat.timeline.detail(**options), 'files': []}
            # Offline history has no in-memory submissions after a gateway restart.
            # The durable registry still owns attachment IDs and delivery state.
            if isinstance(chat, Chat):
                submissions = chat.submissions
            else:
                with self.registry_lock:
                    submissions = copy.deepcopy(self.records.get('threads', {}).get(thread_id, {}).get('submissions', chat.submissions))
            # An unchanged timeline already owns the row bodies. Heartbeats and
            # additional pages only need fresh metadata, not another transcript
            # projection or attachment lookup for every loaded historical turn.
            view = {**chat.view(include_turns=chat.timeline.sequence != chat.sequence),
                    'submissions': merge_native_queue(pending_submissions(submissions), native_items, submissions)}
            count_users = getattr(self.history, 'user_message_count', None)
            if callable(count_users) and (getattr(chat, 'shared', False) or not isinstance(chat, Chat)):
                view['userMessageCount'] = count_users(thread_id)
            # Bind ledger identities before Timeline computes keys/revisions.
            # Native echoes and offline history must have the same user key.
            for turn in view['turns']:
                seen_user = False
                for message in turn['messages']:
                    if message.get('role') != 'user':
                        continue
                    # Saved/native history has no handoff placeholder. Live views
                    # explicitly mark synthesized acknowledgement rows as false.
                    message.setdefault('deliveryConfirmed', True)
                    submission = submissions.get(message.get('requestId'))
                    if not submission and not message.get('requestId') and not seen_user:
                        submission = next((v for v in submissions.values()
                                           if v.get('turnId') == turn['id'] and v.get('mode') != 'steer'), None)
                    seen_user = True
                    if submission:
                        if submission.get('clientRequestId'):
                            message['requestId'] = submission['clientRequestId']
                        message['attachments'] = [{**a, 'type': 'localImage' if a.get('image') else 'file',
                                                   **({'uploadId': a['id']} if a.get('image') else {})}
                                                  for a in copy.deepcopy(submission.get('attachments', []))]
                self._annotate_upload_attachments(chat, turn['messages'])
                turn['actionable'] = bool(turn.get('id')) and turn.get('id') != 'history'
            chat.timeline.update(self._with_title_override(thread_id, view))
            if mode == 'detail':
                result = chat.timeline.detail(**options)
            elif mode == 'changes':
                result = chat.timeline.changes(**options)
            else:
                result = chat.timeline.page(**options)
                # Read another bounded saved prefix only when the requested
                # boundary reaches the beginning of the loaded native turns.
                if (options.get('before') and not result.get('reset') and not result['rows']
                        and result['meta'].get('historyComplete') is False
                        and isinstance(chat, Chat) and chat.shared):
                    # Live shared turns accumulate independently of the saved
                    # tail budget. Read beyond the whole loaded prefix so its
                    # oldest boundary is present even after many native turns.
                    next_limit = max(chat.history_limit, len(chat.state['turns'])) * 2
                    saved = self.history.session(thread_id, turn_limit=next_limit)
                    with saved.condition:
                        turns = saved.state['turns']
                        first = chat.state['turns'][0]['turnId'] if chat.state['turns'] else None
                        boundary = next((i for i, turn in enumerate(turns) if turn.get('turnId') == first), None)
                        if boundary is None:
                            raise ValueError('历史记录的边界已变化，请重新打开会话后继续加载')
                        chat.state['turns'] = copy.deepcopy(turns[:boundary]) + chat.state['turns']
                        chat.state['turnsPagination'] = copy.deepcopy(saved.state['turnsPagination'])
                        chat.history_limit = saved.limit or next_limit
                        chat.changed()
                    return self.timeline_read(thread_id, mode, **options)
            result['files'] = []
            if mode == 'changes':
                with self.registry_lock:
                    entry = copy.deepcopy(self.records['threads'].get(thread_id))
                if isinstance(chat, Chat):
                    state = chat.composer_state()
                elif entry is not None:
                    state = composer_state(composer_mode(entry.get('composerMode', 'normal')),
                                           entry.get('threadGoal'), goal_known=bool(entry.get('goalKnown')),
                                           goal_capable=entry.get('goalSupported') is not False, revision=entry.get('composerRevision', 0))
                else:
                    state = None
                if state is not None:
                    result.setdefault('meta', {})['composerState'] = state
            return result

    def send(self, thread_id, text, submission_id, mode='send', skills=None, *, work_mode=None, attachments=None, ui_locale=None, client_request_id=None, _text_limit=20000):
        if client_request_id is not None and (not isinstance(client_request_id, str) or not __import__("re").fullmatch(r"[a-zA-Z0-9-]{16,80}", client_request_id)):
            raise ValueError("消息客户端标识无效")
        self._adopt_record(thread_id)
        entry = self._record(thread_id)
        prior = (entry.get('submissions') or {}).get(str(submission_id))
        work_mode = submission_work_mode(work_mode, entry.get('composerMode', 'normal'),
                                         prior, steer=mode == 'steer')
        chat = self.session(thread_id)
        with chat.actions:
            chat.refresh_shared_state()
            if mode == 'auto':
                view = chat.view()
                mode = prior.get('mode') if prior else ('queue' if view['status'] == 'active' or view.get('requests') else 'send')
            if mode == 'queue' and work_mode != 'default' and not prior:
                view = chat.view()
                if view['status'] != 'active' and not view.get('requests'):
                    mode = 'send'
            result = chat.send(text, submission_id, attachments, mode=mode,
                work_mode=work_mode, skills=skills,
                catalog_reader=self.catalog_reader, client_request_id=client_request_id, _text_limit=_text_limit)
            if work_mode == 'goal' and result.get('status') == 'accepted':
                with self.registry_lock:
                    entry = self.records['threads'][thread_id]
                    row = chat.submissions.get(str(submission_id), {})
                    if (entry.get('composerMode') == 'goal'
                            and row.get('composerModeRevision') == entry.get('composerModeRevision', 0)):
                        # Consume only the accepted input mode. The native goal remains.
                        entry['composerMode'] = 'normal'
                        entry['composerModeRevision'] = entry.get('composerModeRevision', 0) + 1
                        entry['composerRevision'] = entry.get('composerRevision', 0) + 1
                        self.save()
            result['composerState'] = chat.composer_state()
            if result.get('nativeQueueConfirmed'):
                result['queuedSubmissions'] = merge_native_queue(pending_submissions(chat.submissions),
                    self._native_queue_items(thread_id), chat.submissions)
            return result

    def interrupt(self, thread_id):
        self._adopt_record(thread_id)
        return self.session(thread_id).stop()

    def respond(self, thread_id, request_id, response):
        self._adopt_record(thread_id)
        chat = self.session(thread_id)
        if not isinstance(chat, Chat):
            return chat.respond(request_id, response)
        with chat.actions:
            submission_id = async_submission_id(thread_id, request_id)
            with chat.condition:
                pending = next((row for row in async_requests(chat.state) if row['id'] == request_id), None)
                prior = copy.deepcopy(chat.submissions.get(submission_id))
                active = chat.state.get('threadRuntimeStatus', {}).get('type') == 'active'
            if prior:
                questions = ((pending or {}).get('params') or {}).get('questions') or prior_async_questions(prior)
                text = async_reply_text(questions, response)
                if prior.get('status') == 'failed':
                    if not pending:
                        raise ValueError('该问题已结束，请刷新会话查看最新内容')
                    # An explicit retry is safe only after a confirmed rejection.
                    # Keep the same native message ID; uncertain deliveries below
                    # remain receipts and must never be dispatched a second time.
                    chat.refresh_shared_state()
                    with chat.condition:
                        mode = 'steer' if chat.state.get('threadRuntimeStatus', {}).get('type') == 'active' else 'send'
                        work_mode = None if mode == 'steer' else 'default'
                        row = chat.submissions[submission_id]
                        row.update(text=text, mode=mode, workMode=work_mode, status='queued',
                                   digest=hashlib.sha256(json.dumps([text, [], mode, work_mode, []], ensure_ascii=False).encode()).hexdigest())
                        row.pop('error', None)
                        row.pop('turnId', None)
                    try:
                        result = chat._dispatch(submission_id, row)
                    except Exception as error:
                        with chat.condition:
                            if row['status'] == 'queued':
                                row.update(status='failed', error=str(error))
                        chat.persist()
                        raise
                    return {**result, 'composerState': chat.composer_state()}
                if prior.get('text') != text:
                    raise ValueError('此问题已提交不同答案，请查看会话结果')
                return {'id': submission_id, 'status': prior.get('status', 'unknown'),
                        'composerState': chat.composer_state()}
            if pending:
                text = async_reply_text(pending['params'].get('questions', []), response)
                return self.send(thread_id, text, submission_id,
                                 'steer' if active else 'send', skills=[], work_mode='default', _text_limit=100000)
            return chat.respond(request_id, response)

    def submission_receipt(self, thread_id, submission_id):
        uuid.UUID(str(thread_id)); uuid.UUID(str(submission_id))
        # No session() call: checking delivery never resumes a model or thread.
        entry = self._record(thread_id)
        chat = self.live.get(thread_id)
        if chat:
            with chat.lock:
                live = chat.submissions.get(submission_id)
                # A live submission also owns Catalog/service locks. A receipt
                # needs only immutable status fields, never a copy of services.
                row = {key: live[key] for key in ('status', 'error', 'nativeQueueConfirmed', 'nativeQueueId', 'nativeQueueStage') if key in live} if live else None
        else:
            row = entry.get('submissions', {}).get(submission_id)
        confirmed = False
        history = self.web_history if entry.get('runtime') == 'web' else self.history
        check = getattr(history, 'confirmed_user_receipt', None)
        if row and row.get('status') in ('accepted', 'unknown') and callable(check):
            try:
                confirmed = check(thread_id, submission_id)
            except (KeyError, OSError):
                pass  # Not saved/discoverable yet: keep admission and original contents.
        return {'id': submission_id, 'status': row.get('status', 'unknown') if row else 'unknown',
                'deliveryConfirmed': confirmed,
                'nativeQueueConfirmed': bool(row and row.get('nativeQueueConfirmed')),
                'nativeQueueRejected': bool(row and row.get('nativeQueueStage') == 'rejected'),
                **({'nativeQueueId': row['nativeQueueId']} if row and row.get('nativeQueueId') else {}),
                **({'error': row['error']} if row and row.get('error') else {})}

    def cancel_queued(self, thread_id, submission_id):
        self._adopt_record(thread_id)
        chat = self.session(thread_id)
        with chat.actions:
            row = chat.submissions.get(submission_id)
            if row and row.get('queueOwner') == 'native':
                from bridge.clients.codex.native_queue import operate as native_operate
                native = self._native_queue(thread_id)
                result = native_operate(chat, {'type': 'delete_queued_message', 'token': row.get('nativeQueueId')},
                                        native, native.read(thread_id, fresh=True))
            else:
                result = chat.cancel_queued(submission_id)
            chat.persist()
            return result

    def queue_actions(self, thread_id, command):
        from bridge.clients.codex.standalone_queue import operate
        self._adopt_record(thread_id)
        chat = self.session(thread_id)
        with chat.actions:
            result = operate(chat, command)
            result['queuedSubmissions'] = merge_native_queue(pending_submissions(chat.submissions),
                self._native_queue_items(thread_id), chat.submissions)
            return result

    def ignore_submission(self, thread_id, submission_id):
        self._adopt_record(thread_id)
        chat = self.session(thread_id)
        with chat.actions, chat.condition:
            row = chat.submissions.get(submission_id)
            if not row or row['status'] != 'unknown':
                raise ValueError('这条消息不是待确认记录，请刷新状态')
            row['status'] = 'ignored'
            chat.persist()
            chat.changed()
        return {'ok': True}

    def full_history(self, thread_id):
        if self.history and thread_id not in self.records['threads']:
            return self._with_title_override(thread_id, self.history.session(thread_id, full=True).view())
        return self.view(thread_id)

    def settings(self, thread_id, model, effort, *, fast_mode=None):
        self._adopt_record(thread_id)
        if fast_mode is not None:
            raise ValueError('此独立入口暂未启用快速服务档位')
        chat = self.session(thread_id)
        result = chat.settings(model, effort, self.catalog(thread_id, kind='models'))
        with self.registry_lock:
            entry = self.records['threads'].get(thread_id)
            if entry is not None:
                entry['model'] = model
                entry['effort'] = effort
                self.save()
        return result

    def rename(self, thread_id, title):
        entry = self._scoped_record(thread_id)
        return execute_rename(self, thread_id, title, entry)

    def linux_permission_options(self, thread_id):
        if thread_id not in self.records['threads'] and self.history:
            self.history.get(thread_id)
        else:
            self._record(thread_id)
        return {'available': False, 'reason': '此入口沿用该 WSL 会话的原有权限'}

    def permissions(self, thread_id, preset, confirmed=False):
        self._adopt_record(thread_id)
        raise ValueError('此入口沿用 WSL 配置，权限变更请由后台服务管理员处理')

    def message_action(self, thread_id, body):
        action = body.get('action')
        if action == 'delete':
            return self.delete_thread(thread_id)
        entry = self._scoped_record(thread_id)
        if action in ('pin', 'unpin'):
            return execute_pin_action(self, thread_id, action, entry)
        if action in ('archive', 'unarchive'):
            return execute_archive_action(self, thread_id, action, entry)
        if action == 'fork':
            from bridge.clients.codex.fork_helper import execute_fork_action
            return execute_fork_action(self, thread_id, body, entry)
        raise ValueError('独立入口暂不支持改写已有轮次；请新建聊天')

    def delete_thread(self, thread_id):
        """Only the native owner deletes history; never unlink a rollout here."""
        with self.lock:
            chat = self.live.get(thread_id)
        # Sending/queue operations take actions before the bridge lock. Do not
        # hold the bridge lock while waiting for an in-flight sender to finish.
        with (chat.actions if chat else nullcontext()), self.lock:
            if self.live.get(thread_id) is not chat:
                raise ValueError('会话状态已变化，请刷新后再删除')
            entry = self._scoped_record(thread_id)
            submissions = chat.submissions if chat else entry.get('submissions', {})
            if any(row.get('status') in ('queued', 'unknown') for row in submissions.values()):
                raise ValueError('会话还有待发送或待确认的消息，请处理队列后再删除')
            if chat and (chat.state.get('requests') or async_requests(chat.state)):
                raise ValueError('会话正在等待回复，请处理当前问题后再删除')
            backend = self._history_backend() if entry.get('runtime') == 'history' else self.runtime
            if entry.get('runtime') != 'history':
                backend.start()
            try:
                # Resume metadata only: unloaded history has no reliable status
                # from thread/read. This never starts a model turn.
                native_store = self.history if entry.get('runtime') == 'history' else self.web_history
                try:
                    archived = bool(native_store.get(thread_id).get('archived'))
                except KeyError:
                    archived = False  # Exact native no-rollout confirmation below remains mandatory.
                if not archived:
                    thread = backend.request('thread/resume', {'threadId': thread_id, 'excludeTurns': True})['thread']
                    if Path(thread.get('cwd', '')).resolve() != Path(entry['cwd']).resolve():
                        raise PermissionError('原生会话目录与已授权目录不一致')
                    if thread.get('status', {}).get('type') != 'idle':
                        raise ValueError('会话正在执行任务或等待回复，请结束当前任务后再删除')
                    queued = backend.request('thread/queue/list', {'threadId': thread_id}, timeout=5)
                    if not isinstance(queued.get('data'), list):
                        raise ValueError('无法核对待发送消息，尚未删除会话，请稍后重试')
                    if queued['data'] or queued.get('nextCursor') is not None:
                        raise ValueError('会话还有待发送消息，请处理队列后再删除')
                # Native archive unloads execution; resume/queue APIs reject it.
                # Local uncertain submissions were rejected above. Let the same
                # native owner perform its archived-thread deletion atomically,
                # without unarchiving/waking it or touching rollout files.
                backend.request('thread/delete', {'threadId': thread_id}, timeout=15)
            except Exception as error:
                if goal_rpc_unsupported(error):
                    raise ValueError('当前 Codex CLI 不支持安全删除，请升级 CLI 后再试；会话已保留') from error
                # A lost delete receipt may leave only a registry row. Reconcile
                # only an exact native "no rollout" plus fresh store absence.
                rpc = getattr(error, 'rpc_error', {}) or {}
                history = self.history if entry.get('runtime') == 'history' else self.web_history
                absent = False
                if rpc.get('code') == -32600 and str(rpc.get('message', '')).endswith('no rollout found for thread id ' + thread_id) and history:
                    try:
                        history.get(thread_id)
                    except KeyError:
                        absent = True
                if not absent:
                    if isinstance(error, SideChatError) or not isinstance(error, ValueError):
                        raise ValueError('执行端未确认删除结果，请刷新会话列表后重试；不会自动重复删除') from error
                    raise
            with self.registry_lock:
                before = copy.deepcopy(self.records)
                self.records['threads'].pop(thread_id, None)
                self.records['titleOverrides'].pop(thread_id, None)
                for creation in self.records['creations'].values():
                    if creation.get('id') == thread_id:
                        creation['deleted'] = True
                try:
                    self.save()
                except Exception:
                    self.records = before
                    raise
            if chat:
                with chat.condition:
                    chat.closed = True
                    chat.queue_event.set()
                    chat.condition.notify_all()
                self.live.pop(thread_id, None)
            for history in (self.history, self.web_history):
                if history:
                    with history.lock:
                        history.sessions.pop(thread_id, None)
            return {'ok': True}

    def subagents(self, thread_id, agent_id=None):
        from bridge.clients.codex.subagent_views import subagents
        return subagents(self, thread_id, agent_id)

    def side_chat(self, thread_id, owner, action, body):
        self._adopt_record(thread_id)
        raise ValueError('此入口使用持久化主聊天；请新建聊天进行独立讨论')

    def close(self):
        self.closed.set()
        for chat in list(self.live.values()):
            with chat.condition:
                chat.persist()
                chat.closed = True
                chat.queue_event.set()
                chat.condition.notify_all()
        self.runtime.close()
        if self.history_runtime:
            self.history_runtime.close()
        self.terminals.close()
