#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");

const PRIMARY_BUNDLE_PATH = path.join(__dirname, "pi-web-enhancements.js");
const MIRROR_BUNDLE_PATH = path.join(__dirname, "..", "public", "pi-web-enhancements.js");
const MODULES_DIR = path.join(__dirname, "modules");
const MANIFEST_PATH = path.join(MODULES_DIR, "manifest.json");
const PACKAGE_VERSION = require(path.join(__dirname, "..", "package.json")).version;

const MODULE_SPECS = [
  {
    index: 1,
    id: "01-bootstrap-and-core-state",
    name: "01-bootstrap-and-core-state.js",
    file: "01-bootstrap-and-core-state.js",
    startAnchor: null,
    responsibility:
      "IIFE 启动引导、路由自愈保护、页面标题脱敏防抖、顶层 TDZ 声明提升、Managed Lifecycle 零泄漏注册表、原生样式生命周期契约、通知偏好与历史、Toast 与剪贴板工具。",
  },
  {
    index: 2,
    id: "02-plugin-registry-and-settings-schema",
    name: "02-plugin-registry-and-settings-schema.js",
    file: "02-plugin-registry-and-settings-schema.js",
    startAnchor: "// 0. Enhancement Plugins Registry (网页插件注册与管理)",
    includePrecedingBanner: true,
    responsibility:
      "ENHANCEMENT_PLUGINS (76 个插件) 注册表与默认配置 Schema、模块与插件启闭持久化、用户消息状态对齐与大图去重、会话置顶/归档/背景色/多维彩色标签/Odoo 插件更新状态胶囊与分组保留策略。",
  },
  {
    index: 3,
    id: "03-session-cache-and-sync-engine",
    name: "03-session-cache-and-sync-engine.js",
    file: "03-session-cache-and-sync-engine.js",
    startAnchor: "// 0.2 Session Memory Cache (会话内存秒开与长会话优化)",
    includePrecedingBanner: true,
    responsibility:
      "会话内存秒开缓存 (Session Memory Cache)、CacheStorage/IndexedDB 统一持久化存储抽象、会话历史顺序防回退守卫 (session-history-order-guard)、高性能会话搜索 LRU 缓存与归档折叠管理、权威终态核验引擎 (Terminal Reconcile Engine)、原生缓存预加载与跨端多标签页同步。",
  },
  {
    index: 4,
    id: "04-sidebar-and-session-management",
    name: "04-sidebar-and-session-management.js",
    file: "04-sidebar-and-session-management.js",
    startAnchor: "// 1. Session Row Context Menu (右键会话菜单)",
    includePrecedingBanner: true,
    responsibility:
      "侧边栏会话行右键上下文菜单、未读水位线管理、会话行内重命名与双击重命名、快捷引用工具条与文本批注 (Quote Toolbar & Annotations)、ask_user 网页原生选择器与四题交互原型、跨项目会话状态提示 (Cross-project Session Status Indicator)。",
  },
  {
    index: 5,
    id: "05-composer-and-input-workflow",
    name: "05-composer-and-input-workflow.js",
    file: "05-composer-and-input-workflow.js",
    startAnchor: "// 2.6 AI Quick Actions (同轮 AI 结构化选择 + 安全兜底)",
    includePrecedingBanner: true,
    responsibility:
      "AI 快捷操作建议、空输入发送继续、输入框草稿与图片本地记忆、文件直接粘贴与拖放胶囊卡片、输入框图片点击放大、流式思考聚合守卫、运行中切换后续模型、Cursor/Codex 风格统一输入框与模型思考胶囊、Markdown 格式化粘贴、Goal/Plan 模式、@ 提及聚焦插件、全站图片双击预览、右侧面板会话绑定、移动端软键盘与手势守护、会话批量管理与删除。",
  },
  {
    index: 6,
    id: "06-chat-view-and-tool-cards",
    name: "06-chat-view-and-tool-cards.js",
    file: "06-chat-view-and-tool-cards.js",
    startAnchor: "// 3. Task Total Duration & Turn Usage Tooltips (点击展开耗时拆解与消耗明细气泡)",
    includePrecedingBanner: true,
    responsibility:
      "回合耗时拆解与消耗明细气泡、工具调用自动折叠与子代理派发卡片增强、孤立过程消息吸附聚合器、会话压缩摘要自动折叠、runAllSyncOperations 全量同步步骤编排、原生消息字体与滚动条增强、目录选择器悬停与新建文件夹、Minimap 全导航、回到底部按钮、会话阅读位置记忆与恢复、代码块免扫描保护、本地路径快捷唤起与 Obsidian/Markdown 预览增强。",
  },
  {
    index: 7,
    id: "07-kernel-scheduler-and-observers",
    name: "07-kernel-scheduler-and-observers.js",
    file: "07-kernel-scheduler-and-observers.js",
    startAnchor: "// Debounced DOM Synchronization and Mutex Guard",
    includePrecedingBanner: false,
    responsibility:
      "防抖 DOM 同步调度器 (scheduleDomSync)、聊天区/弹窗/侧边栏 MutationObserver 观察器、耗时与用量明细浮层渲染 (showDurationTooltip / showUsageTooltip)、实时运行秒表与浏览器标签页计时器 (Live Running Stopwatch)、思考深度持久化与自动恢复。",
  },
  {
    index: 8,
    id: "08-settings-panels-and-lifecycle",
    name: "08-settings-panels-and-lifecycle.js",
    file: "08-settings-panels-and-lifecycle.js",
    startAnchor: "// 设置对话框可调节尺寸与侧边栏可调节宽度 (Settings Dialog & Sidebar Resizable)",
    includePrecedingBanner: true,
    responsibility:
      "设置对话框尺寸与侧边栏宽度拖拽调节、设置侧边栏折叠控制器、设置弹窗增强插件面板与归档管理标签页、设置项双击快捷入口与底部快捷栏、全局用量与成本大盘 (Usage & Cost Dashboard)、静默热载探针、零泄漏清理钩子 (__PI_WEB_ENHANCEMENTS_CLEANUP__)、Plugin Micro-Kernel 异常隔离沙箱与首屏 0ms 同步立即执行挂载。",
  },
];

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function splitIntoLineChunks(rawText) {
  return rawText.match(/[^\n]*\n|[^\n]+/g) || [];
}

