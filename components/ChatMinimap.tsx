"use client";

import { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import { isMessageGroupAnchor } from "@/lib/message-display";
import type { AgentMessage, TextContent, UserMessage } from "@/lib/types";
import { useMinimapBookmarks } from "@/hooks/useMinimapBookmarks";
import { useMobileHorizontalSwipe } from "@/hooks/useMobileHorizontalSwipe";
import { stripDimensionNotes } from "./MessageView";
import styles from "./ChatMinimap.module.css";

interface Props {
  overlay?: boolean;
  onClose?: () => void;
  sessionId: string | null;
  messages: AgentMessage[];
  streamingMessage: Partial<AgentMessage> | null;
  scrollContainer: RefObject<HTMLDivElement | null>;
  messageRefs: RefObject<(HTMLDivElement | null)[]>;
  onRevealHistory: () => void;
}

const MINIMAP_WIDTH = 36;
const MAX_NODE_GAP = 50;
const MINIMAP_PADDING = 12;
const PREVIEW_HIDE_DELAY = 250;
// Explicit selections remain stable until the user scrolls the chat again.
const NAVIGATION_ACTIVE_LOCK_MS = Infinity;

export interface TurnInfo {
  userTurnNumber: number;
  userMessage: UserMessage;
  scrollTop: number | null;
  element?: HTMLDivElement | null;
  entryId?: string;
  bookmarkEntryId?: string;
}

export interface NodeInfo {
  topRatio: number;
  targetTurn: TurnInfo;
  index: number;
}

export function getUserPreview(message: UserMessage): string {
  if (typeof message.content === "string") return stripDimensionNotes(message.content).trim();
  if (Array.isArray(message.content)) {
    const text = stripDimensionNotes(
      message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n")
    ).trim();
    if (text) return text;
    const hasImage = message.content.some((block) => block.type === "image");
    if (hasImage) return "[图片]";
  }
  return "";
}

/** Assign 1-based serial numbers strictly to loaded user turns.
 *  Reads window.__PI_ENH_GET_HISTORY_STATE__() safely (SSR-guarded) to resolve total turns. */
export function computeUserTurnNumbers(
  turns: TurnInfo[],
  historyTotalTurns?: number | null,
): void {
  const loadedUserCount = turns.length;
  let totalTurns = loadedUserCount;
  if (
    typeof historyTotalTurns === "number" &&
    Number.isFinite(historyTotalTurns) &&
    historyTotalTurns >= loadedUserCount
  ) {
    totalTurns = historyTotalTurns;
  } else if (typeof window !== "undefined") {
    try {
      const history = (window as any).__PI_ENH_GET_HISTORY_STATE__?.();
      if (
        history &&
        typeof history.totalTurns === "number" &&
        Number.isFinite(history.totalTurns) &&
        history.totalTurns >= loadedUserCount
      ) {
        totalTurns = history.totalTurns;
      }
    } catch {}
  }

  const userOffset = Math.max(0, totalTurns - loadedUserCount);
  for (let i = 0; i < turns.length; i++) {
    turns[i].userTurnNumber = userOffset + i + 1;
  }
}

export function createTurnNodes(turns: TurnInfo[]): NodeInfo[] {
  return turns.map((turn, index) => ({
    topRatio: 0,
    targetTurn: turn,
    index,
  }));
}

export interface NodeLayout {
  nodes: NodeInfo[];
  gap: number;
  fillsHeight: boolean;
}

export function layoutNodes(allNodes: NodeInfo[], minimapHeight: number): NodeLayout {
  if (allNodes.length === 0) {
    return { nodes: [], gap: MAX_NODE_GAP, fillsHeight: false };
  }

  const height = Math.max(1, minimapHeight);
  const usableHeight = Math.max(0, height - MINIMAP_PADDING * 2);
  if (allNodes.length === 1) {
    return {
      nodes: [{ ...allNodes[0], topRatio: MINIMAP_PADDING / height }],
      gap: MAX_NODE_GAP,
      fillsHeight: false,
    };
  }

  const naturalGap = usableHeight / (allNodes.length - 1);
  const gap = Math.min(MAX_NODE_GAP, naturalGap);
  return {
    nodes: allNodes.map((node, index) => ({
      ...node,
      topRatio: (MINIMAP_PADDING + index * gap) / height,
    })),
    gap,
    fillsHeight: naturalGap <= MAX_NODE_GAP,
  };
}

export function getMinimapHistorySettings(): { initialTurns: number; stepTurns: number } {
  if (typeof window !== "undefined") {
    try {
      const fn = (window as any).__PI_ENH_GET_MINIMAP_HISTORY_SETTINGS__;
      if (typeof fn === "function") {
        const s = fn();
        return {
          initialTurns: Math.max(5, Math.min(50, Math.floor(Number(s?.initialTurns) || 5))),
          stepTurns: Math.max(1, Number(s?.stepTurns) || 5),
        };
      }
    } catch {}
  }
  return { initialTurns: 5, stepTurns: 5 };
}

export function readMinimapHistoryState(loadedCount: number): {
  sessionId: string;
  totalTurns: number;
  hasEarlierMessages: boolean;
  oldestEntryId?: string | null;
} {
  let nativeState: any = null;
  if (typeof window !== "undefined") {
    try {
      const fn = (window as any).__PI_ENH_GET_HISTORY_STATE__;
      if (typeof fn === "function") nativeState = fn();
    } catch {}
  }
  const currentSessionId = nativeState?.sessionId || "current";
  const nativeTotal = Number(nativeState?.totalTurns);
  const totalTurns = Number.isFinite(nativeTotal) && nativeTotal > 0
    ? Math.max(loadedCount, Math.floor(nativeTotal))
    : loadedCount;
  return {
    sessionId: currentSessionId,
    totalTurns,
    hasEarlierMessages: Boolean(nativeState?.hasEarlierMessages),
    oldestEntryId: nativeState?.oldestEntryId || null,
  };
}

function waitForCommitFrames(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve();
        });
      });
    } else {
      setTimeout(resolve, 32);
    }
  });
}

