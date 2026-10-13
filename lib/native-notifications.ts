import { isEnhancementPluginFastActive } from "./enhancement-settings.generated.ts";

export const NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY =
  "pi-enh-notification-settings-v1";
export const NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY =
  "pi-enh-notification-history-v1";
export const NATIVE_NOTIFICATION_HISTORY_LIMIT = 100;
export const NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT =
  "pi-native-notification-policy-change";

export type NativeNotificationType = "info" | "success" | "warning" | "error";

export interface NativeNotificationChannel {
  id: string;
  name: string;
  desc: string;
  group: string;
  defaultEnabled: boolean;
}

export interface NativeNotificationHistoryItem {
  id: string;
  sourceId?: string;
  timestamp: number;
  message: string;
  type: string;
  channel: string;
  settingId: string;
  suppressed: boolean;
}

export interface NativeNotificationInput {
  id: string;
  message: string;
  type: NativeNotificationType | string;
}

export interface NativeNotificationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NativeNotificationWindow {
  localStorage?: NativeNotificationStorage | null;
  __PI_NATIVE_NOTIFICATION_POLICY__?: NativeNotificationPolicy;
}

export interface NativeNotificationPolicy {
  readonly version: 1;
  readonly changeEvent: string;
  readonly channels: readonly NativeNotificationChannel[];
  getSettings(): Record<string, boolean>;
  isEnabled(settingId: string): boolean;
  isNotificationCenterEnabled(): boolean;
  isNativeNotificationEnabled(message: string, type?: string): boolean;
  admitNativeNotification(input: NativeNotificationInput): boolean;
  classify(message: string, type?: string, channel?: string): string;
  record(
    message: string,
    type?: string,
    channel?: string,
    settingId?: string | null,
  ): boolean;
  setEnabled(settingId: string, enabled: boolean): boolean;
  reset(): void;
  history(): NativeNotificationHistoryItem[];
  clearHistory(): void;
}

export interface CreateNativeNotificationPolicyOptions {
  targetWindow?: NativeNotificationWindow | null;
  isNotificationCenterEnabled?: () => boolean;
  now?: () => number;
  createId?: () => string;
}

export const NATIVE_NOTIFICATION_CHANNELS: readonly NativeNotificationChannel[] =
  Object.freeze([
    {
      id: "session-title",
      name: "会话标题自动提炼",
      desc: "会话标题被 AI 自动提炼并修改时提示。",
      group: "日常提示",
      defaultEnabled: false,
    },
    {
      id: "mcp",
      name: "MCP 工具与连接提示",
      desc: "MCP 工具注册、重新加载、连接失败或配置错误提示。",
      group: "日常提示",
      defaultEnabled: false,
    },
    {
      id: "native-info",
      name: "普通信息提示",
      desc: "其他 info 级别的 Agent 扩展通知。",
      group: "日常提示",
      defaultEnabled: false,
    },
    {
      id: "native-success",
      name: "成功提示",
      desc: "操作成功或服务完成时的 success 通知。",
      group: "日常提示",
      defaultEnabled: true,
    },
    {
      id: "native-warning",
      name: "警告提示",
      desc: "warning 级别的服务或配置告警。",
      group: "异常与安全",
      defaultEnabled: true,
    },
    {
      id: "native-error",
      name: "错误提示",
      desc: "error 级别的故障提示，建议保持开启。",
      group: "异常与安全",
      defaultEnabled: true,
    },
    {
      id: "security-guard",
      name: "安全拦截与防护",
      desc: "WSL、NAS、Pi Web 重启及超时看门狗等高危操作拦截提示。",
      group: "异常与安全",
      defaultEnabled: true,
    },
    {
      id: "enhancement-toast",
      name: "网页增强操作提示",
      desc: "复制、归档、缓存、插件切换等网页操作的轻量提示。",
      group: "网页提醒",
      defaultEnabled: true,
    },
    {
      id: "attention-sound",
      name: "审批提示音",
      desc: "后台任务等待人工处理时播放提示音。",
      group: "后台任务",
      defaultEnabled: true,
    },
    {
      id: "attention-desktop",
      name: "桌面待处理通知",
      desc: "后台任务需要处理时发送浏览器/系统桌面通知。",
      group: "后台任务",
      defaultEnabled: false,
    },
  ]);

