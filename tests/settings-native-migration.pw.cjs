"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const piWebRequire = createRequire(path.resolve(__dirname, "../package.json"));
const esbuild = piWebRequire("esbuild");
const { chromium } = piWebRequire("playwright");
const { compileSettingsCss } = require("./native-settings-css.cjs");

const CANDIDATE_DIR = path.resolve(__dirname, "../enhancements/modules");
const CANONICAL_MODULES_DIR = path.resolve(__dirname, "../enhancements/modules");

function buildCandidateEnhancementsScript() {
  const files = [
    "01-bootstrap-and-core-state.js",
    "02-plugin-registry-and-settings-schema.js",
    "03-session-cache-and-sync-engine.js",
    "04-sidebar-and-session-management.js",
    "05-composer-and-input-workflow.js",
    "06-chat-view-and-tool-cards.js",
    "07-kernel-scheduler-and-observers.js",
    "08-settings-panels-and-lifecycle.js",
  ];

  return fs.readFileSync(path.resolve(__dirname, "../public/pi-web-enhancements.js"), "utf8");
}

function buildReactFixtureBundle() {
  const entryPath = path.resolve(__dirname, "settings-native-migration-fixture.tsx");
  const result = esbuild.buildSync({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    nodePaths: [path.resolve(__dirname, "../node_modules")],
    alias: {
      "@": path.resolve(__dirname, ".."),
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify("1.0.4"),
      "process.env.NEXT_PUBLIC_PI_VERSION": JSON.stringify("0.86.0"),
    },
  });
  return result.outputFiles[0].text;
}

function buildHtmlHost(enhancementsJs, reactBundleJs, css) {

  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Settings Native Migration Playwright Acceptance</title>
  <style>
    ${css}
  </style>
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
    }
    #root, .test-app-root {
      width: 100%;
      height: 100%;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    // Usage 与偏好 reader 由实际 public bundle 前缀加载，不额外注入测试依赖。
  </script>
  <script>
    // 注入 candidate 8 模块 stage 组合
    try {
      ${enhancementsJs}
    } catch(err) {
      console.error("ENHANCEMENT STAGE LOAD ERROR:", err);
    }
  </script>
  <script>
    // 注入 React SettingsPanel 原生托管宿主
    try {
      ${reactBundleJs}
    } catch(err) {
      console.error("REACT BUNDLE LOAD ERROR:", err);
    }
  </script>