export function ChatMinimap({
  overlay = false,
  onClose,
  sessionId,
  messages,
  streamingMessage,
  scrollContainer,
  messageRefs,
  onRevealHistory,
}: Props) {
  const { bookmarks, toggle: toggleBookmark } = useMinimapBookmarks(sessionId);
  const currentSessionIdRef = useRef<string | null>(null);
  const sessionGenerationRef = useRef(0);
  const closedByUserRef = useRef(false);
  const lastPointerTypeRef = useRef("mouse");
  const justSwipedRef = useRef(false);
  const gestureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorGuardRef = useRef<{ entryId: string; topBefore: number } | null>(null);

  const [visible, setVisible] = useState(false);
  const [allNodes, setAllNodes] = useState<NodeInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [minimapHeight, setMinimapHeight] = useState(600);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [mouseYRatio, setMouseYRatio] = useState<number | null>(null);
  const [targetTurns, setTargetTurns] = useState<number>(() => getMinimapHistorySettings().initialTurns);
  useEffect(() => {
    const syncPreferences = () => setTargetTurns(getMinimapHistorySettings().initialTurns);
    window.addEventListener("pi:minimap-preferences-change", syncPreferences);
    return () => window.removeEventListener("pi:minimap-preferences-change", syncPreferences);
  }, []);
  const targetTurnsRef = useRef(targetTurns);
  targetTurnsRef.current = targetTurns;
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const isLoadingEarlierRef = useRef(false);
  const initialLoadAttemptRef = useRef<string | null>(null);
  const [loadError, setLoadError] = useState(false);

  const historyState = readMinimapHistoryState(allNodes.length);
  if (sessionId !== currentSessionIdRef.current) {
    currentSessionIdRef.current = sessionId;
    sessionGenerationRef.current++;
    closedByUserRef.current = false;
    isLoadingEarlierRef.current = false;
    initialLoadAttemptRef.current = null;
    const initial = getMinimapHistorySettings().initialTurns;
    targetTurnsRef.current = initial;
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const allNodesRef = useRef<NodeInfo[]>([]);
  const nodeLayoutRef = useRef<NodeLayout>({
    nodes: [],
    gap: MAX_NODE_GAP,
    fillsHeight: false,
  });
  const previewBoxRef = useRef<HTMLDivElement>(null);

  // 原生实现手机竖屏导航面板右滑关闭，条目按钮支持手势且抑制 ghost click
  useMobileHorizontalSwipe({
    containerRef: previewBoxRef,
    direction: "right",
    enabled: Boolean(overlay),
    threshold: 40,
    dominantRatio: 1.3,
    allowOnButtons: true,
    onSwipe: () => {
      onClose?.();
    },
  });
  const previewItemRefs = useRef(new Map<number, HTMLDivElement>());
  const previewHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodeLockRef = useRef<{ index: number; until: number } | null>(null);
  const lockedUserMessageRef = useRef<UserMessage | null>(null);
  const pointerDownStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    startActiveIndex: number | null;
    startNode: NodeInfo | null;
    wasPreviewOpen: boolean;
    hasMoved: boolean;
  } | null>(null);
  const pendingNavigationNodeIndexRef = useRef<number | null>(null);

  const allMessages = useMemo(
    () => (streamingMessage ? [...messages, streamingMessage] : messages) as (AgentMessage | Partial<AgentMessage>)[],
    [messages, streamingMessage],
  );
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;
  useEffect(() => {
    setTargetTurns(getMinimapHistorySettings().initialTurns);
    setIsLoadingEarlier(false);
    setLoadError(false);
  }, [sessionId]);

  const nodeLayout = useMemo(
    () => layoutNodes(allNodes, minimapHeight),
    [allNodes, minimapHeight],
  );
  const { nodes: positionedNodes, gap: nodeGap } = nodeLayout;
  nodeLayoutRef.current = nodeLayout;

  const lockActiveNode = useCallback((index: number) => {
    const targetNode = allNodesRef.current.find((n) => n.index === index);
    if (targetNode) {
      lockedUserMessageRef.current = targetNode.targetTurn.userMessage;
    }
    activeNodeLockRef.current = {
      index,
      until: Date.now() + NAVIGATION_ACTIVE_LOCK_MS,
    };
    setActiveIndex(index);
  }, []);

  const syncActiveNode = useCallback((scrollEl: HTMLDivElement, nextNodes: NodeInfo[]) => {
    const activeLock = activeNodeLockRef.current;
    if (activeLock && Date.now() < activeLock.until) {
      setActiveIndex(activeLock.index);
      return;
    }
    activeNodeLockRef.current = null;
    lockedUserMessageRef.current = null;

    const measuredNodes = nextNodes.filter((node) => node.targetTurn.scrollTop !== null);
    if (measuredNodes.length === 0) {
      setActiveIndex(null);
      return;
    }
    const focusTop = scrollEl.scrollTop + scrollEl.clientHeight * 0.3;
    const nextActiveNode = measuredNodes.reduce((bestNode, node) => (
      Math.abs((node.targetTurn.scrollTop ?? 0) - focusTop)
        < Math.abs((bestNode.targetTurn.scrollTop ?? 0) - focusTop)
        ? node
        : bestNode
    ), measuredNodes[0]);
    setActiveIndex(nextActiveNode.index);
  }, []);

  const updateScroll = useCallback(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const scrollable = scrollEl.scrollHeight - scrollEl.clientHeight;
    const currentNodes = allNodesRef.current;
    setVisible(overlay || scrollable > 20);
    syncActiveNode(scrollEl, currentNodes);
  }, [overlay, scrollContainer, syncActiveNode]);

  const measureThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureNodes = useCallback(() => {
    if (measureThrottleRef.current) return;
    measureThrottleRef.current = setTimeout(() => {
      measureThrottleRef.current = null;
      const scrollEl = scrollContainer.current;
      const minimapEl = containerRef.current;
      if (!scrollEl || !minimapEl) return;

      const refs = messageRefs.current;
      const containerRect = scrollEl.getBoundingClientRect();
      const turns: TurnInfo[] = [];
      let refIndex = 0;

      for (const message of allMessagesRef.current) {
        const isAnchor = isMessageGroupAnchor(message);
        if (!isAnchor && message.role !== "assistant") continue;
        const element = refs?.[refIndex];
        refIndex++;

        // Only genuine user messages become minimap navigation nodes
        if (message.role === "user") {
          const elementRect = element?.getBoundingClientRect();
          const bookmarkEntryId = element?.getAttribute("data-entry-id") ||
            (message as any).entryId ||
            (message as any).id || undefined;
          const entryId = bookmarkEntryId || `user-${refIndex}`;
          turns.push({
            userTurnNumber: 0,
            userMessage: message as UserMessage,
            element,
            entryId,
            bookmarkEntryId,
            scrollTop: elementRect && elementRect.height > 0 && element?.getClientRects().length
              ? elementRect.top - containerRect.top + scrollEl.scrollTop
              : null,
          });
        }
      }

      // 锚点保护基准记录：记录当前 preview 视口内第一张卡片的稳定 entryId 与屏幕 top
      const box = previewBoxRef.current;
      if (box) {
        const boxRect = box.getBoundingClientRect();
        const cards = Array.from(box.querySelectorAll<HTMLElement>('[data-minimap-preview-index]'))
          .filter((el) => el.style.display !== "none");
        for (const el of cards) {
          const rect = el.getBoundingClientRect();
          if (rect.bottom > boxRect.top && rect.top < boxRect.bottom) {
            const entryId = el.getAttribute("data-minimap-preview-entry-id");
            if (entryId) {
              anchorGuardRef.current = { entryId, topBefore: rect.top };
              break;
            }
          }
        }
      }

      computeUserTurnNumbers(turns);

      const nextNodes = createTurnNodes(turns);
      setMinimapHeight(minimapEl.clientHeight);
      allNodesRef.current = nextNodes;
      setAllNodes(nextNodes);
      setVisible(overlay || scrollEl.scrollHeight - scrollEl.clientHeight > 20);

      // Stable entry identity or message reference lock to preserve position across prepends
      const now = Date.now();
      const isLockActive = (pointerDownStateRef.current !== null) ||
        (activeNodeLockRef.current !== null && now < activeNodeLockRef.current.until);

      let restoredIndex: number | null = null;
      if (isLockActive && lockedUserMessageRef.current) {
        const matched = nextNodes.find((n) => n.targetTurn.userMessage === lockedUserMessageRef.current);
        if (matched) {
          restoredIndex = matched.index;
          if (activeNodeLockRef.current) {
            activeNodeLockRef.current.index = matched.index;
          }
          setActiveIndex(matched.index);
        }
      } else {
        // 锁期已过或不在拖动中，必须期满清理，恢复手滚正常同步
        lockedUserMessageRef.current = null;
        activeNodeLockRef.current = null;
      }

      if (restoredIndex === null) {
        syncActiveNode(scrollEl, nextNodes);
      }

      const pendingNodeIndex = pendingNavigationNodeIndexRef.current;
      const pendingNode = pendingNodeIndex !== null ? nextNodes[pendingNodeIndex] : null;
      if (pendingNode && pendingNode.targetTurn.scrollTop !== null) {
        pendingNavigationNodeIndexRef.current = null;
        lockActiveNode(pendingNode.index);
        const targetOffset = scrollEl.clientHeight * 0.3;
        scrollEl.scrollTo({
          top: Math.max(0, pendingNode.targetTurn.scrollTop - targetOffset),
          behavior: "smooth",
        });
        if (overlay) onClose?.();
      }
    }, overlay ? 0 : 150);
  }, [overlay, onClose, lockActiveNode, messageRefs, scrollContainer, syncActiveNode]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const releaseSelection = () => {
      activeNodeLockRef.current = null;
      lockedUserMessageRef.current = null;
      setMouseYRatio(null);
    };
    const releaseForKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) releaseSelection();
    };
    el.addEventListener("scroll", updateScroll, { passive: true });
    el.addEventListener("wheel", releaseSelection, { passive: true });
    el.addEventListener("pointerdown", releaseSelection, { passive: true });
    el.addEventListener("keydown", releaseForKey);
    return () => {
      el.removeEventListener("scroll", updateScroll);
      el.removeEventListener("wheel", releaseSelection);
      el.removeEventListener("pointerdown", releaseSelection);
      el.removeEventListener("keydown", releaseForKey);
    };
  }, [scrollContainer, updateScroll]);

  useEffect(() => {
    const el = scrollContainer.current;
    if (!el) return;
    const syncLayout = () => {
      measureNodes();
      updateScroll();
    };
    const ro = new ResizeObserver(syncLayout);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    syncLayout();
    return () => {
      ro.disconnect();
      if (measureThrottleRef.current) {
        clearTimeout(measureThrottleRef.current);
        measureThrottleRef.current = null;
      }
    };
  }, [measureNodes, scrollContainer, updateScroll]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      measureNodes();
      updateScroll();
    }, 50);
    return () => clearTimeout(timeout);
  }, [messages.length, measureNodes, updateScroll]);

  const scrollToNode = useCallback((node: NodeInfo, behavior: ScrollBehavior) => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    scrollEl.dispatchEvent(new CustomEvent("pi:minimap-navigation", { bubbles: true }));
    setMouseYRatio(null);
    lockActiveNode(node.index);
    const element = node.targetTurn.element;
    const rect = element?.isConnected ? element.getBoundingClientRect() : null;
    const liveTop = element
      ? rect && rect.height > 0 && element.getClientRects().length
        ? rect.top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
        : null
      : node.targetTurn.scrollTop;
    if (liveTop === null) {
      pendingNavigationNodeIndexRef.current = node.index;
      onRevealHistory();
      return;
    }
    const targetTop = Math.max(
      0,
      liveTop - scrollEl.clientHeight * 0.3,
    );
    scrollEl.scrollTo({ top: targetTop, behavior });
    if (overlay) onClose?.();
  }, [overlay, onClose, lockActiveNode, onRevealHistory, scrollContainer]);

  const findNearestNode = useCallback((ratio: number, clamp = false): NodeInfo | null => {
    const { nodes, gap, fillsHeight } = nodeLayoutRef.current;
    const height = containerRef.current?.clientHeight ?? 0;
    if (nodes.length === 0 || height <= 0) return null;

    const pointerY = Math.max(0, Math.min(height, ratio * height));
    const firstNodeY = nodes[0].topRatio * height;
    const rawIndex = gap > 0 ? Math.round((pointerY - firstNodeY) / gap) : 0;
    const nodeIndex = Math.max(0, Math.min(nodes.length - 1, rawIndex));
    const nearestNode = nodes[nodeIndex];

    if (!fillsHeight && !clamp) {
      const nodeY = nearestNode.topRatio * height;
      const hitRadius = Math.max(24, gap);
      if (Math.abs(pointerY - nodeY) > hitRadius) return null;
    }
    return nearestNode;
  }, []);

  const cancelPreviewHide = useCallback(() => {
    if (!previewHideTimerRef.current) return;
    clearTimeout(previewHideTimerRef.current);
    previewHideTimerRef.current = null;
  }, []);

  const showPreview = useCallback((event?: React.MouseEvent<HTMLDivElement>) => {
    if (event && (lastPointerTypeRef.current !== "mouse" || (event.nativeEvent as any)?.sourceCapabilities?.firesTouchEvents)) return;
    if (closedByUserRef.current) return;
    if (gestureTimerRef.current) {
      clearTimeout(gestureTimerRef.current);
      gestureTimerRef.current = null;
    }
    if (previewBoxRef.current) {
      previewBoxRef.current.style.transform = "";
      previewBoxRef.current.style.opacity = "";
      previewBoxRef.current.style.transition = "";
    }
    cancelPreviewHide();
    setMinimapHovered(true);
  }, [cancelPreviewHide]);

  const schedulePreviewHide = useCallback(() => {
    if (pointerDownStateRef.current) return;
    cancelPreviewHide();
    previewHideTimerRef.current = setTimeout(() => {
      previewHideTimerRef.current = null;
      setMinimapHovered(false);
      setMouseYRatio(null);
    }, PREVIEW_HIDE_DELAY);
  }, [cancelPreviewHide]);

  const handleMouseLeave = useCallback((event?: React.MouseEvent<HTMLDivElement>) => {
    // Touch generates compatibility mouse events after release; it must not hide a just-opened drawer.
    if (lastPointerTypeRef.current !== "mouse" || (event?.nativeEvent as any)?.sourceCapabilities?.firesTouchEvents) return;
    schedulePreviewHide();
    closedByUserRef.current = false;
  }, [schedulePreviewHide]);

  const preservePreviewScroll = useCallback(() => {
    const box = previewBoxRef.current;
    if (!box) return;
    const boxRect = box.getBoundingClientRect();
    const cards = Array.from(box.querySelectorAll<HTMLElement>('[data-minimap-preview-index]'))
      .filter((el) => el.style.display !== "none");
    for (const el of cards) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom > boxRect.top && rect.top < boxRect.bottom) {
        const entryId = el.getAttribute("data-minimap-preview-entry-id");
        if (entryId) {
          anchorGuardRef.current = { entryId, topBefore: rect.top };
          break;
        }
      }
    }
  }, []);

  useLayoutEffect(() => {
    const guard = anchorGuardRef.current;
    if (!guard) return;
    anchorGuardRef.current = null;
    const box = previewBoxRef.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>(`[data-minimap-preview-entry-id="${guard.entryId}"]`);
    if (!el || el.style.display === "none") return;
    const topAfter = el.getBoundingClientRect().top;
    const diff = topAfter - guard.topBefore;
    if (Math.abs(diff) >= 0.5) {
      box.scrollTop += diff;
    }
  });

  const runContinuousLoad = useCallback((desiredTargetTurns: number, source: string) => {
    if (isLoadingEarlierRef.current) return false;

    const loader = typeof window !== "undefined" ? (window as any).__PI_ENH_LOAD_EARLIER__ : null;
    if (typeof loader !== "function") return false;

    preservePreviewScroll();
    isLoadingEarlierRef.current = true;
    setIsLoadingEarlier(true);
    setLoadError(false);

    const generation = sessionGenerationRef.current;

    (async () => {
      let pageCount = 0;
      let consecutiveNoUser = 0;

      try {
        while (true) {
          if (sessionGenerationRef.current !== generation) return;

          const loadedUserCount = allMessagesRef.current.filter((message) => message.role === "user").length;
          const history = readMinimapHistoryState(loadedUserCount);

          // 1. 已达到目标用户数或服务端无更早消息，成功停止
          if (loadedUserCount >= desiredTargetTurns || !history.hasEarlierMessages) {
            break;
          }

          // 2. 熔断保护：单次交互最多 30 页，连续无新增 user 最多 10 页
          if (pageCount >= 30 || consecutiveNoUser >= 10) {
            setLoadError(true);
            break;
          }

          // Navigation pages are source messages, not turns. A larger bounded
          // page avoids serial requests through a long tool execution.
          const fetchTail = 100;

          // 记录本轮请求前消息状态与 cursor/entryId
          const messagesBefore = allMessagesRef.current;
          const msgCountBefore = messagesBefore.length;
          const oldestEntryIdBefore = history.oldestEntryId || (messagesBefore[0] as any)?.entryId || null;

          pageCount++;
          let res: any;
          try {
            res = await loader(fetchTail, source);
          } catch (e) {
            if (sessionGenerationRef.current !== generation) return;
            setLoadError(true);
            break;
          }

          if (sessionGenerationRef.current !== generation) return;
          if (res === false) {
            setLoadError(true);
            break;
          }

          // 4. 等待两帧，确保 React commit 并更新 DOM/refs
          await waitForCommitFrames();
          if (sessionGenerationRef.current !== generation) return;

          // 5. 检查进展
          const nextLoadedUserCount = allMessagesRef.current.filter((message) => message.role === "user").length;
          const nextHistory = readMinimapHistoryState(nextLoadedUserCount);
          const messagesAfter = allMessagesRef.current;
          const msgCountAfter = messagesAfter.length;
          const oldestEntryIdAfter = nextHistory.oldestEntryId || (messagesAfter[0] as any)?.entryId || null;

          const userProgress = nextLoadedUserCount > loadedUserCount;
          if (userProgress) {
            consecutiveNoUser = 0;
          } else {
            consecutiveNoUser++;
          }

          const cursorProgress = msgCountAfter > msgCountBefore ||
            oldestEntryIdAfter !== oldestEntryIdBefore;

          // 若既无 user 进展，也无 cursor/消息集合进展，判定为无进展错误，停止重试
          if (!userProgress && !cursorProgress) {
            setLoadError(true);
            break;
          }

          if (!nextHistory.hasEarlierMessages) {
            break;
          }
        }
      } finally {
        if (sessionGenerationRef.current === generation) {
          isLoadingEarlierRef.current = false;
          setIsLoadingEarlier(false);
        }
      }
    })();

    return true;
  }, [preservePreviewScroll]);

  const triggerLoadEarlier = useCallback((source = "button") => {
    if (isLoadingEarlierRef.current) return false;
    const loadedCount = allNodesRef.current.length;
    const history = readMinimapHistoryState(loadedCount);
    const settings = getMinimapHistorySettings();

    // 1. 优先本地展开未显示的已加载轮次
    const currentTarget = targetTurnsRef.current;
    if (currentTarget < loadedCount) {
      preservePreviewScroll();
      const nextTarget = Math.min(loadedCount, currentTarget + settings.stepTurns);
      targetTurnsRef.current = nextTarget;
      setTargetTurns(nextTarget);
      setLoadError(false);
      return true;
    }

    // 2. 本地已完全展开，请求服务端更早消息
    if (!history.hasEarlierMessages && !loadError) {
      return false;
    }

    // 若当前处于错误状态，用户主动重试
    setLoadError(false);

    // 一次触发目标只加一次 step 5
    const nextTarget = loadError ? currentTarget : currentTarget + settings.stepTurns;
    targetTurnsRef.current = nextTarget;
    setTargetTurns(nextTarget);

    return runContinuousLoad(nextTarget, source);
  }, [loadError, preservePreviewScroll, runContinuousLoad]);

  const expandAllLoadedTurns = useCallback(() => {
    const loadedCount = allNodesRef.current.length;
    if (loadedCount <= 0 || targetTurnsRef.current >= loadedCount) return;
    preservePreviewScroll();
    targetTurnsRef.current = loadedCount;
    setTargetTurns(loadedCount);
  }, [preservePreviewScroll]);

  useEffect(() => {
    const initial = getMinimapHistorySettings().initialTurns;
    if (targetTurnsRef.current < initial) {
      targetTurnsRef.current = initial;
      setTargetTurns(initial);
    }
    const loadedCount = allMessagesRef.current.filter(message => message.role === "user").length;
    const history = readMinimapHistoryState(loadedCount);
    // ChatWindow installs the authoritative bridge before this passive effect.
    // A closed mobile navigator is unmounted, so it does no background work.
    if (!sessionId || history.sessionId !== sessionId || !history.hasEarlierMessages || loadedCount >= initial) return;
    const attemptKey = `${sessionGenerationRef.current}:${initial}`;
    if (initialLoadAttemptRef.current === attemptKey) return;
    if (runContinuousLoad(initial, "initial")) {
      // Network/budget failures require an explicit retry, never an effect loop.
      initialLoadAttemptRef.current = attemptKey;
    }
  }, [allNodes.length, messages.length, runContinuousLoad, sessionId, targetTurns]);

  useEffect(() => {
    return () => {
      sessionGenerationRef.current++;
      isLoadingEarlierRef.current = false;
      cancelPreviewHide();
      if (gestureTimerRef.current) {
        clearTimeout(gestureTimerRef.current);
        gestureTimerRef.current = null;
      }
      if (suppressClickTimerRef.current) {
        clearTimeout(suppressClickTimerRef.current);
        suppressClickTimerRef.current = null;
      }
    };
  }, [cancelPreviewHide]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__PI_ENH_CLOSE_MINIMAP__ = (animate?: boolean) => {
      cancelPreviewHide();
      closedByUserRef.current = true;
      if (animate && previewBoxRef.current) {
        const box = previewBoxRef.current;
        box.style.transition = "transform 0.16s ease-out, opacity 0.16s ease-out";
        box.style.transform = "translateX(100%)";
        box.style.opacity = "0";
        if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
        gestureTimerRef.current = setTimeout(() => {
          gestureTimerRef.current = null;
          setMinimapHovered(false);
          setMouseYRatio(null);
          if (box) {
            box.style.transform = "";
            box.style.opacity = "";
            box.style.transition = "";
          }
        }, 160);
      } else {
        setMinimapHovered(false);
        setMouseYRatio(null);
      }
    };
    (window as any).__PI_ENH_OPEN_MINIMAP__ = (ratio?: number) => {
      if (gestureTimerRef.current) {
        clearTimeout(gestureTimerRef.current);
        gestureTimerRef.current = null;
      }
      if (previewBoxRef.current) {
        previewBoxRef.current.style.transform = "";
        previewBoxRef.current.style.opacity = "";
        previewBoxRef.current.style.transition = "";
      }
      closedByUserRef.current = false;
      cancelPreviewHide();
      setMinimapHovered(true);
      if (typeof ratio === "number") {
        setMouseYRatio(Math.max(0, Math.min(1, ratio)));
      }
    };
    (window as any).__PI_ENH_IS_MINIMAP_OPEN__ = () => Boolean(minimapHovered);
    return () => {
      delete (window as any).__PI_ENH_CLOSE_MINIMAP__;
      delete (window as any).__PI_ENH_OPEN_MINIMAP__;
      delete (window as any).__PI_ENH_IS_MINIMAP_OPEN__;
    };
  }, [cancelPreviewHide, minimapHovered]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    lastPointerTypeRef.current = event.pointerType || "mouse";
    if (!visible) return;
    if (!event.isPrimary || (typeof event.button === "number" && event.button !== 0)) return;
    if (pointerDownStateRef.current !== null) return;
    if ((event.target as HTMLElement)?.closest?.('[data-minimap-preview-box], [data-pi-enh-minimap-toolbar]')) {
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.height <= 0) return;

    const pointerId = event.pointerId;
    const clientY = event.clientY;
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const node = findNearestNode(ratio, true);

    const wasPreviewOpen = minimapHovered;
    pointerDownStateRef.current = {
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: Date.now(),
      startActiveIndex: activeIndex,
      startNode: node,
      wasPreviewOpen,
      hasMoved: false,
    };

    try {
      event.currentTarget.setPointerCapture(pointerId);
    } catch {}

    setMouseYRatio(ratio);
    if (node) {
      setActiveIndex(node.index);
      lockActiveNode(node.index);
    }
  }, [activeIndex, findNearestNode, lockActiveNode, minimapHovered, visible]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!(event.nativeEvent as any)?.sourceCapabilities?.firesTouchEvents) {
      lastPointerTypeRef.current = event.pointerType || "mouse";
    }
    if ((event.target as HTMLElement)?.closest?.('[data-minimap-preview-box], [data-pi-enh-minimap-toolbar]')) {
      return;
    }
    const downState = pointerDownStateRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;

    const clientY = event.clientY;
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

    if (downState && downState.pointerId === event.pointerId) {
      const dy = Math.abs(event.clientY - downState.startY);
      const dx = Math.abs(event.clientX - downState.startX);
      if (dy > 3 || dx > 3) {
        downState.hasMoved = true;
        if (!minimapHovered) {
          closedByUserRef.current = false;
          cancelPreviewHide();
          setMinimapHovered(true);
        }
      }
      setMouseYRatio(ratio);
      const node = findNearestNode(ratio, true);
      if (node) {
        setActiveIndex(node.index);
        lockActiveNode(node.index);
      }
      return;
    }

    // Pure mouse hover when not dragging
    if (event.buttons === 0 && minimapHovered) {
      setMouseYRatio(ratio);
    }
  }, [cancelPreviewHide, findNearestNode, lockActiveNode, minimapHovered]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const downState = pointerDownStateRef.current;
    if (!downState || downState.pointerId !== event.pointerId) return;

    pointerDownStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}

    const rect = containerRef.current?.getBoundingClientRect();
    const ratio = rect && rect.height > 0
      ? Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
      : null;
    if (ratio !== null) {
      setMouseYRatio(ratio);
    }
    const currentNode = ratio !== null ? findNearestNode(ratio, true) : null;
    const finalNode = currentNode || downState.startNode;

    if (!downState.hasMoved) {
      // Tap (movement <= 3px)
      if (downState.wasPreviewOpen) {
        if (
          downState.startActiveIndex !== null &&
          finalNode &&
          downState.startActiveIndex === finalNode.index
        ) {
          cancelPreviewHide();
          setMinimapHovered(false);
          setMouseYRatio(null);
          closedByUserRef.current = true;
          return;
        }
        if (finalNode) {
          closedByUserRef.current = false;
          setActiveIndex(finalNode.index);
          lockActiveNode(finalNode.index);
          scrollToNode(finalNode, "smooth");
        }
        return;
      }

      if (
        downState.startActiveIndex !== null &&
        finalNode &&
        downState.startActiveIndex === finalNode.index
      ) {
        closedByUserRef.current = false;
        cancelPreviewHide();
        setMinimapHovered(true);
        return;
      }

      if (finalNode) {
        closedByUserRef.current = false;
        cancelPreviewHide();
        setMinimapHovered(true);
        setActiveIndex(finalNode.index);
        lockActiveNode(finalNode.index);
        scrollToNode(finalNode, "smooth");
      }
      return;
    }

    if (finalNode) {
      closedByUserRef.current = false;
      cancelPreviewHide();
      setMinimapHovered(true);
      setActiveIndex(finalNode.index);
      lockActiveNode(finalNode.index);
      scrollToNode(finalNode, "smooth");
    }
  }, [cancelPreviewHide, findNearestNode, lockActiveNode, scrollToNode]);

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const downState = pointerDownStateRef.current;
    if (!downState || downState.pointerId !== event.pointerId) return;

    pointerDownStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}

    setMouseYRatio(null);
    setActiveIndex(downState.startActiveIndex);
    if (!downState.wasPreviewOpen) {
      setMinimapHovered(false);
    }
    if (downState.startActiveIndex === null) {
      activeNodeLockRef.current = null;
      lockedUserMessageRef.current = null;
    } else {
      const startNode = positionedNodes.find((n) => n.index === downState.startActiveIndex);
      if (startNode) {
        lockActiveNode(startNode.index);
      }
    }
  }, [lockActiveNode, positionedNodes]);

  const nearestNode = useMemo(() => {
    if (mouseYRatio !== null) {
      const node = findNearestNode(mouseYRatio, true);
      if (node) return node;
    }
    if (activeIndex !== null) {
      return positionedNodes.find((n) => n.index === activeIndex) ?? null;
    }
    return null;
  }, [activeIndex, findNearestNode, mouseYRatio, positionedNodes]);
  const nearestNodeIndex = nearestNode?.index ?? null;

  useEffect(() => {
    // 只有用户在 rail 上主动悬停或拖拽至被隐藏节点时才按需展开
    if (mouseYRatio === null) return;
    const node = findNearestNode(mouseYRatio, true);
    if (!node) return;
    const loadedCount = allNodes.length;
    const currentTarget = targetTurnsRef.current;
    const hiddenCount = Math.max(0, loadedCount - currentTarget);
    if (node.index < hiddenCount) {
      const needed = loadedCount - node.index;
      preservePreviewScroll();
      targetTurnsRef.current = Math.max(currentTarget, needed);
      setTargetTurns(targetTurnsRef.current);
    }
  }, [allNodes.length, findNearestNode, mouseYRatio, preservePreviewScroll]);

  const lastCenteredEntryRef = useRef<string | null>(null);

  useEffect(() => {
    if (!minimapHovered || nearestNodeIndex === null) {
      lastCenteredEntryRef.current = null;
      return;
    }
    // Prepending changes array indices, not the user's reading target.
    const entryId = allNodesRef.current[nearestNodeIndex]?.targetTurn.entryId ?? null;
    if (entryId && lastCenteredEntryRef.current === entryId) return;
    lastCenteredEntryRef.current = entryId;

    const previewBox = previewBoxRef.current;
    const previewItem = previewItemRefs.current.get(nearestNodeIndex);
    if (!previewBox || !previewItem) return;
    const targetTop = previewItem.offsetTop
      - (previewBox.clientHeight - previewItem.offsetHeight) / 2;
    previewBox.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
  }, [minimapHovered, nearestNodeIndex]);

  useEffect(() => {
    // Mobile overlays use native scrolling; desktop wheel/swipe history gestures
    // must not load older pages or interfere with Android navigation.
    if (overlay) return;
    const previewBox = previewBoxRef.current;
    if (!previewBox) return;

    if (gestureTimerRef.current) {
      clearTimeout(gestureTimerRef.current);
      gestureTimerRef.current = null;
    }
    previewBox.style.transform = "";
    previewBox.style.opacity = "";
    previewBox.style.transition = "";

    const handleWheel = (e: WheelEvent) => {
      if (previewBox.scrollTop <= 1 && e.deltaY < 0) {
        if (triggerLoadEarlier("wheel")) {
          e.preventDefault();
        }
      }
    };
    previewBox.addEventListener("wheel", handleWheel, { passive: false });

    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartTime = 0;
    let gestureIntent: null | "scroll" | "swipe-right" = null;
    let currentTranslateX = 0;
    let isAtTop = false;

    const resetSwipe = (animate = false) => {
      touchStartX = 0;
      touchStartY = 0;
      touchStartTime = 0;
      gestureIntent = null;
      currentTranslateX = 0;
      isAtTop = false;
      if (previewBox) {
        if (animate) previewBox.style.transition = "transform 0.18s ease-out";
        previewBox.style.transform = "";
        if (animate) {
          if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
          gestureTimerRef.current = setTimeout(() => {
            gestureTimerRef.current = null;
            if (previewBox) previewBox.style.transition = "";
          }, 180);
        }
      }
    };

    const handleTouchStart = (e: TouchEvent) => {
      const touch = e.touches?.[0];
      if (!touch) return;
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchStartTime = Date.now();
      gestureIntent = null;
      currentTranslateX = 0;
      justSwipedRef.current = false;
      if (suppressClickTimerRef.current) {
        clearTimeout(suppressClickTimerRef.current);
        suppressClickTimerRef.current = null;
      }
      isAtTop = previewBox.scrollTop <= 1;
    };

    const handleTouchMove = (e: TouchEvent) => {
      const touch = e.touches?.[0];
      if (!touch) return;
      const dx = touch.clientX - touchStartX;
      const dy = touch.clientY - touchStartY;

      if (!gestureIntent) {
        if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) {
          gestureIntent = "scroll";
          justSwipedRef.current = true;
        } else if (dx > 10 && dx > Math.abs(dy) * 1.1) {
          gestureIntent = "swipe-right";
          justSwipedRef.current = true;
        }
      }

      if (gestureIntent === "scroll" || !gestureIntent) {
        if (isAtTop && dy >= 32) {
          isAtTop = false;
          justSwipedRef.current = true;
          if (triggerLoadEarlier("touch") && e.cancelable) {
            e.preventDefault();
          }
        }
        return;
      }

      if (gestureIntent === "swipe-right") {
        if (dx > 0) {
          if (e.cancelable) e.preventDefault();
          currentTranslateX = dx;
          previewBox.style.transition = "none";
          previewBox.style.transform = `translateX(${dx}px)`;
        } else {
          currentTranslateX = 0;
          previewBox.style.transform = "";
        }
      }
    };

    const handleTouchEnd = () => {
      if (gestureIntent === null) {
        resetSwipe(false);
        return; // A normal tap must reach the user's native button onClick.
      }
      if (gestureIntent === "swipe-right" && currentTranslateX > 0) {
        const elapsed = Math.max(1, Date.now() - touchStartTime);
        const vx = currentTranslateX / elapsed;
        const shouldClose = currentTranslateX >= 48 || (currentTranslateX >= 24 && vx > 0.25);
        if (shouldClose) {
          closedByUserRef.current = true; // Hover during the exit animation must not cancel the user's close.
          justSwipedRef.current = true;
          previewBox.style.transition = "transform 0.16s ease-out, opacity 0.16s ease-out";
          previewBox.style.transform = "translateX(100%)";
          previewBox.style.opacity = "0";
          if (gestureTimerRef.current) clearTimeout(gestureTimerRef.current);
          gestureTimerRef.current = setTimeout(() => {
            gestureTimerRef.current = null;
            closedByUserRef.current = true;
            cancelPreviewHide();
            setMinimapHovered(false);
            setMouseYRatio(null);
            resetSwipe(false);
            if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current);
            suppressClickTimerRef.current = setTimeout(() => {
              suppressClickTimerRef.current = null;
              justSwipedRef.current = false;
            }, 100);
          }, 160);
          return;
        }
      }

      justSwipedRef.current = true;
      resetSwipe(true);
      if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = setTimeout(() => {
        suppressClickTimerRef.current = null;
        justSwipedRef.current = false;
      }, 200);
    };

    const handleTouchCancel = () => {
      justSwipedRef.current = true;
      resetSwipe(true);
      if (suppressClickTimerRef.current) clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = setTimeout(() => {
        suppressClickTimerRef.current = null;
        justSwipedRef.current = false;
      }, 200);
    };

    previewBox.addEventListener("touchstart", handleTouchStart, { passive: true });
    previewBox.addEventListener("touchmove", handleTouchMove, { passive: false });
    previewBox.addEventListener("touchend", handleTouchEnd, { passive: true });
    previewBox.addEventListener("touchcancel", handleTouchCancel, { passive: true });

    return () => {
      previewBox.removeEventListener("wheel", handleWheel);
      previewBox.removeEventListener("touchstart", handleTouchStart);
      previewBox.removeEventListener("touchmove", handleTouchMove);
      previewBox.removeEventListener("touchend", handleTouchEnd);
      previewBox.removeEventListener("touchcancel", handleTouchCancel);
      if (gestureTimerRef.current) {
        clearTimeout(gestureTimerRef.current);
        gestureTimerRef.current = null;
      }
      if (suppressClickTimerRef.current) {
        clearTimeout(suppressClickTimerRef.current);
        suppressClickTimerRef.current = null;
      }
    };
  }, [cancelPreviewHide, minimapHovered, overlay, triggerLoadEarlier, visible]);

  // 导航测量前保留固定宽度，避免消息先按全宽渲染后再次换行。
  if (!visible && !overlay) return (
    <div ref={containerRef} className="chat-desktop-minimap" data-minimap-native-owner="true" aria-hidden="true"
      style={{ width: MINIMAP_WIDTH, flexShrink: 0, visibility: "hidden" }} />
  );

  const lastNodeTop = positionedNodes.length > 0
    ? positionedNodes[positionedNodes.length - 1].topRatio * minimapHeight
    : MINIMAP_PADDING;
  const railHeight = Math.max(1, lastNodeTop - MINIMAP_PADDING);

  return (
    <div
      ref={containerRef}
      data-minimap-native-owner="true"
      className={overlay ? undefined : "chat-desktop-minimap"}
      onPointerDown={overlay ? undefined : handlePointerDown}
      onPointerMove={overlay ? undefined : handlePointerMove}
      onPointerUp={overlay ? undefined : handlePointerUp}
      onPointerCancel={overlay ? undefined : handlePointerCancel}
      onLostPointerCapture={overlay ? undefined : handlePointerCancel}
      onMouseEnter={overlay ? undefined : showPreview}
      onMouseLeave={overlay ? undefined : handleMouseLeave}
      onMouseDown={(e) => {
        // Prevent default text selection during pointer scrubbing
        if (e.button === 0) e.preventDefault();
      }}
      style={{
        width: overlay ? 0 : MINIMAP_WIDTH,
        flexShrink: 0,
        position: overlay ? "absolute" : "relative",
        ...(overlay ? { top: 0, bottom: 0, right: 0, pointerEvents: "none" as const } : {}),
        cursor: "pointer",
        userSelect: "none",
        touchAction: "pan-y",
        borderLeft: overlay ? "none" : "1px solid var(--border)",
        background: overlay ? "transparent" : "var(--bg-panel)",
        overflow: "visible",
      }}
    >
      {!overlay && <>
      {/* 实际轨道独占 child hit surface */}
      <div
        data-minimap-rail-hit="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          touchAction: "none",
          zIndex: 1,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: MINIMAP_PADDING,
          height: railHeight,
          width: 1,
          background: "var(--border)",
          transform: "translateX(-50%)",
          zIndex: 0,
        }}
      />

      {positionedNodes.map((node) => {
        const isNearest = minimapHovered && nearestNode?.index === node.index;
        const isActive = activeIndex === node.index;
        const isBookmarked = !!node.targetTurn.bookmarkEntryId && bookmarks.has(node.targetTurn.bookmarkEntryId);

        return (
          <div
            key={node.index}
            data-minimap-node-index={node.index}
            data-minimap-node-bookmarked={isBookmarked ? "true" : undefined}
            data-minimap-node-active={isActive ? "" : undefined}
            style={{
              position: "absolute",
              top: `${node.topRatio * 100}%`,
              transform: "translateY(-50%)",
              left: 0,
              right: 0,
              height: Math.max(1, nodeGap),
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              zIndex: 2,
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: isBookmarked ? "#fff" : isActive ? "var(--accent, #a4c2f4)" : "rgba(128,128,128,0.16)",
                border: `1.5px solid ${isBookmarked ? "#fff" : isActive ? "var(--accent, #a4c2f4)" : "rgba(128,128,128,0.58)"}`,
                boxShadow: isActive ? "0 0 0 2px var(--bg-panel), 0 0 8px color-mix(in srgb, var(--accent, #a4c2f4) 55%, transparent)" : "none",
                transition: "transform 0.1s, background 0.1s",
                transform: isNearest ? "scale(1.25)" : "scale(1)",
              }}
            />
          </div>
        );
      })}

      </>}
      {(overlay || (minimapHovered && allNodes.length > 0)) && (() => {
        const visibleTurnsCount = Math.min(allNodes.length, targetTurns);
        const hiddenCount = Math.max(0, allNodes.length - visibleTurnsCount);
        const totalTurnsCount = historyState.totalTurns || allNodes.length;

        let loadEarlierLabel = "加载更早轮次";
        let loadEarlierDisabled = false;
        let loadEarlierTitle = "向上滚轮或点击加载更早对话";
        let loadEarlierAriaLabel = "加载更早对话";

        if (isLoadingEarlier) {
          loadEarlierLabel = "正在加载...";
          loadEarlierDisabled = true;
          loadEarlierTitle = "正在从服务端拉取更早轮次";
          loadEarlierAriaLabel = "正在加载更早对话";
        } else if (loadError) {
          loadEarlierLabel = "加载失败，点击重试";
          loadEarlierDisabled = false;
          loadEarlierTitle = "加载历史记录失败，点击重新尝试";
          loadEarlierAriaLabel = "加载历史记录失败，点击重新尝试";
        } else if (hiddenCount > 0) {
          loadEarlierLabel = `展开更早轮次 (${hiddenCount} 轮未显示)`;
          loadEarlierDisabled = false;
          loadEarlierTitle = `展开本地未显示的 ${hiddenCount} 轮对话`;
          loadEarlierAriaLabel = `展开更早 ${hiddenCount} 轮对话`;
        } else if (!historyState.hasEarlierMessages) {
          loadEarlierLabel = "已显示全部轮次";
          loadEarlierDisabled = true;
          loadEarlierTitle = "当前会话的全部轮次已完全显示";
          loadEarlierAriaLabel = "当前会话的全部轮次已完全显示";
        }

        const activeTurn = nearestNode ?? (activeIndex !== null ? allNodes[activeIndex] : null);
        const focusLabel = activeTurn
          ? ` · 定位第 ${activeTurn.targetTurn.userTurnNumber} 轮`
          : "";

        return (
          <div
            ref={previewBoxRef}
            className={`${styles.preview}${overlay ? ` ${styles.overlayPreview}` : ""}`}
            role={overlay ? "dialog" : undefined}
            aria-label={overlay ? "会话导航" : undefined}
            data-minimap-preview-box=""
            data-minimap-native-preview=""
            onMouseEnter={showPreview}
            onMouseDown={(event) => event.stopPropagation()}
            onMouseMove={(event) => event.stopPropagation()}
          >
            <div className={styles.toolbar} data-pi-enh-minimap-toolbar="">
              <div
                className={styles.header}
                title="双击可展开当前已加载的全部轮次"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  expandAllLoadedTurns();
                }}
              >
                <span>会话导航</span>
                <span className={styles.badge}>
                  💬 共 {totalTurnsCount} 轮 · 已显示 {visibleTurnsCount} 轮{focusLabel}
                </span>
              </div>
              <button
                type="button"
                className={`${styles.loadEarlier} ${isLoadingEarlier ? styles.loading : ""}`}
                data-pi-enh-minimap-load-earlier=""
                disabled={loadEarlierDisabled}
                onClick={() => triggerLoadEarlier("button")}
                aria-label={loadEarlierAriaLabel}
                title={loadEarlierTitle}
              >
                {loadEarlierLabel}
              </button>
            </div>

            {overlay && allNodes.length === 0 && <p className={styles.emptyOverlay}>当前没有可导航的轮次</p>}
            {allNodes.map((node) => {
              const isHidden = node.index < hiddenCount;
              const isLocated = nearestNodeIndex === node.index;
              return (
                <div
                  key={node.index}
                  ref={(element) => {
                    if (element) previewItemRefs.current.set(node.index, element);
                    else previewItemRefs.current.delete(node.index);
                  }}
                  className={styles.turn}
                  style={isHidden ? { display: "none" } : undefined}
                  data-minimap-preview-index={node.index}
                  data-minimap-preview-entry-id={node.targetTurn.entryId || node.targetTurn.element?.dataset.entryId}
                  data-located={isLocated ? "true" : undefined}
                >
                  <span
                    className={styles.number}
                    data-minimap-turn-number={String(node.targetTurn.userTurnNumber)}
                  >
                    <span aria-hidden="true">
                      {String(node.targetTurn.userTurnNumber)}
                    </span>
                  </span>
                  <div className={styles.content}>
                    <button
                      type="button"
                      className={styles.user}
                      data-minimap-preview-user={node.index}
                      onClick={() => {
                        if (justSwipedRef.current) return;
                        scrollToNode(node, "smooth");
                      }}
                    >
                      <span className={styles.userText}>
                        {getUserPreview(node.targetTurn.userMessage)}
                      </span>
                    </button>
                    {sessionId && node.targetTurn.bookmarkEntryId && (
                      <button
                        type="button"
                        className={styles.bookmark}
                        data-minimap-bookmark-entry={node.targetTurn.bookmarkEntryId}
                        aria-pressed={bookmarks.has(node.targetTurn.bookmarkEntryId)}
                        aria-label={`${bookmarks.has(node.targetTurn.bookmarkEntryId) ? "取消标记" : "标记"}第 ${node.targetTurn.userTurnNumber} 轮`}
                        title={bookmarks.has(node.targetTurn.bookmarkEntryId) ? "取消书签" : "添加书签"}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleBookmark(node.targetTurn.bookmarkEntryId!);
                        }}
                      >
                        <svg width="16" height="18" viewBox="0 0 16 20" fill={bookmarks.has(node.targetTurn.bookmarkEntryId) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
                          <path d="M3 1.5h10a1 1 0 0 1 1 1v15l-6-4-6 4v-15a1 1 0 0 1 1-1Z" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

// Hook to create a stable array of refs for messages
export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
