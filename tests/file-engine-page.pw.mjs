// Full built Next page; private authentication and all API boundaries intercepted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url),{chromium}=require('playwright');
const output=path.resolve(root,'../acceptance'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'pi-file-context-'));
const origin='http://127.0.0.1:31365',password=crypto.randomUUID(),cwd='/isolated/shared-repo';
const cases=[],pageErrors=[],requests=[],blocked=[];let browser,child,log='';
fs.mkdirSync(output,{recursive:true});
try{
 assert(fs.existsSync(root+'/.next/BUILD_ID'));
 await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(31365,'127.0.0.1',()=>s.close(resolve));});
 child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','31365'],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:scratch,PI_AGENT_DIR:scratch,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 fs.writeFileSync(output+'/FILE_PAGE_PROCESS.json',JSON.stringify({pid:child.pid,startTicks:fs.readFileSync('/proc/'+child.pid+'/stat','utf8').split(' ')[21],port:31365}));
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/login')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready,'Private Next fixture must be ready');
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const engine of ['codex','pi'])for(const width of [1280,390]){
  const defaultEngine=engine==='codex'?'pi':'codex';
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,locale:'zh-CN',serviceWorkers:'block'});
  const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex'),sig=crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex');
  await context.addCookies([{name:'pi_web_session',value:token+'.'+sig,url:origin}]);
  await context.addInitScript(()=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme','dark');localStorage.setItem('pi-enh-plugin-at-mention-plugins','false');});
  await context.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname,json=(data,status=200)=>route.fulfill({status,json:data});
   if(u.origin!==origin)return route.abort('blockedbyclient');
   if(!p.startsWith('/api/')){if(/^\/pi-.*manifest\.json$/.test(p))return json([]);if(p==='/pi-usage-ledger.json')return json({});return route.continue();}
   if(!['GET','HEAD'].includes(req.method())&&!['/api/cwd/validate','/api/execution-engines/check'].includes(p)){blocked.push({path:p,method:req.method()});return json({error:'No mutation or prompt permitted'},403);}
   if(p.startsWith('/api/files/')||p.startsWith('/api/git/')||p==='/api/file-index'){
    const e=u.searchParams.get('engine');requests.push({engine,width,endpoint:p,query:Object.fromEntries(u.searchParams)});
    if(e!==engine)return json({error:'Missing or wrong explicit engine'},403);
    if(p.startsWith('/api/files/')){
     if(u.searchParams.get('type')==='list')return json({entries:['shared.md','notes.txt','third.txt'].map(name=>({name,isDir:false,size:40})),path:cwd});
     return json({content:'# '+engine.toUpperCase()+' whole-page fixture',language:'markdown',size:40,truncated:false});
    }
    if(p==='/api/git/status')return json({isGitRepository:false,files:[],additions:0,deletions:0});
    if(p==='/api/git/diff')return json({supported:false});
    return u.searchParams.has('q') ? json({matches:[{path:'shared.md',isDir:false}]}) : json({files:['preloaded.txt'],truncated:true});
   }
   if(p==='/api/execution-engines')return json({defaultEngine,codex:{enabled:true,url:origin+'/native'}});
   if(p==='/api/execution-engines/check')return json({connected:true,projects:[{cwd}]});
   if(p==='/api/cwd/validate')return json({valid:true,cwd,exists:true});
   if(p==='/api/sessions')return json({sessions:[]});
   if(p==='/api/agent/running')return json({runningSessionIds:[],completionNotificationSuppressedSessionIds:[],sessionListVersion:1});
   if(p==='/api/models')return json({models:{'openai:gpt-6.1-sol':'GPT-6.1 Sol'},modelList:[{id:'gpt-6.1-sol',provider:'openai',name:'GPT-6.1 Sol'}],defaultModel:{provider:'openai',modelId:'gpt-6.1-sol',id:'gpt-6.1-sol'}});
   if(p==='/api/worktrees')return json({isGit:false,projectRoot:cwd,currentWorktreePath:cwd,worktrees:[]});
   if(p==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
   return json({success:true,data:{},skills:[],tools:[],models:[],sessions:[],projects:[]});
  });
  const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(origin+'/?engine='+engine+'&cwd='+encodeURIComponent(cwd),{waitUntil:'domcontentloaded'});
  await page.locator('textarea').last().waitFor();
  assert(!new URL(page.url()).searchParams.has('session'),'The whole-page reproduction must stay sessionless');
  assert.equal(await page.evaluate(()=>Boolean(window.__PI_ENH_DISABLE_NATIVE_AT_FILES__)),false,'Native autocomplete is selected through its real registered preference');
  const textarea=page.locator('textarea').last();
  const indexRequest=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/file-index');
  await textarea.fill('@sha');const indexUrl=new URL((await indexRequest).url());
  assert.equal(indexUrl.searchParams.get('engine'),engine,'Native @ index must carry the current execution engine');
  await page.getByRole('button',{name:'shared.md',exact:true}).click();
  assert((await textarea.inputValue()).includes('@shared.md'),'Real completion button must insert the remote result');await textarea.fill('');
  // Finish composer interaction before opening the mobile navigation drawer.
  const show=page.getByRole('button',{name:/^(显示侧边栏|Show sidebar)$/});
  if(width===390)await show.waitFor({state:'visible'});
  if(await show.isVisible())await show.click();
  await page.getByText('shared.md',{exact:true}).first().waitFor();
  await page.screenshot({path:output+`/file-page-${engine}-${width}-tree.png`,animations:'disabled'});
  await page.getByText('shared.md',{exact:true}).first().click();
  const viewer=page.locator('.file-viewer-shell');await viewer.getByText(engine.toUpperCase()+' whole-page fixture',{exact:false}).waitFor();
  const href=await viewer.locator('a[download]').getAttribute('href');assert.equal(new URL(href,origin).searchParams.get('engine'),engine);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const screenshot=output+`/file-page-${engine}-${width}-viewer.png`;await page.screenshot({path:screenshot,animations:'disabled'});
  cases.push({engine,defaultEngine,width,sessionless:true,listAndViewerPassed:true,screenshot});await context.close();
 }
 assert.deepEqual(pageErrors,[]);assert.deepEqual(blocked,[]);
 for(const c of cases){assert(requests.some(r=>r.engine===c.engine&&r.width===c.width&&r.query.type==='list'));assert(requests.some(r=>r.engine===c.engine&&r.width===c.width&&r.query.type==='read'));}
 const result={status:'passed',cases,pageErrors,blocked,requests,modelCalls:0,productionWrites:0};fs.writeFileSync(output+'/FILE_PAGE_BROWSER.json',JSON.stringify(result,null,2));console.log(JSON.stringify({status:'passed',cases,pageErrors,modelCalls:0,productionWrites:0}));
}catch(error){
 if(browser){const p=browser.contexts().flatMap(c=>c.pages()).at(-1);if(p){await p.screenshot({path:output+'/file-page-failure.png'});fs.writeFileSync(output+'/FILE_PAGE_FAILURE.json',JSON.stringify({error:error.message,text:await p.locator('body').innerText(),requests,pageErrors,blocked},null,2));}}throw error;
}finally{
 if(browser)await browser.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
 fs.writeFileSync(output+'/file-page-next.log',log);fs.rmSync(scratch,{recursive:true,force:true});
}
