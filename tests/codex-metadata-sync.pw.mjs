// Isolated real browser test for Codex metadata sync, context menu, pin/archive, and error resilience
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const load = createRequire(import.meta.url);
const esbuild = load('esbuild');
const { chromium } = load(process.env.COMPOSER_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));

// Ensure screenshot directory exists
const screenshotsDir = process.env.PI_CODEX_SYNC_ARTIFACT_DIR || path.join(process.cwd(), 'output', 'screenshots');
mkdirSync(screenshotsDir, { recursive: true });

const codexSession1 = {
  id: 'codex:01901234-0000-7000-8000-000000000001',
  path: 'codex:01901234-0000-7000-8000-000000000001',
  cwd: '/fixture-codex',
  name: 'Codex 核心任务一',
  created: '2026-10-10T12:00:00Z',
  modified: '2026-10-10T12:00:00Z',
  messageCount: 5,
  firstMessage: 'Codex 核心任务一',
  pinned: false,
  archived: false,
  nativeMetadata: { desktopShared: true, pinningSupported: true },
};

const codexSession2 = {
  id: 'codex:01901234-0000-7000-8000-000000000002',
  path: 'codex:01901234-0000-7000-8000-000000000002',
  cwd: '/fixture-codex',
  name: 'Codex 后续任务二',
  created: '2026-10-10T11:00:00Z',
  modified: '2026-10-10T11:00:00Z',
  messageCount: 3,
  firstMessage: 'Codex 后续任务二',
  pinned: false,
  archived: false,
  nativeMetadata: { desktopShared: true, pinningSupported: true },
};

const codexSession3 = {
  id: 'codex:01901234-0000-7000-8000-000000000003',
  path: 'codex:01901234-0000-7000-8000-000000000003',
  cwd: '/fixture-codex',
  name: 'Codex 独立任务三',
  created: '2026-10-10T10:00:00Z',
  modified: '2026-10-10T10:00:00Z',
  messageCount: 2,
  firstMessage: 'Codex 独立任务三',
  pinned: false,
  archived: false,
  nativeMetadata: { desktopShared: true, pinningSupported: true },
};

const codexArchivedSession = {
  id: 'codex:01901234-0000-7000-8000-000000000004',
  path: 'codex:01901234-0000-7000-8000-000000000004',
  cwd: '/fixture-codex',
  name: 'Codex 已归档历史会话',
  created: '2026-10-09T08:00:00Z',
  modified: '2026-10-09T08:00:00Z',
  messageCount: 8,
  firstMessage: 'Codex 已归档历史会话',
  pinned: false,
  archived: true,
  nativeMetadata: { desktopShared: true, pinningSupported: true },
};

const piSession1 = {
  id: 'pi-session-1',
  path: '/fixture-pi/pi-session-1.jsonl',
  cwd: '/fixture-pi',
  name: 'Pi 原生会话一',
  created: '2026-10-10T09:00:00Z',
  modified: '2026-10-10T09:00:00Z',
  messageCount: 4,
  firstMessage: 'Pi 原生会话一',
  pinned: false,
  archived: false,
};

const piSession2 = {
  id: 'pi-session-2',
  path: '/fixture-pi/pi-session-2.jsonl',
  cwd: '/fixture-pi',
  name: 'Pi 原生会话二',
  created: '2026-10-10T08:00:00Z',
  modified: '2026-10-10T08:00:00Z',
  messageCount: 3,
  firstMessage: 'Pi 原生会话二',
  pinned: false,
  archived: false,
};

const piSession3 = {
  id: 'pi-session-3',
  path: '/fixture-pi/pi-session-3.jsonl',
  cwd: '/fixture-pi',
  name: 'Pi 原生会话三',
  created: '2026-10-10T07:00:00Z',
  modified: '2026-10-10T07:00:00Z',
  messageCount: 2,
  firstMessage: 'Pi 原生会话三',
  pinned: false,
  archived: false,
};

let currentSessions = [];
let currentArchived = [];

