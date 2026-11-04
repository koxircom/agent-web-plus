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
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'learning-settings-'));
const output=path.resolve(root,'../acceptance'),origin='http://127.0.0.1:31371',password=crypto.randomUUID();
const errors=[],cases=[];let child,browser,log='';
fs.mkdirSync(output,{recursive:true});
try {
  await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(31371,'127.0.0.1',()=>server.close(resolve));});
  child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','31371'],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:scratch,PI_AGENT_DIR:scratch,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/login')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready);
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const [engine,width] of [['pi',1280],['pi',800],['pi',390],['codex',800],['codex',390]]){
    let enabled=false,learningRequests=[];
    const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,locale:'zh-CN',serviceWorkers:'block'});
    const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');
    await context.addCookies([{name:'pi_web_session',value:token+'.'+crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex'),url:origin}]);
    await context.addInitScript(()=>localStorage.setItem('pi-locale','zh-CN'));
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),p=url.pathname,json=data=>route.fulfill({json:data});
      if(url.origin!==origin)return route.abort('blockedbyclient');
      if(!p.startsWith('/api/')){if(/^\/pi-.*manifest\.json$/.test(p))return json([]);return route.continue();}
      if(p==='/api/learning'){
        learningRequests.push({method:request.method(),cwd:url.searchParams.get('cwd')});
        if(request.method()==='PUT'){enabled=request.postDataJSON().enabled;return json({enabled});}
        if(request.method()!=='GET')return route.fulfill({status:403,json:{error:'fixture write blocked'}});
        return json({enabled,project:url.searchParams.get('cwd'),lastReview:null,lessons:[]});
      }
      if(!['GET','HEAD'].includes(request.method())&&!['/api/cwd/validate','/api/execution-engines/check'].includes(p))return route.fulfill({status:403,json:{error:'fixture is read-only'}});
      if(p==='/api/execution-engines')return json({defaultEngine:engine,codex:{enabled:true,url:origin+'/native'}});
      if(p==='/api/execution-engines/check')return json({connected:true,projects:[{cwd:'/isolated'}]});
      if(p==='/api/cwd/validate')return json({valid:true,cwd:'/isolated',exists:true});
      if(p==='/api/sessions')return json({sessions:[]});
      if(p==='/api/project-trust')return json({trusted:true,requiresTrust:false});
      if(p==='/api/agent/running')return json({runningSessionIds:[],completionNotificationSuppressedSessionIds:[],sessionListVersion:1});
      if(p==='/api/worktrees')return json({isGit:false,projectRoot:'/isolated',currentWorktreePath:'/isolated',worktrees:[]});
      if(p==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
      return json({success:true,data:{},skills:[],tools:[],models:[],sessions:[],projects:[]});
    });
    const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/?engine='+engine+'&cwd=%2Fisolated',{waitUntil:'domcontentloaded'});await page.locator('textarea').last().waitFor();
    const sidebar=page.getByRole('button',{name:/^(显示侧边栏|Show sidebar)$/});if(await sidebar.isVisible())await sidebar.click();
    await page.locator('[data-shortcut-id="general"]').click();await page.locator('.settings-section-tab').filter({hasText:'自动复盘'}).click();
    const heading=page.getByRole('heading',{name:'自动复盘',exact:true});await heading.waitFor();
    const panel=heading.locator('xpath=../..');const toggle=page.getByRole('switch',{name:'启用自动复盘'});await toggle.waitFor();
    await page.getByText('已关闭',{exact:true}).waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'false');
    if(engine==='codex')await page.getByText('当前 Codex 会话暂不支持自动复盘；切换到 Pi Agent 项目可查看复盘记录。',{exact:true}).waitFor();
    else await page.getByText('暂无项目经验或技能候选。',{exact:true}).waitFor();
    const geometry=await page.evaluate(()=>{
      const host=document.querySelector('.settings-dialog-main').getBoundingClientRect();
      const h=[...document.querySelectorAll('h2')].find(x=>x.textContent==='自动复盘').getBoundingClientRect();
      return {inset:Math.round(h.left-host.left),right:Math.round(host.right-h.right),overflow:document.documentElement.scrollWidth>innerWidth};
    });
    assert(geometry.inset>=12&&geometry.inset<=34,JSON.stringify(geometry));assert.equal(geometry.overflow,false);
    if(engine==='pi'&&width===1280){await toggle.click();await page.getByText('已开启',{exact:true}).waitFor();assert.equal(enabled,true);await toggle.click();await page.getByText('已关闭',{exact:true}).waitFor();assert.equal(enabled,false);}
    await page.screenshot({path:output+`/learning-${engine}-${width}.png`,animations:'disabled'});
    cases.push({engine,width,geometry,toggleTested:engine==='pi'&&width===1280,learningRequests});
    await context.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',cases,errors}));
} finally {if(browser)await browser.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(scratch,{recursive:true,force:true});}
