const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 从 05 模块中精确抽取目标函数与逻辑，严禁 Node FakeDOM 挂起反模式
const sourcePath = path.join(__dirname, "..", "modules", "05-composer-and-input-workflow.js");
const code = fs.readFileSync(sourcePath, "utf8");

// 1. 抽取 formatBatchDeleteResultItem 与 renderBatchDeleteResultDetails
const startSigDetails = "function formatBatchDeleteResultItem(";
const startIdxDetails = code.indexOf(startSigDetails);
assert(startIdxDetails !== -1, "必须在 05 模块中找到 formatBatchDeleteResultItem 函数定义");
const endSigDetails = "\n  function createBatchDeleteModal(";
const endIdxDetails = code.indexOf(endSigDetails, startIdxDetails);
assert(endIdxDetails !== -1, "必须找到 renderBatchDeleteResultDetails 代码块结尾");

const fnCodeDetails = code.slice(startIdxDetails, endIdxDetails);

// 2. 抽取 createBatchDeleteModal 代码块
const startSigModal = "  function createBatchDeleteModal(";
const startIdxModal = code.indexOf(startSigModal);
assert(startIdxModal !== -1, "必须在 05 模块中找到 createBatchDeleteModal 函数定义");
const endSigModal = "\n  function openBatchDeleteModal(";
const endIdxModal = code.indexOf(endSigModal, startIdxModal);
assert(endIdxModal !== -1, "必须找到 createBatchDeleteModal 代码块结尾");

const fnCodeModal = code.slice(startIdxModal, endIdxModal);

// 3. 抽取 executeBatchDeleteSessions 的核心回执与状态流逻辑
const startSigExec = "  async function executeBatchDeleteSessions(";
const startIdxExec = code.indexOf(startSigExec);
assert(startIdxExec !== -1, "必须在 05 模块中找到 executeBatchDeleteSessions 函数定义");
const endSigExec = "\n  // 鼠标点击捕获监听";
const endIdxExec = code.indexOf(endSigExec, startIdxExec);
assert(endIdxExec !== -1, "必须找到 executeBatchDeleteSessions 代码块结尾");

const fnCodeExec = code.slice(startIdxExec, endIdxExec);

// 轻量安全 DOM 节点模型，精确验证 DOM 结构与样式，杜绝 Node FakeDOM 句柄泄露
class MockElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.className = "";
    this._textContent = "";
    this._innerHTML = "";
    this.attributes = new Map();
    this.eventListeners = new Map();
    this.disabled = false;
  }
  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("\n");
  }
  set textContent(val) {
    this.children = [];
    this._textContent = String(val);
  }
  get innerHTML() {
    return this._innerHTML || this.textContent;
  }
  set innerHTML(val) {
    this._innerHTML = String(val);
    this.children = [];
    const regex = /<([a-z0-9]+)([^>]*?)>/gi;
    let match;
    while ((match = regex.exec(val)) !== null) {
      const tag = match[1];
      const attrs = match[2];
      const idMatch = attrs.match(/id="([^"]+)"/);
      const actionMatch = attrs.match(/data-action="([^"]+)"/);
      if (idMatch || actionMatch) {
        const el = new MockElement(tag);
        if (idMatch) el.id = idMatch[1];
        if (actionMatch) el.setAttribute("data-action", actionMatch[1]);
        this.children.push(el);
      }
    }
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...newChildren) {
    this.children = [...newChildren];
    this._textContent = "";
  }
  querySelector(selector) {
    if (selector.startsWith("#")) {
      const id = selector.slice(1);
      if (this.id === id) return this;
      for (const child of this.children) {
        if (child.querySelector) {
          const res = child.querySelector(selector);
          if (res) return res;
        }
      }
    } else if (selector.startsWith("[") && selector.endsWith("]")) {
      const match = selector.match(/\[([a-zA-Z0-9_-]+)="([^"]+)"\]/);
      if (match) {
        const [, attr, val] = match;
        if (this.attributes.get(attr) === val) return this;
        for (const child of this.children) {
          if (child.querySelector) {
            const res = child.querySelector(selector);
            if (res) return res;
          }
        }
      }
    }
    return null;
  }
  setAttribute(name, val) {
    this.attributes.set(name, String(val));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
  addEventListener(event, fn) {
    const list = this.eventListeners.get(event) || [];
    list.push(fn);
    this.eventListeners.set(event, list);
  }
  remove() {
    this.removed = true;
  }
  focus() {}
}

