import sys,threading,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import Chat
class CompletedTurnTests(unittest.TestCase):
 def test_authoritative_completed_tools_are_loaded_once_outside_event_lock(self):
  from types import SimpleNamespace
  chat=Chat.__new__(Chat);chat.id='test';chat.lock=threading.RLock();chat.condition=threading.Condition(chat.lock);chat.completed_reads={'done','active'};chat.sequence=0;chat.shared=False
  chat.pending_completions={};chat.shared_requests={};chat.submissions={};chat.ready=True;chat.closed=False
  chat.queue_event=threading.Event();chat.persist=lambda *a,**k:None
  chat.state={'turns':[{'turnId':'done','status':'completed','items':[]},{'turnId':'active','status':'inProgress','items':[{'id':'live'}]}],'threadRuntimeStatus':{'type':'idle'},'requests':[]}
  class Backend:
   process=SimpleNamespace(poll=lambda:None)
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
  chat.pending_completions={};chat.shared_requests={};chat.submissions={};chat.ready=True;chat.closed=False
  chat.actions=threading.RLock();chat.queue_event=threading.Event()
  chat.persist=lambda *a,**k:None;chat._release_handoff_turns=lambda:None
  final={'id':'final','type':'agentMessage','text':'最终结果','phase':'final_answer'}
  chat.state={'id':'test','cwd':'/tmp/test','turns':[{'turnId':'done','status':'completed','items':[final]}],'requests':[],'threadRuntimeStatus':{'type':'idle'}}
  calls=[]
  class Backend:
   process=SimpleNamespace(poll=lambda:None)
   def request(self,method,params,timeout=30):
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

 def test_completed_snapshot_without_terminal_answer_is_retried_until_answer_arrives(self):
  chat,calls,final=self.fixture();chat.state['turns'][0]['items']=[]
  snapshots=[
   {'data':[{'id':'done','status':'completed','items':[{'id':'tool','type':'commandExecution'}]}]},
   {'data':[{'id':'done','status':'completed','items':[{'id':'tool','type':'commandExecution'},final]}]},
  ]
  chat.backend.request=lambda *args:snapshots.pop(0)
  chat._refresh_completed()
  self.assertEqual(chat.completed_reads,{'done'})
  self.assertEqual([item['id'] for item in chat.state['turns'][0]['items']],['tool'])
  chat._refresh_completed()
  self.assertEqual(chat.completed_reads,set())
  self.assertEqual([item['id'] for item in chat.state['turns'][0]['items']],['tool','final'])

 def test_failed_or_interrupted_turn_does_not_wait_for_an_answer(self):
  for status in ('failed','interrupted'):
   with self.subTest(status=status):
    chat,_,_=self.fixture();chat.state['turns'][0]['items']=[]
    chat.backend.request=lambda *args:{'data':[{'id':'done','status':status,'items':[]}]}
    chat._refresh_completed()
    self.assertEqual(chat.completed_reads,set())

 def test_sparse_native_snapshot_keeps_observed_items_and_active_turn(self):
  chat,_,final=self.fixture();chat.state['turns'].append({'turnId':'new','status':'inProgress','items':[{'id':'live'}]})
  chat.backend.request=lambda *a:{'data':[{'id':'done','status':'completed','items':[]}]}
  chat._refresh_completed();self.assertIn(final,chat.state['turns'][0]['items']);self.assertEqual(chat.state['turns'][1]['items'],[{'id':'live'}])

 def test_sparse_completion_keeps_steering_between_opening_and_final(self):
  chat,_,final=self.fixture()
  opening={'id':'opening','type':'userMessage','content':[{'type':'text','text':'原始请求'}]}
  quote={'id':'quote','type':'userMessage','clientId':'quoted-request','content':[{'type':'text','text':'> 引用：请先上线'}]}
  tool={'id':'observed-tool','type':'commandExecution'}
  chat.state['turns'][0]['items']=[opening,tool,quote,final]
  fresh={**final,'text':'完整最终结果'}
  chat.backend.request=lambda *a:{'data':[{'id':'done','status':'completed','items':[opening,fresh]}]}
  chat._refresh_completed()
  items=chat.state['turns'][0]['items']
  self.assertEqual([i['id'] for i in items],['opening','observed-tool','quote','final'])
  self.assertEqual(items[-1]['text'],'完整最终结果')

 def test_completion_notification_preserves_steering_before_new_final(self):
  from bridge.features.sessions.side_chat import SideChat
  chat,_,final=self.fixture();chat.closed=False;chat.ready=True
  chat.state['requests']=[];chat.state['threadRuntimeStatus']={'type':'active'};chat.queue_event=threading.Event()
  opening={'id':'opening','type':'userMessage'}
  quote={'id':'quote','type':'userMessage','clientId':'quoted-request'}
  chat.state['turns'][0].update(status='inProgress',items=[opening,quote])
  SideChat._event(chat,{'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[opening,final]}}})
  self.assertEqual([i['id'] for i in chat.state['turns'][0]['items']],['opening','quote','final'])

 def test_no_common_snapshot_ids_keeps_observed_prefix_and_identical_sends(self):
  chat,_,final=self.fixture()
  users=[{'id':key,'type':'userMessage','clientId':key,'content':[{'type':'text','text':'同文消息'}]} for key in ['first','second']]
  chat.state['turns'][0]['items']=users
  chat.backend.request=lambda *a:{'data':[{'id':'done','status':'completed','items':[final]}]}
  chat._refresh_completed()
  self.assertEqual([i['id'] for i in chat.state['turns'][0]['items']],['first','second','final'])

 def test_completion_without_final_stays_active_and_subsequent_item_commits_atomically(self):
  chat,_,final=self.fixture();chat.closed=False;chat.ready=True
  chat.queue_event=threading.Event();chat.state['requests']=[]
  chat.state['threadRuntimeStatus']={'type':'active'}
  tool={'id':'tool','type':'commandExecution'}
  chat.state['turns'][0].update(status='inProgress',items=[tool])
  # 收到 turn/completed 但 items 只有 tool，无 final
  chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[tool]}}})
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'active')
  self.assertEqual(chat.state['turns'][0]['status'],'inProgress')
  self.assertIn('done',chat.completed_reads)
  # 紧接着真实 final item 到达
  chat._event({'method':'item/completed','params':{'threadId':'test','turnId':'done','item':final}})
  self.assertEqual(chat.state['turns'][0]['status'],'completed')
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'idle')
  self.assertEqual(chat.completed_reads,set())
  self.assertIn({**final,'_completed':True},chat.state['turns'][0]['items'])
  self.assertNotIn('_completed',final)

 def test_completion_without_final_commits_atomically_on_authoritative_snapshot(self):
  chat,calls,final=self.fixture();chat.closed=False;chat.ready=True
  chat.queue_event=threading.Event();chat.state['requests']=[]
  chat.state['threadRuntimeStatus']={'type':'active'}
  tool={'id':'tool','type':'commandExecution'}
  chat.state['turns'][0].update(status='inProgress',items=[tool])
  chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[tool]}}})
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'active')
  self.assertEqual(chat.state['turns'][0]['status'],'inProgress')
  # 模拟权威快照回读到齐
  snapshots=[
   {'data':[{'id':'done','status':'completed','items':[tool,final]}]}
  ]
  chat.backend.request=lambda *args:snapshots.pop(0)
  chat._refresh_completed()
  self.assertEqual(chat.state['turns'][0]['status'],'completed')
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'idle')
  self.assertEqual(chat.completed_reads,set())
  self.assertEqual([i['id'] for i in chat.state['turns'][0]['items']],['tool','final'])

 def test_interrupted_or_failed_turn_commits_immediately_without_final(self):
  for status in ('interrupted','failed'):
   with self.subTest(status=status):
    chat,_,_=self.fixture();chat.closed=False;chat.ready=True
    chat.queue_event=threading.Event();chat.state['requests']=[]
    chat.state['threadRuntimeStatus']={'type':'active'}
    chat.state['turns'][0].update(status='inProgress',items=[])
    chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':status,'items':[]}}})
    self.assertEqual(chat.state['turns'][0]['status'],status)
    self.assertEqual(chat.state['threadRuntimeStatus']['type'],'idle')
    self.assertEqual(chat.completed_reads,set())

 def test_snapshot_reorders_shared_anchors_and_updates_them_without_mutating_inputs(self):
  import copy
  from bridge.features.sessions.model import merge_turn_items
  observed=[{'id':'a','text':'old'},{'id':'quote'},{'id':'b'},{'id':'tail'}]
  snapshot=[{'id':'b','text':'fresh'},{'id':'new'},{'id':'a','text':'fresh'}]
  before=copy.deepcopy([observed,snapshot])
  result=merge_turn_items(snapshot,observed)
  self.assertEqual([i['id'] for i in result],['b','tail','new','a','quote'])
  self.assertEqual(result[0]['text'],'fresh')
  result[0]['text']='changed'
  self.assertEqual([observed,snapshot],before)

 def test_foreign_or_closed_turn_completed_is_ignored_and_never_creates_none_turn(self):
  chat,_,final=self.fixture();chat.closed=False;chat.ready=True
  chat.state['turns'][0].update(status='inProgress',items=[])
  # 1. 外部线程的 turn/completed 事件，params.threadId 不一致
  chat._event({'method':'turn/completed','params':{'threadId':'other-thread','turn':{'id':'other-turn','status':'completed','items':[]}}})
  self.assertEqual(len(chat.state['turns']),1)
  self.assertEqual(chat.state['turns'][0]['turnId'],'done')
  self.assertNotIn(None,[t.get('turnId') for t in chat.state['turns']])

  # 2. 空 turnId 或缺 threadId，绝不创建 Turn(None)
  chat._event({'method':'turn/completed','params':{'turn':{'status':'completed'}}})
  self.assertEqual(len(chat.state['turns']),1)
  self.assertNotIn(None,[t.get('turnId') for t in chat.state['turns']])

  # 3. chat closed 时收到事件被忽略
  chat.closed=True
  chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[final]}}})
  self.assertEqual(chat.state['turns'][0]['status'],'inProgress')

 def test_item_started_does_not_settle_completion_until_item_completed(self):
  chat,_,final=self.fixture();chat.closed=False;chat.ready=True
  chat.state['threadRuntimeStatus']={'type':'active'}
  chat.state['turns'][0].update(status='inProgress',items=[])
  # 1. turn/completed 先到，但无 items
  chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[]}}})
  self.assertEqual(chat.state['turns'][0]['status'],'inProgress')
  self.assertIn('done',chat.pending_completions)

  # 2. item/started 携带 final 结构到达，绝不能提前 settle
  started_item={**final}
  chat._event({'method':'item/started','params':{'threadId':'test','turnId':'done','item':started_item}})
  self.assertEqual(chat.state['turns'][0]['status'],'inProgress')
  self.assertIn('done',chat.pending_completions)

  # 3. item/completed 到达，空 final text 也是合法的 terminal
  completed_empty_item={**final,'text':''}
  chat._event({'method':'item/completed','params':{'threadId':'test','turnId':'done','item':completed_empty_item}})
  self.assertEqual(chat.state['turns'][0]['status'],'completed')
  self.assertNotIn('done',chat.pending_completions)
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'idle')

 def test_plan_item_is_progress_and_never_settles_as_final(self):
  chat,_,_=self.fixture();chat.closed=False;chat.ready=True
  chat.state['threadRuntimeStatus']={'type':'active'}
  chat.state['turns'][0].update(status='inProgress',items=[])
  plan_item={'id':'plan-1','type':'plan','text':'正在执行计划'}
  # plan 即使 item/completed 也绝不是 final 终态
  chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[plan_item]}}})
  self.assertEqual(chat.state['turns'][0]['status'],'inProgress')
  self.assertIn('done',chat.pending_completions)
  chat._event({'method':'item/completed','params':{'threadId':'test','turnId':'done','item':plan_item}})
  self.assertEqual(chat.state['turns'][0]['status'],'inProgress')
  self.assertIn('done',chat.pending_completions)

 def test_pending_refresh_idle_does_not_override_ui_active_and_disconnect_keeps_pending(self):
  chat,_,_=self.fixture();chat.closed=False;chat.ready=True
  chat.state['threadRuntimeStatus']={'type':'active'}
  chat.state['turns'][0].update(status='inProgress',items=[])
  chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[]}}})
  self.assertIn('done',chat.pending_completions)
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'active')

  # 1. refresh_shared_state 原生返回 idle 时，不得覆盖 UI 的 active 状态
  chat.backend.request=lambda method,params,timeout=30:{'thread':{'id':'test','cwd':'/tmp/test','status':{'type':'idle'}}}
  chat.refresh_shared_state()
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'active')

  # 2. bridge/disconnected 不能 clear pending_completions 与 completed_reads
  chat._event({'method':'bridge/disconnected'})
  self.assertIn('done',chat.pending_completions)
  self.assertIn('done',chat.completed_reads)

 def test_unshared_completion_behavior_contrast(self):
  chat,_,final=self.fixture();chat.shared=False;chat.closed=False;chat.ready=True
  chat.state['threadRuntimeStatus']={'type':'active'}
  chat.state['turns'][0].update(status='inProgress',items=[])
  tool={'id':'tool','type':'commandExecution'}
  # 非共享模式维持原生完成规则，不卡在 pending_completions
  chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[tool]}}})
  self.assertEqual(chat.state['turns'][0]['status'],'completed')
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'idle')
  self.assertNotIn('done',chat.pending_completions)

 def test_complete_notification_with_final_commits_without_a_second_read(self):
  chat,_,final=self.fixture();chat.state['threadRuntimeStatus']={'type':'active'}
  chat.state['turns'][0].update(status='inProgress',items=[])
  chat._event({'method':'turn/completed','params':{'threadId':'test','turn':{'id':'done','status':'completed','items':[final]}}})
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'idle')
  self.assertEqual(chat.pending_completions,{})
  self.assertEqual(chat.completed_reads,set())
  self.assertIn(final,chat.state['turns'][0]['items'])

 def test_idle_notification_before_completion_does_not_settle_active_turn(self):
  chat,_,_=self.fixture();chat.state['threadRuntimeStatus']={'type':'active'}
  chat.state['turns'][0].update(status='inProgress',items=[])
  chat._event({'method':'thread/status/changed','params':{'threadId':'test','status':{'type':'idle'}}})
  self.assertEqual(chat.state['threadRuntimeStatus']['type'],'active')

if __name__=='__main__':unittest.main()