</body>
</html>`;
}

async function finishNativeThemeTransition(page) {
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await Promise.all(document.getAnimations().filter(animation =>
      animation.effect?.pseudoElement?.startsWith('::view-transition')
    ).map(animation => animation.finished.catch(() => {})));
  });
}

async function setupPageRoutes(context, htmlContent, blockedExternalUrls = []) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());

    // 安全只读已知外部资源 route（如上游版本检查）
    if (url.hostname === "registry.npmjs.org" && url.pathname.includes("@earendil-works/pi-coding-agent/latest")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: "0.99.1" }),
      });
      return;
    }
    if (url.hostname === "api.github.com" && url.pathname.includes("/releases/latest")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tag_name: "v0.99.1", html_url: "https://github.com/earendil-works/pi/releases/tag/v0.99.1" }),
      });
      return;
    }

    // 生产环境安全红线防污染保护：生产 URL 认证前硬性拒绝执行
    if ((url.hostname !== "settings-migration.local" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")) {
      blockedExternalUrls.push(route.request().url());
      await route.abort("accessdenied");
      return;
    }

    if (url.hostname === "settings-migration.local" && url.pathname === "/") {
      await route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: htmlContent,
      });
      return;
    }

    if (url.pathname === '/api/sessions') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [] }) });
      return;
    }

    if (url.pathname.includes("/pi-usage-ledger.json")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          version: 2,
          generatedAt: new Date().toISOString(),
          buckets: [],
        }),
      });
      return;
    }

    if (url.pathname.includes("/api/web-auth")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ enabled: true }),
      });
      return;
    }

    if (url.pathname.includes("/api/tools/settings")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ isWindows: false, powerShellEnabled: false }),
      });
      return;
    }

    if (url.pathname.includes("/api/models/enabled")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          allEnabled: true,
          stalePatterns: [],
          enabledTotal: 5,
          availableTotal: 5,
          settingsPath: "~/.pi/agent/settings.json",
          scope: "global",
          editable: true,
          providers: [],
        }),
      });
      return;
    }

    if (url.pathname.includes("/api/models-config")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ providers: {}, quickShortcuts: [] }),
      });
      return;
    }

    if (url.pathname.includes("/api/auth/providers")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ oauth: [], apiKey: [] }),
      });
      return;
    }

    if (url.pathname.includes("/api/models")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ models: {}, modelList: [], defaultModel: null }),
      });
      return;
    }

    if (url.pathname.includes("/api/skills")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ skills: [] }),
      });
      return;
    }

    if (url.pathname.includes("/api/subagents/settings")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ builtInEnabled: true }),
      });
      return;
    }

    if (url.pathname.includes("/api/plugins")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ plugins: [] }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    });
  });
}

test("Settings Native Owner Migration: 5 Extensions A->B->C->A, Maintenance Host, Plugins on/off, Mobile Select", async (t) => {
  const enhancementsJs = buildCandidateEnhancementsScript();
  const reactBundleJs = buildReactFixtureBundle();
  const htmlContent = buildHtmlHost(enhancementsJs, reactBundleJs, await compileSettingsCss());

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const pageErrors = [];
  const consoleErrors = [];
  const blockedExternalUrls = [];

  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
  });

  await setupPageRoutes(context, htmlContent, blockedExternalUrls);
  await context.addInitScript(() => {
    localStorage.setItem('pi-locale', 'zh-CN');
    localStorage.setItem('pi-enh-session-archived', JSON.stringify([
      { id: 'archive-fixture', name: '隔离搜索样例', cwd: '/workspace/example', archivedAt: Date.now() },
    ]));
    localStorage.setItem('pi-enh-session-archived-rev', '1');
    const listeners = new Set();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, options) => {
      if (type === 'click' && listener?.name === 'handleOutsideClick') listeners.add(listener);
      return add(type, listener, options);
    };
    document.removeEventListener = (type, listener, options) => {
      if (type === 'click') listeners.delete(listener);
      return remove(type, listener, options);
    };
    window.__usageOutsideListenerCount = () => listeners.size;
  });

  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", (err) => {
    console.error("PAGE ERROR:", err);
    pageErrors.push(err);
  });
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  try {
  await page.goto("http://settings-migration.local/");
  await page.waitForSelector(".settings-dialog-surface", { timeout: 5000 });

  // ==========================================
  // 1. ABI 握手与独立渲染器注册
  // ==========================================
  await t.test("ABI Handshake & Registered Renderers", async () => {
    const abiStatus = await page.evaluate(() => {
      const abi = window.__PI_WEB_SETTINGS_NATIVE__;
      return {
        hasAbi: Boolean(abi),
        hasRegister: typeof abi?.registerRenderer === "function",
        hasNotify: typeof abi?.notifyPreferencesChanged === "function",
        hasActivate: typeof abi?.activateSection === "function",
        currentSection: abi?.getActiveSection(),
        isModalOpen: abi?.isModalOpen(),
      };
    });

    assert.equal(consoleErrors.length, 0, `Initialization errors: ${consoleErrors.join('; ')}`);
    assert.equal(abiStatus.hasAbi, true);
    assert.equal(abiStatus.hasRegister, true);
    assert.equal(abiStatus.hasNotify, true);
    assert.equal(abiStatus.hasActivate, true);
    assert.equal(abiStatus.isModalOpen, true);
  });

  // ==========================================
  // 2. 独占 Maintenance Host 渲染（页面维护卡与版本卡）
  // ==========================================
  await t.test("Maintenance Host rendered without hijacking native general sections", async () => {
    const maintenanceHost = page.locator(".settings-general-maintenance-host");
    await assert.doesNotReject(async () => maintenanceHost.waitFor({ state: "visible" }));

    // 验证维护管理卡与版本卡已挂载在 maintenanceHost 内部
    const cacheSection = maintenanceHost.locator(".pi-enh-cache-section");
    const versionSection = maintenanceHost.locator(".pi-enh-version-section");
    assert.equal(await cacheSection.count(), 1, "Cache & Restart card must be inside maintenance host");
    assert.equal(await versionSection.count(), 1, "Version card must be inside maintenance host");

    // 验证严禁搬移原生 General sections 到任何旧 shell
    const oldShell = page.locator(".pi-enh-dashboard-shell");
    assert.equal(await oldShell.count(), 0, "Old pi-enh-dashboard-shell must NOT exist");
    const rows = await page.locator('.settings-section-tab-row').evaluateAll(nodes => nodes.map(el => {
      const rect = el.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom };
    }));
    for (let index = 1; index < rows.length; index++) assert.ok(rows[index].top >= rows[index - 1].bottom,
      `Sidebar rows ${index - 1}/${index} must not overlap`);
    const appearance = await page.locator('[data-settings-area="appearance"]').boundingBox();
    const chat = await page.locator('[data-settings-area="chat"]').boundingBox();
    assert.equal(appearance.y, chat.y, 'Native grid cards must align at the same row top');
    // Capture stable palettes through the native reduced-motion path, not a view-transition midpoint.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.settings-theme-option:has(input[value="dark"])').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' &&
      document.querySelector('input[name="theme"][value="dark"]').checked);
    await finishNativeThemeTransition(page);
    await page.locator('.settings-general').evaluate(el => el.scrollTop = 0);
    await page.screenshot({ path: path.resolve(__dirname, '../../verification/render/desktop-dark.png') });
    const darkBackground = await page.locator('.settings-dialog-surface').evaluate(el => getComputedStyle(el).backgroundColor);
    await page.locator('.settings-theme-option:has(input[value="light"])').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' &&
      document.querySelector('input[name="theme"][value="light"]').checked);
    await finishNativeThemeTransition(page);
    await page.locator('.settings-general').evaluate(el => el.scrollTop = 0);
    const lightBackground = await page.locator('.settings-dialog-surface').evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(lightBackground, darkBackground, 'Native theme control must actually change the rendered palette');
    await page.screenshot({ path: path.resolve(__dirname, '../../verification/render/desktop-light.png') });
    await page.locator('.settings-theme-option:has(input[value="dark"])').click();
  });

  // ==========================================
  // 3. 5 个独立扩展 A -> B -> C -> A 真实点击切换与每面板真实内容操作
  // ==========================================
  await t.test("5 Extensions Tab switching: enhancements -> notifications -> archived -> enhancements", async () => {
    // 真实点击切换至 enhancements
    await page.locator('.settings-section-tab[data-section-id="enhancements"]').click();
    await page.waitForTimeout(50);
    const enhHost = page.locator(".settings-enhancements-host");
    await assert.doesNotReject(async () => enhHost.waitFor({ state: "visible" }));
    assert.equal(await enhHost.evaluate((el) => el.classList.contains("pi-enh-plugins-panel")), true);
    // 验证 enhancements 内部真实内容存在且可操作
    const moduleToggle = enhHost.locator("[data-module-toggle]").first();
    assert.equal(await moduleToggle.count() > 0, true, "Enhancement module toggle must exist");
    await moduleToggle.click();
    await page.waitForTimeout(50);
    // 恢复 toggle 状态以保持后续测试环境纯净
    await moduleToggle.click();
    await page.waitForTimeout(50);

    // 真实点击切换至 notifications
    await page.locator('.settings-section-tab[data-section-id="notifications"]').click();
    await page.waitForTimeout(50);
    const notifHost = page.locator(".settings-notifications-host");
    await assert.doesNotReject(async () => notifHost.waitFor({ state: "visible" }));
    assert.equal(await notifHost.evaluate((el) => el.classList.contains("pi-enh-notifications-panel")), true);
    // enhancements host 应被隐藏
    const enhHidden = await page.locator('div.settings-section-host[data-section-id="enhancements"]').evaluate((el) => el.hidden);
    assert.equal(enhHidden, true);
    // 验证 notifications 面板真实内容存在（工具栏操作按钮）
    const notifAction = notifHost.locator("[data-notification-action]").first();
    assert.equal(await notifAction.count() > 0, true, "Notifications action toolbar must exist");

    // 真实点击切换至 archived
    await page.locator('.settings-section-tab[data-section-id="archived"]').click();
    await page.waitForTimeout(50);
    const archHost = page.locator(".settings-archived-host");
    await assert.doesNotReject(async () => archHost.waitFor({ state: "visible" }));
    assert.equal(await archHost.evaluate((el) => el.classList.contains("pi-enh-archived-panel")), true);
    // 验证 archived 面板搜索框存在且可输入
    const archSearch = archHost.locator("input[data-archived-search]");
    assert.equal(await archSearch.count(), 1);
    await archSearch.fill("test-query");
    assert.equal(await archSearch.inputValue(), "test-query");

    // 真实点击切换至 usage (运行真实本地 PiUsagePanel 代码)
    await page.locator('.settings-section-tab[data-section-id="usage"]').click();
    const usageHost = page.locator(".settings-usage-host");
    await assert.doesNotReject(async () => usageHost.waitFor({ state: "visible" }));
    assert.equal(await usageHost.evaluate((el) => el.classList.contains("pi-enh-usage-panel")), true);

    // 等待真实本地 PiUsagePanel 完成首次数据水合与内容渲染，摆脱临时加载 spinner
    await page.waitForFunction(() => {
      const host = document.querySelector(".settings-usage-host");
      return host && host.querySelector(".pi-enh-usage-panel-content") && !host.querySelector(".pi-enh-history-spinner");
    }, { timeout: 3000 });
    assert.equal(await usageHost.locator(".pi-enh-history-spinner").count(), 0, "Usage panel must be rendered by real PiUsagePanel without permanent spinner");

    // 真实点击切换至 tags
    await page.locator('.settings-section-tab[data-section-id="tags"]').click();
    await page.waitForTimeout(50);
    const tagsHost = page.locator(".settings-tags-host");
    await assert.doesNotReject(async () => tagsHost.waitFor({ state: "visible" }));
    assert.equal(await tagsHost.evaluate((el) => el.classList.contains("pi-enh-tags-panel")), true);
    // 验证 tags 编辑输入框可操作
    const tagInput = tagsHost.locator("input.pi-enh-tag-add-name-input");
    assert.equal(await tagInput.count(), 1);
    await tagInput.fill("acceptance-tag");
    await tagInput.evaluate(el => { window.__tagEditingNode = el; });
    await page.evaluate(() => window.__TEST_CONTROL__.rerender());
    await page.waitForFunction(() => document.querySelector('[data-parent-revision="1"]'));
    assert.equal(await tagInput.inputValue(), "acceptance-tag");
    assert.equal(await tagInput.evaluate(el => el === window.__tagEditingNode && el === document.activeElement), true,
      "Parent rerender must retain editing node, input and focus");

    // 真实点击回到 enhancements (A -> B -> C -> A 闭环)
    await page.locator('.settings-section-tab[data-section-id="enhancements"]').click();
    await page.waitForTimeout(50);
    assert.equal(await enhHost.isVisible(), true);
    const tagsHidden = await page.locator('div.settings-section-host[data-section-id="tags"]').evaluate((el) => el.hidden);
    assert.equal(tagsHidden, true);
  });

  // ==========================================
  // 4. Plugins on/off 回退与恢复及 Parent Rerender 状态不丢
  // ==========================================
  await t.test("Plugins on/off preference response: disable session-tags -> tab removed and section fallback", async () => {
    // 当前在 tags 面板
    await page.locator('.settings-section-tab[data-section-id="tags"]').click();
    await page.waitForTimeout(50);

    // 关闭 session-tags 插件偏好
    await page.evaluate(() => {
      window.__TEST_CONTROL__.togglePluginMock("session-tags", false);
    });
    await page.waitForTimeout(100);

    // 验证 tags tab 已被原生安全移除，且自动回退到 general
    const tagsTab = page.locator('.settings-section-tab[data-section-id="tags"]');
    assert.equal(await tagsTab.count(), 0, "Disabled extension tab must be removed by native React");
    const currentSection = await page.evaluate(() => window.__PI_WEB_SETTINGS_NATIVE__.getActiveSection());
    assert.equal(currentSection, "general", "Active section must fallback to general when extension is disabled");

    // Parent rerender 验证：测试控制触发 remount，状态不丢
    await page.evaluate(() => {
      window.__TEST_CONTROL__.remount();
    });
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".settings-dialog-surface").isVisible(), true, "SettingsPanel persists after Parent remount");

    // 重新开启 session-tags 插件偏好
    await page.evaluate(() => {
      window.__TEST_CONTROL__.togglePluginMock("session-tags", true);
    });
    await page.waitForTimeout(100);
    const restoredTagsTab = page.locator('.settings-section-tab[data-section-id="tags"]');
    assert.equal(await restoredTagsTab.count(), 1, "Enabled extension tab must be restored by native React");
  });

  // ==========================================
  // 5. Tab Action Pin 保存与读回中文/别名
  // ==========================================
  await t.test("Tab Action Pin saves and reads back Chinese labels and aliases", async () => {
    // 1. 测试未 pinned 的 models tab-action：点击固定，断言读回中文 label
    const modelsPinBtn = page.locator('.settings-section-tab-row [data-host-id="tab-action:models"] .pi-enh-tab-pin-btn');
    await assert.doesNotReject(async () => modelsPinBtn.waitFor({ state: "visible" }));
    await modelsPinBtn.click();
    await page.waitForTimeout(50);

    let savedShortcuts = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("pi-web-quick-shortcuts") || "[]");
      } catch (_) {
        return [];
      }
    });

    const modelsItem = savedShortcuts.find((s) => s.id === "models");
    assert.ok(modelsItem, "Pinned models item must exist in shortcuts");
    assert.equal(modelsItem.label, "模型", `Label must be Chinese "模型", got: ${modelsItem.label}`);

    // 2. 测试 general tab-action：别名兼容验证（对应 settings 或 general）
    const generalPinBtn = page.locator('.settings-section-tab-row [data-host-id="tab-action:general"] .pi-enh-tab-pin-btn');
    await assert.doesNotReject(async () => generalPinBtn.waitFor({ state: "visible" }));
    const initialGeneralPinned = await generalPinBtn.evaluate((el) => el.classList.contains("is-pinned"));
    assert.equal(initialGeneralPinned, true, "General tab is pinned by default");

    // 取消固定
    await generalPinBtn.click();
    await page.waitForTimeout(50);
    savedShortcuts = await page.evaluate(() => JSON.parse(localStorage.getItem("pi-web-quick-shortcuts") || "[]"));
    assert.equal(savedShortcuts.some((s) => s.id === "settings" || s.id === "general"), false, "General item removed after toggle");

    // 重新添加固定，验证读回中文
    await generalPinBtn.click();
    await page.waitForTimeout(50);
    savedShortcuts = await page.evaluate(() => JSON.parse(localStorage.getItem("pi-web-quick-shortcuts") || "[]"));
    const restoredGeneral = savedShortcuts.find((s) => s.id === "settings" || s.id === "general");
    assert.ok(restoredGeneral, "General item restored in shortcuts");
    assert.ok(["常规", "设置"].includes(restoredGeneral.label), `Label must be Chinese, got: ${restoredGeneral.label}`);
  });

  // ==========================================
  // 5. 移动端 (390px) Select 联动
  // ==========================================
  await t.test("Mobile 390px viewport: native select picker controls section", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(50);

    const picker = page.locator("select.settings-mobile-section-picker");
    await assert.doesNotReject(async () => picker.waitFor({ state: "visible" }));

    await picker.selectOption('general');
    await page.waitForFunction(() => !document.querySelector('.pi-enh-toast'));
    assert.equal(await page.locator('.settings-general').evaluate(el => el.scrollWidth <= el.clientWidth), true,
      'Mobile General must not overflow horizontally');
    await page.screenshot({ path: path.resolve(__dirname, '../../verification/render/mobile-390.png') });
    // 通过 picker 切换至 models
    await picker.selectOption("models");
    await page.waitForTimeout(50);
    const activeSection = await page.evaluate(() => window.__PI_WEB_SETTINGS_NATIVE__.getActiveSection());
    assert.equal(activeSection, "models");

    // 切回桌面端
    await page.setViewportSize({ width: 1280, height: 860 });
  });

  // ==========================================
  // 7. 关 modal 从快捷 button 真实重开初选 usage
  // ==========================================
  await t.test("Close modal and reopen directly via shortcut button selecting usage", async () => {
    assert.equal(await page.evaluate(() => typeof window.__PI_ENH_OPEN_SETTINGS__), "function");

    // 真实关闭 modal
    await page.evaluate(() => window.__TEST_CONTROL__.close());
    await page.waitForTimeout(50);
    assert.equal(await page.locator(".settings-dialog-surface").count(), 0, "Modal should be closed");

    // Dispatch through the real shortcut API; this fixture has no native sidebar.
    await page.evaluate(() => window.__PI_ENH_TRIGGER_SHORTCUT__("usage"));
    await page.waitForTimeout(200);

    // 验证 modal 重新打开且初选展示 usage 面板
    const surface = page.locator(".settings-dialog-surface");
    await assert.doesNotReject(async () => surface.waitFor({ state: "visible" }));
    const sec = await page.evaluate(() => window.__PI_WEB_SETTINGS_NATIVE__?.getActiveSection());
    assert.equal(sec, "usage");
    assert.equal(await page.locator(".settings-usage-host").isVisible(), true);
  });

  await t.test('Real shortcut button and usage dropdown disposal', async () => {
    const usagePin = page.locator('[data-host-id="tab-action:usage"] .pi-enh-tab-pin-btn');
    if (!(await usagePin.evaluate(el => el.classList.contains('is-pinned')))) await usagePin.click();
    await page.locator('[data-pi-usage-dropdown-toggle]').click();
    assert.equal(await page.evaluate(() => window.__usageOutsideListenerCount()), 1);
    await page.evaluate(() => window.__TEST_CONTROL__.close());
    await page.waitForFunction(() => document.querySelector('.settings-dialog-surface') === null);
    assert.equal(await page.evaluate(() => window.__usageOutsideListenerCount()), 0,
      'Programmatic unmount without an outside click must release the document listener');
    await page.locator('.pi-enh-shortcut-btn[data-shortcut-id="usage"]').click();
    await page.waitForFunction(() => window.__PI_WEB_SETTINGS_NATIVE__?.getActiveSection() === 'usage');
    assert.equal(await page.locator('.settings-usage-host').isVisible(), true);
  });

  await t.test('Bundle cleanup preserves React-owned tabs and hosts', async () => {
    const before = await page.locator('.settings-section-tab').count();
    await page.evaluate(() => window.__PI_WEB_ENHANCEMENTS_CLEANUP__());
    assert.equal(await page.locator('.settings-section-tab').count(), before);
    assert.equal(await page.locator('.settings-usage-host').count(), 1);
    await page.locator('.settings-section-tab[data-section-id="general"]').click();
    assert.equal(await page.locator('.settings-general').isVisible(), true);
  });

    assert.equal(pageErrors.length, 0, `Page errors: ${pageErrors.map((err) => err.message).join("; ")}`);
    assert.equal(consoleErrors.length, 0, `Console errors: ${consoleErrors.join("; ")}`);
  } finally {
    await browser.close();
  }
});
