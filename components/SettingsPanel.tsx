"use client";

import {
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import dynamic from "next/dynamic";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { THEME_OPTIONS } from "@/lib/theme";
import { ThemeIcon } from "./ThemeIcon";
import {
  CHAT_CONTENT_WIDTH_DEFAULT,
  CHAT_CONTENT_WIDTH_MAX,
  CHAT_CONTENT_WIDTH_MIN,
  CHAT_CONTENT_FONT_SIZE_DEFAULT,
  CHAT_CONTENT_FONT_SIZE_MAX,
  CHAT_CONTENT_FONT_SIZE_MIN,
  useChatAppearance,
} from "@/hooks/useChatAppearance";
import { sendAgentCommand } from "@/lib/agent-client";
import type { ProjectTrustStatus, ToolSettingsResponse } from "@/lib/api-types";
import {
  setLastSettingsSection,
  type SettingsSection,
} from "@/lib/settings-navigation";
import {
  isThinkingExpandedByDefault,
  setThinkingExpandedByDefault,
} from "@/lib/thinking-expansion-preference";
import { setupPushSubscription } from "@/lib/push-client";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";
import {
  readInitialSettingsLayout,
  saveSidebarWidth,
  saveSidebarCollapsed,
  saveDialogSize,
  clampSidebarWidth,
  clampDialogSize,
  SETTINGS_SIDEBAR_WIDTH_DEFAULT,
  SETTINGS_SIDEBAR_WIDTH_MIN,
  SETTINGS_SIDEBAR_WIDTH_MAX,
  SETTINGS_SIDEBAR_WIDTH_COLLAPSED,
  SETTINGS_DIALOG_WIDTH_DEFAULT,
  SETTINGS_DIALOG_HEIGHT_DEFAULT,
  SETTINGS_DIALOG_WIDTH_MIN,
  SETTINGS_DIALOG_HEIGHT_MIN,
  type SettingsLayoutState,
  type SettingsDialogSize,
} from "@/lib/settings-layout";
import {
  settingsExtensionRegistry,
  LEGACY_SETTINGS_EXTENSIONS,
  isExtensionEnabled,
  isSettingsPluginEnabled,
  type SettingsExtensionDefinition,
} from "@/lib/settings-extensions";
import { IsolatedSettingsHost } from "./IsolatedSettingsHost";
import { focusModalPanel, listenForPanelEscape } from "@/lib/stacked-dialog";

function SettingsSectionLoading({ section, error, retry }: {
  section: SettingsSection;
  error?: Error | null;
  retry?: () => void;
}) {
  const { t } = useI18n();
  const labels = { models: t("common.models"), skills: t("common.skills"), agents: t("common.agents"), plugins: t("common.plugins"), mcp: t("settings.mcp") };
  return (
    <div className="settings-section-loading" role={error ? "alert" : "status"} aria-busy={!error}>
      <h2>{labels[section as keyof typeof labels]}</h2>
      <p>{error ? "此设置页加载失败，请重试。" : t("i18n.loading")}</p>
      {error ? <ConfigButton onClick={retry}>重试加载</ConfigButton> : (
        <div className="settings-loading-skeleton" aria-hidden="true">
          <div /><div /><div />
        </div>
      )}
    </div>
  );
}

const loadModelsConfig = () => import("./ModelsConfig").then((module) => module.ModelsConfig);
const loadSkillsConfig = () => import("./SkillsConfig").then((module) => module.SkillsConfig);
const loadAgentsConfig = () => import("./AgentsConfig").then((module) => module.AgentsConfig);
const loadPluginsConfig = () => import("./PluginsConfig").then((module) => module.PluginsConfig);
const loadMcpConfig = () => import("./McpConfig").then((module) => module.McpConfig);
const ModelsConfig = dynamic(loadModelsConfig, { loading: (props) => <SettingsSectionLoading section="models" {...props} /> });
const SkillsConfig = dynamic(loadSkillsConfig, { loading: (props) => <SettingsSectionLoading section="skills" {...props} /> });
const AgentsConfig = dynamic(loadAgentsConfig, { loading: (props) => <SettingsSectionLoading section="agents" {...props} /> });
const PluginsConfig = dynamic(loadPluginsConfig, { loading: (props) => <SettingsSectionLoading section="plugins" {...props} /> });
const McpConfig = dynamic(loadMcpConfig, { loading: (props) => <SettingsSectionLoading section="mcp" {...props} /> });

const sectionLoaders = { models: loadModelsConfig, skills: loadSkillsConfig, agents: loadAgentsConfig, plugins: loadPluginsConfig, mcp: loadMcpConfig };
export function preloadSettingsSection(section: SettingsSection) {
  const loader = sectionLoaders[section as keyof typeof sectionLoaders];
  // Warm only the hovered/focused code chunk; no component/data request is mounted.
  if (loader) void loader().catch(() => {});
}

interface Props {
  resolveReturnFocus?: (opener: Element) => Element | null;
  cwd: string | null;
  sessionId: string | null;
  initialSection: SettingsSection;
  onClose: () => void;
  onSessionReloaded: () => void;
  quoteSelectionEnabled: boolean;
  onQuoteSelectionChange: (enabled: boolean) => void;
  /** The page's trust status for `cwd`; Settings › MCP reloads when it changes. */
  projectTrust?: ProjectTrustStatus | null;
  /** Opens the page's trust dialog for `cwd`. */
  onOpenTrustDialog?: () => void;
  /** Settings › MCP changed `cwd`'s project trust. */
  onProjectTrustChanged?: (cwd: string, status: ProjectTrustStatus) => void;
}

export function SettingsSectionIcon({ section, size = 16, strokeWidth = 1.8 }: { section: SettingsSection; size?: number; strokeWidth?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "settings-section-icon",
  };

  if (section === "general") return <svg {...common}><path d="M20 7h-9M14 17H5" /><circle cx="7" cy="7" r="3" /><circle cx="17" cy="17" r="3" /></svg>;
  if (section === "models") return <svg {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" /></svg>;
  if (section === "skills") return <svg {...common}><path d="m12 2-10 5 10 5 10-5-10-5Z" /><path d="m2 12 10 5 10-5M2 17l10 5 10-5" /></svg>;
  if (section === "agents") return <svg {...common} className="settings-section-icon is-agent"><rect x="5" y="7" width="14" height="11" rx="2" /><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4" /></svg>;
  if (section === "plugins") return <svg {...common}><path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3" /></svg>;
  if (section === "mcp") return <svg {...common}><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></svg>;
  if (section === "enhancements") return <svg {...common}><path d="M12 2v4m0 12v4M2 12h4m12 0h4m-3.5-6.5 2.5-2.5m-15 15 2.5-2.5m0-10-2.5-2.5m15 15-2.5-2.5" /><circle cx="12" cy="12" r="4" /></svg>;
  if (section === "notifications") return <svg {...common}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>;
  if (section === "archived") return <svg {...common}><rect width="20" height="5" x="2" y="3" rx="1" /><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" /><path d="M10 12h4" /></svg>;
  if (section === "usage") return <svg {...common}><path d="M3 3v18h18" /><path d="m19 9-5 5-4-4-3 3" /></svg>;
  if (section === "tags") return <svg {...common}><path d="m12 2 8 8-9.5 9.5a2.12 2.12 0 0 1-3 0l-5-5a2.12 2.12 0 0 1 0-3L12 2Z" /><circle cx="16" cy="6" r="1.5" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="9" /></svg>;
}

interface NavGroupDef {
  id: "general" | "agent" | "data";
  titleKey: string;
  sectionIds: readonly SettingsSection[];
}

const SETTINGS_NAV_GROUPS: readonly NavGroupDef[] = [
  {
    id: "general",
    titleKey: "settings.groupGeneral",
    sectionIds: ["general", "notifications"],
  },
  {
    id: "agent",
    titleKey: "settings.groupAgents",
    sectionIds: ["models", "skills", "agents", "plugins", "mcp", "enhancements"],
  },
  {
    id: "data",
    titleKey: "settings.groupData",
    sectionIds: ["usage", "archived", "tags"],
  },
];

function SettingsRow({
  label,
  description,
  htmlFor,
  className,
  isSwitch = false,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  className?: string;
  isSwitch?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`settings-row${isSwitch ? " is-switch-row" : ""}${className ? ` ${className}` : ""}`}>
      <div className="settings-row-info">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="settings-row-label">{label}</label>
        ) : (
          <span className="settings-row-label">{label}</span>
        )}
        {description ? <div className="settings-row-description">{description}</div> : null}
      </div>
      <div className="settings-row-control">
        {children}
      </div>
    </div>
  );
}

