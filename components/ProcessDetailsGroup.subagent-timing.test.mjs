import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const {
  createToolProcessSummary,
  includeToolInProcessSummary,
  getProcessSubagentTiming,
  formatProcessDuration,
  formatProcessDurationZh,
  getToolProcessSummaryLabel,
} = await createJiti(import.meta.url).import("../lib/tool-public-status.ts");

const t = (key, params = {}) =>
  Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), key);

test("ProcessDetailsGroup data flow: subagent timing is included only when subagents exist", () => {
  // Scenario 1: Only bash & read tools
  const summaryRegular = createToolProcessSummary();
  includeToolInProcessSummary(summaryRegular, { toolName: "read", toolCallId: "r1", input: {} }, { role: "toolResult", toolCallId: "r1", content: [], timestamp: 2000 }, 1000);
  includeToolInProcessSummary(summaryRegular, { toolName: "bash", toolCallId: "b1", input: {} }, { role: "toolResult", toolCallId: "b1", content: [], timestamp: 3000 }, 1500);

  const timingRegular = getProcessSubagentTiming(summaryRegular);
  assert.equal(timingRegular, null, "Regular tool group must not have subagent timing");

  // Scenario 2: Group containing subagents
  const summarySubagent = createToolProcessSummary();
  includeToolInProcessSummary(summarySubagent, { toolName: "subagent", toolCallId: "s1", input: {} }, { role: "toolResult", toolCallId: "s1", content: [], timestamp: 5000 }, 1000);

  const timingSubagent = getProcessSubagentTiming(summarySubagent);
  assert.notEqual(timingSubagent, null);
  assert.equal(timingSubagent?.hasSubagent, true);
  assert.equal(timingSubagent?.running, false);
  assert.equal(timingSubagent?.durationMs, 4000);
  assert.equal(formatProcessDuration(timingSubagent?.durationMs), "4s");
});

test("ProcessDetailsGroup data flow: multiple subagents earliest start to latest end", () => {
  const summary = createToolProcessSummary();

  // Assistant turn 1 invokes subagent 1 at T = 1000, finishes at T = 4000
  includeToolInProcessSummary(summary, { toolName: "subagent", toolCallId: "s1", input: {} }, { role: "toolResult", toolCallId: "s1", content: [], timestamp: 4000 }, 1000);

  // Assistant turn 2 invokes subagent 2 at T = 2000, finishes at T = 7500
  includeToolInProcessSummary(summary, { toolName: "Agent", toolCallId: "s2", input: {} }, { role: "toolResult", toolCallId: "s2", content: [], timestamp: 7500 }, 2000);

  const timing = getProcessSubagentTiming(summary);
  assert.equal(timing?.hasSubagent, true);
  assert.equal(timing?.running, false);
  assert.equal(timing?.startTime, 1000, "Should select earliest start (1000)");
  assert.equal(timing?.endTime, 7500, "Should select latest end (7500)");
  assert.equal(timing?.durationMs, 6500);
  assert.equal(formatProcessDuration(timing?.durationMs), "6s");
});

test("ProcessDetailsGroup data flow: live ticking when at least one subagent is running", () => {
  const summary = createToolProcessSummary();

  // Subagent 1 completed in 3 seconds
  includeToolInProcessSummary(summary, { toolName: "subagent", toolCallId: "s1", input: {} }, { role: "toolResult", toolCallId: "s1", content: [], timestamp: 4000 }, 1000);

  // Subagent 2 still running (started at 2000, current now = 10000)
  includeToolInProcessSummary(summary, { toolName: "subagent", toolCallId: "s2", input: {} }, undefined, 2000);

  const timing = getProcessSubagentTiming(summary, 10000);
  assert.equal(timing?.hasSubagent, true);
  assert.equal(timing?.running, true);
  assert.equal(timing?.startTime, 1000, "Group start should be earliest start (1000)");
  assert.equal(timing?.durationMs, 9000, "Live duration should be now(10000) - groupStart(1000)");
  assert.equal(formatProcessDuration(timing?.durationMs), "9s");
});

test("ProcessDetailsGroup data flow: missing timestamp gracefully ignored without fabricating time", () => {
  const summary = createToolProcessSummary();
  includeToolInProcessSummary(summary, { toolName: "subagent", toolCallId: "s1", input: {} }, undefined, undefined);

  const timing = getProcessSubagentTiming(summary, 5000);
  assert.equal(timing?.hasSubagent, true);
  assert.equal(timing?.running, true);
  assert.equal(timing?.startTime, undefined);
  assert.equal(timing?.durationMs, undefined);
  assert.equal(formatProcessDuration(timing?.durationMs), null);
});

test("ProcessDetailsGroup data flow: multiple subagents with partially missing end times conservatively hide duration", () => {
  const summary = createToolProcessSummary();

  // Subagent 1 finished with valid timestamp (endTime: 4000)
  includeToolInProcessSummary(summary, { toolName: "subagent", toolCallId: "s1", input: {} }, { role: "toolResult", toolCallId: "s1", content: [], timestamp: 4000 }, 1000);

  // Subagent 2 finished without timestamp
  includeToolInProcessSummary(summary, { toolName: "Agent", toolCallId: "s2", input: {} }, { role: "toolResult", toolCallId: "s2", content: [] }, 2000);

  const timing = getProcessSubagentTiming(summary);
  assert.equal(timing?.hasSubagent, true);
  assert.equal(timing?.running, false);
  assert.equal(timing?.startTime, 1000);
  assert.equal(timing?.endTime, undefined, "Must not use partial endTime when another subagent lacks endTime");
  assert.equal(timing?.durationMs, undefined, "Duration must be hidden to prevent misleading aggregation");
  assert.equal(formatProcessDuration(timing?.durationMs), null);
});

test("ProcessDurationBadge in ChatWindow.tsx displays estimated prefix and explanatory title in owner source", async () => {
  const fs = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const chatWindowPath = fileURLToPath(new URL("./ChatWindow.tsx", import.meta.url));
  const source = fs.readFileSync(chatWindowPath, "utf8");

  assert.match(
    source,
    /title="根据消息时间估算，非工具精确执行时间"/,
    "ProcessDurationBadge must declare explanatory title about time estimation",
  );
  assert.match(
    source,
    /≈\{text\}/,
    "ProcessDurationBadge must display ≈ prefix before formatted text",
  );
  assert.match(
    source,
    /⏱️\s*≈\{text\}/,
    "ProcessDurationBadge must render stopwatch emoji before ≈ prefix",
  );
  assert.match(
    source,
    /#38bdf8/,
    "ProcessDurationBadge style must use #38bdf8 matching live timer",
  );
  assert.match(
    source,
    /fontWeight:\s*500/,
    "ProcessDurationBadge style must declare font weight 500",
  );
  assert.match(
    source,
    /PROCESS_DETAILS_WRAPPER_STYLE/,
    "ProcessDetailsGroup must use inline flexwrap wrapper for label and badge",
  );
});

test("formatProcessDurationZh outputs Chinese time format for subagent timings", () => {
  assert.equal(formatProcessDurationZh(undefined), null);
  assert.equal(formatProcessDurationZh(-500), null);
  assert.equal(formatProcessDurationZh(0), "0秒");
  assert.equal(formatProcessDurationZh(4000), "4秒");
  assert.equal(formatProcessDurationZh(6500), "6秒");
  assert.equal(formatProcessDurationZh(9000), "9秒");
  assert.equal(formatProcessDurationZh(65000), "1分5秒");
  assert.equal(formatProcessDurationZh(3665000), "1小时1分5秒");
});


