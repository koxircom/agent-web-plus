import { SESSION_SYNC_PROTOCOL } from "./session-sync-protocol.ts";
import type { AgentMessage } from "./types.ts";
import type { SessionData } from "../hooks/useAgentSession.ts";
import type { SessionWireBaseline } from "./session-view-cache.ts";
export { SESSION_SYNC_PROTOCOL };

export interface MinimalStorage { getItem(key: string): string | null }
export function isSessionMemoryCacheEnabled(customStorage?: MinimalStorage): boolean {
  try {
    if (!customStorage && typeof window !== "undefined") {
      const hook = (window as unknown as { __PI_ENH_IS_PLUGIN_ENABLED__?: (id: string) => boolean }).__PI_ENH_IS_PLUGIN_ENABLED__;
      if (hook) return hook("session-memory-cache");
    }
    const storage = customStorage ?? (typeof window !== "undefined" ? window.localStorage : null);
    const settings = JSON.parse(storage?.getItem("pi-enh-settings-v1") || "null");
    if (settings?.modules?.["local-workspace"]?.enabled === false) return false;
    const feature = settings?.features?.["session-memory-cache"]?.enabled;
    if (typeof feature === "boolean") return feature;
    return storage?.getItem("pi-enh-plugin-session-memory-cache") !== "false";
  } catch { return false; } // Restricted storage/unknown state must not override a disabled feature.
}

export function buildSessionSyncUrl(options: {
  sessionId: string; baseRevision?: string | null; force?: boolean; syncEnabled?: boolean;
  treeFormat?: "summary" | "full"; additionalParams?: Record<string, string>;
}): string {
  const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1", deferTools: "1", tree: options.treeFormat ?? "summary", ...options.additionalParams });
  if (options.force) params.set("force", "1");
  if (options.syncEnabled !== false) {
    params.set("sync", "1");
    if (options.baseRevision) params.set("baseRevision", options.baseRevision);
  } else { params.delete("sync"); params.delete("baseRevision"); }
  return `/api/sessions/${encodeURIComponent(options.sessionId)}?${params}`;
}

/** Only committed history changes invalidate disk/network snapshots. Streaming
 * deltas and replayed tool progress update separate state and must not starve
 * initial hydration before it even reaches fetch. Reconnection and completion are read barriers:
 * a pre-handshake/settlement flight must not certify the current transcript. */
export function invalidatesSessionHistory(eventType: string): boolean {
  return /^(connected|message_end|agent_settled|prompt_done|compaction_start|auto_compaction_start)$/.test(eventType);
}

