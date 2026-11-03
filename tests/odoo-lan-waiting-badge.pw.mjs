// Playwright E2E verification for Odoo lock waiting badges in SessionSidebar.
// Validates:
// 1. SessionSidebar renders .pi-native-waiting-badge for sessions present in collaborationWaitingSessions
// 2. Both 'waiting' and 'handoff' badge states with exact texts and titles
// 3. 4D Visual Topology: vertical bounding box non-overlap check across adjacent sibling rows
// 4. Desktop (1280x800) and mobile (390x844) viewport verification
// 5. Dynamic lifecycle: badge clears when collaborationWaitingSessions resolves
// 6. Zero page errors and zero console errors

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createIsolatedFixtureServer,
  launchIsolatedSessionBrowser,
  assertVerticalGeometryNonOverlap,
} from "./fixtures/native-release-browser.mjs";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const root = fileURLToPath(new URL("..", import.meta.url));

const session1 = {
  id: "codex:01900001-0000-7000-8000-000000000001",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Odoo Purchase Order Task",
  path: "codex:01900001-0000-7000-8000-000000000001",
  created: "2026-10-20T10:00:00Z",
  modified: "2026-10-20T10:00:00Z",
  messageCount: 5,
  firstMessage: "Purchase workflow refactor",
  pinned: false,
};

const session2 = {
  id: "codex:01900001-0000-7000-8000-000000000002",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "Odoo Sale Export Task",
  path: "codex:01900001-0000-7000-8000-000000000002",
  created: "2026-10-20T11:00:00Z",
  modified: "2026-10-20T11:00:00Z",
  messageCount: 3,
  firstMessage: "Sale export report",
  pinned: false,
};

const session3 = {
  id: "codex:01900001-0000-7000-8000-000000000003",
  cwd: "/fixture/workspace",
  projectKey: "/fixture/workspace",
  projectRoot: "/fixture/workspace",
  name: "General Inquiry Task",
  path: "codex:01900001-0000-7000-8000-000000000003",
  created: "2026-10-20T12:00:00Z",
  modified: "2026-10-20T12:00:00Z",
  messageCount: 2,
  firstMessage: "No lock session",
  pinned: false,
};

const allFixtureSessions = [session1, session2, session3];

const bundle = await esbuild.build({
  entryPoints: [path.join(root, "tests/fixtures/native-sidebar-release.tsx")],
  bundle: true,
  write: false,
  format: "iife",
  alias: { "@": root },
  define: { "process.env.NODE_ENV": '"production"' },
});

