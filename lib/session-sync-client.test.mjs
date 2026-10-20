import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_SYNC_PROTOCOL,
  buildSessionSyncUrl,
  bumpSessionEpoch,
  getSessionEpoch,
  isEpochFresh,
  invalidatesSessionHistory,
  isSessionMemoryCacheEnabled,
  reconcileSyncResponse,
  resetSyncClientStateForTests,
  reuseMessageObjects,
} from "./session-sync-client.ts";
import {
  deleteSessionViewSnapshot,
  deleteSessionWireBaseline,
  getSessionViewSnapshot,
  getSessionWireBaseline,
  resetSessionViewCacheForTests,
  setSessionViewSnapshot,
  setSessionWireBaseline,
} from "./session-view-cache.ts";

function createMockMessage(role, content, id) {
  return id ? { role, content, id } : { role, content };
}

function createBaseline(sessionId, revision, messages, entryIds) {
  return {
    sessionId,
    revision,
    messages,
    entryIds,
    savedAt: Date.now(),
  };
}

test("buildSessionSyncUrl adds sync=1 and baseRevision when enabled, drops them when disabled", () => {
  const urlEnabled = buildSessionSyncUrl({
    sessionId: "sess-123",
    baseRevision: "rev-abc",
    force: false,
    syncEnabled: true,
  });
  assert.ok(urlEnabled.includes("sync=1"));
  assert.ok(urlEnabled.includes("baseRevision=rev-abc"));
  assert.ok(urlEnabled.includes("/api/sessions/sess-123"));

  const urlDisabled = buildSessionSyncUrl({
    sessionId: "sess-123",
    baseRevision: "rev-abc",
    force: false,
    syncEnabled: false,
  });
  assert.ok(!urlDisabled.includes("sync="));
  assert.ok(!urlDisabled.includes("baseRevision="));
  assert.ok(urlDisabled.includes("/api/sessions/sess-123"));

  const urlForce = buildSessionSyncUrl({
    sessionId: "sess-123",
    force: true,
    syncEnabled: true,
  });
  assert.ok(urlForce.includes("force=1"));
  assert.ok(urlForce.includes("sync=1"));
});

test("isSessionMemoryCacheEnabled inspects pi-enh-settings-v1 and legacy keys", () => {
  // 1. Default (no storage) => true
  assert.equal(isSessionMemoryCacheEnabled({ getItem: () => null }), true);

  // 2. Disabled via features in pi-enh-settings-v1
  const storageFeatureDisabled = {
    getItem: (key) =>
      key === "pi-enh-settings-v1"
        ? JSON.stringify({
            schemaVersion: 1,
            modules: { "local-workspace": { enabled: true } },
            features: { "session-memory-cache": { enabled: false } },
          })
        : null,
  };
  assert.equal(isSessionMemoryCacheEnabled(storageFeatureDisabled), false);

  // 3. Disabled via module in pi-enh-settings-v1
  const storageModuleDisabled = {
    getItem: (key) =>
      key === "pi-enh-settings-v1"
        ? JSON.stringify({
            schemaVersion: 1,
            modules: { "local-workspace": { enabled: false } },
            features: { "session-memory-cache": { enabled: true } },
          })
        : null,
  };
  assert.equal(isSessionMemoryCacheEnabled(storageModuleDisabled), false);

  // 4. Enabled via pi-enh-settings-v1
  const storageEnabled = {
    getItem: (key) =>
      key === "pi-enh-settings-v1"
        ? JSON.stringify({
            schemaVersion: 1,
            modules: { "local-workspace": { enabled: true } },
            features: { "session-memory-cache": { enabled: true } },
          })
        : null,
  };
  assert.equal(isSessionMemoryCacheEnabled(storageEnabled), true);

  // 5. Fallback legacy key
  const storageLegacyFalse = {
    getItem: (key) => (key === "pi-enh-plugin-session-memory-cache" ? "false" : null),
  };
  assert.equal(isSessionMemoryCacheEnabled(storageLegacyFalse), false);

  const storageLegacyTrue = {
    getItem: (key) => (key === "pi-enh-plugin-session-memory-cache" ? "true" : null),
  };
  assert.equal(isSessionMemoryCacheEnabled(storageLegacyTrue), true);
});

