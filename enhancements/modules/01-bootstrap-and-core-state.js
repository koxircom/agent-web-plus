/**
 * Agent Web Plus Enhancements v4.3.4:
 * 1. Session Row Context Menu (Right-click in sidebar)
 *    - Copy Session ID / Path / Prompt / CWD
 * 2. Quick Action Quote Toolbar (Select text in chat output)
 *    - Actions: [ “ 引用 | 解释 | 单测 | 排查 | 优化 ]
 *    - Formats text as Markdown quote + auto-appends targeted prompt
 * 3. Total Task Duration Breakdown Tooltip (悬浮耗时拆解气泡)
 *    - Hover on ⏱️ badge in assistant message footer
 *    - Breakdown: Thinking, Tools (with sub-tool counts), Generation/Network
 *    - Colorful segment progress bar + detail breakdown table
 * 4. Toast Notifications
 * 5. Session Scroll Position Memory & Restore (会话阅读位置记忆与恢复)
 *    - 记忆跨会话阅读位置，切换会话后自动平滑恢复至上次阅读进度
 */
(function () {
  "use strict";

  // 默认语言中文智能对齐：未设置时优先使用简体中文
  try {
    if (!localStorage.getItem("pi-locale")) {
      localStorage.setItem("pi-locale", "zh-CN");
    }
  } catch (e) {}

  // 0. 路由自愈保护：如果用户通过直连路径 (如 /01a0bf39-...) 访问导致 404，毫秒级自动重定向到合法的 Query 模式 /?session=<id>
  try {
    if (typeof window !== "undefined" && window.location) {
      const rawPath = String(window.location.pathname || "").replace(/^\/+|\/+$/g, "");
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawPath)) {
        const targetSearch = new URLSearchParams(window.location.search || "");
        targetSearch.set("session", rawPath);
        const nextUrl = "/?" + targetSearch.toString();
        window.location.replace(nextUrl);
        return;
      }
    }
  } catch (e) {}

  // Safe Hot-Reloading: Clean up any previous instance before re-initializing
  if (typeof window.__PI_WEB_ENHANCEMENTS_CLEANUP__ === "function") {
    try {
      window.__PI_WEB_ENHANCEMENTS_CLEANUP__();
    } catch (err) {
      console.warn("[Agent Web Plus Enhancements] error cleaning up previous instance:", err);
    }
  }
  // 立即清除任何可能残留的孤儿 Toast 节点
  try {
    for (const t of document.querySelectorAll(".pi-enh-toast")) {
      t.remove();
    }
  } catch (e) {}

  // 本实例 lifecycle 与 ownership 标志
  let isDisposed = false;
  let hasDeferredSync = false;

  // Top-level TDZ hoisted forward declarations (< line 200)
  let pendingDecorationOperations,
    latestKnownSessionGroups,
    SESSION_RECENTS_HEADER_HEIGHT = 34,
    SESSION_NORMAL_ITEM_HEIGHT = 54,
    SESSION_TAGGED_ITEM_HEIGHT = 72,
    PERSISTENT_SESSION_CACHE_NAME,
    sessionMemoryCache,
    persistentSessionEpochs,
    baseFetch,
    originalWindowFetch,
    crossDeviceSyncChannel,
    activeMenu,
    sessionArchiveIcon,
    annotationEditor,
    quoteBar,
    quoteBarInteracting,
    projectStatusModel,
    projectStatusState,
    projectStatusCatalog,
    projectStatusDisposed,
    projectStatusLeader,
    projectStatusChannel,
    projectStatusLastPayload,
    quickActionsConfig,
    quickActionsDraftConfig,
    quickActionsDraftGeneration,
    quickActionsSyncStatus,
    isComposing,
    emptySendContinuePassthrough,
    activeComposerPasteTextarea,
    activeZoomDialog,
    composerQueuePanel,
    activeFormattedComposer,
    isComposingInput,
    composerModesStateMap,
    pendingNewComposerMode,
    isSessionBatchMode,
    batchDeleteModal,
    durationTooltip,
    usageTooltip,
    orphanOriginalDisplay,
    minimapHistoryDisplayState,
    autoLoadEarlierTriggered,
    viewerFileContentCache,
    wasRunning,
    restoredThinkingSessionScopes,
    SHORTCUT_TIP_STORAGE_KEY,
    pendingShortcutNavigation,
    codeBlockScanObserver = null,
    lastObsidianViewerPath = null,
    cachedNativeOnOpenFile = null,
    sidebarObserver = null,
    activeTurnStartTime = null,
    activeTurnEntryId = null,
    notRunningConsecutiveTicks = 0,
    isRestoringThinking = false,
    settingsDialogObserver = null,
    isPersistingShortcutsToServer = false,
    pendingPersistShortcutsTimer = null,
    initialShortcutsSyncAttempted = false,
    isForceReloading = false,
    archivedPanelSearchQuery = "",
    selectedArchivedIds = new Set(),
    lastCheckedArchivedIndex = null,
    isDateCleanPanelOpen = false,
    archivedDateCutoffValue = "",
    bridgeBaseSyncUrl = null,
    currentScriptTag = null,
    pollerIntervalId = null;

  // --- Managed Lifecycle & Zero-Leak Teardown Registry ---
  const activeCleanups = [];
  const managedTimeoutCleanups = new Map();
  let usageDashboardModal = null;

  function clearManagedTimeout(id) {
    if (id == null) return;
    try { clearTimeout(id); } catch (e) {}
    const cleanup = managedTimeoutCleanups.get(id);
    if (cleanup) {
      managedTimeoutCleanups.delete(id);
      const idx = activeCleanups.indexOf(cleanup);
      if (idx !== -1) activeCleanups.splice(idx, 1);
    }
  }

  function addManagedListener(target, type, handler, options) {
    if (isDisposed) return;
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, handler, options);
    activeCleanups.push(() => {
      try {
        target.removeEventListener(type, handler, options);
      } catch (e) {}
    });
  }

  function addManagedInterval(fn, ms) {
    if (isDisposed) return null;
    const id = setInterval(fn, ms);
    activeCleanups.push(() => {
      try { clearInterval(id); } catch (e) {}
    });
    return id;
  }

  function addManagedTimeout(fn, ms) {
    if (isDisposed) return null;
    let id;
    const cleanup = () => {
      try { clearTimeout(id); } catch (e) {}
      managedTimeoutCleanups.delete(id);
    };
    id = setTimeout(() => {
      managedTimeoutCleanups.delete(id);
      const idx = activeCleanups.indexOf(cleanup);
      if (idx !== -1) activeCleanups.splice(idx, 1);
      if (isDisposed) return;
      try {
        fn();
      } catch (err) {
        console.error("[Agent Web Plus Enhancements] Error in managed timeout:", err);
      }
    }, ms);
    managedTimeoutCleanups.set(id, cleanup);
    activeCleanups.push(cleanup);
    return id;
  }

  let chatObserver = null;
  let observedTarget = null;
  let isMutatingInternally = false;
  let syncScheduled = false;
  let domSyncFrameId = null;
  let domSyncTimerId = null;

  function withMutationGuard(fn) {
    if (isDisposed) return;
    if (isMutatingInternally) {
      fn();
      return;
    }
    isMutatingInternally = true;
    try {
      fn();
    } finally {
      // Release in next microtask to absorb any synchronous mutation events
      Promise.resolve().then(() => {
        isMutatingInternally = false;
        if (hasDeferredSync && !isDisposed) {
          hasDeferredSync = false;
          scheduleDomSync();
        }
      });
    }
  }

  function isLoginPage() {
    try {
      const path = window.location.pathname || "";
      if (path === "/login" || path.startsWith("/login/")) return true;
      if (document.querySelector('input[type="password"]') && !document.querySelector('textarea, [role="textbox"], .session-row')) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Shared styles are imported once by app/layout.tsx.


  // --- Notification Preferences & History (通知偏好与历史) ---
  const getNativeNotificationPolicy = () => {
    try { return window.__PI_NATIVE_NOTIFICATION_POLICY__ || null; } catch (e) { return null; }
  };
  const nativeNotificationPolicy = getNativeNotificationPolicy();
  const NOTIFICATION_CHANNELS = nativeNotificationPolicy?.channels || [];
  const NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT = nativeNotificationPolicy?.changeEvent || "pi-native-notification-policy-change";

  function readNotificationSettings() {
    return getNativeNotificationPolicy()?.getSettings?.() || Object.fromEntries(NOTIFICATION_CHANNELS.map((item) => [item.id, item.defaultEnabled]));
  }

  function getNotificationChannel(id) {
    return NOTIFICATION_CHANNELS.find((item) => item.id === id) || null;
  }

  function isNotificationEnabled(id) {
    return getNativeNotificationPolicy()?.isEnabled?.(id) ?? true;
  }

  function getNotificationTypeLabel(type) {
    return ({ info: "信息", success: "成功", warning: "警告", error: "错误" })[type] || "提示";
  }

  function classifyNotification(message, type = "info", channel = "native") {
    return getNativeNotificationPolicy()?.classify?.(message, type, channel) || "native-info";
  }

  function readNotificationHistory() {
    return getNativeNotificationPolicy()?.history?.() || [];
  }

  function recordNotificationEvent(message, type = "info", channel = "native", settingId = null) {
    return getNativeNotificationPolicy()?.record?.(message, type, channel, settingId) ?? true;
  }

  function applyNotificationVisibility(dispatchPolicyChange = true) {
    if (dispatchPolicyChange) {
      try { window.dispatchEvent(new CustomEvent(NATIVE_NOTIFICATION_POLICY_CHANGE_EVENT)); } catch (e) {}
    }
    if (!isNotificationEnabled("enhancement-toast")) dismissToast?.(true);
    if (typeof renderAttentionNotices === "function") renderAttentionNotices();
    if (typeof syncApprovalSound === "function") syncApprovalSound();
    if (typeof syncDesktopAttention === "function") syncDesktopAttention();
  }

  function setNotificationEnabled(id, enabled) {
    if (!getNotificationChannel(id) || !getNativeNotificationPolicy()?.setEnabled?.(id, enabled)) return;
    applyNotificationVisibility(false);
  }

  function clearNotificationHistory() {
    getNativeNotificationPolicy()?.clearHistory?.();
  }

  function resetNotificationSettings() {
    getNativeNotificationPolicy()?.reset?.();
    applyNotificationVisibility(false);
  }

  window.__PI_ENH_NOTIFICATION_SETTINGS__ = {
    channels: NOTIFICATION_CHANNELS,
    get: () => ({ ...readNotificationSettings() }),
    set: (id, enabled) => setNotificationEnabled(id, enabled),
    history: () => readNotificationHistory(),
    clearHistory: clearNotificationHistory,
    classify: classifyNotification,
    reset: resetNotificationSettings,
    admit: (notice) => getNativeNotificationPolicy()?.admitNativeNotification?.(notice) ?? true,
  };

  // --- Toast Helper ---
  let toastEl = null;
  let toastTimer = null;
  let toastRemoveTimer = null;

  function dismissToast(immediate = false) {
    if (toastTimer) {
      clearManagedTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastRemoveTimer) {
      clearTimeout(toastRemoveTimer);
      toastRemoveTimer = null;
    }
    if (!toastEl) return;
    const el = toastEl;
    toastEl = null;
    el.classList.remove("show");
    if (immediate) {
      try { el.remove(); } catch (e) {}
    } else {
      toastRemoveTimer = setTimeout(() => {
        try { el.remove(); } catch (e) {}
      }, 220);
    }
  }

  function showToast(message, iconSvg, durationMs) {
    const settingId = arguments.length > 3 && arguments[3] ? arguments[3] : "enhancement-toast";
    if (!recordNotificationEvent(message, "info", "toast", settingId)) return;
    // 1. 清理可能遗留的历史孤儿 toast 节点
    for (const orphan of document.querySelectorAll(".pi-enh-toast")) {
      try { orphan.remove(); } catch (e) {}
    }
    if (toastTimer) {
      clearManagedTimeout(toastTimer);
      toastTimer = null;
    }
    if (toastRemoveTimer) {
      clearTimeout(toastRemoveTimer);
      toastRemoveTimer = null;
    }

    // 2. 创建全新的 toast 节点，并附带关键内联样式兜底防掉落
    toastEl = document.createElement("div");
    toastEl.className = "pi-enh-toast";
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    // 防御性内联定位：即使外部样式表被清理或延迟，也绝不掉入文档常规流（左下角）
    toastEl.style.position = "fixed";
    toastEl.style.top = "16px";
    toastEl.style.left = "50%";
    toastEl.style.zIndex = "100000";

    const msgStr = String(message || "");
    const isErrorMsg = /失败|错误|异常|超时|无法|拒绝|拦截|未通过/.test(msgStr);
    const isLoadingMsg = !isErrorMsg && !/完成|成功|已/.test(msgStr) && /正在|下载|更新中|加载中|刷新中|连接中|同步中/.test(msgStr);
    const defaultCheck = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const errorIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    const loadingIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite"/></path></svg>`;
    const resolvedIcon = iconSvg || (isErrorMsg ? errorIcon : (isLoadingMsg ? loadingIcon : defaultCheck));
    if (isErrorMsg) toastEl.setAttribute("data-toast-level", "error");
    else if (isLoadingMsg) toastEl.setAttribute("data-toast-level", "loading");
    toastEl.innerHTML = `${resolvedIcon}<span data-pi-enh-toast-text>${message}</span><button type="button" class="pi-enh-toast-dismiss" data-pi-enh-toast-dismiss aria-label="关闭提示" title="关闭">×</button>`;
    toastEl.querySelector("[data-pi-enh-toast-dismiss]")?.addEventListener("click", () => dismissToast(false));
    document.body.appendChild(toastEl);

    // 强制触发 reflow 保证动画平滑
    void toastEl.offsetWidth;
    toastEl.classList.add("show");

    const defaultDuration = isErrorMsg ? 4200 : (isLoadingMsg ? 15000 : 2400);
    const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : defaultDuration;
    toastTimer = addManagedTimeout(() => dismissToast(false), duration);
  }

  const QUEUE_WARN_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

  function showQueueSecurityWarningToast(message = "队列未改动：安全接口待维护安装，暂不能编辑、删除或提升") {
    const previousToast = toastEl;
    showToast(message, QUEUE_WARN_ICON, 3200);
    if (toastEl && toastEl !== previousToast) {
      // Keep this longer warning readable on phones without changing other toasts.
      toastEl.style.width = "max-content";
      toastEl.style.maxWidth = "calc(100vw - 32px)";
      toastEl.style.boxSizing = "border-box";
      const icon = toastEl.querySelector("svg");
      if (icon) icon.style.flexShrink = "0";
    }
  }

  // A hot-reload starts from the previous script instance. Carry its notice
  // across the script handoff so the freshly loaded helper renders it with
  // the current dismissible toast markup.
  const pendingToast = window.__PI_ENH_PENDING_TOAST__;
  if (pendingToast && pendingToast.message) {
    delete window.__PI_ENH_PENDING_TOAST__;
    showToast(pendingToast.message, pendingToast.iconSvg, pendingToast.durationMs, pendingToast.settingId);
  }

  // --- Clipboard Helper ---
  async function copyText(text, successMsg) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showToast(successMsg);
    } catch (e) {
      showToast("复制失败: " + e.message);
    }
  }
