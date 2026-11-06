import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "connection-log-bridge-"));
const original = { agentDir: process.env.PI_CODING_AGENT_DIR, logDir: process.env.PI_WEB_DIAGNOSTICS_DIR, fetch: globalThis.fetch };
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.PI_WEB_DIAGNOSTICS_DIR = join(root, "logs");
const jiti = createJiti(import.meta.url, { alias: { "server-only": "next/dist/compiled/server-only/empty.js" } });
const { saveExecutionEngineSettings } = await jiti.import("./execution-engine-settings.ts");
const { codexBridgeRequest } = await jiti.import("./execution-engines/codex-bridge-client.ts");
const { withConnectionDiagnostics, readConnectionDiagnostics, connectionLogPath } = await jiti.import("./connection-diagnostics-server.ts");
const connectionKey = Symbol.for("pi-web.codex-bridge-connection");
const previousConnection = globalThis[connectionKey];
after(() => {
  globalThis.fetch = original.fetch;
  if (previousConnection === undefined) delete globalThis[connectionKey]; else globalThis[connectionKey] = previousConnection;
  for (const [key, value] of [["PI_CODING_AGENT_DIR", original.agentDir], ["PI_WEB_DIAGNOSTICS_DIR", original.logDir]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

async function configure(handler) {
  delete globalThis[connectionKey];
  await saveExecutionEngineSettings({ defaultEngine: "codex", codex: { enabled: true, url: "http://127.0.0.1:19097", username: "test", password: "test-only" } });
  globalThis.fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/login") return new Response("{}", { headers: { "Set-Cookie": "sid=LEAK_COOKIE" } });
    if (path === "/api/auth") return Response.json({ authenticated: true, csrf: "LEAK_CSRF" });
    return handler(url, options);
  };
}

test("one trace correlates browser route and upstream timeout while all sensitive fields are absent", async () => {
  const traceId = randomUUID();
  await configure(async (_url, options) => {
    assert.equal(options.headers["X-Agent-Web-Trace-ID"], traceId);
    return Response.json({ error: "LEAK_REMOTE_BODY" }, { status: 504 });
  });
  const request = new Request("http://localhost/api/sessions/codex%3A77777777-7777-4777-8777-777777777777/context?before=LEAK_FRONT_CURSOR", { headers: { "X-Agent-Web-Trace-ID": traceId } });
  await assert.rejects(withConnectionDiagnostics(request, () => codexBridgeRequest("/api/sessions/local/77777777-7777-4777-8777-777777777777/messages?before=LEAK_UPSTREAM_CURSOR")), error => error.status === 504);
  const records = readConnectionDiagnostics().filter(row => row.traceId === traceId);
  assert.ok(records.some(row => row.source === "bridge" && row.status === 504 && row.reason === "request_timeout"));
  assert.ok(records.some(row => row.source === "server" && row.status === 504));
  assert.doesNotMatch(readFileSync(connectionLogPath(), "utf8"), /LEAK_|test-only/);
});

test("upstream transport cause survives bridge error translation as a precise safe code", async () => {
  const traceId = randomUUID();
  await configure(async () => { throw new TypeError("LEAK_NETWORK_TEXT", { cause: { code: "ECONNREFUSED" } }); });
  const request = new Request("http://localhost/api/agent/running?engine=codex", { headers: { "X-Agent-Web-Trace-ID": traceId } });
  await assert.rejects(withConnectionDiagnostics(request, () => codexBridgeRequest("/api/activity")), error => error.status === 502);
  const record = readConnectionDiagnostics().find(row => row.traceId === traceId && row.source === "bridge");
  assert.equal(record.reason, "connection_refused"); assert.equal(record.errorCode, "ECONNREFUSED");
  assert.doesNotMatch(readFileSync(connectionLogPath(), "utf8"), /LEAK_|test-only/);
});
