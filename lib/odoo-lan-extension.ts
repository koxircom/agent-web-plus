import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { OdooLanClient, OdooLanResult, OdooLanSnapshot } from "./odoo-lan-types.ts";
import { resolveOdooLanClient } from "./odoo-lan-service.ts";
import {
  registerOdooLanConsumer,
  getOdooLanSessionConsumers,
  prepareOdooLanReacquire,
} from "./odoo-lan-runtime.ts";
import {
  resolveExtensionSessionId,
  resolveExtensionSessionName,
} from "./collaboration-extension.ts";

export const COLLABORATION_ODOO_EXTENSION_NAME = "pi-web-odoo-addon-lock";

export interface OdooAddonLockToolParams {
  action: "status" | "acquire" | "release" | "cancel";
  addon?: string;
  reason?: string;
  resumeTask?: string;
  token?: string;
  generation?: number;
  queueId?: string;
}

const OdooAddonLockToolParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["status", "acquire", "release", "cancel"],
      description: "操作类型：status(查看锁与队列状态), acquire(申请插件锁或FIFO排队), release(释放持有的插件锁), cancel(取消排队)",
    },
    addon: {
      type: "string",
      description: "Odoo 插件技术名称（如 'sale_commission', 'mrp_workorder'）",
    },
    reason: {
      type: "string",
      description: "申请原因或锁用途说明（最多500字符）",
    },
    resumeTask: {
      type: "string",
      description: "排队获授后系统自动接力执行的任务内容（最多1200字符，仅在需要排队自动续做时生效）",
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

export function createOdooLanExtension(options?: {
  client?: OdooLanClient;
  agentDir?: string;
  configFile?: string;
  timeoutMs?: number;
}): InlineExtension {
  return {
    name: COLLABORATION_ODOO_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      let activeClient: OdooLanClient | undefined = options?.client;
      let isBusy = false;
      const settledListeners = new Set<() => void>();
      let unregisterConsumer: (() => void) | undefined;

      const getClient = async (): Promise<OdooLanClient | undefined> => {
        if (!activeClient) {
          activeClient = await resolveOdooLanClient({
            configFile: options?.configFile,
            timeoutMs: options?.timeoutMs,
          });
        }
        return activeClient;
      };

      pi.on("session_start", async (_event, ctx) => {
        const sessionId = resolveExtensionSessionId(ctx);
        if (!sessionId) return;

        const client = await getClient();
        if (!client) return;

        unregisterConsumer?.();
        unregisterConsumer = registerOdooLanConsumer({
          sessionId,
          sessionName: () => resolveExtensionSessionName(ctx),
          client,
          isBusy: () => (typeof ctx?.isIdle === "function" ? !ctx.isIdle() : isBusy),
          onSettled: (cb) => {
            settledListeners.add(cb);
            return () => settledListeners.delete(cb);
          },
          isHandoffConsumedOnActiveBranch: (handoffId: string) => {
            try {
              // 契约铁律：必须检查当前活动分支 (getBranch)，绝不能用历史全量条目 (getEntries) 误判活动分支去重
              const branch = (ctx?.sessionManager?.getBranch?.() ?? []) as Array<Record<string, any>>;
              for (const e of branch) {
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

        // 启动时检查是否有待处理交接
        const consumers = getOdooLanSessionConsumers();
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

      pi.on("session_shutdown", async () => {
        // 关键契约：idle wrapper 回收或 session 关闭严禁释放业务锁！
        // 仅注销内存中的接收器。
        unregisterConsumer?.();
        unregisterConsumer = undefined;
        settledListeners.clear();
      });

      pi.registerTool({
        name: "odoo_addon_lock",
        label: "Odoo Addon Lock",
        description:
          "基于单一 Python 权威的 LAN Odoo 业务插件互斥锁与跨节点协作接力工具。提供插件独占锁定、FIFO排队、自动会话接力与代际释放功能。",
        promptSnippet:
          "内置 LAN Odoo 插件协作锁 (status/acquire/release/cancel)，支持排队获授后原会话自动接力",
        promptGuidelines: [
          "凡修改或部署 Odoo 业务插件前，必须先调用 odoo_addon_lock acquire 获取模块锁，严禁无锁修改。",
          "如果插件已被占用，系统将自动进入 FIFO 排队；请务必提供 resumeTask（不超过1200字符）；排到获授后系统将自动唤醒原会话接力执行，切勿在当前轮次死循环轮询！",
          "完成插件开发、单测与验收后，必须使用获授时返回的 token 和 generation 显式调用 action='release' 释放锁，以便其他节点或会话接力。",
          "idle wrapper 销毁或断线不会释放业务锁；业务释放必须显式 release。",
        ],
        parameters: OdooAddonLockToolParamsSchema,
        async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
          const params = rawParams as unknown as OdooAddonLockToolParams;
          const sessionId = resolveExtensionSessionId(ctx);
          if (!sessionId) {
            throw new Error("无法从会话上下文中获取有效的 sessionId 身份，拒绝执行 Odoo 锁操作");
          }
          const sessionName = resolveExtensionSessionName(ctx);
          const ownerPid = process.pid;

          const client = await getClient();
          if (!client) {
            throw new Error("Odoo LAN 客户端未配置或无法连接，拒绝执行锁操作");
          }

          if (params.action === "status") {
            const snapshot = await client.status();
            const myHeld: string[] = [];
            const myQueued: Array<{ addon: string; queueId?: string; position?: number }> = [];
            const otherHeld: Array<{ addon: string; ownerNode: string; ownerTitle: string }> = [];

            for (const res of snapshot.resources || []) {
              const addon = res.resource;
              if (
                res.status === "held" &&
                res.owner?.sessionId === sessionId &&
                res.owner?.instanceId === client.instanceId
              ) {
                myHeld.push(`${addon} (token: ${res.owner.token ?? '旧协议身份锁'}, generation: ${res.owner.generation ?? '-'})`);
              } else if (res.status === "held" && res.owner) {
                otherHeld.push({
                  addon,
                  ownerNode: res.owner.instanceLabel || res.owner.instanceId,
                  ownerTitle: res.owner.sessionName || "未命名会话",
                });
              } else if (res.status === "handoff" && res.handoff) {
                otherHeld.push({
                  addon,
                  ownerNode: res.handoff.instanceLabel || res.handoff.instanceId,
                  ownerTitle: `[交接中 -> ${res.handoff.sessionName || "未命名会话"}]`,
                });
              }

              if (Array.isArray(res.queue)) {
                const idx = res.queue.findIndex(
                  (q) => q.sessionId === sessionId && q.instanceId === client.instanceId,
                );
                if (idx !== -1) {
                  const entry = res.queue[idx];
                  myQueued.push({
                    addon,
                    queueId: entry.queueId,
                    position: idx + 1,
                  });
                }
              }
            }

            let report = "【Odoo 插件协作锁状态】\n";
            report += `当前节点: ${client.instanceLabel} (${client.instanceId})\n`;
            if (myHeld.length > 0) {
              report += `当前会话持有插件锁 (${myHeld.length}个):\n  - ${myHeld.join("\n  - ")}\n`;
            } else {
              report += "当前会话未持有任何 Odoo 插件锁。\n";
            }

            if (myQueued.length > 0) {
              report += `当前会话正在排队 (${myQueued.length}个):\n`;
              for (const q of myQueued) {
                report += `  - 插件: ${q.addon}, 队列位置: 第 ${q.position} 位\n`;
              }
            }

            if (otherHeld.length > 0) {
              report += `其他被占用插件:\n`;
              for (const o of otherHeld) {
                report += `  - ${o.addon}: 由 [${o.ownerNode}]「${o.ownerTitle}」持有\n`;
              }
            }

            return {
              content: [{ type: "text", text: report.trim() }],
              details: {
                sessionId,
                sessionName,
                instanceId: client.instanceId,
                heldCount: myHeld.length,
                queuedCount: myQueued.length,
              },
            };
          }

          if (params.action === "acquire") {
            if (!params.addon || typeof params.addon !== "string" || !params.addon.trim()) {
              throw new Error("action='acquire' 必须提供有效的 addon 插件技术名称");
            }

            const resumeTask=params.resumeTask?.trim() || '继续原会话中因Odoo插件锁等待而暂停的原任务；先核对最新源码、已完成步骤和授权范围，不新增发布、外发或权限操作。';
            if(resumeTask.length>1200||(params.reason?.length??0)>500)throw new Error('续做任务或加锁原因超出长度限制');
            await prepareOdooLanReacquire(sessionId,client);
            const rawResult = await client.request({
              action: "acquire",
              actor: {
                sessionId,
                sessionName,
                ownerPid,
              },
              resource: params.addon.trim(),
              reason: params.reason,
              resumeTask,
            });

            const result = rawResult as OdooLanResult;
            if (result.status === "acquired") {
              const text =
                `【加锁成功】已获授 Odoo 插件锁: [${params.addon}]\n` +
                `代际 (generation): ${result.generation ?? "-"}\n` +
                `凭据 (token): ${result.token ?? "旧协议身份锁"}\n` +
                `提示: 请在完成插件修改与验收后，使用该 token 与 generation 调用 action='release' 释放资源。`;
              return {
                content: [{ type: "text", text }],
                details: {
                  status: result.status,
                  resource: params.addon,
                  generation: result.generation,
                  token: result.token,
                },
              };
            } else {
              const hint = "提示: 已保存原任务续做意图，排到获授后自动接力；请结束当前轮次等待，禁止无锁写入，切勿循环轮询。";
              const text =
                `【已进入排队】Odoo 插件 [${params.addon}] 已被占用，已原子加入 FIFO 排队。\n` +
                `队列位置: 第 ${result.position ?? 1} 位\n` +
                hint;
              return {
                content: [{ type: "text", text }],
                details: {
                  status: result.status,
                  resource: params.addon,
                  position: result.position,
                  queueId: result.queueId,
                },
              };
            }
          }

          if (params.action === "release") {
            if (!params.addon || typeof params.addon !== "string" || !params.addon.trim()) {
              throw new Error("action='release' 必须提供要释放的 addon 插件技术名称");
            }
            const snapshot=await client.status();
            const ownLegacy=snapshot.resources.some(resource=>resource.resource===params.addon?.trim()&&resource.status==='held'&&resource.owner?.legacy===true&&resource.owner.sessionId===sessionId&&resource.owner.instanceId===client.instanceId);
            if(!ownLegacy&&(!params.token||typeof params.token!=='string'||!Number.isSafeInteger(params.generation)||(params.generation??0)<=0)){
              throw new Error("释放新协议锁必须提供获授的token和generation；旧锁仅可由原节点和原会话兼容释放");
            }

            const rawResult = await client.request({
              action: "release",
              actor: {
                sessionId,
                sessionName,
                ownerPid,
              },
              resource: params.addon.trim(),
              token: params.token,
              generation: params.generation,
            });

            const text = `【释放成功】已释放 Odoo 插件锁 [${params.addon}]。系统将自动调度后续排队会话接力。`;
            return {
              content: [{ type: "text", text }],
              details: rawResult,
            };
          }

          if (params.action === "cancel") {
            const rawResult = await client.request({
              action: "cancel",
              actor: {
                sessionId,
                sessionName,
                ownerPid,
              },
              resource: params.addon,
              queueId: params.queueId,
            });

            const text = `【取消成功】已取消 Odoo 插件排队项。`;
            return {
              content: [{ type: "text", text }],
              details: rawResult,
            };
          }

          throw new Error(`未知的 action 操作: ${String(params.action)}`);
        },
      });
    },
  };
}
