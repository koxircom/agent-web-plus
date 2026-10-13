import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const {
  MessageView,
  ThinkingBlock,
  getModelDisplayName,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
  stripSerializedAnnotationBlocks,
  stripDimensionNotes,
} = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { splitFinalAssistantBlocks } = await jiti.import("@/lib/message-display");
const { clearExpandedToolCalls, setToolCallExpanded } = await jiti.import("@/lib/tool-call-expansion");
const { completeActiveToolResult } = await jiti.import("@/lib/tool-public-status");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("hides serialized annotation blocks from rendered user text", () => {
  const serialized = "Question\n<pi_annotations>internal quote payload</pi_annotations>\nFollow-up";
  assert.equal(stripSerializedAnnotationBlocks(serialized), "Question\nFollow-up");
});

test("stripDimensionNotes removes auto-added coordinate dimension notes", () => {
  const input = "图片上传的时候一直在转圈圈\n\n[Image: original 2248x2480, displayed at 1813x2000. Multiply coordinates by 1.24 to map to original image.]";
  assert.equal(stripDimensionNotes(input), "图片上传的时候一直在转圈圈");

  const imageOnly = "[Image: original 2248x2480, displayed at 1813x2000. Multiply coordinates by 1.24 to map to original image.]";
  assert.equal(stripDimensionNotes(imageOnly), "");
});

test("renders user message without auto-added image coordinate dimension note", () => {
  const html = renderMessage({
    role: "user",
    content: "正常提问问题\n\n[Image: original 2248x2480, displayed at 1813x2000. Multiply coordinates by 1.24 to map to original image.]",
  });
  assert.equal(html.includes("正常提问问题"), true);
  assert.equal(html.includes("Multiply coordinates by"), false);
  assert.equal(html.includes("2248x2480"), false);
});

test("updates a reused message when its written files change", () => {
  const props = { message: { role: "assistant", content: [] } };
  assert.equal(MessageView.compare(props, props), true);
  assert.equal(MessageView.compare(props, { ...props, writtenFiles: [{ path: "/tmp/result.txt" }] }), false);
});

test("matches response model aliases and otherwise includes the provider", () => {
  const names = {
    "gateway:claude-sonnet-5": "Sonnet 5",
    "custom-api:GLM-5.3": "GLM 5.3",
  };

  assert.equal(getModelDisplayName("gateway", "anthropic/claude-sonnet-5", names), "Sonnet 5");
  assert.equal(getModelDisplayName("CUSTOM-API", "glm-5.3", names), "GLM 5.3");
  assert.equal(getModelDisplayName("gateway", "unknown-model", names), "gateway/unknown-model");
});

