import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const {
  getToolPublicStatus,
  getToolPublicCategoryKey,
  createToolProcessSummary,
  includeToolInProcessSummary,
  getToolProcessSummaryLabel,
  completeActiveToolResult,
  getProcessSubagentTiming,
  formatProcessDuration,
  isValidTimestamp,
} = await createJiti(import.meta.url).import('./tool-public-status.ts');
test('tool success requires a final result; partial output never counts as success',()=>{const b={toolName:'bash'};assert.equal(getToolPublicStatus(b),'running');assert.equal(getToolPublicStatus(b,{content:[],inProgress:true}),'running');assert.equal(getToolPublicStatus(b,{content:[],isError:true}),'failure');assert.equal(getToolPublicStatus(b,{content:[],isError:false}),'success');assert.equal(getToolPublicStatus({toolName:'apply_patch'},{content:[],details:{result:{failures:[{filePath:'a',message:'fail'}]}}}),'failure');});
test('unknown tools use a neutral category rather than expose their raw name',()=>{assert.equal(getToolPublicCategoryKey('unknown_sensitive_name'),'chat.toolCategory.generic');assert.equal(getToolPublicCategoryKey('bash'),'chat.toolCategory.command');assert.equal(getToolPublicCategoryKey('read'),'chat.toolCategory.read');});

const translations={"chat.toolCategory.read":"读取文件","chat.toolCategory.command":"运行命令","chat.toolCategory.search":"搜索","chat.processAction.generic":"调用工具","chat.processAction.subagent":"执行子任务","chat.processActionSeparator":"、","chat.processRunning":"正在{actions}","chat.processExecuted":"已执行：{actions}","chat.thinking":"正在思考...","chat.processThinkingRecord":"思考记录","chat.toolStatusRunningCount":"运行中 {count} 项","chat.toolStatusSuccessCount":"成功 {count} 项","chat.toolStatusFailureCount":"失败 {count} 项"};
const t=(key,params={})=>Object.entries(params).reduce((s,[k,v])=>s.replace(`{${k}}`,String(v)),translations[key]??key);
test('current action changes on final tool result and uses active categories only',()=>{
 const read={toolName:'read'},command={toolName:'bash'};
 let s=createToolProcessSummary();includeToolInProcessSummary(s,read,{inProgress:true});includeToolInProcessSummary(s,command);
 assert.equal(getToolProcessSummaryLabel(s,t),'正在读取文件、运行命令 · 运行中 2 项');
 s=createToolProcessSummary();includeToolInProcessSummary(s,read,{content:[]});includeToolInProcessSummary(s,command,{inProgress:true});
 assert.equal(getToolProcessSummaryLabel(s,t),'正在运行命令 · 运行中 1 项 · 成功 1 项');
 s=createToolProcessSummary();includeToolInProcessSummary(s,read,{content:[]});includeToolInProcessSummary(s,command,{content:[]});
 assert.equal(getToolProcessSummaryLabel(s,t),'已执行：读取文件、运行命令 · 成功 2 项');
});
test('failures stay visible; actions are bounded and never disclose names or arguments',()=>{
 const s=createToolProcessSummary();for(let i=0;i<30;i++)includeToolInProcessSummary(s,{toolName:'private_custom_tool',arguments:{token:'SECRET'}},{isError:true});
 assert.equal(getToolProcessSummaryLabel(s,t),'已执行：调用工具 · 失败 30 项');assert.equal(s.categories.length,1);
});
test('thinking-only history is not presented as still running',()=>{
 const s=createToolProcessSummary();assert.equal(getToolProcessSummaryLabel(s,t,true),'正在思考...');assert.equal(getToolProcessSummaryLabel(s,t,false),'思考记录');
});

test('slim execution end establishes final status before transcript result arrives',()=>{
 const block={toolName:'read'};
 const completed=completeActiveToolResult(undefined,{toolCallId:'read-1',toolName:'read',isError:false});
 assert.equal(getToolPublicStatus(block,completed),'success');assert.deepEqual(completed.content,[]);
 const partial={role:'toolResult',toolCallId:'cmd-1',toolName:'bash',content:[{type:'text',text:'partial'}],inProgress:true,isError:false};
 const failed=completeActiveToolResult(partial,{toolCallId:'cmd-1',isError:true});
 assert.equal(getToolPublicStatus({toolName:'bash'},failed),'failure');assert.equal(failed.content,partial.content);assert.equal(partial.inProgress,true);
});

