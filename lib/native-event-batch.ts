import {
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";
import {
  extractSessionSnapshotEvents,
  TOOL_UPDATE_COALESCE_MS,
  type AgentEventStreamSession,
} from "./agent-event-stream";
import { acquireSessionLivenessLease, type SessionLivenessLease } from "./session-liveness";
import { subscribePromptDeliveries } from "./prompt-delivery";

export const PROCESS_EPOCH = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const BATCH_HUB_INACTIVITY_TTL_MS = 90_000;
export const DEFAULT_RING_CAPACITY = 1000;
export const DEFAULT_RING_BYTES_LIMIT = 4 * 1024 * 1024;
let nextHubGeneration = 0;

export interface BufferedSessionEvent {
  seq: number;
  event: AgentEventLike;
  bytes: number;
}

export class SessionEventRingBuffer {
  public readonly maxItems: number;
  public readonly maxBytes: number;
  private items: BufferedSessionEvent[] = [];
  private totalBytes = 0;
  private _oldestSeq = 0;
  private _latestSeq = 0;

  constructor(
    maxItems = DEFAULT_RING_CAPACITY,
    maxBytes = DEFAULT_RING_BYTES_LIMIT,
  ) {
    this.maxItems = maxItems;
    this.maxBytes = maxBytes;
  }

  get oldestSeq(): number {
    return this._oldestSeq;
  }

  get latestSeq(): number {
    return this._latestSeq;
  }

  push(event: AgentEventLike): number {
    const serialized = JSON.stringify(event) ?? "null";
    const bytes = Buffer.byteLength(serialized, "utf8");
    const snapshot = JSON.parse(serialized) as AgentEventLike;
    this._latestSeq += 1;
    const seq = this._latestSeq;

    if (bytes > this.maxBytes) {
      this.items = [];
      this.totalBytes = 0;
      this._oldestSeq = seq + 1;
      return seq;
    }

    this.items.push({ seq, event: snapshot, bytes });
    this.totalBytes += bytes;

    let dropped = false;
    while (
      this.items.length > 0 &&
      (this.items.length > this.maxItems || this.totalBytes > this.maxBytes)
    ) {
      const shifted = this.items.shift();
      if (shifted) {
        this.totalBytes -= shifted.bytes;
        dropped = true;
      }
    }

    if (dropped) {
      this._oldestSeq = this.items[0]?.seq ?? this._latestSeq + 1;
    }

    return seq;
  }

  getEventsAfter(seq: number): AgentEventLike[] {
    if (seq >= this._latestSeq) return [];
    return this.items.filter((item) => item.seq > seq).map((item) => item.event);
  }

  clear(): void {
    this.items = [];
    this.totalBytes = 0;
    this._oldestSeq = 0;
    this._latestSeq = 0;
  }
}

export interface SessionBatchResponsePayload {
  reset: boolean;
  epoch: string;
  cursor: string | null;
  events: AgentEventLike[];
}

export class SessionEventHub {
  public readonly sessionId: string;
  public readonly epoch: string;
  private readonly sessionPromise: Promise<AgentEventStreamSession>;
  public readonly ringBuffer: SessionEventRingBuffer;
  private lease: SessionLivenessLease;
  private unsubscribeSession: (() => void) | null = null;
  private unsubscribeInbox: (() => void) | null = null;
  private pendingToolUpdates = new Map<unknown, AgentEventLike>();
  private toolUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestedAt = Date.now();
  private initialEvents: AgentEventLike[] = [];
  private sessionInstance: AgentEventStreamSession | null = null;

  public startupError: AgentEventLike | null = null;
  public destroyed = false;
  public ready = false;
  public readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private readySettled = false;

  constructor(
    sessionId: string,
    sessionPromise: Promise<AgentEventStreamSession>,
    ringCapacity = DEFAULT_RING_CAPACITY,
    ringBytesLimit = DEFAULT_RING_BYTES_LIMIT,
  ) {
    this.sessionId = sessionId;
    this.epoch = `${PROCESS_EPOCH}.${(++nextHubGeneration).toString(36)}`;
    this.sessionPromise = sessionPromise;
    this.ringBuffer = new SessionEventRingBuffer(ringCapacity, ringBytesLimit);
    this.lease = acquireSessionLivenessLease(sessionId);

    this.readyPromise = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });

    this.start();
    this.scheduleInactivity();
  }

  public currentCursor(): string {
    return `${this.epoch}:${this.ringBuffer.latestSeq}`;
  }

  public getInitialEvents(): AgentEventLike[] {
    return this.initialEvents;
  }

  public getFreshSnapshotEvents(): AgentEventLike[] {
    if (!this.sessionInstance) {
      return this.initialEvents;
    }
    const { snapshotEvents } = extractSessionSnapshotEvents(
      this.sessionInstance,
      this.sessionId,
      [],
    );
    return snapshotEvents;
  }

  public touch(): void {
    if (this.destroyed) return;
    this.lastRequestedAt = Date.now();
    this.lease.renew();
    this.scheduleInactivity();
  }

  private scheduleInactivity(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = setTimeout(() => {
      if (Date.now() - this.lastRequestedAt >= BATCH_HUB_INACTIVITY_TTL_MS) {
        this.destroy();
      }
    }, BATCH_HUB_INACTIVITY_TTL_MS);
    this.inactivityTimer.unref?.();
  }

  private flushToolUpdates = (): void => {
    this.toolUpdateTimer = null;
    const updates = [...this.pendingToolUpdates.values()];
    this.pendingToolUpdates.clear();
    for (const update of updates) {
      this.ringBuffer.push(update);
    }
  };

  private sendClientEvent(clientEvent: AgentEventLike): void {
    if (clientEvent.type === "tool_execution_update") {
      this.pendingToolUpdates.set(clientEvent.toolCallId, clientEvent);
      this.toolUpdateTimer ??= setTimeout(this.flushToolUpdates, TOOL_UPDATE_COALESCE_MS);
      return;
    }
    if (clientEvent.type === "tool_execution_end") {
      this.pendingToolUpdates.delete(clientEvent.toolCallId);
    } else if (clientEvent.type === "agent_end") {
      this.pendingToolUpdates.clear();
    }
    this.ringBuffer.push(clientEvent);
  }

  private forwardEvent(event: AgentEventLike): void {
    const clientEvent = toClientAgentEvent(event);
    if (clientEvent) {
      this.sendClientEvent(clientEvent);
    }
  }

  private settleReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private start(): void {
    // Inbox admission updates
    this.unsubscribeInbox = subscribePromptDeliveries(this.sessionId, (requestId, receipt) => {
      if (this.destroyed) return;
      this.sendClientEvent({ type: "prompt_delivery", requestId, receipt });
      this.sendClientEvent({ type: "prompt_inbox_changed" });
    });

    void (async () => {
      try {
        const session = await this.sessionPromise;
        if (this.destroyed) return;
        this.sessionInstance = session;

        if (session.isAlive && !session.isAlive()) {
          this.destroy();
          return;
        }

        const bufferedEvents: AgentEventLike[] = [];
        let snapshotPublished = false;

        const handleEvent = (event: AgentEventLike) => {
          if (event.type === "session_shutdown") {
            this.destroy();
            return;
          }
          if (!snapshotPublished) {
            bufferedEvents.push(event);
            return;
          }
          this.forwardEvent(event);
        };

        const stopListening = session.onEvent(handleEvent);
        if (this.destroyed) {
          stopListening();
          this.settleReady();
          return;
        }
        if (session.isAlive && !session.isAlive()) {
          stopListening();
          this.destroy();
          this.settleReady();
          return;
        }
        this.unsubscribeSession = stopListening;

        const { snapshotEvents } = extractSessionSnapshotEvents(
          session,
          this.sessionId,
          bufferedEvents,
        );
        this.initialEvents = snapshotEvents;
        snapshotPublished = true;
        this.ready = true;
        this.settleReady();
      } catch (error) {
        if (this.destroyed) {
          this.settleReady();
          return;
        }
        const retryable = Boolean(
          error && typeof error === "object" && "retryable" in error && error.retryable === true,
        );
        this.startupError = {
          type: "startup_error",
          errorMessage: `Failed to start agent: ${error instanceof Error ? error.message : String(error)}`,
          ...(retryable ? { retryable: true } : {}),
        };
        this.ready = true;
        this.settleReady();
      }
    })();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.settleReady();
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    if (this.toolUpdateTimer) clearTimeout(this.toolUpdateTimer);
    this.inactivityTimer = null;
    this.toolUpdateTimer = null;
    this.pendingToolUpdates.clear();
    this.unsubscribeInbox?.();
    this.unsubscribeInbox = null;
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.lease.release();
    removeHubFromRegistry(this.sessionId, this);
  }
}

