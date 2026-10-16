"use client";

import { useEffect, useRef, type RefObject } from "react";

export interface UseMobileHorizontalSwipeOptions {
  containerRef: RefObject<HTMLElement | null>;
  direction: "left" | "right";
  enabled?: boolean;
  threshold?: number;
  dominantRatio?: number;
  allowOnButtons?: boolean;
  onSwipe: () => void;
}

export interface SwipeTargetCheckOptions {
  allowOnButtons?: boolean;
}

/** Check if device viewport is at or below mobile breakpoint (<= 640px) */
export function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia) {
    return window.matchMedia("(max-width: 640px)").matches;
  }
  return window.innerWidth <= 640;
}

/** Check if target element is eligible for mobile swipe gestures */
export function isEligibleSwipeTarget(
  target: EventTarget | null,
  container: HTMLElement | null,
  options?: SwipeTargetCheckOptions
): boolean {
  if (!(target instanceof HTMLElement)) return false;

  // 1. Text selection active -> abort
  if (typeof window !== "undefined") {
    try {
      const sel = window.getSelection();
      if (sel && sel.toString().trim().length > 0) return false;
    } catch {}
  }

  // 2. Input controls -> abort to preserve cursor/typing
  if (
    target.closest(
      "input, textarea, select, [contenteditable='true'], [data-pi-native-composer-host], .pi-enh-cursor-composer, .chat-input-container"
    )
  ) {
    return false;
  }

  // 3. Code blocks and tables -> abort to preserve code interaction
  if (target.closest("pre, code, table, .code-block, [data-code-block]")) {
    return false;
  }

  // 4. Buttons: abort by default in chat view, allow in navigation overlay
  if (!options?.allowOnButtons) {
    if (target.closest("button, [role='button']")) {
      return false;
    }
  }

  // 5. Elements with actual horizontal scroll capacity -> abort to preserve native horizontal scroll
  const docBody = typeof document !== "undefined" ? document.body : null;
  let cur: HTMLElement | null = target;
  while (cur && cur !== container && cur !== docBody) {
    if (cur.scrollWidth > cur.clientWidth + 2) {
      try {
        const overflowX = window.getComputedStyle(cur).overflowX;
        if (overflowX === "auto" || overflowX === "scroll") {
          return false;
        }
      } catch {}
    }
    cur = cur.parentElement;
  }

  return true;
}

export interface SwipeEvalState {
  horizontalLocked: boolean;
  abandoned: boolean;
}

/**
 * Evaluate movement delta during touchmove.
 * Invariant: If vertical scroll is detected first, permanently abandon this gesture.
 */
export function evaluateSwipeMove(
  deltaX: number,
  deltaY: number,
  direction: "left" | "right",
  state: SwipeEvalState,
  options?: { dominantRatio?: number }
): SwipeEvalState {
  if (state.abandoned) {
    return { horizontalLocked: false, abandoned: true };
  }
  if (state.horizontalLocked) {
    return { horizontalLocked: true, abandoned: false };
  }

  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);
  const ratio = options?.dominantRatio ?? 1.3;

  // Vertical scroll detected first -> permanently abandon swipe
  if (absY >= 6 && absY > absX) {
    return { horizontalLocked: false, abandoned: true };
  }
  if (absY >= 8 && absY >= absX * 0.85) {
    return { horizontalLocked: false, abandoned: true };
  }

  // Check if horizontal movement matches target direction
  const directionMatches = direction === "left" ? deltaX < 0 : deltaX > 0;
  if (!directionMatches && absX >= 8) {
    return { horizontalLocked: false, abandoned: true };
  }

  // Horizontal movement dominates with at least 8px -> lock horizontal swipe
  if (directionMatches && absX >= 8 && absX >= absY * ratio) {
    return { horizontalLocked: true, abandoned: false };
  }

  return { horizontalLocked: false, abandoned: false };
}

/** Check if completed touch gesture satisfies all final swipe criteria */
export function isFinalSwipeValid(
  deltaX: number,
  deltaY: number,
  direction: "left" | "right",
  state: SwipeEvalState,
  options?: { threshold?: number; dominantRatio?: number }
): boolean {
  if (state.abandoned || !state.horizontalLocked) return false;

  const threshold = options?.threshold ?? 40;
  const ratio = options?.dominantRatio ?? 1.3;
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);

  if (absX < threshold) return false;
  if (absX < absY * ratio) return false;

  return direction === "left" ? deltaX <= -threshold : deltaX >= threshold;
}

