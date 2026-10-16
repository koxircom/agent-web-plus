import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatInput, ModelErrorBanner, canClearBuiltinCommandInput, canRestoreUserMessage, canRunBuiltinSlashCommandWhileStreaming, compressImageFile, cycleListIndex, draftImagesToAttachedImages, filterModelOptions, getTooManyImagesNotice, getUpwardMenuMaxHeight, getUserMessageText, getUserMessageDraftImages, isExactSlashCommand, modelSupportsImageInput, offersBuiltinSlashCommandWhileStreaming, replaceLinksWithMarkdown, shouldCompressImageFile, submitsSlashCommandOnEnter } = await jiti.import("./ChatInput.tsx");
const { isBareMcpCommand } = await jiti.import("@/lib/mcp-command.ts");
const { ModelSelector } = await jiti.import("./ModelSelector.tsx");
const { clearDraft, getDraft, mergeRestoredSubmissionDraft, mergeRestoredSubmissionText, rekeyDraft, setDraft } = await jiti.import("@/lib/draft-store.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

test("native textarea grows to eight visual lines and preserves explicit locking", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "resizeChatInputTextarea");
  const script = new Script(ts.transpileModule(declaration.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText);
  const metrics = { paddingTop: "4px", paddingBottom: "4px", borderTopWidth: "1px", borderBottomWidth: "1px", lineHeight: "24px", fontSize: "15px" };
  const context = { exports: {}, getComputedStyle: () => metrics };
  script.runInNewContext(context);
  const resize = context.exports.resizeChatInputTextarea;
  let manual = false;
  let native = true;
  const card = { dataset: {} };
  const textarea = { value: "文字", style: { height: "auto" }, scrollHeight: 32,
    closest(selector) { return selector === ".chat-composer-custom-height" ? manual : native ? card : null; } };
  resize(textarea);
  assert.equal(textarea.style.height, "34px", "one visual line includes padding and borders");
  textarea.scrollHeight = 200;
  resize(textarea);
  assert.equal(textarea.style.height, "202px", "eight visual lines fit");
  textarea.scrollHeight = 296;
  resize(textarea);
  assert.equal(textarea.style.height, "202px", "overflow, including wrapped text, is capped at eight lines");
  metrics.lineHeight = "32px";
  resize(textarea);
  assert.equal(textarea.style.height, "266px", "cap follows the rendered font, not a fixed pixel height");
  textarea.scrollHeight = 40;
  resize(textarea);
  assert.equal(textarea.style.height, "42px", "deleting text shrinks the input");
  textarea.value = "";
  resize(textarea);
  assert.equal(textarea.style.height, "auto", "empty input returns to its CSS minimum");
  manual = true;
  for (const height of ["60px", "360px"]) {
    textarea.value = "多行文字";
    textarea.scrollHeight = 600;
    textarea.style.height = height;
    resize(textarea);
    assert.equal(textarea.style.height, height, "manual height wins above and below the automatic cap");
  }
  manual = false;
  card.dataset.composerMinHeight = "100";
  textarea.scrollHeight = 40;
  resize(textarea);
  assert.equal(textarea.style.height, "100px", "unlocked drag sets a starting height");
  textarea.scrollHeight = 200;
  resize(textarea);
  assert.equal(textarea.style.height, "202px", "content grows past an unlocked starting height");
  textarea.value = "";
  resize(textarea);
  assert.equal(textarea.style.height, "100px", "empty draft keeps its unlocked starting height");
  delete card.dataset.composerMinHeight;
  native = false;
  textarea.value = "长文本";
  textarea.scrollHeight = 600;
  resize(textarea);
  assert.equal(textarea.style.height, "200px", "classic layout keeps its existing cap");
});

test("preserves pasted HTML links as Markdown without changing plain text layout", () => {
  const link = (label, href, occurrence = 0) => ({ label, href, occurrence });

  assert.equal(
    replaceLinksWithMarkdown(
      "Jobs:\nEngineer\nEngineer\nDone",
      [link("Engineer", "https://example.com/1"), link("Engineer", "https://example.com/2", 1)],
    ),
    "Jobs:\n[Engineer](https://example.com/1)\n[Engineer](https://example.com/2)\nDone",
  );
  assert.equal(
    replaceLinksWithMarkdown("Read [this]", [link("[this]", "https://example.com/a_(b)")]),
    "Read [\\[this\\]](https://example.com/a_\\(b\\))",
  );
  assert.equal(
    replaceLinksWithMarkdown("Engineer and Engineer", [link("Engineer", "https://example.com/job", 1)]),
    "Engineer and [Engineer](https://example.com/job)",
  );
  assert.equal(replaceLinksWithMarkdown("plain text", [link("missing", "https://example.com")]), null);
});

test("follow-up shortcuts preserve newline, IME, mobile and completion behavior", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  // Execute the component's actual callback without mounting the rest of the UI.
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  const cases = [
    ["Enter follows up", {}, {}, "followup"],
    ["Ctrl+Enter steers", { ctrlKey: true }, {}, "steer"],
    ["Cmd+Enter steers", { metaKey: true }, {}, "steer"],
    ["Alt+Enter follows up", { altKey: true }, {}, "followup"],
    ["idle Alt+Enter sends", { altKey: true }, { isStreaming: false }, "send"],
    ["Shift+Enter inserts a newline", { shiftKey: true }, {}, "native"],
    ["Alt+Shift+Enter keeps native behavior", { altKey: true, shiftKey: true }, {}, "native"],
    ["composition ref blocks sending", { altKey: true }, { isComposingRef: { current: true } }, "native"],
    ["native composition blocks sending", { altKey: true, nativeEvent: { isComposing: true } }, {}, "native"],
    ["IME keyCode blocks sending", { altKey: true, nativeEvent: { keyCode: 229 } }, {}, "native"],
    ["composition grace blocks sending", { altKey: true }, { lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["mobile Alt+Enter keeps native behavior", { altKey: true }, { isMobile: true }, "native"],
    ["mobile composition grace cannot send", { altKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "native"],
    ["mobile Ctrl+Alt+Enter steers", { altKey: true, ctrlKey: true }, { isMobile: true }, "steer"],
    ["mobile Cmd+Alt+Enter steers", { altKey: true, metaKey: true }, { isMobile: true }, "steer"],
    ["mobile modified Enter respects composition grace", { altKey: true, ctrlKey: true }, { isMobile: true, lastCompositionEndAtRef: { current: 950 } }, "prevented"],
    ["Ctrl+Enter falls back to follow-up", { ctrlKey: true }, { onSteer: undefined }, "followup"],
    ["Cmd+Enter falls back to follow-up", { metaKey: true }, { onSteer: undefined }, "followup"],
    ["slash completion takes priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "help" }, "slash"],
    ["available built-in commands take priority", { altKey: true }, { slashMenuOpen: true, slashQuery: "copy", value: "/copy", displayedSlashCommands: [{ name: "copy", source: "builtin", availableWhileStreaming: true }] }, "send"],
    ["pi's built-in /mcp submits at once, also while streaming", {}, { slashMenuOpen: true, slashQuery: "mcp", value: "/mcp", displayedSlashCommands: [{ name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } }] }, "send"],
    ["another extension's /mcp completes first", {}, { slashMenuOpen: true, slashQuery: "mcp", value: "/mcp", displayedSlashCommands: [{ name: "mcp", source: "extension", sourceInfo: { path: "/ext/mcp.ts" } }] }, "slash"],
    ["file completion takes priority", { altKey: true }, { atMenuOpen: true, atQuery: {} }, "file"],
    ["history selection takes priority", { altKey: true }, { historyMenuOpen: true }, "history"],
  ];
  for (const [name, keys, state, expected] of cases) {
    let action = "native";
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: true,
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      onSteer() {}, onFollowUp() {},
      sendQueued(mode) { action = mode; }, handleSend() { action = "send"; },
      applySlashCommand() { action = "slash"; },
      submitsSlashCommandOnEnter, isBareMcpCommand, value: "", setSlashMenuOpen() {},
      applyAtCompletion() { action = "file"; },
      applyHistoryInput() { action = "history"; },
      ...state,
    });
    handler({
      key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 13 },
      preventDefault() { action = "prevented"; },
      ...keys,
    });
    assert.equal(action, expected, name);
  }
});

