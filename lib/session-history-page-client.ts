import { beginConnectionAttempt } from "./connection-diagnostics-client.ts";
import { isSessionMemoryCacheEnabled } from "./session-sync-client.ts";
import type {
  CachedHistoryPage,
  HistoryPageContext,
  HistoryPageExpectedParams,
} from "./session-history-page-cache.ts";
import {
  buildHistoryPageCacheKey,
  computeLocalChecksum,
  validateHistoryPageContext,
  getHistoryPageMemory,
  setHistoryPageMemory,
  deleteHistoryPagesMemory,
  clearHistoryPagesMemory,
  MAX_PAGE_BYTES,
  HISTORY_CACHE_PROTOCOL_HEADER,
  HISTORY_FINGERPRINT_HEADER,
  HISTORY_CACHE_PROTOCOL_VERSION,
} from "./session-history-page-cache.ts";
import {
  readHistoryPageDisk,
  writeHistoryPageDisk,
  deleteHistoryPagesDisk,
  clearHistoryPagesDisk,
  getHistoryPagesGeneration,
} from "./session-history-page-storage.ts";

export interface FetchHistoryPageContextOptions {
  sessionId: string;
  leafId?: string | null;
  before: string;
  tail?: number;
  deferThinking?: boolean;
  deferMedia?: boolean;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  fetchFn?: typeof fetch;
}

export interface FetchHistoryPageContextResult {
  context: HistoryPageContext;
  tail: number;
  before: string | null;
  fromCache: boolean;
  fingerprint?: string;
}

export class HistoryPageHttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message?: string) {
    super(message || `HTTP ${statusCode}`);
    this.name = "HistoryPageHttpError";
    this.statusCode = statusCode;
  }
}

export function deleteSessionHistoryPages(sessionId: string): void {
  deleteHistoryPagesMemory(sessionId);
  deleteHistoryPagesDisk(sessionId);
}

export function clearAllSessionHistoryPages(): void {
  clearHistoryPagesMemory();
  clearHistoryPagesDisk();
}

interface GuardedGetParams {
  key: string;
  sessionId: string;
  leafId: string | null;
  before: string;
  tail: number;
  deferThinking: boolean;
  deferMedia: boolean;
}

async function executeGuardedGet(
  url: string,
  fetchFn: typeof fetch,
  params: GuardedGetParams,
  entryGen: number,
  signal?: AbortSignal,
  isCurrent?: () => boolean,
): Promise<FetchHistoryPageContextResult | null> {
  if (signal?.aborted || (isCurrent && !isCurrent())) return null;

  const diagnostic = beginConnectionAttempt({ operation: "history_read", url, sessionId: params.sessionId,
    engine: params.sessionId.startsWith("codex:") ? "codex" : "pi" });
  let responseStatus: number | undefined;
  try {
  const res = await fetchFn(url, { method: "GET", cache: "no-store", signal, headers: diagnostic.headers });
  responseStatus = res.status;
  if (signal?.aborted || (isCurrent && !isCurrent())) return null;

  if (res.status === 401 || res.status === 403 || res.status === 404) {
    deleteSessionHistoryPages(params.sessionId);
    throw new HistoryPageHttpError(res.status);
  }

  if (!res.ok) {
    throw new HistoryPageHttpError(res.status);
  }

  const data = (await res.json()) as {
    context: HistoryPageContext;
    tail?: number;
    before?: string | null;
  };
  if (signal?.aborted || (isCurrent && !isCurrent())) return null;

  const protocol = res.headers.get(HISTORY_CACHE_PROTOCOL_HEADER);
  const serverFingerprint = res.headers.get(HISTORY_FINGERPRINT_HEADER);
  if ((protocol === HISTORY_CACHE_PROTOCOL_VERSION && data.tail !== params.tail)
    || (data.tail !== undefined && data.tail !== params.tail)) {
    throw new SyntaxError("History page response tail mismatch");
  }
  // A versioned response must certify the exact requested boundary.
  if ((protocol === HISTORY_CACHE_PROTOCOL_VERSION && data.before !== params.before)
    || (data.before !== undefined && data.before !== null && data.before !== params.before)) {
    throw new SyntaxError(`History page response before mismatch: expected ${params.before}, got ${data.before}`);
  }

  // Validate context shape against boundary cursor
  if (!validateHistoryPageContext(data.context, params.before)) {
    throw new SyntaxError("Invalid history page context received from server");
  }

  // Store into cache only if still enabled, generation unchanged, protocol matches, and valid fingerprint exists
  if (
    isSessionMemoryCacheEnabled() &&
    getHistoryPagesGeneration() === entryGen &&
    !signal?.aborted &&
    (!isCurrent || isCurrent()) &&
    protocol === HISTORY_CACHE_PROTOCOL_VERSION &&
    serverFingerprint
  ) {
    try {
      const serialized = JSON.stringify(data.context);
      const bytes = new TextEncoder().encode(serialized).byteLength;
      if (bytes <= MAX_PAGE_BYTES) {
        const pageEntry: CachedHistoryPage = {
          key: params.key,
          sessionId: params.sessionId,
          leafId: params.leafId,
          before: params.before,
          tail: data.tail ?? params.tail,
          deferThinking: params.deferThinking,
          deferMedia: params.deferMedia,
          fingerprint: serverFingerprint,
          protocol: HISTORY_CACHE_PROTOCOL_VERSION,
          context: data.context,
          savedAt: Date.now(),
          lastAccessed: Date.now(),
          bytes,
          localChecksum: computeLocalChecksum(serialized),
        };

        // Re-check right before writes: prevent late resurrect
        if (isSessionMemoryCacheEnabled() && getHistoryPagesGeneration() === entryGen) {
          setHistoryPageMemory(pageEntry);
          writeHistoryPageDisk(pageEntry, entryGen);
        }
      }
    } catch {
      // Safe serialization failure ignore
    }
  }

  diagnostic.success();
  return {
    context: data.context,
    tail: data.tail ?? params.tail,
    before: data.before ?? params.before,
    fromCache: false,
    fingerprint: serverFingerprint ?? undefined,
  };
  } catch (error) {
    diagnostic.fail(error, { status: responseStatus, cancelled: signal?.aborted || (isCurrent ? !isCurrent() : false) });
    throw error;
  }
}

