export interface PendingPromptSubmission {
  requestId: string;
  sessionId: string;
  message: string;
  images?: Array<{ data: string; mimeType: string }>;
  status: "sending" | "uncertain" | "accepted" | "unconfirmed" | "recalled";
  recallRestored?: boolean;
  streamingBehavior?: "steer" | "followUp";
  createdAt: number;
}

export interface PromptSubmissionPreviewIdentity {
  requestId: string;
  sessionId: string;
  draftKey: string | undefined;
}

/** Presentation-only deduplication; never modifies durable submissions. */
export function visiblePromptSubmissions(
  rows: PendingPromptSubmission[],
  preview: PromptSubmissionPreviewIdentity | null,
  sessionId: string | null,
  draftKey: string | undefined,
): PendingPromptSubmission[] {
  return rows.filter((row) => !(row.status === "sending" && row.streamingBehavior
    && preview?.requestId === row.requestId && preview.sessionId === row.sessionId
    && preview.sessionId === sessionId && preview.draftKey === draftKey));
}

const STORAGE_KEY = "pi-web:unconfirmed-prompts-v1";
const TAB_KEY = "pi-web:prompt-submissions-tab-v1";
const DB_NAME = "pi-web-prompt-submissions-v1";
const STORE_NAME = "submissions";
const MAX_SUBMISSIONS = 20;
const listeners = new Set<() => void>();
const EMPTY: PendingPromptSubmission[] = [];
let submissions: PendingPromptSubmission[] = EMPTY;
let restored = false;
let ready: Promise<void> = Promise.resolve();
let backend: "opening" | "indexeddb" | "storage" | "blocked" = "opening";
let tabId: string | null = null;
let database: IDBDatabase | null = null;
let legacyStorage: Storage | null = null;
let legacyHasInvalidRows = false;
let writeQueue: Promise<void> = Promise.resolve();
const settledRequestIds = new Set<string>();
// Server inbox records already have a durable owner. Keep their originals, but
// do not charge restored history against the cap on locally unacknowledged POSTs.
const serverRetainedRequestIds = new Set<string>();
const localAdmissionCount = () => submissions.filter((row) => !serverRetainedRequestIds.has(row.requestId)).length;

// Mutations can arrive while IndexedDB is restoring. Preserve them as small
// per-ID overlays, then apply them after the disk snapshot is read.
const pendingDeletes = new Set<string>();
const pendingRows = new Map<string, PendingPromptSubmission>();
const pendingStatuses = new Map<string, Pick<PendingPromptSubmission, "status" | "recallRestored">>();

function storage(): Storage | null {
  try {
    // Tab-scoped. sessionStorage keeps the scope stable over refresh without
    // making another open tab claim this tab's pending submissions.
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function validRow(value: unknown): PendingPromptSubmission | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const status = row.status === "confirming" ? "accepted" : row.status;
  if (typeof row.requestId !== "string" || !row.requestId
      || typeof row.sessionId !== "string" || typeof row.message !== "string"
      || typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt)
      || !(status === "sending" || status === "accepted" || status === "unconfirmed"
        || status === "uncertain" || status === "recalled")
      || (row.images !== undefined && (!Array.isArray(row.images)
        || !row.images.every((image: unknown) => Boolean(image && typeof image === "object"
          && typeof (image as { data?: unknown }).data === "string"
          && typeof (image as { mimeType?: unknown }).mimeType === "string"))))) return null;
  return { ...row, status } as PendingPromptSubmission;
}

function readLegacy(store: Storage | null): { raw: string | null; rows: PendingPromptSubmission[]; invalid: boolean } {
  if (!store) return { raw: null, rows: [], invalid: false };
  let raw: string | null;
  try { raw = store.getItem(STORAGE_KEY); } catch { return { raw: null, rows: [], invalid: true }; }
  if (!raw) return { raw, rows: [], invalid: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { raw, rows: [], invalid: true };
    const rows = parsed.map(validRow).filter((row): row is PendingPromptSubmission => row !== null);
    return { raw, rows, invalid: rows.length !== parsed.length };
  } catch {
    return { raw, rows: [], invalid: true };
  }
}

function getTabId(store: Storage | null): string | null {
  if (!store) return null;
  try {
    const existing = store.getItem(TAB_KEY);
    if (existing) return existing;
    const generated = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    store.setItem(TAB_KEY, generated);
    return store.getItem(TAB_KEY) === generated ? generated : null;
  } catch {
    return null;
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let done = false;
    const finish = (db: IDBDatabase | null) => {
      if (done) { db?.close(); return; }
      done = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => finish(null), 3000);
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
          store.createIndex("tabId", "tabId", { unique: false });
        }
      };
      request.onsuccess = () => finish(request.result);
      request.onerror = request.onblocked = () => finish(null);
    } catch {
      finish(null);
    }
  });
}

