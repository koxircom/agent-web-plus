import contextlib,sqlite3,sys,tempfile,unittest,uuid
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.wsl_history import WslHistory
class HistoryBatchTests(unittest.TestCase):
 def test_activity_metadata_uses_one_scoped_query_and_keeps_symlink_boundary(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)/'project';root.mkdir();outside=Path(tmp)/'outside';outside.mkdir();(root/'escape').symlink_to(outside)
   home=Path(tmp)/'home';home.mkdir();db=sqlite3.connect(home/'state_5.sqlite')
   db.execute('CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,archived INTEGER,name TEXT,title TEXT,source TEXT,thread_source TEXT,recency_at_ms INTEGER,recency_at INTEGER,updated_at INTEGER)')
   ids=[str(uuid.uuid4()) for _ in range(156)];escaped=str(uuid.uuid4())
   db.executemany('INSERT INTO threads VALUES(?,?,0,NULL,"history","cli",NULL,NULL,NULL,1)',[(i,str(root)) for i in ids]+[(escaped,str(root/'escape'))]);db.commit();db.close()
   store=WslHistory(home,[{'key':'local|project','name':'project','path':root}]);connect=store._connect;counts={'queries':0,'paths':0};workspace=store.workspace
   @contextlib.contextmanager
   def connected():
    counts['queries']+=1
    with connect() as conn:yield conn
   def scoped(cwd):counts['paths']+=1;return workspace(cwd)
   store._connect=connected;store.workspace=scoped;rows=store.get_many(ids+[escaped]);self.assertEqual(set(rows),set(ids));self.assertEqual(counts,{'queries':1,'paths':2})
if __name__=='__main__':unittest.main()
