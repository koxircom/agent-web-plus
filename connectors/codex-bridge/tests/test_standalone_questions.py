"""Standalone async question replies use the normal durable send ledger."""
import copy
import json
import sys
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge.clients.codex.standalone import Chat, StandaloneBridge, async_reply_text, async_submission_id
from bridge.features.sessions.side_chat import SideChatError
from bridge.features.sessions.model import normalize_item, user_display_text


THREAD = '01901234-5678-7000-8000-000000000001'
TURN = 'question-turn'
ITEM = 'question-item'
REQUEST = 'async:' + TURN + ':' + ITEM
QUESTION_ID = '["request_user_input_async","' + ITEM + '",0]'


def thread_result(status='idle'):
    turn_status = 'inProgress' if status == 'active' else 'completed'
    return {'thread': {'id': THREAD, 'cwd': '/tmp', 'status': {'type': status}, 'turns': [{
        'id': TURN, 'turnId': TURN, 'status': turn_status, 'items': [{
            'id': ITEM, 'type': 'agentMessage', 'text': '',
            'questions': [{'title': '选一个', 'options': ['甲', '乙']}],
        }],
    }]}, 'model': 'model', 'reasoningEffort': 'high'}


class Backend:
    shared = False
    process = SimpleNamespace(poll=lambda: None)

    def __init__(self, fail_unknown=False, reject=False):
        self.calls = []
        self.fail_unknown = fail_unknown
        self.reject = reject

    def request(self, method, params, timeout=30):
        self.calls.append((method, copy.deepcopy(params)))
        if method in ('turn/start', 'turn/steer'):
            if self.reject:
                self.reject = False
                error = SideChatError('模拟原生明确拒绝')
                error.rpc_error = {'code': -32602, 'message': '模拟拒绝'}
                raise error
            if self.fail_unknown:
                self.fail_unknown = False
                raise SideChatError('模拟传输结果未确认')
            return {'turn': {'id': params.get('expectedTurnId', 'reply-turn'), 'status': 'inProgress'}}
        raise AssertionError('unexpected request: ' + method)

    def write(self, value):
        self.calls.append(('write', copy.deepcopy(value)))


