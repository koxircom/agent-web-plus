import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('./SessionSidebar.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('sidebar.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let callback;function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(file)==='useEffect'&&n.arguments[0]?.getText(file).includes('win.__PI_WEB_REFRESH_PROJECT_STATUS__ = poll'))callback=n.arguments[0].getText(file);ts.forEachChild(n,visit)}visit(file);assert(callback);
const code=ts.transpileModule('('+callback+')',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve()};
function harness({slowCatalog=false}={}){
 let now=0,next=0,mode='success',visibility='visible',reads=0,catalogReads=0;
 const timers=new Map(),listeners=new Map(),health=[],snapshots=[];let running=new Set();
 const setTimeout=(fn,ms)=>{const id=++next;timers.set(id,{fn,at:now+ms});return id},clearTimeout=id=>timers.delete(id);
 const document={get visibilityState(){return visibility},addEventListener:(k,v)=>listeners.set(k,v),removeEventListener:k=>listeners.delete(k)};
 const window={dispatchEvent:e=>snapshots.push(e)};
 const refs={runningPollAuthoritativeRef:{current:false},currentSuppressedCompletionSessionIdsRef:{current:new Set()},completedReceiptIdsRef:{current:new Set()},sessionListVersionRef:{current:slowCatalog?0:1},sessionListLoadingRef:{current:false},sidebarBridgeStateRef:{current:{allSessions:[]}}};
 const scope={...refs,window,document,BroadcastChannel:undefined,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail}},Event:class{constructor(type){this.type=type}},AbortController,RUNNING_SESSIONS_POLL_MS:2500,executionEngine:'codex',setTimeout,clearTimeout,
  setRunningStatusHealthy:v=>health.push(v),setRunningSessionIds:f=>{running=typeof f==='function'?f(running):f},loadSessions:()=>{catalogReads++;return slowCatalog?new Promise(()=>{}):Promise.resolve()},
  fetch:async(_url,{signal})=>{reads++;if(mode==='hang')return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));const status=mode==='success'?200:mode==='auth'?401:503;return {ok:status===200,status,json:async()=>({runningSessionIds:['one'],sessionListVersion:1,statusSnapshot:{epoch:'epoch',revision:reads,executions:[{sessionId:'one',state:'running'}]}})}}};
 const cleanup=new Function(...Object.keys(scope),'return '+code)(...Object.values(scope))();
 return {health,snapshots,get reads(){return reads},get catalogReads(){return catalogReads},get running(){return [...running]},mode:v=>{mode=v},hidden:async v=>{visibility=v?'hidden':'visible';listeners.get('visibilitychange')?.();await flush()},advance:async ms=>{const end=now+ms;while(true){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();await flush()}now=end;await flush()},stop:()=>cleanup(),get timerCount(){return timers.size}};
}
test('a single failed status read invalidates task data without declaring a healthy transport disconnected',async()=>{const h=harness();try{await flush();assert.equal(h.health.at(-1),true);h.mode('failure');await h.advance(2500);assert.deepEqual(h.running,[]);assert.equal(h.health.at(-1),true);h.mode('success');await h.advance(2500);assert.equal(h.health.at(-1),true);assert(!h.health.slice(h.health.indexOf(true)+1).includes(false))}finally{h.stop()}});
test('opening the mobile native picker pauses expiry; resume confirms status before any disconnection verdict',async()=>{const h=harness();try{await flush();const start=h.health.length;await h.hidden(true);await h.advance(60000);assert(!h.health.slice(start).includes(false));await h.hidden(false);assert.equal(h.health.at(-1),true);assert.equal(h.reads,2)}finally{h.stop()}});
test('slow catalogue refresh cannot block the next lightweight status poll',async()=>{const h=harness({slowCatalog:true});try{await flush();assert.equal(h.catalogReads,1);await h.advance(2500);assert.equal(h.reads,2)}finally{h.stop()}});
test('sustained outage expires the connection and cannot invent completed receipts',async()=>{const h=harness();try{await flush();h.mode('failure');await h.advance(12500);assert.equal(h.health.at(-1),false);assert.deepEqual(h.running,[]);assert(h.snapshots.filter(e=>e.detail).every(e=>e.detail.payload===null||e.detail.payload.statusSnapshot.executions.every(x=>x.state!=='ended')))}finally{h.stop()}assert.equal(h.timerCount,0)});
test('authentication rejection immediately makes the connection unavailable',async()=>{const h=harness();try{await flush();h.mode('auth');await h.advance(2500);assert.equal(h.health.at(-1),false)}finally{h.stop()}});
