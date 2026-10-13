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
const listeners = new Set<() => void>();
const EMPTY: PendingPromptSubmission[] = [];
let submissions: PendingPromptSubmission[] = EMPTY;
let restored = false;
// Only protects in-flight snapshots in this tab; server receipts remain durable.
const settledRequestIds = new Set<string>();

function storage(): Storage | null {
  // Tab-scoped: refreshing preserves submissions without another tab claiming them.
  return typeof window === "undefined" ? null : window.sessionStorage;
}
function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return;
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return;
    submissions = rows.filter((r): r is PendingPromptSubmission => Boolean(r
      && typeof r.requestId === "string" && typeof r.sessionId === "string"
      && typeof r.message === "string" && typeof r.createdAt === "number"
      && (r.status === "sending" || r.status === "confirming" || r.status === "unconfirmed" || r.status === "uncertain" || r.status === "accepted" || r.status === "recalled")
      && (r.images === undefined || (Array.isArray(r.images) && r.images.every((i: { data?: unknown; mimeType?: unknown }) => i && typeof i.data === "string" && typeof i.mimeType === "string")))))
      .map((row) => ({ ...row, status: (row.status as string) === "confirming" ? "accepted" : row.status }));
  } catch { /* Keep the original stored bytes; do not silently overwrite them. */ }
}
function commit(next: PendingPromptSubmission[]): void {
  const store = storage();
  if (store) {
    if (next.length) store.setItem(STORAGE_KEY, JSON.stringify(next));
    else store.removeItem(STORAGE_KEY);
  }
  submissions = next;
  for (const listener of listeners) listener();
}
export function getPendingPromptSubmissions(): PendingPromptSubmission[] {
  restore();
  return submissions;
}
export const getServerPendingPromptSubmissions = () => EMPTY;
export function subscribePendingPromptSubmissions(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function retainPromptSubmission(row: PendingPromptSubmission): void {
  restore();
  if (submissions.length >= 20) throw new Error("未确认消息过多，请先确认已保留的消息。");
  commit([...submissions, row]);
}
export function markPromptSubmissionUncertain(requestId: string): void {
  restore();
  const next = submissions.map((row) => row.requestId === requestId && row.status !== "unconfirmed" && row.status !== "recalled" ? { ...row, status: "uncertain" as const } : row);
  // The original durable copy was saved before dispatch. Never discard it if a later write fails.
  try { commit(next); } catch { submissions = next; for (const listener of listeners) listener(); }
}
export function releasePromptSubmission(requestId: string): void {
  restore();
  settledRequestIds.add(requestId);
  // Snapshot reads have an 8s deadline. Bound the tab's recent terminal IDs;
  // they are not a second persistent receipt store.
  if (settledRequestIds.size > 512) settledRequestIds.delete(settledRequestIds.values().next().value!);
  const next = submissions.filter((row) => row.requestId !== requestId);
  if (next.length === submissions.length) return;
  try { commit(next); } catch { submissions = next; for (const listener of listeners) listener(); }
}

export function markPromptSubmissionsRecalled(requestIds: string[], restored = false): void {
  restore();
  const ids = new Set(requestIds);
  commit(submissions.map(row => ids.has(row.requestId)
    ? { ...row, status: "recalled" as const, recallRestored: row.recallRestored || restored } : row));
}

/** One receipt transition for HTTP, SSE, reconciliation and refresh.
 * Accepted is normal admission; only an actual failure/orphan needs recovery. */
export function reconcilePromptSubmission(requestId: string, receipt: {
  status: string; inFlight?: boolean;
}): void {
  restore();
  if (receipt.status === "committed" || receipt.status === "cancelled") {
    releasePromptSubmission(requestId);
    return;
  }
  const current = submissions.find(row => row.requestId === requestId);
  if (!current || current.status === "recalled") return;
  let status = current.status;
  if (receipt.status === "unconfirmed") status = "unconfirmed";
  else if (current.status !== "unconfirmed") {
    if (receipt.status === "accepted") status = receipt.inFlight === false ? "uncertain" : "accepted";
    else if (receipt.status === "unknown" || (receipt.status === "pending" && receipt.inFlight === false)) status = "uncertain";
  }
  if (status === current.status) return;
  const next = submissions.map(row => row.requestId === requestId ? { ...row, status } : row);
  try { commit(next); } catch { submissions = next; for (const listener of listeners) listener(); }
}

/** Backups are silent during normal delivery, including after reload. */
export function needsPromptRecovery(row: PendingPromptSubmission): boolean {
  return row.status === "uncertain" || row.status === "unconfirmed" || row.status === "recalled";
}

/** Server inbox fills a fresh tab using the existing state read; never sends. */
export function mergeServerPromptSubmissions(rows: PendingPromptSubmission[]): void {
  restore();
  const existing = new Set(submissions.map(row => row.requestId));
  const missing = rows.filter(row => !existing.has(row.requestId) && !settledRequestIds.has(row.requestId));
  if (!missing.length) return;
  const next = [...submissions, ...missing];
  try { commit(next); } catch { submissions = next; for (const listener of listeners) listener(); }
}
