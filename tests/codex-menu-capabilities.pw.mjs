import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const acceptanceDir = resolve(root, '..', 'acceptance');

// 构建包含最新 04 模块的临时测试 bundle（纯内存，不污染磁盘快照）
const modulesDir = resolve(root, 'enhancements', 'modules');
const files = [
  '01-bootstrap-and-core-state.js',
  '02-plugin-registry-and-settings-schema.js',
  '03-session-cache-and-sync-engine.js',
  '04-sidebar-and-session-management.js',
  '05-composer-and-input-workflow.js',
  '06-chat-view-and-tool-cards.js',
  '07-kernel-scheduler-and-observers.js',
  '08-settings-panels-and-lifecycle.js',
];

const bundleParts = await Promise.all(
  files.map((f) => readFile(resolve(modulesDir, f), 'utf8'))
);
const modeIconPrefix = 'var COMPOSER_MODE_ICON_MARKUP = {"goal":"<g fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"1.7\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><path d=\\"M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0\\" /><path d=\\"M12 7a5 5 0 1 0 5 5\\" /><path d=\\"M13 3.055a9 9 0 1 0 7.941 7.945\\" /><path d=\\"M15 6v3h3l3 -3h-3v-3l-3 3\\" /><path d=\\"M15 9l-3 3\\" /></g>","plan":"<g fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"1.7\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><path d=\\"M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7\\" /><path d=\\"M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3\\" /><path d=\\"M9.7 17l4.6 0\\" /></g>"};\n';
const testBundleSource = `(function(){\n"use strict";\n${modeIconPrefix}\n${bundleParts.join('\n')}\n})();`;

// 测试会话列表定义
const mockSessions = [
  {
    id: 'codex:sess-rollout',
    name: 'Codex 有真实路径会话',
    path: '/root/.codex/sessions/2026-10-21T06-25-00_rollout.jsonl',
    cwd: '/workspace/project-codex',
    executionEngine: 'codex',
  },
  {
    id: 'codex:sess-placeholder',
    name: 'Codex 占位路径会话',
    path: 'codex:sess-placeholder', // placeholder
    cwd: '/workspace/project-codex',
    executionEngine: 'codex',
  },
  {
    id: 'codex:sess-non-resident',
    name: 'Codex 非当前驻留会话',
    path: '/root/.codex/sessions/2026-10-21T07-00-00_other.jsonl',
    cwd: '/workspace/project-codex',
    executionEngine: 'codex',
  },
  {
    id: 'pi-sess-baseline',
    name: 'Pi 原生会话对比基准',
    path: '/root/.pi/agent/sessions/2026-10-21_pi.jsonl',
    cwd: '/workspace/project-pi',
    executionEngine: 'pi',
  },
];

