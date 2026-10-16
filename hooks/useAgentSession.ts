"use client";

import { useState, useCallback, useRef, useEffect, useEffectEvent, useLayoutEffect, useMemo, useReducer, useSyncExternalStore } from "react";
import type {
  AgentMessage,
  BlockingExtensionUiRequest,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { completeActiveToolResult } from "@/lib/tool-public-status";
import { normalizeToolCalls } from "@/lib/normalize";
import { acknowledgeRecalledPrompts, isPromptRejectedError, readPromptReceipt, isPromptSubmissionDispatching, sendAgentCommand } from "@/lib/agent-client";
import { getPendingPromptSubmissions, markPromptSubmissionsRecalled, reconcilePromptSubmission, mergeServerPromptSubmissions, getServerPendingPromptSubmissions, subscribePendingPromptSubmissions, releasePromptSubmission, type PendingPromptSubmission, type PromptSubmissionPreviewIdentity } from "@/lib/prompt-submissions";
import {
  clearSessionViewCache,
  deleteSessionViewSnapshot,
  deleteSessionWireBaseline,
  getSessionViewSnapshot,
  getSessionWireBaseline,
  setSessionViewSnapshot,
  setSessionWireBaseline,
} from "@/lib/session-view-cache";
import {
  buildSessionSyncUrl,
  bumpSessionEpoch,
  getSessionEpoch,
  isEpochFresh,
  isSessionMemoryCacheEnabled,
  invalidatesSessionHistory,
  reconcileSyncResponse,
  preserveLoadedHistoryPrefix,
  viewMatchesBaseline,
} from "@/lib/session-sync-client";
import { fetchHistoryPageContext } from "@/lib/session-history-page-client";
import { isSessionResidentFresh, markSessionResidentFresh, waitForSessionPreload } from "@/lib/session-preload";
import { clampModelThinkingLevel } from "@/lib/model-thinking-level";
import { readSessionWireDisk } from "@/lib/session-sync-storage";
import { clearDraft, rekeyDraft, restoreDraftSubmission } from "@/lib/draft-store";
import { getPreferredToolPreset, setPreferredToolPreset } from "@/lib/tool-preset-preference";
import { CONFIGURED_TOOL_PRESET, getPresetFromToolNames, getToolNamesForPreset, type ToolEntry, type ToolPreset } from "@/lib/tool-presets";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { mergeSessionStats, type SessionFileStats } from "@/lib/session-stats";
import { bindUserMessageIdentity, bindUserHistoryIdentities, reconcileDeliveredUserEntry, reconcileUserReceipt, preservePendingUserMessage, type OptimisticUserMessage } from "@/lib/prompt-recovery";
import { waitForPromptPreparation } from "@/lib/prompt-preparation";
import { AgentEventConnection } from "@/lib/agent-event-connection";
import { isNestedToolExecutionEvent, isSystemMessageEvent } from "@/lib/agent-event-wire";
import { markLatestAssistantRetryAttempt } from "@/lib/message-display";
import { getToolExecutionProgress } from "@/lib/tool-execution-progress";
import { CODEMODE_TOOL_NAME, getCodemodeProgress } from "@/lib/codemode-view";
import { updateExtensionWidgets } from "@/lib/extension-widgets";
import { bareMcpOpensSettings } from "@/lib/mcp-command";
import type { SettingsSection } from "@/lib/settings-navigation";
import {
  enqueueExtensionUiRequest,
  removeExtensionUiRequest,
  retainExtensionUiRequests,
  upsertExtensionUiRequest,
} from "@/lib/extension-ui-queue";
import {
  CHAT_SCROLL_REATTACH_TOLERANCE,
  CHAT_SCROLL_TAIL_TOLERANCE,
  getLiveFollowAttached,
  shouldShowScrollToLatest,
} from "@/lib/chat-lazy-load";
import {
  INITIAL_STREAMING_STATE,
  streamReducer,
  type ClientAssistantMessageEvent,
} from "@/lib/streaming-message";
import {
  getEnhancementWindow,
  registerSessionReloadAliases,
} from "@/lib/enhancement-chat-bridge";
import { recallSessionQueue } from "@/lib/queue-recall-client";
import { pendingSessionInfo } from "@/lib/session-catalog-client";
import { admitNativeNotification, isNativeNotificationEnabled, NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT } from "@/lib/native-notifications";

export interface SessionData {
  sessionId: string;
  promptEntryIds?: Record<string, string>;
  filePath: string;
  totalActiveMs: number;
  tree: SessionTreeNode[];
  leafId: string | null;
  toolNames?: string[];
  /** Opaque freshness token for the session view cache (summary tree reads). */
  snapshotRevision?: string | null;
  /** "summary" when `tree` carries the body-free navigation format. */
  treeFormat?: "summary";
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    oldestEntryId: string | null;
    hasMore: boolean;
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
  };
  /** Cumulative usage over ALL session-file entries (incl. compacted history). */
  stats?: SessionFileStats;
  /** True when GET ?force=1 dropped a stale live wrapper and rebuilt from disk. */
  wrapperRebuilt?: boolean;
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  model?: { provider: string; id: string };
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
};

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

type ExtensionUiDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "refilter" }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "stopping" }
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; progress?: string }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo?: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; action?: "openSessionStats" | "openSettings" };

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  onAgentEnd?: () => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionSubmissionChange?: (sourceDraftKey: string, session: SessionInfo | null) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked: boolean) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  /** Registers an action that lazily starts the session and loads its prompt and tools. */
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Opens Settings on a section; a bare `/mcp` the built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  setToolPreset?: (preset: ToolPreset) => void;
  deferInitialScroll?: boolean;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ConcreteThinkingLevel = Exclude<ThinkingLevelOption, "auto">;

function asConcreteThinkingLevel(value?: string | null): ConcreteThinkingLevel | null {
  if (!value || value === "auto") return null;
  return value as ConcreteThinkingLevel;
}

export function isAbortError(e: unknown): boolean {
  if (!e) return false;
  if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") {
    return true;
  }
  if (typeof e === "object" && e !== null && "name" in e && (e as { name: unknown }).name === "AbortError") {
    return true;
  }
  return false;
}

const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_READY_TIMEOUT_MS = 60_000;
const EVENT_STREAM_RECONNECT_DELAY_MS = 1_000;
const SESSION_LEASE_RENEW_INTERVAL_MS = 30_000;
// Retry temporary model-list failures without requiring a page refresh.
const MODELS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "refilter": {
      const enabled = (notice: NoticeItem) => isNativeNotificationEnabled(notice.message, notice.type);
      return fillPendingNotices(state.visible.filter(enabled), state.pending.filter(enabled));
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  replaceMessage: (message: UserMessage) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: Array<{ data: string; mimeType: string }>, targetDraftKey?: string) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  defaultThinkingLevel?: string | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

