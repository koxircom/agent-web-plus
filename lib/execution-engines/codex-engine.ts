import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { codexConnectionIdentity, codexThreadId } from "../execution-engine-settings";
import { CodexBridgeError, codexBridgeJson, codexBridgeRequest } from "./codex-bridge-client";
import { assistantText, codexComposerStatuses, projectCodexPage, projectCodexUsage, projectCodexRow, projectCodexSession, publicCodexId, type CodexMeta, type CodexPage, type CodexRow, type CodexRequest } from "./codex-projection";
import type { AgentEventLike } from "../agent-event-wire";
import type { AgentMessage } from "../types";
import { acceptPromptDelivery, markPromptDeliveryUnconfirmed, cancelPromptDelivery, commitPromptDelivery, recallPromptDelivery } from "../prompt-delivery";

export async function codexProjects(): Promise<{ key: string; name: string; cwd: string }[]> {
  const result = await codexBridgeJson("/api/projects");
  if (!Array.isArray(result.projects)) throw new Error("Codex 服务工作区格式不正确");
  return result.projects;
}
const catalogKey = Symbol.for("pi-web.codex-catalog");
type CatalogRow = { id: string; recency?: number; title: string; cwd: string };
type CatalogCache = { identity: string; version: number; loadedAt: number; rows: CatalogRow[] };
const catalogGlobals = globalThis as unknown as Record<symbol, CatalogCache | undefined>;
type SharedFlight<T> = { promise: Promise<T>; controller: AbortController; waiters: number; settled: boolean };
function sharedFlight<T>(flights: Map<string, SharedFlight<T>>, key: string, work: (signal: AbortSignal) => Promise<T>) {
  let flight = flights.get(key);
  if (flight?.controller.signal.aborted && !flight.settled) {
    if (flights.get(key) === flight) flights.delete(key);
    flight = undefined;
  }
  if (!flight) {
    const controller = new AbortController();
    flight = { promise: Promise.resolve().then(() => work(controller.signal)), controller, waiters: 0, settled: false };
    const current = flight;
    flight.promise = flight.promise.finally(() => {
      current.settled = true;
      if (flights.get(key) === current) flights.delete(key);
    });
    flights.set(key, flight);
    void flight.promise.catch(() => {});
  }
  return flight;
}
function joinFlight<T>(flight: SharedFlight<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    if (!flight.waiters && !flight.settled) flight.controller.abort(signal.reason);
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
  }
  flight.waiters++;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const finish = (accept: boolean, value: unknown) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      if (accept) resolve(value as T);
      else reject(value);
    };
    const onAbort = () => finish(false, signal?.reason ?? new DOMException("The operation was aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    flight.promise.then(value => finish(true, value), error => finish(false, error));
    if (signal?.aborted) onAbort();
  }).finally(() => {
    flight.waiters--;
    if (!flight.waiters && !flight.settled) flight.controller.abort();
  });
}
const catalogFlightsKey = Symbol.for("pi-web.codex-catalog-flights");
const statusFlightsKey = Symbol.for("pi-web.codex-status-flights");
const flightGlobals = globalThis as unknown as Record<symbol, unknown>;
const catalogFlights = (flightGlobals[catalogFlightsKey] ||= new Map()) as Map<string, SharedFlight<CatalogCache>>;
const statusFlights = (flightGlobals[statusFlightsKey] ||= new Map()) as Map<string, SharedFlight<Awaited<ReturnType<typeof buildCodexRunningStatus>>>>;

const CODEX_STATUS_CATALOG_TTL_MS = 10_000;
function catalogVersion(rows: CatalogRow[]) {
  const entries = rows.map(row => [row.id, row.title, row.cwd, row.recency ?? null]);
  return Number.parseInt(createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 12), 16);
}
async function loadCodexCatalog(identity: string, signal?: AbortSignal, maxAgeMs = 0): Promise<CatalogCache> {
  const pending = catalogFlights.get(identity);
  if (pending && !pending.controller.signal.aborted) return joinFlight(pending, signal);
  const cached = catalogGlobals[catalogKey];
  if (cached?.identity === identity && Date.now() - cached.loadedAt < maxAgeMs) return cached;
  let flight!: SharedFlight<CatalogCache>;
  flight = sharedFlight(catalogFlights, identity, async flightSignal => {
    const rows: CatalogRow[] = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = (await codexBridgeJson(`/api/sessions?offset=${offset}`, undefined, { connectionIdentity: identity, signal: flightSignal })).sessions;
      rows.push(...page);
      if (page.length < 100) break;
    }
    if (await codexConnectionIdentity() !== identity) throw new CodexBridgeError("执行端配置已改变，请重新打开会话", 409, "codex_session_refresh");
    if (flightSignal.aborted || catalogFlights.get(identity) !== flight) {
      throw flightSignal.reason ?? new DOMException("The operation was aborted", "AbortError");
    }
    const result = { identity, version: catalogVersion(rows), loadedAt: Date.now(), rows };
    catalogGlobals[catalogKey] = result;
    return result;
  });
  return joinFlight(flight, signal);
}
async function codexActivity(rows: CatalogRow[], identity: string, signal?: AbortSignal) {
  const activity = [];
  for (let offset = 0; offset < rows.length; offset += 500) {
    const result = await codexBridgeJson("/api/activity", { hosts: { local: rows.slice(offset, offset + 500).map(r => r.id) } },
      { connectionIdentity: identity, signal });
    activity.push(...result.sessions);
  }
  return activity;
}

