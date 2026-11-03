/**
 * Native in-memory queue client & LRU attachment cache for Agent Web Plus.
 * Micro-contract:
 * - Session/signature-scoped state.
 * - Single-flight LRU (max 30 items, 24MiB) keyed by `${sessionId}:${token}`. Never claim by text.
 * - get_queue_actions v2 token/text/kind verification.
 * - delete/promote/reorder/recall RPCs via sendAgentCommand.
 * - Atomic recall / recallAll without silent fallback or recovery download patches.
 */

import { sendAgentCommand } from "./agent-client";
import { getDraft } from "./draft-store";
import { isBase64ImageWithinLimits, MAX_ATTACHED_IMAGES } from "./image-attachments";
import { validateRecallAllResponse, type RecalledPromptRestoration } from "./queue-recall-client";

export interface QueuedImage {
  data: string;
  mimeType: string;
  alt?: string;
}

export interface QueueActionSnapshotItem {
  token: string;
  text: string;
  imageCount: number;
  status?: string;
  error?: string;
}

export interface QueueActionsSnapshotV2 {
  version: 2;
  reorder?: boolean;
  steering: QueueActionSnapshotItem[];
  followUp: QueueActionSnapshotItem[];
}

export interface QueuedMessageDetail {
  text: string;
  kind: "steering" | "followUp";
  token: string;
  images: QueuedImage[];
  requestId?: string;
}

export interface QueueRowData {
  kind: "steer" | "follow-up";
  text: string;
}

export const MAX_QUEUE_DETAIL_CACHE_ITEMS = 30;
export const MAX_QUEUE_DETAIL_CACHE_BYTES = 24 * 1024 * 1024; // 24MiB

interface CacheEntry {
  detail: QueuedMessageDetail;
  size: number;
}

// Global LRU cache: `${sessionId}:${token}` -> CacheEntry
const detailCache = new Map<string, CacheEntry>();
let currentCacheBytes = 0;
let cacheGeneration = 0;
const sessionGenerations = new Map<string, number>();

function getSessionGeneration(sessionId: string): number {
  return sessionGenerations.get(sessionId) ?? 0;
}

// Single-flight requests: `${sessionId}:${token}` -> Promise
const inFlightRequests = new Map<string, Promise<QueuedMessageDetail | null>>();

export function estimateDetailBytes(detail: QueuedMessageDetail | null | undefined): number {
  if (!detail || typeof detail !== "object") return 0;
  let bytes = 128;
  if (typeof detail.text === "string") {
    bytes += detail.text.length * 2;
  }
  if (Array.isArray(detail.images)) {
    for (const img of detail.images) {
      if (img && typeof img.data === "string") {
        bytes += img.data.length * 2 + 64;
      }
    }
  }
  return bytes;
}

function evictLRU(): void {
  while (detailCache.size > MAX_QUEUE_DETAIL_CACHE_ITEMS || currentCacheBytes > MAX_QUEUE_DETAIL_CACHE_BYTES) {
    const oldestKey = detailCache.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = detailCache.get(oldestKey);
    detailCache.delete(oldestKey);
    if (entry && typeof entry.size === "number") {
      currentCacheBytes = Math.max(0, currentCacheBytes - entry.size);
    }
  }
}

export function getFromDetailCache(sessionId: string, token: string): QueuedMessageDetail | null {
  const cacheKey = `${sessionId}:${token}`;
  const entry = detailCache.get(cacheKey);
  if (!entry) return null;
  // Refresh LRU order
  detailCache.delete(cacheKey);
  detailCache.set(cacheKey, entry);
  return entry.detail;
}

export function putIntoDetailCache(sessionId: string, token: string, detail: QueuedMessageDetail): void {
  const cacheKey = `${sessionId}:${token}`;
  const size = estimateDetailBytes(detail);
  if (size > MAX_QUEUE_DETAIL_CACHE_BYTES) return;

  if (detailCache.has(cacheKey)) {
    const old = detailCache.get(cacheKey);
    currentCacheBytes = Math.max(0, currentCacheBytes - (old?.size || 0));
    detailCache.delete(cacheKey);
  }

  detailCache.set(cacheKey, { detail, size });
  currentCacheBytes += size;
  evictLRU();
}

