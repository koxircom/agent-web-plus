import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const { chromium } = require(process.env.COMPOSER_PLAYWRIGHT_MODULE || 'playwright');
const { compileSettingsCss } = require('./native-settings-css.cjs');

// 隔离 agentDir 到测试临时目录
const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pw-tab-title-'));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

const {
  readAgentWebSettings,
  writeAgentWebSettings,
  normalizeBrowserTabTitle,
  AGENT_WEB_SETTINGS_FILE,
} = require('../lib/browser-tab-title.ts');

const fixtureSource = `
  import React, { useEffect, useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { I18nProvider } from './hooks/useI18n';
  import { SettingsPanel } from './components/SettingsPanel';
  import { useBrowserTabTitle, setBrowserTabTitle, resetBrowserTabTitle } from './hooks/useBrowserTabTitle';

  function TestApp() {
    const { customTitle, rawTitle, saveTitle, resetTitle } = useBrowserTabTitle();
    const [showSettings, setShowSettings] = useState(true);

    useEffect(() => {
      document.title = customTitle || "Pi Web";
    }, [customTitle]);

    window.fixture = {
      saveTitle,
      resetTitle,
      getRawTitle: () => rawTitle,
      getCustomTitle: () => customTitle,
      setShowSettings,
    };

    return (
      <I18nProvider initialLocale="zh-CN">
        <div id="app-container" style={{ minHeight: "100vh", background: "#121212", color: "#fff" }}>
          <header id="tab-header" style={{ padding: "12px 24px", borderBottom: "1px solid #333" }}>
            <h1 id="page-title" style={{ fontSize: "16px", margin: 0 }}>{customTitle || "Pi Web"}</h1>
          </header>
          <main id="tab-main" style={{ padding: "24px" }}>
            <button id="toggle-settings" onClick={() => setShowSettings((v) => !v)}>
              设置
            </button>
            {showSettings && (
              <SettingsPanel
                cwd="/workspace/odoo"
                sessionId={null}
                initialSection="general"
                onClose={() => setShowSettings(false)}
                onSessionReloaded={() => {}}
                quoteSelectionEnabled={false}
                onQuoteSelectionChange={() => {}}
              />
            )}
          </main>
        </div>
      </I18nProvider>
    );
  }

  createRoot(document.getElementById('root')).render(<TestApp />);
`;

const bundle = await esbuild.build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: fixtureSource,
  },
  bundle: true,
  write: false,
  format: 'iife',
  alias: { '@': root },
  loader: { '.css': 'empty' },
  plugins: [
    {
      name: 'css-stub',
      setup(b) {
        b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: 'css-stub' }));
        b.onLoad({ filter: /.*/, namespace: 'css-stub' }, () => ({ contents: 'export default {};', loader: 'js' }));
      },
    },
  ],
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env.NEXT_PUBLIC_APP_VERSION': '"1.4.46"',
    'process.env.NEXT_PUBLIC_PI_VERSION': '"1.4.0"',
  },
});

const css = (await compileSettingsCss()) + '\n' + fs.readFileSync(path.join(root, 'app/enhancements.css'), 'utf8');

