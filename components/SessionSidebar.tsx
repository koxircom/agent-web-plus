"use client";

import { codexProjectKey } from "@/lib/execution-engines/codex-projection";

import { useTouchContextMenu } from "@/hooks/useTouchContextMenu";

import { mergeLocalSessions } from "@/lib/session-catalog-client";

import { registerSessionPreloadBridge, updateSessionPreloadCatalog } from "@/lib/session-preload";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies } from "@/lib/session-family";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { dispatchSessionRowContextMenu, SESSION_ROW_RENAME_EVENT } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getProjectActivity, getRecentProjects, sessionsForProject } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-memory";
import { formatRelativeTime } from "@/lib/i18n/format";
import {
  createSidebarShortcutsFallbackHandler,
  getEnhancementSessionHeadersHeight,
  getEnhancementProjectActivity,
  getEnhancementSessionStatus,
  type EnhancementProjectActivity,
  getEnhancementSessionItemHeight,
  getEnhancementSessionTags,
  hasEnhancementSessionLayout,
  getEnhancementSessionItemTop,
  getEnhancementSessionOdooAddons,
  processEnhancementSessionGroups,
  registerEnhancementOpenSettings,
  registerEnhancementSidebarBridge,
} from "@/lib/enhancement-sidebar-bridge";
import { useI18n } from "@/hooks/useI18n";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import { DismissButton } from "./DismissButton";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { SessionSearch } from "./SessionSearch";
import { ExecutionEngineSwitcher } from "./ExecutionEngineSwitcher";

// Fixed row height for the session list. SessionItem renders at exactly this
// height, so the list can be windowed (only the visible slice is mounted).
const SESSION_LIST_ITEM_HEIGHT = 54;

interface FileManagerAvailability {
  supported: boolean;
  reason: string | null;
  platform: string;
}

// Server error codes with a translation; any other code is shown verbatim.
const FILE_MANAGER_ERROR_KEYS: Record<string, string> = {
  remote: "sidebar.openInExplorerRemoteOnly",
  "unsupported-platform": "sidebar.openInExplorerUnsupported",
};

export function getSessionListIndices(count: number, scrollTop: number, viewportHeight: number, focusedIndex = -1): number[] {
  const overscan = 8;
  const visibleCount = Math.ceil((viewportHeight || 600) / SESSION_LIST_ITEM_HEIGHT) + overscan * 2;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / SESSION_LIST_ITEM_HEIGHT) - overscan, count - visibleCount));
  const end = Math.min(count, start + visibleCount);
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  // Keep a focused row mounted so scrolling cannot discard an inline rename.
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end && focusedIndex < count) indices.push(focusedIndex);
  return indices;
}

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text-muted)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 26, height: 26, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 5,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color 0.3s, background 0.3s",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

function sessionListUrl(summary: boolean, force: boolean, engine: "pi" | "codex"): string {
  if (summary) return `/api/sessions?engine=${engine}&summary=1`;
  if (force) return `/api/sessions?engine=${engine}&force=1`;
  return `/api/sessions?engine=${engine}`;
}

const EMPTY_LOCAL_SESSIONS: SessionInfo[] = [];

import type { SidebarBootstrap } from "@/lib/sidebar-bootstrap";

