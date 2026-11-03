"use client";

import { useSyncExternalStore } from "react";
import { isBrowserTabAppearance, sameBrowserTabAppearance, type BrowserTabAppearance } from "../lib/browser-tab-appearance.ts";
import {
  normalizeBrowserTabTitle,
  sanitizeRawBrowserTabTitle,
  BROWSER_TAB_TITLE_MAX_CODEPOINTS,
} from "../lib/browser-tab-title-normalization.ts";

export { normalizeBrowserTabTitle, BROWSER_TAB_TITLE_MAX_CODEPOINTS };

export interface BrowserTabTitleSnapshot {
  appearance: BrowserTabAppearance | null;
  rawTitle: string;
  customTitle: string;
  revision: number;
  version: number;
  isLoading: boolean;
  error: string | null;
  isConflict: boolean;
}

const DEFAULT_SNAPSHOT: BrowserTabTitleSnapshot = Object.freeze({
  appearance: null,
  rawTitle: "",
  customTitle: "",
  revision: 0,
  version: 1,
  isLoading: false,
  error: null,
  isConflict: false,
});

let currentSnapshot: BrowserTabTitleSnapshot = {
  ...DEFAULT_SNAPSHOT,
};

const listeners = new Set<() => void>();
let subscriptionActive = false;
let activeAbortController: AbortController | null = null;
let hasAttemptedInitialFetch = false;
let subscriptionGeneration = 0;

// save 串行队列锁：保护连点两个 save 时排队串行，防止并发写入导致版本混乱
let saveLockChain: Promise<void> = Promise.resolve();

function emitChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {}
  }
}

function updateSnapshot(updates: Partial<BrowserTabTitleSnapshot>): void {
  currentSnapshot = {
    ...currentSnapshot,
    ...updates,
  };
  emitChange();
}

// 严格校验来自服务端的 payload：必须是 version 1，revision 为非负 safe integer，title 为 string
function isValidPayload(
  data: unknown
): data is { version: number; revision: number; title: string; customTitle?: string; appearance?: BrowserTabAppearance | null } {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return (
    (d.appearance == null || isBrowserTabAppearance(d.appearance)) &&
    d.version === 1 &&
    typeof d.revision === "number" &&
    Number.isSafeInteger(d.revision) &&
    d.revision >= 0 &&
    typeof d.title === "string" &&
    d.title === sanitizeRawBrowserTabTitle(d.title) &&
    (d.customTitle === undefined || d.customTitle === normalizeBrowserTabTitle(d.title))
  );
}

async function fetchInitialSettings(
  signal: AbortSignal,
  expectedGeneration: number,
  options?: { preserveConflict?: boolean }
): Promise<void> {
  if (typeof window === "undefined") return;
  try {
    const res = await fetch("/api/ui-settings/browser-title", {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
      signal,
    });
    if (signal.aborted || expectedGeneration !== subscriptionGeneration) return;
    if (!res.ok) {
      updateSnapshot({
        isLoading: false,
        error: `Failed to load settings (HTTP ${res.status})`,
      });
      return;
    }
    const data = await res.json();
    if (signal.aborted || expectedGeneration !== subscriptionGeneration) return;

    if (!isValidPayload(data)) {
      updateSnapshot({
        isLoading: false,
        error: "Invalid settings payload from server",
      });
      return;
    }

    // monotonic revision 保证：noInitialGET 覆新 SSE
    // 如果本地 snapshot 的 revision 已经大于收到的 revision，绝不后退覆盖已有更新
    if (data.revision < currentSnapshot.revision) {
      updateSnapshot({
        isLoading: false,
      });
      return;
    }

    const preserveConflict = options?.preserveConflict || currentSnapshot.isConflict;

    updateSnapshot({
      appearance: data.appearance ?? null,
      rawTitle: data.title,
      customTitle: data.customTitle ?? normalizeBrowserTabTitle(data.title),
      revision: data.revision,
      version: 1,
      isLoading: false,
      error: preserveConflict ? currentSnapshot.error : null,
      isConflict: preserveConflict,
    });
  } catch (err: unknown) {
    if (signal.aborted || expectedGeneration !== subscriptionGeneration) return;
    const message = err instanceof Error ? err.message : String(err);
    updateSnapshot({
      isLoading: false,
      error: message || "Failed to load settings from server",
    });
  }
}