function createDetailsSandbox(options = {}) {
  const titles = options.titles || {};
  const mockDoc = {
    createElement: (tag) => new MockElement(tag),
  };
  const sandbox = {
    document: mockDoc,
    getSessionTitleForBatch: (id) => titles[id] || id,
    Array,
    Set,
    Boolean,
    String,
    Math,
  };
  vm.runInNewContext(
    fnCodeDetails +
      ";\nthis.formatBatchDeleteResultItem = formatBatchDeleteResultItem;\nthis.renderBatchDeleteResultDetails = renderBatchDeleteResultDetails;",
    sandbox
  );
  return sandbox;
}

// ==========================================
// 单元测试集：结果详情、错误保存、XSS防护与确定性重试
// ==========================================

test("用例 1: result 帧真实保存 error，实时渲染显示具体标题、ID 与实际原因", () => {
  const sb = createDetailsSandbox({
    titles: {
      "session-failed-1": "生产数据库排查",
      "session-unknown-1": "临时草稿备份",
    },
  });

  const job = {
    ids: ["session-ok-1", "session-failed-1", "session-unknown-1"],
    appliedDeletedIds: new Set(["session-ok-1"]),
    failedIds: ["session-failed-1"],
    unknownIds: ["session-unknown-1"],
    notStartedIds: [],
    itemErrors: {
      "session-failed-1": "会话文件被其他进程独占，写入锁定",
      "session-unknown-1": "上游代理响应超时 (504 Gateway Timeout)",
    },
  };

  const container = new MockElement("div");
  sb.renderBatchDeleteResultDetails(container, job);

  // 断言：成功项绝不列为错误，子节点精确为 2 项
  assert.equal(container.children.length, 2, "容器内应恰好包含 2 个未成功项");

  const [item1, item2] = container.children;

  // 断言失败项：包含标题、ID 与具体的服务端错误原因
  assert.equal(item1.className, "pi-enh-batch-result-detail-item");
  assert.match(item1.textContent, /^\[失败\]/, "第一项必须明确标记 [失败]");
  assert.match(item1.textContent, /生产数据库排查/, "标题可得时必须使用标题");
  assert.match(item1.textContent, /\(session-failed-1\)/, "ID 必须保留用于技术定位");
  assert.match(item1.textContent, /会话文件被其他进程独占，写入锁定/, "必须展示真实服务端 error");

  // 断言未知项：包含 [未知] 标记与错误原因
  assert.equal(item2.className, "pi-enh-batch-result-detail-item");
  assert.match(item2.textContent, /^\[未知\]/, "第二项必须明确标记 [未知]");
  assert.match(item2.textContent, /临时草稿备份 \(session-unknown-1\)/);
  assert.match(item2.textContent, /504 Gateway Timeout/);
});

test("用例 2: done 帧补充保存 not_started 项的 error，并保留未执行区别", () => {
  const sb = createDetailsSandbox({
    titles: {
      "session-notstart": "待同步长任务",
    },
  });

  const job = {
    ids: ["session-notstart"],
    appliedDeletedIds: new Set(),
    failedIds: [],
    unknownIds: [],
    notStartedIds: ["session-notstart"],
    itemErrors: {
      "session-notstart": "批次因前序未知错误中止，本项未执行",
    },
  };

  const container = new MockElement("div");
  sb.renderBatchDeleteResultDetails(container, job);

  assert.equal(container.children.length, 1);
  const item = container.children[0];
  assert.match(item.textContent, /^\[未执行\]/, "not_started 必须明确标记 [未执行]");
  assert.match(item.textContent, /待同步长任务 \(session-notstart\)/);
  assert.match(item.textContent, /批次因前序未知错误中止，本项未执行/);
});

