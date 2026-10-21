// Real native components; all writes are confined to this in-process HTTP fixture.
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.FILE_CONTEXT_EVIDENCE_DIR || fileURLToPath(new URL('../../acceptance', import.meta.url));
mkdirSync(evidence, { recursive: true });
const bundle = await build({stdin:{resolveDir:root,loader:'tsx',contents:`
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FileExplorer} from './components/FileExplorer';
import {FileViewer} from './components/FileViewer';
import {I18nProvider} from './hooks/useI18n';
import {openFileTab} from './components/file-tab-state';
function App(){
 const [engine,setEngine]=useState('pi'),[tabs,setTabs]=useState([]),[active,setActive]=useState(null);
 const cwd='/workspace/shared-repo', tab=tabs.find(t=>t.id===active);
 const open=(p,n,o={})=>{const e=o.executionEngine??engine,id='file:'+e+':'+p;
  setTabs(prev=>openFileTab(prev,{tabId:id,filePath:p,fileName:n,executionEngine:e,cwd:o.cwd??cwd,sourceSessionId:o.sourceSessionId}));setActive(id);};
 return <main><section><nav><button id='pi' onClick={()=>setEngine('pi')}>Pi</button><button id='codex' onClick={()=>setEngine('codex')}>Codex</button><b>{engine}</b></nav>
 <div id='explorer'><FileExplorer cwd={cwd} executionEngine={engine} onOpenFile={open} changesCollapsed={false}/></div></section>
 <section id='viewer'><nav>{tabs.map(t=><button key={t.id} data-tab-engine={t.executionEngine} onClick={()=>setActive(t.id)}>{t.label} ({t.executionEngine})</button>)}</nav>
 <div id='file-body'>{tab&&<FileViewer key={tab.id+':'+(tab.viewerRevision??0)} filePath={tab.filePath} cwd={tab.cwd} sourceSessionId={tab.sourceSessionId} executionEngine={tab.executionEngine} watchEnabled={false}
 onOpenFile={(p,page)=>open(p,p.split('/').pop(),{executionEngine:tab.executionEngine,cwd:tab.cwd,sourceSessionId:tab.sourceSessionId,page})}/>}</div></section></main>;}
createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
`},bundle:true,write:false,format:'iife',loader:{'.css':'empty'},alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'}});
const requests=[], heldLists=[], heldChecks=[];
let holdPiList=false,holdPiCheck=false;
const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
const entries=names=>names.map(name=>({name,isDir:name==='shared-dir',size:100,modified:'2026-10-20T00:00:00Z'}));
const server=http.createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1'),q=Object.fromEntries(u.searchParams),engine=q.engine;
 requests.push({method:req.method,endpoint:u.pathname,...q});
 if(u.pathname==='/bundle.js'){res.writeHead(200,{'Content-Type':'application/javascript'});return res.end(bundle.outputFiles[0].text);}
 if(u.pathname.startsWith('/api/')){
  if(!['pi','codex'].includes(engine))return json(res,{error:'Explicit engine required'},400);
  if(u.pathname.startsWith('/api/files/')){
   const p='/'+decodeURIComponent(u.pathname.slice('/api/files/'.length)).replace(/^\/+/,''),type=q.type;
   if(type==='list'){
    if(p.endsWith('/shared-dir')){
     const send=()=>json(res,{entries:entries([engine+'-child.txt']),path:p});
     if(engine==='pi'&&holdPiList){holdPiList=false;heldLists.push(send);return;}return send();
    }
    return json(res,{entries:entries(['shared-dir','shared.md','notes.txt','third.txt']),path:p});
   }
   if(type==='upload-check'){
    const send=()=>json(res,{conflicts:[],nonReplaceable:[]});
    if(engine==='pi'&&holdPiCheck){holdPiCheck=false;heldChecks.push(send);return;}return send();
   }
   if(type==='upload'){req.resume();return req.on('end',()=>json(res,{uploaded:['fixture.txt'],skipped:[],errors:[]}));}
   if(type==='download'){res.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="shared.md"'});return res.end(engine+' fixture');}
   if(type==='read'||type==='preview'){
    const content='# '+engine.toUpperCase()+' fixture\n\nSame path, different backend.\n\n[Notes](./notes.txt)';
    return json(res,{content,language:'markdown',size:content.length,truncated:false});
   }
   if(type==='meta')return json(res,{size:100});
  }
  if(u.pathname==='/api/git/status')return json(res,{isGitRepository:true,files:[],additions:0,deletions:0});
  if(u.pathname==='/api/git/diff')return json(res,{supported:true,status:'modified',patch:'diff --git a/shared.md b/shared.md\n--- a/shared.md\n+++ b/shared.md\n@@ -1 +1 @@\n-old\n+'+engine+' diff\n'});
  if(u.pathname==='/api/file-index')return json(res,{matches:[{path:'shared.md',isDir:false}]});
  return json(res,{error:'Unknown fixture endpoint'},404);
 }
 res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
 :root{--bg:#16191d;--bg-panel:#1d2228;--bg-hover:#282e36;--bg-selected:#303944;--text:#e8edf2;--text-muted:#a9b5c1;--text-dim:#8493a1;--border:#38434f;--accent:#69b4ff;--font-mono:monospace;color:var(--text);background:var(--bg);font:14px sans-serif}*{box-sizing:border-box}body{margin:0}main{height:100dvh;display:grid;grid-template-columns:300px minmax(0,1fr)}section{min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border)}nav{padding:8px;display:flex;gap:8px;flex-wrap:wrap}button{color:var(--text);background:var(--bg-selected);border:1px solid var(--border);padding:5px 9px;cursor:pointer}#explorer,#file-body{flex:1;min-height:0;overflow:auto}@media(max-width:600px){main{grid-template-columns:1fr;grid-template-rows:45% 55%}}.file-viewer-toolbar,.file-viewer-controls,.file-viewer-actions,.file-viewer-mode-switch{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.file-viewer-path{overflow:hidden;text-overflow:ellipsis}.file-viewer-controls{margin-left:auto}.file-viewer-shell{min-width:0}.file-viewer-toolbar{max-width:100%}a{color:var(--accent)}
 </style><div id="root"></div><script src="/bundle.js"></script></html>`);
});
let browser;
const checks=[],pageErrors=[];
try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900},acceptDownloads:true});
  page.setDefaultTimeout(12000);page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(origin);const explorer=page.locator('#explorer'),body=page.locator('#file-body');
  await explorer.getByText('shared.md',{exact:true}).waitFor();
  const boxes=[];
  for(const name of ['shared-dir','shared.md','notes.txt','third.txt'])boxes.push(await explorer.getByText(name,{exact:true}).evaluate(el=>{const r=(el.closest('div[title]')||el.parentElement).getBoundingClientRect();return {name:el.textContent,y:r.y,bottom:r.bottom};}));
  for(let i=1;i<boxes.length;i++)assert(boxes[i].y>=boxes[i-1].bottom,'Adjacent file rows must not overlap');
  holdPiList=true;
  await Promise.all([page.waitForRequest(r=>r.url().includes('shared-dir')&&r.url().includes('type=list')),explorer.getByText('shared-dir',{exact:true}).click()]);
  assert.equal(heldLists.length,1,'The stale request must actually be in flight');
  await page.locator('#codex').click();await explorer.getByText('shared.md',{exact:true}).waitFor();
  await explorer.getByText('shared-dir',{exact:true}).click();await explorer.getByText('codex-child.txt',{exact:true}).waitFor();
  const late=page.waitForResponse(r=>r.url().includes('shared-dir')&&new URL(r.url()).searchParams.get('engine')==='pi');heldLists.shift()();await(await late).finished();
  await page.waitForLoadState('networkidle');assert.equal(await explorer.getByText('pi-child.txt',{exact:true}).count(),0);
  await explorer.getByText('shared.md',{exact:true}).click();await body.getByText('CODEX fixture',{exact:false}).waitFor();
  await page.locator('#pi').click();await explorer.getByText('shared.md',{exact:true}).waitFor();
  // The open Codex viewer keeps its source despite the explorer now being Pi.
  await body.getByText('CODEX fixture',{exact:false}).waitFor();
  const diff=body.getByRole('button',{name:'Diff',exact:true});await diff.waitFor();await diff.click();
  assert.equal(await diff.getAttribute('aria-pressed'),'true');
  const download=body.locator('a[download]');assert.equal(await download.count(),1);
  assert.equal(new URL(await download.getAttribute('href'),origin).searchParams.get('engine'),'codex');
  const [dl]=await Promise.all([page.waitForEvent('download'),download.click()]);assert.equal(await dl.failure(),null);
  await explorer.getByText('shared.md',{exact:true}).click();await body.getByText('PI fixture',{exact:false}).waitFor();
  assert.equal(await page.locator('[data-tab-engine="pi"]').count(),1);assert.equal(await page.locator('[data-tab-engine="codex"]').count(),1);
  await page.locator('[data-tab-engine="codex"]').click();await body.getByRole('button',{name:'Preview',exact:true}).click();
  await body.getByRole('heading',{name:'CODEX fixture',exact:true}).waitFor();
  await body.getByRole('link',{name:'Notes',exact:true}).click();await body.getByText('CODEX fixture',{exact:false}).waitFor();
  assert.equal(await page.locator('[data-tab-engine="codex"]').count(),2,'Markdown links retain the original backend');
  // An old successful upload check must not resume after Pi -> Codex -> Pi (ABA).
  const beforeUpload=requests.filter(r=>r.type==='upload').length;holdPiCheck=true;
  await Promise.all([page.waitForRequest(r=>r.url().includes('type=upload-check')),explorer.locator('input[type=file]').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')})]);
  assert.equal(heldChecks.length,1);
  await page.locator('#codex').click();await explorer.getByText('shared.md',{exact:true}).waitFor();
  await page.locator('#pi').click();await explorer.getByText('shared.md',{exact:true}).waitFor();
  const checkResponse=page.waitForResponse(r=>r.url().includes('type=upload-check'));heldChecks.shift()();await(await checkResponse).finished();await page.waitForLoadState('networkidle');
  assert.equal(requests.filter(r=>r.type==='upload').length,beforeUpload,'Obsolete upload admission cannot resume on a later same-engine scope');
  // A current-scope upload still uses the real check + XHR boundary, fixture only.
  await Promise.all([page.waitForResponse(r=>r.url().includes('type=upload')&&!r.url().includes('upload-check')),explorer.locator('input[type=file]').setInputFiles({name:'fixture.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')})]);
  assert.equal(requests.filter(r=>r.type==='upload').at(-1).engine,'pi');
  const screenshot=evidence+'/file-context-'+width+'.png';await page.screenshot({path:screenshot,fullPage:true});
  checks.push({width,screenshot,samePathTabsIsolated:true,lateSubtreeRejected:true,uploadABARejected:true,currentUploadPassed:true,boxes});await page.close();
 }
 assert.deepEqual(pageErrors,[]);
 for(const r of requests.filter(r=>r.endpoint.startsWith('/api/')))assert(['pi','codex'].includes(r.engine),'All fixture file API calls carry an engine');
 assert(requests.some(r=>r.type==='download'&&r.engine==='codex'));assert(requests.some(r=>r.endpoint==='/api/git/diff'&&r.engine==='codex'));
 const receipt={status:'passed',checks,pageErrors,productionWrites:0,modelCalls:0,requests};
 writeFileSync(evidence+'/FILE_CONTEXT_BROWSER.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({status:'passed',checks,pageErrors,productionWrites:0,modelCalls:0},null,2));
}catch(error){
 if(browser){const page=browser.contexts().flatMap(c=>c.pages()).at(-1);if(page){await page.screenshot({path:evidence+'/file-context-failure.png',fullPage:true});writeFileSync(evidence+'/FILE_CONTEXT_FAILURE.json',JSON.stringify({error:error.message,text:await page.locator('body').innerText(),requests,pageErrors},null,2));}}
 throw error;
}finally{
 for(const send of [...heldLists,...heldChecks])send();
 if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
