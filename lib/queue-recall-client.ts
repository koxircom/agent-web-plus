import { acknowledgeRecalledPrompts, sendAgentCommand } from "./agent-client";
import { getDraft } from "./draft-store";
import { getPendingPromptSubmissions } from "./prompt-submissions";
import { MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits } from "./image-attachments";
import type {
  QueueActionsSnapshot,
  QueuedImageAttachment,
  QueuedMessageInfo,
  RecallAllQueuedMessagesResult,
} from "./queue-actions";

export interface RecalledAttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

export interface RecalledPromptRestoration {
  sessionId: string;
  targetDraftKey?: string;
  entries: Array<{ requestId?: string; text: string; images?: QueuedImageAttachment[] }>;
}

// One tab-local owner survives component/session remounts; a page reload starts
// fresh and recovers from durable drafts/receipts. Never persist a memory claim.
const restoredRecalls = new Set<string>();

/** Claim synchronously, merge only unclaimed entries, and acknowledge only
 * after draft persistence succeeds. A lost ACK remains retryable. */
export async function restoreRecalledPrompts(
  payload: RecalledPromptRestoration,
  restore: (text: string, images: RecalledAttachedImage[] | undefined, key: string) => void,
): Promise<boolean> {
  const key = payload.targetDraftKey ?? payload.sessionId;
  const claimed: string[] = [];
  for (const entry of payload.entries) {
    if (typeof entry.text !== "string" || (entry.requestId !== undefined && typeof entry.requestId !== "string")
      || !Array.isArray(entry.images ?? []) || (entry.images ?? []).some(image => !isBase64ImageWithinLimits(image))) {
      throw new Error("Invalid recalled prompt contents");
    }
  }
  const entries = payload.entries.filter(entry => {
    if (!entry.requestId) return true; // Legacy/native external messages have no browser outbox.
    const identity = JSON.stringify([payload.sessionId, entry.requestId]);
    const row = getPendingPromptSubmissions().find(row => row.sessionId === payload.sessionId && row.requestId === entry.requestId);
    if (restoredRecalls.has(identity) || row?.recallRestored) return false;
    restoredRecalls.add(identity);
    claimed.push(identity);
    return true;
  });
  try {
    if (entries.length) {
      const text = entries.map(entry => entry.text).filter(text => text.trim()).join("\n\n");
      const images = entries.flatMap(entry => (entry.images ?? []).map(toRecalledAttachedImage));
      if (images.length + (getDraft(key)?.images.length ?? 0) > MAX_ATTACHED_IMAGES) throw new Error("召回图片超过上限，原消息仍已保留");
      if (text.trim() || images.length) restore(text, images.length ? images : undefined, key);
    }
  } catch (error) {
    for (const identity of claimed) restoredRecalls.delete(identity);
    throw error;
  }
  // Do not mark recallRestored here: it is durable only if draft persistence
  // succeeds. In-memory ownership still prevents repeated restore when disabled.
  const requestIds = [...new Set(payload.entries.flatMap(entry => entry.requestId ? [entry.requestId] : []))];
  await acknowledgeRecalledPrompts(payload.sessionId, requestIds, key);
  if (restoredRecalls.size > 512) {
    const pending = new Set(getPendingPromptSubmissions().map(row => JSON.stringify([row.sessionId, row.requestId])));
    for (const identity of restoredRecalls) {
      if (restoredRecalls.size <= 512) break;
      if (!pending.has(identity)) restoredRecalls.delete(identity);
    }
  }
  return entries.length > 0;
}

export interface RecallSessionQueueOptions {
  sessionId: string | null | undefined;
  targetDraftKey?: string;
  sendCommand?: <T = unknown>(sessionId: string, command: Record<string, unknown>) => Promise<T>;
  restoreSubmission: (
    text: string,
    images: RecalledAttachedImage[] | undefined,
    targetDraftKey: string | undefined,
  ) => void;
  isSameSession?: (originSessionId: string) => boolean;
  clearQueuedMessagesUi?: () => void;
  onError?: (message: string, error: unknown) => void;
  getExistingDraftImageCount?: (targetDraftKey: string | undefined) => number;
  restoreRecall?: (payload: RecalledPromptRestoration) => Promise<boolean>;
}