const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Codex Menu Capabilities Test</title>
  <style>
    body { background: #18181b; color: #f4f4f5; font-family: sans-serif; margin: 0; padding: 20px; }
    .sidebar { width: 320px; border-right: 1px solid #27272a; padding: 8px; }
    .pi-enh-session-row-host {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 12px; margin-bottom: 6px; border-radius: 6px; background: #27272a;
      cursor: pointer; user-select: none;
    }
    .pi-enh-session-row-host:hover { background: #3f3f46; }
    .pi-enh-session-overflow {
      background: transparent; border: none; color: #a1a1aa; cursor: pointer; padding: 4px;
    }
    .pi-enh-menu {
      position: fixed; background: #27272a; border: 1px solid #3f3f46; border-radius: 8px;
      padding: 4px; z-index: 99999; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.5); min-width: 200px;
    }
    .pi-enh-menu-item {
      display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 4px;
      font-size: 13px; color: #f4f4f5; cursor: pointer;
    }
    .pi-enh-menu-item:hover { background: #3b82f6; color: #fff; }
    .pi-enh-menu-sep { height: 1px; background: #3f3f46; margin: 4px 0; }
    .pi-enh-toast {
      position: fixed; bottom: 20px; right: 20px; background: #1e293b; color: #f8fafc;
      padding: 8px 16px; border-radius: 6px; border: 1px solid #475569; z-index: 100000;
    }
  </style>
</head>
<body>
  <div class="sidebar">
    <h3>会话列表</h3>
    <div id="session-list">
      <div class="pi-enh-session-row-host" data-pi-enh-session-id="codex:sess-rollout" data-execution-engine="codex">
        <span class="session-name">Codex 有真实路径会话</span>
        <button type="button" class="pi-enh-session-overflow" title="更多操作">⋮</button>
      </div>
      <div class="pi-enh-session-row-host" data-pi-enh-session-id="codex:sess-placeholder" data-execution-engine="codex">
        <span class="session-name">Codex 占位路径会话</span>
        <button type="button" class="pi-enh-session-overflow" title="更多操作">⋮</button>
      </div>
      <div class="pi-enh-session-row-host" data-pi-enh-session-id="codex:sess-non-resident" data-execution-engine="codex">
        <span class="session-name">Codex 非当前驻留会话</span>
        <button type="button" class="pi-enh-session-overflow" title="更多操作">⋮</button>
      </div>
      <div class="pi-enh-session-row-host" data-pi-enh-session-id="pi-sess-baseline" data-execution-engine="pi">
        <span class="session-name">Pi 原生会话对比基准</span>
        <button type="button" class="pi-enh-session-overflow" title="更多操作">⋮</button>
      </div>
    </div>
  </div>

  <script>
    // 模拟测试桥接
    window.testState = {
      copiedClipboardText: null,
      nativeReloadCalls: [],
      nativeReloadShouldFail: false,
      nativeReloadError: null,
      piReloadCalls: [],
      navigatedUrls: [],
    };

    // 拦截 navigator.clipboard.writeText
    if (!navigator.clipboard) navigator.clipboard = {};
    navigator.clipboard.writeText = async function(text) {
      window.testState.copiedClipboardText = text;
      return true;
    };
    navigator.clipboard.readText = async function() {
      return window.testState.copiedClipboardText || "";
    };

    // 拦截 location.assign
    const origAssign = window.location.assign ? window.location.assign.bind(window.location) : null;
    window.location.assign = function(url) {
      window.testState.navigatedUrls.push(url);
    };

    // 模拟 Raw sessions 获取
    window.__PI_ENH_GET_RAW_SESSIONS__ = function() {
      return ${JSON.stringify(mockSessions)};
    };

    // 模拟当前驻留会话（codex:sess-rollout 与 codex:sess-placeholder 是当前，codex:sess-non-resident 不是）
    window.__PI_WEB_GET_RESIDENT_SESSION_DATA__ = function(sid) {
      if (sid === "codex:sess-rollout" || sid === "codex:sess-placeholder") {
        return { sessionId: sid, active: true };
      }
      return null;
    };

    // 模拟原生 reload 会话 API (真实原生为 Promise<void>，返回 undefined)
    window.__PI_WEB_RELOAD_SESSION__ = async function(sid, showLoading, includeState, options) {
      window.testState.nativeReloadCalls.push({ sid, showLoading, includeState, options });
      if (window.testState.nativeReloadShouldFail) {
        if (window.testState.nativeReloadError) throw window.testState.nativeReloadError;
        return false;
      }
      return undefined;
    };

    // 模拟 Pi 原生重载
    window.__PI_ENH_RELOAD_SPECIFIC_SESSION__ = function(sid, notify) {
      window.testState.piReloadCalls.push({ sid, notify });
    };

    // 原生右键触发派发器辅助函数
    window.triggerRowContextMenu = function(sessionId) {
      const session = (${JSON.stringify(mockSessions)}).find(s => s.id === sessionId);
      if (!session) return;
      const row = document.querySelector('[data-pi-enh-session-id="' + sessionId + '"]');
      const rect = row ? row.getBoundingClientRect() : { left: 100, top: 100 };
      const event = new CustomEvent("pi-web:session-row-contextmenu", {
        cancelable: true,
        detail: {
          id: session.id,
          path: session.path,
          cwd: session.cwd,
          name: session.name,
          executionEngine: session.executionEngine,
          clientX: rect.left + 50,
          clientY: rect.top + 10,
          refresh: () => {},
        }
      });
      window.dispatchEvent(event);
    };
  </script>
  <script src="/bundle.js"></script>
</body>
</html>`;

test('Codex 会话右键与溢出菜单能力闭环验收', async () => {
  await mkdir(acceptanceDir, { recursive: true });

  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.end(testBundleSource);
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(htmlContent);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const serverPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();

  const results = {
    testName: 'Codex 会话菜单 Native Rollout 路径复制与原生重读',
    timestamp: new Date().toISOString(),
    scenarios: {},
  };

  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => typeof window.__PI_ENH_TRIGGER_SESSION_INLINE_RENAME__ === 'function');
    await page.waitForSelector('.pi-enh-session-overflow');

    // =========================================================================
    // 场景 1: Codex 会话带真实合法绝对路径 - 右键菜单项文案与复制路径
    // =========================================================================
    await page.evaluate(() => window.triggerRowContextMenu('codex:sess-rollout'));
    await page.waitForSelector('.pi-enh-menu');

    // 检查文案改称为“重新读取原生会话”
    const reloadItem = page.locator('.pi-enh-menu [data-action="reload-session"]');
    assert.equal(await reloadItem.innerText(), '重新读取原生会话');

    // 真实点击“复制会话文件完整路径”
    const copyPathItem = page.locator('.pi-enh-menu [data-action="copy-path"]');
    await copyPathItem.click();

    // 验证剪贴板真实写入了 rollout 绝对路径
    const copiedText1 = await page.evaluate(() => window.testState.copiedClipboardText);
    assert.equal(copiedText1, '/root/.codex/sessions/2026-10-21T06-25-00_rollout.jsonl');

    // 验证 toast
    await page.waitForSelector('.pi-enh-toast');
    const toastText1 = await page.locator('.pi-enh-toast').innerText();
    assert(toastText1.includes('已复制会话文件完整路径'));

    await page.screenshot({ path: resolve(acceptanceDir, '01-codex-menu-copy-valid-path.png') });
    results.scenarios.codexCopyValidPath = {
      passed: true,
      copiedValue: copiedText1,
      toast: toastText1,
      menuTitle: '重新读取原生会话',
    };

    // =========================================================================
    // 场景 2: Codex 会话当前目标 - 重新读取原生会话 (开始语义，绝不假报成功)
    // =========================================================================
    await page.evaluate(() => window.triggerRowContextMenu('codex:sess-rollout'));
    await page.waitForSelector('.pi-enh-menu');

    const reloadMenuItem = page.locator('.pi-enh-menu [data-action="reload-session"]');
    await reloadMenuItem.click();

    await page.waitForFunction(() => window.testState.nativeReloadCalls.length === 1);
    const reloadCall = await page.evaluate(() => window.testState.nativeReloadCalls[0]);
    assert.equal(reloadCall.sid, 'codex:sess-rollout');
    assert.equal(reloadCall.options?.force, true);

    // 验证出现“正在重新读取原生会话...”开始语义
    await page.waitForSelector('.pi-enh-toast:has-text("正在重新读取原生会话...")');
    // 严密断言：原生返回 undefined (Promise<void>) 时，绝对不出现“已重新读取原生会话”的成功宣称
    const falseSuccessCount = await page.locator('.pi-enh-toast:has-text("已重新读取原生会话")').count();
    assert.equal(falseSuccessCount, 0, '绝不能在没有确认成功时妄称已重新读取');

    await page.screenshot({ path: resolve(acceptanceDir, '02-codex-menu-reload-resident-start-semantic.png') });
    results.scenarios.codexReloadResidentStartSemantic = {
      passed: true,
      call: reloadCall,
      noFalseSuccessClaim: true,
    };

    // =========================================================================
    // 场景 3: Codex 会话当前目标 - 失败与错误诚实反馈 (覆盖返回 false 与 rejection)
    // =========================================================================
    // 3a: 原生明确返回 false
    await page.evaluate(() => {
      window.testState.nativeReloadCalls = [];
      window.testState.nativeReloadShouldFail = true;
      window.testState.nativeReloadError = null; // 返回 false
      window.triggerRowContextMenu('codex:sess-rollout');
    });
    await page.waitForSelector('.pi-enh-menu');
    await page.locator('.pi-enh-menu [data-action="reload-session"]').click();
    await page.waitForSelector('.pi-enh-toast:has-text("重新读取原生会话失败")');

    // 3b: 原生发生 rejection
    await page.evaluate(() => {
      window.testState.nativeReloadCalls = [];
      window.testState.nativeReloadShouldFail = true;
      window.testState.nativeReloadError = new Error('Codex 服务连接超时');
      window.triggerRowContextMenu('codex:sess-rollout');
    });
    await page.waitForSelector('.pi-enh-menu');
    await page.locator('.pi-enh-menu [data-action="reload-session"]').click();
    await page.waitForSelector('.pi-enh-toast:has-text("Codex 服务连接超时")');

    await page.screenshot({ path: resolve(acceptanceDir, '03-codex-menu-reload-failure-honest-toast.png') });
    results.scenarios.codexReloadFailureHonestToast = {
      passed: true,
      toastObserved: 'Codex 服务连接超时',
    };

    // 恢复测试状态
    await page.evaluate(() => {
      window.testState.nativeReloadShouldFail = false;
      window.testState.nativeReloadError = null;
    });

    // =========================================================================
    // 场景 4: Codex 会话缺失路径 (placeholder 如 codex:id) - 绝不复制伪值，清楚反馈
    // =========================================================================
    await page.evaluate(() => {
      window.testState.copiedClipboardText = 'PREVIOUS_DATA';
      window.triggerRowContextMenu('codex:sess-placeholder');
    });
    await page.waitForSelector('.pi-enh-menu');

    await page.locator('.pi-enh-menu [data-action="copy-path"]').click();
    // 剪贴板没有被写入 codex:sess-placeholder 伪值
    const copiedText4 = await page.evaluate(() => window.testState.copiedClipboardText);
    assert.notEqual(copiedText4, 'codex:sess-placeholder');
    assert.equal(copiedText4, 'PREVIOUS_DATA'); // 保留原有或未覆盖

    await page.waitForSelector('.pi-enh-toast:has-text("该 Codex 会话暂无本地文件路径")');
    await page.screenshot({ path: resolve(acceptanceDir, '04-codex-menu-placeholder-no-fake-path.png') });
    results.scenarios.codexPlaceholderPath = {
      passed: true,
      noFakeCopied: true,
      feedbackToast: '该 Codex 会话暂无本地文件路径',
    };

    // =========================================================================
    // 场景 5: Codex 会话非当前驻留目标 - 正常 URL 导航，不调用 reload，不合成 click
    // =========================================================================
    await page.evaluate(() => {
      window.testState.nativeReloadCalls = [];
      window.triggerRowContextMenu('codex:sess-non-resident');
    });
    await page.waitForSelector('.pi-enh-menu');

    await Promise.all([
      page.waitForURL((url) => url.searchParams.get('session') === 'codex:sess-non-resident'),
      page.locator('.pi-enh-menu [data-action="reload-session"]').click(),
    ]);

    assert(page.url().includes('session=codex%3Asess-non-resident'));
    await page.waitForFunction(() => typeof window.__PI_ENH_TRIGGER_SESSION_INLINE_RENAME__ === 'function');
    await page.waitForSelector('.pi-enh-session-overflow');

    await page.screenshot({ path: resolve(acceptanceDir, '05-codex-menu-non-resident-navigation.png') });
    results.scenarios.codexNonResidentNavigation = {
      passed: true,
      navigatedUrl: page.url(),
      noIllegalReload: true,
    };

    // =========================================================================
    // 场景 6: 溢出菜单 (三点菜单) 使用同一真实能力逻辑
    // =========================================================================
    const overflowBtn = page.locator('[data-pi-enh-session-id="codex:sess-rollout"] .pi-enh-session-overflow');
    await overflowBtn.click();
    await page.waitForSelector('.pi-enh-session-menu');

    const overflowReloadItem = page.locator('.pi-enh-session-menu [data-session-action="reload"]');
    assert.equal(await overflowReloadItem.innerText(), '重新读取原生会话');

    await page.evaluate(() => { window.testState.nativeReloadCalls = []; });
    await overflowReloadItem.click();

    await page.waitForFunction(() => window.testState.nativeReloadCalls.length === 1);
    const overflowCall = await page.evaluate(() => window.testState.nativeReloadCalls[0]);
    assert.equal(overflowCall.sid, 'codex:sess-rollout');
    assert.equal(overflowCall.options?.force, true);

    await page.waitForSelector('.pi-enh-toast:has-text("正在重新读取原生会话...")');
    const overflowFalseSuccessCount = await page.locator('.pi-enh-toast:has-text("已重新读取原生会话")').count();
    assert.equal(overflowFalseSuccessCount, 0, '溢出菜单重读亦绝不能假报成功');
    await page.screenshot({ path: resolve(acceptanceDir, '06-codex-overflow-menu-capabilities.png') });
    results.scenarios.codexOverflowMenu = {
      passed: true,
      menuTitle: '重新读取原生会话',
      call: overflowCall,
    };

    // =========================================================================
    // 场景 7: Pi 原生会话保留原有从磁盘重载行为与文案
    // =========================================================================
    await page.evaluate(() => {
      window.testState.piReloadCalls = [];
      window.__PI_ENH_RELOAD_SPECIFIC_SESSION__ = function(sid, notify) {
        window.testState.piReloadCalls.push({ sid, notify });
      };
      window.triggerRowContextMenu('pi-sess-baseline');
    });
    await page.waitForSelector('.pi-enh-menu');

    const piReloadItem = page.locator('.pi-enh-menu [data-action="reload-session"]');
    assert.equal(await piReloadItem.innerText(), '从磁盘重载 (Alt+R)');

    await piReloadItem.click();

    const piCalls = await page.evaluate(() => window.testState.piReloadCalls);
    assert.equal(piCalls.length, 1);
    assert.equal(piCalls[0].sid, 'pi-sess-baseline');

    // 检查 Pi 会话的溢出菜单
    const piOverflowBtn = page.locator('[data-pi-enh-session-id="pi-sess-baseline"] .pi-enh-session-overflow');
    await piOverflowBtn.click();
    await page.waitForSelector('.pi-enh-session-menu');
    const piOverflowReload = page.locator('.pi-enh-session-menu [data-session-action="reload"]');
    assert.equal(await piOverflowReload.innerText(), '从磁盘重载 (Alt+R)');

    await page.screenshot({ path: resolve(acceptanceDir, '07-pi-baseline-preserved.png') });
    results.scenarios.piBaselinePreserved = {
      passed: true,
      menuTitle: '从磁盘重载 (Alt+R)',
      piReloadCalled: true,
    };

    // =========================================================================
    // 场景 8 (关键反例): 当前页面全局引擎为 Codex，但目标为 Pi 会话时，明确不能误判为 Codex
    // =========================================================================
    await page.evaluate(() => {
      window.testState.piReloadCalls = [];
      window.testState.nativeReloadCalls = [];
      // 模拟当前页面运行环境切到了 codex (如全局处于 Codex 模式或混合搜索非活动行)
      window.__PI_ENH_GET_EXECUTION_ENGINE__ = () => 'codex';
      window.triggerRowContextMenu('pi-sess-baseline');
    });
    await page.waitForSelector('.pi-enh-menu');

    // 1. 验证菜单项文案：绝不能被当前页面的 codex 引擎覆盖为“重新读取原生会话”
    const counterPiReloadItem = page.locator('.pi-enh-menu [data-action="reload-session"]');
    assert.equal(await counterPiReloadItem.innerText(), '从磁盘重载 (Alt+R)', 'Pi 会话绝不能被当前页面全局 Codex 引擎覆盖为原生重读');

    // 2. 验证点击该重载项：必须调用 Pi 的重载通道，绝不能误调 Codex 原生重读
    await counterPiReloadItem.click();
    const counterPiCalls = await page.evaluate(() => window.testState.piReloadCalls);
    const counterNativeCalls = await page.evaluate(() => window.testState.nativeReloadCalls);
    assert.equal(counterPiCalls.length, 1, '必须派发 Pi 重读');
    assert.equal(counterPiCalls[0].sid, 'pi-sess-baseline');
    assert.equal(counterNativeCalls.length, 0, '绝不能误调 Codex 原生 reload 接口');

    // 3. 验证复制路径：必须复制真实 Pi 文件路径，绝不能提示“Codex 会话暂无本地文件路径”
    await page.evaluate(() => {
      window.testState.copiedClipboardText = null;
      window.triggerRowContextMenu('pi-sess-baseline');
    });
    await page.waitForSelector('.pi-enh-menu');
    await page.locator('.pi-enh-menu [data-action="copy-path"]').click();
    const copiedPiPath = await page.evaluate(() => window.testState.copiedClipboardText);
    assert.equal(copiedPiPath, '/root/.pi/agent/sessions/2026-10-21_pi.jsonl');
    await page.waitForSelector('.pi-enh-toast');
    const toastTextCounter = await page.locator('.pi-enh-toast').innerText();
    assert(toastTextCounter.includes('已复制会话文件完整路径'));

    // 4. 验证在全局 Codex 引擎下，Pi 会话的溢出菜单同样保持 Pi 语义
    const piOverflowBtnCounter = page.locator('[data-pi-enh-session-id="pi-sess-baseline"] .pi-enh-session-overflow');
    await piOverflowBtnCounter.click();
    await page.waitForSelector('.pi-enh-session-menu');
    const piOverflowReloadCounter = page.locator('.pi-enh-session-menu [data-session-action="reload"]');
    assert.equal(await piOverflowReloadCounter.innerText(), '从磁盘重载 (Alt+R)', '溢出菜单中 Pi 会话亦保持磁盘重载文案');
    await page.keyboard.press('Escape');

    await page.screenshot({ path: resolve(acceptanceDir, '08-codex-engine-target-pi-counter-example.png') });
    results.scenarios.codexEngineTargetPiCounterExample = {
      passed: true,
      menuTitle: '从磁盘重载 (Alt+R)',
      piReloadCalled: true,
      nativeReloadCalled: false,
      copiedPath: copiedPiPath,
    };

    // 写入验收 JSON
    const acceptanceJsonPath = resolve(acceptanceDir, 'codex-menu-capabilities.json');
    await writeFile(acceptanceJsonPath, JSON.stringify(results, null, 2), 'utf8');

    console.log('✅ 所有 Codex 菜单能力及 Pi 兼容性测试全部通过！验收 JSON 已写入:', acceptanceJsonPath);
  } finally {
    await browser.close();
    server.close();
  }
});