/**
 * Reusable hook for mobile horizontal swipe gesture recognition (<= 640px).
 * - Binds native touchstart/move/end/cancel on the provided containerRef
 * - Invariant: touchmove has passive:false, calls preventDefault once horizontal locked
 * - Invariant: At least 40px distance, 1.3 horizontal-dominant ratio, vertical-first permanently abandons
 * - Invariant: Suppresses ghost clicks after a valid swipe without preventing legitimate clicks
 */
export function useMobileHorizontalSwipe({
  containerRef,
  direction,
  enabled = true,
  threshold = 40,
  dominantRatio = 1.3,
  allowOnButtons = false,
  onSwipe,
}: UseMobileHorizontalSwipeOptions) {
  const onSwipeRef = useRef(onSwipe);
  onSwipeRef.current = onSwipe;

  // 用时间戳抑制 click，替代 250ms timer（避免不必要的定时器泄漏）
  const suppressClickUntilRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const container = containerRef.current;
    if (!container) return;

    let startX = 0;
    let startY = 0;
    let startTime = 0;
    let tracking = false;
    let state: SwipeEvalState = { horizontalLocked: false, abandoned: false };

    const handleTouchStart = (e: TouchEvent) => {
      // 正常随后 touchstart 立即恢复标志
      suppressClickUntilRef.current = 0;

      // Desktop / Wide screen invariant: do not interfere
      if (!isMobileViewport()) {
        tracking = false;
        return;
      }

      // Single-finger invariant: ignore multi-touch
      if (e.touches.length !== 1) {
        tracking = false;
        state = { horizontalLocked: false, abandoned: true };
        return;
      }

      const touch = e.touches[0];
      const target = touch.target;

      // Check element eligibility
      if (!isEligibleSwipeTarget(target, container, { allowOnButtons })) {
        tracking = false;
        state = { horizontalLocked: false, abandoned: true };
        return;
      }

      startX = touch.clientX;
      startY = touch.clientY;
      startTime = Date.now();
      tracking = true;
      state = { horizontalLocked: false, abandoned: false };
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (!tracking || state.abandoned) return;

      if (e.touches.length !== 1) {
        state = { horizontalLocked: false, abandoned: true };
        return;
      }

      const touch = e.touches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;

      state = evaluateSwipeMove(deltaX, deltaY, direction, state, { dominantRatio });

      // 水平锁定后立即开始抑制 click，避免短 swipe 误点子元素
      if (state.horizontalLocked && !state.abandoned) {
        suppressClickUntilRef.current = Date.now() + 400;
        if (e.cancelable) {
          e.preventDefault();
        }
      }
    };

    const handleTouchEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;

      const touch = e.changedTouches[0];
      if (!touch) return;

      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const elapsed = Date.now() - startTime;

      // Abort if long-press text selection occurred
      if (typeof window !== "undefined") {
        try {
          const sel = window.getSelection();
          if (sel && sel.toString().trim().length > 0) return;
        } catch {}
      }

      if (elapsed > 700) {
        // Exceeded reasonable swipe gesture duration
        return;
      }

      if (isFinalSwipeValid(deltaX, deltaY, direction, state, { threshold, dominantRatio })) {
        // 刷新抑制时间戳，持续抑制抬手后的 ghost click
        suppressClickUntilRef.current = Date.now() + 400;
        onSwipeRef.current();
      } else if (state.horizontalLocked && !state.abandoned) {
        // 水平锁定过但未达最终阈值，也短时间抑制可能产生的误点击
        suppressClickUntilRef.current = Date.now() + 400;
      }
    };

    const handleTouchCancel = () => {
      tracking = false;
      state = { horizontalLocked: false, abandoned: true };
    };

    const handleClickCapture = (e: MouseEvent) => {
      if (Date.now() < suppressClickUntilRef.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchCancel, { passive: true });
    container.addEventListener("click", handleClickCapture, { capture: true });

    return () => {
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchCancel);
      container.removeEventListener("click", handleClickCapture, { capture: true });
    };
  }, [containerRef, direction, enabled, threshold, dominantRatio, allowOnButtons]);
}
