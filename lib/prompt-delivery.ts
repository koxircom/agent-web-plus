import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PendingPromptSubmission } from "./prompt-submissions";

export type PromptReceipt =
  | { status: "pending" | "accepted" | "unconfirmed" | "unknown" }
  | { status: "committed"; entryId?: string }
  | { status: "cancelled" }
  | { status: "recalled"; reason?: "runtime_exit" }
  | { status: "rejected"; error: string };
type RecordEntry = { fingerprint: string; receipt: PromptReceipt; at: number; command?: Record<string, unknown>; entryId?: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const isTerminal = (status: PromptReceipt["status"]) => ["committed", "rejected", "cancelled", "recalled"].includes(status);

/** Most acknowledgements concern the just-appended user entry. Read its tail
 * first; oversized/older entries fall back to a streaming read, never a
 * synchronous allocation and parse of the entire transcript on the server. */
async function syncNativeUserEntry(filePath: string, entryId: string): Promise<void> {
  // Windows FlushFileBuffers requires a writable handle. r+ never creates,
  // truncates or changes content; Linux keeps its existing read-only handle.
  const file = await open(filePath, process.platform === "win32" ? "r+" : "r");
  const matches = (line: string) => {
    try {
      const entry = JSON.parse(line);
      return entry.id === entryId && entry.type === "message" && entry.message?.role === "user";
    } catch { return false; }
  };
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 64 * 1024);
    const buffer = Buffer.allocUnsafe(size - start);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // never interpret a partial first line
    let found = lines.some(matches);
    if (!found && start > 0) {
      const decoder = new StringDecoder("utf8");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let position = 0, pendingLine = "";
      while (!found && position < size) {
        const read = await file.read(chunk, 0, Math.min(chunk.length, size - position), position);
        if (!read.bytesRead) break;
        position += read.bytesRead;
        pendingLine += decoder.write(chunk.subarray(0, read.bytesRead));
        let newline: number;
        while ((newline = pendingLine.indexOf("\n")) !== -1) {
          if (matches(pendingLine.slice(0, newline))) { found = true; break; }
          pendingLine = pendingLine.slice(newline + 1);
        }
      }
      if (!found) found = matches(pendingLine + decoder.end());
    }
    if (!found) throw new Error("Prompt has not reached the session file");
    await file.sync();
  } finally { await file.close(); }
}
export function validPromptRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{16,80}$/.test(value);
}

/** A private inbox, separate from the SDK transcript. Save before execution;
 * uncertain deliveries are never replayed, expired or erased by a restart. */
