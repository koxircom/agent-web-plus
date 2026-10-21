// Actual built Next page and certified enhancement assets. All APIs are private fixtures.
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
const output=path.resolve(root,'../acceptance'),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'agent-turn-page-')),password=crypto.randomUUID();
fs.mkdirSync(output,{recursive:true});let child,browser,log='';const cases=[],errors=[],blocked=[];
try{
 assert(fs.existsSync(root+'/.next/BUILD_ID'));
 const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const origin='http://127.0.0.1:'+port;
 child=spawn(process.execPath,[require.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:scratch,PI_AGENT_DIR:scratch,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(origin+'/login')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}assert(ready,log);
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const engine of ['codex','pi'])for(const width of [1280,390]){
  const uuid='11111111-2222-4333-8444-555555555555',sid=engine==='codex'?'codex:'+uuid:uuid,cwd='/isolated/turn-number';
  const messages=[],entryIds=[];for(const n of [98,99,100]){
   messages.push({role:'user',content:[{type:'text',text:`第${n}轮提问：${engine}共用消息编号`}],...(engine==='pi'?{timestamp:1792550000000+n*1000}:{})});entryIds.push('user-'+n);
   messages.push({role:'assistant',content:[{type:'text',text:`第${n}轮回复。`}],model:'fixture',provider:engine,stopReason:'stop'});entryIds.push('assistant-'+n);
  }
  const session={id:sid,path:'/isolated/session.jsonl',name:engine+' 轮次验证',cwd,created:'2026-10-21T00:00:00Z',modified:'2026-10-21T00:00:00Z',messageCount:200,firstMessage:'编号验证',executionEngine:engine};
  const data={sessionId:sid,filePath:session.path,sessionName:session.name,header:{type:'session',id:sid,cwd},navigationTotalTurns:100,tree:[],treeFormat:'summary',leafId:null,executionEngine:engine,snapshotRevision:'turn-page-1',context:{messages,entryIds,oldestEntryId:'user-98',hasMore:true,model:{provider:engine,modelId:'fixture'},thinkingLevel:'high'}};
  const ctx=await browser.newContext({viewport:{width,height:900},hasTouch:width===390,locale:'zh-CN',serviceWorkers:'block'});
  const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex'),sig=crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex');
  await ctx.addCookies([{name:'pi_web_session',value:token+'.'+sig,url:origin}]);
  await ctx.addInitScript(()=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme','dark');});
  await ctx.route('**/*',async route=>{
   const req=route.request(),u=new URL(req.url()),p=u.pathname,json=(d,status=200)=>route.fulfill({status,json:d});
   if(u.origin!==origin)return route.abort('blockedbyclient');
   if(!p.startsWith('/api/')){if(/^\/pi-.*manifest\.json$/.test(p))return json([]);if(p==='/pi-usage-ledger.json')return json({});return route.continue();}
   if(!['GET','HEAD'].includes(req.method())&&!p.endsWith('/lease')&&!['/api/cwd/validate','/api/execution-engines/check'].includes(p)){blocked.push({path:p,method:req.method()});return json({error:'Read-only fixture'},403);}
   if(p==='/api/execution-engines')return json({defaultEngine:engine,codex:{enabled:true,url:origin+'/native'}});
   if(p==='/api/execution-engines/check')return json({connected:true,projects:[{cwd}]});
   if(p==='/api/cwd/validate')return json({valid:true,cwd,exists:true});
   if(p==='/api/sessions')return json({sessions:[session],sessionListVersion:1});
   if(p.startsWith('/api/sessions/'))return json(u.searchParams.get('lookup')==='1'?{exists:true,sessionId:sid}:p.endsWith('/context')?{...data,context:{...data.context,messages:[],entryIds:[]}}:data);
   if(p==='/api/agent/running')return json({runningSessionIds:[],completionNotificationSuppressedSessionIds:[],sessionListVersion:1});
   if(p.endsWith('/events'))return route.fulfill({status:200,contentType:'text/event-stream',body:'event: connected\ndata: {}\n\n'});
   if(p.endsWith('/lease'))return json({acquired:true});
   if(p.startsWith('/api/agent/'))return json({running:false,runtimeAlive:false,state:{model:{provider:engine,id:'fixture'},thinkingLevel:'high'},uncommittedPrompts:[]});
   if(p==='/api/models')return json({models:{[engine+':fixture']:'Fixture'},modelList:[{id:'fixture',provider:engine,name:'Fixture'}],defaultModel:{provider:engine,modelId:'fixture'},defaultThinkingLevel:'high'});
   if(p==='/api/worktrees')return json({isGit:false,projectRoot:cwd,currentWorktreePath:cwd,worktrees:[]});
   if(p.startsWith('/api/files/'))return json({entries:[],path:cwd});
   if(p==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
   return json({success:true,data:{},skills:[],tools:[],models:[],sessions:[],projects:[]});
  });
  const page=await ctx.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/?session='+encodeURIComponent(sid)+'&engine='+engine,{waitUntil:'domcontentloaded'});
  await page.locator('[data-turn-number="100"]').waitFor();
  assert.deepEqual(await page.locator('.pi-enh-turn-number-badge').allTextContents(),['#98','#99','#100']);
  await page.waitForFunction(()=>typeof window.__PI_ENH_SET_PLUGIN__==='function');
  await page.evaluate(()=>window.__PI_ENH_SET_PLUGIN__('turn-number-indicator',false));await page.waitForFunction(()=>document.querySelectorAll('.pi-enh-turn-number-badge').length===0);
  await page.evaluate(()=>window.__PI_ENH_SET_PLUGIN__('turn-number-indicator',true));await page.locator('[data-turn-number="100"]').waitFor();
  await page.evaluate(()=>window.__PI_ENH_SET_MODULE__('task-insights',false));await page.waitForFunction(()=>document.querySelectorAll('.pi-enh-turn-number-badge').length===0);
  await page.evaluate(()=>window.__PI_ENH_SET_MODULE__('task-insights',true));await page.locator('[data-turn-number="100"]').waitFor();
  const geometry=await page.evaluate(()=>{const rows=Array.from(document.querySelectorAll('[data-entry-id][data-scroll-anchor]')).map(el=>{const b=el.getBoundingClientRect();return {y:b.y,bottom:b.bottom}});return {rows,overflow:document.documentElement.scrollWidth>innerWidth};});
  assert(geometry.rows.length>=6);assert(!geometry.overflow);for(let i=1;i<geometry.rows.length;i++)assert(geometry.rows[i].y>=geometry.rows[i-1].bottom);
  const screenshot=output+`/turn-page-${engine}-${width}.png`;await page.screenshot({path:screenshot,animations:'disabled'});
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('[data-turn-number="100"]').waitFor();assert.deepEqual(await page.locator('.pi-enh-turn-number-badge').allTextContents(),['#98','#99','#100']);
  cases.push({engine,width,screenshot,geometry,labels:['#98','#99','#100'],realEnhancementSettersPassed:true,reloadPassed:true});await ctx.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);fs.writeFileSync(output+'/TURN_PAGE_BROWSER.json',JSON.stringify({status:'passed',cases,pageErrors:errors,blocked,productionWrites:0},null,2));console.log(JSON.stringify({status:'passed',cases:cases.map(({engine,width,screenshot})=>({engine,width,screenshot}))}));
}catch(error){if(browser){const p=browser.contexts().flatMap(c=>c.pages()).at(-1);if(p){await p.screenshot({path:output+'/turn-page-failure.png'});fs.writeFileSync(output+'/TURN_PAGE_FAILURE.json',JSON.stringify({error:error.message,text:await p.locator('body').innerText(),errors,blocked},null,2));}}throw error;
}finally{if(browser)await browser.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}fs.writeFileSync(output+'/turn-page-next.log',log);fs.rmSync(scratch,{recursive:true,force:true});}
