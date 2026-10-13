// Native ChatWindow history-navigation fixture. All API/SSE traffic terminates
// at this process; it never starts a model, agent, or production service.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require("playwright");
const sourceRoot = process.env.HISTORY_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const baseline = process.env.HISTORY_BASELINE === "1";
const sourceRequire = createRequire(path.join(sourceRoot, "package.json"));

const userMessage = (turn, text = `导航测试用户轮次 ${turn}`) => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: turn * 1000,
});

const assistantMessage = (turn, long = false) => ({
  role: "assistant",
  content: [{
    type: "text",
    text: long
      ? `最后一轮的长回答 ${turn}。\n\n${("长回答正文用于保持真实滚动高度和阅读位置。 ".repeat(45) + "\n\n").repeat(3)}`
      : `导航测试助手轮次 ${turn}。\n\n这是固定的服务端历史内容。`,
  }],
  timestamp: turn * 1000 + 1,
  api: "openai-responses",
  provider: "openai",
  model: "gpt-6.1-sol",
  stopReason: "stop",
  usage: {
    input: 10,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 20,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

function makeSession(id, totalTurns, initialTurns = 1, options = {}) {
  const turns = Array.from({ length: totalTurns }, (_, index) => {
    const turn = index + 1;
    return {
      turn,
      messages: [
        userMessage(turn, options.userText?.(turn) ?? `导航测试用户轮次 ${turn}`),
        assistantMessage(turn, options.longLastAssistant && turn === totalTurns),
      ],
      ids: [`u${turn}`, `a${turn}`],
    };
  });
  const loaded = turns.slice(-initialTurns);
  const messages = loaded.flatMap((turn) => turn.messages);
  const entryIds = loaded.flatMap((turn) => turn.ids);
  const info = {
    id,
    cwd: "/isolated/history-fixture",
    name: `History fixture ${id}`,
    path: `/isolated/${id}.jsonl`,
    created: new Date(0).toISOString(),
    modified: new Date(0).toISOString(),
    messageCount: totalTurns * 2,
    firstMessage: `fixture ${id}`,
  };
  return {
    id,
    info,
    turns,
    initialTurns,
    messages,
    entryIds,
    oldestEntryId: entryIds[0] ?? null,
    hasMore: totalTurns > initialTurns,
    failuresRemaining: options.failures ?? 0,
    holdFirstPage: options.holdFirstPage ?? false,
    pending: null,
    pageRequests: [],
  };
}

function contextFor(messages, entryIds, oldestEntryId, hasMore) {
  return {
    messages,
    entryIds,
    oldestEntryId,
    hasMore,
    thinkingLevel: "off",
    model: { provider: "openai", modelId: "gpt-6.1-sol", id: "gpt-6.1-sol" },
  };
}

function olderPage(config, before) {
  const match = /^u(\d+)$/.exec(before ?? "");
  if (!match) throw new Error(`Fixture received invalid history cursor: ${before}`);
  const cursorTurn = Number(match[1]);
  const firstTurn = Math.max(1, cursorTurn - 2);
  const pageTurns = config.turns.filter((turn) => turn.turn >= firstTurn && turn.turn < cursorTurn);
  const messages = pageTurns.flatMap((turn) => turn.messages);
  const entryIds = pageTurns.flatMap((turn) => turn.ids);
  return {
    context: contextFor(messages, entryIds, pageTurns.length ? pageTurns[0].ids[0] : null, firstTurn > 1),
  };
}

const sessions = new Map();
const allPageRequests = [];
const pageErrors = [];
const externalRequests = [];
const receipts = [];
const trackedPages = new Map();
let activeScenario = "startup";

const bundle = await build({
  stdin: {
    resolveDir: sourceRoot,
    loader: "tsx",
    contents: `
      import React, { useState } from "react";
      import { createRoot } from "react-dom/client";
      import { ChatWindow } from "./components/ChatWindow";
      import { I18nProvider } from "./hooks/useI18n";

      const sessions = window.__HISTORY_FIXTURE_SESSIONS__;

      function Fixture() {
        const [sessionId, setSessionId] = useState(sessions.initialId);
        const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
        const session = sessions.byId[sessionId];
        return (
          <I18nProvider>
            <div id="fixture-controls">
              <button id="fixture-open-navigation" onClick={() => setMobileNavigationOpen(true)}>打开导航</button>
              <button id="fixture-switch-session" onClick={() => setSessionId(sessions.switchTo)}>切换会话</button>
              <span id="fixture-active-session">{sessionId}</span>
            </div>
            <ChatWindow
              key={sessionId}
              session={session}
              newSessionCwd={null}
              newSessionDraftKey={null}
              mobileNavigationOpen={mobileNavigationOpen}
              onMobileNavigationOpenChange={setMobileNavigationOpen}
            />
          </I18nProvider>
        );
      }

      createRoot(document.getElementById("root")).render(<Fixture />);
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

async function compileGlobalCss() {
  const helperPath = path.join(sourceRoot, "tests/native-settings-css.cjs");
  if (fs.existsSync(helperPath)) {
    return sourceRequire("./tests/native-settings-css.cjs").compileSettingsCss();
  }
  const postcss = require("postcss");
  const tailwind = require("@tailwindcss/postcss");
  const styles = ["app/globals.css", "app/settings.css"]
    .map((relativePath) => path.join(sourceRoot, relativePath))
    .filter((filePath) => fs.existsSync(filePath))
    .map((filePath) => fs.readFileSync(filePath, "utf8"));
  const from = path.join(sourceRoot, "app/globals.css");
  const result = await postcss([tailwind({ base: sourceRoot, optimize: false })])
    .process(styles.join("\n"), { from });
  return result.css;
}

const css = await compileGlobalCss()
  + "\n"
  + bundle.outputFiles.filter((file) => file.path.endsWith(".css")).map((file) => file.text).join("\n");
const fixtureSessions = { initialId: "", switchTo: "", byId: {} };

function sendJson(response, value, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function pageContextResponse(config, before) {
  const page = olderPage(config, before);
  return {
    ...page,
    tail: 100,
    before,
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://history-fixture");
  if (url.pathname === "/bundle.js") {
    response.setHeader("content-type", "text/javascript; charset=utf-8");
    return response.end(bundle.outputFiles.find((file) => file.path.endsWith(".js")).text);
  }
  if (url.pathname.startsWith("/api/agent/") && url.pathname.endsWith("/events")) {
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache");
    response.write(`data: ${JSON.stringify({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] })}\n\n`);
    return;
  }

  const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(context))?$/.exec(url.pathname);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const config = sessions.get(sessionId);
    if (!config) return sendJson(response, { error: "unknown fixture session" }, 404);
    if (sessionMatch[2] === "context" && url.searchParams.has("before")) {
      const before = url.searchParams.get("before");
      const item = {
        sessionId,
        before,
        tail: Number(url.searchParams.get("tail") || 0),
        at: Date.now(),
      };
      config.pageRequests.push(item);
      allPageRequests.push(item);

      if (config.failuresRemaining > 0) {
        config.failuresRemaining--;
        return sendJson(response, { error: "isolated fixture failure" }, 503);
      }
      if (config.holdFirstPage && !config.pending) {
        config.pending = { response, before };
        return;
      }
      return sendJson(response, pageContextResponse(config, before));
    }

    return sendJson(response, {
      sessionId,
      info: config.info,
      tree: [],
      leafId: `a${config.turns.at(-1)?.turn ?? 1}`,
      totalActiveMs: 0,
      context: contextFor(config.messages, config.entryIds, config.oldestEntryId, config.hasMore),
    });
  }

  if (/^\/api\/agent\/[^/]+\/events$/.test(url.pathname)) {
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.write(`data: ${JSON.stringify({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] })}\n\n`);
    return;
  }
  if (url.pathname.startsWith("/api/agent/")) {
    return sendJson(response, {
      success: true,
      data: {
        isStreaming: false,
        running: false,
        model: { provider: "openai", modelId: "gpt-6.1-sol", id: "gpt-6.1-sol" },
        thinkingLevel: "off",
      },
      models: { "openai:gpt-6.1-sol": "GPT-6.1 Sol" },
      modelList: [],
      skills: [],
      pendingExtensionUiRequests: [],
      tools: [],
    });
  }
  if (url.pathname.startsWith("/api/")) {
    return sendJson(response, {
      success: true,
      models: { "openai:gpt-6.1-sol": "GPT-6.1 Sol" },
      modelList: [],
      skills: [],
      running: false,
      isStreaming: false,
      pendingExtensionUiRequests: [],
      data: {},
      tools: [],
    });
  }

  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html>
    <html data-theme="dark"><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>${css}
        html, body, #root { height: 100%; margin: 0; }
        #root { display: flex; flex-direction: column; }
        #fixture-controls { position: fixed; z-index: 10000; top: 0; left: 0; opacity: .8; }
      </style>
    </head><body><div id="root"></div>
      <script>window.__HISTORY_FIXTURE_SESSIONS__ = ${JSON.stringify(fixtureSessions)};</script>
      <script src="/bundle.js"></script>
    </body></html>`);
});

async function waitFor(predicate, description, timeoutMs = 7000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function records(config) {
  return config.pageRequests.map(({ sessionId, before, tail }) => ({ sessionId, before, tail }));
}

function releasePendingPage(config) {
  assert.ok(config.pending, `Expected ${config.id} to have a held history page`);
  const { response, before } = config.pending;
  config.pending = null;
  config.holdFirstPage = false;
  response.end(JSON.stringify(pageContextResponse(config, before)));
}

async function scrollMetrics(scroll) {
  return scroll.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    scrollTop: element.scrollTop,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    distanceFromBottom: element.scrollHeight - element.scrollTop - element.clientHeight,
  }));
}

