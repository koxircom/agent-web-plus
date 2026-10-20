import type { SessionData } from "../hooks/useAgentSession";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
} from "./types.ts";
import {
  getAssistantErrorMessage,
  isAssistantTruncated,
} from "./message-display.ts";

export const PROCESS_COLLAPSE_CHANGE_EVENT = "pi-enh-process-collapse-change";
export const NATIVE_PROCESS_COLLAPSE_VERSION = 1;
export const HISTORY_LOAD_TAIL_MIN = 50;
export const HISTORY_LOAD_TAIL_MAX = 500;
export const HISTORY_LOAD_TAIL_DEFAULT = 250;

export interface EnhancementHistoryState {
  sessionId: string | null;
  totalTurns: number;
  hasEarlierMessages: boolean;
  entryIds: string[];
  oldestEntryId: string | null;
}

export interface SessionReloadController {
  getSessionId: () => string | null;
  getSessionData?: () => SessionData | null;
  isActive?: () => boolean;
  reloadSession: (
    sessionId: string,
    showLoading?: boolean,
    includeState?: boolean,
    options?: { force?: boolean },
  ) => unknown;
}

export interface EnhancementWindowLike {
  __PI_ENH_NATIVE_PROCESS_COLLAPSE__?: number;
  __PI_ENH_IS_PLUGIN_ENABLED__?: (id: string) => boolean;
  __PI_ENH_GET_HISTORY_STATE__?: () => EnhancementHistoryState;
  __PI_ENH_LOAD_EARLIER__?: (tail?: unknown, source?: string) => Promise<boolean>;
  __PI_ENH_PREPARE_HISTORY_COMMIT__?: () => void;
  __PI_WEB_GET_RESIDENT_SESSION_DATA__?: (sessionId: string) => SessionData | null;
  __PI_WEB_RELOAD_SESSION__?: (
    sessionId: string,
    showLoading?: boolean,
    includeState?: boolean,
    options?: { force?: boolean },
  ) => unknown;
  __PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__?: (showLoading?: boolean) => unknown;
  __PI_ENH_RELOAD_CURRENT_SESSION__?: (showLoading?: boolean) => unknown;
  localStorage?: Pick<Storage, "getItem"> | null;
  location?: { search?: string } | null;
  addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
}

export function getEnhancementWindow(): EnhancementWindowLike | null {
  if (typeof window === "undefined") return null;
  return window as unknown as EnhancementWindowLike;
}

export function installNativeProcessCollapseFlag(
  win: EnhancementWindowLike | null = getEnhancementWindow(),
): void {
  if (!win) return;
  win.__PI_ENH_NATIVE_PROCESS_COLLAPSE__ = NATIVE_PROCESS_COLLAPSE_VERSION;
}

if (typeof window !== "undefined") {
  installNativeProcessCollapseFlag();
}

export function isEnhancementPluginEnabled(
  id = "task-tool-auto-collapse",
  win: EnhancementWindowLike | null = getEnhancementWindow(),
): boolean {
  if (!win) return true;
  if (typeof win.__PI_ENH_IS_PLUGIN_ENABLED__ === "function") {
    try {
      return Boolean(win.__PI_ENH_IS_PLUGIN_ENABLED__(id));
    } catch {
      // Fall back to localStorage below if the runtime bridge throws.
    }
  }
  try {
    const rawSettings = win.localStorage?.getItem("pi-enh-settings-v1") || "{}";
    const config = JSON.parse(rawSettings) as {
      modules?: Record<string, { enabled?: boolean }>;
      features?: Record<string, { enabled?: boolean }>;
    };
    if (config.modules?.["conversation-navigation"]?.enabled === false) {
      return false;
    }
    const enabled = config.features?.[id]?.enabled;
    if (typeof enabled === "boolean") return enabled;
    return win.localStorage?.getItem(`pi-enh-plugin-${id}`) !== "false";
  } catch {
    return true;
  }
}