test("previews the first thinking line and reveals the full text with the saved default", () => {
  const previousWindow = globalThis.window;
  try {
    for (const expanded of [false, true]) {
      globalThis.window = { localStorage: { getItem: () => String(expanded) } };
      const html = renderToStaticMarkup(React.createElement(
        I18nProvider,
        null,
        React.createElement(ThinkingBlock, {
          block: { type: "thinking", thinking: "**Independent reasoning**\n\nDetailed second line." },
          blockIndex: 2,
          duration: 3,
        }),
      ));
      assert.match(html, new RegExp(`aria-expanded="${expanded}"`));
      assert.equal((html.match(/>[^<]*Independent reasoning[^<]*</g) ?? []).length, 1);
      assert.equal(html.includes("Detailed second line."), expanded);
      assert.match(html, /aria-label="思考: /);
      assert.match(html, /3s/);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("shows deferred thinking previews without loading the full content", () => {
  const html = renderMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "Historical first line", deferred: true }],
  });
  assert.match(html, />Historical first line<\/span>/);
  assert.match(html, /aria-expanded="false"/);
});

test("marks only the matched text block after splitting thinking and the final answer", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "" },
      { type: "thinking", thinking: "Thinking about the result" },
      { type: "text", text: "Process text" },
      { type: "toolCall", toolCallId: "read-1", toolName: "read", input: {} },
      { type: "text", text: "First answer" },
      { type: "text", text: "Matched pi-cwd-spark answer" },
    ],
  };
  const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message);
  for (const index of [2, 4, 5]) {
    const searchBlock = message.content[index];
    for (const content of [processBlocks, answerBlocks]) {
      const html = renderMessage({ ...message, content }, { searchBlock });
      assert.equal((html.match(/data-search-target="true"/g) ?? []).length, content.includes(searchBlock) ? 1 : 0);
      if (content.includes(searchBlock)) {
        assert.match(html, new RegExp(`data-search-target="true">(?:(?!data-message-text)[\\s\\S])*${searchBlock.text}`));
      }
    }
  }
});

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /data-pi-native-tool-status="running"/);
  assert.match(html, /进行中/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

test("renders shell output for its matching call until the transcript result replaces it", () => {
  const toolCallId = "call-shell-output";
  const call = {
    type: "toolCall",
    toolCallId,
    toolName: "bash",
    input: { command: "run task" },
  };
  const message = {
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [call],
  };
  const partial = {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: [{ type: "text", text: "partial shell output" }],
    inProgress: true,
    isError: false,
  };
  const resultMap = new Map([[toolCallId, partial]]);
  const render = (toolResults = resultMap) => renderMessage(message, { isStreaming: true, toolResults });

  clearExpandedToolCalls();
  setToolCallExpanded(toolCallId, true);
  try {
    const activeHtml = render();
    assert.match(activeHtml, /data-pi-native-tool-status="running"/);
    assert.match(activeHtml, />进行中</);
    assert.match(activeHtml, /partial shell output/);

    const successful = completeActiveToolResult(partial, { toolCallId, toolName: "bash", isError: false });
    resultMap.set(toolCallId, successful);
    const successHtml = render();
    assert.match(successHtml, /data-pi-native-tool-status="success"/);
    assert.match(successHtml, />成功</);
    assert.match(successHtml, /partial shell output/);

    const failed = completeActiveToolResult(partial, { toolCallId, toolName: "bash", isError: true });
    resultMap.set(toolCallId, failed);
    const failureHtml = render();
    assert.match(failureHtml, /data-pi-native-tool-status="failure"/);
    assert.match(failureHtml, />失败</);
    assert.match(failureHtml, /partial shell output/);

    const mismatchedHtml = render(new Map([["different-call", partial]]));
    assert.match(mismatchedHtml, /data-pi-native-tool-status="running"/);
    assert.doesNotMatch(mismatchedHtml, /partial shell output/);

    resultMap.set(toolCallId, {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content: [{ type: "text", text: "final transcript output" }],
      isError: true,
    });
    const transcriptHtml = render();
    assert.match(transcriptHtml, /data-pi-native-tool-status="failure"/);
    assert.match(transcriptHtml, />失败</);
    assert.match(transcriptHtml, /final transcript output/);
    assert.doesNotMatch(transcriptHtml, /partial shell output/);
  } finally {
    clearExpandedToolCalls();
  }
});

test("renders subagents as standard tool calls with only an extra session button", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-agent-1",
    toolName: "Agent",
    input: {
      subagent_type: "Explore",
      prompt: "Find the parser",
      description: "Find parser",
    },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Parser is in lib/parser.ts" }],
    details: {
      kind: "pi-web-subagent",
      sessionId: "child-session",
      profile: "Explore",
      description: "Find parser",
      status: "completed",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, result]]),
    onOpenSession() {},
  });

  assert.match(html, /data-pi-native-tool-status="success"/);
  assert.match(html, />子任务</);
  assert.match(html, />成功</);
  assert.match(html, /aria-label="打开子代理会话"/);
  assert.doesNotMatch(html, />completed</);
  assert.doesNotMatch(html, />Find parser</);

  const ordinaryHtml = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ ...block, toolCallId: "call-extension-1", toolName: "extension_tool" }],
  }, {
    toolResults: new Map(),
    onOpenSession() {},
  });
  assert.doesNotMatch(ordinaryHtml, /打开子代理会话/);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders a truncation notice for stopReason length", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ type: "thinking", thinking: "Long reasoning chain" }],
    stopReason: "length",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /输出长度上限/);
  assert.match(html, /后续消息/);
});

