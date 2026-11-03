const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// 从 05 模块中精确抽取纯函数与排序算法，禁止 eval 整个脚本 FakeDOM
const sourcePath = path.join(__dirname, "..", "modules", "05-composer-and-input-workflow.js");
const code = fs.readFileSync(sourcePath, "utf8");

// 抽取 computeBatchRangeSelection
const startSigRange = "function computeBatchRangeSelection(";
const startIdxRange = code.indexOf(startSigRange);
assert(startIdxRange !== -1, "必须在 05 模块中找到 computeBatchRangeSelection 函数定义");
const endSigRange = "\n  // 获取当前工作区真实有序会话可选行集合";
const endIdxRange = code.indexOf(endSigRange, startIdxRange);
assert(endIdxRange !== -1, "必须找到 computeBatchRangeSelection 函数结尾");

const fnCodeRange = code.slice(startIdxRange, endIdxRange);
const sandboxRange = {};
vm.runInNewContext(fnCodeRange + "; computeBatchRangeSelection = computeBatchRangeSelection;", sandboxRange);
const computeBatchRangeSelection = sandboxRange.computeBatchRangeSelection;
assert(typeof computeBatchRangeSelection === "function", "抽取的 computeBatchRangeSelection 必须为可用纯函数");

// 抽取 getOrderedSessionBatchIds
const startSigOrder = "function getOrderedSessionBatchIds(";
const startIdxOrder = code.indexOf(startSigOrder);
assert(startIdxOrder !== -1, "必须在 05 模块中找到 getOrderedSessionBatchIds 函数定义");
const endSigOrder = "\n  // 移动端触摸滑选支持";
const endIdxOrder = code.indexOf(endSigOrder, startIdxOrder);
assert(endIdxOrder !== -1, "必须找到 getOrderedSessionBatchIds 函数结尾");

const fnCodeOrder = code.slice(startIdxOrder, endIdxOrder);

function createOrderedIdsRunner(options = {}) {
  const sandbox = {
    window: options.window || {},
    document: options.document || { querySelectorAll: () => [] },
    latestKnownSessionGroups: options.latestKnownSessionGroups || null,
  };
  vm.runInNewContext(fnCodeOrder + "; getOrderedSessionBatchIds = getOrderedSessionBatchIds;", sandbox);
  return () => Array.from(sandbox.getOrderedSessionBatchIds());
}

// ==========================================
// 1. 纯范围连续滑选算法用例 (Pure Range Selection)
// ==========================================

test("用例 1: 正向单向连续滑选 (2 -> 4 连续全选)", () => {
  const orderedIds = ["s1", "s2", "s3", "s4", "s5"];
  const snapshot = new Set();
  const anchorId = "s2";
  const currentId = "s4";
  const targetChecked = true;

  const res = computeBatchRangeSelection(snapshot, orderedIds, anchorId, currentId, targetChecked);
  assert.deepEqual(Array.from(res).sort(), ["s2", "s3", "s4"]);
});

test("用例 2: 核心回滑撤回 (4 -> 2 撤回 3 和 4，仅保留 2)", () => {
  const orderedIds = ["s1", "s2", "s3", "s4", "s5"];
  const snapshot = new Set();
  const anchorId = "s2";
  const targetChecked = true;

  // 1. 滑到 s4
  const resAt4 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s4", targetChecked);
  assert.deepEqual(Array.from(resAt4).sort(), ["s2", "s3", "s4"]);

  // 2. 回滑至 s3：s4 撤回
  const resAt3 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s3", targetChecked);
  assert.deepEqual(Array.from(resAt3).sort(), ["s2", "s3"]);

  // 3. 回滑至 s2：s3、s4 均撤回，仅保留起始点 s2
  const resAt2 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s2", targetChecked);
  assert.deepEqual(Array.from(resAt2).sort(), ["s2"]);
});

test("用例 3: 跨越 anchor 向上滑选 (从 2 跨过 anchor 回滑到 1)", () => {
  const orderedIds = ["s1", "s2", "s3", "s4", "s5"];
  const snapshot = new Set();
  const anchorId = "s2";
  const targetChecked = true;

  // 从 s2 向上滑到 s1：包含 [s1, s2]，下方的 s3/s4 自动在 range 外恢复快照
  const resAt1 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s1", targetChecked);
  assert.deepEqual(Array.from(resAt1).sort(), ["s1", "s2"]);
});

