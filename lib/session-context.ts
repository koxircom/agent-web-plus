import type { AgentMessage, ImageContent, SessionEntry, SessionContext } from "./types";
import { deferLargeToolResult } from "./session-tool-result";
import { normalizeToolCalls } from "./normalize";
import { getThinkingPreview } from "./message-display";
import { MAX_TOOL_RESULT_IMAGE_BYTES, TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images";

export interface BuildSessionContextOptions {
  deferThinking?: boolean;
  deferToolResults?: boolean;
  deferToolResultImages?: boolean;
  tail?: number;
  excludeLeaf?: boolean;
  before?: string | null;
  /** Session id used to build lazy URLs for historical tool-result images. */
  sessionId?: string;
}

export interface BranchNodeMetadata {
  id: string;
  parentId: string | null;
  countsTowardTail: boolean;
  thinkingLevel?: string;
  modelChange?: { provider: string; modelId: string };
  assistantModel?: { provider: string; modelId: string };
}

export interface BranchSettingsResult {
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

/**
 * Common ancestor traversal for both SessionEntry and EntryMeta.
 * Caps at tail visible messages, protects against cycles and raw-window inflation.
 */
export function traverseAncestorChain<T extends BranchNodeMetadata>(
  startNode: T | undefined,
  getParent: (node: T) => T | undefined,
  tail: number,
  excludeStart = false,
  rawCap?: number,
): T[] {
  if (!startNode) return [];
  let current: T | undefined = startNode;
  if (excludeStart) {
    current = current.parentId ? getParent(current) : undefined;
  }
  if (!current) return [];

  const chain: T[] = [];
  let visible = 0;
  const maxRaw = rawCap ?? (tail > 0 ? rawWindowCap(tail) : Infinity);
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) break; // cycle protection
    visited.add(current.id);
    chain.push(current);
    if (current.countsTowardTail) visible++;
    if ((tail > 0 && visible >= tail) || chain.length >= maxRaw) break;
    current = current.parentId ? getParent(current) : undefined;
  }
  chain.reverse();
  return chain;
}

/**
 * Common settings resolver from ancestor chain.
 * Traverses upward from startNode:
 * - captures latest thinkingLevel
 * - captures latest explicit modelChange and assistantModel
 * - preserves getLatestModelChange priority semantics over assistantModel.
 */
export function resolveBranchSettingsFromChain<T extends BranchNodeMetadata>(
  startNode: T | undefined,
  getParent: (node: T) => T | undefined,
): BranchSettingsResult {
  if (!startNode) {
    return { thinkingLevel: "off", model: null };
  }

  let thinkingLevel: string | undefined;
  let latestExplicitModel: { provider: string; modelId: string } | undefined;
  let latestAssistantModel: { provider: string; modelId: string } | undefined;

  let current: T | undefined = startNode;
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id)) break;
    visited.add(current.id);

    if (thinkingLevel === undefined && current.thinkingLevel !== undefined) {
      thinkingLevel = current.thinkingLevel;
    }
    if (latestExplicitModel === undefined && current.modelChange) {
      latestExplicitModel = current.modelChange;
    }
    if (latestAssistantModel === undefined && current.assistantModel) {
      latestAssistantModel = current.assistantModel;
    }

    if (thinkingLevel !== undefined && (latestExplicitModel !== undefined || latestAssistantModel !== undefined)) {
      if (latestExplicitModel !== undefined) break;
    }

    current = current.parentId ? getParent(current) : undefined;
  }

  return {
    thinkingLevel: thinkingLevel ?? "off",
    model: latestExplicitModel ?? latestAssistantModel ?? null,
  };
}

export function sessionEntryToMetadata(entry: SessionEntry): BranchNodeMetadata {
  let modelChange: { provider: string; modelId: string } | undefined;
  let thinkingLevel: string | undefined;
  let assistantModel: { provider: string; modelId: string } | undefined;

  if (entry.type === "model_change") {
    modelChange = { provider: entry.provider, modelId: entry.modelId };
  } else if (entry.type === "thinking_level_change") {
    thinkingLevel = entry.thinkingLevel;
  } else if (entry.type === "message" && entry.message?.role === "assistant") {
    const msg = entry.message as { provider?: unknown; model?: unknown };
    if (typeof msg.provider === "string" && typeof msg.model === "string") {
      assistantModel = { provider: msg.provider, modelId: msg.model };
    }
  }

  return {
    id: entry.id,
    parentId: entry.parentId,
    countsTowardTail: countsTowardTail(entry),
    thinkingLevel,
    modelChange,
    assistantModel,
  };
}

