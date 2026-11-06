import { beginConnectionAttempt } from "./connection-diagnostics-client.ts";
import type { AgentEventSourceLike } from "./agent-event-connection";
import type { AgentEventLike } from "./agent-event-wire";
import type { SessionBatchResponsePayload } from "./native-event-batch";

export type EventSourceListener = (event: MessageEvent<string> | Event) => void;
export const DEFAULT_BATCH_POLL_TIMEOUT_MS = 65_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionBatchResponse(value: unknown): SessionBatchResponsePayload {
  if (!isRecord(value) || typeof value.reset !== "boolean" || typeof value.epoch !== "string" || !value.epoch) {
    throw new SyntaxError("Invalid batch event response");
  }
  if (!Array.isArray(value.events) || !value.events.every((event) =>
    isRecord(event) && typeof event.type === "string" && event.type.length > 0 && event.type.trim() === event.type
  )) {
    throw new SyntaxError("Invalid batch event list");
  }

  const events = value.events as AgentEventLike[];
  if (value.cursor === null) {
    if (events.length !== 1 || events[0].type !== "startup_error" || value.reset) {
      throw new SyntaxError("Invalid batch event cursor");
    }
  } else if (typeof value.cursor === "string") {
    const separator = value.cursor.lastIndexOf(":");
    const seqText = separator > 0 ? value.cursor.slice(separator + 1) : "";
    if (
      separator < 1
      || value.cursor.slice(0, separator) !== value.epoch
      || !/^\d+$/.test(seqText)
      || !Number.isSafeInteger(Number(seqText))
    ) {
      throw new SyntaxError("Invalid batch event cursor");
    }
  } else {
    throw new SyntaxError("Invalid batch event cursor");
  }

  return {
    reset: value.reset,
    epoch: value.epoch,
    cursor: value.cursor as string | null,
    events,
  };
}

export class BatchEventSource implements AgentEventSourceLike {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSED = 2;

  public readyState = BatchEventSource.CONNECTING;
  public onmessage: ((event: MessageEvent<string>) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onopen: ((event: Event) => void) | null = null;

  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abortController: AbortController | null = null;
  private cursor: string | null = null;
  private epoch: string | null = null;
  private isStreaming = false;
  private hasPendingQueue = false;
  private readonly listeners = new Map<string, Set<EventSourceListener>>();

  constructor(
    public readonly sessionId: string,
    private readonly activePollIntervalMs = 250,
    private readonly idlePollIntervalMs = 1000,
    private readonly requestTimeoutMs = DEFAULT_BATCH_POLL_TIMEOUT_MS,
  ) {
    this.schedule(0);
  }

  public addEventListener(type: string, listener: EventSourceListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  public removeEventListener(type: string, listener: EventSourceListener): void {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(type);
      }
    }
  }

  public dispatchEvent(event: Event): boolean {
    const set = this.listeners.get(event.type);
    if (set) {
      for (const listener of set) {
        try {
          listener(event);
        } catch (e) {
          console.error("[pi-web] BatchEventSource listener error:", e);
        }
      }
    }
    return true;
  }

  public close(): void {
    if (this.readyState === BatchEventSource.CLOSED) return;
    this.readyState = BatchEventSource.CLOSED;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.listeners.clear();
  }

