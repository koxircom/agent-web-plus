import type { AgentMessage, AgentUsage, SessionEntry, SessionMessage } from "./types";

export interface SessionFileStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

function emptyStats(): SessionFileStats {
  return {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function addUsage(stats: SessionFileStats, usage?: AgentUsage): void {
  if (!usage) return;
  stats.tokens.input += usage.input ?? 0;
  stats.tokens.output += usage.output ?? 0;
  stats.tokens.cacheRead += usage.cacheRead ?? 0;
  stats.tokens.cacheWrite += usage.cacheWrite ?? 0;
  stats.cost += usage.cost?.total ?? 0;
}

export function addMessage(
  stats: SessionFileStats,
  message: SessionMessage,
  options?: { countUsage?: boolean },
): void {
  const countUsage = options?.countUsage ?? true;
  // Like the SDK, every message entry counts toward the total, including the
  // transcript system messages that hold the prompt and tool loadout.
  stats.totalMessages += 1;
  if (message.role === "user") {
    stats.userMessages += 1;
  } else if (message.role === "toolResult") {
    stats.toolResults += 1;
    if (countUsage) addUsage(stats, message.usage);
  } else if (message.role === "assistant") {
    stats.assistantMessages += 1;
    if (Array.isArray(message.content)) {
      stats.toolCalls += message.content.filter((c) => c.type === "toolCall").length;
    }
    if (countUsage) addUsage(stats, message.usage);
  }
}

function finishStats(stats: SessionFileStats): SessionFileStats {
  stats.tokens.total = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  return stats;
}

function computeMessageStats(messages: AgentMessage[]): SessionFileStats {
  const stats = emptyStats();
  for (const message of messages) {
    if (message.role !== "custom") addMessage(stats, message);
  }
  return finishStats(stats);
}

export function mergeSessionStats(
  fileStats: SessionFileStats | undefined,
  loadedMessages: AgentMessage[],
  currentMessages: AgentMessage[],
): SessionFileStats {
  const current = computeMessageStats(currentMessages);
  if (!fileStats) return current;

  const loaded = computeMessageStats(loadedMessages);
  const delta = (now: number, before: number) => Math.max(0, now - before);
  const tokens = {
    input: fileStats.tokens.input + delta(current.tokens.input, loaded.tokens.input),
    output: fileStats.tokens.output + delta(current.tokens.output, loaded.tokens.output),
    cacheRead: fileStats.tokens.cacheRead + delta(current.tokens.cacheRead, loaded.tokens.cacheRead),
    cacheWrite: fileStats.tokens.cacheWrite + delta(current.tokens.cacheWrite, loaded.tokens.cacheWrite),
    total: 0,
  };
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  return {
    userMessages: fileStats.userMessages + delta(current.userMessages, loaded.userMessages),
    assistantMessages: fileStats.assistantMessages + delta(current.assistantMessages, loaded.assistantMessages),
    toolCalls: fileStats.toolCalls + delta(current.toolCalls, loaded.toolCalls),
    toolResults: fileStats.toolResults + delta(current.toolResults, loaded.toolResults),
    totalMessages: fileStats.totalMessages + delta(current.totalMessages, loaded.totalMessages),
    tokens,
    cost: fileStats.cost + delta(current.cost, loaded.cost),
  };
}

export const FORK_PROVENANCE_TYPE = "pi-web:fork-provenance";

export interface ForkEntryOrigin {
  sessionId: string;
  sessionFile?: string;
}

export interface ForkProvenanceData {
  version: number;
  parentSessionId: string;
  parentSessionPath?: string;
  forkPointEntryId?: string;
  inheritedEntryIds: string[];
  /**
   * 稳定事件原始来源映射：entryId -> { sessionId, sessionFile? }
   * 确保嵌套 fork (A -> B -> C) 中，A 的 entry 在 C 中依旧指向 A，而非当前 parent B。
   */
  entryOrigins?: Record<string, ForkEntryOrigin>;
}

export function extractForkProvenance(entries: readonly SessionEntry[]): {
  inheritedEntryIds: Set<string>;
  entryOrigins: Map<string, ForkEntryOrigin>;
  parentSessionId?: string;
} {
  const inheritedEntryIds = new Set<string>();
  const entryOrigins = new Map<string, ForkEntryOrigin>();
  let parentSessionId: string | undefined;

  for (const entry of entries) {
    if (entry.type === "custom" && (entry as { customType?: string }).customType === FORK_PROVENANCE_TYPE) {
      const data = (entry as { data?: unknown }).data as ForkProvenanceData | undefined;
      if (data) {
        if (data.parentSessionId && !parentSessionId) {
          parentSessionId = data.parentSessionId;
        }
        if (Array.isArray(data.inheritedEntryIds)) {
          for (const id of data.inheritedEntryIds) {
            if (typeof id === "string" && id) inheritedEntryIds.add(id);
          }
        }
        if (data.entryOrigins && typeof data.entryOrigins === "object") {
          for (const [id, orig] of Object.entries(data.entryOrigins)) {
            if (orig && typeof orig.sessionId === "string") {
              entryOrigins.set(id, orig);
            }
          }
        }
      }
    }
  }
  return { inheritedEntryIds, entryOrigins, parentSessionId };
}

export function extractForkInheritedEntryIds(entries: readonly SessionEntry[]): Set<string> {
  return extractForkProvenance(entries).inheritedEntryIds;
}

export interface ForkProvenanceSourceEntry {
  type: string;
  id?: string;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function prepareForkProvenance(
  sourceEntries: readonly (ForkProvenanceSourceEntry | SessionEntry | unknown)[],
  parentSessionId: string,
  parentSessionFile: string | undefined,
  forkPointEntryId: string,
  inheritedEntryIds: string[],
): ForkProvenanceData {
  let existingOrigins: Record<string, ForkEntryOrigin> = {};
  for (const rawEntry of sourceEntries) {
    const entry = rawEntry as ForkProvenanceSourceEntry;
    if (entry && entry.type === "custom" && entry.customType === FORK_PROVENANCE_TYPE) {
      const data = entry.data as ForkProvenanceData | undefined;
      if (data?.entryOrigins && typeof data.entryOrigins === "object") {
        existingOrigins = { ...existingOrigins, ...data.entryOrigins };
      }
    }
  }

  const sessionFileBase = parentSessionFile ? parentSessionFile.split(/[/\\]/).pop() : undefined;
  const entryOrigins: Record<string, ForkEntryOrigin> = {};

  for (const id of inheritedEntryIds) {
    if (existingOrigins[id]) {
      // 嵌套 fork：继承最初祖先来源
      entryOrigins[id] = existingOrigins[id];
    } else {
      // 当前父会话首次产生的 entry
      entryOrigins[id] = {
        sessionId: parentSessionId,
        sessionFile: sessionFileBase,
      };
    }
  }

  return {
    version: 1,
    parentSessionId,
    parentSessionPath: parentSessionFile,
    forkPointEntryId,
    inheritedEntryIds,
    entryOrigins,
  };
}

/**
 * Aggregate usage across ALL entries in a session file.
 *
 * Mirrors the SDK's `AgentSession.getSessionStats()`: besides assistant
 * (and tool-result) messages, this also counts usage recorded on compaction,
 * branch-summary and `usage` entries (prompt-cache warming, which is billed
 * but never enters model context). Compaction only appends a summary entry — the
 * summarized history stays in the file — so these totals grow monotonically
 * for the life of the session. Totals computed over the active context alone
 * (the compaction-aware message list) shrink whenever old history is
 * summarized away, which is what made the UI token/cost counters appear to be
 * reset after compaction.
 */
export function computeSessionStats(entries: SessionEntry[]): SessionFileStats {
  const stats = emptyStats();
  const { inheritedEntryIds } = extractForkProvenance(entries);

  for (const entry of entries) {
    const isInherited = Boolean(entry.id && inheritedEntryIds.has(entry.id));
    if (entry.type === "compaction" || entry.type === "branch_summary" || entry.type === "usage") {
      if (!isInherited) {
        addUsage(stats, entry.usage);
      }
      continue;
    }
    if (entry.type !== "message") continue;
    addMessage(stats, entry.message, { countUsage: !isInherited });
  }

  return finishStats(stats);
}
