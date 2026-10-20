"""Native-owned deletion: no models, user files or real daemon connections."""
import copy
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import StandaloneBridge
from bridge.features.sessions.side_chat import SideChatError

ID = '01901234-5678-7000-8000-000000000001'


class DeleteTests(unittest.TestCase):
    def fixture(self, root):
        class Backend:
            def __init__(self):
                self.calls, self.status, self.queue, self.failure = [], 'idle', [], None

            def start(self):
                pass

            def request(self, method, params, timeout=30):
                self.calls.append((method, params))
                if method == 'thread/resume':
                    return {'thread': {'id': ID, 'status': {'type': self.status}}}
                if method == 'thread/queue/list':
                    return {'data': self.queue, 'nextCursor': None}
                if self.failure:
                    raise self.failure
                return {}

        backend = Backend()
        bridge = StandaloneBridge.__new__(StandaloneBridge)
        bridge.lock, bridge.registry_lock = threading.RLock(), threading.RLock()
        bridge.records = {'threads': {ID: {'cwd': root, 'runtime': 'web'}},
                          'titleOverrides': {ID: '名称'}, 'creations': {'r': {'id': ID, 'title': '名称'}}}
        bridge.workspaces = [{'path': Path(root)}]
        bridge.runtime = backend
        history = SimpleNamespace(lock=threading.RLock(), sessions={ID: object()})
        bridge.history, bridge.web_history = None, history
        bridge.live = {}
        bridge.saved = []
        bridge.save = lambda: bridge.saved.append(copy.deepcopy(bridge.records))
        return bridge, backend

    def test_native_ack_removes_only_exact_registry_cache_and_idempotent_creation(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            b.records['threads']['other'] = {'cwd': root}
            chat = SimpleNamespace(actions=threading.RLock(), condition=threading.Condition(),
                                   queue_event=threading.Event(), closed=False, submissions={}, state={})
            b.live[ID] = chat
            self.assertEqual(b.message_action(ID, {'action': 'delete'}), {'ok': True})
            self.assertEqual([m for m, _ in backend.calls], ['thread/resume', 'thread/queue/list', 'thread/delete'])
            self.assertEqual(backend.calls[-1][1], {'threadId': ID})
            self.assertEqual(set(b.records['threads']), {'other'})
            self.assertNotIn(ID, b.records['titleOverrides'])
            self.assertTrue(b.records['creations']['r']['deleted'])
            self.assertTrue(chat.closed)
            self.assertNotIn(ID, b.live)
            self.assertNotIn(ID, b.web_history.sessions)

    def test_active_or_waiting_thread_never_reaches_delete(self):
        with tempfile.TemporaryDirectory() as root:
            for status in ('active', 'notLoaded', 'unknown'):
                b, backend = self.fixture(root)
                backend.status = status
                with self.assertRaisesRegex(ValueError, '结束当前任务'):
                    b.delete_thread(ID)
                self.assertEqual(len(backend.calls), 1)
                self.assertIn(ID, b.records['threads'])

    def test_local_uncertain_or_queued_message_blocks_before_native_rpc(self):
        with tempfile.TemporaryDirectory() as root:
            for status in ('unknown', 'queued'):
                b, backend = self.fixture(root)
                b.records['threads'][ID]['submissions'] = {'s': {'status': status}}
                with self.assertRaisesRegex(ValueError, '处理队列'):
                    b.delete_thread(ID)
                self.assertEqual(backend.calls, [])

    def test_native_queue_blocks_deletion_without_consuming_message(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            backend.queue = [{'id': 'native-message'}]
            with self.assertRaisesRegex(ValueError, '处理队列'):
                b.delete_thread(ID)
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])

    def test_pending_question_blocks_before_native_rpc(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            b.live[ID] = SimpleNamespace(actions=threading.RLock(), submissions={}, state={'requests': [{'id': 1}]})
            with self.assertRaisesRegex(ValueError, '处理当前问题'):
                b.delete_thread(ID)
            self.assertEqual(backend.calls, [])

    def test_history_delete_uses_configured_shared_owner_without_adopting_or_stopping_it(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            b.records['threads'].pop(ID)
            b.history = b.web_history
            b._scoped_record = lambda _: {'runtime': 'history', 'cwd': root}
            b._history_backend = lambda: backend
            b.runtime = SimpleNamespace(start=lambda: self.fail('unrelated owner started'))
            b._adopt_record = lambda _: self.fail('history must not be adopted for deletion')
            self.assertEqual(b.message_action(ID, {'action': 'delete'}), {'ok': True})
            self.assertEqual(backend.calls[-1], ('thread/delete', {'threadId': ID}))

    def test_native_unknown_receipt_and_unsupported_keep_all_records_without_retry(self):
        with tempfile.TemporaryDirectory() as root:
            for error in (TimeoutError('lost receipt'), SideChatError('unsupported')):
                if isinstance(error, SideChatError):
                    error.rpc_error = {'code': -32601, 'message': 'method not found'}
                b, backend = self.fixture(root)
                backend.failure = error
                before = copy.deepcopy(b.records)
                with self.assertRaises(ValueError):
                    b.delete_thread(ID)
                self.assertEqual(b.records, before)
                self.assertEqual(len([m for m, _ in backend.calls if m == 'thread/delete']), 1)

    def test_scope_denial_and_invalid_id_never_touch_native_owner(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            b.workspaces = [{'path': Path(root) / 'unrelated'}]
            with self.assertRaises(PermissionError):
                b.delete_thread(ID)
            with self.assertRaises(ValueError):
                b.delete_thread('../other')
            self.assertEqual(backend.calls, [])

    def test_disk_save_failure_retains_registry_for_explicit_reconciliation(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            before = copy.deepcopy(b.records)
            b.save = lambda: (_ for _ in ()).throw(OSError('disk full'))
            with self.assertRaises(OSError):
                b.delete_thread(ID)
            self.assertEqual(b.records, before)
            self.assertEqual(backend.calls[-1][0], 'thread/delete')

    def test_lost_receipt_reconciliation_requires_native_missing_and_fresh_store_missing(self):
        with tempfile.TemporaryDirectory() as root:
            for missing in (True, False):
                b, backend = self.fixture(root)
                error = SideChatError('missing')
                error.rpc_error = {'code': -32600, 'message': 'no rollout found for thread id ' + ID}
                backend.failure = error
                def get(_):
                    if missing:
                        raise KeyError(ID)
                    return {'id': ID}
                b.web_history.get = get
                if missing:
                    self.assertEqual(b.delete_thread(ID), {'ok': True})
                else:
                    with self.assertRaisesRegex(ValueError, '未确认删除'):
                        b.delete_thread(ID)
                    self.assertIn(ID, b.records['threads'])


if __name__ == '__main__':
    unittest.main()
