export interface EnhancementSidebarBridgeHandle<TSession = unknown> {
  refreshSessions: (showLoading?: boolean, force?: boolean) => unknown;
  getRawSessions: () => TSession[];
  getSessionGroups?: () => unknown[];
  getExecutionEngine?: () => "pi" | "codex";
  rerenderSessions: () => void;
  notifySessionDeleted: (sessionId: string) => void;
  setUnreadSession: (sessionId: string, isUnread: boolean) => void;
  isSessionUnread: (sessionId: string) => boolean;
}

export interface EnhancementSearchResultFields {
  searchGroup?: string;
  searchProjectKey?: string;
  searchProjectTitle?: string;
  isArchived?: boolean;
  isFirstArchived?: boolean;
  archivedSearchCount?: number;
}

type WindowRecord = Record<string, unknown>;

interface SidebarBridgeState {
  handles: Set<EnhancementSidebarBridgeHandle>;
  installed: Record<string, unknown>;
}

interface OpenSettingsBridgeState {
  primaryHandlers: Set<(section: string) => void>;
  fallbackHandlers: Set<(section: string) => void>;
  installedDispatcher: (section?: string) => void;
}

const SIDEBAR_BRIDGE_KEYS = [
  "__PI_ENH_REFRESH_SESSIONS__",
  "__PI_ENH_GET_RAW_SESSIONS__",
  "__PI_ENH_GET_SEARCH_CATALOG__",
  "__PI_ENH_GET_SESSION_GROUPS__",
  "__PI_ENH_GET_EXECUTION_ENGINE__",
  "__PI_ENH_RERENDER_SESSIONS__",
  "__PI_ENH_SESSION_DELETED__",
  "__PI_ENH_SET_UNREAD_SESSION__",
  "__PI_ENH_IS_SESSION_UNREAD__",
] as const;

/** Search membership/content identity; ordinary activity timestamps do not change it. */
export function getSessionSearchCatalogScope(sessions: readonly unknown[]): string {
  return JSON.stringify(sessions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const session = value as Record<string, unknown>;
    if (typeof session.id !== "string" || session.transient || session.submissionPending) return [];
    return [[session.id, ...["path", "cwd", "name", "firstMessage"].map((key) =>
      typeof session[key] === "string" ? session[key] : ""),
      typeof session.messageCount === "number" && Number.isFinite(session.messageCount)
        ? session.messageCount
        : null,
    ]];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

const sidebarBridgeRegistry = new WeakMap<object, SidebarBridgeState>();
const openSettingsBridgeRegistry = new WeakMap<object, OpenSettingsBridgeState>();

function getDefaultWindow(): WindowRecord | undefined {
  return typeof window !== "undefined" ? (window as unknown as WindowRecord) : undefined;
}

function getOrCreateSidebarBridgeState(win: WindowRecord): SidebarBridgeState {
  const existing = sidebarBridgeRegistry.get(win);
  if (existing) return existing;

  const handles = new Set<EnhancementSidebarBridgeHandle>();

  const installed: Record<string, unknown> = {
    __PI_ENH_REFRESH_SESSIONS__: (showLoading = false, force = false) => {
      let lastResult: unknown;
      for (const handle of handles) {
        try {
          lastResult = handle.refreshSessions(Boolean(showLoading), Boolean(force));
        } catch {
          // Isolate per-pane callback errors
        }
      }
      return lastResult;
    },
    __PI_ENH_GET_RAW_SESSIONS__: () => {
      const list = [...handles];
      let fallbackArray: unknown[] = [];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        try {
          const raw = list[i].getRawSessions();
          if (Array.isArray(raw)) {
            if (raw.length > 0) return raw;
            fallbackArray = raw;
          }
        } catch {
          // Ignore faulty pane getter
        }
      }
      return fallbackArray;
    },
    __PI_ENH_GET_SEARCH_CATALOG__: () => {
      const sessions = (installed.__PI_ENH_GET_RAW_SESSIONS__ as () => unknown[])();
      return { sessions, scope: getSessionSearchCatalogScope(sessions) };
    },
    __PI_ENH_GET_SESSION_GROUPS__: () => {
      const list = [...handles];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        try {
          const fn = list[i].getSessionGroups;
          if (typeof fn === "function") {
            const groups = fn();
            if (Array.isArray(groups)) return groups;
          }
        } catch {
          // Ignore faulty pane getter
        }
      }
      return [];
    },
    __PI_ENH_GET_EXECUTION_ENGINE__: () => {
      const list = [...handles];
      for (let i = list.length - 1; i >= 0; i -= 1) {
        try {
          const fn = list[i].getExecutionEngine;
          if (typeof fn === "function") {
            const engine = fn();
            if (engine === "codex" || engine === "pi") return engine;
          }
        } catch {
          // Ignore faulty pane getter
        }
      }
      return "pi";
    },
    __PI_ENH_RERENDER_SESSIONS__: () => {
      for (const handle of handles) {
        try {
          handle.rerenderSessions();
        } catch {
          // Isolate per-pane rerender errors
        }
      }
    },
    __PI_ENH_SESSION_DELETED__: (sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId) return;
      for (const handle of handles) {
        try {
          handle.notifySessionDeleted(sessionId);
        } catch {
          // Isolate per-pane deletion notification errors
        }
      }
    },
    __PI_ENH_SET_UNREAD_SESSION__: (sessionId: string, isUnread: boolean) => {
      if (typeof sessionId !== "string" || !sessionId) return;
      const targetState = Boolean(isUnread);
      for (const handle of handles) {
        try {
          handle.setUnreadSession(sessionId, targetState);
        } catch {
          // Isolate per-pane unread state errors
        }
      }
    },
    __PI_ENH_IS_SESSION_UNREAD__: (sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId) return false;
      for (const handle of handles) {
        try {
          if (handle.isSessionUnread(sessionId)) return true;
        } catch {
          // Ignore faulty pane unread check
        }
      }
      return false;
    },
  };

  const state: SidebarBridgeState = { handles, installed };
  sidebarBridgeRegistry.set(win, state);
  return state;
}

