"""Focused contracts for native standalone composer modes and goal controls."""
import copy
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge.clients.codex.standalone import Chat, StandaloneBridge
from bridge.clients.codex.standalone_composer import (
    composer_mode, composer_state, native_goal, submission_work_mode,
)
from bridge.features.sessions.side_chat import SideChat, SideChatError


THREAD = '01901234-5678-7000-8000-000000000001'


class NativeBackend:
    shared = False
    process = SimpleNamespace(poll=lambda: None)

    def __init__(self, goal=None):
        self.goal = copy.deepcopy(goal)
        self.calls = []
        self.fail_next_get = False

    def request(self, method, params, timeout=30):
        self.calls.append((method, copy.deepcopy(params)))
        if method == 'thread/goal/get':
            if self.fail_next_get:
                self.fail_next_get = False
                raise SideChatError('原生目标读取超时')
            return {'goal': copy.deepcopy(self.goal)}
        if method == 'thread/goal/set':
            if 'objective' in params:
                self.goal = {'threadId': THREAD, 'objective': params['objective'],
                             'status': params.get('status', 'active'), 'createdAt': 100,
                             'timeUsedSeconds': 0}
            else:
                self.goal = {**self.goal, 'status': params['status']}
            return {'goal': copy.deepcopy(self.goal)}
        if method == 'thread/goal/clear':
            self.goal = None
            return {}
        if method == 'turn/start':
            return {'turn': {'id': 'turn-1', 'status': 'inProgress'}}
        raise AssertionError('unexpected native request: ' + method)

    def write(self, value):
        self.calls.append(('write', copy.deepcopy(value)))


