"use client";

import { createPortal } from "react-dom";

import composerModeIcons from "../lib/composer-mode-icons.json";

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages, SlashCommandInfo } from "@/hooks/useAgentSession";
import type { SkillsResponse } from "@/lib/api-types";
import type { TextContent, UserMessage } from "@/lib/types";
import {
  clearDraft,
  getDraft,
  getDraftInMemory,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft as rekeyStoredDraft,
  setDraft,
  type ChatDraftImage,
} from "@/lib/draft-store";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { getMarkdownListContinuation } from "@/lib/markdown-list-continuation";
import { isBareMcpCommand, isBuiltinMcpCommand } from "@/lib/mcp-command";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { ImagePreview } from "./ImagePreview";
import { stripDimensionNotes } from "./MessageView";
import { preloadImageCapabilities } from "@/lib/image-capabilities";
import { useIsMobile, focusEditable } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";
import { useChatAppearance } from "@/hooks/useChatAppearance";
import { rekeyComposerHeight, useComposerLayoutPreferences } from "@/hooks/useComposerLayoutPreferences";
import type { ToolPreset } from "@/lib/tool-presets";
import type { PendingPromptSubmission, PromptSubmissionPreviewIdentity } from "@/lib/prompt-submissions";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";
import { ThinkingSelector } from "./ThinkingSelector";
import { ComposerQueue, ComposerQueueIcon } from "./ComposerQueue";
import { isSuggestionDoubleTap, type InlineSuggestion, type SuggestionTap } from "@/lib/inline-suggestion";

export { filterModelOptions } from "./ModelSelector";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[], onRegistered?: (identity: PromptSubmissionPreviewIdentity) => void) => void | boolean | Promise<void | boolean>;
  onFollowUp?: (message: string, images?: AttachedImage[], onRegistered?: (identity: PromptSubmissionPreviewIdentity) => void) => void | boolean | Promise<void | boolean>;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[], onRegistered?: (identity: PromptSubmissionPreviewIdentity) => void) => void | boolean | Promise<void | boolean>;
  isStreaming: boolean;
  executionEngine?: "pi" | "codex";
  /** Preview only; accepted suggestions become ordinary drafts and are never auto-sent. */
  inlineSuggestion?: InlineSuggestion | null;
  hasConversation?: boolean;
  /** Text-only composer without the session controls or outer spacing. */
  compact?: boolean;
  /** End rail measured by the owning chat viewport; compact composers ignore it. */
  columnEndInset?: number;
  /** Native question surface, between the queue and the editable composer. */
  extensionPanel?: React.ReactNode;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[] }[];
  modelError?: string | null;
  modelsLoading?: boolean;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  onModelChange?: (provider: string, modelId: string) => void;
  modelSwitching?: boolean;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  toolPreset?: ToolPreset;
  onToolPresetChange?: (preset: ToolPreset) => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** New session has not committed a thinking level; the button still shows the resolved default. */
  isAutoThinkingSelection?: boolean;
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  queueSyncStatus?: "loading" | "ready" | "error";
  inputHistory?: string[];
  retainedSubmissions?: PendingPromptSubmission[];
  deliveredRequestIds?: readonly string[];
  onRecallQueue?: () => void;
  onQueuePreviewChange?: (identity: PromptSubmissionPreviewIdentity | null) => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
}

export interface ChatInputHandle {
  focusEditable: () => boolean;
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  replaceMessage: (message: UserMessage) => void;
  prependText: (text: string) => void;
  addImages: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (text: string, images?: ChatDraftImage[], targetDraftKey?: string) => void;
}

const COMPOSITION_END_ENTER_GRACE_MS = 100;
const TEXT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const ANCHORED_MENU_GAP = 8;

type ComposerMode = "normal" | "plan" | "goal";

interface ComposerGoalSnapshot {
  sessionId: string;
  mode: ComposerMode;
  goal: string;
  paused: boolean;
  pausePending: boolean;
  goalElapsedMs: number | null;
  goalActiveSinceMs: number | null;
  statusKey: "paused" | "pending" | "active" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  action: "pause" | "resume" | null;
}

interface ComposerModeSnapshot {
  sessionId: string | null;
  mode: ComposerMode;
  goal: ComposerGoalSnapshot | null;
}

function readComposerModeSnapshot(): ComposerModeSnapshot {
  if (typeof window === "undefined") return { sessionId: null, mode: "normal", goal: null };

  try {
    const bridges = window as any;
    const sessionId = bridges.__PI_ENH_GET_EFFECTIVE_COMPOSER_SESSION_ID__?.() || null;
    const candidateMode = bridges.__PI_ENH_GET_COMPOSER_MODE__?.(sessionId);
    const mode: ComposerMode = candidateMode === "plan" || candidateMode === "goal" ? candidateMode : "normal";
    const goalCandidate = bridges.__PI_ENH_GET_COMPOSER_GOAL_STATE__?.(sessionId);
    const goal = goalCandidate && typeof goalCandidate.goal === "string"
      ? goalCandidate as ComposerGoalSnapshot
      : null;

    return { sessionId, mode, goal };
  } catch (_) {
    return { sessionId: null, mode: "normal", goal: null };
  }
}

