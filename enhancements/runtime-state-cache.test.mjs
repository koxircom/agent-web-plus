import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./modules/03-session-cache-and-sync-engine.js',import.meta.url),'utf8');
for(const [name,start,end,urlStr]of[
 ['agent','    // 场景 0:','    // 场景 1:','/api/agent/sid'],
 ['session','    // 场景 2:','    // metricsOnly','/api/sessions/sid/state'],
]) test(`idle ${name} runtime reads preserve authoritative paused queues instead of inventing empty state`,async()=>{
 const from=source.indexOf(start,source.indexOf('    const entry = getOrCreateSessionEntry(sessionId);',source.indexOf('  async function interceptedFetchCore(input, init)')));const body=source.slice(from,source.indexOf(end,from));let calls=0;
 const json={running:false,runtimeAlive:true,state:{isStreaming:false,queuedMessages:{steering:['saved task'],followUp:[]}}};const response=new Response(JSON.stringify(json));
 const context={urlStr,input:urlStr,init:{},sessionId:'sid',entry:{runGeneration:1,isRunning:false,hasPendingAgentEnd:false,state:{data:{running:false}}},isPluginEnabled:()=>true,knownSessionsMap:new Map([['sid',{}]]),isChatSessionRunning:()=>false,activeFetch:async()=>{calls++;return response},readSessionRunningState:()=>false,markSessionRunning(){},createCachedResponse:data=>new Response(JSON.stringify(data))};
 vm.createContext(context);vm.runInContext('this.read=async function(){'+body+'}',context);const result=await context.read();assert.equal(calls,1);assert.equal(result,response);assert.deepEqual(await result.json(),json);
});
