// Isolated user-message identity regression: one submitted image prompt owns one history entry.
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sourceRoot = path.resolve(process.env.SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const load = createRequire(path.join(sourceRoot, "package.json"));
const { build } = load("esbuild");
const { chromium } = load(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");
const baseline = process.argv.includes("--baseline") || process.env.USER_MESSAGE_IDENTITY_BASELINE === "1";
const requestedScenarios = process.env.USER_MESSAGE_IDENTITY_SCENARIOS
  ? process.env.USER_MESSAGE_IDENTITY_SCENARIOS.split(",").map((name) => name.trim()).filter(Boolean)
  : null;

const sessionId = "user-message-identity-fixture";
const promptText = "请保留这条带图片的用户消息";
const sdkImageNote = "[Image: original 1140x2616, displayed at 872x2000. Multiply coordinates by 1.31 to map to original image.]";
const historyText = `${promptText}\n${sdkImageNote}`;
const optimisticImageData = "optimistic-image-data";
const historyImageData = "history-image-data";
const imageMimeType = "image/png";
const model = { provider: "openai", modelId: "gpt-6.1-sol", id: "gpt-6.1-sol" };
const sessionInfo = {
  id: sessionId,
  path: "/isolated/user-message-identity.jsonl",
  cwd: "/isolated/user-message-identity",
  name: "User message identity fixture",
  created: "2026-10-14T00:00:00.000Z",
  modified: "2026-10-14T00:00:00.000Z",
  messageCount: 0,
  firstMessage: "",
};

let state;
const pageErrors = [];
const externalRequests = [];
const requestLog = [];

function json(response, value, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(value));
}

function textBlock(text) {
  return { type: "text", text };
}

function imageBlock(data) {
  return { type: "image", source: { type: "base64", media_type: imageMimeType, data } };
}

function historyUser(post, index) {
  return {
    role: "user",
    content: [textBlock(historyText), imageBlock(historyImageData)],
    timestamp: 2000 + index,
    requestId: post.requestId,
  };
}

function optimisticEventUser(post) {
  return {
    role: "user",
    content: [textBlock(promptText), imageBlock(post.body.images?.[0]?.data || optimisticImageData)],
    timestamp: 1000,
  };
}

function historySnapshot() {
  const messages = state.promptPosts.map((post, index) => historyUser(post, index));
  const entryIds = state.promptPosts.map((post, index) => `user-entry-${index + 1}`);
  const promptEntryIds = Object.fromEntries(state.promptPosts.map((post, index) => [post.requestId, entryIds[index]]));
  return {
    sessionId,
    filePath: sessionInfo.path,
    totalActiveMs: 0,
    tree: [],
    leafId: null,
    treeFormat: "summary",
    snapshotRevision: `history-${state.historyReads.length}`,
    promptEntryIds,
    info: { ...sessionInfo, messageCount: messages.length },
    context: {
      messages,
      entryIds,
      oldestEntryId: entryIds[0] ?? null,
      hasMore: false,
      thinkingLevel: "off",
      model,
    },
  };
}

function emptySnapshot() {
  return {
    sessionId,
    filePath: sessionInfo.path,
    totalActiveMs: 0,
    tree: [],
    leafId: null,
    treeFormat: "summary",
    snapshotRevision: `empty-${state.historyReads.length}`,
    promptEntryIds: {},
    info: sessionInfo,
    context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model },
  };
}

function resetState(scenario) {
  if (state) for (const stream of state.streams) stream.end();
  state = {
    scenario,
    streams: new Set(),
    streamConnections: 0,
    promptPosts: [],
    historyReads: [],
    pendingHistory: [],
    events: [],
    runtimeRunning: false,
    runtimeStreaming: false,
  };
  return state;
}

