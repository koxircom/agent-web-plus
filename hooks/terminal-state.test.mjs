import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('./useAgentSession.ts',import.meta.url),'utf8');
const file=ts.createSourceFile('hook.ts',source,ts.ScriptTarget.Latest,true);
function evaluate(node){return new Function('scope',`with(scope){return ${ts.transpileModule('('+node.getText(file)+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText.trim().replace(/;$/,'')};}`);}
function callback(name){let found;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(file)===name)found=n.initializer.arguments[0];ts.forEachChild(n,visit);}visit(file);assert.ok(found,name);return evaluate(found);}
function harness(){const ref=current=>({current});let resolve;const response=new Promise(r=>resolve=r);const ui={running:true,phase:{kind:'waiting_model'},notifications:0};const noop=()=>{};
 const scope={agentRunningRef:ref(true),sdkAgentActiveRef:ref(true),rpcPromptPendingRef:ref(true),promptRunIdRef:ref(1),agentStateRevisionRef:ref(0),notifiedPromptRunIdRef:ref(0),sessionIdRef:ref('s'),optimisticUserMessageRef:ref(null),preparationRef:ref(null),getPendingPromptSubmissions:()=>[],
 invalidatesSessionHistory:()=>false,bumpSessionEpoch:noop,cancelEventStreamGrace:noop,setAgentRunning:v=>ui.running=v,setAgentPhase:v=>ui.phase=v,setRetryInfo:noop,setActiveToolResults:noop,dispatch:noop,setIsCompacting:noop,setAutoCompactionEnabled:noop,setQueuedMessages:noop,normalizeQueuedMessages:x=>x,syncLiveModel:noop,reconcileSelectedHistory:noop,loadSession:noop,scheduleEventStreamClose:noop,fetch:()=>response,
 setMessages:noop,normalizeToolCalls:x=>x,isSystemMessageEvent:()=>false,setContextUsage:noop,setSystemPrompt:noop,setExtensionStatuses:noop,setExtensionWidgets:noop,
 notifyPromptStage:id=>{if(scope.notifiedPromptRunIdRef.current!==id){scope.notifiedPromptRunIdRef.current=id;ui.notifications++;}},
 settleUiStage:()=>{const was=scope.agentRunningRef.current;scope.agentRunningRef.current=false;ui.running=false;ui.phase=null;return was;}};
 for(const n of ['finishPromptWithoutStream','handleAgentEvent','reconcileAgentState'])scope[n]=callback(n)(scope);
 return {scope,ui,resolve};}
test('settled ends the visible run before the POST completion callback',()=>{const h=harness();h.scope.handleAgentEvent({type:'agent_settled'});assert.equal(h.ui.running,false);assert.equal(h.ui.phase,null);h.scope.handleAgentEvent({type:'prompt_done'});assert.equal(h.ui.notifications,1);});
test('a busy snapshot started before settlement cannot revive SDK or prompt activity',async()=>{const h=harness();const pending=h.scope.reconcileAgentState('s');h.scope.handleAgentEvent({type:'agent_settled'});h.scope.handleAgentEvent({type:'prompt_done'});h.resolve({ok:true,json:async()=>({running:true,state:{isStreaming:true,isPromptRunning:true}})});await pending;assert.equal(h.scope.sdkAgentActiveRef.current,false);assert.equal(h.scope.rpcPromptPendingRef.current,false);assert.equal(h.ui.running,false);});
test('a real continuation started after settlement survives the old prompt_done',()=>{const h=harness();h.scope.handleAgentEvent({type:'agent_settled'});h.scope.handleAgentEvent({type:'agent_start'});h.scope.handleAgentEvent({type:'prompt_done'});assert.equal(h.ui.running,true);assert.equal(h.scope.sdkAgentActiveRef.current,true);});
test('a final assistant answer does not invent a waiting-model phase',()=>{const h=harness();h.scope.handleAgentEvent({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'完成'}]}});assert.equal(h.ui.phase,null);});

test('prompt_done recovers a missing SDK settlement without leaving Stop or waiting visible',async()=>{
 const h=harness();let checked;
 const reconcile=h.scope.reconcileAgentState;
 h.scope.reconcileAgentState=sid=>(checked=reconcile(sid));
 h.scope.handleAgentEvent({type:'prompt_done'});
 assert.ok(checked,'A remaining SDK activity flag must be verified against the runtime');
 h.resolve({ok:true,json:async()=>({running:false,runtimeAlive:true,state:{isStreaming:false,isPromptRunning:false}})});
 await checked;
 assert.equal(h.ui.running,false);assert.equal(h.ui.phase,null);assert.equal(h.ui.notifications,1);
 assert.equal(h.scope.sdkAgentActiveRef.current,false);assert.equal(h.scope.rpcPromptPendingRef.current,false);
});

test('idle reconciliation clears the visible run even when its wrapper remains alive',async()=>{
 const h=harness();const pending=h.scope.reconcileAgentState('s');
 h.resolve({ok:true,json:async()=>({running:false,runtimeAlive:true,state:{isStreaming:false,isPromptRunning:false}})});
 await pending;assert.equal(h.ui.running,false);assert.equal(h.ui.phase,null);assert.equal(h.ui.notifications,1);
});

for(const stage of ['preparing','sending'])test(`an old idle snapshot preserves a new prompt still ${stage}`,async()=>{
 const h=harness();
 if(stage==='preparing')h.scope.preparationRef.current={};
 else h.scope.getPendingPromptSubmissions=()=>[{sessionId:'s',status:'sending'}];
 const pending=h.scope.reconcileAgentState('s');
 h.resolve({ok:true,json:async()=>({running:false,state:{isStreaming:false,isPromptRunning:false}})});
 await pending;assert.equal(h.ui.running,true);assert.equal(h.ui.notifications,0);
});

