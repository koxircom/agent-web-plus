// Playwright end-to-end browser verification for Codex first model flow:
// Mounts real useAgentSession + native ChatWindow/ChatInput at mobile (390x844) & desktop (1280x800).
// Uses a real Node HTTP fixture calling createCodexSession at /api/agent/new
// and getCodexRuntime(id).send at /api/agent/:id.
// Downstream mock is an isolated Bridge HTTP server fixture.
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const fullPage = process.env.FIRST_MODEL_FULL_PAGE === '1';
let nextProcess, nextLog='';
const load = createRequire(import.meta.url);
const esbuild = load("esbuild");
const { chromium } = load(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");
const root = process.env.FIRST_MODEL_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));

const tempAgentDir = mkdtempSync(join(tmpdir(), "codex-first-model-pw-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;

const jiti = createJiti(import.meta.url, { alias: { "server-only": "next/dist/compiled/server-only/empty.js" } });

// 1. Downstream Bridge HTTP Server fixture
const sessionModels = new Map();
const sessionEfforts = new Map();
const sentPrompts = [];
const bridgeCalls = [];
let sessionCreationGate = null;
let rejectSelectedModel = false;
const caseResults = [], httpIssues = [];
const output = process.env.FIRST_MODEL_EVIDENCE_DIR || fileURLToPath(new URL('../../acceptance', import.meta.url));
mkdirSync(output, {recursive:true});

const bridgeServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  let body;
  if (req.method === "POST" || req.method === "PUT") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (raw) {
      try { body = JSON.parse(raw); } catch { body = raw; }
    }
  }
  bridgeCalls.push({ method: req.method, pathname, body });

  if (pathname === "/api/login") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/auth") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authenticated: true, csrf: "csrf-test" }));
    return;
  }

  if (pathname === "/api/projects") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      projects: [{ key: "work", name: "Work", cwd: "/home/koxir/Work" }]
    }));
    return;
  }

  if (pathname.startsWith("/api/projects/catalog")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      models: [
        { id: "gpt-6.1-sol", name: "GPT 6.1 Sol", isDefault: true, efforts: ["low", "medium", "high"] },
        { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", isDefault: false, efforts: ["low", "medium", "high"] }
      ]
    }));
    return;
  }

  if (pathname === "/api/sessions" && req.method === "POST") {
    if (sessionCreationGate) {
      await sessionCreationGate;
    }
    const threadId = crypto.randomUUID();
    // Native initial state: 5.6-luna, medium effort
    sessionModels.set(threadId, "gpt-5.6-luna");
    sessionEfforts.set(threadId, "medium");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: threadId }));
    return;
  }

  if (pathname.includes("/settings") && req.method === "POST") {
    const match = pathname.match(/\/api\/sessions\/([^/?]+)\/settings/);
    const threadId = match ? match[1] : "unknown";
    if (rejectSelectedModel && body?.model === 'gpt-5.6-luna') {
      res.writeHead(409, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'Fixture native model selection rejected'}));
      return;
    }
    if (body?.model) sessionModels.set(threadId, body.model);
    if (body?.effort) sessionEfforts.set(threadId, body.effort);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: threadId,
      title: "新聊天",
      model: sessionModels.get(threadId),
      effort: sessionEfforts.get(threadId),
    }));
    return;
  }

  if (pathname.includes("/send") && req.method === "POST") {
    const match = pathname.match(/\/api\/sessions\/([^/?]+)\/send/);
    const threadId = match ? match[1] : "unknown";
    sentPrompts.push({
      threadId,
      id: body?.id,
      text: body?.text,
      model: sessionModels.get(threadId),
      effort: sessionEfforts.get(threadId),
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "accepted",
      id: body?.id,
      nativeQueueConfirmed: true,
      nativeQueueId: "nq-" + body?.id,
    }));
    return;
  }

  if (pathname.includes("/timeline")) {
    const match = pathname.match(/\/api\/sessions\/([^/?]+)\/timeline/);
    const threadId = match ? match[1] : "unknown";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      epoch: "1",
      sequence: 1,
      rows: [],
      meta: {
        id: threadId,
        title: "新聊天",
        model: sessionModels.get(threadId) || "gpt-5.6-luna",
        effort: sessionEfforts.get(threadId) || "medium",
        submissions: [],
        rows: []
      }
    }));
    return;
  }

  if (pathname.includes("/changes")) {
    const match = pathname.match(/\/api\/sessions\/([^/?]+)\/changes/);
    const threadId = match ? match[1] : "unknown";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      epoch: "1",
      sequence: 1,
      rows: [],
      meta: {
        id: threadId,
        title: "新聊天",
        model: sessionModels.get(threadId) || "gpt-5.6-luna",
        effort: sessionEfforts.get(threadId) || "medium",
        submissions: [],
        rows: []
      }
    }));
    return;
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
});