test("用例 3: 恶意 HTML 注入防护（XSS Invariant）——只用 textContent，禁止 innerHTML", () => {
  const maliciousTitle = '<script>window.pwned=1</script><img src="x" onerror="evil()">';
  const maliciousError = '<b>致命错误</b><svg onload="alert(1)">&quot;';
  const maliciousId = '<div id="exploit">';

  const sb = createDetailsSandbox({
    titles: {
      [maliciousId]: maliciousTitle,
    },
  });

  const job = {
    ids: [maliciousId],
    appliedDeletedIds: new Set(),
    failedIds: [maliciousId],
    unknownIds: [],
    notStartedIds: [],
    itemErrors: {
      [maliciousId]: maliciousError,
    },
  };

  const container = new MockElement("div");
  sb.renderBatchDeleteResultDetails(container, job);

  assert.equal(container.children.length, 1);
  const item = container.children[0];

  // 确保没有直接赋值 innerHTML 产生标签被解析的风险
  assert.equal(item._innerHTML, "", "严禁向 item.innerHTML 写入恶意 HTML 代码");
  // textContent 中必须完整安全地保留字面量
  assert.ok(item.textContent.includes('<script>window.pwned=1</script>'));
  assert.ok(item.textContent.includes('<b>致命错误</b><svg onload="alert(1)">'));
});

test("用例 4: missing reason 缺少错误时显示保守 fallback，保留区别且绝不臆造 busy 原因", () => {
  const sb = createDetailsSandbox();

  const job = {
    ids: ["id-fail", "id-unk", "id-notstart"],
    appliedDeletedIds: new Set(),
    failedIds: ["id-fail"],
    unknownIds: ["id-unk"],
    notStartedIds: ["id-notstart"],
    // 服务端未提供 error
    itemErrors: {},
  };

  const container = new MockElement("div");
  sb.renderBatchDeleteResultDetails(container, job);

  assert.equal(container.children.length, 3);
  const [failItem, unkItem, notstartItem] = container.children;

  assert.match(failItem.textContent, /^\[失败\] id-fail: 删除未成功/);
  assert.match(unkItem.textContent, /^\[未知\] id-unk: 状态未知，未确认是否已删除/);
  assert.match(notstartItem.textContent, /^\[未执行\] id-notstart: 任务提前停止，未开始删除/);

  // 铁律：保守 fallback 严禁臆造 busy/频繁/繁忙
  const fullText = container.textContent;
  assert.doesNotMatch(fullText, /busy/i, "不得臆造 busy 词");
  assert.doesNotMatch(fullText, /繁忙/, "不得臆造繁忙原因");
  assert.doesNotMatch(fullText, /频繁/, "不得臆造频繁原因");
});

test("用例 5: 成功项（deleted/missing）绝不列为错误，全部成功时容器隐藏清空", () => {
  const sb = createDetailsSandbox();

  const job = {
    ids: ["s1", "s2"],
    appliedDeletedIds: new Set(["s1", "s2"]),
    failedIds: [],
    unknownIds: [],
    notStartedIds: [],
    itemErrors: {},
  };

  const container = new MockElement("div");
  sb.renderBatchDeleteResultDetails(container, job);

  assert.equal(container.children.length, 0);
  assert.equal(container.textContent, "");
  assert.equal(container.style.display, "none", "全部成功时容器应设为 display: none");
});