test('non-subagent tools never produce subagent timing', () => {
  const summary = createToolProcessSummary();
  includeToolInProcessSummary(summary, { toolName: 'read', toolCallId: 'r1', input: {} }, { content: [], timestamp: 2000 }, 1000);
  includeToolInProcessSummary(summary, { toolName: 'bash', toolCallId: 'b1', input: {} }, undefined, 1500);
  assert.equal(getProcessSubagentTiming(summary), null);
});

test('single subagent live duration ticks forward and handles inProgress without premature completion', () => {
  const summary = createToolProcessSummary();
  const subagentCall = { toolName: 'subagent', toolCallId: 'sub-1', input: {} };
  // 1. Streaming tool call with no result yet
  includeToolInProcessSummary(summary, subagentCall, undefined, 10_000);
  let timing = getProcessSubagentTiming(summary, 12_500);
  assert.equal(timing?.hasSubagent, true);
  assert.equal(timing?.running, true);
  assert.equal(timing?.startTime, 10_000);
  assert.equal(timing?.durationMs, 2_500);
  assert.equal(formatProcessDuration(timing?.durationMs), '2s');

  // 2. Middle inProgress result arrives, still running
  includeToolInProcessSummary(summary, subagentCall, { role: 'toolResult', toolCallId: 'sub-1', content: [], inProgress: true, timestamp: 13_000 }, 10_000);
  timing = getProcessSubagentTiming(summary, 14_800);
  assert.equal(timing?.running, true);
  assert.equal(timing?.durationMs, 4_800);
  assert.equal(formatProcessDuration(timing?.durationMs), '4s');

  // 3. Final completion result arrives
  includeToolInProcessSummary(summary, subagentCall, { role: 'toolResult', toolCallId: 'sub-1', content: [], inProgress: false, timestamp: 16_200 }, 10_000);
  timing = getProcessSubagentTiming(summary, 99_999);
  assert.equal(timing?.running, false);
  assert.equal(timing?.startTime, 10_000);
  assert.equal(timing?.endTime, 16_200);
  assert.equal(timing?.durationMs, 6_200);
  assert.equal(formatProcessDuration(timing?.durationMs), '6s');
});

test('multiple subagents in a group adopt earliest start to latest end semantics', () => {
  // Case A: All completed
  const summaryA = createToolProcessSummary();
  includeToolInProcessSummary(summaryA, { toolName: 'subagent', toolCallId: 'sub-a1', input: {} }, { role: 'toolResult', toolCallId: 'sub-a1', content: [], timestamp: 14_000 }, 12_000);
  includeToolInProcessSummary(summaryA, { toolName: 'Agent', toolCallId: 'sub-a2', input: {} }, { role: 'toolResult', toolCallId: 'sub-a2', content: [], timestamp: 19_000 }, 11_000);
  const timingA = getProcessSubagentTiming(summaryA);
  assert.equal(timingA?.hasSubagent, true);
  assert.equal(timingA?.running, false);
  assert.equal(timingA?.startTime, 11_000); // min(12000, 11000)
  assert.equal(timingA?.endTime, 19_000);   // max(14000, 19000)
  assert.equal(timingA?.durationMs, 8_000); // 19000 - 11000 = 8000
  assert.equal(formatProcessDuration(timingA?.durationMs), '8s');

  // Case B: One finished, one still running -> whole group ticks until last finishes
  const summaryB = createToolProcessSummary();
  includeToolInProcessSummary(summaryB, { toolName: 'subagent', toolCallId: 'sub-b1', input: {} }, { role: 'toolResult', toolCallId: 'sub-b1', content: [], timestamp: 15_000 }, 10_000);
  includeToolInProcessSummary(summaryB, { toolName: 'subagent', toolCallId: 'sub-b2', input: {} }, { role: 'toolResult', toolCallId: 'sub-b2', content: [], inProgress: true }, 13_000);
  const timingB = getProcessSubagentTiming(summaryB, 18_000);
  assert.equal(timingB?.running, true);
  assert.equal(timingB?.startTime, 10_000);
  assert.equal(timingB?.durationMs, 8_000); // 18000 - 10000 = 8000
  assert.equal(formatProcessDuration(timingB?.durationMs), '8s');
});