async function captureScenario(page, receipt) {
  receipts.push(receipt);
  if (!process.env.HISTORY_ARTIFACT_DIR) return;
  fs.mkdirSync(process.env.HISTORY_ARTIFACT_DIR, { recursive: true });
  const safeName = receipt.scenario.replace(/[^a-z0-9-]/gi, "-");
  await page.screenshot({ path: path.join(process.env.HISTORY_ARTIFACT_DIR, `${safeName}.png`) });
}

async function openBrowserPage(browser, origin, width, sessionConfigs, switchTo = "") {
  for (const config of sessionConfigs) {
    sessions.set(config.id, config);
    fixtureSessions.byId[config.id] = config.info;
  }
  fixtureSessions.initialId = sessionConfigs[0].id;
  fixtureSessions.switchTo = switchTo;

  const context = await browser.newContext({
    viewport: { width, height: 844 },
    locale: "zh-CN",
    hasTouch: width <= 640,
  });
  await context.addInitScript(() => {
    // Keep the fixture on the real network path without the optional page cache.
    localStorage.setItem("pi-enh-settings-v1", JSON.stringify({ modules: { "local-workspace": { enabled: false } } }));
  });
  const page = await context.newPage();
  trackedPages.set(page, {
    scenario: activeScenario,
    width,
    sessionIds: sessionConfigs.map((config) => config.id),
  });
  page.on("close", () => trackedPages.delete(page));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (item) => {
    if (new URL(item.url()).origin !== origin) externalRequests.push(item.url());
  });
  await page.goto(origin);
  const scroll = page.locator("[data-pi-native-scroll-owner]");
  await scroll.waitFor({ timeout: 5000 });
  const lastUserText = sessionConfigs[0].turns.at(-1).messages[0].content[0].text;
  await scroll.getByText(lastUserText, { exact: true }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(120);
  return { context, page, scroll };
}

