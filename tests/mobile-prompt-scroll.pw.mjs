// Actual native ChatWindow in an isolated HTTP fixture; no production/model requests.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url), {build}=require('esbuild'), {chromium}=require('playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const user=text=>({role:'user',content:[{type:'text',text}],timestamp:Date.now()});
const assistant=text=>({role:'assistant',content:[{type:'text',text}],timestamp:Date.now(),api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',stopReason:'stop',usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
const history=[user('上一轮用户消息'),assistant('上一轮内容。\n\n'.repeat(120))];
const session={id:'scroll-fixture',cwd:'/isolated',name:'Scroll fixture',path:'/isolated/session.jsonl',created:new Date().toISOString(),modified:new Date().toISOString(),messageCount:2,firstMessage:'previous'};
const bundle=await build({stdin:{resolveDir:root,loader:'tsx',contents:`import React from 'react';import{createRoot}from'react-dom/client';import{ChatWindow}from'./components/ChatWindow';import{I18nProvider}from'./hooks/useI18n';createRoot(document.getElementById('root')).render(<I18nProvider><ChatWindow session={${JSON.stringify(session)}} newSessionCwd={null} newSessionDraftKey={null}/></I18nProvider>);`},bundle:true,write:false,outfile:'fixture.js',format:'iife',alias:{'@':root},loader:{'.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'process.env.NODE_ENV':'"development"'}});
const cssDir=process.env.SCROLL_CSS_DIR||path.join(root,'.next/static/css');
const css=fs.readdirSync(cssDir).filter(n=>n.endsWith('.css')).map(n=>fs.readFileSync(path.join(cssDir,n),'utf8')).join('\n');
assert.ok(css,'Build the candidate CSS before checking native scroll geometry');
const streams=new Set(),timers=new Set();let messages=[...history],olderPending=null;
const later=(fn,ms)=>{const t=setTimeout(()=>{timers.delete(t);fn()},ms);timers.add(t)};
const json=(res,data)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(data))};
const emit=event=>{for(const res of streams)if(!res.destroyed)res.write(`data: ${JSON.stringify(event)}\n\n`)};
const context=(rows,ids,hasMore=true)=>({messages:rows,entryIds:ids,oldestEntryId:ids[0],hasMore,thinkingLevel:'off',model:{provider:'openai',modelId:'gpt-6.1-sol',id:'gpt-6.1-sol'}});
fs.writeFileSync('/tmp/pi-scroll-fixture.js',bundle.outputFiles[0].text);
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://fixture');
 if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text)}
 if(url.pathname.endsWith('/events')){res.setHeader('content-type','text/event-stream');streams.add(res);req.on('close',()=>streams.delete(res));res.write(`data: ${JSON.stringify({type:'connected',isStreaming:false,pendingExtensionUiIds:[]})}\n\n`);return}
 if(url.pathname==='/api/sessions/scroll-fixture/context'&&url.searchParams.has('before')){olderPending=res;return}
 if(url.pathname==='/api/sessions/scroll-fixture')return json(res,{sessionId:session.id,info:session,tree:[],leafId:'e1',totalActiveMs:0,context:context(messages,messages.map((_,i)=>'e'+i))});
 if(url.pathname==='/api/agent/scroll-fixture'&&req.method==='POST'){
  let body='';for await(const chunk of req)body+=chunk;const command=JSON.parse(body);
  if(command.type==='prompt') {messages.push(user(command.message));emit({type:'agent_start'});later(()=>emit({type:'message_end',message:messages.at(-1)}),20)}
  return json(res,{success:true,data:{isStreaming:false,model:{provider:'openai',modelId:'gpt-6.1-sol',id:'gpt-6.1-sol'},thinkingLevel:'off'}})
 }
 if(url.pathname==='/fixture/older'){const older=[user('更早的用户消息'),assistant('更早内容。\n\n'.repeat(30))];if(olderPending){json(olderPending,{context:context(older,['old0','old1'],false)});olderPending=null}return json(res,{ok:true})}
 if(url.pathname==='/fixture/answer'){emit({type:'message_end',message:assistant('后台继续输出')});return json(res,{ok:true})}
 if(url.pathname==='/fixture/stream'){emit({type:'message_start',message:assistant('流式回答：')});for(let i=0;i<80;i++)later(()=>emit({type:'message_update',assistantMessageEvent:{type:'text_delta',contentIndex:0,delta:`片段${i}。 `}}),i*2);return json(res,{ok:true})}
 if(url.pathname==='/fixture/end'){emit({type:'message_end',message:assistant('本轮回答完成')});emit({type:'agent_end',messages:[]});return json(res,{ok:true})}
 if(url.pathname.startsWith('/api/'))return json(res,{models:{'openai:gpt-6.1-sol':'GPT-6.1 Sol'},modelList:[],skills:[],running:false,isStreaming:false,pendingExtensionUiRequests:[],data:{},tools:[]});
 res.setHeader('content-type','text/html');res.end(`<html data-theme="dark"><head><style>${css}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`)
});
let browser;const receipts=[];const errors=[];
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true});const origin='http://127.0.0.1:'+server.address().port;
 for(const width of [390,980]){
  messages=[...history];const page=await browser.newPage({viewport:{width,height:844},hasTouch:true});page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.stack)});await page.goto(origin);await page.waitForTimeout(500);if(errors.length)throw Error(errors.join('\n'));
  const scroll=page.locator('[data-pi-native-scroll-owner]'),input=page.locator('textarea').last();await scroll.waitFor({timeout:3000});await page.getByText('上一轮用户消息',{exact:true}).waitFor();
  const send=async(text)=>{await input.fill(text);await input.press('Control+Enter');await scroll.getByText(text,{exact:true}).waitFor();await page.waitForTimeout(150)};
  const measure=async(text)=>scroll.getByText(text,{exact:true}).evaluate(el=>{const s=el.closest('[data-pi-native-scroll-owner]');return {offset:el.getBoundingClientRect().top-s.getBoundingClientRect().top,scrollTop:s.scrollTop,height:s.clientHeight,scrollHeight:s.scrollHeight}});
  await send('本轮手机消息');receipts.push({width,scenario:'normal',...await measure('本轮手机消息')});
  await page.request.get(origin+'/fixture/stream');await page.waitForTimeout(300);receipts.push({width,scenario:'streaming-deltas',...await measure('本轮手机消息')});
  await page.setViewportSize({width,height:520});await page.waitForTimeout(120);await page.setViewportSize({width,height:844});await page.waitForTimeout(120);receipts.push({width,scenario:'keyboard-resize',...await measure('本轮手机消息')});
  await page.request.get(origin+'/fixture/end');await page.waitForTimeout(100);
  await scroll.evaluate(el=>el.scrollTop=300);await page.evaluate(()=>void window.__PI_ENH_LOAD_EARLIER__());await page.waitForTimeout(100);
  await send('分页期间的新消息');receipts.push({width,scenario:'history-before-response',...await measure('分页期间的新消息')});
  assert.ok(olderPending,'older page must really be pending');await page.request.get(origin+'/fixture/older');await page.waitForTimeout(200);receipts.push({width,scenario:'history-after-response',...await measure('分页期间的新消息')});
  await scroll.evaluate(el=>el.scrollTop=300);await page.waitForTimeout(80);await send('运行中的引导消息');receipts.push({width,scenario:'queued-delivery',...await measure('运行中的引导消息')});
  await send('连续排队的下一条消息');receipts.push({width,scenario:'second-queued-delivery',...await measure('连续排队的下一条消息')});
  if(process.env.SCROLL_ARTIFACT_DIR)await page.screenshot({path:path.join(process.env.SCROLL_ARTIFACT_DIR,`scroll-${width}.png`)});
  await scroll.evaluate(el=>el.scrollTop=600);await page.waitForTimeout(80);await page.request.get(origin+'/fixture/stream');await page.waitForTimeout(300);assert.ok(Math.abs(await scroll.evaluate(el=>el.scrollTop)-600)<2,'batched streaming preserves manual history position');await page.request.get(origin+'/fixture/answer');await page.waitForTimeout(100);assert.ok(Math.abs(await scroll.evaluate(el=>el.scrollTop)-600)<2,'reading history stays under user control');
  await page.close();
 }
 assert.deepEqual(errors,[]);for(const r of receipts)assert.ok(r.offset>=0&&r.offset<100,JSON.stringify(r));console.log(JSON.stringify({status:'passed',receipts,errors,actualServerWrites:0,manualReadingPreserved:true},null,2));
}finally{for(const t of timers)clearTimeout(t);if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
