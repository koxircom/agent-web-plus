"""Native queue owns execution. All data and transport are isolated fixtures."""
import copy
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock
from bridge.clients.codex.native_queue import NativeQueue, reconcile_handoffs, merge
from bridge.features.sessions.side_chat import SideChatError

SID='01901234-5678-7000-8000-000000000001'
SUB='01901234-5678-7000-8000-000000000002'
class NativeHandoffTests(unittest.TestCase):
    def setUp(self):
        from test_shared_bridge import SharedBridgeTests
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.bridge,self.chat,self.backend=SharedBridgeTests().fixture(self.temp.name)
        self.items=[];self.adds=[];self.failure=None
        original=self.backend.request
        def request(method,params,timeout=30):
            if method=='thread/queue/list':return {'data':copy.deepcopy(self.items),'nextCursor':None}
            if method=='thread/queue/add':
                self.adds.append(copy.deepcopy(params))
                if self.failure=='not_sent':
                    error=SideChatError('before write');error.dispatched=False;raise error
                item={'id':'native-'+str(len(self.adds)),'input':params['input'],'clientUserMessageId':params['clientUserMessageId']};self.items.append(item)
                if self.failure=='response_lost':
                    error=SideChatError('response lost');error.dispatched=True;raise error
                return {'queuedSubmission':copy.deepcopy(item)}
            if method=='thread/queue/delete':
                before=len(self.items);self.items[:]=[i for i in self.items if i['id']!=params['queuedSubmissionId']];return {'deleted':len(self.items)!=before}
            if method=='thread/queue/reorder':return {}
            return original(method,params,timeout)
        self.backend.request=request
        self.native=NativeQueue(self.backend);self.bridge._native_queue=lambda _:self.native;self.bridge._native_queue_items=lambda _:self.native.read(SID)
        self.bridge.web_history=None
        self.bridge.save=lambda:Path(self.temp.name,'ledger.json').write_text(json.dumps(self.bridge.records))

    def send(self,**options):return self.chat.send('原始消息',SUB,[],mode='queue',work_mode='default',client_request_id='http-original-request',**options)

    def test_stable_http_retries_add_once_and_native_token_projects_to_every_client(self):
        first=self.send();second=self.send()
        self.assertTrue(first['nativeQueueConfirmed']);self.assertEqual(first['nativeQueueId'],second['nativeQueueId']);self.assertEqual(len(self.adds),1)
        self.assertEqual(self.adds[0]['clientUserMessageId'],SUB)
        projected=merge([],self.items,self.chat.submissions)
        self.assertEqual(projected[0]['id'],first['nativeQueueId']);self.assertEqual(projected[0]['clientRequestId'],'http-original-request')
        saved=json.loads(Path(self.temp.name,'ledger.json').read_text())['threads'][SID]['submissions'][SUB]
        self.assertEqual(saved['queueOwner'],'native');self.assertTrue(saved['nativeQueueConfirmed'])

    def test_response_loss_is_reconciled_by_exact_client_id_without_second_add(self):
        self.failure='response_lost';result=self.send();self.assertEqual(result['status'],'unknown')
        self.failure=None;reconcile_handoffs(self.chat)
        self.assertTrue(self.chat.submissions[SUB]['nativeQueueConfirmed']);self.assertEqual(len(self.adds),1)
        self.assertEqual(self.chat.submissions[SUB]['nativeQueueId'],self.items[0]['id'])

    def test_transport_proven_not_sent_retries_only_the_same_original_id(self):
        self.failure='not_sent';self.send();self.assertEqual(self.chat.submissions[SUB]['nativeQueueStage'],'prepared');self.assertEqual(self.items,[])
        self.failure=None;reconcile_handoffs(self.chat)
        self.assertEqual(len(self.items),1);self.assertEqual({p['clientUserMessageId']for p in self.adds},{SUB})

    def test_uncertain_absence_never_replays_and_worker_has_no_native_turn_dispatch(self):
        self.failure='response_lost';self.send();self.items.clear();self.failure=None
        reconcile_handoffs(self.chat);self.assertEqual(len(self.adds),1);self.assertEqual(self.chat.submissions[SUB]['nativeQueueStage'],'uncertain')
        self.chat._dispatch=Mock(side_effect=AssertionError('second executor'))
        self.chat.queue_event.set();worker=threading.Thread(target=self.chat._queue_loop,daemon=True);worker.start()
        with self.chat.condition:self.chat.closed=True;self.chat.queue_event.set()
        worker.join(2);self.assertFalse(worker.is_alive());self.chat._dispatch.assert_not_called()

    def test_busy_plan_and_goal_stay_out_of_native_and_web_execution_queues(self):
        for mode in ['plan','goal']:
            with self.assertRaisesRegex(ValueError,'等待当前任务结束'):
                self.chat.send('必须保留模式',SUB,[],mode='queue',work_mode=mode)
        self.assertEqual(self.chat.submissions,{});self.assertEqual(self.items,[])

    def test_native_recall_returns_original_attachments_and_marks_only_exact_http_receipt(self):
        from bridge.clients.codex.standalone_queue import operate
        self.send();token=self.items[0]['id']
        result=operate(self.chat,{'type':'recall_queued_message','token':token})
        self.assertEqual(result['text'],'原始消息');self.assertEqual(result['recalledPromptRequestIds'],['http-original-request'])
        self.assertEqual(self.items,[]);self.assertEqual(self.chat.submissions[SUB]['status'],'recalled')

    def test_native_consumption_claims_exact_turn_and_historical_receipts_never_exhaust_admission(self):
        for i in range(25):self.chat.submissions[str(i)]={'status':'queued','nativeQueueConfirmed':True,'queueOwner':'native','mode':'queue','text':'历史原文'}
        self.send()
        self.chat._event({'method':'item/started','params':{'threadId':SID,'turnId':'exact-native-turn','item':{'type':'userMessage','id':'server-generated-id','clientId':SUB,'content':[]}}})
        self.assertEqual(self.chat.submissions[SUB]['status'],'accepted')
        self.assertEqual(self.chat.submissions[SUB]['turnId'],'exact-native-turn')
        self.chat._event({'id':19,'method':'item/commandExecution/requestApproval','params':{'threadId':SID,'turnId':'exact-native-turn'}})
        self.assertEqual([r['id']for r in self.chat.state['requests']],[19])

    def test_native_queue_and_recall_preserve_original_image_bytes(self):
        from bridge.features.workspace.uploads import Uploads
        from bridge.clients.codex.standalone_queue import operate
        import base64
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0XcAAAAASUVORK5CYII=')
        self.chat.uploads=Uploads(self.temp.name)
        attachment='01901234-5678-7000-8000-000000000009'
        self.chat.uploads.put(SID,attachment,'图片.png',png)
        self.chat.send('图片原文',SUB,[attachment],mode='queue',work_mode='default',client_request_id='http-original-request')
        self.assertEqual(self.adds[0]['input'][1]['type'],'localImage')
        self.assertEqual(Path(self.adds[0]['input'][1]['path']).read_bytes(),png)
        restored=operate(self.chat,{'type':'recall_queued_message','token':self.items[0]['id']})
        self.assertEqual(restored['text'],'图片原文');self.assertEqual(base64.b64decode(restored['images'][0]['data']),png)

    def test_new_chat_uses_shared_owner_when_configured(self):
        bridge=self.bridge;bridge.history_socket='/isolated/socket';bridge.history_home=Path(self.temp.name);bridge.store=Mock(home=Path(self.temp.name));bridge.workspace_by_key={'p':{'path':Path(self.temp.name)}}
        bridge.records['creations']={};bridge._history_backend=lambda:self.backend;self.backend.start=lambda:None
        bridge.runtime=Mock();bridge._validated_rollout_path=lambda *_:None;bridge._start_queue=lambda _:None
        original=self.backend.request
        self.backend.request=lambda method,params,timeout=30:({'thread':{'id':SID,'cwd':self.temp.name},'model':'model'} if method=='thread/start' else original(method,params,timeout))
        result=bridge.create_chat('p','共享新会话','01901234-5678-7000-8000-000000000003')
        self.assertEqual(result['id'],SID);self.assertEqual(bridge.records['threads'][SID]['runtime'],'history');bridge.runtime.start.assert_not_called()

if __name__=='__main__':unittest.main()
