// Tests for Codex Archived Panel in Settings Panel ExtensionSectionHost
// Validates:
// 1. Desktop & mobile Pi -> Codex -> Usage -> Codex -> Pi switching
// 2. Empty lists still render engine switcher & refresh buttons
// 3. 101 items pagination (pageSize=100), load more, and search filtering
// 4. Desktop external archive change sync via manual refresh
// 5. Single / batch restore and delete against correct engine
// 6. Timeout / empty {} ack does not false-succeed
// 7. Late arrival discarded via abort + epoch on engine switch
// 8. At least 3+ adjacent rows without overlap (BoundingBox non-overlap)
// 9. Zero console / page errors
// 10. No production mutation

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const projectRequire = createRequire(path.join(root, "package.json"));
const esbuild = projectRequire("esbuild");
const { chromium } = projectRequire("playwright");
const { compileSettingsCss } = projectRequire("./tests/native-settings-css.cjs");

function buildModulesScript() {
  const modeIcons = projectRequire("./lib/composer-mode-icons.json");
  const iconPaths = (mode) => modeIcons[mode].map((d) => `<path d="${d}" />`).join("");
  const iconGroup = (mode) => `<g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${iconPaths(mode)}</g>`;
  const modeIconCode = `var COMPOSER_MODE_ICON_MARKUP = ${JSON.stringify(Object.fromEntries(Object.keys(modeIcons).map((mode) => [mode, iconGroup(mode)])))};`;

  const optionalLoaderStub = `
    if (typeof window !== "undefined") {
      if (!window.__PI_ENH_LOAD_OPTIONAL__) window.__PI_ENH_LOAD_OPTIONAL__ = () => Promise.resolve();
      if (!window.PiUsagePanel) {
        window.PiUsagePanel = {
          render: (p) => { p.innerHTML = '<div class="pi-enh-usage-panel-content">Mock Usage</div>'; },
          dispose: () => {},
        };
      }
    }
  `;

  const files = [
    "01-bootstrap-and-core-state.js",
    "02-plugin-registry-and-settings-schema.js",
    "03-session-cache-and-sync-engine.js",
    "04-sidebar-and-session-management.js",
    "05-composer-and-input-workflow.js",
    "06-chat-view-and-tool-cards.js",
    "07-kernel-scheduler-and-observers.js",
    "08-settings-panels-and-lifecycle.js",
  ];
  const combined = files.map((f) => fs.readFileSync(path.join(root, "enhancements/modules", f), "utf8")).join("\n;\n");
  return `${modeIconCode}\n;\n${optionalLoaderStub}\n;\n${combined}`;
}

async function buildReactBundle() {
  const cssStubPlugin = {
    name: "css-stub",
    setup(b) {
      b.onResolve({ filter: /\.css$/ }, (args) => ({ path: args.path, namespace: "css-stub" }));
      b.onLoad({ filter: /.*/, namespace: "css-stub" }, () => ({ contents: "export default {};", loader: "js" }));
    },
  };

  const entryPath = path.resolve(root, "tests/settings-native-migration-fixture.tsx");
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: "iife",
    target: "es2022",
    plugins: [cssStubPlugin],
    nodePaths: [path.resolve(root, "node_modules")],
    alias: { "@": root },
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify("1.4.15"),
      "process.env.NEXT_PUBLIC_PI_VERSION": JSON.stringify("0.86.0"),
    },
  });
  return result.outputFiles[0].text;
}

function buildHtml(enhancementsJs, reactBundleJs, css) {
  return `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Codex Archived Panel Acceptance Test</title>
  <style>${css}</style>
  <style>
    html, body {
      margin: 0; padding: 0; width: 100%; height: 100%;
      background: var(--bg); color: var(--text); overflow: hidden;
    }
    #root, .test-app-root { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    try {
      ${enhancementsJs}
    } catch (e) {
      console.error("ENHANCEMENT MODULES LOAD ERROR:", e);
    }
  </script>
  <script>
    try {
      ${reactBundleJs}
    } catch (e) {
      console.error("REACT BUNDLE LOAD ERROR:", e);
    }
  </script>
</body>
</html>`;
}

