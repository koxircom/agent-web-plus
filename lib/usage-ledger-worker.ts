import { Worker } from "node:worker_threads";
import path from "node:path";
import { resolveUsageGuardBinDir } from "./usage-delete-guard";
import type { UsageLedgerMode } from "./usage-ledger-service";

type Result = { body: Uint8Array<ArrayBuffer>; compressed?: Uint8Array<ArrayBuffer>; mode: UsageLedgerMode; status: number };
type Pending = { resolve: (result: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

export function createUsageLedgerWorker(options: { scriptPath?: string; timeoutMs?: number } = {}) {
  let worker: Worker | null = null;
  let sequence = 0;
  const pending = new Map<number, Pending>();
  const flights = new Map<boolean, Promise<Result>>();

  function stop(error: Error, target = worker) {
    if (!target || worker !== target) return;
    worker = null;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(error); }
    pending.clear();
    void target.terminate();
  }

  function ensureWorker() {
    if (worker) return worker;
    const target = new Worker(options.scriptPath ?? path.join(resolveUsageGuardBinDir(), "usage-ledger-worker.mjs"));
    worker = target;
    target.on("message", (message: Result & { id: number }) => {
      if (worker !== target) return;
      const task = pending.get(message?.id);
      if (!task) return;
      pending.delete(message.id);
      clearTimeout(task.timer);
      if (!(message.body instanceof Uint8Array) || ![200, 503].includes(message.status)
          || !["native-local", "legacy-central"].includes(message.mode)
          || (message.compressed !== undefined && !(message.compressed instanceof Uint8Array))) {
        task.reject(new Error("Invalid usage worker response"));
      } else task.resolve({ body: message.body, compressed: message.compressed, mode: message.mode, status: message.status });
      if (pending.size === 0) target.unref();
    });
    target.on("error", error => stop(error instanceof Error ? error : new Error("Usage snapshot worker failed"), target));
    target.on("exit", () => stop(new Error("Usage worker exited before completing the snapshot"), target));
    target.unref();
    return target;
  }

  function read(refresh = false): Promise<Result> {
    const existing = flights.get(refresh);
    if (existing) return existing;
    const flight = new Promise<Result>((resolve, reject) => {
      let target: Worker;
      try { target = ensureWorker(); } catch (error) { reject(error); return; }
      const id = ++sequence;
      const timer = setTimeout(() => stop(new Error("Usage snapshot worker timed out"), target), options.timeoutMs ?? 240_000);
      pending.set(id, { resolve, reject, timer });
      target.ref();
      try { target.postMessage({ id, refresh }); }
      catch (error) { stop(error instanceof Error ? error : new Error("Unable to dispatch usage snapshot"), target); }
    }).finally(() => { if (flights.get(refresh) === flight) flights.delete(refresh); });
    flights.set(refresh, flight);
    return flight;
  }

  return { read, close: () => stop(new Error("Usage snapshot worker closed")) };
}

const key = Symbol.for("pi-web.usage-ledger-worker");
const globals = globalThis as unknown as Record<symbol, ReturnType<typeof createUsageLedgerWorker> | undefined>;
export function readUsageLedgerResponse(refresh = false) {
  return (globals[key] ??= createUsageLedgerWorker()).read(refresh);
}