const HUB_REGISTRY_SYMBOL = Symbol.for("pi-web.sessionEventHubs");
type HubRegistry = Map<string, SessionEventHub>;

function getHubRegistry(): HubRegistry {
  const g = globalThis as Record<symbol, HubRegistry>;
  if (!g[HUB_REGISTRY_SYMBOL]) {
    g[HUB_REGISTRY_SYMBOL] = new Map<string, SessionEventHub>();
    const shutdown = () => {
      for (const hub of [...g[HUB_REGISTRY_SYMBOL].values()]) {
        hub.destroy();
      }
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    process.once("exit", shutdown);
  }
  return g[HUB_REGISTRY_SYMBOL];
}

function removeHubFromRegistry(sessionId: string, hub: SessionEventHub): void {
  const reg = getHubRegistry();
  if (reg.get(sessionId) === hub) {
    reg.delete(sessionId);
  }
}

export function getOrCreateSessionEventHub(
  sessionId: string,
  sessionResolver: () => Promise<AgentEventStreamSession>,
): SessionEventHub {
  const reg = getHubRegistry();
  let hub = reg.get(sessionId);
  if (!hub || hub.destroyed) {
    hub = new SessionEventHub(sessionId, sessionResolver());
    reg.set(sessionId, hub);
  } else {
    hub.touch();
  }
  return hub;
}

export function closeAllSessionEventHubs(): void {
  const reg = getHubRegistry();
  for (const hub of [...reg.values()]) {
    hub.destroy();
  }
  reg.clear();
}

/**
 * Handles short-batch event polling for agent sessions.
 * Releases HTTP socket on every response.
 */
export async function handleAgentEventBatchRequest(
  req: Request,
  sessionId: string,
  sessionResolver: () => Promise<AgentEventStreamSession>,
): Promise<Response> {
  if (req.signal.aborted) {
    return new Response(null, { status: 204 });
  }

  const url = new URL(req.url);
  const cursor = url.searchParams.get("cursor");

  const hub = getOrCreateSessionEventHub(sessionId, sessionResolver);
  hub.touch();

  await hub.readyPromise;

  if (req.signal.aborted) {
    return new Response(null, { status: 204 });
  }
  if (hub.destroyed) {
    return new Response(null, { status: 204 });
  }

  if (hub.startupError) {
    const payload: SessionBatchResponsePayload = {
      reset: false,
      epoch: hub.epoch,
      cursor: null,
      events: [hub.startupError],
    };
    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-cache, no-store, no-transform",
      },
    });
  }

  // 首次连接：未提供 cursor，返回新鲜初始快照，不重放历史
  if (!cursor) {
    const events = hub.getFreshSnapshotEvents();
    const payload: SessionBatchResponsePayload = {
      reset: false,
      epoch: hub.epoch,
      cursor: hub.currentCursor(),
      events,
    };
    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-cache, no-store, no-transform",
      },
    });
  }

  // 解析客户端提供的 cursor：${hubEpoch}:${seq}
  const separator = cursor.lastIndexOf(":");
  const clientEpoch = separator > 0 ? cursor.slice(0, separator) : "";
  const seqText = separator > 0 ? cursor.slice(separator + 1) : "";
  const clientSeq = Number(seqText);

  const isValidSeq = /^\d+$/.test(seqText) && Number.isSafeInteger(clientSeq) && clientSeq >= 0;
  const isEpochMatch = clientEpoch === hub.epoch;
  const isOverflow = isValidSeq && hub.ringBuffer.oldestSeq > 0 && clientSeq < hub.ringBuffer.oldestSeq - 1;
  const isFutureSeq = isValidSeq && clientSeq > hub.ringBuffer.latestSeq;

  // Epoch 不匹配、Seq 非法、已发生 RingBuffer 溢出，显式 reset，推送新鲜快照恢复
  if (!isEpochMatch || !isValidSeq || isOverflow || isFutureSeq) {
    const events = hub.getFreshSnapshotEvents();
    const payload: SessionBatchResponsePayload = {
      reset: true,
      epoch: hub.epoch,
      cursor: hub.currentCursor(),
      events,
    };
    return Response.json(payload, {
      headers: {
        "Cache-Control": "no-cache, no-store, no-transform",
      },
    });
  }

  // 正常增量抓取
  const deltaEvents = hub.ringBuffer.getEventsAfter(clientSeq);
  const payload: SessionBatchResponsePayload = {
    reset: false,
    epoch: hub.epoch,
    cursor: hub.currentCursor(),
    events: deltaEvents,
  };

  return Response.json(payload, {
    headers: {
      "Cache-Control": "no-cache, no-store, no-transform",
    },
  });
}
