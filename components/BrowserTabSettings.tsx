"use client";

import { useState } from "react";
import { getBrowserTabTitleSnapshot, useBrowserTabTitle } from "@/hooks/useBrowserTabTitle";
import { sanitizeRawBrowserTabTitle } from "@/lib/browser-tab-title-normalization";
import { BRAND_NAME } from "@/lib/branding";
import { buildTabFaviconSvg } from "@/lib/tab-favicon";
import { DEFAULT_TAB_APPEARANCE, formatBrowserTabTitle, isBrowserTabAppearance, sameBrowserTabAppearance, type BrowserTabAppearance } from "@/lib/browser-tab-appearance";
import { ConfigButton } from "./SettingsUi";

type Draft = { text: string; appearance: BrowserTabAppearance; baseRevision: number };
export function BrowserTabSettings({ cwd, engine }: { cwd: string | null; engine: "pi" | "codex" }) {
  const { rawTitle, appearance, revision, saveTitle, resetTitle, isLoading, error } = useBrowserTabTitle();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const server: Draft = { text: rawTitle, appearance: appearance ?? { ...DEFAULT_TAB_APPEARANCE, titleTemplate: rawTitle.trim() ? "{text}" : DEFAULT_TAB_APPEARANCE.titleTemplate }, baseRevision: revision };
  const value = draft ?? server;
  const changed = value.text !== server.text || !sameBrowserTabAppearance(value.appearance, server.appearance);
  const valid = isBrowserTabAppearance(value.appearance);
  const project = cwd?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "";
  const hex = value.appearance.themeColor;
  const rgb = hex ? [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) : null;
  const previewColor = rgb ? (rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > .179 ? "#111111" : "#ffffff") : "var(--text)";
  const preview = formatBrowserTabTitle(value.appearance, { project, agent: engine === "codex" ? "Codex" : "Pi Agent", text: value.text, app: BRAND_NAME });
  const update = (patch: Partial<BrowserTabAppearance>) => { setDraft({ ...value, appearance: { ...value.appearance, ...patch } }); setFeedback(""); };
  const save = async (reset = false) => {
    if (saving || isLoading) return;
    setSaving(true); setFeedback("");
    try {
      const result = reset ? await resetTitle() : await saveTitle(value.text, value.appearance, value.baseRevision);
      if (result.success) { setDraft(null); setFeedback(reset ? "已恢复默认标签页" : "已保存，同一服务的其他页面会自动同步"); }
      else {
        if (result.conflict) setDraft(current => current ? { ...current, baseRevision: getBrowserTabTitleSnapshot().revision } : current);
        setFeedback(result.conflict ? "设置已被其他页面修改。你的草稿已保留，请核对后再次保存。" : `保存失败：${result.error || "请稍后重试"}`);
      }
    } finally { setSaving(false); }
  };
  return <section className="settings-general settings-browser-tab" aria-label="浏览器标签页">
    <div className="settings-row-info">
      <h2 className="settings-general-title">浏览器标签页</h2>
      <p className="settings-row-description">组合项目、Agent 名称和自定义文本；保存到当前服务，跨浏览器同步。</p>
    </div>
    <div className="settings-browser-tab-fields">
      <label htmlFor="settings-browser-tab-template">标题模板</label>
      <input id="settings-browser-tab-template" className="settings-select" value={value.appearance.titleTemplate} disabled={saving || isLoading} maxLength={320} onChange={e => update({ titleTemplate: e.target.value })} aria-describedby="settings-tab-template-help" />
      <div id="settings-tab-template-help" className="settings-row-description">支持 {'{project}'} 项目、{'{agent}'} Pi Agent/Codex、{'{text}'} 自定义文本、{'{app}'} 应用名。可自由调整顺序和分隔符。</div>
      <div className="settings-browser-tab-presets" aria-label="标题组合预设">
        {[["项目 + Agent", "{project} · {agent}"], ["项目 + 自定义", "{project} · {text}"], ["仅自定义", "{text}"], ["默认", DEFAULT_TAB_APPEARANCE.titleTemplate]].map(([label, template]) => <ConfigButton key={label} size="small" variant="ghost" disabled={saving || isLoading} onClick={() => update({ titleTemplate: template })}>{label}</ConfigButton>)}
      </div>
      <label htmlFor="settings-browser-tab-title">自定义文本</label>
      <input id="settings-browser-tab-title" className="settings-select" value={value.text} disabled={saving || isLoading} maxLength={160} placeholder="例如：开发环境、正式环境" onChange={e => { setDraft({ ...value, text: sanitizeRawBrowserTabTitle(e.target.value) }); setFeedback(""); }} />
      <div className="settings-browser-tab-colors">
        {([["logoColor", "Logo 颜色"], ["themeColor", "标签页主题色"]] as const).map(([key, label]) => <div key={key} className="settings-browser-tab-color">
          <label htmlFor={`settings-tab-${key}`}>{label}</label>
          <div className="settings-browser-tab-color-controls">
            <input id={`settings-tab-${key}`} type="color" value={value.appearance[key] || "#6250e9"} disabled={saving || isLoading} onChange={e => update({ [key]: e.target.value })} />
            <span>{value.appearance[key] || "自动"}</span>
            <ConfigButton size="small" variant="ghost" disabled={saving || isLoading || !value.appearance[key]} onClick={() => update({ [key]: "" })}>自动</ConfigButton>
          </div>
        </div>)}
      </div>
      <p className="settings-row-description">主题色用于支持它的浏览器工具栏和独立窗口。桌面 Chrome 等浏览器不允许网页更改单个标签的背景色；上方预览仅供配色参考。Logo 颜色不改变任务状态角标。</p>
      <div className="settings-browser-tab-preview" aria-label="标签页预览" style={{ background: value.appearance.themeColor || "var(--bg-hover)", color: previewColor }}>
        {/* Native SVG geometry is shared with the real favicon; no external resource. */}
        <img width="24" height="24" alt="标签页 Logo 预览" src={`data:image/svg+xml,${encodeURIComponent(buildTabFaviconSvg(engine, undefined, value.appearance.logoColor))}`} />
        <span>{preview}</span><span aria-hidden="true">×</span>
      </div>
      {!valid && <p role="alert" className="settings-row-description">请输入非空模板（最多 160 个字符），仅使用上方支持的变量。</p>}
      <div className="settings-browser-tab-actions">
        <ConfigButton size="small" variant="primary" aria-label="保存标签页设置" disabled={saving || isLoading || !changed || !valid} onClick={() => void save()}>{saving ? "保存中…" : "保存标签页设置"}</ConfigButton>
        <ConfigButton size="small" variant="ghost" disabled={saving || isLoading || (!rawTitle && !appearance && !draft)} onClick={() => void save(true)}>恢复默认</ConfigButton>
      </div>
      {(feedback || error) && <p role="status" className="settings-row-description">{feedback || `设置读取失败：${error}`}</p>}
    </div>
  </section>;
}
