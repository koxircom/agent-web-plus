// Session search must reconcile cached result rows with the current catalogue.
// This fixture is local-only and also supports --baseline/SOURCE_ROOT runs.
import http from "node:http";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
const { chromium } = require(process.env.COMPOSER_PLAYWRIGHT_MODULE || "playwright");
const sourceRoot = process.env.SOURCE_ROOT || process.env.SESSION_SEARCH_SOURCE_ROOT
  || fileURLToPath(new URL("..", import.meta.url));
const baseline = process.argv.includes("--baseline") || process.env.SESSION_SEARCH_BASELINE === "1";

const currentTitle = "更新CLIProxyAPI 管理配置";
const staleTitle = "sub2api生成cliproxy Gemini账";
const sessions = {
  title: { id: "title-hit", path: "/fixture/title-hit.jsonl", cwd: "/fixture", name: currentTitle, created: "2026-10-13T00:00:00.000Z", modified: "2026-10-14T00:00:00.000Z", messageCount: 2, firstMessage: currentTitle },
  remove: { id: "remove-hit", path: "/fixture/remove-hit.jsonl", cwd: "/fixture", name: "可移除的 CLIProxy 记录", created: "2026-10-13T00:00:00.000Z", modified: "2026-10-14T00:00:01.000Z", messageCount: 2, firstMessage: "可移除的 CLIProxy 记录" },
  delete: { id: "delete-hit", path: "/fixture/delete-hit.jsonl", cwd: "/fixture", name: "点击前删除的 CLIProxy 记录", created: "2026-10-13T00:00:00.000Z", modified: "2026-10-14T00:00:02.000Z", messageCount: 2, firstMessage: "点击前删除的 CLIProxy 记录" },
  valid: { id: "valid-hit", path: "/fixture/valid-hit.jsonl", cwd: "/fixture", name: "有效 CLIProxy 记录", created: "2026-10-13T00:00:00.000Z", modified: "2026-10-14T00:00:03.000Z", messageCount: 2, firstMessage: "有效 CLIProxy 记录" },
};
const staleSession = { ...sessions.title, id: "stale-sub2api", name: staleTitle, firstMessage: staleTitle };
const staleResult = (session) => ({ session, blockIndex: 0, before: "", match: "clipro", after: " 配置" });
const resultFor = (name) => staleResult(name === "stale" ? staleSession : sessions[name]);

let scenario = "stale-extra";
let searchCalls = 0;
let lookupCalls = [];
let missingIds = new Set();
let heldSearches = [];
let server;

function json(res, value, status = 200) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "private, no-store");
  res.end(JSON.stringify(value));
}
function searchPayload(call) {
  if (scenario === "catalog-removal" && call > 1) return { results: [resultFor("title")], truncated: false };
  if (scenario === "catalog-removal") return { results: [resultFor("remove"), resultFor("title")], truncated: false };
  if (scenario === "delayed-old" && call > 1) return { results: [resultFor("title")], truncated: false };
  if (scenario === "delete-between") return { results: [resultFor("delete")], truncated: false };
  if (scenario === "valid-click") return { results: [resultFor("valid")], truncated: false };
  return { results: [resultFor("stale"), { ...resultFor("title"), session: { ...sessions.title, name: "旧缓存标题" } }], truncated: false };
}
function resetScenario(name) {
  scenario = name;
  searchCalls = 0;
  lookupCalls = [];
  missingIds = new Set();
  heldSearches = [];
}

const bundle = await build({
  stdin: { resolveDir: sourceRoot, loader: "tsx", contents: `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { I18nProvider } from "./hooks/useI18n";
    import { SessionSearch } from "./components/SessionSearch";
    const fixture = window.__SESSION_SEARCH_FIXTURE__;
    const rows = fixture.rows;
    function App() {
      const [catalog, setCatalog] = useState(fixture.catalog);
      const [selected, setSelected] = useState("");
      const [navigations, setNavigations] = useState(0);
      const [unavailable, setUnavailable] = useState([]);
      const removeCatalogRow = async () => { await fetch("/fixture/catalog-remove"); setCatalog((items) => items.filter((item) => item.id !== rows.removeId)); };
      const deleteBeforeClick = async () => { await fetch("/fixture/delete-before-click"); };
      return <I18nProvider><div>
        <button id="catalog-remove" type="button" onClick={removeCatalogRow}>catalog remove</button>
        <button id="delete-before-click" type="button" onClick={deleteBeforeClick}>delete before click</button>
        <output id="selected" data-value={selected}>{selected}</output>
        <output id="navigations" data-count={navigations}>{navigations}</output>
        <output id="unavailable" data-ids={unavailable.join(",")}>{unavailable.join(",")}</output>
        <SessionSearch open={true} query="clipro" sessions={catalog} selectedSessionId={selected}
          onUnavailableSession={(id) => setUnavailable((items) => [...items, id])}
          onSelectSession={(session) => { setSelected(session.id); setNavigations((count) => count + 1); }}>
          <div id="search-child" />
        </SessionSearch>
      </div></I18nProvider>;
    }
    createRoot(document.getElementById("root")).render(<App />);
  `}, bundle: true, format: "iife", write: false, alias: { "@": sourceRoot }, define: { "process.env.NODE_ENV": '"development"' },
});

