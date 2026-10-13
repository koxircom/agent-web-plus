// Actual ChatWindow surface with isolated local HTTP APIs; never contacts a production server.
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url),{build}=require('esbuild'),{chromium}=require('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const session={id:'prompt-delivery-fixture',cwd:'/isolated',name:'Prompt delivery fixture',path:'/isolated/session.jsonl',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:0,firstMessage:''};
const model={provider:'openai',modelId:'gpt-6.1-sol',id:'gpt-6.1-sol'};
const emptyContext={messages:[],entryIds:[],oldestEntryId:null,hasMore:false,thinkingLevel:'off',model};
const acceptedMessage='已接收消息：原文必须持续可见。';
const sendingMessage='正在发送的普通消息';
const recalledMessage='新标签撤回原文：第一行保留\n第二行也必须保留。';
const recalledRow={requestId:'recalled-delivery-fixture',sessionId:session.id,message:recalledMessage,status:'recalled',createdAt:Date.now()};

const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';
 import{ChatWindow}from'./components/ChatWindow';import{I18nProvider}from'./hooks/useI18n';
 createRoot(document.getElementById('root')).render(<I18nProvider><ChatWindow session={${JSON.stringify(session)}} newSessionCwd={null} newSessionDraftKey={null}/></I18nProvider>);
 `},bundle:true,write:false,loader:{'.css':'empty'},outfile:'prompt-delivery-fixture.js',format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"development"'}});

const streams=new Set();
const promptPosts=[];
const heldResponses=new Map();
const promptCountWaiters=[];
const heldSessionResponses=[];
const sessionReadWaiters=[];
let inboxRows=[];
let holdPromptResponses=false;
let holdSessionResponses=false;
let apiWrites=0;
function json(res,data){res.setHeader('content-type','application/json');res.end(JSON.stringify(data));}
function notifyPromptWaiters(){for(let i=promptCountWaiters.length-1;i>=0;i--){const waiter=promptCountWaiters[i];if(promptPosts.length>=waiter.count){promptCountWaiters.splice(i,1);waiter.resolve();}}}
function waitForPromptCount(count){if(promptPosts.length>=count)return Promise.resolve();return new Promise(resolve=>promptCountWaiters.push({count,resolve}));}
function waitForSessionRead(){if(heldSessionResponses.length)return Promise.resolve(heldSessionResponses[0]);return new Promise(resolve=>sessionReadWaiters.push(resolve));}
function releaseSessionRead(res){const index=heldSessionResponses.indexOf(res);if(index>=0)heldSessionResponses.splice(index,1);json(res,{sessionId:session.id,info:session,tree:[],leafId:null,totalActiveMs:0,context:emptyContext});}
function respondToPrompt(requestId){const res=heldResponses.get(requestId);if(!res)return false;heldResponses.delete(requestId);json(res,{success:true,data:{isStreaming:false,model,thinkingLevel:'off'},receipt:{status:'accepted'}});return true;}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 if(url.pathname.startsWith('/api/')&&req.method==='POST')apiWrites++;
 if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(url.pathname==='/api/agent/prompt-delivery-fixture/events'){
  res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');streams.add(res);req.on('close',()=>streams.delete(res));
  res.write(`data: ${JSON.stringify({type:'connected',isStreaming:false,pendingExtensionUiIds:[]})}\n\n`);return;
 }
 if(url.pathname==='/api/agent/prompt-delivery-fixture'&&req.method==='POST'){
  let raw='';for await(const chunk of req)raw+=chunk;const command=JSON.parse(raw);
  if(command.type==='prompt'){
   promptPosts.push({requestId:command.requestId,message:command.message,body:command});notifyPromptWaiters();
   if(holdPromptResponses){heldResponses.set(command.requestId,res);return;}
   return json(res,{success:true,data:{isStreaming:false,model,thinkingLevel:'off'},receipt:{status:'accepted'}});
  }
  return json(res,{success:true,data:{isStreaming:false,model,thinkingLevel:'off'}});
 }
 if(url.pathname==='/api/agent/prompt-delivery-fixture'&&req.method==='GET'){
  if(url.searchParams.has('interactions'))return json(res,{uncommittedPrompts:inboxRows,pendingExtensionUiRequests:[]});
  if(url.searchParams.has('requestId'))return json(res,{status:'accepted',inFlight:true});
  return json(res,{running:false,state:{isStreaming:false,isPromptRunning:false,thinkingLevel:'off',model,queuedMessages:{steering:[],followUp:[]},pendingExtensionUiRequests:[]}});
 }
 if(url.pathname==='/api/sessions/prompt-delivery-fixture/state')return json(res,{running:false,state:{isStreaming:false,isPromptRunning:false,thinkingLevel:'off',model,queuedMessages:{steering:[],followUp:[]}}});
 if(url.pathname==='/api/sessions/prompt-delivery-fixture'){
  if(holdSessionResponses){heldSessionResponses.push(res);const waiter=sessionReadWaiters.shift();if(waiter)waiter(res);return;}
  return json(res,{sessionId:session.id,info:session,tree:[],leafId:null,totalActiveMs:0,context:emptyContext});
 }
 if(url.pathname==='/api/models')return json(res,{models:{'openai:gpt-6.1-sol':'GPT-6.1 Sol'},modelList:[],skills:[],running:false,isStreaming:false,pendingExtensionUiRequests:[],data:{},tools:[]});
 if(url.pathname.startsWith('/api/'))return json(res,{success:true,data:{},models:{},modelList:[],skills:[],running:false,isStreaming:false,pendingExtensionUiRequests:[],data:{},tools:[]});
 res.setHeader('content-type','text/html');res.end('<!doctype html><html data-theme="dark"><head><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});

let browser;
const receipts=[];
const pageErrors=[];
const externalRequests=[];
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true});
 const origin=`http://127.0.0.1:${server.address().port}`;
 for(const width of [1280,390]){
  // Accepted prompts remain silent in the real ChatWindow surface.
  holdPromptResponses=false;inboxRows=[];
  {
   const context=await browser.newContext({locale:'zh-CN',viewport:{width,height:844},hasTouch:width<500});
   const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
   page.on('request',request=>{if(new URL(request.url()).origin!==origin)externalRequests.push(request.url());});
   await page.goto(origin);await page.locator('textarea').last().waitFor();
   const acceptedPostStart=promptPosts.length;
   const input=page.locator('textarea').last();await input.fill(acceptedMessage);
   await page.locator('button[aria-label="发送"]').click();
   await waitForPromptCount(acceptedPostStart+1);
   const acceptedRequest=promptPosts.at(-1);assert.equal(acceptedRequest.message,acceptedMessage);
   await page.waitForFunction(requestId=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]').some(row=>row.requestId===requestId&&row.status==='accepted'),acceptedRequest.requestId);
   assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'accepted prompts never render the legacy recovery card');
   assert.equal(await page.locator('[class~="border-amber-500/40"]').count(),0,'accepted prompts never render an amber recovery card');
   assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'accepted originals stay out of the DOM by default');
   assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0,'accepted prompts do not expose the history button');
   assert.equal(await page.locator('.pi-native-extension-column > *').count(),0,'accepted prompts leave the extension surface empty');
   assert.equal(await page.getByRole('dialog').count(),0,'no saved-prompt dialog is mounted');
   receipts.push({width,scenario:'accepted',requestId:acceptedRequest.requestId,status:'accepted',legacyCardCount:0,historyButtonVisible:false,savedOriginalMounted:false});
   await context.close();
  }

  // The pending row is durable in the tab store while the HTTP command is held,
  // but a normal sending row must not render as a persistent delivery card.
  holdPromptResponses=true;inboxRows=[];
  {
   const context=await browser.newContext({locale:'zh-CN',viewport:{width,height:844},hasTouch:width<500});
   const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
   page.on('request',request=>{if(new URL(request.url()).origin!==origin)externalRequests.push(request.url());});
   await page.goto(origin);await page.locator('textarea').last().waitFor();
   const sendingPostStart=promptPosts.length;
   await page.locator('textarea').last().fill(sendingMessage);await page.locator('button[aria-label="发送"]').click();
   await waitForPromptCount(sendingPostStart+1);
   const sendingRequest=promptPosts.at(-1);assert.equal(sendingRequest.message,sendingMessage);
   await page.waitForFunction(requestId=>{
    const rows=JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]');
    return rows.some(row=>row.requestId===requestId&&row.status==='sending');
   },sendingRequest.requestId);
   assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'sending row is not a persistent card');
   assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0,'sending rows do not expose the history button');
   assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'sending originals stay out of the DOM');
   assert.equal(await page.locator('.pi-native-extension-dock').count(),0,'no extension dock is rendered for sending alone');
   const sendingStorage=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')||'[]'));
   const sendingRow=sendingStorage.find(row=>row.requestId===sendingRequest.requestId);
   assert.equal(sendingRow?.status,'sending');assert.equal(sendingRow?.message,sendingMessage);
   assert.ok(respondToPrompt(sendingRequest.requestId),'held local prompt response is released');
   receipts.push({width,scenario:'sending',requestId:sendingRequest.requestId,status:sendingRow.status,persistentCardCount:0,requestSentToLocalFixture:true});
   await context.close();
  }

  // A fresh tab has no sessionStorage. Hydrate a recalled row through the
  // session interaction snapshot and inspect it only after opening history.
  holdPromptResponses=false;holdSessionResponses=true;inboxRows=[recalledRow];
  {
   const writesBefore=apiWrites,promptPostsBefore=promptPosts.length;
   const context=await browser.newContext({locale:'zh-CN',viewport:{width,height:844},hasTouch:width<500});
   const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
   page.on('request',request=>{if(new URL(request.url()).origin!==origin)externalRequests.push(request.url());});
   await page.addInitScript(()=>{window.__freshPromptStoreWasEmpty=sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')===null;});
   await page.goto(origin);
   const heldSessionRead=await waitForSessionRead();
   const initialTextarea=await page.locator('textarea').last().elementHandle();
   assert.ok(initialTextarea,'ChatInput exists while the real session history read is pending');
   assert.equal(await initialTextarea.evaluate(element=>element.isConnected),true);
   assert.equal(await page.evaluate(()=>window.__freshPromptStoreWasEmpty),true,'new tab starts without a tab-scoped prompt copy');
   releaseSessionRead(heldSessionRead);holdSessionResponses=false;
   await page.locator('[data-pi-native-scroll-owner]').waitFor({state:'attached',timeout:5000});
   assert.equal(await initialTextarea.evaluate(element=>element===document.querySelectorAll('textarea').item(document.querySelectorAll('textarea').length-1)),true,'the same composer textarea remains connected after history hydration');
   assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'new-tab recall never mounts the legacy recovery card');
   assert.equal(await page.locator('[class~="border-amber-500/40"]').count(),0,'new-tab recall never mounts an amber recovery card');
   assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'new-tab recalled original is absent from the DOM until opened');
   const historyButton=page.getByRole('button',{name:'已保留消息'});
   await historyButton.waitFor({state:'visible',timeout:5000});
   await historyButton.click();
   const savedDialog=page.getByRole('dialog',{name:'已保留消息'});
   const savedRow=savedDialog.locator('[data-pi-saved-prompt]');
   await savedRow.waitFor();
   assert.equal(await savedRow.getAttribute('data-pi-saved-prompt'),recalledRow.requestId);
   await savedRow.locator('details > summary').click();
   await savedRow.getByText(recalledMessage,{exact:true}).waitFor();
   const savedText=await savedRow.evaluate(element=>element.textContent??'');
   assert.ok(savedText.includes(recalledMessage),'opening history preserves the complete recalled original text');
   assert.ok(savedText.includes('消息已撤回，原文已保留'),'recalled receipt keeps its accurate status');
   await savedDialog.getByRole('button',{name:'关闭已保留消息'}).click();
   assert.equal(await savedDialog.count(),0);
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'已保留消息','closing returns focus to the history button');
   assert.equal(await page.evaluate(()=>sessionStorage.getItem('pi-web:unconfirmed-prompts-v1')!==null),true,'server inbox hydrated a fresh tab store');
   assert.equal(await page.locator('.pi-native-extension-column > *').count(),0,'the native saved-prompt dialog does not create an extension dock surface');
   assert.equal(await page.getByRole('dialog').count(),0,'no unrelated extension dialog is open');
   assert.equal(promptPosts.length,promptPostsBefore,'hydration never resends the recalled prompt');
   assert.equal(apiWrites,writesBefore,'initial recalled hydration makes no local API writes');
   receipts.push({width,scenario:'fresh-tab-recalled',requestId:recalledRow.requestId,status:'recalled',legacyCardCount:0,historyOpened:true,originalTextPresent:savedText.includes(recalledMessage),sessionStorageInitiallyEmpty:true,textareaPreservedAcrossHydration:true,noPromptReplay:true,noApiWrites:true});
   await context.close();
  }
 }
 assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[],'all browser requests stay inside the local HTTP fixture');
 console.log(JSON.stringify({status:'passed',viewportWidths:[1280,390],productionRequests:0,externalRequests,apiWrites,promptPosts:promptPosts.map(({requestId,message})=>({requestId,message})),receipts,pageErrors},null,2));
}finally{
 holdPromptResponses=false;holdSessionResponses=false;for(const [requestId] of heldResponses)respondToPrompt(requestId);
 for(const response of [...heldSessionResponses])releaseSessionRead(response);
 if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
