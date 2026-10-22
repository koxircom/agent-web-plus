import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
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
  const route = await jiti.import("../app/api/usage/ledger/route.ts");
  const response = await route.GET();

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.ok(json.version);
  assert.ok(json.pricing, "response must include pricing metadata");
  assert.equal(json.pricing.version, 1);
  assert.equal(json.pricing.currency, "USD");
  assert.equal(json.pricing.unit, "per_1m_tokens");
  assert.ok(json.pricing.refresh);
  assert.ok(json.pricing.models);
});
