#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_FILES = Object.freeze({
  chatInput: "components/ChatInput.tsx",
  settingsPanel: "components/SettingsPanel.tsx",
  chatMinimap: "components/ChatMinimap.tsx",
  brand: "components/PiWebBrand.tsx",
  module04: "enhancements/modules/04-sidebar-and-session-management.js",
  module05: "enhancements/modules/05-composer-and-input-workflow.js",
  module06: "enhancements/modules/06-chat-view-and-tool-cards.js",
  module07: "enhancements/modules/07-kernel-scheduler-and-observers.js",
  builder: "enhancements/build-pi-web-enhancements.cjs",
});

const NATIVE_SETTINGS_SECTIONS = Object.freeze([
  "general",
  "models",
  "skills",
  "agents",
  "plugins",
  "mcp",
  "learning",
]);

const BUNDLED_MODULES = Object.freeze([
  "01-bootstrap-and-core-state.js",
  "05-composer-and-input-workflow.js",
  "06-chat-view-and-tool-cards.js",
  "07-kernel-scheduler-and-observers.js",
]);

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

function createCheck(id, name, ok, success, failure, files) {
  return {
    id,
    name,
    ok,
    message: ok ? success : failure,
    files,
  };
}

function nativeSettingsSectionIds(source) {
  const start = source.indexOf("const nativeSections");
  const end = source.indexOf("const sections = useMemo", start);
  if (start < 0 || end < 0) return null;
  const block = source.slice(start, end);
  return Array.from(block.matchAll(/\{\s*id:\s*["']([^"']+)["']/g), (match) => match[1]);
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  if (start < 0) return null;
  const bodyStart = source.indexOf("{", start);
  if (bodyStart < 0) return null;
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const indent = source.slice(lineStart, start);
  const bodyEnd = source.indexOf(`\n${indent}}`, bodyStart);
  if (bodyEnd < 0) return null;
  return source.slice(bodyStart + 1, bodyEnd);
}

function checkReleaseOwnership(sources) {
  const missing = Object.entries(SOURCE_FILES)
    .filter(([key]) => typeof sources?.[key] !== "string")
    .map(([, file]) => file);

  if (missing.length > 0) {
    return {
      ok: false,
      checks: [createCheck(
        "source-files-present",
        "检查输入文件",
        false,
        "检查所需源码文件齐全。",
        `缺少检查输入：${missing.join("、")}。`,
        missing,
      )],
    };
  }

  const chatInput = sources.chatInput;
  const module04 = sources.module04;
  const module05 = sources.module05;
  const settings = sources.settingsPanel;
  const minimap = sources.chatMinimap;
  const module06 = sources.module06;
  const module07 = sources.module07;
  const brand = sources.brand;
  const builder = sources.builder;

  const textareaStart = chatInput.indexOf("<textarea");
  const textareaHead = textareaStart < 0 ? "" : chatInput.slice(textareaStart, textareaStart + 1800);
  const nativeComposerOk =
    countMatches(chatInput, /<textarea\b/g) === 1 &&
    countMatches(chatInput, /<input\b/g) === 1 &&
    /<input\b[\s\S]{0,160}?type="file"/.test(chatInput) &&
    textareaHead.includes('className="chat-input-textarea"') &&
    textareaHead.includes("ref={textareaRef}") &&
    textareaHead.includes("value={value}") &&
    countMatches(chatInput, /data-pi-native-composer-layout="true"/g) === 1 &&
    !/\bcontentEditable\s*=/i.test(chatInput) &&
    !/\brole\s*=\s*["']textbox["']/i.test(chatInput);

  const composerFinder = functionBody(module05, "function findComposerTextarea()");
  const composerSelectors = composerFinder
    ? Array.from(composerFinder.matchAll(/document\.querySelector\(\s*(["'])(.*?)\1\s*\)/g), (match) => match[2])
    : [];
  const alternateEditorPatterns = [
    /\bcontentEditable\s*=\s*(?:\{\s*true\s*\}|true|["']true["'])/i,
    /\.contentEditable\s*=\s*["']true["']/i,
    /\.setAttribute\(\s*["']contenteditable["']\s*,\s*["']true["']\s*\)/i,
    /\brole\s*=\s*["']textbox["']/i,
    /document\.createElement\(\s*["']textarea["']\s*\)/i,
  ];
  const composerAdapterOk =
    composerSelectors[0] === "textarea.chat-input-textarea" &&
    alternateEditorPatterns.every((pattern) => !pattern.test(module05));

  const nativeSubmissionOwnerOk =
    !/\bsyncComposerAttachmentSendability\s*\(/.test(module05 + module07) &&
    chatInput.includes("__PI_ENH_PREPARE_COMPOSER_SUBMISSION__") &&
    chatInput.includes("pi-enh-composer-submission-state-change") &&
    module05.includes("__PI_ENH_GET_COMPOSER_SUBMISSION_STATE__") &&
    !/function (?:queueNativeComposerSubmission|invokeNativeComposerSubmit|installAnnotationSendBridge|handoffAnnotationsToNativeSend|syncAnnotationSendButtons)\(/.test(module04 + module05) &&
    !/__reactProps|getReactProps\(/.test(module05) &&
    ["function replaceButtonSendText(", "function restoreButtonSendText("].every((signature) => {
      const body = functionBody(module05, signature);
      return body === null || !/\.disabled\s*=/.test(body);
    });

  const sectionIds = nativeSettingsSectionIds(settings);
  const settingsNavOk =
    sectionIds !== null &&
    JSON.stringify(sectionIds) === JSON.stringify(NATIVE_SETTINGS_SECTIONS) &&
    /LEGACY_SETTINGS_EXTENSIONS\.filter\(\(ext\)\s*=>\s*isExtensionEnabled\(ext\)\)/.test(settings) &&
    /return\s*\[\s*\.\.\.nativeSections\s*,\s*\.\.\.enabledExtensions\.map\(\(ext\)\s*=>\s*\(\{/.test(settings) &&
    countMatches(settings, /\brole="dialog"/g) === 1;

  const hiddenMinimapMarker = /if\s*\(\s*!visible\s*(?:&&\s*!overlay\s*)?\)\s*return\s*\(\s*<div[\s\S]{0,400}?data-minimap-native-owner="true"/.test(minimap);
  const minimapLoadingOwnerOk = hiddenMinimapMarker &&
    countMatches(minimap, /data-minimap-native-owner="true"/g) === 2;
  const adapter = functionBody(module06, "function syncMinimapEnhancements()");
  const minimapLegacyYieldOk = adapter !== null &&
    adapter.includes("pi:minimap-preferences-change") &&
    module06.includes("window.__PI_ENH_OPEN_MINIMAP__") &&
    !/function (?:attachMinimapInteractions|ensureMinimapStyles|renderMinimapPreview|createMinimapMobileNavigator)\(/.test(module06);

  const mutationGate = functionBody(module07, "function isEditorLocalTextOrNodeMutation(m)");
  const schedulerScopeOk =
    mutationGate !== null &&
    mutationGate.includes('textarea.chat-input-textarea') &&
    mutationGate.includes('[role="dialog"]') &&
    mutationGate.includes('[role="menu"]') &&
    module07.includes("if (isEditorLocalTextOrNodeMutation(m)) continue;");

  const wordmarkParts = ["Pi", "Web", "Plus"].every((part) =>
    new RegExp(`<tspan\\b[^>]*>\\s*${part}\\s*</tspan>`).test(brand),
  );
  const inlineBrandOk =
    countMatches(brand, /<svg\b/g) === 2 &&
    /data-pi-brand-part="wordmark"/.test(brand) &&
    wordmarkParts &&
    !/<(?:img|image)\b/i.test(brand);

  const moduleFileEntries = Array.from(builder.matchAll(/\bfile:\s*["']([^"']+)["']/g), (match) => match[1]);
  const bundledModuleEntriesOk = BUNDLED_MODULES.every((file) =>
    moduleFileEntries.filter((entry) => entry === file).length === 1,
  );
  const modulePositions = BUNDLED_MODULES.map((file) => moduleFileEntries.indexOf(file));
  const moduleOrderOk = modulePositions.every((position, index) =>
    position >= 0 && (index === modulePositions.length - 1 || position < modulePositions[index + 1]),
  );
  const builderWritesOverwrite =
    /const combinedBuffer\s*=\s*Buffer\.concat\(moduleBuffers\)\s*;/.test(builder) &&
    countMatches(builder, /fs\.writeFileSync\(PRIMARY_BUNDLE_PATH,\s*combinedBuffer\)/g) === 1 &&
    countMatches(builder, /fs\.writeFileSync\(MIRROR_BUNDLE_PATH,\s*buildPublicBundle\(bundleBuffer(?:,\s*true)?\)\)/g) === 1 &&
    !/fs\.appendFile(?:Sync)?\s*\(\s*(?:PRIMARY_BUNDLE_PATH|MIRROR_BUNDLE_PATH)\b/.test(builder);
  const verifyChecksDeterministicBundle =
    /Buffer\.compare\(combinedBuffer,\s*primaryBuffer\)\s*!==\s*0/.test(builder) &&
    /mirrorBuffer\.indexOf\(combinedBuffer,\s*rawOffset\s*\+\s*1\)\s*!==\s*-1/.test(builder);
  const bundleOverwriteOk = bundledModuleEntriesOk && moduleOrderOk && builderWritesOverwrite && verifyChecksDeterministicBundle;

  const checks = [
    createCheck(
      "composer-native-single",
      "输入框由单一原生 textarea 所有",
      nativeComposerOk,
      "ChatInput 保留唯一受控原生 textarea；隐藏文件输入仍是唯一 input。",
      "ChatInput 必须只有一个带 chat-input-textarea 标识的受控 textarea、一个文件 input 和原生布局所有权标记，且不能添加 contentEditable 或 textbox。",
      [SOURCE_FILES.chatInput],
    ),
    createCheck(
      "composer-legacy-adapter",
      "输入增强适配原生输入框",
      composerAdapterOk,
      "module05 优先绑定 React textarea，现有附件、快捷操作等增强可继续保留。",
      "module05 必须先查找 textarea.chat-input-textarea，且不能创建第二个 textarea、contentEditable 编辑器或 textbox。",
      [SOURCE_FILES.module05],
    ),
    createCheck(
      "composer-native-submission-owner",
      "原生输入框统一拥有发送状态和提交入口",
      nativeSubmissionOwnerOk,
      "增强仅准备 payload 和通知状态；ChatInput 执行普通、引导与后续提交。",
      "禁止恢复旧捕获提交、React 私有属性调用或增强直接修改原生发送按钮 disabled；使用原生提交与状态桥。",
      [SOURCE_FILES.chatInput, SOURCE_FILES.module04, SOURCE_FILES.module05],
    ),
    createCheck(
      "settings-single-navigation",
      "设置由单一原生导航承载",
      settingsNavOk,
      "五个原生设置区与启用的 legacy 扩展共用一个对话框导航。",
      "SettingsPanel 必须保留 general/models/skills/agents/plugins/mcp 六个原生区，将启用的 legacy 扩展显式追加到同一导航，并只声明一个对话框根节点。",
      [SOURCE_FILES.settingsPanel],
    ),
    createCheck(
      "minimap-native-owner-loading",
      "Minimap 在加载期声明原生所有权",
      minimapLoadingOwnerOk,
      "隐藏占位与可见轨道都声明 data-minimap-native-owner，module06 可在加载阶段识别 native rail。",
      "ChatMinimap 的 hidden 占位和可见轨道都必须带 native owner 标记，module06 必须以该标记识别 native minimap。",
      [SOURCE_FILES.chatMinimap, SOURCE_FILES.module06],
    ),
    createCheck(
      "minimap-legacy-yield",
      "Minimap 仅保留原生适配",
      minimapLegacyYieldOk,
      "module06 仅转发偏好和原生导航接口，没有第二套 Minimap。",
      "module06 必须保留原生接口与偏好事件，禁止恢复已退役的渲染、样式和交互实现。",
      [SOURCE_FILES.module06],
    ),
    createCheck(
      "composer-scheduler-scope",
      "输入区调度保留交互控件",
      schedulerScopeOk,
      "module07 以原生 textarea 限定编辑器变更，并保留菜单与对话框同步路径。",
      "module07 的编辑区变更过滤必须识别原生 textarea、排除菜单/对话框，并由 DOM 同步循环实际调用。",
      [SOURCE_FILES.module07],
    ),
    createCheck(
      "brand-inline-vector",
      "品牌标识保留原生矢量字标",
      inlineBrandOk,
      "PiWebBrand 保留 π+ Pi Web Plus inline SVG 字标，不引入图片叠层。",
      "PiWebBrand 必须保留 inline SVG 字标 Pi/Web/Plus 和 wordmark 锚点，不能改为 img/image 叠层。",
      [SOURCE_FILES.brand],
    ),
    createCheck(
      "bundle-deterministic-overwrite",
      "增强 bundle 按模块确定性覆盖",
      bundleOverwriteOk,
      "指定模块顺序进入 bundle，主文件与 public 镜像均覆盖写入；验证器检查字节一致和核心 bundle 唯一。",
      "builder 必须按确定模块顺序合并并覆盖 primary/mirror 输出，且保留字节一致与 public 核心 bundle 唯一性验证；不能改为追加写入。",
      [SOURCE_FILES.builder],
    ),
  ];

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

function readSourceSnapshot(sourceDir) {
  const snapshot = {};
  for (const [key, relativePath] of Object.entries(SOURCE_FILES)) {
    const fullPath = path.join(sourceDir, relativePath);
    try {
      snapshot[key] = fs.readFileSync(fullPath, "utf8");
    } catch (error) {
      throw new Error(`无法读取 ${relativePath}：${error.message}`);
    }
  }
  return snapshot;
}

function parseArgs(argv) {
  let sourceDir = null;
  let showHelp = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (arg === "--source-dir") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) {
        throw new Error("--source-dir 后必须提供候选源码目录。");
      }
      sourceDir = argv[i + 1];
      i += 1;
      continue;
    }
    throw new Error(`未知参数：${arg}`);
  }

  if (!showHelp && !sourceDir) {
    throw new Error("必须通过 --source-dir 指定要检查的 Pi Web 候选目录。");
  }
  return { sourceDir, showHelp };
}

function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    if (args.showHelp) {
      console.log("用法：node enhancements/check-release-ownership.cjs --source-dir <Pi-Web-源码目录>");
      return 0;
    }

    const sourceDir = path.resolve(args.sourceDir);
    const report = checkReleaseOwnership(readSourceSnapshot(sourceDir));
    for (const check of report.checks) {
      const icon = check.ok ? "通过" : "失败";
      const files = check.files.length > 0 ? `（${check.files.join("、")}）` : "";
      console.log(`${check.ok ? "✓" : "✗"} ${icon}：${check.name}。${check.message}${files}`);
    }
    if (!report.ok) {
      console.error(`Pi Web 发布防叠层检查失败：${report.checks.filter((check) => !check.ok).length} 项未通过。`);
      return 1;
    }
    console.log(`Pi Web 发布防叠层检查通过：${report.checks.length} 项源码所有权契约成立。`);
    return 0;
  } catch (error) {
    console.error(`Pi Web 发布防叠层检查无法执行：${error.message}`);
    return 2;
  }
}

module.exports = {
  SOURCE_FILES,
  checkReleaseOwnership,
};

if (require.main === module) {
  process.exitCode = main();
}
