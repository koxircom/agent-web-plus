import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,readFileSync,writeFileSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';import{createJiti}from'jiti';
const dir=mkdtempSync(join(tmpdir(),'shared-queue-'));process.env.PI_CODING_AGENT_DIR=dir;test.after(()=>rmSync(dir,{recursive:true,force:true}));
const jiti=createJiti(import.meta.url,{alias:{'@':new URL('..',import.meta.url).pathname,'server-only':'next/dist/compiled/server-only/empty.js'}}),{createPromptDeliveryStore}=await jiti.import('./prompt-delivery.ts');
test('durable inbox changes notify both clients in the same session; observers cannot break admission',async()=>{
 const d=createPromptDeliveryStore(dir),a=[],b=[],other=[];const offA=d.subscribe('A',(id,r)=>a.push([id,r.status])),offB=d.subscribe('A',(id,r)=>b.push([id,r.status])),offOther=d.subscribe('B',(id,r)=>other.push([id,r.status]));d.subscribe('A',()=>{throw Error('observer disconnected')});let calls=0;const id=crypto.randomUUID();await d.run('A',id,{message:'shared'},async()=>calls++);
 assert.equal(calls,1);assert.deepEqual(a,[[id,'pending'],[id,'accepted']]);assert.deepEqual(a,b);assert.deepEqual(other,[]);offA();offB();offOther();
});
test('terminal tombstones survive the old retention boundary; same ID never executes again',async()=>{
 const sid=crypto.randomUUID(),rid=crypto.randomUUID(),d=createPromptDeliveryStore(dir),command={message:'once'};let calls=0;await d.run(sid,rid,command,async()=>calls++);await d.commit(sid,rid,{handled:true});
 const hash=x=>createHash('sha256').update(x).digest('hex'),file=join(dir,'state','prompt-deliveries-v1',hash(sid),hash(rid)+'.json'),row=JSON.parse(readFileSync(file));row.at=Date.now()-72*3600e3;writeFileSync(file,JSON.stringify(row));const fresh=createPromptDeliveryStore(dir);assert.equal(fresh.receipt(sid,rid).status,'committed');await fresh.run(sid,rid,command,async()=>calls++);assert.equal(calls,1);assert.equal(JSON.parse(readFileSync(file)).command,undefined);
});
test('queue inbox reads do not create a Codex runtime or require a configured engine',async()=>{
 const {GET}=await jiti.import('../app/api/agent/[id]/route.ts');const sid='codex:'+crypto.randomUUID();const response=await GET(new Request('http://fixture/api?inbox=1'),{params:Promise.resolve({id:sid})});assert.equal(response.status,200);assert.deepEqual(await response.json(),{uncommittedPrompts:[]});
});
test('automatic HTTP handoff reuses the saved identity and attachments',async t=>{
 const store=await jiti.import('./prompt-submissions.ts'),client=await jiti.import('./agent-client.ts');
 const oldFetch=globalThis.fetch,oldWindow=globalThis.window;const disk=new Map();globalThis.window={sessionStorage:{getItem:k=>disk.get(k)||null,setItem:(k,v)=>disk.set(k,v),removeItem:k=>disk.delete(k)}};t.after(()=>{globalThis.fetch=oldFetch;if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow});
 const row={requestId:crypto.randomUUID(),sessionId:'A',message:'offline text',images:[{data:'eA==',mimeType:'image/png'}],streamingBehavior:'followUp',status:'uncertain',createdAt:Date.now(),deliveryProtocol:2};await store.retainPromptSubmission(row);let posted;
 globalThis.fetch=async(_u,init)=>{assert.equal(init.method,'POST');posted=JSON.parse(init.body);return Response.json({success:true,receipt:{status:'accepted'}})};await client.handoffUnsubmittedPrompt(row);assert.equal(posted.requestId,row.requestId);assert.deepEqual(posted.images,row.images);assert.equal(posted.streamingBehavior,'followUp');assert.equal(store.getPendingPromptSubmissions().length,1);store.releasePromptSubmission(row.requestId);
});
