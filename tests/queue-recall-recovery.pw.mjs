// Exercise native prompt recall, inbox recovery, and draft acknowledgement in an isolated browser fixture.
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const { chromium } = require(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("..", import.meta.url));
const sessionId = "recall-fixture";
const sourceText = "撤回后恢复的原始消息";
const image = { data: "aGVsbG8=", mimeType: "image/png" };
const imageWithPreview = { ...image, previewUrl: "data:image/png;base64,aGVsbG8=" };
const recalledLabel = "消息已撤回，原文已保留";
const restoreLabel = "恢复到输入框";
const confirmLabel = "确认草稿保存";

const bundle = await esbuild.build({
  stdin: {
    resolveDir: root,
    loader: "tsx",
    contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { I18nProvider } from "./hooks/useI18n";
      import { useAgentSession } from "./hooks/useAgentSession";
      import { ChatInput } from "./components/ChatInput";
      import { getDraft } from "./lib/draft-store";
      import { getPendingPromptSubmissions } from "./lib/prompt-submissions";

      const originalFetch = window.fetch.bind(window);
      window.__ackDraftSnapshots = [];
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (new URL(url, window.location.href).pathname === "/api/agent/recall-fixture"
          && body?.type === "acknowledge_recalled_prompts") {
          const raw = localStorage.getItem("pi-enh-composer-draft-v3:" + encodeURIComponent("recall-fixture"));
          window.__ackDraftSnapshots.push(raw ? JSON.parse(raw) : null);
        }
        return originalFetch(input, init);
      };

      function Harness() {
        const sid = "recall-fixture";
        const h = useAgentSession({
          session: { id: sid, path: "/isolated/recall-fixture.jsonl", cwd: "/isolated", name: sid,
            created: "2026-10-11T00:00:00.000Z", modified: "2026-10-11T00:00:00.000Z",
            messageCount: 0, firstMessage: "" },
          newSessionCwd: null, newSessionDraftKey: null,
        });
        window.fixture = {
          submit: (text, attached) => h.handleFollowUp(text, attached),
          recall: () => h.handleRecallQueue(),
          rows: () => getPendingPromptSubmissions(),
          draft: () => getDraft(sid),
          ackDrafts: () => window.__ackDraftSnapshots,
        };
        const draft = getDraft(sid);
        return <>
          <button type="button" data-run-recall onClick={() => void h.handleRecallQueue()}>执行队列召回</button>
          <output data-current-draft>{draft?.value ?? ""}</output>
          <output data-current-image-count>{draft?.images.length ?? 0}</output>
          <ChatInput draftKey={sid} isStreaming={false} onSend={() => {}} onAbort={() => {}}
            retainedSubmissions={h.unconfirmedSubmissions}
            onConfirmSubmission={(row) => h.confirmPendingSubmission(row)} />
        </>;
      }
      createRoot(document.getElementById("root")).render(<I18nProvider><Harness /></I18nProvider>);
    `,
  },
  bundle: true,
  write: false,
  loader: { ".css": "empty" },
  format: "iife",
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
});

function json(res, body, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function createFixture(scenario) {
  const records = new Map();
  const requests = [];
  let promptPosts = 0;
  let acknowledgementPosts = 0;
  let queueSnapshotPosts = 0;
  let recallAllPosts = 0;
  let lostAcknowledgement = false;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    const path = url.pathname;
    if (path === "/bundle.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(bundle.outputFiles[0].text);
      return;
    }
    if (path === "/") {
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
      return;
    }
    if (path.endsWith("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": fixture ready\n\n");
      res.write('data: {"type":"connected","isStreaming":false}\n\n');
      return;
    }
    if (path.endsWith("/lease") && req.method === "POST") {
      requests.push({ method: req.method, path, body: null });
      json(res, { renewed: 1 });
      return;
    }
    if (path === "/api/models") {
      requests.push({ method: req.method, path, body: null });
      json(res, { models: {}, modelList: [], modelThinkingLevels: {}, modelThinkingLevelMaps: {} });
      return;
    }
    if (path === "/api/sessions/" + sessionId + "/state") {
      requests.push({ method: req.method, path, body: null });
      json(res, { running: false, state: {
        isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false,
        queuedMessages: { steering: [], followUp: [] },
      } });
      return;
    }
    if (path === "/api/sessions/" + sessionId) {
      requests.push({ method: req.method, path, body: null });
      json(res, {
        sessionId, filePath: "/isolated/recall-fixture.jsonl", totalActiveMs: 0,
        tree: [], leafId: null,
        context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false, thinkingLevel: "off", model: null },
      });
      return;
    }
    if (path === "/api/agent/" + sessionId && req.method === "GET") {
      if (url.searchParams.has("requestId")) {
        const record = records.get(url.searchParams.get("requestId"));
        if (!record) {
          requests.push({ method: req.method, path, body: null });
          json(res, { status: "unknown" });
          return;
        }
        if (scenario === "automatic-marker" && record.status === "accepted") record.status = "recalled";
        requests.push({ method: req.method, path, body: null, receiptStatus: record.status });
        json(res, { status: record.status });
        return;
      }
      if (url.searchParams.get("interactions") === "1") {
        const uncommittedPrompts = [...records.values()]
          .filter((record) => record.status === "accepted" || record.status === "recalled")
          .map((record) => ({
            requestId: record.requestId, sessionId, message: record.message, images: record.images,
            status: record.status, createdAt: record.createdAt, streamingBehavior: "followUp",
          }));
        requests.push({ method: req.method, path: path + url.search, body: null, inbox: uncommittedPrompts });
        json(res, { pendingExtensionUiRequests: [], uncommittedPrompts });
        return;
      }
      requests.push({ method: req.method, path, body: null });
      json(res, { running: false });
      return;
    }
    if (path === "/api/agent/" + sessionId && req.method === "POST") {
      const body = await readJson(req);
      requests.push({ method: req.method, path, body });
      if (body.type === "prompt") {
        promptPosts += 1;
        const record = {
          requestId: body.requestId, message: String(body.message ?? ""),
          images: (Array.isArray(body.images) ? body.images : []).map(({ data, mimeType }) => ({ data, mimeType })),
          status: "accepted", createdAt: Date.now(),
        };
        records.set(record.requestId, record);
        json(res, { success: true, data: {}, requestId: record.requestId, receipt: { status: "accepted" } });
        return;
      }
      if (body.type === "get_queue_actions") {
        queueSnapshotPosts += 1;
        const record = [...records.values()].find((candidate) => candidate.status === "accepted" || candidate.status === "recalled");
        json(res, { success: true, data: {
          version: 2, steering: [], followUp: record ? [{ token: "recall-token", text: record.message, imageCount: record.images.length }] : [],
        } });
        return;
      }
      if (body.type === "recall_all_queued_messages") {
        recallAllPosts += 1;
        const record = [...records.values()].find((candidate) => candidate.status === "accepted");
        if (!record || JSON.stringify(body.tokens) !== JSON.stringify(["recall-token"])) {
          json(res, { error: "Fixture queue token mismatch" }, 409);
          return;
        }
        record.status = "recalled";
        if (scenario === "lost-recall") {
          // A gateway lost the successful upstream response. Returning 502
          // avoids Chromium transparently retrying a reset keep-alive socket;
          // the fixture must exercise the application's recovery path.
          json(res, { error: "Gateway lost upstream recall response" }, 502);
          return;
        }
        json(res, { success: true, data: {
          version: 2,
          entries: [{ token: "recall-token", kind: "followUp", text: record.message, images: record.images }],
          recalledPromptRequestIds: [record.requestId], cancelledPromptRequestIds: [],
        } });
        return;
      }
      if (body.type === "acknowledge_recalled_prompts") {
        acknowledgementPosts += 1;
        const ids = Array.isArray(body.requestIds) ? body.requestIds : [];
        for (const id of ids) {
          const record = records.get(id);
          if (record?.status === "recalled") record.status = "cancelled";
        }
        if (scenario === "lost-recall" && !lostAcknowledgement) {
          lostAcknowledgement = true;
          json(res, { error: "Gateway lost upstream acknowledgement response" }, 502);
          return;
        }
        json(res, { success: true, data: { cancelledPromptRequestIds: ids } });
        return;
      }
      json(res, { success: true, data: {} });
      return;
    }
    requests.push({ method: req.method, path, body: null });
    json(res, { success: true, data: {} });
  });

  return {
    server, requests,
    stats: () => ({ promptPosts, acknowledgementPosts, queueSnapshotPosts, recallAllPosts }),
  };
}

async function startFixture(fixture) {
  await new Promise((resolve) => fixture.server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + fixture.server.address().port;
}

async function stopFixture(fixture) {
  fixture.server.closeAllConnections();
  await new Promise((resolve) => fixture.server.close(resolve));
}

async function submitOriginal(page) {
  await page.evaluate(({ text, attached }) => window.fixture.submit(text, attached), {
    text: sourceText, attached: [imageWithPreview],
  });
}

async function waitForRow(page, status) {
  await page.waitForFunction((expected) => window.fixture?.rows().some((row) => row.status === expected), status);
}

async function assertAcknowledgementFollowedDraftPersistence(page) {
  const snapshots = await page.evaluate(() => window.fixture.ackDrafts());
  assert.equal(snapshots.length, 1, "the fixture must observe one acknowledgement request");
  assert.deepEqual({ value: snapshots[0]?.value, images: snapshots[0]?.images }, { value: sourceText, images: [image] },
    "the persisted same-session draft must already contain the restored text and images when acknowledgement is posted");
}

async function runAutomaticMarker(width, browser) {
  const fixture = createFixture("automatic-marker");
  const origin = await startFixture(fixture);
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 844 } });
  const page = await context.newPage();
  const externalRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.fixture);
    await submitOriginal(page);
    await waitForRow(page, "recalled");
    assert.equal(await page.locator("[data-pi-pending-prompt]").count(), 0, "automatic recall never mounts the legacy amber card");
    assert.equal(await page.locator("[data-pi-saved-prompt]").count(), 0, "the recalled original stays out of the DOM until opened");
    const icon = page.getByRole("button", { name: "已保留消息" });
    await icon.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await icon.count(), 1, "recalled rows expose the neutral history button");
    await icon.click();
    const dialog = page.getByRole("dialog", { name: "已保留消息" });
    const saved = dialog.locator("[data-pi-saved-prompt]");
    await saved.waitFor();
    assert.equal(await saved.getAttribute("data-pi-saved-prompt"), (await page.evaluate(() => window.fixture.rows()[0])).requestId);
    await saved.locator("details > summary").click();
    await dialog.getByText(recalledLabel, { exact: true }).waitFor();
    await dialog.getByText(sourceText, { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => window.fixture.draft()))?.value ?? "", "",
      "the automatic receipt check may mark recalled, but it must not restore into the draft");
    assert.equal((await page.evaluate(() => window.fixture.rows()[0])).message, sourceText);
    assert.equal(fixture.stats().promptPosts, 1);
    await dialog.getByRole("button", { name: "关闭已保留消息" }).click();
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "已保留消息", "closing returns focus to the history button");
    await icon.click();
    await page.getByRole("dialog", { name: "已保留消息" }).getByRole("button", { name: restoreLabel }).click();
    await page.waitForFunction(() => window.fixture.draft()?.value === "撤回后恢复的原始消息"
      && window.fixture.draft()?.images.length === 1);
    await page.waitForFunction(() => window.fixture.rows().length === 0);
    const draft = await page.evaluate(() => window.fixture.draft());
    assert.deepEqual({ value: draft.value, images: draft.images }, { value: sourceText, images: [image] });
    assert.equal(fixture.stats().acknowledgementPosts, 1);
    await assertAcknowledgementFollowedDraftPersistence(page);
    assert.equal(fixture.stats().promptPosts, 1, "restore must not submit a new prompt");
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await stopFixture(fixture);
  }
}

async function runNormalRecall(width, browser) {
  const fixture = createFixture("normal");
  const origin = await startFixture(fixture);
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 844 } });
  const page = await context.newPage();
  const externalRequests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(origin);
    await page.waitForFunction(() => window.fixture);
    await submitOriginal(page);
    await waitForRow(page, "accepted");
    assert.equal(await page.locator("[data-pi-pending-prompt]").count(), 0, "Normal accepted queue keeps its backup without a recovery card");
    assert.equal(await page.getByRole("button", { name: "已保留消息" }).count(), 0, "accepted prompts do not expose the history button");
    assert.equal(await page.locator("[data-pi-saved-prompt]").count(), 0, "accepted originals stay out of the DOM");
    await page.getByRole("button", { name: "执行队列召回" }).click();
    await page.waitForFunction(() => window.fixture.draft()?.value === "撤回后恢复的原始消息"
      && window.fixture.draft()?.images.length === 1);
    await page.waitForFunction(() => window.fixture.rows().length === 0);
    const draft = await page.evaluate(() => window.fixture.draft());
    assert.deepEqual({ value: draft.value, images: draft.images }, { value: sourceText, images: [image] });
    assert.deepEqual(fixture.stats(), { promptPosts: 1, acknowledgementPosts: 1, queueSnapshotPosts: 1, recallAllPosts: 1 });
    await assertAcknowledgementFollowedDraftPersistence(page);
    const ack = fixture.requests.find((request) => request.body?.type === "acknowledge_recalled_prompts");
    assert.deepEqual(ack?.body.requestIds, [fixture.requests.find((request) => request.body?.type === "prompt")?.body.requestId]);
    assert.equal(fixture.requests.filter((request) => request.path.includes("interactions=1")).length, 1);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await stopFixture(fixture);
  }
}

async function runLostRecallAndAcknowledgement(width, browser) {
  const fixture = createFixture("lost-recall");
  const origin = await startFixture(fixture);
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width, height: 844 } });
  const originalTab = await context.newPage();
  const externalRequests = [];
  const errors = [];
  originalTab.on("request", (request) => {
    if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
  });
  originalTab.on("pageerror", (error) => errors.push(error.message));
  try {
    await originalTab.goto(origin);
    await originalTab.waitForFunction(() => window.fixture);
    await submitOriginal(originalTab);
    await waitForRow(originalTab, "accepted");
    await originalTab.evaluate(() => window.fixture.recall());
    assert.equal(fixture.stats().recallAllPosts, 1);
    assert.equal(fixture.stats().promptPosts, 1);

    const newTab = await context.newPage();
    newTab.on("request", (request) => {
      if (new URL(request.url()).origin !== origin) externalRequests.push(request.url());
    });
    newTab.on("pageerror", (error) => errors.push(error.message));
    await newTab.goto(origin);
    await newTab.waitForFunction(() => window.fixture?.rows().some((row) => row.status === "recalled"));
    const inboxRow = await newTab.evaluate(() => window.fixture.rows()[0]);
    assert.equal(inboxRow.message, sourceText, "server inbox must retain the exact recalled original");
    assert.deepEqual(inboxRow.images, [image], "server inbox must retain the original image attachment");
    assert.equal(await newTab.locator("[data-pi-pending-prompt]").count(), 0, "server inbox recovery never mounts the legacy amber card");
    assert.equal(await newTab.locator("[data-pi-saved-prompt]").count(), 0, "the server original stays out of the DOM until opened");
    const icon = newTab.getByRole("button", { name: "已保留消息" });
    await icon.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await icon.count(), 1, "recalled inbox rows expose the neutral history button");
    await icon.click();
    const dialog = newTab.getByRole("dialog", { name: "已保留消息" });
    const saved = dialog.locator("[data-pi-saved-prompt]");
    await saved.waitFor();
    assert.equal(await saved.getAttribute("data-pi-saved-prompt"), inboxRow.requestId);
    await saved.locator("details > summary").click();
    await dialog.getByText(recalledLabel, { exact: true }).waitFor();
    await dialog.getByText(sourceText, { exact: true }).waitFor();
    assert.equal((await newTab.evaluate(() => window.fixture.draft()))?.value ?? "", "",
      "server inbox hydration must not auto-restore a recalled message");

    await dialog.getByRole("button", { name: restoreLabel }).click();
    await newTab.waitForFunction(() => window.fixture.draft()?.value === "撤回后恢复的原始消息"
      && window.fixture.draft()?.images.length === 1);
    await newTab.locator("[data-pi-saved-prompt]").getByRole("button", { name: confirmLabel }).waitFor();
    const afterLostAck = await newTab.evaluate(() => ({
      draft: window.fixture.draft(), row: window.fixture.rows()[0],
    }));
    assert.equal(afterLostAck.row.status, "recalled");
    assert.equal(afterLostAck.row.recallRestored, true, "a lost acknowledgement retains the restoration marker");
    assert.deepEqual({ value: afterLostAck.draft.value, images: afterLostAck.draft.images }, { value: sourceText, images: [image] });
    assert.equal(fixture.stats().acknowledgementPosts, 1);
    await assertAcknowledgementFollowedDraftPersistence(newTab);

    await newTab.locator("[data-pi-saved-prompt]").getByRole("button", { name: confirmLabel }).click();
    await newTab.waitForFunction(() => window.fixture.rows().length === 0);
    const finalDraft = await newTab.evaluate(() => window.fixture.draft());
    assert.deepEqual({ value: finalDraft.value, images: finalDraft.images }, { value: sourceText, images: [image] },
      "a cancelled receipt clears the backup without restoring the same original twice");
    assert.equal(fixture.stats().promptPosts, 1, "neither recovery nor acknowledgement retry may POST a prompt");
    assert.equal(fixture.stats().acknowledgementPosts, 1, "the cancelled receipt clears local state without repeating acknowledgement");
    const interactions = fixture.requests.filter((request) => request.path.includes("interactions=1"));
    assert.equal(interactions.length, 2, "the new tab must obtain the recalled original from the server inbox");
    assert.deepEqual(interactions[1].inbox[0], {
      requestId: inboxRow.requestId, sessionId, message: sourceText, images: [image],
      status: "recalled", createdAt: inboxRow.createdAt, streamingBehavior: "followUp",
    });
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await stopFixture(fixture);
  }
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.COMPOSER_CHROMIUM_PATH ? { executablePath: process.env.COMPOSER_CHROMIUM_PATH } : {}),
  });
  for (const width of [1280, 390]) {
    await runAutomaticMarker(width, browser);
    await runNormalRecall(width, browser);
    await runLostRecallAndAcknowledgement(width, browser);
  }
  console.log(JSON.stringify({
    status: "passed", viewports: [1280, 390],
    scenarios: ["automatic-recalled-marker", "recall-all-restores-once", "lost-recall-and-ack-recovery"],
    isolatedApi: true, promptSubmissionsDuringRecovery: 0,
  }, null, 2));
} finally {
  if (browser) await browser.close();
}
