"use client";

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PendingPromptSubmission } from "@/lib/prompt-submissions";
import type { QueuedMessages } from "@/hooks/useAgentSession";
import type { RecalledPromptRestoration } from "@/lib/queue-recall-client";
import { useComposerQueueBridge } from "@/hooks/useComposerQueueBridge";
import { calculateDragMetrics, optimisticReorder, type RowRectMetric } from "@/lib/composer-queue-drag";

type Entry = { kind: "steer" | "follow-up"; text: string };
type Image = { data: string; mimeType: string; alt?: string };

export function ComposerQueueIcon({ kind }: { kind: "more" | "delete" | "promote" | "sort" | "edit" }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "more" ? (
        <>
          <circle cx="5" cy="12" r=".8" />
          <circle cx="12" cy="12" r=".8" />
          <circle cx="19" cy="12" r=".8" />
        </>
      ) : kind === "delete" ? (
        <>
          <path d="M4 6h16M18 6l-1 14H7L6 6M9 6V3h6v3M10 10v6M14 10v6" />
        </>
      ) : kind === "edit" ? (
        <>
          <path d="m15 4 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 15Z" />
        </>
      ) : kind === "sort" ? (
        <>
          <path d="M4 4v14h15m-4-4 4 4-4 4M9 6h10M9 11h6" />
        </>
      ) : (
        <path d="M4 5v4a5 5 0 0 0 5 5h11m-5-5 5 5-5 5" />
      )}
    </svg>
  );
}

const QueueIcon = ComposerQueueIcon;

/**
 * Queue nodes belong to React from their first paint to consumption.
 * Queue actions and attachment data communicate through native hook/service,
 * without DOM script bridging or global custom events.
 */
