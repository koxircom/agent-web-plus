  // ==========================================
  // 0.2 Session Memory Cache (会话内存秒开与长会话优化)
  // ==========================================
  function getSessionMemoryCacheLimit() {
    const isMobile = typeof isMobileEnvironment === "function" && isMobileEnvironment();
    if (isMobile) {
      const mobileVal = getPluginSetting("session-memory-cache", "maxSessionsMobile");
      if (typeof mobileVal === "number") return mobileVal;
      return 30; // 手机端提升至30个会话，闪存占用极低，充分保障常用会话常驻本地
    }
    return getPluginSetting("session-memory-cache", "maxSessions") ?? 100;
  }
  function setSessionMemoryCacheLimit(limit) {
    const isMobile = typeof isMobileEnvironment === "function" && isMobileEnvironment();
    if (isMobile) {
      return setPluginSetting("session-memory-cache", "maxSessionsMobile", limit);
    }
    return setPluginSetting("session-memory-cache", "maxSessions", limit);
  }
  // v1 可能将 tail=80 的截断结果误标为 tail=1000；隔离旧快照，避免升级后继续秒开残缺历史。
  PERSISTENT_SESSION_CACHE_NAME = "pi-enh-session-cache-v2";
  const PERSISTENT_SESSION_MANIFEST_KEY = "pi-enh-session-cache-manifest-v2";
  sessionMemoryCache = new Map();
  const inFlightSessionDetailRequests = new Map();
  const dormantSessionEventSources = new Map();
  let visiblePrewarmTimer = null;
  // Only native reloads owned by the reconciliation engine inherit this cancellation scope.
  const sessionHistoryReloadSignals = new Map();
  persistentSessionEpochs = new Map();
  let persistentCacheEpoch = 0;
  let persistentCacheTask = Promise.resolve();
  let persistentSessionManifest = loadPersistentSessionManifest();
  function scheduleTerminalSyncCheck(sessionId, options) {
    if (typeof scheduleTerminalSessionReconcile === "function") {
      return scheduleTerminalSessionReconcile(sessionId, options);
    }
    return window.__PI_ENH_SCHEDULE_TERMINAL_SYNC__?.(sessionId, options);
  }
  baseFetch = typeof window !== "undefined" && typeof window.fetch === "function" ? window.fetch : null;
  originalWindowFetch = baseFetch;

  function clearSessionMemoryCache() {
    sessionMemoryCache.clear();
  }

  function loadPersistentSessionManifest() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PERSISTENT_SESSION_MANIFEST_KEY) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function savePersistentSessionManifest() {
    try {
      localStorage.setItem(PERSISTENT_SESSION_MANIFEST_KEY, JSON.stringify(persistentSessionManifest));
    } catch (e) {}
  }

  function canUsePersistentSessionCache() {
    if (typeof window === "undefined") return false;
    const hasCacheAPI = window.caches && typeof window.caches.open === "function";
    const hasIndexedDB = !!window.indexedDB;
    return hasCacheAPI || hasIndexedDB;
  }

  // --- 统一持久化存储抽象 (支持 CacheStorage 与 IndexedDB 降级) ---
  const PersistentStorage = (function() {
    let idbPromise = null;
    const STORE_NAME = "pi-enh-session-cache-v2";

    function getIDB() {
      if (!idbPromise) {
        idbPromise = new Promise((resolve, reject) => {
          try {
            const req = window.indexedDB.open(STORE_NAME, 1);
            req.onupgradeneeded = (e) => {
              const db = e.target.result;
              if (!db.objectStoreNames.contains("cache")) {
                db.createObjectStore("cache");
              }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          } catch(e) { reject(e); }
        });
      }
      return idbPromise;
    }

    return {
      async put(key, data) {
        if (window.caches && typeof window.caches.open === "function") {
          try {
            const cache = await window.caches.open(PERSISTENT_SESSION_CACHE_NAME);
            await cache.put(key, createCachedResponse(data, {}, "PERSISTENT"));
            return;
          } catch(e) {
            if (e && (e.name === "QuotaExceededError" || String(e).includes("QuotaExceeded"))) {
              try { await PersistentStorage.clear(); } catch (_) {}
            }
          }
        }
        if (window.indexedDB) {
          try {
            const db = await getIDB();
            return new Promise((resolve) => {
              const tx = db.transaction("cache", "readwrite");
              tx.objectStore("cache").put(data, key);
              tx.oncomplete = () => resolve();
              tx.onerror = () => {
                if (tx.error && (tx.error.name === "QuotaExceededError" || String(tx.error).includes("QuotaExceeded"))) {
                  try { PersistentStorage.clear(); } catch (_) {}
                }
                resolve();
              };
            });
          } catch(e) {}
        }
      },
      async match(key) {
        if (window.caches && typeof window.caches.open === "function") {
          try {
            const cache = await window.caches.open(PERSISTENT_SESSION_CACHE_NAME);
            const resp = await cache.match(key);
            if (resp) return await resp.json();
          } catch(e) {}
        }
        if (window.indexedDB) {
          try {
            const db = await getIDB();
            return new Promise((resolve) => {
              const tx = db.transaction("cache", "readonly");
              const req = tx.objectStore("cache").get(key);
              req.onsuccess = () => resolve(req.result || null);
              req.onerror = () => resolve(null);
            });
          } catch(e) {}
        }
        return null;
      },
      async delete(key) {
        if (window.caches && typeof window.caches.open === "function") {
          try {
            const cache = await window.caches.open(PERSISTENT_SESSION_CACHE_NAME);
            await cache.delete(key);
          } catch(e) {}
        }
        if (window.indexedDB) {
          try {
            const db = await getIDB();
            return new Promise((resolve) => {
              const tx = db.transaction("cache", "readwrite");
              tx.objectStore("cache").delete(key);
              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
            });
          } catch(e) {}
        }
      },
      async clear() {
        if (window.caches && typeof window.caches.open === "function") {
          try { await window.caches.delete(PERSISTENT_SESSION_CACHE_NAME); } catch(e) {}
        }
        if (window.indexedDB) {
          try {
            const db = await getIDB();
            return new Promise((resolve) => {
              const tx = db.transaction("cache", "readwrite");
              tx.objectStore("cache").clear();
              tx.oncomplete = () => resolve();
              tx.onerror = () => resolve();
            });
          } catch(e) {}
        }
      }
    };
  })();

  function queuePersistentCacheTask(task) {
    persistentCacheTask = persistentCacheTask.then(task, task);
    return persistentCacheTask;
  }

  function getPersistentCacheKey(urlStr) {
    try {
      return new URL(urlStr, window.location.href).href;
    } catch (e) {
      return String(urlStr || "");
    }
  }

  function isPersistableSessionUrl(urlStr) {
    if (!urlStr || /[?&](?:metricsOnly=1|before=)/.test(urlStr)) return false;
    // 1. 会话主信息：/api/sessions/:id
    if (/\/api\/sessions\/[^/?#]+(?:[?#]|$)/.test(urlStr) && !/\/api\/sessions\/[^/?#]+\//.test(urlStr)) return true;
    // 2. 对话首屏消息上下文：/api/sessions/:id/context（包含 tail 参数），持久化后重新打开彻底免加载
    if (/\/api\/sessions\/[^/?#]+\/context(?:[?#]|$)/.test(urlStr)) return true;
    return false;
  }
  const isPrimarySessionDetailUrl = isPersistableSessionUrl;

  function getSessionRequestPath(urlStr) {
    try {
      return new URL(urlStr, window.location.href).pathname;
    } catch (e) {
      return String(urlStr || "").split(/[?#]/)[0];
    }
  }

  function getUrlTailParam(urlStr) {
    try {
      const tail = new URL(urlStr, typeof window !== "undefined" && window.location ? window.location.href : "http://localhost").searchParams.get("tail");
      return tail ? parseInt(tail, 10) : null;
    } catch (e) {
      const match = String(urlStr || "").match(/[?&]tail=(\d+)/);
      return match ? parseInt(match[1], 10) : null;
    }
  }

  function isSimpleCoalesceableGet(input, init) {
    if (typeof input !== "string") return false;
    if (init == null) return true;
    if (typeof init !== "object") return false;
    const proto = Object.getPrototypeOf(init);
    if (proto !== Object.prototype && proto !== null) return false;
    const keys = Object.getOwnPropertyNames(init);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (init[k] === undefined) continue;
      if (k === "method") {
        if (String(init.method || "GET").toUpperCase() !== "GET") return false;
      } else if (k !== "cache") {
        return false;
      }
    }
    return true;
  }

  function isWarmSessionSnapshotUrl(urlStr) {
    const path = getSessionRequestPath(urlStr);
    if (!/\/api\/sessions\/[^/?#]+(?:[?#]|$)/.test(urlStr) || path.endsWith("/context")) return true;
    try {
      const tail = new URL(urlStr, window.location.href).searchParams.get("tail");
      return !tail || Number(tail) > 1;
    } catch (e) {
      return !/[?&]tail=1(?:&|$)/.test(urlStr);
    }
  }

  function isSnapshotComplete(data) {
    if (!data || typeof data !== "object") return false;
    const messages = data?.context?.messages;
    if (!Array.isArray(messages)) return false;
    // 允许任何有效消息快照（包括停留在 toolResult 或工具调用的会话）进入本地缓存作为秒开基线，由增量同步负责后续更新
    return true;
  }

  function isSessionCacheStale(sessionId, entry, urlStr, candidate) {
    if (!entry) return true;

    // 1. 明确失效优先于运行态快照复用；提交新任务后或刚经历 agent_end 必须拉新，不能因已标记运行而返回旧数据。
    if (entry.needsFreshSync || entry.hasPendingAgentEnd) return true;

    // 2. 刚完成的任务（5分钟内）：无论何时何种状态，只要快照时间早于任务完成时间，或者快照不完整，或者标记了 needsFreshSync，若无有效指纹强制判定为 stale；若具备权威 snapshotRevision 与完整快照则允许本地秒开，由后台轻量 sync=1 增量比对
    if (entry.completedAt && (Date.now() - entry.completedAt) < 300 * 1000) {
      const cachedTime = Number(candidate?.timestamp) > 0
        ? Number(candidate.timestamp)
        : (Number(candidate?.data?._cachedAt) > 0 ? Number(candidate.data._cachedAt) : 0);
      const hasValidRevision = typeof candidate?.data?.snapshotRevision === "string" && candidate.data.snapshotRevision.length > 0;
      if (!hasValidRevision && (cachedTime < (entry.completedAt - 500) || entry.needsFreshSync)) {
        return true;
      }
      if (!candidate?.data || !isSnapshotComplete(candidate.data)) {
        return true;
      }
    }

    // 3. 运行中的会话：保留内存快照用于即时切换（0ms秒开），后续增量内容由 SSE (EventSource) 实时补充；
    // 但若已收到 agent_end、快照数据不存在或包含未闭合的不完整工具调用，也强制实时拉取
    if (entry.isRunning || (typeof isChatSessionRunning === "function" && isChatSessionRunning(sessionId))) {
      if (entry.hasPendingAgentEnd) return true;
      if (!candidate?.data || !isSnapshotComplete(candidate.data)) return true;
      return false;
    }

    // 4. 非运行态（已完成/空闲）：
    // 如果快照是不完整的半截工具调用（运行中途遗留的），绝不能展示给用户，必须强制实时同步！
    if (candidate?.data && !isSnapshotComplete(candidate.data)) return true;

    // 5. 检查服务端元数据中的 modified 与 messageCount
    const meta = knownSessionsMap.get(sessionId);
    if (meta) {
      if (meta.modified) {
        const serverModTime = Date.parse(meta.modified);
        const cachedTime = Number(candidate?.timestamp) > 0
          ? Number(candidate.timestamp)
          : (Number(candidate?.data?._cachedAt) > 0 ? Number(candidate.data._cachedAt) : 0);
        const hasRevision = typeof candidate?.data?.snapshotRevision === "string" && candidate.data.snapshotRevision.length > 0;
        if (serverModTime && !(hasRevision && cachedTime === 0) && serverModTime > (cachedTime + 500)) return true;
      }
      const candidateMsgs = candidate?.data?.context?.messages;
      if (typeof meta.messageCount === "number" && Array.isArray(candidateMsgs) && candidateMsgs.length > 0) {
        if (meta.messageCount > candidateMsgs.length && !/[?&]tail=\d+/.test(urlStr)) {
          return true;
        }
      }
    }
    return false;
  }

  function withSessionCacheTimestamp(data, ts = Date.now()) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    return { ...data, _cachedAt: ts };
  }

  function summarizeStringForSignature(str) {
    const s = String(str || "");
    let hash = 2166136261;
    for (let i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${s.length}:${s.slice(0, 16)}:${s.slice(-16)}:${(hash >>> 0).toString(36)}`;
  }

  function getLastMessageContentSignature(msg) {
    if (!msg || typeof msg !== "object") return "";
    if (typeof msg.content === "string") {
      return `str:${summarizeStringForSignature(msg.content)}`;
    }
    if (!Array.isArray(msg.content)) return "";
    return msg.content.map(block => {
      if (!block || typeof block !== "object") return "";
      const type = String(block.type || "");
      if (type === "text") {
        return `t:${summarizeStringForSignature(block.text)}`;
      }
      if (type === "thinking") {
        return `th:${summarizeStringForSignature(block.thinking)}`;
      }
      if (type === "toolCall") {
        const rawArgs = typeof block.arguments === "string"
          ? block.arguments
          : JSON.stringify(block.arguments || {});
        return `tc:${block.id || ""}:${block.name || ""}:${summarizeStringForSignature(rawArgs)}`;
      }
      return `${type}:${block.id || ""}`;
    }).join("|");
  }

  function hasSessionDataChanged(oldData, newData) {
    if (!oldData || !newData) return false; // 禁止把空内容当成新状态
    const oldMsgs = oldData?.context?.messages;
    const newMsgs = newData?.context?.messages;
    if (Array.isArray(oldMsgs) && Array.isArray(newMsgs) && oldMsgs.length > 0 && newMsgs.length === 0) {
      return false;
    }
    const oldRev = typeof oldData?.snapshotRevision === "string" && oldData.snapshotRevision.length > 0
      ? oldData.snapshotRevision
      : null;
    const newRev = typeof newData?.snapshotRevision === "string" && newData.snapshotRevision.length > 0
      ? newData.snapshotRevision
      : null;
    if (oldRev && newRev) {
      return oldRev !== newRev;
    }
    if (oldData?.leafId !== newData?.leafId) return true;
    const oldIds = oldData?.context?.entryIds;
    const newIds = newData?.context?.entryIds;
    if (Array.isArray(oldIds) && Array.isArray(newIds)) {
      if (oldIds.length !== newIds.length) return true;
      for (let i = oldIds.length - 1; i >= 0; i--) {
        if (oldIds[i] !== newIds[i]) return true;
      }
    }
    if (Array.isArray(oldMsgs) && Array.isArray(newMsgs)) {
      if (oldMsgs.length !== newMsgs.length) return true;
      const oldLast = oldMsgs.at(-1);
      const newLast = newMsgs.at(-1);
      if ((oldLast?.id || oldLast?.timestamp) !== (newLast?.id || newLast?.timestamp)) return true;
      if (oldLast?.role !== newLast?.role) return true;
      if (oldLast?.stopReason !== newLast?.stopReason) return true;
      const oldBlocks = oldLast?.content?.length || 0;
      const newBlocks = newLast?.content?.length || 0;
      if (oldBlocks !== newBlocks) return true;
      if (getLastMessageContentSignature(oldLast) !== getLastMessageContentSignature(newLast)) return true;
    }
    return false;
  }

  const MAX_SESSION_SYNC_ANCHORS = 16;
  const MAX_SESSION_SYNC_ANCHOR_QUERY_CHARS = 8192;
  const MAX_SESSION_SYNC_ANCHOR_MESSAGE_CHARS = 65536;

  function stableSessionSyncJson(value) {
    if (value === null || typeof value !== "object") {
      const encoded = JSON.stringify(value);
      return encoded === undefined ? "null" : encoded;
    }
    if (Array.isArray(value)) {
      return `[${value.map(item => stableSessionSyncJson(item)).join(",")}]`;
    }
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${stableSessionSyncJson(value[key])}`).join(",")}}`;
  }

  function getSessionSyncAnchorFingerprint(message) {
    if (!message || typeof message !== "object") return null;
    const source = {
      role: message.role ?? null,
      stopReason: message.stopReason ?? null,
      content: message.content ?? null,
    };
    let encoded;
    try {
      const rough = JSON.stringify(source);
      if (typeof rough !== "string" || rough.length > MAX_SESSION_SYNC_ANCHOR_MESSAGE_CHARS) return null;
      encoded = stableSessionSyncJson(source);
    } catch {
      return null;
    }
    let hashA = 2166136261;
    let hashB = 2246822519;
    for (let i = 0; i < encoded.length; i++) {
      const code = encoded.charCodeAt(i);
      hashA = Math.imul(hashA ^ code, 16777619);
      hashB = Math.imul(hashB ^ code, 0x85ebca6b);
    }
    return `${encoded.length.toString(36)}:${(hashA >>> 0).toString(16).padStart(8, "0")}${(hashB >>> 0).toString(16).padStart(8, "0")}`;
  }

  function buildSessionSyncAnchors(data) {
    const ids = data?.context?.entryIds;
    const messages = data?.context?.messages;
    if (!Array.isArray(ids) || !Array.isArray(messages) || ids.length !== messages.length) return [];
    const anchors = [];
    for (let index = ids.length - 1; index >= 0 && anchors.length < MAX_SESSION_SYNC_ANCHORS; index--) {
      const id = ids[index];
      if (typeof id !== "string" || !id || id.length > 256) continue;
      const fingerprint = getSessionSyncAnchorFingerprint(messages[index]);
      if (!fingerprint) continue;
      anchors.push({ id, index, isLatest: index === ids.length - 1, fingerprint });
    }
    return anchors;
  }

  function buildEnhancementSyncUrl(urlStr, baseRevision, anchors) {
    const raw = String(urlStr || "");
    const anchorList = Array.isArray(anchors) ? anchors.slice(0, MAX_SESSION_SYNC_ANCHORS) : [];
    const anchorJson = anchorList.length ? JSON.stringify(anchorList) : "";
    const encodedAnchors = anchorJson ? encodeURIComponent(anchorJson) : "";
    const safeAnchors = encodedAnchors.length <= MAX_SESSION_SYNC_ANCHOR_QUERY_CHARS ? encodedAnchors : "";
    if (!raw || (!baseRevision && !safeAnchors)) return raw;
    if (!/\/api\/sessions\/[^/?#]+(?:[?#]|$)/.test(raw) || /\/api\/sessions\/[^/?#]+\//.test(raw)) {
      return raw;
    }
    const hashIdx = raw.indexOf("#");
    const withoutHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
    const hash = hashIdx >= 0 ? raw.slice(hashIdx) : "";
    const qIdx = withoutHash.indexOf("?");
    const basePath = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
    const rawQuery = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : "";
    const keptPairs = rawQuery
      ? rawQuery.split("&").filter(Boolean).filter(part => {
          const eq = part.indexOf("=");
          const key = eq >= 0 ? part.slice(0, eq) : part;
          return key !== "sync" && key !== "baseRevision" && key !== "lastEntryId" && key !== "anchors";
        })
      : [];
    keptPairs.push("sync=1");
    if (typeof baseRevision === "string" && baseRevision) {
      keptPairs.push(`baseRevision=${encodeURIComponent(baseRevision)}`);
    }
    if (safeAnchors) keptPairs.push(`anchors=${safeAnchors}`);
    return `${basePath}?${keptPairs.join("&")}${hash}`;
  }

  function findValidatedSessionSyncAnchor(baseData, payload) {
    const ids = baseData?.context?.entryIds;
    const messages = baseData?.context?.messages;
    const anchor = payload?.anchor;
    if (!Array.isArray(ids) || !Array.isArray(messages) || ids.length !== messages.length || !anchor || typeof anchor !== "object") return -1;
    if (!Number.isInteger(anchor.index) || anchor.index < 0 || anchor.index >= ids.length) return -1;
    if (typeof anchor.id !== "string" || ids[anchor.index] !== anchor.id) return -1;
    if (anchor.isLatest !== (anchor.index === ids.length - 1)) return -1;
    const localFingerprint = getSessionSyncAnchorFingerprint(messages[anchor.index]);
    if (!localFingerprint || localFingerprint !== anchor.fingerprint) return -1;
    if (payload.lastEntryId !== undefined && payload.lastEntryId !== anchor.id) return -1;
    return anchor.index;
  }

  function reconcileEnhancementSyncPayload(baseData, payload) {
    if (payload && payload.protocol === 1 && typeof payload.mode === "string") {
      if (payload.mode === "unchanged") {
        const stableRevision = typeof payload.revision === "string" && payload.revision.length > 0 && payload.revision !== "anchored";
        if (stableRevision && payload.revision === baseData?.snapshotRevision) {
          return { action: "unchanged", revision: payload.revision };
        }
        const anchorIndex = findValidatedSessionSyncAnchor(baseData, payload);
        const baseIds = baseData?.context?.entryIds;
        if (anchorIndex >= 0 && anchorIndex === baseIds.length - 1) {
          const data = { ...baseData };
          if (stableRevision) data.snapshotRevision = payload.revision;
          else delete data.snapshotRevision;
          return { action: "unchanged", revision: payload.revision || "anchored", data };
        }
        return { action: "invalid_delta" };
      }
      if (payload.mode === "reset") {
        if (payload.data && typeof payload.data === "object" && payload.data.context && Array.isArray(payload.data.context.messages)) {
          const resetRevision = payload.revision === "anchored" ? null : payload.revision;
          const resetData = payload.data.snapshotRevision === undefined && payload.revision !== undefined
            ? { ...payload.data, snapshotRevision: resetRevision }
            : payload.data;
          return { action: "reset", data: resetData };
        }
        return { action: "invalid_delta" };
      }
      if (payload.mode === "delta") {
        const baseMsgs = baseData?.context?.messages;
        const baseIds = baseData?.context?.entryIds;
        const targetIds = payload.data?.context?.entryIds;
        const anchorIndex = findValidatedSessionSyncAnchor(baseData, payload);
        const stableRevision = typeof payload.revision === "string" && payload.revision.length > 0 && payload.revision !== "anchored";
        if (
          !Array.isArray(baseMsgs) ||
          !Array.isArray(baseIds) ||
          baseMsgs.length !== baseIds.length ||
          !Number.isInteger(payload.dropCount) ||
          !Number.isInteger(payload.keepCount) ||
          !Array.isArray(payload.tailMessages) ||
          !payload.data ||
          typeof payload.data !== "object" ||
          !payload.data.context ||
          !Array.isArray(targetIds)
        ) {
          return { action: "invalid_delta" };
        }
        const hasValidBaseRev = typeof baseData?.snapshotRevision === "string" && baseData.snapshotRevision && baseData.snapshotRevision !== "anchored" && payload.baseRevision === baseData.snapshotRevision;
        if (!hasValidBaseRev && anchorIndex < 0) return { action: "invalid_delta" };
        if (!stableRevision && anchorIndex < 0) return { action: "invalid_delta" };
        if (baseData.sessionId && payload.data.sessionId && baseData.sessionId !== payload.data.sessionId) {
          return { action: "invalid_delta" };
        }
        const dropCount = payload.dropCount;
        const keepCount = payload.keepCount;
        if (dropCount < 0 || keepCount < 0 || dropCount + keepCount > baseMsgs.length) {
          return { action: "invalid_delta" };
        }
        if (anchorIndex >= 0 && anchorIndex !== dropCount + keepCount - 1) return { action: "invalid_delta" };
        if (targetIds.some(id => typeof id !== "string" || !id) || new Set(targetIds).size !== targetIds.length) {
          return { action: "invalid_delta" };
        }
        const retainedIds = baseIds.slice(dropCount, dropCount + keepCount);
        if (retainedIds.some((id, idx) => id !== targetIds[idx])) {
          return { action: "invalid_delta" };
        }
        const kept = baseMsgs.slice(dropCount, dropCount + keepCount);
        const mergedMessages = kept.concat(payload.tailMessages);
        if (mergedMessages.length !== targetIds.length) {
          return { action: "invalid_delta" };
        }
        const mergedData = {
          ...payload.data,
          snapshotRevision: stableRevision ? payload.revision : null,
          context: {
            ...payload.data.context,
            messages: mergedMessages,
            entryIds: targetIds,
          },
        };
        return { action: "delta", data: mergedData };
      }
      return { action: "invalid_delta" };
    }
    return { action: "legacy", data: payload };
  }

  function findCompatibleSessionDetail(entry, urlStr) {
    const exact = entry?.detailRequests?.get(urlStr);
    if (exact) return exact;
    if (!entry || !isPersistableSessionUrl(urlStr) || /[?&](?:metricsOnly=1|before=)/.test(urlStr)) return null;
    const requestedPath = getSessionRequestPath(urlStr);
    const requestedTail = getUrlTailParam(urlStr);
    for (const [key, value] of entry.detailRequests.entries()) {
      if (getSessionRequestPath(key) !== requestedPath) continue;
      if (/[?&](?:metricsOnly=1|before=)/.test(key)) continue;
      if (!isWarmSessionSnapshotUrl(key)) continue;
      // 关键防伪装守卫：请求大 tail（如 1000）绝不能复用小 tail（如 80）的截断缓存
      const cachedTail = getUrlTailParam(key);
      if (requestedTail && (!cachedTail || cachedTail < requestedTail)) continue;
      return value;
    }
    return null;
  }

  async function enforcePersistentSessionLRU() {
    while (Object.keys(persistentSessionManifest).length > getSessionMemoryCacheLimit()) {
      const oldest = Object.entries(persistentSessionManifest).sort((a, b) => (a[1]?.lastAccessed || 0) - (b[1]?.lastAccessed || 0))[0];
      if (!oldest) break;
      const [sessionId, metadata] = oldest;
      for (const key of metadata?.keys || []) {
        try { await PersistentStorage.delete(key); } catch (e) {}
      }
      delete persistentSessionManifest[sessionId];
    }
    savePersistentSessionManifest();
  }

  function hasTransientBlobImage(data) {
    if (!data || typeof data !== "object") return false;
    const target = data.data && typeof data.data === "object" ? data.data : data;
    const messages = target?.context?.messages;
    if (!Array.isArray(messages)) return false;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || !Array.isArray(msg.content)) continue;
      for (let j = 0; j < msg.content.length; j++) {
        const part = msg.content[j];
        if (!part || typeof part !== "object" || part.type !== "image") continue;
        const sourceUrl = part.source && typeof part.source === "object" ? part.source.url : null;
        if (typeof sourceUrl === "string" && sourceUrl.startsWith("blob:")) return true;
        // 未 defer 的超大 Base64 图片（> 100KB），不进入离线持久化存储，由内存 Map 承载
        if (typeof part.data === "string" && part.data.length > 100000) return true;
        if (part.source && typeof part.source.data === "string" && part.source.data.length > 100000) return true;
      }
    }
    return false;
  }

  function persistSessionDetail(sessionId, urlStr, data) {
    if (!canUsePersistentSessionCache() || !isPersistableSessionUrl(urlStr) || !isWarmSessionSnapshotUrl(urlStr) || hasTransientBlobImage(data)) return Promise.resolve();
    const stampedData = withSessionCacheTimestamp(data, Number(data?._cachedAt) > 0 ? Number(data._cachedAt) : Date.now());
    const cacheKey = getPersistentCacheKey(urlStr);
    const sessionEpoch = persistentSessionEpochs.get(sessionId) || 0;
    const cacheEpoch = persistentCacheEpoch;
    return queuePersistentCacheTask(async () => {
      if (!isPluginEnabled("session-memory-cache") || persistentCacheEpoch !== cacheEpoch || (persistentSessionEpochs.get(sessionId) || 0) !== sessionEpoch) return;
      try {
        await PersistentStorage.put(cacheKey, stampedData);
        if (persistentCacheEpoch !== cacheEpoch || (persistentSessionEpochs.get(sessionId) || 0) !== sessionEpoch) {
          await PersistentStorage.delete(cacheKey);
          return;
        }
        const previous = persistentSessionManifest[sessionId];
        persistentSessionManifest[sessionId] = {
          lastAccessed: Date.now(),
          keys: Array.from(new Set([...(previous?.keys || []), cacheKey])),
        };
        await enforcePersistentSessionLRU();
      } catch (e) {}
    });
  }

  async function readPersistentSessionDetail(sessionId, urlStr) {
    if (!canUsePersistentSessionCache() || !isPersistableSessionUrl(urlStr) || !isWarmSessionSnapshotUrl(urlStr)) return null;
    const cacheKey = getPersistentCacheKey(urlStr);
    const metadata = persistentSessionManifest[sessionId];
    if (!metadata) return null;
    try {
      let data = await PersistentStorage.match(cacheKey);
      // 原生 Next.js 会在不同场景附加 defer/tail 参数；只要仍是同一会话的首屏详情或 context，
      // 就复用已有快照。翻页和 metricsOnly 请求必须保持精确匹配，避免把不完整数据当成权威结果。
      if (!data && !/[?&](?:metricsOnly=1|before=)/.test(urlStr)) {
        const requestedPath = getSessionRequestPath(urlStr);
        const requestedTail = getUrlTailParam(urlStr);
        for (const key of metadata.keys || []) {
          if (getSessionRequestPath(key) !== requestedPath) continue;
          if (/[?&](?:metricsOnly=1|before=)/.test(key)) continue;
          if (!isWarmSessionSnapshotUrl(key)) continue;
          const cachedTail = getUrlTailParam(key);
          if (requestedTail && (!cachedTail || cachedTail < requestedTail)) continue;
          data = await PersistentStorage.match(key);
          if (data) break;
        }
      }
      if (!data) return null;
      if (hasTransientBlobImage(data)) {
        void invalidatePersistentSession(sessionId);
        return null;
      }
      metadata.lastAccessed = Date.now();
      savePersistentSessionManifest();
      return data;
    } catch (e) {
      return null;
    }
  }

  function invalidatePersistentSession(sessionId) {
    if (!sessionId) return Promise.resolve();
    persistentSessionEpochs.set(sessionId, (persistentSessionEpochs.get(sessionId) || 0) + 1);
    const metadata = persistentSessionManifest[sessionId];
    delete persistentSessionManifest[sessionId];
    savePersistentSessionManifest();
    if (!canUsePersistentSessionCache() || !metadata) return Promise.resolve();
    return queuePersistentCacheTask(async () => {
      try {
        for (const key of metadata.keys || []) {
          await PersistentStorage.delete(key);
        }
      } catch (e) {}
    });
  }

  function clearSessionCaches() {
    try { window.__PI_WEB_SESSION_PRELOAD__?.clear?.(); } catch (e) {}
    window.dispatchEvent(new CustomEvent("pi:session-cache-change"));
    clearSessionMemoryCache();
    persistentCacheEpoch += 1;
    persistentSessionEpochs.clear();
    persistentSessionManifest = {};
    try { localStorage.removeItem(PERSISTENT_SESSION_MANIFEST_KEY); } catch (e) {}
    if (!canUsePersistentSessionCache()) return Promise.resolve();
    return queuePersistentCacheTask(async () => {
      try {
        await PersistentStorage.clear();
      } catch (e) {}
    });
  }

  const activeRevalidationHandles = new Set();

  function scheduleSessionRevalidation(task, options = {}) {
    if (isDisposed) return null;
    const immediate = Boolean(options && options.immediate);
    const handle = { id: null, type: null };
    const runTask = async () => {
      activeRevalidationHandles.delete(handle);
      if (isDisposed) return;
      try {
        await task();
      } catch (e) {}
    };

    if (!immediate && typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      handle.type = "idle";
      handle.id = window.requestIdleCallback(runTask, { timeout: 1500 });
    } else {
      handle.type = "timeout";
      handle.id = setTimeout(runTask, immediate ? 0 : 120);
    }
    activeRevalidationHandles.add(handle);
    return handle;
  }

  function resolveNativeCachePriority(sessionId) {
    if (!sessionId) return "normal";
    const activeSid = getActiveSessionId() || getCurrentSessionId();
    if (sessionId === activeSid) return "active";
    if (isSessionAttentionPending(sessionId)) return "attention";
    if (isSessionActuallyRunning(sessionId)) return "running";
    if (isSessionRecentlyCompleted(sessionId) || (typeof isSessionUnread === "function" && isSessionUnread(sessionId))) {
      return "completed-unread";
    }
    return "normal";
  }

  function bridgeToNativeViewCache(sessionId, _data) {
    if (!sessionId) return;
    try {
      const preloadBridge = typeof window !== "undefined" ? window.__PI_WEB_SESSION_PRELOAD__ : null;
      if (preloadBridge && typeof preloadBridge.setSessionPriority === "function") {
        preloadBridge.setSessionPriority(sessionId, resolveNativeCachePriority(sessionId));
      }
    } catch (_) {}
  }

  function commitSessionDetailSnapshot(sessionId, entry, urlStr, stampedData, now = Date.now()) {
    if (!entry || !stampedData) return;
    entry.detailRequests.set(urlStr, { data: stampedData, timestamp: now });
    const reqPath = getSessionRequestPath(urlStr);
    const encodedId = encodeURIComponent(sessionId);
    const primaryPath = `/api/sessions/${encodedId}`;
    const tailVal = getUrlTailParam(urlStr);
    if ((reqPath === primaryPath || reqPath === `/api/sessions/${sessionId}`) && !/[?&](?:metricsOnly=1|before=)/.test(urlStr) && (!tailVal || tailVal >= 80)) {
      entry.detailRequests.set(`${primaryPath}?deferThinking=1&deferMedia=1&tree=summary&tail=80`, { data: stampedData, timestamp: now });
      entry.detailRequests.set(`${primaryPath}?deferThinking=1&deferMedia=1&tail=80`, { data: stampedData, timestamp: now });
      entry.detailRequests.set(primaryPath, { data: stampedData, timestamp: now });
      for (const existingKey of Array.from(entry.detailRequests.keys())) {
        if (getSessionRequestPath(existingKey) === reqPath && !/[?&](?:metricsOnly=1|before=)/.test(existingKey) && isWarmSessionSnapshotUrl(existingKey)) {
          entry.detailRequests.set(existingKey, { data: stampedData, timestamp: now });
        }
      }
    }
    bridgeToNativeViewCache(sessionId, stampedData);
  }

  function markSessionNeedsIncrementalSync(sessionId) {
    if (!sessionId) return;
    const entry = sessionMemoryCache.get(sessionId);
    if (entry) {
      entry.needsFreshSync = true;
      entry._lastRevalidatedAt = 0;
      entry._skipNextRevalidationUntil = 0;
    }
  }

  function getActiveSessionId() {
    try {
      return new URLSearchParams(window.location.search).get("session");
    } catch (e) {
      return null;
    }
  }

  function getSessionCacheStats() {
    let totalDetails = 0;
    let totalImmutable = 0;
    const detailKeys = [];
    for (const entry of sessionMemoryCache.values()) {
      totalDetails += entry.detailRequests.size;
      totalImmutable += entry.immutableAssets.size;
      detailKeys.push(...Array.from(entry.detailRequests.keys()));
    }
    return {
      enabled: isPluginEnabled("session-memory-cache"),
      count: sessionMemoryCache.size,
      detailCount: totalDetails,
      immutableCount: totalImmutable,
      sessionIds: Array.from(sessionMemoryCache.keys()),
      detailKeys,
      persistentCount: Object.keys(persistentSessionManifest).length,
      persistentSessionIds: Object.keys(persistentSessionManifest),
    };
  }

  function getOrCreateSessionEntry(sessionId) {
    let entry = sessionMemoryCache.get(sessionId);
    if (!entry) {
      entry = {
        sessionId,
        detailRequests: new Map(), // urlKey -> { data, timestamp }
        state: null,               // { data, timestamp }
        immutableAssets: new Map(),// urlKey -> { data, timestamp }
        lastAccessed: Date.now(),
        isRunning: false,
        needsFreshSync: false,
        hasPendingAttention: false,
        completedAt: null,
        isSettled: false,
        settledAt: null,
        runGeneration: 0,
        settledGeneration: 0,
      };
      sessionMemoryCache.set(sessionId, entry);
    } else {
      entry.lastAccessed = Date.now();
    }
    enforceSessionCacheLRU();
    return entry;
  }

  function isSessionProtectedFromEviction(sessionId, entry) {
    if (!sessionId || !entry) return false;
    const currentId = getActiveSessionId();
    if (sessionId === currentId) return true; // 当前查看会话
    if (entry.isRunning) return true;          // 运行中会话

    // 待审核 / 待回复 / 待处理会话（存在 ask_user 或后台 attention 事件）
    if (entry.hasPendingAttention || isSessionAttentionPending(sessionId)) return true;

    // 刚结束的会话（结束未超过 30 分钟，保持内存常驻）
    if (entry.completedAt && (Date.now() - entry.completedAt) < 30 * 60 * 1000) return true;

    // 待回复状态（entry.state 显示未结束或等待输入）
    if (entry.state?.data?.state?.isStreaming || entry.state?.data?.state?.isPromptRunning) return true;

    return false;
  }

  function isSessionAttentionPending(sessionId) {
    if (!sessionId) return false;
    try {
      if (typeof projectStatusState !== "undefined" && projectStatusState?.sessions?.[sessionId]?.status === "attention") {
        return true;
      }
    } catch (e) {}
    return false;
  }

  function enforceSessionCacheLRU() {
    const limit = getSessionMemoryCacheLimit();
    const hardCap = Math.max(limit * 2, 120);
    while (sessionMemoryCache.size > limit) {
      let oldestId = null;
      let oldestTime = Infinity;
      for (const [id, entry] of sessionMemoryCache.entries()) {
        if (isSessionProtectedFromEviction(id, entry)) continue;
        if (entry.lastAccessed < oldestTime) {
          oldestTime = entry.lastAccessed;
          oldestId = id;
        }
      }
      if (!oldestId) {
        if (sessionMemoryCache.size <= hardCap) break;
        const activeSid = getActiveSessionId() || getCurrentSessionId();
        for (const [id, entry] of sessionMemoryCache.entries()) {
          if (id === activeSid) continue;
          if (entry.lastAccessed < oldestTime) {
            oldestTime = entry.lastAccessed;
            oldestId = id;
          }
        }
        if (!oldestId) break;
      }
      sessionMemoryCache.delete(oldestId);
    }
  }

  async function preloadCompletedSession(sessionId, immediate = false) {
    if (!sessionId || !isPluginEnabled("session-memory-cache")) return;
    const bridge = typeof window !== "undefined" ? window.__PI_WEB_SESSION_PRELOAD__ : null;
    if (!bridge || typeof bridge.scheduleCandidates !== "function") return;
    bridge.scheduleCandidates([{
      sessionId,
      hasAttention: isSessionAttentionPending(sessionId),
      isRunning: isSessionActuallyRunning(sessionId),
      isCompleted: isSessionRecentlyCompleted(sessionId),
      isUnread: typeof isSessionUnread === "function" && isSessionUnread(sessionId),
      refresh: !immediate,
    }], { activeSessionId: getActiveSessionId() || getCurrentSessionId() });
  }

  /**
   * 用户指定 4 大类高优会话智能预加载调度引擎：
   * 1. ask_user (P0: 1000分) - 等待用户选择/审批的会话，优先预热展示历史
   * 2. 正在运行的 (P1: 800分) - 正在流式输出或执行命令的会话，保持快照暖态
   * 3. 已经完成的 (P2: 600分) - 刚结束执行的会话，用户大概率立即查验结果
   * 4. 还没有阅读的 (P3: 400分) - 带未读标记/小红点的会话，预先在后台将消息加载进内存
   */
  let priorityPreloadTimer = null;

  function isSessionActuallyRunning(sessionId) {
    if (!sessionId) return false;
    if (typeof isChatSessionRunning === "function" && isChatSessionRunning(sessionId)) return true;
    const entry = sessionMemoryCache?.get(sessionId);
    if (entry?.isRunning) return true;
    if (typeof projectStatusState !== "undefined" && projectStatusState?.sessions?.[sessionId]?.status === "running") return true;
    return false;
  }

  function isSessionRecentlyCompleted(sessionId) {
    if (!sessionId) return false;
    const entry = sessionMemoryCache?.get(sessionId);
    if (entry?.completedAt && Date.now() - entry.completedAt < 30 * 60 * 1000) return true;
    if (typeof projectStatusState !== "undefined" && projectStatusState?.sessions?.[sessionId]?.status === "completed") return true;
    return false;
  }

  function getSessionPreloadPriority(sessionId) {
    if (!sessionId) return 0;
    const activeSid = getActiveSessionId() || getCurrentSessionId();
    if (sessionId === activeSid) return 0; // 当前查看会话已被前台维护，无需后台预热

    // 1. ask_user / attention 挂起
    if (isSessionAttentionPending(sessionId)) return 1000;

    // 2. 正在运行中
    if (isSessionActuallyRunning(sessionId)) return 800;

    // 3. 刚刚完成的任务（30分钟内）
    if (isSessionRecentlyCompleted(sessionId)) return 600;

    // 4. 尚未阅读的会话
    if (typeof isSessionUnread === "function" && isSessionUnread(sessionId)) return 400;

    return 0;
  }

  function schedulePrioritySessionPreloads() {
    if (isDisposed || !isPluginEnabled("session-memory-cache")) return;
    if (priorityPreloadTimer) clearTimeout(priorityPreloadTimer);
    priorityPreloadTimer = setTimeout(() => {
      priorityPreloadTimer = null;
      collectAndPumpPriorityPreloadQueue();
    }, 250);
  }

  function collectAndPumpPriorityPreloadQueue() {
    if (isDisposed || !isPluginEnabled("session-memory-cache")) return;
    const activeSid = getActiveSessionId() || getCurrentSessionId();

    const modelSessionIds = (typeof projectStatusModel !== "undefined" && typeof projectStatusModel?.list === "function")
      ? projectStatusModel.list().map(item => item?.id).filter(Boolean)
      : [];
    const catalogSessionIds = (typeof projectStatusCatalog !== "undefined" && projectStatusCatalog instanceof Map)
      ? Array.from(projectStatusCatalog.keys())
      : [];

    const allCandidateIds = new Set([
      ...knownSessionsMap.keys(),
      ...catalogSessionIds,
      ...modelSessionIds,
      ...(typeof projectStatusState !== "undefined" && projectStatusState?.sessions ? Object.keys(projectStatusState.sessions) : []),
      ...Array.from(document.querySelectorAll("[data-pi-enh-session-id]")).map(el => el.getAttribute("data-pi-enh-session-id")),
    ]);

    const preloadBridge = typeof window !== "undefined" ? window.__PI_WEB_SESSION_PRELOAD__ : null;
    const bridgeCandidates = [];

    for (const sid of allCandidateIds) {
      if (!sid) continue;
      const entry = sessionMemoryCache.get(sid);
      bridgeCandidates.push({
        sessionId: sid,
        isActive: sid === activeSid,
        hasAttention: isSessionAttentionPending(sid),
        isRunning: isSessionActuallyRunning(sid),
        isCompleted: isSessionRecentlyCompleted(sid),
        isUnread: typeof isSessionUnread === "function" && isSessionUnread(sid),
        refresh: Boolean(entry?.needsFreshSync && Date.now() - (entry._nativeRefreshScheduledAt || 0) > 1000),
      });
    }

    if (preloadBridge && typeof preloadBridge.scheduleCandidates === "function" && bridgeCandidates.length > 0) {
      try {
        preloadBridge.scheduleCandidates(bridgeCandidates, { activeSessionId: activeSid });
        for (const item of bridgeCandidates) {
          if (item.refresh) {
            const entry = sessionMemoryCache.get(item.sessionId);
            if (entry) entry._nativeRefreshScheduledAt = Date.now();
          }
        }
      } catch (_) {}
      return; // Native coordinator alone owns scheduling; never run a duplicate legacy queue.
    }

    // Native hydration registers the sole preload coordinator. Its absence is
    // not permission to warm a separate cache that the chat cannot consume.
  }


  function isSessionTerminallySettled(sessionId) {
    if (!sessionId) return false;
    const entry = sessionMemoryCache.get(sessionId);
    if (!entry || !entry.isSettled) return false;

    // 终态证据在没有真实新轮 agent_start 或实际发送解除之前持续有效；
    // 终态检查本身不能因陈旧 DOM 残留的 stop 按钮而删除证据。
    return true;
  }

  function markSessionSettled(sessionId, options = {}) {
    if (!sessionId) return;
    const entry = getOrCreateSessionEntry(sessionId);
    entry.isSettled = true;
    entry.settledAt = Date.now();
    entry.runGeneration = (entry.runGeneration || 0) + 1;
    entry.settledGeneration = entry.runGeneration;
    entry.isRunning = false;
    entry.completedAt = Date.now();
    entry.hasPendingAgentEnd = false;
    entry.hasPendingAttention = false;
  }

  function markSessionRunning(sessionId, running, options = {}) {
    if (!sessionId) return;
    const entry = getOrCreateSessionEntry(sessionId);
    const wasRunning = entry.isRunning;
    const nextRunning = Boolean(running);

    if (nextRunning) {
      // 若当前会话处于终态保护中，且调用未携带明确的新轮次信号（非 explicit/start），
      // 则判定为陈旧状态轮询/滞后的 runningSessionIds，拒绝复活 running。
      if (!options.explicit && !options.start) {
        if (isSessionTerminallySettled(sessionId)) {
          return;
        }
      }
      entry.isSettled = false;
      entry.settledAt = null;
      if (options.explicit || options.start) {
        entry.runGeneration = (entry.runGeneration || 0) + 1;
        entry.state = null;
      }
      entry.isRunning = true;
      entry.completedAt = null;
      // 状态轮询可能在 agent_end 后仍报告 running；只有真正开始新一轮才清掉上一轮的校准证据。
      if (!wasRunning && !entry.hasPendingAgentEnd) {
        if (typeof clearTerminalReconcileTimers === "function") clearTerminalReconcileTimers(sessionId);
      }
      // 运行中的会话也必须有可恢复的最近快照。只在尚未预热时后台补齐，
      // 不清空旧快照，也不让状态轮询反复触发前台重载。
      const hasWarmSnapshot = Array.from(entry.detailRequests.keys()).some((key) => {
        const path = getSessionRequestPath(key);
        return path === getSessionRequestPath(`/api/sessions/${encodeURIComponent(sessionId)}`) && isWarmSessionSnapshotUrl(key);
      });
      if (!options.skipPreload && !hasWarmSnapshot && getActiveSessionId() === sessionId) {
        entry.needsFreshSync = true;
        void preloadCompletedSession(sessionId);
      } else if (!entry.hasPendingAgentEnd) {
        // 状态轮询晚于 agent_end 到达时仍可能报告 running，不能覆盖本轮待落盘标记。
        entry.needsFreshSync = false;
      }
    } else {
      entry.isRunning = false;
      if (options.settled) {
        entry.isSettled = true;
        entry.settledAt = Date.now();
        entry.runGeneration = (entry.runGeneration || 0) + 1;
        entry.settledGeneration = entry.runGeneration;

        // 终态事件可能晚于最近一次 /api/agent 缓存读取；空闲快路径会复用 entry.state。
        // 只归零任务状态并保留模型/上下文元数据，顶层 running 仍表示 RPC 包装器存活。
        const cachedData = entry.state?.data;
        if (cachedData && typeof cachedData === "object" && !Array.isArray(cachedData)) {
          const taskFlags = ["isStreaming", "isPromptRunning", "isBashRunning", "isCompacting"];
          const settledData = { ...cachedData };
          for (const key of taskFlags) {
            if (typeof settledData[key] === "boolean") settledData[key] = false;
          }
          settledData.state = {
            ...(cachedData.state && typeof cachedData.state === "object" && !Array.isArray(cachedData.state)
              ? cachedData.state
              : {}),
            isStreaming: false,
            isPromptRunning: false,
            isBashRunning: false,
            isCompacting: false,
          };
          entry.state = {
            ...entry.state,
            data: settledData,
            timestamp: Date.now(),
            isRunning: false,
          };
        }
      }
      if (wasRunning) {
        entry.completedAt = Date.now();
        // 完成瞬间仍需让原生最终同步拿到最新消息，但保留旧快照作为断网/重启兜底。
        entry.needsFreshSync = true;
      }
    }
  }

  function invalidateSessionCache(sessionId) {
    if (!sessionId) return Promise.resolve();
    try { window.__PI_WEB_SESSION_PRELOAD__?.invalidate?.(sessionId); } catch (e) {}
    const entry = sessionMemoryCache.get(sessionId);
    if (entry) {
      entry.state = null;
      entry.needsFreshSync = true;
      entry._lastRevalidatedAt = 0;
      entry._skipNextRevalidationUntil = 0;
      entry.lastAccessed = Date.now();
    }
    // 失效只阻止旧的排队写入复活，不删除当前快照；运行中切换和浏览器重启仍需可恢复内容。
    persistentSessionEpochs.set(sessionId, (persistentSessionEpochs.get(sessionId) || 0) + 1);
    return Promise.resolve();
  }

  function createCachedResponse(data, originalHeaders = {}, cacheSource = "HIT") {
    const jsonStr = JSON.stringify(data);
    const headers = typeof Headers !== "undefined" ? new Headers(originalHeaders || {}) : {
      get(k) { return this[k.toLowerCase()] || null; },
      set(k, v) { this[k.toLowerCase()] = v; },
    };
    if (headers.set) {
      headers.set("Content-Type", "application/json; charset=utf-8");
      headers.set("X-Pi-Enh-Cache", cacheSource);
    } else {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["x-pi-enh-cache"] = "HIT";
    }

    if (typeof Response !== "undefined") {
      return new Response(jsonStr, {
        status: 200,
        statusText: "OK",
        headers,
      });
    }

    return {
      ok: true,
      status: 200,
      headers: {
        get(key) {
          const k = String(key).toLowerCase();
          if (k === "content-type") return "application/json; charset=utf-8";
          if (k === "x-pi-enh-cache") return cacheSource;
          return null;
        },
      },
      clone() {
        return {
          json: async () => JSON.parse(jsonStr),
          text: async () => jsonStr,
        };
      },
      json: async () => JSON.parse(jsonStr),
      text: async () => jsonStr,
    };
  }

  function extractSessionIdFromUrl(urlStr) {
    if (!urlStr) return null;
    const match = urlStr.match(/\/api\/(?:sessions|agent)\/([^/?#]+)/);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    if (["search", "export", "running", "new", "bash-output", "lease"].includes(id)) return null;
    return id;
  }

  function scheduleSessionUploadCleanup(urlStr, response) {
    if (!response || !(response.ok || response.status === 200 || response.status === 204)) return;
    const deletedId = extractSessionIdFromUrl(urlStr);
    if (!deletedId) return;
    Promise.resolve().then(() => cleanupSessionUploadedFiles(deletedId)).catch(() => {});
  }

  let historySyncWarningTimer = null;

  function clearHistorySyncWarning() {
    if (historySyncWarningTimer) {
      if (typeof window !== "undefined" && typeof window.clearTimeout === "function") {
        window.clearTimeout(historySyncWarningTimer);
      } else {
        try { clearTimeout(historySyncWarningTimer); } catch (e) {}
      }
      historySyncWarningTimer = null;
    }
    document.querySelector('[data-pi-enh-history-sync-warning]')?.remove();
  }

  function showHistorySyncWarning(sessionId) {
    if (!isPluginEnabled('session-history-integrity') || getActiveSessionId() !== sessionId) return;
    clearHistorySyncWarning();
    const warning = document.createElement('div');
    warning.setAttribute('data-pi-enh-history-sync-warning', sessionId);
    warning.setAttribute('role', 'alert');
    warning.textContent = '会话记录同步失败：当前显示可能不完整。请重新切入此会话重试，不要重复发送任务。';
    warning.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:10000;pointer-events:auto;max-width:92vw;padding:10px 34px 10px 14px;border:1px solid rgba(217,119,6,0.85);border-radius:10px;background:rgba(24,24,27,0.96);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);box-shadow:0 8px 24px rgba(0,0,0,0.4);color:var(--text,#fafafa);font-size:13px;line-height:1.4;box-sizing:border-box;';

    const closeBtn = document.createElement('button');
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('aria-label', '关闭提示');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:rgba(250,250,250,0.6);font-size:14px;cursor:pointer;padding:4px 6px;line-height:1;border-radius:4px;';
    closeBtn.onclick = (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
      clearHistorySyncWarning();
    };
    warning.appendChild(closeBtn);

    document.body.appendChild(warning);

    // 移动端防霸屏：真实浏览器环境下 6 秒后自动渐隐清除
    if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
      historySyncWarningTimer = window.setTimeout(() => {
        clearHistorySyncWarning();
      }, 6000);
    }
  }

  function isPrimaryHistoryRequest(url) {
    if (!url) return false;
    const urlStr = typeof url === 'string' ? url : url?.url || '';
    if (/[?&]metricsOnly=/.test(urlStr)) return false;
    // 原生 sync=1 或 tree=summary 的前台会话同步请求始终认定为主会话请求
    if (/[?&]sync=1(?:&|$)/.test(urlStr) || /[?&]tree=summary(?:&|$)/.test(urlStr)) return true;
    // 排除小 tail 且不带 before 翻页的辅助探测请求（如模型角标 tail=1、状态扫描 tail=24、ask_user 扫描 tail=40 等）
    const tailMatch = urlStr.match(/[?&]tail=(\d+)/);
    if (tailMatch) {
      const tailVal = parseInt(tailMatch[1], 10);
      if (tailVal < 50 && !urlStr.includes('before=')) return false;
    }
    return true;
  }

  function isRequestAborted(error, init, input) {
    if (error?.name === 'AbortError' || error?.name === 'CanceledError') return true;
    if (init?.signal?.aborted || input?.signal?.aborted) return true;
    const msg = String(error?.message || '').toLowerCase();
    if (msg.includes('aborted') || msg.includes('canceled') || msg.includes('cancelled')) return true;
    return false;
  }

  // 仅认可逐文件扫描水位；全局 generatedAt 不是会话已入账证明。
  function isSessionIngested(sessionId, sessionMeta = knownSessionsMap.get(sessionId)) {
    if (!sessionId) return false;
    const ledger = window.__PI_ENH_USAGE_LEDGER__;
    try { window.PiUsageLedger.validate(ledger); } catch (_) { return false; }
    const seal = ledger.sessions?.[sessionId]?.ingestion;
    return seal?.source === "nas" && seal.complete === true &&
      Object.prototype.hasOwnProperty.call(seal, "lastEntryId") &&
      !!sessionMeta && Object.prototype.hasOwnProperty.call(sessionMeta, "leafId") &&
      seal.lastEntryId === sessionMeta.leafId && Number.isSafeInteger(seal.size) &&
      seal.size >= 0 && !seal.pendingToolCalls && !seal.pendingSubagentCalls;
  }

  // 客户端失败关闭保护，不是服务端删除事务：绕过浏览器或检查后并发写入仍需后端原子协议。
  async function ensureSessionIngestedBeforeDelete(sessionId) {
    if (!sessionId) throw new Error("缺少会话 ID，已阻止删除");
    // 关键环境隔离：30142 同事端容器不属于 30141 全局用量账本扫描域，跳过封存门禁直接放行真实删除
    if (typeof window !== "undefined" && window.location && window.location.port === "30142") {
      return true;
    }
    const activeFetch = baseFetch || originalWindowFetch;
    if (!activeFetch) throw new Error("无法核验用量入账，已阻止删除");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40000);
    const request = async (url, init = {}) => {
      const response = await activeFetch(url, { ...init, cache: "no-store", signal: controller.signal });
      if (!response?.ok) throw new Error(`入账核验 HTTP ${response?.status || "失败"}`);
      return response.json();
    };
    const freshMeta = async () => {
      const listing = await request(`/api/sessions?usageGuard=${Date.now()}`);
      if (!Array.isArray(listing.sessions) || !Array.isArray(listing.runningSessionIds)) {
        throw new Error("无法确认会话或运行状态，已阻止删除");
      }
      if (listing.runningSessionIds.includes(sessionId)) {
        throw new Error("会话仍在运行，待用量回传后再删除");
      }
      const meta = listing.sessions.find(s => s.id === sessionId);
      if (!meta) throw new Error("无法取得最新会话版本，已阻止删除");
      const detail = await request(`/api/sessions/${encodeURIComponent(sessionId)}?tail=1&usageGuard=${Date.now()}`);
      if (detail.sessionId !== sessionId || !(typeof detail.leafId === "string" || detail.leafId === null)) {
        throw new Error("无法取得原生会话末条记录，已阻止删除");
      }
      return {
        ...meta,
        leafId: detail.leafId,
        usageDeleteGuard: typeof detail.usageDeleteGuard === "number" ? detail.usageDeleteGuard : 0,
      };
    };
    try {
      let meta = await freshMeta();
      if (meta.usageDeleteGuard >= 1) {
        knownSessionsMap.set(sessionId, meta);
        return true;
      }
      if (!isSessionIngested(sessionId, meta)) {
        const result = await request("/api/usage/ledger", { method: "POST" });
        if (result.version !== 2 || !Array.isArray(result.buckets)) {
          throw new Error("服务端入账失败，已阻止删除");
        }
        await window.__PI_ENH_LOAD_OPTIONAL__("usage-panel");
        if (!window.PiUsagePanel?.fetchSnapshotOnce) throw new Error("用量模块不可用，已阻止删除");
        await window.PiUsagePanel.fetchSnapshotOnce(controller.signal);
        meta = await freshMeta();
        if (!isSessionIngested(sessionId, meta)) {
          throw new Error("会话仍有未入账用量、未结束工具或版本变化，已阻止删除");
        }
      }
      knownSessionsMap.set(sessionId, meta);
      return true;
    } catch (error) {
      throw new Error(`未完成用量封存，删除已取消：${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ==========================================
  // 会话消息防回退守卫 (session-history-order-guard)
  // 解决慢速历史请求覆盖已到达的最新流式消息，以及并发请求乱序覆盖问题
  // ==========================================
  const SESSION_HISTORY_ORDER_STATES = new Map();
  const MAX_HISTORY_ORDER_SESSIONS = 50;
  let orderGuardEpoch = 0;

  function clearSessionHistoryOrderState(sessionId) {
    orderGuardEpoch++;
    if (sessionId) {
      SESSION_HISTORY_ORDER_STATES.delete(sessionId);
    } else {
      SESSION_HISTORY_ORDER_STATES.clear();
    }
  }
  activeCleanups.push(() => clearSessionHistoryOrderState());

  function getOrCreateHistoryOrderState(sessionId) {
    if (!sessionId) return null;
    let state = SESSION_HISTORY_ORDER_STATES.get(sessionId);
    if (!state) {
      if (SESSION_HISTORY_ORDER_STATES.size >= MAX_HISTORY_ORDER_SESSIONS) {
        const oldestKey = SESSION_HISTORY_ORDER_STATES.keys().next().value;
        if (oldestKey) SESSION_HISTORY_ORDER_STATES.delete(oldestKey);
      }
      state = {
        sessionId,
        revision: 0,
        requestSeq: 0,
        latestWatermark: null,
        latestAccepted: null,
      };
      SESSION_HISTORY_ORDER_STATES.set(sessionId, state);
    }
    return state;
  }

  function parseOrderGuardTimestamp(rawTs) {
    if (rawTs === undefined || rawTs === null || rawTs === "") return null;
    if (typeof rawTs === "number") {
      return Number.isFinite(rawTs) && rawTs > 0 ? rawTs : null;
    }
    if (typeof rawTs === "string") {
      const n = Number(rawTs);
      if (Number.isFinite(n) && n > 0) return n;
      const p = Date.parse(rawTs);
      if (Number.isFinite(p) && p > 0) return p;
      return null;
    }
    return null;
  }

  function handleSessionHistoryOrderStreamEvent(sessionId, data) {
    if (!sessionId || !data) return;
    if (!isPluginEnabled("session-history-order-guard")) return;
    const type = data.type;
    if (type !== "agent_start" && type !== "message_end" && type !== "compaction_end" && type !== "auto_compaction_end") {
      return;
    }
    const state = getOrCreateHistoryOrderState(sessionId);
    if (!state) return;

    if (type === "agent_start") {
      state.revision++;
    } else if (type === "message_end") {
      state.revision++;
      const msg = data.message;
      if (msg && typeof msg === "object") {
        if (msg.role === "system") return; // 忽略 system 消息，服务端历史记录接口会过滤 system 消息
        const id = msg.id || msg.entryId || data.entryId || data.id || null;
        const rawTs = msg.timestamp ?? msg.createdAt ?? data.timestamp;
        const ts = parseOrderGuardTimestamp(rawTs);
        if (id || (ts !== null && ts > 0)) {
          state.latestWatermark = {
            id,
            timestamp: ts && ts > 0 ? ts : null,
            role: msg.role || null,
            toolCallId: msg.toolCallId || msg.tool_call_id || null,
          };
        }
      }
    } else if (type === "compaction_end" || type === "auto_compaction_end") {
      // compaction_end / auto_compaction_end: 压缩或切树必须清除旧 watermark 防止把合法压缩当回退
      state.revision++;
      state.latestWatermark = null;
      state.latestAccepted = null;
    }
  }

  function handleSessionHistoryOrderAction(sessionId, actionType) {
    if (!sessionId || !actionType) return;
    if (!isPluginEnabled("session-history-order-guard")) return;
    if (actionType === "navigate_tree" || actionType === "fork") {
      const state = SESSION_HISTORY_ORDER_STATES.get(sessionId);
      if (state) {
        state.revision++;
        state.latestWatermark = null;
        state.latestAccepted = null;
      }
    }
  }

  function shouldProtectSessionHistoryOrder(url, sessionId) {
    if (!url || !sessionId) return false;
    const activeSessionId = typeof getActiveSessionId === "function" ? getActiveSessionId() : (typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null);
    if (sessionId !== activeSessionId) return false;
    const urlStr = typeof url === "string" ? url : url?.url || "";
    if (/[?&]metricsOnly(?:=1|&|$)/.test(urlStr)) return false;
    if (/[?&]before=/.test(urlStr)) return false;
    if (/[?&]leafId=/.test(urlStr)) return false;
    const tailMatch = urlStr.match(/[?&]tail=(\d+)/);
    if (tailMatch) {
      const tailVal = parseInt(tailMatch[1], 10);
      if (tailVal <= 50) return false;
    }
    return true;
  }

  function isMessagesUpToDateWithWatermark(messages, watermark, entryIds) {
    if (!watermark) return true;
    if (watermark.id && Array.isArray(entryIds) && entryIds.includes(watermark.id)) {
      return true;
    }
    if (!Array.isArray(messages) || messages.length === 0) return false;

    const wTs = parseOrderGuardTimestamp(watermark.timestamp) || 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || typeof m !== "object") continue;
      if (watermark.id && (m.id === watermark.id || m.entryId === watermark.id)) {
        return true;
      }
      const mTs = parseOrderGuardTimestamp(m.timestamp ?? m.createdAt) || 0;
      const isTsMatched = wTs > 0 && (
        mTs === wTs ||
        (!watermark.id && mTs > 0 && Math.abs(mTs - wTs) <= 120000)
      );
      if (isTsMatched) {
        if (!watermark.role || m.role === watermark.role) {
          if (!watermark.toolCallId || m.toolCallId === watermark.toolCallId || m.tool_call_id === watermark.toolCallId) {
            return true;
          }
        }
      }
    }

    const lastMsg = messages[messages.length - 1];
    const lastTs = parseOrderGuardTimestamp(lastMsg?.timestamp ?? lastMsg?.createdAt) || 0;
    if (wTs > 0 && lastTs > wTs) {
      return true;
    }

    return false;
  }

  function extractOrderGuardMessagesAndEntryIds(json, sessionId) {
    if (json && json.protocol === 1) {
      const wireBaselines =
        (typeof globalThis !== "undefined" && globalThis.__piSessionWireBaselines instanceof Map
          ? globalThis.__piSessionWireBaselines
          : null) ||
        (typeof window !== "undefined" && window.__piSessionWireBaselines instanceof Map
          ? window.__piSessionWireBaselines
          : null);
      const baseline = sessionId && wireBaselines ? wireBaselines.get(sessionId) : null;

      if (json.mode === "reset") {
        const messages = Array.isArray(json?.data?.context?.messages)
          ? json.data.context.messages
          : (Array.isArray(json?.data?.messages) ? json.data.messages : []);
        const entryIds = Array.isArray(json?.data?.context?.entryIds)
          ? json.data.context.entryIds
          : (Array.isArray(json?.data?.entryIds) ? json.data.entryIds : []);
        return { messages, entryIds, isUnchangedEnvelope: false };
      }

      if (json.mode === "delta") {
        const baseMsgs = Array.isArray(baseline?.messages)
          ? baseline.messages
          : (Array.isArray(baseline?.data?.context?.messages) ? baseline.data.context.messages : []);
        const tailMessages = Array.isArray(json?.tailMessages) ? json.tailMessages : [];
        const messages = (Number.isInteger(json.dropCount) && Number.isInteger(json.keepCount))
          ? baseMsgs.slice(json.dropCount, json.dropCount + json.keepCount).concat(tailMessages)
          : tailMessages;
        const entryIds = Array.isArray(json?.data?.context?.entryIds)
          ? json.data.context.entryIds
          : (Array.isArray(json?.data?.entryIds) ? json.data.entryIds : []);
        return { messages, entryIds, isUnchangedEnvelope: false };
      }

      if (json.mode === "unchanged") {
        let messages = Array.isArray(baseline?.messages)
          ? baseline.messages
          : (Array.isArray(baseline?.data?.context?.messages) ? baseline.data.context.messages : []);
        let entryIds = Array.isArray(baseline?.entryIds)
          ? baseline.entryIds
          : (Array.isArray(baseline?.data?.context?.entryIds) ? baseline.data.context.entryIds : []);

        if (messages.length === 0 && entryIds.length === 0 && sessionId) {
          const memCache = typeof sessionMemoryCache !== "undefined" && sessionMemoryCache instanceof Map
            ? sessionMemoryCache.get(sessionId)
            : null;
          if (memCache && memCache.detailRequests instanceof Map) {
            for (const slot of memCache.detailRequests.values()) {
              const ctx = slot?.data?.context;
              if (Array.isArray(ctx?.messages) && ctx.messages.length > 0) {
                messages = ctx.messages;
                entryIds = Array.isArray(ctx.entryIds) ? ctx.entryIds : [];
                break;
              }
            }
          }
        }
        if (messages.length === 0 && entryIds.length === 0 && sessionId) {
          const accepted = SESSION_HISTORY_ORDER_STATES.get(sessionId)?.latestAccepted;
          if (accepted) {
            if (Array.isArray(accepted.messages) && accepted.messages.length > 0) messages = accepted.messages;
            if (Array.isArray(accepted.entryIds) && accepted.entryIds.length > 0) entryIds = accepted.entryIds;
          }
        }
        return { messages, entryIds, isUnchangedEnvelope: true };
      }
    }

    const messages = Array.isArray(json?.context?.messages)
      ? json.context.messages
      : (Array.isArray(json?.messages) ? json.messages : []);
    const entryIds = Array.isArray(json?.context?.entryIds)
      ? json.context.entryIds
      : (Array.isArray(json?.entryIds) ? json.entryIds : []);
    return { messages, entryIds, isUnchangedEnvelope: false };
  }

  function extractNormalizedHistoryKey(url) {
    try {
      const s = String(url || "");
      const UrlClass = typeof URL !== "undefined" ? URL : (typeof window !== "undefined" ? window.URL : null);
      if (UrlClass) {
        let base = "http://localhost";
        if (typeof window !== "undefined" && window.location?.origin) {
          base = window.location.origin;
        }
        const parsed = new UrlClass(s, base);
        if (parsed.searchParams && typeof parsed.searchParams.sort === "function") {
          parsed.searchParams.sort();
        }
        const sortedSearch = parsed.searchParams ? parsed.searchParams.toString() : "";
        const key = sortedSearch ? `${parsed.pathname}?${sortedSearch}` : parsed.pathname;
        const tailVal = parsed.searchParams ? parsed.searchParams.get("tail") : null;
        const tail = tailVal ? parseInt(tailVal, 10) : 1000;
        return { key, pathname: parsed.pathname, tail, search: sortedSearch };
      }
    } catch (_) {}

    try {
      const s = String(url || "");
      const qIdx = s.indexOf("?");
      const pathname = qIdx >= 0 ? s.slice(0, qIdx) : s;
      const tailMatch = s.match(/[?&]tail=(\d+)/);
      const tail = tailMatch ? parseInt(tailMatch[1], 10) : 1000;
      return { key: s, pathname, tail, search: "" };
    } catch (_) {
      return { key: "", pathname: "", tail: 1000, search: "" };
    }
  }

  function checkOrderGuardAborted(init, input) {
    if (init?.signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
    if (input?.signal?.aborted) {
      throw new DOMException("The user aborted a request.", "AbortError");
    }
  }

  function isOrderGuardStateValid(sessionId, state, reqEpoch) {
    if (!isPluginEnabled("session-history-order-guard")) return false;
    if (reqEpoch !== orderGuardEpoch) return false;
    if (SESSION_HISTORY_ORDER_STATES.get(sessionId) !== state) return false;
    return true;
  }

  function safeCreateOrderGuardResponse(bodyText, status, statusText, rawHeaders) {
    const headers = new Headers();
    if (rawHeaders) {
      try {
        const entries = typeof rawHeaders.entries === "function" ? rawHeaders.entries() : Object.entries(rawHeaders);
        for (const [k, v] of entries) {
          const lk = String(k).toLowerCase();
          if (lk !== "content-encoding" && lk !== "content-length" && lk !== "transfer-encoding") {
            headers.set(k, v);
          }
        }
      } catch (_) {}
    }
    if (!headers.get("Content-Type")) {
      headers.set("Content-Type", "application/json; charset=utf-8");
    }
    return new Response(bodyText, {
      status: status || 200,
      statusText: statusText || "OK",
      headers,
    });
  }

  async function wrapSessionHistoryOrderGuard(input, init, url, sessionId, fetchInitial) {
    checkOrderGuardAborted(init, input);

    if (!isPluginEnabled("session-history-order-guard")) {
      return await fetchInitial();
    }

    const state = getOrCreateHistoryOrderState(sessionId);
    if (!state) {
      return await fetchInitial();
    }

    const reqEpoch = orderGuardEpoch;
    const reqSeq = ++state.requestSeq;
    const startRevision = state.revision;
    const { key: reqKey, pathname: reqPathname, tail: reqTail } = extractNormalizedHistoryKey(url);

    // 1. 先按原路径取得 response
    const response = await fetchInitial();
    checkOrderGuardAborted(init, input);

    if (!isOrderGuardStateValid(sessionId, state, reqEpoch)) {
      return response;
    }
    if (!response || !response.ok) {
      return response;
    }

    let bodyText;
    let json;
    try {
      bodyText = await response.clone().text();
      checkOrderGuardAborted(init, input);
      if (!isOrderGuardStateValid(sessionId, state, reqEpoch)) {
        return response;
      }
      json = JSON.parse(bodyText);
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      return response;
    }

    const {
      messages,
      entryIds,
      isUnchangedEnvelope,
    } = extractOrderGuardMessagesAndEntryIds(json, sessionId);

    // 2. 检查并发请求乱序覆盖（反序两个 GET）：
    const accepted = state.latestAccepted;
    if (
      accepted &&
      reqEpoch === accepted.epoch &&
      reqSeq < accepted.seq &&
      accepted.key === reqKey
    ) {
      // 只要同完整 key 且是旧 seq，绝不能用旧响应覆盖新响应
      // 必须再次确认 accepted 快照是否满足【当前】SSE watermark：
      const isAcceptedFresh = isMessagesUpToDateWithWatermark(
        accepted.messages,
        state.latestWatermark,
        accepted.entryIds
      );
      if (isAcceptedFresh) {
        return new Response(accepted.bodyText, {
          status: accepted.status,
          statusText: accepted.statusText,
          headers: new Headers(accepted.headers),
        });
      }
      // 不满足则严禁 return 已过期 accepted，后续必须 fresh 读！
    }

    // 3. 检查当前响应是否落后于 SSE watermark、或请求期间有新 revision、或反序且 accepted 已过期
    const hasNewRevision = state.revision > startRevision;
    const isInitialUpToDate = (isUnchangedEnvelope && messages.length === 0 && entryIds.length === 0 && !hasNewRevision)
      ? true
      : isMessagesUpToDateWithWatermark(messages, state.latestWatermark, entryIds);
    const isBehindWatermark = Boolean(
      state.latestWatermark && !isInitialUpToDate
    );
    const isOutdatedByRevision = Boolean(
      hasNewRevision && state.latestWatermark && !isInitialUpToDate
    );
    const isBehindAcceptedStale = Boolean(
      accepted && reqEpoch === accepted.epoch && reqSeq < accepted.seq && accepted.key === reqKey
    );

    const needsFreshRead = isBehindWatermark || isOutdatedByRevision || isBehindAcceptedStale;

    if (!needsFreshRead) {
      const prevSeq = state.latestAccepted?.seq || 0;
      state.latestAccepted = {
        seq: Math.max(prevSeq, reqSeq),
        epoch: reqEpoch,
        key: reqKey,
        pathname: reqPathname,
        tail: reqTail,
        bodyText,
        messages,
        entryIds,
        messagesCount: messages.length,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers?.entries ? response.headers.entries() : []),
      };
      return response;
    }

    // 4. 明确落后时，使用 baseFetch/originalWindowFetch no-store 重新读，最多 3 次
    const activeFetch = baseFetch || originalWindowFetch || (typeof window !== "undefined" ? window.fetch : null);
    if (!activeFetch) {
      const err = new Error("[session-history-order-guard] 会话历史记录落后于流式消息版本，且无可用的重读客户端");
      err.isOrderGuardError = true;
      err.fallbackResponse = bodyText
        ? safeCreateOrderGuardResponse(bodyText, response.status, response.statusText, response.headers)
        : null;
      throw err;
    }

    let freshResponse = null;
    let freshJson = null;
    let freshBodyText = null;
    let freshMessages = [];
    let freshEntryIds = [];
    let freshSuccess = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      checkOrderGuardAborted(init, input);
      if (!isOrderGuardStateValid(sessionId, state, reqEpoch)) {
        return freshResponse || response;
      }
      attempts++;

      let reqInput = input;
      if (attempts >= 2 && typeof input === "string" && input.includes("sync=1") && input.includes("baseRevision=")) {
        reqInput = input.replace(/[?&]baseRevision=[^&#]+/g, "").replace(/\?&/, "?");
        if (!reqInput.includes("force=1")) reqInput += "&force=1";
      }

      try {
        freshResponse = await activeFetch(reqInput, {
          ...init,
          cache: "no-store",
        });
      } catch (err) {
        if (isRequestAborted(err, init, input)) throw err;
        break;
      }

      checkOrderGuardAborted(init, input);
      if (!isOrderGuardStateValid(sessionId, state, reqEpoch)) {
        return freshResponse || response;
      }

      if (freshResponse && freshResponse.ok) {
        try {
          freshBodyText = await freshResponse.clone().text();
          checkOrderGuardAborted(init, input);
          if (!isOrderGuardStateValid(sessionId, state, reqEpoch)) {
            return freshResponse;
          }
          freshJson = JSON.parse(freshBodyText);
          const extractedFresh = extractOrderGuardMessagesAndEntryIds(freshJson, sessionId);
          freshMessages = extractedFresh.messages;
          freshEntryIds = extractedFresh.entryIds;
          const isFreshUpToDate = (extractedFresh.isUnchangedEnvelope && freshMessages.length === 0 && freshEntryIds.length === 0 && state.revision === startRevision)
            ? true
            : isMessagesUpToDateWithWatermark(freshMessages, state.latestWatermark, freshEntryIds);
          if (isFreshUpToDate) {
            freshSuccess = true;
            break;
          }
        } catch (_) {}
      }
    }

    checkOrderGuardAborted(init, input);
    if (!isOrderGuardStateValid(sessionId, state, reqEpoch)) {
      return freshResponse || response;
    }

    if (!freshSuccess || !freshResponse || !freshResponse.ok || !freshBodyText) {
      const err = new Error("[session-history-order-guard] 会话历史记录落后于流式消息版本，已阻止过期快照覆盖界面");
      err.isOrderGuardError = true;
      err.fallbackResponse = (freshResponse && freshResponse.ok && freshBodyText)
        ? safeCreateOrderGuardResponse(freshBodyText, freshResponse.status, freshResponse.statusText, freshResponse.headers)
        : (bodyText
          ? safeCreateOrderGuardResponse(bodyText, response.status, response.statusText, response.headers)
          : null);
      throw err;
    }

    const prevSeq = state.latestAccepted?.seq || 0;
    state.latestAccepted = {
      seq: Math.max(prevSeq, reqSeq),
      epoch: reqEpoch,
      key: reqKey,
      pathname: reqPathname,
      tail: reqTail,
      bodyText: freshBodyText,
      messages: freshMessages,
      entryIds: freshEntryIds,
      messagesCount: freshMessages.length,
      status: freshResponse.status,
      statusText: freshResponse.statusText,
      headers: Array.from(freshResponse.headers?.entries ? freshResponse.headers.entries() : []),
    };
    return freshResponse;
  }

  // React replaces its history with this fetch result. A stale-while-revalidate
  // cache cannot be authoritative without a React subscription/commit bridge.
  // Keep this guard independent of SSE invalidation and the legacy cache toggle.
  let lastKnownSessionListPayload = {
    sessionListVersion: 0,
    runningSessionIds: [],
    completionNotificationSuppressedSessionIds: [],
  };

  function isTransientFetchError(err, init, input) {
    if (!err || isRequestAborted(err, init, input)) return false;
    if (err instanceof TypeError) return true;
    const msg = String(err?.message || err || "");
    return /failed to fetch|load failed|networkerror|network request failed|fetch failed/i.test(msg);
  }

  function normalizeFallbackSessionData(rawData, sessionId) {
    if (!rawData || typeof rawData !== "object") return null;
    const base = rawData.protocol === 1 && rawData.data && typeof rawData.data === "object"
      ? rawData.data
      : rawData;
    const rawMessages = Array.isArray(base?.context?.messages)
      ? base.context.messages
      : (Array.isArray(base?.messages) ? base.messages : null);
    if (!Array.isArray(rawMessages)) return null;
    const rawEntryIds = Array.isArray(base?.context?.entryIds)
      ? base.context.entryIds
      : (Array.isArray(base?.entryIds) ? base.entryIds : []);
    const alignedEntryIds = rawEntryIds.length === rawMessages.length && rawEntryIds.every(id => typeof id === "string" && id.length > 0)
      ? rawEntryIds
      : rawMessages.map((m, idx) => {
          const cand = rawEntryIds[idx] || m?.id || m?.entryId;
          return typeof cand === "string" && cand.length > 0 ? cand : `fallback-entry-${idx}`;
        });
    return {
      ...base,
      sessionId: base.sessionId || sessionId,
      leafId: base.leafId ?? (alignedEntryIds.at(-1) || null),
      context: {
        ...(base.context || {}),
        messages: rawMessages,
        entryIds: alignedEntryIds,
        oldestEntryId: base.context?.oldestEntryId ?? (alignedEntryIds[0] || null),
        hasMore: Boolean(base.context?.hasMore),
      },
    };
  }

  async function buildFallbackSessionHistoryResponse(sessionId, requestUrl) {
    if (!sessionId) return null;
    const urlStr = String(requestUrl || "");
    const isSyncReq = /[?&]sync=1(?:&|$)/.test(urlStr);
    let reqBaseRev = null;
    try {
      reqBaseRev = new URL(urlStr, typeof window !== "undefined" && window.location ? window.location.href : "http://localhost").searchParams.get("baseRevision");
    } catch (_) {
      const m = urlStr.match(/[?&]baseRevision=([^&#]+)/);
      if (m) reqBaseRev = decodeURIComponent(m[1]);
    }

    const wireBaselines =
      (typeof globalThis !== "undefined" && globalThis.__piSessionWireBaselines instanceof Map
        ? globalThis.__piSessionWireBaselines
        : null) ||
      (typeof window !== "undefined" && window.__piSessionWireBaselines instanceof Map
        ? window.__piSessionWireBaselines
        : null);
    const baseline = wireBaselines ? wireBaselines.get(sessionId) : null;

    // 1. 检查 SESSION_HISTORY_ORDER_STATES.get(sessionId)?.latestAccepted
    const accepted = SESSION_HISTORY_ORDER_STATES.get(sessionId)?.latestAccepted;
    if (accepted && accepted.bodyText) {
      let canUseAcceptedRaw = true;
      try {
        const parsedAcc = JSON.parse(accepted.bodyText);
        if (parsedAcc && parsedAcc.protocol === 1) {
          if (parsedAcc.mode === "unchanged" || parsedAcc.mode === "delta") {
            const targetRev = parsedAcc.mode === "unchanged" ? parsedAcc.revision : parsedAcc.baseRevision;
            if (!baseline || !baseline.revision || baseline.revision !== targetRev) {
              canUseAcceptedRaw = false;
            }
          }
        }
      } catch (_) {}
      if (canUseAcceptedRaw) {
        return new Response(accepted.bodyText, {
          status: accepted.status || 200,
          statusText: accepted.statusText || "OK",
          headers: new Headers(accepted.headers || { "Content-Type": "application/json" }),
        });
      }
    }

    // 2. 检查 globalThis.__piSessionWireBaselines?.get?.(sessionId)
    if (baseline) {
      if (isSyncReq) {
        if (reqBaseRev && baseline.revision && reqBaseRev === baseline.revision) {
          return createCachedResponse(
            { protocol: 1, mode: "unchanged", revision: baseline.revision },
            {},
            "FALLBACK_WIRE_UNCHANGED"
          );
        }
        if (baseline.data) {
          const normData = normalizeFallbackSessionData(baseline.data, sessionId) || baseline.data;
          return createCachedResponse(
            {
              protocol: 1,
              mode: "reset",
              revision: baseline.revision || normData.snapshotRevision || null,
              data: normData,
            },
            {},
            "FALLBACK_WIRE_RESET"
          );
        }
      } else if (baseline.data) {
        const normData = normalizeFallbackSessionData(baseline.data, sessionId) || baseline.data;
        return createCachedResponse(normData, {}, "FALLBACK_WIRE_DATA");
      }
    }

    // 3. 检查 globalThis.__piSessionViewCache?.get?.(sessionId)
    const viewCache =
      (typeof globalThis !== "undefined" && globalThis.__piSessionViewCache instanceof Map
        ? globalThis.__piSessionViewCache
        : null) ||
      (typeof window !== "undefined" && window.__piSessionViewCache instanceof Map
        ? window.__piSessionViewCache
        : null);
    const viewEntry = viewCache ? viewCache.get(sessionId) : null;
    if (viewEntry && Array.isArray(viewEntry.messages)) {
      const sessionData = normalizeFallbackSessionData(
        {
          sessionId,
          snapshotRevision: viewEntry.revision || null,
          leafId: viewEntry.leafId ?? null,
          tree: viewEntry.summaryTree,
          treeFormat: "summary",
          stats: viewEntry.stats,
          totalActiveMs: viewEntry.totalActiveMs,
          context: {
            messages: viewEntry.messages,
            entryIds: Array.isArray(viewEntry.entryIds)
              ? viewEntry.entryIds
              : (Array.isArray(viewEntry.loadedEntryIds) ? viewEntry.loadedEntryIds : []),
            oldestEntryId: viewEntry.oldestEntryId ?? null,
            hasMore: Boolean(viewEntry.hasMore),
            thinkingLevel: viewEntry.thinkingLevel || "off",
            model: viewEntry.model ?? null,
          },
        },
        sessionId
      );
      if (sessionData) {
        if (isSyncReq) {
          return createCachedResponse(
            {
              protocol: 1,
              mode: "reset",
              revision: viewEntry.revision || null,
              data: sessionData,
            },
            {},
            "FALLBACK_VIEW_CACHE"
          );
        }
        return createCachedResponse(sessionData, {}, "FALLBACK_VIEW_CACHE");
      }
    }

    // 4. 检查 sessionMemoryCache.get(sessionId) 的 findCompatibleSessionDetail（或 readPersistentSessionDetail）
    const memEntry = typeof sessionMemoryCache !== "undefined" ? sessionMemoryCache.get(sessionId) : null;
    let cachedData = memEntry ? findCompatibleSessionDetail(memEntry, urlStr)?.data : null;
    if (!cachedData && memEntry && memEntry.detailRequests instanceof Map) {
      for (const slot of memEntry.detailRequests.values()) {
        if (slot?.data && isSnapshotComplete(slot.data)) {
          cachedData = slot.data;
          break;
        }
      }
    }
    if (!cachedData && typeof readPersistentSessionDetail === "function") {
      try {
        cachedData = await readPersistentSessionDetail(sessionId, urlStr);
      } catch (_) {}
    }
    if (cachedData) {
      const normData = normalizeFallbackSessionData(cachedData, sessionId) || cachedData;
      if (isSyncReq) {
        return createCachedResponse(
          {
            protocol: 1,
            mode: "reset",
            revision: normData.snapshotRevision || null,
            data: normData,
          },
          {},
          "FALLBACK_CACHE"
        );
      }
      return createCachedResponse(normData, {}, "FALLBACK_CACHE");
    }

    return null;
  }

  async function fetchAuthoritativeHistory(input, init, url) {
    const sessionId = extractSessionIdFromUrl(url);
    const isPrimary = isPrimaryHistoryRequest(url);
    const activeFetch = baseFetch || originalWindowFetch;
    const warning = typeof document !== "undefined" ? document.querySelector('[data-pi-enh-history-sync-warning]') : null;
    if (warning && warning.getAttribute('data-pi-enh-history-sync-warning') !== getActiveSessionId()) clearHistorySyncWarning();
    const runFetch = async () => isPluginEnabled('session-memory-cache')
      ? await cachedSessionFetch.call(this, input, init)
      : await activeFetch(input, { ...init, cache: 'no-store' });
    try {
      let response;
      try {
        response = await runFetch();
      } catch (firstErr) {
        if (isTransientFetchError(firstErr, init, input) && activeFetch) {
          await new Promise((r) => setTimeout(r, 220));
          response = await activeFetch(input, { ...init, cache: 'no-store' });
        } else {
          throw firstErr;
        }
      }
      if (isPrimary && sessionId === getActiveSessionId()) {
        if (response.ok) clearHistorySyncWarning();
        else showHistorySyncWarning(sessionId);
      }
      return response;
    } catch (error) {
      if (isPrimary && sessionId && isTransientFetchError(error, init, input)) {
        const fallbackResp = await buildFallbackSessionHistoryResponse(sessionId, url);
        if (fallbackResp) {
          if (typeof scheduleTerminalSyncCheck === "function") {
            scheduleTerminalSyncCheck(sessionId, { reason: "network_fallback", force: true });
          }
          return fallbackResp;
        }
      }
      if (isPrimary && !isRequestAborted(error, init, input) && sessionId === getActiveSessionId()) {
        showHistorySyncWarning(sessionId);
      }
      throw error;
    }
  }
  activeCleanups.push(clearHistorySyncWarning);

  // ==========================================
  // 高性能会话搜索 LRU 缓存与智能加速引擎 (Search Cache & Acceleration Engine)
  // ==========================================
  const SESSION_SEARCH_CACHE = new Map();
  const SEARCH_CACHE_MAX_SIZE = 120;
  const SEARCH_CACHE_TTL = 300000; // 5 分钟有效

  function getSearchCacheKey(query, tagId) {
    return `${(query || "").trim().toLowerCase()}::${tagId || "all"}`;
  }

  function getNativeSearchCatalog() {
    try {
      const snapshot = window.__PI_ENH_GET_SEARCH_CATALOG__?.();
      return snapshot && Array.isArray(snapshot.sessions) && typeof snapshot.scope === "string" ? snapshot : null;
    } catch (_) { return null; }
  }

  function getFromSearchCache(key, catalogScope) {
    const entry = SESSION_SEARCH_CACHE.get(key);
    if (!entry) return null;
    if (entry.catalogScope !== catalogScope || Date.now() - entry.timestamp > SEARCH_CACHE_TTL) {
      SESSION_SEARCH_CACHE.delete(key);
      return null;
    }
    return entry.data;
  }

  function setToSearchCache(key, data, catalogScope) {
    if (!key || !data) return;
    if (SESSION_SEARCH_CACHE.size >= SEARCH_CACHE_MAX_SIZE) {
      const oldestKey = SESSION_SEARCH_CACHE.keys().next().value;
      if (oldestKey) SESSION_SEARCH_CACHE.delete(oldestKey);
    }
    SESSION_SEARCH_CACHE.set(key, {
      timestamp: Date.now(),
      data,
      catalogScope,
    });
  }

  function invalidateSearchCache() {
    SESSION_SEARCH_CACHE.clear();
  }

  function findNarrowableParentCache(query, catalogScope) {
    const qClean = (query || "").trim().toLowerCase();
    if (!qClean) return null;

    // 1. 尝试找前缀词缓存：例如当前是 "解耦"，检查是否已有 "解" 的完整缓存
    for (const [cacheKey, entry] of SESSION_SEARCH_CACHE.entries()) {
      if (entry.catalogScope !== catalogScope || Date.now() - entry.timestamp > SEARCH_CACHE_TTL) continue;
      const [cachedQ, cachedTag] = cacheKey.split("::");
      if (cachedTag !== (activeSessionFilterTagId || "all")) continue;
      if (cachedQ && cachedQ.length < qClean.length && qClean.startsWith(cachedQ)) {
        if (entry && entry.data && !entry.data.truncated && Array.isArray(entry.data.results)) {
          return { parentQuery: cachedQ, data: entry.data };
        }
      }
    }

    // 2. 尝试找多词主前缀：例如当前是 "解耦 优化"，检查是否已有 "解耦" 的缓存
    const keywords = qClean.split(/\s+/).filter(Boolean);
    if (keywords.length > 1) {
      for (const kw of keywords) {
        const key = getSearchCacheKey(kw, activeSessionFilterTagId);
        const entry = SESSION_SEARCH_CACHE.get(key);
        if (entry && entry.data && Array.isArray(entry.data.results)) {
          return { parentQuery: kw, data: entry.data };
        }
      }
    }

    return null;
  }

  let isSearchWarming = false;
  async function prewarmSessionSearchIndex() {
    if (knownSessionsMap.size > 0 || isSearchWarming) return;
    isSearchWarming = true;
    try {
      const realFetch = originalWindowFetch || baseFetch || (typeof fetch === "function" ? fetch : null);
      if (!realFetch) return;
      const warmResp = await realFetch("/api/sessions", { cache: "no-store" });
      if (warmResp?.ok) {
        const warmData = await warmResp.json();
        if (Array.isArray(warmData?.sessions)) {
          for (const s of warmData.sessions) {
            if (s?.id) {
              knownSessionsMap.set(s.id, s);
              const title = computeSessionTitle(s);
              knownSessionTitles.set(s.id, title);
            }
          }
        }
      }
    } catch (e) {
    } finally {
      isSearchWarming = false;
    }
  }

  // 页面空闲与用户悬停时毫秒级自动预热
  if (typeof window !== "undefined") {
    setTimeout(prewarmSessionSearchIndex, 1200);
    window.addEventListener("pointerdown", () => prewarmSessionSearchIndex(), { once: true, passive: true });
  }

  // ==========================================
  // 模型设置与配置极速内存秒开缓存 (Models Fast SWR Cache)
  // 解决模型标签页点击打开慢、网络往返等待与界面空白抖动问题
  // ==========================================
  const MODELS_FAST_CACHE_TTL = 300000; // 5分钟有效缓存
  const modelsFastMemoryCache = new Map(); // cacheKey -> { data, headers, timestamp }
  const inFlightModelsFetches = new Map(); // cacheKey -> Promise
  const MODELS_STORAGE_PREFIX = "pi-enh-models-cache-v1:";

  function safeNativeFetch(input, init) {
    const realFetch = originalWindowFetch || baseFetch || (typeof window !== "undefined" && typeof window.fetch === "function" ? window.fetch : null);
    if (!realFetch) return Promise.reject(new Error("fetch unavailable"));
    const targetWindow = typeof window !== "undefined" ? window : globalThis;
    return realFetch.apply(targetWindow, [input, init]);
  }

  function normalizeModelsCacheKey(url) {
    if (!url || typeof url !== "string") return "";
    try {
      const u = new URL(url, typeof window !== "undefined" ? window.location.href : "http://localhost");
      const cwd = u.searchParams.get("cwd");
      return cwd ? `${u.pathname}?cwd=${encodeURIComponent(cwd)}` : u.pathname;
    } catch (_) {
      return url.split("#")[0].split("?")[0];
    }
  }

  function isModelsFastCacheUrl(url) {
    if (!url || typeof url !== "string") return false;
    return (
      url.includes("/api/models-config") ||
      url.includes("/api/models/enabled") ||
      url.includes("/api/auth/providers")
    );
  }

  function readModelsPersistentSnapshot(cacheKey) {
    if (typeof localStorage === "undefined") return null;
    try {
      const raw = localStorage.getItem(MODELS_STORAGE_PREFIX + cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data && typeof parsed.data === "object") {
        return parsed;
      }
    } catch (_) {}
    return null;
  }

  function writeModelsPersistentSnapshot(cacheKey, data) {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(MODELS_STORAGE_PREFIX + cacheKey, JSON.stringify({
        data,
        timestamp: Date.now()
      }));
    } catch (_) {}
  }

  function findCandidateModelsSnapshot(cacheKey) {
    let entry = modelsFastMemoryCache.get(cacheKey);
    if (entry && entry.data) return entry;

    if (cacheKey.startsWith("/api/models/enabled")) {
      for (const [k, v] of modelsFastMemoryCache.entries()) {
        if (k.startsWith("/api/models/enabled") && v && v.data && v.data.scope !== "project") {
          return v;
        }
      }
    }

    const persisted = readModelsPersistentSnapshot(cacheKey);
    if (persisted && persisted.data) {
      modelsFastMemoryCache.set(cacheKey, {
        data: persisted.data,
        headers: { "Content-Type": "application/json" },
        timestamp: persisted.timestamp || 0
      });
      return modelsFastMemoryCache.get(cacheKey);
    }

    if (cacheKey.startsWith("/api/models/enabled")) {
      const genericPersisted = readModelsPersistentSnapshot("/api/models/enabled");
      if (genericPersisted && genericPersisted.data) {
        modelsFastMemoryCache.set(cacheKey, {
          data: genericPersisted.data,
          headers: { "Content-Type": "application/json" },
          timestamp: genericPersisted.timestamp || 0
        });
        return modelsFastMemoryCache.get(cacheKey);
      }
    }

    return null;
  }

  function invalidateModelsFastCache(urlPattern) {
    if (!urlPattern) {
      modelsFastMemoryCache.clear();
      return;
    }
    for (const key of Array.from(modelsFastMemoryCache.keys())) {
      if (key.includes(urlPattern)) {
        modelsFastMemoryCache.delete(key);
        try {
          localStorage.removeItem(MODELS_STORAGE_PREFIX + key);
        } catch (_) {}
      }
    }
  }

  async function handleModelsFastCacheGet(input, init, requestUrl) {
    const cacheKey = normalizeModelsCacheKey(requestUrl);
    const candidate = findCandidateModelsSnapshot(cacheKey);
    const now = Date.now();

    // 1. 命中内存或持久化快照：0ms 瞬间直出给 React
    if (candidate && candidate.data) {
      if (now - (candidate.timestamp || 0) > 4000 && !inFlightModelsFetches.has(cacheKey)) {
        const bgPromise = (async () => {
          try {
            const resp = await safeNativeFetch(requestUrl, { ...init, cache: "no-store" });
            if (resp && (resp.ok || resp.status === 200)) {
              const freshData = await resp.json();
              if (freshData && typeof freshData === "object") {
                const updatedEntry = {
                  data: freshData,
                  headers: { "Content-Type": "application/json" },
                  timestamp: Date.now()
                };
                modelsFastMemoryCache.set(cacheKey, updatedEntry);
                if (cacheKey.startsWith("/api/models/enabled")) {
                  modelsFastMemoryCache.set("/api/models/enabled", updatedEntry);
                  writeModelsPersistentSnapshot("/api/models/enabled", freshData);
                }
                writeModelsPersistentSnapshot(cacheKey, freshData);
              }
            }
          } catch (_) {} finally {
            inFlightModelsFetches.delete(cacheKey);
          }
        })();
        inFlightModelsFetches.set(cacheKey, bgPromise);
      }

      return createCachedResponse(candidate.data, candidate.headers || { "Content-Type": "application/json" }, "MODELS_FAST_CACHE_HIT");
    }

    // 2. 缓存未命中但有正在进行的同向网络请求：合并请求 (Coalesce)
    if (inFlightModelsFetches.has(cacheKey)) {
      try {
        const sharedData = await inFlightModelsFetches.get(cacheKey);
        if (sharedData) {
          return createCachedResponse(sharedData, { "Content-Type": "application/json" }, "MODELS_COALESCED_HIT");
        }
      } catch (_) {}
    }

    // 3. 全新网络拉取
    let resolveInFlight = null;
    const inFlightPromise = new Promise(r => { resolveInFlight = r; });
    inFlightModelsFetches.set(cacheKey, inFlightPromise);

    try {
      const resp = await safeNativeFetch(input, { ...init, cache: "no-store" });
      if (resp && (resp.ok || resp.status === 200)) {
        try {
          const clone = typeof resp.clone === "function" ? resp.clone() : resp;
          const freshData = await clone.json();
          if (freshData && typeof freshData === "object") {
            const entry = {
              data: freshData,
              headers: { "Content-Type": "application/json" },
              timestamp: Date.now()
            };
            modelsFastMemoryCache.set(cacheKey, entry);
            if (cacheKey.startsWith("/api/models/enabled")) {
              modelsFastMemoryCache.set("/api/models/enabled", entry);
              writeModelsPersistentSnapshot("/api/models/enabled", freshData);
            }
            writeModelsPersistentSnapshot(cacheKey, freshData);
            if (resolveInFlight) resolveInFlight(freshData);
            return createCachedResponse(freshData, resp.headers, "MODELS_LIVE");
          }
        } catch (_) {}
      }
      if (resolveInFlight) resolveInFlight(null);
      return resp;
    } catch (err) {
      if (resolveInFlight) resolveInFlight(null);
      throw err;
    } finally {
      inFlightModelsFetches.delete(cacheKey);
    }
  }

  async function preloadModelsFastCache(customCwd) {
    try {
      const cwd = customCwd || (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("cwd") : "");
      const urls = [
        "/api/models-config",
        "/api/auth/providers",
        "/api/models/enabled",
        cwd ? `/api/models/enabled?cwd=${encodeURIComponent(cwd)}` : null
      ].filter(Boolean);
      await Promise.allSettled(urls.map(u => handleModelsFastCacheGet(u, { method: "GET" }, u)));
    } catch (_) {}
  }
  if (typeof window !== "undefined") {
    window.__PI_ENH_PRELOAD_MODELS_CACHE__ = preloadModelsFastCache;
    window.__PI_ENH_INVALIDATE_MODELS_CACHE__ = invalidateModelsFastCache;
  }

  let activeSearchAbortController = null;

  async function handleEnhancedSessionSearch(input, init, requestUrl) {
    const realFetch = originalWindowFetch || baseFetch || (typeof fetch === "function" ? fetch : null);
    if (!realFetch) return Promise.reject(new Error("fetch unavailable"));

    let query = "";
    try {
      const parsedUrl = new URL(requestUrl, typeof window !== "undefined" ? window.location.href : "http://localhost");
      query = (parsedUrl.searchParams.get("q") || "").trim();
    } catch (e) {}

    if (!query) {
      return realFetch(input, init);
    }

    // Native catalogue ownership is required before local metadata can add hits.
    // Older tabs without this bridge use the authoritative server search.
    const catalog = getNativeSearchCatalog();
    if (!catalog) return realFetch(input, init);
    const catalogById = new Map(catalog.sessions.filter((s) => s?.id && !s.transient && !s.submissionPending).map((s) => [s.id, s]));

    // 1. 优先命中 0ms 闪电 LRU 缓存
    const cacheKey = getSearchCacheKey(query, activeSessionFilterTagId);
    const cachedData = getFromSearchCache(cacheKey, catalog.scope);
    if (cachedData) {
      scheduleSearchResultsHighlight();
      return createCachedResponse(cachedData, new Headers({ "Content-Type": "application/json" }), "ENHANCED_SEARCH_CACHE");
    }

    const keywords = query.split(/\s+/).map((k) => k.trim()).filter(Boolean);

    // 1.1 前缀或多词子集内存收窄匹配 (0ms 瞬发响应)
    const narrowableParent = findNarrowableParentCache(query, catalog.scope);
    if (narrowableParent) {
      const parentResults = narrowableParent.data.results || [];
      const filtered = [];

      for (const item of parentResults) {
        const fullSnippet = ((item.before || "") + " " + (item.match || "") + " " + (item.after || "")).toLowerCase();
        const sid = item.session?.id;
        const sess = sid ? catalogById.get(sid) : null;
        const sessMeta = ((sess?.name || "") + " " + (sess?.firstMessage || "") + " " + (sess?.id || "")).toLowerCase();
        const combined = fullSnippet + " " + sessMeta;

        const matchesAll = keywords.every((kw) => combined.includes(kw.toLowerCase()));
        if (matchesAll) {
          filtered.push(item);
        }
      }

      if (filtered.length > 0) {
        const narrowedJson = {
          results: filtered,
          truncated: narrowableParent.data.truncated || false,
        };
        setToSearchCache(cacheKey, narrowedJson, catalog.scope);
        scheduleSearchResultsHighlight();
        return createCachedResponse(narrowedJson, new Headers({ "Content-Type": "application/json" }), "ENHANCED_SEARCH_NARROWED");
      }
    }

    // 2. 中断旧的过期网络请求，释放通道与服务端 I/O
    if (activeSearchAbortController) {
      try { activeSearchAbortController.abort(); } catch (e) {}
    }
    activeSearchAbortController = new AbortController();
    const currentAbortSignal = activeSearchAbortController.signal;

    let nativeResults = [];
    let isTruncated = false;

    // 4. 多关键词智能优化：单关键词直接请求；多关键词以最长关键词为主特征检索，避免多次打满全盘扫描
    if (keywords.length <= 1) {
      try {
        const fetchInit = { ...init, signal: currentAbortSignal };
        const realResp = await realFetch(input, fetchInit);
        if (!realResp || !realResp.ok) return realResp;
        const rawJson = await realResp.json();
        nativeResults = Array.isArray(rawJson?.results) ? rawJson.results : [];
        isTruncated = !!rawJson?.truncated;
      } catch (e) {
        if (currentAbortSignal.aborted) return new Response(JSON.stringify({ results: [], truncated: false }), { status: 200 });
        return realFetch(input, init);
      }
    } else {
      // 选取长度最长的主关键词优先检索，大幅减少重型全盘扫描请求
      const primaryKeyword = keywords.reduce((a, b) => (b.length > a.length ? b : a), keywords[0]);
      const secondaryKeywords = keywords.filter((k) => k !== primaryKeyword);

      try {
        const subUrl = new URL(requestUrl, typeof window !== "undefined" ? window.location.href : "http://localhost");
        subUrl.searchParams.set("q", primaryKeyword);
        const fetchInit = { ...init, signal: currentAbortSignal };
        const realResp = await realFetch(subUrl.toString(), fetchInit);

        if (realResp && realResp.ok) {
          const rawJson = await realResp.json();
          const primaryList = Array.isArray(rawJson?.results) ? rawJson.results : [];
          if (rawJson?.truncated) isTruncated = true;

          // 在客户端对次要关键词进行毫秒级 AND 过滤与片段拼接
          for (const item of primaryList) {
            const fullSnippet = ((item.before || "") + " " + (item.match || "") + " " + (item.after || "")).toLowerCase();
            const sid = item.session?.id;
            const sess = sid ? catalogById.get(sid) : null;
            const sessMeta = ((sess?.name || "") + " " + (sess?.firstMessage || "") + " " + (sess?.id || "")).toLowerCase();
            const combined = fullSnippet + " " + sessMeta;

            const matchesAllSecondary = secondaryKeywords.every((sk) => combined.includes(sk.toLowerCase()));
            if (matchesAllSecondary) {
              nativeResults.push(item);
            }
          }
        }
      } catch (e) {
        if (currentAbortSignal.aborted) return new Response(JSON.stringify({ results: [], truncated: false }), { status: 200 });
        nativeResults = [];
      }
    }

    const seenSessionIds = new Set(nativeResults.map((r) => r.session?.id).filter(Boolean));
    const titleMatches = [];

    // 本地标题/首条消息多关键词 AND 匹配
    for (const [id, s] of catalogById.entries()) {
      if (seenSessionIds.has(id)) continue;
      const name = (s.name || "").trim();
      const firstMsg = (s.firstMessage || "").trim();
      const idStr = (s.id || "").trim();
      const fullText = (name + " " + firstMsg + " " + idStr).toLowerCase();

      const matchesAll = keywords.every((kw) => fullText.includes(kw.toLowerCase()));
      if (!matchesAll) continue;

      const primaryKw = keywords[0].toLowerCase();
      let matchText = name;
      let matchIdx = name.toLowerCase().indexOf(primaryKw);
      if (matchIdx === -1 && firstMsg.toLowerCase().includes(primaryKw)) {
        matchText = firstMsg;
        matchIdx = firstMsg.toLowerCase().indexOf(primaryKw);
      } else if (matchIdx === -1 && idStr.toLowerCase().includes(primaryKw)) {
        matchText = idStr;
        matchIdx = idStr.toLowerCase().indexOf(primaryKw);
      }
      if (matchIdx === -1) {
        matchText = name || firstMsg || idStr;
        matchIdx = 0;
      }

      const before = matchText.slice(Math.max(0, matchIdx - 40), matchIdx);
      const match = matchText.slice(matchIdx, matchIdx + keywords[0].length);
      const after = matchText.slice(matchIdx + keywords[0].length, matchIdx + keywords[0].length + 40);
      titleMatches.push({
        session: s,
        before: (matchIdx > 40 ? "..." : "") + before,
        match: match,
        after: after + (matchIdx + keywords[0].length + 40 < matchText.length ? "..." : ""),
        isTitleMatch: true,
      });
      seenSessionIds.add(id);
    }

    let mergedResults = [...titleMatches, ...nativeResults].filter((r) => catalogById.has(r.session?.id));

    // 结合标签过滤：若选中了具体标签，严格过滤出满足该标签的会话
    if (isPluginEnabled("session-tags") && activeSessionFilterTagId && activeSessionFilterTagId !== "all") {
      const mappings = readSessionTagMappings();
      mergedResults = mergedResults.filter((r) => {
        const sid = r.session?.id;
        return sid && Array.isArray(mappings[sid]) && mappings[sid].includes(activeSessionFilterTagId);
      });
    }

    const mergedJson = {
      results: mergedResults,
      truncated: isTruncated,
    };

    // 保存至 LRU 高性能缓存
    if (getNativeSearchCatalog()?.scope === catalog.scope) setToSearchCache(cacheKey, mergedJson, catalog.scope);

    // 触发搜索关键词全量高亮与导航
    scheduleSearchResultsHighlight();

    return createCachedResponse(mergedJson, new Headers({ "Content-Type": "application/json" }), "ENHANCED_SEARCH");
  }

  // ==========================================
  // 搜索关键词高亮与多片段方向键定位
  // ==========================================
  let highlightSearchDebounceTimer = null;
  function scheduleSearchResultsHighlight() {
    if (highlightSearchDebounceTimer) clearTimeout(highlightSearchDebounceTimer);
    highlightSearchDebounceTimer = setTimeout(() => {
      filterSearchResultsByTag();
      highlightSearchResultsKeywords();
      syncSearchResultsFoldingBars();
    }, 40);
  }

  // ==========================================
  // 会话搜索项目与归档折叠管理 (Session Search Project & Archive Folding)
  // ==========================================
  const searchExpandedProjectKeys = new Set();
  let searchArchivedCollapsed = true;

  function resetSearchFoldingState() {
    searchExpandedProjectKeys.clear();
    searchArchivedCollapsed = true;
  }

  function getSearchButtonSession(btn) {
    const sid = btn.getAttribute("data-search-session-id");
    if (!sid) return null;
    const fromMap = knownSessionsMap.get(sid);
    if (fromMap) return fromMap;
    const cwdSpan = btn.querySelector("span[title]");
    const cwd = cwdSpan ? cwdSpan.getAttribute("title") : "";
    return { id: sid, cwd };
  }

  let isSyncingSearchFolding = false;
  function syncSearchResultsFoldingBars() {
    if (isSyncingSearchFolding) return;
    isSyncingSearchFolding = true;
    try {
      const input = getSessionSearchInput();
      const isSearchOpen = !!input && input.isConnected && input.offsetParent !== null;
      const hasQuery = Boolean(input?.value?.trim());

      if (!isSearchOpen || !hasQuery) {
        resetSearchFoldingState();
        document.querySelectorAll(".pi-enh-search-group-toggle").forEach((el) => el.remove());
        document.querySelectorAll(".pi-enh-search-empty-current-hint").forEach((el) => el.remove());
        document.querySelectorAll("button[data-search-session-id].is-search-collapsed").forEach((b) => b.classList.remove("is-search-collapsed"));
        return;
      }

      if (!isPluginEnabled("session-search-project-folding")) {
        document.querySelectorAll(".pi-enh-search-group-toggle").forEach((el) => el.remove());
        document.querySelectorAll(".pi-enh-search-empty-current-hint").forEach((el) => el.remove());
        document.querySelectorAll("button[data-search-session-id].is-search-collapsed").forEach((b) => b.classList.remove("is-search-collapsed"));
        return;
      }

      const buttons = Array.from(document.querySelectorAll("button[data-search-session-id]"));
      if (buttons.length === 0) {
        document.querySelectorAll(".pi-enh-search-group-toggle").forEach((el) => el.remove());
        document.querySelectorAll(".pi-enh-search-empty-current-hint").forEach((el) => el.remove());
        return;
      }

      const container = buttons[0].parentElement;
      if (container && !container.classList.contains("pi-enh-search-results-container")) {
        container.classList.add("pi-enh-search-results-container");
      }

      const currentProjectKey = getCurrentProjectStatusKey();
      const archivedIds = readStoredSessionIds(ARCHIVED_SESSION_STORAGE_KEY);

      const currentButtons = [];
      const projectButtonsMap = new Map();
      const archivedButtons = [];

      for (const btn of buttons) {
        const sid = btn.getAttribute("data-search-session-id");
        let group = btn.getAttribute("data-search-group");
        let pKey = btn.getAttribute("data-search-project-key");
        let pTitle = btn.getAttribute("data-search-project-title");

        if (!group) {
          const isArchived = btn.getAttribute("data-search-archived") === "true" || (sid && archivedIds.has(sid));
          if (isArchived) {
            group = "archived";
          } else {
            const sess = getSearchButtonSession(btn);
            if (isSessionInCurrentProject(sess, currentProjectKey)) {
              group = "current";
            } else {
              group = "other";
              pKey = getSessionProjectStatusKey(sess) || "other";
              pTitle = sess?.projectRoot || sess?.cwd || "其他项目";
            }
          }
          btn.setAttribute("data-search-group", group);
          if (pKey) btn.setAttribute("data-search-project-key", pKey);
          if (pTitle) btn.setAttribute("data-search-project-title", pTitle);
        }

        if (group === "archived") {
          archivedButtons.push(btn);
        } else if (group === "other") {
          if (!pKey) {
            const sess = getSearchButtonSession(btn);
            pKey = getSessionProjectKey(sess);
            pTitle = sess?.projectRoot || sess?.cwd || "其他项目";
            btn.setAttribute("data-search-project-key", pKey);
            btn.setAttribute("data-search-project-title", pTitle);
          }
          if (!projectButtonsMap.has(pKey)) {
            projectButtonsMap.set(pKey, { projectKey: pKey, projectTitle: pTitle || pKey, buttons: [] });
          }
          projectButtonsMap.get(pKey).buttons.push(btn);
        } else {
          currentButtons.push(btn);
          btn.classList.remove("is-search-collapsed");
        }
      }

      // 1. 各个其他项目的独立折叠与按钮显隐同步
      for (const [pKey, proj] of projectButtonsMap.entries()) {
        const isExpanded = searchExpandedProjectKeys.has(pKey);
        for (const btn of proj.buttons) {
          btn.classList.toggle("is-search-collapsed", !isExpanded);
        }

        let toggle = Array.from(container.querySelectorAll('.pi-enh-search-group-toggle[data-toggle-group="project"]')).find(
          (el) => el.getAttribute("data-project-key") === pKey
        );
        if (!toggle) {
          toggle = document.createElement("div");
          toggle.className = "pi-enh-search-group-toggle";
          toggle.setAttribute("data-toggle-group", "project");
          toggle.setAttribute("data-project-key", pKey);
          toggle.setAttribute("role", "button");
          toggle.setAttribute("tabindex", "0");
          toggle.setAttribute("title", `点击展开/收起 ${proj.projectTitle} 项目的匹配会话`);
          toggle.innerHTML = `
            <span class="pi-enh-search-group-arrow">▶</span>
            <span class="pi-enh-search-group-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              </svg>
            </span>
            <span class="pi-enh-search-group-title" title="${escapeHtml(proj.projectTitle)}">${escapeHtml(proj.projectTitle)}</span>
            <span class="pi-enh-search-group-count">${proj.buttons.length} 个匹配</span>
          `;
          toggle.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (searchExpandedProjectKeys.has(pKey)) {
              searchExpandedProjectKeys.delete(pKey);
            } else {
              searchExpandedProjectKeys.add(pKey);
            }
            syncSearchResultsFoldingBars();
          });
          toggle.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              if (searchExpandedProjectKeys.has(pKey)) {
                searchExpandedProjectKeys.delete(pKey);
              } else {
                searchExpandedProjectKeys.add(pKey);
              }
              syncSearchResultsFoldingBars();
            }
          });
        }

        toggle.classList.toggle("is-expanded", isExpanded);
        toggle.classList.toggle("is-collapsed", !isExpanded);
        const countSpan = toggle.querySelector(".pi-enh-search-group-count");
        if (countSpan && countSpan.textContent !== `${proj.buttons.length} 个匹配`) {
          countSpan.textContent = `${proj.buttons.length} 个匹配`;
        }

        const firstBtn = proj.buttons[0];
        if (firstBtn && (toggle.parentElement !== container || toggle.nextElementSibling !== firstBtn)) {
          firstBtn.before(toggle);
        }
      }

      // 清理已失效的项目折叠条
      container.querySelectorAll('.pi-enh-search-group-toggle[data-toggle-group="project"]').forEach((toggle) => {
        const pk = toggle.getAttribute("data-project-key");
        if (!pk || !projectButtonsMap.has(pk)) {
          toggle.remove();
        }
      });
      // 清理旧的统一 other 折叠条
      container.querySelectorAll('.pi-enh-search-group-toggle[data-toggle-group="other"]').forEach((toggle) => toggle.remove());

      // 2. 已归档会话的折叠与按钮显隐同步
      for (const btn of archivedButtons) {
        btn.classList.toggle("is-search-collapsed", searchArchivedCollapsed);
      }

      let archivedToggle = container.querySelector('.pi-enh-search-group-toggle[data-toggle-group="archived"]');
      if (archivedButtons.length > 0) {
        if (!archivedToggle) {
          archivedToggle = document.createElement("div");
          archivedToggle.className = "pi-enh-search-group-toggle";
          archivedToggle.setAttribute("data-toggle-group", "archived");
          archivedToggle.setAttribute("role", "button");
          archivedToggle.setAttribute("tabindex", "0");
          archivedToggle.setAttribute("title", "点击展开/收起已归档的匹配会话");
          archivedToggle.innerHTML = `
            <span class="pi-enh-search-group-arrow">▶</span>
            <span class="pi-enh-search-group-icon">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="21 8 21 21 3 21 3 8"></polyline>
                <rect x="1" y="3" width="22" height="5"></rect>
                <line x1="10" y1="12" x2="14" y2="12"></line>
              </svg>
            </span>
            <span class="pi-enh-search-group-title">已归档会话</span>
            <span class="pi-enh-search-group-count">${archivedButtons.length} 个匹配</span>
          `;
          archivedToggle.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            searchArchivedCollapsed = !searchArchivedCollapsed;
            syncSearchResultsFoldingBars();
          });
          archivedToggle.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              searchArchivedCollapsed = !searchArchivedCollapsed;
              syncSearchResultsFoldingBars();
            }
          });
        }

        archivedToggle.classList.toggle("is-expanded", !searchArchivedCollapsed);
        archivedToggle.classList.toggle("is-collapsed", searchArchivedCollapsed);
        const countSpan = archivedToggle.querySelector(".pi-enh-search-group-count");
        if (countSpan && countSpan.textContent !== `${archivedButtons.length} 个匹配`) {
          countSpan.textContent = `${archivedButtons.length} 个匹配`;
        }

        const firstArchived = archivedButtons[0];
        if (firstArchived && (archivedToggle.parentElement !== container || archivedToggle.nextElementSibling !== firstArchived)) {
          firstArchived.before(archivedToggle);
        }
      } else if (archivedToggle) {
        archivedToggle.remove();
      }

      // 3. 本地项目无匹配提示
      let emptyHint = container.querySelector(".pi-enh-search-empty-current-hint");
      if (currentButtons.length === 0 && (projectButtonsMap.size > 0 || archivedButtons.length > 0)) {
        if (!emptyHint) {
          emptyHint = document.createElement("div");
          emptyHint.className = "pi-enh-search-empty-current-hint";
          emptyHint.textContent = "当前项目无匹配对话，已为您匹配其他项目会话：";
        }
        const firstTarget = container.querySelector(".pi-enh-search-group-toggle");
        if (firstTarget && (emptyHint.parentElement !== container || emptyHint.nextElementSibling !== firstTarget)) {
          firstTarget.before(emptyHint);
        }
      } else if (emptyHint) {
        emptyHint.remove();
      }
    } finally {
      isSyncingSearchFolding = false;
    }
  }

  function filterSearchResultsByTag() {
    const resultButtons = document.querySelectorAll("button[data-search-session-id]");
    if (resultButtons.length === 0) return;

    const mappings = readSessionTagMappings();
    let visibleCount = 0;

    for (const btn of resultButtons) {
      const sid = btn.getAttribute("data-search-session-id");
      if (!sid) continue;

      let shouldShow = true;
      if (activeSessionFilterTagId && activeSessionFilterTagId !== "all") {
        const tagIds = mappings[sid];
        shouldShow = Array.isArray(tagIds) && tagIds.includes(activeSessionFilterTagId);
      }

      if (shouldShow) {
        btn.style.display = "";
        visibleCount++;
      } else {
        btn.style.display = "none";
      }
    }
  }

  let activeSearchFocusedCard = null;

  function highlightSearchResultsKeywords() {
    const searchInput = getSessionSearchInput();
    const rawQuery = (searchInput?.value || "").trim();
    const keywords = rawQuery.split(/\s+/).map((k) => k.trim()).filter(Boolean);
    if (keywords.length === 0) return;

    const resultCards = document.querySelectorAll("button[data-search-session-id]");
    if (resultCards.length === 0) return;

    const regexPattern = keywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const regex = new RegExp(`(${regexPattern})`, "gi");

    for (const card of resultCards) {
      // 1. 标题关键词高亮
      const titleSpan = card.querySelector("span.truncate") || card.firstElementChild;
      if (titleSpan && titleSpan.tagName === "SPAN") {
        const rawTitle = titleSpan.getAttribute("data-pi-enh-raw-title") || titleSpan.textContent;
        if (!titleSpan.hasAttribute("data-pi-enh-raw-title")) {
          titleSpan.setAttribute("data-pi-enh-raw-title", rawTitle);
        }
        if (regex.test(rawTitle)) {
          const nextTitleHtml = escapeHtml(rawTitle).replace(regex, `<mark class="pi-enh-search-highlight">$1</mark>`);
          if (titleSpan.innerHTML !== nextTitleHtml) {
            titleSpan.innerHTML = nextTitleHtml;
          }
        }
      }

      // 2. 正文匹配片段关键词多词高亮
      const snippetSpan = card.querySelector("span.wrap-anywhere") || card.lastElementChild;
      if (snippetSpan && snippetSpan.tagName === "SPAN") {
        const rawSnippet = snippetSpan.getAttribute("data-pi-enh-raw-snippet") || snippetSpan.textContent;
        if (!snippetSpan.hasAttribute("data-pi-enh-raw-snippet")) {
          snippetSpan.setAttribute("data-pi-enh-raw-snippet", rawSnippet);
        }
        if (regex.test(rawSnippet)) {
          const nextSnippetHtml = escapeHtml(rawSnippet).replace(regex, `<mark class="pi-enh-search-highlight">$1</mark>`);
          if (snippetSpan.innerHTML !== nextSnippetHtml) {
            snippetSpan.innerHTML = nextSnippetHtml;
          }
        }
      }

      // 3. 多关键词匹配片段键盘 ↑ / ↓ 方向键定位导航器 (Snippet Navigator)
      const marks = card.querySelectorAll("mark.pi-enh-search-highlight");
      let nav = card.querySelector(".pi-enh-search-snippet-nav");

      if (marks.length > 1) {
        if (!nav) {
          nav = document.createElement("span");
          nav.className = "pi-enh-search-snippet-nav";
          nav.setAttribute("title", "使用键盘 ↑/↓ 键或点击切换定位匹配片段");
          nav.innerHTML = `
            <button type="button" class="pi-enh-snip-btn" data-snip-action="prev" title="上一处 (↑)">▲</button>
            <span class="pi-enh-snip-counter">1/${marks.length}</span>
            <button type="button" class="pi-enh-snip-btn" data-snip-action="next" title="下一处 (↓)">▼</button>
          `;
          const headerRow = card.querySelector("span.mt-1.flex") || card.children[1] || card.firstElementChild;
          if (headerRow) {
            headerRow.appendChild(nav);
          } else {
            card.appendChild(nav);
          }
        } else {
          const counter = nav.querySelector(".pi-enh-snip-counter");
          if (counter && !counter.textContent.endsWith(`/${marks.length}`)) {
            counter.textContent = `1/${marks.length}`;
          }
        }

        if (!card.__piEnhNavBound) {
          card.__piEnhNavBound = true;
          card.addEventListener("mouseenter", () => {
            activeSearchFocusedCard = card;
          });
          card.addEventListener("mouseleave", () => {
            if (activeSearchFocusedCard === card) {
              activeSearchFocusedCard = null;
            }
            card.querySelectorAll("mark.is-focused-mark").forEach((m) => m.classList.remove("is-focused-mark"));
          });

          card.addEventListener("click", (e) => {
            const btn = e.target.closest(".pi-enh-snip-btn");
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            const action = btn.getAttribute("data-snip-action");
            navigateCardSnippets(card, action === "prev" ? -1 : 1);
          });
        }
      } else if (nav) {
        nav.remove();
      }
    }
  }

  function navigateCardSnippets(card, direction = 1) {
    if (!card) return;
    const marks = Array.from(card.querySelectorAll("mark.pi-enh-search-highlight"));
    if (marks.length <= 1) return;

    let curIdx = marks.findIndex((m) => m.classList.contains("is-focused-mark"));
    if (curIdx === -1) curIdx = 0;
    marks[curIdx]?.classList.remove("is-focused-mark");

    const nextIdx = (curIdx + direction + marks.length) % marks.length;
    const targetMark = marks[nextIdx];
    if (targetMark) {
      targetMark.classList.add("is-focused-mark");
      targetMark.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }

    const counter = card.querySelector(".pi-enh-snip-counter");
    if (counter) {
      counter.textContent = `${nextIdx + 1}/${marks.length}`;
    }
  }

  addManagedListener(window, "keydown", (e) => {
    if (!activeSearchFocusedCard) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const marks = activeSearchFocusedCard.querySelectorAll("mark.pi-enh-search-highlight");
      if (marks.length <= 1) return;
      e.preventDefault();
      e.stopPropagation();
      navigateCardSnippets(activeSearchFocusedCard, e.key === "ArrowDown" ? 1 : -1);
    }
  }, true);

  function syncSessionSearchTagFilterBar() {
    if (!isPluginEnabled("session-tags")) {
      document.querySelector(".pi-enh-session-tag-filter-bar")?.remove();
      return;
    }

    const allTags = readSessionTagsDefinitions();
    if (allTags.length === 0) {
      document.querySelector(".pi-enh-session-tag-filter-bar")?.remove();
      return;
    }

    const input = getSessionSearchInput();
    const isSearchOpen = !!input && input.isConnected && input.offsetParent !== null;
    const isFiltered = activeSessionFilterTagId && activeSessionFilterTagId !== "all";

    // 核心规则：搜索框打开中始终显示；搜索框关闭中仅当设置了标签过滤时显示，若是“全部”则绝不显示
    const shouldShow = isSearchOpen || isFiltered;

    if (!shouldShow) {
      document.querySelector(".pi-enh-session-tag-filter-bar")?.remove();
      return;
    }

    // 锚点定位：搜索中挂在 input 后；非搜索时挂在工作区选择栏后
    let anchor = null;
    if (isSearchOpen) {
      anchor = input;
    } else {
      const sidebar = document.querySelector(".sidebar-container") || document.querySelector("aside");
      if (sidebar) {
        const projectBtn = sidebar.querySelector("button[title*='选择项目'], button[aria-label*='选择项目'], button:has([title*='/'])");
        if (projectBtn?.parentElement) {
          anchor = projectBtn.parentElement;
        } else {
          const openRepoBtn = sidebar.querySelector("button[title*='打开仓库根目录'], button[title*='Open repo root']");
          if (openRepoBtn?.isConnected) anchor = openRepoBtn;
          else anchor = sidebar.firstElementChild?.firstElementChild || sidebar.firstElementChild;
        }
      }
    }

    if (!anchor) return;

    let filterBar = document.querySelector(".pi-enh-session-tag-filter-bar");
    if (!filterBar) {
      filterBar = document.createElement("div");
      filterBar.className = "pi-enh-session-tag-filter-bar";
    }

    if (filterBar.previousElementSibling !== anchor) {
      anchor.after(filterBar);
    }

    const pillsHtml = [
      `<button type="button" class="pi-enh-tag-filter-pill${activeSessionFilterTagId === "all" ? " is-active" : ""}" data-tag-filter-id="all">全部</button>`,
      ...allTags.map((tag) => {
        const isActive = activeSessionFilterTagId === tag.id;
        const palette = getTagPaletteItem(tag.color);
        return `<button type="button" class="pi-enh-tag-filter-pill${isActive ? " is-active" : ""}" data-tag-filter-id="${tag.id}" style="--filter-pill-bg:${palette.bg};--filter-pill-border:${palette.border};--filter-pill-color:${palette.color};">
          <span class="pi-enh-tag-dot" style="background:${tag.color};"></span>
          <span>${escapeHtml(tag.name)}</span>
        </button>`;
      }),
    ].join("");

    if (filterBar.innerHTML !== pillsHtml) {
      filterBar.innerHTML = pillsHtml;
    }

    if (!filterBar.__piEnhBound) {
      filterBar.__piEnhBound = true;
      filterBar.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-tag-filter-id]");
        if (!btn) return;
        const targetId = btn.getAttribute("data-tag-filter-id");
        if (targetId === "all" || targetId === activeSessionFilterTagId) {
          activeSessionFilterTagId = "all";
        } else {
          activeSessionFilterTagId = targetId;
        }

        syncSessionSearchTagFilterBar();
        filterSearchResultsByTag();
        syncSearchResultsFoldingBars();

        const searchInp = getSessionSearchInput();
        if (searchInp && searchInp.isConnected && searchInp.value.trim()) {
          searchInp.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          requestSessionListRefresh(false, true);
        }
      });
    }
  }

  // 搜索框 0 延迟实时同步开闭监听器
  let searchInputObserver = null;
  function initSearchInputObserver() {
    if (searchInputObserver || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      syncSessionSearchTagFilterBar();
    });

    try {
      const target = document.querySelector(".sidebar-container") || document.body;
      observer.observe(target, { childList: true, subtree: true });
      searchInputObserver = observer;
      activeCleanups.push(() => {
        observer.disconnect();
        searchInputObserver = null;
      });
    } catch (e) {}
  }

  addManagedListener(document, "click", (e) => {
    const btn = e.target?.closest?.('button[aria-controls="session-search-input"], button[title*="搜索对话"], button[aria-label*="搜索对话"], button[title*="Search conversations"]');
    if (btn) {
      prewarmSessionSearchIndex();
      setTimeout(() => syncSessionSearchTagFilterBar(), 0);
    }

  }, true);

  addManagedListener(document, "mouseover", (e) => {
    const btn = e.target?.closest?.('button[aria-controls="session-search-input"], button[title*="搜索对话"], button[aria-label*="搜索对话"], button[title*="Search conversations"]');
    if (btn) prewarmSessionSearchIndex();
  }, { passive: true });

  initSearchInputObserver();

  // ==========================================
  // stop-fast-response (停止即时响应) 插件核心实现
  // ==========================================
  const AGENT_ABORT_COMMAND_TYPES = new Set([
    "abort",
    "abort_bash",
    "abort_compaction",
    "abort_retry"
  ]);

  const pendingStopRequests = new Map();

  // 记录每个 DOM 按钮最初的属性以及当前持有反馈的 token 集合
  // 使用 WeakMap 避免持有已销毁 DOM 的引用引起内存泄漏
  const buttonOriginalAttrs = new WeakMap();
  const buttonFeedbackHolders = new WeakMap();
  // 记录每个 token 关联的 DOM 按钮，用于精确按 own entry / sid 还原与隔离
  const tokenFeedbackMap = new Map();
  const sessionActiveTokens = new Map();

  function restoreButtonFeedbackDom(btn) {
    if (!btn || btn.nodeType !== 1) return;
    try {
      const orig = buttonOriginalAttrs.get(btn);
      if (orig) {
        if (orig.origBusy !== null && orig.origBusy !== undefined && orig.origBusy !== "") {
          btn.setAttribute("aria-busy", orig.origBusy);
        } else {
          btn.removeAttribute("aria-busy");
        }
        if (orig.origTitle !== null && orig.origTitle !== undefined && orig.origTitle !== "") {
          btn.setAttribute("title", orig.origTitle);
        } else {
          btn.removeAttribute("title");
        }
        buttonOriginalAttrs.delete(btn);
      } else {
        const domOrigBusy = btn.getAttribute("data-pi-enh-orig-busy");
        if (domOrigBusy) btn.setAttribute("aria-busy", domOrigBusy);
        else btn.removeAttribute("aria-busy");

        const domOrigTitle = btn.getAttribute("data-pi-enh-orig-title");
        if (domOrigTitle) btn.setAttribute("title", domOrigTitle);
        else btn.removeAttribute("title");
      }
      btn.removeAttribute("data-pi-enh-orig-busy");
      btn.removeAttribute("data-pi-enh-orig-title");
      btn.classList.remove("pi-enh-stopping-feedback");
      buttonFeedbackHolders.delete(btn);
    } catch (_) {}
  }

  function ensureStopFastResponseStyle() {
    if (typeof document === "undefined") return;
    try {
      if (!document.getElementById("pi-enh-stop-fast-response-style")) {
        const style = document.createElement("style");
        style.id = "pi-enh-stop-fast-response-style";
        style.textContent = `
          .pi-enh-stopping-feedback {
            opacity: 0.72 !important;
            filter: brightness(0.92);
            cursor: wait !important;
            transition: opacity 0.15s ease;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      }
    } catch (_) {}
  }

  function removeStopFastResponseStyle() {
    if (typeof document === "undefined") return;
    try {
      const style = document.getElementById("pi-enh-stop-fast-response-style");
      if (style) style.remove();
    } catch (_) {}
  }

  if (typeof isPluginEnabled === "function" ? isPluginEnabled("stop-fast-response") : true) {
    ensureStopFastResponseStyle();
  }

  function findActiveComposerStopButtons() {
    if (typeof document === "undefined") return [];
    // 真实 composer 边界限制：仅在 fieldset、form、.pi-enh-cursor-composer 或包含 textarea.chat-input-textarea 的容器内查找
    const composerRoots = [];
    const knownRoots = document.querySelectorAll(
      '[data-pi-native-composer-host], form, .pi-enh-cursor-composer, .chat-input-container, [data-chat-input-wrap]'
    );
    for (const r of knownRoots) {
      if (r && r.nodeType === 1 && !composerRoots.includes(r)) {
        composerRoots.push(r);
      }
    }
    const textareas = document.querySelectorAll('textarea.chat-input-textarea');
    for (const ta of textareas) {
      const root = ta.closest('[data-pi-native-composer-host], form, [data-composer], div') || ta.parentElement;
      if (root && !composerRoots.includes(root)) {
        composerRoots.push(root);
      }
    }

    if (composerRoots.length === 0) return [];

    const stopButtons = [];
    const stopRegex = /^(停止\s*Agent|停止代理|停止|中止|取消|Stop\s*Agent|Stop|Cancel\s*Agent|Cancel)$/i;

    for (const root of composerRoots) {
      const buttons = root.querySelectorAll('button');
      for (const btn of buttons) {
        if (!btn || btn.nodeType !== 1) continue;
        if (btn.classList?.contains("pi-enh-cursor-stop")) {
          stopButtons.push(btn);
          continue;
        }
        const title = (btn.getAttribute("title") || "").trim();
        const ariaLabel = (btn.getAttribute("aria-label") || "").trim();
        const text = (btn.textContent || "").trim();
        if (stopRegex.test(title) || stopRegex.test(ariaLabel) || stopRegex.test(text)) {
          stopButtons.push(btn);
          continue;
        }
        // 如果是 svg rect，必须有明确的 stop/abort/cancel 意图，严禁把任意带有 svg rect 的按钮当停止按钮
        if (typeof btn.querySelector === "function" && btn.querySelector("svg rect")) {
          const combined = (title + " " + ariaLabel + " " + text + " " + (btn.className || "")).toLowerCase();
          if (combined.includes("stop") || combined.includes("abort") || combined.includes("cancel") ||
              combined.includes("停止") || combined.includes("中止") || combined.includes("取消")) {
            stopButtons.push(btn);
          }
        }
      }
    }
    return Array.from(new Set(stopButtons));
  }

  function applyStopFeedback(sessionId, token) {
    if (typeof document === "undefined") return;

    // 跨会话隔离检查：若当前界面激活的不是 targetSessionId，绝不能修改当前界面的 composer 按钮
    const currentSid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    if (currentSid && sessionId && sessionId !== currentSid) {
      return;
    }

    try {
      if (typeof showToast === "function") {
        showToast("正在停止...", null, 1500);
      }
    } catch (_) {}

    ensureStopFastResponseStyle();

    const buttons = findActiveComposerStopButtons();
    if (buttons.length === 0) return;

    const requestToken = token || sessionId || {};
    let tokenEntry = tokenFeedbackMap.get(requestToken);
    if (!tokenEntry) {
      tokenEntry = { sessionId, buttons: new Set() };
      tokenFeedbackMap.set(requestToken, tokenEntry);
    }

    if (sessionId) {
      let sessTokens = sessionActiveTokens.get(sessionId);
      if (!sessTokens) {
        sessTokens = new Set();
        sessionActiveTokens.set(sessionId, sessTokens);
      }
      sessTokens.add(requestToken);
    }

    for (const btn of buttons) {
      try {
        let holders = buttonFeedbackHolders.get(btn);
        if (!holders) {
          holders = new Set();
          buttonFeedbackHolders.set(btn, holders);
        }

        if (!buttonOriginalAttrs.has(btn)) {
          buttonOriginalAttrs.set(btn, {
            origBusy: btn.getAttribute("aria-busy"),
            origTitle: btn.getAttribute("title"),
          });
          btn.setAttribute("data-pi-enh-orig-busy", btn.getAttribute("aria-busy") || "");
          btn.setAttribute("data-pi-enh-orig-title", btn.getAttribute("title") || "");
        }

        holders.add(requestToken);
        tokenEntry.buttons.add(btn);

        btn.setAttribute("aria-busy", "true");
        btn.setAttribute("title", "正在停止...");
        btn.classList.add("pi-enh-stopping-feedback");
      } catch (_) {}
    }
  }

  function clearStopFeedback(sessionId, token) {
    if (typeof document === "undefined") return;

    // 1. 如果传入了特定 token（own entry / requestToken），仅清理该 token 关联的反馈
    if (token && tokenFeedbackMap.has(token)) {
      const entry = tokenFeedbackMap.get(token);
      tokenFeedbackMap.delete(token);

      if (entry.sessionId) {
        const sessTokens = sessionActiveTokens.get(entry.sessionId);
        if (sessTokens) {
          sessTokens.delete(token);
          if (sessTokens.size === 0) sessionActiveTokens.delete(entry.sessionId);
        }
      }

      for (const btn of entry.buttons) {
        try {
          const holders = buttonFeedbackHolders.get(btn);
          if (holders) holders.delete(token);
          if (!holders || holders.size === 0) {
            restoreButtonFeedbackDom(btn);
          }
        } catch (_) {}
      }
      return;
    }

    // A late completion after disable/unload must not clear a newer request's feedback.
    if (token) return;

    // 2. 如果只传入了 sessionId，清理该 session 下所有 token
    if (sessionId) {
      const sessTokens = sessionActiveTokens.get(sessionId);
      if (sessTokens) {
        for (const tok of Array.from(sessTokens)) {
          clearStopFeedback(sessionId, tok);
        }
      }
      return;
    }

    // 3. 全局清理（如插件被禁用、设置变更或热卸载）
    for (const [tok, entry] of Array.from(tokenFeedbackMap.entries())) {
      tokenFeedbackMap.delete(tok);
      for (const btn of entry.buttons) {
        try {
          const holders = buttonFeedbackHolders.get(btn);
          if (holders) holders.delete(tok);
          if (!holders || holders.size === 0) {
            restoreButtonFeedbackDom(btn);
          }
        } catch (_) {}
      }
    }
    sessionActiveTokens.clear();

    const buttons = document.querySelectorAll(".pi-enh-stopping-feedback, [data-pi-enh-orig-busy]");
    for (const btn of buttons) {
      restoreButtonFeedbackDom(btn);
    }
  }

  if (typeof window !== "undefined") {
    window.__PI_ENH_CLEAR_STOP_FEEDBACK__ = clearStopFeedback;
    window.__PI_ENH_ENSURE_STOP_STYLE__ = ensureStopFastResponseStyle;
    window.__PI_ENH_REMOVE_STOP_STYLE__ = removeStopFastResponseStyle;
  }

  if (typeof activeCleanups !== "undefined" && Array.isArray(activeCleanups)) {
    activeCleanups.push(() => {
      for (const entries of pendingStopRuntimePreparations.values()) for (const entry of entries) entry.cancelled = true;
      pendingStopRuntimePreparations.clear();
      clearStopFeedback();
      removeStopFastResponseStyle();
      if (typeof window !== "undefined") {
        delete window.__PI_ENH_CLEAR_STOP_FEEDBACK__;
        delete window.__PI_ENH_ENSURE_STOP_STYLE__;
        delete window.__PI_ENH_REMOVE_STOP_STYLE__;
      }
    });
  }

  function isSameOriginExactAgentPost(input, init) {
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method !== "POST") return null;

    let urlStr = "";
    if (typeof input === "string") {
      urlStr = input;
    } else if (typeof URL !== "undefined" && input instanceof URL) {
      urlStr = input.href;
    } else if (typeof Request !== "undefined" && input instanceof Request) {
      urlStr = input.url;
    } else if (input && typeof input.url === "string") {
      urlStr = input.url;
    }
    if (!urlStr) return null;

    try {
      const loc = typeof window !== "undefined" && window.location ? window.location : null;
      const base = loc ? loc.href : "http://localhost";
      const parsed = new URL(urlStr, base);
      if (loc && parsed.origin !== loc.origin) return null;

      const match = parsed.pathname.match(/^\/api\/agent\/([^/?#]+)$/);
      if (!match) return null;
      const rawId = match[1];
      const sessionId = decodeURIComponent(rawId);
      const RESERVED = ["search", "export", "running", "new", "bash-output", "lease"];
      if (RESERVED.includes(sessionId)) return null;
      return { sessionId, urlStr };
    } catch (_) {
      return null;
    }
  }

  function peekAgentAbortTypeSync(input, init) {
    let body = init && init.body !== undefined ? init.body : undefined;
    if (body === undefined && input && typeof input === "object" && !(typeof Request !== "undefined" && input instanceof Request)) {
      body = input.body;
    }
    if (typeof body === "string") {
      if (body.includes('"abort') || body.includes('"abort_bash"') || body.includes('"abort_compaction"') || body.includes('"abort_retry"')) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.type === "string" && AGENT_ABORT_COMMAND_TYPES.has(parsed.type)) {
            return parsed.type;
          }
        } catch (_) {}
      }
    }
    return null;
  }

  async function resolveAgentAbortType(input, init) {
    const syncType = peekAgentAbortTypeSync(input, init);
    if (syncType) return syncType;

    let rawBody = init && init.body !== undefined ? init.body : undefined;
    if (rawBody === undefined && input && typeof input === "object") {
      if (typeof input.clone === "function" && !input.bodyUsed) {
        try {
          const cloned = input.clone();
          rawBody = await cloned.text();
        } catch (_) {
          return null;
        }
      } else if (typeof input.body === "string") {
        rawBody = input.body;
      }
    }

    if (rawBody && typeof rawBody !== "string" && typeof rawBody.text === "function") {
      try {
        rawBody = await rawBody.text();
      } catch (_) {
        return null;
      }
    } else if (rawBody && typeof rawBody === "object" && (rawBody instanceof ArrayBuffer || ArrayBuffer.isView(rawBody))) {
      try {
        rawBody = new TextDecoder().decode(rawBody);
      } catch (_) {
        return null;
      }
    }

    if (typeof rawBody === "string") {
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed && typeof parsed.type === "string" && AGENT_ABORT_COMMAND_TYPES.has(parsed.type)) {
          return parsed.type;
        }
      } catch (_) {}
    }
    return null;
  }

  async function dispatchDirectStopFetch(targetInfo, abortType, input, init) {
    const { sessionId } = targetInfo;
    const dedupeKey = `${sessionId}:${abortType}`;

    const callerSignal = init?.signal || (typeof Request !== "undefined" && input instanceof Request ? input.signal : null);
    if (callerSignal?.aborted) {
      throw callerSignal.reason || new DOMException("The user aborted a request.", "AbortError");
    }

    const myEntry = { promise: null, sessionId, abortType };
    applyStopFeedback(sessionId, myEntry);

    const existing = pendingStopRequests.get(dedupeKey);
    if (existing) {
      if (callerSignal) {
        return new Promise((resolve, reject) => {
          let settled = false;
          const onAbort = () => {
            if (settled) return;
            settled = true;
            clearStopFeedback(sessionId, myEntry);
            callerSignal.removeEventListener("abort", onAbort);
            reject(callerSignal.reason || new DOMException("The user aborted a request.", "AbortError"));
          };
          callerSignal.addEventListener("abort", onAbort, { once: true });
          existing.promise.then(
            (res) => {
              if (settled) return;
              settled = true;
              clearStopFeedback(sessionId, myEntry);
              callerSignal.removeEventListener("abort", onAbort);
              try { resolve(res.clone()); } catch (_) { resolve(res); }
            },
            (err) => {
              if (settled) return;
              settled = true;
              clearStopFeedback(sessionId, myEntry);
              callerSignal.removeEventListener("abort", onAbort);
              reject(err);
            }
          );
        });
      }
      try {
        const res = await existing.promise;
        try { return res.clone(); } catch (_) { return res; }
      } finally {
        clearStopFeedback(sessionId, myEntry);
      }
    }

    // 安全调度执行，确保无论同步抛错还是异步 reject，own entry 都会被安全清理，不留死 entry，且生命周期以真实 pending 为准，杜绝 15s 假超时
    const executeFetch = async () => {
      try {
        const activeFetch = baseFetch || originalWindowFetch || (typeof window !== "undefined" ? window.fetch : fetch);
        if (!activeFetch) throw new Error("No active fetch available");
        const response = await Promise.resolve().then(() => activeFetch.call(this, input, init));
        return response;
      } finally {
        if (pendingStopRequests.get(dedupeKey) === myEntry) {
          pendingStopRequests.delete(dedupeKey);
        }
        clearStopFeedback(sessionId, myEntry);
      }
    };

    const fetchPromise = executeFetch();
    myEntry.promise = fetchPromise;
    pendingStopRequests.set(dedupeKey, myEntry);

    try {
      const response = await fetchPromise;
      try { return response.clone(); } catch (_) { return response; }
    } catch (err) {
      if (pendingStopRequests.get(dedupeKey) === myEntry) {
        pendingStopRequests.delete(dedupeKey);
      }
      clearStopFeedback(sessionId, myEntry);
      throw err;
    }
  }

  async function interceptedFetch(input, init) {
    if (isPluginEnabled("stop-fast-response")) {
      const agentTarget = isSameOriginExactAgentPost(input, init);
      if (agentTarget) {
        const syncAbortType = peekAgentAbortTypeSync(input, init);
        if (syncAbortType) {
          return dispatchDirectStopFetch.call(this, agentTarget, syncAbortType, input, init);
        }
        const asyncAbortType = await resolveAgentAbortType(input, init);
        if (asyncAbortType) {
          return dispatchDirectStopFetch.call(this, agentTarget, asyncAbortType, input, init);
        }
      }
    }

    const url = typeof input === "string" ? input : input?.url || "";
    const request = beginHistoryPageRequest(url, input, init);
    try {
      const response = await interceptedFetchCore.call(this, input, request?.init || init);
      await request?.finish(response);
      return response;
    } catch (error) {
      await request?.finish(null, error);
      throw error;
    }
  }

  async function interceptedFetchCore(input, init) {
    const sessionId = getCurrentSessionId();
    const requestUrl = typeof input === 'string' ? input : input?.url || '';
    const requestMethod = String(init?.method || input?.method || 'GET').toUpperCase();
    // Clone Request before fetch consumes its body. Never consume the caller's stream.
    let queueRequestBody = null;
    let parsedQueueRequestBody = null;
    if (requestMethod === "POST" && /\/api\/agent\/[^/?#]+(?:[?#]|$)/.test(requestUrl)) {
      try {
        queueRequestBody = typeof init?.body === "string" ? Promise.resolve(init.body)
          : typeof Request !== "undefined" && input instanceof Request ? input.clone().text().catch(() => null) : null;
      } catch (_) {}
    }

    // A new-chat mode is staged locally; establish and verify it BEFORE the first prompt.
    if (queueRequestBody && isPluginEnabled("composer-modes")) {
      const owner = extractSessionIdFromUrl(requestUrl);
      const stagedPending = pendingNewComposerMode;
      const staged = pendingNewComposerMode?.sessionId ? pendingNewComposerMode : null;
      // Creation is not a Pi session id; it has no owner until the response.
      const ownerEngine = owner === "new" ? null : owner?.startsWith("codex:") ? "codex" : owner ? "pi" : null;
      const stagedEngine = stagedPending?.engine || "pi";
      if (stagedPending && (
        (ownerEngine && ownerEngine !== stagedEngine) ||
        stagedPending.project !== getCurrentProjectStatusKey()
      )) {
        pendingNewComposerMode = null;
      } else if (staged && owner === staged.sessionId && ownerEngine === stagedEngine) {
        const payload = await queueRequestBody.then(text => { try { return JSON.parse(text); } catch { return null; } });
        const internalPiModePrompt = stagedEngine === "pi" && String(payload?.message || "").startsWith("/composer-mode");
        if (payload?.type === "prompt" && !internalPiModePrompt) {
          if (!await requestSwitchComposerMode(staged.mode, owner)) {
            return new Response(JSON.stringify({success:false,accepted:false,code:"prompt_rejected",error:"计划/目标模式尚未确认生效，消息未发送，请重试。"}), {status:409,headers:{"Content-Type":"application/json"}});
          }
          if (pendingNewComposerMode === staged) pendingNewComposerMode = null;
        }
      }
    }

    // 封堵原生旧 clear_queue 绕过：当 composer-queue-panel 开启时，阻止向同源 /api/agent/:id POST clear_queue
    // 说明：关闭 composer-queue-panel 插件时，保持原生行为，不进行拦截与安全阻止。
    if (isPluginEnabled("composer-queue-panel") && requestMethod === "POST" && queueRequestBody) {
      const isSameOriginAgentEndpoint = /^\/api\/agent\/[^/?#]+(?:[?#]|$)/.test(requestUrl) || (() => {
        try {
          const parsed = new URL(requestUrl, window.location.href);
          return parsed.origin === window.location.origin && /^\/api\/agent\/[^/?#]+(?:[?#]|$)/.test(parsed.pathname);
        } catch (_) {
          return false;
        }
      })();
      if (isSameOriginAgentEndpoint) {
        let isClearQueue = false;
        try {
          const bodyStr = await queueRequestBody;
          if (typeof bodyStr === "string") {
            try {
              parsedQueueRequestBody = JSON.parse(bodyStr);
              if (parsedQueueRequestBody?.type === "clear_queue") isClearQueue = true;
            } catch (_) {}
          }
        } catch (_) {}

        if (isClearQueue) {
          try {
            showQueueSecurityWarningToast("已阻止可能丢失图片的旧版召回，队列未改动；请使用安全队列编辑");
          } catch (toastErr) {
            // 提示渲染抛错绝不放行危险的旧版 clear_queue 请求
          }
          return new Response(JSON.stringify({
            success: false,
            error: "已阻止可能丢失图片的旧版召回，队列未改动；请使用安全队列编辑",
            code: "LEGACY_CLEAR_QUEUE_BLOCKED",
          }), {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    // 保护跨端置顶、归档与装饰配置：若原生面板 PUT /api/models-config，自动从成功 GET 的权威配置逐字段补齐遗漏字段
    if (requestMethod === "PUT" && /\/api\/models-config(?:[?#]|$)/.test(requestUrl)) {
      try {
        let rawBody = null;
        if (typeof init?.body === "string") {
          rawBody = init.body;
        } else if (typeof Request !== "undefined" && input instanceof Request) {
          try {
            // 使用 clone() 读取文本，绝对不消费原 input 的 body 流
            rawBody = await input.clone().text();
          } catch (readErr) {
            console.error("[pi-enh] Failed to read request body during PUT models-config interception:", readErr?.message || "read error");
            return new Response(JSON.stringify({
              error: "Failed to read request body before updating models-config: " + (readErr?.message || "read error"),
              code: "MODELS_CONFIG_BODY_READ_FAILED"
            }), {
              status: 400,
              statusText: "Bad Request",
              headers: { "Content-Type": "application/json" }
            });
          }
        }

        let bodyJson = null;
        if (typeof rawBody === "string") {
          try {
            bodyJson = JSON.parse(rawBody);
          } catch (parseErr) {
            console.error("[pi-enh] JSON parse error during PUT models-config interception:", parseErr?.message || "parse error");
            return new Response(JSON.stringify({
              error: "Invalid JSON body in PUT models-config: " + (parseErr?.message || "parse error"),
              code: "MODELS_CONFIG_PARSE_FAILED"
            }), {
              status: 400,
              statusText: "Bad Request",
              headers: { "Content-Type": "application/json" }
            });
          }
        }

        if (bodyJson && typeof bodyJson === "object" && !Array.isArray(bodyJson)) {
          const METADATA_FIELDS_TO_PRESERVE = [
            "pinnedSessions",
            "pinnedRevision",
            "archivedSessions",
            "archivedRevision",
            "sessionColors",
            "sessionColorsRevision",
            "sessionTagsDefinitions",
            "sessionTagMappings",
            "sessionTagsRevision"
          ];

          const missingFields = METADATA_FIELDS_TO_PRESERVE.filter((field) => !(field in bodyJson));

          if (missingFields.length > 0) {
            let authoritativeConfig = null;
            try {
              const { resp: getResp, json: data } = await fetchModelsConfigBounded("/api/models-config", { cache: "no-store", readJson: true });
              if (getResp && getResp.ok) {
                if (data && typeof data === "object" && !Array.isArray(data) && data.providers && typeof data.providers === "object" && !Array.isArray(data.providers)) {
                  authoritativeConfig = data;
                } else {
                  console.error("[pi-enh] Authoritative models-config invalid during native PUT interception");
                }
              } else {
                console.error("[pi-enh] Authoritative models-config GET failed during native PUT interception:", getResp?.status);
              }
            } catch (err) {
              console.error("[pi-enh] Network error reading authoritative models-config before PUT:", err?.message || "network error");
            }

            if (!authoritativeConfig) {
              console.error("[pi-enh] Aborting native PUT /api/models-config to protect metadata");
              return new Response(JSON.stringify({
                error: "Failed to read authoritative config before updating models-config; please retry",
                code: "MODELS_CONFIG_READ_FAILED"
              }), {
                status: 503,
                statusText: "Service Unavailable",
                headers: { "Content-Type": "application/json" }
              });
            }

            let mutated = false;
            for (const field of missingFields) {
              if (authoritativeConfig[field] !== undefined) {
                bodyJson[field] = authoritativeConfig[field];
                mutated = true;
              }
            }

            if (mutated) {
              const newBodyStr = JSON.stringify(bodyJson);
              if (typeof Request !== "undefined" && input instanceof Request) {
                input = new Request(input, { body: newBodyStr });
              }
              init = { ...init, body: newBodyStr };
            }
          }
        }
      } catch (e) {
        console.error("[pi-enh] Error preserving metadata in PUT /api/models-config:", e?.message || "error");
        return new Response(JSON.stringify({
          error: "Internal error preserving metadata in PUT /api/models-config: " + (e?.message || "error"),
          code: "MODELS_CONFIG_PRESERVE_FAILED"
        }), {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 模型与配置 API 专用快速通道：直接以安全原生上下文透传，绝不穿透 session 会话队列与历史守卫
    if (isModelsFastCacheUrl(requestUrl)) {
      if (requestMethod === "GET") {
        return await handleModelsFastCacheGet(input, init, requestUrl);
      }
      // 对于 PUT / POST 等写操作：直接安全原生执行并同步更新缓存与本地快照
      invalidateModelsFastCache();
      const resp = await safeNativeFetch(input, init);
      if (resp && resp.ok) {
        try {
          const clone = typeof resp.clone === "function" ? resp.clone() : resp;
          const freshData = await clone.json();
          if (freshData && typeof freshData === "object") {
            const cacheKey = normalizeModelsCacheKey(requestUrl);
            const entry = {
              data: freshData,
              headers: { "Content-Type": "application/json" },
              timestamp: Date.now()
            };
            modelsFastMemoryCache.set(cacheKey, entry);
            if (cacheKey.startsWith("/api/models/enabled")) {
              modelsFastMemoryCache.set("/api/models/enabled", entry);
              writeModelsPersistentSnapshot("/api/models/enabled", freshData);
            }
            writeModelsPersistentSnapshot(cacheKey, freshData);
          }
        } catch (_) {}
      }
      return resp;
    }

    // 优先拦截并增强会话搜索：自动召回标题、首条消息与会话ID
    if (requestMethod === "GET" && /\/api\/sessions\/search(?:[?#]|$)/.test(requestUrl)) {
      return await handleEnhancedSessionSearch(input, init, requestUrl);
    }

    const callerSignal = init?.signal || input?.signal;
    const reloadSignal = sessionHistoryReloadSignals.get(extractSessionIdFromUrl(requestUrl));
    if (requestMethod === 'GET' && reloadSignal && callerSignal && /\/api\/sessions\/[^/?#]+(?:\/(?:context|state))?(?:[?#]|$)/.test(requestUrl)) {
      init = { ...init, cache: 'no-store', signal: AbortSignal.any([callerSignal, reloadSignal]) };
    } else if (requestMethod === 'GET' && reloadSignal && /\/api\/sessions\/[^/?#]+\/state(?:[?#]|$)/.test(requestUrl)) {
      init = { ...init, cache: 'no-store', signal: reloadSignal };
    }
    const isSessionsListGet =
      requestMethod === "GET" &&
      /\/api\/sessions(?:\?.*)?$/.test(requestUrl) &&
      !requestUrl.includes("/search") &&
      !requestUrl.includes("/context") &&
      !extractSessionIdFromUrl(requestUrl);
    const isHistoryGet = requestMethod === 'GET' &&
      /\/api\/sessions\/[^/?#]+(?:\/context)?(?:[?#]|$)/.test(requestUrl);
    const targetSessionId = isHistoryGet ? extractSessionIdFromUrl(requestUrl) : null;
    const authoritative = isPluginEnabled('session-history-integrity') && isHistoryGet && targetSessionId;

    const fetchInitial = () => authoritative
      ? fetchAuthoritativeHistory(input, init, requestUrl)
      : cachedSessionFetch.call(this, input, init);

    let response;
    try {
      if (isPluginEnabled('session-history-order-guard') && shouldProtectSessionHistoryOrder(requestUrl, targetSessionId)) {
        response = await wrapSessionHistoryOrderGuard(input, init, requestUrl, targetSessionId, fetchInitial);
      } else {
        response = await fetchInitial();
      }
    } catch (historyErr) {
      if (isSessionsListGet && isTransientFetchError(historyErr, init, input)) {
        const activeFetch = baseFetch || originalWindowFetch;
        if (activeFetch) {
          try {
            await new Promise((r) => setTimeout(r, 200));
            response = await activeFetch(input, { ...init, cache: "no-store" });
          } catch (_) {}
        }
        if (!response && knownSessionsMap.size > 0) {
          const fallbackSessions = Array.from(knownSessionsMap.values()).filter(
            (s) => s?.id && !isSessionDeleted(s.id)
          );
          return createCachedResponse(
            {
              sessions: fallbackSessions,
              sessionListVersion: lastKnownSessionListPayload.sessionListVersion || 0,
              runningSessionIds: Array.isArray(lastKnownSessionListPayload.runningSessionIds)
                ? lastKnownSessionListPayload.runningSessionIds
                : [],
              completionNotificationSuppressedSessionIds: Array.isArray(
                lastKnownSessionListPayload.completionNotificationSuppressedSessionIds
              )
                ? lastKnownSessionListPayload.completionNotificationSuppressedSessionIds
                : [],
            },
            {},
            "FALLBACK_SESSIONS_LIST"
          );
        }
      }

      if (isHistoryGet && targetSessionId) {
        const isOrderGuardErr = Boolean(
          historyErr?.isOrderGuardError ||
          String(historyErr?.message || "").includes("[session-history-order-guard]")
        );
        const isReloadAbortOnly = Boolean(
          reloadSignal?.aborted && !callerSignal?.aborted && isRequestAborted(historyErr, init, input)
        );
        if (isOrderGuardErr || isTransientFetchError(historyErr, init, input) || isReloadAbortOnly) {
          let fallbackResp = null;
          try {
            fallbackResp = await buildFallbackSessionHistoryResponse(targetSessionId, requestUrl);
          } catch (_) {}
          fallbackResp = fallbackResp || historyErr?.fallbackResponse || null;
          if (fallbackResp) {
            if (typeof scheduleTerminalSyncCheck === "function") {
              try {
                scheduleTerminalSyncCheck(targetSessionId, {
                  reason: isOrderGuardErr ? "order_guard_fallback" : "network_fallback",
                  force: true,
                });
              } catch (_) {}
            }
            response = fallbackResp;
          } else if (isOrderGuardErr) {
            // 终极防红字熔断：无论如何绝不允许向原生 React 抛出 order-guard 异常，
            // 否则 React tG 的 catch(e) 会调用 setLoadError(String(e)) 卸载整个聊天窗口并渲染全屏红字！
            const isSyncReq = /[?&]sync=1(?:&|$)/.test(String(requestUrl || ""));
            const emptyPayload = isSyncReq
              ? {
                  protocol: 1,
                  mode: "reset",
                  revision: null,
                  data: {
                    sessionId: targetSessionId,
                    snapshotRevision: null,
                    context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false },
                  },
                }
              : {
                  sessionId: targetSessionId,
                  snapshotRevision: null,
                  context: { messages: [], entryIds: [], oldestEntryId: null, hasMore: false },
                };
            response = createCachedResponse(emptyPayload, {}, "FALLBACK_ORDER_GUARD_CIRCUIT_BREAKER");
          }
        }
      }

      if (!response) {
        throw historyErr;
      }
    }

    if (
      response?.ok &&
      isHistoryGet &&
      targetSessionId &&
      !requestUrl.includes("/context") &&
      /[?&]sync=1(?:&|$)/.test(requestUrl) &&
      isPluginEnabled("session-memory-cache")
    ) {
      try {
        const cloned = typeof response.clone === "function" ? response.clone() : null;
        if (cloned) {
          cloned.json().then((rawPayload) => {
            try {
              let fullData = null;
              if (rawPayload && rawPayload.protocol === 1) {
                if (rawPayload.mode === "reset" && rawPayload.data?.context?.messages) {
                  fullData = {
                    ...rawPayload.data,
                    snapshotRevision: rawPayload.revision || rawPayload.data.snapshotRevision || null,
                  };
                } else {
                  const wireBase =
                    (typeof globalThis !== "undefined" && globalThis.__piSessionWireBaselines instanceof Map
                      ? globalThis.__piSessionWireBaselines.get(targetSessionId)
                      : null) ||
                    (typeof window !== "undefined" && window.__piSessionWireBaselines instanceof Map
                      ? window.__piSessionWireBaselines.get(targetSessionId)
                      : null);
                  if (wireBase?.data?.context?.messages) {
                    fullData = wireBase.data;
                  } else if (rawPayload.mode === "delta" && rawPayload.data?.context?.entryIds) {
                    const extracted = extractOrderGuardMessagesAndEntryIds(rawPayload, targetSessionId);
                    if (extracted.messages.length === rawPayload.data.context.entryIds.length) {
                      fullData = {
                        ...rawPayload.data,
                        snapshotRevision: rawPayload.revision || null,
                        context: {
                          ...rawPayload.data.context,
                          messages: extracted.messages,
                          entryIds: extracted.entryIds,
                        },
                      };
                    }
                  }
                }
              } else if (rawPayload?.context?.messages) {
                fullData = rawPayload;
              }
              if (fullData && isSnapshotComplete(fullData)) {
                const memEntry = getOrCreateSessionEntry(targetSessionId);
                const now = Date.now();
                const stamped = withSessionCacheTimestamp(fullData, now);
                const canonicalUrl = `/api/sessions/${encodeURIComponent(targetSessionId)}?deferThinking=1&deferMedia=1&tail=1000`;
                commitSessionDetailSnapshot(targetSessionId, memEntry, canonicalUrl, stamped, now);
                recordSessionModelMetadataFromPayload(targetSessionId, stamped);
              }
            } catch (_) {}
          }).catch(() => {});
        }
      } catch (_) {}
    }

    if (response?.ok && requestMethod === "POST" && /\/api\/agent\/new(?:[?#]|$)/.test(requestUrl) && pendingNewComposerMode) {
      const created = await response.clone().json().catch(() => null);
      if (created?.sessionId && pendingNewComposerMode.project === getCurrentProjectStatusKey()) {
        const createdEngine = created.sessionId.startsWith("codex:") ? "codex" : "pi";
        const stagedEngine = pendingNewComposerMode.engine || "pi";
        if (createdEngine === stagedEngine) pendingNewComposerMode.sessionId = created.sessionId;
        else pendingNewComposerMode = null;
      }
    }
    // Keep native GET/poll state authoritative, including changes from another browser.
    if (response?.ok && requestMethod === "GET" && /\/api\/agent\/[^/?#]+(?:[?#]|$)/.test(requestUrl)) {
      const state = await response.clone().json().catch(() => null);
      const parsedMode = parseExtensionStatus(state?.state || state, "composer-modes");
      if (parsedMode?.version === 1 && ["normal", "plan", "goal"].includes(parsedMode.mode)) {
        const sessionId = extractSessionIdFromUrl(requestUrl);
        const commitModeState = window.__PI_ENH_COMMIT_COMPOSER_MODE_STATE__;
        if (sessionId && typeof commitModeState === "function") commitModeState(sessionId, parsedMode);
      }
    }

    // 捕获会话列表以维护全量会话索引、剔除已删除会话并提供新鲜度感知
    if (response?.ok && requestMethod === "GET" && /\/api\/sessions(?:\?.*)?$/.test(requestUrl) && !requestUrl.includes("/search") && !requestUrl.includes("/context")) {
      try {
        const rawJson = await response.clone().json();
        if (typeof rawJson?.sessionListVersion === "number") {
          lastKnownSessionListPayload.sessionListVersion = rawJson.sessionListVersion;
        }
        if (Array.isArray(rawJson?.runningSessionIds)) {
          lastKnownSessionListPayload.runningSessionIds = rawJson.runningSessionIds;
        }
        if (Array.isArray(rawJson?.completionNotificationSuppressedSessionIds)) {
          lastKnownSessionListPayload.completionNotificationSuppressedSessionIds =
            rawJson.completionNotificationSuppressedSessionIds;
        }
        if (Array.isArray(rawJson?.sessions)) {
          let hasDeleted = false;
          const cleanSessions = [];
          for (const s of rawJson.sessions) {
            if (s?.id && isSessionDeleted(s.id)) {
              hasDeleted = true;
              continue;
            }
            if (s?.id) {
              cleanSessions.push(s);
              const prev = knownSessionsMap.get(s.id);
              knownSessionsMap.set(s.id, s);
              const title = computeSessionTitle(s);
              knownSessionTitles.set(s.id, title);
              // 新鲜度感知：若服务端 modified 或 messageCount 发生变化，标记增量待同步（保留本地快照作为秒开与 sync=1 锚点基线）
              if (prev && ((s.modified && prev.modified !== s.modified) || (typeof s.messageCount === "number" && prev.messageCount !== s.messageCount))) {
                markSessionNeedsIncrementalSync(s.id);
                const activeSid = getActiveSessionId() || getCurrentSessionId();
                if (activeSid === s.id && !(typeof isChatSessionRunning === "function" && isChatSessionRunning(s.id))) {
                  scheduleTerminalSyncCheck(s.id, { reason: "catalog_modified", force: true });
                }
              }
            }
          }
          if (hasDeleted) {
            const patchedData = { ...rawJson, sessions: cleanSessions };
            response = createCachedResponse(patchedData, response.headers, "FILTERED_DELETED");
          }
        }
      } catch (e) {}
    }
    const url = typeof input === "string" ? input : input?.url || "";
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method === "POST") {
      const targetSessionId = extractSessionIdFromUrl(url);
      if (targetSessionId) {
        try {
          const bodyObj = typeof init?.body === "string" ? JSON.parse(init.body) : null;
          if (!bodyObj || bodyObj.type === "prompt" || !bodyObj.type || bodyObj.message) {
            handleSessionWakeupIfArchived(targetSessionId);
          }
        } catch {
          handleSessionWakeupIfArchived(targetSessionId);
        }
      }
    }
    // A successful server acknowledgement, not a click or dialog unmount.
    // Custom UI keystrokes remain pending until their server-side closed event.
    if (response?.ok && method === "POST" && /\/api\/agent\/[^/?#]+(?:[?#]|$)/.test(url) && isPluginEnabled("project-status-indicator")) {
      try {
        const command = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (command?.type === "extension_ui_response") {
          const result = await response.clone().json();
          if (result.success === true && !result.error) requestProjectStatusRefresh(true);
        }
      } catch { /* Preserve the original response and native error handling. */ }
    }
    // 捕获队列消息发送请求中的图片附件（基于实际成功网络响应，不依赖 DOM 事件或 blob 抓取）
    if (response?.ok && method === "POST" && /\/api\/agent\/[^/?#]+(?:[?#]|$)/.test(url)) {
      try {
        const ownerSessionId = extractSessionIdFromUrl(url);
        const reqBodyStr = await queueRequestBody;
        let reqBody = parsedQueueRequestBody;
        try {
          if (!reqBody && reqBodyStr) reqBody = JSON.parse(reqBodyStr);
        } catch (_) {}
        if (ownerSessionId && reqBody) {
          const type = String(reqBody.type || "");
          if (type === "navigate_tree" || type === "fork") {
            handleSessionHistoryOrderAction(ownerSessionId, type);
          }
          const behavior = String(reqBody.streamingBehavior || "");
          const isSteer = type === "steer" || (type === "prompt" && /steer/i.test(behavior));
          const isFollowUp = type === "follow_up" || type === "followup" || (type === "prompt" && /follow-?up/i.test(behavior));
          if (isSteer || isFollowUp) {
            const cloneResult = await response.clone().json();
            if (cloneResult && cloneResult.success === true && !cloneResult.error) {
              const kind = isSteer ? "steer" : "follow-up";
              const rawMsg = typeof reqBody.message === "string" ? reqBody.message : (reqBody.message?.content || "");
              const rawImgs = Array.isArray(reqBody.images) ? reqBody.images : [];
              if (typeof recordCapturedSubmissionAttachment === "function") {
                recordCapturedSubmissionAttachment(ownerSessionId, kind, rawMsg, rawImgs);
              }
            }
          }
        }
      } catch (_) { /* Preserve original response */ }
    }
    if (response?.ok && method === "GET" && sessionId === getCurrentSessionId() &&
        extractSessionIdFromUrl(url) === sessionId && /\/context\?/.test(url) &&
        /[?&]before=/.test(url) && !/[?&]metricsOnly=/.test(url)) {
      response = await deduplicateHistoryPage(url, response);
      // Capture after the network wait, before React consumes/prepends the page.
      armHistoryScrollRestore();
    }
    return response;
  }

  async function isAgentGetToolsRequest(input, init, method, urlStr, targetSessionId) {
    if (method !== "POST" || !targetSessionId) return false;
    const agentMatch = urlStr.match(/\/api\/agent\/([^/?#]+)(?:\/)?(?:[?#]|$)/);
    if (!agentMatch) return false;
    const matchedId = decodeURIComponent(agentMatch[1]);
    if (!matchedId || matchedId !== targetSessionId) return false;

    let rawBody = init && init.body !== undefined ? init.body : undefined;
    if (rawBody === undefined && input && typeof input === "object") {
      if (typeof input.clone === "function" && !input.bodyUsed) {
        try {
          const cloned = input.clone();
          rawBody = await cloned.text();
        } catch (_) {
          return false;
        }
      } else if (typeof input.body === "string") {
        rawBody = input.body;
      }
    }

    if (rawBody && typeof rawBody !== "string" && typeof rawBody.text === "function") {
      try {
        rawBody = await rawBody.text();
      } catch (_) {
        return false;
      }
    } else if (rawBody && typeof rawBody === "object" && (rawBody instanceof ArrayBuffer || ArrayBuffer.isView(rawBody))) {
      try {
        rawBody = new TextDecoder().decode(rawBody);
      } catch (_) {
        return false;
      }
    }

    const READ_ONLY_AGENT_COMMAND_TYPES = new Set([
      "get_tools",
      "get_state",
      "get_commands",
      "get_available_models",
      "get_queued_message",
      "get_queue_actions",
    ]);

    if (typeof rawBody === "string") {
      try {
        const parsed = JSON.parse(rawBody);
        return Boolean(parsed && typeof parsed === "object" && READ_ONLY_AGENT_COMMAND_TYPES.has(parsed.type));
      } catch (_) {
        return false;
      }
    }

    if (rawBody && typeof rawBody === "object" && !(typeof Blob !== "undefined" && rawBody instanceof Blob) && !(rawBody instanceof ArrayBuffer)) {
      return READ_ONLY_AGENT_COMMAND_TYPES.has(rawBody.type);
    }

    return false;
  }

  function readSessionRunningState(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    if (payload.error) {
      return null;
    }

    // 1. 优先 nested state 明确布尔 isStreaming / isPromptRunning / isBashRunning 的 OR
    // /api/sessions/:id/state 接口规范：rpc?.isAlive() 返回 { running: true, state: await rpc.send(get_state) }
    // 此时顶层 running: true 仅代表 RPC 进程存活，不能作为任务正在运行的依据；
    // 当 state 内明确提供布尔字段时，全 false 表示 idle，即便外层 running: true
    const stateObj = payload.state;
    if (stateObj && typeof stateObj === "object" && !Array.isArray(stateObj)) {
      const isStreamingBool = typeof stateObj.isStreaming === "boolean";
      const isPromptBool = typeof stateObj.isPromptRunning === "boolean";
      const isBashBool = typeof stateObj.isBashRunning === "boolean";
      const isCompactingBool = typeof stateObj.isCompacting === "boolean";

      if (isStreamingBool || isPromptBool || isBashBool || isCompactingBool) {
        return Boolean(
          (isStreamingBool && stateObj.isStreaming) ||
          (isPromptBool && stateObj.isPromptRunning) ||
          (isBashBool && stateObj.isBashRunning) ||
          (isCompactingBool && stateObj.isCompacting)
        );
      }
    }

    // 2. 支持 agent GET 顶层明确任务布尔状态字段 (isStreaming / isPromptRunning / isBashRunning / isCompacting)
    const topStreamingBool = typeof payload.isStreaming === "boolean";
    const topPromptBool = typeof payload.isPromptRunning === "boolean";
    const topBashBool = typeof payload.isBashRunning === "boolean";
    const topCompactingBool = typeof payload.isCompacting === "boolean";
    if (topStreamingBool || topPromptBool || topBashBool || topCompactingBool) {
      return Boolean(
        (topStreamingBool && payload.isStreaming) ||
        (topPromptBool && payload.isPromptRunning) ||
        (topBashBool && payload.isBashRunning) ||
        (topCompactingBool && payload.isCompacting)
      );
    }

    // 3. 只有外层 running: false 可作为未连/未运行证据；running: true 单独不当任务运行，字段缺失或 error 返回 null
    if (typeof payload.running === "boolean") {
      if (payload.running === false) {
        return false;
      }
      return null;
    }

    return null;
  }

  async function cachedSessionFetch(input, init) {
    const activeFetch = baseFetch || originalWindowFetch || (typeof fetch === "function" ? fetch : null);
    if (!activeFetch) return Promise.reject(new Error("fetch unavailable"));

    const method = (
      (init && typeof init.method === "string" ? init.method : null) ||
      (input && typeof input === "object" && typeof input.method === "string" ? input.method : null) ||
      "GET"
    ).toUpperCase();
    const urlStr = typeof input === "string" ? input : input?.url ? input.url : String(input);
    // HEAD is a read-only validator, never an Agent command or cache mutation.
    if (method === "HEAD") return activeFetch(input, init);
    // Native sync envelopes and current-identity lookups must bypass all history caches.
    if (method === "GET" && /\/api\/sessions\/[^/?#]+\?(?:[^#]*&)?(?:sync|lookup)=1(?=[&#]|$)/.test(urlStr)) {
      return activeFetch(input, init);
    }
    // Interaction queues and prompt receipts belong to the live server.
    // A receipt must never be replaced by an idle Agent state envelope.
    if (method === "GET" && /\/api\/agent\/[^/?#]+\?(?:[^#]*&)?(?:interactions=1|requestId=[^&#]+)(?=[&#]|$)/.test(urlStr)) {
      return activeFetch(input, init);
    }

    // 场景 0: 拦截外部文件/UNC路径请求，由本地桥接服务兜底读取，彻底解决 Access denied
    if (method === "GET" && urlStr.includes("/api/files/")) {
      const fileResp = await handleObsidianFileFetch(input, init, urlStr, activeFetch);
      if (fileResp) return fileResp;
    }

    // 附件清理与会话删除状态保全是独立核心职责，不能因会话缓存插件被关闭而失效。
    if (!isPluginEnabled("session-memory-cache")) {
      const targetSessionId = method === "DELETE" ? extractSessionIdFromUrl(urlStr) : null;
      let deleteMarked = false;
      if (targetSessionId) {
        try {
          markSessionAsDeleted(targetSessionId);
          deleteMarked = true;
          await ensureSessionIngestedBeforeDelete(targetSessionId);
        } catch (ensureErr) {
          if (deleteMarked) restoreSessionDeleteState(targetSessionId);
          throw ensureErr;
        }
      }
      let response = null;
      try {
        response = await activeFetch.apply(this, arguments);
      } catch (fetchErr) {
        if (targetSessionId) {
          restoreSessionDeleteState(targetSessionId);
        }
        throw fetchErr;
      }
      if (method === "DELETE") {
        if (response && (response.ok || response.status === 200 || response.status === 204 || response.status === 404)) {
          if (targetSessionId) {
            markSessionDeleteConfirmed(targetSessionId);
            cleanupDeletedSessionEverywhere(targetSessionId);
          }
          scheduleSessionUploadCleanup(urlStr, response);
        } else if (targetSessionId) {
          restoreSessionDeleteState(targetSessionId);
        }
      }
      return response;
    }

    const isAgentOrStateGet = method === "GET" && (urlStr.includes("/api/agent/") || urlStr.endsWith("/state") || urlStr.includes("/state?"));
    if (method === "GET" && (init?.cache || input?.cache) === "no-store" && !isPrimarySessionDetailUrl(urlStr) && !isAgentOrStateGet) {
      return activeFetch.apply(this, arguments);
    }

    if (method !== "GET") {
      const targetSessionId = extractSessionIdFromUrl(urlStr);
      let deleteMarked = false;
      if (targetSessionId) {
        if (method === "DELETE") {
          try {
            markSessionAsDeleted(targetSessionId);
            deleteMarked = true;
            await ensureSessionIngestedBeforeDelete(targetSessionId);
          } catch (ensureErr) {
            if (deleteMarked) restoreSessionDeleteState(targetSessionId);
            throw ensureErr;
          }
        } else {
          // 仅精确针对 POST /api/agent/:id 的已核验只读命令与中止/停止命令豁免失效与升级，保留透传不缓存工具响应
          const isReadOnlyGetTools = await isAgentGetToolsRequest(input, init, method, urlStr, targetSessionId);
          const isAbortCmd = (typeof isPluginEnabled === "function" ? isPluginEnabled("stop-fast-response") : true)
            ? await resolveAgentAbortType(input, init)
            : null;
          if (!isReadOnlyGetTools && !isAbortCmd) {
            const lazyEs = dormantSessionEventSources.get(targetSessionId);
            if (lazyEs && typeof lazyEs.upgradeToReal === "function") {
              try { await lazyEs.upgradeToReal(); } catch (_) {}
            }
            markSessionRunning(targetSessionId, true, { skipPreload: true, explicit: true });
            void invalidateSessionCache(targetSessionId);
          }
        }
      }
      let response = null;
      try {
        response = await activeFetch.apply(this, arguments);
      } catch (fetchErr) {
        if (method === "DELETE" && targetSessionId) {
          restoreSessionDeleteState(targetSessionId);
        }
        throw fetchErr;
      }
      if (method === "DELETE") {
        if (response && (response.ok || response.status === 200 || response.status === 204 || response.status === 404)) {
          if (targetSessionId) {
            markSessionDeleteConfirmed(targetSessionId);
            cleanupDeletedSessionEverywhere(targetSessionId);
          }
          scheduleSessionUploadCleanup(urlStr, response);
        } else if (targetSessionId) {
          restoreSessionDeleteState(targetSessionId);
        }
      }
      return response;
    }

    const sessionId = extractSessionIdFromUrl(urlStr);

    if (!sessionId) {
      return activeFetch.apply(this, arguments);
    }

    const entry = getOrCreateSessionEntry(sessionId);

    // 场景 0: /api/agent/:id 状态请求（绝不能当作会话详情缓存！）
    if (urlStr.includes("/api/agent/")) {
      // Runtime state is ephemeral: idle sessions can still own paused queues
      // and pending questions. Only the native service may report it empty.
      const reqGeneration = entry.runGeneration;
      const realResp = await activeFetch(input, { ...init, cache: "no-store" });
      if (realResp && (realResp.ok || realResp.status === 200)) {
        try {
          const clone = typeof realResp.clone === "function" ? realResp.clone() : realResp;
          clone.json().then(data => {
            if (reqGeneration !== entry.runGeneration) return;
            const runningState = readSessionRunningState(data);
            if (runningState === true) {
              markSessionRunning(sessionId, true);
            } else if (runningState === false) {
              markSessionRunning(sessionId, false, { settled: true });
            }
          }).catch(() => {});
        } catch (e) {}
      }
      return realResp;
    }

    // 场景 1: 不可变条目资源缓存（思考过程 / 媒体图片）
    const isThinkingOrMedia = urlStr.includes("/thinking") || urlStr.includes("/tool-result-image");
    if (isThinkingOrMedia) {
      const cached = entry.immutableAssets.get(urlStr);
      if (cached) {
        return createCachedResponse(cached.data);
      }
      const realResp = await activeFetch(input, { ...init, cache: "no-store" });
      if (realResp && (realResp.ok || realResp.status === 200)) {
        try {
          const clone = typeof realResp.clone === "function" ? realResp.clone() : realResp;
          const json = await clone.json();
          entry.immutableAssets.set(urlStr, { data: json, timestamp: Date.now() });
        } catch (e) {}
      }
      return realResp;
    }

    // 场景 2: 会话状态请求 (/api/sessions/:id/state)
    const isStateRequest = urlStr.endsWith("/state") || urlStr.includes("/state?");
    if (isStateRequest) {
      // Runtime state is ephemeral: idle sessions can still own paused queues
      // and pending questions. Only the native service may report it empty.
      const reqGeneration = entry.runGeneration;
      const realResp = await activeFetch(input, { ...init, cache: "no-store" });
      if (realResp && (realResp.ok || realResp.status === 200)) {
        try {
          const clone = typeof realResp.clone === "function" ? realResp.clone() : realResp;
          const json = await clone.json();
          if (reqGeneration === entry.runGeneration) {
            const runningState = readSessionRunningState(json);
            if (typeof runningState === "boolean") {
              entry.state = { data: json, timestamp: Date.now(), isRunning: runningState };
              if (runningState) {
                markSessionRunning(sessionId, true);
              } else {
                markSessionRunning(sessionId, false, { settled: true });
              }
            } else {
              // 仅在读到明确布尔运行态时采信；字段缺失、error 或未知 running:true 不能凭空标完成
              entry.state = { data: json, timestamp: Date.now() };
            }
          }
        } catch (e) {}
      }
      return realResp;
    }

    // metricsOnly 请求直接透传 activeFetch 响应，绝不破坏性投影剥离 model/content/stopReason/details，保证权威统计元数据完整
    if (/[?&]metricsOnly=1(?:&|$)/.test(urlStr)) {
      return activeFetch(input, { ...init, cache: "no-store" });
    }

    // 场景 3: 主会话详情与翻页上下文 (/api/sessions/:id 和 /context)
    // 关键规范：当会话缓存插件被禁用时，绝对不拦截原生会话详情与 context 请求，100% 透传原生网络行为
    if (!isPluginEnabled("session-memory-cache")) {
      return activeFetch.apply(this, arguments);
    }

    // 关键不变量：原生可见会话请求 tail=1000 不得截成 tail=80 后用原 URL 冒充完整快照；只后台预热允许 80
    // 原生页面发起的可见请求无论是否为当前激活会话，均严格保留原始 URL 与 tail 参数，确保尾长一致与快照权威完整
    const effectiveUrl = urlStr;
    const fetchInput = input;

    const isHistoricalPage = /[?&]before=/.test(urlStr);
    const bypassCache = Boolean(entry.forceBypassCache && !isHistoricalPage);

    const cachedDetail = !bypassCache ? findCompatibleSessionDetail(entry, urlStr) : null;
    const persistentDetail = !bypassCache && !cachedDetail && canUsePersistentSessionCache() && isPersistableSessionUrl(urlStr)
      ? await readPersistentSessionDetail(sessionId, urlStr)
      : null;
    const persistedTs = Number(persistentDetail?._cachedAt) > 0 ? Number(persistentDetail._cachedAt) : 0;
    const candidate = !bypassCache
      ? (cachedDetail || (persistentDetail ? { data: persistentDetail, timestamp: persistedTs, isPersistent: true } : null))
      : null;

    // ========================================================
    // 纯粹坚定的 Local-First 架构（用户要求：先从本地缓存读取秒开，再去后台核对指纹）
    // 只要本地存在完整有效的候选快照（内存或 PersistentStorage CacheStorage/IndexedDB）：
    // 1. 0 毫秒立即返回本地快照给 React 上屏渲染，杜绝任何白屏或 loading 等待；
    // 2. 将版本比对与增量同步 100% 移至后台静默执行 (Stale-While-Revalidate + Tail Sync)！
    // ========================================================
    if (candidate && candidate.data && isSnapshotComplete(candidate.data)) {
      entry.lastAccessed = Date.now();
      if (candidate.isPersistent) {
        commitSessionDetailSnapshot(sessionId, entry, urlStr, candidate.data, candidate.timestamp || 0);
        enforceSessionCacheLRU();
      }
      if (candidate.data) {
        recordSessionModelMetadataFromPayload(sessionId, candidate.data);
      }
      if (!isHistoricalPage && isWarmSessionSnapshotUrl(urlStr)) {
        const nowForReval = Date.now();
        const activeSidForReval = getActiveSessionId() || getCurrentSessionId();
        const isUrgentSync = Boolean(
          entry.needsFreshSync ||
          entry.hasPendingAgentEnd ||
          candidate.isPersistent ||
          isSessionCacheStale(sessionId, entry, urlStr, candidate)
        );
        const isSuppressedBySkipWindow = !isUrgentSync && Boolean(
          entry._skipNextRevalidationUntil && nowForReval < entry._skipNextRevalidationUntil
        );
        const isWithinCooldown = !isUrgentSync && Boolean(
          !candidate.isPersistent && nowForReval - (entry._lastRevalidatedAt || candidate.timestamp || 0) < 3000
        );

        if (entry._revalidating) {
          if (isUrgentSync) {
            entry._revalidationQueued = true;
          }
        } else if (isSuppressedBySkipWindow || isWithinCooldown) {
          if (entry._skipNextRevalidationUntil && nowForReval < entry._skipNextRevalidationUntil) {
            entry._skipNextRevalidationUntil = 0;
          }
        } else {
          entry._skipNextRevalidationUntil = 0;
          entry._revalidating = true;
          entry._revalidationQueued = false;
          const capturedPersistentCacheEpoch = persistentCacheEpoch;
          const capturedSessionEpoch = persistentSessionEpochs.get(sessionId) || 0;
          const capturedRevalEpoch = entry._revalidationEpoch || 0;
          const capturedEntry = entry;

          const isRevalidationValid = () => {
            if (isDisposed) return false;
            if (persistentCacheEpoch !== capturedPersistentCacheEpoch) return false;
            if ((persistentSessionEpochs.get(sessionId) || 0) !== capturedSessionEpoch) return false;
            if (sessionMemoryCache.get(sessionId) !== capturedEntry) return false;
            if (capturedEntry.forceBypassCache) return false;
            if ((capturedEntry._revalidationEpoch || 0) !== capturedRevalEpoch) return false;
            return true;
          };

          const runBackgroundRevalidation = async () => {
            try {
              if (!isRevalidationValid()) return;
              const currentSlot = findCompatibleSessionDetail(capturedEntry, urlStr) || capturedEntry.detailRequests.get(urlStr);
              const baseSnapshot = (currentSlot?.data && isSnapshotComplete(currentSlot.data)) ? currentSlot.data : candidate.data;
              const bgInit = { ...init, cache: "no-store" };
              const baseRev = typeof baseSnapshot?.snapshotRevision === "string" && baseSnapshot.snapshotRevision
                ? baseSnapshot.snapshotRevision
                : null;
              const anchors = buildSessionSyncAnchors(baseSnapshot);
              const revalInput = (baseRev || anchors.length)
                ? buildEnhancementSyncUrl(effectiveUrl, baseRev, anchors)
                : fetchInput;
              const bgResp = await activeFetch(revalInput, bgInit);
              if (!isRevalidationValid()) return;
              if (bgResp && (bgResp.ok || bgResp.status === 200)) {
                const rawJson = await bgResp.json();
                if (!isRevalidationValid()) return;
                let reconciled = reconcileEnhancementSyncPayload(baseSnapshot, rawJson);
                if (reconciled.action === "invalid_delta") {
                  const fallbackResp = await activeFetch(fetchInput, bgInit);
                  if (!isRevalidationValid()) return;
                  if (!fallbackResp || (!fallbackResp.ok && fallbackResp.status !== 200)) return;
                  const fallbackJson = await fallbackResp.json();
                  if (!isRevalidationValid()) return;
                  reconciled = reconcileEnhancementSyncPayload(baseSnapshot, fallbackJson);
                }
                if (reconciled.action === "unchanged") {
                  const doneNow = Date.now();
                  capturedEntry._lastRevalidatedAt = doneNow;
                  if (!capturedEntry.hasPendingAgentEnd) {
                    capturedEntry.needsFreshSync = false;
                  }
                  const unchangedBase = reconciled.data || baseSnapshot;
                  if (unchangedBase) {
                    const stampedUnchanged = withSessionCacheTimestamp(unchangedBase, doneNow);
                    commitSessionDetailSnapshot(sessionId, capturedEntry, urlStr, stampedUnchanged, doneNow);
                    void persistSessionDetail(sessionId, urlStr, stampedUnchanged);
                  }
                  return;
                }
                if (reconciled.action === "delta" || reconciled.action === "reset" || reconciled.action === "legacy") {
                  let freshData = reconciled.data;
                  const candidateMsgs = baseSnapshot?.context?.messages || [];
                  const freshMsgs = freshData?.context?.messages;
                  const isFreshEmpty = candidateMsgs.length > 0 && (!Array.isArray(freshMsgs) || freshMsgs.length === 0);
                  if (!freshData || isFreshEmpty || !isSnapshotComplete(freshData)) {
                    return;
                  }
                  const isExplicitDelta = reconciled.action === "delta" && (
                    Number(rawJson?.keepCount) < candidateMsgs.length ||
                    Number(rawJson?.dropCount) > 0 ||
                    (Array.isArray(rawJson?.tailMessages) && rawJson.tailMessages.length > 0)
                  );
                  const hasDiff = isExplicitDelta || hasSessionDataChanged(baseSnapshot, freshData);
                  if (!hasDiff && !freshData.snapshotRevision && baseSnapshot?.snapshotRevision) {
                    freshData = { ...freshData, snapshotRevision: baseSnapshot.snapshotRevision };
                  }
                  const now = Date.now();
                  capturedEntry._lastRevalidatedAt = now;
                  if (!capturedEntry.hasPendingAgentEnd) {
                    capturedEntry.needsFreshSync = false;
                  }
                  const stampedFresh = withSessionCacheTimestamp(freshData, now);
                  commitSessionDetailSnapshot(sessionId, capturedEntry, urlStr, stampedFresh, now);
                  recordSessionModelMetadataFromPayload(sessionId, stampedFresh);
                  capturedEntry.lastAccessed = now;
                  void persistSessionDetail(sessionId, urlStr, stampedFresh);
                  const currentActiveSid = getActiveSessionId() || getCurrentSessionId();
                  if (hasDiff && currentActiveSid === sessionId) {
                    entry._skipNextRevalidationUntil = Date.now() + 2000;
                    try {
                      if (typeof window.__PI_ENH_RELOAD_SPECIFIC_SESSION__ === "function") {
                        window.__PI_ENH_RELOAD_SPECIFIC_SESSION__(sessionId, false);
                      } else if (typeof window.__PI_WEB_RELOAD_SESSION__ === "function") {
                        window.__PI_WEB_RELOAD_SESSION__(sessionId, false, true);
                      } else if (typeof window.__PI_ENH_RELOAD_CURRENT_SESSION__ === "function") {
                        window.__PI_ENH_RELOAD_CURRENT_SESSION__(false);
                      }
                    } catch (e) {}
                  }
                }
              }
            } catch (err) {}
            finally {
              if (capturedEntry._revalidationQueued && isRevalidationValid()) {
                capturedEntry._revalidationQueued = false;
                scheduleSessionRevalidation(runBackgroundRevalidation, { immediate: true });
              } else {
                capturedEntry._revalidating = false;
                capturedEntry._revalidationQueued = false;
              }
            }
          };

          scheduleSessionRevalidation(runBackgroundRevalidation, {
            immediate: isUrgentSync || activeSidForReval === sessionId,
          });
        }
      }
      return createCachedResponse(candidate.data, {}, candidate.isPersistent ? "PERSISTENT" : "HIT");
    }

    // 仅在本地完全没有候选快照（全新冷会话）或用户显式要求强制绕过缓存时，才走以下网络拉取
    const isSimpleGet = isSimpleCoalesceableGet(input, init);
    const explicitCachePolicy = (init && typeof init.cache === "string") ? init.cache : "default";
    const coalesceKey = JSON.stringify([urlStr, explicitCachePolicy]);
    const canCoalesceCold = !bypassCache && !isHistoricalPage && isWarmSessionSnapshotUrl(urlStr) && !urlStr.includes("/context") && isSimpleGet;
    if (canCoalesceCold && inFlightSessionDetailRequests.has(coalesceKey)) {
      try {
        const sharedJson = await inFlightSessionDetailRequests.get(coalesceKey);
        if (sharedJson) return createCachedResponse(sharedJson, {}, "COALESCED");
      } catch (_) {}
    }
    const liveInit = { ...init, cache: "no-store" };
    let resolveColdFlight = null;
    let coldFlightPromise = null;
    if (canCoalesceCold) {
      coldFlightPromise = new Promise((r) => { resolveColdFlight = r; });
      inFlightSessionDetailRequests.set(coalesceKey, coldFlightPromise);
    }
    let realResp = null;
    try {
      realResp = await activeFetch(fetchInput, liveInit);
      if (realResp && (realResp.ok || realResp.status === 200)) {
        try {
          const clone = typeof realResp.clone === "function" ? realResp.clone() : realResp;
          const rawJson = await clone.json();
          const json = rawJson;
          const oldData = entry.detailRequests.get(urlStr)?.data;
          const oldMsgs = oldData?.context?.messages;
          const newMsgs = json?.context?.messages;
          const isFreshEmpty = Array.isArray(oldMsgs) && oldMsgs.length > 0 && Array.isArray(newMsgs) && newMsgs.length === 0;
          if (!isFreshEmpty && isSnapshotComplete(json)) {
            const now = Date.now();
            const stampedJson = withSessionCacheTimestamp(json, now);
            entry.forceBypassCache = false;
            if (!entry.hasPendingAgentEnd) {
              entry.needsFreshSync = false;
            }
            commitSessionDetailSnapshot(sessionId, entry, urlStr, stampedJson, now);
            entry._lastRevalidatedAt = now;
            recordSessionModelMetadataFromPayload(sessionId, stampedJson);
            entry.lastAccessed = now;
            enforceSessionCacheLRU();
            void persistSessionDetail(sessionId, urlStr, stampedJson);
            if (resolveColdFlight) { resolveColdFlight(stampedJson); resolveColdFlight = null; }
            return createCachedResponse(stampedJson, realResp.headers, "LIVE_WINDOW");
          }
        } catch (e) {}
      }
    } finally {
      entry.forceBypassCache = false;
      if (resolveColdFlight) resolveColdFlight(null);
      if (canCoalesceCold && inFlightSessionDetailRequests.get(coalesceKey) === coldFlightPromise) {
        inFlightSessionDetailRequests.delete(coalesceKey);
      }
    }

    return realResp;
  }

  function navigateSessionWithoutRsc(nextUrl) {
    if (!isPluginEnabled("session-memory-cache")) return false;
    try {
      const urlStr = typeof nextUrl === "string" ? nextUrl : nextUrl?.id ? `?session=${encodeURIComponent(nextUrl.id)}` : String(nextUrl || "");
      const finalUrl = urlStr && !urlStr.startsWith("?") && !urlStr.startsWith("/") ? `?session=${encodeURIComponent(urlStr)}` : urlStr;
      window.history.replaceState(window.history.state || null, "", finalUrl);
      return true;
    } catch (e) {
      return false;
    }
  }

  if (typeof window !== "undefined") {
    window.fetch = interceptedFetch;
    window.__PI_ENH_IS_SESSION_INGESTED__ = isSessionIngested;
    window.__PI_ENH_ENSURE_SESSION_INGESTED__ = ensureSessionIngestedBeforeDelete;
    window.__PI_ENH_CLEAR_SESSION_CACHE__ = clearSessionCaches;
    window.__PI_ENH_INVALIDATE_SESSION_CACHE__ = invalidateSessionCache;
    window.__PI_ENH_MARK_SESSION_RUNNING__ = markSessionRunning;
    window.__PI_ENH_IS_SESSION_TERMINALLY_SETTLED__ = isSessionTerminallySettled;
    window.__PI_ENH_MARK_SESSION_SETTLED__ = markSessionSettled;
    window.__PI_ENH_GET_SESSION_CACHE_STATS__ = getSessionCacheStats;
    window.__PI_ENH_GET_SESSION_CACHE_LIMIT__ = getSessionMemoryCacheLimit;
    window.__PI_ENH_SET_SESSION_CACHE_LIMIT__ = setSessionMemoryCacheLimit;
    window.__PI_ENH_PRELOAD_COMPLETED_SESSION__ = preloadCompletedSession;
    window.__PI_ENH_IS_SESSION_PROTECTED__ = isSessionProtectedFromEviction;
    window.__PI_ENH_SESSION_MEMORY_NAV__ = navigateSessionWithoutRsc;
    window.__PI_ENH_SET_BASE_FETCH__ = (fn) => { baseFetch = fn; };
    window.__PI_ENH_KNOWN_SESSIONS__ = knownSessionsMap;
    window.__PI_ENH_INSPECT_SESSION_CACHE_ENTRY__ = (sessionId) => sessionMemoryCache.get(sessionId);
    window.__PI_ENH_SCHEDULE_PRIORITY_PRELOAD__ = schedulePrioritySessionPreloads;
    window.__PI_ENH_GET_SESSION_PRELOAD_PRIORITY__ = getSessionPreloadPriority;

    function reloadSpecificSession(sessionId, notify = true) {
      if (!sessionId) return false;
      const entry = getOrCreateSessionEntry(sessionId);
      if (notify && entry) {
        entry.forceBypassCache = true;
        entry.needsFreshSync = true;
        entry._revalidationEpoch = (entry._revalidationEpoch || 0) + 1;
        entry._revalidating = false;
        entry._revalidationQueued = false;
        entry._lastRevalidatedAt = 0;
        entry._skipNextRevalidationUntil = 0;
        entry.detailRequests.clear();
        entry.lastAccessed = 0;
        if (entry.completedAt) entry.completedAt = 0;
        void invalidateSessionCache(sessionId);
        void invalidatePersistentSession(sessionId);
        clearSessionHistoryOrderState(sessionId);
      }

      if (notify && typeof showToast === "function") {
        showToast("正在从磁盘重新加载最新记录...", sessionArchiveIcon);
      }

      // 优先调用原生 React 挂载的权威会话重载接口（无 DOM 依赖，100% 直通核心状态更新）
      if (typeof window.__PI_WEB_RELOAD_SESSION__ === "function") {
        try {
          return window.__PI_WEB_RELOAD_SESSION__(sessionId, Boolean(notify), true);
        } catch (e) {}
      }

      const currentItem = document.querySelector(
        `[data-pi-enh-session-id="${sessionId}"], [data-session-id="${sessionId}"], a[href*="session=${sessionId}"]`
      );
      if (currentItem) {
        currentItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      } else {
        window.dispatchEvent(new CustomEvent("pi-enh:session-reload", { detail: { sessionId } }));
      }
      return true;
    }

    function reloadCurrentSession(notify = true) {
      const sessionId = getActiveSessionId() || getCurrentSessionId();
      if (sessionId) {
        return reloadSpecificSession(sessionId, notify);
      }
      if (typeof window.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__ === "function") {
        try {
          return window.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__(Boolean(notify));
        } catch (e) {}
      }
      return false;
    }

    window.__PI_ENH_RELOAD_CURRENT_SESSION__ = reloadCurrentSession;
    window.__PI_ENH_RELOAD_SPECIFIC_SESSION__ = reloadSpecificSession;

    // ========================================================
    // 权威终态核验与可见性恢复引擎 (Terminal Reconcile Engine)
    // 根治 agent_end 中间事件旧快照覆盖、后端未落盘即时同步造成的“最新轮消失”
    // ========================================================
    const activeTerminalReconcileTimers = new Map();
    const sessionReconcileGenerations = new Map();
    const terminalReconcileControllers = new Map();
    const foregroundReconcileSessions = new Set();
    const terminalReconcileStatus = new Map();
    let terminalReconcileSequence = 0; // 单调递增，切页/新一轮后旧网络响应绝不与新一轮编号碰撞
    const sessionTurnBaselines = new Map();
    const sessionExpectedTurnSignatures = new Map();
    const RECONCILE_INTERVALS = [120, 220, 350, 500, 750, 1000, 1300, 1600];

    function recordSessionTurnBaseline(sessionId) {
      if (!sessionId) return;
      const domState = getDomSessionTerminalSnapshot(sessionId);
      const entry = sessionMemoryCache?.get(sessionId);
      const baselineEntryId = domState?.lastEntryId || entry?.lastAuthoritativeEntryId || null;
      const baselineAssistantId = domState?.lastAssistantEntryId || null;
      const baselineTextSnippet = domState?.lastAssistantTextSnippet || "";
      const baselineEntryCount = domState?.entryCount || 0;
      sessionTurnBaselines.set(sessionId, {
        baselineEntryId,
        baselineAssistantId,
        baselineTextSnippet,
        baselineEntryCount,
        timestamp: Date.now()
      });
      sessionExpectedTurnSignatures.delete(sessionId);
    }

    function recordSessionTurnMessageEnd(sessionId, data) {
      if (!sessionId || !data?.message) return;
      const msg = data.message;
      if (msg.role !== "assistant") return;
      let text = "";
      if (Array.isArray(msg.content)) {
        text = msg.content
          .filter(b => b.type === "text")
          .map(b => b.text || "")
          .join("")
          .trim();
      } else if (typeof msg.text === "string") {
        text = msg.text.trim();
      }
      sessionExpectedTurnSignatures.set(sessionId, {
        expectedMessageId: msg.id || null,
        expectedSnippet: text.slice(0, 60),
        stopReason: msg.stopReason || null,
        timestamp: Date.now()
      });
    }

    function clearTerminalReconcileTimers(sessionId) {
      if (sessionId) foregroundReconcileSessions.delete(sessionId);
      else foregroundReconcileSessions.clear();
      for (const [id, controller] of terminalReconcileControllers) {
        if (!sessionId || id === sessionId) {
          controller.abort();
          terminalReconcileControllers.delete(id);
        }
      }
      if (sessionId) {
        const timer = activeTerminalReconcileTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        activeTerminalReconcileTimers.delete(sessionId);
        sessionReconcileGenerations.delete(sessionId);
        sessionTurnBaselines.delete(sessionId);
        sessionExpectedTurnSignatures.delete(sessionId);
      } else {
        for (const timer of activeTerminalReconcileTimers.values()) {
          clearTimeout(timer);
        }
        activeTerminalReconcileTimers.clear();
        sessionReconcileGenerations.clear();
        sessionTurnBaselines.clear();
        sessionExpectedTurnSignatures.clear();
      }
    }

    function getDomSessionTerminalSnapshot(sessionId) {
      const scroll = getChatScrollContainer() || document.querySelector(".chat-content");
      if (!scroll) return null;
      const entryNodes = Array.from(scroll.querySelectorAll("[data-entry-id]"));
      const entryIds = entryNodes.map(n => n.getAttribute("data-entry-id")).filter(Boolean);
      const lastEntryNode = entryNodes.at(-1);
      const lastEntryId = lastEntryNode?.getAttribute("data-entry-id") || null;

      const assistantNodes = Array.from(scroll.querySelectorAll('div[data-message-role="assistant"]'));
      const lastAssistantNode = assistantNodes.at(-1);
      const lastAssistantEntryId = lastAssistantNode?.getAttribute("data-entry-id") ||
        lastAssistantNode?.closest?.("[data-entry-id]")?.getAttribute("data-entry-id") || null;
      const fullAssistantText = (lastAssistantNode?.textContent || "").trim();
      const textNode = lastAssistantNode?.querySelector?.('[data-message-text="true"], .markdown-body');
      const textSnippet = (textNode?.textContent || fullAssistantText).trim().slice(0, 200);

      return {
        entryCount: entryIds.length,
        entryIds: new Set(entryIds),
        lastEntryId,
        lastAssistantEntryId,
        lastAssistantTextSnippet: textSnippet,
        // A grouped assistant node can include long commentary before its final answer.
        fullAssistantText,
      };
    }

    function parseAuthoritativeTerminalInfo(data) {
      if (!data) return null;
      const messages = Array.isArray(data?.context?.messages) ? data.context.messages : [];
      const entryIds = Array.isArray(data?.context?.entryIds) && data.context.entryIds.length > 0
        ? data.context.entryIds.filter(Boolean)
        : messages.map(m => m.id).filter(Boolean);
      const leafId = data?.leafId || null;

      const lastServerAssistant = [...messages].reverse().find(m => m.role === "assistant");
      let assistantText = "";
      if (Array.isArray(lastServerAssistant?.content)) {
        assistantText = lastServerAssistant.content
          .filter(b => b.type === "text")
          .map(b => b.text || "")
          .join("")
          .trim()
          .slice(0, 120);
      }
      const assistantIndex = messages.lastIndexOf(lastServerAssistant);
      // SDK messages generally have no id; context.entryIds is the positional identity contract.
      const lastAssistantId = entryIds[assistantIndex] || lastServerAssistant?.id || null;
      const lastRenderable = messages.findLastIndex(m => m.role === "user" || m.role === "assistant");
      // Tool results/custom extension notices may not have independent rendered chat nodes.
      const lastServerEntryId = entryIds[lastRenderable] || lastAssistantId || null;

      return {
        messageCount: messages.length,
        messages,
        entryIds,
        lastServerEntryId,
        lastAssistantId,
        lastAssistantText: assistantText,
        leafId,
        isComplete: isSnapshotComplete(data),
      };
    }

    function evaluateTerminalSessionStatus(domState, serverInfo, options = {}) {
      if (!domState || !serverInfo) return { action: "retry", reason: "missing_state" };

      const {
        hasPendingAgentEnd = false,
        turnBaseline = null,
        expectedSignature = null,
        attemptIndex = 0,
        maxAttempts = 8,
      } = options;

      const serverLastInDom = serverInfo.lastServerEntryId
        ? domState.entryIds.has(serverInfo.lastServerEntryId)
        : Boolean(serverInfo.lastAssistantId && domState.entryIds.has(serverInfo.lastAssistantId));
      const cleanText = (str) => String(str || "").replace(/[#*_`\s]/g, "");
      const cleanServer = cleanText(serverInfo.lastAssistantText);
      const cleanDom = cleanText(domState?.fullAssistantText || domState?.lastAssistantTextSnippet);
      const textMatches = !cleanServer || !cleanDom ||
        cleanDom.includes(cleanServer.slice(0, 15)) ||
        cleanServer.includes(cleanDom.slice(0, 15));

      const domLastInServerIndex = domState.lastEntryId ? serverInfo.entryIds.indexOf(domState.lastEntryId) : -1;
      const domAssistantInServerIndex = domState.lastAssistantEntryId ? serverInfo.entryIds.indexOf(domState.lastAssistantEntryId) : -1;
      const serverTerminalIndex = serverInfo.entryIds.indexOf(serverInfo.lastServerEntryId);

      // 1. 服务端严格新于当前 UI（UI 停留在旧轮次，服务端已落盘新轮次）
      const isServerStrictlyNewer = (
        (!serverLastInDom && domLastInServerIndex !== -1 && domLastInServerIndex < serverTerminalIndex) ||
        (!serverLastInDom && domAssistantInServerIndex !== -1 && domAssistantInServerIndex < serverTerminalIndex) ||
        // DOM 中的节点数会被虚拟列表截断，不能直接与服务器全量消息数比较。
        (!serverInfo.entryIds.length && !domState.entryIds.size && serverInfo.messageCount > domState.entryCount) ||
        (serverInfo.lastServerEntryId === domState.lastEntryId && !textMatches && Boolean(serverInfo.lastAssistantText && domState.lastAssistantTextSnippet))
      );

      if (isServerStrictlyNewer) {
        if (serverInfo.isComplete) {
          return { action: "reconcile", serverData: serverInfo, reason: "server_strictly_newer" };
        }
        return { action: "retry", reason: "server_newer_but_incomplete" };
      }

      // 2. DOM 领先于服务端（DOM 中已经有新条目更新，但服务端尚未落盘）
      // 绝不能把旧 serverData 写入缓存并当完成！
      const serverLastInDomIndex = serverInfo.lastServerEntryId ? Array.from(domState.entryIds).indexOf(serverInfo.lastServerEntryId) : -1;
      const isDomStrictlyNewer = (
        (serverLastInDomIndex !== -1 && serverLastInDomIndex < domState.entryIds.size - 1) ||
        (!serverInfo.entryIds.includes(domState.lastEntryId) && domState.entryCount > serverInfo.entryIds.length)
      );

      if (isDomStrictlyNewer) {
        return { action: "retry", reason: "dom_strictly_newer_waiting_server_flush" };
      }

      // 3. 服务端与 DOM 在条目上看起来一致（末尾 entry 相同或匹配）
      if (serverLastInDom && textMatches) {
        // 如果当前并不处于待落盘状态（没有 pendingAgentEnd）
        if (!hasPendingAgentEnd) {
          return { action: "settled", upToDate: true, reason: "matched_no_pending" };
        }

        // 当前有 pendingAgentEnd：必须区分“旧轮与旧 DOM 一致但本轮尚未落盘” vs “真正已呈现新轮”
        // 信号 A：SSE 本轮 message_end 期望签名
        if (expectedSignature && (expectedSignature.expectedMessageId || expectedSignature.expectedSnippet)) {
          const serverHasExpectedId = expectedSignature.expectedMessageId && (
            serverInfo.messages.some(m => m.id === expectedSignature.expectedMessageId) ||
            serverInfo.entryIds.includes(expectedSignature.expectedMessageId)
          );
          const serverHasExpectedText = expectedSignature.expectedSnippet && (
            serverInfo.lastAssistantText && serverInfo.lastAssistantText.includes(expectedSignature.expectedSnippet.slice(0, 30))
          );
          if (serverHasExpectedId || serverHasExpectedText) {
            return { action: "settled", upToDate: true, reason: "matched_expected_signature" };
          }
          // 服务端尚未包含本轮期望输出，必须重试等待落盘
          return { action: "retry", reason: "waiting_expected_signature_flush" };
        }

        // 信号 B：本轮 baseline 标记
        if (turnBaseline) {
          const hasAdvancedBeyondBaseline = (
            (serverInfo.lastServerEntryId && serverInfo.lastServerEntryId !== turnBaseline.baselineEntryId) ||
            (serverInfo.entryIds.length > turnBaseline.baselineEntryCount) ||
            (serverInfo.lastAssistantId && serverInfo.lastAssistantId !== turnBaseline.baselineAssistantId)
          );
          if (hasAdvancedBeyondBaseline) {
            return { action: "settled", upToDate: true, reason: "advanced_beyond_baseline" };
          }
          // 服务端依然停留在 baseline，说明尚未落盘新轮，必须重试等待落盘
          return { action: "retry", reason: "server_still_at_baseline" };
        }

        // 信号 C：缺信号（既无 expectedSignature 也无 baseline），保守继续有界轮询
        if (attemptIndex < maxAttempts - 1) {
          return { action: "retry", reason: "conservative_bounded_poll_waiting_flush" };
        }

        // No expected turn was observed: exhaustion is not evidence of a successful sync.
        return { action: "retry", reason: "exhausted_without_turn_evidence" };
      }

      return { action: "retry", reason: "fallback_retry" };
    }

    function isSessionReconcileActive() {
      return !isDisposed && (isPluginEnabled("session-history-integrity") || isPluginEnabled("session-memory-cache"));
    }

    function scheduleTerminalSessionReconcile(sessionId, options = {}) {
      if (!sessionId || !isSessionReconcileActive()) return;
      if (terminalReconcileStatus.get(sessionId)?.state === "native") return;
      const activeId = getActiveSessionId() || getCurrentSessionId();
      if (activeId !== sessionId) return;
      if (options.reason === "session_switch") {
        const swEntry = sessionMemoryCache?.get(sessionId);
        const swUrl = `/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=1&deferMedia=1&tail=1000`;
        if (swEntry && !swEntry.isRunning && !swEntry.needsFreshSync && !swEntry.hasPendingAgentEnd) {
          const swHit = findCompatibleSessionDetail(swEntry, swUrl);
          if (
            swHit?.data &&
            isSnapshotComplete(swHit.data) &&
            !isSessionCacheStale(sessionId, swEntry, swUrl, swHit) &&
            Date.now() - (swEntry._lastRevalidatedAt || swHit.timestamp || 0) < 3000
          ) {
            return;
          }
        }
      }

      // Coalesce focus/visibility/route signals; cancel an older session before its response commits.
      for (const id of sessionReconcileGenerations.keys()) {
        if (id !== sessionId) clearTerminalReconcileTimers(id);
      }
      const isForegroundCheck = Boolean(options.force || ["visibility", "focus", "pageshow", "session_switch"].includes(options.reason));
      // Coalescing must promote the existing job, not discard a foreground recovery signal.
      if (isForegroundCheck) foregroundReconcileSessions.add(sessionId);
      if (sessionReconcileGenerations.has(sessionId)) return;
      const currentGen = ++terminalReconcileSequence;
      sessionReconcileGenerations.set(sessionId, currentGen);
      terminalReconcileStatus.set(sessionId, { state: "checking", reason: options.reason || "terminal" });
      if (terminalReconcileStatus.size > 50) terminalReconcileStatus.delete(terminalReconcileStatus.keys().next().value);

      if (activeTerminalReconcileTimers.has(sessionId)) {
        clearTimeout(activeTerminalReconcileTimers.get(sessionId));
        activeTerminalReconcileTimers.delete(sessionId);
      }

      let pendingReactCommit = false;
      function attemptReconcile(attemptIndex) {
        if (sessionReconcileGenerations.get(sessionId) !== currentGen) return;
        if (!isSessionReconcileActive()) return;
        const currentActive = getActiveSessionId() || getCurrentSessionId();
        if (currentActive !== sessionId) return;
        const entry = sessionMemoryCache?.get(sessionId);
        if (options.reason === "session_switch" && entry && !entry.isRunning && !entry.needsFreshSync && !entry.hasPendingAgentEnd) {
          const swUrl = `/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=1&deferMedia=1&tail=1000`;
          const swHit = findCompatibleSessionDetail(entry, swUrl);
          if (
            swHit?.data &&
            isSnapshotComplete(swHit.data) &&
            !isSessionCacheStale(sessionId, entry, swUrl, swHit) &&
            Date.now() - (entry._lastRevalidatedAt || swHit.timestamp || 0) < 3000
          ) {
            clearTerminalReconcileTimers(sessionId);
            return;
          }
        }
        // 终态事件比可能滞后的项目状态/输入框按钮更权威；前台激活恢复或强制检查不受本地旧 running 阻断。
        if (!foregroundReconcileSessions.has(sessionId) && entry?.isRunning && !entry.hasPendingAgentEnd) {
          clearTerminalReconcileTimers(sessionId);
          return;
        }

        void runReconcileCheck(attemptIndex).catch(() => scheduleNext(attemptIndex + 1));
      }

      async function runReconcileCheck(attemptIndex) {
        // Native owns validation as well as preloading. Do not run the legacy
        // full-history probe beside a native mount or terminal/focus reload.
        if (window.__PI_WEB_SESSION_PRELOAD__ && typeof window.__PI_WEB_RELOAD_SESSION__ === "function") {
          clearTerminalReconcileTimers(sessionId);
          if (options.reason === "session_switch") {
            terminalReconcileStatus.delete(sessionId);
            return; // Mount already validates.
          }
          const status = { state: "native", reason: options.reason || "terminal" };
          terminalReconcileStatus.set(sessionId, status);
          try { await window.__PI_WEB_RELOAD_SESSION__(sessionId, false, true, { force: true }); }
          catch (_) { /* Native keeps readable history and owns bounded retries. */ }
          finally { if (terminalReconcileStatus.get(sessionId) === status) terminalReconcileStatus.delete(sessionId); }
          return;
        }
        const activeFetch = baseFetch || originalWindowFetch || (typeof window !== "undefined" && typeof window.fetch === "function" ? window.fetch : null);
        if (!activeFetch) return;

        const encodedId = encodeURIComponent(sessionId);
        const detailUrl1000 = `/api/sessions/${encodedId}?deferThinking=1&deferMedia=1&tail=1000`;
        const cachedEntry = sessionMemoryCache?.get(sessionId);
        const cachedCandidate = cachedEntry ? findCompatibleSessionDetail(cachedEntry, detailUrl1000) : null;
        const baseData = cachedCandidate?.data;
        const baseRev = (!cachedEntry?.hasPendingAgentEnd && !sessionTurnBaselines.has(sessionId) && typeof baseData?.snapshotRevision === "string" && baseData.snapshotRevision)
          ? baseData.snapshotRevision
          : null;
        const anchors = buildSessionSyncAnchors(baseData);
        const requestUrl = (baseRev || anchors.length) ? buildEnhancementSyncUrl(detailUrl1000, baseRev, anchors) : detailUrl1000;
        const controller = new AbortController();
        terminalReconcileControllers.set(sessionId, controller);
        const requestDeadline = setTimeout(() => controller.abort(), 8000);
        let resp = null;
        let serverData = null;
        try {
          resp = await activeFetch(requestUrl, { cache: "no-store", signal: controller.signal });
          if (resp?.ok) {
            const rawJson = await resp.json();
            if (baseRev || anchors.length) {
              const reconciled = reconcileEnhancementSyncPayload(baseData, rawJson);
              if (reconciled.action === "unchanged") {
                serverData = reconciled.data || baseData;
              } else if (reconciled.action === "delta" || reconciled.action === "reset" || reconciled.action === "legacy") {
                serverData = reconciled.data;
              } else if (reconciled.action === "invalid_delta") {
                const fallbackResp = await activeFetch(detailUrl1000, { cache: "no-store", signal: controller.signal });
                if (fallbackResp?.ok) serverData = await fallbackResp.json();
              }
            } else {
              serverData = rawJson;
            }
          }
        } catch (_) { /* Keep old UI; retry without declaring synchronization successful. */ }
        finally {
          clearTimeout(requestDeadline);
          if (terminalReconcileControllers.get(sessionId) === controller) terminalReconcileControllers.delete(sessionId);
        }
        if (sessionReconcileGenerations.get(sessionId) !== currentGen) return;
        if ((getActiveSessionId() || getCurrentSessionId()) !== sessionId) return;
        if (!isSessionReconcileActive()) return;
        if (!resp || !resp.ok) {
          scheduleNext(attemptIndex + 1);
          return;
        }

        if (!serverData) {
          scheduleNext(attemptIndex + 1);
          return;
        }
        if (sessionReconcileGenerations.get(sessionId) !== currentGen) return;
        if ((getActiveSessionId() || getCurrentSessionId()) !== sessionId) return;
        if (!isSessionReconcileActive()) return;

        const serverInfo = parseAuthoritativeTerminalInfo(serverData);
        const domState = getDomSessionTerminalSnapshot(sessionId);
        const entry = getOrCreateSessionEntry(sessionId);

        // Native React can show its error panel after an aborted reload (no chat DOM).
        // Once a newer snapshot was proven, retry that commit instead of waiting forever for missing DOM.
        const evaluation = pendingReactCommit && !domState?.entryIds?.size && serverInfo?.isComplete
          ? { action: "reconcile", reason: "retry_failed_react_commit" }
          : evaluateTerminalSessionStatus(domState, serverInfo, {
          hasPendingAgentEnd: Boolean(entry.hasPendingAgentEnd),
          turnBaseline: sessionTurnBaselines.get(sessionId) || null,
          expectedSignature: sessionExpectedTurnSignatures.get(sessionId) || null,
          attemptIndex,
          maxAttempts: RECONCILE_INTERVALS.length,
        });

        if (evaluation.action === "reconcile") {
          pendingReactCommit = true;
          // 后端权威数据已包含最新回复且落盘闭合，而 DOM 处于旧轮次（被旧快照覆盖或未更新）：
          // 立即更新缓存并触发原生无感 reload！
          const now = Date.now();
          const stampedServerData = withSessionCacheTimestamp(serverData, now);
          commitSessionDetailSnapshot(sessionId, entry, detailUrl1000, stampedServerData, now);
          entry._lastRevalidatedAt = now;
          entry._skipNextRevalidationUntil = now + 2000;
          void persistSessionDetail(sessionId, detailUrl1000, stampedServerData);
          // A complete history snapshot does not prove the agent is idle or React has committed it.
          entry.needsFreshSync = true;
          entry.lastAccessed = now;

          const reloadController = new AbortController();
          terminalReconcileControllers.set(sessionId, reloadController);
          sessionHistoryReloadSignals.set(sessionId, reloadController.signal);
          let onReloadAbort;
          const reloadAborted = new Promise(resolve => {
            onReloadAbort = resolve;
            reloadController.signal.addEventListener('abort', onReloadAbort, { once: true });
          });
          const reloadDeadline = setTimeout(() => reloadController.abort(), 8000);
          try {
            // Bound BOTH the history probe and React's subsequent history/state reads.
            // Merely timing out the await would leave a live old request able to commit later.
            let reloadPromise;
            if (typeof window.__PI_WEB_RELOAD_SESSION__ === "function") {
              reloadPromise = window.__PI_WEB_RELOAD_SESSION__(sessionId, false, true);
            } else if (typeof reloadCurrentSession === "function") {
              reloadPromise = reloadCurrentSession(false);
            }
            await Promise.race([Promise.resolve(reloadPromise).catch(() => {}), reloadAborted]);
          } catch (_) { /* Retry below if React has not actually rendered the latest turn. */ }
          finally {
            clearTimeout(reloadDeadline);
            reloadController.signal.removeEventListener('abort', onReloadAbort);
            if (sessionHistoryReloadSignals.get(sessionId) === reloadController.signal) sessionHistoryReloadSignals.delete(sessionId);
            if (terminalReconcileControllers.get(sessionId) === reloadController) terminalReconcileControllers.delete(sessionId);
          }

          if (sessionReconcileGenerations.get(sessionId) !== currentGen) return;
          if ((getActiveSessionId() || getCurrentSessionId()) !== sessionId) return;

          // 原生 reload 必须可等待并验证真实 DOM 权威呈现
          let domVerified = false;
          for (let frame = 0; frame < 5; frame++) {
            // Hidden tabs may suspend RAF indefinitely; a bounded timer keeps the sync lock releasable.
            await new Promise(resolve => {
              let frameId;
              const done = () => { clearTimeout(deadline); if (frameId) cancelAnimationFrame(frameId); resolve(); };
              const deadline = setTimeout(done, 100);
              if (typeof requestAnimationFrame === 'function') frameId = requestAnimationFrame(done);
            });
            if (sessionReconcileGenerations.get(sessionId) !== currentGen) return;
            const freshDom = getDomSessionTerminalSnapshot(sessionId);
            const domHasLastServer = Boolean(
              (serverInfo.lastServerEntryId && freshDom?.entryIds?.has(serverInfo.lastServerEntryId)) ||
              (serverInfo.lastAssistantId && freshDom?.entryIds?.has(serverInfo.lastAssistantId))
            );
            const cleanText = (str) => String(str || "").replace(/[#*_`\s]/g, "");
            const cleanServer = cleanText(serverInfo.lastAssistantText);
            const cleanDom = cleanText(freshDom?.fullAssistantText || freshDom?.lastAssistantTextSnippet);
            const domTextMatches = !cleanServer || !cleanDom ||
              cleanDom.includes(cleanServer.slice(0, 15)) ||
              cleanServer.includes(cleanDom.slice(0, 15));

            if (domHasLastServer && domTextMatches) {
              domVerified = true;
              break;
            }
          }

          if (domVerified) {
            entry.needsFreshSync = false;
            entry.hasPendingAgentEnd = false;
            terminalReconcileStatus.set(sessionId, { state: "verified", entryId: serverInfo.lastAssistantId || serverInfo.lastServerEntryId });
            clearHistorySyncWarning();
            void persistSessionDetail(sessionId, detailUrl1000, serverData);
            clearTerminalReconcileTimers(sessionId);
            return;
          }

          // DOM 尚未呈现新状态时继续有界重试
          scheduleNext(attemptIndex + 1);
          return;
        }

        if (evaluation.action === "settled") {
          // 当前 DOM 已经呈现最新回复，更新缓存状态，同数据绝不重复 reload！
          const now = Date.now();
          if (!serverData.snapshotRevision && baseData?.snapshotRevision && !hasSessionDataChanged(baseData, serverData)) {
            serverData = { ...serverData, snapshotRevision: baseData.snapshotRevision };
          }
          const stampedServerData = withSessionCacheTimestamp(serverData, now);
          commitSessionDetailSnapshot(sessionId, entry, detailUrl1000, stampedServerData, now);
          entry._lastRevalidatedAt = now;
          entry.needsFreshSync = false;
          entry.hasPendingAgentEnd = false;
          entry.lastAccessed = now;
          sessionTurnBaselines.delete(sessionId);
          sessionExpectedTurnSignatures.delete(sessionId);
          if (serverInfo.isComplete) {
            void persistSessionDetail(sessionId, detailUrl1000, stampedServerData);
          }
          terminalReconcileStatus.set(sessionId, { state: "verified", entryId: serverInfo.lastAssistantId || serverInfo.lastServerEntryId });
          clearHistorySyncWarning();
          clearTerminalReconcileTimers(sessionId);
          return;
        }

        // 3. action === "retry": 若尚未落盘或未包含新轮，继续有界条件轮询
        scheduleNext(attemptIndex + 1);
      }

      function scheduleNext(nextIndex) {
        if (sessionReconcileGenerations.get(sessionId) !== currentGen || !isSessionReconcileActive()) return;
        if ((getActiveSessionId() || getCurrentSessionId()) !== sessionId) {
          clearTerminalReconcileTimers(sessionId);
          return;
        }
        if (nextIndex >= RECONCILE_INTERVALS.length) {
          const entry = getOrCreateSessionEntry(sessionId);
          entry.needsFreshSync = true;
          terminalReconcileStatus.set(sessionId, { state: "unverified", reason: "retry_exhausted" });
          showHistorySyncWarning(sessionId);
          clearTerminalReconcileTimers(sessionId);
          return;
        }
        const delay = RECONCILE_INTERVALS[nextIndex];
        const timer = setTimeout(() => {
          attemptReconcile(nextIndex);
        }, delay);
        activeTerminalReconcileTimers.set(sessionId, timer);
      }

      // 启动第 0 次检查：session_switch 留出 300ms 供 React 完成本地缓存首帧挂载，避免 0ms 读到空 DOM 误触发二次重载
      const initialDelay = options.reason === "session_switch" ? 300 : (isForegroundCheck ? 0 : RECONCILE_INTERVALS[0]);
      const timer = setTimeout(() => attemptReconcile(0), initialDelay);
      activeTerminalReconcileTimers.set(sessionId, timer);
    }

    window.__PI_ENH_TERMINAL_SYNC_STATUS__ = (sessionId, debug = false) => {
      const status = terminalReconcileStatus.get(sessionId) || null;
      return !debug ? status : { ...status, generation: sessionReconcileGenerations.get(sessionId),
        timer: activeTerminalReconcileTimers.has(sessionId), request: terminalReconcileControllers.has(sessionId),
        enabled: isSessionReconcileActive(), disposed: isDisposed, activeSession: getActiveSessionId() || getCurrentSessionId() };
    };
    activeCleanups.push(() => {
      clearTerminalReconcileTimers();
      terminalReconcileStatus.clear();
      delete window.__PI_ENH_TERMINAL_SYNC_STATUS__;
      delete window.__PI_ENH_SCHEDULE_TERMINAL_SYNC__;
    });
    window.__PI_ENH_SCHEDULE_TERMINAL_SYNC__ = scheduleTerminalSessionReconcile;
    window.__PI_ENH_CLEAR_TERMINAL_RECONCILE_TIMERS__ = clearTerminalReconcileTimers;
    window.__PI_ENH_RECONCILE_TERMINAL_SESSION__ = scheduleTerminalSessionReconcile;
    window.__PI_ENH_TERMINAL_SYNC_CHECK__ = scheduleTerminalSessionReconcile;
    window.__PI_ENH_EVALUATE_TERMINAL_SESSION_STATUS__ = evaluateTerminalSessionStatus;
    window.__PI_ENH_RECORD_TURN_BASELINE__ = recordSessionTurnBaseline;
    window.__PI_ENH_RECORD_TURN_MESSAGE_END__ = recordSessionTurnMessageEnd;
    window.__PI_ENH_SESSION_TURN_BASELINES__ = sessionTurnBaselines;
    window.__PI_ENH_EXPECTED_TURN_SIGNATURES__ = sessionExpectedTurnSignatures;

    function verifySessionStreamSettled(sessionId, eventType) {
      if (!sessionId) return;
      const entry = getOrCreateSessionEntry(sessionId);
      const reqGeneration = entry.runGeneration;
      const activeFetch = baseFetch || originalWindowFetch || (typeof window !== "undefined" && typeof window.fetch === "function" ? window.fetch : null);
      if (!activeFetch) return;

      activeFetch(`/api/agent/${encodeURIComponent(sessionId)}`, { cache: "no-store" })
        .then(async (resp) => {
          if (!resp || !resp.ok) return;
          const clone = typeof resp.clone === "function" ? resp.clone() : resp;
          const json = await clone.json();
          if (reqGeneration !== entry.runGeneration) return;

          const runningState = readSessionRunningState(json);
          if (runningState === false) {
            markSessionSettled(sessionId);
            markSessionRunning(sessionId, false, { settled: true });
            entry.isRunning = false;
            entry.completedAt = Date.now();
            entry.hasPendingAgentEnd = false;
            entry.hasPendingAttention = false;
            broadcastSessionUpdate(sessionId, new Date().toISOString(), "event");
            if (sessionId === getCurrentSessionId() || sessionId === getActiveSessionId()) {
              scheduleTerminalSessionReconcile(sessionId, { reason: eventType });
            } else {
              if (typeof schedulePrioritySessionPreloads === "function") {
                schedulePrioritySessionPreloads();
              }
            }
          } else if (runningState === true) {
            markSessionRunning(sessionId, true);
          }
        })
        .catch(() => {});
    }

    function handleSessionStreamEvent(sId, data) {
      if (!sId || !data) return;
      handleSessionHistoryOrderStreamEvent(sId, data);
      handleModelSpeedStreamEvent(sId, data);
      if (data?.type === "agent_start") {
        // 新一轮开始时明确废弃上一轮的异步校准，状态轮询本身不得做此清理。
        clearTerminalReconcileTimers(sId);
        const runningEntry = getOrCreateSessionEntry(sId);
        runningEntry.hasPendingAgentEnd = false;
        runningEntry.isSettled = false;
        runningEntry.settledAt = null;
        runningEntry.state = null;
        runningEntry.runGeneration = (runningEntry.runGeneration || 0) + 1;
        markSessionRunning(sId, true, { explicit: true, start: true });
        recordSessionTurnBaseline(sId);
        handleSessionWakeupIfArchived(sId);
        if (typeof schedulePrioritySessionPreloads === "function") {
          schedulePrioritySessionPreloads();
        }
      } else if (data?.type === "message_end") {
        recordSessionTurnMessageEnd(sId, data);
      } else if (data?.type === "connected") {
        // 普通切换也会收到空闲 connected，它不是任务完成事件。
        // 仅已知运行→空闲或明确失效时执行完成同步，避免每次切换清缓存并广播伪更新。
        if (data.isStreaming === false) {
          const previousEntry = sessionMemoryCache.get(sId);
          const requiresSync = previousEntry?.isRunning || previousEntry?.needsFreshSync || previousEntry?.hasPendingAgentEnd;
          markSessionRunning(sId, false);
          if (!requiresSync) {
            return;
          }
          const entry = getOrCreateSessionEntry(sId);
          entry.isRunning = false;
          entry.hasPendingAgentEnd = true;
          entry.completedAt = Date.now();
          markSessionNeedsIncrementalSync(sId);
          void invalidateSessionCache(sId);
          broadcastSessionUpdate(sId, new Date().toISOString(), "event");
          if (sId === getCurrentSessionId() || sId === getActiveSessionId()) {
            scheduleTerminalSessionReconcile(sId, { reason: "connected" });
          }
        } else {
          markSessionRunning(sId, true, { explicit: true });
        }
      } else if (data?.type === "agent_end") {
        // agent_end 仅视作中间事件，不抢先完成同步，不将 needsFreshSync 置 false，不立即 preload
        const entry = getOrCreateSessionEntry(sId);
        entry.hasPendingAgentEnd = true;
        entry.needsFreshSync = true;
        entry.lastAgentEndTime = Date.now();
        if (!sessionTurnBaselines.has(sId)) {
          recordSessionTurnBaseline(sId);
        }
        // 原生 React 在收到 agent_end 时会立即调用 tI(session)
        // 保持 needsFreshSync=true 确保原生 tI 绝不命中未更新的旧缓存
        // 同时若为当前活跃会话，启动后台权威校准保护
        if (sId === getCurrentSessionId() || sId === getActiveSessionId()) {
          scheduleTerminalSessionReconcile(sId, { reason: "agent_end" });
        }
      } else if (data?.type === "agent_settled" || data?.type === "prompt_done") {
        verifySessionStreamSettled(sId, data.type);
      } else if (data?.type === "tool_execution_end" && data.toolName === "ask_user" && data.toolCallId) {
        getOrCreateSessionEntry(sId).hasPendingAttention = false;
        resolveAskUserToolResult(sId, String(data.toolCallId));
      } else if (data?.type === "extension_ui_request") {
        const entry = getOrCreateSessionEntry(sId);
        if (["select", "confirm", "input", "editor", "custom"].includes(data.method)) {
          entry.hasPendingAttention = data.closed !== true;
          if (data.closed !== true && typeof schedulePrioritySessionPreloads === "function") {
            schedulePrioritySessionPreloads();
          }
        }
      } else if (data?.type === "extension_ui_response" || data?.type === "extension_ui_closed") {
        const entry = getOrCreateSessionEntry(sId);
        entry.hasPendingAttention = false;
      }
      if (["agent_start", "agent_end", "agent_settled", "prompt_done", "extension_ui_request", "extension_ui_response", "extension_ui_closed"].includes(data?.type)
        || (data?.type === "tool_execution_end" && data.toolName === "ask_user")) {
        requestProjectStatusRefresh(data?.type === "extension_ui_request" && data.closed === true);
        if (typeof schedulePrioritySessionPreloads === "function") {
          schedulePrioritySessionPreloads();
        }
      }
    }
    window.__PI_ENH_HANDLE_SESSION_STREAM_EVENT__ = handleSessionStreamEvent;

    // 全局 EventSource 联动，精准捕获会话生命周期（避免任何旧缓存抹除新消息）
    const OriginalEventSource = window.EventSource;
    if (typeof OriginalEventSource === "function" && !window.__PI_ENH_EVENT_SOURCE_WRAPPED__) {
      window.__PI_ENH_EVENT_SOURCE_WRAPPED__ = true;
      const managedEventSources = new Map();
      const EnhancedEventSource = function(url, options) {
        const urlStr = String(url || "");
        const sId = extractSessionIdFromUrl(urlStr);
        if (
          sId &&
          !sId.startsWith("codex:") &&
          urlStr.includes("/events") &&
          urlStr.includes("/api/agent/") &&
          isPluginEnabled("session-memory-cache") &&
          knownSessionsMap.has(sId) &&
          !sessionMemoryCache.get(sId)?.isRunning &&
          !(typeof isChatSessionRunning === "function" && isChatSessionRunning(sId))
        ) {
          // Codex 的共享执行端可由电脑启动任务，其只读 SSE 必须真实订阅。
          // 休眠 Pi 历史会话惰性 SSE 代理：浏览历史会话时不向服务端发起 /events 触发 startRpcSession 冷启动阻塞；
          // 当用户在该会话发送消息（POST /api/agent/:id）时自动升级连接真实 OriginalEventSource。
          const listeners = new Map();
          let realEs = null;
          let upgradePromise = null;
          const lazyEs = {
            url: urlStr,
            readyState: 1,
            onopen: null,
            onmessage: null,
            onerror: null,
            addEventListener(type, fn) {
              if (typeof fn !== "function") return;
              if (!listeners.has(type)) listeners.set(type, new Set());
              listeners.get(type).add(fn);
              if (realEs) realEs.addEventListener(type, fn);
            },
            removeEventListener(type, fn) {
              listeners.get(type)?.delete(fn);
              if (realEs) realEs.removeEventListener(type, fn);
            },
            close() {
              this.readyState = 2;
              if (dormantSessionEventSources.get(sId) === this) dormantSessionEventSources.delete(sId);
              if (realEs) {
                try { realEs.close(); } catch (_) {}
                realEs = null;
              }
            },
            upgradeToReal() {
              if (this.readyState === 2) return Promise.resolve(null);
              if (upgradePromise) return upgradePromise;
              upgradePromise = new Promise((resolve) => {
                try {
                  if (dormantSessionEventSources.get(sId) === this) dormantSessionEventSources.delete(sId);
                  realEs = new OriginalEventSource(url, options);
                  let settled = false;
                  const finish = () => { if (!settled) { settled = true; clearTimeout(t); resolve(realEs); } };
                  const t = setTimeout(finish, 3000);
                  for (const [type, set] of listeners.entries()) {
                    for (const fn of set) realEs.addEventListener(type, fn);
                  }
                  realEs.onopen = (ev) => { if (typeof this.onopen === "function") this.onopen(ev); };
                  realEs.onerror = (ev) => { finish(); if (typeof this.onerror === "function") this.onerror(ev); };
                  realEs.onmessage = (ev) => {
                    try {
                      const d = JSON.parse(ev.data);
                      handleSessionStreamEvent(sId, d);
                      if (d?.type === "connected") finish();
                    } catch (_) {}
                    if (typeof this.onmessage === "function") this.onmessage(ev);
                  };
                } catch (_) {
                  resolve(null);
                }
              });
              return upgradePromise;
            },
          };
          dormantSessionEventSources.set(sId, lazyEs);
          setTimeout(() => {
            if (lazyEs.readyState === 2 || realEs) return;
            const syntheticEvent = { data: JSON.stringify({ type: "connected", sessionId: sId, isStreaming: false }) };
            if (typeof lazyEs.onmessage === "function") {
              try { lazyEs.onmessage(syntheticEvent); } catch (_) {}
            }
            const msgListeners = listeners.get("message");
            if (msgListeners) {
              for (const fn of msgListeners) {
                try { fn(syntheticEvent); } catch (_) {}
              }
            }
          }, 0);
          return lazyEs;
        }
        const es = new OriginalEventSource(url, options);
        try {
          if (sId && urlStr.includes("/events")) {
            const messageHandler = (event) => {
              try {
                const data = JSON.parse(event.data);
                handleSessionStreamEvent(sId, data);
              } catch (e) {}
            };
            es.addEventListener("message", messageHandler);
            managedEventSources.set(es, messageHandler);
          }
        } catch (e) {}
        return es;
      };
      EnhancedEventSource.prototype = OriginalEventSource.prototype;
      for (const prop of Object.getOwnPropertyNames(OriginalEventSource)) {
        if (!(prop in EnhancedEventSource)) {
          try { EnhancedEventSource[prop] = OriginalEventSource[prop]; } catch (e) {}
        }
      }
      window.EventSource = EnhancedEventSource;
      activeCleanups.push(() => {
        clearTerminalReconcileTimers();
        for (const [eventSource, messageHandler] of managedEventSources) {
          try { eventSource.removeEventListener("message", messageHandler); } catch (e) {}
          // 严禁调用 eventSource.close()！该连接属于原生应用，强行关闭会导致客户端抛出 Connection closed 致命崩溃
        }
        managedEventSources.clear();
        if (typeof window !== "undefined" && window.EventSource === EnhancedEventSource) {
          window.EventSource = OriginalEventSource;
          delete window.__PI_ENH_EVENT_SOURCE_WRAPPED__;
        }
      });
    }

    // 侧边栏会话项悬停智能预热（Hover Preload）：在用户鼠标移入 80ms 后预拉取元数据与首屏上下文，
    // 彻底消除点击切换会话时的读盘等待，实现 0ms 纯瞬开。
    let hoverPreloadTimer = null;
    let lastHoveredPreloadId = null;

    addManagedListener(document, "mouseover", (event) => {
      if (!isPluginEnabled("session-memory-cache")) return;
      const target = event.target;
      const row = target?.closest?.(".pi-enh-session-row-host[data-pi-enh-session-id], [data-session-id]");
      const sessionId = row?.getAttribute?.("data-pi-enh-session-id") || row?.getAttribute?.("data-session-id");
      if (!sessionId || sessionId === getCurrentSessionId() || sessionId === lastHoveredPreloadId) return;

      lastHoveredPreloadId = sessionId;
      if (hoverPreloadTimer) clearTimeout(hoverPreloadTimer);
      hoverPreloadTimer = setTimeout(() => {
        if (
          lastHoveredPreloadId === sessionId &&
          sessionId !== getCurrentSessionId() &&
          sessionId !== getActiveSessionId() &&
          isPluginEnabled("session-memory-cache")
        ) {
          void preloadCompletedSession(sessionId, true);
        }
      }, 80);
    }, { passive: true });

    function isSessionActionControlTarget(target) {
      if (!target || typeof target.closest !== "function") return false;
      if (target.closest(
        ".pi-enh-session-overflow, " +
        ".pi-enh-session-pinned-indicator, " +
        ".pi-enh-native-session-actions, " +
        ".pi-enh-session-menu, " +
        ".pi-enh-menu, " +
        ".pi-enh-menu-item, " +
        "[data-session-action], " +
        "[data-action], " +
        ".pi-enh-session-batch-checkbox, " +
        ".pi-enh-session-tag-chip, " +
        ".pi-enh-session-tags-row, " +
        "[data-tag-action], " +
        ".pi-enh-search-restore-btn, " +
        ".pi-enh-settings-modal, " +
        "input, textarea, select"
      )) {
        return true;
      }
      const row = target.closest(".pi-enh-session-row-host");
      if (row) {
        const btn = target.closest("button, [role='button']");
        if (btn && row.contains(btn)) {
          return true;
        }
      }
      return false;
    }
    window.__PI_ENH_IS_SESSION_ACTION_CONTROL__ = isSessionActionControlTarget;

    addManagedListener(document, "click", (event) => {
      if (!isPluginEnabled("session-memory-cache") || isSessionActionControlTarget(event.target)) return;
      const row = event.target?.closest?.("[data-pi-enh-session-id], [data-session-id]");
      const id = row?.getAttribute("data-pi-enh-session-id") || row?.getAttribute("data-session-id");
      if (!id || id === getCurrentSessionId()) return;
      window.__PI_WEB_SESSION_PRELOAD__?.preload?.(id, {
        priority: "foreground", score: 2000, cachePriority: "active",
      });
    }, { capture: true, passive: true });
  }

  // ==========================================
  // 跨端与多标签页会话秒级同步 (Cross-Device Session Sync)
  // ==========================================
  crossDeviceSyncChannel = null;
  let lastAutoReloadTime = 0;

  function initCrossDeviceSessionSync() {
    if (typeof BroadcastChannel === "function" && !crossDeviceSyncChannel) {
      try {
        crossDeviceSyncChannel = new BroadcastChannel("pi-web-session-sync-v1");
        crossDeviceSyncChannel.onmessage = (event) => {
          if (!isPluginEnabled("cross-device-session-sync")) return;
          const data = event.data;
          if (!data) return;
          if (data.type === "pinned_sessions_updated" && Array.isArray(data.pinnedIds)) {
            const nextSet = new Set(data.pinnedIds);
            writeStoredSessionIds(PINNED_SESSION_STORAGE_KEY, nextSet);
            if (data.revision) setLocalPinnedRevision(data.revision);
            requestSessionListRefresh();
            syncSessionPinArchiveControls();
            return;
          }
          if (data.type === "archived_sessions_updated" && Array.isArray(data.archivedEntries)) {
            const remoteRev = Number(data.revision) || 0;
            const localRev = getLocalArchivedRevision();
            if (remoteRev >= localRev) {
              let entriesToApply = data.archivedEntries;
              if (typeof recentlyRestoredArchivedSessionIds !== "undefined" && recentlyRestoredArchivedSessionIds.size > 0) {
                entriesToApply = entriesToApply.filter((e) => !recentlyRestoredArchivedSessionIds.has(e?.id || e));
              }
              writeStoredArchivedEntries(entriesToApply);
              if (remoteRev > 0) setLocalArchivedRevision(remoteRev);
              window.__PI_ENH_ARCHIVED_MANIFEST__ = entriesToApply;
              requestSessionListRefresh();
              const panel = document.querySelector(".pi-enh-archived-panel");
              const nav = document.querySelector(".settings-section-tabs");
              if (panel && panel.style.display !== "none") {
                renderArchivedPanel(panel, nav);
              }
            }
            return;
          }
          if (data.type === "quick_shortcuts_updated" && Array.isArray(data.shortcuts)) {
            if (typeof setStoredQuickShortcuts === "function") {
              setStoredQuickShortcuts(data.shortcuts, false);
            }
            if (data.revision && typeof setLocalShortcutsRevision === "function") {
              setLocalShortcutsRevision(data.revision);
            }
            if (typeof syncBottomShortcutsBar === "function") {
              syncBottomShortcutsBar(true);
            }
            const nav = document.querySelector(".settings-section-tabs");
            if (nav && typeof syncTabShortcutsInSettings === "function") {
              syncTabShortcutsInSettings(nav);
            }
            return;
          }
          if (data.type === "session_read_status_updated" && data.sessionId) {
            const sid = data.sessionId;
            if (!data.unread) {
              recordSessionReadWatermark(sid, data.meta || null);
              if (typeof markProjectCompletionRead === "function") {
                markProjectCompletionRead(sid);
              }
              const ids = readUnreadSessionIds();
              if (ids.has(sid)) {
                ids.delete(sid);
                writeUnreadSessionIds(ids);
              }
              if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
                try { window.__PI_ENH_SET_UNREAD_SESSION__(sid, false); } catch (e) {}
              }
              if (typeof projectStatusModel !== "undefined" && projectStatusModel.setUnread) {
                try { projectStatusModel.setUnread(Array.from(ids)); } catch (e) {}
              }
              if (typeof syncProjectStatusIndicators === "function") {
                syncProjectStatusIndicators();
              }
            } else {
              recordSessionManualUnread(sid);
              if (typeof markProjectCompletionUnread === "function") {
                markProjectCompletionUnread(sid);
              }
              const ids = readUnreadSessionIds();
              if (!ids.has(sid)) {
                ids.add(sid);
                writeUnreadSessionIds(ids);
              }
              if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
                try { window.__PI_ENH_SET_UNREAD_SESSION__(sid, true); } catch (e) {}
              }
              if (typeof projectStatusModel !== "undefined" && projectStatusModel.setUnread) {
                try { projectStatusModel.setUnread(Array.from(ids)); } catch (e) {}
              }
              if (typeof syncProjectStatusIndicators === "function") {
                syncProjectStatusIndicators();
              }
            }
            return;
          }
          if (data.sessionId) {
            handleRemoteSessionUpdate(data.sessionId, data.modified, data.source);
          }
        };
      } catch (e) {}
    }
  }

  function broadcastSessionUpdate(sessionId, modified, source = "local") {
    if (!isPluginEnabled("cross-device-session-sync") || !sessionId) return;
    try {
      crossDeviceSyncChannel?.postMessage({
        type: "session_updated",
        sessionId,
        modified: modified || new Date().toISOString(),
        source,
        at: Date.now(),
      });
    } catch (e) {}
  }

  function handleRemoteSessionUpdate(sessionId, modified, source) {
    if (!sessionId) return;
    markSessionNeedsIncrementalSync(sessionId);
    const activeId = getActiveSessionId() || getCurrentSessionId();
    if (activeId === sessionId) {
      if (typeof isChatSessionRunning === "function" && isChatSessionRunning(sessionId)) return;
      const now = Date.now();
      if (now - lastAutoReloadTime < 500) return;
      lastAutoReloadTime = now;
      if (typeof scheduleTerminalSyncCheck === "function") {
        scheduleTerminalSyncCheck(sessionId, { reason: "remote_update", force: true });
      }
      if (typeof window.__PI_ENH_RELOAD_CURRENT_SESSION__ === "function") {
        try {
          window.__PI_ENH_RELOAD_CURRENT_SESSION__(false);
        } catch (e) {}
      }
    }
  }

  let lastRemotePinnedCheckTime = 0;
  function checkRemotePinnedFreshnessThrottle() {
    const now = Date.now();
    if (now - lastRemotePinnedCheckTime < 4000) return;
    lastRemotePinnedCheckTime = now;
    if (typeof syncManifestPinnedEntries === "function") {
      void syncManifestPinnedEntries(false);
    }
    if (typeof syncManifestQuickShortcuts === "function") {
      void syncManifestQuickShortcuts(false);
    }
    if (typeof syncManifestArchivedEntries === "function") {
      void syncManifestArchivedEntries(false);
    }
    if (typeof syncManifestSessionColors === "function") {
      void syncManifestSessionColors(false);
    }
    if (typeof syncManifestSessionTags === "function") {
      void syncManifestSessionTags(false);
    }
    if (typeof syncManifestReadWatermarks === "function") {
      void syncManifestReadWatermarks(false);
    }
  }

  function notifySessionCatalogFreshness(sessions) {
    if (!Array.isArray(sessions)) return;
    const activeId = getActiveSessionId() || getCurrentSessionId();
    for (const s of sessions) {
      if (!s?.id) continue;
      const prev = knownSessionsMap.get(s.id);
      knownSessionsMap.set(s.id, s);
      const title = computeSessionTitle(s);
      knownSessionTitles.set(s.id, title);
      if (prev && ((s.modified && prev.modified !== s.modified) || (typeof s.messageCount === "number" && prev.messageCount !== s.messageCount))) {
        markSessionNeedsIncrementalSync(s.id);
        broadcastSessionUpdate(s.id, s.modified, "poll");
        if (activeId === s.id && !(typeof isChatSessionRunning === "function" && isChatSessionRunning(s.id))) {
          handleRemoteSessionUpdate(s.id, s.modified, "poll");
        }
      }
    }
    checkRemotePinnedFreshnessThrottle();
  }

  function syncCrossDeviceSessionSync(enabled) {
    if (!enabled) {
      try { crossDeviceSyncChannel?.close(); } catch (e) {}
      crossDeviceSyncChannel = null;
    } else {
      initCrossDeviceSessionSync();
    }
  }

  initCrossDeviceSessionSync();
  if (typeof syncManifestReadWatermarks === "function") {
    void syncManifestReadWatermarks(false);
  }

  if (typeof window !== "undefined") {
    window.__PI_ENH_NOTIFY_SESSION_CATALOG__ = notifySessionCatalogFreshness;
    window.__PI_ENH_BROADCAST_SESSION_UPDATE__ = broadcastSessionUpdate;
    window.__PI_ENH_SYNC_CROSS_DEVICE_SYNC__ = syncCrossDeviceSessionSync;
    window.__PI_ENH_CLEAR_STOP_FEEDBACK__ = clearStopFeedback;
  }

  // 安全清理历史遗留的多端协同 DOM 节点（若存在）
  try {
    document.querySelector(".pi-enh-presence-badge")?.remove();
    document.querySelector(".pi-enh-presence-popover")?.remove();
  } catch (e) {}

  // 界面防红字黑屏自愈看门狗：一旦页面意外渲染出错误节点，自动自愈恢复
  if (typeof window !== "undefined") {
    addManagedInterval(() => {
      try {
        const errEl = document.querySelector(".chat-content-error, .text-red-400, div[class*='text-red']");
        if (errEl && errEl.textContent && (
          errEl.textContent.includes("[session-history-order-guard]") ||
          /failed to fetch|networkerror|load failed/i.test(errEl.textContent)
        )) {
          console.warn("[pi-enh] Detected stale error screen on DOM, triggering auto-heal...");
          errEl.style.display = "none";
          if (typeof window.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__ === "function") {
            window.__PI_WEB_NATIVE_RELOAD_CURRENT_SESSION__(false);
          } else if (typeof window.__PI_ENH_RELOAD_CURRENT_SESSION__ === "function") {
            window.__PI_ENH_RELOAD_CURRENT_SESSION__(false);
          }
        }
      } catch (_) {}
    }, 1500);

    // 会话加载长期卡死自愈看门狗 (Anti-Loading-Stuck Watchdog)
    // 专治大体积会话、高频SSE推送/版本并发冲突导致的“一直显示正在加载会话...”
    let lastStuckSessionId = null;
    let stuckDetectCount = 0;
    let lastHealTimestamp = 0;

    addManagedInterval(() => {
      try {
        const targetSessionId = getActiveSessionId() || getCurrentSessionId();
        if (!targetSessionId) {
          lastStuckSessionId = null;
          stuckDetectCount = 0;
          return;
        }

        const chatContent = document.querySelector(".chat-content");
        const loadingDiv = Array.from(document.querySelectorAll("div")).find(d =>
          d.children.length === 0 &&
          (d.textContent?.includes("正在加载会话") || d.textContent?.includes("Loading session") || d.textContent?.includes("正在載入工作階段"))
        );

        if (!chatContent && loadingDiv) {
          if (lastStuckSessionId === targetSessionId) {
            stuckDetectCount++;
          } else {
            lastStuckSessionId = targetSessionId;
            stuckDetectCount = 1;
          }

          // 连续检测到卡在 loading 态超过 2 次（约 1.6s ~ 2.4s）
          if (stuckDetectCount >= 2 && Date.now() - lastHealTimestamp > 1500) {
            lastHealTimestamp = Date.now();
            console.warn(`[pi-enh] Detected session loading stuck on "${targetSessionId}" for ${stuckDetectCount * 800}ms, triggering force healing...`);

            // 1. 最优先执行：直接触发原生权威重载，解除 loading 态死锁
            try {
              if (typeof window.__PI_WEB_RELOAD_SESSION__ === "function") {
                const p = window.__PI_WEB_RELOAD_SESSION__(targetSessionId, true, true, { force: true });
                if (p && typeof p.then === "function") {
                  p.then(() => {
                    console.log(`[pi-enh] Watchdog reload successfully resolved for ${targetSessionId}`);
                  }).catch((err) => {
                    console.warn(`[pi-enh] Watchdog reload promise rejected:`, err?.message || err);
                  });
                }
              } else if (typeof window.__PI_ENH_RELOAD_CURRENT_SESSION__ === "function") {
                window.__PI_ENH_RELOAD_CURRENT_SESSION__(true);
              }
            } catch (reloadErr) {
              console.error(`[pi-enh] Watchdog reload invocation error:`, reloadErr);
            }


          }
        } else {
          lastStuckSessionId = null;
          stuckDetectCount = 0;
        }
      } catch (_) {}
    }, 800);
  }

  // 页面首屏就绪后，平滑延迟 800ms 触发一次高优会话（running/completed/ask_user）优先级预加载
  if (typeof window !== "undefined") {
    setTimeout(() => {
      if (typeof schedulePrioritySessionPreloads === "function") {
        schedulePrioritySessionPreloads();
      }
    }, 800);
  }

  activeCleanups.push(() => {
    if (typeof window !== "undefined" && window.fetch === interceptedFetch) {
      window.fetch = originalWindowFetch;
    }
    clearSessionMemoryCache();
    syncCrossDeviceSessionSync(false);
  });