async function showDesktopNodes(page) {
  const rail = page.locator("[data-minimap-native-owner]").first();
  await rail.hover({ timeout: 3000 });
  await page.locator("[data-minimap-node-index]").first().waitFor({ timeout: 3000 });
  return page.locator("[data-minimap-node-index]").count();
}

async function runBaselineDesktop(browser, origin) {
  const desktop = makeSession("baseline-desktop", 9, 1, { longLastAssistant: true });
  const { context: desktopContext, page: desktopPage } = await openBrowserPage(browser, origin, 980, [desktop]);
  await desktopPage.waitForTimeout(500);
  const desktopNodes = await showDesktopNodes(desktopPage);
  assert.equal(desktopNodes, 1, "baseline should retain only the one initially loaded navigation node");
  assert.equal(desktop.pageRequests.length, 0, "baseline should not automatically fetch older history");
  await captureScenario(desktopPage, { scenario: "baseline-desktop", width: 980, nodes: desktopNodes, requests: records(desktop) });
  await desktopContext.close();
}

async function runBaselinePhone(browser, origin) {
  const phone = makeSession("baseline-phone", 9, 1);
  const { context: phoneContext, page: phonePage } = await openBrowserPage(browser, origin, 390, [phone]);
  await phonePage.waitForTimeout(300);
  assert.equal(phone.pageRequests.length, 0, "baseline phone with closed navigation should not fetch history");
  await captureScenario(phonePage, { scenario: "baseline-phone-closed", width: 390, nodes: 1, requests: records(phone) });
  await phoneContext.close();
}