test("Odoo LAN waiting badge: renders waiting/handoff badges with strict geometry and clears on resolve", async (t) => {
  let activeWaitingSessions = {
    [session1.id]: {
      status: "waiting",
      ownerNode: "群晖30141",
      ownerTitle: "主控采购单优化",
      addon: "kx_purchase_order",
    },
    [session2.id]: {
      status: "handoff",
      ownerNode: "群晖30142",
      ownerTitle: "销售报表导出",
      addon: "kx_sale_report",
    },
  };

  const bootstrap = {
    renderedAt: Date.now(),
    sessions: allFixtureSessions,
    sessionListVersion: 1,
    runningSessionIds: [],
    completionNotificationSuppressedSessionIds: [],
    collaborationWaitingSessions: activeWaitingSessions,
  };

  const serverInfo = await createIsolatedFixtureServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${serverInfo.port}`);

    if (url.pathname === "/bundle.js") {
      res.setHeader("content-type", "text/javascript; charset=utf-8");
      return res.end(bundle.outputFiles[0].text);
    }

    if (url.pathname === "/api/agent/running") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          runningSessionIds: [],
          completionNotificationSuppressedSessionIds: [],
          sessionListVersion: 1,
          collaborationWaitingSessions: activeWaitingSessions,
        })
      );
    }

    if (url.pathname === "/api/sessions") {
      res.setHeader("content-type", "application/json");
      return res.end(
        JSON.stringify({
          sessions: allFixtureSessions,
          sessionListVersion: 1,
          runningSessionIds: [],
          collaborationWaitingSessions: activeWaitingSessions,
        })
      );
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
  <title>Odoo Waiting Badge QA-C</title>
  <script>window.process = { env: { NODE_ENV: "production" }, platform: "linux" };</script>
  <style>
    body { margin: 0; padding: 0; font-family: sans-serif; background: #09090b; color: #fafafa; }
    #root { width: 340px; height: 100vh; }
  </style>
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
  </script>
  <script src="/bundle.js"></script>
</body>
</html>`);
  });

  t.after(async () => {
    await serverInfo.close();
  });

  // Verify across both desktop and mobile viewports
  for (const viewport of [
    { width: 1280, height: 800, isMobile: false },
    { width: 390, height: 844, isMobile: true },
  ]) {
    const harness = await launchIsolatedSessionBrowser(serverInfo.origin, {
      viewport,
      isMobile: viewport.isMobile,
    });

    try {
      const page = harness.page;
      await page.goto(serverInfo.origin);

      const row1 = page.locator(`[data-pi-enh-session-id="${session1.id}"]`);
      const row2 = page.locator(`[data-pi-enh-session-id="${session2.id}"]`);
      const row3 = page.locator(`[data-pi-enh-session-id="${session3.id}"]`);

      await row1.waitFor();
      await row2.waitFor();
      await row3.waitFor();

      // 1. Verify waiting badge presence and attributes on session 1
      await assert.doesNotReject(async () => {
        await page.waitForFunction(
          (id) => {
            const el = document.querySelector(`[data-pi-enh-session-id="${id}"] .pi-native-waiting-badge`);
            return el !== null;
          },
          session1.id,
          { timeout: 5000 }
        );
      });

      const badge1 = row1.locator(".pi-native-waiting-badge");
      assert.equal(await badge1.getAttribute("data-pi-waiting-status"), "waiting");
      const badge1Text = (await badge1.innerText()).trim();
      assert.ok(
        badge1Text.includes("等待 群晖30141 · kx_purchase_order"),
        `Expected badge 1 text to contain '等待 群晖30141 · kx_purchase_order', got: '${badge1Text}'`
      );
      const badge1Title = await badge1.getAttribute("title");
      assert.ok(
        badge1Title.includes("群晖30141") && badge1Title.includes("持有 kx_purchase_order"),
        `Badge 1 title must reflect owner details, got: '${badge1Title}'`
      );

      // 2. Verify handoff badge presence and attributes on session 2
      const badge2 = row2.locator(".pi-native-waiting-badge");
      assert.equal(await badge2.getAttribute("data-pi-waiting-status"), "handoff");
      const badge2Text = (await badge2.innerText()).trim();
      assert.ok(
        badge2Text.includes("准备继续 · kx_sale_report"),
        `Expected badge 2 text to contain '准备继续 · kx_sale_report', got: '${badge2Text}'`
      );

      // 3. Verify normal session 3 has NO waiting badge
      assert.equal(await row3.locator(".pi-native-waiting-badge").count(), 0);

      // 4. Check 4D geometric topology: 3 adjacent rows in vertical visual order must strictly not overlap
      const box1 = await row1.boundingBox();
      const box2 = await row2.boundingBox();
      const box3 = await row3.boundingBox();
      assert.ok(box1 && box2 && box3, "All session row bounding boxes must be measurable");
      const verticalRows = [box1, box2, box3].sort((a, b) => a.y - b.y);
      assertVerticalGeometryNonOverlap(verticalRows, "SessionSidebar rows with waiting badges");

      // 5. Test clearing waiting status: update activeWaitingSessions to empty and re-poll
      activeWaitingSessions = {};
      await page.evaluate(() => {
        // Trigger manual session list / running poll update
        if (typeof window.__FIXTURE_API__?.rerenderSidebar === "function") {
          window.__FIXTURE_API__.rerenderSidebar();
        }
      });

      // Poll until badges clear
      await page.waitForFunction(
        () => document.querySelectorAll(".pi-native-waiting-badge").length === 0,
        { timeout: 5000 }
      );

      // Re-verify geometry after badges clear
      const postBox1 = await row1.boundingBox();
      const postBox2 = await row2.boundingBox();
      const postBox3 = await row3.boundingBox();
      assert.ok(postBox1 && postBox2 && postBox3);
      const postVerticalRows = [postBox1, postBox2, postBox3].sort((a, b) => a.y - b.y);
      assertVerticalGeometryNonOverlap(postVerticalRows, "SessionSidebar rows post-clear");

      // Reset for next viewport test
      activeWaitingSessions = {
        [session1.id]: {
          status: "waiting",
          ownerNode: "群晖30141",
          ownerTitle: "主控采购单优化",
          addon: "kx_purchase_order",
        },
        [session2.id]: {
          status: "handoff",
          ownerNode: "群晖30142",
          ownerTitle: "销售报表导出",
          addon: "kx_sale_report",
        },
      };

      harness.assertCleanErrors();
    } finally {
      await harness.close();
    }
  }
});