test("file mention arrows wrap around the match list", () => {
  const source = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findHandler(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleKeyDown") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findHandler);
  }
  const script = new Script(ts.transpileModule(findHandler(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);

  function move(key, atActiveIndex, length) {
    let next = null;
    const handler = script.runInNewContext({
      Date: { now: () => 1000 },
      COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, isStreaming: false,
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: [], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [], slashActiveIndex: 0,
      atMenuOpen: true, atQuery: {}, atMatches: Array.from({ length }, () => ({})), atActiveIndex,
      onSteer() {}, onFollowUp() {},
      sendQueued() {}, handleSend() {},
      applySlashCommand() {},
      isExactSlashCommand() { return false; }, value: "@file",
      setSlashMenuOpen() {}, setAtMenuOpen() {},
      applyAtCompletion() {},
      applyHistoryInput() {},
      cycleListIndex,
      setAtActiveIndex(update) {
        next = typeof update === "function" ? update(atActiveIndex) : update;
      },
    });
    handler({
      key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 0 },
      preventDefault() {},
    });
    return next;
  }

  assert.equal(move("ArrowDown", 0, 3), 1);
  assert.equal(move("ArrowDown", 2, 3), 0);
  assert.equal(move("ArrowUp", 0, 3), 2);
  assert.equal(move("ArrowUp", 1, 3), 0);
  assert.equal(move("ArrowDown", 0, 1), 0);
  assert.equal(move("ArrowDown", 0, 0), 0);
});

test("cycleListIndex wraps in both directions", () => {
  assert.equal(cycleListIndex(0, 3, 1), 1);
  assert.equal(cycleListIndex(2, 3, 1), 0);
  assert.equal(cycleListIndex(0, 3, -1), 2);
  assert.equal(cycleListIndex(1, 3, -1), 0);
  assert.equal(cycleListIndex(0, 1, 1), 0);
  assert.equal(cycleListIndex(4, 0, 1), 0);
  assert.equal(cycleListIndex(-1, 4, 1), 0);
});

test("shows the follow-up shortcut in the button tooltip", () => {
  const html = renderToStaticMarkup(
    React.createElement(I18nProvider, null, React.createElement(ChatInput, {
      onSend() {}, onAbort() {}, onFollowUp() {}, isStreaming: true,
    })),
  );

  assert.match(html, /title="在 Agent 完成后排队此消息 \(Alt\/Option\+Enter\)"/);
  assert.match(html, /aria-keyshortcuts="Alt\+Enter"/);
});

test("renders the upstream model error", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelErrorBanner, {
        error: "Invalid models.json schema:\nproviders.custom.models.0.id must not be empty",
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /模型错误/);
  assert.match(html, /providers\.custom\.models\.0\.id must not be empty/);
});

test("does not render an empty model error", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(I18nProvider, null, React.createElement(ModelErrorBanner, { error: null })),
    ),
    "",
  );
});

test("scope warnings never reappear when the composer mounts", () => {
  for (const warnings of [[], ['No models match pattern "ghost-gateway/*"'],
    ['Invalid thinking level "bogus" in pattern "fixture/startup:bogus". Using default instead.']]) {
    for (let mount = 0; mount < 2; mount++) {
      const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
        React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false,
          modelScopeWarnings: warnings })));
      assert.doesNotMatch(html, /模型范围警告|模型警告|ghost-gateway|Invalid thinking level|role="alert"/);
    }
  }
});

test("actual model errors remain visible alongside ignored scope diagnostics", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatInput, { onSend() {}, onAbort() {}, isStreaming: false,
      modelError: "Invalid models.json schema", modelScopeWarnings: ['No models match pattern "ghost-gateway/*"'] })));
  assert.match(html, /模型错误/);
  assert.match(html, /Invalid models.json schema/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /模型范围警告|ghost-gateway/);
});

test("keeps the model selector visible when a model error leaves no options", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        modelError: "Invalid models.json schema",
        modelList: [],
        modelNames: {},
      }),
    ),
  );

  assert.match(html, />无可用模型</);
  assert.match(html, /title="无可用模型"/);
});

test("desktop composer omits tool and manual compaction controls when compatibility props are supplied", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onToolPresetChange() {},
        onCompact() {},
        onAbortCompaction() {},
        isCompacting: true,
        isStreaming: false,
        toolPreset: "read-only",
      }),
    ),
  );

  assert.doesNotMatch(html, /更改工具预设|read-only|仅聊天|压缩上下文|停止压缩/);
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /chat-composer-right-inner|toolDropdown(Open|Ref)|setToolDropdownOpen/);
});

test("renders the compact composer with the standard Send button and no session controls", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        isStreaming: false,
        compact: true,
      }),
    ),
  );

  assert.match(html, /<textarea/);
  assert.match(html, />发送<\/button>/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /type="file"|Attach image|Change tool preset/);
});