interface SettingsHostContextProps {
  onClose: () => void;
  activateSection: (id: string) => boolean;
  availableSections: readonly string[];
  cwd: string | null;
  sessionId: string | null;
}

function MaintenanceHost(props: SettingsHostContextProps) {
  return <IsolatedSettingsHost {...props} id="maintenance" sectionId="general"
    className="settings-general-maintenance-host settings-extension-host" hideWhenEmpty />;
}

const subscribeSettingsPreferences = (listener: () => void) =>
  settingsExtensionRegistry.subscribePreferences(listener);
const readDashboardPreference = () => isSettingsPluginEnabled("general-settings-dashboard");

function GeneralSettings({
  sessionId,
  onSessionReloaded,
  quoteSelectionEnabled,
  onQuoteSelectionChange,
  onClose,
  activateSection,
  availableSections,
  cwd,
}: Pick<Props, "sessionId" | "onSessionReloaded" | "quoteSelectionEnabled" | "onQuoteSelectionChange"> & {
  onClose: () => void;
  activateSection: (id: string) => boolean;
  availableSections: readonly string[];
  cwd: string | null;
}) {
  const { locale, setLocale, supportedLocales, t } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const dashboardEnabled = useSyncExternalStore(
    subscribeSettingsPreferences, readDashboardPreference, readDashboardPreference,
  );
  const { width: chatContentWidth, setWidth: setChatContentWidth, fontSize, setFontSize } = useChatAppearance();
  const [shellSettings, setShellSettings] = useState<ToolSettingsResponse | null>(null);
  const [shellSaving, setShellSaving] = useState(false);
  const [shellError, setShellError] = useState<string | null>(null);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const [pushRegistering, setPushRegistering] = useState(false);
  const [pushStatus, setPushStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const [webAuthEnabled, setWebAuthEnabled] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  useEffect(() => {
    setThinkingExpanded(isThinkingExpandedByDefault());
    void fetch("/api/web-auth")
      .then((response) => response.ok ? response.json() : null)
      .then((data: { enabled?: boolean } | null) => setWebAuthEnabled(data?.enabled === true))
      .catch(() => {});
  }, []);

  const logOut = async () => {
    setLoggingOut(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/web-auth", { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      window.location.replace("/login");
    } catch {
      setLogoutError(t("auth.logoutFailed"));
    } finally {
      setLoggingOut(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/tools/settings")
      .then(async (response) => {
        const data = await response.json() as ToolSettingsResponse & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!cancelled) setShellSettings(data);
      })
      .catch((cause) => {
        if (!cancelled) setShellError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { cancelled = true; };
  }, []);

  const togglePowerShell = async (enabled: boolean) => {
    setShellSaving(true);
    setShellError(null);
    try {
      const response = await fetch("/api/tools/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as ToolSettingsResponse & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setShellSettings(data);
      if (sessionId) {
        await sendAgentCommand(sessionId, { type: "reload" });
        onSessionReloaded();
      }
    } catch (cause) {
      setShellError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setShellSaving(false);
    }
  };

  const registerPush = async () => {
    if (pushRegistering) return;
    setPushRegistering(true);
    setPushStatus(null);
    try {
      if (typeof window === "undefined" || !("Notification" in window)) {
        throw new Error("unsupported or not permitted");
      }
      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") throw new Error("unsupported or not permitted");
      const ok = await setupPushSubscription(locale);
      if (!ok) throw new Error("unsupported or not permitted");
      setPushStatus({ kind: "ok", message: t("settings.pushRegistered") });
    } catch (cause) {
      setPushStatus({ kind: "error", message: `${t("settings.pushRegisterFailed")} ${cause instanceof Error ? cause.message : String(cause)}` });
    } finally {
      setPushRegistering(false);
    }
  };

  return (
    <div className={`settings-general${dashboardEnabled ? " settings-general-dashboard" : ""}`}>
      <h2 className="settings-general-title">{t("settings.general")}</h2>

      {/* 常规设置卡片 */}
      <section className="settings-general-section settings-card" data-settings-area="appearance">
        <div className="settings-card-header">
          <h3 className="settings-card-title">{t("settings.general")}</h3>
        </div>
        <div className="settings-card-body">
          {/* 原生语言选择 */}
          <SettingsRow
            label={t("common.language")}
            description={t("settings.languageDescription")}
            htmlFor="settings-language-select"
            className="settings-language-row"
          >
            <select
              id="settings-language-select"
              className="settings-select settings-language-select"
              value={locale}
              onChange={(event) => setLocale(event.target.value as typeof locale)}
              aria-label={t("common.language")}
            >
              {supportedLocales.map((plugin) => (
                <option key={plugin.id} value={plugin.id}>
                  {plugin.label} ({plugin.id})
                </option>
              ))}
            </select>
          </SettingsRow>

          {/* 外观三段选择 */}
          <SettingsRow
            label={t("settings.appearance")}
            description={t("settings.appearanceDescription")}
            className="settings-appearance-row"
          >
            <div role="radiogroup" aria-label={t("settings.appearance")} className="settings-theme-options">
              {THEME_OPTIONS.map((option) => {
                const selected = preference === option.id;
                return (
                  <label
                    key={option.id}
                    className="settings-theme-option"
                  >
                    <input
                      type="radio"
                      name="theme"
                      value={option.id}
                      checked={selected}
                      onChange={() => setThemePreference(option.id)}
                      className="sr-only"
                    />
                    <ThemeIcon preference={option.id} />
                    <span className="settings-theme-option-label">{t(option.label)}</span>
                  </label>
                );
              })}
            </div>
          </SettingsRow>
        </div>
      </section>

      {/* 聊天设置卡片 */}
      <section className="settings-general-section settings-card" data-settings-area="chat">
        <div className="settings-card-header">
          <h3 className="settings-card-title">{t("settings.chat")}</h3>
        </div>
        <div className="settings-chat-options">
          {/* 宽度滑块 */}
          <div className="settings-chat-option settings-row">
            <div className="settings-row-info">
              <label htmlFor="settings-chat-content-width" className="settings-row-label">
                {t("settings.chatContentWidth")}
              </label>
              <div className="settings-row-description">
                {t("settings.chatContentWidthDescription")}
              </div>
            </div>
            <div className="settings-row-control settings-chat-range-control">
              <div className="settings-chat-range-track">
                <output htmlFor="settings-chat-content-width">{chatContentWidth}px</output>
                <ConfigButton
                  variant="ghost"
                  size="small"
                  className="settings-chat-reset"
                  title={t("settings.resetChatContentWidth")}
                  aria-label={t("settings.resetChatContentWidth")}
                  disabled={chatContentWidth === CHAT_CONTENT_WIDTH_DEFAULT}
                  onClick={() => setChatContentWidth(CHAT_CONTENT_WIDTH_DEFAULT)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                  </svg>
                </ConfigButton>
              </div>
              <input
                id="settings-chat-content-width"
                type="range"
                min={CHAT_CONTENT_WIDTH_MIN}
                max={CHAT_CONTENT_WIDTH_MAX}
                step={10}
                value={chatContentWidth}
                onChange={(event) => setChatContentWidth(Number(event.target.value))}
              />
            </div>
          </div>

          {/* 字号滑块 */}
          <div className="settings-chat-option settings-row">
            <div className="settings-row-info">
              <label htmlFor="settings-chat-content-font-size" className="settings-row-label">
                {t("settings.chatContentFontSize")}
              </label>
            </div>
            <div className="settings-row-control settings-chat-range-control">
              <div className="settings-chat-range-track">
                <output htmlFor="settings-chat-content-font-size">{fontSize}px</output>
                <ConfigButton
                  variant="ghost"
                  size="small"
                  className="settings-chat-reset"
                  title={t("settings.resetChatContentFontSize")}
                  aria-label={t("settings.resetChatContentFontSize")}
                  disabled={fontSize === CHAT_CONTENT_FONT_SIZE_DEFAULT}
                  onClick={() => setFontSize(CHAT_CONTENT_FONT_SIZE_DEFAULT)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5" />
                  </svg>
                </ConfigButton>
              </div>
              <input
                id="settings-chat-content-font-size"
                type="range"
                min={CHAT_CONTENT_FONT_SIZE_MIN}
                max={CHAT_CONTENT_FONT_SIZE_MAX}
                step={1}
                value={fontSize}
                onChange={(event) => setFontSize(Number(event.target.value))}
              />
            </div>
          </div>

          {/* 展开思考 */}
          <div className="settings-chat-option settings-row is-switch-row">
            <div className="settings-row-info">
              <span className="settings-row-label">{t("settings.thinkingExpandedDefault")}</span>
              <div className="settings-row-description">{t("settings.thinkingDisplayDescription")}</div>
            </div>
            <div className="settings-row-control">
              <ConfigSwitch
                checked={thinkingExpanded}
                label={t("settings.thinkingExpandedDefault")}
                onChange={(enabled) => {
                  setThinkingExpandedByDefault(enabled);
                  setThinkingExpanded(enabled);
                }}
              />
            </div>
          </div>

          {/* 划词提问 */}
          <div className="settings-chat-option settings-row is-switch-row">
            <div className="settings-row-info">
              <span className="settings-row-label">{t("settings.quoteSelection")}</span>
            </div>
            <div className="settings-row-control">
              <ConfigSwitch
                checked={quoteSelectionEnabled}
                label={t("settings.quoteSelection")}
                onChange={onQuoteSelectionChange}
              />
            </div>
          </div>
        </div>
      </section>

      {/* 系统权限卡片 */}
      <section className="settings-general-section settings-card" data-settings-area="system">
        <div className="settings-card-header">
          <h3 className="settings-card-title">{t("settings.systemPermissions")}</h3>
        </div>
        <div className="settings-card-body">
          {shellSettings?.isWindows && (
            <div className="settings-row is-switch-row" data-settings-area="shell">
              <div className="settings-row-info">
                <span className="settings-row-label">{t("settings.shellTool")}</span>
                <div className="settings-row-description">{t("settings.shellToolDescription")}</div>
                {shellError && <p role="alert" className="settings-general-error">{shellError}</p>}
              </div>
              <div className="settings-row-control">
                <ConfigSwitch
                  checked={shellSettings.powerShellEnabled}
                  loading={shellSaving}
                  label={t("settings.usePowerShell")}
                  onChange={(enabled) => void togglePowerShell(enabled)}
                />
              </div>
            </div>
          )}

          <div className="settings-row" data-settings-area="push">
            <div className="settings-row-info">
              <span className="settings-row-label">{t("settings.pushPermission")}</span>
              <div className="settings-row-description">{t("settings.pushPermissionDescription")}</div>
              {pushStatus && (
                <p
                  role="status"
                  className="settings-general-error"
                  style={pushStatus.kind === "ok" ? { color: "var(--accent)" } : undefined}
                >
                  {pushStatus.message}
                </p>
              )}
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className="config-button config-button-small config-button-secondary"
                disabled={pushRegistering}
                onClick={() => void registerPush()}
              >
                {pushRegistering ? t("settings.pushRegisterLoading") : t("settings.pushRegister")}
              </button>
            </div>
          </div>

          {webAuthEnabled && (
            <div className="settings-row" data-settings-area="signout">
              <div className="settings-row-info">
                <span className="settings-row-label">{t("auth.logOut")}</span>
                {logoutError && <p role="alert" className="settings-general-error">{logoutError}</p>}
              </div>
              <div className="settings-row-control">
                <ConfigButton variant="secondary" disabled={loggingOut} onClick={() => void logOut()}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10 17l5-5-5-5M15 12H3M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  </svg>
                  {loggingOut ? t("auth.loggingOut") : t("auth.logOut")}
                </ConfigButton>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 原生 General 提供的独占维护卡片宿主（React 拥有且无孩子） */}
      <MaintenanceHost
        onClose={onClose}
        activateSection={activateSection}
        availableSections={availableSections}
        cwd={cwd}
        sessionId={sessionId}
      />
    </div>
  );
}

function ExtensionSectionHost({ definition, ...props }: SettingsHostContextProps & {
  definition: SettingsExtensionDefinition;
}) {
  return (
    <div className="settings-extension-host-container">
      <IsolatedSettingsHost {...props} id={definition.id} sectionId={definition.id}
        className={`settings-extension-host settings-${definition.id}-host`} showLoading fill />
    </div>
  );
}

export function SettingsPanel({
  resolveReturnFocus,
  cwd,
  sessionId,
  initialSection,
  onClose,
  onSessionReloaded,
  quoteSelectionEnabled,
  onQuoteSelectionChange,
  projectTrust,
  onOpenTrustDialog,
  onProjectTrustChanged,
}: Props) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const panel = dialogRef.current;
    // Keep the original opener across StrictMode's setup/cleanup replay.
    returnFocusRef.current ??= focusModalPanel(document, panel, {
      restoreTextEntry: !window.matchMedia?.("(pointer: coarse)").matches,
      resolveReturnFocus,
    });
    return () => {
      // Composer CSS hides it while the modal exists. Restore after React's
      // removal commit, when it is focusable again, without a timer or poll.
      queueMicrotask(() => {
        if (panel?.isConnected) return;
        returnFocusRef.current?.();
        returnFocusRef.current = null;
      });
    };
  }, []);

  // 1. 同步初始布局状态（0ms 首次 client render 取得，无跳变）
  const [layout, setLayout] = useState<SettingsLayoutState>(() => readInitialSettingsLayout());
  const [isResizing, setIsResizing] = useState(false);

  // 拖动状态 ref：记录开始位置和初始尺寸，供取消时回滚
  const resizingStateRef = useRef<{
    kind: "sidebar" | "east" | "south" | "se";
    startX: number;
    startY: number;
    initialSidebarWidth: number;
    initialDialogSize: SettingsDialogSize;
  } | null>(null);

  // 2. 扩展偏好响应与 sections 列表
  const [extVersion, setExtVersion] = useState(0);

  useEffect(() => {
    return settingsExtensionRegistry.subscribePreferences(() => {
      setExtVersion((v) => v + 1);
    });
  }, []);

  const enabledExtensions = useMemo(() => {
    return LEGACY_SETTINGS_EXTENSIONS.filter((ext) => isExtensionEnabled(ext));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extVersion]);

  const nativeSections: { id: SettingsSection; label: string; requiresProject: boolean }[] = useMemo(
    () => [
      { id: "general", label: t("settings.general"), requiresProject: false },
      { id: "models", label: t("common.models"), requiresProject: false },
      { id: "skills", label: t("common.skills"), requiresProject: true },
      { id: "agents", label: t("common.agents"), requiresProject: true },
      { id: "plugins", label: t("common.plugins"), requiresProject: true },
      { id: "mcp", label: t("settings.mcp"), requiresProject: false },
    ],
    [t],
  );

  const sections = useMemo(() => {
    return [
      ...nativeSections,
      ...enabledExtensions.map((ext) => ({
        id: ext.id as SettingsSection,
        label: ext.label,
        requiresProject: ext.requiresProject,
        legacyTabAttr: ext.legacyTabAttr,
      })),
    ];
  }, [nativeSections, enabledExtensions]);

  // 三类分组结构（常规设置、Agent与扩展、数据与记录）
  const groupedSections = useMemo(() => {
    return SETTINGS_NAV_GROUPS.map((group) => {
      const items = sections.filter((s) => {
        if (group.sectionIds.includes(s.id)) return true;
        if (group.id === "agent") {
          const inOtherGroup = SETTINGS_NAV_GROUPS[0].sectionIds.includes(s.id) || SETTINGS_NAV_GROUPS[2].sectionIds.includes(s.id);
          return !inOtherGroup;
        }
        return false;
      });
      return {
        ...group,
        label: t(group.titleKey),
        items,
      };
    }).filter((g) => g.items.length > 0);
  }, [sections, t]);

  // 3. 导航与激活状态
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [mountedSections, setMountedSections] = useState<ReadonlySet<SettingsSection>>(
    () => new Set([section]),
  );

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  useEffect(() => setLastSettingsSection(initialSection), [initialSection]);

  const activateSection = useCallback(
    (nextSection: SettingsSection): boolean => {
      const target = sectionsRef.current.find((s) => s.id === nextSection);
      if (!target) return false;
      if (target.requiresProject && !cwdRef.current) return false;

      setMountedSections((current) => new Set(current).add(nextSection));
      setSection(nextSection);
      setLastSettingsSection(nextSection);
      return true;
    },
    [],
  );

  const activateSectionById = useCallback(
    (id: string): boolean => {
      return activateSection(id as SettingsSection);
    },
    [activateSection],
  );

  // 4. 注册 Modal Runtime 到 ABI
  useEffect(() => {
    settingsExtensionRegistry.setModalRuntime({
      activateSection: (id) => activateSectionById(id),
      getActiveSection: () => section,
      isModalOpen: () => true,
      onRendererRegistered: (id) => {
        if (id === section) {
          setMountedSections((current) => new Set(current).add(id as SettingsSection));
        }
      },
    });

    return () => {
      settingsExtensionRegistry.setModalRuntime(null);
    };
  }, [section, activateSectionById]);

  // 5. 键盘 Escape 关闭
  useEffect(() => listenForPanelEscape(document, onClose), [onClose]);

  // 6. Project 缺失或被禁用的扩展自动回退
  useEffect(() => {
    const isProjectReq =
      section === "skills" || section === "agents" || section === "plugins";
    if (isProjectReq && !cwd) {
      activateSection("general");
      return;
    }

    const isExt = LEGACY_SETTINGS_EXTENSIONS.some((e) => e.id === section);
    if (isExt && !enabledExtensions.some((e) => e.id === section)) {
      activateSection("general");
    }
  }, [cwd, section, enabledExtensions, activateSection]);

  // 7. 折叠切换（纯 CSS 过渡，无多余状态）
  const toggleCollapse = useCallback(() => {
    setLayout((prev) => {
      const nextCollapsed = !prev.isCollapsed;
      saveSidebarCollapsed(nextCollapsed);
      return { ...prev, isCollapsed: nextCollapsed };
    });
  }, []);

  // 8. 拖动 Pointer Capture 处理
  const handleSidebarPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || layout.isCollapsed) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    setIsResizing(true);
    resizingStateRef.current = {
      kind: "sidebar",
      startX: e.clientX,
      startY: e.clientY,
      initialSidebarWidth: layout.sidebarWidth,
      initialDialogSize: { ...layout.dialogSize },
    };
  };

  const handleSidebarDoubleClick = () => {
    if (layout.isCollapsed) return;
    setLayout((prev) => ({ ...prev, sidebarWidth: SETTINGS_SIDEBAR_WIDTH_DEFAULT }));
    saveSidebarWidth(SETTINGS_SIDEBAR_WIDTH_DEFAULT);
  };

  const handleSidebarKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (layout.isCollapsed) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      const next = clampSidebarWidth(layout.sidebarWidth - 16);
      setLayout((prev) => ({ ...prev, sidebarWidth: next }));
      saveSidebarWidth(next);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = clampSidebarWidth(layout.sidebarWidth + 16);
      setLayout((prev) => ({ ...prev, sidebarWidth: next }));
      saveSidebarWidth(next);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSidebarDoubleClick();
    } else if (e.key === "Home") {
      e.preventDefault();
      const next = SETTINGS_SIDEBAR_WIDTH_MIN;
      setLayout((prev) => ({ ...prev, sidebarWidth: next }));
      saveSidebarWidth(next);
    } else if (e.key === "End") {
      e.preventDefault();
      const next = SETTINGS_SIDEBAR_WIDTH_MAX;
      setLayout((prev) => ({ ...prev, sidebarWidth: next }));
      saveSidebarWidth(next);
    }
  };

  const handleDialogPointerDown = (
    kind: "east" | "south" | "se",
    e: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    setIsResizing(true);
    resizingStateRef.current = {
      kind,
      startX: e.clientX,
      startY: e.clientY,
      initialSidebarWidth: layout.sidebarWidth,
      initialDialogSize: { ...layout.dialogSize },
    };
  };

  const handleDialogDoubleClick = () => {
    const defaultSize = clampDialogSize({
      width: SETTINGS_DIALOG_WIDTH_DEFAULT,
      height: SETTINGS_DIALOG_HEIGHT_DEFAULT,
    });
    setLayout((prev) => ({ ...prev, dialogSize: defaultSize }));
    saveDialogSize(defaultSize);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizingStateRef.current;
    if (!state) return;
    if (state.kind === "sidebar") {
      const deltaX = e.clientX - state.startX;
      const nextWidth = clampSidebarWidth(state.initialSidebarWidth + deltaX);
      setLayout((prev) => ({ ...prev, sidebarWidth: nextWidth }));
    } else {
      const deltaX = e.clientX - state.startX;
      const deltaY = e.clientY - state.startY;
      if (state.kind === "east") {
        const nextSize = clampDialogSize({
          width: state.initialDialogSize.width + deltaX * 2,
          height: state.initialDialogSize.height,
        });
        setLayout((prev) => ({ ...prev, dialogSize: nextSize }));
      } else if (state.kind === "south") {
        const nextSize = clampDialogSize({
          width: state.initialDialogSize.width,
          height: state.initialDialogSize.height + deltaY * 2,
        });
        setLayout((prev) => ({ ...prev, dialogSize: nextSize }));
      } else if (state.kind === "se") {
        const nextSize = clampDialogSize({
          width: state.initialDialogSize.width + deltaX * 2,
          height: state.initialDialogSize.height + deltaY * 2,
        });
        setLayout((prev) => ({ ...prev, dialogSize: nextSize }));
      }
    }
  };

  // 正常 pointerup 保存尺寸
  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizingStateRef.current;
    if (!state) return;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {}
    setIsResizing(false);
    resizingStateRef.current = null;

    if (state.kind === "sidebar") {
      saveSidebarWidth(layout.sidebarWidth);
    } else {
      saveDialogSize(layout.dialogSize);
    }
  };

  // pointercancel 恢复初始尺寸，绝对不保存
  const handlePointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = resizingStateRef.current;
    if (!state) return;
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    } catch {}
    setIsResizing(false);
    resizingStateRef.current = null;

    // 恢复到拖拽开始时的尺寸
    if (state.kind === "sidebar") {
      setLayout((prev) => ({ ...prev, sidebarWidth: state.initialSidebarWidth }));
    } else {
      setLayout((prev) => ({ ...prev, dialogSize: state.initialDialogSize }));
    }
  };

  const handleLostPointerCapture = () => {
    if (resizingStateRef.current) {
      setIsResizing(false);
      resizingStateRef.current = null;
    }
  };

  const handleDialogResizerKeyDown = (
    kind: "east" | "south" | "se",
    e: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    const step = 20;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (kind === "east" || kind === "se") {
        const next = clampDialogSize({ width: layout.dialogSize.width - step, height: layout.dialogSize.height });
        setLayout((prev) => ({ ...prev, dialogSize: next }));
        saveDialogSize(next);
      }
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (kind === "east" || kind === "se") {
        const next = clampDialogSize({ width: layout.dialogSize.width + step, height: layout.dialogSize.height });
        setLayout((prev) => ({ ...prev, dialogSize: next }));
        saveDialogSize(next);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (kind === "south" || kind === "se") {
        const next = clampDialogSize({ width: layout.dialogSize.width, height: layout.dialogSize.height - step });
        setLayout((prev) => ({ ...prev, dialogSize: next }));
        saveDialogSize(next);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (kind === "south" || kind === "se") {
        const next = clampDialogSize({ width: layout.dialogSize.width, height: layout.dialogSize.height + step });
        setLayout((prev) => ({ ...prev, dialogSize: next }));
        saveDialogSize(next);
      }
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleDialogDoubleClick();
    }
  };

  // 9. 渲染 Section 宿主
  const sectionHost = (id: SettingsSection, content: ReactNode) =>
    mountedSections.has(id) ? (
      <div key={id} hidden={section !== id} className="settings-section-host" data-section-id={id}>
        {content}
      </div>
    ) : null;

  const availableSectionIds = useMemo(() => sections.map((s) => s.id), [sections]);

  const dialogStyle: CSSProperties = {
    "--settings-sidebar-width": `${layout.isCollapsed ? SETTINGS_SIDEBAR_WIDTH_COLLAPSED : layout.sidebarWidth}px`,
    "--settings-dialog-width": `${layout.dialogSize.width}px`,
    "--settings-dialog-height": `${layout.dialogSize.height}px`,
  } as CSSProperties;

  const surfaceClassName = [
    "settings-dialog-surface",
    layout.isCollapsed ? "is-collapsed" : "",
    isResizing ? "is-resizing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="settings-dialog-backdrop"
    >
      <div className={surfaceClassName} style={dialogStyle}>
        {/* 侧边栏（包含标题行与折叠按钮、竖向导航栏；在 mobile <= 640px 时作为顶部 header） */}
        <header className="settings-dialog-header">
          <div className="settings-dialog-title">
            <span className="settings-dialog-title-text">{t("settings.title")}</span>
            <button
              type="button"
              className="settings-sidebar-collapse-btn"
              onClick={toggleCollapse}
              title={layout.isCollapsed ? "展开标签栏" : "折叠标签栏 (只显示图标)"}
              aria-label={layout.isCollapsed ? "展开标签栏" : "折叠标签栏"}
              aria-expanded={!layout.isCollapsed}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect width="18" height="18" x="3" y="3" rx="2.5" />
                <path d="M9 3v18" />
              </svg>
            </button>
          </div>

          <select
            aria-label={t("settings.title")}
            value={section}
            onChange={(event) => activateSection(event.target.value as SettingsSection)}
            className="settings-mobile-section-picker"
          >
            {groupedSections.map((group) => (
              <optgroup key={group.id} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.id} value={item.id} disabled={item.requiresProject && !cwd}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <nav aria-label={t("settings.title")} className="settings-section-tabs">
            {groupedSections.map((group) => (
              <div key={group.id} className="settings-nav-group">
                <div className="settings-nav-group-title" title={group.label}>
                  <span>{group.label}</span>
                </div>
                <div className="settings-nav-group-items">
                  {group.items.map((item) => {
                    const selected = section === item.id;
                    const disabled = item.requiresProject && !cwd;
                    const legacyTabAttr = "legacyTabAttr" in item ? item.legacyTabAttr : undefined;
                    return (
                      <div key={item.id} className="settings-section-tab-row">
                        <button
                          type="button"
                          className="settings-section-tab"
                          disabled={disabled}
                          title={disabled ? t("settings.projectRequired") : isSettingsPluginEnabled("settings-tab-shortcuts") ? `${item.label}（双击添加／取消快捷入口）` : item.label}
                          aria-current={selected ? "page" : undefined}
                          data-section-id={item.id}
                          data-pi-enh-tab={legacyTabAttr}
                          onClick={() => activateSection(item.id)}
                          onDoubleClick={() => settingsExtensionRegistry.invokeTabAction(item.id)}
                          onPointerEnter={() => { if (!disabled) preloadSettingsSection(item.id); }}
                          onFocus={() => { if (!disabled) preloadSettingsSection(item.id); }}
                        >
                          <SettingsSectionIcon section={item.id} />
                          <span>{item.label}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </header>

        {/* 侧边栏拖拽手柄（带 pointer capture 和键盘控制） */}
        <div
          className="settings-sidebar-resizer"
          onPointerDown={handleSidebarPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handleLostPointerCapture}
          onDoubleClick={handleSidebarDoubleClick}
          onKeyDown={handleSidebarKeyDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuenow={layout.sidebarWidth}
          aria-valuemin={SETTINGS_SIDEBAR_WIDTH_MIN}
          aria-valuemax={SETTINGS_SIDEBAR_WIDTH_MAX}
          tabIndex={0}
        >
          <div className="settings-sidebar-resizer-line" />
        </div>

        {/* 关闭按钮占用独立布局行，不覆盖可滚动的设置控件。 */}
        <div className="settings-dialog-toolbar">
          <button
          type="button"
          onClick={onClose}
          title={t("i18n.close")}
          aria-label={t("i18n.close")}
          className="config-close-button settings-dialog-close"
        >
          ×
          </button>
        </div>

        {/* 主内容区域 */}
        <main className="settings-dialog-main">
          {sectionHost(
            "general",
            <GeneralSettings
              sessionId={sessionId}
              onSessionReloaded={onSessionReloaded}
              quoteSelectionEnabled={quoteSelectionEnabled}
              onQuoteSelectionChange={onQuoteSelectionChange}
              onClose={onClose}
              activateSection={activateSectionById}
              availableSections={availableSectionIds}
              cwd={cwd}
            />,
          )}
          {sectionHost("models", <ModelsConfig embedded cwd={cwd} onClose={onClose} />)}
          {cwd &&
            sectionHost(
              "skills",
              <SkillsConfig embedded key={cwd} cwd={cwd} trust={projectTrust} onClose={onClose} />,
            )}
          {cwd &&
            sectionHost(
              "agents",
              <AgentsConfig embedded key={cwd} cwd={cwd} trust={projectTrust} sessionId={sessionId} onClose={onClose} onReloaded={onSessionReloaded} />,
            )}
          {cwd &&
            sectionHost(
              "plugins",
              <PluginsConfig embedded key={cwd} cwd={cwd} trust={projectTrust} sessionId={sessionId} onClose={onClose} onReloaded={onSessionReloaded} />,
            )}
          {sectionHost("mcp", <McpConfig embedded key={cwd ?? ""} cwd={cwd} trust={projectTrust} onTrustProject={onOpenTrustDialog} onProjectTrustChanged={onProjectTrustChanged} onClose={onClose} />)}

          {/* 5 个 legacy extension section host */}
          {enabledExtensions.map((ext) =>
            sectionHost(
              ext.id,
              <ExtensionSectionHost
                key={ext.id}
                definition={ext}
                onClose={onClose}
                activateSection={activateSectionById}
                availableSections={availableSectionIds}
                cwd={cwd}
                sessionId={sessionId}
              />,
            ),
          )}
        </main>



        {/* 弹窗尺寸缩放手柄（东、南、东南），支持 pointer 与键盘 */}
        <div
          className="settings-dialog-resizer settings-dialog-resizer-east"
          onPointerDown={(e) => handleDialogPointerDown("east", e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handleLostPointerCapture}
          onDoubleClick={handleDialogDoubleClick}
          onKeyDown={(e) => handleDialogResizerKeyDown("east", e)}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize settings dialog width"
          tabIndex={0}
        />
        <div
          className="settings-dialog-resizer settings-dialog-resizer-south"
          onPointerDown={(e) => handleDialogPointerDown("south", e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handleLostPointerCapture}
          onDoubleClick={handleDialogDoubleClick}
          onKeyDown={(e) => handleDialogResizerKeyDown("south", e)}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize settings dialog height"
          tabIndex={0}
        />
        <div
          className="settings-dialog-resizer settings-dialog-resizer-se"
          onPointerDown={(e) => handleDialogPointerDown("se", e)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onLostPointerCapture={handleLostPointerCapture}
          onDoubleClick={handleDialogDoubleClick}
          onKeyDown={(e) => handleDialogResizerKeyDown("se", e)}
          role="separator"
          aria-label="Resize settings dialog size"
          aria-valuenow={layout.dialogSize.width}
          aria-valuemin={SETTINGS_DIALOG_WIDTH_MIN}
          tabIndex={0}
        >
          <svg
            className="settings-dialog-resizer-grip"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <line x1="8" y1="2" x2="2" y2="8" />
            <line x1="9" y1="5" x2="5" y2="9" />
            <line x1="9" y1="8" x2="8" y2="9" />
          </svg>
        </div>
      </div>
    </div>
  );
}
