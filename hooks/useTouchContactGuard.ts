"use client";

import { useEffect } from "react";

export function isLocalFileHref(href: string | null | undefined): boolean {
  if (!href?.trim()) return false;
  const value = href.trim();
  if (/^(https?:|mailto:|tel:|javascript:|#)/i.test(value)) return false;
  return /^file:\/\//i.test(value)
    || /^\/(workspace|root|home|srv|volume\d+|tmp|var|opt|etc|app)\b/i.test(value)
    || /^[a-z]:[\\/]|^(\\\\|\/\/)/i.test(value)
    || /\.[a-z0-9_-]+(#|\?|$)/i.test(value);
}

export function isFilePanelInteractionTarget(target: unknown): boolean {
  const element = target as Element | null;
  if (typeof element?.closest !== "function") return false;
  if (element.closest("[aria-controls='file-panel'], .desktop-file-panel-toggle, [data-mobile-toolbar-file], [data-file-link], [data-file-path], [data-turn-written-files], [data-file-entry], [data-file-tree-node], .pi-enh-file-link, .pi-enh-path-btn")) return true;
  return isLocalFileHref(element.closest("a")?.getAttribute("href"));
}

type ClickSource = { nativeEvent?: ClickSource; detail?: number; pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } };
const nativeClick = (event: unknown): ClickSource => {
  const source = (event ?? {}) as ClickSource;
  return source.nativeEvent ?? source;
};
export function isTouchClick(event: unknown): boolean {
  const source = nativeClick(event);
  return source.pointerType === "touch" || source.sourceCapabilities?.firesTouchEvents === true;
}
export function isKeyboardClick(event: unknown): boolean {
  return nativeClick(event).detail === 0 && !isTouchClick(event);
}
export function isExplicitMouseClick(event: unknown): boolean {
  const source = nativeClick(event);
  return !isTouchClick(event) && (source.pointerType === "mouse" || source.sourceCapabilities?.firesTouchEvents === false);
}

type Contacts = { touches?: ArrayLike<unknown> };
type ContactPointer = { pointerId?: number; pointerType?: string };

/** One contact sequence stays contaminated until a genuinely new single contact.
 * No debounce clock: all compatibility clicks from that sequence are rejected. */
export function createTouchContactGuardCore() {
  let contaminated = false;
  let touchCount = 0;
  let mouseInput = false;
  const pointers = new Set<number>();
  const reset = () => { contaminated = false; touchCount = 0; pointers.clear(); };
  const handleTouchStart = ({ touches }: Contacts) => {
    const count = touches?.length ?? 1;
    // A native touchstart with one total contact is a new sequence, even
    // after a system gesture swallowed the preceding release event.
    mouseInput = false;
    if (count === 1) contaminated = false;
    if (count > 1) contaminated = true;
    touchCount = count;
  };
  const handleTouchEnd = ({ touches }: Contacts) => { touchCount = touches?.length ?? 0; };
  const handlePointerDown = ({ pointerId = 0, pointerType }: ContactPointer) => {
    if (pointerType === "mouse") { mouseInput = true; return; }
    if (pointerType !== "touch") return;
    mouseInput = false;
    if (!pointers.size && touchCount === 0) contaminated = false;
    pointers.add(pointerId);
    if (pointers.size > 1) contaminated = true;
  };
  const handlePointerUp = ({ pointerId = 0, pointerType }: ContactPointer) => {
    if (pointerType === "touch") pointers.delete(pointerId);
  };
  return {
    handleTouchStart, handleTouchEnd, handleTouchCancel: handleTouchEnd,
    handlePointerDown, handlePointerUp, handlePointerCancel: handlePointerUp,
    shouldBlockClick: (event?: unknown) => contaminated && !mouseInput && !isKeyboardClick(event) && !isExplicitMouseClick(event),
    // Blocking a click never cleans the sequence; only the next contact does.
    consumeClickBlock: () => {},
    isContaminated: () => contaminated,
    isBlockPending: () => contaminated,
    reset,
  };
}

/** AppShell owns the actual file-opening event boundary, including wide touch
 * screens. Window capture precedes both legacy document links and React clicks. */
export function useTouchContactGuard(): void {
  useEffect(() => {
    const core = createTouchContactGuardCore();
    const click = (event: MouseEvent) => {
      if (!core.shouldBlockClick(event) || !isFilePanelInteractionTarget(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const listeners: [string, EventListener][] = [
      ["touchstart", event => core.handleTouchStart(event as TouchEvent)],
      ["touchend", event => core.handleTouchEnd(event as TouchEvent)],
      ["touchcancel", event => core.handleTouchCancel(event as TouchEvent)],
      ["pointerdown", event => core.handlePointerDown(event as PointerEvent)],
      ["pointerup", event => core.handlePointerUp(event as PointerEvent)],
      ["pointercancel", event => core.handlePointerCancel(event as PointerEvent)],
    ];
    for (const [name, handler] of listeners) window.addEventListener(name, handler, { capture: true, passive: true });
    window.addEventListener("click", click, true);
    return () => {
      for (const [name, handler] of listeners) window.removeEventListener(name, handler, true);
      window.removeEventListener("click", click, true);
    };
  }, []);
}
