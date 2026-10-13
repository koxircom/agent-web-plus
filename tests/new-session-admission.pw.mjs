// Actual new-session ChatWindow; isolated HTTP/SSE only, no model or production writes.
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild'),{chromium}=require('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const model={provider:'openai',modelId:'fixture',id:'fixture'};
const info={id:'new-admission-fixture',cwd:'/isolated',path:'/isolated/session.jsonl',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:1,firstMessage:'new admission'};
const savedMessage='本轮原文：必须保存且不能重发';
const coldRequestId='cold-uncertain-fixture';
const coldMessage='旧标签中的未确认原文';
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';
 import{ChatWindow}from'./components/ChatWindow';import{I18nProvider}from'./hooks/useI18n';
 function Fixture(){const[s,setS]=useState(window.__restoreSession||null);return <ChatWindow key="stable-chat-window" session={s} newSessionCwd={s?null:'/isolated'} newSessionDraftKey={s?null:'new:isolated'} onSessionCreated={setS}/>}
 createRoot(document.getElementById('root')).render(<I18nProvider><Fixture/></I18nProvider>);
 `},bundle:true,write:false,loader:{'.css':'empty'},outfile:'admission.js',format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_APP_VERSION':'"fixture"','process.env.NEXT_PUBLIC_PI_VERSION':'"1.1.0"'}});
const streams=new Set(),posts=[],errors=[],externalRequests=[],results=[];
let scenario='normal',receiptReads=0,committed=false;
function json(res,data){res.setHeader('content-type','application/json');res.end(JSON.stringify(data));}
function emit(event){for(const res of streams)res.write(`data: ${JSON.stringify(event)}\n\n`);}
function delivery(requestId,status){if(status==='committed'&&(requestId===posts[0]?.requestId||requestId===coldRequestId))committed=true;emit({type:'prompt_delivery',requestId,receipt:{status}});}
async function waitForEventStream(){const deadline=Date.now()+5000;while(!streams.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.ok(streams.size,'the isolated session event stream is connected');}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(url.pathname==='/api/agent/new')return json(res,{sessionId:info.id,model,thinkingLevel:'off'});
 if(url.pathname===`/api/agent/${info.id}/events`){res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');streams.add(res);req.on('close',()=>streams.delete(res));res.write(`data: ${JSON.stringify({type:'connected',isStreaming:posts.length>0,pendingExtensionUiIds:[]})}\n\n`);return;}
 if(url.pathname===`/api/agent/${info.id}`&&req.method==='POST'){
  let raw='';for await(const chunk of req)raw+=chunk;const command=JSON.parse(raw);
  if(command.type==='prompt'){
   posts.push(command);
   emit({type:'agent_start'});
   emit({type:'extension_ui_request',id:'muted-mcp',method:'notify',message:'[MCP] Could not connect to isolated fixture',notifyType:'warning'});
   emit({type:'extension_ui_request',id:'muted-info',method:'notify',message:'Fixture startup ready',notifyType:'info'});
   emit({type:'extension_ui_request',id:'real-warning',method:'notify',message:'磁盘空间不足：隔离警告',notifyType:'warning'});
   if(scenario==='early-commit')delivery(command.requestId,'committed');
   if(scenario==='early-failure')delivery(command.requestId,'unconfirmed');
   await new Promise(resolve=>setTimeout(resolve,scenario==='sending'?500:120));
   if(scenario==='lost-response'){res.setHeader('content-type','application/json');res.end('{"success":');return;}
   return json(res,{success:true,data:null,receipt:{status:'accepted'}});
  }
  return json(res,{success:true,data:{isStreaming:true,isPromptRunning:true,model,thinkingLevel:'off',commands:[],tools:[]}});
 }
 if(url.pathname===`/api/agent/${info.id}`){
  if(url.searchParams.has('requestId')){receiptReads++;return json(res,{status:scenario==='lost-response'||scenario==='cold-refresh-uncertain'?'unknown':committed?'committed':'accepted',inFlight:scenario!=='orphan'&&scenario!=='lost-response'&&scenario!=='cold-refresh-uncertain'});}
  if(url.searchParams.has('interactions')){
   const row=posts[0];
   const snapshot=row&&!committed?[{requestId:row.requestId,sessionId:info.id,message:row.message,status:'accepted',createdAt:Date.now()}]:[];
   if(scenario==='stale-inbox'&&snapshot.length){delivery(row.requestId,'committed');await new Promise(resolve=>setTimeout(resolve,200));}
   return json(res,{uncommittedPrompts:snapshot,pendingExtensionUiRequests:[]});
  }
  return json(res,{running:posts.length>0,state:{isStreaming:posts.length>0,isPromptRunning:posts.length>0,model,thinkingLevel:'off',queuedMessages:{steering:[],followUp:[]}}});
 }
 if(url.pathname===`/api/sessions/${info.id}`)return json(res,{sessionId:info.id,info,tree:[],leafId:null,totalActiveMs:0,context:{messages:[],entryIds:[],oldestEntryId:null,hasMore:false,model,thinkingLevel:'off'}});
 if(url.pathname===`/api/sessions/${info.id}/state`)return json(res,{running:posts.length>0,state:{isStreaming:posts.length>0,isPromptRunning:posts.length>0,model,thinkingLevel:'off'}});
 if(url.pathname==='/api/models')return json(res,{models:{'openai:fixture':'Fixture'},modelList:[],defaultModel:model});
 if(url.pathname.startsWith('/api/'))return json(res,{success:true,data:{},tools:[],skills:[]});
 res.setHeader('content-type','text/html');res.end('<!doctype html><html data-theme="dark"><head><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}button,textarea{font:inherit}</style></head><body><div id="root"></div><script>window.__restoreSession='+JSON.stringify((scenario==='refresh-live'&&posts.length)||scenario==='cold-refresh-uncertain'?info:null)+'</script><script src="/bundle.js"></script></body></html>');
});
let browser;
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true});
 const origin=`http://127.0.0.1:${server.address().port}`;
 for(const width of (process.env.WIDTHS?.split(',').map(Number)??[390,1280]))for(const mode of (process.env.SCENARIOS?.split(',')??['normal','sending','early-commit','early-failure','orphan','fsync-failure','stale-inbox','refresh-live','lost-response','cold-refresh-uncertain'])){
  scenario=mode;posts.length=0;receiptReads=0;committed=false;
  const context=await browser.newContext({locale:'zh-CN',viewport:{width,height:844},hasTouch:width<500});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).origin!==origin)externalRequests.push(r.url());});
  await page.addInitScript((initialRow)=>{
   localStorage.setItem('pi-enh-notification-settings-v1',JSON.stringify({schemaVersion:1,channels:{mcp:false,'native-info':false}}));
   if(initialRow)sessionStorage.setItem('pi-web:unconfirmed-prompts-v1',JSON.stringify([initialRow]));
   window.__admissionMutations=[];
   const legacySelector='.notice-shelf-item,[data-pi-pending-prompt]';
   new MutationObserver(records=>{for(const r of records)for(const node of r.addedNodes)if(node instanceof Element)for(const el of [node,...node.querySelectorAll('*')])if(el.matches(legacySelector)||el.classList.contains('border-amber-500/40'))window.__admissionMutations.push({kind:el.matches('.notice-shelf-item')?'notice':'legacy-recovery',text:el.textContent,at:performance.now()});}).observe(document,{subtree:true,childList:true});
  },mode==='cold-refresh-uncertain'?{requestId:coldRequestId,sessionId:info.id,message:coldMessage,status:'uncertain',createdAt:Date.now(),streamingBehavior:'followUp'}:null);
  await page.goto(origin);
  if(mode==='cold-refresh-uncertain'){
   await page.waitForFunction(()=>document.querySelector('textarea'));
   await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').some(r=>r.status==='uncertain'));
   assert.equal(posts.length,0,'a cold uncertain backup never sends a prompt');
   assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'cold refresh never revives the legacy recovery card');
   assert.equal(await page.locator('[class~="border-amber-500/40"]').count(),0,'cold refresh inserts no amber recovery card');
   assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'cold refresh keeps the saved original out of the DOM by default');
   assert.equal(await page.getByRole('dialog',{name:'已保留消息'}).count(),0,'the history popover starts closed');
   const icon=page.getByRole('button',{name:'已保留消息'});
   assert.equal(await icon.count(),1,'uncertain sessionStorage row exposes the neutral history button');
   await icon.click();
   const dialog=page.getByRole('dialog',{name:'已保留消息'});
   const saved=dialog.locator('[data-pi-saved-prompt]');
   await saved.waitFor();
   assert.equal(await saved.getAttribute('data-pi-saved-prompt'),coldRequestId);
   await saved.locator('details > summary').click();
   await saved.getByText(coldMessage,{exact:true}).waitFor();
   await dialog.getByRole('button',{name:'关闭已保留消息'}).click();
   assert.equal(await dialog.count(),0);
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'已保留消息','closing returns focus to the history button');
   assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1'))[0].message),coldMessage,'viewing does not clear the cold backup');
   await waitForEventStream();
   delivery(coldRequestId,'committed');
   await page.waitForFunction(()=>sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')===null);
   assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0,'late committed receipt removes the history button');
   const coldMutations=await page.evaluate(()=>window.__admissionMutations);
   assert.equal(coldMutations.filter(x=>x.kind==='legacy-recovery').length,0,'cold refresh inserts no legacy recovery card');
   results.push({width,scenario:mode,promptPosts:posts.length,legacyRecoveryInsertions:0,coldOriginalRetainedUntilCommit:true,historyButtonRemovedAfterCommit:true});
   console.log(JSON.stringify({width,mode,promptPosts:posts.length}));
   await context.close();
   continue;
  }
  await page.locator('textarea').last().fill(savedMessage);await page.locator('button[aria-label="发送"]').click();
  if(mode==='sending'){
   await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').some(r=>r.status==='sending'));
   assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0,'sending submissions do not expose the history button');
   assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'sending originals stay out of the DOM');
  }
  await page.waitForFunction(()=>{const rows=JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]');return rows.some(r=>r.status==='unconfirmed'||r.status==='accepted')||document.querySelector('.notice-shelf-item');});
  // Wait for HTTP admission without treating a timeout as an acceptance event.
  await page.waitForFunction(()=>!JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').some(r=>r.status==='sending'));
  assert.equal(posts.length,1,'one exact prompt POST, never replayed');const id=posts[0].requestId;
  const admittedRow=await page.evaluate(requestId=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').find(r=>r.requestId===requestId),id);
  const shouldShowHistory=Boolean(admittedRow&&['uncertain','unconfirmed','recalled'].includes(admittedRow.status));
  assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),shouldShowHistory?1:0,'only uncertain, unconfirmed, or recalled rows expose history');
  await page.getByText('磁盘空间不足：隔离警告',{exact:true}).waitFor();
  assert.equal(await page.locator('.notice-shelf-item').count(),1,'actionable warning survives new-session promotion');
  const history=await page.evaluate(()=>window.__PI_NATIVE_NOTIFICATION_POLICY__.history());
  assert.equal(history.filter(x=>x.message.includes('[MCP]')).length,1,'one typed event produces one history record');
  assert.equal(history.find(x=>x.message.includes('[MCP]')).suppressed,true);
  let beforeReload=[];
  assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'no scenario mounts the legacy recovery card by default');
  assert.equal(await page.locator('[class~="border-amber-500/40"]').count(),0,'no scenario mounts an amber recovery card by default');
  assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'saved originals stay out of the DOM until the user opens history');
  assert.equal(await page.getByRole('dialog',{name:'已保留消息'}).count(),0,'the history popover starts closed');
  if(['normal','sending','fsync-failure','refresh-live','lost-response'].includes(mode)){
   assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'normal admission never mounts the legacy recovery card');
   assert.equal(await page.locator('.pi-native-extension-dock').count(),0,'no empty recovery dock');
   assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1'))[0].message),savedMessage);
   delivery('unrelated-request','committed');
   assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')).length),1,'another request cannot acknowledge this backup');
   if(mode==='refresh-live'){
    beforeReload=await page.evaluate(()=>window.__admissionMutations);
    await page.reload();await page.waitForFunction(()=>document.querySelector('textarea'));
    await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').some(r=>r.status==='accepted'));
    assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'refresh does not manufacture a delivery failure');
   }
   if(mode!=='lost-response')delivery(id,mode==='fsync-failure'?'unconfirmed':'committed');
  }
  if(['orphan','fsync-failure','early-failure','lost-response'].includes(mode)){
   await page.waitForFunction((requestId)=>{const rows=JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]');return rows.some(r=>r.requestId===requestId&&['uncertain','unconfirmed','recalled'].includes(r.status));},id);
   const row=await page.evaluate((requestId)=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').find(r=>r.requestId===requestId),id);
   assert.equal(row.message,savedMessage,'the exact failed/unknown original remains in sessionStorage');
   assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'failed and unknown deliveries never mount the legacy recovery card');
   assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'the saved original is absent from the DOM until requested');
   const icon=page.getByRole('button',{name:'已保留消息'});
   assert.equal(await icon.count(),1,'uncertain, unconfirmed, or recalled rows expose the neutral history button');
   await icon.click();
   const dialog=page.getByRole('dialog',{name:'已保留消息'});
   const saved=dialog.locator('[data-pi-saved-prompt]');
   await saved.waitFor();
   assert.equal(await saved.getAttribute('data-pi-saved-prompt'),id);
   await saved.locator('details > summary').click();
   await saved.getByText(savedMessage,{exact:true}).waitFor();
   await dialog.getByRole('button',{name:'关闭已保留消息'}).click();
   assert.equal(await dialog.count(),0);
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'已保留消息','closing returns focus to the history button');
   assert.equal(await page.evaluate((requestId)=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').find(r=>r.requestId===requestId)?.message,id),savedMessage,'closing does not discard the original backup');
   delivery(id,'committed');
   await page.waitForFunction((requestId)=>!JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').some(r=>r.requestId===requestId),id);
   assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0,'a late committed receipt removes the history button');
  }else if(mode!=='stale-inbox'&&mode!=='lost-response'){
   await page.waitForFunction(()=>sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')===null);
   assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0);
  }
  if(mode==='stale-inbox'){await new Promise(resolve=>setTimeout(resolve,400));assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'late accepted snapshot must never resurrect a committed request');assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0,'late accepted snapshot must not revive the history button');}
  const mutations=[...beforeReload,...await page.evaluate(()=>window.__admissionMutations)];
  assert.equal(mutations.filter(x=>/\[MCP\]|Fixture startup ready/.test(x.text)).length,0,'muted text never enters DOM, including before enhancements load');
  assert.equal(mutations.filter(x=>x.kind==='legacy-recovery').length,0,'all scenarios have zero legacy recovery-card insertions');
  console.log(JSON.stringify({width,mode,receiptReads,promptPosts:posts.length}));
  const maxReads=mode==='fsync-failure'?4:3; // The injected failure introduces one additional state to check.
  assert.ok(receiptReads<=maxReads,`${width}/${mode}: only the existing immediate recovery checks run; got ${receiptReads}`);
  results.push({width,scenario:mode,promptPosts:posts.length,receiptReads,mutedDomInsertions:0,legacyRecoveryInsertions:mutations.filter(x=>x.kind==='legacy-recovery').length,originalRetained:['orphan','fsync-failure','early-failure','lost-response'].includes(mode),actionableWarningVisible:true});
  await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
 console.log(JSON.stringify({status:'passed',productionRequests:0,results,errors},null,2));
}finally{if(browser)await browser.close();for(const stream of streams)stream.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
