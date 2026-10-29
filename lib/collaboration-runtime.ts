import path from "node:path";
import os from "node:os";
import {
  createLockHandoffDispatcher,
  type DispatcherOptions,
  type LockHandoffDispatcher,
  type WakeCandidate,
  type SessionConsumer,
  getAgentDirSafe,
  sanitizeSessionId,
  sanitizeError,
} from "./lock-handoff-dispatcher.ts";
import {
  getCollaborationStore,
  type CollaborationStore,
  type LockHandoff,
} from "./collaboration-store.ts";

export const COLLABORATION_MESSAGE_CUSTOM_TYPE = "collaboration:handoff_wake";

export interface CollaborationConsumerRegistration {
  sessionId: string;
  sessionName?: () => string | undefined;
  isBusy: () => boolean;
  onSettled?: (callback: () => void) => () => void;
  isHandoffConsumedOnActiveBranch?: (handoffId: string) => boolean;
  sendMessage: (
    message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: Record<string, unknown>;
    },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ) => Promise<unknown> | unknown;
  stateFile?: string;
}

export interface ActiveConsumer extends SessionConsumer {
  sessionId: string;
  cancel: () => void;
  resetCancellation: () => void;
}

// Instrumentation and route bundles can load separate copies of this module.
// Share consumers process-wide, just like the native AgentSession registry.
const CONSUMERS_SYMBOL = Symbol.for("agent-web-plus/collaboration-consumers/v1");
const globals = globalThis as unknown as Record<symbol, unknown>;
const consumerRegistry = (globals[CONSUMERS_SYMBOL] ??= new Map()) as Map<string, Map<string, ActiveConsumer>>;

function getStateFileKey(stateFile?: string): string {
  if (stateFile) return path.resolve(stateFile);
  const agentDir = getAgentDirSafe();
  return path.resolve(path.join(agentDir, "state", "collaboration-locks.json"));
}

export function getCollaborationSessionConsumers(stateFile: string): Map<string, SessionConsumer> {
  const key = getStateFileKey(stateFile);
  let map = consumerRegistry.get(key);
  if (!map) {
    map = new Map();
    consumerRegistry.set(key, map as Map<string, ActiveConsumer>);
  }
  return map;
}

export function readCollaborationWakeCandidates(options: { stateFile: string; pid?: number }): WakeCandidate[] {
  const stateFile = getStateFileKey(options.stateFile);
  const store = getCollaborationStore({ stateFile });
  let state;
  try {
    state = store.readState();
  } catch {
    return [];
  }

  const pid = options.pid ?? process.pid;
  const candidates: WakeCandidate[] = [];
  const seenSessions = new Set<string>();

  for (const res of Object.values(state.resources)) {
    if (res.status === "handoff" && res.handoff) {
      const h: LockHandoff = res.handoff;
      // Auto resume only if:
      // 1. Has explicit resumeTask
      // 2. Not already consumed
      // 3. Not already added in candidates list
      if (
        h.resumeTask &&
        typeof h.resumeTask === "string" &&
        h.resumeTask.trim().length > 0 &&
        !state.consumedHandoffIds.includes(h.handoffId) &&
        !seenSessions.has(h.targetSessionId)
      ) {
        seenSessions.add(h.targetSessionId);
        candidates.push({
          sessionId: h.targetSessionId,
          sessionName: h.targetSessionName || "未命名会话（标题尚未生成）",
          moduleKey: h.handoffId,
          messageId: h.handoffId,
          // Map to current process pid so process restart does not discard the grant!
          ownerPid: pid,
        });
      }
    }
  }

  return candidates;
}

export function cancelCollaborationSessionWakeups(options: { stateFile: string; sessionId: string }): void {
  const stateFile = getStateFileKey(options.stateFile);
  const store = getCollaborationStore({ stateFile });

  // 1. Synchronous in-memory fence
  const consumers = getCollaborationSessionConsumers(stateFile) as Map<string, ActiveConsumer>;
  consumers.get(options.sessionId)?.cancel?.();

  // 2. Synchronous persistent cancel in store
  try {
    store.cancelSync({ sessionId: options.sessionId });
  } catch (err) {
    console.error(
      `[协作锁] 取消会话 ${sanitizeSessionId(options.sessionId)} 同步持久化失败:`,
      sanitizeError(err),
    );
  }
}

export function resetCollaborationConsumerCancellation(sessionId: string, stateFile?: string): void {
  const file = getStateFileKey(stateFile);
  const consumers = getCollaborationSessionConsumers(file) as Map<string, ActiveConsumer>;
  consumers.get(sessionId)?.resetCancellation?.();
}