export function registerEnhancementSidebarBridge<TSession = unknown>(
  handle: EnhancementSidebarBridgeHandle<TSession>,
  win: WindowRecord | undefined = getDefaultWindow(),
): () => void {
  if (!win) return () => {};

  const state = getOrCreateSidebarBridgeState(win);
  state.handles.add(handle);

  for (const key of SIDEBAR_BRIDGE_KEYS) {
    win[key] = state.installed[key];
  }

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    state.handles.delete(handle);
    if (state.handles.size === 0) {
      for (const key of SIDEBAR_BRIDGE_KEYS) {
        if (win[key] === state.installed[key]) {
          delete win[key];
        }
      }
    }
  };
}

function getOrCreateOpenSettingsState(win: WindowRecord): OpenSettingsBridgeState {
  const existing = openSettingsBridgeRegistry.get(win);
  if (existing) return existing;

  const primaryHandlers = new Set<(section: string) => void>();
  const fallbackHandlers = new Set<(section: string) => void>();

  const installedDispatcher = (rawSection?: string) => {
    const normalized = typeof rawSection === "string" && rawSection.trim()
      ? (rawSection.trim() === "settings" ? "general" : rawSection.trim())
      : "general";

    const activePrimary = [...primaryHandlers].at(-1);
    if (activePrimary) {
      try {
        activePrimary(normalized);
        return;
      } catch {
        // Fall through to fallback if primary throws
      }
    }

    const activeFallback = [...fallbackHandlers].at(-1);
    if (activeFallback) {
      try {
        activeFallback(normalized);
      } catch {
        // Ignore fallback failure
      }
    }
  };

  const state: OpenSettingsBridgeState = {
    primaryHandlers,
    fallbackHandlers,
    installedDispatcher,
  };
  openSettingsBridgeRegistry.set(win, state);
  return state;
}

export function registerEnhancementOpenSettings(
  handler: (section: string) => void,
  options?: { fallback?: boolean; win?: WindowRecord },
): () => void {
  const win = options?.win ?? getDefaultWindow();
  if (!win || typeof handler !== "function") return () => {};

  const state = getOrCreateOpenSettingsState(win);
  const bucket = options?.fallback ? state.fallbackHandlers : state.primaryHandlers;
  bucket.add(handler);

  const existingFn = win.__PI_OPEN_SETTINGS__;
  const hasExternalPrimary = typeof existingFn === "function" && existingFn !== state.installedDispatcher;

  // Sidebar fallback must never clobber an already registered external or primary setter.
  if (!options?.fallback || !hasExternalPrimary) {
    win.__PI_OPEN_SETTINGS__ = state.installedDispatcher;
    win.__PI_ENH_OPEN_SETTINGS__ = state.installedDispatcher;
  }

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    bucket.delete(handler);
    if (
      state.primaryHandlers.size === 0
      && state.fallbackHandlers.size === 0
    ) {
      if (win.__PI_OPEN_SETTINGS__ === state.installedDispatcher) {
        delete win.__PI_OPEN_SETTINGS__;
      }
      if (win.__PI_ENH_OPEN_SETTINGS__ === state.installedDispatcher) {
        delete win.__PI_ENH_OPEN_SETTINGS__;
      }
    }
  };
}

