import { clearToolResultContentCache, deleteToolResultContentCache } from "./tool-result-content.ts";
// Bounded in-memory snapshot of settled session history. The view snapshot and
// sync wire baseline share one resident-session LRU and one byte budget.
// Streaming and SSE objects stay in their live owners. Queue previews are
// display-only, memory-only metadata, never certified or persisted wire state.

import type { AgentMessage } from "./types";
import type { SessionData } from "../hooks/useAgentSession";
import { deleteSessionWireDisk, writeSessionWireDisk, prepareSessionWireDisk } from "./session-sync-storage.ts";
import { deleteSessionHistoryPages, clearAllSessionHistoryPages } from "./session-history-page-client.ts";

export type SessionViewCachePriority = "normal" | "completed-unread" | "running" | "attention";

export interface SessionViewSnapshot {
	sessionId: string;
	/** Opaque server revision the snapshot was validated against. */
	revision: string | null;
	/** Preview from a live/unstable read; never a delta baseline. */
	livePreview?: boolean;
	data?: SessionData;
	messages: AgentMessage[];
	entryIds: string[];
	leafId: string | null;
	/** Oldest entry id currently loaded — the pagination cursor. */
	oldestEntryId: string | null;
	hasMore: boolean;
	/** Summary-format branch tree (no bodies) when the server sent one. */
	summaryTree?: unknown;
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	stats?: unknown;
	navigationTotalTurns?: number;
	totalActiveMs?: number;
	/** Ids of history pages the user already paged in beyond the first window. */
	loadedEntryIds: string[];
	/** Last confirmed queue for immediate paint; the live owner must revalidate it. */
	queuePreview?: { steering: string[]; followUp: string[]; deliveryStates?: {status: string; error?: string}[] };
	/** Ranking metadata only; does not change the authoritative snapshot. */
	cachePriority?: SessionViewCachePriority;
	savedAt: number;
}

/** Exact wire baseline returned by server for sync protocol delta calculation. */
export interface SessionWireBaseline {
	sessionId: string;
	revision: string;
	messages: AgentMessage[];
	entryIds: string[];
	/** Exact response metadata; unchanged cannot reconstruct tool presets from messages alone. */
	data?: SessionData;
	cachePriority?: SessionViewCachePriority;
	savedAt: number;
}

export const MAX_SESSION_VIEW_CACHE_SESSIONS = 20;
export const MAX_SESSION_VIEW_CACHE_BYTES = 128 * 1024 * 1024;

declare global {
	var __piSessionViewCache: Map<string, SessionViewSnapshot> | undefined;
	var __piSessionWireBaselines: Map<string, SessionWireBaseline> | undefined;
}

const lruOrder = new Map<string, true>(); // Oldest to newest, shared by both maps.
const byteSizes = new WeakMap<object, number>();
let activeSessionId: string | null = null;

function cache(): Map<string, SessionViewSnapshot> {
	if (!globalThis.__piSessionViewCache) globalThis.__piSessionViewCache = new Map();
	return globalThis.__piSessionViewCache;
}

function wireCache(): Map<string, SessionWireBaseline> {
	if (!globalThis.__piSessionWireBaselines) globalThis.__piSessionWireBaselines = new Map();
	return globalThis.__piSessionWireBaselines;
}

function residentIds(): Set<string> {
	return new Set([...cache().keys(), ...wireCache().keys()]);
}

/** Reconcile direct global-map changes without treating reads as LRU touches. */
function syncLruOrder(): void {
	const resident = residentIds();
	for (const sessionId of lruOrder.keys()) {
		if (!resident.has(sessionId)) lruOrder.delete(sessionId);
	}
	for (const sessionId of cache().keys()) {
		if (!lruOrder.has(sessionId)) lruOrder.set(sessionId, true);
	}
	for (const sessionId of wireCache().keys()) {
		if (!lruOrder.has(sessionId)) lruOrder.set(sessionId, true);
	}
}

function touchSession(sessionId: string): void {
	syncLruOrder();
	lruOrder.delete(sessionId);
	lruOrder.set(sessionId, true);
	// Keep the exposed maps' iteration order useful to their existing readers.
	const view = cache().get(sessionId);
	if (view) {
		cache().delete(sessionId);
		cache().set(sessionId, view);
	}
	const baseline = wireCache().get(sessionId);
	if (baseline) {
		wireCache().delete(sessionId);
		wireCache().set(sessionId, baseline);
	}
}

