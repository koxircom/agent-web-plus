// Isolated Next page and mocked job transport. No real sessions are deleted.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const {chromium}=require('playwright');
const origin='http://127.0.0.1:31365',password=crypto.randomUUID();
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'pi-delete-cancel-'));
const ids=['codex:11111111-1111-4111-8111-111111111111','codex:22222222-2222-4222-8222-222222222222'];
const sessions=ids.map((id,i)=>({id,path:'/isolated/'+i+'.jsonl',cwd:'/isolated',name:'测试会话 '+i,created:'2026-10-20',modified:'2026-10-20',messageCount:1,firstMessage:'隔离验证'}));
let browser,server,log='';
try {
 server=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','31365'],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:scratch,PI_AGENT_DIR:scratch,PI_WEB_PASSWORD:password},stdio:['ignore','pipe','pipe']});
 server.stdout.on('data',x=>log+=x);server.stderr.on('data',x=>log+=x);
 for(let i=0;i<80;i++){if(server.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/login')).ok)break}catch{}await new Promise(r=>setTimeout(r,250))}
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900},locale:'zh-CN',isMobile:width===390,hasTouch:width===390,serviceWorkers:'block'});
  const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');
  const sig=crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex');
  await context.addCookies([{name:'pi_web_session',value:token+'.'+sig,url:origin}]);
  await context.addInitScript(()=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme','dark')});
  let job=null,cancelPosts=0,deleted=0;const errors=[];
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url()),json=(body,status=200)=>route.fulfill({status,json:body}),ok=data=>json({success:true,data});
   if(url.origin!==origin)return route.abort('blockedbyclient');
   if(!url.pathname.startsWith('/api/'))return route.continue();
   if(url.pathname==='/api/sessions/batch-delete/jobs'&&req.method()==='POST'){
    const data=req.postDataJSON();assert.deepEqual(data.ids,ids);job={id:data.id,ids:data.ids,total:ids.length,status:'running',processed:0,lastSequence:1,cancelRequested:false};return json(job,202);
   }
   if(url.pathname.startsWith('/api/sessions/batch-delete/jobs/')&&job){
    if(url.pathname.endsWith('/events')){
     const frames=[{seq:1,frame:{type:'start',total:2}}];
     if(job.cancelRequested)frames.push({seq:2,frame:{type:'done',total:2,processed:0,results:ids.map(id=>({id,ok:false,state:'not_started'})),deletedSessionIds:[],stopped:true}});
     job.lastSequence=frames.length;job.status=job.cancelRequested?'stopped':'running';
     return json({...job,frames:frames.filter(x=>x.seq>Number(url.searchParams.get('after')||0))});
    }
    if(req.method()==='POST'){cancelPosts++;job.cancelRequested=true;return json(job)}
    return json(job);
   }
   if(url.pathname==='/api/sessions')return json({sessions});
   if(url.pathname==='/api/agent/running')return json({runningSessionIds:[],sessionListVersion:1});
   if(url.pathname==='/api/models')return json({models:{},modelList:[]});
   if(url.pathname==='/api/execution-engines')return json({defaultEngine:'codex',codex:{enabled:true,url:origin+'/native'}});
   if(url.pathname==='/api/execution-engines/check')return json({connected:true,projects:[{cwd:'/isolated'}]});
   if(url.pathname==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
   if(url.pathname.startsWith('/api/sessions/'))return json({sessionId:ids[0],tree:[],leafId:null,totalActiveMs:0,context:{messages:[],entryIds:[],oldestEntryId:null,hasMore:false,thinkingLevel:'high',model:null}});
   if(url.pathname.startsWith('/api/agent/'))return req.method()==='POST'?ok({isStreaming:false,tools:[],commands:[]}):json({running:false,state:{isStreaming:false,queuedMessages:{steering:[],followUp:[]}}});
   return json({success:true,data:{},sessions:[],models:[],skills:[],tools:[],projects:[]});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/?engine=codex',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>typeof window.__PI_ENH_SET_SESSION_BATCH_MODE__==='function',{},{timeout:20000});
  await page.evaluate(ids=>{window.__PI_ENH_SET_SESSION_BATCH_MODE__(true);for(const id of ids)window.__PI_ENH_TOGGLE_SESSION_BATCH_SELECT__(id,true)},ids);
  const deleteButton=page.locator('#pi-enh-session-batch-bar [data-action="batch-delete"]');
  const box=await deleteButton.boundingBox();
  if(width===390&&(!box||box.x<0||box.x>=width)){
   await page.locator('button[title*="sidebar"],button[aria-label*="sidebar"],button[title*="侧栏"],button[aria-label*="侧栏"],button[title="显示侧边栏"]').first().click({timeout:5000});
  }
  await deleteButton.click();const modal=page.locator('#pi-enh-batch-delete-modal');await modal.waitFor();
  await modal.locator('[data-action="confirm"]').click();const stop=modal.locator('[data-action="stop"]');await stop.waitFor({state:'visible'});
  const bounds=await stop.boundingBox();assert(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width,'cancel control fits viewport');
  await stop.click();await page.waitForFunction(()=>document.querySelector('#pi-enh-batch-progress-status')?.textContent?.includes('任务已停止'),null,{timeout:15000});
  assert.equal(await modal.locator('#pi-enh-batch-progress-counts').textContent(),'0 / 2');assert.equal(cancelPosts,1);assert.equal(job.cancelRequested,true);assert.equal(deleted,0);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({width,cancelPosts,deleted,jobStatus:job.status,buttonVisible:true}));await context.close();
 }
} finally {
 if(browser)await browser.close();if(server&&server.exitCode===null){server.kill('SIGTERM');await new Promise(r=>server.once('exit',r))}fs.rmSync(scratch,{recursive:true,force:true});
}
