import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createJiti} from 'jiti';

const {createUsageLedgerWorker}=await createJiti(import.meta.url).import('./usage-ledger-worker.ts');
const fixture=async(t,source)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'usage-worker-'));
 const scriptPath=path.join(dir,'worker.cjs');await fs.writeFile(scriptPath,source);
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));return scriptPath;
};

test('CPU-heavy snapshots leave the request loop responsive and concurrent reads share one result',async t=>{
 const scriptPath=await fixture(t,`const {parentPort}=require('node:worker_threads');
 let requests=0;parentPort.on('message',({id,refresh})=>{
  requests++;const until=Date.now()+400;while(Date.now()<until){};
  const body=new TextEncoder().encode(JSON.stringify({requests,refresh,totalTokens:123}));
  parentPort.postMessage({id,body,status:200,mode:'native-local'},[body.buffer]);
 });`);
 const worker=createUsageLedgerWorker({scriptPath,timeoutMs:5000});t.after(()=>worker.close());
 let ticks=0;const timer=setInterval(()=>ticks++,10);t.after(()=>clearInterval(timer));
 const [a,b]=await Promise.all([worker.read(),worker.read()]);
 assert.equal(a,b);assert.ok(ticks>=10,`request loop stalled: ${ticks} ticks`);
 assert.deepEqual(JSON.parse(new TextDecoder().decode(a.body)),{requests:1,refresh:false,totalTokens:123});
 assert.equal(JSON.parse(new TextDecoder().decode((await worker.read(true)).body)).refresh,true);
});

test('unexpected worker exit fails the current read and a later read can start a new worker',async t=>{
 const scriptPath=await fixture(t,`process.exit(0);`);
 const worker=createUsageLedgerWorker({scriptPath,timeoutMs:1000});t.after(()=>worker.close());
 await assert.rejects(worker.read(),/exited/);
 await fs.writeFile(scriptPath,`const {parentPort}=require('node:worker_threads');parentPort.on('message',({id})=>parentPort.postMessage({id,body:new Uint8Array([123,125]),status:503,mode:'legacy-central'}));`);
 const result=await worker.read();assert.equal(result.status,503);assert.equal(result.mode,'legacy-central');
});

test('a hung worker has a bounded lifetime, rejecting every pending operation',async t=>{
 const scriptPath=await fixture(t,`require('node:worker_threads').parentPort.on('message',()=>{});`);
 const worker=createUsageLedgerWorker({scriptPath,timeoutMs:150});t.after(()=>worker.close());
 const results=await Promise.allSettled([worker.read(),worker.read(true)]);
 assert.ok(results.every(r=>r.status==='rejected'&&/timed out/.test(r.reason.message)));
});

test('malformed worker results cannot become a successful JSON response',async t=>{
 const scriptPath=await fixture(t,`require('node:worker_threads').parentPort.on('message',({id})=>require('node:worker_threads').parentPort.postMessage({id,body:'{}',status:200,mode:'native-local'}));`);
 const worker=createUsageLedgerWorker({scriptPath});t.after(()=>worker.close());
 await assert.rejects(worker.read(),/Invalid usage worker response/);
});
