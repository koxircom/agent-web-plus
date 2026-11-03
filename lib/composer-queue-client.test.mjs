import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  clearQueueDetailCache,
  deleteQueuedMessage,
  estimateDetailBytes,
  fetchQueueActions,
  fetchQueuedMessageDetail,
  getFromDetailCache,
  getQueueDetailCacheStats,
  matchQueueEntries,
  MAX_QUEUE_DETAIL_CACHE_BYTES,
  MAX_QUEUE_DETAIL_CACHE_ITEMS,
  promoteQueuedMessage,
  putIntoDetailCache,
  recallAllQueuedMessages,
  recallSingleQueuedMessage,
  reorderQueuedMessages,
} = await jiti.import("./composer-queue-client.ts");

const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("duplicate text portraits: messages with identical text are isolated by token and not claimed by text", async () => {
  clearQueueDetailCache();
  const sessionId = "session-duplicate-text";

  const entries = [
    { kind: "steer", text: "同样的任务指令" },
    { kind: "steer", text: "同样的任务指令" },
  ];

  const snapshot = {
    version: 2,
    steering: [
      { token: "tok-img-1", text: "同样的任务指令", imageCount: 1 },
      { token: "tok-img-2", text: "同样的任务指令", imageCount: 2 },
    ],
    followUp: [],
  };

  const matched = matchQueueEntries(entries, snapshot);
  assert.ok(matched);
  assert.equal(matched.length, 2);
  assert.equal(matched[0].token, "tok-img-1");
  assert.equal(matched[1].token, "tok-img-2");

  // Put two different portraits into the detail cache
  putIntoDetailCache(sessionId, "tok-img-1", {
    token: "tok-img-1",
    text: "同样的任务指令",
    kind: "steering",
    images: [{ data: VALID_PNG_BASE64, mimeType: "image/png", alt: "任务图 1" }],
  });
  putIntoDetailCache(sessionId, "tok-img-2", {
    token: "tok-img-2",
    text: "同样的任务指令",
    kind: "steering",
    images: [
      { data: VALID_PNG_BASE64, mimeType: "image/png", alt: "任务图 2A" },
      { data: VALID_PNG_BASE64, mimeType: "image/png", alt: "任务图 2B" },
    ],
  });

  const detail1 = getFromDetailCache(sessionId, "tok-img-1");
  const detail2 = getFromDetailCache(sessionId, "tok-img-2");
  assert.equal(detail1?.images.length, 1);
  assert.equal(detail1?.images[0].alt, "任务图 1");
  assert.equal(detail2?.images.length, 2);
  assert.equal(detail2?.images[1].alt, "任务图 2B");
});

test("empty queue and mismatched snapshot: empty[] is authoritative and rejects mismatched claims", () => {
  // 1. Empty entries match empty snapshot
  const emptyMatched = matchQueueEntries([], {
    version: 2,
    steering: [],
    followUp: [],
  });
  assert.deepEqual(emptyMatched, []);

  // 2. Mismatched length rejects
  const mismatchedLen = matchQueueEntries([{ kind: "steer", text: "任务" }], {
    version: 2,
    steering: [],
    followUp: [],
  });
  assert.equal(mismatchedLen, null);

  // 3. Mismatched kind rejects
  const mismatchedKind = matchQueueEntries([{ kind: "steer", text: "任务" }], {
    version: 2,
    steering: [],
    followUp: [{ token: "tok-1", text: "任务", imageCount: 0 }],
  });
  assert.equal(mismatchedKind, null);

  // 4. Mismatched text rejects
  const mismatchedText = matchQueueEntries([{ kind: "steer", text: "客户端任务" }], {
    version: 2,
    steering: [{ token: "tok-1", text: "服务端不同任务", imageCount: 0 }],
    followUp: [],
  });
  assert.equal(mismatchedText, null);

  // 5. Non-v2 snapshot rejects
  const nonV2 = matchQueueEntries([{ kind: "steer", text: "任务" }], {
    version: 1,
    steering: [{ token: "tok-1", text: "任务", imageCount: 0 }],
    followUp: [],
  });
  assert.equal(nonV2, null);
});

