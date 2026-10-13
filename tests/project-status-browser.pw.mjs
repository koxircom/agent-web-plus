// Actual compiled AppShell + Sidebar + enhancement model; owned files, no model calls.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const root=process.env.PI_STATUS_SOURCE_ROOT||fileURLToPath(new URL('..',import.meta.url)),load=createRequire(import.meta.url),{chromium}=load('playwright');
const baseline=process.env.PI_STATUS_BASELINE==='1',output=process.env.PI_STATUS_OUTPUT||'/tmp/pi-task-status-browser.json';
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'pi-status-fixture-')),agentDir=path.join(scratch,'agent'),work=path.join(scratch,'work'),odoo=path.join(scratch,'odoo');
fs.mkdirSync(path.join(agentDir,'sessions','fixture'),{recursive:true});fs.mkdirSync(work);fs.mkdirSync(odoo);
const ids=[1,2,3,4].map(n=>'00000000-0000-7000-8000-'+String(n).padStart(12,'0')),files=[];
ids.forEach((id,i)=>{const cwd=i===3?odoo:work,now=new Date().toISOString(),file=path.join(agentDir,'sessions','fixture',`${now.replace(/[:.]/g,'-')}_${id}.jsonl`);files.push(file);fs.writeFileSync(file,[
{type:'session',version:3,id,cwd,timestamp:now},
{type:'message',id:'u'+i,parentId:null,timestamp:now,message:{role:'user',content:[{type:'text',text:'Status fixture '+i}],timestamp:1}},
{type:'message',id:'a'+i,parentId:'u'+i,timestamp:now,message:{role:'assistant',content:[{type:'text',text:'Status fixture reply '+i}],model:'gpt-6.1-sol',provider:'openai',api:'openai-responses',stopReason:'stop',timestamp:2,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}},
{type:'session_info',id:'i'+i,parentId:'a'+i,timestamp:now,name:'Status fixture '+i}].map(x=>JSON.stringify(x)).join('\n')+'\n');});
const port=Number(process.env.PI_STATUS_PORT||31462),origin=`http://127.0.0.1:${port}`,password='isolated-status-fixture-password';let serverLog='',browser;
const server=spawn(process.execPath,[load.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_AGENT_DIR:agentDir,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>serverLog+=b);server.stderr.on('data',b=>serverLog+=b);
const result={baseline,checks:[],errors:[],productionRequests:0,modelCalls:0};
try{
 let ready=false;for(let n=0;n<80;n++){if(server.exitCode!==null)throw Error(serverLog);try{ready=(await fetch(origin+'/login')).ok}catch{}if(ready)break;await new Promise(r=>setTimeout(r,250))}assert(ready,'Isolated Next must start');
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const width of [1280,390]){
 const context=await browser.newContext({viewport:{width,height:900},serviceWorkers:'block',isMobile:width===390,hasTouch:width===390});const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');await context.addCookies([{name:'pi_web_session',value:token+'.'+crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex'),url:origin,httpOnly:true,sameSite:'Lax'}]);
 await context.addInitScript(({work,ids})=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme','dark');localStorage.setItem('pi-enh-project-status-v1',JSON.stringify({sessions:{ghost:{id:'ghost',projectKey:work,status:'running'},[ids[0]]:{id:ids[0],projectKey:work,status:'attention',pendingRequests:[{id:'old',method:'select'}]}}}));}, {work,ids});
 let revision=1,mode='ok',running=[ids[0],ids[1],ids[3]],executions=running.map(sessionId=>({sessionId,state:'running',runId:sessionId})),pending=[{sessionId:ids[1],pendingRequests:[{id:'question',method:'select'}]}],requests=0,heldReads=[];
 const snapshot=()=>({runningSessionIds:running,completionNotificationSuppressedSessionIds:[],sessionListVersion:-1,statusSnapshot:{version:1,epoch:'fixture',revision,executions},interactionState:{version:1,sessions:pending}});
 await context.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin!==origin)return route.fulfill({status:204});if(!['GET','HEAD'].includes(req.method()))return route.fulfill({status:403,json:{error:'read-only fixture'}});if(u.pathname.endsWith('/events'))return route.fulfill({status:204});if(u.pathname==='/api/agent/running'){requests++;if(mode==='hold')return new Promise(resolve=>heldReads.push(()=>{void route.fulfill({json:snapshot()}).catch(()=>{}).finally(resolve);}));if(mode==='offline')return route.fulfill({status:503,json:{error:'offline'}});if(mode==='timeout'){await new Promise(resolve=>setTimeout(resolve,8500));return route.fulfill({json:snapshot()}).catch(()=>{});}return route.fulfill({json:snapshot()});}return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));await page.goto(origin+'/?session='+ids[2],{waitUntil:'domcontentloaded'});await page.getByText('Status fixture reply 2',{exact:false}).waitFor({timeout:20000});await page.waitForFunction(()=>window.__PI_ENH_PROJECT_STATUS_MODEL__?.health().state==='live');
 await page.waitForTimeout(600);requests=0;await page.waitForTimeout(5300);const steadyRequests=requests;
 const refresh=()=>page.evaluate(()=>window.__PI_WEB_REFRESH_PROJECT_STATUS__?.()||window.__PI_ENH_REFRESH_PROJECT_INTERACTIONS__?.(true));
 const title=await page.title(),dots=await page.locator('[data-pi-enh-current-project] [data-pi-native-project-status-dot]').count();
 if(baseline){result.checks.push({width,title,dots,steadyWindowMs:5300,steadyRequests});await context.close();continue;}
 const faviconSvg=decodeURIComponent((await page.locator('link[data-pi-enh-attention-favicon]').getAttribute('href')).split(',',2)[1]);assert.match(faviconSvg,/>1<\/text>/);assert(faviconSvg.includes('#f59e0b'));
 assert.equal(title,'work 🔵1 🟡1');assert.equal(dots,1);assert.equal(await page.locator('[data-pi-enh-current-project] [data-pi-enh-project-status-created]').count(),0);
 assert.equal(await page.locator(`[data-pi-enh-session-id="${ids[1]}"]`).getAttribute('data-pi-enh-project-status'),'attention');
 assert.match(await page.locator('[data-pi-native-project-status-dot]').first().getAttribute('title'),/当前工作区：运行 1，待回复 1；其他工作区：运行 1/);
 result.checks.push({width,scenario:'running-and-waiting',title,dots,steadyWindowMs:5300,steadyRequests});
 if(width===1280){
  mode='hold';await page.evaluate(()=>{void window.__PI_WEB_REFRESH_PROJECT_STATUS__();});
  for(let i=0;i<40&&!heldReads.length;i++)await page.waitForTimeout(25);
  assert(heldReads.length,'Pending status request was intercepted');
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.__PI_ENH_PROJECT_STATUS_MODEL__.health().state),'live','Hiding a tab must not report a failed read');
  result.checks.push({width,scenario:'intentional-hidden-abort-keeps-fresh-status'});
  mode='ok';heldReads.splice(0).forEach(release=>release());
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
  await page.waitForFunction(()=>document.title.endsWith('🔵1 🟡1'));
  const background=await context.newPage();background.on('pageerror',e=>result.errors.push(e.message));await background.goto(origin+'/?session='+ids[3],{waitUntil:'domcontentloaded'});await background.waitForFunction(()=>document.title.endsWith('🔵1'));
  await background.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
  revision++;const savedRunning=running,savedExecutions=executions,savedPending=pending;running=[];executions=[];pending=[];await refresh();await background.waitForFunction(()=>document.title==='odoo');
  await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForTimeout(150);requests=0;await background.waitForFunction(()=>window.__PI_ENH_PROJECT_STATUS_MODEL__.health().state==='unavailable',{},{timeout:14000});assert.equal(await background.title(),'odoo');assert.equal(requests,0,'Hidden tabs share receipts or expire, without polling');
  result.checks.push({width,scenario:'hidden-tab-broadcast-and-expiry',hiddenRequests:requests});
  running=savedRunning;executions=savedExecutions;pending=savedPending;revision++;await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});await page.waitForFunction(()=>document.title.endsWith('🔵1 🟡1'));await background.close();
 }

 revision++;running=[];pending=[];executions=[{sessionId:ids[0],state:'running',runId:'orphan'},{sessionId:ids[1],state:'ended',runId:'done'}];await refresh();await page.waitForFunction(()=>document.title==='work');assert.equal(await page.locator('[data-pi-enh-current-project] [data-pi-native-project-status-dot]').count(),0);result.checks.push({width,scenario:'orphan-not-running-and-completed-not-counted',title:await page.title()});
 revision++;executions=[{sessionId:ids[0],state:'failed',runId:'failed'}];await refresh();await page.waitForFunction(()=>document.querySelector('[data-pi-enh-current-project] [data-pi-native-project-status-dot]')?.getAttribute('data-pi-native-project-status-dot')==='interrupted');
 // Delete only the fixture file and force the normal native catalog refresh. The stale server receipt must not survive.
 const saved=fs.readFileSync(files[0]);fs.unlinkSync(files[0]);await page.evaluate(()=>window.__PI_ENH_REFRESH_SESSIONS__(false,true));await page.waitForFunction(()=>!document.querySelector('[data-pi-enh-current-project] [data-pi-native-project-status-dot]'));assert.equal(await page.locator(`[data-pi-enh-session-id="${ids[0]}"]`).count(),0);result.checks.push({width,scenario:'deleted-error-cleared'});fs.writeFileSync(files[0],saved);await page.evaluate(()=>window.__PI_ENH_REFRESH_SESSIONS__(false,true));
 revision++;mode='offline';await refresh();await page.waitForFunction(()=>window.__PI_ENH_PROJECT_STATUS_MODEL__.health().state==='unavailable');assert.equal(await page.title(),'work');assert.equal(await page.locator('[data-pi-enh-current-project] [data-pi-native-project-status-dot="unknown"]').count(),1);result.checks.push({width,scenario:'offline-unknown',title:await page.title()});
 mode='ok';executions=[];await refresh();await page.waitForFunction(()=>window.__PI_ENH_PROJECT_STATUS_MODEL__.health().state==='live');await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__PI_ENH_PROJECT_STATUS_MODEL__?.health().state==='live');assert.equal(await page.title(),'work');result.checks.push({width,scenario:'refresh-no-cache-resurrection'});
 if(width===1280){mode='timeout';const started=Date.now();await refresh();await page.waitForFunction(()=>window.__PI_ENH_PROJECT_STATUS_MODEL__.health().state==='unavailable',{},{timeout:10000});assert.equal(await page.title(),'work');result.checks.push({width,scenario:'timeout-unknown',elapsedMs:Date.now()-started});mode='ok';}
 if(process.env.PI_STATUS_SCREENSHOTS){fs.mkdirSync(process.env.PI_STATUS_SCREENSHOTS,{recursive:true});await page.screenshot({path:path.join(process.env.PI_STATUS_SCREENSHOTS,`status-${width}.png`)});}
 await context.close();
 }
 assert.deepEqual(result.errors,[]);result.status='passed';
}catch(e){result.status='failed';result.failure=e.stack;process.exitCode=1;}finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(r=>{if(server.exitCode!==null)return r();server.once('exit',r);setTimeout(()=>{server.kill('SIGKILL');r()},2000).unref()});fs.rmSync(scratch,{recursive:true,force:true});fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