let lifecycleAttached = false;

function isPageVisible(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState !== "hidden";
}

function handleVisibilityChange(): void {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "hidden") {
    disconnectActiveSubscription();
  } else if (document.visibilityState === "visible") {
    if (listeners.size > 0 && !subscriptionActive) {
      startSubscription();
    }
  }
}

function handlePageShow(): void {
  if (listeners.size > 0 && isPageVisible() && !subscriptionActive) {
    startSubscription();
  }
}

function handlePageHide(): void {
  disconnectActiveSubscription();
}

function attachLifecycleListeners(): void {
  if (typeof window === "undefined" || lifecycleAttached) return;
  lifecycleAttached = true;
  if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", handleVisibilityChange);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pi-web-project-status", handleStatusSnapshot);
  }
}

function detachLifecycleListeners(): void {
  if (typeof window === "undefined" || !lifecycleAttached) return;
  lifecycleAttached = false;
  if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
  if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
    window.removeEventListener("pageshow", handlePageShow);
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("pi-web-project-status", handleStatusSnapshot);
  }
}

function disconnectActiveSubscription(): void {
  subscriptionGeneration++;
  subscriptionActive = false;
  if (activeAbortController) {
    try {
      activeAbortController.abort();
    } catch {}
    activeAbortController = null;
  }
  hasAttemptedInitialFetch = false;
  if (currentSnapshot.isLoading) {
    updateSnapshot({ isLoading: false });
  }
}

function startSubscription(): void {
  if (typeof window === "undefined") return;
  if (!isPageVisible() || subscriptionActive) return;
  subscriptionActive = true;

  subscriptionGeneration++;
  const thisGen = subscriptionGeneration;

  activeAbortController = new AbortController();

  if (!hasAttemptedInitialFetch) {
    hasAttemptedInitialFetch = true;
    updateSnapshot({ isLoading: true });
    void fetchInitialSettings(activeAbortController.signal, thisGen);
  }

  // Title revisions travel with the existing native status request: no extra
  // per-tab long-lived connection competes with session events on HTTP/1.1.
}

export function receiveBrowserTabTitleStatus(data: unknown): void {
  if (!subscriptionActive || !isValidPayload(data) || data.revision < currentSnapshot.revision) return;
  updateSnapshot({
    appearance: data.appearance ?? null,
    rawTitle: data.title,
    customTitle: data.customTitle ?? normalizeBrowserTabTitle(data.title),
    revision: data.revision,
    version: 1,
    isLoading: false,
    error: currentSnapshot.isConflict ? currentSnapshot.error : null,
    isConflict: currentSnapshot.isConflict,
  });
}

function handleStatusSnapshot(event: Event): void {
  const payload = (event as CustomEvent<{ payload?: { browserTitle?: unknown; browserTitleError?: string } }>).detail?.payload;
  if (!payload || !subscriptionActive) return;
  if (payload.browserTitleError) updateSnapshot({ error: payload.browserTitleError });
  else if (payload.browserTitle) receiveBrowserTabTitleStatus(payload.browserTitle);
}

function stopSubscription(): void {
  disconnectActiveSubscription();
}

export function subscribeBrowserTabTitle(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    attachLifecycleListeners();
    if (isPageVisible()) {
      startSubscription();
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      detachLifecycleListeners();
      stopSubscription();
    }
  };
}

export function getBrowserTabTitleSnapshot(): BrowserTabTitleSnapshot {
  return currentSnapshot;
}

function getServerSnapshot(): BrowserTabTitleSnapshot {
  return DEFAULT_SNAPSHOT;
}