export function createPromptDeliveryStore(agentDir: string) {
  const root = join(agentDir, "state", "prompt-deliveries-v1");
  const records = new Map<string, Map<string, RecordEntry>>();
  const flights = new Map<string, Promise<unknown>>();
  const committing = new Set<string>();
  const listeners = new Map<string, Set<(requestId: string, receipt: PromptReceipt) => void>>();
  const directory = (sid: string) => join(root, digest(sid));
  const filename = (sid: string, requestId: string) => join(directory(sid), `${digest(requestId)}.json`);
  function session(sid: string) {
    let rows = records.get(sid);
    if (rows) return rows;
    rows = new Map();
    const dir = directory(sid);
    if (existsSync(dir)) for (const file of readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const saved = JSON.parse(readFileSync(join(dir, file), "utf8")) as RecordEntry & { requestId: string };
      if (!validPromptRequestId(saved.requestId) || !saved.receipt || typeof saved.fingerprint !== "string") throw new Error("Invalid saved prompt receipt");
      // Terminal records contain only identity/fingerprint/receipt. Keep these
      // small tombstones so a delayed offline client can never replay a prompt.
      rows.set(saved.requestId, saved);
    }
    records.set(sid, rows);
    return rows;
  }
  function save(sid: string, requestId: string, row: RecordEntry) {
    const dir = directory(sid);
    const firstCreated = mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (firstCreated && process.platform !== "win32") {
      // Persist each newly created directory's parent link too.
      for (let current = dir; ; current = dirname(current)) {
        const d = openSync(dirname(current), "r"); try { fsyncSync(d); } finally { closeSync(d); }
        if (current === firstCreated) break;
      }
    }
    const target = filename(sid, requestId), temp = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ ...row, requestId })); fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      renameSync(temp, target);
      // Directory fsync is supported on the deployed Linux host. Windows cannot
      // open directories this way, but still gets atomic replacement and file fsync.
      if (process.platform !== "win32") { const d = openSync(dir, "r"); try { fsyncSync(d); } finally { closeSync(d); } }
    } finally { if (existsSync(temp)) unlinkSync(temp); }
    session(sid).set(requestId, row);
    for (const listener of listeners.get(sid) ?? []) {
      try { listener(requestId, row.receipt); } catch { /* Delivery observers cannot roll back a durable write. */ }
    }
  }
  const receipt = (sid: string, requestId: string): PromptReceipt => session(sid).get(requestId)?.receipt ?? { status: "unknown" };
  async function commit(sid: string, requestId: string, evidence: { sessionFile: string; entryId: string } | { handled: true }) {
    const row = session(sid).get(requestId);
    if (!row || isTerminal(row.receipt.status)) return;
    const id = JSON.stringify([sid, requestId]);
    committing.add(id);
    try {
      let entryId: string | undefined;
      if ("entryId" in evidence) {
        entryId = evidence.entryId;
        // Presentation identity is known after the SDK append. This is not a
        // committed acknowledgement: the existing fsync gate below still owns it.
        row.entryId = entryId;
        // Identity comes from the live SDK's persisted entry, never matching text.
        await syncNativeUserEntry(evidence.sessionFile, entryId);
      }
      if (isTerminal(session(sid).get(requestId)!.receipt.status)) return;
      save(sid, requestId, { fingerprint: row.fingerprint, at: row.at, receipt: { status: "committed", ...(entryId ? { entryId } : {}) } });
    } finally { committing.delete(id); }
  }
  function accept(sid: string, requestId: string) {
    const row = session(sid).get(requestId);
    if (row?.receipt.status === "pending") save(sid, requestId, { ...row, receipt: { status: "accepted" } });
  }
  function unconfirmed(sid: string, requestId: string) {
    const row = session(sid).get(requestId);
    if (!row || isTerminal(row.receipt.status)) return;
    save(sid, requestId, { ...row, receipt: { status: "unconfirmed" } });
  }
  function cancel(sid: string, requestId: string) {
    const row = session(sid).get(requestId);
    if (!row || isTerminal(row.receipt.status)) return;
    save(sid, requestId, { fingerprint: row.fingerprint, at: row.at, receipt: { status: "cancelled" } });
  }
  function pending(sid: string): PendingPromptSubmission[] {
    return [...session(sid)].flatMap<PendingPromptSubmission>(([requestId, row]) => row.command && (!isTerminal(row.receipt.status) || row.receipt.status === "recalled")
      ? [{ requestId, sessionId: sid, message: String(row.command.message ?? ""),
        images: row.command.images as PendingPromptSubmission["images"], createdAt: row.at,
        ...(row.receipt.status === "recalled" && row.receipt.reason ? { recoveryReason: row.receipt.reason } : {}),
        status: row.receipt.status === "recalled" ? "recalled" as const : row.receipt.status === "accepted" ? "accepted" as const : row.receipt.status === "unconfirmed" ? "unconfirmed" as const : "sending" as const,
        ...(row.command.streamingBehavior === "steer" || row.command.streamingBehavior === "followUp" ? { streamingBehavior: row.command.streamingBehavior } : {}),
      }] : []).sort((a, b) => a.createdAt - b.createdAt);
  }
  function recall(sid: string, requestId: string, reason?: "runtime_exit") {
    const row = session(sid).get(requestId);
    if (!row || isTerminal(row.receipt.status)) return;
    save(sid, requestId, { ...row, receipt: { status: "recalled", ...(reason ? { reason } : {}) } });
  }
  /** A dead SDK queue cannot progress. Transfer its original to the existing
   * recall/durable-draft handshake, never back to execute(). Flight and fsync
   * ownership cover admission and the gap before the native user receipt.
   * No age timeout: even an old live request retains its owner. */
  function recoverInterrupted(sid: string, isActive: (requestId: string) => boolean) {
    for (const [requestId, row] of session(sid)) {
      if (isTerminal(row.receipt.status)
        || !["steer", "followUp"].includes(String(row.command?.streamingBehavior))) continue;
      const id = JSON.stringify([sid, requestId]);
      if (flights.has(id) || committing.has(id) || isActive(requestId)) continue;
      recall(sid, requestId, "runtime_exit");
    }
  }
  function acknowledgeRecall(sid: string, requestId: string) {
    const row = session(sid).get(requestId);
    if (row?.receipt.status !== "recalled") return;
    save(sid, requestId, { fingerprint: row.fingerprint, at: row.at, receipt: { status: "cancelled" } });
  }
  function run(sid: string, requestId: string, command: Record<string, unknown>, execute: () => Promise<unknown>): Promise<unknown> {
    const rows = session(sid), fingerprint = digest(JSON.stringify([command.message, command.images ?? [], command.streamingBehavior ?? null, command.toolNames ?? null]));
    const id = JSON.stringify([sid, requestId]), existing = rows.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(new Error("Prompt request ID already belongs to another submission"));
      if (flights.has(id)) return flights.get(id)!;
      // HTTP retries acknowledge the durable admission, never execute again.
      if (existing.receipt.status === "rejected") return Promise.reject(new Error(existing.receipt.error));
      return Promise.resolve(null);
    }
    if ([...rows.values()].filter(row => row.command).length >= 512) return Promise.reject(new Error("Too many pending prompts; submission was not sent"));
    const row: RecordEntry = { fingerprint, receipt: { status: "pending" }, at: Date.now(), command };
    // This failure is before execution and can safely restore the draft.
    save(sid, requestId, row);
    const result = Promise.resolve().then(execute).then(value => {
      const latest = rows.get(requestId)!;
      if (latest.receipt.status === "pending") save(sid, requestId, { ...latest, receipt: { status: "accepted" } });
      return value;
    }, error => {
      const latest = rows.get(requestId)!;
      if (!isTerminal(latest.receipt.status)) {
        const uncertain = error && typeof error === "object" && "deliveryUncertain" in error && error.deliveryUncertain === true;
        save(sid, requestId, uncertain
          ? { ...latest, receipt: { status: "unconfirmed" } }
          : { ...latest, receipt: { status: "rejected", error: error instanceof Error ? error.message : String(error) }, command: undefined });
      }
      throw error;
    }).finally(() => { flights.delete(id); });
    flights.set(id, result);
    return result;
  }
  const isCommitting = (sid: string, requestId: string) => committing.has(JSON.stringify([sid, requestId]));
  const entryIds = (sid: string): Record<string, string> => Object.fromEntries([...session(sid)].flatMap(([requestId, row]) => {
    const entryId = row.receipt.status === "committed" ? row.receipt.entryId : row.entryId;
    return entryId && !["cancelled", "recalled", "rejected"].includes(row.receipt.status) ? [[requestId, entryId]] : [];
  }));
  function subscribe(sid: string, listener: (requestId: string, receipt: PromptReceipt) => void) {
    let group = listeners.get(sid);
    if (!group) listeners.set(sid, group = new Set());
    group.add(listener);
    return () => { group.delete(listener); if (!group.size) listeners.delete(sid); };
  }
  return { run, receipt, commit, accept, isCommitting, unconfirmed, cancel, recall, acknowledgeRecall, pending, entryIds, subscribe, recoverInterrupted };
}
const key = Symbol.for("pi-web:durable-prompt-delivery-v1");
const registry = globalThis as typeof globalThis & { [key]?: ReturnType<typeof createPromptDeliveryStore> };
function store() { return registry[key] ??= createPromptDeliveryStore(getAgentDir()); }
export const getPromptReceipt = (sid: string, requestId: string) => store().receipt(sid, requestId);
export const getPromptEntryIds = (sid: string) => store().entryIds(sid);
export const isPromptDeliveryCommitting = (sid: string, requestId: string) => store().isCommitting(sid, requestId);
export const getUncommittedPromptSubmissions = (sid: string) => store().pending(sid);
export const acceptPromptDelivery = (sid: string, requestId: string) => store().accept(sid, requestId);
export const markPromptDeliveryUnconfirmed = (sid: string, requestId: string) => store().unconfirmed(sid, requestId);
export const cancelPromptDelivery = (sid: string, requestId: string) => store().cancel(sid, requestId);
export const recallPromptDelivery = (sid: string, requestId: string) => store().recall(sid, requestId);
export const acknowledgeRecalledPromptDelivery = (sid: string, requestId: string) => store().acknowledgeRecall(sid, requestId);
export const commitPromptDelivery = (sid: string, requestId: string, evidence: Parameters<ReturnType<typeof createPromptDeliveryStore>["commit"]>[2]) => store().commit(sid, requestId, evidence);
export const runPromptDelivery = (sid: string, requestId: string, command: Record<string, unknown>, execute: () => Promise<unknown>) => store().run(sid, requestId, command, execute);

export const subscribePromptDeliveries = (sid: string, listener: (requestId: string, receipt: PromptReceipt) => void) => store().subscribe(sid, listener);

export const recoverInterruptedPiPrompts = (sid: string, isActive: (requestId: string) => boolean) => store().recoverInterrupted(sid, isActive);