export function createSidebarShortcutsFallbackHandler(
  shortcutsHost: ParentNode,
): (section: string) => void {
  return (section: string) => {
    const buttons = shortcutsHost.querySelectorAll<HTMLButtonElement>("button:not(.pi-enh-shortcut-btn)");
    if (section === "models" && buttons[0]) {
      buttons[0].click();
      return;
    }
    if (section === "skills" && buttons[1] && !buttons[1].disabled) {
      buttons[1].click();
      return;
    }
    const settingsBtn = buttons[buttons.length - 1];
    if (settingsBtn) settingsBtn.click();
  };
}

export function composeEnhancementWindowTitle(
  baseTitle: string,
  win: WindowRecord | undefined = getDefaultWindow(),
): string {
  if (!win) return baseTitle;
  try {
    const isPluginEnabled = win.__PI_ENH_IS_PLUGIN_ENABLED__;
    if (typeof isPluginEnabled === "function" && isPluginEnabled("project-status-indicator") === false) {
      return baseTitle;
    }
    const compose = win.__PI_ENH_COMPOSE_WINDOW_TITLE__;
    if (typeof compose === "function") {
      const composed = compose(baseTitle);
      if (typeof composed === "string" && composed.length > 0) {
        return composed;
      }
    }
  } catch {
    // Fallback to native title when enhancement hook throws
  }
  return baseTitle;
}

export function processEnhancementSessionGroups<T>(
  groups: T[],
  win: WindowRecord | undefined = getDefaultWindow(),
): T[] {
  if (!win) return groups;
  try {
    const hook = win.__PI_ENH_PROCESS_SESSION_GROUPS__;
    if (typeof hook === "function") {
      const processed = hook(groups);
      if (Array.isArray(processed)) return processed as T[];
    }
  } catch {
    // Fallback to native session groups on error
  }
  return groups;
}

export function getEnhancementSessionHeadersHeight<T>(
  groups: T[],
  win: WindowRecord | undefined = getDefaultWindow(),
): number {
  if (!win) return 0;
  try {
    const hook = win.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__;
    if (typeof hook === "function") {
      const height = Number(hook(groups));
      if (Number.isFinite(height) && height >= 0) return height;
    }
  } catch {
    // Fallback to 0 on error
  }
  return 0;
}

export function getEnhancementSessionItemTop<T>(
  index: number,
  groups: T[],
  itemHeight: number,
  win: WindowRecord | undefined = getDefaultWindow(),
): number {
  const fallback = index * itemHeight;
  if (!win) return fallback;
  try {
    const hook = win.__PI_ENH_GET_SESSION_ITEM_TOP__;
    if (typeof hook === "function") {
      const top = hook(index, groups);
      if (typeof top === "number" && Number.isFinite(top)) return top;
    }
  } catch {
    // Fallback to native coordinate on error
  }
  return fallback;
}

export interface EnhancementSessionOdooAddon {
  technical: string;
  status: string;
  isLatest: boolean;
}

// The manifest owner validates update evidence; React owns the resulting badges.
export function getEnhancementSessionOdooAddons(
  sessionId: string,
  win: WindowRecord | undefined = getDefaultWindow(),
): EnhancementSessionOdooAddon[] {
  if (!win || !sessionId) return [];
  try {
    const hook = win.__PI_ENH_GET_SESSION_ODOO_ADDONS__;
    if (typeof hook === "function") {
      const addons = hook(sessionId);
      if (Array.isArray(addons)) {
        return addons.filter((addon): addon is EnhancementSessionOdooAddon =>
          addon && typeof addon.technical === "string" && Boolean(addon.technical),
        );
      }
    }
  } catch {
    // An unavailable enhancement must not prevent the native sidebar rendering.
  }
  return [];
}

export interface EnhancementSessionTag { id: string; name: string; color?: string; }

