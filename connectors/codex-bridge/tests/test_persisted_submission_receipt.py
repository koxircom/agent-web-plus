"""Exact saved identity survives long tool tails, weak responses and restart."""
import json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from bridge.features.sessions.store import SessionStore
from bridge.clients.codex.standalone import StandaloneBridge

class PersistedReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name);(self.home/'sessions').mkdir();self.path=self.home/'sessions'/'rollout.jsonl'
        self.path.touch();self.store=SessionStore(self.home);self.store.get=lambda sid:{'rollout_path':str(self.path)}
    def append(self, client='submission-A', kind='UserMessage', complete=True):
        row={'type':'event_msg','payload':{'type':'item_completed','item':{'type':kind,'id':'native-user','client_id':client}}}
        with self.path.open('ab') as f:f.write(json.dumps(row).encode()+(b'\n' if complete else b''))
    def test_late_append_partial_and_same_text_never_count_as_receipt(self):
        self.path.write_text(json.dumps({'type':'response_item','payload':{'type':'message','role':'user','client_id':'submission-A','content':'same text'}})+'\n')
        self.assertFalse(self.store.confirmed_user_receipt('thread','submission-A'))
        self.append(kind='AgentMessage');self.append(client='submission-B')
        self.assertFalse(self.store.confirmed_user_receipt('thread','submission-A'))
        self.append(complete=False)
        self.assertFalse(self.store.confirmed_user_receipt('thread','submission-A'))
        with self.path.open('ab') as f:f.write(b'\n')
        self.assertTrue(self.store.confirmed_user_receipt('thread','submission-A'))
    def test_old_receipt_is_found_without_reading_full_transcript_into_memory(self):
        self.append()
        with self.path.open('ab') as f:
            for i in range(180):f.write(json.dumps({'type':'response_item','payload':{'type':'custom_tool_call_output','output':'tool '+str(i)}}).encode()+b'\n')
        fresh=SessionStore(self.home);fresh.get=self.store.get
        self.assertTrue(fresh.confirmed_user_receipt('thread','submission-A'))
        self.assertFalse(fresh.confirmed_user_receipt('thread','submission-other'))
        self.path.write_text('{}\n')
        self.assertFalse(fresh.confirmed_user_receipt('thread','submission-A'))
    def test_path_must_be_in_original_codex_home(self):
        self.store.get=lambda sid:{'rollout_path':'/etc/passwd'}
        with self.assertRaises(ValueError):self.store.confirmed_user_receipt('thread','submission-A')

    def test_gateway_checks_exact_native_id_without_attaching_runtime(self):
        from unittest.mock import Mock
        sid='01901234-5678-7000-8000-000000000001'
        token='01901234-5678-7000-8000-000000000002'
        history=SimpleNamespace(confirmed_user_receipt=Mock(return_value=True))
        bridge=SimpleNamespace(_record=lambda identifier:{'submissions':{token:{'status':'accepted'}}},live={},history=history)
        result=StandaloneBridge.submission_receipt(bridge,sid,token)
        self.assertTrue(result['deliveryConfirmed']);history.confirmed_user_receipt.assert_called_once_with(sid,token)
        history.confirmed_user_receipt.reset_mock()
        for status in ['queued','cancelled','recalled','failed']:
            bridge._record=lambda identifier,status=status:{'submissions':{token:{'status':status}}}
            self.assertFalse(StandaloneBridge.submission_receipt(bridge,sid,token)['deliveryConfirmed'])
        history.confirmed_user_receipt.assert_not_called()

    def test_web_receipt_uses_its_own_home_and_unavailable_history_keeps_original(self):
        from unittest.mock import Mock
        sid='01901234-5678-7000-8000-000000000001';token='01901234-5678-7000-8000-000000000002'
        original=SimpleNamespace(confirmed_user_receipt=Mock(side_effect=AssertionError('wrong home')))
        web=SimpleNamespace(confirmed_user_receipt=Mock(return_value=True))
        bridge=SimpleNamespace(_record=lambda _: {'runtime':'web','submissions':{token:{'status':'accepted'}}},live={},history=original,web_history=web)
        self.assertTrue(StandaloneBridge.submission_receipt(bridge,sid,token)['deliveryConfirmed'])
        original.confirmed_user_receipt.assert_not_called()
        for error in [KeyError('not indexed yet'),FileNotFoundError('not saved yet')]:
            web.confirmed_user_receipt.side_effect=error
            result=StandaloneBridge.submission_receipt(bridge,sid,token)
            self.assertEqual(result['status'],'accepted');self.assertFalse(result['deliveryConfirmed'])

    def test_live_catalog_lock_does_not_break_read_only_receipt(self):
        import threading
        sid='01901234-5678-7000-8000-000000000001';token='01901234-5678-7000-8000-000000000002'
        live=SimpleNamespace(lock=threading.RLock(),submissions={token:{'status':'accepted','catalog':threading.Lock()}})
        bridge=SimpleNamespace(_record=lambda _: {'runtime':'history','submissions':{}},live={sid:live},history=SimpleNamespace(confirmed_user_receipt=lambda *_:True))
        result=StandaloneBridge.submission_receipt(bridge,sid,token)
        self.assertEqual(result,{'id':token,'status':'accepted','deliveryConfirmed':True,
                                 'nativeQueueConfirmed':False,'nativeQueueRejected':False})

if __name__=='__main__':unittest.main()
