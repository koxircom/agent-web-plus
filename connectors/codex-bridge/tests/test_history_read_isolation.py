"""Slow historical observers must not stall other Codex conversations."""
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from weakref import WeakValueDictionary

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import StandaloneBridge
from bridge.clients.codex.wsl_history import WslHistory

SLOW = '01901234-5678-7000-8000-000000000001'
FAST = '01901234-5678-7000-8000-000000000002'


class Observer:
    connected = True
    shared = True

    def __init__(self, bridge, identifier, result, backend, entry=None):
        self.id = identifier


class HistoryReadIsolationTests(unittest.TestCase):
    def bridge(self):
        bridge = StandaloneBridge.__new__(StandaloneBridge)
        bridge.lock = threading.RLock()
        bridge.registry_lock = threading.RLock()
        bridge.history_observation_locks = WeakValueDictionary()
        bridge.records = {'threads': {}}
        bridge.workspaces = [{'path': Path('/tmp')}]
        bridge.live = {}
        bridge.history_socket = '/unused-test-socket'
        bridge.history = SimpleNamespace(get=lambda _: {'cwd': '/tmp', 'title': 'fixture'})
        bridge._history_backend = lambda: object()
        bridge._start_queue = lambda _: None
        return bridge

    def assert_unrelated_read_completes(self, bridge, read):
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        failures, calls = [], []

        def resume(backend, identifier):
            calls.append(identifier)
            if identifier == SLOW:
                entered.set()
                if not release.wait(3):
                    raise AssertionError('test did not release the slow observer')
            return {'thread': {'cwd': '/tmp'}}

        def run(operation, done=None):
            try:
                operation()
            except BaseException as error:
                failures.append(error)
            finally:
                if done:
                    done.set()

        bridge._resume_history = resume
        slow = threading.Thread(target=run, args=(lambda: bridge._observe_history(SLOW),))
        fast = threading.Thread(target=run, args=(read, finished))
        with patch('bridge.clients.codex.standalone.Chat', Observer):
            slow.start()
            try:
                self.assertTrue(entered.wait(1), 'slow native read did not start')
                fast.start()
                self.assertTrue(finished.wait(0.5), 'an unrelated read waited for the slow history')
            finally:
                release.set()
                slow.join(2)
                if fast.ident:
                    fast.join(2)
        self.assertFalse(failures, failures)
        return calls

    def test_cached_foreground_session_does_not_wait_for_another_observer(self):
        bridge = self.bridge()
        expected = object()
        bridge.records['threads'][FAST] = {'cwd': '/tmp', 'runtime': 'history'}
        bridge.live[FAST] = expected
        results = []
        self.assert_unrelated_read_completes(bridge, lambda: results.append(bridge.session(FAST, attach=False)))
        self.assertIs(results[0], expected)

    def test_cold_foreground_session_can_observe_while_another_session_is_slow(self):
        bridge = self.bridge()
        results = []
        calls = self.assert_unrelated_read_completes(bridge, lambda: results.append(bridge.session(FAST, attach=False)))
        self.assertEqual(results[0].id, FAST)
        self.assertCountEqual(calls, [SLOW, FAST])

    def test_same_session_observation_remains_single_flight(self):
        bridge = self.bridge()
        entered, release = threading.Event(), threading.Event()
        results, calls, errors = [], [], []

        def resume(backend, identifier):
            calls.append(identifier)
            entered.set()
            if not release.wait(3):
                raise AssertionError('test did not release observer')
            return {'thread': {'cwd': '/tmp'}}

        def read():
            try:
                results.append(bridge.session(SLOW, attach=False))
            except BaseException as error:
                errors.append(error)

        bridge._resume_history = resume
        workers = [threading.Thread(target=read) for _ in range(2)]
        with patch('bridge.clients.codex.standalone.Chat', Observer):
            workers[0].start()
            try:
                self.assertTrue(entered.wait(1))
                workers[1].start()
            finally:
                release.set()
                for worker in workers:
                    if worker.ident:
                        worker.join(2)
        self.assertFalse(errors, errors)
        self.assertEqual(calls, [SLOW])
        self.assertEqual(len(results), 2)
        self.assertIs(results[0], results[1])

    def test_slow_saved_history_parse_does_not_hold_the_cache_registry_lock(self):
        history = WslHistory.__new__(WslHistory)
        history.lock = threading.RLock()
        history.get = lambda identifier: {'id': identifier}
        entered, release, finished = threading.Event(), threading.Event(), threading.Event()
        errors = []

        def slow_refresh(*_):
            entered.set()
            if not release.wait(3):
                raise AssertionError('test did not release saved history')

        history.sessions = {
            SLOW: SimpleNamespace(refresh=slow_refresh),
            FAST: SimpleNamespace(refresh=lambda *_: None),
        }

        def read(identifier, done=None):
            try:
                history.session(identifier)
            except BaseException as error:
                errors.append(error)
            finally:
                if done:
                    done.set()

        slow = threading.Thread(target=read, args=(SLOW,))
        fast = threading.Thread(target=read, args=(FAST, finished))
        slow.start()
        try:
            self.assertTrue(entered.wait(1))
            fast.start()
            self.assertTrue(finished.wait(0.5), 'another saved history waited for a slow parse')
        finally:
            release.set()
            slow.join(2)
            if fast.ident:
                fast.join(2)
        self.assertFalse(errors, errors)

    def test_observation_revalidates_deleted_history_before_publication(self):
        bridge = self.bridge()

        def missing(_):
            raise KeyError('history removed during native read')

        def resume(*_):
            bridge.history.get = missing
            return {'thread': {'cwd': '/tmp'}}

        bridge._resume_history = resume
        with patch('bridge.clients.codex.standalone.Chat', Observer):
            with self.assertRaises(KeyError):
                bridge._observe_history(SLOW)
        self.assertNotIn(SLOW, bridge.live)

    def test_observation_rejects_a_workspace_change_during_native_read(self):
        bridge = self.bridge()

        def resume(*_):
            bridge.history.get = lambda _: {'cwd': '/', 'title': 'moved'}
            return {'thread': {'cwd': '/tmp'}}

        bridge._resume_history = resume
        with patch('bridge.clients.codex.standalone.Chat', Observer):
            with self.assertRaises(PermissionError):
                bridge._observe_history(SLOW)
        self.assertNotIn(SLOW, bridge.live)


if __name__ == '__main__':
    unittest.main()
