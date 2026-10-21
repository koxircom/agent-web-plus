// Playwright end-to-end browser verification for native turn number indicators (#N)
// Loads real ChatWindow and useAgentSession in a real browser environment.
// Verifies:
// 1. Codex session without timestamp displays turn numbers natively (#1..#4), no fake timestamp
// 2. Pi session with timestamp displays turn numbers to the left of the timestamp
// 3. Identical user prompt texts with distinct entryIds are each counted once (#3, #4)
// 4. Long history tail offset (known total 100, loaded 3 tail messages -> #98, #99, #100)
// 5. Native history pagination (click real loader button -> prepends earlier messages #96, #97, preserving #98..#100)
// 6. Dynamic appending of new turn (#101) advances total without mutating previous turn numbers
// 7. Session switch A -> B -> A with clean isolation and no state leakage
// 8. Plugin toggle (turn-number-indicator) live response (on -> off -> on)
// 9. Module toggle (task-insights) live response (on -> off -> on)
// 10. Desktop (1280x800) and mobile (390x844) geometric non-overlap & zero overflow
// 11. Zero console errors / page errors, 0 duplicate badges
// 12. Persisted JSON receipt and visual screenshot evidence

import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const sourceRoot = path.resolve(process.env.SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const sourceRequire = createRequire(path.join(sourceRoot, "package.json"));
const { build } = sourceRequire("esbuild");
const { chromium } = sourceRequire(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");

const outputDir = process.env.TURN_NUMBER_OUTPUT || path.resolve(sourceRoot, "../acceptance");
fs.mkdirSync(outputDir, { recursive: true });

const baseline = process.env.BASELINE === "1" || process.argv.includes("--baseline");

// 1. Compile Global CSS and load Enhancements CSS
async function compileGlobalCss() {
  const helperPath = path.join(sourceRoot, "tests/native-settings-css.cjs");
  if (fs.existsSync(helperPath)) {
    return sourceRequire("./tests/native-settings-css.cjs").compileSettingsCss();
  }
  const postcss = sourceRequire("postcss");
  const tailwind = sourceRequire("@tailwindcss/postcss");
  const styles = ["app/globals.css", "app/settings.css"]
    .map((relativePath) => path.join(sourceRoot, relativePath))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => fs.readFileSync(filePath, "utf8"));
  const from = path.join(sourceRoot, "app/globals.css");
  const result = await postcss([tailwind({ base: sourceRoot, optimize: false })])
    .process(styles.join("\n"), { from });
  return result.css;
}

const enhancementsCss = fs.readFileSync(path.join(sourceRoot, "app/enhancements.css"), "utf8");

// Load candidate enhancement modules to provide full window.__PI_ENH_* APIs
function getEnhancementModulesScript() {
  const prefix = `var COMPOSER_MODE_ICON_MARKUP = {"goal":"<g fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"1.7\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><path d=\\"M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0\\" /><path d=\\"M12 7a5 5 0 1 0 5 5\\" /><path d=\\"M13 3.055a9 9 0 1 0 7.941 7.945\\" /><path d=\\"M15 6v3h3l3 -3h-3v-3l-3 3\\" /><path d=\\"M15 9l-3 3\\" /></g>","plan":"<g fill=\\"none\\" stroke=\\"currentColor\\" stroke-width=\\"1.7\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><path d=\\"M3 12h1m8 -9v1m8 8h1m-15.4 -6.4l.7 .7m12.1 -.7l-.7 .7\\" /><path d=\\"M9 16a5 5 0 1 1 6 0a3.5 3.5 0 0 0 -1 3a2 2 0 0 1 -4 0a3.5 3.5 0 0 0 -1 -3\\" /><path d=\\"M9.7 17l4.6 0\\" /></g>"};\n`;
  const modulesDir = path.join(sourceRoot, "enhancements/modules");
  const moduleFiles = [
    "01-bootstrap-and-core-state.js",
    "02-plugin-registry-and-settings-schema.js",
    "03-session-cache-and-sync-engine.js",
    "04-sidebar-and-session-management.js",
    "05-composer-and-input-workflow.js",
    "06-chat-view-and-tool-cards.js",
    "07-kernel-scheduler-and-observers.js",
    "08-settings-panels-and-lifecycle.js",
  ];
  const body = moduleFiles
    .filter((file) => fs.existsSync(path.join(modulesDir, file)))
    .map((file) => fs.readFileSync(path.join(modulesDir, file), "utf8"))
    .join("\n;\n");
  return prefix + body;
}

const enhancementsScript = getEnhancementModulesScript();

// 2. Bundle Real ChatWindow via esbuild
const bundle = await build({
  stdin: {
    resolveDir: sourceRoot,
    loader: "tsx",
    contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { ChatWindow } from "./components/ChatWindow";
      import { I18nProvider } from "./hooks/useI18n";

      const sessionConfigs = window.__TURN_FIXTURE_SESSIONS__ || {};

      function TurnNumberFixture() {
        const [currentId, setCurrentId] = useState("codex:turn-test");
        const session = sessionConfigs[currentId] || null;

        return (
          <I18nProvider initialLocale="zh-CN">
            <div
              id="fixture-controls"
              style={{
                position: "relative",
                height: 40,
                boxSizing: "border-box",
                top: 0,
                right: 0,
                zIndex: 99999,
                background: "rgba(24, 24, 27, 0.9)",
                border: "1px solid rgba(255, 255, 255, 0.15)",
                borderRadius: "0 0 0 8px",
                padding: "6px 10px",
                display: "flex",
                gap: "8px",
                alignItems: "center",
              }}
            >
              <button
                id="fixture-switch-a"
                onClick={() => setCurrentId("codex:turn-test")}
                style={{ padding: "3px 8px", fontSize: "12px", cursor: "pointer" }}
              >
                Session A (Codex)
              </button>
              <button
                id="fixture-switch-b"
                onClick={() => setCurrentId("pi:turn-long")}
                style={{ padding: "3px 8px", fontSize: "12px", cursor: "pointer" }}
              >
                Session B (Pi Long)
              </button>
              <span id="fixture-active-id" style={{ color: "#a1a1aa", fontSize: "12px" }}>
                {currentId}
              </span>
            </div>
            <div id="fixture-chat-container" style={{ height: "calc(100vh - 40px)", display: "flex", flexDirection: "column" }}>
              <ChatWindow
                key={currentId}
                session={session}
                newSessionCwd={null}
                newSessionDraftKey={null}
              />
            </div>
          </I18nProvider>
        );
      }

      createRoot(document.getElementById("root")).render(<TurnNumberFixture />);
    `,
  },
  bundle: true,
  write: false,
  outfile: "fixture.js",
  format: "iife",
  alias: { "@": sourceRoot },
  loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl" },
  define: { "process.env.NODE_ENV": '"development"' },
});

const compiledCss = (await compileGlobalCss())
  + '\n' + ['app/composer.css','components/ComposerQueue.css','app/ask-user.css'].map(name=>fs.readFileSync(path.join(sourceRoot,name),'utf8')).join('\n')
  + "\n"
  + enhancementsCss
  + "\n"
  + bundle.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text).join("\n");

const jsBundleText = bundle.outputFiles.find((file) => file.path.endsWith(".js"))?.text || "";

// 3. Isolated Mock Data for Sessions
const sessionConfigs = {
  "codex:turn-test": {
    id: "codex:turn-test",
    name: "Codex Turn Test",
    path: "/isolated/codex-turn.jsonl",
    cwd: "/isolated",
    created: "2026-10-21T00:00:00Z",
    modified: "2026-10-21T00:00:00Z",
    messageCount: 8,
    firstMessage: "首个Codex用户消息",
  },
  "pi:turn-long": {
    id: "pi:turn-long",
    name: "Pi Long Session",
    path: "/isolated/pi-long.jsonl",
    cwd: "/isolated",
    created: "2026-10-21T00:00:00Z",
    modified: "2026-10-21T00:00:00Z",
    messageCount: 200,
    firstMessage: "长历史更早第1轮提问",
  },
};

// Session A: Codex session, no timestamps, identical prompt text with distinct entryIds (u3, u4)
const codexContext = {
  messages: [
    { role: "user", content: [{ type: "text", text: "首个Codex用户消息" }], entryId: "u1" },
    { role: "assistant", content: [{ type: "text", text: "助手回答 1" }], entryId: "a1", timestamp: 1001 },
    { role: "user", content: [{ type: "text", text: "第二个Codex用户消息" }], entryId: "u2" },
    { role: "assistant", content: [{ type: "text", text: "助手回答 2" }], entryId: "a2", timestamp: 2001 },
    { role: "user", content: [{ type: "text", text: "第三个用户消息同文" }], entryId: "u3" },
    { role: "assistant", content: [{ type: "text", text: "助手回答 3" }], entryId: "a3", timestamp: 3001 },
    { role: "user", content: [{ type: "text", text: "第三个用户消息同文" }], entryId: "u4" },
    { role: "assistant", content: [{ type: "text", text: "助手回答 4" }], entryId: "a4", timestamp: 4001 },
  ],
  entryIds: ["u1", "a1", "u2", "a2", "u3", "a3", "u4", "a4"],
  oldestEntryId: "u1",
  hasMore: false,
  thinkingLevel: "off",
  model: { provider: "fixture", modelId: "sol", id: "fixture:sol" },
};

// Session B: Pi session with timestamps, tail loaded (98, 99, 100) out of total 100 turns
const piTailContext = {
  messages: [
    { role: "user", content: [{ type: "text", text: "长历史尾部第98轮用户提问" }], entryId: "u98", timestamp: 98000 },
    { role: "assistant", content: [{ type: "text", text: "长历史尾部第98轮助手回答" }], entryId: "a98", timestamp: 98001 },
    { role: "user", content: [{ type: "text", text: "长历史尾部第99轮用户提问" }], entryId: "u99", timestamp: 99000 },
    { role: "assistant", content: [{ type: "text", text: "长历史尾部第99轮助手回答" }], entryId: "a99", timestamp: 99001 },
    { role: "user", content: [{ type: "text", text: "长历史尾部第100轮用户提问" }], entryId: "u100", timestamp: 100000 },
    { role: "assistant", content: [{ type: "text", text: "长历史尾部第100轮助手回答" }], entryId: "a100", timestamp: 100001 },
  ],
  entryIds: ["u98", "a98", "u99", "a99", "u100", "a100"],
  oldestEntryId: "u98",
  hasMore: true,
  thinkingLevel: "off",
  model: { provider: "fixture", modelId: "sol", id: "fixture:sol" },
};

// Older page for Session B when pagination is triggered (before=u98)
const piOlderPage = {
  context: {
    messages: [
      { role: "user", content: [{ type: "text", text: "长历史更早第96轮用户提问" }], entryId: "u96", timestamp: 96000 },
      { role: "assistant", content: [{ type: "text", text: "长历史更早第96轮助手回答" }], entryId: "a96", timestamp: 96001 },
      { role: "user", content: [{ type: "text", text: "长历史更早第97轮用户提问" }], entryId: "u97", timestamp: 97000 },
      { role: "assistant", content: [{ type: "text", text: "长历史更早第97轮助手回答" }], entryId: "a97", timestamp: 97001 },
    ],
    entryIds: ["u96", "a96", "u97", "a97"],
    oldestEntryId: "u96",
    hasMore: true,
    thinkingLevel: "off",
    model: { provider: "fixture", modelId: "sol", id: "fixture:sol" },
  },
  before: "u98",
  tail: 100,
};

const sseStreams = new Map();

function broadcastSse(sid, event) {
  const set = sseStreams.get(sid);
  if (set) {
    for (const res of set) {
      if (!res.destroyed && !res.writableEnded) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  }
}

// 4. HTTP Server Setup
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");

  const sendJson = (data, status = 200) => {
    if (res.destroyed || res.writableEnded) return;
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
  };

  if (url.pathname === "/bundle.js") {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    return res.end(jsBundleText);
  }

  if (url.pathname === "/enhancements.js") {
    res.setHeader("content-type", "text/javascript; charset=utf-8");
    return res.end(enhancementsScript);
  }

  if (url.pathname === "/api/models-config") {
    return sendJson({
      providers: {},
      models: {},
      archivedSessions: [],
      quickShortcuts: [],
      shortcutsRevision: 1,
    });
  }

  if (/^\/pi-(?:agent-update|archived|odoo-addons|pinned|shortcuts|tags)-manifest\.json/.test(url.pathname)) {
    return sendJson([]);
  }

  // SSE Events connection
  const sseMatch = /^\/api\/agent\/([^/]+)\/events$/.exec(url.pathname);
  if (sseMatch) {
    const sid = decodeURIComponent(sseMatch[1]);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (!sseStreams.has(sid)) sseStreams.set(sid, new Set());
    sseStreams.get(sid).add(res);
    res.on("close", () => sseStreams.get(sid)?.delete(res));
    res.write(`data: ${JSON.stringify({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] })}\n\n`);
    return;
  }

  // Session context pagination
  const contextMatch = /^\/api\/sessions\/([^/]+)\/context$/.exec(url.pathname);
  if (contextMatch) {
    const sid = decodeURIComponent(contextMatch[1]);
    const before = url.searchParams.get("before");
    const tailParam = url.searchParams.get("tail");
    if (sid === "pi:turn-long" && before === "u98") {
      const resp = {
        context: piOlderPage.context,
        before,
      };
      if (tailParam !== null) {
        resp.tail = Number(tailParam);
      }
      return sendJson(resp);
    }
    return sendJson({ error: "no more history" }, 404);
  }

  // Session detail and initial context
  const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
  if (sessionMatch) {
    const sid = decodeURIComponent(sessionMatch[1]);
    if (sid === "codex:turn-test") {
      return sendJson({
        sessionId: sid,
        info: sessionConfigs[sid],
        tree: [],
        leafId: "a4",
        totalActiveMs: 0,
        treeFormat: "summary",
        snapshotRevision: "rev-codex",
        navigationTotalTurns: 4,
        context: codexContext,
      });
    }
    if (sid === "pi:turn-long") {
      return sendJson({
        sessionId: sid,
        info: sessionConfigs[sid],
        tree: [],
        leafId: "a100",
        totalActiveMs: 0,
        treeFormat: "summary",
        snapshotRevision: "rev-pi-1",
        navigationTotalTurns: 100,
        context: piTailContext,
      });
    }
    return sendJson({ error: "session not found" }, 404);
  }

  if (url.pathname === "/api/sessions") {
    return sendJson({ sessions: Object.values(sessionConfigs) });
  }

  if (url.pathname.startsWith("/api/agent/")) {
    return sendJson({
      success: true,
      data: {
        isStreaming: false,
        running: false,
        model: { provider: "fixture", modelId: "sol", id: "fixture:sol" },
        thinkingLevel: "off",
      },
      models: { "fixture:sol": "Sol" },
      modelList: [{ provider: "fixture", id: "sol", name: "Sol" }],
      skills: [],
      pendingExtensionUiRequests: [],
      tools: [],
    });
  }

  if (url.pathname.startsWith("/api/")) {
    return sendJson({
      success: true,
      models: { "fixture:sol": "Sol" },
      modelList: [{ provider: "fixture", id: "sol", name: "Sol" }],
      skills: [],
      running: false,
      isStreaming: false,
      data: {},
      tools: [],
    });
  }

  // Root HTML document
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Turn Number Acceptance Test</title>
  <style>
    ${compiledCss}
    html, body, #root { height: 100%; margin: 0; padding: 0; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__TURN_FIXTURE_SESSIONS__ = ${JSON.stringify(sessionConfigs)};
  </script>
  <script src="/enhancements.js"></script>
  <script src="/bundle.js"></script>
</body>
</html>`);
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const origin = `http://127.0.0.1:${port}`;

// 5. Test Suite Execution
const receipt = {
  at: new Date().toISOString(),
  baseline,
  status: "running",
  checks: [],
  artifacts: [],
  errors: [],
};

let browser;

try {
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true,
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: "zh-CN" });
  page.on("pageerror", (err) => receipt.errors.push(`[PageError] ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      receipt.errors.push(`[ConsoleError] ${msg.text()}`);
    }
  });

  console.log(`Starting real browser verification at ${origin}...`);
  await page.goto(origin, { waitUntil: "domcontentloaded" });

  // Wait for initial Codex session to hydrate
  await page.waitForSelector("#fixture-active-id", { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector("#fixture-active-id")?.textContent === "codex:turn-test");

  // === 1. Codex Session (no timestamps) Native Badges & Duplicate Text Check ===
  console.log("Checking Scenario 1: Codex session without timestamp & identical text counting...");
  if (baseline) {
    // Negative proof on legacy baseline: Codex user messages without timestamp must NOT have badges
    const baselineBadges = await page.$$eval(".pi-enh-turn-number-badge", (els) => els.length);
    assert.equal(baselineBadges, 0, "[Baseline] Legacy codebase should have 0 turn number badges for messages without timestamp");
    receipt.checks.push({ name: "baseline-negative-proof", passed: true, note: "0 badges as expected on baseline" });
    console.log("✓ Baseline negative proof passed (0 badges on legacy)");
  } else {
    // Candidate verification: badges #1, #2, #3, #4 must be rendered natively
    await page.waitForSelector('.pi-enh-turn-number-badge[data-turn-number="4"]', { timeout: 10000 });
    const codexBadges = await page.$$eval(".pi-enh-turn-number-badge", (els) =>
      els.map((el) => ({
        turn: el.getAttribute("data-turn-number"),
        text: el.textContent?.trim(),
      }))
    );
    assert.equal(codexBadges.length, 4, "Codex session should render exactly 4 turn number badges");
    assert.deepEqual(
      codexBadges.map((b) => b.text),
      ["#1", "#2", "#3", "#4"],
      "Badges must be numbered #1 to #4 sequentially"
    );

    // Verify turn 3 and turn 4 have identical content but distinct turn numbers
    const userTexts = await page.$$eval(".markdown-user-message", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    assert.equal(userTexts[2], "第三个用户消息同文");
    assert.equal(userTexts[3], "第三个用户消息同文");
    assert.equal(codexBadges[2].text, "#3");
    assert.equal(codexBadges[3].text, "#4");

    // Zero duplicate badges check
    const userContainers = await page.$$eval(".markdown-user-message", (els) => els.length);
    assert.equal(codexBadges.length, userContainers, "Each user message must have exactly 1 turn number badge");

    // Zero fake timestamp check on Codex
    const timestampsInCodex = await page.$$eval(".markdown-user-message", (els) => {
      return els.map((el) => {
        const bottomRow = el.closest(".message-wrapper, div")?.parentElement?.querySelector("div[style*='justify-content: flex-end']");
        const timeEl = bottomRow?.querySelector("span[style*='font-size: 10']");
        return timeEl?.textContent?.trim() || null;
      });
    });
    // Messages without timestamp must NOT display a fabricated timestamp
    for (const time of timestampsInCodex) {
      assert.equal(time, null, "Codex user messages without timestamp must not fabricate Date.now()");
    }

    const codexScreenshotPath = path.join(outputDir, "turn-number-codex-1280.png");
    await page.screenshot({ path: codexScreenshotPath, fullPage: false });
    receipt.artifacts.push(codexScreenshotPath);
    receipt.checks.push({ name: "codex-no-timestamp-badges", passed: true, count: 4 });
    console.log("✓ Scenario 1: Codex native turn numbers passed");

    // === 2. Switch to Session B (Pi Long Session) Tail Offset & Timestamp Layout ===
    console.log("Checking Scenario 2: Pi long session tail offset (#98, #99, #100) & timestamp layout...");
    await page.click("#fixture-switch-b");
    await page.waitForFunction(() => document.querySelector("#fixture-active-id")?.textContent === "pi:turn-long");
    await page.waitForSelector('.pi-enh-turn-number-badge[data-turn-number="100"]', { timeout: 10000 });

    const piTailBadges = await page.$$eval(".pi-enh-turn-number-badge", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    assert.deepEqual(piTailBadges, ["#98", "#99", "#100"], "Tail messages of total 100 turns must be #98, #99, #100");

    // Verify timestamp alignment: badge is to the left of the timestamp
    const badgeTimeAlignment = await page.$$eval(".pi-enh-turn-number-badge", (badges) => {
      return badges.map((badge) => {
        const parent = badge.parentElement;
        const timeSpan = parent?.querySelector("span[style*='font-size: 10']");
        if (!timeSpan) return null;
        const bRect = badge.getBoundingClientRect();
        const tRect = timeSpan.getBoundingClientRect();
        return {
          badgeRight: bRect.right,
          timeLeft: tRect.left,
          valid: bRect.right <= tRect.left + 2, // Allow 2px tolerance for subpixel layout
        };
      });
    });
    for (const item of badgeTimeAlignment) {
      if (item) {
        assert.equal(item.valid, true, "Turn number badge must be positioned to the left of timestamp");
      }
    }

    const piScreenshotPath = path.join(outputDir, "turn-number-pi-1280.png");
    await page.screenshot({ path: piScreenshotPath, fullPage: false });
    receipt.artifacts.push(piScreenshotPath);
    receipt.checks.push({ name: "pi-tail-turn-numbers", passed: true, badges: piTailBadges });
    console.log("✓ Scenario 2: Pi long session tail offset passed");

    // === 3. Native Pagination: Click Real Load Button & Prepend Earlier History ===
    console.log("Checking Scenario 3: Real history pagination prepend (#96, #97, #98, #99, #100)...");
    const loadButton = page.locator("button[data-history-load-state]");
    await loadButton.waitFor({ state: "visible", timeout: 8000 });
    await loadButton.click();

    // After pagination, u96 and u97 are prepended, total turns 100, loaded 5 turns -> #96..#100
    await page.waitForSelector('.pi-enh-turn-number-badge[data-turn-number="96"]', { timeout: 10000 });
    const paginatedBadges = await page.$$eval(".pi-enh-turn-number-badge", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    assert.deepEqual(
      paginatedBadges,
      ["#96", "#97", "#98", "#99", "#100"],
      "Prepending earlier history must preserve tail #98..#100 and prepend #96, #97"
    );
    receipt.checks.push({ name: "native-pagination-prepend", passed: true, badges: paginatedBadges });
    console.log("✓ Scenario 3: Native history pagination passed");

    // === 4. Dynamically Append Turn #101 via Real Composer Submission ===
    console.log("Checking Scenario 4: Real composer turn submission (#101)...");
    const composerTextarea = page.locator("textarea.chat-input-textarea");
    await composerTextarea.waitFor({ state: "visible", timeout: 8000 });
    await composerTextarea.fill("第101轮新追加用户问题");
    await composerTextarea.press("Enter");

    await page.waitForSelector('.pi-enh-turn-number-badge[data-turn-number="101"]', { timeout: 10000 });
    const appendedBadges = await page.$$eval(".pi-enh-turn-number-badge", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    assert.deepEqual(
      appendedBadges,
      ["#96", "#97", "#98", "#99", "#100", "#101"],
      "Appending turn #101 must advance total to 101 while keeping previous badges intact"
    );
    receipt.checks.push({ name: "real-composer-append-turn", passed: true, badges: appendedBadges });
    console.log("✓ Scenario 4: Real composer turn submission passed");

    // === 5. Session Switch A -> B -> A with Clean Isolation ===
    console.log("Checking Scenario 5: Session switch A -> B -> A isolation...");
    // Switch back to Session A (Codex)
    await page.click("#fixture-switch-a");
    await page.waitForFunction(() => document.querySelector("#fixture-active-id")?.textContent === "codex:turn-test");
    await page.waitForSelector('.pi-enh-turn-number-badge[data-turn-number="4"]', { timeout: 10000 });
    let aReturnBadges = await page.$$eval(".pi-enh-turn-number-badge", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    assert.deepEqual(aReturnBadges, ["#1", "#2", "#3", "#4"], "Session A must cleanly show #1..#4 upon return");

    // Switch to Session B again
    await page.click("#fixture-switch-b");
    await page.waitForFunction(() => document.querySelector("#fixture-active-id")?.textContent === "pi:turn-long");
    await page.waitForSelector('.pi-enh-turn-number-badge[data-turn-number="100"]', { timeout: 10000 });
    let bReturnBadges = await page.$$eval(".pi-enh-turn-number-badge", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    assert.ok(bReturnBadges.includes("#100"), "Session B must resume its turn numbers");

    // Switch back to Session A again
    await page.click("#fixture-switch-a");
    await page.waitForFunction(() => document.querySelector("#fixture-active-id")?.textContent === "codex:turn-test");
    await page.waitForSelector('.pi-enh-turn-number-badge[data-turn-number="4"]', { timeout: 10000 });
    aReturnBadges = await page.$$eval(".pi-enh-turn-number-badge", (els) =>
      els.map((el) => el.textContent?.trim())
    );
    assert.deepEqual(aReturnBadges, ["#1", "#2", "#3", "#4"], "Session A must be completely isolated");
    await page.reload({waitUntil:'networkidle'});
    await page.waitForSelector('.pi-enh-turn-number-badge[data-turn-number="4"]');
    assert.deepEqual(await page.locator('.pi-enh-turn-number-badge').allTextContents(), ['#1','#2','#3','#4']);
    receipt.checks.push({ name: "session-switch-and-refresh-isolation", passed: true });
    console.log("✓ Scenario 5: Session switch A -> B -> A passed");

    // === 6. Feature & Module Toggles (Real localStorage & Events) ===
    console.log("Checking Scenario 6: Plugin and module toggles...");
    // 6.1 Toggle plugin off via real __PI_ENH_SET_PLUGIN__
    await page.evaluate(() => {
      if (typeof window.__PI_ENH_SET_PLUGIN__ !== "function") throw Error("Real plugin setter not loaded");
      window.__PI_ENH_SET_PLUGIN__("turn-number-indicator", false);
    });
    await page.waitForFunction(() => document.querySelectorAll(".pi-enh-turn-number-badge").length === 0, {
      timeout: 6000,
    });
    let badgeCount = await page.$$eval(".pi-enh-turn-number-badge", (els) => els.length);
    assert.equal(badgeCount, 0, "Badges must immediately exit when plugin is disabled");

    // 6.2 Toggle plugin back on
    await page.evaluate(() => {
      if (typeof window.__PI_ENH_SET_PLUGIN__ !== "function") throw Error("Real plugin setter not loaded");
      window.__PI_ENH_SET_PLUGIN__("turn-number-indicator", true);
    });
    await page.waitForFunction(() => document.querySelectorAll(".pi-enh-turn-number-badge").length === 4, {
      timeout: 6000,
    });
    badgeCount = await page.$$eval(".pi-enh-turn-number-badge", (els) => els.length);
    assert.equal(badgeCount, 4, "Badges must immediately restore when plugin is re-enabled");

    // 6.3 Toggle module off via __PI_ENH_SET_MODULE__
    await page.evaluate(() => {
      if (typeof window.__PI_ENH_SET_MODULE__ !== "function") throw Error("Real module setter not loaded");
      window.__PI_ENH_SET_MODULE__("task-insights", false);
    });
    await page.waitForFunction(() => document.querySelectorAll(".pi-enh-turn-number-badge").length === 0, {
      timeout: 6000,
    });
    badgeCount = await page.$$eval(".pi-enh-turn-number-badge", (els) => els.length);
    assert.equal(badgeCount, 0, "Badges must immediately exit when task-insights module is disabled");

    // 6.4 Toggle module back on
    await page.evaluate(() => {
      if (typeof window.__PI_ENH_SET_MODULE__ !== "function") throw Error("Real module setter not loaded");
      window.__PI_ENH_SET_MODULE__("task-insights", true);
    });
    await page.waitForFunction(() => document.querySelectorAll(".pi-enh-turn-number-badge").length === 4, {
      timeout: 6000,
    });
    badgeCount = await page.$$eval(".pi-enh-turn-number-badge", (els) => els.length);
    assert.equal(badgeCount, 4, "Badges must immediately restore when task-insights module is re-enabled");
    receipt.checks.push({ name: "feature-and-module-toggles", passed: true });
    console.log("✓ Scenario 6: Plugin and module toggles passed");

    // === 7. Responsive Viewport & Geometry (Desktop 1280x800 & Mobile 390x844) ===
    console.log("Checking Scenario 7: Geometry and responsive layouts...");
    const viewports = [
      { name: "desktop", width: 1280, height: 800 },
      { name: "mobile", width: 390, height: 844 },
    ];

    for (const engine of ['codex','pi']) for (const vp of viewports) {
      await page.click(engine==='codex'?'#fixture-switch-a':'#fixture-switch-b');
      await page.waitForSelector(engine==='codex'?'.pi-enh-turn-number-badge[data-turn-number="4"]':'.pi-enh-turn-number-badge[data-turn-number="100"]');
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.waitForTimeout(100);

      const geometryResult = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-entry-id][data-scroll-anchor]')).map(el=>{
          const b=el.getBoundingClientRect();return {id:el.getAttribute('data-entry-id'),y:b.y,bottom:b.bottom};
        });
        const overlapErrors=[];
        for(let i=1;i<rows.length;i++)if(rows[i].y<rows[i-1].bottom)overlapErrors.push({previous:rows[i-1],current:rows[i]});
        return {rows,overlapErrors,isOverflow:document.documentElement.scrollWidth>innerWidth};
      });
      assert(geometryResult.rows.length>=6,'Check actual adjacent user and assistant wrappers, not just the badge');

      assert.equal(geometryResult.overlapErrors.length, 0, `[${vp.name}] Adjacent message rows overlap: ${geometryResult.overlapErrors.join("; ")}`);
      assert.equal(geometryResult.isOverflow, false, `[${vp.name}] Horizontal overflow detected`);

      const vpScreenshotPath = path.join(outputDir, `turn-number-${engine}-${vp.name}-${vp.width}.png`);
      await page.screenshot({ path: vpScreenshotPath, fullPage: false });
      receipt.artifacts.push(vpScreenshotPath);
    }
    receipt.checks.push({ name: "viewport-geometry-and-no-overflow", passed: true });
    console.log("✓ Scenario 7: Viewport geometry and non-overlap passed");
  }

  assert.deepEqual(receipt.errors, [], `Unexpected errors encountered during test: ${receipt.errors.join("; ")}`);
  receipt.status = "passed";
} catch (err) {
  receipt.status = "failed";
  receipt.error = err.stack || err.message;
  process.exitCode = 1;
  console.error("Test execution failed:", err);
} finally {
  const receiptPath = path.join(outputDir, "turn-number-receipt.json");
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), "utf8");
  console.log(`Receipt saved to ${receiptPath}`);

  // Close browser and server connections
  if (browser) await browser.close().catch(() => {});
  for (const set of sseStreams.values()) {
    for (const res of set) {
      try {
        res.destroy();
      } catch (_) {}
    }
  }
  sseStreams.clear();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve)).catch(() => {});
  console.log("Cleanup finished.");
}
