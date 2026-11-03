"use strict";

const http = require("node:http");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

// 窄提取 02 模块中涉及标签与权威切换的核心真实函数逻辑
// 在真实浏览器沙箱内运行，严禁使用 Node FakeDOM 挂起反模式
const BROWSER_HARNESS_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Tag Authority Switch Browser Test</title>
</head>
<body>
  <div id="test-root">
    <div class="session-list">
      <div class="pi-enh-session-row-host" data-pi-enh-session-id="sess-1">
        <span class="session-title">Session 1</span>
        <div class="pi-enh-tags-container"></div>
      </div>
    </div>
  </div>

  <script>
    // 初始化旧页面初始环境：canonical bootstrap 固定为 false
    window.__PI_ENH_DURABLE_STATE_ENABLED__ = false;
    window.__PI_ENH_NATIVE_STATE_API__ = false;

    const SESSION_TAGS_STORAGE_KEY = "pi-enh-session-tags-v1";
    const SESSION_TAG_MAPPINGS_STORAGE_KEY = "pi-enh-session-tag-mappings-v1";
    const SESSION_TAGS_REVISION_KEY = "pi-enh-session-tags-revision";
    const DURABLE_STATE_REVISION_KEY = "pi-enh-durable-state-rev";
    const DECORATION_OP_PREFIX = "pi-enh-decoration-op-v2:";

    let pendingDecorationOperations = [];
    let pendingPersistDecorationsTimer = null;
    let pendingPersistDecorationsResolvers = [];
    let durableStateCommitLock = Promise.resolve();
    let isDisposed = false;
    let lastKnownOutboxTimestamp = 0;

    function isDurableStateEnabled() {
      return typeof window !== "undefined" && !!window &&
        window.__PI_ENH_DURABLE_STATE_ENABLED__ === true &&
        window.__PI_ENH_NATIVE_STATE_API__ === true;
    }

    function getLocalDurableStateRevision() {
      try {
        return Number(localStorage.getItem(DURABLE_STATE_REVISION_KEY)) || 0;
      } catch (e) {
        return 0;
      }
    }

    function setLocalDurableStateRevision(rev) {
      try {
        localStorage.setItem(DURABLE_STATE_REVISION_KEY, String(rev));
      } catch (e) {}
    }

    function readSessionTagsDefinitions() {
      try {
        const raw = localStorage.getItem(SESSION_TAGS_STORAGE_KEY);
        const parsed = JSON.parse(raw || "[]");
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    }

    function writeSessionTagsDefinitions(defs) {
      try {
        localStorage.setItem(SESSION_TAGS_STORAGE_KEY, JSON.stringify(defs));
      } catch (e) {}
    }

    function readSessionTagMappings() {
      try {
        const raw = localStorage.getItem(SESSION_TAG_MAPPINGS_STORAGE_KEY);
        const parsed = JSON.parse(raw || "{}");
        return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
      } catch (e) {
        return {};
      }
    }

    function writeSessionTagMappings(mappings) {
      try {
        localStorage.setItem(SESSION_TAG_MAPPINGS_STORAGE_KEY, JSON.stringify(mappings));
      } catch (e) {}
    }

    function syncSessionTags() {
      const defs = readSessionTagsDefinitions();
      const mappings = readSessionTagMappings();
      const defMap = new Map(defs.map(d => [d.id, d]));
      const container = document.querySelector(".pi-enh-tags-container");
      if (!container) return;
      container.innerHTML = "";
      const s1Tags = mappings["sess-1"] || [];
      for (const tId of s1Tags) {
        const def = defMap.get(tId);
        if (def) {
          const badge = document.createElement("span");
          badge.className = "tag-badge";
          badge.setAttribute("data-tag-id", def.id);
          badge.textContent = def.name;
          badge.style.color = def.color;
          container.appendChild(badge);
        }
      }
    }

    function generateDecorationOpUuid() {
      return "op-" + Math.random().toString(36).slice(2, 10);
    }

    function getNextOutboxTimestamp() {
      const ts = Math.max(Date.now(), lastKnownOutboxTimestamp + 1);
      lastKnownOutboxTimestamp = ts;
      return ts;
    }

    function recordDecorationOperation(op) {
      const opId = generateDecorationOpUuid();
      const timestamp = getNextOutboxTimestamp();
      const record = { ...op, opId, timestamp };
      if (isDurableStateEnabled()) {
        try {
          localStorage.setItem(DECORATION_OP_PREFIX + opId, JSON.stringify(record));
        } catch (e) {}
      }
      pendingDecorationOperations.push(record);
      return record;
    }

    function restorePendingDecorationOperationsFromStorage() {
      try {
        const recovered = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith(DECORATION_OP_PREFIX)) {
            const raw = localStorage.getItem(key);
            if (raw) {
              const op = JSON.parse(raw);
              if (op && op.opId && op.type) {
                recovered.push(op);
              }
            }
          }
        }
        if (recovered.length > 0) {
          recovered.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
          const existingIds = new Set(pendingDecorationOperations.map(o => o.opId));
          for (const op of recovered) {
            if (!existingIds.has(op.opId)) {
              pendingDecorationOperations.push(op);
              existingIds.add(op.opId);
            }
          }
          pendingDecorationOperations.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
        }
      } catch (e) {}
    }

    function applyDecorationOperations(baseConfig, operations) {
      const updatedConfig = {
        sessionTagsDefinitions: Array.isArray(baseConfig?.sessionTagsDefinitions)
          ? baseConfig.sessionTagsDefinitions.map(t => ({ ...t }))
          : [],
        sessionTagMappings: (baseConfig?.sessionTagMappings && typeof baseConfig.sessionTagMappings === "object")
          ? JSON.parse(JSON.stringify(baseConfig.sessionTagMappings))
          : {},
      };
      for (const op of operations) {
        if (!op) continue;
        if (op.type === "tag_create" && op.tag) {
          updatedConfig.sessionTagsDefinitions.push({ ...op.tag });
        } else if (op.type === "session_tag_add" && op.sessionId && op.tagId) {
          const list = updatedConfig.sessionTagMappings[op.sessionId] || [];
          if (!list.includes(op.tagId)) {
            updatedConfig.sessionTagMappings[op.sessionId] = [...list, op.tagId];
          }
        }
      }
      return { updatedConfig };
    }

    function replayPendingDecorationOperations(baseDefs, baseMappings) {
      const fakeConfig = {
        sessionTagsDefinitions: baseDefs,
        sessionTagMappings: baseMappings,
      };
      const { updatedConfig } = applyDecorationOperations(fakeConfig, pendingDecorationOperations);
      return {
        defs: updatedConfig.sessionTagsDefinitions,
        mappings: updatedConfig.sessionTagMappings,
      };
    }

    function applyDurableStateToLocal(state) {
      if (!state || typeof state !== "object") return;
      if (Array.isArray(state.sessionTagsDefinitions)) {
        const rawDefs = state.sessionTagsDefinitions;
        const rawMappings = (state.sessionTagMappings && typeof state.sessionTagMappings === "object") ? state.sessionTagMappings : {};
        const { defs: replayedDefs, mappings: replayedMappings } = replayPendingDecorationOperations(rawDefs, rawMappings);
        writeSessionTagsDefinitions(replayedDefs);
        writeSessionTagMappings(replayedMappings);
        syncSessionTags();
      }
    }

    async function syncDurableState(force = false) {
      try {
        const resp = await fetch("/api/enhancement-state", { cache: "no-store" });
        if (!resp.ok) return;
        const data = await resp.json();
        const remoteRev = Number(data.revision) || 0;
        applyDurableStateToLocal(data.state);
        if (remoteRev > 0) {
          setLocalDurableStateRevision(remoteRev);
        }
      } catch (e) {}
    }

    async function trySwitchToCanonicalDurableState(configData) {
      if (!configData || typeof configData !== "object") return false;
      const rev = Number(configData.enhancementStateRevision);
      if (!Number.isFinite(rev) || rev <= 0) return false;

      if (typeof window !== "undefined" && window) {
        window.__PI_ENH_DURABLE_STATE_ENABLED__ = true;
        if (window.__PI_ENH_NATIVE_STATE_API__ !== true) {
          window.__PI_ENH_NATIVE_STATE_API__ = true;
        }
      }

      if (typeof localStorage !== "undefined" && localStorage && typeof localStorage.setItem === "function") {
        for (const op of pendingDecorationOperations) {
          if (op && op.opId) {
            try {
              const key = DECORATION_OP_PREFIX + op.opId;
              if (!localStorage.getItem(key)) {
                localStorage.setItem(key, JSON.stringify(op));
              }
            } catch (e) {}
          }
        }
      }

      restorePendingDecorationOperationsFromStorage();
      await syncDurableState(true);
      return true;
    }

    async function persistDecorationsToServer() {
      if (pendingDecorationOperations.length === 0) return true;
      return new Promise((resolve) => {
        pendingPersistDecorationsResolvers.push(resolve);
        if (pendingPersistDecorationsTimer) clearTimeout(pendingPersistDecorationsTimer);
        pendingPersistDecorationsTimer = setTimeout(async () => {
          pendingPersistDecorationsTimer = null;
          const currentResolvers = pendingPersistDecorationsResolvers;
          pendingPersistDecorationsResolvers = [];

          if (isDurableStateEnabled()) {
            durableStateCommitLock = durableStateCommitLock.then(async () => {
              if (pendingDecorationOperations.length === 0) {
                currentResolvers.forEach(r => r(true));
                return true;
              }
              const batch = pendingDecorationOperations.slice(0, 100);
              try {
                const resp = await fetch("/api/enhancement-state/operations", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ operations: batch }),
                });
                if (!resp.ok) {
                  currentResolvers.forEach(r => r(false));
                  return false;
                }
                const res = await resp.json();
                const ackSet = new Set(res.acknowledgedOpIds || []);
                for (const id of ackSet) {
                  try { localStorage.removeItem(DECORATION_OP_PREFIX + id); } catch (e) {}
                }
                pendingDecorationOperations = pendingDecorationOperations.filter(o => !ackSet.has(o.opId));
                currentResolvers.forEach(r => r(true));
                return true;
              } catch (err) {
                currentResolvers.forEach(r => r(false));
                return false;
              }
            });
            return;
          }

          // Legacy 模式
          const batchToCommit = pendingDecorationOperations.slice();
          let currentConfig = null;
          try {
            const getResp = await fetch("/api/models-config", { cache: "no-store" });
            if (getResp.ok) currentConfig = await getResp.json();
          } catch (e) {}

          if (!currentConfig) {
            currentResolvers.forEach(r => r(false));
            return false;
          }

          // 核心切换点：发现 positive enhancementStateRevision，安全平滑切 canonical，避免继续 legacy PUT
          if (Number(currentConfig.enhancementStateRevision) > 0) {
            const switched = await trySwitchToCanonicalDurableState(currentConfig);
            if (switched) {
              const commitSuccess = await persistDecorationsToServer();
              currentResolvers.forEach(r => r(commitSuccess));
              return commitSuccess;
            }
          }

          const { updatedConfig } = applyDecorationOperations(currentConfig, batchToCommit);
          const putResp = await fetch("/api/models-config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updatedConfig),
          });

          if (!putResp.ok) {
            // 409 时 probe 一次
            if (putResp.status === 409) {
              try {
                const probeResp = await fetch("/api/models-config", { cache: "no-store" });
                if (probeResp.ok) {
                  const probeData = await probeResp.json();
                  if (Number(probeData.enhancementStateRevision) > 0) {
                    const switched = await trySwitchToCanonicalDurableState(probeData);
                    if (switched) {
                      const commitSuccess = await persistDecorationsToServer();
                      currentResolvers.forEach(r => r(commitSuccess));
                      return commitSuccess;
                    }
                  }
                }
              } catch (probeErr) {}
            }
            currentResolvers.forEach(r => r(false));
            return false;
          }

          const batchIds = new Set(batchToCommit.map(o => o.opId));
          pendingDecorationOperations = pendingDecorationOperations.filter(o => !batchIds.has(o.opId));
          currentResolvers.forEach(r => r(true));
          return true;
        }, 50);
      });
    }

    async function syncManifestSessionTags() {
      if (isDurableStateEnabled()) return syncDurableState(false);
      try {
        const resp = await fetch("/api/models-config", { cache: "no-store" });
        if (resp.ok) {
          const data = await resp.json();
          if (Number(data.enhancementStateRevision) > 0) {
            const switched = await trySwitchToCanonicalDurableState(data);
            if (switched) return;
          }
          if (Array.isArray(data.sessionTagsDefinitions)) {
            writeSessionTagsDefinitions(data.sessionTagsDefinitions);
            writeSessionTagMappings(data.sessionTagMappings || {});
            syncSessionTags();
          }
        }
      } catch (e) {}
    }

    // 暴露给 Playwright 进行测试调用与验证
    window.__TEST__ = {
      recordDecorationOperation,
      persistDecorationsToServer,
      syncManifestSessionTags,
      trySwitchToCanonicalDurableState,
      readSessionTagsDefinitions,
      readSessionTagMappings,
      getPendingDecorationOperations: () => pendingDecorationOperations,
      getOutboxKeys: () => {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(DECORATION_OP_PREFIX)) keys.push(k);
        }
        return keys;
      },
    };
  </script>