async function runDesktopBoundedPrefetch(browser, origin) {
  const config = makeSession("desktop-prefetch", 9, 1, { longLastAssistant: true, holdFirstPage: true });
  const { context, page, scroll } = await openBrowserPage(browser, origin, 980, [config]);
  await waitFor(() => Boolean(config.pending), "desktop first automatic page request");
  const initialState = await page.evaluate(() => window.__PI_ENH_GET_HISTORY_STATE__?.());
  assert.equal(initialState?.entryIds?.length, 2, "the desktop fixture starts with one user turn and its assistant reply");
  assert.equal(initialState?.hasEarlierMessages, true, "the initial desktop context must advertise older history");
  assert.equal(await showDesktopNodes(page), 1, "only the latest user turn should be navigable before pagination");
  const sentinel = page.locator("button[data-history-load-state]").first();
  await sentinel.waitFor({ timeout: 3000 });
  assert.equal(await sentinel.getAttribute("data-history-load-state"), "loading");
  const spinner = page.locator("[data-history-load-spinner]");
  assert.equal(await spinner.count(), 1, "a pending request must render its actual spinner");
  const normalAnimation = await spinner.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  assert.notEqual(normalAnimation.name, "none", "pending history spinner must rotate under normal motion settings");

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedAnimation = await spinner.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  assert.equal(reducedAnimation.name, "none", "reduced motion must disable spinner rotation");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const before = await scrollMetrics(scroll);
  releasePendingPage(config);
  await waitFor(async () => config.pageRequests.length === 2 && await page.locator("[data-minimap-node-index]").count() === 5,
    "desktop navigation to stop at five loaded user turns");
  await page.waitForTimeout(180);
  assert.equal(config.pageRequests.length, 2, "the five-turn target must remain stable after the render settles");
  await waitFor(() => sentinel.getAttribute("data-history-load-state").then((state) => state === "idle"), "idle history indicator");
  const after = await scrollMetrics(scroll);
  assert.ok(Math.abs(after.distanceFromBottom - before.distanceFromBottom) < 3,
    "automatic prepends preserve the bottom reading position");
  assert.equal(await page.locator("[data-history-load-spinner]").count(), 0, "idle state must not retain or animate the spinner");
  assert.equal((await page.evaluate(() => window.__PI_ENH_GET_HISTORY_STATE__?.()))?.hasEarlierMessages, true,
    "navigation should stop at five turns while the session still has older history");
  assert.equal(await showDesktopNodes(page), 5, "the visible desktop navigator must contain five loaded user nodes");
  assert.equal(config.pageRequests.length, 2, "two pages of two user turns should satisfy the five-turn target");
  await captureScenario(page, {
    scenario: "desktop-bounded-prefetch",
    width: 980,
    initialUserTurns: 1,
    finalUserNodes: 5,
    requests: records(config),
    before,
    after,
    normalAnimation,
    reducedAnimation,
  });
  await context.close();
}

async function runPhoneOpenLoad(browser, origin) {
  const config = makeSession("phone-prefetch", 9, 1, { longLastAssistant: true });
  const { context, page, scroll } = await openBrowserPage(browser, origin, 390, [config]);
  await page.waitForTimeout(350);
  assert.equal(config.pageRequests.length, 0, "closed mobile navigation must not request older context");
  const widthBefore = await scroll.evaluate((element) => element.getBoundingClientRect().width);
  await page.locator("#fixture-open-navigation").click();
  const dialog = page.getByRole("dialog", { name: "会话导航" });
  await dialog.waitFor({ timeout: 3000 });
  await waitFor(async () => config.pageRequests.length === 2 && await dialog.locator("[data-minimap-preview-user]").count() === 5,
    "mobile overlay to load exactly five user navigation nodes");
  await page.waitForTimeout(180);
  assert.equal(config.pageRequests.length, 2, "mobile navigation must stop once five user turns are loaded");
  const widthAfter = await scroll.evaluate((element) => element.getBoundingClientRect().width);
  assert.equal(widthAfter, widthBefore, "opening the mobile navigation overlay must not resize the chat");
  assert.equal(config.pageRequests.length, 2, "the opened mobile navigation must stop at five loaded user turns");
  assert.equal((await page.evaluate(() => window.__PI_ENH_GET_HISTORY_STATE__?.()))?.hasEarlierMessages, true);
  await captureScenario(page, { scenario: "phone-closed-then-open", width: 390, widthBefore, widthAfter, nodes: 5, requests: records(config) });
  await context.close();
}

