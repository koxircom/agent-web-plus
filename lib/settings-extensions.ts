import { SETTINGS_SECTION_VALUES, type SettingsSection } from "./settings-navigation";
import {
  createFastPluginReader,
  ENHANCEMENT_METADATA,
  type StorageGetter,
} from "./enhancement-settings.generated";

export type SettingsExtensionId =
  | "enhancements"
  | "notifications"
  | "archived"
  | "usage"
  | "tags";

export interface SettingsExtensionDefinition {
  id: SettingsExtensionId;
  label: string;
  pluginId?: string;
  legacyTabAttr: string;
  requiresProject: boolean;
}

export const LEGACY_SETTINGS_EXTENSIONS: readonly SettingsExtensionDefinition[] = [
  {
    id: "enhancements",
    label: "增强插件",
    legacyTabAttr: "plugins",
    requiresProject: false,
  },
  {
    id: "archived",
    label: "已归档",
    pluginId: "session-pin-archive",
    legacyTabAttr: "archived",
    requiresProject: false,
  },
  {
    id: "notifications",
    label: "通知管理",
    pluginId: "notification-center",
    legacyTabAttr: "notifications",
    requiresProject: false,
  },
  {
    id: "usage",
    label: "用量统计",
    pluginId: "usage-cost-dashboard",
    legacyTabAttr: "usage",
    requiresProject: false,
  },
  {
    id: "tags",
    label: "会话标签",
    pluginId: "session-tags",
    legacyTabAttr: "tags",
    requiresProject: false,
  },
] as const;

const readBrowserPluginPreference = createFastPluginReader((key) => {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}, ENHANCEMENT_METADATA);

export function isSettingsPluginEnabled(pluginId: string, storageGetter?: StorageGetter): boolean {
  return storageGetter
    ? createFastPluginReader(storageGetter, ENHANCEMENT_METADATA)(pluginId)
    : readBrowserPluginPreference(pluginId);
}

export function isExtensionEnabled(
  def: SettingsExtensionDefinition,
  storageGetter?: StorageGetter,
): boolean {
  return !def.pluginId || isSettingsPluginEnabled(def.pluginId, storageGetter);
}

export type SettingsExtensionCleanup = () => void;

export interface SettingsExtensionContext {
  onClose: () => void;
  activateSection: (id: string) => boolean;
  nav: Readonly<{
    currentSection: string;
    availableSections: readonly string[];
    cwd: string | null;
    sessionId: string | null;
  }>;
}

export type SettingsExtensionMount = (
  host: HTMLElement,
  context: SettingsExtensionContext,
) => SettingsExtensionCleanup | void;

export interface SettingsShortcut {
  id: SettingsSection;
  label: string;
}

export interface SettingsNativeAbi {
  setSidebarShortcuts(shortcuts: readonly { id: string; label: string }[] | null): void;
  registerRenderer(id: string, mount: SettingsExtensionMount): () => void;
  registerTabAction(id: string, action: () => void): () => void;
  invokeTabAction(id: string): boolean;
  notifyPreferencesChanged(): void;
  activateSection(id: string): boolean;
  getActiveSection(): string | null;
  isModalOpen(): boolean;
}

declare global {
  interface Window {
    __PI_WEB_SETTINGS_NATIVE__?: SettingsNativeAbi;
  }
}

type PreferenceListener = () => void;
type RendererChangeListener = (id: string) => void;
type RendererMap = Map<string, SettingsExtensionMount>;

interface ModalRuntime {
  activateSection(id: string): boolean;
  getActiveSection(): string | null;
  isModalOpen(): boolean;
  onRendererRegistered(id: string): void;
}

class SettingsExtensionRegistry {
  private renderers: RendererMap = new Map();
  private tabActions = new Map<string, () => void>();
  private preferenceListeners: Set<PreferenceListener> = new Set();
  private rendererListeners: Set<RendererChangeListener> = new Set();
  private currentModal: ModalRuntime | null = null;
  private readyDispatched = false;
  private sidebarShortcuts: readonly SettingsShortcut[] | null = null;
  private shortcutListeners = new Set<() => void>();

  public getSidebarShortcuts = (): readonly SettingsShortcut[] | null => this.sidebarShortcuts;

  public subscribeSidebarShortcuts = (listener: () => void): (() => void) => {
    this.shortcutListeners.add(listener);
    return () => { this.shortcutListeners.delete(listener); };
  };