function validateSyntaxGate(code, filename = "pi-web-enhancements.js") {
  // Strictly compile-only syntax gate via vm.Script (never execute/eval in Node to avoid libuv handle leaks)
  new vm.Script(code, { filename });
  const requiredTokens = [
    "__PI_ENH_KERNEL_HEALTH__",
    "runIsolatedKernelStep",
    "initialDomSyncImmediate",
    "__PI_ENH_IS_PLUGIN_ENABLED__",
    "__PI_WEB_ENHANCEMENTS_LOADED__",
  ];
  for (const token of requiredTokens) {
    if (!code.includes(token)) {
      throw new Error(`Missing required kernel token in bundle: ${token}`);
    }
  }
}

function validateOwnershipGate() {
  const { SOURCE_FILES, checkReleaseOwnership } = require("./check-release-ownership.cjs");
  const sources = Object.fromEntries(Object.entries(SOURCE_FILES).map(([key, file]) =>
    [key, fs.readFileSync(path.join(__dirname, "..", file), "utf8")]));
  for (const file of ["components/FileViewer.tsx", "components/MermaidBlock.tsx"]) {
    const code = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    if (code.includes("Prism as SyntaxHighlighter") || code.includes("dist/cjs/styles/prism")) {
      throw new Error("不可重新同步引入完整高亮/主题：" + file);
    }
  }
  const report = checkReleaseOwnership(sources);
  if (!report.ok) throw new Error("发布所有权门禁失败：" + report.checks.filter(c => !c.ok).map(c => c.name).join("、"));
  const module03 = fs.readFileSync(path.join(MODULES_DIR, "03-session-cache-and-sync-engine.js"), "utf8");
  for (const token of ["captureDomSessionSnapshot(", "showSessionDomSnapshotOverlay(", "showSessionStaticLoadingPlaceholder("]) {
    if (module03.includes(token)) throw new Error("会话显示必须由原生缓存拥有：" + token);
  }
  const module08 = fs.readFileSync(path.join(MODULES_DIR, "08-settings-panels-and-lifecycle.js"), "utf8");
  if (!module08.includes("const state = getPiAgentUpdateState();")) {
    throw new Error("设置版本卡片必须读取现有版本状态，不能使用独立的旧版默认值");
  }
  const module01 = fs.readFileSync(path.join(MODULES_DIR, "01-bootstrap-and-core-state.js"), "utf8");
  const layout = fs.readFileSync(path.join(__dirname, "..", "app/layout.tsx"), "utf8");
  const nativeStyles = fs.readFileSync(path.join(__dirname, "..", "app/enhancements.css"), "utf8");
  if (!layout.includes('import "./enhancements.css";') || !nativeStyles.includes(".pi-enh-quote-bar")) {
    throw new Error("共享增强样式必须由原生首帧样式流水线拥有");
  }
  const shell = fs.readFileSync(path.join(__dirname, "..", "components/AppShell.tsx"), "utf8");
  const shortcuts = fs.readFileSync(path.join(__dirname, "..", "components/SettingsShortcuts.tsx"), "utf8");
  if (!shell.includes("<SettingsShortcuts") || !shortcuts.includes("useSyncExternalStore(") || !shortcuts.includes("key={id}") ||
      !module08.includes("abi.setSidebarShortcuts(getStoredQuickShortcuts())") ||
      module08.includes("function locateShortcutsContainer(") || module08.includes("function bindShortcutButtonsEvents(") ||
      nativeStyles.includes(".pi-enh-shortcuts-bar") || nativeStyles.includes('.sidebar-container > div:last-child:not([data-pi-enh-shortcuts-disabled="true"])')) {
    throw new Error("快捷入口必须由原生组件渲染：增强层只能同步偏好，不可隐藏、替换或清除原生按钮焦点");
  }
  if (module01.includes("styleEl.textContent") || module01.includes("initLogoInstantCache") || /Node\.prototype\.insertBefore\s*=/.test(module01)) {
    throw new Error("已迁移的共享样式/Logo/DOM所有权不能再次通过运行时覆盖");
  }
  if (module01.includes("contain-intrinsic-size: auto 130px")) throw new Error("原生会话不能使用增强层估算消息高度");
  for (const token of ["triggerSessionScrollRestore(", "hookScrollContainerScrollTo(", "sessionScrollMemory = new Map"]) {
    if (sources.module06.includes(token)) throw new Error("阅读位置必须由原生组件拥有：" + token);
  }
  if (sources.module06.includes("make_xlsx_lib") || sources.module06.includes("/*! xlsx.js")) {
    throw new Error("Excel 引擎不可重新内联进增强主包");
  }
}

