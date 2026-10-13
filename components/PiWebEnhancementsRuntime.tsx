"use client";

import { useEffect } from "react";
import {
  initializeNativeNotificationPolicy,
  type NativeNotificationWindow,
} from "@/lib/native-notifications";
import { scheduleImagePreload } from "@/lib/image-capabilities";
import {
  ensureEnhancementsRuntime as bootstrapEnhancementsRuntime,
  type EnhancementsRuntimeWindow,
} from "@/lib/enhancement-state-bootstrap";

const STANDALONE_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const OFFICIAL_PI_VERSION =
  process.env.NEXT_PUBLIC_PI_VERSION &&
  process.env.NEXT_PUBLIC_PI_VERSION !== "unknown"
    ? process.env.NEXT_PUBLIC_PI_VERSION
    : "0.87.1";

import type { EnhancementStateReadResult } from "@/lib/enhancement-state-store.cjs";
type EnhancementsWindow = Window & EnhancementsRuntimeWindow;

export function ensureEnhancementsRuntime(
  targetWindow?: EnhancementsRuntimeWindow,
): Promise<boolean> {
  const win =
    targetWindow ??
    (typeof window !== "undefined"
      ? (window as EnhancementsWindow)
      : undefined);
  if (!win) {
    return Promise.resolve(false);
  }
  initializeNativeNotificationPolicy(
    win as unknown as NativeNotificationWindow,
  );
  win.__PI_ENH_NATIVE_STATE_API__ = true;
  win.__PI_OFFICIAL_AGENT_VERSION__ = OFFICIAL_PI_VERSION;
  return bootstrapEnhancementsRuntime(win, {
    standaloneVersion: STANDALONE_VERSION,
    officialPiVersion: OFFICIAL_PI_VERSION,
  });
}

export function PiWebEnhancementsRuntime({
  initialState,
  durableStatePresent,
}: {
  initialState?: EnhancementStateReadResult | null;
  durableStatePresent?: boolean;
}) {
  useEffect(() => {
    const win = window as EnhancementsWindow;
    // The server read is the same authoritative snapshot used by the sidebar.
    // Existing revision/outbox checks still decide whether it may be applied.
    if (typeof durableStatePresent === "boolean")
      win.__PI_ENH_DURABLE_STATE_ENABLED__ = durableStatePresent;
    if (initialState) win.__PI_ENH_INITIAL_DURABLE_STATE__ = initialState;
    void ensureEnhancementsRuntime();
    const cancelImagePreload = scheduleImagePreload();
    const onVisibilityChange = () => {
      const win = window as EnhancementsWindow;
      if (
        document.visibilityState === "visible" &&
        !win.__PI_WEB_ENHANCEMENTS_LOADED__
      ) {
        win.__PI_ENH_RELOAD__?.();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelImagePreload();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [initialState, durableStatePresent]);

  return null;
}