export function subscribeProcessCollapseChange(
  onChange: () => void,
  win: EnhancementWindowLike | null = getEnhancementWindow(),
): () => void {
  if (!win || typeof win.addEventListener !== "function" || typeof win.removeEventListener !== "function") {
    return () => {};
  }
  const listener = () => onChange();
  win.addEventListener(PROCESS_COLLAPSE_CHANGE_EVENT, listener);
  return () => {
    win.removeEventListener?.(PROCESS_COLLAPSE_CHANGE_EVENT, listener);
  };
}

/** Preserve public commentary in place; only technical blocks enter disclosure groups. */
export function splitAssistantDisplayRuns(message: AssistantMessage): { kind: "public" | "process"; message: AssistantMessage }[] {
  const runs: { kind: "public" | "process"; blocks: AssistantContentBlock[]; indices: number[] }[] = [];
  for (const [originalIndex, block] of (message.content ?? []).entries()) {
    if (block.type === "text" && !block.text.trim()) continue;
    if (block.type === "thinking" && !block.deferred && !block.thinking.trim()) continue;
    const kind = block.type === "thinking" || block.type === "toolCall" ? "process" : "public";
    const previous = runs.at(-1);
    if (previous?.kind === kind) { previous.blocks.push(block); previous.indices.push(originalIndex); }
    else runs.push({ kind, blocks: [block], indices: [originalIndex] });
  }
  if (
    runs.at(-1)?.kind !== "public"
    && (message.retryAttempt || getAssistantErrorMessage(message) || isAssistantTruncated(message))
  ) {
    runs.push({ kind: "public", blocks: [], indices: [] });
  }
  return runs.map((run, index) => {
    const last = index === runs.length - 1;
    const copy = { ...message, content: run.blocks, displayBlockIndices: run.indices };
    if (!last) {
      delete copy.usage;
      delete copy.errorMessage;
      copy.stopReason = "stop";
    }
    return { kind: run.kind, message: copy };
  });
}

export function clampHistoryLoadTail(
  requestedTail: unknown,
  fallback = HISTORY_LOAD_TAIL_DEFAULT,
): number {
  if (
    requestedTail === undefined
    || requestedTail === null
    || requestedTail === ""
    || typeof requestedTail === "boolean"
  ) {
    return fallback;
  }
  const numeric = typeof requestedTail === "number" ? requestedTail : Number(requestedTail);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(
    HISTORY_LOAD_TAIL_MIN,
    Math.min(HISTORY_LOAD_TAIL_MAX, Math.round(numeric)),
  );
}

export function buildEnhancementHistoryState(input: {
  sessionId: string | null | undefined;
  totalTurns: number | null | undefined;
  hasEarlierMessages: boolean;
  entryIds: readonly string[];
  oldestEntryId: string | null | undefined;
}): EnhancementHistoryState {
  const rawTurns = input.totalTurns;
  const totalTurns = typeof rawTurns === "number" && Number.isFinite(rawTurns) && rawTurns > 0
    ? Math.floor(rawTurns)
    : 0;
  return {
    sessionId: input.sessionId ?? null,
    totalTurns,
    hasEarlierMessages: Boolean(input.hasEarlierMessages),
    entryIds: Array.isArray(input.entryIds) ? [...input.entryIds] : [],
    oldestEntryId: input.oldestEntryId ?? null,
  };
}

export interface EarlierHistoryLoaderDeps<
  TContext extends { messages?: readonly unknown[]; entryIds?: readonly string[] } = {
    messages: AgentMessage[];
    entryIds: string[];
  },
> {
  isLoading: () => boolean;
  setLoading: (loading: boolean) => void;
  hasEarlierMessages: () => boolean;
  getOldestEntryId: () => string | null;
  getSessionId: () => string | null;
  getActiveLeafId: () => string | null;
  isMounted?: () => boolean;
  captureScrollAnchor?: () => void;
  clearScrollAnchor?: () => void;
  loadContext: (
    sessionId: string,
    leafId: string | null,
    before: string,
    options: { tail: number },
  ) => Promise<TContext | null | undefined>;
  onContextLoaded?: (context: TContext) => void;
}