test('an intermediate agent_end preserves a real extension continuation',async()=>{
 const h=harness();let checked;const reconcile=h.scope.reconcileAgentState;
 h.scope.reconcileAgentState=sid=>(checked=reconcile(sid));
 h.scope.handleAgentEvent({type:'agent_end'});
 h.resolve({ok:true,json:async()=>({running:true,state:{isStreaming:true,isPromptRunning:true}})});
 await checked;assert.equal(h.ui.running,true);assert.equal(h.ui.notifications,0);
});

test('reconciliation does not finish an active compaction',async()=>{
 const h=harness();const pending=h.scope.reconcileAgentState('s');
 h.resolve({ok:true,json:async()=>({running:true,state:{isStreaming:false,isPromptRunning:false,isCompacting:true}})});
 await pending;assert.equal(h.ui.running,true);assert.equal(h.ui.notifications,0);
});

test('recovered prompt polling captures its original run before the initial delay',async()=>{
 const h=harness();let releaseDelay;let reads=0;
 Object.assign(h.scope,{PROMPT_SETTLE_INITIAL_DELAY_MS:800,PROMPT_SETTLE_MAX_MS:20000,PROMPT_SETTLE_POLL_MS:600,
  delay:()=>new Promise(r=>{releaseDelay=r;}),fetch:()=>{reads++;throw Error('Must not query a superseded run');}});
 const wait=callback('waitForPromptSettlement')(h.scope);
 const pending=wait('s');h.scope.promptRunIdRef.current=2;releaseDelay();await pending;
 assert.equal(reads,0);assert.equal(h.ui.running,true);
});

test('metadata callback changes cannot postpone the missed-event recovery clock',t=>{
 let effect;
 function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(file)==='useEffect'
  &&n.arguments[0]?.getText(file).includes('setInterval')&&n.arguments[0].getText(file).includes('AGENT_STATE_RECONCILE_MS'))effect=n;ts.forEachChild(n,visit);}
 visit(file);assert.ok(effect);
 t.mock.timers.enable({apis:['setInterval']});
 let checks=0,lastCheckedVersion=-1,cleanup,previousDeps;
 const listeners=new Map();const events={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
 const scope={agentRunning:true,sessionIdRef:{current:'s'},AGENT_STATE_RECONCILE_MS:15000,setInterval,clearInterval,
  document:{...events,visibilityState:'visible'},window:events};
 scope.reconcileSelectedHistory=()=>scope.reconcileAgentState('s');
 scope.reconcileRunningAgent=()=>scope.reconcileAgentState('s');
 const render=version=>{
  scope.reconcileAgentState=()=>{checks++;lastCheckedVersion=version;};
  const deps=evaluate(effect.arguments[1])(scope);
  if(!previousDeps||deps.some((value,i)=>value!==previousDeps[i])){
   cleanup?.();cleanup=evaluate(effect.arguments[0])(scope)();previousDeps=deps;
  }
 };
 try{
  render(0);
  for(let version=1;version<=6;version++){t.mock.timers.tick(2500);render(version);}
  assert.equal(checks,1,'Recovery must happen at 15 seconds despite six metadata refreshes');
  assert.equal(lastCheckedVersion,5,'The timer uses the latest callback');
  listeners.get('online')();assert.equal(lastCheckedVersion,6);
  scope.agentRunning=false;render(7);t.mock.timers.tick(15000);assert.equal(checks,2,'Settlement removes the timer');
 }finally{cleanup?.();}
});

test('sidebar completion verifies the runtime without clearing local submission optimistically',()=>{
 let effect;
 function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(file)==='useEffect'
  &&n.arguments[0]?.getText(file).includes('previousSessionRunningRef.current'))effect=n;ts.forEachChild(n,visit);}
 visit(file);assert.ok(effect);
 let checks=0;
 const scope={opts:{sessionRunning:false},previousSessionRunningRef:{current:false},reconcileSelectedHistory:()=>checks++};
 const apply=evaluate(effect.arguments[0])(scope);
 apply();assert.equal(checks,0,'The initial empty sidebar must not end a local prompt');
 scope.opts.sessionRunning=true;apply();assert.equal(checks,0);
 scope.opts.sessionRunning=false;apply();assert.equal(checks,1,'A server-observed completion should be confirmed immediately');
 apply();assert.equal(checks,1,'Repeated idle snapshots do not duplicate completion checks');
});

test('native usage updates the shared state only for the currently selected session and clears missing values',()=>{
 const h=harness();let context=null,data={sessionId:'s'};h.scope.setContextUsage=v=>context=v;h.scope.setData=f=>data=f(data);
 const usage={contextUsage:{tokens:125000,contextWindow:500000,percent:25},tokens:{input:1,output:2,cacheRead:0,cacheWrite:0,total:3}};
 h.scope.handleAgentEvent({type:'session_usage',sessionId:'other',usage});assert.equal(context,null);
 h.scope.handleAgentEvent({type:'session_usage',sessionId:'s',usage});assert.equal(context.tokens,125000);assert.equal(data.usage.tokens.total,3);
 h.scope.handleAgentEvent({type:'session_usage',sessionId:'s',usage:{contextUsage:null,tokens:null}});assert.equal(context,null);assert.equal(data.usage.tokens,null);
});

test('late history invalidation forces a fresh shared read without reviving the idle agent',()=>{
 const h=harness(),calls=[];h.scope.agentRunningRef.current=false;h.scope.ui={};h.ui.running=false;
 h.scope.loadSession=(...args)=>calls.push(args);
 h.scope.handleAgentEvent({type:'session_history_changed'});
 assert.deepEqual(calls,[['s',false,false,{force:true}]]);assert.equal(h.ui.running,false);
});
