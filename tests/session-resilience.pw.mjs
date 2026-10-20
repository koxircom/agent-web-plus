// Real React hook + native EventSource, isolated HTTP fixture, no model calls.
import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root=path.resolve(process.env.SOURCE_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const load=createRequire(path.join(root,'package.json'));
const {build}=load('esbuild'),{chromium}=load('playwright');
const out=process.env.RESILIENCE_OUTPUT||path.resolve(root,'../resilience');fs.mkdirSync(out,{recursive:true});
const model={provider:'fixture',modelId:'fixture'};
const rows=Array.from({length:2000},(_,i)=>({role:i%2?'assistant':'user',content:[{type:'text',text:`已保存轮次-${i}`}],timestamp:i+1}));
const ids=rows.map((_,i)=>`entry-${i}`);
let state;
function reset(){state={streams:new Map(),reads:[],holds:[],holdSid:null,pageHold:false,pageRequests:[],running:false,count:2000,posts:[]};}
function snap(sid,start=1900,end=state.count){
  const msgs=rows.slice(start,end),entryIds=ids.slice(start,end);
  return{sessionId:sid,filePath:`/isolated/${sid}.jsonl`,info:{id:sid,path:`/isolated/${sid}.jsonl`,cwd:'/isolated',messageCount:end,name:sid},tree:[],treeFormat:'summary',leafId:ids[end-1],snapshotRevision:`${sid}-${end}`,promptEntryIds:{},totalActiveMs:0,context:{messages:msgs,entryIds,oldestEntryId:entryIds[0],hasMore:start>0,thinkingLevel:'off',model}};
}
function json(res,data){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data));}
function emit(sid,event){for(const res of state.streams.get(sid)||[])if(!res.destroyed)res.write(`data: ${JSON.stringify(event)}\n\n`);}
function cut(sid){for(const res of state.streams.get(sid)||[])res.destroy();}
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{useAgentSession}from'./hooks/useAgentSession';
function View({sid}){const h=useAgentSession({session:{id:sid,path:'/isolated/'+sid+'.jsonl',cwd:'/isolated',name:sid,created:'2026-10-14T00:00:00Z',modified:'2026-10-14T00:00:00Z',messageCount:2000,firstMessage:''},newSessionCwd:null,newSessionDraftKey:null});window.fixture={state:()=>({sid,ids:h.entryIds,text:h.messages.map(m=>m.content?.[0]?.text),loading:h.loading,error:h.error,cursor:h.historyCursor,running:h.agentRunning}),reload:()=>h.retryLoadSession(),page:()=>h.loadContext(sid,h.activeLeafId,h.historyCursor,{tail:100}),event:e=>h.handleAgentEventRef.current(e)};return <main><h1>{sid}</h1><output data-ready data-loading={String(h.loading)} data-error={h.error||''}>{h.messages.length}条</output>{h.messages.map((m,i)=><div key={h.entryIds[i]||i} data-entry-id={h.entryIds[i]}>{m.content?.[0]?.text}</div>)}</main>}
function App(){const[sid,setSid]=useState('A');window.switchSession=setSid;return <View key={sid} sid={sid}/>};createRoot(document.getElementById('root')).render(<App/>);`},bundle:true,write:false,format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"development"'}});
const server=http.createServer(async(req,res)=>{
const u=new URL(req.url,'http://fixture');if(u.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
const agent=u.pathname.match(/^\/api\/agent\/([^/]+)(\/events)?$/),session=u.pathname.match(/^\/api\/sessions\/([^/]+)(\/(context|state))?$/);
if(agent?.[2]){const sid=agent[1];res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});if(!state.streams.has(sid))state.streams.set(sid,new Set());state.streams.get(sid).add(res);res.on('close',()=>state.streams.get(sid)?.delete(res));return res.write(`data: ${JSON.stringify({type:'connected',isStreaming:state.running,pendingExtensionUiIds:[]})}\n\n`);}
if(agent&&req.method==='POST'){let body='';for await(const c of req)body+=c;state.posts.push(JSON.parse(body));return json(res,{success:true,data:{},receipt:{status:'accepted'}});}
if(agent||session?.[3]==='state')return json(res,{running:state.running,state:{isStreaming:state.running,isPromptRunning:false,thinkingLevel:'off',model,queuedMessages:{steering:[],followUp:[]}},uncommittedPrompts:[],pendingExtensionUiRequests:[]});
if(session){const sid=session[1];if(session[3]==='context'){const before=u.searchParams.get('before');const end=ids.indexOf(before),start=Math.max(0,end-100);const body={context:snap(sid,start,end).context,before,tail:100};state.pageRequests.push({before,start,end});if(state.pageHold){state.holds.push({res,body,page:true});return;}return json(res,body);}
const body=snap(sid);state.reads.push({sid,count:state.count});if(state.holdSid===sid){state.holds.push({res,body});return;}return json(res,body);}
if(u.pathname.startsWith('/api/'))return json(res,{models:{},modelList:[],skills:[],tools:[],success:true,data:{}});
res.setHeader('content-type','text/html');res.end('<html lang="zh"><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
async function wait(check,label,ms=12000){const until=Date.now()+ms;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout '+label);}
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox']});const result={status:'checking',productionWrites:0,modelCalls:0,checks:[],errors:[]};
async function open(width,held=false,running=false){reset();state.running=running;if(held)state.holdSid='A';const ctx=await browser.newContext({viewport:{width,height:850},locale:'zh-CN'});const page=await ctx.newPage();page.on('pageerror',e=>result.errors.push(e.message));await page.goto(origin);await page.locator('[data-ready]').waitFor();if(!held)await wait(async()=>!(await page.evaluate(()=>window.fixture.state())).loading,'initial load');return{ctx,page};}
async function get(page){return page.evaluate(()=>window.fixture.state());}
try{
for(const width of[390,1280]){
// A slow running-session bootstrap admits history before opening SSE. The
// handshake must recover commits written while the initial snapshot was pending.
let cold=await open(width,true,true);await wait(()=>state.holds.length>0,'cold snapshot held');
assert.equal(state.streams.get('A')?.size||0,0,'SSE must not invalidate cold hydration');
const initial=state.holds.splice(0);state.count=2002;
rows[2000]={role:'assistant',content:[{type:'text',text:'加载期间完成的回答'}],timestamp:2001};ids[2000]='entry-2000';
rows[2001]={role:'toolResult',toolCallId:'cold-tool',toolName:'read',content:[{type:'text',text:'加载期间工具结果'}],timestamp:2002};ids[2001]='entry-2001';
emit('A',{type:'message_end',message:rows[2000]});emit('A',{type:'message_end',message:rows[2001]});
state.holdSid=null;for(const x of initial)json(x.res,x.body);
await wait(async()=>(await get(cold.page)).ids.includes('entry-2001'),'cold handshake catches commits');
let cv=await get(cold.page);assert.equal(cv.loading,false);assert.equal(cv.error,null);assert.equal(cv.running,true);
assert.equal(cv.ids.filter(x=>x==='entry-2000').length,1);assert.equal(cv.ids.filter(x=>x==='entry-2001').length,1);
assert.equal(state.reads.length,2,'one bootstrap and one handshake, without retry traffic');
result.checks.push({width,scenario:'running-cold-hydration-during-commits',passed:true,historyRequests:state.reads.length});await cold.ctx.close();

// Unmount A while HTTP is pending, return to A and resolve old response last.
let{ctx,page}=await open(width,true);await wait(()=>state.holds.length>0,'held A');const old=state.holds.splice(0);state.holdSid=null;await page.evaluate(()=>window.switchSession('B'));await wait(async()=>(await get(page)).sid==='B'&&(await get(page)).ids.length===100,'B');
state.count=2001;rows[2000]={role:'user',content:[{type:'text',text:'切换后最新消息'}],timestamp:2001};ids[2000]='entry-2000';await page.evaluate(()=>window.switchSession('A'));await wait(async()=>(await get(page)).ids.includes('entry-2000'),'new A');for(const x of old)json(x.res,x.body);await new Promise(r=>setTimeout(r,100));assert.equal((await get(page)).ids.at(-1),'entry-2000');assert.equal((await get(page)).sid,'A');
await page.screenshot({path:path.join(out,`switch-${width}.png`)});result.checks.push({width,scenario:'A-B-A-stale-response',passed:true});await ctx.close();
// Paging a 2000-entry conversation then refreshing a moving tail retains prefix.
({ctx,page}=await open(width));for(let i=0;i<5;i++){const before=(await get(page)).ids.length;await page.evaluate(()=>window.fixture.page());await wait(async()=>(await get(page)).ids.length===before+100,'older page');}
let v=await get(page);assert.equal(v.ids.length,600);assert.equal(new Set(v.ids).size,600);assert.equal(v.cursor,'entry-1400');
state.count=2001;await page.evaluate(()=>window.fixture.reload());await wait(async()=>(await get(page)).ids.includes('entry-2000'),'tail refresh');v=await get(page);assert.equal(v.ids[0],'entry-1400');assert.equal(v.ids.length,601);assert.equal(new Set(v.ids).size,601);
// Simultaneous old page response after refreshed head must be discarded/merged without duplicates.
state.pageHold=true;await page.evaluate(()=>void window.fixture.page());await wait(()=>state.holds.some(x=>x.page),'held page');state.count=2002;rows[2001]={role:'assistant',content:[{type:'text',text:'同步后最新回答'}],timestamp:2002};ids[2001]='entry-2001';await page.evaluate(()=>window.fixture.reload());await wait(async()=>(await get(page)).ids.includes('entry-2001'),'overlap tail');for(const x of state.holds.splice(0))json(x.res,x.body);await new Promise(r=>setTimeout(r,100));assert.equal((await get(page)).ids[0],'entry-1400','changed leaf rejects an obsolete page');state.pageHold=false;await page.evaluate(()=>window.fixture.page());await wait(async()=>(await get(page)).ids[0]==='entry-1300','retry current page');v=await get(page);assert.equal(v.ids.length,702);assert.equal(new Set(v.ids).size,702);assert.equal(v.ids.at(-1),'entry-2001');
result.checks.push({width,scenario:'2000-entry-paging-refresh-race',passed:true,loaded:702});await ctx.close();
// Native network stream drops, unseen completed turn is recovered by idle handshake.
({ctx,page}=await open(width));await wait(()=>state.streams.get('A')?.size>0,'SSE open');state.holdSid='A';await page.evaluate(()=>void window.fixture.reload());await wait(()=>state.holds.length>0,'pre-disconnect read');const idleOld=state.holds.splice(0);cut('A');state.holdSid=null;state.count=2001;await wait(async()=>(await get(page)).ids.includes('entry-2000'),'idle reconnect',15000);for(const x of idleOld)json(x.res,x.body);await new Promise(r=>setTimeout(r,100));assert.equal((await get(page)).ids.filter(x=>x==='entry-2000').length,1);result.checks.push({width,scenario:'native-SSE-idle-reconnect',passed:true});await ctx.close();
// A turn finishes while offline, another run is active at reconnect.
({ctx,page}=await open(width));await wait(()=>state.streams.get('A')?.size>0,'SSE running');emit('A',{type:'agent_start'});await wait(async()=>(await get(page)).running,'run begins');state.holdSid='A';await page.evaluate(()=>void window.fixture.reload());await wait(()=>state.holds.length>0,'pre-running-disconnect read');const runningOld=state.holds.splice(0);cut('A');state.holdSid=null;state.count=2001;state.running=true;await wait(async()=>(await get(page)).ids.includes('entry-2000'),'running reconnect unseen committed turn',15000);for(const x of runningOld)json(x.res,x.body);await new Promise(r=>setTimeout(r,100));assert.equal((await get(page)).ids.at(-1),'entry-2000');assert.equal((await get(page)).running,true);result.checks.push({width,scenario:'native-SSE-running-reconnect',passed:true});await ctx.close();
}
assert.deepEqual(result.errors,[]);assert.equal(state.posts.length,0);result.status='passed';
}catch(e){result.status='failed';result.failure=e.stack;console.error(e.stack);process.exitCode=1;}finally{result.at=new Date().toISOString();fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
