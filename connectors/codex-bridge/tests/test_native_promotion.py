"""Transfer ownership, races, lost replies; no model/user data."""
import copy
import tempfile
import unittest
from unittest.mock import Mock
from test_shared_bridge import SharedBridgeTests
from bridge.clients.codex.native_queue import NativeQueue, operate
from bridge.clients.codex.native_promotion import promote, reconcile
from bridge.clients.codex.standalone import pending_submissions
from bridge.features.sessions.side_chat import SideChatError


class NativePromotionTests(unittest.TestCase):
    def fixture(self, root):
        bridge, chat, _ = SharedBridgeTests().fixture(root)
        item = {'id': 'native-q', 'clientUserMessageId': 'client-q', 'input': [
            {'type': 'text', 'text': '原始引导'}, {'type': 'skill', 'name': 'skill', 'path': '/synthetic/skill'}]}
        native = NativeQueue(Mock())
        items = [copy.deepcopy(item)]
        calls = []
        def request(method, params, timeout=30):
            calls.append((method, copy.deepcopy(params)))
            if method == 'thread/queue/list': return {'data': copy.deepcopy(items), 'nextCursor': None}
            if method == 'thread/queue/delete':
                exists = bool(items)
                items.clear()
                return {'deleted': exists}
            if method == 'thread/turns/list': return {'data': [{'id': 'turn', 'status': 'inProgress'}]}
            if method == 'turn/steer': return {'turnId': 'turn'}
            raise AssertionError(method)
        native.backend.request.side_effect = request
        bridge._native_queue = lambda _: native
        bridge._native_queue_items = lambda _: native.read(chat.id, fresh=True)
        return bridge, chat, native, item, calls, items, request

    def test_exact_native_input_and_identity_steer_once(self):
        with tempfile.TemporaryDirectory() as root:
            _, c, n, item, calls, _, _ = self.fixture(root)
            operate(c, {'type': 'promote_queued_message', 'token': item['id']}, n, [item])
            promote(c, item, n)  # repeated HTTP/click
            steer = [p for m, p in calls if m == 'turn/steer']
            self.assertEqual(len(steer), 1)
            self.assertEqual(steer[0]['input'], item['input'])
            self.assertEqual(steer[0]['clientUserMessageId'], item['clientUserMessageId'])
            self.assertEqual(steer[0]['expectedTurnId'], 'turn')
            self.assertEqual(pending_submissions(c.submissions), [])
            self.assertEqual(c.submissions['client-q']['status'], 'accepted')

    def test_lost_steer_reply_is_query_only_even_after_reconciliation(self):
        with tempfile.TemporaryDirectory() as root:
            b, c, n, item, calls, _, request = self.fixture(root)
            def lose(method, params, timeout=30):
                if method == 'turn/steer':
                    calls.append((method, params))
                    raise TimeoutError('lost reply')
                return request(method, params, timeout)
            n.backend.request.side_effect = lose
            promote(c, item, n)
            reconcile(c); reconcile(c)
            self.assertEqual(sum(m == 'turn/steer' for m, _ in calls), 1)
            self.assertEqual(pending_submissions(c.submissions)[0]['text'], '原始引导')
            b.history = Mock()
            b.history.confirmed_user_receipt.return_value = True
            reconcile(c)
            self.assertEqual(c.submissions['client-q']['status'], 'accepted')
            self.assertEqual(pending_submissions(c.submissions), [])

    def test_lost_delete_reply_never_steers_without_ownership_proof(self):
        with tempfile.TemporaryDirectory() as root:
            _, c, n, item, calls, _, request = self.fixture(root)
            def lose(method, params, timeout=30):
                result = request(method, params, timeout)
                if method == 'thread/queue/delete': raise TimeoutError('lost delete reply')
                return result
            n.backend.request.side_effect = lose
            with self.assertRaises(TimeoutError): promote(c, item, n)
            reconcile(c)
            self.assertFalse(any(m == 'turn/steer' for m, _ in calls))
            self.assertEqual(c.submissions['client-q']['nativeQueueInput'], item['input'])

    def test_delete_race_consumed_elsewhere_never_replays(self):
        with tempfile.TemporaryDirectory() as root:
            _, c, n, item, calls, items, request = self.fixture(root)
            def race(method, params, timeout=30):
                if method == 'thread/queue/delete': items.clear()
                return request(method, params, timeout)
            n.backend.request.side_effect = race
            promote(c, item, n)
            self.assertFalse(any(m == 'turn/steer' for m, _ in calls))

    def test_active_turn_ends_restores_exact_input_to_single_native_owner(self):
        with tempfile.TemporaryDirectory() as root:
            _, c, n, item, calls, _, request = self.fixture(root)
            def ended(method, params, timeout=30):
                if method == 'thread/turns/list': return {'data': []}
                if method == 'thread/queue/add':
                    calls.append((method, params)); return {'queuedSubmission': {**item, 'id': 'restored'}}
                return request(method, params, timeout)
            n.backend.request.side_effect = ended
            promote(c, item, n)
            adds = [p for m, p in calls if m == 'thread/queue/add']
            self.assertEqual(len(adds), 1)
            self.assertEqual(adds[0]['input'], item['input'])
            self.assertEqual(c.submissions['client-q']['nativeQueueId'], 'restored')
            self.assertEqual(pending_submissions(c.submissions), [])

    def test_restored_new_queue_id_is_a_new_promote_action_not_a_duplicate(self):
        with tempfile.TemporaryDirectory() as root:
            _, c, n, item, calls, items, request = self.fixture(root)
            def ended(method, params, timeout=30):
                if method == 'thread/turns/list': return {'data': []}
                if method == 'thread/queue/add': return {'queuedSubmission': {**item, 'id': 'restored'}}
                return request(method, params, timeout)
            n.backend.request.side_effect = ended
            promote(c, item, n)
            restored = {**item, 'id': 'restored'}
            items.append(restored)
            n.backend.request.side_effect = request
            promote(c, restored, n)
            self.assertEqual(sum(m == 'thread/queue/delete' for m, _ in calls), 2)
            self.assertEqual(sum(m == 'turn/steer' for m, _ in calls), 1)
            self.assertEqual(c.submissions['client-q']['status'], 'accepted')

    def test_explicit_steer_rejection_restores_queue_not_replays_steer(self):
        with tempfile.TemporaryDirectory() as root:
            _, c, n, item, calls, _, request = self.fixture(root)
            def reject(method, params, timeout=30):
                if method == 'turn/steer':
                    calls.append((method, params)); error = SideChatError('turn ended'); error.rpc_error = {'code': -32600}; raise error
                if method == 'thread/queue/add':
                    calls.append((method, params)); return {'queuedSubmission': {**item, 'id': 'restored'}}
                return request(method, params, timeout)
            n.backend.request.side_effect = reject
            promote(c, item, n); reconcile(c)
            self.assertEqual(sum(m == 'turn/steer' for m, _ in calls), 1)
            self.assertEqual(sum(m == 'thread/queue/add' for m, _ in calls), 1)

if __name__ == '__main__': unittest.main()
