"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsMobile } from "@/hooks/useIsMobile";

type Level = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface Props {
  levels: readonly Level[];
  value: Level;
  displayLabel: string;
  levelMap?: Record<string, string | null> | null;
  descriptions: Record<string, string>;
  label: string;
  title: string;
  disabled: boolean;
  native: boolean;
  onChange: (level: Level) => void;
}

/** A native anchored menu; its portal never participates in the composer grid. */
export function ThinkingSelector({ levels, value, displayLabel, levelMap, descriptions, label, title, disabled, native, onChange }: Props) {
  const isMobile = useIsMobile();
  const keyboardOpen = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; bottom: number; right: number } | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0, left: 0, top: 0 });
  const updateAnchor = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) setAnchor({ top: rect.top, bottom: rect.bottom, right: rect.right });
    const v = window.visualViewport;
    setViewport({ width: v?.width ?? window.innerWidth, height: v?.height ?? window.innerHeight, left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0 });
  };
  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus && (!isMobile || keyboardOpen.current)) trigger.current?.focus();
  };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    const reposition = () => updateAnchor();
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    const selected = panel.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    if (!isMobile || keyboardOpen.current) (selected ?? panel.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
    };
  // Reposition reads refs and viewport; selection changes close the menu.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const width = Math.min(248, Math.max(0, viewport.width - 16));
  const above = anchor ? anchor.top - viewport.top - 8 : 0;
  const below = anchor ? viewport.top + viewport.height - anchor.bottom - 8 : 0;
  const useAbove = above >= Math.min(levels.length * 34 + 10, 240) || above >= below;
  const maxHeight = Math.max(0, Math.min(320, useAbove ? above : below));
  return (
    <div className="thinking-selector" data-pi-native-thinking-selector="true" data-pi-thinking-control={native ? "true" : undefined}>
      <button ref={trigger} type="button" aria-label={label} title={title} aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
        style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, height: 32, padding: "0 8px", border: "none", borderRadius: 9, background: "transparent", color: "var(--text-muted)", fontSize: 12, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1 }}
        onPointerDown={(event) => { keyboardOpen.current = false; const active = document.activeElement; if (isMobile && active?.matches("textarea, input, [contenteditable]")) event.preventDefault(); }}
        onClick={() => { updateAnchor(); setOpen((current) => !current); }}
        onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); keyboardOpen.current = true; updateAnchor(); setOpen(true); panel.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus(); } }}>
        <span style={{ whiteSpace: "nowrap" }}>{displayLabel}</span>
      </button>
      {open && anchor && typeof document !== "undefined" && createPortal(
        <div ref={panel} role="listbox" aria-label={label} data-pi-native-thinking-selector="true" className="thinking-selector-menu pi-native-menu-motion"
          style={{ position: "fixed", zIndex: 1200, boxSizing: "border-box", width, maxHeight, left: Math.max(viewport.left + 8, Math.min(anchor.right - width, viewport.left + viewport.width - width - 8)), ...(useAbove ? { bottom: window.innerHeight - anchor.top + 6 } : { top: anchor.bottom + 6 }) }}
          onKeyDown={(event) => {
            if (event.key === "Tab") { close(); return; }
            const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === "ArrowDown" ? (index + 1) % buttons.length : event.key === "ArrowUp" ? (index - 1 + buttons.length) % buttons.length : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : -1;
            if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
          }}>
          {levels.map((level) => {
            const mapped = levelMap?.[level];
            const active = level === value;
            return <button key={level} type="button" role="option" aria-selected={active} className="thinking-selector-option"
              onPointerDown={(event) => { if (isMobile && !keyboardOpen.current) event.preventDefault(); }}
              onClick={() => { close(true); if (!active) onChange(level); }}>
              <span style={{ width: 12, flexShrink: 0, color: "var(--text)", textAlign: "center" }} aria-hidden="true">{active ? "✓" : ""}</span>
              <span style={{ whiteSpace: "nowrap" }}>{mapped ?? level}{mapped && mapped !== level ? ` (${level})` : ""}</span>
              <span className="thinking-selector-description">{descriptions[level]}</span>
            </button>;
          })}
        </div>, document.body)}
    </div>
  );
}
