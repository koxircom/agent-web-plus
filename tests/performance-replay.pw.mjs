// Fixed, local-only long transcript replay. Same source/fixture for before/after.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(process.env.PI_PERF_SOURCE_ROOT||fileURLToPath(new URL('..',import.meta.url)));
const load=createRequire(path.join(root,'package.json')),esbuild=load('esbuild'),{chromium}=load('playwright');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-replay-'));
const cssDir=process.env.PI_PERF_CSS_DIR||path.join(root,'.next/static/css');
const css=fs.readdirSync(cssDir).filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join(cssDir,n),'utf8')).join('\n');
const assistant=text=>({role:'assistant',content:[{type:'text',text}],model:'gpt-6.1-sol',provider:'openai',timestamp:1,stopReason:'stop'});
const user=text=>({role:'user',content:[{type:'text',text}],timestamp:1});
const history=Array.from({length:1000},(_,i)=>i%2?assistant(`历史回答 ${i}：这是用于固定回放的内容。\n\n- 保留目录与标签\n- 不调用模型\n`):user(`历史问题 ${i}`));
const sid='perf-replay',session={id:sid,cwd:'/isolated',path:'/isolated/perf.jsonl',name:'性能回放',messageCount:1000,created:'2026-10-11T00:00:00Z',modified:'2026-10-11T00:00:00Z',firstMessage:'历史问题'};
const prefix=('段落与 **强调**，用于相同长度的 Markdown 回放。\n\n- 项目一\n- 项目二\n\n').repeat(40);
const chunks=Array.from({length:360},(_,i)=>`片段${i}。 `),finalText=prefix+chunks.join('');
const question={type:'extension_ui_request',id:'perf-question',method:'custom',lines:[],askUser:{toolCallId:'question-tool',question:'回放确认：是否继续？',options:[{title:'继续'},{title:'停止'}]}};
const bundle=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from'react';import{createRoot}from'react-dom/client';import{ChatWindow}from'./components/ChatWindow';import{I18nProvider}from'./hooks/useI18n';
 window.receipt={commits:0,renderMs:0,inputs:[]};
 class Source {readyState=1;onmessage=null;onerror=null;constructor(){window.source=this;setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'connected',isStreaming:false,pendingExtensionUiIds:[]})}),0)}close(){this.readyState=2}}
 window.EventSource=Source;window.emit=e=>window.source?.onmessage?.({data:JSON.stringify(e)});
 function App(){return <React.Profiler id="chat" onRender={(id,phase,actualDuration)=>{window.receipt.commits++;window.receipt.renderMs+=actualDuration;if(window.inputAt){window.receipt.inputs.push(performance.now()-window.inputAt);window.inputAt=0}}}><ChatWindow session={${JSON.stringify(session)}} newSessionCwd={null} newSessionDraftKey={null}/></React.Profiler>}
 createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
 `},outdir:dir,entryNames:'fixture',bundle:true,splitting:true,write:true,format:'esm',alias:{'@':root,'react-dom/client':load.resolve('react-dom/profiling')},loader:{'.woff2':'file','.woff':'file','.ttf':'file'},define:{'process.env.NODE_ENV':'"production"'},metafile:true});
let completed=false,running=false,browser;
const errors=[],results=[],requests=[];
const json=(res,data)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data));};
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture');requests.push({method:req.method,path:url.pathname});
 if(url.pathname==='/fixture/start'){running=true;return json(res,{ok:true})}
 if(url.pathname==='/fixture/complete'){running=false;completed=true;return json(res,{ok:true})}
 if(url.pathname===`/api/sessions/${sid}`){const msgs=completed?[...history,assistant(finalText)]:history;return json(res,{sessionId:sid,info:session,tree:[],leafId:'e999',totalActiveMs:0,context:{messages:msgs,entryIds:msgs.map((_,i)=>'e'+i),oldestEntryId:'e0',hasMore:false,thinkingLevel:'off',model:{provider:'openai',modelId:'gpt-6.1-sol'}}})}
 if(url.pathname.startsWith('/api/agent/')||url.pathname.endsWith('/state'))return json(res,{running,state:{isStreaming:running,isPromptRunning:false,queuedMessages:{steering:[],followUp:[]}},pendingExtensionUiRequests:[]});
 if(url.pathname.startsWith('/api/'))return json(res,{models:{'openai:gpt-6.1-sol':'GPT-6.1 Sol'},modelList:[],skills:[],running:false,isStreaming:false,pendingExtensionUiRequests:[],data:{},tools:[]});
 const filename=path.join(dir,path.basename(url.pathname));
 if(fs.existsSync(filename)&&fs.statSync(filename).isFile()){res.setHeader('content-type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.css')?'text/css':'application/octet-stream');return res.end(fs.readFileSync(filename))}
 res.setHeader('content-type','text/html');res.end(`<html data-theme="dark"><head><style>${css}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style>${fs.existsSync(path.join(dir,'fixture.css'))?'<link rel="stylesheet" href="/fixture.css">':''}</head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 for(const width of (process.env.PI_PERF_WIDTHS||'1280,390').split(',').map(Number))for(let sample=0;sample<Number(process.env.PI_PERF_SAMPLES||3);sample++){
  completed=false;running=false;const page=await browser.newPage({viewport:{width,height:844}});page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin);await page.locator('textarea').waitFor();await page.waitForFunction(()=>window.source?.onmessage);await page.waitForTimeout(250);
  await page.request.get(origin+'/fixture/start');const cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable');
  const cpuBefore=(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='TaskDuration').value;
  await page.evaluate(({prefix,question})=>{window.inputAt=0;window.receipt={commits:0,renderMs:0,inputs:[]};window.emit({type:'agent_start'});window.emit({type:'message_start',message:{role:'assistant',content:[{type:'text',text:prefix}],model:'gpt-6.1-sol',provider:'openai'}});}, {prefix,question});
  await page.getByRole('button',{name:/^(Stop agent|停止 Agent)$/}).waitFor();
  const replay=await page.evaluate(async chunks=>{
   let inputCount=0;const input=document.querySelector('textarea');
   const probe=setInterval(()=>{window.inputAt=performance.now();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,String(++inputCount));input.dispatchEvent(new Event('input',{bubbles:true}))},100);
   const start=performance.now();for(const delta of chunks){window.emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta}});await new Promise(r=>setTimeout(r,2))}clearInterval(probe);await new Promise(r=>setTimeout(r,70));return {...window.receipt,elapsedMs:performance.now()-start};
  },chunks);
  const cpuAfter=(await cdp.send('Performance.getMetrics')).metrics.find(m=>m.name==='TaskDuration').value;
  assert.deepEqual((await page.locator('.markdown-body').last().textContent()).match(/片段\d+。/g),chunks.map(s=>s.trim()),'streamed chunks are complete, ordered and not duplicated');
  // Interaction and terminal boundaries must not wait for a frame.
  await page.evaluate(({question})=>{window.askAt=performance.now();window.emit(question);},{question});
  await page.getByText(question.askUser.question,{exact:true}).waitFor();const askMs=await page.evaluate(()=>performance.now()-window.askAt);
  await page.evaluate(()=>window.emit({type:'extension_ui_closed',id:'perf-question'}));
  await page.request.get(origin+'/fixture/complete');
  await page.evaluate(message=>{window.endAt=performance.now();window.emit({type:'message_end',message});window.emit({type:'agent_settled'});window.emit({type:'prompt_done'});},assistant(finalText));
  await page.getByRole('button',{name:/^(Stop agent|停止 Agent)$/}).waitFor({state:'detached'});
  await page.waitForFunction(()=>!/正在等待模型|Waiting for model/i.test(document.body.textContent));
  await page.getByText('片段359。',{exact:false}).last().waitFor();
  const terminalMs=await page.evaluate(()=>performance.now()-window.endAt);
  assert.deepEqual((await page.locator('.markdown-body').last().textContent()).match(/片段\d+。/g),chunks.map(s=>s.trim()),'terminal transcript preserves every chunk exactly once');
  assert.ok(askMs<1000&&terminalMs<1000,'terminal/question response must be prompt');
  results.push({width,sample,commits:replay.commits,renderMs:replay.renderMs,cpuMs:(cpuAfter-cpuBefore)*1000,elapsedMs:replay.elapsedMs,inputP95Ms:[...replay.inputs].sort((a,b)=>a-b)[Math.floor(replay.inputs.length*.95)]??null,askMs,terminalMs});await page.close();
 }
 assert.deepEqual(errors,[]);
 assert.deepEqual(requests.filter(r=>r.method!=='GET'&&!r.path.endsWith('/lease')),[], 'Only fixture-intercepted lease renewal may use POST; never submit a model prompt');
 const receipt={fixtureVersion:2,inputProbe:'native ChatInput textarea through its React onChange and Profiler commit',label:process.env.PI_PERF_LABEL||'candidate',source:root,environment:'Chromium production profiling build; local synthetic events; 1000 history messages; 360 deltas at 2ms requested intervals',results,errors,productionRequests:0};
 if(process.env.PI_PERF_OUTPUT)fs.writeFileSync(process.env.PI_PERF_OUTPUT,JSON.stringify(receipt,null,2));console.log(JSON.stringify(receipt,null,2));
}finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true})}