function entryKey(id: string, requestId: string): string { return `${id}:${requestId}`; }

function runTransaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => void,
): Promise<T | void> {
  return new Promise((resolve, reject) => {
    let failure: Error | null = null;
    let tx: IDBTransaction | null = null;
    try {
      tx = db.transaction(STORE_NAME, mode);
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = tx.onabort = () => reject(failure ?? new Error("Prompt backup transaction failed"));
      work(tx);
    } catch {
      try { tx?.abort(); } catch { reject(new Error("Prompt backup transaction failed")); }
      if (!tx) reject(new Error("Prompt backup transaction failed"));
    }
  });
}

function writeEntry(db: IDBDatabase, id: string, row: PendingPromptSubmission): Promise<void> {
  return runTransaction(db, "readwrite", (tx) => {
    tx.objectStore(STORE_NAME).put({ key: entryKey(id, row.requestId), tabId: id, ...row });
  }).then(() => undefined);
}

function deleteEntry(db: IDBDatabase, id: string, requestId: string): Promise<void> {
  return runTransaction(db, "readwrite", (tx) => {
    tx.objectStore(STORE_NAME).delete(entryKey(id, requestId));
  }).then(() => undefined);
}

function readEntries(db: IDBDatabase, id: string): Promise<PendingPromptSubmission[]> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readonly");
      tx.onabort = tx.onerror = () => reject(new Error("Prompt backup read failed"));
      const request = tx.objectStore(STORE_NAME).index("tabId").getAll(id);
      request.onsuccess = () => {
        const rows = (request.result as Array<Record<string, unknown>>)
          .map(({ key: _key, tabId: _tabId, ...row }) => validRow(row))
          .filter((row): row is PendingPromptSubmission => row !== null);
        resolve(rows);
      };
      request.onerror = () => reject(new Error("Prompt backup read failed"));
    } catch {
      reject(new Error("Prompt backup read failed"));
    }
  });
}

function writeFallback(rows: PendingPromptSubmission[]): void {
  const store = legacyStorage ?? storage();
  if (!store) throw new Error("Prompt backup unavailable");
  try {
    if (rows.length) store.setItem(STORAGE_KEY, JSON.stringify(rows));
    else store.removeItem(STORAGE_KEY);
  } catch {
    // Never pass the browser's raw quota/security error to logs or callers.
    throw new Error("Prompt backup unavailable");
  }
}

function notify(): void { for (const listener of listeners) listener(); }

function rememberChanges(previous: PendingPromptSubmission[], next: PendingPromptSubmission[]): void {
  const oldRows = new Map(previous.map((row) => [row.requestId, row]));
  const nextRows = new Map(next.map((row) => [row.requestId, row]));
  for (const id of oldRows.keys()) {
    if (!nextRows.has(id)) {
      pendingDeletes.add(id);
      pendingRows.delete(id);
      pendingStatuses.delete(id);
    }
  }
  for (const [id, row] of nextRows) {
    const old = oldRows.get(id);
    if (!old) {
      pendingDeletes.delete(id);
      pendingRows.set(id, row);
      continue;
    }
    if (old.status !== row.status || old.recallRestored !== row.recallRestored) {
      pendingStatuses.set(id, { status: row.status, recallRestored: row.recallRestored });
    }
  }
}

function persistChanges(previous: PendingPromptSubmission[], next: PendingPromptSubmission[]): void {
  if (backend === "opening") {
    rememberChanges(previous, next);
    return;
  }
  if (backend === "storage") {
    writeFallback(next);
    return;
  }
  if (backend !== "indexeddb" || !database || !tabId) return;
  const oldRows = new Map(previous.map((row) => [row.requestId, row]));
  const nextRows = new Map(next.map((row) => [row.requestId, row]));
  const removals = [...oldRows.keys()].filter((id) => !nextRows.has(id));
  const writes = [...nextRows.values()].filter((row) => {
    const old = oldRows.get(row.requestId);
    return !old || old.status !== row.status || old.recallRestored !== row.recallRestored;
  });
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    for (const id of removals) await deleteEntry(database!, tabId!, id);
    for (const row of writes) await writeEntry(database!, tabId!, row);
  }).catch(() => {
    // The last completed row transaction remains durable; an update failure
    // cannot remove or replace that backup. Receipt reconciliation retries it.
  });
}

function commit(next: PendingPromptSubmission[]): void {
  const previous = submissions;
  // In the Web Storage fallback, the complete replacement must succeed before
  // publishing a new snapshot. IDB mutations are per-row and never rewrite all
  // large image payloads as a single collection.
  if (backend === "storage") writeFallback(next);
  submissions = next;
  if (backend !== "storage") persistChanges(previous, next);
  notify();
}

