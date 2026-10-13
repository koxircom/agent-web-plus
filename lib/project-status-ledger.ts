import { randomUUID } from "node:crypto";
type State = "running" | "idle" | "ended" | "failed" | "stopped";
type Execution = { sessionId: string; state: State; runId: string };
type Pending = { sessionId: string; pendingRequests: { id: string; method: string }[] };
// Actual SDK run receipts survive idle wrapper eviction, bounded to 500 ended runs.
export class ProjectStatusLedger {
  private readonly epoch = randomUUID();
  private revision = 0;
  private signature = "";
  private executions = new Map<string, Execution>();
  begin(sessionId: string): void {
    this.executions.delete(sessionId);
    this.executions.set(sessionId, { sessionId, state: "running", runId: randomUUID() });
  }
  finish(sessionId: string, stopReason?: string, suppressed = false): void {
    const current = this.executions.get(sessionId);
    if (!current || current.state !== "running") return;
    current.state = stopReason === "aborted" ? "stopped" : stopReason === "error" ? "failed" : suppressed ? "idle" : "ended";
    const ended = [...this.executions.values()].filter(item => item.state !== "running");
    for (const item of ended.slice(0, Math.max(0, ended.length - 500))) this.executions.delete(item.sessionId);
  }
  forget(sessionId: string): void { this.executions.delete(sessionId); }
  snapshot(runningIds: string[], pending: Pending[]) {
    const running = new Set(runningIds);
    const executions = [...this.executions.values()].map(item => ({ ...item, state: running.has(item.sessionId) ? "running" as const : item.state === "running" ? "idle" as const : item.state }));
    for (const id of running) if (!this.executions.has(id)) executions.push({ sessionId: id, state: "running", runId: "" });
    const sessions = pending.filter(item => item.pendingRequests.length > 0).map(item => ({ sessionId: item.sessionId, pendingRequests: item.pendingRequests.map(request => ({ ...request })) }));
    const signature = JSON.stringify([executions, sessions]);
    if (signature !== this.signature) { this.signature = signature; this.revision++; }
    return { statusSnapshot: { version: 1, epoch: this.epoch, revision: this.revision, executions }, interactionState: { version: 1, sessions } };
  }
}