function getResidentSessionData(sessionId: string): SessionData | null {
  if (!isSessionMemoryCacheEnabled()) return null;
  const cached = getSessionViewSnapshot(sessionId);
  if (!cached) return null;
  const exact = cached.livePreview ? cached.data : getSessionWireBaseline(sessionId)?.data ?? cached.data;
        const preview: SessionData = {
          ...exact,
          sessionId: sessionId,
          filePath: exact?.filePath ?? "",
          snapshotRevision: cached.revision,
          treeFormat: "summary",
          totalActiveMs: cached.totalActiveMs ?? 0,
          tree: cached.summaryTree as SessionData["tree"],
          leafId: cached.leafId,
          context: {
            messages: cached.messages,
            entryIds: cached.entryIds,
            oldestEntryId: cached.oldestEntryId,
            hasMore: cached.hasMore,
            thinkingLevel: cached.thinkingLevel,
            model: cached.model,
          },
          stats: cached.stats as SessionData["stats"],
        };
  return preview;
}

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, newSessionDraftKey, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionSubmissionChange, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    onOpenSettings,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;

  const [data, setData] = useState<SessionData | null>(() => session ? getResidentSessionData(session.id) : null);
  const [loading, setLoading] = useState(!isNew && !data);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(data?.leafId ?? null);
  const [messages, setMessages] = useState<AgentMessage[]>(data?.context.messages ?? []);
  const [activeToolResults, setActiveToolResults] = useState<Map<string, ToolResultMessage>>(new Map());
  const [entryIds, setEntryIds] = useState<string[]>(data?.context.entryIds ?? []);
  const [historyCursor, setHistoryCursor] = useState<string | null>(data?.context.oldestEntryId ?? null);
  const [hasEarlierMessages, setHasEarlierMessages] = useState(data?.context.hasMore ?? false);
  const [streamState, dispatch] = useReducer(streamReducer, INITIAL_STREAMING_STATE);
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<ToolPreset>(CONFIGURED_TOOL_PRESET);
  const [newSessionThinkingLevel, setNewSessionThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [newSessionDefaultThinkingLevel, setNewSessionDefaultThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [currentThinkingOverride, setCurrentThinkingOverride] = useState<ConcreteThinkingLevel | null>(null);
  const [liveThinkingLevel, setLiveThinkingLevel] = useState<ConcreteThinkingLevel | null>(null);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [liveModel, setLiveModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [autoCompactionEnabled, setAutoCompactionEnabled] = useState(true);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const preparationRef = useRef<AbortController | null>(null);
  const stopInFlightRef = useRef<Promise<void> | null>(null);
  useEffect(() => { setStopRequested(false); }, [session?.id]);
  useEffect(() => {
    if (!agentRunning && !bashRunning) setStopRequested(false);
  }, [agentRunning, bashRunning]);
  const [promptAnchorActive, setPromptAnchorActive] = useState(false);
  const [promptScrollRevision, setPromptScrollRevision] = useState(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialogs, setExtensionDialogs] = useState<ExtensionUiDialogRequest[]>([]);
  const [extensionCustomUis, setExtensionCustomUis] = useState<ExtensionUiCustomRequest[]>([]);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const pendingSubmissions = useSyncExternalStore(subscribePendingPromptSubmissions, getPendingPromptSubmissions, getServerPendingPromptSubmissions);

  const eventConnectionRef = useRef<AgentEventConnection | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  const unconfirmedSubmissions = useMemo(() => pendingSubmissions.filter((row) => row.sessionId === (session?.id ?? sessionIdRef.current)), [pendingSubmissions, session?.id]);
  const sessionPropIdRef = useRef<string | null>(session?.id ?? null);
  // False while the session carries no tool selection of its own, so its loadout
  // follows settings.json defaultTools and the picker must say so rather than
  // labelling it with whichever preset the resolved tools happen to match.
  const sessionToolsPinnedRef = useRef(false);
  const agentRunningRef = useRef(false);
  // Lifecycle events outrank state snapshots already in flight.
  const agentStateRevisionRef = useRef(0);
  const extensionUiRevisionRef = useRef(0);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  const initialScrollDoneRef = useRef(Boolean(opts.deferInitialScroll));
  const lastUserMsgRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToUserRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const previousScrollTopRef = useRef(0);
  const liveFollowFrameRef = useRef<number | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  // The command list as last loaded, and the get_commands request under way, if
  // any. A bare /mcp reads them to tell whose /mcp it is (handleBuiltinSlashCommand).
  // The generation moves on with every request and every clear, and only a request
  // still current writes its answer: one that set_tools outdated (or a newer request)
  // would otherwise put back the list of a session that is no longer there.
  const slashCommandsRef = useRef<SlashCommandInfo[]>([]);
  const slashCommandsLoadRef = useRef<Promise<SlashCommandInfo[] | null> | null>(null);
  const slashCommandsGenerationRef = useRef(0);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const thinkingLevelOverrideRef = useRef<ConcreteThinkingLevel | null>(null);
  const thinkingLevelPinsRef = useRef<Record<string, string>>({});
  const defaultThinkingLevelRef = useRef<ConcreteThinkingLevel | null>(null);
  const promptRunIdRef = useRef(0);
  const optimisticUserMessageRef = useRef<OptimisticUserMessage | null>(null);
  const modelSwitchPendingRef = useRef(false);
  const draftKeyAliasesRef = useRef(new Map<string, string>());
  const sessionHookMountedRef = useRef(true);
  // In-flight session reads, keyed by session id (or force:<id> for fresh reads).
  const loadFlightsRef = useRef(new Map<string, Promise<unknown>>());
  const latestLoadRequestRef = useRef<object | null>(null);
  // Latest settled view state, readable from the unmount cleanup without
  // re-subscribing it. Assigned every render like sessionPropIdRef below.
  const dataRef = useRef<SessionData | null>(null);
  const messagesRef = useRef<AgentMessage[]>([]);
  const entryIdsRef = useRef<string[]>([]);
  const activeLeafIdRef = useRef<string | null>(null);
  const historyCursorRef = useRef<string | null>(null);
  const hasEarlierMessagesRef = useRef(false);

  sessionPropIdRef.current = session?.id ?? null;
  dataRef.current = data;
  messagesRef.current = messages;
  entryIdsRef.current = entryIds;
  activeLeafIdRef.current = activeLeafId;
  historyCursorRef.current = historyCursor;
  hasEarlierMessagesRef.current = hasEarlierMessages;

  if (!eventConnectionRef.current) {
    eventConnectionRef.current = new AgentEventConnection({
      createSource: (sid) => new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`),
      onEvent: (event) => handleAgentEventRef.current?.(event as AgentEvent),
      shouldMaintain: (sid) => (
        sessionHookMountedRef.current
        && sessionIdRef.current === sid
        && (
          agentRunningRef.current
          || eventStreamGraceActiveRef.current
          || sessionPropIdRef.current === sid
        )
      ),
      readinessTimeoutMs: EVENT_STREAM_READY_TIMEOUT_MS,
      reconnectDelayMs: EVENT_STREAM_RECONNECT_DELAY_MS,
      onUnexpectedError: (error) => {
        console.error("Failed to maintain the agent event stream:", error);
      },
    });
  }

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;
  const existingSessionId = session?.id;

  useLayoutEffect(() => {
    if (!existingSessionId && (!isNew || sessionIdRef.current)) return;
    setToolPresetState(getPreferredToolPreset());
  }, [existingSessionId, isNew, setToolPresetState]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const container = scrollContainerRef.current;
    if (!container) return;
    // Scroll the chat container itself instead of scrolling a sentinel element
    // into view: that propagates to every scrollable ancestor, and on mobile
    // the keyboard-shifted document layer visibly jumps the whole app while
    // streaming content follows the tail.
    container.scrollTo({ top: container.scrollHeight, behavior });
    previousScrollTopRef.current = container.scrollTop;
  }, []);

  const currentModel = currentModelOverride ?? liveModel ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew
    ? (newSessionModel ?? newSessionDefaultModel)
    : currentModel ?? (data?.context.messages.length === 0 ? newSessionDefaultModel : null);
  const contextThinkingLevel = asConcreteThinkingLevel(
    data?.context.thinkingLevel && data.context.thinkingLevel !== "off"
      ? data.context.thinkingLevel
      : null,
  );
  const currentThinkingLevel = currentThinkingOverride ?? liveThinkingLevel ?? contextThinkingLevel;
  const requestedDisplayThinkingLevel = isNew
    ? (newSessionThinkingLevel ?? newSessionDefaultThinkingLevel)
    : currentThinkingLevel ?? (data?.context.messages.length === 0 ? newSessionDefaultThinkingLevel : null);
  const displayThinkingLevel = clampModelThinkingLevel(requestedDisplayThinkingLevel, displayModel
    ? modelThinkingLevels[`${displayModel.provider}:${displayModel.modelId}`] : null);
  const composerDraftKey = session?.id ?? newSessionDraftKey ?? undefined;

  const syncLiveModel = useCallback((state?: AgentStateResponse) => {
    setLiveModel(state?.model
      ? { provider: state.model.provider, modelId: state.model.id }
      : null);
    if (state?.thinkingLevel !== undefined) {
      setLiveThinkingLevel(asConcreteThinkingLevel(state.thinkingLevel));
    }
  }, []);

  const resolveComposerDraftKey = useCallback((key: string | undefined) => {
    if (!key) return undefined;
    let resolved = key;
    const visited = new Set<string>();
    while (!visited.has(resolved)) {
      visited.add(resolved);
      const next = draftKeyAliasesRef.current.get(resolved);
      if (!next) break;
      resolved = next;
    }
    return resolved;
  }, []);

  const restoreSubmission = useCallback((
    text: string,
    images: Array<{ data: string; mimeType: string }> | undefined,
    targetDraftKey: string | undefined,
  ) => {
    const draftImages = images?.map(({ data, mimeType }) => ({ data, mimeType }));
    const destinationDraftKey = resolveComposerDraftKey(targetDraftKey);
    if (
      !sessionHookMountedRef.current
      && !newSessionPromotedRef.current
      && targetDraftKey === newSessionDraftKey
    ) return;
    const input = opts.chatInputRef?.current;
    if (input) {
      input.restoreSubmission(text, draftImages, destinationDraftKey);
    } else if (destinationDraftKey) {
      restoreDraftSubmission(destinationDraftKey, text, draftImages);
    }
  }, [newSessionDraftKey, opts.chatInputRef, resolveComposerDraftKey]);

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) {
      return {
        ...sessionStatsOverride,
        totalActiveMs: data?.totalActiveMs,
        ...(contextUsage ? { contextUsage } : {}),
      };
    }
    const fileStats = data?.stats;
    const stats = mergeSessionStats(fileStats, data?.context.messages ?? [], messages);
    if (stats.tokens.total === 0 && messages.length === 0 && !fileStats) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      ...stats,
      totalActiveMs: data?.totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.context.messages, data?.filePath, data?.totalActiveMs, data?.stats, session?.id, session?.name]);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false, options?: { force?: boolean; streamRetry?: boolean; abortRetry?: boolean; signal?: AbortSignal; resident?: boolean }): Promise<unknown> => {
    // Single-flight: concurrent reads for the same session (mount + SSE settle +
    // reconcile) share one request unless the caller forces a fresh read.
    const syncEnabled = isSessionMemoryCacheEnabled();
    // Every new request supersedes earlier reads; only same-epoch reads may share a flight.
    if (options?.resident && syncEnabled) await waitForSessionPreload(sid);
    if (options?.resident && (!sessionHookMountedRef.current || sessionIdRef.current !== sid)) return null;
    const reuseResident = Boolean(options?.resident && !options.force && syncEnabled && isSessionResidentFresh(sid) && getSessionWireBaseline(sid, false)?.data && !getSessionViewSnapshot(sid, false)?.livePreview);
    const previousEpoch = getSessionEpoch(sid);
    const inflight = !options?.force ? loadFlightsRef.current.get(`${sid}:${previousEpoch}:${syncEnabled}`) : undefined;
    if (inflight) return await inflight;
    const requestEpoch = bumpSessionEpoch(sid);
    const readOwner = {};
    latestLoadRequestRef.current = readOwner;
    const ownsCurrentView = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && latestLoadRequestRef.current === readOwner && isSessionMemoryCacheEnabled() === syncEnabled;
    const flightKey = `${sid}:${requestEpoch}:${syncEnabled}`;
    const isCurrentRead = () => sessionHookMountedRef.current && sessionIdRef.current === sid
      && isEpochFresh(sid, requestEpoch) && isSessionMemoryCacheEnabled() === syncEnabled;
    const cachedWire = syncEnabled ? getSessionWireBaseline(sid) : null;
    let wireBaseline = cachedWire?.data ? cachedWire : null;
    let baseRevision = wireBaseline?.revision ?? null;
  const flight = (async (): Promise<unknown> => {
    let messagesLoaded = false;
    let willRetryAbort = false;
    try {
      if (showLoading) setLoading(true);
      if (syncEnabled && !wireBaseline) {
        const restored = await readSessionWireDisk(sid);
        if (!isCurrentRead()) return null;
        if (restored?.data) {
          wireBaseline = restored; baseRevision = restored.revision;
          setSessionWireBaseline(restored, false);
          // Reload/tab restoration: display confirmed disk history before network negotiation.
          if (!dataRef.current) {
            const preview = restored.data;
            dataRef.current = preview; messagesRef.current = preview.context.messages; entryIdsRef.current = preview.context.entryIds;
            setData(preview); setMessages(preview.context.messages); setEntryIds(preview.context.entryIds);
            setActiveLeafId(preview.leafId); setHistoryCursor(preview.context.oldestEntryId);
            setHasEarlierMessages(preview.context.hasMore); setLoading(false);
          }
        }
      }
      let reconciled: ReturnType<typeof reconcileSyncResponse> | undefined;
      // One bounded repair for a changed snapshot or invalid baseline; keep cached history visible.
      if (reuseResident && wireBaseline?.data) reconciled = { action: "unchanged", revision: wireBaseline.revision, preserveCurrentMessages: true };
      for (let attempt = 0; !reconciled && attempt < 2; attempt++) {
        const url = buildSessionSyncUrl({ sessionId: sid, baseRevision, force: options?.force || Boolean(options?.resident && !reuseResident), syncEnabled, treeFormat: "summary" });
        // A newer epoch may request the same URL while an older read is still
        // pending. Bypass the browser cache so it cannot queue behind that read.
        const res = await fetch(url, { cache: "no-store", ...(options?.signal ? { signal: options.signal } : {}) });
        if (!isCurrentRead()) return null;
        if (res.status === 404 || res.status === 401 || res.status === 403) {
          if (res.status === 404) deleteSessionViewSnapshot(sid);
          else clearSessionViewCache();
          setData(null); setActiveLeafId(null); setMessages([]); setEntryIds([]);
          dataRef.current = null; messagesRef.current = []; entryIdsRef.current = [];
          setHistoryCursor(null); setHasEarlierMessages(false);
          setError(res.status === 404 ? "Session not found" : "Session authorization required");
          return null;
        }
        // The server explicitly rejects a snapshot changed during its read.
        // Retry within this same owner instead of surfacing an expected write race.
        if (res.status === 409 && attempt === 0) continue;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        if (!isCurrentRead()) return null;
        reconciled = reconcileSyncResponse({ sessionId: sid, status: res.status, payload, wireBaseline,
          currentMessages: messagesRef.current, currentEntryIds: entryIdsRef.current });
        if (reconciled.action !== "invalid_delta") break;
        if (attempt === 1) throw new Error(`Session sync rejected: ${reconciled.reason}`);
        deleteSessionWireBaseline(sid); wireBaseline = null; baseRevision = null; reconciled = undefined;
      }
      let d: SessionData;
      if (reconciled?.action === "unchanged" && wireBaseline?.data) {
        const exact = wireBaseline.data;
        // Restore metadata/tool presets from the exact wire baseline, not an invented empty object.
        d = viewMatchesBaseline(wireBaseline, messagesRef.current, entryIdsRef.current)
          ? { ...exact, context: { ...exact.context, messages: messagesRef.current, entryIds: entryIdsRef.current,
              oldestEntryId: historyCursorRef.current, hasMore: hasEarlierMessagesRef.current } }
          : exact;
      } else if (reconciled?.action === "delta" || reconciled?.action === "reset" || reconciled?.action === "legacy") {
        d = reconciled.data;
        if (syncEnabled && reconciled.newWireBaseline) setSessionWireBaseline(reconciled.newWireBaseline);
        else deleteSessionViewSnapshot(sid, { preserveHistoryPages: true }); // Drop an uncertified tail, not independently validated ancestor pages.
      } else {
        throw new Error(reconciled?.action === "error" ? reconciled.message : "Invalid session sync response");
      }
      // Reconcile the exact server window first, then retain certified loaded
      // ancestors in the view. Never widen the wire baseline or restore stale
      // live messages that have not received their committed entry IDs yet.
      d = preserveLoadedHistoryPrefix(d, wireBaseline, {
        messages: messagesRef.current, entryIds: entryIdsRef.current,
        oldestEntryId: historyCursorRef.current, hasMore: hasEarlierMessagesRef.current,
      });
      // A history read during preparation may predate the submitted prompt.
      // Keep its local echo visible without adding it to a certified baseline.
      bindUserHistoryIdentities(d.context.messages, d.context.entryIds, d.promptEntryIds);
      const displayMessages = preservePendingUserMessage(d.context.messages, d.context.entryIds, sid, optimisticUserMessageRef.current);
      dataRef.current = d; messagesRef.current = displayMessages; entryIdsRef.current = d.context.entryIds;
      setData(d); setActiveLeafId(d.leafId); setMessages(displayMessages); setEntryIds(d.context.entryIds);
      setHistoryCursor(d.context.oldestEntryId ?? null); setHasEarlierMessages(Boolean(d.context.hasMore));
      // Apply even on unchanged: a remounted view must restore the session's tool preset.
      sessionToolsPinnedRef.current = d.toolNames !== undefined;
      setToolPresetState(d.toolNames !== undefined ? getPresetFromToolNames(d.toolNames) : CONFIGURED_TOOL_PRESET);
      setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
      setCurrentThinkingOverride(null); setError(null);
      if (syncEnabled && d.treeFormat === "summary") {
        setSessionViewSnapshot({ sessionId: sid, revision: d.snapshotRevision ?? null, livePreview: !d.snapshotRevision, ...(!d.snapshotRevision ? { data: d } : {}), messages: d.context.messages,
          entryIds: d.context.entryIds, leafId: d.leafId, oldestEntryId: d.context.oldestEntryId,
          hasMore: d.context.hasMore, summaryTree: d.tree, thinkingLevel: d.context.thinkingLevel,
          model: d.context.model, stats: d.stats, totalActiveMs: d.totalActiveMs, loadedEntryIds: d.context.entryIds });
      }

      if (syncEnabled && d.snapshotRevision) markSessionResidentFresh(sid);

      if (d.wrapperRebuilt) {
        eventConnectionRef.current?.close();
        eventConnectionRef.current?.maintain(sid);
      }
      if (!includeState && d.context.thinkingLevel && d.context.thinkingLevel !== "off") {
        setLiveThinkingLevel(asConcreteThinkingLevel(d.context.thinkingLevel));
      }

      messagesLoaded = true;
      // A silent replacement owns settlement of an earlier visible load too.
      setLoading(false);
      if (!includeState) return null;

      try {
        const stateRunId = promptRunIdRef.current;
        const stateRevision = agentStateRevisionRef.current;
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`, options?.signal ? { signal: options.signal } : undefined);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (!isCurrentRead() || promptRunIdRef.current !== stateRunId
          || agentStateRevisionRef.current !== stateRevision) return null;

        const liveState = agentState.state;
        syncLiveModel(liveState);
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
          if (liveState.autoCompactionEnabled !== undefined) setAutoCompactionEnabled(liveState.autoCompactionEnabled ?? true);
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      if (isAbortError(e)) {
        const isExplicitCallerAbort = Boolean(options?.signal?.aborted);
        const canRetry = ownsCurrentView() && !options?.abortRetry && !isExplicitCallerAbort;
        if (canRetry) {
          willRetryAbort = true;
          queueMicrotask(() => {
            if (ownsCurrentView()) {
              void loadSession(sid, showLoading && !dataRef.current, includeState, {
                ...options,
                force: true,
                abortRetry: true,
              });
            }
          });
        }
        return null;
      }
      if (isCurrentRead()) setError(String(e));
      return "error";
    } finally {
      if (ownsCurrentView() && !messagesLoaded) {
        if (willRetryAbort) {
          if (dataRef.current) setLoading(false);
        } else if (!isEpochFresh(sid, requestEpoch) && !options?.streamRetry) {
          queueMicrotask(() => {
            if (ownsCurrentView()) void loadSession(sid, true, includeState, { force: true, streamRetry: true });
          });
        } else {
          setLoading(false);
          if (!isEpochFresh(sid, requestEpoch) && !dataRef.current) {
            setError("History changed while loading; the next session refresh will reconcile it.");
          }
        }
      }
    }
    })();
    loadFlightsRef.current.set(flightKey, flight);
    flight.finally(() => {
      if (loadFlightsRef.current.get(flightKey) === flight) loadFlightsRef.current.delete(flightKey);
    });
    return await flight;
  }, [setToolPresetState, syncLiveModel]);

  const loadContext = useCallback(async (sid: string, leafId: string | null, before?: string | null, options?: { tail?: number; signal?: AbortSignal }) => {
    try {
      const isCurrent = () => (
        sessionIdRef.current === sid
        && (sessionPropIdRef.current === null || sessionPropIdRef.current === sid)
        && (before ? (activeLeafIdRef.current === leafId && historyCursorRef.current === before) : true)
        && !options?.signal?.aborted
        && sessionHookMountedRef.current
      );

      let contextData: { context: SessionData["context"] } | null = null;
      if (before && isSessionMemoryCacheEnabled()) {
        const pageResult = await fetchHistoryPageContext({
          sessionId: sid,
          leafId,
          before,
          tail: options?.tail,
          deferThinking: true,
          deferMedia: true,
          signal: options?.signal,
          isCurrent,
        });
        if (!pageResult) return;
        contextData = { context: pageResult.context as SessionData["context"] };
      } else {
        const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
        if (leafId) params.set("leafId", leafId);
        // Page upward: ask the server for the `tail` ancestors preceding `before`,
        // then prepend them. Omitting `before` fetches the most-recent `tail`.
        if (before) params.set("before", before);
        if (options?.tail) params.set("tail", String(options.tail));
        const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
        const res = await fetch(url, { signal: options?.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        contextData = await res.json() as { context: SessionData["context"] };
      }

      if (
        !contextData
        || !isCurrent()
      ) return;
      const d = contextData;
      historyCursorRef.current = d.context.oldestEntryId ?? null;
      hasEarlierMessagesRef.current = Boolean(d.context.hasMore);
      setHistoryCursor(d.context.oldestEntryId);
      setHasEarlierMessages(d.context.hasMore);
      setData((prev) => {
        if (!prev || prev.sessionId !== sid) return prev;
        const context = before ? {
          ...prev.context,
          messages: [...d.context.messages, ...prev.context.messages],
          entryIds: [...d.context.entryIds, ...prev.context.entryIds],
          oldestEntryId: d.context.oldestEntryId,
          hasMore: d.context.hasMore,
        } : d.context;
        return { ...prev, context };
      });
      if (before) {
        // Older page: prepend so scroll position stays anchored.
        messagesRef.current = [...d.context.messages, ...messagesRef.current];
        entryIdsRef.current = [...d.context.entryIds, ...entryIdsRef.current];
        setMessages((prev) => [...d.context.messages, ...prev]);
        setEntryIds((prev) => [...d.context.entryIds, ...prev]);
      } else {
        messagesRef.current = d.context.messages;
        entryIdsRef.current = d.context.entryIds ?? [];
        setMessages(d.context.messages);
        setEntryIds(d.context.entryIds ?? []);
      }
      return d.context;
    } catch (e) {
      if (!options?.signal?.aborted) console.error("Failed to load context:", e);
    }
  }, []);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (!tools || !sessionHookMountedRef.current || sessionIdRef.current !== sid) return null;
      const { getPresetFromTools } = await import("@/lib/tool-presets");
      setToolPresetState(sessionToolsPinnedRef.current ? getPresetFromTools(tools) : CONFIGURED_TOOL_PRESET);
      onSystemToolsChange?.(tools);
      return tools;
    } catch (e) {
      console.error("Failed to load tools:", e);
      return null;
    }
  }, [onSystemToolsChange, setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    const provisionalDraftKey = newSessionDraftKey;
    if (!provisionalDraftKey) return;
    if (provisionalDraftKey !== sid) {
      draftKeyAliasesRef.current.set(provisionalDraftKey, sid);
      const input = opts.chatInputRef?.current;
      if (input) input.rekeyDraft(provisionalDraftKey, sid);
      else rekeyDraft(provisionalDraftKey, sid);
    }
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      transient: true,
    }, provisionalDraftKey);
  }, [isNew, newSessionCwd, newSessionDraftKey, onSessionCreated, opts.chatInputRef]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      // Undefined means the user never overrode the loadout: omit the field entirely
      // so pi resolves settings.json defaultTools instead of being pinned to ours (#700).
      const toolNames = getToolNamesForPreset(toolPreset);
      sessionToolsPinnedRef.current = toolNames !== undefined;
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          ...(toolNames !== undefined ? { toolNames } : {}),
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as {
        sessionId: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
      };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setLiveThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
        if (selectedThinkingLevel) {
          const effective = asConcreteThinkingLevel(result.thinkingLevel);
          thinkingLevelOverrideRef.current = effective;
          setNewSessionThinkingLevel(effective);
        } else {
          setNewSessionDefaultThinkingLevel(asConcreteThinkingLevel(result.thinkingLevel));
        }
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, toolPreset]);

  // Opening the System or Tools panel may initialize an otherwise dormant
  // session. This is deliberately a non-prompt command: it creates no message
  // or model run, but lets users inspect the exact prompt before sending one.
  const loadSystemInfo = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) return;

    const [state] = await Promise.all([
      sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" }),
      loadTools(sid),
    ]);
    if (!sessionHookMountedRef.current || sessionIdRef.current !== sid) return;
    syncLiveModel(state);
    setSystemPrompt(state.systemPrompt ?? "");
  }, [ensureNewSession, loadTools, syncLiveModel]);

  const replaceSlashCommands = useCallback((commands: SlashCommandInfo[]) => {
    slashCommandsRef.current = commands;
    setSlashCommands(commands);
  }, []);

  // The session's tools changed (set_tools may have rebuilt it as Chat only): forget the
  // list and the request under way, so the next reader asks the session as it is now.
  const clearSlashCommands = useCallback(() => {
    slashCommandsGenerationRef.current += 1;
    slashCommandsLoadRef.current = null;
    replaceSlashCommands([]);
  }, [replaceSlashCommands]);

  // Null when get_commands failed, which an empty list (a Chat-only session's) must not be mistaken for.
  const requestSlashCommands = useCallback((): Promise<SlashCommandInfo[] | null> => {
    const generation = ++slashCommandsGenerationRef.current;
    const current = () => slashCommandsGenerationRef.current === generation;
    const load = (async () => {
      const sid = sessionIdRef.current ?? await ensureNewSession();
      if (!sid) {
        if (current()) replaceSlashCommands([]);
        return [] as SlashCommandInfo[];
      }
      setSlashCommandsLoading(true);
      try {
        const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
        const commands = data?.commands ?? [];
        if (current()) replaceSlashCommands(commands);
        return commands;
      } catch (e) {
        console.error("Failed to load slash commands:", e);
        if (current()) replaceSlashCommands([]);
        return null;
      } finally {
        // A newer request under way keeps the palette's "Loading" until it answers.
        if (current() || !slashCommandsLoadRef.current) setSlashCommandsLoading(false);
      }
    })();
    slashCommandsLoadRef.current = load;
    const settle = () => {
      if (slashCommandsLoadRef.current === load) slashCommandsLoadRef.current = null;
    };
    load.then(settle, settle);
    return load;
  }, [ensureNewSession, replaceSlashCommands]);

  const loadSlashCommands = useCallback(async () => (await requestSlashCommands()) ?? [], [requestSlashCommands]);

  // The list a bare /mcp is decided by: the request under way (the palette starts
  // one as "/mcp" is typed, often still unanswered at Enter), else the list already
  // loaded, else a new request. Null when it cannot be read: guessing would either
  // swallow another extension's /mcp or send one Settings should have taken.
  const slashCommandsForMcp = useCallback(async (): Promise<SlashCommandInfo[] | null> => {
    const pending = slashCommandsLoadRef.current;
    const known = slashCommandsRef.current;
    if (!pending && known.length > 0) return known;
    const loaded = await (pending ?? requestSlashCommands()).catch(() => null);
    return loaded ?? (known.length > 0 ? known : null);
  }, [requestSlashCommands]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventConnectionRef.current?.close();
  }, []);

  const ensureEventsConnected = useCallback((sid: string) => (
    eventConnectionRef.current!.ensureConnected(sid)
  ), []);

  const maintainEventsConnected = useCallback((sid: string) => {
    eventConnectionRef.current!.maintain(sid);
  }, []);

  // Keep the selected session warm even while its agent is idle. The SSE lease
  // is renewed separately below and expires if the browser disappears.
  // A cold view hydrates history before subscribing: completed-message events
  // must not repeatedly invalidate its first read. The connected handshake then
  // reconciles turns committed between that snapshot and the subscription.
  useEffect(() => {
    const sid = session?.id;
    if (!sid || data?.sessionId !== sid) return;
    // React Strict Mode re-runs every effect after a simulated unmount, in
    // declaration order. The mount-only effect below flips this ref to false
    // in its cleanup and only restores it when it re-runs *after* this one,
    // so without re-asserting it here shouldMaintain() refuses the connection
    // and the selected session never opens its event stream.
    sessionHookMountedRef.current = true;
    maintainEventsConnected(sid);
    return () => {
      if (sessionIdRef.current === sid) eventConnectionRef.current?.close();
    };
  }, [maintainEventsConnected, session?.id, data?.sessionId]);

  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    let disposed = false;
    let renewing = false;

    const renewLease = async () => {
      if (disposed || renewing) return;
      renewing = true;
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sid)}/lease`, {
          method: "POST",
          cache: "no-store",
        });
        if (!response.ok || disposed) return;
        const result = await response.json() as { renewed?: number };
        if (
          !disposed
          && result.renewed === 0
          && dataRef.current?.sessionId === sid
          && sessionIdRef.current === sid
          && sessionPropIdRef.current === sid
        ) {
          closeEvents();
          maintainEventsConnected(sid);
        }
      } catch {
        // Retry on the next interval; the SSE connection remains the primary path.
      } finally {
        renewing = false;
      }
    };

    const interval = setInterval(() => void renewLease(), SESSION_LEASE_RENEW_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void renewLease();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [closeEvents, maintainEventsConnected, session?.id]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    const sid = sessionIdRef.current;
    setExtensionDialogs((queue) => removeExtensionUiRequest(queue, request.id));
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      console.error("Failed to send extension UI response:", e);
    }
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string | string[]) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
      return true;
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
      return false;
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    const item = { id: notice.id ?? createNoticeId(), message, type: notice.type ?? "info" };
    if (!admitNativeNotification(item)) return;
    dispatchNotice({ type: "add", notice: item });
  }, []);

  useEffect(() => {
    const onPolicyChange = () => dispatchNotice({ type: "refilter" });
    window.addEventListener(NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT, onPolicyChange);
    return () => window.removeEventListener(NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT, onPolicyChange);
  }, []);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (isBlockingExtensionUiRequest(request)) onAttentionNeeded?.(request);

    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
        setExtensionDialogs((queue) => enqueueExtensionUiRequest(queue, request));
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => updateExtensionWidgets(
          prev,
          request.widgetKey,
          request.widgetLines,
          request.widgetPlacement,
        ));
        break;
      case "setTitle":
        if (request.title) {
          window.dispatchEvent(new CustomEvent("pi-enh-title-change", { detail: { title: request.title } }));
        }
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUis((queue) => request.closed
          ? removeExtensionUiRequest(queue, request.id)
          : upsertExtensionUiRequest(queue, request));
        break;
    }
  }, [addNotice, onAttentionNeeded, opts.chatInputRef]);

  const restorePendingInteraction = useEffectEvent((request: ExtensionUiRequest) => {
    handleExtensionUiRequest(request);
  });

  useEffect(() => {
    const sid = session?.id;
    if (!sid) return;
    const controller = new AbortController();
    const revision = extensionUiRevisionRef.current;
    // Pending questions must not wait for the event stream's connection/replay
    // or a large history. SSE remains authoritative once it has caught up.
    void (async () => {
      try {
        const response = await fetch(`/api/agent/${encodeURIComponent(sid)}?interactions=1`, {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
          cache: "no-store",
        });
        if (!response.ok) return;
        const snapshot = await response.json();
        if (controller.signal.aborted || sessionIdRef.current !== sid) return;
        if (Array.isArray(snapshot.uncommittedPrompts)) mergeServerPromptSubmissions(snapshot.uncommittedPrompts);
        if (extensionUiRevisionRef.current !== revision) return;
        if (!Array.isArray(snapshot.pendingExtensionUiRequests)) return;
        for (const request of snapshot.pendingExtensionUiRequests as ExtensionUiRequest[]) {
          if (isBlockingExtensionUiRequest(request)) restorePendingInteraction(request);
        }
      } catch {
        // The normal event stream still restores requests if this read fails.
      }
    })();
    return () => controller.abort();
  }, [session?.id]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    setActiveToolResults(new Map());
    dispatch({ type: "end" });
    return wasRunning;
  }, []);

  const notifyPromptStage = useCallback((runId: number) => {
    if (notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    onAgentEnd?.();
    return true;
  }, [onAgentEnd]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    if (sessionPropIdRef.current === sid) {
      cancelEventStreamGrace();
      return;
    }
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        syncLiveModel(state);
        const promptActive = Boolean(data.running && state && (state.isStreaming || state.isPromptRunning));
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }

        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [cancelEventStreamGrace, closeEvents, syncLiveModel]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (promptRunIdRef.current !== runId || (sid && sessionIdRef.current !== sid)) return;

    const promptWasPending = rpcPromptPendingRef.current;
    const agentWasActive = sdkAgentActiveRef.current;
    rpcPromptPendingRef.current = false;
    sdkAgentActiveRef.current = false;
    optimisticUserMessageRef.current = null;
    const wasRunning = settleUiStage();
    if (promptWasPending || agentWasActive || wasRunning) {
      notifyPromptStage(runId);
    }
    if (sid) {
      // History refresh is best-effort background work. loadSession already
      // checks the session and epoch so a switch or newer prompt wins.
      void loadSession(sid);
      scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyPromptStage, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId = promptRunIdRef.current) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (promptRunIdRef.current !== runId || sessionIdRef.current !== sid) return;
      try {
        const revision = agentStateRevisionRef.current;
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          if (promptRunIdRef.current !== runId || sessionIdRef.current !== sid) return;
          if (agentStateRevisionRef.current !== revision) continue;
          const state = data.state;
          syncLiveModel(state);
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning && !state.isCompacting)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream, syncLiveModel]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        syncLiveModel(data.state);
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession, syncLiveModel]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current || sessionIdRef.current !== sid) return;
    const runId = promptRunIdRef.current;
    const revision = agentStateRevisionRef.current;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (sessionIdRef.current !== sid || promptRunIdRef.current !== runId
          || agentStateRevisionRef.current !== revision) return;
      const state = data.state;
      syncLiveModel(state);
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setAutoCompactionEnabled(state?.autoCompactionEnabled ?? true);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      if (state) {
        if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting);
      if (busy) {
        sdkAgentActiveRef.current = Boolean(state.isStreaming);
        rpcPromptPendingRef.current = Boolean(state.isPromptRunning);
        return;
      }
      if (!agentRunningRef.current) return;
      // An idle snapshot can belong to the previous turn while the user's
      // next prompt is still connecting or awaiting admission. The durable
      // submission receipt owns that uncertainty; do not end it optimistically.
      if (preparationRef.current || getPendingPromptSubmissions().some(
        (row) => row.sessionId === sid && row.status === "sending",
      )) return;
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [finishPromptWithoutStream, syncLiveModel]);

  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  // Metadata refreshes change completion callbacks. They must not restart the
  // recovery clock, or a busy sidebar can postpone the first check forever.
  const reconcileRunningAgent = useEffectEvent(() => {
    const sid = sessionIdRef.current;
    if (sid) void reconcileAgentState(sid);
  });
  const reconcileSelectedHistory = useEffectEvent(() => {
    const sid = sessionIdRef.current;
    if (!sid || !sessionHookMountedRef.current) return;
    if (agentRunningRef.current) void reconcileAgentState(sid);
    else void loadSession(sid);
  });
  const previousSessionRunningRef = useRef(opts.sessionRunning);
  useEffect(() => {
    const wasRunning = previousSessionRunningRef.current;
    previousSessionRunningRef.current = opts.sessionRunning;
    // The sidebar's authoritative running snapshot is an early completion
    // signal, not permission to clear a newly submitted prompt. Confirm it
    // through the same run-guarded runtime read before settling the composer.
    if (wasRunning === true && opts.sessionRunning === false) reconcileSelectedHistory();
  }, [opts.sessionRunning]);
  const catalogHistorySource = session ? `${session.id}:${session.path}:${session.modified}` : null;
  const previousCatalogHistorySourceRef = useRef(catalogHistorySource);
  const catalogHistoryDirtyRef = useRef(false);
  useEffect(() => {
    if (previousCatalogHistorySourceRef.current !== catalogHistorySource) {
      previousCatalogHistorySourceRef.current = catalogHistorySource;
      catalogHistoryDirtyRef.current = true;
      if (session?.id) bumpSessionEpoch(session.id);
    }
    // A list refresh can observe an entire turn that this tab never streamed.
    // Keep the live writer in charge, then reconcile the selected idle view.
    if (catalogHistoryDirtyRef.current && !agentRunning && !opts.sessionRunning && session?.id) {
      catalogHistoryDirtyRef.current = false;
      void loadSession(session.id);
    }
  }, [catalogHistorySource, agentRunning, opts.sessionRunning, session?.id, loadSession]);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcileSelectedHistory();
    };
    const interval = agentRunning ? setInterval(reconcileRunningAgent, AGENT_STATE_RECONCILE_MS) : null;
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcileSelectedHistory);
    return () => {
      if (interval !== null) clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcileSelectedHistory);
    };
  }, [agentRunning]);

  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    if (event.type === "extension_ui_request" || event.type === "extension_ui_closed"
      || (event.type === "connected" && Array.isArray(event.pendingExtensionUiIds))) {
      extensionUiRevisionRef.current += 1;
    }
    if (["connected", "agent_start", "agent_end", "agent_settled", "prompt_done"].includes(event.type)) {
      agentStateRevisionRef.current += 1;
    }
    if (sessionIdRef.current && invalidatesSessionHistory(event.type)) {
      bumpSessionEpoch(sessionIdRef.current);
    }
    switch (event.type) {
      case "connected": {
        dispatch({ type: "end" });
        if (Array.isArray(event.pendingExtensionUiIds)) {
          // The server replays what it still holds right after this event.
          const pending = new Set(event.pendingExtensionUiIds as string[]);
          setExtensionDialogs((queue) => retainExtensionUiRequests(queue, pending));
          setExtensionCustomUis((queue) => retainExtensionUiRequests(queue, pending));
        }
        if (event.isStreaming === true) {
          cancelEventStreamGrace();
          sdkAgentActiveRef.current = true;
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "waiting_model" });
          // The stream snapshot only replays the current message. Completed
          // turns missed while disconnected still belong to native history.
          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
        } else if (agentRunningRef.current && !rpcPromptPendingRef.current) {
          // A connected snapshot can reveal that the server is already idle.
          // Keep a prompt whose POST is still awaiting acceptance alive.
          const sid = sessionIdRef.current;
          if (sid) void reconcileAgentState(sid);
        } else if (!agentRunningRef.current && !rpcPromptPendingRef.current) {
          // Reconnect does not replay turns completed while the tab was away.
          // An idle handshake must validate history even when local state never
          // observed agent_start. Share the existing native loader/flight.
          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid, false, true);
        }
        break;
      }
      case "agent_start":
        cancelEventStreamGrace();
        if (!rpcPromptPendingRef.current) {
          promptRunIdRef.current += 1;
        }
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          void loadSession(sessionIdRef.current);
          void reconcileAgentState(sessionIdRef.current);
        }
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive) {
          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          break;
        }
        // SDK settlement ends this run. The POST promise may still be unwinding;
        // it is not model activity and must not keep Stop / waiting visible.

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning) {
          notifyPromptStage(promptRunIdRef.current);
        }
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageRef.current = null;
          if (!promptWasPending && notifiedPromptRunIdRef.current === runId) {
            const sid = sessionIdRef.current;
            if (sid) void loadSession(sid);
            break;
          }

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            notifyPromptStage(runId);
            if (sid) scheduleEventStreamClose(sid);
          } else if (sid) {
            // prompt_done can survive a lost agent_settled event. Verify the
            // runtime so its stale SDK flag cannot leave Stop visible; a real
            // extension continuation still reports busy and stays active.
            void reconcileAgentState(sid);
          }
        }
        break;
      case "prompt_error":
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        // Transcript system messages (prompt and tool loadout) are filtered
        // server-side; keep them out of the chat should one arrive.
        if (isSystemMessageEvent(event)) break;
        if (event.type === "message_start") {
          const msg = event.message as AgentMessage | undefined;
          if (msg?.role === "user") break;
          if (msg?.role === "assistant") {
            dispatch({ type: "snapshot", message: msg });
            if (msg.content.length > 0) setAgentPhase(null);
          } else if (msg) {
            setAgentPhase(null);
          }
        } else {
          const delta = event.assistantMessageEvent as ClientAssistantMessageEvent | undefined;
          if (delta) {
            dispatch({ type: "delta", event: delta });
            if (delta.type !== "toolcall_start" && delta.type !== "toolcall_delta") {
              setAgentPhase(null);
            }
          }
        }
        // Live-follow the streaming output only when the user is already near
        // the bottom of the message list. If they scrolled up, leave them there.
        if (!pendingScrollToUserRef.current && isNearBottomRef.current && liveFollowFrameRef.current === null) {
          // Defer the scroll so React has time to update the DOM with the new
          // streaming content; otherwise scrollIntoView may target stale layout.
          liveFollowFrameRef.current = requestAnimationFrame(() => {
            liveFollowFrameRef.current = null;
            if (isNearBottomRef.current) scrollToBottom("auto");
          });
        }
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // append nothing, but verify disk: the commit may have arrived after
        // the settlement read. Its epoch already superseded that older read.
        if (!agentRunningRef.current) {
          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          break;
        }
        if (isSystemMessageEvent(event)) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed && completed.role === "user") {
          // The bubble and authoritative queue snapshot share the same React
          // update batch; do not infer consumption from text (duplicates/images).
          if (event.queuedMessages !== undefined) {
            setQueuedMessages(normalizeQueuedMessages(event.queuedMessages as QueuedMessages));
          }
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const requestId = typeof event.requestId === "string" ? event.requestId : undefined;
          bindUserMessageIdentity(delivered, { requestId, entryId: typeof event.entryId === "string" ? event.entryId : undefined });
          const pending = optimisticUserMessageRef.current;
          const ownsEcho = pending && (pending.requestId ? pending.requestId === requestId : !requestId);
          if (ownsEcho) optimisticUserMessageRef.current = null;
          if (!ownsEcho) {
            // Steering/follow-up delivery is a new user turn too. The initial
            // prompt already acquired its scroll intent in handleSend.
            pendingScrollToUserRef.current = true;
            setPromptAnchorActive(true);
            setPromptScrollRevision((revision) => revision + 1);
          }
          setMessages((prev) => reconcileDeliveredUserEntry(prev, delivered, ownsEcho ? pending : null));
        } else if (completed) {
          setMessages((prev) => [...prev, normalizeToolCalls(completed)]);
          if (completed.role === "toolResult") {
            setActiveToolResults((prev) => {
              if (!prev.has(completed.toolCallId)) return prev;
              const next = new Map(prev);
              next.delete(completed.toolCallId);
              return next;
            });
          }
        }
        dispatch({ type: "end" });
        // A terminal answer is already available. Only real tool/start events
        // can announce the next phase; message completion is not a new request.
        setAgentPhase(completed?.role === "assistant" ? null : { kind: "waiting_model" });
        break;
      }
      case "tool_execution_start": {
        // A call a tool made itself (a codemode script's) belongs to its
        // parent's card; listed here it would show as a top-level running tool,
        // and a call cut off by its script can end after the parent did.
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_update": {
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const partialResult = event.partialResult as Partial<ToolResultMessage> | undefined;
        const content = partialResult?.content;
        // Live output for shells; for codemode, the calls its script has made so far.
        if ((name === "bash" || name === "powershell" || name === CODEMODE_TOOL_NAME) && Array.isArray(content)) {
          setActiveToolResults((prev) => {
            const next = new Map(prev);
            next.set(id, {
              role: "toolResult",
              toolCallId: id,
              toolName: name,
              content,
              isError: partialResult?.isError,
              details: partialResult?.details,
              inProgress: true,
            });
            return next;
          });
        }
        const progress = name === CODEMODE_TOOL_NAME
          ? getCodemodeProgress(event.partialResult)
          : getToolExecutionProgress(event.partialResult);
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          const existing = tools.find((tool) => tool.id === id);
          const updated = {
            id,
            name: name || existing?.name || "tool",
            progress: progress ?? existing?.progress,
          };
          return {
            kind: "running_tools",
            tools: [...tools.filter((tool) => tool.id !== id), updated],
          };
        });
        break;
      }
      case "tool_execution_end": {
        if (isNestedToolExecutionEvent(event)) break;
        const id = event.toolCallId as string;
        setActiveToolResults((prev) => {
          const next = new Map(prev);
          next.set(id, completeActiveToolResult(prev.get(id), {
            toolCallId: id,
            toolName: event.toolName as string | undefined,
            isError: event.isError as boolean | undefined,
          }));
          return next;
        });
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "prompt_delivery": {
        const sid = sessionIdRef.current;
        const requestId = event.requestId;
        if (!sid || typeof requestId !== "string") break;
        const receipt = event.receipt as { status?: string; entryId?: string } | undefined;
        if (receipt?.status === "committed" && typeof receipt.entryId === "string") {
          const entryId = receipt.entryId;
          setMessages((prev) => reconcileUserReceipt(prev, requestId, entryId));
        }
        if (typeof receipt?.status === "string") reconcilePromptSubmission(requestId, { status: receipt.status });
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setMessages((prev) => markLatestAssistantRetryAttempt(prev));
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          if (sessionIdRef.current) loadSession(sessionIdRef.current);
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
      case "extension_ui_closed":
        setExtensionDialogs((queue) => removeExtensionUiRequest(queue, event.id as string));
        break;
    }
  }, [addNotice, cancelEventStreamGrace, handleExtensionUiRequest, loadSession, notifyPromptStage, reconcileAgentState, scheduleEventStreamClose, scrollToBottom, settleUiStage, syncLiveModel]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length) return;
    if (agentRunningRef.current || bashRunningRef.current) {
      restoreSubmission(message, images, composerDraftKey);
      return;
    }
    const isSlashCommandPrompt = !images?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) {
        restoreSubmission(message, images, composerDraftKey);
        return;
      }
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    const sourceDraftKey = isNew ? newSessionDraftKey : null;
    if (sourceDraftKey && newSessionCwd) {
      onSessionSubmissionChange?.(sourceDraftKey, pendingSessionInfo(sourceDraftKey, newSessionCwd, sourceDraftKey, message));
    }
    if (sessionIdRef.current) bumpSessionEpoch(sessionIdRef.current);
    const promptRunId = promptRunIdRef.current + 1;
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(message.trim() ? [{ type: "text" as const, text: message }] : []), ...imageBlocks]
        : message,
      timestamp: Date.now(),
    };
    optimisticUserMessageRef.current = { sessionId: sessionIdRef.current, message: userMsg, precedingEntryIds: entryIdsRef.current };
    const onPromptRegistered = ({ requestId }: { requestId: string }) => {
      const pending = optimisticUserMessageRef.current;
      if (pending?.message === userMsg) {
        pending.requestId = requestId;
        bindUserMessageIdentity(userMsg, { requestId });
      }
    };
    setMessages((prev) => [...prev, userMsg]);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    pendingScrollToUserRef.current = true;
    setPromptAnchorActive(true);
    setPromptScrollRevision((revision) => revision + 1);

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;
    const preparation = new AbortController();
    preparationRef.current = preparation;
    setStopRequested(false);
    const prepare = <T,>(operation: Promise<T>) => waitForPromptPreparation(operation, preparation.signal);

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await prepare(ensuringNewSessionRef.current ?? Promise.resolve(null));
        const sid = existingSid ?? await prepare(ensureNewSession());

        if (!sid) throw new Error("Unable to create a session for the prompt");
        sentSessionId = sid;
        if (optimisticUserMessageRef.current?.message === userMsg) optimisticUserMessageRef.current.sessionId = sid;
        if (sourceDraftKey) onSessionSubmissionChange?.(sourceDraftKey, pendingSessionInfo(sourceDraftKey, newSessionCwd, sid, message));
        if (selectedModel) {
          setPendingModel(selectedModel);
          if (existingSid) {
            await prepare(sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId }));
          }
        }
        await prepare(ensureEventsConnected(sid));
        preparationRef.current = null;
        promptRequestStarted = true;
        bumpSessionEpoch(sid);
        const result = await sendAgentCommand<{ stopped?: boolean } | null>(sid, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        }, { onPromptRegistered });
        promoteNewSession(1, message);
        if (result?.stopped) await reconcileAgentState(sid);
      } else if (session) {
        sentSessionId = session.id;
        await prepare(ensureEventsConnected(session.id));
        preparationRef.current = null;
        promptRequestStarted = true;
        bumpSessionEpoch(session.id);
        const result = await sendAgentCommand<{ stopped?: boolean } | null>(session.id, {
          type: "prompt",
          message,
          ...(piImages?.length ? { images: piImages } : {}),
        }, { onPromptRegistered });
        if (result?.stopped) await reconcileAgentState(session.id);
      } else {
        throw new Error("No active session for the prompt");
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      const cancelledBeforeDispatch = preparation.signal.aborted && !promptRequestStarted;
      if (!cancelledBeforeDispatch) console.error("Failed to send message:", e);
      const definitivelyRejected = !promptRequestStarted || isPromptRejectedError(e);
      // A transport/proxy failure after dispatch is ambiguous: the server may
      // have accepted the prompt before the response was lost. Keep SSE alive
      // until server state confirms the run is idle.
      if (!definitivelyRejected && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      if (cancelledBeforeDispatch) {
        // Stop cancels execution, not the submitted message. Finish only session
        // creation and retain it natively; never reconnect or replay the prompt.
        try {
          const sid = sentSessionId ?? sessionIdRef.current ?? await ensuringNewSessionRef.current;
          if (!sid) throw new Error("尚未建立会话，消息已退回输入框。");
          await sendAgentCommand(sid, {
            type: "retain_stopped_prompt", requestId: crypto.randomUUID(), message,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          if (optimisticUserMessageRef.current?.message === userMsg) optimisticUserMessageRef.current = null;
          rpcPromptPendingRef.current = false;
          agentRunningRef.current = false;
          setAgentRunning(false);
          setStopRequested(false);
          setAgentPhase(null);
          dispatch({ type: "end" });
          if (isNew) promoteNewSession(1, message);
          await loadSession(sid);
          closeEvents();
          return;
        } catch (saveError) {
          addNotice({ type: "error", message: `停止后保存消息失败，内容已退回输入框：${saveError instanceof Error ? saveError.message : String(saveError)}` });
        }
      }
      if (sourceDraftKey) onSessionSubmissionChange?.(sourceDraftKey, null);
      rpcPromptPendingRef.current = false;
      setMessages((prev) => {
        const optimisticIndex = prev.lastIndexOf(userMsg);
        return optimisticIndex === -1
          ? prev
          : [...prev.slice(0, optimisticIndex), ...prev.slice(optimisticIndex + 1)];
      });
      if (!cancelledBeforeDispatch) addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      restoreSubmission(message, images, composerDraftKey);
      optimisticUserMessageRef.current = null;
      // Rejection only describes this submission. Another tab or an event we
      // missed may still have a real run active for the same session, so keep
      // its SSE connection until server state says the wrapper is idle.
      if (sentSessionId && !cancelledBeforeDispatch) {
        void reconcileAgentState(sentSessionId);
        return;
      }
      agentRunningRef.current = false;
      closeEvents();
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    } finally {
      if (preparationRef.current === preparation) preparationRef.current = null;
    }
  }, [isNew, newSessionCwd, newSessionDraftKey, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, composerDraftKey, reconcileAgentState, restoreSubmission, onSessionSubmissionChange, loadSession]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    setStopRequested(false);
    const preparation = new AbortController();
    preparationRef.current = preparation;
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await waitForPromptPreparation(ensureNewSession(), preparation.signal);
      if (preparation.signal.aborted) throw new DOMException("Preparation cancelled", "AbortError");
      preparationRef.current = null;
      if (!sid) throw new Error("Unable to create a session for the shell command");
      bumpSessionEpoch(sid);
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      if (!preparation.signal.aborted) {
        console.error("Failed to execute shell command:", e);
        addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      }
      restoreSubmission(inputText, undefined, composerDraftKey);
    } finally {
      if (preparationRef.current === preparation) preparationRef.current = null;
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, composerDraftKey, ensureNewSession, loadSession, promoteNewSession, restoreSubmission, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    if (preparationRef.current) {
      setStopRequested(true);
      preparationRef.current.abort();
      return;
    }
    if (stopInFlightRef.current) return stopInFlightRef.current;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setStopRequested(true);
    const operation = (async () => {
      try {
        await sendAgentCommand(sid, { type: bashRunningRef.current ? "abort_bash" : "abort" });
      } catch (e) {
        setStopRequested(false);
        console.error("Failed to abort:", e);
        addNotice({ type: "error", message: "停止请求未确认，请重试。" });
      }
    })();
    stopInFlightRef.current = operation;
    try { await operation; }
    finally { if (stopInFlightRef.current === operation) stopInFlightRef.current = null; }
  }, [addNotice]);

  const handleFork = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    setForkingEntryId(entryId);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        entryId,
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
      }
    } catch (e) {
      console.error("Fork failed:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setForkingEntryId(null);
    }
  }, [addNotice, onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string): Promise<boolean> => {
    if (bashRunningRef.current) return false;
    const sid = sessionIdRef.current;
    if (!sid) return false;
    bumpSessionEpoch(sid);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, {
        type: "navigate_tree",
        targetId: entryId,
      });
      if (result?.cancelled || sessionIdRef.current !== sid) return false;
      await loadSession(sid);
      return sessionIdRef.current === sid;
    } catch (e) {
      console.error("Failed to navigate:", e);
      return false;
    }
  }, [loadSession]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    // pi refuses navigate_tree mid-run: it moves the one leaf the running agent
    // appends to. Switching only the view would render the live run under
    // another branch, so the switch waits for the run like the server does.
    if (bashRunningRef.current || agentRunningRef.current || isCompacting) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    bumpSessionEpoch(sid);
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [isCompacting, loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const supported = modelThinkingLevels[`${provider}:${modelId}`];
      if (thinkingLevelOverrideRef.current !== null) {
        const effective = clampModelThinkingLevel(thinkingLevelOverrideRef.current, supported);
        thinkingLevelOverrideRef.current = effective;
        setNewSessionThinkingLevel(effective);
      }
      if (thinkingLevelOverrideRef.current === null) {
        const pinned = thinkingLevelPinsRef.current[`${provider}/${modelId}`];
        setNewSessionDefaultThinkingLevel(
          clampModelThinkingLevel(asConcreteThinkingLevel(pinned) ?? defaultThinkingLevelRef.current, supported),
        );
      }
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      const selected = await sendAgentCommand<{ provider: string; id: string }>(sid, { type: "set_model", provider, modelId });
      setLiveModel({ provider: selected.provider, modelId: selected.id });
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `切换模型失败：${e instanceof Error ? e.message : String(e)}`,
      });
      // A failed response can still follow a server-side write (for example, a
      // dropped connection), so let the session file settle the displayed model.
      await loadSession(sid, false, true);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, currentModelOverride, isNew, loadSession, modelThinkingLevels, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    if (sessionIdRef.current) bumpSessionEpoch(sessionIdRef.current);
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    let d: ModelsResponse;
    try {
      const timeoutSignal = AbortSignal.timeout(12_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const res = await fetch(modelsUrl, { signal: requestSignal });
      if (!res.ok) {
        let detail = "";
        try {
          const body: unknown = await res.json();
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
            detail = body.error;
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError") throw e;
          // Non-JSON error responses fall back to the HTTP status.
        }
        throw new Error(detail || `暂时无法获取模型（HTTP ${res.status}），请稍后重试。`);
      }
      d = await res.json() as ModelsResponse;
      signal?.throwIfAborted();
      // Older servers returned an empty failure catalog with HTTP 200.
      // Do not erase usable models or treat that response as recovery.
      if (d.modelError && !(d.modelList?.length || Object.keys(d.models ?? {}).length)) {
        throw new Error(d.modelError);
      }
    } catch (e) {
      if (!signal && !(e instanceof DOMException && e.name === "AbortError")) {
        setModelError("暂时无法获取模型，请稍后重试。");
      }
      throw e;
    }
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    const displayDefaultModel = d.defaultModel
      ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
      : undefined;
    setNewSessionDefaultModel(displayDefaultModel
      ? { provider: displayDefaultModel.provider, modelId: displayDefaultModel.id }
      : null);
    thinkingLevelPinsRef.current = d.thinkingLevelPins ?? {};
    defaultThinkingLevelRef.current = asConcreteThinkingLevel(d.defaultThinkingLevel);
    if (isNew && !sessionIdRef.current) {
      // The first listed model is not necessarily the runtime's automatic choice.
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayDefaultModel && d.thinkingLevelPins?.[`${displayDefaultModel.provider}/${displayDefaultModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setNewSessionDefaultThinkingLevel(
          asConcreteThinkingLevel(pinned) ?? defaultThinkingLevelRef.current,
        );
      }
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (!result.action) {
        // A command that opens a panel says nothing: the panel is the answer.
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "auto-compact": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          // Read the live wrapper (this POST starts it if idle) so the toggle
          // follows settings.json, not the React default of `true`.
          const liveState = await sendAgentCommand<AgentStateResponse>(sid, { type: "get_state" });
          const nextEnabled = !(liveState?.autoCompactionEnabled ?? true);
          await sendAgentCommand(sid, {
            type: "set_auto_compaction",
            enabled: nextEnabled,
          });
          setAutoCompactionEnabled(nextEnabled);
          return complete({
            handled: true,
            message: nextEnabled
              ? "Auto-compaction enabled"
              : "Auto-compaction disabled",
          });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "mcp": {
          // Only a bare /mcp, and only when pi's built-in MCP extension owns it or
          // nothing does (lib/mcp-command.ts): another extension's /mcp is sent as
          // before, and so is every subcommand, since `/mcp login`, `logout` and
          // `reconnect` act on this session's own connections. Returning before
          // onSend leaves no "/mcp" bubble and no sidebar row for a new chat; a
          // streaming run is not touched.
          if (args || !onOpenSettings) return { handled: false };
          const commands = await slashCommandsForMcp();
          if (!commands || !bareMcpOpensSettings(commands)) return { handled: false };
          onOpenSettings("mcp");
          return complete({ handled: true, action: "openSettings" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "clone": {
          if (!sid) return complete({ handled: true, error: "No active session to clone" });
          if (agentRunningRef.current || bashRunningRef.current) {
            return complete({ handled: true, error: "Cannot clone while the session is running" });
          }
          const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
            type: "clone",
            leafId: activeLeafId,
          });
          if (result?.cancelled || !result?.newSessionId) {
            return complete({ handled: true, error: "Cannot clone an empty or unsaved session" });
          }
          const completed = complete({ handled: true, message: "Cloned current session branch" });
          onSessionForked?.(result.newSessionId);
          return completed;
        }

        default:
          return { handled: false };
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [activeLeafId, addNotice, ensureNewSession, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onOpenSettings, onSessionForked, onSessionStatsPanelOpen, slashCommandsForMcp]);

  // Let AgentSession.prompt decide atomically whether to queue against the
  // current run or start a new turn if it settled while the request was in
  // flight. Direct steer/followUp calls can strand a message in an idle queue.
  const sendStreamingPrompt = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
    onRegistered?: (identity: PromptSubmissionPreviewIdentity) => void,
  ) => {
    const sid = sessionIdRef.current;
    const restore = () => restoreSubmission(message, images, composerDraftKey);
    if (!sid) {
      restore();
      addNotice({ type: "error", message: "No active session for the queued message" });
      return;
    }
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let dispatched = false;
    try {
      // A stale busy indicator can outlive the idle SSE grace window. Listen
      // before submitting so an idle fallback run cannot become invisible.
      await ensureEventsConnected(sid);
      dispatched = true;
      await sendAgentCommand(sid, {
        type: "prompt",
        message,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      }, { onPromptRegistered: (identity) => onRegistered?.({ ...identity, draftKey: composerDraftKey }) });
    } catch (e) {
      console.error("Failed to submit streaming prompt:", e);
      // A transport failure after dispatch is ambiguous: the server may have
      // accepted the queued prompt before the response was lost. Restoring in
      // that case would invite a duplicate turn.
      if (!dispatched || isPromptRejectedError(e)) restore();
      addNotice({
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [addNotice, composerDraftKey, restoreSubmission, ensureEventsConnected]);

  const confirmPendingSubmission = useCallback(async (row: PendingPromptSubmission, recoverRecall = true) => {
    try {
      const receipt = await readPromptReceipt(row.sessionId, row.requestId);
      const current = getPendingPromptSubmissions().find((item) => item.requestId === row.requestId);
      if (!current) return;
      if (receipt.status === "committed") {
        releasePromptSubmission(row.requestId);
        if (sessionHookMountedRef.current && sessionIdRef.current === row.sessionId) {
          maintainEventsConnected(row.sessionId);
          promoteNewSession(1, row.message);
          void loadSession(row.sessionId);
          void reconcileAgentState(row.sessionId);
        }
      } else if (receipt.status === "recalled") {
        if (current.status !== "recalled") markPromptSubmissionsRecalled([row.requestId]);
        // Automatic checks expose the saved original; only an explicit recovery
        // action restores it. A delayed recall response cannot duplicate a draft.
        if (recoverRecall) {
          if (!current.recallRestored) restoreSubmission(row.message, row.images, row.sessionId);
          await acknowledgeRecalledPrompts(row.sessionId, [row.requestId]);
        }
      } else if (receipt.status === "cancelled") {
        // Delete or an acknowledged recall already owns removal. Do not
        // resurrect cancelled queue contents in an unrelated composer.
        releasePromptSubmission(row.requestId);
      } else if (["accepted", "pending", "unknown", "unconfirmed"].includes(receipt.status)) {
        reconcilePromptSubmission(row.requestId, receipt);
      } else if (receipt.status === "rejected") {
        // Preserve the original owner even if this read returns after a switch.
        restoreSubmission(row.message, row.images, row.sessionId);
        releasePromptSubmission(row.requestId);
        if (isNew && newSessionDraftKey && sessionIdRef.current === row.sessionId) onSessionSubmissionChange?.(newSessionDraftKey, null);
        if (sessionIdRef.current === row.sessionId) addNotice({ type: "error", message: `消息未发送，已退回输入框：${receipt.error ?? "请求被拒绝"}` });
      }
    } catch { /* Original contents remain visible and durable until confirmed. */ }
  }, [addNotice, loadSession, maintainEventsConnected, promoteNewSession, reconcileAgentState, restoreSubmission, isNew, newSessionDraftKey, onSessionSubmissionChange]);

  // Metadata/UI callbacks may change each render. Keep the existing recovery
  // clock stable while using the latest owner when a receipt check runs.
  const confirmUncertainSubmission = useEffectEvent((row: PendingPromptSubmission) => confirmPendingSubmission(row, false));
  useEffect(() => {
    const pending = unconfirmedSubmissions.filter((row) => row.status !== "recalled");
    if (!pending.length) return;
    let active = true;
    let checking = false;
    const check = async () => {
      if (!active || checking) return;
      checking = true;
      try { for (const row of pending) {
        if (!active) break;
        if (!isPromptSubmissionDispatching(row.requestId)) await confirmUncertainSubmission(row);
      } }
      finally { checking = false; }
    };
    void check();
    const interval = setInterval(() => { if (document.visibilityState === "visible") void check(); }, 8000);
    const onOnline = () => { void check(); };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; clearInterval(interval); window.removeEventListener("online", onOnline); document.removeEventListener("visibilitychange", onVisible); };
  }, [unconfirmedSubmissions]);

  const handleSteer = useCallback(async (message: string, images?: AttachedImage[], onRegistered?: (identity: PromptSubmissionPreviewIdentity) => void) => {
    await sendStreamingPrompt(message, "steer", images, onRegistered);
  }, [sendStreamingPrompt]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
    onRegistered?: (identity: PromptSubmissionPreviewIdentity) => void,
  ) => {
    await sendStreamingPrompt(message, behavior, images, onRegistered);
  }, [sendStreamingPrompt]);

  const handleFollowUp = useCallback(async (message: string, images?: AttachedImage[], onRegistered?: (identity: PromptSubmissionPreviewIdentity) => void) => {
    await sendStreamingPrompt(message, "followUp", images, onRegistered);
  }, [sendStreamingPrompt]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const targetDraftKey = composerDraftKey ?? sid;
    await recallSessionQueue({
      sessionId: sid,
      targetDraftKey,
      sendCommand: sendAgentCommand,
      restoreSubmission,
      isSameSession: (originSid) => sessionHookMountedRef.current && sessionIdRef.current === originSid,
      clearQueuedMessagesUi: () => setQueuedMessages({ steering: [], followUp: [] }),
      onError: (message, e) => {
        console.error("Failed to recall queued messages:", e);
        addNotice({ type: "error", message });
      },
    });
  }, [addNotice, composerDraftKey, restoreSubmission]);

  const handleThinkingLevelChange = useCallback(async (requested: ThinkingLevelOption) => {
    const level = requested === "auto" ? "auto" : clampModelThinkingLevel(requested, displayModel
      ? modelThinkingLevels[`${displayModel.provider}:${displayModel.modelId}`] : null)!;
    if (level === "auto") {
      thinkingLevelOverrideRef.current = null;
      setNewSessionThinkingLevel(null);
      setCurrentThinkingOverride(null);
      return;
    }
    if (isNew) {
      thinkingLevelOverrideRef.current = level;
      setNewSessionThinkingLevel(level);
    } else {
      setCurrentThinkingOverride(level);
    }
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{ thinkingLevel?: string }>(sid, { type: "set_thinking_level", level });
      if (sessionHookMountedRef.current && sessionIdRef.current === sid) {
        setLiveThinkingLevel(asConcreteThinkingLevel(result?.thinkingLevel) ?? level);
        setCurrentThinkingOverride(null);
      }
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      setCurrentThinkingOverride(null);
      addNotice({ type: "error", message: `设置思考深度失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }, [addNotice, displayModel, isNew, modelThinkingLevels]);

  const handleToolPresetChange = useCallback(async (preset: ToolPreset) => {
    const toolNames = getToolNamesForPreset(preset);
    setPreferredToolPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) {
      sessionToolsPinnedRef.current = toolNames !== undefined;
      return;
    }
    try {
      // Omitting toolNames retracts the session's pin so it follows the configured
      // defaults again; the server rebuilds the session to resolve them.
      const result = await sendAgentCommand<{ sessionId?: string; recreated?: boolean }>(sid, {
        type: "set_tools",
        ...(toolNames !== undefined ? { toolNames } : {}),
      });
      sessionToolsPinnedRef.current = toolNames !== undefined;
      const activeSessionId = result?.sessionId ?? sid;
      if (activeSessionId !== sid || result?.recreated) {
        cancelEventStreamGrace();
        closeEvents();
        // The old wrapper cancels its pending extension UI only after its stream has
        // closed, so those close events never arrive; drop the requests here instead
        // of leaving them queued in front of the new wrapper's.
        setExtensionDialogs([]);
        setExtensionCustomUis([]);
        sessionIdRef.current = activeSessionId;
        if (result?.recreated && sessionPropIdRef.current === activeSessionId) {
          maintainEventsConnected(activeSessionId);
        }
      }
      clearSlashCommands();
      setExtensionStatuses([]);
      setExtensionWidgets([]);
      const [state] = await Promise.all([
        sendAgentCommand<AgentStateResponse>(activeSessionId, { type: "get_state" }),
        loadTools(activeSessionId),
      ]);
      if (sessionHookMountedRef.current && sessionIdRef.current === activeSessionId) {
        setSystemPrompt(state.systemPrompt ?? "");
        syncLiveModel(state);
      }
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [cancelEventStreamGrace, clearSlashCommands, closeEvents, loadTools, maintainEventsConnected, setToolPresetState, syncLiveModel]);

  const scrollToMessage = useCallback((element: HTMLElement, viewportOffset = 16) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    initialScrollDoneRef.current = true;
    pendingScrollToUserRef.current = false;
    isNearBottomRef.current = false;
    setPromptAnchorActive(false);
    container.scrollTo({
      top: element.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        + container.scrollTop
        - viewportOffset,
      behavior: "instant",
    });
    previousScrollTopRef.current = container.scrollTop;
  }, []);

  const scrollUserMsgToTop = useCallback(() => {
    const container = scrollContainerRef.current;
    const el = lastUserMsgRef.current;
    if (!container || !el) return;
    const elAbsTop = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const targetTop = Math.min(Math.max(0, elAbsTop - 16), maxScrollTop);

    if (liveFollowFrameRef.current !== null) {
      cancelAnimationFrame(liveFollowFrameRef.current);
      liveFollowFrameRef.current = null;
    }
    isNearBottomRef.current = true;
    previousScrollTopRef.current = targetTop;
    container.scrollTo({ top: targetTop, behavior: "auto" });
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      const { scrollTop, clientHeight, scrollHeight } = container;
      const isAgentRunning = agentRunningRef.current;
      const wasAttached = isNearBottomRef.current;
      const isAttached = getLiveFollowAttached(
        wasAttached,
        previousScrollTopRef.current,
        scrollTop,
        clientHeight,
        scrollHeight,
        isAgentRunning
          ? CHAT_SCROLL_REATTACH_TOLERANCE
          : CHAT_SCROLL_TAIL_TOLERANCE,
      );
      isNearBottomRef.current = isAttached;
      previousScrollTopRef.current = scrollTop;
      const shouldShow = shouldShowScrollToLatest(scrollTop, clientHeight, scrollHeight);
      setShowScrollToBottom((previous) => (previous === shouldShow ? previous : shouldShow));
      if (!wasAttached && isAttached && isAgentRunning) {
        scrollToBottom("auto");
      } else if (!isAttached && liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
    }
  }, [scrollToBottom]);

  useEffect(() => {
    let cacheEnabled = isSessionMemoryCacheEnabled();
    const invalidate = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key !== null && event.key !== "pi-enh-settings-v1" && event.key !== "pi-enh-plugin-session-memory-cache") return;
        // Other tabs also save unrelated settings into the shared preference
        // object. Only a cache preference transition invalidates resident chats.
        const nextEnabled = isSessionMemoryCacheEnabled(window.localStorage);
        if (nextEnabled === cacheEnabled) return;
        cacheEnabled = nextEnabled;
      } else {
        cacheEnabled = isSessionMemoryCacheEnabled();
      }
      clearSessionViewCache();
      const sid = sessionIdRef.current;
      if (sid) {
        bumpSessionEpoch(sid);
        if (dataRef.current) dataRef.current = { ...dataRef.current, snapshotRevision: null };
        void loadSession(sid, messagesRef.current.length === 0, true);
      }
    };
    window.addEventListener("pi:session-cache-change", invalidate);
    window.addEventListener("storage", invalidate);
    return () => {
      window.removeEventListener("pi:session-cache-change", invalidate);
      window.removeEventListener("storage", invalidate);
    };
  }, [loadSession]);

  // Paging widens the resident view without altering the exact wire baseline.
  // Its suffix must still match the certified tail before it can be reused.
  function saveResidentView() {
      const sid = sessionIdRef.current;
      const currentData = dataRef.current;
      const syncEnabled = isSessionMemoryCacheEnabled();
      if (syncEnabled && !agentRunningRef.current && sid && currentData && currentData.sessionId === sid && currentData.snapshotRevision
        && messagesRef.current.length === entryIdsRef.current.length) {
        const existing = getSessionViewSnapshot(sid, false);
        const entryIds = entryIdsRef.current;
        if (existing?.messages === messagesRef.current && existing.entryIds === entryIds) return;
        const wire = getSessionWireBaseline(sid, false);
        const coverable = Boolean(wire && viewMatchesBaseline(wire, messagesRef.current, entryIds));
        if (coverable) {
          setSessionViewSnapshot({
            sessionId: sid,
            revision: currentData.snapshotRevision,
            messages: messagesRef.current,
            entryIds: entryIdsRef.current,
            leafId: activeLeafIdRef.current,
            oldestEntryId: historyCursorRef.current,
            hasMore: hasEarlierMessagesRef.current,
            summaryTree: currentData.tree,
            thinkingLevel: currentData.context.thinkingLevel,
            model: currentData.context.model,
            stats: currentData.stats,
            totalActiveMs: currentData.totalActiveMs,
            loadedEntryIds: entryIdsRef.current,
          });
        }
      }
  }
  useLayoutEffect(() => {
    saveResidentView();
    // The snapshot uses the current refs; these fields identify a settled view change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, messages, entryIds, agentRunning]);

  // Load session on mount
  useEffect(() => {
    sessionHookMountedRef.current = true;
    if (session) {
      sessionIdRef.current = session.id;
      // Paint a resident view immediately; list revisions and native events
      // invalidate it. Mounting a chat never forces wrapper reconstruction.
      // Only the settled history fields are restored — no streaming, queue, or
      // run state — and the background read remains authoritative.
      // The initial render already owns a resident snapshot. Only fill a cache
      // that arrived between render and this effect; never blank a visible view.
      const preview = !dataRef.current ? getResidentSessionData(session.id) : null;
      if (preview) {
        dataRef.current = preview; messagesRef.current = preview.context.messages; entryIdsRef.current = preview.context.entryIds;
        historyCursorRef.current = preview.context.oldestEntryId; hasEarlierMessagesRef.current = preview.context.hasMore;
        setData(preview); setActiveLeafId(preview.leafId);
        setMessages(preview.context.messages); setEntryIds(preview.context.entryIds);
        setHistoryCursor(preview.context.oldestEntryId); setHasEarlierMessages(preview.context.hasMore);
        setError(null); setLoading(false);
      }
      const cached = Boolean(dataRef.current);
      loadSession(session.id, !cached, true, { resident: true }).then((loadedAgentState) => {
        const agentState = loadedAgentState as { running: boolean; state?: AgentStateResponse } | null;
        if (agentState?.running) {
          loadTools(session.id);
          if (agentState.state?.isStreaming || agentState.state?.isPromptRunning) {
            sdkAgentActiveRef.current = Boolean(agentState.state.isStreaming);
            rpcPromptPendingRef.current = Boolean(agentState.state.isPromptRunning);
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "resume" });
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id, promptRunIdRef.current);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
        } else if (agentState?.running === false && agentRunningRef.current && !rpcPromptPendingRef.current) {
          // The mount snapshot may predate a local completion; confirm again
          // through the run-guarded reconciliation path before clearing it.
          void reconcileAgentState(session.id);
        }
        if (agentState?.state) {
          if (agentState.state.isCompacting !== undefined) setIsCompacting(agentState.state.isCompacting);
          if (agentState.state.contextUsage !== undefined) setContextUsage(agentState.state.contextUsage ?? null);
          if (agentState.state.systemPrompt !== undefined) setSystemPrompt(agentState.state.systemPrompt ?? null);
          if (agentState.state.extensionStatuses !== undefined) setExtensionStatuses(agentState.state.extensionStatuses ?? []);
          if (agentState.state.extensionWidgets !== undefined) setExtensionWidgets(agentState.state.extensionWidgets ?? []);
          if (agentState.state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(agentState.state.queuedMessages));
        }
      });
    }
    return () => {
      sessionHookMountedRef.current = false;
      const abandonedDraftKey = isNew ? newSessionDraftKey : null;
      if (abandonedDraftKey) {
        queueMicrotask(() => {
          if (!sessionHookMountedRef.current && !newSessionPromotedRef.current) {
            clearDraft(abandonedDraftKey);
          }
        });
      }
      saveResidentView();
      if (liveFollowFrameRef.current !== null) {
        cancelAnimationFrame(liveFollowFrameRef.current);
        liveFollowFrameRef.current = null;
      }
      bashRecoveryIdRef.current += 1;
      cancelEventStreamGrace();
      closeEvents();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    onSystemInfoLoaderChange?.(loadSystemInfo);
    return () => onSystemInfoLoaderChange?.(null);
  }, [loadSystemInfo, onSystemInfoLoaderChange]);

  const branchSwitchLocked = agentRunning || bashRunning || isCompacting;
  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange, branchSwitchLocked);
  }, [data?.tree, activeLeafId, handleLeafChange, branchSwitchLocked, onBranchDataChange]);

  const loadSessionRef = useRef(loadSession);
  loadSessionRef.current = loadSession;
  useLayoutEffect(() => {
    return registerSessionReloadAliases(getEnhancementWindow(), {
      getSessionId: () => sessionIdRef.current ?? sessionPropIdRef.current ?? null,
      getSessionData: () => {
        const current = dataRef.current;
        if (!current || current.sessionId !== sessionIdRef.current
          || (sessionPropIdRef.current !== null && sessionPropIdRef.current !== current.sessionId)
          || messagesRef.current.length !== entryIdsRef.current.length) return null;
        return { ...current, context: { ...current.context,
          messages: messagesRef.current, entryIds: entryIdsRef.current,
          oldestEntryId: historyCursorRef.current, hasMore: hasEarlierMessagesRef.current,
        } };
      },
      isActive: () => (
        sessionHookMountedRef.current
        && Boolean(
          sessionIdRef.current
          && (sessionPropIdRef.current === null || sessionPropIdRef.current === sessionIdRef.current),
        )
      ),
      reloadSession: (sid, showLoading = false, includeState = true, options) => (
        loadSessionRef.current(sid, showLoading, includeState, options)
      ),
    });
  }, [session?.id]);

  useLayoutEffect(() => {
    // Enhancement metrics consume the native settled history. No second fetch,
    // message store or event stream is created by this notification.
    if (data?.sessionId && data.sessionId === sessionIdRef.current) {
      window.dispatchEvent(new CustomEvent("pi-native-session-data-change", { detail: { sessionId: data.sessionId } }));
    }
  }, [data, messages, entryIds]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    previousScrollTopRef.current = container.scrollTop;
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange]);

  useEffect(() => {
    if (!agentRunning) setPromptAnchorActive(false);
  }, [agentRunning]);

  useLayoutEffect(() => {
    if (opts.deferInitialScroll) return;
    if (messages.length > 0) {
      if (pendingScrollToUserRef.current) {
        pendingScrollToUserRef.current = false;
        initialScrollDoneRef.current = true;
        scrollUserMsgToTop();
      } else if (!initialScrollDoneRef.current) {
        initialScrollDoneRef.current = true;
        scrollToBottom("instant");
      } else if (!agentRunningRef.current && isNearBottomRef.current) {
        scrollToBottom("auto");
      }
    }
  }, [messages.length, agentRunning, scrollToBottom, scrollUserMsgToTop, opts.deferInitialScroll]);

  // Keep transient failures out of the composer while bounded recovery runs.
  useEffect(() => {
    const controller = new AbortController();
    setModelsLoading(true);
    (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await loadModels(controller.signal);
          setModelsLoading(false);
          return;
        } catch (e) {
          if (controller.signal.aborted) return;
          if (e instanceof DOMException && e.name === "AbortError") return;
          if (attempt >= MODELS_RETRY_DELAYS_MS.length) {
            setModelError("暂时无法获取模型，请稍后重试。");
            setModelsLoading(false);
            return;
          }
          await delay(MODELS_RETRY_DELAYS_MS[attempt]);
          if (controller.signal.aborted) return;
        }
      }
    })();
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  // Pause notice expiry while hovered or focused.
  // The remainingMs/startedAt/oldestId refs implement a true pause-and-resume instead of resetting the 5s timer.
  const [pausedNoticeId, setPausedNoticeId] = useState<string | null>(null);
  const noticeRemainingMsRef = useRef(NOTICE_VISIBLE_MS);
  const noticeTimerStartedAtRef = useRef<number | null>(null);
  const noticeOldestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (noticeState.visible.length === 0) {
      noticeOldestIdRef.current = null;
      return;
    }
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    // Oldest visible notice changed; restart the countdown
    if (noticeOldestIdRef.current !== oldest.id) {
      noticeOldestIdRef.current = oldest.id;
      noticeRemainingMsRef.current = NOTICE_VISIBLE_MS;
    }
    if (noticeState.visible.some((notice) => notice.id === pausedNoticeId)) return;
    noticeTimerStartedAtRef.current = Date.now();
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, noticeRemainingMsRef.current);
    return () => {
      clearTimeout(t);
      // Accrue the elapsed time so the countdown resumes from the remaining time
      if (noticeTimerStartedAtRef.current !== null) {
        noticeRemainingMsRef.current = Math.max(
          0,
          noticeRemainingMsRef.current - (Date.now() - noticeTimerStartedAtRef.current),
        );
        noticeTimerStartedAtRef.current = null;
      }
    };
  }, [noticeState.visible, pausedNoticeId]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  // Native error UI reuses the existing read-only loader; no second session/cache state machine.
  const retryLoadSession = useCallback(() => {
    const sid = session?.id ?? sessionIdRef.current;
    if (sid) {
      setError(null);
      void loadSession(sid, true, true, { force: true });
    }
  }, [session?.id, loadSession]);

  const thinkingLevel: ThinkingLevelOption = displayThinkingLevel ?? "auto";
  // The head of each queue is on screen; the rest wait behind it.
  const extensionDialog = extensionDialogs[0] ?? null;
  const waitingExtensionDialogCount = Math.max(0, extensionDialogs.length - 1);
  const extensionCustomUi = extensionCustomUis[0] ?? null;
  const waitingExtensionCustomUiCount = Math.max(0, extensionCustomUis.length - 1);

  return {
    // State
    data, loading, error, activeLeafId, messages, activeToolResults, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, modelNames, modelList, modelError, modelsLoading, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, newSessionModel, toolPreset, thinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, modelSwitching, sessionStats, autoCompactionEnabled,
    slashCommands, slashCommandsLoading, queuedMessages, unconfirmedSubmissions, confirmPendingSubmission,
    notices: noticeState.visible, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    isAutoThinkingSelection: isNew && newSessionThinkingLevel === null,
    agentPhase: stopRequested && (agentRunning || bashRunning) ? { kind: "stopping" } as AgentPhase : agentPhase,
    isNew,
    promptAnchorActive, promptScrollRevision,
    showScrollToBottom,
    // Refs
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, pendingScrollToUserRef, initialScrollDoneRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    setNoticePaused: setPausedNoticeId,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, setActiveLeafId, setData, setMessages, loadContext,
    scrollToBottom, scrollUserMsgToTop, scrollToMessage,
    retryLoadSession,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
