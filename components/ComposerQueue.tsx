"use client";

import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PendingPromptSubmission } from "@/lib/prompt-submissions";
import type { QueuedMessages } from "@/hooks/useAgentSession";

type Entry = { kind: "steer" | "follow-up"; text: string };
type Image = { data: string; mimeType: string; alt?: string };
type Details = { signature: string; enabled: boolean; actionsEnabled?: boolean; busy: boolean; reorder?: boolean; images: Image[][]; statuses?: {status: string; error?: string}[] };

export function ComposerQueueIcon({ kind }: { kind: "more" | "delete" | "promote" | "sort" | "edit" }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "more" ? <><circle cx="5" cy="12" r=".8" /><circle cx="12" cy="12" r=".8" /><circle cx="19" cy="12" r=".8" /></>
      : kind === "delete" ? <><path d="M4 6h16M18 6l-1 14H7L6 6M9 6V3h6v3M10 10v6M14 10v6" /></>
      : kind === "edit" ? <><path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 15Z" /></>
      : kind === "sort" ? <><path d="M4 4v14h15m-4-4 4 4-4 4M9 6h10M9 11h6" /></>
      : <path d="M4 5v4a5 5 0 0 0 5 5h11m-5-5 5 5-5 5" />}
  </svg>;
}

const QueueIcon = ComposerQueueIcon;

/** Queue nodes belong to React from their first paint to consumption. The
 * existing enhancement service provides secure actions and attachment data,
 * through an explicit extension boundary; it never inspects/writes these nodes. */
