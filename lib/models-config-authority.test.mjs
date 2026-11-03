import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStateStore } = require("./enhancement-state-store.cjs");
const { tryAcquireLockSync, releaseLockSync } = require("./agent-state-mutex.cjs");

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const {
  ModelsConfigConflictError,
  ModelsConfigReadError,
  ModelsConfigWriteError,
  readModelsConfig,
  writeModelsConfig,
} = await jiti.import("./models-config-store.ts");

const { GET, PUT } = await jiti.import("../app/api/models-config/route.ts");

function createTempAgent(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-models-authority-"));
  const modelsPath = join(root, "models.json");
  const originalEnv = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;

  t.after(() => {
    if (originalEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalEnv;
    rmSync(root, { recursive: true, force: true });
  });

  return { root, modelsPath };
}

function makePutRequest(body, { host = "localhost", contentType = "application/json" } = {}) {
  const headers = {};
  if (host) headers.Host = host;
  if (contentType) headers["Content-Type"] = contentType;

  return new Request("http://localhost/api/models-config", {
    method: "PUT",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("corrupted or broken legacy models.json does not init canonical state and is not overwritten", (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const brokenContent = '{ "providers": { "broken": [ } }';
  writeFileSync(modelsPath, brokenContent, "utf8");

  // 1. readModelsConfig must throw ModelsConfigReadError
  assert.throws(() => readModelsConfig(modelsPath), ModelsConfigReadError);

  // 2. writeModelsConfig must throw ModelsConfigReadError without initializing or replacing disk
  assert.throws(
    () => writeModelsConfig({ providers: { newProv: { models: [] } } }, modelsPath),
    ModelsConfigReadError,
  );

  // 3. Verify disk file remains unchanged
  assert.equal(readFileSync(modelsPath, "utf8"), brokenContent);

  // 4. Verify enhancement-state was never initialized
  const stateDir = join(root, "state", "enhancement-state");
  assert.equal(existsSync(stateDir), false);

  // 5. Missing providers schema error also does not init and does not overwrite
  const missingProviders = '{ "quickShortcuts": [] }';
  writeFileSync(modelsPath, missingProviders, "utf8");
  assert.throws(() => readModelsConfig(modelsPath), ModelsConfigReadError);
  assert.throws(
    () => writeModelsConfig({ providers: { newProv: { models: [] } } }, modelsPath),
    ModelsConfigReadError,
  );
  assert.equal(readFileSync(modelsPath, "utf8"), missingProviders);
  assert.equal(existsSync(stateDir), false);
});

test("fresh get returns identical tags across readModelsConfig and stateStore, without auto-init on uninitialized", (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const initialConfig = {
    providers: {
      providerA: {
        baseUrl: "https://a.test/v1",
        api: "openai-completions",
        models: [{ id: "m1" }],
      },
    },
    someOtherPref: "value-1",
  };
  writeFileSync(modelsPath, JSON.stringify(initialConfig), "utf8");

  // 1. Uninitialized read: raw disk returned, enhancementStateRevision not present, no stateDir created
  const uninitialized = readModelsConfig(modelsPath);
  assert.deepEqual(uninitialized.providers, initialConfig.providers);
  assert.equal(uninitialized.someOtherPref, "value-1");
  assert.equal(uninitialized.enhancementStateRevision, undefined);
  assert.equal(existsSync(join(root, "state", "enhancement-state")), false);

  // 2. Initialize canonical state and add a tag
  const store = createStateStore({ agentDir: root });
  store.ensureInitializedFromLegacyLocked({ modelsConfigPath: modelsPath });
  store.commitSync([
    {
      opId: "op-create-1",
      type: "tag_create",
      tag: { id: "tag-work", name: "Work", color: "#3b82f6" },
    },
    {
      opId: "op-add-1",
      type: "session_tag_add",
      sessionId: "session-123",
      tagId: "tag-work",
    },
    {
      opId: "op-color-1",
      type: "session_color_set",
      sessionId: "session-123",
      color: "#3b82f6",
    },
  ]);

  const canonical = store.read();
  assert.equal(canonical.revision > 1, true);

  // 3. Dual-read parity: readModelsConfig returns overlaid authoritative state
  const dualRead = readModelsConfig(modelsPath);
  assert.deepEqual(dualRead.sessionTagsDefinitions, canonical.state.sessionTagsDefinitions);
  assert.deepEqual(dualRead.sessionTagMappings, canonical.state.sessionTagMappings);
  assert.deepEqual(dualRead.sessionColors, canonical.state.sessionColors);
  assert.equal(dualRead.sessionTagsRevision, canonical.revision);
  assert.equal(dualRead.enhancementStateRevision, canonical.revision);
  assert.deepEqual(dualRead.providers, initialConfig.providers);
  assert.equal(dualRead.someOtherPref, "value-1");

  // 4. Verify enhancementStateRevision was not persisted to disk
  const onDisk = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(onDisk.enhancementStateRevision, undefined);
});

test("stale decorator snapshot clearing, deleting, or re-adding rejected with 409 ModelsConfigConflictError", async (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const baseConfig = {
    providers: {
      providerA: { models: [{ id: "model-a" }] },
    },
  };
  writeFileSync(modelsPath, JSON.stringify(baseConfig), "utf8");

  // Initialize and create 2 tags
  const store = createStateStore({ agentDir: root });
  store.ensureInitializedFromLegacyLocked({ modelsConfigPath: modelsPath });
  store.commitSync([
    { opId: "op-create-1", type: "tag_create", tag: { id: "tag-1", name: "One" } },
    { opId: "op-create-2", type: "tag_create", tag: { id: "tag-2", name: "Two" } },
    { opId: "op-tag-add-1", type: "session_tag_add", sessionId: "s-1", tagId: "tag-1" },
  ]);

  const current = store.read();
  assert.equal(current.state.sessionTagsDefinitions.length, 2);

  // Case A: Stale clearing (sending empty array while tags exist)
  assert.throws(
    () => writeModelsConfig({ ...baseConfig, sessionTagsDefinitions: [] }, modelsPath),
    (err) => {
      assert.ok(err instanceof ModelsConfigConflictError);
      assert.match(err.message, /refresh the page or use the tag operations API/i);
      return true;
    },
  );

  let putRes = await PUT(makePutRequest({ ...baseConfig, sessionTagsDefinitions: [] }));
  assert.equal(putRes.status, 409);
  assert.match((await putRes.json()).error, /refresh the page or use the tag operations API/i);

  // Case B: Stale deletion (client only has tag-1, omitting tag-2)
  assert.throws(
    () => writeModelsConfig({
      ...baseConfig,
      sessionTagsDefinitions: [{ id: "tag-1", name: "One" }],
    }, modelsPath),
    ModelsConfigConflictError,
  );

  putRes = await PUT(makePutRequest({
    ...baseConfig,
    sessionTagsDefinitions: [{ id: "tag-1", name: "One" }],
  }));
  assert.equal(putRes.status, 409);

  // Case C: Stale mappings mismatch
  assert.throws(
    () => writeModelsConfig({
      ...baseConfig,
      sessionTagsDefinitions: current.state.sessionTagsDefinitions,
      sessionTagMappings: {}, // stale empty mappings
    }, modelsPath),
    ModelsConfigConflictError,
  );

  // Delete tag-2 canonically, then stale client tries to re-add tag-2 via whole snapshot
  store.commitSync([{ opId: "op-del-2", type: "tag_delete", tagId: "tag-2" }]);
  const afterDelete = store.read();
  assert.equal(afterDelete.state.sessionTagsDefinitions.length, 1);

  // Case D: Stale re-add of removed tag
  assert.throws(
    () => writeModelsConfig({
      ...baseConfig,
      sessionTagsDefinitions: [
        { id: "tag-1", name: "One" },
        { id: "tag-2", name: "Two" },
      ],
    }, modelsPath),
    ModelsConfigConflictError,
  );

  // Verify canonical state was protected throughout all failed attempts
  const finalCanonical = store.read();
  assert.equal(finalCanonical.state.sessionTagsDefinitions.length, 1);
  assert.equal(finalCanonical.state.sessionTagsDefinitions[0].id, "tag-1");
});

test("PUT on first initialization with true legacy edits difference returns 409 and does not auto-migrate body", async (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const diskLegacy = {
    providers: { providerA: { models: [{ id: "m1" }] } },
    sessionTagsDefinitions: [{ id: "legacy-disk-tag", name: "Original From Disk" }],
    sessionTagMappings: { "sess-old": ["legacy-disk-tag"] },
    sessionColors: { "sess-old": "#10b981" },
  };
  writeFileSync(modelsPath, JSON.stringify(diskLegacy, null, 2), "utf8");

  // State store is not initialized yet
  const store = createStateStore({ agentDir: root });
  assert.throws(() => store.read(), /NOT_INITIALIZED/);

  // Client PUTs conflicting legacy edits
  const clientBody = {
    providers: { providerA: { models: [{ id: "m1" }] } },
    sessionTagsDefinitions: [{ id: "legacy-client-tag", name: "Changed In Old Tab" }],
  };

  const response = await PUT(makePutRequest(clientBody));
  assert.equal(response.status, 409);
  const json = await response.json();
  assert.match(json.error, /refresh the page or use the tag operations API/i);

  // Canonical state was initialized from DISK decorators, NOT clientBody
  const canonical = store.read();
  assert.deepEqual(canonical.state.sessionTagsDefinitions, diskLegacy.sessionTagsDefinitions);
  assert.deepEqual(canonical.state.sessionTagMappings, diskLegacy.sessionTagMappings);
  assert.deepEqual(canonical.state.sessionColors, diskLegacy.sessionColors);

  // Disk also preserved original disk decorators
  const diskAfter = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(diskAfter.sessionTagsDefinitions, diskLegacy.sessionTagsDefinitions);
});

test("non-decorator updates persist provider and otherprefs without modifying canonical state or disk decorators", (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const initial = {
    providers: {
      p1: { baseUrl: "https://p1.test", models: [{ id: "m1" }] },
    },
    quickShortcuts: [{ id: "chat" }],
    customUserPref: { theme: "dark", fontSize: 14 },
    sessionTagsDefinitions: [{ id: "persisted-tag", name: "Original" }],
  };
  writeFileSync(modelsPath, JSON.stringify(initial, null, 2), "utf8");

  // Save non-decorator update (adding provider p2, updating customUserPref, not passing decorator fields)
  const updateBody = {
    providers: {
      p1: { baseUrl: "https://p1.test", models: [{ id: "m1" }] },
      p2: { baseUrl: "https://p2.test", models: [{ id: "m2" }] },
    },
    quickShortcuts: [{ id: "chat" }, { id: "code" }],
    customUserPref: { theme: "system", fontSize: 16 },
  };

  writeModelsConfig(updateBody, modelsPath);

  // Disk check: disk has new providers and preferences, while retaining original disk decorator
  const disk = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.deepEqual(disk.providers, updateBody.providers);
  assert.deepEqual(disk.quickShortcuts, updateBody.quickShortcuts);
  assert.deepEqual(disk.customUserPref, updateBody.customUserPref);
  assert.deepEqual(disk.sessionTagsDefinitions, initial.sessionTagsDefinitions);
  assert.equal(disk.enhancementStateRevision, undefined);

  // Overlay read check: returns updated providers & custom prefs, plus canonical tags
  const read = readModelsConfig(modelsPath);
  assert.deepEqual(read.providers, updateBody.providers);
  assert.deepEqual(read.quickShortcuts, updateBody.quickShortcuts);
  assert.deepEqual(read.customUserPref, updateBody.customUserPref);
  assert.deepEqual(read.sessionTagsDefinitions, initial.sessionTagsDefinitions);
  assert.equal(read.enhancementStateRevision, 1);
});

test("concurrent modelworker and canonicaltagworkers preserve providers, prefs, and tags without loss", async (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const initial = {
    providers: {
      providerA: { models: [{ id: "m-base" }] },
    },
    counterPref: 0,
  };
  writeFileSync(modelsPath, JSON.stringify(initial), "utf8");

  const store = createStateStore({ agentDir: root });
  store.ensureInitializedFromLegacyLocked({ modelsConfigPath: modelsPath });

  const TOTAL_ROUNDS = 20;

  // Run model worker and tag worker concurrently.
  // Model worker performs bounded async retries and refreshes authoritative config on LOCK_BUSY,
  // without business-layer synchronous spinning.
  const modelWorker = (async () => {
    for (let i = 1; i <= TOTAL_ROUNDS; i++) {
      let written = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          const authoritative = readModelsConfig(modelsPath);
          writeModelsConfig({
            ...authoritative,
            providers: {
              ...authoritative.providers,
              providerA: {
                models: [
                  { id: "m-base" },
                  { id: `m-worker-${i}`, cost: { input: i } },
                ],
              },
            },
            counterPref: i,
          }, modelsPath);
          written = true;
          break;
        } catch (err) {
          const code = err && err.code;
          const msg = String(err);
          if (code === "LOCK_BUSY" || msg.includes("LOCK_BUSY")) {
            await new Promise((r) => setTimeout(r, 10));
            continue;
          }
          throw err;
        }
      }
      assert.ok(written, `modelWorker failed to complete round ${i} within retry budget`);
      // Small tick
      await new Promise((r) => setTimeout(r, 2));
    }
  })();

  const tagWorker = (async () => {
    for (let i = 1; i <= TOTAL_ROUNDS; i++) {
      store.commitSync([
        {
          opId: `op-tag-create-${i}`,
          type: "tag_create",
          tag: { id: `tag-${i}`, name: `Tag ${i}`, color: "#10b981" },
        },
        {
          opId: `op-session-tag-${i}`,
          type: "session_tag_add",
          sessionId: `sess-${i}`,
          tagId: `tag-${i}`,
        },
      ]);
      await new Promise((r) => setTimeout(r, 2));
    }
  })();

  await Promise.all([modelWorker, tagWorker]);

  // Verify final state
  const finalRead = readModelsConfig(modelsPath);

  // 1. Model worker's final state persisted
  assert.equal(finalRead.counterPref, TOTAL_ROUNDS);
  assert.equal(finalRead.providers.providerA.models.length, 2);
  assert.equal(finalRead.providers.providerA.models[1].id, `m-worker-${TOTAL_ROUNDS}`);

  // 2. Tag worker's tags all present in canonical overlay
  assert.equal(finalRead.sessionTagsDefinitions.length, TOTAL_ROUNDS);
  assert.equal(Object.keys(finalRead.sessionTagMappings).length, TOTAL_ROUNDS);
  assert.equal(finalRead.enhancementStateRevision > TOTAL_ROUNDS, true);

  // 3. Disk does not have enhancementStateRevision
  const disk = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(disk.enhancementStateRevision, undefined);
});

test("API route security: untrusted host 403, bad content-type 400, invalid json 400", async (t) => {
  createTempAgent(t);

  // 1. Untrusted host
  const untrustedReq = makePutRequest({ providers: {} }, { host: "evil.attacker.com" });
  const untrustedRes = await PUT(untrustedReq);
  assert.equal(untrustedRes.status, 403);
  assert.equal((await untrustedRes.json()).error, "Untrusted API request");

  // 2. Non-json content-type
  const badCtReq = makePutRequest({ providers: {} }, { contentType: "text/plain" });
  const badCtRes = await PUT(badCtReq);
  assert.equal(badCtRes.status, 400);
  assert.equal((await badCtRes.json()).error, "Content-Type must be application/json");

  // 3. Invalid JSON string
  const malformedReq = makePutRequest("not valid json {", { contentType: "application/json" });
  const malformedRes = await PUT(malformedReq);
  assert.equal(malformedRes.status, 400);
  assert.equal((await malformedRes.json()).error, "Invalid JSON body");

  // 4. Non-object root
  const nonObjectReq = makePutRequest("[1, 2, 3]", { contentType: "application/json" });
  const nonObjectRes = await PUT(nonObjectReq);
  assert.equal(nonObjectRes.status, 400);
  assert.equal((await nonObjectRes.json()).error, "Expected a JSON object");
});

test("writeModelsConfig failclosed throws LOCK_BUSY immediately without spinning when lock is held", (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const initial = { providers: { p: { models: [] } } };
  writeFileSync(modelsPath, JSON.stringify(initial), "utf8");

  const handle = tryAcquireLockSync(root);
  assert.ok(handle, "Failed to acquire lock for test setup");

  try {
    const start = Date.now();
    assert.throws(
      () => writeModelsConfig({ providers: { p: { models: [{ id: "m1" }] } } }, modelsPath),
      (err) => {
        assert.equal(err && err.code, "LOCK_BUSY");
        return true;
      },
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `Expected instant failclosed (<200ms), took ${elapsed}ms`);
  } finally {
    releaseLockSync(handle);
  }
});

test("API PUT returns 503 with Retry-After 1 when state lock is busy", async (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const initial = { providers: { p: { models: [] } } };
  writeFileSync(modelsPath, JSON.stringify(initial), "utf8");

  const handle = tryAcquireLockSync(root);
  assert.ok(handle, "Failed to acquire lock for test setup");

  try {
    const putRes = await PUT(makePutRequest({ providers: { p: { models: [{ id: "m1" }] } } }));
    assert.equal(putRes.status, 503);
    assert.equal(putRes.headers.get("Retry-After"), "1");
    const json = await putRes.json();
    assert.equal(json.error, "Service temporarily busy, please retry");
  } finally {
    releaseLockSync(handle);
  }
});

test("API PUT on empty models.json returns conservative 422 when state init fails, without pre-normalization", async (t) => {
  const { root, modelsPath } = createTempAgent(t);
  writeFileSync(modelsPath, "", "utf8");

  const putRes = await PUT(makePutRequest({ providers: { p: { models: [] } } }));
  assert.equal(putRes.status, 422);

  // Must not perform write normalization before state store init
  assert.equal(readFileSync(modelsPath, "utf8"), "");
});

test("writeModelsConfig merges {...currentDisk, ...normalized} to preserve unknown fields", (t) => {
  const { root, modelsPath } = createTempAgent(t);
  const initial = {
    providers: {
      providerA: { models: [{ id: "m-base" }] },
    },
    unknownThirdPartyField: { setting: true, nested: [1, 2, 3] },
    anotherLegacyField: "legacy_value",
  };
  writeFileSync(modelsPath, JSON.stringify(initial), "utf8");

  // Save updated provider without providing unknownThirdPartyField or anotherLegacyField
  writeModelsConfig({
    providers: {
      providerA: { models: [{ id: "m-updated" }] },
    },
  }, modelsPath);

  const disk = JSON.parse(readFileSync(modelsPath, "utf8"));
  assert.equal(disk.providers.providerA.models[0].id, "m-updated");
  assert.deepEqual(disk.unknownThirdPartyField, initial.unknownThirdPartyField);
  assert.equal(disk.anotherLegacyField, initial.anotherLegacyField);
});
