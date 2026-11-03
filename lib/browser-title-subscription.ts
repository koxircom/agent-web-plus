import type { BrowserTabAppearance } from "./browser-tab-appearance";
import fs from "node:fs";
import path from "node:path";
import {
  readAgentWebSettings,
  normalizeBrowserTabTitle,
  AGENT_WEB_SETTINGS_FILE,
} from "./browser-tab-title";

export const RESOURCE_FALLBACK_CODES = new Set(["ENOSPC", "EMFILE", "ENFILE"]);

export function isResourceFallbackError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return Boolean(code && RESOURCE_FALLBACK_CODES.has(code));
}

export interface BrowserTitleSnapshot {
  version: number;
  revision: number;
  title: string;
  customTitle: string;
  appearance?: BrowserTabAppearance | null;
}

export interface TitleSubscriber {
  onSnapshot: (snapshot: BrowserTitleSnapshot) => void;
  onError: (err: { error: string }) => void;
  onFallback?: (info: { mode: "poll"; code: string }) => void;
}

export interface SubscriptionHandle {
  unsubscribe: () => void;
  getInitialSnapshot: () => Promise<BrowserTitleSnapshot>;
  getMode: () => "watch" | "poll" | "none";
  getFallbackCode: () => string | null;
}

export interface SubscribeOptions {
  fsModule?: typeof fs;
  pollIntervalMs?: number;
  debounceMs?: number;
}

interface AgentDirHub {
  agentDir: string;
  subscribers: Set<TitleSubscriber>;
  mode: "watch" | "poll" | "none";
  fallbackCode: string | null;
  watcher: fs.FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  debounceTimer: NodeJS.Timeout | null;
  lastSnapshot: BrowserTitleSnapshot | null;
  inFlight: Promise<BrowserTitleSnapshot | null> | null;
  pendingRefresh: boolean;
  isClosed: boolean;
  fsModule: typeof fs;
  pollIntervalMs: number;
  debounceMs: number;
}

const hubs = new Map<string, AgentDirHub>();

function cleanupHub(hub: AgentDirHub): void {
  hub.isClosed = true;
  if (hub.debounceTimer) {
    clearTimeout(hub.debounceTimer);
    hub.debounceTimer = null;
  }
  if (hub.pollTimer) {
    clearInterval(hub.pollTimer);
    hub.pollTimer = null;
  }
  if (hub.watcher) {
    try {
      hub.watcher.removeAllListeners();
    } catch {}
    try {
      hub.watcher.close();
    } catch {}
    hub.watcher = null;
  }
  hub.subscribers.clear();
}

function startPollingFallback(hub: AgentDirHub, code: string): void {
  if (hub.isClosed || hub.pollTimer) return;
  hub.mode = "poll";
  hub.fallbackCode = code;

  for (const sub of hub.subscribers) {
    try {
      sub.onFallback?.({ mode: "poll", code });
    } catch {}
  }

  hub.pollTimer = setInterval(() => {
    void triggerRefresh(hub);
  }, hub.pollIntervalMs);
}

function setupHubObserver(hub: AgentDirHub): void {
  try {
    hub.watcher = hub.fsModule.watch(
      hub.agentDir,
      { persistent: false },
      (_eventType, filename) => {
        if (hub.isClosed) return;
        const fn = filename ? String(filename) : "";
        if (fn && fn !== AGENT_WEB_SETTINGS_FILE) return;
        if (hub.debounceTimer) clearTimeout(hub.debounceTimer);
        hub.debounceTimer = setTimeout(() => {
          hub.debounceTimer = null;
          void triggerRefresh(hub);
        }, hub.debounceMs);
      }
    );
    hub.mode = "watch";

    hub.watcher.on("error", (err) => {
      if (hub.isClosed) return;
      if (hub.watcher) {
        try {
          hub.watcher.removeAllListeners();
        } catch {}
        try {
          hub.watcher.close();
        } catch {}
        hub.watcher = null;
      }
      if (isResourceFallbackError(err)) {
        startPollingFallback(hub, (err as NodeJS.ErrnoException).code || "ENOSPC");
      } else {
        hub.mode = "none";
        const errPayload = { error: "Watcher error" };
        for (const sub of hub.subscribers) {
          try {
            sub.onError(errPayload);
          } catch {}
        }
        cleanupHub(hub);
        hubs.delete(hub.agentDir);
      }
    });
  } catch (err: unknown) {
    if (isResourceFallbackError(err)) {
      startPollingFallback(hub, (err as NodeJS.ErrnoException).code || "ENOSPC");
    } else {
      hub.mode = "none";
      cleanupHub(hub);
      hubs.delete(hub.agentDir);
      throw err;
    }
  }
}

