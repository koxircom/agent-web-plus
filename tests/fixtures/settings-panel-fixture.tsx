"use client";

import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "../../hooks/useI18n";
import { SettingsPanel } from "../../components/SettingsPanel";
import { settingsExtensionRegistry } from "../../lib/settings-extensions";
import type { SettingsSection } from "../../lib/settings-navigation";

export interface SettingsTestApi {
  setSection: (section: SettingsSection) => void;
  setCwd: (cwd: string | null) => void;
  triggerParentRerender: () => void;
  getSettingsNativeAbi: () => any;
  closeCalls: number;
}

declare global {
  interface Window {
    __SETTINGS_TEST_API__?: SettingsTestApi;
  }
}

function TestSettingsRoot() {
  const [cwd, setCwd] = useState<string | null>("/workspace/test-project");
  const [section, setSection] = useState<SettingsSection>("general");
  const [rerenderCount, setRerenderCount] = useState(0);
  const [closeCalls, setCloseCalls] = useState(0);
  const [explorerVisible, setExplorerVisible] = useState(false);

  useEffect(() => {
    window.__SETTINGS_TEST_API__ = {
      setSection: (s) => setSection(s),
      setCwd: (c) => setCwd(c),
      triggerParentRerender: () => setRerenderCount((c) => c + 1),
      getSettingsNativeAbi: () => (window as any).__PI_WEB_SETTINGS_NATIVE__,
      closeCalls,
    };
  }, [closeCalls]);

  return (
    <I18nProvider>
      <div
        data-parent-rerender-count={rerenderCount}
        style={{ width: "100%", height: "100%", position: "relative" }}
      >
        <SettingsPanel
          cwd={cwd}
          sessionId="test-session-123"
          initialSection={section}
          onClose={() => setCloseCalls((c) => c + 1)}
          onSessionReloaded={() => {}}
          quoteSelectionEnabled={true}
          onQuoteSelectionChange={() => {}}
          explorerVisible={explorerVisible}
          onExplorerVisibilityChange={setExplorerVisible}
        />
      </div>
    </I18nProvider>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  const root = ReactDOM.createRoot(rootEl);
  root.render(<TestSettingsRoot />);
}