export async function saveBrowserTabTitle(
  value: string,
  appearance?: BrowserTabAppearance | null
): Promise<{ success: boolean; conflict?: boolean; error?: string }> {
  // stale 订阅 generation 与 save 串行：连点击两个 save 必须排队执行
  let release: () => void = () => {};
  const lockPromise = new Promise<void>((r) => {
    release = r;
  });
  const prevLock = saveLockChain;
  saveLockChain = lockPromise;

  try {
    await prevLock;
    return await doSaveBrowserTabTitle(value, appearance);
  } finally {
    release();
  }
}

async function doSaveBrowserTabTitle(
  value: string,
  appearance?: BrowserTabAppearance | null
): Promise<{ success: boolean; conflict?: boolean; error?: string }> {
  if (currentSnapshot.isLoading || !hasAttemptedInitialFetch) {
    return { success: false, error: "Settings are not loaded" };
  }
  const sanitized = sanitizeRawBrowserTabTitle(value);
  const currentRevision = currentSnapshot.revision;

  try {
    const res = await fetch("/api/ui-settings/browser-title", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: sanitized,
        revision: currentRevision,
        ...(appearance !== undefined ? { appearance } : {}),
      }),
    });

    if (res.status === 409) {
      // 409 乐观锁冲突：保留冲突状态与 UI
      updateSnapshot({
        isConflict: true,
        error: "conflict",
      });
      // Refresh the authority without silently resubmitting or discarding the user's draft.
      await fetchInitialSettings(new AbortController().signal, subscriptionGeneration, { preserveConflict: true });
      return { success: false, conflict: true, error: "conflict" };
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const errMsg = errData.error || `HTTP ${res.status}`;
      updateSnapshot({
        error: errMsg,
        isConflict: false,
      });
      return { success: false, error: errMsg };
    }

    const data = await res.json();
    // 保存 ack fallback 假 revision 不允许！严格校验 payload
    if (!isValidPayload(data) || data.revision !== currentRevision + 1 || data.title !== sanitized ||
        (appearance !== undefined && !sameBrowserTabAppearance(data.appearance ?? null, appearance))) {
      updateSnapshot({
        error: "Server returned invalid payload on save",
      });
      return { success: false, error: "Server returned invalid payload on save" };
    }

    // A newer external write may arrive by SSE before this PUT acknowledgement.
    if (data.revision >= currentSnapshot.revision) {
      updateSnapshot({
        appearance: data.appearance ?? null,
        rawTitle: data.title,
        customTitle: normalizeBrowserTabTitle(data.title),
        revision: data.revision,
        version: 1,
        isLoading: false,
        error: null,
        isConflict: false,
      });
    }

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    updateSnapshot({
      error: message || "Network error",
    });
    return { success: false, error: message };
  }
}

export async function resetBrowserTabTitle(): Promise<{ success: boolean; conflict?: boolean; error?: string }> {
  return await saveBrowserTabTitle("", null);
}

export async function setBrowserTabTitle(
  value: string
): Promise<{ success: boolean; conflict?: boolean; error?: string }> {
  return await saveBrowserTabTitle(value);
}

export function _resetBrowserTabTitleStateForTesting(): void {
  detachLifecycleListeners();
  stopSubscription();
  listeners.clear();
  currentSnapshot = { ...DEFAULT_SNAPSHOT };
  hasAttemptedInitialFetch = false;
  saveLockChain = Promise.resolve();
}

export function useBrowserTabTitle() {
  const snapshot = useSyncExternalStore(subscribeBrowserTabTitle, getBrowserTabTitleSnapshot, getServerSnapshot);
  return {
    appearance: snapshot.appearance,
    rawTitle: snapshot.rawTitle,
    customTitle: snapshot.customTitle,
    revision: snapshot.revision,
    version: snapshot.version,
    isLoading: snapshot.isLoading,
    error: snapshot.error,
    isConflict: snapshot.isConflict,
    saveTitle: saveBrowserTabTitle,
    resetTitle: resetBrowserTabTitle,
    setTitle: setBrowserTabTitle,
  };
}