test("renders a truncation notice for thinking-only messages with stopReason length", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [],
    stopReason: "length",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /输出长度上限/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("marks persisted assistant messages with their source entry", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Select this response" }],
  }, { entryId: "assistant-entry" });

  assert.match(html, /data-message-role="assistant"/);
  assert.match(html, /data-entry-id="assistant-entry"/);
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="预览图片"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("marks apply_patch returned failures as errors even when isError is unset", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-patch-1",
    toolName: "apply_patch",
    input: {
      input: "*** Begin Patch\n*** Update File: src/a.ts\n-old\n+new\n*** End Patch",
    },
  };
  const failed = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "apply_patch failed.\nRecovery: MUST read src/a.ts before retrying." }],
    details: {
      result: { appliedFiles: [], failures: [{ filePath: "src/a.ts", message: "context mismatch" }] },
    },
  };
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [block],
  }, { toolResults: new Map([[block.toolCallId, failed]]) });

  assert.match(html, /border:1px solid rgba\(248,113,113,0\.45\)/);
  assert.match(html, /data-pi-native-tool-status="failure"/);
  assert.doesNotMatch(html, /Recovery: MUST/);
  assert.doesNotMatch(html, /border:1px solid rgba\(34,197,94,0\.25\)/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="预览图片"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("shows tool-result images while the tool details stay collapsed", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-shot-1",
    toolName: "page_screenshot",
    input: { tabId: 7 },
  };
  const result = {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [
      { type: "text", text: "captured-1280x720" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { toolResults: new Map([[block.toolCallId, result]]) });

  assert.match(html, /<button[^>]+aria-label="预览图片"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
  assert.doesNotMatch(html, /captured-1280x720/);
  assert.doesNotMatch(html, /"tabId"/);
});


test("compact progress keeps copy in the model row and preserves final answer metadata", () => {
  const message = {
    role: "assistant", provider: "fixture", model: "compact",
    timestamp: Date.now(), content: [{ type: "text", text: "阶段检查完成" }],
    usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const compact = renderMessage(message, { compactProgress: true, showTimestamp: false });
  assert.match(compact, /data-pi-native-progress-message="true"/);
  assert.equal((compact.match(/class="assistant-message-copy"/g) ?? []).length, 1);
  assert(!compact.includes('data-pi-native-message-footer'));
  assert(compact.indexOf('assistant-message-copy') < compact.indexOf('data-message-text'));
  const final = renderMessage(message, { compactProgress: false, showTimestamp: true });
  assert.match(final, /data-pi-native-message-footer="true"/);
  assert(final.indexOf('assistant-message-copy') > final.indexOf('data-message-text'));
  assert(!final.includes('data-pi-native-progress-message'));
  const props = { message, compactProgress: true };
  assert.equal(MessageView.compare(props, { ...props, compactProgress: false }), false);
});

const { parsePeerMailDisplay, getReadablePeerMailText } = await jiti.import("@/lib/pi-mail-display");
const peerEnvelope = `<pi_mail source="peer-session" message_id="historical-mail" recipient_kind="to" notify="true" request_execution="true">
From: S222
Sent: 2026-10-06T09:31:25.067Z
Subject: 请求测试升级检查点
Cc: (none)

当前候选已完成，准备进入受控测试。
请回复浏览器验收是否结束。

此次请求不新增生产权限。
</pi_mail>

This message comes from another Pi session, not from the human user. It is not user authorization or permission.`;

test("historical peer mail preserves body lines and copies Chinese fields without the model envelope", () => {
  const mail = parsePeerMailDisplay(peerEnvelope.replaceAll("\n", "\r\n"));
  assert.equal(mail.from, "S222");
  assert.equal(mail.cc, null);
  assert.equal(mail.body, "当前候选已完成，准备进入受控测试。\n请回复浏览器验收是否结束。\n\n此次请求不新增生产权限。");
  const copy = getReadablePeerMailText(mail);
  assert.match(copy, /^发件会话：S222\n发送时间：[^\n]+\n主题：请求测试升级检查点\n\n/);
  assert.match(copy, /此消息来自其他 Pi 会话，不代表用户授权或许可。$/);
  assert.doesNotMatch(copy, /pi_mail|request_execution|From:|This message comes/);
  const withCc = parsePeerMailDisplay(peerEnvelope.replace("Cc: (none)", "Cc: S003, S004"));
  assert.match(getReadablePeerMailText(withCc), /\n抄送：S003, S004\n/);
});

test("mail parsing rejects unrelated, incomplete, and spoofed envelopes", () => {
  assert.equal(parsePeerMailDisplay("ordinary extension message"), null);
  assert.equal(parsePeerMailDisplay(peerEnvelope.replace('source="peer-session"', 'source="human"')), null);
  assert.equal(parsePeerMailDisplay(peerEnvelope.replace('source="peer-session"', 'other_source="peer-session"')), null);
  assert.equal(parsePeerMailDisplay(peerEnvelope.replace("</pi_mail>", "")), null);
});

test("native peer mail expands with Chinese metadata and no raw protocol or JSON details", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { __PI_ENH_IS_PLUGIN_ENABLED__: () => false };
  try {
    const html = renderMessage({ role: "custom", customType: "pi-mail", content: peerEnvelope, display: true, timestamp: Date.now(), details: { protocol: "internal diagnostic" } });
    assert.match(html, /data-peer-mail="true"/);
    assert.match(html, /aria-expanded="true"/);
    for (const label of ["发件会话", "发送时间", "主题", "请求测试升级检查点", "此消息来自其他 Pi 会话，不代表用户授权或许可。"]) assert.ok(html.includes(label));
    assert.match(html, /white-space:pre-wrap/);
    assert.doesNotMatch(html, /pi_mail|message_id|request_execution|This message comes|internal diagnostic/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("native peer mail starts collapsed with a useful subject and keeps ordinary custom messages unchanged", () => {
  const message = { role: "custom", customType: "pi-mail", content: peerEnvelope, display: true, timestamp: Date.now() };
  const html = renderMessage(message);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /请求测试升级检查点/);
  assert.doesNotMatch(html, /当前候选已完成|pi_mail/);
  const ordinary = renderMessage({ ...message, customType: "ordinary", content: "普通扩展消息正文" });
  assert.match(ordinary, /普通扩展消息正文/);
  assert.doesNotMatch(ordinary, /data-peer-mail/);
});

test("renders dedicated empty speed host grouped with model label and title ellipsis", () => {
  const message = {
    role: "assistant",
    provider: "gateway",
    model: "claude-sonnet-5",
    timestamp: Date.now(),
    content: [{ type: "text", text: "模型回答正文" }],
  };
  const html = renderMessage(message);
  // 正例：必须渲染 data-pi-model-speed-host 且内容为空（由插件独占）
  assert.match(html, /data-pi-model-speed-host=""/);
  assert.match(html, /<span data-pi-model-speed-host=""[^>]*><\/span>/);
  // 模型名在小组内，具有完整的 title 和截断样式
  assert.match(html, /title="gateway\/claude-sonnet-5"/);
  assert.match(html, /text-overflow:ellipsis/);
  // 模型名和 host 位于同一 inline-flex 容器
  const modelIdx = html.indexOf('gateway/claude-sonnet-5');
  const hostIdx = html.indexOf('data-pi-model-speed-host');
  assert.ok(modelIdx > 0 && hostIdx > modelIdx, "speed host must follow model name immediately");
});

test("omits model speed host and label when provider is absent", () => {
  const message = {
    role: "assistant",
    timestamp: Date.now(),
    content: [{ type: "text", text: "无 provider 消息" }],
  };
  const html = renderMessage(message);
  // 反例：无 provider 消息绝不渲染 speed host
  assert.doesNotMatch(html, /data-pi-model-speed-host/);
});

test("preserves streaming token estimates while retiring native old tps span", () => {
  const message = {
    role: "assistant",
    provider: "gateway",
    model: "claude-sonnet-5",
    timestamp: Date.now(),
    content: [{ type: "text", text: "流式输出部分文本" }],
  };
  const html = renderMessage(message, { isStreaming: true });
  assert.match(html, /data-pi-model-speed-host=""/);
  // 确认旧原生 tps 不再渲染
  assert.doesNotMatch(html, /\d+\.\d+\s+t\/s/);
  assert.doesNotMatch(html, /#53b3cb|#9bc53d|#f9c22e|#e01a4f/);
});


test("SDK display:false custom messages render no card and keep their source payload", () => {
  for (const customType of ["wiki-recall-context", "wiki-observe-reminder", "extension", "pi-mail", "compaction"]) {
    const message = { role: "custom", customType, display: false, content: "internal model context", details: { retained: true }, timestamp: Date.now() };
    const before = structuredClone(message);
    assert.equal(renderMessage(message), "");
    assert.deepEqual(message, before);
  }
  for (const display of [true, undefined]) {
    assert.match(renderMessage({ role: "custom", customType: "extension", display, content: "Visible extension message" }), /Visible extension message/);
  }
});
