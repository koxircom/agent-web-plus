import "server-only";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { codexConnectionIdentity, isCodexSessionId } from "./execution-engine-settings";
import { executeBatchDelete, type BatchDeleteFrame, type BatchDeleteDoneFrame, type BatchDeleteRowResult } from "./session-batch-delete";

export type DeleteJobStatus = "running" | "completed" | "stopped" | "interrupted";
export type DeleteJobEvent = { seq: number; frame: BatchDeleteFrame };
type JobMeta = {
  schema: 1; id: string; ids: string[]; createdAt: string; ownerPid: number;
  ownerTicks: string | null; ownerRuntime: string; connectionIdentity?: string;
  interruptedAt?: string;
};
type Job = { meta: JobMeta; events: DeleteJobEvent[] };
export class DeleteJobError extends Error {
  readonly code = "session_delete_job_error";
  constructor(message: string, public status = 400) { super(message); }
}
/** Route bundles can share a global store while loading distinct Error constructors. */
export function deleteJobErrorStatus(error: unknown, fallback = 500): number {
  if (error && typeof error === "object" && "code" in error && error.code === "session_delete_job_error" && "status" in error) {
    const status = Number(error.status);
    if ([400, 404, 409, 422].includes(status)) return status;
  }
  return fallback;
}
const validJobId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(id);
export function validateDeleteJob(id: unknown, ids: unknown): asserts ids is string[] {
  if (!validJobId(id)) throw new DeleteJobError("删除任务标识无效");
  if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || ids.some(value =>
    typeof value !== "string" || !value.length || value.length > 200 || /[\/\\\0]/.test(value))) {
    throw new DeleteJobError("每个任务需提供 1 至 10000 个有效会话 ID");
  }
}
function ticks(pid: number) {
  try { return (stat => stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19])(readFileSync(`/proc/${pid}/stat`, "utf8")); }
  catch { return null; }
}
const ownerTicks = ticks(process.pid);
function doneFrame(job: Job): BatchDeleteDoneFrame | undefined {
  const last = job.events.at(-1)?.frame;
  return last?.type === "done" ? last : undefined;
}
function info(job: Job) {
  const done = doneFrame(job);
  const lastResult = [...job.events].reverse().find(event => event.frame.type === "result")?.frame;
  return { id: job.meta.id, createdAt: job.meta.createdAt, ids: [...job.meta.ids], total: job.meta.ids.length,
    status: (job.meta.interruptedAt ? "interrupted" : done ? (done.stopped ? "stopped" : "completed") : "running") as DeleteJobStatus,
    processed: done?.processed ?? (lastResult?.type === "result" ? lastResult.processed : 0),
    lastSequence: job.events.length };
}

