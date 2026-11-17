"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const modules = path.join(__dirname, "../modules");
const source = n => fs.readFileSync(path.join(modules, n), "utf8");
function extract(text, name) {
  const ast = ts.createSourceFile("fixture.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      assert.equal(found, undefined, `duplicate function: ${name}`);
      found = node.getText(ast);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `missing function: ${name}`);
  return found;
}
const settings = source("02-plugin-registry-and-settings-schema.js");
const cache = source("03-session-cache-and-sync-engine.js");
const errorSource = extract(settings, "sessionDeleteError");
const deleteSource = extract(settings, "deleteArchivedSession");
const confirmSource = extract(cache, "isConfirmedSessionDeleteResponse");
const wrapperSource = extract(cache, "cachedSessionFetch");
const guardSource = extract(cache, "ensureSessionIngestedBeforeDelete");
const backgroundSource = extract(cache, "backgroundSealSessionUsage");
const piId = "00000000-0000-7000-8000-000000000001";
const codexId = "codex:00000000-0000-7000-8000-000000000002";
const response = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});
function fixture(enabled, id, result) {
  const events = [], calls = [];
  const context = {
    Response, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    window: {}, console,
    originalWindowFetch: null,
    baseFetch: async (url, init) => {
      calls.push({ url, method: init?.method || "GET" });
      // A slow background ledger must not block the existing foreground contract.
      if (url === "/api/usage/ledger") return new Promise(() => {});
      return result;
    },
    isPluginEnabled: () => enabled,
    extractSessionIdFromUrl: () => id,
    markSessionAsDeleted: () => events.push("pending"),
    restoreSessionDeleteState: () => events.push("restore"),
    markSessionDeleteConfirmed: () => events.push("confirmed"),
    cleanupDeletedSessionEverywhere: () => events.push("cleanup"),
    scheduleSessionUploadCleanup: () => events.push("attachments"),
  };
  vm.createContext(context);
  vm.runInContext([backgroundSource, guardSource, confirmSource, wrapperSource].join("\n"), context);
  return { context, events, calls, run: () => context.cachedSessionFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }) };
}
for (const enabled of [true, false]) {
  for (const [name, status, body] of [
    ["404", 404, { error: "not found" }],
    ["missing acknowledgement", 200, {}],
    ["negative acknowledgement", 200, { ok: false }],
    ["string acknowledgement", 200, { ok: "true" }],
    ["empty success", 204, undefined],
    ["failure with misleading body", 409, { ok: true }],
  ]) test(`Codex ${name} keeps state (cache ${enabled})`, async () => {
    const f = fixture(enabled, codexId, response(status, body));
    const returned = await f.run();
    assert.equal(returned.status, status);
    assert.equal(returned.bodyUsed, false);
    assert.ok(f.events.includes("restore"));
    assert.ok(!f.events.some(x => ["confirmed", "cleanup", "attachments"].includes(x)));
    assert.ok(!f.calls.some(x => x.url.startsWith("/api/sessions?") || x.method === "GET"));
  });
  test(`Codex explicit acknowledgement cleans state without consuming body (cache ${enabled})`, async () => {
    const f = fixture(enabled, codexId, response(200, { ok: true }));
    const returned = await f.run();
    assert.ok(f.events.includes("confirmed") && f.events.includes("cleanup") && f.events.includes("attachments"));
    assert.deepEqual(await returned.json(), { ok: true });
  });
  for (const status of [200, 204, 404]) test(`Pi ${status} keeps its idempotent deletion contract (cache ${enabled})`, async () => {
    const f = fixture(enabled, piId, response(status, status === 204 ? undefined : { ok: true }));
    await f.run();
    assert.ok(f.events.includes("confirmed"));
    assert.ok(!f.calls.some(x => x.url.startsWith("/api/sessions?")));
  });
}
test("malformed Codex JSON cannot confirm deletion", async () => {
  const f = fixture(true, codexId, new Response("not-json", { status: 200 }));
  await f.run();
  assert.ok(f.events.includes("restore"));
  assert.ok(!f.events.includes("confirmed"));
});
function deletion(id, result) {
  const events = [];
  const context = {
    fetch: async () => result, window: {}, URLSearchParams,
    markSessionAsDeleted: () => events.push("pending"),
    restoreSessionDeleteState: () => events.push("restore"),
    markSessionDeleteConfirmed: () => events.push("confirmed"),
    cleanupDeletedSessionEverywhere: () => events.push("cleanup"),
    requestSessionListRefresh: () => {},
  };
  vm.createContext(context); vm.runInContext(errorSource + "\n" + deleteSource, context);
  return { events, run: () => context.deleteArchivedSession(id) };
}
for (const id of [piId, codexId]) test(`backend failure preserves bounded reason, HTTP status and safe code: ${id.split(":")[0]}`, async () => {
  const f = deletion(id, response(409, { error: "child is active", code: "SESSION_ACTIVE" }));
  await assert.rejects(f.run(), error => error.message === "HTTP 409 [SESSION_ACTIVE]: child is active" && error.status === 409 && error.code === "SESSION_ACTIVE");
  assert.ok(!f.events.includes("confirmed"));
});
test("long server messages and markup codes are bounded", async () => {
  const f = deletion(piId, response(500, { error: "x".repeat(1000), code: "<img>" }));
  await assert.rejects(f.run(), error => error.message.length === 610 && !error.message.includes("<img>"));
});
test("non-JSON error still reports HTTP status", async () => {
  await assert.rejects(deletion(piId, new Response("gateway", { status: 502 })).run(), /HTTP 502/);
});
test("Codex caller still refuses a missing acknowledgement", async () => {
  const f = deletion(codexId, response(200, {}));
  await assert.rejects(f.run(), /HTTP 200/);
  assert.ok(!f.events.includes("cleanup"));
});
test("fast deletion toast escapes server-controlled markup", async () => {
  const toasts = [];
  const context = { window: {}, sessionDeleteIcon: "icon", markSessionAsDeleted() {}, restoreSessionDeleteState() {}, requestSessionListRefresh() {},
    deleteArchivedSession: async () => { throw Error('<img src=x onerror="boom()">'); },
    showToast: text => toasts.push(text),
    escapeHtml: text => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  };
  vm.createContext(context); vm.runInContext(extract(source("04-sidebar-and-session-management.js"), "beginFastSessionDelete"), context);
  context.beginFastSessionDelete(piId);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(toasts.some(text => text.includes("&lt;img")));
  assert.ok(toasts.every(text => !text.includes("<img")));
});
test("archived deletion failure toast escapes the same backend message", () => {
  assert.ok(source("08-settings-panels-and-lifecycle.js").includes('showToast(escapeHtml(err?.message || "删除会话未确认，已保留状态"), undefined, 3500)'));
});
