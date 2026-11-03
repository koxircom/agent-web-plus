"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isSettingsPluginEnabled, settingsExtensionRegistry } from "@/lib/settings-extensions";
import {
  deleteQueuedMessage,
  fetchQueueActions,
  fetchQueuedMessageDetail,
  matchQueueEntries,
  promoteQueuedMessage,
  recallAllQueuedMessages,
  recallSingleQueuedMessage,
  reorderQueuedMessages,
  type QueuedImage,
  type QueueRowData,
} from "@/lib/composer-queue-client";
import type { RecalledPromptRestoration } from "@/lib/queue-recall-client";

export interface UseComposerQueueBridgeOptions {
  sessionId: string;
  entries: readonly QueueRowData[];
  signature: string;
  actionsEnabled: boolean;
  onRestoreRecall?: (payload: RecalledPromptRestoration) => Promise<boolean>;
  onRecallQueue?: () => void;
  onToast?: (message: string, type?: "info" | "success" | "error") => void;
}

export interface UseComposerQueueBridgeResult {
  pluginEnabled: boolean;
  enabled: boolean;
  busy: boolean;
  reorder: boolean;
  images: QueuedImage[][];
  tokens: string[];
  statuses?: Array<{ status: string; error?: string }>;
  errorMessage: string | null;
  action: (name: string, index?: number, targetIndex?: number) => Promise<boolean>;
}