test("running sessions allow choosing the next model while pending changes remain locked", () => {
  for (const modelSwitching of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
      React.createElement(ChatInput, {
        onSend() {}, onAbort() {}, onModelChange() {}, isStreaming: true,
        model: { provider: "owned", modelId: "queued-model" },
        modelList: [{ provider: "owned", id: "queued-model", name: "Queued model" }],
        modelSwitching,
      })));
    const trigger = html.match(/class="model-selector[^"]*"[\s\S]*?(<button[^>]*>)/)?.[1];
    assert.ok(trigger, "model trigger exists during streaming");
    assert.equal(trigger.includes('disabled=""'), modelSwitching);
  }
});

test("shows and locks the optimistic model while a switch is pending", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onModelChange() {},
        isStreaming: false,
        model: { provider: "deepseek", modelId: "deepseek-v4-flash" },
        modelList: [{ provider: "deepseek", id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        modelSwitching: true,
      }),
    ),
  );

  assert.match(html, /title="正在切换模型"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /disabled=""/);
  assert.match(html, />DeepSeek V4 Flash</);
  assert.match(html, /animation:spin 0\.8s linear infinite/);
});

test("filters model options by name and id", () => {
  const options = [
    { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
    { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
  ];

  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.equal(filterModelOptions(options, "OpenAI").length, 0);
  assert.equal(filterModelOptions(options, "anthropic/claude").length, 0);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("renders the shared field model selector as a disabled gray control", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ModelSelector, {
        options: [{ provider: "openai", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
        value: null,
        onChange() {},
        onClear() {},
        emptyLabel: "Parent default",
        ariaLabel: "Model override",
        disabled: true,
        variant: "field",
      }),
    ),
  );

  assert.match(html, /aria-label="Model override"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /background:var\(--bg-panel\)/);
  assert.match(html, />Parent default</);
});

test("caps an upward menu to the visible space above its anchor", () => {
  assert.equal(getUpwardMenuMaxHeight(343, 36), 299);
  assert.equal(getUpwardMenuMaxHeight(40, 36), 0);
  // Composer sitting under a 36px top bar with only ~160px of air: a 400px
  // file list would paint through the bar and hide the leading matches.
  assert.equal(getUpwardMenuMaxHeight(200, 36), 156);
  assert.ok(getUpwardMenuMaxHeight(200, 36) < 400);
});

test("file mention menu applies the measured upward height cap", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("{atMenuOpen && atQuery !== null && (() => {");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 4000);
  assert.match(block, /ref=\{atMenuRef\}/);
  assert.match(block, /min\(48vh, 400px, \$\{atMenuMaxHeight\}px\)/);
  assert.match(block, /flexDirection: "column"/);
  assert.match(block, /minHeight: 0/);
  assert.equal(block.includes("maxHeight: \"min(48vh, 400px)\""), false);
});

test("file mention menu remeasures when its layout container shifts the anchor", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function subscribeUpwardMenuMaxHeight");
  assert.notEqual(start, -1);
  const block = source.slice(start, start + 1800);
  assert.match(block, /const layoutContainer = parent\?\.parentElement;/);
  assert.match(block, /anchorObserver\?\.observe\(layoutContainer\)/);
});

test("keeps large PNG screenshots as PNG at 2048px and uses JPEG compression only for photos", async () => {
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024, type: "image/png" }), false);
  assert.equal(shouldCompressImageFile({ size: 1024 * 1024 + 1, type: "image/png" }), true);
  assert.equal(shouldCompressImageFile({ size: 2 * 1024 * 1024, type: "image/gif" }), false);

  const originals = {
    FileReader: globalThis.FileReader,
    createImageBitmap: globalThis.createImageBitmap,
    document: globalThis.document,
  };
  let bitmapCalls = 0;
  let closeCalls = 0;
  const canvases = [];

  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = "data:image/png;base64,ORIGINAL";
      this.onload();
    }
  };
  globalThis.createImageBitmap = async () => {
    bitmapCalls += 1;
    return { width: 4096, height: 2048, close() { closeCalls += 1; } };
  };
  globalThis.document = {
    createElement: () => {
      const context = { fillStyle: "", fillRectCalls: 0, fillRect() { this.fillRectCalls += 1; }, drawImage() {} };
      const canvas = {
        width: 0,
        height: 0,
        context,
        toDataURLCalls: [],
        getContext: () => context,
        toDataURL(...args) {
          this.toDataURLCalls.push(args);
          return args[0] === "image/png"
            ? "data:image/png;base64,PNG_COMPRESSED"
            : "data:image/jpeg;base64,JPEG_COMPRESSED";
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };

  try {
    assert.deepEqual(await compressImageFile({ size: 1024, type: "image/png" }), {
      data: "ORIGINAL",
      mimeType: "image/png",
    });
    assert.deepEqual(await compressImageFile({ size: 3 * 1024 * 1024, type: "image/png" }), {
      data: "PNG_COMPRESSED",
      mimeType: "image/png",
    });
    assert.deepEqual(await compressImageFile({ size: 3 * 1024 * 1024, type: "image/jpeg" }), {
      data: "JPEG_COMPRESSED",
      mimeType: "image/jpeg",
    });
    assert.equal(bitmapCalls, 2);
    assert.deepEqual(
      canvases.map(({ width, height, toDataURLCalls, context }) => ({ width, height, toDataURLCalls, fillRectCalls: context.fillRectCalls })),
      [
        { width: 2048, height: 1024, toDataURLCalls: [["image/png"]], fillRectCalls: 0 },
        { width: 1024, height: 512, toDataURLCalls: [["image/jpeg", 0.85]], fillRectCalls: 1 },
      ],
    );
    assert.equal(closeCalls, 2);
  } finally {
    globalThis.FileReader = originals.FileReader;
    globalThis.createImageBitmap = originals.createImageBitmap;
    globalThis.document = originals.document;
  }
});

test("recognizes exact slash commands for one-Enter submission", () => {
  const builtin = { name: "copy", description: "", source: "builtin" };
  assert.equal(isExactSlashCommand("/copy", builtin), true);
  assert.equal(isExactSlashCommand("  /copy  ", builtin), true);
  assert.equal(isExactSlashCommand("/co", builtin), false);
  assert.equal(isExactSlashCommand("/copy extra", builtin), false);
  assert.equal(isExactSlashCommand("/copy", { ...builtin, source: "extension" }), false);
});

test("clears a completed built-in only while its submitted input is unchanged", () => {
  assert.equal(canClearBuiltinCommandInput("/copy", 0, "/copy"), true);
  assert.equal(canClearBuiltinCommandInput("new follow-up", 0, "/copy"), false);
  assert.equal(canClearBuiltinCommandInput("/copy", 1, "/copy"), false);
});

test("locks built-in command submission until it settles", async () => {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "runBuiltinCommand") {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  const callback = new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext({
    attachedImages: [],
    attachedImagesRef: { current: [] },
    builtinCommandPendingRef: { current: false },
    canClearBuiltinCommandInput,
    clearInput() {},
    onBuiltinCommand: async () => new Promise((resolve) => { callback.resolve = resolve; }),
    setBuiltinCommandPending(value) { callback.pendingStates.push(value); },
    valueRef: { current: "/reload" },
  });
  callback.pendingStates = [];

  const first = callback("/reload");
  assert.deepEqual(callback.pendingStates, [true]);
  assert.equal(await callback("/reload"), true);
  assert.deepEqual(callback.pendingStates, [true]);
  callback.resolve({ handled: true });
  assert.equal(await first, true);
  assert.deepEqual(callback.pendingStates, [true, false]);
  assert.match(sourceText, /inert=\{builtinCommandPending \|\| undefined\}\s+aria-busy=\{builtinCommandPending\}/);
});

test("keeps only read-only built-ins available while a run is active", () => {
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/session"), true);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/auto-compact"), false);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/reload"), false);
});

