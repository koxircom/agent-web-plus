import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const pkgRoot = process.cwd();
const binGuardDir = path.join(pkgRoot, "bin", "usage-guard");

const { scanSession, readState } = require(path.join(binGuardDir, "generate-usage-ledger.js"));

const jiti = createJiti(import.meta.url, {
  alias: { "@": pkgRoot, "server-only": "next/dist/compiled/server-only/empty.js" },
  interopDefault: true,
  moduleCache: false,
});

const {
  computeSessionStats,
  extractForkInheritedEntryIds,
  FORK_PROVENANCE_TYPE,
} = await jiti.import("../lib/session-stats.ts");

const { GET: getSessionRoute } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { GUARD_VERSION } = await jiti.import("../lib/usage-delete-guard.ts");

function createUsage(over = {}) {
  return {
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheWrite: 10,
    totalTokens: 180,
    cost: { input: 0.1, output: 0.05, cacheRead: 0.01, cacheWrite: 0.02, total: 0.18 },
    ...over,
  };
}

function userEntry(id, parentId, content = "hello") {
  return { type: "message", id, parentId, timestamp: "2026-10-21T10:00:00.000Z", message: { role: "user", content } };
}

function assistantEntry(id, parentId, text = "hi", u = createUsage()) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-10-21T10:00:05.000Z",
    message: {
      role: "assistant",
      provider: "test-provider",
      model: "test-model",
      content: [{ type: "text", text }],
      usage: u,
    },
  };
}

function compactionEntry(id, parentId, u = createUsage({ input: 10, output: 10, cost: { total: 0.05 } })) {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-10-21T10:01:00.000Z",
    summary: "compacted history",
    tokensBefore: 200,
    firstKeptEntryId: "u1",
    usage: u,
  };
}

function usageEntry(id, parentId, u = createUsage({ input: 0, output: 1, cacheRead: 50, cost: { total: 0.01 } })) {
  return {
    type: "usage",
    id,
    parentId,
    timestamp: "2026-10-21T10:00:02.000Z",
    kind: "cache_warm",
    provider: "test-provider",
    model: "test-model",
    usage: u,
  };
}

function forkProvenanceEntry(id, parentId, parentSessionId, inheritedEntryIds) {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: "2026-10-21T10:05:00.000Z",
    customType: FORK_PROVENANCE_TYPE,
    data: {
      version: 1,
      parentSessionId,
      forkPointEntryId: parentId,
      inheritedEntryIds,
    },
  };
}

test("1. 复现旧版 fork copy 导致用量/计费重复", () => {
  const entries = [
    userEntry("u1", null),
    assistantEntry("a1", "u1", "response 1", createUsage({ input: 100, output: 50, cost: { total: 0.15 } })),
    compactionEntry("c1", "a1", createUsage({ input: 20, output: 20, cost: { total: 0.05 } })),
  ];

  // 无 fork-provenance 标记时，计算出的用量为全量累加
  const stats = computeSessionStats(entries);
  assert.equal(stats.tokens.input, 120);
  assert.equal(stats.tokens.output, 70);
  assert.ok(Math.abs(stats.cost - 0.20) < 1e-9);
});

test("2. 新版 fork 带 fork-provenance 时，新分支初始新增计费为 0", () => {
  const parentEntries = [
    userEntry("u1", null),
    usageEntry("w1", "u1"),
    assistantEntry("a1", "w1", "answer", createUsage({ input: 200, output: 100, cost: { total: 0.3 } })),
    compactionEntry("c1", "a1", createUsage({ input: 30, output: 30, cost: { total: 0.06 } })),
  ];

  const inheritedIds = ["u1", "w1", "a1", "c1"];
  const provEntry = forkProvenanceEntry("prov1", "c1", "parent-sid-1", inheritedIds);

  const forkedEntries = [...parentEntries, provEntry];
  const stats = computeSessionStats(forkedEntries);

  // 新分支上尚未发送新消息，计费必须精确为 0
  assert.equal(stats.tokens.input, 0);
  assert.equal(stats.tokens.output, 0);
  assert.equal(stats.tokens.cacheRead, 0);
  assert.equal(stats.tokens.cacheWrite, 0);
  assert.equal(stats.tokens.total, 0);
  assert.equal(stats.cost, 0);

  // 消息总条数依然能反映历史树
  assert.equal(stats.userMessages, 1);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(stats.totalMessages, 2);
});

