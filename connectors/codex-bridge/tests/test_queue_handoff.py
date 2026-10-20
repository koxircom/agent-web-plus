"""RPC acknowledgement and native events are independent transports.

Use two durable queued requests and the actual Chat/Timeline projection. Never
connect to a user runtime or send to a model.
"""
import copy
import tempfile
import unittest
import test_shared_bridge as fixture
ID = fixture.ID
from bridge.clients.codex.standalone import Chat
from bridge.features.sessions.side_chat import SideChatError, SideChat


class QueueHandoffTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.bridge, self.chat, self.backend = fixture.SharedBridgeTests().fixture(self.root.name)
        self.bridge.session = lambda *a, **kw: self.chat
        self.bridge._annotate_upload_attachments = lambda *a: None
        self.backend.status = 'active'
        for token in ('01901234-5678-7000-8000-000000000011', '01901234-5678-7000-8000-000000000012'):
            # Compatibility for already-accepted pre-native-queue ledger rows.
            SideChat.send(self.chat, '相同的排队内容', token, mode='queue', client_request_id='client-request-' + token)
            self.chat.persist()
        self.backend.status = 'idle'
        original = self.backend.request
        self.starts = []
        def request(method, params, timeout=30):
            if method == 'turn/start':
                self.starts.append(params['clientUserMessageId'])
                return {'turn': {'id': 'turn-' + params['clientUserMessageId'], 'status': 'inProgress', 'items': []}}
            return original(method, params, timeout)
        self.backend.request = request

    def page(self):
        return self.bridge.timeline_read(ID, limit=100)

    def dispatch(self, token):
        self.backend.status = 'idle'
        with self.chat.actions:
            return self.chat._dispatch(token, self.chat.submissions[token])

    def echo(self, token, complete=False):
        turn_id = 'turn-' + token
        self.chat._event({'method': 'turn/started', 'params': {'threadId': ID, 'turn': {'id': turn_id, 'status': 'inProgress'}}})
        self.chat._event({'method': 'item/started', 'params': {'threadId': ID, 'turnId': turn_id, 'item': {'id': 'native-' + token, 'type': 'userMessage', 'clientId': token, 'content': [{'type': 'text', 'text': '相同的排队内容'}]}}})
        if complete:
            self.chat._event({'method': 'turn/completed', 'params': {'threadId': ID, 'turn': {'id': turn_id, 'status': 'completed'}}})

    def assert_representation(self, page, delivered, queued):
        users = [r for r in page['rows'] if r['role'] == 'user']
        self.assertEqual([r.get('requestId') for r in users], ['client-request-' + t for t in delivered])
        self.assertEqual([r['id'] for r in page['meta']['submissions']], queued)
        self.assertEqual(len(users) + len(page['meta']['submissions']), len(delivered) + len(queued))

    def test_two_acknowledgements_precede_native_user_events(self):
        self.assert_representation(self.page(), [], ['01901234-5678-7000-8000-000000000011', '01901234-5678-7000-8000-000000000012'])
        self.dispatch('01901234-5678-7000-8000-000000000011')
        accepted = self.page()
        self.assert_representation(accepted, ['01901234-5678-7000-8000-000000000011'], ['01901234-5678-7000-8000-000000000012'])
        self.assertIs(accepted['rows'][0]['deliveryConfirmed'], False)
        self.assertEqual(accepted['meta']['submissions'][0]['clientRequestId'], 'client-request-01901234-5678-7000-8000-000000000012')
        first_version = accepted['rows'][0]['version']
        first_key = accepted['rows'][0]['key']
        self.echo('01901234-5678-7000-8000-000000000011', complete=True)
        echoed = self.page()
        self.assert_representation(echoed, ['01901234-5678-7000-8000-000000000011'], ['01901234-5678-7000-8000-000000000012'])
        self.assertIs(echoed['rows'][0]['deliveryConfirmed'], True)
        self.assertNotEqual(echoed['rows'][0]['version'], first_version)
        self.assertEqual(echoed['rows'][0]['key'], first_key, 'native echo must not replace the message identity')
        self.dispatch('01901234-5678-7000-8000-000000000012')
        self.assert_representation(self.page(), ['01901234-5678-7000-8000-000000000011', '01901234-5678-7000-8000-000000000012'], [])
        self.echo('01901234-5678-7000-8000-000000000012', complete=True)
        self.assert_representation(self.page(), ['01901234-5678-7000-8000-000000000011', '01901234-5678-7000-8000-000000000012'], [])
        self.assertEqual(self.starts, ['01901234-5678-7000-8000-000000000011', '01901234-5678-7000-8000-000000000012'])

    def test_restart_before_native_echo_keeps_accepted_input_without_replay(self):
        self.dispatch('01901234-5678-7000-8000-000000000011')
        entry = copy.deepcopy(self.bridge.records['threads'][ID])
        self.chat = Chat(self.bridge, ID, {'thread': {'id': ID, 'cwd': self.root.name, 'turns': [], 'status': {'type': 'active'}}}, self.backend, entry)
        self.assert_representation(self.page(), ['01901234-5678-7000-8000-000000000011'], ['01901234-5678-7000-8000-000000000012'])
        self.assertEqual(self.starts, ['01901234-5678-7000-8000-000000000011'])

    def test_echo_before_acknowledgement_and_duplicate_events_stay_single(self):
        original = self.backend.request
        def request(method, params, timeout=30):
            if method == 'turn/start':
                self.echo(params['clientUserMessageId'], complete=True)
            return original(method, params, timeout)
        self.backend.request = request
        self.dispatch('01901234-5678-7000-8000-000000000011')
        self.echo('01901234-5678-7000-8000-000000000011', complete=True)
        self.assert_representation(self.page(), ['01901234-5678-7000-8000-000000000011'], ['01901234-5678-7000-8000-000000000012'])

    def test_explicit_removal_does_not_materialize_a_message(self):
        self.chat.cancel_queued('01901234-5678-7000-8000-000000000012')
        self.dispatch('01901234-5678-7000-8000-000000000011')
        self.assert_representation(self.page(), ['01901234-5678-7000-8000-000000000011'], [])
        self.assertEqual(self.chat.submissions['01901234-5678-7000-8000-000000000012']['status'], 'cancelled')

    def test_live_ack_native_echo_and_offline_history_keep_one_entry_key(self):
        from types import SimpleNamespace
        from bridge.features.sessions.timeline import Timeline
        import threading
        token = '01901234-5678-7000-8000-000000000011'
        self.dispatch(token)
        key = self.page()['rows'][0]['key']
        self.echo(token, complete=True)
        self.assertEqual(self.page()['rows'][0]['key'], key)
        self.chat.persist()
        saved = SimpleNamespace(condition=threading.RLock(), submissions={}, timeline=Timeline(), sequence=1,
            view=lambda **_options: {'id': ID, 'sequence': 1, 'turns': [{'id': 'turn-' + token,
                'status': 'completed', 'messages': [{'id': 'offline-native-id', 'role': 'user',
                'kind': 'userMessage', 'text': '相同的排队内容'}]}]})
        self.bridge.session = lambda *a, **kw: saved
        self.assertEqual(self.page()['rows'][0]['key'], key)
        self.assertNotIn('handoffTurn', self.bridge.records['threads'][ID]['submissions'][token])

    def test_unknown_acknowledgement_never_claims_delivery_or_replays(self):
        original = self.backend.request
        def request(method, params, timeout=30):
            if method == 'turn/start':
                raise SideChatError('模拟传输结果未知')
            return original(method, params, timeout)
        self.backend.request = request
        self.assertEqual(self.dispatch('01901234-5678-7000-8000-000000000011')['status'], 'unknown')
        page = self.page()
        self.assertEqual(page['rows'], [])
        self.assertEqual([r['status'] for r in page['meta']['submissions']], ['unknown', 'queued'])


if __name__ == '__main__':
    unittest.main()