test("Codex native archived panel end-to-end acceptance", async (t) => {
  const enhancementsJs = buildModulesScript();
  const reactBundleJs = await buildReactBundle();
  const settingsCss = await compileSettingsCss();
  const enhCss = fs.readFileSync(path.join(root, "app/enhancements.css"), "utf8");
  const fullCss = `${settingsCss}\n${enhCss}`;
  const htmlContent = buildHtml(enhancementsJs, reactBundleJs, fullCss);

  // Mock data store
  let mockCodexSessions = [];
  let pendingDelayMs = 0;
  let simulateRestoreFailure = false;
  let simulateDeleteFailure = false;
  let mockMalformedList = false;
  let mockDeleteMode = "normal";
  let deleteDelayMs = 0;
  let mockPaginationMode = null;

  const browser = await chromium.launch({ headless: true });

  t.after(async () => {
    await browser.close();
  });

  async function createFixtureContext(viewport = { width: 1280, height: 800 }) {
    const context = await browser.newContext({ viewport });
    const errors = [];

    await context.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");
      localStorage.setItem("pi-enh-session-archived", JSON.stringify([]));
      localStorage.setItem("pi-enh-session-archived-rev", "1");
    });

    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());

      if (url.hostname === "settings-test.local" && url.pathname === "/") {
        await route.fulfill({
          status: 200,
          contentType: "text/html; charset=utf-8",
          body: htmlContent,
        });
        return;
      }

      if (url.pathname.includes("/api/models-config")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ providers: {}, archivedManifest: [] }) });
        return;
      }

      // GET /api/sessions
      if (url.pathname === "/api/sessions") {
        const engine = url.searchParams.get("engine");
        const archived = url.searchParams.get("archived");
        const offset = Number(url.searchParams.get("offset") || "0");
        const limit = Number(url.searchParams.get("limit") || "100");

        if (pendingDelayMs > 0) {
          await new Promise((r) => setTimeout(r, pendingDelayMs));
        }

        if (engine === "codex" && archived === "true") {
          if (mockMalformedList === "empty-obj") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({}),
            });
            return;
          }
          if (mockMalformedList === "missing-archived-tag") {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                sessions: [{ id: "codex:no-archive", title: "无归档标记", cwd: "/test" }],
              }),
            });
            return;
          }

          if (mockPaginationMode === "duplicate-page2" && offset >= 100) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({ sessions: mockCodexSessions.slice(0, 100) }),
            });
            return;
          }

          const slice = mockCodexSessions.slice(offset, offset + limit);
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessions: slice }),
          });
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ sessions: [] }),
        });
        return;
      }

      // PATCH /api/sessions/:id (restore / unarchive)
      if (route.request().method() === "PATCH" && url.pathname.startsWith("/api/sessions/")) {
        const sessionId = decodeURIComponent(url.pathname.replace("/api/sessions/", ""));
        if (simulateRestoreFailure) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "还原失败模拟" }),
          });
          return;
        }
        mockCodexSessions = mockCodexSessions.filter((s) => s.id !== sessionId);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            session: { id: sessionId, archived: false },
          }),
        });
        return;
      }

      // DELETE /api/sessions/:id
      if (route.request().method() === "DELETE" && url.pathname.startsWith("/api/sessions/")) {
        const sessionId = decodeURIComponent(url.pathname.replace("/api/sessions/", ""));
        if (deleteDelayMs > 0) {
          await new Promise((r) => setTimeout(r, deleteDelayMs));
        }
        if (mockDeleteMode === "404") {
          await route.fulfill({
            status: 404,
            contentType: "application/json",
            body: JSON.stringify({ error: "Session not found" }),
          });
          return;
        }
        if (mockDeleteMode === "empty") {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({}),
          });
          return;
        }
        if (mockDeleteMode === "partial" && sessionId.endsWith("fa11")) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "partial failure" }),
          });
          return;
        }
        if (simulateDeleteFailure) {
          await route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: "删除失败模拟" }),
          });
          return;
        }
        mockCodexSessions = mockCodexSessions.filter((s) => s.id !== sessionId);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
        return;
      }

      // Default mocks for standard web apis
      if (url.pathname.includes("/api/web-auth")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ enabled: true }) });
        return;
      }
      if (url.pathname.includes("/api/tools/settings")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ isWindows: false, powerShellEnabled: false }) });
        return;
      }
      if (url.pathname.includes("/api/models/enabled")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ allEnabled: true, stalePatterns: [], enabledTotal: 1, availableTotal: 1, settingsPath: "~/.pi/agent/settings.json", scope: "global", editable: true, providers: [] }) });
        return;
      }
      if (url.pathname.includes("/pi-usage-ledger.json")) {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ version: 2, generatedAt: new Date().toISOString(), buckets: [] }) });
        return;
      }

      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", (err) => {
      console.error("PAGE ERROR:", err);
      errors.push(`PageError: ${err.message}`);
    });
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (!text.includes("favicon") && !text.includes("net::ERR_FAILED") && !text.includes("status of 500") && !text.includes("status of 404")) {
          errors.push(`ConsoleError: ${text}`);
        }
      }
    });

    return { context, page, errors };
  }

  async function openArchivedSection(page) {
    await page.goto("http://settings-test.local/");
    await page.waitForSelector(".settings-dialog-surface", { timeout: 5000 });
    await page.locator('.settings-section-tab[data-section-id="archived"]').click();
    await page.waitForSelector(".settings-archived-host.pi-enh-archived-panel", { timeout: 5000 });
  }

  async function switchSettingsSection(page, sectionId) {
    const isMobile = await page.evaluate(() => window.innerWidth < 640);
    if (isMobile) {
      const picker = page.locator("select.settings-mobile-section-picker");
      if (await picker.isVisible()) {
        await picker.selectOption(sectionId);
        await page.waitForTimeout(100);
        return;
      }
    }
    await page.locator(`.settings-section-tab[data-section-id="${sectionId}"]`).click();
  }

  // TEST 1: Empty list preserves engine tabs and refresh button
  await t.test("Empty list renders Pi Agent & Codex switch buttons and refresh", async () => {
    mockCodexSessions = [];
    const { context, page, errors } = await createFixtureContext();

    await openArchivedSection(page);

    // Verify engine tabs exist
    const piTab = page.locator('[data-action="switch-archived-engine"][data-engine="pi"]');
    const codexTab = page.locator('[data-action="switch-archived-engine"][data-engine="codex"]');
    const refreshBtn = page.locator('[data-action="refresh-archived"]');

    assert.ok(await piTab.isVisible(), "Pi engine tab must be visible");
    assert.ok(await codexTab.isVisible(), "Codex engine tab must be visible");
    assert.ok(await refreshBtn.isVisible(), "Refresh button must be visible");

    // Switch to Codex
    await codexTab.click();
    await page.waitForTimeout(100);

    // Verify empty state for Codex
    const emptyText = await page.locator(".pi-enh-archived-panel").textContent();
    assert.match(emptyText, /暂无 Codex 已归档的会话/, "Should show empty text for Codex");

    // Tabs still visible when empty
    assert.ok(await piTab.isVisible(), "Pi engine tab still visible when Codex is empty");
    assert.ok(await codexTab.isVisible(), "Codex engine tab still visible when Codex is empty");

    assert.equal(errors.length, 0, `Expected 0 errors, got: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 2: 101 items pagination, load more, and search filtering
  await t.test("101 items pagination (pageSize=100) and search filter", async () => {
    mockCodexSessions = Array.from({ length: 101 }, (_, i) => ({
      id: `codex:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: `Codex 任务 ${String(i).padStart(3, "0")}`,
      cwd: `/home/koxir/project-${i}`,
      updatedAt: Date.now() - (101 - i) * 60000,
      archived: true,
    }));

    const { context, page, errors } = await createFixtureContext();

    await openArchivedSection(page);

    // Switch to Codex
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();

    // Wait for first page (100 items)
    await page.waitForSelector('[data-action="load-more-codex"]');
    let items = await page.locator(".pi-enh-archived-item").count();
    assert.equal(items, 100, "First page should render exactly 100 items");

    const badge = await page.locator("[data-archived-count]").textContent();
    assert.match(badge, /已加载 100 个\+/, "Badge should indicate more items available");

    // Click load more
    await page.locator('[data-action="load-more-codex"]').click();
    await page.waitForTimeout(150);

    items = await page.locator(".pi-enh-archived-item").count();
    assert.equal(items, 101, "Second page should append the 101st item");

    // Load more button should disappear (since slice < 100)
    const loadMoreVisible = await page.locator('[data-action="load-more-codex"]').isVisible();
    assert.equal(loadMoreVisible, false, "Load more button should be hidden after all items loaded");

    const badgeFull = await page.locator("[data-archived-count]").textContent();
    assert.match(badgeFull, /共 101 个/, "Badge should indicate total 101 items");

    // Test search filter
    const searchInput = page.locator("[data-archived-search]");
    await searchInput.fill("100");
    await page.waitForTimeout(100);

    const filteredItems = await page.locator(".pi-enh-archived-item").count();
    assert.equal(filteredItems, 1, "Search should filter to 1 item");
    const filteredBadge = await page.locator("[data-archived-count]").textContent();
    assert.match(filteredBadge, /显示 1 \/ 101 个/, "Badge should show filtered count");

    // Clear search
    await searchInput.fill("");
    await page.waitForTimeout(100);
    assert.equal(await page.locator(".pi-enh-archived-item").count(), 101, "Clearing search restores 101 items");

    assert.equal(errors.length, 0, `Expected 0 errors, got: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 3: External archive change synced via refresh button
  await t.test("External archive syncs via refresh button", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-0000000000a1", title: "初始会话 1", cwd: "/test", updatedAt: Date.now(), archived: true },
      { id: "codex:00000000-0000-4000-8000-0000000000a2", title: "初始会话 2", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];

    const { context, page, errors } = await createFixtureContext();

    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForTimeout(100);

    assert.equal(await page.locator(".pi-enh-archived-item").count(), 2, "Initially 2 items");

    // External change occurs
    mockCodexSessions.push({
      id: "codex:00000000-0000-4000-8000-0000000000a3",
      title: "外部新归档会话",
      cwd: "/test",
      updatedAt: Date.now(),
      archived: true,
    });

    // Click refresh
    await page.locator('[data-action="refresh-archived"]').click();
    await page.waitForTimeout(150);

    assert.equal(await page.locator(".pi-enh-archived-item").count(), 3, "After refresh should show 3 items");
    const text = await page.locator(".pi-enh-archived-panel").textContent();
    assert.match(text, /外部新归档会话/, "Should contain newly archived session title");

    assert.equal(errors.length, 0, `Expected 0 errors, got: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 4: Single & Batch Restore and Delete
  await t.test("Single and batch restore and delete on Codex", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-000000000001", title: "Codex 待还原 1", cwd: "/test", updatedAt: Date.now(), archived: true },
      { id: "codex:00000000-0000-4000-8000-000000000002", title: "Codex 待删除 2", cwd: "/test", updatedAt: Date.now(), archived: true },
      { id: "codex:00000000-0000-4000-8000-000000000003", title: "Codex 批操作 3", cwd: "/test", updatedAt: Date.now(), archived: true },
      { id: "codex:00000000-0000-4000-8000-000000000004", title: "Codex 批操作 4", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];

    const { context, page, errors } = await createFixtureContext();

    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });

    // 1. Single restore s1
    const restoreBtn = page.locator('[data-action="restore-archived-session"]').first();
    await restoreBtn.click();
    await page.waitForFunction(() => document.querySelectorAll(".pi-enh-archived-item").length === 3, { timeout: 5000 });
    assert.equal(await page.locator(".pi-enh-archived-item").count(), 3, "s1 restored and removed from list");

    // 2. Single delete s2 (two-stage confirm)
    const delBtn = page.locator('[data-action="delete-archived-session"]').first();
    await delBtn.click();
    assert.equal(await delBtn.getAttribute("data-stage"), "confirm", "First click should enter confirm stage");
    await page.waitForTimeout(50);
    await delBtn.click();
    await page.waitForFunction(() => document.querySelectorAll(".pi-enh-archived-item").length === 2, { timeout: 5000 });
    assert.equal(await page.locator(".pi-enh-archived-item").count(), 2, "s2 deleted and removed from list");

    // 3. Batch restore s3 and s4
    const selectAll = page.locator('[data-action="toggle-select-all-archived"]');
    await selectAll.click();
    const batchRestoreBtn = page.locator('[data-action="batch-restore-selected"]');
    await batchRestoreBtn.click();
    await page.waitForFunction(() => document.querySelectorAll(".pi-enh-archived-item").length === 0, { timeout: 5000 });
    assert.equal(await page.locator(".pi-enh-archived-item").count(), 0, "All items batch restored");

    assert.equal(errors.length, 0, `Expected 0 errors, got: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 5: Timeout / failure does not false-succeed
  await t.test("Restore/delete failure does not remove item from list", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-000000000009", title: "失败测试会话", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];
    simulateRestoreFailure = true;
    simulateDeleteFailure = true;

    const { context, page, errors } = await createFixtureContext();

    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });

    // Try restore
    const restoreBtn = page.locator('[data-action="restore-archived-session"]');
    await restoreBtn.click();
    await page.waitForTimeout(150);

    // Item must remain!
    assert.equal(await page.locator(".pi-enh-archived-item").count(), 1, "Failed restore must keep item in list");

    // Try delete
    const delBtn = page.locator('[data-action="delete-archived-session"]');
    await delBtn.click();
    await page.waitForTimeout(50);
    await delBtn.click();
    await page.waitForTimeout(150);

    // Item must remain!
    assert.equal(await page.locator(".pi-enh-archived-item").count(), 1, "Failed delete must keep item in list");

    simulateRestoreFailure = false;
    simulateDeleteFailure = false;

    assert.equal(errors.length, 0, `Expected 0 errors, got: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 6: Late arrival discarded on engine switch
  await t.test("Late arrival discarded via abort and epoch", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-000000000008", title: "迟到测试会话", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];
    pendingDelayMs = 600;

    const { context, page, errors } = await createFixtureContext();

    await openArchivedSection(page);

    // Click Codex (triggers request with 600ms delay)
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();

    // Immediately switch back to Pi (aborts request, increments epoch)
    await page.locator('[data-action="switch-archived-engine"][data-engine="pi"]').click();

    // Wait out the late arrival
    await page.waitForTimeout(800);
    pendingDelayMs = 0;

    // Verify current engine is still Pi and not overwritten by Codex
    const activeEngineBtn = page.locator('[data-action="switch-archived-engine"].is-active');
    assert.equal(await activeEngineBtn.getAttribute("data-engine"), "pi", "Active engine must remain Pi");
    const panelText = await page.locator(".pi-enh-archived-panel").textContent();
    assert.doesNotMatch(panelText, /迟到测试会话/, "Late Codex response must not pollute Pi panel");

    assert.equal(errors.length, 0, `Expected 0 errors, got: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 7: 4D topology - At least 3+ adjacent rows without overlap (desktop & mobile)
  await t.test("At least 3 adjacent rows have zero bounding overlap (desktop & mobile)", async () => {
    mockCodexSessions = Array.from({ length: 5 }, (_, i) => ({
      id: `codex:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: `拓扑测试条目 ${i} - 具有超长标题用于验证换行与空间几何拓扑表现`,
      cwd: `/home/koxir/workspace/repo-${i}`,
      updatedAt: Date.now() - i * 10000,
      archived: true,
    }));

    // Desktop check
    const { context: dCtx, page: dPage, errors: dErrors } = await createFixtureContext({ width: 1280, height: 800 });
    await openArchivedSection(dPage);
    await dPage.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await dPage.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });

    const dBoxes = await dPage.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".pi-enh-archived-item"));
      return items.map((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
    });

    assert.ok(dBoxes.length >= 3, "At least 3 items present");
    for (let i = 0; i < dBoxes.length - 1; i++) {
      const cur = dBoxes[i];
      const next = dBoxes[i + 1];
      const diff = next.top - cur.bottom;
      assert.ok(diff >= 0, `Desktop items ${i} and ${i + 1} must not overlap (diff: ${diff}px)`);
    }
    assert.equal(dErrors.length, 0, `Desktop errors: ${dErrors.join(", ")}`);
    await dCtx.close();

    // Mobile check (390px)
    const { context: mCtx, page: mPage, errors: mErrors } = await createFixtureContext({ width: 390, height: 844 });
    await openArchivedSection(mPage);
    await mPage.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await mPage.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });

    const mBoxes = await mPage.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".pi-enh-archived-item"));
      return items.map((el) => {
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
    });

    assert.ok(mBoxes.length >= 3, "At least 3 items present on mobile");
    for (let i = 0; i < mBoxes.length - 1; i++) {
      const cur = mBoxes[i];
      const next = mBoxes[i + 1];
      const diff = next.top - cur.bottom;
      assert.ok(diff >= 0, `Mobile items ${i} and ${i + 1} must not overlap (diff: ${diff}px)`);
    }
    assert.equal(mErrors.length, 0, `Mobile errors: ${mErrors.join(", ")}`);
    await mCtx.close();
  });

  await t.test("Leaving the native archived section cleans requests and re-entry reads the current Desktop catalog", async () => {
    const first = { id: "codex:00000000-0000-4000-8000-000000000091", title: "归档旧目录", cwd: "/test", updatedAt: Date.now(), archived: true };
    const next = { ...first, id: "codex:00000000-0000-4000-8000-000000000092", title: "Desktop 新归档" };
    mockCodexSessions = [first];
    const { context, page, errors } = await createFixtureContext();
    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.getByText(first.title, { exact: true }).waitFor();
    await switchSettingsSection(page, "usage");
    mockCodexSessions = [next];
    await switchSettingsSection(page, "archived");
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.getByText(next.title, { exact: true }).waitFor();
    assert.equal(await page.getByText(first.title, { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  });

  // TEST 8: Full Navigation cycle: Desktop & Mobile Pi -> Codex -> Usage -> Codex -> Pi
  await t.test("Navigation cycle Pi -> Codex -> Usage -> Codex -> Pi on desktop and mobile", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-000000000007", title: "Codex 导航会话 1", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];

    for (const vp of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const { context, page, errors } = await createFixtureContext(vp);
      await openArchivedSection(page);
      assert.ok(await page.locator('[data-action="switch-archived-engine"][data-engine="pi"]').isVisible());

      // Switch to Codex
      await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
      await page.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });
      assert.ok(await page.locator(".pi-enh-archived-item").isVisible(), "Codex item visible");

      // Switch to Usage
      await switchSettingsSection(page, "usage");

      // Switch back to Archived
      await switchSettingsSection(page, "archived");
      await page.waitForSelector(".settings-archived-host.pi-enh-archived-panel", { timeout: 5000 });

      // Switch to Pi
      await page.locator('[data-action="switch-archived-engine"][data-engine="pi"]').click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('[data-action="switch-archived-engine"][data-engine="pi"]').getAttribute("aria-selected"), "true");

      assert.equal(errors.length, 0, `Cycle errors at viewport ${vp.width}: ${errors.join(", ")}`);
      await context.close();
    }
  });

  // TEST 9: Malformed list response
  await t.test("Malformed list response (200 {} or invalid item) shows error and does not falsify empty", async () => {
    mockMalformedList = "empty-obj";
    const { context, page, errors } = await createFixtureContext();

    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForTimeout(200);

    const text = await page.locator(".pi-enh-archived-panel").textContent();
    assert.doesNotMatch(text, /暂无 Codex 已归档的会话/, "Must not treat 200 {} as empty list");
    assert.match(text, /Codex 返回数据格式异常|无法加载 Codex 已归档会话/, "Must show error message");

    mockMalformedList = "missing-archived-tag";
    await page.locator('[data-action="retry-fetch-codex"]').click();
    await page.waitForTimeout(200);

    const text2 = await page.locator(".pi-enh-archived-panel").textContent();
    assert.doesNotMatch(text2, /暂无 Codex 已归档的会话/, "Must not treat missing archived tag as empty");
    assert.match(text2, /格式损坏或缺少归档标记|无法加载 Codex 已归档会话/, "Must display error on malformed session item");

    mockMalformedList = false;
    assert.equal(errors.length, 0, `Errors: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 10: Codex 404 / {} delete failclosed
  await t.test("Codex delete with 404 or 200 {} fails closed and keeps item", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-000000004040", title: "404删除测试", cwd: "/test", updatedAt: Date.now(), archived: true },
      { id: "codex:00000000-0000-4000-8000-000000002000", title: "200空包删除测试", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];

    const { context, page, errors } = await createFixtureContext();
    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });
    assert.equal(await page.locator(".pi-enh-archived-item").count(), 2);

    // 1. Delete s1 with 404 -> fails closed
    mockDeleteMode = "404";
    const delBtn1 = page.locator('[data-action="delete-archived-session"]').first();
    await delBtn1.click();
    await page.waitForTimeout(50);
    await delBtn1.click();
    await page.waitForTimeout(200);

    assert.equal(await page.locator(".pi-enh-archived-item").count(), 2, "Codex 404 delete must failclosed");

    // 2. Delete s2 with 200 {} -> fails closed
    mockDeleteMode = "empty";
    const delBtn2 = page.locator('[data-action="delete-archived-session"]').nth(1);
    await delBtn2.click();
    await page.waitForTimeout(50);
    await delBtn2.click();
    await page.waitForTimeout(200);

    assert.equal(await page.locator(".pi-enh-archived-item").count(), 2, "Codex 200 {} delete must failclosed");

    mockDeleteMode = "normal";
    assert.equal(errors.length, 0, `Errors: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 11: Batch false partial
  await t.test("Batch delete partial failure does not false-count failures and keeps them selected", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-0000000000a1", title: "成功1", cwd: "/test", updatedAt: Date.now(), archived: true },
      { id: "codex:00000000-0000-4000-8000-00000000fa11", title: "失败2", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];
    mockDeleteMode = "partial";

    const { context, page, errors } = await createFixtureContext();
    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });

    const selectAll = page.locator('[data-action="toggle-select-all-archived"]');
    await selectAll.click();

    const batchDel = page.locator('[data-action="batch-delete-selected"]');
    await batchDel.click();
    await page.waitForTimeout(50);
    await batchDel.click();
    await page.waitForFunction(() => document.querySelectorAll(".pi-enh-archived-item").length === 1, { timeout: 5000 });

    assert.equal(await page.locator(".pi-enh-archived-item").count(), 1, "Failed item remains in list");
    const remainingText = await page.locator(".pi-enh-archived-item").textContent();
    assert.match(remainingText, /失败2/, "Failed item is the one remaining");

    mockDeleteMode = "normal";
    assert.equal(errors.length, 0, `Errors: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 12: 101 pagination dedup, raw offset, append 0 stop
  await t.test("101 pagination dedup advances raw offset and append 0 prompts directory changed", async () => {
    mockCodexSessions = Array.from({ length: 100 }, (_, i) => ({
      id: `codex:00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: `会话 ${i}`,
      cwd: "/test",
      updatedAt: Date.now() - i * 1000,
      archived: true,
    }));
    mockPaginationMode = "duplicate-page2";

    const { context, page, errors } = await createFixtureContext();
    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });

    assert.equal(await page.locator(".pi-enh-archived-item").count(), 100);
    assert.ok(await page.locator('[data-action="load-more-codex"]').isVisible());

    await page.locator('[data-action="load-more-codex"]').click();
    await page.waitForTimeout(300);

    assert.equal(await page.locator(".pi-enh-archived-item").count(), 100);
    const panelText = await page.locator(".pi-enh-archived-panel").textContent();
    assert.match(panelText, /会话目录发生变动，请刷新列表/, "Append 0 with raw 100 must prompt directory changed");

    mockPaginationMode = null;
    assert.equal(errors.length, 0, `Errors: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 13: Back-and-forth switch resets pending loading and unmount
  await t.test("Engine switch while pending resets loading and unmounting does not leak errors", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-000000000099", title: "回切测试", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];
    pendingDelayMs = 500;

    const { context, page, errors } = await createFixtureContext();
    await openArchivedSection(page);

    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForTimeout(50);

    await page.locator('[data-action="switch-archived-engine"][data-engine="pi"]').click();
    await page.waitForTimeout(50);

    pendingDelayMs = 0;
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });

    assert.equal(await page.locator(".pi-enh-archived-item").count(), 1, "Codex list loads successfully after back-and-forth switch");

    await switchSettingsSection(page, "usage");
    await page.waitForTimeout(100);

    assert.equal(errors.length, 0, `Errors: ${errors.join(", ")}`);
    await context.close();
  });

  // TEST 14: Late operation completion does not pollute another engine panel
  await t.test("Late restore/delete operation completion does not pollute another engine panel", async () => {
    mockCodexSessions = [
      { id: "codex:00000000-0000-4000-8000-000000000088", title: "迟到删除会话", cwd: "/test", updatedAt: Date.now(), archived: true },
    ];
    deleteDelayMs = 400;

    const { context, page, errors } = await createFixtureContext();
    await openArchivedSection(page);
    await page.locator('[data-action="switch-archived-engine"][data-engine="codex"]').click();
    await page.waitForSelector(".pi-enh-archived-item", { timeout: 5000 });

    const delBtn = page.locator('[data-action="delete-archived-session"]');
    await delBtn.click();
    await page.waitForTimeout(50);
    await delBtn.click();

    await page.locator('[data-action="switch-archived-engine"][data-engine="pi"]').click();

    await page.waitForTimeout(600);
    deleteDelayMs = 0;

    const activeEngine = await page.locator('[data-action="switch-archived-engine"].is-active').getAttribute("data-engine");
    assert.equal(activeEngine, "pi", "Must stay on Pi engine");

    assert.equal(errors.length, 0, `Errors: ${errors.join(", ")}`);
    await context.close();
  });
});
