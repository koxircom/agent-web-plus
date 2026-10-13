export const ENHANCEMENT_STATE_ENDPOINT = "/api/enhancement-state";
export const ENHANCEMENT_STATE_HEADER = "x-pi-enhancement-state";
export const DURABLE_STATE_REVISION_KEY = "pi-enh-durable-state-rev";
export const DECORATION_OP_PREFIX = "pi-enh-decoration-op-v2:";
export const DURABLE_STATE_PROBE_TIMEOUT_MS = 3000;

const DEFAULT_STANDALONE_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
const DEFAULT_OFFICIAL_PI_VERSION =
  process.env.NEXT_PUBLIC_PI_VERSION && process.env.NEXT_PUBLIC_PI_VERSION !== "unknown"
    ? process.env.NEXT_PUBLIC_PI_VERSION
    : "0.87.1";
const BOOTSTRAP_STATE_SYMBOL = Symbol.for("pi-web:enhancements-runtime-bootstrap");

export interface StorageLike {
  readonly length: number;
  getItem(key: string): string | null;
  key(index: number): string | null;
  [key: string]: unknown;
}

export interface ScriptElementLike {
  id: string;
  src: string;
  async: boolean;
  integrity?: string;
  crossOrigin?: string;
  onerror: (() => void) | null;
  remove?: () => void;
}

export interface ElementContainerLike {
  appendChild(node: ScriptElementLike): unknown;
}

export interface DocumentLike {
  getElementById(id: string): { remove(): void } | null;
  createElement(tagName: "script" | string): ScriptElementLike;
  head?: ElementContainerLike | null;
  documentElement?: ElementContainerLike | null;
  visibilityState?: string;
}

export type EnhancementsRuntimeWindow = {
  __PI_WEB_LOADER_INJECTED__?: boolean;
  __PI_WEB_STANDALONE_EDITION__?: string;
  __PI_WEB_STANDALONE_VERSION__?: string;
  __PI_OFFICIAL_AGENT_VERSION__?: string;
  __PI_ENH_NATIVE_STATE_API__?: boolean;
  __PI_ENH_DURABLE_STATE_ENABLED__?: boolean;
  __PI_ENH_INITIAL_DURABLE_STATE__?: unknown;
  __PI_WEB_ENHANCEMENTS_LOADED__?: boolean;
  __PI_ENH_ASSET_BUILD__?: string;
  __PI_ENH_RELOAD__?: (forceBust?: boolean) => void;
  localStorage?: StorageLike | null;
  fetch?: typeof fetch;
  document?: DocumentLike;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  [BOOTSTRAP_STATE_SYMBOL]?: RuntimeBootstrapState;
};

