// Real useAgentSession interaction hydration with local-only HTTP and event fixtures.
import http from 'node:http';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const load=createRequire(import.meta.url),esbuild=load('esbuild');
const {chromium}=load(process.env.COMPOSER_PLAYWRIGHT_MODULE||'playwright');
const root=fileURLToPath(new URL('..',import.meta.url));
const questionFor=id=>({type:'extension_ui_request',id:`question-${id}`,method:'custom',lines:[],askUser:{toolCallId:`tool-${id}`,question:`隔离确认：${id} 会话请求`,options:[{title:'仅在当前会话处理'},{title:'暂不处理'}]}});
const questions={alpha:questionFor('alpha'),beta:questionFor('beta')};
const sessionData=id=>({id,cwd:'/isolated',name:`fixture-${id}`});
const interactionsReads=[];
const requests=[];
const readWaiters=[];
const pageErrors=[];
const externalRequests=[];
let browser;

function json(res,data){if(res.destroyed||res.writableEnded)return false;res.setHeader('content-type','application/json');res.end(JSON.stringify(data));return true;}
function notifyReadWaiters(){for(let i=readWaiters.length-1;i>=0;i--){const waiter=readWaiters[i];if(interactionsReads.length>=waiter.count){readWaiters.splice(i,1);waiter.resolve();}}}
function waitForReadCount(count){if(interactionsReads.length>=count)return Promise.resolve();return new Promise(resolve=>readWaiters.push({count,resolve}));}
function countReads(id){return interactionsReads.filter(read=>read.sessionId===id).length;}
function deliverRead(read){if(!read||read.res.destroyed||read.res.writableEnded)return false;return json(read.res,{pendingExtensionUiRequests:[questions[read.sessionId]]});}

const bundle=await esbuild.build({stdin:{resolveDir:root,loader:'tsx',contents:`
 import React from 'react';import{createRoot}from'react-dom/client';
 import{useAgentSession}from'./hooks/useAgentSession';import{AskUserSurface}from'./components/AskUserPanel';
 import{I18nProvider}from'./hooks/useI18n';
 function Chat({id,handlerVersion}){
  const h=useAgentSession({session:{id,cwd:'/isolated',name:id},newSessionCwd:null,newSessionDraftKey:null,
   onAttentionNeeded:request=>{const w=window;if(!w.__attentionReceipts)w.__attentionReceipts=[];w.__attentionReceipts.push({sessionId:id,handlerVersion,requestId:request.id});}});
  return <><output data-active-session={id} data-handler-version={handlerVersion}/>
   {h.extensionCustomUi&&<AskUserSurface request={h.extensionCustomUi} waitingCount={h.waitingExtensionCustomUiCount} onInput={h.sendExtensionCustomInput} fallback="native ask-user surface unavailable"/>}
  </>;
 }
 // Match AppShell: one hook instance per session; callback-only renders preserve it.
 function App(){const[id,setId]=React.useState('alpha');const[handlerVersion,setHandlerVersion]=React.useState(0);
  return <><button type="button" onClick={()=>setHandlerVersion(version=>version+1)}>更新注意力回调</button>
   <button type="button" onClick={()=>setId('beta')}>切换到 beta</button>
   <button type="button" onClick={()=>setId('alpha')}>切换到 alpha</button>
   <Chat key={id} id={id} handlerVersion={handlerVersion}/>
  </>;
 }
 createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
 `},bundle:true,write:false,format:'iife',alias:{'@':root},define:{'process.env.NODE_ENV':'"development"'}});

const streams=new Set();
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');
 requests.push({method:req.method,path:url.pathname+url.search});
 if(url.pathname==='/bundle.js'){res.setHeader('content-type','text/javascript');return res.end(bundle.outputFiles[0].text);}
 if(url.pathname.startsWith('/api/agent/')&&url.pathname.endsWith('/events')){
  res.setHeader('content-type','text/event-stream');res.setHeader('cache-control','no-cache');streams.add(res);res.on('close',()=>streams.delete(res));
  res.write('data: '+JSON.stringify({type:'connected',isStreaming:false})+'\n\n');return;
 }
 if(url.pathname.startsWith('/api/agent/')&&url.searchParams.get('interactions')==='1'){
  const sessionId=decodeURIComponent(url.pathname.split('/').at(-1));
  interactionsReads.push({sessionId,res,closed:false});
  const read=interactionsReads.at(-1);res.on('close',()=>{read.closed=true;});notifyReadWaiters();return;
 }
 if(url.pathname.startsWith('/api/sessions/')&&!url.pathname.endsWith('/state')){
  const id=decodeURIComponent(url.pathname.split('/').at(-1));
  return json(res,{sessionId:id,info:sessionData(id),tree:[],leafId:null,totalActiveMs:0,context:{messages:[],entryIds:[],oldestEntryId:null,hasMore:false,thinkingLevel:'off',model:null}});
 }
 if(url.pathname.startsWith('/api/sessions/')&&url.pathname.endsWith('/state'))return json(res,{running:false,state:{isStreaming:false,isPromptRunning:false,queuedMessages:{steering:[],followUp:[]}}});
 if(url.pathname==='/api/models')return json(res,{models:{},modelList:[],skills:[],running:false,isStreaming:false,pendingExtensionUiRequests:[],data:{},tools:[]});
 if(url.pathname.startsWith('/api/agent/'))return json(res,{running:false,state:{isStreaming:false,isPromptRunning:false},pendingExtensionUiRequests:[]});
 if(url.pathname.startsWith('/api/'))return json(res,{success:true,data:{},models:{},modelList:[],skills:[],running:false,isStreaming:false,pendingExtensionUiRequests:[],data:{},tools:[]});
 res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});

