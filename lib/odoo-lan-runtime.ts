import path from "node:path";
import {markOdooStopFence,readOdooStopFences,clearOdooStopFences,isOdooStopped} from './odoo-lan-cancellation.ts';
import type {
  OdooLanClient,
  OdooLanSnapshot,
  OdooLanHandoff,
  OdooLanResource,
} from "./odoo-lan-types.ts";
import { sanitizeSessionTitle } from "./collaboration-store.ts";
import {
  type SessionConsumer,
  sanitizeSessionId,
  sanitizeError,
} from "./lock-handoff-dispatcher.ts";

export const ODOO_LAN_MESSAGE_CUSTOM_TYPE = "odoo_lan:handoff_wake";

export interface OdooLanConsumerRegistration {
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
  client: OdooLanClient;
}

export interface ActiveOdooLanConsumer extends SessionConsumer {
  sessionId: string;
  cancel: () => void;
  resetCancellation: () => void;
}

const ODOO_CONSUMERS_SYMBOL = Symbol.for("agent-web-plus/odoo-lan-consumers/v1");
const globals = globalThis as unknown as Record<symbol, unknown>;
const odooConsumerRegistry = (globals[ODOO_CONSUMERS_SYMBOL] ??= new Map<string, ActiveOdooLanConsumer>()) as Map<string, ActiveOdooLanConsumer>;

export function getOdooLanSessionConsumers(): Map<string, ActiveOdooLanConsumer> {
  return odooConsumerRegistry;
}

/**
 * 契约规范：
 * 1. 内存 consumer 立即 cancel；
 * 2. dispatcher 记录取消栅栏（防止冷 session 被异步恢复唤醒）；
 * 3. 异步向 authority 请求取消排队或未 accepted 的 handoff，但绝不释放 held 业务持锁！
 */
export function cancelOdooLanWakeups(sessionId: string): void {
  const consumer = odooConsumerRegistry.get(sessionId);
  consumer?.cancel();
  const dispatcher=getOdooLanDispatcher();
  if(dispatcher)dispatcher.cancelSessionWakeups(sessionId);else markOdooStopFence(sessionId);
  void cancelAuthorityHandoffOrQueue(sessionId).catch(error=>console.warn('[Odoo接力] 停止意图已保存，等待权威恢复：',sanitizeError(error)));
}

export async function cancelAuthorityHandoffOrQueue(sessionId: string, providedClient?: OdooLanClient, strict = false, originalFences = readOdooStopFences(sessionId)): Promise<void> {
  const stillRelevant=()=>!originalFences.length||originalFences.some(epoch=>readOdooStopFences(sessionId).includes(epoch));
  try {
    const { resolveOdooLanClient } = await import("./odoo-lan-service.ts");
    const client = providedClient ?? await resolveOdooLanClient();
    if (!client || !client.isConfigured()) {if(strict)throw new Error('Odoo权威不可用，停止意图仍然有效');return;}
    if(!stillRelevant()) return;
    const snapshot = await client.status();
    if(!stillRelevant()) return;
    for (const res of snapshot.resources) {
      if(!stillRelevant()) return;
      const queued = res.queue.find(q=>q.sessionId===sessionId&&q.instanceId===client.instanceId);
      const inQueue = Boolean(queued);
      const inHandoff =
        res.status === "handoff" &&
        res.handoff &&
        res.handoff.sessionId === sessionId &&
        res.handoff.instanceId === client.instanceId;

      if (inQueue || inHandoff) {
        try {
          await client.request({
            action: "cancel",
            actor: {
              sessionId,
              sessionName: "取消会话",
              ownerPid: process.pid,
            },
            resource: res.resource,
            queueId: queued?.queueId,
            handoffId: inHandoff ? res.handoff?.handoffId : undefined,
          });
        } catch (err) {
          if(strict)throw err;
          console.warn(`[Odoo接力] 取消排队/交接持久同步警告: ${sanitizeError(err)}`);
        }
      }
    }
    if(strict&&stillRelevant()){
      const proof=await client.status();
      if(proof.resources.some(res=>res.status==='unknown'||res.queue.some(q=>q.sessionId===sessionId&&q.instanceId===client.instanceId)||(res.handoff?.sessionId===sessionId&&res.handoff.instanceId===client.instanceId)))throw new Error('旧排队或交接仍待确认，保留停止意图，未重新申请');
    }
  } catch(error) {if(strict)throw error;console.warn('[Odoo接力] 权威暂不可达，保留停止意图：',sanitizeError(error));}
}