/** One app process owns execution; files own intent and confirmed events. HTTP readers never own or cancel a job. */
export function createSessionDeleteJobStore(agentDir: string, dependencies: {
  execute?: typeof executeBatchDelete; identity?: typeof codexConnectionIdentity;
} = {}) {
  const directory = join(agentDir, "state", "session-delete-jobs");
  const active = new Map<string, Job>();
  const runtime = randomUUID();
  const execute = dependencies.execute ?? executeBatchDelete;
  const identity = dependencies.identity ?? codexConnectionIdentity;
  let queue: Promise<unknown> = Promise.resolve();
  const metaPath = (id: string) => join(directory, id + ".json");
  const eventPath = (id: string) => join(directory, id + ".ndjson");
  function append(job: Job, frame: BatchDeleteFrame) {
    const event = { seq: job.events.length + 1, frame };
    const fd = openSync(eventPath(job.meta.id), "a", 0o600);
    try { writeFileSync(fd, JSON.stringify(event) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
    job.events.push(event);
  }
  function saveMeta(job: Job) { writePrivateFileAtomicSync(metaPath(job.meta.id), JSON.stringify(job.meta)); }
  function recover(job: Job, message: string) {
    if (doneFrame(job)) return;
    const results = new Map<string, BatchDeleteRowResult>();
    const dispatched = new Set<string>();
    const deleted = new Set<string>();
    for (const { frame } of job.events) {
      if (frame.type === "item-start") dispatched.add(frame.id);
      if (frame.type === "result") {
        results.set(frame.result.id, frame.result);
        for (const id of frame.deletedSessionIds) deleted.add(id);
      }
    }
    if (!job.events.length) append(job, { type: "start", total: job.meta.ids.length });
    for (const id of job.meta.ids) {
      if (results.has(id)) continue;
      const result: BatchDeleteRowResult = { id, ok: false,
        state: dispatched.has(id) ? "unknown" : "not_started", error: message };
      results.set(id, result);
      if (dispatched.has(id)) append(job, { type: "result", total: job.meta.ids.length,
        processed: [...results.values()].filter(row => row.state !== "not_started").length,
        result, deletedSessionIds: [] });
    }
    job.meta.interruptedAt = new Date().toISOString();
    // The terminal event is authoritative even if the metadata update is interrupted.
    append(job, { type: "done", total: job.meta.ids.length,
      processed: [...results.values()].filter(row => row.state !== "not_started").length,
      results: job.meta.ids.map(id => results.get(id)!), deletedSessionIds: [...deleted], stopped: true });
    saveMeta(job);
  }
  function load(id: string): Job {
    if (!validJobId(id)) throw new DeleteJobError("删除任务标识无效");
    const live = active.get(id);
    if (live) return live;
    if (!existsSync(metaPath(id))) throw new DeleteJobError("删除任务不存在", 404);
    let meta: JobMeta, events: DeleteJobEvent[], completeBytes = 0, torn = false;
    try {
      meta = JSON.parse(readFileSync(metaPath(id), "utf8"));
      validateDeleteJob(meta.id, meta.ids);
      if (meta.id !== id || meta.schema !== 1) throw new Error("metadata mismatch");
      const text = existsSync(eventPath(id)) ? readFileSync(eventPath(id), "utf8") : "";
      completeBytes = Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1));
      torn = completeBytes !== Buffer.byteLength(text);
      const lines = text.split("\n"); lines.pop(); // Never admit a torn final journal record.
      events = lines.filter(Boolean).map((line, index) => {
        const event = JSON.parse(line) as DeleteJobEvent;
        if (event.seq !== index + 1 || !event.frame || typeof event.frame.type !== "string") throw new Error("event sequence mismatch");
        return event;
      });
    } catch { throw new DeleteJobError("删除任务记录暂时无法核对；没有重新派发删除", 422); }
    const job = { meta, events };
    if (!doneFrame(job)) {
      let alive = false;
      try { process.kill(meta.ownerPid, 0); alive = true; } catch { /* stopped owner */ }
      if (meta.ownerTicks && ticks(meta.ownerPid) !== meta.ownerTicks) alive = false;
      if (meta.ownerRuntime === runtime) alive = false; // Same runtime with no active owner: admission/execution failed.
      if (!alive) {
        // Remove only an incomplete tail owned by the stopped process before appending recovery.
        if (torn) {
          truncateSync(eventPath(id), completeBytes);
          const fd = openSync(eventPath(id), "r+");
          try { fsyncSync(fd); } finally { closeSync(fd); }
        }
        recover(job, "服务进程已中断；已派发项结果待核对，未派发项没有执行。不会自动重复删除。");
      }
    }
    return job;
  }
  async function run(job: Job, binding: Promise<string | undefined>) {
    const allResults = new Map<string, BatchDeleteRowResult>();
    const deleted = new Set<string>();
    let processed = 0, stopped = false;
    try {
      job.meta.connectionIdentity = await binding;
      saveMeta(job);
      for (let offset = 0; offset < job.meta.ids.length; offset += 100) {
        const chunk = job.meta.ids.slice(offset, offset + 100), before = processed;
        let storageFailure: unknown;
        const result = await execute(chunk, {
          origin: "api-batch", expectedCodexIdentity: job.meta.connectionIdentity, reconcileUncertainDeletes: true,
          onFrame(frame) {
            try {
            if (frame.type === "item-start") append(job, { ...frame, index: offset + frame.index, total: job.meta.ids.length });
            if (frame.type === "result") {
              append(job, { ...frame, processed: before + frame.processed, total: job.meta.ids.length });
              allResults.set(frame.result.id, frame.result);
              frame.deletedSessionIds.forEach(id => deleted.add(id));
            }
            return true;
            } catch (error) { storageFailure = error; return false; }
          },
        });
        if (storageFailure) throw storageFailure;
        for (const row of result.results) allResults.set(row.id, row);
        result.deletedSessionIds.forEach(id => deleted.add(id));
        processed = [...allResults.values()].filter(row => row.state !== "not_started").length;
        if (result.stopped) { stopped = true; break; }
      }
      const results = job.meta.ids.map(id => allResults.get(id) ?? {
        id, ok: false, state: "not_started" as const, error: "前序结果待核对，未派发此项",
      });
      append(job, { type: "done", total: job.meta.ids.length, processed,
        results, deletedSessionIds: [...deleted], stopped });
    } catch {
      // A persisted item-start without a persisted result stays unknown, never replayed.
      recover(job, "后台任务中断；请核对已派发项结果，未派发项没有执行。不会自动重复删除。");
    } finally { active.delete(job.meta.id); }
  }
  return {
    create(id: string, requested: string[]): ReturnType<typeof info> {
      validateDeleteJob(id, requested);
      const ids = [...new Set(requested)];
      if (existsSync(metaPath(id))) {
        const job = load(id);
        if (JSON.stringify(job.meta.ids) !== JSON.stringify(ids)) throw new DeleteJobError("同一删除任务标识不能用于不同会话", 409);
        return info(job);
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const job: Job = { meta: { schema: 1, id, ids, createdAt: new Date().toISOString(),
        ownerPid: process.pid, ownerTicks, ownerRuntime: runtime }, events: [] };
      try { writeFileSync(metaPath(id), JSON.stringify(job.meta), { flag: "wx", mode: 0o600, flush: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.create(id, requested);
        throw error;
      }
      append(job, { type: "start", total: ids.length });
      if (process.platform !== "win32") {
        const parent = openSync(directory, "r");
        try { fsyncSync(parent); } finally { closeSync(parent); }
      }
      active.set(id, job);
      // Capture the connection at admission, not after another queued job finishes.
      const binding = ids.some(isCodexSessionId) ? Promise.resolve().then(identity) : Promise.resolve(undefined);
      const admitted = binding.then(value => ({ value }), error => ({ error }));
      const task = queue.catch(() => {}).then(async () => {
        const result = await admitted;
        await run(job, "error" in result ? Promise.reject(result.error) : Promise.resolve(result.value));
      });
      queue = task.catch(() => {});
      return info(job);
    },
    get(id: string) { return info(load(id)); },
    events(id: string, after = 0) {
      const job = load(id);
      if (!Number.isSafeInteger(after) || after < 0 || after > job.events.length) throw new DeleteJobError("删除进度游标无效", 409);
      return { ...info(job), frames: job.events.slice(after, after + 256) };
    },
    list() {
      if (!existsSync(directory)) return [];
      return readdirSync(directory).filter(name => name.endsWith(".json")).map(name => info(load(name.slice(0, -5)))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
    },
  };
}
type Store = ReturnType<typeof createSessionDeleteJobStore>;
const storesKey = Symbol.for("pi-web.session-delete-job-stores");
const globals = globalThis as unknown as Record<symbol, Map<string, Store> | undefined>;
export function getSessionDeleteJobs() {
  const stores = globals[storesKey] ??= new Map<string, Store>();
  const root = getAgentDir();
  if (!stores.has(root)) stores.set(root, createSessionDeleteJobStore(root));
  return stores.get(root)!;
}