class StandaloneComposerTests(unittest.TestCase):
    def test_mode_snapshot_uses_prior_row_before_new_composer_mode(self):
        prior = {'workMode': 'plan'}
        self.assertEqual(submission_work_mode(None, 'goal', prior), 'plan')
        self.assertEqual(submission_work_mode(None, 'normal'), 'default')
        self.assertEqual(submission_work_mode('normal', 'plan'), 'default')
        self.assertIsNone(submission_work_mode('goal', 'goal', steer=True))
        self.assertEqual(composer_mode('goal'), 'goal')
        with self.assertRaises(ValueError):
            composer_mode('automatic')

    def test_composer_state_preserves_native_terminal_status_and_unknown(self):
        complete = {'objective': '完成的目标', 'status': 'complete', 'createdAt': 42,
                    'timeUsedSeconds': 3}
        state = composer_state('plan', complete, goal_known=True)
        self.assertEqual(state['goalStatus'], 'complete')
        self.assertFalse(state['paused'])
        self.assertEqual(state['goalElapsedMs'], 3000)
        unknown = composer_state('plan', None, goal_known=False)
        self.assertNotIn('goal', unknown)
        self.assertFalse(unknown['goalKnown'])
        empty = composer_state('normal', None, goal_known=True)
        self.assertNotIn('goal', empty)
        self.assertTrue(empty['goalKnown'])
        self.assertEqual(unknown['capabilities'], {'goal': True, 'plan': True})
        self.assertIsNone(native_goal({'goal': None}))
        with self.assertRaises(ValueError):
            native_goal({})
        with self.assertRaises(ValueError):
            native_goal({'goal': {'objective': '无 status'}})

    def test_mode_switch_adopts_scoped_history_without_starting_turn(self):
        bridge = object.__new__(StandaloneBridge)
        bridge.registry_lock = threading.RLock()
        bridge.records = {'threads': {}}
        bridge.workspaces = [{'path': Path('/tmp')}]
        bridge.save = lambda: None
        calls = []

        def adopt(thread_id):
            calls.append(('adopt', thread_id))
            bridge.records['threads'][thread_id] = {'cwd': '/tmp', 'runtime': 'history'}

        bridge._adopt_record = adopt
        bridge.view = lambda thread_id: {'id': thread_id, 'composerMode': bridge.records['threads'][thread_id]['composerMode']}
        result = StandaloneBridge.set_composer_mode(bridge, THREAD, 'plan')

        self.assertEqual(result['composerMode'], 'plan')
        self.assertEqual(calls, [('adopt', THREAD)])
        self.assertEqual(bridge.records['threads'][THREAD]['composerRevision'], 1)
        bridge.set_composer_mode(THREAD, 'plan')
        self.assertEqual(bridge.records['threads'][THREAD]['composerRevision'], 1)
        bridge.set_composer_mode(THREAD, 'normal')
        self.assertEqual(bridge.records['threads'][THREAD]['composerRevision'], 2)
        self.assertFalse(any(method == 'turn/start' for method, _ in calls))

    def test_unsupported_goal_mode_keeps_previous_composer_mode(self):
        bridge = object.__new__(StandaloneBridge)
        bridge.registry_lock = threading.RLock()
        bridge.records = {'threads': {THREAD: {'cwd': '/tmp', 'composerMode': 'plan',
                                               'goalSupported': False, 'goalSupportChecked': True}}}
        bridge.workspaces = [{'path': Path('/tmp')}]
        bridge.save = lambda: None
        bridge.session = lambda _thread: self.fail('unsupported goal must be rejected before probing')

        with self.assertRaisesRegex(ValueError, '不支持原生目标'):
            StandaloneBridge.set_composer_mode(bridge, THREAD, 'goal')
        self.assertEqual(bridge.records['threads'][THREAD]['composerMode'], 'plan')

    def test_goal_metadata_refresh_keeps_recency_and_skips_unchanged_disk_write(self):
        bridge = SimpleNamespace(registry_lock=threading.RLock(),
                                 records={'threads': {THREAD: {'updatedAt': 42}}})
        writes = []
        bridge.save = lambda: writes.append(True)
        chat = object.__new__(Chat)
        chat.id, chat.bridge = THREAD, bridge
        chat.lock = threading.RLock()
        chat.condition = threading.Condition(chat.lock)
        chat.state, chat.submissions = {}, {}
        chat.goal_known, chat.goal_supported, chat.goal_support_checked = False, True, False
        chat.backend = NativeBackend()
        chat.changed = lambda: None
        chat.refresh_native_goal()
        self.assertEqual(bridge.records['threads'][THREAD]['updatedAt'], 42)
        self.assertEqual(len(writes), 1)
        chat.refresh_native_goal()
        self.assertEqual(len(writes), 1)
        self.assertEqual(bridge.records['threads'][THREAD]['updatedAt'], 42)

    def goal_chat(self):
        from test_shared_bridge import SharedBridgeTests
        import tempfile
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        bridge, chat, _ = SharedBridgeTests().fixture(self.folder.name)
        chat.backend = NativeBackend({'objective': '持久目标', 'status': 'active', 'createdAt': 42})
        return bridge, chat

    def test_goal_events_increment_revision_but_duplicate_snapshot_does_not(self):
        bridge, chat = self.goal_chat()
        chat.refresh_native_goal()
        first = chat.composer_state()
        self.assertEqual(first['goal'], '持久目标')
        chat.refresh_native_goal()
        self.assertEqual(chat.composer_state()['revision'], first['revision'])
        chat._event({'method': 'thread/goal/updated', 'params': {'threadId': THREAD, 'goal': {
            'objective': '持久目标', 'status': 'complete', 'createdAt': 42}}})
        completed = chat.composer_state()
        self.assertGreater(completed['revision'], first['revision'])
        self.assertEqual(completed['goalStatus'], 'complete')
        self.assertEqual(completed['goal'], '持久目标')
        chat._event({'method': 'thread/goal/cleared', 'params': {'threadId': THREAD}})
        cleared = chat.composer_state()
        self.assertGreater(cleared['revision'], completed['revision'])
        self.assertTrue(cleared['goalKnown'])
        self.assertNotIn('goal', cleared)

    def test_reconnect_read_failure_preserves_confirmed_goal_and_revision(self):
        bridge, chat = self.goal_chat()
        chat.refresh_native_goal()
        before = chat.composer_state()
        chat.backend.fail_next_get = True
        chat.refresh_native_goal()
        self.assertEqual(chat.composer_state(), before)
        self.assertTrue(bridge.records['threads'][THREAD]['goalKnown'])

    def test_slow_refresh_cannot_erase_newer_goal_event(self):
        bridge, chat = self.goal_chat()
        original = chat.backend.request
        def overtaken(method, params, timeout=30):
            chat._event({'method': 'thread/goal/updated', 'params': {'threadId': THREAD, 'goal': {
                'objective': '最新目标', 'status': 'active', 'createdAt': 45}}})
            return {'goal': None}
        chat.backend.request = overtaken
        chat.refresh_native_goal()
        self.assertEqual(chat.composer_state()['goal'], '最新目标')

    def test_goal_turn_uses_native_default_and_only_the_user_input(self):
        chat = object.__new__(SideChat)
        chat.id = THREAD
        chat.uploads = None
        chat.lock = threading.RLock()
        chat.runtime = NativeBackend()
        chat.turn_permissions = {}
        chat.state = {'cwd': '/tmp', 'latestModel': 'model', 'latestReasoningEffort': 'high',
                      'threadRuntimeStatus': {'type': 'idle'}, 'turns': [], 'requests': []}
        chat._release_handoff_turns = lambda: None
        row = {'mode': 'send', 'workMode': 'goal', 'text': '按需求完成页面',
               'status': 'queued', 'skills': [], 'catalog': None, 'attachmentIds': []}

        result = SideChat._dispatch(chat, '01901234-5678-7000-8000-000000000002', row)

        method, params = chat.runtime.calls[-1]
        self.assertEqual(method, 'turn/start')
        self.assertEqual(params['collaborationMode']['mode'], 'default')
        self.assertEqual(params['input'], [{'type': 'text', 'text': '按需求完成页面', 'text_elements': []}])
        self.assertEqual(result['status'], 'accepted')

    def test_goal_submission_write_ahead_and_unknown_is_never_replayed(self):
        backend = NativeBackend()
        backend.fail_next_get = True
        chat = object.__new__(Chat)
        chat.id, chat.backend = THREAD, backend
        chat.condition = threading.Condition(threading.RLock())
        chat.changed = lambda: None
        chat.goal_known, chat.goal_supported = False, True
        chat.state = {'threadGoal': None}
        persisted = []
        chat.persist = lambda: persisted.append(copy.deepcopy(row))
        row = {'text': '整理工作流', 'status': 'queued'}

        self.assertFalse(chat._prepare_goal_submission('sub-1', row))
        self.assertEqual(row['status'], 'unknown')
        self.assertEqual(row['goalMutation']['state'], 'unknown')
        calls = len(backend.calls)
        self.assertFalse(chat._prepare_goal_submission('sub-1', row))
        self.assertEqual(len(backend.calls), calls)
        self.assertGreaterEqual(len(persisted), 2)

    def test_goal_submission_sets_user_goal_before_same_turn(self):
        backend = NativeBackend()
        chat = object.__new__(Chat)
        chat.id, chat.backend = THREAD, backend
        chat.condition = threading.Condition(threading.RLock())
        chat.changed = lambda: None
        chat.goal_known, chat.goal_supported = False, True
        chat.state = {'threadGoal': None}
        chat.persist = lambda: None
        row = {'text': '整理工作流', 'status': 'queued'}

        self.assertTrue(chat._prepare_goal_submission('sub-2', row))
        self.assertEqual([method for method, _ in backend.calls], [
            'thread/goal/get', 'thread/goal/set', 'thread/goal/get'])
        self.assertEqual(backend.calls[1][1]['origin'], 'user')
        self.assertEqual(row['goalMutation']['state'], 'confirmed')
        self.assertEqual(chat.state['threadGoal']['objective'], '整理工作流')

    def test_goal_success_consumes_input_mode_but_keeps_native_goal(self):
        import uuid
        bridge, chat = self.goal_chat()
        chat.shared = False
        chat.backend.goal = None
        chat.runtime = chat.backend
        chat.refresh_shared_state = lambda: None
        bridge._adopt_record = lambda _: None
        bridge.session = lambda _: chat
        entry = bridge.records['threads'][THREAD]
        entry.update(composerMode='goal', composerModeRevision=3)
        submission = str(uuid.uuid4())
        result = bridge.send(THREAD, '本轮目标', submission)
        self.assertEqual(result['status'], 'accepted')
        self.assertEqual(result['composerState']['mode'], 'normal')
        self.assertEqual(result['composerState']['goal'], '本轮目标')
        self.assertEqual(chat.backend.goal['objective'], '本轮目标')
        self.assertEqual(entry['composerModeRevision'], 4)
        revision = result['composerState']['revision']
        # The same receipt never consumes a later input selection.
        entry.update(composerMode='goal', composerModeRevision=5)
        repeated = bridge.send(THREAD, '本轮目标', submission)
        self.assertEqual(repeated['status'], 'accepted')
        self.assertEqual(entry['composerMode'], 'goal')
        self.assertEqual(entry['composerRevision'], revision)
        entry.update(composerMode='normal')
        chat.state['threadRuntimeStatus']['type'] = 'idle'
        bridge.send(THREAD, '下一条普通消息', str(uuid.uuid4()))
        self.assertEqual(list(chat.submissions.values())[-1]['workMode'], 'default')
        self.assertEqual(chat.backend.goal['objective'], '本轮目标')

    def test_goal_failure_or_newer_mode_selection_is_not_consumed(self):
        import uuid
        from unittest.mock import patch
        for outcome in ('failed', 'unknown', 'newer-goal', 'newer-plan'):
            with self.subTest(outcome=outcome):
                bridge, chat = self.goal_chat()
                chat.shared = False
                chat.backend.goal = None
                chat.refresh_shared_state = lambda: None
                bridge._adopt_record = lambda _: None
                bridge.session = lambda _: chat
                entry = bridge.records['threads'][THREAD]
                entry.update(composerMode='goal', composerModeRevision=3)
                def dispatch(_chat, submission, row):
                    if outcome.startswith('newer-'):
                        entry.update(composerMode=outcome[6:], composerModeRevision=5)
                    row['status'] = outcome if outcome in ('failed', 'unknown') else 'accepted'
                    return {'id': submission, 'status': row['status']}
                with patch.object(SideChat, '_dispatch', dispatch):
                    result = bridge.send(THREAD, '失败也不能丢失的目标', str(uuid.uuid4()))
                self.assertEqual(entry['composerMode'], 'plan' if outcome == 'newer-plan' else 'goal')
                self.assertEqual(list(chat.submissions.values())[0]['text'], '失败也不能丢失的目标')
                self.assertNotEqual(result['composerState']['mode'], 'normal')

    def goal_bridge(self, goal):
        bridge = object.__new__(StandaloneBridge)
        bridge.goal_lock = threading.RLock()
        bridge.registry_lock = threading.RLock()
        bridge.records = {'threads': {THREAD: {'cwd': '/tmp', 'goalCommandReceipts': {}}}}
        bridge.workspaces = [{'path': Path('/tmp')}]
        bridge.save = lambda: None
        backend = NativeBackend(goal)
        chat = SimpleNamespace(
            actions=threading.RLock(), backend=backend, goal_supported=True, goal_known=True,
            condition=threading.Condition(), state={'threadGoal': copy.deepcopy(goal)},
            persist=lambda: None, changed=lambda: None,
        )
        bridge.session = lambda _thread: chat
        return bridge, backend, chat

    def test_pause_is_origin_user_idempotent_and_sends_no_turn(self):
        goal = {'threadId': THREAD, 'objective': '整理工作流', 'status': 'active',
                'createdAt': 100, 'timeUsedSeconds': 0}
        bridge, backend, chat = self.goal_bridge(goal)
        identity = {'objective': goal['objective'], 'createdAt': goal['createdAt']}

        first = StandaloneBridge.set_goal_status(bridge, THREAD, 'paused',
                                                 '01901234-5678-7000-8000-000000000003',
                                                 expected=identity)
        calls = len(backend.calls)
        second = StandaloneBridge.set_goal_status(bridge, THREAD, 'paused',
                                                  '01901234-5678-7000-8000-000000000003',
                                                  expected=identity)

        self.assertTrue(first['confirmed'])
        self.assertTrue(second['duplicate'])
        self.assertEqual(backend.goal['status'], 'paused')
        self.assertEqual(chat.state['threadGoal']['status'], 'paused')
        self.assertEqual([m for m, _ in backend.calls].count('turn/start'), 0)
        self.assertEqual(backend.calls[1][1]['origin'], 'user')
        self.assertEqual(len(backend.calls), calls)

    def test_goal_action_read_timeout_keeps_confirmed_goal(self):
        goal = {'objective': '不能丢失的目标', 'status': 'active', 'createdAt': 100}
        bridge, backend, chat = self.goal_bridge(goal)
        backend.fail_next_get = True
        with self.assertRaises(SideChatError):
            bridge.set_goal_status(THREAD, 'paused',
                '01901234-5678-7000-8000-000000000009', expected={'objective': goal['objective'], 'createdAt': 100})
        self.assertEqual(chat.state['threadGoal'], goal)
        self.assertTrue(chat.goal_known)

    def test_cancel_requires_matching_expected_identity(self):
        goal = {'threadId': THREAD, 'objective': '整理工作流', 'status': 'active',
                'createdAt': 100, 'timeUsedSeconds': 0}
        bridge, backend, _chat = self.goal_bridge(goal)
        wrong = {'objective': goal['objective'], 'createdAt': 99}
        with self.assertRaisesRegex(ValueError, '目标已发生变化'):
            StandaloneBridge.cancel_goal(bridge, THREAD,
                                         '01901234-5678-7000-8000-000000000004', expected=wrong)
        self.assertIsNotNone(backend.goal)
        self.assertNotIn('thread/goal/clear', [method for method, _ in backend.calls])


if __name__ == '__main__':
    unittest.main()