test("failed delete / promote / reorder: returns error and does not mutate client state optimistically", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Mock server returning failure
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: false, error: "Queue item locked or missing" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    await assert.rejects(
      async () => {
        await deleteQueuedMessage("session-fail", "stale-token");
      },
      (err) => {
        assert.match(String(err), /Queue item locked or missing/);
        return true;
      },
    );

    await assert.rejects(
      async () => {
        await promoteQueuedMessage("session-fail", "stale-token");
      },
      (err) => {
        assert.match(String(err), /Queue item locked or missing/);
        return true;
      },
    );

    await assert.rejects(
      async () => {
        await reorderQueuedMessages("session-fail", ["t1", "t2"], "t1", "t2");
      },
      (err) => {
        assert.match(String(err), /Queue item locked or missing/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reload state and LRU eviction: limits to 30 items, 24MiB, single-flight dedup, and clean isolation", async () => {
  clearQueueDetailCache();
  const sessionId = "session-lru-test";

  // 1. Insert 35 items into cache; only the latest 30 survive
  for (let i = 1; i <= 35; i++) {
    putIntoDetailCache(sessionId, `token-${i}`, {
      token: `token-${i}`,
      text: `队列条目 ${i}`,
      kind: "followUp",
      images: [],
    });
  }

  const stats = getQueueDetailCacheStats();
  assert.equal(stats.count, MAX_QUEUE_DETAIL_CACHE_ITEMS);
  assert.equal(getFromDetailCache(sessionId, "token-1"), null); // Oldest evicted
  assert.ok(getFromDetailCache(sessionId, "token-35")); // Newest retained

  // 2. Single-flight dedup: concurrent fetches for the same token share one underlying HTTP request
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 10));
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            version: 2,
            token: "dedup-tok",
            text: "单一并发内容",
            kind: "followUp",
            images: [],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const [res1, res2] = await Promise.all([
      fetchQueuedMessageDetail("session-flight", "dedup-tok"),
      fetchQueuedMessageDetail("session-flight", "dedup-tok"),
    ]);

    assert.equal(fetchCount, 1);
    assert.equal(res1?.token, "dedup-tok");
    assert.equal(res2?.token, "dedup-tok");
  } finally {
    globalThis.fetch = originalFetch;
  }

  // 3. Clean by session: does not affect other sessions
  putIntoDetailCache("session-other", "tok-other", {
    token: "tok-other",
    text: "其他会话",
    kind: "steering",
    images: [],
  });
  clearQueueDetailCache("session-lru-test");
  assert.equal(getFromDetailCache("session-lru-test", "token-35"), null);
  assert.ok(getFromDetailCache("session-other", "tok-other"));
});

