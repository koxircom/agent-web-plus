"use client";

import { useState, type CSSProperties } from "react";
import type { NoticeItem } from "@/hooks/useAgentSession";
import { noticeRecoveryHelp } from "@/lib/notice-recovery";
import { copyText } from "@/lib/clipboard";

const actionStyle: CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", background: "var(--bg)", color: "var(--text)", cursor: "pointer", font: "inherit", lineHeight: 1.4 };

function NoticeRecoveryActions({ notice, sessionId, onRefresh, onOpenConnectionSettings }: {
  notice: NoticeItem;
  sessionId?: string;
  onRefresh?: () => void;
  onOpenConnectionSettings?: () => void;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const [copyFallback, setCopyFallback] = useState("");
  const copyProblem = async () => {
    // Excludes URL credentials, private query parameters and the chat transcript.
    const link = sessionId ? `${window.location.origin}/?session=${encodeURIComponent(sessionId)}` : "尚未创建会话";
    const text = `会话：${link}\n提示：${notice.message}\n处理方式：${noticeRecoveryHelp(notice.recovery)}`;
    try {
      await copyText(text);
      setCopyStatus("已复制，请先检查并删除私人内容后再分享");
      setCopyFallback("");
    } catch {
      setCopyStatus("浏览器未允许复制，请长按或选中下方内容手动复制");
      setCopyFallback(text);
    }
  };
  return <div style={{ marginTop: 10, whiteSpace: "normal" }}>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {notice.recovery === "connection" && onOpenConnectionSettings && <button type="button" style={actionStyle} onClick={onOpenConnectionSettings}>打开连接设置</button>}
      {notice.recovery === "session" && onRefresh && <button type="button" style={actionStyle} onClick={onRefresh}>刷新会话状态</button>}
      <button type="button" style={actionStyle} onClick={() => void copyProblem()}>复制问题信息</button>
    </div>
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", color: "var(--text)" }}>查看处理方式</summary>
      <p style={{ margin: "8px 0", whiteSpace: "pre-line" }}>{noticeRecoveryHelp(notice.recovery)}</p>
      <a href="https://github.com/koxircom/agent-web-plus/issues" target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>打开问题反馈</a>
    </details>
    {copyStatus && <div role="status" style={{ marginTop: 8 }}>{copyStatus}</div>}
    {copyFallback && <textarea aria-label="待手动复制的问题信息" readOnly value={copyFallback} onFocus={event => event.currentTarget.select()} style={{ width: "100%", minHeight: 96, marginTop: 8, background: "var(--bg)", color: "var(--text)" }} />}
  </div>;
}

// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下 padding(14*2) - 上下边框(1*2)
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 30;

export function NoticeShelf({ notices, floating = false, onPauseChange, onDismiss, onRefresh, onOpenConnectionSettings, sessionId }: {
  notices: NoticeItem[];
  floating?: boolean;
  onPauseChange?: (id: string | null) => void;
  onDismiss: (id: string) => void;
  onRefresh?: () => void;
  onOpenConnectionSettings?: () => void;
  sessionId?: string;
}) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            onMouseEnter={() => onPauseChange?.(notice.id)}
            onMouseLeave={(event) => {
              if (!event.currentTarget.contains(document.activeElement)) onPauseChange?.(null);
            }}
            onFocus={() => onPauseChange?.(notice.id)}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !event.currentTarget.matches(":hover")) onPauseChange?.(null);
            }}
            style={{
              display: "flex",
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: 60,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 14,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 14,
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: 14px vertical
                // padding + (21px line box - 7px dot) / 2
                marginTop: 21,
              }}
            />
            {/* Full text by default: pre-line preserves \n (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <div
              tabIndex={0}
              style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              <div style={{ whiteSpace: "pre-line" }}>{notice.message}</div>
              {(notice.type === "warning" || notice.type === "error" || notice.recovery) && <NoticeRecoveryActions notice={notice} sessionId={sessionId} onRefresh={onRefresh} onOpenConnectionSettings={onOpenConnectionSettings} />}
            </div>
            <button type="button" aria-label="关闭提示" onClick={() => onDismiss(notice.id)} style={{ ...actionStyle, flexShrink: 0, marginTop: 10 }}>×</button>
          </div>
        );
      })}
    </div>
  );
}

