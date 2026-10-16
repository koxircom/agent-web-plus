import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createJiti} from 'jiti';
import {execFileSync} from 'node:child_process';
const jiti=createJiti(import.meta.url,{moduleCache:false});
import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after} from 'node:test';
const dir=mkdtempSync(join(tmpdir(),'pi-prompt-durable-'));
after(()=>rmSync(dir,{recursive:true,force:true}));
const {createPromptDeliveryStore}=await jiti.import('./prompt-delivery.ts');
const delivery=createPromptDeliveryStore(dir),runPromptDelivery=delivery.run,getPromptReceipt=delivery.receipt;
const id=()=>crypto.randomUUID();
const recordPath=(sid,requestId)=>join(dir,'state','prompt-deliveries-v1',createHash('sha256').update(sid).digest('hex'),`${createHash('sha256').update(requestId).digest('hex')}.json`);
const command={type:'prompt',message:'同一段引导',streamingBehavior:'steer'};
test('receipt exists before preflight; simultaneous same-ID POST is admitted once',async()=>{
 const requestId=id();let count=0,finish;const wait=new Promise(r=>finish=r);
 const a=runPromptDelivery('A',requestId,command,async()=>{count++;await wait;return null;});
 const b=runPromptDelivery('A',requestId,command,async()=>{count++;});
 assert.equal(getPromptReceipt('A',requestId).status,'pending');await Promise.resolve();assert.equal(count,1);
 finish();await Promise.all([a,b]);assert.equal(getPromptReceipt('A',requestId).status,'accepted');
});
test('failed preflight has an explicit negative receipt; duplicate is not executed',async()=>{
 const requestId=id();let count=0;const execute=async()=>{count++;throw Error('invalid model');};
 await assert.rejects(runPromptDelivery('A',requestId,command,execute),/invalid model/);
 assert.deepEqual(getPromptReceipt('A',requestId),{status:'rejected',error:'invalid model'});
 await assert.rejects(runPromptDelivery('A',requestId,command,execute),/invalid model/);assert.equal(count,1);
});
test('same text with distinct request IDs is not suppressed; receipts are session scoped',async()=>{
 let count=0;const execute=async()=>{count++;};const requestId=id();
 await runPromptDelivery('A',requestId,command,execute);await runPromptDelivery('B',requestId,command,execute);
 await runPromptDelivery('A',id(),command,execute);assert.equal(count,3);
 assert.equal(getPromptReceipt('other',requestId).status,'unknown');
});
test('reusing an ID with different text or attachments fails closed',async()=>{
 const requestId=id();await runPromptDelivery('A',requestId,command,async()=>null);
 await assert.rejects(runPromptDelivery('A',requestId,{...command,message:'different'},async()=>null),/another submission/);
 await assert.rejects(runPromptDelivery('A',requestId,{...command,images:[{data:'eA==',mimeType:'image/png'}]},async()=>null),/another submission/);
 assert.equal(getPromptReceipt('A',requestId).status,'accepted');
});

