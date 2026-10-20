import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
const dir=mkdtempSync(join(tmpdir(),'pi-queue-recovery-'));
process.env.PI_CODING_AGENT_DIR=dir;
test.after(()=>rmSync(dir,{recursive:true,force:true}));
const jiti=createJiti(import.meta.url,{alias:{'@':new URL('..',import.meta.url).pathname,'server-only':'next/dist/compiled/server-only/empty.js'}});
const {createPromptDeliveryStore,runPromptDelivery,getPromptReceipt}=await jiti.import('./prompt-delivery.ts');
const {GET}=await jiti.import('../app/api/agent/[id]/route.ts');
const id=()=>crypto.randomUUID();
const command={type:'prompt',message:'排队原文',images:[{data:'eA==',mimeType:'image/png'}],streamingBehavior:'followUp'};
const read=async(sid,query='?inbox=1')=>{const r=await GET(new Request('http://fixture/api'+query),{params:Promise.resolve({id:sid})});assert.equal(r.status,200);return r.json()};

test('restart transfers an orphan to durable recall, preserving exact original and images without execution',async()=>{
 const sid=id(),rid=id();let calls=0;const d=createPromptDeliveryStore(dir);await d.run(sid,rid,command,async()=>calls++);
 const fresh=createPromptDeliveryStore(dir);fresh.recoverInterrupted(sid,()=>false);
 assert.deepEqual(fresh.receipt(sid,rid),{status:'recalled',reason:'runtime_exit'});
 const [row]=fresh.pending(sid);assert.equal(row.message,command.message);assert.deepEqual(row.images,command.images);assert.equal(row.recoveryReason,'runtime_exit');
 fresh.recoverInterrupted(sid,()=>assert.fail('recovered record must be terminal'));
 await fresh.run(sid,rid,command,async()=>calls++);assert.equal(calls,1);
 assert.equal(createPromptDeliveryStore(dir).pending(sid)[0].message,command.message);
 fresh.acknowledgeRecall(sid,rid);assert.equal(createPromptDeliveryStore(dir).receipt(sid,rid).status,'cancelled');assert.deepEqual(fresh.pending(sid),[]);
});
test('admission flight and exact live queue owner block orphan recovery; absence afterwards permits recovery',async()=>{
 const d=createPromptDeliveryStore(dir),sid=id(),rid=id();let finish;const gate=new Promise(r=>finish=r);const flight=d.run(sid,rid,command,()=>gate);
 d.recoverInterrupted(sid,()=>false);assert.equal(d.receipt(sid,rid).status,'pending');finish();await flight;
 d.recoverInterrupted(sid,r=>r===rid);assert.equal(d.receipt(sid,rid).status,'accepted');
 d.recoverInterrupted(sid,()=>false);assert.equal(d.receipt(sid,rid).status,'recalled');
});
test('native entry fsync wins over recovery, terminal and ordinary nonqueue submissions are untouched',async()=>{
 const d=createPromptDeliveryStore(dir),sid=id(),rid=id(),file=join(dir,'native.jsonl');await d.run(sid,rid,command,async()=>null);
 writeFileSync(file,JSON.stringify({type:'message',id:'native-user',message:{role:'user'}})+'\n');
 const commit=d.commit(sid,rid,{sessionFile:file,entryId:'native-user'});assert.equal(d.isCommitting(sid,rid),true);
 d.recoverInterrupted(sid,()=>false);assert.equal(d.receipt(sid,rid).status,'accepted');await commit;d.recoverInterrupted(sid,()=>false);assert.equal(d.receipt(sid,rid).status,'committed');
 const ordinary=id();await d.run(sid,ordinary,{message:'ordinary'},async()=>null);d.recoverInterrupted(sid,()=>false);assert.equal(d.receipt(sid,ordinary).status,'accepted');
});
test('Pi GET inbox and receipt recover, including when a new idle wrapper exists; Codex uses its own owner',async()=>{
 const sid=id(),rid=id();await runPromptDelivery(sid,rid,command,async()=>null);
 globalThis.__piSessions=new Map([[sid,{isAlive:()=>true,isPromptRequestActive:()=>false}]]);
 try {const inbox=await read(sid);assert.equal(inbox.uncommittedPrompts[0].status,'recalled');assert.equal((await read(sid,'?requestId='+rid)).reason,'runtime_exit');}
 finally {globalThis.__piSessions.delete(sid)}
 const codex='codex:'+id(),native=id();await runPromptDelivery(codex,native,command,async()=>null);
 assert.equal((await read(codex)).uncommittedPrompts[0].status,'accepted');assert.equal(getPromptReceipt(codex,native).status,'accepted');
});
test('Pi GET cannot recall an active or still-disposing wrapper request',async()=>{
 for(const live of [true,false]){const sid=id(),rid=id();await runPromptDelivery(sid,rid,command,async()=>null);globalThis.__piSessions=new Map([[sid,{isAlive:()=>live,isPromptRequestActive:()=>true}]]);
 try {assert.equal((await read(sid)).uncommittedPrompts[0].status,'accepted')}finally{globalThis.__piSessions.delete(sid)}}
});
test('inbox order is admission time, independent of hashed filename order',async()=>{
 const sid=id(),d=createPromptDeliveryStore(dir);for(const message of ['first','second','third'])await d.run(sid,id(),{...command,message},async()=>null);
 const fresh=createPromptDeliveryStore(dir);assert.deepEqual(fresh.pending(sid).map(r=>r.createdAt),fresh.pending(sid).map(r=>r.createdAt).sort((a,b)=>a-b));
});