test("用例 4: 手势前已有选中的项保持不被覆盖破坏", () => {
  const orderedIds = ["s1", "s2", "s3", "s4", "s5"];
  // 手势前 s1 与 s5 已经被选中
  const snapshot = new Set(["s1", "s5"]);
  const anchorId = "s2";
  const targetChecked = true;

  // 滑到 s3：选中的应是 s1, s2, s3, s5
  const resAt3 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s3", targetChecked);
  assert.deepEqual(Array.from(resAt3).sort(), ["s1", "s2", "s3", "s5"]);

  // 回滑到 s2：s3 撤回，但手势前的 s1 和 s5 依然完好保留！
  const resAt2 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s2", targetChecked);
  assert.deepEqual(Array.from(resAt2).sort(), ["s1", "s2", "s5"]);
});

test("用例 5: 初始已选起点反选场景保持 (从 2 向下反选 2、3，回滑时恢复)", () => {
  const orderedIds = ["s1", "s2", "s3", "s4", "s5"];
  // 手势前全部已选
  const snapshot = new Set(["s1", "s2", "s3", "s4", "s5"]);
  const anchorId = "s2";
  const targetChecked = false; // 反选模式

  // 反选滑到 s3：s2 和 s3 应该被移除，保留 s1, s4, s5
  const resAt3 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s3", targetChecked);
  assert.deepEqual(Array.from(resAt3).sort(), ["s1", "s4", "s5"]);

  // 回滑到 s2：s3 恢复为已选，s2 依然为反选未选状态
  const resAt2 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s2", targetChecked);
  assert.deepEqual(Array.from(resAt2).sort(), ["s1", "s3", "s4", "s5"]);

  // 跨过 anchor 向上反选至 s1：s1, s2 反选未选，s3, s4, s5 恢复为已选
  const resAt1 = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s1", targetChecked);
  assert.deepEqual(Array.from(resAt1).sort(), ["s3", "s4", "s5"]);
});

test("用例 6: 跳行与快速自动滚动范围连续补齐", () => {
  const orderedIds = ["s1", "s2", "s3", "s4", "s5", "s6"];
  const snapshot = new Set();
  const anchorId = "s2";
  const targetChecked = true;

  // 快速移动直接跳过 s3, s4 到达 s5：中间项自动全部补齐
  const res = computeBatchRangeSelection(snapshot, orderedIds, anchorId, "s5", targetChecked);
  assert.deepEqual(Array.from(res).sort(), ["s2", "s3", "s4", "s5"]);
});

test("用例 7: 边界与异常输入安全保护", () => {
  const orderedIds = ["s1", "s2", "s3"];
  const snapshot = new Set(["s1"]);

  // anchor 不存在
  assert.deepEqual(Array.from(computeBatchRangeSelection(snapshot, orderedIds, "s999", "s2", true)), ["s1"]);
  // current 不存在
  assert.deepEqual(Array.from(computeBatchRangeSelection(snapshot, orderedIds, "s1", "s999", true)), ["s1"]);
  // orderedIds 为空
  assert.deepEqual(Array.from(computeBatchRangeSelection(snapshot, [], "s1", "s2", true)), ["s1"]);
  // null/undefined 输入
  assert.deepEqual(Array.from(computeBatchRangeSelection(snapshot, null, null, null, true)), ["s1"]);
});

// ==========================================
// 2. 真实渲染顺序与 Pinned/Children 规则用例
// ==========================================

test("用例 8: 优先通过 window.__PI_ENH_GET_SESSION_GROUPS__ 读取真实排序 (Pinned 在前，Recents 在后)", () => {
  const mockFamilies = [
    { root: { id: "pinned-1", name: "置顶会话1" }, subagents: [] },
    { root: { id: "pinned-2", name: "置顶会话2" }, subagents: [] },
    { root: { id: "recent-1", name: "最近会话1" }, subagents: [] },
    { root: { id: "recent-2", name: "最近会话2" }, subagents: [] },
  ];

  const getOrderedIds = createOrderedIdsRunner({
    window: {
      __PI_ENH_GET_SESSION_GROUPS__: () => mockFamilies,
    },
    document: {
      querySelectorAll: () => [
        { getAttribute: () => "pinned-1" },
        { getAttribute: () => "pinned-2" },
        { getAttribute: () => "recent-1" },
        { getAttribute: () => "recent-2" },
      ],
    },
  });

  const ids = getOrderedIds();
  assert.deepEqual(ids, ["pinned-1", "pinned-2", "recent-1", "recent-2"]);
});