export function ComposerQueue({
  sessionId,
  executionEngine = "pi",
  queuedMessages,
  onRecallQueue,
  onRestoreRecall,
  pending,
  syncStatus = "ready",
  retainedSubmissions = [],
  deliveredRequestIds = [],
}: {
  retainedSubmissions?: PendingPromptSubmission[];
  deliveredRequestIds?: readonly string[];
  syncStatus?: "loading" | "ready" | "error";
  pending?: { kind: "steering" | "followUp"; text: string; images: Image[] } | null;
  sessionId: string;
  executionEngine?: "pi" | "codex";
  queuedMessages?: QueuedMessages | null;
  onRecallQueue?: () => void;
  onRestoreRecall?: (payload: RecalledPromptRestoration) => Promise<boolean>;
}) {
  const host = useRef<HTMLElement>(null);
  const entries: Entry[] = useMemo(
    () => [
      ...(queuedMessages?.steering ?? []).map((text) => ({ kind: "steer" as const, text })),
      ...(queuedMessages?.followUp ?? []).map((text) => ({ kind: "follow-up" as const, text })),
    ],
    [queuedMessages?.steering, queuedMessages?.followUp],
  );
  const nativeIds = useMemo(
    () => [
      ...(queuedMessages?.steering ?? []).map((_, i) => queuedMessages?.requestIds?.steering?.[i] ?? null),
      ...(queuedMessages?.followUp ?? []).map((_, i) => queuedMessages?.requestIds?.followUp?.[i] ?? null),
    ],
    [queuedMessages?.steering, queuedMessages?.followUp, queuedMessages?.requestIds],
  );
  const represented = new Set([...nativeIds, ...deliveredRequestIds]);
  const backups = retainedSubmissions.filter(
    (row) =>
      row.sessionId === sessionId &&
      row.streamingBehavior &&
      row.status !== "recalled" &&
      !represented.has(row.requestId),
  );
  const rows = [
    ...entries.map((entry, index) => ({
      ...entry,
      pending: false,
      backup: undefined as PendingPromptSubmission | undefined,
      requestId: nativeIds[index],
    })),
    ...backups.map((row) => ({
      kind: row.streamingBehavior === "steer" ? ("steer" as const) : ("follow-up" as const),
      text: row.message,
      pending: true,
      backup: row,
      requestId: row.requestId,
    })),
    ...(pending
      ? [
          {
            kind: pending.kind === "steering" ? ("steer" as const) : ("follow-up" as const),
            text: pending.text,
            pending: true,
            backup: undefined,
            requestId: null,
          },
        ]
      : []),
  ];

  const actionsEnabled = syncStatus === "ready" && (executionEngine === "pi" || executionEngine === "codex");
  const signature = JSON.stringify([sessionId, entries, nativeIds]);

  const [feedback, setFeedback] = useState<{ message: string; type: "info" | "success" | "error" } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Direct native queue bridge without DOM events
  const bridge = useComposerQueueBridge({
    sessionId,
    entries,
    signature,
    actionsEnabled,
    onRestoreRecall,
    onRecallQueue,
    onToast: (msg, type = "info") => {
      setFeedback({ message: msg, type });
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setFeedback(null), 4000);
    },
  });

  const [confirmation, setConfirmation] = useState<{ signature: string; index: number } | null>(null);
  const [hover, setHover] = useState<{ src: string; left: number; bottom: number; count: number } | null>(null);
  const [gallery, setGallery] = useState<{
    items: Array<{ src: string; alt: string }>;
    index: number;
    triggerRef: React.RefObject<HTMLButtonElement | null>;
  } | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });

  // Optimistic order locking during RPC and awaiting authoritative signature
  const [pendingReorder, setPendingReorder] = useState<{
    fromIndex: number;
    targetIndex: number;
    initialSignature: string;
    expectedIds?: (string | null)[];
  } | null>(null);
  const currentPendingOpRef = useRef<{
    fromIndex: number;
    targetIndex: number;
    initialSignature: string;
    expectedIds?: (string | null)[];
  } | null>(null);
  const pendingReorderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [dragView, setDragView] = useState<{
    index: number;
    target: number;
    offset: number;
    dropLineTop: number | null;
    moved: boolean;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dragFrame = useRef<number | null>(null);
  const activeCaptureRef = useRef<{ element: Element; pointerId: number } | null>(null);
  const multitouchCleanerRef = useRef<(() => void) | null>(null);
  const drag = useRef<{
    index: number;
    originalIndex: number;
    target: number;
    kind: "steer" | "follow-up";
    signature: string;
    pointerId: number;
    startY: number;
    startScrollTop: number;
    lastClientY: number;
    moved: boolean;
    slot: number;
    lastFrame: number;
    autoScrollDirection: -1 | 0 | 1;
  } | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const badgeRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const releaseOwnedCapture = (pointerId?: number) => {
    const cap = activeCaptureRef.current;
    if (cap && (pointerId === undefined || cap.pointerId === pointerId)) {
      activeCaptureRef.current = null;
      try {
        if (cap.element.hasPointerCapture(cap.pointerId)) {
          cap.element.releasePointerCapture(cap.pointerId);
        }
      } catch {}
    }
  };

  const endDrag = (clearPreview = true) => {
    if (multitouchCleanerRef.current) {
      multitouchCleanerRef.current();
      multitouchCleanerRef.current = null;
    }
    drag.current = null;
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    if (clearPreview) setDragView(null);
  };

  const prevSignatureRef = useRef(signature);
  useLayoutEffect(() => {
    setHover(null);
    setMenu(null);
    setDragView(null);
    releaseOwnedCapture();
    endDrag(true);
    setFeedback(null);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);

    if (prevSignatureRef.current !== signature) {
      const activeOp = currentPendingOpRef.current;
      if (activeOp) {
        currentPendingOpRef.current = null;
        if (pendingReorderTimer.current) clearTimeout(pendingReorderTimer.current);
        setPendingReorder((curr) => (curr === activeOp ? null : curr));

        if (activeOp.expectedIds && activeOp.expectedIds.length) {
          const actualIds = nativeIds;
          const matches =
            actualIds.length === activeOp.expectedIds.length &&
            actualIds.every((id, idx) => id === activeOp.expectedIds![idx]);

          if (!matches) {
            setFeedback({ message: "队列已被外部更新，已恢复最新状态", type: "info" });
          }
        }
      }
      prevSignatureRef.current = signature;
    }
  }, [signature]);

  useLayoutEffect(() => {
    const handleBlur = () => {
      if (drag.current) {
        releaseOwnedCapture();
        endDrag(true);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drag.current) {
        e.preventDefault();
        e.stopPropagation();
        releaseOwnedCapture();
        endDrag(true);
      }
    };
    window.addEventListener("blur", handleBlur);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useLayoutEffect(() => {
    if (!hover) return;
    const close = () => setHover(null);
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", escape);
    };
  }, [hover]);

  useLayoutEffect(() => {
    if (menu === null) return;
    const trigger = host.current
      ?.querySelector<HTMLDivElement>(`[data-queue-original-index="${menu}"]`)
      ?.querySelector<HTMLButtonElement>(".pi-enh-queue-more");
    const popup = menuRef.current;
    if (!trigger || !popup) return;
    const rect = trigger.getBoundingClientRect();
    const bounds = popup.getBoundingClientRect();
    setMenuPosition({
      left: Math.max(8, Math.min(rect.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top:
        rect.bottom + bounds.height + 8 <= window.innerHeight
          ? rect.bottom + 4
          : Math.max(8, rect.top - bounds.height - 4),
    });
    popup.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.contains(event.target) && !trigger.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);

  const getRowRects = (): (RowRectMetric | null)[] => {
    return rowRefs.current.map((row) => {
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        offsetTop: row.offsetTop,
      };
    });
  };

  const getContainerBounds = () => {
    if (!listRef.current) return null;
    const rect = listRef.current.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      height: rect.height,
    };
  };

  const updateDrag = (currentClientY: number) => {
    const d = drag.current,
      list = listRef.current;
    if (!d || !list) return;
    const rowRects = getRowRects();
    const containerBounds = getContainerBounds();
    const metrics = calculateDragMetrics({
      pointerY: currentClientY,
      startY: d.startY,
      scrollTop: list.scrollTop,
      startScrollTop: d.startScrollTop,
      dragIndex: d.index,
      dragKind: d.kind,
      rows,
      rowRects,
      containerBounds,
    });

    d.target = metrics.targetIndex;
    d.slot = metrics.slot;
    d.moved = d.moved || metrics.hasMoved;
    d.autoScrollDirection = metrics.autoScrollDirection;

    setDragView((prev) => {
      if (
        prev &&
        prev.index === d.index &&
        prev.target === metrics.targetIndex &&
        Math.abs(prev.offset - metrics.offset) < 0.5 &&
        prev.dropLineTop === (metrics.dropLine.visible ? metrics.dropLine.top : null) &&
        prev.moved === d.moved
      ) {
        return prev;
      }
      return {
        index: d.index,
        target: metrics.targetIndex,
        offset: metrics.offset,
        dropLineTop: metrics.dropLine.visible ? metrics.dropLine.top : null,
        moved: d.moved,
      };
    });
  };

  const scrollDrag = (now: number) => {
    const d = drag.current,
      list = listRef.current;
    if (!d || !list) {
      dragFrame.current = null;
      return;
    }
    const elapsed = Math.min(32, now - d.lastFrame);
    d.lastFrame = now;
    if (d.moved && d.autoScrollDirection !== 0) {
      list.scrollTop += d.autoScrollDirection * elapsed * 0.4;
      updateDrag(d.lastClientY);
    }
    dragFrame.current = requestAnimationFrame(scrollDrag);
  };

  useLayoutEffect(
    () => () => {
      if (multitouchCleanerRef.current) {
        multitouchCleanerRef.current();
        multitouchCleanerRef.current = null;
      }
      currentPendingOpRef.current = null;
      drag.current = null;
      releaseOwnedCapture();
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      if (pendingReorderTimer.current) clearTimeout(pendingReorderTimer.current);
    },
    [],
  );

  const move = (fromIndex: number, targetIndex: number) => {
    if (fromIndex === targetIndex || fromIndex < 0 || targetIndex < 0) return;
    if (entries[fromIndex]?.kind !== entries[targetIndex]?.kind) return;
    if (pendingReorder || currentPendingOpRef.current) return;

    const hasIds = nativeIds.some((id) => id !== null);
    const expectedIds = hasIds
      ? optimisticReorder(nativeIds, fromIndex, targetIndex)
      : undefined;

    const op = {
      fromIndex,
      targetIndex,
      initialSignature: signature,
      expectedIds,
    };

    currentPendingOpRef.current = op;
    setPendingReorder(op);

    if (pendingReorderTimer.current) clearTimeout(pendingReorderTimer.current);
    pendingReorderTimer.current = setTimeout(() => {
      if (currentPendingOpRef.current === op) {
        currentPendingOpRef.current = null;
        setPendingReorder((current) => {
          if (current === op) {
            setFeedback({ message: "队列排序确认超时，请刷新同步", type: "error" });
            return null;
          }
          return current;
        });
      }
    }, 10000);

    void (async () => {
      const ok = await bridge.action("reorder", fromIndex, targetIndex);
      if (!ok) {
        if (currentPendingOpRef.current === op) {
          currentPendingOpRef.current = null;
          if (pendingReorderTimer.current) clearTimeout(pendingReorderTimer.current);
          setPendingReorder((current) => (current === op ? null : current));
        }
      }
    })();
  };

  const effectiveRows = useMemo(() => {
    if (pendingReorder && pendingReorder.initialSignature === signature) {
      return optimisticReorder(rows, pendingReorder.fromIndex, pendingReorder.targetIndex);
    }
    return rows;
  }, [rows, pendingReorder, signature]);

  const remove = (originalIdx: number) => {
    if (!actionsEnabled || !bridge.enabled) return;
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    if (confirmation?.signature === signature && confirmation.index === originalIdx) {
      setConfirmation(null);
      void bridge.action("delete", originalIdx);
    } else {
      setConfirmation({ signature, index: originalIdx });
      confirmTimer.current = setTimeout(() => setConfirmation(null), 3500);
    }
  };

  const queueActionsAvailable = executionEngine === "pi" || executionEngine === "codex";

  return (
    <section
      ref={host}
      className="pi-enh-queue-panel"
      data-pi-native-queue="true"
      aria-label="排队消息"
      aria-busy={syncStatus === "loading" || undefined}
      hidden={!rows.length && syncStatus === "ready"}
    >
      {syncStatus !== "ready" && (
        <div role="status" className="px-3 py-1 text-[11px] text-text-muted">
          {syncStatus === "error"
            ? rows.length
              ? "队列暂未同步，已保留上次显示"
              : "队列暂未同步"
            : rows.length
              ? "正在核对排队消息…"
              : "正在同步排队消息…"}
        </div>
      )}
      <div ref={listRef} className="pi-enh-queue-list">
        {effectiveRows.map((entry, renderIndex) => {
          const originalIndex = rows.indexOf(entry);
          const images: Image[] =
            entry.backup?.images ??
            (entry.pending ? pending?.images ?? [] : bridge.images[originalIndex] ?? []);
          const src = images[0] ? `data:${images[0].mimeType};base64,${images[0].data}` : "";
          const confirming = confirmation?.signature === signature && confirmation.index === originalIndex;
          const delivery = queuedMessages?.deliveryStates?.[originalIndex] ?? bridge.statuses?.[originalIndex];
          const isPendingAction = !!pendingReorder || bridge.busy;
          const disabled =
            entry.pending ||
            delivery?.status === "unknown" ||
            !actionsEnabled ||
            !bridge.enabled ||
            isPendingAction;
          const isMenuOpen = menu !== null;
          const sortable =
            queueActionsAvailable &&
            !disabled &&
            !isMenuOpen &&
            bridge.reorder &&
            entries.filter((row) => row.kind === entry.kind).length > 1;

          const isDragging = dragView?.index === renderIndex;

          return (
            <div
              ref={(node) => {
                rowRefs.current[renderIndex] = node;
              }}
              data-queue-index={renderIndex}
              data-queue-original-index={originalIndex}
              data-retained-request-id={entry.backup?.requestId}
              className={`pi-enh-queue-row${isDragging ? " pi-enh-queue-row-dragging" : ""}`}
              style={isDragging && dragView?.moved ? { transform: `translateY(${dragView.offset}px)` } : undefined}
              aria-busy={entry.pending || undefined}
              key={entry.requestId || `${entry.kind}-${originalIndex}`}
            >
              {queueActionsAvailable && (
                <button
                  type="button"
                  className="pi-enh-queue-sort"
                  aria-label={`拖动排序第 ${renderIndex + 1} 条排队消息`}
                  title={sortable ? "拖动调整同类消息顺序；也可用上下方向键" : disabled ? "队列更新中" : "至少两条同类消息时可拖动排序"}
                  disabled={!sortable}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                      e.preventDefault();
                      if (!sortable) return;
                      const targetRenderIndex = renderIndex + (e.key === "ArrowUp" ? -1 : 1);
                      const targetEntry = effectiveRows[targetRenderIndex];
                      if (targetEntry && targetEntry.kind === entry.kind) {
                        const targetOriginalIndex = rows.indexOf(targetEntry);
                        if (targetOriginalIndex !== -1 && originalIndex !== -1) {
                          move(originalIndex, targetOriginalIndex);
                        }
                      }
                    }
                  }}
                  onPointerDown={(e) => {
                    if (!sortable || !e.isPrimary || e.button !== 0) return;
                    if (drag.current) {
                      releaseOwnedCapture();
                      endDrag(true);
                    }
                    e.preventDefault();
                    const pointerId = e.pointerId;
                    const targetEl = e.currentTarget;
                    try {
                      targetEl.setPointerCapture(pointerId);
                      activeCaptureRef.current = { element: targetEl, pointerId };
                    } catch {}

                    drag.current = {
                      index: renderIndex,
                      originalIndex,
                      target: renderIndex,
                      kind: entry.kind,
                      signature,
                      pointerId,
                      startY: e.clientY,
                      startScrollTop: listRef.current?.scrollTop ?? 0,
                      lastClientY: e.clientY,
                      moved: false,
                      slot: 0,
                      lastFrame: performance.now(),
                      autoScrollDirection: 0,
                    };
                    setMenu(null);
                    setHover(null);

                    const onSecondContact = (evt: PointerEvent) => {
                      if (drag.current && evt.pointerId !== drag.current.pointerId) {
                        releaseOwnedCapture();
                        endDrag(true);
                      }
                    };
                    window.addEventListener("pointerdown", onSecondContact, { capture: true, passive: true });
                    multitouchCleanerRef.current = () => {
                      window.removeEventListener("pointerdown", onSecondContact, { capture: true } as any);
                    };

                    dragFrame.current = requestAnimationFrame(scrollDrag);
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d || d.pointerId !== e.pointerId || d.signature !== signature) return;
                    if (!e.isPrimary) {
                      releaseOwnedCapture(e.pointerId);
                      endDrag(true);
                      return;
                    }
                    d.lastClientY = e.clientY;
                    updateDrag(e.clientY);
                  }}
                  onPointerUp={(e) => {
                    const d = drag.current;
                    if (!d || d.pointerId !== e.pointerId) return;

                    const rowRects = getRowRects();
                    const finalMetrics = calculateDragMetrics({
                      pointerY: e.clientY,
                      startY: d.startY,
                      scrollTop: listRef.current?.scrollTop ?? 0,
                      startScrollTop: d.startScrollTop,
                      dragIndex: d.index,
                      dragKind: d.kind,
                      rows: effectiveRows,
                      rowRects,
                    });
                    const fromOriginalIndex = d.originalIndex;
                    const targetRenderIndex = finalMetrics.targetIndex;
                    const targetEntry = effectiveRows[targetRenderIndex];
                    const targetOriginalIndex = targetEntry ? rows.indexOf(targetEntry) : -1;
                    const commit =
                      (d.moved || finalMetrics.hasMoved) &&
                      d.signature === signature &&
                      targetOriginalIndex !== -1 &&
                      targetOriginalIndex !== fromOriginalIndex;

                    endDrag(true);
                    releaseOwnedCapture(e.pointerId);

                    if (commit) {
                      move(fromOriginalIndex, targetOriginalIndex);
                    }
                  }}
                  onPointerCancel={(e) => {
                    if (drag.current && drag.current.pointerId === e.pointerId) {
                      releaseOwnedCapture(e.pointerId);
                      endDrag(true);
                    }
                  }}
                  onLostPointerCapture={(e) => {
                    if (drag.current && drag.current.pointerId === e.pointerId) {
                      releaseOwnedCapture(e.pointerId);
                      endDrag(true);
                    }
                  }}
                >
                  <QueueIcon kind="sort" />
                </button>
              )}
              {queueActionsAvailable && !!images.length && (
                <button
                  ref={(node) => {
                    badgeRefs.current[originalIndex] = node;
                  }}
                  type="button"
                  className="pi-enh-queue-image-badge"
                  aria-label="查看排队消息附带图片"
                  disabled={entry.pending || isPendingAction}
                  onClick={() => {
                    if (entry.pending || isPendingAction) return;
                    setHover(null);
                    const galleryItems = images.map((img, i) => ({
                      src: `data:${img.mimeType};base64,${img.data}`,
                      alt: img.alt || `图片附件 ${i + 1}`,
                    }));
                    setGallery({
                      items: galleryItems,
                      index: 0,
                      triggerRef: { current: badgeRefs.current[originalIndex] },
                    });
                  }}
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHover({
                      src,
                      count: images.length,
                      left: Math.max(10, Math.min(window.innerWidth - 250, rect.left)),
                      bottom: window.innerHeight - rect.top + 8,
                    });
                  }}
                  onMouseLeave={() => setHover(null)}
                >
                  <img className="pi-enh-queue-thumb" src={src} alt={images[0].alt || "图片附件"} data-no-zoom="true" />
                  {images.length > 1 && <span className="pi-enh-queue-image-count">{images.length}</span>}
                </button>
              )}
              {queueActionsAvailable ? (
                <button
                  type="button"
                  className="pi-enh-queue-text"
                  disabled={disabled}
                  title={`点击移回输入框编辑：${entry.text || "图片消息"}`}
                  onClick={() => void bridge.action("recall", originalIndex)}
                >
                  {entry.text || (images.length ? "" : "图片消息")}
                </button>
              ) : (
                <span className="pi-enh-queue-text" title={entry.text || (images.length ? "图片消息" : undefined)}>
                  {entry.text || (images.length ? "" : "图片消息")}
                </span>
              )}
              {entry.backup && (
                <span role="status">
                  {entry.backup.status === "accepted"
                    ? "正在同步队列"
                    : entry.backup.status === "sending"
                      ? "发送中"
                      : "等待同步"}
                </span>
              )}
              {delivery?.status === "unknown" && <span role="status" title="内容已保留；确认结果前不会自动重发">发送待确认</span>}
              {delivery?.status === "failed" && <span role="status" title={delivery.error || "内容已保留，可移回输入框编辑"}>发送失败，内容已保留</span>}
              {queueActionsAvailable && (
                <div className="pi-enh-queue-actions">
                  {entry.kind === "follow-up" && (
                    <button
                      type="button"
                      className="pi-enh-queue-promote"
                      aria-label={`立即引导第 ${renderIndex + 1} 条排队消息`}
                      disabled={disabled}
                      onClick={() => void bridge.action("promote", originalIndex)}
                    >
                      <QueueIcon kind="promote" />
                      <span>引导</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={`pi-enh-queue-delete${confirming ? " pi-enh-queue-delete-confirming" : ""}`}
                    aria-label={`删除第 ${renderIndex + 1} 条排队消息`}
                    title={confirming ? "再次点击确认删除" : "删除此排队消息"}
                    disabled={disabled}
                    onClick={() => remove(originalIndex)}
                  >
                    <QueueIcon kind="delete" />
                  </button>
                  <button
                    type="button"
                    className="pi-enh-queue-more"
                    aria-label={`更多操作：第 ${renderIndex + 1} 条排队消息`}
                    aria-expanded={menu === originalIndex}
                    aria-haspopup="menu"
                    disabled={disabled}
                    onClick={() => setMenu(menu === originalIndex ? null : originalIndex)}
                  >
                    <QueueIcon kind="more" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {dragView && dragView.dropLineTop !== null && dragView.moved && dragView.target !== dragView.index && (
          <div
            className="pi-enh-queue-drop-line"
            style={{ top: `${dragView.dropLineTop}px` }}
            aria-hidden="true"
          />
        )}
      </div>
      {queueActionsAvailable &&
        menu !== null &&
        createPortal(
          <div
            ref={menuRef}
            className="pi-enh-queue-menu"
            role="menu"
            aria-label="排队消息操作"
            style={menuPosition}
            onKeyDown={(e) => {
              const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
                e.preventDefault();
                buttons[
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? buttons.length - 1
                      : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
                ]?.focus();
              }
              if (e.key === "Tab") {
                e.stopPropagation();
                setMenu(null);
                host.current
                  ?.querySelector<HTMLDivElement>(`[data-queue-original-index="${menu}"]`)
                  ?.querySelector<HTMLButtonElement>(".pi-enh-queue-more")
                  ?.focus({ preventScroll: true });
              }
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void bridge.action("recall", menu);
              }}
            >
              <QueueIcon kind="edit" />
              编辑消息
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                void bridge.action("delete", menu);
              }}
            >
              <QueueIcon kind="sort" />
              关闭排队
            </button>
          </div>,
          document.body,
        )}
      {queueActionsAvailable &&
        hover &&
        createPortal(
          <div className="pi-enh-queue-hover-preview" style={{ left: hover.left, bottom: hover.bottom }}>
            <img src={hover.src} alt="图片附件预览" />
            <span>{hover.count > 1 ? `共 ${hover.count} 张图片 · 点击放大` : "图片附件预览 · 点击放大"}</span>
          </div>,
          document.body,
        )}
      {(feedback || bridge.errorMessage) && (
        <div
          role={feedback?.type === "error" || bridge.errorMessage ? "alert" : "status"}
          className="pi-enh-queue-feedback px-3 py-1 text-[11px] text-amber-500"
        >
          {feedback?.message || bridge.errorMessage}
        </div>
      )}
      {gallery && (
        <QueueGalleryDialog
          items={gallery.items}
          initialIndex={gallery.index}
          triggerRef={gallery.triggerRef}
          onClose={() => setGallery(null)}
        />
      )}
    </section>
  );
}