server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/bundle.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); return; }
  if (url.pathname === "/fixture/catalog-remove") { json(res, { ok: true }); return; }
  if (url.pathname === "/fixture/delete-before-click") { missingIds.add("delete-hit"); json(res, { ok: true }); return; }
  if (url.pathname === "/fixture/release") { for (const pending of heldSearches.splice(0)) json(pending.res, pending.data); json(res, { ok: true }); return; }
  if (url.pathname === "/api/sessions/search") {
    searchCalls += 1;
    if (scenario === "delayed-old" && searchCalls === 1) { heldSearches.push({ res, data: searchPayload(searchCalls) }); return; }
    json(res, searchPayload(searchCalls)); return;
  }
  if (url.pathname.startsWith("/api/sessions/") && url.searchParams.get("lookup") === "1") {
    const id = decodeURIComponent(url.pathname.split("/").at(-1));
    lookupCalls.push(id);
    if (missingIds.has(id)) { json(res, { error: "Session not found" }, 404); return; }
    json(res, { sessionId: id, exists: true }); return;
  }
  if (url.pathname.startsWith("/api/sessions/")) { json(res, { error: "Session not found" }, 404); return; }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});

function catalogFor(name) {
  if (name === "catalog-removal" || name === "delayed-old") return [sessions.remove, sessions.title];
  if (name === "delete-between") return [sessions.delete];
  if (name === "valid-click") return [sessions.valid];
  return [sessions.title];
}
function fixtureFor(name) {
  return { rows: { removeId: "remove-hit" }, catalog: catalogFor(name) };
}
async function waitFor(page, predicate, message) { await page.waitForFunction(predicate, null, message); }

async function runScenario(browser, origin, name) {
  resetScenario(name);
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 980, height: 820 } });
  await context.addInitScript((fixture) => { window.__SESSION_SEARCH_FIXTURE__ = fixture; }, fixtureFor(name));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  if (name === "delayed-old") {
    await page.locator('#catalog-remove').waitFor();
    await assertEventually(() => searchCalls === 1);
  } else await page.locator('button[data-search-session-id]').first().waitFor({ state: "visible", timeout: 5000 });
  const ids = () => page.locator('button[data-search-session-id]').evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-search-session-id")));
  if (name === "stale-extra") {
    const currentIds = await ids();
    assert.deepEqual(currentIds, baseline ? ["stale-sub2api", "title-hit"] : ["title-hit"]);
    if (!baseline) assert.match(await page.locator('[data-search-session-id="title-hit"]').innerText(), /更新CLIProxyAPI 管理配置/);
  } else if (name === "catalog-removal") {
    assert.deepEqual(await ids(), ["remove-hit", "title-hit"]);
    await page.locator("#catalog-remove").click();
    if (!baseline) { await waitFor(page, () => document.querySelectorAll('button[data-search-session-id]').length === 1); assert.equal(searchCalls, 2); }
    else { assert.equal(searchCalls, 1); }
    assert.deepEqual(await ids(), baseline ? ["remove-hit", "title-hit"] : ["title-hit"]);
  } else if (name === "delete-between") {
    await page.locator("#delete-before-click").click();
    await page.locator('[data-search-session-id="delete-hit"]').click();
    if (baseline) { assert.equal(await page.locator("#navigations").getAttribute("data-count"), "1"); assert.deepEqual(lookupCalls, []); }
    else { await waitFor(page, () => document.querySelector("#unavailable")?.getAttribute("data-ids") === "delete-hit"); assert.equal(await page.locator("#navigations").getAttribute("data-count"), "0"); assert.deepEqual(lookupCalls, ["delete-hit"]); assert.equal(await page.locator("#unavailable").getAttribute("data-ids"), "delete-hit"); assert.ok(await page.locator('[role="status"]').count() > 0, "search remains open after a missing lookup"); }
  } else if (name === "valid-click") {
    await page.locator('[data-search-session-id="valid-hit"]').click();
    await waitFor(page, () => document.querySelector("#navigations")?.getAttribute("data-count") === "1");
    assert.equal(await page.locator("#selected").getAttribute("data-value"), "valid-hit");
    assert.deepEqual(lookupCalls, baseline ? [] : ["valid-hit"]);
  } else if (name === "delayed-old") {
    assert.equal(searchCalls, 1);
    await page.locator("#catalog-remove").click();
    if (!baseline) { await assertEventually(() => searchCalls >= 2); await page.locator('[data-search-session-id="title-hit"]').waitFor({ state: "visible" }); }
    await fetch(`${origin}/fixture/release`);
    await page.waitForTimeout(180);
    assert.deepEqual(await ids(), baseline ? ["stale-sub2api", "title-hit"] : ["title-hit"]);
  }
  assert.deepEqual(errors, [], `${name}: page errors`);
  const visibleIds = await ids();
  await context.close();
  return { name, baseline, searchCalls, lookupCalls: [...lookupCalls], visibleIds };
}

let browser;
async function assertEventually(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "expected server request did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.COMPOSER_CHROMIUM_PATH ? { executablePath: process.env.COMPOSER_CHROMIUM_PATH } : {}) });
  const results = [];
  for (const name of ["stale-extra", "catalog-removal", "delete-between", "valid-click", "delayed-old"]) results.push(await runScenario(browser, origin, name));
  console.log(JSON.stringify({ status: "passed", baseline, sourceRoot, scenarios: results }, null, 2));
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
