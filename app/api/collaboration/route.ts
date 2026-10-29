import { NextResponse } from "next/server";
import { getCollaborationStore, sanitizeSessionTitle } from "@/lib/collaboration-store";
import { resolveOdooLanClient } from "@/lib/odoo-lan-service";
import { sanitizeError } from "@/lib/lock-handoff-dispatcher";
import type { OdooLanSnapshot } from "@/lib/odoo-lan-types";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const store = getCollaborationStore();
    const port = process.env.PORT || "30141";
    const instanceLabel = process.env.PI_INSTANCE_LABEL || `Pi Web Plus (${port})`;
    const status = store.getPublicStatus(instanceLabel);

    // 聚合 LAN Odoo 业务锁：契约要求坏配置/断线必须作为 unavailable 传播，绝不能伪装为 disabled/绿空
    let odooClient;
    let configError: string | undefined;
    try {
      odooClient = await resolveOdooLanClient();
    } catch (err) {
      configError = err instanceof Error ? err.message : String(err);
    }

    if (configError) {
      // 坏配置呈现为 unknown 错误状态，绝不能被吞掉呈现为绿空
      status.resources.push({
        key: "odoo:authority_status",
        label: "Odoo LAN 权威节点",
        status: "unknown" as any,
        owner: {
          title: `[配置异常: ${sanitizeError(configError)}]`,
        },
        queue: [],
      } as any);
    } else if (odooClient && odooClient.isConfigured()) {
      let odooSnapshot: OdooLanSnapshot | undefined;
      let odooError: string | undefined;

      try {
        odooSnapshot = odooClient.getCachedSnapshot();
        if (!odooSnapshot) {
          // 缓存未就绪时进行一次带超时的状态查询
          odooSnapshot = await Promise.race([
            odooClient.status(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("Odoo 权威节点状态查询超时")), 2000),
            ),
          ]);
        }
      } catch (err) {
        odooError = err instanceof Error ? err.message : String(err);
      }

      if (odooError || !odooSnapshot) {
        // 契约铁律：disconnected 不能空闲绿，错误呈现为 unknown
        status.resources.push({
          key: "odoo:authority_status",
          label: "Odoo LAN 权威节点",
          status: "unknown" as any,
          owner: {
            title: `[连接异常: ${sanitizeError(odooError || "状态未就绪")}]`,
          },
          queue: [],
        } as any);
      } else {
        for (const res of odooSnapshot.resources || []) {
          const isHeld = res.status === "held";
          const isHandoff = res.status === "handoff";
          const resStatus = isHeld ? "held" : isHandoff ? "handoff" : "unknown";

          let ownerTitle = "";
          let ownerNode = "";
          if (isHeld && res.owner) {
            ownerTitle = sanitizeSessionTitle(res.owner.sessionName);
            ownerNode = res.owner.instanceLabel || res.owner.instanceId || "";
          } else if (isHandoff && res.handoff) {
            ownerTitle = sanitizeSessionTitle(res.handoff.sessionName);
            ownerNode = res.handoff.instanceLabel || res.handoff.instanceId || "";
          }

          // 契约铁律：公开 DTO 绝不泄露 token、generation、PID、SID、queueId 或内部 UUID
          const queue = (res.queue || []).map((q) => ({
            title: sanitizeSessionTitle(q.sessionName),
            node: q.instanceLabel || q.instanceId || "",
            reason: q.reason || "",
            resumeTask: q.resumeTask || "",
          }));

          status.resources.push({
            key: `odoo:${res.resource}`,
            label: `Odoo: ${res.resource}`,
            status: resStatus as any,
            owner: ownerTitle ? { title: ownerTitle, node: ownerNode } : undefined as any,
            queue,
          } as any);
        }
      }
    }

    return NextResponse.json(status);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[api/collaboration] 状态读取失败(fail-closed):", msg);
    return NextResponse.json(
      { error: "协作状态存储损坏或不可用，拒绝读取" },
      { status: 503 },
    );
  }
}