test("unchanged response preserves current paged messages and returns revision", () => {
  const result = reconcileSyncResponse({
    sessionId: "sess-1",
    status: 200,
    payload: {
      protocol: 1,
      mode: "unchanged",
      revision: "rev-same",
    },
    wireBaseline: createBaseline("sess-1", "rev-same", [], []),
    currentMessages: [createMockMessage("user", "paged message")],
    currentEntryIds: ["e-paged"],
  });

  assert.equal(result.action, "unchanged");
  assert.equal(result.revision, "rev-same");
  assert.equal(result.preserveCurrentMessages, true);
});

test("delta merges retained messages with tailMessages and reuses existing objects", () => {
  const m1 = createMockMessage("user", "first", "id-1");
  const m2 = createMockMessage("assistant", "second", "id-2");
  const m3New = createMockMessage("assistant", "third", "id-3");

  const baseline = createBaseline("sess-1", "rev-1", [m1, m2], ["e-1", "e-2"]);

  const result = reconcileSyncResponse({
    sessionId: "sess-1",
    status: 200,
    payload: {
      protocol: 1,
      mode: "delta",
      baseRevision: "rev-1",
      revision: "rev-2",
      dropCount: 0,
      keepCount: 2,
      tailMessages: [m3New],
      data: {
        sessionId: "sess-1",
        context: {
          entryIds: ["e-1", "e-2", "e-3"],
        },
      },
    },
    wireBaseline: baseline,
  });

  assert.equal(result.action, "delta");
  assert.equal(result.revision, "rev-2");
  assert.equal(result.data.context.messages.length, 3);
  assert.deepEqual(result.data.context.entryIds, ["e-1", "e-2", "e-3"]);
  // Object identity reuse
  assert.equal(result.data.context.messages[0], m1);
  assert.equal(result.data.context.messages[1], m2);
  assert.equal(result.newWireBaseline?.revision, "rev-2");
  assert.deepEqual(result.newWireBaseline?.entryIds, ["e-1", "e-2", "e-3"]);
});

test("delta handles moving window with dropCount > 0", () => {
  const m1 = createMockMessage("user", "msg1", "id-1");
  const m2 = createMockMessage("assistant", "msg2", "id-2");
  const m3 = createMockMessage("user", "msg3", "id-3");
  const m4Tail = createMockMessage("assistant", "msg4", "id-4");

  const baseline = createBaseline("sess-1", "rev-1", [m1, m2, m3], ["e-1", "e-2", "e-3"]);

  // Drop m1 (dropCount: 1), keep m2 and m3 (keepCount: 2), append m4Tail
  const result = reconcileSyncResponse({
    sessionId: "sess-1",
    status: 200,
    payload: {
      protocol: 1,
      mode: "delta",
      baseRevision: "rev-1",
      revision: "rev-2",
      dropCount: 1,
      keepCount: 2,
      tailMessages: [m4Tail],
      data: {
        sessionId: "sess-1",
        context: {
          entryIds: ["e-2", "e-3", "e-4"],
        },
      },
    },
    wireBaseline: baseline,
  });

  assert.equal(result.action, "delta");
  assert.equal(result.data.context.messages.length, 3);
  assert.equal(result.data.context.messages[0], m2);
  assert.equal(result.data.context.messages[1], m3);
  assert.equal(result.data.context.messages[2].content, "msg4");
  assert.deepEqual(result.data.context.entryIds, ["e-2", "e-3", "e-4"]);
});

test("same-ID message content edit updates without corrupting object reuse", () => {
  const oldMsg = createMockMessage("assistant", "streaming partial...", "tool-run-1");
  const newMsgSameId = createMockMessage("assistant", "completed full result!", "tool-run-1");

  // reuseMessageObjects directly
  const reused = reuseMessageObjects([newMsgSameId], [oldMsg]);
  // Because content changed, it should NOT reuse the old object reference
  assert.notEqual(reused[0], oldMsg);
  assert.equal(reused[0].content, "completed full result!");

  // If content is identical, it SHOULD reuse
  const identicalMsg = createMockMessage("assistant", "completed full result!", "tool-run-1");
  const reusedIdentical = reuseMessageObjects([identicalMsg], [reused[0]]);
  assert.equal(reusedIdentical[0], reused[0]);
});