test("a bare /mcp reaches the built-in handler while a run is active", () => {
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp"), true);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/copy"), true);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/compact"), false);
  // Subcommands act on the session's connections and are queued like any message.
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp login docs"), false);
  assert.equal(offersBuiltinSlashCommandWhileStreaming("/mcp:1"), false);
  // The built-in list itself is unchanged: /mcp is not one of the composer's built-ins.
  assert.equal(canRunBuiltinSlashCommandWhileStreaming("/mcp"), false);
});

test("Enter on pi's built-in /mcp submits it at once; other extension commands still complete first", () => {
  const builtinMcp = { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp", source: "builtin", scope: "temporary", origin: "top-level" } };
  const otherMcp = { ...builtinMcp, sourceInfo: { ...builtinMcp.sourceInfo, path: "/ext/mcp.ts" } };
  const copy = { name: "copy", description: "", source: "builtin", availableWhileStreaming: true };
  const compact = { name: "compact", description: "", source: "builtin" };

  assert.equal(submitsSlashCommandOnEnter("/mcp", builtinMcp, false), true);
  assert.equal(submitsSlashCommandOnEnter("/mcp", builtinMcp, true), true);
  assert.equal(submitsSlashCommandOnEnter("/mc", builtinMcp, false), false);
  assert.equal(submitsSlashCommandOnEnter("/mcp", otherMcp, false), false);
  assert.equal(submitsSlashCommandOnEnter("/deploy", { ...otherMcp, name: "deploy" }, false), false);
  // The composer's built-ins keep their rule: typed in full, and while streaming only those allowed then.
  assert.equal(submitsSlashCommandOnEnter("/copy", copy, true), true);
  assert.equal(submitsSlashCommandOnEnter("/compact", compact, false), true);
  assert.equal(submitsSlashCommandOnEnter("/compact", compact, true), false);
  assert.equal(submitsSlashCommandOnEnter("/co", copy, false), false);

  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  assert.match(sourceText, /if \(submitsSlashCommandOnEnter\(value, selectedCommand, isStreaming\)\) \{/);
});

function chatInputCallback(name, context) {
  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findCallback(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      return node.initializer.arguments[0];
    }
    return ts.forEachChild(node, findCallback);
  }
  return new Script(ts.transpileModule(findCallback(source).getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext({
    attachedImagesRef: {current: context.attachedImages ?? []},
    queuedSubmissionPendingRef: {current: false},
    draftKeyRef: {current: 'fixture'}, queuedMessages: {steering: [], followUp: []}, setQueuedSubmissionPreview(){},
    setQueuedSubmissionPending(){}, MAX_ATTACHED_IMAGES: 10,
    offersBuiltinSlashCommandWhileStreaming,
    ...context,
  });
}

test("while a run streams, a bare /mcp opens Settings or is queued as before", async () => {
  const run = async (value, handled, { mode = "steer", images = [] } = {}) => {
    const calls = { builtin: [], prompts: [], cleared: 0 };
    const sendQueued = chatInputCallback("sendQueued", {
      value,
      attachedImages: images,
      onAudioUnlock() {},
      clearInput() { calls.cleared += 1; },
      onBuiltinCommand: async () => ({ handled }),
      canRunBuiltinSlashCommandWhileStreaming,
      isBareMcpCommand,
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      onPromptWithStreamingBehavior: (message, behavior, attached) => calls.prompts.push([message, behavior, attached?.length ?? 0]),
      onSteer() { throw new Error("slash messages are prompts"); },
      onFollowUp() { throw new Error("slash messages are prompts"); },
    });
    sendQueued(mode);
    await new Promise((resolve) => setImmediate(resolve));
    return calls;
  };

  // Owned: Settings opened, nothing queued, the handler clears the input itself.
  assert.deepEqual(await run("/mcp", true), { builtin: ["/mcp"], prompts: [], cleared: 0 });
  // Another extension's /mcp: queued exactly as before.
  assert.deepEqual(await run("/mcp", false), { builtin: ["/mcp"], prompts: [["/mcp", "steer", 0]], cleared: 1 });
  assert.deepEqual(await run("/mcp", false, { mode: "followup" }), { builtin: ["/mcp"], prompts: [["/mcp", "followUp", 0]], cleared: 1 });
  // Subcommands and a /mcp with images never reach the handler.
  assert.deepEqual(await run("/mcp login docs", true), { builtin: [], prompts: [["/mcp login docs", "steer", 0]], cleared: 1 });
  assert.deepEqual(await run("/mcp", true, { images: [{}] }), { builtin: [], prompts: [["/mcp", "steer", 1]], cleared: 1 });
  // The composer's own built-ins are unchanged.
  assert.deepEqual(await run("/copy", true), { builtin: ["/copy"], prompts: [], cleared: 0 });
});

test("handleSend lets a handled /mcp through while streaming and sends an unowned one when idle", async () => {
  const run = async (value, { isStreaming, handled }) => {
    const calls = { builtin: [], sent: [] };
    const handleSend = chatInputCallback("handleSend", {
      value,
      attachedImages: [],
      onAudioUnlock() {},
      isStreaming,
      offersBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async (message) => { calls.builtin.push(message); return handled; },
      clearInput() {},
      onSend: (message) => calls.sent.push(message),
    });
    await handleSend();
    return calls;
  };
  assert.deepEqual(await run("/mcp", { isStreaming: true, handled: true }), { builtin: ["/mcp"], sent: [] });
  assert.deepEqual(await run("/mcp", { isStreaming: false, handled: true }), { builtin: ["/mcp"], sent: [] });
  assert.deepEqual(await run("/mcp", { isStreaming: false, handled: false }), { builtin: ["/mcp"], sent: ["/mcp"] });
  // Streaming without steer handlers keeps any other message in the composer, as before.
  assert.deepEqual(await run("/mcp login", { isStreaming: true, handled: false }), { builtin: [], sent: [] });
});

test("restores text and base64 images when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "text", text: "Review this image @src/example.ts " },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
  };

  assert.equal(getUserMessageText(message), "Review this image @src/example.ts ");
  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/png" },
  ]);

  const messageWithDimension = {
    role: "user",
    content: [
      { type: "text", text: "历史提问文本\n\n[Image: original 2248x2480, displayed at 1813x2000. Multiply coordinates by 1.24 to map to original image.]" }
    ]
  };
  assert.equal(getUserMessageText(messageWithDimension), "历史提问文本");
});