export function createEarlierHistoryLoader<
  TContext extends { messages?: readonly unknown[]; entryIds?: readonly string[] },
>(deps: EarlierHistoryLoaderDeps<TContext>): (requestedTail?: unknown) => Promise<boolean> {
  return async (requestedTail?: unknown): Promise<boolean> => {
    if (deps.isLoading() || !deps.hasEarlierMessages()) return false;
    const oldestId = deps.getOldestEntryId();
    if (!oldestId) return false;
    const sessionId = deps.getSessionId();
    if (!sessionId) return false;
    const leafId = deps.getActiveLeafId();
    const tail = clampHistoryLoadTail(requestedTail);

    deps.setLoading(true);
    deps.captureScrollAnchor?.();
    try {
      const context = await deps.loadContext(sessionId, leafId, oldestId, { tail });
      if (
        !context
        || (deps.isMounted && !deps.isMounted())
        || deps.getSessionId() !== sessionId
        || deps.getActiveLeafId() !== leafId
      ) {
        deps.clearScrollAnchor?.();
        return false;
      }
      if (!Array.isArray(context.messages) || context.messages.length === 0) {
        deps.clearScrollAnchor?.();
      }
      deps.onContextLoaded?.(context);
      return true;
    } catch {
      deps.clearScrollAnchor?.();
      return false;
    } finally {
      deps.setLoading(false);
    }
  };
}

export function registerHistoryViewportBridges(
  win: EnhancementWindowLike | null | undefined,
  handlers: {
    getHistoryState: () => EnhancementHistoryState;
    loadEarlier: (requestedTail?: unknown) => Promise<boolean>;
    prepareHistoryCommit: () => void;
  },
): () => void {
  if (!win) return () => {};
  const { getHistoryState, loadEarlier, prepareHistoryCommit } = handlers;
  win.__PI_ENH_GET_HISTORY_STATE__ = getHistoryState;
  win.__PI_ENH_LOAD_EARLIER__ = loadEarlier;
  win.__PI_ENH_PREPARE_HISTORY_COMMIT__ = prepareHistoryCommit;
  return () => {
    if (win.__PI_ENH_GET_HISTORY_STATE__ === getHistoryState) {
      delete win.__PI_ENH_GET_HISTORY_STATE__;
    }
    if (win.__PI_ENH_LOAD_EARLIER__ === loadEarlier) {
      delete win.__PI_ENH_LOAD_EARLIER__;
    }
    if (win.__PI_ENH_PREPARE_HISTORY_COMMIT__ === prepareHistoryCommit) {
      delete win.__PI_ENH_PREPARE_HISTORY_COMMIT__;
    }
  };
}

interface ReloadRegistryState {
  residentDataBridge: (sessionId: string) => SessionData | null;
  controllers: Set<SessionReloadController>;
  reloadSessionBridge: (
    sessionId: string,
    showLoading?: boolean,
    includeState?: boolean,
    options?: { force?: boolean },
  ) => unknown;
  nativeReloadCurrentBridge: (showLoading?: boolean) => unknown;
  fallbackEnhReloadCurrentBridge: (showLoading?: boolean) => unknown;
}

const reloadRegistries = new WeakMap<EnhancementWindowLike, ReloadRegistryState>();

function resolveWindowActiveSessionId(win: EnhancementWindowLike): string | null {
  try {
    const historySid = win.__PI_ENH_GET_HISTORY_STATE__?.()?.sessionId;
    if (typeof historySid === "string" && historySid.length > 0) return historySid;
  } catch {
    // Ignore history bridge errors.
  }
  try {
    const search = win.location?.search;
    if (typeof search === "string" && search.length > 0) {
      const sid = new URLSearchParams(search).get("session");
      if (sid) return sid;
    }
  } catch {
    // Ignore URL parsing errors.
  }
  return null;
}

