// Idle-session regression fixture for a turn committed while the browser missed every event.
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");
const sourceRoot = process.env.LATEST_TURN_SOURCE_ROOT
  || process.env.HISTORY_SOURCE_ROOT
  || fileURLToPath(new URL("..", import.meta.url));
const baseline = process.argv.includes("--baseline") || process.env.LATEST_TURN_BASELINE === "1";
const requestedScenarioNames = process.env.LATEST_TURN_SCENARIOS
  ? process.env.LATEST_TURN_SCENARIOS.split(",").map((name) => name.trim()).filter(Boolean)
  : null;
const artifactDir = process.env.LATEST_TURN_ARTIFACT_DIR || null;

const oldAssistant = "旧回答：服务器最初的历史";
const latestAssistant = "最新回答：错过事件后仍应自动出现";
const oldUser = "旧提问：初始历史";
const latestUser = "最新提问：已完成的新一轮";
const oldModified = "2026-10-13T00:00:00.000Z";
const latestModified = "2026-10-13T00:00:01.000Z";

const requests = [];
const pageErrors = [];
const externalRequests = [];
const sessions = new Map();
const streams = new Set();
let diagnosticPage;

function json(response, value, status = 200) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(JSON.stringify(value));
}

function message(role, text, entryId, timestamp) {
  return { role, content: [{ type: "text", text }], entryId, timestamp };
}

function makeSession(id, mode) {
  return {
    id,
    mode,
    latest: false,
    runtimeRunning: false,
    sseConnections: 0,
    messageEndEvents: 0,
    settlementEvents: 0,
    visibilityEvents: 0,
    sessionReads: 0,
    holdNextDetail: false,
    pendingDetail: null,
    staleDetailSnapshotRevision: null,
    info: {
      id,
      path: `/isolated/${id}.jsonl`,
      cwd: "/isolated/latest-turn-fixture",
      name: `Latest turn ${id}`,
      created: oldModified,
      modified: oldModified,
      messageCount: 2,
      firstMessage: oldUser,
    },
  };
}

function sessionSnapshot(config) {
  const messages = [
    message("user", oldUser, "old-user", 1000),
    message("assistant", oldAssistant, "old-assistant", 1001),
  ];
  const entryIds = ["old-user", "old-assistant"];
  if (config.latest) {
    messages.push(message("user", latestUser, "latest-user", 2000));
    messages.push(message("assistant", latestAssistant, "latest-assistant", 2001));
    entryIds.push("latest-user", "latest-assistant");
  }
  return {
    sessionId: config.id,
    filePath: config.info.path,
    totalActiveMs: 0,
    tree: [],
    leafId: null,
    treeFormat: "summary",
    snapshotRevision: config.latest ? "latest" : "old",
    info: config.info,
    context: {
      messages,
      entryIds,
      oldestEntryId: entryIds[0],
      hasMore: false,
      thinkingLevel: "off",
      model: { provider: "openai", modelId: "gpt-6.1-sol" },
    },
  };
}

