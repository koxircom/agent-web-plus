import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { chromium } = require('playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const acceptanceDir = path.resolve(root, '..', 'acceptance');

if (!fs.existsSync(acceptanceDir)) {
  fs.mkdirSync(acceptanceDir, { recursive: true });
}

const bundle = await build({
  stdin: {
    resolveDir: root,
    loader: 'tsx',
    contents: `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NewSessionBrandHeader } from './components/NewSessionBrandHeader';
import { I18nProvider } from './hooks/useI18n';

function Fixture() {
  const [engine, setEngine] = useState('codex');
  return (
    <div style={{ padding: 20 }}>
      <button id="switch-to-pi" onClick={() => setEngine('pi')}>Switch to Pi</button>
      <button id="switch-to-codex" onClick={() => setEngine('codex')}>Switch to Codex</button>
      <div id="header-container">
        <NewSessionBrandHeader
          executionEngine={engine}
          appVersion="1.4.0-rc.4"
          piVersion="1.3.0"
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <I18nProvider initialLocale="zh-CN">
    <Fixture />
  </I18nProvider>
);
`,
  },
  bundle: true,
  write: false,
  outfile: 'fixture.js',
  loader: { '.css': 'empty' },
  format: 'iife',
  alias: { '@': root },
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env.NEXT_PUBLIC_APP_VERSION': '"1.4.0-rc.4"',
    'process.env.NEXT_PUBLIC_PI_VERSION': '"1.3.0"',
  },
});