  public setSidebarShortcuts(shortcuts: readonly { id: string; label: string }[] | null): void {
    const seen = new Set<string>();
    const normalized: SettingsShortcut[] = [];
    for (const item of shortcuts ?? []) {
      const id = item?.id === "settings" ? "general" : item?.id;
      if (!SETTINGS_SECTION_VALUES.includes(id as SettingsSection) || seen.has(id)) continue;
      seen.add(id);
      normalized.push({ id: id as SettingsSection, label: typeof item.label === "string" ? item.label : id });
    }
    const next = shortcuts === null ? null : normalized;
    if (JSON.stringify(next) === JSON.stringify(this.sidebarShortcuts)) return;
    this.sidebarShortcuts = next;
    for (const listener of this.shortcutListeners) listener();
  }

  constructor() {
    this.ensureWindowAbi();
  }

  public registerRenderer(id: string, mount: SettingsExtensionMount): () => void {
    this.renderers.set(id, mount);
    if (this.currentModal) {
      this.currentModal.onRendererRegistered(id);
    }
    this.notifyRendererChanged(id);
    return () => {
      if (this.renderers.get(id) === mount) {
        this.renderers.delete(id);
        this.notifyRendererChanged(id);
      }
    };
  }

  public registerTabAction(id: string, action: () => void): () => void {
    this.tabActions.set(id, action);
    return () => {
      if (this.tabActions.get(id) === action) this.tabActions.delete(id);
    };
  }

  public invokeTabAction(id: string): boolean {
    const action = this.tabActions.get(id);
    if (!action || !isSettingsPluginEnabled("settings-tab-shortcuts")) return false;
    action();
    return true;
  }

  public getRenderer(id: string): SettingsExtensionMount | undefined {
    return this.renderers.get(id);
  }

  public subscribeRenderer(id: string, listener: () => void): () => void {
    const handler: RendererChangeListener = (changedId) => {
      if (changedId === id || changedId === "*") {
        listener();
      }
    };
    this.rendererListeners.add(handler);
    return () => {
      this.rendererListeners.delete(handler);
    };
  }

  public subscribeAllRenderers(listener: (id: string) => void): () => void {
    this.rendererListeners.add(listener);
    return () => {
      this.rendererListeners.delete(listener);
    };
  }

  private notifyRendererChanged(id: string): void {
    for (const listener of this.rendererListeners) {
      try {
        listener(id);
      } catch (err) {
        console.error("Error in settings renderer listener:", err);
      }
    }
  }

  public notifyPreferencesChanged(): void {
    for (const listener of this.preferenceListeners) {
      try {
        listener();
      } catch (err) {
        console.error("Error in settings preference listener:", err);
      }
    }
  }

  public subscribePreferences(listener: PreferenceListener): () => void {
    this.preferenceListeners.add(listener);
    return () => {
      this.preferenceListeners.delete(listener);
    };
  }

  public setModalRuntime(modal: ModalRuntime | null): void {
    this.currentModal = modal;
  }

  public activateSection(id: string): boolean {
    if (!this.currentModal) return false;
    return this.currentModal.activateSection(id);
  }

  public getActiveSection(): string | null {
    if (!this.currentModal) return null;
    return this.currentModal.getActiveSection();
  }

  public isModalOpen(): boolean {
    return Boolean(this.currentModal && this.currentModal.isModalOpen());
  }

  public ensureWindowAbi(): SettingsNativeAbi | null {
    if (typeof window === "undefined") return null;

    const abi: SettingsNativeAbi = {
      setSidebarShortcuts: (shortcuts) => this.setSidebarShortcuts(shortcuts),
      registerRenderer: (id, mount) => this.registerRenderer(id, mount),
      registerTabAction: (id, action) => this.registerTabAction(id, action),
      invokeTabAction: (id) => this.invokeTabAction(id),
      notifyPreferencesChanged: () => this.notifyPreferencesChanged(),
      activateSection: (id) => this.activateSection(id),
      getActiveSection: () => this.getActiveSection(),
      isModalOpen: () => this.isModalOpen(),
    };

    window.__PI_WEB_SETTINGS_NATIVE__ = abi;

    if (!this.readyDispatched) {
      this.readyDispatched = true;
      try {
        window.dispatchEvent(new CustomEvent("pi-web:settings-native-ready", { detail: abi }));
      } catch {}
    }

    return abi;
  }
}

export const settingsExtensionRegistry = new SettingsExtensionRegistry();
