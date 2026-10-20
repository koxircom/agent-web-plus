"""Bounded saved-history joins and stable ancestors; synthetic records only."""
import json, sys, tempfile, unittest, threading
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.wsl_history import HistorySession
from bridge.clients.codex.standalone import StandaloneBridge, Chat
from bridge.features.sessions.timeline import Timeline
from test_shared_bridge import SharedBridgeTests, ID

class HistoryPagingTests(unittest.TestCase):
 def test_initial_read_is_one_turn_and_expands_only_on_explicit_boundary(self):
  with tempfile.TemporaryDirectory() as root:
   path=Path(root)/'rollout.jsonl';path.write_text('{}')
   calls=[]
   def read(identifier,meta,limit):
    calls.append(limit);return {'turns':[], 'cwd':root, 'turnsPagination':{'hasLoadedOldest':False}}
   store=SimpleNamespace(_history=read);s=HistorySession(store,ID);meta={'rollout_path':str(path)}
   s.refresh(meta);s.refresh(meta);self.assertEqual(calls,[1])
   s.refresh(meta,turn_limit=4);self.assertEqual(calls,[1,4]);self.assertEqual(s.limit,4)
 def test_native_older_pages_prepend_without_replacing_live_items_or_cursor(self):
  with tempfile.TemporaryDirectory() as root:
   b,c,backend=SharedBridgeTests().fixture(root)
   c.state['turns']=[{'turnId':'t2','status':'completed','items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':'last user'}]},{'id':'a','type':'agentMessage','text':'LIVE authoritative'}]}]
   c.state['turnsPagination']={'hasLoadedOldest':False}
   b.session=lambda *_args,**_kwargs:c;b._annotate_upload_attachments=lambda *_:None
   older={'turnId':'t1','status':'completed','items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':'older user'}]}]}
   stale={'turnId':'t2','status':'completed','items':[{'id':'a','type':'agentMessage','text':'stale disk'}]}
   calls=[]
   def saved(identifier,turn_limit):
    calls.append(turn_limit);return SimpleNamespace(condition=threading.RLock(),limit=2,state={'turns':[older,stale],'turnsPagination':{'hasLoadedOldest':True}})
   b.history=SimpleNamespace(session=saved)
   page=b.timeline_read(ID,limit=1000);self.assertFalse(calls);cursor=page['before']
   previous=b.timeline_read(ID,limit=1000,before=cursor)
   self.assertEqual(calls,[2]);self.assertEqual([r['text']for r in previous['rows']],['older user'])
   self.assertFalse(previous['hasMore']);self.assertFalse(previous.get('reset',False));self.assertEqual(c.state['turns'][-1]['items'][-1]['text'],'LIVE authoritative')
 def test_timeline_honors_large_but_byte_bounded_explicit_navigation_pages(self):
  t=Timeline();t.update({'sequence':1,'turns':[{'id':'x','messages':[{'id':str(i),'role':'user','text':'x'*1000}for i in range(1200)]}]})
  page=t.page(limit=1000);self.assertGreater(len(page['rows']),100);self.assertLess(len(page['rows']),1000)
  next_page=t.page(limit=1000,before=page['before']);self.assertFalse(set(r['key']for r in page['rows'])&set(r['key']for r in next_page['rows']))
if __name__=='__main__':unittest.main()
