/** The diagnostic wire format is an allowlist. Never add response bodies or raw errors. */
export const CONNECTION_TRACE_HEADER = "X-Agent-Web-Trace-ID";
export const CONNECTION_DIAGNOSTICS_ENDPOINT = "/api/diagnostics/connections";
export const CONNECTION_OPERATIONS = ["status_poll", "session_events", "session_read", "history_read", "session_handshake", "upstream", "authentication", "web_lifecycle"] as const;
export type ConnectionOperation = typeof CONNECTION_OPERATIONS[number];
export const CONNECTION_REASONS = ["authentication_required", "authentication_expired", "access_denied", "rate_limited", "request_timeout", "upstream_unavailable", "connection_refused", "connection_reset", "dns_error", "network_error", "invalid_response", "heartbeat_timeout", "startup_error", "http_error", "request_cancelled", "recovered", "service_start", "service_stop"] as const;
export type ConnectionReason = typeof CONNECTION_REASONS[number];
export interface ConnectionDiagnostic {
  version: 1;
  at: string;
  event: "failure" | "recovered" | "lifecycle";
  source: "browser" | "server" | "bridge";
  operation: ConnectionOperation;
  reason: ConnectionReason;
  route: string;
  traceId: string;
  engine?: "pi" | "codex";
  sessionId?: string;
  pageId?: string;
  status?: number;
  durationMs?: number;
  timeoutMs?: number;
  attempts?: number;
  outageMs?: number;
  online?: boolean;
  visibility?: "visible" | "hidden" | "prerender";
  errorName?: string;
  errorCode?: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SESSION = /^(?:codex:)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ROUTE_WORDS = new Set(["api", "agent", "running", "sessions", "context", "state", "events", "changes", "activity", "projects", "auth", "login", "messages", "history", "metadata", "settings", "health", "diagnostics", "connections", "entries", "turns", "hosts", "local", "queue", "models", "workspace", "workspaces", "files", "usage", "list", "read"]);
const ERROR_NAMES = new Set(["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "CodexBridgeError", "HistoryPageHttpError"]);
const ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "codex_timeout", "codex_connection_required", "codex_session_refresh"]);
export function safeTraceId(value: unknown): string | undefined { return typeof value === "string" && UUID.test(value) ? value : undefined; }
export function safeSessionId(value: unknown): string | undefined { return typeof value === "string" && SESSION.test(value) ? value : undefined; }
export function diagnosticRoute(url: string): string {
  try {
    const pathname = new URL(url, "http://local.invalid").pathname;
    if (!pathname.startsWith("/api/")) return "/other";
    return pathname.split("/").slice(0, 9).map(part => {
      if (!part) return "";
      if (part === ":id" || part === ":session") return part;
      return ROUTE_WORDS.has(part) ? part : ":id";
    }).join("/");
  } catch { return "/other"; }
}
export function sessionIdFromDiagnosticUrl(url: string): string | undefined {
  try {
    for (const part of new URL(url, "http://local.invalid").pathname.split("/")) {
      const id = safeSessionId(decodeURIComponent(part));
      if (id) return id;
    }
  } catch { /* an untrusted route is never diagnostic text */ }
}
export function connectionErrorFields(error: unknown): { errorName?: string; errorCode?: string } {
  if (!error || typeof error !== "object") return {};
  const value = error as { name?: unknown; code?: unknown; cause?: unknown };
  const cause = value.cause && typeof value.cause === "object" ? value.cause as { code?: unknown } : null;
  const code = ERROR_CODES.has(String(value.code)) ? value.code : cause?.code;
  return {
    ...(typeof value.name === "string" && ERROR_NAMES.has(value.name) ? { errorName: value.name } : {}),
    ...(typeof code === "string" && ERROR_CODES.has(code) ? { errorCode: code } : {}),
  };
}
export function connectionFailureReason(error: unknown, status?: number, timedOut = false): ConnectionReason {
  const fields = connectionErrorFields(error);
  if (status === 401) return "authentication_required";
  if (status === 403) return "access_denied";
  if (status === 429) return "rate_limited";
  if (timedOut || status === 408 || status === 504 || fields.errorName === "TimeoutError" || /TIMEOUT|ETIMEDOUT|codex_timeout/.test(fields.errorCode ?? "")) return "request_timeout";
  if (fields.errorCode === "ECONNREFUSED") return "connection_refused";
  if (fields.errorCode === "ECONNRESET" || fields.errorCode === "UND_ERR_SOCKET") return "connection_reset";
  if (fields.errorCode === "ENOTFOUND" || fields.errorCode === "EAI_AGAIN") return "dns_error";
  if (status === 502 || status === 503) return "upstream_unavailable";
  if (status && status >= 400) return "http_error";
  if (fields.errorName === "SyntaxError") return "invalid_response";
  if (fields.errorName === "AbortError") return "request_cancelled";
  return "network_error";
}
export function sanitizeConnectionDiagnostic(value: unknown): ConnectionDiagnostic | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value as Record<string, unknown>;
  if (!CONNECTION_OPERATIONS.includes(x.operation as ConnectionOperation) || !CONNECTION_REASONS.includes(x.reason as ConnectionReason)
    || !["browser", "server", "bridge"].includes(String(x.source)) || !["failure", "recovered", "lifecycle"].includes(String(x.event))
    || !safeTraceId(x.traceId) || typeof x.route !== "string" || x.route.length > 2048 || typeof x.at !== "string"
    || !/^\d{4}-\d{2}-\d{2}T/.test(x.at) || !Number.isFinite(Date.parse(x.at))) return null;
  const clean: ConnectionDiagnostic = { version: 1, at: new Date(x.at).toISOString(), event: x.event as ConnectionDiagnostic["event"],
    source: x.source as ConnectionDiagnostic["source"], operation: x.operation as ConnectionOperation,
    reason: x.reason as ConnectionReason, route: diagnosticRoute(x.route), traceId: x.traceId as string };
  if (x.engine === "pi" || x.engine === "codex") clean.engine = x.engine;
  const sid = safeSessionId(x.sessionId); if (sid) clean.sessionId = sid;
  const pageId = safeTraceId(x.pageId); if (pageId) clean.pageId = pageId;
  for (const key of ["durationMs", "timeoutMs", "attempts", "outageMs"] as const) {
    const v = x[key]; if (typeof v === "number" && Number.isFinite(v) && v >= 0) clean[key] = Math.min(Math.round(v), 7 * 86400_000);
  }
  if (typeof x.status === "number" && Number.isInteger(x.status) && x.status >= 100 && x.status <= 599) clean.status = x.status;
  if (typeof x.online === "boolean") clean.online = x.online;
  if (x.visibility === "visible" || x.visibility === "hidden" || x.visibility === "prerender") clean.visibility = x.visibility;
  if (typeof x.errorName === "string" && ERROR_NAMES.has(x.errorName)) clean.errorName = x.errorName;
  if (typeof x.errorCode === "string" && ERROR_CODES.has(x.errorCode)) clean.errorCode = x.errorCode;
  return clean;
}
