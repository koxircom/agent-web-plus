import test from 'node:test';import assert from 'node:assert/strict';import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'server-only':'next/dist/compiled/server-only/empty.js'}});
const {CodexRuntime}=await jiti.import(process.env.PI_CODEX_ENGINE_TEST_MODULE || './codex-engine.ts');
const meta={id:'12345678-1234-1234-1234-123456789abc',cwd:'/project',title:'test',status:'active',connected:true,sequence:1};
const row=(key,text,extra={})=>({key,text,role:'assistant',version:text,turnId:'turn',turnStatus:'inProgress',order:0,...extra});
test('saved, metadata-only and reset rows never append completed assistant replies again',async()=>{
 const old=row('old','saved',{turnStatus:'completed'}),partial=row('commentary','working');
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[old,partial],meta});const events=[];runtime.listeners.add(e=>events.push(e));
 const tool=row('tool','command',{role:'activity',kind:'commandExecution',status:'completed'});
 await runtime.accept({epoch:'epoch',sequence:2,rows:[tool],meta});
 await runtime.accept({epoch:'epoch',sequence:3,rows:[old,{...partial,turnStatus:'completed'},row('final','DONE',{turnStatus:'completed'})],meta:{...meta,status:'idle'}});
 await runtime.accept({epoch:'new-epoch',sequence:4,reset:true,rows:[old,{...partial,turnStatus:'completed'},tool,row('final','DONE',{turnStatus:'completed'})],meta:{...meta,status:'active'}});
 await runtime.accept({epoch:'new-epoch',sequence:5,rows:[],meta:{...meta,status:'idle'}});
 const texts=events.filter(e=>e.type==='message_end'&&e.message?.role==='assistant').flatMap(e=>e.message.content.filter(b=>b.type==='text').map(b=>b.text));
 assert.deepEqual(texts,['working','DONE']);
});
test('a state read cannot consume an external task start before the event stream publishes it',async()=>{
 const idle={...meta,status:'idle'},runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta:idle}),events=[];
 runtime.listeners.add(e=>events.push(e));runtime.json=async()=>({...meta,sequence:2});
 await runtime.send({type:'get_state'});await runtime.accept({epoch:'epoch',sequence:2,rows:[],meta:{...meta,sequence:2}});
 assert.equal(events.filter(e=>e.type==='agent_start').length,1);
});
test('state and usage reads request metadata without transferring the transcript',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta});const paths=[];
 runtime.json=async path=>{paths.push(path);return meta;};
 await runtime.send({type:'get_state'});await runtime.send({type:'get_session_stats'});
 assert.equal(paths.length,2);assert(paths.every(path=>path.endsWith('?metadata=1')));
});
test('transient changes failures retry in the existing read loop without shutting down the session',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta}),events=[];let calls=0;
 runtime.json=async(_path,_body,{signal}={})=>{
  calls++;
  if(calls===1)throw Object.assign(new Error('temporary bridge outage'),{retryable:true});
  if(calls===2)return {epoch:'epoch',sequence:2,rows:[],meta:{...meta,sequence:2}};
  return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
 };
 const unsubscribe=runtime.onEvent(e=>events.push(e));
 const deadline=Date.now()+1500;while(calls<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(calls>=2);assert.equal(runtime.isAlive(),true);assert.equal(events.some(e=>e.type==='session_shutdown'),false);
 unsubscribe();const stoppedAt=Date.now()+500;while(runtime.polling&&Date.now()<stoppedAt)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(runtime.polling,false);
});
test('permanent changes failures close the event session',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta}),events=[];
 runtime.json=async()=>{throw Object.assign(new Error('configuration changed'),{status:409,retryable:false});};
 const unsubscribe=runtime.onEvent(e=>events.push(e));
 const deadline=Date.now()+500;while(!events.some(e=>e.type==='session_shutdown')&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal(runtime.isAlive(),false);assert.equal(events.filter(e=>e.type==='session_shutdown').length,1);unsubscribe();
});
test('write failures remain uncertain and are never replayed by the read poll retry',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta:{...meta,status:'idle'}});let sends=0;
 runtime.json=async(path)=>{if(path.endsWith('/send'))sends++;throw Object.assign(new Error('temporary bridge outage'),{status:502,retryable:true});};
 await assert.rejects(runtime.send({type:'prompt',requestId:'request-1',message:'hello'}),error=>error.deliveryUncertain===true);
 assert.equal(sends,1);
});

