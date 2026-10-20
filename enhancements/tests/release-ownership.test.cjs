"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { checkReleaseOwnership } = require("../check-release-ownership.cjs");

function fixture() {
  const moduleFiles = [
    "01-bootstrap-and-core-state.js",
    "02-plugin-registry-and-settings-schema.js",
    "03-session-cache-and-sync-engine.js",
    "04-sidebar-and-session-management.js",
    "05-composer-and-input-workflow.js",
    "06-chat-view-and-tool-cards.js",
    "07-kernel-scheduler-and-observers.js",
    "08-settings-panels-and-lifecycle.js",
  ];

  return {
    module04: `function prepareAnnotationSubmission() {}`,
    chatInput: `
      window.__PI_ENH_PREPARE_COMPOSER_SUBMISSION__;
      window.addEventListener("pi-enh-composer-submission-state-change", refresh);
      <input type="file" />
      <div data-pi-native-composer-layout="true">
        <textarea ref={textareaRef} className="chat-input-textarea" value={value} />
      </div>
    `,
    settingsPanel: `
      const enabledExtensions = LEGACY_SETTINGS_EXTENSIONS.filter((ext) => isExtensionEnabled(ext));
      const nativeSections = [
        { id: "general" }, { id: "models" }, { id: "skills" },
        { id: "agents" }, { id: "plugins" }, { id: "mcp" }, { id: "execution-engine" }, { id: "learning" },
      ];
      const sections = useMemo(() => {
        return [ ...nativeSections, ...enabledExtensions.map((ext) => ({ id: ext.id })) ];
      }, [nativeSections, enabledExtensions]);
      return <div role="dialog" />;
    `,
    chatMinimap: `
      if (!visible) return (
        <div data-minimap-native-owner="true" aria-hidden="true" />
      );
      return <div data-minimap-native-owner="true" />;
    `,
    brand: `
      return <svg><text data-pi-brand-part="wordmark">
        <tspan>Agent Web </tspan><tspan>Plus</tspan>
      </text></svg>;
      return <svg />;
    `,
    module05: `
      window.__PI_ENH_GET_COMPOSER_SUBMISSION_STATE__;
      function findComposerTextarea() {
        return document.querySelector("textarea.chat-input-textarea") ||
          document.querySelector("textarea");
      }
    `,
    module06: `
      function syncMinimapEnhancements() {
        window.dispatchEvent(new CustomEvent("pi:minimap-preferences-change"));
      }
      window.__PI_ENH_OPEN_MINIMAP__;
    `,
    module07: `
      function isEditorLocalTextOrNodeMutation(m) {
        const insideTextarea = Boolean(targetEl.closest("textarea.chat-input-textarea"));
        if (targetEl.closest('[role="dialog"], [role="menu"]')) return false;
      }
      if (isEditorLocalTextOrNodeMutation(m)) continue;
    `,
    builder: `
      const MODULE_SPECS = [
        ${moduleFiles.map((file) => `{ file: "${file}" }`).join(",\n        ")}
      ];
      function syncMirrorBundle(bundleBuffer) {
        fs.writeFileSync(MIRROR_BUNDLE_PATH, buildPublicBundle(bundleBuffer));
      }
      function runBuild() {
        const combinedBuffer = Buffer.concat(moduleBuffers);
        fs.writeFileSync(PRIMARY_BUNDLE_PATH, combinedBuffer);
        syncMirrorBundle(combinedBuffer);
      }
      function runVerify() {
        if (Buffer.compare(combinedBuffer, primaryBuffer) !== 0) throw new Error();
        if (mirrorBuffer.indexOf(combinedBuffer, rawOffset + 1) !== -1) throw new Error();
      }
    `,
  };
}

function failingCheck(report, id) {
  assert.equal(report.ok, false, "fixture 应触发发布门禁失败");
  assert.ok(report.checks.some((check) => check.id === id && !check.ok), `应报告 ${id}`);
}

test("接受原生 React ownership 与确定性 bundle fixture", () => {
  const report = checkReleaseOwnership(fixture());
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => !check.ok), null, 2));
});

test("发现新增的第二个 React 可编辑表面", () => {
  const sources = fixture();
  sources.chatInput = sources.chatInput.replace(
    "</div>",
    '</div><div contentEditable={true} role="textbox" />',
  );
  failingCheck(checkReleaseOwnership(sources), "composer-native-single");
});

test("发现 module05 注入第二个 contentEditable 编辑器", () => {
  const sources = fixture();
  sources.module05 += '\nconst editor = document.createElement("div"); editor.contentEditable = "true";';
  failingCheck(checkReleaseOwnership(sources), "composer-legacy-adapter");
});

test("发现原生设置 section 被移除", () => {
  const sources = fixture();
  sources.settingsPanel = sources.settingsPanel.replace('{ id: "models" }, ', "");
  failingCheck(checkReleaseOwnership(sources), "settings-single-navigation");
});

test("发现设置面板新增第二个对话框叠层", () => {
  const sources = fixture();
  sources.settingsPanel += '<div role="dialog" />';
  failingCheck(checkReleaseOwnership(sources), "settings-single-navigation");
});

test("发现 minimap 隐藏加载占位失去所有权标记", () => {
  const sources = fixture();
  sources.chatMinimap = sources.chatMinimap.replace(
    '<div data-minimap-native-owner="true" aria-hidden="true" />',
    '<div aria-hidden="true" />',
  );
  failingCheck(checkReleaseOwnership(sources), "minimap-native-owner-loading");
});

test("发现已退役的 legacy minimap 交互重新进入主包", () => {
  const sources = fixture();
  sources.module06 += "\nfunction attachMinimapInteractions() {}";
  failingCheck(checkReleaseOwnership(sources), "minimap-legacy-yield");
});

test("发现品牌字标改为图片叠层", () => {
  const sources = fixture();
  sources.brand += '<img src="/legacy-logo.png" />';
  failingCheck(checkReleaseOwnership(sources), "brand-inline-vector");
});

test("发现 bundle 构建从覆盖写改为追加写", () => {
  const sources = fixture();
  sources.builder = sources.builder.replace(
    "fs.writeFileSync(PRIMARY_BUNDLE_PATH, combinedBuffer);",
    "fs.appendFileSync(PRIMARY_BUNDLE_PATH, combinedBuffer);",
  );
  failingCheck(checkReleaseOwnership(sources), "bundle-deterministic-overwrite");
});


test("拒绝旧捕获提交桥重新进入主包", () => {
  const sources=fixture(); sources.module04 += "\nfunction installAnnotationSendBridge() {}";
  failingCheck(checkReleaseOwnership(sources),"composer-native-submission-owner");
});
test("拒绝增强改写原生按钮 disabled 或调用私有 React props", () => {
  for(const extra of ["\nfunction replaceButtonSendText(button) {\n  button.disabled = false;\n}","\ngetReactProps(sendButton).onClick();"]){
    const sources=fixture();sources.module05+=extra;
    failingCheck(checkReleaseOwnership(sources),"composer-native-submission-owner");
  }
});

test("拒绝调度器继续调用已退役的附件按钮覆盖函数", () => {
  const sources=fixture();sources.module07+="\nsyncComposerAttachmentSendability(card, textarea);";
  failingCheck(checkReleaseOwnership(sources),"composer-native-submission-owner");
});
