// Actual built Next page, native hook/composer and shipped enhancement service.
// All API traffic is intercepted inside an isolated browser context. No LLM.
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
const output=path.resolve(root,'../acceptance');fs.mkdirSync(output,{recursive:true});
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'pi-queue-edit-'));
const origin='http://127.0.0.1:31364',password=crypto.randomUUID();
const model={provider:'openai',modelId:'gpt-6.1-sol',id:'gpt-6.1-sol'};
const image={data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5QAAAABJRU5ErkJggg==',mimeType:'image/png'};
const sessionStates=new Map(),errors=[],cases=[];let browser,child,log='',promptCalls=0;
const make=(engine,rows=[])=>{const sid=(engine==='codex'?'codex:':'')+crypto.randomUUID();const s={sid,rows,records:new Map(rows.map(row=>[row.requestId,{...row,status:'accepted'}])),ackAttempts:0,ackSuccess:0,reads:0,actions:[],dropAck:false};sessionStates.set(sid,s);return s};
const item=(text,images=[])=>({token:crypto.randomUUID(),requestId:crypto.randomUUID(),text,images,kind:'followUp'});
const queue=s=>{const steer=s.rows.filter(x=>x.kind==='steering'),follow=s.rows.filter(x=>x.kind!=='steering');return {steering:steer.map(x=>x.text),followUp:follow.map(x=>x.text),requestIds:{steering:steer.map(x=>x.requestId),followUp:follow.map(x=>x.requestId)}}};
const pending=s=>[...s.records.values()].filter(x=>x.status!=='cancelled').map(x=>({requestId:x.requestId,sessionId:s.sid,message:x.text,images:x.images,status:x.status,streamingBehavior:x.kind==='steering'?'steer':'followUp',createdAt:1,deliveryProtocol:2}));
const state=s=>({running:true,runtimeAlive:true,state:{isStreaming:true,isPromptRunning:true,model,thinkingLevel:'high',queuedMessages:queue(s)},uncommittedPrompts:pending(s)});
const session=s=>({id:s.sid,path:'/isolated/'+s.sid+'.jsonl',cwd:'/isolated',name:'队列编辑验收',created:'2026-10-20',modified:'2026-10-20',messageCount:1,firstMessage:'隔离验收'});
const detail=x=>({...x,version:2});
async function fixture(route){
 const req=route.request(),u=new URL(req.url());
 if(u.origin!==origin)return route.abort('blockedbyclient');
 const json=(data,status=200)=>route.fulfill({status,json:data});
 const success=data=>json({success:true,data});
 if(!u.pathname.startsWith('/api/')){
  if(/^\/pi-(?:agent-update|archived|odoo-addons|pinned|shortcuts|tags)-manifest\.json$/.test(u.pathname))return json([]);
  if(u.pathname==='/pi-usage-ledger.json')return json({});
  return route.continue();
 }
 const a=u.pathname.match(/^\/api\/agent\/([^/]+)(\/events|\/lease)?$/);
 if(a){const s=sessionStates.get(decodeURIComponent(a[1]));if(!s)return json({error:'unknown fixture'},404);
  if(a[2]==='/lease')return success({});
  if(a[2]==='/events')return route.fulfill({contentType:'text/event-stream',body:[{type:'connected',isStreaming:true,pendingExtensionUiIds:[]},{type:'queue_update',...queue(s)}].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')});
  if(req.method()==='GET'){
   if(u.searchParams.has('requestId')){s.reads++;return json({status:s.records.get(u.searchParams.get('requestId'))?.status??'cancelled',inFlight:true})}
   if(u.searchParams.has('inbox')||u.searchParams.has('interactions'))return json({uncommittedPrompts:pending(s),pendingExtensionUiRequests:[]});
   return json(state(s));
  }
  const command=req.postDataJSON()??{},type=command.type;
  if(type==='prompt'){promptCalls++;return json({error:'No prompt is permitted in this test'},403)}
  if(type==='get_queue_actions'){const q=kind=>s.rows.filter(x=>x.kind===kind).map(x=>({token:x.token,text:x.text,imageCount:x.images.length}));return success({version:2,reorder:true,steering:q('steering'),followUp:q('followUp')})}
  if(type==='get_queued_message')return success(detail(s.rows.find(x=>x.token===command.token)));
  if(type==='acknowledge_recalled_prompts'){
   s.ackAttempts++;if(s.dropAck){s.dropAck=false;return json({error:'lost ACK fixture'},503)}
   s.ackSuccess++;for(const id of command.requestIds??[])if(s.records.has(id))s.records.get(id).status='cancelled';
   return success({cancelledPromptRequestIds:command.requestIds});
  }
  if(type==='recall_queued_message'||type==='recall_all_queued_messages'){
   const selected=type==='recall_queued_message'?s.rows.filter(x=>x.token===command.token):s.rows;
   assert(selected.length);if(type==='recall_all_queued_messages')assert.deepEqual(command.tokens,s.rows.map(x=>x.token));
   for(const x of selected)s.records.get(x.requestId).status='recalled';
   s.rows=s.rows.filter(x=>!selected.includes(x));s.actions.push(type);
   const metadata={recalledPromptRequestIds:selected.map(x=>x.requestId),cancelledPromptRequestIds:s.sid.startsWith('codex:')?selected.map(x=>x.requestId):[]};
   return success(type==='recall_queued_message'?{...detail(selected[0]),...metadata}:{version:2,entries:selected.map(detail),...metadata});
  }
  if(type==='delete_queued_message'){
   const x=s.rows.find(x=>x.token===command.token);assert(x);s.rows=s.rows.filter(row=>row!==x);s.records.get(x.requestId).status='cancelled';s.actions.push(type);return success({version:2,cancelledPromptRequestIds:[x.requestId]});
  }
  if(type==='promote_queued_message'){
   const x=s.rows.find(x=>x.token===command.token);assert(x);x.kind='steering';s.rows=[...s.rows.filter(x=>x.kind==='steering'),...s.rows.filter(x=>x.kind!=='steering')];s.actions.push(type);return success({version:2,queuedMessages:queue(s)});
  }
  if(type==='reorder_queued_message'){
   const i=s.rows.findIndex(x=>x.token===command.token),j=s.rows.findIndex(x=>x.token===command.targetToken);assert(i>=0&&j>=0);const [x]=s.rows.splice(i,1);s.rows.splice(j,0,x);s.actions.push(type);return success({version:2,queuedMessages:queue(s)});
  }
  return success({isStreaming:true,model,thinkingLevel:'high',tools:[],commands:[]});
 }
 const m=u.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/state)?$/);
 if(m){const s=sessionStates.get(decodeURIComponent(m[1]));if(!s)return json({error:'unknown fixture'},404);return json({...state(s),sessionId:s.sid,tree:[],leafId:null,totalActiveMs:0,context:{messages:[{role:'assistant',content:[{type:'text',text:'隔离验证：队列身份与编辑恢复'}]}],entryIds:['saved-assistant'],oldestEntryId:null,hasMore:false,thinkingLevel:'high',model}})}
 if(u.pathname==='/api/sessions')return json({sessions:[...sessionStates.values()].map(session)});
 if(u.pathname==='/api/agent/running')return json({runningSessionIds:[...sessionStates.keys()],completionNotificationSuppressedSessionIds:[],sessionListVersion:1});
 if(u.pathname==='/api/models')return json({models:{'openai:gpt-6.1-sol':'GPT-6.1 Sol'},modelList:[{id:'gpt-6.1-sol',provider:'openai',name:'GPT-6.1 Sol'}],defaultModel:model});
 if(u.pathname==='/api/execution-engines')return json({defaultEngine:'pi',codex:{enabled:true,url:origin+'/native'}});
 if(u.pathname==='/api/execution-engines/check')return json({connected:true,projects:[{cwd:'/isolated'}]});
 if(u.pathname==='/api/cwd/validate')return json({valid:true,cwd:'/isolated',exists:true});
 if(u.pathname==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
 return json({success:true,data:{},skills:[],tools:[],models:[],sessions:[],projects:[]});
}
const focus=page=>page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'))});
const occurrences=(value,text)=>value.split(text).length-1;
async function open(page,s){await page.goto(origin+'/?session='+encodeURIComponent(s.sid)+'&engine='+(s.sid.startsWith('codex:')?'codex':'pi'),{waitUntil:'domcontentloaded'});await page.locator('textarea').last().waitFor({timeout:20000})}
async function clickEdit(page,text){const b=page.locator('[data-pi-native-queue] .pi-enh-queue-text').filter({hasText:text}).first();await b.waitFor();await page.waitForFunction(text=>[...document.querySelectorAll('.pi-enh-queue-text')].some(e=>e.textContent===text&&!e.disabled),text,{timeout:15000});await b.click();await page.waitForFunction(text=>document.querySelector('textarea')?.value.includes(text),text,{timeout:10000})}
try{
 assert(fs.existsSync(path.join(root,'.next/BUILD_ID')),'Build the real candidate before browser acceptance');
 await new Promise((resolve,reject)=>{const check=net.createServer();check.once('error',reject);check.listen(31364,'127.0.0.1',()=>check.close(resolve))});
 child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','31364'],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:scratch,PI_AGENT_DIR:scratch,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 fs.writeFileSync(output+'/QUEUE_BROWSER_PROCESS.json',JSON.stringify({pid:child.pid,startTicks:fs.readFileSync('/proc/'+child.pid+'/stat','utf8').split(' ')[21],port:31364}));
 for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/login')).ok)break}catch{}await new Promise(r=>setTimeout(r,250))}
 const chrome=chromium.executablePath();assert(fs.existsSync(chrome),'registered Playwright Chromium must be present');browser=await chromium.launch({headless:true,executablePath:chrome,args:['--no-sandbox']});
 for(const engine of ['pi','codex'])for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,locale:'zh-CN',serviceWorkers:'block'});
  const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');const sig=crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex');
  await context.addCookies([{name:'pi_web_session',value:token+'.'+sig,url:origin}]);
  await context.addInitScript(()=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme','dark');localStorage.setItem('pi-enh-plugin-composer-queue-panel','true')});
  await context.route('**/*',fixture);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const rows=[item('检查队列消息身份',[image]),item('核对编辑恢复'),item('验证附件保留')],a=make(engine,rows),b=make(engine);
  await open(page,a);
  await page.waitForFunction(()=>document.querySelectorAll('.pi-enh-queue-row:not([data-retained-request-id])').length===3);
  assert.equal(await page.locator('.pi-enh-queue-row').count(),3,'accepted backups cannot duplicate an identified native snapshot');
  const boxes=await page.locator('.pi-enh-queue-row').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {y:r.y,bottom:r.bottom}}));
  for(let i=1;i<boxes.length;i++)assert(boxes[i].y>=boxes[i-1].bottom,'adjacent queue rows overlap');
  assert.equal(await page.getByText('正在同步队列',{exact:true}).count(),0);
  await page.waitForFunction(sid=>new Promise(resolve=>{const r=indexedDB.open('pi-web-prompt-submissions-v1',1);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('submissions')){db.close();return resolve(false)}const q=db.transaction('submissions').objectStore('submissions').getAll();q.onsuccess=()=>{const found=q.result.filter(x=>x.sessionId===sid&&x.status==='accepted').length;db.close();resolve(found===3)};q.onerror=()=>{db.close();resolve(false)}};r.onerror=()=>resolve(false)}),a.sid);
  await page.screenshot({path:output+`/queue-${engine}-${width}-before.png`,animations:'disabled'});
  await page.locator('textarea').last().fill('已有草稿内容');a.dropAck=true;const reads=a.reads;
  await clickEdit(page,rows[0].text);assert(a.actions.includes('recall_queued_message'),'must execute actual queue action, never call restore directly');
  await page.waitForFunction(text=>document.querySelector('textarea')?.value.includes(text),rows[0].text);
  assert.equal(occurrences(await page.locator('textarea').last().inputValue(),rows[0].text),1);
  await focus(page);
  for(let i=0;i<60&&a.ackAttempts<2;i++){await focus(page);await new Promise(r=>setTimeout(r,100))}
  assert(a.ackAttempts>=2,'lost ACK must be retried via actual receipt recovery');assert(a.reads>reads,'receipt recovery must run');assert.equal(a.records.get(rows[0].requestId).status,'cancelled');
  const value=await page.locator('textarea').last().inputValue();assert.equal(occurrences(value,rows[0].text),1);assert(value.includes('已有草稿内容'));
  await page.waitForFunction(()=>document.querySelectorAll('.pi-enh-queue-row').length===2,{},{timeout:20000});
  assert.equal(await page.locator('[data-pi-native-composer-host] img').count(),1,'restored attachment appears exactly once');
  await page.screenshot({path:output+`/queue-${engine}-${width}-edited.png`,animations:'disabled'});
  await open(page,b);assert(!(await page.locator('textarea').last().inputValue()).includes(rows[0].text));await open(page,a);
  await page.waitForFunction(text=>document.querySelector('textarea')?.value.includes(text),rows[0].text);assert.equal(occurrences(await page.locator('textarea').last().inputValue(),rows[0].text),1);
  // Same text, two different IDs remain two jobs; native keyboard reordering.
  const twin=make(engine,[item('相同文本的独立任务'),item('相同文本的独立任务')]);await open(page,twin);
  await page.waitForFunction(()=>document.querySelectorAll('.pi-enh-queue-row').length===2);
  const sort=page.getByRole('button',{name:'拖动排序第 2 条排队消息',exact:true});await page.waitForFunction(()=>!document.querySelectorAll('.pi-enh-queue-sort')[1]?.disabled);await sort.focus();await sort.press('ArrowUp');
  for(let i=0;i<50&&!twin.actions.includes('reorder_queued_message');i++)await new Promise(r=>setTimeout(r,100));assert(twin.actions.includes('reorder_queued_message'));
  const noCache=make(engine,[item('关闭草稿缓存也只恢复一次')]);await open(page,noCache);
  await page.evaluate(()=>window.__PI_ENH_SET_PLUGIN__('composer-draft-cache',false));
  assert.equal(await page.evaluate(()=>window.__PI_ENH_IS_PLUGIN_ENABLED__('composer-draft-cache')),false,'disable the actual registry preference, not an unused storage key');
  const readCount=noCache.reads;await clickEdit(page,noCache.rows[0].text);const text='关闭草稿缓存也只恢复一次';const originalRid=[...noCache.records.keys()][0];
  await focus(page);for(let i=0;i<30&&noCache.reads===readCount;i++){await focus(page);await new Promise(r=>setTimeout(r,100))}
  assert(noCache.reads>readCount);assert.equal(noCache.ackAttempts,0);assert.equal(noCache.records.get(originalRid).status,'recalled');assert.equal(occurrences(await page.locator('textarea').last().inputValue(),text),1);
  assert.equal(promptCalls,0);cases.push({engine,width,nonOverlap:true,knownIdentityNoDuplicate:true,realClickRecall:true,lostAckRetried:true,originDraftIsolation:true,sameTextSeparateIds:true,realReorder:true,cacheDisabledPreservesOriginal:true});await context.close();
 }
 assert.deepEqual(errors,[]);fs.writeFileSync(output+'/QUEUE_BROWSER.json',JSON.stringify({status:'passed',cases,pageErrors:errors,productionWrites:0,modelCalls:0,promptCalls},null,2));console.log(JSON.stringify({status:'passed',cases,pageErrors:errors,promptCalls}));
}catch(error){if(browser)for(const c of browser.contexts())for(const p of c.pages()){await p.screenshot({path:output+'/queue-failure.png'}).catch(()=>{});fs.writeFileSync(output+'/queue-failure-state.txt',(await p.locator('body').innerText().catch(()=>'')));}fs.writeFileSync(output+'/QUEUE_BROWSER.json',JSON.stringify({status:'failed',error:error.stack,cases,pageErrors:errors},null,2));console.error(error.stack);process.exitCode=1}
finally{if(browser)await browser.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r))}fs.writeFileSync(output+'/isolated-next.log',log);fs.writeFileSync(output+'/CLEANUP.json',JSON.stringify({isolatedNextExited:child?.exitCode!==null,signal:child?.signalCode,privateScratchRemoved:true,newContainers:0}));fs.rmSync(scratch,{recursive:true,force:true})}