test("用例 6: 批量上限截断与长换行样式防撑破", () => {
  const sb = createDetailsSandbox();

  // 构造 25 个失败项（超过 20 条上限）
  const failedIds = [];
  const itemErrors = {};
  for (let i = 1; i <= 25; i++) {
    const id = `session-multi-${i}`;
    failedIds.push(id);
    itemErrors[id] = `第 ${i} 行错误\n带有第二行排版详情\n超长字符串跟踪日志 0x${i.toString(16).repeat(20)}`;
  }

  const job = {
    ids: failedIds,
    appliedDeletedIds: new Set(),
    failedIds,
    unknownIds: [],
    notStartedIds: [],
    itemErrors,
  };

  const container = new MockElement("div");
  sb.renderBatchDeleteResultDetails(container, job);

  // 检查容器样式：防撑破、自适应滚动
  assert.equal(container.style.maxHeight, "180px", "必须设置 maxHeight 限制容器高度");
  assert.equal(container.style.overflowY, "auto", "必须启用 overflowY: auto 滚动条");
  assert.equal(container.style.overflowWrap, "anywhere", "必须指定 overflowWrap: anywhere 防撑破");

  // 批量上限为 20 项，加 1 个超限提示项，共 21 项
  assert.equal(container.children.length, 21, "25 个失败项时应渲染 20 个详情项 + 1 个截断提示");

  const moreEl = container.children[20];
  assert.equal(moreEl.className, "pi-enh-batch-result-detail-more");
  assert.match(moreEl.textContent, /\.\.\. 等共 25 项未删除\/待核对/, "截断提示必须包含总未解决数");

  // 检查首项换行排版样式
  const firstItem = container.children[0];
  assert.match(firstItem.style.cssText, /white-space:\s*pre-wrap/, "必须保留 pre-wrap 换行样式");
});

