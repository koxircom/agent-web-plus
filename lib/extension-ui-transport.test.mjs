import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {deliverExtensionUiInput,checkExtensionUiState}=await jiti.import('./agent-client.ts');

test('real stalled HTTP response body is bounded; unknown write cannot replay and corrupt GET cannot unlock',async t=>{
 const nativeFetch=globalThis.fetch,nativeTimeout=AbortSignal.timeout;
 let posts=0,gets=0,snapshotMode='pending';const budgets=[];
 const request={type:'extension_ui_request',id:'body-stall',method:'custom',lines:[]};
 const server=http.createServer((req,res)=>{
  if(req.method==='POST'){posts++;req.resume();res.writeHead(200,{'content-type':'application/json'});res.write('{"success":true,"data":');return;}
  gets++;res.setHeader('content-type','application/json');res.end(JSON.stringify(snapshotMode==='corrupt'?{}:{runtimeAlive:true,pendingExtensionUiRequests:snapshotMode==='closed'?[]:[request]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const url=`http://127.0.0.1:${server.address().port}`;
 globalThis.fetch=(path,options)=>nativeFetch(url+path,options);
 AbortSignal.timeout=function(ms){budgets.push(ms);return nativeTimeout.call(AbortSignal,ms===12000?80:ms);};
 t.after(async()=>{globalThis.fetch=nativeFetch;AbortSignal.timeout=nativeTimeout;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const payload={type:'extension_ui_input',id:request.id,method:'custom',data:'answer'};
 assert.equal((await deliverExtensionUiInput('stalled-session',payload)).status,'uncertain');
 assert.deepEqual(budgets,[12000]);assert.equal(posts,1);assert.equal(gets,1);
 assert.equal((await deliverExtensionUiInput('stalled-session',payload)).status,'uncertain');
 snapshotMode='corrupt';assert.equal((await deliverExtensionUiInput('stalled-session',payload)).status,'uncertain');assert.equal(posts,1);
 snapshotMode='pending';assert.equal((await deliverExtensionUiInput('stalled-session',payload)).status,'uncertain');assert.equal(posts,1);
 snapshotMode='closed';assert.deepEqual(await checkExtensionUiState('stalled-session'),[]);
});

test('valid pending ACK releases admission for the next same-mode input',async t=>{
 const saved=globalThis.fetch;let posts=0;const request={type:'extension_ui_request',id:'same-mode',method:'custom',lines:[]};
 globalThis.fetch=async(_path,options)=>{assert.equal(options.method,'POST');posts++;return Response.json({success:true,data:{id:request.id,status:'pending',request}});};
 t.after(()=>{globalThis.fetch=saved;});
 const payload={type:'extension_ui_input',id:request.id,method:'custom',data:'step'};
 for(let i=0;i<2;i++) assert.equal((await deliverExtensionUiInput('same-mode-session',payload)).status,'pending');
 assert.equal(posts,2);
});

test('ordinary terminal keystrokes are not dropped; a later pending ACK cannot unlock an earlier uncertain write',async t=>{
 const saved=globalThis.fetch, replies=[];let posts=0,closed=false;
 const request={type:'extension_ui_request',id:'terminal-stream',method:'custom',lines:[]};
 globalThis.fetch=async(_url,options)=>{
  if(options?.method==='POST'){posts++;return new Promise(resolve=>replies.push(resolve));}
  return Response.json({runtimeAlive:true,pendingExtensionUiRequests:closed?[]:[request]});
 };
 t.after(()=>{globalThis.fetch=saved;});
 const input=data=>deliverExtensionUiInput('terminal-session',{type:'extension_ui_input',id:request.id,method:'custom',data});
 const first=input('h'),second=input('e');await new Promise(resolve=>setImmediate(resolve));assert.equal(posts,2,'Both distinct keys dispatch before either ACK');
 replies[0](Response.json({error:'lost response'},{status:504}));assert.equal((await first).status,'uncertain');
 replies[1](Response.json({success:true,data:{id:request.id,status:'pending',request}}));assert.equal((await second).status,'pending');
 assert.equal((await input('l')).status,'uncertain');assert.equal(posts,2,'Pending ACK cannot clear the earlier unknown-write lock');
 closed=true;assert.deepEqual(await checkExtensionUiState('terminal-session'),[]);
});
