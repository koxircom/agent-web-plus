import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';

const root=await mkdtemp(join(tmpdir(),'codex-attention-'));
process.env.PI_CODING_AGENT_DIR=root;
const helper=join(root,'extensions/ask-user-feishu-notify/notify.mjs');
await mkdir(join(root,'extensions/ask-user-feishu-notify'),{recursive:true});
await writeFile(helper, `import fs from 'node:fs';
export function readConfig(path){return JSON.parse(fs.readFileSync(path,'utf8'));}
export function sanitizeBaseUrl(base,id){const u=new URL(base);u.username='';u.password='';u.search='';u.hash='';u.searchParams.set('session',id);return u.href;}
export function generateSign(secret,timestamp){return secret+':'+timestamp;}
export async function sendFeishuNotification(value){
 fs.appendFileSync(process.env.PI_CODING_AGENT_DIR+'/calls.jsonl',JSON.stringify(value)+'\\n');
 if(process.env.CODEX_ATTENTION_TEST_FAIL==='1')throw new Error('timeout');
 return {code:0};
}`);
const config=join(root,'ask-user-feishu-notify.json');
const writeConfig=enabled=>writeFile(config,JSON.stringify({valid:true,enabled,webhookUrl:'https://notification.invalid/fake',secret:'fixture-signing-value',baseUrl:'https://demo.invalid/work?ignored=true'}));
await writeConfig(true);
const jiti=createJiti(import.meta.url,{alias:{'server-only':'next/dist/compiled/server-only/empty.js'}});
const {notifyCodexAttention,flushCodexAttentionNotifications,codexAttentionNotificationsEnabled}=await jiti.import('./codex-attention-notifications.ts');
const {createCodexAttentionMonitor}=await jiti.import('./codex-attention-monitor.ts');
const input={sessionId:'codex:01901234-5678-7000-8000-000000000001',requestId:'async:turn:item',kind:'question',title:'演示会话',question:'请选择方案 token=fixture-private-value'};
const calls=async()=>{try{return (await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};

test('server notification reuses configured helper, sanitizes content, persists one attempt across re-import',async()=>{
 assert.equal(await codexAttentionNotificationsEnabled(),true);
 assert.equal(notifyCodexAttention(input),'queued');
 assert.equal(notifyCodexAttention(input),'queued');
 await flushCodexAttentionNotifications();
 const sent=await calls();assert.equal(sent.length,1);
 assert.equal(sent[0].timeoutMs,5000);
 assert.equal(sent[0].payload.msg_type,'text');
 assert.match(sent[0].payload.content.text,/Codex 有问题需要确认/);
 assert.doesNotMatch(sent[0].payload.content.text,/fixture-private-value|演示会话|请选择方案|ignored=true/);
 assert.equal(new URL(sent[0].payload.content.text.split('\n').at(-1)).searchParams.get('session'),input.sessionId);
 assert.match(sent[0].payload.sign,/^fixture-signing-value:/);
 const fresh=createJiti(import.meta.url,{moduleCache:false,alias:{'server-only':'next/dist/compiled/server-only/empty.js'}});
 const again=await fresh.import('./codex-attention-notifications.ts');again.notifyCodexAttention(input);await again.flushCodexAttentionNotifications();
 assert.equal((await calls()).length,1);
 assert.equal((await stat(join(root,'state/codex-attention-notifications.json'))).mode&0o777,0o600);
});
test('uncertain delivery is recorded and never automatically posted twice; disabled config sends nothing',async()=>{
 const uncertain={...input,requestId:'uncertain'};
 process.env.CODEX_ATTENTION_TEST_FAIL='1';
 notifyCodexAttention(uncertain);await flushCodexAttentionNotifications();
 notifyCodexAttention(uncertain);await flushCodexAttentionNotifications();
 assert.equal((await calls()).length,2);
 delete process.env.CODEX_ATTENTION_TEST_FAIL;
 const ledger=JSON.parse(await readFile(join(root,'state/codex-attention-notifications.json'),'utf8'));
 assert.equal(Object.values(ledger.entries).filter(row=>row.status==='unknown').length,1);
 await writeConfig(false);assert.equal(await codexAttentionNotificationsEnabled(),false);
 notifyCodexAttention({...input,requestId:'disabled'});await flushCodexAttentionNotifications();assert.equal((await calls()).length,2);
 await writeConfig(true);
});
test('server monitor runs without a browser and re-observes pending requests for the durable ledger',async()=>{
 let reads=0,release;
 let snapshot=[{sessionId:input.sessionId,title:'演示',requests:[{id:'idle-question',method:'bridge/requestUserInputAsync',supported:true,params:{questions:[{question:'完成后仍可回答？'}]}}]}];
 const gate=new Promise(resolve=>release=resolve);
 const notices=[];
 const monitor=createCodexAttentionMonitor({enabled:async()=>true,read:async()=>{reads++;if(reads===1)await gate;return snapshot;},notify:notice=>{notices.push(notice);return 'queued';}});
 const first=monitor.tick(),same=monitor.tick();release();await Promise.all([first,same]);
 assert.equal(reads,1);assert.equal(notices.length,1);assert.equal(notices[0].kind,'question');
 await monitor.tick();assert.equal(notices.length,2);
 snapshot=[];await monitor.tick();
 snapshot=[{sessionId:input.sessionId,requests:[{id:'manual',method:'unknown',supported:false,params:{message:'请处理操作'}}]}];
 await monitor.tick();assert.equal(notices.length,3);assert.equal(notices[2].kind,'manual-action');
 await monitor.stop();await monitor.tick();assert.equal(notices.length,3);
});
test('monitor leaves queue-full requests eligible for next observation',async()=>{
 let attempts=0;const monitor=createCodexAttentionMonitor({enabled:async()=>true,read:async()=>[{sessionId:input.sessionId,requests:[{id:'q',supported:false,params:{}}]}],notify:()=>++attempts===1?'queue-full':'queued'});
 await monitor.tick();await monitor.tick();await monitor.tick();assert.equal(attempts,3);await monitor.stop();
});
test('notification owner deduplicates monitor ticks and survives monitor restart with no browser',async()=>{
 const before=(await calls()).length;
 const read=async()=>[{sessionId:input.sessionId,requests:[{id:'background-only',method:'bridge/requestUserInputAsync',supported:true,params:{questions:[{question:'私密内容不应通知出去'}]}}]}];
 const monitor=createCodexAttentionMonitor({enabled:async()=>true,read});
 await monitor.tick();await flushCodexAttentionNotifications();
 await monitor.tick();await flushCodexAttentionNotifications();await monitor.stop();
 const restarted=createCodexAttentionMonitor({enabled:async()=>true,read});
 await restarted.tick();await flushCodexAttentionNotifications();await restarted.stop();
 const sent=await calls();assert.equal(sent.length,before+1);assert.doesNotMatch(sent.at(-1).payload.content.text,/私密内容/);
});
test.after(async()=>{await flushCodexAttentionNotifications();await rm(root,{recursive:true,force:true});});