export async function prepareOdooLanReacquire(sessionId: string, client: OdooLanClient): Promise<void> {
  const epochs=readOdooStopFences(sessionId);
  if(epochs.length){
    await cancelAuthorityHandoffOrQueue(sessionId,client,true,epochs);
    clearOdooStopFences(sessionId,epochs);
    if(isOdooStopped(sessionId))throw new Error('较新的停止指令仍然有效，本次未重新申请资源');
  }
  resetOdooLanCancellation(sessionId);
}

export function resetOdooLanCancellation(sessionId: string): void {
  const consumer = odooConsumerRegistry.get(sessionId);
  consumer?.resetCancellation();

  const dispatcher = getOdooLanDispatcher();
  dispatcher?.resetSessionWakeups(sessionId);
}

/**
 * 注册当前会话的 Odoo LAN 接力接收器。
 * 核心并发与状态契约：
 * 1. Awaited client.status() 后必须二次检查 isBusy 与 isCancelled；
 * 2. 分离 Branch dedup 与 ACK retry：已在活动分支的消息不再重复注入，但只要 handoff 未完成 ACK 必须重试 ACK；
 * 3. 绝不在 ACK 之前 add handoffId 导致 lost-ACK 无法重试；
 * 4. 仅在空闲且交接仍有效时 triggerTurn；nextTurn 仅存上下文，不会自动续做；
 * 5. 全异步边界执行 stop/cancel 与权威当前 handoffId/token/gen 二次校验。
 */
