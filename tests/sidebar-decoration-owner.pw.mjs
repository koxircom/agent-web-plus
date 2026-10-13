// Exercise the real sidebar bridge without changing user data or opening an agent.
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const load=createRequire(import.meta.url),esbuild=load('esbuild'),{chromium}=load(process.env.COMPOSER_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const sessions=['alpha','beta'].map(id=>({id,path:'/fixture/'+id+'.jsonl',cwd:'/fixture',name:id,created:'2026-10-10T12:00:00Z',modified:'2026-10-10T12:00:00Z',messageCount:1,firstMessage:id}));
const data={sessions,sessionListVersion:1,runningSessionIds:[],completionNotificationSuppressedSessionIds:[]};
const bundle=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';
 import{SessionSidebar}from'./components/SessionSidebar';import{I18nProvider}from'./hooks/useI18n';
 const bootstrap=${JSON.stringify({...data,renderedAt:Date.now()})};
 window.fixture={catalogCalls:0,tags:[],hidden:false};
 window.__PI_ENH_GET_SESSION_TAGS__=id=>id==='alpha'?window.fixture.tags:[];
 window.__PI_ENH_PROCESS_SESSION_GROUPS__=groups=>window.fixture.hidden?groups.filter(g=>g.root.id!=='beta'):groups;
 function App(){const[catalog,setCatalog]=React.useState([]);const change=React.useCallback(rows=>{window.fixture.catalogCalls++;setCatalog(rows);},[]);
  return <><output>{catalog.length}</output><div style={{height:800,width:360,display:'flex'}}><SessionSidebar bootstrap={bootstrap} initialSessionId="alpha" onSelectSession={()=>{}} onNewSession={()=>{}} onSessionsChange={change}/></div></>;
 }
 createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
 `},bundle:true,write:false,format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"production"'}});
const requests=[],errors=[];let browser;
const server=http.createServer((req,res)=>{
 requests.push({method:req.method,path:req.url});
 if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(req.url.startsWith('/api/')){res.setHeader('content-type','application/json');return res.end(JSON.stringify({...data,isGit:false,entries:[],files:[],home:'/fixture'}));}
 res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
 await page.goto(origin);await page.waitForFunction(()=>window.fixture.catalogCalls>=2&&typeof window.__PI_ENH_RERENDER_SESSIONS__==='function');
 const before=await page.evaluate(()=>window.fixture.catalogCalls);
 const alpha=page.locator('[data-pi-enh-session-id="alpha"]'),beta=page.locator('[data-pi-enh-session-id="beta"]');
 await alpha.waitFor();await beta.waitFor();const initialHeight=await alpha.evaluate(e=>e.style.height);
 await page.evaluate(()=>{window.fixture.tags=[{id:'done',name:'标签更新验收',color:'#34d399'}];window.fixture.hidden=true;window.__PI_ENH_RERENDER_SESSIONS__();});
 await alpha.getByText('标签更新验收').waitFor();await beta.waitFor({state:'hidden'});
 assert.notEqual(await alpha.evaluate(e=>e.style.height),initialHeight,'tag changes update row geometry');
 assert.equal(await page.evaluate(()=>window.fixture.catalogCalls),before,'decoration updates must not publish a changed session catalogue');
 await page.evaluate(()=>{window.fixture.tags=[];window.fixture.hidden=false;for(let i=0;i<20;i++)window.__PI_ENH_RERENDER_SESSIONS__();});
 await beta.waitFor();await alpha.getByText('标签更新验收').waitFor({state:'hidden'});
 assert.equal(await alpha.evaluate(e=>e.style.height),initialHeight);
 assert.equal(await page.evaluate(()=>window.fixture.catalogCalls),before,'repeated decoration sync stays inside sidebar');
 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(r=>!['GET','HEAD'].includes(r.method)),[]);
 console.log(JSON.stringify({status:'passed',catalogCalls:before,decorationUpdates:21,tagUpdate:true,filterUpdate:true,rowHeightRestored:true,serverWrites:0}));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
