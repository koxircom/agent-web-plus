import "server-only";
import { createHash } from "node:crypto";
import { readExecutionEngineSettings } from "../execution-engine-settings";

type Connection = { signature: string; cookie: string; csrf: string; generation: number; flight?: Promise<void> };
const key = Symbol.for("pi-web.codex-bridge-connection");
const globals = globalThis as unknown as Record<symbol, Connection | undefined>;

function waitForSharedFlight(flight: Promise<void>, signal?: AbortSignal) {
  if (!signal) return flight;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    flight.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
  });
}

export class CodexBridgeError extends Error {
  constructor(message: string, public readonly status = 502, public readonly code?: string, public readonly dispatched?: boolean,
    public readonly retryable = status >= 500 || status === 408 || status === 429) { super(message); }
}
export async function codexBridgeRequest(path: string, body?: unknown, options?: { bytes?: Uint8Array; contentType?: string; timeout?: number; signal?: AbortSignal; connectionIdentity?: string }) {
  if (!path.startsWith("/api/") || path.includes("\\")) throw new Error("无效 Codex 服务路径");
  const config = (await readExecutionEngineSettings()).codex;
  if (!config.enabled || !config.url) throw new CodexBridgeError("Codex 引擎尚未启用或配置", 409, "codex_connection_required");
  const signature = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  if (options?.connectionIdentity && options.connectionIdentity !== signature) throw new CodexBridgeError("执行端配置已改变，请重新打开会话", 409, "codex_session_refresh");
  let connection = globals[key];
  if (!connection || connection.signature !== signature) globals[key] = connection = { signature, cookie: "", csrf: "", generation: 0 };
  const endpoint = config.url;
  const origin = new URL(endpoint).origin;
  const target = connection;
  const request = async (
    route: string,
    value?: unknown,
    binary?: Uint8Array,
    requestSignal: AbortSignal | null | undefined = options?.signal,
    timeout = options?.timeout ?? (route.includes("/changes?") ? 20000 : route.includes("/settings") ? 15000 : 10000),
  ) => {
    const headers: Record<string, string> = { Origin: origin };
    if (target.cookie) headers.Cookie = target.cookie;
    if (value !== undefined || binary) {
      headers["Content-Type"] = binary ? options?.contentType || "application/octet-stream" : "application/json";
      if (target.csrf) headers["X-CSRF-Token"] = target.csrf;
    }
    try {
      return await fetch(endpoint + route, {
        method: value !== undefined || binary ? "POST" : "GET", headers,
        body: binary ? Buffer.from(binary) : value !== undefined ? JSON.stringify(value) : undefined,
        cache: "no-store", redirect: "error", signal: requestSignal ? AbortSignal.any([requestSignal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (requestSignal?.aborted) throw requestSignal.reason ?? error;
      const isTimeout = error instanceof Error && (error.name === "TimeoutError" || (error.name === "AbortError" && !requestSignal?.aborted));
      if (isTimeout) {
        if (value !== undefined || binary) {
          throw new CodexBridgeError(
            "Codex 操作响应超时，当前设置未在时限内确认生效；写操作未自动重发，请刷新核对",
            504,
            "codex_timeout",
            undefined,
            false,
          );
        }
        throw new CodexBridgeError("Codex 请求响应超时，请稍后刷新重试", 504, "codex_timeout", undefined, true);
      }
      throw new CodexBridgeError("Codex 执行端暂时不可达；Pi 引擎可继续使用", 502, "codex_connection_required", undefined, true);
    }
  };
  const authenticate = async () => {
    if (target.csrf) return;
    if (!target.flight) target.flight = (async () => {
      {
        const response = await request("/api/login", { username: config.username, password: config.password }, undefined, null, 10000);
        if (!response.ok) throw new CodexBridgeError("Codex 服务登录失败，请检查连接配置", response.status, "codex_connection_required");
        target.cookie = response.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; ");
      }
      const response = await request("/api/auth", undefined, undefined, null, 10000);
      if (!response.ok) throw new CodexBridgeError("无法核对 Codex 服务认证", response.status, "codex_connection_required");
      const auth = await response.json();
      if (auth.authenticated === false) throw new CodexBridgeError("Codex 服务需要有效认证", 401, "codex_connection_required");
      target.csrf = auth.csrf || "anonymous";
      target.generation++;
    })().finally(() => { target.flight = undefined; });
    await waitForSharedFlight(target.flight, options?.signal);
  };
  await authenticate();
  let generation = target.generation;
  let response = await request(path, body, options?.bytes);
  if (response.status === 401) {
    // A late response using the old cookie must not invalidate a newer login.
    if (target.generation === generation && !target.flight) { target.csrf = ""; target.cookie = ""; }
    // Read-only requests may reauthenticate once. Writes keep their original
    // receipt/uncertainty contract and are never replayed by this transport.
    if (body === undefined && !options?.bytes) {
      await response.body?.cancel();
      await authenticate();
      generation = target.generation;
      response = await request(path);
    }
  }
  if (!response.ok) {
    if (response.status === 401 && target.generation === generation && !target.flight) { target.csrf = ""; target.cookie = ""; }
    const result = await response.json().catch(() => ({}));
    throw new CodexBridgeError(result.error || "Codex 服务未完成操作", response.status, result.code, result.dispatched,
      response.status >= 500 || response.status === 408 || response.status === 429);
  }
  return response;
}
// JSON schemas are validated by the native connector; consumers narrow each response.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function codexBridgeJson(path: string, body?: unknown, options?: { connectionIdentity?: string; timeout?: number; signal?: AbortSignal }): Promise<any> {
  return (await codexBridgeRequest(path, body, options)).json();
}
