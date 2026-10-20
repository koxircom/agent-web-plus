"""Shared history ownership contracts; no real model, daemon or user data."""
import copy
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import StandaloneBridge, Chat
from bridge.features.sessions.side_chat import SideChat

ID='01901234-5678-7000-8000-000000000001'
class SharedBridgeTests(unittest.TestCase):
    def fixture(self, root):
        class Backend:
            shared=True
            process=SimpleNamespace(poll=lambda:None)
            def __init__(self): self.calls=[];self.status='idle'
            def request(self, method, params, timeout=30):
                self.calls.append((method,params))
                return {'thread':{'id':ID,'cwd':root,'status':{'type':self.status}},'model':'model','reasoningEffort':'high'}
            def write(self,value): self.calls.append(('write',value))
        backend=Backend();bridge=StandaloneBridge.__new__(StandaloneBridge)
        bridge.records={'threads':{ID:{'title':'原会话','cwd':root,'runtime':'history'}},'titleOverrides':{}}
        bridge.history=None;bridge.registry_lock=threading.RLock();bridge.lock=threading.RLock();bridge.uploads=None;bridge.catalog_reader=None;bridge.save=lambda:None;bridge.workspaces=[{'path':Path(root)}]
        chat=Chat(bridge,ID,backend.request('fixture',{}),backend);bridge.live={ID:chat};bridge.history_runtime=backend;bridge.runtime=SimpleNamespace(write=lambda _:self.fail('unrelated runtime received a reply'));bridge.closed=threading.Event()
        return bridge,chat,backend

    def test_shared_resume_preserves_original_active_status(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);r.status='active';c.refresh_shared_state()
            self.assertEqual(c.state['threadRuntimeStatus']['type'],'active')
            self.assertEqual(r.calls[-1],('thread/resume',{'threadId':ID,'excludeTurns':True}))

    def test_auto_queues_real_active_and_sends_real_idle(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);b._adopt_record=lambda _:None;b.session=lambda _:c;c.send=lambda *_args,**kw:{'mode':kw['mode']}
            r.status='active';self.assertEqual(b.send(ID,'消息','submission',mode='auto')['mode'],'queue')
            r.status='idle';self.assertEqual(b.send(ID,'消息','submission',mode='auto')['mode'],'send')
            self.assertEqual(b.send(ID,'计划消息','plan-submission',mode='queue',work_mode='plan')['mode'],'send')

    def test_foreign_requests_are_not_exposed_or_answered(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root)
            b._runtime_event({'id':1,'method':'item/commandExecution/requestApproval','params':{'threadId':ID,'turnId':'desktop-turn'}},'history')
            b._runtime_event({'id':2,'method':'item/tool/call','params':{'threadId':'other-thread','turnId':'other-turn'}},'history')
            self.assertEqual(c.state['requests'],[]);self.assertFalse(any(m=='write'for m,_ in r.calls))

    def test_own_request_race_waits_for_the_confirmed_turn_id(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);c.submissions={'s':{'status':'unknown'}}
            c._event({'id':3,'method':'item/commandExecution/requestApproval','params':{'threadId':ID,'turnId':'web-turn'}})
            self.assertEqual(c.state['requests'],[])
            c.submissions['s'].update(status='accepted',turnId='web-turn');c._sync_shared_requests()
            self.assertEqual([x['id']for x in c.state['requests']],[3])
            c._event({'method':'serverRequest/resolved','params':{'threadId':ID,'requestId':3}})
            self.assertEqual(c.state['requests'],[])

    def test_foreign_turn_start_cannot_claim_an_unknown_web_submission(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);c.submissions={'s':{'status':'unknown','mode':'send'}}
            c._event({'method':'turn/started','params':{'threadId':ID,'turn':{'id':'desktop-turn','status':'inProgress'}}})
            self.assertNotIn('turnId',c.submissions['s'])

    def test_shared_disconnect_does_not_stop_the_independent_backend(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);other=SimpleNamespace(backend=b.runtime,_event=lambda _:self.fail('web chat was disconnected'));b.live['other']=other
            b._runtime_event({'method':'bridge/disconnected'},'history')
            self.assertFalse(b.closed.is_set());self.assertFalse(c.ready);self.assertIn('不会自动重发',c.error)

    def test_shared_turn_does_not_override_native_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root)
            c.runtime.request('turn/start',{'threadId':ID,'approvalPolicy':'never','sandboxPolicy':{'type':'dangerFullAccess'},'runtimeWorkspaceRoots':['/'],'input':[]})
            self.assertEqual(r.calls[-1][1],{'threadId':ID,'input':[]})

    def test_dispatch_rechecks_busy_state_before_starting(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);r.status='active';row={'mode':'queue','status':'queued'};c.submissions={'s':row}
            with patch.object(SideChat,'_dispatch',side_effect=AssertionError('must not start a concurrent turn')):
                self.assertEqual(c._dispatch('s',row),{'id':'s','status':'queued'})
            row['mode']='send'
            with self.assertRaisesRegex(ValueError,'正在运行任务'):c._dispatch('s',row)

    def test_shared_join_reads_metadata_and_keeps_scoped_local_history(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root)
            saved=SimpleNamespace(condition=threading.RLock(),state={'turns':[{'turnId':'original','items':[]}]})
            calls=[]
            b.history=SimpleNamespace(session=lambda identifier,full: (calls.append(full),saved)[1])
            result=b._resume_history(r,ID)
            self.assertEqual(r.calls[-1],('thread/resume',{'threadId':ID,'excludeTurns':True}))
            self.assertEqual(result['thread']['turns'][0]['turnId'],'original')
            self.assertEqual(calls,[False])

    def test_offline_history_retains_durable_image_and_request_identity(self):
        from bridge.features.sessions.timeline import Timeline
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root)
            b.records['threads'][ID]['submissions']={'s':{'turnId':'t','status':'accepted','mode':'send','text':'图片消息','clientRequestId':'web-request','attachments':[{'id':'upload','name':'image.png','image':True}]}}
            saved=SimpleNamespace(condition=threading.RLock(),submissions={},timeline=Timeline(),sequence=1,view=lambda **_options:{'id':ID,'sequence':1,'title':'原会话','turns':[{'id':'t','status':'completed','messages':[{'id':'u','role':'user','kind':'userMessage','text':'图片消息'}]}]})
            b.session=lambda *_args,**_kw:saved;b._annotate_upload_attachments=lambda *_:None
            result=b.timeline_read(ID)
            user=next(row for row in result['rows']if row['role']=='user')
            self.assertEqual(user['attachments'][0]['uploadId'],'upload')
            self.assertEqual(user['requestId'],'web-request')

    def test_read_only_shared_observer_never_creates_a_durable_web_record(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root)
            b.records['threads'].clear()
            b.history=SimpleNamespace(get=lambda _: {'cwd':root,'title':'原会话'})
            b._history_backend=lambda:r
            b._resume_history=lambda *_:{'thread':{'id':ID,'cwd':root,'turns':[],'status':{'type':'active'}},'model':'model'}
            b.live={};b._start_queue=lambda _:None
            observed=b._observe_history(ID);observed.persist()
            self.assertEqual(b.records['threads'],{})
            self.assertEqual(observed.state['threadRuntimeStatus']['type'],'active')
            self.assertIs(b._observe_history(ID),observed)

    def test_registered_shared_history_observes_native_state_on_read(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);b.live={};b.history=object();b.history_socket='/configured/socket'
            b._observe_history=lambda identifier:c
            self.assertIs(b.session(ID,attach=False),c)

    def test_rename_of_a_read_only_observer_keeps_its_title_without_adopting(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);b.records['threads'].clear();b._scoped_record=lambda _: {'runtime':'history'}
            b.view=lambda identifier:c.state
            b.rename(ID,'新名称')
            self.assertEqual(b.records['titleOverrides'][ID],'新名称')
            self.assertEqual(b.records['threads'],{})
            self.assertEqual(c.state['title'],'新名称')

    def test_shared_disconnect_is_scoped_by_backend(self):
        with tempfile.TemporaryDirectory() as root:
            b,c,r=self.fixture(root);events=[];b.live['web']=SimpleNamespace(backend=b.runtime,_event=events.append)
            b._runtime_event({'method':'turn/completed','params':{'threadId':'web','turn':{'id':'foreign','status':'completed'}}},'history')
            self.assertEqual(events,[])

if __name__=='__main__':unittest.main()
