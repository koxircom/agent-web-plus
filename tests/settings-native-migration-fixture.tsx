import React, { useState } from "react";
import { I18nProvider } from "@/hooks/useI18n";
import { SettingsPanel } from "@/components/SettingsPanel";
import { SessionSidebar } from "@/components/SessionSidebar";
import { settingsExtensionRegistry, LEGACY_SETTINGS_EXTENSIONS } from "@/lib/settings-extensions";
import { registerEnhancementOpenSettings } from "@/lib/enhancement-sidebar-bridge";
import type { SettingsSection } from "@/lib/settings-navigation";

interface TestControl {
  open: (section?: SettingsSection, cwd?: string | null) => void;
  close: () => void;
  remount: () => void;
  rerender: () => void;
  setTheme: (theme: "dark" | "light") => void;
  togglePluginMock: (pluginId: string, enabled: boolean) => void;
}

declare global {
  interface Window {
    __TEST_CONTROL__?: TestControl;
  }
}

export function SettingsMigrationApp() {
  const [isOpen, setIsOpen] = useState(true);
  const [currentSection, setCurrentSection] = useState<SettingsSection>("general");
  const [currentCwd, setCurrentCwd] = useState<string | null>("/workspace/pi-web");
  const [remountKey, setRemountKey] = useState(0);
  const [parentRevision, setParentRevision] = useState(0);
  const [quoteSelection, setQuoteSelection] = useState(true);
  const [explorerVisible, setExplorerVisible] = useState(false);

  React.useEffect(() => {
    const unregisterOpen = registerEnhancementOpenSettings((sec) => {
      setCurrentSection((sec || "general") as SettingsSection);
      setIsOpen(true);
    });

    window.__TEST_CONTROL__ = {
      open: (sec = "general", cwd = "/workspace/pi-web") => {
        setCurrentSection(sec);
        setCurrentCwd(cwd);
        setIsOpen(true);
      },
      close: () => setIsOpen(false),
      remount: () => setRemountKey((k) => k + 1),
      rerender: () => setParentRevision((revision) => revision + 1),
      setTheme: (theme) => {
        document.documentElement.setAttribute("data-theme", theme);
        if (theme === "dark") {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      },
      togglePluginMock: (pluginId, enabled) => {
        try {
          localStorage.setItem(`pi-enh-plugin-${pluginId}`, enabled ? "true" : "false");
          const raw = localStorage.getItem("pi-enh-settings-v1");
          let cfg: any = {};
          if (raw) {
            try { cfg = JSON.parse(raw); } catch (_) {}
          }
          cfg.features = cfg.features || {};
          cfg.features[pluginId] = cfg.features[pluginId] || {};
          cfg.features[pluginId].enabled = Boolean(enabled);
          localStorage.setItem("pi-enh-settings-v1", JSON.stringify(cfg));
        } catch (_) {}
        settingsExtensionRegistry.notifyPreferencesChanged();
      },
    };

    return () => {
      unregisterOpen();
      delete window.__TEST_CONTROL__;
    };
  }, []);

  return (
    <div className="test-app-root" data-parent-revision={parentRevision}>
      <aside className="sidebar-container" style={{ width: 280, height: "100%" }}>
        <SessionSidebar selectedSessionId={null} onSelectSession={() => {}} skipInitialProjectSelection />
        <div data-pi-enh-shortcuts-host="true" />
      </aside>
      {!isOpen && (
        <button
          type="button"
          id="test-open-settings-btn"
          onClick={() => setIsOpen(true)}
        >
          Open Settings
        </button>
      )}

      {isOpen && (
        <SettingsPanel
          key={remountKey}
          cwd={currentCwd}
          sessionId="test-session-migration-123"
          initialSection={currentSection}
          onClose={() => setIsOpen(false)}
          onSessionReloaded={() => {}}
          quoteSelectionEnabled={quoteSelection}
          onQuoteSelectionChange={setQuoteSelection}
          explorerVisible={explorerVisible}
          onExplorerVisibilityChange={setExplorerVisible}
        />
      )}
    </div>
  );
}

// 供页面独立加载挂载
if (typeof window !== "undefined") {
  const rootEl = document.getElementById("root");
  if (rootEl) {
    import("react-dom/client").then(({ createRoot }) => {
      createRoot(rootEl).render(
        <I18nProvider>
          <SettingsMigrationApp />
        </I18nProvider>,
      );
    });
  }
}
