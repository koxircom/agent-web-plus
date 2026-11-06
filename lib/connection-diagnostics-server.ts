import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  CONNECTION_TRACE_HEADER, connectionErrorFields, connectionFailureReason, diagnosticRoute,
  safeTraceId, sanitizeConnectionDiagnostic, sessionIdFromDiagnosticUrl,
  type ConnectionDiagnostic, type ConnectionOperation,
} from "./connection-diagnostics.ts";

export const CONNECTION_LOG_MAX_BYTES = 2 * 1024 * 1024;
export const CONNECTION_LOG_ARCHIVES = 2;
type RequestContext = { traceId: string; route: string; sessionId?: string; engine?: "pi" | "codex"; operation: ConnectionOperation };
type LogState = { context: AsyncLocalStorage<RequestContext>; recent: Map<string, { at: number; reason: string; suppressed: number }>; warned: boolean };
const key = Symbol.for("pi-web.connection-diagnostics");
const globalState = globalThis as unknown as Record<symbol, LogState>;
const state = globalState[key] ??= { context: new AsyncLocalStorage<RequestContext>(), recent: new Map(), warned: false };

export function connectionLogPath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  const directory = process.env.PI_WEB_DIAGNOSTICS_DIR || join(agentDir, "logs", "connections");
  return join(directory, `${hostname().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "host"}.jsonl`);
}
export function currentConnectionDiagnosticContext(): RequestContext | undefined { return state.context.getStore(); }
function buildId(): string | undefined {
  try { const value = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim(); return /^[\w-]{1,80}$/.test(value) ? value : undefined; }
  catch { return undefined; }
}
export function appendConnectionDiagnostic(input: unknown): boolean {
  const event = sanitizeConnectionDiagnostic(input);
  if (!event) return false;
  try {
    const now = Date.now();
    const dedupeKey = [connectionLogPath(), event.source, event.pageId ?? "", event.operation, event.route, event.engine ?? "", event.sessionId ?? "", event.status ?? ""].join("|");
    const previous = state.recent.get(dedupeKey);
    if (event.event === "failure" && previous?.reason === event.reason && now - previous.at < 15_000) {
      previous.suppressed++; return true;
    }
    const line = JSON.stringify({ ...event, receivedAt: new Date(now).toISOString(),
      server: { pid: process.pid, version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown", buildId: buildId() },
      ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}) }) + "\n";
    const path = connectionLogPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > CONNECTION_LOG_MAX_BYTES) {
      if (existsSync(`${path}.${CONNECTION_LOG_ARCHIVES}`)) unlinkSync(`${path}.${CONNECTION_LOG_ARCHIVES}`);
      for (let i = CONNECTION_LOG_ARCHIVES - 1; i >= 1; i--) if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
    state.recent.delete(dedupeKey);
    state.recent.set(dedupeKey, { at: now, reason: event.reason, suppressed: 0 });
    if (state.recent.size > 256) state.recent.delete(state.recent.keys().next().value!);
    return true;
  } catch {
    if (!state.warned) { state.warned = true; console.warn("[pi-web] Connection diagnostic log could not be written; request handling continues."); }
    return false;
  }
}
export function readConnectionDiagnostics(limit = 100): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  const path = connectionLogPath();
  for (let i = CONNECTION_LOG_ARCHIVES; i >= 0; i--) {
    const file = i ? `${path}.${i}` : path;
    try {
      // Read only our own bounded log files, never an arbitrary browser path.
      if (statSync(file).size > CONNECTION_LOG_MAX_BYTES + 8192) continue;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try { const row = JSON.parse(line); if (sanitizeConnectionDiagnostic(row)) events.push(row); } catch { /* partial last append */ }
      }
    } catch { /* a new installation or concurrent rotation has no history yet */ }
  }
  return events.slice(-Math.max(1, Math.min(10_000, limit)));
}
function operationForUrl(url: URL): ConnectionOperation {
  if (url.pathname === "/api/agent/running") return "status_poll";
  if (url.pathname.endsWith("/events")) return "session_events";
  if (url.pathname.endsWith("/context")) return "history_read";
  return "session_read";
}
export function connectionRequestContext(request: Request): RequestContext {
  const url = new URL(request.url);
  const sessionId = sessionIdFromDiagnosticUrl(request.url);
  const requested = url.searchParams.get("engine");
  const engine = requested === "pi" || requested === "codex" ? requested : sessionId?.startsWith("codex:") ? "codex" : sessionId ? "pi" : undefined;
  return { traceId: safeTraceId(request.headers.get(CONNECTION_TRACE_HEADER)) ?? randomUUID(), route: diagnosticRoute(request.url), sessionId,
    engine, operation: operationForUrl(url) };
}
export function logConnectionRequestFailure(request: Request, status: number, reason?: ConnectionDiagnostic["reason"]): void {
  if (!/^\/api\/(?:agent|sessions)(?:\/|$)/.test(new URL(request.url).pathname)) return;
  const context = connectionRequestContext(request);
  appendConnectionDiagnostic({ ...context, version: 1, at: new Date().toISOString(), event: "failure", source: "server", operation: "authentication",
    status, reason: reason ?? connectionFailureReason(null, status) });
}
/** Preserve each route's response/error contract while correlating its failures with the browser. */
export async function withConnectionDiagnostics(request: Request, handler: () => Promise<Response>): Promise<Response> {
  const context = connectionRequestContext(request);
  const started = performance.now();
  return state.context.run(context, async () => {
    try {
      const response = await handler();
      response.headers.set(CONNECTION_TRACE_HEADER, context.traceId);
      if (response.status >= 400 && response.status !== 409) appendConnectionDiagnostic({ ...context, version: 1, at: new Date().toISOString(), event: "failure", source: "server",
        status: response.status, reason: connectionFailureReason(null, response.status), durationMs: performance.now() - started });
      return response;
    } catch (error) {
      // Navigation/tab closure is expected. The bridge records a caller deadline separately.
      if (!request.signal.aborted) {
        const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
        appendConnectionDiagnostic({ ...context, version: 1, at: new Date().toISOString(), event: "failure", source: "server", status,
          reason: connectionFailureReason(error, status), durationMs: performance.now() - started, ...connectionErrorFields(error) });
      }
      throw error;
    }
  });
}

/** Called from the existing Node startup/shutdown owner, never a second process watcher. */
export function logConnectionLifecycle(reason: "service_start" | "service_stop"): void {
  appendConnectionDiagnostic({ version: 1, at: new Date().toISOString(), source: "server", event: "lifecycle", operation: "web_lifecycle", reason,
    route: "/api", traceId: randomUUID() });
}
