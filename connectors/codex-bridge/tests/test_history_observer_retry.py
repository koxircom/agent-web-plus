"""Read-only history observers briefly cache native resume failures."""
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from bridge.features.sessions.side_chat import SideChatError
import test_history_read_isolation as history_read_isolation

SLOW = history_read_isolation.SLOW


class HistoryObserverRetryTests(unittest.TestCase):
    def fixture(self, request):
        bridge = history_read_isolation.HistoryReadIsolationTests().bridge()
        saved = SimpleNamespace(id=SLOW, state={'turns': [{
            'turnId': 'saved-turn', 'status': 'completed', 'items': [{
                'id': 'saved-item', 'type': 'userMessage', 'text': 'saved history body',
            }],
        }]})
        fallback_calls = []
        bridge.history.session = lambda identifier, full=False: (
            fallback_calls.append((identifier, full)), saved
        )[1]

        class Backend:
            shared = True

            def request(self, method, params, timeout=30):
                return request(method, params, timeout)

        backend = Backend()
        bridge._history_backend = lambda: backend
        return bridge, saved, fallback_calls

    def assert_saved_history(self, result, saved):
        self.assertIs(result, saved)
        self.assertEqual(saved.state['turns'][0]['items'][0]['text'], 'saved history body')

    def test_concurrent_observer_failures_share_one_native_attempt_and_return_saved_history(self):
        entered, release = threading.Event(), threading.Event()
        rpc_calls, results, errors, starts = [], [], [], [threading.Event(), threading.Event()]

        def request(method, params, _timeout):
            rpc_calls.append((method, params))
            if len(rpc_calls) == 1:
                entered.set()
                if not release.wait(3):
                    raise AssertionError('test did not release the first native resume')
            raise SideChatError('simulated native owner unavailable')

        bridge, saved, fallback_calls = self.fixture(request)

        def read(index):
            starts[index].set()
            try:
                results.append(bridge.session(SLOW, attach=False))
            except BaseException as error:
                errors.append(error)

        workers = [threading.Thread(target=read, args=(index,), daemon=True) for index in range(2)]
        workers[0].start()
        try:
            self.assertTrue(entered.wait(1), 'native history resume did not start')
            workers[1].start()
            self.assertTrue(starts[1].wait(1), 'second history read did not start')
        finally:
            release.set()
            for worker in workers:
                if worker.ident is not None:
                    worker.join(3)

        self.assertFalse(any(worker.is_alive() for worker in workers), 'history readers did not stop')
        self.assertFalse(errors, errors)
        self.assertEqual(len(rpc_calls), 1)
        self.assertEqual(rpc_calls[0][0], 'thread/resume')
        self.assertEqual(len(results), 2)
        for result in results:
            self.assert_saved_history(result, saved)
        self.assertEqual(fallback_calls, [(SLOW, False), (SLOW, False)])

    def test_native_event_retries_and_publishes_a_live_observer(self):
        calls=[]
        def request(method, params, _timeout):
            calls.append(method)
            if len(calls)==1:
                raise SideChatError('simulated native owner unavailable')
            return {'thread': {'id': SLOW, 'cwd': '/tmp', 'status': {'type': 'idle'}}}
        bridge,saved,_=self.fixture(request)
        saved.condition=threading.RLock()
        bridge.history_runtime=bridge._history_backend()
        with patch('bridge.clients.codex.standalone.Chat', history_read_isolation.Observer):
            self.assert_saved_history(bridge.session(SLOW,attach=False),saved)
            bridge._runtime_event({'method':'thread/status/changed','params':{'threadId':SLOW,'status':{'type':'active'}}},'history')
            observed=bridge.session(SLOW,attach=False)
        self.assertEqual(calls,['thread/resume','thread/resume'])
        self.assertIsNot(observed,saved)
        self.assertEqual(observed.id,SLOW)

    def test_failure_cache_expires_and_force_retries_immediately(self):
        now = [100.0]
        rpc_calls = []

        def request(method, params, _timeout):
            rpc_calls.append((method, params))
            raise SideChatError('simulated native owner unavailable')

        bridge, saved, fallback_calls = self.fixture(request)
        with patch('bridge.clients.codex.standalone.time.monotonic', side_effect=lambda: now[0]):
            self.assert_saved_history(bridge.session(SLOW, attach=False), saved)
            self.assert_saved_history(bridge.session(SLOW, attach=False), saved)
            self.assertEqual(len(rpc_calls), 1, 'an unforced retry ignored the short failure cache')

            now[0] += 10.1
            self.assert_saved_history(bridge.session(SLOW, attach=False), saved)
            self.assertEqual(len(rpc_calls), 2, 'expired failure cache permanently hid the native retry')

            self.assert_saved_history(bridge.session(SLOW, attach=False, force=True), saved)
            self.assertEqual(len(rpc_calls), 3, 'force=True did not bypass the current failure cache')

        self.assertEqual(fallback_calls, [(SLOW, False)] * 4)


if __name__ == '__main__':
    unittest.main()
