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
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'enhancement-settings-'));
const output=path.resolve(root,'../acceptance'),origin='http://127.0.0.1:31370',password=crypto.randomUUID();
const errors=[],cases=[];let child,browser,log='';
fs.mkdirSync(output,{recursive:true});
try {
  await new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(31370,'127.0.0.1',()=>server.close(resolve));});
  child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','31370'],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:scratch,PI_AGENT_DIR:scratch,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/login')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready);
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,locale:'zh-CN',serviceWorkers:'block'});
    const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');
    await context.addCookies([{name:'pi_web_session',value:token+'.'+crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex'),url:origin}]);
    await context.addInitScript(()=>{
      localStorage.setItem('pi-locale','zh-CN');
      if(!localStorage.getItem('pi-test-seeded')){
        localStorage.setItem('pi-test-seeded','1');
        localStorage.setItem('pi-enh-settings-v1',JSON.stringify({schemaVersion:1,modules:{'task-insights':{enabled:false},'conversation-navigation':{enabled:false}},features:{'turn-number-indicator':{enabled:false},'live-stopwatch':{enabled:false},'task-tool-auto-collapse':{enabled:false},'subagent-dispatch-cards':{enabled:false},'quick-quote':{enabled:false},'session-attention-desktop':{enabled:false},'ask-user-batch-prototype':{enabled:true}},settings:{'minimap-full-nav':{initialTurns:12,stepTurns:7}}}));
      }
    });
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url()),p=url.pathname,json=data=>route.fulfill({json:data});
      if(url.origin!==origin)return route.abort('blockedbyclient');
      if(!p.startsWith('/api/')){if(/^\/pi-.*manifest\.json$/.test(p))return json([]);return route.continue();}
      if(!['GET','HEAD'].includes(request.method())&&!['/api/cwd/validate','/api/execution-engines/check'].includes(p))return route.fulfill({status:403,json:{error:'fixture is read-only'}});
      if(p==='/api/execution-engines')return json({defaultEngine:'pi',codex:{enabled:true,url:origin+'/native'}});
      if(p==='/api/execution-engines/check')return json({connected:true,projects:[{cwd:'/isolated'}]});
      if(p==='/api/cwd/validate')return json({valid:true,cwd:'/isolated',exists:true});
      if(p==='/api/sessions')return json({sessions:[]});
      if(p==='/api/agent/running')return json({runningSessionIds:[],completionNotificationSuppressedSessionIds:[],sessionListVersion:1});
      if(p==='/api/worktrees')return json({isGit:false,projectRoot:'/isolated',currentWorktreePath:'/isolated',worktrees:[]});
      if(p==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
      return json({success:true,data:{},skills:[],tools:[],models:[],sessions:[],projects:[]});
    });
    const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
    const openSettings=async()=>{
      const sidebar=page.getByRole('button',{name:/^(显示侧边栏|Show sidebar)$/});if(await sidebar.isVisible())await sidebar.click();
      await page.locator('[data-shortcut-id="general"]').click();
      const navigation=page.locator('.settings-section-tab').filter({hasText:'增强插件'});await navigation.click();
      await page.locator('.pi-enh-plugins-panel [data-module-row]').first().waitFor();
    };
    await page.goto(origin+'/?engine=pi&cwd=%2Fisolated',{waitUntil:'domcontentloaded'});await page.locator('textarea').last().waitFor();
    await openSettings();
    for(const id of ['turn-number-indicator','live-stopwatch','task-tool-auto-collapse','subagent-dispatch-cards']){
      assert.equal(await page.locator(`[data-plugin-toggle="${id}"]`).count(),0,id);
      assert.equal(await page.evaluate(id=>window.__PI_ENH_IS_PLUGIN_ENABLED__(id),id),true,id);
    }
    assert.equal(await page.locator('[data-module-row="task-insights"]').count(),0);
    assert.equal(await page.locator('[data-plugin-toggle="ask-user-batch-prototype"]').count(),0);
    assert.equal(await page.evaluate(()=>window.__PI_ENH_IS_PLUGIN_ENABLED__('ask-user-batch-prototype')),false);
    const conversation=page.locator('[data-module-row="conversation-navigation"]');
    await conversation.locator('summary').click();
    const initialTurns=conversation.locator('[data-plugin-setting="minimap-full-nav:initialTurns"]');
    assert.equal(await initialTurns.inputValue(),'12');assert.equal(await initialTurns.isDisabled(),false);
    const quote=page.locator('[data-module-row="selection-context"]');await quote.locator('summary').click();
    let toggle=quote.locator('[data-plugin-toggle="quick-quote"]');assert.equal(await toggle.getAttribute('aria-checked'),'false');
    await toggle.click();assert.equal(await toggle.getAttribute('aria-checked'),'true');
    await page.reload({waitUntil:'domcontentloaded'});await page.locator('textarea').last().waitFor();await openSettings();
    await page.locator('[data-module-row="selection-context"] summary').click();toggle=page.locator('[data-plugin-toggle="quick-quote"]');
    assert.equal(await toggle.getAttribute('aria-checked'),'true');await toggle.click();assert.equal(await toggle.getAttribute('aria-checked'),'false');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:output+`/settings-simplified-${width}.png`,animations:'disabled'});
    cases.push({width,hiddenCore:4,oldDisabledCoreStillActive:true,prototypeOff:true,personalTogglePersists:true,parametersPreserved:true});
    await context.close();
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',cases,errors}));
} finally {if(browser)await browser.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));}fs.rmSync(scratch,{recursive:true,force:true});}