test('saved inbox and same-ID deduplication survive a fresh store before transcript persistence',async()=>{
 const sid=id(),requestId=id();let runs=0;
 await delivery.run(sid,requestId,{message:'SSD writes',images:[{data:'eA==',mimeType:'image/png'}]},async()=>{runs++;assert.equal(createPromptDeliveryStore(dir).pending(sid)[0].message,'SSD writes')});
 const restarted=createPromptDeliveryStore(dir);
 assert.equal(restarted.receipt(sid,requestId).status,'accepted');assert.equal(restarted.pending(sid)[0].images[0].data,'eA==');
 await assert.rejects(restarted.run(sid,requestId,{message:'SSD writes',images:[{data:'eA==',mimeType:'image/png'}]},async()=>runs++),/already recorded/);
 assert.equal(runs,1);
});
test('only an actual native user entry can commit; fsynced receipt survives restart without retaining payload',async()=>{
 const sid=id(),requestId=id(),file=join(dir,'native.jsonl');
 await delivery.run(sid,requestId,{message:'original'},async()=>null);
 writeFileSync(file,JSON.stringify({type:'message',id:'assistant-only',message:{role:'assistant'}})+'\n');
 await assert.rejects(delivery.commit(sid,requestId,{sessionFile:file,entryId:'assistant-only'}),/not reached/);
 assert.equal(delivery.isCommitting(sid,requestId),false,'failed confirmation cannot retain an active commit owner');
 assert.equal(delivery.receipt(sid,requestId).status,'accepted');
 writeFileSync(file,JSON.stringify({type:'message',id:'native-user-entry',message:{role:'user',content:'expanded original'}})+'\n');
 await delivery.commit(sid,requestId,{sessionFile:file,entryId:'native-user-entry'});
 assert.deepEqual(createPromptDeliveryStore(dir).receipt(sid,requestId),{status:'committed',entryId:'native-user-entry'});
 assert.deepEqual(createPromptDeliveryStore(dir).pending(sid),[]);
});
test('commit before preflight POST resolves never gets downgraded to accepted',async()=>{
 const sid=id(),requestId=id(),file=join(dir,'early.jsonl');
 await delivery.run(sid,requestId,{message:'early'},async()=>{
 writeFileSync(file,JSON.stringify({type:'message',id:'early-user',message:{role:'user'}})+'\n');
 await delivery.commit(sid,requestId,{sessionFile:file,entryId:'early-user'});
 });assert.equal(delivery.receipt(sid,requestId).status,'committed');
});
test('disk unavailable refuses execution before the model can run',async()=>{
 const blocked=join(dir,'not-a-directory');writeFileSync(blocked,'x');let runs=0;
 const broken=createPromptDeliveryStore(blocked);
 await assert.rejects(async()=>broken.run(id(),id(),{message:'retain me'},async()=>runs++));assert.equal(runs,0);
});

