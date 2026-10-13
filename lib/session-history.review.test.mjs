import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getEventListeners } from 'node:events';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { buildSessionContext, sliceActiveBranch } = await jiti.import('./session-context.ts');
// Exercise the same native import context as the worker, including SDK v2 migration.
const bundledDir=mkdtempSync(new URL('../.test-history-indexer-',import.meta.url).pathname);
after(()=>rmSync(bundledDir,{recursive:true,force:true}));
const bundledFile=join(bundledDir,'indexer.mjs');
await build({entryPoints:[new URL('./session-history-indexer.ts',import.meta.url).pathname],outfile:bundledFile,bundle:true,platform:'node',format:'esm',packages:'external'});
const { SessionHistoryIndexer } = await import(pathToFileURL(bundledFile).href);
const { SessionHistoryPool } = await jiti.import('./session-history-pool.ts');
const { handleSessionContextRequest } = await jiti.import('./session-context-service.ts');
const entry = (id, parentId, content) => ({type:'message',id,parentId,timestamp:'2026-01-01T00:00:00Z',message:{role:'user',content}});
const header = {type:'session', version:3, id:'review',cwd:'/tmp'};
const serialize = (entries) => [header,...entries].map(JSON.stringify).join('\n')+'\n';

test('shared projection is read-only even with frozen Agent-owned entries', () => {
  const entries = [entry('u1',null,'hello'),entry('u2','u1','world')];
  for (const e of entries) Object.freeze(e);
  const before = JSON.stringify(entries);
  const context = buildSessionContext(entries,'u2',{tail:1});
  assert.deepEqual(context.entryIds,['u2']);
  assert.equal(JSON.stringify(entries),before);
  assert.equal(sliceActiveBranch(entries,'u2',1)[0],entries[1]);
});

test('rewrite retry re-resolves ALL cursor offsets and branch settings', async (t) => {
  const dir = mkdtempSync(join(tmpdir(),'pi-history-review-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file = join(dir,'snapshot.jsonl');
  const old = [entry('u1',null,'old'), entry('u2','u1','old leaf')];
  writeFileSync(file,serialize(old));
  const updated = [
    {type:'model_change',id:'model',parentId:null,provider:'review',modelId:'new',timestamp:'2026-01-01T00:00:00Z'},
    entry('u1','model','中文内容改变字节位置 '.repeat(120)),entry('u2','u1','new leaf')];
  const indexer = new SessionHistoryIndexer();
  let rewrote = false;
  indexer.seekReadHook = ()=> {
    if (!rewrote) { rewrote=true;writeFileSync(file,serialize(updated)); }
    return null;
  };
  const actual = JSON.parse(await indexer.queryContext(file,{leafId:'u2',tail:1})).context;
  assert.deepEqual(actual,JSON.parse(JSON.stringify(buildSessionContext(updated,'u2',{tail:1}))));
  assert.equal(readFileSync(file,'utf8'),serialize(updated));
});

test('live parsed history never rereads JSONL, scans catalogue or picks inactive branch', async () => {
  const entries = [entry('u1',null,'root'),entry('selected','u1','selected branch'),entry('other','u1','inactive branch')];
  for (const filePath of [undefined,'/persisted/live.jsonl']) {
    const live = {isAlive:()=>true,isRunning:()=>true,inner:{sessionManager:{getSessionFile:()=>filePath,getLeafId:()=> 'selected',getEntries:()=>entries}}};
    const response = await handleSessionContextRequest(new Request('http://localhost/api/sessions/review/context'),{id:'review'},{
      getRpc:()=>live,
      resolvePath:async()=> { throw Error('Must not resolve catalogue for live session'); },
      pool:{queryContext:async()=> { throw Error('Must not reread Agent-owned parsed history'); }}});
    assert.equal(response.status,200);
    assert.deepEqual((await response.json()).context.entryIds,['u1','selected']);
  }
});

test('v2 migration preserves stable pagination IDs and never writes the session', async (t) => {
  const dir = mkdtempSync(join(tmpdir(),'pi-v2-review-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file = join(dir,'legacy.jsonl');
  const contents = [{...header,version:2},entry('root',null,'hello'),entry('leaf','root','world')]
    .map(JSON.stringify).join('\n')+'\n{partial';
  writeFileSync(file,contents);
  const indexer = new SessionHistoryIndexer();
  const first = JSON.parse(await indexer.queryContext(file,{tail:1}));
  const previous = JSON.parse(await indexer.queryContext(file,{tail:1,before:first.context.oldestEntryId}));
  assert.deepEqual(first.context.entryIds,['leaf']);
  assert.deepEqual(previous.context.entryIds,['root']);
  assert.equal(previous.context.hasMore,false);
  assert.equal(readFileSync(file,'utf8'),contents);
});

test('v1 without persistent IDs fails explicitly rather than inventing unstable pagination IDs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(),'pi-v1-review-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file = join(dir,'legacy.jsonl');
  const contents = [{...header,version:1}, {type:'message',message:{role:'user',content:'hello'}}]
    .map(JSON.stringify).join('\n');
  writeFileSync(file,contents);
  await assert.rejects(new SessionHistoryIndexer().queryContext(file,{tail:1}),
    error=>error.statusCode===500 && /stable entry IDs/.test(error.message));
  assert.equal(readFileSync(file,'utf8'),contents);
});

test('queued cancellation unregisters listeners without touching active job', async (t) => {
  const dir=mkdtempSync(join(tmpdir(),'pi-pool-review-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const script=join(dir,'reply.cjs');
  writeFileSync(script,`const {parentPort}=require('node:worker_threads');parentPort.on('message',m=>setTimeout(()=>parentPort.postMessage({id:m.id,success:true,jsonString:'{}'}),100));`);
  const pool = new SessionHistoryPool({workerScriptPath:script,maxWorkers:1,requestTimeoutMs:1500});
  t.after(()=>pool.closeAll());
  const controller = new AbortController();
  const active = pool.queryContext('/same');
  const queued = pool.queryContext('/same',{signal:controller.signal});
  const rejected = assert.rejects(queued,e=>e.statusCode===499);
  assert.equal(pool.getQueueLength(),1);
  controller.abort();await rejected;
  assert.equal(pool.getQueueLength(),0);
  assert.equal(getEventListeners(controller.signal,'abort').length,0);
  assert.equal(await active,'{}');
  assert.equal(await pool.queryContext('/same'),'{}');
});
