// Real React sidebar + real enhancement action dispatcher, all APIs isolated.
import http from 'node:http';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const load=createRequire(import.meta.url),esbuild=load('esbuild'),{chromium}=load(process.env.COMPOSER_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const sessions=['alpha','beta'].map(id=>({id,path:'/fixture/'+id+'.jsonl',cwd:'/fixture',name:id,created:'2026-10-10T12:00:00Z',modified:'2026-10-10T12:00:00Z',messageCount:1,firstMessage:id}));
const data={sessions,sessionListVersion:1,runningSessionIds:[],completionNotificationSuppressedSessionIds:[]};
const moduleSource=readFileSync(root+'/enhancements/modules/04-sidebar-and-session-management.js','utf8');
const renameSource=moduleSource.slice(moduleSource.indexOf('  function triggerSessionInlineRename('),moduleSource.indexOf('  window.__PI_ENH_TRIGGER_SESSION_INLINE_RENAME__'));
assert(renameSource.includes('dispatchEvent'));
assert(!renameSource.includes('createElement'));
const bundle=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';
 import{SessionSidebar}from'./components/SessionSidebar';import{I18nProvider}from'./hooks/useI18n';
 const bootstrap=${JSON.stringify({...data,renderedAt:Date.now()})};
 window.fixture={hidden:false};
 window.__PI_ENH_PROCESS_SESSION_GROUPS__=groups=>window.fixture.hidden?groups.filter(g=>g.root.id!=='alpha'):groups;
 createRoot(document.getElementById('root')).render(<I18nProvider><div style={{height:800,width:360,display:'flex'}}><SessionSidebar bootstrap={bootstrap} initialSessionId="alpha" onSelectSession={()=>{}} onNewSession={()=>{}} /></div></I18nProvider>);
 `},bundle:true,write:false,format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'}});
const writes=[],errors=[],checks=[];let browser;
const server=http.createServer((req,res)=>{
 if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(!['GET','HEAD'].includes(req.method)){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{writes.push({method:req.method,path:req.url,body:JSON.parse(body)});res.setHeader('content-type','application/json');res.end('{}');});return;}
 if(req.url.startsWith('/api/')){res.setHeader('content-type','application/json');return res.end(JSON.stringify({...data,isGit:false,entries:[],files:[],home:'/fixture'}));}
 res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900},isMobile:width===390,hasTouch:width===390});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin);const row=page.locator('[data-pi-enh-session-id="alpha"]');await row.waitFor();
  await page.waitForFunction(()=>typeof window.__PI_ENH_RERENDER_SESSIONS__==='function');
  // No enhancement script or hiding stylesheet exists during cold render/hover/touch.
  if(width===390)await row.tap();else await row.hover();
  assert.equal(await page.locator('.pi-enh-native-session-actions').count(),0);
  assert.equal(await row.locator('button[title*="Rename"],button[title*="重命名"],button[title*="Delete"],button[title*="删除"]').count(),0);
  await page.evaluate(source=>{
   const getSessionRowById=id=>document.querySelector('[data-pi-enh-session-id="'+id+'"]');
   window.fixture.rename=eval('('+source.trim()+')');
  },renameSource);
  const count=writes.length;
  assert(await page.evaluate(()=>window.fixture.rename('alpha')));await row.locator('input').waitFor();
  await row.locator('input').fill('未提交');
  assert(await page.evaluate(()=>window.fixture.rename('alpha')));
  assert.equal(await row.locator('input').inputValue(),'未提交');
  await page.keyboard.press('Escape');await row.locator('input').waitFor({state:'detached'});
  assert.equal(writes.length,count,'Escape and subsequent blur never persist');
  await page.evaluate(()=>window.fixture.rename('alpha'));await row.locator('input').waitFor();
  await page.keyboard.press('Enter');await row.locator('input').waitFor({state:'detached'});
  assert.equal(writes.length,count,'Untouched fallback title is not persisted');
  await page.evaluate(()=>window.fixture.rename('alpha'));await row.locator('input').fill('已修改');const entered=page.waitForResponse(r=>r.request().method()==='PATCH');await page.keyboard.press('Enter');await entered;
  await page.waitForFunction(()=>!document.querySelector('[data-pi-enh-session-id="alpha"] input'));
  assert.equal(writes.length,count+1,'Enter and blur submit exactly once');
  assert.deepEqual(writes.at(-1),{method:'PATCH',path:'/api/sessions/alpha',body:{name:'已修改'}});
  await page.evaluate(()=>window.fixture.rename('alpha'));await row.locator('input').fill('失焦提交');const blurred=page.waitForResponse(r=>r.request().method()==='PATCH');await page.locator('[data-pi-enh-session-id="beta"]').click();await blurred;
  await row.locator('input').waitFor({state:'detached'});assert.equal(writes.length,count+2);
  await page.evaluate(()=>{window.fixture.oldRow=document.querySelector('[data-pi-enh-session-id="alpha"]');window.fixture.hidden=true;window.__PI_ENH_RERENDER_SESSIONS__();});
  await row.waitFor({state:'detached'});
  assert(await page.evaluate(()=>window.fixture.oldRow.dispatchEvent(new CustomEvent('pi-web:session-row-rename',{cancelable:true}))),'Unmount removes listener');
  await page.evaluate(()=>{window.fixture.hidden=false;window.__PI_ENH_RERENDER_SESSIONS__();});await row.waitFor();
  assert(await page.evaluate(()=>window.fixture.rename('alpha')));await row.locator('input').waitFor();await page.keyboard.press('Escape');
  checks.push({width,coldRenderHasNoLegacyActions:true,withoutHidingCss:true,delayedDispatcher:true,cancelNoWrite:true,repeatPreservesDraft:true,enterSingleWrite:true,blurSingleWrite:true,unmountCleanup:true,remount:true});
  await page.close();
 }
 assert.deepEqual(errors,[]);const receipt={status:'passed',productionRequests:0,modelCalls:0,checks,errors,fixtureWrites:writes.length};
 if(process.env.PI_ACTIONS_RECEIPT)writeFileSync(process.env.PI_ACTIONS_RECEIPT,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