test("restores legacy flat image entries when editing a user message", () => {
  const message = {
    role: "user",
    content: [
      { type: "image", data: "AQID", mimeType: "image/jpeg" },
    ],
  };

  assert.deepEqual(getUserMessageDraftImages(message), [
    { data: "AQID", mimeType: "image/jpeg" },
  ]);
});

test("does not restore a historical message over a pending image attachment", () => {
  assert.equal(canRestoreUserMessage("", 0, 0), true);
  assert.equal(canRestoreUserMessage("", 1, 0), false);
  assert.equal(canRestoreUserMessage("", 0, 1), false);
  assert.equal(canRestoreUserMessage("draft", 0, 0), false);
});

test("restores a cleared submission using the queued React state", () => {
  let value = "failed submission";
  const updates = [
    () => "",
    (current) => mergeRestoredSubmissionText("failed submission", current),
  ];

  for (const update of updates) value = update(value);

  assert.equal(value, "failed submission");
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "new draft"),
    "failed submission\n\nnew draft",
  );
  assert.equal(
    mergeRestoredSubmissionText("failed submission", "failed submission"),
    "failed submission\n\nfailed submission",
  );
});

test("keeps a failed first submission recoverable across a composer remount", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft(
    "failed submission",
    [image],
    "",
    [],
  );

  assert.deepEqual(restored, {
    value: "failed submission",
    images: [image],
  });
  assert.deepEqual(
    mergeRestoredSubmissionDraft("failed submission", [image], "new draft", []),
    {
      value: "failed submission\n\nnew draft",
      images: [image],
    },
  );
});

test("preserves duplicate image attachments when restoring a submission", () => {
  const image = { data: "AQID", mimeType: "image/png" };
  const restored = mergeRestoredSubmissionDraft("", [image, image], "", [image]);

  assert.deepEqual(restored.images, [image, image, image]);
});

test("moves a provisional new-session draft to the real session key", () => {
  const provisionalKey = "new:/tmp/rekey-test";
  const sessionKey = "session-rekey-test";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "queued while preflight ran", images: [] });

  assert.deepEqual(rekeyDraft(provisionalKey, sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "queued while preflight ran",
    images: [],
  });

  clearDraft(sessionKey);
});

test("rekey keeps a synchronously restored draft when React state is still empty", () => {
  const provisionalKey = "new:/tmp/rekey-race";
  const sessionKey = "session-rekey-race";
  clearDraft(provisionalKey);
  clearDraft(sessionKey);
  setDraft(provisionalKey, { value: "restored before state flush", images: [] });

  assert.deepEqual(
    rekeyDraft(provisionalKey, sessionKey, { value: "", images: [] }),
    { value: "restored before state flush", images: [] },
  );
  assert.equal(getDraft(provisionalKey), null);
  assert.deepEqual(getDraft(sessionKey), {
    value: "restored before state flush",
    images: [],
  });

  clearDraft(sessionKey);
});

test("renders compact errors above the input as a wrapping alert", () => {
  const error = "Compaction failed: OpenAI API error (403): <html>request forbidden</html>";
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ChatInput, {
        onSend() {},
        onAbort() {},
        onCompact() {},
        isStreaming: false,
        compactError: error,
      }),
    ),
  );

  assert.match(html, /role="alert"/);
  assert.match(html, /Compaction failed: OpenAI API error/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
  assert.match(html, /white-space:pre-wrap/);
  assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
});

test("modelSupportsImageInput warns only when modality info is known and lacks image", () => {
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "ollama", input: ["text"] },
    { id: "vision", name: "Vision", provider: "anthropic", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom", input: undefined },
  ];

  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, modelList), false);
  assert.equal(modelSupportsImageInput({ provider: "anthropic", modelId: "vision" }, modelList), true);
  // Unknown modality info never blocks the user.
  assert.equal(modelSupportsImageInput({ provider: "custom", modelId: "unknown" }, modelList), true);
  // Model missing from the list is treated as unknown.
  assert.equal(modelSupportsImageInput({ provider: "x", modelId: "missing" }, modelList), true);
  assert.equal(modelSupportsImageInput(null, modelList), true);
  assert.equal(modelSupportsImageInput({ provider: "ollama", modelId: "text-only" }, undefined), true);
});

test("renders image warnings for known text-only defaults without an explicit model selection", () => {
  const draftKey = "new:/tmp/image-warning-default";
  const modelList = [
    { id: "text-only", name: "Text Only", provider: "custom", input: ["text"] },
    { id: "vision", name: "Vision", provider: "custom", input: ["text", "image"] },
    { id: "unknown", name: "Unknown", provider: "custom" },
  ];
  setDraft(draftKey, {
    value: "Describe this image",
    images: [{ data: "aW1hZ2U=", mimeType: "image/png" }],
  });

  try {
    for (const [modelId, warningExpected] of [["text-only", true], ["vision", false], ["unknown", false], [null, false]]) {
      const html = renderToStaticMarkup(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(ChatInput, {
            onSend() {},
            onAbort() {},
            isStreaming: false,
            isAutoModelSelection: true,
            model: modelId ? { provider: "custom", modelId } : null,
            modelList,
            draftKey,
          }),
        ),
      );

      assert.match(html, /<img/);
      assert.equal(html.includes("图片可能无法发送"), warningExpected, `default model: ${modelId}`);
      if (warningExpected) {
        assert.match(html, /当前选择的模型（Text Only）不支持图片输入/);
        assert.ok(html.indexOf('role="alert"') < html.indexOf("<textarea"));
      }
    }
  } finally {
    clearDraft(draftKey);
  }
});

test("draftImagesToAttachedImages preserves all valid images beyond 10 while filtering invalid ones", () => {
  const makeImg = (idx) => ({
    data: Buffer.from(`img-${idx}`, "utf8").toString("base64"),
    mimeType: "image/png",
  });
  const elevenValid = Array.from({ length: 11 }, (_, i) => makeImg(i + 1));
  const decoded = draftImagesToAttachedImages([
    ...elevenValid,
    { data: "invalid-base64!", mimeType: "image/png" },
  ]);

  assert.equal(decoded.length, 11);
  assert.deepEqual(
    decoded.map(({ data, mimeType }) => ({ data, mimeType })),
    elevenValid,
  );
  assert.equal(getTooManyImagesNotice(10), null);
  assert.match(getTooManyImagesNotice(11)?.title ?? "", /11\/10/);
  assert.match(getTooManyImagesNotice(11)?.body ?? "", /Remove 1 image or send in batches/);
});