test("reset mode handles authoritative snapshot with string revision or null revision", () => {
  const m1 = createMockMessage("user", "fresh");
  const resetWithRev = reconcileSyncResponse({
    sessionId: "sess-1",
    status: 200,
    payload: {
      protocol: 1,
      mode: "reset",
      revision: "rev-fresh",
      data: {
        sessionId: "sess-1",
        context: {
          messages: [m1],
          entryIds: ["e-fresh"],
        },
      },
    },
    wireBaseline: null,
  });

  assert.equal(resetWithRev.action, "reset");
  assert.equal(resetWithRev.revision, "rev-fresh");
  assert.equal(resetWithRev.newWireBaseline?.revision, "rev-fresh");

  // Running/unstable state has null revision => safe to display, but not safe to cache as fresh wire baseline
  const resetWithNullRev = reconcileSyncResponse({
    sessionId: "sess-1",
    status: 200,
    payload: {
      protocol: 1,
      mode: "reset",
      revision: null,
      data: {
        sessionId: "sess-1",
        context: {
          messages: [m1],
          entryIds: ["e-fresh"],
        },
      },
    },
    wireBaseline: null,
  });

  assert.equal(resetWithNullRev.action, "reset");
  assert.equal(resetWithNullRev.revision, null);
  assert.equal(resetWithNullRev.newWireBaseline, null);
});

test("malformed delta safely returns invalid_delta instead of throwing", () => {
  const baseline = createBaseline("sess-1", "rev-1", [createMockMessage("user", "a")], ["e-1"]);

  // 1. Revision mismatch
  const mismatch = reconcileSyncResponse({
    sessionId: "sess-1",
    status: 200,
    payload: {
      protocol: 1,
      mode: "delta",
      baseRevision: "rev-wrong",
      revision: "rev-2",
      dropCount: 0,
      keepCount: 1,
      tailMessages: [],
      data: { sessionId: "sess-1", context: { entryIds: ["e-1"] } },
    },
    wireBaseline: baseline,
  });
  assert.equal(mismatch.action, "invalid_delta");

  // 2. dropCount + keepCount out of bounds
  const outOfBounds = reconcileSyncResponse({
    sessionId: "sess-1",
    status: 200,
    payload: {
      protocol: 1,
      mode: "delta",
      baseRevision: "rev-1",
      revision: "rev-2",
      dropCount: 1,
      keepCount: 2, // 1 + 2 > 1
      tailMessages: [],
      data: { sessionId: "sess-1", context: { entryIds: ["e-1"] } },
    },
    wireBaseline: baseline,
  });
  assert.equal(outOfBounds.action, "invalid_delta");

  // 3. EntryId mismatch
  const idMismatch = reconcileSyncResponse({
    sessionId: "sess-1",
    status: 200,
    payload: {
      protocol: 1,
      mode: "delta",
      baseRevision: "rev-1",
      revision: "rev-2",
      dropCount: 0,
      keepCount: 1,
      tailMessages: [],
      data: { sessionId: "sess-1", context: { entryIds: ["e-different"] } },
    },
    wireBaseline: baseline,
  });
  assert.equal(idMismatch.action, "invalid_delta");
});

test("legacy 0.9.1 server response is consumed cleanly without errors", () => {
  const legacyPayload = {
    sessionId: "sess-legacy",
    filePath: "/tmp/sess.jsonl",
    tree: [],
    context: {
      messages: [{ role: "user", content: "legacy hello" }],
      entryIds: ["e-legacy-1"],
      thinkingLevel: "off",
      model: null,
    },
    snapshotRevision: "rev-legacy-100",
  };

  const result = reconcileSyncResponse({
    sessionId: "sess-legacy",
    status: 200,
    payload: legacyPayload,
    wireBaseline: null,
  });

  assert.equal(result.action, "legacy");
  assert.equal(result.revision, "rev-legacy-100");
  assert.equal(result.data.sessionId, "sess-legacy");
  assert.equal(result.data.context.messages[0].content, "legacy hello");
  assert.equal(result.newWireBaseline?.revision, "rev-legacy-100");
});

test("404 and 401 return not_found and unauthorized, invalidating cache without resurrection", () => {
  resetSessionViewCacheForTests();
  setSessionViewSnapshot({
    sessionId: "s-gone",
    revision: "rev-gone",
    messages: [{ role: "user", content: "old" }],
    entryIds: ["e-old"],
    leafId: "e-old",
    oldestEntryId: "e-old",
    hasMore: false,
    thinkingLevel: "off",
    model: null,
    loadedEntryIds: ["e-old"],
  });
  setSessionWireBaseline({
    sessionId: "s-gone",
    revision: "rev-gone",
    messages: [{ role: "user", content: "old" }],
    entryIds: ["e-old"],
  });

  assert.ok(getSessionViewSnapshot("s-gone"));
  assert.ok(getSessionWireBaseline("s-gone"));

  const res404 = reconcileSyncResponse({
    sessionId: "s-gone",
    status: 404,
    payload: null,
    wireBaseline: getSessionWireBaseline("s-gone"),
  });
  assert.equal(res404.action, "not_found");

  // Invalidate on 404
  deleteSessionViewSnapshot("s-gone");
  deleteSessionWireBaseline("s-gone");
  assert.equal(getSessionViewSnapshot("s-gone"), null);
  assert.equal(getSessionWireBaseline("s-gone"), null);

  const res401 = reconcileSyncResponse({
    sessionId: "s-unauth",
    status: 401,
    payload: null,
    wireBaseline: null,
  });
  assert.equal(res401.action, "unauthorized");
});

