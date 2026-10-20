import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai';
import {createAgentSession,ModelRuntime,SessionManager,SettingsManager,DefaultResourceLoader} from '@earendil-works/pi-coding-agent';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}};
const waitFor=async fn=>{const until=Date.now()+4000;while(!fn()){if(Date.now()>until)assert.fail('condition timed out');await new Promise(r=>setTimeout(r,5))}};
for (const stopped of [false,true]) test(`a follow-up arriving during agent_settled waits for real admission${stopped?' and honours Stop':''}`, {timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-settlement-admission-'));const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const settledGate=defer(),settledEntered=defer(),secondInputGate=defer(),secondInputEntered=defer();let settlements=0;
 t.after(async()=>{settledGate.resolve();secondInputGate.resolve();if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(dir,{recursive:true,force:true})});
 const jiti=createJiti(import.meta.url,{tsconfigPaths:true});const {AgentSessionWrapper}=await jiti.import('./rpc-manager.ts');
 const faux=fauxProvider({models:[{id:'fixture'}]});const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
 const settingsManager=SettingsManager.inMemory();const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{pi.on('agent_settled',async()=>{if(++settlements===1){settledEntered.resolve();await settledGate.promise}});pi.on('input',async e=>{if(e.text==='late follow-up'){secondInputEntered.resolve();await secondInputGate.promise}})}]});await loader.reload();
 const manager=SessionManager.create(dir,join(dir,'sessions'));const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,modelRuntime:runtime,model:faux.getModel('fixture'),tools:[],sessionManager:manager,settingsManager});const wrapper=new AgentSessionWrapper(session);wrapper.beginExtensionBinding();await wrapper.waitUntilReady();wrapper.start();t.after(()=>wrapper.destroy());
 faux.setResponses([fauxAssistantMessage('first done'),fauxAssistantMessage('second done')]);await wrapper.send({type:'prompt',message:'first',requestId:crypto.randomUUID()});await settledEntered.promise;
 assert.equal(session.isStreaming,false,'SDK run has stopped, but its settlement handler is still running');assert.equal(wrapper.isRunning(),true);
 let acknowledged=false;const incoming=wrapper.send({type:'prompt',message:'late follow-up',streamingBehavior:'followUp',requestId:crypto.randomUUID()}).then(()=>{acknowledged=true});
 await new Promise(r=>setTimeout(r,40));assert.equal(acknowledged,false,'HTTP admission must not succeed just because deferred SDK prompt returned early');
 if(stopped)await wrapper.send({type:'abort'});settledGate.resolve();await secondInputEntered.promise;assert.equal(acknowledged,false,'real input preflight is still pending');secondInputGate.resolve();await incoming;await waitFor(()=>!wrapper.isRunning());
 if(stopped){const snapshot=await wrapper.send({type:'get_queue_actions'});assert.equal(snapshot.steering.length,0);assert.equal(snapshot.followUp.length,1);assert.equal(snapshot.followUp[0].text,'late follow-up');return;}
 const users=manager.getEntries().filter(e=>e.type==='message'&&e.message.role==='user');assert.equal(users.filter(e=>e.message.content.some(p=>p.type==='text'&&p.text==='late follow-up')).length,1);
});

for(const boundary of ['model-output','agent-before-settle','already-idle']) test(`white-send follow-up remains distinct from steering at ${boundary}`,{timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-send-kind-'));const old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=dir;
 const gate=defer(),entered=defer();let first=true;const requestContexts=[];
 t.after(async()=>{gate.resolve();if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(dir,{recursive:true,force:true})});
 const jiti=createJiti(import.meta.url,{tsconfigPaths:true});const {AgentSessionWrapper}=await jiti.import('./rpc-manager.ts');
 const faux=fauxProvider({models:[{id:'fixture'}]});const runtime=await ModelRuntime.create({authPath:join(dir,'auth.json'),modelsPath:null,refreshOnCreate:false});runtime.registerNativeProvider(faux.provider);
 const settingsManager=SettingsManager.inMemory();const loader=new DefaultResourceLoader({cwd:dir,agentDir:dir,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[pi=>{pi.on('agent_before_settle',async()=>{if(first&&boundary==='agent-before-settle'){first=false;entered.resolve();await gate.promise;}})}]});await loader.reload();
 const manager=SessionManager.create(dir,join(dir,'sessions'));const {session}=await createAgentSession({cwd:dir,agentDir:dir,resourceLoader:loader,modelRuntime:runtime,model:faux.getModel('fixture'),tools:[],sessionManager:manager,settingsManager});const wrapper=new AgentSessionWrapper(session);wrapper.beginExtensionBinding();await wrapper.waitUntilReady();wrapper.start();t.after(()=>wrapper.destroy());
 const events=[];wrapper.onEvent(e=>events.push(e));const fn=session.agent.streamFunction;session.agent.streamFunction=(model,context,options)=>{requestContexts.push(context.messages.map(m=>m.role==='user'?m.content.filter(p=>p.type==='text').map(p=>p.text).join(''):m.role));return fn(model,context,options)};
 faux.setResponses([async()=>{if(boundary==='model-output'){entered.resolve();await gate.promise;}return fauxAssistantMessage('first finished');},fauxAssistantMessage('next finished'),fauxAssistantMessage('follow-up finished')]);
 const send=(message,streamingBehavior)=>wrapper.send({type:'prompt',requestId:crypto.randomUUID(),message,...(streamingBehavior?{streamingBehavior}:{})});
 await send('original');if(boundary==='already-idle')await waitFor(()=>!wrapper.isRunning());else await entered.promise;
 await send('white send task','followUp');
 const snapshot=await wrapper.send({type:'get_queue_actions'});assert.equal(snapshot.steering.length,0,'white Send must never enter steering');
 if(boundary!=='already-idle'){
   assert.equal(snapshot.followUp.length,1);assert.equal(snapshot.followUp[0].text,'white send task');
   await send('guide task','steer');const both=await wrapper.send({type:'get_queue_actions'});assert.equal(both.followUp[0].token,snapshot.followUp[0].token);assert.equal(both.steering[0].text,'guide task');
   gate.resolve();
 }
 await waitFor(()=>!wrapper.isRunning());
 const users=manager.getEntries().filter(e=>e.type==='message'&&e.message.role==='user').map(e=>e.message.content.filter(p=>p.type==='text').map(p=>p.text).join(''));
 assert.equal(users.filter(x=>x==='white send task').length,1);if(boundary!=='already-idle')assert.deepEqual(users,['original','guide task','white send task']);
 assert.deepEqual((await wrapper.send({type:'get_queue_actions'})).followUp,[]);
});