test("用例 7: executeBatchDeleteSessions 完整状态机：result 与 done 保存 error，有失败时标题明确为‘处理完成，部分未删除’且隔离 unknown", async () => {
  const storage = new Map();
  const testIds = ["session-ok", "session-fail", "session-unk", "session-notstart"];
  const jobId = "00000000-0000-4000-8000-000000000002";

  const frames = [
    { type: "start", total: 4 },
    { type: "item-start", id: "session-ok", index: 1, total: 4 },
    { type: "result", processed: 1, total: 4, result: { id: "session-ok", ok: true, state: "deleted" }, deletedSessionIds: ["session-ok"] },
    { type: "item-start", id: "session-fail", index: 2, total: 4 },
    {
      type: "result",
      processed: 2,
      total: 4,
      result: { id: "session-fail", ok: false, state: "failed", error: "Odoo 业务正在锁定关联单据" },
      deletedSessionIds: [],
    },
    { type: "item-start", id: "session-unk", index: 3, total: 4 },
    {
      type: "result",
      processed: 3,
      total: 4,
      result: { id: "session-unk", ok: false, state: "unknown", error: "网络传输丢包，连接重置" },
      deletedSessionIds: [],
    },
    {
      type: "done",
      processed: 3,
      total: 4,
      results: [
        { id: "session-ok", ok: true, state: "deleted" },
        { id: "session-fail", ok: false, state: "failed", error: "Odoo 业务正在锁定关联单据" },
        { id: "session-unk", ok: false, state: "unknown", error: "网络传输丢包，连接重置" },
        { id: "session-notstart", ok: false, state: "not_started", error: "批次因未知状态停止，未执行" },
      ],
      deletedSessionIds: ["session-ok"],
      stopped: true,
    },
  ];

  const sequence = frames.map((f, i) => ({ seq: i + 1, frame: f }));

  const statusEl = new MockElement("span");
  statusEl.id = "pi-enh-batch-progress-status";
  const resultIdsEl = new MockElement("div");
  resultIdsEl.id = "pi-enh-batch-progress-result-ids";
  const confirmBtn = new MockElement("button");
  confirmBtn.setAttribute("data-action", "confirm");

  const mockModal = new MockElement("div");
  mockModal.id = "pi-enh-batch-delete-modal";
  mockModal.appendChild(statusEl);
  mockModal.appendChild(resultIdsEl);
  mockModal.appendChild(confirmBtn);

  const sandbox = {
    console,
    Map,
    Set,
    Array,
    AbortController,
    ReadableStream,
    TextDecoder,
    TextEncoder,
    JSON,
    Math,
    String,
    Boolean,
    setTimeout,
    clearTimeout,
    batchDeleteInFlight: false,
    batchDeleteJob: null,
    batchDeleteJobEntry: null,
    batchDeleteObserverController: null,
    batchDeleteObserverGeneration: 0,
    batchDeleteJobStorageKey: "pi-enh:session-batch-delete-job",
    isSessionBatchMode: false,
    batchDeleteModal: mockModal,
    selectedSessionBatchIds: new Set(testIds),
    syncSessionBatchBar() {},
    syncSessionBatchRowStates() {},
    syncBatchDeleteJobEntry() {},
    removeBatchDeleteJobEntry() {},
    isBatchDeleteJobTerminal: (job) => Boolean(job?.done),
    createBatchDeleteJobId: () => jobId,
    saveBatchDeleteJobPointer(job) {
      storage.set("pi-enh:session-batch-delete-job", JSON.stringify({ id: job.id, ids: job.ids }));
    },
    clearBatchDeleteJobPointer() {
      storage.delete("pi-enh:session-batch-delete-job");
    },
    window: {
      localStorage: {
        getItem: (k) => storage.get(k) || null,
        setItem: (k, v) => storage.set(k, v),
        removeItem: (k) => storage.delete(k),
      },
      history: { replaceState() {} },
    },
    document: {
      getElementById: (id) => (id === "pi-enh-batch-delete-modal" ? mockModal : null),
      createElement: (tag) => new MockElement(tag),
    },
    getSessionTitleForBatch: (id) => (id === "session-fail" ? "客户订单草稿" : id),
    getCurrentSessionId: () => "other",
    getSessionRowById: () => null,
    markSessionDeleteConfirmed: () => {},
    cleanupDeletedSessionEverywhere: () => {},
    cleanupSessionUploadedFiles: async () => {},
    restoreSessionDeleteState: () => {},
    requestSessionListRefresh: () => {},
    closeBatchDeleteModal: () => {},
    setSessionBatchMode: () => {},
    showToast: () => {},
    sessionDeleteIcon: "",
    fetch: async (url, opts) => {
      if (opts?.method === "POST") {
        return {
          ok: true,
          status: 202,
          headers: { get: () => "application/json" },
          json: async () => ({ id: jobId, ids: testIds, total: testIds.length, status: "running", processed: 0, lastSequence: 0 }),
        };
      }
      if (url.endsWith(`/jobs/${jobId}`)) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({
            id: jobId,
            ids: testIds,
            total: testIds.length,
            status: "stopped",
            processed: 3,
            lastSequence: sequence.length,
          }),
        };
      }
      if (url.includes(`/jobs/${jobId}/events`)) {
        const after = Number(new URL(url, "http://local").searchParams.get("after") || 0);
        const page = sequence.filter((item) => item.seq > after);
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({
            id: jobId,
            frames: page,
            lastSequence: sequence.length,
            status: "stopped",
          }),
        };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  };

  vm.runInNewContext(
    fnCodeDetails +
      "\n" +
      fnCodeExec +
      "\nthis.run = executeBatchDeleteSessions;\nthis.getJob = () => batchDeleteJob;",
    sandbox
  );

  await sandbox.run(testIds, confirmBtn);

  const job = sandbox.getJob();
  assert.ok(job, "执行完成后必须存在 job 状态");
  assert.equal(job.done, true);

  // 1. 验证 result 与 done 帧均保存 error
  assert.equal(job.itemErrors["session-fail"], "Odoo 业务正在锁定关联单据");
  assert.equal(job.itemErrors["session-unk"], "网络传输丢包，连接重置");
  assert.equal(job.itemErrors["session-notstart"], "批次因未知状态停止，未执行");

  // 2. 验证完成时标题：由于stopped且有未完成项
  assert.equal(statusEl.textContent, "任务已停止，部分结果需要核对 (3/4)");

  // 3. 验证详情渲染包含标题与各状态原因
  assert.equal(resultIdsEl.children.length, 3, "未完成项恰好为 3 项");
  const [fItem, uItem, nItem] = resultIdsEl.children;
  assert.match(fItem.textContent, /\[失败\] 客户订单草稿 \(session-fail\): Odoo 业务正在锁定关联单据/);
  assert.match(uItem.textContent, /\[未知\] session-unk: 网络传输丢包，连接重置/);
  assert.match(nItem.textContent, /\[未执行\] session-notstart: 批次因未知状态停止，未执行/);

  // 4. 验证确定性重试项绝对不包含 unknown：retryCount = failed(1) + notStarted(1) = 2
  assert.equal(confirmBtn.textContent, "选择可重试项 (2)", "重试项只能是 failed + not_started，严禁加入 unknown");
});