function formatComposerGoalDuration(totalMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(totalMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value < 10 ? `0${value}` : String(value);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Native React controls project the mode bridge's authoritative snapshot. Keeping
 * the subscription in this leaf prevents mode/goal updates from rerendering the
 * controlled textarea while the user is typing or composing IME text.
 */
function NativeComposerModeControls({ onModeChange, goalHost = null }: { onModeChange: (mode: ComposerMode) => void; goalHost?: HTMLElement | null }) {
  const [snapshot, setSnapshot] = useState<ComposerModeSnapshot>(() => ({ sessionId: null, mode: "normal", goal: null }));
  const [goalClockNow, setGoalClockNow] = useState(0);
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const refresh = useCallback(() => {
    const nextSnapshot = readComposerModeSnapshot();
    setSnapshot((current) => {
      const currentGoal = current.goal;
      const nextGoal = nextSnapshot.goal;
      const sameGoal = currentGoal === nextGoal || (
        currentGoal !== null &&
        nextGoal !== null &&
        currentGoal.sessionId === nextGoal.sessionId &&
        currentGoal.mode === nextGoal.mode &&
        currentGoal.goal === nextGoal.goal &&
        currentGoal.paused === nextGoal.paused &&
        currentGoal.pausePending === nextGoal.pausePending &&
        currentGoal.goalElapsedMs === nextGoal.goalElapsedMs &&
        currentGoal.goalActiveSinceMs === nextGoal.goalActiveSinceMs &&
        currentGoal.statusKey === nextGoal.statusKey &&
        currentGoal.action === nextGoal.action
      );
      return current.sessionId === nextSnapshot.sessionId && current.mode === nextSnapshot.mode && sameGoal
        ? current
        : nextSnapshot;
    });
    onModeChange(nextSnapshot.mode);
  }, [onModeChange]);

  useEffect(() => {
    refresh();
    const handleAddMenuChange = (event: Event) => {
      setAddMenuOpen((event as CustomEvent<{ open?: boolean }>).detail?.open === true);
    };
    window.addEventListener("pi-enh-composer-mode-change", refresh);
    window.addEventListener("pi-native-composer-preferences-change", refresh);
    window.addEventListener("pi-enh-composer-add-menu-change", handleAddMenuChange);
    return () => {
      window.removeEventListener("pi-enh-composer-mode-change", refresh);
      window.removeEventListener("pi-native-composer-preferences-change", refresh);
      window.removeEventListener("pi-enh-composer-add-menu-change", handleAddMenuChange);
    };
  }, [refresh]);

  useEffect(() => {
    const goal = snapshot.goal;
    if (
      !goal ||
      goal.statusKey !== "active" ||
      typeof goal.goalElapsedMs !== "number" ||
      typeof goal.goalActiveSinceMs !== "number"
    ) return;

    const interval = window.setInterval(() => setGoalClockNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [
    snapshot.goal?.sessionId,
    snapshot.goal?.goal,
    snapshot.goal?.statusKey,
    snapshot.goal?.goalElapsedMs,
    snapshot.goal?.goalActiveSinceMs,
  ]);

  const openAddMenu = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const openMenu = (window as any).__PI_ENH_OPEN_COMPOSER_ADD_MENU__;
    if (typeof openMenu === "function") {
      try { openMenu(event.currentTarget); } catch (_) {}
    }
  }, []);

  const exitMode = useCallback(() => {
    const switchMode = (window as any).__PI_ENH_SWITCH_COMPOSER_MODE__;
    if (typeof switchMode === "function") {
      try { void switchMode("normal", snapshot.sessionId ?? undefined); } catch (_) {}
    }
  }, [snapshot.sessionId]);

  const handleGoalAction = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const { goal } = snapshot;
    const handleAction = (window as any).__PI_ENH_HANDLE_COMPOSER_GOAL_ACTION__;
    if (goal && typeof handleAction === "function") {
      try { void handleAction(goal.action, goal.sessionId, event.currentTarget); } catch (_) {}
    }
  }, [snapshot]);

  const modeLabel = snapshot.mode === "plan" ? "计划" : snapshot.mode === "goal" ? "目标" : "";
  const goal = snapshot.goal;
  const goalText = goal?.goal?.trim() || "";
  const goalDurationMs = goal && typeof goal.goalElapsedMs === "number"
    ? goal.goalElapsedMs + (
      goal.statusKey === "active" && typeof goal.goalActiveSinceMs === "number"
        ? Math.max(0, (goalClockNow || Date.now()) - goal.goalActiveSinceMs)
        : 0
    )
    : null;
  const goalActionLabel = goal?.action === "resume"
    ? (goal.statusKey === "pending" ? "取消待暂停" : "继续目标")
    : "暂停目标";
  const goalActionText = goal?.statusKey === "pending"
    ? "取消"
    : goal?.action === "resume"
      ? "继续"
      : "暂停";
  const goalStatusLabels: Record<ComposerGoalSnapshot["statusKey"], string> = {
    pending: "等待暂停", paused: "已暂停", active: "进行中", blocked: "已阻塞",
    usageLimited: "额度受限", budgetLimited: "预算受限", complete: "已完成",
  };
  const goalStatusLabel = goal ? goalStatusLabels[goal.statusKey] || "状态待确认" : "";

  const goalSummary = goalText && goal && (
            <div
              className="chat-composer-goal-summary"
              data-status={goal.statusKey}
              role="group"
              aria-label={`当前目标，${goalStatusLabel}：${goalText}`}
              title={`${goalStatusLabel}：${goalText}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">{composerModeIcons.goal.map(d => <path key={d} d={d} />)}</svg>
              <span className="chat-composer-goal-status">{goalStatusLabel}</span>
              <span className="chat-composer-goal-text">{goalText}</span>
              {goalDurationMs !== null && (
                <span className="chat-composer-goal-timer" aria-label="目标累计运行时间" title="目标累计运行时间">
                  {formatComposerGoalDuration(goalDurationMs)}
                </span>
              )}
              {goal.action && <button
                type="button"
                className="chat-composer-goal-action"
                aria-label={goalActionLabel}
                title={goalActionLabel}
                onClick={handleGoalAction}
              >
                {goalActionText}
              </button>}
            </div>
  );

  return (
    <>
      {goalHost && goalSummary ? createPortal(goalSummary, goalHost) : null}
      <button
        type="button"
        className={`chat-composer-add-btn pi-enh-composer-add-btn${addMenuOpen ? " active" : ""}`}
        aria-label="打开附件与模式菜单"
        aria-haspopup="menu"
        aria-expanded={addMenuOpen}
        title="添加附件或切换模式"
        onClick={openAddMenu}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M8 3v10M3 8h10" />
        </svg>
      </button>
      {modeLabel && (
        <div className="chat-composer-mode-status" data-mode={snapshot.mode}>
          <button
            type="button"
            className="chat-composer-mode-chip chat-composer-control-capsule"
            aria-label={`退出${modeLabel}模式`}
            title={`退出${modeLabel}模式`}
            onClick={exitMode}
          >
            <span className="chat-composer-mode-icon" aria-hidden="true">
              <svg className="chat-composer-mode-symbol" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                {composerModeIcons[snapshot.mode as "plan" | "goal"].map((d) => <path key={d} d={d} />)}
              </svg>
              <svg className="chat-composer-mode-dismiss" width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" fill="var(--text-muted)" />
                <path d="m5.8 5.8 4.4 4.4m0-4.4-4.4 4.4" stroke="var(--bg-panel)" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </span>
            <span>{modeLabel}</span>
          </button>
        </div>
      )}
    </>
  );
}

export function resizeChatInputTextarea(textarea: HTMLTextAreaElement): void {
  // Only an explicit lock or an active drag suspends automatic sizing.
  if (textarea.closest(".chat-composer-custom-height")) return;
  textarea.style.height = "auto";
  const card = textarea.closest<HTMLElement>(".chat-composer-card");
  const minimum = Number(card?.dataset.composerMinHeight) || 0;
  if (!textarea.value && !textarea.dataset?.piInlineSuggestion) {
    if (minimum) textarea.style.height = `${minimum}px`;
    return;
  }

  const style = getComputedStyle(textarea);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.6;
  const maxHeight = textarea.closest(".chat-composer-card") ? lineHeight * 8 + padding + border : 200;
  textarea.style.height = `${Math.max(minimum, Math.min(textarea.scrollHeight + border, maxHeight))}px`;
}

export function getUpwardMenuMaxHeight(menuBottom: number, visibleTop: number, gap = ANCHORED_MENU_GAP): number {
  return Math.max(0, Math.floor(menuBottom - visibleTop - gap));
}

export function cycleListIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return ((index + delta) % length + length) % length;
}

export function replaceLinksWithMarkdown(
  text: string,
  links: Iterable<{ label: string; href: string; occurrence: number }>,
): string | null {
  let result = "";
  let searchFrom = 0;
  let replaced = false;

  for (const { label, href, occurrence } of links) {
    if (!label || !href) continue;
    let index = 0;
    for (let match = 0; match <= occurrence; match++) {
      index = text.indexOf(label, match ? index + label.length : 0);
      if (index < 0) break;
    }
    if (index < searchFrom) continue;
    const escapedLabel = label.replace(/([\\[\]])/g, "\\$1");
    const escapedHref = href.replace(/([\\()])/g, "\\$1");
    result += `${text.slice(searchFrom, index)}[${escapedLabel}](${escapedHref})`;
    searchFrom = index + label.length;
    replaced = true;
  }

  return replaced ? result + text.slice(searchFrom) : null;
}

function getVisibleTopBoundary(element: HTMLElement): number {
  let visibleTop = window.visualViewport?.offsetTop ?? 0;

  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "hidden" || overflowY === "clip") {
      visibleTop = Math.max(visibleTop, parent.getBoundingClientRect().top + parent.clientTop);
    }
  }

  return visibleTop;
}

function subscribeUpwardMenuMaxHeight(
  menu: HTMLElement,
  onChange: (height: number) => void,
): () => void {
  let frameId: number | null = null;
  const update = () => {
    frameId = null;
    onChange(getUpwardMenuMaxHeight(
      menu.getBoundingClientRect().bottom,
      getVisibleTopBoundary(menu),
    ));
  };
  const scheduleUpdate = () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(update);
  };

  update();
  const parent = menu.parentElement;
  const layoutContainer = parent?.parentElement;
  const anchorObserver = typeof ResizeObserver === "undefined" || !parent
    ? null
    : new ResizeObserver(scheduleUpdate);
  if (parent) anchorObserver?.observe(parent);
  if (layoutContainer) anchorObserver?.observe(layoutContainer);
  const viewport = window.visualViewport;
  viewport?.addEventListener("resize", scheduleUpdate);
  viewport?.addEventListener("scroll", scheduleUpdate);
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("scroll", scheduleUpdate, true);

  return () => {
    anchorObserver?.disconnect();
    viewport?.removeEventListener("resize", scheduleUpdate);
    viewport?.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("scroll", scheduleUpdate, true);
    if (frameId !== null) cancelAnimationFrame(frameId);
  };
}

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_DESC_KEYS: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "chat.thinkingUseDefault", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return tokens.toLocaleString();
}

type BuiltinSlashCommand = {
  name: string;
  description: string;
  source: "builtin";
  availableWhileStreaming?: boolean;
};

type SlashCommandPaletteItem = SlashCommandInfo | BuiltinSlashCommand;

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: BuiltinSlashCommand[] = [
  { name: "compact", description: "chat.commandCompact", source: "builtin" },
  { name: "auto-compact", description: "chat.commandAutoCompact", source: "builtin" },
  { name: "reload", description: "chat.commandReload", source: "builtin" },
  { name: "name", description: "chat.commandName", source: "builtin" },
  { name: "session", description: "chat.commandSession", source: "builtin", availableWhileStreaming: true },
  { name: "copy", description: "chat.commandCopy", source: "builtin", availableWhileStreaming: true },
  { name: "clone", description: "chat.commandClone", source: "builtin" },
];

function getBuiltinSlashCommand(message: string): BuiltinSlashCommand | undefined {
  const match = message.trim().match(/^\/([^\s]+)(?:\s|$)/);
  if (!match) return undefined;
  return BUILTIN_SLASH_COMMANDS.find((command) => command.name === match[1]);
}

export function canRunBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return getBuiltinSlashCommand(message)?.availableWhileStreaming === true;
}

export function isExactSlashCommand(message: string, command: SlashCommandPaletteItem): boolean {
  return command.source === "builtin" && message.trim() === `/${command.name}`;
}

export function offersBuiltinSlashCommandWhileStreaming(message: string): boolean {
  return canRunBuiltinSlashCommandWhileStreaming(message) || isBareMcpCommand(message);
}

export function submitsSlashCommandOnEnter(message: string, command: SlashCommandPaletteItem, isStreaming: boolean): boolean {
  if (command.source === "builtin") {
    return isExactSlashCommand(message, command) && (!isStreaming || command.availableWhileStreaming === true);
  }
  return isBuiltinMcpCommand(command) && isBareMcpCommand(message);
}

export function canClearBuiltinCommandInput(message: string, imageCount: number, submittedMessage: string): boolean {
  return imageCount === 0 && message.trim() === submittedMessage;
}

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "prompt", "skill"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtIn",
  extension: "chat.extensions",
  prompt: "chat.prompts",
  skill: "chat.skills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  prompt: 2,
  skill: 3,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string, t: (key: string) => string): number {
  const name = command.name.toLowerCase();
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return command.source === "builtin" ? t(command.description) : command.description ?? "";
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  if (command.source !== "skill" || !command.name.startsWith("skill:")) return false;
  return dormancy[command.name.slice("skill:".length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
) {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}

const CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES = 1024 * 1024;
const CLIENT_MAX_SCREENSHOT_SIDE = 2048;
const CLIENT_MAX_PHOTO_SIDE = 1024;
const CLIENT_JPEG_QUALITY = 0.85;

export function shouldCompressImageFile(file: Pick<File, "size" | "type">): boolean {
  return file.size > CLIENT_IMAGE_COMPRESSION_THRESHOLD_BYTES && file.type !== "image/gif";
}

function readImageFile(file: Blob, mimeType: string): Promise<{ data: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const data = typeof reader.result === "string" ? reader.result.split(",")[1] : undefined;
      if (!data) {
        reject(new Error("Failed to read image"));
        return;
      }
      resolve({ data, mimeType });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function compressImageFile(file: File): Promise<{ data: string; mimeType: string }> {
  const original = () => readImageFile(file, file.type);
  if (!shouldCompressImageFile(file) || typeof createImageBitmap !== "function") return original();

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return original();

  try {
    const preservePng = file.type === "image/png";
    const outputMimeType = preservePng ? "image/png" : "image/jpeg";
    const maxSide = preservePng ? CLIENT_MAX_SCREENSHOT_SIDE : CLIENT_MAX_PHOTO_SIDE;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return original();
    if (!preservePng) {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = (preservePng
      ? canvas.toDataURL(outputMimeType)
      : canvas.toDataURL(outputMimeType, CLIENT_JPEG_QUALITY)
    ).split(",")[1];
    return data && data.length < Math.ceil(file.size / 3) * 4
      ? { data, mimeType: outputMimeType }
      : original();
  } catch {
    return original();
  } finally {
    bitmap.close();
  }
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

export function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .map(draftImageToAttachedImage);
}

export function getTooManyImagesNotice(
  imageCount: number,
  maxImages = MAX_ATTACHED_IMAGES,
  locale = "en",
): { title: string; body: string } | null {
  if (imageCount <= maxImages) return null;
  const excess = imageCount - maxImages;
  if (locale === "zh-CN" || locale === "zh-TW") {
    return {
      title: `已附加 ${imageCount} 张图片（单次发送上限 ${maxImages} 张）`,
      body: `单条消息最多可发送 ${maxImages} 张图片（当前超出 ${excess} 张）。请先删减多余图片或分批发送。`,
    };
  }
  return {
    title: `Too many images attached (${imageCount}/${maxImages})`,
    body: `A message can include at most ${maxImages} images. Remove ${excess} image${excess === 1 ? "" : "s"} or send in batches before submitting.`,
  };
}

export function canRestoreUserMessage(
  value: string,
  attachedImageCount: number,
  pendingImageCount: number,
): boolean {
  return !value.trim() && attachedImageCount === 0 && pendingImageCount === 0;
}

export function getUserMessageText(message: UserMessage): string {
  if (typeof message.content === "string") return stripDimensionNotes(message.content);
  return stripDimensionNotes(
    message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  );
}

export function getUserMessageDraftImages(message: UserMessage): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];

    // Support both the current nested image format and older flat pi-ai entries.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];

    const image = { data, mimeType };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  });
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function ModelNoticeBanner({ tone, title, body, onClose }: { tone: "error" | "warning"; title: string; body: React.ReactNode; onClose?: () => void }) {
  const { t } = useI18n();
  const color = tone === "error" ? "239,68,68" : "234,179,8";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid rgba(${color},0.3)`,
        borderRadius: 6,
        background: `rgba(${color},0.07)`,
        color: `rgb(${color})`,
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={t("chat.close")}
          style={{
            flexShrink: 0,
            background: "none",
            border: "none",
            padding: "0 2px",
            cursor: "pointer",
            color: "inherit",
            opacity: 0.7,
            fontSize: 13,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  const { t } = useI18n();
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title={t("chat.modelError")} body={error} />;
}

/** True when the selected model is known to accept image input (#584). Unknown modality info never blocks the user. */
export function modelSupportsImageInput(
  model: { provider: string; modelId: string } | null | undefined,
  modelList: { id: string; name: string; provider: string; input?: string[] }[] | undefined
): boolean {
  if (!model) return true;
  const entry = modelList?.find((m) => m.provider === model.provider && m.id === model.modelId);
  if (!entry || !entry.input) return true;
  return entry.input.includes("image");
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, executionEngine = "pi", model, isAutoModelSelection, modelNames, modelList, modelError, modelsLoading, onModelChange, modelSwitching,
  compactError, compactResult, inlineSuggestion, hasConversation = false,
  thinkingLevel, isAutoThinkingSelection = false, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, queueSyncStatus = "ready", inputHistory = [], retainedSubmissions = [], deliveredRequestIds = [], onRecallQueue, onQueuePreviewChange,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
 onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
  compact = false,
  columnEndInset,
  extensionPanel,
}: Props, ref) {
  const { t, locale } = useI18n();
  const { fontSize } = useChatAppearance();
  const isMobile = useIsMobile();
  const isCodexEngine = executionEngine === "codex";
  const [value, setValue] = useState(() => (draftKey ? getDraftInMemory(draftKey)?.value ?? "" : ""));
  const [hasEnhancedSubmissionPayload, setHasEnhancedSubmissionPayload] = useState(false);
  const [emptyContinueEnabled, setEmptyContinueEnabled] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraftInMemory(draftKey)?.images) : []
  ));
  const trimmedValue = value.trimStart();
  const bashMode = !isCodexEngine && attachedImages.length === 0 && trimmedValue.startsWith("!");
  const bashExcluded = bashMode && trimmedValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [slashMenuMaxHeight, setSlashMenuMaxHeight] = useState<number | null>(null);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atMenuMaxHeight, setAtMenuMaxHeight] = useState<number | null>(null);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [imageWarningDismissed, setImageWarningDismissed] = useState(false);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [builtinCommandPending, setBuiltinCommandPending] = useState(false);
  const builtinCommandPendingRef = useRef(false);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);
  const [skillDormancyState, setSkillDormancyState] = useState<{
    cwd: string;
    values: Record<string, boolean>;
  } | null>(null);
  const skillDormancy = cwd && skillDormancyState?.cwd === cwd
    ? skillDormancyState.values
    : {};

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atMenuRef = useRef<HTMLDivElement>(null);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const pendingImageCountRef = useRef(0);
  const draftHydratedKeyRef = useRef<string | null>(null);
  const queuedSubmissionPendingRef = useRef(false);
  const [queuedSubmissionPending, setQueuedSubmissionPending] = useState(false);
  const [queuedSubmissionPreview, setQueuedSubmissionPreview] = useState<{
    token: object; identity: PromptSubmissionPreviewIdentity | null;
    draftKey: string | undefined; text: string; kind: "steering" | "followUp";
    images: { data: string; mimeType: string }[];
  } | null>(null);
  const queuedPreviewVisible = Boolean(queuedSubmissionPreview && queuedSubmissionPreview.draftKey === draftKey
    && !(queuedSubmissionPreview.identity && (
      deliveredRequestIds.includes(queuedSubmissionPreview.identity.requestId)
      || retainedSubmissions.some(row => row.requestId === queuedSubmissionPreview.identity!.requestId)
      || Object.values(queuedMessages?.requestIds ?? {}).flat().includes(queuedSubmissionPreview.identity.requestId))));
  useEffect(() => {
    if (queuedSubmissionPreview && !queuedPreviewVisible) setQueuedSubmissionPreview(null);
  }, [queuedSubmissionPreview, queuedPreviewVisible]);
  const queuePreviewIdentity = queuedPreviewVisible ? queuedSubmissionPreview?.identity ?? null : null;
  useLayoutEffect(() => {
    onQueuePreviewChange?.(queuePreviewIdentity);
    return () => onQueuePreviewChange?.(null);
  }, [queuePreviewIdentity, onQueuePreviewChange]);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;

  const [suggestionComposing, setSuggestionComposing] = useState(false);
  const [consumedSuggestionKey, setConsumedSuggestionKey] = useState<string | null>(null);
  const suggestionKey = inlineSuggestion ? JSON.stringify([draftKey, inlineSuggestion.sessionId, inlineSuggestion.id, inlineSuggestion.text]) : null;
  const visibleSuggestion = !compact && inlineSuggestion?.sessionId === draftKey && value.length === 0
    && !isStreaming && !suggestionComposing && !hasEnhancedSubmissionPayload && attachedImages.length === 0
    && !slashMenuOpen && !atMenuOpen && !historyMenuOpen && !extensionPanel
    && !queuedMessages?.steering.length && !queuedMessages?.followUp.length
    && consumedSuggestionKey !== suggestionKey ? inlineSuggestion : null;
  const allowEmptyContinue = !compact && hasConversation && emptyContinueEnabled && !isStreaming && !suggestionComposing
    && !visibleSuggestion && value.trim().length === 0 && attachedImages.length === 0 && !hasEnhancedSubmissionPayload;
  const lastSuggestionTapRef = useRef<SuggestionTap | null>(null);
  const suggestionTouchRef = useRef<{id: number; x: number; y: number; key: string} | null>(null);
  const acceptInlineSuggestion = useCallback(() => {
    const ta = textareaRef.current;
    if (!visibleSuggestion || !suggestionKey || draftKeyRef.current !== draftKey
      || valueRef.current !== "" || !ta || ta.value !== "" || isComposingRef.current) return false;
    valueRef.current = visibleSuggestion.text;
    setValue(visibleSuggestion.text);
    setConsumedSuggestionKey(suggestionKey);
    lastSuggestionTapRef.current = null;
    requestAnimationFrame(() => {
      if (textareaRef.current !== ta || draftKeyRef.current !== draftKey) return;
      focusEditable(ta, {preventScroll: true});
      ta.setSelectionRange(visibleSuggestion.text.length, visibleSuggestion.text.length);
      resizeChatInputTextarea(ta);
    });
    return true;
  }, [visibleSuggestion, suggestionKey, draftKey]);
  const cancelSuggestionTouch = useCallback(() => {
    suggestionTouchRef.current = null;
    lastSuggestionTapRef.current = null;
  }, []);
  const startSuggestionTouch = useCallback((event: React.TouchEvent<HTMLTextAreaElement>) => {
    if (!visibleSuggestion || !suggestionKey || event.touches.length !== 1 || isComposingRef.current
      || (window.getSelection()?.toString() ?? "").length > 0) { cancelSuggestionTouch(); return; }
    const touch = event.touches[0];
    suggestionTouchRef.current = {id: touch.identifier, x: touch.clientX, y: touch.clientY, key: suggestionKey};
  }, [visibleSuggestion, suggestionKey, cancelSuggestionTouch]);
  const moveSuggestionTouch = useCallback((event: React.TouchEvent<HTMLTextAreaElement>) => {
    const active = suggestionTouchRef.current;
    const touch = event.touches[0];
    if (!active || event.touches.length !== 1 || touch.identifier !== active.id
      || Math.hypot(touch.clientX - active.x, touch.clientY - active.y) > 8) cancelSuggestionTouch();
  }, [cancelSuggestionTouch]);
  const endSuggestionTouch = useCallback((event: React.TouchEvent<HTMLTextAreaElement>) => {
    const active = suggestionTouchRef.current;
    suggestionTouchRef.current = null;
    const touch = Array.from(event.changedTouches).find(item => item.identifier === active?.id);
    if (!active || !touch || event.touches.length || !visibleSuggestion || active.key !== suggestionKey
      || Math.hypot(touch.clientX - active.x, touch.clientY - active.y) > 8) { cancelSuggestionTouch(); return; }
    const next = {time: performance.now(), x: touch.clientX, y: touch.clientY, key: active.key};
    if (isSuggestionDoubleTap(lastSuggestionTapRef.current, next) && acceptInlineSuggestion()) {
      event.preventDefault();
      lastSuggestionTapRef.current = null;
    } else lastSuggestionTapRef.current = next;
  }, [visibleSuggestion, suggestionKey, acceptInlineSuggestion, cancelSuggestionTouch]);

  useImperativeHandle(ref, () => ({
    focusEditable() { return focusEditable(textareaRef.current, { preventScroll: true }); },
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      valueRef.current = text;
      setValue(text);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        focusEditable(ta);
        resizeChatInputTextarea(ta);
      });
    },
    replaceMessage(message: UserMessage) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (!canRestoreUserMessage(current, attachedImagesRef.current.length, pendingImageCountRef.current)) return;

      const body = getUserMessageText(message);
      const enhancementWindow = window as Window & {
        __PI_ENH_RESTORE_COMPOSER_ATTACHMENTS__?: (body: string) => string | null;
      };
      const restoredBody = enhancementWindow.__PI_ENH_RESTORE_COMPOSER_ATTACHMENTS__?.(body);
      if (restoredBody === null) return;
      const restoredText = restoredBody ?? body;
      const restoredImages = draftImagesToAttachedImages(getUserMessageDraftImages(message));
      valueRef.current = restoredText;
      attachedImagesRef.current = restoredImages;
      setValue(restoredText);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return restoredImages;
      });
      requestAnimationFrame(() => {
        if (!ta) return;
        focusEditable(ta);
        resizeChatInputTextarea(ta);
      });
    },
    prependText(text: string) {
      if (!text.trim()) return;
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      // Mirrors the TUI's queue restore: queued text first, then whatever
      // the user already typed, separated by a blank line.
      const combined = [text, current].filter((t) => t.trim()).join("\n\n");
      valueRef.current = combined;
      setValue(combined);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        focusEditable(ta);
        ta.setSelectionRange(combined.length, combined.length);
        resizeChatInputTextarea(ta);
      });
    },
    rekeyDraft(previousKey: string, nextKey: string) {
      if (previousKey === nextKey) return;
      rekeyComposerHeight(previousKey, nextKey);
      if (draftKeyRef.current !== previousKey) {
        rekeyStoredDraft(previousKey, nextKey);
        return;
      }

      const currentDraft = {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      };
      const moved = rekeyStoredDraft(previousKey, nextKey, currentDraft) ?? { value: "", images: [] };
      const unchanged = moved.value === currentDraft.value
        && moved.images.length === currentDraft.images.length
        && moved.images.every((image, index) => (
          image.data === currentDraft.images[index]?.data
          && image.mimeType === currentDraft.images[index]?.mimeType
        ));
      draftKeyRef.current = nextKey;
      if (unchanged) return;

      const movedImages = draftImagesToAttachedImages(moved.images);
      valueRef.current = moved.value;
      attachedImagesRef.current = movedImages;
      setValue(moved.value);
      setAttachedImages((current) => {
        current.forEach(revokeImagePreview);
        return movedImages;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
    },
    restoreSubmission(text: string, images?: ChatDraftImage[], targetDraftKey?: string) {
      if (!text.trim() && !images?.length) return;

      // clearInput is queued before the submission handler runs. Compose with
      // that queued state so a fast rejection cannot observe stale DOM text and
      // then get overwritten by the clear.
      const currentDraftKey = draftKeyRef.current;
      const destinationDraftKey = targetDraftKey ?? currentDraftKey;
      const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
      const storedDraft = !targetsCurrentComposer && destinationDraftKey
        ? getDraft(destinationDraftKey)
        : null;
      const restoredDraft = mergeRestoredSubmissionDraft(
        text,
        images,
        targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? ""),
        targetsCurrentComposer
          ? attachedImagesRef.current.map(imageToDraftImage)
          : (storedDraft?.images ?? []),
      );
      // The first optimistic message switches ChatWindow out of its empty-state
      // layout and remounts this component. Persist synchronously so recovery is
      // not lost if this instance is the one being unmounted.
      if (destinationDraftKey) setDraft(destinationDraftKey, restoredDraft);
      if (!targetsCurrentComposer) return;
      const restoredIncomingImages = draftImagesToAttachedImages(images);
      const restoredImages = restoredIncomingImages.length
        ? [...restoredIncomingImages, ...attachedImagesRef.current]
        : attachedImagesRef.current;
      // Session promotion can rekey this composer before React flushes the
      // functional updates below, so update the imperative snapshot first.
      valueRef.current = restoredDraft.value;
      attachedImagesRef.current = restoredImages;
      setValue((current) => {
        const restored = mergeRestoredSubmissionText(text, current);
        valueRef.current = restored;
        return restored;
      });
      setAtQuery(null);
      setHistoryMenuOpen(false);
      if (restoredIncomingImages.length) {
        setAttachedImages((current) => {
          const next = [...restoredIncomingImages, ...current];
          attachedImagesRef.current = next;
          return next;
        });
      }
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        focusEditable(ta);
        ta.setSelectionRange(ta.value.length, ta.value.length);
        resizeChatInputTextarea(ta);
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      valueRef.current = newVal;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        focusEditable(ta);
        resizeChatInputTextarea(ta);
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    if (compact) return;
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const imageFiles = files
      .filter((f) => f.type.startsWith("image/") && f.size <= MAX_ATTACHED_IMAGE_BYTES)
      .slice(0, remaining);
    if (!imageFiles.length) return;
    preloadImageCapabilities();
    pendingImageCountRef.current += imageFiles.length;
    try {
      const newImages = await Promise.all(
        imageFiles.map(async (file) => ({
          ...await compressImageFile(file),
          previewUrl: URL.createObjectURL(file),
        }))
      );
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        const next = [...prev, ...accepted];
        attachedImagesRef.current = next;
        return next;
      });
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, [compact]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      attachedImagesRef.current = next;
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    attachedImagesRef.current = [];
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearInput = useCallback(() => {
    valueRef.current = "";
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearImages, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey || draftHydratedKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
    });
  }, [attachedImages, draftKey, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey && draftHydratedKeyRef.current === (draftKey ?? null)) return;

    if (previousDraftKey && previousDraftKey !== draftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    draftHydratedKeyRef.current = draftKey ?? null;
    const nextValue = draft?.value ?? "";
    const nextImages = draftImagesToAttachedImages(draft?.images);
    valueRef.current = nextValue;
    attachedImagesRef.current = nextImages;
    setValue(nextValue);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return nextImages;
    });
  }, [draftKey]);

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    resizeChatInputTextarea(ta);
  }, []);


  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    let previousWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      // Height updates also notify the observer; only remeasure on width changes.
      if (entry.contentRect.width === previousWidth) return;
      previousWidth = entry.contentRect.width;
      resizeTextarea();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [resizeTextarea]);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  const runBuiltinCommand = useCallback(async (msg: string): Promise<boolean> => {
    if (attachedImages.length || !msg.startsWith("/") || !onBuiltinCommand) return false;
    if (builtinCommandPendingRef.current) return true;
    builtinCommandPendingRef.current = true;
    setBuiltinCommandPending(true);
    try {
      const result = await onBuiltinCommand(msg);
      if (!result.handled) return false;
      if (!result.error && canClearBuiltinCommandInput(valueRef.current, attachedImagesRef.current.length, msg)) clearInput();
      return true;
    } finally {
      builtinCommandPendingRef.current = false;
      setBuiltinCommandPending(false);
    }
  }, [attachedImages.length, clearInput, onBuiltinCommand]);

  const lastSubmissionAtRef = useRef(-Infinity);
  const handleStopClick = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    // A send button can become Stop between the two taps of one gesture.
    // Keyboard activation and the dedicated Escape shortcut remain immediate.
    if (event.detail !== 0 && performance.now() - lastSubmissionAtRef.current < 500) return;
    onAbort();
  }, [onAbort]);

  const handleSend = useCallback(async (event?: React.MouseEvent<HTMLButtonElement>) => {
    const msg = value.trim();
    const currentImageCount = Math.max(attachedImages.length, attachedImagesRef.current.length);
    const builtinAllowed = !isStreaming || offersBuiltinSlashCommandWhileStreaming(msg);
    if (builtinAllowed && await runBuiltinCommand(msg)) return;
    if (isStreaming) return;
    const enhancementWindow = typeof window !== "undefined" ? window as Window & {
      __PI_ENH_PREPARE_COMPOSER_SUBMISSION__?: (kind: "send" | "steer" | "followup", body: string) => { text: string; commit: () => void } | null;
    } : null;
    const submission = enhancementWindow?.__PI_ENH_PREPARE_COMPOSER_SUBMISSION__?.("send", msg) ?? null;
    const submittedText = (submission?.text ?? msg) || (event?.type === "click" && allowEmptyContinue && currentImageCount === 0 ? "继续" : "");
    if (!submittedText && !currentImageCount) return;
    if (currentImageCount > MAX_ATTACHED_IMAGES) return;
    onAudioUnlock?.();
    clearInput();
    lastSubmissionAtRef.current = performance.now();
    onSend(submittedText, attachedImages.length ? attachedImages : undefined);
    submission?.commit();
  }, [value, attachedImages, isStreaming, allowEmptyContinue, runBuiltinCommand, onSend, clearInput, onAudioUnlock]);

  const slashQuery = !compact && value.startsWith("/") && !/\s/.test(value.slice(1))
    ? value.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const builtinCommands = (isStreaming
      ? BUILTIN_SLASH_COMMANDS.filter((command) => command.availableWhileStreaming)
      : BUILTIN_SLASH_COMMANDS).filter((command) => !isCodexEngine || !["compact", "auto-compact", "clone"].includes(command.name));
    const commands = [...builtinCommands, ...(isCodexEngine ? [] : slashCommands ?? [])];
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = getSlashDescription(command, t).toLowerCase();
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery, t) - slashMatchRank(b, slashQuery, t);
        if (rankDelta !== 0) return rankDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || TEXT_COLLATOR.compare(a.name, b.name);
      });
  })();

  const {
    commands: displayedSlashCommands,
    groups: groupedSlashCommands,
  } = buildSlashCommandLayout(filteredSlashCommands, skillDormancy);

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "chat.match" : "chat.command")
    : t(slashQuery ? "chat.matches" : "chat.commands", { count: filteredSlashCommands.length });
  const hasInputText = Boolean(value.trim());
  const tooManyImagesNotice = getTooManyImagesNotice(attachedImages.length, MAX_ATTACHED_IMAGES, locale);
  const canSendMessage = (hasInputText || attachedImages.length > 0 || hasEnhancedSubmissionPayload || allowEmptyContinue) && !tooManyImagesNotice;
  const canQueueStreamingMessage = (hasInputText || attachedImages.length > 0 || hasEnhancedSubmissionPayload) && !tooManyImagesNotice && !queuedSubmissionPending && !queuedPreviewVisible;
  // Warn when images are attached but the selected model is known not to accept
  // image input (#584), including a resolved default. Unknown models stay silent.
  const showImageUnsupportedWarning = (
    attachedImages.length > 0
    && !modelSupportsImageInput(model, modelList)
    && !imageWarningDismissed
  );
  useEffect(() => {
    if (attachedImages.length === 0) setImageWarningDismissed(false);
  }, [attachedImages.length]);

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (typeof window !== "undefined" && (window as any).__PI_ENH_DISABLE_NATIVE_AT_FILES__) {
      setAtQuery(null);
      return;
    }
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      focusEditable(el);
      el.setSelectionRange(newPos, newPos);
      resizeChatInputTextarea(el);
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    setValue(text);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      focusEditable(ta);
      ta.setSelectionRange(text.length, text.length);
      resizeChatInputTextarea(ta);
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      focusEditable(ta);
      ta.setSelectionRange(nextValue.length, nextValue.length);
      resizeChatInputTextarea(ta);
    });
  }, []);

  const sendQueued = useCallback(async (mode: "steer" | "followup") => {
    if (queuedSubmissionPendingRef.current || queuedPreviewVisible) return;
    const msg = value.trim();
    const images = attachedImagesRef.current;
    const currentImageCount = Math.max(attachedImages.length, images.length);
    onAudioUnlock?.();
    if (!currentImageCount && onBuiltinCommand && offersBuiltinSlashCommandWhileStreaming(msg)) {
      if (await runBuiltinCommand(msg)) return;
    }
    const enhancementWindow = typeof window !== "undefined" ? window as Window & {
      __PI_ENH_PREPARE_COMPOSER_SUBMISSION__?: (kind: "send" | "steer" | "followup", body: string) => { text: string; commit: () => void } | null;
    } : null;
    const submission = enhancementWindow?.__PI_ENH_PREPARE_COMPOSER_SUBMISSION__?.(mode, msg) ?? null;
    const submittedText = submission?.text ?? msg;
    if (!submittedText && !currentImageCount) return;
    if (currentImageCount > MAX_ATTACHED_IMAGES) return;
    lastSubmissionAtRef.current = performance.now();
    queuedSubmissionPendingRef.current = true;
    setQueuedSubmissionPending(true);
    const kind: "steering" | "followUp" = mode === "steer" ? "steering" : "followUp";
    const preview = {
      token: {}, identity: null,
      draftKey: draftKeyRef.current, text: submittedText, kind,
      images: images.map(({ data, mimeType }) => ({ data, mimeType })),
    };
    setQueuedSubmissionPreview(preview);
    const onRegistered = (identity: PromptSubmissionPreviewIdentity) => {
      setQueuedSubmissionPreview((current) => current?.token === preview.token ? { ...current, identity } : current);
      // The durable outbox now owns text and images. Preserve edits made while
      // storage was opening rather than clearing a newer draft or another tab.
      if (identity.durable !== false && draftKeyRef.current === preview.draftKey && valueRef.current === value
        && attachedImagesRef.current.length === images.length
        && attachedImagesRef.current.every((image, index) => image === images[index])) clearInput();
    };
    try {
      const submittedImages = images.length ? images : undefined;
      let accepted: boolean | void = false;
      if (submittedText.startsWith("/") && onPromptWithStreamingBehavior) {
        accepted = await onPromptWithStreamingBehavior(submittedText, mode === "steer" ? "steer" : "followUp", submittedImages, onRegistered);
      } else if (mode === "steer" && onSteer) {
        accepted = await onSteer(submittedText, submittedImages, onRegistered);
      } else if (mode === "followup" && onFollowUp) {
        accepted = await onFollowUp(submittedText, submittedImages, onRegistered);
      }
      if (accepted !== false) submission?.commit();
      else setQueuedSubmissionPreview((current) => current?.token === preview.token ? null : current);
    } catch (error) {
      setQueuedSubmissionPreview((current) => current?.token === preview.token ? null : current);
      throw error;
    } finally {
      queuedSubmissionPendingRef.current = false;
      setQueuedSubmissionPending(false);
    }
  }, [value, attachedImages, queuedMessages, queuedPreviewVisible, onBuiltinCommand, onPromptWithStreamingBehavior, onSteer, onFollowUp, clearInput, onAudioUnlock, runBuiltinCommand]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = displayedSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [displayedSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const enhancementWindow = typeof window !== "undefined" ? window as Window & {
        __PI_ENH_IS_MOBILE_ENV__?: () => boolean;
        __PI_ENH_SWITCH_COMPOSER_MODE__?: (mode: ComposerMode, sessionId?: string) => Promise<boolean>;
        __PI_ENH_IS_PLUGIN_ENABLED__?: (pluginId: string) => boolean;
        __PI_ENH_GET_ACTIVE_AT_MENTION_MENU__?: (textarea: HTMLTextAreaElement) => { count: number } | null;
        __PI_ENH_MOVE_ACTIVE_AT_MENTION__?: (delta: number) => void;
        __PI_ENH_APPLY_ACTIVE_AT_MENTION__?: () => boolean;
        __PI_ENH_CLOSE_AT_MENTION_MENU__?: () => void;
      } : null;
      const mobileEnterEnabled = enhancementWindow?.__PI_ENH_IS_PLUGIN_ENABLED__?.("mobile-enter-newline") ?? true;
      const mobileEnterNewline = mobileEnterEnabled
        && (enhancementWindow?.__PI_ENH_IS_MOBILE_ENV__?.() ?? isMobile);
      const sendShortcut = e.key === "Enter" && !e.shiftKey && (!mobileEnterNewline || e.ctrlKey || e.metaKey);
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !isComposing
        && enhancementWindow?.__PI_ENH_IS_PLUGIN_ENABLED__?.("composer-modes")
        && enhancementWindow.__PI_ENH_SWITCH_COMPOSER_MODE__) {
        e.preventDefault();
        if (!nativeEvent.repeat) {
          const snapshot = readComposerModeSnapshot();
          void enhancementWindow.__PI_ENH_SWITCH_COMPOSER_MODE__(snapshot.mode === "plan" ? "normal" : "plan", snapshot.sessionId ?? undefined);
        }
        return;
      }

      if (sendShortcut && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      // The optional plugin candidate list is rendered by its enhancement,
      // while this native handler remains the sole owner of composer keys.
      const enhancedAtMenu = enhancementWindow?.__PI_ENH_GET_ACTIVE_AT_MENTION_MENU__?.(e.currentTarget) ?? null;
      if (enhancedAtMenu && !isComposing) {
        if (e.key === "ArrowDown" && enhancedAtMenu.count > 0) {
          e.preventDefault();
          e.stopPropagation();
          enhancementWindow?.__PI_ENH_MOVE_ACTIVE_AT_MENTION__?.(1);
          return;
        }
        if (e.key === "ArrowUp" && enhancedAtMenu.count > 0) {
          e.preventDefault();
          e.stopPropagation();
          enhancementWindow?.__PI_ENH_MOVE_ACTIVE_AT_MENTION__?.(-1);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          enhancementWindow?.__PI_ENH_CLOSE_AT_MENTION_MENU__?.();
          return;
        }
        if ((e.key === "Tab" || e.key === "Enter") && enhancedAtMenu.count > 0) {
          e.preventDefault();
          e.stopPropagation();
          enhancementWindow?.__PI_ENH_APPLY_ACTIVE_AT_MENTION__?.();
          return;
        }
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        const selectedCommand = displayedSlashCommands[slashActiveIndex];
        if (e.key === "Tab" && selectedCommand) {
          e.preventDefault();
          applySlashCommand(selectedCommand);
          return;
        }
        if (sendShortcut && selectedCommand) {
          e.preventDefault();
          if (submitsSlashCommandOnEnter(value, selectedCommand, isStreaming)) {
            setSlashMenuOpen(false);
            void handleSend();
          } else {
            applySlashCommand(selectedCommand);
          }
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => cycleListIndex(i, atMatches.length, -1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || sendShortcut) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
        && !isComposing && !recentlyComposed && acceptInlineSuggestion()) {
        e.preventDefault();
        return;
      }
      if (e.key === "Escape" && !isComposing && visibleSuggestion && suggestionKey) {
        e.preventDefault();
        setConsumedSuggestionKey(suggestionKey);
        cancelSuggestionTouch();
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (sendShortcut) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          sendQueued((e.ctrlKey || e.metaKey) && onSteer ? "steer" : "followup");
        } else {
          handleSend();
        }
      }
    },
    [isMobile, isStreaming, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, displayedSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value, acceptInlineSuggestion, visibleSuggestion, suggestionKey, cancelSuggestionTouch]
  );

  useEffect(() => {
    const refreshSubmissionState = () => {
      const enhancementWindow = window as Window & {
        __PI_ENH_GET_COMPOSER_SUBMISSION_STATE__?: () => {
          hasAnnotations?: boolean;
          hasAttachments?: boolean;
          hasQuickReply?: boolean;
          emptyContinueEnabled?: boolean;
        } | null;
      };
      const state = enhancementWindow.__PI_ENH_GET_COMPOSER_SUBMISSION_STATE__?.();
      setHasEnhancedSubmissionPayload(state?.hasAnnotations === true || state?.hasAttachments === true || state?.hasQuickReply === true);
      setEmptyContinueEnabled(state?.emptyContinueEnabled === true);
    };
    refreshSubmissionState();
    window.addEventListener("pi-enh-composer-submission-state-change", refreshSubmissionState);
    return () => window.removeEventListener("pi-enh-composer-submission-state-change", refreshSubmissionState);
  }, []);

  useEffect(() => {
    if (!textareaRef.current) return;
    window.dispatchEvent(new Event("pi-native-composer-mounted"));
    return () => { window.dispatchEvent(new Event("pi-native-composer-unmounted")); };
  }, []);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // Shift+Enter on desktop, Enter on mobile keyboards: every newline the
    // textarea inserts arrives here, while IME confirmations and sends do not.
    const continueList = (event: InputEvent) => {
      if (event.inputType !== "insertLineBreak" || event.isComposing) return;
      const edit = getMarkdownListContinuation(ta.value, ta.selectionStart, ta.selectionEnd);
      if (!edit) return;
      event.preventDefault();
      ta.setSelectionRange(edit.start, edit.end);
      // insertText keeps the edit on the native undo stack and fires the input
      // event that updates the controlled value.
      document.execCommand(edit.text ? "insertText" : "delete", false, edit.text);
    };
    ta.addEventListener("beforeinput", continueList);
    return () => ta.removeEventListener("beforeinput", continueList);
  }, []);

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    resizeChatInputTextarea(ta);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!compact && imageItems.length) {
      e.preventDefault();
      const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
      processImageFiles(files);
      return;
    }

    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    if (!html || !text) return;
    const document = new DOMParser().parseFromString(html, "text/html");
    const links = Array.from(document.querySelectorAll("a[href]"), (link) => {
      const label = link.textContent ?? "";
      const range = document.createRange();
      range.setStart(document.body, 0);
      range.setEndBefore(link);
      return {
        label,
        href: link.getAttribute("href")?.trim() ?? "",
        occurrence: label ? range.toString().split(label).length - 1 : 0,
      };
    });
    const markdown = replaceLinksWithMarkdown(text, links);
    if (markdown === null) return;

    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const nextValue = ta.value.slice(0, start) + markdown + ta.value.slice(ta.selectionEnd);
    e.preventDefault();
    valueRef.current = nextValue;
    setValue(nextValue);
    setHistoryMenuOpen(false);
    updateAtQuery(nextValue, start + markdown.length);
    requestAnimationFrame(() => {
      focusEditable(ta);
      ta.setSelectionRange(start + markdown.length, start + markdown.length);
    });
  }, [compact, processImageFiles, updateAtQuery]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  // Lazy-load skill dormancy (disable-model-invocation) each time the slash
  // palette opens, so toggles made in the skills panel are reflected on the
  // next open. Failures degrade silently to the unannotated palette.
  useEffect(() => {
    if (isCodexEngine || !slashMenuOpen || !cwd) return;
    const requestCwd = cwd;
    let cancelled = false;
    setSkillDormancyState({ cwd: requestCwd, values: {} });
    fetch(`/api/skills?cwd=${encodeURIComponent(requestCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`skills fetch failed: ${res.status}`);
        return res.json() as Promise<Partial<SkillsResponse>>;
      })
      .then((data) => {
        if (cancelled) return;
        const dormancy: Record<string, boolean> = {};
        for (const skill of data.skills ?? []) dormancy[skill.name] = skill.disableModelInvocation;
        setSkillDormancyState({ cwd: requestCwd, values: dormancy });
      })
      .catch(() => {
        if (!cancelled) setSkillDormancyState({ cwd: requestCwd, values: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [slashMenuOpen, cwd, isCodexEngine]);

  useEffect(() => {
    if (slashActiveIndex >= displayedSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, displayedSlashCommands.length - 1));
    }
  }, [displayedSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = displayedSlashCommands.length;
  }, [displayedSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  useLayoutEffect(() => {
    if (!slashMenuOpen || slashQuery === null) {
      setSlashMenuMaxHeight(null);
      return;
    }
    const menu = slashMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setSlashMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [slashMenuOpen, slashQuery]);

  useLayoutEffect(() => {
    if (!atMenuOpen || atQuery === null) {
      setAtMenuMaxHeight(null);
      return;
    }
    const menu = atMenuRef.current;
    if (!menu) return;
    return subscribeUpwardMenuMaxHeight(menu, (nextHeight) => {
      setAtMenuMaxHeight((current) => current === nextHeight ? current : nextHeight);
    });
  }, [atMenuOpen, atQuery]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelSelectorOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  })();

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  const resolvedThinkingLevel = thinkingLevel && thinkingLevel !== "auto" ? thinkingLevel : null;
  const thinkingDisplayLabel = (() => {
    const lvl = resolvedThinkingLevel ?? "auto";
    if (lvl === "auto" || !thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const {
    codexLayoutEnabled,
    modesEnabled,
    customHeight,
    heightLocked,
    setCustomHeight,
  } = useComposerLayoutPreferences(draftKey);
  const [nativeComposerMode, setNativeComposerMode] = useState<ComposerMode>("normal");
  const handleNativeComposerModeChange = useCallback((mode: ComposerMode) => {
    setNativeComposerMode((current) => current === mode ? current : mode);
  }, []);

  const handleModesHostReady = useCallback((node: HTMLDivElement | null) => {
    if (node) window.dispatchEvent(new Event("pi-native-composer-preferences-change"));
  }, []);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const gestureRef = useRef<{ owner: string | undefined; y: number; height: number; latest: number | null } | null>(null);
  const ignoreResizeClickRef = useRef(false);
  const effectiveCustomHeight = dragHeight ?? customHeight;
  const fixedHeight = dragHeight !== null || heightLocked;

  const measureComposerHeight = useCallback(() => {
    const ta = textareaRef.current;
    // The formatting plugin owns its visible editable, not the hidden proxy.
    const formatted = ta?.parentElement?.querySelector<HTMLElement>(".pi-enh-formatted-composer:not([style*='display: none'])");
    return (formatted ?? ta)?.getBoundingClientRect().height || 28;
  }, []);

  const handleResizerPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    ignoreResizeClickRef.current = false;
    gestureRef.current = { owner: draftKey, y: e.clientY, height: measureComposerHeight(), latest: null };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [draftKey, measureComposerHeight]);

  const handleResizerPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.owner !== draftKey) return;
    const delta = gesture.y - e.clientY;
    if (gesture.latest === null && Math.abs(delta) < 4) return;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const height = Math.max(44, Math.min(Math.floor(viewportHeight * 0.8), Math.round(gesture.height + delta)));
    gesture.latest = height;
    ignoreResizeClickRef.current = true;
    setDragHeight(height);
  }, [draftKey]);

  const handleResizerPointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (gesture && gesture.owner === draftKey && gesture.latest !== null) {
      // One write per completed gesture, using its latest value even in one React batch.
      setCustomHeight(gesture.latest, true);
    }
    setDragHeight(null);
  }, [draftKey, setCustomHeight]);

  const handleResizerPointerCancel = useCallback(() => {
    if (!gestureRef.current) return;
    gestureRef.current = null;
    setDragHeight(null);
  }, []);

  const toggleComposerHeightLock = useCallback(() => {
    if (ignoreResizeClickRef.current) {
      ignoreResizeClickRef.current = false;
      return;
    }
    // Unlock also discards the manual minimum so automatic sizing resumes immediately.
    setCustomHeight(heightLocked ? null : measureComposerHeight(), !heightLocked);
  }, [heightLocked, measureComposerHeight, setCustomHeight]);

  useLayoutEffect(() => {
    gestureRef.current = null;
    setDragHeight(null);
  }, [draftKey]);

  const [goalHost, setGoalHost] = useState<HTMLDivElement | null>(null);
  const isCodexActive = codexLayoutEnabled && !compact;
  useLayoutEffect(resizeTextarea, [value, visibleSuggestion?.text, fontSize, isCodexActive, effectiveCustomHeight, fixedHeight, resizeTextarea]);
  const hasUserContent = Boolean(value && value.trim().length > 0);

  const rootClassName = isCodexActive
    ? [
        "chat-composer-card pi-enh-cursor-composer",
        "chat-composer-model-pill pi-enh-composer-model-pill",
        fixedHeight ? "chat-composer-custom-height" : "",
        isStreaming ? "has-running-controls" : "",
        hasUserContent ? "has-user-content" : "",
      ].filter(Boolean).join(" ")
    : "chat-composer-classic";

  const rootStyle: React.CSSProperties = {
    maxWidth: "var(--chat-content-max-width, 820px)",
    margin: "0 auto",
    ...(isCodexActive && effectiveCustomHeight
      ? { "--pi-composer-custom-height": `${effectiveCustomHeight}px` }
      : {}),
  } as React.CSSProperties;



  return (
    <div
      data-pi-native-composer-host="true"
      data-pi-execution-engine={executionEngine}
      role="group"
      inert={builtinCommandPending || undefined}
      aria-busy={builtinCommandPending}
      style={{
        flexShrink: 0,
        minWidth: 0,
        margin: 0,
        border: 0,
        background: "transparent",
        padding: compact ? 0 : "0 16px 8px",
        paddingRight: compact ? 0 : 16 + (columnEndInset ?? (isMobile ? 0 : 36)),
        opacity: builtinCommandPending ? 0.5 : 1,
        transition: "opacity 0.15s",
      }}
    >
      {/* Hidden file input */}
      {!compact && <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
          e.target.value = "";
        }}
      />}
      <ComposerQueue sessionId={draftKey ?? ""} executionEngine={executionEngine} queuedMessages={queuedMessages} syncStatus={queueSyncStatus} onRecallQueue={onRecallQueue} pending={queuedPreviewVisible ? queuedSubmissionPreview : null} retainedSubmissions={retainedSubmissions} deliveredRequestIds={deliveredRequestIds} />
      {extensionPanel}
      {isCodexActive && modesEnabled && <div ref={setGoalHost} className="chat-composer-goal-host" style={{maxWidth: rootStyle.maxWidth, marginLeft: "auto", marginRight: "auto"}} />}
      <div className={rootClassName} style={rootStyle} data-pi-native-composer-layout="true" data-pi-native-inline-suggestions={!compact ? "true" : undefined}
        data-composer-min-height={!fixedHeight ? customHeight ?? undefined : undefined}>
        {isCodexActive && (
          <button
            type="button"
            className={`chat-composer-resizer ${heightLocked ? "chat-composer-height-locked" : ""} ${dragHeight !== null ? "chat-composer-resizing" : ""}`}
            aria-label={heightLocked ? "取消输入框高度锁定" : "锁定输入框高度"}
            aria-pressed={heightLocked}
            title={heightLocked ? "高度已锁定，单击恢复自动撑高；拖动调整高度" : "自动撑高，单击锁定当前高度；拖动调整并锁定高度"}
            onClick={toggleComposerHeightLock}
            onPointerDown={handleResizerPointerDown}
            onPointerMove={handleResizerPointerMove}
            onPointerUp={handleResizerPointerUp}
            onPointerCancel={handleResizerPointerCancel}
            onLostPointerCapture={handleResizerPointerCancel}
          >
            <span className="chat-composer-resizer-line" />
          </button>
        )}
        <div className={isCodexActive ? "chat-composer-banner-stack" : ""}>
        <ModelErrorBanner error={modelError} />
        {tooManyImagesNotice && (
          <ModelNoticeBanner tone="error" title={tooManyImagesNotice.title} body={tooManyImagesNotice.body} />
        )}
        {showImageUnsupportedWarning && (() => {
          const entry = modelList?.find((m) => m.provider === model?.provider && m.id === model?.modelId);
          return (
            <ModelNoticeBanner
              tone="warning"
              title={t("chat.imageNotSupportedTitle")}
              body={t("chat.imageNotSupportedBody", { model: entry?.name || model?.modelId || "" })}
              onClose={() => setImageWarningDismissed(true)}
            />
          );
        })()}
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.24)",
            borderRadius: 6, fontSize: 12, color: "rgba(5,150,105,0.95)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {compactError && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              padding: "7px 10px",
              background: "rgba(239,68,68,0.07)",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
              color: "#ef4444",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {compactError}
          </div>
        )}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div
            className={isCodexActive ? "chat-composer-attachments" : ""}
            style={{
              display: "flex",
              gap: 6,
              marginBottom: isCodexActive ? 0 : 6,
              flexWrap: isCodexActive ? "nowrap" : "wrap",
            }}
          >
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                <ImagePreview key={img.previewUrl} src={img.previewUrl}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={img.previewUrl}
                    alt=""
                    style={{ width: isCodexActive ? 44 : 56, height: isCodexActive ? 44 : 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                  />
                </ImagePreview>
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        </div>
        {/* Main input */}
        <div
          className={isCodexActive ? "chat-composer-editor-container chat-composer-contents" : ""}
          style={{ position: "relative", minWidth: 0, display: isCodexActive ? "contents" : undefined }}
        >
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                maxHeight: "min(44vh, 360px)",
              }}
            >
              <div
                title={t("chat.inputHistory")}
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: "calc(min(44vh, 360px) - 31px)", overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: 6,
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              ref={slashMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "calc(100% + 8px)",
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                overflow: "hidden",
                boxSizing: "border-box",
                display: "flex",
                flexDirection: "column",
                maxHeight: slashMenuMaxHeight === null
                  ? "min(72.8vh, 598px)"
                  : `min(72.8vh, 598px, ${slashMenuMaxHeight}px)`,
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                  flexShrink: 0,
                }}
              >
                 <span>{slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: slashCommandCountLabel })}</span>
                 <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
              </div>
              <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                     {t("chat.noCommands")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                           <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, skillDormancy);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: 7,
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{
                                fontSize: 13,
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                color: dormant ? "var(--text-dim)" : undefined,
                              }}>
                                /{command.name}
                                {dormant && (
                                  <span style={{
                                    marginLeft: 6,
                                    padding: "0 4px",
                                    border: "1px solid var(--border)",
                                    borderRadius: 3,
                                    fontSize: 9,
                                    color: "var(--text-dim)",
                                    whiteSpace: "nowrap",
                                  }}>
                                    {t("chat.dormant")}
                                  </span>
                                )}
                              </span>
                               {command.description && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                   {getSlashDescription(command, t)}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
               ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
              : "";
            return (
              <div
                ref={atMenuRef}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: "calc(100% + 8px)",
                  zIndex: 120,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  boxShadow: "0 -6px 20px rgba(0,0,0,0.12)",
                  overflow: "hidden",
                  boxSizing: "border-box",
                  display: "flex",
                  flexDirection: "column",
                  maxHeight: atMenuMaxHeight === null
                    ? "min(48vh, 400px)"
                    : `min(48vh, 400px, ${atMenuMaxHeight}px)`,
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                    flexShrink: 0,
                  }}
                >
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          <div
            className={isCodexActive ? "chat-composer-editor-host chat-composer-contents" : ""}
            style={isCodexActive ? ({
              display: "contents",
            } as React.CSSProperties) : ({
              minWidth: 0,
              display: "flex",
              flexDirection: compact ? "column" : "row",
              gap: 8,
              alignItems: compact ? "stretch" : "center",
              background: "var(--bg)",
              border: compact ? "none" : `1px solid ${bashMode ? "var(--tool-bg)" : isStreaming && (onSteer || onFollowUp)
                ? "rgba(234,179,8,0.4)"
                : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
              borderRadius: compact ? 0 : 14,
              padding: compact ? 0 : "10px 10px 10px 14px",
              boxShadow: compact ? "none" : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties)}
          >
          <textarea
            ref={textareaRef}
            className="chat-input-textarea"
            data-pi-inline-suggestion={visibleSuggestion ? suggestionKey : undefined}
            aria-description={visibleSuggestion ? "建议内容，按 Tab 或在手机上双击采纳；采纳后不会自动发送" : undefined}
            onTouchStart={startSuggestionTouch}
            onTouchMove={moveSuggestionTouch}
            onTouchEnd={endSuggestionTouch}
            onTouchCancel={cancelSuggestionTouch}
            data-pi-native-list-continuation="true"
            aria-label={compact ? t("chat.quoteQuestion") : undefined}
            value={value}
            onChange={(e) => {
              valueRef.current = e.target.value;
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
              setSuggestionComposing(true);
              cancelSuggestionTouch();
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              setSuggestionComposing(false);
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={visibleSuggestion?.text ?? (
              isStreaming && (onSteer || onFollowUp)
                ? t("chat.steerPlaceholder")
                : isStreaming ? t("chat.agentPlaceholder")
                : isCodexActive && modesEnabled && nativeComposerMode === "plan"
                  ? "描述你的任务以生成方案…"
                  : isCodexActive && modesEnabled && nativeComposerMode === "goal"
                    ? "描述你的目标，定义可衡量的成果，以获得最佳效果…"
                : ""
            )}
            rows={1}
            style={{
              flex: compact ? "none" : 1,
              minWidth: 0,
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: "var(--chat-content-font-size, 14px)",
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: isCodexActive ? undefined : (compact ? 96 : 24),
              maxHeight: isCodexActive ? undefined : 200,
              overflow: "auto",
            }}
          />

          {isStreaming ? (
            <div
              className={isCodexActive ? "chat-composer-send-group chat-composer-actions" : ""}
              style={isCodexActive ? undefined : { display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}
            >
              {onSteer && (
                <button
                  type="button"
                  onClick={() => sendQueued("steer")}
                  disabled={!canQueueStreamingMessage}
                  aria-label="将消息加入引导队列"
                  title="将消息加入引导队列"
                  className="chat-composer-steer pi-enh-cursor-send pi-enh-cursor-steer"
                >
                  <ComposerQueueIcon kind="promote" />
                </button>
              )}
              {onFollowUp && (
                <button
                  onClick={() => sendQueued("followup")}
                  disabled={!canQueueStreamingMessage}
                  title={`${t("chat.followUpHint")} (${isMobile ? "Ctrl/Cmd+" : ""}Alt/Option+Enter)`}
                  aria-keyshortcuts={isMobile ? "Control+Alt+Enter Meta+Alt+Enter" : "Alt+Enter"}
                  className={isCodexActive ? "chat-composer-followup pi-enh-cursor-send pi-enh-cursor-followup" : ""}
                  style={isCodexActive ? undefined : {
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: canQueueStreamingMessage ? "rgba(129,140,248,0.12)" : "none",
                    border: "1px solid rgba(129,140,248,0.35)",
                    borderRadius: 8,
                    color: canQueueStreamingMessage ? "rgba(99,102,241,1)" : "var(--text-dim)",
                    cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  {isCodexActive ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 13V3M3 8l5-5 5 5" />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                      <line x1="2" y1="9" x2="8" y2="9" />
                    </svg>
                  )}
                  {t("chat.followUp")}
                </button>
              )}
            </div>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSendMessage}
              title={tooManyImagesNotice ? `${tooManyImagesNotice.title} — ${tooManyImagesNotice.body}` : undefined}
              aria-label={t("chat.send")}
              className={isCodexActive ? "chat-composer-send pi-enh-cursor-send" : ""}
              style={isCodexActive ? undefined : {
                flexShrink: 0,
                alignSelf: "flex-end",
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 14px",
                background: canSendMessage ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: 8,
                color: canSendMessage ? "var(--accent-contrast)" : "var(--text-dim)",
                cursor: canSendMessage ? "pointer" : "not-allowed",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                boxShadow: canSendMessage ? "0 1px 3px color-mix(in srgb, var(--accent) 25%, transparent)" : "none",
                transition: "background 0.15s, box-shadow 0.15s",
              }}
            >
              {isCodexActive ? (
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 13V3M3 8l5-5 5 5" />
                </svg>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="2" y1="7" x2="11" y2="7" />
                    <polyline points="7.5 3 12 7 7.5 11" />
                  </svg>
                  {t("chat.send")}
                </>
              )}
            </button>
          )}
          </div>
        </div>

        {/* Bash mode status label */}
        {/* Bottom bar: left | center (context) | right */}
        {!compact && <div
          data-pi-composer-toolbar="true"
          className={isCodexActive ? "chat-composer-toolbar chat-composer-contents" : ""}
          style={isCodexActive ? { display: "contents" } : {
            marginTop: 8,
            display: isMobile ? "grid" : "flex",
            gridTemplateColumns: isMobile ? "minmax(0, 1fr) auto" : undefined,
            alignItems: "center",
            gap: 6,
          }}
        >

          {/* LEFT: add button + attach image button */}
          <div
            className={isCodexActive ? "chat-composer-left chat-composer-contents" : ""}
            style={isCodexActive ? { display: "contents" } : { flex: isMobile ? "1 1 auto" : "0 0 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 2 }}
          >
            {isCodexActive && modesEnabled && (
              <div
                ref={handleModesHostReady}
                className="chat-composer-mode-host"
                data-pi-composer-mode-host="true"
              >
                <NativeComposerModeControls onModeChange={handleNativeComposerModeChange} goalHost={goalHost} />
              </div>
            )}
            <div className="chat-composer-attachment-controls">
            <button
              onClick={() => fileInputRef.current?.click()}
              title={t("chat.attachImage")}
              data-pi-attach-image="true"
              className={isCodexActive ? "chat-composer-attach-btn" : ""}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: isCodexActive ? 28 : 32,
                height: isCodexActive ? 28 : 32,
                minWidth: isCodexActive ? 28 : 32,
                padding: 0,
                background: "none", border: "none",
                borderRadius: isCodexActive ? 8 : 9,
                color: attachedImages.length ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                opacity: 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            </div>
            {/* 经典模式下模型选择器留在左侧 */}
            {!isCodexActive && (modelsLoading || modelOptions.length > 0 || model || modelError) && onModelChange && (
              <ModelSelector
                options={modelOptions}
                loading={modelsLoading}
                value={model}
                onChange={onModelChange}
                // Running sessions save this selection for the next user message.
                busy={modelSwitching}
                title={isStreaming ? "为下一条消息选择模型，当前任务继续使用原模型" : undefined}
                isAutoSelection={isAutoModelSelection}
              />
            )}
          </div>

          {/* spacer */}
          {!isMobile && !isCodexActive && <div style={{ flex: 1 }} />}

          {/* RIGHT: controls */}
          <div
            className={isCodexActive ? "chat-composer-right chat-composer-contents" : ""}
            style={isCodexActive ? { display: "contents" } : {
              flex: "0 0 auto",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              position: "relative",
              marginLeft: isMobile ? 0 : "auto",
            }}
          >
            <div className={isCodexActive ? "chat-composer-model-controls chat-composer-control-capsule" : undefined} style={!isCodexActive ? { display: "flex", alignItems: "center", gap: 2 } : undefined}>
            {/* Codex 模式下模型选择器位于 Row 3 倒数第 4 列 */}
            {isCodexActive && (modelsLoading || modelOptions.length > 0 || model || modelError) && onModelChange && (
              <ModelSelector
                options={modelOptions}
                loading={modelsLoading}
                value={model}
                onChange={onModelChange}
                // Running sessions save this selection for the next user message.
                busy={modelSwitching}
                title={isStreaming ? "为下一条消息选择模型，当前任务继续使用原模型" : undefined}
                isAutoSelection={isAutoModelSelection}
              />
            )}

            {onThinkingLevelChange && (
              <ThinkingSelector
                disabled={false}
                levels={THINKING_LEVELS.filter((level) => !availableThinkingLevels || level === "auto" || availableThinkingLevels.includes(level))}
                value={isAutoThinkingSelection ? "auto" : resolvedThinkingLevel ?? "auto"}
                displayLabel={thinkingDisplayLabel}
                levelMap={thinkingLevelMap}
                descriptions={Object.fromEntries(THINKING_LEVELS.map((level) => [level, t(THINKING_LEVEL_DESC_KEYS[level])]))}
                label={t("chat.changeReasoningLabel")}
                title={isStreaming ? `为下一条消息设置思考深度：${thinkingDisplayLabel}` : t("chat.changeReasoning", { level: thinkingDisplayLabel })}
                native={isCodexActive}
                onChange={onThinkingLevelChange}
              />
            )}
            </div>

            {/* 运行态 Stop 按钮 (在 Codex 模式下为 24px 圆形图标按钮，位于 Col -2) */}
            {isStreaming && (
              <button
                onClick={handleStopClick}
                title={t("chat.stopAgent")}
                aria-label={t("chat.stopAgent")}
                className={isCodexActive ? "chat-composer-stop" : ""}
                style={isCodexActive ? undefined : {
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px",
                  height: 32,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  borderRadius: 9,
                  color: "#ef4444",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.16)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.08)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" />
                </svg>
                {!isCodexActive && t("chat.stop")}
              </button>
            )}

          </div>

        </div>}
      </div>
    </div>
  );
});
