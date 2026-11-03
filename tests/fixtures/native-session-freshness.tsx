import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useAgentSession } from "../../hooks/useAgentSession";
import { I18nProvider } from "../../hooks/useI18n";
import type { SessionInfo } from "../../lib/types";

export const FIXTURE_EVIDENCE_DISCLAIMER = "QA-A-COMPONENT-HTTP-EVIDENCE-ONLY-MAIN-GATE-REVIEWS-FULL-SITE";

declare global {
  interface Window {
    __FRESHNESS_CONFIG__?: {
      sessions: SessionInfo[];
      initialSessionId?: string;
    };
    __FRESHNESS_API__?: {
      getSelectedSessionId: () => string;
      switchSession: (nextId: string) => void;
      refreshCurrentSession: () => void;
      getHookState: () => any;
      getMessageTexts: () => string[];
    };
  }
}

function SessionContentView({
  session,
  refreshKey,
}: {
  session: SessionInfo;
  refreshKey: number;
}) {
  const hook = useAgentSession({
    session,
    sessionRefreshKey: refreshKey,
    newSessionCwd: null,
    newSessionDraftKey: null,
  });

  const messageTexts = hook.messages.map((m: any) => m.content?.[0]?.text || "");

  useEffect(() => {
    if (window.__FRESHNESS_API__) {
      window.__FRESHNESS_API__.getHookState = () => ({
        sessionId: session.id,
        loading: hook.loading,
        messageCount: hook.messages.length,
        entryIds: hook.entryIds,
        messages: hook.messages,
        error: hook.error,
      });
      window.__FRESHNESS_API__.getMessageTexts = () => messageTexts;
    }
  });

  return (
    <div
      data-testid="session-content"
      data-active-session-id={session.id}
      data-loading={String(hook.loading)}
    >
      <h2 data-testid="active-session-name">{session.name}</h2>
      <output
        data-ready
        data-loading={String(hook.loading)}
        data-message-count={hook.messages.length}
      >
        {hook.messages.length}条消息
      </output>
      <div data-testid="chat-messages-container">
        {hook.messages.map((msg: any, i: number) => (
          <div
            key={hook.entryIds[i] || i}
            data-entry-id={hook.entryIds[i] || i}
            className="chat-message-bubble"
          >
            {msg.content?.[0]?.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function FreshnessFixtureApp() {
  const config = window.__FRESHNESS_CONFIG__ || {
    sessions: [],
    initialSessionId: "",
  };

  const [currentId, setCurrentId] = useState<string>(
    config.initialSessionId || (config.sessions[0]?.id ?? "")
  );
  const [refreshKey, setRefreshKey] = useState(0);

  const activeSession =
    config.sessions.find((s: any) => s.id === currentId) || config.sessions[0];

  const currentIdRef = useRef(currentId);
  currentIdRef.current = currentId;

  useEffect(() => {
    window.__FRESHNESS_API__ = {
      getSelectedSessionId: () => currentIdRef.current,
      switchSession: (nextId: string) => setCurrentId(nextId),
      refreshCurrentSession: () => setRefreshKey((k) => k + 1),
      getHookState: () => null,
      getMessageTexts: () => [],
    };
  }, []);

  return (
    <I18nProvider>
      <div
        data-qa-fixture="native-session-freshness"
        data-qa-disclaimer={FIXTURE_EVIDENCE_DISCLAIMER}
        style={{ padding: 16 }}
      >
        <header>
          <h1>会话新鲜度与防陈旧覆盖真实Owner测试</h1>
          <nav data-testid="session-tabs" style={{ display: "flex", gap: 8, margin: "12px 0" }}>
            {config.sessions.map((s: any) => (
              <button
                key={s.id}
                type="button"
                data-pi-enh-session-id={s.id}
                data-selected={s.id === currentId ? "true" : "false"}
                onClick={() => setCurrentId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </nav>
          <button
            type="button"
            data-testid="refresh-session-btn"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            刷新当前会话
          </button>
        </header>

        <main style={{ marginTop: 16 }}>
          {activeSession ? (
            <SessionContentView
              key={activeSession.id}
              session={activeSession}
              refreshKey={refreshKey}
            />
          ) : (
            <p>无选中会话</p>
          )}
        </main>
      </div>
    </I18nProvider>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<FreshnessFixtureApp />);
}