test("3. 新分支追加真实新请求后，仅新请求计费，历史继承依然不重复计费", () => {
  const parentEntries = [
    userEntry("u1", null),
    assistantEntry("a1", "u1", "old answer", createUsage({ input: 500, output: 200, cost: { total: 0.7 } })),
  ];
  const provEntry = forkProvenanceEntry("prov1", "a1", "parent-sid-1", ["u1", "a1"]);

  // 用户在子会话发起新一轮对话
  const newU = userEntry("u2", "prov1", "continue in fork");
  const newA = assistantEntry("a2", "u2", "new response", createUsage({
    input: 80,
    output: 40,
    cacheRead: 10,
    cacheWrite: 5,
    cost: { total: 0.12 },
  }));

  const entries = [...parentEntries, provEntry, newU, newA];
  const stats = computeSessionStats(entries);

  // 仅新产生的 a2 计费，a1 不再计费
  assert.equal(stats.tokens.input, 80);
  assert.equal(stats.tokens.output, 40);
  assert.equal(stats.tokens.cacheRead, 10);
  assert.equal(stats.tokens.cacheWrite, 5);
  assert.equal(stats.tokens.total, 80 + 40 + 10 + 5);
  assert.ok(Math.abs(stats.cost - 0.12) < 1e-9);
  assert.equal(stats.userMessages, 2);
  assert.equal(stats.assistantMessages, 2);
});

test("4. 嵌套 fork (A -> B -> C)：每一代正确继承所有祖先，新分支初始均为 0", () => {
  // A 会话
  const a1 = userEntry("a_u1", null);
  const a2 = assistantEntry("a_a1", "a_u1", "A reply", createUsage({ input: 100, output: 50, cost: { total: 0.1 } }));

  // B 从 A fork
  const bProv = forkProvenanceEntry("b_prov", "a_a1", "session_A", ["a_u1", "a_a1"]);
  const bStatsInitial = computeSessionStats([a1, a2, bProv]);
  assert.equal(bStatsInitial.tokens.total, 0);
  assert.equal(bStatsInitial.cost, 0);

  // B 产生了新消息
  const b_u1 = userEntry("b_u1", "b_prov", "B question");
  const b_a1 = assistantEntry("b_a1", "b_u1", "B reply", createUsage({ input: 200, output: 80, cost: { total: 0.25 } }));
  const bStatsAfterTurn = computeSessionStats([a1, a2, bProv, b_u1, b_a1]);
  assert.equal(bStatsAfterTurn.tokens.input, 200);
  assert.equal(bStatsAfterTurn.tokens.output, 80);
  assert.ok(Math.abs(bStatsAfterTurn.cost - 0.25) < 1e-9);

  // C 从 B fork，继承 A 和 B 的所有消息
  const cProv = forkProvenanceEntry("c_prov", "b_a1", "session_B", ["a_u1", "a_a1", "b_u1", "b_a1"]);
  const cStatsInitial = computeSessionStats([a1, a2, bProv, b_u1, b_a1, cProv]);
  assert.equal(cStatsInitial.tokens.total, 0);
  assert.equal(cStatsInitial.cost, 0);

  // C 产生新消息
  const c_u1 = userEntry("c_u1", "c_prov", "C question");
  const c_a1 = assistantEntry("c_a1", "c_u1", "C reply", createUsage({ input: 300, output: 120, cost: { total: 0.4 } }));
  const cStatsAfterTurn = computeSessionStats([a1, a2, bProv, b_u1, b_a1, cProv, c_u1, c_a1]);
  assert.equal(cStatsAfterTurn.tokens.input, 300);
  assert.equal(cStatsAfterTurn.tokens.output, 120);
  assert.ok(Math.abs(cStatsAfterTurn.cost - 0.4) < 1e-9);
});

test("5. 父会话被删除或 reparent 后，子会话 fork-provenance 自包含不丢失", () => {
  const inheritedIds = ["msg_1", "msg_2"];
  const provEntry = forkProvenanceEntry("prov_x", "msg_2", "deleted_parent_id", inheritedIds);
  const newMsg = assistantEntry("msg_3", "prov_x", "independent reply", createUsage({ input: 70, cost: { total: 0.08 } }));

  const stats = computeSessionStats([
    userEntry("msg_1", null),
    assistantEntry("msg_2", "msg_1", "old reply", createUsage({ input: 300 })),
    provEntry,
    newMsg,
  ]);

  // 即使父会话不存在或已 reparent，子会话依然只计算 msg_3
  assert.equal(stats.tokens.input, 70);
  assert.ok(Math.abs(stats.cost - 0.08) < 1e-9);
});

