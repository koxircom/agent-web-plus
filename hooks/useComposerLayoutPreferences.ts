"use client";

import { useSyncExternalStore, useCallback } from "react";
import { isEnhancementPluginFastActive } from "@/lib/enhancement-settings.generated";

export const COMPOSER_HEIGHT_STORAGE_PREFIX = "pi-web:composer-session-height:v1:";
export const COMPOSER_PREFERENCES_CHANGE_EVENT = "pi-native-composer-preferences-change";

export interface ComposerLayoutPreferences {
  codexLayoutEnabled: boolean;
  modelReasoningPillEnabled: boolean;
  modesEnabled: boolean;
  customHeight: number | null;
  heightLocked: boolean;
}

export const DEFAULT_COMPOSER_PREFERENCES: Readonly<ComposerLayoutPreferences> = Object.freeze({
  codexLayoutEnabled: true,
  modelReasoningPillEnabled: true,
  modesEnabled: true,
  customHeight: null,
  heightLocked: false,
});

interface SessionHeight { customHeight: number | null; heightLocked: boolean }
const AUTOMATIC_HEIGHT: Readonly<SessionHeight> = Object.freeze({ customHeight: null, heightLocked: false });
// Hydrate only the selected owner once. Input renders never read storage again.
const heights = new Map<string, SessionHeight>();
const snapshots = new Map<string, { signature: string; value: ComposerLayoutPreferences }>();
function cacheHeight(key: string, height: SessionHeight): void {
  if (!heights.has(key) && heights.size >= 128) {
    const oldest = heights.keys().next().value!;
    heights.delete(oldest);
    snapshots.delete(oldest);
  }
  heights.set(key, height);
}
function heightKey(ownerKey?: string): string {
  return COMPOSER_HEIGHT_STORAGE_PREFIX + encodeURIComponent(ownerKey ?? "");
}
function sanitizeHeight(height: unknown): number | null {
  return typeof height === "number" && Number.isFinite(height) && height >= 28
    ? Math.round(height) : null;
}
function readHeight(ownerKey?: string): SessionHeight {
  const key = heightKey(ownerKey);
  const cached = heights.get(key);
  if (cached) return cached;
  let height: SessionHeight = AUTOMATIC_HEIGHT;
  if (ownerKey) {
    try {
      const stored = JSON.parse(readStorageItem(key) ?? "null");
      const customHeight = sanitizeHeight(stored?.height);
      if (customHeight !== null) height = { customHeight, heightLocked: stored.locked === true };
    } catch { /* Invalid or unavailable storage starts with automatic sizing. */ }
  }
  cacheHeight(key, height);
  return height;
}

function getSafeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch (_) {
    return null;
  }
}

function readStorageItem(key: string): string | null {
  try {
    const storage = getSafeLocalStorage();
    return storage ? storage.getItem(key) : null;
  } catch (_) {
    return null;
  }
}

function getPreferencesSnapshot(ownerKey?: string): ComposerLayoutPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_COMPOSER_PREFERENCES;
  }

  // 1. 读取布局、胶囊与模式偏好
  const codexLayoutEnabled = isEnhancementPluginFastActive("codex-composer-layout");
  const modelReasoningPillEnabled = isEnhancementPluginFastActive("composer-model-reasoning-pill");
  const modesEnabled = isEnhancementPluginFastActive("composer-modes");

  const { customHeight, heightLocked } = readHeight(ownerKey);
  const signature = `${codexLayoutEnabled}:${modelReasoningPillEnabled}:${modesEnabled}:${customHeight}:${heightLocked}`;
  const key = heightKey(ownerKey);
  const cached = snapshots.get(key);
  if (cached?.signature === signature) return cached.value;
  const value = { codexLayoutEnabled, modelReasoningPillEnabled, modesEnabled, customHeight, heightLocked };
  snapshots.set(key, { signature, value });
  return value;
}

function subscribeToPreferences(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};

  const onStorageChange = (e: StorageEvent) => {
    if (
      !e.key ||
      e.key === "pi-enh-settings-v1" ||
      e.key.startsWith("pi-enh-plugin-") ||
      e.key.startsWith(COMPOSER_HEIGHT_STORAGE_PREFIX)
    ) {
      if (!e.key) heights.clear();
      else if (e.key.startsWith(COMPOSER_HEIGHT_STORAGE_PREFIX)) heights.delete(e.key);
      callback();
    }
  };

  const onCustomChange = () => {
    callback();
  };

  try {
    window.addEventListener("storage", onStorageChange);
    window.addEventListener(COMPOSER_PREFERENCES_CHANGE_EVENT, onCustomChange);
  } catch (_) {}

  return () => {
    try {
      window.removeEventListener("storage", onStorageChange);
      window.removeEventListener(COMPOSER_PREFERENCES_CHANGE_EVENT, onCustomChange);
    } catch (_) {}
  };
}

export function saveComposerCustomHeight(ownerKey: string | undefined, height: number | null, locked = false): void {
  const customHeight = sanitizeHeight(height);
  const state = customHeight === null ? AUTOMATIC_HEIGHT : { customHeight, heightLocked: locked };
  const key = heightKey(ownerKey);
  cacheHeight(key, state); // Also works when storage is denied or full.
  try {
    if (ownerKey) {
      const storage = getSafeLocalStorage();
      if (customHeight === null) storage?.removeItem(key);
      else storage?.setItem(key, JSON.stringify({ height: customHeight, locked }));
    }
  } catch { /* The in-memory state remains authoritative for this page. */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(COMPOSER_PREFERENCES_CHANGE_EVENT));
}

export function rekeyComposerHeight(previousKey: string, nextKey: string): void {
  const previous = readHeight(previousKey);
  if (previous.customHeight !== null && readHeight(nextKey).customHeight === null) {
    saveComposerCustomHeight(nextKey, previous.customHeight, previous.heightLocked);
  }
  saveComposerCustomHeight(previousKey, null);
}

export function useComposerLayoutPreferences(ownerKey?: string): ComposerLayoutPreferences & {
  setCustomHeight: (height: number | null, locked?: boolean) => void;
} {
  const getSnapshot = useCallback(() => getPreferencesSnapshot(ownerKey), [ownerKey]);
  const preferences = useSyncExternalStore(subscribeToPreferences, getSnapshot, () => DEFAULT_COMPOSER_PREFERENCES);
  const setCustomHeight = useCallback((height: number | null, locked = false) => {
    saveComposerCustomHeight(ownerKey, height, locked);
  }, [ownerKey]);
  return { ...preferences, setCustomHeight };
}
