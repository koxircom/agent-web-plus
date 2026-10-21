"use client";

import { userMessageRenderKey, userMessageRequestId } from "@/lib/prompt-recovery";

import { createToolProcessSummary, getToolProcessSummaryLabel, includeToolInProcessSummary, type ToolProcessSummary } from "@/lib/tool-public-status";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { isHiddenCustomMessage, isMessageGroupAnchor } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { buildQuotedSelection } from "@/lib/quoted-selection";
import { MessageView } from "./MessageView";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { getInlineSuggestion } from "@/lib/inline-suggestion";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { AnsiText } from "./AnsiText";
import { AskUserSurface, AskUserTextPanel, ExtensionWaitingCount } from "./AskUserPanel";
import { ChatScrollToBottom } from "./ChatScrollToBottom";
import { NoticeShelf } from "./NoticeShelf";
import { NewSessionBrandHeader } from "./NewSessionBrandHeader";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile, allowsAutomaticEditableFocus, focusEditable } from "@/hooks/useIsMobile";
import { useChatColumnInset } from "@/hooks/useChatColumnInset";
import { useScrollbarVisibility } from "@/hooks/useScrollbarVisibility";
import { useMobileHorizontalSwipe } from "@/hooks/useMobileHorizontalSwipe";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { ToolEntry } from "@/lib/tool-presets";
import type { SettingsSection } from "@/lib/settings-navigation";
import { findChatScrollAnchor, type ChatScrollPosition } from "@/lib/chat-scroll-position";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getPromptAnchorSpacerHeight,
  getVisibleRenderWindow,
  isScrollAtTail,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";
import { getHistoryLoadAction } from "@/lib/chat-history-pagination";
import {
  buildEnhancementHistoryState,
  createEarlierHistoryLoader,
  getEnhancementWindow,
  installNativeProcessCollapseFlag,
  isEnhancementPluginEnabled,
  registerHistoryViewportBridges,
  splitAssistantDisplayRuns,
} from "@/lib/enhancement-chat-bridge";

interface Props {
  session: SessionInfo | null;
  executionEngine?: "pi" | "codex";
  mobileNavigationOpen?: boolean;
  onMobileNavigationOpenChange?: (open: boolean) => void;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
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
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** Opens Settings on a section: a bare `/mcp` that pi's built-in MCP extension owns opens Settings › MCP. */
  onOpenSettings?: (section: SettingsSection) => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string, page?: number) => void;
  onOpenSession?: (sessionId: string) => void;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: () => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    return t("chat.runningTool");
  }
  if (phase?.kind === "stopping") return t("chat.stopping");
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

const CHAT_MINIMAP_WIDTH = 36;
const CHAT_COLUMN_PADDING = 16;

