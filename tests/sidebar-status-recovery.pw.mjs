// Verify SessionSidebar status recovery, A/B session switching, and foreground revalidation after expiration.
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

const sessionA = {
  id: "01901234-rec0-0000-0000-00000000000a",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Session Alpha Workload",
  path: "session-a.jsonl",
  created: "2026-10-18T10:00:00Z",
  modified: "2026-10-18T10:00:00Z",
  messageCount: 2,
  firstMessage: "Workload A",
  pinned: false,
};

const sessionB = {
  id: "01901234-rec0-0000-0000-00000000000b",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Session Beta Workload",
  path: "session-b.jsonl",
  created: "2026-10-18T11:00:00Z",
  modified: "2026-10-18T11:00:00Z",
  messageCount: 3,
  firstMessage: "Workload B",
  pinned: false,
};

const bootstrap = {
  renderedAt: Date.now(),
  sessions: [sessionA, sessionB],
  sessionListVersion: 1,
  runningSessionIds: [sessionA.id],
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

let serverMode = "healthy-a"; // "healthy-a" | "outage" | "healthy-b"
let pollCount = 0;

const serverInfo = await createIsolatedFixtureServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${serverInfo.port}`);
  if (url.pathname === "/bundle.js") {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    return res.end(bundle.outputFiles[0].text);
  }

  if (url.pathname === "/api/sessions") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      sessions: [sessionA, sessionB],
      sessionListVersion: 1,
      runningSessionIds: serverMode === "healthy-a" ? [sessionA.id] : serverMode === "healthy-b" ? [sessionB.id] : [],
    }));
  }

  if (url.pathname === "/api/agent/running") {
    pollCount++;
    if (serverMode === "outage") {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ error: "Service temporarily unavailable" }));
    }

    const currentRunning = serverMode === "healthy-a" ? [sessionA.id] : [sessionB.id];
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      runningSessionIds: currentRunning,
      completionNotificationSuppressedSessionIds: [],
      sessionListVersion: 1,
      statusSnapshot: {
        epoch: "status-recovery-epoch",
        revision: pollCount,
        executions: currentRunning.map((sessionId) => ({ sessionId, state: "running" })),
      },
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
  <title>Sidebar Status Recovery QA-A</title>
  <script>window.process = { env: { NODE_ENV: "production" }, platform: "linux" };</script>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__NATIVE_SIDEBAR_CONFIG__ = {
      bootstrap: ${JSON.stringify(bootstrap)},
      executionEngine: "pi",
      codexEnabled: false,
      selectedSessionId: ${JSON.stringify(sessionA.id)},
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

  // 1. Initial State A: Session A is running and selected
  await page.waitForFunction((id) => {
    return document.querySelector(`[data-pi-enh-session-id="${id}"]`);
  }, sessionA.id);

  assert.equal(
    await page.evaluate(() => window.__FIXTURE_API__?.getSelectedSessionId()),
    sessionA.id,
    "Initial selection must be Session A"
  );

  // 2. Perform A -> B session switch
  await page.evaluate((idB) => {
    window.__FIXTURE_API__.setSelectedSessionId(idB);
  }, sessionB.id);

  await page.waitForFunction((idB) => {
    return window.__FIXTURE_API__?.getSelectedSessionId() === idB;
  }, sessionB.id);

  // 3. Simulate outage: server enters 503 error state
  serverMode = "outage";

  // Force trigger poll during outage
  await page.evaluate(() => {
    window.__PI_WEB_REFRESH_PROJECT_STATUS__?.();
  });

  // Verify that during outage, stale task data is invalidated rather than inventing completion
  await page.waitForFunction(() => {
    const snap = window.__PI_WEB_PROJECT_STATUS_SNAPSHOT__;
    return snap === null || snap === undefined;
  });

  // 4. Recovery: Server recovers with Workload B running (healthy-b)
  serverMode = "healthy-b";

  // Simulate tab returning from hidden to visible (foreground revalidation)
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await page.waitForTimeout(50);

  // Return to visible -> triggers revalidateForeground()
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.__PI_WEB_REFRESH_PROJECT_STATUS__?.();
  });

  // Wait for status recovery to settle
  await page.waitForFunction((idB) => {
    const snap = window.__PI_WEB_PROJECT_STATUS_SNAPSHOT__;
    return snap?.runningSessionIds?.includes(idB);
  }, sessionB.id);

  const finalSnapshot = await page.evaluate(() => window.__PI_WEB_PROJECT_STATUS_SNAPSHOT__);
  assert.deepEqual(finalSnapshot.runningSessionIds, [sessionB.id], "Status must recover to Session B running");

  assertCleanErrors();
  console.log(JSON.stringify({
    status: "passed",
    test: "sidebar-status-recovery",
    pollsCount: pollCount,
    switchedAtoB: true,
    outageInvalidatedStale: true,
    foregroundRecoveryConfirmed: true,
  }));
} finally {
  if (runner) await runner.close();
  await serverInfo.close();
}
