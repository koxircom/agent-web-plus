"""A shared live chat can outgrow its original saved-history tail budget."""
import copy
import tempfile
import threading
import unittest
from types import SimpleNamespace
import test_shared_bridge as fixtures
ID=fixtures.ID

class PrefixGrowthTests(unittest.TestCase):
    def make(self, root, loaded, total=20):
        bridge,chat,backend=fixtures.SharedBridgeTests().fixture(root)
        turns=[{'turnId':f'turn-{i}', 'status':'completed', 'items':[
            {'id':f'user-{i}','type':'userMessage','content':[{'type':'text','text':f'第{i}轮'}]},
            {'id':f'assistant-{i}','type':'agentMessage','text':f'回复{i}'}]} for i in range(total)]
        chat.state['turns']=copy.deepcopy(turns[-loaded:]);chat.state['turnsPagination']={'hasLoadedOldest':False};chat.history_limit=1
        calls=[]
        def saved_session(identifier, turn_limit):
            calls.append(turn_limit)
            return SimpleNamespace(condition=threading.RLock(),limit=turn_limit,
                state={'turns':copy.deepcopy(turns[-turn_limit:]),'turnsPagination':{'hasLoadedOldest':turn_limit>=total}})
        bridge.history=SimpleNamespace(session=saved_session)
        bridge.session=lambda *_a,**_kw:chat;bridge._annotate_upload_attachments=lambda *_:None
        return bridge,chat,calls
    def test_loaded_four_turns_with_tail_budget_one_can_page_older(self):
        with tempfile.TemporaryDirectory() as root:
            bridge,chat,calls=self.make(root,4)
            initial=bridge.timeline_read(ID,limit=1000);before=initial['before']
            older=bridge.timeline_read(ID,limit=1000,before=before)
            self.assertGreaterEqual(calls[0],5)
            self.assertTrue(older['rows']);self.assertNotIn('reset',older)
            self.assertTrue(set(r['key'] for r in initial['rows']).isdisjoint(r['key'] for r in older['rows']))
            self.assertEqual(initial['epoch'],older['epoch'])
    def test_repeated_growth_keeps_all_turns_unique_and_reaches_oldest(self):
        with tempfile.TemporaryDirectory() as root:
            bridge,chat,calls=self.make(root,9,total=101)
            page=bridge.timeline_read(ID,limit=1000);seen=[r['key']for r in page['rows']];users=sum(r['role']=='user'for r in page['rows'])
            for _ in range(12):
                if not (page['hasMore'] or page['meta'].get('historyComplete') is False):break
                page=bridge.timeline_read(ID,limit=1000,before=page['before'])
                seen += [r['key']for r in page['rows']];users+=sum(r['role']=='user'for r in page['rows'])
            self.assertFalse(page['hasMore']);self.assertTrue(page['meta']['historyComplete']);self.assertEqual(users,101);self.assertEqual(len(seen),len(set(seen)))
            self.assertLessEqual(len(calls),5)
    def test_real_missing_boundary_is_still_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            bridge,chat,calls=self.make(root,4)
            def replaced(_identifier,turn_limit):
                return SimpleNamespace(condition=threading.RLock(),limit=turn_limit,state={'turns':[], 'turnsPagination':{'hasLoadedOldest':True}})
            bridge.history.session=replaced
            page=bridge.timeline_read(ID,limit=1000)
            with self.assertRaisesRegex(ValueError,'边界已变化'):bridge.timeline_read(ID,before=page['before'])

if __name__=='__main__':unittest.main()
