"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfigButton } from "./SettingsUi";

export interface CollaborationQueueItem {
  title: string;
  node?: string;
  reason: string;
  resumeTask: string;
}

export interface CollaborationResourceItem {
  key: string;
  label: string;
  status: "held" | "handoff" | "unknown";
  owner?: {
    title: string;
    node?: string;
  } | null;
  queue: CollaborationQueueItem[];
}

export interface CollaborationCapabilities {
  piAutoResume: boolean;
  codexAutoResume: boolean;
  scope: string;
  enforcement: string;
}

export interface CollaborationResponse {
  capabilities: CollaborationCapabilities;
  resources: CollaborationResourceItem[];
  updatedAt: string;
  instanceLabel: string;
}

/**
 * 格式化会话标题，严格杜绝内部 sessionID / UUID / S编号泄露。
 * 契约要求：不得用内部 sessionID/编号 fallback，使用“未命名会话（标题尚未生成）”等明确占位。
 */
export function formatSessionTitle(title: unknown): string {
  if (typeof title !== "string") return "未命名会话（标题尚未生成）";
  const trimmed = title.trim();
  if (!trimmed) return "未命名会话（标题尚未生成）";
  const isUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(trimmed);
  const isHexId = /^[0-9a-fA-F]{16,}$/.test(trimmed);
  const isInternalShortId = /^S\d+$/i.test(trimmed);
  if (isUuid || isHexId || isInternalShortId) {
    return "未命名会话（标题尚未生成）";
  }
  return trimmed;
}

