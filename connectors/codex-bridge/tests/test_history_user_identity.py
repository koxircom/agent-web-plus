"""Saved user receipts must keep the live native identity, never text-dedupe."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.wsl_history import WslHistory
from bridge.features.sessions.model import normalize_state
from bridge.features.sessions.timeline import Timeline


class HistoryUserIdentityTests(unittest.TestCase):
    def saved(self, root, records, limit=None):
        home = Path(root) / 'home'
        path = home / 'sessions' / 'rollout.jsonl'
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(json.dumps(r) + '\n' for r in records))
        store = WslHistory(home, [{'key': 'fixture', 'path': root}])
        return store._history('fixture', {'rollout_path': str(path), 'cwd': root}, limit)

    @staticmethod
    def response(identifier, text='同一段文字'):
        return {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'id': identifier,
                'content': [{'type': 'input_text', 'text': text}]}}

    @staticmethod
    def receipt(identifier, client=None, turn='t'):
        return {'type': 'event_msg', 'payload': {'type': 'item_completed', 'turn_id': turn,
                'item': {'type': 'UserMessage', 'id': identifier, 'client_id': client,
                         'content': [{'type': 'text', 'text': '同一段文字'}]}}}

    def test_live_completion_reload_and_paging_keep_one_user_entry(self):
        with tempfile.TemporaryDirectory() as root:
            records = [{'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 't'}},
                       self.response('stored-msg'), self.receipt('native-user', 'client-a'),
                       {'type': 'event_msg', 'payload': {'type': 'task_complete'}}]
            timeline = Timeline()
            live = {'id': 'fixture', 'turns': [{'turnId': 't', 'status': 'inProgress', 'items': [
                {'id': 'native-user', 'type': 'userMessage', 'clientId': 'client-a',
                 'content': [{'type': 'text', 'text': '同一段文字'}]}]}]}
            timeline.update({**normalize_state(live), 'sequence': 1})
            key = timeline.rows[0]['key']
            for sequence, limit in enumerate([1, None], 2):
                saved = self.saved(root, records, limit)
                timeline.update({**normalize_state(saved), 'sequence': sequence})
                self.assertEqual([r['key'] for r in timeline.rows if r['role'] == 'user'], [key])
                self.assertEqual(saved['turns'][0]['items'][0]['id'], 'native-user')
                self.assertEqual(saved['turns'][0]['items'][0]['clientId'], 'client-a')

    def test_two_identical_sends_stay_distinct_and_duplicate_receipt_is_ignored(self):
        with tempfile.TemporaryDirectory() as root:
            saved = self.saved(root, [{'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 't'}},
                self.response('msg-a'), self.receipt('native-a', 'client-a'), self.receipt('native-a', 'client-a'),
                self.response('msg-b'), self.receipt('native-b', 'client-b')])
            timeline = Timeline(); timeline.update({**normalize_state(saved), 'sequence': 1})
            self.assertEqual(len(timeline.rows), 2)
            self.assertNotEqual(timeline.rows[0]['key'], timeline.rows[1]['key'])
            self.assertEqual([r['requestId'] for r in timeline.rows], ['client-a', 'client-b'])

    def test_runtime_environment_record_is_not_a_second_user_input(self):
        with tempfile.TemporaryDirectory() as root:
            context='<environment_context>\n<current_date>2026-10-19</current_date>\n<timezone>Asia/Hong_Kong</timezone>\n<filesystem><workspace_roots /></filesystem>\n</environment_context>'
            records=[{'type':'event_msg','payload':{'type':'task_started','turn_id':'t'}},
                     self.response('environment',context),self.response('stored-msg'),self.receipt('native-user','client-a')]
            saved=self.saved(root,records)
            users=[i for i in saved['turns'][0]['items'] if i['type']=='userMessage']
            self.assertEqual([i['id'] for i in users],['native-user'])
            store=WslHistory(Path(root)/'home',[{'path':root}])
            self.assertEqual(store._count_user_messages(Path(root)/'home/sessions/rollout.jsonl'),1)

    def test_literal_environment_sent_by_user_is_kept_by_native_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            context='<environment_context><current_date>2026-10-19</current_date><timezone>Asia/Hong_Kong</timezone><filesystem /></environment_context>'
            receipt=self.receipt('literal-native','literal-client');receipt['payload']['item']['content']=[{'type':'text','text':context}]
            saved=self.saved(root,[{'type':'event_msg','payload':{'type':'task_started','turn_id':'t'}},self.response('literal',context),receipt])
            self.assertEqual(saved['turns'][0]['items'][0]['clientId'],'literal-client')
            store=WslHistory(Path(root)/'home',[{'path':root}]);self.assertEqual(store._count_user_messages(Path(root)/'home/sessions/rollout.jsonl'),1)

    def test_primary_ledger_matches_native_client_identity_instead_of_first_user(self):
        import tempfile
        from test_shared_bridge import SharedBridgeTests
        with tempfile.TemporaryDirectory() as root:
            bridge,chat,_=SharedBridgeTests().fixture(root)
            chat.state['turns']=[{'turnId':'t','status':'completed','items':[
                {'id':'other','type':'userMessage','clientId':'other-client','content':[{'type':'text','text':'另一条真实消息'}]},
                {'id':'actual','type':'userMessage','clientId':'own-client','content':[{'type':'text','text':'当前真实提问'}]}]}]
            chat.submissions={'own-client':{'turnId':'t','mode':'send','status':'accepted','text':'当前真实提问','clientRequestId':'web-client'}}
            messages=chat.view()['turns'][0]['messages']
            self.assertEqual([m['text'] for m in messages],['另一条真实消息','当前真实提问'])
            self.assertEqual([m.get('requestId') for m in messages],['other-client','own-client'])

    def test_legacy_without_native_receipts_preserves_record_id_and_contents(self):
        with tempfile.TemporaryDirectory() as root:
            saved = self.saved(root, [self.response('legacy-a'), self.response('legacy-b')])
            self.assertEqual([i['id'] for i in saved['turns'][0]['items']], ['legacy-a', 'legacy-b'])

    def test_foreign_turn_receipt_cannot_relabel_a_user_message(self):
        with tempfile.TemporaryDirectory() as root:
            saved = self.saved(root, [{'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 't'}},
                self.response('own-message'), self.receipt('foreign', 'foreign-client', turn='elsewhere')])
            self.assertEqual(saved['turns'][0]['items'][0]['id'], 'own-message')
            self.assertNotIn('clientId', saved['turns'][0]['items'][0])


if __name__ == '__main__':
    unittest.main()