function applyOverlays(rows: PendingPromptSubmission[]): PendingPromptSubmission[] {
  const merged = new Map(rows.map((row) => [row.requestId, row]));
  for (const id of pendingDeletes) merged.delete(id);
  for (const [id, status] of pendingStatuses) {
    const row = merged.get(id);
    if (row) merged.set(id, { ...row, ...status });
  }
  for (const [id, row] of pendingRows) if (!merged.has(id)) merged.set(id, row);
  for (const id of settledRequestIds) merged.delete(id);
  return [...merged.values()];
}

function startRestore(): void {
  if (restored) return;
  restored = true;
  legacyStorage = storage();
  const legacy = readLegacy(legacyStorage);
  legacyHasInvalidRows = legacy.invalid;
  submissions = legacy.rows;

  // Without IDB, the complete Web Storage write remains a safe tab-scoped
  // fallback. It can reject large payloads, in which case the caller must not POST.
  if (typeof indexedDB === "undefined") {
    backend = "storage";
    return;
  }

  tabId = getTabId(legacyStorage);
  if (!tabId) {
    backend = "blocked";
    return;
  }

  ready = (async () => {
    const db = await openDatabase();
    if (!db) {
      // An installed but unavailable/blocked database may contain submissions
      // that sessionStorage cannot enumerate. Refuse new sends rather than
      // silently treating that partial snapshot as complete.
      backend = "blocked";
      notify();
      return;
    }
    database = db;
    try {
      if (legacy.raw && legacy.rows.length) {
        // Migrate row-by-row. The legacy full copy stays intact until every
        // transaction has completed, so a partial migration is repeatable.
        for (const row of legacy.rows) await writeEntry(db, tabId!, row);
      }
      const diskRows = await readEntries(db, tabId!);
      submissions = applyOverlays(diskRows);
      backend = legacyHasInvalidRows ? "blocked" : "indexeddb";
      if (legacy.raw && !legacyHasInvalidRows) {
        try { legacyStorage?.removeItem(STORAGE_KEY); } catch { /* IDB now owns the complete rows. */ }
      }
      if (backend === "indexeddb" && (pendingDeletes.size || pendingRows.size || pendingStatuses.size)) {
        const removals = [...pendingDeletes];
        const writes = [...pendingRows.values()];
        const statuses = [...pendingStatuses.entries()];
        pendingDeletes.clear(); pendingRows.clear(); pendingStatuses.clear();
        try {
          for (const id of removals) await deleteEntry(db, tabId!, id);
          for (const row of writes) await writeEntry(db, tabId!, row);
          for (const [id, status] of statuses) {
            const row = submissions.find((item) => item.requestId === id);
            if (row) await writeEntry(db, tabId!, { ...row, ...status });
          }
        } catch { /* The previous durable rows stay intact; receipts reconcile on refresh. */ }
      }
    } catch {
      backend = "blocked";
      submissions = applyOverlays(legacy.rows);
    }
    notify();
  })();
}

export async function waitForPromptSubmissionRestore(): Promise<void> {
  startRestore();
  await ready;
}

export function getPendingPromptSubmissions(): PendingPromptSubmission[] {
  startRestore();
  return submissions;
}
export const getServerPendingPromptSubmissions = () => EMPTY;
export function subscribePendingPromptSubmissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function retentionError(): Error {
  return new Error("Prompt backup could not be confirmed");
}

function retainInIndexedDb(row: PendingPromptSubmission): Promise<void> {
  const db = database;
  const id = tabId;
  if (!db || !id) return Promise.reject(retentionError());
  return new Promise((resolve, reject) => {
    let full = false;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(full ? new Error("Prompt queue is full") : retentionError());
      const store = tx.objectStore(STORE_NAME);
      const count = store.index("tabId").getAllKeys(id);
      count.onsuccess = () => {
        const localDiskCount = count.result.filter((key) => typeof key !== "string"
          || !serverRetainedRequestIds.has(key.slice(id.length + 1))).length;
        if (localDiskCount >= MAX_SUBMISSIONS || localAdmissionCount() >= MAX_SUBMISSIONS) {
          full = true;
          try { tx.abort(); } catch { reject(new Error("Prompt queue is full")); }
          return;
        }
        try {
          store.put({ key: entryKey(id, row.requestId), tabId: id, ...row });
        } catch {
          // A synchronous structured-clone/quota failure must abort cleanly;
          // throwing from the IDB callback would surface as an uncaught pageerror.
          try { tx.abort(); } catch { reject(retentionError()); }
        }
      };
      count.onerror = () => { try { tx.abort(); } catch { reject(retentionError()); } };
    } catch {
      reject(retentionError());
    }
  });
}