const MAX_TRACKED_NOTIFICATION_IDS = 256;

interface NativeNotificationEventTarget {
  addEventListener?: (
    type: string,
    listener: (event: { key: string | null }) => void,
  ) => void;
  dispatchEvent?: (event: Event) => boolean;
}

function getBrowserWindow(): NativeNotificationWindow | null {
  try {
    if (typeof window !== "undefined" && window && typeof window === "object") {
      return window as unknown as NativeNotificationWindow;
    }
  } catch {
    // A restricted or unavailable browser global must not block a notification.
  }
  return null;
}

function makeDefaults(): Record<string, boolean> {
  return Object.fromEntries(
    NATIVE_NOTIFICATION_CHANNELS.map(({ id, defaultEnabled }) => [
      id,
      defaultEnabled,
    ]),
  );
}

function getChannel(settingId: string): NativeNotificationChannel | undefined {
  return NATIVE_NOTIFICATION_CHANNELS.find(
    (channel) => channel.id === settingId,
  );
}

export function classifyNativeNotification(
  message: string,
  type = "info",
  channel = "native",
): string {
  const text = String(message || "");
  if (channel === "toast") return "enhancement-toast";
  if (channel === "attention-sound") return "attention-sound";
  if (channel === "attention-desktop") return "attention-desktop";
  if (/会话标题(?:已自动提炼|自动提炼)/i.test(text)) return "session-title";
  if (
    /\bMCP\b|Registered\s+\d+\s+tool|MCP tools|工具.*(?:注册|重新加载)|(?:注册|重新加载).*工具/i.test(
      text,
    )
  ) {
    return "mcp";
  }
  if (
    /已(?:物理)?拦截|WSL|NAS|Pi Web.*(?:杀死|重启|高危)|看门狗|超时兜底/i.test(
      text,
    )
  ) {
    return "security-guard";
  }
  if (type === "error") return "native-error";
  if (type === "warning") return "native-warning";
  if (type === "success") return "native-success";
  return "native-info";
}

function parseSettings(raw: string | null): Record<string, boolean> {
  const settings = makeDefaults();
  if (!raw) return settings;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return settings;
    const value = parsed as { schemaVersion?: unknown; channels?: unknown };
    if (
      value.schemaVersion !== 1 ||
      !value.channels ||
      typeof value.channels !== "object"
    )
      return settings;
    const channels = value.channels as Record<string, unknown>;
    for (const { id } of NATIVE_NOTIFICATION_CHANNELS) {
      if (typeof channels[id] === "boolean")
        settings[id] = channels[id] as boolean;
    }
  } catch {
    // Invalid persisted preferences use the safe documented defaults.
  }
  return settings;
}

function parseHistory(raw: string | null): NativeNotificationHistoryItem[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .slice(0, NATIVE_NOTIFICATION_HISTORY_LIMIT)
      .filter((item): item is NativeNotificationHistoryItem => {
        return Boolean(
          item && typeof item === "object" && typeof item.message === "string",
        );
      });
  } catch {
    return [];
  }
}

