import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
const waitFor=async fn=>{const until=Date.now()+3000;while(!fn()){if(Date.now()>until)assert.fail('receipt confirmation timed out');await new Promise(r=>setTimeout(r,5));}};
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve}};

test('real SDK: recall receipts survive a dropped response while distinct same-text IDs still execute once', {timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-prompt-durability-sdk-'));
 const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 t.after(async()=>{if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(dir,{recursive:true,force:true})});
 const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
 const {runPromptDelivery,getPromptReceipt,getPromptEntryIds,createPromptDeliveryStore}=await jiti.import('./prompt-delivery.ts');
 const {AgentSessionWrapper}=await jiti.import('./rpc-manager.ts');
 const faux=fauxProvider({models:[{id:'fixture'}]});
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
 const settingsManager=SettingsManager.inMemory();
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await loader.reload();
 const manager=SessionManager.create(dir,join(dir,'sessions'));
 const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,modelRuntime:runtime,model:faux.getModel('fixture'),tools:[],sessionManager:manager,settingsManager});
 const wrapper=new AgentSessionWrapper(session);wrapper.beginExtensionBinding();await wrapper.waitUntilReady();wrapper.start();t.after(()=>wrapper.destroy());
 const gate=defer(),entered=defer(),settled=defer();t.after(()=>gate.resolve());
 session.subscribe(event=>{if(event.type==='agent_settled')settled.resolve()});
 let calls=0;const stream=session.agent.streamFunction;session.agent.streamFunction=(...args)=>{calls++;return stream(...args)};
 faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage([fauxText('first finished')])},fauxAssistantMessage([fauxText('queue first finished')]),fauxAssistantMessage([fauxText('queue second finished')])]);
 const send=(requestId,message,streamingBehavior)=>{const command={type:'prompt',requestId,message,...(streamingBehavior?{streamingBehavior}:{})};return runPromptDelivery(session.sessionId,requestId,command,()=>wrapper.send(command))};
 const deliveryEvents=[],userEndEvents=[];
 wrapper.onEvent(event=>{if(event.type==='message_end'&&event.message?.role==='user')userEndEvents.push(event);if(event.type==='prompt_delivery'){
  deliveryEvents.push(event);
  if(event.receipt.status==='committed')assert.equal(createPromptDeliveryStore(dir).receipt(session.sessionId,event.requestId).status,'committed','event follows the durable receipt on disk');
 }});
 const initial=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();
 await send(initial,'same original');await entered.promise;
 assert.equal(wrapper.isPromptRequestActive(initial),true,'the exact request remains active while its SDK run is gated');
 assert.equal(wrapper.isPromptRequestActive(a),false,'another request ID is not active just because this session is running');
 const orphan=crypto.randomUUID();
 await runPromptDelivery(session.sessionId,orphan,{type:'prompt',requestId:orphan,message:'accepted without wrapper ownership'},async()=>{});
 assert.equal(getPromptReceipt(session.sessionId,orphan).status,'accepted');
 assert.equal(wrapper.isPromptRequestActive(orphan),false,'an accepted orphan has no request-scoped wrapper ownership');
 createPromptDeliveryStore(dir).cancel(session.sessionId,orphan);
 await waitFor(()=>getPromptReceipt(session.sessionId,initial).status==='committed');
 assert.equal(getPromptReceipt(session.sessionId,initial).status,'committed','user entry is saved before a model reply');
 assert.equal(userEndEvents[0].requestId,initial,'the original SSE event carries the exact request identity without delaying SDK event order');
 assert.equal(getPromptEntryIds(session.sessionId)[initial],getPromptReceipt(session.sessionId,initial).entryId,'history can reconcile the same native entry via the existing receipt store');
 const queuePrompt=async(message)=>{
  const requestId=crypto.randomUUID();await send(requestId,message,'followUp');
  const snapshot=await wrapper.send({type:'get_queue_actions'});
  assert.equal(wrapper.isPromptRequestActive(requestId),true,'the exact followUp remains active while its SDK queue object is pending');
  return {requestId,tokens:snapshot.followUp.map(item=>item.token)};
 };

 const deleted=await queuePrompt('same original');
 const deleteResult=await wrapper.send({type:'delete_queued_message',token:deleted.tokens[0]});
 assert.deepEqual(deleteResult.cancelledPromptRequestIds,[deleted.requestId]);
 assert.equal(wrapper.isPromptRequestActive(deleted.requestId),false,'deleting the SDK queue object clears its request ownership');
 assert.equal(createPromptDeliveryStore(dir).receipt(session.sessionId,deleted.requestId).status,'cancelled');
 assert.deepEqual(createPromptDeliveryStore(dir).pending(session.sessionId),[]);

 const returnedRecall=await queuePrompt('single recall response');
 const recallResult=await wrapper.send({type:'recall_queued_message',token:returnedRecall.tokens[0]});
 assert.deepEqual(recallResult.cancelledPromptRequestIds,[]);
 assert.deepEqual(recallResult.recalledPromptRequestIds,[returnedRecall.requestId]);
 assert.equal(wrapper.isPromptRequestActive(returnedRecall.requestId),false,'recalling the SDK queue object clears its request ownership');
 const returnedStore=createPromptDeliveryStore(dir);
 assert.equal(returnedStore.pending(session.sessionId).find(row=>row.requestId===returnedRecall.requestId).message,'single recall response');
 await returnedStore.acknowledgeRecall(session.sessionId,returnedRecall.requestId);

 const recalled=await queuePrompt('restore original after a lost response');
 // Discard the successful RPC result to model a response lost after the server
 // removed the SDK queue item. A fresh store must still recover the exact text.
 await wrapper.send({type:'recall_queued_message',token:recalled.tokens[0]});
 const recoveryStore=createPromptDeliveryStore(dir);
 assert.equal(recoveryStore.receipt(session.sessionId,recalled.requestId).status,'recalled');
 assert.deepEqual(recoveryStore.pending(session.sessionId).map(row=>({requestId:row.requestId,message:row.message,status:row.status})),
  [{requestId:recalled.requestId,message:'restore original after a lost response',status:'recalled'}]);
 assert.equal(calls,1,'a recalled item is not executed by the SDK');
 await recoveryStore.acknowledgeRecall(session.sessionId,recalled.requestId);
 await recoveryStore.acknowledgeRecall(session.sessionId,recalled.requestId);
 assert.equal(recoveryStore.receipt(session.sessionId,recalled.requestId).status,'cancelled');
 assert.deepEqual(recoveryStore.pending(session.sessionId),[]);
 assert.equal(createPromptDeliveryStore(dir).receipt(session.sessionId,recalled.requestId).status,'cancelled');

 const batchRecall=[await queuePrompt('recall batch one'),await queuePrompt('recall batch two')];
 const batchSnapshot=await wrapper.send({type:'get_queue_actions'});
 const recallAll=await wrapper.send({type:'recall_all_queued_messages',tokens:batchSnapshot.followUp.map(item=>item.token)});
 assert.deepEqual(recallAll.cancelledPromptRequestIds,[]);
 assert.deepEqual(recallAll.recalledPromptRequestIds,batchRecall.map(row=>row.requestId));
 const batchRecovery=createPromptDeliveryStore(dir);
 const recoveredBatchById=new Map(batchRecovery.pending(session.sessionId).map(row=>[row.requestId,row]));
 for(const [index,row] of batchRecall.entries()){
  const recovered=recoveredBatchById.get(row.requestId);
  assert.ok(recovered,`missing recalled prompt ${row.requestId}`);
  assert.deepEqual({requestId:recovered.requestId,message:recovered.message,status:recovered.status},
   {requestId:row.requestId,message:index===0?'recall batch one':'recall batch two',status:'recalled'});
 }
 for(const row of batchRecall) await batchRecovery.acknowledgeRecall(session.sessionId,row.requestId);
 assert.equal(createPromptDeliveryStore(dir).pending(session.sessionId).filter(row=>batchRecall.some(item=>item.requestId===row.requestId)).length,0);

 const cleared=await queuePrompt('clear explicitly');
 const clearResult=await wrapper.send({type:'clear_queue'});
 assert.deepEqual(clearResult.cancelledPromptRequestIds,[cleared.requestId]);
 assert.equal(createPromptDeliveryStore(dir).receipt(session.sessionId,cleared.requestId).status,'cancelled');
 assert.equal(calls,1,'deleted, recalled, and cleared queued prompts never reach the model');
 await send(a,'same original','followUp');await send(b,'same original','followUp');
 assert.equal(getPromptReceipt(session.sessionId,a).status,'accepted');assert.equal(getPromptReceipt(session.sessionId,b).status,'accepted');
 const fresh=createPromptDeliveryStore(dir);assert.equal(fresh.pending(session.sessionId).length,2,'unconsumed queue originals survive a server restart');
 gate.resolve();await settled.promise;await new Promise(resolve=>setImmediate(resolve));
 await waitFor(()=>[initial,a,b].every(id=>getPromptReceipt(session.sessionId,id).status==='committed'));
 for(const requestId of [initial,a,b])assert.equal(wrapper.isPromptRequestActive(requestId),false,'consuming and settling the exact request clears its active ownership');
 const receipts=[initial,a,b].map(id=>getPromptReceipt(session.sessionId,id));
 assert(receipts.every(row=>row.status==='committed'),JSON.stringify(receipts));assert.equal(new Set(receipts.map(row=>row.entryId)).size,3);
 const disk=SessionManager.open(manager.getSessionFile());const users=disk.getEntries().filter(e=>e.type==='message'&&e.message.role==='user');assert.equal(users.length,3);
 const restarted=createPromptDeliveryStore(dir);assert.equal(restarted.receipt(session.sessionId,b).status,'committed');
 assert.deepEqual(restarted.pending(session.sessionId),[]);assert.equal(calls,3);
 for(const requestId of [initial,a,b])assert.equal(deliveryEvents.filter(event=>event.requestId===requestId&&event.receipt.status==='committed').length,1,'one durable push per exact request ID');
 await assert.rejects(restarted.run(session.sessionId,b,{type:'prompt',requestId:b,message:'same original',streamingBehavior:'followUp'},async()=>{throw Error('must not execute')}),/already recorded/);
 const bytes=await readFile(manager.getSessionFile(),'utf8');assert(bytes.includes(receipts[2].entryId));
 // Exercise the actual persistence-error push without deleting or truncating
 // the SDK transcript. The inbox remains the durable owner; no model replay.
 const failed=crypto.randomUUID();
 await runPromptDelivery(session.sessionId,failed,{type:'prompt',requestId:failed,message:'retain after fsync evidence failure'},async()=>{
  wrapper.confirmPromptDelivery(failed,{sessionFile:join(dir,'missing-transcript.jsonl'),entryId:'missing-entry'});
 });
 await waitFor(()=>deliveryEvents.some(event=>event.requestId===failed&&event.receipt.status==='unconfirmed'));
 assert.equal(createPromptDeliveryStore(dir).receipt(session.sessionId,failed).status,'unconfirmed');
 assert.equal(createPromptDeliveryStore(dir).pending(session.sessionId).find(row=>row.requestId===failed).message,'retain after fsync evidence failure');
 assert.equal(calls,3,'persistence failure never replays the model request');
 const destroyGate=defer(),destroyEntered=defer();t.after(()=>destroyGate.resolve());
 faux.setResponses([async()=>{destroyEntered.resolve();await destroyGate.promise;return fauxAssistantMessage([fauxText('destroyed run')])}]);
 const destroyHolder=crypto.randomUUID(),destroyQueued=crypto.randomUUID();
 const destroyRun=runPromptDelivery(session.sessionId,destroyHolder,{type:'prompt',requestId:destroyHolder,message:'destroy while active'},()=>wrapper.send({type:'prompt',requestId:destroyHolder,message:'destroy while active'})).catch(()=>undefined);
 await destroyEntered.promise;
 await send(destroyQueued,'destroy queued followUp','followUp');
 assert.equal(wrapper.isPromptRequestActive(destroyHolder),true,'destroy fixture has an active SDK run');
 assert.equal(wrapper.isPromptRequestActive(destroyQueued),true,'destroy fixture has an exact queued followUp');
 wrapper.destroy();
 assert.equal(wrapper.isPromptRequestActive(destroyHolder),false,'destroy clears active run ownership');
 assert.equal(wrapper.isPromptRequestActive(destroyQueued),false,'destroy clears queued request ownership');
 destroyGate.resolve();await destroyRun;
});