test("route race: AbortController aborts previous session request preventing cross-session pollution", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      if (init?.signal) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 50);
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      }
      return new Response(JSON.stringify({ success: true, data: { version: 2, steering: [], followUp: [] } }));
    };

    const controllerA = new AbortController();
    const promiseA = fetchQueueActions("session-a", controllerA.signal);
    // User rapidly navigated to session B
    controllerA.abort();

    const resultA = await promiseA;
    assert.equal(resultA, null); // Aborted session A returns null and never pollutes state

    // 2. Single-flight external signal abort does not contaminate concurrent or subsequent non-aborted subscriber
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(
        JSON.stringify({
          success: true,
          data: { token: "tok-race", text: "并发文本", kind: "steering", images: [] },
        }),
      );
    };

    const ctrlA = new AbortController();
    const reqA = fetchQueuedMessageDetail("sess-race", "tok-race", ctrlA.signal);
    ctrlA.abort();

    const reqB = fetchQueuedMessageDetail("sess-race", "tok-race");

    const resA = await reqA;
    const resB = await reqB;

    assert.equal(resA, null, "Caller A got aborted null");
    assert.ok(resB, "Caller B got valid detail without being poisoned by A's abort");
    assert.equal(resB?.token, "tok-race");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("recall and recallAll recovery: capacity guard, atomic restore, and explicit network uncertainty error", async () => {
  clearQueueDetailCache();
  const sessionId = "session-recall-test";
  const token = "tok-recall-1";

  putIntoDetailCache(sessionId, token, {
    token,
    text: "要移回的消息",
    kind: "steering",
    images: [
      { data: VALID_PNG_BASE64, mimeType: "image/png" },
      { data: VALID_PNG_BASE64, mimeType: "image/png" },
    ],
  });

  // 0. Missing onRestoreRecall must reject upfront without mutating or calling RPC
  await assert.rejects(
    async () => {
      await recallSingleQueuedMessage({
        sessionId,
        token,
        getDraftImageCount: () => 0,
      });
    },
    (err) => {
      assert.match(String(err), /缺少移回输入框处理回调/);
      return true;
    },
  );

  // 1. Capacity guard: draft already has 9 images, recalling 2 would exceed MAX_ATTACHED_IMAGES (10)
  await assert.rejects(
    async () => {
      await recallSingleQueuedMessage({
        sessionId,
        token,
        getDraftImageCount: () => 9,
        onRestoreRecall: async () => true,
      });
    },
    (err) => {
      assert.match(String(err), /超过 10 张上限/);
      return true;
    },
  );

  // 2. Normal recall: atomic restore to draft key
  const originalFetch = globalThis.fetch;
  let restoredPayload = null;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: 2,
            token,
            text: "要移回的消息",
            kind: "steering",
            requestId: "req-123",
            images: [
              { data: VALID_PNG_BASE64, mimeType: "image/png" },
              { data: VALID_PNG_BASE64, mimeType: "image/png" },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const outcome = await recallSingleQueuedMessage({
      sessionId,
      token,
      getDraftImageCount: () => 0,
      onRestoreRecall: async (payload) => {
        restoredPayload = payload;
        return true;
      },
    });

    assert.equal(outcome.requestId, "req-123");
    assert.equal(outcome.text, "要移回的消息");
    assert.equal(outcome.images.length, 2);
    assert.ok(restoredPayload);
    assert.equal(restoredPayload.sessionId, sessionId);
    assert.equal(restoredPayload.targetDraftKey, sessionId);
    assert.equal(restoredPayload.entries[0].requestId, "req-123");

    // 3. Network uncertainty: throws explicit error without claiming original message is preserved
    globalThis.fetch = async () => {
      throw new Error("Connection reset by peer");
    };

    await assert.rejects(
      async () => {
        await recallSingleQueuedMessage({
          sessionId,
          token,
          getDraftImageCount: () => 0,
          onRestoreRecall: async () => true,
        });
      },
      (err) => {
        assert.match(String(err), /召回操作未确认，请刷新核对队列状态/);
        assert.doesNotMatch(String(err), /原消息已保留/);
        return true;
      },
    );

    // 4. Atomic recallAll
    putIntoDetailCache(sessionId, "tok-all-1", {
      token: "tok-all-1",
      text: "消息一",
      kind: "steering",
      images: [],
    });
    putIntoDetailCache(sessionId, "tok-all-2", {
      token: "tok-all-2",
      text: "消息二",
      kind: "followUp",
      images: [],
    });

    let allRestored = null;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            version: 2,
            entries: [
              { requestId: "r1", token: "tok-all-1", text: "消息一", kind: "steering", images: [] },
              { requestId: "r2", token: "tok-all-2", text: "消息二", kind: "followUp", images: [] },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const allOutcome = await recallAllQueuedMessages({
      sessionId,
      tokens: ["tok-all-1", "tok-all-2"],
      getDraftImageCount: () => 0,
      onRestoreRecall: async (payload) => {
        allRestored = payload;
        return true;
      },
    });

    assert.equal(allOutcome.length, 2);
    assert.ok(allRestored);
    assert.equal(allRestored.entries.length, 2);
    assert.equal(allRestored.entries[0].requestId, "r1");
    assert.equal(allRestored.entries[1].requestId, "r2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
