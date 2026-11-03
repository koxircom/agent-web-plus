import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ComposerQueue } from "@/components/ComposerQueue";
import type { QueuedMessages } from "@/hooks/useAgentSession";

interface QueueTestControl {
  setQueue: (q: QueuedMessages | null) => void;
  setSessionId: (id: string) => void;
  setEngine: (eng: "pi" | "codex") => void;
  setSyncStatus: (s: "loading" | "ready" | "error") => void;
  getQueue: () => QueuedMessages | null;
}

declare global {
  interface Window {
    __QUEUE_TEST_CONTROL__?: QueueTestControl;
  }
}

function TestHost() {
  const [sessionId, setSessionId] = useState(() => {
    return new URLSearchParams(window.location.search).get("session") || "session-test-1";
  });
  const [engine, setEngine] = useState<"pi" | "codex">(() => {
    return (new URLSearchParams(window.location.search).get("engine") as "pi" | "codex") || "pi";
  });
  const [syncStatus, setSyncStatus] = useState<"loading" | "ready" | "error">("ready");
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages | null>(() => {
    const raw = new URLSearchParams(window.location.search).get("initialQueue");
    if (raw) {
      try {
        return JSON.parse(decodeURIComponent(raw));
      } catch {}
    }
    return {
      steering: ["优先任务 A"],
      followUp: ["普通任务 1", "普通任务 2", "普通任务 3"],
      requestIds: {
        steering: ["id-steer-A"],
        followUp: ["id-follow-1", "id-follow-2", "id-follow-3"],
      },
    };
  });

  useEffect(() => {
    window.__QUEUE_TEST_CONTROL__ = {
      setQueue: (q) => setQueuedMessages(q),
      setSessionId: (id) => setSessionId(id),
      setEngine: (eng) => setEngine(eng),
      setSyncStatus: (s) => setSyncStatus(s),
      getQueue: () => queuedMessages,
    };
  }, [queuedMessages]);

  return (
    <main style={{ padding: "16px", maxWidth: "820px", margin: "0 auto" }}>
      <ComposerQueue
        sessionId={sessionId}
        executionEngine={engine}
        queuedMessages={queuedMessages}
        syncStatus={syncStatus}
      />
      <div id="test-anchor" style={{ marginTop: "20px" }}>测试桩</div>
    </main>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<TestHost />);
}