class StandaloneQuestionsTests(unittest.TestCase):
    def fixture(self, status='idle', entry=None, backend=None):
        entry = entry or {'title': '问题测试', 'cwd': '/tmp', 'runtime': 'web', 'model': 'model',
                          'effort': 'high', 'submissions': {}}
        backend = backend or Backend()
        bridge = SimpleNamespace(registry_lock=threading.RLock(),
            records={'threads': {THREAD: entry}}, catalog_reader=None, uploads=None,
            save=lambda: None)
        chat = Chat(bridge, THREAD, thread_result(status), backend, entry)
        standalone = object.__new__(StandaloneBridge)
        standalone._adopt_record = lambda _thread: None
        standalone._record = lambda _thread: copy.deepcopy(bridge.records['threads'][THREAD])
        standalone.session = lambda _thread: chat
        standalone.catalog_reader = None
        standalone.registry_lock = bridge.registry_lock
        standalone.records = bridge.records
        standalone.live = {THREAD: chat}
        standalone.history = None
        bridge.records['threads'][THREAD]['updatedAt'] = 1
        standalone._native_queue_items = lambda _thread: []
        return standalone, bridge, chat, backend

    def test_question_is_supported_and_reappears_from_native_turn_after_refresh(self):
        _standalone, bridge_state, chat, _backend = self.fixture()
        request = next(row for row in chat.view()['requests'] if row['id'] == REQUEST)
        self.assertTrue(request['supported'])
        self.assertEqual(request['params']['questions'][0]['id'], QUESTION_ID)
        activity = _standalone.activity([THREAD])[0]
        self.assertEqual(activity['status'], 'idle')
        self.assertTrue(activity['hasPendingRequests'])

        fresh = Chat(bridge=bridge_state, identifier=THREAD, result=thread_result(),
                     backend=chat.backend,
                     entry={'title': '问题测试', 'cwd': '/tmp', 'runtime': 'web', 'submissions': {}})
        restored = next(row for row in fresh.view()['requests'] if row['id'] == REQUEST)
        self.assertTrue(restored['supported'])

        bridge_state.records['threads'][THREAD]['submissions'] = {
            async_submission_id(THREAD, REQUEST): {'status': 'unknown',
                'text': async_reply_text([{'id': QUESTION_ID, 'question': '选一个'}],
                                         {'answers': {QUESTION_ID: ['甲']}})}}
        masked = Chat(bridge=bridge_state, identifier=THREAD, result=thread_result(),
                      backend=chat.backend, entry=bridge_state.records['threads'][THREAD])
        self.assertFalse(any(row['id'] == REQUEST for row in masked.view()['requests']))

    def test_reply_uses_stable_identity_native_question_id_and_current_mode(self):
        bridge, _records, chat, backend = self.fixture(status='active')
        result = bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['甲']}})

        expected_submission = str(uuid.uuid5(uuid.UUID(THREAD), 'async-question:' + REQUEST))
        self.assertEqual(result['id'], expected_submission)
        self.assertEqual(result['status'], 'accepted')
        method, params = next(call for call in backend.calls if call[0] == 'turn/steer')
        payload = params['input'][0]['text']
        self.assertTrue(payload.startswith('<send_user_message_question_reply>'))
        replies = json.loads(payload.split('\n', 1)[1].rsplit('\n', 1)[0])
        self.assertEqual(replies, [{'questionItemId': QUESTION_ID, 'question': '选一个', 'answer': '甲'}])
        self.assertEqual(params['clientUserMessageId'], expected_submission)
        self.assertNotIn('approvalPolicy', params)

        duplicate = bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['甲']}})
        self.assertEqual(duplicate, result)
        with self.assertRaisesRegex(ValueError, '不同答案'):
            bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['乙']}})
        self.assertEqual(len([call for call in backend.calls if call[0] == 'turn/steer']), 1)

    def test_reply_display_is_readable_in_live_history_handoff_and_reload(self):
        for status in ('idle', 'active'):
            with self.subTest(status=status):
                bridge, records, chat, backend = self.fixture(status=status)
                result = bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['是，空闲后切换']}})
                identifier = result['id']
                raw = chat.submissions[identifier]['text']
                expected = '问题：选一个\n回答：是，空闲后切换'
                # Immediate handoff / steering acknowledgement must use the same
                # display projection as a later native echo and disk replay.
                def assert_view(view):
                    users = [m for t in view['turns'] for m in t['messages']
                             if m.get('requestId') == identifier]
                    self.assertEqual(len(users), 1)
                    self.assertEqual(users[0]['text'], expected)
                    self.assertEqual(users[0]['requestId'], identifier)
                assert_view(chat.view())
                native = {'id': identifier, 'clientUserMessageId': identifier,
                          'type': 'steeringUserMessage' if status == 'active' else 'userMessage'}
                native['input' if status == 'active' else 'content'] = [{'type': 'text', 'text': raw}]
                self.assertEqual(normalize_item(native)['text'], expected)
                restored = thread_result()
                turn_id = chat.submissions[identifier]['turnId']
                existing = next((t for t in restored['thread']['turns'] if t['id'] == turn_id), None)
                if existing:
                    existing['items'].append(native)
                else:
                    restored['thread']['turns'].append({'id': turn_id, 'turnId': turn_id,
                        'status': 'completed', 'items': [native]})
                refreshed = Chat(bridge=chat.bridge, identifier=THREAD, result=restored,
                    backend=backend, entry=copy.deepcopy(records.records['threads'][THREAD]))
                assert_view(refreshed.view())
                # Display cleanup cannot change wire data, stored text or native identity.
                self.assertEqual(chat.submissions[identifier]['text'], raw)
                self.assertEqual(refreshed.submissions[identifier]['text'], raw)
                sent = next(params for method, params in backend.calls if method in ('turn/start', 'turn/steer'))
                self.assertEqual(sent['input'][0]['text'], raw)
                self.assertEqual(sent['clientUserMessageId'], identifier)

    def test_reply_display_preserves_invalid_and_ordinary_user_content(self):
        for text in ('普通回答 <标签>', '<send_user_message_question_reply>无效 JSON</send_user_message_question_reply>',
                     '<send_user_message_question_reply>[{"question":"有问题但无答案"}]</send_user_message_question_reply>',
                     '说明：<send_user_message_question_reply>[]</send_user_message_question_reply>'):
            self.assertEqual(user_display_text(text), text)
        raw = async_reply_text([{'id': QUESTION_ID, 'question': '问题一'}, {'id': 'two', 'question': '问题二'}],
                               {'answers': {QUESTION_ID: ['答案一'], 'two': ['答案二']}})
        self.assertEqual(user_display_text(raw), '问题：问题一\n回答：答案一\n\n问题：问题二\n回答：答案二')

    def test_unknown_reply_is_masked_and_never_resent_after_refresh(self):
        entry = {'title': '问题测试', 'cwd': '/tmp', 'runtime': 'web', 'model': 'model',
                 'effort': 'high', 'submissions': {}}
        backend = Backend(fail_unknown=True)
        bridge, bridge_state, chat, backend = self.fixture(entry=entry, backend=backend)
        first = bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['甲']}})
        self.assertEqual(first['status'], 'unknown')
        self.assertFalse(any(row['id'] == REQUEST for row in chat.view()['requests']))

        refreshed = Chat(bridge=chat.bridge, identifier=THREAD, result=thread_result(),
                         backend=backend, entry=copy.deepcopy(bridge_state.records['threads'][THREAD]))
        bridge.session = lambda _thread: refreshed
        duplicate = bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['甲']}})
        self.assertEqual(duplicate['status'], 'unknown')
        self.assertEqual(len([call for call in backend.calls if call[0] == 'turn/start']), 1)

    def test_answer_ids_and_each_answer_length_are_validated_before_send(self):
        bridge, _records, _chat, backend = self.fixture()
        for response in (
            {'answers': {}},
            {'answers': {QUESTION_ID: ['甲'], 'unexpected': ['乙']}},
            {'answers': {QUESTION_ID: ['甲']}, 'extra': True},
            {'answers': {QUESTION_ID: ['   ']}},
            {'answers': {QUESTION_ID: ['甲' * 20001]}},
        ):
            with self.subTest(response=response):
                with self.assertRaisesRegex(ValueError, '回答所有问题'):
                    bridge.respond(THREAD, REQUEST, response)
        self.assertFalse(any(method in ('turn/start', 'turn/steer') for method, _params in backend.calls))

    def test_explicit_retry_after_native_rejection_keeps_identity_and_accepts_corrected_answer(self):
        bridge, _records, chat, backend = self.fixture(backend=Backend(reject=True))
        with self.assertRaisesRegex(SideChatError, '明确拒绝'):
            bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['甲']}})
        identifier = async_submission_id(THREAD, REQUEST)
        self.assertEqual(chat.submissions[identifier]['status'], 'failed')
        self.assertTrue(any(row['id'] == REQUEST for row in chat.view()['requests']))
        # The owner may start another turn before the user explicitly retries.
        chat.state['threadRuntimeStatus']['type'] = 'active'
        chat.state['turns'][-1]['status'] = 'inProgress'
        result = bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['乙']}})
        self.assertEqual(result['status'], 'accepted')
        calls = [(method, params) for method, params in backend.calls if method.startswith('turn/')]
        self.assertEqual([method for method, _ in calls], ['turn/start', 'turn/steer'])
        self.assertEqual([params['clientUserMessageId'] for _, params in calls], [identifier, identifier])
        self.assertIn('乙', calls[-1][1]['input'][0]['text'])
        bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['乙']}})
        self.assertEqual(len(backend.calls), 2)

    def test_rejected_reply_cannot_be_retried_after_the_native_question_disappears(self):
        bridge, _records, chat, backend = self.fixture(backend=Backend(reject=True))
        with self.assertRaises(SideChatError):
            bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['甲']}})
        chat.state['turns'] = []
        with self.assertRaisesRegex(ValueError, '问题已结束'):
            bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: ['甲']}})
        self.assertEqual(len(backend.calls), 1)

    def test_20000_character_answer_survives_question_wrapper_overhead(self):
        bridge, _records, _chat, backend = self.fixture()
        answer = '甲' * 20000
        result = bridge.respond(THREAD, REQUEST, {'answers': {QUESTION_ID: [answer]}})
        self.assertEqual(result['status'], 'accepted')
        prompt = next(params['input'][0]['text'] for method, params in backend.calls
                      if method == 'turn/start')
        self.assertGreater(len(prompt), 20000)
        self.assertEqual(json.loads(prompt.split('\n', 1)[1].rsplit('\n', 1)[0])[0]['answer'], answer)
        # Only validated /respond replies get envelope headroom. A public send
        # cannot bypass its normal limit by copying the protocol wrapper.
        with self.assertRaises(ValueError):
            bridge.send(THREAD, prompt, str(uuid.uuid4()))


if __name__ == '__main__':
    unittest.main()
