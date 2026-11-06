import {
  CONNECTION_DIAGNOSTICS_ENDPOINT,
  CONNECTION_OPERATIONS,
  CONNECTION_REASONS,
  CONNECTION_TRACE_HEADER,
  connectionErrorFields,
  connectionFailureReason,
  diagnosticRoute,
  safeSessionId,
  safeTraceId,
  sanitizeConnectionDiagnostic,
  sessionIdFromDiagnosticUrl,
  type ConnectionDiagnostic,
  type ConnectionOperation,
  type ConnectionReason,
} from "./connection-diagnostics.ts";

export { CONNECTION_TRACE_HEADER };

const STORAGE_KEY = "pi-web:connection-diagnostics:v1";
const PAGE_ID_KEY = "pi-web:connection-diagnostics:page-id:v1";
const MAX_EVENTS = 80;
const MAX_OUTAGES = 80;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const COALESCE_MS = 30 * 1000;
const FAILED_FLUSH_INTERVAL_MS = 15 * 1000;
const FLUSH_TIMEOUT_MS = 2500;
const BATCH_SIZE = 20;

export interface BeginConnectionAttemptOptions {
  operation: ConnectionOperation;
  url: string;
  sessionId?: string;
  engine?: "pi" | "codex";
  timeoutMs?: number;
}

export interface ConnectionAttemptFailureOptions {
  status?: number;
  timedOut?: boolean;
  cancelled?: boolean;
  reason?: ConnectionReason;
}

interface StoredEvent {
  id: string;
  event: ConnectionDiagnostic;
}

interface StoredOutage {
  groupKey: string;
  operation: ConnectionOperation;
  route: string;
  pageId: string;
  sessionId?: string;
  engine?: "pi" | "codex";
  startedAt: number;
  lastLoggedAt: number;
  signature: string;
  attempts: number;
}

interface ClientState {
  events: StoredEvent[];
  outages: Record<string, StoredOutage>;
}

interface StoredState {
  version: 1;
  events: StoredEvent[];
  outages: StoredOutage[];
}

let memoryState: ClientState | null = null;
let memoryDirty = false;
let cachedPageId: string | null = null;
let flushPromise: Promise<void> | null = null;
let lastFailedFlushAt: number | null = null;
let listenerWindow: Window | null = null;
let listenerDocument: Document | null = null;
let onlineListener: (() => void) | null = null;
let visibilityListener: (() => void) | null = null;

function isBrowserRuntime(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function isDiagnosticReportUrl(url: string): boolean {
  return diagnosticRoute(url) === CONNECTION_DIAGNOSTICS_ENDPOINT;
}

function now(): number {
  return Date.now();
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : now();
}

function createUuid(): string {
  try {
    const value = globalThis.crypto?.randomUUID?.();
    if (safeTraceId(value)) return value;
  } catch { /* use a local fallback when crypto is unavailable */ }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (part) => {
    const value = Math.floor(Math.random() * 16);
    return (part === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function getLocalStorage(): Storage | null {
  if (!isBrowserRuntime()) return null;
  try { return window.localStorage; } catch { return null; }
}

function getPageId(): string {
  if (cachedPageId) return cachedPageId;
  const id = createUuid();
  try {
    const storage = window.sessionStorage;
    const existing = safeTraceId(storage.getItem(PAGE_ID_KEY));
    if (existing) return cachedPageId = existing;
    storage.setItem(PAGE_ID_KEY, id);
  } catch { /* in-memory identity is enough when tab storage is unavailable */ }
  return cachedPageId = id;
}

function browserStateFields(): Pick<ConnectionDiagnostic, "online" | "visibility"> {
  const fields: Pick<ConnectionDiagnostic, "online" | "visibility"> = {};
  try { if (typeof navigator.onLine === "boolean") fields.online = navigator.onLine; } catch { /* optional browser metadata */ }
  try {
    const visibility = document.visibilityState;
    if (visibility === "visible" || visibility === "hidden" || visibility === "prerender") fields.visibility = visibility;
  } catch { /* optional browser metadata */ }
  return fields;
}

function groupKey(operation: ConnectionOperation, route: string, sessionId: string | undefined, engine: "pi" | "codex" | undefined, pageId: string): string {
  return JSON.stringify([operation, route, sessionId ?? "", engine ?? "", pageId]);
}

function emptyState(): ClientState {
  return { events: [], outages: Object.create(null) as Record<string, StoredOutage> };
}

function validOperation(value: unknown): value is ConnectionOperation {
  return CONNECTION_OPERATIONS.includes(value as ConnectionOperation);
}

function safeStoredEvent(value: unknown): StoredEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = safeTraceId(row.id);
  const event = sanitizeConnectionDiagnostic(row.event);
  if (!id || !event || event.source !== "browser" || (event.event !== "failure" && event.event !== "recovered")) return null;
  return { id, event };
}

function safeStoredOutage(value: unknown): StoredOutage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!validOperation(row.operation) || typeof row.route !== "string"
    || !Number.isFinite(row.startedAt) || !Number.isFinite(row.lastLoggedAt)
    || typeof row.signature !== "string" || row.signature.length > 256
    || !Number.isInteger(row.attempts) || Number(row.attempts) < 1) return null;
  const route = diagnosticRoute(row.route);
  const sessionId = safeSessionId(row.sessionId);
  const engine = row.engine === "pi" || row.engine === "codex" ? row.engine : undefined;
  const pageId = safeTraceId(row.pageId);
  if (!pageId) return null;
  const key = groupKey(row.operation, route, sessionId, engine, pageId);
  if (row.groupKey !== key) return null;
  const outage: StoredOutage = {
    groupKey: key,
    operation: row.operation,
    route,
    pageId,
    startedAt: Number(row.startedAt),
    lastLoggedAt: Number(row.lastLoggedAt),
    signature: row.signature,
    attempts: Math.min(1_000_000, Number(row.attempts)),
  };
  if (sessionId) outage.sessionId = sessionId;
  if (engine) outage.engine = engine;
  return outage;
}

function readPersistentState(): { state: ClientState; available: boolean } {
  const storage = getLocalStorage();
  if (!storage) return { state: emptyState(), available: false };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { state: emptyState(), available: true };
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.events) || !Array.isArray(parsed.outages)) {
      return { state: emptyState(), available: true };
    }
    const state = emptyState();
    for (const value of parsed.events) {
      const row = safeStoredEvent(value);
      if (row) state.events.push(row);
    }
    for (const value of parsed.outages) {
      const row = safeStoredOutage(value);
      if (row) state.outages[row.groupKey] = row;
    }
    return { state: pruneState(state), available: true };
  } catch { return { state: emptyState(), available: false }; }
}