export function formatTimestamp(isoString: unknown): string {
  if (typeof isoString !== "string" || !isoString) return "-";
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleString("zh-CN", {
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return isoString;
  }
}

function parseCollaborationData(data: unknown): CollaborationResponse {
  if (!data || typeof data !== "object") {
    throw new Error("协作服务返回的数据格式无效。");
  }
  const obj = data as Partial<CollaborationResponse>;
  const caps = obj.capabilities;
  if (!caps || typeof caps !== "object") {
    throw new Error("缺少 capabilities 声明。");
  }
  if (!Array.isArray(obj.resources)) {
    throw new Error("缺少 resources 列表。");
  }
  return {
    capabilities: {
      piAutoResume: Boolean(caps.piAutoResume),
      codexAutoResume: Boolean(caps.codexAutoResume),
      scope: typeof caps.scope === "string" ? caps.scope : "instance",
      enforcement: typeof caps.enforcement === "string" ? caps.enforcement : "cooperative",
    },
    resources: obj.resources.map((item) => {
      const res = (item ?? {}) as Partial<CollaborationResourceItem>;
      const ownerObj = res.owner && typeof res.owner === "object" ? res.owner : null;
      const resStatus = res.status === "handoff" ? "handoff" : res.status === "unknown" ? "unknown" : "held";
      return {
        key: typeof res.key === "string" ? res.key : "",
        label: typeof res.label === "string" ? res.label : (typeof res.key === "string" ? res.key : "未命名资源"),
        status: resStatus,
        owner: ownerObj
          ? {
              title: typeof ownerObj.title === "string" ? ownerObj.title : "",
              node: typeof ownerObj.node === "string" ? ownerObj.node : undefined,
            }
          : null,
        queue: Array.isArray(res.queue)
          ? res.queue.map((q) => {
              const queueItem = (q ?? {}) as Partial<CollaborationQueueItem>;
              return {
                title: typeof queueItem.title === "string" ? queueItem.title : "",
                node: typeof queueItem.node === "string" ? queueItem.node : undefined,
                reason: typeof queueItem.reason === "string" ? queueItem.reason : "",
                resumeTask: typeof queueItem.resumeTask === "string" ? queueItem.resumeTask : "",
              };
            })
          : [],
      };
    }),
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
    instanceLabel: typeof obj.instanceLabel === "string" ? obj.instanceLabel : "当前实例",
  };
}

export function CollaborationSettings() {
  const [data, setData] = useState<CollaborationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshIndex, setRefreshIndex] = useState(0);

  const mountedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const loadData = useCallback(() => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    void fetch("/api/collaboration", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const errDetail = body && typeof body === "object" && "error" in body && typeof body.error === "string"
            ? body.error
            : `读取协作接力状态失败（HTTP ${response.status}）。`;
          throw new Error(errDetail);
        }
        return parseCollaborationData(body);
      })
      .then((parsed) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setData(parsed);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setError(err instanceof Error ? err.message : "读取协作接力状态失败。");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadData();

    return () => {
      mountedRef.current = false;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
    };
  }, [loadData, refreshIndex]);

  const handleRefresh = useCallback(() => {
    setRefreshIndex((idx) => idx + 1);
  }, []);

  return (
    <section className="settings-general settings-general-section settings-collaboration-panel" aria-labelledby="collaboration-title">
      <div className="settings-collaboration-header">
        <div>
          <h2 id="collaboration-title" className="settings-collaboration-title">协作接力</h2>
          <p className="settings-collaboration-subtitle">
            查看通用资源及已配置的 Odoo 共享资源持有状态、等待队列与原任务续做计划。
          </p>
        </div>
        <div className="settings-collaboration-actions">
          <ConfigButton
            variant="secondary"
            disabled={loading}
            onClick={handleRefresh}
          >
            {loading ? "刷新中..." : "刷新状态"}
          </ConfigButton>
        </div>
      </div>

      {/* 机制提示卡片：同实例合作型互斥、Pi自动续做、Codex支持与Token消耗说明 */}
      <div className="settings-collaboration-banner" role="region" aria-label="协作机制提示">
        <div className="settings-collaboration-banner-title">
          <span>协作方式</span>
          {data?.instanceLabel && (
            <span className="settings-collaboration-pill">实例: {data.instanceLabel}</span>
          )}
        </div>
        <ul className="settings-collaboration-banner-list">
          <li>
            <strong>合作型互斥：</strong>按资源互斥协作；未接入协议的外部脚本不在保护范围。
          </li>
          <li>
            <strong>Pi 自动接力：</strong>仅唤醒已获授且配置了续做目标的原会话。等待不调用模型；实际续做会消耗模型 Token。
          </li>
          <li>
            <strong>边界与限制：</strong>Codex 执行端暂不支持自动唤醒；通用锁仅限本实例，Odoo 插件锁按局域网配置共享。
          </li>
        </ul>
      </div>

      {/* 状态分流展示：错误态、加载态、空态、成功内容态 */}
      {error && (
        <div className="settings-collaboration-alert" role="alert">
          <div className="settings-collaboration-alert-title">状态加载受阻</div>
          <p className="settings-collaboration-alert-message">{error}</p>
          <ConfigButton variant="secondary" onClick={handleRefresh}>
            重试加载
          </ConfigButton>
        </div>
      )}

      {loading && !data && (
        <div className="settings-collaboration-loading" role="status" aria-busy="true">
          <div className="settings-loading-skeleton" aria-hidden="true">
            <div /><div /><div />
          </div>
          <p className="settings-collaboration-loading-text">正在查询协作资源与等待队列...</p>
        </div>
      )}

      {data && !error && !loading && data.resources.length === 0 && (
        <div className="settings-collaboration-empty" role="status">
          <div className="settings-collaboration-empty-badge">空闲就绪</div>
          <h3 className="settings-collaboration-empty-title">暂无已登记的资源占用</h3>
          <p className="settings-collaboration-empty-desc">
            当前没有已登记的占用或排队任务；未接入协作协议的外部操作不在此列表中。
          </p>
          <div className="settings-collaboration-meta">
            最后更新：{formatTimestamp(data.updatedAt)}
          </div>
        </div>
      )}

      {data && !error && !loading && data.resources.length > 0 && (
        <div className="settings-collaboration-list" role="feed" aria-label="协作资源列表">
          {data.resources.map((resource) => {
            const isHeld = resource.status === "held";
            const isHandoff = resource.status === "handoff";
            const ownerTitle = formatSessionTitle(resource.owner?.title);
            const ownerDisplay = resource.owner?.node
              ? `[${resource.owner.node}] ${ownerTitle}`
              : ownerTitle;
            const queueCount = resource.queue.length;

            return (
              <div key={resource.key} className="settings-collaboration-card">
                <div className="settings-collaboration-card-head">
                  <div className="settings-collaboration-card-label-row">
                    <strong className="settings-collaboration-resource-name">{resource.label}</strong>
                    <code className="settings-collaboration-resource-key">{resource.key}</code>
                  </div>
                  <span
                    className={`settings-collaboration-status-badge ${
                      isHeld ? "is-held" : isHandoff ? "is-handoff" : "is-unknown"
                    }`}
                  >
                    {isHeld ? "已持有独占锁" : isHandoff ? "接力交接中" : "状态待确认/异常"}
                  </span>
                </div>

                <div className="settings-collaboration-owner-box">
                  <div className="settings-collaboration-field-label">当前持有会话：</div>
                  <div className="settings-collaboration-field-value is-owner">
                    {ownerDisplay}
                  </div>
                </div>

                <div className="settings-collaboration-queue-section">
                  <div className="settings-collaboration-queue-head">
                    <span className="settings-collaboration-queue-title">
                      等待接力队列（{queueCount} 个会话）
                    </span>
                  </div>

                  {queueCount === 0 ? (
                    <div className="settings-collaboration-queue-empty">
                      无排队会话，释放后直接就绪
                    </div>
                  ) : (
                    <ol className="settings-collaboration-queue-list">
                      {resource.queue.map((item, index) => {
                        const queueTitle = formatSessionTitle(item.title);
                        const queueDisplay = item.node
                          ? `[${item.node}] ${queueTitle}`
                          : queueTitle;
                        return (
                          <li key={index} className="settings-collaboration-queue-item">
                            <div className="settings-collaboration-queue-order">#{index + 1}</div>
                            <div className="settings-collaboration-queue-content">
                              <div className="settings-collaboration-queue-session">
                                <span className="settings-collaboration-queue-label">排队会话：</span>
                                <span className="settings-collaboration-queue-val font-semibold">{queueDisplay}</span>
                              </div>
                              <div className="settings-collaboration-queue-reason">
                                <span className="settings-collaboration-queue-label">等待原因：</span>
                                <span className="settings-collaboration-queue-val">{item.reason || "未注明"}</span>
                              </div>
                              <div className="settings-collaboration-queue-task">
                                <span className="settings-collaboration-queue-label">接力目标：</span>
                                <span className="settings-collaboration-queue-val">{item.resumeTask || "未注明"}</span>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              </div>
            );
          })}

          <div className="settings-collaboration-footer-info">
            <span>实例标签: {data.instanceLabel}</span>
            <span>·</span>
            <span>更新时间: {formatTimestamp(data.updatedAt)}</span>
            {loading && <span>（正在刷新...）</span>}
          </div>
        </div>
      )}
    </section>
  );
}