export interface RecallSessionQueueOutcome {
  recalled: boolean;
  reason?: "no-session" | "empty" | "error";
  text: string;
  images: RecalledAttachedImage[];
  targetDraftKey?: string;
  tokens?: string[];
  error?: unknown;
}

export function toRecalledAttachedImage(image: QueuedImageAttachment): RecalledAttachedImage {
  return {
    data: image.data,
    mimeType: image.mimeType,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function validateSnapshotList(items: unknown, label: string): Array<{ token: string; imageCount: number }> {
  if (!Array.isArray(items)) {
    throw new Error(`Invalid queue snapshot: ${label} must be an array`);
  }
  return items.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Invalid queue snapshot: ${label}[${idx}] must be an object`);
    }
    const candidate = item as { token?: unknown; text?: unknown; imageCount?: unknown };
    if (typeof candidate.token !== "string" || !candidate.token.trim()) {
      throw new Error(`Invalid queue snapshot: ${label}[${idx}].token must be a non-empty string`);
    }
    if (typeof candidate.text !== "string") {
      throw new Error(`Invalid queue snapshot: ${label}[${idx}].text must be a string`);
    }
    if (
      typeof candidate.imageCount !== "number"
      || !Number.isInteger(candidate.imageCount)
      || candidate.imageCount < 0
    ) {
      throw new Error(`Invalid queue snapshot: ${label}[${idx}].imageCount must be a non-negative integer`);
    }
    return {
      token: candidate.token,
      imageCount: candidate.imageCount,
    };
  });
}

/**
 * Validate a v2 `get_queue_actions` response and extract the ordered steering + followUp token list.
 * Fails closed on legacy or malformed payloads without treating string-only queues as image-compatible.
 */
export function extractSnapshotTokens(snapshotResult: unknown): {
  tokens: string[];
  totalImages: number;
} {
  if (!snapshotResult || typeof snapshotResult !== "object") {
    throw new Error("Queue recall requires atomic queue actions v2 snapshot");
  }
  const candidate = snapshotResult as Partial<QueueActionsSnapshot>;
  if (candidate.version !== 2) {
    throw new Error("Queue recall requires atomic queue actions v2 snapshot");
  }
  const steering = validateSnapshotList(candidate.steering, "steering");
  const followUp = validateSnapshotList(candidate.followUp, "followUp");
  const ordered = [...steering, ...followUp];
  return {
    tokens: ordered.map((item) => item.token),
    totalImages: ordered.reduce((sum, item) => sum + item.imageCount, 0),
  };
}

/**
 * Validate a v2 `recall_all_queued_messages` response against the expected token order.
 */
export function validateRecallAllResponse(
  result: unknown,
  expectedTokens: readonly string[],
): QueuedMessageInfo[] {
  if (!result || typeof result !== "object") {
    throw new Error("Invalid recall_all_queued_messages response");
  }
  const candidate = result as Partial<RecallAllQueuedMessagesResult>;
  if (candidate.version !== 2 || !Array.isArray(candidate.entries)) {
    throw new Error("Invalid recall_all_queued_messages v2 payload");
  }
  if (candidate.entries.length !== expectedTokens.length) {
    throw new Error("Recalled entry count mismatch");
  }

  return candidate.entries.map((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Invalid recalled entry at index ${idx}`);
    }
    const typedEntry = entry as Partial<QueuedMessageInfo>;
    if (typeof typedEntry.token !== "string" || typedEntry.token !== expectedTokens[idx]) {
      throw new Error(`Recalled entry token mismatch at index ${idx}`);
    }
    if (typeof typedEntry.text !== "string") {
      throw new Error(`Invalid recalled entry text at index ${idx}`);
    }
    if (typedEntry.kind !== "steering" && typedEntry.kind !== "followUp") {
      throw new Error(`Invalid recalled entry kind at index ${idx}`);
    }
    if (!Array.isArray(typedEntry.images)) {
      throw new Error(`Invalid recalled entry images at index ${idx}`);
    }
    const images: QueuedImageAttachment[] = typedEntry.images.map((img, imgIdx) => {
      if (!isBase64ImageWithinLimits(img)) {
        throw new Error(`Invalid recalled image attachment at entry ${idx}, image ${imgIdx}`);
      }
      return {
        data: img.data,
        mimeType: img.mimeType,
      };
    });
    return {
      ...(typeof typedEntry.requestId === "string" ? { requestId: typedEntry.requestId } : {}),
      text: typedEntry.text,
      kind: typedEntry.kind,
      token: typedEntry.token,
      images,
    };
  });
}