export function useComposerQueueBridge({
  sessionId,
  entries,
  signature,
  actionsEnabled,
  onRestoreRecall,
  onRecallQueue,
  onToast,
}: UseComposerQueueBridgeOptions): UseComposerQueueBridgeResult {
  // 1. Plugin toggle subscription from settings registry, no ready-event wait
  const [pluginEnabled, setPluginEnabled] = useState(() => isSettingsPluginEnabled("composer-queue-panel"));

  useEffect(() => {
    const sync = () => {
      setPluginEnabled(isSettingsPluginEnabled("composer-queue-panel"));
    };
    sync();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", sync);
      const unsubscribe = settingsExtensionRegistry.subscribePreferences(sync);
      return () => {
        window.removeEventListener("storage", sync);
        unsubscribe();
      };
    }
  }, []);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const currentSessionIdRef = useRef(sessionId);
  currentSessionIdRef.current = sessionId;
  const currentSignatureRef = useRef(signature);
  currentSignatureRef.current = signature;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const [state, setState] = useState<{
    signature: string;
    tokens: string[];
    images: QueuedImage[][];
    reorder: boolean;
    statuses?: Array<{ status: string; error?: string }>;
    verified: boolean;
  }>({
    signature,
    tokens: [],
    images: entries.map(() => []),
    reorder: false,
    verified: false,
  });

  // 2. Generation counter and AbortController to prevent route / session A -> B races
  const generationRef = useRef(0);
  const activeControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const gen = ++generationRef.current;
    if (activeControllerRef.current) {
      activeControllerRef.current.abort();
      activeControllerRef.current = null;
    }

    // Reset busy lock and errors when switching session or queue signature
    busyRef.current = false;
    setBusy(false);
    setErrorMessage(null);

    const currentEntries = entriesRef.current;

    if (!pluginEnabled || !actionsEnabled || !currentEntries.length) {
      setState({
        signature,
        tokens: [],
        images: currentEntries.map(() => []),
        reorder: false,
        statuses: undefined,
        verified: false,
      });
      return;
    }

    const controller = new AbortController();
    activeControllerRef.current = controller;

    void (async () => {
      try {
        const snapshot = await fetchQueueActions(sessionId, controller.signal);
        if (generationRef.current !== gen || controller.signal.aborted) return;

        const matched = matchQueueEntries(currentEntries, snapshot);
        if (!matched) {
          // Desynchronized or signature mismatch: empty authoritative fallback
          setState({
            signature,
            tokens: [],
            images: currentEntries.map(() => []),
            reorder: false,
            statuses: undefined,
            verified: false,
          });
          return;
        }

        const tokens = matched.map((item) => item.token);
        const statuses = matched.some((m) => m.status)
          ? matched.map((m) => ({ status: m.status || "", error: m.error }))
          : undefined;

        // Fetch details for entries having image attachments
        const detailPromises = matched.map((item) => {
          if (item.imageCount > 0) {
            return fetchQueuedMessageDetail(sessionId, item.token, controller.signal);
          }
          return Promise.resolve(null);
        });

        const details = await Promise.all(detailPromises);
        if (generationRef.current !== gen || controller.signal.aborted) return;

        if (matched.some((item, i) => item.imageCount > 0 && (!details[i] || details[i]!.images.length !== item.imageCount))) {
          throw new Error("队列图片尚未完整读取，请重新同步；消息未被修改");
        }
        const images = details.map((d) => d?.images ?? []);
        setState({
          signature,
          tokens,
          images,
          reorder: snapshot?.reorder === true,
          statuses,
          verified: true,
        });
      } catch (error) {
        if (generationRef.current !== gen || controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : "队列详情读取失败，消息未被修改");
        setState({
          signature,
          tokens: [],
          images: currentEntries.map(() => []),
          reorder: false,
          statuses: undefined,
          verified: false,
        });
      }
    })();

    return () => {
      controller.abort();
    };
  }, [sessionId, signature, actionsEnabled, pluginEnabled]);

  const isCurrentSignature = state.signature === signature;
  const isActionReady = actionsEnabled && pluginEnabled && state.verified && isCurrentSignature;

  // 3. Command dispatcher for delete, promote, reorder, recall
  const action = useCallback(
    async (name: string, index = -1, targetIndex = -1): Promise<boolean> => {
      if (!actionsEnabled) return false;
      if (!pluginEnabled || !state.verified) {
        if (name === "recallAll") {
          onRecallQueue?.();
          return true;
        }
        return false;
      }
      // Strict signature and session identity verification
      if (state.signature !== signature || signature !== currentSignatureRef.current || sessionId !== currentSessionIdRef.current) {
        return false;
      }
      // Synchronous mutex lock to prevent same-tick duplicate POSTs
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      setErrorMessage(null);

      const actionSessionId = sessionId;
      const actionSignature = signature;
      const isStillCurrent = () =>
        currentSessionIdRef.current === actionSessionId && currentSignatureRef.current === actionSignature;

      try {
        if (name === "delete") {
          const token = state.tokens[index];
          if (!token) throw new Error("排队消息未绑定或队列状态已变化");
          const ok = await deleteQueuedMessage(sessionId, token);
          if (!ok) throw new Error("删除排队消息失败");
          return true;
        } else if (name === "promote") {
          const token = state.tokens[index];
          if (!token) throw new Error("排队消息未绑定或队列状态已变化");
          const ok = await promoteQueuedMessage(sessionId, token);
          if (!ok) throw new Error("转为立即引导失败");
          if (isStillCurrent()) {
            onToast?.("已转为立即引导，将在下一个执行点优先处理", "success");
          }
          return true;
        } else if (name === "reorder") {
          const token = state.tokens[index];
          const targetToken = state.tokens[targetIndex];
          if (!state.reorder || !token || !targetToken || index === targetIndex || entriesRef.current[index]?.kind !== entriesRef.current[targetIndex]?.kind) return false;
          const ok = await reorderQueuedMessages(sessionId, state.tokens, token, targetToken);
          if (!ok) throw new Error("排序失败");
          return true;
        } else if (name === "recall") {
          const token = state.tokens[index];
          if (!token) throw new Error("排队消息未绑定或队列状态已变化");
          await recallSingleQueuedMessage({
            sessionId,
            token,
            targetDraftKey: sessionId,
            onRestoreRecall,
          });
          if (isStillCurrent()) {
            onToast?.("已移回输入框编辑", "success");
          }
          return true;
        } else if (name === "recallAll") {
          if (!state.tokens.length) {
            onRecallQueue?.();
            return true;
          }
          await recallAllQueuedMessages({
            sessionId,
            tokens: state.tokens,
            targetDraftKey: sessionId,
            onRestoreRecall,
          });
          if (isStillCurrent()) {
            onToast?.("已全部移回输入框编辑", "success");
          }
          return true;
        }
        return false;
      } catch (err) {
        if (isStillCurrent()) {
          const msg = (err as Error)?.message || "排队消息操作失败";
          setErrorMessage(msg);
          onToast?.(msg, "error");
        }
        return false;
      } finally {
        if (isStillCurrent()) {
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [actionsEnabled, pluginEnabled, state, signature, sessionId, onRecallQueue, onRestoreRecall, onToast],
  );

  return {
    pluginEnabled,
    enabled: isActionReady,
    busy,
    reorder: isActionReady && state.reorder,
    images: isCurrentSignature ? state.images : entries.map(() => []),
    tokens: isCurrentSignature ? state.tokens : [],
    statuses: isCurrentSignature ? state.statuses : undefined,
    errorMessage,
    action,
  };
}