test("用例 8: 隐藏弹窗后重开（isJobView）：完整复现失败详情与原因，不丢失已保存的服务端错误", () => {
  const titles = { "session-fail-2": "重开测试客户单" };
  const mockDoc = {
    body: new MockElement("body"),
    createElement: (tag) => new MockElement(tag),
  };

  const existingJob = {
    id: "00000000-0000-4000-8000-000000000003",
    ids: ["session-ok-2", "session-fail-2"],
    appliedDeletedIds: new Set(["session-ok-2"]),
    failedIds: ["session-fail-2"],
    unknownIds: [],
    notStartedIds: [],
    done: true,
    status: "completed",
    serverStatus: "completed",
    lastProgress: {
      status: "处理完成，部分未删除 (2/2)",
      processed: 2,
      total: 2,
      confirmed: 1,
      failed: 1,
      unknown: 0,
    },
    itemErrors: {
      "session-fail-2": "服务器内部错误：PostgreSQL foreign key violation",
    },
  };

  const sandbox = {
    document: mockDoc,
    batchDeleteJob: existingJob,
    isBatchDeleteJobTerminal: (j) => Boolean(j?.done),
    getSessionTitleForBatch: (id) => titles[id] || id,
    escapeHtml: (s) => s,
    closeBatchDeleteModal: () => {},
    dismissBatchDeleteJob: () => {},
    setSessionBatchMode: () => {},
    executeBatchDeleteSessions: async () => {},
    selectedSessionBatchIds: new Set(),
    batchDeleteModal: null,
    Array,
    Set,
    Boolean,
    String,
    Math,
  };

  vm.runInNewContext(
    fnCodeDetails +
      "\n" +
      fnCodeModal +
      "\nthis.createBatchDeleteModal = createBatchDeleteModal;",
    sandbox
  );

  const modalBackdrop = sandbox.createBatchDeleteModal(existingJob.ids, "job");
  assert.ok(modalBackdrop, "重开必须成功返回 modalBackdrop 节点");

  const status = modalBackdrop.querySelector("#pi-enh-batch-progress-status");
  assert.equal(status.textContent, "处理完成，部分未删除 (2/2)");

  const resultIds = modalBackdrop.querySelector("#pi-enh-batch-progress-result-ids");
  assert.ok(resultIds, "必须存在结果详情容器");
  assert.equal(resultIds.children.length, 1, "重开后应完整渲染 1 项失败详情");

  const item = resultIds.children[0];
  assert.match(item.textContent, /\[失败\] 重开测试客户单 \(session-fail-2\)/);
  assert.match(item.textContent, /PostgreSQL foreign key violation/);
});
