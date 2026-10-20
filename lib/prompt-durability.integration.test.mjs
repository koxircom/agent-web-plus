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
 await restarted.run(session.sessionId,b,{type:'prompt',requestId:b,message:'same original',streamingBehavior:'followUp'},async()=>{throw Error('must not execute')});
 assert.equal(restarted.receipt(session.sessionId,b).status,'committed');
 assert.equal(calls,3,'terminal retries acknowledge receipt without another model call');
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

for(const mode of ['duplicate-delete','batch-reorder']) test(`queue handoff keeps the task visible through a slow SDK user-message extension (${mode})`, {timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-queue-handoff-sdk-'));const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const firstGate=defer(),firstEntered=defer(),deliveryGate=defer(),deliveryEntered=defer();
 t.after(async()=>{firstGate.resolve();deliveryGate.resolve();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(dir,{recursive:true,force:true})});
 const jiti=createJiti(import.meta.url,{tsconfigPaths:true});const {runPromptDelivery,getPromptReceipt}=await jiti.import('./prompt-delivery.ts');const {AgentSessionWrapper}=await jiti.import('./rpc-manager.ts');
 const faux=fauxProvider({models:[{id:'fixture'}]});const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
 const settingsManager=SettingsManager.inMemory();let queuedObject;
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{pi.on('message_start',async e=>{if(e.message===queuedObject){deliveryEntered.resolve();await deliveryGate.promise;}})}]});await loader.reload();
 const manager=SessionManager.create(dir,join(dir,'sessions'));const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,modelRuntime:runtime,model:faux.getModel('fixture'),tools:[],sessionManager:manager,settingsManager});const wrapper=new AgentSessionWrapper(session);wrapper.beginExtensionBinding();await wrapper.waitUntilReady();wrapper.start();t.after(()=>wrapper.destroy());if(mode==='batch-reorder')session.agent.followUpMode='all';
 faux.setResponses([async()=>{firstEntered.resolve();await firstGate.promise;return fauxAssistantMessage('first done')},fauxAssistantMessage('queued done')]);
 const events=[];wrapper.onEvent(e=>events.push(e));const send=(id,text,behavior,images)=>{const cmd={type:'prompt',requestId:id,message:text,...(behavior?{streamingBehavior:behavior}:{}),...(images?{images}:{})};return runPromptDelivery(session.sessionId,id,cmd,()=>wrapper.send(cmd));};
 const png={type:'image',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5K0AAAAASUVORK5CYII=',mimeType:'image/png'};const first=crypto.randomUUID(),queued=crypto.randomUUID(),deleted=crypto.randomUUID();await send(first,'initial');await firstEntered.promise;await send(queued,'task must remain visible','followUp',[png]);queuedObject=session.agent.followUpQueue.messages[0];const secondText=mode==='batch-reorder'?'second task reordered first':'task must remain visible';await send(deleted,secondText,'followUp',[png,png]);if(mode==='batch-reorder'){queuedObject=session.agent.followUpQueue.messages[1];const order=await wrapper.send({type:'get_queue_actions'});await wrapper.send({type:'reorder_queued_message',tokens:order.followUp.map(x=>x.token),token:order.followUp[1].token,targetToken:order.followUp[0].token});}firstGate.resolve();await deliveryEntered.promise;if(mode==='duplicate-delete'){const raw=await wrapper.send({type:'get_queue_actions'});assert.equal(raw.followUp.length,1);assert.equal(raw.followUp[0].imageCount,2);const removed=await wrapper.send({type:'delete_queued_message',token:raw.followUp[0].token});assert.deepEqual(removed.cancelledPromptRequestIds,[deleted]);assert.equal(getPromptReceipt(session.sessionId,deleted).status,'cancelled');}
 assert.equal(session.agent.followUpQueue.messages.length,0,'SDK already dequeued while its extension is blocked');
 const state=await wrapper.send({type:'get_state'});
 assert.deepEqual(state.queuedMessages.followUp,mode==='batch-reorder'?['second task reordered first','task must remain visible']:['task must remain visible'],'client state must retain the task until the user entry is delivered');
 assert.equal(events.filter(e=>e.type==='queue_update').at(-1).followUp[0],mode==='batch-reorder'?'second task reordered first':'task must remain visible','SSE must not clear before chat delivery');
 assert.equal(getPromptReceipt(session.sessionId,queued).status,'accepted');
 assert.equal(wrapper.isPromptRequestActive(queued),true,'dequeued user delivery remains owned while its extension is pending');
 deliveryGate.resolve();await waitFor(()=>getPromptReceipt(session.sessionId,queued).status==='committed');await waitFor(()=>!wrapper.isRunning());
 assert.equal(wrapper.isPromptRequestActive(queued),false,'committed queued delivery releases runtime ownership');
 const delivered=events.find(e=>e.type==='message_end'&&e.requestId===queued);assert(delivered);assert.deepEqual(delivered.queuedMessages,{steering:[],followUp:[]});assert.equal(manager.getEntries().filter(e=>e.type==='message'&&e.message===queuedObject).length,1);
});