test('Codex queue events use the native top-level fields on live changes and mutations',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta}),events=[];
 runtime.listeners.add(e=>events.push(e));
 await runtime.accept({epoch:'epoch',sequence:2,rows:[],meta:{...meta,submissions:[{id:'q',text:'待发送',mode:'queue',status:'queued'}]}});
 assert.deepEqual(events.find(e=>e.type==='queue_update'),{type:'queue_update',steering:[],followUp:['待发送'],requestIds:{steering:[],followUp:[null]}});
 let posted;runtime.json=async(path,command)=>{posted={path,command};return {version:2,queuedMessages:{steering:[],followUp:[]}}};
 await runtime.send({type:'delete_queued_message',token:'q'});
 assert.ok(posted.path.endsWith('/queue'));assert.equal(posted.command.token,'q');
 assert.deepEqual(events.at(-1),{type:'queue_update',steering:[],followUp:[]});
});

 test('queue consumption publishes delivered user before standalone empty queue',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta:{...meta,submissions:[{id:'q',text:'quoted',status:'queued',mode:'followUp'}]}}),events=[];
 runtime.listeners.add(e=>events.push(e));
 await runtime.accept({epoch:'epoch',sequence:2,rows:[row('input','quoted',{role:'user',requestId:'r'})],meta:{...meta,submissions:[]}});
 const delivered=events.findIndex(e=>e.type==='message_end'&&e.message?.role==='user');
 assert.ok(delivered>=0);assert.ok(events.findIndex(e=>e.type==='queue_update')>delivered);
 });

 test('unchanged Codex long polls do not republish queue state',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta}),events=[];
 runtime.listeners.add(e=>events.push(e));
 for(let sequence=2;sequence<=12;sequence++)await runtime.accept({epoch:'epoch',sequence,rows:[],meta});
 assert.equal(events.filter(e=>e.type==='queue_update').length,0);
 });
test('another client state read cannot swallow a queue event before the stream publishes it',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta}),events=[];
 runtime.listeners.add(e=>events.push(e));const next={...meta,submissions:[{id:'q',text:'shared',status:'queued',mode:'queue'}]};
 runtime.json=async()=>next;await runtime.send({type:'get_state'});
 await runtime.accept({epoch:'epoch',sequence:2,rows:[],meta:next});
 assert.equal(events.filter(e=>e.type==='queue_update').length,1);
});

test('each Codex subscription immediately publishes all queued messages without another state read',()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta:{...meta,submissions:[{id:'a',text:'排队甲',status:'queued',mode:'queue'},{id:'b',text:'排队乙',status:'queued',mode:'queue'}]}});
 runtime.polling=true; // Isolate the synchronous subscription contract.
 for(let i=0;i<2;i++){
  const events=[];const stop=runtime.onEvent(e=>events.push(e));
  assert.deepEqual(events[0],{type:'queue_update',steering:[],followUp:['排队甲','排队乙'],requestIds:{steering:[],followUp:[null,null]}});stop();
 }
});

 test('queued handoff never drops text while unknown or failed, and only clears after native receipt',async()=>{
  const entry={id:'q',text:'很长的重要原文',status:'queued',mode:'queue'};
  const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'epoch',sequence:1,rows:[],meta:{...meta,submissions:[entry]}}),events=[];
  runtime.listeners.add(e=>events.push(e));
  await runtime.accept({epoch:'epoch',sequence:2,rows:[],meta:{...meta,submissions:[{...entry,status:'unknown'}]}});
  assert.deepEqual(events.at(-1).followUp,[entry.text]);assert.equal(events.at(-1).deliveryStates[0].status,'unknown');
  await runtime.accept({epoch:'epoch',sequence:3,rows:[],meta:{...meta,submissions:[{...entry,status:'failed',error:'rejected'}]}});
  assert.deepEqual(events.at(-1).followUp,[entry.text]);assert.equal(events.at(-1).deliveryStates[0].status,'failed');
  await runtime.accept({epoch:'epoch',sequence:4,rows:[row('user',entry.text,{role:'user',requestId:'r'})],meta:{...meta,submissions:[]}});
  const user=events.findIndex(e=>e.type==='message_end'&&e.message?.role==='user');
  assert.ok(user>=0);assert.ok(events.findIndex((e,i)=>i>user&&e.type==='queue_update'&&!e.followUp.length)>user);
 });

test('metadata-only usage changes stream through the native owner after a state read without duplicates',async()=>{
 const runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'e',sequence:1,rows:[],meta}),events=[];
 runtime.listeners.add(e=>events.push(e));
 const next={...meta,contextUsage:{usedTokens:125000,contextWindow:500000},tokenUsage:{inputTokens:900000,cachedInputTokens:800000,outputTokens:100000,totalTokens:1000000}};
 runtime.json=async()=>next;const state=await runtime.send({type:'get_state'});assert.equal(state.contextUsage.tokens,125000);const stats=await runtime.send({type:"get_session_stats"});assert.equal(stats.tokens.total,1000000);assert.equal(stats.tokens.input,100000);
 await runtime.accept({epoch:'e',sequence:2,rows:[],meta:next});await runtime.accept({epoch:'e',sequence:2,rows:[],meta:next});
 const usage=events.filter(e=>e.type==='session_usage');assert.equal(usage.length,1);assert.equal(usage[0].usage.tokens.total,1000000);assert.equal(usage[0].sessionId,'codex:'+meta.id);
 await runtime.accept({epoch:'e',sequence:3,rows:[],meta});assert.deepEqual(events.filter(e=>e.type==='session_usage').at(-1).usage,{tokens:null,contextUsage:null});
 runtime.poll=async()=>{};const replay=[];const unsubscribe=runtime.onEvent(e=>replay.push(e));assert.equal(replay.filter(e=>e.type==='session_usage').length,1);unsubscribe();
});


