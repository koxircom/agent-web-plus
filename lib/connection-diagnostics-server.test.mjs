import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeConnectionDiagnostic, connectionFailureReason, CONNECTION_TRACE_HEADER } from "./connection-diagnostics.ts";
import { appendConnectionDiagnostic, connectionLogPath, readConnectionDiagnostics, withConnectionDiagnostics, currentConnectionDiagnosticContext, CONNECTION_LOG_MAX_BYTES } from "./connection-diagnostics-server.ts";

const root = mkdtempSync(join(tmpdir(), "connection-log-test-"));
const previousDir = process.env.PI_WEB_DIAGNOSTICS_DIR;
function setup() { process.env.PI_WEB_DIAGNOSTICS_DIR = mkdtempSync(join(root, "case-")); }
function event(overrides = {}) { return { version: 1, at: new Date().toISOString(), source: "browser", event: "failure", operation: "history_read", reason: "request_timeout", traceId: randomUUID(), route: "/api/sessions/codex%3A77777777-7777-4777-8777-777777777777/context?before=LEAK_CURSOR", status: 504, ...overrides }; }
after(() => { if (previousDir === undefined) delete process.env.PI_WEB_DIAGNOSTICS_DIR; else process.env.PI_WEB_DIAGNOSTICS_DIR = previousDir; rmSync(root, { recursive: true, force: true }); });

test("allowlist drops raw errors, response content, credentials, queries and arbitrary identifiers", () => {
  setup();
  const raw = event({ message: "LEAK_MESSAGE", body: "LEAK_BODY", cookie: "LEAK_COOKIE", errorCode: "LEAK_CODE", errorName: "LEAK_ERROR", sessionId: "LEAK_SESSION", headers: { Authorization: "LEAK_AUTH" } });
  assert.equal(appendConnectionDiagnostic(raw), true);
  const text = readFileSync(connectionLogPath(), "utf8");
  assert.doesNotMatch(text, /LEAK_/);
  assert.equal(readConnectionDiagnostics()[0].route, "/api/sessions/:id/context");
  assert.equal(readConnectionDiagnostics()[0].status, 504);
  assert.equal(sanitizeConnectionDiagnostic(event({ traceId: "LEAK_ID" })), null);
  assert.equal(sanitizeConnectionDiagnostic(event({ at: "bad date" })), null);
  if (process.platform !== "win32") assert.equal(statSync(connectionLogPath()).mode & 0o777, 0o600);
});

test("unchanged errors coalesce but changed reason and recovery are retained", () => {
  setup();
  const first = event(); assert.equal(appendConnectionDiagnostic(first), true);
  assert.equal(appendConnectionDiagnostic({ ...first, traceId: randomUUID() }), true);
  assert.equal(readConnectionDiagnostics().length, 1);
  appendConnectionDiagnostic({ ...first, reason: "network_error", traceId: randomUUID() });
  appendConnectionDiagnostic({ ...first, event: "recovered", reason: "recovered", attempts: 3, outageMs: 1234, traceId: randomUUID() });
  const rows = readConnectionDiagnostics();
  assert.equal(rows.length, 3);
  assert.equal(rows[1].suppressed, 1);
  assert.equal(rows[2].attempts, 3);
  assert.equal(rows[2].outageMs, 1234);
});

test("write failure is not falsely acknowledged by the dedupe cache", () => {
  setup(); const dir = process.env.PI_WEB_DIAGNOSTICS_DIR;
  rmSync(dir, { recursive: true }); writeFileSync(dir, "not a directory");
  const row = event();
  assert.equal(appendConnectionDiagnostic(row), false);
  assert.equal(appendConnectionDiagnostic(row), false);
  rmSync(dir); assert.equal(appendConnectionDiagnostic(row), true);
  assert.equal(readConnectionDiagnostics().length, 1);
});

test("rotation is bounded to current file and two archives", () => {
  setup(); appendConnectionDiagnostic(event());
  for (let i = 0; i < 4; i++) {
    writeFileSync(connectionLogPath(), "x".repeat(CONNECTION_LOG_MAX_BYTES));
    appendConnectionDiagnostic(event({ status: 500 + i, reason: "http_error" }));
  }
  const files = readdirSync(process.env.PI_WEB_DIAGNOSTICS_DIR);
  assert.equal(files.length, 3);
  assert.ok(files.every(file => statSync(join(process.env.PI_WEB_DIAGNOSTICS_DIR, file)).size <= CONNECTION_LOG_MAX_BYTES));
  assert.ok(readConnectionDiagnostics().length >= 1);
});

test("request contexts remain isolated and preserve response bodies and trace IDs", async () => {
  setup();
  const ids = [randomUUID(), randomUUID()];
  const results = await Promise.all(ids.map(async (id, index) => {
    const request = new Request(`http://127.0.0.1/api/sessions/77777777-7777-4777-8777-77777777777${index}/context?before=LEAK_BOUNDARY`, { headers: { [CONNECTION_TRACE_HEADER]: id } });
    const response = await withConnectionDiagnostics(request, async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      assert.equal(currentConnectionDiagnosticContext().traceId, id);
      return Response.json({ error: "LEAK_RESPONSE" }, { status: 504 });
    });
    assert.equal(response.headers.get(CONNECTION_TRACE_HEADER), id);
    assert.deepEqual(await response.json(), { error: "LEAK_RESPONSE" });
    return response.status;
  }));
  assert.deepEqual(results, [504, 504]);
  const rows = readConnectionDiagnostics(); assert.deepEqual(new Set(rows.map(row => row.traceId)), new Set(ids));
  assert.doesNotMatch(readFileSync(connectionLogPath(), "utf8"), /LEAK_/);
});

test("successful reads are quiet and navigation abort preserves the original rejection", async () => {
  setup();
  await withConnectionDiagnostics(new Request("http://127.0.0.1/api/agent/running?engine=pi"), async () => Response.json({ ok: true }));
  assert.equal(readConnectionDiagnostics().length, 0);
  const controller = new AbortController(); controller.abort();
  const expected = new Error("LEAK_ABORT");
  await assert.rejects(withConnectionDiagnostics(new Request("http://127.0.0.1/api/agent/running", { signal: controller.signal }), async () => { throw expected; }), error => error === expected);
  assert.equal(readConnectionDiagnostics().length, 0);
});

test("classifies distinct transport failures without reading their message", () => {
  assert.equal(connectionFailureReason(new Error("secret"), 401), "authentication_required");
  assert.equal(connectionFailureReason(null, 403), "access_denied");
  assert.equal(connectionFailureReason(null, 429), "rate_limited");
  assert.equal(connectionFailureReason(null, 504), "request_timeout");
  assert.equal(connectionFailureReason(new TypeError("secret", { cause: { code: "ECONNREFUSED" } })), "connection_refused");
  assert.equal(connectionFailureReason(new TypeError("secret", { cause: { code: "ENOTFOUND" } })), "dns_error");
  assert.equal(connectionFailureReason(new SyntaxError("secret")), "invalid_response");
});