let base;
let browser;
let currentScenario = 'fast-local';
let sequencePhase = 'running';
const errors = [];
const requestLog = [];

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, base);
    const json = (data, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (u.pathname === '/bundle.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(bundle.outputFiles.find((f) => f.path.endsWith('.js')).text);
    }

    if (u.pathname === '/api/codex-update') {
      const isLocalOnly = u.searchParams.get('localOnly') === '1';
      requestLog.push({ url: req.url, isLocalOnly, scenario: currentScenario, timestamp: Date.now() });

      if (currentScenario === 'fast-local') {
        if (isLocalOnly) {
          // 快路由迅速返回真实本地版本
          await new Promise((r) => setTimeout(r, 60));
          return json({
            installedVersion: '0.163.0',
            currentVersion: '0.163.0',
            runningVersion: '0.163.0',
            runtimeStatus: 'running',
            activationState: 'current',
            activationMessage: '当前 CLI 版本已生效',
            latestVersion: null,
            updateAvailable: false,
            releaseUrl: '',
          });
        }
        // 完整更新检查故意延迟，模拟 GitHub 检查耗时
        await new Promise((r) => setTimeout(r, 600));
        return json({
          installedVersion: '0.163.0',
          currentVersion: '0.163.0',
          runningVersion: '0.163.0',
          runtimeStatus: 'running',
          activationState: 'current',
          activationMessage: '当前 CLI 版本已生效',
          latestVersion: '0.164.0',
          updateAvailable: true,
          releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.164.0',
        });
      }

      if (currentScenario === 'github-failure') {
        if (isLocalOnly) {
          // 本地状态读取成功
          return json({
            installedVersion: '0.163.0',
            currentVersion: '0.163.0',
            runningVersion: '0.163.0',
            runtimeStatus: 'running',
            activationState: 'current',
            activationMessage: '当前 CLI 版本已生效',
            latestVersion: null,
            updateAvailable: false,
            releaseUrl: '',
          });
        }
        // 模拟 GitHub 失败或 500
        await new Promise((r) => setTimeout(r, 80));
        return json({ error: 'GitHub API rate limit or network timeout' }, 500);
      }

      if (currentScenario === 'fast-valid-full200-version-error') {
        if (isLocalOnly) {
          // 快路由迅速返回有效本地状态
          await new Promise((r) => setTimeout(r, 40));
          return json({
            installedVersion: '0.163.0',
            currentVersion: '0.163.0',
            runningVersion: '0.163.0',
            runtimeStatus: 'running',
            activationState: 'current',
            activationMessage: '当前 CLI 版本已生效',
            latestVersion: null,
            updateAvailable: false,
            releaseUrl: '',
          });
        }
        // full 请求返回 HTTP 200，但 body connector 读取失败（versionError，installed: null，runtime: unknown）
        await new Promise((r) => setTimeout(r, 200));
        return json({
          installedVersion: null,
          currentVersion: null,
          runningVersion: null,
          runtimeStatus: 'unknown',
          activationState: 'manual',
          activationMessage: 'CLI 激活状态暂不可用',
          versionError: 'Codex CLI 版本暂不可用',
          latestVersion: '0.164.0',
          updateAvailable: false,
          releaseUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.164.0',
        });
      }

      if (currentScenario === 'sequence-flow') {
        if (sequencePhase === 'running') {
          return json({
            installedVersion: '0.163.0',
            currentVersion: '0.163.0',
            runningVersion: '0.163.0',
            runtimeStatus: 'running',
            activationState: 'current',
            activationMessage: '当前 CLI 版本已生效',
            latestVersion: null,
            updateAvailable: false,
            releaseUrl: '',
          });
        }
        if (sequencePhase === 'both-fail') {
          return json({ error: 'Network failure / Connector down' }, 502);
        }
        if (sequencePhase === 'stopped') {
          return json({
            installedVersion: '0.163.0',
            currentVersion: '0.163.0',
            runningVersion: null,
            runtimeStatus: 'stopped',
            activationState: 'manual',
            activationMessage: '未运行',
            latestVersion: null,
            updateAvailable: false,
            releaseUrl: '',
          });
        }
      }

      if (currentScenario === 'all-fail') {
        await new Promise((r) => setTimeout(r, 40));
        return json({ error: 'Connector down' }, 502);
      }

      if (currentScenario === 'pending-check') {
        // 故意延迟返回，用于检验初始 pending 状态
        await new Promise((r) => setTimeout(r, 800));
        return json({
          installedVersion: '0.163.0',
          currentVersion: '0.163.0',
          runningVersion: '0.163.0',
          runtimeStatus: 'running',
          activationState: 'current',
          activationMessage: '当前 CLI 版本已生效',
          latestVersion: null,
          updateAvailable: false,
          releaseUrl: '',
        });
      }
    }

    if (u.pathname === '/api/app-update') {
      return json({
        currentVersion: '1.4.0-rc.4',
        latestVersion: '1.4.0-rc.4',
        updateAvailable: false,
        releaseUrl: '',
      });
    }

    if (u.pathname === '/api/pi-update') {
      return json({
        latestVersion: '1.3.0',
        releaseUrl: 'https://github.com/earendil-works/pi',
      });
    }

    res.setHeader('content-type', 'text/html');
    res.end(
      '<html data-theme="dark"><head><style>:root{--font-mono:monospace;--text:#e0e0e0;--text-muted:#888;--bg-hover:#333;--accent:#4F5AE8;}</style></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'
    );
  } catch (e) {
    errors.push(e.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

const results = {
  status: 'pending',
  timestamp: new Date().toISOString(),
  cases: [],
  pageErrors: [],
  screenshots: [],
};

try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' });
  await context.addInitScript(() => localStorage.setItem('pi-locale', 'zh-CN'));
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));

  // Case 1: 验证初始 pending 显示“正在读取”而非“暂不可用”
  {
    currentScenario = 'pending-check';
    requestLog.length = 0;
    await page.goto(base);
    const cliVersionText = await page.locator('[data-pi-element="codex-cli-version"]').textContent();
    const runningVersionText = await page.locator('[data-pi-element="codex-cli-running-version"]').textContent();

    assert.match(cliVersionText, /正在读取/, 'Pending stage must show 正在读取');
    assert.doesNotMatch(cliVersionText, /版本暂不可用/, 'Pending stage must not show 版本暂不可用');
    assert.match(runningVersionText, /正在读取/, 'Pending runtime stage must show 正在读取');
    assert.doesNotMatch(runningVersionText, /运行状态暂不可用/, 'Pending runtime stage must not show 运行状态暂不可用');

    const screenshotPath = path.join(acceptanceDir, 'codex-status-01-pending.png');
    await page.screenshot({ path: screenshotPath });
    results.screenshots.push(screenshotPath);
    results.cases.push({
      name: 'initial-pending',
      cliVersionText,
      runningVersionText,
      passed: true,
    });
  }

  // Case 2: 验证快路由 localOnly=1 优先展示真实本地版本，随后完整更新无缝承接
  {
    currentScenario = 'fast-local';
    requestLog.length = 0;
    await page.goto(base);

    // 等待快路由返回，本地版本立即呈现（在 600ms 完整请求返回之前）
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-pi-element="codex-cli-version"]');
      return el && el.textContent.includes('v0.163.0');
    }, { timeout: 3000 });

    const localLoadedCliText = await page.locator('[data-pi-element="codex-cli-version"]').textContent();
    const localLoadedRunningText = await page.locator('[data-pi-element="codex-cli-running-version"]').textContent();
    assert.match(localLoadedCliText, /v0\.163\.0/);
    assert.match(localLoadedRunningText, /运行中 v0\.163\.0/);

    const screenshotLocalPath = path.join(acceptanceDir, 'codex-status-02-fast-local.png');
    await page.screenshot({ path: screenshotLocalPath });
    results.screenshots.push(screenshotLocalPath);

    // 随后完整更新请求返回，显示更新链接
    await page.waitForSelector('[data-pi-element="release-notes-link"]', { timeout: 4000 });
    const updateLinkText = await page.locator('[data-pi-element="release-notes-link"]').textContent();
    assert.match(updateLinkText, /v0\.164\.0/);

    const screenshotFullUpdatePath = path.join(acceptanceDir, 'codex-status-03-full-update.png');
    await page.screenshot({ path: screenshotFullUpdatePath });
    results.screenshots.push(screenshotFullUpdatePath);

    const localOnlyCalls = requestLog.filter((r) => r.isLocalOnly).length;
    const fullCalls = requestLog.filter((r) => !r.isLocalOnly).length;
    assert.ok(localOnlyCalls >= 1, 'Must invoke localOnly route');
    assert.ok(fullCalls >= 1, 'Must invoke full update route');

    results.cases.push({
      name: 'fast-local-and-full-update',
      localLoadedCliText,
      localLoadedRunningText,
      updateLinkText,
      localOnlyCalls,
      fullCalls,
      passed: true,
    });
  }

  // Case 3: 验证 GitHub 检查失败/超时时，本地真实版本不被抹除成 unknown
  {
    currentScenario = 'github-failure';
    requestLog.length = 0;
    await page.goto(base);

    // 等待本地版本加载
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-pi-element="codex-cli-version"]');
      return el && el.textContent.includes('v0.163.0');
    }, { timeout: 3000 });

    // 等待随后 GitHub 失败的响应处理
    await page.waitForSelector('[data-pi-element="codex-cli-update-unavailable"]', { timeout: 3000 });

    const preservedCliText = await page.locator('[data-pi-element="codex-cli-version"]').textContent();
    const preservedRunningText = await page.locator('[data-pi-element="codex-cli-running-version"]').textContent();
    const updateUnavailableText = await page.locator('[data-pi-element="codex-cli-update-unavailable"]').textContent();

    assert.match(preservedCliText, /v0\.163\.0/, 'Local version must be preserved when GitHub update fails');
    assert.doesNotMatch(preservedCliText, /版本暂不可用/, 'Local version must not be wiped to unavailable');
    assert.match(preservedRunningText, /运行中 v0\.163\.0/, 'Running version must be preserved');
    assert.match(updateUnavailableText, /更新检查暂不可用/, 'Update status must explicitly report unavailable');

    const screenshotPreservedPath = path.join(acceptanceDir, 'codex-status-04-github-failure-preserved.png');
    await page.screenshot({ path: screenshotPreservedPath });
    results.screenshots.push(screenshotPreservedPath);

    results.cases.push({
      name: 'github-failure-preserves-local-version',
      preservedCliText,
      preservedRunningText,
      updateUnavailableText,
      passed: true,
    });
  }

  // Case 4: 切换 Pi-Codex 引擎验证，Pi 模式正常不回归
  {
    await page.locator('#switch-to-pi').click();
    await page.waitForSelector('[data-pi-element="pi-version"]', { timeout: 3000 });

    const piVersionText = await page.locator('[data-pi-element="pi-version"]').textContent();
    assert.match(piVersionText, /v1\.3\.0/);
    assert.equal(await page.locator('[data-pi-element="codex-cli-version"]').count(), 0);

    const screenshotPiPath = path.join(acceptanceDir, 'codex-status-05-pi-engine.png');
    await page.screenshot({ path: screenshotPiPath });
    results.screenshots.push(screenshotPiPath);

    // 重新切回 Codex
    await page.locator('#switch-to-codex').click();
    await page.waitForSelector('[data-pi-element="codex-cli-version"]', { timeout: 3000 });

    results.cases.push({
      name: 'switch-pi-codex-no-regression',
      piVersionText,
      passed: true,
    });
  }

  // Case 5: 当本地与更新检查均失败时，如实展示 unknown / 暂不可用，不伪造 0.163
  {
    currentScenario = 'all-fail';
    requestLog.length = 0;
    await page.goto(base);

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-pi-element="codex-cli-version"]');
      return el && el.textContent.includes('版本暂不可用');
    }, { timeout: 3000 });

    const failCliText = await page.locator('[data-pi-element="codex-cli-version"]').textContent();
    const failRunningText = await page.locator('[data-pi-element="codex-cli-running-version"]').textContent();
    assert.match(failCliText, /版本暂不可用/);
    assert.doesNotMatch(failCliText, /v0\.163/, 'Must not fabricate 0.163 version on genuine failure');
    assert.match(failRunningText, /运行状态暂不可用/);

    const screenshotAllFailPath = path.join(acceptanceDir, 'codex-status-06-all-fail-unknown.png');
    await page.screenshot({ path: screenshotAllFailPath });
    results.screenshots.push(screenshotAllFailPath);

    results.cases.push({
      name: 'genuine-failure-truthful-unknown',
      failCliText,
      failRunningText,
      passed: true,
    });
  }

  // Case 6: 反例验证：fast有效→随后full200返回空快照/versionError，刚读到的valid快照不得被抹掉
  {
    currentScenario = 'fast-valid-full200-version-error';
    requestLog.length = 0;
    await page.goto(base);

    // 首先等待 fast local 返回并在界面呈现
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-pi-element="codex-cli-version"]');
      return el && el.textContent.includes('v0.163.0');
    }, { timeout: 3000 });

    // 等待随后 full 请求返回（200ms），验证 valid 快照未被抹除，依然展示真实版本和运行中
    await page.waitForTimeout(300);

    const preservedValidCliText = await page.locator('[data-pi-element="codex-cli-version"]').textContent();
    const preservedValidRunningText = await page.locator('[data-pi-element="codex-cli-running-version"]').textContent();

    assert.match(preservedValidCliText, /v0\.163\.0/, 'Valid snapshot from fast local must not be erased by full 200 empty snapshot');
    assert.doesNotMatch(preservedValidCliText, /版本暂不可用/, 'Must not fall back to unavailable');
    assert.doesNotMatch(preservedValidCliText, /上次读取/, 'Freshly read valid local must not be marked stale');
    assert.match(preservedValidRunningText, /运行中 v0\.163\.0/, 'Running status from valid fast local must be preserved');
    assert.doesNotMatch(preservedValidRunningText, /运行状态暂不可用/);

    // 并且 full 请求中带有的新版本更新提示正常呈现
    await page.waitForSelector('[data-pi-element="release-notes-link"]', { timeout: 3000 });
    const updateLinkText = await page.locator('[data-pi-element="release-notes-link"]').textContent();
    assert.match(updateLinkText, /v0\.164\.0/);

    const screenshotCase6Path = path.join(acceptanceDir, 'codex-status-07-fast-valid-full-empty-preserved.png');
    await page.screenshot({ path: screenshotCase6Path });
    results.screenshots.push(screenshotCase6Path);

    results.cases.push({
      name: 'fast-valid-full200-empty-preserved',
      preservedValidCliText,
      preservedValidRunningText,
      updateLinkText,
      passed: true,
    });
  }

  // Case 7: 反例验证：先 running → 随后双失败（保留上次版本作“上次读取”，显式状态读取失败，不声称运行中）→ 随后恢复/stopped（真实更新覆盖旧running）
  {
    currentScenario = 'sequence-flow';
    sequencePhase = 'running';
    requestLog.length = 0;
    await page.goto(base);

    // 阶段 1：先正常运行中
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-pi-element="codex-cli-running-version"]');
      return el && el.textContent.includes('运行中 v0.163.0');
    }, { timeout: 3000 });

    const phase1CliText = await page.locator('[data-pi-element="codex-cli-version"]').textContent();
    const phase1RunningText = await page.locator('[data-pi-element="codex-cli-running-version"]').textContent();
    assert.match(phase1CliText, /v0\.163\.0/);
    assert.match(phase1RunningText, /运行中 v0\.163\.0/);

    const screenshotPhase1Path = path.join(acceptanceDir, 'codex-status-08-seq-01-running.png');
    await page.screenshot({ path: screenshotPhase1Path });
    results.screenshots.push(screenshotPhase1Path);

    // 阶段 2：发生双失败（网络/connector 挂掉）
    sequencePhase = 'both-fail';
    // 派发 visibilitychange 事件触发 refreshCodexStatus
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    // 等待页面更新为双失败状态
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-pi-element="codex-cli-running-version"]');
      return el && el.textContent.includes('状态读取失败');
    }, { timeout: 3000 });

    const phase2CliText = await page.locator('[data-pi-element="codex-cli-version"]').textContent();
    const phase2RunningText = await page.locator('[data-pi-element="codex-cli-running-version"]').textContent();
    const phase2UpdateText = await page.locator('[data-pi-element="codex-cli-update-unavailable"]').textContent();

    assert.match(phase2CliText, /v0\.163\.0（上次读取）/, 'Must keep last-known version with explicit 上次读取 marker');
    assert.match(phase2RunningText, /状态读取失败/, 'Runtime row must explicitly show 状态读取失败');
    assert.doesNotMatch(phase2RunningText, /运行中/, 'Runtime row must NEVER claim running during connection failure');
    assert.match(phase2UpdateText, /更新检查暂不可用/);

    const screenshotPhase2Path = path.join(acceptanceDir, 'codex-status-09-seq-02-both-fail.png');
    await page.screenshot({ path: screenshotPhase2Path });
    results.screenshots.push(screenshotPhase2Path);

    // 阶段 3：恢复但服务 stopped（未运行），必须作为真实更新覆盖旧状态
    sequencePhase = 'stopped';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await page.waitForFunction(() => {
      const el = document.querySelector('[data-pi-element="codex-cli-running-version"]');
      return el && el.textContent.includes('未运行');
    }, { timeout: 3000 });

    const phase3CliText = await page.locator('[data-pi-element="codex-cli-version"]').textContent();
    const phase3RunningText = await page.locator('[data-pi-element="codex-cli-running-version"]').textContent();

    assert.match(phase3CliText, /v0\.163\.0/);
    assert.doesNotMatch(phase3CliText, /上次读取/, 'Fresh stopped update removes stale marker');
    assert.match(phase3RunningText, /未运行/, 'Stopped status is a real update and must overwrite running');

    const screenshotPhase3Path = path.join(acceptanceDir, 'codex-status-10-seq-03-stopped.png');
    await page.screenshot({ path: screenshotPhase3Path });
    results.screenshots.push(screenshotPhase3Path);

    results.cases.push({
      name: 'running-then-both-fail-then-stopped',
      phase1CliText,
      phase1RunningText,
      phase2CliText,
      phase2RunningText,
      phase3CliText,
      phase3RunningText,
      passed: true,
    });
  }

  results.status = 'passed';
  results.pageErrors = errors;
  fs.writeFileSync(path.join(acceptanceDir, 'codex-status-acceptance.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