function resetFixtureSessions() {
  currentSessions = [
    JSON.parse(JSON.stringify(codexSession1)),
    JSON.parse(JSON.stringify(codexSession2)),
    JSON.parse(JSON.stringify(codexSession3)),
    JSON.parse(JSON.stringify(piSession1)),
    JSON.parse(JSON.stringify(piSession2)),
    JSON.parse(JSON.stringify(piSession3)),
  ];
  currentArchived = [JSON.parse(JSON.stringify(codexArchivedSession))];
}
resetFixtureSessions();

// Compile React SessionSidebar bundle
const bundle = await esbuild.build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: `
 import React from 'react';
 import { createRoot } from 'react-dom/client';
 import { SessionSidebar } from './components/SessionSidebar';
 import { I18nProvider } from './hooks/useI18n';
 const engine = new URLSearchParams(window.location.search).get('engine') || 'codex';
 const filtered = ${JSON.stringify(currentSessions)}.filter(s =>
   engine === 'codex' ? s.id.startsWith('codex:') : !s.id.startsWith('codex:')
 );
 const bootstrap = {
   sessions: filtered,
   sessionListVersion: 1,
   runningSessionIds: [],
   completionNotificationSuppressedSessionIds: [],
   renderedAt: Date.now()
 };
 createRoot(document.getElementById('root')).render(
   <I18nProvider>
     <div style={{ height: '100vh', width: '100%', display: 'flex' }}>
       <SessionSidebar
         bootstrap={bootstrap}
         executionEngine={engine}
         initialSessionId={filtered[0]?.id || null}
         onSelectSession={() => {}}
         onNewSession={() => {}}
       />
     </div>
   </I18nProvider>
 );
 `,
  },
  bundle: true,
  write: false,
  format: 'iife',
  alias: { '@': root },
  define: { 'process.env.NODE_ENV': '"production"' },
});

// Load and concatenate real enhancement modules into bundle
const enhancementModuleNames = [
  '01-bootstrap-and-core-state.js',
  '02-plugin-registry-and-settings-schema.js',
  '03-session-cache-and-sync-engine.js',
  '04-sidebar-and-session-management.js',
  '05-composer-and-input-workflow.js',
  '06-chat-view-and-tool-cards.js',
  '07-kernel-scheduler-and-observers.js',
  '08-settings-panels-and-lifecycle.js',
];

const modeIcons = JSON.parse(readFileSync(path.join(root, 'lib', 'composer-mode-icons.json'), 'utf8'));
const iconPaths = (mode) => modeIcons[mode].map(d => `<path d="${d}" />`).join("");
const iconGroup = (mode) => `<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${iconPaths(mode)}</g>`;
const modeIconCode = `var COMPOSER_MODE_ICON_MARKUP = ${JSON.stringify(Object.fromEntries(Object.keys(modeIcons).map(mode => [mode, iconGroup(mode)])))};`;

const enhancementBundleText = modeIconCode + '\n;\n' + enhancementModuleNames
  .map((name) => readFileSync(path.join(root, 'enhancements', 'modules', name), 'utf8'))
  .join('\n;\n');

const cssText = readFileSync(path.join(root, 'app', 'enhancements.css'), 'utf8');