export class CodexStatusRevision {
  private identity: string | null = null;
  private epoch = randomUUID();
  private revision = 0;
  private fingerprint: string | null = null;

  update(identity: string, activity: unknown[]) {
    if (this.identity !== identity) {
      this.identity = identity;
      this.epoch = randomUUID();
      this.revision = 0;
      this.fingerprint = null;
    }
    const fingerprint = JSON.stringify(activity);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.revision++;
    }
    return { epoch: this.epoch, revision: this.revision };
  }
}
const statusRevisionKey = Symbol.for("pi-web.codex-status-revision");
const statusGlobals = globalThis as unknown as Record<symbol, CodexStatusRevision | undefined>;
const statusRevision = (statusGlobals[statusRevisionKey] ||= new CodexStatusRevision());

async function buildCodexRunningStatus(identity: string, signal: AbortSignal) {
  const catalog = await loadCodexCatalog(identity, signal, CODEX_STATUS_CATALOG_TTL_MS);
  const activity = await codexActivity(catalog.rows, identity, signal);
  if (await codexConnectionIdentity() !== identity) throw new CodexBridgeError("执行端配置已改变，请重新打开会话", 409, "codex_session_refresh");
  const stamp = statusRevision.update(identity, activity);
  return { sessionListVersion: catalog.version,
    runningSessionIds: activity.filter(r => r.status === "active").map(r => publicCodexId(r.id)),
    completionNotificationSuppressedSessionIds: [],
    statusSnapshot: { version: 1, epoch: stamp.epoch, revision: stamp.revision, executions: activity.map(r => ({ sessionId: publicCodexId(r.id), state: r.status === "active" ? "running" : "idle", runId: "" })) },
    interactionState: { version: 1, sessions: [] } };
}
export async function codexRunningStatus(signal?: AbortSignal) {
  const identity = await codexConnectionIdentity();
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  const flight = sharedFlight(statusFlights, identity, flightSignal => buildCodexRunningStatus(identity, flightSignal));
  return joinFlight(flight, signal);
}
export async function listCodexSessions(signal?: AbortSignal) {
  const identity = await codexConnectionIdentity();
  // The explicit session-list request is the user's refresh action; it always
  // reads the authoritative catalog instead of trusting the status TTL.
  const catalog = await loadCodexCatalog(identity, signal);
  // Query runtime metadata only. Listing never creates or resumes a Codex thread.
  const activity = await codexActivity(catalog.rows, identity, signal);
  if (await codexConnectionIdentity() !== identity) throw new CodexBridgeError("执行端配置已改变，请重新打开会话", 409, "codex_session_refresh");
  return { sessions: catalog.rows.map(projectCodexSession), sessionListVersion: catalog.version,
    runningSessionIds: activity.filter(r => r.status === "active").map(r => publicCodexId(r.id)), completionNotificationSuppressedSessionIds: [] };
}
export async function rowText(id: string, epoch: string, row: CodexRow, identity?: string, signal?: AbortSignal) {
  if (!row.truncated) return row.text;
  let text = "", offset = 0;
  while (text.length < 512000) {
    const query = new URLSearchParams({ key: `${epoch}.${row.key}`, offset: String(offset), version: row.version });
    const detail = await codexBridgeJson(`/api/sessions/${codexThreadId(id)}/detail?${query}`, undefined, { connectionIdentity: identity, signal });
    // A concurrent edit invalidates the cursor. Never concatenate different versions.
    if (detail.version !== row.version || detail.offset !== offset) return row.text;
    text += detail.text;
    if (detail.next === null || detail.next === undefined) return text;
    if (detail.next <= offset) throw new Error("Codex 内容分页没有前进");
    offset = detail.next;
  }
  return text + "\n（内容过长，已显示前 512 KB）";
}
export async function codexNavigationIndex(id: string, signal?: AbortSignal) {
  return codexBridgeJson(`/api/sessions/${codexThreadId(id)}/navigation`, undefined, { signal });
}
export async function codexSessionPage(id: string, options: { before?: string; limit?: number; identity?: string; timeout?: number; signal?: AbortSignal } = {}): Promise<CodexPage> {
  const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(1000, options.limit || 50))) });
  if (options.before) query.set("before", options.before);
  const base = `/api/sessions/${codexThreadId(id)}`;
  let page = await codexBridgeJson(`${base}/timeline?${query}`, undefined, { connectionIdentity: options.identity, timeout: options.timeout, signal: options.signal }) as CodexPage;
  if (options.before && !page.rows.length && page.meta.historyComplete === false) {
    // This explicit older-history read never resumes or starts a turn.
    await codexBridgeJson(`${base}/history`, {}, { connectionIdentity: options.identity, timeout: options.timeout, signal: options.signal });
    page = await codexBridgeJson(`${base}/timeline?${query}`, undefined, { connectionIdentity: options.identity, timeout: options.timeout, signal: options.signal });
  }
  if (options.before && page.reset) throw new CodexBridgeError("历史记录边界已变化，请重新打开会话后继续加载", 409);
  // Preserve complete assistant replies; tool previews stay bounded until expanded.
  const replies = page.rows.filter(row => row.truncated && row.role === "assistant");
  for (let start = 0; start < replies.length; start += 4) {
    await Promise.all(replies.slice(start, start + 4).map(async row => {
      row.text = await rowText(id, page.epoch, row, options.identity, options.signal); row.truncated = false;
    }));
  }
  return page;
}
export async function readCodexSession(id: string, request?: Request) {
  const query = request ? new URL(request.url).searchParams : null;
  if (query?.get("lookup") === "1") {
    await codexBridgeJson(`/api/sessions/${codexThreadId(id)}?metadata=1`);
    return { exists: true, sessionId: id };
  }
  const rawTail = Number(query?.get("tail"));
  const limit = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(1000, rawTail) : 50;
  return projectCodexPage(await codexSessionPage(id, { limit, signal: request?.signal }), id);
}
export async function codexModels(cwd?: string) {
  const projects = await codexProjects();
  const project = cwd ? projects.find(p => p.cwd === cwd) : projects[0];
  if (!project) throw new Error("请选择 Codex 服务已配置的工作区");
  const catalog = await codexBridgeJson(`/api/projects/catalog?${new URLSearchParams({ project: project.key, kind: "models" })}`);
  const models = catalog.models as { id: string; name: string; efforts?: string[]; isDefault?: boolean }[];
  return { models: Object.fromEntries(models.map(m => ["codex:" + m.id, m.name])),
    modelList: models.map(m => ({ id: m.id, name: m.name, provider: "codex", input: ["text", "image"] })),
    defaultModel: models.length ? { provider: "codex", modelId: (models.find(m => m.isDefault) || models[0]).id } : null,
    thinkingLevels: Object.fromEntries(models.map(m => ["codex:" + m.id, (m.efforts || ["low", "medium", "high"]).map(e => e === "none" ? "off" : e)])),
    thinkingLevelMaps: {}, thinkingLevelPins: {}, defaultThinkingLevel: "high" };
}
export async function createCodexSession(cwd: string, command: Record<string, unknown>) {
  if (command.type !== "ensure_session") throw new Error("请先创建 Codex 会话，再提交消息");
  const project = (await codexProjects()).find(p => p.cwd === cwd);
  if (!project) throw new Error("请选择 Codex 服务已配置的工作区");
  const created = await codexBridgeJson("/api/sessions", { project: project.key, title: "新聊天", id: randomUUID() });
  const id = publicCodexId(created.id);
  const runtime = await getCodexRuntime(id);
  if (typeof command.modelId === "string") await runtime.send({ type: "set_model", modelId: command.modelId });
  if (typeof command.thinkingLevel === "string") await runtime.send({ type: "set_thinking_level", level: command.thinkingLevel });
  return { success: true, sessionId: id, data: null,
    model: { provider: "codex", modelId: runtime.meta.model || "Codex" }, thinkingLevel: runtime.meta.effort === "none" ? "off" : runtime.meta.effort || "high" };
}
export async function reconcileCodexDelivery(id: string, requestId: string) {
  const submissionId = submissionUuid(requestId);
  const receipt = await codexBridgeJson(`/api/sessions/${codexThreadId(id)}/submissions/${submissionId}`);
  if (receipt.status === "accepted" || receipt.status === "queued") acceptPromptDelivery(id, requestId);
  else if (receipt.status === "failed" && receipt.id === submissionId && receipt.nativeQueueRejected === true) {
    recallPromptDelivery(id, requestId); // Automatic original-text/image draft restoration.
    return "recalled";
  }
  else if (receipt.status === "unknown" || receipt.status === "failed") markPromptDeliveryUnconfirmed(id, requestId);
  else if (receipt.status === "recalled") recallPromptDelivery(id, requestId);
  else if (receipt.status === "cancelled") cancelPromptDelivery(id, requestId);
  // The native receipt is independent of the browser/runtime's bounded tail.
  // An acknowledged write is insufficient; only the exact persisted user echo
  // releases the shared inbox, even after reconnect or wrapper eviction.
  if (receipt.id === submissionId && (["accepted", "unknown"].includes(receipt.status) && receipt.deliveryConfirmed === true
      || ["accepted", "queued"].includes(receipt.status) && receipt.nativeQueueConfirmed === true && typeof receipt.nativeQueueId === "string")) {
    await commitPromptDelivery(id, requestId, { handled: true });
    return "committed";
  }
  return receipt.status;
}
export function submissionUuid(requestId: string) {
  const hex = createHash("sha256").update("pi-web-codex:" + requestId).digest("hex").slice(0, 32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
const globals = globalThis as unknown as Record<symbol, unknown>;
const runtimeKey = Symbol.for("pi-web.codex-session-runtimes");
const runtimes = (globals[runtimeKey] ||= new Map()) as Map<string, CodexRuntime>;
const flightsKey = Symbol.for("pi-web.codex-session-flights");
const flights = (globals[flightsKey] ||= new Map()) as Map<string, Promise<CodexRuntime>>;
export async function getCodexRuntime(id: string) {
  codexThreadId(id);
  const identity = await codexConnectionIdentity(), key = identity + ":" + id;
  const cached = runtimes.get(key);
  if (cached?.isAlive() && cached.hasViewers()) return cached;
  let flight = flights.get(key);
  if (!flight) {
    flight = codexSessionPage(id, { identity }).then(page => {
      if (!runtimes.has(key) && runtimes.size >= 32) {
        const idle = [...runtimes].find(([, runtime]) => !runtime.hasViewers());
        if (!idle) throw new Error("打开的 Codex 会话过多，请关闭不再使用的页面");
        runtimes.delete(idle[0]);
      }
      // Reuse an in-flight projection only while it has viewers; otherwise take
      // a fresh authoritative snapshot after browser suspension or navigation.
      const runtime = new CodexRuntime(id, identity, page); runtimes.set(key, runtime); return runtime;
    }).finally(() => { flights.delete(key); });
    flights.set(key, flight);
  }
  return flight;
}
function queue(meta: CodexMeta) {
  const steering: NonNullable<CodexMeta["submissions"]> = [], followUp: NonNullable<CodexMeta["submissions"]> = [];
  let hasDeliveryStates = false;
  for (const row of meta.submissions || []) {
    if (!["queued", "unknown", "failed"].includes(row.status)) continue;
    (row.mode === "steer" ? steering : followUp).push(row);
    hasDeliveryStates ||= row.status !== "queued";
  }
  return { steering: steering.map(row => row.text), followUp: followUp.map(row => row.text),
    requestIds: { steering: steering.map(row => row.clientRequestId ?? null), followUp: followUp.map(row => row.clientRequestId ?? null) },
    ...(hasDeliveryStates ? { deliveryStates: [...steering, ...followUp].map(row => ({ status: row.status, ...(row.error ? { error: row.error } : {}) })) } : {}) };
}
const CODEX_POLL_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000, 5000];
function isRetryableBridgeFailure(error: unknown) {
  return Boolean(error && typeof error === "object" && "retryable" in error && error.retryable === true);
}
function waitForPollRetry(delay: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    if (signal.aborted) finish();
    else {
      timer = setTimeout(finish, delay);
      signal.addEventListener("abort", finish, { once: true });
    }
  });
}