async function runAlreadyLoadedAndScrollAnchor(browser, origin) {
  const config = makeSession("already-loaded", 10, 8, { longLastAssistant: true });
  config.holdFirstPage = true;
  const { context, page, scroll } = await openBrowserPage(browser, origin, 980, [config]);
  await page.waitForTimeout(350);
  assert.equal(config.pageRequests.length, 0, "eight initially loaded turns already exceed the initial five-turn target");
  assert.equal(await showDesktopNodes(page), 8);
  await scroll.evaluate((element) => {
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) * 0.45);
  });
  const anchor = await scroll.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const target = [...element.querySelectorAll("[data-scroll-anchor][data-entry-id]")].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.bottom > box.top + 12 && rect.top < box.bottom - 12;
    });
    if (!target) throw new Error("fixture could not find a visible message anchor");
    return { entryId: target.getAttribute("data-entry-id"), top: target.getBoundingClientRect().top };
  });
  const sentinel = page.locator("button[data-history-load-state]").first();
  await sentinel.evaluate((element) => element.click());
  await waitFor(() => Boolean(config.pending), "manual history page request after eight loaded turns");
  assert.equal(await sentinel.getAttribute("data-history-load-state"), "loading");
  releasePendingPage(config);
  await waitFor(async () => config.pageRequests.length === 1 && await page.locator('[data-entry-id="u1"]').count() === 1,
    "older page prepend after the manual request");
  await page.waitForTimeout(80);
  const anchorAfter = await page.locator(`[data-scroll-anchor][data-entry-id="${anchor.entryId}"]`).evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(Math.abs(anchorAfter - anchor.top) < 3, `prepend moved current reading anchor from ${anchor.top} to ${anchorAfter}`);
  await captureScenario(page, { scenario: "already-loaded-and-anchor", width: 980, autoRequests: 0, manualRequests: records(config), anchor, anchorAfter });
  await context.close();
}

async function runShortHistory(browser, origin) {
  const config = makeSession("short-history", 2, 1, { longLastAssistant: true });
  const { context, page } = await openBrowserPage(browser, origin, 980, [config]);
  await waitFor(async () => config.pageRequests.length === 1 && await page.locator("[data-minimap-node-index]").count() === 2,
    "short history to reach its terminal page");
  await page.waitForTimeout(250);
  assert.equal(config.pageRequests.length, 1, "hasMore false must stop automatic loading at the two-turn history boundary");
  assert.equal(await showDesktopNodes(page), 2);
  await captureScenario(page, { scenario: "short-history-terminal", width: 980, nodes: 2, requests: records(config), hasMore: false });
  await context.close();
}

async function runFailureAndExplicitRetry(browser, origin) {
  const config = makeSession("retry-history", 5, 1, { failures: 1, longLastAssistant: true });
  const { context, page } = await openBrowserPage(browser, origin, 980, [config]);
  const sentinel = page.locator("button[data-history-load-state]").first();
  await waitFor(async () => config.pageRequests.length === 1 && await sentinel.getAttribute("data-history-load-state") === "error",
    "one failed automatic history request and visible error state");
  await page.waitForTimeout(300);
  assert.equal(config.pageRequests.length, 1, "a failed automatic request must not enter a retry loop");
  assert.equal(await sentinel.isEnabled(), true, "failed history must expose an actionable retry");
  assert.match(await sentinel.innerText(), /失败|重试/, "retry action must announce the failure and retry affordance");

  const rail = page.locator("[data-minimap-native-owner]").first();
  await rail.hover({ timeout: 3000 });
  const navRetry = page.locator("[data-pi-enh-minimap-load-earlier]");
  await navRetry.waitFor({ timeout: 3000 });
  assert.equal(await navRetry.isEnabled(), true);
  assert.match(await navRetry.getAttribute("aria-label"), /失败|重试/);
  await navRetry.click();
  await waitFor(async () => config.pageRequests.length === 3 && await page.locator("[data-minimap-node-index]").count() === 5,
    "explicit navigation retry to recover the remaining short history");
  assert.deepEqual(config.pageRequests.map((request) => request.before), ["u5", "u5", "u3"]);
  await captureScenario(page, { scenario: "failed-then-explicit-retry", width: 980, nodes: 5, requests: records(config), retryAccessible: true });
  await context.close();
}