function pruneState(state: ClientState): ClientState {
  const cutoff = now() - MAX_AGE_MS;
  const events = state.events.filter((row) => {
    const at = Date.parse(row.event.at);
    return Number.isFinite(at) && at >= cutoff && at <= now() + 5 * 60 * 1000;
  }).sort((a, b) => Date.parse(a.event.at) - Date.parse(b.event.at)).slice(-MAX_EVENTS);
  const outages = Object.values(state.outages)
    .filter((row) => row.groupKey === groupKey(row.operation, row.route, row.sessionId, row.engine, row.pageId))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_OUTAGES);
  const map = Object.create(null) as Record<string, StoredOutage>;
  for (const outage of outages) map[outage.groupKey] = outage;
  return { events, outages: map };
}

function mergeStates(primary: ClientState, secondary: ClientState): ClientState {
  const eventMap = new Map<string, StoredEvent>();
  for (const row of [...primary.events, ...secondary.events]) eventMap.set(row.id, row);
  const outages = Object.create(null) as Record<string, StoredOutage>;
  for (const row of Object.values(secondary.outages)) outages[row.groupKey] = row;
  for (const row of Object.values(primary.outages)) {
    const previous = outages[row.groupKey];
    if (!previous) outages[row.groupKey] = row;
    else outages[row.groupKey] = {
      ...previous,
      ...row,
      startedAt: Math.min(previous.startedAt, row.startedAt),
      lastLoggedAt: Math.max(previous.lastLoggedAt, row.lastLoggedAt),
      attempts: Math.max(previous.attempts, row.attempts),
    };
  }
  return pruneState({ events: [...eventMap.values()], outages });
}

function loadState(): ClientState {
  const persisted = readPersistentState();
  if (!persisted.available) {
    memoryDirty = true;
    memoryState = memoryState ? pruneState(memoryState) : persisted.state;
    return memoryState;
  }
  const state = memoryDirty && memoryState ? mergeStates(memoryState, persisted.state) : persisted.state;
  memoryState = state;
  return state;
}

function persistState(state: ClientState): void {
  const pruned = pruneState(state);
  memoryState = pruned;
  const storage = getLocalStorage();
  if (!storage) {
    memoryDirty = true;
    return;
  }
  const value: StoredState = { version: 1, events: pruned.events, outages: Object.values(pruned.outages) };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(value));
    memoryDirty = false;
  } catch {
    memoryDirty = true;
  }
}

function appendEvent(state: ClientState, value: unknown): void {
  const event = sanitizeConnectionDiagnostic(value);
  if (!event || event.source !== "browser" || (event.event !== "failure" && event.event !== "recovered")) return;
  state.events.push({ id: createUuid(), event });
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.round(monotonicNow() - startedAt));
}

