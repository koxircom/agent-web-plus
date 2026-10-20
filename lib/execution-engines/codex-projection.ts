import type { AgentMessage, AssistantMessage, SessionInfo } from "../types";
import type {SessionUsageSnapshot} from "../session-usage";

export interface CodexRequest {
  id: string | number; method: string; supported: boolean;
  // Native request parameters vary by approval and user-input method.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
}
export interface CodexRow {
  key: string; requestId?: string; deliveryConfirmed?: boolean; turnId: string; order: number; version: string; role: string;
  kind?: string; status?: string; title?: string; text: string; truncated?: boolean; turnStatus?: string;
  attachments?: { name?: string; type?: string; uploadId?: string; path?: string }[];
}
export interface CodexComposerState {
  revision?: number;
  version: 1; mode: "normal" | "plan" | "goal"; capabilities: { goal: boolean; plan: boolean };
  goal?: string; goalKnown?: boolean; paused?: boolean; goalStatus?: string;
  goalIdentity?: { objective: string; createdAt?: number | null };
  goalElapsedMs?: number; goalActiveSinceMs?: number;
}
export interface CodexMeta {
  composerState?: CodexComposerState;
  id: string; title: string; cwd: string; model?: string; provider?: string; effort?: string;
  status: string; connected: boolean; sequence: number;
  submissions?: { id: string; clientRequestId?: string; text: string; status: string; mode?: string; error?: string }[];
  requests?: CodexRequest[]; historyComplete?: boolean; userMessageCount?: number;
  contextUsage?: {usedTokens:number;contextWindow:number|null;cached?:boolean}|null;
  tokenUsage?: {inputTokens:number;cachedInputTokens:number;outputTokens:number;reasoningOutputTokens?:number;totalTokens:number}|null;
}
export interface CodexPage {
  epoch: string; sequence: number; rows: CodexRow[]; before?: string; hasMore?: boolean;
  reset?: boolean; meta: CodexMeta;
}
/** Project both GET and SSE through Pi's existing composer-status contract. */
export function projectCodexComposer(meta: CodexMeta): CodexComposerState {
  const state = meta.composerState;
  if (!state || state.version !== 1 || !["normal", "plan", "goal"].includes(state.mode)) {
    return { version: 1, mode: "normal", capabilities: { goal: false, plan: false } };
  }
  return { ...state, capabilities: { goal: state.capabilities?.goal === true, plan: state.capabilities?.plan === true } };
}
export function codexComposerStatuses(meta: CodexMeta) {
  return [{ key: "composer-modes", text: JSON.stringify(projectCodexComposer(meta)) }];
}
/** A configured remote workspace is selectable; "/" is the virtual root. */
export function projectCodexDirectories(projects: { name: string; cwd: string }[], path?: string | null) {
  const selected = projects.find(project => project.cwd === path);
  return { path: selected?.cwd || "", parentPath: selected ? "/" : null,
    directories: selected ? [] : projects.map(project => ({ name: project.name, path: project.cwd })) };
}
export const codexProjectKey = (cwd: string) => "codex:" + cwd;
export const publicCodexId = (id: string) => "codex:" + id;
/** Native input includes cached input; Pi's shared counters store it separately. */
export function projectCodexUsage(meta:CodexMeta):SessionUsageSnapshot {
  const valid=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
  const ctx=meta.contextUsage,raw=meta.tokenUsage;
  const window=ctx&&valid(ctx.contextWindow)&&ctx.contextWindow>0?ctx.contextWindow:0;
  const contextUsage=ctx&&valid(ctx.usedTokens)?{tokens:ctx.usedTokens,contextWindow:window,percent:window?ctx.usedTokens/window*100:null}:null;
  const tokens=raw&&[raw.inputTokens,raw.outputTokens,raw.totalTokens,raw.cachedInputTokens].every(valid)&&raw.cachedInputTokens<=raw.inputTokens
    ?{input:raw.inputTokens-raw.cachedInputTokens,output:raw.outputTokens,cacheRead:raw.cachedInputTokens,cacheWrite:0,total:raw.totalTokens}:null;
  return {contextUsage,tokens};
}
export function assistantText(meta: CodexMeta, text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }],
           model: meta.model || "Codex", provider: "codex", stopReason: meta.status === "active" ? undefined : "stop" };
}
export function projectCodexRow(row: CodexRow, meta: CodexMeta, epoch?: string): AgentMessage[] {
  if (row.role === "user") {
    const content: import("../types").UserMessage["content"] = [{ type: "text", text: row.text }];
    const images = row.attachments?.filter(a => a.uploadId && a.type === "localImage") || [];
    for (const image of images) content.push({ type: "image", source: { type: "url",
      url: `/api/execution-engines/codex-image?thread=${encodeURIComponent(meta.id)}&upload=${encodeURIComponent(image.uploadId!)}` } });
    return [{ role: "user", content }];
  }
  if (row.role === "assistant") return [assistantText(meta, row.text)];
  if (row.role === "activity" && row.kind === "reasoning") return [{ ...assistantText(meta, ""), content: [{ type: "thinking", thinking: row.text }] }];
  if (row.role === "activity") {
    const name = row.kind === "commandExecution" ? "bash" : "codex_tool";
    return [{ ...assistantText(meta, ""), content: [{ type: "toolCall", toolCallId: row.key,
              toolName: name, input: { command: row.text, description: row.title || "Codex 工具" } }] },
            { role: "toolResult", toolCallId: row.key, toolName: name,
              content: [{ type: "text", text: row.text }], inProgress: row.status === "inProgress", isError: row.status === "failed",
              ...(row.truncated && epoch ? { deferredResult: { entryId: `${epoch}.${row.key}`, revision: row.version } } : {}) }];
  }
  return [{ role: "custom", customType: "codex", display: true, content: row.text }];
}
export function projectCodexPage(page: CodexPage, id: string) {
  const messages: AgentMessage[] = [], entryIds: string[] = [];
  const promptEntryIds: Record<string, string> = {};
  const last = page.rows.at(-1);
  for (const row of page.rows) {
    // The active assistant belongs to the existing native SSE snapshot. Putting
    // it in saved context as well would render the same bubble twice on resume.
    if (row === last && row.role === "assistant" && row.turnStatus === "inProgress" && page.meta.status === "active") continue;
    if (row.role === "user" && row.requestId) promptEntryIds[row.requestId] = row.key + ":0";
    const projected = projectCodexRow(row, page.meta, page.epoch);
    projected.forEach((message, i) => { messages.push(message); entryIds.push(row.key + ":" + i); });
  }
  return {
    sessionId: id, filePath: id, header: { type: "session", id, cwd: page.meta.cwd, timestamp: new Date().toISOString() },
    sessionName: page.meta.title, totalActiveMs: 0, tree: [], treeFormat: "summary" as const,
    // Codex projects a linear timeline, not a Pi branch tree. A moving tail
    // must not cancel an in-flight ancestor page as a branch switch.
    leafId: null,
    snapshotRevision: page.meta.status === "active" ? null : `codex:${page.epoch}:${page.sequence}`,
    navigationTotalTurns: page.meta.userMessageCount,
    usage: projectCodexUsage(page.meta),
    promptEntryIds, executionEngine: "codex", capabilities: { branch: false, compact: false, tools: false },
    context: { messages, entryIds, oldestEntryId: page.before || null,
      hasMore: Boolean(page.hasMore || page.meta.historyComplete === false), thinkingLevel: page.meta.effort || "high",
      model: { provider: "codex", modelId: page.meta.model || "Codex" } },
  };
}
export function projectCodexSession(row: { id: string; title: string; cwd: string; path?: string; updatedAt?: number; recency?: number }): SessionInfo {
  const modified = new Date(typeof row.recency === "number" && Number.isFinite(row.recency) && row.recency > 0
    ? row.recency : row.updatedAt ? row.updatedAt * 1000 : Date.now()).toISOString();
  return { id: publicCodexId(row.id), path: row.path || publicCodexId(row.id), cwd: row.cwd,
    name: row.title, firstMessage: row.title, created: modified, modified, messageCount: 0,
    detailsPending: true, projectRoot: row.cwd, projectKey: codexProjectKey(row.cwd) };
}