interface Props {
  bootstrap?: SidebarBootstrap;
  executionEngine?: "pi" | "codex";
  codexEnabled?: boolean;
  onExecutionEngineChange?: (engine: "pi" | "codex") => Promise<void>;
  initialCwd?: string | null;
  localSessions?: SessionInfo[];
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onNewSession?: (sessionId: string, cwd: string, engine: "pi" | "codex") => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff" }) => void;
  onOpenTerminal?: (cwd: string) => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: () => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const RUNNING_SESSIONS_POLL_MS = 2500;
const SESSION_DETAILS_HYDRATION_DELAY_MS = 750;
const SESSION_PANE_DEFAULT_HEIGHT = 320;
const SESSION_PANE_MIN_HEIGHT = 80;
const EXPLORER_PANE_MIN_HEIGHT = 120;
const SESSION_PANE_MAX_HEIGHT = 1600;

function loadLastCustomCwd(engine: "pi" | "codex"): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(`${LAST_CUSTOM_CWD_STORAGE_KEY}:${engine}`)
      ?? (engine === "pi" ? window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) : null) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string, engine: "pi" | "codex"): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${LAST_CUSTOM_CWD_STORAGE_KEY}:${engine}`, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

const DROPDOWN_ANIMATION_MS = 200;

function AnimatedDropdown({ open, children, style }: { open: boolean; children: ReactNode; style: CSSProperties }) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (open) {
      setMounted(true);
    } else {
      timeout = setTimeout(() => setMounted(false), DROPDOWN_ANIMATION_MS);
    }

    return () => {
      if (timeout) clearTimeout(timeout);
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className="pi-native-menu-motion"
      data-menu-motion-state={open ? "open" : "closed"}
      inert={!open}
      aria-hidden={!open}
      style={{
        ...style,
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}



export function SessionSidebar({ bootstrap, executionEngine = "pi", codexEnabled = false, onExecutionEngineChange, initialCwd, selectedSessionId, onSelectSession, onNewSession, initialSessionId, skipInitialProjectSelection, onInitialRestoreDone, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, onOpenTerminal, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange, localSessions = EMPTY_LOCAL_SESSIONS }: Props) {
  const isCodexEngine = executionEngine === "codex";
  const { t } = useI18n();
  // First client render must use the server snapshot clock; subsequent renders
  // resume local relative times after hydration.
  const [initialRenderTime, setInitialRenderTime] = useState<Date | undefined>(() => bootstrap ? new Date(bootstrap.renderedAt) : undefined);
  useEffect(() => { setInitialRenderTime(undefined); }, []);
  const [serverSessions, setAllSessions] = useState<SessionInfo[]>(() => bootstrap?.sessions ?? []);
  // Tags, pins and visibility belong to this sidebar. Refreshing decorations
  // must not masquerade as new server metadata and redraw the active chat.
  const [decorationRevision, setDecorationRevision] = useState(0);
  const allSessions = useMemo(() => mergeLocalSessions(serverSessions, localSessions), [serverSessions, localSessions]);
  // Tracked in a ref only: the version is compared against the polled value to
  // decide whether the list needs reloading, and no render reads it.
  const sessionListVersionRef = useRef<number | null>(bootstrap?.sessionListVersion ?? null);
  const sessionLoadIdRef = useRef(0);
  const sessionListLoadingRef = useRef(false);
  const [loading, setLoading] = useState(!bootstrap);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(() => {
    const sessions = bootstrap?.sessions ?? [];
    const requested = selectedCwdProp ?? initialCwd;
    return sessions.find((session) => session.id === initialSessionId)?.cwd
      ?? (requested && sessions.some((session) => session.cwd === requested) ? requested : null);
  });
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [projectFilter, setProjectFilter] = useState("");
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(() => loadLastCustomCwd(executionEngine));
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerKey, setExplorerKey] = useState(0);
  // The incoming value is a baseline; only later changes request a refresh.
  const previousExplorerRefreshKeyRef = useRef(explorerRefreshKey);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const sessionSearchActive = sessionSearchOpen && Boolean(sessionSearchQuery.trim());
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [explorerRefreshDone, setExplorerRefreshDone] = useState(false);
  const [fileManager, setFileManager] = useState<FileManagerAvailability | null>(null);
  const [fileManagerError, setFileManagerError] = useState<string | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set(bootstrap?.runningSessionIds ?? []));
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadHydrated, setUnreadHydrated] = useState(false);
  useEffect(() => {
    setUnreadSessionIds(loadUnreadSessionIds());
    setUnreadHydrated(true);
  }, []);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const [runningStatusHealthy, setRunningStatusHealthy] = useState(false);
  const completedReceiptIdsRef = useRef(new Set<string>());
  const detailsHydrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Virtualized session list: only the visible window of rows is mounted.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const explorerScrollRef = useRef<HTMLDivElement>(null);
  useScrollbarVisibility(listScrollRef);
  useScrollbarVisibility(explorerScrollRef, explorerOpen && Boolean(selectedCwdProp || selectedCwd));
  const sessionPaneRef = useRef<HTMLDivElement>(null);
  const explorerSectionRef = useRef<HTMLDivElement>(null);
  const sessionPaneHeightRef = useRef(SESSION_PANE_DEFAULT_HEIGHT);
  const getDefaultSessionPaneHeight = useCallback(() => {
    if (!explorerOpen) return SESSION_PANE_DEFAULT_HEIGHT;
    const paneHeight = sessionPaneRef.current?.getBoundingClientRect().height;
    const explorerHeight = explorerSectionRef.current?.getBoundingClientRect().height;
    return paneHeight && explorerHeight
      ? Math.round((paneHeight + explorerHeight) / 2)
      : SESSION_PANE_DEFAULT_HEIGHT;
  }, [explorerOpen]);
  const getMaxSessionPaneHeight = useCallback(() => {
    if (!explorerOpen || !(selectedCwdProp || selectedCwd)) return SESSION_PANE_MAX_HEIGHT;
    const paneHeight = sessionPaneRef.current?.getBoundingClientRect().height ?? SESSION_PANE_DEFAULT_HEIGHT;
    const explorerHeight = explorerSectionRef.current?.getBoundingClientRect().height ?? EXPLORER_PANE_MIN_HEIGHT;
    return Math.max(
      SESSION_PANE_MIN_HEIGHT,
      paneHeight + explorerHeight - EXPLORER_PANE_MIN_HEIGHT,
    );
  }, [explorerOpen, selectedCwd, selectedCwdProp]);
  const sessionPaneResizer = useResizablePanel({
    ariaLabel: t("layout.resizeSidebarSections"),
    axis: "vertical",
    cssVariable: "--sidebar-session-pane-height",
    defaultWidth: SESSION_PANE_DEFAULT_HEIGHT,
    getDefaultWidth: getDefaultSessionPaneHeight,
    getMaxWidth: getMaxSessionPaneHeight,
    growthDirection: "down",
    maxWidth: SESSION_PANE_MAX_HEIGHT,
    minWidth: SESSION_PANE_MIN_HEIGHT,
    storageKey: "pi-web:sidebar-session-pane-height",
    widthRef: sessionPaneHeightRef,
  });
  const [listViewportH, setListViewportH] = useState(0);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const listScrollRafRef = useRef<number | null>(null);
  const listScrollTopRef = useRef(0);
  const renderedListScrollTopRef = useRef(0);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    listScrollTopRef.current = e.currentTarget.scrollTop;
    if (listScrollRafRef.current != null) return;
    listScrollRafRef.current = requestAnimationFrame(() => {
      listScrollRafRef.current = null;
      const nextTop = Math.floor(listScrollTopRef.current / SESSION_LIST_ITEM_HEIGHT) * SESSION_LIST_ITEM_HEIGHT;
      if (renderedListScrollTopRef.current === nextTop) return;
      renderedListScrollTopRef.current = nextTop;
      setListScrollTop(nextTop);
    });
  }, []);
  useLayoutEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setListViewportH(entry.contentRect.height);
    });
    ro.observe(el);
    setListViewportH(el.clientHeight);
    listScrollTopRef.current = el.scrollTop;
    renderedListScrollTopRef.current = Math.floor(el.scrollTop / SESSION_LIST_ITEM_HEIGHT) * SESSION_LIST_ITEM_HEIGHT;
    setListScrollTop(renderedListScrollTopRef.current);
    return () => ro.disconnect();
  }, [sessionSearchActive]);

  const loadSessions = useCallback(async (showLoading = false, force = false, summary = false) => {
    const loadId = ++sessionLoadIdRef.current;
    sessionListLoadingRef.current = true;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(sessionListUrl(summary, force, executionEngine), {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        sessionListVersion: number;
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      // Status effects can run before React commits this catalogue. Publish to
      // the existing bridge ref now so an already listed running chat is not
      // mistaken for a missing chat and fetched a second time.
      sidebarBridgeStateRef.current.allSessions = data.sessions;
      setAllSessions(data.sessions);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
      }
      // Drop markers for deleted sessions and for subagents, whose completion
      // is intentionally silent even if an older client marked them unread.
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
    } catch (e) {
      if (loadId === sessionLoadIdRef.current) setError(String(e));
    } finally {
      if (loadId === sessionLoadIdRef.current) {
        sessionListLoadingRef.current = false;
        setLoading(false);
      }
    }
  }, [executionEngine]);

  const sidebarBridgeStateRef = useRef({
    loadSessions,
    allSessions,
    onSessionDeleted,
    unreadSessionIds,
  });
  sidebarBridgeStateRef.current = {
    loadSessions,
    allSessions,
    onSessionDeleted,
    unreadSessionIds,
  };

  useEffect(() => {
    return registerEnhancementSidebarBridge({
      refreshSessions: (showLoading = false, force = false) =>
        sidebarBridgeStateRef.current.loadSessions(showLoading, force),
      getRawSessions: () => sidebarBridgeStateRef.current.allSessions.filter((session) => !session.submissionPending),
      rerenderSessions: () => {
        setDecorationRevision((revision) => revision + 1);
      },
      notifySessionDeleted: (sessionId: string) => {
        sidebarBridgeStateRef.current.onSessionDeleted?.(sessionId);
      },
      setUnreadSession: (sessionId: string, isUnread: boolean) => {
        setUnreadSessionIds((prev) => {
          if (!sessionId) return prev;
          const shouldBeUnread = Boolean(isUnread);
          if (prev.has(sessionId) === shouldBeUnread) return prev;
          const next = new Set(prev);
          if (shouldBeUnread) next.add(sessionId);
          else next.delete(sessionId);
          return next;
        });
      },
      isSessionUnread: (sessionId: string) =>
        Boolean(sessionId && sidebarBridgeStateRef.current.unreadSessionIds.has(sessionId)),
    });
  }, []);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    let active = true;

    if (isFirst) {
      // Header/stat metadata is enough to select the URL session and paint the
      // sidebar. Hydrate exact counts, names, and first messages once the
      // selected chat has had a chance to start loading.
      const initialRead = bootstrap ? Promise.resolve() : loadSessions(true, false, true);
      void initialRead.then(() => {
        if (!active || executionEngine === "codex") return;
        detailsHydrationTimerRef.current = setTimeout(() => {
          detailsHydrationTimerRef.current = null;
          if (active) void loadSessions(false, true);
        }, SESSION_DETAILS_HYDRATION_DELAY_MS);
      });
    } else {
      void loadSessions(false, true);
    }

    return () => {
      active = false;
      if (detailsHydrationTimerRef.current) {
        clearTimeout(detailsHydrationTimerRef.current);
        detailsHydrationTimerRef.current = null;
      }
    };
  }, [loadSessions, refreshKey]);

  // Browser storage is unavailable during server rendering. Restore the panel
  // preference after hydration so a collapsed explorer stays collapsed on reload.
  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
  }, []);

  // Only the server can raise a file-manager window, and only when the browser
  // runs on that same machine. Ask it once so the button can pick the right
  // label (Explorer / Finder / generic) and disable itself when unavailable.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/open-in-explorer")
      .then((res) => res.ok ? res.json() as Promise<FileManagerAvailability> : null)
      .then((data) => { if (!cancelled && data) setFileManager(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // A failure belongs to the project it happened on.
  useEffect(() => {
    setFileManagerError(null);
  }, [selectedCwd, selectedCwdProp]);

  const openInFileManager = useCallback(async () => {
    const dir = selectedCwd ?? selectedCwdProp;
    if (!dir) return;
    try {
      const res = await fetch("/api/open-in-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: dir }),
      });
      if (res.ok) {
        setFileManagerError(null);
        return;
      }
      const data = await res.json().catch(() => ({})) as { error?: string };
      setFileManagerError(data.error ?? `HTTP ${res.status}`);
    } catch (error) {
      setFileManagerError(error instanceof Error ? error.message : String(error));
    }
  }, [selectedCwd, selectedCwdProp]);

  const fileManagerLabel = t(
    fileManager?.platform === "darwin"
      ? "sidebar.openInFinder"
      : fileManager?.platform === "win32"
        ? "sidebar.openInExplorer"
        : "sidebar.openInFileManager",
  );
  const fileManagerUnavailable = fileManager?.supported === false;
  const fileManagerErrorMessage = fileManagerError
    ? t(FILE_MANAGER_ERROR_KEYS[fileManagerError] ?? fileManagerError)
    : null;

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    if (unreadHydrated) saveUnreadSessionIds(unreadSessionIds);
  }, [unreadHydrated, unreadSessionIds]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    let refreshQueued = false;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(`pi-web-native-status-v1:${executionEngine}`) : null;
    let lastStamp: { epoch: string; revision: number } | null = null;
    const retiredEpochs = new Set<string>();
    const publish = (payload: unknown = null, catalog?: SessionInfo[]) => {
      const win = window as unknown as Record<string, unknown>;
      win.__PI_WEB_PROJECT_STATUS_SNAPSHOT__ = payload;
      window.dispatchEvent(new CustomEvent("pi-web-project-status", { detail: { payload, catalog } }));
    };
    const invalidateSnapshot = () => {
      // Missing task data is unknown, never a completion receipt.
      setRunningSessionIds(prev => prev.size ? new Set() : prev);
      completedReceiptIdsRef.current = new Set();
      publish();
    };
    const unavailable = () => {
      setRunningStatusHealthy(false);
      invalidateSnapshot();
    };
    const clearExpiry = () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
    };
    const armExpiry = () => {
      clearExpiry();
      // Native pickers/background tabs suspend polling; only visible time can
      // establish that a transport has stopped answering.
      if (!stopped && document.visibilityState === "visible") expiryTimer = setTimeout(unavailable, 12000);
    };
    const accept = (data: { runningSessionIds: string[]; completionNotificationSuppressedSessionIds?: string[];
      statusSnapshot?: { epoch: string; revision: number; executions: { state: string; sessionId: string }[] } }, broadcast = false, catalog?: SessionInfo[]) => {
      if (stopped || !Array.isArray(data.runningSessionIds) || data.runningSessionIds.some(id => typeof id !== "string")) return false;
      const stamp = data.statusSnapshot;
      if (stamp) {
        if (retiredEpochs.has(stamp.epoch) || lastStamp?.epoch === stamp.epoch && stamp.revision < lastStamp.revision) return false;
        if (lastStamp && lastStamp.epoch !== stamp.epoch) retiredEpochs.add(lastStamp.epoch);
        lastStamp = { epoch: stamp.epoch, revision: stamp.revision };
      }
      runningPollAuthoritativeRef.current = true;
      currentSuppressedCompletionSessionIdsRef.current = new Set(data.completionNotificationSuppressedSessionIds ?? []);
      completedReceiptIdsRef.current = new Set<string>((stamp?.executions ?? []).filter(item => item.state === "ended").map(item => item.sessionId));
      const nextIds = new Set<string>(data.runningSessionIds);
      setRunningSessionIds(prev => prev.size === nextIds.size && [...prev].every(id => nextIds.has(id)) ? prev : nextIds);
      setRunningStatusHealthy(true);
      publish(data, catalog);
      armExpiry();
      if (broadcast) channel?.postMessage({ payload: data, at: Date.now(), catalog: sidebarBridgeStateRef.current.allSessions.filter(session => !session.submissionPending) });
      return true;
    };
    if (channel) channel.onmessage = event => {
      if (event.data?.payload && Date.now() - event.data.at < 12000) accept(event.data.payload, false, event.data.catalog);
    };
    const schedule = () => {
      clearTimer();
      if (!stopped && document.visibilityState === "visible") timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };
    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      if (controller) { refreshQueued = true; return; }
      const current = new AbortController();
      controller = current;
      const timeout = setTimeout(() => current.abort(), 8000);
      try {
        const res = await fetch(`/api/agent/running?engine=${executionEngine}`, { cache: "no-store", signal: current.signal });
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) unavailable();
          throw new Error(`Task status HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!Array.isArray(data.runningSessionIds) || data.runningSessionIds.some((id: unknown) => typeof id !== "string")) throw new Error("Invalid running status");
        if (stopped || controller !== current || current.signal.aborted) return;
        accept(data, true);
        if (data.sessionListVersion !== sessionListVersionRef.current && !sessionListLoadingRef.current) void loadSessions();
      } catch {
        if (!stopped && controller === current && current.signal.reason !== "tab-hidden") {
          // Discard stale task indicators immediately, but let the existing
          // visible freshness deadline distinguish one failed read from outage.
          invalidateSnapshot();
        }
      } finally {
        clearTimeout(timeout);
        if (controller === current) controller = null;
        if (refreshQueued && !stopped) { refreshQueued = false; clearTimer(); void poll(); }
        else schedule();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        clearTimer();
        armExpiry();
        void poll();
      } else {
        clearTimer();
        clearExpiry();
        controller?.abort("tab-hidden");
      }
    };
    const win = window as unknown as Record<string, unknown>;
    win.__PI_WEB_REFRESH_PROJECT_STATUS__ = poll;
    window.dispatchEvent(new Event("pi-web-project-status-owner"));
    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      if (expiryTimer) clearTimeout(expiryTimer);
      channel?.close();
      if (win.__PI_WEB_REFRESH_PROJECT_STATUS__ === poll) {
        delete win.__PI_WEB_REFRESH_PROJECT_STATUS__;
        delete win.__PI_WEB_PROJECT_STATUS_SNAPSHOT__;
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadSessions]);

  useEffect(() => registerSessionPreloadBridge(), []);
  useEffect(() => {
    updateSessionPreloadCatalog(allSessions.filter((session) => !session.submissionPending), runningSessionIds, unreadSessionIds, selectedSessionId ?? null);
  }, [allSessions, runningSessionIds, unreadSessionIds, selectedSessionId]);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent("pi-web-session-catalog", { detail: { sessions: allSessions.filter(session => !session.submissionPending) } }));
  }, [allSessions]);

  useEffect(() => {
    onSessionsChange?.(serverSessions);
  }, [serverSessions, onSessionsChange]);

  useEffect(() => {
    if (!runningStatusHealthy) {
      previousRunningSessionIdsRef.current = new Set();
      return;
    }
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => completedReceiptIdsRef.current.has(id) && !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !sidebarBridgeStateRef.current.allSessions.some((session) => session.id === id),
    );
    if ((completedInBackground.length > 0 || hasUnlistedRunningSession) && !sessionListLoadingRef.current) {
      loadSessions(false, true);
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.();
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningStatusHealthy, runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

  useEffect(() => {
    const previousKey = previousExplorerRefreshKeyRef.current;
    previousExplorerRefreshKeyRef.current = explorerRefreshKey;
    if (
      previousKey !== undefined &&
      explorerRefreshKey !== undefined &&
      previousKey !== explorerRefreshKey
    ) {
      setExplorerKey((k) => k + 1);
    }
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch(`/api/home?engine=${executionEngine}`).then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, [executionEngine]);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    if (isCodexEngine) {
      if (worktreeState && (worktreeState.forCwd === cwd || worktreeState.worktrees.some((w) => w.path === cwd))) {
        return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
      }
      const match = allSessions.find(session => session.cwd === cwd || session.projectRoot === cwd);
      return projectSelection(match?.projectRoot ?? cwd, match ? workspaceKeyOf(match) : codexProjectKey(cwd));
    }
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [isCodexEngine, validatedProject, worktreeState, allSessions, projectSelection]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}&engine=${executionEngine}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
      });
    return () => { cancelled = true; };
  }, [executionEngine, selectedCwd, wtRefreshKey, refreshKey]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    // The directory can already be visible from the server snapshot. URL
    // session restoration must still run once after hydration.
    if (initialSessionId && !restoredRef.current) {
      restoredRef.current = true;
      const target = allSessions.find((s) => s.id === initialSessionId);
      if (target) {
        setSelectedCwd(target.cwd);
        onSelectSession(target, true);
        return;
      }
      onInitialRestoreDone?.();
    }
    if (selectedCwd === null) {
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession, onInitialRestoreDone]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path, engine: executionEngine }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      saveLastCustomCwd(data.cwd, executionEngine);
      setCustomPathValue(data.cwd);
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, executionEngine]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch(`/api/default-cwd?engine=${executionEngine}`, { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, [executionEngine]);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch, engine: executionEngine }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState, executionEngine]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    if (isCodexEngine) {
      setWtError("Codex 执行端不支持通过网页删除工作树，请在 WSL 终端中管理");
      return;
    }
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force, engine: executionEngine }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath, executionEngine, isCodexEngine]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setProjectFilter("");
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Clicking a session moves the effective cwd to that session's worktree.
  // Done on the click path (not via the selectedCwd prop sync) so it also
  // works when the prop value won't change — e.g. re-clicking the already
  // open session after manually switching worktrees.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    if (s.submissionPending) return;
    setAllSessions((current) => current.some((session) => session.id === s.id) ? current : [s, ...current]);
    if (s.cwd) setSelectedCwd(s.cwd);
    onSelectSession(s, false, entryId, blockIndex);
  }, [onSelectSession]);

  const handleUnavailableSearchSession = useCallback((sessionId: string) => {
    setAllSessions((current) => current.filter((session) => session.id !== sessionId));
    void loadSessions(false, true);
  }, [loadSessions]);

  const handleNewSession = useCallback(() => {
    const effectiveCwd = selectedCwd ?? selectedCwdProp ?? allSessions[0]?.cwd ?? (homeDir || null);
    if (!effectiveCwd) return;
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, effectiveCwd, executionEngine);
  }, [selectedCwd, selectedCwdProp, allSessions, homeDir, onNewSession, executionEngine]);

  const recentProjects = useMemo(() => getRecentProjects(allSessions), [allSessions]);
  const showProjectFilter = recentProjects.length > 8;
  const visibleProjects = useMemo(() => {
    const query = projectFilter.trim().toLowerCase();
    return query
      ? recentProjects.filter((project) => project.root.toLowerCase().includes(query))
      : recentProjects;
  }, [projectFilter, recentProjects]);

  // Sessions of every worktree in the selected project are shown together
  const selectedProject = useMemo(() => projectFor(selectedCwd), [projectFor, selectedCwd]);

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );

  // Any activity in a project other than the one currently selected — shown as
  // a dot on the (collapsed) selector button so it is visible without opening
  // the dropdown.
  const hasOtherWorkspaceActivity = useMemo(
    () => [...projectActivity.entries()].some(
      ([key, { running, unread }]) => key !== selectedProject?.key && (running > 0 || unread > 0),
    ),
    [projectActivity, selectedProject],
  );

  const currentProjectStatus = getEnhancementProjectActivity(selectedProject?.key ?? null);
  const otherProjectStatus = getEnhancementProjectActivity(selectedProject?.key ?? null, true);
  const selectorStatus = currentProjectStatus?.status ? currentProjectStatus : otherProjectStatus?.status ? otherProjectStatus : currentProjectStatus;
  const selectorStatusLabel = currentProjectStatus
    ? `当前工作区：${currentProjectStatus.label}；其他工作区：${otherProjectStatus?.label || "无运行或待回复任务"}`
    : t("sidebar.newActivity");

  const filteredSessions = useMemo(
    () => {
      if (!selectedProject) return allSessions;
      const projectIds = new Set(sessionsForProject(allSessions, selectedProject.key).map((session) => session.id));
      return allSessions.filter((session) => projectIds.has(session.id)
        || (session.submissionPending && session.cwd === selectedCwd));
    },
    [allSessions, selectedProject, selectedCwd],
  );
  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );
  const worktreeGuide = selectedCwd
    && worktreeState
    && selectedProject?.key === worktreeState.projectKey
    && !showWorktreeSwitcher
    ? (worktreeState.isGit
        ? {
             label: t("sidebar.openRepoRoot"),
             title: t("sidebar.openRepoRootTitle"),
          }
        : {
             label: t("sidebar.gitRepoRootOnly"),
             title: t("sidebar.gitRepoRootOnlyTitle"),
          })
    : null;
  const worktreeLoading = Boolean(selectedCwd && worktreeLoadingCwd === selectedCwd);
  const inactiveWorktreeSelector = worktreeGuide
    ?? (worktreeLoading && !showWorktreeSwitcher
      ? {
           label: t("sidebar.worktrees"),
           title: t("sidebar.checkingWorktrees"),
        }
      : null);

  const sessionFamilies = useMemo(
    () => processEnhancementSessionGroups(listSessionFamilies(filteredSessions)),
    [filteredSessions, decorationRevision],
  );

  const initialDecorations = bootstrap?.decorations?.state;
  const nativeHeights = sessionFamilies.map((family) => SESSION_LIST_ITEM_HEIGHT
    + (getEnhancementSessionTags(family.root.id, initialDecorations).length ? 18 : 0));
  const nativeTops: number[] = [0];
  for (const height of nativeHeights) nativeTops.push(nativeTops[nativeTops.length - 1] + height);
  const enhancedLayout = hasEnhancementSessionLayout();

  const virtualIndices = useMemo(() => getSessionListIndices(
    sessionFamilies.length,
    listScrollTop,
    listViewportH,
    sessionFamilies.findIndex((family) => family.root.id === focusedSessionId),
  ), [focusedSessionId, listScrollTop, listViewportH, sessionFamilies]);

  useEffect(() => {
    const shortcutsHost = sessionPaneResizer.panelRef.current?.nextElementSibling as HTMLElement | null;
    if (!shortcutsHost) return;
    shortcutsHost.setAttribute("data-pi-enh-shortcuts-host", "true");
    return registerEnhancementOpenSettings(
      createSidebarShortcutsFallbackHandler(shortcutsHost),
      { fallback: true },
    );
  }, [sessionPaneResizer.panelRef]);

  return (
    <div
      ref={sessionPaneResizer.panelRef}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        "--sidebar-session-pane-height": `${sessionPaneResizer.width}px`,
      } as CSSProperties}
    >
      {customPathOpen && (
        <DirectoryPicker
          executionEngine={executionEngine}
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}
      {/* Header */}
      <div
        style={{
          padding: "12px 10px 10px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div className="pi-native-sidebar-header-toolbar">
          <ExecutionEngineSwitcher engine={executionEngine} connected={runningStatusHealthy} codexEnabled={codexEnabled} onChange={onExecutionEngineChange} />
          <div className="pi-native-sidebar-header-actions">
            <button
              type="button"
              aria-label={t("sidebar.new")}
              onClick={handleNewSession}
              disabled={!selectedCwd}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: selectedCwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: selectedCwd ? "pointer" : "not-allowed",
                height: 32,
                width: 32,
                padding: 0,
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                letterSpacing: "-0.01em",
                flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
             title={selectedCwd ? t("sidebar.newSessionTitle", { path: selectedCwd }) : t("sidebar.selectProject")}
              onMouseEnter={(e) => {
                if (!selectedCwd) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = selectedCwd ? "var(--text-muted)" : "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
            </button>
            {(
              <button
                type="button"
                onClick={() => {
                  setSessionSearchOpen((open) => !open);
                  setWtDropdownOpen(false);
                }}
                title={t("sidebar.toggleSessionSearch")}
                aria-label={t("sidebar.toggleSessionSearch")}
                aria-expanded={sessionSearchOpen}
                aria-controls="session-search-input"
                className={`flex h-[32px] w-[32px] shrink-0 cursor-pointer items-center justify-center rounded-[7px] border border-border hover:bg-bg-selected focus-visible:outline-2 focus-visible:outline-accent ${sessionSearchOpen ? "bg-bg-selected text-accent" : "bg-bg-hover text-text-muted"}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
                </svg>
              </button>
            )}
          </div>
        </div>

        {/* CWD picker */}
        <div ref={dropdownRef} style={{ position: "relative" }}>
          <button data-pi-native-project-status="true" data-pi-enh-current-project={selectedProject?.key || ""}
            onClick={() => setDropdownOpen((v) => !v)}
            title={selectedProject?.root ?? selectedCwd ?? ""}
            data-current-cwd={selectedCwd ?? selectedCwdProp ?? ""}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              padding: "6px 10px",
              background: selectedCwd ? "var(--bg-hover)" : "rgba(37,99,235,0.06)",
              border: selectedCwd ? "1px solid var(--border)" : "1px solid rgba(37,99,235,0.4)",
              borderRadius: 7,
              cursor: "pointer",
              fontSize: 12,
              color: "var(--text)",
              textAlign: "left",
              transition: "border-color 0.15s, background 0.15s",
            }}
          >
            {selectedCwd ? (
              <PathLabel
                text={displayCwd(selectedProject?.root ?? selectedCwd, homeDir)}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text)",
                }}
              />
            ) : (
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                 {initialSessionId && !restoredRef.current ? "" : t("sidebar.selectProject")}
              </span>
            )}
            {selectorStatus?.status ? (
              <ProjectStatusDot activity={selectorStatus} label={selectorStatusLabel} />
            ) : !currentProjectStatus && hasOtherWorkspaceActivity ? (
              <span data-pi-native-project-status-dot="activity" title={t("sidebar.newActivity")} aria-label={t("sidebar.newActivity")}
                style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginLeft: 6, background: "var(--accent)" }} />
            ) : null}
          </button>

          <AnimatedDropdown
            open={dropdownOpen}
            style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              zIndex: 100,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
              overflow: "hidden",
            }}
          >
              {showProjectFilter && (
                <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                  <input
                    value={projectFilter}
                    onChange={(e) => setProjectFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setProjectFilter("");
                        setDropdownOpen(false);
                      }
                    }}
                     placeholder={t("sidebar.filterProjects")}
                    autoFocus
                    style={{
                      width: "100%",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      padding: "5px 8px",
                      border: "1px solid var(--border)",
                      borderRadius: 5,
                      outline: "none",
                      background: "var(--bg)",
                      color: "var(--text)",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}
              <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto" }}>
                {visibleProjects.map((project) => (
                  <button
                    key={project.key}
                    data-pi-native-project-status="true"
                    onClick={() => {
                      setSelectedCwd(project.root);
                      setProjectFilter("");
                      setCustomPathOpen(false);
                      setCustomPathError(null);
                      setDropdownOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      width: "100%",
                      padding: "8px 10px",
                      background: "var(--bg)",
                      border: "none",
                      borderBottom: "1px solid var(--border)",
                      color: project.key === selectedProject?.key ? "var(--text)" : "var(--text-muted)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 11,
                      fontFamily: "var(--font-mono)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={project.root}
                  >
                    {project.key === selectedProject?.key && (
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <polyline points="1.5 5 4 7.5 8.5 2.5" />
                      </svg>
                    )}
                    {project.key !== selectedProject?.key && <span style={{ width: 10, flexShrink: 0 }} />}
                    <PathLabel text={displayCwd(project.root, homeDir)} style={{ flex: 1 }} />
                    {getEnhancementProjectActivity(project.key)
                      ? <ProjectStatusBadges activity={getEnhancementProjectActivity(project.key)!} />
                      : showProjectActivity(projectActivity.get(project.key), t)}
                  </button>
                ))}
                {visibleProjects.length === 0 && projectFilter.trim() && (
                   <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingProjects")}</div>
                )}
              </div>

              {/* Default cwd shortcut */}
              {!customPathOpen && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleDefaultCwd(); }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    width: "100%",
                    padding: "8px 10px",
                    background: "none",
                    border: "none",
                    borderTop: visibleProjects.length > 0 ? "1px solid var(--border)" : "none",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 11,
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" />
                  </svg>
                   <span>{t("sidebar.useDefaultDirectory")}</span>
                </button>
              )}

              {/* Custom path directory picker */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleCustomPathClick();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  width: "100%",
                  padding: "8px 10px",
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  textAlign: "left",
                  fontSize: 11,
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                  <line x1="5" y1="1" x2="5" y2="9" />
                  <line x1="1" y1="5" x2="9" y2="5" />
                </svg>
                <span>{t("sidebar.customPath")}</span>
              </button>
          </AnimatedDropdown>
        </div>

        {sessionSearchOpen && (
          <input
            id="session-search-input"
            type="search"
            autoFocus
            value={sessionSearchQuery}
            maxLength={200}
            aria-label={t("sidebar.searchSessions")}
            placeholder={t("sidebar.searchSessions")}
            onChange={(event) => setSessionSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setSessionSearchQuery("");
              }
            }}
            className="mt-[6px] block h-[29px] w-full min-w-0 rounded-[7px] border border-border bg-bg px-[10px] text-xs text-text focus:outline-2 focus:outline-accent"
          />
        )}

        {/* Worktree switcher — shown only for git projects at a checkout top
            level (repo subdirs keep their own project identity, so switching
            from them would jump projects). Rendered whenever the selected cwd
            belongs to the loaded project (not just when forCwd matches), so
            switching between worktrees of one project keeps the row mounted
            instead of flickering while data refetches: all worktrees of a
            project share the same list anyway. */}
        {!sessionSearchOpen && showWorktreeSwitcher && (() => {
          if (!worktreeState) return null;
          const showWtFilter = worktreeState.worktrees.length >= 8;
          const visibleWorktrees = showWtFilter && wtFilter.trim()
            ? worktreeState.worktrees.filter((w) =>
                (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
            : worktreeState.worktrees;
          return (
            <div ref={wtDropdownRef} style={{ position: "relative", marginTop: 6 }}>
              <button
                onClick={() => setWtDropdownOpen((v) => !v)}
                 title={currentWorktree ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path }) : t("sidebar.switchWorktree")}
                style={{
                  width: "100%",
                  height: 29,
                  boxSizing: "border-box",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "0 10px",
                  background: "var(--bg-hover)",
                  border: "1px solid var(--border)",
                  borderRadius: 7,
                  cursor: "pointer",
                  fontSize: 11,
                  lineHeight: 1.35,
                  color: "var(--text-muted)",
                  textAlign: "left",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, color: currentWorktree && !currentWorktree.isMain ? "var(--accent)" : "var(--text-dim)" }}>
                  <line x1="6" y1="3" x2="6" y2="15" />
                  <circle cx="18" cy="6" r="3" />
                  <circle cx="6" cy="18" r="3" />
                  <path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <PathLabel
                  text={currentWorktree ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir)) : "…"}
                  style={{ flex: 1, fontFamily: "var(--font-mono)", color: "var(--text)" }}
                />
                {currentWorktree?.isMain && (
                   <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
                )}
                {worktreeState.worktrees.length > 1 && (
                  <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>
                    {worktreeState.worktrees.length}
                  </span>
                )}
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <polyline points="2 3.5 5 6.5 8 3.5" />
                </svg>
              </button>

              <AnimatedDropdown
                open={wtDropdownOpen}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  zIndex: 100,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 6px 20px rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                  {showWtFilter && (
                    <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
                      <input
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--border)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  )}
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktreePath;
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", borderBottom: "1px solid var(--border)", background: "rgba(239,68,68,0.06)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("sidebar.forceRemoveCheckout")}
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 5, color: "#fff", fontSize: 11, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.force")}
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
                              style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.cancel")}
                            </button>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={wt.path}
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--border)" }}
                        >
                          <button
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              display: "flex",
                              alignItems: "center",
                              gap: 7,
                              padding: "8px 10px",
                              background: "var(--bg)",
                              border: "none",
                              color: isCurrent ? "var(--text)" : "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left",
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                            }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                            {wt.isMain && <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>}
                          </button>
                          {!wt.isMain && !isCodexEngine && (
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
                               title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 34, height: 28, padding: 0, marginRight: 4,
                                background: "none", border: "none",
                                color: "var(--text-dim)", cursor: "pointer",
                                borderRadius: 5, flexShrink: 0,
                                transition: "color 0.12s, background 0.12s",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = "#ef4444"; e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-dim)"; e.currentTarget.style.background = "none"; }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={t("sidebar.createWorktreeTitle")}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        width: "100%",
                        padding: "8px 10px",
                        background: "none",
                        border: "none",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 11,
                      }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                       <span>{t("sidebar.newWorktree")}</span>
                    </button>
                  ) : (
                    <div style={{ padding: "6px 8px" }}>
                      <input
                        ref={wtNewInputRef}
                        value={wtNewBranch}
                        onChange={(e) => {
                          setWtNewBranch(e.target.value);
                          setWtError(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void handleCreateWorktree();
                          }
                          if (e.key === "Escape") {
                            setWtNewOpen(false);
                            setWtNewBranch("");
                            setWtError(null);
                          }
                        }}
                         placeholder={t("sidebar.branchName")}
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 5,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--accent)",
                            border: "none",
                            borderRadius: 5,
                            color: "var(--accent-contrast)",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 5,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                           {t("sidebar.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
              </AnimatedDropdown>
            </div>
          );
        })()}
        {!sessionSearchOpen && inactiveWorktreeSelector && (
          <button
            type="button"
            aria-disabled="true"
            tabIndex={-1}
            title={inactiveWorktreeSelector.title}
            style={{
              width: "100%",
              height: 29,
              boxSizing: "border-box",
              marginTop: 6,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "0 10px",
              border: "1px solid var(--border)",
              borderRadius: 7,
              background: "var(--bg-hover)",
              color: "var(--text-dim)",
              fontSize: 11,
              lineHeight: 1.35,
              whiteSpace: "nowrap",
              textAlign: "left",
              cursor: "default",
              opacity: 0.82,
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{inactiveWorktreeSelector.label}</span>
          </button>
        )}
      </div>

      {/* Session list */}
      <div
        ref={sessionPaneRef}
        style={{
          display: "flex",
          flexDirection: "column",
          flex: explorerOpen && (selectedCwdProp || selectedCwd)
            ? "0 1 var(--sidebar-session-pane-height, 320px)"
            : "1 1 auto",
          minHeight: SESSION_PANE_MIN_HEIGHT,
          overflow: "hidden",
        }}
      >
        {error && <div role="status" data-pi-catalog-stale="true" title={error} style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>
          {t(allSessions.length ? "sidebar.catalogStale" : "sidebar.catalogReadFailed")}
        </div>}
        <SessionSearch executionEngine={executionEngine} open={sessionSearchOpen} query={sessionSearchQuery} sessions={allSessions} selectedSessionId={selectedSessionId} onSelectSession={handleSelectSessionFromList} onUnavailableSession={handleUnavailableSearchSession}>
        <div
          ref={listScrollRef}
          onScroll={handleListScroll}
          className="scrollbar-subtle"
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            overflowY: "auto",
            padding: "0",
          }}
        >
        {loading && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.loading")}
          </div>
        )}
        {!loading && !error && sessionFamilies.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>
            {t("sidebar.noSessions")}
          </div>
        )}
        {sessionFamilies.length > 0 && (
          <div
            style={{
              position: "relative",
              height: enhancedLayout ? sessionFamilies.length * SESSION_LIST_ITEM_HEIGHT + getEnhancementSessionHeadersHeight(sessionFamilies) : nativeTops[nativeTops.length - 1],
            }}
          >
            {virtualIndices.map((index) => {
              const family = sessionFamilies[index];
              const familySessions = [family.root, ...family.subagents];
              const displaySession = family.latestModified === family.root.modified
                ? family.root
                : { ...family.root, modified: family.latestModified };
              // Bubble blur after the input's save handler before unpinning the row.
              return (
                <div
                  key={family.root.id}
                  onFocus={() => setFocusedSessionId(family.root.id)}
                  onBlur={() => setFocusedSessionId(null)}
                  style={{
                    position: "absolute",
                    top: enhancedLayout ? getEnhancementSessionItemTop(index, sessionFamilies, SESSION_LIST_ITEM_HEIGHT) : nativeTops[index],
                    left: 0,
                    right: 0,
                  }}
                >
                  <SessionItem
                    initialRenderTime={initialRenderTime}
                    initialDecorations={initialDecorations}
                    executionEngine={executionEngine}
                    session={displaySession}
                    isSelected={familySessions.some((session) => session.id === selectedSessionId)}
                    isRunning={familySessions.some((session) => runningSessionIds.has(session.id))}
                    isUnread={familySessions.some((session) => unreadSessionIds.has(session.id))}
                    onClick={() => handleSelectSessionFromList(family.root)}
                    onRenamed={loadSessions}
                  />
                </div>
              );
            })}
          </div>
        )}
        </div>
        </SessionSearch>
      </div>

      {explorerOpen && (selectedCwdProp || selectedCwd) && (
        <div
          className={`sidebar-section-resize-handle${sessionPaneResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar-sections"
          title={`${t("layout.resizeSidebarSections")}: ${t("layout.resizeHeightHint")}`}
          style={{
            position: "relative",
            zIndex: 20,
            width: "100%",
            height: 12,
            margin: "-6px 0",
            flex: "0 0 12px",
            cursor: "row-resize",
            touchAction: "none",
          }}
          {...sessionPaneResizer.separatorProps}
        />
      )}

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          ref={explorerSectionRef}
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: explorerOpen ? EXPLORER_PANE_MIN_HEIGHT : 0,
            overflow: "hidden",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
            <button
              onClick={() => setExplorerOpen((open) => {
                const next = !open;
                saveExplorerOpen(next);
                return next;
              })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flex: 1,
                padding: "6px 10px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.05em",
                textTransform: "uppercase",
                textAlign: "left",
              }}
            >
              <svg
                width="9" height="9" viewBox="0 0 10 10" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
                style={{ transform: explorerOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s", flexShrink: 0 }}
              >
                <polyline points="3 2 7 5 3 8" />
              </svg>
              {t("files.explorer")}
            </button>
            <ToolbarIconButton
              onClick={() => { void openInFileManager(); }}
              disabled={fileManagerUnavailable}
              title={fileManagerUnavailable
                ? t(fileManager?.reason === "remote" ? "sidebar.openInExplorerRemoteOnly" : "sidebar.openInExplorerUnsupported")
                : fileManagerLabel}
              color="var(--text-dim)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 8a2 2 0 0 1 2-2h3.4l1.9 1.9H19a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              </svg>
            </ToolbarIconButton>
            {onOpenTerminal && (
              <ToolbarIconButton
                onClick={() => onOpenTerminal(selectedCwd ?? selectedCwdProp!)}
                title={t("terminal.open")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                ariaPressed={!changesCollapsed}
                color={changesCollapsed ? "var(--text-dim)" : "var(--accent)"}
                background={changesCollapsed ? "none" : "var(--bg-selected)"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M3 12h6" />
                  <path d="M15 12h6" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => {
                  setFileSearchOpen((open) => !open);
                }}
                title={t("sidebar.searchFiles")}
                ariaPressed={fileSearchOpen}
                color={fileSearchOpen ? "var(--accent)" : "var(--text-dim)"}
                background={fileSearchOpen ? "var(--bg-selected)" : "none"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-dim)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
                setExplorerRefreshDone(true);
                if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
                explorerRefreshTimerRef.current = setTimeout(() => setExplorerRefreshDone(false), 2000);
              }}
              title={t("sidebar.refreshExplorer")}
              skipHover={explorerRefreshDone}
              color={explorerRefreshDone ? "#4ade80" : "var(--text-dim)"}
              background={explorerRefreshDone ? "rgba(74,222,128,0.18)" : "none"}
              marginRight={6}
            >
              {explorerRefreshDone ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </ToolbarIconButton>
          </div>
          {fileManagerErrorMessage && (
            <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "0 10px 6px", fontSize: 10, lineHeight: 1.35, color: "#f87171" }}>
              <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{fileManagerErrorMessage}</span>
              <DismissButton onClick={() => setFileManagerError(null)} title={t("files.dismissError")} />
            </div>
          )}
          {explorerOpen && (
            <div ref={explorerScrollRef} className="scrollbar-subtle" style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                sessionId={selectedSessionId}
                executionEngine={executionEngine}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.agentRunning")}
      aria-label={t("sidebar.agentRunning")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <g>
          <path
            d="M21 12a9 9 0 1 1-3.8-7.4"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 12 12"
            to="360 12 12"
            dur="0.9s"
            repeatCount="indefinite"
          />
        </g>
      </svg>
    </span>
  );
}

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "#0891b2",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="7" cy="7" r="2.5" fill="currentColor" />
        {/* Unread is a persistent state, not ongoing work. Animating SVG radius
            invalidates the whole document's layout every frame while idle. */}
        <circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="1.4" opacity="0.32" />
      </svg>
    </span>
  );
}

/**
 * Compact per-project activity badges for the workspace selector dropdown items:
 * a spinning running icon + count and an unread dot + count. Renders nothing
 * when the project has no activity. Counts share the accent / unread colors of
 * the per-session indicators so the two stay visually consistent.
 */
function ProjectStatusDot({ activity, label = activity.label }: { activity: EnhancementProjectActivity; label?: string }) {
  const color = { attention: "#f59e0b", interrupted: "#f87171", running: "#60a5fa", unknown: "#a1a1aa" }[activity.status || "unknown"];
  return <span data-pi-native-project-status-dot={activity.status || undefined} title={label} aria-label={label}
    style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, marginLeft: 6, background: color }} />;
}
function ProjectStatusBadges({ activity }: { activity: EnhancementProjectActivity }) {
  if (!activity.status) return null;
  return <span title={activity.label} aria-label={activity.label} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, marginLeft: 6 }}>
    <ProjectStatusDot activity={activity} />{activity.label}
  </span>;
}

function showProjectActivity(
  activity: { running: number; unread: number } | undefined,
  t: (key: string) => string,
): ReactNode {
  if (!activity || (activity.running === 0 && activity.unread === 0)) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, marginLeft: 6 }}>
      {activity.running > 0 && (
        <span
          title={t("sidebar.agentRunning")}
          aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "var(--accent)", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ display: "block" }}>
            <g>
              <path d="M21 12a9 9 0 1 1-3.8-7.4" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
              <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
            </g>
          </svg>
          {activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span
          title={t("sidebar.newSessionActivity")}
          aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`}
          style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#0891b2", fontSize: 10, fontFamily: "var(--font-mono)" }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
          {activity.unread}
        </span>
      )}
    </span>
  );
}

function SessionItem({
  initialRenderTime,
  initialDecorations,
  executionEngine,
  session,
  isSelected,
  isRunning,
  isUnread,
  onClick,
  onRenamed,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  initialRenderTime?: Date;
  initialDecorations?: import("@/lib/enhancement-state-store.cjs").EnhancementDurableState;
  executionEngine: "pi" | "codex";
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  onClick: () => void;
  onRenamed?: () => void;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { locale, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const rowRef = useRef<HTMLDivElement>(null);
  const renameActiveRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Select only after React has mounted the input.
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  // A stored first message may be an SDK-expanded <skill> block; collapse it
  // back to the compact /skill:name args command the user typed before using
  // it as the auto-name fallback, mirroring MessageView's rendering.
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = session.name || displayFirstMessage.slice(0, 50) || session.id.slice(0, 12);

  const startRename = useCallback(() => {
    if (session.transient || session.submissionPending) return false;
    if (renameActiveRef.current) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return true;
    }
    renameActiveRef.current = true;
    setRenameValue(title);
    setRenaming(true);
    return true;
  }, [session.transient, session.submissionPending, title]);

  // The menu requests an action; React alone owns the editor and its lifecycle.
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const rename = (event: Event) => {
      if (startRename()) event.preventDefault();
    };
    row.addEventListener(SESSION_ROW_RENAME_EVENT, rename);
    return () => row.removeEventListener(SESSION_ROW_RENAME_EVENT, rename);
  }, [startRename]);

  const cancelRename = useCallback(() => {
    renameActiveRef.current = false;
    setRenaming(false);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renameActiveRef.current) return;
    renameActiveRef.current = false;
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed displayFirstMessage, so an untouched rename of
    // a skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "重命名未保存");
      onRenamed?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "重命名未保存");
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const openContextMenu = useCallback((clientX: number, clientY: number) => {
    return dispatchSessionRowContextMenu({
      executionEngine,
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX,
      clientY,
      refresh: () => { onRenamed?.(); },
    });
  }, [executionEngine, onRenamed, session.cwd, session.id, session.name, session.path]);

  const contextMenu = useTouchContextMenu(openContextMenu, !renaming && !session.submissionPending);
  const handleContextMenu = contextMenu.onContextMenu;

  const taskStatus = getEnhancementSessionStatus(session.id);
  const rowStatus = taskStatus?.status === "completed" && !taskStatus.unread ? undefined : taskStatus?.status;
  const tags = getEnhancementSessionTags(session.id, initialDecorations);
  const showTags = !renaming && tags.length > 0;
  const odooAddons = getEnhancementSessionOdooAddons(session.id);
  const showOdooAddons = !renaming && odooAddons.length > 0;

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <div
      ref={rowRef}
      data-pi-enh-editing={renaming ? "true" : undefined}
      data-pi-enh-session-id={session.id}
      data-execution-engine={executionEngine}
      data-pi-native-session-tags="true"
      data-pi-native-project-status="true"
      data-pi-enh-project-status={rowStatus && rowStatus !== "idle" ? rowStatus : undefined}
      data-pi-enh-completed-unread={rowStatus === "completed" ? String(taskStatus?.unread) : undefined}
      data-pi-enh-has-tags={showTags ? "true" : undefined}
      data-pi-enh-has-odoo-addons={showOdooAddons ? "true" : undefined}
      className={`pi-enh-session-row-host${rowStatus === "attention" ? " pi-enh-session-needs-attention" : ""}`}
      aria-disabled={session.submissionPending || undefined}
      onClick={renaming || session.submissionPending ? undefined : onClick}
      {...contextMenu}
      onContextMenu={renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: getEnhancementSessionItemHeight(session.id, SESSION_LIST_ITEM_HEIGHT + (tags.length ? 18 : 0)),
        display: "flex",
        alignItems: "center",
        paddingLeft: depth > 0 ? depth * 12 + 14 : 14,
        paddingRight: 8,
        cursor: renaming || session.submissionPending ? "default" : "pointer",
        background: isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderLeft: isSelected ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "background 0.1s",
        gap: 6,
        overflow: "hidden",
      }}
    >
      {renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
            if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
          }}
          autoFocus
          style={{
            flex: 1,
            fontSize: 12,
            padding: "5px 8px",
            border: "1px solid var(--accent)",
            borderRadius: 5,
            outline: "none",
            background: "var(--bg)",
            color: "var(--text)",
            height: 30,
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Subagent indicator for child sessions */}
          {depth > 0 && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="5" y="7" width="14" height="11" rx="2" />
              <path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" />
            </svg>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 12,
                fontWeight: isSelected ? 500 : 400,
                lineHeight: 1.4,
                color: "var(--text)",
              }}
              title={title}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
            </div>
            <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 8, color: "var(--text-dim)", fontSize: 11, minWidth: 0 }}>
              {rowStatus === "unknown" ? (
                <span title="服务端任务状态暂不可确认">状态待确认</span>
              ) : rowStatus === "attention" ? (
                <span title="等待你的回复" style={{ color: "#f59e0b" }}>待回复</span>
              ) : rowStatus === "interrupted" ? (
                <span title="本轮任务异常停止，点击会话查看具体错误" style={{ color: "#f87171", fontWeight: 600 }}>异常停止</span>
              ) : (taskStatus ? rowStatus === "running" : isRunning) ? (
                <RunningSessionIndicator />
              ) : isUnread ? (
                <UnreadSessionIndicator />
              ) : (
                <span title={session.modified}>{formatRelativeTime(session.modified, locale, initialRenderTime)}</span>
              )}
              <span>
                {session.detailsPending ? "…" : t("sidebar.messagesCount", { count: session.messageCount })}
              </span>
              {session.isWorktree && session.branch && (
                <span
                  title={`Worktree: ${session.cwd}`}
                  style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--accent)", minWidth: 0, overflow: "hidden" }}
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session.branch}</span>
                </span>
              )}
            </div>
            {showTags && (
              <div className="pi-enh-session-tags-row">
                {tags.slice(0, 2).map((tag) => {
                  const color = tag.color || "#9ca3af";
                  return <span key={tag.id} className="pi-enh-session-tag-pill" title={tag.name}
                    style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 35%, transparent)` }}>
                    <span className="pi-enh-tag-dot" style={{ background: color }} />
                    <span className="pi-enh-tag-name">{tag.name}</span>
                  </span>;
                })}
                {tags.length > 2 && <span className="pi-enh-session-tag-pill pi-enh-session-tag-more"
                  style={{ color: "#9ca3af", background: "rgba(156,163,175,0.16)", border: "1px solid rgba(156,163,175,0.35)" }}
                  title={`全部标签：${tags.map((tag) => tag.name).join("、")}`}>+{tags.length - 2}</span>}
              </div>
            )}
          </div>

          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={t(collapsed ? "sidebar.expandSubagents" : "sidebar.collapseSubagents")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}


          {showOdooAddons && (
            <div className="pi-enh-session-odoo-addons">
              {odooAddons.map((addon) => (
                <div className="pi-enh-odoo-addon-row" key={addon.technical}>
                  <span
                    className={`pi-enh-odoo-addon-pill${addon.isLatest ? " is-latest" : ""}`}
                    data-pi-enh-latest={addon.isLatest ? "true" : "false"}
                    title={`${addon.technical} · ${addon.status}${addon.isLatest ? " · 最新实际更新会话" : ""}`}
                    aria-label={`${addon.technical}${addon.isLatest ? "（最新实际更新会话）" : ""}`}
                  >
                    <span className="pi-enh-odoo-addon-dot" aria-hidden="true" />
                    <span className="pi-enh-odoo-addon-name">{addon.technical}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
