import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./modules/03-session-cache-and-sync-engine.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('  async function interceptedFetch(input, init)'),source.indexOf('  async function interceptedFetchCore(input, init)'));
test('native Stop bypasses optional fetch work without rewriting an in-flight queued prompt',async()=>{
 let release;const pending=new Promise(r=>release=r),calls=[];
 const context={isPluginEnabled:()=>true,isSameOriginExactAgentPost:()=>({sessionId:'sid'}),peekAgentAbortTypeSync:(_i,init)=>JSON.parse(init.body).type==='abort'?'abort':null,
 dispatchDirectStopFetch:async(_target,type)=>{calls.push(type);return new Response('{}')},resolveAgentAbortType:async()=>null,
 beginHistoryPageRequest:()=>null,interceptedFetchCore:async(_input,init)=>{calls.push(JSON.parse(init.body));await pending;return new Response('{}')},Response};
 vm.createContext(context);vm.runInContext(body+';this.fetch=interceptedFetch',context);
 const command={type:'prompt',requestId:'original-id',message:'queued task',streamingBehavior:'followUp',images:[{data:'same image',mimeType:'image/png'}]};
 const operation=context.fetch('/api/agent/sid',{body:JSON.stringify(command)});await new Promise(r=>setImmediate(r));
 await context.fetch('/api/agent/sid',{body:JSON.stringify({type:'abort'})});release();await operation;
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[command,'abort']);
});
