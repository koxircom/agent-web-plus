import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {CollaborationStore} from '../lib/collaboration-store.ts';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=process.env.COLLAB_ACCEPTANCE_OUTPUT||path.resolve(root,'../acceptance');fs.mkdirSync(out,{recursive:true});
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'collaboration-browser-')),agent=path.join(scratch,'agent');fs.mkdirSync(agent);
const store=new CollaborationStore({agentDir:agent});const empty=store.readState();
await store.acquire({sessionId:'11111111-1111-4111-8111-111111111111',sessionName:'销售订单打印排版',ownerPid:process.pid,scope:'instance',resources:['source:order-report','deployment:test']});
await store.acquire({sessionId:'22222222-2222-4222-8222-222222222222',sessionName:'采购日期与币别调整',ownerPid:process.pid,scope:'instance',resources:['deployment:test'],reason:'等待前序表单与报表验收完成，避免中断共享测试环境',resumeTask:'取得环境后升级已验收候选，验证日期位置与其他信息页签'});
const populated=fs.readFileSync(store.stateFile,'utf8');
const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));const origin='http://127.0.0.1:'+port,password=crypto.randomUUID();
let server,browser,log='';const results=[],errors=[];let modelCalls=0;
try{
 server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:agent,PI_AGENT_DIR:agent,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});server.stdout.on('data',v=>log+=v);server.stderr.on('data',v=>log+=v);
 const deadline=Date.now()+45000;while(true){assert.equal(server.exitCode,null);const r=await fetch(origin+'/api/web-auth').catch(()=>null);if(r?.ok)break;assert(Date.now()<deadline,'isolated server readiness');await new Promise(r=>setTimeout(r,150));}
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const width of [1440,390]){
  fs.writeFileSync(store.stateFile,populated);const ctx=await browser.newContext({viewport:{width,height:1000},locale:'zh-CN',serviceWorkers:'block'});
  const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');await ctx.addCookies([{name:'pi_web_session',value:token+'.'+crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex'),url:origin}]);
  await ctx.addInitScript(()=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme','dark');});
  await ctx.route('**/*',route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==origin)return route.abort();if(u.pathname.startsWith('/api/agent/')&&req.method()==='POST'){modelCalls++;return route.abort();}return route.continue();});
  const page=await ctx.newPage();page.setDefaultTimeout(25000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin,{waitUntil:'domcontentloaded'});
  // The enhancement runtime is mounted by the native AppShell effect, so this
  // also proves hydration has attached the settings button's React handler.
  await page.waitForFunction(()=>Boolean(window.__PI_WEB_ENHANCEMENTS_LOADED__),{},{timeout:25000});
  const opener=page.locator('button[data-shortcut-id="general"]');
  const revealSidebar=page.getByRole('button',{name:'显示侧边栏',exact:true});
  if(await revealSidebar.isVisible())await revealSidebar.click();
  await opener.click();const dialog=page.getByRole('dialog');await dialog.waitFor();const tab=dialog.getByRole('button',{name:'协作接力',exact:true});await tab.click();const panel=dialog.locator('.settings-section-host[data-section-id="collaboration"]');await panel.getByRole('feed').waitFor();await panel.getByText('采购日期与币别调整',{exact:true}).waitFor();
  const payload=await (await ctx.request.get(origin+'/api/collaboration')).json();assert.equal(payload.resources.length,2);assert(!JSON.stringify(payload).includes('11111111-1111'));assert(!JSON.stringify(payload).includes('"token"'));
  if(width===390){
   await dialog.getByRole('button',{name:'展开标签栏',exact:true}).waitFor();
   await page.waitForFunction(()=>document.querySelector('.settings-collaboration-card')?.getBoundingClientRect().width>=230);
   await page.setViewportSize({width:1440,height:1000});
   await page.waitForFunction(()=>!document.querySelector('.settings-dialog-surface')?.classList.contains('is-collapsed'));
   await page.setViewportSize({width:390,height:1000});
   await page.waitForFunction(()=>document.querySelector('.settings-dialog-surface')?.classList.contains('is-collapsed'));
  }
  const boxes=await panel.locator('.settings-collaboration-card').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,bottom:r.bottom,width:r.width,right:r.right}}));for(let i=1;i<boxes.length;i++)assert(boxes[i].y>=boxes[i-1].bottom,'resource cards overlap');assert(boxes.every(r=>r.right<=width+1));
  await panel.locator('.settings-collaboration-card').first().scrollIntoViewIfNeeded();await page.screenshot({path:path.join(out,`collaboration-${width}.png`),animations:'disabled'});
  await dialog.getByRole('button',{name:'常规',exact:true}).click();await panel.waitFor({state:'hidden'});const hidden=await panel.evaluate(n=>({display:getComputedStyle(n).display,hidden:n.hidden,offset:n.offsetParent===null}));assert.equal(hidden.display,'none');assert(hidden.hidden&&hidden.offset);
  await tab.click();await panel.getByRole('feed').waitFor();
  fs.writeFileSync(store.stateFile,'{invalid');await panel.getByRole('button',{name:'刷新状态',exact:true}).click();await panel.getByRole('alert').waitFor();assert.equal(await panel.getByRole('feed').count(),0);assert.equal(await panel.getByText('空闲就绪',{exact:true}).count(),0);
  fs.writeFileSync(store.stateFile,JSON.stringify(empty));await panel.getByRole('button',{name:'重试加载',exact:true}).click();await panel.getByText('暂无已登记的资源占用',{exact:true}).waitFor();assert.equal(await panel.getByRole('alert').count(),0);
  results.push({width,realApi:true,queue:true,tabCycle:true,hidden,errorAndEmptyIsolated:true,boxes});await ctx.close();
 }
 assert.deepEqual(errors,[]);assert.equal(modelCalls,0);fs.writeFileSync(path.join(out,'COLLABORATION_BROWSER.json'),JSON.stringify({status:'passed',buildId:fs.readFileSync(path.join(root,'.next/BUILD_ID'),'utf8').trim(),results,errors,productionWrites:0,modelCalls},null,2));console.log(JSON.stringify({status:'passed',cases:results.length,modelCalls}));
}catch(e){const page=browser?.contexts().flatMap(c=>c.pages()).at(-1);if(page){await page.screenshot({path:path.join(out,'collaboration-failure.png')});fs.writeFileSync(path.join(out,'collaboration-failure.txt'),await page.locator('body').innerText());fs.writeFileSync(path.join(out,'collaboration-errors.json'),JSON.stringify({errors,buttons:await page.getByRole('button').evaluateAll(ns=>ns.map(n=>({text:n.innerText,label:n.getAttribute('aria-label'),title:n.title})))},null,2));}throw e;
}finally{await browser?.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r));}fs.writeFileSync(path.join(out,'collaboration-next.log'),log);fs.rmSync(scratch,{recursive:true,force:true});}