async function runSessionSwitchWhilePending(browser, origin) {
  const oldSession = makeSession("switch-old", 9, 1, {
    holdFirstPage: true,
    userText: (turn) => `旧会话消息 ${turn}`,
  });
  const newSession = makeSession("switch-new", 1, 1, {
    longLastAssistant: true,
    userText: () => "新会话唯一消息",
  });
  newSession.hasMore = false;
  const { context, page } = await openBrowserPage(browser, origin, 980, [oldSession, newSession], newSession.id);
  await waitFor(() => Boolean(oldSession.pending), "old session page to remain pending");
  await page.locator("#fixture-switch-session").click();
  await page.locator("#fixture-active-session").getByText(newSession.id, { exact: true }).waitFor({ timeout: 5000 });
  const scroll = page.locator("[data-pi-native-scroll-owner]");
  await scroll.getByText("新会话唯一消息", { exact: true }).waitFor({ timeout: 5000 });
  await waitFor(async () => await page.locator("[data-minimap-node-index]").count() === 1, "new session navigation node");
  assert.equal(await page.locator('[data-minimap-node-index]').count(), 1);
  assert.equal(await page.locator('[data-history-load-state="loading"]').count(), 0, "new session must not show old session loading status");
  await page.locator("[data-minimap-native-owner]").first().hover({ timeout: 3000 });
  const navigationStatus = page.locator("[data-pi-enh-minimap-load-earlier]");
  await navigationStatus.waitFor({ timeout: 3000 });
  const newSessionStatus = await navigationStatus.getAttribute("aria-label");
  assert.equal(await navigationStatus.isDisabled(), true, "new session navigation must report its own terminal history state");

  releasePendingPage(oldSession);
  await page.waitForTimeout(260);
  assert.equal(await page.locator("#fixture-active-session").textContent(), newSession.id);
  assert.equal(await scroll.getByText("新会话唯一消息", { exact: true }).count(), 1);
  assert.equal(await scroll.getByText("旧会话消息 7", { exact: true }).count(), 0, "late old-session history must not populate the new chat");
  assert.equal(await page.locator("[data-minimap-node-index]").count(), 1, "late old history must not change new navigation");
  assert.equal(await page.locator('[data-history-load-state="loading"]').count(), 0, "late old history must not leave a loading state");
  assert.equal(await navigationStatus.getAttribute("aria-label"), newSessionStatus, "late old history must not alter the new navigation status");
  assert.equal(await navigationStatus.isDisabled(), true);
  assert.equal(newSession.pageRequests.length, 0);
  await captureScenario(page, {
    scenario: "switch-session-with-pending-page",
    width: 980,
    oldSessionRequests: records(oldSession),
    newSessionRequests: records(newSession),
    newSessionNodes: 1,
    oldResponseReleased: true,
    oldPayloadVisible: false,
    loadingStatus: false,
    newSessionStatus,
  });
  await context.close();
}

