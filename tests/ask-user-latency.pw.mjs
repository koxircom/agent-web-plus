import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const load = createRequire(import.meta.url);
const esbuild = load('esbuild');
const { chromium } = load(process.env.COMPOSER_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const question = { type: 'extension_ui_request', id: 'question-a', method: 'custom', lines: [],
  askUser: { toolCallId: 'tool-a', question: '隔离验收：请选择执行范围', options: [{ title: '受限执行' }, { title: '只读分析' }] } };
const json = (res, data) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
const timers = new Set();
const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
const baseline = process.env.ASK_USER_BASELINE === '1';
const requests = [];
let scenario = 'slow-stream';
const bundle = await esbuild.build({
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react';import{createRoot}from'react-dom/client';
    import{useAgentSession}from'./hooks/useAgentSession';import{AskUserSurface}from'./components/AskUserPanel';
    import{I18nProvider}from'./hooks/useI18n';
    function Chat({id}){const h=useAgentSession({session:{id,cwd:'/isolated',name:id},newSessionCwd:null});
      return <><span data-loading={h.loading}>历史加载状态</span>{h.extensionCustomUi&&<AskUserSurface request={h.extensionCustomUi} waitingCount={h.waitingExtensionCustomUiCount} onInput={h.sendExtensionCustomInput} fallback="fallback"/>}</>}
    function App(){const[id,setId]=React.useState('a');return <><button onClick={()=>setId('a')}>会话 A</button><button onClick={()=>setId('b')}>会话 B</button><Chat key={id} id={id}/></>}
    createRoot(document.getElementById('root')).render(<I18nProvider><App/></I18nProvider>);
  ` }, bundle: true, write: false, format: 'iife', alias: { '@': root },
  define: { 'process.env.NODE_ENV': '"development"' },
});
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture'); requests.push({ path: url.pathname + url.search, method: req.method });
  if (url.pathname === '/bundle.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
  if (url.pathname.endsWith('/events')) {
    res.setHeader('content-type', 'text/event-stream');res.write(': ready\n\n');
    const send = data => { if (!res.destroyed) res.write('data: '+JSON.stringify(data)+'\n\n'); };
    const isA = url.pathname.includes('/a/');
    if (scenario === 'stale-snapshot') {
      send({type:'connected',isStreaming:true,pendingExtensionUiIds:[]});
    } else {
      if(scenario==='synthetic-connected')send({type:'connected',isStreaming:false});
      later(() => { send({type:'connected',isStreaming:true,pendingExtensionUiIds:isA?[question.id]:[]});if(isA)send(question); }, 4000);
    }
    return;
  }
  if (url.searchParams.get('interactions') === '1') {
    const pending = url.pathname.endsWith('/a') ? [question] : [];
    return later(() => json(res, { pendingExtensionUiRequests: pending }), scenario === 'stale-snapshot' ? 350 : 25);
  }
  if (url.pathname.startsWith('/api/sessions/') && !url.pathname.endsWith('/state')) {
    return later(() => json(res, { sessionId: url.pathname.split('/').pop(), tree: [], leafId: null, totalActiveMs:0,
      context:{messages:[],entryIds:[],oldestEntryId:null,hasMore:false,thinkingLevel:'off',model:null} }), 6000);
  }
  if (url.pathname.startsWith('/api/')) return json(res, { models: [], skills: [], running: true, state: { isStreaming: true }, data: {} });
  res.setHeader('content-type', 'text/html');res.end('<html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
let browser;
try {
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  browser = await chromium.launch({headless:true,...(process.env.COMPOSER_CHROMIUM_PATH?{executablePath:process.env.COMPOSER_CHROMIUM_PATH}:{})});
  const page = await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const origin='http://127.0.0.1:'+server.address().port;
  const started=performance.now();await page.goto(origin);await page.locator('[data-pi-native-ask-owner]').waitFor();
  const firstMs=Math.round(performance.now()-started);
  console.log(JSON.stringify({firstMs,historyStillLoading:await page.locator('[data-loading]').getAttribute('data-loading')}));
  if(baseline){assert.ok(firstMs>=3800);}
  else{
    assert.ok(firstMs<1000,'question should not wait four seconds for SSE');
    assert.equal(await page.locator('[data-loading]').getAttribute('data-loading'),'true');
    await page.getByText('会话 B',{exact:true}).click();
    assert.equal(await page.locator('[data-pi-native-ask-owner]').count(),0,'never show another session question');
    const switched=performance.now();await page.getByText('会话 A',{exact:true}).click();await page.locator('[data-pi-native-ask-owner]').waitFor();
    const switchMs=Math.round(performance.now()-switched);assert.ok(switchMs<1000);console.log(JSON.stringify({switchMs}));
    await page.waitForTimeout(4200);assert.equal(await page.locator('[data-pi-native-ask-owner]').count(),1,'SSE replay stays deduplicated');
    scenario='synthetic-connected';const syntheticStarted=performance.now();await page.reload();await page.locator('[data-pi-native-ask-owner]').waitFor();
    assert.ok(performance.now()-syntheticStarted<1000,'a dormant connection without a pending-ID snapshot cannot invalidate the live HTTP read');
    assert.equal(await page.getByText(question.askUser.question,{exact:true}).isVisible(),true);
    scenario='stale-snapshot';await page.reload();await page.waitForTimeout(600);
    assert.equal(await page.locator('[data-pi-native-ask-owner]').count(),0,'older HTTP snapshot cannot resurrect a request absent from the SSE snapshot');
  }
  assert.deepEqual(errors,[]);assert.equal(requests.some(r=>r.method==='POST'),false,'fixture performs no answer or model submissions');
  console.log(JSON.stringify({status:'passed',baseline,requests:requests.length}));
}finally{for(const timer of timers)clearTimeout(timer);if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
