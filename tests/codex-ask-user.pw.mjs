import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url,{alias:{'server-only':'next/dist/compiled/server-only/empty.js'}});
const {CodexRuntime}=await jiti.import('../lib/execution-engines/codex-engine.ts');
const meta={id:'01901234-5678-7000-8000-000000000001',status:'idle',cwd:'/fixture',connected:true,requests:[{id:'async:turn:item',method:'bridge/requestUserInputAsync',supported:true,params:{questions:[{id:'exact-question-id',question:'请选择处理方式',options:[{label:'直接处理',description:'推荐方式'},{label:'稍后处理'}]}]}}]};
const runtime=()=>new CodexRuntime('codex:'+meta.id,'fixture',{epoch:'fixture',sequence:1,rows:[],meta});
let current=runtime(),fail=true;const posted=[],piInputs=[];
const output=await build({entryPoints:[resolve('tests/codex-ask-user-fixture.tsx')],bundle:true,write:false,format:'iife',platform:'browser',alias:{'@':resolve('.')},define:{'process.env.NODE_ENV':'"production"'}});
const css=await readFile('app/ask-user.css','utf8');
const html=`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>:root{--bg-panel:#202020;--bg-hover:#292929;--border:#454545;--text:#eeeeee;--text-muted:#bbbbbb;--text-dim:#aaaaaa;--accent:#8baaff}*{box-sizing:border-box}body{background:#171717;color:#eee;margin:0;font-family:system-ui}main{max-width:820px;margin:0 auto;padding:16px}h1{font-size:18px}main>textarea{background:#202020;color:#eee;margin-top:12px;padding:12px;width:100%;height:90px;border:1px solid #454545;border-radius:12px}${css}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
const server=createServer(async(req,res)=>{try{
 if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');res.end(output.outputFiles[0].text);return;}
 if(req.url==='/requests'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(current.pendingRequests()));return;}
 if(req.method==='POST'){
  let raw='';for await(const chunk of req)raw+=chunk;
  if(req.url==='/pi-input'){piInputs.push(JSON.parse(raw));res.end('{}');return;}
  const response=JSON.parse(raw);current.json=async(path,body)=>{posted.push({path,body});if(fail)throw new Error('fixture transport failure');return {status:'accepted'};};
  await current.send({type:'extension_ui_response',...response});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(current.pendingRequests()));return;
 }
 res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
 }catch{res.statusCode=503;res.end('回答未确认送达');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port;
let browser;const errors=[];const evidence=process.env.CODEX_ASK_USER_EVIDENCE;
test('real shared card: mobile choices, failed answer retention, reload restore, native exact-id receipt and Pi compatibility',async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH});
 const context=await browser.newContext({viewport:{width:390,height:844},locale:'zh-CN'});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.getByRole('dialog',{name:'请选择处理方式'}).waitFor();
 assert.equal(await page.getByRole('button',{name:/直接处理/}).getAttribute('aria-pressed'),'true');
 await page.getByRole('button',{name:/稍后处理/}).click();assert.equal(await page.getByRole('button',{name:/稍后处理/}).getAttribute('aria-pressed'),'true');
 await page.getByRole('textbox',{name:'自定义回答'}).fill('手机自定义答案');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('status').filter({hasText:'回答未确认送达'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'自定义回答'}).inputValue(),'手机自定义答案');
 assert.equal(await page.getByRole('dialog').count(),1);assert.equal(current.pendingRequests().length,1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:resolve(evidence,'ask-user-mobile.png'),fullPage:true});}
 await page.reload();await page.getByRole('dialog',{name:'请选择处理方式'}).waitFor();
 // A page reload restores the authoritative pending question, without sending anything.
 assert.equal(posted.length,1);fail=false;
 await page.getByRole('textbox',{name:'自定义回答'}).fill('手机自定义答案');await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('status').filter({hasText:'回答已提交'}).waitFor();
 assert.deepEqual(posted[1].body,{requestId:'async:turn:item',response:{answers:{'exact-question-id':['手机自定义答案']}}});
 assert.equal(current.pendingRequests().length,0);
 current=runtime();await page.goto(url);await page.getByRole('dialog').waitFor();
 await page.getByRole('button',{name:/稍后处理/}).click();await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('status').filter({hasText:'回答已提交'}).waitFor();assert.equal(posted.at(-1).body.response.answers['exact-question-id'][0],'稍后处理');
 await page.goto(url+'/?pi');await page.getByRole('dialog',{name:'Pi 仍使用原提问卡片'}).waitFor();await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('status').filter({hasText:'回答已提交'}).waitFor();assert(piInputs[0].includes('\r'));
 assert.deepEqual(errors,[]);
 if(evidence)await writeFile(resolve(evidence,'BROWSER_ACCEPTANCE.json'),JSON.stringify({status:'passed',environment:'isolated local protocol fixture',viewport:{width:390,height:844},nativeRequestId:'async:turn:item',checks:['options','freeform','failure-retains-draft','reload-restores-request','exact-question-id','Pi-custom-transport','no-horizontal-overflow'],errors},null,2));
});
test.after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
