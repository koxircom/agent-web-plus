import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.app.service import LiveSession
from bridge.clients.codex.windows_desktop import NativeRejected, NativeUnknown, WindowsDesktopBridge
from bridge.features.sessions.create import CreationError
from bridge.features.sessions.create import CreationUnavailable, delete_thread_metadata


class WindowsDeleteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.executable = self.root / 'codex.exe'
        self.executable.touch()
        self.thread = str(uuid.uuid4())
        self.bridge = WindowsDesktopBridge(self.root, self.root / 'bridge',
            [{'key': 'test', 'name': 'test', 'path': str(self.root)}], creation_executable=str(self.executable))
        self.bridge.store = Mock()
        self.bridge.store.get.return_value = {'id': self.thread, 'cwd': str(self.root)}
        self.session = LiveSession(self.thread)
        self.session.state = {'threadRuntimeStatus': {'type': 'idle'}, 'turns': []}
        self.session.connected = True
        self.session.revision = 1
        self.bridge.live[self.thread] = self.session
        self.bridge.ipc = Mock()

    def tearDown(self):
        self.bridge.close()
        self.tmp.cleanup()

    @patch('bridge.clients.codex.windows_desktop.delete_thread_metadata', create=True)
    def test_delete_uses_native_metadata_and_confirms_actual_absence(self, native):
        native.side_effect = lambda *a, **kw: setattr(self.bridge.store.get, 'side_effect', KeyError('gone'))
        self.assertEqual(self.bridge.message_action(self.thread, {'action': 'delete'}), {'ok': True})
        native.assert_called_once()
        self.assertEqual(native.call_args.args[:3], (str(self.executable), self.root, str(self.root)))
        self.assertEqual(native.call_args.args[3], self.thread)
        self.assertNotIn(self.thread, self.bridge.live)
        self.bridge.ipc.request.assert_not_called()

    @patch('bridge.clients.codex.windows_desktop.delete_thread_metadata', create=True)
    def test_busy_and_unconfirmed_inputs_preserve_session(self, native):
        self.session.state['threadRuntimeStatus']['type'] = 'active'
        with self.assertRaisesRegex(NativeRejected, '结束当前任务'):
            self.bridge.message_action(self.thread, {'action': 'delete'})
        self.session.state['threadRuntimeStatus']['type'] = 'idle'
        self.bridge.submissions[self.thread + ':pending'] = {'status': 'unknown'}
        with self.assertRaisesRegex(NativeRejected, '待确认'):
            self.bridge.message_action(self.thread, {'action': 'delete'})
        native.assert_not_called()
        self.assertIn(self.thread, self.bridge.live)

    @patch('bridge.clients.codex.windows_desktop.delete_thread_metadata', create=True)
    def test_unconfirmed_delete_never_claims_success_or_retries(self, native):
        native.side_effect = CreationError('receipt lost')
        with self.assertRaises(NativeUnknown):
            self.bridge.message_action(self.thread, {'action': 'delete'})
        native.assert_called_once()
        self.assertIn(self.thread, self.bridge.live)

    @patch('bridge.clients.codex.windows_desktop.delete_thread_metadata', create=True)
    def test_cold_compressed_history_deletes_without_decoding_saved_messages(self, native):
        self.bridge.live.pop(self.thread)
        self.bridge.store.history.side_effect = ValueError('读取压缩历史需要系统 Zstandard 库')
        native.side_effect = lambda *a, **kw: setattr(self.bridge.store.get, 'side_effect', KeyError('gone'))
        self.assertEqual(self.bridge.message_action(self.thread, {'action': 'delete'}), {'ok': True})
        self.bridge.store.history.assert_not_called()
        native.assert_called_once()
        self.bridge.ipc.request.assert_not_called()


class NativeDeleteMetadataTests(unittest.TestCase):
    def test_exact_thread_and_empty_queue_are_required_before_single_delete(self):
        with tempfile.TemporaryDirectory() as root:
            thread = str(uuid.uuid4())
            calls = []
            def request(method, params):
                calls.append((method, params))
                return {'thread': {'id': thread, 'cwd': root, 'status': {'type': 'notLoaded'}}} if method == 'thread/read' else {'data': [], 'nextCursor': None}
            with patch('bridge.features.sessions.create._runtime_operation', side_effect=lambda exe, home, cwd, op, **kw: op(request)):
                delete_thread_metadata('fixture', root, root, thread)
            self.assertEqual([m for m, _ in calls], ['thread/read', 'thread/queue/list', 'thread/delete'])
            self.assertEqual(calls[-1][1], {'threadId': thread})

    def test_active_wrong_scope_and_pending_queue_never_delete(self):
        with tempfile.TemporaryDirectory() as root:
            thread = str(uuid.uuid4())
            for case in ('active', 'identity', 'cwd', 'queue', 'cursor', 'invalid_queue'):
                calls = []
                def request(method, params):
                    calls.append(method)
                    if method == 'thread/read':
                        return {'thread': {'id': 'wrong' if case == 'identity' else thread,
                            'cwd': '/' if case == 'cwd' else root, 'status': {'type': 'active' if case == 'active' else 'notLoaded'}}}
                    return {'data': [{}] if case == 'queue' else None if case == 'invalid_queue' else [],
                            'nextCursor': 'more' if case == 'cursor' else None}
                with self.subTest(case=case), patch('bridge.features.sessions.create._runtime_operation', side_effect=lambda exe, home, cwd, op, **kw: op(request)):
                    with self.assertRaises(CreationUnavailable):
                        delete_thread_metadata('fixture', root, root, thread)
                self.assertNotIn('thread/delete', calls)

if __name__ == '__main__':
    unittest.main()
