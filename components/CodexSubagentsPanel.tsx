"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { MarkdownBody } from "./MarkdownBody";
import type {
  CodexSubagentItem,
  CodexSubagentDetailResponse,
  CodexSubagentTurn,
} from "@/lib/execution-engines/codex-subagents";

interface Props {
  sessionId: string;
  sessionTitle?: string;
  isMobile: boolean;
  onClose: () => void;
}

export interface TreeAgentItem extends CodexSubagentItem {
  depth: number;
  parentName?: string;
}

function formatTime(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusColor(status: string): string {
  if (status === "completed") return "#16a34a";
  if (status === "inProgress") return "var(--accent)";
  if (status === "failed") return "#dc2626";
  if (status === "interrupted" || status === "aborted") return "#d97706";
  return "var(--text-dim)";
}

function statusLabel(status: string): string {
  if (status === "completed") return "已完成";
  if (status === "inProgress") return "运行中";
  if (status === "failed") return "失败";
  if (status === "interrupted" || status === "aborted") return "已中断";
  if (status === "unknown") return "未知状态";
  return status || "未知状态";
}

function StatusBadge({ status, archived }: { status: string; archived?: boolean }) {
  const color = statusColor(status);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      <span>{statusLabel(status)}</span>
      {archived && (
        <span style={{ fontSize: 10, padding: "1px 4px", borderRadius: 3, background: "var(--bg-hover)", color: "var(--text-dim)" }}>
          已归档
        </span>
      )}
    </span>
  );
}

