import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import{fileURLToPath}from'node:url';
const root=path.resolve(process.env.PI_PERF_SOURCE_ROOT||fileURLToPath(new URL('..',import.meta.url))),load=createRequire(path.join(root,'package.json')),{chromium}=load('playwright');
const dir=path.join(root,'enhancements/modules'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')));
// Observation only inside this isolated fixture, never written into a product bundle.
const bundle=manifest.modules.map(m=>fs.readFileSync(path.join(dir,m.file),'utf8')).join('').replace('function runAllSyncOperations(scopeOrOptions) {','function runAllSyncOperations(scopeOrOptions) { window.syncCounts[scopeOrOptions === "chat-text" ? "text" : "full"]++;');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async r=>{const u=new URL(r.request().url());if(u.pathname.startsWith('/api/'))return r.fulfill({json:{sessions:[],runningSessionIds:[],context:{messages:[],entryIds:[]},state:{},ok:true,revision:1}});return r.fulfill({contentType:'text/html',body:'<html><body><div class="chat-content"><div class="overflow-y-auto"><div id="chat-message-list"><div data-message-role="user">问题</div><div data-message-role="assistant"><div data-message-text="true">回答</div></div></div></div><textarea class="chat-input-textarea"></textarea></div></body></html>'})});
 await page.goto('http://pi-test.local/?session=idle-perf');await page.evaluate(()=>window.syncCounts={full:0,text:0});await page.addScriptTag({content:bundle});await page.waitForTimeout(1500);
 await page.evaluate(()=>window.syncCounts={full:0,text:0});await page.waitForTimeout(11500);const idle=await page.evaluate(()=>({...window.syncCounts}));
 if(!process.env.PI_PERF_BASELINE)assert.equal(idle.full,0,'unchanged page should not trigger full scans');
 await page.evaluate(()=>document.querySelector('[data-message-text]').textContent+='新输出');await page.waitForTimeout(200);const text=await page.evaluate(()=>({...window.syncCounts}));assert.ok(text.text>idle.text,'text replacement still syncs chat scope');
 await page.evaluate(()=>{const b=document.createElement('button');b.textContent='新工具';document.querySelector('.chat-content').append(b)});await page.waitForTimeout(200);const structure=await page.evaluate(()=>({...window.syncCounts}));assert.ok(structure.full>text.full,'structural changes still invalidate full scope');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({idleMs:11500,idle,text,structure,errors,productionRequests:0},null,2));
}finally{await browser.close()}