export function registerCollaborationConsumer(
  reg: CollaborationConsumerRegistration,
): () => void {
  const stateFile = getStateFileKey(reg.stateFile);
  const consumers = getCollaborationSessionConsumers(stateFile) as Map<string, ActiveConsumer>;
  const store = getCollaborationStore({ stateFile });

  let inFlight = false;
  let pendingDrain = false;
  let cancelledGeneration = 0;
  let unsubscribeSettled: (() => void) | undefined;

  const performDrain = async () => {
    if (inFlight) {
      pendingDrain = true;
      return;
    }

    // Check if session is currently busy
    if (reg.isBusy()) {
      pendingDrain = true;
      if (!unsubscribeSettled && reg.onSettled) {
        unsubscribeSettled = reg.onSettled(() => {
          if (pendingDrain) {
            pendingDrain = false;
            void performDrain();
          }
        });
      }
      return;
    }

    inFlight = true;
    pendingDrain = false;

    try {
      // Critical verification before sending: re-read store state to confirm grant validity
      let state;
      try {
        state = store.readState();
      } catch {
        return;
      }

      // Find handoff for this session
      let matchingHandoff: LockHandoff | undefined;
      for (const res of Object.values(state.resources)) {
        if (
          res.status === "handoff" &&
          res.handoff?.targetSessionId === reg.sessionId &&
          !state.consumedHandoffIds.includes(res.handoff.handoffId)
        ) {
          matchingHandoff = res.handoff;
          break;
        }
      }

      if (!matchingHandoff || !matchingHandoff.resumeTask) {
        return;
      }

      // Cancellation fence: if this handoff generation was cancelled, skip it
      if (cancelledGeneration > 0 && matchingHandoff.generation <= cancelledGeneration) {
        return;
      }

      // Active branch custom details handoffId deduplication
      const alreadyOnBranch =
        reg.isHandoffConsumedOnActiveBranch?.(matchingHandoff.handoffId) ?? false;

      if (!alreadyOnBranch) {
        await reg.sendMessage(
          {
            customType: COLLABORATION_MESSAGE_CUSTOM_TYPE,
            content: `【协作资源已获授】系统交接事件，并非新的用户授权。先用 resource_lock status 核实持有凭据与当前代际，重读最新源码，再在原任务与授权范围内继续：${matchingHandoff.resumeTask}。完成原定验收后释放资源；保留生产发布、外发和权限变更的确认边界。`,
            display: true,
            details: {
              handoffId: matchingHandoff.handoffId,
              token: matchingHandoff.token,
              generation: matchingHandoff.generation,
              resources: matchingHandoff.resources,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }

      // Safe ack handoff
      await store.ackHandoff({
        sessionId: reg.sessionId,
        handoffId: matchingHandoff.handoffId,
        token: matchingHandoff.token,
      });
    } catch (err) {
      console.error(
        `[协作接力] 会话 ${sanitizeSessionId(reg.sessionId)} 消息发送失败:`,
        sanitizeError(err),
      );
    } finally {
      inFlight = false;
      if (pendingDrain) {
        pendingDrain = false;
        void performDrain();
      }
    }
  };

  const consumer: ActiveConsumer = {
    sessionId: reg.sessionId,
    drain: () => {
      void performDrain();
    },
    cancel: () => {
      try {
        cancelledGeneration = store.readState().generation;
      } catch {
        cancelledGeneration = Number.MAX_SAFE_INTEGER;
      }
      pendingDrain = false;
      unsubscribeSettled?.();
      unsubscribeSettled = undefined;
    },
    resetCancellation: () => {
      cancelledGeneration = 0;
    },
  };

  consumers.set(reg.sessionId, consumer);

  return () => {
    consumer.cancel();
    consumers.delete(reg.sessionId);
  };
}

const COLLAB_DISPATCHER_SYMBOL = Symbol.for("@agegr/pi-web/collaboration-dispatcher/v1");

export function getCollaborationDispatcher(): LockHandoffDispatcher | undefined {
  return (globalThis as Record<symbol, unknown>)[COLLAB_DISPATCHER_SYMBOL] as
    | LockHandoffDispatcher
    | undefined;
}

export function startCollaborationDispatcher(options?: DispatcherOptions): LockHandoffDispatcher {
  const existing = getCollaborationDispatcher();
  if (existing?.isAlive()) return existing;

  const stateFile = getStateFileKey(options?.stateFile);
  const dispatcher = createLockHandoffDispatcher({
    stateFile,
    readCandidates: readCollaborationWakeCandidates,
    getConsumers: getCollaborationSessionConsumers,
    cancelPending: cancelCollaborationSessionWakeups,
    ...options,
  });

  (globalThis as Record<symbol, unknown>)[COLLAB_DISPATCHER_SYMBOL] = dispatcher;
  dispatcher.start();
  return dispatcher;
}

export async function stopCollaborationDispatcher(): Promise<void> {
  const existing = getCollaborationDispatcher();
  (globalThis as Record<symbol, unknown>)[COLLAB_DISPATCHER_SYMBOL] = undefined;
  await existing?.stop();
}

export function cancelCollaborationWakeups(sessionId: string, stateFile?: string): void {
  const file = getStateFileKey(stateFile);
  const dispatcher = getCollaborationDispatcher();
  if (dispatcher) {
    dispatcher.cancelSessionWakeups(sessionId);
  } else {
    cancelCollaborationSessionWakeups({ stateFile: file, sessionId });
  }
}