test("ChatInput restoreSubmission preserves all 11 images and text when draft grows from 1 to 9 during delayed recall, and handles 2+1, failed submission, and different draftKey", async () => {
  const { recallSessionQueue } = await jiti.import("@/lib/queue-recall-client.ts");
  const queueActions = await jiti.import("@/lib/queue-actions.ts");
  const { Agent } = await jiti.import("@earendil-works/pi-agent-core");

  const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findRestoreMethod(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "restoreSubmission") {
      return node;
    }
    return ts.forEachChild(node, findRestoreMethod);
  }
  const methodNode = findRestoreMethod(source);
  assert.ok(methodNode, "restoreSubmission method must exist in ChatInput.tsx");
  const fnExpr = `(${methodNode.parameters.map((p) => p.getText(source)).join(", ")}) => ${methodNode.body.getText(source)}`;
  const restoreScript = new Script(ts.transpileModule(fnExpr, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);

  const makeImg = (idx) => ({
    data: Buffer.from(`chatinput-img-${idx}`, "utf8").toString("base64"),
    mimeType: "image/png",
  });
  const toAttached = (img) => ({
    ...img,
    previewUrl: `data:${img.mimeType};base64,${img.data}`,
  });

  function createHarness(initialDraftKey, initialText, initialImages) {
    const state = {
      draftKeyRef: { current: initialDraftKey },
      valueRef: { current: initialText },
      attachedImagesRef: { current: initialImages.map(toAttached) },
      valueState: initialText,
      attachedImagesState: initialImages.map(toAttached),
      textareaRef: { current: null },
    };
    setDraft(initialDraftKey, { value: initialText, images: initialImages });
    const restoreSubmission = restoreScript.runInNewContext({
      Array,
      Object,
      Math,
      draftKeyRef: state.draftKeyRef,
      valueRef: state.valueRef,
      attachedImagesRef: state.attachedImagesRef,
      textareaRef: state.textareaRef,
      getDraft,
      setDraft,
      mergeRestoredSubmissionDraft,
      mergeRestoredSubmissionText,
      draftImagesToAttachedImages,
      imageToDraftImage: (img) => ({ data: img.data, mimeType: img.mimeType }),
      setValue(updater) {
        state.valueState = typeof updater === "function" ? updater(state.valueState) : updater;
      },
      setAttachedImages(updater) {
        state.attachedImagesState = typeof updater === "function" ? updater(state.attachedImagesState) : updater;
      },
      setAtQuery() {},
      setHistoryMenuOpen() {},
      requestAnimationFrame() {},
    });
    return { state, restoreSubmission };
  }

  // 1. Delayed RPC race: draft grows from 1 to 9 images while recall_all_queued_messages is in flight, returns 2 -> 11 kept
  const raceKey = "chatinput-race-sid";
  clearDraft(raceKey);
  const initialImg = makeImg(1);
  const addedDuringRpc = Array.from({ length: 8 }, (_, i) => makeImg(i + 2)); // 2..9
  const recalled1 = makeImg(10);
  const recalled2 = makeImg(11);
  const { state: raceState, restoreSubmission: raceRestore } = createHarness(
    raceKey,
    "existing user text",
    [initialImg],
  );

  const agent = new Agent({ streamFn: async () => { throw new Error("unused"); } });
  agent.state.isStreaming = true;
  const fakeSession = {
    sessionId: raceKey,
    isStreaming: true,
    isCompacting: false,
    agent,
    _steeringMessages: ["recalled steer"],
    _followUpMessages: ["recalled followup"],
    _emitQueueUpdate() {},
  };
  agent.steer({
    role: "user",
    content: [{ type: "text", text: "recalled steer" }, { type: "image", ...recalled1 }],
    timestamp: Date.now(),
  });
  agent.followUp({
    role: "user",
    content: [{ type: "text", text: "recalled followup" }, { type: "image", ...recalled2 }],
    timestamp: Date.now(),
  });

  const outcome = await recallSessionQueue({
    sessionId: raceKey,
    targetDraftKey: raceKey,
    getExistingDraftImageCount: () => raceState.attachedImagesRef.current.length,
    sendCommand: async (_sid, cmd) => {
      if (cmd.type === "get_queue_actions") {
        return queueActions.snapshot(fakeSession);
      }
      if (cmd.type === "recall_all_queued_messages") {
        await new Promise((r) => setTimeout(r, 10));
        // User adds 8 images while recall RPC is in flight -> draft now has 9 images
        const nineImages = [initialImg, ...addedDuringRpc];
        raceState.attachedImagesRef.current = nineImages.map(toAttached);
        raceState.attachedImagesState = nineImages.map(toAttached);
        setDraft(raceKey, { value: raceState.valueRef.current, images: nineImages });
        return queueActions.recallAll(fakeSession, cmd.tokens);
      }
      throw new Error(`Unexpected: ${cmd.type}`);
    },
    restoreSubmission: (text, images, targetDraftKey) => {
      raceRestore(text, images?.map(({ data, mimeType }) => ({ data, mimeType })), targetDraftKey);
    },
  });

  assert.equal(outcome.recalled, true);
  assert.equal(raceState.valueState, "recalled steer\n\nrecalled followup\n\nexisting user text");
  assert.equal(raceState.attachedImagesState.length, 11);
  assert.equal(raceState.attachedImagesRef.current.length, 11);
  assert.deepEqual(
    Array.from(raceState.attachedImagesState, ({ data, mimeType }) => ({ data, mimeType })),
    [recalled1, recalled2, initialImg, ...addedDuringRpc],
  );
  assert.deepEqual(getDraft(raceKey), {
    value: "recalled steer\n\nrecalled followup\n\nexisting user text",
    images: [recalled1, recalled2, initialImg, ...addedDuringRpc],
  });
  clearDraft(raceKey);

  // 2. Normal 2+1 recall
  const normalKey = "chatinput-normal-2plus1";
  clearDraft(normalKey);
  const { state: normalState, restoreSubmission: normalRestore } = createHarness(
    normalKey,
    "draft one",
    [makeImg(3)],
  );
  normalRestore("queued two", [makeImg(1), makeImg(2)], normalKey);
  assert.equal(normalState.valueState, "queued two\n\ndraft one");
  assert.equal(normalState.attachedImagesState.length, 3);
  assert.deepEqual(getDraft(normalKey)?.images, [makeImg(1), makeImg(2), makeImg(3)]);
  clearDraft(normalKey);

  // 3. Failed submission recovery and different draft key isolation
  const activeKey = "chatinput-active-session";
  const backgroundKey = "chatinput-background-session";
  clearDraft(activeKey);
  clearDraft(backgroundKey);
  setDraft(backgroundKey, { value: "bg draft", images: [makeImg(20)] });
  const { state: activeState, restoreSubmission: activeRestore } = createHarness(
    activeKey,
    "",
    [],
  );
  // Restore into background draft key without touching active composer
  activeRestore("failed bg submit", [makeImg(19)], backgroundKey);
  assert.equal(activeState.valueState, "");
  assert.equal(activeState.attachedImagesState.length, 0);
  assert.deepEqual(getDraft(backgroundKey), {
    value: "failed bg submit\n\nbg draft",
    images: [makeImg(19), makeImg(20)],
  });
  // Restore failed submission into active composer
  activeRestore("failed active submit", [makeImg(18)], activeKey);
  assert.equal(activeState.valueState, "failed active submit");
  assert.deepEqual(getDraft(activeKey)?.images, [makeImg(18)]);
  clearDraft(activeKey);
  clearDraft(backgroundKey);
});

