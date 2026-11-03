import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ModelsConfigReadError,
  ModelsConfigWriteError,
  normalizeModelsConfigCosts,
  readModelsConfig,
  writeModelsConfig,
} = await jiti.import("./models-config-store.ts");
const { invalidateModelsCache, loadModelsWithCache } = await jiti.import("./models-cache.ts");
const { buildSessionContext, getSessionEntries } = await jiti.import("./session-reader.ts");

function createTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-models-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    defaultThinkingLevel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
    thinkingLevelPins: {},
  };
}

function withCanonicalOverlay(base, revision = 1) {
  return {
    ...base,
    sessionTagsDefinitions: [],
    sessionTagMappings: {},
    sessionColors: {},
    sessionTagsRevision: revision,
    enhancementStateRevision: revision,
  };
}

test("saving models.json atomically invalidates the model-list cache", async (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [{ id: "acme-2" }],
      },
    },
  };
  let loads = 0;

  invalidateModelsCache();
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  writeModelsConfig(config, modelsPath);
  const reloaded = await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));

  assert.equal(loads, 2);
  assert.equal(reloaded.modelList[0].id, "load-2");
  assert.deepEqual(readModelsConfig(modelsPath), withCanonicalOverlay(config));
  assert.ok(readdirSync(join(root, "agent")).includes("models.json"));
  assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")), config);
  if (process.platform !== "win32") {
    assert.equal(statSync(modelsPath).mode & 0o777, 0o600);
  }
});

test("models.json reads accept the BOM, comments and trailing commas pi accepts", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  writeFileSync(modelsPath, `\uFEFF{
  // Hand-edited provider
  "providers": {
    "acme": {
      "baseUrl": "https://models.example.test/v1", // keeps the // inside strings
      "apiKey": "key,}",
      "models": [{ "id": "acme-2", }],
    },
  },
}
`);

  assert.deepEqual(readModelsConfig(modelsPath), {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        apiKey: "key,}",
        models: [{ id: "acme-2" }],
      },
    },
  });
});

test("an unreadable models.json is reported and never replaced by a save", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  const original = '{ "providers": { "acme": { "models": [ } } }';
  writeFileSync(modelsPath, original);

  assert.throws(() => readModelsConfig(modelsPath), ModelsConfigReadError);
  assert.throws(
    () => writeModelsConfig({ providers: { other: { models: [] } } }, modelsPath),
    ModelsConfigReadError,
  );
  assert.equal(readFileSync(modelsPath, "utf8"), original);

  writeFileSync(modelsPath, "[]");
  assert.throws(() => readModelsConfig(modelsPath), /expected a JSON object/);
});

test("models.json reads reject a missing providers object and never replace it", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  const original = JSON.stringify({ quickShortcuts: [{ id: "chat" }] });
  writeFileSync(modelsPath, original);

  assert.throws(() => readModelsConfig(modelsPath), ModelsConfigReadError);
  assert.throws(
    () => writeModelsConfig({ providers: {} }, modelsPath),
    ModelsConfigReadError,
  );
  assert.equal(readFileSync(modelsPath, "utf8"), original);
});

test("models.json writes reject a missing providers object without changing valid config", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  const original = { providers: { acme: { models: [{ id: "acme-1" }] } } };
  writeFileSync(modelsPath, JSON.stringify(original));

  assert.throws(
    () => writeModelsConfig({ quickShortcuts: [{ id: "chat" }] }, modelsPath),
    ModelsConfigWriteError,
  );
  assert.deepEqual(readModelsConfig(modelsPath), original);
});

test("an empty models.json reads as no providers and rejects write when canonical state init fails on empty disk", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");
  writeFileSync(modelsPath, "\n");

  assert.deepEqual(readModelsConfig(modelsPath), { providers: {} });
  // 不做写前 normalization，底座调用 ensure 报 invalid，防止潜在误抹
  assert.throws(
    () => writeModelsConfig({ providers: { acme: { models: [] } } }, modelsPath),
    /LEGACY_MODELS_INVALID/,
  );
  assert.equal(readFileSync(modelsPath, "utf8"), "\n");
});