async function collectFailureDiagnostics(error) {
  const openPages = [];
  for (const [page, metadata] of trackedPages) {
    if (page.isClosed()) continue;
    let pageState;
    try {
      pageState = await page.evaluate(() => {
        const historyGetter = window.__PI_ENH_GET_HISTORY_STATE__;
        let historyBridge = null;
        let historyBridgeError = null;
        if (typeof historyGetter === "function") {
          try {
            historyBridge = historyGetter();
          } catch (bridgeError) {
            historyBridgeError = String(bridgeError?.stack || bridgeError);
          }
        }
        return {
          url: location.href,
          activeSession: document.querySelector("#fixture-active-session")?.textContent ?? null,
          historyBridgeAvailable: typeof historyGetter === "function",
          historyBridge,
          historyBridgeError,
          minimapNodeCount: document.querySelectorAll("[data-minimap-node-index]").length,
          minimapPreviewUserCount: document.querySelectorAll("[data-minimap-preview-user]").length,
          sentinelStates: [...document.querySelectorAll("[data-history-load-state]")].map((element) => ({
            state: element.getAttribute("data-history-load-state"),
            text: element.innerText?.trim() ?? "",
            disabled: element.disabled ?? null,
            ariaBusy: element.getAttribute("aria-busy"),
          })),
          minimapButtons: [...document.querySelectorAll("[data-pi-enh-minimap-load-earlier]")].map((element) => ({
            text: element.innerText?.trim() ?? "",
            ariaLabel: element.getAttribute("aria-label"),
            disabled: element.disabled ?? null,
            className: typeof element.className === "string" ? element.className : "",
          })),
          partialDomText: (document.body?.innerText ?? "").slice(0, 2400),
        };
      });
    } catch (diagnosticError) {
      pageState = { diagnosticError: String(diagnosticError?.stack || diagnosticError) };
    }
    openPages.push({ ...metadata, ...pageState });
  }

  return {
    status: "failed",
    scenario: activeScenario,
    error: { name: error?.name ?? "Error", message: error?.message ?? String(error), stack: error?.stack ?? null },
    allPageRequests: allPageRequests.map(({ sessionId, before, tail }) => ({ sessionId, before, tail })),
    pageErrors: [...pageErrors],
    completedScenarios: receipts,
    openPages,
  };
}

let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });

  const scenarioRunners = baseline
    ? {
        "baseline-desktop": () => runBaselineDesktop(browser, origin),
        "baseline-phone-closed": () => runBaselinePhone(browser, origin),
      }
    : {
        "desktop-bounded-prefetch": () => runDesktopBoundedPrefetch(browser, origin),
        "phone-closed-then-open": () => runPhoneOpenLoad(browser, origin),
        "already-loaded-and-anchor": () => runAlreadyLoadedAndScrollAnchor(browser, origin),
        "short-history-terminal": () => runShortHistory(browser, origin),
        "failed-then-explicit-retry": () => runFailureAndExplicitRetry(browser, origin),
        "switch-session-with-pending-page": () => runSessionSwitchWhilePending(browser, origin),
      };
  const requestedScenarios = process.env.HISTORY_SCENARIOS
    ? process.env.HISTORY_SCENARIOS.split(",").map((name) => name.trim()).filter(Boolean)
    : Object.keys(scenarioRunners);
  const unknownScenarios = requestedScenarios.filter((name) => !scenarioRunners[name]);
  assert.deepEqual(unknownScenarios, [], `unknown HISTORY_SCENARIOS value(s); choose from ${Object.keys(scenarioRunners).join(", ")}`);
  assert.ok(requestedScenarios.length > 0, "HISTORY_SCENARIOS must name at least one scenario");

  for (const scenario of requestedScenarios) {
    activeScenario = scenario;
    await scenarioRunners[scenario]();
  }

  assert.deepEqual(pageErrors, [], "native ChatWindow fixture must not raise browser exceptions");
  assert.deepEqual(externalRequests, [], "the fixture must not contact external services");
  const output = {
    status: "passed",
    sourceRoot,
    baseline,
    selectedScenarios: requestedScenarios,
    scenarios: receipts,
    pageRequests: allPageRequests.map(({ sessionId, before, tail }) => ({ sessionId, before, tail })),
    pageErrors,
    externalRequests,
    actualServerWrites: 0,
  };
  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  try {
    console.error(JSON.stringify(await collectFailureDiagnostics(error), null, 2));
  } catch (diagnosticError) {
    console.error(JSON.stringify({
      status: "failed",
      scenario: activeScenario,
      error: String(error?.stack || error),
      diagnosticsError: String(diagnosticError?.stack || diagnosticError),
      allPageRequests: allPageRequests.map(({ sessionId, before, tail }) => ({ sessionId, before, tail })),
      pageErrors,
    }, null, 2));
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
