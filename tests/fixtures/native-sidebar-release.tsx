import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { SessionSidebar } from "../../components/SessionSidebar";
import { I18nProvider } from "../../hooks/useI18n";
import type { SessionInfo } from "../../lib/types";

export const FIXTURE_EVIDENCE_DISCLAIMER = "QA-A-COMPONENT-HTTP-EVIDENCE-ONLY-MAIN-GATE-REVIEWS-FULL-SITE";

declare global {
  interface Window {
    __NATIVE_SIDEBAR_CONFIG__?: {
      bootstrap: any;
      executionEngine?: "pi" | "codex";
      codexEnabled?: boolean;
      selectedSessionId?: string | null;
      selectedCwd?: string;
      customTags?: any[];
      customMappings?: Record<string, string[]>;
      onSelectSessionLog?: string[];
    };
    __FIXTURE_API__?: {
      setExecutionEngine: (engine: "pi" | "codex") => void;
      setSelectedSessionId: (id: string | null) => void;
      setBootstrap: (bs: any) => void;
      togglePin?: (id: string) => Promise<boolean>;
      getSelectedSessionId: () => string | null;
      getExecutionEngine: () => string;
      rerenderSidebar: () => void;
    };
    __PI_ENH_GET_SESSION_TAGS__?: (sessionId: string) => any[];
    __PI_ENH_IS_PLUGIN_ENABLED__?: (id: string) => boolean;
  }
}

function FixtureSidebarApp() {
  const config = window.__NATIVE_SIDEBAR_CONFIG__ || {
    bootstrap: {
      renderedAt: Date.now(),
      sessions: [],
      sessionListVersion: 1,
      runningSessionIds: [],
      completionNotificationSuppressedSessionIds: [],
    },
    executionEngine: "codex" as const,
    codexEnabled: true,
    selectedSessionId: null,
    selectedCwd: "/fixture/workspace",
  };

  const [engine, setEngine] = useState<"pi" | "codex">(config.executionEngine || "codex");
  const [bootstrap, setBootstrap] = useState(config.bootstrap);
  const [selectedId, setSelectedId] = useState<string | null>(config.selectedSessionId ?? null);
  const [cwd, setCwd] = useState(config.selectedCwd || "/fixture/workspace");
  const [refreshKey, setRefreshKey] = useState(0);

  const handleSelectSession = useCallback((session: SessionInfo) => {
    setSelectedId(session.id);
    if (config.onSelectSessionLog) {
      config.onSelectSessionLog.push(session.id);
    }
  }, [config]);

  const handleNewSession = useCallback((_tempId: string, effectiveCwd: string, _targetEngine: "pi" | "codex") => {
    setSelectedId(null);
    setCwd(effectiveCwd);
  }, []);

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    window.__FIXTURE_API__ = {
      setExecutionEngine: (next) => setEngine(next),
      setSelectedSessionId: (next) => setSelectedId(next),
      setBootstrap: (next) => setBootstrap(next),
      getSelectedSessionId: () => selectedIdRef.current,
      getExecutionEngine: () => engine,
      rerenderSidebar: () => setRefreshKey((k) => k + 1),
    };
  }, [engine]);

  return (
    <div
      data-qa-fixture="native-sidebar-release"
      data-qa-disclaimer={FIXTURE_EVIDENCE_DISCLAIMER}
      style={{ display: "flex", height: 800, width: 360, overflow: "hidden" }}
    >
      <div style={{ width: 360, height: "100%", display: "flex", flexDirection: "column" }}>
        <SessionSidebar
          bootstrap={bootstrap}
          initialSessionId={config.selectedSessionId || bootstrap?.sessions?.[0]?.id}
          executionEngine={engine}
          codexEnabled={config.codexEnabled !== false}
          onExecutionEngineChange={async (next) => { setEngine(next); }}
          selectedSessionId={selectedId}
          selectedCwd={cwd}
          refreshKey={refreshKey}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
        />
      </div>
    </div>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <I18nProvider initialLocale="zh-CN">
      <FixtureSidebarApp />
    </I18nProvider>
  );
}