export interface EnsureEnhancementsRuntimeOptions {
  standaloneVersion?: string;
  officialPiVersion?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

interface RuntimeBootstrapState {
  promise: Promise<boolean>;
  probePending: boolean;
  initialLoadScheduled: boolean;
  initialScriptInserted: boolean;
  pendingReloadForceBust: boolean | null;
  loadScript: (forceBust?: boolean) => void;
}

function resolveStorage(winOrStorage: unknown): StorageLike | null {
  if (!winOrStorage || typeof winOrStorage !== "object") return null;
  if ("localStorage" in (winOrStorage as Record<string, unknown>)) {
    const candidate = (winOrStorage as { localStorage?: unknown }).localStorage;
    return candidate && typeof candidate === "object" ? (candidate as StorageLike) : null;
  }
  return winOrStorage as StorageLike;
}

/**
 * Returns true ONLY when localStorage is readable, `pi-enh-durable-state-rev` is <= 0 (or absent),
 * and no `pi-enh-decoration-op-v2:` outbox keys exist.
 * Any storage read error, positive/invalid revision, or pending outbox key fails closed (returns false).
 */
export function canUseLegacyModelsConfig(winOrStorage: unknown): boolean {
  try {
    const storage = resolveStorage(winOrStorage);
    if (!storage || typeof storage !== "object") {
      return false;
    }
    if (
      typeof storage.getItem !== "function"
      || typeof storage.key !== "function"
      || typeof storage.length !== "number"
      || !Number.isInteger(storage.length)
      || storage.length < 0
    ) {
      return false;
    }

    const rawRevision = storage.getItem(DURABLE_STATE_REVISION_KEY);
    if (rawRevision !== null) {
      if (typeof rawRevision !== "string") {
        return false;
      }
      const trimmed = rawRevision.trim();
      if (trimmed !== "") {
        const parsedRevision = Number(trimmed);
        if (!Number.isFinite(parsedRevision) || parsedRevision > 0) {
          return false;
        }
      }
    }

    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (typeof key === "string" && key.startsWith(DECORATION_OP_PREFIX)) {
        return false;
      }
    }

    for (const key of Object.keys(storage)) {
      if (key.startsWith(DECORATION_OP_PREFIX)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export async function probeDurableStateCapability(
  win: EnhancementsRuntimeWindow,
  options?: EnsureEnhancementsRuntimeOptions,
): Promise<boolean> {
  const fetchImpl =
    options?.fetch
    ?? (typeof win.fetch === "function" ? win.fetch.bind(win) : undefined)
    ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);

  if (typeof fetchImpl !== "function") {
    win.__PI_ENH_DURABLE_STATE_ENABLED__ = true;
    return true;
  }

  const setTimer =
    options?.setTimeout
    ?? (typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : globalThis.setTimeout.bind(globalThis));
  const clearTimer =
    options?.clearTimeout
    ?? (typeof win.clearTimeout === "function"
      ? win.clearTimeout.bind(win)
      : globalThis.clearTimeout.bind(globalThis));

  const timeoutMs = options?.timeoutMs ?? DURABLE_STATE_PROBE_TIMEOUT_MS;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const abortTimeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimer(() => {
      try {
        controller?.abort();
      } catch {
        // ignore abort errors
      }
      reject(new Error(`HEAD ${ENHANCEMENT_STATE_ENDPOINT} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      fetchImpl(ENHANCEMENT_STATE_ENDPOINT, {
        method: "HEAD",
        cache: "no-store",
        credentials: "same-origin",
        ...(controller ? { signal: controller.signal } : {}),
      }),
      abortTimeoutPromise,
    ]);

    if (!response || response.status !== 200) {
      win.__PI_ENH_DURABLE_STATE_ENABLED__ = true;
      return true;
    }

    const rawHeader =
      response.headers?.get?.(ENHANCEMENT_STATE_HEADER)
      ?? response.headers?.get?.("X-Pi-Enhancement-State")
      ?? null;
    const normalizedHeader = typeof rawHeader === "string" ? rawHeader.trim().toLowerCase() : "";

    if (normalizedHeader === "present") {
      win.__PI_ENH_DURABLE_STATE_ENABLED__ = true;
      return true;
    }

    if (normalizedHeader === "absent") {
      const durable = canUseLegacyModelsConfig(win) ? false : true;
      win.__PI_ENH_DURABLE_STATE_ENABLED__ = durable;
      return durable;
    }

    win.__PI_ENH_DURABLE_STATE_ENABLED__ = true;
    return true;
  } catch {
    win.__PI_ENH_DURABLE_STATE_ENABLED__ = true;
    return true;
  } finally {
    if (timer !== null) {
      clearTimer(timer);
    }
  }
}

export function ensureEnhancementsRuntime(
  targetWindow?: EnhancementsRuntimeWindow,
  options?: EnsureEnhancementsRuntimeOptions,
): Promise<boolean> {
  const win =
    targetWindow
    ?? (typeof window !== "undefined" ? (window as unknown as EnhancementsRuntimeWindow) : undefined);
  if (!win) {
    return Promise.resolve(false);
  }

  const standaloneVersion =
    options?.standaloneVersion ?? win.__PI_WEB_STANDALONE_VERSION__ ?? DEFAULT_STANDALONE_VERSION;
  const officialPiVersion =
    options?.officialPiVersion
    ?? win.__PI_OFFICIAL_AGENT_VERSION__
    ?? DEFAULT_OFFICIAL_PI_VERSION;

  win.__PI_WEB_LOADER_INJECTED__ = true;
  win.__PI_WEB_STANDALONE_EDITION__ = `koxir-standalone-${standaloneVersion}`;
  win.__PI_WEB_STANDALONE_VERSION__ = standaloneVersion;
  win.__PI_OFFICIAL_AGENT_VERSION__ = officialPiVersion;
  win.__PI_ENH_NATIVE_STATE_API__ = true;

  const existingState = win[BOOTSTRAP_STATE_SYMBOL];
  if (existingState) {
    if (!existingState.probePending) {
      if (win.__PI_ENH_DURABLE_STATE_ENABLED__ === false && !canUseLegacyModelsConfig(win)) {
        win.__PI_ENH_DURABLE_STATE_ENABLED__ = true;
      }
      const doc = win.document ?? (typeof document !== "undefined" ? (document as unknown as DocumentLike) : undefined);
      const hasScript = Boolean(doc?.getElementById("pi-web-enhancements-script"));
      if (
        !win.__PI_WEB_ENHANCEMENTS_LOADED__
        && !hasScript
        && !existingState.initialLoadScheduled
      ) {
        existingState.initialLoadScheduled = true;
        existingState.initialScriptInserted = true;
        existingState.loadScript(false);
      }
    }
    return existingState.promise;
  }

  const setTimer =
    options?.setTimeout
    ?? (typeof win.setTimeout === "function" ? win.setTimeout.bind(win) : globalThis.setTimeout.bind(globalThis));

  let firstScriptLoad = true;
  let retryCount = 0;
  const maxRetries = 3;

  const loadScript = (forceBust = false) => {
    if (!forceBust && win.__PI_WEB_ENHANCEMENTS_LOADED__) return;
    const doc = win.document ?? (typeof document !== "undefined" ? (document as unknown as DocumentLike) : undefined);
    if (!doc) return;
    const existing = doc.getElementById("pi-web-enhancements-script");
    if (existing) existing.remove();
    const script = doc.createElement("script");
    script.id = "pi-web-enhancements-script";
    const assetBuild = win.__PI_ENH_ASSET_BUILD__ || `koxir-${standaloneVersion}`;
    // Only the first insertion belongs to this compiled build. Hot reloads must
    // discover current compatibility bytes, not replay a previous build's hash.
    const immutablePath = firstScriptLoad && !forceBust ? process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_PATH : "";
    firstScriptLoad = false;
    script.src = immutablePath || `/pi-web-enhancements.js?v=${encodeURIComponent(assetBuild)}${forceBust ? `&t=${Date.now()}` : ""}`;
    if (immutablePath && process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_INTEGRITY) {
      script.integrity = process.env.NEXT_PUBLIC_PI_ENHANCEMENT_ASSET_INTEGRITY;
      script.crossOrigin = "anonymous";
    }
    script.async = true;
    script.onerror = () => {
      if (retryCount < maxRetries) {
        retryCount += 1;
        setTimer(() => loadScript(true), 1000 * retryCount);
      }
    };
    (doc.head || doc.documentElement)?.appendChild(script);
  };

  const hasExplicitBooleanFlag = typeof win.__PI_ENH_DURABLE_STATE_ENABLED__ === "boolean";

  const state: RuntimeBootstrapState = {
    promise: Promise.resolve(true),
    probePending: !hasExplicitBooleanFlag,
    initialLoadScheduled: true,
    initialScriptInserted: false,
    pendingReloadForceBust: null,
    loadScript,
  };

  win[BOOTSTRAP_STATE_SYMBOL] = state;

  win.__PI_ENH_RELOAD__ = (forceBust = true) => {
    if (state.probePending) {
      state.pendingReloadForceBust = forceBust;
      void state.promise;
      return;
    }
    state.initialScriptInserted = true;
    loadScript(forceBust);
  };

  const finalizeAndLoadScript = (resolvedDurable: boolean): boolean => {
    const finalDurable = resolvedDurable || !canUseLegacyModelsConfig(win);
    win.__PI_ENH_DURABLE_STATE_ENABLED__ = finalDurable;
    state.probePending = false;
    state.initialLoadScheduled = false;

    if (state.pendingReloadForceBust !== null) {
      const forceBust = state.pendingReloadForceBust;
      state.pendingReloadForceBust = null;
      state.initialScriptInserted = true;
      loadScript(forceBust);
    } else if (!win.__PI_WEB_ENHANCEMENTS_LOADED__ && !state.initialScriptInserted) {
      state.initialScriptInserted = true;
      loadScript(false);
    }

    return finalDurable;
  };

  if (hasExplicitBooleanFlag) {
    const explicitDurable = win.__PI_ENH_DURABLE_STATE_ENABLED__ === true;
    const effectiveDurable = explicitDurable || !canUseLegacyModelsConfig(win);
    win.__PI_ENH_DURABLE_STATE_ENABLED__ = effectiveDurable;
    state.promise = new Promise<boolean>((resolve) => {
      queueMicrotask(() => {
        resolve(finalizeAndLoadScript(effectiveDurable));
      });
    });
    return state.promise;
  }

  // Pending state stays fail-closed (durable = true) until HEAD completes
  win.__PI_ENH_DURABLE_STATE_ENABLED__ = true;
  state.promise = probeDurableStateCapability(win, options).then((probedDurable) =>
    finalizeAndLoadScript(probedDurable),
  );

  return state.promise;
}