export function clearQueueDetailCache(sessionId?: string): void {
  if (sessionId) {
    sessionGenerations.set(sessionId, getSessionGeneration(sessionId) + 1);
    for (const [key, entry] of detailCache.entries()) {
      if (key.startsWith(`${sessionId}:`)) {
        detailCache.delete(key);
        currentCacheBytes = Math.max(0, currentCacheBytes - (entry?.size || 0));
      }
    }
    for (const key of inFlightRequests.keys()) {
      if (key.startsWith(`${sessionId}:`)) {
        inFlightRequests.delete(key);
      }
    }
  } else {
    cacheGeneration++;
    sessionGenerations.clear();
    detailCache.clear();
    currentCacheBytes = 0;
    inFlightRequests.clear();
  }
}

export function getQueueDetailCacheStats(): { count: number; bytes: number; generation: number; inFlightCount: number } {
  return {
    count: detailCache.size,
    bytes: currentCacheBytes,
    generation: cacheGeneration,
    inFlightCount: inFlightRequests.size,
  };
}

function validateSnapshotItems(items: unknown, label: string): QueueActionSnapshotItem[] | null {
  if (!Array.isArray(items)) return null;
  const result: QueueActionSnapshotItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") return null;
    const raw = item as Record<string, unknown>;
    if (typeof raw.token !== "string" || !raw.token.trim()) return null;
    if (typeof raw.text !== "string") return null;
    if (typeof raw.imageCount !== "number" || !Number.isInteger(raw.imageCount) || raw.imageCount < 0) return null;
    result.push({
      token: raw.token,
      text: raw.text,
      imageCount: raw.imageCount,
      ...(typeof raw.status === "string" ? { status: raw.status } : {}),
      ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    });
  }
  return result;
}

/**
 * Fetch v2 queue snapshot from the native agent API.
 * Validates protocol version and schema strictly without swallowing broken structures.
 */
export async function fetchQueueActions(sessionId: string, signal?: AbortSignal): Promise<QueueActionsSnapshotV2 | null> {
  if (!sessionId || typeof sessionId !== "string") return null;
  try {
    const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "get_queue_actions" }),
      signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json || json.success === false || !json.data) return null;
    const data = json.data as Partial<QueueActionsSnapshotV2>;
    if (data.version !== 2) return null;
    const steering = validateSnapshotItems(data.steering, "steering");
    const followUp = validateSnapshotItems(data.followUp, "followUp");
    if (!steering || !followUp) return null;
    return {
      version: 2,
      reorder: data.reorder === true,
      steering,
      followUp,
    };
  } catch {
    return null;
  }
}

/**
 * Verify whether client-rendered entries match the server snapshot exactly.
 * Matches count, kinds and trimmed text in strict order.
 * Returns mapped QueueActionSnapshotItem list or null if desynchronized.
 */
export function matchQueueEntries(
  entries: readonly QueueRowData[],
  snapshot: QueueActionsSnapshotV2 | null | undefined,
): QueueActionSnapshotItem[] | null {
  if (!snapshot || snapshot.version !== 2) return null;
  const steering = snapshot.steering;
  const followUp = snapshot.followUp;
  if (steering.length + followUp.length !== entries.length) return null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isSteer = i < steering.length;
    const expectedKind = isSteer ? "steer" : "follow-up";
    const serverItem = isSteer ? steering[i] : followUp[i - steering.length];
    if (entry.kind !== expectedKind) return null;
    if ((entry.text || "").trim() !== (serverItem.text || "").trim()) return null;
    if (!serverItem.token || typeof serverItem.token !== "string") return null;
  }

  return [...steering, ...followUp];
}

/**
 * Fetch detail (with image attachments) for a single token.
 * Leverages LRU cache and single-flight dedup.
 * Fails closed on any invalid image without caching filtered subsets.
 */