// The durable state owner keeps revision/outbox reconciliation. React alone
// renders the tag nodes, including the server-provided initial snapshot.
export function getEnhancementSessionTags(
  sessionId: string,
  initial?: { sessionTagsDefinitions: EnhancementSessionTag[]; sessionTagMappings: Record<string, unknown> } | null,
  win: WindowRecord | undefined = getDefaultWindow(),
): EnhancementSessionTag[] {
  try {
    const hook = win?.__PI_ENH_GET_SESSION_TAGS__;
    if (typeof hook === "function") {
      const tags = hook(sessionId);
      return Array.isArray(tags) ? tags : [];
    }
  } catch { return []; }
  const ids = initial?.sessionTagMappings[sessionId];
  return Array.isArray(ids) ? ids.flatMap((id) => {
    const tag = initial?.sessionTagsDefinitions.find((tag) => tag.id === id);
    return tag ? [tag] : [];
  }) : [];
}

export function hasEnhancementSessionLayout(win: WindowRecord | undefined = getDefaultWindow()): boolean {
  return typeof win?.__PI_ENH_GET_SESSION_ITEM_TOP__ === "function";
}

export function getEnhancementSessionItemHeight(
  sessionId: string,
  fallback: number,
  win: WindowRecord | undefined = getDefaultWindow(),
): number {
  if (!win) return fallback;
  try {
    const hook = win.__PI_ENH_GET_SESSION_ITEM_HEIGHT__;
    if (typeof hook === "function") {
      const height = hook(sessionId);
      if (typeof height === "number" && Number.isFinite(height) && height > 0) return height;
    }
  } catch {
    // Keep the native height when enhancement state is unavailable.
  }
  return fallback;
}

export function processEnhancementSearchResults<T>(
  results: T[] | undefined,
  win: WindowRecord | undefined = getDefaultWindow(),
): Array<T & EnhancementSearchResultFields> {
  const fallback = (Array.isArray(results) ? results : []) as Array<T & EnhancementSearchResultFields>;
  if (!win) return fallback;
  try {
    const hook = win.__PI_ENH_PROCESS_SEARCH_RESULTS__;
    if (typeof hook === "function") {
      const processed = hook(results);
      if (Array.isArray(processed)) return processed as Array<T & EnhancementSearchResultFields>;
    }
  } catch {
    // Fallback to native search results on error
  }
  return fallback;
}

export function getEnhancementSearchResultDataProps(
  item: EnhancementSearchResultFields & { session: { id: string } },
): {
  "data-search-session-id": string;
  "data-search-group"?: string;
  "data-search-project-key"?: string;
  "data-search-project-title"?: string;
  "data-search-archived"?: "true";
  "data-search-archived-first"?: "true";
  "data-search-archive-divider"?: string;
} {
  return {
    "data-search-session-id": item.session.id,
    "data-search-group": item.searchGroup || (item.isArchived ? "archived" : undefined),
    "data-search-project-key": item.searchProjectKey || undefined,
    "data-search-project-title": item.searchProjectTitle || undefined,
    "data-search-archived": item.isArchived ? "true" : undefined,
    "data-search-archived-first": item.isFirstArchived ? "true" : undefined,
    "data-search-archive-divider": item.isFirstArchived
      ? `已归档会话 · ${item.archivedSearchCount ?? 0} 个匹配`
      : undefined,
  };
}

export interface EnhancementProjectActivity {
  running: number;
  attention: number;
  interrupted: number;
  status: "running" | "attention" | "interrupted" | "unknown" | null;
  label: string;
}

export function getEnhancementProjectActivity(projectKey: string | null, others = false): EnhancementProjectActivity | null {
  const win = getDefaultWindow();
  try {
    const hook = win?.__PI_ENH_GET_PROJECT_ACTIVITY__;
    return typeof hook === "function" ? hook(projectKey, others) : null;
  } catch { return null; }
}

export function getEnhancementSessionStatus(sessionId: string): { status: string; unread?: boolean } | null {
  const win = getDefaultWindow();
  try {
    if (typeof win?.__PI_ENH_IS_PLUGIN_ENABLED__ === "function" && win.__PI_ENH_IS_PLUGIN_ENABLED__("project-status-indicator") === false) return null;
    const hook = win?.__PI_ENH_GET_EFFECTIVE_PROJECT_STATUS_ENTRY__;
    return typeof hook === "function" ? hook(sessionId) : null;
  } catch { return null; }
}