/**
 * Entry that renders as a standalone visible message in the chat window:
 * user / assistant messages plus the compaction divider. toolResult entries,
 * hidden custom messages and session meta render as attachments or nothing,
 * so they must not consume the `tail` budget — counting raw entries starves
 * user messages out of the window in agent-heavy sessions (a 50-entry window
 * over a tool-heavy session can hold a single user message).
 */
export function countsTowardTail(entry: SessionEntry): boolean {
  if (entry.type === "compaction") return true;
  if (entry.type !== "message") return false;
  const role = (entry as { message?: { role?: string } }).message?.role;
  return role === "user" || role === "assistant";
}

/**
 * Raw-entry ceiling for one page, so a span of tool traffic with few visible
 * anchors cannot balloon the payload. Scaled with `tail`; older history still
 * pages in via `before`.
 */
export const MIN_RAW_WINDOW_ENTRIES = 200;
export const rawWindowCap = (tail: number) => Math.max(MIN_RAW_WINDOW_ENTRIES, tail * 6);

/**
 * Extract the ancestor chain from `leafId` back toward the root, capped at
 * `tail` visible entries (most-recent first after the final reverse).
 * Iterative: a linear session's chain length equals its entry count, so a
 * recursive walk would overflow the stack. The result is still a valid prefix
 * of the active branch — older history is loaded on demand via pagination.
 */
export function sliceActiveBranch(
  entries: SessionEntry[],
  leafId: string | null,
  tail: number,
  excludeLeaf = false,
  byIdMap?: Map<string, SessionEntry>,
): SessionEntry[] {
  if (tail <= 0) return entries;
  const byId = byIdMap ?? new Map<string, SessionEntry>(entries.map((e) => [e.id, e]));
  const leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  if (!leaf) return [];

  // Wrap SessionEntry into BranchNodeMetadata for shared traversal
  type EntryWithMeta = SessionEntry & BranchNodeMetadata;
  const metaCache = new Map<string, EntryWithMeta>();
  const getEntryMeta = (entry: SessionEntry): EntryWithMeta => {
    let cached = metaCache.get(entry.id);
    if (!cached) {
      const meta = sessionEntryToMetadata(entry);
      cached = { ...entry, ...meta } as EntryWithMeta;
      metaCache.set(entry.id, cached);
    }
    return cached;
  };

  const startMeta = getEntryMeta(leaf);
  return traverseAncestorChain(
    startMeta,
    (node) => {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      return parent ? getEntryMeta(parent) : undefined;
    },
    tail,
    excludeLeaf,
    rawWindowCap(tail),
  ).map((node) => byId.get(node.id)!);
}

export function getLatestModelChange(entries: SessionEntry[]): SessionContext["model"] {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "model_change") {
      return { provider: entry.provider, modelId: entry.modelId };
    }
  }
  return null;
}

export function getSessionSettings(
  entries: SessionEntry[],
  leafId?: string | null,
  byIdMap?: Map<string, SessionEntry>,
): Pick<SessionContext, "thinkingLevel" | "model"> {
  if (leafId === null) return { thinkingLevel: "off", model: null };
  const byId = byIdMap ?? new Map<string, SessionEntry>(entries.map((e) => [e.id, e]));
  const leaf = leafId ? byId.get(leafId) : entries[entries.length - 1];
  if (!leaf) return { thinkingLevel: "off", model: null };

  const metaCache = new Map<string, BranchNodeMetadata>();
  const getMeta = (entry: SessionEntry): BranchNodeMetadata => {
    let cached = metaCache.get(entry.id);
    if (!cached) {
      cached = sessionEntryToMetadata(entry);
      metaCache.set(entry.id, cached);
    }
    return cached;
  };

  return resolveBranchSettingsFromChain(
    getMeta(leaf),
    (node) => {
      const parent = node.parentId ? byId.get(node.parentId) : undefined;
      return parent ? getMeta(parent) : undefined;
    },
  );
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: BuildSessionContextOptions = {},
): SessionContext {
  const { tail, excludeLeaf, before } = options;
  // before overrides leafId=null
  const effectiveCursor = (before !== undefined && before !== null)
    ? before
    : (leafId === null ? null : (leafId ?? undefined));

  // Single Map allocation for both sliceActiveBranch and getSessionSettings.
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  // History pages retain the original branch order, including compacted messages.
  const sliced = effectiveCursor === null ? [] : sliceActiveBranch(
    entries, effectiveCursor ?? null, tail && tail > 0 ? tail : entries.length, excludeLeaf, byId,
  );
  const hasMore = Boolean(tail && tail > 0 && sliced[0]?.parentId);

  // Pi records an auto-retried provider failure by omitting that failed
  // assistant entry from future model context. Keep it visible in history,
  // but annotate it as a superseded attempt instead of a terminal failure.
  const omittedTargets = new Set<string>();
  for (const entry of sliced) {
    if (entry.type !== "context_edit") continue;
    if (entry.replacement === null) omittedTargets.add(entry.targetId);
    else omittedTargets.delete(entry.targetId);
  }

  // Convert messages and their IDs together to keep fork/navigation targets aligned.
  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of sliced) {
    let m = entryToUiMessage(entry, options);
    if (
      m?.role === "assistant"
      && m.stopReason === "error"
      && omittedTargets.has(entry.id)
    ) {
      m = { ...m, retryAttempt: true };
    }
    if (m) {
      messages.push(m);
      entryIds.push(entry.id);
    }
  }

  // Settings are always resolved from effectiveCursor itself, regardless of whether excludeLeaf empties the page.
  const settings = getSessionSettings(entries, effectiveCursor, byId);

  return {
    messages,
    entryIds,
    oldestEntryId: sliced[0]?.id ?? null,
    hasMore,
    ...settings,
  };
}