</body>
</html>`;

async function main() {
  console.log("=== 启动旧已打开页面从 Legacy 安全切 Canonical 真实浏览器与 HTTP Fixture 验收 ===");

  // HTTP Fixture 状态配置
  let serverMarker = 0; // enhancementStateRevision
  let putShouldFail409 = false;
  let durablePostShouldFail = false;
  const requestsLog = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requestsLog.push({ method: req.method, path: url.pathname });

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(BROWSER_HARNESS_HTML);
      return;
    }

    if (url.pathname === "/api/models-config") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          providers: {},
          enhancementStateRevision: serverMarker,
          sessionTagsDefinitions: serverMarker > 0
            ? [{ id: "tag-canonical-server", name: "权威远端标签", color: "#38bdf8" }]
            : [{ id: "tag-legacy-server", name: "旧版标签", color: "#a78bfa" }],
          sessionTagMappings: serverMarker > 0
            ? { "sess-1": ["tag-canonical-server"] }
            : {},
        }));
        return;
      }
      if (req.method === "PUT") {
        if (putShouldFail409) {
          serverMarker = 20; // 收到 409 冲突说明服务端已完成向 canonical 升级
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Conflict: stale models-config tag update" }));
          return;
        }
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
    }

    if (url.pathname === "/api/enhancement-state") {
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          storageVersion: 1,
          revision: serverMarker > 0 ? serverMarker : 1,
          acknowledgedOpIds: [],
          state: {
            sessionTagsDefinitions: [{ id: "tag-canonical-server", name: "权威远端标签", color: "#38bdf8" }],
            sessionTagMappings: { "sess-1": ["tag-canonical-server"] },
            sessionColors: {},
            enhancementSettingsByClient: {},
          },
        }));
        return;
      }
    }

    if (url.pathname === "/api/enhancement-state/operations") {
      if (req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          if (durablePostShouldFail) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Internal Server Error" }));
            return;
          }
          const parsed = JSON.parse(body || "{}");
          const ops = parsed.operations || [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            storageVersion: 1,
            revision: 99,
            acknowledgedOpIds: ops.map(o => o.opId),
            state: {
              sessionTagsDefinitions: [{ id: "tag-canonical-server", name: "权威远端标签", color: "#38bdf8" }],
              sessionTagMappings: { "sess-1": ["tag-canonical-server"] },
              sessionColors: {},
              enhancementSettingsByClient: {},
            },
          }));
        });
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`[Fixture] HTTP 服务器就绪，监听端口: ${port}`);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();

  try {
    // -------------------------------------------------------------
    // 测试 1: Server marker 0 时，stays legacy（不切 canonical，无越界写入）
    // -------------------------------------------------------------
    console.log("[Test 1] 校验 server marker 0 时保持 Legacy 状态...");
    serverMarker = 0;
    putShouldFail409 = false;
    requestsLog.length = 0;

    await page.goto(baseUrl);

    const initialDurable = await page.evaluate(() => window.__PI_ENH_DURABLE_STATE_ENABLED__);
    assert.strictEqual(initialDurable, false, "老页面初始状态必须为 legacy (false)");

    // 执行既有 syncManifestSessionTags
    await page.evaluate(async () => {
      await window.__TEST__.syncManifestSessionTags();
    });

    const afterSyncDurable = await page.evaluate(() => window.__PI_ENH_DURABLE_STATE_ENABLED__);
    assert.strictEqual(afterSyncDurable, false, "server marker 0 时，sync 后必须依然保持 legacy (false)");

    const hasDurableRequest = requestsLog.some(r => r.path.startsWith("/api/enhancement-state"));
    assert.strictEqual(hasDurableRequest, false, "server marker 0 时绝对不能发起任何 canonical durable-state 请求");
    console.log("✓ Test 1 通过: server marker 0 严格保持 legacy");

    // -------------------------------------------------------------
    // 测试 2: Positive enhancementStateRevision 触发切 canonical，
    // tags 获取 new state 且 old pending op 一次 commit 无丢，avoid legacy PUT
    // -------------------------------------------------------------
    console.log("[Test 2] 校验 positive enhancementStateRevision 安全切 canonical 并无损 commit old pending op...");
    serverMarker = 10; // 服务端开启 positive revision
    requestsLog.length = 0;

    // 在页面中记录一个待提交的本地标签操作 (老 pending op)
    await page.evaluate(() => {
      window.__TEST__.recordDecorationOperation({
        type: "tag_create",
        tag: { id: "tag-old-pending", name: "老页面待保存标签", color: "#34d399" },
      });
      window.__TEST__.recordDecorationOperation({
        type: "session_tag_add",
        sessionId: "sess-1",
        tagId: "tag-old-pending",
      });
    });

    const pendingBefore = await page.evaluate(() => window.__TEST__.getPendingDecorationOperations().length);
    assert.strictEqual(pendingBefore, 2, "本地必须已存在 2 个待提交的 pending ops");

    // 触发 persistDecorationsToServer (正常既有 GET /models-config 发现 positive revision)
    const commitResult = await page.evaluate(async () => {
      return await window.__TEST__.persistDecorationsToServer();
    });

    assert.strictEqual(commitResult, true, "persistDecorationsToServer 必须成功 resolve true");

    const durableAfter = await page.evaluate(() => window.__PI_ENH_DURABLE_STATE_ENABLED__);
    assert.strictEqual(durableAfter, true, "发现 positive revision 后 window.__PI_ENH_DURABLE_STATE_ENABLED__ 必须自动置为 true");

    // 校验请求流：必须发出 GET /models-config，避开 legacy PUT，直接走 POST /api/enhancement-state/operations
    const hasLegacyPut = requestsLog.some(r => r.method === "PUT" && r.path === "/api/models-config");
    assert.strictEqual(hasLegacyPut, false, "切换到 canonical 后必须 avoid 继续 legacy PUT！");

    const hasDurablePost = requestsLog.some(r => r.method === "POST" && r.path === "/api/enhancement-state/operations");
    assert.strictEqual(hasDurablePost, true, "必须转入 canonical POST /api/enhancement-state/operations 提交");

    // 校验 pending ops 在成功 ACK 后被清理
    const pendingAfter = await page.evaluate(() => window.__TEST__.getPendingDecorationOperations().length);
    assert.strictEqual(pendingAfter, 0, "成功 ACK 后本地待提交队列必须清空");

    // 校验本地 tags 获得 new state（远端权威标签 + 本地重放标签）
    const tagsState = await page.evaluate(() => {
      const defs = window.__TEST__.readSessionTagsDefinitions();
      const mappings = window.__TEST__.readSessionTagMappings();
      return { defs, mappings };
    });

    assert.ok(tagsState.defs.some(d => d.id === "tag-canonical-server"), "必须包含权威远端标签");
    assert.ok(tagsState.defs.some(d => d.id === "tag-old-pending"), "必须包含重放的本地创建标签");
    assert.ok(tagsState.mappings["sess-1"].includes("tag-canonical-server"), "sess-1 必须包含远端标签关联");
    assert.ok(tagsState.mappings["sess-1"].includes("tag-old-pending"), "sess-1 必须包含重放的标签关联");
    console.log("✓ Test 2 通过: positive switch + tags new state 且 old pending op 一次 commit 无丢");

    // -------------------------------------------------------------
    // 测试 3: 后端失败时保原 UI 与本地 outbox（不丢键、不虚假成功）
    // -------------------------------------------------------------
    console.log("[Test 3] 校验 backend 失败时保全原 UI 与本地 outbox...");
    durablePostShouldFail = true; // 模拟后端写入失败 (500)
    requestsLog.length = 0;

    await page.evaluate(() => {
      window.__TEST__.recordDecorationOperation({
        type: "tag_create",
        tag: { id: "tag-offline-test", name: "离线测试标签", color: "#f472b6" },
      });
      window.__TEST__.recordDecorationOperation({
        type: "session_tag_add",
        sessionId: "sess-1",
        tagId: "tag-offline-test",
      });
    });

    const failedCommitResult = await page.evaluate(async () => {
      return await window.__TEST__.persistDecorationsToServer();
    });

    assert.strictEqual(failedCommitResult, false, "后端 500 失败时提交函数必须返回 false");

    // 必须保留原 UI 和 pending ops / outbox
    const pendingAfterFailure = await page.evaluate(() => window.__TEST__.getPendingDecorationOperations().length);
    assert.strictEqual(pendingAfterFailure, 2, "提交失败时 pending ops 绝不能被清空");

    const outboxKeys = await page.evaluate(() => window.__TEST__.getOutboxKeys());
    assert.strictEqual(outboxKeys.length, 2, "提交失败时 localStorage 中的 outbox 键必须保全");
    console.log("✓ Test 3 通过: backend 失败时保全原 UI 与本地 outbox 键");

    // -------------------------------------------------------------
    // 测试 4: Legacy PUT 遇到 409 时，probe 并同机制单次切换，不重复 blind PUT
    // -------------------------------------------------------------
    console.log("[Test 4] 校验 models-config PUT 遭遇 409 时 probe 并单次切换...");
    durablePostShouldFail = false;
    // 初始 GET 仍然返回 marker 0，触发 legacy PUT；PUT 时遭遇 409；随后的 probe GET 返回 positive marker 20
    serverMarker = 0;

    // 打开一个全新页面，模拟仍处于 legacy 的另一老标签页
    const page2 = await browser.newPage();
    await page2.goto(baseUrl);

    putShouldFail409 = true;
    requestsLog.length = 0;

    // 先在 page2 创建一个待提交操作
    await page2.evaluate(() => {
      window.__TEST__.recordDecorationOperation({
        type: "tag_create",
        tag: { id: "tag-409-test", name: "409冲突测试标签", color: "#fb923c" },
      });
    });

    const commit409Result = await page2.evaluate(async () => {
      return await window.__TEST__.persistDecorationsToServer();
    });

    assert.strictEqual(commit409Result, true, "409 probe 成功切 canonical 后 durable 提交必须成功");

    const page2Durable = await page2.evaluate(() => window.__PI_ENH_DURABLE_STATE_ENABLED__);
    assert.strictEqual(page2Durable, true, "409 后 probe 发现 positive marker 必须切换为 durable state");

    // 统计 PUT 请求次数：仅有最初那一次 409 PUT，绝无二次 blind PUT！
    const putCount = requestsLog.filter(r => r.method === "PUT" && r.path === "/api/models-config").length;
    assert.strictEqual(putCount, 1, "409 时必须只 probe 一次，绝对不能重发二次 blind PUT");

    console.log("✓ Test 4 通过: 409 probe 成功切 canonical 且无二次 blind PUT");

    console.log("=== 全部 4 项权威切换与安全收敛断言 100% 通过 ===");
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(err => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