export class CodexRuntime {
  private listeners = new Set<(event: AgentEventLike) => void>();
  private polling = false;
  private pollController: AbortController | null = null;
  private reachable = true;
  private publishedStreaming: boolean;
  private publishedQueue: string;
  private queueMutationGeneration = 0;
  private publishedUsage: string;
  private publishedComposer: string;
  private rows = new Map<string, CodexRow>();
  private assistantKey: string | null = null;
  private completedAssistantKeys = new Set<string>();
  private requests = new Map<string, { native: CodexRequest; event: AgentEventLike; questionId?: string }>();
  private answers = new Map<string, Record<string, string[]>>();
  streamingMessage: AgentMessage | null = null;
  meta: CodexMeta;
  constructor(readonly id: string, readonly identity: string, private page: CodexPage) {
    this.meta = page.meta;
    this.publishedQueue = JSON.stringify(queue(page.meta));
    this.publishedUsage = JSON.stringify(projectCodexUsage(page.meta));
    this.publishedComposer = codexComposerStatuses(page.meta)[0].text;
    this.publishedStreaming = this.isStreaming;
    for (const row of page.rows) this.rows.set(row.key, row);
    const last = page.rows.at(-1);
    const liveLast = this.isStreaming && last?.role === "assistant" && last.turnStatus === "inProgress";
    for (const row of page.rows) if (row.role === "assistant" && !(liveLast && row === last)) this.completedAssistantKeys.add(row.key);
    if (liveLast && last) {
      this.assistantKey = last.key; this.streamingMessage = assistantText(this.meta, last.text);
    }
    this.updateRequests();
  }
  private adoptMeta(incoming: CodexMeta, queueGeneration = this.queueMutationGeneration): CodexMeta {
    if (queueGeneration < this.queueMutationGeneration) incoming = { ...incoming, submissions: this.meta.submissions };
    // Queue/history polls may have started before a confirmed mode change.
    // Preserve only the newer composer snapshot; other runtime fields stay live.
    const validComposerState = (candidate: unknown): CodexMeta["composerState"] | undefined => {
      if (!candidate || typeof candidate !== "object") return undefined;
      const state = candidate as CodexMeta["composerState"];
      if (!state || state.version !== 1 || !["normal", "plan", "goal"].includes(state.mode)) return undefined;
      if (state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 0)) return undefined;
      return state;
    };
    const currentState = validComposerState(this.meta.composerState);
    const incomingState = validComposerState(incoming.composerState);
    const currentRevision = currentState?.revision;
    const incomingRevision = incomingState?.revision;
    // Only explicit revisions are comparable. Revision 0 is a valid first
    // snapshot. Legacy-only runtimes remain arrival-ordered; after a versioned
    // confirmation, an unversioned response cannot erase it.
    // Missing or malformed snapshots cannot erase a valid confirmed state.
    const preserveCurrent = !incomingState || (currentRevision !== undefined && (incomingRevision === undefined
      || incomingRevision < currentRevision));
    this.meta = preserveCurrent
      ? { ...incoming, composerState: currentState ?? incoming.composerState }
      : incoming;
    return this.meta;
  }
  private json(path: string, body?: unknown, options?: { signal?: AbortSignal }) {
    return codexBridgeJson(path, body, { connectionIdentity: this.identity, signal: options?.signal });
  }
  get isStreaming() { return this.meta.status === "active" || Boolean(this.meta.requests?.length); }
  isAlive() { return this.reachable; } // History-only views are valid even without an active executor.
  hasViewers() { return this.listeners.size > 0; }
  pendingRequests() { return [...this.requests.values()].map(r => r.event); }
  onEvent(listener: (event: AgentEventLike) => void) {
    this.listeners.add(listener);
    // Publish the current queue on every subscription, even when it has not
    // changed. Waiting for a later history/state read leaves a false empty UI.
    listener({ type: "queue_update", ...queue(this.meta) });
    listener({type:"session_usage",sessionId:this.id,usage:projectCodexUsage(this.meta)});
    listener(this.composerEvent());
    for (const event of this.pendingRequests()) listener(event);
    if (!this.polling) void this.poll();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.pollController?.abort();
    };
  }
  private emit(event: AgentEventLike) { for (const listener of this.listeners) listener(event); }
  private composerEvent(): AgentEventLike {
    return { type: "extension_ui_request", id: "codex-composer:" + this.id,
      method: "setStatus", statusKey: "composer-modes", statusText: codexComposerStatuses(this.meta)[0].text };
  }
  private publishComposer() {
    const text = codexComposerStatuses(this.meta)[0].text;
    if (text !== this.publishedComposer) {
      this.publishedComposer = text;
      this.emit(this.composerEvent());
    }
  }
  private updateRequests() {
    const next = new Map<string, { native: CodexRequest; event: AgentEventLike; questionId?: string }>();
    for (const request of this.meta.requests || []) {
      const base = "codex-request:" + request.id;
      if (request.supported && ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(request.method)) {
        const labels: Record<string, string> = { accept: "允许本次", decline: "拒绝", cancel: "取消本次任务" };
        const decisions = request.params.availableDecisions || ["accept", "decline", ...(request.method.includes("permissions") ? [] : ["cancel"])];
        const options = decisions.filter((d: string) => d in labels).map((d: string) => labels[d]);
        next.set(base, { native: request, event: { type: "extension_ui_request", id: base, method: "select",
          title: "Codex 需要确认：" + (request.params.command || request.params.reason || "修改工作区权限"), options } });
      } else if (request.supported && ["item/tool/requestUserInput", "tool/requestUserInput", "bridge/requestUserInputAsync"].includes(request.method)) {
        const answered = this.answers.get(String(request.id)) || {};
        for (const question of request.params.questions || []) if (!answered[question.id]) {
          const id = base + ":" + question.id;
          const options = question.options?.map((o: { label: string; description?: string }) => o.label + (o.description ? " — " + o.description : ""));
          next.set(id, { native: request, questionId: question.id, event: { type: "extension_ui_request", id,
            method: "input", title: [question.question, options?.join("\n")].filter(Boolean).join("\n") } });
        }
      } else {
        next.set(base, { native: request, event: { type: "extension_ui_request", id: base, method: "notify", notifyType: "warning", recovery: "codex-client",
          message: "Codex 有一项操作需要你处理，当前网页暂不支持。请回到发起任务的 Codex 客户端，打开同一会话查看并处理；无需因此停止任务。" } });
      }
    }
    // A native response/interrupt may resolve a request in another client.
    // Drop its partial answers instead of retaining stale per-request state.
    const pendingIds = new Set((this.meta.requests || []).map(request => String(request.id)));
    for (const id of this.answers.keys()) if (!pendingIds.has(id)) this.answers.delete(id);
    for (const id of this.requests.keys()) if (!next.has(id)) this.emit({ type: "extension_ui_closed", id });
    for (const [id, item] of next) if (!this.requests.has(id)) this.emit(item.event);
    this.requests = next;
  }
  private finishAssistant() {
    if (this.streamingMessage && this.assistantKey && !this.completedAssistantKeys.has(this.assistantKey)) {
      this.emit({ type: "message_end", entryId: this.assistantKey + ":0", message: this.streamingMessage });
      this.completedAssistantKeys.add(this.assistantKey);
    }
    this.streamingMessage = null; this.assistantKey = null;
  }
  hasConfirmedDelivery(requestId: string) {
    return [...this.rows.values()].some(row => row.role === "user" && row.requestId === requestId && row.deliveryConfirmed === true);
  }
  private async accept(next: CodexPage, queueGeneration = this.queueMutationGeneration) {
    // A concurrent get_state/settings read can refresh meta before this poll.
    // Lifecycle edges belong to the event stream, not to those read snapshots.
    const wasActive = this.publishedStreaming;
    const nextActive = next.meta.status === "active" || Boolean(next.meta.requests?.length);
    // Resolve fallible answer reads before publishing or consuming this batch.
    // A failed detail request must leave its row version and completion edge
    // available to the existing changes-loop retry.
    const answerBodies = new Map<string, string>();
    for (const row of next.rows) {
      if (row.role === "assistant" && this.rows.get(row.key)?.version !== row.version
        && !this.completedAssistantKeys.has(row.key) && (nextActive || wasActive)
        && !(next.reset && row.turnStatus !== "inProgress")) {
        answerBodies.set(row.key, await rowText(this.id, next.epoch, row, this.identity));
      }
    }
    this.adoptMeta(next.meta, queueGeneration);
    const queueSnapshot = queue(this.meta);
    this.publishComposer();
    this.publishedStreaming = this.isStreaming;
    const usage=projectCodexUsage(this.meta),usageKey=JSON.stringify(usage);
    if (usageKey!==this.publishedUsage) {
      this.publishedUsage=usageKey;
      this.emit({type:"session_usage",sessionId:this.id,usage});
    }
    this.updateRequests();
    if (this.isStreaming && !wasActive) this.emit({ type: "agent_start" });
    let historyChanged = Boolean(next.reset);
    // Reset is a full authoritative snapshot, not permission to replay saved
    // assistant entries into the native append-only event channel.
    for (const row of next.rows) {
      const prior = this.rows.get(row.key);
      this.rows.set(row.key, row);
      if (prior?.version === row.version && (row.role === "assistant" || row.kind === "reasoning" || (prior?.turnStatus === row.turnStatus && prior?.status === row.status))) continue;
      if (row.role === "assistant") {
        // Completion can precede the saved final answer, and reconnects can
        // reveal missed/corrected completed rows. Reconcile the authoritative
        // transcript instead of dropping them or replaying saved bubbles.
        if (this.completedAssistantKeys.has(row.key) || !(this.isStreaming || wasActive)
          || (next.reset && row.turnStatus !== "inProgress")) {
          this.completedAssistantKeys.add(row.key);
          historyChanged = true;
          continue;
        }
        if (this.assistantKey && this.assistantKey !== row.key) this.finishAssistant();
        this.assistantKey = row.key;
        this.streamingMessage = assistantText(this.meta, answerBodies.get(row.key)!);
        this.emit({ type: "message_start", message: this.streamingMessage });
      } else if (row.role === "user") {
        this.emit({ type: "message_end", entryId: row.key + ":0", ...(row.requestId ? { requestId: row.requestId } : {}), message: projectCodexRow(row, this.meta)[0], queuedMessages: queueSnapshot });
        // Only the durable user echo completes handoff; queue admission alone
        // keeps the original in both the server inbox and browser outbox.
        if (row.requestId && row.deliveryConfirmed === true) {
          try {
            await commitPromptDelivery(this.id, row.requestId, { handled: true });
            this.emit({ type: "prompt_delivery", requestId: row.requestId, receipt: { status: "committed", entryId: row.key + ":0" } });
          } catch { markPromptDeliveryUnconfirmed(this.id, row.requestId); }
        }
      } else if (row.role === "activity" && row.kind === "reasoning" && (this.isStreaming || wasActive)) {
        this.emit({ type: "message_end", message: { ...assistantText(this.meta, ""), content: [{ type: "thinking", thinking: row.text }] } });
      } else if (row.role === "activity" && (this.isStreaming || wasActive)) {
        this.finishAssistant();
        const name = row.kind === "commandExecution" ? "bash" : "codex_tool";
        if (!prior) {
          const call = projectCodexRow(row, this.meta)[0];
          this.emit({ type: "message_start", message: call });
          this.emit({ type: "message_end", message: call });
          this.emit({ type: "tool_execution_start", toolCallId: row.key, toolName: name, args: { command: row.text } });
        }
        // Tool bodies use the same lazy-detail contract as saved history.
        // Their latency or failure must not block a later final answer.
        const result = projectCodexRow(row, this.meta, next.epoch).find(message => message.role === "toolResult")!;
        this.emit({ type: row.status === "inProgress" ? "tool_execution_update" : "tool_execution_end", toolCallId: row.key, toolName: name, partialResult: result });
        if (row.status !== "inProgress") this.emit({ type: "message_end", message: result });
      } else if (row.role === "error") {
        this.emit({ type: "prompt_error", errorMessage: row.text });
      }
    }
    // Delivered user events carry the same queue snapshot. Publish them first
    // so consumption never removes the only visible copy. Unchanged long polls
    // need no queue event or React render.
    const nextQueue = JSON.stringify(queueSnapshot);
    if (nextQueue !== this.publishedQueue) {
      this.publishedQueue = nextQueue;
      this.emit({ type: "queue_update", ...queueSnapshot });
    }
    this.page = { ...next, before: next.before || this.page.before };
    if (historyChanged) this.emit({ type: "session_history_changed" });
    if ((wasActive && !this.isStreaming) || (next.rows.length && !this.isStreaming)) {
      this.finishAssistant();
      this.emit({ type: "agent_end" }); this.emit({ type: "agent_settled" }); this.emit({ type: "prompt_done" });
    }
    while (this.rows.size > 150) {
      const oldest = this.rows.keys().next().value!;
      this.rows.delete(oldest); this.completedAssistantKeys.delete(oldest);
    }
  }
  private async poll() {
    if (this.polling || !this.listeners.size || !this.reachable) return;
    this.polling = true;
    const controller = new AbortController();
    this.pollController = controller;
    let retry = 0;
    try {
      while (this.listeners.size && !controller.signal.aborted && this.reachable) {
        try {
          const query = new URLSearchParams({ after: String(this.page.sequence), epoch: this.page.epoch, start: this.page.before || "" });
          const queueGeneration = this.queueMutationGeneration;
          const next = await this.json(`/api/sessions/${codexThreadId(this.id)}/changes?${query}`, undefined, { signal: controller.signal });
          await this.accept(next, queueGeneration);
          retry = 0;
        } catch (error) {
          if (controller.signal.aborted || !this.listeners.size || (error instanceof Error && error.name === "AbortError")) break;
          if (!isRetryableBridgeFailure(error)) {
            this.reachable = false;
            this.emit({ type: "session_shutdown" });
            break;
          }
          const delay = CODEX_POLL_RETRY_DELAYS_MS[Math.min(retry++, CODEX_POLL_RETRY_DELAYS_MS.length - 1)];
          await waitForPollRetry(delay, controller.signal);
        }
      }
    } finally {
      this.polling = false;
      if (this.pollController === controller) this.pollController = null;
      if (this.listeners.size && this.reachable) void this.poll();
    }
  }
  async send(command: Record<string, unknown>): Promise<unknown> {
    const queueGeneration = this.queueMutationGeneration;
    const base = `/api/sessions/${codexThreadId(this.id)}`;
    switch (command.type) {
      case "get_queue_actions":
      case "get_queued_message":
      case "promote_queued_message":
      case "recall_queued_message":
      case "delete_queued_message":
      case "recall_all_queued_messages":
      case "reorder_queued_message":
      case "clear_queue": {
        const result = await this.json(base + "/queue", command);
        const recalled = new Set<string>(result.recalledPromptRequestIds || []);
        for (const requestId of result.cancelledPromptRequestIds || []) {
          if (recalled.has(requestId)) recallPromptDelivery(this.id, requestId);
          else cancelPromptDelivery(this.id, requestId);
        }
        if (!["get_queue_actions", "get_queued_message"].includes(String(command.type))) {
          this.queueMutationGeneration++;
          if (Array.isArray(result.queuedSubmissions)) this.meta = { ...this.meta, submissions: result.queuedSubmissions };
        }
        if (queueGeneration < this.queueMutationGeneration && ["get_queue_actions", "get_queued_message"].includes(String(command.type)) && result.queuedMessages) result.queuedMessages = queue(this.meta);
        if (result.queuedMessages) {
          this.publishedQueue = JSON.stringify(result.queuedMessages);
          this.emit({ type: "queue_update", ...result.queuedMessages });
        }
        return result;
      }
      case "get_commands": return { commands: [] };
      case "get_tools": return [];
      case "get_session_stats": {
        const view=await this.json(base + "?metadata=1") as CodexMeta;
        const usage=projectCodexUsage(view);
        const {mergeSessionStats}=await import("../session-stats");
        const stats=mergeSessionStats(undefined,[],[...this.rows.values()].flatMap(row=>projectCodexRow(row,view)));
        return {sessionId:this.id,sessionFile:this.id,sessionName:view.title,...stats,
          tokens:usage.tokens??{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},
          tokenUsageAvailable:usage.tokens!==null,messageCountsScope:"loaded",contextUsage:usage.contextUsage};
      }
      case "get_state": {
        const view = await this.json(base + "?metadata=1") as CodexMeta;
        this.adoptMeta(view, queueGeneration);
        this.updateRequests();
        return { model: { provider: "codex", id: view.model }, thinkingLevel: view.effort === "none" ? "off" : view.effort || "high",
          isStreaming: this.isStreaming, isPromptRunning: this.isStreaming, isBashRunning: false, isCompacting: false,
          autoCompactionEnabled: false, contextUsage: projectCodexUsage(view).contextUsage,
          queuedMessages: queue(this.meta), extensionStatuses: codexComposerStatuses(this.meta), extensionWidgets: [] };
      }
      case "set_composer_mode": {
        if (!["normal", "plan", "goal"].includes(String(command.mode))) throw new Error("模式参数无效");
        const view = await this.json(base + "/composer", { mode: command.mode }) as CodexMeta;
        if (view.composerState?.mode !== command.mode) throw new Error("Codex 模式切换尚未确认，消息未发送");
        this.adoptMeta(view, queueGeneration);
        this.publishComposer();
        return { extensionStatuses: codexComposerStatuses(this.meta) };
      }
      case "composer_goal_action": {
        if (!["pause", "resume"].includes(String(command.action))) throw new Error("目标操作无效");
        const receipt = await this.json(base + "/goal/status", { id: randomUUID(),
          status: command.action === "pause" ? "paused" : "active", expected: command.expected });
        if (receipt.confirmed !== true) throw new Error("Codex 目标操作结果待确认，不会自动重发");
        const view = await this.json(base + "?metadata=1") as CodexMeta;
        const expectedStatus = command.action === "pause" ? "paused" : "active";
        if (view.composerState?.goalStatus !== expectedStatus) throw new CodexBridgeError("Codex 目标操作尚未确认，请刷新状态。", 409, "codex_session_refresh", false, false);
        this.adoptMeta(view, queueGeneration);
        this.publishComposer();
        return { extensionStatuses: codexComposerStatuses(this.meta) };
      }
      case "prompt": {
        if (typeof command.message !== "string" || typeof command.requestId !== "string") throw new Error("消息内容或请求标识不正确");
        const attachments: string[] = [];
        if (Array.isArray(command.images)) {
          if (command.images.length > 10) throw new Error("最多添加 10 张图片");
          for (let index = 0; index < command.images.length; index++) {
            const image = command.images[index] as { data: string; mimeType: string };
            if (typeof image.data !== "string" || image.data.length > 28 * 1024 * 1024 || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(image.mimeType)) throw new Error("图片格式或大小不受支持");
            const upload = submissionUuid(command.requestId + ":image:" + index);
            const suffix = ({ "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" })[image.mimeType];
            const query = new URLSearchParams({ id: upload, name: `图片-${index + 1}.${suffix}` });
            const result = await (await codexBridgeRequest(base + "/uploads?" + query, undefined,
              { bytes: Buffer.from(image.data, "base64"), contentType: image.mimeType, connectionIdentity: this.identity })).json();
            attachments.push(result.id);
          }
        }
        const behavior = command.streamingBehavior;
        const mode = behavior === "steer" ? "steer" : behavior === "followUp" ? "queue" : "auto";
        let result;
        try {
          result = await this.json(base + "/send", { id: submissionUuid(command.requestId), clientRequestId: command.requestId, text: command.message, attachments, mode, uiLocale: "zh-CN" });
        } catch (error) {
          // Timeout/5xx can occur after the executor accepted the turn.
          if (!(error && typeof error === "object" && "status" in error && Number(error.status) < 500)) throw Object.assign(new Error("Codex 发送结果待确认，请核对记录，不要重复发送"), { deliveryUncertain: true });
          throw error;
        }
        if (result.status === "failed") throw new CodexBridgeError(result.error || "Codex 拒绝发送，内容已保留", 409, "submission_rejected", false, false);
        if (!["accepted", "queued"].includes(result.status)) throw Object.assign(new Error(result.error || "Codex 发送结果待确认，请核对记录，不要重复发送"), { deliveryUncertain: true });
        if (result.composerState) {
          this.adoptMeta({ ...this.meta, composerState: result.composerState });
          this.publishComposer();
        }
        // Accepted/queued is admission, not evidence that the original user
        // message has reached history. Preserve its recoverable inbox content.
        if (result.id === submissionUuid(command.requestId) && result.nativeQueueConfirmed === true && typeof result.nativeQueueId === "string") {
          // The original native queue now durably owns the exact input. This is
          // a completed handoff, including when the HTTP/SSE response is lost.
          this.queueMutationGeneration++;
          if (Array.isArray(result.queuedSubmissions)) {
            this.meta = { ...this.meta, submissions: result.queuedSubmissions };
            const snapshot = queue(this.meta), key = JSON.stringify(snapshot);
            if (key !== this.publishedQueue) {
              this.publishedQueue = key;
              this.emit({ type: "queue_update", ...snapshot });
            }
          }
          await commitPromptDelivery(this.id, command.requestId, { handled: true });
        } else acceptPromptDelivery(this.id, command.requestId);
        return result;
      }
      case "abort": return this.json(base + "/stop", {});
      case "set_model": {
        const view = await this.json(base + "/settings", { model: command.modelId, effort: this.meta.effort || "high" }) as CodexMeta;
        this.adoptMeta(view, queueGeneration); return { provider: "codex", id: view.model };
      }
      case "set_thinking_level": {
        const view = await this.json(base + "/settings", { model: this.meta.model, effort: command.level === "off" ? "none" : command.level }) as CodexMeta;
        this.adoptMeta(view, queueGeneration); return { thinkingLevel: view.effort === "none" ? "off" : view.effort };
      }
      case "set_session_name": return this.json(base + "/rename", { title: command.name });
      case "get_messages": return (await readCodexSession(this.id) as ReturnType<typeof projectCodexPage>).context.messages;
      case "get_last_assistant_text": return { text: [...this.rows.values()].filter(r => r.role === "assistant").at(-1)?.text || "" };
      case "extension_ui_response": {
        const id = String(command.id), item = this.requests.get(id);
        if (!item) throw new CodexBridgeError("该确认已处理或已失效，请刷新会话状态。", 409, "codex_session_refresh", false, false);
        if (item.questionId) {
          if (command.cancelled) {
            if (item.native.method === "bridge/requestUserInputAsync") return {};
            throw new Error("回答尚未提交，请重新打开此会话继续回答");
          }
          if (typeof command.value !== "string" || !command.value.trim()) throw new Error("请输入回答");
          const answers = this.answers.get(String(item.native.id)) || {};
          answers[item.questionId] = [command.value]; this.answers.set(String(item.native.id), answers);
          this.updateRequests();
          if ((item.native.params.questions || []).some((q: { id: string }) => !answers[q.id])) return {};
          try {
            const result = await this.json(base + "/respond", { requestId: item.native.id, response: { answers } });
            // Async replies can be admitted before their durable user echo is
            // visible. Keep answered identities until the native request leaves.
            if (item.native.method !== "bridge/requestUserInputAsync") this.answers.delete(String(item.native.id));
            return result;
          } catch (error) {
            delete answers[item.questionId];
            this.updateRequests();
            throw error;
          }
        }
        const labels: Record<string, string> = { "允许本次": "accept", "拒绝": "decline", "取消本次任务": "cancel" };
        const decision = command.cancelled ? (item.native.method.includes("permissions") ? "decline" : "cancel") : labels[String(command.value)];
        if (!decision) throw new Error("请选择允许、拒绝或取消");
        return this.json(base + "/respond", { requestId: item.native.id, response: { decision } });
      }
      default: throw new CodexBridgeError("当前网页暂不支持这项 Codex 操作，请查看处理方式。", 501, "codex_operation_unsupported", false, false);
    }
  }
}