function findCurrentController(
  controllers: Set<SessionReloadController>,
  win: EnhancementWindowLike,
): SessionReloadController | null {
  const list = Array.from(controllers);
  if (list.length === 0) return null;

  const activeSid = resolveWindowActiveSessionId(win);
  if (activeSid) {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.getSessionId() === activeSid && c.isActive?.() !== false) return c;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.getSessionId() === activeSid) return c;
    }
  }

  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.isActive?.() === true && c.getSessionId()) return c;
  }

  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.getSessionId()) return c;
  }

  return list[list.length - 1] ?? null;
}

function findControllerForSession(
  controllers: Set<SessionReloadController>,
  sessionId: string,
  win: EnhancementWindowLike,
): SessionReloadController | null {
  const list = Array.from(controllers);
  if (list.length === 0) return null;

  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.getSessionId() === sessionId && c.isActive?.() !== false) return c;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (c.getSessionId() === sessionId) return c;
  }

  return findCurrentController(controllers, win);
}

function getOrCreateReloadRegistry(win: EnhancementWindowLike): ReloadRegistryState {
  let state = reloadRegistries.get(win);
  if (state) return state;

  const controllers = new Set<SessionReloadController>();
  const nativeReloadCurrentBridge = (showLoading = false): unknown => {
    const controller = findCurrentController(controllers, win);
    const sid = controller?.getSessionId();
    if (!controller || !sid) return false;
    return controller.reloadSession(sid, Boolean(showLoading), true);
  };
  const reloadSessionBridge = (
    sessionId: string,
    showLoading = false,
    includeState = true,
    options?: { force?: boolean },
  ): unknown => {
    if (!sessionId) return nativeReloadCurrentBridge(showLoading);
    const controller = findControllerForSession(controllers, sessionId, win);
    if (!controller) return false;
    return controller.reloadSession(sessionId, Boolean(showLoading), includeState, options);
  };
  const fallbackEnhReloadCurrentBridge = (showLoading = false): unknown => (
    nativeReloadCurrentBridge(showLoading)
  );

  const residentDataBridge = (sessionId: string): SessionData | null => {
    const controller = findControllerForSession(controllers, sessionId, win);
    // Never substitute the active chat for another requested session.
    if (!controller || controller.getSessionId() !== sessionId || controller.isActive?.() === false) return null;
    const data = controller.getSessionData?.();
    return data?.sessionId === sessionId ? data : null;
  };
  state = {
    residentDataBridge,
    controllers,
    reloadSessionBridge,
    nativeReloadCurrentBridge,
    fallbackEnhReloadCurrentBridge,
  };
  reloadRegistries.set(win, state);
  return state;
}

export function registerSessionReloadAliases(
  win: EnhancementWindowLike | null | undefined,
  controller: SessionReloadController,
): () => void {
  if (!win) return () => {};
  const state = getOrCreateReloadRegistry(win);
  // Refresh insertion order so the latest mounted/updated active pane is preferred.
  state.controllers.delete(controller);
  state.controllers.add(controller);

  win.__PI_WEB_GET_RESIDENT_SESSION_DATA__ = state.residentDataBridge;
  win.__PI_WEB_RELOAD_SESSION__ = state.reloadSessionBridge;
  win.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__ = state.nativeReloadCurrentBridge;
  if (typeof win.__PI_ENH_RELOAD_CURRENT_SESSION__ !== "function") {
    win.__PI_ENH_RELOAD_CURRENT_SESSION__ = state.fallbackEnhReloadCurrentBridge;
  }

  return () => {
    state.controllers.delete(controller);
    if (state.controllers.size === 0) {
      if (win.__PI_WEB_GET_RESIDENT_SESSION_DATA__ === state.residentDataBridge) {
        delete win.__PI_WEB_GET_RESIDENT_SESSION_DATA__;
      }
      if (win.__PI_WEB_RELOAD_SESSION__ === state.reloadSessionBridge) {
        delete win.__PI_WEB_RELOAD_SESSION__;
      }
      if (win.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__ === state.nativeReloadCurrentBridge) {
        delete win.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__;
      }
      if (win.__PI_ENH_RELOAD_CURRENT_SESSION__ === state.fallbackEnhReloadCurrentBridge) {
        delete win.__PI_ENH_RELOAD_CURRENT_SESSION__;
      }
    }
  };
}

