"use client";

import { useState } from "react";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";

type Engine = "pi" | "codex";

const renderAgentName = (label: string, id?: string) => <span className={`agent-engine-label agent-engine-label-${id === "codex" ? "codex" : "pi"}`}>{label}</span>;

/** The shell owns engine/navigation state; this control owns only its pending UI. */
export function ExecutionEngineSwitcher({ engine, connected, codexEnabled, onChange }: {
  engine: Engine;
  connected: boolean;
  codexEnabled: boolean;
  onChange?: (engine: Engine) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options: ModelSelectorOption[] = [
    { provider: "agent", modelId: "pi", name: "Pi Agent" },
    { provider: "agent", modelId: "codex", name: "Codex", disabled: !codexEnabled },
  ];

  return <div className="pi-native-engine-switcher min-w-0" data-pi-native-engine-switcher="true">
    <ModelSelector
      ariaLabel="切换 Agent"
      title={pending ? "正在切换 Agent…" : "切换 Agent"}
      options={options}
      value={{ provider: "agent", modelId: engine }}
      selectedLabel={engine === "pi" ? "Pi Agent" : "Codex"}
      disabled={pending || !onChange}
      placement="down"
      showIcon={false}
      showChevron
      renderLabel={renderAgentName}
      onChange={async (_provider, modelId) => {
        if (modelId !== "pi" && modelId !== "codex") return;
        setError(null);
        setPending(true);
        try { await onChange?.(modelId as Engine); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "切换失败，请重试"); }
        finally { setPending(false); }
      }}
    />
    <div role="status" aria-live="polite" className="flex items-center gap-1 text-[10px] text-text-muted" title={error || (connected ? "网页服务已连接，任务状态自动同步" : "正在恢复连接，聊天记录和草稿会保留")}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: connected ? "#22c55e" : "#eab308", flexShrink: 0 }} />
      <span>{error ? "切换失败" : (pending ? "正在切换…" : connected ? "已连接" : "连接恢复中…")}</span>
    </div>
  </div>;
}
