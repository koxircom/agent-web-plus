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
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'ask-dismiss-browser-'));
const origin='http://127.0.0.1:31368',password=crypto.randomUUID();
const sid='codex:01901234-5678-7000-8000-000000000001',id='codex-request:fixture:question';
const model={provider:'codex',modelId:'gpt-6.1-sol',id:'gpt-6.1-sol'};
let active=true,allowDefer=true,answerPosts=0,dismissPosts=0,child,browser,log='';
 const errors=[];
function question(){return {type:'extension_ui_request',id,method:'input',title:'隔离测试问题',allowDefer,askUser:{toolCallId:'fixture',question:'隔离测试问题',options:[],allowFreeform:true,allowMultiple:false,allowComment:false}};}
const pending=()=>active?[question()]:[];
async function fixture(route){
 const req=route.request(),u=new URL(req.url());
 if(u.origin!==origin)return route.abort('blockedbyclient');
 const json=(data,status=200)=>route.fulfill({status,json:data});
 const success=data=>json({success:true,data});
 if(!u.pathname.startsWith('/api/'))return route.continue();
 const a=u.pathname.match(/^\/api\/agent\/([^/]+)(\/events|\/lease)?$/);
 if(a){
  if(a[2]==='/lease')return success({});
  if(a[2]==='/events')return route.fulfill({contentType:'text/event-stream',body:'data: '+JSON.stringify({type:'connected',isStreaming:false,pendingExtensionUiIds:pending().map(x=>x.id)})+'\n\n'});
  if(req.method()==='GET'){
   if(u.searchParams.has('interactions'))return json({pendingExtensionUiRequests:pending(),uncommittedPrompts:[]});
   if(u.searchParams.has('inbox'))return json({uncommittedPrompts:[]});
   return json({running:false,runtimeAlive:true,state:{isStreaming:false,isPromptRunning:false,model,thinkingLevel:'high',queuedMessages:{steering:[],followUp:[]}}});
  }
  const body=req.postDataJSON()||{};
  if(body.type==='extension_ui_response'){answerPosts++;return json({error:'reply outcome unknown'},503);}
  if(body.type==='extension_ui_dismiss'){dismissPosts++;assert.equal(body.id,id);active=false;return success({id,status:'closed'});}
  if(body.type==='get_tools'||body.type==='get_commands')return success([]);
  return success({});
 }
 if(u.pathname.startsWith('/api/sessions/')&&u.pathname.endsWith('/state'))return json({runtimeAlive:true,pendingExtensionUiRequests:pending()});
 if(u.pathname.startsWith('/api/sessions/'))return json({sessionId:sid,tree:[],leafId:null,totalActiveMs:0,context:{messages:[],entryIds:[],oldestEntryId:null,hasMore:false,thinkingLevel:'high',model}});
 if(u.pathname==='/api/sessions')return json({sessions:[{id:sid,path:'/fixture',cwd:'/fixture',name:'隔离会话',firstMessage:'隔离验收',created:'2026-01-01',modified:'2026-01-01',messageCount:0}]});
 if(u.pathname==='/api/agent/running')return json({runningSessionIds:[],completionNotificationSuppressedSessionIds:[],interactionState:{version:1,sessions:active?[{sessionId:sid,pendingRequests:[{id,method:'input'}]}]:[]}});
 if(u.pathname==='/api/models')return json({models:{},modelList:[],defaultModel:model});
 if(u.pathname==='/api/execution-engines')return json({defaultEngine:'codex',codex:{enabled:true,url:origin+'/fixture'}});
 if(u.pathname==='/api/execution-engines/check')return json({connected:true,projects:[{cwd:'/fixture'}]});
 if(u.pathname==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
 return json({success:true,data:{},skills:[],tools:[],models:[],sessions:[],projects:[]});
}
try{
 await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(31368,'127.0.0.1',()=>s.close(resolve));});
 child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p','31368'],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:scratch,PI_AGENT_DIR:scratch,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 for(let i=0;i<80;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/login')).ok)break}catch{}await new Promise(r=>setTimeout(r,250));}
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined,args:['--no-sandbox']});
 for(const width of [1280,390]){
  const context=await browser.newContext({viewport:{width,height:800},hasTouch:width===390,locale:'zh-CN',serviceWorkers:'block'});
  const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');
  await context.addCookies([{name:'pi_web_session',value:token+'.'+crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex'),url:origin}]);
  await context.route('**/*',fixture);const page=await context.newPage();page.on('pageerror',e=>errors.push(e.stack||e.message));
  active=true;allowDefer=true;answerPosts=0;dismissPosts=0;
  await page.goto(origin+'/?session='+encodeURIComponent(sid));
  const dialog=page.getByRole('dialog',{name:'隔离测试问题'});await dialog.waitFor({timeout:20000});
  await dialog.getByRole('textbox',{name:'自定义回答'}).fill('保留的回答');await dialog.getByRole('button',{name:'发送',exact:true}).click();
  await page.getByText('结果待确认，未重复发送',{exact:true}).waitFor();
  if(width===1280)await dialog.getByRole('button',{name:'关闭',exact:true}).click();
  else await page.getByRole('button',{name:'关闭交互提示'}).click();
  await dialog.waitFor({state:'hidden'});
  assert.equal(answerPosts,1);assert.equal(dismissPosts,1);
  await page.reload();await page.locator('textarea').last().waitFor({timeout:20000});assert.equal(await dialog.count(),0);
  active=true;allowDefer=false;await page.reload();await dialog.waitFor({timeout:20000});
  await page.getByRole('textbox',{name:'自定义回答'}).fill('需要保留的草稿');await page.getByRole('button',{name:'关闭交互提示'}).click();
  await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:/查看已隐藏的请求/}).click();await dialog.waitFor();
  assert.equal(await page.getByRole('textbox',{name:'自定义回答'}).inputValue(),'需要保留的草稿');assert.equal(dismissPosts,1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await context.close();
 }
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',viewports:[1280,390],checks:['uncertain-close','no-repeat-answer','reload','hidden-draft','no-overflow']}));
}catch(error){
 if(browser)for(const context of browser.contexts())for(const page of context.pages()){
  console.error('FIXTURE PAGE',await page.locator('body').innerText().catch(()=>''));
  console.error('FIXTURE ERRORS',JSON.stringify(errors));
 }
 throw error;
}finally{if(browser)await browser.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}fs.rmSync(scratch,{recursive:true,force:true});}
