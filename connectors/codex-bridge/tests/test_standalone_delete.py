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
    def test_provider_changed_history_delete_reads_metadata_without_resuming(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            error = SideChatError('provider mismatch')
            error.rpc_error = {'code': -32600, 'data': {'type': 'modelProviderMismatch'},
                               'message': 'This chat uses openai, but your current provider is fixture.'}
            def request(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/resume':
                    raise error
                if method == 'thread/read':
                    self.assertEqual(params, {'threadId': ID, 'includeTurns': False})
                    return {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'notLoaded'}}}
                if method == 'thread/queue/list':
                    return {'data': [], 'nextCursor': None}
                if method == 'thread/delete':
                    return {}
                self.fail('unexpected RPC: ' + method)
            backend.request = request
            self.assertEqual(b.delete_thread(ID), {'ok': True})
            self.assertEqual([m for m, _ in backend.calls],
                             ['thread/read', 'thread/queue/list', 'thread/delete'])
            self.assertNotIn(ID, b.records['threads'])

    def fixture(self, root):
        class Backend:
            def __init__(self):
                self.calls, self.status, self.queue, self.failure = [], 'idle', [], None

            def start(self):
                pass

            def request(self, method, params, timeout=30):
                self.calls.append((method, params))
                if method == 'thread/read':
                    return {'thread': {'id': ID, 'cwd':root, 'status': {'type': self.status}}}
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
        history = SimpleNamespace(lock=threading.RLock(), sessions={ID: object()}, get=lambda _: {'cwd':root,'archived':False})
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
            self.assertEqual([m for m, _ in backend.calls], ['thread/read', 'thread/queue/list', 'thread/delete'])
            self.assertEqual(backend.calls[-1][1], {'threadId': ID})
            self.assertEqual(set(b.records['threads']), {'other'})
            self.assertNotIn(ID, b.records['titleOverrides'])
            self.assertTrue(b.records['creations']['r']['deleted'])
            self.assertTrue(chat.closed)
            self.assertNotIn(ID, b.live)
            self.assertNotIn(ID, b.web_history.sessions)

    def test_archived_thread_deletes_through_native_owner_without_waking_it(self):
        with tempfile.TemporaryDirectory() as root:
            b,backend=self.fixture(root)
            b.web_history.get=lambda _: {'cwd':root,'archived':True}
            self.assertEqual(b.delete_thread(ID), {'ok':True})
            self.assertEqual([m for m,_ in backend.calls], ['thread/delete'])
            b,backend=self.fixture(root)
            b.web_history.get=lambda _: {'cwd':root,'archived':True}
            b.records['threads'][ID]['submissions']={'queued':{'status':'unknown'}}
            with self.assertRaisesRegex(ValueError, '处理队列'): b.delete_thread(ID)
            self.assertNotIn('thread/delete',[m for m,_ in backend.calls])

    def test_active_or_waiting_thread_never_reaches_delete(self):
        with tempfile.TemporaryDirectory() as root:
            for status in ('active', 'unknown'):
                b, backend = self.fixture(root)
                backend.status = status
                with self.assertRaisesRegex(ValueError, '结束当前任务'):
                    b.delete_thread(ID)
                self.assertEqual(len(backend.calls), 1)
                self.assertIn(ID, b.records['threads'])

    def test_dismissed_async_question_does_not_block_idle_native_delete(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            qid = '["request_user_input_async","question",0]'
            request = 'async:turn:question'
            state = {'turns': [{'id': 'turn', 'turnId': 'turn', 'status': 'completed', 'items': [
                {'id': 'question', 'type': 'agentMessage', 'questions': [{'title': '问题', 'options': []}]}
            ]}]}
            chat = SimpleNamespace(actions=threading.RLock(), condition=threading.Condition(),
                                   queue_event=threading.Event(), closed=False, submissions={}, state=state,
                                   dismissed_async_questions={})
            b.live[ID] = chat
            with self.assertRaisesRegex(ValueError, '等待回复'):
                b.delete_thread(ID)
            self.assertFalse(backend.calls)
            chat.dismissed_async_questions[request] = [qid]
            self.assertEqual(b.delete_thread(ID), {'ok': True})
            self.assertEqual([method for method, _ in backend.calls], ['thread/read', 'thread/queue/list', 'thread/delete'])

    def test_system_error_with_terminal_turns_deletes_safely(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            backend.status = 'systemError'
            def custom_request(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    include_turns = params.get('includeTurns', False)
                    res = {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'systemError'}}}
                    if include_turns:
                        res['thread']['turns'] = [
                            {'id': 't1', 'status': 'completed'},
                            {'id': 't2', 'status': 'failed'}
                        ]
                    return res
                if method == 'thread/queue/list':
                    return {'data': [], 'nextCursor': None}
                if method == 'thread/delete':
                    return {}
                self.fail('unexpected RPC: ' + method)
            backend.request = custom_request
            self.assertEqual(b.delete_thread(ID), {'ok': True})
            self.assertEqual([m for m, _ in backend.calls],
                             ['thread/read', 'thread/read', 'thread/queue/list', 'thread/delete'])
            self.assertEqual(backend.calls[0][1], {'threadId': ID, 'includeTurns': False})
            self.assertEqual(backend.calls[1][1], {'threadId': ID, 'includeTurns': True})
            self.assertEqual(backend.calls[3][1], {'threadId': ID})
            self.assertNotIn(ID, b.records['threads'])

    def test_system_error_in_progress_turn_blocks_delete(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            backend.status = 'systemError'
            def custom_request(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    include_turns = params.get('includeTurns', False)
                    res = {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'systemError'}}}
                    if include_turns:
                        res['thread']['turns'] = [
                            {'id': 't1', 'status': 'completed'},
                            {'id': 't2', 'status': 'inProgress'}
                        ]
                    return res
                return {}
            backend.request = custom_request
            with self.assertRaisesRegex(ValueError, '执行任务|结束当前任务'):
                b.delete_thread(ID)
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])
            self.assertIn(ID, b.records['threads'])

    def test_system_error_unknown_or_malformed_turns_blocks_delete(self):
        with tempfile.TemporaryDirectory() as root:
            # 1. 包含未知 turn 状态
            b, backend = self.fixture(root)
            backend.status = 'systemError'
            def request_unknown_turn(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    return {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'systemError'},
                                      'turns': [{'id': 't1', 'status': 'unknown_status'}]}}
                return {}
            backend.request = request_unknown_turn
            with self.assertRaisesRegex(ValueError, '尚未确认安全终止状态'):
                b.delete_thread(ID)
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])

            # 2. turns 为空
            b2, backend2 = self.fixture(root)
            backend2.status = 'systemError'
            def request_empty_turns(method, params, timeout=30):
                backend2.calls.append((method, params))
                if method == 'thread/read':
                    return {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'systemError'}, 'turns': []}}
                return {}
            backend2.request = request_empty_turns
            with self.assertRaisesRegex(ValueError, '轮次为空或异常|尚未确认安全终止状态'):
                b2.delete_thread(ID)
            self.assertNotIn('thread/delete', [m for m, _ in backend2.calls])

            # 3. turns 格式异常（非 list）
            b3, backend3 = self.fixture(root)
            backend3.status = 'systemError'
            def request_malformed_turns(method, params, timeout=30):
                backend3.calls.append((method, params))
                if method == 'thread/read':
                    return {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'systemError'}, 'turns': 'invalid'}}
                return {}
            backend3.request = request_malformed_turns
            with self.assertRaises(ValueError):
                b3.delete_thread(ID)
            self.assertNotIn('thread/delete', [m for m, _ in backend3.calls])

            # 4. 第二轮 read 发生异常
            b4, backend4 = self.fixture(root)
            backend4.status = 'systemError'
            def request_read_failure(method, params, timeout=30):
                backend4.calls.append((method, params))
                if method == 'thread/read' and params.get('includeTurns'):
                    raise SideChatError('read failed')
                return {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'systemError'}}}
            backend4.request = request_read_failure
            with self.assertRaisesRegex(ValueError, '会话预检失败'):
                b4.delete_thread(ID)
            self.assertNotIn('thread/delete', [m for m, _ in backend4.calls])

    def test_system_error_status_changed_to_active_blocks_delete(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            backend.status = 'systemError'
            def custom_request(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    if params.get('includeTurns'):
                        return {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'active'},
                                          'turns': [{'id': 't1', 'status': 'completed'}]}}
                    return {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'systemError'}}}
                return {}
            backend.request = custom_request
            with self.assertRaisesRegex(ValueError, '结束当前任务'):
                b.delete_thread(ID)
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])
            self.assertIn(ID, b.records['threads'])

    def test_system_error_pending_native_queue_blocks_delete(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            backend.status = 'systemError'
            def custom_request(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    return {'thread': {'id': ID, 'cwd': root, 'status': {'type': 'systemError'},
                                      'turns': [{'id': 't1', 'status': 'failed'}]}}
                if method == 'thread/queue/list':
                    return {'data': [{'id': 'pending-msg'}], 'nextCursor': None}
                return {}
            backend.request = custom_request
            with self.assertRaisesRegex(ValueError, '待发送消息|处理队列'):
                b.delete_thread(ID)
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])
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

    def test_delete_does_not_hold_bridge_lock_while_waiting_for_a_sender(self):
        with tempfile.TemporaryDirectory() as root:
            b, _ = self.fixture(root)
            actions, waiting = threading.RLock(), threading.Event()
            class Actions:
                def __enter__(self):
                    waiting.set()
                    actions.acquire()
                def __exit__(self, *_):
                    actions.release()
            b.live[ID] = SimpleNamespace(actions=Actions(), condition=threading.Condition(),
                state={}, submissions={}, closed=False, queue_event=threading.Event())
            failures = []
            def run():
                try:
                    b.delete_thread(ID)
                except Exception as error:
                    failures.append(error)
            actions.acquire()
            worker = threading.Thread(target=run, daemon=True)
            worker.start()
            try:
                self.assertTrue(waiting.wait(2))
                acquired = b.lock.acquire(timeout=.1)
                if acquired:
                    b.lock.release()
                self.assertTrue(acquired, 'sender must be able to finish its native queue read')
            finally:
                actions.release()
                worker.join(2)
            self.assertFalse(worker.is_alive())
            self.assertEqual(failures, [])

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

    def test_empty_thread_no_rollout_preflight_checks_queue_and_deletes_via_native_owner(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            error = SideChatError('no rollout')
            error.rpc_error = {'code': -32600, 'message': 'no rollout found for thread id ' + ID}
            def custom_request(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    raise error
                if method == 'thread/queue/list':
                    return {'data': [], 'nextCursor': None}
                if method == 'thread/delete':
                    return {}
                return {}
            backend.request = custom_request
            b.web_history.get = lambda _: (_ for _ in ()).throw(KeyError(ID))
            self.assertEqual(b.delete_thread(ID), {'ok': True})
            self.assertEqual([m for m, _ in backend.calls], ['thread/read', 'thread/queue/list', 'thread/delete'])
            self.assertEqual(backend.calls[-1], ('thread/delete', {'threadId': ID}))
            self.assertEqual(len([m for m, _ in backend.calls if m == 'thread/delete']), 1)
            self.assertNotIn(ID, b.records['threads'])

    def test_empty_thread_preflight_fails_closed_if_queue_not_empty(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            error = SideChatError('no rollout')
            error.rpc_error = {'code': -32600, 'message': 'no rollout found for thread id ' + ID}
            def custom_request(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    raise error
                if method == 'thread/queue/list':
                    return {'data': [{'id': 'pending-msg'}], 'nextCursor': None}
                if method == 'thread/delete':
                    return {}
                return {}
            backend.request = custom_request
            b.web_history.get = lambda _: (_ for _ in ()).throw(KeyError(ID))
            with self.assertRaisesRegex(ValueError, '待发送消息|处理队列'):
                b.delete_thread(ID)
            self.assertEqual([m for m, _ in backend.calls], ['thread/read', 'thread/queue/list'])
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])
            self.assertIn(ID, b.records['threads'])

    def test_empty_thread_preflight_fails_closed_if_native_store_present(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            error = SideChatError('no rollout')
            error.rpc_error = {'code': -32600, 'message': 'no rollout found for thread id ' + ID}
            def custom_request(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    raise error
                return {}
            backend.request = custom_request
            b.web_history.get = lambda _: {'cwd': root, 'archived': False}
            with self.assertRaisesRegex(ValueError, '预检失败|未确认删除'):
                b.delete_thread(ID)
            self.assertEqual([m for m, _ in backend.calls], ['thread/read'])
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])
            self.assertIn(ID, b.records['threads'])

    def test_empty_thread_preflight_fails_closed_on_inexact_no_rollout_text_or_code(self):
        with tempfile.TemporaryDirectory() as root:
            # 1. 别的 no rollout 文本
            b, backend = self.fixture(root)
            error1 = SideChatError('inexact')
            error1.rpc_error = {'code': -32600, 'message': 'active error: no rollout found for thread id ' + ID}
            def custom_request1(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    raise error1
                return {}
            backend.request = custom_request1
            b.web_history.get = lambda _: (_ for _ in ()).throw(KeyError(ID))
            with self.assertRaises(ValueError):
                b.delete_thread(ID)
            self.assertEqual([m for m, _ in backend.calls], ['thread/read'])
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])
            self.assertIn(ID, b.records['threads'])

            # 2. 错误的 RPC 错误码
            b2, backend2 = self.fixture(root)
            error2 = SideChatError('wrong code')
            error2.rpc_error = {'code': -32000, 'message': 'no rollout found for thread id ' + ID}
            def custom_request2(method, params, timeout=30):
                backend2.calls.append((method, params))
                if method == 'thread/read':
                    raise error2
                return {}
            backend2.request = custom_request2
            b2.web_history.get = lambda _: (_ for _ in ()).throw(KeyError(ID))
            with self.assertRaises(ValueError):
                b2.delete_thread(ID)
            self.assertEqual([m for m, _ in backend2.calls], ['thread/read'])
            self.assertNotIn('thread/delete', [m for m, _ in backend2.calls])
            self.assertIn(ID, b2.records['threads'])

    def test_preflight_cwd_mismatch_and_timeout_never_dispatches_delete(self):
        with tempfile.TemporaryDirectory() as root:
            # 权限/目录不一致
            b, backend = self.fixture(root)
            def custom_request_cwd(method, params, timeout=30):
                backend.calls.append((method, params))
                if method == 'thread/read':
                    return {'thread': {'id': ID, 'cwd': str(Path(root) / 'sub'), 'status': {'type': 'idle'}}}
                return {}
            backend.request = custom_request_cwd
            with self.assertRaises(PermissionError):
                b.delete_thread(ID)
            self.assertEqual([m for m, _ in backend.calls], ['thread/read'])
            self.assertNotIn('thread/delete', [m for m, _ in backend.calls])
            self.assertIn(ID, b.records['threads'])

            # preflight 阶段超时明确未发 delete
            b2, backend2 = self.fixture(root)
            def custom_request_timeout(method, params, timeout=30):
                backend2.calls.append((method, params))
                if method == 'thread/read':
                    raise TimeoutError('read timeout')
                return {}
            backend2.request = custom_request_timeout
            with self.assertRaises(ValueError):
                b2.delete_thread(ID)
            self.assertEqual([m for m, _ in backend2.calls], ['thread/read'])
            self.assertNotIn('thread/delete', [m for m, _ in backend2.calls])
            self.assertIn(ID, b2.records['threads'])

    def test_dispatched_delete_receipt_uncertainty_on_timeout_never_retries(self):
        with tempfile.TemporaryDirectory() as root:
            b, backend = self.fixture(root)
            backend.failure = TimeoutError('delete write timed out')
            before = copy.deepcopy(b.records)
            with self.assertRaisesRegex(ValueError, '未确认删除结果'):
                b.delete_thread(ID)
            self.assertEqual(b.records, before)
            # 写操作绝不重发，thread/delete 仅 1 次
            self.assertEqual([m for m, _ in backend.calls], ['thread/read', 'thread/queue/list', 'thread/delete'])
            self.assertEqual(len([m for m, _ in backend.calls if m == 'thread/delete']), 1)




if __name__ == '__main__':
    unittest.main()
