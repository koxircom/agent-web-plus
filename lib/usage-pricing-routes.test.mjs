import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { gunzipSync } from "node:zlib";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

// 必须在导入 owner 前硬性临时 mkdtemp 创建独立子沙箱，确保哪怕外部已有 test env 也绝不 touch 真实既有 ledger
const tempSandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-pricing-routes-sandbox-"));
const sandboxHome = path.join(tempSandbox, "home");
const sandboxAgentDir = path.join(sandboxHome, ".pi", "agent");
const sandboxSessionsDir = path.join(sandboxAgentDir, "sessions");
const sandboxScriptsDir = path.join(sandboxAgentDir, "scripts");

fs.mkdirSync(sandboxSessionsDir, { recursive: true });
fs.mkdirSync(sandboxScriptsDir, { recursive: true });

const source = process.platform === "win32" ? "windows" : "nas";
const fixtureLedgerPath = path.join(sandboxScriptsDir, `pi-usage-ledger-${source}.json`);
const fixtureLedgerContent = JSON.stringify({
  version: 2,
  generatedAt: "2026-10-01T00:00:00.000Z",
  snapshotId: "fixture-snapshot-id",
  buckets: [],
});
fs.writeFileSync(fixtureLedgerPath, fixtureLedgerContent);

// 保存旧环境与 globalThis 单例以便后续精确恢复
const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_AGENT_DIR: process.env.PI_AGENT_DIR,
  PI_SESSIONS_DIR: process.env.PI_SESSIONS_DIR,
  PI_USAGE_DATA_DIR: process.env.PI_USAGE_DATA_DIR,
};
const serviceKey = Symbol.for("pi-web.usage-ledger-service");
const originalService = globalThis[serviceKey];
const originalPricingManager = globalThis.__piDefaultUsagePricingManager;

// 导入 owner 前硬性设置沙箱环境变量，消除原有单例污染
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.PI_CODING_AGENT_DIR = sandboxAgentDir;
process.env.PI_AGENT_DIR = sandboxAgentDir;
process.env.PI_SESSIONS_DIR = sandboxSessionsDir;
delete process.env.PI_USAGE_DATA_DIR;
delete globalThis[serviceKey];
delete globalThis.__piDefaultUsagePricingManager;

// 在沙箱生效后创建 jiti 导入 owner，保证 @ 精确解析到 agent-web-plus 根目录
const jiti = createJiti(import.meta.url, {
  alias: { "@": projectRoot },
  interopDefault: true,
  moduleCache: false,
});

test.after(() => {
  for (const [key, val] of Object.entries(originalEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  if (originalService === undefined) {
    delete globalThis[serviceKey];
  } else {
    globalThis[serviceKey] = originalService;
  }
  if (originalPricingManager === undefined) {
    delete globalThis.__piDefaultUsagePricingManager;
  } else {
    globalThis.__piDefaultUsagePricingManager = originalPricingManager;
  }
  try {
    fs.rmSync(tempSandbox, { recursive: true, force: true });
  } catch {}
});

test("GET /api/usage/pricing route returns standard pricing snapshot contract", async () => {
  const route = await jiti.import("../app/api/usage/pricing/route.ts");
  const response = await route.GET();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const json = await response.json();
  assert.equal(json.version, 1);
  assert.equal(json.currency, "USD");
  assert.equal(json.unit, "per_1m_tokens");
  assert.ok(json.refresh && typeof json.refresh === "object");
  assert.ok(["current", "cached", "refreshing", "error", "offline"].includes(json.refresh.state));
  assert.ok(json.models && typeof json.models === "object");

  for (const [id, model] of Object.entries(json.models)) {
    assert.equal(model.modelId, id);
    assert.equal(model.provider, "openai-codex");
    assert.ok(typeof model.input === "number" && Number.isFinite(model.input) && model.input >= 0);
    assert.ok(typeof model.output === "number" && Number.isFinite(model.output) && model.output >= 0);
    assert.ok(typeof model.cacheRead === "number" && Number.isFinite(model.cacheRead) && model.cacheRead >= 0);
    assert.ok(typeof model.cacheWrite === "number" && Number.isFinite(model.cacheWrite) && model.cacheWrite >= 0);
    assert.ok(["pi-sdk", "manual", "fallback"].includes(model.source));
    assert.equal(typeof model.tiered, "boolean");
  }
});

test("GET /api/usage/ledger route includes pricing metadata without mutating ledger storage", async () => {
  const beforeContent = fs.readFileSync(fixtureLedgerPath, "utf8");

  const route = await jiti.import("../app/api/usage/ledger/route.ts");
  const response = await route.GET();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const json = await response.json();
  assert.equal(json.version, 2);
  assert.ok(json.pricing, "response must include pricing metadata");
  assert.equal(json.pricing.version, 1);
  assert.equal(json.pricing.currency, "USD");
  assert.equal(json.pricing.unit, "per_1m_tokens");
  assert.ok(json.pricing.refresh);
  assert.ok(json.pricing.models);

  const afterContent = fs.readFileSync(fixtureLedgerPath, "utf8");
  assert.equal(afterContent, beforeContent, "ledger storage must not be mutated");
});

test("usage snapshots negotiate gzip without changing JSON data or forcing unsupported clients", async () => {
  const route = await jiti.import("../app/api/usage/ledger/route.ts");
  const compressed = await route.GET(new Request("http://localhost/api/usage/ledger", {headers:{"Accept-Encoding":"br, GZip; q=0.8"}}));
  assert.equal(compressed.headers.get("Content-Encoding"),"gzip");
  assert.equal(compressed.headers.get("Vary"),"Accept-Encoding");
  const data=JSON.parse(gunzipSync(Buffer.from(await compressed.arrayBuffer())).toString());
  assert.equal(data.version,2);assert.ok(data.pricing);assert.ok(Array.isArray(data.buckets));
  const plain=await route.GET(new Request("http://localhost/api/usage/ledger", {headers:{"Accept-Encoding":"br, gzip;q=0"}}));
  assert.equal(plain.headers.get("Content-Encoding"),null);
  const normal=await plain.json();assert.equal(normal.version,data.version);assert.deepEqual(normal.totals,data.totals);assert.deepEqual(normal.buckets,data.buckets);
});