export function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseAssistantTimestamp(timestamp: unknown): number | undefined {
  if (typeof timestamp === "number") {
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  if (typeof timestamp === "string") {
    const trimmed = timestamp.trim();
    if (!trimmed) return undefined;
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
    const asNum = Number(trimmed);
    if (Number.isFinite(asNum)) return asNum;
  }
  return undefined;
}

export function resolveAssistantCompletedAt(
  entryTimestamp: unknown,
  messageTimestamp: unknown,
): number | undefined {
  const completedAt = parseAssistantTimestamp(entryTimestamp);
  if (completedAt === undefined) return undefined;

  const startedAt = parseAssistantTimestamp(messageTimestamp);
  if (startedAt !== undefined && completedAt < startedAt) {
    return undefined;
  }

  return completedAt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

export function deferToolResultBase64Images(
  message: AgentMessage,
  sessionId: string | undefined,
  entryId: string,
): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.flatMap((block, blockIndex) => {
    const image = base64ImageInfo(block);
    if (!image) return [block];

    // Keep the initial history response small, but preserve an image block that
    // the browser can load only when its collapsed tool result is expanded.
    if (
      sessionId &&
      image.mime &&
      TOOL_RESULT_IMAGE_MIMES.has(image.mime) &&
      image.bytes > 0 &&
      image.bytes <= MAX_TOOL_RESULT_IMAGE_BYTES
    ) {
      const source: ImageContent["source"] = {
        type: "url",
        media_type: image.mime,
        url: `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/tool-result-image?blockIndex=${blockIndex}`,
      };
      return [{ type: "image", source } satisfies ImageContent];
    }

    // Retain the old bounded fallback for callers that do not have a session id.
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return [];
  });
  if (omitted === 0) return { ...message, content };

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
export function entryToUiMessage(
  entry: SessionEntry,
  options: BuildSessionContextOptions,
): AgentMessage | null {
  switch (entry.type) {
    case "message": {
      // Transcript system messages carry the prompt and tool loadout (Pi >= 0.86).
      // They are provider input, not conversation, so they never render.
      if (entry.message.role === "system") return null;
      let message = options.deferToolResultImages
        ? deferToolResultBase64Images(normalizeToolCalls(entry.message), options.sessionId, entry.id)
        : normalizeToolCalls(entry.message);
      if (options.deferToolResults && options.sessionId && message.role === "toolResult") {
        message = deferLargeToolResult(message, entry.id);
      }
      const legacyContent = message.role === "assistant" ? (message as { content: unknown }).content : undefined;
      if (typeof legacyContent === "string") {
        message = { ...message, content: [{ type: "text", text: legacyContent }] } as AgentMessage;
      }
      if (message.role === "assistant") {
        const completedAt = resolveAssistantCompletedAt(entry.timestamp, message.timestamp);
        if (completedAt !== undefined) {
          message = { ...message, completedAt } as AgentMessage;
        }
      }
      if (!options.deferThinking || message.role !== "assistant") return message;
      const content = message.content;
      return {
        ...message,
        content: content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: getThinkingPreview(block.thinking), deferred: true }
            : block
        )),
      } as AgentMessage;
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}
