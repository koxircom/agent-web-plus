// Real client delivery/store/panel in a browser; every API is an isolated fixture.
import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url),esbuild=require('esbuild'),{chromium}=require('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const bundle=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {I18nProvider} from './hooks/useI18n';import {ChatInput} from './components/ChatInput';
 import {sendAgentCommand,readPromptReceipt} from './lib/agent-client';
 import * as store from './lib/prompt-submissions';
 function Fixture(){const [owner,setOwner]=React.useState('A');
 const rows=React.useSyncExternalStore(store.subscribePendingPromptSubmissions,store.getPendingPromptSubmissions,store.getServerPendingPromptSubmissions);
 const confirm=async row=>{const receipt=await readPromptReceipt(row.sessionId,row.requestId);if(receipt.status==='committed')store.releasePromptSubmission(row.requestId);else store.reconcilePromptSubmission(row.requestId,receipt)};
 window.fixture={send:message=>sendAgentCommand(owner,{type:'prompt',message}),setOwner,confirm:()=>confirm(store.getPendingPromptSubmissions()[0]),rows:()=>store.getPendingPromptSubmissions(),restore:store.mergeServerPromptSubmissions};
 return <><div id="history">Yesterday's history</div><ChatInput draftKey={owner} isStreaming={false} onSend={()=>{}} onAbort={()=>{}}
   retainedSubmissions={rows.filter(row=>row.sessionId===owner)} onConfirmSubmission={confirm}/></>}
 createRoot(document.getElementById('root')).render(<I18nProvider><Fixture/></I18nProvider>);
 `},bundle:true,write:false,loader:{'.css':'empty'},format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'}});
let posts=0,reads=0,mode='accepted',records=new Map();
const server=http.createServer(async(req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].text);return}
 if(req.url.startsWith('/api/')){
  res.setHeader('content-type','application/json');
  if(req.method==='POST'){posts++;let data='';for await(const chunk of req)data+=chunk;const command=JSON.parse(data);records.set(command.requestId,command);if(mode==='lost'){req.socket.destroy();return}res.end(JSON.stringify({success:true,receipt:{status:mode}}));return}
  reads++;res.end(JSON.stringify({status:mode==='lost'?'accepted':mode,inFlight:mode!=='lost'}));return;
 }
 res.setHeader('content-type','text/html');res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
let browser;const results=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});
 for(const width of [1280,390]){
 const context=await browser.newContext({locale:'zh-CN',viewport:{width,height:844}});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const before=posts,beforeUnique=records.size;mode='accepted';await page.goto(url);await page.waitForFunction(()=>window.fixture);
 await page.evaluate(()=>fixture.send('SSD 新一轮，不能被昨天的记录覆盖'));
 assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'normal admission never renders the legacy recovery card');assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0,'accepted rows do not expose the history button');assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'accepted originals stay out of the DOM by default');assert.equal(posts,before+1);
 assert.equal(await page.evaluate(()=>fixture.rows()[0].status),'accepted');
 assert.equal(await page.evaluate(()=>fixture.rows()[0].message),'SSD 新一轮，不能被昨天的记录覆盖');
 await page.reload();await page.waitForFunction(()=>window.fixture);assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0);assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0);
 await page.evaluate(()=>fixture.setOwner('B'));await page.waitForFunction(()=>document.querySelector('[data-pi-saved-prompt]')===null);assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0);
 await page.evaluate(()=>fixture.setOwner('A'));assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0);assert.equal(await page.getByRole('button',{name:'已保留消息'}).count(),0);
 // Older history changes cannot remove the independent submission owner.
 await page.evaluate(()=>document.querySelector('#history').textContent='Older snapshot loaded');assert.equal(await page.evaluate(()=>fixture.rows()[0].message),'SSD 新一轮，不能被昨天的记录覆盖');
 mode='committed';await page.evaluate(()=>fixture.confirm());await page.waitForFunction(()=>fixture.rows().length===0);
 assert.equal(posts,before+1,'receipt check cannot replay');
 mode='lost';await page.evaluate(()=>fixture.send('响应丢失但服务端已经接收'));await page.getByRole('button',{name:'已保留消息'}).waitFor();
 console.log(JSON.stringify({width,lostResponseRawPosts:posts-before,uniqueSubmissions:records.size-beforeUnique}));
 assert.equal(records.size,beforeUnique+2,'transport retries must retain the original request identity');const afterLost=posts;assert.equal(await page.evaluate(()=>fixture.rows()[0].status),'uncertain');
 assert.equal(await page.locator('[data-pi-pending-prompt]').count(),0,'uncertain delivery never renders the legacy recovery card');assert.equal(await page.locator('[data-pi-saved-prompt]').count(),0,'uncertain original stays out of the DOM until requested');
 await page.evaluate(()=>fixture.setOwner('B'));await page.waitForFunction(()=>document.querySelector('[aria-label="已保留消息"]')===null);assert.equal(await page.getByRole('dialog',{name:'已保留消息'}).count(),0,'switching away hides the saved-prompt menu');
 await page.evaluate(()=>fixture.setOwner('A'));await page.getByRole('button',{name:'已保留消息'}).waitFor();assert.equal(await page.getByRole('dialog',{name:'已保留消息'}).count(),0,'switching back does not auto-open the saved-prompt menu');
 const lostIcon=page.getByRole('button',{name:'已保留消息'});await lostIcon.click();const lostDialog=page.getByRole('dialog',{name:'已保留消息'});const lostRow=lostDialog.locator('[data-pi-saved-prompt]');await lostRow.waitFor();await lostRow.locator('details > summary').click();await lostRow.getByText('响应丢失但服务端已经接收',{exact:true}).waitFor();
 await lostDialog.getByRole('button',{name:'关闭已保留消息'}).click();assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'已保留消息','closing returns focus to the history button');
 // A different tab has no sessionStorage; hydrate from the saved server inbox.
 const row=await page.evaluate(()=>fixture.rows()[0]);const tab=await context.newPage();await tab.goto(url);await tab.waitForFunction(()=>window.fixture);
 assert.equal(await tab.evaluate(()=>fixture.rows().length),0);await tab.evaluate(row=>fixture.restore([row]),row);await tab.getByRole('button',{name:'已保留消息'}).waitFor();assert.equal(await tab.locator('[data-pi-pending-prompt]').count(),0);assert.equal(await tab.locator('[data-pi-saved-prompt]').count(),0);await tab.getByRole('button',{name:'已保留消息'}).click();const tabSaved=tab.locator('[data-pi-saved-prompt]');await tabSaved.locator('details > summary').click();await tabSaved.getByText('响应丢失但服务端已经接收',{exact:true}).waitFor();assert.equal(posts,afterLost);
 results.push({width,refresh:true,switch:true,oldHistory:true,lostResponse:true,newTabInbox:true,noReplay:true,pageErrors:errors});assert.deepEqual(errors,[]);await context.close();
 }
 console.log(JSON.stringify({status:'passed',productionWrites:0,posts,receiptReads:reads,checks:results},null,2));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