async function readFreshSnapshot(agentDir: string): Promise<BrowserTitleSnapshot> {
  const { settings } = await readAgentWebSettings(agentDir);
  return {
    version: settings.version,
    revision: settings.revision,
    title: settings.title,
    customTitle: normalizeBrowserTabTitle(settings.title),
    ...(settings.tabAppearance ? { appearance: settings.tabAppearance } : {}),
  };
}

function triggerRefresh(hub: AgentDirHub): Promise<BrowserTitleSnapshot | null> {
  if (hub.isClosed) return Promise.resolve(null);
  if (hub.inFlight) {
    hub.pendingRefresh = true;
    return hub.inFlight;
  }

  hub.inFlight = (async () => {
    try {
      do {
        hub.pendingRefresh = false;
        try {
          const snapshot = await readFreshSnapshot(hub.agentDir);
          if (hub.isClosed) break;
          const current = hub.lastSnapshot;
          // latest monotonic: revision 不倒退
          if (!current || snapshot.revision >= current.revision) {
            const hasChanged =
              !current ||
              current.revision !== snapshot.revision ||
              current.version !== snapshot.version ||
              current.title !== snapshot.title;
            hub.lastSnapshot = snapshot;
            if (hasChanged) {
              for (const sub of hub.subscribers) {
                try {
                  sub.onSnapshot(snapshot);
                } catch {}
              }
            }
          }
        } catch {
          if (!hub.isClosed) {
            const errPayload = { error: "Failed to read fresh settings" };
            for (const sub of hub.subscribers) {
              try {
                sub.onError(errPayload);
              } catch {}
            }
          }
        }
      } while (hub.pendingRefresh && !hub.isClosed);
    } finally {
      hub.inFlight = null;
    }
    return hub.lastSnapshot;
  })();

  return hub.inFlight;
}

export function subscribeBrowserTitle(
  agentDir: string,
  subscriber: TitleSubscriber,
  options: SubscribeOptions = {}
): SubscriptionHandle {
  const fsMod = options.fsModule || fs;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const debounceMs = options.debounceMs ?? 25;

  const normalizedDir = path.resolve(agentDir);

  // 保 read-only GET 不 mkdir
  if (!fsMod.existsSync(normalizedDir)) {
    throw Object.assign(new Error("Settings directory unavailable"), {
      code: "ENOENT",
    });
  }

  let hub = hubs.get(normalizedDir);
  if (!hub) {
    hub = {
      agentDir: normalizedDir,
      subscribers: new Set(),
      mode: "none",
      fallbackCode: null,
      watcher: null,
      pollTimer: null,
      debounceTimer: null,
      lastSnapshot: null,
      inFlight: null,
      pendingRefresh: false,
      isClosed: false,
      fsModule: fsMod,
      pollIntervalMs,
      debounceMs,
    };
    hubs.set(normalizedDir, hub);
    setupHubObserver(hub);
  }

  hub.subscribers.add(subscriber);

  if (hub.mode === "poll" && hub.fallbackCode) {
    const code = hub.fallbackCode;
    try {
      subscriber.onFallback?.({ mode: "poll", code });
    } catch {}
  }

  return {
    unsubscribe: () => {
      if (!hub || !hub.subscribers.delete(subscriber)) return;
      if (hub.subscribers.size === 0) {
        cleanupHub(hub);
        if (hubs.get(normalizedDir) === hub) hubs.delete(normalizedDir);
      }
    },
    getInitialSnapshot: async () => {
      const snapshot = await triggerRefresh(hub);
      if (snapshot) return snapshot;
      return await readFreshSnapshot(hub.agentDir);
    },
    getMode: () => hub.mode,
    getFallbackCode: () => hub.fallbackCode,
  };
}

export function getActiveHubCount(): number {
  return hubs.size;
}

export function getHubDebugInfo(agentDir: string): {
  subscriberCount: number;
  mode: "watch" | "poll" | "none";
  fallbackCode: string | null;
  hasWatcher: boolean;
  hasPollTimer: boolean;
  hasDebounceTimer: boolean;
  isClosed: boolean;
} | null {
  const normalized = path.resolve(agentDir);
  const hub = hubs.get(normalized);
  if (!hub) return null;
  return {
    subscriberCount: hub.subscribers.size,
    mode: hub.mode,
    fallbackCode: hub.fallbackCode,
    hasWatcher: hub.watcher !== null,
    hasPollTimer: hub.pollTimer !== null,
    hasDebounceTimer: hub.debounceTimer !== null,
    isClosed: hub.isClosed,
  };
}

export function resetAllSubscriptionsForTesting(): void {
  for (const [, hub] of hubs.entries()) {
    cleanupHub(hub);
  }
  hubs.clear();
}