export function ComposerQueue({ sessionId, executionEngine = "pi", queuedMessages, onRecallQueue, pending, syncStatus = "ready", retainedSubmissions = [], deliveredRequestIds = [] }: {
  retainedSubmissions?: PendingPromptSubmission[];
  deliveredRequestIds?: readonly string[];
  syncStatus?: "loading" | "ready" | "error";
  pending?: { kind: "steering" | "followUp"; text: string; images: Image[] } | null;
  sessionId: string; executionEngine?: "pi" | "codex"; queuedMessages?: QueuedMessages | null; onRecallQueue?: () => void;
}) {
  const host = useRef<HTMLElement>(null);
  const entries: Entry[] = [
    ...(queuedMessages?.steering ?? []).map(text => ({ kind: "steer" as const, text })),
    ...(queuedMessages?.followUp ?? []).map(text => ({ kind: "follow-up" as const, text })),
  ];
  const nativeIds = [...(queuedMessages?.requestIds?.steering ?? []), ...(queuedMessages?.requestIds?.followUp ?? [])];
  const represented = new Set([...nativeIds, ...deliveredRequestIds]);
  const backups = retainedSubmissions.filter(row => row.sessionId === sessionId && row.streamingBehavior
    && row.status !== "recalled" && !represented.has(row.requestId));
  const rows = [
    ...entries.map((entry, index) => ({ ...entry, pending: false, backup: undefined as PendingPromptSubmission | undefined, requestId: nativeIds[index] })),
    ...backups.map(row => ({ kind: row.streamingBehavior === "steer" ? "steer" as const : "follow-up" as const, text: row.message, pending: true, backup: row, requestId: row.requestId })),
    ...(pending ? [{ kind: pending.kind === "steering" ? "steer" as const : "follow-up" as const, text: pending.text, pending: true, backup: undefined, requestId: null }] : []),
  ];
  const actionsEnabled = syncStatus === "ready" && (executionEngine === "pi" || executionEngine === "codex");
  const signature = JSON.stringify([sessionId, entries]);
  const current = useRef({ sessionId, entries, signature, actionsEnabled });
  current.current = { sessionId, entries, signature, actionsEnabled };
  const [details, setDetails] = useState<Details | null>(null);
  const [confirmation, setConfirmation] = useState<{signature: string; index: number} | null>(null);
  const [hover, setHover] = useState<{src: string; left: number; bottom: number; count: number} | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [dragView, setDragView] = useState<{index: number; target: number; offset: number} | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragFrame = useRef<number | null>(null);
  const drag = useRef<{index: number; target: number; signature: string; pointerId: number; startY: number; moved: boolean; centers: {index: number; y: number}[]; origin: number; scrollTop: number; clientY: number; lastFrame: number} | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publish = useCallback(() => {
    window.dispatchEvent(new CustomEvent("pi:native-queue-snapshot", {
      detail: { ...current.current, host: host.current },
    }));
  }, []);
  useLayoutEffect(() => {
    const receive = (event: Event) => {
      const data = (event as CustomEvent<Details>).detail;
      if (data?.signature === current.current.signature) setDetails(data);
      else if (data?.enabled === false && !data.signature) setDetails(null);
    };
    window.addEventListener("pi:native-queue-details", receive);
    window.addEventListener("pi:native-queue-ready", publish);
    return () => {
      window.removeEventListener("pi:native-queue-details", receive);
      window.removeEventListener("pi:native-queue-ready", publish);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [publish]);
  useLayoutEffect(() => { publish(); }, [signature, actionsEnabled, publish]);
  useLayoutEffect(() => {
    setHover(null); setMenu(null); setDragView(null); drag.current = null;
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
  }, [signature]);
  useLayoutEffect(() => {
    if (!hover) return;
    const close = () => setHover(null);
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, {capture: true, passive: true});
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("blur", close); window.removeEventListener("scroll", close, true); window.removeEventListener("keydown", escape); };
  }, [hover]);
  useLayoutEffect(() => {
    if (menu === null) return;
    const trigger = rowRefs.current[menu]?.querySelector<HTMLButtonElement>(".pi-enh-queue-more");
    const popup = menuRef.current;
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    const bounds = popup.getBoundingClientRect();
    setMenuPosition({
      left: Math.max(8, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: rect.bottom + bounds.height + 8 <= window.innerHeight ? rect.bottom + 4 : Math.max(8, rect.top - bounds.height - 4),
    });
    popup.querySelector<HTMLButtonElement>("button")?.focus({preventScroll: true});
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.contains(event.target) && !trigger.contains(event.target)) close();
    };
    // The open popup owns Escape before the document's running-task guard.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault(); event.stopPropagation(); close();
      trigger.focus({preventScroll: true});
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, {capture: true, passive: true});
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);
  // Frame work exists only during a pointer gesture. Measure base positions
  // once, then account for list scrolling without reading transformed rows.
  const updateDrag = () => {
    const d = drag.current, list = listRef.current;
    if (!d || !list) return;
    const offset = Math.max(d.centers[0].y - d.origin, Math.min(d.centers[d.centers.length - 1].y - d.origin,
      d.clientY - d.startY + list.scrollTop - d.scrollTop));
    if (Math.abs(offset) < 5 && !d.moved) return;
    d.moved = true;
    const center = d.origin + offset;
    d.target = d.centers.reduce((nearest, row) => Math.abs(row.y - center) < Math.abs(nearest.y - center) ? row : nearest).index;
    setDragView(previous => previous?.index === d.index && previous.target === d.target && previous.offset === offset
      ? previous : {index: d.index, target: d.target, offset});
  };
  const scrollDrag = (now: number) => {
    const d = drag.current, list = listRef.current;
    if (!d || !list) { dragFrame.current = null; return; }
    const bounds = list.getBoundingClientRect(), edge = Math.min(32, bounds.height / 4);
    const direction = d.clientY < bounds.top + edge ? -1 : d.clientY > bounds.bottom - edge ? 1 : 0;
    const elapsed = Math.min(32, now - d.lastFrame); d.lastFrame = now;
    if (d.moved && direction) { list.scrollTop += direction * elapsed * .4; updateDrag(); }
    dragFrame.current = requestAnimationFrame(scrollDrag);
  };
  const endDrag = (clearPreview = true) => {
    drag.current = null;
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    if (clearPreview) setDragView(null);
  };
  useLayoutEffect(() => () => {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
  }, []);
  useLayoutEffect(() => {
    // Keep the drop preview until the secure action acknowledges or rejects it.
    if (!drag.current && !details?.busy) setDragView(null);
  }, [details]);
  const active = details?.signature === signature ? details : null;
  const action = (name: string, index = -1, targetIndex = -1) => {
    if (!actionsEnabled) return;
    if (!active?.enabled) {
      if (name === "recallAll") onRecallQueue?.();
      return;
    }
    window.dispatchEvent(new CustomEvent("pi:native-queue-action", {
      detail: { action: name, index, targetIndex, sessionId, signature },
    }));
  };
  const remove = (index: number) => {
    if (!actionsEnabled) return;
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmation?.signature === signature && confirmation.index === index) {
      setConfirmation(null);
      action("delete", index);
    } else {
      setConfirmation({signature, index});
      confirmTimer.current = setTimeout(() => setConfirmation(null), 3500);
    }
  };
  const queueActionsAvailable = executionEngine === "pi" || executionEngine === "codex";
  return <section ref={host} className="pi-enh-queue-panel" data-pi-native-queue="true" aria-label="排队消息" aria-busy={syncStatus === "loading" || undefined} hidden={!rows.length && syncStatus === "ready"}>
    {syncStatus !== "ready" && <div role="status" className="px-3 py-1 text-[11px] text-text-muted">{syncStatus === "error" ? (rows.length ? "队列暂未同步，已保留上次显示" : "队列暂未同步") : rows.length ? "正在核对排队消息…" : "正在同步排队消息…"}</div>}
    <div ref={listRef} className="pi-enh-queue-list">{rows.map((entry, index) => {
      const images: Image[] = entry.backup?.images ?? (entry.pending ? pending?.images ?? [] : active?.images[index] ?? []);
      const src = images[0] ? `data:${images[0].mimeType};base64,${images[0].data}` : "";
      const confirming = confirmation?.signature === signature && confirmation.index === index;
      const delivery = queuedMessages?.deliveryStates?.[index] ?? active?.statuses?.[index];
      const disabled = entry.pending || delivery?.status === "unknown" || !actionsEnabled || !active?.enabled || active.busy;
      const sortable = queueActionsAvailable && !disabled && active?.reorder && entries.filter(row => row.kind === entry.kind).length > 1;
      const move = (target: number) => {
        if (sortable && entries[target]?.kind === entry.kind) action("reorder", index, target);
      };
      let offset = 0;
      if (dragView) {
        if (dragView.index === index) offset = dragView.offset;
        else if (index > dragView.index && index <= dragView.target) offset = -(rowRefs.current[index]?.offsetTop ?? 0) + (rowRefs.current[index - 1]?.offsetTop ?? 0);
        else if (index < dragView.index && index >= dragView.target) offset = (rowRefs.current[index + 1]?.offsetTop ?? 0) - (rowRefs.current[index]?.offsetTop ?? 0);
      }
      return <div ref={node => {rowRefs.current[index] = node;}} data-queue-index={index} data-retained-request-id={entry.backup?.requestId} className={`pi-enh-queue-row${dragView?.target === index ? " pi-enh-queue-row-target" : ""}${dragView?.index === index ? " pi-enh-queue-row-dragging" : ""}`} aria-busy={entry.pending || undefined} style={offset ? {transform: `translateY(${offset}px)`} : undefined} key={entry.requestId || `${entry.kind}-${index}`}>
        {queueActionsAvailable && <button type="button" className="pi-enh-queue-sort" aria-label={`拖动排序第 ${index + 1} 条排队消息`} title={sortable ? "拖动调整同类消息顺序；也可用上下方向键" : disabled ? "队列更新中" : "至少两条同类消息时可拖动排序"} disabled={!sortable}
          onKeyDown={e => {if (e.key === "ArrowUp" || e.key === "ArrowDown") {e.preventDefault(); move(index + (e.key === "ArrowUp" ? -1 : 1));}}}
          onPointerDown={e => {
            if (!sortable || !e.isPrimary || e.button !== 0) return;
            e.preventDefault();
            const centers = rowRefs.current.flatMap((row, i) => {
              if (!row || entries[i]?.kind !== entry.kind) return [];
              const rect = row.getBoundingClientRect();
              return [{index: i, y: rect.top + rect.height / 2}];
            });
            const origin = centers.find(row => row.index === index)!.y;
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = {index, target: index, signature, pointerId: e.pointerId, startY: e.clientY, moved: false, centers, origin, scrollTop: listRef.current?.scrollTop ?? 0, clientY: e.clientY, lastFrame: performance.now()};
            setMenu(null); setHover(null);
            dragFrame.current = requestAnimationFrame(scrollDrag);
          }} onPointerMove={e => {
            const d = drag.current;
            if (!d || d.pointerId !== e.pointerId || d.signature !== signature) return;
            d.clientY = e.clientY; updateDrag();
          }} onPointerUp={e => {
            const d = drag.current;
            const commit = !!d?.moved && d.signature === signature && d.target !== d.index;
            endDrag(!commit);
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            if (commit) move(d!.target);
          }} onPointerCancel={() => endDrag()} onLostPointerCapture={() => {if (drag.current) endDrag();}}><QueueIcon kind="sort" /></button>}
        {queueActionsAvailable && !!images.length && <button type="button" className="pi-enh-queue-image-badge" aria-label="查看排队消息附带图片" disabled={entry.pending} onClick={() => { setHover(null); action("gallery", index); }} onMouseEnter={e => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHover({src, count: images.length, left: Math.max(10, Math.min(window.innerWidth - 250, rect.left)), bottom: window.innerHeight - rect.top + 8});
          }} onMouseLeave={() => setHover(null)}>
          <img className="pi-enh-queue-thumb" src={src} alt={images[0].alt || "图片附件"} data-no-zoom="true" />
          {images.length > 1 && <span className="pi-enh-queue-image-count">{images.length}</span>}
        </button>}
        {queueActionsAvailable ? (
          <button type="button" className="pi-enh-queue-text" disabled={disabled} title={`点击移回输入框编辑：${entry.text || "图片消息"}`} onClick={() => action("recall", index)}>{entry.text || (images.length ? "" : "图片消息")}</button>
        ) : (
          <span className="pi-enh-queue-text" title={entry.text || (images.length ? "图片消息" : undefined)}>{entry.text || (images.length ? "" : "图片消息")}</span>
        )}
        {entry.backup && <span role="status">{entry.backup.status === "accepted" ? "正在同步队列" : entry.backup.status === "sending" ? "发送中" : "等待同步"}</span>}
        {delivery?.status === "unknown" && <span role="status" title="内容已保留；确认结果前不会自动重发">发送待确认</span>}
        {delivery?.status === "failed" && <span role="status" title={delivery.error || "内容已保留，可移回输入框编辑"}>发送失败，内容已保留</span>}
        {queueActionsAvailable && <div className="pi-enh-queue-actions">
          {entry.kind === "follow-up" && <button type="button" className="pi-enh-queue-promote" aria-label={`立即引导第 ${index + 1} 条排队消息`} disabled={disabled} onClick={() => action("promote", index)}><QueueIcon kind="promote" /><span>引导</span></button>}
          <button type="button" className={`pi-enh-queue-delete${confirming ? " pi-enh-queue-delete-confirming" : ""}`} aria-label={`删除第 ${index + 1} 条排队消息`} title={confirming ? "再次点击确认删除" : "删除此排队消息"} disabled={disabled} onClick={() => remove(index)}><QueueIcon kind="delete" /></button>
          <button type="button" className="pi-enh-queue-more" aria-label={`更多操作：第 ${index + 1} 条排队消息`} aria-expanded={menu === index} aria-haspopup="menu" disabled={disabled} onClick={() => setMenu(menu === index ? null : index)}><QueueIcon kind="more" /></button>
        </div>}
      </div>;
    })}</div>
    {queueActionsAvailable && menu !== null && createPortal(<div ref={menuRef} className="pi-enh-queue-menu" role="menu" aria-label="排队消息操作" style={menuPosition} onKeyDown={e => {
      const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
      if (e.key === "Tab") {
        e.stopPropagation(); setMenu(null);
        rowRefs.current[menu]?.querySelector<HTMLButtonElement>(".pi-enh-queue-more")?.focus({preventScroll: true});
      }
    }}>
      <button type="button" role="menuitem" onClick={() => {setMenu(null); action("recall", menu);}}><QueueIcon kind="edit" />编辑消息</button>
      <button type="button" role="menuitem" onClick={() => {setMenu(null); action("delete", menu);}}><QueueIcon kind="sort" />关闭排队</button>
    </div>, document.body)}
    {queueActionsAvailable && hover && createPortal(<div className="pi-enh-queue-hover-preview" style={{left: hover.left, bottom: hover.bottom}}><img src={hover.src} alt="图片附件预览" /><span>{hover.count > 1 ? `共 ${hover.count} 张图片 · 点击放大左右切换` : "图片附件预览 · 点击放大"}</span></div>, document.body)}
  </section>;
}
