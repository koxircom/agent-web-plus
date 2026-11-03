import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalPassword = process.env.PI_WEB_PASSWORD;

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { createStateStore } = await jiti.import("./enhancement-state-store.cjs");
const { tryAcquireLockSync, releaseLockSync } = await jiti.import("./agent-state-mutex.cjs");
const {
  MAX_ENHANCEMENT_STATE_BODY_BYTES,
  MAX_ENHANCEMENT_STATE_OPERATIONS,
} = await jiti.import("./enhancement-state-api.ts");
const { GET, HEAD } = await jiti.import("../app/api/enhancement-state/route.ts");
const { POST } = await jiti.import("../app/api/enhancement-state/operations/route.ts");
const { proxy } = await jiti.import("../proxy.ts");
const { createWebSessionToken } = await jiti.import("./web-auth.ts");

const tempDirs = [];

function createIsolatedAgentDir(prefix = "pi-enh-state-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function snapshotDirectoryHashes(rootDir) {
  if (!existsSync(rootDir)) return null;
  const result = {};
  function walk(currDir, relPrefix = "") {
    const entries = readdirSync(currDir).sort();
    for (const name of entries) {
      const fullPath = join(currDir, name);
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        walk(fullPath, relPath);
      } else {
        result[relPath] = sha256File(fullPath);
      }
    }
  }
  walk(rootDir);
  return result;
}

