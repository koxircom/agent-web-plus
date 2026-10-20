import sys,threading,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import Chat
class CompletedTurnTests(unittest.TestCase):
 def test_authoritative_completed_tools_are_loaded_once_outside_event_lock(self):
  chat=Chat.__new__(Chat);chat.id='test';chat.lock=threading.RLock();chat.condition=threading.Condition(chat.lock);chat.completed_reads={'done','active'};chat.sequence=0;chat.shared=False
  chat.state={'turns':[{'turnId':'done','status':'completed','items':[]},{'turnId':'active','status':'inProgress','items':[{'id':'live'}]}]}
  class Backend:
   def request(self,method,params):
    assert not chat.lock._is_owned();assert method=='thread/read';assert params=={'threadId':'test','includeTurns':True}
    return {'thread':{'turns':[{'id':'done','items':[{'id':'actual-tool','type':'commandExecution'}]},{'id':'active','items':[]}]}}
  chat.backend=Backend();chat._refresh_completed()
  self.assertEqual(chat.state['turns'][0]['items'][0]['id'],'actual-tool');self.assertEqual(chat.state['turns'][1]['items'][0]['id'],'live')
  self.assertEqual(chat.completed_reads,{'active'});chat.completed_reads.clear()
  chat.backend=None;chat._refresh_completed();self.assertEqual(chat.completed_reads,set())
 def test_connector_never_hardcodes_full_access_or_never_approval_for_new_sessions(self):
  source=Path(__file__).resolve().parents[1]/'bridge/clients/codex/standalone.py';text=source.read_text()
  self.assertNotIn("'sandbox': 'danger-full-access'",text);self.assertNotIn("'approvalPolicy': 'never'",text)

class SharedCompletionTests(unittest.TestCase):
 def fixture(self):
  import copy
  from types import SimpleNamespace
  chat=Chat.__new__(Chat);chat.id='test';chat.lock=threading.RLock();chat.condition=threading.Condition(chat.lock);chat.completed_reads={'done'};chat.sequence=0;chat.shared=True;chat.history_limit=1
  final={'id':'final','type':'agentMessage','text':'最终结果','phase':'final_answer'}
  chat.state={'turns':[{'turnId':'done','status':'completed','items':[final]}]}
  calls=[]
  class Backend:
   def request(self,method,params):
    self.assert_unlocked=not chat.lock._is_owned();calls.append((method,params));return {'data':[{'id':'done','status':'completed','items':[copy.deepcopy(final),{'id':'tool','type':'commandExecution'}]}]}
  chat.backend=Backend()
  stale=SimpleNamespace(condition=threading.Condition(),state={'turns':[{'turnId':'done','status':'completed','items':[]}]})
  chat.bridge=SimpleNamespace(history=SimpleNamespace(session=lambda *a,**kw:stale))
  return chat,calls,final

 def test_stale_rollout_cannot_erase_observed_final_answer(self):
  chat,calls,final=self.fixture();chat._refresh_completed()
  self.assertIn(final,chat.state['turns'][0]['items'])
  self.assertEqual(calls[0][0],'thread/turns/list')
  self.assertEqual(chat.completed_reads,set())

 def test_missing_final_event_is_backfilled_from_native_turn_without_refresh(self):
  chat,calls,final=self.fixture();chat.state['turns'][0]['items']=[];chat._refresh_completed()
  self.assertIn(final,chat.state['turns'][0]['items']);self.assertEqual(chat.sequence,1)
  chat._refresh_completed();self.assertEqual(len(calls),1)

 def test_failed_completion_read_remains_pending_and_does_not_erase_messages(self):
  chat,_,final=self.fixture()
  def fail(*args):raise OSError('temporary transport failure')
  chat.backend.request=fail
  with self.assertRaises(OSError):chat._refresh_completed()
  self.assertEqual(chat.completed_reads,{'done'});self.assertIn(final,chat.state['turns'][0]['items'])

 def test_sparse_native_snapshot_keeps_observed_items_and_active_turn(self):
  chat,_,final=self.fixture();chat.state['turns'].append({'turnId':'new','status':'inProgress','items':[{'id':'live'}]})
  chat.backend.request=lambda *a:{'data':[{'id':'done','status':'completed','items':[]}]}
  chat._refresh_completed();self.assertIn(final,chat.state['turns'][0]['items']);self.assertEqual(chat.state['turns'][1]['items'],[{'id':'live'}])

if __name__=='__main__':unittest.main()