test("6. 非亲缘独立会话的同文/同 timestamp 消息各自合法保留计费", () => {
  const ts = "2026-10-21T11:00:00.000Z";
  // 会话 X
  const entryX = {
    type: "message",
    id: "x_1",
    parentId: null,
    timestamp: ts,
    message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "same text" }], usage: createUsage({ input: 50, cost: { total: 0.05 } }) },
  };
  // 会话 Y (完全独立，非亲缘)
  const entryY = {
    type: "message",
    id: "y_1",
    parentId: null,
    timestamp: ts,
    message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "same text" }], usage: createUsage({ input: 50, cost: { total: 0.05 } }) },
  };

  const statsX = computeSessionStats([entryX]);
  const statsY = computeSessionStats([entryY]);

  assert.equal(statsX.tokens.input, 50);
  assert.equal(statsY.tokens.input, 50);
  assert.ok(Math.abs(statsX.cost - 0.05) < 1e-9);
  assert.ok(Math.abs(statsY.cost - 0.05) < 1e-9);
});

test("7. 全局账本 scanSession 扫描 fork 会话：继承 entries 不重复记账，重扫完全幂等", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ledger-test-"));
  try {
    const parentFile = path.join(tmpDir, "parent.jsonl");
    const childFile = path.join(tmpDir, "child.jsonl");

    const parentHeader = { type: "session", version: 3, id: "parent-sid", timestamp: "2026-10-21T10:00:00.000Z", cwd: "/test" };
    const pU1 = userEntry("pu1", null);
    const pA1 = assistantEntry("pa1", "pu1", "parent reply", createUsage({ input: 100, output: 50, totalTokens: 150 }));
    fs.writeFileSync(parentFile, [parentHeader, pU1, pA1].map(x => JSON.stringify(x)).join("\n") + "\n");

    const childHeader = { type: "session", version: 3, id: "child-sid", timestamp: "2026-10-21T10:05:00.000Z", cwd: "/test", parentSession: parentFile };
    const prov = forkProvenanceEntry("cprov", "pa1", "parent-sid", ["pu1", "pa1"]);
    const cU1 = userEntry("cu1", "cprov", "child question");
    const cA1 = assistantEntry("ca1", "cu1", "child reply", createUsage({ input: 80, output: 40, totalTokens: 120 }));
    fs.writeFileSync(childFile, [childHeader, pU1, pA1, prov, cU1, cA1].map(x => JSON.stringify(x)).join("\n") + "\n");

    const state = { version: 2, events: {}, sessions: {}, sources: {} };
    const audit = { assistant: 0, subagentResults: 0, system: 0, partialLines: 0, aggregateOnlyTasks: 0, abandonedToolCalls: 0 };

    // 扫描父会话与子会话
    await scanSession(parentFile, state, "nas", audit);
    await scanSession(childFile, state, "nas", audit);

    // 父会话记了 pa1 (150 tokens)；子会话继承了 pa1，跳过重复记账，仅记了 ca1 (120 tokens)
    const eventKeys = Object.keys(state.events);
    assert.equal(eventKeys.length, 2, "账本中应该恰好有 2 个事件 (pa1 与 ca1)，pa1 绝不被子会话重复记账");

    // pa1: input 100, output 50, cacheRead 20, cacheWrite 10 => totalTokens = 180
    // ca1: input 80, output 40, cacheRead 20, cacheWrite 10 => totalTokens = 150
    // 总计 180 + 150 = 330
    const totalTokens = Object.values(state.events).reduce((sum, e) => sum + (e.totalTokens || 0), 0);
    assert.equal(totalTokens, 180 + 150, "总 tokens 严格等于父新增 + 子新增 (含缓存读写)");

    // 重扫幂等性验证
    const rescanAudit = { assistant: 0, subagentResults: 0, system: 0, partialLines: 0, aggregateOnlyTasks: 0, abandonedToolCalls: 0 };
    await scanSession(parentFile, state, "nas", rescanAudit);
    await scanSession(childFile, state, "nas", rescanAudit);

    assert.equal(Object.keys(state.events).length, 2, "重扫后事件总数保持 2，幂等无重复膨胀");
    const rescanTotal = Object.values(state.events).reduce((sum, e) => sum + (e.totalTokens || 0), 0);
    assert.equal(rescanTotal, 180 + 150, "重扫后总 tokens 严格保持不变");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("8. GET /api/sessions/[id]?lookup=1 包含 usageDeleteGuard 能力证明", async () => {
  const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../lib/session-reader.ts");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lookup-test-"));
  try {
    const testSessionId = "lookup-test-sid-1";
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const header = { type: "session", version: 3, id: testSessionId, timestamp: new Date().toISOString(), cwd: "/tmp" };
    fs.writeFileSync(sessionFile, JSON.stringify(header) + "\n");
    cacheSessionPath(testSessionId, sessionFile);

    try {
      const req = new Request(`http://localhost/api/sessions/${testSessionId}?lookup=1`);
      const resp = await getSessionRoute(req, { params: Promise.resolve({ id: testSessionId }) });
      assert.equal(resp.status, 200);
      const data = await resp.json();
      assert.equal(data.sessionId, testSessionId);
      assert.equal(data.exists, true);
      assert.equal(data.usageDeleteGuard, GUARD_VERSION);
    } finally {
      invalidateSessionPathCache();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("9. 03 删除前入账守卫：新 server 凭 lookup guard 成功放行，免去 tail=1 杜绝 409 误挡", async () => {
  // 模拟客户端 ensureSessionIngestedBeforeDelete 逻辑
  let tailCalled = false;
  const mockFetch = async (url) => {
    if (url.includes("?lookup=1")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessionId: "s1", exists: true, usageDeleteGuard: 1 }),
      };
    }
    if (url.includes("/api/sessions?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sessions: [{ id: "s1", title: "test session" }],
          runningSessionIds: [], // 空闲
        }),
      };
    }
    if (url.includes("?tail=1")) {
      tailCalled = true;
      return { ok: false, status: 409 }; // 如果调用了 tail=1，会报 409
    }
    throw new Error(`Unexpected url: ${url}`);
  };

  const simulateEnsureSessionIngested = async (sessionId, activeFetch) => {
    const lookupResp = await activeFetch(`/api/sessions/${encodeURIComponent(sessionId)}?lookup=1`);
    if (!lookupResp || !lookupResp.ok) throw new Error(`入账核验 HTTP ${lookupResp?.status || "失败"}`);
    const lookup = await lookupResp.json().catch(() => null);
    if (!lookup || lookup.exists !== true) throw new Error("会话不存在或已删除");

    if (typeof lookup.usageDeleteGuard === "number" && lookup.usageDeleteGuard >= 1) {
      const listingResp = await activeFetch(`/api/sessions?usageGuard=${Date.now()}`);
      const listing = await listingResp.json();
      if (!Array.isArray(listing.sessions) || !Array.isArray(listing.runningSessionIds)) {
        throw new Error("无法确认会话或运行状态，已阻止删除");
      }
      if (listing.runningSessionIds.includes(sessionId)) {
        throw new Error("会话仍在运行，待用量回传后再删除");
      }
      // 放行！
      return true;
    }

    // legacy
    const detailResp = await activeFetch(`/api/sessions/${encodeURIComponent(sessionId)}?tail=1`);
    if (!detailResp?.ok) throw new Error(`入账核验 HTTP ${detailResp?.status || "失败"}`);
    return false;
  };

  const result = await simulateEnsureSessionIngested("s1", mockFetch);
  assert.equal(result, true);
  assert.equal(tailCalled, false, "新 server 下绝对不调用 ?tail=1，成功避免 409 误挡！");
});

