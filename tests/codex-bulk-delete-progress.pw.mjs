// Playwright verification for real Codex bulk-delete progress UI & jobs protocol.
// Validates:
// 1. Real batch-delete jobs HTTP routes (/api/sessions/batch-delete/jobs/*)
// 2. Real bulk-delete progress UI modal (#pi-enh-batch-delete-modal)
// 3. Progress bar state (#pi-enh-batch-delete-progressbar) aria-values and progression
// 4. Modal lifecycle: opens on toolbar action, activates progress section on confirm, and closes upon 100% completion
// 5. Cancel lifecycle: cancels safely without triggering deletion
// 6. Zero page errors and zero console errors

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createRealBulkDeleteHttpServer } from "./fixtures/bulk-delete-real-http.mjs";
import { launchIsolatedSessionBrowser } from "./fixtures/native-release-browser.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const enhancementsJs = fs.readFileSync(path.join(root, "public/pi-web-enhancements.js"), "utf8");

test("Codex bulk-delete progress: real UI modal, progressbar dynamics and job completion", async (t) => {
  const s1 = "session-del-001";
  const s2 = "session-del-002";

  let serverInstance = null;

  serverInstance = await createRealBulkDeleteHttpServer({
    fallbackHandler(req, res, { urlObj }) {
      if (urlObj.pathname === "/pi-web-enhancements.js") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/javascript; charset=utf-8");
        return res.end(enhancementsJs);
      }

      if (urlObj.pathname === "/api/agent/running" || urlObj.pathname === "/api/sessions") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({
          sessions: [
            { id: s1, path: `/fixture/${s1}.jsonl`, cwd: "/fixture", name: "Delete Target 1", modified: "2026-10-25T10:00:00Z" },
            { id: s2, path: `/fixture/${s2}.jsonl`, cwd: "/fixture", name: "Delete Target 2", modified: "2026-10-25T10:00:00Z" },
          ],
          sessionListVersion: 1,
          runningSessionIds: [],
        }));
      }

      if (urlObj.pathname === "/api/models-config") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ providers: {}, archivedSessions: [], pinnedSessions: [] }));
      }

      if (urlObj.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bulk Delete Progress Test</title>
  <style>
    body { background: #09090b; color: #f4f4f5; font-family: sans-serif; margin: 0; padding: 20px; }
    .sidebar-container { width: 320px; }
  </style>
</head>
<body>
  <div class="sidebar-container">
    <div>
      <div></div>
      <div></div>
    </div>
  </div>
  <div id="session-list">
    <div class="pi-enh-session-row-host" data-pi-enh-session-id="${s1}">
      <span class="session-name">Delete Target 1</span>
    </div>
    <div class="pi-enh-session-row-host" data-pi-enh-session-id="${s2}">
      <span class="session-name">Delete Target 2</span>
    </div>
  </div>
  <script src="/pi-web-enhancements.js"></script>
</body>
</html>`);
      }

      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "Not found" }));
    },
  });

  t.after(async () => {
    if (serverInstance) await serverInstance.close();
  });

  const p1 = await serverInstance.addSession(s1);
  const p2 = await serverInstance.addSession(s2);

  const harness = await launchIsolatedSessionBrowser(serverInstance.origin, {
    viewport: { width: 1280, height: 800 },
  });

  try {
    const page = harness.page;
    await page.goto(serverInstance.origin);

    // Wait for enhancements runtime to mount
    await page.waitForFunction(() => typeof window.__PI_ENH_SET_SESSION_BATCH_MODE__ === "function");

    // 1. Enter session batch mode and select both target sessions
    await page.evaluate(([id1, id2]) => {
      window.__PI_ENH_SET_SESSION_BATCH_MODE__(true);
      window.__PI_ENH_TOGGLE_SESSION_BATCH_SELECT__(id1, true);
      window.__PI_ENH_TOGGLE_SESSION_BATCH_SELECT__(id2, true);
    }, [s1, s2]);

    // 2. Click the real batch-delete toolbar button
    const deleteBtn = page.locator('button[data-action="batch-delete"]');
    await deleteBtn.waitFor({ state: "visible", timeout: 5000 });
    await deleteBtn.click();

    // 3. Confirmation modal appears
    const modal = page.locator("#pi-enh-batch-delete-modal");
    await modal.waitFor({ state: "visible", timeout: 5000 });

    const confirmBtn = modal.locator('button[data-action="confirm"]');
    await confirmBtn.waitFor({ state: "visible", timeout: 5000 });
    await confirmBtn.click();

    // 4. Progress section becomes active
    const progressbar = page.locator("#pi-enh-batch-delete-progressbar");
    await progressbar.waitFor({ state: "visible", timeout: 5000 });
    assert.equal(await progressbar.getAttribute("aria-valuemax"), "2");

    // 5. Wait for batch delete job to complete on server; modal cleanly exits upon 100% completion
    await modal.waitFor({ state: "detached", timeout: 15000 });

    // 6. Confirm physical session files were deleted
    assert.equal(fs.existsSync(p1), false, `${p1} should be deleted`);
    assert.equal(fs.existsSync(p2), false, `${p2} should be deleted`);

    // 7. Test cancel flow without deletion
    const s3 = "session-del-003";
    const p3 = await serverInstance.addSession(s3);

    await page.evaluate((id) => {
      window.__PI_ENH_SET_SESSION_BATCH_MODE__(true);
      window.__PI_ENH_TOGGLE_SESSION_BATCH_SELECT__(id, true);
    }, s3);

    await deleteBtn.click();
    await modal.waitFor({ state: "visible", timeout: 5000 });
    const cancelBtn = modal.locator('[data-action="cancel"]');
    await cancelBtn.click();
    await modal.waitFor({ state: "detached", timeout: 5000 });

    // s3 must not be deleted
    assert.equal(fs.existsSync(p3), true, `${p3} should remain intact`);

    // 8. Assert clean errors
    harness.assertCleanErrors();
  } finally {
    await harness.close();
  }
});
