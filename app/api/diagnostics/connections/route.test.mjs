import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "connection-log-route-"));
const oldDir = process.env.PI_WEB_DIAGNOSTICS_DIR;
const oldPassword = process.env.PI_WEB_PASSWORD;
process.env.PI_WEB_DIAGNOSTICS_DIR = root;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { GET, POST } = await jiti.import("./route.ts");
const { proxy } = await jiti.import("../../../../proxy.ts");
const { createWebSessionToken } = await jiti.import("../../../../lib/web-auth.ts");
after(() => { if (oldDir === undefined) delete process.env.PI_WEB_DIAGNOSTICS_DIR; else process.env.PI_WEB_DIAGNOSTICS_DIR = oldDir;
  if (oldPassword === undefined) delete process.env.PI_WEB_PASSWORD; else process.env.PI_WEB_PASSWORD = oldPassword;
  rmSync(root, { recursive: true, force: true }); });

const entry = () => ({ version: 1, at: new Date().toISOString(), source: "browser", event: "failure", operation: "status_poll", reason: "request_timeout", traceId: randomUUID(), route: "/api/agent/running?engine=codex&secret=LEAK_QUERY", engine: "codex", status: 504 });
function request(body, headers = {}) { return new Request("http://localhost/api/diagnostics/connections", { method: "POST", headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }); }

test("valid browser records are persisted and downloadable without arbitrary payload fields", async () => {
  const record = entry(); record.body = "LEAK_BODY";
  const response = await POST(request({ events: [record] }));
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: 1 });
  const exportResponse = await GET(new Request("http://localhost/api/diagnostics/connections?download=1"));
  assert.match(exportResponse.headers.get("Content-Disposition"), /^attachment;/);
  const body = await exportResponse.text(); assert.doesNotMatch(body, /LEAK_/);
  const data = JSON.parse(body); assert.equal(data.events[0].traceId, record.traceId);
});

test("rejects cross-site writes, server impersonation, malformed batches and oversized streaming bodies", async () => {
  assert.equal((await POST(request({ events: [entry()] }, { Origin: "https://evil.invalid", "Sec-Fetch-Site": "cross-site" }))).status, 403);
  assert.equal((await POST(request({ events: [{ ...entry(), source: "server" }] }))).status, 400);
  assert.equal((await POST(request({ events: [{ ...entry(), event: "lifecycle", reason: "service_start" }] }))).status, 400);
  assert.equal((await POST(request({ events: Array.from({ length: 21 }, entry) }))).status, 400);
  assert.equal((await POST(request("{"))).status, 400);
  assert.equal((await POST(request("x".repeat(64 * 1024 + 1)))).status, 413);
});

test("diagnostic export stays behind existing authentication and expiry is recorded without cookie contents", async () => {
  process.env.PI_WEB_PASSWORD = "diagnostic-test-password";
  const response = proxy(new NextRequest("http://localhost/api/diagnostics/connections?download=1", { headers: { Host: "localhost" } }));
  assert.equal(response.status, 401);
  const token = createWebSessionToken(process.env.PI_WEB_PASSWORD, 0);
  const traceId = randomUUID();
  const rejected = proxy(new NextRequest("http://localhost/api/agent/running?engine=codex", { headers: { Host: "localhost", Cookie: `pi_web_session=${token}`, "X-Agent-Web-Trace-ID": traceId } }));
  assert.equal(rejected.status, 401);
  const log = await (await GET(new Request("http://localhost/api/diagnostics/connections"))).json();
  assert.ok(log.events.some(row => row.traceId === traceId && row.reason === "authentication_expired"));
  assert.ok(!JSON.stringify(log).includes(token));
  assert.ok(!JSON.stringify(log).includes(process.env.PI_WEB_PASSWORD));
});
