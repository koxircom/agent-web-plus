// Actual ChatWindow surface browser test for Codex user-message "New Session" (fork)
import http from 'node:http';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));

const screenshotsDir = process.env.PI_CODEX_SYNC_ARTIFACT_DIR || path.join(process.cwd(), 'output', 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });

const codexSession = {
  id: 'codex:01901234-0000-7000-8000-000000000001',
  cwd: '/fixture-codex',
  name: 'Codex 真实会话',
  path: 'codex:01901234-0000-7000-8000-000000000001',
  created: new Date().toISOString(),
  modified: new Date().toISOString(),
  messageCount: 3,
  firstMessage: '第一条提问',
};

const model = { provider: 'codex', modelId: 'Codex', id: 'Codex' };

// 上下文：第1条用户消息 forkable: true；第2条用户消息 forkable: false；第3条 assistant
const context = {
  messages: [
    { role: 'user', content: [{ type: 'text', text: '第一条用户提问（可分支）' }], forkable: true, timestamp: Date.now() - 10000 },
    { role: 'assistant', content: [{ type: 'text', text: '首轮回复' }], timestamp: Date.now() - 9000 },
    { role: 'user', content: [{ type: 'text', text: '中途指令（不可分支）' }], forkable: false, timestamp: Date.now() - 8000 },
    { role: 'assistant', content: [{ type: 'text', text: '次轮回复' }], timestamp: Date.now() - 7000 },
  ],
  entryIds: ['u1-key:0', 'a1-key:0', 'u2-key:0', 'a2-key:0'],
  oldestEntryId: null,
  hasMore: false,
  thinkingLevel: 'high',
  model,
};

const forkedSessionEvents = [];

const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: `
 import React from 'react';
 import { createRoot } from 'react-dom/client';
 import { ChatWindow } from './components/ChatWindow';
 import { I18nProvider } from './hooks/useI18n';

 window.__forkedEvents = [];
 function handleForked(newSessionId) {
   window.__forkedEvents.push(newSessionId);
 }

 createRoot(document.getElementById('root')).render(
   <I18nProvider>
     <div style={{ height: '100vh', display: 'flex' }}>
       <ChatWindow
         session={${JSON.stringify(codexSession)}}
         executionEngine="codex"
         newSessionCwd={null}
         newSessionDraftKey={null}
         onSessionForked={handleForked}
       />
     </div>
   </I18nProvider>
 );
 `,
  },
  bundle: true,
  write: false,
  outfile: 'codex-user-message-fork.js',
  loader: { '.css': 'empty' },
  format: 'iife',
  alias: { '@': root },
  define: { 'process.env.NODE_ENV': '"development"' },
});

const receivedCommands = [];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/bundle.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(bundle.outputFiles[0].text);
  }

  // SSE 事件流
  if (url.pathname.includes('/events')) {
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.write(`data: ${JSON.stringify({ type: 'connected', isStreaming: false, pendingExtensionUiIds: [] })}\n\n`);
    return;
  }

  // 会话读取
  if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({
      sessionId: codexSession.id,
      info: codexSession,
      tree: [],
      leafId: null,
      totalActiveMs: 0,
      context,
    }));
  }

  // agent 指令交互
  if (req.method === 'POST' && url.pathname.startsWith('/api/agent/')) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const command = raw ? JSON.parse(raw) : {};
    receivedCommands.push(command);

    if (command.type === 'fork') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        success: true,
        data: {
          newSessionId: 'codex:01901234-child-0000-000000000002',
        },
      }));
    }

    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ success: true, data: { isStreaming: false, model, thinkingLevel: 'high' } }));
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/agent/')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({
      running: false,
      state: {
        isStreaming: false,
        isPromptRunning: false,
        thinkingLevel: 'high',
        model,
        queuedMessages: { steering: [], followUp: [] },
        pendingExtensionUiRequests: [],
      },
    }));
  }

  res.setHeader('content-type', 'text/html');
  res.end(`<!DOCTYPE html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>`);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err));
  await page.goto(`http://127.0.0.1:${port}`);

  // 等待首条用户消息渲染出来
  await page.waitForSelector('text=第一条用户提问（可分支）');

  // hover 到第一条用户消息以展示操作栏
  const firstUserMessage = page.locator('text=第一条用户提问（可分支）');
  await firstUserMessage.hover();

  // 在第一条消息的操作区查找“新会话”按钮
  const forkButton = page.locator('button:has-text("新会话"), button[title*="新会话"], button[title*="New session"]').first();
  await forkButton.waitFor({ state: 'visible', timeout: 5000 });
  assert.ok(await forkButton.isVisible(), '首条用户消息上必须能看到“新会话”按钮');
  await page.screenshot({ path: path.join(screenshotsDir, 'fork-user-message-codex-hover.png'), fullPage: true });

  // 检查第二条消息（不可分支的消息）
  const secondUserMessage = page.locator('text=中途指令（不可分支）');
  await secondUserMessage.hover();
  // 第二条消息所在的父容器内绝不能有能点击的分支按钮
  const secondContainer = page.locator('[data-entry-id="u2-key:0"]');
  const secondForkBtn = secondContainer.locator('button:has-text("新会话"), button[title*="新会话"]');
  assert.equal(await secondForkBtn.count(), 0, '不可分支的消息（steer/非first_user）绝不能暴露“新会话”按钮');

  // 回到第一条消息，真实执行浏览器点击
  await firstUserMessage.hover();
  await forkButton.click();

  // 断言服务端接收到了真实发起的 fork 命令
  await page.waitForFunction(() => window.__forkedEvents && window.__forkedEvents.length > 0, null, { timeout: 5000 });
  const forkedCommands = receivedCommands.filter(c => c.type === 'fork');
  assert.equal(forkedCommands.length, 1, '点击后必须向服务端发送且仅发送一次 fork 命令');
  assert.equal(forkedCommands[0].entryId, 'u1-key:0');
  assert.ok(forkedCommands[0].requestId, 'fork 命令必须携带客户端稳定的 requestId');

  // 断言 onSessionForked 触发了新会话 ID 传递
  const forkedEvents = await page.evaluate(() => window.__forkedEvents);
  assert.deepEqual(forkedEvents, ['codex:01901234-child-0000-000000000002']);

  await page.screenshot({ path: path.join(screenshotsDir, 'fork-user-message-codex-complete.png'), fullPage: true });

  console.log('✅ Playwright 真实浏览器点击与隔离验收通过！');
} finally {
  await browser.close();
  server.close();
}