function snapshotBytes(snapshot: unknown): number {
	const cacheKey = snapshot !== null && typeof snapshot === "object" ? snapshot : null;
	if (cacheKey) {
		const cached = byteSizes.get(cacheKey);
		if (cached !== undefined) return cached;
	}
	try {
		const wire = snapshot as SessionWireBaseline;
		const record = wire?.data ? prepareSessionWireDisk(wire) : null;
		if (record) {
      const preview = (snapshot as SessionViewSnapshot).queuePreview;
      const bytes = record.bytes + (preview ? new TextEncoder().encode(JSON.stringify(preview)).byteLength : 0);
      if (cacheKey) byteSizes.set(cacheKey, bytes);
      return bytes;
    }
		const serialized = JSON.stringify(snapshot);
		const bytes = typeof serialized === "string"
			? new TextEncoder().encode(serialized).byteLength
			: Number.MAX_SAFE_INTEGER;
		if (cacheKey) byteSizes.set(cacheKey, bytes);
		return bytes;
	} catch {
		// Circular or non-serializable payload — treat as oversize.
		const bytes = Number.MAX_SAFE_INTEGER;
		if (cacheKey) byteSizes.set(cacheKey, bytes);
		return bytes;
	}
}

function priorityRank(priority: SessionViewCachePriority | undefined): number {
	switch (priority) {
		case "attention": return 3;
		case "running": return 2;
		case "completed-unread": return 1;
		default: return 0;
	}
}

function sessionPriority(sessionId: string): SessionViewCachePriority {
	const viewRank = priorityRank(cache().get(sessionId)?.cachePriority);
	const wireRank = priorityRank(wireCache().get(sessionId)?.cachePriority);
	const rank = Math.max(viewRank, wireRank);
	return rank === 3 ? "attention" : rank === 2 ? "running" : rank === 1 ? "completed-unread" : "normal";
}

function removeResidentSession(sessionId: string): void {
	cache().delete(sessionId);
	wireCache().delete(sessionId);
	lruOrder.delete(sessionId);
}

function evictToFit(): void {
	syncLruOrder();
	const viewCache = cache();
	const baselines = wireCache();
	const totalBytes = () => {
		let total = 0;
		for (const item of viewCache.values()) total += snapshotBytes(item);
		for (const item of baselines.values()) total += snapshotBytes(item);
		return total;
	};
	while (lruOrder.size > MAX_SESSION_VIEW_CACHE_SESSIONS || totalBytes() > MAX_SESSION_VIEW_CACHE_BYTES) {
		let victim: string | undefined;
		let victimRank = Number.POSITIVE_INFINITY;
		for (const sessionId of lruOrder.keys()) {
			// The selected session is protected ahead of status priority. The hard
			// session and byte caps still win if it is the only possible victim.
			const rank = (sessionId === activeSessionId ? 100 : 0) + priorityRank(sessionPriority(sessionId));
			if (rank < victimRank) {
				victim = sessionId;
				victimRank = rank;
			}
		}
		if (victim === undefined) break;
		removeResidentSession(victim);
	}
}

function validPriority(value: unknown): value is SessionViewCachePriority {
	return value === "normal" || value === "completed-unread" || value === "running" || value === "attention";
}

function withPriority<T extends { cachePriority?: SessionViewCachePriority }>(
	entry: T,
	priority: SessionViewCachePriority,
): T {
	const previousBytes = snapshotBytes(entry);
	const previousPriority = entry.cachePriority;
	const delta = previousPriority
		? JSON.stringify(priority)!.length - JSON.stringify(previousPriority)!.length
		: JSON.stringify({ cachePriority: priority })!.length - 1;
	const updated = Object.freeze({ ...entry, cachePriority: priority }) as T;
	// Priorities are short ASCII metadata. Reuse the immutable payload's known
	// size and adjust only the encoded status field instead of serializing messages.
	byteSizes.set(updated, Math.max(0, previousBytes + delta));
	return updated;
}

function inheritedPriority(
	sessionId: string,
	input: { cachePriority?: SessionViewCachePriority },
	previous?: { cachePriority?: SessionViewCachePriority },
): SessionViewCachePriority | undefined {
	if (Object.prototype.hasOwnProperty.call(input, "cachePriority")) return input.cachePriority;
	const current = sessionPriority(sessionId);
	if (current !== "normal") return current;
	return previous?.cachePriority;
}

export function getSessionViewSnapshot(sessionId: string, touch = true): SessionViewSnapshot | null {
	const snapshot = cache().get(sessionId);
	if (!snapshot) return null;
	if (touch) touchSession(sessionId);
	return snapshot;
}

/** Store a snapshot; returns false when it was refused (oversize/invalid). */
export function setSessionViewSnapshot(snapshot: Omit<SessionViewSnapshot, "savedAt">): boolean {
	if (!snapshot.sessionId || (!snapshot.revision && !(snapshot.livePreview && snapshot.revision === null))) return false;
	const store = cache();
	const previous = store.get(snapshot.sessionId);
	store.delete(snapshot.sessionId);
	const priority = inheritedPriority(snapshot.sessionId, snapshot, previous);
	const entry = Object.freeze({
		...snapshot,
		queuePreview: snapshot.queuePreview ?? previous?.queuePreview,
		savedAt: Date.now(),
		...(priority ? { cachePriority: priority } : {}),
	}) as SessionViewSnapshot;
	if (snapshotBytes(entry) > MAX_SESSION_VIEW_CACHE_BYTES) {
		syncLruOrder();
		return false;
	}
	store.set(entry.sessionId, entry);
	touchSession(entry.sessionId);
	evictToFit();
	return cache().has(entry.sessionId);
}

