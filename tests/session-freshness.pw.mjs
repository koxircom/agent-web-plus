// Verify session freshness and race protection: delayed response from older session A must never overwrite active session B (anti-stale).
// Real useAgentSession hook path with real browser HTTP hooks and owner epoch enforcement.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createIsolatedFixtureServer,
  launchIsolatedSessionBrowser,
  FIXTURE_DISCLAIMER,
} from "./fixtures/native-release-browser.mjs";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const root = fileURLToPath(new URL("..", import.meta.url));

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const CURRENT_VERSION = pkg.version;

const sessionA = {
  id: "01901234-fsh0-0000-0000-00000000000a",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Session Alpha (Slow Network)",
  path: "session-a.jsonl",
  created: "2026-10-19T10:00:00Z",
  modified: "2026-10-19T10:00:00Z",
  messageCount: 1,
  firstMessage: "Slow Alpha Prompt",
  pinned: false,
};

const sessionB = {
  id: "01901234-fsh0-0000-0000-00000000000b",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Session Beta (Fast Network)",
  path: "session-b.jsonl",
  created: "2026-10-19T11:00:00Z",
  modified: "2026-10-19T11:00:00Z",
  messageCount: 1,
  firstMessage: "Fast Beta Prompt",
  pinned: false,
};

function makeSessionPayload(sid, text, rev = `${sid}-rev1`) {
  return {
    sessionId: sid,
    filePath: `/isolated/${sid}.jsonl`,
    info: { id: sid, path: `/isolated/${sid}.jsonl`, cwd: "/isolated", name: sid },
    tree: [],
    treeFormat: "summary",
    leafId: "entry-0",
    snapshotRevision: rev,
    promptEntryIds: {},
    totalActiveMs: 0,
    context: {
      messages: [
        { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() },
      ],
      entryIds: ["entry-0"],
      oldestEntryId: "entry-0",
      hasMore: false,
      thinkingLevel: "off",
      model: { provider: "fixture", modelId: "fixture" },
    },
  };
}

const bundle = await esbuild.build({
  entryPoints: [path.join(root, "tests/fixtures/native-session-freshness.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  loader: { ".css": "empty" },
  alias: { "@": root },
  define: {
    "process.env.NODE_ENV": '"development"',
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(CURRENT_VERSION),
    "process.env.NEXT_PUBLIC_PI_VERSION": JSON.stringify(CURRENT_VERSION),
  },
});

let delayedAlphaResolver = null;
let delayedB1Resolver = null;
let holdNextB = false;
let bRequestCounter = 0;
const requestLog = [];

const serverInfo = await createIsolatedFixtureServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${serverInfo.port}`);

  if (url.pathname === "/bundle.js") {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    return res.end(bundle.outputFiles[0].text);
  }

  // Event stream for useAgentSession
  if (url.pathname.startsWith("/api/agent/") && url.pathname.endsWith("/events")) {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.write(`data: ${JSON.stringify({ type: "connected", isStreaming: false })}\n\n`);
    return;
  }

  // Intercept real session sync requests initiated by useAgentSession
  if (url.pathname.startsWith("/api/sessions/")) {
    const segments = url.pathname.slice("/api/sessions/".length).split("/");
    const requestedId = decodeURIComponent(segments[0]);
    const subRoute = segments[1];

    if (subRoute === "state") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        running: false,
        state: { isStreaming: false, isPromptRunning: false, queuedMessages: { steering: [], followUp: [] } },
      }));
    }

    requestLog.push({ id: requestedId, time: Date.now(), query: url.search });

    // Scenario 1: Initial Session A is delayed
    if (requestedId === sessionA.id) {
      new Promise((resolve) => {
        delayedAlphaResolver = resolve;
      }).then(() => {
        if (!res.destroyed && !res.writableEnded) {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(makeSessionPayload(sessionA.id, "Alpha Slow Delayed Content")));
        }
      });
      return;
    }

    // Session B handling
    if (requestedId === sessionB.id) {
      bRequestCounter++;
      if (holdNextB) {
        holdNextB = false;
        new Promise((resolve) => {
          delayedB1Resolver = resolve;
        }).then(() => {
          if (!res.destroyed && !res.writableEnded) {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(makeSessionPayload(sessionB.id, "Beta Stale Turn 1 Content", "rev-b1")));
          }
        });
        return;
      }

      const text = bRequestCounter > 2 ? "Beta Refreshed Latest Content (Turn 2)" : "Beta Fast Fresh Payload";
      const rev = bRequestCounter > 2 ? "rev-b2" : "rev-b-init";
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(makeSessionPayload(sessionB.id, text, rev)));
    }
  }

  if (url.pathname === "/api/models") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ models: {}, modelList: [], skills: [], tools: [] }));
  }

  if (url.pathname === "/api/agent/running") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ runningSessionIds: [], sessionListVersion: 1 }));
  }

  if (url.pathname === "/api/home") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ home: "/fixture/workspace" }));
  }

  if (url.pathname === "/api/worktrees") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ projectRoot: "/fixture/workspace", worktrees: [] }));
  }

  if (url.pathname.startsWith("/api/agent/")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ running: false, state: { isStreaming: false, isPromptRunning: false } }));
  }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Session Freshness Anti-Stale QA-A</title>
  <script>window.process = { env: { NODE_ENV: "development", NEXT_PUBLIC_APP_VERSION: ${JSON.stringify(CURRENT_VERSION)}, NEXT_PUBLIC_PI_VERSION: ${JSON.stringify(CURRENT_VERSION)} }, platform: "linux" };</script>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__FRESHNESS_CONFIG__ = {
      sessions: [${JSON.stringify(sessionA)}, ${JSON.stringify(sessionB)}],
      initialSessionId: ${JSON.stringify(sessionA.id)},
    };
  </script>
  <script src="/bundle.js"></script>
</body>
</html>`);
});