function getErrorFields(error: unknown): { errorName?: string; errorCode?: string } {
  try { return connectionErrorFields(error); } catch { return {}; }
}

function emitFailure(context: AttemptContext, error: unknown, options: ConnectionAttemptFailureOptions): void {
  const state = loadState();
  const currentTime = now();
  const existing = state.outages[context.groupKey];
  let reason: ConnectionReason;
  const explicitReason = options.reason && CONNECTION_REASONS.includes(options.reason) && options.reason !== "recovered"
    ? options.reason
    : undefined;
  try { reason = explicitReason ?? connectionFailureReason(error, options.status, options.timedOut === true); }
  catch { reason = explicitReason ?? "network_error"; }
  const errorFields = getErrorFields(error);
  const signature = JSON.stringify([reason, options.status ?? null, options.timedOut === true,
    errorFields.errorName ?? null, errorFields.errorCode ?? null]);
  const outage: StoredOutage = existing ? {
    ...existing,
    attempts: Math.min(1_000_000, existing.attempts + 1),
  } : {
    groupKey: context.groupKey,
    operation: context.operation,
    route: context.route,
    pageId: context.pageId,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context.engine ? { engine: context.engine } : {}),
    startedAt: currentTime,
    lastLoggedAt: currentTime,
    signature,
    attempts: 1,
  };
  const shouldLog = !existing || signature !== existing.signature || currentTime - existing.lastLoggedAt >= COALESCE_MS;
  outage.signature = signature;
  if (shouldLog) outage.lastLoggedAt = currentTime;
  state.outages[context.groupKey] = outage;
  if (shouldLog) {
    appendEvent(state, {
      version: 1,
      at: new Date(currentTime).toISOString(),
      event: "failure",
      source: "browser",
      operation: context.operation,
      reason,
      route: context.route,
      traceId: context.traceId,
      ...(context.engine ? { engine: context.engine } : {}),
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      pageId: context.pageId,
      durationMs: elapsedSince(context.startedMono),
      ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      attempts: outage.attempts,
      outageMs: Math.max(0, currentTime - outage.startedAt),
      ...browserStateFields(),
      ...errorFields,
    });
  }
  persistState(state);
}