export async function fetchHistoryPageContext(
  options: FetchHistoryPageContextOptions,
): Promise<FetchHistoryPageContextResult | null> {
  const entryGen = getHistoryPagesGeneration();
  const { sessionId, leafId, before, signal, isCurrent } = options;
  const fetchFn = options.fetchFn ?? fetch;

  const rawTail = Number(options.tail);
  const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
  const deferThinking = options.deferThinking !== false;
  const deferMedia = options.deferMedia !== false;

  const params = new URLSearchParams();
  if (deferThinking) params.set("deferThinking", "1");
  if (deferMedia) params.set("deferMedia", "1");
  if (leafId) params.set("leafId", leafId);
  params.set("before", before);
  if (tail) params.set("tail", String(tail));

  const url = `/api/sessions/${encodeURIComponent(sessionId)}/context?${params}`;

  const guardedParams: GuardedGetParams = {
    key: buildHistoryPageCacheKey({
      sessionId,
      leafId,
      before,
      tail,
      deferThinking,
      deferMedia,
    }),
    sessionId,
    leafId: leafId ?? null,
    before,
    tail,
    deferThinking,
    deferMedia,
  };

  const enabled = isSessionMemoryCacheEnabled();

  // If cache is disabled or before cursor is empty (not older page history), directly bypass to guarded GET
  if (!enabled || !before) {
    return executeGuardedGet(url, fetchFn, guardedParams, entryGen, signal, isCurrent);
  }

  if (signal?.aborted || (isCurrent && !isCurrent())) return null;

  const expectedParams: HistoryPageExpectedParams = {
    key: guardedParams.key,
    sessionId,
    leafId: guardedParams.leafId,
    before,
    tail,
    deferThinking,
    deferMedia,
  };

  // 1. Look in Memory, then IndexedDB
  let cached: CachedHistoryPage | null = getHistoryPageMemory(guardedParams.key, expectedParams);
  if (!cached) {
    cached = await readHistoryPageDisk(guardedParams.key, expectedParams);
    if (signal?.aborted || (isCurrent && !isCurrent())) return null;
    if (cached && isSessionMemoryCacheEnabled() && getHistoryPagesGeneration() === entryGen) {
      setHistoryPageMemory(cached);
    }
  }

  // If cache was disabled or cleared while reading from disk, fall through to guarded GET
  if (!isSessionMemoryCacheEnabled() || getHistoryPagesGeneration() !== entryGen) {
    return executeGuardedGet(url, fetchFn, guardedParams, entryGen, signal, isCurrent);
  }

  // 2. Cache Hit Candidate: Send HEAD to verify authorization and fingerprint
  if (cached && cached.fingerprint) {
    let headRes: Response;
    try {
      headRes = await fetchFn(url, { method: "HEAD", cache: "no-store", signal });
    } catch (err) {
      if (signal?.aborted || (isCurrent && !isCurrent())) return null;
      throw err;
    }

    if (signal?.aborted || (isCurrent && !isCurrent())) return null;

    if (headRes.status === 401 || headRes.status === 403 || headRes.status === 404) {
      deleteSessionHistoryPages(sessionId);
      throw new HistoryPageHttpError(headRes.status);
    }

    // HEAD 5xx must never be treated as hit
    if (headRes.status >= 500) {
      throw new HistoryPageHttpError(headRes.status);
    }

    if (headRes.ok) {
      const protocol = headRes.headers.get(HISTORY_CACHE_PROTOCOL_HEADER);
      const remoteFingerprint = headRes.headers.get(HISTORY_FINGERPRINT_HEADER);

      // If legacy backend has no protocol header or fingerprint, fall back through guarded GET
      if (protocol !== HISTORY_CACHE_PROTOCOL_VERSION || !remoteFingerprint) {
        return executeGuardedGet(url, fetchFn, guardedParams, entryGen, signal, isCurrent);
      }

      // Exact fingerprint match: return local body only if cache still enabled and generation unchanged
      if (remoteFingerprint === cached.fingerprint) {
        if (isSessionMemoryCacheEnabled() && getHistoryPagesGeneration() === entryGen) {
          return {
            context: cached.context,
            tail: cached.tail,
            before: cached.before,
            fromCache: true,
            fingerprint: remoteFingerprint,
          };
        }
        return executeGuardedGet(url, fetchFn, guardedParams, entryGen, signal, isCurrent);
      }
    }
  }

  // 3. Cache Miss / Fingerprint Mismatch / Fallback: GET authoritative body
  return executeGuardedGet(url, fetchFn, guardedParams, entryGen, signal, isCurrent);
}