for (const kind of ['steer','followUp']) test(`Stop preserves accepted ${kind} queue and attachment until explicitly resumed`, {timeout:15000}, async t => {
 const dir=await mkdtemp(join(tmpdir(),'pi-stop-queue-sdk-'));const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const gate=defer(),entered=defer();t.after(async()=>{gate.resolve();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(dir,{recursive:true,force:true})});
 const jiti=createJiti(import.meta.url,{tsconfigPaths:true});const {runPromptDelivery,getPromptReceipt}=await jiti.import('./prompt-delivery.ts');const {AgentSessionWrapper}=await jiti.import('./rpc-manager.ts');
 const faux=fauxProvider({models:[{id:'fixture'}]});const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
 let extensionCommandCalls=0;const settingsManager=SettingsManager.inMemory();const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{pi.registerCommand("fixture-status",{description:"Status fixture",handler:async()=>{extensionCommandCalls++}})}]});await loader.reload();
 const manager=SessionManager.create(dir,join(dir,'sessions'));const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,modelRuntime:runtime,model:faux.getModel('fixture'),tools:[],sessionManager:manager,settingsManager});const wrapper=new AgentSessionWrapper(session);wrapper.beginExtensionBinding();await wrapper.waitUntilReady();wrapper.start();t.after(()=>wrapper.destroy());
 let calls=0;const fn=session.agent.streamFunction;session.agent.streamFunction=(...args)=>{if(!args[2]?.signal?.aborted)calls++;return fn(...args)};
 faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage('stopped first')},fauxAssistantMessage('continued'),fauxAssistantMessage('queued finished'),fauxAssistantMessage('late queued finished'),fauxAssistantMessage('preflight finished')]);
 const send=(message,behavior,images)=>{const id=crypto.randomUUID(),cmd={type:'prompt',requestId:id,message,...(behavior?{streamingBehavior:behavior}:{}),...(images?{images}:{})};return runPromptDelivery(session.sessionId,id,cmd,()=>wrapper.send(cmd)).then(()=>id)};
 await send('running first');await entered.promise;const png={type:'image',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5K0AAAAASUVORK5CYII=',mimeType:'image/png'};const queued=await send('queued task must not disappear',kind,[png]);
 const before=await wrapper.send({type:'get_queue_actions'});const list=kind==='steer'?'steering':'followUp';assert.equal(before[list].length,1);
 await wrapper.send({type:'abort'});gate.resolve();await waitFor(()=>!wrapper.isRunning());
 const after=await wrapper.send({type:'get_queue_actions'});assert.deepEqual(after[list].slice(0,1),before[list],'Stop preserves exact queue token and attachment');
 assert.equal(getPromptReceipt(session.sessionId,queued).status,'accepted');assert.equal(calls,1,'Stop cannot start queued work');
 const commandId=await send('/fixture-status',kind);assert.equal(extensionCommandCalls,1,'native commands still execute while queue is paused');await waitFor(()=>getPromptReceipt(session.sessionId,commandId).status==='committed');
 const late=await send('queue submission delayed past Stop',kind,[png]);
 assert.equal(calls,1,'A delayed queued submission after Stop must wait for explicit continuation');
 const paused=await wrapper.send({type:'get_queue_actions'});assert.equal(paused[list].length,2,'Stop preserves both admitted and delayed queue intents');
 assert.equal(getPromptReceipt(session.sessionId,late).status,'accepted');
 await send('continue explicitly');await waitFor(()=>!wrapper.isRunning());await waitFor(()=>getPromptReceipt(session.sessionId,queued).status==='committed'&&getPromptReceipt(session.sessionId,late).status==='committed');
 const disk=SessionManager.open(manager.getSessionFile());assert.equal(disk.getEntries().filter(e=>e.type==='message'&&e.message.role==='user'&&e.message.content.some(p=>p.type==='text'&&p.text==='queued task must not disappear')).length,1);
});

