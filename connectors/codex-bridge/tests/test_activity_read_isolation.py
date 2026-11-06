"""Activity reads use committed summaries instead of waiting on turn history."""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import Chat, StandaloneBridge


THREAD = '01901234-5678-7000-8000-000000000001'
TURN = 'activity-turn'
ITEM = 'question-item'
QUESTION = '["request_user_input_async","' + ITEM + '",0]'


def thread_result(status='idle', turns=None):
    return {'thread': {'id': THREAD, 'cwd': None, 'status': {'type': status},
                       'turns': [] if turns is None else turns},
            'model': 'model', 'reasoningEffort': 'high'}


class ActivityReadIsolationTests(unittest.TestCase):
    def fixture(self, root, *, status='idle', turns=None):
        entry = {'title': '活动测试', 'cwd': root, 'runtime': 'web', 'updatedAt': 1234.5,
                 'submissions': {}}

        class Backend:
            shared = False
            process = SimpleNamespace(poll=lambda: None)

        bridge = StandaloneBridge.__new__(StandaloneBridge)
        bridge.registry_lock = threading.RLock()
        bridge.lock = threading.RLock()
        bridge.records = {'threads': {THREAD: entry}}
        bridge.workspaces = [{'path': Path(root)}]
        bridge.history = None
        bridge.live = {}
        bridge.uploads = None
        bridge.catalog_reader = None
        bridge.save = lambda: None
        chat = Chat(bridge, THREAD,
                    {**thread_result(status, turns), 'thread': {
                        **thread_result(status, turns)['thread'], 'cwd': root}},
                    Backend(), entry)
        bridge.live[THREAD] = chat
        return bridge, chat

    def test_activity_returns_committed_status_without_waiting_for_or_reading_turns(self):
        turn = {'id': TURN, 'turnId': TURN, 'status': 'completed', 'items': [
            {'id': ITEM, 'type': 'agentMessage', 'text': '',
             'questions': [{'title': '选一个', 'options': ['甲', '乙']}]}
        ]}
        with tempfile.TemporaryDirectory() as root:
            bridge, chat = self.fixture(root, status='idle', turns=[turn])
            held, release, finished = threading.Event(), threading.Event(), threading.Event()
            failures, rows = [], []

            class UnreadableTurns:
                def __iter__(self):
                    raise AssertionError('activity read native turn bodies')

                def __getitem__(self, _key):
                    raise AssertionError('activity read native turn bodies')

                def __deepcopy__(self, _memo):
                    raise AssertionError('activity copied native turn bodies')

            # The committed activity summary must remain usable even if the live
            # history collection cannot be traversed during this read.
            chat.state['turns'] = UnreadableTurns()

            def hold_condition():
                with chat.condition:
                    held.set()
                    if not release.wait(3):
                        failures.append(AssertionError('test did not release chat.condition'))

            def read_activity():
                try:
                    rows.extend(bridge.activity([THREAD]))
                except BaseException as error:
                    failures.append(error)
                finally:
                    finished.set()

            holder = threading.Thread(target=hold_condition, daemon=True)
            reader = threading.Thread(target=read_activity, daemon=True)
            holder.start()
            try:
                self.assertTrue(held.wait(1), 'test thread did not acquire chat.condition')
                reader.start()
                self.assertTrue(finished.wait(0.5),
                                'activity waited for the native history lock')
            finally:
                release.set()
                holder.join(2)
                if reader.ident is not None:
                    reader.join(2)

            self.assertFalse(holder.is_alive(), 'condition holder did not stop')
            self.assertFalse(reader.is_alive(), 'activity reader did not stop')
            self.assertFalse(failures, failures)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]['id'], THREAD)
            self.assertEqual(rows[0]['status'], 'idle')
            self.assertTrue(rows[0]['hasPendingRequests'])

    def test_native_turn_and_async_question_events_refresh_activity_status(self):
        with tempfile.TemporaryDirectory() as root:
            bridge, chat = self.fixture(root)
            self.assertActivity(bridge, 'idle', pending=False)

            chat._event({'method': 'turn/started', 'params': {
                'threadId': THREAD, 'turn': {'id': TURN, 'status': 'inProgress'}}})
            self.assertActivity(bridge, 'active', pending=False)

            question_item = {'id': ITEM, 'type': 'agentMessage', 'text': '',
                             'questions': [{'title': '选一个', 'options': ['甲', '乙']}]}
            chat._event({'method': 'item/completed', 'params': {
                'threadId': THREAD, 'turnId': TURN, 'item': question_item}})
            self.assertActivity(bridge, 'active', pending=True)

            chat._event({'method': 'turn/completed', 'params': {
                'threadId': THREAD, 'turn': {'id': TURN, 'status': 'completed'}}})
            self.assertActivity(bridge, 'idle', pending=True)

            reply = '<send_user_message_question_reply>\n' + json.dumps([
                {'questionItemId': QUESTION, 'question': '选一个', 'answer': '甲'}
            ], ensure_ascii=False) + '\n</send_user_message_question_reply>'
            chat._event({'method': 'item/completed', 'params': {
                'threadId': THREAD, 'turnId': TURN,
                'item': {'id': 'answer-item', 'type': 'userMessage',
                         'content': [{'type': 'text', 'text': reply}]}}})
            self.assertActivity(bridge, 'idle', pending=False)

    def assertActivity(self, bridge, status, *, pending):
        rows = bridge.activity([THREAD])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['status'], status)
        self.assertEqual(rows[0]['hasPendingRequests'], pending)


if __name__ == '__main__':
    unittest.main()