test('process exit during admission retains the original and blocks execution in a replacement process',()=>{
 const sid=id(),requestId=id();
 const child=`import {createJiti} from 'jiti';const {createPromptDeliveryStore}=await createJiti(import.meta.url).import(${JSON.stringify(fileURLToPath(new URL('./prompt-delivery.ts',import.meta.url)))});const store=createPromptDeliveryStore(${JSON.stringify(dir)});await store.run(${JSON.stringify(sid)},${JSON.stringify(requestId)},{message:'crash-proof original'},async()=>process.exit(0));`;
 execFileSync(process.execPath,['--input-type=module','-e',child],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
 const restarted=createPromptDeliveryStore(dir);
 assert.equal(restarted.receipt(sid,requestId).status,'pending');assert.equal(restarted.pending(sid)[0].message,'crash-proof original');
 return assert.rejects(restarted.run(sid,requestId,{message:'crash-proof original'},async()=>assert.fail('must not replay')),/already recorded/);
});

test('large native entries crossing the tail window are confirmed without parsing the whole file at once',async()=>{
 const sid=id(),requestId=id(),file=join(dir,'large-entry.jsonl');
 await delivery.run(sid,requestId,{message:'large'},async()=>null);
 writeFileSync(file,JSON.stringify({type:'message',id:'large-user',message:{role:'user',content:'中文'.repeat(70000)}})+'\n');
 await delivery.commit(sid,requestId,{sessionFile:file,entryId:'large-user'});
 assert.equal(delivery.receipt(sid,requestId).status,'committed');
});
test('cancelled queue originals remain terminal after preflight resolution and restart',async()=>{
 const sid=id(),requestId=id();let finish;const gate=new Promise(r=>finish=r);
 const run=delivery.run(sid,requestId,{message:'removed'},async()=>gate);
 delivery.cancel(sid,requestId);finish();await run;
 const restarted=createPromptDeliveryStore(dir);
 assert.equal(restarted.receipt(sid,requestId).status,'cancelled');assert.deepEqual(restarted.pending(sid),[]);
 await assert.rejects(restarted.run(sid,requestId,{message:'removed'},async()=>assert.fail('cannot replay')),/already recorded/);
});

test('recall keeps the original recoverable across restart and beyond receipt retention',async()=>{
 const sid=id(),requestId=id(),original={message:'restore this original',images:[{data:'eA==',mimeType:'image/png'}]};
 await delivery.run(sid,requestId,original,async()=>null);
 delivery.recall(sid,requestId);
 assert.deepEqual(delivery.receipt(sid,requestId),{status:'recalled'});
 const recalled=delivery.pending(sid);
 assert.equal(recalled.length,1);
 assert.deepEqual({requestId:recalled[0].requestId,sessionId:recalled[0].sessionId,message:recalled[0].message,images:recalled[0].images,status:recalled[0].status},
  {requestId,sessionId:sid,message:original.message,images:original.images,status:'recalled'});

 const file=recordPath(sid,requestId),saved=JSON.parse(readFileSync(file,'utf8'));
 saved.at=Date.now()-48*60*60*1000;writeFileSync(file,JSON.stringify(saved));
 const restarted=createPromptDeliveryStore(dir);
 assert.deepEqual(restarted.receipt(sid,requestId),{status:'recalled'});
 assert.equal(restarted.pending(sid)[0].message,original.message);
 assert.deepEqual(restarted.pending(sid)[0].images,original.images);
 await assert.rejects(restarted.run(sid,requestId,original,async()=>assert.fail('recalled request must not execute again')),/already recorded/);
});

test('acknowledgeRecall only clears a recalled original and is idempotent',async()=>{
 const sid=id(),requestId=id(),original={message:'draft after recall'};
 await delivery.run(sid,requestId,original,async()=>null);
 await delivery.acknowledgeRecall(sid,requestId);
 assert.equal(delivery.receipt(sid,requestId).status,'accepted');
 assert.equal(delivery.pending(sid)[0].message,original.message);

 delivery.recall(sid,requestId);
 await delivery.acknowledgeRecall(sid,requestId);
 await delivery.acknowledgeRecall(sid,requestId);
 assert.equal(delivery.receipt(sid,requestId).status,'cancelled');
 assert.deepEqual(delivery.pending(sid),[]);
 assert.equal(JSON.parse(readFileSync(recordPath(sid,requestId),'utf8')).command,undefined);
 const restarted=createPromptDeliveryStore(dir);
 assert.equal(restarted.receipt(sid,requestId).status,'cancelled');
 assert.deepEqual(restarted.pending(sid),[]);
});

test('recall during async native-entry verification prevents a late commit',async()=>{
 const sid=id(),requestId=id(),file=join(dir,'recall-during-commit.jsonl');
 await delivery.run(sid,requestId,{message:'still recoverable'},async()=>null);
 writeFileSync(file,JSON.stringify({type:'message',id:'late-user-entry',message:{role:'user',content:'still recoverable'}})+'\n');
 const commit=delivery.commit(sid,requestId,{sessionFile:file,entryId:'late-user-entry'});
 assert.equal(delivery.isCommitting(sid,requestId),true,'a finished model run does not orphan an active disk confirmation');
 assert.equal(delivery.isCommitting(sid,id()),false,'commit ownership is request-scoped');
 delivery.recall(sid,requestId);
 await commit;
 assert.equal(delivery.isCommitting(sid,requestId),false);
 assert.deepEqual(delivery.receipt(sid,requestId),{status:'recalled'});
 assert.equal(delivery.pending(sid)[0].message,'still recoverable');
});

test('recalled queue originals remain recalled after late preflight resolution',async()=>{
 const sid=id(),requestId=id();let finish,signalStarted;const gate=new Promise(r=>finish=r),started=new Promise(r=>signalStarted=r);
 const run=delivery.run(sid,requestId,{message:'keep after recall'},async()=>{signalStarted();await gate;return null;});
 await started;
 delivery.recall(sid,requestId);
 finish();await run;
 assert.deepEqual(delivery.receipt(sid,requestId),{status:'recalled'});
 assert.equal(delivery.pending(sid)[0].message,'keep after recall');
});

test('a real persistence failure remains explicit across admission completion and process restart',async()=>{
 const sid=id(),requestId=id();await delivery.run(sid,requestId,{message:'keep after persistence failure'},async()=>delivery.unconfirmed(sid,requestId));
 const fresh=createPromptDeliveryStore(dir);assert.equal(fresh.receipt(sid,requestId).status,'unconfirmed');assert.equal(fresh.pending(sid)[0].message,'keep after persistence failure');assert.equal(fresh.pending(sid)[0].status,'unconfirmed');
 await assert.rejects(fresh.run(sid,requestId,{message:'keep after persistence failure'},async()=>assert.fail('must not replay')),/already recorded/);
});