test("用例 9: family 下展开的 children (subagents) 紧跟其 root 后面排列", () => {
  const mockFamilies = [
    {
      root: { id: "root-1" },
      subagents: [{ id: "sub-1-1" }, { id: "sub-1-2" }],
    },
    {
      root: { id: "root-2" },
      subagents: [{ id: "sub-2-1" }],
    },
  ];

  // DOM 中展开了 sub-1-1 和 sub-2-1，但 sub-1-2 处于折叠状态（未渲染进 DOM）
  const domRows = [
    { getAttribute: () => "root-1" },
    { getAttribute: () => "sub-1-1" },
    { getAttribute: () => "root-2" },
    { getAttribute: () => "sub-2-1" },
  ];

  const getOrderedIds = createOrderedIdsRunner({
    window: {
      __PI_ENH_GET_SESSION_GROUPS__: () => mockFamilies,
    },
    document: {
      querySelectorAll: () => domRows,
    },
  });

  const ids = getOrderedIds();
  // 必须紧跟 root，展开的项被选入，折叠的 sub-1-2 绝不出现
  assert.deepEqual(ids, ["root-1", "sub-1-1", "root-2", "sub-2-1"]);
});

test("用例 10: 折叠的 child 以及隐藏的归档/别项目残留 DOM 绝不混入可选列表", () => {
  const mockFamilies = [
    { root: { id: "p1-root-1" }, subagents: [{ id: "p1-sub-collapsed" }] },
    { root: { id: "p1-root-2" }, subagents: [] },
  ];

  // DOM 中除了当前项目，还残留有其他项目/归档会话（例如历史面板或外部残余 DOM）
  const domRows = [
    { getAttribute: () => "p1-root-1" },
    { getAttribute: () => "other-project-session" },
    { getAttribute: () => "hidden-archived-session" },
    { getAttribute: () => "p1-root-2" },
  ];

  const getOrderedIds = createOrderedIdsRunner({
    window: {
      __PI_ENH_GET_SESSION_GROUPS__: () => mockFamilies,
    },
    document: {
      querySelectorAll: () => domRows,
    },
  });

  const ids = getOrderedIds();
  // 只有当前项目且可见的会话被选入，别项目与归档残留彻底隔离
  assert.deepEqual(ids, ["p1-root-1", "p1-root-2"]);
  assert(!ids.includes("other-project-session"));
  assert(!ids.includes("hidden-archived-session"));
  assert(!ids.includes("p1-sub-collapsed"));
});

// ==========================================
// 3. 工作区切换与状态清理安全防泄漏用例
// ==========================================

test("用例 11: cleanBatchTouchState 抑制尾随 click 与多指安全清理", () => {
  // 验证 05 模块中的 cleanBatchTouchState 与 click 抑制时间戳
  assert(code.includes("batchTouchClickSuppressionUntil = Date.now() + 450;"));
  assert(code.includes("event.touches.length !== 1"));
  assert(code.includes("cleanBatchTouchState(true)"));
});

test("用例 12: 工作区改变检测 checkBatchWorkspaceChange 完整清理选区与触摸快照", () => {
  assert(code.includes("function checkBatchWorkspaceChange()"));
  assert(code.includes("lastBatchActiveWorkspace !== currentKey"));
  assert(code.includes("selectedSessionBatchIds.clear()"));
  assert(code.includes("cleanBatchTouchState(true)"));
});

test("用例 13: 自动滚动 raf 读取最新保存 touch x/y 并以实际 overflow 祖先滚动", () => {
  assert(code.includes("updateBatchSelectionFromPoint(batchTouchLastX, batchTouchLastY);"));
  assert(code.includes("function getBatchScrollContainer("));
  assert(code.includes("el.scrollHeight > el.clientHeight"));
});
