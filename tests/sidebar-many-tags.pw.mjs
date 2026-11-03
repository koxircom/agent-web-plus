// Verify dense multi-tag session rows render with variable heights and strictly zero geometric overlap in both desktop and mobile viewports.
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  createIsolatedFixtureServer,
  launchIsolatedSessionBrowser,
  assertVerticalGeometryNonOverlap,
  FIXTURE_DISCLAIMER,
} from "./fixtures/native-release-browser.mjs";

const require = createRequire(import.meta.url);
const esbuild = require("esbuild");
const root = fileURLToPath(new URL("..", import.meta.url));

// Create 6 contiguous session rows
const sessionCount = 6;
const baseTime = Date.parse("2026-10-17T12:00:00Z");
const sessions = Array.from({ length: sessionCount }, (_, i) => {
  const num = String(i + 1).padStart(4, "0");
  // Newer modified time appears higher in sidebar list
  const time = new Date(baseTime - i * 60000).toISOString();
  return {
    id: `01901234-row0-0000-0000-${num}00000000`,
    cwd: "/fixture/workspace",
    projectKey: "/fixture/workspace",
    projectRoot: "/fixture/workspace",
    name: `Contiguous Row ${i + 1}`,
    path: `session-${i + 1}.jsonl`,
    created: time,
    modified: time,
    messageCount: 2,
    firstMessage: `Row ${i + 1} content`,
    pinned: false,
  };
});

// Define tag definitions
const tagDefinitions = [
  { id: "tag-urgent", name: "紧急加急", color: "#ef4444" },
  { id: "tag-backend", name: "后端服务", color: "#3b82f6" },
  { id: "tag-review", name: "待复核", color: "#f59e0b" },
  { id: "tag-verified", name: "已验收", color: "#10b981" },
  { id: "tag-odoo", name: "Odoo插件", color: "#8b5cf6" },
  { id: "tag-docker", name: "Docker容器", color: "#06b6d4" },
  { id: "tag-database", name: "PostgreSQL", color: "#6366f1" },
  { id: "tag-network", name: "局域网路由", color: "#ec4899" },
];

// Configure tag distribution across rows: alternating between no-tag and dense multi-tags
const tagMappings = {
  [sessions[0].id]: [], // Row 0: zero tags (standard height)
  [sessions[1].id]: ["tag-urgent", "tag-backend", "tag-review", "tag-verified", "tag-odoo", "tag-docker"], // Row 1: dense tags (variable height)
  [sessions[2].id]: [], // Row 2: zero tags (standard height)
  [sessions[3].id]: ["tag-database", "tag-network", "tag-odoo", "tag-verified", "tag-backend"], // Row 3: dense tags (variable height)
  [sessions[4].id]: ["tag-urgent"], // Row 4: single tag
  [sessions[5].id]: ["tag-review", "tag-docker", "tag-network", "tag-database", "tag-odoo", "tag-urgent"], // Row 5: dense tags (variable height)
};

const bootstrap = {
  renderedAt: Date.now(),
  sessions,
  sessionListVersion: 1,
  runningSessionIds: [],
  completionNotificationSuppressedSessionIds: [],
  decorations: {
    ok: true,
    revision: 1,
    state: {
      sessionTagsDefinitions: tagDefinitions,
      sessionTagMappings: tagMappings,
    },
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

const serverInfo = await createIsolatedFixtureServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${serverInfo.port}`);

  if (url.pathname === "/bundle.js") {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    return res.end(bundle.outputFiles[0].text);
  }

  if (url.pathname === "/api/sessions") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      sessions,
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

  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Sidebar Many Tags QA-A</title>
  <script>window.process = { env: { NODE_ENV: "production" }, platform: "linux" };</script>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__NATIVE_SIDEBAR_CONFIG__ = {
      bootstrap: ${JSON.stringify(bootstrap)},
      executionEngine: "pi",
      codexEnabled: false,
      selectedSessionId: ${JSON.stringify(sessions[0].id)},
      selectedCwd: "/fixture/workspace",
    };
    // Direct hook for tag lookup
    window.__PI_ENH_GET_SESSION_TAGS__ = function(sessionId) {
      var mappings = ${JSON.stringify(tagMappings)};
      var defs = ${JSON.stringify(tagDefinitions)};
      var tagIds = mappings[sessionId] || [];
      return tagIds.map(function(id) {
        return defs.find(function(d) { return d.id === id; });
      }).filter(Boolean);
    };
  </script>
  <script src="/bundle.js"></script>
</body>
</html>`);
});

const viewports = [
  { name: "desktop", width: 1280, height: 800, isMobile: false },
  { name: "mobile", width: 390, height: 844, isMobile: true },
];

const results = [];

try {
  for (const vp of viewports) {
    const runner = await launchIsolatedSessionBrowser(serverInfo.origin, {
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.isMobile,
    });
    const { page, assertCleanErrors } = runner;

    try {
      await page.goto(serverInfo.origin);
      await page.waitForSelector('[data-qa-fixture="native-sidebar-release"]');

      const fixtureDisclaimer = await page.getAttribute('[data-qa-fixture="native-sidebar-release"]', "data-qa-disclaimer");
      assert.equal(fixtureDisclaimer, FIXTURE_DISCLAIMER);

      // Wait for all 6 contiguous session rows to be visible in DOM
      for (const s of sessions) {
        await page.waitForFunction((id) => {
          return document.querySelector(`[data-pi-enh-session-id="${id}"]`);
        }, s.id);
      }

      // Collect bounding boxes of all 6 contiguous rows in rendered DOM order
      const rowLocators = await page.locator('[data-pi-enh-session-id]').all();
      assert.ok(rowLocators.length >= sessionCount, `Expected at least ${sessionCount} rendered rows, got ${rowLocators.length}`);

      const boxes = [];
      for (let i = 0; i < sessionCount; i++) {
        const row = rowLocators[i];
        await row.waitFor({ state: "visible" });
        const box = await row.boundingBox();
        assert.ok(box, `Bounding box must exist for row ${i + 1}`);
        boxes.push(box);
      }

      // 1. Invariant: Variable heights verification
      // Dense tag rows (e.g. Row 1, Row 3, Row 5) must be taller than row 0 (no tag)
      const standardHeight = boxes[0].height;
      const denseHeightRow1 = boxes[1].height;
      const denseHeightRow3 = boxes[3].height;
      assert.ok(
        denseHeightRow1 > standardHeight,
        `Dense tag row 1 (${denseHeightRow1}px) must be taller than standard row 0 (${standardHeight}px)`
      );
      assert.ok(
        denseHeightRow3 > standardHeight,
        `Dense tag row 3 (${denseHeightRow3}px) must be taller than standard row 0 (${standardHeight}px)`
      );

      // 2. Invariant: Geometric non-overlap flow check for all 6 contiguous sibling rows
      assertVerticalGeometryNonOverlap(boxes, `${vp.name}-session-rows`);

      assertCleanErrors();
      results.push({
        viewport: vp.name,
        standardHeight,
        denseHeightRow1,
        denseHeightRow3,
        nonOverlapVerified: true,
      });
    } finally {
      await runner.close();
    }
  }

  console.log(JSON.stringify({
    status: "passed",
    test: "sidebar-many-tags",
    results,
  }));
} finally {
  await serverInfo.close();
}