test('Stop during SDK preflight reaches idle and delivers the admitted user message without a model request', {timeout:15000}, async t => {
 const dir=await mkdtemp(join(tmpdir(),'pi-stop-queue-sdk-'));const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const gate=defer(),entered=defer(),inputGate=defer(),inputEntered=defer();t.after(async()=>{gate.resolve();inputGate.resolve();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;await rm(dir,{recursive:true,force:true})});
 const jiti=createJiti(import.meta.url,{tsconfigPaths:true});const {runPromptDelivery,getPromptReceipt}=await jiti.import('./prompt-delivery.ts');const {AgentSessionWrapper}=await jiti.import('./rpc-manager.ts');
 const faux=fauxProvider({models:[{id:'fixture'}]});const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
 const settingsManager=SettingsManager.inMemory();const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{pi.on("input",async e=>{if(e.text==="preflight task") {inputEntered.resolve();await inputGate.promise;}})}]});await loader.reload();
 const manager=SessionManager.create(dir,join(dir,'sessions'));const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,modelRuntime:runtime,model:faux.getModel('fixture'),tools:[],sessionManager:manager,settingsManager});const wrapper=new AgentSessionWrapper(session);wrapper.beginExtensionBinding();await wrapper.waitUntilReady();wrapper.start();t.after(()=>wrapper.destroy());
 let calls=0;const fn=session.agent.streamFunction;session.agent.streamFunction=(...args)=>{if(!args[2]?.signal?.aborted)calls++;return fn(...args)};
 faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage('stopped first')},fauxAssistantMessage('continued'),fauxAssistantMessage('queued finished'),fauxAssistantMessage('late queued finished'),fauxAssistantMessage('preflight finished')]);
 const send=(message,behavior,images)=>{const id=crypto.randomUUID(),cmd={type:'prompt',requestId:id,message,...(behavior?{streamingBehavior:behavior}:{}),...(images?{images}:{})};return runPromptDelivery(session.sessionId,id,cmd,()=>wrapper.send(cmd)).then(()=>id)};
 await send('running first');await entered.promise;
 const incoming=send('preflight task','followUp');await inputEntered.promise;
 await wrapper.send({type:'abort'});gate.resolve();await waitFor(()=>session.isIdle);inputGate.resolve();const id=await incoming;
 await waitFor(()=>!wrapper.isRunning());await waitFor(()=>getPromptReceipt(session.sessionId,id).status==='committed');
 assert(manager.getEntries().some(e=>e.type==='message'&&e.message.role==='user'&&e.message.content.some(p=>p.type==='text'&&p.text==='preflight task')));
 assert.equal(calls,1,'an aborted preflight never calls the model for this message');
});