test("epoch protection drops stale responses after send, SSE, or force requests", () => {
  resetSyncClientStateForTests();
  const sid = "sess-epoch";
  assert.equal(getSessionEpoch(sid), 0);

  // Request started at epoch 0
  const reqEpoch = getSessionEpoch(sid);
  assert.equal(isEpochFresh(sid, reqEpoch), true);

  // SSE event arrives or user sends a message -> epoch bumps
  bumpSessionEpoch(sid);
  assert.equal(getSessionEpoch(sid), 1);

  // Old response arriving now is stale!
  assert.equal(isEpochFresh(sid, reqEpoch), false);

  // New request started at epoch 1 is fresh
  const req2Epoch = getSessionEpoch(sid);
  assert.equal(isEpochFresh(sid, req2Epoch), true);

  // User forces refresh -> epoch bumps again
  bumpSessionEpoch(sid);
  assert.equal(isEpochFresh(sid, req2Epoch), false);
});

test("unchanged response preserves wider paged-in history and prevents narrow window overwrite", () => {
  resetSessionViewCacheForTests();
  const sid = "sess-paged";

  // Initial wire baseline (e.g. initial 2 messages)
  const m1 = createMockMessage("user", "msg1", "id-1");
  const m2 = createMockMessage("assistant", "msg2", "id-2");
  setSessionWireBaseline({
    sessionId: sid,
    revision: "rev-wire-1",
    messages: [m1, m2],
    entryIds: ["e-1", "e-2"],
  });

  // User paged in earlier history (e.g. m0 prepended)
  const m0 = createMockMessage("user", "earlier msg0", "id-0");
  const widerMessages = [m0, m1, m2];
  const widerEntryIds = ["e-0", "e-1", "e-2"];

  setSessionViewSnapshot({
    sessionId: sid,
    revision: "rev-wire-1",
    messages: widerMessages,
    entryIds: widerEntryIds,
    leafId: "e-2",
    oldestEntryId: "e-0",
    hasMore: false,
    thinkingLevel: "off",
    model: null,
    loadedEntryIds: ["e-0", "e-1", "e-2"],
  });

  // Server returns unchanged with base revision rev-wire-1
  const wireBaseline = getSessionWireBaseline(sid);
  const result = reconcileSyncResponse({
    sessionId: sid,
    status: 200,
    payload: {
      protocol: 1,
      mode: "unchanged",
      revision: "rev-wire-1",
    },
    wireBaseline,
    currentMessages: widerMessages,
    currentEntryIds: widerEntryIds,
  });

  assert.equal(result.action, "unchanged");
  assert.equal(result.preserveCurrentMessages, true);

  // In hook logic: on unchanged, view snapshot is updated with current (wider) messages,
  // NOT wire baseline's narrow messages:
  setSessionViewSnapshot({
    sessionId: sid,
    revision: result.revision,
    messages: widerMessages,
    entryIds: widerEntryIds,
    leafId: "e-2",
    oldestEntryId: "e-0",
    hasMore: false,
    thinkingLevel: "off",
    model: null,
    loadedEntryIds: widerEntryIds,
  });

  const saved = getSessionViewSnapshot(sid);
  assert.equal(saved?.messages.length, 3);
  assert.deepEqual(saved?.entryIds, ["e-0", "e-1", "e-2"]);
  // Ensure the wire baseline remains untouched as the exact wire window
  const storedWire = getSessionWireBaseline(sid);
  assert.equal(storedWire?.messages.length, 2);
  assert.deepEqual(storedWire?.entryIds, ["e-1", "e-2"]);
});


test("reconnection invalidates a history flight begun before the handshake", () => {
  resetSyncClientStateForTests();
  const sid = "reconnect-flight", oldEpoch = getSessionEpoch(sid);
  assert.equal(invalidatesSessionHistory("connected"), true);
  bumpSessionEpoch(sid);
  assert.equal(isEpochFresh(sid, oldEpoch), false);
  assert.equal(invalidatesSessionHistory("message_update"), false);
});