test("over-limit draft (>10 images) renders all previews and warning banner, blocks handleSend and sendQueued without clearing draft, and keeps addImages capped at 10", async () => {
  const draftKey = "over-limit-submit-guard";
  clearDraft(draftKey);
  const makeImg = (idx) => ({
    data: Buffer.from(`guard-img-${idx}`, "utf8").toString("base64"),
    mimeType: "image/png",
  });
  const elevenImages = Array.from({ length: 11 }, (_, i) => makeImg(i + 1));
  setDraft(draftKey, {
    value: "preserve this text and 11 images",
    images: elevenImages,
  });

  try {
    // 1. SSR render check: all 11 images rendered, warning banner visible, Send button disabled
    const html = renderToStaticMarkup(
      React.createElement(
        I18nProvider,
        null,
        React.createElement(ChatInput, {
          onSend() {},
          onAbort() {},
          isStreaming: false,
          draftKey,
        }),
      ),
    );
    assert.equal((html.match(/<img\b/g) ?? []).length, 11);
    assert.match(html, /已附加 11 张图片（单次发送上限 10 张）/);
    assert.match(html, /请先删减多余图片或分批发送/);
    assert.match(html, /<button(?=[^>]*disabled="")(?=[^>]*aria-label="发送")[^>]*>/);

    // 2. Execute actual handleSend & sendQueued from ChatInput.tsx
    const sourceText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
    const source = ts.createSourceFile("ChatInput.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function findCallback(name, node = source) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
        return node.initializer.arguments[0];
      }
      return ts.forEachChild(node, (child) => findCallback(name, child));
    }

    const MAX_ATTACHED_IMAGES = 10;
    const MAX_ATTACHED_IMAGE_BYTES = 10 * 1024 * 1024;
    let sendCalls = 0;
    let steerCalls = 0;
    let followUpCalls = 0;
    let clearCalls = 0;

    const attachedEleven = draftImagesToAttachedImages(elevenImages);
    const handleSendFn = new Script(ts.transpileModule(findCallback("handleSend").getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText).runInNewContext({
      queuedSubmissionPendingRef: { current: false },
      setQueuedSubmissionPending() {},
      value: "preserve this text and 11 images",
      attachedImages: attachedEleven,
      attachedImagesRef: { current: attachedEleven },
      MAX_ATTACHED_IMAGES,
      onAudioUnlock() {},
      isStreaming: false,
      canRunBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async () => false,
      clearInput() {
        clearCalls += 1;
        clearDraft(draftKey);
      },
      onSend() {
        sendCalls += 1;
      },
    });

    const sendQueuedFn = new Script(ts.transpileModule(findCallback("sendQueued").getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText).runInNewContext({
      queuedSubmissionPendingRef: { current: false },
      setQueuedSubmissionPending() {},
      value: "preserve this text and 11 images",
      attachedImages: attachedEleven,
      attachedImagesRef: { current: attachedEleven },
      MAX_ATTACHED_IMAGES,
      onAudioUnlock() {},
      onBuiltinCommand: undefined,
      canRunBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async () => false,
      onPromptWithStreamingBehavior: undefined,
      clearInput() {
        clearCalls += 1;
        clearDraft(draftKey);
      },
      onSteer() {
        steerCalls += 1;
      },
      onFollowUp() {
        followUpCalls += 1;
      },
    });

    await handleSendFn();
    await sendQueuedFn("steer");
    await sendQueuedFn("followup");

    assert.equal(sendCalls, 0, "must not call onSend when images > 10");
    assert.equal(steerCalls, 0, "must not call onSteer when images > 10");
    assert.equal(followUpCalls, 0, "must not call onFollowUp when images > 10");
    assert.equal(clearCalls, 0, "must not clear input or draft when images > 10");
    assert.equal(getDraft(draftKey)?.images.length, 11, "draft in store must remain intact with 11 images");

    // Once user removes 1 image (down to 10), handleSend succeeds
    const attachedTen = attachedEleven.slice(0, 10);
    const handleSendTenFn = new Script(ts.transpileModule(findCallback("handleSend").getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText).runInNewContext({
      value: "preserve this text and 11 images",
      attachedImages: attachedTen,
      attachedImagesRef: { current: attachedTen },
      MAX_ATTACHED_IMAGES,
      onAudioUnlock() {},
      isStreaming: false,
      canRunBuiltinSlashCommandWhileStreaming,
      runBuiltinCommand: async () => false,
      clearInput() {
        clearCalls += 1;
      },
      onSend(_msg, imgs) {
        sendCalls += 1;
        assert.equal(imgs.length, 10);
      },
    });
    await handleSendTenFn();
    assert.equal(sendCalls, 1);
    assert.equal(clearCalls, 1);

    // 3. Ordinary addImages (processImageFiles) still enforces strict 10-image cap
    let currentAttached = attachedTen.slice(0, 8);
    const attachedImagesRef = { current: currentAttached };
    const pendingImageCountRef = { current: 0 };
    const processImageFilesFn = new Script(ts.transpileModule(findCallback("processImageFiles").getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText).runInNewContext({
      compact: false,
      MAX_ATTACHED_IMAGES,
      MAX_ATTACHED_IMAGE_BYTES,
      attachedImagesRef,
      pendingImageCountRef,
      preloadImageCapabilities() {},
      compressImageFile: async (file) => ({ data: file.data, mimeType: file.type }),
      URL: { createObjectURL: (file) => `blob:${file.name}`, revokeObjectURL() {} },
      revokeImagePreview() {},
      setAttachedImages(updater) {
        currentAttached = updater(currentAttached);
      },
    });

    await processImageFilesFn([
      { name: "a.png", type: "image/png", size: 100, data: makeImg(21).data },
      { name: "b.png", type: "image/png", size: 100, data: makeImg(22).data },
      { name: "c.png", type: "image/png", size: 100, data: makeImg(23).data },
      { name: "d.png", type: "image/png", size: 100, data: makeImg(24).data },
    ]);
    assert.equal(currentAttached.length, 10, "ordinary addImages must cap at 10");
    assert.equal(pendingImageCountRef.current, 0);
  } finally {
    clearDraft(draftKey);
  }
});


test("queued submission immediately shows pending, clears once and blocks duplicate until acknowledgement", async () => {
 const source=ts.createSourceFile("ChatInput.tsx",readFileSync(new URL("./ChatInput.tsx",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let callback;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(source)==="sendQueued")callback=n.initializer.arguments[0];ts.forEachChild(n,visit);}visit(source);assert(callback);
 let release;const held=new Promise(r=>release=r),pending=[],ref={current:false};let cleared=0,sends=0,preview=null;
 const run=new Script(ts.transpileModule(callback.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText).runInNewContext({draftKeyRef:{current:'fixture'},queuedMessages:{steering:[],followUp:[]},setQueuedSubmissionPreview:value=>preview=typeof value==='function'?value(preview):value,value:"引导内容",attachedImages:[],attachedImagesRef:{current:[]},MAX_ATTACHED_IMAGES:10,queuedSubmissionPendingRef:ref,setQueuedSubmissionPending:v=>pending.push(v),onAudioUnlock:undefined,onBuiltinCommand:undefined,onPromptWithStreamingBehavior:undefined,clearInput:()=>cleared++,onSteer:()=>{sends++;return held;},onFollowUp:undefined});
 const first=run("steer");assert.equal(preview.text,'引导内容');assert.equal(preview.draftKey,'fixture');assert.equal(preview.kind,'steering');assert.deepEqual(pending,[true]);assert.equal(cleared,1);assert.equal(sends,1);
 await run("steer");assert.equal(sends,1);release();await first;assert.deepEqual(pending,[true,false]);assert.equal(ref.current,false);assert.equal(preview,null);
});


test("native extension payload sends once and clears through the native callback", async () => {
  const calls=[];let commits=0,clears=0;
  const window={__PI_ENH_PREPARE_COMPOSER_SUBMISSION__(kind,body){assert.equal(kind,"send");assert.equal(body,"");return {text:"annotation and attachment payload",commit(){commits++;}};}};
  const send=chatInputCallback("handleSend",{window,value:"",attachedImages:[],isStreaming:false,runBuiltinCommand:async()=>false,onAudioUnlock(){},clearInput(){clears++;},onSend(text){calls.push(text);}});
  await send();assert.deepEqual(calls,["annotation and attachment payload"]);assert.equal(clears,1);assert.equal(commits,1);
});
test("native queued extension payload commits only after acceptance, preserving rejected payload", async () => {
  for(const rejected of [false,true]){
    let commits=0,seen;const window={__PI_ENH_PREPARE_COMPOSER_SUBMISSION__(kind){assert.equal(kind,"followup");return {text:"queued annotation",commit(){commits++;}};}};
    const send=chatInputCallback("sendQueued",{window,value:"",attachedImages:[],onBuiltinCommand:null,onAudioUnlock(){},clearInput(){},onFollowUp:async text=>{seen=text;if(rejected)throw new Error("rejected");}});
    if(rejected)await assert.rejects(send("followup"),/rejected/);else await send("followup");
    assert.equal(seen,"queued annotation");assert.equal(commits,rejected?0:1);
  }
});

// Retired UI must not return through a native render or a responsive CSS path.
test("retired more controls menu has no composer render, state or styles", () => {
  const source = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../app/composer.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /chat\.(moreControls|collapseControls)|controlsMenu(Open|Ref)|setControlsMenuOpen|chat-composer-(more-btn|mobile-popover)/);
  assert.doesNotMatch(styles, /chat-composer-(more-btn|mobile-popover)/);
});

test("goal and plan controls share neutral mode icons and expose an accessible exit", () => {
  const input = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const module = readFileSync(new URL("../enhancements/modules/05-composer-and-input-workflow.js", import.meta.url), "utf8");
  const sprite = readFileSync(new URL("../public/icons/composer-mode-icons.svg", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../app/composer.css", import.meta.url), "utf8");
  assert.match(input, /switchMode\("normal", snapshot\.sessionId \?\? undefined\)/);
  assert.match(input, /aria-label=\{`退出\$\{modeLabel\}模式`\}/);
  assert.match(input, /title=\{`退出\$\{modeLabel\}模式`\}/);
  assert.match(module, /composer-mode-icons\.svg#goal/);
  assert.match(module, /composer-mode-icons\.svg#plan/);
  assert.match(module, /goalItem\.title = "设置要持续追求的目标"/);
  assert.match(module, /planItem\.title = "开启计划模式/);
  assert.match(sprite, /<symbol id="goal"[^>]*stroke-width="1\.7"/);
  assert.match(sprite, /<symbol id="plan"[^>]*stroke-width="1\.7"/);
  const chip = styles.match(/\.chat-composer-card \.chat-composer-mode-chip\s*\{([^}]+)\}/)?.[1];
  assert.ok(chip);
  const capsule = styles.match(/\.chat-composer-card \.chat-composer-control-capsule\s*\{([^}]+)\}/)?.[1];
  assert.match(capsule, /height: 24px/);
  assert.match(chip, /color: var\(--text\)/);
  assert.doesNotMatch(chip, /--accent/);
});

test("streaming steer stays an accessible icon-only queue action in both layouts", () => {
  const input = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
  const styles = readFileSync(new URL("../app/composer.css", import.meta.url), "utf8");
  assert.match(input, /aria-label="将消息加入引导队列"/);
  assert.match(input, /title="将消息加入引导队列"/);
  assert.match(input, /className="chat-composer-steer pi-enh-cursor-send pi-enh-cursor-steer"/);
  assert.match(input, /ComposerQueueIcon kind="promote"/);
  assert.doesNotMatch(input, /chat-composer-steer-label|t\("chat\.steer"\)/);
  assert.doesNotMatch(styles, /chat-composer-steer-label|chat-composer-card button\.chat-composer-steer/);
  const steer = styles.match(/\.chat-composer-steer\s*\{([^}]+)\}/)?.[1];
  assert.ok(steer);
  assert.match(steer, /width: 24px/);
  assert.match(steer, /background: transparent/);
  assert.doesNotMatch(steer, /#eab308|234, 179, 8/);
  assert.match(styles, /\.chat-composer-steer:disabled\s*\{[^}]*opacity: \.45/);
});