const errors = [];
const sseClients = new Set();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/bundle.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(bundle.outputFiles[0].text);
  }

  if (url.pathname === '/style.css') {
    res.setHeader('content-type', 'text/css');
    return res.end(css);
  }

  if (url.pathname === '/api/web-auth') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ enabled: false }));
  }

  if (url.pathname === '/api/tools/settings') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ isWindows: false, powerShellEnabled: false }));
  }

  // 1. GET /api/ui-settings/browser-title (readonly, no init, no-cache)
  if (url.pathname === '/api/ui-settings/browser-title' && req.method === 'GET') {
    try {
      const { settings } = await readAgentWebSettings(testAgentDir);
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      return res.end(
        JSON.stringify({
          version: settings.version,
          revision: settings.revision,
          title: settings.title,
          customTitle: normalizeBrowserTabTitle(settings.title),
        })
      );
    } catch {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: 'Failed to read settings' }));
    }
  }

  // 2. PUT /api/ui-settings/browser-title (optimistic concurrency, atomic write)
  if (url.pathname === '/api/ui-settings/browser-title' && req.method === 'PUT') {
    let bodyText = '';
    req.on('data', (chunk) => { bodyText += chunk; });
    req.on('end', async () => {
      try {
        const body = JSON.parse(bodyText);
        const updated = await writeAgentWebSettings(
          { title: body.title, revision: body.revision },
          testAgentDir
        );

        // 通知所有 SSE 客户端
        const payload = JSON.stringify({
          version: updated.version,
          revision: updated.revision,
          title: updated.title,
          customTitle: normalizeBrowserTabTitle(updated.title),
        });
        for (const client of sseClients) {
          try {
            client.write(`data: ${payload}\n\n`);
          } catch {}
        }

        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            success: true,
            version: updated.version,
            revision: updated.revision,
            title: updated.title,
            customTitle: normalizeBrowserTabTitle(updated.title),
          })
        );
      } catch (err) {
        if (err.name === 'SettingsConflictError') {
          res.statusCode = 409;
          return res.end(JSON.stringify({ error: 'Conflict: revision mismatch' }));
        }
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // 3. GET /api/ui-settings/browser-title/events (SSE)
  if (url.pathname === '/api/ui-settings/browser-title/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });

    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });

    // 立即推送当前 snapshot
    try {
      const { settings } = await readAgentWebSettings(testAgentDir);
      const payload = JSON.stringify({
        version: settings.version,
        revision: settings.revision,
        title: settings.title,
        customTitle: normalizeBrowserTabTitle(settings.title),
      });
      res.write(`data: ${payload}\n\n`);
    } catch {}
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ success: true, models: {}, modelList: [], tools: [], skills: [], providers: [], config: {} }));
  }

  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pi Web</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
