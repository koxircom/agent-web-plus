import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getNewSessionModelPreference: read, setNewSessionModelPreference: write } = await createJiti(import.meta.url).import("./new-session-model-preference.ts");
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const models = [{ provider: "codex", id: "model-a" }, { provider: "pi", id: "model-b" }];

test("each engine restores its own selected model and supported depth", () => {
  const data = storage();
  write("codex", { provider: "codex", modelId: "model-a", thinkingLevel: "xhigh" }, data);
  write("pi", { provider: "pi", modelId: "model-b", thinkingLevel: "low" }, data);
  assert.deepEqual(read("codex", models, { "codex:model-a": ["low", "high"] }, data),
    { provider: "codex", modelId: "model-a", thinkingLevel: "high" });
  assert.deepEqual(read("pi", models, { "pi:model-b": ["low", "high"] }, data),
    { provider: "pi", modelId: "model-b", thinkingLevel: "low" });
  assert.equal(read("codex", [], {}, data), null);
});

test("automatic depth and unavailable or malformed browser storage fail safely", () => {
  const data = storage();
  write("codex", { provider: "codex", modelId: "model-a", thinkingLevel: null }, data);
  assert.equal(read("codex", models, {}, data).thinkingLevel, null);
  data.setItem("pi-new-session-model-codex-v1", '{"provider":"codex","modelId":"model-a","thinkingLevel":"invalid"}');
  assert.equal(read("codex", models, {}, data), null);
  const denied = { getItem() { throw Error("denied"); }, setItem() { throw Error("denied"); } };
  assert.equal(read("codex", models, {}, denied), null);
  assert.doesNotThrow(() => write("codex", { provider: "codex", modelId: "model-a", thinkingLevel: "high" }, denied));
});
