import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('..',import.meta.url));
const require=createRequire(import.meta.url),{chromium}=require('playwright');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'explorer-visibility-'));
const origin='http://127.0.0.1:31369',password=crypto.randomUUID(),cwd='/isolated/explorer';
const output=path.resolve(root,'../acceptance');
const cases=[],errors=[];
let browser,child,log='';
fs.mkdirSync(output,{recursive:true});
try {
  await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(31369,'127.0.0.1',()=>server.close(resolve));});
  child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','31369'],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:scratch,PI_AGENT_DIR:scratch,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/login')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready,'isolated server did not start');
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const engine of ['pi','codex'])for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,locale:'zh-CN',serviceWorkers:'block'});
    const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');
    const signature=crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex');
    await context.addCookies([{name:'pi_web_session',value:token+'.'+signature,url:origin}]);
    await context.addInitScript(()=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme','dark');});
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),p=url.pathname,json=data=>route.fulfill({json:data});
      if(url.origin!==origin)return route.abort('blockedbyclient');
      if(!p.startsWith('/api/')){if(/^\/pi-.*manifest\.json$/.test(p))return json([]);return route.continue();}
      if(!['GET','HEAD'].includes(request.method())&&!['/api/cwd/validate','/api/execution-engines/check'].includes(p))return route.fulfill({status:403,json:{error:'fixture is read-only'}});
      if(p==='/api/execution-engines')return json({defaultEngine:engine,codex:{enabled:true,url:origin+'/native'}});
      if(p==='/api/execution-engines/check')return json({connected:true,projects:[{cwd}]});
      if(p==='/api/cwd/validate')return json({valid:true,cwd,exists:true});
      if(p==='/api/sessions')return json({sessions:[]});
      if(p==='/api/agent/running')return json({runningSessionIds:[],completionNotificationSuppressedSessionIds:[],sessionListVersion:1});
      if(p==='/api/worktrees')return json({isGit:false,projectRoot:cwd,currentWorktreePath:cwd,worktrees:[]});
      if(p.startsWith('/api/files/'))return json({entries:[{name:'example.md',isDir:false,size:10}],path:cwd});
      if(p==='/api/git/status')return json({isGitRepository:false,files:[]});
      if(p==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
      return json({success:true,data:{},skills:[],tools:[],models:[],sessions:[],projects:[]});
    });
    const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
    const openSidebar=async()=>{const button=page.getByRole('button',{name:/^(显示侧边栏|Show sidebar)$/});if(await button.isVisible())await button.click();};
    const settings=async()=>{await openSidebar();await page.locator('[data-shortcut-id="general"]').click();const toggle=page.getByRole('switch',{name:'显示文件浏览器'});await toggle.waitFor();return toggle;};
    await page.goto(origin+'/?engine='+engine+'&cwd='+encodeURIComponent(cwd),{waitUntil:'domcontentloaded'});
    await page.locator('textarea').last().waitFor();await openSidebar();
    assert.equal(await page.getByRole('button',{name:'文件浏览器',exact:true}).count(),0);
    let toggle=await settings();assert.equal(await toggle.getAttribute('aria-checked'),'false');await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'),'true');
    await page.getByRole('button',{name:'关闭',exact:true}).first().click();await openSidebar();
    await page.getByRole('button',{name:'文件浏览器',exact:true}).waitFor();
    await page.getByText('example.md',{exact:true}).waitFor();
    await page.reload({waitUntil:'domcontentloaded'});await page.locator('textarea').last().waitFor();await openSidebar();
    await page.getByRole('button',{name:'文件浏览器',exact:true}).waitFor();
    toggle=await settings();assert.equal(await toggle.getAttribute('aria-checked'),'true');await toggle.click();
    await page.getByRole('button',{name:'关闭',exact:true}).first().click();await openSidebar();
    assert.equal(await page.getByRole('button',{name:'文件浏览器',exact:true}).count(),0);
    assert.equal(await page.locator('[data-resize-handle="sidebar-sections"]').count(),0);
    await page.reload({waitUntil:'domcontentloaded'});await page.locator('textarea').last().waitFor();await openSidebar();
    assert.equal(await page.getByRole('button',{name:'文件浏览器',exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:output+`/explorer-${engine}-${width}.png`,animations:'disabled'});
    cases.push({engine,width,defaultHidden:true,enable:true,enabledAfterReload:true,disable:true,disabledAfterReload:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',cases,errors}));
} finally {
  if(browser)await browser.close();
  if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}
  fs.rmSync(scratch,{recursive:true,force:true});
}