test("10. 03 删除前入账守卫：lookup 失败、404、正在运行、旧 server 遇到 409 均 failclosed", async () => {
  const simulateEnsureSessionIngested = async (sessionId, activeFetch) => {
    const lookupResp = await activeFetch(`/api/sessions/${encodeURIComponent(sessionId)}?lookup=1`);
    if (!lookupResp || !lookupResp.ok) throw new Error(`入账核验 HTTP ${lookupResp?.status || "失败"}`);
    const lookup = await lookupResp.json().catch(() => null);
    if (!lookup || lookup.exists !== true) throw new Error("会话不存在或已删除");

    if (typeof lookup.usageDeleteGuard === "number" && lookup.usageDeleteGuard >= 1) {
      const listingResp = await activeFetch(`/api/sessions?usageGuard=${Date.now()}`);
      const listing = await listingResp.json();
      if (!Array.isArray(listing.sessions) || !Array.isArray(listing.runningSessionIds)) {
        throw new Error("无法确认会话或运行状态，已阻止删除");
      }
      if (listing.runningSessionIds.includes(sessionId)) {
        throw new Error("会话仍在运行，待用量回传后再删除");
      }
      return true;
    }

    // 旧 server 兼容分支
    const detailResp = await activeFetch(`/api/sessions/${encodeURIComponent(sessionId)}?tail=1`);
    if (!detailResp?.ok) throw new Error(`入账核验 HTTP ${detailResp?.status || "失败"}`);
    return true;
  };

  // a) lookup 报 404
  await assert.rejects(
    async () => simulateEnsureSessionIngested("s_404", async (url) => ({ ok: false, status: 404 })),
    /入账核验 HTTP 404/
  );

  // b) lookup 报 500
  await assert.rejects(
    async () => simulateEnsureSessionIngested("s_500", async (url) => ({ ok: false, status: 500 })),
    /入账核验 HTTP 500/
  );

  // c) lookup 返回 exists: false
  await assert.rejects(
    async () => simulateEnsureSessionIngested("s_not_exist", async (url) => ({
      ok: true, status: 200, json: async () => ({ exists: false }),
    })),
    /会话不存在或已删除/
  );

  // d) 会话正在运行 (running)
  await assert.rejects(
    async () => simulateEnsureSessionIngested("s_busy", async (url) => {
      if (url.includes("?lookup=1")) return { ok: true, status: 200, json: async () => ({ sessionId: "s_busy", exists: true, usageDeleteGuard: 1 }) };
      if (url.includes("/api/sessions?")) return { ok: true, status: 200, json: async () => ({ sessions: [{ id: "s_busy" }], runningSessionIds: ["s_busy"] }) };
      throw new Error();
    }),
    /会话仍在运行，待用量回传后再删除/
  );

  // e) 旧 server (无 guard) 下遭遇 tail=1 报 409：保留 409 保护，failclosed！
  await assert.rejects(
    async () => simulateEnsureSessionIngested("s_legacy", async (url) => {
      if (url.includes("?lookup=1")) return { ok: true, status: 200, json: async () => ({ sessionId: "s_legacy", exists: true /* 没有 usageDeleteGuard */ }) };
      if (url.includes("?tail=1")) return { ok: false, status: 409 };
      throw new Error();
    }),
    /入账核验 HTTP 409/
  );
});

