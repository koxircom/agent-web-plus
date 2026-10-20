"""Real durable Chat + native queue contract; no live service or model calls."""
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
from test_shared_bridge import SharedBridgeTests, ID
from bridge.clients.codex.standalone_queue import operate
from bridge.features.workspace.uploads import Uploads

class QueueTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.bridge, self.chat, self.backend = SharedBridgeTests().fixture(self.root.name)
        self.chat.submissions = {str(i): {'status':'queued','text':'相同内容' if i < 3 else '第三条',
            'mode':'queue','workMode':'default','attachmentIds':[], 'attachments':[],
            'skills':[], 'catalog':None,'clientRequestId':'request-'+str(i)} for i in range(1,4)}
        self.bridge.save = lambda: Path(self.root.name,'ledger.json').write_text(json.dumps(self.bridge.records,ensure_ascii=False))
    def call(self, action, **kw):
        return operate(self.chat, {'type':action, **kw})
    def test_snapshot_stable_tokens_duplicate_text_and_live_catalog(self):
        self.chat.submissions['1']['catalog'] = __import__('threading').RLock()
        a=self.call('get_queue_actions'); b=self.call('get_queue_actions')
        self.assertEqual(a,b);self.assertEqual([x['token'] for x in a['followUp']],['1','2','3'])
        self.call('delete_queued_message',token='2')
        self.assertEqual(self.chat.submissions['1']['status'],'queued')
        self.assertEqual(self.chat.submissions['2']['status'],'cancelled')
        self.assertEqual(json.loads(Path(self.root.name,'ledger.json').read_text())['threads'][ID]['submissions']['2']['status'],'cancelled')
    def test_reorder_uses_existing_records_and_rejects_stale_snapshot(self):
        self.call('reorder_queued_message',tokens=['1','2','3'],token='1',targetToken='3')
        self.assertEqual(list(self.chat.submissions),['2','3','1'])
        with self.assertRaises(ValueError):self.call('reorder_queued_message',tokens=['1','2','3'],token='1',targetToken='3')
        self.assertEqual(list(self.chat.submissions),['2','3','1'])
    def test_recall_image_keeps_exact_bytes_and_original_request_identity(self):
        uploads=Uploads(self.root.name);self.chat.uploads=uploads
        upload='01901234-5678-7000-8000-000000000002'
        data=b'\x89PNG\r\n\x1a\nfixture'
        meta=uploads.put(ID,upload,'图片.png',data)
        self.chat.submissions['1'].update(attachments=[meta],attachmentIds=[upload])
        detail=self.call('get_queued_message',token='1')
        self.assertEqual(base64.b64decode(detail['images'][0]['data']),data)
        out=self.call('recall_queued_message',token='1')
        self.assertEqual(out['images'],detail['images']);self.assertEqual(out['recalledPromptRequestIds'],['request-1'])
        self.assertEqual(self.chat.submissions['1']['status'],'recalled')
        with self.assertRaises(ValueError):self.call('delete_queued_message',token='1')
    def test_recall_all_is_atomic_and_preserves_order(self):
        with self.assertRaises(ValueError):self.call('recall_all_queued_messages',tokens=['1'])
        self.assertEqual(len(self.call('get_queue_actions')['followUp']),3)
        result=self.call('recall_all_queued_messages',tokens=['1','2','3'])
        self.assertEqual([x['token'] for x in result['entries']],['1','2','3'])
        self.assertEqual(result['queuedMessages']['followUp'],[])
    def test_failed_save_rolls_back_memory(self):
        self.chat.persist()
        self.bridge.save=Mock(side_effect=OSError('fixture disk failure'))
        with self.assertRaises(OSError):self.call('delete_queued_message',token='1')
        self.assertEqual(self.chat.submissions['1']['status'],'queued')
        self.assertEqual(self.bridge.records['threads'][ID]['submissions']['1']['status'],'queued')
    def test_promote_active_dispatches_once_with_original_token(self):
        self.backend.status='active'
        def dispatch(token,row):
            self.assertEqual((token,row['mode'],row['workMode']),('2','steer',None));row['status']='accepted';self.chat.persist();return {'status':'accepted'}
        self.chat._dispatch=Mock(side_effect=dispatch)
        self.call('promote_queued_message',token='2')
        self.assertEqual(self.chat._dispatch.call_count,1)
        with self.assertRaises(ValueError):self.call('promote_queued_message',token='2')
    def test_promote_idle_wakes_original_queue_without_starting_an_extra_turn(self):
        self.chat._dispatch=Mock()
        self.call('promote_queued_message',token='1')
        self.assertTrue(self.chat.queue_event.is_set());self.chat._dispatch.assert_not_called()
    def test_rejected_promote_keeps_original_queued_content(self):
        self.backend.status='active'
        def rejected(token,row):row['status']='failed';raise ValueError('native rejected')
        self.chat._dispatch=Mock(side_effect=rejected)
        with self.assertRaises(ValueError):self.call('promote_queued_message',token='1')
        self.assertEqual(self.chat.submissions['1']['status'],'queued');self.assertEqual(self.chat.submissions['1']['mode'],'queue')
    def test_unknown_promote_is_never_restored_or_replayed(self):
        self.backend.status='active'
        def unknown(token,row):row['status']='unknown';return {'status':'unknown'}
        self.chat._dispatch=Mock(side_effect=unknown)
        with self.assertRaises(ValueError):self.call('promote_queued_message',token='1')
        with self.assertRaises(ValueError):self.call('promote_queued_message',token='1')
        self.assertEqual(self.chat.submissions['1']['status'],'unknown');self.assertEqual(self.chat._dispatch.call_count,1)

    def test_unknown_remains_visible_read_only_and_failed_is_recoverable(self):
        from bridge.clients.codex.standalone import pending_submissions
        self.chat.submissions['1'].update(status='unknown')
        self.chat.submissions['2'].update(status='failed',error='native rejection')
        rows=self.call('get_queue_actions')['followUp']
        self.assertEqual([row['status']for row in rows],['unknown','failed','queued'])
        self.assertEqual(len(pending_submissions(self.chat.submissions)),3)
        for action in ['delete_queued_message','recall_queued_message','promote_queued_message']:
            with self.assertRaisesRegex(ValueError,'待确认'):self.call(action,token='1')
        with self.assertRaisesRegex(ValueError,'待确认'):self.call('clear_queue')
        self.assertEqual(self.chat.submissions['3']['status'],'queued')
        recalled=self.call('recall_queued_message',token='2')
        self.assertEqual(recalled['text'],self.chat.submissions['2']['text'])
        self.assertEqual(self.chat.submissions['2']['status'],'recalled')

    def test_steering_an_external_turn_does_not_claim_its_tool_requests(self):
        self.chat.submissions['1'].update(status='accepted',mode='steer',turnId='original-turn')
        self.chat.shared_requests={'request':{'id':1,'method':'item/tool/call','params':{'threadId':ID,'turnId':'original-turn'}}}
        self.chat._sync_shared_requests()
        self.assertEqual(self.chat.state['requests'],[])
        self.chat._event({'id':2,'method':'item/tool/call','params':{'threadId':ID,'turnId':'original-turn'}})
        self.assertNotIn('2',self.chat.shared_requests)
        self.chat.submissions['1']['mode']='queue'
        self.chat._sync_shared_requests();self.assertEqual(len(self.chat.state['requests']),1)
    def test_native_steer_echo_uses_client_identity_without_duplicate_placeholder(self):
        self.chat.submissions['1'].update(status='accepted',mode='steer',turnId='original-turn')
        self.chat.state['turns']=[{'turnId':'original-turn','status':'inProgress','items':[{'id':'native-id','type':'userMessage','clientId':'1','content':[{'type':'text','text':'相同内容'}]}]}]
        messages=self.chat.view()['turns'][0]['messages']
        self.assertEqual(len(messages),1);self.assertEqual(messages[0]['id'],'native-id');self.assertEqual(messages[0]['requestId'],'1')
    def test_messages_without_client_identity_do_not_invent_None_identity(self):
        from bridge.features.sessions.model import normalize_item
        row=normalize_item({'id':'native','type':'userMessage','content':[{'type':'text','text':'原消息'}]})
        self.assertNotIn('requestId',row)

    def test_old_history_fallback_does_not_claim_later_steering_rows(self):
        from types import SimpleNamespace
        from bridge.features.sessions.timeline import Timeline
        import threading
        self.bridge.records['threads'][ID]['submissions']={'s':{'turnId':'t','mode':'send','status':'accepted','text':'初始','clientRequestId':'primary-id','attachments':[]},'steer-token':{'turnId':'t','mode':'steer','status':'accepted','text':'补充','clientRequestId':'steer-request','attachments':[]}}
        saved=SimpleNamespace(condition=threading.RLock(),submissions={},timeline=Timeline(),sequence=1,view=lambda **_options:{'id':ID,'sequence':1,'turns':[{'id':'t','status':'completed','messages':[{'id':'u','role':'user','kind':'userMessage','text':'初始'},{'id':'v','role':'user','kind':'userMessage','text':'补充','requestId':'steer-token'},{'id':'w','role':'user','kind':'userMessage','text':'无关联'}]}]})
        self.bridge.session=lambda *_args,**_kw:saved;self.bridge._annotate_upload_attachments=lambda *_:None
        rows=[r for r in self.bridge.timeline_read(ID)['rows'] if r['role']=='user']
        self.assertEqual(rows[0]['requestId'],'primary-id');self.assertEqual(rows[1]['requestId'],'steer-request');self.assertNotIn('requestId',rows[2])

    def test_older_persist_cannot_overwrite_a_newly_saved_submission(self):
        import threading
        old_waiting, release_old, attempted, mutated = (threading.Event() for _ in range(4))
        lock, failures = threading.RLock(), []
        class Gate:
            def __enter__(self):
                if threading.current_thread().name == 'old-persist':
                    old_waiting.set()
                    if not release_old.wait(3):
                        raise AssertionError('old persist was not released')
                lock.acquire()
                return self
            def __exit__(self, *args):
                lock.release()
        self.bridge.registry_lock = Gate()
        def old():
            try:
                self.chat.persist(touch=False)
            except Exception as error:
                failures.append(error)
        def newer():
            attempted.set()
            try:
                with self.chat.lock:
                    self.chat.submissions['new'] = {'status':'queued','mode':'queue','text':'新消息绝不能被旧快照覆盖'}
                    self.chat.persist()
                    mutated.set()
            except Exception as error:
                failures.append(error)
        older, newer_thread = threading.Thread(target=old, name='old-persist'), threading.Thread(target=newer, name='new-persist')
        older.start()
        self.assertTrue(old_waiting.wait(2))
        newer_thread.start()
        self.assertTrue(attempted.wait(2))
        mutated.wait(.1)
        release_old.set()
        older.join(2)
        newer_thread.join(2)
        self.assertFalse(older.is_alive() or newer_thread.is_alive(), 'both writers must finish')
        self.assertEqual(failures, [])
        disk = json.loads(Path(self.root.name, 'ledger.json').read_text())
        self.assertEqual(disk['threads'][ID]['submissions']['new']['text'], '新消息绝不能被旧快照覆盖')
