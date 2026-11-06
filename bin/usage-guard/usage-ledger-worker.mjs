import { createRequire as workerCreateRequire } from "node:module"; const require = workerCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key3 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key3) && key3 !== except)
        __defProp(to, key3, { get: () => from[key3], enumerable: !(desc = __getOwnPropDesc(from, key3)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// scripts/usage-worker-server-only.cjs
var require_usage_worker_server_only = __commonJS({
  "scripts/usage-worker-server-only.cjs"(exports, module) {
    "use strict";
    module.exports = {};
  }
});

// lib/execution-engine-settings.ts
var execution_engine_settings_exports = {};
__export(execution_engine_settings_exports, {
  codexConnectionIdentity: () => codexConnectionIdentity,
  codexThreadId: () => codexThreadId,
  isCodexSessionId: () => isCodexSessionId,
  publicExecutionEngineSettings: () => publicExecutionEngineSettings,
  readExecutionEngineSettings: () => readExecutionEngineSettings,
  saveExecutionEngineSettings: () => saveExecutionEngineSettings
});
import { getAgentDir as getAgentDir2 } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join as join2 } from "node:path";
import { randomUUID, createHash } from "node:crypto";
async function readExecutionEngineSettings() {
  try {
    const value = JSON.parse(await readFile(join2(getAgentDir2(), "execution-engines.json"), "utf8"));
    return { ...defaults, ...value, codex: { ...defaults.codex, ...value.codex } };
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(defaults);
    throw error;
  }
}
function publicExecutionEngineSettings(value) {
  const { password, ...codex } = value.codex;
  return { defaultEngine: value.defaultEngine, codex: { ...codex, hasPassword: Boolean(password) } };
}
async function saveExecutionEngineSettings(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("\u6267\u884C\u5F15\u64CE\u914D\u7F6E\u683C\u5F0F\u4E0D\u6B63\u786E");
  const input = body;
  if (Object.keys(input).some((k) => !["defaultEngine", "codex"].includes(k))) throw new Error("\u672A\u77E5\u6267\u884C\u5F15\u64CE\u914D\u7F6E\u5B57\u6BB5");
  const current = await readExecutionEngineSettings();
  if (input.defaultEngine !== void 0) {
    if (input.defaultEngine !== "pi" && input.defaultEngine !== "codex") throw new Error("\u6267\u884C\u5F15\u64CE\u4E0D\u53D7\u652F\u6301");
    current.defaultEngine = input.defaultEngine;
  }
  if (input.codex !== void 0) {
    if (!input.codex || typeof input.codex !== "object" || Array.isArray(input.codex)) throw new Error("Codex \u914D\u7F6E\u683C\u5F0F\u4E0D\u6B63\u786E");
    const codex = input.codex;
    if (Object.keys(codex).some((k) => !["enabled", "url", "username", "password", "clearPassword"].includes(k))) throw new Error("\u672A\u77E5 Codex \u914D\u7F6E\u5B57\u6BB5");
    for (const key3 of ["url", "username", "password"]) {
      if (codex[key3] !== void 0 && typeof codex[key3] !== "string") throw new Error("Codex \u914D\u7F6E\u5E94\u4E3A\u6587\u672C");
      if (typeof codex[key3] === "string" && (key3 !== "password" || codex[key3])) current.codex[key3] = codex[key3];
    }
    if (codex.enabled !== void 0) {
      if (typeof codex.enabled !== "boolean") throw new Error("\u542F\u7528\u72B6\u6001\u4E0D\u6B63\u786E");
      current.codex.enabled = codex.enabled;
    }
    if (codex.clearPassword !== void 0 && typeof codex.clearPassword !== "boolean") throw new Error("\u6E05\u9664\u5BC6\u7801\u72B6\u6001\u4E0D\u6B63\u786E");
    if (current.codex.username.length > 200 || current.codex.password.length > 1e3 || current.codex.url.length > 2048) throw new Error("\u8FDE\u63A5\u914D\u7F6E\u5185\u5BB9\u8FC7\u957F");
    if (codex.clearPassword === true) current.codex.password = "";
  }
  if (current.codex.url) {
    const url = new URL(current.codex.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("\u8BF7\u8F93\u5165\u4E0D\u542B\u51ED\u636E\u3001\u53C2\u6570\u548C\u7247\u6BB5\u7684 HTTP(S) \u670D\u52A1\u5730\u5740");
    current.codex.url = url.href.replace(/\/$/, "");
  }
  if (current.defaultEngine === "codex" && (!current.codex.enabled || !current.codex.url)) throw new Error("\u8BF7\u5148\u542F\u7528\u5E76\u914D\u7F6E Codex \u670D\u52A1");
  await mkdir(getAgentDir2(), { recursive: true, mode: 448 });
  const file = join2(getAgentDir2(), "execution-engines.json");
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(current, null, 2), { mode: 384, flag: "wx" });
  await rename(temporary, file);
  return publicExecutionEngineSettings(current);
}
function codexThreadId(id) {
  if (!isCodexSessionId(id)) throw new Error("Codex \u4F1A\u8BDD\u6807\u8BC6\u4E0D\u6B63\u786E");
  return id.slice(6);
}
async function codexConnectionIdentity() {
  return createHash("sha256").update(JSON.stringify((await readExecutionEngineSettings()).codex)).digest("hex");
}
var import_server_only, defaults, isCodexSessionId;
var init_execution_engine_settings = __esm({
  "lib/execution-engine-settings.ts"() {
    "use strict";
    import_server_only = __toESM(require_usage_worker_server_only());
    defaults = {
      defaultEngine: "pi",
      codex: { enabled: false, url: "", username: "", password: "" }
    };
    isCodexSessionId = (id) => /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
  }
});

// lib/connection-diagnostics.ts
function safeTraceId(value) {
  return typeof value === "string" && UUID.test(value) ? value : void 0;
}
function safeSessionId(value) {
  return typeof value === "string" && SESSION.test(value) ? value : void 0;
}
function diagnosticRoute(url) {
  try {
    const pathname = new URL(url, "http://local.invalid").pathname;
    if (!pathname.startsWith("/api/")) return "/other";
    return pathname.split("/").slice(0, 9).map((part) => {
      if (!part) return "";
      if (part === ":id" || part === ":session") return part;
      return ROUTE_WORDS.has(part) ? part : ":id";
    }).join("/");
  } catch {
    return "/other";
  }
}
function sessionIdFromDiagnosticUrl(url) {
  try {
    for (const part of new URL(url, "http://local.invalid").pathname.split("/")) {
      const id = safeSessionId(decodeURIComponent(part));
      if (id) return id;
    }
  } catch {
  }
}
function connectionErrorFields(error) {
  if (!error || typeof error !== "object") return {};
  const value = error;
  const cause = value.cause && typeof value.cause === "object" ? value.cause : null;
  const code = ERROR_CODES.has(String(value.code)) ? value.code : cause?.code;
  return {
    ...typeof value.name === "string" && ERROR_NAMES.has(value.name) ? { errorName: value.name } : {},
    ...typeof code === "string" && ERROR_CODES.has(code) ? { errorCode: code } : {}
  };
}
function connectionFailureReason(error, status, timedOut = false) {
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
function sanitizeConnectionDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const x = value;
  if (!CONNECTION_OPERATIONS.includes(x.operation) || !CONNECTION_REASONS.includes(x.reason) || !["browser", "server", "bridge"].includes(String(x.source)) || !["failure", "recovered", "lifecycle"].includes(String(x.event)) || !safeTraceId(x.traceId) || typeof x.route !== "string" || x.route.length > 2048 || typeof x.at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(x.at) || !Number.isFinite(Date.parse(x.at))) return null;
  const clean = {
    version: 1,
    at: new Date(x.at).toISOString(),
    event: x.event,
    source: x.source,
    operation: x.operation,
    reason: x.reason,
    route: diagnosticRoute(x.route),
    traceId: x.traceId
  };
  if (x.engine === "pi" || x.engine === "codex") clean.engine = x.engine;
  const sid = safeSessionId(x.sessionId);
  if (sid) clean.sessionId = sid;
  const pageId = safeTraceId(x.pageId);
  if (pageId) clean.pageId = pageId;
  for (const key3 of ["durationMs", "timeoutMs", "attempts", "outageMs"]) {
    const v = x[key3];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) clean[key3] = Math.min(Math.round(v), 7 * 864e5);
  }
  if (typeof x.status === "number" && Number.isInteger(x.status) && x.status >= 100 && x.status <= 599) clean.status = x.status;
  if (typeof x.online === "boolean") clean.online = x.online;
  if (x.visibility === "visible" || x.visibility === "hidden" || x.visibility === "prerender") clean.visibility = x.visibility;
  if (typeof x.errorName === "string" && ERROR_NAMES.has(x.errorName)) clean.errorName = x.errorName;
  if (typeof x.errorCode === "string" && ERROR_CODES.has(x.errorCode)) clean.errorCode = x.errorCode;
  return clean;
}
var CONNECTION_TRACE_HEADER, CONNECTION_OPERATIONS, CONNECTION_REASONS, UUID, SESSION, ROUTE_WORDS, ERROR_NAMES, ERROR_CODES;
var init_connection_diagnostics = __esm({
  "lib/connection-diagnostics.ts"() {
    "use strict";
    CONNECTION_TRACE_HEADER = "X-Agent-Web-Trace-ID";
    CONNECTION_OPERATIONS = ["status_poll", "session_events", "session_read", "history_read", "session_handshake", "upstream", "authentication", "web_lifecycle"];
    CONNECTION_REASONS = ["authentication_required", "authentication_expired", "access_denied", "rate_limited", "request_timeout", "upstream_unavailable", "connection_refused", "connection_reset", "dns_error", "network_error", "invalid_response", "heartbeat_timeout", "startup_error", "http_error", "request_cancelled", "recovered", "service_start", "service_stop"];
    UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    SESSION = /^(?:codex:)?[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    ROUTE_WORDS = /* @__PURE__ */ new Set(["api", "agent", "running", "sessions", "context", "state", "events", "changes", "activity", "projects", "auth", "login", "messages", "history", "metadata", "settings", "health", "diagnostics", "connections", "entries", "turns", "hosts", "local", "queue", "models", "workspace", "workspaces", "files", "usage", "list", "read"]);
    ERROR_NAMES = /* @__PURE__ */ new Set(["Error", "TypeError", "SyntaxError", "AbortError", "TimeoutError", "CodexBridgeError", "HistoryPageHttpError"]);
    ERROR_CODES = /* @__PURE__ */ new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "codex_timeout", "codex_connection_required", "codex_session_refresh"]);
  }
});

