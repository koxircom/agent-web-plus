"use client";
import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

/** Native row owner: desktop context menu and touch hold share one action. */
export function useTouchContextMenu(open: (x: number, y: number) => boolean, enabled: boolean) {
  const action = useRef(open); action.current = open;
  const pending = useRef<{ id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const suppressUntil = useRef(0);
  const cancel = () => { if (pending.current) clearTimeout(pending.current.timer); pending.current = null; };
  useEffect(() => cancel, []);
  useEffect(() => { if (!enabled) cancel(); }, [enabled]);
  return {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      cancel();
      if (!enabled || !event.isPrimary || event.pointerType !== "touch" || (event.target as HTMLElement).closest("button,input,textarea,select,[contenteditable=true]")) return;
      const { pointerId: id, clientX: x, clientY: y } = event;
      const timer = setTimeout(() => { pending.current = null; if (action.current(x, y)) suppressUntil.current = Date.now() + 1400; }, 550);
      pending.current = { id, x, y, timer };
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const p = pending.current;
      if (p && (p.id !== event.pointerId || Math.hypot(event.clientX-p.x, event.clientY-p.y) > 10)) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu(event: MouseEvent<HTMLDivElement>) {
      cancel();
      if (!enabled) return;
      if (Date.now() < suppressUntil.current || action.current(event.clientX, event.clientY)) { event.preventDefault(); event.stopPropagation(); }
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (Date.now() < suppressUntil.current) { event.preventDefault(); event.stopPropagation(); }
    },
  };
}
