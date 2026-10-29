import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'server-only':'next/dist/compiled/server-only/empty.js'}});
const {createSessionDeleteJobStore,DeleteJobError}=await jiti.import('./session-delete-jobs.ts');
const nativeId=n=>`codex:01900000-0000-7000-8000-${String(n).padStart(12,'0')}`;
const jobId=n=>`test-delete-job-${String(n).padStart(8,'0')}`;
async function sandbox(t){const root=await mkdtemp(join(tmpdir(),'session-delete-jobs-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function finish(store,id){for(let i=0;i<200;i++){const value=store.get(id);if(value.status!=='running')return value;await new Promise(r=>setTimeout(r,5));}throw Error('Isolated job did not finish');}
function executor(calls,gate){return async(ids,options)=>{options.onFrame?.({type:'start',total:ids.length});const results=[];for(let i=0;i<ids.length;i++){const id=ids[i];options.onFrame?.({type:'item-start',id,index:i+1,total:ids.length});calls.push(id);if(gate)await gate(id);const result={id,ok:true,state:'deleted'};results.push(result);options.onFrame?.({type:'result',processed:i+1,total:ids.length,result,deletedSessionIds:[id]});}options.onFrame?.({type:'done',processed:ids.length,total:ids.length,results,deletedSessionIds:ids,stopped:false});return{results,deletedSessionIds:ids,stopped:false};};}

test('intent is durable before dispatch; lost create ACK and duplicate admission do not replay deletion',async t=>{
 const root=await sandbox(t),calls=[];let release;const gate=new Promise(r=>release=r);
 const store=createSessionDeleteJobStore(root,{execute:executor(calls,()=>gate),identity:async()=> 'captured-identity'}),ids=[nativeId(1),nativeId(2)];
 const first=store.create(jobId(1),ids);assert.equal(first.status,'running');assert.equal(calls.length,0);const meta=JSON.parse(fs.readFileSync(join(root,'state/session-delete-jobs',jobId(1)+'.json')));assert.deepEqual(meta.ids,ids);
 store.create(jobId(1),ids);assert.throws(()=>store.create(jobId(1),[nativeId(3)]),e=>e instanceof DeleteJobError&&e.status===409);
 for(let i=0;!calls.length&&i<30;i++)await new Promise(r=>setTimeout(r,2));assert.equal(calls.length,1);
 // Abandoning the initial viewer and querying a fresh cursor does not cancel execution.
 const prefix=store.events(jobId(1),0);assert.equal(prefix.frames[0].frame.type,'start');release();
 const done=await finish(store,jobId(1));assert.equal(done.status,'completed');assert.deepEqual(calls,ids);
 store.create(jobId(1),ids);assert.deepEqual(calls,ids);const rest=store.events(jobId(1),prefix.lastSequence);assert(rest.frames.some(e=>e.frame.type==='done'));assert.equal(new Set(store.events(jobId(1),0).frames.map(e=>e.seq)).size,store.events(jobId(1),0).frames.length);
});

test('server chunks at 100 but exposes one ordered master operation and a single terminal receipt',async t=>{
 const root=await sandbox(t),calls=[],sizes=[];const real=executor(calls);
 const store=createSessionDeleteJobStore(root,{execute:async(ids,o)=>{sizes.push(ids.length);assert.equal(o.expectedCodexIdentity,'original-identity');return real(ids,o)},identity:async()=> 'original-identity'});
 const ids=Array.from({length:133},(_,i)=>nativeId(i+1));store.create(jobId(2),ids);await finish(store,jobId(2));assert.deepEqual(sizes,[100,33]);assert.deepEqual(calls,ids);
 const all=[];let cursor=0;for(;;){const page=store.events(jobId(2),cursor);all.push(...page.frames);cursor=all.at(-1)?.seq??0;if(cursor===page.lastSequence)break;}
 assert.equal(all.filter(e=>e.frame.type==='start').length,1);assert.equal(all.filter(e=>e.frame.type==='done').length,1);assert.equal(all.at(-1).frame.processed,133);assert.deepEqual(all.map(e=>e.seq),all.map((_,i)=>i+1));assert.equal(all.filter(e=>e.frame.type==='item-start').at(-1).frame.index,133);
});

test('an uncertain native result stops undispatched items without resubmission',async t=>{
 const root=await sandbox(t),calls=[];const ids=[nativeId(1),nativeId(2)];
 const store=createSessionDeleteJobStore(root,{identity:async()=> 'a',execute:async(chunk,o)=>{const id=chunk[0];calls.push(id);o.onFrame({type:'item-start',id,index:1,total:2});const result={id,ok:false,state:'unknown',error:'Native receipt unknown'};o.onFrame({type:'result',processed:1,total:2,result,deletedSessionIds:[]});return{results:[result,{id:chunk[1],ok:false,state:'not_started'}],deletedSessionIds:[],stopped:true};}});
 store.create(jobId(3),ids);const info=await finish(store,jobId(3));assert.equal(info.status,'stopped');assert.deepEqual(calls,[ids[0]]);const done=store.events(jobId(3),0).frames.at(-1).frame;assert.deepEqual(done.results.map(r=>r.state),['unknown','not_started']);
});

test('process-loss recovery preserves confirmed facts, marks in-flight unknown, never replays any item',async t=>{
 const root=await sandbox(t),dir=join(root,'state/session-delete-jobs'),id=jobId(4),ids=[nativeId(1),nativeId(2),nativeId(3)];fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(join(dir,id+'.json'),JSON.stringify({schema:1,id,ids,createdAt:new Date().toISOString(),ownerPid:2147483647,ownerTicks:'old',ownerRuntime:'retired-process'}));
 const frames=[{type:'start',total:3},{type:'item-start',id:ids[0],index:1,total:3},{type:'result',processed:1,total:3,result:{id:ids[0],ok:true,state:'deleted'},deletedSessionIds:[ids[0]]},{type:'item-start',id:ids[1],index:2,total:3}];
 fs.writeFileSync(join(dir,id+'.ndjson'),frames.map((frame,i)=>JSON.stringify({seq:i+1,frame})).join('\n')+'\n'+String.raw`{"seq":5,"frame":`);let writes=0;
 const store=createSessionDeleteJobStore(root,{execute:async()=>{writes++;throw Error('Must not dispatch')}});const recovered=store.get(id);assert.equal(recovered.status,'interrupted');const done=store.events(id,0).frames.at(-1).frame;assert.deepEqual(done.results.map(r=>r.state),['deleted','unknown','not_started']);assert.deepEqual(done.deletedSessionIds,[ids[0]]);const reloaded=createSessionDeleteJobStore(root);assert.equal(reloaded.get(id).status,'interrupted');store.create(id,ids);assert.equal(writes,0);assert.equal(store.events(id,0).frames.filter(e=>e.frame.type==='done').length,1);
});

test('invalid IDs and unavailable private storage never dispatch work',async t=>{
 const root=await sandbox(t);let writes=0;const store=createSessionDeleteJobStore(root,{execute:async()=>{writes++;throw Error('forbidden')}});
 assert.throws(()=>store.create('../escape', ['a']),DeleteJobError);assert.throws(()=>store.create(jobId(5),['../session']),DeleteJobError);assert.throws(()=>store.get(jobId(5)),e=>e.status===404);assert.equal(fs.existsSync(join(root,'state/session-delete-jobs')),false);
 fs.writeFileSync(join(root,'state'),'blocked');assert.throws(()=>store.create(jobId(5),['a']));assert.equal(writes,0);
});

test('separate accepted jobs remain serial and capture admission connection before waiting',async t=>{
 const root=await sandbox(t),calls=[];let release;const held=new Promise(r=>release=r);let connection='a';const bindings=[];
 const store=createSessionDeleteJobStore(root,{identity:async()=>connection,execute:async(ids,o)=>{bindings.push(o.expectedCodexIdentity);return executor(calls,ids[0]===nativeId(1)?()=>held:undefined)(ids,o)}});
 store.create(jobId(6),[nativeId(1)]);store.create(jobId(7),[nativeId(2)]);await new Promise(r=>setTimeout(r,10));connection='b';assert.deepEqual(calls,[nativeId(1)]);release();await finish(store,jobId(7));assert.deepEqual(bindings,['a','a']);assert.deepEqual(calls,[nativeId(1),nativeId(2)]);
});