function buildPublicBundle(bundleBuffer, writeAssets = false) {
  const usageLedger = fs.readFileSync(path.join(__dirname, "usage-ledger-core.js"), "utf8");
  const { script: optionalLoader } = require("./build-optional-assets.cjs").buildOptionalAssets(__dirname, { write: writeAssets });
  const { extractEnhancementMetadata, buildFastPluginReaderSnippet, buildNativePluginSettingsModuleCode } = require("./pi-web-settings-prepaint.cjs");
  const metadata = extractEnhancementMetadata(path.join(MODULES_DIR, "02-plugin-registry-and-settings-schema.js"));
  const nativePath = path.join(__dirname, "..", "lib", "enhancement-settings.generated.ts");
  const nativeCode = buildNativePluginSettingsModuleCode(metadata);
  if (writeAssets) fs.writeFileSync(nativePath, nativeCode);
  else if (!fs.existsSync(nativePath) || fs.readFileSync(nativePath, "utf8") !== nativeCode) {
    throw new Error("原生设置元数据漂移，请运行增强构建同步 canonical schema");
  }
  const reader = buildFastPluginReaderSnippet(metadata);
  if (bundleBuffer.includes(Buffer.from("PiUsagePanel =")) || bundleBuffer.includes(Buffer.from("make_xlsx_lib"))) throw new Error("低频组件重复内联，已阻止发布");
  const prefix = Buffer.from(`${usageLedger}\n;\n${optionalLoader}\n;\n${reader}\n;\n`, "utf8");
  return Buffer.concat([prefix, bundleBuffer]);
}

