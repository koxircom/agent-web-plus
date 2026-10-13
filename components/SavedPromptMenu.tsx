"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { needsPromptRecovery, type PendingPromptSubmission } from "@/lib/prompt-submissions";

const buttonStyle: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  width: 28, height: 28, padding: 0, flexShrink: 0,
  border: 0, borderRadius: 8, background: "transparent", color: "var(--text-muted)", cursor: "pointer",
};

function SavedPrompt({ submission, onConfirm }: {
  submission: PendingPromptSubmission;
  onConfirm: (submission: PendingPromptSubmission) => Promise<void>;
}) {
  const { t } = useI18n();
  const [checking, setChecking] = useState(false);
  return (
    <article data-pi-saved-prompt={submission.requestId} style={{ padding: "12px 0", borderTop: "1px solid var(--border)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span>{t(submission.status === "recalled" ? "chat.recalledTitle" : submission.status === "unconfirmed" ? "chat.pendingSaveFailedTitle" : "chat.pendingTitle")}</span>
        <button type="button" disabled={checking} className="rounded-md border border-border px-2 py-1 text-text-muted hover:bg-bg-hover disabled:opacity-50"
          onClick={async () => {
            if (checking) return;
            setChecking(true);
            try { await onConfirm(submission); }
            finally { setChecking(false); }
          }}>
          {t(checking ? "chat.pendingChecking" : submission.status === "recalled" ? (submission.recallRestored ? "chat.recalledConfirm" : "chat.recalledRestore") : "chat.pendingCheck")}
        </button>
      </div>
      <details style={{ marginTop: 8 }}>
        <summary style={{ cursor: "pointer", color: "var(--text-muted)" }}>原文</summary>
        <div style={{ marginTop: 8, whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text" }}>{submission.message}</div>
        {!!submission.images?.length && <p>{t("chat.pendingImages", { count: submission.images.length })}</p>}
      </details>
    </article>
  );
}

/** Receipts own delivery, not presentation. Backups never mount a chat alert or
 * replay a prompt. The original is available only after opening this menu. */
export function SavedPromptMenu({ submissions, onConfirm }: {
  submissions: PendingPromptSubmission[];
  onConfirm: (submission: PendingPromptSubmission) => Promise<void>;
}) {
  const rows = submissions.filter(needsPromptRecovery);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);
  const close = (returnFocus = false) => {
    setAnchor(null);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };
  const open = anchor !== null && rows.length > 0;
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setAnchor(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.stopPropagation();
      setAnchor(null);
      triggerRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  useEffect(() => { if (!rows.length) setAnchor(null); }, [rows.length]);
  if (!rows.length) return null;
  return (
    <>
      <button ref={triggerRef} type="button" aria-label="已保留消息" title="已保留消息" aria-haspopup="dialog" aria-expanded={open}
        style={buttonStyle} onClick={() => {
          if (open) { close(true); return; }
          const rect = triggerRef.current!.getBoundingClientRect();
          const width = Math.min(420, window.innerWidth - 24);
          setAnchor({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(100, rect.top - 20) });
        }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2" />
        </svg>
      </button>
      {open && createPortal(
        <div ref={panelRef} role="dialog" aria-label="已保留消息" onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); close(true); } }}
          style={{ position: "fixed", zIndex: 160, left: anchor.left, bottom: anchor.bottom, width: "min(420px, calc(100vw - 24px))", maxHeight: `min(60dvh, ${anchor.maxHeight}px)`, overflowY: "auto", overscrollBehavior: "contain", boxSizing: "border-box", padding: "10px 14px", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 8px 24px rgba(0,0,0,0.18)", fontSize: 13 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 8 }}>
            <span>已保留消息</span>
            <button ref={closeRef} type="button" aria-label="关闭已保留消息" style={buttonStyle} onClick={() => close(true)}>×</button>
          </div>
          {rows.map(row => <SavedPrompt key={row.requestId} submission={row} onConfirm={onConfirm} />)}
        </div>, document.body,
      )}
    </>
  );
}
