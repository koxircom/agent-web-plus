// Test Codex pin source-owner: correct PATCH request generation and non-mutation on failure.
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

const session1 = {
  id: "codex:01901234-0000-7000-8000-000000000001",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Codex Pinned Row",
  path: "codex:01901234-0000-7000-8000-000000000001",
  created: "2026-10-15T10:00:00Z",
  modified: "2026-10-15T10:00:00Z",
  messageCount: 2,
  firstMessage: "Codex Pinned Row",
  pinned: true,
  nativeMetadata: { pinningSupported: true, desktopShared: true },
};

const session2 = {
  id: "codex:01901234-0000-7000-8000-000000000002",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Codex Unpinned Row",
  path: "codex:01901234-0000-7000-8000-000000000002",
  created: "2026-10-15T11:00:00Z",
  modified: "2026-10-15T11:00:00Z",
  messageCount: 1,
  firstMessage: "Codex Unpinned Row",
  pinned: false,
  nativeMetadata: { pinningSupported: true, desktopShared: true },
};

const piSession = {
  id: "01901234-pi00-0000-000000000003",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Pi Session Non-Owner",
  path: "01901234-pi00-0000-000000000003.jsonl",
  created: "2026-10-15T12:00:00Z",
  modified: "2026-10-15T12:00:00Z",
  messageCount: 1,
  firstMessage: "Pi Session Non-Owner",
  pinned: false,
};

const bootstrap = {
  renderedAt: Date.now(),
  sessions: [session1, session2, piSession],
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

const patchRequests = [];
let failNextPatch = false;

const serverInfo = await createIsolatedFixtureServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${serverInfo.port}`);

  if (url.pathname === "/bundle.js") {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    return res.end(bundle.outputFiles[0].text);
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/sessions/")) {
    let bodyText = "";
    req.on("data", (chunk) => { bodyText += chunk; });
    req.on("end", () => {
      const parsedBody = bodyText ? JSON.parse(bodyText) : {};
      const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      patchRequests.push({
        method: "PATCH",
        url: url.pathname,
        sessionId,
        body: parsedBody,
        headers: req.headers,
      });

      if (failNextPatch) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ ok: false, error: "Storage lock contention on backend" }));
      }

      const targetPinned = parsedBody.action === "pin";
      if (sessionId === session1.id) session1.pinned = targetPinned;
      if (sessionId === session2.id) session2.pinned = targetPinned;
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        session: { id: sessionId, pinned: targetPinned },
      }));
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      sessions: [session1, session2, piSession],
      sessionListVersion: 1,
      runningSessionIds: [],
    }));
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

  // HTML shell
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Codex Pin Owner QA-A</title>
  <script>window.process = { env: { NODE_ENV: "production" }, platform: "linux" };</script>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__NATIVE_SIDEBAR_CONFIG__ = {
      bootstrap: ${JSON.stringify(bootstrap)},
      executionEngine: "codex",
      codexEnabled: true,
      selectedSessionId: ${JSON.stringify(session1.id)},
      selectedCwd: "/fixture/workspace",
    };
    // Activate pin enhancement plugin check
    window.__PI_ENH_IS_PLUGIN_ENABLED__ = function(id) {
      return id === "session-pin-archive";
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

  // Verify fixture disclaimer metadata
  const fixtureDisclaimer = await page.getAttribute('[data-qa-fixture="native-sidebar-release"]', "data-qa-disclaimer");
  assert.equal(fixtureDisclaimer, FIXTURE_DISCLAIMER, "Component fixture disclaimer must be present");

  // Wait for sidebar sessions to render
  const s1Locator = page.locator(`[data-pi-enh-session-id="${session1.id}"]`);
  const s2Locator = page.locator(`[data-pi-enh-session-id="${session2.id}"]`);
  await s1Locator.waitFor({ state: "visible" });
  await s2Locator.waitFor({ state: "visible" });

  // 1. Session 1 is initially pinned: verify indicator is present
  const pinIndicator1 = s1Locator.locator('[data-pi-native-session-pin="true"]');
  await pinIndicator1.waitFor({ state: "visible" });

  // 2. Perform unpin on Session 1 via toggle handler
  failNextPatch = false;
  await pinIndicator1.click();

  // Wait for PATCH request to complete
  await page.waitForFunction((id) => !document.querySelector(`[data-pi-enh-session-id="${id}"] [data-pi-native-session-pin="true"]`), session1.id);

  assert.equal(patchRequests.length, 1);
  assert.equal(patchRequests[0].sessionId, session1.id);
  assert.equal(patchRequests[0].body.action, "unpin");
  assert.equal(patchRequests[0].headers["content-type"], "application/json");

  // 3. Perform pin on Session 2 but simulate backend failure
  failNextPatch = true;
  const pinResult = await page.evaluate(async (s2Id) => {
    try {
      if (window.__PI_ENH_TOGGLE_NATIVE_SESSION_PIN__) {
        return await window.__PI_ENH_TOGGLE_NATIVE_SESSION_PIN__(s2Id);
      }
      return null;
    } catch (e) {
      return { caughtError: e.message };
    }
  }, session2.id);

  assert.ok(pinResult?.caughtError, "Pin operation must reject when backend returns 500");
  assert.match(pinResult.caughtError, /Storage lock contention/);

  // Assertion: Failure must NOT falsely mutate state (失败不误成功)
  const pinIndicator2 = s2Locator.locator('[data-pi-native-session-pin="true"]');
  assert.equal(await pinIndicator2.count(), 0, "Session 2 must NOT show pinned indicator on failure");

  // Assertion: Error banner should be rendered
  const errorBanner = page.locator('[data-pi-native-pin-error="true"]');
  await errorBanner.waitFor({ state: "visible" });
  assert.match(await errorBanner.textContent(), /Storage lock contention/);

  // Close error banner
  await errorBanner.locator("button").click();
  await errorBanner.waitFor({ state: "hidden" });

  // 4. Source owner isolation test: attempting to pin a session belonging to another owner/non-existent
  const foreignResult = await page.evaluate(async () => {
    try {
      await window.__PI_ENH_TOGGLE_NATIVE_SESSION_PIN__("non-existent-session-id");
      return { success: true };
    } catch (e) {
      return { error: e.message };
    }
  });
  assert.match(foreignResult.error, /会话不存在|No sidebar pane registered/);

  assertCleanErrors();
  console.log(JSON.stringify({
    status: "passed",
    test: "codex-pin-source-owner",
    patchRequests: patchRequests.length,
    failurePreventedFalsyPin: true,
    sourceOwnerVerified: true,
  }));
} finally {
  if (runner) await runner.close();
  await serverInfo.close();
}