// This is a normal source build transform; the reviewable raw closure remains
// available for compatibility reloads, while first load uses immutable bytes.
function buildRuntimeAsset(publicBuffer, write = false) {
  const transformed = require("esbuild").transformSync(publicBuffer.toString("utf8"), {
    loader: "js", target: "es2020", minifyWhitespace: true, minifySyntax: true,
    minifyIdentifiers: false, legalComments: "eof",
  });
  const bytes = Buffer.from(transformed.code);
  validateSyntaxGate(transformed.code, "enhancements-runtime.js");
  const hash = crypto.createHash("sha256").update(bytes).digest();
  const assetPath = `/pi-web-assets/enhancements-${hash.toString("hex").slice(0,16)}.js`;
  const target = path.join(__dirname, "..", "public", assetPath.slice(1));
  if (write) { fs.mkdirSync(path.dirname(target), {recursive:true}); fs.writeFileSync(target, bytes); }
  else if (!fs.existsSync(target) || !fs.readFileSync(target).equals(bytes)) throw new Error("首屏增强资源漂移：" + assetPath);
  return { path: assetPath, sha256: hash.toString("hex"), integrity: `sha256-${hash.toString("base64")}`, bytes: bytes.length };
}

function syncMirrorBundle(bundleBuffer) {
  fs.mkdirSync(path.dirname(MIRROR_BUNDLE_PATH), { recursive: true });
  fs.writeFileSync(MIRROR_BUNDLE_PATH, buildPublicBundle(bundleBuffer, true));
}

// Keep only this release's immutable assets; old hashes contain retired code.
// This runs in the build checkout, never against an installed running service.
function pruneRetiredAssets(runtimeAsset) {
  const { manifest } = require("./build-optional-assets.cjs").buildOptionalAssets(__dirname);
  const current = new Set([runtimeAsset.path, ...Object.values(manifest).map(asset => asset.path)]);
  const dir = path.join(__dirname, "..", "public", "pi-web-assets");
  for (const name of fs.readdirSync(dir)) {
    if (/^(enhancements|image-editor|usage-panel|xlsx-engine)-[a-f0-9]{16}\.js$/.test(name)
        && !current.has(`/pi-web-assets/${name}`)) fs.unlinkSync(path.join(dir, name));
  }
}

function resolveModuleBoundaries(lineChunks) {
  const totalLines = lineChunks.length;
  const startLines = new Array(MODULE_SPECS.length).fill(1);

  for (let i = 1; i < MODULE_SPECS.length; i++) {
    const spec = MODULE_SPECS[i];
    const matches = [];
    for (let lineIdx = 0; lineIdx < totalLines; lineIdx++) {
      if (lineChunks[lineIdx].includes(spec.startAnchor)) {
        matches.push(lineIdx + 1);
      }
    }
    if (matches.length !== 1) {
      throw new Error(
        `Anchor for module ${spec.name} ("${spec.startAnchor}") matched ${matches.length} times (expected 1).`
      );
    }
    let startLine = matches[0];
    if (
      spec.includePrecedingBanner &&
      startLine > 1 &&
      lineChunks[startLine - 2].trim() === "// =========================================="
    ) {
      startLine -= 1;
    }
    startLines[i] = startLine;
  }

  const boundaries = [];
  for (let i = 0; i < MODULE_SPECS.length; i++) {
    const startLine = startLines[i];
    const endLine = i + 1 < MODULE_SPECS.length ? startLines[i + 1] - 1 : totalLines;
    if (startLine > endLine) {
      throw new Error(`Invalid boundary for ${MODULE_SPECS[i].name}: ${startLine}..${endLine}`);
    }
    boundaries.push({
      ...MODULE_SPECS[i],
      startLine,
      endLine,
    });
  }
  return boundaries;
}

