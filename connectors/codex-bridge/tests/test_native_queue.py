import copy
import tempfile
import unittest
from unittest.mock import Mock
from test_shared_bridge import SharedBridgeTests, ID
from bridge.clients.codex.native_queue import NativeQueue, merge, detail, operate

class NativeQueueTests(unittest.TestCase):
    def setUp(self):
        self.item = {'id': 'native-one', 'clientUserMessageId': 'client-one',
                     'input': [{'type':'text','text':'原生排队消息'}]}
        self.backend = Mock()
        self.backend.request.return_value = {'data':[self.item], 'nextCursor':None}
        self.queue = NativeQueue(self.backend)

    def test_paging_cache_invalidation_and_confirmed_empty(self):
        self.backend.request.side_effect = [{'data':[self.item],'nextCursor':'next'},
            {'data':[{**self.item,'id':'native-two'}],'nextCursor':None}]
        self.assertEqual(len(self.queue.read(ID)),2)
        self.assertEqual(len(self.queue.read(ID)),2)
        self.assertEqual(self.backend.request.call_count,2)
        self.queue.invalidate(ID)
        self.backend.request.side_effect = OSError('disconnected')
        self.assertEqual(len(self.queue.read(ID)),2)
        with self.assertRaises(OSError):self.queue.read(ID,fresh=True)
        self.backend.request.side_effect = None
        self.backend.request.return_value = {'data':[],'nextCursor':None}
        self.assertEqual(self.queue.read(ID,fresh=True),[])

    def test_equal_text_is_not_identity_and_native_http_ids_are_distinct(self):
        local=[{'id':'local','text':'原生排队消息'}]
        result=merge(local,[self.item,{**self.item,'id':'native-two','clientUserMessageId':'client-two'}])
        self.assertEqual([row['id'] for row in result],['local','native-one','native-two'])
        self.assertNotIn('clientRequestId',result[1])
        self.assertEqual(merge([{'id':'client-one'}],[self.item]),[{'id':'client-one'}])

    def test_exact_native_delete_and_unknown_write_not_retried(self):
        chat=Mock(id=ID)
        self.backend.request.return_value={'deleted':True}
        result=operate(chat,{'type':'delete_queued_message','token':'native-one'},self.queue,[self.item])
        self.assertTrue(result['success'])
        self.assertEqual(self.backend.request.call_args.args[:2],('thread/queue/delete',{'threadId':ID,'queuedSubmissionId':'native-one'}))
        self.backend.request.side_effect=TimeoutError('unknown')
        with self.assertRaises(TimeoutError):operate(chat,{'type':'delete_queued_message','token':'native-one'},self.queue,[self.item])
        self.assertEqual(self.backend.request.call_count,2)

    def test_rich_recall_fails_before_delete(self):
        chat=Mock(id=ID,state={'threadRuntimeStatus':{'type':'active'}})
        rich={**self.item,'input':[{'type':'skill','name':'skill'}]}
        with self.assertRaises(ValueError):operate(chat,{'type':'recall_queued_message','token':'native-one'},self.queue,[rich])
        self.assertFalse(self.backend.request.called)

    def test_shared_adapter_queue_actions_and_timeline_include_original_tokens(self):
        from bridge.clients.codex.standalone_queue import operate as queue_operate
        with tempfile.TemporaryDirectory() as root:
            bridge,chat,backend=SharedBridgeTests().fixture(root)
            bridge._native_queue=lambda _:self.queue
            bridge._native_queue_items=lambda _:self.queue.read(ID)
            bridge.session=lambda *a,**kw:chat
            bridge._annotate_upload_attachments=lambda *a:None
            bridge.history=None
            actions=queue_operate(chat,{'type':'get_queue_actions'})
            self.assertEqual(actions['followUp'][0]['token'],'native-one')
            view=bridge.timeline_read(ID)
            self.assertEqual(view['meta']['submissions'][0]['id'],'native-one')
            self.backend.request.return_value={'data':[],'nextCursor':None}
            self.queue.invalidate(ID)
            changes=bridge.timeline_read(ID,'changes',after=view['sequence'],epoch=view['epoch'],start=0)
            self.assertEqual(changes['meta']['submissions'],[])
            self.assertFalse(any(method in ('turn/start','turn/steer')for method,_ in backend.calls))

if __name__=='__main__':unittest.main()