test('idle settlement before delayed final invalidates history exactly once without replaying saved bubbles',async()=>{
 const partial=row('commentary','还在执行'),runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'e',sequence:1,rows:[partial],meta}),events=[];
 runtime.listeners.add(e=>events.push(e));
 await runtime.accept({epoch:'e',sequence:2,rows:[],meta:{...meta,status:'idle'}});events.length=0;
 const final=row('late-final','最终完整答复',{turnStatus:'completed'});
 await runtime.accept({epoch:'e',sequence:3,rows:[final],meta:{...meta,status:'idle'}});
 assert.equal(events.filter(e=>e.type==='session_history_changed').length,1);
 assert.equal(events.filter(e=>e.type==='message_start').length,0);events.length=0;
 await runtime.accept({epoch:'e',sequence:4,rows:[final],meta:{...meta,status:'idle'}});
 assert.equal(events.filter(e=>e.type==='session_history_changed').length,0);
});
test('completed reply correction and unknown reset history reconcile instead of duplicate append',async()=>{
 const saved=row('saved','旧正文',{turnStatus:'completed'}),runtime=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'e',sequence:1,rows:[saved],meta:{...meta,status:'idle'}}),events=[];
 runtime.listeners.add(e=>events.push(e));
 await runtime.accept({epoch:'e',sequence:2,rows:[{...saved,text:'完整正文',version:'new'}],meta:{...meta,status:'idle'}});
 assert.equal(events.filter(e=>e.type==='session_history_changed').length,1);events.length=0;
 await runtime.accept({epoch:'e2',sequence:3,reset:true,rows:[saved,row('missed','后台完成',{turnStatus:'completed'})],meta:{...meta,status:'idle'}});
 assert.equal(events.filter(e=>e.type==='session_history_changed').length,1);
 assert.equal(events.filter(e=>['message_start','message_end'].includes(e.type)).length,0);
});

const asyncQuestion = {id:'async:turn:question',method:'bridge/requestUserInputAsync',supported:true,
 params:{questions:[{id:'original-question-id',question:'新手机慢的是哪一类访问？',options:[{label:'网页'},{label:'图片下载'}]}]}};
test('async question renders its question and options instead of an unsupported warning', async()=>{
 const r=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'e',sequence:1,rows:[],meta:{...meta,requests:[asyncQuestion]}});
 const events=r.pendingRequests();assert.equal(events.length,1);assert.equal(events[0].method,'input');
 assert.match(events[0].title,/新手机慢的是哪一类访问/);assert.match(events[0].title,/图片下载/);
 assert(!JSON.stringify(events).includes('bridge/requestUserInputAsync'));assert(!JSON.stringify(events).includes('停止本次任务'));
 const calls=[];r.json=async(path,body)=>{calls.push({path,body});return {status:'accepted'};};
 await r.send({type:'extension_ui_response',id:events[0].id,value:'图片下载'});
 assert.deepEqual(calls[0].body,{requestId:asyncQuestion.id,response:{answers:{'original-question-id':['图片下载']}}});
 await r.accept({epoch:'e',sequence:2,rows:[],meta:{...meta,requests:[asyncQuestion]}});
 assert.equal(r.pendingRequests().length,0,'admission before native echo must not reopen the same question');
});
test('async question failed reply remains answerable and dismissal never stops a task', async()=>{
 const r=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'e',sequence:1,rows:[],meta:{...meta,requests:[asyncQuestion]}});
 const event=r.pendingRequests()[0];let writes=0;
 r.json=async()=>{writes++;throw new Error('reply transport failed');};
 await r.send({type:'extension_ui_response',id:event.id,cancelled:true});assert.equal(writes,0);
 await assert.rejects(r.send({type:'extension_ui_response',id:event.id,value:'网页'}),/reply transport failed/);
 assert.equal(r.pendingRequests()[0].method,'input');assert.equal(writes,1);
});
test('unsupported requests explain the next action without exposing protocol names',()=>{
 const unknown={id:'unknown',method:'internal/privateProtocol',supported:false,params:{}};
 const r=new CodexRuntime('codex:'+meta.id,'identity',{epoch:'e',sequence:1,rows:[],meta:{...meta,requests:[unknown]}});
 const event=r.pendingRequests()[0];assert.equal(event.method,'notify');assert.match(event.message,/同一会话/);
 assert(!event.message.includes(unknown.method));assert(!event.message.includes('请停止'));
});