// Epoch identity survives remounts without unbounded per-session counters.
const epochs = new Map<string, number>();
let epochSerial = 0;
export function getSessionEpoch(sid: string): number { return epochs.get(sid) ?? 0; }
export function bumpSessionEpoch(sid: string): number {
  const value = ++epochSerial;
  epochs.delete(sid); epochs.set(sid, value);
  if (epochs.size > 256) epochs.delete(epochs.keys().next().value!);
  return value;
}
export function isEpochFresh(sid: string, value: number): boolean { return getSessionEpoch(sid) === value; }
export function resetSyncClientStateForTests(): void { epochs.clear(); epochSerial = 0; }

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every(k => Object.hasOwn(y, k) && equal(x[k], y[k]));
}
export function isAgentMessageEqual(a: AgentMessage, b: AgentMessage): boolean { return equal(a, b); }
export function reuseMessageObjects(next: AgentMessage[], prev: AgentMessage[], nextIds?: string[], prevIds?: string[]): AgentMessage[] {
  const indexed = prevIds ? new Map(prevIds.map((id, i) => [id, prev[i]])) : null;
  return next.map((message, i) => {
    const old = indexed && nextIds ? indexed.get(nextIds[i]) : prev[i];
    return old && equal(old, message) ? old : message;
  });
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function ids(value: unknown): value is string[] { return Array.isArray(value) && value.every(id => typeof id === "string" && id.length > 0) && new Set(value).size === value.length; }
function messages(value: unknown): value is AgentMessage[] { return Array.isArray(value) && value.every(msg => object(msg) && typeof msg.role === "string"); }
function snapshot(value: unknown, sid: string): value is SessionData {
  return object(value) && value.sessionId === sid && object(value.context) && messages(value.context.messages)
    && ids(value.context.entryIds) && value.context.entryIds.length === value.context.messages.length;
}
function revision(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256; }

export type ReconcileSyncResult =
  | { action: "unchanged"; revision: string; preserveCurrentMessages: true }
  | { action: "delta" | "reset" | "legacy"; data: SessionData; revision: string | null; newWireBaseline: SessionWireBaseline | null }
  | { action: "invalid_delta"; reason: string }
  | { action: "not_found" | "unauthorized" }
  | { action: "error"; status: number; message: string };

export function reconcileSyncResponse(params: {
  sessionId: string; status: number; payload: unknown; wireBaseline: SessionWireBaseline | null;
  currentMessages?: AgentMessage[]; currentEntryIds?: string[];
}): ReconcileSyncResult {
  const { sessionId: sid, status, payload, wireBaseline: base } = params;
  const invalid = (reason: string): ReconcileSyncResult => ({ action: "invalid_delta", reason });
  const error = (message: string): ReconcileSyncResult => ({ action: "error", status, message });
  if (status === 404) return { action: "not_found" };
  if (status === 401 || status === 403) return { action: "unauthorized" };
  if (status < 200 || status >= 300) return error(`HTTP ${status}`);
  if (!object(payload)) return error("Malformed session response");
  const validBase = base?.sessionId === sid && revision(base.revision) && ids(base.entryIds) && base.entryIds.length === base.messages.length;
  if (payload.protocol !== undefined && payload.protocol !== SESSION_SYNC_PROTOCOL) return error("Unsupported session sync protocol");
  const protocol = payload.protocol === SESSION_SYNC_PROTOCOL;
  if (protocol && payload.mode === "unchanged") {
    return validBase && base.revision === payload.revision
      ? { action: "unchanged", revision: base.revision, preserveCurrentMessages: true }
      : invalid("Unchanged response does not match an exact local baseline");
  }
  let action: "delta" | "reset" | "legacy" = "legacy";
  let data: unknown = payload;
  let rev: unknown = payload.snapshotRevision ?? null;
  if (protocol && payload.mode === "delta") {
    if (!validBase || base.revision !== payload.baseRevision || !revision(payload.revision)) return invalid("Delta base/revision mismatch");
    const drop = payload.dropCount, keep = payload.keepCount;
    if (typeof drop !== "number" || typeof keep !== "number" || !Number.isSafeInteger(drop) || !Number.isSafeInteger(keep)
      || drop < 0 || keep < 0 || drop + keep > base.messages.length || !messages(payload.tailMessages)) return invalid("Invalid delta bounds/messages");
    if (!object(payload.data) || payload.data.sessionId !== sid || !object(payload.data.context) || !ids(payload.data.context.entryIds)) return invalid("Invalid delta identity/context");
    const targetIds = payload.data.context.entryIds;
    if (targetIds.length !== keep + payload.tailMessages.length || base.entryIds.slice(drop, drop + keep).some((id, i) => id !== targetIds[i])) return invalid("Delta entry IDs do not align");
    data = { ...payload.data, context: { ...payload.data.context, messages: base.messages.slice(drop, drop + keep).concat(payload.tailMessages) } };
    rev = payload.revision; action = "delta";
  } else if (protocol && payload.mode === "reset") {
    data = payload.data; rev = payload.revision; action = "reset";
  } else if (protocol) return error("Unsupported session sync mode");
  if (!snapshot(data, sid) || (rev !== null && !revision(rev))) return error("Malformed session snapshot/revision");
  const nextMessages = reuseMessageObjects(data.context.messages, params.currentMessages ?? base?.messages ?? [], data.context.entryIds, params.currentEntryIds ?? base?.entryIds);
  const result: SessionData = { ...data, snapshotRevision: rev, context: { ...data.context, messages: nextMessages } };
  return {
    action, data: result, revision: rev,
    newWireBaseline: rev ? { sessionId: sid, revision: rev, messages: nextMessages, entryIds: result.context.entryIds, data: result, savedAt: Date.now() } : null,
  };
}

/** Keep already loaded ancestors when a confirmed tail window advances.
 * The wire baseline stays narrow and exact; only the display view is widened.
 * A changed branch or unknown gap fails closed. Same-epoch linear row IDs
 * may replace a changing overlap; branch histories also require equal bodies.
 */
export function preserveLoadedHistoryPrefix(
  next: SessionData,
  base: Pick<SessionWireBaseline, "sessionId" | "messages" | "entryIds"> | null,
  current: { messages: AgentMessage[]; entryIds: string[]; oldestEntryId: string | null; hasMore: boolean },
  stableRowIdentity = false,
): SessionData {
  if (!base || base.sessionId !== next.sessionId || current.messages.length < current.entryIds.length
    || !viewMatchesBaseline(base, current.messages.slice(0, current.entryIds.length), current.entryIds)) return next;
  const nextIds = next.context.entryIds;
  const offset = nextIds.length ? current.entryIds.indexOf(nextIds[0]) : -1;
  if (offset <= 0) return next;
  const overlap = Math.min(current.entryIds.length - offset, nextIds.length);
  if (!overlap || !nextIds.slice(0, overlap).every((id, i) => id === current.entryIds[offset + i]
    && (stableRowIdentity || isAgentMessageEqual(next.context.messages[i], current.messages[offset + i])))) return next;
  return { ...next, context: { ...next.context,
    messages: current.messages.slice(0, offset).concat(next.context.messages),
    entryIds: current.entryIds.slice(0, offset).concat(nextIds),
    oldestEntryId: current.oldestEntryId,
    hasMore: current.hasMore,
  } };
}

/** A wider view is reusable only if its suffix exactly covers this confirmed wire window. */
export function viewMatchesBaseline<T extends Pick<SessionWireBaseline, "messages" | "entryIds">>(base: T, viewMessages: AgentMessage[], viewIds: string[]): boolean {
  if (viewMessages.length !== viewIds.length || viewIds.length < base.entryIds.length) return false;
  const offset = viewIds.length - base.entryIds.length;
  return base.entryIds.every((id, i) => id === viewIds[offset + i] && equal(base.messages[i], viewMessages[offset + i]));
}