test("a nonexistent models.json reads as no providers and can be saved over", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "models.json");

  assert.deepEqual(readModelsConfig(modelsPath), { providers: {} });
  writeModelsConfig({ providers: { acme: { models: [] } } }, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath), withCanonicalOverlay({ providers: { acme: { models: [] } } }));
});

test("models.json writes fill partial cost groups with zero and remove empty groups", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        models: [
          { id: "empty-cost", cost: {} },
          { id: "partial-cost", cost: { input: 1, output: 2, cacheRead: 0.1 } },
          { id: "complete-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.1 } },
        ],
        modelOverrides: {
          inherited: { cost: { input: 3 } },
        },
      },
    },
  };

  const normalized = normalizeModelsConfigCosts(config);
  assert.deepEqual(normalized.providers.acme.models, [
    { id: "empty-cost" },
    { id: "partial-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
    { id: "complete-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.1 } },
  ]);
  assert.deepEqual(normalized.providers.acme.modelOverrides, {
    inherited: { cost: { input: 3 } },
  });
  assert.deepEqual(config.providers.acme.models[0], { id: "empty-cost", cost: {} });

  writeModelsConfig(config, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath), withCanonicalOverlay(normalized));
});

test("saving models.json drops blank model rows without hiding other schema errors", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");

  writeModelsConfig({
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1 } },
          { id: "" },
          { id: "  " },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  }, modelsPath);

  assert.deepEqual(readModelsConfig(modelsPath), withCanonicalOverlay({
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  }));
});

test("an existing session opens after its historical model is removed from config", (t) => {
  const root = createTempRoot(t);
  const sessionPath = join(root, "session.jsonl");
  const modelsPath = join(root, "models.json");
  const records = [
    {
      type: "session",
      version: 3,
      id: "existing-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "model_change",
      id: "model-old",
      parentId: null,
      provider: "retired-provider",
      modelId: "retired-model",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "message",
      id: "user-1",
      parentId: "model-old",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "keep this conversation" },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        provider: "retired-provider",
        model: "retired-model",
        content: [{ type: "text", text: "still readable" }],
      },
    },
  ];
  writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  writeModelsConfig({
    providers: {
      "retired-provider": {
        baseUrl: "https://retired.example.test/v1",
        api: "openai-completions",
        models: [{ id: "retired-model" }],
      },
    },
  }, modelsPath);
  const beforeChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.equal(beforeChange.messages[1].content[0].text, "still readable");

  writeModelsConfig({
    providers: {
      replacement: {
        baseUrl: "https://replacement.example.test/v1",
        api: "openai-completions",
        models: [{ id: "replacement-model" }],
      },
    },
  }, modelsPath);

  const afterChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.deepEqual(afterChange.entryIds, ["user-1", "assistant-1"]);
  assert.equal(afterChange.messages[0].content, "keep this conversation");
  assert.equal(afterChange.messages[1].content[0].text, "still readable");
});


test("old-tab archive revisions avoid writes and cache invalidation while business changes persist", async (t) => {
  const root = createTempRoot(t), modelsPath = join(root, "models.json");
  const base = { providers: {}, archivedSessions: [{ id: "owned", name: "原名" }], archivedRevision: 100, nested: { archivedRevision: 1 } };
  writeModelsConfig(base, modelsPath);
  const before = statSync(modelsPath), bytes = readFileSync(modelsPath, "utf8");
  let loads = 0;
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  for (let i = 0; i < 100; i++) writeModelsConfig({ ...base, archivedRevision: 101 + i }, modelsPath);
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  assert.equal(loads, 1);
  assert.equal(statSync(modelsPath).ino, before.ino);
  assert.equal(statSync(modelsPath).mtimeMs, before.mtimeMs);
  assert.equal(readFileSync(modelsPath, "utf8"), bytes);
  for (const change of [
    x => { x.archivedSessions = []; },
    x => { x.archivedSessions[0].name = "改名"; },
    x => { x.nested.archivedRevision = 2; },
    x => { x.archivedRevision = 0; },
    x => { x.unknownBusinessField = true; },
  ]) {
    writeModelsConfig(base, modelsPath);
    const next = structuredClone(base); change(next);
    writeModelsConfig(next, modelsPath);
    assert.deepEqual(readModelsConfig(modelsPath), withCanonicalOverlay(next));
  }
  invalidateModelsCache();
});
