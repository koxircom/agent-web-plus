#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");
const { withGlobalBuildLock } = require("./pi-web-enhancement-locks.cjs");
const { runSessionDeleteRegressionGate } = require("./session-delete-regression-gate.cjs");

const PRIMARY_BUNDLE_PATH = "/root/.pi/agent/scripts/pi-web-enhancements.js";
const MIRROR_BUNDLE_PATH = "/workspace/pi-web/enhancements/pi-web-enhancements.js";
const MODULES_DIR = "/root/.pi/agent/scripts/enhancements/modules";
const MANIFEST_PATH = path.join(MODULES_DIR, "manifest.json");

const MODULE_SPECS = [
  {
    index: 1,
    id: "01-bootstrap-and-core-state",
    name: "01-bootstrap-and-core-state.js",
    file: "01-bootstrap-and-core-state.js",
    startAnchor: null,
    responsibility:
      "IIFE 启动引导、路由自愈保护、页面标题脱敏防抖、顶层 TDZ 声明提升、Managed Lifecycle 零泄漏注册表、全局 CSS 样式表注入、通知偏好与历史、Toast 与剪贴板工具。",
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
      "会话内存秒开缓存 (Session Memory Cache)、CacheStorage/IndexedDB 统一持久化存储抽象、会话历史顺序防回退守卫 (session-history-order-guard)、高性能会话搜索 LRU 缓存与归档折叠管理、权威终态核验引擎 (Terminal Reconcile Engine)、DOM 快照秒开与跨端多标签页同步。",
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

function sanitizeForPublicRepo(text) {
  return String(text || "")
    .replace(/C:\/Users\/KOXIR/g, "~")
    .replace(/C:\\\\Users\\\\KOXIR/g, "~")
    .replace(/C:\\Users\\demo/g, "~")
    .replace(/10\.0\.0\.2/g, "127.0.0.1")
    .replace(/10\.0\.0\.89/g, "127.0.0.1")
    .replace(/10\.7\.7\.2/g, "127.0.0.1")
    .replace(/192\.168\.255\.6/g, "127.0.0.1");
}

function writeFileIfChanged(filePath, content, encoding) {
  const nextBuf = Buffer.isBuffer(content)
    ? content
    : Buffer.from(String(content), encoding || "utf8");
  if (fs.existsSync(filePath)) {
    try {
      const curBuf = fs.readFileSync(filePath);
      if (Buffer.compare(curBuf, nextBuf) === 0) {
        return false;
      }
    } catch (_) {}
  }
  fs.writeFileSync(filePath, nextBuf);
  return true;
}

function resolveMirrorPackageVersion(mirrorBundlePath = MIRROR_BUNDLE_PATH, options = {}) {
  if (typeof options.mirrorVersion === "string" && options.mirrorVersion.trim()) {
    return options.mirrorVersion.trim();
  }
  const candidatePkgPaths = [];
  if (mirrorBundlePath) {
    const mirrorDir = path.dirname(path.resolve(mirrorBundlePath));
    candidatePkgPaths.push(path.join(path.dirname(mirrorDir), "package.json"));
  }
  candidatePkgPaths.push(
    "/workspace/pi-web/package.json",
    "/usr/local/lib/node_modules/@agegr/pi-web/package.json"
  );
  for (const pkgPath of candidatePkgPaths) {
    try {
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (typeof pkg.version === "string" && pkg.version.trim()) {
          return pkg.version.trim();
        }
      }
    } catch (_) {}
  }
  return "1.0.5";
}

function assertMirrorNotCanonical(mirrorBundlePath, options = {}) {
  if (!mirrorBundlePath) return;
  const resolvedMirrorBundle = path.resolve(mirrorBundlePath);
  const mirrorDir = path.dirname(resolvedMirrorBundle);
  const mirrorModulesDir = path.join(mirrorDir, "modules");
  const canonicalBundles = new Set(
    [
      path.resolve(PRIMARY_BUNDLE_PATH),
      options.primaryBundlePath ? path.resolve(options.primaryBundlePath) : null,
    ].filter(Boolean)
  );
  const canonicalModuleDirs = new Set(
    [
      path.resolve(MODULES_DIR),
      options.modulesDir ? path.resolve(options.modulesDir) : null,
    ].filter(Boolean)
  );
  if (
    canonicalBundles.has(resolvedMirrorBundle) ||
    canonicalModuleDirs.has(path.resolve(mirrorDir)) ||
    canonicalModuleDirs.has(path.resolve(mirrorModulesDir))
  ) {
    const err = new Error(
      `Refusing to overwrite canonical enhancement source (${resolvedMirrorBundle}) with sanitized mirror output.`
    );
    err.code = "ENHANCEMENT_MIRROR_CANONICAL_COLLISION";
    throw err;
  }
}

function buildSanitizedMirrorSnapshot(
  bundleBuffer,
  mirrorBundlePath = MIRROR_BUNDLE_PATH,
  options = {}
) {
  let rawModuleBuffers =
    Array.isArray(options.moduleBuffers) && options.moduleBuffers.length === MODULE_SPECS.length
      ? options.moduleBuffers
      : null;

  if (!rawModuleBuffers) {
    const canonicalModulesDir = options.modulesDir
      ? path.resolve(options.modulesDir)
      : MODULES_DIR;
    if (
      fs.existsSync(canonicalModulesDir) &&
      MODULE_SPECS.every((s) => fs.existsSync(path.join(canonicalModulesDir, s.file)))
    ) {
      const diskBuffers = MODULE_SPECS.map((s) =>
        fs.readFileSync(path.join(canonicalModulesDir, s.file))
      );
      if (Buffer.compare(Buffer.concat(diskBuffers), bundleBuffer) === 0) {
        rawModuleBuffers = diskBuffers;
      }
    }
  }

  if (!rawModuleBuffers) {
    const rawText = bundleBuffer.toString("utf8");
    const lineChunks = splitIntoLineChunks(rawText);
    const boundaries = resolveModuleBoundaries(lineChunks);
    rawModuleBuffers = boundaries.map((b) =>
      Buffer.from(lineChunks.slice(b.startLine - 1, b.endLine).join(""), "utf8")
    );
  }

  const sanitizedModuleBuffers = [];
  const mirrorManifestModules = [];
  let currentLine = 1;

  for (let i = 0; i < MODULE_SPECS.length; i++) {
    const spec = MODULE_SPECS[i];
    const sanText = sanitizeForPublicRepo(rawModuleBuffers[i].toString("utf8"));
    const sanBuf = Buffer.from(sanText, "utf8");
    const chunks = splitIntoLineChunks(sanText);
    const startLine = currentLine;
    const endLine = startLine + chunks.length - 1;
    currentLine = endLine + 1;

    sanitizedModuleBuffers.push(sanBuf);
    mirrorManifestModules.push({
      index: spec.index,
      id: spec.id,
      name: spec.name,
      file: spec.file,
      startLine,
      endLine,
      lineCount: chunks.length,
      lineRange: [startLine, endLine],
      lineRangeText: `${startLine}-${endLine}`,
      bytes: sanBuf.length,
      sha256: sha256Hex(sanBuf),
      responsibility: spec.responsibility,
    });
  }

  const sanitizedBundleBuffer = Buffer.concat(sanitizedModuleBuffers);
  const mirrorVersion = resolveMirrorPackageVersion(mirrorBundlePath, options);
  const mirrorManifest = {
    schemaVersion: 1,
    edition: `koxir-standalone-${mirrorVersion}`,
    version: mirrorVersion,
    targetFile: "enhancements/pi-web-enhancements.js",
    mirrorFile: "public/pi-web-enhancements.js",
    totalLines: currentLine - 1,
    totalBytes: sanitizedBundleBuffer.length,
    bundleSha256: sha256Hex(sanitizedBundleBuffer),
    modules: mirrorManifestModules,
  };

  return {
    sanitizedBundleBuffer,
    sanitizedModuleBuffers,
    mirrorManifest,
    mirrorVersion,
  };
}

function syncMirrorBundle(bundleBuffer, mirrorBundlePath = MIRROR_BUNDLE_PATH, options = {}) {
  if (!mirrorBundlePath) return null;
  assertMirrorNotCanonical(mirrorBundlePath, options);
  const resolvedMirrorBundle = path.resolve(mirrorBundlePath);
  const mirrorDir = path.dirname(resolvedMirrorBundle);
  if (fs.existsSync(mirrorDir)) {
    const snapshot = buildSanitizedMirrorSnapshot(bundleBuffer, resolvedMirrorBundle, options);
    writeFileIfChanged(resolvedMirrorBundle, snapshot.sanitizedBundleBuffer);
    const publicMirror = path.join(path.dirname(mirrorDir), "public", "pi-web-enhancements.js");
    if (fs.existsSync(path.dirname(publicMirror))) {
      writeFileIfChanged(publicMirror, snapshot.sanitizedBundleBuffer);
    }
    if (options.syncMirrorModules !== false) {
      const mirrorModulesDir = path.join(mirrorDir, "modules");
      fs.mkdirSync(mirrorModulesDir, { recursive: true });
      for (let i = 0; i < MODULE_SPECS.length; i++) {
        const spec = MODULE_SPECS[i];
        writeFileIfChanged(
          path.join(mirrorModulesDir, spec.file),
          snapshot.sanitizedModuleBuffers[i]
        );
      }
      writeFileIfChanged(
        path.join(mirrorModulesDir, "manifest.json"),
        JSON.stringify(snapshot.mirrorManifest, null, 2) + "\n",
        "utf8"
      );
    }
    return snapshot.mirrorManifest;
  }
  return null;
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

function resolveBuildPaths(options = {}) {
  const modulesDir = options.modulesDir ? path.resolve(options.modulesDir) : MODULES_DIR;
  const primaryBundlePath = options.primaryBundlePath
    ? path.resolve(options.primaryBundlePath)
    : PRIMARY_BUNDLE_PATH;
  const mirrorBundlePath =
    options.mirrorBundlePath !== undefined
      ? options.mirrorBundlePath
        ? path.resolve(options.mirrorBundlePath)
        : null
      : MIRROR_BUNDLE_PATH;
  const manifestPath = options.manifestPath
    ? path.resolve(options.manifestPath)
    : path.join(modulesDir, "manifest.json");
  return { modulesDir, primaryBundlePath, mirrorBundlePath, manifestPath };
}

function runSplit(options = {}) {
  const { modulesDir, primaryBundlePath, mirrorBundlePath, manifestPath } =
    resolveBuildPaths(options);

  return withGlobalBuildLock(
    {
      ...options,
      modulesDir,
      operation: options.operation || "split",
    },
    () => {
      if (!fs.existsSync(primaryBundlePath)) {
        throw new Error(`Source bundle not found: ${primaryBundlePath}`);
      }
      const rawBuffer = fs.readFileSync(primaryBundlePath);
      const rawText = rawBuffer.toString("utf8");

      validateSyntaxGate(rawText, primaryBundlePath);

      const lineChunks = splitIntoLineChunks(rawText);
      const boundaries = resolveModuleBoundaries(lineChunks);

      const moduleBuffers = [];
      const manifestModules = [];
      for (const b of boundaries) {
        const moduleText = lineChunks.slice(b.startLine - 1, b.endLine).join("");
        const moduleBuffer = Buffer.from(moduleText, "utf8");
        moduleBuffers.push(moduleBuffer);

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

      runSessionDeleteRegressionGate({
        modulesDir,
        candidateModules: boundaries.map((boundary, index) => ({
          file: boundary.file,
          content: moduleBuffers[index],
        })),
        candidateBundleText: rawText,
        stateFile: options.stateFile,
        enforceUnlockedDiffCheck: options.enforceUnlockedDiffCheck,
        nonProductionFixture: options.nonProductionFixture,
        operation: "split-candidate",
      });

      fs.mkdirSync(modulesDir, { recursive: true });
      for (let i = 0; i < boundaries.length; i += 1) {
        writeFileIfChanged(path.join(modulesDir, boundaries[i].file), moduleBuffers[i]);
      }

      const manifest = {
        schemaVersion: 1,
        edition: "koxir-standalone-1.0.0",
        version: "1.0.0",
        targetFile: primaryBundlePath,
        mirrorFile: mirrorBundlePath || MIRROR_BUNDLE_PATH,
        totalLines: lineChunks.length,
        totalBytes: rawBuffer.length,
        bundleSha256: sha256Hex(rawBuffer),
        modules: manifestModules,
      };

      writeFileIfChanged(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      syncMirrorBundle(rawBuffer, mirrorBundlePath, {
        ...options,
        modulesDir,
        primaryBundlePath,
        moduleBuffers,
      });

      console.log(
        `[build-pi-web-enhancements] Split complete: ${manifestModules.length} modules (${manifest.totalLines} lines, ${manifest.totalBytes} bytes, sha256=${manifest.bundleSha256.slice(0, 12)}...).`
      );
      return manifest;
    }
  );
}

function runBuild(options = {}) {
  const { modulesDir, primaryBundlePath, mirrorBundlePath, manifestPath } =
    resolveBuildPaths(options);

  return withGlobalBuildLock(
    {
      ...options,
      modulesDir,
      operation: options.operation || "build",
    },
    () => {
      const moduleBuffers = [];
      const manifestModules = [];
      let currentLine = 1;

      for (const spec of MODULE_SPECS) {
        const modulePath = path.join(modulesDir, spec.file);
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

      validateSyntaxGate(combinedText, primaryBundlePath);

      runSessionDeleteRegressionGate({
        modulesDir,
        candidateModules: MODULE_SPECS.map((spec, index) => ({
          file: spec.file,
          content: moduleBuffers[index],
        })),
        candidateBundleText: combinedText,
        stateFile: options.stateFile,
        enforceUnlockedDiffCheck: options.enforceUnlockedDiffCheck,
        nonProductionFixture: options.nonProductionFixture,
        operation: "build-candidate",
      });

      fs.mkdirSync(path.dirname(primaryBundlePath), { recursive: true });
      writeFileIfChanged(primaryBundlePath, combinedBuffer);
      syncMirrorBundle(combinedBuffer, mirrorBundlePath, {
        ...options,
        modulesDir,
        primaryBundlePath,
        moduleBuffers,
      });

      const manifest = {
        schemaVersion: 1,
        edition: "koxir-standalone-1.0.0",
        version: "1.0.0",
        targetFile: primaryBundlePath,
        mirrorFile: mirrorBundlePath || MIRROR_BUNDLE_PATH,
        totalLines: currentLine - 1,
        totalBytes: combinedBuffer.length,
        bundleSha256: sha256Hex(combinedBuffer),
        modules: manifestModules,
      };
      writeFileIfChanged(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

      console.log(
        `[build-pi-web-enhancements] Build complete: ${manifest.totalLines} lines, ${manifest.totalBytes} bytes, vm.Script syntax gate passed.`
      );
      return manifest;
    }
  );
}

function runVerify(options = {}) {
  const { modulesDir, primaryBundlePath, mirrorBundlePath, manifestPath } =
    resolveBuildPaths(options);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
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
    const modulePath = path.join(modulesDir, spec.file);
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

  validateSyntaxGate(combinedText, primaryBundlePath);

  const primaryBuffer = fs.readFileSync(primaryBundlePath);
  if (Buffer.compare(combinedBuffer, primaryBuffer) !== 0) {
    throw new Error(
      `Combined modules do not match ${primaryBundlePath} byte-for-byte (combined=${combinedBuffer.length}B, primary=${primaryBuffer.length}B).`
    );
  }

  if (mirrorBundlePath && fs.existsSync(mirrorBundlePath)) {
    assertMirrorNotCanonical(mirrorBundlePath, { modulesDir, primaryBundlePath });
    const mirrorSnapshot = buildSanitizedMirrorSnapshot(combinedBuffer, mirrorBundlePath, {
      ...options,
      modulesDir,
      primaryBundlePath,
      moduleBuffers,
    });
    const mirrorBuffer = fs.readFileSync(mirrorBundlePath);
    const expectedMirrorBuffer = mirrorSnapshot.sanitizedBundleBuffer;
    if (Buffer.compare(expectedMirrorBuffer, mirrorBuffer) !== 0) {
      throw new Error(
        `Sanitized combined modules do not match ${mirrorBundlePath} byte-for-byte (expected=${expectedMirrorBuffer.length}B, mirror=${mirrorBuffer.length}B).`
      );
    }
    const mirrorDir = path.dirname(mirrorBundlePath);
    const publicMirror = path.join(path.dirname(mirrorDir), "public", "pi-web-enhancements.js");
    if (fs.existsSync(publicMirror)) {
      const publicMirrorBuffer = fs.readFileSync(publicMirror);
      if (Buffer.compare(expectedMirrorBuffer, publicMirrorBuffer) !== 0) {
        throw new Error(
          `Sanitized combined modules do not match ${publicMirror} byte-for-byte (expected=${expectedMirrorBuffer.length}B, public=${publicMirrorBuffer.length}B).`
        );
      }
    }
    const mirrorModulesDir = path.join(mirrorDir, "modules");
    const mirrorManifestPath = path.join(mirrorModulesDir, "manifest.json");
    if (fs.existsSync(mirrorModulesDir) || fs.existsSync(mirrorManifestPath)) {
      if (!fs.existsSync(mirrorManifestPath)) {
        throw new Error(`Mirror manifest not found: ${mirrorManifestPath}`);
      }
      const mirrorManifest = JSON.parse(fs.readFileSync(mirrorManifestPath, "utf8"));
      const expectedMirrorManifest = mirrorSnapshot.mirrorManifest;
      if (mirrorManifest.version !== expectedMirrorManifest.version) {
        throw new Error(
          `Mirror manifest version mismatch: expected ${expectedMirrorManifest.version}, got ${mirrorManifest.version}`
        );
      }
      if (mirrorManifest.edition !== expectedMirrorManifest.edition) {
        throw new Error(
          `Mirror manifest edition mismatch: expected ${expectedMirrorManifest.edition}, got ${mirrorManifest.edition}`
        );
      }
      if (mirrorManifest.bundleSha256 !== expectedMirrorManifest.bundleSha256) {
        throw new Error(
          `Mirror manifest bundleSha256 mismatch: expected ${expectedMirrorManifest.bundleSha256}, got ${mirrorManifest.bundleSha256}`
        );
      }
      if (
        !Array.isArray(mirrorManifest.modules) ||
        mirrorManifest.modules.length !== MODULE_SPECS.length
      ) {
        throw new Error(
          `Mirror manifest module count mismatch: expected ${MODULE_SPECS.length}, got ${mirrorManifest.modules?.length}`
        );
      }
      for (let i = 0; i < MODULE_SPECS.length; i++) {
        const spec = MODULE_SPECS[i];
        const mirrorModPath = path.join(mirrorModulesDir, spec.file);
        if (!fs.existsSync(mirrorModPath)) {
          throw new Error(`Mirror module file missing: ${mirrorModPath}`);
        }
        const actualMirrorModBuf = fs.readFileSync(mirrorModPath);
        const expectedMirrorModBuf = mirrorSnapshot.sanitizedModuleBuffers[i];
        if (Buffer.compare(expectedMirrorModBuf, actualMirrorModBuf) !== 0) {
          throw new Error(
            `Mirror module ${spec.file} does not match sanitized canonical module byte-for-byte.`
          );
        }
        const mirrorEntry = mirrorManifest.modules[i];
        const expectedEntry = expectedMirrorManifest.modules[i];
        if (
          !mirrorEntry ||
          mirrorEntry.file !== expectedEntry.file ||
          mirrorEntry.sha256 !== expectedEntry.sha256 ||
          mirrorEntry.startLine !== expectedEntry.startLine ||
          mirrorEntry.endLine !== expectedEntry.endLine ||
          mirrorEntry.bytes !== expectedEntry.bytes
        ) {
          throw new Error(
            `Mirror manifest entry mismatch for ${spec.file}: expected sha256=${expectedEntry.sha256} (${expectedEntry.lineRangeText}), got sha256=${mirrorEntry?.sha256} (${mirrorEntry?.lineRangeText})`
          );
        }
      }
    }
  }

  const combinedSha = sha256Hex(combinedBuffer);
  if (manifest.bundleSha256 !== combinedSha) {
    throw new Error(`Bundle SHA256 mismatch: manifest=${manifest.bundleSha256}, actual=${combinedSha}`);
  }

  console.log(
    `[build-pi-web-enhancements] Verify OK: ${MODULE_SPECS.length} modules === ${primaryBundlePath} & ${mirrorBundlePath} (${manifest.totalLines} lines, ${combinedBuffer.length} bytes, sha256=${combinedSha.slice(0, 12)}..., vm.Script syntax OK).`
  );
}

function ensureSynced(options = {}) {
  const { modulesDir, primaryBundlePath, mirrorBundlePath, manifestPath } =
    resolveBuildPaths(options);

  return withGlobalBuildLock(
    {
      ...options,
      modulesDir,
      operation: options.operation || "ensure-synced",
    },
    ({ operationToken }) => {
      const nestedOpts = { ...options, operationToken };
      if (!fs.existsSync(manifestPath)) {
        if (fs.existsSync(primaryBundlePath)) {
          runSplit(nestedOpts);
          return { action: "split", operationToken };
        }
        return { action: "none", operationToken };
      }

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      let modulesChanged = false;
      for (let i = 0; i < MODULE_SPECS.length; i++) {
        const spec = MODULE_SPECS[i];
        const entry = manifest.modules && manifest.modules[i];
        const modulePath = path.join(modulesDir, spec.file);
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
        runBuild(nestedOpts);
        return { action: "build-from-modules", operationToken };
      }
      if (fs.existsSync(primaryBundlePath)) {
        const bundleSha = sha256Hex(fs.readFileSync(primaryBundlePath));
        if (bundleSha !== manifest.bundleSha256) {
          runSplit(nestedOpts);
          return { action: "split-from-bundle", operationToken };
        }
      }
      if (mirrorBundlePath && fs.existsSync(path.dirname(mirrorBundlePath))) {
        try {
          runVerify(nestedOpts);
        } catch (_) {
          runBuild(nestedOpts);
          return { action: "sync-mirror-from-canonical", operationToken };
        }
      }
      return { action: "noop", operationToken };
    }
  );
}

function main(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const args = new Set(argv);

  if (args.has("--stage") || args.has("--component-publish") || args.has("--publish-candidate")) {
    const compScript = path.join(__dirname, "pi-web-component-release.cjs");
    if (fs.existsSync(compScript)) {
      return require(compScript).runCli(argv);
    }
  }

  if (
    args.has("--verify") &&
    !args.has("--build") &&
    !args.has("--deploy") &&
    !args.has("--split") &&
    !args.has("--auto") &&
    !args.has("--sync")
  ) {
    runVerify(options);
    return;
  }

  if (args.has("--deploy") && !args.has("--module")) {
    console.log(
      "[build-pi-web-enhancements] 提示：推荐使用组件解耦发布工作流: node /root/.pi/agent/scripts/pi-web-component-release.cjs stage --module <XX> && node /root/.pi/agent/scripts/pi-web-component-release.cjs publish --candidate <ID>"
    );
  }

  const { modulesDir, primaryBundlePath } = resolveBuildPaths(options);

  return withGlobalBuildLock(
    {
      ...options,
      modulesDir,
      operation: args.has("--deploy")
        ? "build-and-deploy"
        : args.has("--split")
          ? "split"
          : args.has("--auto") || args.has("--sync")
            ? "ensure-synced"
            : "build",
    },
    ({ operationToken }) => {
      const nestedOpts = { ...options, operationToken };
      if (args.has("--auto") || args.has("--sync")) {
        ensureSynced(nestedOpts);
        if (args.has("--verify")) runVerify(nestedOpts);
        return;
      }
      if (args.has("--split")) {
        runSplit(nestedOpts);
        if (args.has("--verify")) {
          runVerify(nestedOpts);
        }
        return;
      }
      runBuild(nestedOpts);
      if (args.has("--verify")) {
        runVerify(nestedOpts);
      }
      if (args.has("--deploy")) {
        const patchScript =
          options.patchScriptPath || path.join(path.dirname(primaryBundlePath), "patch-pi-web.js");
        if (fs.existsSync(patchScript)) {
          require(patchScript).run({
            ...nestedOpts,
            staticOnly: true,
            syncLayoutInline: true,
            skipBuilderSync: true,
            operationToken,
          });
          console.log("[build-pi-web-enhancements] Static deployment complete.");
        }
      }
    }
  );
}

module.exports = {
  runBuild,
  runSplit,
  runVerify,
  ensureSynced,
  main,
  sanitizeForPublicRepo,
  syncMirrorBundle,
  resolveMirrorPackageVersion,
  buildSanitizedMirrorSnapshot,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error("[build-pi-web-enhancements] ERROR:", err && err.stack ? err.stack : err);
    process.exit(1);
  }
}
