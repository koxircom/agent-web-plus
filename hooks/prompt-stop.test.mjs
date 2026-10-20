import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from "node:crypto";
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {pendingSessionInfo} from '../lib/session-catalog-client.ts';
const source=readFileSync(new URL('./useAgentSession.ts',import.meta.url),'utf8');
const helper=readFileSync(new URL('../lib/prompt-preparation.ts',import.meta.url),'utf8').replace('export function','function');
const extract=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const code=stripTypeScriptTypes(helper+'\n'+extract('  const handleSend = useCallback','  const executeBash = useCallback')+'\n'+extract('  const executeBash = useCallback','  const handleFork = useCallback'))+'\n({handleSend,executeBash,handleAbort})';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const tick=()=>new Promise(r=>setImmediate(r));
function harness(isNew=false){
 const newSession=deferred(),events=deferred(),command=deferred(),state={running:false,bash:false,messages:[],restored:[],notices:[],commands:[],stopping:false,sessionSubmissions:[],promptScrollRevision:0},ref=current=>({current});
 const scope={crypto:webcrypto,AbortController,DOMException,Promise,useCallback:f=>f,waitForPromptPreparation:undefined,isNew,newSessionCwd:'/test',newSessionDraftKey:'new:draft:/test',newSessionModel:null,pendingSessionInfo,onSessionSubmissionChange:(...args)=>state.sessionSubmissions.push(args),session:isNew?null:{id:'s'},composerDraftKey:'draft',
  agentRunningRef:ref(false),bashRunningRef:ref(false),sessionIdRef:ref(isNew?null:'s'),ensuringNewSessionRef:ref(null),promptRunIdRef:ref(0),rpcPromptPendingRef:ref(false),optimisticUserMessageRef:ref(null),entryIdsRef:ref([]),pendingScrollToUserRef:ref(false),preparationRef:ref(null),stopInFlightRef:ref(null),executeBashRef:ref(null),
  ensureNewSession:()=>{const pending=newSession.promise.then(s=>{scope.sessionIdRef.current=s;return s;});scope.ensuringNewSessionRef.current=pending;return pending;},maintainEventsConnected:()=>{},
  sendAgentCommand:async(s,c)=>{state.commands.push(c);if(c.type==='abort')await command.promise;},
  restoreSubmission:(...args)=>state.restored.push(args),setMessages:f=>state.messages=f(state.messages),setAgentRunning:v=>state.running=v,setBashRunning:v=>state.bash=v,setPendingBash:()=>{},setStopRequested:v=>state.stopping=v,
  setAgentPhase:()=>{},setPromptAnchorActive:()=>{},setPromptScrollRevision:update=>{state.promptScrollRevision=update(state.promptScrollRevision);},setPendingModel:()=>{},dispatch:()=>{},bumpSessionEpoch:()=>{},cancelEventStreamGrace:()=>{},markOptimisticUserMessage:()=>{},userMessageKey:()=> 'user',promoteNewSession:()=>{},waitForPromptSettlement:()=>{},reconcileAgentState:()=>{},loadSession:async()=>{},closeEvents:()=>{},addNotice:n=>state.notices.push(n),isPromptRejectedError:()=>false,console};
 const actions=vm.runInNewContext(code,scope);return{...actions,newSession,events,command,state,scope};
}
for(const phase of ['create'])test(`Stop during ${phase} retains the message without model dispatch`,async()=>{
 const h=harness(phase==='create'),sending=h.handleSend('keep me');await tick();
 assert.equal(h.state.running,true);
 if(phase==='create') assert.equal(h.state.sessionSubmissions[0][1].firstMessage,'keep me');
 await h.handleAbort();
 // Stop cannot cancel the shared creation, but must never await event connection.
 h.newSession.resolve('s');await sending;
 assert.equal(h.state.running,false);assert.equal(h.state.messages.length,1);assert.equal(h.state.restored.length,0);assert.equal(h.state.notices.length,0);
 assert.equal(h.state.commands.filter(c=>c.type==='retain_stopped_prompt').length,1);
 assert.equal(h.state.commands.find(c=>c.type==='retain_stopped_prompt').message,'keep me');
 h.events.resolve();await tick();
 assert.equal(h.state.commands.some(c=>c.type==='prompt'),false);
});
test('Stop before shell session creation cannot execute a delayed command',async()=>{
 const h=harness(true),execution=h.executeBash('sleep 30',false);await tick();await h.handleAbort();await execution;
 h.newSession.resolve('s');await tick();assert.equal(h.state.commands.length,0);assert.equal(h.state.bash,false);assert.equal(h.state.restored[0][0],'!sleep 30');assert.equal(h.state.notices.length,0);
});
test('normal preparation dispatches exactly once and repeated Stop shares acknowledgement',async()=>{
 const h=harness(),sending=h.handleSend('normal');await tick();h.events.resolve();await sending;
 assert.equal(h.state.commands.filter(c=>c.type==='prompt').length,1);
 const first=h.handleAbort(),second=h.handleAbort();await tick();assert.equal(h.state.stopping,true);assert.equal(h.state.commands.filter(c=>c.type==='abort').length,1);
 h.command.resolve();await Promise.all([first,second]);
});

test('title and optimistic message appear before session creation and event connection', async()=>{
 const h=harness(true), sending=h.handleSend('即时标题'); await tick();
 assert.equal(h.state.promptScrollRevision,1);
 assert.equal(h.state.sessionSubmissions[0][1].firstMessage,'即时标题');
 assert.equal(h.state.messages[0].content,'即时标题');
 assert.equal(h.state.commands.length,0);
 h.newSession.resolve('real'); await tick();
 assert.equal(h.state.sessionSubmissions.at(-1)[1].id,'real');
 assert.equal(h.state.sessionSubmissions.at(-1)[1].firstMessage,'即时标题');
 assert.equal(h.state.commands.filter(c=>c.type==='prompt').length,1);
 await sending;
 assert.equal(h.state.commands.filter(c=>c.type==='prompt').length,1);
});

test('Stop retains image-only submissions and mixed attachment payload intact', async()=>{
 for(const message of ['', '修改这些文件\n\n[附件: @.pi-uploads/example.pdf]']) {
  const h=harness(true), images=[{data:'AQID',mimeType:'image/png'}];
  const sending=h.handleSend(message,images);await tick();await h.handleAbort();h.newSession.resolve('s');await sending;
  const saved=h.state.commands.find(c=>c.type==='retain_stopped_prompt');
  assert.equal(saved.message,message);assert.equal(saved.images[0].data,'AQID');assert.equal(saved.images[0].mimeType,'image/png');
  assert.equal(h.state.restored.length,0);assert.equal(h.state.commands.some(c=>c.type==='prompt'),false);
 }
});