let runner;
try {
  runner = await launchIsolatedSessionBrowser(serverInfo.origin);
  const { page, assertCleanErrors } = runner;

  await page.goto(serverInfo.origin);
  await page.waitForSelector('[data-qa-fixture="native-session-freshness"]');

  const fixtureDisclaimer = await page.getAttribute(
    '[data-qa-fixture="native-session-freshness"]',
    "data-qa-disclaimer"
  );
  assert.equal(fixtureDisclaimer, FIXTURE_DISCLAIMER);

  // 1. Initial mounted session is Session A
  assert.equal(
    await page.evaluate(() => window.__FRESHNESS_API__?.getSelectedSessionId()),
    sessionA.id
  );

  // Wait for the real useAgentSession hook to initiate HTTP request for Session A
  for (let i = 0; i < 60 && !delayedAlphaResolver; i++) {
    await page.waitForTimeout(50);
  }
  assert.ok(delayedAlphaResolver, "Real useAgentSession must initiate HTTP request for Session A");

  // Verify request was captured in real requestLog
  assert.ok(
    requestLog.some((r) => r.id === sessionA.id),
    "Server requestLog must record Session A loadSession request"
  );

  // 2. User switches to Session B while Session A is still inflight/held
  const tabB = page.locator(`[data-pi-enh-session-id="${sessionB.id}"]`);
  await tabB.click();

  // Wait for session selection to become Session B
  await page.waitForFunction(
    (idB) => window.__FRESHNESS_API__?.getSelectedSessionId() === idB,
    sessionB.id
  );

  // Wait for useAgentSession to load and render Session B's content
  const activeContent = page.locator('[data-testid="session-content"]');
  await page.waitForFunction(
    (idB) => document.querySelector('[data-testid="session-content"]')?.getAttribute("data-active-session-id") === idB,
    sessionB.id
  );

  const bubbleB = page.locator('.chat-message-bubble:has-text("Beta Fast Fresh Payload")');
  await bubbleB.waitFor({ state: "visible", timeout: 8000 });

  const initialBMessages = await page.evaluate(() => window.__FRESHNESS_API__?.getMessageTexts());
  assert.deepEqual(initialBMessages, ["Beta Fast Fresh Payload"]);

  // 3. Now release the delayed Session A response (late arrival from slower previous session)
  delayedAlphaResolver();

  // Wait extra time to let any potential stale propagation occur
  await page.waitForTimeout(300);

  // 4. Invariant Assertion: The late arriving Session A must NOT overwrite the active Session B!
  const currentSelectedId = await page.evaluate(() => window.__FRESHNESS_API__?.getSelectedSessionId());
  assert.equal(
    currentSelectedId,
    sessionB.id,
    "Selected session must remain Session B"
  );

  const currentActiveSid = await page.getAttribute('[data-testid="session-content"]', "data-active-session-id");
  assert.equal(
    currentActiveSid,
    sessionB.id,
    "DOM active session container must remain Session B"
  );

  const messagesAfterLateArrival = await page.evaluate(() => window.__FRESHNESS_API__?.getMessageTexts());
  assert.deepEqual(
    messagesAfterLateArrival,
    ["Beta Fast Fresh Payload"],
    "Delayed Session A response must NEVER overwrite active Session B messages (switch anti-stale invariant preserved)"
  );

  // 5. Scenario 2: Refresh anti-stale within Session B
  // Hold the first refresh request (B1), trigger second refresh (B2), B2 returns fast, release B1.
  holdNextB = true;
  await page.click('[data-testid="refresh-session-btn"]');

  // Wait until B1 is intercepted
  for (let i = 0; i < 60 && !delayedB1Resolver; i++) {
    await page.waitForTimeout(50);
  }
  assert.ok(delayedB1Resolver, "First refresh request B1 must be intercepted and held");

  // Trigger second refresh B2 (which will answer quickly with Turn 2 content)
  await page.click('[data-testid="refresh-session-btn"]');

  const bubbleTurn2 = page.locator('.chat-message-bubble:has-text("Beta Refreshed Latest Content (Turn 2)")');
  await bubbleTurn2.waitFor({ state: "visible", timeout: 5000 });

  // Now release delayed B1
  delayedB1Resolver();
  await page.waitForTimeout(300);

  // Invariant Assertion: Delayed B1 must NOT overwrite Turn 2 content
  const messagesAfterRefreshRace = await page.evaluate(() => window.__FRESHNESS_API__?.getMessageTexts());
  assert.deepEqual(
    messagesAfterRefreshRace,
    ["Beta Refreshed Latest Content (Turn 2)"],
    "Delayed earlier refresh B1 must NEVER overwrite newer refresh B2 (refresh anti-stale invariant preserved)"
  );

  assertCleanErrors();
  console.log(JSON.stringify({
    status: "passed",
    test: "session-freshness",
    version: CURRENT_VERSION,
    realHookOwnerVerified: true,
    delayedSessionAIntercepted: true,
    switchedToFastSessionB: true,
    switchStaleOverwritePrevented: true,
    refreshStaleOverwritePrevented: true,
    totalSessionRequestsLogged: requestLog.length,
  }));
} finally {
  if (runner) await runner.close();
  await serverInfo.close();
}
