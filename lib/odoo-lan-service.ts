import type {
  OdooLanClient,
  OdooLanSnapshot,
  OdooLanResource,
} from "./odoo-lan-types.ts";
import { getOdooLanClient } from "./odoo-lan-client.ts";
import { sanitizeSessionTitle } from "./collaboration-store.ts";

export interface OdooWaitingSessionInfo {
  status: "waiting" | "handoff";
  ownerNode: string;
  ownerTitle: string;
  addon: string;
}

const CLIENT_STUB_SYMBOL = Symbol.for("@agegr/pi-web/odoo-lan-service/client-stub");
const globals = globalThis as unknown as Record<symbol, unknown>;
let clientSingletonPromise: Promise<OdooLanClient | undefined> | undefined;

/**
 * 允许在测试或无物理 Python 权威时显式注入 OdooLanClient stub。
 * 挂载在 globalThis 上确保跨 Jiti/Node 模块边界共享。
 */
export function setOdooLanClientStub(stub: OdooLanClient | null): void {
  globals[CLIENT_STUB_SYMBOL] = stub;
  clientSingletonPromise = undefined;
}

export function getOdooLanClientStub(): OdooLanClient | null {
  return (globals[CLIENT_STUB_SYMBOL] as OdooLanClient | null) ?? null;
}

export function resetOdooLanClientSingleton(): void {
  clientSingletonPromise = undefined;
}

/**
 * 获取系统配置的 Odoo LAN Client 单例。
 * 契约规范：
 * 1. 采用实际静态 import，杜绝 Webpack 将动态 import 上下文打空；
 * 2. 配置文件不存在或显式 enabled: false 视为未配置（安全返回 undefined）；
 * 3. 配置文件损坏或 enabled: true 但关键字段缺失必须作为 Error/unavailable 抛出或传播，绝不能伪装为 disabled/绿空！
 */
export async function resolveOdooLanClient(options?: {
  configFile?: string;
  timeoutMs?: number;
}): Promise<OdooLanClient | undefined> {
  const stub = getOdooLanClientStub();
  if (stub) {
    return stub;
  }

  if (clientSingletonPromise) {
    return clientSingletonPromise;
  }

  clientSingletonPromise = (async () => {
    // 静态构造客户端实例
    const client = getOdooLanClient(options);

    // isConfigured() 在配置 malformed 时会抛出 Error
    // 此处绝不能 catch 掉转化为 undefined，必须让坏配置作为异常传播
    const configured = client.isConfigured();
    if (configured) {
      return client;
    }
    return undefined;
  })();

  return clientSingletonPromise;
}

/**
 * 将 Odoo LAN 快照纯内存投影为当前实例中各本地会话的等待状态映射。
 * 纯 0-Token 内存计算，无网络/无模型开销。
 * 契约严格要求：绝不暴露 token/generation/PID/内部 UUID，仅映射会话状态与公开显示信息。
 */
export function projectOdooWaitingSessions(
  snapshot: OdooLanSnapshot | undefined,
  currentInstanceId: string,
): Record<string, OdooWaitingSessionInfo> {
  if (!snapshot || !Array.isArray(snapshot.resources)) {
    return {};
  }

  const result: Record<string, OdooWaitingSessionInfo> = {};

  for (const res of snapshot.resources) {
    const addon = res.resource || "未知插件";

    // 1. 检查是否有排队会话属于本实例
    if (Array.isArray(res.queue)) {
      for (const q of res.queue) {
        if (q.instanceId === currentInstanceId && q.sessionId) {
          // 当前持有者的显示信息
          let ownerNode = "群晖30141";
          let ownerTitle = "未命名会话（标题尚未生成）";

          if (res.status === "held" && res.owner) {
            ownerNode = res.owner.instanceLabel || res.owner.instanceId || ownerNode;
            ownerTitle = sanitizeSessionTitle(res.owner.sessionName);
          } else if (res.status === "handoff" && res.handoff) {
            ownerNode = res.handoff.instanceLabel || res.handoff.instanceId || ownerNode;
            ownerTitle = sanitizeSessionTitle(res.handoff.sessionName);
          }

          result[q.sessionId] = {
            status: "waiting",
            ownerNode,
            ownerTitle,
            addon,
          };
        }
      }
    }

    // 2. 检查是否有交接中的会话属于本实例
    if (res.status === "handoff" && res.handoff) {
      const h = res.handoff;
      if (h.instanceId === currentInstanceId && h.sessionId) {
        const ownerNode = h.instanceLabel || h.instanceId || "群晖30141";
        const ownerTitle = sanitizeSessionTitle(h.sessionName);

        result[h.sessionId] = {
          status: "handoff",
          ownerNode,
          ownerTitle,
          addon,
        };
      }
    }
  }

  return result;
}