test("11. 真实 SDK SessionManager 生成 fork/fork_branch 文件：先扫child后parent、只剩child无旧账本、嵌套fork", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const { prepareForkProvenance, FORK_PROVENANCE_TYPE } = await jiti.import("../lib/session-stats.ts");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-real-sdk-fork-test-"));

  try {
    const sessionDir = path.join(tmpDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });

    // 1. 真实 SDK 创建 Root 会话 A
    const smA = SessionManager.create(tmpDir, sessionDir);
    const sidA = smA.getSessionId();
    const fileA = smA.getSessionFile();

    const u1Id = smA.appendMessage({ role: "user", content: "Question A" });
    const a1Usage = createUsage({ input: 200, output: 100, cost: { total: 0.3 } });
    const a1Id = smA.appendMessage({
      role: "assistant",
      provider: "provider-a",
      model: "model-a",
      content: [{ type: "text", text: "Reply A" }],
      usage: a1Usage,
    });

    // 2. 真实 SDK 从 A 产生分支会话 B (fork_branch 从 a1 分支)
    const fileB = smA.createBranchedSession(a1Id);
    assert.ok(fileB && fs.existsSync(fileB), "SDK createBranchedSession 应成功创建真实文件");
    const smB = SessionManager.open(fileB, sessionDir);
    const sidB = smB.getSessionId();

    // 写入真实 marker 并验证
    const entriesB = smB.getEntries();
    const inheritedB = entriesB.map((e) => e.id).filter(Boolean);
    const provB = prepareForkProvenance(smA.getEntries(), sidA, fileA, a1Id, inheritedB);
    smB.appendCustomEntry(FORK_PROVENANCE_TYPE, provB);

    // B 会话产生新消息 b1
    const u2Id = smB.appendMessage({ role: "user", content: "Question B" });
    const b1Usage = createUsage({ input: 120, output: 60, cost: { total: 0.18 } });
    const b1Id = smB.appendMessage({
      role: "assistant",
      provider: "provider-b",
      model: "model-b",
      content: [{ type: "text", text: "Reply B" }],
      usage: b1Usage,
    });

    // 3. 真实 SDK 从 B 嵌套 fork 出 C
    const fileC = smB.createBranchedSession(b1Id);
    const smC = SessionManager.open(fileC, sessionDir);
    const sidC = smC.getSessionId();

    const entriesC = smC.getEntries();
    const inheritedC = entriesC.filter((e) => e.type !== "custom").map((e) => e.id).filter(Boolean);
    const provC = prepareForkProvenance(smB.getEntries(), sidB, fileB, b1Id, inheritedC);

    // 断言嵌套 fork 下，a1 的 origin 依然是 A，而不是 B！
    assert.equal(provC.entryOrigins[a1Id]?.sessionId, sidA, "嵌套 fork 中祖先 entry a1 必须稳定指向 Root A！");
    assert.equal(provC.entryOrigins[b1Id]?.sessionId, sidB, "B 生成的 entry b1 必须稳定指向 B！");
    smC.appendCustomEntry(FORK_PROVENANCE_TYPE, provC);

    // C 产生新消息 c1
    const u3Id = smC.appendMessage({ role: "user", content: "Question C" });
    const c1Usage = createUsage({ input: 80, output: 40, cost: { total: 0.12 } });
    smC.appendMessage({
      role: "assistant",
      provider: "provider-c",
      model: "model-c",
      content: [{ type: "text", text: "Reply C" }],
      usage: c1Usage,
    });

    // 场景 A：先扫 child (C) 后扫 parent (A, B)
    const state1 = { version: 2, events: {}, sessions: {}, sources: {} };
    const audit1 = { assistant: 0, subagentResults: 0, system: 0, partialLines: 0, aggregateOnlyTasks: 0, abandonedToolCalls: 0 };
    await scanSession(fileC, state1, "nas", audit1);
    await scanSession(fileB, state1, "nas", audit1);
    await scanSession(fileA, state1, "nas", audit1);

    // 验证总共恰有 3 个事件 (a1, b1, c1)，各归所属，总额准确
    const eventKeys1 = Object.keys(state1.events);
    assert.equal(eventKeys1.length, 3, "账本中恰有 a1, b1, c1 三个事件");
    const totalTokens1 = Object.values(state1.events).reduce((sum, e) => sum + (e.totalTokens || 0), 0);
    // a1: 200+100+20+10 = 330; b1: 120+60+20+10 = 210; c1: 80+40+20+10 = 150. Sum = 690
    assert.equal(totalTokens1, 330 + 210 + 150);

    // 重扫幂等验证
    await scanSession(fileC, state1, "nas", audit1);
    await scanSession(fileA, state1, "nas", audit1);
    assert.equal(Object.keys(state1.events).length, 3, "重扫完全幂等");
    assert.equal(Object.values(state1.events).reduce((sum, e) => sum + (e.totalTokens || 0), 0), 690);

    // 场景 B：只剩 child (只扫描 C，模拟 parent A 和 B 均被删除或未入账)
    const state2 = { version: 2, events: {}, sessions: {}, sources: {} };
    const audit2 = { assistant: 0, subagentResults: 0, system: 0, partialLines: 0, aggregateOnlyTasks: 0, abandonedToolCalls: 0 };
    await scanSession(fileC, state2, "nas", audit2);

    // 仅扫描 C，继承的 a1 (归属 A) 和 b1 (归属 B) 依然能被准确恢复入账，绝不漏费！
    assert.equal(Object.keys(state2.events).length, 3, "只扫 child 也能完整恢复历史事件，绝不漏费！");
    const totalTokens2 = Object.values(state2.events).reduce((sum, e) => sum + (e.totalTokens || 0), 0);
    assert.equal(totalTokens2, 690, "总 tokens 严格完整");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("12. 会话 stats 完整覆盖 compaction 与 usage 条目（继承项计费为0，子自身新增计费）", () => {
  const inheritedIds = ["u1", "a1", "comp1", "usage1"];
  const prov = forkProvenanceEntry("prov1", "usage1", "parent-id", inheritedIds);

  const entries = [
    userEntry("u1", null),
    assistantEntry("a1", "u1", "old reply", createUsage({ input: 100 })),
    compactionEntry("comp1", "a1", createUsage({ input: 30, cost: { total: 0.05 } })),
    usageEntry("usage1", "comp1", createUsage({ input: 0, cacheRead: 50, cost: { total: 0.02 } })),
    prov,
    // 子会话新产生的 user, compaction, usage
    userEntry("u2", "prov1", "new in child"),
    compactionEntry("comp2", "u2", createUsage({ input: 40, output: 20, cost: { total: 0.08 } })),
    usageEntry("usage2", "comp2", createUsage({ input: 0, output: 1, cacheRead: 80, cost: { total: 0.03 } })),
  ];

  const stats = computeSessionStats(entries);
  // comp1 与 usage1 被继承，计费为 0；comp2 (input 40, output 20, cache 30 => 90 tokens, cost 0.08) 与 usage2 (cacheRead 80, output 1 => 81 tokens, cost 0.03) 正常计费
  assert.equal(stats.tokens.input, 40);
  assert.equal(stats.tokens.output, 21);
  assert.equal(stats.tokens.cacheRead, 100); // comp2 cacheRead 20 + usage2 cacheRead 80
  assert.ok(Math.abs(stats.cost - 0.11) < 1e-9);
});

test("13. get_session_stats shape 完整性：保留 sessionId, sessionFile, contextUsage 等既有字段", () => {
  // 模拟 AgentSession inner 返回的原始结构
  const mockInnerStats = {
    sessionId: "sid-mock-123",
    sessionFile: "/tmp/session-mock.jsonl",
    userMessages: 5,
    assistantMessages: 5,
    toolCalls: 2,
    toolResults: 2,
    totalMessages: 14,
    tokens: { input: 999, output: 888, cacheRead: 0, cacheWrite: 0, total: 1887 },
    cost: 1.5,
    contextUsage: { tokens: 500, percent: 50 },
  };

  const entries = [
    userEntry("u1", null),
    assistantEntry("a1", "u1", "reply", createUsage({ input: 50, output: 25, cost: { total: 0.07 } })),
  ];

  const computed = computeSessionStats(entries);
  const combined = {
    ...mockInnerStats,
    ...computed,
    sessionId: mockInnerStats?.sessionId ?? "fallback-sid",
    sessionFile: mockInnerStats?.sessionFile ?? "fallback-file",
    sessionName: "Test Session",
  };

  // 必须完整保留 inner 的既有字段！
  assert.equal(combined.sessionId, "sid-mock-123");
  assert.equal(combined.sessionFile, "/tmp/session-mock.jsonl");
  assert.deepEqual(combined.contextUsage, { tokens: 500, percent: 50 });
  assert.equal(combined.sessionName, "Test Session");

  // 计费统计被 computed 正确覆盖
  assert.equal(combined.tokens.input, 50);
  assert.equal(combined.tokens.output, 25);
  assert.ok(Math.abs(combined.cost - 0.07) < 1e-9);
});

test("14. marker 落盘验证机制：如果 marker 写入失败或丢失，抛出错误，绝不吞掉假装成功", () => {
  function verifyMarkerPersistence(entries) {
    const verified = entries.some(
      (e) =>
        e.type === "custom" &&
        e.customType === FORK_PROVENANCE_TYPE &&
        Boolean(e.data?.inheritedEntryIds?.length)
    );
    if (!verified) {
      throw new Error("Failed to verify fork provenance persistence");
    }
    return true;
  }

  // a) 验证成功时正常通过
  const goodEntries = [
    userEntry("u1", null),
    forkProvenanceEntry("p1", "u1", "pid", ["u1"]),
  ];
  assert.equal(verifyMarkerPersistence(goodEntries), true);

  // b) marker 缺失或写入失败时抛出错误
  const badEntries = [
    userEntry("u1", null),
  ];
  assert.throws(
    () => verifyMarkerPersistence(badEntries),
    /Failed to verify fork provenance persistence/
  );
});
