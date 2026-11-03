import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProcessDetailsGroup, ProcessDurationBadge } from "../../components/ChatWindow";
import {
  createToolProcessSummary,
  includeToolInProcessSummary,
} from "../../lib/tool-public-status";
import { zhCNLocale } from "../../lib/i18n/messages/zh-CN";

export function ProcessDurationFixtureApp() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // Scene 1: Completed subagent (duration = 4000ms -> "4秒")
  const summaryCompleted = createToolProcessSummary();
  includeToolInProcessSummary(
    summaryCompleted,
    { type: "toolCall", toolName: "subagent", toolCallId: "s1", input: {} },
    { role: "toolResult", toolCallId: "s1", content: [], timestamp: 5000 },
    1000,
  );

  // Scene 2: Running subagent (started 3 seconds ago)
  const summaryRunning = createToolProcessSummary();
  includeToolInProcessSummary(
    summaryRunning,
    { type: "toolCall", toolName: "subagent", toolCallId: "s2", input: {} },
    undefined,
    Date.now() - 3000,
  );

  // Scene 3: Regular tools without subagent
  const summaryRegular = createToolProcessSummary();
  includeToolInProcessSummary(
    summaryRegular,
    { type: "toolCall", toolName: "read", toolCallId: "r1", input: {} },
    { role: "toolResult", toolCallId: "r1", content: [], timestamp: 2000 },
    1000,
  );

  const t = (key: string, params: Record<string, string | number> = {}) => {
    let res = (zhCNLocale.messages as Record<string, string>)[key] || key;
    for (const [k, v] of Object.entries(params)) {
      res = res.replace(`{${k}}`, String(v));
    }
    return res;
  };

  return (
    <div
      data-theme={theme}
      style={{
        padding: 16,
        background: theme === "dark" ? "#18181b" : "#ffffff",
        color: theme === "dark" ? "#f4f4f5" : "#18181b",
        fontFamily: "system-ui, -apple-system, sans-serif",
        minHeight: "100vh",
        boxSizing: "border-box",
      }}
    >
      <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
        <button
          type="button"
          data-testid="toggle-theme"
          onClick={() => setTheme((prev) => (prev === "dark" ? "light" : "dark"))}
          style={{
            padding: "4px 8px",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          切换主题（当前：{theme}）
        </button>
      </div>

      <div
        data-testid="container-completed"
        style={{
          border: "1px solid rgba(255,255,255,0.1)",
          padding: 12,
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 6 }}>
          场景 1：已完成子任务（应当显示 ⏱️ ≈4秒，停止不 tick，紧随 label）
        </div>
        <ProcessDetailsGroup toolStates={summaryCompleted} t={t}>
          <div data-testid="completed-details" style={{ fontSize: 12, color: "#71717a" }}>
            子任务已顺利完成
          </div>
        </ProcessDetailsGroup>
      </div>

      <div
        data-testid="container-running"
        style={{
          border: "1px solid rgba(255,255,255,0.1)",
          padding: 12,
          borderRadius: 8,
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 6 }}>
          场景 2：进行中子任务（应当动态计时，⏱️ 紧随 label）
        </div>
        <ProcessDetailsGroup toolStates={summaryRunning} t={t}>
          <div data-testid="running-details" style={{ fontSize: 12, color: "#71717a" }}>
            子任务正在执行中...
          </div>
        </ProcessDetailsGroup>
      </div>

      <div
        data-testid="container-regular"
        style={{
          border: "1px solid rgba(255,255,255,0.1)",
          padding: 12,
          borderRadius: 8,
        }}
      >
        <div style={{ fontSize: 11, color: "#a1a1aa", marginBottom: 6 }}>
          场景 3：常规工具（不应展示子任务计时 Badge）
        </div>
        <ProcessDetailsGroup toolStates={summaryRegular} t={t}>
          <div data-testid="regular-details" style={{ fontSize: 12, color: "#71717a" }}>
            普通文件读取
          </div>
        </ProcessDetailsGroup>
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<ProcessDurationFixtureApp />);
}