await new Promise((resolve) => bridgeServer.listen(0, resolve));
const bridgePort = bridgeServer.address().port;
const bridgeUrl = `http://127.0.0.1:${bridgePort}`;

// Configure Pi execution engine settings pointing to our Bridge fixture
const settingsModule = await jiti.import(join(root, 'lib/execution-engine-settings.ts'));
await settingsModule.saveExecutionEngineSettings({
  codex: { enabled: true, url: bridgeUrl },
  defaultEngine: "codex"
});

// Import real codex engine functions backed by the bridge fixture
const { createCodexSession, getCodexRuntime, codexModels } = await jiti.import(join(root, 'lib/execution-engines/codex-engine.ts'));

// 2. Build React bundle with esbuild
const cssStubPlugin = {
  name: "css-stub",
  setup(b) {
    b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "css-stub" }));
    b.onLoad({ filter: /.*/, namespace: "css-stub" }, () => ({ contents: "export default {};", loader: "js" }));
  },
};

const bundle = await esbuild.build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
      import React, { useRef } from "react";
      import { createRoot } from "react-dom/client";
      import { I18nProvider } from "./hooks/useI18n";
      import { ChatWindow } from "./components/ChatWindow";

      function App() {
        const chatInputRef = useRef(null);
        return (
          <I18nProvider>
            <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
              <ChatWindow
                chatInputRef={chatInputRef}
                session={null}
                executionEngine="codex"
                newSessionCwd="/home/koxir/Work"
                newSessionDraftKey="test-draft-new"
              />
            </div>
          </I18nProvider>
        );
      }

      const container = document.getElementById("root");
      const root = createRoot(container);
      root.render(<App />);
    `,
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  plugins: [cssStubPlugin],
  loader: {
    ".woff": "empty",
    ".woff2": "empty",
    ".ttf": "empty",
    ".svg": "text",
  },
  define: { "process.env.NODE_ENV": '"test"' },
  alias: { "server-only": "next/dist/compiled/server-only/empty.js" },
});

// 3. Web App Server
const unknownRoutes = [];
const activeSseConnections = new Set();

const appServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (pathname === "/bundle.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(bundle.outputFiles[0].text);
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Codex First Model Playwright Test</title>
  <script>
    window.process = { env: { NODE_ENV: "test" } };
  </script>
</head>
<body style="margin: 0; padding: 0; overflow: hidden;">
  <div id="root"></div>
  <script type="module" src="/bundle.js"></script>
</body>
</html>`);
    return;
  }

  // Real Next.js route: /api/models
  if (pathname === "/api/models") {
    const cwd = url.searchParams.get("cwd") || undefined;
    try {
      const catalog = await codexModels(cwd);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(catalog));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  // Real Next.js route: /api/agent/new -> calls real createCodexSession
  if (pathname === "/api/agent/new" && req.method === "POST") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    try {
      const result = await createCodexSession(body.cwd || "/home/koxir/Work", body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // Real Next.js route: /api/agent/:id (POST send command / prompt)
  if (pathname.startsWith("/api/agent/") && !pathname.endsWith("/events") && !pathname.endsWith("/lease") && req.method === "POST") {
    const encodedId = pathname.replace(/^\/api\/agent\//, "");
    const id = decodeURIComponent(encodedId);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    try {
      const runtime = await getCodexRuntime(id);
      const result = await runtime.send(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: result }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // Real Next.js route: /api/agent/:id (GET prompt receipt / status)
  if (pathname.startsWith("/api/agent/") && !pathname.endsWith("/events") && !pathname.endsWith("/lease") && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "accepted" }));
    return;
  }

  // SSE event stream: /api/agent/:id/events
  if (pathname.startsWith("/api/agent/") && pathname.endsWith("/events")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });
    res.write(": keep-alive\n\n");
    activeSseConnections.add(res);
    req.on("close", () => activeSseConnections.delete(res));
    return;
  }

  // Lease route: /api/agent/:id/lease
  if (pathname.startsWith("/api/agent/") && pathname.endsWith("/lease")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ acquired: true }));
    return;
  }

  // Version checks: /api/app-update & /api/codex-update
  if (pathname === "/api/app-update" || pathname === "/api/codex-update") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ updateAvailable: false, currentVersion: "1.4.5" }));
    return;
  }

  // Session state: /api/sessions/:id
  if (pathname.startsWith("/api/sessions/") && !pathname.endsWith("/context")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      sessionId: pathname.replace(/^\/api\/sessions\//, ""),
      context: { messages: [], model: null },
      snapshotRevision: null
    }));
    return;
  }

  // Context: /api/sessions/:id/context
  if (pathname.startsWith("/api/sessions/") && pathname.endsWith("/context")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      messages: [],
      tree: [],
      model: null
    }));
    return;
  }

  // Passive auxiliary queries
  if (["/api/skills", "/api/plugins/check", "/api/mcp", "/api/project-trust"].some((p) => pathname.startsWith(p))) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ skills: [], plugins: [], servers: [], trusted: true }));
    return;
  }

  // Any non-existent or unexpected route must be tracked and fail the test!
  unknownRoutes.push({ method: req.method, pathname });
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Route not found" }));
});