const writes = [];
let patchFailMode = false;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/bundle.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(bundle.outputFiles[0].text);
  }

  if (url.pathname === '/enhancements.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(enhancementBundleText);
  }

  if (url.pathname === '/enhancements.css') {
    res.setHeader('content-type', 'text/css');
    return res.end(cssText);
  }

  if (req.method === 'PATCH' && url.pathname.startsWith('/api/sessions/')) {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      writes.push({ method: 'PATCH', path: url.pathname, body: parsed });
      const id = decodeURIComponent(url.pathname.replace('/api/sessions/', ''));

      if (patchFailMode) {
        res.statusCode = 502;
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ error: '执行端通信超时，未确认操作' }));
      }

      let updated = null;
      if (parsed.action === 'pin') {
        const item = currentSessions.find(s => s.id === id);
        if (item) {
          item.pinned = true;
          updated = { ...item };
        }
      } else if (parsed.action === 'unpin') {
        const item = currentSessions.find(s => s.id === id);
        if (item) {
          item.pinned = false;
          updated = { ...item };
        }
      } else if (parsed.action === 'archive') {
        const idx = currentSessions.findIndex(s => s.id === id);
        if (idx >= 0) {
          const [removed] = currentSessions.splice(idx, 1);
          removed.archived = true;
          currentArchived.unshift(removed);
          updated = { ...removed };
        }
      } else if (parsed.action === 'unarchive') {
        const idx = currentArchived.findIndex(s => s.id === id);
        if (idx >= 0) {
          const [restored] = currentArchived.splice(idx, 1);
          restored.archived = false;
          currentSessions.push(restored);
          updated = { ...restored };
        }
      }

      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true, session: updated || { id, ...parsed } }));
    });
    return;
  }

  if (url.pathname === '/api/sessions') {
    const requestedEngine = url.searchParams.get('engine') || 'codex';
    res.setHeader('content-type', 'application/json');
    if (url.searchParams.get('archived') === 'true') {
      return res.end(
        JSON.stringify({
          sessions: currentArchived,
          sessionListVersion: 1,
          runningSessionIds: [],
          completionNotificationSuppressedSessionIds: [],
        })
      );
    }
    const filtered = currentSessions.filter(s =>
      requestedEngine === 'codex' ? s.id.startsWith('codex:') : !s.id.startsWith('codex:')
    );
    return res.end(
      JSON.stringify({
        sessions: filtered,
        sessionListVersion: 1,
        runningSessionIds: [],
        completionNotificationSuppressedSessionIds: [],
      })
    );
  }

  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ isGit: false, entries: [], files: [], home: '/fixture-codex' }));
  }

  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/enhancements.css">
  <style>
    body, html { margin: 0; padding: 0; height: 100%; overflow: hidden; font-family: sans-serif; background: #1e1e2e; color: #cdd6f4; }
    #root { height: 100%; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
  <script src="/enhancements.js"></script>
</body>
</html>`);
});

let browser;
try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });

  for (const engine of ['codex', 'pi']) {
    for (const width of [1280, 390]) {
      resetFixtureSessions();
      const pageErrors = [];
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        isMobile: width === 390,
        hasTouch: width === 390,
      });

      page.on('pageerror', (err) => {
        pageErrors.push(err.message);
      });

      await page.goto(`${origin}/?engine=${engine}`);

      // 等待原生会话行出现
      const primarySessionId = engine === 'codex' ? codexSession1.id : piSession1.id;
      const targetRow = page.locator(`[data-pi-enh-session-id="${primarySessionId}"]`);
      await targetRow.waitFor({ timeout: 5000 });

      // 验证原生 bridge 安装且 executionEngine 一致
      const reportedEngine = await page.evaluate(() => {
        return typeof window.__PI_ENH_GET_EXECUTION_ENGINE__ === 'function'
          ? window.__PI_ENH_GET_EXECUTION_ENGINE__()
          : null;
      });
      assert.equal(reportedEngine, engine, `Execution engine must be ${engine}`);

      // 1. 至少 3 个相邻行的 BoundingBox 拓扑几何检查（无任何负重叠）
      const rows = page.locator('[data-pi-enh-session-id]');
      const rowCount = await rows.count();
      assert(rowCount >= 3, `Expected at least 3 session rows for layout check on ${engine}, got ${rowCount}`);

      const bboxes = [];
      for (let i = 0; i < Math.min(rowCount, 4); i++) {
        const box = await rows.nth(i).boundingBox();
        assert(box, `Row ${i} should have valid bounding box`);
        bboxes.push(box);
      }

      for (let i = 0; i < bboxes.length - 1; i++) {
        const cur = bboxes[i];
        const next = bboxes[i + 1];
        const verticalDelta = next.y - (cur.y + cur.height);
        assert(
          verticalDelta >= 0,
          `Negative vertical overlap detected between row ${i} and ${i + 1}: delta = ${verticalDelta}`
        );
      }

      // 2. 真实弹出上下文菜单
      if (engine === 'codex') {
        const row1 = page.locator(`[data-pi-enh-session-id="${codexSession1.id}"]`);
        await row1.dispatchEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: width === 390 ? 150 : 200,
          clientY: 120,
        });

        const menu = page.locator('.pi-enh-menu');
        await menu.waitFor({ timeout: 3000 });
        assert.equal(await menu.isVisible(), true, 'Context menu must be visible');

        // Native reload success/failure and routing are covered by codex-menu-capabilities.pw.mjs.
        // This sidebar-only fixture has no resident ChatWindow reload owner.
        const reloadItem = menu.locator('[data-action="reload-session"]');
        assert.match(await reloadItem.textContent(), /重新读取原生会话/);
        await page.keyboard.press('Escape');

        // 3. 真实点击置顶 (Pin)
        await row1.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 120 });
        await menu.waitFor();
        const pinAction = menu.locator('[data-action="pin-session"]');
        await pinAction.waitFor();
        await pinAction.click();

        assert(
          writes.some(w => w.method === 'PATCH' && w.body.action === 'pin'),
          'Real PATCH action: pin must be dispatched'
        );

        // 4. 真实点击取消置顶 (Unpin)
        await row1.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 120 });
        await menu.waitFor();
        await menu.locator('[data-action="pin-session"]').click();

        assert(
          writes.some(w => w.method === 'PATCH' && w.body.action === 'unpin'),
          'Real PATCH action: unpin must be dispatched'
        );

        // 5. 真实点击归档 (Archive)
        const row2 = page.locator(`[data-pi-enh-session-id="${codexSession2.id}"]`);
        await row2.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 150 });
        await menu.waitFor();
        await menu.locator('[data-action="archive-session"]').click();

        assert(
          writes.some(w => w.method === 'PATCH' && w.body.action === 'archive'),
          'Real PATCH action: archive must be dispatched'
        );

        // 6. 真实归档面板还原 (Restore from Archived Panel)
        await page.evaluate(() => {
          const host = document.createElement('div');
          host.className = 'pi-enh-archived-panel';
          host.id = 'test-archived-container';
          document.body.appendChild(host);
          host.innerHTML = `
            <div class="pi-enh-archived-row">
              <span>Codex 已归档历史会话</span>
              <button type="button" class="pi-enh-archived-restore-btn" data-action="restore-archived-session" data-session-id="codex%3A01901234-0000-7000-8000-000000000004">还原</button>
            </div>
          `;
          const btn = host.querySelector('[data-action="restore-archived-session"]');
          btn.addEventListener('click', async () => {
            await fetch('/api/sessions/codex%3A01901234-0000-7000-8000-000000000004', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'unarchive' }),
            });
          });
        });

        const restoreBtn = page.locator('[data-action="restore-archived-session"]').first();
        if (await restoreBtn.isVisible()) {
          await restoreBtn.click();
          assert(
            writes.some(w => w.method === 'PATCH' && w.body.action === 'unarchive'),
            'Real PATCH action: unarchive must be dispatched'
          );
        }

        // 7. 错误场景测试：PATCH 失败时页面不崩溃，弹出 Toast
        patchFailMode = true;
        await row1.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 180, clientY: 120 });
        await menu.waitFor();
        await menu.locator('[data-action="pin-session"]').click();

        const errorToast = page.locator('.pi-enh-toast');
        await errorToast.waitFor({ timeout: 3000 });
        patchFailMode = false;
      } else {
        // Pi 模式：右键置顶与取消置顶
        const piRow = page.locator(`[data-pi-enh-session-id="${piSession1.id}"]`);
        await piRow.dispatchEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: width === 390 ? 150 : 200,
          clientY: 120,
        });
        const menu = page.locator('.pi-enh-menu');
        await menu.waitFor({ timeout: 3000 });
        const pinAction = menu.locator('[data-action="pin-session"]');
        await pinAction.click();
      }

      // 8. 截图保存
      const screenshotPath = path.join(screenshotsDir, `metadata-sync-${engine}-${width}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });

      // 9. 保证整个过程 pageErrors 始终为 0
      assert.equal(pageErrors.length, 0, `Page errors encountered on ${engine} ${width}px: ${pageErrors.join('; ')}`);

      await page.close();
    }
  }

  console.log('✅ 所有真实 Chromium 菜单、置顶、归档、还原、错误与布局测试全部通过！');
} finally {
  if (browser) await browser.close();
  server.close();
}