export async function fetchQueuedMessageDetail(
  sessionId: string,
  token: string,
  signal?: AbortSignal,
): Promise<QueuedMessageDetail | null> {
  if (!sessionId || !token) return null;
  if (signal?.aborted) return null;

  const cached = getFromDetailCache(sessionId, token);
  if (cached) return cached;

  const cacheKey = `${sessionId}:${token}`;
  let inFlight = inFlightRequests.get(cacheKey);

  if (!inFlight) {
    const sessionGenAtStart = getSessionGeneration(sessionId);
    const globalGenAtStart = cacheGeneration;

    inFlight = (async (): Promise<QueuedMessageDetail | null> => {
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "get_queued_message", token }),
        });
        if (!res.ok) return null;
        const json = await res.json();
        if (!json || json.success === false || !json.data || typeof json.data !== "object") return null;
        const data = json.data as Record<string, unknown>;
        if (typeof data.token !== "string" || data.token !== token || !data.token.trim()) return null;
        if (typeof data.text !== "string") return null;
        if (data.kind !== "steering" && data.kind !== "followUp") return null;
        if (!Array.isArray(data.images) || data.images.length > MAX_ATTACHED_IMAGES) return null;

        const validImages: QueuedImage[] = [];
        for (let i = 0; i < data.images.length; i++) {
          const img = data.images[i];
          if (!img || typeof img !== "object") return null;
          const rawData = (img as Record<string, unknown>).data;
          const rawMime = (img as Record<string, unknown>).mimeType;
          if (typeof rawData !== "string" || !rawData || typeof rawMime !== "string" || !rawMime.startsWith("image/")) {
            return null;
          }
          const base64Img = { data: rawData, mimeType: rawMime };
          if (!isBase64ImageWithinLimits(base64Img)) {
            return null;
          }
          const rawAlt = (img as Record<string, unknown>).alt;
          validImages.push({
            data: rawData,
            mimeType: rawMime,
            alt: typeof rawAlt === "string" ? rawAlt : `图片附件 ${i + 1}`,
          });
        }

        const detail: QueuedMessageDetail = {
          token: data.token,
          text: data.text,
          kind: data.kind,
          images: validImages,
          ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
        };

        if (sessionGenAtStart === getSessionGeneration(sessionId) && globalGenAtStart === cacheGeneration) {
          putIntoDetailCache(sessionId, token, detail);
        }
        return detail;
      } catch {
        return null;
      } finally {
        if (inFlightRequests.get(cacheKey) === inFlight) {
          inFlightRequests.delete(cacheKey);
        }
      }
    })();

    inFlightRequests.set(cacheKey, inFlight);
  }

  if (!signal) {
    return await inFlight;
  }

  return await new Promise<QueuedMessageDetail | null>((resolve) => {
    let resolved = false;
    const onAbort = () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    inFlight!.then(
      (result) => {
        if (!resolved) {
          resolved = true;
          signal.removeEventListener("abort", onAbort);
          resolve(result);
        }
      },
      () => {
        if (!resolved) {
          resolved = true;
          signal.removeEventListener("abort", onAbort);
          resolve(null);
        }
      },
    );
  });
}

/**
 * Promote follow-up queue item to immediate steering.
 */
export async function promoteQueuedMessage(sessionId: string, token: string): Promise<boolean> {
  const result = await sendAgentCommand<{ version: number }>(sessionId, {
    type: "promote_queued_message",
    token,
  });
  return result?.version === 2;
}

/**
 * Delete a queued item safely via RPC.
 * Does not mutate client DOM directly; awaits SSE queue sync.
 */
export async function deleteQueuedMessage(sessionId: string, token: string): Promise<boolean> {
  const result = await sendAgentCommand<{ version: number }>(sessionId, {
    type: "delete_queued_message",
    token,
  });
  return result?.version === 2;
}

/**
 * Reorder queued items of the same kind.
 */
export async function reorderQueuedMessages(
  sessionId: string,
  tokens: string[],
  token: string,
  targetToken: string,
): Promise<boolean> {
  const result = await sendAgentCommand<{ version: number }>(sessionId, {
    type: "reorder_queued_message",
    tokens,
    token,
    targetToken,
  });
  return result?.version === 2;
}

export interface RecallQueuedMessageOptions {
  sessionId: string;
  token: string;
  targetDraftKey?: string;
  getDraftImageCount?: (draftKey: string) => number;
  onRestoreRecall?: (payload: RecalledPromptRestoration) => Promise<boolean>;
}

/**
 * Recall a single queued message atomically.
 * Steps:
 * 1. Fetch full detail (including images). Fails before mutating server if detail read fails.
 * 2. Check draft image count against MAX_ATTACHED_IMAGES (10). Fails before mutation if exceeded.
 * 3. Invoke atomic recall_queued_message RPC. Explicit network error; no silent fallback or downloaded file patch.
 * 4. Restore to target draft atomically.
 */