function makeHistoryId(now: number): string {
  return `${now}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createNativeNotificationPolicy(
  options: CreateNativeNotificationPolicyOptions = {},
): NativeNotificationPolicy {
  const targetWindow = options.targetWindow ?? getBrowserWindow();
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => makeHistoryId(now()));
  let cachedSettings: Record<string, boolean> | null = null;
  let cachedSettingsRaw: string | null | undefined;
  let cachedHistory: NativeNotificationHistoryItem[] | null = null;
  let cachedHistoryRaw: string | null | undefined;
  const handledNativeIds = new Set<string>();
  const handledNativeOrder: string[] = [];
  const eventTarget = targetWindow as
    | (NativeNotificationWindow & NativeNotificationEventTarget)
    | null
    | undefined;

  const dispatchPolicyChange = (): void => {
    try {
      if (typeof eventTarget?.dispatchEvent !== "function") return;
      const event =
        typeof CustomEvent === "function"
          ? new CustomEvent(NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT)
          : new Event(NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT);
      eventTarget.dispatchEvent(event);
    } catch {
      // Policy changes remain applied if a host cannot dispatch DOM events.
    }
  };

  const getStorage = (): NativeNotificationStorage | null => {
    try {
      const storage = targetWindow?.localStorage;
      if (
        storage &&
        typeof storage.getItem === "function" &&
        typeof storage.setItem === "function"
      )
        return storage;
    } catch {
      // Storage access is optional; notifications must still render.
    }
    return null;
  };

  const writeRaw = (key: string, raw: string): boolean => {
    try {
      const storage = getStorage();
      if (!storage) return false;
      storage.setItem(key, raw);
      return true;
    } catch {
      return false;
    }
  };

  try {
    eventTarget?.addEventListener?.("storage", (event) => {
      if (event.key === NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY || event.key === null)
        cachedHistoryRaw = undefined;
      if (
        event.key !== NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY &&
        event.key !== null
      )
        return;
      cachedSettingsRaw = undefined;
      dispatchPolicyChange();
    });
  } catch {
    // Cross-tab synchronization is optional when the host has no event target.
  }

  const getSettingsInternal = (): Record<string, boolean> => {
    if (cachedSettings && cachedSettingsRaw !== undefined)
      return cachedSettings;
    const storage = getStorage();
    let raw: string | null = null;
    let readSucceeded = false;
    try {
      raw = storage?.getItem(NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY) ?? null;
      readSucceeded = Boolean(storage);
    } catch {
      // Fall back to defaults and retry the read on the next policy event.
    }
    if (cachedSettings && readSucceeded && raw === cachedSettingsRaw)
      return cachedSettings;
    cachedSettingsRaw = readSucceeded ? raw : undefined;
    cachedSettings = parseSettings(raw);
    if (readSucceeded && raw === null) {
      const serialized = JSON.stringify({
        schemaVersion: 1,
        channels: cachedSettings,
      });
      if (writeRaw(NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY, serialized))
        cachedSettingsRaw = serialized;
    }
    return cachedSettings;
  };

  const isNotificationCenterEnabled = (): boolean => {
    try {
      return options.isNotificationCenterEnabled
        ? options.isNotificationCenterEnabled()
        : isEnhancementPluginFastActive("notification-center");
    } catch {
      return true;
    }
  };

  const isEnabled = (settingId: string): boolean => {
    const channel = getChannel(settingId);
    if (!channel) return true;
    return getSettingsInternal()[settingId] !== false;
  };

  const readHistoryInternal = (): NativeNotificationHistoryItem[] => {
    if (cachedHistory && cachedHistoryRaw !== undefined) return cachedHistory;
    let raw: string | null = null;
    let readSucceeded = false;
    try {
      const storage = getStorage();
      raw = storage?.getItem(NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY) ?? null;
      readSucceeded = Boolean(storage);
    } catch {
      // A history read failure must not change notification admission.
    }
    if (cachedHistory && readSucceeded && raw === cachedHistoryRaw)
      return cachedHistory;
    cachedHistoryRaw = readSucceeded ? raw : undefined;
    cachedHistory = parseHistory(raw);
    for (const item of cachedHistory) {
      if (typeof item.sourceId === "string" && item.sourceId)
        rememberNativeId(item.sourceId);
    }
    return cachedHistory;
  };

  function rememberNativeId(id: string): void {
    if (handledNativeIds.has(id)) return;
    handledNativeIds.add(id);
    handledNativeOrder.push(id);
    while (handledNativeOrder.length > MAX_TRACKED_NOTIFICATION_IDS) {
      const oldest = handledNativeOrder.shift();
      if (oldest) handledNativeIds.delete(oldest);
    }
  }

  const writeHistory = (history: NativeNotificationHistoryItem[]): void => {
    cachedHistory = history.slice(0, NATIVE_NOTIFICATION_HISTORY_LIMIT);
    const serialized = JSON.stringify(cachedHistory);
    cachedHistoryRaw = serialized;
    writeRaw(NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY, serialized);
  };

  const record = (
    message: string,
    type = "info",
    channel = "native",
    settingId: string | null = null,
    sourceId?: string,
  ): boolean => {
    const resolvedId =
      settingId || classifyNativeNotification(message, type, channel);
    const enabled = isEnabled(resolvedId);
    const history = readHistoryInternal();
    history.unshift({
      id: createId(),
      ...(sourceId ? { sourceId } : {}),
      timestamp: now(),
      message: String(message || "").slice(0, 2000),
      type: String(type || "info"),
      channel: String(channel || "native"),
      settingId: resolvedId,
      suppressed: !enabled,
    });
    writeHistory(history);
    return enabled;
  };

  const isNativeNotificationEnabled = (
    message: string,
    type = "info",
  ): boolean => {
    if (!isNotificationCenterEnabled()) return true;
    return isEnabled(classifyNativeNotification(message, type, "native"));
  };

  const admitNativeNotification = ({
    id,
    message,
    type,
  }: NativeNotificationInput): boolean => {
    const sourceId = typeof id === "string" ? id.trim() : "";
    if (sourceId && handledNativeIds.has(sourceId)) {
      return isNativeNotificationEnabled(message, type);
    }
    if (!isNotificationCenterEnabled()) {
      if (sourceId) rememberNativeId(sourceId);
      return true;
    }
    if (sourceId) {
      readHistoryInternal();
      if (handledNativeIds.has(sourceId)) {
        return isNativeNotificationEnabled(message, type);
      }
      rememberNativeId(sourceId);
    }
    return record(message, type, "native", null, sourceId || undefined);
  };

  const setEnabled = (settingId: string, enabled: boolean): boolean => {
    if (!getChannel(settingId)) return false;
    const settings = getSettingsInternal();
    settings[settingId] = Boolean(enabled);
    const serialized = JSON.stringify({ schemaVersion: 1, channels: settings });
    cachedSettingsRaw = serialized;
    writeRaw(NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY, serialized);
    dispatchPolicyChange();
    return true;
  };

  const reset = (): void => {
    cachedSettings = makeDefaults();
    const serialized = JSON.stringify({
      schemaVersion: 1,
      channels: cachedSettings,
    });
    cachedSettingsRaw = serialized;
    writeRaw(NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY, serialized);
    dispatchPolicyChange();
  };

  const history = (): NativeNotificationHistoryItem[] =>
    readHistoryInternal().slice();

  const clearHistory = (): void => writeHistory([]);

  const policy: NativeNotificationPolicy = {
    version: 1,
    changeEvent: NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT,
    channels: NATIVE_NOTIFICATION_CHANNELS,
    getSettings: () => ({ ...getSettingsInternal() }),
    isEnabled,
    isNotificationCenterEnabled,
    isNativeNotificationEnabled,
    admitNativeNotification,
    classify: classifyNativeNotification,
    record,
    setEnabled,
    reset,
    history,
    clearHistory,
  };
  return policy;
}

export function initializeNativeNotificationPolicy(
  targetWindow: NativeNotificationWindow | null = getBrowserWindow(),
): NativeNotificationPolicy | null {
  if (!targetWindow || typeof targetWindow !== "object") return null;
  try {
    const existing = targetWindow.__PI_NATIVE_NOTIFICATION_POLICY__;
    if (
      existing?.version === 1 &&
      typeof existing.admitNativeNotification === "function"
    )
      return existing;
  } catch {
    // Reinitializing is safe when the existing global cannot be read.
  }
  const policy = createNativeNotificationPolicy({ targetWindow });
  try {
    targetWindow.__PI_NATIVE_NOTIFICATION_POLICY__ = policy;
  } catch {
    // The module exports remain usable if a host object refuses global assignment.
  }
  return policy;
}

let modulePolicy = initializeNativeNotificationPolicy();

function getPolicy(): NativeNotificationPolicy | null {
  const targetWindow = getBrowserWindow();
  if (targetWindow) {
    try {
      const policy = targetWindow.__PI_NATIVE_NOTIFICATION_POLICY__;
      if (policy?.version === 1) return policy;
    } catch {
      // Fall through to the module-local instance.
    }
    modulePolicy =
      initializeNativeNotificationPolicy(targetWindow) ?? modulePolicy;
  }
  return modulePolicy;
}

export function admitNativeNotification(
  input: NativeNotificationInput,
): boolean {
  try {
    return getPolicy()?.admitNativeNotification(input) ?? true;
  } catch {
    return true;
  }
}

export function isNativeNotificationEnabled(
  message: string,
  type: string,
): boolean {
  try {
    return getPolicy()?.isNativeNotificationEnabled(message, type) ?? true;
  } catch {
    return true;
  }
}
