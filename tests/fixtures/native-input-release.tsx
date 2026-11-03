import React, { useState, useRef, useEffect, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { ChatInput, type AttachedImage } from "@/components/ChatInput";
import { AskUserPanel, AskUserTextPanel } from "@/components/AskUserPanel";
import { I18nProvider } from "@/hooks/useI18n";
import type { InlineSuggestion } from "@/lib/inline-suggestion";
import type { ExtensionUiRequest, AskUserQuestion, ExtensionUiDeliveryResult } from "@/lib/types";

export interface NativeInputTestApi {
  setMode: (mode: "composer" | "ask-user" | "ask-user-text") => void;
  setIsStreaming: (streaming: boolean) => void;
  setDraftKey: (draftKey: string) => void;
  setCwd: (cwd: string) => void;
  setInlineSuggestion: (suggestion: InlineSuggestion | null) => void;
  setAskUserProps: (props: {
    request?: ExtensionUiRequest;
    question?: AskUserQuestion;
    waitingCount?: number;
    respondResult?: boolean | ExtensionUiDeliveryResult | "throw" | "slow";
  }) => void;
  getSentEvents: () => any[];
  clearSentEvents: () => void;
  getAskUserEvents: () => any[];
  clearAskUserEvents: () => void;
  resolveSlowDelivery?: () => void;
}

declare global {
  interface Window {
    __NATIVE_INPUT_API__?: NativeInputTestApi;
  }
}

function TestContainer() {
  const [mode, setMode] = useState<"composer" | "ask-user" | "ask-user-text">("composer");
  const [isStreaming, setIsStreaming] = useState(false);
  const [draftKey, setDraftKey] = useState("session-1");
  const [cwd, setCwd] = useState("/workspace/test");
  const [inlineSuggestion, setInlineSuggestion] = useState<InlineSuggestion | null>(null);

  // AskUser 状态
  const [askRequest, setAskRequest] = useState<any>({
    type: "extension_ui_request",
    id: "req-1",
    method: "custom",
    lines: [],
  });
  const [askQuestion, setAskQuestion] = useState<AskUserQuestion>({
    toolCallId: "req-1",
    question: "请选择处理方案",
    options: [{ title: "直接处理" }, { title: "稍后处理" }],
    allowFreeform: true,
    allowMultiple: false,
    allowComment: false,
  });
  const [waitingCount, setWaitingCount] = useState(0);
  const [respondBehavior, setRespondBehavior] = useState<boolean | ExtensionUiDeliveryResult | "throw" | "slow">(true);

  const [deliveredRequestIds, setDeliveredRequestIds] = useState<string[]>([]);
  const sentEventsRef = useRef<any[]>([]);
  const askUserEventsRef = useRef<any[]>([]);
  const slowResolverRef = useRef<(() => void) | null>(null);

  const handleSend = useCallback((message: string, images?: AttachedImage[]) => {
    sentEventsRef.current.push({ type: "send", message, images, time: Date.now() });
  }, []);

  const handleAbort = useCallback(() => {
    sentEventsRef.current.push({ type: "abort", time: Date.now() });
    setIsStreaming(false);
  }, []);

  const handleSteer = useCallback((message: string, images?: AttachedImage[], onRegistered?: any) => {
    const reqId = "steer-" + Math.random().toString(36).slice(2, 9);
    sentEventsRef.current.push({ type: "steer", message, images, time: Date.now() });
    if (onRegistered) {
      onRegistered({ requestId: reqId, draftKey, durable: true });
      setDeliveredRequestIds((prev) => [...prev, reqId]);
    }
    return true;
  }, [draftKey]);

  const handleFollowUp = useCallback((message: string, images?: AttachedImage[], onRegistered?: any) => {
    const reqId = "followup-" + Math.random().toString(36).slice(2, 9);
    sentEventsRef.current.push({ type: "followup", message, images, time: Date.now() });
    if (onRegistered) {
      onRegistered({ requestId: reqId, draftKey, durable: true });
      setDeliveredRequestIds((prev) => [...prev, reqId]);
    }
    return true;
  }, [draftKey]);

  const handleAskUserInput = useCallback(async (request: any, data: any) => {
    askUserEventsRef.current.push({ request, data, time: Date.now() });
    if (respondBehavior === "slow") {
      await new Promise<void>((resolve) => {
        slowResolverRef.current = resolve;
      });
      return true;
    }
    if (respondBehavior === "throw") {
      throw new Error("回答未确认送达，网络故障");
    }
    if (typeof respondBehavior === "boolean") {
      return respondBehavior;
    }
    return respondBehavior;
  }, [respondBehavior]);

  const handleAskUserRespond = useCallback(async (request: any, response: any) => {
    askUserEventsRef.current.push({ request, response, time: Date.now() });
    if (respondBehavior === "slow") {
      await new Promise<void>((resolve) => {
        slowResolverRef.current = resolve;
      });
      return true;
    }
    if (respondBehavior === "throw") {
      throw new Error("回答未确认送达，网络故障");
    }
    if (typeof respondBehavior === "boolean") {
      return respondBehavior;
    }
    return respondBehavior;
  }, [respondBehavior]);

  useEffect(() => {
    window.__NATIVE_INPUT_API__ = {
      setMode,
      setIsStreaming,
      setDraftKey,
      setCwd,
      setInlineSuggestion,
      setAskUserProps: (props) => {
        if (props.request !== undefined) setAskRequest(props.request);
        if (props.question !== undefined) setAskQuestion(props.question);
        if (props.waitingCount !== undefined) setWaitingCount(props.waitingCount);
        if (props.respondResult !== undefined) setRespondBehavior(props.respondResult);
      },
      getSentEvents: () => [...sentEventsRef.current],
      clearSentEvents: () => {
        sentEventsRef.current = [];
      },
      getAskUserEvents: () => [...askUserEventsRef.current],
      clearAskUserEvents: () => {
        askUserEventsRef.current = [];
      },
      resolveSlowDelivery: () => {
        if (slowResolverRef.current) {
          slowResolverRef.current();
          slowResolverRef.current = null;
        }
      },
    };
  }, []);

  return (
    <div style={{ padding: 16, maxWidth: 960, margin: "0 auto", boxSizing: "border-box" }}>
      {mode === "composer" && (
        <ChatInput
          key={`composer-${draftKey}`}
          draftKey={draftKey}
          cwd={cwd}
          isStreaming={isStreaming}
          inlineSuggestion={inlineSuggestion}
          onSend={handleSend}
          onAbort={handleAbort}
          onSteer={handleSteer}
          onFollowUp={handleFollowUp}
          deliveredRequestIds={deliveredRequestIds}
          model={{ provider: "openai", modelId: "gpt-6.1-sol" }}
          thinkingLevel="high"
        />
      )}

      {mode === "ask-user" && (
        <AskUserPanel
          key={`ask-${askRequest.id}-${draftKey}`}
          request={askRequest}
          question={askQuestion}
          waitingCount={waitingCount}
          onInput={handleAskUserInput}
          onReply={handleAskUserRespond}
        />
      )}

      {mode === "ask-user-text" && (
        <AskUserTextPanel
          key={`ask-text-${askRequest.id}-${draftKey}`}
          request={askRequest}
          waitingCount={waitingCount}
          onRespond={handleAskUserRespond}
        />
      )}
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <I18nProvider>
      <TestContainer />
    </I18nProvider>
  );
}
