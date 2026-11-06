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
 def test_slow_older_history_does_not_block_current_state_or_events(self):
  with tempfile.TemporaryDirectory() as root:
   b,c,_=SharedBridgeTests().fixture(root)
   c.state['turns']=[{'turnId':'t2','status':'completed','items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':'current'}]}]}]
   c.state['turnsPagination']={'hasLoadedOldest':False}
   b.session=lambda *_args,**_kwargs:c;b._native_queue_items=lambda _:[];b._annotate_upload_attachments=lambda *_:None
   entered,release,done=threading.Event(),threading.Event(),threading.Event();errors=[];pages=[]
   older={'turnId':'t1','status':'completed','items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':'older'}]}]}
   def saved(identifier,turn_limit):
    entered.set()
    if not release.wait(3):raise AssertionError('history fixture was not released')
    return SimpleNamespace(condition=threading.RLock(),limit=2,state={'turns':[older,c.state['turns'][0]],'turnsPagination':{'hasLoadedOldest':True}})
   b.history=SimpleNamespace(session=saved)
   page=b.timeline_read(ID,limit=1000)
   def read_older():
    try:pages.append(b.timeline_read(ID,limit=1000,before=page['before']))
    except BaseException as error:errors.append(error)
   def state():
    try:b.view(ID,metadata=True)
    except BaseException as error:errors.append(error)
    finally:done.set()
   worker=threading.Thread(target=read_older);reader=threading.Thread(target=state);worker.start()
   try:
    self.assertTrue(entered.wait(1));reader.start();self.assertTrue(done.wait(.5),'state waited for older-history parsing')
   finally:
    release.set();worker.join(2)
    if reader.ident:reader.join(2)
   self.assertFalse(errors,errors);self.assertEqual([r['text'] for r in pages[0]['rows']],['older'])
 def test_older_history_without_progress_returns_a_clear_error(self):
  with tempfile.TemporaryDirectory() as root:
   b,c,_=SharedBridgeTests().fixture(root)
   current={'turnId':'t2','status':'completed','items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':'current'}]}]}
   c.state['turns']=[current];c.state['turnsPagination']={'hasLoadedOldest':False}
   b.session=lambda *_args,**_kwargs:c;b._native_queue_items=lambda _:[];b._annotate_upload_attachments=lambda *_:None
   calls=[]
   def saved(identifier,turn_limit):
    calls.append(turn_limit)
    if len(calls)>3:raise AssertionError('history pagination repeated without progress')
    return SimpleNamespace(condition=threading.RLock(),limit=turn_limit,state={'turns':[current],'turnsPagination':{'hasLoadedOldest':False}})
   b.history=SimpleNamespace(session=saved)
   page=b.timeline_read(ID,limit=1000)
   with self.assertRaisesRegex(ValueError,'无法向前加载'):
    b.timeline_read(ID,limit=1000,before=page['before'])
   self.assertEqual(len(calls),1)
 def test_concurrent_older_reads_do_not_duplicate_or_overwrite_live_turns(self):
  with tempfile.TemporaryDirectory() as root:
   b,c,_=SharedBridgeTests().fixture(root)
   current={'turnId':'t2','status':'completed','items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':'current'}]}]}
   older={'turnId':'t1','status':'completed','items':[{'id':'u','type':'userMessage','content':[{'type':'text','text':'older'}]}]}
   c.state['turns']=[current];c.state['turnsPagination']={'hasLoadedOldest':False}
   b.session=lambda *_args,**_kwargs:c;b._native_queue_items=lambda _:[];b._annotate_upload_attachments=lambda *_:None
   barrier=threading.Barrier(2);errors=[];pages=[]
   def saved(identifier,turn_limit):
    barrier.wait(timeout=2)
    return SimpleNamespace(condition=threading.RLock(),limit=2,state={'turns':[older,current],'turnsPagination':{'hasLoadedOldest':True}})
   b.history=SimpleNamespace(session=saved);page=b.timeline_read(ID,limit=1000)
   def read():
    try:pages.append(b.timeline_read(ID,limit=1000,before=page['before']))
    except BaseException as error:errors.append(error)
   workers=[threading.Thread(target=read) for _ in range(2)]
   for worker in workers:worker.start()
   for worker in workers:worker.join(3)
   self.assertFalse(errors,errors);self.assertTrue(all(not w.is_alive() for w in workers))
   self.assertEqual([t['turnId'] for t in c.state['turns']],['t1','t2'])
   self.assertEqual([[r['text'] for r in p['rows']] for p in pages],[['older'],['older']])
if __name__=='__main__':unittest.main()