function emitRecovery(context: AttemptContext, status?: number): void {
  const state = loadState();
  const outage = state.outages[context.groupKey];
  if (!outage) return;
  delete state.outages[context.groupKey];
  appendEvent(state, {
    version: 1,
    at: new Date(now()).toISOString(),
    event: "recovered",
    source: "browser",
    operation: context.operation,
    reason: "recovered",
    route: context.route,
    traceId: context.traceId,
    ...(context.engine ? { engine: context.engine } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
    pageId: context.pageId,
    ...(status !== undefined ? { status } : {}),
    durationMs: elapsedSince(context.startedMono),
    ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    attempts: outage.attempts,
    outageMs: Math.max(0, now() - outage.startedAt),
    ...browserStateFields(),
  });
  persistState(state);
}

interface AttemptContext {
  traceId: string;
  operation: ConnectionOperation;
  route: string;
  groupKey: string;
  sessionId?: string;
  engine?: "pi" | "codex";
  timeoutMs?: number;
  pageId: string;
  startedMono: number;
}

function installListeners(): void {
  if (!isBrowserRuntime() || listenerWindow === window) return;
  removeListeners();
  listenerWindow = window;
  listenerDocument = document;
  onlineListener = () => { void flushConnectionDiagnostics(); };
  visibilityListener = () => {
    if (document.visibilityState === "visible") void flushConnectionDiagnostics();
  };
  window.addEventListener("online", onlineListener);
  document.addEventListener("visibilitychange", visibilityListener);
}

function removeListeners(): void {
  if (listenerWindow && onlineListener) listenerWindow.removeEventListener("online", onlineListener);
  if (listenerDocument && visibilityListener) listenerDocument.removeEventListener("visibilitychange", visibilityListener);
  listenerWindow = null;
  listenerDocument = null;
  onlineListener = null;
  visibilityListener = null;
}

function isOnline(): boolean {
  try { return typeof navigator.onLine !== "boolean" || navigator.onLine; } catch { return true; }
}

async function postBatch(rows: StoredEvent[]): Promise<number> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectTimeout: ((error: Error) => void) | null = null;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const request = fetch(CONNECTION_DIAGNOSTICS_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: rows.map((row) => row.event) }),
    ...(controller ? { signal: controller.signal } : {}),
  });
  timer = setTimeout(() => {
    try { controller?.abort(); } catch { /* abort is best-effort */ }
    rejectTimeout?.(new Error("diagnostic flush timed out"));
  }, FLUSH_TIMEOUT_MS);
  try {
    const response = await Promise.race([request, timeout]);
    if (!response.ok || response.status !== 202) throw new Error("diagnostic batch was not acknowledged");
    const body = await Promise.race([response.json(), timeout]) as { accepted?: unknown };
    if (!Number.isInteger(body?.accepted) || Number(body.accepted) < 1 || Number(body.accepted) > rows.length) {
      throw new Error("diagnostic acknowledgement was invalid");
    }
    return Number(body.accepted);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function performFlush(): Promise<void> {
  if (!isBrowserRuntime() || !isOnline()) return;
  const state = loadState();
  if (!state.events.length) return;
  const startedAt = now();
  if (lastFailedFlushAt !== null && startedAt - lastFailedFlushAt < FAILED_FLUSH_INTERVAL_MS) return;
  const initialIds = new Set(state.events.map((row) => row.id));
  let remainingIds = new Set(initialIds);
  while (remainingIds.size > 0) {
    const current = loadState();
    const batch = current.events.filter((row) => remainingIds.has(row.id)).slice(0, BATCH_SIZE);
    if (!batch.length) return;
    let accepted: number;
    try { accepted = await postBatch(batch); }
    catch {
      lastFailedFlushAt = now();
      return;
    }
    lastFailedFlushAt = null;
    const acknowledged = new Set(batch.slice(0, accepted).map((row) => row.id));
    remainingIds = new Set([...remainingIds].filter((id) => !acknowledged.has(id)));
    const latest = loadState();
    latest.events = latest.events.filter((row) => !acknowledged.has(row.id));
    persistState(latest);
  }
}

/** Flushes durable browser diagnostics without affecting the native request result. */
export function flushConnectionDiagnostics(): Promise<void> {
  if (!isBrowserRuntime()) return Promise.resolve();
  installListeners();
  if (flushPromise) return flushPromise;
  flushPromise = performFlush().catch(() => {}).finally(() => { flushPromise = null; });
  return flushPromise;
}

export function beginConnectionAttempt(options: BeginConnectionAttemptOptions): {
  traceId: string;
  headers: Record<string, string>;
  fail(error: unknown, options?: ConnectionAttemptFailureOptions): void;
  success(status?: number): void;
} {
  const traceId = createUuid();
  const url = typeof options?.url === "string" ? options.url : "";
  const route = diagnosticRoute(url);
  const operation = options?.operation;
  const active = isBrowserRuntime() && validOperation(operation) && !isDiagnosticReportUrl(url);
  const sessionId = safeSessionId(options?.sessionId) ?? sessionIdFromDiagnosticUrl(url);
  const pageId = active ? getPageId() : "00000000-0000-4000-8000-000000000000";
  const engine = options?.engine === "pi" || options?.engine === "codex" ? options.engine : undefined;
  const context: AttemptContext = {
    traceId,
    operation: validOperation(operation) ? operation : "status_poll",
    route,
    groupKey: groupKey(validOperation(operation) ? operation : "status_poll", route, sessionId, engine, pageId),
    ...(sessionId ? { sessionId } : {}),
    ...(engine ? { engine } : {}),
    ...(typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0 ? { timeoutMs: options.timeoutMs } : {}),
    pageId,
    startedMono: monotonicNow(),
  };
  if (active) installListeners();
  let terminal = false;
  return {
    traceId,
    headers: { [CONNECTION_TRACE_HEADER]: traceId },
    fail(error: unknown, failureOptions: ConnectionAttemptFailureOptions = {}): void {
      if (terminal) return;
      terminal = true;
      if (!active || failureOptions.cancelled === true) return;
      try { emitFailure(context, error, failureOptions); } catch { /* diagnostics never change native request behavior */ }
      try { void flushConnectionDiagnostics(); } catch { /* diagnostics never change native request behavior */ }
    },
    success(status?: number): void {
      if (terminal) return;
      terminal = true;
      if (!active) return;
      try { emitRecovery(context, status); } catch { /* diagnostics never change native request behavior */ }
      try { void flushConnectionDiagnostics(); } catch { /* diagnostics never change native request behavior */ }
    },
  };
}

/** Test-only lifecycle reset. It never clears persisted data unless explicitly requested. */
export function _resetConnectionDiagnosticsClientForTests(options: { clearStorage?: boolean } = {}): void {
  removeListeners();
  flushPromise = null;
  lastFailedFlushAt = null;
  cachedPageId = null;
  memoryState = null;
  memoryDirty = false;
  if (options.clearStorage) {
    const storage = getLocalStorage();
    try { storage?.removeItem(STORAGE_KEY); } catch { /* test cleanup is best-effort */ }
    try { window.sessionStorage.removeItem(PAGE_ID_KEY); } catch { /* test cleanup is best-effort */ }
  }
}
