// Verify Pi/Codex engine status authority and strict visual separation without cross-engine leakage.
import assert from "node:assert/strict";
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

const piSession = {
  id: "01901234-pi00-0000-000000000001",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Pi Engine Worker Session",
  path: "01901234-pi00-0000-000000000001.jsonl",
  created: "2026-10-16T10:00:00Z",
  modified: "2026-10-16T10:00:00Z",
  messageCount: 3,
  firstMessage: "Pi session task",
  pinned: false,
};

const codexSession = {
  id: "codex:01901234-0000-7000-8000-000000000002",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Codex Engine Worker Session",
  path: "codex:01901234-0000-7000-8000-000000000002",
  created: "2026-10-16T11:00:00Z",
  modified: "2026-10-16T11:00:00Z",
  messageCount: 2,
  firstMessage: "Codex session task",
  pinned: false,
  nativeMetadata: { pinningSupported: true, desktopShared: true },
};

const bootstrap = {
  renderedAt: Date.now(),
  sessions: [piSession, codexSession],
  sessionListVersion: 1,
  runningSessionIds: [],
  completionNotificationSuppressedSessionIds: [],
  decorations: {
    ok: true,
    revision: 1,
    state: { sessionTagsDefinitions: [], sessionTagMappings: {} },
    storageVersion: 1,
  },
};

const bundle = await esbuild.build({
  entryPoints: [path.join(root, "tests/fixtures/native-sidebar-release.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
});

const engineRequests = [];
let piRunning = ["01901234-pi00-0000-000000000001"];
let codexRunning = ["codex:01901234-0000-7000-8000-000000000002"];

const serverInfo = await createIsolatedFixtureServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${serverInfo.port}`);

  if (url.pathname === "/bundle.js") {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    return res.end(bundle.outputFiles[0].text);
  }

  if (url.pathname === "/api/agent/running") {
    const engineParam = url.searchParams.get("engine") || "pi";
    engineRequests.push(engineParam);

    const running = engineParam === "codex" ? codexRunning : piRunning;
    const epoch = `epoch-${engineParam}`;
    const revision = engineRequests.length;

    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      runningSessionIds: running,
      completionNotificationSuppressedSessionIds: [],
      sessionListVersion: 1,
      statusSnapshot: {
        epoch,
        revision,
        executions: running.map((sessionId) => ({ sessionId, state: "running" })),
      },
    }));
  }

  if (url.pathname === "/api/sessions") {
    const engineParam = url.searchParams.get("engine") || "pi";
    const sessions = engineParam === "codex" ? [codexSession] : [piSession];
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      sessions,
      sessionListVersion: 1,
      runningSessionIds: engineParam === "codex" ? codexRunning : piRunning,
    }));
  }

  if (url.pathname === "/api/home") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ home: "/fixture/workspace" }));
  }

  if (url.pathname === "/api/worktrees") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ projectRoot: "/fixture/workspace", worktrees: [] }));
  }

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sidebar Engine Status QA-A</title>
  <script>window.process = { env: { NODE_ENV: "production" }, platform: "linux" };</script>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__NATIVE_SIDEBAR_CONFIG__ = {
      bootstrap: ${JSON.stringify(bootstrap)},
      executionEngine: "pi",
      codexEnabled: true,
      selectedSessionId: ${JSON.stringify(piSession.id)},
      selectedCwd: "/fixture/workspace",
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
  await page.waitForSelector('[data-qa-fixture="native-sidebar-release"]');

  const fixtureDisclaimer = await page.getAttribute('[data-qa-fixture="native-sidebar-release"]', "data-qa-disclaimer");
  assert.equal(fixtureDisclaimer, FIXTURE_DISCLAIMER);

  // 1. Initial State: Execution engine is "pi"
  await page.waitForFunction(() => window.__FIXTURE_API__?.getExecutionEngine() === "pi");

  // Wait for pi status poll to trigger
  await page.waitForFunction((id) => {
    return document.querySelector(`[data-pi-enh-session-id="${id}"]`);
  }, piSession.id);

  const piRow = page.locator(`[data-pi-enh-session-id="${piSession.id}"]`);
  await piRow.waitFor({ state: "visible" });
  assert.equal(await piRow.getAttribute("data-execution-engine"), "pi");

  // Verify that the initial status request asked for engine=pi
  assert.ok(engineRequests.includes("pi"), "Status poll must query engine=pi");

  // 2. Switch to Codex engine via fixture API
  await page.evaluate(() => {
    window.__FIXTURE_API__.setExecutionEngine("codex");
  });

  // Wait for sidebar to reflect codex engine
  await page.waitForFunction(() => window.__FIXTURE_API__?.getExecutionEngine() === "codex");
  await page.waitForFunction((id) => {
    return document.querySelector(`[data-pi-enh-session-id="${id}"]`);
  }, codexSession.id);

  const codexRow = page.locator(`[data-pi-enh-session-id="${codexSession.id}"]`);
  await codexRow.waitFor({ state: "visible" });
  assert.equal(await codexRow.getAttribute("data-execution-engine"), "codex");

  // Verify that engine=codex was polled
  assert.ok(engineRequests.includes("codex"), "Status poll must query engine=codex after switch");

  // 3. Authority test: Verify that broadcast for a retired epoch or stale revision cannot hijack status
  const rejectionResult = await page.evaluate(async () => {
    const channel = new BroadcastChannel("pi-web-native-status-v1:codex");
    // Send stale revision
    channel.postMessage({
      payload: {
        runningSessionIds: ["stale-hijacked-session"],
        statusSnapshot: {
          epoch: "epoch-codex",
          revision: 0, // Old revision
          executions: [{ sessionId: "stale-hijacked-session", state: "running" }],
        },
      },
      at: Date.now(),
    });
    // Wait briefly for event loop
    await new Promise((r) => setTimeout(r, 100));
    // Verify that hijacked session was NOT added to DOM
    const hijackedEl = document.querySelector('[data-pi-enh-session-id="stale-hijacked-session"]');
    channel.close();
    return { hijackedPresent: Boolean(hijackedEl) };
  });

  assert.equal(rejectionResult.hijackedPresent, false, "Stale revision broadcast must be rejected by authoritative accept");

  // 4. Verify cross-channel separation: posting to pi channel does not affect codex pane
  const crossChannelResult = await page.evaluate(async () => {
    const piChannel = new BroadcastChannel("pi-web-native-status-v1:pi");
    piChannel.postMessage({
      payload: {
        runningSessionIds: ["cross-engine-leakage-id"],
        statusSnapshot: {
          epoch: "epoch-pi",
          revision: 9999,
          executions: [{ sessionId: "cross-engine-leakage-id", state: "running" }],
        },
      },
      at: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 100));
    const leakedEl = document.querySelector('[data-pi-enh-session-id="cross-engine-leakage-id"]');
    piChannel.close();
    return { leakedPresent: Boolean(leakedEl) };
  });

  assert.equal(crossChannelResult.leakedPresent, false, "Pi channel broadcast must not cross into Codex engine view");

  assertCleanErrors();
  console.log(JSON.stringify({
    status: "passed",
    test: "sidebar-engine-status",
    engineRequestsCount: engineRequests.length,
    piSeparationConfirmed: true,
    codexSeparationConfirmed: true,
    authorityFencingPassed: true,
  }));
} finally {
  if (runner) await runner.close();
  await serverInfo.close();
}