function initializeTempStore(agentDir, initialModels = {}) {
  const modelsPath = join(agentDir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify(
      {
        providers: {},
        sessionTagsDefinitions: initialModels.sessionTagsDefinitions ?? [
          { id: "tag-init", name: "Initial", color: "#2563eb" },
        ],
        sessionTagMappings: initialModels.sessionTagMappings ?? {
          "sess-1": ["tag-init"],
        },
        sessionColors: initialModels.sessionColors ?? {
          "sess-1": "blue",
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  const store = createStateStore({ agentDir });
  return store.initializeFromLegacy({ modelsConfigPath: modelsPath });
}

function headRequest(pathAndQuery = "/api/enhancement-state", headers = {}) {
  return new Request(`http://localhost${pathAndQuery}`, {
    method: "HEAD",
    headers: { Host: "localhost", ...headers },
  });
}

function getRequest(pathAndQuery = "/api/enhancement-state", headers = {}) {
  return new Request(`http://localhost${pathAndQuery}`, {
    method: "GET",
    headers: { Host: "localhost", ...headers },
  });
}

function postRequest(
  body,
  {
    pathAndQuery = "/api/enhancement-state/operations",
    headers = {},
    raw = false,
  } = {},
) {
  return new Request(`http://localhost${pathAndQuery}`, {
    method: "POST",
    headers: {
      Host: "localhost",
      "Content-Type": "application/json",
      ...headers,
    },
    body: raw ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  delete process.env.PI_WEB_PASSWORD;
});

after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  if (originalPassword === undefined) delete process.env.PI_WEB_PASSWORD;
  else process.env.PI_WEB_PASSWORD = originalPassword;

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store implementation matches reference script byte-for-byte and runtime exposes __PI_ENH_NATIVE_STATE_API__", () => {
  const referencePath = "/root/.pi/agent/scripts/pi-enhancement-state-store.cjs";
  const localPath = join(process.cwd(), "lib", "enhancement-state-store.cjs");
  if (existsSync(referencePath)) {
    assert.equal(sha256File(localPath), sha256File(referencePath));
  }
  const runtimeSource = readFileSync(
    join(process.cwd(), "components", "PiWebEnhancementsRuntime.tsx"),
    "utf8",
  );
  assert.match(runtimeSource, /__PI_ENH_NATIVE_STATE_API__\s*=\s*true/);
});

test("uninitialized store: GET returns 409 and HEAD reports absent, invalid op rejected without writes, valid POST auto-inits and matches GET", async () => {
  const agentDir = createIsolatedAgentDir("pi-enh-uninit-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const stateDir = join(agentDir, "state", "enhancement-state");

  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {},
      sessionTagsDefinitions: [{ id: "legacy-1", name: "Legacy" }],
    }),
    "utf8",
  );
  const beforeRootSnapshot = snapshotDirectoryHashes(agentDir);

  // 1. GET returns 409 NOT_INITIALIZED and HEAD reports absent without touching disk
  const headRes1 = await HEAD(headRequest());
  assert.equal(headRes1.status, 200);
  assert.equal(headRes1.headers.get("X-Pi-Enhancement-State"), "absent");

  const getRes = await GET(getRequest());
  assert.equal(getRes.status, 409);
  assert.equal(getRes.headers.get("access-control-allow-origin"), null);
  const getBody = await getRes.json();
  assert.equal(getBody.ok, false);
  assert.equal(getBody.error, "NOT_INITIALIZED");
  assert.equal(existsSync(stateDir), false);
  assert.deepEqual(snapshotDirectoryHashes(agentDir), beforeRootSnapshot);

  // 2. Invalid op is validated first before writing/migrating and makes zero disk modifications
  const invalidPostRes = await POST(
    postRequest({
      operations: [
        {
          opId: "op-invalid-type",
          type: "unsupported_operation_type",
        },
      ],
    }),
  );
  assert.equal(invalidPostRes.status, 400);
  const invalidBody = await invalidPostRes.json();
  assert.equal(invalidBody.ok, false);
  assert.equal(invalidBody.error, "BAD_REQUEST");
  assert.equal(existsSync(stateDir), false);
  assert.deepEqual(snapshotDirectoryHashes(agentDir), beforeRootSnapshot);

  // 3. Valid POST operation safely initializes from legacy in a single locked transaction and commits op
  const postRes = await POST(
    postRequest({
      operations: [
        {
          opId: "op-uninit-1",
          type: "session_color_set",
          timestamp: Date.now(),
          sessionId: "sess-1",
          color: "green",
        },
      ],
    }),
  );
  assert.equal(postRes.status, 200);
  const postBody = await postRes.json();
  assert.equal(postBody.ok, true);
  assert.equal(postBody.revision, 2);
  assert.deepEqual(postBody.acknowledgedOpIds, ["op-uninit-1"]);
  assert.equal(postBody.state.sessionTagsDefinitions.length, 1);
  assert.equal(postBody.state.sessionTagsDefinitions[0].id, "legacy-1");
  assert.equal(postBody.state.sessionColors["sess-1"], "green");
  assert.equal(existsSync(stateDir), true);

  // 4. Fresh route read matches committed post result and HEAD reports present
  const headRes2 = await HEAD(headRequest());
  assert.equal(headRes2.status, 200);
  assert.equal(headRes2.headers.get("X-Pi-Enhancement-State"), "present");

  const getRes2 = await GET(getRequest());
  assert.equal(getRes2.status, 200);
  const getBody2 = await getRes2.json();
  assert.equal(getBody2.ok, true);
  assert.equal(getBody2.revision, postBody.revision);
  assert.deepEqual(getBody2.state, postBody.state);
});

test("corrupted legacy models.json does not migrate on POST, leaves models.json untouched, and never leaks paths", async () => {
  const agentDir = createIsolatedAgentDir("pi-enh-bad-legacy-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const stateDir = join(agentDir, "state", "enhancement-state");
  const badModelsContent = '{"providers": {}, "sessionTagsDefinitions": "not-an-array"}';
  writeFileSync(join(agentDir, "models.json"), badModelsContent, "utf8");
  const beforeSnapshot = snapshotDirectoryHashes(agentDir);

  const postRes = await POST(
    postRequest({
      operations: [
        {
          opId: "op-bad-legacy-1",
          type: "session_color_set",
          timestamp: Date.now(),
          sessionId: "sess-1",
          color: "blue",
        },
      ],
    }),
  );
  assert.equal(postRes.status, 422);
  const postBody = await postRes.json();
  assert.equal(postBody.ok, false);
  assert.equal(postBody.error, "LEGACY_MODELS_INVALID");
  assert.equal(postBody.message.includes(agentDir), false);
  assert.equal(postBody.message.includes("/tmp/"), false);
  assert.equal(existsSync(stateDir), false);
  assert.deepEqual(snapshotDirectoryHashes(agentDir), beforeSnapshot);
  assert.equal(readFileSync(join(agentDir, "models.json"), "utf8"), badModelsContent);
});

test("state lock busy returns 503 with Retry-After 1, and stale lock returns fixed 503 without fallback to filesystem", async () => {
  const agentDir = createIsolatedAgentDir("pi-enh-lock-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  initializeTempStore(agentDir);

  // 1. LOCK_BUSY: 当其他进程/句柄占住锁时
  const lockHandle = tryAcquireLockSync(agentDir);
  assert.ok(lockHandle, "lock must be acquired");

  try {
    const postRes = await POST(
      postRequest({
        operations: [
          {
            opId: "op-lock-busy-1",
            type: "session_color_set",
            timestamp: Date.now(),
            sessionId: "sess-busy",
            color: "red",
          },
        ],
      }),
    );
    assert.equal(postRes.status, 503);
    assert.equal(postRes.headers.get("Retry-After"), "1");
    const body = await postRes.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, "LOCK_BUSY");
    assert.equal(body.message.includes(agentDir), false);
  } finally {
    releaseLockSync(lockHandle);
  }

  // 2. STALE: 锁目录存在但 owner 骤死（dead owner），必须返回 503 LOCK_STALE_REQUIRES_RECOVERY，且绝不写入或降级
  const mutexPath = join(process.cwd(), "lib", "agent-state-mutex.cjs");
  const crashScript = `
'use strict';
const { withAgentStateLockSync } = require(${JSON.stringify(mutexPath)});
withAgentStateLockSync(${JSON.stringify(agentDir)}, () => {
  process.kill(process.pid, 'SIGKILL');
});
`;
  const crashChild = spawn(process.execPath, ["-e", crashScript]);
  await new Promise((resolve) => crashChild.on("close", resolve));

  const stalePostRes = await POST(
    postRequest({
      operations: [
        {
          opId: "op-stale-1",
          type: "session_color_set",
          timestamp: Date.now(),
          sessionId: "sess-stale",
          color: "black",
        },
      ],
    }),
  );
  assert.equal(stalePostRes.status, 503);
  const staleBody = await stalePostRes.json();
  assert.equal(staleBody.ok, false);
  assert.equal(staleBody.error, "LOCK_STALE_REQUIRES_RECOVERY");
  assert.equal(staleBody.message, "Agent state lock is stale and requires recovery");
  assert.equal(staleBody.message.includes(agentDir), false);
});

test("corrupted journal or current.json returns 503 and never resets or writes to disk", async () => {
  // Case 1: current.json exists without journal.jsonl
  const missingJournalDir = createIsolatedAgentDir("pi-enh-corrupt-no-journal-");
  process.env.PI_CODING_AGENT_DIR = missingJournalDir;
  const stateDir1 = join(missingJournalDir, "state", "enhancement-state");
  mkdirSync(stateDir1, { recursive: true });
  writeFileSync(
    join(stateDir1, "current.json"),
    JSON.stringify({
      ok: true,
      revision: 1,
      state: {
        sessionTagsDefinitions: [],
        sessionTagMappings: {},
        sessionColors: {},
        enhancementSettingsByClient: {},
      },
      storageVersion: 1,
    }),
    "utf8",
  );
  const snap1Before = snapshotDirectoryHashes(stateDir1);

  let getRes = await GET(getRequest());
  assert.equal(getRes.status, 503);
  assert.equal((await getRes.json()).ok, false);
  let postRes = await POST(
    postRequest({
      operations: [{ opId: "op-1", type: "session_color_clear", sessionId: "s1" }],
    }),
  );
  assert.equal(postRes.status, 503);
  assert.deepEqual(snapshotDirectoryHashes(stateDir1), snap1Before);

  // Case 2: corrupted journal hash / truncated line
  const badJournalDir = createIsolatedAgentDir("pi-enh-corrupt-journal-");
  process.env.PI_CODING_AGENT_DIR = badJournalDir;
  initializeTempStore(badJournalDir);
  const stateDir2 = join(badJournalDir, "state", "enhancement-state");
  const journalPath2 = join(stateDir2, "journal.jsonl");
  writeFileSync(journalPath2, `${readFileSync(journalPath2, "utf8")}{"corrupted":true}\n`, "utf8");
  const snap2Before = snapshotDirectoryHashes(stateDir2);

  getRes = await GET(getRequest());
  assert.equal(getRes.status, 503);
  const badJournalBody = await getRes.json();
  assert.equal(badJournalBody.ok, false);
  assert.match(badJournalBody.error, /CORRUPTED/);

  postRes = await POST(
    postRequest({
      operations: [{ opId: "op-2", type: "session_color_clear", sessionId: "s1" }],
    }),
  );
  assert.equal(postRes.status, 503);
  assert.deepEqual(snapshotDirectoryHashes(stateDir2), snap2Before);
});

test("GET reads full protocol without modifying disk hashes, and sees latest POST and external commits", async () => {
  const agentDir = createIsolatedAgentDir("pi-enh-read-write-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  initializeTempStore(agentDir);
  const stateDir = join(agentDir, "state", "enhancement-state");

  const hashesBeforeGet = snapshotDirectoryHashes(stateDir);
  const getRes1 = await GET(getRequest());
  assert.equal(getRes1.status, 200);
  assert.equal(getRes1.headers.get("access-control-allow-origin"), null);
  assert.match(getRes1.headers.get("cache-control") ?? "", /no-store/);
  const data1 = await getRes1.json();
  assert.deepEqual(data1, {
    ok: true,
    revision: 1,
    state: {
      sessionTagsDefinitions: [{ id: "tag-init", name: "Initial", color: "#2563eb" }],
      sessionTagMappings: { "sess-1": ["tag-init"] },
      sessionColors: { "sess-1": "blue" },
      enhancementSettingsByClient: {},
    },
    storageVersion: 1,
  });
  const hashesAfterGet = snapshotDirectoryHashes(stateDir);
  assert.deepEqual(hashesAfterGet, hashesBeforeGet);

  // POST new operations
  const postRes = await POST(
    postRequest({
      operations: [
        {
          opId: "op-create-tag-2",
          type: "tag_create",
          timestamp: 1700000000001,
          tag: { id: "tag-2", name: "Urgent", color: "#ef4444" },
        },
        {
          opId: "op-add-tag-2",
          type: "session_tag_add",
          timestamp: 1700000000002,
          sessionId: "sess-2",
          tagId: "tag-2",
        },
        {
          opId: "op-color-2",
          type: "session_color_set",
          timestamp: 1700000000003,
          sessionId: "sess-2",
          color: "amber",
        },
        {
          opId: "op-prefs-1",
          type: "preferences_snapshot",
          timestamp: 1700000000004,
          clientId: "client-abc",
          values: {
            "pi-enh-settings-v1": '{"enabled":true}',
            "pi-enh-plugin-demo": "1",
          },
        },
      ],
    }),
  );
  assert.equal(postRes.status, 200);
  const postData = await postRes.json();
  assert.equal(postData.ok, true);
  assert.equal(postData.revision, 2);
  assert.equal(postData.storageVersion, 1);
  assert.deepEqual(postData.acknowledgedOpIds, [
    "op-create-tag-2",
    "op-add-tag-2",
    "op-color-2",
    "op-prefs-1",
  ]);
  assert.deepEqual(postData.tagIdRemap, {});
  assert.equal(postData.state.sessionTagsDefinitions.length, 2);
  assert.deepEqual(postData.state.sessionTagMappings["sess-2"], ["tag-2"]);
  assert.equal(postData.state.sessionColors["sess-2"], "amber");
  assert.deepEqual(postData.state.enhancementSettingsByClient["client-abc"], {
    "pi-enh-settings-v1": '{"enabled":true}',
    "pi-enh-plugin-demo": "1",
  });

  // Duplicate opId retry must not increment revision or write to disk
  const hashesBeforeDup = snapshotDirectoryHashes(stateDir);
  const dupRes = await POST(
    postRequest({
      operations: [
        {
          opId: "op-create-tag-2",
          type: "tag_create",
          timestamp: 1700000000001,
          tag: { id: "tag-2", name: "Urgent", color: "#ef4444" },
        },
      ],
    }),
  );
  assert.equal(dupRes.status, 200);
  const dupData = await dupRes.json();
  assert.equal(dupData.revision, 2);
  assert.deepEqual(dupData.acknowledgedOpIds, ["op-create-tag-2"]);
  assert.deepEqual(snapshotDirectoryHashes(stateDir), hashesBeforeDup);

  // External commit on disk is immediately visible on next GET because GET instantiates a fresh store
  const externalStore = createStateStore({ agentDir });
  await externalStore.commit([
    {
      opId: "op-ext-3",
      type: "session_color_set",
      timestamp: 1700000000005,
      sessionId: "sess-ext",
      color: "purple",
    },
  ]);

  const getRes2 = await GET(getRequest());
  assert.equal(getRes2.status, 200);
  const data2 = await getRes2.json();
  assert.equal(data2.revision, 3);
  assert.equal(data2.state.sessionColors["sess-ext"], "purple");
});

test("concurrent commits serialize cleanly via store module lock without losing updates", async () => {
  const agentDir = createIsolatedAgentDir("pi-enh-concurrent-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  initializeTempStore(agentDir);

  const concurrency = 6;
  const responses = await Promise.all(
    Array.from({ length: concurrency }, (_, idx) =>
      POST(
        postRequest({
          operations: [
            {
              opId: `concurrent-tag-${idx}`,
              type: "tag_create",
              timestamp: 1700000010000 + idx,
              tag: { id: `t-conc-${idx}`, name: `Concurrent ${idx}`, color: "#10b981" },
            },
            {
              opId: `concurrent-color-${idx}`,
              type: "session_color_set",
              timestamp: 1700000020000 + idx,
              sessionId: `sess-conc-${idx}`,
              color: "emerald",
            },
          ],
        }),
      ),
    ),
  );

  for (const res of responses) {
    assert.equal(res.status, 200);
  }

  const finalGet = await GET(getRequest());
  assert.equal(finalGet.status, 200);
  const finalData = await finalGet.json();
  assert.equal(finalData.revision, 1 + concurrency);
  assert.equal(finalData.state.sessionTagsDefinitions.length, 1 + concurrency);
  for (let idx = 0; idx < concurrency; idx++) {
    assert.equal(finalData.state.sessionColors[`sess-conc-${idx}`], "emerald");
  }
});

test("malformed JSON, prototype pollution, unknown fields, >100 ops, >1MiB body, and invalid operations make zero disk modifications", async () => {
  const agentDir = createIsolatedAgentDir("pi-enh-validation-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  initializeTempStore(agentDir);
  const stateDir = join(agentDir, "state", "enhancement-state");
  const baselineHashes = snapshotDirectoryHashes(stateDir);

  // 1. Malformed JSON
  let res = await POST(postRequest("{bad json", { raw: true }));
  assert.equal(res.status, 400);

  // 2. Non-object top-level JSON
  res = await POST(postRequest("[]", { raw: true }));
  assert.equal(res.status, 400);

  // 3. Unknown top-level fields (including client instance/agentDir override attempts)
  for (const badBody of [
    { operations: [], extra: 1 },
    { operations: [], instance: "30142" },
    { operations: [], agentDir: "/tmp/evil" },
  ]) {
    res = await POST(postRequest(badBody));
    assert.equal(res.status, 400);
  }

  // 4. Prototype pollution in top-level or nested operation payloads
  const pollutedPayloads = [
    '{"__proto__":{"polluted":true},"operations":[]}',
    '{"constructor":{"prototype":{"polluted":true}},"operations":[]}',
    '{"operations":[{"opId":"op-p1","type":"tag_create","tag":{"id":"t1","name":"Tag","__proto__":{"polluted":true}}}]}',
    '{"operations":[{"opId":"__proto__","type":"tag_delete","tagId":"tag-init"}]}',
    '{"operations":[{"opId":"op-p2","type":"preferences_snapshot","clientId":"c1","values":{"__proto__":"1"}}]}',
  ];
  for (const rawPayload of pollutedPayloads) {
    res = await POST(postRequest(rawPayload, { raw: true }));
    assert.equal(res.status, 400);
    assert.equal(({}).polluted, undefined);
  }

  // 5. Unknown field inside operation or tag
  res = await POST(
    postRequest({
      operations: [
        {
          opId: "op-unknown-key",
          type: "tag_delete",
          tagId: "tag-init",
          unexpectedField: "nope",
        },
      ],
    }),
  );
  assert.equal(res.status, 400);

  // 6. Invalid operation semantics (unsupported type, missing tag on session_tag_add)
  for (const type of ["drop_all", "constructor", "__proto__", "toString"]) {
    res = await POST(postRequest({ operations: [{ opId: "op-bad-type", type }] }));
    assert.equal(res.status, 400, `Unsupported operation ${type} must not inherit an object method`);
  }

  res = await POST(
    postRequest({
      operations: [
        {
          opId: "op-missing-tag",
          type: "session_tag_add",
          sessionId: "sess-1",
          tagId: "non-existent-tag-id",
        },
      ],
    }),
  );
  assert.equal(res.status, 400);

  // 7. Batch > 100 operations
  const tooManyOps = Array.from({ length: MAX_ENHANCEMENT_STATE_OPERATIONS + 1 }, (_, i) => ({
    opId: `op-many-${i}`,
    type: "session_color_clear",
    sessionId: `sess-${i}`,
  }));
  res = await POST(postRequest({ operations: tooManyOps }));
  assert.equal(res.status, 400);

  // 8. Streaming body > 1MiB (exact 1,048,576 byte boundary check)
  let chunksRead = 0;
  const oversizedStream = new ReadableStream({
    pull(controller) {
      chunksRead += 1;
      // 3 chunks of 512 KiB = 1.5 MiB, should stop on 3rd chunk (1MiB + 1 byte)
      if (chunksRead <= 3) {
        controller.enqueue(new Uint8Array(512 * 1024).fill(0x61));
      } else {
        controller.close();
      }
    },
  });
  res = await POST(
    new Request("http://localhost/api/enhancement-state/operations", {
      method: "POST",
      headers: { Host: "localhost", "Content-Type": "application/json" },
      body: oversizedStream,
      duplex: "half",
    }),
  );
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, "PAYLOAD_TOO_LARGE");

  // Exact 1MiB payload (1,048,576 bytes) with empty operations is accepted (200) without writing
  const baseEmptyOpsJson = '{"operations":[]}';
  const exactOneMiB = " ".repeat(MAX_ENHANCEMENT_STATE_BODY_BYTES - baseEmptyOpsJson.length) + baseEmptyOpsJson;
  assert.equal(Buffer.byteLength(exactOneMiB, "utf8"), MAX_ENHANCEMENT_STATE_BODY_BYTES);
  res = await POST(postRequest(exactOneMiB, { raw: true }));
  assert.equal(res.status, 200);

  // Exact 1MiB + 1 byte payload (1,048,577 bytes) is rejected with 413
  const oneMiBPlusOne = " " + exactOneMiB;
  assert.equal(Buffer.byteLength(oneMiBPlusOne, "utf8"), MAX_ENHANCEMENT_STATE_BODY_BYTES + 1);
  res = await POST(postRequest(oneMiBPlusOne, { raw: true }));
  assert.equal(res.status, 413);

  // Verify zero modifications on disk across all rejected requests
  assert.deepEqual(snapshotDirectoryHashes(stateDir), baselineHashes);
});

test("client instance parameter cannot select another directory and different instances stay isolated", async () => {
  const dirA = createIsolatedAgentDir("pi-enh-instance-a-");
  const dirB = createIsolatedAgentDir("pi-enh-instance-b-");

  initializeTempStore(dirA, {
    sessionTagsDefinitions: [{ id: "tag-a", name: "InstanceA", color: "#111111" }],
    sessionTagMappings: {},
    sessionColors: { "sess-a": "red" },
  });
  initializeTempStore(dirB, {
    sessionTagsDefinitions: [{ id: "tag-b", name: "InstanceB", color: "#222222" }],
    sessionTagMappings: {},
    sessionColors: { "sess-b": "green" },
  });

  const dirBHashesBefore = snapshotDirectoryHashes(join(dirB, "state", "enhancement-state"));

  // Active instance is dirA, but client passes ?instance=30142 or ?instance=dirB
  process.env.PI_CODING_AGENT_DIR = dirA;
  const getResA = await GET(
    getRequest(`/api/enhancement-state?instance=${encodeURIComponent(dirB)}`),
  );
  assert.equal(getResA.status, 200);
  const bodyA = await getResA.json();
  assert.equal(bodyA.state.sessionTagsDefinitions[0].id, "tag-a");

  const postResA = await POST(
    postRequest(
      {
        operations: [
          {
            opId: "op-inst-a-1",
            type: "session_color_set",
            sessionId: "sess-a",
            color: "blue",
          },
        ],
      },
      {
        pathAndQuery: `/api/enhancement-state/operations?instance=30142&agentDir=${encodeURIComponent(dirB)}`,
      },
    ),
  );
  assert.equal(postResA.status, 200);

  // dirB was untouched while dirA was active
  assert.deepEqual(
    snapshotDirectoryHashes(join(dirB, "state", "enhancement-state")),
    dirBHashesBefore,
  );

  // Switch active instance to dirB: reads and writes only dirB
  process.env.PI_CODING_AGENT_DIR = dirB;
  const getResB = await GET(getRequest("/api/enhancement-state?instance=30141"));
  assert.equal(getResB.status, 200);
  const bodyB = await getResB.json();
  assert.equal(bodyB.revision, 1);
  assert.equal(bodyB.state.sessionTagsDefinitions[0].id, "tag-b");
  assert.equal(bodyB.state.sessionColors["sess-a"], undefined);
});

test("same-origin authentication boundary via proxy.ts protects enhancement-state routes without CORS or anonymous bypass", () => {
  process.env.PI_WEB_PASSWORD = "test-secret-password";
  const token = createWebSessionToken("test-secret-password");

  for (const path of ["/api/enhancement-state", "/api/enhancement-state/operations"]) {
    // Anonymous request is rejected with 401
    const unauthRes = proxy(
      new NextRequest(`http://localhost${path}`, {
        headers: { Host: "localhost" },
      }),
    );
    assert.equal(unauthRes.status, 401);

    // Cross-origin request is rejected with 403 even with a valid session cookie
    const crossOriginRes = proxy(
      new NextRequest(`http://localhost${path}`, {
        headers: {
          Host: "localhost",
          Origin: "http://evil.example.com",
          Cookie: `pi_web_session=${token}`,
        },
      }),
    );
    assert.equal(crossOriginRes.status, 403);

    // Same-origin authenticated request passes
    const authRes = proxy(
      new NextRequest(`http://localhost${path}`, {
        headers: {
          Host: "localhost",
          Origin: "http://localhost",
          Cookie: `pi_web_session=${token}`,
        },
      }),
    );
    assert.equal(authRes.status, 200);
    assert.equal(authRes.headers.get("x-middleware-next"), "1");
    assert.equal(authRes.headers.get("access-control-allow-origin"), null);
  }

  // Verify HEAD /api/enhancement-state specifically through proxy and route handler
  const unauthHeadRes = proxy(
    new NextRequest("http://localhost/api/enhancement-state", {
      method: "HEAD",
      headers: { Host: "localhost" },
    }),
  );
  assert.equal(unauthHeadRes.status, 401);

  const crossOriginHeadRes = proxy(
    new NextRequest("http://localhost/api/enhancement-state", {
      method: "HEAD",
      headers: {
        Host: "localhost",
        Origin: "http://evil.example.com",
        Cookie: `pi_web_session=${token}`,
      },
    }),
  );
  assert.equal(crossOriginHeadRes.status, 403);

  const authHeadRes = proxy(
    new NextRequest("http://localhost/api/enhancement-state", {
      method: "HEAD",
      headers: {
        Host: "localhost",
        Origin: "http://localhost",
        Cookie: `pi_web_session=${token}`,
      },
    }),
  );
  assert.equal(authHeadRes.status, 200);
  assert.equal(authHeadRes.headers.get("x-middleware-next"), "1");
  assert.equal(authHeadRes.headers.get("access-control-allow-origin"), null);
});

test("HEAD /api/enhancement-state reports absent, present, and current-only without reading or modifying disk", async () => {
  // 1. Absent when state directory does not exist (even with legacy models.json present)
  const absentDir = createIsolatedAgentDir("pi-enh-head-absent-");
  process.env.PI_CODING_AGENT_DIR = absentDir;
  writeFileSync(
    join(absentDir, "models.json"),
    JSON.stringify({
      providers: {},
      sessionTagsDefinitions: [{ id: "legacy-1", name: "Legacy" }],
    }),
    "utf8",
  );
  const absentBefore = snapshotDirectoryHashes(absentDir);

  const headAbsentRes = await HEAD(headRequest());
  assert.equal(headAbsentRes.status, 200);
  assert.equal(headAbsentRes.headers.get("x-pi-enhancement-state"), "absent");
  assert.match(headAbsentRes.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(headAbsentRes.headers.get("access-control-allow-origin"), null);
  assert.equal(await headAbsentRes.text(), "");
  assert.equal(existsSync(join(absentDir, "state", "enhancement-state")), false);
  assert.deepEqual(snapshotDirectoryHashes(absentDir), absentBefore);

  // 2. Present when current.json exists alone (current-only must NOT be misclassified as absent/fresh, and corrupt content is not read)
  const currentOnlyDir = createIsolatedAgentDir("pi-enh-head-current-only-");
  process.env.PI_CODING_AGENT_DIR = currentOnlyDir;
  const currentOnlyStateDir = join(currentOnlyDir, "state", "enhancement-state");
  mkdirSync(currentOnlyStateDir, { recursive: true });
  writeFileSync(join(currentOnlyStateDir, "current.json"), "{corrupted-unreadable-json", "utf8");
  const currentOnlyBefore = snapshotDirectoryHashes(currentOnlyDir);

  const headCurrentOnlyRes = await HEAD(headRequest());
  assert.equal(headCurrentOnlyRes.status, 200);
  assert.equal(headCurrentOnlyRes.headers.get("x-pi-enhancement-state"), "present");
  assert.match(headCurrentOnlyRes.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(headCurrentOnlyRes.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(snapshotDirectoryHashes(currentOnlyDir), currentOnlyBefore);

  // 3. Present when initialized normally (both journal.jsonl and current.json exist)
  const presentDir = createIsolatedAgentDir("pi-enh-head-present-");
  process.env.PI_CODING_AGENT_DIR = presentDir;
  initializeTempStore(presentDir);
  const presentBefore = snapshotDirectoryHashes(presentDir);

  const headPresentRes = await HEAD(headRequest());
  assert.equal(headPresentRes.status, 200);
  assert.equal(headPresentRes.headers.get("x-pi-enhancement-state"), "present");
  assert.match(headPresentRes.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(headPresentRes.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(snapshotDirectoryHashes(presentDir), presentBefore);

  // 4. Untrusted cross-site HEAD request is rejected with 403 and no CORS
  const untrustedHeadRes = await HEAD(
    new Request("http://localhost/api/enhancement-state", {
      method: "HEAD",
      headers: {
        Host: "evil.example.com",
        Origin: "http://evil.example.com",
      },
    }),
  );
  assert.equal(untrustedHeadRes.status, 403);
  assert.equal(untrustedHeadRes.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(snapshotDirectoryHashes(presentDir), presentBefore);
});