export function CodexSubagentsPanel({ sessionId, sessionTitle, isMobile, onClose }: Props) {
  // Session identity tracking for synchronous reset on parent switch
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [agents, setAgents] = useState<CodexSubagentItem[]>([]);
  const [limited, setLimited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CodexSubagentDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Synchronous state reset during render if parent session changes
  if (sessionId !== activeSessionId) {
    setActiveSessionId(sessionId);
    setAgents([]);
    setLimited(false);
    setLoading(true);
    setError(null);
    setSearchQuery("");
    setSelectedAgentId(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
  }

  // Active requests tracked to cancel on unmount or session switch
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);

  const loadList = useCallback(() => {
    if (listAbortRef.current) {
      listAbortRef.current.abort();
    }
    const controller = new AbortController();
    listAbortRef.current = controller;

    setLoading(true);
    setError(null);

    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "子智能体列表获取失败");
        }
        return res.json();
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setAgents(data.agents || []);
        setLimited(Boolean(data.limited));
        setLoading(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "无法读取子智能体");
        setLoading(false);
      });
  }, [sessionId]);

  const loadDetail = useCallback(
    (agentId: string) => {
      if (detailAbortRef.current) {
        detailAbortRef.current.abort();
      }
      const controller = new AbortController();
      detailAbortRef.current = controller;

      setDetailLoading(true);
      setDetailError(null);

      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents?id=${encodeURIComponent(agentId)}`, {
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || "子智能体详情获取失败");
          }
          return res.json();
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          setDetail(data);
          setDetailLoading(false);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setDetailError(err instanceof Error ? err.message : "无法读取子智能体详情");
          setDetailLoading(false);
        });
    },
    [sessionId]
  );

  // Initial and session-change load effect
  useEffect(() => {
    loadList();

    return () => {
      if (listAbortRef.current) listAbortRef.current.abort();
      if (detailAbortRef.current) detailAbortRef.current.abort();
    };
  }, [sessionId, loadList]);

  // Load detail when selectedAgentId changes with strict identity ownership check
  useEffect(() => {
    if (!selectedAgentId) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    // Safety guard: ensure selectedAgentId belongs to the current session's loaded agents list
    const belongsToCurrentParent = agents.some((a) => a.id === selectedAgentId);
    if (!belongsToCurrentParent) {
      setDetail(null);
      setDetailError(null);
      return;
    }

    loadDetail(selectedAgentId);

    return () => {
      if (detailAbortRef.current) {
        detailAbortRef.current.abort();
      }
    };
  }, [selectedAgentId, agents, loadDetail]);

  // Build tree hierarchy: Depth-First Search for parent/child/grandchild visualization
  const treeAgents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const map = new Map<string, CodexSubagentItem>();
    const childrenMap = new Map<string, CodexSubagentItem[]>();

    for (const a of agents) {
      map.set(a.id, a);
      const list = childrenMap.get(a.parentId) || [];
      list.push(a);
      childrenMap.set(a.parentId, list);
    }

    const result: TreeAgentItem[] = [];
    const visited = new Set<string>();

    function traverse(item: CodexSubagentItem, depth: number) {
      visited.add(item.id);
      let parentName: string | undefined;
      if (item.parentId !== sessionId) {
        const p = map.get(item.parentId);
        parentName = p ? p.nickname || p.title : "上级子任务";
      }

      const matchesSearch =
        !q ||
        item.title.toLowerCase().includes(q) ||
        Boolean(item.nickname && item.nickname.toLowerCase().includes(q)) ||
        Boolean(item.role && item.role.toLowerCase().includes(q));

      if (matchesSearch) {
        result.push({
          ...item,
          depth,
          parentName,
        });
      }

      const children = childrenMap.get(item.id) || [];
      for (const child of children) {
        if (!visited.has(child.id)) {
          traverse(child, depth + 1);
        }
      }
    }

    // Top-level subagents (direct children of sessionId or roots)
    const directChildren = childrenMap.get(sessionId) || [];
    for (const rootItem of directChildren) {
      if (!visited.has(rootItem.id)) {
        traverse(rootItem, 0);
      }
    }

    // Any remaining items whose parent is not sessionId
    for (const item of agents) {
      if (!visited.has(item.id)) {
        traverse(item, 0);
      }
    }

    return result;
  }, [agents, sessionId, searchQuery]);

  return (
    <div
      role="dialog"
      aria-label="Codex 子智能体列表"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-panel)",
        border: "1px solid var(--border)",
        borderRadius: "0 0 8px 8px",
        boxShadow: "0 14px 34px rgba(0,0,0,0.18)",
        overflow: "hidden",
        width: "100%",
        maxHeight: "82dvh",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--bg)",
          minHeight: 46,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <span style={{ display: "grid", placeItems: "center", color: "var(--accent)" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          </span>
          <strong style={{ fontSize: 13, fontWeight: 600 }}>Codex 子智能体</strong>
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            ({agents.length} 个任务)
          </span>
          {limited && (
            <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "#fef3c7", color: "#b45309" }}>
              已达最多 128 个展示上限
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Read-only refresh button */}
          <button
            type="button"
            onClick={() => {
              loadList();
              if (selectedAgentId) {
                loadDetail(selectedAgentId);
              }
            }}
            disabled={loading || detailLoading}
            aria-label="刷新子智能体状态"
            title="按需只读刷新状态"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              cursor: loading || detailLoading ? "default" : "pointer",
              padding: "3px 8px",
              fontSize: 12,
              borderRadius: 4,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <span>↻</span>
            <span>刷新</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭面板"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "4px 8px",
              fontSize: 14,
              borderRadius: 4,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            ✕
          </button>
        </div>
      </div>

      {/* Main Body: Single column for mobile / Split layout for desktop */}
      <div
        style={{
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          flex: 1,
          overflow: "hidden",
          minHeight: 320,
        }}
      >
        {/* Left Column: Agents List */}
        {(!isMobile || !selectedAgentId) && (
          <div
            style={{
              width: isMobile ? "100%" : 320,
              minWidth: isMobile ? undefined : 300,
              borderRight: isMobile ? "none" : "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              background: "var(--bg-panel)",
              overflow: "hidden",
            }}
          >
            {/* Filter Search */}
            {agents.length > 5 && (
              <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
                <input
                  type="text"
                  placeholder="搜索子任务名称或角色..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{
                    width: "100%",
                    fontSize: 12,
                    padding: "5px 8px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg)",
                    color: "var(--text)",
                    outline: "none",
                  }}
                />
              </div>
            )}

            {/* List scroll container */}
            <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
              {loading && (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
                  正在加载原生子智能体列表...
                </div>
              )}

              {error && (
                <div style={{ padding: 18, textAlign: "center", color: "#dc2626", fontSize: 12 }}>
                  <div>{error}</div>
                  <button
                    type="button"
                    onClick={loadList}
                    style={{
                      marginTop: 10,
                      padding: "4px 12px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: "var(--bg)",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    重试
                  </button>
                </div>
              )}

              {!loading && !error && treeAgents.length === 0 && (
                <div style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>
                  {searchQuery ? "未找到匹配的子智能体" : "当前会话暂无派生的子智能体任务"}
                </div>
              )}

              {!loading && !error && treeAgents.map((agent) => {
                const isSelected = agent.id === selectedAgentId;
                const indentPadding = 12 + Math.min(agent.depth, 3) * 16;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    data-agent-id={agent.id}
                    onClick={() => setSelectedAgentId(agent.id)}
                    style={{
                      width: "100%",
                      padding: "8px 12px 8px 0",
                      paddingLeft: indentPadding,
                      display: "flex",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 8,
                      textAlign: "left",
                      background: isSelected ? "var(--bg-selected)" : "transparent",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      borderLeft: isSelected ? "3px solid var(--accent)" : "3px solid transparent",
                      cursor: "pointer",
                      color: "var(--text)",
                      transition: "background 0.1s",
                      boxSizing: "border-box",
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {agent.depth > 0 && (
                          <span style={{ color: "var(--text-dim)", fontFamily: "monospace", fontSize: 11, flexShrink: 0 }}>
                            └─
                          </span>
                        )}
                        <span
                          style={{
                            fontWeight: isSelected ? 600 : 500,
                            fontSize: 12,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: isMobile ? 180 : 210,
                          }}
                          title={agent.title}
                        >
                          {agent.title}
                        </span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 2, fontSize: 11, color: "var(--text-dim)" }}>
                        {agent.parentName && (
                          <span style={{ color: "var(--accent)" }}>
                            派生自: {agent.parentName}
                          </span>
                        )}
                        {agent.role && <span>角色: {agent.role}</span>}
                        {agent.updated && <span>· {formatTime(agent.updated)}</span>}
                      </div>
                    </div>
                    <div style={{ flexShrink: 0, textAlign: "right" }}>
                      <StatusBadge status={agent.status} archived={agent.archived} />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Right Column: Subagent Detail View */}
        {(!isMobile || Boolean(selectedAgentId)) && (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              background: "var(--bg)",
              overflow: "hidden",
            }}
          >
            {isMobile && selectedAgentId && (
              <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" }}>
                <button
                  type="button"
                  onClick={() => setSelectedAgentId(null)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent)",
                    cursor: "pointer",
                    fontSize: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    padding: 0,
                  }}
                >
                  ← 返回任务列表
                </button>
              </div>
            )}

            {!selectedAgentId ? (
              <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--text-dim)", fontSize: 12, padding: 24 }}>
                请在左侧选择子智能体查看执行历史与结果
              </div>
            ) : detailLoading ? (
              <div style={{ flex: 1, display: "grid", placeItems: "center", color: "var(--text-dim)", fontSize: 12, padding: 24 }}>
                正在加载子智能体历史回看...
              </div>
            ) : detailError ? (
              <div style={{ flex: 1, display: "grid", placeItems: "center", color: "#dc2626", fontSize: 12, padding: 24, textAlign: "center" }}>
                <div>
                  <div style={{ marginBottom: 10 }}>{detailError}</div>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedAgentId) loadDetail(selectedAgentId);
                    }}
                    style={{
                      padding: "4px 14px",
                      borderRadius: 4,
                      border: "1px solid var(--border)",
                      background: "var(--bg-panel)",
                      color: "var(--text)",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    重试
                  </button>
                </div>
              </div>
            ) : detail ? (
              <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
                {/* Detail Header Info */}
                <div style={{ paddingBottom: 12, marginBottom: 12, borderBottom: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <h4 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{detail.title}</h4>
                    <StatusBadge status={detail.status} archived={detail.archived} />
                  </div>
                  <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)", display: "flex", alignItems: "center", gap: 10 }}>
                    {detail.nickname && <span>昵称: {detail.nickname}</span>}
                    {detail.role && <span>角色: {detail.role}</span>}
                    <span>只读历史回看 · 零模型开销</span>
                  </div>
                </div>

                {/* Turns List */}
                {detail.turns && detail.turns.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    {detail.turns.map((turn: CodexSubagentTurn, index: number) => (
                      <div
                        key={turn.id || index}
                        style={{
                          borderRadius: 6,
                          border: "1px solid var(--border)",
                          background: "var(--bg-panel)",
                          padding: 10,
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, fontSize: 11, color: "var(--text-dim)" }}>
                          <span>第 {index + 1} 轮次</span>
                          {turn.status && <span>状态: {statusLabel(turn.status)}</span>}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {turn.messages && turn.messages.map((msg, msgIdx) => (
                            <div key={msg.id || msgIdx} style={{ fontSize: 12 }}>
                              {msg.role === "user" ? (
                                <div style={{ background: "var(--user-bg, rgba(0,0,0,0.03))", padding: "6px 8px", borderRadius: 4 }}>
                                  <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", marginBottom: 2 }}>任务指令 / 输入:</div>
                                  <MarkdownBody>{msg.text || ""}</MarkdownBody>
                                </div>
                              ) : msg.kind === "storedToolEvent" || msg.role === "activity" ? (
                                <div style={{ background: "var(--tool-bg, rgba(0,0,0,0.02))", borderLeft: "2px solid var(--accent)", padding: "4px 8px", borderRadius: 2 }}>
                                  <div style={{ fontSize: 10, color: "var(--accent)", fontWeight: 600 }}>{msg.title || "工具调用"}</div>
                                  {msg.text && (
                                    <pre style={{ margin: "2px 0 0 0", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-all", color: "var(--text-muted)" }}>
                                      {msg.text}
                                    </pre>
                                  )}
                                  {msg.output && (
                                    <div style={{ marginTop: 4, fontSize: 11, color: "var(--text-dim)" }}>
                                      输出: <span style={{ fontFamily: "var(--font-mono)" }}>{msg.output.slice(0, 300)}</span>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div>
                                  <MarkdownBody>{msg.text || ""}</MarkdownBody>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ textAlign: "center", color: "var(--text-dim)", fontSize: 12, padding: 20 }}>
                    该子智能体尚无记录轮次
                  </div>
                )}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
