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
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';
 import{ChatWindow}from'./components/ChatWindow';import{I18nProvider}from'./hooks/useI18n';
 function Fixture(){const[s,setS]=useState(null);return <ChatWindow key='stable-chat-window' session={s} newSessionCwd={s?null:'/isolated'} newSessionDraftKey={s?null:'new:isolated'} onSessionCreated={info=>setS(info)}/>}; createRoot(document.getElementById('root')).render(<I18nProvider><Fixture/></I18nProvider>);
 `},bundle:true,loader:{'.css':'empty'},write:false,outfile:'prompt-delivery-fixture.js',format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_APP_VERSION':'"1.3.69"','process.env.NEXT_PUBLIC_PI_VERSION':'"1.1.0"'}});

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
 if(url.pathname==='/api/agent/new')return json(res,{sessionId:session.id,model,thinkingLevel:'off'});
 if(url.pathname==='/api/agent/prompt-delivery-fixture/events'){
  res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');streams.add(res);req.on('close',()=>streams.delete(res));
  res.write(`data: ${JSON.stringify({type:'connected',isStreaming:false,pendingExtensionUiIds:[]})}\n\n`);return;
 }
 if(url.pathname==='/api/agent/prompt-delivery-fixture'&&req.method==='POST'){
  let raw='';for await(const chunk of req)raw+=chunk;const command=JSON.parse(raw);
  if(command.type==='prompt'){
   promptPosts.push({requestId:command.requestId,message:command.message,body:command});notifyPromptWaiters();
   for(const stream of streams)for(const [id,message,notifyType]of[['startup-warning','[MCP] Could not connect to fixture: isolated diagnostic','warning'],['startup-info','Fixture startup ready','info']])stream.write(`data: ${JSON.stringify({type:'extension_ui_request',method:'notify',id,message,notifyType})}\n\n`);
   await new Promise(resolve=>setTimeout(resolve,180));
   if(holdPromptResponses){heldResponses.set(command.requestId,res);return;}
   return json(res,{success:true,data:{isStreaming:false,model,thinkingLevel:'off'},receipt:{status:'accepted'}});
  }
  return json(res,{success:true,data:{isStreaming:false,model,thinkingLevel:'off'}});
 }
 if(url.pathname==='/api/agent/prompt-delivery-fixture'&&req.method==='GET'){
  if(url.searchParams.has('interactions'))return json(res,{uncommittedPrompts:inboxRows,pendingExtensionUiRequests:[]});
  if(url.searchParams.has('requestId')){await new Promise(resolve=>setTimeout(resolve,120));return json(res,{status:'committed'});}
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
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true});
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:390,height:844},hasTouch:true});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.error('browser error',e.stack);});
 await page.addInitScript(()=>{
  localStorage.setItem('pi-enh-notification-settings-v1',JSON.stringify({schemaVersion:1,channels:{mcp:false,'native-info':false}}));
  window.__flashMutations=[];
  new MutationObserver(records=>{for(const record of records)for(const [action,nodes]of[['add',record.addedNodes],['remove',record.removedNodes]])for(const node of nodes)if(node instanceof Element){for(const el of [node,...node.querySelectorAll('.notice-shelf-item,[data-pi-pending-prompt]')])if(el.matches('.notice-shelf-item,[data-pi-pending-prompt]'))window.__flashMutations.push({at:performance.now(),action,kind:el.matches('.notice-shelf-item')?'notice':'pending',text:el.textContent});}}).observe(document,{subtree:true,childList:true});
 });
 const origin=`http://127.0.0.1:${server.address().port}`;
 await page.goto(origin);await page.locator('textarea').last().waitFor({state:'attached',timeout:5000}).catch(async e=>{console.error((await page.content()).slice(-3000));throw e;});
 await page.locator('textarea').last().fill('新会话闪现隔离诊断');await page.locator('button[aria-label="发送"]').click();
 await page.waitForFunction(()=>window.__flashMutations.some(x=>x.kind==='pending'&&x.action==='remove'),{timeout:5000});
 console.log(JSON.stringify({mutations:await page.evaluate(()=>window.__flashMutations),errors,posts:promptPosts.length},null,2));
}finally{if(browser)await browser.close();for(const stream of streams)stream.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
