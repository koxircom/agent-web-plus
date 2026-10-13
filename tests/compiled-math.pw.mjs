// Real Next build + isolated session files: verifies the bundler's lazy JS/CSS contract.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import {createRequire} from 'node:module';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('..',import.meta.url)),load=createRequire(import.meta.url),{chromium}=load('playwright');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'pi-compiled-math-')),agentDir=path.join(scratch,'agent'),cwd=path.join(scratch,'workspace');fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.join(agentDir,'sessions','fixture'),{recursive:true});
const ids=['00000000-0000-7000-8000-000000000001','00000000-0000-7000-8000-000000000002'];
for(let i=0;i<ids.length;i++){
 const text=i?'Inline: $a^2+b^2=c^2$\n\n$$\nE=mc^2\n$$':'Plain compiled entry probe. Code: `$x$`; price: \\$5 USD.';
 const rows=[{type:'session',version:3,id:ids[i],cwd,timestamp:new Date().toISOString()},
 {type:'message',id:'11111111',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:[{type:'text',text:'查看测试内容'}],timestamp:1}},
 {type:'message',id:'22222222',parentId:'11111111',timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'text',text}],model:'gpt-6.1-sol',provider:'openai',api:'openai-responses',stopReason:'stop',timestamp:2,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}},
 {type:'session_info',id:'33333333',parentId:'22222222',name:i?'数学公式验收':'普通消息验收',timestamp:new Date().toISOString()}];
 fs.writeFileSync(path.join(agentDir,'sessions','fixture',`2026-10-11T00-00-00-000Z_${ids[i]}.jsonl`),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
}
const cssFiles=fs.readdirSync(path.join(root,'.next/static/css')).filter(n=>fs.readFileSync(path.join(root,'.next/static/css',n),'utf8').includes('.katex .katex-mathml'));
assert.equal(cssFiles.length,1,'One separate KaTeX stylesheet should exist');
const port=Number(process.env.PI_PERF_NEXT_PORT||31461),origin=`http://127.0.0.1:${port}`;
let serverLog='',browser;const server=spawn(process.execPath,[load.resolve('next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,PI_AGENT_DIR:agentDir,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});server.stdout.on('data',b=>serverLog+=b);server.stderr.on('data',b=>serverLog+=b);
try{
 let ready=false;for(let n=0;n<80;n++){if(server.exitCode!==null)throw Error(serverLog);try{ready=(await fetch(origin+'/login')).ok}catch{}if(ready)break;await new Promise(r=>setTimeout(r,250))}assert.ok(ready,'Isolated Next must start');
 browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1280,height:900},serviceWorkers:'block'});const requests=[],errors=[],blockedWrites=[];
 if(process.env.PI_WEB_PASSWORD){const payload='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');await context.addCookies([{name:'pi_web_session',value:payload+'.'+crypto.createHmac('sha256',process.env.PI_WEB_PASSWORD).update('pi-web-session:'+payload).digest('hex'),url:origin,httpOnly:true,sameSite:'Lax'}]);}
 await context.route('**/*',r=>{const u=new URL(r.request().url());if(u.origin!==origin)return r.fulfill({status:204});if(!['GET','HEAD'].includes(r.request().method())){blockedWrites.push(u.pathname);return r.fulfill({status:403,json:{error:'isolated read-only acceptance'}})}if(u.pathname.endsWith('/events'))return r.fulfill({status:204});return r.continue()});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));
 await page.goto(origin+'/?session='+ids[0],{waitUntil:'domcontentloaded'});await page.getByText('Plain compiled entry probe.',{exact:false}).waitFor({timeout:20000});await page.waitForTimeout(400);
 const katexCssPath='/_next/static/css/'+cssFiles[0];assert.equal(requests.includes(katexCssPath),false,'Actual Next must not preload KaTeX CSS on a plain conversation');
 const initial=requests.length;await page.goto(origin+'/?session='+ids[1],{waitUntil:'domcontentloaded'});await page.locator('.markdown-body .katex-display').waitFor({timeout:20000});
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.markdown-body .katex')).fontFamily.includes('KaTeX_Main'));
 assert.equal(requests.slice(initial).filter(p=>p===katexCssPath).length,1);assert.equal(await page.locator('.markdown-body .katex').count(),2);assert.deepEqual(errors,[]);
 if(process.env.PI_PERF_SCREENSHOT)await page.screenshot({path:process.env.PI_PERF_SCREENSHOT});
 console.log(JSON.stringify({status:'passed',buildId:fs.readFileSync(path.join(root,'.next/BUILD_ID'),'utf8').trim(),initialKatexCssRequests:0,mathKatexCssRequests:1,formulaCount:2,katexCssPath,errors,blockedWrites,productionRequests:0},null,2));
}finally{if(browser)await browser.close();server.kill('SIGTERM');await new Promise(r=>{if(server.exitCode!==null)return r();server.once('exit',r);setTimeout(()=>{server.kill('SIGKILL');r()},2000).unref()});fs.rmSync(scratch,{recursive:true,force:true})}
