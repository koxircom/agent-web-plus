import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
const {AgentSessionWrapper}=await createJiti(import.meta.url,{tsconfigPaths:true}).import('./rpc-manager.ts');
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
test('current tool continuation stays unchanged; queued user input activates durable model and thinking choices', {timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-next-turn-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const faux=fauxProvider({models:[{id:'old',reasoning:true},{id:'new',reasoning:true}]});
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
 const settingsManager=SettingsManager.inMemory();
 const resourceLoader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await resourceLoader.reload();
 const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader,modelRuntime:runtime,model:faux.getModel('old'),thinkingLevel:'low',tools:['ls'],sessionManager:SessionManager.inMemory(dir),settingsManager});
 const wrapper=new AgentSessionWrapper(session);wrapper.beginExtensionBinding();await wrapper.waitUntilReady();t.after(()=>wrapper.destroy());
 const gate=deferred(),entered=deferred(),calls=[];const stream=session.agent.streamFunction;
 session.agent.streamFunction=(model,context,options)=>{calls.push({model:model.id,reasoning:options.reasoning});return stream(model,context,options)};
 faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage([fauxToolCall('ls',{path:'.'})],{stopReason:'toolUse'})},fauxAssistantMessage([fauxText('当前任务完成')]),fauxAssistantMessage([fauxText('下一轮完成')])]);
 const running=session.prompt('当前任务');t.after(()=>gate.resolve());await Promise.race([entered.promise,running.then(()=>{throw new Error('provider not entered')})]);
 try {
  await wrapper.send({type:'set_model',provider:faux.provider.id,modelId:'new'});
  await wrapper.send({type:'set_thinking_level',level:'high'});
  assert.equal(session.model.id,'old');assert.equal(session.thinkingLevel,'low');
  const pending=session.sessionManager.getBranch().findLast(e=>e.type==='custom'&&e.customType==='next-turn-settings');assert.equal(pending.data.model.id,'new');assert.equal(pending.data.thinkingLevel,'high');
  await session.followUp('下一条用户消息');
 } finally {gate.resolve()}
 await running;
 assert.deepEqual(calls,[{model:'old',reasoning:'low'},{model:'old',reasoning:'low'},{model:'new',reasoning:'high'}]);
 assert.equal(session.model.id,'new');assert.equal(session.thinkingLevel,'high');
 assert.deepEqual(wrapper.nextTurnSettings,{});assert.equal(session.pendingMessageCount,0);
});
test('pending choices restore from transcript, invalid choices fail, and idle input applies them before admission',async t=>{
 const manager=SessionManager.inMemory('/tmp/pi-next-turn-owned');manager.appendMessage({role:'user',content:[{type:'text',text:'已完成'}],timestamp:1});
 const calls=[],model={id:'old',provider:'owned',reasoning:true},next={id:'new',provider:'owned',reasoning:true};
 const inner={sessionId:'pending-fixture',isStreaming:true,isCompacting:false,isBashRunning:false,model,sessionManager:manager,agent:{state:{thinkingLevel:'low'}},extensionRunner:{getRegisteredCommands:()=>[]},modelRuntime:{getModel:(_p,id)=>id==='new'?next:id==='old'?model:undefined,refresh:async()=>{},checkAuth:async()=>true},setModel:async m=>{calls.push(m.id);inner.model=m},setThinkingLevel:l=>{calls.push(l);inner.agent.state.thinkingLevel=l},dispose(){}};
 const first=new AgentSessionWrapper(inner);first.extensionsBound=true;
 await first.send({type:'set_model',provider:'owned',modelId:'new'});await first.send({type:'set_thinking_level',level:'high'});
 await assert.rejects(first.send({type:'set_thinking_level',level:'unknown'}),/参数无效/);
 await assert.rejects(first.send({type:'set_model',provider:'owned',modelId:'missing'}),/模型不存在/);assert.deepEqual(calls,[]);
 const restored=new AgentSessionWrapper(inner);restored.extensionsBound=true;t.after(()=>{first.destroy();restored.destroy()});
 assert.equal(restored.nextTurnSettings.model.id,'new');inner.isStreaming=false;await restored.applyNextTurnSettings();assert.deepEqual(calls,['new','high']);assert.deepEqual(restored.nextTurnSettings,{});
});

test('running model switch clamps max to Flash high without altering the current provider request', {timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-thinking-flash-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const faux=fauxProvider({models:[{id:'old',reasoning:true},{id:'flash',reasoning:true}]});
 const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
 const old=runtime.getModel(faux.provider.id,'old'),flash=runtime.getModel(faux.provider.id,'flash');
 old.thinkingLevelMap={max:'max',xhigh:'xhigh'};flash.thinkingLevelMap={off:null,minimal:null,low:'low',medium:'medium',high:'high',xhigh:null,max:null};
 const settingsManager=SettingsManager.inMemory({defaultThinkingLevel:'max'});
 const resourceLoader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});await resourceLoader.reload();
 const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader,modelRuntime:runtime,model:old,thinkingLevel:'max',tools:[],sessionManager:SessionManager.inMemory(dir),settingsManager});
 const wrapper=new AgentSessionWrapper(session);wrapper.beginExtensionBinding();await wrapper.waitUntilReady();t.after(()=>wrapper.destroy());
 const gate=deferred(),entered=deferred(),calls=[],stream=session.agent.streamFunction;
 session.agent.streamFunction=(model,context,options)=>{calls.push({model:model.id,reasoning:options.reasoning});return stream(model,context,options)};
 faux.setResponses([async()=>{entered.resolve();await gate.promise;return fauxAssistantMessage([fauxText('当前请求完成')])},fauxAssistantMessage([fauxText('Flash完成')])]);
 const running=session.prompt('当前任务');t.after(()=>gate.resolve());await entered.promise;
 try {
  const selected=await wrapper.send({type:'set_model',provider:faux.provider.id,modelId:'flash'});
  assert.equal(selected.thinkingLevel,'high');assert.equal(wrapper.nextTurnSettings.thinkingLevel,'high');assert.equal(session.model.id,'old');assert.equal(session.thinkingLevel,'max');
  const level=await wrapper.send({type:'set_thinking_level',level:'max'});assert.equal(level.thinkingLevel,'high');
  await session.followUp('下一轮');
 }finally{gate.resolve()}
 await running;assert.deepEqual(calls,[{model:'old',reasoning:'max'},{model:'flash',reasoning:'high'}]);assert.equal(session.thinkingLevel,'high');
});