// lib/connection-diagnostics-server.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, chmodSync, existsSync as existsSync2, mkdirSync, readFileSync as readFileSync3, renameSync, statSync as statSync2, unlinkSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname as dirname2, join as join3 } from "node:path";
function connectionLogPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join3(homedir(), ".pi", "agent");
  const directory = process.env.PI_WEB_DIAGNOSTICS_DIR || join3(agentDir, "logs", "connections");
  return join3(directory, `${hostname().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "host"}.jsonl`);
}
function currentConnectionDiagnosticContext() {
  return state.context.getStore();
}
function buildId() {
  try {
    const value = readFileSync3(join3(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
    return /^[\w-]{1,80}$/.test(value) ? value : void 0;
  } catch {
    return void 0;
  }
}
function appendConnectionDiagnostic(input) {
  const event = sanitizeConnectionDiagnostic(input);
  if (!event) return false;
  try {
    const now = Date.now();
    const dedupeKey = [connectionLogPath(), event.source, event.pageId ?? "", event.operation, event.route, event.engine ?? "", event.sessionId ?? "", event.status ?? ""].join("|");
    const previous = state.recent.get(dedupeKey);
    if (event.event === "failure" && previous?.reason === event.reason && now - previous.at < 15e3) {
      previous.suppressed++;
      return true;
    }
    const line = JSON.stringify({
      ...event,
      receivedAt: new Date(now).toISOString(),
      server: { pid: process.pid, version: process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown", buildId: buildId() },
      ...previous?.suppressed ? { suppressed: previous.suppressed } : {}
    }) + "\n";
    const path4 = connectionLogPath();
    mkdirSync(dirname2(path4), { recursive: true, mode: 448 });
    if (existsSync2(path4) && statSync2(path4).size + Buffer.byteLength(line) > CONNECTION_LOG_MAX_BYTES) {
      if (existsSync2(`${path4}.${CONNECTION_LOG_ARCHIVES}`)) unlinkSync(`${path4}.${CONNECTION_LOG_ARCHIVES}`);
      for (let i = CONNECTION_LOG_ARCHIVES - 1; i >= 1; i--) if (existsSync2(`${path4}.${i}`)) renameSync(`${path4}.${i}`, `${path4}.${i + 1}`);
      renameSync(path4, `${path4}.1`);
    }
    appendFileSync(path4, line, { encoding: "utf8", mode: 384 });
    chmodSync(path4, 384);
    state.recent.delete(dedupeKey);
    state.recent.set(dedupeKey, { at: now, reason: event.reason, suppressed: 0 });
    if (state.recent.size > 256) state.recent.delete(state.recent.keys().next().value);
    return true;
  } catch {
    if (!state.warned) {
      state.warned = true;
      console.warn("[pi-web] Connection diagnostic log could not be written; request handling continues.");
    }
    return false;
  }
}
var CONNECTION_LOG_MAX_BYTES, CONNECTION_LOG_ARCHIVES, key, globalState, state;
var init_connection_diagnostics_server = __esm({
  "lib/connection-diagnostics-server.ts"() {
    "use strict";
    init_connection_diagnostics();
    CONNECTION_LOG_MAX_BYTES = 2 * 1024 * 1024;
    CONNECTION_LOG_ARCHIVES = 2;
    key = /* @__PURE__ */ Symbol.for("pi-web.connection-diagnostics");
    globalState = globalThis;
    state = globalState[key] ??= { context: new AsyncLocalStorage(), recent: /* @__PURE__ */ new Map(), warned: false };
  }
});

// lib/execution-engines/codex-bridge-client.ts
var codex_bridge_client_exports = {};
__export(codex_bridge_client_exports, {
  CodexBridgeError: () => CodexBridgeError,
  codexBridgeJson: () => codexBridgeJson,
  codexBridgeRequest: () => codexBridgeRequest
});
import { createHash as createHash2, randomUUID as randomUUID2 } from "node:crypto";
function waitForSharedFlight(flight, signal) {
  if (!signal) return flight;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.then(() => {
      cleanup();
      resolve();
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
}
async function codexBridgeRequest(path4, body, options) {
  if (!path4.startsWith("/api/") || path4.includes("\\")) throw new Error("\u65E0\u6548 Codex \u670D\u52A1\u8DEF\u5F84");
  const config = (await readExecutionEngineSettings()).codex;
  if (!config.enabled || !config.url) throw new CodexBridgeError("Codex \u5F15\u64CE\u5C1A\u672A\u542F\u7528\u6216\u914D\u7F6E", 409, "codex_connection_required");
  const signature = createHash2("sha256").update(JSON.stringify(config)).digest("hex");
  if (options?.connectionIdentity && options.connectionIdentity !== signature) throw new CodexBridgeError("\u6267\u884C\u7AEF\u914D\u7F6E\u5DF2\u6539\u53D8\uFF0C\u8BF7\u91CD\u65B0\u6253\u5F00\u4F1A\u8BDD", 409, "codex_session_refresh");
  let connection = globals[key2];
  if (!connection || connection.signature !== signature) globals[key2] = connection = { signature, cookie: "", csrf: "", generation: 0 };
  const endpoint = config.url;
  const origin = new URL(endpoint).origin;
  const target = connection;
  const request = async (route, value, binary, requestSignal = options?.signal, timeout = options?.timeout ?? (route.includes("/changes?") ? 2e4 : route.includes("/settings") ? 15e3 : 1e4)) => {
    const headers = { Origin: origin };
    const parent = currentConnectionDiagnosticContext();
    const traceId = parent?.traceId ?? randomUUID2();
    headers[CONNECTION_TRACE_HEADER] = traceId;
    const started = performance.now();
    const logFailure = (error, status, cancelled = false) => appendConnectionDiagnostic({
      version: 1,
      at: (/* @__PURE__ */ new Date()).toISOString(),
      source: "bridge",
      event: "failure",
      operation: "upstream",
      engine: "codex",
      traceId,
      sessionId: parent?.sessionId ?? sessionIdFromDiagnosticUrl(route),
      route: diagnosticRoute(route),
      status,
      reason: cancelled ? "request_cancelled" : connectionFailureReason(error, status),
      durationMs: performance.now() - started,
      timeoutMs: timeout,
      ...connectionErrorFields(error)
    });
    if (target.cookie) headers.Cookie = target.cookie;
    if (value !== void 0 || binary) {
      headers["Content-Type"] = binary ? options?.contentType || "application/octet-stream" : "application/json";
      if (target.csrf) headers["X-CSRF-Token"] = target.csrf;
    }
    try {
      const response2 = await fetch(endpoint + route, {
        method: value !== void 0 || binary ? "POST" : "GET",
        headers,
        body: binary ? Buffer.from(binary) : value !== void 0 ? JSON.stringify(value) : void 0,
        cache: "no-store",
        redirect: "error",
        signal: requestSignal ? AbortSignal.any([requestSignal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
      });
      if (!response2.ok) logFailure(null, response2.status);
      return response2;
    } catch (error) {
      if (requestSignal?.aborted) {
        logFailure(error, 499, true);
        throw requestSignal.reason ?? error;
      }
      const isTimeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" && !requestSignal?.aborted);
      logFailure(error, isTimeout ? 504 : 502);
      if (isTimeout) {
        if (value !== void 0 || binary) {
          throw new CodexBridgeError(
            "Codex \u64CD\u4F5C\u54CD\u5E94\u8D85\u65F6\uFF0C\u5F53\u524D\u8BBE\u7F6E\u672A\u5728\u65F6\u9650\u5185\u786E\u8BA4\u751F\u6548\uFF1B\u5199\u64CD\u4F5C\u672A\u81EA\u52A8\u91CD\u53D1\uFF0C\u8BF7\u5237\u65B0\u6838\u5BF9",
            504,
            "codex_timeout",
            void 0,
            false
          );
        }
        throw new CodexBridgeError("Codex \u8BF7\u6C42\u54CD\u5E94\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u5237\u65B0\u91CD\u8BD5", 504, "codex_timeout", void 0, true);
      }
      throw new CodexBridgeError("Codex \u6267\u884C\u7AEF\u6682\u65F6\u4E0D\u53EF\u8FBE\uFF1BPi \u5F15\u64CE\u53EF\u7EE7\u7EED\u4F7F\u7528", 502, "codex_connection_required", void 0, true);
    }
  };
  const authenticate = async () => {
    if (target.csrf) return;
    if (!target.flight) target.flight = (async () => {
      {
        const response3 = await request("/api/login", { username: config.username, password: config.password }, void 0, null, 1e4);
        if (!response3.ok) throw new CodexBridgeError("Codex \u670D\u52A1\u767B\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8FDE\u63A5\u914D\u7F6E", response3.status, "codex_connection_required");
        target.cookie = response3.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; ");
      }
      const response2 = await request("/api/auth", void 0, void 0, null, 1e4);
      if (!response2.ok) throw new CodexBridgeError("\u65E0\u6CD5\u6838\u5BF9 Codex \u670D\u52A1\u8BA4\u8BC1", response2.status, "codex_connection_required");
      const auth = await response2.json();
      if (auth.authenticated === false) throw new CodexBridgeError("Codex \u670D\u52A1\u9700\u8981\u6709\u6548\u8BA4\u8BC1", 401, "codex_connection_required");
      target.csrf = auth.csrf || "anonymous";
      target.generation++;
    })().finally(() => {
      target.flight = void 0;
    });
    await waitForSharedFlight(target.flight, options?.signal);
  };
  await authenticate();
  let generation = target.generation;
  let response = await request(path4, body, options?.bytes);
  if (response.status === 401) {
    if (target.generation === generation && !target.flight) {
      target.csrf = "";
      target.cookie = "";
    }
    if (body === void 0 && !options?.bytes) {
      await response.body?.cancel();
      await authenticate();
      generation = target.generation;
      response = await request(path4);
    }
  }
  if (!response.ok) {
    if (response.status === 401 && target.generation === generation && !target.flight) {
      target.csrf = "";
      target.cookie = "";
    }
    const result = await response.json().catch(() => ({}));
    throw new CodexBridgeError(
      result.error || "Codex \u670D\u52A1\u672A\u5B8C\u6210\u64CD\u4F5C",
      response.status,
      result.code,
      result.dispatched,
      response.status >= 500 || response.status === 408 || response.status === 429
    );
  }
  return response;
}
async function codexBridgeJson(path4, body, options) {
  return (await codexBridgeRequest(path4, body, options)).json();
}
var import_server_only2, key2, globals, CodexBridgeError;
var init_codex_bridge_client = __esm({
  "lib/execution-engines/codex-bridge-client.ts"() {
    "use strict";
    import_server_only2 = __toESM(require_usage_worker_server_only());
    init_connection_diagnostics_server();
    init_connection_diagnostics();
    init_execution_engine_settings();
    key2 = /* @__PURE__ */ Symbol.for("pi-web.codex-bridge-connection");
    globals = globalThis;
    CodexBridgeError = class extends Error {
      constructor(message, status = 502, code, dispatched, retryable = status >= 500 || status === 408 || status === 429) {
        super(message);
        this.status = status;
        this.code = code;
        this.dispatched = dispatched;
        this.retryable = retryable;
      }
    };
  }
});

// lib/usage-ledger-worker-entry.ts
import { parentPort } from "node:worker_threads";

// lib/usage-ledger-service.ts
import { spawn } from "node:child_process";
import { readFileSync as readFileSync2, statSync } from "node:fs";

// lib/usage-delete-guard.ts
import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import * as nodeModuleNamespace from "module";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";
var REQUIRED_GUARD_FILES = [
  "pi-usage-delete-guard.cjs",
  "pi-usage-seal-worker.cjs",
  "usage-storage-paths.cjs",
  "generate-usage-ledger.js",
  "usage-ledger-core.js"
];
function hasCompleteGuardBinDir(binDir) {
  return REQUIRED_GUARD_FILES.every((fileName) => existsSync(join(binDir, fileName)));
}
function verifyGuardBinInRoot(pkgRoot) {
  const resolvedRoot = resolvePath(pkgRoot);
  const candidateBin = join(resolvedRoot, "bin", "usage-guard");
  if (hasCompleteGuardBinDir(candidateBin)) {
    return candidateBin;
  }
  throw new Error(`[usage-delete-guard] Incomplete or missing usage-guard bin directory in: ${pkgRoot}`);
}
function searchUpwardForGuardBin(startDir) {
  let current = resolvePath(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(current, "bin", "usage-guard");
    if (hasCompleteGuardBinDir(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
function findDotNextPackageRoot(startDir) {
  let current = resolvePath(startDir);
  for (let depth = 0; depth < 16; depth += 1) {
    if (basename(current) === ".next") {
      const parent2 = dirname(current);
      return parent2 !== current ? parent2 : null;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
function isPiWebPackageRoot(dir) {
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    return pkg.name === "@agegr/pi-web";
  } catch {
    return false;
  }
}
function findOwningPackageRoot(startDir) {
  const dotNextRoot = findDotNextPackageRoot(startDir);
  if (dotNextRoot) return dotNextRoot;
  let current = resolvePath(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const guardBinDir2 = join(current, "bin", "usage-guard");
    if (existsSync(guardBinDir2) || isPiWebPackageRoot(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
function normalizeRuntimeFilePath(raw) {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("node:") || trimmed.startsWith("internal/") || trimmed.startsWith("[") || trimmed.startsWith("webpack-internal:") || trimmed.startsWith("rsc:")) {
    return null;
  }
  let filePath = trimmed;
  if (trimmed.startsWith("file://")) {
    try {
      filePath = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  if (!isAbsolute(filePath)) return null;
  if (filePath.includes(join("node_modules", "jiti"))) return null;
  return filePath;
}
function getRuntimeModuleFilePath() {
  const origPrepare = Error.prepareStackTrace;
  try {
    let sites = [];
    Error.prepareStackTrace = (_err, stack) => {
      sites = Array.isArray(stack) ? stack : [];
      return "";
    };
    const probe = new Error();
    void probe.stack;
    for (const site of sites) {
      const candidate = normalizeRuntimeFilePath(site.getFileName?.()) ?? normalizeRuntimeFilePath(site.getScriptNameOrSourceURL?.());
      if (candidate) return candidate;
    }
  } catch {
  } finally {
    Error.prepareStackTrace = origPrepare;
  }
  const stackText = new Error().stack ?? "";
  for (const line of stackText.split("\n")) {
    const match = line.match(/\((file:\/\/[^)]+|\/[^):]+|[A-Za-z]:\\[^):]+)/) ?? line.match(/at\s+(file:\/\/\S+|\/[^:\s]+|[A-Za-z]:\\[^:\s]+)/);
    if (match?.[1]) {
      const candidate = normalizeRuntimeFilePath(match[1]);
      if (candidate) return candidate;
    }
  }
  return null;
}
function getNativeCreateRequire() {
  const proc = process;
  const methodKey = ["create", "Require"].join("");
  if (typeof proc.getBuiltinModule === "function") {
    const builtinMod = proc.getBuiltinModule("node:module") ?? proc.getBuiltinModule("module");
    const fn = builtinMod?.[methodKey];
    if (typeof fn === "function") {
      return fn.bind(builtinMod);
    }
  }
  const fallbackMod = nodeModuleNamespace;
  const fallbackFn = fallbackMod?.[methodKey];
  if (typeof fallbackFn === "function") {
    return fallbackFn.bind(fallbackMod);
  }
  throw new Error("[usage-delete-guard] Native module.createRequire is unavailable");
}
function loadNativeCommonJs(scriptPath) {
  const absPath = resolvePath(scriptPath);
  const createReq = getNativeCreateRequire();
  const runtimeRequire = createReq(absPath);
  return runtimeRequire(absPath);
}
function resolveUsageGuardBinDir(customPkgRoot) {
  if (customPkgRoot) {
    return verifyGuardBinInRoot(customPkgRoot);
  }
  const runtimeFile = getRuntimeModuleFilePath();
  if (runtimeFile) {
    const owningRoot = findOwningPackageRoot(dirname(runtimeFile));
    if (owningRoot) {
      return verifyGuardBinInRoot(owningRoot);
    }
  }
  if (typeof process.argv[1] === "string" && process.argv[1].trim()) {
    const argvBin = searchUpwardForGuardBin(dirname(resolvePath(process.argv[1])));
    if (argvBin) return argvBin;
  }
  const foundFromCwd = searchUpwardForGuardBin(process.cwd());
  if (foundFromCwd) return foundFromCwd;
  throw new Error("[usage-delete-guard] Trusted bin/usage-guard directory not found or incomplete");
}
function loadUsageDeleteGuard(customPkgRoot) {
  const binDir = resolveUsageGuardBinDir(customPkgRoot);
  if (globalThis.__piUsageDeleteGuardModule && globalThis.__piUsageDeleteGuardBinDir === binDir) {
    return globalThis.__piUsageDeleteGuardModule;
  }
  const guardScriptPath = join(binDir, "pi-usage-delete-guard.cjs");
  const guardModule = loadNativeCommonJs(guardScriptPath);
  globalThis.__piUsageDeleteGuardModule = guardModule;
  globalThis.__piUsageDeleteGuardBinDir = binDir;
  return guardModule;
}
function ensureSessionWriteGuardInstalled(SessionManagerClass = SessionManager) {
  const guard = loadUsageDeleteGuard();
  return guard.installSessionWriteGuard(SessionManagerClass);
}
var GUARD_VERSION = loadUsageDeleteGuard().GUARD_VERSION;
var deletedPaths = loadUsageDeleteGuard().deletedPaths;
ensureSessionWriteGuardInstalled();

// lib/usage-ledger-service.ts
import * as os from "node:os";
import path from "node:path";
var guardBinDir = resolveUsageGuardBinDir();
var storagePaths = loadNativeCommonJs(path.join(guardBinDir, "usage-storage-paths.cjs"));
var ledgerCore = loadNativeCommonJs(path.join(guardBinDir, "usage-ledger-core.js"));
function readValidLedger(filePath, validate) {
  let value;
  try {
    value = JSON.parse(readFileSync2(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || value.version !== 2 || !Array.isArray(value.buckets)) return null;
  try {
    validate(value);
    return value;
  } catch {
    return null;
  }
}
function defaultNativeLedgerPath(source) {
  return storagePaths.resolveUsagePathsForLedger({ source }).outputFile;
}
function runGenerator(source, cwd) {
  return new Promise((resolve, reject) => {
    const script = path.join(guardBinDir, "generate-usage-ledger.js");
    const child = spawn(process.execPath, [script, "--source", source], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    let settled = false;
    let timeout;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once("error", (error) => finish(error));
    child.once("spawn", () => {
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
      }
    });
    const timeoutMs = Number(process.env.PI_USAGE_GENERATOR_TIMEOUT_MS) || 18e4;
    timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Usage ledger generation timed out"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Usage ledger generator exited (${code ?? signal ?? "unknown"})`));
    });
  });
}
function modeError(message, mode) {
  const error = new Error(message);
  error.mode = mode;
  return error;
}
function createUsageLedgerService(options = {}) {
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;
  const validate = options.validate || ledgerCore.validate;
  const nativeSource = platform === "win32" ? "windows" : "nas";
  const resolveNativePath = options.resolveNativeLedgerPath || defaultNativeLedgerPath;
  const generate = options.generate || runGenerator;
  const now = options.now || Date.now;
  const refreshIntervalMs = options.refreshIntervalMs ?? 5 * 6e4;
  let generation = null;
  let nextBackgroundAttempt = 0;
  let backgroundFailed = false;
  let lastVerifiedRefresh = 0;
  const publicLedgerPath = path.join(cwd, "public", "pi-usage-ledger.json");
  function readCentral() {
    const configured = typeof process.env.PI_USAGE_DATA_DIR === "string" && process.env.PI_USAGE_DATA_DIR.trim().length > 0;
    let globalLedgerPath = null;
    if (configured) {
      const storage = storagePaths.resolveUsageStorage({ source: "nas" });
      globalLedgerPath = storage.enabled ? storage.globalLedgerFile || null : null;
    }
    if (globalLedgerPath) {
      const globalLedger = readValidLedger(globalLedgerPath, validate);
      if (globalLedger) return { ledger: globalLedger, mode: "legacy-central" };
    }
    const publicLedger = readValidLedger(publicLedgerPath, validate);
    if (publicLedger) return { ledger: publicLedger, mode: "legacy-central" };
    if (configured) {
      throw modeError("Configured central usage ledger is missing or invalid", "legacy-central");
    }
    return null;
  }
  async function runSingleflight(source) {
    if (!generation) {
      generation = generate(source, cwd).finally(() => {
        generation = null;
      });
    }
    return generation;
  }
  async function readNative() {
    const nativeLedgerPath = resolveNativePath(nativeSource);
    const existing = readValidLedger(nativeLedgerPath, validate);
    if (existing) {
      let stale = false;
      try {
        stale = now() - Math.max(statSync(nativeLedgerPath).mtimeMs, lastVerifiedRefresh) >= refreshIntervalMs;
      } catch {
        stale = true;
      }
      if (stale && !generation && now() >= nextBackgroundAttempt) {
        nextBackgroundAttempt = now() + refreshIntervalMs;
        backgroundFailed = false;
        void runSingleflight(nativeSource).then(() => {
          if (!readValidLedger(nativeLedgerPath, validate)) throw new Error("Usage ledger refresh produced an invalid snapshot");
          lastVerifiedRefresh = now();
        }).catch(() => {
          backgroundFailed = true;
          nextBackgroundAttempt = now() + refreshIntervalMs;
        });
      }
      const refreshStatus = stale && generation ? "loading" : stale && backgroundFailed ? "error" : void 0;
      return { ledger: existing, mode: "native-local", ...refreshStatus ? { refreshStatus } : {} };
    }
    await runSingleflight(nativeSource);
    const generated = readValidLedger(nativeLedgerPath, validate);
    if (!generated) throw modeError("Native usage ledger generation produced no valid snapshot", "native-local");
    return { ledger: generated, mode: "native-local" };
  }
  async function get() {
    const central = readCentral();
    if (central) return central;
    return readNative();
  }
  async function post() {
    const central = readCentral();
    if (central) return central;
    await runSingleflight(nativeSource);
    const generated = readValidLedger(resolveNativePath(nativeSource), validate);
    if (!generated) throw modeError("Native usage ledger generation produced no valid snapshot", "native-local");
    backgroundFailed = false;
    lastVerifiedRefresh = now();
    nextBackgroundAttempt = now() + refreshIntervalMs;
    return { ledger: generated, mode: "native-local" };
  }
  return { get, post };
}
var serviceKey = /* @__PURE__ */ Symbol.for("pi-web.usage-ledger-service");
function getService() {
  const target = globalThis;
  return target[serviceKey] ||= createUsageLedgerService();
}
function getUsageLedger() {
  return getService().get();
}
function refreshUsageLedger() {
  return getService().post();
}

// lib/usage-ledger-engines.ts
import { createHash as createHash3 } from "node:crypto";
import path2 from "node:path";
var core = loadNativeCommonJs(path2.join(resolveUsageGuardBinDir(), "usage-ledger-core.js"));
var settle = async (work) => {
  try {
    return { value: await work() };
  } catch (error) {
    return { error };
  }
};
function combineUsageLedgers(pi, codex) {
  const piValue = "value" in pi ? pi.value : null;
  const codexValue = "value" in codex ? codex.value : null;
  if (!piValue && !codexValue) throw "error" in pi ? pi.error : new Error("\u7528\u91CF\u8D26\u672C\u6682\u4E0D\u53EF\u7528");
  if (codexValue) core.validate(codexValue);
  const coverage = codexValue?.sources?.codex;
  const engineStatus = {
    pi: !piValue ? { status: "unavailable", message: "Pi Agent \u7528\u91CF\u6682\u4E0D\u53EF\u7528\uFF0C\u5F53\u524D\u7EDF\u8BA1\u4E0D\u5B8C\u6574" } : piValue.refreshStatus === "loading" ? { status: "loading", message: "\u6B63\u5728\u540E\u53F0\u66F4\u65B0 Pi Agent \u7528\u91CF\uFF0C\u6682\u663E\u793A\u4E0A\u6B21\u5FEB\u7167" } : piValue.refreshStatus === "error" ? { status: "partial", message: "Pi Agent \u7528\u91CF\u66F4\u65B0\u5931\u8D25\uFF0C\u6682\u663E\u793A\u4E0A\u6B21\u5FEB\u7167" } : { status: "ready" },
    codex: "error" in codex ? { status: "unavailable", message: "Codex \u7528\u91CF\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u6267\u884C\u7AEF\u8FDE\u63A5\u6216\u5347\u7EA7\u8FDE\u63A5\u5668" } : !codexValue ? { status: "disabled", message: "\u5C1A\u672A\u542F\u7528 Codex \u6267\u884C\u5F15\u64CE" } : codexValue.error ? { status: "unavailable", message: "Codex \u7528\u91CF\u540C\u6B65\u5931\u8D25\uFF0C\u4FDD\u7559\u4E0A\u6B21\u5FEB\u7167" } : codexValue.loading ? { status: "loading", message: "\u6B63\u5728\u6574\u7406 Codex \u5386\u53F2\u7528\u91CF\uFF0C\u5F53\u524D\u7EDF\u8BA1\u5C1A\u672A\u5B8C\u6574" } : coverage?.unavailableHistoryCount ? { status: "partial", message: `Codex \u6709 ${coverage.unavailableHistoryCount} \u6761\u5386\u53F2\u8BB0\u5F55\u7684\u6587\u4EF6\u5DF2\u4E0D\u53EF\u7528\uFF0C\u4EC5\u7EDF\u8BA1\u53EF\u6838\u5BF9\u7528\u91CF` } : coverage?.complete === false ? coverage.counterGapCount ? { status: "unavailable", message: "Codex \u90E8\u5206\u5386\u53F2\u8BA1\u6570\u7F3A\u5931\uFF0C\u5F53\u524D\u4EC5\u5C55\u793A\u53EF\u6838\u5BF9\u7528\u91CF" } : { status: "loading", message: "\u6B63\u5728\u7B49\u5F85 Codex \u5386\u53F2\u8BB0\u5F55\u5199\u5165\u5B8C\u6210\uFF0C\u5F53\u524D\u4EC5\u5C55\u793A\u5B8C\u6574\u8BB0\u5F55" } : { status: "ready" }
  };
  const tag = (ledger2, engine) => (ledger2?.buckets || []).map((bucket) => ({ ...bucket, engine }));
  const old = piValue?.ledger;
  const ledger = {
    ...old || {},
    version: 2,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    snapshotId: !codexValue && !("error" in codex) ? old?.snapshotId : createHash3("sha256").update(JSON.stringify([old?.snapshotId, codexValue?.snapshotId, engineStatus])).digest("hex").slice(0, 24),
    buckets: [...tag(old || null, "pi"), ...tag(codexValue, "codex")],
    sessions: { ...old?.sessions, ...codexValue?.sessions },
    sources: { ...old?.sources, ...codexValue?.sources || {} },
    engineStatus
  };
  const aggregate = core.aggregate(ledger);
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "messageCount", "calls", "records", "costNano", "unpricedTokens", "missingUsage"];
  ledger.totals = Object.fromEntries(fields.map((key3) => [key3, aggregate[key3]]));
  core.validate(ledger);
  return { ledger, mode: piValue?.mode || "native-local" };
}
async function readUsageByEngine(operation, readCodex, refreshCodex = false) {
  const codex = readCodex || (async () => {
    const { readExecutionEngineSettings: readExecutionEngineSettings2 } = await Promise.resolve().then(() => (init_execution_engine_settings(), execution_engine_settings_exports));
    if (!(await readExecutionEngineSettings2()).codex.enabled) return null;
    const { codexBridgeJson: codexBridgeJson2 } = await Promise.resolve().then(() => (init_codex_bridge_client(), codex_bridge_client_exports));
    const ledger = await codexBridgeJson2(`/api/usage/ledger${refreshCodex ? "?refresh=1" : ""}`, void 0, { timeout: 1e4 });
    return ledger;
  });
  const [piResult, codexResult] = await Promise.all([settle(operation), settle(codex)]);
  return combineUsageLedgers(piResult, codexResult);
}

// lib/usage-pricing.ts
import fs from "node:fs";
import path3 from "node:path";
import { getAgentDir as getAgentDir4 } from "@earendil-works/pi-coding-agent";

// lib/model-runtime.ts
import {
  createAgentSessionServices,
  getAgentDir as getAgentDir3
} from "@earendil-works/pi-coding-agent";
async function createModelRuntimeWithExtensions() {
  const agentDir = getAgentDir3();
  const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
  return services.modelRuntime;
}

// lib/models-cache.ts
var MODELS_CACHE_STALE_MS = 5 * 6e4;
function getModelsCacheState() {
  if (!globalThis.__piModelsCacheState) {
    globalThis.__piModelsCacheState = {
      entries: /* @__PURE__ */ new Map(),
      inFlight: /* @__PURE__ */ new Map(),
      generation: 0
    };
  }
  return globalThis.__piModelsCacheState;
}
function invalidateModelsCache() {
  const state2 = getModelsCacheState();
  state2.generation += 1;
  state2.entries.clear();
  state2.inFlight.clear();
}

// lib/model-catalog-refresh.ts
var CATALOG_REFRESH_TIMEOUT_MS = 15e3;
function serializeCatalogCost(cost) {
  if (!cost) return "";
  const input = cost.input ?? "";
  const output = cost.output ?? "";
  const cacheRead = cost.cacheRead ?? "";
  const cacheWrite = cost.cacheWrite ?? "";
  const tiers = Array.isArray(cost.tiers) ? JSON.stringify(cost.tiers) : "";
  return `${input}:${output}:${cacheRead}:${cacheWrite}:${tiers}`;
}
function modelCatalogSignature(models) {
  return models.map((model) => `${model.provider}\0${model.id}\0${model.name}\0${serializeCatalogCost(model.cost)}`).sort().join("\n");
}
function isModelNetworkDisabled() {
  return process.env.PI_OFFLINE !== void 0;
}
async function refreshModelCatalogs(options = {}) {
  if (isModelNetworkDisabled()) return { completed: false, changed: false, reason: "offline" };
  const timeout = AbortSignal.timeout(CATALOG_REFRESH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let runtime;
  try {
    runtime = await createModelRuntimeWithExtensions();
  } catch {
    return { completed: false, changed: false, reason: "runtime" };
  }
  const before = modelCatalogSignature(runtime.getModels());
  let completed = false;
  try {
    const result = await runtime.refresh({
      ...options.providers ? { providers: options.providers } : {},
      force: true,
      signal
    });
    completed = !result.aborted && result.errors.size === 0;
  } catch {
    completed = false;
  }
  const changed = modelCatalogSignature(runtime.getModels()) !== before;
  if (changed) invalidateModelsCache();
  return { completed, changed };
}
function getPasses() {
  if (!globalThis.__piModelCatalogRefreshPasses) globalThis.__piModelCatalogRefreshPasses = /* @__PURE__ */ new Map();
  return globalThis.__piModelCatalogRefreshPasses;
}
function shareModelCatalogRefresh(options = {}) {
  const key3 = options.providers ? [...options.providers].sort().join(",") : "";
  const passes = getPasses();
  const running = passes.get(key3);
  if (running) return running;
  const pass = refreshModelCatalogs({ ...options, signal: void 0 }).finally(() => {
    if (passes.get(key3) === pass) passes.delete(key3);
  });
  passes.set(key3, pass);
  return pass;
}

// lib/usage-pricing.ts
var PRICING_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1e3;
var PRICING_RETRY_COOLDOWN_MS = 5 * 60 * 1e3;
function isValidPricingRate(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validateAndExtractCost(cost) {
  if (!cost || typeof cost !== "object") return null;
  const c = cost;
  if (!isValidPricingRate(c.input) || !isValidPricingRate(c.output) || !isValidPricingRate(c.cacheRead) || !isValidPricingRate(c.cacheWrite)) {
    return null;
  }
  const tiered = Array.isArray(c.tiers) && c.tiers.length > 0;
  return {
    input: c.input,
    output: c.output,
    cacheRead: c.cacheRead,
    cacheWrite: c.cacheWrite,
    tiered
  };
}
function areValidModelsPricing(models) {
  if (!models || typeof models !== "object") return false;
  const entries = Object.entries(models);
  if (entries.length === 0) return false;
  for (const [modelId, rate] of entries) {
    if (!rate || typeof rate !== "object") return false;
    if (rate.modelId !== modelId || rate.provider !== "openai-codex") return false;
    if (!isValidPricingRate(rate.input) || !isValidPricingRate(rate.output) || !isValidPricingRate(rate.cacheRead) || !isValidPricingRate(rate.cacheWrite)) {
      return false;
    }
  }
  return true;
}
function hasExplicitCostField(cost) {
  if (!cost || typeof cost !== "object") return false;
  const c = cost;
  return isValidPricingRate(c.input) || isValidPricingRate(c.output) || isValidPricingRate(c.cacheRead) || isValidPricingRate(c.cacheWrite) || Array.isArray(c.tiers) && c.tiers.length > 0;
}
function readManualCostModelIds(modelsJsonPath) {
  const manualIds = /* @__PURE__ */ new Set();
  try {
    const p = modelsJsonPath ?? path3.join(getAgentDir4(), "models.json");
    if (!fs.existsSync(p)) return manualIds;
    const content = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(content);
    const providerConfig = data?.providers?.["openai-codex"];
    if (!providerConfig || typeof providerConfig !== "object") return manualIds;
    const modelOverrides = providerConfig.modelOverrides;
    if (modelOverrides && typeof modelOverrides === "object") {
      for (const [modelId, override] of Object.entries(modelOverrides)) {
        if (override && typeof override === "object" && "cost" in override && hasExplicitCostField(override.cost)) {
          manualIds.add(modelId);
        }
      }
    }
    const modelsArr = providerConfig.models;
    if (Array.isArray(modelsArr)) {
      for (const m of modelsArr) {
        if (m && typeof m === "object" && typeof m.id === "string" && "cost" in m && hasExplicitCostField(m.cost)) {
          manualIds.add(m.id);
        }
      }
    }
  } catch {
  }
  return manualIds;
}
function getStoredCheckedAt(modelsStorePath) {
  try {
    const p = modelsStorePath ?? path3.join(getAgentDir4(), "models-store.json");
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, "utf-8");
    const data = JSON.parse(content);
    const checkedAt = data?.["openai-codex"]?.checkedAt;
    return typeof checkedAt === "number" && Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : null;
  } catch {
    return null;
  }
}
function getFileMtime(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}
function getModelsJsonMtime(modelsJsonPath) {
  return getFileMtime(modelsJsonPath ?? path3.join(getAgentDir4(), "models.json"));
}
function getModelsStoreMtime(modelsStorePath) {
  return getFileMtime(modelsStorePath ?? path3.join(getAgentDir4(), "models-store.json"));
}
function buildPricingModels(runtimeModels, manualCostModelIds) {
  const result = {};
  const isManual = (id) => {
    if (!manualCostModelIds) return false;
    if (manualCostModelIds instanceof Set) return manualCostModelIds.has(id);
    if (manualCostModelIds instanceof Map) return manualCostModelIds.has(id);
    return false;
  };
  for (const m of runtimeModels) {
    if (m.provider !== "openai-codex") continue;
    const sdkCost = validateAndExtractCost(m.cost);
    if (sdkCost) {
      result[m.id] = {
        input: sdkCost.input,
        output: sdkCost.output,
        cacheRead: sdkCost.cacheRead,
        cacheWrite: sdkCost.cacheWrite,
        source: isManual(m.id) ? "manual" : "pi-sdk",
        provider: "openai-codex",
        modelId: m.id,
        tiered: sdkCost.tiered
      };
    }
  }
  return result;
}
var UsagePricingManager = class {
  constructor(options = {}) {
    this.cachedSnapshot = null;
    this.modelsJsonMtimeMs = -1;
    this.modelsStoreMtimeMs = -1;
    this.modelsStoreCheckedAt = null;
    // SDK checkedAt records attempts (including failed HTTP reads), not successful updates.
    this.lastRefreshedAt = 0;
    this.lastVerifiedRefreshedAt = 0;
    this.lastAttemptedAt = 0;
    this.refreshPromise = null;
    this.lastRefreshError = null;
    this.initOrSyncPromise = null;
    this.now = options.now ?? (() => Date.now());
    this.runtimeFactory = options.runtimeFactory ?? createModelRuntimeWithExtensions;
    this.refreshFn = options.refreshFn ?? shareModelCatalogRefresh;
    this.modelsJsonPath = options.modelsJsonPath;
    this.modelsStorePath = options.modelsStorePath;
    this.initialCheckedAt = options.initialCheckedAt;
    this.isOffline = options.isOffline ?? isModelNetworkDisabled;
  }
  invalidate() {
    this.cachedSnapshot = null;
    this.modelsJsonMtimeMs = -1;
    this.modelsStoreMtimeMs = -1;
    this.modelsStoreCheckedAt = null;
    this.lastVerifiedRefreshedAt = 0;
    this.initOrSyncPromise = null;
  }
  async getPricing() {
    const offline = this.isOffline();
    const currentJsonMtime = getModelsJsonMtime(this.modelsJsonPath);
    const currentStoreMtime = this.modelsStorePath !== void 0 ? getModelsStoreMtime(this.modelsStorePath) : this.initialCheckedAt !== void 0 ? 0 : getModelsStoreMtime();
    const currentStoredCheckedAt = this.modelsStorePath !== void 0 ? getStoredCheckedAt(this.modelsStorePath) : this.initialCheckedAt !== void 0 ? this.initialCheckedAt : getStoredCheckedAt();
    const needsInit = !this.cachedSnapshot;
    const needsJsonSync = currentJsonMtime !== this.modelsJsonMtimeMs;
    const needsStoreSync = currentStoreMtime !== this.modelsStoreMtimeMs || currentStoredCheckedAt !== null && currentStoredCheckedAt !== this.modelsStoreCheckedAt;
    if (needsInit || needsJsonSync || needsStoreSync) {
      if (!this.initOrSyncPromise) {
        this.initOrSyncPromise = this.syncRuntimeState({
          currentJsonMtime,
          currentStoreMtime,
          currentStoredCheckedAt,
          offline
        }).finally(() => {
          this.initOrSyncPromise = null;
        });
      }
      await this.initOrSyncPromise;
    }
    const needsRefresh = this.lastRefreshError ? this.now() - this.lastAttemptedAt >= PRICING_RETRY_COOLDOWN_MS : this.now() - this.lastRefreshedAt >= PRICING_REFRESH_INTERVAL_MS;
    if (!offline && needsRefresh && !this.refreshPromise) {
      this.triggerBackgroundRefresh();
    }
    const refreshStatus = offline ? { state: "offline" } : this.refreshPromise ? { state: "refreshing" } : this.lastRefreshError ? {
      state: "error",
      attemptedAt: this.lastRefreshError.attemptedAt,
      message: this.lastRefreshError.message
    } : {
      state: this.lastVerifiedRefreshedAt > 0 && this.now() - this.lastRefreshedAt < PRICING_REFRESH_INTERVAL_MS ? "current" : "cached"
    };
    const snapshot = this.cachedSnapshot ?? {
      version: 1,
      currency: "USD",
      unit: "per_1m_tokens",
      updatedAt: null,
      refresh: refreshStatus,
      models: {}
    };
    return {
      version: 1,
      currency: "USD",
      unit: "per_1m_tokens",
      updatedAt: snapshot.updatedAt,
      refresh: refreshStatus,
      models: { ...snapshot.models }
    };
  }
  async syncRuntimeState(params) {
    const {
      currentJsonMtime,
      currentStoreMtime,
      currentStoredCheckedAt,
      offline
    } = params;
    let freshModels = null;
    try {
      const runtime = await this.runtimeFactory();
      const manualIds = readManualCostModelIds(this.modelsJsonPath);
      const built = buildPricingModels(runtime.getModels(), manualIds);
      if (areValidModelsPricing(built)) {
        freshModels = built;
      }
    } catch {
      freshModels = null;
    }
    if (freshModels) {
      this.modelsJsonMtimeMs = currentJsonMtime;
      this.modelsStoreMtimeMs = currentStoreMtime;
      const isNewStoreCheckedAt = currentStoredCheckedAt !== null && currentStoredCheckedAt !== this.modelsStoreCheckedAt;
      this.modelsStoreCheckedAt = currentStoredCheckedAt;
      if (isNewStoreCheckedAt && currentStoredCheckedAt > 0) {
        this.lastRefreshedAt = currentStoredCheckedAt;
      }
      if (this.cachedSnapshot && JSON.stringify(this.cachedSnapshot.models) !== JSON.stringify(freshModels)) {
        this.lastVerifiedRefreshedAt = 0;
      }
      const updatedAt = this.lastVerifiedRefreshedAt > 0 ? new Date(this.lastVerifiedRefreshedAt).toISOString() : null;
      if (this.cachedSnapshot) {
        this.cachedSnapshot.models = freshModels;
        this.cachedSnapshot.updatedAt = updatedAt;
      } else {
        const isFresh = this.lastVerifiedRefreshedAt > 0 && this.now() - this.lastRefreshedAt < PRICING_REFRESH_INTERVAL_MS;
        this.cachedSnapshot = {
          version: 1,
          currency: "USD",
          unit: "per_1m_tokens",
          updatedAt,
          refresh: {
            state: offline ? "offline" : isFresh ? "current" : "cached"
          },
          models: freshModels
        };
      }
    } else {
      if (!this.cachedSnapshot) {
        if (currentStoredCheckedAt && this.lastRefreshedAt === 0) {
          this.lastRefreshedAt = currentStoredCheckedAt;
        }
        this.cachedSnapshot = {
          version: 1,
          currency: "USD",
          unit: "per_1m_tokens",
          updatedAt: null,
          refresh: {
            state: offline ? "offline" : "error",
            message: "Failed to initialize valid pricing models from runtime"
          },
          models: {}
        };
      }
    }
  }
  triggerBackgroundRefresh() {
    const attemptTime = this.now();
    this.lastAttemptedAt = attemptTime;
    const attemptedAt = new Date(attemptTime).toISOString();
    const promise = (async () => {
      try {
        const result = await this.refreshFn({ providers: ["openai-codex"] });
        if (result.completed) {
          let freshModels = null;
          try {
            const freshRuntime = await this.runtimeFactory();
            const manualIds = readManualCostModelIds(this.modelsJsonPath);
            const built = buildPricingModels(freshRuntime.getModels(), manualIds);
            if (areValidModelsPricing(built)) {
              freshModels = built;
            }
          } catch {
            freshModels = null;
          }
          if (freshModels) {
            const finishTime = this.now();
            this.lastRefreshedAt = finishTime;
            this.lastVerifiedRefreshedAt = finishTime;
            this.lastRefreshError = null;
            this.modelsJsonMtimeMs = getModelsJsonMtime(this.modelsJsonPath);
            this.modelsStoreMtimeMs = this.modelsStorePath !== void 0 || this.initialCheckedAt === void 0 ? getModelsStoreMtime(this.modelsStorePath) : 0;
            this.modelsStoreCheckedAt = this.modelsStorePath !== void 0 || this.initialCheckedAt === void 0 ? getStoredCheckedAt(this.modelsStorePath) : this.initialCheckedAt;
            if (this.cachedSnapshot) {
              this.cachedSnapshot = {
                version: 1,
                currency: "USD",
                unit: "per_1m_tokens",
                updatedAt: new Date(finishTime).toISOString(),
                refresh: {
                  state: "current"
                },
                models: freshModels
              };
            }
          } else {
            this.lastRefreshError = {
              attemptedAt,
              message: "Refreshed catalog contains empty or invalid pricing models"
            };
          }
        } else {
          const message = result.reason ? `Refresh skipped: ${result.reason}` : "Refresh failed to complete";
          this.lastRefreshError = { attemptedAt, message };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.lastRefreshError = { attemptedAt, message };
      } finally {
        this.refreshPromise = null;
      }
    })();
    this.refreshPromise = promise;
  }
  async getModelPricing(modelId) {
    const snapshot = await this.getPricing();
    return snapshot.models[modelId];
  }
  getRunningRefreshPromise() {
    return this.refreshPromise;
  }
};
function getDefaultManager() {
  if (!globalThis.__piDefaultUsagePricingManager) {
    globalThis.__piDefaultUsagePricingManager = new UsagePricingManager();
  }
  return globalThis.__piDefaultUsagePricingManager;
}
function getUsagePricing() {
  return getDefaultManager().getPricing();
}

// lib/usage-ledger-worker-entry.ts
import { gzipSync } from "node:zlib";
if (!parentPort) throw new Error("Usage ledger worker requires a parent port");
var port = parentPort;
var queue = Promise.resolve();
port.on("message", (message) => {
  if (!message || !Number.isSafeInteger(message.id) || typeof message.refresh !== "boolean") return;
  queue = queue.then(async () => {
    let mode = process.env.PI_USAGE_DATA_DIR?.trim() ? "legacy-central" : "native-local";
    try {
      const result = await readUsageByEngine(message.refresh ? refreshUsageLedger : getUsageLedger, void 0, message.refresh);
      mode = result.mode;
      let pricing;
      try {
        pricing = await getUsagePricing();
      } catch {
        console.warn("[usage-ledger] Pricing snapshot unavailable");
      }
      const body = new TextEncoder().encode(JSON.stringify(pricing ? { ...result.ledger, pricing } : result.ledger));
      const compressed = new Uint8Array(gzipSync(body));
      port.postMessage({ id: message.id, mode, body, compressed, status: 200 }, [body.buffer, compressed.buffer]);
    } catch (error) {
      const markedMode = error?.mode;
      if (markedMode === "legacy-central" || markedMode === "native-local") mode = markedMode;
      console.warn("[usage-ledger] Snapshot computation failed");
      const body = new TextEncoder().encode(JSON.stringify({ error: "\u672A\u80FD\u83B7\u53D6\u5230\u6709\u6548\u7684\u8D26\u672C\u5FEB\u7167\u6570\u636E" }));
      port.postMessage({ id: message.id, mode, body, status: 503 }, [body.buffer]);
    }
  });
});