test('duration formatting handles zero, seconds, minutes, and hours accurately', () => {
  assert.equal(formatProcessDuration(undefined), null);
  assert.equal(formatProcessDuration(-5), null);
  assert.equal(formatProcessDuration(0), '0s');
  assert.equal(formatProcessDuration(999), '0s');
  assert.equal(formatProcessDuration(1_000), '1s');
  assert.equal(formatProcessDuration(59_000), '59s');
  assert.equal(formatProcessDuration(60_000), '1m 0s');
  assert.equal(formatProcessDuration(125_000), '2m 5s');
  assert.equal(formatProcessDuration(3_661_000), '1h 1m 1s');
});

test('handles missing or invalid timestamps without fabricating time', () => {
  const summary = createToolProcessSummary();
  includeToolInProcessSummary(summary, { toolName: 'subagent', toolCallId: 'sub-no-ts', input: {} }, undefined, undefined);
  const timing = getProcessSubagentTiming(summary, 20_000);
  assert.equal(timing?.hasSubagent, true);
  assert.equal(timing?.running, true);
  assert.equal(timing?.startTime, undefined);
  assert.equal(timing?.durationMs, undefined);
  assert.equal(formatProcessDuration(timing?.durationMs), null);
});

test('completeActiveToolResult retains provided timestamp or fills client completion moment', () => {
  const withExplicit = completeActiveToolResult(undefined, { toolCallId: 't1', toolName: 'subagent', timestamp: 50_000 });
  assert.equal(withExplicit.timestamp, 50_000);

  const before = Date.now();
  const withMissing = completeActiveToolResult(undefined, { toolCallId: 't2', toolName: 'subagent' });
  const after = Date.now();
  assert(typeof withMissing.timestamp === 'number');
  assert(withMissing.timestamp >= before && withMissing.timestamp <= after);
});

test('completeActiveToolResult overrides previous.inProgress timestamp and preserves only completed timestamp', () => {
  const inProgressPartial = {
    role: 'toolResult',
    toolCallId: 'sub-prog-1',
    toolName: 'subagent',
    content: [],
    inProgress: true,
    timestamp: 10_000,
  };

  // Case 1: previous was inProgress, end event lacks timestamp -> must NOT use 10_000, fills client completion moment
  const before = Date.now();
  const completedNoEventTs = completeActiveToolResult(inProgressPartial, { toolCallId: 'sub-prog-1' });
  const after = Date.now();
  assert.equal(completedNoEventTs.inProgress, false);
  assert.notEqual(completedNoEventTs.timestamp, 10_000, 'inProgress timestamp must not be mistaken for end time');
  assert(completedNoEventTs.timestamp >= before && completedNoEventTs.timestamp <= after);

  // Case 2: previous was inProgress, end event provides explicit timestamp -> prioritize event timestamp
  const completedWithEventTs = completeActiveToolResult(inProgressPartial, { toolCallId: 'sub-prog-1', timestamp: 25_000 });
  assert.equal(completedWithEventTs.timestamp, 25_000);

  // Case 3: previous was already completed (not inProgress) -> preserve its existing completion timestamp
  const alreadyCompleted = {
    role: 'toolResult',
    toolCallId: 'sub-done-1',
    toolName: 'subagent',
    content: [],
    inProgress: false,
    timestamp: 12_345,
  };
  const recompleted = completeActiveToolResult(alreadyCompleted, { toolCallId: 'sub-done-1' });
  assert.equal(recompleted.timestamp, 12_345, 'Completed previous result must retain its completion timestamp');
});

test('multiple subagents with partially missing end times conservatively hide final aggregated duration', () => {
  const summary = createToolProcessSummary();
  // subagent 1 completed with valid timestamp
  includeToolInProcessSummary(summary, { toolName: 'subagent', toolCallId: 'sub-m1', input: {} }, { role: 'toolResult', toolCallId: 'sub-m1', content: [], inProgress: false, timestamp: 4_000 }, 1_000);
  // subagent 2 completed without timestamp (endTime is undefined)
  includeToolInProcessSummary(summary, { toolName: 'Agent', toolCallId: 'sub-m2', input: {} }, { role: 'toolResult', toolCallId: 'sub-m2', content: [], inProgress: false }, 2_000);

  const timing = getProcessSubagentTiming(summary);
  assert.equal(timing?.hasSubagent, true);
  assert.equal(timing?.running, false);
  assert.equal(timing?.startTime, 1_000);
  assert.equal(timing?.endTime, undefined, 'Must not output partial/misleading endTime');
  assert.equal(timing?.durationMs, undefined, 'Must conservatively hide duration when some end times are missing');
  assert.equal(formatProcessDuration(timing?.durationMs), null);
});