/** Resolves only after the full backup has committed to IDB or Web Storage. */
export async function retainPromptSubmission(row: PendingPromptSubmission): Promise<void> {
  startRestore();
  await ready;
  // Let prior receipt-driven deletes settle before checking the 20-item limit.
  await writeQueue;
  if (localAdmissionCount() >= MAX_SUBMISSIONS) throw new Error("Prompt queue is full");

  if (backend === "storage") {
    const next = [...submissions, row];
    writeFallback(next);
    submissions = next;
    notify();
    return;
  }

  if (backend !== "indexeddb") throw retentionError();
  try {
    await retainInIndexedDb(row);
  } catch (error) {
    if (error instanceof Error && error.message === "Prompt queue is full") throw error;
    // Rebuild from the current snapshot after the async transaction has failed:
    // a concurrent release/status update must not be overwritten by a stale copy.
    if (localAdmissionCount() >= MAX_SUBMISSIONS) throw new Error("Prompt queue is full");
    const fallbackNext = submissions.some((item) => item.requestId === row.requestId)
      ? submissions : [...submissions, row];
    writeFallback(fallbackNext);
    submissions = fallbackNext;
    notify();
    return;
  }

  // Other receipts and concurrent retains can mutate state while IDB commits.
  // Add this exact row onto the latest snapshot instead of restoring an old array.
  if (!submissions.some((item) => item.requestId === row.requestId)) submissions = [...submissions, row];
  notify();
}

export function markPromptSubmissionUncertain(requestId: string): void {
  startRestore();
  const next = submissions.map((row) => row.requestId === requestId && row.status !== "unconfirmed" && row.status !== "recalled" ? { ...row, status: "uncertain" as const } : row);
  try { commit(next); } catch { submissions = next; notify(); }
}
export function releasePromptSubmission(requestId: string): void {
  startRestore();
  settledRequestIds.add(requestId);
  serverRetainedRequestIds.delete(requestId);
  // Snapshot reads have an 8s deadline. Bound the tab's recent terminal IDs;
  // they are not a second persistent receipt store.
  if (settledRequestIds.size > 512) settledRequestIds.delete(settledRequestIds.values().next().value!);
  const next = submissions.filter((row) => row.requestId !== requestId);
  if (next.length === submissions.length) return;
  try { commit(next); } catch { submissions = next; notify(); }
}

export function markPromptSubmissionsRecalled(requestIds: string[], restored = false): void {
  startRestore();
  const ids = new Set(requestIds);
  try {
    commit(submissions.map((row) => ids.has(row.requestId)
      ? { ...row, status: "recalled" as const, recallRestored: row.recallRestored || restored } : row));
  } catch {
    submissions = submissions.map((row) => ids.has(row.requestId)
      ? { ...row, status: "recalled" as const, recallRestored: row.recallRestored || restored } : row);
    notify();
  }
}

/** One receipt transition for HTTP, SSE, reconciliation and refresh.
 * Accepted is normal admission; only an actual failure/orphan needs recovery. */
export function reconcilePromptSubmission(requestId: string, receipt: {
  status: string; inFlight?: boolean;
}): void {
  startRestore();
  if (receipt.status === "committed" || receipt.status === "cancelled") {
    releasePromptSubmission(requestId);
    return;
  }
  const current = submissions.find((row) => row.requestId === requestId);
  if (!current) return;
  if (["pending", "accepted", "unconfirmed", "recalled"].includes(receipt.status)) serverRetainedRequestIds.add(requestId);
  if (current.status === "recalled") return;
  let status = current.status;
  if (receipt.status === "unconfirmed") status = "unconfirmed";
  else if (current.status !== "unconfirmed") {
    if (receipt.status === "accepted") status = receipt.inFlight === false ? "uncertain" : "accepted";
    else if (receipt.status === "unknown" || (receipt.status === "pending" && receipt.inFlight === false)) status = "uncertain";
  }
  if (status === current.status) return;
  const next = submissions.map((row) => row.requestId === requestId ? { ...row, status } : row);
  try { commit(next); } catch { submissions = next; notify(); }
}

/** Backups are silent during normal delivery, including after reload. */
export function needsPromptRecovery(row: PendingPromptSubmission): boolean {
  return row.status === "uncertain" || row.status === "unconfirmed" || row.status === "recalled";
}

/** Server inbox fills a fresh tab using the existing state read; never sends. */
export function mergeServerPromptSubmissions(rows: PendingPromptSubmission[]): void {
  startRestore();
  for (const row of rows) if (!settledRequestIds.has(row.requestId)) serverRetainedRequestIds.add(row.requestId);
  const existing = new Set(submissions.map((row) => row.requestId));
  const missing = rows.filter((row) => !existing.has(row.requestId) && !settledRequestIds.has(row.requestId));
  if (!missing.length) return;
  try { commit([...submissions, ...missing]); }
  catch { submissions = [...submissions, ...missing]; notify(); }
}
