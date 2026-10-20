import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

const source = ts.createSourceFile(
  "useAgentSession.ts",
  await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const nodes = [];
function visit(node) {
  nodes.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
const loader = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "loadModels");
const schedule = nodes.find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === "MODELS_RETRY_DELAYS_MS");
const effect = nodes.find((node) => ts.isCallExpression(node)
  && node.expression.getText(source) === "useEffect"
  && node.arguments[1]?.getText(source) === "[loadModels, modelsRefreshKey]");
const retry = effect.arguments[0].body.statements.find((node) => ts.isExpressionStatement(node) && node.getText(source).startsWith("(async")).expression;
function script(text) {
  return new Script(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText);
}
const loadScript = script(`(${loader.initializer.arguments[0].getText(source)})`);
const retryScript = script(retry.getText(source));

function setup(fetchImpl) {
  const writes = [];
  const delays = [];
  const context = {
    Error, DOMException, AbortSignal, URLSearchParams,
    controller: new AbortController(),
    newSessionCwd: "/project", session: null, isNew: true,
    sessionIdRef: { current: null }, thinkingLevelOverrideRef: { current: null },
    thinkingLevelPinsRef: { current: {} }, defaultThinkingLevelRef: { current: null },
    asConcreteThinkingLevel: (value) => (!value || value === "auto" ? null : value),
    fetch: fetchImpl,
    MODELS_RETRY_DELAYS_MS: script(schedule.initializer.getText(source)).runInNewContext(),
    delay: async (ms) => { delays.push(ms); },
  };
  for (const name of ["ModelError", "ModelNames", "ModelScopeWarnings", "ModelThinkingLevels", "ModelThinkingLevelMaps", "ModelList", "NewSessionDefaultModel", "NewSessionDefaultThinkingLevel", "ModelsLoading"]) {
    context[`set${name}`] = (value) => writes.push([name, value]);
  }
  context.loadModels = loadScript.runInNewContext(context);
  return { context, writes, delays, run: () => retryScript.runInNewContext(context) };
}

test("model-load failures become visible only after bounded retries and clear on recovery", async () => {
  for (const [fetchImpl, expected] of [
    [async () => { throw new TypeError("Failed to fetch"); }, "Failed to fetch"],
    [async () => Response.json({ error: "Access denied" }, { status: 403 }), "Access denied"],
    [async () => new Response("Unavailable", { status: 503 }), "暂时无法获取模型（HTTP 503），请稍后重试。"],
    [async () => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }), "Invalid JSON"],
  ]) {
    const state = setup(fetchImpl);
    await state.run();
    assert.deepEqual(state.delays, [2_000, 5_000, 10_000]);
    assert.deepEqual(state.writes, [["ModelError", "暂时无法获取模型，请稍后重试。"], ["ModelsLoading", false]]);
  }

  let attempts = 0;
  const recovered = setup(async () => {
    if (++attempts === 1) throw new TypeError("Failed to fetch");
    return Response.json({
      models: { "custom:test": "Test" },
      modelList: [{ provider: "custom", id: "test", name: "Test" }],
      defaultModel: { provider: "custom", modelId: "test" },
      thinkingLevelPins: { "custom/test": "high" },
    });
  });
  await recovered.run();
  assert.equal(attempts, 2);
  assert.deepEqual(recovered.delays, [2_000]);
  assert.deepEqual(recovered.writes.filter(([name]) => name === "ModelError"), [["ModelError", null]]);
  assert.ok(recovered.writes.some(([name, value]) => name === "ModelList" && value[0].id === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultModel" && value.modelId === "test"));
  assert.ok(recovered.writes.some(([name, value]) => name === "NewSessionDefaultThinkingLevel" && value === "high"));
});

test("cancelling model loads prevents state writes and further retries", async () => {
  for (const status of [200, 403]) {
    const reading = Promise.withResolvers();
    const state = setup(async (_url, { signal }) => ({
      ok: status === 200, status,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        reading.resolve();
      }),
    }));
    const completed = state.run();
    await reading.promise;
    state.context.controller.abort();
    await completed;
    assert.deepEqual(state.writes, []);
    assert.deepEqual(state.delays, []);
  }

  const late = setup(async (_url, { signal }) => ({
    ok: true,
    json: async () => {
      late.context.controller.abort();
      assert.equal(signal.aborted, true);
      return { models: {}, modelList: [] };
    },
  }));
  await late.run();
  assert.deepEqual(late.writes, []);

  let attempts = 0;
  const waiting = setup(async () => { attempts++; throw new TypeError("Failed to fetch"); });
  waiting.context.delay = async () => waiting.context.controller.abort();
  await waiting.run();
  assert.equal(attempts, 1);
});

 test("an HTTP 200 empty error catalog retries without erasing usable state", async () => {
  let attempts = 0;
  const state = setup(async () => ++attempts === 1
    ? Response.json({ models: {}, modelList: [], modelError: "temporary failure" })
    : Response.json({ models: { "custom:test": "Test" }, modelList: [{ id: "test", provider: "custom", name: "Test" }] }));
  await state.run();
  assert.equal(attempts, 2);
  assert.deepEqual(state.delays, [2000]);
  assert.equal(state.writes.filter(([name]) => name === "ModelList").length, 1);
  assert.deepEqual(state.writes.filter(([name]) => name === "ModelError"), [["ModelError", null]]);
});

 test("a stalled model request times out and follows the bounded recovery path", async () => {
  let attempts = 0;
  const state = setup(async (_url, { signal }) => {
    attempts++;
    signal.throwIfAborted();
  });
  state.context.AbortSignal = { ...AbortSignal, any: AbortSignal.any, timeout: () => AbortSignal.abort(new DOMException("Timed out", "TimeoutError")) };
  await state.run();
  assert.equal(attempts, 4);
  assert.deepEqual(state.delays, [2000, 5000, 10000]);
  assert.equal(state.writes.filter(([name]) => name === "ModelList").length, 0);
});