const bundle = await build({
  stdin: {
    resolveDir: sourceRoot,
    loader: "tsx",
    contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { useAgentSession } from "./hooks/useAgentSession";
      import { getSessionEpoch } from "./lib/session-sync-client";

      const fixture = window.__LATEST_TURN_FIXTURE__;
      const initialSession = {
        id: fixture.id,
        path: "/isolated/" + fixture.id + ".jsonl",
        cwd: "/isolated/latest-turn-fixture",
        name: "Latest turn " + fixture.id,
        created: fixture.oldModified,
        modified: fixture.oldModified,
        messageCount: 2,
        firstMessage: "旧提问：初始历史",
      };

      function textOf(message) {
        const content = message?.content;
        if (typeof content === "string") return content;
        if (!Array.isArray(content)) return "";
        return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
      }

      async function changeServer(action) {
        const response = await fetch("/fixture/" + fixture.id + "/" + action);
        if (!response.ok) throw new Error("fixture action failed: " + action);
      }

      function Fixture() {
        const [session, setSession] = useState(initialSession);
        const [sessionRunning, setSessionRunning] = useState(false);
        const hook = useAgentSession({ session, sessionRunning, newSessionCwd: null, newSessionDraftKey: null });
        const originalHandler = hook.handleAgentEventRef.current;
        hook.handleAgentEventRef.current = event => {
          const before = getSessionEpoch(session.id);
          originalHandler(event);
          (window.__hookEvents ||= []).push({type:event.type,before,after:getSessionEpoch(session.id),running:hook.agentRunning});
        };
        const advanceMetadata = async () => {
          await changeServer("metadata");
          setSession({ ...initialSession, modified: fixture.latestModified });
        };
        const advanceOnline = async () => {
          await changeServer("online");
          window.dispatchEvent(new Event("online"));
        };
        const advanceSse = async () => { await changeServer("sse"); };
        const advanceLateMessageEnd = async () => { await changeServer("late-message-end"); };
        const advancePassiveSettlement = async () => { await changeServer("passive-settlement"); };
        const advanceVisibility = async () => {
          await changeServer("visibility");
          document.dispatchEvent(new Event("visibilitychange"));
        };
        const startBarrier = async () => {
          await changeServer("barrier-start");
          setSession({ ...initialSession, modified: fixture.latestModified });
        };
        const finishBarrier = async () => { await changeServer("barrier-terminal"); };
        const releaseBarrier = async () => { await changeServer("barrier-release"); };
        const startMissedRun = async () => {
          await changeServer("start");
          setSessionRunning(true);
        };
        const finishMissedRun = async () => {
          await changeServer("finish");
          setSessionRunning(false);
        };
        return <>
          <button id="advance-metadata" onClick={advanceMetadata}>更新会话修改时间</button>
          <button id="advance-online" onClick={advanceOnline}>模拟 online</button>
          <button id="advance-sse" onClick={advanceSse}>模拟 SSE 重连</button>
          <button id="advance-late-message-end" onClick={advanceLateMessageEnd}>模拟迟到 message_end</button>
          <button id="advance-passive-settlement" onClick={advancePassiveSettlement}>模拟被动结算</button>
          <button id="advance-visibility" onClick={advanceVisibility}>模拟回到前台</button>
          <button id="barrier-start" onClick={startBarrier}>开始受控详情读取</button>
          <button id="barrier-terminal" onClick={finishBarrier}>发送终止事件</button>
          <button id="barrier-release" onClick={releaseBarrier}>释放旧详情读取</button>
          <button id="running-start" onClick={startMissedRun}>开始遗漏轮次</button>
          <button id="running-finish" onClick={finishMissedRun}>结束遗漏轮次</button>
          <output id="fixture-state" data-session-running={String(sessionRunning)} data-session-modified={session.modified} />
          <output id="hook-state" data-loaded={String(!hook.loading)} data-error={hook.error || ""} />
          <main id="transcript">
            {hook.messages.map((item, index) => <div key={index} data-message-role={item.role}>{textOf(item)}</div>)}
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

function recordRequest(request, url) {
  requests.push({ method: request.method, path: url.pathname + url.search });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://latest-turn-fixture");
  recordRequest(request, url);

  if (url.pathname === "/bundle.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    return response.end(bundle.outputFiles[0].text);
  }
  const fixtureMatch = /^\/fixture\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (fixtureMatch) {
    const config = sessions.get(decodeURIComponent(fixtureMatch[1]));
    if (!config) return json(response, { error: "unknown fixture" }, 404);
    const action = fixtureMatch[2];
    if (action === "metadata" || action === "online" || action === "sse" || action === "finish") {
      config.latest = true;
      if (action === "metadata") config.info.modified = latestModified;
      if (action === "finish") config.runtimeRunning = false;
    } else if (action === "late-message-end") {
      config.latest = true;
      config.messageEndEvents += 1;
      for (const stream of [...streams]) {
        if (stream.sessionId === config.id && !stream.response.destroyed && !stream.response.writableEnded) {
          stream.response.write(`data: ${JSON.stringify({
            type: "message_end",
            message: message("assistant", latestAssistant, "latest-assistant", 2001),
          })}\n\n`);
        }
      }
    } else if (action === "passive-settlement") {
      config.latest = true;
      config.settlementEvents += 1;
      for (const stream of [...streams]) {
        if (stream.sessionId === config.id && !stream.response.destroyed && !stream.response.writableEnded) {
          stream.response.write(`data: ${JSON.stringify({ type: "agent_settled" })}\n\n`);
        }
      }
    } else if (action === "visibility") {
      config.latest = true;
      config.visibilityEvents += 1;
    } else if (action === "barrier-start") {
      config.holdNextDetail = true;
    } else if (action === "barrier-terminal") {
      config.latest = true;
      config.info.modified = latestModified;
      config.messageEndEvents += 1;
      for (const stream of [...streams]) {
        if (stream.sessionId === config.id && !stream.response.destroyed && !stream.response.writableEnded) {
          stream.response.write(`data: ${JSON.stringify({
            type: "message_end",
            message: message("assistant", latestAssistant, "latest-assistant", 2001),
          })}\n\n`);
        }
      }
    } else if (action === "barrier-release") {
      const pending = config.pendingDetail;
      if (!pending) return json(response, { error: "no pending detail" }, 409);
      config.pendingDetail = null;
      json(pending.response, pending.snapshot);
    } else if (action === "start") {
      config.runtimeRunning = true;
    } else {
      return json(response, { error: "unknown fixture action" }, 404);
    }
    if (action === "sse") {
      for (const stream of [...streams]) {
        if (stream.sessionId === config.id) stream.response.end();
      }
    }
    return json(response, { ok: true });
  }

  const eventsMatch = /^\/api\/agent\/([^/]+)\/events$/.exec(url.pathname);
  if (eventsMatch) {
    const id = decodeURIComponent(eventsMatch[1]);
    const config = sessions.get(id);
    if (!config) return json(response, { error: "unknown session" }, 404);
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache");
    response.setHeader("connection", "keep-alive");
    config.sseConnections += 1;
    const stream = { sessionId: id, response };
    streams.add(stream);
    response.on("close", () => streams.delete(stream));
    if (config.mode === "sse" || config.mode === "barrier") {
      response.write(`data: ${JSON.stringify({ type: "connected", isStreaming: false })}\n\n`);
    }
    return;
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(state))?$/.exec(url.pathname);
  if (sessionMatch) {
    const config = sessions.get(decodeURIComponent(sessionMatch[1]));
    if (!config) return json(response, { error: "unknown session" }, 404);
    if (sessionMatch[2] === "state") {
      return json(response, {
        running: config.runtimeRunning,
        state: { isStreaming: false, isPromptRunning: false, queuedMessages: { steering: [], followUp: [] } },
      });
    }
    config.sessionReads += 1;
    const snapshot = sessionSnapshot(config);
    if (config.holdNextDetail) {
      config.holdNextDetail = false;
      config.pendingDetail = { response, snapshot };
      config.staleDetailSnapshotRevision = snapshot.snapshotRevision;
      return;
    }
    return json(response, snapshot);
  }

  const agentMatch = /^\/api\/agent\/([^/]+)$/.exec(url.pathname);
  if (agentMatch) {
    const config = sessions.get(decodeURIComponent(agentMatch[1]));
    if (!config) return json(response, { error: "unknown session" }, 404);
    if (url.searchParams.get("interactions") === "1") {
      return json(response, { pendingExtensionUiRequests: [], uncommittedPrompts: [] });
    }
    return json(response, { running: config.runtimeRunning, state: { isStreaming: false, isPromptRunning: false } });
  }
  if (url.pathname === "/api/models") {
    return json(response, { models: {}, modelList: [], skills: [], modelScopeWarnings: [], tools: [] });
  }
  if (url.pathname.startsWith("/api/")) return json(response, { ok: true });
  response.setHeader("content-type", "text/html; charset=utf-8");
  return response.end("<!doctype html><html><body><div id=\"root\"></div><script src=\"/bundle.js\"></script></body></html>");
});

async function waitFor(check, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const screenshots = [];
const screenshotErrors = [];
async function captureScreenshot(page, name) {
  if (!artifactDir || baseline) return;
  try {
    await fs.mkdir(artifactDir, { recursive: true });
    const target = path.join(artifactDir, `${name}.png`);
    await page.screenshot({ path: target, fullPage: true });
    screenshots.push(target);
  } catch (error) {
    screenshotErrors.push({ name, error: String(error?.message || error) });
  }
}

async function runScenario(browser, origin, spec) {
  const config = makeSession(spec.id, spec.mode);
  sessions.set(config.id, config);
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: spec.width, height: 820 } });
  await context.addInitScript((fixture) => { window.__LATEST_TURN_FIXTURE__ = fixture; }, {
    id: config.id,
    oldModified,
    latestModified,
  });
  await context.addInitScript(() => {
    window.__fixtureEvents = [];
    const NativeEventSource = window.EventSource;
    window.EventSource = class extends NativeEventSource {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", event => window.__fixtureEvents.push(JSON.parse(event.data).type));
      }
    };
  });
  const page = await context.newPage();
  diagnosticPage = page;
  const scenarioErrors = [];
  page.on("pageerror", (error) => { pageErrors.push(error.message); scenarioErrors.push(error.message); });
  page.on("request", (item) => {
    if (new URL(item.url()).origin !== origin) externalRequests.push(item.url());
  });
  await page.goto(origin);
  await page.getByText(oldAssistant, { exact: true }).waitFor({ timeout: 5000 });
  const readsBefore = config.sessionReads;

  if (spec.name === "running-transition") {
    await page.locator("#running-start").click();
    await page.locator('#fixture-state[data-session-running="true"]').waitFor({ state: "attached", timeout: 2000 });
    await page.locator("#running-finish").click();
  } else if (spec.name === "late-message-end-idle") {
    await waitFor(() => config.sseConnections >= 1, "late message_end SSE stream", 2500);
    await page.locator("#advance-late-message-end").click();
  } else if (spec.name === "passive-settlement-idle") {
    await waitFor(() => config.sseConnections >= 1, "passive settlement SSE stream", 2500);
    await page.locator("#advance-passive-settlement").click();
  } else if (spec.name === "visibility-while-idle") {
    await page.locator("#advance-visibility").click();
  } else if (spec.name === "terminal-barrier-race") {
    await waitFor(() => config.sseConnections >= 1, "terminal barrier SSE stream", 2500);
    await page.locator("#barrier-start").click();
    if (!baseline) await waitFor(() => Boolean(config.pendingDetail), "held stale detail request", 2500);
    await page.locator("#barrier-terminal").click();
  } else {
    await page.locator(`#${spec.button}`).click();
  }

  if (spec.name === "sse-reconnect") {
    await waitFor(() => config.sseConnections >= 2, "SSE reconnect", 3500);
  }
  if (baseline) {
    await page.waitForTimeout(spec.name === "sse-reconnect" ? 500 : 350);
    assert.equal(await page.getByText(latestAssistant, { exact: true }).count(), 0,
      `${spec.name}: baseline must keep the missed turn stale`);
  } else {
    await page.getByText(latestAssistant, { exact: true }).waitFor({ timeout: spec.name === "sse-reconnect" ? 5000 : 2500 });
    assert.equal(await page.getByText(latestAssistant, { exact: true }).count(), 1,
      `${spec.name}: latest assistant must be visible exactly once`);
    await waitFor(() => config.sessionReads > readsBefore, `${spec.name} history refresh request`);
    if (spec.name === "terminal-barrier-race") {
      assert.equal(config.staleDetailSnapshotRevision, "old",
        "terminal barrier must have captured the old detail snapshot at request start");
      assert.equal(config.messageEndEvents, 1, "terminal barrier must deliver one late message_end event");
      await page.locator("#barrier-release").click();
      await waitFor(() => config.pendingDetail === null, "stale detail response release");
      await page.waitForTimeout(180);
      assert.equal(await page.getByText(latestAssistant, { exact: true }).count(), 1,
        "a released stale detail response must not overwrite the terminal refresh");
    }
  }

  if (spec.name === "late-message-end-idle") {
    assert.equal(config.messageEndEvents, 1, "late message_end fixture must emit one terminal event");
  }
  if (spec.name === "passive-settlement-idle") {
    assert.equal(config.settlementEvents, 1, "passive settlement fixture must emit one terminal event");
  }
  if (spec.name === "visibility-while-idle") {
    assert.equal(config.visibilityEvents, 1, "visibility fixture must dispatch one visible transition");
  }
  if (spec.name === "terminal-barrier-race" && baseline) {
    assert.equal(config.messageEndEvents, 1, "terminal barrier fixture must emit one terminal event");
    assert.equal(config.pendingDetail, null, "baseline must not create the controlled detail request");
  }
  await captureScreenshot(page, spec.name);
  assert.deepEqual(scenarioErrors, [], `${spec.name}: browser page errors`);
  await context.close();
  return {
    name: spec.name,
    width: spec.width,
    baseline,
    sessionReads: config.sessionReads,
    refreshRequested: config.sessionReads > readsBefore,
    latestVisible: await Promise.resolve(baseline ? false : true),
    sseConnections: config.sseConnections,
    messageEndEvents: config.messageEndEvents,
    settlementEvents: config.settlementEvents,
    visibilityEvents: config.visibilityEvents,
    staleDetailSnapshotRevision: config.staleDetailSnapshotRevision,
  };
}

