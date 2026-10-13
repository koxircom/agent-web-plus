// Real native shortcut + Settings panel; all requests isolated, no user configuration writes.
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const load=createRequire(import.meta.url),esbuild=load('esbuild'),{chromium}=load(process.env.COMPOSER_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const bundle=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';
 import{SettingsShortcuts,resolveSettingsShortcutFocus}from'./components/SettingsShortcuts';
 import{SettingsPanel}from'./components/SettingsPanel';import{settingsExtensionRegistry as registry}from'./lib/settings-extensions';
 import{I18nProvider}from'./hooks/useI18n';
 function App(){const[section,setSection]=React.useState(null),host=React.useRef(null);
  window.fixture={setShortcuts:rows=>registry.setSidebarShortcuts(rows),open:()=>setSection('general'),noOpSync:()=>registry.setSidebarShortcuts(registry.getSidebarShortcuts())};
  return <><div className="chat-composer-card"><textarea aria-label="Composer"/></div><div ref={host} data-pi-enh-shortcuts-host="true" style={{display:'flex',width:'100%'}}><SettingsShortcuts cwd="/fixture" onOpen={setSection}/></div>
   {section&&<SettingsPanel cwd="/fixture" sessionId={null} initialSection={section} onClose={()=>setSection(null)} onSessionReloaded={()=>{}} quoteSelectionEnabled={false} onQuoteSelectionChange={()=>{}} resolveReturnFocus={opener=>resolveSettingsShortcutFocus(host.current,opener)}/>}
  </>;
 }
 createRoot(document.getElementById('root')).render(<React.StrictMode><I18nProvider><App/></I18nProvider></React.StrictMode>);
 `},bundle:true,write:false,format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"development"'}});
const cssDir=root+'/.next/static/css';const css=fs.readdirSync(cssDir).filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(cssDir+'/'+f,'utf8')).join('\n');assert(css.length>1000);
let browser;const requests=[],errors=[];
const server=http.createServer((req,res)=>{
 requests.push({method:req.method,path:req.url});
 if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(req.url==='/style.css'){res.setHeader('content-type','text/css');return res.end(css);}
 if(req.url.startsWith('/api/')){res.setHeader('content-type','application/json');return res.end(JSON.stringify({success:true,models:{},modelList:[],tools:[],skills:[],providers:[],config:{}}));}
 res.setHeader('content-type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});const checks=[];
 for(const coarse of [false,true]){
  const context=await browser.newContext({viewport:{width:coarse?390:1280,height:900},hasTouch:coarse});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin);const settings=page.locator('[data-shortcut-id="general"]');await settings.waitFor();
  // Open before asynchronous configuration arrives. Relabel + reorder + repeat sync.
  const initial=await settings.elementHandle();await settings.click();const panel=page.locator('.settings-dialog-backdrop');await panel.waitFor();
  assert(await panel.evaluate(e=>e.contains(document.activeElement)));
  await page.evaluate(()=>{window.fixture.setShortcuts([{id:'settings',label:'常规'},{id:'models',label:'模型'}]);for(let i=0;i<5;i++)window.fixture.noOpSync();});
  assert(await initial.evaluate(e=>e.isConnected),'late shortcut config must preserve the actual opener');
  await panel.evaluate(e=>e.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true,isComposing:true})));
  assert(await panel.isVisible());await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
  assert(await initial.evaluate(e=>e===document.activeElement),'late preferences retain opener focus');
  // A real removal while Settings is open returns to the remaining shortcut.
  await settings.click();await panel.waitFor();await page.evaluate(()=>window.fixture.setShortcuts([{id:'models',label:'模型'}]));
  await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
  assert(await page.locator('[data-shortcut-id="models"]').evaluate(e=>e===document.activeElement),'removed opener falls back to surviving toolbar');
  // Toggle off restores native controls without remounting surviving keys.
  await page.evaluate(()=>window.fixture.setShortcuts(null));await settings.waitFor();
  const editor=page.getByRole('textbox',{name:'Composer'});await editor.focus();await page.evaluate(()=>window.fixture.open());await panel.waitFor();
  assert(await panel.evaluate(e=>e.contains(document.activeElement)));
  assert.equal(await editor.isVisible(),false,'real modal CSS hides composer until removal');
  await page.keyboard.press('Escape');await panel.waitFor({state:'hidden'});
  assert.equal(await editor.evaluate(e=>e===document.activeElement),!coarse,'only desktop restores editor focus');
  checks.push({coarse,width:coarse?390:1280,latePreferenceIdentity:true,removedOpenerFallback:true,imeEscape:true,composerRestoration:true});await context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(r=>!['GET','HEAD'].includes(r.method)),[]);
 console.log(JSON.stringify({status:'passed',checks,pageErrors:errors,serverWrites:0},null,2));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