await new Promise((resolve) => appServer.listen(0, resolve));
const appPort = appServer.address().port;
let baseUrl = `http://127.0.0.1:${appPort}`;
const password=crypto.randomUUID();
const browser = await chromium.launch({ headless: true });
async function testPage(options) {
  const page=await browser.newPage(options);
  page.on('response',r=>{if(r.status()>=400)httpIssues.push({url:new URL(r.url()).pathname,status:r.status()});});
  if(fullPage){
    const origin=new URL(baseUrl).origin;
    const token='v1.'+(Math.floor(Date.now()/1000)+3600)+'.'+crypto.randomBytes(16).toString('hex');
    const sig=crypto.createHmac('sha256',password).update('pi-web-session:'+token).digest('hex');
    await page.context().addCookies([{name:'pi_web_session',value:token+'.'+sig,url:origin}]);
    await page.addInitScript(()=>{localStorage.setItem('pi-locale','zh-CN');localStorage.setItem('pi-theme','dark');});
    await page.route('**/*',route=>{
      const u=new URL(route.request().url()),p=u.pathname,json=data=>route.fulfill({json:data});
      if(u.origin!==origin)return route.abort('blockedbyclient');
      if(p==='/api/agent/running')return json({runningSessionIds:[],completionNotificationSuppressedSessionIds:[],sessionListVersion:1});
      // Core creation, settings, prompt, history, SSE and catalog use actual Next routes.
      if(p.startsWith('/api/agent/')||p==='/api/models'||p.startsWith('/api/sessions/'))return route.continue();
      if(!p.startsWith('/api/')){
        if(/^\/pi-.*manifest\.json$/.test(p))return json([]);
        if(p==='/pi-usage-ledger.json')return json({});
        return route.continue();
      }
      if(p==='/api/execution-engines')return route.continue();
      if(p==='/api/execution-engines/check')return json({connected:true,projects:[{cwd:'/home/koxir/Work'}]});
      if(p==='/api/cwd/validate')return json({valid:true,cwd:'/home/koxir/Work',exists:true});
      if(p==='/api/sessions')return json({sessions:[]});
      if(p==='/api/worktrees')return json({isGit:false,projectRoot:'/home/koxir/Work',worktrees:[]});
      if(p.startsWith('/api/files/'))return json({entries:[],path:'/home/koxir/Work'});
      if(p==='/api/git/status')return json({isGitRepository:false,files:[]});
      if(p==='/api/enhancement-state')return route.fulfill({status:200,headers:{'x-pi-enhancement-state':'absent'}});
      return json({success:true,data:{},skills:[],tools:[],models:[],sessions:[],projects:[]});
    });
  }
  return page;
}
try {
  if(fullPage){
    const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
    const origin='http://127.0.0.1:'+port;
    nextProcess=spawn(process.execPath,[load.resolve('next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:root,env:{...process.env,PI_AGENT_DIR:tempAgentDir,PI_CODING_AGENT_DIR:tempAgentDir,PI_WEB_PASSWORD:password,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
    nextProcess.stdout.on('data',x=>nextLog+=x);nextProcess.stderr.on('data',x=>nextLog+=x);
    let ready=false;for(let i=0;i<100;i++){if(nextProcess.exitCode!==null)throw Error(nextLog);try{if((await fetch(origin+'/login')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,200));}assert(ready,nextLog);
    baseUrl=origin+'/?engine=codex&cwd='+encodeURIComponent('/home/koxir/Work');
  }
  // Scenario 1: Desktop Viewport (1280x800)
  {
    const pageErrors = [];
    const page = await testPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (err) => {
      console.error("PAGE ERROR:", err);
      pageErrors.push(err);
    });
    page.on("console", (msg) => console.log("PAGE CONSOLE:", msg.text()));

    await page.goto(baseUrl);

    // Wait until ChatWindow and model display capsule render
    const modelSelector = page.locator(".chat-composer-model-btn, [data-pi-native-thinking-selector]");
    await modelSelector.first().waitFor({ state: "visible", timeout: 10000 });

    // Assert that without dropdown interaction, the displayed model is catalog default 6.1
    await page.waitForFunction(() => {
      const body = document.body.innerText;
      return body.includes("gpt-6.1-sol") || body.includes("GPT 6.1 Sol") || body.includes("6.1");
    }, { timeout: 10000 });

    sentPrompts.length = 0;

    // Type first message into native ChatInput textarea
    const textarea = page.locator("textarea").first();
    await textarea.waitFor({ state: "visible" });
    await textarea.fill("Hello Codex Desktop first turn");

    // Click native send button and await its actual server admission response.
    const admission=page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postDataJSON()?.type==='prompt');
    const sendButton = page.locator("button.chat-composer-send, button[aria-label='发送']").first();
    await sendButton.click();

    // Wait for the prompt to be dispatched downstream
    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll("[data-message-role='user'], .chat-message-user");
      return msgs.length > 0;
    }, { timeout: 10000 });

    // Poll until sentPrompts captures downstream receipt
    const start = Date.now();
    while (sentPrompts.length === 0 && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(pageErrors.length, 0, `Desktop pageErrors 必须为空: ${pageErrors.map(e => e.message).join("; ")}`);
    assert.equal(sentPrompts.length, 1, "Desktop 首发 prompt 必须且只调用一次真实 send");
    assert.equal(sentPrompts[0].text, "Hello Codex Desktop first turn");
    assert.equal(sentPrompts[0].model, "gpt-6.1-sol", "真实 send 时记录的模型必须为 catalog 默认 6.1");
    assert.equal(sentPrompts[0].effort, "high", "真实 send 时记录的 thinking 必须为 high");
    const admitted=await admission;assert(admitted.ok());assert.equal((await admitted.json()).success,true);

    if(fullPage)await page.screenshot({path:join(output,'first-model-full-1280.png'),animations:'disabled'});
    caseResults.push({viewport:1280,scenario:'default-first-turn',sent:[...sentPrompts],pageErrors:pageErrors.map(e=>e.message)});
    await page.close();
    console.log("✅ Playwright Desktop (1280x800) passed: 首次真实发送捕获 6.1 与 high，零 pageErrors");
  }

  // Scenario 2: Mobile Viewport (390x844)
  {
    const pageErrors = [];
    const page = await testPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.on("pageerror", (err) => pageErrors.push(err));

    await page.goto(baseUrl);

    // Wait for mobile render
    const modelSelector = page.locator(".chat-composer-model-btn, [data-pi-native-thinking-selector]");
    await modelSelector.first().waitFor({ state: "visible", timeout: 10000 });

    sentPrompts.length = 0;

    const textarea = page.locator("textarea").first();
    await textarea.waitFor({ state: "visible" });
    await textarea.fill("Hello Codex Mobile first turn");

    const sendButton = page.locator("button.chat-composer-send, button[aria-label='发送']").first();
    const admission=page.waitForResponse(r=>r.request().method()==='POST'&&r.request().postDataJSON()?.type==='prompt');
    await sendButton.click();

    await page.waitForFunction(() => {
      const msgs = document.querySelectorAll("[data-message-role='user'], .chat-message-user");
      return msgs.length > 0;
    }, { timeout: 10000 });

    const start = Date.now();
    while (sentPrompts.length === 0 && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(pageErrors.length, 0, `Mobile pageErrors 必须为空: ${pageErrors.map(e => e.message).join("; ")}`);
    assert.equal(sentPrompts.length, 1, "Mobile 首发 prompt 必须且只调用一次真实 send");
    assert.equal(sentPrompts[0].text, "Hello Codex Mobile first turn");
    assert.equal(sentPrompts[0].model, "gpt-6.1-sol");
    assert.equal(sentPrompts[0].effort, "high");
    const admitted=await admission;assert(admitted.ok());assert.equal((await admitted.json()).success,true);

    if(fullPage){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal viewport overflow');await page.screenshot({path:join(output,'first-model-full-390.png'),animations:'disabled'});}
    caseResults.push({viewport:390,scenario:'default-first-turn',sent:[...sentPrompts],pageErrors:pageErrors.map(e=>e.message)});
    await page.close();
    console.log("✅ Playwright Mobile (390x844) passed: 移动端拓扑正常，真实首发成功，零 pageErrors");
  }

  // Scenario 3: Delayed session creation gate -> user selects 5.6-luna and low -> release gate -> single send uses latest confirmed choice
  {
    const pageErrors = [];
    const page = await testPage({ viewport: { width: 1280, height: 800 } });
    page.on("pageerror", (err) => pageErrors.push(err));

    await page.goto(baseUrl);
    const textarea = page.locator("textarea").first();
    await textarea.waitFor({ state: "visible" });

    // Set up delayed session creation gate
    let releaseGate;
    sessionCreationGate = new Promise((resolve) => { releaseGate = resolve; });

    sentPrompts.length = 0;
    await textarea.fill("Delayed send test message");
    const sendButton = page.locator("button.chat-composer-send, button[aria-label='发送']").first();
    await sendButton.click();

    // While creation is gated and in-flight, select model 5.6 and thinking low
    // 1. Switch model to 5.6-luna
    const modelBtn = page.locator(".chat-composer-model-controls button, .chat-composer-model-btn").first();
    await modelBtn.click();
    const lunaOption = page.locator("button, [role='option']").filter({ hasText: /5\.6/ }).first();
    await lunaOption.waitFor({ state: "visible" });
    await lunaOption.click();

    // 2. Switch thinking to low
    const thinkingBtn = page.locator("[data-pi-native-thinking-selector='true'] button").first();
    await thinkingBtn.click();
    const lowOption = page.locator(".thinking-selector-menu button, [role='option']").filter({ hasText: /low|低/i }).first();
    await lowOption.waitFor({ state: "visible" });
    await lowOption.click();

    // Ensure prompt has NOT been sent yet
    assert.equal(sentPrompts.length, 0, "Gate 挂起期间，绝不能提前发送 prompt");

    // Release gate
    releaseGate();
    sessionCreationGate = null;

    // Wait until prompt is dispatched downstream
    const start = Date.now();
    while (sentPrompts.length === 0 && Date.now() - start < 10000) {
      await new Promise((r) => setTimeout(r, 50));
    }

    assert.equal(pageErrors.length, 0, `Delayed gate pageErrors 必须为空: ${pageErrors.map(e => e.message).join("; ")}`);
    assert.equal(sentPrompts.length, 1, "必须且只发送一次 prompt");
    assert.equal(sentPrompts[0].text, "Delayed send test message");
    assert.equal(sentPrompts[0].model, "gpt-5.6-luna", "延迟创建期间切换的模型必须在首发中确认生效");
    assert.equal(sentPrompts[0].effort, "low", "延迟创建期间切换的思考深度必须在首发中确认生效");

    caseResults.push({viewport:1280,scenario:'selection-during-creation',sent:[...sentPrompts],pageErrors:pageErrors.map(e=>e.message)});
    await page.close();
    console.log("✅ Playwright Scenario 3 passed: 创建被 gate 延迟 -> 选 5.6/low -> 释放 gate -> 唯一 send 确认为 5.6 与 low");
  }

  // A model failure during creation followed by a thinking selection must not
  // overwrite the rejected admission barrier and silently send with 6.1.
  {
    const page=await testPage({viewport:{width:1280,height:800}}), pageErrors=[];
    page.on('pageerror',e=>pageErrors.push(e.message));await page.goto(baseUrl);
    const textarea=page.locator('textarea').first();await textarea.waitFor();
    let release;sessionCreationGate=new Promise(resolve=>{release=resolve;});sentPrompts.length=0;
    await textarea.fill('Must stay as draft after failed selection');
    await page.locator('button.chat-composer-send,button[aria-label="发送"]').first().click();
    await page.locator('.chat-composer-model-controls button,.chat-composer-model-btn').first().click();
    await page.locator('button,[role="option"]').filter({hasText:/5\.6/}).first().click();
    await page.locator('[data-pi-native-thinking-selector="true"] button').first().click();
    await page.locator('.thinking-selector-menu button,[role="option"]').filter({hasText:/low|低/i}).first().click();
    rejectSelectedModel=true;release();sessionCreationGate=null;
    await page.waitForFunction(()=>document.querySelector('textarea')?.value.includes('Must stay as draft after failed selection'));
    assert.equal(sentPrompts.length,0,'Rejected model followed by thinking selection must not release prompt');
    assert.deepEqual(pageErrors,[],'Handled confirmation failure must not become an unhandled browser rejection');
    caseResults.push({viewport:1280,scenario:'failed-selection-preserves-draft',sent:[],pageErrors});
    rejectSelectedModel=false;await page.close();
  }

  // Scenario 5: Verify unknownRoutes is completely empty
  assert.equal(
    unknownRoutes.length,
    0,
    `存在未预期的路由请求 (例如已废弃的 /api/agent/:id/command): ${JSON.stringify(unknownRoutes)}`
  );
  console.log("✅ Playwright verification passed: 不存在任何未预期或错误的端点调用");

  writeFileSync(join(output,fullPage?'FIRST_MODEL_FULL_PAGE.json':'FIRST_MODEL_BROWSER.json'),JSON.stringify({status:'passed',fullPage,cases:caseResults,bridgeCalls,unknownRoutes,httpIssues,productionWrites:0,realModelCalls:0},null,2));
  console.log("All first-model browser assertions passed");
} catch(error) {
  const page=browser.contexts().flatMap(c=>c.pages()).at(-1);
  if(page){await page.screenshot({path:join(output,'first-model-failure.png')});writeFileSync(join(output,'FIRST_MODEL_FAILURE.json'),JSON.stringify({error:error.message,text:await page.locator('body').innerText(),sentPrompts,bridgeCalls},null,2));}
  throw error;
} finally {
  for (const sse of activeSseConnections) {
    try { sse.end(); } catch {}
  }
  await browser.close();
  if(nextProcess&&nextProcess.exitCode===null){nextProcess.kill('SIGTERM');await new Promise(resolve=>nextProcess.once('exit',resolve));}
  if(fullPage)writeFileSync(join(output,'first-model-next.log'),nextLog);
  await new Promise((r) => appServer.close(r));
  await new Promise((r) => bridgeServer.close(r));
  rmSync(tempAgentDir, { recursive: true, force: true });
}
