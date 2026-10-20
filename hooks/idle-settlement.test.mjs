import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source=readFileSync(new URL('./useAgentSession.ts',import.meta.url),'utf8');
const a=source.indexOf('  const finishPromptWithoutStream ='),b=source.indexOf('  const waitForPromptSettlement =',a);
const callback=source.slice(a,b).replace('sid: string | null','sid');
function setup(){
 let resolve;const history=new Promise(r=>resolve=r),calls=[];
 const refs={sessionIdRef:{current:'A'},promptRunIdRef:{current:3},rpcPromptPendingRef:{current:true},sdkAgentActiveRef:{current:true},optimisticUserMessageRef:{current:{sessionId:'A',message:'draft'}}};
 const ctx={...refs,useCallback:fn=>fn,loadSession:sid=>{calls.push(['history',sid]);return history;},notifyPromptStage:id=>calls.push(['notify',id]),scheduleEventStreamClose:sid=>calls.push(['grace',sid]),settleUiStage:()=>{calls.push(['idle']);return true;}};
 vm.createContext(ctx);vm.runInContext(callback+'\nthis.finish=finishPromptWithoutStream;',ctx);
 return {ctx,refs,calls,resolve};
}
test('server idle clears Stop but preserves unconfirmed user content while history is unresolved',async()=>{
 const {ctx,refs,calls,resolve}=setup();await ctx.finish('A',3);
 assert.equal(refs.rpcPromptPendingRef.current,false);assert.equal(refs.sdkAgentActiveRef.current,false);assert.deepEqual(refs.optimisticUserMessageRef.current,{sessionId:'A',message:'draft'});
 assert.deepEqual(calls,[['idle'],['notify',3],['history','A'],['grace','A']]);resolve();
});
test('late settlement cannot clear another session or a newer run',async()=>{
 for(const changes of [{sessionIdRef:'B'},{promptRunIdRef:4}]){
  const {ctx,refs,calls,resolve}=setup();for(const [k,v]of Object.entries(changes))refs[k].current=v;
  await ctx.finish('A',3);assert.deepEqual(calls,[]);assert.equal(refs.rpcPromptPendingRef.current,true);assert.deepEqual(refs.optimisticUserMessageRef.current,{sessionId:'A',message:'draft'});resolve();
 }
});
test('a new prompt started during delayed history does not receive a late idle mutation',async()=>{
 const {ctx,refs,calls,resolve}=setup();await ctx.finish('A',3);
 refs.promptRunIdRef.current=4;refs.rpcPromptPendingRef.current=true;refs.sdkAgentActiveRef.current=true;refs.optimisticUserMessageRef.current={sessionId:'A',message:'next'};resolve();await Promise.resolve();
 assert.equal(refs.rpcPromptPendingRef.current,true);assert.equal(refs.sdkAgentActiveRef.current,true);assert.deepEqual(refs.optimisticUserMessageRef.current,{sessionId:'A',message:'next'});assert.equal(calls.filter(x=>x[0]==='idle').length,1);
});