let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.COMPOSER_CHROMIUM_PATH ? { executablePath: process.env.COMPOSER_CHROMIUM_PATH } : {}),
  });
  const scenarioSpecs = [
    { name: "metadata-change-idle", id: "latest-turn-metadata", mode: "silent", width: 1280, button: "advance-metadata" },
    { name: "online-while-idle", id: "latest-turn-online", mode: "silent", width: 390, button: "advance-online" },
    { name: "sse-reconnect", id: "latest-turn-sse", mode: "sse", width: 1280, button: "advance-sse" },
    { name: "late-message-end-idle", id: "latest-turn-message-end", mode: "sse", width: 1280 },
    { name: "passive-settlement-idle", id: "latest-turn-passive-settlement", mode: "sse", width: 1280 },
    { name: "visibility-while-idle", id: "latest-turn-visibility", mode: "silent", width: 390 },
    { name: "terminal-barrier-race", id: "latest-turn-terminal-barrier", mode: "barrier", width: 390 },
    { name: "running-transition", id: "latest-turn-running", mode: "silent", width: 390 },
  ];
  const scenarioAliases = {
    "late-message-end": "late-message-end-idle",
    "passive-settlement": "passive-settlement-idle",
    "visibility": "visibility-while-idle",
    "terminal-barrier": "terminal-barrier-race",
  };
  const selectedNames = (requestedScenarioNames || scenarioSpecs.map((spec) => spec.name))
    .map((name) => scenarioAliases[name] || name);
  const knownNames = new Set(scenarioSpecs.map((spec) => spec.name));
  const unknownNames = selectedNames.filter((name) => !knownNames.has(name));
  assert.deepEqual(unknownNames, [], `unknown LATEST_TURN_SCENARIOS value(s); choose from ${[...knownNames].join(", ")}`);
  assert.ok(selectedNames.length > 0, "LATEST_TURN_SCENARIOS must name at least one scenario");
  const specsByName = new Map(scenarioSpecs.map((spec) => [spec.name, spec]));
  const scenarios = [];
  for (const name of selectedNames) scenarios.push(await runScenario(browser, origin, specsByName.get(name)));

  const leaseRenewals = requests.filter((request) => request.method === "POST" && request.path.endsWith("/lease")).length;
  const apiWrites = requests.filter((request) => request.method === "POST" && request.path.startsWith("/api/") && !request.path.endsWith("/lease"));
  assert.deepEqual(apiWrites, [], "the fixture must not submit model or prompt POST requests");
  assert.deepEqual(pageErrors, [], "the idle refresh fixture must not raise browser exceptions");
  assert.deepEqual(externalRequests, [], "all browser traffic must remain on the isolated HTTP fixture");
  console.log(JSON.stringify({ status: "passed", sourceRoot, baseline, selectedScenarios: selectedNames,
    scenarios, screenshots, screenshotErrors, leaseRenewals, apiWrites, pageErrors, externalRequests }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: "failed", sourceRoot, baseline, error: String(error?.stack || error), browser: diagnosticPage ? await diagnosticPage.evaluate(() => ({events:window.__fixtureEvents,hookEvents:window.__hookEvents,transcript:document.querySelector('#transcript')?.innerText,error:document.querySelector('#hook-state')?.getAttribute('data-error')})).catch(()=>null) : null, sessions: [...sessions.values()].map(({id,sessionReads,sseConnections,messageEndEvents,staleDetailSnapshotRevision,pendingDetail}) => ({id,sessionReads,sseConnections,messageEndEvents,staleDetailSnapshotRevision,pendingDetail:Boolean(pendingDetail)})), requests, pageErrors, externalRequests }, null, 2));
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