  private schedule(delayMs: number): void {
    if (this.readyState === BatchEventSource.CLOSED) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (this.readyState === BatchEventSource.CLOSED || this.inFlight) return;
    this.inFlight = true;
    const controller = new AbortController();
    this.abortController = controller;
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("Batch event request timed out"));
      }, this.requestTimeoutMs);
    });

    const cursorParam = this.cursor ? `&cursor=${encodeURIComponent(this.cursor)}` : "";
    const url = `/api/agent/${encodeURIComponent(this.sessionId)}/events?format=batch${cursorParam}`;
    const diagnostic = beginConnectionAttempt({ operation: "session_events", url, sessionId: this.sessionId,
      engine: this.sessionId.startsWith("codex:") ? "codex" : "pi", timeoutMs: this.requestTimeoutMs });
    let responseStatus: number | undefined;

    try {
      const res = await Promise.race([
        fetch(url, {
          method: "GET",
          signal: controller.signal,
          headers: { Accept: "application/json", ...diagnostic.headers },
        }),
        timeoutPromise,
      ]);

      if (this.readyState === BatchEventSource.CLOSED) return;

      responseStatus = res.status;
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const payload = parseSessionBatchResponse(await Promise.race([res.json(), timeoutPromise]));
      if (this.readyState === BatchEventSource.CLOSED) return;
      if (this.epoch !== null && payload.epoch !== this.epoch && !payload.reset) {
        throw new SyntaxError("Batch event epoch changed without reset");
      }

      if (payload.events.some(event => event.type === "startup_error")) diagnostic.fail(null, { status: responseStatus, reason: "startup_error" });
      else diagnostic.success();
      const isSnapshot = this.cursor === null || payload.reset || (this.epoch !== null && payload.epoch !== this.epoch);
      const events = [...payload.events];
      if (isSnapshot) {
        this.isStreaming = false;
        this.hasPendingQueue = false;
        if (!events.some((event) => event.type === "queue_update") && !events.some((event) => event.type === "startup_error")) {
          events.push({ type: "queue_update", steering: [], followUp: [] });
        }
      }

      // A valid response owns this cursor even if a UI callback below fails.
      this.epoch = payload.epoch;
      this.cursor = payload.cursor;

      if (this.readyState === BatchEventSource.CONNECTING) {
        this.readyState = BatchEventSource.OPEN;
        const openEvent = new Event("open");
        this.onopen?.(openEvent);
        this.dispatchEvent(openEvent);
      }
      if (this.readyState === BatchEventSource.CLOSED) return;

      for (const event of events) {
        if (this.readyState === BatchEventSource.CLOSED) return;
        const eventType = event.type;

        if (eventType === "connected") {
          this.isStreaming = Boolean(event.isStreaming);
        } else if (eventType === "agent_start") {
          this.isStreaming = true;
        } else if (eventType === "agent_end") {
          this.isStreaming = false;
        } else if (eventType === "queue_update") {
          const steering = event.steering;
          const followUp = event.followUp;
          this.hasPendingQueue =
            (Array.isArray(steering) && steering.length > 0) ||
            (Array.isArray(followUp) && followUp.length > 0);
        }

        const msgEvent = new MessageEvent("message", {
          data: JSON.stringify(event),
        });

        this.onmessage?.(msgEvent);
        this.dispatchEvent(msgEvent);

        if (eventType && eventType !== "message") {
          this.dispatchEvent(new CustomEvent(eventType, { detail: event }));
        }
      }
      if (this.readyState === BatchEventSource.CLOSED) return;
      // A validated empty batch proves transport liveness without changing
      // application state or turning idle polling into an active poll loop.
      if (payload.events.length === 0) {
        this.onmessage?.(new MessageEvent("message", {
          data: JSON.stringify({ type: "heartbeat" }),
        }));
      }
      // 活跃（有事件接收、正在流式输出或有排队）时使用高频 250ms，静止空闲时降低至 1000ms
      const hasActivity = events.length > 0 || this.isStreaming || this.hasPendingQueue;
      const nextDelay = hasActivity ? this.activePollIntervalMs : this.idlePollIntervalMs;
      this.schedule(nextDelay);
    } catch (error) {
      diagnostic.fail(error, { status: responseStatus, timedOut,
        cancelled: this.readyState === BatchEventSource.CLOSED || (controller.signal.aborted && !timedOut) });
      if (this.readyState === BatchEventSource.CLOSED) return;
      if (controller.signal.aborted && !timedOut) return;

      const errEvent = new Event("error");
      this.onerror?.(errEvent);
      this.dispatchEvent(errEvent);

      // 出错后退避 1000ms 重试
      this.schedule(this.idlePollIntervalMs);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      this.inFlight = false;
      if (this.abortController === controller) this.abortController = null;
    }
  }
}

/**
 * Creates an agent event source backed by native short-batch JSON requests.
 * Conforms to AgentEventSourceLike and releases the HTTP socket on every turn.
 */
export function createAgentEventBatchSource(sessionId: string): AgentEventSourceLike {
  return new BatchEventSource(sessionId);
}