try{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,...(process.env.COMPOSER_CHROMIUM_PATH?{executablePath:process.env.COMPOSER_CHROMIUM_PATH}:{})});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:980,height:820}});
 const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
 page.on('request',request=>{if(new URL(request.url()).origin!==origin)externalRequests.push(request.url());});
 await page.goto(origin);await page.locator('[data-active-session="alpha"]').waitFor({state:'attached'});
 await waitForReadCount(1);
 for(let index=0;index<4;index++)await page.getByRole('button',{name:'更新注意力回调'}).click();
 assert.equal(await page.locator('[data-active-session="alpha"]').getAttribute('data-handler-version'),'4');
 assert.equal(countReads('alpha'),1,'callback-only rerenders do not reread the same session interaction snapshot');

 await page.getByRole('button',{name:'切换到 beta'}).click();
 await page.locator('[data-active-session="beta"]').waitFor({state:'attached'});await waitForReadCount(2);
 assert.equal(countReads('alpha'),1);assert.equal(countReads('beta'),1,'changing session starts exactly one new snapshot read');
 await page.getByRole('button',{name:'更新注意力回调'}).click();
 assert.equal(await page.locator('[data-active-session="beta"]').getAttribute('data-handler-version'),'5');
 const betaRead=interactionsReads.find(read=>read.sessionId==='beta');
 assert.ok(deliverRead(betaRead),'beta snapshot response is delivered by the local fixture');
 await page.locator(`[data-pi-native-ask-owner="${questions.beta.id}"]`).waitFor({state:'visible',timeout:5000});
 assert.equal(await page.getByText(questions.beta.askUser.question,{exact:true}).isVisible(),true,'the pending ask-user request is rendered');
 await page.waitForFunction(()=>window.__attentionReceipts?.some(receipt=>receipt.sessionId==='beta'));
 const callbacksBeforeStale=await page.evaluate(()=>window.__attentionReceipts??[]);
 assert.deepEqual(callbacksBeforeStale,[{sessionId:'beta',handlerVersion:5,requestId:questions.beta.id}], 'snapshot notification uses the latest callback');

 const alphaRead=interactionsReads.find(read=>read.sessionId==='alpha');
 const alphaConnectionClosedBeforeDelivery=alphaRead.closed||alphaRead.res.destroyed;
 const staleReadDelivered=deliverRead(alphaRead);
 await page.waitForTimeout(150);
 assert.equal(countReads('alpha'),1);assert.equal(countReads('beta'),1);
 assert.equal(await page.locator(`[data-pi-native-ask-owner="${questions.beta.id}"]`).isVisible(),true,'late old-session response cannot remove the active session question');
 assert.equal(await page.locator(`[data-pi-native-ask-owner="${questions.alpha.id}"]`).count(),0,'late old-session response cannot contaminate the active session');
 assert.deepEqual(await page.evaluate(()=>window.__attentionReceipts??[]),callbacksBeforeStale,'stale response does not notify an outdated or current session callback');
 assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[],'all browser traffic stays on the isolated HTTP fixture');
 const apiWrites=requests.filter(request=>request.method==='POST');
 assert.deepEqual(apiWrites,[],'the test does not answer questions or submit prompts');
 console.log(JSON.stringify({status:'passed',sessionIds:['alpha','beta'],callbackOnlyRenders:5,interactionReads:{alpha:countReads('alpha'),beta:countReads('beta')},pendingAskUserVisible:true,latestAttentionCallbackVersion:callbacksBeforeStale[0]?.handlerVersion,oldAlphaResponseDelivered:staleReadDelivered,alphaConnectionClosedBeforeDelivery,oldSessionQuestionVisible:false,apiWrites:apiWrites.length,externalRequests,pageErrors,receipt:interactionsReads.map(read=>({sessionId:read.sessionId,clientConnectionClosed:read.closed}))},null,2));
 await context.close();
}finally{
 if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
