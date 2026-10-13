  // ==========================================
  // 1. Session Row Context Menu (右键会话菜单)
  // ==========================================
  activeMenu = null;

  function closeMenu() {
    if (activeSessionTagsPopover) {
      closeSessionTagsPopover(false);
    }
    if (activeMenu) {
      const confirmItem = activeMenu._deleteConfirmItem;
      if (confirmItem?._confirmTimer) {
        clearTimeout(confirmItem._confirmTimer);
        confirmItem._confirmTimer = null;
      }
      activeMenu.remove();
      activeMenu = null;
    }
  }
  window.__PI_ENH_SET_ACTIVE_MENU__ = (m) => { activeMenu = m; };
  window.__PI_ENH_CLOSE_MENU__ = closeMenu;

  const sessionOverflowIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="5" cy="12" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle></svg>`;
  const sessionPinIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"></path><path d="M8 3h8"></path><path d="M9 3v5l-3 4v2h12v-2l-3-4V3"></path></svg>`;
  sessionArchiveIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg>`;
  const sessionDeleteIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>`;
  const sessionWarnIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
  const sessionUnreadIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3.5" fill="currentColor"></circle></svg>`;
  const sessionReadIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>`;

  const UNREAD_SESSION_STORAGE_KEY = "pi-web:unread-session-ids";
  const SESSION_READ_WATERMARKS_STORAGE_KEY = "pi-enh:session-read-watermarks-v1";
  const READ_WATERMARKS_REVISION_STORAGE_KEY = "pi-enh-session-read-watermarks-rev";

  function getLocalReadWatermarksRevision() {
    try {
      return Number(localStorage.getItem(READ_WATERMARKS_REVISION_STORAGE_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setLocalReadWatermarksRevision(rev) {
    try {
      localStorage.setItem(READ_WATERMARKS_REVISION_STORAGE_KEY, String(rev));
    } catch (e) {}
  }

  function pruneWatermarks(watermarks, limit = 120) {
    if (!watermarks || typeof watermarks !== "object") return {};
    const entries = Object.entries(watermarks);
    if (entries.length <= limit) return { ...watermarks };
    entries.sort((a, b) => {
      const timeA = Number(a[1]?.readAt || a[1]?.markedAt || 0);
      const timeB = Number(b[1]?.readAt || b[1]?.markedAt || 0);
      return timeB - timeA;
    });
    const pruned = {};
    for (const [id, val] of entries.slice(0, limit)) {
      pruned[id] = val;
    }
    return pruned;
  }

  function readSessionReadWatermarks() {
    try {
      const raw = localStorage.getItem(SESSION_READ_WATERMARKS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function writeSessionReadWatermarks(watermarks) {
    try {
      localStorage.setItem(SESSION_READ_WATERMARKS_STORAGE_KEY, JSON.stringify(watermarks));
    } catch (e) {}
  }

  function getSessionMetaForWatermark(sessionId, statusEntry = null) {
    if (!sessionId) return null;
    const catalogSession = (typeof projectStatusCatalog !== "undefined" && projectStatusCatalog) ? projectStatusCatalog.get(sessionId) : null;
    const knownSession = (typeof knownSessionsMap !== "undefined" && knownSessionsMap) ? knownSessionsMap.get(sessionId) : null;
    // Catalog refreshes can arrive independently; don't prefer an older message watermark.
    const s = Number(knownSession?.messageCount) > Number(catalogSession?.messageCount ?? -1)
      ? knownSession : (catalogSession || knownSession);
    const entry = statusEntry || ((typeof projectStatusModel !== "undefined" && typeof projectStatusModel.entry === "function")
      ? projectStatusModel.entry(sessionId)
      : null);
    return {
      id: sessionId,
      runId: String(entry?.runId || s?.runId || ""),
      messageCount: Number(s?.messageCount ?? 0),
      isSubagent: s?.relation?.kind === "subagent" || entry?.isSubagent,
      running: entry?.execution === "running" || Boolean(s?.isRunning)
        || (typeof projectStatusLastPayload !== "undefined" && projectStatusLastPayload?.runningSessionIds?.includes(sessionId)),
    };
  }

  function recordSessionReadWatermark(sessionId, meta = null) {
    if (!sessionId) return false;
    const sMeta = meta || getSessionMetaForWatermark(sessionId);
    const hasLoadedSession = (typeof knownSessionsMap !== "undefined" && knownSessionsMap.has(sessionId))
      || (typeof projectStatusCatalog !== "undefined" && projectStatusCatalog.has(sessionId));
    const hasValidMeta = Boolean(sMeta && (sMeta.runId || sMeta.messageCount));
    if (!hasLoadedSession && !hasValidMeta) {
      return false;
    }

    const watermarks = readSessionReadWatermarks();
    const existing = watermarks[sessionId];
    const newRunId = sMeta?.runId || "";
    const newMessageCount = sMeta?.messageCount || 0;

    if (existing && existing.manualUnread === false && (existing.runId || "") === newRunId && (existing.messageCount || 0) === newMessageCount) {
      return false;
    }

    watermarks[sessionId] = {
      runId: newRunId,
      messageCount: newMessageCount,
      manualUnread: false,
      readAt: Date.now(),
    };
    writeSessionReadWatermarks(watermarks);
    if (typeof persistReadWatermarksToServer === "function") {
      void persistReadWatermarksToServer();
    }
    return true;
  }

  function recordSessionManualUnread(sessionId) {
    if (!sessionId) return;
    const watermarks = readSessionReadWatermarks();
    const existing = watermarks[sessionId];
    if (existing && existing.manualUnread === true) return;
    watermarks[sessionId] = {
      ...(existing || {}),
      manualUnread: true,
      markedAt: Date.now(),
    };
    writeSessionReadWatermarks(watermarks);
  }

  function readUnreadSessionIds() {
    try {
      const raw = localStorage.getItem(UNREAD_SESSION_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
    } catch (e) {
      return new Set();
    }
  }

  function writeUnreadSessionIds(ids) {
    try {
      const arr = Array.from(ids);
      if (arr.length === 0) {
        localStorage.removeItem(UNREAD_SESSION_STORAGE_KEY);
      } else {
        localStorage.setItem(UNREAD_SESSION_STORAGE_KEY, JSON.stringify(arr));
      }
    } catch (e) {}
    if (typeof schedulePrioritySessionPreloads === "function") {
      schedulePrioritySessionPreloads();
    }
  }

  function isSessionUnread(sessionId) {
    if (!sessionId) return false;
    if (typeof window !== "undefined" && typeof window.__PI_ENH_IS_SESSION_UNREAD__ === "function") {
      try {
        if (window.__PI_ENH_IS_SESSION_UNREAD__(sessionId)) return true;
      } catch (e) {}
    }
    if (readUnreadSessionIds().has(sessionId)) return true;
    if (typeof projectStatusModel !== "undefined" && typeof projectStatusModel.entry === "function") {
      try {
        const entry = projectStatusModel.entry(sessionId);
        if (entry?.unread) return true;
      } catch (e) {}
    }
    return false;
  }

  function markSessionAsRead(sessionId, explicit = false) {
    if (!sessionId) return;
    if (typeof isPluginEnabled === "function" && !isPluginEnabled("session-pin-archive")) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible" && !explicit) return;

    const watermarks = readSessionReadWatermarks();
    const wm = watermarks[sessionId];
    if (wm && wm.manualUnread && !explicit) {
      return;
    }

    const wasUnread = Boolean(isSessionUnread(sessionId));
    const watermarkChanged = Boolean(recordSessionReadWatermark(sessionId));
    if (typeof markProjectCompletionRead === "function") {
      markProjectCompletionRead(sessionId);
    }

    let markReadChanged = false;
    if (wasUnread) {
      const ids = readUnreadSessionIds();
      if (ids.has(sessionId)) {
        ids.delete(sessionId);
        writeUnreadSessionIds(ids);
        markReadChanged = true;
      }
      if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
        try {
          window.__PI_ENH_SET_UNREAD_SESSION__(sessionId, false);
        } catch (e) {}
      }
      if (typeof projectStatusModel !== "undefined" && projectStatusModel.setUnread) {
        try {
          projectStatusModel.setUnread(Array.from(ids));
        } catch (e) {}
      }
    }

    const unreadChanged = wasUnread !== Boolean(isSessionUnread(sessionId)) || markReadChanged;
    const shouldBroadcast = Boolean(explicit || watermarkChanged || unreadChanged);

    if (shouldBroadcast) {
      try {
        const sMeta = getSessionMetaForWatermark(sessionId);
        crossDeviceSyncChannel?.postMessage({
          type: "session_read_status_updated",
          sessionId,
          unread: false,
          meta: sMeta,
          revision: Date.now(),
        });
      } catch (e) {}
    }

    if (markReadChanged && typeof persistReadWatermarksToServer === "function") {
      void persistReadWatermarksToServer();
    }
  }
  window.__PI_ENH_MARK_SESSION_AS_READ__ = markSessionAsRead;

  function toggleSessionUnread(sessionId, forceState) {
    if (!sessionId) return false;
    const currentUnread = isSessionUnread(sessionId);
    const targetState = typeof forceState === "boolean" ? forceState : !currentUnread;

    const ids = readUnreadSessionIds();
    if (targetState) {
      ids.add(sessionId);
      recordSessionManualUnread(sessionId);
      if (typeof markProjectCompletionUnread === "function") {
        markProjectCompletionUnread(sessionId);
      }
    } else {
      ids.delete(sessionId);
      recordSessionReadWatermark(sessionId);
      if (typeof markProjectCompletionRead === "function") {
        markProjectCompletionRead(sessionId);
      }
    }
    writeUnreadSessionIds(ids);

    // 1. 优先调用 React 原生状态桥接，实现零延迟即时重绘与指示器联动
    if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
      try {
        window.__PI_ENH_SET_UNREAD_SESSION__(sessionId, targetState);
      } catch (e) {}
    }

    // 2. 广播 storage 事件，通知其他 Tab 或监听模块
    try {
      window.dispatchEvent(new StorageEvent("storage", {
        key: UNREAD_SESSION_STORAGE_KEY,
        newValue: JSON.stringify(Array.from(ids)),
      }));
    } catch (e) {}

    // 3. 广播跨 Tab 状态
    try {
      const sMeta = getSessionMetaForWatermark(sessionId);
      crossDeviceSyncChannel?.postMessage({
        type: "session_read_status_updated",
        sessionId,
        unread: Boolean(targetState),
        meta: sMeta,
        revision: Date.now(),
      });
    } catch (e) {}

    // 4. 同步项目状态模型（如果有）
    if (typeof projectStatusModel !== "undefined" && projectStatusModel.setUnread) {
      try {
        projectStatusModel.setUnread(Array.from(ids));
        if (typeof syncProjectStatusIndicators === "function") {
          syncProjectStatusIndicators();
        }
      } catch (e) {}
    }

    // 5. 若无原生桥接，触发轻量刷新
    if (typeof window === "undefined" || typeof window.__PI_ENH_SET_UNREAD_SESSION__ !== "function") {
      requestSessionListRefresh();
    }

    if (!targetState && typeof persistReadWatermarksToServer === "function") {
      void persistReadWatermarksToServer();
    }

    return targetState;
  }
  window.__PI_ENH_TOGGLE_SESSION_UNREAD__ = toggleSessionUnread;

  function reconcileUnreadSessions() {
    if (typeof isPluginEnabled === "function" && !isPluginEnabled("session-pin-archive")) return;

    const storedIds = readUnreadSessionIds();
    const currentUnreadIds = new Set(storedIds);
    const archivedIds = (typeof getArchivedSessionIds === "function")
      ? new Set(getArchivedSessionIds())
      : ((typeof readStoredArchivedEntries === "function")
          ? new Set(readStoredArchivedEntries().map(e => (typeof e === "string" ? e : e?.id)).filter(Boolean))
          : (typeof readStoredSessionIds === "function" && typeof ARCHIVED_SESSION_STORAGE_KEY !== "undefined"
              ? readStoredSessionIds(ARCHIVED_SESSION_STORAGE_KEY)
              : new Set()));

    const isDeleted = (id) => {
      if (typeof isSessionDeleted === "function" && isSessionDeleted(id)) return true;
      if (typeof isSessionLocallyDeleted === "function" && isSessionLocallyDeleted(id)) return true;
      return false;
    };

    const watermarks = readSessionReadWatermarks();
    const currentActiveId = (typeof document !== "undefined" && document.visibilityState === "visible")
      ? (typeof getSessionIdFromCurrentUrl === "function" ? getSessionIdFromCurrentUrl() : null)
      : null;

    let changed = false;
    let watermarksChanged = false;

    const statusEntriesMap = new Map();
    if (typeof projectStatusModel !== "undefined" && typeof projectStatusModel.list === "function") {
      try {
        for (const item of projectStatusModel.list()) {
          if (item?.id) statusEntriesMap.set(item.id, item);
        }
      } catch (e) {}
    }

    const candidateIds = new Set([...storedIds, ...Object.keys(watermarks)]);
    if (currentActiveId) candidateIds.add(currentActiveId);

    const inspectSession = (sessionId) => {
      if (!sessionId) return;
      const isUnread = currentUnreadIds.has(sessionId) ||
        (typeof window !== "undefined" && typeof window.__PI_ENH_IS_SESSION_UNREAD__ === "function" && window.__PI_ENH_IS_SESSION_UNREAD__(sessionId));
      const meta = getSessionMetaForWatermark(sessionId, statusEntriesMap.get(sessionId) || {});
      const receipt = watermarks[sessionId];
      const newer = receipt && !receipt.manualUnread && (meta.runId
        ? meta.runId !== receipt.runId : meta.messageCount > (receipt.messageCount || 0));
      // A native completion may arrive before its catalog update. Recover the unread
      // when fresh metadata finally arrives, rather than swallowing that new answer.
      if (!isUnread && newer && !meta.running && sessionId !== currentActiveId
        && !archivedIds.has(sessionId) && !isDeleted(sessionId) && !meta.isSubagent) {
        currentUnreadIds.add(sessionId);
        window.__PI_ENH_SET_UNREAD_SESSION__?.(sessionId, true);
        delete watermarks[sessionId];
        watermarksChanged = changed = true;
        return;
      }
      if (!isUnread) return;

      // 1. 归档会话或已删除会话绝不留幽灵计数
      if (archivedIds.has(sessionId) || isDeleted(sessionId)) {
        currentUnreadIds.delete(sessionId);
        if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
          try { window.__PI_ENH_SET_UNREAD_SESSION__(sessionId, false); } catch (e) {}
        }
        changed = true;
        return;
      }

      // 2. 子代理条目不留未读计数
      if (meta?.isSubagent) {
        currentUnreadIds.delete(sessionId);
        if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
          try { window.__PI_ENH_SET_UNREAD_SESSION__(sessionId, false); } catch (e) {}
        }
        changed = true;
        return;
      }

      // 3. 当前有效前台会话标为已读（自动 reconcile 尊重 manualUnread）
      if (currentActiveId && sessionId === currentActiveId) {
        const wm = watermarks[sessionId];
        if (wm?.manualUnread) {
          return;
        }
        currentUnreadIds.delete(sessionId);
        recordSessionReadWatermark(sessionId, meta);
        if (typeof markProjectCompletionRead === "function") markProjectCompletionRead(sessionId);
        if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
          try { window.__PI_ENH_SET_UNREAD_SESSION__(sessionId, false); } catch (e) {}
        }
        changed = true;
        return;
      }

      // 4. 水位检查：同一 run 不因重放/epoch 变动复活；新真实轮次仍允许未读；manualUnread 保持有效
      const wm = watermarks[sessionId];
      if (wm && !wm.manualUnread) {
        const hasValidMeta = Boolean(meta && (meta.runId || meta.messageCount));
        if (!hasValidMeta) {
          return;
        }

        const hasNewRun = Boolean(meta.runId && meta.runId !== wm.runId);
        const legacyNewMessages = !meta.runId && meta.messageCount > (wm.messageCount || 0);
        if (hasNewRun || legacyNewMessages) {
          delete watermarks[sessionId];
          watermarksChanged = true;
        } else {
          currentUnreadIds.delete(sessionId);
          if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
            try { window.__PI_ENH_SET_UNREAD_SESSION__(sessionId, false); } catch (e) {}
          }
          changed = true;
        }
      }
    };

    for (const id of candidateIds) inspectSession(id);

    if (watermarksChanged) {
      writeSessionReadWatermarks(watermarks);
    }

    if (changed) {
      writeUnreadSessionIds(currentUnreadIds);
      if (typeof projectStatusModel !== "undefined" && projectStatusModel.setUnread) {
        try { projectStatusModel.setUnread(Array.from(currentUnreadIds)); } catch (e) {}
      }
    }
  }
  function installStorageUnreadWatchdog() {
    if (typeof window === "undefined") return;
    const targetProto = (typeof Storage !== "undefined" && Storage.prototype) ? Storage.prototype : null;
    const targetStorage = (typeof localStorage !== "undefined") ? localStorage : window.localStorage;

    function filterUnreadValue(rawVal) {
      if (typeof rawVal !== "string") return { value: rawVal, purgedIds: [] };
      try {
        const parsed = JSON.parse(rawVal);
        if (!Array.isArray(parsed) || parsed.length === 0) {
          return { value: rawVal, purgedIds: [] };
        }
        const watermarks = (typeof readSessionReadWatermarks === "function") ? readSessionReadWatermarks() : {};
        const purgedIds = [];
        const filtered = parsed.filter((id) => {
          if (typeof id !== "string") return false;
          const wm = watermarks[id];
          if (!wm || wm.manualUnread === true) return true;

          const meta = (typeof getSessionMetaForWatermark === "function") ? getSessionMetaForWatermark(id) : null;
          const hasNewRun = Boolean(meta?.runId && wm.runId && meta.runId !== wm.runId);
          const legacyNewMessages = (!wm.runId || !meta?.runId) && (meta?.messageCount || 0) > (wm.messageCount || 0);
          const hasNewActivity = hasNewRun || legacyNewMessages;

          if (!hasNewActivity) {
            purgedIds.push(id);
            return false;
          }
          return true;
        });

        if (purgedIds.length > 0) {
          return { value: JSON.stringify(filtered), purgedIds };
        }
      } catch (e) {}
      return { value: rawVal, purgedIds: [] };
    }

    const wrapSetItem = (origSetItem) => {
      return function (key, value) {
        if (key === UNREAD_SESSION_STORAGE_KEY) {
          const { value: nextVal, purgedIds } = filterUnreadValue(value);
          value = nextVal;
          if (purgedIds.length > 0 && typeof queueMicrotask === "function") {
            queueMicrotask(() => {
              for (const pid of purgedIds) {
                try { window.__PI_ENH_SET_UNREAD_SESSION__?.(pid, false); } catch (e) {}
              }
            });
          }
        }
        return origSetItem.call(this, key, value);
      };
    };

    if (targetProto && !targetProto.__piEnhUnreadWatchdogInstalled) {
      const origProtoSetItem = targetProto.setItem;
      targetProto.setItem = wrapSetItem(origProtoSetItem);
      targetProto.__piEnhUnreadWatchdogInstalled = true;
    }
    if (targetStorage && !targetStorage.__piEnhUnreadWatchdogInstalled) {
      const origStorageSetItem = targetStorage.setItem.bind(targetStorage);
      if (origStorageSetItem !== targetProto?.setItem) {
        targetStorage.setItem = wrapSetItem(origStorageSetItem);
        targetStorage.__piEnhUnreadWatchdogInstalled = true;
      }
    }
  }

  installStorageUnreadWatchdog();

  var pendingPersistReadWatermarksTimer = null;
  var pendingPersistReadWatermarksResolvers = [];

  function persistReadWatermarksToServer() {
    if (typeof isPluginEnabled === "function" && !isPluginEnabled("session-pin-archive")) {
      return Promise.resolve(false);
    }
    const timerSetter = (typeof setTimeout === "function") ? setTimeout : (typeof window !== "undefined" && typeof window.setTimeout === "function" ? window.setTimeout : null);
    const timerClearer = (typeof clearTimeout === "function") ? clearTimeout : (typeof window !== "undefined" && typeof window.clearTimeout === "function" ? window.clearTimeout : null);
    if (!timerSetter) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      pendingPersistReadWatermarksResolvers.push(resolve);
      if (pendingPersistReadWatermarksTimer && timerClearer) {
        timerClearer(pendingPersistReadWatermarksTimer);
      }
      pendingPersistReadWatermarksTimer = timerSetter(() => {
        pendingPersistReadWatermarksTimer = null;
        const currentResolvers = pendingPersistReadWatermarksResolvers;
        pendingPersistReadWatermarksResolvers = [];

        const lockRunner = (typeof runWithModelsConfigLock === "function")
          ? runWithModelsConfigLock
          : ((fn) => Promise.resolve().then(fn));

        lockRunner(async () => {
          if (typeof isDisposed !== "undefined" && isDisposed) {
            currentResolvers.forEach((r) => r(false));
            return false;
          }
          try {
            let currentConfig = null;
            try {
              if (typeof fetchModelsConfigBounded === "function") {
                const { resp: getResp, json: data } = await fetchModelsConfigBounded("/api/models-config", { cache: "no-store", readJson: true });
                if (getResp?.ok && data && typeof data === "object" && !Array.isArray(data) && data.providers && typeof data.providers === "object") {
                  currentConfig = data;
                }
              } else {
                const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
                if (activeFetch) {
                  const resp = await activeFetch("/api/models-config", { cache: "no-store" });
                  if (resp?.ok) {
                    const data = await resp.json();
                    if (data && typeof data === "object" && !Array.isArray(data) && data.providers) {
                      currentConfig = data;
                    }
                  }
                }
              }
            } catch (e) {
              console.error("[pi-enh] models-config GET network error for read watermarks:", e?.message || "network error");
            }

            if (!currentConfig || (typeof isDisposed !== "undefined" && isDisposed)) {
              currentResolvers.forEach((r) => r(false));
              return false;
            }

            const localWatermarks = pruneWatermarks(readSessionReadWatermarks(), 120);
            const serverRev = Number(currentConfig.sessionReadWatermarksRevision) || 0;
            const revision = Math.max(Date.now(), serverRev + 1, getLocalReadWatermarksRevision() + 1);
            setLocalReadWatermarksRevision(revision);

            const putPayload = {
              ...currentConfig,
              sessionReadWatermarks: localWatermarks,
              sessionReadWatermarksRevision: revision,
            };

            // 保护归档与置顶状态：避免未读水位线覆写时使用陈旧服务端快照回滚本地最新修改
            if (typeof readStoredArchivedEntries === "function") {
              const localArchived = readStoredArchivedEntries();
              const localArchivedRev = typeof getLocalArchivedRevision === "function" ? getLocalArchivedRevision() : 0;
              const serverArchivedRev = Number(currentConfig.archivedRevision) || 0;
              if (localArchivedRev >= serverArchivedRev || (typeof hasPendingArchivedPush !== "undefined" && hasPendingArchivedPush)) {
                putPayload.archivedSessions = localArchived;
                putPayload.archivedRevision = Math.max(localArchivedRev, serverArchivedRev);
              }
            }
            if (typeof readStoredSessionIds === "function" && typeof PINNED_SESSION_STORAGE_KEY !== "undefined") {
              const localPinnedIds = Array.from(readStoredSessionIds(PINNED_SESSION_STORAGE_KEY));
              const localPinnedRev = typeof getLocalPinnedRevision === "function" ? getLocalPinnedRevision() : 0;
              const serverPinnedRev = Number(currentConfig.pinnedRevision) || 0;
              if (localPinnedRev >= serverPinnedRev) {
                putPayload.pinnedSessions = localPinnedIds.map((id) => ({
                  id,
                  name: (typeof knownSessionTitles !== "undefined" && knownSessionTitles.get(id)) || "",
                  pinnedAt: Date.now()
                }));
                putPayload.pinnedRevision = Math.max(localPinnedRev, serverPinnedRev);
              }
            }

            let ok = false;
            if (typeof fetchModelsConfigBounded === "function") {
              const { resp: putResp } = await fetchModelsConfigBounded("/api/models-config", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(putPayload),
                readJson: false,
              });
              ok = Boolean(putResp?.ok) && !(typeof isDisposed !== "undefined" && isDisposed);
            } else {
              const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
              if (activeFetch) {
                const putResp = await activeFetch("/api/models-config", {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(putPayload),
                });
                ok = Boolean(putResp?.ok);
              }
            }

            currentResolvers.forEach((r) => r(ok));
            return ok;
          } catch (err) {
            console.error("[pi-enh] persistReadWatermarksToServer error:", err?.message || "unknown error");
            currentResolvers.forEach((r) => r(false));
            return false;
          }
        });
      }, 1500);
    });
  }

  var activeReadWatermarksSyncPromise = null;
  function syncManifestReadWatermarks(force = false) {
    if (activeReadWatermarksSyncPromise) return activeReadWatermarksSyncPromise;
    activeReadWatermarksSyncPromise = (async () => {
      try {
        const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
        if (!activeFetch) return;

        let remoteData = null;
        try {
          const resp = await activeFetch("/api/models-config", { cache: "no-store" });
          if (resp?.ok) {
            remoteData = await resp.json();
          }
        } catch (e) {}

        if (!remoteData || typeof remoteData !== "object" || !("sessionReadWatermarks" in remoteData)) {
          return;
        }

        const remoteRev = Number(remoteData.sessionReadWatermarksRevision) || 0;
        const localRev = getLocalReadWatermarksRevision();

        if (remoteRev > localRev || force) {
          const remoteWatermarks = (remoteData.sessionReadWatermarks && typeof remoteData.sessionReadWatermarks === "object" && !Array.isArray(remoteData.sessionReadWatermarks))
            ? remoteData.sessionReadWatermarks
            : {};

          const localWatermarks = readSessionReadWatermarks();
          let watermarksChanged = false;

          for (const [sId, rWm] of Object.entries(remoteWatermarks)) {
            if (!sId || !rWm || typeof rWm !== "object") continue;
            const lWm = localWatermarks[sId];
            if (!lWm) {
              localWatermarks[sId] = { ...rWm };
              watermarksChanged = true;
            } else {
              const rTime = Number(rWm.readAt || rWm.markedAt || 0);
              const lTime = Number(lWm.readAt || lWm.markedAt || 0);
              if (rTime > lTime) {
                localWatermarks[sId] = { ...lWm, ...rWm };
                watermarksChanged = true;
              } else if (rWm.manualUnread !== lWm.manualUnread && rTime >= lTime) {
                localWatermarks[sId] = { ...lWm, ...rWm };
                watermarksChanged = true;
              }
            }

            if (rWm && !rWm.manualUnread && typeof markProjectCompletionRead === "function") {
              markProjectCompletionRead(sId);
            }
          }

          if (watermarksChanged) {
            writeSessionReadWatermarks(localWatermarks);
          }

          const nextRev = Math.max(remoteRev, localRev);
          if (nextRev > 0) {
            setLocalReadWatermarksRevision(nextRev);
          }

          if (typeof reconcileUnreadSessions === "function") {
            reconcileUnreadSessions();
          }
          if (typeof syncProjectStatusIndicators === "function") {
            syncProjectStatusIndicators();
          }
        }
      } catch (e) {
      } finally {
        activeReadWatermarksSyncPromise = null;
      }
    })();
    return activeReadWatermarksSyncPromise;
  }

  window.__PI_ENH_RECONCILE_UNREAD_SESSIONS__ = reconcileUnreadSessions;
  window.__PI_ENH_SYNC_MANIFEST_READ_WATERMARKS__ = syncManifestReadWatermarks;
  window.__PI_ENH_PERSIST_READ_WATERMARKS__ = persistReadWatermarksToServer;
  window.__PI_ENH_INSTALL_STORAGE_UNREAD_WATCHDOG__ = installStorageUnreadWatchdog;
  activeCleanups.push(() => {
    delete window.__PI_ENH_MARK_SESSION_AS_READ__;
    delete window.__PI_ENH_TOGGLE_SESSION_UNREAD__;
    delete window.__PI_ENH_RECONCILE_UNREAD_SESSIONS__;
    delete window.__PI_ENH_SYNC_MANIFEST_READ_WATERMARKS__;
    delete window.__PI_ENH_PERSIST_READ_WATERMARKS__;
    delete window.__PI_ENH_INSTALL_STORAGE_UNREAD_WATCHDOG__;
  });

  function getSessionRowById(sessionId) {
    for (const row of document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]")) {
      if (row.getAttribute("data-pi-enh-session-id") === sessionId) return row;
    }
    return null;
  }

  function requestSessionListRefresh(showLoading = false, force = true) {
    try {
      if (typeof invalidateSearchCache === "function") invalidateSearchCache();
      if (typeof window.__PI_ENH_REFRESH_SESSIONS__ === "function") {
        window.__PI_ENH_REFRESH_SESSIONS__(showLoading, force);
      }
    } catch (e) {}
  }

  function removeSessionPinArchiveControls() {
    document.documentElement.classList.remove("pi-enh-session-pin-archive-active");
    for (const selector of [".pi-enh-session-overflow", ".pi-enh-session-pinned-indicator", ".pi-enh-session-menu"]) {
      for (const element of document.querySelectorAll(selector)) element.remove();
    }
  }

  function restoreSessionDeleteLocalState(sessionId, snapshot) {
    if (snapshot?.wasPinned) {
      snapshot.pinnedIds.add(sessionId);
      writeStoredSessionIds(PINNED_SESSION_STORAGE_KEY, snapshot.pinnedIds);
    }
    if (snapshot?.pinnedManifestBefore) {
      window.__PI_ENH_PINNED_MANIFEST__ = snapshot.pinnedManifestBefore;
    }
    if (snapshot?.archivedEntry) {
      const currentEntries = readStoredArchivedEntries();
      if (!currentEntries.some((entry) => entry.id === sessionId)) {
        const restoreIndex = Math.max(0, Math.min(snapshot.archivedIndex, currentEntries.length));
        currentEntries.splice(restoreIndex, 0, snapshot.archivedEntry);
        writeStoredArchivedEntries(currentEntries);
      }
    }
    if (snapshot?.archivedManifestBefore) {
      window.__PI_ENH_ARCHIVED_MANIFEST__ = snapshot.archivedManifestBefore;
    }
  }

  function beginFastSessionDelete(sessionId) {
    if (!sessionId) return;

    const inFlightDeletes = (typeof window !== "undefined" && window.__PI_ENH_FAST_SESSION_DELETE_IDS__ instanceof Set)
      ? window.__PI_ENH_FAST_SESSION_DELETE_IDS__
      : ((typeof window !== "undefined" && (window.__PI_ENH_FAST_SESSION_DELETE_IDS__ = new Set())) || new Set());
    if (inFlightDeletes.has(sessionId)) return;
    inFlightDeletes.add(sessionId);

    // 所有删除入口只可标 pending，网络前严禁提前清理或清除 metadata。
    // markSessionAsDeleted 通过 React sidebar bridge 复制本地数组，首帧即可重算过滤与虚拟坐标。
    markSessionAsDeleted(sessionId);
    showToast("已移除会话，正在后台删除…", sessionDeleteIcon);

    (async () => {
      try {
        await deleteArchivedSession(sessionId);
        requestSessionListRefresh(false, true);
        showToast("已删除会话", sessionDeleteIcon);
      } catch (err) {
        restoreSessionDeleteState(sessionId);
        requestSessionListRefresh(false, true);
        showToast("删除会话失败，已恢复会话: " + (err?.message || String(err)), sessionDeleteIcon);
      } finally {
        inFlightDeletes.delete(sessionId);
      }
    })();
  }
  window.__PI_ENH_BEGIN_FAST_SESSION_DELETE__ = beginFastSessionDelete;

  // ==========================================
  // 会话行内重命名统一调度器 (Inline Rename Controller)
  // ==========================================
  function triggerSessionInlineRename(sessionId) {
    if (!sessionId) return false;
    const row = getSessionRowById(sessionId);
    if (!row) return false;

    return !row.dispatchEvent(new CustomEvent("pi-web:session-row-rename", { cancelable: true }));
  }
  window.__PI_ENH_TRIGGER_SESSION_INLINE_RENAME__ = triggerSessionInlineRename;

  function handleSessionPinArchiveAction(sessionId, action) {
    if (action === "pin") {
      const pinned = toggleSessionPin(sessionId);
      syncSessionPinArchiveControls();
      requestSessionListRefresh();
      showToast(pinned ? "已置顶会话" : "已取消置顶会话", sessionPinIcon);
      return;
    }
    if (action === "toggle-unread" || action === "unread") {
      const unread = toggleSessionUnread(sessionId);
      showToast(unread ? "已标为未读" : "已标为已读", unread ? sessionUnreadIcon : sessionReadIcon);
      return;
    }
    if (action === "archive") {
      const row = getSessionRowById(sessionId);
      const sessionName = extractSessionTitleFromRow(row, sessionId);
      const archiveFn = (typeof archiveSession === "function")
        ? archiveSession
        : (typeof window !== "undefined" ? window.__PI_ENH_ARCHIVE_SESSION__ : null);
      const archived = archiveFn ? archiveFn(sessionId, { name: sessionName }) : false;

      if (archived) {
        syncSessionPinArchiveControls();
        requestSessionListRefresh(false, true);
        if (typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
          try { window.__PI_ENH_RERENDER_SESSIONS__(); } catch (e) {}
        }
        showToast("已归档会话，可在“设置 → 已归档”中还原", sessionArchiveIcon, 4200);
        return;
      }
    }
    if (action === "rename") {
      closeMenu();
      triggerSessionInlineRename(sessionId);
      return;
    }
    if (action === "reload") {
      closeMenu();
      if (typeof window.__PI_ENH_RELOAD_SPECIFIC_SESSION__ === "function") {
        window.__PI_ENH_RELOAD_SPECIFIC_SESSION__(sessionId, true);
      }
      return;
    }
    if (action === "delete") {
      beginFastSessionDelete(sessionId);
      return;
    }
  }

  function showSessionOverflowMenu(sessionId, trigger) {
    closeMenu();
    if (typeof window.__PI_ENH_DISMISS_SNAPSHOT_OVERLAY__ === "function") {
      try { window.__PI_ENH_DISMISS_SNAPSHOT_OVERLAY__("menu-opened"); } catch (e) {}
    }
    if (typeof window.__PI_ENH_DISMISS_LOADING_PLACEHOLDER__ === "function") {
      try { window.__PI_ENH_DISMISS_LOADING_PLACEHOLDER__("menu-opened"); } catch (e) {}
    }
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.classList.remove("pi-enh-scroll-restoring");
    }
    const pinned = readStoredSessionIds(PINNED_SESSION_STORAGE_KEY).has(sessionId);
    const unread = isSessionUnread(sessionId);
    const menu = document.createElement("div");
    menu.className = "pi-enh-menu pi-enh-session-menu";
    menu.innerHTML = `
      <div class="pi-enh-menu-item" data-session-action="pin">${sessionPinIcon}<span>${pinned ? "取消置顶" : "置顶会话"}</span></div>
      <div class="pi-enh-menu-item" data-session-action="toggle-unread">${unread ? sessionReadIcon : sessionUnreadIcon}<span>${unread ? "标为已读" : "标为未读"}</span></div>
      <div class="pi-enh-menu-item" data-session-action="rename"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg><span>重命名</span></div>
      <div class="pi-enh-menu-item" data-session-action="reload"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg><span>从磁盘重载 (Alt+R)</span></div>
      <div class="pi-enh-menu-sep"></div>
      <div class="pi-enh-menu-item" data-session-action="archive">${sessionArchiveIcon}<span>归档会话</span></div>
      <div class="pi-enh-menu-item pi-enh-menu-item-danger" data-session-action="delete" data-stage="init" title="点击一次进入确认，再次点击彻底删除"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg><span>删除会话</span></div>
    `;
    document.body.appendChild(menu);
    activeMenu = menu;
    const triggerRect = typeof trigger?.getBoundingClientRect === "function"
      ? trigger.getBoundingClientRect()
      : { right: 0, bottom: 0, top: 0, left: 0 };
    const menuRect = typeof menu.getBoundingClientRect === "function" ? menu.getBoundingClientRect() : {};
    const menuWidth = menuRect.width || menu.offsetWidth || 210;
    const menuHeight = menuRect.height || menu.offsetHeight || 220;
    const PADDING = 8;

    let posX = (triggerRect.right || 0) - menuWidth;
    posX = Math.max(PADDING, Math.min(posX, window.innerWidth - menuWidth - PADDING));

    const fitsBelow = (triggerRect.bottom || 0) + 4 + menuHeight <= window.innerHeight - PADDING;
    const fitsAbove = (triggerRect.top || 0) - 4 - menuHeight >= PADDING;
    let posY;
    if (fitsBelow) {
      posY = (triggerRect.bottom || 0) + 4;
    } else if (fitsAbove) {
      posY = (triggerRect.top || 0) - 4 - menuHeight;
    } else {
      posY = Math.max(PADDING, window.innerHeight - menuHeight - PADDING);
    }

    menu.style.left = `${Math.round(posX)}px`;
    menu.style.top = `${Math.round(posY)}px`;

    const deleteMenuItem = menu.querySelector('[data-session-action="delete"]');
    menu._deleteConfirmItem = deleteMenuItem;
    const resetDeleteMenuItem = () => {
      if (!deleteMenuItem) return;
      if (deleteMenuItem._confirmTimer) {
        clearManagedTimeout(deleteMenuItem._confirmTimer);
        deleteMenuItem._confirmTimer = null;
      }
      deleteMenuItem.setAttribute("data-stage", "init");
      deleteMenuItem.classList.remove("pi-enh-menu-item-confirming");
      deleteMenuItem.title = "点击一次进入确认，再次点击彻底删除";
      deleteMenuItem.innerHTML = `${sessionDeleteIcon}<span>删除会话</span>`;
    };
    const armDeleteMenuItem = () => {
      if (!deleteMenuItem) return;
      deleteMenuItem.setAttribute("data-stage", "confirm");
      deleteMenuItem.classList.add("pi-enh-menu-item-confirming");
      deleteMenuItem.title = "再次点击彻底删除此会话";
      deleteMenuItem.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg><span>确认删除</span>`;
      if (deleteMenuItem._confirmTimer) clearManagedTimeout(deleteMenuItem._confirmTimer);
      deleteMenuItem._confirmTimer = addManagedTimeout(resetDeleteMenuItem, 4000);
    };

    menu.addEventListener("click", (event) => {
      const item = event.target.closest("[data-session-action]");
      const action = item?.getAttribute("data-session-action");
      if (!action) return;
      event.stopPropagation();
      if (action === "delete") {
        if ((item.getAttribute("data-stage") || "init") !== "confirm") {
          armDeleteMenuItem();
          return;
        }
        resetDeleteMenuItem();
      }
      closeMenu();
      handleSessionPinArchiveAction(sessionId, action);
    });
  }

  function syncSessionPinArchiveControls() {
    if (!isPluginEnabled("session-pin-archive")) {
      removeSessionPinArchiveControls();
      return;
    }
    document.documentElement.classList.add("pi-enh-session-pin-archive-active");
    const pinnedIds = readStoredSessionIds(PINNED_SESSION_STORAGE_KEY);
    const sessionRows = Array.from(document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]"));
    for (const row of sessionRows) {
      const sessionId = row.getAttribute("data-pi-enh-session-id");
      if (!sessionId) continue;
      const isPinned = pinnedIds.has(sessionId);
      let indicator = row.querySelector(".pi-enh-session-pinned-indicator");
      if (isPinned) {
        // The pin marker is an action, not a passive decoration: clicking it
        // immediately toggles the current row back to unpinned.
        if (!indicator || indicator.tagName?.toLowerCase() !== "button") {
          indicator?.remove();
          indicator = document.createElement("button");
          indicator.type = "button";
          indicator.className = "pi-enh-session-pinned-indicator";
          indicator.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            handleSessionPinArchiveAction(sessionId, "pin");
          });
        }
        indicator.setAttribute("title", "取消置顶");
        indicator.setAttribute("aria-label", "取消置顶");
        indicator.setAttribute("aria-pressed", "true");
        indicator.innerHTML = sessionPinIcon;
      } else if (indicator) {
        indicator.remove();
        indicator = null;
      }

      let trigger = row.querySelector(".pi-enh-session-overflow");
      if (!trigger) {
        trigger = document.createElement("button");
        trigger.type = "button";
        trigger.className = "pi-enh-session-overflow";
        trigger.setAttribute("aria-label", "会话更多操作");
        trigger.setAttribute("title", "更多操作");
        trigger.innerHTML = sessionOverflowIcon;
      }
      if (!trigger._piEnhOverflowBound) {
        trigger._piEnhOverflowBound = true;
        trigger.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (typeof window.__PI_ENH_DISMISS_SNAPSHOT_OVERLAY__ === "function") {
            try { window.__PI_ENH_DISMISS_SNAPSHOT_OVERLAY__("menu-trigger-clicked"); } catch (e) {}
          }
          if (typeof window.__PI_ENH_DISMISS_LOADING_PLACEHOLDER__ === "function") {
            try { window.__PI_ENH_DISMISS_LOADING_PLACEHOLDER__("menu-trigger-clicked"); } catch (e) {}
          }
          showSessionOverflowMenu(sessionId, trigger);
        });
      }
      // React may add its native action container after our controls. Re-append
      // the overflow button on every sync so it is always the final row item.
      if (row.children[row.children.length - 1] !== trigger) row.appendChild(trigger);

      // 关键修复：确保置顶图钉 indicator 紧随内容之后、排在 trigger (overflow) 之前，绝不落在第一位
      if (isPinned && indicator) {
        if (indicator.nextSibling !== trigger) {
          row.insertBefore(indicator, trigger);
        }
      }
    }
    reconcileUnreadSessions();
  }

  function syncSearchResultsArchivedDecoration() {
    if (!isPluginEnabled("session-pin-archive")) return;
    // Older plugin versions inserted dividers outside React's virtual tree.
    // Remove any leftovers once; the current divider is a CSS pseudo-element
    // on React's first archived result and therefore cannot duplicate.
    for (const divider of document.querySelectorAll(".pi-enh-search-group-divider")) {
      divider.remove();
    }

    const archivedIds = readStoredSessionIds(ARCHIVED_SESSION_STORAGE_KEY);
    const searchButtons = document.querySelectorAll("button[data-search-session-id]");
    if (searchButtons.length === 0) return;

    for (const btn of searchButtons) {
      const sessionId = btn.getAttribute("data-search-session-id");
      if (!sessionId || !archivedIds.has(sessionId)) {
        btn.classList.remove("pi-enh-search-archived-item");
        btn.querySelector(".pi-enh-search-archived-badge")?.remove();
        btn.querySelector(".pi-enh-search-restore-btn")?.remove();
        continue;
      }

      btn.classList.add("pi-enh-search-archived-item");

      const titleSpan = btn.querySelector("span.truncate") || btn.querySelector("span");
      if (titleSpan && !titleSpan.querySelector(".pi-enh-search-archived-badge")) {
        const badge = document.createElement("span");
        badge.className = "pi-enh-search-archived-badge";
        badge.textContent = "已归档";
        titleSpan.appendChild(badge);
      }

      const metaRow = btn.querySelector("span.mt-1.flex") || btn.firstElementChild;
      if (metaRow && !metaRow.querySelector(".pi-enh-search-restore-btn")) {
        const restoreBtn = document.createElement("span");
        restoreBtn.className = "pi-enh-search-restore-btn";
        restoreBtn.setAttribute("title", "一键还原至活跃会话");
        restoreBtn.innerHTML = `
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>
          <span>还原</span>
        `;
        restoreBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          restoreArchivedSession(sessionId);
          requestSessionListRefresh();
          showToast("已还原会话", sessionArchiveIcon);
          addManagedTimeout(syncSearchResultsArchivedDecoration, 50);
        });
        metaRow.appendChild(restoreBtn);
      }
    }
  }

  addManagedListener(window, "pi-web:session-row-contextmenu", (event) => {
    if (!isPluginEnabled("context-menu")) return;
    event.preventDefault();
    closeMenu();

    // 长按/右键菜单弹出时，立即清空任何残留的文本选区并隐藏引用工具条
    closeNativeQuoteSelectionToolbar();
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        sel.removeAllRanges();
      }
    } catch (_) {}

    const { id, path, cwd, name, clientX, clientY } = event.detail || {};
    if (!id) return;

    const menu = document.createElement("div");
    menu.className = "pi-enh-menu";
    const displayName = name || id.slice(0, 18) + "...";

    menu.innerHTML = `
      <div class="pi-enh-menu-header" title="${id}">会话: ${displayName}</div>
      <div class="pi-enh-menu-sep"></div>
      <div class="pi-enh-menu-item" data-action="toggle-unread">
        ${isSessionUnread(id) ? sessionReadIcon : sessionUnreadIcon}
        <span>${isSessionUnread(id) ? "标为已读" : "标为未读"}</span>
      </div>
      <div class="pi-enh-menu-item" data-action="rename-session">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
        <span>重命名会话</span>
      </div>
      ${isPluginEnabled("session-pin-archive") ? `
      <div class="pi-enh-menu-item" data-action="archive-session">
        ${sessionArchiveIcon}
        <span>归档会话</span>
      </div>
      ` : ""}
      ${isPluginEnabled("session-tags") ? `
      <div class="pi-enh-menu-item pi-enh-menu-item-with-arrow" data-action="open-session-tags">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
          <line x1="7" y1="7" x2="7.01" y2="7"></line>
        </svg>
        <span>会话标签</span>
        <span class="pi-enh-menu-arrow" style="margin-left:auto;opacity:0.6;font-size:11px;">▶</span>
      </div>
      ` : ""}
      <div class="pi-enh-menu-sep"></div>
      <div class="pi-enh-menu-item" data-action="copy-id">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        <span>复制会话 ID (Session ID)</span>
      </div>
      <div class="pi-enh-menu-item" data-action="copy-url">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
        <span>复制会话链接 (Session URL)</span>
      </div>
      <div class="pi-enh-menu-item" data-action="copy-path">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
        <span>复制会话文件完整路径</span>
      </div>
      <div class="pi-enh-menu-item" data-action="copy-prompt">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><path d="M10 8h4"></path><path d="M10 12h4"></path></svg>
        <span>复制 Agent 接力提示词 (Codex/其他)</span>
      </div>
      <div class="pi-enh-menu-sep"></div>
      <div class="pi-enh-menu-item" data-action="copy-cwd">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        <span>复制项目工作目录</span>
      </div>
      <div class="pi-enh-menu-item" data-action="reload-session">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
        <span>从磁盘重载 (Alt+R)</span>
      </div>
      ${renderSessionColorMenuItems(id)}
    `;

    document.body.appendChild(menu);
    activeMenu = menu;

    const menuRect = typeof menu.getBoundingClientRect === "function" ? menu.getBoundingClientRect() : {};
    const menuWidth = menuRect.width || menu.offsetWidth || 250;
    const menuHeight = menuRect.height || menu.offsetHeight || 420;
    const PADDING = 8;

    let posX = Number(clientX) || 0;
    let posY = Number(clientY) || 0;

    // 水平定位：默认在鼠标右侧，若超出右边界则向左翻转或贴右边缘展示
    if (posX + menuWidth > window.innerWidth - PADDING) {
      if (posX - menuWidth >= PADDING) {
        posX = posX - menuWidth;
      } else {
        posX = window.innerWidth - menuWidth - PADDING;
      }
    }
    posX = Math.max(PADDING, posX);

    // 垂直定位：默认在鼠标下方，若超出下边界则优先向上翻转，若上下均不足则贴底/视口安全约束
    if (posY + menuHeight > window.innerHeight - PADDING) {
      if (posY - menuHeight >= PADDING) {
        posY = posY - menuHeight;
      } else {
        posY = window.innerHeight - menuHeight - PADDING;
      }
    }
    posY = Math.max(PADDING, posY);

    menu.style.left = `${Math.round(posX)}px`;
    menu.style.top = `${Math.round(posY)}px`;

    // 鼠标悬停自动展开会话标签二级菜单 (Hover Cascading Submenu)
    const tagsMenuItem = menu.querySelector('.pi-enh-menu-item[data-action="open-session-tags"]');
    if (tagsMenuItem) {
      tagsMenuItem.addEventListener("mouseenter", () => {
        if (tagsMenuItem._closeSubmenuTimer) {
          clearTimeout(tagsMenuItem._closeSubmenuTimer);
          tagsMenuItem._closeSubmenuTimer = null;
        }
        if (!activeSessionTagsPopover) {
          tagsMenuItem._openSubmenuTimer = setTimeout(() => {
            const triggerRect = tagsMenuItem.getBoundingClientRect();
            openSessionTagsPopover(id, tagsMenuItem, null, triggerRect);
          }, 120);
        } else {
          tagsMenuItem.classList.add("is-submenu-open");
        }
      });

      tagsMenuItem.addEventListener("mouseleave", () => {
        if (tagsMenuItem._openSubmenuTimer) {
          clearTimeout(tagsMenuItem._openSubmenuTimer);
          tagsMenuItem._openSubmenuTimer = null;
        }
        if (activeSessionTagsPopover) {
          // 若子菜单内输入框聚焦中，绝不启动关闭定时器
          if (document.activeElement && activeSessionTagsPopover.contains(document.activeElement)) {
            return;
          }
          tagsMenuItem._closeSubmenuTimer = setTimeout(() => {
            if (document.activeElement && activeSessionTagsPopover?.contains(document.activeElement)) {
              return;
            }
            closeSessionTagsPopover(false);
          }, 220);
        }
      });

      // 鼠标移动到主菜单其他项时，迅速收起二级菜单
      const siblingItems = menu.querySelectorAll('.pi-enh-menu-item:not([data-action="open-session-tags"])');
      for (const sib of siblingItems) {
        sib.addEventListener("mouseenter", () => {
          if (tagsMenuItem._openSubmenuTimer) {
            clearTimeout(tagsMenuItem._openSubmenuTimer);
            tagsMenuItem._openSubmenuTimer = null;
          }
          // 关键防护：如果子菜单内的输入框已经获得焦点（用户输入文字中），哪怕鼠标不小心滑过兄弟项，也绝不能杀死子菜单！
          if (activeSessionTagsPopover && document.activeElement && activeSessionTagsPopover.contains(document.activeElement)) {
            return;
          }
          if (activeSessionTagsPopover) {
            closeSessionTagsPopover(false);
          }
        });
      }
    }

    menu.addEventListener("click", (e) => {
      const item = e.target.closest("[data-action]");
      if (!item) return;
      const action = item.dataset.action;

      if (action === "toggle-unread") {
        closeMenu();
        const unread = toggleSessionUnread(id);
        showToast(unread ? "已标为未读" : "已标为已读", unread ? sessionUnreadIcon : sessionReadIcon);
        return;
      } else if (action === "rename-session") {
        closeMenu();
        triggerSessionInlineRename(id);
        return;
      } else if (action === "archive-session") {
        closeMenu();
        handleSessionPinArchiveAction(id, "archive");
        return;
      } else if (action === "open-session-tags") {
        e.stopPropagation();
        const triggerRect = item.getBoundingClientRect();
        if (!activeSessionTagsPopover) {
          openSessionTagsPopover(id, item, e, triggerRect);
        } else {
          const searchInput = activeSessionTagsPopover.querySelector(".pi-enh-tags-search-input");
          if (searchInput) searchInput.focus();
        }
        return;
      } else if (action === "copy-id") {
        copyText(id, `已复制会话 ID: ${id.slice(0, 12)}...`);
      } else if (action === "copy-url") {
        const origin = window.location ? window.location.origin : "";
        const url = `${origin}/?session=${encodeURIComponent(id)}`;
        copyText(url, `已复制会话链接: ${id.slice(0, 12)}...`);
      } else if (action === "copy-path") {
        copyText(path || "", `已复制会话文件路径`);
      } else if (action === "copy-prompt") {
        const prompt = `这是我之前的 Pi 会话（ID: ${id}，文件路径: ${path || ""}，工作目录: ${cwd || ""}）。请读取并分析该会话的上下文记录与遗留任务，接着继续推进下一步工作。`;
        copyText(prompt, `已复制跨 Agent 接力提示词`);
      } else if (action === "copy-cwd") {
        copyText(cwd || "", `已复制工作目录`);
      } else if (action === "reload-session") {
        if (typeof window.__PI_ENH_RELOAD_SPECIFIC_SESSION__ === "function") {
          window.__PI_ENH_RELOAD_SPECIFIC_SESSION__(id, true);
        }
      } else if (action === "set-session-color") {
        const color = item.getAttribute("data-session-color") || "";
        const preset = SESSION_COLOR_PRESETS.find((candidate) => candidate.id === color);
        if (setSessionColor(id, color)) showToast(`已设为${preset?.name || "所选"}背景`);
      } else if (action === "clear-session-color") {
        if (clearSessionColor(id)) showToast("已清除会话背景颜色");
      }
      closeMenu();
    });
  });

  // ==========================================
  // 会话双击重命名 (Session DblClick Rename)
  // 手机（含折叠屏展开及桌面模式）不以视口宽度或输入模式偏好判定。
  // ==========================================
  function isMobileSessionRenameDisabled(event) {
    if (event?.sourceCapabilities?.firesTouchEvents || event?.pointerType === "touch" || event?.pointerType === "pen") return true;
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
    if ((/Macintosh/i.test(ua) || navigator.platform === "MacIntel") && navigator.maxTouchPoints > 1) return true;
    return window.matchMedia("(pointer: coarse) and (hover: none)").matches;
  }

  function handleSessionRowDblClick(event) {
    if (!isPluginEnabled("session-dblclick-rename")) return;
    // 手机端/移动端触屏完全取消双击编辑会话标题功能
    if (isMobileSessionRenameDisabled(event)) return;

    const target = event.target;
    // 忽略控制类按钮、链接、输入框、下拉框、或者增强插件控制按钮的点击
    if (target.closest("button, a, input, select, textarea, [role='button'], .pi-enh-session-overflow, .pi-enh-session-pinned-indicator, .pi-enh-session-menu")) {
      return;
    }
    const row = target.closest(".pi-enh-session-row-host[data-pi-enh-session-id]");
    if (!row) return;

    // 若当前行已处于编辑状态，无需重复触发
    if (row.querySelector("input") || row.getAttribute("data-pi-enh-editing") === "true") {
      return;
    }

    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    window.getSelection()?.removeAllRanges();

    const sessionId = row.getAttribute("data-pi-enh-session-id");
    if (sessionId) {
      triggerSessionInlineRename(sessionId);
    }
  }

  function handleSessionRowMouseDown(event) {
    if (!isPluginEnabled("session-dblclick-rename")) return;
    // 手机端/移动端触屏不拦截与处理
    if (isMobileSessionRenameDisabled(event)) return;

    if (event.detail >= 2) {
      const target = event.target;
      if (target.closest("button, a, input, select, textarea, [role='button'], .pi-enh-session-overflow, .pi-enh-session-pinned-indicator, .pi-enh-session-menu")) {
        return;
      }
      const row = target.closest(".pi-enh-session-row-host[data-pi-enh-session-id]");
      if (row) {
        // 防止双击选中文本
        event.preventDefault();
      }
    }
  }

  addManagedListener(document, "dblclick", handleSessionRowDblClick, true);
  addManagedListener(document, "mousedown", handleSessionRowMouseDown, true);

  // 会话行内重命名焦点与失焦自愈联动：聚焦即刻隐藏模型徽标，失焦即刻精准恢复
  addManagedListener(document, "focusin", (event) => {
    const input = event.target;
    if (input?.tagName === "INPUT" && input.type === "text" && input.closest?.(".pi-enh-session-row-host")) {
      const row = input.closest(".pi-enh-session-row-host");
      row?.setAttribute("data-pi-enh-editing", "true");
      row?.querySelector(".pi-enh-session-model-badge")?.remove();
      // 记录聚焦时的原始标题，便于空文本回滚
      if (!input.hasAttribute("data-pi-enh-orig-title")) {
        const sessionId = row?.getAttribute("data-pi-enh-session-id");
        const origTitle = input.value || (sessionId ? extractSessionTitleFromRow(row, sessionId) : "") || "";
        input.setAttribute("data-pi-enh-orig-title", origTitle);
      }
    }
  }, true);

  // 关键防护与便捷交互：
  // 1. Ctrl+Z / Cmd+Z 一键撤销还原到进入编辑时的初始标题文本
  // 2. 当用户在会话名称输入框按下回车提交空文本时，阻止清空、弹出温和提示并自动恢复原标题
  addManagedListener(document, "keydown", (event) => {
    const input = event.target;
    if (input?.tagName !== "INPUT" || input.type !== "text" || !input.closest?.(".pi-enh-session-row-host")) return;

    // 1. Ctrl+Z / Cmd+Z 一键还原初始标题文本
    if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z") && !event.shiftKey) {
      const origTitle = input.getAttribute("data-pi-enh-orig-title");
      if (origTitle !== null && input.value !== origTitle) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(input, origTitle);
          else input.value = origTitle;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        } catch (e) {}

        requestAnimationFrame(() => {
          input.select();
        });
        showToast("已还原初始标题", sessionPinIcon, 1500);
        return;
      }
    }

    // 2. 回车提交空文本拦截
    if (event.key === "Enter") {
      const rawVal = input.value || "";
      if (!rawVal.trim()) {
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

        const origTitle = input.getAttribute("data-pi-enh-orig-title") || "";
        showToast("会话名称不能为空", sessionWarnIcon, 2500);

        // 还原 input 现实值并触发 Escape 退出编辑，保留原标题
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(input, origTitle);
          else input.value = origTitle;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        } catch (e) {}

        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        }));
      }
    }
  }, true);

  addManagedListener(document, "focusout", (event) => {
    const input = event.target;
    if (input?.tagName === "INPUT" && input.type === "text" && input.closest?.(".pi-enh-session-row-host")) {
      const row = input.closest(".pi-enh-session-row-host");
      const rawVal = input.value || "";
      if (!rawVal.trim()) {
        const origTitle = input.getAttribute("data-pi-enh-orig-title") || "";
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
          if (setter) setter.call(input, origTitle);
          else input.value = origTitle;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        } catch (e) {}

        showToast("会话名称不能为空", sessionWarnIcon, 2500);

        input.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        }));
      }

      setTimeout(() => {
        if (row && !row.querySelector('input:not([type="checkbox"])')) {
          row.removeAttribute("data-pi-enh-editing");
        }
        if (typeof syncSessionModelLabels === "function") syncSessionModelLabels();
        if (typeof syncSessionPinArchiveControls === "function") syncSessionPinArchiveControls();
      }, 50);
      setTimeout(() => {
        if (typeof syncSessionModelLabels === "function") syncSessionModelLabels();
        if (typeof syncSessionPinArchiveControls === "function") syncSessionPinArchiveControls();
      }, 250);
    }
  }, true);

  addManagedListener(document, "click", (e) => {
    if (activeMenu && !activeMenu.contains(e.target) && !(activeSessionTagsPopover && activeSessionTagsPopover.contains(e.target))) {
      closeMenu();
    }
  });
  addManagedListener(window, "blur", closeMenu);
  function handleGlobalEscapeKey(e) {
    if (e.key !== "Escape" && e.keyCode !== 27) return;
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;

    // Native Settings owns focus, nested dialogs and Escape. Do not bypass
    // that owner by clicking its close button from a global capture listener.
    if (document.querySelector(".settings-dialog-backdrop")) return;

    // 0. 最高优先级：关闭全屏大图预览 / 退出标注编辑 (全屏最高 z-index 模态层最优先响应，保障 MacBook 等环境)
    const zoomDialog = (typeof activeZoomDialog !== "undefined" && activeZoomDialog && activeZoomDialog.open)
      ? activeZoomDialog
      : document.querySelector("dialog.image-preview-dialog[open], dialog.pi-enh-image-zoom-dialog[open]");
    if (zoomDialog) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

      if (typeof zoomDialog.__piEnhHandleEscape === "function") {
        zoomDialog.__piEnhHandleEscape();
        return;
      }
      const closeBtn = zoomDialog.querySelector(".image-preview-close, button[aria-label*='关闭'], button[title*='关闭']");
      if (closeBtn && typeof closeBtn.click === "function") {
        closeBtn.click();
        return;
      }
      if (typeof zoomDialog.__piEnhCleanup === "function") {
        zoomDialog.__piEnhCleanup();
        return;
      }
      if (typeof closeComposerImageZoomModal === "function") {
        closeComposerImageZoomModal();
        return;
      }
      try { zoomDialog.close?.(); } catch (err) {}
      try { zoomDialog.remove?.(); } catch (err) {}
      return;
    }

    // 选择目录弹窗响应 Esc 退出
    const directoryPicker = document.querySelector(".directory-picker-panel");
    if (directoryPicker) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

      const newFolderRow = directoryPicker.querySelector(".directory-picker-new-folder-row");
      if (newFolderRow) {
        newFolderRow.remove();
        return;
      }

      const closeBtn = directoryPicker.querySelector("div:first-child button[title], button[aria-label*='关闭'], button[aria-label*='close']");
      if (closeBtn) {
        closeBtn.click();
        return;
      }

      const backdrop = directoryPicker.closest(".directory-picker-backdrop") || document.querySelector(".directory-picker-backdrop");
      if (backdrop && typeof backdrop.click === "function") {
        backdrop.click();
        return;
      }
    }

    if (usageDashboardModal) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      closeUsageDashboard();
      return;
    }

    // 会话批量删除确认弹窗优先响应 Esc 关闭
    if (batchDeleteModal) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      closeBatchDeleteModal();
      return;
    }

    // 处于会话批量管理模式时，按 Esc 退出批量管理模式
    if (isSessionBatchMode && isPluginEnabled("session-batch-actions")) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      setSessionBatchMode(false);
      return;
    }

    // 注释编辑框是当前最上层交互：Esc 只退出编辑，不删除已保存注释。
    if (annotationEditor) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      closeAnnotationEditor();
      return;
    }

    // 2. 次高优先级：关闭自定义右键菜单、引用工具条与耗时/消耗浮层
    let overlayClosed = false;
    if (activeSessionTagsPopover) {
      closeSessionTagsPopover(false);
      overlayClosed = true;
    } else if (activeMenu) {
      closeMenu();
      overlayClosed = true;
    }
    if (closeNativeQuoteSelectionToolbar()) overlayClosed = true;
    const hadTooltips = Boolean(
      (durationTooltip && durationTooltip.parentNode) ||
      (usageTooltip && usageTooltip.parentNode) ||
      document.querySelector(".pi-enh-tooltip, .pi-enh-duration-tooltip, .pi-enh-usage-tooltip")
    );
    if (hadTooltips) {
      hideAllTooltips();
      overlayClosed = true;
    } else {
      hideAllTooltips();
    }

    // 优先关闭已有 activeMenu/quote 浮层而不继续关闭搜索；仅确有浮层关闭时 stop
    if (overlayClosed) {
      if (typeof e.preventDefault === "function") e.preventDefault();
      if (typeof e.stopPropagation === "function") e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
      return;
    }

    // 3. 第三优先级：退出会话搜索 (关闭搜索框并回焦主输入框)
    if (isPluginEnabled("session-search-shortcut")) {
      const isSearchOpen = typeof isSessionSearchOpen === "function" && isSessionSearchOpen();
      const activeEl = document.activeElement;
      const isTargetSearchInput = activeEl && (activeEl.id === "session-search-input" || activeEl.closest?.("#session-search-input"));
      const isEventSearchInput = e.target && (e.target.id === "session-search-input" || e.target.closest?.("#session-search-input"));

      if (isSearchOpen || isTargetSearchInput || isEventSearchInput) {
        const btn = typeof getSessionSearchButton === "function" ? getSessionSearchButton() : null;
        if (btn) {
          if (typeof e.preventDefault === "function") e.preventDefault();
          if (typeof e.stopPropagation === "function") e.stopPropagation();
          if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

          btn.click();
          const searchInput = typeof getSessionSearchInput === "function" ? getSessionSearchInput() : null;
          if (searchInput) {
            try { searchInput.blur(); } catch (err) {}
          }
          const composer = Array.from(document.querySelectorAll(".pi-enh-formatted-composer, .chat-input-textarea, textarea.chat-input, textarea")).find((el) => el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyle(el).visibility !== "hidden");
          if (composer) {
            try { composer.focus(); } catch (err) {}
          }
          return;
        }
      }
    }

    // 4. 底层兜底：esc-guard 拦截意外 Escape 导致的任务中断
    if (isPluginEnabled("esc-guard")) {
      const target = e.target;
      const isInput = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      const nativeTextarea = document.querySelector?.("textarea.chat-input-textarea");
      const formattedComposer = target?.closest?.(".pi-enh-formatted-composer");
      const nativeFieldset = nativeTextarea?.closest?.("[data-pi-native-composer-host]");
      const formattedFieldset = formattedComposer?.closest?.("[data-pi-native-composer-host]");
      const isMainComposer = target === nativeTextarea || Boolean(
        formattedComposer && nativeFieldset && formattedFieldset === nativeFieldset
      );
      const isImeEscape = Boolean(
        e.isComposing || e.keyCode === 229 || (typeof isComposingInput !== "undefined" && isComposingInput)
      );
      const completionOwnsEscape = isMainComposer && !isImeEscape
        && typeof isComposerCompletionKey === "function"
        && isComposerCompletionKey(e, nativeTextarea);
      const hasRunningTask = Boolean(typeof isLiveRunning === "function" ? isLiveRunning() : findActiveStopButton());
      if (hasRunningTask && !isImeEscape && !completionOwnsEscape && (isMainComposer || !isInput)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }
  }

  addManagedListener(document, "keydown", handleGlobalEscapeKey, true);
  window.__PI_ENH_HANDLE_GLOBAL_ESCAPE_KEY__ = handleGlobalEscapeKey;

  function handleGlobalShortcuts(e) {
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "r" || e.key === "R" || e.code === "KeyR")) {
      const sid = getCurrentSessionId();
      if (sid && typeof window.__PI_ENH_RELOAD_CURRENT_SESSION__ === "function") {
        e.preventDefault();
        e.stopPropagation();
        window.__PI_ENH_RELOAD_CURRENT_SESSION__(true);
      }
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "u" || e.key === "U" || e.code === "KeyU")) {
      if (typeof window.__PI_ENH_TOGGLE_USAGE_DASHBOARD__ === "function") {
        e.preventDefault();
        e.stopPropagation();
        window.__PI_ENH_TOGGLE_USAGE_DASHBOARD__();
      }
    }
  }
  addManagedListener(document, "keydown", handleGlobalShortcuts, true);

  function closeNativeQuoteSelectionToolbar() {
    const close = window.__PI_WEB_CLOSE_NATIVE_QUOTE_SELECTION__;
    return typeof close === "function" ? Boolean(close()) : false;
  }

  // ==========================================
  // 2. Quick Action Quote Toolbar (快捷引用工具条)
  // ==========================================
  const ANNOTATION_STORAGE_PREFIX = "pi-enh-annotations-v1:";
  let annotationSessionId = "";
  let annotationItems = [];
  const annotationAnchors = new Map();
  let annotationDraftMarker = null;
  let lastAnnotationSubmissionState = null;

  function getAnnotationSessionId() {
    try {
      return new URLSearchParams(window.location.search || "").get("session") || "draft";
    } catch {
      return "draft";
    }
  }

  function normalizeAnnotationText(value) {
    return String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/<\/??pi_annotations>/gi, "")
      .trim();
  }

  function ensureAnnotationSession() {
    const nextSessionId = getAnnotationSessionId();
    if (nextSessionId === annotationSessionId) return;
    annotationSessionId = nextSessionId;
    annotationItems = [];
    annotationAnchors.clear();
    removeAnnotationMarkers();
    closeAnnotationEditor();
    closeAnnotationList();
    try {
      const saved = JSON.parse(localStorage.getItem(ANNOTATION_STORAGE_PREFIX + annotationSessionId) || "[]");
      if (Array.isArray(saved)) {
        annotationItems = saved
          .filter((item) => item && typeof item.quote === "string")
          .map((item) => ({
            id: String(item.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
            quote: normalizeAnnotationText(item.quote),
            comment: normalizeAnnotationText(item.comment),
            createdAt: Number(item.createdAt) || Date.now(),
          }))
          .filter((item) => item.quote);
      }
    } catch {}
  }

  function persistAnnotations() {
    try {
      localStorage.setItem(ANNOTATION_STORAGE_PREFIX + annotationSessionId, JSON.stringify(annotationItems));
    } catch {}
  }

  function listAnnotations() {
    ensureAnnotationSession();
    return annotationItems.map((item) => ({ ...item }));
  }

  function notifyAnnotationSubmissionState() {
    const hasAnnotations = isPluginEnabled("quick-quote") && annotationItems.length > 0;
    if (lastAnnotationSubmissionState === hasAnnotations) return;
    lastAnnotationSubmissionState = hasAnnotations;
    window.dispatchEvent(new Event("pi-enh-composer-submission-state-change"));
  }

  function addAnnotation(quote, comment) {
    ensureAnnotationSession();
    const normalizedQuote = normalizeAnnotationText(quote);
    if (!normalizedQuote) return listAnnotations();
    annotationItems.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      quote: normalizedQuote,
      comment: normalizeAnnotationText(comment),
      createdAt: Date.now(),
    });
    persistAnnotations();
    notifyAnnotationSubmissionState();
    return listAnnotations();
  }

  function removeAnnotation(id) {
    ensureAnnotationSession();
    annotationItems = annotationItems.filter((item) => item.id !== id);
    annotationAnchors.delete(id);
    document.querySelector(`.pi-enh-annotation-marker[data-annotation-id="${id}"]`)?.remove();
    closeNativeQuoteSelectionToolbar();
    persistAnnotations();
    syncAnnotationMarkers();
    notifyAnnotationSubmissionState();
    return listAnnotations();
  }

  function updateAnnotation(id, quote, comment) {
    ensureAnnotationSession();
    const item = annotationItems.find((entry) => entry.id === id);
    const normalizedQuote = normalizeAnnotationText(quote);
    if (!item || !normalizedQuote) return listAnnotations();
    item.quote = normalizedQuote;
    item.comment = normalizeAnnotationText(comment);
    persistAnnotations();
    notifyAnnotationSubmissionState();
    return listAnnotations();
  }

  function clearAnnotations() {
    ensureAnnotationSession();
    annotationItems = [];
    annotationAnchors.clear();
    removeAnnotationMarkers();
    closeNativeQuoteSelectionToolbar();
    persistAnnotations();
    notifyAnnotationSubmissionState();
    return [];
  }

  function annotationLabel() {
    return `${listAnnotations().length} 条注释`;
  }

  function serializeAnnotations(body) {
    const normalizedBody = String(body || "").trim();
    const items = listAnnotations();
    if (!items.length) return normalizedBody;
    const blocks = items.map((item, index) => {
      const quoteLines = item.quote
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const firstLine = quoteLines[0] || "";
      const otherLines = quoteLines.slice(1);
      const lines = [`> **引用 [${index + 1}]**：${firstLine}`];
      for (const line of otherLines) {
        lines.push(`> ${line}`);
      }
      if (item.comment && item.comment.trim()) {
        const commentLines = item.comment.trim().split("\n");
        lines.push(`> **注释**：${commentLines[0]}`);
        for (let i = 1; i < commentLines.length; i += 1) {
          lines.push(`> ${commentLines[i]}`);
        }
      }
      return lines.join("\n");
    });
    const header = blocks.join("\n\n");
    return normalizedBody ? `${header}\n\n${normalizedBody}` : header;
  }

  let annotationBadge = null;
  let annotationRail = null;

  function getComposerTextarea() {
    return document.querySelector("textarea.chat-input-textarea") ||
      document.querySelector('textarea[style*="fontFamily"]') ||
      document.querySelector("form textarea") ||
      document.querySelector("textarea");
  }

  function focusComposerTextarea() {
    const doFocus = () => {
      // 1. 优先对焦可见的格式化输入框
      const formatted = document.querySelector(".pi-enh-formatted-composer");
      if (formatted && (formatted.offsetWidth > 0 || formatted.offsetParent !== null || window.getComputedStyle?.(formatted).display !== "none")) {
        try {
          formatted.focus();
          const sel = window.getSelection();
          if (sel) {
            const range = document.createRange();
            range.selectNodeContents(formatted);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
          return true;
        } catch (e) {}
      }

      // 2. 原生 textarea
      const textarea = getComposerTextarea();
      if (textarea && (textarea.offsetWidth > 0 || textarea.offsetParent !== null || window.getComputedStyle?.(textarea).display !== "none")) {
        try {
          textarea.focus();
          const len = textarea.value ? textarea.value.length : 0;
          if (typeof textarea.setSelectionRange === "function") {
            textarea.setSelectionRange(len, len);
          }
          textarea.scrollTop = textarea.scrollHeight;
          return true;
        } catch (e) {}
      }

      // 3. 通用备用对焦：通过点击触发表单内部聚焦
      const composerShell = document.querySelector(".chat-input-container, form fieldset");
      if (composerShell && !document.activeElement?.closest?.(".chat-input-container, form")) {
        try {
          (formatted || textarea)?.focus();
        } catch (e) {}
      }
      return false;
    };

    doFocus();
  }

  function removeAnnotationUi() {
    closeAnnotationEditor();
    closeAnnotationList();
    removeAnnotationMarkers();
    for (const badge of document.querySelectorAll(".pi-enh-annotation-badge")) {
      try { badge.remove(); } catch {}
    }
    annotationBadge = null;
    for (const rail of document.querySelectorAll(".pi-enh-annotation-rail")) {
      try { rail.remove(); } catch {}
    }
    annotationRail = null;
    closeNativeQuoteSelectionToolbar();
  }

  let annotationBatchSelectChecked = false;

  function syncAnnotationComposer() {
    notifyAnnotationSubmissionState();
    if (!isPluginEnabled("quick-quote")) {
      removeAnnotationUi();
      return;
    }
    const textarea = getComposerTextarea();
    const items = listAnnotations();
    if (!textarea || !items.length) {
      closeAnnotationList();
      if (annotationBadge) {
        try { annotationBadge.remove(); } catch {}
      }
      annotationBadge = null;
      if (annotationRail) {
        try { annotationRail.remove(); } catch {}
      }
      annotationRail = null;
      for (const badge of document.querySelectorAll(".pi-enh-annotation-badge")) {
        try { badge.remove(); } catch {}
      }
      for (const rail of document.querySelectorAll(".pi-enh-annotation-rail")) {
        try { rail.remove(); } catch {}
      }
      annotationBatchSelectChecked = false;
      return;
    }
    const composerCard = textarea.closest?.('[data-pi-native-composer-host] > div[style*="max-width"]') ||
                         textarea.closest?.('.pi-enh-cursor-composer') ||
                         textarea.closest?.('[data-pi-native-composer-host]') ||
                         textarea.closest?.('form');
    const composerHost = composerCard?.parentElement || textarea.parentElement?.parentElement || textarea.parentElement;

    if (!annotationRail || !annotationRail.isConnected || annotationRail.parentElement !== composerHost) {
      if (annotationRail && annotationRail.parentElement && annotationRail.parentElement !== composerHost) {
        try { annotationRail.remove(); } catch {}
      }
      if (!annotationRail || !annotationRail.isConnected) {
        annotationRail = document.createElement("section");
        annotationRail.className = "pi-enh-annotation-rail";
        annotationRail.setAttribute("role", "region");
        annotationRail.setAttribute("aria-label", "引用注释栏");
      }
      if (composerCard && composerCard.parentElement) {
        // 不要每次强制rail紧挨card，优先在queuePanel前插入或card前插入，避免与queuePanel互相移动DOM死循环
        const queuePanel = composerCard.parentElement.querySelector?.(".pi-enh-queue-panel");
        const insertTarget = (queuePanel && queuePanel.parentElement === composerCard.parentElement) ? queuePanel : composerCard;
        composerCard.parentElement.insertBefore(annotationRail, insertTarget);
      } else if (composerHost) {
        composerHost.insertBefore(annotationRail, textarea.parentElement || textarea);
      }
    }
    if (composerCard?.style?.maxWidth && annotationRail) {
      annotationRail.style.maxWidth = composerCard.style.maxWidth;
    }

    if (!annotationBadge || !annotationBadge.parentElement || annotationBadge.parentElement !== annotationRail) {
      if (!annotationBadge) {
        annotationBadge = document.createElement("div");
        annotationBadge.className = "pi-enh-annotation-badge";
        annotationBadge.setAttribute("role", "group");
        annotationBadge.setAttribute("aria-label", "引用注释");
        const summary = document.createElement("button");
        summary.type = "button";
        summary.className = "pi-enh-annotation-badge-summary";
        summary.setAttribute("aria-label", "查看引用注释");
        summary.setAttribute("aria-expanded", "false");

        // 规整正方形复选框，自动出现，替代原来残缺的 ::before 伪元素
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "pi-enh-annotation-checkbox";
        checkbox.setAttribute("aria-label", "全选所有注释");
        checkbox.setAttribute("title", "勾选后可一键清空所有注释");
        checkbox.checked = annotationBatchSelectChecked;
        checkbox.addEventListener("click", (e) => {
          e.stopPropagation();
        });
        checkbox.addEventListener("change", (e) => {
          e.stopPropagation();
          annotationBatchSelectChecked = checkbox.checked;
          syncAnnotationComposer();
        });
        summary.appendChild(checkbox);

        const icon = document.createElement("span");
        icon.className = "pi-enh-annotation-badge-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H6l-3 2v-5.5A7.5 7.5 0 1 1 20 11.5Z"/><path d="M8 10h8M8 13.5h5"/></svg>';
        summary.appendChild(icon);

        const label = document.createElement("span");
        label.className = "pi-enh-annotation-badge-label";
        summary.appendChild(label);
        summary.addEventListener("click", (event) => {
          if (event.target === checkbox) return;
          event.stopPropagation();
          cancelAnnotationListClose();
          openAnnotationList();
        });
        annotationBadge.addEventListener("mouseenter", () => {
          cancelAnnotationListClose();
          openAnnotationList();
        });
        annotationBadge.addEventListener("mouseleave", scheduleAnnotationListClose);
        annotationBadge.addEventListener("focusin", cancelAnnotationListClose);
        annotationBadge.addEventListener("focusout", scheduleAnnotationListClose);
        annotationBadge.appendChild(summary);
      }
      if (annotationRail && annotationBadge.parentElement !== annotationRail) {
        annotationRail.appendChild(annotationBadge);
      }
    }
    annotationBadge.setAttribute("data-annotation-count", String(items.length));
    const label = annotationBadge.querySelector(".pi-enh-annotation-badge-label");
    if (label) label.textContent = annotationLabel();
    const checkbox = annotationBadge.querySelector(".pi-enh-annotation-checkbox");
    if (checkbox) checkbox.checked = annotationBatchSelectChecked;

    const existingRemove = annotationBadge.querySelector(".pi-enh-annotation-badge-remove");
    const showRemove = items.length === 1 || (items.length > 1 && annotationBatchSelectChecked);
    if (showRemove) {
      const remove = existingRemove || createAnnotationButton("", "pi-enh-annotation-badge-remove", "");
      if (!existingRemove) {
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
        remove.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const currentItems = listAnnotations();
          if (currentItems.length === 1) {
            removeAnnotation(currentItems[0].id);
          } else if (currentItems.length > 1 && annotationBatchSelectChecked) {
            clearAnnotations();
            showToast(`已清空全部 ${currentItems.length} 条注释`);
          } else {
            return;
          }
          annotationBatchSelectChecked = false;
          closeAnnotationList();
          closeAnnotationEditor();
          syncAnnotationComposer();
        });
        annotationBadge.appendChild(remove);
      }
      const actionLabel = items.length === 1 ? "删除这条注释" : `清空全部 ${items.length} 条注释`;
      remove.setAttribute("aria-label", actionLabel);
      remove.setAttribute("title", actionLabel);
    } else if (existingRemove) {
      existingRemove.remove();
    }
  }

  annotationEditor = null;
  let annotationList = null;
  let annotationEditorState = null;
  let annotationListCloseTimer = null;
  let activeAnnotationSaveHandler = null;
  let annotationEditorOpenedAt = 0;

  function createAnnotationButton(text, className, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    if (label) button.setAttribute("aria-label", label);
    return button;
  }

  function removeAnnotationMarkers() {
    for (const marker of document.querySelectorAll(".pi-enh-annotation-marker")) marker.remove();
    annotationDraftMarker = null;
    try { window.CSS?.highlights?.delete("pi-enh-annotation-selection"); } catch {}
  }

  function syncAnnotationHighlights() {
    try {
      if (!window.CSS?.highlights || typeof window.Highlight !== "function") return;
      const ranges = [];
      for (const anchor of annotationAnchors.values()) {
        if (anchor.range) ranges.push(anchor.range);
      }
      if (annotationEditorState?.range && !ranges.includes(annotationEditorState.range)) ranges.push(annotationEditorState.range);
      if (ranges.length) window.CSS.highlights.set("pi-enh-annotation-selection", new window.Highlight(...ranges));
      else window.CSS.highlights.delete("pi-enh-annotation-selection");
    } catch {}
  }

  function getAnnotationEndRect(range, fallbackRect) {
    try {
      const rects = Array.from(range?.getClientRects?.() || []).filter((rect) => rect && (rect.width || rect.height));
      if (rects.length) return rects.at(-1);
      const bounds = range?.getBoundingClientRect?.();
      if (bounds && (bounds.width || bounds.height)) return bounds;
    } catch {}
    return fallbackRect || null;
  }

  function findLiveQuoteRange(quote, container = null) {
    if (!quote || typeof quote !== "string") return null;
    const cleanQuote = quote.trim();
    if (!cleanQuote) return null;
    const sample = cleanQuote.slice(0, 36);
    const root = container || document.querySelector("main, .chat-window, .message-view") || document.body;
    try {
      if (typeof document.createTreeWalker !== "function") return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent || "";
        const idx = text.indexOf(sample);
        if (idx !== -1) {
          const range = document.createRange();
          range.setStart(node, idx);
          const endIdx = Math.min(text.length, idx + cleanQuote.length);
          range.setEnd(node, endIdx);
          return range;
        }
      }
    } catch {}
    return null;
  }

  function isAnnotationRectVisible(rect, anchorNode = null) {
    if (!rect || (rect.width === 0 && rect.height === 0)) return false;
    const winW = window.innerWidth || 1024;
    const winH = window.innerHeight || 768;

    // 基础视口判断（上下边界）
    if (rect.bottom < 10 || rect.top > winH - 10 || rect.right < 0 || rect.left > winW) {
      return false;
    }

    const chatBounds = getChatViewBoundary();
    // 检查是否已被左侧侧边栏遮挡，或者超出聊天右边界
    if (rect.right < chatBounds.left + 2 || rect.left > chatBounds.right - 2) {
      return false;
    }

    // 检查是否被底部输入框 (Composer) 遮挡
    try {
      const composer = getComposerTextarea();
      const composerRoot = composer?.closest("form") || composer?.parentElement?.parentElement || composer;
      if (composerRoot && typeof composerRoot.getBoundingClientRect === "function") {
        const cRect = composerRoot.getBoundingClientRect();
        if (cRect && cRect.top > 60 && rect.top >= cRect.top - 6) {
          return false;
        }
      }
    } catch {}

    // 检查是否被顶部 Header 遮挡
    try {
      const header = document.querySelector("header, .chat-header, .settings-dialog-header");
      if (header && typeof header.getBoundingClientRect === "function") {
        const hRect = header.getBoundingClientRect();
        if (hRect && hRect.bottom > 0 && rect.bottom <= hRect.bottom + 4) {
          return false;
        }
      }
    } catch {}

    // 检查父级滚动容器的裁剪
    if (anchorNode && anchorNode.nodeType) {
      let parent = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
      while (parent && parent !== document.body && parent !== document.documentElement) {
        try {
          const style = window.getComputedStyle ? window.getComputedStyle(parent) : null;
          if (style && (style.overflowY === "auto" || style.overflowY === "scroll" || style.overflowY === "hidden")) {
            const pRect = parent.getBoundingClientRect();
            if (pRect && (rect.bottom < pRect.top + 2 || rect.top > pRect.bottom - 2)) {
              return false;
            }
          }
        } catch {}
        parent = parent.parentElement;
      }
    }

    return true;
  }

  function positionAnnotationMarker(marker, rect, anchorNode = null) {
    if (!marker || !rect) return;
    if (!isAnnotationRectVisible(rect, anchorNode)) {
      marker.style.display = "none";
      return;
    }
    marker.style.display = "grid";
    const size = window.innerWidth <= 680 ? 20 : 22;
    const gap = 5;
    const chatBounds = getChatViewBoundary();
    let left = rect.right + gap;
    const minMarkerLeft = chatBounds.left + 8;
    const maxMarkerLeft = Math.max(minMarkerLeft, chatBounds.right - size - 8);
    if (left + size > chatBounds.right - 8) left = rect.left - size - gap;
    left = Math.max(minMarkerLeft, Math.min(maxMarkerLeft, left));
    const top = rect.top + rect.height / 2 - size / 2;
    marker.style.left = `${Math.round(left)}px`;
    marker.style.top = `${Math.round(top)}px`;
  }

  function createAnnotationMarker(number, rect, itemId, anchorNode = null) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "pi-enh-annotation-marker";
    marker.textContent = String(number);
    marker.setAttribute("aria-label", itemId ? `编辑第 ${number} 条注释` : `正在添加第 ${number} 条注释`);
    if (itemId) marker.setAttribute("data-annotation-id", itemId);
    marker.addEventListener("click", () => {
      const id = marker.getAttribute("data-annotation-id");
      if (!id) return;
      const item = listAnnotations().find((entry) => entry.id === id);
      const anchor = annotationAnchors.get(id);
      if (item) openAnnotationEditor(item.quote, id, getAnnotationEndRect(anchor?.range, anchor?.rect) || marker.getBoundingClientRect(), anchor?.range);
    });
    document.body.appendChild(marker);
    positionAnnotationMarker(marker, rect, anchorNode);
    return marker;
  }

  function syncAnnotationMarkers() {
    if (!isPluginEnabled("quick-quote")) {
      removeAnnotationMarkers();
      return;
    }
    const isModalOpen = Boolean(document.querySelector(".settings-dialog-backdrop, .config-panel-root.is-modal, dialog[open]:not(.pi-enh-image-zoom-dialog)"));
    if (isModalOpen) {
      removeAnnotationMarkers();
      return;
    }

    const items = listAnnotations();
    const ids = new Set(items.map((item) => item.id));
    for (const marker of document.querySelectorAll(".pi-enh-annotation-marker[data-annotation-id]")) {
      if (!ids.has(marker.getAttribute("data-annotation-id"))) marker.remove();
    }
    items.forEach((item, index) => {
      let anchor = annotationAnchors.get(item.id);
      if (!anchor) return;
      if (anchor.range && (!anchor.range.startContainer || !anchor.range.startContainer.isConnected)) {
        const liveRange = findLiveQuoteRange(item.quote);
        if (liveRange) {
          anchor.range = liveRange;
          annotationAnchors.set(item.id, anchor);
        }
      }
      let marker = document.querySelector(`.pi-enh-annotation-marker[data-annotation-id="${item.id}"]`);
      const rect = getAnnotationEndRect(anchor.range, anchor.rect);
      if (!marker) marker = createAnnotationMarker(index + 1, rect, item.id, anchor.range?.startContainer);
      marker.textContent = String(index + 1);
      marker.setAttribute("aria-label", `编辑第 ${index + 1} 条注释`);
      positionAnnotationMarker(marker, rect, anchor.range?.startContainer);
    });
    syncAnnotationHighlights();
  }

  function closeAnnotationEditor() {
    activeAnnotationSaveHandler = null;
    annotationEditorOpenedAt = 0;
    if (annotationEditor) annotationEditor.remove();
    if (annotationDraftMarker) annotationDraftMarker.remove();
    annotationDraftMarker = null;
    annotationEditor = null;
    annotationEditorState = null;
    syncAnnotationHighlights();
  }

  function getComposerBoundaryTop() {
    try {
      const composer = getComposerTextarea();
      const composerRoot = composer?.closest?.(".chat-composer-card") ||
                           composer?.closest?.("form") || 
                           composer?.closest?.(".chat-input-container") || 
                           composer?.parentElement?.parentElement || 
                           composer;
      if (composerRoot && typeof composerRoot.getBoundingClientRect === "function") {
        const cRect = composerRoot.getBoundingClientRect();
        if (cRect && cRect.top > 80) {
          const badge = document.querySelector(".pi-enh-annotation-badge");
          if (badge && typeof badge.getBoundingClientRect === "function") {
            const bRect = badge.getBoundingClientRect();
            if (bRect && bRect.top > 60 && bRect.top < cRect.top) {
              return bRect.top;
            }
          }
          return cRect.top;
        }
      }
    } catch {}
    return (window.innerHeight || 768) - 100;
  }

  function getHeaderBoundaryBottom() {
    try {
      const header = document.querySelector("header, .chat-header, .settings-dialog-header");
      if (header && typeof header.getBoundingClientRect === "function") {
        const hRect = header.getBoundingClientRect();
        if (hRect && hRect.bottom > 0) {
          return hRect.bottom;
        }
      }
    } catch {}
    return 48;
  }

  function getChatViewBoundary() {
    const winW = (typeof window !== "undefined" && window.innerWidth) || 1024;
    const winH = (typeof window !== "undefined" && window.innerHeight) || 768;

    let left = 0;
    let right = winW;
    let top = 0;
    let bottom = winH;

    // 1. 探测侧边栏占用：如果侧边栏打开，获取其右边界（桌面/平板/折叠屏分栏常驻，或手机非抽屉侧边栏）
    try {
      const sidebar = (typeof getSessionSidebarElement === "function" && getSessionSidebarElement()) ||
                      (typeof document !== "undefined" && (document.getElementById("session-sidebar") || document.querySelector(".sidebar-container, .sessions-sidebar, aside")));
      if (sidebar && typeof sidebar.getBoundingClientRect === "function") {
        const sRect = sidebar.getBoundingClientRect();
        if (sRect && sRect.right > 40 && sRect.left < 50 && sRect.width > 40) {
          const style = window.getComputedStyle ? window.getComputedStyle(sidebar) : null;
          const isHidden = style && (style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity || "1") < 0.1);
          if (!isHidden) {
            left = Math.max(left, sRect.right);
          }
        }
      }
    } catch {}

    // 2. 探测主内容区/聊天容器 (main / .chat-window / .message-view)
    try {
      const main = typeof document !== "undefined" && document.querySelector("main, .chat-window, .message-view, [data-session-chat]");
      if (main && typeof main.getBoundingClientRect === "function") {
        const mRect = main.getBoundingClientRect();
        if (mRect && mRect.width > 120) {
          left = Math.max(left, mRect.left);
          right = Math.min(right, mRect.right);
          top = Math.max(top, mRect.top);
          bottom = Math.min(bottom, mRect.bottom);
        }
      }
    } catch {}

    // 3. 探测底部输入框 (Composer)
    try {
      const composer = typeof getComposerTextarea === "function" ? getComposerTextarea() : (typeof document !== "undefined" && document.querySelector("textarea"));
      const composerRoot = composer?.closest?.("form") || composer?.parentElement?.parentElement || composer;
      if (composerRoot && typeof composerRoot.getBoundingClientRect === "function") {
        const cRect = composerRoot.getBoundingClientRect();
        if (cRect && cRect.top > 80) {
          bottom = Math.min(bottom, cRect.top);
          if (cRect.left > left && cRect.left < winW * 0.6) {
            left = Math.max(left, cRect.left);
          }
          if (cRect.right < right && cRect.right > winW * 0.4) {
            right = Math.min(right, cRect.right);
          }
        }
      }
    } catch {}

    // 4. 探测顶部 Header
    try {
      const header = typeof document !== "undefined" && document.querySelector("header, .chat-header, .settings-dialog-header");
      if (header && typeof header.getBoundingClientRect === "function") {
        const hRect = header.getBoundingClientRect();
        if (hRect && hRect.bottom > 0) {
          top = Math.max(top, hRect.bottom);
        }
      }
    } catch {}

    if (right <= left + 140) {
      left = 0;
      right = winW;
    }

    return { left, right, top, bottom, width: right - left, height: bottom - top };
  }

  function positionAnnotationPopover(element, selectionBounds, endRect = null, anchorNode = null) {
    if (!element || !selectionBounds) return;
    const chatBounds = getChatViewBoundary();
    const availableWidth = Math.max(260, chatBounds.width - 24);
    const width = Math.min(360, availableWidth);
    const measuredHeight = element.getBoundingClientRect?.().height || 150;

    const composerTop = getComposerBoundaryTop();
    const headerBottom = getHeaderBoundaryBottom();
    const bottomGap = 12;
    const topGap = 8;
    const minTop = Math.max(chatBounds.top + topGap, headerBottom + topGap);
    // 严格限制最大 top，确保编辑框下边缘绝不侵入底部输入窗口
    const maxTop = Math.max(minTop, composerTop - measuredHeight - bottomGap);

    const bounds = selectionBounds || endRect;
    const bTop = bounds.top || 90;
    const bBottom = bounds.bottom || bTop + 24;
    const bLeft = bounds.left != null ? bounds.left : (chatBounds.left + 12);
    const bRight = bounds.right != null ? bounds.right : (bLeft + 200);

    const safeMinLeft = chatBounds.left + 12;
    const safeMaxLeft = Math.max(safeMinLeft, chatBounds.right - width - 12);

    let left = safeMinLeft;
    let top = minTop;

    // 智能全方位避让逻辑：首要原则是绝不遮挡所选文字的任何一行，且绝不遮挡底部输入框
    const underTop = bBottom + 8;
    const canPlaceUnder = underTop <= maxTop;
    // 向上翻转必须以整段文字的顶部 (bTop) 减去弹窗高度，确保所有行文字均在弹窗下方完整呈现，绝不盖住第一、二行！
    const aboveTop = bTop - measuredHeight - 8;
    const canPlaceAbove = aboveTop >= minTop;
    const canPlaceRight = (chatBounds.right - bRight) >= (width + 24);

    if (canPlaceUnder) {
      // 1. 优先放在整段文字正下方：所有行文字全部在上方，弹窗在下方，所有文字完整清晰可见！
      top = underTop;
      left = Math.max(safeMinLeft, Math.min(safeMaxLeft, bLeft));
    } else if (canPlaceAbove) {
      // 2. 下方空间不足（靠近底部输入框）：向上翻转至整段文字上方，整段多行文字完整露在弹窗下方！
      top = aboveTop;
      left = Math.max(safeMinLeft, Math.min(safeMaxLeft, bLeft));
    } else if (canPlaceRight) {
      // 3. 上下空间均紧张时，右侧充足则在右侧并列
      left = bRight + 14;
      top = Math.max(minTop, Math.min(maxTop, bTop));
    } else {
      // 4. 极端拥挤场景：贴在底部输入框上方安全区止步，严格不越界压住输入框
      top = maxTop;
      left = Math.max(safeMinLeft, Math.min(safeMaxLeft, bLeft));
    }

    // 手机单栏狭窄视口（聊天区宽度 <= 440）：在聊天区内居中对齐
    if (chatBounds.width <= 440) {
      left = Math.max(safeMinLeft, Math.min(safeMaxLeft, chatBounds.left + (chatBounds.width - width) / 2));
    }

    // 终极安全锁：确保 top 严格限制在 [minTop, maxTop]，left 严格在安全视口内
    top = Math.max(minTop, Math.min(maxTop, top));
    left = Math.max(safeMinLeft, Math.min(safeMaxLeft, left));

    Object.assign(element.style, { 
      left: `${Math.round(left)}px`, 
      top: `${Math.round(top)}px`, 
      width: `${Math.round(width)}px` 
    });
  }

  let annotationRepositionRaf = null;

  function scheduleAnnotationReposition() {
    if (annotationRepositionRaf !== null) return;
    if (typeof requestAnimationFrame === "function") {
      annotationRepositionRaf = requestAnimationFrame(() => {
        annotationRepositionRaf = null;
        repositionActiveAnnotationUi();
      });
    } else {
      repositionActiveAnnotationUi();
    }
  }

  function repositionActiveAnnotationUi() {
    if (!isPluginEnabled("quick-quote")) return;

    // 模态弹窗（设置弹窗等）打开时，清理页面引用浮层
    const isModalOpen = Boolean(document.querySelector(".settings-dialog-backdrop, .config-panel-root.is-modal, dialog[open]:not(.pi-enh-image-zoom-dialog)"));
    if (isModalOpen) {
      closeNativeQuoteSelectionToolbar();
      if (annotationEditor) closeAnnotationEditor();
      removeAnnotationMarkers();
      return;
    }

    // 移动端侧边栏抽屉打开时，避免浮层在抽屉下方或遮挡侧边栏
    if (typeof isSessionSidebarOpen === "function" && isSessionSidebarOpen() && typeof isMobileDrawerMode === "function" && isMobileDrawerMode()) {
      closeNativeQuoteSelectionToolbar();
      if (annotationEditor) closeAnnotationEditor();
      removeAnnotationMarkers();
      return;
    }

    // 1. 如果输入框正在打开编辑，更新其跟随位置与草稿 marker
    if (annotationEditor && annotationEditorState) {
      let liveRange = annotationEditorState.range;
      if (liveRange && (!liveRange.startContainer || !liveRange.startContainer.isConnected)) {
        liveRange = findLiveQuoteRange(annotationEditorState.quote);
        if (liveRange) annotationEditorState.range = liveRange;
      }
      const bounds = (liveRange && typeof liveRange.getBoundingClientRect === "function")
        ? liveRange.getBoundingClientRect()
        : annotationEditorState.bounds || annotationEditorState.rect;
      const endRect = getAnnotationEndRect(liveRange, annotationEditorState.rect);
      if (bounds) {
        positionAnnotationPopover(annotationEditor, bounds, endRect, liveRange?.startContainer);
        if (annotationDraftMarker && endRect) {
          positionAnnotationMarker(annotationDraftMarker, endRect, liveRange?.startContainer);
        }
      }
    }

    // 2. 刷新同步所有已保存的 marker
    syncAnnotationMarkers();

  }

  function resizeAnnotationComment(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    const height = Math.max(30, Math.min(220, textarea.scrollHeight || 30));
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = (textarea.scrollHeight || 0) > 220 ? "auto" : "hidden";
  }

  function openAnnotationEditor(quote, itemId, rect, sourceRange) {
    if (!isPluginEnabled("quick-quote")) return;
    const existing = itemId ? listAnnotations().find((item) => item.id === itemId) : null;
    const selectedQuote = normalizeAnnotationText(existing?.quote || quote);
    if (!selectedQuote) return;
    closeAnnotationEditor();
    const range = sourceRange?.cloneRange?.() || sourceRange || null;
    const selectionBounds = (range && typeof range.getBoundingClientRect === "function")
      ? range.getBoundingClientRect()
      : rect;
    const anchorRect = getAnnotationEndRect(range, rect);
    const editor = document.createElement("section");
    editor.className = "pi-enh-annotation-editor";
    editor.setAttribute("role", "dialog");
    editor.setAttribute("aria-label", itemId ? "编辑引用注释" : "添加引用注释");
    editor.setAttribute("title", selectedQuote);
    // 遵照用户要求：弹出的对话框彻底去掉顶部引用预览内容；保留隐藏节点以兼容已有单元测试
    const quotePreview = document.createElement("div");
    quotePreview.className = "pi-enh-annotation-quote-preview";
    quotePreview.textContent = selectedQuote;
    quotePreview.setAttribute("title", selectedQuote);
    quotePreview.style.display = "none";

    const comment = document.createElement("textarea");
    comment.className = "pi-enh-annotation-comment";
    comment.rows = 1;
    comment.placeholder = "添加可选评论…";
    comment.value = existing?.comment || "";
    comment.setAttribute("aria-label", "注释内容");
    comment.addEventListener("input", () => {
      resizeAnnotationComment(comment);
      scheduleAnnotationReposition();
    });
    const actions = document.createElement("div");
    actions.className = "pi-enh-annotation-editor-actions";
    const existingIndex = itemId ? listAnnotations().findIndex((item) => item.id === itemId) : -1;
    const annotationNumber = existingIndex !== -1 ? existingIndex + 1 : listAnnotations().length + 1;
    const indexBadge = document.createElement("span");
    indexBadge.className = "pi-enh-annotation-editor-index";
    indexBadge.textContent = `#${annotationNumber}`;
    indexBadge.setAttribute("aria-label", `第 ${annotationNumber} 条注释`);
    indexBadge.setAttribute("title", `当前正在编辑第 ${annotationNumber} 条注释`);

    const save = createAnnotationButton("", "pi-enh-annotation-save", itemId ? "保存注释更改" : "保存注释");
    save.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>';
    if (!itemId) annotationDraftMarker = createAnnotationMarker(listAnnotations().length + 1, anchorRect, null);
    const saveAnnotation = (restoreFocus = true) => {
      if (itemId) {
        updateAnnotation(itemId, selectedQuote, comment.value);
      } else {
        const items = addAnnotation(selectedQuote, comment.value);
        const saved = items.at(-1);
        if (saved && annotationDraftMarker) {
          annotationDraftMarker.setAttribute("data-annotation-id", saved.id);
          annotationAnchors.set(saved.id, { range, rect: anchorRect, quote: selectedQuote });
          annotationDraftMarker = null;
        }
      }
      closeAnnotationEditor();
      syncAnnotationComposer();
      syncAnnotationMarkers();
      showToast("已保存注释");
      if (restoreFocus) focusComposerTextarea();
    };
    save.addEventListener("click", saveAnnotation);
    activeAnnotationSaveHandler = saveAnnotation;
    annotationEditorOpenedAt = Date.now();
    comment.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        closeAnnotationEditor();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        saveAnnotation();
      }
    });
    actions.append(indexBadge, save);
    editor.append(quotePreview, comment, actions);
    document.body.appendChild(editor);
    annotationEditor = editor;
    annotationEditorState = { quote: selectedQuote, itemId, range, rect: anchorRect, bounds: selectionBounds };
    resizeAnnotationComment(comment);
    syncAnnotationHighlights();
    positionAnnotationPopover(editor, selectionBounds, anchorRect);
    comment.focus();
  }

  function cancelAnnotationListClose() {
    if (annotationListCloseTimer !== null) clearManagedTimeout(annotationListCloseTimer);
    annotationListCloseTimer = null;
  }

  function scheduleAnnotationListClose() {
    cancelAnnotationListClose();
    annotationListCloseTimer = addManagedTimeout(() => { 
      try {
        if (annotationList?.matches?.(":hover") || annotationBadge?.matches?.(":hover")) return;
      } catch {}
      closeAnnotationList();
    }, 240);
  }

  function closeAnnotationList() {
    cancelAnnotationListClose();
    if (annotationList) annotationList.remove();
    annotationList = null;
    annotationBadge?.querySelector(".pi-enh-annotation-badge-summary")?.setAttribute("aria-expanded", "false");
  }

  function positionAnnotationList(panel, rect) {
    const chatBounds = getChatViewBoundary();
    const availableW = Math.max(260, chatBounds.width - 24);
    const width = Math.min(390, availableW);
    panel.style.width = `${width}px`;
    const height = panel.getBoundingClientRect?.().height || Math.min(320, window.innerHeight - 24);
    const safeMinLeft = chatBounds.left + 12;
    const safeMaxLeft = Math.max(safeMinLeft, chatBounds.right - width - 12);
    let left = Math.max(safeMinLeft, Math.min(safeMaxLeft, rect?.left || safeMinLeft));
    let top = (rect?.top || window.innerHeight - 60) - height - 8;
    if (top < chatBounds.top + 12) top = Math.min(window.innerHeight - height - 12, (rect?.bottom || 52) + 8);
    if (chatBounds.width <= 440) {
      left = Math.max(safeMinLeft, Math.min(safeMaxLeft, chatBounds.left + (chatBounds.width - width) / 2));
    }
    Object.assign(panel.style, { left: `${Math.round(left)}px`, top: `${Math.round(Math.max(12, top))}px` });
  }

  function openAnnotationList() {
    if (annotationList) return;
    const items = listAnnotations();
    if (!items.length) return;
    const panel = document.createElement("section");
    panel.className = "pi-enh-annotation-list";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "引用注释列表");
    panel.addEventListener("mouseenter", cancelAnnotationListClose);
    panel.addEventListener("mouseleave", scheduleAnnotationListClose);
    const header = document.createElement("div");
    header.className = "pi-enh-annotation-list-header";
    const heading = document.createElement("strong");
    heading.textContent = annotationLabel();
    header.appendChild(heading);
    panel.appendChild(header);
    items.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "pi-enh-annotation-list-item";
      row.setAttribute("data-annotation-id", item.id);
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "pi-enh-annotation-list-edit";
      edit.setAttribute("aria-label", `编辑第 ${index + 1} 条注释`);
      const quote = document.createElement("span");
      quote.className = "pi-enh-annotation-list-quote";
      quote.textContent = item.quote;
      const meta = document.createElement("span");
      meta.className = "pi-enh-annotation-list-meta";
      meta.textContent = item.comment || "无附加评论";
      edit.append(quote, meta);
      edit.addEventListener("click", () => {
        closeAnnotationList();
        const anchor = annotationAnchors.get(item.id);
        openAnnotationEditor(item.quote, item.id, getAnnotationEndRect(anchor?.range, anchor?.rect) || annotationBadge?.getBoundingClientRect?.(), anchor?.range);
      });
      const remove = createAnnotationButton("", "pi-enh-annotation-list-delete", `删除第 ${index + 1} 条注释`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6m4-6v6"/></svg>';
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        cancelAnnotationListClose();
        removeAnnotation(item.id);
        syncAnnotationComposer();
        const remaining = listAnnotations();
        if (!remaining.length) {
          closeAnnotationList();
          return;
        }
        row.remove();
        heading.textContent = annotationLabel();
        panel.querySelectorAll(".pi-enh-annotation-list-item").forEach((itemRow, newIndex) => {
          const editBtn = itemRow.querySelector(".pi-enh-annotation-list-edit");
          const delBtn = itemRow.querySelector(".pi-enh-annotation-list-delete");
          if (editBtn) editBtn.setAttribute("aria-label", `编辑第 ${newIndex + 1} 条注释`);
          if (delBtn) delBtn.setAttribute("aria-label", `删除第 ${newIndex + 1} 条注释`);
        });
        const currentBadgeRect = annotationBadge?.getBoundingClientRect?.() || rect;
        positionAnnotationList(panel, currentBadgeRect);
      });
      row.append(edit, remove);
      panel.appendChild(row);
    });
    document.body.appendChild(panel);
    annotationList = panel;
    annotationBadge?.querySelector(".pi-enh-annotation-badge-summary")?.setAttribute("aria-expanded", "true");
    const rect = annotationBadge?.getBoundingClientRect?.() || { left: 12, top: window.innerHeight - 60, bottom: window.innerHeight - 28 };
    positionAnnotationList(panel, rect);
  }

  function setComposerText(textarea, value) {
    try {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(textarea, value);
      else textarea.value = value;
    } catch {
      textarea.value = value;
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function consumeAnnotationSnapshot(snapshot, sessionId) {
    if (getAnnotationSessionId() !== sessionId || !Array.isArray(snapshot) || !snapshot.length) return;
    const snapshotMap = new Map(snapshot.map((s) => [s.id, s]));
    ensureAnnotationSession();
    annotationItems = annotationItems.filter((item) => {
      const matched = snapshotMap.get(item.id);
      if (!matched) return true;
      if (matched.quote !== item.quote || matched.comment !== item.comment) return true;
      annotationAnchors.delete(item.id);
      try {
        document.querySelector(`.pi-enh-annotation-marker[data-annotation-id="${item.id}"]`)?.remove();
      } catch {}
      return false;
    });
    persistAnnotations();
    syncAnnotationComposer();
    syncAnnotationMarkers();
  }

  function prepareNativeComposerSubmission(kind, body) {
    if (!isPluginEnabled("quick-quote")) return null;
    const snapshot = listAnnotations();
    if (!snapshot.length) return null;
    const sessionId = getAnnotationSessionId();
    return {
      text: serializeAnnotations(body),
      commit() {
        if (getAnnotationSessionId() !== sessionId) return;
        consumeAnnotationSnapshot(snapshot, sessionId);
      },
      kind,
    };
  }

  window.__PI_ENH_ANNOTATIONS__ = {
    list: listAnnotations,
    add: addAnnotation,
    remove: removeAnnotation,
    update: updateAnnotation,
    clear: clearAnnotations,
    label: annotationLabel,
    serialize: serializeAnnotations,
    sync: syncAnnotationComposer,
    openEditor: openAnnotationEditor,
  };
  window.__PI_ENH_OPEN_ANNOTATION_EDITOR__ = openAnnotationEditor;
  window.__PI_ENH_PREPARE_ANNOTATION_SUBMISSION__ = prepareNativeComposerSubmission;
  const syncAnnotationUi = () => {
    syncAnnotationComposer();
    syncAnnotationMarkers();
  };
  addManagedListener(window, "pi-native-composer-mounted", syncAnnotationUi);
  addManagedListener(window, "pi-native-composer-unmounted", syncAnnotationUi);
  addManagedListener(window, "pi-native-chat-messages-changed", syncAnnotationUi);
  syncAnnotationUi();

  async function copySelectionToClipboard(text) {
    const raw = String(text || "").trim();
    if (!raw) return;
    let copied = false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
        await navigator.clipboard.writeText(raw);
        copied = true;
      }
    } catch {}

    if (!copied) {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = raw;
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        textarea.style.top = "-9999px";
        textarea.setAttribute("readonly", "");
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand("copy");
        textarea.remove();
      } catch {}
    }

    const copyIconSvg = `<svg width="14" height="14" viewBox="0 0 24 24" fill="#34d399"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
    showToast(copied ? "已复制选中文本" : "复制完成", copyIconSvg);

    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  let nativeSelectionSnapshot = null;
  addManagedListener(window, "pi-web:native-selection-change", (event) => {
    nativeSelectionSnapshot = event.detail || null;
  });
  addManagedListener(window, "pi-web:native-selection-action", (event) => {
    if (!isPluginEnabled("quick-quote")) return;
    const selection = event.detail || nativeSelectionSnapshot;
    if (!selection?.text) return;
    if (selection.action === "copy") copySelectionToClipboard(selection.text);
    if (selection.action === "quote") {
      openAnnotationEditor(selection.text, null, selection.rect, selection.range);
    }
  });

  addManagedListener(document, "mousedown", (event) => {
    if (!annotationEditor || !activeAnnotationSaveHandler) return;
    const target = event.target;
    if (annotationEditor.contains(target)) return;
    if (target?.closest?.(".pi-enh-quote-bar, .pi-enh-annotation-marker")) return;
    // 点击编辑框外部，自动无备注保存当前引用，等效于点击保存
    activeAnnotationSaveHandler(false);
  });
  addManagedListener(window, "scroll", scheduleAnnotationReposition, true);
  addManagedListener(window, "resize", scheduleAnnotationReposition);
  if (typeof window !== "undefined" && window.visualViewport) {
    addManagedListener(window.visualViewport, "resize", scheduleAnnotationReposition);
    addManagedListener(window.visualViewport, "scroll", scheduleAnnotationReposition);
  }

  // ==========================================
  // 2.6 Cross-project Session Status Indicator (跨项目会话状态提示)
  // ==========================================
  // Pure state model: transport, DOM and storage never decide whether a request closed.
  function createProjectStatusModel() {
    let catalog = new Map(), entries = new Map(), epoch = null, revision = -1, catalogReady = false;
    let sync = { state: "connecting", at: 0 }, unread = new Set();
    const acknowledged = new Map(), retiredEpochs = new Set();
    let completedRead = new Set();
    const completionKey = (id, item) => JSON.stringify([id, item.runId]);
    const isCompletedRead = (id, item) => {
      if (!item?.runId) return true;
      if (completedRead.has(completionKey(id, item))) return true;
      if (completedRead.has(JSON.stringify([id, item.runId]))) return true;
      if (epoch && completedRead.has(JSON.stringify([epoch, id, item.runId]))) return true;
      for (const token of completedRead) {
        try {
          const parsed = JSON.parse(token);
          if (Array.isArray(parsed)) {
            if (parsed.length === 2 && parsed[0] === id && parsed[1] === item.runId) return true;
            if (parsed.length === 3 && parsed[1] === id && parsed[2] === item.runId) return true;
          }
        } catch (e) {}
      }
      return false;
    };
    const titleOf = session => String(session?.name || "").trim()
      || String(session?.firstMessage || "").trim().split(/\r?\n/, 1)[0].slice(0, 50)
      || String(session?.id || "").slice(0, 12) || "未命名会话";
    const key = value => String(value || "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
    const empty = id => ({ id, status: "idle", execution: "idle", pendingRequests: [], runId: "", toolNames: [], observedAt: 0 });
    const buildEntry = id => {
      // Browser storage is metadata/read history, never a runtime receipt.
      const item = entries.get(id) || empty(id);
      const session = catalog.get(id) || {};
      return { ...item, projectKey: key(session.projectKey || session.projectRoot || session.cwd || item.projectKey),
        title: titleOf({ ...session, id, title: item.title }), cwd: session.cwd || item.cwd || "",
        unread: item.status === "completed" && !!item.runId && !isCompletedRead(id, item) };
    };
    const list = () => [...(catalogReady ? catalog.keys() : entries.keys())].map(buildEntry);
    const entry = id => (catalogReady ? catalog.has(id) : entries.has(id))
      ? buildEntry(id)
      : empty(id);
    // Native unread flags are session-level activity hints, not evidence of a
    // new assistant answer. Ended rounds remain factual row labels only.
    const items = (projectKey, status = null, others = false) => list().filter(entry =>
      (projectKey === null || (others ? entry.projectKey !== key(projectKey) : entry.projectKey === key(projectKey)))
      && (!status || entry.status === status) && entry.status !== "completed"
      && !(entry.status === "interrupted" && acknowledged.get(entry.id) === entry.runId));
    const apply = (payload, now) => {
      const interactions = payload?.interactionState, stamp = payload?.statusSnapshot;
      const reject = state => { sync = { ...sync, state }; return { accepted: false, newRequests: [] }; };
      if (interactions?.version !== 1 || stamp?.version !== 1) return reject("unsupported");
      if (!Array.isArray(interactions.sessions) || !Array.isArray(stamp.executions) || !Array.isArray(payload.runningSessionIds)
        || payload.runningSessionIds.some(id => typeof id !== "string") || !stamp.epoch || typeof stamp.epoch !== "string"
        || !Number.isSafeInteger(stamp.revision) || stamp.revision < 0) return reject("unavailable");
      if (retiredEpochs.has(stamp.epoch) || epoch === stamp.epoch && stamp.revision < revision) return { accepted: false, newRequests: [] };
      const next = new Map(), seen = new Set(), newRequests = [];
      for (const item of stamp.executions) {
        if (!item || typeof item.sessionId !== "string" || !item.sessionId || next.has(item.sessionId)
          || !["running", "idle", "ended", "failed", "stopped"].includes(item.state)
          || (item.toolNames !== undefined && (!Array.isArray(item.toolNames) || item.toolNames.some(name => typeof name !== "string")))) return reject("unavailable");
        const status = { ended: "completed", failed: "interrupted" }[item.state] || item.state;
        next.set(item.sessionId, { ...empty(item.sessionId), status, execution: item.state, runId: String(item.runId || ""), toolNames: item.toolNames || [] });
      }
      // The runtime set is authoritative even if an old server ledger misses an end event.
      const running = new Set(payload.runningSessionIds);
      for (const item of next.values()) {
        if (running.has(item.id)) { item.status = item.execution = "running"; }
        else if (item.execution === "running") { item.status = item.execution = "idle"; }
      }
      for (const id of running) if (!next.has(id)) next.set(id, { ...empty(id), status: "running", execution: "running" });
      for (const item of interactions.sessions) {
        if (!item || typeof item.sessionId !== "string" || !item.sessionId || seen.has(item.sessionId) || !Array.isArray(item.pendingRequests)) return reject("unavailable");
        seen.add(item.sessionId);
        const ids = new Set(), previous = epoch === stamp.epoch ? entries.get(item.sessionId) : null;
        for (const request of item.pendingRequests) {
          if (!request || typeof request.id !== "string" || !request.id || ids.has(request.id)
            || !["select", "confirm", "input", "editor", "custom"].includes(request.method)) return reject("unavailable");
          ids.add(request.id);
          if (!previous?.pendingRequests.some(old => old.id === request.id)) newRequests.push({ sessionId: item.sessionId, id: request.id, epoch: stamp.epoch });
        }
        const entry = next.get(item.sessionId) || empty(item.sessionId);
        entry.pendingRequests = item.pendingRequests.map(request => ({ id: request.id, method: request.method }));
        if (ids.size) { entry.status = "attention"; entry.observedAt = previous?.observedAt || now; }
        next.set(item.sessionId, entry);
      }
      // Commit only after the entire snapshot validates; no partial DOM transitions.
      if (epoch && epoch !== stamp.epoch) retiredEpochs.add(epoch);
      entries = next; epoch = stamp.epoch; revision = stamp.revision;
      sync = { state: "live", at: now };
      return { accepted: true, newRequests };
    };
    const markAttention = (id, pendingRequests = []) => {
      if (!id) return;
      const current = entries.get(id) || empty(id);
      entries.set(id, {
        ...current,
        status: "attention",
        pendingRequests: pendingRequests.length ? pendingRequests.map(request => ({ ...request })) : current.pendingRequests,
        observedAt: current.observedAt || Date.now(),
      });
    };
    const clearAttention = (id, nextStatus = null) => {
      if (!id) return;
      const current = entries.get(id);
      if (current) {
        entries.set(id, {
          ...current,
          status: nextStatus || (current.execution === "running" ? "running" : "idle"),
          pendingRequests: [],
        });
      }
    };
    return {
      apply, list, items, titleOf, markAttention, clearAttention, setCatalog: sessions => { catalogReady = true; catalog = new Map(sessions.filter(s => s?.id).map(s => [s.id, s])); },
      entry,
      setUnread: ids => { unread = new Set(ids); }, // Native activity is not completion-read evidence.
      setCompletedRead: keys => {
        const next = new Set();
        for (const key of keys || []) {
          if (typeof key === "string") {
            next.add(key);
            try {
              const parsed = JSON.parse(key);
              if (Array.isArray(parsed)) {
                if (parsed.length === 3 && typeof parsed[1] === "string" && typeof parsed[2] === "string") {
                  next.add(JSON.stringify([parsed[1], parsed[2]]));
                }
              }
            } catch (e) {}
          }
        }
        completedRead = next;
      },
      readCompleted: id => {
        const item = entries.get(id);
        if (!item || item.status !== "completed" || !item.runId) return null;
        const simpleToken = JSON.stringify([id, item.runId]);
        const epochToken = epoch ? JSON.stringify([epoch, id, item.runId]) : simpleToken;
        if (completedRead.has(simpleToken) && completedRead.has(epochToken)) return null;
        completedRead.add(simpleToken);
        completedRead.add(epochToken);
        return simpleToken;
      },
      unreadCompleted: id => {
        if (!id) return;
        for (const token of Array.from(completedRead)) {
          try {
            const parsed = JSON.parse(token);
            if (Array.isArray(parsed)) {
              if ((parsed.length === 2 && parsed[0] === id) || (parsed.length === 3 && parsed[1] === id)) {
                completedRead.delete(token);
              }
            }
          } catch (e) {}
        }
      },
      acknowledge: id => { acknowledged.set(id, (entries.get(id) || empty(id)).runId); },
      unavailable: state => { sync = { ...sync, state }; }, health: () => ({ ...sync }),
      summary(projectKey) {
        const counts = { attention: 0, interrupted: 0, running: 0, completed: 0, status: null };
        for (const entry of items(projectKey)) {
          if (Object.hasOwn(counts, entry.status)) counts[entry.status]++;
        }
        counts.status = ["attention", "interrupted", "running"].find(status => counts[status]) || null;
        return counts;
      },
    };
  }
  // END STATUS MODEL

  function createDesktopAttentionNotifier(env) {
    const opened = new Map(), delivering = new Set();
    let disposed = false;
    const keyOf = request => `${request.epoch}:${request.sessionId}:${request.id}`;
    const close = key => { try { opened.get(key)?.(); } catch {} opened.delete(key); };
    return {
      async notify(requests) {
        if (disposed || !env.canNotify()) return;
        await env.withLock(async () => {
          for (const request of requests) {
            if (disposed || !env.canNotify() || !env.isPending(request)) continue;
            const key = keyOf(request), seen = env.readSeen();
            if (seen.includes(key) || delivering.has(key)) continue;
            delivering.add(key);
            try {
              const retract = await env.deliver({ sessionId: request.sessionId, tag: `pi-attention-v2:${key}`, url: `/?session=${encodeURIComponent(request.sessionId)}` });
              if (typeof retract !== "function") continue;
              if (disposed || !env.canNotify() || !env.isPending(request)) { retract(); continue; }
              opened.set(key, retract);
              env.writeSeen([...new Set([...env.readSeen(), key])].slice(-500));
            } catch { /* Failed delivery stays retryable; never acknowledges a question. */ }
            finally { delivering.delete(key); }
          }
        });
      },
      reconcile(requests) {
        const pending = new Set(requests.map(keyOf));
        for (const key of opened.keys()) if (!pending.has(key)) close(key);
      },
      dispose() { disposed = true; for (const key of opened.keys()) close(key); },
    };
  }
  // END DESKTOP NOTIFIER

  async function withAttentionDeliveryLock(name, work) {
    if (navigator.locks) return navigator.locks.request(name, work);
    // HTTP origins lack Web Locks. Best-effort expiring lease avoids competing
    // tabs delivering at once; never persist a failed delivery as acknowledged.
    const key = `pi-enh-delivery-lease:${name}`;
    const owner = `${Date.now()}:${Math.random()}`;
    try {
      const current = JSON.parse(localStorage.getItem(key) || "null");
      if (current?.until > Date.now()) return;
      localStorage.setItem(key, JSON.stringify({ owner, until: Date.now() + 30000 }));
      await new Promise(resolve => setTimeout(resolve, 30));
      if (JSON.parse(localStorage.getItem(key) || "null")?.owner !== owner) return;
      return await work();
    } catch { /* Storage unavailable: do not spam competing tabs. */ }
    finally {
      try { if (JSON.parse(localStorage.getItem(key) || "null")?.owner === owner) localStorage.removeItem(key); } catch {}
    }
  }

  function createApprovalSound(env) {
    let context = null, disposed = false, pendingResume = null;
    const ready = () => !disposed && env.enabled() && context?.state === "running";
    const prepare = async (gesture = false) => {
      if (disposed || !env.enabled() || !env.AudioContext) return false;
      try {
        if (!context || context.state === "closed") { context = new env.AudioContext(); pendingResume = null; }
        if (context.state !== "running") {
          // Recover suspended/interrupted audio in the background. Autoplay may
          // still refuse; never hold the cross-tab delivery lock indefinitely.
          if (!pendingResume || gesture) {
            const attempt = Promise.resolve(context.resume()).catch(() => {});
            pendingResume = attempt;
            void attempt.then(() => { if (pendingResume === attempt) pendingResume = null; });
          }
          await new Promise(resolve => {
            const timer = setTimeout(resolve, env.resumeTimeoutMs ?? 400);
            void pendingResume.then(() => { clearTimeout(timer); resolve(); });
          });
        }
        return ready();
      } catch { return false; }
    };
    return {
      ready, ensureReady: () => prepare(), unlock: () => prepare(true),
      play() {
        if (!ready()) return false;
        try {
          [880, 660, 880].forEach((frequency, index) => {
            const oscillator = context.createOscillator(), gain = context.createGain();
            const time = context.currentTime + index * 0.19;
            oscillator.type = "triangle"; oscillator.frequency.value = frequency;
            oscillator.connect(gain); gain.connect(context.destination);
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.12, time + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.13);
            oscillator.start(time); oscillator.stop(time + 0.14);
          });
          return true;
        } catch { return false; }
      },
      dispose() { disposed = true; try { context?.close()?.catch(() => {}); } catch {} context = null; },
    };
  }
  // END APPROVAL SOUND

  let approvalSound = null, approvalSoundNotifier = null;
  let projectStatusLastLegacyResponseAt = 0;
  function isProjectStatusHealthy() {
    if (projectStatusDisposed) return false;
    const health = projectStatusModel?.health?.();
    if (!health) return false;
    return health.state === "live" && Date.now() - health.at < 12000;
  }
  function readNoticeSeen(key) { try { const value = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } }
  function writeNoticeSeen(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
  function approvalSoundEnabled() {
    return !projectStatusDisposed && isPluginEnabled("project-status-indicator") && isPluginEnabled("session-attention-sound") && isNotificationEnabled("attention-sound") && localStorage.getItem("pi-sound-enabled") !== "false";
  }
  function getApprovalSound() {
    return approvalSound ||= createApprovalSound({ AudioContext: window.AudioContext || window.webkitAudioContext, enabled: approvalSoundEnabled });
  }
  function disposeApprovalSound() { approvalSoundNotifier?.dispose(); approvalSoundNotifier = null; approvalSound?.dispose(); approvalSound = null; }
  function isAttentionRequestPending(request) {
    return getDesktopPendingRequests().some(item =>
      item.sessionId === request.sessionId && item.id === request.id && (!request.epoch || !item.epoch || item.epoch === request.epoch)
    );
  }
  function syncApprovalSound() {
    if (!approvalSoundNotifier) approvalSoundNotifier = createDesktopAttentionNotifier({
      canNotify: () => isProjectStatusHealthy() && approvalSoundEnabled(),
      isPending: isAttentionRequestPending,
      readSeen: () => readNoticeSeen("pi-enh-approval-sounded-v1"), writeSeen: value => writeNoticeSeen("pi-enh-approval-sounded-v1", value),
      withLock: work => withAttentionDeliveryLock("pi-web-approval-sound-v1", work),
      deliver: async payload => {
        const sound = getApprovalSound();
        if (!await sound.ensureReady() || !isProjectStatusHealthy()) return;
        // The request can close while resume() is awaiting browser permission.
        const pending = getDesktopPendingRequests().some(item => `pi-attention-v2:${item.epoch}:${item.sessionId}:${item.id}` === payload.tag);
        if (pending && sound.play()) return () => {};
      },
    });
    const requests = getDesktopPendingRequests();
    approvalSoundNotifier.reconcile(requests); void approvalSoundNotifier.notify(requests);
  }
  let isApprovalSoundUnlocked = false;
  async function unlockApprovalSound(preview = false) {
    if (isApprovalSoundUnlocked && !preview) return;
    if (!approvalSoundEnabled()) { if (preview) showToast("请开启审批提示音，并检查 Pi Web 声音总开关"); return; }
    const sound = getApprovalSound();
    if (sound.ready() && !preview) {
      isApprovalSoundUnlocked = true;
      return;
    }
    const unlocked = await sound.unlock();
    if (unlocked) isApprovalSoundUnlocked = true;
    if (preview) {
      if (unlocked) sound.play();
      else showToast("浏览器尚未允许播放声音，请点击页面后重试");
    }
    syncApprovalSound();
  }
  addManagedListener(document, "pointerdown", event => { if (event.isTrusted) void unlockApprovalSound(); }, { passive: true });
  addManagedListener(document, "keydown", event => {
    if (!event.isTrusted || isApprovalSoundUnlocked) return;
    const tag = event.target?.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || event.target?.isContentEditable) return;
    void unlockApprovalSound();
  }, { passive: true });
  addManagedListener(document, "click", event => { if (event.target?.closest?.("[data-attention-sound-preview]")) void unlockApprovalSound(true); });
  activeCleanups.push(disposeApprovalSound);

  function renderAttentionNotices() {
    // Keep the cleanup hook for existing call sites, but do not recreate the removed in-page card.
    document.querySelector(".pi-enh-attention-notice")?.remove();
  }

  let desktopAttentionNotifier = null;
  function canSendDesktopAttention() {
    return isProjectStatusHealthy() && isPluginEnabled("project-status-indicator") && isPluginEnabled("session-attention-desktop") && isNotificationEnabled("attention-desktop") && window.isSecureContext && typeof Notification !== "undefined" && Notification.permission === "granted";
  }
  function disposeDesktopAttention() { desktopAttentionNotifier?.dispose(); desktopAttentionNotifier = null; }
  function getDesktopPendingRequests() {
    const list = [];
    const seen = new Set();
    const epoch = projectStatusLastPayload?.statusSnapshot?.epoch || "local";

    const serverSessions = projectStatusLastPayload?.interactionState?.sessions || [];
    for (const session of serverSessions) {
      if (!session?.sessionId || !Array.isArray(session.pendingRequests)) continue;
      const localEntry = projectStatusModel.entry(session.sessionId);
      if (localEntry && localEntry.status !== "attention") continue;
      for (const req of session.pendingRequests) {
        if (!req?.id) continue;
        const key = `${session.sessionId}:${req.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ ...req, sessionId: session.sessionId, epoch });
      }
    }

    const localList = typeof projectStatusModel !== "undefined" ? projectStatusModel.list() : [];
    for (const entry of localList) {
      if (!entry?.id) continue;
      const effective = getEffectiveProjectStatusEntry(entry.id);
      if (effective?.status !== "attention") continue;
      const pendingRequests = (effective.pendingRequests && effective.pendingRequests.length > 0)
        ? effective.pendingRequests
        : [{ id: "local-ask", method: "select" }];
      for (const req of pendingRequests) {
        if (!req?.id) continue;
        const key = `${entry.id}:${req.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({
          id: req.id,
          method: req.method || "select",
          sessionId: entry.id,
          epoch,
        });
      }
    }
    return list;
  }
  function syncDesktopAttention() {
    const requests = getDesktopPendingRequests();
    if (!desktopAttentionNotifier) desktopAttentionNotifier = createDesktopAttentionNotifier({
      canNotify: canSendDesktopAttention,
      isPending: request => getDesktopPendingRequests().some(item => item.epoch === request.epoch && item.sessionId === request.sessionId && item.id === request.id),
      readSeen: () => { try { const value = JSON.parse(localStorage.getItem("pi-enh-desktop-notified-v2") || "[]"); return Array.isArray(value) ? value : []; } catch { return []; } },
      writeSeen: value => { try { localStorage.setItem("pi-enh-desktop-notified-v2", JSON.stringify(value)); } catch {} },
      withLock: work => withAttentionDeliveryLock("pi-web-desktop-notice-v2", work),
      deliver: async payload => {
        const entry = projectStatusModel.entry(payload.sessionId);
        recordNotificationEvent(`${entry.title || "后台任务"} 需要确认或输入`, "warning", "attention-desktop", "attention-desktop");
        const options = { body: `${entry.title || "后台任务"} 需要确认或输入，点击前往处理`, tag: payload.tag, icon: "/icons/icon-192.png", requireInteraction: true, renotify: false, data: { url: payload.url } };
        if (navigator.serviceWorker) {
          try {
            const registration = await navigator.serviceWorker.getRegistration();
            if (registration) {
              await registration.showNotification("Pi Web · 待你处理", options);
              return () => { void registration.getNotifications({tag:payload.tag}).then(items => items.forEach(item => item.close())).catch(() => {}); };
            }
          } catch { /* Same fallback as native browser-notifications.ts. */ }
        }
        const notification = new Notification("Pi Web · 待你处理", options);
        notification.onclick = () => { notification.close(); window.focus(); openProjectStatusSession(payload.sessionId); };
        return () => { notification.onclick = null; notification.close(); };
      },
    });
    desktopAttentionNotifier.reconcile(requests);
    if (projectStatusLeader) void desktopAttentionNotifier.notify(requests).catch(() => {});
  }
  async function requestDesktopAttentionPermission() {
    if (!window.isSecureContext || typeof Notification === "undefined") { showToast("浏览器通知需要 HTTPS 或 localhost/127.0.0.1"); return; }
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    showToast(permission === "granted" ? "通知权限已允许；请开启桌面待处理提醒" : "通知未获允许；可在浏览器站点设置中修改，站内提醒不受影响");
    setProjectStatusMonitoring(isPluginEnabled("project-status-indicator"));
  }

  projectStatusModel = createProjectStatusModel();
  // A ChatWindow session-load failure is local transport state, not an Agent
  // execution outcome. Keep it outside the authoritative cross-tab model.
  const localSessionLoadErrors = new Map();
  const PROJECT_STATUS_STORAGE_KEY_V1 = "pi-enh-project-status-v1";
  const PROJECT_STATUS_META = {
    attention: { color: "#f59e0b", label: "待你处理", title: "待处理" },
    interrupted: { color: "#f87171", label: "异常停止", title: "任务中断" },
    "load-error": { color: "#f87171", label: "加载异常", title: "任务中断" },
    completed: { color: "#4ade80", label: "本轮结束", title: "本轮结束" },
    running: { color: "#60a5fa", label: "运行中", title: "运行" },
    stopped: { color: "#a1a1aa", label: "已停止", title: "已停止" },
    idle: { color: "#a1a1aa", label: "空闲", title: "空闲" },
  };
  projectStatusState = readProjectStatusState();
  projectStatusCatalog = new Map();
  let projectStatusIntervalId = null;
  const projectStatusOriginalIcons = new Map();
  let projectTabStatusSnapshot = null;
  let projectInteractionInterval = null;
  let projectInteractionController = null;
  let projectInteractionGeneration = 0;
  projectStatusDisposed = false;

  function readProjectStatusState() {
    try {
      const raw = localStorage.getItem(PROJECT_STATUS_STORAGE_KEY_V1);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.sessions) {
          // Preserve metadata only. Pending/running/error facts must be read live.
          parsed.sessions = Object.fromEntries(Object.entries(parsed.sessions).map(([id, entry]) =>
            [id, { id, title: entry?.title || "", cwd: entry?.cwd || "", projectKey: entry?.projectKey || "", status: "idle", pendingRequests: [] }]));
          return parsed;
        }
      }
    } catch (e) {}
    return { sessions: {} };
  }

  function persistProjectStatusState() {
    const listEntries = projectStatusModel.list().map(entry => {
      const status = (entry.status === "completed" && !entry.unread) ? "idle" : entry.status;
      return [entry.id, { ...entry, status }];
    });
    const previous = projectStatusState.sessions || {};
    const nextSessions = Object.fromEntries(listEntries);
    for (const [id, prev] of Object.entries(previous)) {
      if (nextSessions[id]) {
        nextSessions[id].title = nextSessions[id].title || prev.title;
        nextSessions[id].cwd = nextSessions[id].cwd || prev.cwd;
        nextSessions[id].projectKey = nextSessions[id].projectKey || prev.projectKey;
      }
    }
    projectStatusState.sessions = nextSessions;
    try {
      localStorage.setItem(PROJECT_STATUS_STORAGE_KEY_V1, JSON.stringify(projectStatusState));
    } catch (e) {}
  }

  function markLocalActiveSessionAttention(sessionId, options = {}) {
    if (!sessionId) return;
    const session = projectStatusCatalog.get(sessionId) || {};
    const existing = projectStatusState.sessions[sessionId] || { id: sessionId };
    const pendingRequests = options.pendingRequests?.length
      ? options.pendingRequests
      : existing.pendingRequests?.length ? existing.pendingRequests : [{ id: "local-ask", method: "select" }];

    projectStatusState.sessions[sessionId] = {
      ...existing,
      id: sessionId,
      status: "attention",
      pendingRequests,
      projectKey: existing.projectKey || getSessionProjectStatusKey(session) || "",
      title: existing.title || getSessionStatusTitle(session) || "",
      cwd: existing.cwd || session.cwd || "",
    };
    projectStatusModel.markAttention(sessionId, pendingRequests);
    persistProjectStatusState();
    syncProjectStatusIndicators();
    try {
      window.__PI_WEB_SESSION_PRELOAD__?.setSessionPriority?.(sessionId, "attention");
      if (typeof schedulePrioritySessionPreloads === "function") {
        schedulePrioritySessionPreloads();
      }
    } catch (_) {}
    // 绝不盲目强行更新当前标签页标题为 attention！必须完全由 syncProjectStatusIndicators 根据当前标签页所在项目的真实有效状态统一计算判定，杜绝跨项目污染与闪烁
    if (options.notify !== false) {
      syncApprovalSound();
      syncDesktopAttention();
    }
    if (options.broadcast !== false && typeof projectStatusChannel?.postMessage === "function") {
      try {
        projectStatusChannel.postMessage({ type: "attention", sessionId, pendingRequests });
      } catch (e) {}
    }
  }

  function normalizeProjectStatusKey(value) {
    return String(value || "")
      .trim()
      .replace(/\//g, "\\")
      .replace(/[\\\\]+$/, "")
      .toLowerCase();
  }

  function getSessionProjectStatusKey(session) {
    return normalizeProjectStatusKey(session?.projectKey || session?.projectRoot || session?.cwd);
  }

  function getSessionStatusTitle(session) {
    return projectStatusModel.titleOf(session);
  }

  function refreshProjectStatusCatalog(sessions) {
    projectStatusModel.setCatalog(sessions);
    persistProjectStatusState();
    notifySessionCatalogFreshness(sessions);
    projectStatusCatalog = new Map();
    for (const session of sessions) {
      if (!session?.id) continue;
      projectStatusCatalog.set(session.id, session);
      const existing = projectStatusState.sessions[session.id];
      if (existing) {
        existing.projectKey = getSessionProjectStatusKey(session) || existing.projectKey || "";
        existing.cwd = session.cwd || existing.cwd || "";
        existing.title = getSessionStatusTitle(session) || existing.title || "";
      }
    }
    if (typeof schedulePrioritySessionPreloads === "function") {
      schedulePrioritySessionPreloads();
    }
  }

  function getSessionIdFromCurrentUrl() {
    try {
      return new URLSearchParams(window.location.search).get("session");
    } catch (e) {
      return null;
    }
  }

  function getKnownProjectStatusKeys() {
    const knownProjectKeys = new Set();
    for (const session of projectStatusCatalog.values()) {
      const key = getSessionProjectStatusKey(session);
      if (key) knownProjectKeys.add(key);
    }
    for (const entry of Object.values(projectStatusState.sessions)) {
      const key = normalizeProjectStatusKey(entry?.projectKey);
      if (key) knownProjectKeys.add(key);
    }
    return knownProjectKeys;
  }

  function getCurrentProjectStatusKey() {
    const selected = document.querySelector("[data-pi-enh-current-project]");
    if (selected) return normalizeProjectStatusKey(selected.getAttribute("data-pi-enh-current-project"));

    // 优先从原生界面的新建按钮与当前项目选择按钮直接提取当前选中的工作区（支持中英文）
    const sidebar = document.querySelector(".sidebar-container") || document.querySelector("aside") || document.body;
    for (const button of sidebar.querySelectorAll("button")) {
      const title = (button.getAttribute("title") || "").trim();
      const mZh = title.match(/在\s+(.*?)\s+中新建会话/);
      if (mZh && mZh[1]) return normalizeProjectStatusKey(mZh[1]);
      const mEn = title.match(/New session in\s+(.*)/i);
      if (mEn && mEn[1]) return normalizeProjectStatusKey(mEn[1]);
    }
    const pickerBtn = sidebar.querySelector("div[style*='position: relative'] > button[title*='/']:not([title*=' '])") ||
                      sidebar.querySelector("div[style*='position: relative'] > button[title*='\\\\']:not([title*=' '])");
    if (pickerBtn) {
      const t = pickerBtn.getAttribute("title");
      if (t) return normalizeProjectStatusKey(t);
    }

    const currentSessionId = getSessionIdFromCurrentUrl();
    const currentSession = currentSessionId ? projectStatusCatalog.get(currentSessionId) : null;
    const currentFromSession = getSessionProjectStatusKey(currentSession);
    if (currentFromSession) return currentFromSession;
    if (currentSessionId && projectStatusState?.sessions?.[currentSessionId]?.projectKey) {
      return normalizeProjectStatusKey(projectStatusState.sessions[currentSessionId].projectKey);
    }

    for (const button of document.querySelectorAll("button")) {
      const title = (button.getAttribute("title") || "").trim();
      if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(title) && !/(?:在|in)\s+.*\s+(?:中|session)/i.test(title)) {
        return normalizeProjectStatusKey(title);
      }
    }

    const knownProjectKeys = getKnownProjectStatusKeys();
    for (const button of document.querySelectorAll("button")) {
      const key = normalizeProjectStatusKey(button.getAttribute("title"));
      if (key && knownProjectKeys.has(key)) return key;
    }
    return null;
  }

  function getEffectiveProjectStatusEntry(id) {
    const entry = projectStatusModel.entry(id);
    if (!isProjectStatusHealthy()) return { ...entry, status: "unknown", pendingRequests: [], unread: false };
    if (localSessionLoadErrors.has(id) && entry.status === "idle") {
      return { ...entry, status: "load-error", loadError: localSessionLoadErrors.get(id) };
    }
    return entry;
  }

  function getEffectiveProjectStatusItems(projectKey, status = null, others = false) {
    const target = normalizeProjectStatusKey(projectKey);
    if (!target && !others) return [];
    return projectStatusModel.items(projectKey, null, others).map(entry => getEffectiveProjectStatusEntry(entry.id)).filter(entry => {
      const inScope = others ? (entry.projectKey && entry.projectKey !== target) : (entry.projectKey === target);
      const statusMatches = !status || entry.status === status || status === "interrupted" && entry.status === "load-error";
      return inScope && statusMatches;
    });
  }

  function getEffectiveProjectStatusSummary(projectKey) {
    const counts = { attention: 0, interrupted: 0, running: 0, completed: 0, status: null };
    for (const entry of getEffectiveProjectStatusItems(projectKey)) {
      const status = entry.status === "load-error" ? "interrupted" : entry.status;
      if (Object.hasOwn(counts, status)) counts[status]++;
    }
    counts.status = ["attention", "interrupted", "running"].find(status => counts[status]) || null;
    return counts;
  }

  function getProjectStatus(key) { return getEffectiveProjectStatusSummary(key).status; }

  function findNativeSessionLoadError() {
    return Array.from(document.querySelectorAll("main .text-red-400")).find(node => {
      const classes = node.classList;
      return classes?.contains("flex") && classes.contains("h-full") && classes.contains("items-center")
        && classes.contains("justify-center") && /^(?:Error|TypeError|Failed to fetch|错误)\s*[:：]?/i.test(String(node.textContent || "").trim());
    }) || null;
  }

  function reconcileCurrentSessionLoadError() {
    const id = getSessionIdFromCurrentUrl();
    if (!id) return;
    const error = findNativeSessionLoadError();
    if (error) {
      localSessionLoadErrors.set(id, { message: String(error.textContent || "").trim().slice(0, 160), observedAt: Date.now() });
    } else {
      localSessionLoadErrors.delete(id);
    }
  }

  function findSessionForStatusRow(row) {
    const sessionId = row.getAttribute("data-pi-enh-session-id");
    if (sessionId) {
      const session = projectStatusCatalog.get(sessionId);
      if (session) return session;
      const stored = projectStatusState.sessions[sessionId];
      if (stored) return { id: sessionId, ...stored };
    }
    const titleNodes = row.querySelectorAll("[title]");
    const titles = Array.from(titleNodes).map((node) => String(node.getAttribute("title") || "").trim()).filter(Boolean);
    for (const session of projectStatusCatalog.values()) {
      const candidates = [session.name, session.firstMessage, session.id].map((value) => String(value || "").trim()).filter(Boolean);
      if (candidates.some((candidate) => titles.includes(candidate))) return session;
    }
    for (const [id, entry] of Object.entries(projectStatusState.sessions)) {
      if (entry?.title && titles.includes(String(entry.title).trim())) return { id, ...entry };
    }
    return null;
  }

  function getSessionStatusRows() {
    const explicitRows = Array.from(document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]"));
    if (explicitRows.length > 0) return explicitRows;
    const sidebar = (typeof document !== "undefined" && (document.querySelector(".sessions-sidebar, aside, [data-session-list], nav") || document)) || null;
    if (!sidebar) return [];
    const fastRows = sidebar.querySelectorAll('div[style*="54px"]');
    if (fastRows && fastRows.length > 0) {
      return Array.from(fastRows).filter((element) => element.querySelectorAll("[title]").length > 0);
    }
    const divs = sidebar.querySelectorAll("div");
    return Array.from(divs).filter((element) => {
      if (element.style?.height !== "54px") return false;
      return element.querySelectorAll("[title]").length > 0;
    });
  }

  function restoreStatusRow(row) {
    row.removeAttribute("data-pi-enh-completed-unread");
    row.classList.remove("pi-enh-session-needs-attention");
    row.removeAttribute("data-pi-enh-project-status");
    const originalBackground = row.getAttribute("data-pi-enh-original-background");
    const originalBorderLeft = row.getAttribute("data-pi-enh-original-border-left");
    if (originalBackground !== null) row.style.background = originalBackground;
    if (originalBorderLeft !== null) row.style.borderLeft = originalBorderLeft;
    row.removeAttribute("data-pi-enh-original-background");
    row.removeAttribute("data-pi-enh-original-border-left");
  }

  function decorateProjectStatusRows() {
    const rows = getSessionStatusRows();
    for (const row of rows) {
      if (row.hasAttribute("data-pi-native-project-status")) continue;
      const session = findSessionForStatusRow(row);
      const entry = session ? getEffectiveProjectStatusEntry(session.id) : null;
      const status = entry?.status || null;
      if (!status || status === "idle") { restoreStatusRow(row); continue; }
      // 已读的“本轮结束”立刻从侧边栏清除消失，不在侧边栏残留灰色徽标
      if (status === "completed" && !entry.unread) { restoreStatusRow(row); continue; }
      if (row.getAttribute("data-pi-enh-project-status") !== status) {
        restoreStatusRow(row);
        row.setAttribute("data-pi-enh-project-status", status);
        if (status === "attention") row.classList.add("pi-enh-session-needs-attention");
      }
      const unreadValue = status === "completed" ? String(entry.unread) : null;
      if (unreadValue !== null && row.getAttribute("data-pi-enh-completed-unread") !== unreadValue) row.setAttribute("data-pi-enh-completed-unread", unreadValue);
      else if (unreadValue === null && row.hasAttribute("data-pi-enh-completed-unread")) row.removeAttribute("data-pi-enh-completed-unread");

    }
  }

  function restoreProjectStatusDot(dot) {
    const created = dot.getAttribute("data-pi-enh-project-status-created") === "true";
    if (created) {
      dot.remove();
      return;
    }
    const originalBackground = dot.getAttribute("data-pi-enh-original-background");
    const originalTitle = dot.getAttribute("data-pi-enh-original-title");
    const originalAriaLabel = dot.getAttribute("data-pi-enh-original-aria-label");
    if (originalBackground !== null) dot.style.background = originalBackground;
    if (originalTitle !== null) dot.setAttribute("title", originalTitle);
    if (originalAriaLabel !== null) dot.setAttribute("aria-label", originalAriaLabel);
    dot.removeAttribute("data-pi-enh-project-status");
    dot.removeAttribute("data-pi-enh-project-status-dot");
    dot.removeAttribute("data-pi-enh-project-status-created");
    dot.removeAttribute("data-pi-enh-original-background");
    dot.removeAttribute("data-pi-enh-original-title");
    dot.removeAttribute("data-pi-enh-original-aria-label");
    dot.classList.remove("pi-enh-project-status-dot");
  }

  function syncProjectStatusDot(projectButton, status) {
    if (!projectButton || projectButton.hasAttribute("data-pi-native-project-status")) return;
    let dot = projectButton.querySelector("[data-pi-enh-project-status-dot]");
    if (!dot) {
      dot = projectButton.querySelector("[title]");
      if (!dot || dot === projectButton || !/有新活动|new activity/i.test(dot.getAttribute("title") || "")) dot = null;
    }
    if (!status) {
      if (dot?.hasAttribute("data-pi-enh-project-status")) restoreProjectStatusDot(dot);
      return;
    }
    if (!dot) {
      dot = document.createElement("span");
      dot.setAttribute("data-pi-enh-project-status-created", "true");
      projectButton.appendChild(dot);
    } else if (!dot.hasAttribute("data-pi-enh-project-status")) {
      dot.setAttribute("data-pi-enh-original-background", dot.style.background || "");
      dot.setAttribute("data-pi-enh-original-title", dot.getAttribute("title") || "");
      dot.setAttribute("data-pi-enh-original-aria-label", dot.getAttribute("aria-label") || "");
    }
    const meta = PROJECT_STATUS_META[status];
    dot.classList.add("pi-enh-project-status-dot");
    dot.setAttribute("data-pi-enh-project-status-dot", "true");
    dot.setAttribute("data-pi-enh-project-status", status);
    dot.setAttribute("title", meta.title);
    dot.setAttribute("aria-label", meta.title);
    dot.style.background = meta.color;
  }

  function cleanSessionTitleBase(title) {
    if (!title) return "";
    let clean = String(title)
      .replace(/^\(⏱️.*?\)\s*/, "")
      .replace(/^⏱️\s+[\d.]+s\s+·\s+/, "")
      .replace(/^✅\s*\(.*?\)\s*/, "")
      .replace(/^(?:🔵|🟠【等待答复】|⚠️\s*需要确认|🟠\s*需要确认|🔴\s*任务中断|🟢\s*已完成待验收|🟢\s*已完成)\s*(?:·\s*)?/, "")
      .replace(/\s+·\s+(?:🟠【等待答复】|⚠️\s*需要确认|🟠\s*需要确认|🔴\s*任务中断|🟢\s*已完成待验收|🟢\s*已完成|🔵\s*运行中|🔵)\s*$/, "")
      .replace(/\s*[-·|_]\s*(?:π\+\s*)?\bPi\s*Web\b(?:\s+Plus\b|\s*\+)?/gi, "")
      .replace(/(?:π\+\s*)?\bPi\s*Web\b(?:\s+Plus\b|\s*\+)?\s*[-·|_]\s*/gi, "")
      .replace(/(?:π\+\s*)?\bPi\s*Web\b(?:\s+Plus\b|\s*\+)?/gi, "")
      .replace(/\s*[-·|_]\s*$/, "")
      .trim();
    return clean || "work";
  }

  function stripProjectStatusTitleSuffix(title) {
    return cleanSessionTitleBase(title);
  }

  function renderProjectStatusFavicon(count, hasAttention) {
    const favicon = document.head?.querySelector("link[data-pi-enh-attention-favicon]");
    if (!favicon) return;
    const color = hasAttention ? "#f59e0b" : "#3b82f6";
    const badge = count > 9 ? "9+" : String(count);
    const fontSize = badge.length > 1 ? 22 : 26;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><linearGradient id="flatBlueViolet" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#4F5AE8"/><stop offset="100%" stop-color="#7850E8"/></linearGradient></defs><g transform="translate(13.7 21.6) scale(0.84)"><circle cx="91.2" cy="96" r="87.5" fill="url(#flatBlueViolet)"/><path fill="#FFFFFF" d="M67.7,59.5H132.7C135.9,59.5 136.1,62.9 135.4,67.2C134.8,71.3 133.9,73.5 130.4,73.5H114.1L107.7,107.5C106.3,114.4 106.7,118.8 110.8,121.2C114.6,123.3 121.1,123.8 124.9,119.8C126.7,117.9 128.6,120 129.5,123C131.7,130.9 122.2,137.5 113.8,137.5C101.1,137.5 92.2,131.4 93.7,114.9C94.1,105.5 97.7,86.3 100.5,73.5H82.1L75.5,108.4C72.9,122.1 66.6,137.5 55.6,137.5C49.5,137.5 45.8,132.7 48,127.2C49.6,123.8 54.5,122 57.5,116C62.4,106.5 65.3,89.4 68.7,73.7H60.2C56.7,73.7 55.3,75.4 53.1,78.4C50.5,82.3 43.5,82.9 44.9,77.2C47.2,67.1 56.2,59.5 67.7,59.5Z"/></g><circle cx="167" cy="38" r="34" fill="${color}" stroke="#FFFFFF" stroke-width="3"/><text x="167" y="${badge.length > 1 ? 46 : 47}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="white">${badge}</text></svg>`;
    const href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    if (favicon.getAttribute("href") !== href) favicon.setAttribute("href", href);
  }

  function restoreProjectStatusFavicon() {
    document.head?.querySelector("link[data-pi-enh-attention-favicon]")?.remove();
    for (const [icon, rel] of projectStatusOriginalIcons) {
      if (rel) icon.setAttribute("rel", rel);
      else icon.removeAttribute("rel");
    }
    projectStatusOriginalIcons.clear();
  }

  function syncProjectStatusFavicon(snapshot) {
    if (!snapshot?.count || projectStatusDisposed || !isPluginEnabled("project-status-indicator")) {
      restoreProjectStatusFavicon();
      return;
    }
    for (const icon of document.head.querySelectorAll('link[rel~="icon"]')) {
      if (icon.hasAttribute("data-pi-enh-attention-favicon")) continue;
      if (!projectStatusOriginalIcons.has(icon)) projectStatusOriginalIcons.set(icon, icon.getAttribute("rel"));
      icon.removeAttribute("rel");
    }
    let favicon = document.head.querySelector("link[data-pi-enh-attention-favicon]");
    if (!favicon) {
      favicon = document.createElement("link");
      favicon.setAttribute("rel", "icon");
      favicon.setAttribute("type", "image/svg+xml");
      favicon.setAttribute("data-pi-enh-attention-favicon", "true");
      document.head.appendChild(favicon);
    }
    renderProjectStatusFavicon(snapshot.hasAttention ? snapshot.attention : snapshot.running, snapshot.hasAttention);
  }

  function getCurrentProjectTabStatusSnapshot() {
    const projectKey = getCurrentProjectStatusKey();
    const counts = { running: 0, attention: 0 };
    const healthy = isProjectStatusHealthy();
    if (healthy && projectKey) {
      const target = normalizeProjectStatusKey(projectKey);
      for (const entry of projectStatusModel.list()) {
        if (entry.projectKey !== target) continue;
        if (entry.status === "attention" && entry.pendingRequests.length) counts.attention++;
        else if (entry.status === "running") counts.running++;
      }
    }
    return { projectKey: normalizeProjectStatusKey(projectKey), ...counts,
      count: counts.running + counts.attention, hasAttention: counts.attention > 0, healthy };
  }

  function syncProjectTabStatusSnapshot(force = false) {
    const currentProjectKey = normalizeProjectStatusKey(getCurrentProjectStatusKey());
    if (!force && projectTabStatusSnapshot?.projectKey === currentProjectKey) return projectTabStatusSnapshot;
    projectTabStatusSnapshot = projectStatusDisposed || !isPluginEnabled("project-status-indicator")
      ? { projectKey: currentProjectKey, count: 0, hasAttention: false }
      : getCurrentProjectTabStatusSnapshot();
    window.__PI_WEB_PROJECT_TAB_STATUS__ = projectTabStatusSnapshot;
    syncProjectStatusFavicon(projectTabStatusSnapshot);
    return projectTabStatusSnapshot;
  }

  function hasActiveAskUserOnScreen() {
    // Visibility is a read-only hint; pending/closed request state stays server-owned.
    const picker = document.querySelector('[data-ask-user-picker]');
    return Boolean(picker && picker.getAttribute("aria-busy") !== "true");
  }

  function isCurrentSessionInAttention(sid = null) {
    const sessionId = sid || getSessionIdFromCurrentUrl();
    if (!sessionId) return false;
    const stored = projectStatusState.sessions[sessionId];
    if (stored?.status === "attention" && stored.pendingRequests && stored.pendingRequests.length > 0) return true;
    return false;
  }

  function hasAnyAttentionSession() {
    if (typeof projectStatusState === "undefined" || !projectStatusState?.sessions) return false;
    for (const entry of Object.values(projectStatusState.sessions)) {
      if (entry?.status === "attention" && entry.pendingRequests && entry.pendingRequests.length > 0) {
        return true;
      }
    }
    return false;
  }

  function getCurrentEffectiveStatus(key = null) {
    if (projectStatusDisposed || !isPluginEnabled("project-status-indicator") || !isProjectStatusHealthy()) return null;
    return getProjectStatusForSummary(key || getCurrentProjectStatusKey());
  }

  function formatProjectTabTitle(base, snapshot) {
    const cleanBase = cleanSessionTitleBase(base);
    // Unknown transport health has no task count. Keep diagnostics in the workspace
    // indicator instead of an unexplained question mark in the browser tab.
    if (!snapshot.healthy) return cleanBase;
    const parts = [];
    if (snapshot.running) parts.push(`🔵${snapshot.running}`);
    if (snapshot.attention) parts.push(`🟡${snapshot.attention}`);
    return parts.length ? `${cleanBase} ${parts.join(" ")}` : cleanBase;
  }

  function composeProjectWindowTitle(base) {
    if (projectStatusDisposed || !isPluginEnabled("project-status-indicator")) {
      return window.__PI_WEB_NATIVE_TITLE_BASE__ || base || "Pi Web";
    }
    const snapshot = syncProjectTabStatusSnapshot(false);
    return formatProjectTabTitle(base, snapshot);
  }
  window.__PI_ENH_COMPOSE_WINDOW_TITLE__ = composeProjectWindowTitle;
  window.__PI_ENH_CLEAR_SESSION_ATTENTION__ = clearSessionAttention;
  window.__PI_ENH_MARK_LOCAL_ACTIVE_SESSION_ATTENTION__ = markLocalActiveSessionAttention;
  window.__PI_ENH_GET_EFFECTIVE_PROJECT_STATUS_ENTRY__ = getEffectiveProjectStatusEntry;
  window.__PI_ENH_GET_CURRENT_PROJECT_STATUS_KEY__ = getCurrentProjectStatusKey;
  window.__PI_ENH_GET_CURRENT_EFFECTIVE_STATUS__ = getCurrentEffectiveStatus;
  window.__PI_ENH_GET_PROJECT_STATUS_FOR_SUMMARY__ = getProjectStatusForSummary;
  window.__PI_ENH_GET_PROJECT_ACTIVITY__ = (projectKey, others = false) => {
    if (projectStatusDisposed || !isPluginEnabled("project-status-indicator")) return null;
    const healthy = isProjectStatusHealthy();
    const counts = { running: 0, attention: 0, interrupted: 0 };
    if (healthy) for (const entry of projectStatusModel.items(projectKey, null, others)) {
      if (Object.hasOwn(counts, entry.status)) counts[entry.status]++;
    }
    const status = healthy ? ["attention", "interrupted", "running"].find(s => counts[s]) || null : "unknown";
    const parts = [];
    if (counts.running) parts.push(`运行 ${counts.running}`);
    if (counts.attention) parts.push(`待回复 ${counts.attention}`);
    if (counts.interrupted) parts.push(`异常停止 ${counts.interrupted}`);
    return { ...counts, status, label: healthy ? parts.join("，") || "无运行或待回复任务" : "状态待确认" };
  };

  function updateProjectStatusTitle() {
    syncProjectTabStatusSnapshot(true);
    window.dispatchEvent(new Event("pi-enh-title-change"));
  }

  function getCurrentProjectButton() {
    const explicit = document.querySelector("[data-pi-enh-current-project]");
    if (explicit) return explicit;
    const currentKey = getCurrentProjectStatusKey();
    const candidates = document.querySelectorAll("button");
    for (const button of candidates) {
      const title = normalizeProjectStatusKey(button.getAttribute("title"));
      if (currentKey && title === currentKey) return button;
    }
    return Array.from(candidates).find((button) => {
      const title = button.getAttribute("title") || "";
      return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(title) && !/在 .* 中/.test(title);
    }) || null;
  }

  function getProjectStatusForSummary(projectKey, others = false) {
    const target = normalizeProjectStatusKey(projectKey);
    if (!target && !others) return null;
    const counts = { attention: 0, interrupted: 0, running: 0 };
    for (const rawEntry of projectStatusModel.items(target, null, others)) {
      const entry = getEffectiveProjectStatusEntry(rawEntry.id);
      if (Object.hasOwn(counts, entry.status)) counts[entry.status]++;
    }
    return ["attention", "interrupted", "running"].find(status => counts[status]) || null;
  }

  function syncProjectStatusDots() {
    const knownProjectKeys = getKnownProjectStatusKeys();
    const currentKey = getCurrentProjectStatusKey();
    const currentProjectButton = getCurrentProjectButton();
    const activeDots = new Set();
    for (const button of document.querySelectorAll("button")) {
      const projectKey = normalizeProjectStatusKey(button.getAttribute("title"));
      if (!projectKey || !knownProjectKeys.has(projectKey)) continue;
      const status = button === currentProjectButton
        ? getProjectStatusForSummary(currentKey, true)
        : getProjectStatusForSummary(projectKey);
      syncProjectStatusDot(button, status);
      const dot = button.querySelector("[data-pi-enh-project-status-dot]");
      if (dot) activeDots.add(dot);
    }
    for (const dot of document.querySelectorAll("[data-pi-enh-project-status-dot]")) {
      if (!activeDots.has(dot)) restoreProjectStatusDot(dot);
    }
  }

  /*
   * Keep project status rows and browser chrome sourced from one snapshot so
   * read completion and resolved Ask User state update together.
   */
  function syncProjectStatusIndicators() {
    if (projectStatusDisposed || !isPluginEnabled("project-status-indicator")) {
      removeProjectStatusIndicators();
      return;
    }
    reconcileCurrentSessionLoadError();
    if (typeof document !== "undefined" && !document.hidden) {
      const curId = getSessionIdFromCurrentUrl();
      if (curId) {
        const wm = (typeof readSessionReadWatermarks === "function") ? readSessionReadWatermarks()[curId] : null;
        if (!wm?.manualUnread) {
          if (typeof markSessionAsRead === "function") markSessionAsRead(curId);
          else if (typeof markProjectCompletionRead === "function") markProjectCompletionRead(curId);
        }
      }
    }
    decorateProjectStatusRows();
    renderAttentionNotices();
    syncProjectStatusDots();
    renderProjectStatusSummary();
    updateProjectStatusTitle();
    window.__PI_ENH_RERENDER_SESSIONS__?.();
  }

  function removeProjectStatusIndicators() {
    disposeDesktopAttention();
    disposeApprovalSound();
    document.documentElement.removeAttribute("data-pi-enh-interaction-sync");
    for (const node of document.querySelectorAll(".pi-enh-project-status-summary, .pi-enh-status-popover, .pi-enh-attention-notice")) node.remove();
    for (const row of getSessionStatusRows()) if (!row.hasAttribute("data-pi-native-project-status")) restoreStatusRow(row);
    for (const dot of document.querySelectorAll("[data-pi-enh-project-status-dot]")) restoreProjectStatusDot(dot);
    updateProjectStatusTitle();
    window.__PI_ENH_RERENDER_SESSIONS__?.();
  }

  function clearSessionAttention(sessionId, nextStatus = null, resolvedRequestIds = []) {
    if (!sessionId) return;
    if (Array.isArray(resolvedRequestIds) && resolvedRequestIds.length > 0) {
      rememberResolvedAskUserRequests(sessionId, resolvedRequestIds);
    }
    projectStatusModel.clearAttention(sessionId, nextStatus);
    if (projectStatusState.sessions[sessionId]) {
      const current = projectStatusState.sessions[sessionId];
      projectStatusState.sessions[sessionId] = {
        ...current,
        status: nextStatus || (current.execution === "running" ? "running" : "idle"),
        pendingRequests: [],
      };
    }
    renderAttentionNotices();
    persistProjectStatusState();
    syncProjectStatusIndicators();
    if (typeof schedulePrioritySessionPreloads === "function") {
      schedulePrioritySessionPreloads();
    }

    // 立即 reconcile 声音与桌面通知，不让 resolved 旧 payload 复活
    const requests = getDesktopPendingRequests();
    desktopAttentionNotifier?.reconcile(requests);
    approvalSoundNotifier?.reconcile(requests);
  }

  function resolveCurrentAskUserStatus(sessionId = getSessionIdFromCurrentUrl()) {
    if (sessionId) {
      clearSessionAttention(sessionId);
      projectStatusChannel?.postMessage({ type: "clear-attention", sessionId });
    }
    // DOM unmount/navigation is NOT a server response. Reconcile instead.
    void refreshProjectInteractions(true);
  }

  function resolveAskUserToolResult(sessionId, toolCallId, broadcast = true) {
    if (!sessionId || !toolCallId) return false;
    const current = getEffectiveProjectStatusEntry(sessionId);
    const pending = current?.status === "attention" ? current.pendingRequests || [] : [];
    const matched = pending.some(request => request?.id === toolCallId || request?.id === "local-ask" || request?.id === "pending-ask");
    if (!matched) return false;
    rememberResolvedAskUserRequests(sessionId, [toolCallId]);
    const remaining = pending.filter(request => request?.id !== toolCallId && request?.id !== "local-ask" && request?.id !== "pending-ask");
    if (remaining.length) {
      markLocalActiveSessionAttention(sessionId, { pendingRequests: remaining, broadcast: false, notify: false });
    } else {
      clearSessionAttention(sessionId, null, [toolCallId]);
    }
    if (broadcast) projectStatusChannel?.postMessage({ type: "resolved-ask-user", sessionId, toolCallId });
    return true;
  }

  projectStatusLeader = false; projectStatusChannel = null; let projectStatusLockController = null, releaseProjectStatusLock = null;
  projectStatusLastPayload = null; let projectStatusCatalogVersion = null, projectStatusNextPoll = 0, projectStatusFailures = 0;
  const projectStatusResolvedAskUserRequests = new Map();

  function getProjectStatusAskUserRequestBucketKey(sessionId, epoch = null) {
    const resolvedEpoch = String(epoch || projectStatusLastPayload?.statusSnapshot?.epoch || "local");
    return JSON.stringify([resolvedEpoch, String(sessionId || "")]);
  }

  function rememberResolvedAskUserRequests(sessionId, requestIds, epoch = null) {
    if (!sessionId || !Array.isArray(requestIds) || requestIds.length === 0) return;
    const key = getProjectStatusAskUserRequestBucketKey(sessionId, epoch);
    const resolved = projectStatusResolvedAskUserRequests.get(key) || new Set();
    for (const requestId of requestIds) {
      if (requestId !== undefined && requestId !== null && requestId !== "") resolved.add(String(requestId));
    }
    if (resolved.size > 0) projectStatusResolvedAskUserRequests.set(key, resolved);
    while (projectStatusResolvedAskUserRequests.size > 128) {
      const oldest = projectStatusResolvedAskUserRequests.keys().next().value;
      if (oldest === undefined) break;
      projectStatusResolvedAskUserRequests.delete(oldest);
    }
  }

  function filterResolvedAskUserRequests(payload) {
    const sessions = payload?.interactionState?.sessions;
    if (!Array.isArray(sessions) || sessions.length === 0) return payload;
    const epoch = payload?.statusSnapshot?.epoch || "local";
    let changed = false;
    const nextSessions = sessions.map(session => {
      const pendingRequests = session?.pendingRequests;
      const resolved = projectStatusResolvedAskUserRequests.get(getProjectStatusAskUserRequestBucketKey(session?.sessionId, epoch));
      if (!resolved || !Array.isArray(pendingRequests) || pendingRequests.length === 0) return session;
      const filtered = pendingRequests.filter(request => {
        const requestId = request?.id;
        return requestId === undefined || requestId === null || requestId === "" || !resolved.has(String(requestId));
      });
      if (filtered.length === pendingRequests.length) return session;
      changed = true;
      return { ...session, pendingRequests: filtered };
    });
    return changed
      ? { ...payload, interactionState: { ...payload.interactionState, sessions: nextSessions } }
      : payload;
  }
  let projectStatusCatalogController = null, projectStatusRefreshQueued = false;
  const COMPLETED_READ_KEY = "pi-enh-completed-read-v1";
  function readCompletedTokens() {
    try { const value = JSON.parse(localStorage.getItem(COMPLETED_READ_KEY) || "[]"); return Array.isArray(value) ? value.filter(item => typeof item === "string") : []; } catch { return []; }
  }
  projectStatusModel.setCompletedRead(readCompletedTokens());

  function markProjectCompletionRead(id) {
    if (!id) return;
    const token = projectStatusModel.readCompleted(id);
    if (!token) return;
    const tokens = [...new Set([...readCompletedTokens(), token])].slice(-500);
    try { localStorage.setItem(COMPLETED_READ_KEY, JSON.stringify(tokens)); } catch {}
    persistProjectStatusState();
    updateProjectStatusTitle();
  }

  function markProjectCompletionUnread(id) {
    if (!id) return;
    if (typeof projectStatusModel !== "undefined" && typeof projectStatusModel.unreadCompleted === "function") {
      projectStatusModel.unreadCompleted(id);
    }
    const currentTokens = readCompletedTokens();
    const filtered = currentTokens.filter(token => {
      try {
        const parsed = JSON.parse(token);
        if (Array.isArray(parsed)) {
          if (parsed.length === 2 && parsed[0] === id) return false;
          if (parsed.length === 3 && parsed[1] === id) return false;
        }
      } catch (e) {}
      return true;
    });
    if (filtered.length !== currentTokens.length) {
      try { localStorage.setItem(COMPLETED_READ_KEY, JSON.stringify(filtered)); } catch {}
      persistProjectStatusState();
    }
    updateProjectStatusTitle();
  }

  function receiveProjectStatus(payload, catalog = null) {
    const reconciledPayload = filterResolvedAskUserRequests(payload);
    const result = projectStatusModel.apply(reconciledPayload, Date.now());
    if (result.accepted) {
      projectStatusLastPayload = reconciledPayload;
      if (catalog) refreshProjectStatusCatalog(catalog);
      projectStatusModel.setUnread([...readUnreadSessionIds()]);
      projectStatusModel.setCompletedRead(readCompletedTokens());
      if (typeof reconcileUnreadSessions === "function") reconcileUnreadSessions();
      persistProjectStatusState();
      syncApprovalSound();
      syncDesktopAttention();
    }

    // 无论是否带 interactionState，只要能正常拿到 runningSessionIds，就是健康状态
    if (result.accepted) {
      projectStatusFailures = 0;
      const runningSet = new Set(payload.runningSessionIds || []);
      try {
        for (const [sId, entry] of sessionMemoryCache.entries()) {
          if (entry.isRunning && !runningSet.has(sId)) markSessionRunning(sId, false);
        }
        for (const rId of runningSet) markSessionRunning(rId, true);
      } catch (e) {}
    }
    syncProjectStatusIndicators();
    if (typeof schedulePrioritySessionPreloads === "function") {
      schedulePrioritySessionPreloads();
    }
    return result.accepted;
  }

  let isProjectStatusMonitoringActive = false;
  function setProjectStatusMonitoring(enabled) {
    projectInteractionGeneration++;
    projectInteractionController?.abort(); projectInteractionController = null;
    projectStatusCatalogController?.abort(); projectStatusCatalogController = null;
    projectStatusRefreshQueued = false;
    projectStatusLockController?.abort(); projectStatusLockController = null;
    releaseProjectStatusLock?.(); releaseProjectStatusLock = null;
    projectStatusLeader = false;
    projectStatusChannel?.close(); projectStatusChannel = null;
    if (projectInteractionInterval !== null) clearInterval(projectInteractionInterval);
    if (projectStatusIntervalId !== null) clearInterval(projectStatusIntervalId);
    projectInteractionInterval = projectStatusIntervalId = null;
    if (!enabled || projectStatusDisposed || isLoginPage()) {
      isProjectStatusMonitoringActive = false;
      return;
    }
    isProjectStatusMonitoringActive = true;
    const generation = projectInteractionGeneration;
    if (typeof window.__PI_WEB_REFRESH_PROJECT_STATUS__ === "function") {
      if (window.__PI_WEB_PROJECT_STATUS_SNAPSHOT__) receiveProjectStatus(window.__PI_WEB_PROJECT_STATUS_SNAPSHOT__, window.__PI_ENH_GET_RAW_SESSIONS__?.());
      return;
    }
    if (typeof BroadcastChannel === "function") {
      projectStatusChannel = new BroadcastChannel("pi-web-status-v2");
      projectStatusChannel.onmessage = event => {
        if (generation !== projectInteractionGeneration) return;
        const data = event.data;
        if (data?.type === "hello" && projectStatusLeader && projectStatusLastPayload) projectStatusChannel.postMessage({ type: "snapshot", payload: projectStatusLastPayload, catalog: [...projectStatusCatalog.values()] });
        if (data?.type === "snapshot") receiveProjectStatus(data.payload, data.catalog);
        if (data?.type === "attention" && data.sessionId) {
          markLocalActiveSessionAttention(data.sessionId, {
            pendingRequests: data.pendingRequests,
            broadcast: false,
            notify: false,
          });
        }
        if (data?.type === "refresh" && projectStatusLeader) requestProjectStatusRefresh();
        if (data?.type === "clear-attention" && data.sessionId) clearSessionAttention(data.sessionId);
        if (data?.type === "resolved-ask-user" && data.sessionId && data.toolCallId) resolveAskUserToolResult(data.sessionId, data.toolCallId, false);
        if (data?.type === "unavailable") { projectStatusModel.unavailable("unavailable"); syncProjectStatusIndicators(); }
      };
      projectStatusChannel.postMessage({ type: "hello" });
    }
    // 排除浏览器隐藏导致全监控退出；即使后台标签可能被系统深度冻结，也不主动终止监控
    const start = () => {
      if (generation !== projectInteractionGeneration) return;
      projectStatusLeader = true; projectStatusNextPoll = 0;
      projectInteractionInterval = setInterval(refreshProjectInteractions, 2000);
      void refreshProjectInteractions();
    };
    if (typeof navigator !== "undefined" && navigator.locks && projectStatusChannel) {
      projectStatusLockController = new AbortController();
      navigator.locks.request("pi-web-status-observer-v2", { signal: projectStatusLockController.signal }, async () => {
        if (generation !== projectInteractionGeneration) return;
        start();
        await new Promise(resolve => { releaseProjectStatusLock = resolve; });
      }).catch(() => {});
    } else start(); // Explicit fallback: no cross-tab poll coordination on older browsers.
  }

  function requestProjectStatusRefresh(urgent = false) {
    if (projectStatusDisposed || !isPluginEnabled("project-status-indicator")) return;
    projectStatusNextPoll = 0;
    if (typeof window.__PI_WEB_REFRESH_PROJECT_STATUS__ === "function") {
      void window.__PI_WEB_REFRESH_PROJECT_STATUS__();
      return;
    }
    if (!projectStatusLeader && !urgent) { projectStatusChannel?.postMessage({ type: "refresh" }); return; }
    if (projectInteractionController) {
      if (!urgent) { projectStatusRefreshQueued = true; return; }
      projectInteractionController.abort(); projectInteractionController = null;
    }
    // A reply may originate in a follower tab while its observer is throttled.
    // One acknowledgement-driven read is safe; it does not take over polling.
    void refreshProjectInteractions(urgent);
  }

  function refreshProjectStatusCatalogInBackground(version) {
    if (projectStatusCatalogController || projectStatusCatalog.size && version === projectStatusCatalogVersion) return;
    const controller = new AbortController(), generation = projectInteractionGeneration;
    projectStatusCatalogController = controller;
    const timer = setTimeout(() => controller.abort(), 8000);
    void refreshProjectStatus(version, controller.signal).then(() => {
      if (generation !== projectInteractionGeneration || projectStatusDisposed) return;
      syncProjectStatusIndicators();
      projectStatusChannel?.postMessage({ type: "snapshot", payload: projectStatusLastPayload, catalog: [...projectStatusCatalog.values()] });
    }).catch(() => { /* Metadata failure must not roll back healthy execution status. */ }).finally(() => {
      clearTimeout(timer);
      if (projectStatusCatalogController === controller) projectStatusCatalogController = null;
    });
  }

  async function refreshProjectInteractions(force = false) {
    if (typeof window.__PI_WEB_REFRESH_PROJECT_STATUS__ === "function") return window.__PI_WEB_REFRESH_PROJECT_STATUS__();
    if ((!projectStatusLeader && !force) || projectStatusDisposed || isLoginPage() || !isPluginEnabled("project-status-indicator") || projectInteractionController || Date.now() < projectStatusNextPoll) return;
    const generation = projectInteractionGeneration, controller = new AbortController();
    projectInteractionController = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await originalWindowFetch("/api/agent/running", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (generation !== projectInteractionGeneration || projectStatusDisposed || controller.signal.aborted) return;
      const accepted = receiveProjectStatus(payload);
      refreshProjectStatusCatalogInBackground(payload.sessionListVersion);
      // 权威状态仍负责提供 pending 候选；context 扫描只用真实 toolResult.toolCallId 做补充核销，不能以空/失败响应清除状态。
      if (typeof refreshPendingAskUserSessions === "function") {
        void refreshPendingAskUserSessions(Array.from(projectStatusCatalog.values()), payload.runningSessionIds || []);
      }
      if (accepted) {
        projectStatusFailures = 0;
        projectStatusChannel?.postMessage({ type: "snapshot", payload, catalog: [...projectStatusCatalog.values()] });
      } else projectStatusFailures++;
    } catch (error) {
      if (generation === projectInteractionGeneration && !projectStatusDisposed) {
        projectStatusFailures++;
        projectStatusModel.unavailable("unavailable");
        projectStatusChannel?.postMessage({ type: "unavailable" });
        syncProjectStatusIndicators();
      }
    } finally {
      clearTimeout(timeout);
      if (projectInteractionController === controller) {
        projectInteractionController = null;
        if (generation === projectInteractionGeneration) {
          projectStatusNextPoll = projectStatusFailures ? Date.now() + Math.min(30000, 2000 * 2 ** Math.min(projectStatusFailures, 4)) : 0;
          if (projectStatusRefreshQueued) { projectStatusRefreshQueued = false; requestProjectStatusRefresh(); }
        }
      }
    }
  }

  function openProjectStatusSession(id) {
    if (typeof markSessionAsRead === "function") {
      markSessionAsRead(id, true);
    } else {
      markProjectCompletionRead(id);
    }
    syncProjectStatusIndicators();
    window.dispatchEvent(new CustomEvent("pi-enh-open-session", { detail: { sessionId: id } }));
  }

  function renderProjectStatusSummary() {
    // Statuses are shown on each session row; the separate summary bar and list
    // are intentionally removed to keep the project header uncluttered.
    document.querySelector(".pi-enh-project-status-summary")?.remove();
    document.querySelector(".pi-enh-status-popover")?.remove();
  }

  const projectStatusAskUserChecks = new Set();
  const projectStatusAttentionScanTokens = new Map();
  const projectStatusAskUserLastChecked = new Map();
  const PROJECT_STATUS_ATTENTION_SCAN_LIMIT = 5;

  function getAskUserToolCallId(value) {
    if (!value || typeof value !== "object") return null;
    const rawId = value.toolCallId ?? value.tool_call_id ?? value.id;
    return rawId === undefined || rawId === null || rawId === "" ? null : String(rawId);
  }

  function isAskUserToolCall(block) {
    return block?.type === "toolCall" && (block.name === "ask_user" || block.toolName === "ask_user");
  }

  function isAskUserToolResult(message) {
    return message?.role === "toolResult" && (message.toolName === "ask_user" || message.name === "ask_user");
  }

  function getPendingAskUserRequests(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];
    // 从后往前定位最近一轮交互：寻找最近一个非 toolResult 的消息
    let targetAssistantIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "toolResult") continue;
      if (msg?.role === "assistant") {
        targetAssistantIdx = i;
      }
      break;
    }
    if (targetAssistantIdx === -1) return [];

    const assistantMsg = messages[targetAssistantIdx];
    // 若 assistant 明确已因非工具原因终止（如用户中断或模型报错），不视为 pending
    const stopReason = assistantMsg?.stopReason;
    if (stopReason && ["end_turn", "stop", "aborted", "error", "cancelled"].includes(stopReason)) {
      return [];
    }

    const askCalls = [];
    const content = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
    for (const block of content) {
      if (isAskUserToolCall(block)) {
        const id = getAskUserToolCallId(block);
        if (id) askCalls.push({ id, method: "select" });
      }
    }
    if (askCalls.length === 0) return [];

    // 检查该 assistant 之后是否有对应的 toolResult（兼容并行其它工具结果）。
    // 只有真实 toolCallId 才能核销，缺 ID 的结果不得误清其它请求。
    const resolvedIds = new Set();
    for (let i = targetAssistantIdx + 1; i < messages.length; i++) {
      const msg = messages[i];
      if (msg?.role === "toolResult") {
        const resultId = getAskUserToolCallId(msg);
        if (resultId) resolvedIds.add(resultId);
      }
    }

    return askCalls.filter(c => !resolvedIds.has(c.id));
  }

  // 仅在历史中出现可验证的 ask_user toolResult 时返回 resolved；空/失败响应保持 unknown，调用方不得清除 attention。
  function getAskUserResolutionState(messages, trackedRequests = []) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { state: "unknown", pendingRequests: [], resolvedIds: [] };
    }

    const pendingRequests = getPendingAskUserRequests(messages);
    if (pendingRequests.length > 0) {
      return { state: "pending", pendingRequests, resolvedIds: [] };
    }

    const askCallIds = new Set();
    let latestAskCallIds = new Set();
    const resultIds = new Set();
    for (const message of messages) {
      if (message?.role === "assistant") {
        const assistantAskIds = new Set();
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (isAskUserToolCall(block)) {
            const id = getAskUserToolCallId(block);
            if (id) {
              askCallIds.add(id);
              assistantAskIds.add(id);
            }
          }
        }
        if (assistantAskIds.size > 0) latestAskCallIds = assistantAskIds;
      }
      if (isAskUserToolResult(message)) {
        const resultId = getAskUserToolCallId(message);
        if (resultId) resultIds.add(resultId);
      }
    }

    const trackedIds = new Set((Array.isArray(trackedRequests) ? trackedRequests : [])
      .map(request => getAskUserToolCallId(request))
      .filter(Boolean));
    // 存在真实待决 ID 时，历史中旧的已答复 ask_user 不能清除另一条待决请求。
    // 只有 legacy 占位 ID 才回退到最近一条 ask_user 的请求 ID。
    const explicitTrackedIds = [...trackedIds].filter(id => id !== "local-ask" && id !== "pending-ask");
    const knownIds = explicitTrackedIds.length > 0 ? new Set(explicitTrackedIds) : latestAskCallIds;
    const resolvedIds = [...resultIds].filter(id => knownIds.has(id));
    if (resolvedIds.length === 0 || explicitTrackedIds.some(id => !resultIds.has(id))) {
      return { state: "unknown", pendingRequests: [], resolvedIds: [] };
    }
    return { state: "resolved", pendingRequests: [], resolvedIds };
  }

  function hasPendingAskUser(messages) {
    return getPendingAskUserRequests(messages).length > 0;
  }

  function getProjectStatusAttentionScanToken(session) {
    return [session?.modified, session?.updatedAt, session?.lastModified, session?.messageCount].map((value) => String(value || "")).join("|");
  }

  function getPendingAskUserScanCandidates(sessions, runningSessionIds = []) {
    const catalogMap = new Map((sessions || []).filter(s => s?.id).map(s => [s.id, s]));
    const runningSet = new Set((runningSessionIds || []).filter(id => typeof id === "string" && id));
    const candidateMap = new Map();

    // 1. 仅 runningSessionIds 中的会话（running 缺 catalog 则补 { id }）
    for (const rId of runningSet) {
      const sessionObj = catalogMap.get(rId) || { id: rId };
      candidateMap.set(rId, sessionObj);
    }

    // 2. 已有 attention 的会话（仅检查本地状态与模型，绝不补历史无关会话）
    const localStateSessions = projectStatusState?.sessions || {};
    for (const [id, entry] of Object.entries(localStateSessions)) {
      if (entry?.status === "attention" && !candidateMap.has(id)) {
        candidateMap.set(id, catalogMap.get(id) || { id, status: "attention" });
      }
    }
    if (typeof projectStatusModel !== "undefined") {
      for (const entry of projectStatusModel.list()) {
        if (entry?.status === "attention" && !candidateMap.has(entry.id)) {
          candidateMap.set(entry.id, catalogMap.get(entry.id) || { id: entry.id, status: "attention" });
        }
      }
    }

    // 3. 排除 inflight（正在进行 context 请求的会话）
    const candidates = Array.from(candidateMap.values()).filter(s => !projectStatusAskUserChecks.has(s.id));

    // 4. 按 lastChecked 最旧优先排序（未检查过的为 0 最优先）
    candidates.sort((a, b) => {
      const timeA = projectStatusAskUserLastChecked.get(a.id) || 0;
      const timeB = projectStatusAskUserLastChecked.get(b.id) || 0;
      return timeA - timeB;
    });

    return candidates.slice(0, Math.max(0, PROJECT_STATUS_ATTENTION_SCAN_LIMIT - projectStatusAskUserChecks.size));
  }

  async function refreshPendingAskUserSessions(sessions, runningSessionIds = []) {
    if (projectStatusDisposed || isLoginPage() || !isPluginEnabled("project-status-indicator")) return;
    const generation = projectInteractionGeneration;
    const candidates = getPendingAskUserScanCandidates(sessions, runningSessionIds);

    await Promise.all(candidates.map(async (session) => {
      if (!session?.id || projectStatusAskUserChecks.has(session.id)) return;
      projectStatusAskUserChecks.add(session.id);
      // 无论成功与否，调度开始均更新时间戳，确保轮转按序推进
      projectStatusAskUserLastChecked.set(session.id, Date.now());
      const scanController = new AbortController();
      const scanTimeout = setTimeout(() => scanController.abort(), 6000);
      try {
        // Bypass conversation-memory caching: this is a live pending-state probe.
        const response = await originalWindowFetch(`/api/sessions/${encodeURIComponent(session.id)}/context?deferThinking=1&deferMedia=1&tail=24`, {
          cache: "no-store",
          signal: scanController.signal,
        });
        if (!response?.ok) return;
        const data = await response.json();
        if (generation !== projectInteractionGeneration || projectStatusDisposed || scanController.signal.aborted) return;
        if (!Array.isArray(data?.context?.messages)) return;

        projectStatusAttentionScanTokens.set(session.id, getProjectStatusAttentionScanToken(session));
        const messages = data.context.messages;
        const currentEntry = getEffectiveProjectStatusEntry(session.id);
        const trackedRequests = [
          ...(currentEntry?.pendingRequests || []),
          ...(projectStatusState.sessions?.[session.id]?.pendingRequests || []),
        ];
        const resolution = getAskUserResolutionState(messages, trackedRequests);
        if (resolution.state === "pending") {
          markLocalActiveSessionAttention(session.id, { pendingRequests: resolution.pendingRequests });
          syncProjectStatusIndicators();
        } else if (resolution.state === "resolved"
          && (currentEntry?.status === "attention" || projectStatusState.sessions?.[session.id]?.status === "attention")) {
          const acknowledgedRequestIds = resolution.resolvedIds;
          clearSessionAttention(session.id, null, acknowledgedRequestIds);
        }
      } catch (e) {
        // 断网不误清：网络失败或超时保留原有 attention 状态，绝不清除
      } finally {
        clearTimeout(scanTimeout);
        projectStatusAskUserChecks.delete(session.id);
        // 重试或完成均确认更新调度时间
        projectStatusAskUserLastChecked.set(session.id, Date.now());
      }
    }));
  }

  async function refreshEndedSessionStatus(sessions, runningSessionIds = []) {
    const runningSet = new Set(runningSessionIds);
    for (const session of sessions) {
      const stored = projectStatusState.sessions[session.id];
      if ((stored?.status === "running" || stored?.needsInterruptionRecheck === true) && !runningSet.has(session.id)) {
        try {
          const fetcher = (typeof window !== "undefined" && window.fetch) || baseFetch || (typeof fetch === "function" ? fetch : null);
          if (!fetcher) continue;
          const response = await fetcher(`/api/sessions/${encodeURIComponent(session.id)}?deferThinking=1&deferMedia=1&tail=1`, { cache: "no-store" });
          if (!response?.ok) continue;
          const data = await response.json();
          const msgs = data?.context?.messages;
          const lastMsg = Array.isArray(msgs) ? msgs.at(-1) : null;
          const isInterrupted = lastMsg?.stopReason === "aborted" || lastMsg?.stopReason === "error";
          stored.status = isInterrupted ? "interrupted" : "completed";
          stored.execution = isInterrupted ? "failed" : "ended";
          delete stored.needsInterruptionRecheck;
          persistProjectStatusState();
          syncProjectStatusIndicators();
        } catch (e) {}
      }
    }
  }

  async function refreshProjectStatus(version, signal) {
    const generation = projectInteractionGeneration;
    const response = await originalWindowFetch("/api/sessions", { cache: "no-store", signal });
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    const payload = await response.json();
    if (generation !== projectInteractionGeneration || projectStatusDisposed) return;
    if (!Array.isArray(payload.sessions)) throw new Error("Invalid session catalog");
    refreshProjectStatusCatalog(payload.sessions);
    projectStatusCatalogVersion = version;
    if (projectStatusModel.health().state === "unsupported") {
      void refreshPendingAskUserSessions(payload.sessions);
      void refreshEndedSessionStatus(payload.sessions, payload.runningSessionIds || []);
    }
  }

  function getProjectStatusRunningSnapshot() {
    const health = projectStatusModel.health();
    return !projectStatusDisposed && isPluginEnabled("project-status-indicator") && health.state === "live" && Date.now() - health.at < 6000 ? projectStatusLastPayload : null;
  }
  window.__PI_ENH_RUNNING_SNAPSHOT__ = getProjectStatusRunningSnapshot;
  window.__PI_ENH_OWNS_ATTENTION_NOTIFICATIONS__ = () => {
    return !projectStatusDisposed
      && isPluginEnabled("project-status-indicator")
      && isPluginEnabled("session-attention-desktop")
      && isNotificationEnabled("attention-desktop")
      && typeof window !== "undefined"
      && window.isSecureContext
      && typeof Notification !== "undefined"
      && Notification.permission === "granted";
  };
  window.__PI_ENH_GET_PENDING_ASK_USER_REQUESTS__ = getPendingAskUserRequests;
  window.__PI_ENH_HAS_PENDING_ASK_USER__ = hasPendingAskUser;
  window.__PI_ENH_GET_DESKTOP_PENDING_REQUESTS__ = getDesktopPendingRequests;
  window.__PI_ENH_REFRESH_PROJECT_INTERACTIONS__ = refreshProjectInteractions;
  window.__PI_ENH_SET_PROJECT_STATUS_MONITORING__ = setProjectStatusMonitoring;
  window.__PI_ENH_GET_SCAN_CANDIDATES__ = getPendingAskUserScanCandidates;
  window.__PI_ENH_PROJECT_STATUS_MODEL__ = projectStatusModel;
  window.__PI_ENH_IS_PROJECT_STATUS_HEALTHY__ = isProjectStatusHealthy;
  window.__PI_ENH_RECEIVE_PROJECT_STATUS__ = receiveProjectStatus;
  addManagedListener(window, "pi-web-project-status", event => {
    if (!isProjectStatusMonitoringActive || projectStatusDisposed) return;
    const detail = event.detail;
    if (detail?.payload) receiveProjectStatus(detail.payload, detail.catalog || window.__PI_ENH_GET_RAW_SESSIONS__?.());
    else { projectStatusModel.unavailable("unavailable"); syncProjectStatusIndicators(); }
  });
  addManagedListener(window, "pi-web-session-catalog", event => {
    if (!isProjectStatusMonitoringActive || !Array.isArray(event.detail?.sessions)) return;
    refreshProjectStatusCatalog(event.detail.sessions);
    syncProjectStatusIndicators();
  });
  addManagedListener(window, "pi-web-project-status-owner", () => {
    if (isProjectStatusMonitoringActive) setProjectStatusMonitoring(true);
  });
  window.__PI_ENH_RENDER_NOTIFICATION_PANEL__ = renderNotificationPanel;
  window.__PI_ENH_DEBUG_NOTIF_CONDITIONS__ = () => ({
    disposed: projectStatusDisposed,
    statusPlugin: isPluginEnabled("project-status-indicator"),
    desktopPlugin: isPluginEnabled("session-attention-desktop"),
    notifChannel: isNotificationEnabled("attention-desktop"),
    secureContext: typeof window !== "undefined" && window.isSecureContext,
    hasNotif: typeof Notification !== "undefined",
    granted: typeof Notification !== "undefined" && Notification.permission === "granted",
  });
  addManagedListener(document, "click", event => {
    const target = event.target;
    if (target?.closest?.("input, textarea, button, .pi-enh-settings-modal, .pi-enh-session-menu, [data-session-action], [data-action]")) return;
    let sessionId = null;
    const explicitHost = target?.closest?.(".pi-enh-session-row-host[data-pi-enh-session-id], [data-pi-enh-session-id]");
    if (explicitHost) {
      sessionId = explicitHost.getAttribute("data-pi-enh-session-id");
    } else {
      const link = target?.closest?.("a[href*='session='], [data-session-id]");
      if (link) {
        if (link.hasAttribute("data-session-id")) {
          sessionId = link.getAttribute("data-session-id");
        } else {
          try {
            const href = link.getAttribute("href") || "";
            const match = href.match(/[?&]session=([^&#]+)/);
            if (match) sessionId = decodeURIComponent(match[1]);
          } catch (e) {}
        }
      } else {
        const row = target?.closest?.('div[style*="54px"]');
        if (row) {
          const session = findSessionForStatusRow(row);
          if (session?.id) sessionId = session.id;
        }
      }
    }
    if (sessionId) {
      if (typeof markSessionAsRead === "function") {
        markSessionAsRead(sessionId, true);
      } else {
        markProjectCompletionRead(sessionId);
      }
      syncProjectStatusIndicators();
      // The native selector already preserves the current chat. Re-clicking
      // it marks read only; history reconciliation belongs to actual changes.

    }
  });
  addManagedListener(window, "focus", () => {
    if (isPluginEnabled("project-status-indicator")) syncProjectStatusIndicators();
    const currentId = getActiveSessionId() || getCurrentSessionId() || (typeof getSessionIdFromCurrentUrl === "function" ? getSessionIdFromCurrentUrl() : null);
    if (currentId) {
      if (typeof markSessionAsRead === "function") markSessionAsRead(currentId);
      if (typeof scheduleTerminalSyncCheck === "function") {
        scheduleTerminalSyncCheck(currentId, { reason: "focus" });
      }
    }
  });
  addManagedListener(document, "visibilitychange", () => {
    if (document.visibilityState === "visible") {
      const currentId = (typeof getSessionIdFromCurrentUrl === "function" ? getSessionIdFromCurrentUrl() : null) || getActiveSessionId() || getCurrentSessionId();
      if (currentId && typeof markSessionAsRead === "function") {
        markSessionAsRead(currentId);
      }
      if (typeof reconcileUnreadSessions === "function") {
        reconcileUnreadSessions();
      }
    }
  });
  addManagedListener(window, "storage", event => {
    if (event.key === COMPLETED_READ_KEY) {
      projectStatusModel.setCompletedRead(readCompletedTokens());
      syncProjectStatusIndicators();
    }
    if (event.key === SESSION_READ_WATERMARKS_STORAGE_KEY) {
      if (typeof reconcileUnreadSessions === "function") reconcileUnreadSessions();
      syncProjectStatusIndicators();
    }
    if (event.key === UNREAD_SESSION_STORAGE_KEY) {
      try {
        const oldArr = event.oldValue ? JSON.parse(event.oldValue) : [];
        const newArr = event.newValue ? JSON.parse(event.newValue) : [];
        const oldSet = new Set(Array.isArray(oldArr) ? oldArr : []);
        const newSet = new Set(Array.isArray(newArr) ? newArr : []);
        const diffIds = new Set();
        for (const id of oldSet) { if (!newSet.has(id)) diffIds.add(id); }
        for (const id of newSet) { if (!oldSet.has(id)) diffIds.add(id); }

        const liveUnreadIds = readUnreadSessionIds();
        if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
          for (const sId of diffIds) {
            const shouldBeUnread = liveUnreadIds.has(sId);
            const currentlyUnread = typeof window.__PI_ENH_IS_SESSION_UNREAD__ === "function"
              ? window.__PI_ENH_IS_SESSION_UNREAD__(sId)
              : null;
            if (currentlyUnread !== null && currentlyUnread !== shouldBeUnread) {
              window.__PI_ENH_SET_UNREAD_SESSION__(sId, shouldBeUnread);
            }
          }
        }
      } catch (e) {}
      projectStatusModel.setUnread([...readUnreadSessionIds()]);
      if (typeof reconcileUnreadSessions === "function") reconcileUnreadSessions();
      persistProjectStatusState();
      syncProjectStatusIndicators();
    }
  });

  // ==========================================
  // 2.7 ask_user Batch Prototype (四题交互原型)
  // ==========================================
  const ASK_USER_BATCH_PROTOTYPE_QUESTIONS = [
    {
      question: "选择本次任务的实施节奏",
      context: "四题原型：所有答案只在最终汇总页确认，不会提交给 Agent。",
      options: [
        { title: "稳妥分阶段实施", description: "先完成最小可验证改动，再逐步扩展。适合存在兼容性或线上风险的任务，回滚路径更清晰。" },
        { title: "一次性集中实施", description: "把互相关联的改动合并为一个交付批次，减少往返沟通。适合边界清晰、验收目标稳定的功能。" },
      ],
    },
    {
      question: "优先查看哪类验收证据？",
      context: "单选后自动进入下一题；可使用“上一题”回来修改。",
      options: [
        { title: "真实浏览器操作", description: "直接在 Pi Web 中点击、填写与提交，最接近实际体验；适合确认布局、动画、焦点和交互路径。" },
        { title: "自动化回归结果", description: "可重复执行，适合覆盖状态切换、边界条件和未来改动后的回归保护。" },
        { title: "两者都看", description: "先跑自动测试确认基础行为，再用真实页面验证视觉和最终交互。适合重要的用户可见功能。" },
      ],
    },
    {
      question: "选择本批次希望同时包含的能力",
      context: "这是多选题：点击只会勾选，使用“确认本题”继续。",
      multiple: true,
      options: [
        { title: "自动进入下一题", description: "单选点击后直接保存并切换，减少每题额外确认操作。" },
        { title: "上一题修改答案", description: "最终提交前可返回任何已回答的问题，原选择会完整保留。" },
        { title: "复杂选项详细备注", description: "桌面端右侧显示当前选项的背景、风险、适用条件与实施影响；窄屏自动移到选项下方。" },
      ],
    },
    {
      question: "最终提交前是否需要汇总确认页？",
      context: "最后一题完成后会展示全部答案，并允许逐项返回修改。",
      options: [
        { title: "需要汇总确认", description: "在把所有答案交给 Agent 前集中核对，最适合涉及多个偏好或复杂方案的批量问题。" },
        { title: "完成最后一题即提交", description: "交互更快，但失去最后一次整体复核机会。首版不建议采用。" },
      ],
    },
  ];
  let askUserBatchPrototypeState = null;

  function removeAskUserBatchPrototype() {
    for (const element of document.querySelectorAll(".pi-enh-ask-batch-prototype")) element.remove();
  }

  function createAskUserBatchPrototypeButton(text, className, attribute) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = text;
    if (attribute) button.setAttribute(attribute, "true");
    return button;
  }

  function getAskUserBatchPrototypeState() {
    if (!askUserBatchPrototypeState) {
      askUserBatchPrototypeState = {
        index: 0,
        answers: Array.from({ length: ASK_USER_BATCH_PROTOTYPE_QUESTIONS.length }, () => []),
        previews: Array.from({ length: ASK_USER_BATCH_PROTOTYPE_QUESTIONS.length }, () => 0),
        dismissed: false,
        summary: false,
      };
    }
    return askUserBatchPrototypeState;
  }

  function dismissAskUserBatchPrototype() {
    if (askUserBatchPrototypeState) askUserBatchPrototypeState.dismissed = true;
    removeAskUserBatchPrototype();
  }

  function formatAskUserBatchPrototypeAnswer(answer) {
    return answer.length > 0 ? answer.join("、") : "尚未回答";
  }

  function renderAskUserBatchPrototype() {
    const state = getAskUserBatchPrototypeState();
    removeAskUserBatchPrototype();
    if (state.dismissed) return;

    const root = document.createElement("section");
    root.className = "pi-enh-ask-batch-prototype";
    root.setAttribute("aria-label", "ask_user 四题批量原型");
    root.setAttribute("data-pi-enh-ask-batch-index", String(state.summary ? ASK_USER_BATCH_PROTOTYPE_QUESTIONS.length : state.index));
    const header = document.createElement("div");
    header.className = "pi-enh-ask-batch-header";
    const heading = document.createElement("div");
    const kicker = document.createElement("div");
    kicker.className = "pi-enh-ask-batch-kicker";
    kicker.textContent = state.summary ? "批量问答原型 · 汇总" : `批量问答原型 · ${state.index + 1} / ${ASK_USER_BATCH_PROTOTYPE_QUESTIONS.length}`;
    const title = document.createElement("h2");
    title.className = "pi-enh-ask-batch-title";
    title.textContent = state.summary ? "确认全部回答" : "需要你的选择";
    heading.append(kicker, title);
    const close = createAskUserBatchPrototypeButton("关闭演示", "pi-enh-ask-batch-dismiss");
    close.addEventListener("click", dismissAskUserBatchPrototype);
    header.append(heading, close);
    root.appendChild(header);

    if (state.summary) {
      const summary = document.createElement("div");
      summary.className = "pi-enh-ask-batch-summary";
      ASK_USER_BATCH_PROTOTYPE_QUESTIONS.forEach((question, index) => {
        const row = document.createElement("div");
        row.className = "pi-enh-ask-batch-summary-row";
        const text = document.createElement("div");
        text.className = "pi-enh-ask-batch-summary-text";
        const questionLabel = document.createElement("div");
        questionLabel.className = "pi-enh-ask-batch-summary-question";
        questionLabel.textContent = `${index + 1}. ${question.question}`;
        const answer = document.createElement("div");
        answer.className = "pi-enh-ask-batch-summary-answer";
        answer.textContent = formatAskUserBatchPrototypeAnswer(state.answers[index]);
        text.append(questionLabel, answer);
        const edit = createAskUserBatchPrototypeButton("修改", "pi-enh-ask-batch-button");
        edit.addEventListener("click", () => {
          state.index = index;
          state.summary = false;
          renderAskUserBatchPrototype();
        });
        row.append(text, edit);
        summary.appendChild(row);
      });
      const actions = document.createElement("div");
      actions.className = "pi-enh-ask-batch-actions";
      const previous = createAskUserBatchPrototypeButton("上一题", "pi-enh-ask-batch-button", "data-pi-enh-ask-batch-prev");
      previous.addEventListener("click", () => {
        state.index = ASK_USER_BATCH_PROTOTYPE_QUESTIONS.length - 1;
        state.summary = false;
        renderAskUserBatchPrototype();
      });
      const submit = createAskUserBatchPrototypeButton("提交全部回答（演示）", "pi-enh-ask-batch-button pi-enh-ask-batch-button-primary");
      submit.addEventListener("click", () => {
        title.textContent = "原型已完成（未提交给 Agent）";
        submit.disabled = true;
      });
      actions.append(previous, submit);
      root.append(summary, actions);
      document.body.appendChild(root);
      return;
    }

    const progress = document.createElement("div");
    progress.className = "pi-enh-ask-batch-progress";
    ASK_USER_BATCH_PROTOTYPE_QUESTIONS.forEach((_, index) => {
      const step = document.createElement("div");
      step.className = `pi-enh-ask-batch-progress-step${index < state.index ? " is-complete" : ""}${index === state.index ? " is-current" : ""}`;
      progress.appendChild(step);
    });
    root.appendChild(progress);

    const question = ASK_USER_BATCH_PROTOTYPE_QUESTIONS[state.index];
    const questionText = document.createElement("p");
    questionText.className = "pi-enh-ask-batch-question";
    questionText.textContent = question.question;
    const context = document.createElement("p");
    context.className = "pi-enh-ask-batch-context";
    context.textContent = question.context;
    root.append(questionText, context);

    const layout = document.createElement("div");
    layout.className = "pi-enh-ask-batch-layout";
    const options = document.createElement("div");
    options.className = "pi-enh-ask-batch-options";
    const selectedAnswers = state.answers[state.index];
    const previewIndex = state.previews[state.index] ?? 0;
    question.options.forEach((option, optionIndex) => {
      const selected = selectedAnswers.includes(option.title);
      const optionButton = createAskUserBatchPrototypeButton("", `pi-enh-ask-batch-option${selected ? " is-selected" : ""}`, "data-pi-enh-ask-batch-option");
      const badge = document.createElement("span");
      badge.className = "pi-enh-ask-batch-option-index";
      badge.textContent = question.multiple && selected ? "✓" : String(optionIndex + 1);
      const label = document.createElement("span");
      label.className = "pi-enh-ask-batch-option-label";
      label.textContent = option.title;
      optionButton.append(badge, label);
      optionButton.addEventListener("mouseenter", () => {
        state.previews[state.index] = optionIndex;
        renderAskUserBatchPrototype();
      });
      optionButton.addEventListener("click", () => {
        state.previews[state.index] = optionIndex;
        if (question.multiple) {
          state.answers[state.index] = selected
            ? selectedAnswers.filter((answer) => answer !== option.title)
            : [...selectedAnswers, option.title];
        } else {
          state.answers[state.index] = [option.title];
          if (state.index === ASK_USER_BATCH_PROTOTYPE_QUESTIONS.length - 1) state.summary = true;
          else state.index += 1;
        }
        renderAskUserBatchPrototype();
      });
      options.appendChild(optionButton);
    });
    const detail = document.createElement("aside");
    detail.className = "pi-enh-ask-batch-detail";
    const detailLabel = document.createElement("div");
    detailLabel.className = "pi-enh-ask-batch-detail-label";
    detailLabel.textContent = "说明 / 备注";
    const detailTitle = document.createElement("div");
    detailTitle.className = "pi-enh-ask-batch-detail-title";
    detailTitle.textContent = question.options[previewIndex]?.title || "选择一个选项";
    const detailCopy = document.createElement("div");
    detailCopy.className = "pi-enh-ask-batch-detail-copy";
    detailCopy.textContent = question.options[previewIndex]?.description || "将鼠标移到选项上查看详细说明。";
    detail.append(detailLabel, detailTitle, detailCopy);
    layout.append(options, detail);
    root.appendChild(layout);

    const actions = document.createElement("div");
    actions.className = "pi-enh-ask-batch-actions";
    const previous = createAskUserBatchPrototypeButton("上一题", "pi-enh-ask-batch-button", "data-pi-enh-ask-batch-prev");
    previous.disabled = state.index === 0;
    previous.addEventListener("click", () => {
      if (state.index === 0) return;
      state.index -= 1;
      renderAskUserBatchPrototype();
    });
    actions.appendChild(previous);
    if (question.multiple) {
      const next = createAskUserBatchPrototypeButton("确认本题", "pi-enh-ask-batch-button pi-enh-ask-batch-button-primary");
      next.disabled = selectedAnswers.length === 0;
      next.addEventListener("click", () => {
        if (selectedAnswers.length === 0) return;
        state.index += 1;
        renderAskUserBatchPrototype();
      });
      actions.appendChild(next);
    }
    root.appendChild(actions);
    document.body.appendChild(root);
  }

  function showAskUserBatchPrototype() {
    if (!isPluginEnabled("ask-user-batch-prototype")) {
      removeAskUserBatchPrototype();
      return;
    }
    askUserBatchPrototypeState = {
      index: 0,
      answers: Array.from({ length: ASK_USER_BATCH_PROTOTYPE_QUESTIONS.length }, () => []),
      previews: Array.from({ length: ASK_USER_BATCH_PROTOTYPE_QUESTIONS.length }, () => 0),
      dismissed: false,
      summary: false,
    };
    renderAskUserBatchPrototype();
  }