export async function recallSingleQueuedMessage(options: RecallQueuedMessageOptions): Promise<{
  requestId?: string;
  token: string;
  text: string;
  images: QueuedImage[];
}> {
  const { sessionId, token } = options;
  const targetKey = options.targetDraftKey ?? sessionId;

  // 1. Must validate recall callback first before any network/mutation action
  if (!options.onRestoreRecall || typeof options.onRestoreRecall !== "function") {
    throw new Error("缺少移回输入框处理回调(onRestoreRecall)，已阻止召回以防消息丢失");
  }

  // 2. Must read detail completely first
  const detail = await fetchQueuedMessageDetail(sessionId, token);
  if (!detail) {
    throw new Error("获取排队消息详情失败，队列未改动");
  }

  // 3. Capacity guard
  const existingImages = options.getDraftImageCount ? options.getDraftImageCount(targetKey) : (getDraft(targetKey)?.images.length ?? 0);
  if (existingImages + detail.images.length > MAX_ATTACHED_IMAGES) {
    throw new Error("移回编辑失败：合并后图片数量超过 10 张上限，原消息已保留");
  }

  // 4. Atomic RPC
  let result: { version: number; token: string; text: string; images: QueuedImage[]; requestId?: string; recalledPromptRequestIds?: string[] };
  try {
    result = await sendAgentCommand(sessionId, {
      type: "recall_queued_message",
      token,
    });
  } catch (error) {
    throw new Error(`召回操作未确认，请刷新核对队列状态: ${(error as Error)?.message || String(error)}`);
  }

  if (result?.version !== 2 || result.token !== token || typeof result.text !== "string" || !Array.isArray(result.images)) {
    throw new Error("召回响应无效，请刷新核对队列状态");
  }

  const requestId = result.requestId || result.recalledPromptRequestIds?.[0];

  // 5. Restore to draft
  await options.onRestoreRecall({
    sessionId,
    targetDraftKey: targetKey,
    entries: [{
      requestId,
      text: result.text,
      images: result.images,
    }],
  });

  return {
    requestId,
    token: result.token,
    text: result.text,
    images: result.images,
  };
}

export interface RecallAllQueuedMessagesOptions {
  sessionId: string;
  tokens: string[];
  targetDraftKey?: string;
  getDraftImageCount?: (draftKey: string) => number;
  onRestoreRecall?: (payload: RecalledPromptRestoration) => Promise<boolean>;
}

/**
 * Recall all queued messages atomically.
 * Steps:
 * 1. Fetch full details for all tokens. Fails before RPC if any detail fails.
 * 2. Check total image count against MAX_ATTACHED_IMAGES (10). Fails before RPC if exceeded.
 * 3. Invoke atomic recall_all_queued_messages RPC. Explicit network error; no silent fallback.
 * 4. Restore all entries to draft.
 */
export async function recallAllQueuedMessages(options: RecallAllQueuedMessagesOptions): Promise<Array<{
  requestId?: string;
  token: string;
  text: string;
  images: QueuedImage[];
}>> {
  const { sessionId, tokens } = options;
  const targetKey = options.targetDraftKey ?? sessionId;
  if (!tokens.length) {
    return [];
  }

  // 1. Must validate recall callback first before any network/mutation action
  if (!options.onRestoreRecall || typeof options.onRestoreRecall !== "function") {
    throw new Error("缺少移回输入框处理回调(onRestoreRecall)，已阻止全部召回以防消息丢失");
  }

  // 2. Fetch all details first
  const details = await Promise.all(tokens.map(token => fetchQueuedMessageDetail(sessionId, token)));
  if (details.some(d => !d)) {
    throw new Error("详情尚未完整读取，队列未改动");
  }

  // 3. Capacity guard
  const totalRecallImages = details.reduce((sum, d) => sum + (d?.images.length ?? 0), 0);
  const existingImages = options.getDraftImageCount ? options.getDraftImageCount(targetKey) : (getDraft(targetKey)?.images.length ?? 0);
  if (existingImages + totalRecallImages > MAX_ATTACHED_IMAGES) {
    throw new Error("超过 10 张上限，已阻止全部移回以防丢图");
  }

  // 4. Atomic RPC
  let result: unknown;
  try {
    result = await sendAgentCommand(sessionId, {
      type: "recall_all_queued_messages",
      tokens,
    });
  } catch (error) {
    throw new Error(`全部召回未确认，请刷新核对队列状态: ${(error as Error)?.message || String(error)}`);
  }

  // 5. Validate response strictly with validateRecallAllResponse (order, tokens, image limit)
  const validatedEntries = validateRecallAllResponse(result, tokens);

  const mapped = validatedEntries.map((e, idx) => ({
    requestId: e.requestId,
    token: e.token,
    text: e.text,
    images: e.images.map((img, imgIdx) => ({
      data: img.data,
      mimeType: img.mimeType,
      alt: `图片附件 ${imgIdx + 1}`,
    })),
  }));

  // 6. Restore all entries to draft
  await options.onRestoreRecall({
    sessionId,
    targetDraftKey: targetKey,
    entries: mapped.map(e => ({
      requestId: e.requestId,
      text: e.text,
      images: e.images,
    })),
  });

  return mapped;
}