</body>
</html>`);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox'],
  ...(process.env.COMPOSER_CHROMIUM_PATH ? { executablePath: process.env.COMPOSER_CHROMIUM_PATH } : {}),
});

try {
  // 创建两个独立 BrowserContext，证明没有任何 localStorage / storageEvent 耦合
  const context1 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const context2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const page1 = await context1.newPage();
  const page2 = await context2.newPage();

  page1.on('pageerror', (err) => errors.push(`[page1 error] ${err.message}`));
  page2.on('pageerror', (err) => errors.push(`[page2 error] ${err.message}`));

  await page1.goto(origin);
  await page2.goto(origin);

  await page1.waitForSelector('#settings-browser-tab-title');
  await page2.waitForSelector('#settings-browser-tab-title');

  // --- 验证 1: 初始状态 (两者均为默认标题) ---
  assert.equal(await page1.title(), 'Pi Web');
  assert.equal(await page2.title(), 'Pi Web');

  // --- 验证 2: Context 1 修改标题并显式点击保存 -> Context 2 经 SSE 自动实时同步 ---
  const input1 = page1.locator('#settings-browser-tab-title');
  const saveBtn1 = page1.locator('.settings-browser-tab-title-save');

  await input1.fill('Server Instance Title Alpha');
  assert.equal(await saveBtn1.isDisabled(), false);
  await saveBtn1.click();

  // 等待提交成功并反馈
  await page1.waitForFunction(() => document.title === 'Server Instance Title Alpha');
  assert.equal(await page1.title(), 'Server Instance Title Alpha');

  // 独立 Context 2 (跨不同 browser profile) 必须经 SSE 自动更新
  await page2.waitForFunction(() => document.title === 'Server Instance Title Alpha');
  assert.equal(await page2.title(), 'Server Instance Title Alpha');
  const input2 = page2.locator('#settings-browser-tab-title');
  assert.equal(await input2.inputValue(), 'Server Instance Title Alpha');

  // --- 验证 3: localStorage.clear() / sessionStorage.clear() 完全不影响标题 ---
  await page1.evaluate(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });
  await page1.waitForTimeout(100);
  assert.equal(await page1.title(), 'Server Instance Title Alpha', '清空本地 storage 绝不得影响 server 端权威标题');
  assert.equal(await page2.title(), 'Server Instance Title Alpha');

  // --- 验证 4: Emoji 与 80 Unicode Codepoints 截断与首尾空格 trim 校验 ---
  const emojis85 = '🚀'.repeat(85);
  await input1.fill(emojis85);
  await saveBtn1.click();

  await page1.waitForFunction(() => document.title.includes('🚀'));
  assert.equal(Array.from(await page1.title()).length, 80);
  await page2.waitForFunction(() => document.title.includes('🚀'));
  assert.equal(Array.from(await page2.title()).length, 80);

  // --- 验证 5: 重置按钮 -> 恢复为默认标题 ---
  const resetBtn1 = page1.locator('.settings-browser-tab-title-row .settings-chat-reset');
  assert.equal(await resetBtn1.isDisabled(), false);
  await resetBtn1.click();

  await page1.waitForFunction(() => document.title === 'Pi Web');
  assert.equal(await page1.title(), 'Pi Web');
  assert.equal(await input1.inputValue(), '');

  await page2.waitForFunction(() => document.title === 'Pi Web');
  assert.equal(await page2.title(), 'Pi Web');

  // --- 验证 6: 新开独立 Context 3 读取 Server 端持久化状态 ---
  const context3 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page3 = await context3.newPage();
  await page3.goto(origin);
  await page3.waitForSelector('#settings-browser-tab-title');
  assert.equal(await page3.title(), 'Pi Web');
  await context3.close();

  // --- 验证 7: UI 几何空间拓扑与 Siblings 边界无重叠断言 (桌面与移动视口) ---
  for (const isMobile of [false, true]) {
    const checkPage = await context1.newPage();
    if (isMobile) {
      await checkPage.setViewportSize({ width: 390, height: 844 });
    } else {
      await checkPage.setViewportSize({ width: 1280, height: 900 });
    }
    await checkPage.goto(origin);
    await checkPage.waitForSelector('.settings-browser-tab-title-row');

    const row = checkPage.locator('.settings-browser-tab-title-row');
    const rowBox = await row.boundingBox();
    assert.ok(rowBox && rowBox.width > 0 && rowBox.height > 0);

    // 检查前一个相邻 sibling
    const prevSibling = checkPage.locator('.settings-browser-tab-title-row').locator('xpath=preceding-sibling::div[1]');
    if (await prevSibling.count() > 0) {
      const prevBox = await prevSibling.boundingBox();
      if (prevBox) {
        assert.ok(
          rowBox.y >= prevBox.y + prevBox.height - 1,
          `[${isMobile ? 'Mobile' : 'Desktop'}] 标签标题行 (y=${rowBox.y}) 必须在上一行 (bottom=${prevBox.y + prevBox.height}) 下方，无负数重叠`
        );
      }
    }

    // 检查行内 input 与 按钮 的几何关系
    const inputEl = row.locator('input');
    const saveEl = row.locator('.settings-browser-tab-title-save');
    const inBox = await inputEl.boundingBox();
    const btnBox = await saveEl.boundingBox();
    assert.ok(inBox && btnBox);
    assert.ok(btnBox.x >= inBox.x + inBox.width - 5, 'save 按钮必须与输入框横向并排无重叠挤压');

    await checkPage.close();
  }

  // --- 验证 8: 零未捕获异常 ---
  assert.equal(errors.length, 0, `页面存在控制台异常: ${errors.join(', ')}`);
  console.log('✔ Browser full test passed: 2 independent contexts synced via server SSE, no local storage leak, 80 codepoints, UI topology non-overlap');
} finally {
  await browser.close();
  server.close();
  try {
    fs.rmSync(testAgentDir, { recursive: true, force: true });
  } catch {}
}
