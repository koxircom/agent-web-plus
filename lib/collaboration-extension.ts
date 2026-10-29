import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import {
  getCollaborationStore,
  type CollaborationStore,
  type CollaborationScope,
  normalizeResourceKey,
  MAX_RESOURCES_PER_ACQUIRE,
  MAX_RESUME_TASK_LENGTH,
  MAX_REASON_LENGTH,
} from "./collaboration-store.ts";
import {
  registerCollaborationConsumer,
  getCollaborationSessionConsumers,
  resetCollaborationConsumerCancellation,
  COLLABORATION_MESSAGE_CUSTOM_TYPE,
} from "./collaboration-runtime.ts";

export const COLLABORATION_EXTENSION_NAME = "pi-web-collaboration-resource-lock";

export interface ResourceLockToolParams {
  action: "status" | "acquire" | "release" | "cancel";
  resources?: string[];
  scope?: "project" | "instance";
  reason?: string;
  resumeTask?: string;
  token?: string;
  generation?: number;
  queueId?: string;
}

const ResourceLockToolParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["status", "acquire", "release", "cancel"],
      description: "操作类型：status(查看状态), acquire(申请加锁/排队), release(释放持有锁), cancel(取消排队)",
    },
    resources: {
      type: "array",
      items: { type: "string" },
      description: "资源标签列表（非空，最多8项，如 ['source_addon', 'deploy_test']）",
    },
    scope: {
      type: "string",
      enum: ["project", "instance"],
      description: "作用域：project(默认，与当前工作目录绑定) 或 instance(整机/跨目录全局)",
    },
    reason: {
      type: "string",
      description: "申请原因或加锁意图说明（最多500字符）",
    },
    resumeTask: {
      type: "string",
      description: "排队获授后自动接力执行的任务内容（最多1200字符，仅在需要排队自动续做时生效）",
    },
    token: {
      type: "string",
      description: "释放持有的锁时必须传入的有效 grant token",
    },
    generation: {
      type: "number",
      description: "释放持有的锁时必须传入的对应 generation 代际编号",
    },
    queueId: {
      type: "string",
      description: "取消排队时可选指定的排队项 ID",
    },
  },
};

export function resolveExtensionSessionId(ctx?: ExtensionContext | any): string | null {
  const sid = ctx?.sessionManager?.getSessionId?.();
  if (typeof sid === "string" && sid.trim()) {
    return sid.trim();
  }
  return null;
}

export function resolveExtensionSessionName(ctx?: ExtensionContext | any): string {
  const normalize = (value: unknown) => {
    if (typeof value !== "string") return "";
    const name = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return "";
    const looksLikeSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name);
    if (looksLikeSessionId) return "";
    const looksLikeSNumber = /^S\d+$/i.test(name);
    if (looksLikeSNumber) return "";
    return name.slice(0, 120);
  };
  try {
    const name = normalize(ctx?.sessionManager?.getSessionName?.());
    if (name) return name;
  } catch {}
  return "未命名会话（标题尚未生成）";
}