function emitEvent(event) {
  if (event.type === "agent_start") {
    state.runtimeRunning = true;
    state.runtimeStreaming = true;
  } else if (event.type === "agent_settled") {
    state.runtimeRunning = false;
    state.runtimeStreaming = false;
  }
  state.events.push({ ...event, sentAt: Date.now() });
  for (const stream of [...state.streams]) {
    if (!stream.destroyed && !stream.writableEnded) stream.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  if (event.type === "agent_end" || event.type === "agent_settled") {
    for (const pending of state.pendingHistory.splice(0)) json(pending.response, pending.snapshot);
  }
}

async function readBody(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

const bundle = await build({
  stdin: {
    resolveDir: sourceRoot,
    loader: "tsx",
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { useAgentSession } from "./hooks/useAgentSession";

      const fixture = window.__USER_MESSAGE_IDENTITY_FIXTURE__;
      const session = {
        id: fixture.sessionId,
        path: "/isolated/user-message-identity.jsonl",
        cwd: "/isolated/user-message-identity",
        name: "User message identity fixture",
        created: "2026-10-14T00:00:00.000Z",
        modified: "2026-10-14T00:00:00.000Z",
        messageCount: 0,
        firstMessage: "",
      };

      function messageText(message) {
        const content = message?.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\\n");
      }

      function Fixture() {
        const hook = useAgentSession({ session, newSessionCwd: null, newSessionDraftKey: null });
        window.fixture = {
          send: (message, image) => hook.handleSend(message, [image]),
          messages: () => hook.messages,
        };
        return <>
          <output data-fixture-ready="true" data-agent-running={String(hook.agentRunning)} data-error={hook.error || ""} />
          <main id="transcript">
            {hook.messages.map((item, index) => item.role === "user" ? (
              <div key={index} data-user-bubble="true" data-message-index={String(index)} data-entry-id={hook.entryIds[index] || ""}>
                {messageText(item)}
              </div>
            ) : null)}
          </main>
        </>;
      }

      createRoot(document.getElementById("root")).render(<Fixture />);
    `,
  },
  bundle: true,
  write: false,
  format: "iife",
  alias: { "@": sourceRoot },
  define: { "process.env.NODE_ENV": '"development"' },
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://user-message-identity-fixture");
  const log = { method: request.method, path: url.pathname + url.search, body: null };
  requestLog.push(log);

  if (url.pathname === "/bundle.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    return response.end(bundle.outputFiles[0].text);
  }
  if (url.pathname === `/api/agent/${sessionId}/events`) {
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    state.streamConnections += 1;
    state.streams.add(response);
    response.on("close", () => state.streams.delete(response));
    response.write(`data: ${JSON.stringify({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] })}\n\n`);
    return;
  }
  if (url.pathname === `/api/agent/${sessionId}` && request.method === "POST") {
    const body = await readBody(request);
    log.body = body;
    if (body.type === "prompt") {
      state.promptPosts.push({ requestId: body.requestId, body });
      state.runtimeRunning = true;
      state.runtimeStreaming = true;
      return json(response, {
        success: true,
        data: { isStreaming: true, model, thinkingLevel: "off" },
        requestId: body.requestId,
        receipt: { status: "accepted" },
      });
    }
    return json(response, { success: true, data: { isStreaming: state.runtimeStreaming, model, thinkingLevel: "off" } });
  }
  if (url.pathname === `/api/agent/${sessionId}` && request.method === "GET") {
    if (url.searchParams.has("interactions")) return json(response, { uncommittedPrompts: [], pendingExtensionUiRequests: [] });
    if (url.searchParams.has("requestId")) return json(response, { status: "accepted", inFlight: state.runtimeRunning });
    return json(response, {
      running: state.runtimeRunning,
      state: { isStreaming: state.runtimeStreaming, isPromptRunning: false, thinkingLevel: "off", model,
        queuedMessages: { steering: [], followUp: [] }, pendingExtensionUiRequests: [] },
    });
  }
  if (url.pathname === `/api/sessions/${sessionId}/state`) {
    return json(response, {
      running: state.runtimeRunning,
      state: { isStreaming: state.runtimeStreaming, isPromptRunning: false, thinkingLevel: "off", model,
        queuedMessages: { steering: [], followUp: [] } },
    });
  }
  if (url.pathname === `/api/sessions/${sessionId}` && request.method === "GET") {
    const hasPromptHistory = state.promptPosts.length > 0;
    state.historyReads.push({ at: Date.now(), postCount: state.promptPosts.length, entryCount: state.promptPosts.length, eventCount: state.events.length });
    const snapshot = hasPromptHistory ? historySnapshot() : emptySnapshot();
    const terminalSeen = state.events.some((event) => event.type === "agent_end" || event.type === "agent_settled");
    if (hasPromptHistory && !terminalSeen) {
      state.pendingHistory.push({ response, snapshot });
      return;
    }
    return json(response, snapshot);
  }
  if (url.pathname === "/api/models") {
    return json(response, { models: {}, modelList: [], skills: [], running: state.runtimeRunning, isStreaming: state.runtimeStreaming, tools: [] });
  }
  if (url.pathname.startsWith("/api/")) return json(response, { success: true, data: {} });
  response.setHeader("content-type", "text/html; charset=utf-8");
  return response.end("<!doctype html><html><body><div id=\"root\"></div><script src=\"/bundle.js\"></script></body></html>");
});

async function waitFor(check, label, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForSse(page, type, count = 1) {
  await page.waitForFunction(({ eventType, minimum }) => (
    (window.__identitySseEvents || []).filter((event) => event.type === eventType).length >= minimum
  ), { eventType: type, minimum: count }, { timeout: 5000 });
}

async function openScenario(browser, origin, spec) {
  const scenarioState = resetState(spec.name);
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: spec.width, height: 820 } });
  await context.addInitScript((fixture) => { window.__USER_MESSAGE_IDENTITY_FIXTURE__ = fixture; }, { sessionId });
  await context.addInitScript(() => {
    window.__identitySseEvents = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          try { window.__identitySseEvents.push(JSON.parse(event.data)); } catch { /* fixture only */ }
        });
      }
    };
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push({ scenario: spec.name, message: error.message }));
  page.on("request", (item) => {
    if (new URL(item.url()).origin !== origin) externalRequests.push(item.url());
  });
  await page.goto(origin);
  await page.locator('[data-fixture-ready="true"]').waitFor({ state: "attached", timeout: 5000 });
  await waitFor(() => scenarioState.historyReads.length >= 1, `${spec.name} initial history GET`);
  await waitFor(() => scenarioState.streamConnections >= 1, `${spec.name} SSE connection`);
  return { context, page, scenarioState };
}

async function sendPrompt(page, scenarioState, sequence = 0) {
  const before = scenarioState.promptPosts.length;
  await page.evaluate(({ message, image }) => {
    void window.fixture.send(message, image);
  }, {
    message: promptText,
    image: { data: optimisticImageData, mimeType: imageMimeType, previewUrl: "data:image/png;base64,fixture" },
  });
  await waitFor(() => scenarioState.promptPosts.length > before, `prompt POST ${sequence + 1}`);
  const post = scenarioState.promptPosts.at(-1);
  assert.ok(post?.requestId, "prompt POST must carry a requestId");
  assert.equal(post.body.message, promptText);
  assert.deepEqual(post.body.images, [{ type: "image", data: optimisticImageData, mimeType: imageMimeType }]);
  return post;
}

async function waitForHistoryAfter(page, scenarioState, previousReads, label) {
  await waitFor(() => scenarioState.historyReads.length > previousReads, `${label} history GET`);
  await page.getByText(historyText, { exact: true }).first().waitFor({ state: "visible", timeout: 5000 });
}

async function userBubbleCount(page) {
  return page.locator('[data-user-bubble="true"]').count();
}

async function finishScenario(page, scenarioState, spec, requestIds) {
  await waitForSse(page, "message_end", spec.messageEndEvents || 1);
  const requiredMinimum = baseline
    ? (spec.baselineExact ?? spec.baselineMinimum ?? 0)
    : spec.candidateExact;
  await waitFor(async () => (await userBubbleCount(page)) >= requiredMinimum, `${spec.name} user bubble DOM`);
  const count = await userBubbleCount(page);
  if (baseline) {
    if (typeof spec.baselineExact === "number") assert.equal(count, spec.baselineExact, `${spec.name}: baseline bubble count`);
    if (typeof spec.baselineMinimum === "number") assert.ok(count >= spec.baselineMinimum, `${spec.name}: baseline must preserve separate entries`);
  } else {
    assert.equal(count, spec.candidateExact, `${spec.name}: candidate user bubble count`);
  }
  return {
    scenario: spec.name,
    baseline,
    requestIds,
    promptPosts: scenarioState.promptPosts.map((post) => ({ requestId: post.requestId, message: post.body.message, images: post.body.images })),
    historyReads: scenarioState.historyReads.length,
    historyReadEvidence: scenarioState.historyReads.map(({ postCount, entryCount, eventCount }) => ({ postCount, entryCount, eventCount })),
    sseEvents: scenarioState.events.map((event) => ({ type: event.type, requestId: event.requestId, receipt: event.receipt })),
    userBubbleCount: count,
    historyTextCount: await page.getByText(historyText, { exact: true }).count(),
  };
}

async function runScenario(browser, origin, spec) {
  const { context, page, scenarioState } = await openScenario(browser, origin, spec);
  try {
    const first = await sendPrompt(page, scenarioState);
    await waitFor(() => scenarioState.streamConnections >= 1, `${spec.name} prompt SSE readiness`);

    if (spec.name === "history-before-message-end") {
      emitEvent({ type: "agent_start" });
      const readsBefore = scenarioState.historyReads.length;
      emitEvent({ type: "agent_end" });
      await waitForHistoryAfter(page, scenarioState, readsBefore, spec.name);
      emitEvent({ type: "message_end", requestId: first.requestId, message: historyUser(first, 0) });
      return await finishScenario(page, scenarioState, spec, [first.requestId]);
    }

    if (spec.name === "sse-first-history-after") {
      emitEvent({ type: "agent_start" });
      emitEvent({ type: "message_end", requestId: first.requestId, message: historyUser(first, 0) });
      await waitForSse(page, "message_end");
      await page.getByText(historyText, { exact: true }).waitFor({ state: "visible", timeout: 5000 });
      const readsBefore = scenarioState.historyReads.length;
      emitEvent({ type: "agent_end" });
      await waitForHistoryAfter(page, scenarioState, readsBefore, spec.name);
      return await finishScenario(page, scenarioState, spec, [first.requestId]);
    }

    if (spec.name === "duplicate-message-end") {
      emitEvent({ type: "agent_start" });
      emitEvent({ type: "message_end", requestId: first.requestId, message: historyUser(first, 0) });
      emitEvent({ type: "message_end", requestId: first.requestId, message: historyUser(first, 0) });
      return await finishScenario(page, scenarioState, { ...spec, messageEndEvents: 2 }, [first.requestId]);
    }

    if (spec.name === "committed-receipt-before-history") {
      emitEvent({ type: "agent_start" });
      emitEvent({ type: "prompt_delivery", requestId: first.requestId,
        receipt: { status: "committed", entryId: "user-entry-1" } });
      await waitForSse(page, "prompt_delivery");
      const readsBefore = scenarioState.historyReads.length;
      emitEvent({ type: "agent_end" });
      await waitForHistoryAfter(page, scenarioState, readsBefore, spec.name);
      emitEvent({ type: "message_end", requestId: first.requestId, message: historyUser(first, 0) });
      return await finishScenario(page, scenarioState, spec, [first.requestId]);
    }

    if (spec.name === "same-content-different-requests") {
      emitEvent({ type: "agent_start" });
      emitEvent({ type: "message_end", requestId: first.requestId, message: optimisticEventUser(first) });
      const firstReads = scenarioState.historyReads.length;
      emitEvent({ type: "agent_settled" });
      await waitFor(() => !scenarioState.runtimeRunning, "first prompt settlement");
      await waitForHistoryAfter(page, scenarioState, firstReads, "first prompt settlement");
      await page.locator('[data-fixture-ready="true"][data-agent-running="false"]').waitFor({ state: "attached", timeout: 5000 });

      const second = await sendPrompt(page, scenarioState, 1);
      emitEvent({ type: "agent_start" });
      emitEvent({ type: "message_end", requestId: second.requestId, message: optimisticEventUser(second) });
      const secondReads = scenarioState.historyReads.length;
      emitEvent({ type: "agent_settled" });
      await waitFor(() => !scenarioState.runtimeRunning, "second prompt settlement");
      await waitForHistoryAfter(page, scenarioState, secondReads, "second prompt settlement");
      assert.notEqual(first.requestId, second.requestId, "identical content prompts must have different request IDs");
      assert.deepEqual(first.body.images, second.body.images, "identical content prompts must carry identical images");
      const result = await finishScenario(page, scenarioState, { ...spec, messageEndEvents: 2 }, [first.requestId, second.requestId]);
      if (!baseline) assert.equal(result.userBubbleCount, 2, "different request IDs must retain two identical user bubbles");
      return result;
    }

    throw new Error(`Unhandled scenario ${spec.name}`);
  } finally {
    await context.close();
  }
}

let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.COMPOSER_CHROMIUM_PATH ? { executablePath: process.env.COMPOSER_CHROMIUM_PATH } : {}),
  });
  const specs = [
    { name: "history-before-message-end", width: 1280, candidateExact: 1, baselineExact: 2 },
    { name: "sse-first-history-after", width: 1280, candidateExact: 1, baselineExact: 1 },
    { name: "duplicate-message-end", width: 390, candidateExact: 1, baselineExact: 2, messageEndEvents: 2 },
    { name: "committed-receipt-before-history", width: 1280, candidateExact: 1, baselineExact: 2 },
    { name: "same-content-different-requests", width: 390, candidateExact: 2, baselineMinimum: 2, messageEndEvents: 2 },
  ];
  const aliases = {
    "history-first": "history-before-message-end",
    "sse-first": "sse-first-history-after",
    "duplicate-request": "duplicate-message-end",
    "receipt-first": "committed-receipt-before-history",
    "same-content": "same-content-different-requests",
  };
  const names = (requestedScenarios || specs.map((spec) => spec.name)).map((name) => aliases[name] || name);
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  const unknown = names.filter((name) => !byName.has(name));
  assert.deepEqual(unknown, [], `unknown USER_MESSAGE_IDENTITY_SCENARIOS value(s); choose from ${specs.map((spec) => spec.name).join(", ")}`);
  assert.ok(names.length > 0, "USER_MESSAGE_IDENTITY_SCENARIOS must contain at least one scenario");

  const results = [];
  for (const name of names) results.push(await runScenario(browser, origin, byName.get(name)));
  const apiWrites = requestLog.filter((request) => request.method === "POST" && request.path.startsWith("/api/"));
  assert.equal(externalRequests.length, 0, "browser traffic must stay inside the local fixture");
  assert.deepEqual(pageErrors, [], "fixture browser pages must not raise exceptions");
  console.log(JSON.stringify({ status: "passed", sourceRoot, baseline, selectedScenarios: names,
    productionRequests: 0, apiWrites: apiWrites.map(({ path, body }) => ({ path, type: body?.type, requestId: body?.requestId })),
    results, pageErrors, externalRequests }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", sourceRoot, baseline,
    error: String(error?.stack || error), requestLog, pageErrors, externalRequests }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  if (state) for (const pending of state.pendingHistory.splice(0)) json(pending.response, pending.snapshot);
  if (state) for (const stream of state.streams) stream.end();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
