"""Active-writer and read-only-history contracts; no Codex process is started."""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge.clients.codex.errors import ActiveWriterConflict
from bridge.clients.codex.standalone import Runtime, StandaloneBridge
from bridge.features.sessions.side_chat import SideChat, SideChatError
from bridge.features.sessions.timeline import Timeline


THREAD_ID = '01901234-5678-7000-8000-000000000001'


class ActiveWriterTests(unittest.TestCase):
    def test_native_active_writer_error_becomes_stable_conflict(self):
        runtime = Runtime('/unused', '/unused', '/unused', lambda _event: None)

        class Backend:
            def request(self, _method, _params, _timeout):
                error = SideChatError('Codex rejected resume')
                error.rpc_error = {'code': -32600,
                                   'message': f'thread {THREAD_ID} already has an active writer'}
                raise error

        runtime._runtime = Backend()
        with self.assertRaises(ActiveWriterConflict) as caught:
            runtime.request('thread/resume', {'threadId': THREAD_ID})
        self.assertEqual(caught.exception.code, 'codex_active_writer')
        self.assertEqual(caught.exception.kind, 'active_writer')
        self.assertFalse(caught.exception.dispatched)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.payload()['kind'], 'active_writer')
        self.assertFalse(caught.exception.payload()['dispatched'])
        self.assertIn('待发送内容会保留', str(caught.exception))

    def test_rejected_turn_is_failed_with_attachment_reference_retained(self):
        chat = SideChat.__new__(SideChat)
        chat.id = THREAD_ID
        chat.lock = threading.RLock()
        chat.turn_permissions = {}
        chat.uploads = None
        chat.state = {'latestModel': 'model', 'cwd': '/project', 'turns': [], 'requests': [],
                      'threadRuntimeStatus': {'type': 'idle'}}

        class Runtime:
            def request(self, _method, _params):
                raise ActiveWriterConflict()

        chat.runtime = Runtime()
        row = {'attachmentIds': ['01901234-5678-7000-8000-000000000002'],
               'text': '请看附件', 'mode': 'send', 'workMode': 'default',
               'skills': [], 'catalog': None, 'status': 'queued'}
        with self.assertRaises(ActiveWriterConflict):
            SideChat._dispatch(chat, 'submission', row)
        self.assertEqual(row['status'], 'failed')
        self.assertEqual(row['attachmentIds'], ['01901234-5678-7000-8000-000000000002'])

    def test_upload_and_workspace_entrypoints_check_scope_without_adopting(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)

            class UploadStore:
                put = lambda self, *_args: 'put'
                set_thumb = lambda self, *_args: 'thumb'
                preview = lambda self, *_args: 'preview'

            class SessionStore:
                def get(self, _identifier):
                    return {'cwd': str(root)}

            class BridgeStub:
                host = 'local'
                uploads = UploadStore()
                store = SessionStore()

                def _scoped_record(self, _identifier):
                    return {'cwd': str(root)}

                def _adopt_record(self, _identifier):
                    raise AssertionError('file operations must not adopt/resume a thread')

            bridge = BridgeStub()
            self.assertEqual(StandaloneBridge.upload(bridge, THREAD_ID, 'id', 'a.txt', b'a'), 'put')
            self.assertEqual(StandaloneBridge.upload_thumb(bridge, THREAD_ID, 'id', b'x', 1, 1), 'thumb')
            self.assertEqual(StandaloneBridge.upload_preview(bridge, THREAD_ID, 'id'), 'preview')
            self.assertIsInstance(StandaloneBridge.workspace(bridge, THREAD_ID, 'list', {}), dict)

    def test_read_only_session_lookup_uses_history_instead_of_resuming(self):
        class History:
            def __init__(self):
                self.full = None
                self.value = object()

            def session(self, _identifier, full=False):
                self.full = full
                return self.value

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            bridge = StandaloneBridge.__new__(StandaloneBridge)
            bridge.history_socket = None
            bridge.records = {'threads': {THREAD_ID: {'cwd': str(root), 'runtime': 'history'}}}
            bridge.registry_lock = threading.RLock()
            bridge.lock = threading.RLock()
            bridge.workspaces = [{'path': root}]
            bridge.live = {}
            bridge.history = History()
            bridge._history_backend = lambda: (_ for _ in ()).throw(
                AssertionError('read-only lookup must not start a runtime'))
            result = StandaloneBridge.session(bridge, THREAD_ID, attach=False)
            self.assertIs(result, bridge.history.value)
            self.assertFalse(bridge.history.full)  # Cold observation reads a bounded saved tail.
            bridge.history = None
            with self.assertRaises(KeyError):
                StandaloneBridge.session(bridge, THREAD_ID, attach=False)

    def test_offline_web_session_reads_its_own_codex_home_without_resuming(self):
        class History:
            def __init__(self):
                self.full = None
                self.value = object()

            def session(self, _identifier, full=False):
                self.full = full
                return self.value

        class ExternalHistory:
            def session(self, *_args, **_kwargs):
                raise AssertionError('web history must not read history_home')

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            bridge = StandaloneBridge.__new__(StandaloneBridge)
            bridge.history_socket = None
            bridge.records = {'threads': {THREAD_ID: {'cwd': str(root), 'runtime': 'web'}}}
            bridge.registry_lock = threading.RLock()
            bridge.lock = threading.RLock()
            bridge.workspaces = [{'path': root}]
            bridge.live = {}
            bridge.web_history = History()
            bridge.history = ExternalHistory()
            bridge.runtime = type('Runtime', (), {
                'start': lambda *_args: (_ for _ in ()).throw(
                    AssertionError('read-only lookup must not start a runtime'))})()
            result = StandaloneBridge.session(bridge, THREAD_ID, attach=False)
            self.assertIs(result, bridge.web_history.value)
            self.assertFalse(bridge.web_history.full)  # Never parse the entire web rollout on open.

    def test_timeline_ignores_legacy_web_title_override(self):
        class Chat:
            def __init__(self):
                self.condition = threading.Condition()
                self.timeline = Timeline()
                self.sequence = 1
                self.submissions = {}

            def view(self, **_options):
                return {'id': THREAD_ID, 'title': '原始标题', 'sequence': 1,
                        'turns': [], 'goalActivationIds': []}

        bridge = StandaloneBridge.__new__(StandaloneBridge)
        bridge.history_socket = None
        bridge.records = {'threads': {}, 'titleOverrides': {THREAD_ID: '网页覆盖标题'}}
        bridge.history = None
        bridge.registry_lock = threading.RLock()
        chat = Chat()
        bridge.session = lambda _identifier, attach=True: chat
        bridge._annotate_upload_attachments = lambda _chat, _rows: None
        bridge._native_queue_items = lambda _: []
        chat.timeline.update(chat.view())
        result = StandaloneBridge.timeline_read(bridge, THREAD_ID)
        self.assertEqual(result['meta']['title'], '原始标题')

    def test_offline_rename_writes_native_name_without_adoption(self):
        calls = []
        meta = {'id': THREAD_ID, 'name': '原始标题', 'cwd': '/tmp'}

        class HistorySession:
            def __init__(self):
                self.condition = threading.Condition()

            def view(self, **_options):
                return {'id': THREAD_ID, 'title': meta.get('name')}

        class History:
            def workspace(self, _cwd):
                return {'name':'test', 'key':'test'}
            def rollout_path(self, _meta):
                return None
            def get(self, _identifier):
                return meta

            def session(self, _identifier, full=False):
                return HistorySession()

        class Backend:
            def request(self, method, params, timeout=30):
                calls.append((method, params))
                if method == 'thread/name/set':
                    meta['name'] = params['name']
                return {}

        with tempfile.TemporaryDirectory() as folder:
            bridge = StandaloneBridge.__new__(StandaloneBridge)
            bridge.history_socket = None
            bridge.path = Path(folder) / 'web-threads.json'
            bridge.records = {'threads': {}, 'creations': {}, 'titleOverrides': {}}
            bridge.registry_lock = threading.RLock()
            bridge.lock = threading.RLock()
            bridge.history = History()
            bridge.live = {}
            bridge.view = lambda _id: {'id': THREAD_ID, 'title': meta.get('name')}
            bridge.save = lambda: bridge.path.write_text(json.dumps(bridge.records), encoding='utf-8')
            bridge._native_queue_items = lambda _: []
            bridge._scoped_record = lambda _identifier: {'runtime': 'history', 'cwd':'/tmp'}
            bridge._history_backend = lambda: Backend()
            result = StandaloneBridge.rename(bridge, THREAD_ID, '  网页标题  ')
            self.assertEqual(result['title'], '网页标题')
            self.assertIn(('thread/name/set', {'threadId': THREAD_ID, 'name': '网页标题'}), calls)
            self.assertNotIn(THREAD_ID, bridge.records['titleOverrides'])
            self.assertEqual(bridge.records['threads'], {})

    def test_session_paths_are_exposed_only_inside_codex_history_roots(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder) / '.codex'
            history_home = Path(folder) / 'desktop-codex'
            inside = home / 'sessions' / 'rollout.jsonl'
            desktop = history_home / 'sessions' / 'desktop-rollout.jsonl'
            outside = Path(folder) / 'outside.jsonl'
            inside.parent.mkdir(parents=True)
            desktop.parent.mkdir(parents=True)
            inside.write_text('{}\n', encoding='utf-8')
            desktop.write_text('{}\n', encoding='utf-8')
            outside.write_text('{}\n', encoding='utf-8')
            bridge = StandaloneBridge.__new__(StandaloneBridge)
            bridge.history_socket = None
            bridge.codex_home = home
            bridge.history_home = history_home
            bridge.store = type('Store', (), {'home': home})()
            bridge.web_history = None
            bridge.history = None
            self.assertEqual(StandaloneBridge._validated_rollout_path(bridge, str(inside)), str(inside))
            self.assertIsNone(StandaloneBridge._validated_rollout_path(bridge, str(outside)))
            self.assertEqual(StandaloneBridge._thread_path(
                bridge, THREAD_ID, {'runtime': 'web', 'path': str(inside)}), str(inside))
            self.assertIsNone(StandaloneBridge._thread_path(
                bridge, THREAD_ID, {'runtime': 'web', 'path': str(desktop)}))


if __name__ == '__main__':
    unittest.main()