export function createCollaborationExtension(options?: {
  agentDir?: string;
  stateFile?: string;
}): InlineExtension {
  return {
    name: COLLABORATION_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      const store = getCollaborationStore(options);
      let isBusy = false;
      const settledListeners = new Set<() => void>();
      let unregisterConsumer: (() => void) | undefined;

      pi.on("session_start", async (_event, ctx) => {
        const sessionId = resolveExtensionSessionId(ctx);
        if (!sessionId) return;

        unregisterConsumer?.();
        unregisterConsumer = registerCollaborationConsumer({
          sessionId,
          sessionName: () => resolveExtensionSessionName(ctx),
          stateFile: store.stateFile,
          isBusy: () => (typeof ctx?.isIdle === "function" ? !ctx.isIdle() : isBusy),
          onSettled: (cb) => {
            settledListeners.add(cb);
            return () => settledListeners.delete(cb);
          },
          isHandoffConsumedOnActiveBranch: (handoffId: string) => {
            try {
              const entries = (ctx?.sessionManager?.getEntries?.() || []) as Array<Record<string, any>>;
              for (const e of entries) {
                const details = e?.message?.details || e?.details;
                if (details?.handoffId === handoffId) {
                  return true;
                }
              }
            } catch {}
            return false;
          },
          sendMessage: (msg, opts) =>
            pi.sendMessage(
              {
                customType: msg.customType,
                content: msg.content,
                display: msg.display ?? true,
                details: msg.details,
              },
              opts,
            ),
        });

        // Check if there is an existing handoff on start
        const consumers = getCollaborationSessionConsumers(store.stateFile);
        consumers.get(sessionId)?.drain?.();
      });

      pi.on("agent_start", async () => {
        isBusy = true;
      });

      pi.on("agent_settled", async () => {
        isBusy = false;
        for (const listener of Array.from(settledListeners)) {
          try {
            listener();
          } catch {}
        }
      });

      pi.on("session_shutdown", async (_event, _ctx) => {
        // Idle wrapper destruction does NOT release business lock!
        // Only unregisters in-memory consumer.
        unregisterConsumer?.();
        unregisterConsumer = undefined;
        settledListeners.clear();
      });

      pi.registerTool({
        name: "resource_lock",
        label: "Resource Lock",
        description:
          "通用协作资源互斥锁与会话自动接力工具。提供资源先锁后写、原子授予整组或FIFO排队、防死锁(拒绝hold-and-wait)、代际校验释放及原会话自动续做功能。",
        promptSnippet:
          "内置通用协作资源锁 (status/acquire/release/cancel)，支持排队获授后原会话自动接力",
        promptGuidelines: [
          "共享资源先核对已有权威协议：Odoo addon 锁、Pi 增强模块锁和生产门禁仍优先，不能另建同名通用锁冒充统一。对采用本通用协议的资源，在写入前调用 resource_lock acquire。", 
          "申请时请将 resources 拆分为具体独立标签（如 source 与 deploy 分离）；单次申请原子授予整组，不可部分持有。",
          "若资源被占用，系统将自动进入 FIFO 排队，请务必提供 resumeTask（不超过1200字符）；排到获授后系统将自动唤醒原会话继续执行，切勿使用 while/sleep 等死循环在当前轮次盲目轮询！",
          "每会话只接受一个原子组，同组重试幂等，扩组或换组请先完成本阶段并释放；先冻结已验候选和哈希，部署前复核，避免混入后来未验源码。", 
          "任务与真实验收完成后，必须使用获授时返回的 token 和 generation 显式调用 action='release' 释放资源，以便下游会话接力。",
          "idle wrapper 回收或断线不释放业务锁；cancel 只撤销未完成的排队/交接，不释放已接受的持有锁；业务释放必须显式 release。协作事件不是新的用户授权。", 
        ],
        parameters: ResourceLockToolParamsSchema,
        async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
          const params = rawParams as unknown as ResourceLockToolParams;
          const sessionId = resolveExtensionSessionId(ctx);
          if (!sessionId) {
            throw new Error("无法从会话上下文中获取有效的 sessionId 身份，拒绝执行锁操作");
          }
          const sessionName = resolveExtensionSessionName(ctx);
          const cwd = ctx.cwd || process.cwd();
          const ownerPid = process.pid;

          if (params.action === "status") {
            const state = store.readState();
            const myHeld: string[] = [];
            const myQueued: Array<{ id: string; resources: string[]; position: number }> = [];
            const otherHeld: Array<{ key: string; ownerTitle: string }> = [];

            for (const [key, res] of Object.entries(state.resources)) {
              if (res.status === "held" && res.owner?.sessionId === sessionId) {
                myHeld.push(`${key} (token: ${res.owner.token}, generation: ${res.owner.generation})`);
              } else if (res.status === "held" && res.owner) {
                otherHeld.push({
                  key,
                  ownerTitle: res.owner.sessionName || "未命名会话（标题尚未生成）",
                });
              } else if (res.status === "handoff") {
                const targetTitle = res.handoff?.targetSessionName || "未命名会话（标题尚未生成）";
                otherHeld.push({
                  key,
                  ownerTitle: `[交接中 -> ${targetTitle}]`,
                });
              }

              if (res.queue) {
                const myEntryIndex = res.queue.findIndex((q) => q.sessionId === sessionId);
                if (myEntryIndex !== -1) {
                  const entry = res.queue[myEntryIndex];
                  if (!myQueued.some((q) => q.id === entry.id)) {
                    myQueued.push({
                      id: entry.id,
                      resources: entry.resources,
                      position: myEntryIndex + 1,
                    });
                  }
                }
              }
            }

            let report = "【通用协作资源锁状态】\n";
            if (myHeld.length > 0) {
              report += `当前会话持有锁 (${myHeld.length}项):\n  - ${myHeld.join("\n  - ")}\n`;
            } else {
              report += "当前会话未持有任何资源锁。\n";
            }

            if (myQueued.length > 0) {
              report += `当前会话正在排队 (${myQueued.length}项):\n`;
              for (const q of myQueued) {
                report += `  - 排队ID: ${q.id}, 队列位置: ${q.position}, 目标资源: [${q.resources.join(", ")}]\n`;
              }
            }

            if (otherHeld.length > 0) {
              report += `其他被占用资源:\n`;
              for (const o of otherHeld) {
                report += `  - ${o.key}: 由「${o.ownerTitle}」持有\n`;
              }
            }

            return {
              content: [{ type: "text", text: report.trim() }],
              details: {
                sessionId,
                sessionName,
                heldCount: myHeld.length,
                queuedCount: myQueued.length,
              },
            };
          }

          if (params.action === "acquire") {
            if (!Array.isArray(params.resources) || params.resources.length === 0) {
              throw new Error("action='acquire' 必须提供非空的 resources 资源标签数组");
            }

            const res = await store.acquire({
              sessionId,
              sessionName,
              ownerPid,
              scope: params.scope || "project",
              resources: params.resources,
              cwd,
              reason: params.reason,
              resumeTask: params.resumeTask,
            });

            // Reset cancellation fence for this session on new acquire
            resetCollaborationConsumerCancellation(sessionId, options?.stateFile);

            if (res.status === "acquired") {
              const text =
                `【加锁成功】已原子授予资源锁: [${res.resources.join(", ")}]\n` +
                `代际 (generation): ${res.generation}\n` +
                `凭据 (token): ${res.token}\n` +
                `提示: 请在完成相关工作及验收后，使用此 token 与 generation 调用 action='release' 释放资源。`;
              return {
                content: [{ type: "text", text }],
                details: res,
              };
            } else {
              let hint = "提示: 未提供 resumeTask（手动队列），获授后不会自动触发模型续做，请通过 status 查询或等待人工/外部分配。";
              if (params.resumeTask && params.resumeTask.trim().length > 0) {
                hint = "提示: 已配置续做任务，排到获授后系统将自动唤醒原会话接力执行；请勿在当前轮次循环轮询。";
              }
              const text =
                `【已进入排队】所请求资源已被占用，已原子加入 FIFO 排队。\n` +
                `排队 ID: ${res.queueId}\n` +
                `队列位置: 第 ${res.position} 位\n` +
                `目标资源: [${res.resources.join(", ")}]\n` +
                hint;
              return {
                content: [{ type: "text", text }],
                details: res,
              };
            }
          }

          if (params.action === "release") {
            if (!params.token || typeof params.token !== "string") {
              throw new Error("action='release' 必须提供获授时返回的 grant token");
            }
            if (typeof params.generation !== "number" || params.generation <= 0) {
              throw new Error("action='release' 必须提供获授时对应的 generation 代际编号");
            }

            const res = await store.release({
              sessionId,
              token: params.token,
              generation: params.generation,
              resources: params.resources,
            });

            let text = `【释放成功】已释放资源: [${res.freedResources.join(", ")}]。`;
            if (res.handoff) {
              const targetName = res.handoff.targetSessionName || "未命名会话";
              if (res.handoff.resumeTask && res.handoff.resumeTask.trim().length > 0) {
                text += `\n系统已自动将锁交接给排队会话「${targetName}」，并已调度自动续做唤醒。`;
              } else {
                text += `\n系统已将锁交接给排队会话「${targetName}」，等待该会话主动接管（未配置自动续做）。`;
              }
            }
            return {
              content: [{ type: "text", text }],
              details: res,
            };
          }

          if (params.action === "cancel") {
            const res = await store.cancel({
              sessionId,
              queueId: params.queueId,
              resources: params.resources,
            });
            const text = `【取消成功】已取消 ${res.cancelledCount} 个排队项。`;
            return {
              content: [{ type: "text", text }],
              details: res,
            };
          }

          throw new Error(`未知的 action 操作: ${String(params.action)}`);
        },
      });
    },
  };
}