function runSplit() {
  if (!fs.existsSync(PRIMARY_BUNDLE_PATH)) {
    throw new Error(`Source bundle not found: ${PRIMARY_BUNDLE_PATH}`);
  }
  const rawBuffer = fs.readFileSync(PRIMARY_BUNDLE_PATH);
  const rawText = rawBuffer.toString("utf8");

  validateSyntaxGate(rawText, PRIMARY_BUNDLE_PATH);

  const lineChunks = splitIntoLineChunks(rawText);
  const boundaries = resolveModuleBoundaries(lineChunks);

  fs.mkdirSync(MODULES_DIR, { recursive: true });

  const manifestModules = [];
  for (const b of boundaries) {
    const moduleText = lineChunks.slice(b.startLine - 1, b.endLine).join("");
    const moduleBuffer = Buffer.from(moduleText, "utf8");
    const modulePath = path.join(MODULES_DIR, b.file);
    fs.writeFileSync(modulePath, moduleBuffer);

    const lineCount = b.endLine - b.startLine + 1;
    manifestModules.push({
      index: b.index,
      id: b.id,
      name: b.name,
      file: b.file,
      startLine: b.startLine,
      endLine: b.endLine,
      lineCount,
      lineRange: [b.startLine, b.endLine],
      lineRangeText: `${b.startLine}-${b.endLine}`,
      bytes: moduleBuffer.length,
      sha256: sha256Hex(moduleBuffer),
      responsibility: b.responsibility,
    });
  }

  syncMirrorBundle(rawBuffer);
  const manifest = {
    schemaVersion: 1,
    edition: `koxir-standalone-${PACKAGE_VERSION}`,
    version: PACKAGE_VERSION,
    targetFile: "enhancements/pi-web-enhancements.js",
    mirrorFile: "public/pi-web-enhancements.js",
    totalLines: lineChunks.length,
    totalBytes: rawBuffer.length,
    bundleSha256: sha256Hex(rawBuffer),
    publicSha256: sha256Hex(fs.readFileSync(MIRROR_BUNDLE_PATH)),
    runtimeAsset: buildRuntimeAsset(fs.readFileSync(MIRROR_BUNDLE_PATH), true),
    modules: manifestModules,
  };

  pruneRetiredAssets(manifest.runtimeAsset);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(
    `[build-pi-web-enhancements] Split complete: ${manifestModules.length} modules (${manifest.totalLines} lines, ${manifest.totalBytes} bytes, sha256=${manifest.bundleSha256.slice(0, 12)}...).`
  );
}