// Explicit search shares the native result component. It never resumes a thread,
// starts a model, or scans indefinitely; partial scope is shown by that component.
export async function searchCodexSessions(query: string, signal: AbortSignal) {
  const response: import("../session-search").SessionSearchResponse = { results: [], truncated: false };
  if (!query) return response;
  const identity = await codexConnectionIdentity();
  if (catalogGlobals[catalogKey]?.identity !== identity) await listCodexSessions();
  const rows = catalogGlobals[catalogKey]?.rows || [];
  const deadline = Date.now() + 3000, needle = query.toLocaleLowerCase();
  for (const [i, row] of rows.entries()) {
    if (i >= 30 || Date.now() >= deadline || signal.aborted || response.results.length >= 30) { response.truncated = true; break; }
    const session = projectCodexSession(row);
    try {
      const page = await codexSessionPage(session.id, { identity, limit: 50, signal, timeout: Math.max(1, Math.min(1000, deadline - Date.now())) });
      if (page.hasMore || page.meta.historyComplete === false) response.truncated = true;
      const projected = projectCodexPage(page, session.id);
      const messages = projected.context.messages;
      let found = false;
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.type === "text" ? b.text : "").join("\n");
        const at = text.toLocaleLowerCase().indexOf(needle);
        if (at < 0) continue;
        response.results.push({ session, entryId: projected.context.entryIds[index], blockIndex: 0,
          before: text.slice(Math.max(0, at - 80), at), match: text.slice(at, at + query.length), after: text.slice(at + query.length, at + query.length + 80) });
        found = true; break;
      }
      if (!found) {
        const title = row.title + " " + row.cwd, at = title.toLocaleLowerCase().indexOf(needle);
        if (at >= 0) response.results.push({ session, blockIndex: 0, before: title.slice(Math.max(0,at-80),at), match: title.slice(at,at+query.length), after: title.slice(at+query.length,at+query.length+80) });
      }
    } catch { response.truncated = true; }
  }
  return response;
}