export function registerOdooLanConsumer(reg: OdooLanConsumerRegistration): () => void {
  const consumers = getOdooLanSessionConsumers();
  const client = reg.client;

  let inFlight = false;
  let pendingDrain = false;
  let isCancelled = false;
  let unsubscribeSettled: (() => void) | undefined;

  const performDrain = async () => {
    if (inFlight) {
      pendingDrain = true;
      return;
    }

    if (isCancelled || isOdooStopped(reg.sessionId)) {
      return;
    }

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
      // 1. 发送前调用权威 status 核验当前状态（Lost-ACK 与并发防错契约）
      let snapshot: OdooLanSnapshot;
      try {
        snapshot = await client.status();
      } catch (err) {
        console.warn(`[Odoo接力] 权威状态查询受阻，暂缓唤醒: ${sanitizeError(err)}`);
        return;
      }

      // Revalidate Stop after authority I/O, including persisted offline intent.
      if (isCancelled || isOdooStopped(reg.sessionId)) return;
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

      // 2. 查找属于当前实例且目标为当前会话的 handoff
      let targetRes: OdooLanResource | undefined;
      let targetHandoff: OdooLanHandoff | undefined;

      for (const res of snapshot.resources || []) {
        if (
          res.status === "handoff" &&
          res.handoff &&
          res.handoff.instanceId === client.instanceId &&
          res.handoff.sessionId === reg.sessionId
        ) {
          targetRes = res;
          targetHandoff = res.handoff;
          break;
        }
      }

      if (!targetRes || !targetHandoff || !targetHandoff.resumeTask) {
        return;
      }

      const handoffId = targetHandoff.handoffId;
      const token = targetHandoff.token;
      const generation = targetHandoff.generation;
      const resource = targetRes.resource;

      // 3. 活动分支去重（Active branch dedup）与 ACK retry 严格解耦
      const alreadyOnBranch =
        reg.isHandoffConsumedOnActiveBranch?.(handoffId) ?? false;

      if (!alreadyOnBranch) {
        // SDK nextTurn never starts a model request; use normal triggerTurn only after settled.
        if (reg.isBusy()) {
          pendingDrain = true;
          return;
        }

        await reg.sendMessage(
          {
            customType: ODOO_LAN_MESSAGE_CUSTOM_TYPE,
            content: `【Odoo 插件锁已获授】系统交接事件，并非新的用户授权。先核实持有凭据与最新状态，重读最新源码，再在原任务与授权范围内继续：${targetHandoff.resumeTask}。完成原定验收后释放资源；保留生产发布、外发和权限变更的确认边界。`,
            display: true,
            details: {
              handoffId,
              token,
              generation,
              resource,
            },
          },
          { triggerTurn: true },
        );
      }

      // A Stop arriving during send must fence ACK as well.
      if (isCancelled || isOdooStopped(reg.sessionId)) return;

      // 4. 调用权威 ACK，将 handoff 转为正式 held
      // 注意：无论此前是否已在分支注入过，只要 authority 仍处于 handoff 状态，均需提交/重试 ACK
      try {
        await client.request({
          action: "ack",
          actor: {
            sessionId: reg.sessionId,
            sessionName: reg.sessionName?.() || "未命名会话",
            ownerPid: process.pid,
          },
          resource,
          handoffId,
          token,
          generation,
        });
      } catch (ackErr) {
        // ACK 失败记录警告，但不设置永久屏蔽集合，保留下次重试能力
        console.warn(`[Odoo接力] ACK 提交警告: ${sanitizeError(ackErr)}`);
      }
    } catch (err) {
      console.error(
        `[Odoo接力] 会话 ${sanitizeSessionId(reg.sessionId)} 消息发送失败:`,
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

  const consumer: ActiveOdooLanConsumer = {
    sessionId: reg.sessionId,
    drain: () => {
      void performDrain();
    },
    cancel: () => {
      isCancelled = true;
      pendingDrain = false;
      unsubscribeSettled?.();
      unsubscribeSettled = undefined;
    },
    resetCancellation: () => {
      isCancelled = false;
    },
  };

  consumers.set(reg.sessionId, consumer);

  return () => {
    consumer.cancel();
    consumers.delete(reg.sessionId);
  };
}

export interface OdooLanDispatcherOptions {
  client: OdooLanClient;
  pollIntervalMs?: number;
  maxRetries?: number;
  backoffScheduleMs?: number[];
  resolveSessionPath?: (id: string) => Promise<string | undefined> | string | undefined;
  startSession?: (id: string, file: string, cwd: undefined) => Promise<{ session: { waitUntilReady: () => Promise<void> } }>;
  getRpcSession?: (id: string) => ({ waitUntilReady: () => Promise<void>; isAlive: () => boolean }) | undefined;
  getInflightLock?: (id: string) => Promise<{ session: { waitUntilReady: () => Promise<void> } }> | undefined;
  logger?: { warn?: (msg: string) => void; error?: (msg: string) => void };
}

export interface OdooLanDispatcher {
  start(): void;
  stop(): Promise<void>;
  triggerScan(): Promise<void>;
  cancelSessionWakeups(sessionId: string): void;
  resetSessionWakeups(sessionId: string): void;
  isAlive(): boolean;
}

export function createOdooLanDispatcher(options: OdooLanDispatcherOptions): OdooLanDispatcher {
  const client = options.client;
  const logger = options.logger ?? console;
  const maxRetries = options.maxRetries ?? 3;
  const backoffScheduleMs = options.backoffScheduleMs ?? [5000, 15000, 60000];
  const resolveFile = options.resolveSessionPath ?? (async (id) => (await import("./session-reader")).resolveSessionPath(id));
  const restore = options.startSession ?? (async (id, file, cwd) => (await import("./rpc-manager")).startRpcSession(id, file, cwd));
  const live = options.getRpcSession ?? ((id) => (globalThis as any).__piSessions?.get(id));
  const starting = options.getInflightLock ?? ((id) => (globalThis as any).__piStartLocks?.get(id));

  let stopped = false;
  let running = false;
  let rescan = false;
  let scanPromise: Promise<void> | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let unsubscribeClient: (() => void) | undefined;
  const cancelledSessions = new Set<string>();
  const coldRestoreFailures = new Map<string, { attempts: number; retryAt: number }>();

  const processCandidates = async () => {
    let snapshot = client.getCachedSnapshot();
    if (!snapshot) {
      try {
        snapshot = await client.status();
      } catch {
        return;
      }
    }

    if (stopped || !snapshot?.resources) return;
    // Reconcile durable offline Stop intent before restoring any target.
    const localSessions=new Set<string>();
    for(const res of snapshot.resources){for(const q of res.queue)if(q.instanceId===client.instanceId)localSessions.add(q.sessionId);if(res.handoff?.instanceId===client.instanceId)localSessions.add(res.handoff.sessionId);}
    for(const sid of localSessions){
      if(stopped)return;
      if(isOdooStopped(sid)){cancelledSessions.add(sid);await cancelAuthorityHandoffOrQueue(sid,client);}
    }
    if(stopped)return;
    snapshot=client.getCachedSnapshot();
    if(!snapshot)return;

    // 过滤出属于当前实例的 handoff
    const eligibleHandoffs: Array<{ sessionId: string; sessionName?: string; handoffId: string }> = [];
    for (const res of snapshot.resources) {
      if (
        res.status === "handoff" &&
        res.handoff &&
        res.handoff.instanceId === client.instanceId &&
        res.handoff.resumeTask &&
        res.handoff.resumeTask.trim().length > 0 &&
        res.handoff.sessionId
      ) {
        eligibleHandoffs.push({
          sessionId: res.handoff.sessionId,
          sessionName: res.handoff.sessionName,
          handoffId: res.handoff.handoffId,
        });
      }
    }

    // 清理已不再存在的 handoff 失败计数
    const activeSessionIds = new Set(eligibleHandoffs.map((h) => h.sessionId));
    for (const sid of Array.from(coldRestoreFailures.keys())) {
      if (!activeSessionIds.has(sid)) {
        coldRestoreFailures.delete(sid);
      }
    }

    for (const item of eligibleHandoffs) {
      if (stopped || cancelledSessions.has(item.sessionId)) continue;

      // 有界失败重试检查：超过 maxRetries 或仍在退避冷却期时跳过，避免每 5s 无限空转尝试
      const failure = coldRestoreFailures.get(item.sessionId);
      if (failure) {
        if (failure.attempts >= maxRetries) {
          continue;
        }
        if (Date.now() < failure.retryAt) {
          continue;
        }
      }

      const consumers = getOdooLanSessionConsumers();
      let consumer = consumers.get(item.sessionId);

      try {
        if (!consumer) {
          // 原会话未在内存中：冷恢复
          const existing = live(item.sessionId);
          const inflight = starting(item.sessionId);
          let sessionObj: { waitUntilReady: () => Promise<void> };

          if (existing?.isAlive()) {
            sessionObj = existing;
          } else if (inflight) {
            sessionObj = (await inflight).session;
          } else {
            const file = await resolveFile(item.sessionId);
            if (stopped || cancelledSessions.has(item.sessionId)) continue;
            if (!file) {
              const prev = coldRestoreFailures.get(item.sessionId);
              const attempts = (prev?.attempts || 0) + 1;
              const delay = backoffScheduleMs[Math.min(attempts - 1, backoffScheduleMs.length - 1)];
              coldRestoreFailures.set(item.sessionId, { attempts, retryAt: Date.now() + delay });
              logger.warn?.(`[Odoo接力] 找不到原会话文件 (${attempts}/${maxRetries}): ${sanitizeSessionId(item.sessionId)}`);
              continue;
            }
            sessionObj = (await restore(item.sessionId, file, undefined)).session;
          }

          if (stopped || cancelledSessions.has(item.sessionId)) continue;
          await sessionObj.waitUntilReady();
          if (stopped || cancelledSessions.has(item.sessionId)) continue;

          consumer = consumers.get(item.sessionId);
          if (!consumer) {
            const prev = coldRestoreFailures.get(item.sessionId);
            const attempts = (prev?.attempts || 0) + 1;
            const delay = backoffScheduleMs[Math.min(attempts - 1, backoffScheduleMs.length - 1)];
            coldRestoreFailures.set(item.sessionId, { attempts, retryAt: Date.now() + delay });
            logger.warn?.(`[Odoo接力] 原会话恢复后未注册 Odoo 锁接收器 (${attempts}/${maxRetries}): ${sanitizeSessionId(item.sessionId)}`);
            continue;
          }
        }

        if (stopped || cancelledSessions.has(item.sessionId)) continue;
        // 冷恢复成功，重置失败退避记录
        coldRestoreFailures.delete(item.sessionId);
        consumer.drain();
      } catch (err) {
        const prev = coldRestoreFailures.get(item.sessionId);
        const attempts = (prev?.attempts || 0) + 1;
        const delay = backoffScheduleMs[Math.min(attempts - 1, backoffScheduleMs.length - 1)];
        coldRestoreFailures.set(item.sessionId, { attempts, retryAt: Date.now() + delay });
        logger.warn?.(`[Odoo接力] 唤醒原会话失败 (${attempts}/${maxRetries}): ${sanitizeError(err)}`);
      }
    }
  };

  const triggerScan = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (scanPromise) {
      rescan = true;
      return scanPromise;
    }
    scanPromise = (async () => {
      do {
        rescan = false;
        try {
          await processCandidates();
        } catch (err) {
          logger.warn?.(`[Odoo接力] 扫描发生异常: ${sanitizeError(err)}`);
        }
      } while (rescan && !stopped);
    })().finally(() => {
      scanPromise = undefined;
    });
    return scanPromise;
  };

  const start = () => {
    if (stopped || running) return;
    running = true;

    // 订阅客户端通知
    try {
      unsubscribeClient = client.subscribe(() => {
        void triggerScan();
      });
    } catch (err) {
      logger.warn?.(`[Odoo接力] 客户端事件订阅失败，退化为时钟轮询: ${sanitizeError(err)}`);
    }

    // 有界补偿时钟（默认 5s）
    const interval = Math.max(500, Math.min(10000, options.pollIntervalMs ?? 5000));
    pollTimer = setInterval(() => {
      void triggerScan();
    }, interval);
    pollTimer.unref?.();

    void triggerScan();
  };

  const stop = async () => {
    stopped = true;
    running = false;
    if (pollTimer) clearInterval(pollTimer);
    unsubscribeClient?.();
    unsubscribeClient = undefined;
    for(const consumer of getOdooLanSessionConsumers().values())consumer.cancel?.();
    cancelledSessions.clear();
    coldRestoreFailures.clear();
  };

  const cancelSessionWakeups = (sessionId: string) => {
    cancelledSessions.add(sessionId);
    markOdooStopFence(sessionId);
  };

  const resetSessionWakeups = (sessionId: string) => {
    cancelledSessions.delete(sessionId);
  };

  return {
    start,
    stop,
    triggerScan,
    cancelSessionWakeups,
    resetSessionWakeups,
    isAlive: () => running && !stopped,
  };
}

const ODOO_DISPATCHER_SYMBOL = Symbol.for("@agegr/pi-web/odoo-lan-dispatcher/v1");

export function getOdooLanDispatcher(): OdooLanDispatcher | undefined {
  return (globalThis as Record<symbol, unknown>)[ODOO_DISPATCHER_SYMBOL] as
    | OdooLanDispatcher
    | undefined;
}

export function startOdooLanDispatcher(options: OdooLanDispatcherOptions): OdooLanDispatcher {
  const existing = getOdooLanDispatcher();
  if (existing?.isAlive()) return existing;
  const dispatcher = createOdooLanDispatcher(options);
  (globalThis as Record<symbol, unknown>)[ODOO_DISPATCHER_SYMBOL] = dispatcher;
  dispatcher.start();
  return dispatcher;
}

export async function stopOdooLanDispatcher(): Promise<void> {
  const existing = getOdooLanDispatcher();
  (globalThis as Record<symbol, unknown>)[ODOO_DISPATCHER_SYMBOL] = undefined;
  await existing?.stop();
}

/**
 * Node instrumentation 生命周期辅助：
 * 配置启用时主动初始化 snapshot 并订阅 client，启动 dispatcher；
 * 关停时仅停止 dispatcher 与关闭自家子进程，绝不释放业务持锁！
 */
export async function startOdooLanLifecycle(): Promise<void> {
  try {
    const { resolveOdooLanClient } = await import("./odoo-lan-service.ts");
    const client = await resolveOdooLanClient().catch(() => undefined);
    if (client && client.isConfigured()) {
      try {
        await client.status();
      } catch {}
      startOdooLanDispatcher({ client });
    }
  } catch (err) {
    console.warn("[odoo-lan-lifecycle] 启动生命周期预检异常:", err);
  }
}

export async function stopOdooLanLifecycle(): Promise<void> {
  try {
    await stopOdooLanDispatcher();
    const { resolveOdooLanClient } = await import("./odoo-lan-service.ts");
    const client = await resolveOdooLanClient().catch(() => undefined);
    if (client) {
      await client.close();
    }
  } catch (err) {
    console.warn("[odoo-lan-lifecycle] 停止生命周期异常:", err);
  }
}