function QueueGalleryDialog({
  items,
  initialIndex = 0,
  onClose,
  triggerRef,
}: {
  items: Array<{ src: string; alt: string }>;
  initialIndex?: number;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const [index, setIndex] = useState(initialIndex);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const trigger = triggerRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    closeButtonRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog.open) dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [triggerRef]);

  const current = items[index] || items[0];
  const count = items.length;

  const prev = () => {
    setIndex((prevIdx) => (prevIdx > 0 ? prevIdx - 1 : count - 1));
  };
  const next = () => {
    setIndex((prevIdx) => (prevIdx < count - 1 ? prevIdx + 1 : 0));
  };

  return (
    <dialog
      ref={dialogRef}
      className="image-preview-dialog pi-enh-queue-gallery-dialog"
      aria-label="查看排队消息附带图片"
      onCancel={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "ArrowLeft" && count > 1) {
          e.preventDefault();
          prev();
        } else if (e.key === "ArrowRight" && count > 1) {
          e.preventDefault();
          next();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative flex flex-col items-center justify-center max-w-full max-h-full">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="image-preview-image max-w-[90vw] max-h-[85vh] object-contain rounded"
          src={current.src}
          alt={current.alt}
        />
        {count > 1 && (
          <div className="absolute inset-y-0 left-2 right-2 flex items-center justify-between pointer-events-none">
            <button
              type="button"
              className="pointer-events-auto bg-black/60 hover:bg-black/80 text-white rounded-full w-9 h-9 flex items-center justify-center transition-colors"
              aria-label="上一张图片"
              onClick={(e) => {
                e.stopPropagation();
                prev();
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <button
              type="button"
              className="pointer-events-auto bg-black/60 hover:bg-black/80 text-white rounded-full w-9 h-9 flex items-center justify-center transition-colors"
              aria-label="下一张图片"
              onClick={(e) => {
                e.stopPropagation();
                next();
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
        )}
        {count > 1 && (
          <div className="mt-2 px-3 py-1 bg-black/70 text-white text-xs rounded-full pointer-events-none">
            {index + 1} / {count}
          </div>
        )}
      </div>
      <button
        ref={closeButtonRef}
        type="button"
        className="image-preview-close"
        onClick={onClose}
        aria-label="关闭"
        title="关闭"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </dialog>
  );
}
