// Actual FileViewer with synthetic files/git; no model or production requests.
import http from 'node:http';import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),{build}=require('esbuild'),{chromium}=require('playwright'),root=fileURLToPath(new URL('..',import.meta.url));
const text='# Preview fixture\n\nMarkdown source content.\n',part='# Large fixture\n',tail='Remaining source content.\n';
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';import{FileViewer}from'./components/FileViewer';import{I18nProvider}from'./hooks/useI18n';
 window.fixture={enabled:true,clipboard:[]};window.__PI_ENH_IS_PLUGIN_ENABLED__=()=>window.fixture.enabled;
 Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>window.fixture.clipboard.push(text)}});
 function App(){const[path,setPath]=React.useState('/fixture/readme.md');window.fixture.setPath=setPath;return <div style={{height:800}}><FileViewer filePath={path} cwd="/fixture" watchEnabled={false} initialDisplayMode="source"/></div>;}
 createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
 `},bundle:true,write:false,format:'iife',outdir:'/fixture',loader:{'.css':'empty'},alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'}});
const requests=[],errors=[],checks=[];let browser;
const server=http.createServer((req,res)=>{
 requests.push({method:req.method,path:req.url});
 if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles.find(f=>f.path.endsWith('.js')).text);}
 const u=new URL(req.url,'http://fixture');
 if(u.pathname.startsWith('/api/')){
  res.setHeader('content-type','application/json');
  if(u.pathname==='/api/git/diff')return res.end(JSON.stringify({supported:true,status:'modified',patch:'diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-before\n+after\n'}));
  const large=u.pathname.includes('large.md'),offset=Number(u.searchParams.get('offset')||0),content=large?(offset?tail:part):text;
  return res.end(JSON.stringify({content,language:'markdown',size:large?part.length+tail.length:text.length,nextOffset:large?(offset?part.length+tail.length:part.length):text.length,truncated:large&&!offset}));
 }
 res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin);const modes=page.locator('.file-viewer-mode-switch');await modes.getByRole('button',{name:'Diff',exact:true}).waitFor();
  assert.equal(await modes.count(),1);assert.equal(await page.locator('.pi-enh-md-mode-switch').count(),0);
  assert.deepEqual(await modes.locator('button').allTextContents(),['Source','Preview','Diff']);
  await modes.getByRole('button',{name:'Preview',exact:true}).click();await page.getByRole('heading',{name:'Preview fixture'}).waitFor();
  await modes.getByRole('button',{name:'Diff',exact:true}).click();assert.equal(await modes.getByRole('button',{name:'Diff',exact:true}).getAttribute('aria-pressed'),'true');
  await modes.getByRole('button',{name:'Source',exact:true}).click();
  const copy=page.locator('.file-viewer-actions button[aria-label*="复制"], .file-viewer-actions button[aria-label="Copied"]');await copy.click();await page.waitForFunction(()=>window.fixture.clipboard.length===1);assert.equal(await page.evaluate(()=>window.fixture.clipboard[0]),text);
  await page.evaluate(()=>{window.fixture.enabled=false;window.dispatchEvent(new CustomEvent('pi:obsidian-markdown-viewer-preferences-change',{detail:{enabled:false}}));});await copy.waitFor({state:'hidden'});
  assert.equal(await modes.getByRole('button',{name:'Diff',exact:true}).count(),1);
  await page.evaluate(()=>{window.fixture.enabled=true;window.dispatchEvent(new CustomEvent('pi:obsidian-markdown-viewer-preferences-change',{detail:{enabled:true}}));});await copy.waitFor();
  await page.evaluate(()=>window.fixture.setPath('/fixture/large.md'));await page.waitForFunction(()=>document.querySelector('.file-viewer-path')?.textContent==='large.md');
  await copy.click();await page.waitForFunction(()=>window.fixture.clipboard.length===2);assert.equal(await page.evaluate(()=>window.fixture.clipboard[1]),part+tail);
  checks.push({width,singleNativeModes:true,source:true,preview:true,diffPreserved:true,pluginToggle:true,copyFullSource:true,copyChunkedSource:true,noHidingCss:true});await page.close();
 }
 assert.deepEqual(errors,[]);assert(requests.every(r=>r.method==='GET'));const receipt={status:'passed',productionRequests:0,modelCalls:0,checks,errors};if(process.env.PI_FILE_MODE_RECEIPT)writeFileSync(process.env.PI_FILE_MODE_RECEIPT,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