export function deleteSessionViewSnapshot(sessionId: string, options: { preserveHistoryPages?: boolean } = {}): void {
  deleteToolResultContentCache(sessionId);
	cache().delete(sessionId);
	wireCache().delete(sessionId);
	lruOrder.delete(sessionId);
	deleteSessionWireDisk(sessionId);
	// Losing a certified moving-tail snapshot is not deletion of immutable
	// ancestor pages: each of those is independently authenticated by HEAD.
	if (!options.preserveHistoryPages) deleteSessionHistoryPages(sessionId);
}

export function clearSessionViewCache(): void {
  clearToolResultContentCache();
	cache().clear();
	wireCache().clear();
	lruOrder.clear();
	activeSessionId = null;
	deleteSessionWireDisk();
	clearAllSessionHistoryPages();
}

export function getSessionWireBaseline(sessionId: string, touch = true): SessionWireBaseline | null {
	const baseline = wireCache().get(sessionId);
	if (!baseline) return null;
	if (touch) touchSession(sessionId);
	return baseline;
}

export function setSessionWireBaseline(baseline: Omit<SessionWireBaseline, "savedAt">, persist = true): boolean {
	if (!baseline.sessionId || !baseline.revision) return false;
	const store = wireCache();
	const previous = store.get(baseline.sessionId);
	store.delete(baseline.sessionId);
	if (!Array.isArray(baseline.messages) || !Array.isArray(baseline.entryIds)
		|| baseline.messages.length !== baseline.entryIds.length
		|| new Set(baseline.entryIds).size !== baseline.entryIds.length
		|| baseline.entryIds.some((id) => typeof id !== "string" || !id)) {
		syncLruOrder();
		return false;
	}
	const priority = inheritedPriority(baseline.sessionId, baseline, previous);
	const entry = Object.freeze({
		...baseline,
		savedAt: Date.now(),
		...(priority ? { cachePriority: priority } : {}),
	}) as SessionWireBaseline;
	if (snapshotBytes(entry) > MAX_SESSION_VIEW_CACHE_BYTES) {
		syncLruOrder();
		return false;
	}
	store.set(entry.sessionId, entry);
	touchSession(entry.sessionId);
	evictToFit();
	if (persist && store.has(entry.sessionId)) writeSessionWireDisk(entry);
	return store.has(entry.sessionId);
}

export function deleteSessionWireBaseline(sessionId: string): void {
	wireCache().delete(sessionId);
	syncLruOrder();
	deleteSessionWireDisk(sessionId);
}

/** Assign retention rank without pinning entries beyond the shared hard caps. */
export function setSessionViewCachePriority(sessionId: string, priority: SessionViewCachePriority): boolean {
	if (!sessionId || !validPriority(priority)) return false;
	const view = cache().get(sessionId);
	const baseline = wireCache().get(sessionId);
	if (!view && !baseline) return false;
	if ((!view || view.cachePriority === priority) && (!baseline || baseline.cachePriority === priority)) return true;
	if (view) cache().set(sessionId, withPriority(view, priority));
	if (baseline) wireCache().set(sessionId, withPriority(baseline, priority));
	evictToFit();
	return cache().has(sessionId) || wireCache().has(sessionId);
}

/** Protect the selected session before all status priorities during eviction. */
export function setSessionViewCacheActiveSession(sessionId: string | null): void {
	activeSessionId = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
	evictToFit();
}

/** Resident ids ordered most recently accessed first; reading order does not touch LRU. */
export function getSessionViewCacheOrder(): string[] {
	syncLruOrder();
	return Array.from(lruOrder.keys()).reverse();
}

/** True when a cached window still covers every entry the UI has loaded. */
export function snapshotCoversLoadedEntries(
	snapshot: SessionViewSnapshot,
	loadedEntryIds: string[],
): boolean {
	if (loadedEntryIds.length === 0) return true;
	const known = new Set([...snapshot.entryIds, ...snapshot.loadedEntryIds]);
	return loadedEntryIds.every((id) => known.has(id));
}

/** Test seam: drop all module state. */
export function resetSessionViewCacheForTests(): void {
	globalThis.__piSessionViewCache = undefined;
	globalThis.__piSessionWireBaselines = undefined;
	lruOrder.clear();
	activeSessionId = null;
	clearAllSessionHistoryPages();
}