function runBuild() {
  validateOwnershipGate();
  const moduleBuffers = [];
  const manifestModules = [];
  let currentLine = 1;

  for (const spec of MODULE_SPECS) {
    const modulePath = path.join(MODULES_DIR, spec.file);
    if (!fs.existsSync(modulePath)) {
      throw new Error(`Module file missing: ${modulePath}`);
    }
    const buf = fs.readFileSync(modulePath);
    const text = buf.toString("utf8");
    const chunks = splitIntoLineChunks(text);
    const startLine = currentLine;
    const endLine = startLine + chunks.length - 1;
    currentLine = endLine + 1;

    moduleBuffers.push(buf);
    manifestModules.push({
      index: spec.index,
      id: spec.id,
      name: spec.name,
      file: spec.file,
      startLine,
      endLine,
      lineCount: chunks.length,
      lineRange: [startLine, endLine],
      lineRangeText: `${startLine}-${endLine}`,
      bytes: buf.length,
      sha256: sha256Hex(buf),
      responsibility: spec.responsibility,
    });
  }

  const combinedBuffer = Buffer.concat(moduleBuffers);
  const combinedText = combinedBuffer.toString("utf8");

  validateSyntaxGate(combinedText, PRIMARY_BUNDLE_PATH);

  fs.writeFileSync(PRIMARY_BUNDLE_PATH, combinedBuffer);
  syncMirrorBundle(combinedBuffer);

  const manifest = {
    schemaVersion: 1,
    edition: `koxir-standalone-${PACKAGE_VERSION}`,
    version: PACKAGE_VERSION,
    targetFile: "enhancements/pi-web-enhancements.js",
    mirrorFile: "public/pi-web-enhancements.js",
    totalLines: currentLine - 1,
    totalBytes: combinedBuffer.length,
    bundleSha256: sha256Hex(combinedBuffer),
    publicSha256: sha256Hex(fs.readFileSync(MIRROR_BUNDLE_PATH)),
    runtimeAsset: buildRuntimeAsset(fs.readFileSync(MIRROR_BUNDLE_PATH), true),
    modules: manifestModules,
  };
  pruneRetiredAssets(manifest.runtimeAsset);
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(
    `[build-pi-web-enhancements] Build complete: ${manifest.totalLines} lines, ${manifest.totalBytes} bytes, vm.Script syntax gate passed.`
  );
}

