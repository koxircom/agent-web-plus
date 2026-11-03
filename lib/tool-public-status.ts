import { applyPatchResultHasFailures } from "./apply-patch";
import { isApplyPatchToolName, isEditToolName, isWriteToolName } from "./tool-names";
import type { ToolCallContent, ToolResultMessage } from "./types";

export type ToolPublicStatus = "running" | "success" | "failure";

export type ToolPublicCategoryKey =
  | "chat.toolCategory.read"
  | "chat.toolCategory.command"
  | "chat.toolCategory.write"
  | "chat.toolCategory.search"
  | "chat.toolCategory.subagent"
  | "chat.toolCategory.generic";

/** Project a tool result to the short status shown in the conversation. */
export function getToolPublicStatus(
  block: ToolCallContent,
  result?: ToolResultMessage,
): ToolPublicStatus {
  if (!result || result.inProgress) return "running";
  if (result.isError || (isApplyPatchToolName(block.toolName) && applyPatchResultHasFailures(result.details))) {
    return "failure";
  }
  return "success";
}

/** Map implementation-specific tool names to a small set of user-facing categories. */
export function getToolPublicCategoryKey(toolName: string): ToolPublicCategoryKey {
  const name = toolName.toLowerCase();
  const tokens = name.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...values: string[]) => values.some((value) => tokens.includes(value));

  if (has("agent", "subagent", "sub_agent") || name.includes("get_subagent_result") || name.includes("steer_subagent")) {
    return "chat.toolCategory.subagent";
  }
  if (has("bash", "powershell", "shell", "terminal", "exec", "execute", "command")) {
    return "chat.toolCategory.command";
  }
  if (
    isApplyPatchToolName(toolName)
    || isEditToolName(toolName)
    || isWriteToolName(toolName)
    || has("patch", "create", "update", "delete", "remove", "move", "rename", "mkdir")
  ) {
    return "chat.toolCategory.write";
  }
  if (has("grep", "find", "search", "glob", "ripgrep", "rg", "query")) {
    return "chat.toolCategory.search";
  }
  if (has("read", "file", "get", "list", "ls", "cat", "open", "fetch")) {
    return "chat.toolCategory.read";
  }
  return "chat.toolCategory.generic";
}

/** Small, render-local projection: never retain arguments, results or a second
 * execution state. At most six unique category keys are stored per group. */
export type ToolProcessSummary = {
  running: number;
  success: number;
  failure: number;
  categories: ToolPublicCategoryKey[];
  runningCategories: ToolPublicCategoryKey[];
  subagents?: SubagentExecutionRecord[];
};

export type SubagentExecutionRecord = {
  toolCallId: string;
  running: boolean;
  startTime?: number;
  endTime?: number;
};

export type ProcessSubagentTiming = {
  hasSubagent: boolean;
  running: boolean;
  startTime?: number;
  endTime?: number;
  durationMs?: number;
};

export function isValidTimestamp(val: unknown): val is number {
  return typeof val === "number" && Number.isFinite(val) && val > 0;
}

export function createToolProcessSummary(): ToolProcessSummary {
  return { running: 0, success: 0, failure: 0, categories: [], runningCategories: [] };
}

export function includeToolInProcessSummary(
  summary: ToolProcessSummary,
  block: ToolCallContent,
  result?: ToolResultMessage,
  messageTimestamp?: number,
): void {
  const status = getToolPublicStatus(block, result);
  const category = getToolPublicCategoryKey(block.toolName);
  summary[status]++;
  if (!summary.categories.includes(category)) summary.categories.push(category);
  if (status === "running" && !summary.runningCategories.includes(category)) summary.runningCategories.push(category);

  if (category === "chat.toolCategory.subagent") {
    summary.subagents ??= [];
    const isRunning = status === "running";
    const startTime = isValidTimestamp(messageTimestamp) ? messageTimestamp : undefined;
    const endTime = !isRunning && isValidTimestamp(result?.timestamp) ? result.timestamp : undefined;

    const existing = summary.subagents.find((s) => s.toolCallId === block.toolCallId);
    if (existing) {
      existing.running = isRunning;
      if (startTime !== undefined && existing.startTime === undefined) existing.startTime = startTime;
      if (endTime !== undefined) existing.endTime = endTime;
    } else {
      summary.subagents.push({
        toolCallId: block.toolCallId,
        running: isRunning,
        startTime,
        endTime,
      });
    }
  }
}

export function getProcessSubagentTiming(
  summary: ToolProcessSummary,
  now = Date.now(),
): ProcessSubagentTiming | null {
  if (!summary.subagents || summary.subagents.length === 0) return null;

  const isRunning = summary.subagents.some((s) => s.running);
  const startTimes = summary.subagents
    .map((s) => s.startTime)
    .filter(isValidTimestamp);

  if (startTimes.length < summary.subagents.length) {
    return { hasSubagent: true, running: isRunning };
  }

  const startTime = Math.min(...startTimes);

  if (isRunning) {
    const durationMs = Math.max(0, now - startTime);
    return {
      hasSubagent: true,
      running: true,
      startTime,
      durationMs,
    };
  }

  const endTimes = summary.subagents
    .map((s) => s.endTime)
    .filter(isValidTimestamp);

  if (endTimes.length < summary.subagents.length) {
    return {
      hasSubagent: true,
      running: false,
      startTime,
    };
  }

  const endTime = Math.max(...endTimes);
  const durationMs = Math.max(0, endTime - startTime);
  return {
    hasSubagent: true,
    running: false,
    startTime,
    endTime,
    durationMs,
  };
}

export function formatProcessDuration(ms?: number): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatProcessDurationZh(ms?: number): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}小时${m}分${s}秒`;
  if (m > 0) return `${m}分${s}秒`;
  return `${s}秒`;
}

export function getToolProcessSummaryLabel(
  summary: ToolProcessSummary,
  t: (key: string, params?: Record<string, string | number>) => string,
  streamingThinking = false,
): string {
  const categories = summary.running ? summary.runningCategories : summary.categories;
  if (!categories.length) return t(streamingThinking ? "chat.thinking" : "chat.processThinkingRecord");
  const actions = categories.map(key => t(key === "chat.toolCategory.generic" ? "chat.processAction.generic"
    : key === "chat.toolCategory.subagent" ? "chat.processAction.subagent" : key)).join(t("chat.processActionSeparator"));
  const parts = [t(summary.running ? "chat.processRunning" : "chat.processExecuted", {actions})];
  if (summary.running) parts.push(t("chat.toolStatusRunningCount", {count: summary.running}));
  if (summary.success) parts.push(t("chat.toolStatusSuccessCount", {count: summary.success}));
  if (summary.failure) parts.push(t("chat.toolStatusFailureCount", {count: summary.failure}));
  return parts.join(" · ");
}

/** The slim execution-end event establishes status before the transcript result
 * arrives. Reuse partial output until that authoritative message replaces it. */
export function completeActiveToolResult(
  previous: ToolResultMessage | undefined,
  event: { toolCallId: string; toolName?: string; isError?: boolean; timestamp?: number },
): ToolResultMessage {
  const timestamp = (previous && !previous.inProgress && isValidTimestamp(previous.timestamp))
    ? previous.timestamp
    : (isValidTimestamp(event.timestamp) ? event.timestamp : Date.now());

  return {
    ...previous,
    role: "toolResult",
    toolCallId: event.toolCallId,
    toolName: event.toolName ?? previous?.toolName,
    content: previous?.content ?? [],
    isError: event.isError ?? previous?.isError,
    inProgress: false,
    timestamp,
  };
}
