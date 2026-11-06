const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const modulePath = path.join(__dirname, "../modules/08-settings-panels-and-lifecycle.js");
const moduleSource = fs.readFileSync(modulePath, "utf8");

test("静态审计：renderEnhancementModulesPanel 声明存在且没有重复 if 与 fallback", () => {
  // 1. 存在函数声明
  assert.match(
    moduleSource,
    /function\s+renderEnhancementModulesPanel\s*\(\s*panel\s*,\s*nav\s*\)/,
    "必须在 08 模块中完整声明 renderEnhancementModulesPanel(panel, nav)"
  );

  // 2. renderEnhancementsPanel 中直接调用，不包含 typeof fallback 逃避错误
  assert.match(
    moduleSource,
    /if\s*\(!window\.__PI_ENH_LEGACY_SETTINGS_RENDERER__\)\s*return\s+renderEnhancementModulesPanel\(panel,\s*nav\);/,
    "必须直接调用 renderEnhancementModulesPanel，不加 typeof 逃避"
  );
  assert.doesNotMatch(
    moduleSource,
    /typeof\s+renderEnhancementModulesPanel\s*===?\s*["']function["']/,
    "严禁使用 typeof fallback 绕过缺失函数"
  );

  // 3. 入口处没有重复冗余的 panel if 检查
  const duplicateIfPattern = /if\s*\(!panel\)\s*return;\s*if\s*\(!panel\.classList\.contains\("pi-enh-plugins-panel"\)\)\s*panel\.classList\.add\("pi-enh-plugins-panel"\);\s*if\s*\(!panel\)\s*return;/;
  assert.doesNotMatch(moduleSource, duplicateIfPattern, "必须清理 renderEnhancementsPanel 入口处重复的 if 校验");

  // 4. 不硬编码特定内网机器和 IP
  assert.doesNotMatch(
    moduleSource,
    /Windows\s*本地端\s*\(10\.0\.0\.89\)/,
    "模块渲染器不能硬编码内网专用设备 IP"
  );
  assert.doesNotMatch(
    moduleSource,
    /MacBook\s*本地端\s*\(10\.7\.7\.2\)/,
    "模块渲染器不能硬编码内网专用设备 IP"
  );
});

test("运行审计：在隔离沙箱中执行 renderEnhancementsPanel 正确调用 modules renderer", async () => {
  // 仅截取 08 模块中包含 renderEnhancementModulesPanel、applyEnhancementPanelFilter 和 renderEnhancementsPanel 的切片
  const startIdx = moduleSource.indexOf('  const ENHANCEMENT_SETTINGS_RENDERER_REVISION = "1.4.61.2";');
  assert.ok(startIdx > 0, "必须能定位 renderEnhancementModulesPanel 起始点");

  const endIdx = moduleSource.indexOf("  function applyEnhancementPanelFilter(panel) {", startIdx);
  assert.ok(endIdx > 0, "必须能定位 renderEnhancementModulesPanel 结束点");

  const renderModulesSlice = moduleSource.slice(startIdx, endIdx);

  // 模拟精简的 DOM 节点与上下文
  class MockElement {
    constructor(tagName = "div") {
      this.tagName = tagName;
      this.classList = {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        contains(c) { return this._classes.has(c); },
      };
      this.dataset = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this._innerHTML = "";
      this.value = "";
      this.disabled = false;
      this.hidden = false;
    }

    get innerHTML() { return this._innerHTML; }
    set innerHTML(html) {
      this._innerHTML = html;
      this._childSelectors = new Map();
      // 简单模拟根据 data 属性注册虚拟子节点
      const attrMatches = html.matchAll(/data-[a-z0-9-]+(?:="[^"]*")?/gi);
      for (const m of attrMatches) {
        const full = m[0];
        const [k, rawV] = full.split("=");
        const v = rawV ? rawV.replace(/^"|"$/g, "") : "";
        const el = new MockElement("div");
        el.setAttribute(k, v);
        this._childSelectors.set(`[${k}]`, el);
        this._childSelectors.set(`[${k}="${v}"]`, el);
        if (k === "data-plugin-search") el.tagName = "INPUT";
        if (k === "data-module-toggle") el.setAttribute("role", "checkbox");
      }
    }

    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) { this.attributes.delete(k); }

    addEventListener(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(fn);
    }

    querySelector(selector) {
      if (this._childSelectors?.has(selector)) return this._childSelectors.get(selector);
      const el = new MockElement("div");
      if (selector.includes("search")) el.tagName = "INPUT";
      return el;
    }

    querySelectorAll(selector) {
      if (this._childSelectors?.has(selector)) return [this._childSelectors.get(selector)];
      return [];
    }
  }

  const dummyModules = [
    { id: "composer-workflow", name: "输入与工作流", category: "输入交互", version: "1.0.0", desc: "测试模块", features: ["quick-action-buttons"], settings: [] },
    { id: "subagent-dispatch", name: "子 Agent 调度", category: "自动化", version: "1.0.0", desc: "测试子代理", features: [], settings: [] },
  ];

  const dummyPlugins = [
    { id: "quick-action-buttons", name: "快捷操作按钮", desc: "测试", category: "输入交互", defaultEnabled: true },
  ];

  let subagentCommittedValue = null;
  const sandboxContext = {
    ENHANCEMENT_MODULES: dummyModules,
    ENHANCEMENT_PLUGINS: dummyPlugins,
    ENHANCEMENT_SUITE_VERSION: "1.4.47",
    SUBAGENT_DISPATCH_MODULE_ID: "subagent-dispatch",
    enhancementPanelFilter: { query: "", category: "all" },
    getModuleState: () => ({ active: 1, state: "on", selected: 1 }),
    getVisibleModuleFeatures: (module) => module.features.map((id) => dummyPlugins.find((plugin) => plugin.id === id)).filter(Boolean),
    getVisibleEnhancementModules: () => dummyModules,
    isModuleEnabled: () => true,
    moduleStateLabel: () => "已开启",
    renderKernelHealthBadgeHtml: () => '<span class="test-health">OK</span>',
    renderFeatureToggle: () => '<div class="feature-toggle"></div>',
    renderQuickActionsEditor: () => '<div class="quick-actions"></div>',
    renderModuleSettingControl: () => '',
    bindQuickActionsEditor: () => {},
    loadQuickActionsConfig: async () => {},
    refreshQuickActionsEditorDom: () => {},
    applyEnhancementPanelFilter: () => {},
    forceHardReloadApp: () => {},
    enqueueSubagentDispatchCommit: async (val) => { subagentCommittedValue = val; },
    getEnhancementModule: (id) => dummyModules.find(m => m.id === id),
    setModuleEnabled: () => {},
    setPluginEnabled: () => {},
    resetEnhancementSettings: () => {},
    copyText: () => {},
    showToast: () => {},
    toggleModuleFromPanel: () => {},
    isPluginSelected: () => true,
    isPluginEnabled: () => true,
    setPluginSetting: () => {},
    purgeExpiredArchives: async () => {},
    clearSessionCaches: async () => {},
    requestDesktopAttentionPermission: async () => {},
    syncManifestPinnedEntries: async () => {},
    bindSubagentModelControls: () => {},
    syncEnhancementPanelControls: () => {},
    syncSubagentDispatchRemoteState: async () => {},
    initCrossDeviceSyncController: () => {},
    isPwaStandaloneMode: () => false,
    window: {
      __PI_ENH_DISABLE_QUICK_ACTION_CONTEXT_FETCH__: true,
      __PI_ENH_LEGACY_SETTINGS_RENDERER__: false,
    },
    document: new MockElement("document"),
  };

  const scriptCode = `
    ${renderModulesSlice}
    function renderEnhancementsPanel(panel, nav) {
      if (!panel) return;
      if (!panel.classList.contains("pi-enh-plugins-panel")) panel.classList.add("pi-enh-plugins-panel");
      if (!window.__PI_ENH_LEGACY_SETTINGS_RENDERER__) return renderEnhancementModulesPanel(panel, nav);
    }
    ({ renderEnhancementModulesPanel, renderEnhancementsPanel })
  `;

  const { renderEnhancementsPanel, renderEnhancementModulesPanel } = vm.runInNewContext(scriptCode, sandboxContext);
  assert.equal(typeof renderEnhancementModulesPanel, "function", "renderEnhancementModulesPanel 必须为可执行函数");

  const panel = new MockElement("div");
  // 验证调用 renderEnhancementsPanel 能够正常穿透执行 renderEnhancementModulesPanel，无任何 ReferenceError
  assert.doesNotThrow(() => {
    renderEnhancementsPanel(panel, null);
  }, "调用 renderEnhancementsPanel 绝不产生 ReferenceError");

  assert.ok(panel.classList.contains("pi-enh-plugins-panel"), "面板必须打上 pi-enh-plugins-panel 类");
  assert.ok(panel.innerHTML.includes("pi-enh-plugins-shell"), "渲染内容必须包含模块容器外壳");
  assert.ok(panel.innerHTML.includes("网页增强模块"), "渲染内容必须包含标题");
  assert.ok(panel.innerHTML.includes("data-module-row=\"composer-workflow\""), "渲染内容必须渲染对应模块行");
});