/**
 * Merge recalled queue entries in order into a single composer submission payload.
 */
export function mergeRecalledQueueEntries(entries: readonly QueuedMessageInfo[]): {
  text: string;
  images: RecalledAttachedImage[];
} {
  const text = entries
    .map((entry) => entry.text)
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
  const images = entries.flatMap((entry) => entry.images.map(toRecalledAttachedImage));
  return { text, images };
}

/**
 * Recall all queued messages for a session atomically via v2 queue RPCs (`get_queue_actions` -> `recall_all_queued_messages`).
 * Never falls back to `clear_queue`, preserves images and existing draft content, and isolates cross-session switches.
 */
export async function recallSessionQueue(
  options: RecallSessionQueueOptions,
): Promise<RecallSessionQueueOutcome> {
  const originSessionId = typeof options.sessionId === "string" ? options.sessionId.trim() : "";
  if (!originSessionId) {
    return { recalled: false, reason: "no-session", text: "", images: [] };
  }

  const originDraftKey = options.targetDraftKey ?? originSessionId;
  const sendCommand = options.sendCommand ?? sendAgentCommand;
  const isSameSession = options.isSameSession ?? (() => true);

  try {
    const rawSnapshot = await sendCommand<QueueActionsSnapshot>(originSessionId, {
      type: "get_queue_actions",
    });
    const { tokens, totalImages } = extractSnapshotTokens(rawSnapshot);
    if (tokens.length === 0) {
      if (isSameSession(originSessionId)) {
        options.clearQueuedMessagesUi?.();
      }
      return {
        recalled: false,
        reason: "empty",
        text: "",
        images: [],
        targetDraftKey: originDraftKey,
        tokens: [],
      };
    }

    const existingDraftImages = options.getExistingDraftImageCount
      ? options.getExistingDraftImageCount(originDraftKey)
      : (originDraftKey ? (getDraft(originDraftKey)?.images.length ?? 0) : 0);
    if (totalImages + existingDraftImages > MAX_ATTACHED_IMAGES) {
      throw new Error(
        `Cannot recall queued messages: total attached images (${totalImages + existingDraftImages}) would exceed the maximum of ${MAX_ATTACHED_IMAGES}`,
      );
    }

    const rawRecall = await sendCommand<RecallAllQueuedMessagesResult>(originSessionId, {
      type: "recall_all_queued_messages",
      tokens,
    });
    const entries = validateRecallAllResponse(rawRecall, tokens);
    const { text, images } = mergeRecalledQueueEntries(entries);

    if (options.restoreRecall) {
      await options.restoreRecall({ sessionId: originSessionId, targetDraftKey: originDraftKey, entries });
    } else {
      if (text.trim().length > 0 || images.length > 0) options.restoreSubmission(text, images.length ? images : undefined, originDraftKey);
      const recalledIds = (rawRecall as RecallAllQueuedMessagesResult & { recalledPromptRequestIds?: string[] }).recalledPromptRequestIds;
      if (recalledIds?.length) await acknowledgeRecalledPrompts(originSessionId, recalledIds, originDraftKey);
    }

    if (isSameSession(originSessionId)) {
      options.clearQueuedMessagesUi?.();
    }

    return {
      recalled: true,
      text,
      images,
      targetDraftKey: originDraftKey,
      tokens,
    };
  } catch (error) {
    options.onError?.("Failed to recall queued messages", error);
    return {
      recalled: false,
      reason: "error",
      text: "",
      images: [],
      targetDraftKey: originDraftKey,
      error,
    };
  }
}