function runVerify() {
  validateOwnershipGate();
  if (!fs.existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if (!Array.isArray(manifest.modules) || manifest.modules.length !== MODULE_SPECS.length) {
    throw new Error(
      `Manifest module count mismatch: expected ${MODULE_SPECS.length}, got ${manifest.modules?.length}`
    );
  }

  const moduleBuffers = [];
  let expectedStartLine = 1;

  for (let i = 0; i < MODULE_SPECS.length; i++) {
    const spec = MODULE_SPECS[i];
    const entry = manifest.modules[i];
    if (!entry || entry.file !== spec.file) {
      throw new Error(`Manifest entry #${i + 1} mismatch: expected ${spec.file}, got ${entry?.file}`);
    }
    const modulePath = path.join(MODULES_DIR, spec.file);
    if (!fs.existsSync(modulePath)) {
      throw new Error(`Module file missing: ${modulePath}`);
    }
    const buf = fs.readFileSync(modulePath);
    const actualSha = sha256Hex(buf);
    if (actualSha !== entry.sha256) {
      throw new Error(`SHA256 mismatch for ${spec.file}: manifest=${entry.sha256}, actual=${actualSha}`);
    }
    const chunks = splitIntoLineChunks(buf.toString("utf8"));
    const expectedEndLine = expectedStartLine + chunks.length - 1;
    if (entry.startLine !== expectedStartLine || entry.endLine !== expectedEndLine) {
      throw new Error(
        `Line range mismatch for ${spec.file}: manifest=${entry.startLine}-${entry.endLine}, actual=${expectedStartLine}-${expectedEndLine}`
      );
    }
    expectedStartLine = expectedEndLine + 1;
    moduleBuffers.push(buf);
  }

  const combinedBuffer = Buffer.concat(moduleBuffers);
  const combinedText = combinedBuffer.toString("utf8");

  validateSyntaxGate(combinedText, PRIMARY_BUNDLE_PATH);

  const primaryBuffer = fs.readFileSync(PRIMARY_BUNDLE_PATH);
  if (Buffer.compare(combinedBuffer, primaryBuffer) !== 0) {
    throw new Error(
      `Combined modules do not match ${PRIMARY_BUNDLE_PATH} byte-for-byte (combined=${combinedBuffer.length}B, primary=${primaryBuffer.length}B).`
    );
  }

  if (!fs.existsSync(MIRROR_BUNDLE_PATH)) throw new Error("缺少正式增强资源镜像");
  if (fs.existsSync(MIRROR_BUNDLE_PATH)) {
    const mirrorBuffer = fs.readFileSync(MIRROR_BUNDLE_PATH);
    const expectedPublic = buildPublicBundle(combinedBuffer);
    const rawOffset = mirrorBuffer.indexOf(combinedBuffer);
    if (Buffer.compare(expectedPublic, mirrorBuffer) !== 0 || rawOffset < 0 ||
        mirrorBuffer.indexOf(combinedBuffer, rawOffset + 1) !== -1 ||
        rawOffset + combinedBuffer.length !== mirrorBuffer.length) {
      throw new Error(`Public prefix/raw closure mismatch: ${MIRROR_BUNDLE_PATH}`);
    }
    validateSyntaxGate(mirrorBuffer.toString("utf8"), MIRROR_BUNDLE_PATH);
    if (manifest.version !== PACKAGE_VERSION || manifest.publicSha256 !== sha256Hex(mirrorBuffer)
        || JSON.stringify(manifest.runtimeAsset) !== JSON.stringify(buildRuntimeAsset(mirrorBuffer))) {
      throw new Error("版本/正式资源来源指纹不匹配");
    }
  }

  const combinedSha = sha256Hex(combinedBuffer);
  if (manifest.bundleSha256 !== combinedSha) {
    throw new Error(`Bundle SHA256 mismatch: manifest=${manifest.bundleSha256}, actual=${combinedSha}`);
  }

  console.log(
    `[build-pi-web-enhancements] Verify OK: ${MODULE_SPECS.length} modules === ${PRIMARY_BUNDLE_PATH} & ${MIRROR_BUNDLE_PATH} (${manifest.totalLines} lines, ${combinedBuffer.length} bytes, sha256=${combinedSha.slice(0, 12)}..., vm.Script syntax OK).`
  );
}

function ensureSynced() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    if (fs.existsSync(PRIMARY_BUNDLE_PATH)) {
      runSplit();
      return { action: "split" };
    }
    return { action: "none" };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    let modulesChanged = false;
    for (let i = 0; i < MODULE_SPECS.length; i++) {
      const spec = MODULE_SPECS[i];
      const entry = manifest.modules && manifest.modules[i];
      const modulePath = path.join(MODULES_DIR, spec.file);
      if (!entry || !fs.existsSync(modulePath)) {
        modulesChanged = true;
        break;
      }
      const actualSha = sha256Hex(fs.readFileSync(modulePath));
      if (actualSha !== entry.sha256) {
        modulesChanged = true;
        break;
      }
    }
    if (modulesChanged) {
      runBuild();
      return { action: "build-from-modules" };
    }
    if (fs.existsSync(PRIMARY_BUNDLE_PATH)) {
      const bundleSha = sha256Hex(fs.readFileSync(PRIMARY_BUNDLE_PATH));
      if (bundleSha !== manifest.bundleSha256) {
        runSplit();
        return { action: "split-from-bundle" };
      }
    }
    return { action: "noop" };
  } catch (e) {
    console.warn("[build-pi-web-enhancements] ensureSynced warning:", e.message);
    return { action: "error", error: e.message };
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--deploy")) throw new Error("This isolated candidate builder never deploys.");
  if (args.has("--auto") || args.has("--sync")) {
    ensureSynced();
    if (args.has("--verify")) runVerify();
    return;
  }
  if (args.has("--split")) {
    runSplit();
    if (args.has("--verify")) {
      runVerify();
    }
    return;
  }
  if (args.has("--verify") && !args.has("--build") && !args.has("--deploy")) {
    runVerify();
    return;
  }
  runBuild();
  if (args.has("--verify")) {
    runVerify();
  }
  if (args.has("--deploy")) {
    const patchScript = path.join(path.dirname(PRIMARY_BUNDLE_PATH), "patch-pi-web.js");
    if (fs.existsSync(patchScript)) {
      require(patchScript).run({ staticOnly: true, skipBuilderSync: true });
      console.log("[build-pi-web-enhancements] Static deployment complete.");
    }
  }
}

module.exports = {
  runBuild,
  runSplit,
  runVerify,
  ensureSynced,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("[build-pi-web-enhancements] ERROR:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