type HistoryLoadStatus = "idle" | "loading" | "error";
type HistoryLoadOperation = { id: number; sessionId: string | null; leafId: string | null; settled: boolean };

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function ProcessDetailsGroup({ toolStates, streamingThinking = false, reveal = false, children, t }: { toolStates: ToolProcessSummary; streamingThinking?: boolean; reveal?: boolean; children: ReactNode; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (reveal) setExpanded(true);
  }, [reveal]);
  const label = getToolProcessSummaryLabel(toolStates, t, streamingThinking);

  return (
    <div data-pi-native-tool-summary="true" data-pi-enh-native-process="true" style={{ marginBottom: 12 }}>
      <button
        type="button"
        aria-expanded={expanded || reveal}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          minWidth: 0,
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
        title={`${label} · ${expanded || reveal ? t("chat.collapseProcess") : t("chat.expandProcess")}`}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>
          <polyline points="4 2.5 7.5 6 4 9.5" />
        </svg>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
      </button>
      {(expanded || reveal) && (
        <div style={{ marginTop: 8 }}>
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ mobileNavigationOpen = false, onMobileNavigationOpenChange, session, executionEngine = "pi", searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionSubmissionChange, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onOpenSettings, onContextUsageChange, onOpenFile, onOpenSession, onAskInNewChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const isCodexSession = executionEngine === "codex" || session?.id.startsWith("codex:") === true;
  // Only structural whitespace is a navigation shortcut. Text and controls keep
  // native selection, zoom, horizontal scrolling and click behavior.
  const closeMobileNavigation = useCallback(() => onMobileNavigationOpenChange?.(false), [onMobileNavigationOpenChange]);
  const blankTapRef = useRef<{ pointerId: number; x: number; y: number; at: number } | null>(null);
  const previousBlankTapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const resetBlankTap = useCallback(() => {
    blankTapRef.current = null;
    previousBlankTapRef.current = null;
  }, []);
  useEffect(resetBlankTap, [session?.id, newSessionDraftKey, isMobile, resetBlankTap]);
  const isBlankNavigationTarget = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Chromium may adjust touch targets toward nearby text/controls. Test the
    // physical point, so whitespace is distinguished from content itself.
    const target = document.elementFromPoint(event.clientX, event.clientY);
    if (!(target instanceof HTMLElement) || window.getSelection()?.toString().trim()) return false;
    return target.matches("[data-pi-native-scroll-owner], [data-chat-navigation-blank], [data-pi-native-message-column], [data-scroll-anchor]");
  };
  const handleBlankPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isMobile || mobileNavigationOpen || event.pointerType !== "touch" || !event.isPrimary || !isBlankNavigationTarget(event)) {
      resetBlankTap();
      return;
    }
    blankTapRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp };
  };
  const handleBlankPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = blankTapRef.current;
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) resetBlankTap();
  };
  const handleBlankPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = blankTapRef.current;
    blankTapRef.current = null;
    if (!start || start.pointerId !== event.pointerId || !event.isPrimary || event.timeStamp - start.at > 300 || !isBlankNavigationTarget(event)
      || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
      previousBlankTapRef.current = null;
      return;
    }
    const previous = previousBlankTapRef.current;
    if (previous && event.timeStamp - previous.at <= 300 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) <= 24) {
      previousBlankTapRef.current = null;
      onMobileNavigationOpenChange?.(true);
    } else previousBlankTapRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
  };

  useEffect(() => {
    installNativeProcessCollapseFlag();
  }, []);
  const completionNotificationsEnabled = session?.relation?.kind !== "subagent";

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const extensionDialogShownRef = useRef(false);
  const wrappedOnAgentEnd = useCallback(() => {
    if (completionNotificationsEnabled && soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.();
  }, [completionNotificationsEnabled, onAgentEnd]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);

  const {
    loading, error, messages, activeToolResults, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelsLoading, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats, navigationTotalTurns,
    slashCommands, slashCommandsLoading, queuedMessages, queueSyncStatus, unconfirmedSubmissions,
    notices, extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput, setNoticePaused, dismissNotice,
    isAutoModelSelection,
    isAutoThinkingSelection,
    agentPhase,
    isNew,
    showScrollToBottom,
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive, promptScrollRevision,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue, handleRestoreRecall,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, scrollUserMsgToTop,
    loadContext, activeLeafId, scrollToBottom, scrollToMessage,
    retryLoadSession,
  } = useAgentSession({
    executionEngine: isCodexSession ? "codex" : "pi",
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionSubmissionChange, onSessionForked,
    modelsRefreshKey, chatInputRef,
    onBranchDataChange: isCodexSession ? undefined : onBranchDataChange,
    onSystemPromptChange: isCodexSession ? undefined : onSystemPromptChange,
    onSystemToolsChange: isCodexSession ? undefined : onSystemToolsChange,
    onSystemInfoLoaderChange: isCodexSession ? undefined : onSystemInfoLoaderChange,
    onSessionStatsPanelOpen,
    onOpenSettings: isCodexSession ? undefined : onOpenSettings,
    deferInitialScroll: Boolean(pendingScrollRestore),
  });
  const sessionBusy = agentRunning || bashRunning;
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
    quickQuote: boolean;
    nativeQuote: boolean;
    sourceEntryId?: string;
  } | null>(null);
  const quotedRangeRef = useRef<Range | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const quickQuoteToolbar = Boolean(quotedSelection?.quickQuote && !quoteInputOpen);
  const closeQuotedSelection = useCallback(() => {
    quotedRangeRef.current = null;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("pi-web:native-selection-change", { detail: null }));
    }
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  const closeQuotedSelectionRef = useRef(closeQuotedSelection);
  closeQuotedSelectionRef.current = closeQuotedSelection;
  useEffect(() => {
    const bridgeWindow = window as Window & {
      __PI_WEB_CLOSE_NATIVE_QUOTE_SELECTION__?: () => boolean;
    };
    const closeFromEnhancement = () => {
      if (!quotedRangeRef.current) return false;
      closeQuotedSelectionRef.current();
      return true;
    };
    bridgeWindow.__PI_WEB_CLOSE_NATIVE_QUOTE_SELECTION__ = closeFromEnhancement;
    return () => {
      if (bridgeWindow.__PI_WEB_CLOSE_NATIVE_QUOTE_SELECTION__ === closeFromEnhancement) {
        delete bridgeWindow.__PI_WEB_CLOSE_NATIVE_QUOTE_SELECTION__;
      }
    };
  }, []);

  useEffect(() => {
    if (!quoteSelectionEnabled) closeQuotedSelection();
  }, [quoteSelectionEnabled, closeQuotedSelection]);

  const captureQuotedSelection = useCallback(() => {
    if (quoteInputOpen) return;
    const clearSelection = () => {
      if (quotedRangeRef.current) closeQuotedSelection();
    };
    const enhancer = window as Window & {
      __PI_ENH_IS_PLUGIN_ENABLED__?: (pluginId: string) => boolean;
    };
    const quickQuote = Boolean(enhancer.__PI_ENH_IS_PLUGIN_ENABLED__?.("quick-quote"));
    if (!quickQuote && !quoteSelectionEnabled) {
      clearSelection();
      return;
    }
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      clearSelection();
      return;
    }
    const selectedElement = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    if (selectedElement?.closest("input, textarea, [contenteditable='true'], .pi-enh-annotation-editor, .pi-enh-annotation-list")) {
      clearSelection();
      return;
    }
    const text = selection.toString().trim();
    const rect = range.getBoundingClientRect();
    if (!text || (!rect.width && !rect.height)) {
      clearSelection();
      return;
    }
    const clonedRange = range.cloneRange();
    quotedRangeRef.current = clonedRange;
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer as Element
      : range.endContainer.parentElement;
    const sourceEntryId = [ancestor, start, end]
      .map((element) => element?.closest<HTMLElement>("[data-message-role=\"assistant\"]")?.dataset.entryId)
      .find((entryId): entryId is string => Boolean(entryId));
    const detail = { text, range: clonedRange, rect, sourceEntryId };
    window.dispatchEvent(new CustomEvent("pi-web:native-selection-change", { detail }));
    setQuotedSelection({
      text,
      top: rect.top,
      left: rect.left + rect.width / 2,
      quickQuote,
      nativeQuote: quoteSelectionEnabled,
      sourceEntryId,
    });
  }, [quoteSelectionEnabled, quoteInputOpen, closeQuotedSelection]);

  useEffect(() => {
    // Do not measure or publish intermediate ranges while a pointer is held.
    // Coalesce completion events into one frame in this single selection owner.
    let activePointer: number | null = null;
    let selectionFrame: number | null = null;
    const cancelSelectionFrame = () => {
      if (selectionFrame !== null) cancelAnimationFrame(selectionFrame);
      selectionFrame = null;
    };
    const scheduleSelection = () => {
      if (activePointer !== null || quoteInputOpen || selectionFrame !== null) return;
      selectionFrame = requestAnimationFrame(() => {
        selectionFrame = null;
        captureQuotedSelection();
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || quoteInputOpen) return;
      // Preserve the selected range when operating the toolbar itself.
      if (event.target instanceof Node && quotePopoverRef.current?.contains(event.target)) return;
      activePointer = event.pointerId;
      cancelSelectionFrame();
      if (quotedRangeRef.current) closeQuotedSelection();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (activePointer !== null && event.pointerId !== activePointer) return;
      if (event.target instanceof Node && quotePopoverRef.current?.contains(event.target)) return;
      activePointer = null;
      scheduleSelection();
    };
    const cancelSelectionGesture = () => {
      activePointer = null;
      cancelSelectionFrame();
      if (!quoteInputOpen && quotedRangeRef.current) closeQuotedSelection();
    };
    const onContextMenu = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true'], .pi-enh-annotation-editor, .pi-enh-annotation-list, .pi-enh-menu")) return;
      const enhancer = window as Window & { __PI_ENH_IS_MOBILE_ENV__?: () => boolean; __PI_ENH_IS_PLUGIN_ENABLED__?: (pluginId: string) => boolean };
      if (!quoteSelectionEnabled && !enhancer.__PI_ENH_IS_PLUGIN_ENABLED__?.("quick-quote")) return;
      const selection = window.getSelection();
      const hasSelection = Boolean(selection && !selection.isCollapsed && selection.toString().trim());
      if ((enhancer.__PI_ENH_IS_MOBILE_ENV__?.() ?? isMobile) || hasSelection) event.preventDefault();
      if (hasSelection) scheduleSelection();
    };
    document.addEventListener("selectionchange", scheduleSelection);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", cancelSelectionGesture);
    document.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("blur", cancelSelectionGesture);
    return () => {
      cancelSelectionFrame();
      document.removeEventListener("selectionchange", scheduleSelection);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", cancelSelectionGesture);
      document.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("blur", cancelSelectionGesture);
    };
  }, [captureQuotedSelection, closeQuotedSelection, isMobile, quoteInputOpen, quoteSelectionEnabled]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.insertIfEmpty(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
  }, [quoteInputOpen, quotedSelection, t]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const enhancer = window as Window & { __PI_ENH_IS_MOBILE_ENV__?: () => boolean };
    const mobile = enhancer.__PI_ENH_IS_MOBILE_ENV__?.() ?? isMobile;
    const range = quotedRangeRef.current;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
      const anchor = range?.startContainer.isConnected ? range.getBoundingClientRect() : null;
      const selectionTop = anchor?.top ?? quotedSelection.top;
      const selectionBottom = anchor?.bottom ?? quotedSelection.top;
      const selectionLeft = anchor ? anchor.left + anchor.width / 2 : quotedSelection.left;
      let top: number;
      if (quoteInputOpen) {
        top = Math.max(viewportTop + 8, Math.min(quotedSelection.top, viewportBottom - rect.height - 8));
      } else if (mobile) {
        const composer = document.querySelector<HTMLElement>("textarea.chat-input-textarea");
        const maxBottom = Math.min(viewportBottom - 20, composer?.getBoundingClientRect().top ?? viewportBottom);
        top = selectionBottom + 10;
        if (top + rect.height > maxBottom) {
          const aboveNativeMenu = selectionTop - rect.height - 48;
          top = aboveNativeMenu >= viewportTop + 10 ? aboveNativeMenu
            : selectionTop - rect.height - 8 >= viewportTop + 10 ? selectionTop - rect.height - 8
              : Math.max(viewportTop + 10, maxBottom - rect.height);
        }
      } else {
        top = selectionTop - rect.height - 8;
        if (top < viewportTop + 10) top = selectionBottom + 8;
      }
      const chatBounds = messageContentRef.current?.getBoundingClientRect();
      const margin = mobile ? 8 : 10;
      const minLeft = Math.max(viewportLeft + margin, (chatBounds?.left ?? viewportLeft) + margin);
      const maxLeft = Math.max(minLeft, Math.min(viewportRight - rect.width - margin, (chatBounds?.right ?? viewportRight) - rect.width - margin));
      const desiredLeft = quoteInputOpen ? quotedSelection.left - rect.width / 2 : selectionLeft - rect.width / 2;
      const left = Math.max(minLeft, Math.min(maxLeft, desiredLeft));
      popover.style.top = `${Math.round(Math.max(viewportTop + 8, Math.min(viewportBottom - rect.height - 8, top)))}px`;
      popover.style.left = `${Math.round(left)}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError, isMobile]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const askSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    chatInputRef?.current?.insertText(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
    window.getSelection()?.removeAllRanges();
    closeQuotedSelection();
  }, [chatInputRef, quotedSelection, closeQuotedSelection, t]);

  const runQuickQuoteAction = useCallback((action: "copy" | "quote") => {
    if (!quotedSelection) return;
    const range = quotedRangeRef.current;
    const rect = range?.startContainer.isConnected ? range.getBoundingClientRect() : null;
    window.dispatchEvent(new CustomEvent("pi-web:native-selection-action", {
      detail: { action, text: quotedSelection.text, range, rect },
    }));
    closeQuotedSelection();
  }, [quotedSelection, closeQuotedSelection]);

  const askSelectionInNewChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (quoteSubmitting || !prompt.trim() || !quotedSelection?.sourceEntryId || !sourceSessionId || !onAskInNewChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInNewChat(
        prompt,
        sourceSessionId,
        quotedSelection.sourceEntryId,
      );
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInNewChat, quotedSelection, quoteSubmitting, session?.id, sessionIdRef, closeQuotedSelection, unlockAudio]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || !initialPrompt || initialPromptSentRef.current) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.();
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, handleSend, onInitialPromptConsumed]);

  // One sound when a dialog appears with none on screen. A dialog queued behind
  // another one surfaces the moment the user answers that one, so it stays quiet.
  useEffect(() => {
    const surfaced = Boolean(extensionDialog) && !extensionDialogShownRef.current;
    extensionDialogShownRef.current = Boolean(extensionDialog);
    if (!completionNotificationsEnabled || !surfaced) return;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
  }, [sessionBusy, handleAbort]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const [sentinelNode, setSentinelNode] = useState<HTMLButtonElement | null>(null);
  const setSentinelElement = useCallback((node: HTMLButtonElement | null) => {
    sentinelRef.current = node;
    setSentinelNode(node);
  }, []);
  const visibleStartIndexRef = useRef(0);
  const visibleStartKeyRef = useRef<string | null>(null);
  const restoredVisibleCountRef = useRef(visibleCount);
  const visibleCountRef = useRef(visibleCount);
  visibleCountRef.current = visibleCount;
  useEffect(() => {
    window.dispatchEvent(new Event("pi-native-chat-messages-changed"));
  }, [session?.id, messages.length, messages[0], messages[messages.length - 1], entryIds[0], entryIds[entryIds.length - 1], visibleCount]);
  const pendingHistoryVisibleCountRef = useRef<number | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const currentHistorySessionId = session?.id ?? sessionIdRef.current ?? null;
  const currentHistoryScopeRef = useRef({
    sessionId: currentHistorySessionId,
    leafId: activeLeafId,
  });
  currentHistoryScopeRef.current = {
    sessionId: currentHistorySessionId,
    leafId: activeLeafId,
  };
  const historyLoadScopeRef = useRef(currentHistoryScopeRef.current);
  const historyLoadSequenceRef = useRef(0);
  const activeHistoryLoadRef = useRef<HistoryLoadOperation | null>(null);
  const [historyLoadPresentation, setHistoryLoadPresentation] = useState<{
    sessionId: string | null;
    leafId: string | null;
    status: HistoryLoadStatus;
  }>(() => ({ ...currentHistoryScopeRef.current, status: "idle" }));
  const beginHistoryLoad = useCallback((sessionId: string | null, leafId: string | null, status: HistoryLoadStatus) => {
    const operation: HistoryLoadOperation = { id: ++historyLoadSequenceRef.current, sessionId, leafId, settled: status !== "loading" };
    activeHistoryLoadRef.current = operation;
    loadingOlderRef.current = true;
    setHistoryLoadPresentation({ sessionId, leafId, status });
    return operation;
  }, []);
  const isCurrentHistoryLoad = useCallback((operation: HistoryLoadOperation) => {
    const active = activeHistoryLoadRef.current;
    const current = currentHistoryScopeRef.current;
    return active?.id === operation.id
      && active.sessionId === operation.sessionId
      && active.leafId === operation.leafId
      && current.sessionId === operation.sessionId
      && current.leafId === operation.leafId;
  }, []);
  const setHistoryLoadOutcome = useCallback((operation: HistoryLoadOperation, status: Exclude<HistoryLoadStatus, "loading">) => {
    if (!isCurrentHistoryLoad(operation)) return false;
    operation.settled = true;
    setHistoryLoadPresentation({ sessionId: operation.sessionId, leafId: operation.leafId, status });
    return true;
  }, [isCurrentHistoryLoad]);
  const clearHistoryLoadGuard = useCallback((operation: HistoryLoadOperation) => {
    // Restoring the viewport must not retire an in-flight request token.
    // Its outcome still owns the loading presentation until it settles.
    if (!operation.settled || activeHistoryLoadRef.current?.id !== operation.id) return;
    activeHistoryLoadRef.current = null;
    loadingOlderRef.current = false;
  }, []);
  const historyLoadStatus = historyLoadPresentation.sessionId === currentHistoryScopeRef.current.sessionId
    && historyLoadPresentation.leafId === currentHistoryScopeRef.current.leafId
    ? historyLoadPresentation.status
    : "idle";
  useLayoutEffect(() => {
    const current = currentHistoryScopeRef.current;
    const previous = historyLoadScopeRef.current;
    if (previous.sessionId === current.sessionId && previous.leafId === current.leafId) return;
    historyLoadScopeRef.current = { ...current };
    historyLoadSequenceRef.current += 1;
    activeHistoryLoadRef.current = null;
    loadingOlderRef.current = false;
    prevScrollDistanceRef.current = null;
    pendingHistoryVisibleCountRef.current = null;
    setHistoryLoadPresentation({ ...current, status: "idle" });
  }, [activeLeafId, currentHistorySessionId]);
  const restoreStartedRef = useRef(false);
  const pendingScrollRestoreRef = useRef(pendingScrollRestore);
  pendingScrollRestoreRef.current = pendingScrollRestore;
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);
  const searchMessage = messages[entryIds.indexOf(pendingSearchScroll?.entryId ?? "")];
  const searchBlock = searchMessage?.role === "assistant"
    ? (pendingSearchScroll?.blockIndex === undefined
      ? searchMessage.content.find((block) => block.type === "text")
      : searchMessage.content[pendingSearchScroll.blockIndex])
    : undefined;
  const searchHistoryRef = useRef({ entryIds, historyCursor, hasEarlierMessages });
  searchHistoryRef.current = { entryIds, historyCursor, hasEarlierMessages };

  useLayoutEffect(() => {
    const sessionId = session?.id;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    if (!sessionId || !onScrollPositionChange || !container || !content) return;
    const capturePosition = () => {
      if (pendingScrollRestoreRef.current) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        onScrollPositionChange(sessionId, { atBottom: true });
        return;
      }
      const viewportTop = container.getBoundingClientRect().top;
      const candidates = Array.from(content.children).flatMap((element) => {
        if (!(element instanceof HTMLElement) || !element.dataset.entryId) return [];
        const rect = element.getBoundingClientRect();
        return [{ entryId: element.dataset.entryId, anchorKey: element.dataset.scrollAnchor, top: rect.top, bottom: rect.bottom }];
      });
      const anchor = findChatScrollAnchor(candidates, viewportTop);
      if (!anchor) return;
      onScrollPositionChange(sessionId, {
        atBottom: false,
        ...anchor,
        oldestEntryId: searchHistoryRef.current.historyCursor,
      });
    };
    const cancelRestore = () => setPendingScrollRestore(null);
    window.addEventListener("pagehide", capturePosition);
    window.addEventListener("beforeunload", capturePosition);
    window.addEventListener("pi-chat-save-scroll-position", capturePosition);
    window.addEventListener("pi-chat-cancel-scroll-restore", cancelRestore);
    return () => {
      capturePosition();
      window.removeEventListener("pagehide", capturePosition);
      window.removeEventListener("beforeunload", capturePosition);
      window.removeEventListener("pi-chat-save-scroll-position", capturePosition);
      window.removeEventListener("pi-chat-cancel-scroll-restore", cancelRestore);
    };
  }, [loading, onScrollPositionChange, scrollContainerRef, session?.id]);

  useEffect(() => {
    if (searchTarget) setPendingScrollRestore(null);
  }, [searchTarget]);

  useEffect(() => {
    const position = pendingScrollRestore;
    const sessionId = session?.id;
    if (!position || !sessionId || loading || searchTarget || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    const controller = new AbortController();

    const locate = async () => {
      const initialHistory = searchHistoryRef.current;
      if (initialHistory.entryIds.includes(position.anchorEntryId)) {
        setRestoreAnchorReady(true);
        return;
      }

      const operation = beginHistoryLoad(sessionId, activeLeafId, "loading");
      let outcome: Exclude<HistoryLoadStatus, "loading"> = "idle";
      let before = initialHistory.historyCursor;
      let hasMore = initialHistory.hasEarlierMessages;
      try {
        while (hasMore && before && !controller.signal.aborted) {
          const context = await loadContext(sessionId, activeLeafId, before, { signal: controller.signal });
          if (controller.signal.aborted || !isCurrentHistoryLoad(operation)) return;
          if (!context) {
            outcome = "error";
            scrollToBottom("instant");
            setPendingScrollRestore(null);
            return;
          }
          setVisibleCount((current) => current + Math.max(VISIBLE_PAGE_SIZE, context.messages.length * 2));
          if (context.entryIds.includes(position.anchorEntryId)) {
            setRestoreAnchorReady(true);
            return;
          }
          if (context.oldestEntryId === position.oldestEntryId) break;
          before = context.oldestEntryId;
          hasMore = context.hasMore;
        }
        if (!controller.signal.aborted) {
          scrollToBottom("instant");
          setPendingScrollRestore(null);
        }
      } catch {
        if (isCurrentHistoryLoad(operation)) {
          outcome = "error";
          scrollToBottom("instant");
          setPendingScrollRestore(null);
        }
      } finally {
        if (isCurrentHistoryLoad(operation)) {
          setHistoryLoadOutcome(operation, outcome);
          clearHistoryLoadGuard(operation);
        }
      }
    };

    void locate();
    return () => {
      controller.abort();
      // A branch change cancels restoration and must reveal the new context.
      setPendingScrollRestore(null);
    };
  }, [activeLeafId, beginHistoryLoad, clearHistoryLoadGuard, isCurrentHistoryLoad, loadContext, loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id, setHistoryLoadOutcome]);

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    const content = messageContentRef.current;
    if (!position || !content || searchTarget) return;
    const element = Array.from(content.children).find((candidate) => (
      candidate instanceof HTMLElement && (position.anchorKey
        ? candidate.dataset.scrollAnchor === position.anchorKey
        : candidate.dataset.entryId === position.anchorEntryId)
    ));
    if (element instanceof HTMLElement) {
      scrollToMessage(element, position.anchorOffset);
      setVisibleCount((current) => Math.max(current, restoredVisibleCountRef.current));
      setPendingScrollRestore(null);
      return;
    }
    if (restoreAnchorReady) {
      scrollToBottom("instant");
      setPendingScrollRestore(null);
    }
  }, [entryIds, pendingScrollRestore, restoreAnchorReady, scrollToBottom, scrollToMessage, searchTarget, visibleCount]);

  useEffect(() => {
    if (!searchTarget || loading) return;
    const controller = new AbortController();
    const locate = async () => {
      const history = searchHistoryRef.current;
      let found = history.entryIds.includes(searchTarget.entryId);
      if (!found && !sessionBusy && history.hasEarlierMessages && history.historyCursor && !loadingOlderRef.current
        && searchTarget.sessionId === currentHistoryScopeRef.current.sessionId) {
        const operation = beginHistoryLoad(searchTarget.sessionId, activeLeafId, "loading");
        let outcome: Exclude<HistoryLoadStatus, "loading"> = "idle";
        const container = scrollContainerRef.current;
        if (container) prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        // ponytail: one extra page of 200 entries; deeper or other-branch hits just open the session.
        try {
          const context = await loadContext(searchTarget.sessionId, activeLeafId, history.historyCursor, { tail: 200, signal: controller.signal });
          if (controller.signal.aborted || !isCurrentHistoryLoad(operation)) return;
          if (!context) outcome = "error";
          found = Boolean(context?.entryIds.includes(searchTarget.entryId));
        } catch {
          if (isCurrentHistoryLoad(operation)) outcome = "error";
        } finally {
          if (isCurrentHistoryLoad(operation)) {
            setHistoryLoadOutcome(operation, outcome);
            clearHistoryLoadGuard(operation);
          }
        }
      }
      if (controller.signal.aborted) return;
      if (found) {
        prevScrollDistanceRef.current = null;
        setVisibleCount((current) => Math.max(current, (searchHistoryRef.current.entryIds.length + 200) * 2));
        setPendingSearchScroll(searchTarget);
      } else {
        onSearchTargetHandled?.(searchTarget);
      }
    };
    void locate();
    return () => controller.abort();
  }, [searchTarget, loading, activeLeafId, sessionBusy, loadContext, onSearchTargetHandled, scrollContainerRef, beginHistoryLoad, isCurrentHistoryLoad, setHistoryLoadOutcome, clearHistoryLoadGuard]);

  useLayoutEffect(() => {
    if (!pendingSearchScroll || pendingSearchScroll !== searchTarget) return;
    const selector = `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`;
    const element = scrollContainerRef.current?.querySelector<HTMLElement>(searchMessage?.role === "user" ? selector : `${selector} [data-search-target]`);
    if (element) {
      scrollToMessage(element);
      element.animate([
        { backgroundColor: "var(--bg-selected)" },
        { backgroundColor: "transparent" },
      ], { duration: 2500 });
    }
    setPendingSearchScroll(null);
    onSearchTargetHandled?.(pendingSearchScroll);
  }, [pendingSearchScroll, searchTarget, searchMessage, scrollContainerRef, scrollToMessage, onSearchTargetHandled]);

  const revealNextVisiblePage = useCallback(() => {
    const nextVisibleCount = getNextVisibleCount(visibleCountRef.current);
    pendingHistoryVisibleCountRef.current = nextVisibleCount;
    setVisibleCount((current) => Math.max(current, nextVisibleCount));
  }, []);

  const loadOlderHistory = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container || loadingOlderRef.current) return;

    const action = getHistoryLoadAction(visibleStartIndexRef.current, hasEarlierMessages);
    if (action === "reveal-local") {
      beginHistoryLoad(currentHistoryScopeRef.current.sessionId, activeLeafId, "idle");
      prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
      revealNextVisiblePage();
      return;
    }
    if (action !== "load-remote") {
      if (!hasEarlierMessages) return;
      return;
    }

    const oldestId = historyCursor;
    if (!oldestId) return;
    const sid = session?.id ?? sessionIdRef.current;
    if (!sid) return;
    const operation = beginHistoryLoad(sid, activeLeafId, "loading");
    prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
    void loadContext(sid, activeLeafId, oldestId)
      .then((context) => {
        if (!isCurrentHistoryLoad(operation)) return;
        if (context) {
          // The server page is measured in source messages, while the render
          // window is measured in nodes. Reveal one render page at a time.
          revealNextVisiblePage();
          setHistoryLoadOutcome(operation, "idle");
        } else {
          prevScrollDistanceRef.current = null;
          pendingHistoryVisibleCountRef.current = null;
          setHistoryLoadOutcome(operation, "error");
        }
      })
      .catch(() => {
        if (!isCurrentHistoryLoad(operation)) return;
        // A failed page request must not leave the sentinel permanently blocked.
        prevScrollDistanceRef.current = null;
        pendingHistoryVisibleCountRef.current = null;
        setHistoryLoadOutcome(operation, "error");
      })
      .finally(() => {
        if (!isCurrentHistoryLoad(operation)) return;
        // Keep the guard until the layout effect has restored the anchor after
        // the requested render page is mounted.
        if (prevScrollDistanceRef.current == null) clearHistoryLoadGuard(operation);
      });
  }, [activeLeafId, beginHistoryLoad, clearHistoryLoadGuard, hasEarlierMessages, historyCursor, isCurrentHistoryLoad, loadContext, revealNextVisiblePage, scrollContainerRef, session?.id, sessionIdRef, setHistoryLoadOutcome]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // The callback ref/state pair also registers a sentinel that appears after
  // the first effect ran (for example when grouping changes the render count).
  useEffect(() => {
    const sentinel = sentinelNode;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    // 首屏布局会短暂暴露顶部 sentinel；仅在用户操作后自动加载。
    let interacted = false;
    let intersects = false;
    const onHistoryGesture = () => {
      interacted = true;
      if (intersects) void loadOlderHistory();
    };
    container.addEventListener("wheel", onHistoryGesture, { passive: true });
    container.addEventListener("touchmove", onHistoryGesture, { passive: true });
    container.addEventListener("keydown", onHistoryGesture);
    const observer = new IntersectionObserver(
      (entries) => {
        intersects = !!entries[0]?.isIntersecting;
        if (!intersects || !interacted) return;
        void loadOlderHistory();
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      container.removeEventListener("wheel", onHistoryGesture);
      container.removeEventListener("touchmove", onHistoryGesture);
      container.removeEventListener("keydown", onHistoryGesture);
    };
  }, [loadOlderHistory, scrollContainerRef, sentinelNode]);

  // visibleCount is a render-node budget, not a source-message count. Keep
  // older pages clipped and reveal them one page at a time.

  // Restore the viewport after either a local render page or a prepended
  // server page becomes visible. Wait for the requested render page so a
  // source-message update cannot consume the anchor before the page expands.
  const historyPromptRevisionRef = useRef(promptScrollRevision);
  useLayoutEffect(() => {
    if (historyPromptRevisionRef.current !== promptScrollRevision) {
      historyPromptRevisionRef.current = promptScrollRevision;
      // A new user turn takes precedence over a previous reading position.
      // Leave an in-flight page guarded until its own request settles.
      prevScrollDistanceRef.current = null;
    }
    const pendingVisibleCount = pendingHistoryVisibleCountRef.current;
    if (prevScrollDistanceRef.current == null) {
      if (pendingVisibleCount !== null && visibleCount >= pendingVisibleCount) {
        pendingHistoryVisibleCountRef.current = null;
        const operation = activeHistoryLoadRef.current;
        if (operation) clearHistoryLoadGuard(operation);
      }
      return;
    }
    if (pendingVisibleCount !== null && visibleCount < pendingVisibleCount) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
    pendingHistoryVisibleCountRef.current = null;
    const operation = activeHistoryLoadRef.current;
    if (operation) clearHistoryLoadGuard(operation);
  }, [clearHistoryLoadGuard, messages, messages.length, promptScrollRevision, scrollContainerRef, visibleCount]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.tokenUsageAvailable ?? "native",
      sessionStats.messageCountsScope ?? "complete",
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  const onDrop = useCallback((files: File[]) => {
    chatInputRef?.current?.addImages(files);
  }, [chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const visibleMessages = messages.filter((m) => isMessageGroupAnchor(m) || m.role === "assistant");
  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [activeToolResults, messages]);
  const inlineSuggestion = useMemo(() => loading || error || sessionBusy || !sessionIdRef.current
    ? null : getInlineSuggestion(messages, entryIds, sessionIdRef.current),
  [loading, error, sessionBusy, messages, entryIds, sessionIdRef]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);
  const revealHistoryForMinimap = useCallback(() => {
    setVisibleCount((current) => Math.max(current, messages.length * 2));
  }, [messages.length]);

  const historyBridgeRef = useRef({
    sessionId: session?.id ?? sessionIdRef.current ?? null,
    totalTurns: navigationTotalTurns,
    hasEarlierMessages,
    entryIds,
    oldestEntryId: historyCursor,
    activeLeafId,
    messagesLength: messages.length,
    loadContext,
  });
  historyBridgeRef.current = {
    sessionId: session?.id ?? sessionIdRef.current ?? null,
    totalTurns: navigationTotalTurns,
    hasEarlierMessages,
    entryIds,
    oldestEntryId: historyCursor,
    activeLeafId,
    messagesLength: messages.length,
    loadContext,
  };

  useLayoutEffect(() => {
    const win = getEnhancementWindow();
    let bridgeOperation: HistoryLoadOperation | null = null;
    let bridgeLoadFailed = false;
    const loadEarlier = createEarlierHistoryLoader({
      isLoading: () => loadingOlderRef.current,
      setLoading: (next) => {
        if (next) {
          const scope = currentHistoryScopeRef.current;
          bridgeOperation = beginHistoryLoad(scope.sessionId, scope.leafId, "loading");
          bridgeLoadFailed = false;
          return;
        }
        const operation = bridgeOperation;
        bridgeOperation = null;
        if (!operation) return;
        if (isCurrentHistoryLoad(operation)) {
          setHistoryLoadOutcome(operation, bridgeLoadFailed ? "error" : "idle");
          clearHistoryLoadGuard(operation);
        }
        bridgeLoadFailed = false;
      },
      hasEarlierMessages: () => historyBridgeRef.current.hasEarlierMessages,
      getOldestEntryId: () => historyBridgeRef.current.oldestEntryId,
      getSessionId: () => session?.id ?? sessionIdRef.current ?? historyBridgeRef.current.sessionId,
      getActiveLeafId: () => historyBridgeRef.current.activeLeafId,
      captureScrollAnchor: () => {
        const container = scrollContainerRef.current;
        if (container) {
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        }
      },
      clearScrollAnchor: () => {
        if (bridgeOperation && !isCurrentHistoryLoad(bridgeOperation)) return;
        prevScrollDistanceRef.current = null;
        pendingHistoryVisibleCountRef.current = null;
      },
      loadContext: async (sid, leafId, before, options) => {
        try {
          const context = await historyBridgeRef.current.loadContext(sid, leafId, before, options);
          if (!context && bridgeOperation && bridgeOperation.sessionId === sid && bridgeOperation.leafId === leafId
            && isCurrentHistoryLoad(bridgeOperation)) {
            bridgeLoadFailed = true;
          }
          return context;
        } catch (error) {
          if (bridgeOperation && bridgeOperation.sessionId === sid && bridgeOperation.leafId === leafId
            && isCurrentHistoryLoad(bridgeOperation)) {
            bridgeLoadFailed = true;
          }
          throw error;
        }
      },
      onContextLoaded: (context) => {
        if (context.messages.length > 0) {
          setVisibleCount((current) => Math.max(
            current,
            (historyBridgeRef.current.messagesLength + context.messages.length) * 2,
          ));
        }
      },
    });
    return registerHistoryViewportBridges(win, {
      getHistoryState: () => buildEnhancementHistoryState({
        sessionId: session?.id ?? sessionIdRef.current ?? historyBridgeRef.current.sessionId,
        totalTurns: historyBridgeRef.current.totalTurns,
        hasEarlierMessages: historyBridgeRef.current.hasEarlierMessages,
        entryIds: historyBridgeRef.current.entryIds,
        oldestEntryId: historyBridgeRef.current.oldestEntryId,
      }),
      loadEarlier,
      prepareHistoryCommit: () => {
        const container = scrollContainerRef.current;
        if (container && isEnhancementPluginEnabled("history-scroll-stability", win)) {
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
        }
      },
    });
  }, [beginHistoryLoad, clearHistoryLoadGuard, isCurrentHistoryLoad, scrollContainerRef, session?.id, sessionIdRef, setHistoryLoadOutcome]);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const isScrollAvailable = !isEmptyNew && (!loading || messages.length > 0) && !(error && messages.length === 0);
  const swipeEnabled = isMobile && !mobileNavigationOpen && isScrollAvailable;
  const columnEndInset = useChatColumnInset(scrollContainerRef, !loading && !error && !isEmptyNew, isMobile ? 0 : CHAT_MINIMAP_WIDTH);
  useScrollbarVisibility(scrollContainerRef, Boolean(session?.id) || !isEmptyNew);

  // 原生实现手机竖屏聊天左滑打开会话导航（不限边缘，正文可滑；enabled严格映射渲染分支，有缓存不解绑）
  useMobileHorizontalSwipe({
    containerRef: scrollContainerRef,
    direction: "left",
    enabled: swipeEnabled,
    threshold: 40,
    dominantRatio: 1.3,
    allowOnButtons: false,
    onSwipe: () => {
      onMobileNavigationOpenChange?.(true);
    },
  });
  const hasStreamingContent = Boolean(streamState.streamingMessage?.content.length);
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorRevisionRef = useRef(-1);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      promptAnchorRevisionRef.current = -1;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;
    if (promptAnchorRevisionRef.current !== promptScrollRevision) {
      promptAnchorRevisionRef.current = promptScrollRevision;
      promptAnchorAdjustmentDoneRef.current = false;
    }

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const nextPromptAnchorSpacerHeight = getPromptAnchorSpacerHeight(
        targetTop,
        contentEnd,
        container.clientHeight,
      );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (nextPromptAnchorSpacerHeight !== promptAnchorSpacerHeightRef.current) {
        promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
        spacer.style.height = nextPromptAnchorSpacerHeight > 0
          ? `${nextPromptAnchorSpacerHeight}px`
          : "";
      }
      // Each user turn needs an alignment even when its required spacer
      // happens to equal the previous turn's height.
      if (isInitialMeasurement) scrollUserMsgToTop();
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    promptAnchorActive,
    promptScrollRevision,
    scrollContainerRef,
    scrollUserMsgToTop,
  ]);

  useLayoutEffect(() => {
    promptAnchorUpdateRef.current?.();
  }, [streamState.streamingMessage]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const chatInputElement = (
    <Fragment key="chat-input-element">
    <ChatInput
      ref={chatInputRef}
      executionEngine={isCodexSession ? "codex" : "pi"}
      columnEndInset={columnEndInset}
      extensionPanel={(extensionDialog || extensionCustomUi) && (
          <div className="pi-native-extension-dock">
            <div className="pi-native-extension-column">
              {extensionDialog && (extensionDialog.method === "input" || extensionDialog.method === "editor"
                ? <AskUserTextPanel key={extensionDialog.id} request={extensionDialog} waitingCount={waitingExtensionDialogCount} onRespond={respondToExtensionUi} />
                : <ExtensionDialog key={extensionDialog.id} request={extensionDialog} waitingCount={waitingExtensionDialogCount} onRespond={respondToExtensionUi} />)}
              {extensionCustomUi && <AskUserSurface key={extensionCustomUi.id} request={extensionCustomUi} waitingCount={waitingExtensionCustomUiCount} onInput={sendExtensionCustomInput} fallback={<ExtensionCustomPanel request={extensionCustomUi} waitingCount={waitingExtensionCustomUiCount} onInput={sendExtensionCustomInput} />} />}
            </div>
          </div>
      )}
      onSend={handleSend}
      onAbort={handleAbort}
      onSteer={agentRunning ? handleSteer : undefined}
      onFollowUp={agentRunning ? handleFollowUp : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
      isStreaming={sessionBusy}
      inlineSuggestion={inlineSuggestion}
      hasConversation={!isNew && messages.length > 0}
      model={displayModelValue}
      isAutoModelSelection={isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={modelError}
          modelsLoading={modelsLoading}
      onModelChange={handleModelChange}
      modelSwitching={modelSwitching}
      onCompact={!isCodexSession && (session || isNew) ? handleCompact : undefined}
      onAbortCompaction={!isCodexSession ? handleAbortCompaction : undefined}
      isCompacting={!isCodexSession && isCompacting}
      compactError={isCodexSession ? null : compactError}
      compactResult={isCodexSession ? null : compactResult}
      toolPreset={!isCodexSession ? toolPreset : undefined}
      onToolPresetChange={!isCodexSession && (session || isNew) ? handleToolPresetChange : undefined}
      thinkingLevel={thinkingLevel}
      isAutoThinkingSelection={isAutoThinkingSelection}
      onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      queueSyncStatus={queueSyncStatus}
      inputHistory={inputHistory}
      retainedSubmissions={unconfirmedSubmissions}
      deliveredRequestIds={messages.map(userMessageRequestId).filter((id): id is string => Boolean(id))}
      onRecallQueue={handleRecallQueue}
      onRestoreRecall={handleRestoreRecall}
      slashCommands={isCodexSession ? [] : slashCommands}
      slashCommandsLoading={!isCodexSession && slashCommandsLoading}
      onLoadSlashCommands={!isCodexSession ? loadSlashCommands : undefined}
      onBuiltinCommand={!isCodexSession ? handleBuiltinSlashCommand : undefined}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      cwd={session?.cwd ?? newSessionCwd}
    />
    </Fragment>
  );

  if (loading && messages.length === 0) {
    return (
      <div
        data-pi-enh-native-minimap="true"
        className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div key="loading-session-center" className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden text-text-muted">
          {t("chat.loadingSession")}
        </div>
        <div className="chat-composer-footer relative shrink-0" key="chat-input-container">
          {chatInputElement}
          {!isNew && !isCodexSession && (
            <div className="chat-composer-status-slot" aria-hidden="true" />
          )}
        </div>
      </div>
    );
  }

  if (error && messages.length === 0) {
    const isNetwork = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i.test(error);
    return (
      <div
        data-pi-enh-native-minimap="true"
        className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div key="error-session-center" className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center p-6 text-center">
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "color-mix(in srgb, #ef4444 12%, transparent)",
              color: "#ef4444",
              marginBottom: 16,
            }}
          >
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div style={{ fontSize: 16, fontWeight: 650, color: "var(--text)", marginBottom: 8 }}>
            {isNetwork ? "网络连接异常，无法加载会话" : "会话加载失败"}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", maxWidth: 460, lineHeight: 1.6, marginBottom: 14 }}>
            {isNetwork
              ? "未能与服务器建立连接，可能由于网络瞬断、局域网波动或设备休眠。请检查网络后点击下方按钮重试。"
              : "加载该会话数据时遇到异常，请检查服务状态或重新尝试。"}
          </div>
          <div
            style={{
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              color: "#f87171",
              background: "color-mix(in srgb, #ef4444 8%, var(--bg-panel))",
              border: "1px solid color-mix(in srgb, #ef4444 25%, var(--border))",
              borderRadius: 6,
              padding: "6px 12px",
              maxWidth: "min(520px, 100%)",
              overflowWrap: "anywhere",
              marginBottom: 20,
            }}
          >
            {error}
          </div>
          <button
            type="button"
            onClick={retryLoadSession}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 18px",
              borderRadius: 8,
              border: "1px solid var(--accent)",
              background: "var(--accent)",
              color: "var(--accent-contrast)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
              transition: "opacity 0.15s ease",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>
            </svg>
            <span>重新加载会话</span>
          </button>
        </div>
        <div className="chat-composer-footer relative shrink-0" key="chat-input-container">
          {chatInputElement}
          {!isNew && !isCodexSession && (
            <div className="chat-composer-status-slot" aria-hidden="true" />
          )}
        </div>
      </div>
    );
  }

  if (error && messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      data-pi-enh-native-minimap="true"
        className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div key="drag-drop-overlay" className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      {error && messages.length > 0 && (
        <div
          key="session-offline-error-banner"
          role="alert"
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, #f59e0b 50%, var(--border))",
            background: "var(--bg)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            color: "var(--text)",
            fontSize: 12,
            maxWidth: "min(600px, calc(100vw - 32px))",
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#f59e0b", flexShrink: 0 }} />
          <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            会话同步失败，已保留缓存内容：{error}
          </span>
          <button
            type="button"
            onClick={retryLoadSession}
            style={{
              padding: "3px 8px",
              borderRadius: 5,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            重试
          </button>
        </div>
      )}

      <div
        key="notice-shelf-container"
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: isMobile ? 0 : CHAT_MINIMAP_WIDTH,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={notices} floating onPauseChange={setNoticePaused} onDismiss={dismissNotice} onRefresh={session?.id ? retryLoadSession : undefined} onOpenConnectionSettings={onOpenSettings ? () => onOpenSettings("execution-engine") : undefined} sessionId={session?.id} />
      </div>

      <div key="main-chat-viewport" className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {!isEmptyNew && <>
        <div
          ref={scrollContainerRef}
          onPointerDown={handleBlankPointerDown}
          onPointerMove={handleBlankPointerMove}
          onPointerUp={handleBlankPointerUp}
          onPointerCancel={resetBlankTap}
          onScroll={resetBlankTap}
          // The message list is the one place long output has to be dragged through,
          // so it shows its scrollbar instead of hiding it behind the minimap (#788).
          // A stable gutter keeps the centred column from shifting when a short
          // session grows past one screen.
          className="scrollbar-subtle min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-gutter:stable]"
          data-pi-native-scroll-owner={session?.id}
          data-pi-native-scroll-restoring={pendingScrollRestore ? "true" : undefined}
          style={{ visibility: pendingScrollRestore ? "hidden" : undefined }}
        >
          <div data-chat-navigation-blank="true" style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} data-pi-native-message-column="true" style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {(() => {
              // Keep the grouping/index pass lightweight; only the selected
              // render window below is allowed to allocate React message nodes.
              const displayMessages = streamState.isStreaming && hasStreamingContent && streamState.streamingMessage
                ? [...messages, streamState.streamingMessage]
                : messages;
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i -= 1) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (isMessageGroupAnchor(msg) || msg.role === "assistant") {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              type MessagePlan = {
                kind: "message";
                key: string;
                idx: number;
                keyPrefix: string;
                messageOverride?: AgentMessage;
                showTimestamp?: boolean;
                writtenFilesTarget?: boolean;
              };
              type ProcessPlan = {
                kind: "process";
                key: string;
                processKey: string;
                parts: Array<{ idx: number; keyPrefix: string; messageOverride: AgentMessage }>;
                toolStates: ToolProcessSummary;
                streamingThinking: boolean;
                refIndex?: number;
                reveal: boolean;
              };
              type RenderPlan = MessagePlan | ProcessPlan;
              const plans: RenderPlan[] = [];
              const finalAssistantIndices = new Set<number>();
              let lastAssistant = -1;
              for (let i = 0; i < displayMessages.length; i += 1) {
                if (isMessageGroupAnchor(displayMessages[i])) {
                  if (lastAssistant >= 0) finalAssistantIndices.add(lastAssistant);
                  lastAssistant = -1;
                } else if (displayMessages[i].role === "assistant") lastAssistant = i;
              }
              if (lastAssistant >= 0) finalAssistantIndices.add(lastAssistant);
              let processPlan: ProcessPlan | null = null;
              const flushProcess = () => {
                if (!processPlan || processPlan.parts.length === 0) return;
                plans.push(processPlan);
                processPlan = null;
              };
              const messageKeyFor = (idx: number) => userMessageRenderKey(displayMessages[idx]) ?? entryIds[idx] ?? idx;
              const makeMessagePlan = (idx: number, options: Partial<Omit<MessagePlan, "kind" | "key" | "idx">> = {}): MessagePlan => {
                const keyPrefix = options.keyPrefix ?? "message";
                const messageKey = messageKeyFor(idx);
                return {
                  kind: "message",
                  key: `${keyPrefix}-${messageKey}`,
                  idx,
                  ...options,
                  keyPrefix,
                };
              };

              for (let idx = 0; idx < displayMessages.length; idx += 1) {
                const message = displayMessages[idx];
                // Skip presentation only: preserve source indices and entry IDs.
                if (isHiddenCustomMessage(message)) continue;
                if (message.role !== "assistant") {
                  if (message.role === "toolResult") continue;
                  flushProcess();
                  plans.push(makeMessagePlan(idx));
                  continue;
                }

                const finalInTurn = finalAssistantIndices.has(idx);
                const runs = splitAssistantDisplayRuns(message);
                runs.forEach((run, runIndex) => {
                  // This source-message/run identity remains stable as the live
                  // stream commits and as older source messages are prepended.
                  const key = `${idx}-${run.message.displayBlockIndices?.[0] ?? runIndex}`;
                  if (run.kind === "public") {
                    flushProcess();
                    plans.push(makeMessagePlan(idx, {
                      keyPrefix: `public-${runIndex}`,
                      messageOverride: run.message,
                      showTimestamp: finalInTurn && runIndex === runs.length - 1,
                      writtenFilesTarget: finalInTurn && idx < messages.length && runIndex === runs.length - 1,
                    }));
                    return;
                  }

                  if (!processPlan) {
                    processPlan = {
                      kind: "process",
                      key: `process-${key}`,
                      processKey: key,
                      parts: [],
                      toolStates: createToolProcessSummary(),
                      streamingThinking: false,
                      refIndex: visibleRefIndexByMessage.get(idx),
                      reveal: false,
                    };
                  }
                  processPlan.reveal ||= Boolean(pendingSearchScroll && entryIds[idx] === pendingSearchScroll.entryId && (!searchBlock || run.message.content.includes(searchBlock)));
                  for (const block of run.message.content) {
                    if (block.type === "toolCall") includeToolInProcessSummary(processPlan.toolStates, block, toolResultsMap.get(block.toolCallId));
                    if (block.type === "thinking" && idx === messages.length && streamState.isStreaming) processPlan.streamingThinking = true;
                  }
                  processPlan.parts.push({ idx, keyPrefix: `technical-${runIndex}`, messageOverride: run.message });
                });
              }
              flushProcess();

              const renderMessage = (plan: MessagePlan, attachRef = true): ReactNode => {
                const { idx } = plan;
                const msg = plan.messageOverride ?? displayMessages[idx];
                const isStreaming = idx === messages.length && displayMessages !== messages;
                const isVisible = isMessageGroupAnchor(msg) || msg.role === "assistant";
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const messageKey = messageKeyFor(idx);
                let writtenFiles: WrittenFile[] | undefined;
                if (plan.writtenFilesTarget) {
                  const turnContent: AssistantContentBlock[] = [];
                  let start = idx;
                  while (start > 0 && !isMessageGroupAnchor(displayMessages[start - 1])) start -= 1;
                  for (let i = start; i <= idx; i += 1) {
                    if (displayMessages[i].role === "assistant") turnContent.push(...(displayMessages[i] as AssistantMessage).content);
                  }
                  writtenFiles = extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd);
                }
                const view = (
                  <MessageView
                    key={`${plan.keyPrefix}-view-${messageKey}`}
                    message={msg}
                    isStreaming={isStreaming}
                    toolResults={toolResultsMap}
                    modelNames={modelNames}
                    cwd={messageCwd}
                    onOpenFile={onOpenFile}
                    onOpenSession={onOpenSession}
                    entryId={entryIds[idx]}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    onFork={isCodexSession || bashRunning || isNew ? undefined : handleFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={sessionBusy ? undefined : handleNavigate}
                    onEditContent={handleEditContent}
                    compactProgress={plan.keyPrefix?.startsWith("public-") === true && plan.showTimestamp === false}
                    showTimestamp={plan.showTimestamp ?? (msg.role === "assistant")}
                    prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={writtenFiles}
                  />
                );
                if (!isVisible || currentRefIdx === undefined) return view;
                return (
                  <div key={plan.key} data-entry-id={entryIds[idx]} data-scroll-anchor={`${plan.keyPrefix}-${messageKey}`} ref={attachRef ? attachVisibleRef(idx, currentRefIdx) : undefined}>
                    {view}
                  </div>
                );
              };

              const anchorIndex = pendingScrollRestore ? plans.findIndex((plan) => (
                plan.kind === "message"
                && (pendingScrollRestore.anchorKey
                  ? `${plan.keyPrefix}-${messageKeyFor(plan.idx)}` === pendingScrollRestore.anchorKey
                  : entryIds[plan.idx] === pendingScrollRestore.anchorEntryId)
              )) : -1;
              const retainedStartIndex = visibleStartKeyRef.current === null
                ? -1
                : plans.findIndex((plan) => plan.key === visibleStartKeyRef.current);
              const { startIndex } = getVisibleRenderWindow(plans.length, visibleCount, anchorIndex >= 0 ? anchorIndex : retainedStartIndex);
              const firstVisiblePlan = plans[startIndex];
              visibleStartKeyRef.current = firstVisiblePlan?.key ?? null;
              restoredVisibleCountRef.current = plans.length - startIndex;
              visibleStartIndexRef.current = startIndex;
              const hasMore = startIndex > 0 || hasEarlierMessages;
              return (
                <>
                  {hasMore && (
                    <button
                      type="button"
                      ref={setSentinelElement}
                      onClick={loadOlderHistory}
                      data-history-load-state={historyLoadStatus}
                      aria-live="polite"
                      aria-busy={historyLoadStatus === "loading"}
                      disabled={historyLoadStatus === "loading"}
                      className="block w-full border-0 bg-transparent py-3 text-center text-xs text-text-muted"
                    >
                      {historyLoadStatus === "loading" ? (
                        <span className="pi-history-load-pending">
                          <span className="pi-history-load-spinner" data-history-load-spinner="true" aria-hidden="true" />
                          <span>{t("chat.loadingEarlier")}</span>
                        </span>
                      ) : t(historyLoadStatus === "error" ? "chat.loadEarlierFailed" : "chat.loadEarlier")}
                    </button>
                  )}
                  {plans.slice(startIndex).map((plan) => plan.kind === "message"
                    ? renderMessage(plan)
                    : (
                      <div key={plan.key} ref={plan.refIndex === undefined ? undefined : (el) => { messageRefs.current[plan.refIndex!] = el; }}>
                        <ProcessDetailsGroup toolStates={plan.toolStates} streamingThinking={plan.streamingThinking} reveal={plan.reveal} t={t}>
                          {plan.parts.map((part) => renderMessage({
                            kind: "message",
                            key: `${part.keyPrefix}-${messageKeyFor(part.idx)}`,
                            idx: part.idx,
                            keyPrefix: part.keyPrefix,
                            messageOverride: part.messageOverride,
                            showTimestamp: false,
                          }, false))}
                        </ProcessDetailsGroup>
                      </div>
                    ))}
                </>
              );
            })()}
            {/* Keep one status row during streaming and tool execution; technical
                deltas must not repeatedly add/remove space below the disclosure. */}
            {agentRunning && (
              <div data-pi-native-agent-status="true" className="min-h-[36px] break-words py-2 text-[13px] text-text-muted">
                <span className="animate-[pulse_1.5s_infinite]">{phaseLabel(agentPhase, t)}</span>
              </div>
            )}

            {bashRunning && !pendingBash && (
              <div className="py-2 text-[13px] text-text-muted">
                 <span className="animate-[pulse_1.5s_infinite]">{t("chat.runningCommand")}</span>
              </div>
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                onOpenSession={onOpenSession}
              />
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />
            </div>
          </div>
        </div>
        {!isMobile && (pendingScrollRestore ? (
          <div className="chat-desktop-minimap" aria-hidden="true" style={{ width: CHAT_MINIMAP_WIDTH, flexShrink: 0 }} />
        ) : (
          <ChatMinimap
            key={session?.id ?? sessionIdRef.current ?? "new"}
            sessionId={session?.id ?? sessionIdRef.current ?? null}
            messages={messages}
            streamingMessage={streamState.streamingMessage}
            scrollContainer={scrollContainerRef}
            messageRefs={messageRefs}
            onRevealHistory={revealHistoryForMinimap}
          />
        ))}
        {isMobile && mobileNavigationOpen && !pendingScrollRestore && (
          <div className="chat-mobile-navigation-layer" data-mobile-navigation-layer="true">
            <button type="button" className="chat-mobile-navigation-backdrop" aria-label="关闭会话导航" onPointerDown={closeMobileNavigation}
              // Opening on pointer-up can retarget its compatibility click to
              // this newly mounted backdrop. Dismiss on a new press instead.
              onClick={(event) => { if (event.detail === 0) closeMobileNavigation(); }} />
            <ChatMinimap
              key={session?.id ?? sessionIdRef.current ?? "new"}
              sessionId={session?.id ?? sessionIdRef.current ?? null}
              messages={messages}
              streamingMessage={streamState.streamingMessage}
              scrollContainer={scrollContainerRef}
              messageRefs={messageRefs}
              onRevealHistory={revealHistoryForMinimap}
              overlay
              onClose={closeMobileNavigation}
            />
          </div>
        )}
        </>}
      </div>

      {quotedSelection && (quotedSelection.nativeQuote || quotedSelection.quickQuote) && createPortal(
        <div
          ref={quotePopoverRef}
          className="pi-enh-quote-bar"
          data-pi-native-selection-toolbar="true"
          role={quoteInputOpen ? "dialog" : "toolbar"}
          aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.askSelection")}
          style={{
            position: "fixed",
            top: quotedSelection.top,
            left: quotedSelection.left,
            zIndex: 260,
            ...(quickQuoteToolbar ? {
              maxWidth: "calc(100vw - 16px)",
              maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
              overflowY: "auto" as const,
            } : {
              display: "flex",
              flexWrap: "wrap" as const,
              gap: 3,
              width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
              maxWidth: "calc(100vw - 16px)",
              maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
              overflowY: "auto" as const,
              padding: quoteInputOpen ? 12 : 3,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
              boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
            }),
          }}
        >
          {quoteInputOpen ? (
            <fieldset
              disabled={quoteSubmitting}
              aria-busy={quoteSubmitting}
              style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600 }}>{t("chat.askInNewChat")}</span>
                <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <ChatInput
                ref={quoteChatInputRef}
                compact
                onSend={askSelectionInNewChat}
                onAbort={closeQuotedSelection}
                isStreaming={false}
              />
              {quoteError && <div role="alert" style={{ color: "#dc2626", fontSize: 12, overflowWrap: "anywhere" }}>{quoteError}</div>}
            </fieldset>
          ) : <>
            {quotedSelection.quickQuote && (
              <>
                <button
                  type="button"
                  className="pi-enh-quote-copy-btn"
                  title="复制选中文本到剪贴板"
                  aria-label="复制选中文本"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => runQuickQuoteAction("copy")}
                >复制</button>
                <div className="pi-enh-quote-divider" />
                <button
                  type="button"
                  className="pi-enh-quote-btn"
                  title="打开引用注释编辑框"
                  aria-label="添加引用注释"
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => runQuickQuoteAction("quote")}
                >引用</button>
              </>
            )}
            {quotedSelection.quickQuote && quotedSelection.nativeQuote && <div className="pi-enh-quote-divider" />}
            {quotedSelection.nativeQuote && (
              <button
                type="button"
                className="file-viewer-icon-button pi-enh-quote-btn"
                title={t("chat.askInCurrent")}
                aria-label={t("chat.askInCurrent")}
                onPointerDown={(event) => event.preventDefault()}
                onClick={askSelectionHere}
                style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
              >
                <span aria-hidden="true" style={{ fontSize: 15 }}>@</span>
                <span>{t("chat.askInCurrent")}</span>
              </button>
            )}
            {quotedSelection.nativeQuote && onAskInNewChat && quotedSelection.sourceEntryId && !bashRunning && (
              <button
                type="button"
                className="file-viewer-icon-button pi-enh-quote-btn"
                title={t("chat.askInNewChat")}
                aria-label={t("chat.askInNewChat")}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
                style={{ width: "auto", height: 35, flex: "0 0 auto", gap: 5, padding: "0 10px", border: "none", fontSize: 12, fontWeight: 500 }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
                </svg>
                <span>{t("chat.askInNewChat")}</span>
              </button>
            )}
          </>}
        </div>,
        document.body,
      )}

      <div className="chat-composer-footer relative shrink-0" key="chat-input-container">
        {!isEmptyNew && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: 0,
              right: columnEndInset,
              display: "flex",
              justifyContent: "center",
              paddingBottom: 10,
              pointerEvents: "none",
              zIndex: 20,
            }}
          >
            <ChatScrollToBottom
              visible={showScrollToBottom && !pendingScrollRestore}
              sessionId={session?.id ?? null}
              containerRef={scrollContainerRef}
              label={t("chat.scrollToLatest")}
            />
          </div>
        )}
        {isEmptyNew && (
          <NewSessionBrandHeader
            executionEngine={executionEngine}
            isMobile={isMobile}
            releaseNotesLabel={(version) => t("appUpdate.releaseNotes", { version })}
          />
        )}
        {chatInputElement}
        <ExtensionStatusBar statuses={extensionStatuses} widgets={extensionWidgets} />
        {!isEmptyNew && !isCodexSession && extensionStatuses.length === 0 && extensionWidgets.length === 0 && (
          <div className="chat-composer-status-slot" aria-hidden="true" />
        )}
      </div>
      {isEmptyNew && <div className="min-h-0 flex-1" />}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function getExtensionDialogSummary(request: ExtensionDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return request.options[0];
  if (request.method === "confirm") {
    const firstLine = request.message.split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

function ExtensionDialog({
  request,
  waitingCount,
  onRespond,
}: {
  request: Extract<ExtensionDialogRequest, { method: "select" | "confirm" }>;
  waitingCount: number;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const focusFirstOption = useCallback((element: HTMLDivElement | null) => element?.focus(), []);
  const summary = getExtensionDialogSummary(request);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    // The server closes expired requests via extension_ui_closed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  const countdown = remainingSeconds !== null && (
    <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionExpiresIn", { seconds: remainingSeconds })}
    </span>
  );

  const submitValue = () => onRespond(request, { confirmed: true });

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onRespond(request, { cancelled: true });
      }}
      className="pi-native-extension-host"
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "100%",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {request.title}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          {countdown}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        aria-label={request.title}
        style={{
          pointerEvents: "auto",
          width: "100%",
          maxHeight: "min(360px, 42dvh)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)", maxHeight: "min(100px, 14dvh)", overflowY: "auto" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* Pi's TUI shows the title verbatim, newlines included; select/input have no
                separate message field, so extensions put multi-line text here. */}
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650, lineHeight: 1.45, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{request.title}</div>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <ExtensionWaitingCount count={waitingCount} />
              {countdown}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            title={t("chat.extensionCollapse")}
            aria-label={t("chat.extensionCollapse")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        <div
          style={{
            padding: 14,
            flex: "1 1 auto", minHeight: 0, overflowY: "auto",
          }}
        >
          {request.method === "confirm" && (
            <MarkdownBody>{request.message}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-extension-option]"));
                const index = buttons.indexOf(event.target as HTMLElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? buttons.length - 1
                  : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next].focus({ preventScroll: true });
                buttons[next].scrollIntoView({ block: "nearest" });
              }}
              style={{ display: "grid", gap: 8 }}
            >
              {request.options.map((option, index) => (
                <div
                  key={option}
                  role="button"
                  tabIndex={0}
                  data-extension-option
                  aria-label={option}
                  ref={index === 0 ? focusFirstOption : undefined}
                  onClick={() => onRespond(request, { value: option })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onRespond(request, { value: option });
                  }}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 7,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                    overflowWrap: "anywhere",
                    // Match the scroller's padding so keyboard navigation never parks the
                    // option flush against the edge, where whole-pixel scroll snapping and
                    // overflow clipping cut off its focus ring.
                    scrollMargin: 14,
                  }}
                >
                  <div inert>
                    <MarkdownBody>{option}</MarkdownBody>
                  </div>
                </div>
              ))}
            </div>
          )}

        </div>

        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 6,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "var(--accent-contrast)",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function ExtensionCustomPanel({
  request,
  waitingCount,
  onInput,
}: {
  request: ExtensionCustomRequest;
  waitingCount: number;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const showEditableInput = isMobile || !allowsAutomaticEditableFocus();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const summary = displayLines.find((line) => line.trim())?.trim();

  useEffect(() => {
    if (!collapsed) focusEditable(inputRef.current);
  }, [collapsed]);

  return (
    <div
      className="pi-native-extension-host"
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "100%",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 8,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {t("chat.extensionPanel")}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <ExtensionWaitingCount count={waitingCount} />
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) focusEditable(inputRef.current);
        }}
        style={{
          pointerEvents: "auto",
          position: "relative",
          width: "100%",
          maxHeight: "min(360px, 42dvh)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          placeholder={showEditableInput ? t("chat.extensionInput") : undefined}
          style={showEditableInput ? {
            width: "100%", height: 40, flexShrink: 0, resize: "none",
            padding: "9px 12px", border: 0, borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)", color: "var(--text)", fontSize: 16,
          } : {
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <ExtensionWaitingCount count={waitingCount} />
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
            <button
              onClick={() => onInput(request, "\x03")}
              style={{
                padding: "5px 9px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
               {t("chat.close")}
            </button>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
      )}
    </div>
  );
}
