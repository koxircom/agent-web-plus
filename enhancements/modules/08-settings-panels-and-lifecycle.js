  // ==========================================
  // 设置对话框原生托管与独立 Host 架构 (Native Owner & Isolated Extension Hosts)
  // ==========================================

  // 1. 独占 Maintenance Host 渲染（用于 General 维护/版本卡，不搬移原生 sections）
  function mountMaintenanceHost(host, context) {
    if (!host) return () => {};
    if (host.__piEnhMaintenanceMounted) return () => {};
    host.__piEnhMaintenanceMounted = true;

    // 清理既有内容
    host.innerHTML = "";

    // 卡片 1: 页面维护与服务管理
    const cacheSection = document.createElement("section");
    cacheSection.className = "settings-general-section pi-enh-cache-section";
    cacheSection.setAttribute("data-pi-enh-section", "maintenance");

    const heading = document.createElement("h3");
    heading.className = "settings-general-heading";
    heading.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #f59e0b;">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
      </svg>
      <span>页面维护与服务管理</span>
    `;

    const desc = document.createElement("div");
    desc.className = "settings-general-description";
    desc.textContent = "遇到手机端显示旧版本、界面未更新或 Service Worker 缓存异常时可清理缓存；如需重启 Agent Web Plus 服务，可在此手动一键重启。";

    const actionsRow = document.createElement("div");
    actionsRow.className = "pi-enh-service-actions-row";

    // 按钮 1：强制清除缓存刷新
    const btnReload = document.createElement("button");
    btnReload.type = "button";
    btnReload.className = "pi-enh-btn-sm pi-enh-force-reload-btn";
    btnReload.title = "穿透 HTTP 强缓存并更新前端静态资源与网页";
    btnReload.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
      </svg>
      <span>⚡ 强制清除缓存并刷新网页</span>
    `;
    btnReload.addEventListener("click", forceHardReloadApp);

    // 按钮 2：一键重启 Agent Web Plus
    const btnRestart = document.createElement("button");
    btnRestart.type = "button";
    btnRestart.className = "pi-enh-btn-sm pi-enh-restart-service-btn";
    btnRestart.title = "手动重启 Agent Web Plus 后台服务并在恢复后自动重新连接";
    btnRestart.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/>
        <path d="M21 3v5h-5"/>
        <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/>
        <path d="M3 21v-5h5"/>
      </svg>
      <span>⚡ 一键重启 Agent Web Plus</span>
    `;
    btnRestart.addEventListener("click", triggerManualRestartPiWebModal);

    actionsRow.appendChild(btnReload);
    actionsRow.appendChild(btnRestart);

    cacheSection.appendChild(heading);
    cacheSection.appendChild(desc);
    cacheSection.appendChild(actionsRow);
    host.appendChild(cacheSection);

    // 卡片 2: 系统版本与 Pi Agent 上游更新
    const versionSection = document.createElement("section");
    versionSection.className = "settings-general-section pi-enh-version-section";
    versionSection.setAttribute("data-pi-enh-section", "version-info");

    const vHeading = document.createElement("h3");
    vHeading.className = "settings-general-heading";
    vHeading.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #10b981;">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
      <span>系统版本与上游更新</span>
    `;

    const vDesc = document.createElement("div");
    vDesc.className = "settings-general-description";
    vDesc.textContent = "监控上游官方 Pi Coding Agent 发布动态。当有新版本时在新建会话页面与设置中自动提示。";

    const card = document.createElement("div");
    card.className = "pi-enh-version-card";
    card.style.cssText = "display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; background: var(--bg-surface, rgba(255,255,255,0.03)); border: 1px solid var(--border, rgba(255,255,255,0.08)); border-radius: 8px; margin-top: 8px; font-size: 12px;";

    const state = getPiAgentUpdateState();
    const suiteVer = (typeof window !== "undefined" && window.__PI_WEB_STANDALONE_VERSION__) || "1.0.5";
    const updateTag = state.updateAvailable
      ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:600;background:rgba(16,185,129,0.15);color:#10b981;border:1px solid rgba(16,185,129,0.4);"><span style="width:4px;height:4px;border-radius:50%;background:#10b981;"></span>可升级至 v${state.latestVersion}</span>`
      : (state.latestVersion ? `<span style="display:inline-flex;padding:1px 6px;border-radius:9999px;font-size:10px;color:var(--text-muted);background:rgba(255,255,255,0.05);">已是最新</span>` : `<span style="font-size:10px;color:var(--text-muted);">未检测</span>`);

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; line-height: 1.5;">
        <span style="color: var(--text-muted);">Web 前端发行版</span>
        <span style="font-family: var(--font-mono, monospace); font-weight: 600;">v${suiteVer} (Agent Web Plus Standalone)</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; line-height: 1.5;">
        <span style="color: var(--text-muted);">Pi Agent 本地核心</span>
        <span style="font-family: var(--font-mono, monospace); font-weight: 600;">v${state.currentVersion}</span>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; line-height: 1.5;">
        <span style="color: var(--text-muted);">官方上游最新版本</span>
        <div style="display: flex; align-items: center; gap: 6px; font-family: var(--font-mono, monospace);">
          <span>${state.latestVersion ? "v" + state.latestVersion : "检测中…"}</span>
          ${updateTag}
        </div>
      </div>
      <div style="display: flex; gap: 8px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border, rgba(255,255,255,0.06));">
        <a href="${state.releaseUrl || 'https://github.com/earendil-works/pi/releases'}" target="_blank" rel="noopener noreferrer" class="pi-enh-btn-sm" style="flex: 1; text-align: center; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/></svg>
          <span>查看 Release Notes</span>
        </a>
        <button type="button" class="pi-enh-btn-sm pi-enh-check-agent-update-btn" style="flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
          <span>${state.isChecking ? "正在检测…" : "立即检查更新"}</span>
        </button>
      </div>
    `;

    const btnCheck = card.querySelector(".pi-enh-check-agent-update-btn");
    if (btnCheck) {
      btnCheck.addEventListener("click", async () => {
        if (typeof window !== "undefined" && typeof window.__PI_ENH_CHECK_AGENT_UPDATE__ === "function") {
          btnCheck.disabled = true;
          btnCheck.innerHTML = "<span>⏳ 正在检测上游版本…</span>";
          try {
            await window.__PI_ENH_CHECK_AGENT_UPDATE__(true);
            if (typeof showToast === "function") {
              const st = window.__PI_AGENT_UPDATE_STATE__;
              if (st && st.updateAvailable) {
                showToast(`发现 Pi Agent 新版本 v${st.latestVersion}！`);
              } else if (st && st.latestVersion) {
                showToast(`Pi Agent 已是最新版本 (v${st.latestVersion})`);
              } else if (st && st.error) {
                showToast(`检测失败: ${st.error}`);
              }
            }
          } finally {
            btnCheck.disabled = false;
            btnCheck.innerHTML = `
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
              <span>立即检查更新</span>
            `;
          }
        }
      });
    }

    versionSection.appendChild(vHeading);
    versionSection.appendChild(vDesc);
    versionSection.appendChild(card);
    host.appendChild(versionSection);

    return () => {
      host.__piEnhMaintenanceMounted = false;
      host.innerHTML = "";
    };
  }

  const SECTION_SHORTCUT_METADATA = {
    general: { id: "settings", label: "常规", aliasId: "general" },
    settings: { id: "settings", label: "常规", aliasId: "general" },
    models: { id: "models", label: "模型" },
    skills: { id: "skills", label: "技能" },
    agents: { id: "agents", label: "子代理" },
    plugins: { id: "plugins", label: "插件" },
    enhancements: { id: "enhancements", label: "增强插件" },
    notifications: { id: "notifications", label: "通知管理" },
    archived: { id: "archived", label: "已归档" },
    usage: { id: "usage", label: "用量统计" },
    tags: { id: "tags", label: "会话标签" },
  };

  function getSectionShortcutMetadata(sectionId) {
    const predefined = SECTION_SHORTCUT_METADATA[sectionId];
    const label = predefined ? predefined.label : sectionId;
    const id = predefined ? predefined.id : sectionId;
    const iconHtml = SHORTCUT_ICONS[sectionId] || SHORTCUT_ICONS[id] || SHORTCUT_ICONS.settings || "";
    return { id, label, iconHtml };
  }

  // React owns tab events; the extension owns only shortcut state/persistence.
  function toggleSettingsTabShortcut(sectionId) {
    if (!isPluginEnabled("settings-tab-shortcuts")) return;
    const meta = getSectionShortcutMetadata(sectionId);
    const currentShortcuts = getStoredQuickShortcuts();
    const idx = currentShortcuts.findIndex((s) => s.id === sectionId || (sectionId === "general" && s.id === "settings") || (sectionId === "settings" && s.id === "general"));
    if (idx >= 0) {
      currentShortcuts.splice(idx, 1);
      setStoredQuickShortcuts(currentShortcuts);
      showToast(`已从快捷入口移除「${meta.label}」`, meta.iconHtml);
    } else {
      const newItem = { id: meta.id, label: meta.label, iconHtml: meta.iconHtml || "" };
      const settingsIdx = currentShortcuts.findIndex((s) => s.id === "settings" || s.id === "general");
      if (settingsIdx >= 0) currentShortcuts.splice(settingsIdx, 0, newItem);
      else currentShortcuts.push(newItem);
      setStoredQuickShortcuts(currentShortcuts);
      showToast(`已添加「${meta.label}」到左下角快捷入口`, meta.iconHtml);
    }
    syncBottomShortcutsBar(true);
  }

  // 3. Register isolated panels and native-owned tab actions.
  let nativeBridgeRegistered = false;
  let unregisterNativeRenderers = [];

  function onSettingsNativeReady() {
    initSettingsNativeBridge();
  }

  function initSettingsNativeBridge() {
    if (nativeBridgeRegistered) return;
    const abi = typeof window !== "undefined" ? window.__PI_WEB_SETTINGS_NATIVE__ : undefined;
    if (!abi || typeof abi.registerRenderer !== "function") return;
    nativeBridgeRegistered = true;

    unregisterNativeRenderers = [
      abi.registerRenderer("enhancements", (host, context) => {
        if (!host.classList.contains("pi-enh-plugins-panel")) host.classList.add("pi-enh-plugins-panel");
        renderEnhancementsPanel(host, context);
        return () => {
          host.classList.remove("pi-enh-plugins-panel");
          host.innerHTML = "";
        };
      }),
      abi.registerRenderer("notifications", (host, context) => {
        if (!host.classList.contains("pi-enh-notifications-panel")) host.classList.add("pi-enh-notifications-panel");
        renderNotificationPanel(host, context);
        return () => {
          host.classList.remove("pi-enh-notifications-panel");
          host.innerHTML = "";
        };
      }),
      abi.registerRenderer("archived", (host, context) => {
        if (!host.classList.contains("pi-enh-archived-panel")) host.classList.add("pi-enh-archived-panel");
        renderArchivedPanel(host, context);
        return () => {
          host.classList.remove("pi-enh-archived-panel");
          host.innerHTML = "";
        };
      }),
      abi.registerRenderer("usage", (host, context) => {
        if (!host.classList.contains("pi-enh-usage-panel")) host.classList.add("pi-enh-usage-panel");
        renderUsagePanel(host, context);
        return () => {
          window.PiUsagePanel?.dispose?.(host);
          host.classList.remove("pi-enh-usage-panel");
          host.innerHTML = "";
        };
      }),
      abi.registerRenderer("tags", (host, context) => {
        if (!host.classList.contains("pi-enh-tags-panel")) host.classList.add("pi-enh-tags-panel");
        if (typeof renderTagsPanel === "function") {
          renderTagsPanel(host, context);
        }
        return () => {
          host.classList.remove("pi-enh-tags-panel");
          host.innerHTML = "";
        };
      }),
      abi.registerRenderer("maintenance", (host, context) => {
        return mountMaintenanceHost(host, context);
      }),
    ];

    const allSections = ["general", "models", "skills", "agents", "plugins", "enhancements", "notifications", "archived", "usage", "tags"];
    for (const sec of allSections) {
      const unreg = abi.registerTabAction(sec, () => toggleSettingsTabShortcut(sec));
      if (typeof unreg === "function") {
        unregisterNativeRenderers.push(unreg);
      }
    }
  }

  function cleanupSettingsNativeBridge() {
    if (typeof window !== "undefined") {
      window.removeEventListener("pi-web:settings-native-ready", onSettingsNativeReady);
    }
    for (const unreg of unregisterNativeRenderers) {
      try { if (typeof unreg === "function") unreg(); } catch (_) {}
    }
    unregisterNativeRenderers = [];
    nativeBridgeRegistered = false;
  }

  // 4. 模块初始化：单次注册 Native 桥
  if (typeof window !== "undefined") {
    if (window.__PI_WEB_SETTINGS_NATIVE__) {
      initSettingsNativeBridge();
    } else {
      window.addEventListener("pi-web:settings-native-ready", onSettingsNativeReady, { once: true });
    }
  }

  // ==========================================
  // 6.1 Settings Tab Shortcuts & Bottom Bar (设置选项卡双击快捷入口与跨设备同步)
  // ==========================================
  const SHORTCUTS_STORAGE_KEY = "pi-web-quick-shortcuts";
  const SHORTCUTS_REVISION_STORAGE_KEY = "pi-web-quick-shortcuts-revision";
  const DEFAULT_SHORTCUTS = [
    { id: "enhancements", label: "增强插件" },
    { id: "archived", label: "已归档" },
    { id: "usage", label: "用量统计" },
    { id: "settings", label: "设置" },
  ];

  function getLocalShortcutsRevision() {
    try {
      return Number(localStorage.getItem(SHORTCUTS_REVISION_STORAGE_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setLocalShortcutsRevision(rev) {
    try {
      localStorage.setItem(SHORTCUTS_REVISION_STORAGE_KEY, String(rev));
    } catch (e) {}
  }

  isPersistingShortcutsToServer = false;
  pendingPersistShortcutsTimer = null;
  let pendingQuickShortcutsPersistRequest = null;

  async function persistQuickShortcutsToServer(list) {
    if (pendingPersistShortcutsTimer) {
      clearTimeout(pendingPersistShortcutsTimer);
      pendingPersistShortcutsTimer = null;
    }
    const revision = Math.max(Date.now(), getLocalShortcutsRevision() + 1);
    const snapshot = Array.isArray(list) ? list.map((item) => ({ ...item })) : list;
    setLocalShortcutsRevision(revision);

    // 1. 同设备跨标签页广播
    try {
      crossDeviceSyncChannel?.postMessage({
        type: "quick_shortcuts_updated",
        shortcuts: snapshot,
        revision: revision,
        at: Date.now()
      });
    } catch (e) {}

    // 同一短时间内的连续修改只保留最新快照；已开始的 PUT 完成后继续冲刷，不能因并发而丢弃。
    return new Promise((resolve) => {
      if (pendingQuickShortcutsPersistRequest) {
        pendingQuickShortcutsPersistRequest.resolve(false);
      }
      pendingQuickShortcutsPersistRequest = { list: snapshot, revision, resolve };

      const schedulePendingPersist = () => {
        if (pendingPersistShortcutsTimer) clearTimeout(pendingPersistShortcutsTimer);
        pendingPersistShortcutsTimer = setTimeout(async () => {
          pendingPersistShortcutsTimer = null;
          if (!pendingQuickShortcutsPersistRequest || isPersistingShortcutsToServer) return;

          const request = pendingQuickShortcutsPersistRequest;
          pendingQuickShortcutsPersistRequest = null;
          isPersistingShortcutsToServer = true;
          let saved = false;
          try {
            const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
            if (!activeFetch) return;

            const getResp = await activeFetch("/api/models-config", { cache: "no-store" });
            if (!getResp?.ok) return;
            const currentConfig = await getResp.json();
            if (!currentConfig || typeof currentConfig !== "object" || Array.isArray(currentConfig)) return;

            // 不允许迟到的旧快照覆盖服务端更新的快捷入口配置。
            if ((Number(currentConfig.shortcutsRevision) || 0) > request.revision) return;

            const putPayload = {
              ...currentConfig,
              quickShortcuts: request.list,
              shortcutsRevision: request.revision
            };

            const putResp = await activeFetch("/api/models-config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(putPayload)
            });

            if (putResp?.ok) {
              window.__PI_ENH_SHORTCUTS_MANIFEST__ = request.list;
              saved = true;
            }
          } catch (err) {
            saved = false;
          } finally {
            isPersistingShortcutsToServer = false;
            request.resolve(saved);
            if (pendingQuickShortcutsPersistRequest) schedulePendingPersist();
          }
        }, 150);
      };

      schedulePendingPersist();
    });
  }

  var activeShortcutsSyncPromise = null;
  async function syncManifestQuickShortcuts(force = false) {
    if (activeShortcutsSyncPromise) return activeShortcutsSyncPromise;
    activeShortcutsSyncPromise = (async () => {
      try {
        const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
        if (!activeFetch) return;

        let remoteList = null;
        let remoteRevision = 0;

        // 1. 优先从权威服务端配置 /api/models-config 拉取
        try {
          const resp = await activeFetch("/api/models-config", { cache: "no-store" });
          if (resp?.ok) {
            const data = await resp.json();
            if (Array.isArray(data?.quickShortcuts) && data.quickShortcuts.length > 0) {
              remoteList = data.quickShortcuts;
              remoteRevision = Number(data?.shortcutsRevision) || 0;
            }
          }
        } catch (e) {}

        // 2. 回退从静态资产清单 /pi-shortcuts-manifest.json 读取
        if (!remoteList || remoteList.length === 0) {
          try {
            const res = await activeFetch("/pi-shortcuts-manifest.json?v=" + Date.now(), { cache: "no-store" });
            if (res?.ok) {
              const json = await res.json();
              if (Array.isArray(json) && json.length > 0) {
                remoteList = json;
              }
            }
          } catch (e) {}
        }

        // 3. 兜底内置清单
        if (!remoteList || remoteList.length === 0) {
          if (Array.isArray(window.__PI_ENH_SHORTCUTS_MANIFEST__) && window.__PI_ENH_SHORTCUTS_MANIFEST__.length > 0) {
            remoteList = window.__PI_ENH_SHORTCUTS_MANIFEST__;
          }
        }

        if (!remoteList || remoteList.length === 0) return;

        // 规范化 label（确保“已归档会话”自动纠正为“已归档”）
        remoteList = remoteList.map(item =>
          item.id === "archived" && item.label === "已归档会话" ? { ...item, label: "已归档" } : item
        );

        const localRev = getLocalShortcutsRevision();
        const currentStored = getStoredQuickShortcuts();
        const isLocalEmpty = !localStorage.getItem(SHORTCUTS_STORAGE_KEY);

        // 检查本地与远端项是否完全相同
        const isListEqual = Array.isArray(currentStored) &&
          currentStored.length === remoteList.length &&
          currentStored.every((item, idx) => item.id === remoteList[idx].id && item.label === remoteList[idx].label);

        // 判定是否应当覆盖本地状态：
        // 1) 显式强制刷新
        // 2) 手机端或新浏览器首次访问（本地尚无快捷入口）
        // 3) 远端 revision 存在且严格大于本地 revision
        // 4) 本地无 revision 且内容与远端不一致
        const shouldApply = force || isLocalEmpty || (remoteRevision > 0 && remoteRevision > localRev) || (!localRev && !isListEqual);

        if (shouldApply) {
          if (!isListEqual) {
            setStoredQuickShortcuts(remoteList, false);
            if (remoteRevision > 0) setLocalShortcutsRevision(remoteRevision);
            window.__PI_ENH_SHORTCUTS_MANIFEST__ = remoteList;
            syncBottomShortcutsBar(true);
          } else if (remoteRevision > 0 && remoteRevision > localRev) {
            setLocalShortcutsRevision(remoteRevision);
          }
        }
      } catch (e) {
      } finally {
        activeShortcutsSyncPromise = null;
      }
    })();
    return activeShortcutsSyncPromise;
  }
  window.__PI_ENH_SYNC_MANIFEST_SHORTCUTS__ = syncManifestQuickShortcuts;

  const SHORTCUT_ICONS = {
    general: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7h-9M14 17H5"></path><circle cx="7" cy="7" r="3"></circle><circle cx="17" cy="17" r="3"></circle></svg>`,
    settings: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7h-9M14 17H5"></path><circle cx="7" cy="7" r="3"></circle><circle cx="17" cy="17" r="3"></circle></svg>`,
    models: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"></rect><rect x="9" y="9" width="6" height="6"></rect><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3"></path></svg>`,
    skills: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2-10 5 10 5 10-5-10-5Z"></path><path d="m2 12 10 5 10-5M2 17l10 5 10-5"></path></svg>`,
    agents: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="7" width="14" height="11" rx="2"></rect><path d="M9 11h.01M15 11h.01M9 15h6M12 7V4M10 4h4"></path></svg>`,
    plugins: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 7V2M15 7V2M6 13V8a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v5a6 6 0 0 1-12 0ZM12 19v3"></path></svg>`,
    enhancements: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"></path></svg>`,
    archived: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg>`,
    notifications: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><path d="M10 21h4"></path></svg>`,
    tags: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`
  };

  function getStoredQuickShortcuts() {
    try {
      const raw = localStorage.getItem(SHORTCUTS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // 检查是否为老旧默认格局 [models, skills, settings]
          const isLegacyDefault = parsed.length === 3 &&
            parsed.some((s) => s.id === "models") &&
            parsed.some((s) => s.id === "skills") &&
            parsed.some((s) => s.id === "settings") &&
            !parsed.some((s) => s.id === "enhancements" || s.id === "archived");
          if (!isLegacyDefault) {
            let modified = false;
            for (const item of parsed) {
              if (item.id === "archived" && item.label === "已归档会话") {
                item.label = "已归档";
                modified = true;
              }
            }
            if (modified) {
              try { localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(parsed)); } catch (e) {}
            }
            return parsed;
          }
        }
      }
    } catch (e) {}

    // 跨设备清单同步：优先使用服务端固化的清单
    if (Array.isArray(window.__PI_ENH_SHORTCUTS_MANIFEST__) && window.__PI_ENH_SHORTCUTS_MANIFEST__.length > 0) {
      const normalizedManifest = window.__PI_ENH_SHORTCUTS_MANIFEST__.map(item =>
        item.id === "archived" && item.label === "已归档会话" ? { ...item, label: "已归档" } : item
      );
      try {
        localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(normalizedManifest));
      } catch (e) {}
      return [...normalizedManifest];
    }

    return [...DEFAULT_SHORTCUTS];
  }

  function setStoredQuickShortcuts(list, shouldPersist = true) {
    try {
      if (!Array.isArray(list) || list.length === 0) {
        list = [{ id: "settings", label: "设置" }];
      }
      localStorage.setItem(SHORTCUTS_STORAGE_KEY, JSON.stringify(list));
      if (shouldPersist) {
        void persistQuickShortcutsToServer(list);
      }
    } catch (e) {}
  }

  initialShortcutsSyncAttempted = false;
  function syncBottomShortcutsBar() {
    const abi = window.__PI_WEB_SETTINGS_NATIVE__;
    if (!abi?.setSidebarShortcuts) return;
    if (!isPluginEnabled("settings-tab-shortcuts")) {
      abi.setSidebarShortcuts(null);
      return;
    }
    if (!initialShortcutsSyncAttempted) {
      initialShortcutsSyncAttempted = true;
      void syncManifestQuickShortcuts();
    }
    // The extension owns preferences; React alone owns buttons and focus.
    // The registry ignores equal snapshots, including forced remote syncs.
    abi.setSidebarShortcuts(getStoredQuickShortcuts());
  }

  function triggerShortcutNavigation(shortcutId) {
    if (shortcutId === "models" && typeof window !== "undefined" && typeof window.__PI_ENH_PRELOAD_MODELS_CACHE__ === "function") {
      void window.__PI_ENH_PRELOAD_MODELS_CACHE__();
    }
    const targetSection = shortcutId === "settings" ? "general" : shortcutId;

    if (typeof window !== "undefined") {
      // 若弹窗已打开，直接通过 Native ABI 激活目标 section
      const abi = window.__PI_WEB_SETTINGS_NATIVE__;
      if (abi && typeof abi.isModalOpen === "function" && abi.isModalOpen()) {
        if (typeof abi.activateSection === "function") {
          try {
            if (abi.activateSection(targetSection)) return;
          } catch (e) {}
        }
      }

      // 原有快捷打开由现 AppShell __PI_ENH_OPEN_SETTINGS__ 统一路由，不再轮询等待/扫描激活 tab
      if (typeof window.__PI_ENH_OPEN_SETTINGS__ === "function") {
        try {
          window.__PI_ENH_OPEN_SETTINGS__(targetSection);
          return;
        } catch (e) {}
      }
      if (typeof window.__PI_OPEN_SETTINGS__ === "function") {
        try {
          window.__PI_OPEN_SETTINGS__(targetSection);
          return;
        } catch (e) {}
      }
      if (abi && typeof abi.activateSection === "function") {
        try {
          abi.activateSection(targetSection);
          return;
        } catch (e) {}
      }
    }
  }
  window.__PI_ENH_TRIGGER_SHORTCUT__ = triggerShortcutNavigation;

  function activateSettingsTab(nav, shortcutId) {
    const targetSection = shortcutId === "settings" ? "general" : shortcutId;
    if (typeof window !== "undefined") {
      if (window.__PI_WEB_SETTINGS_NATIVE__ && typeof window.__PI_WEB_SETTINGS_NATIVE__.activateSection === "function") {
        return window.__PI_WEB_SETTINGS_NATIVE__.activateSection(targetSection);
      }
      if (typeof window.__PI_ENH_OPEN_SETTINGS__ === "function") {
        window.__PI_ENH_OPEN_SETTINGS__(targetSection);
        return true;
      }
    }
    return false;
  }

  function removeBottomShortcutsBar() {
    window.__PI_WEB_SETTINGS_NATIVE__?.setSidebarShortcuts?.(null);
  }

  isForceReloading = false;
  async function forceHardReloadApp() {
    if (isForceReloading) return false;
    isForceReloading = true;

    // 始终建立状态对象（不要求外部预填）
    window.__PI_ENH_FORCE_RELOAD_STATE__ = { status: "loading", error: null };

    function updateReloadProgressToast(text) {
      const activeTextEl = document.querySelector(".pi-enh-toast[data-toast-level='loading'] [data-pi-enh-toast-text]");
      if (activeTextEl) {
        activeTextEl.textContent = text;
        return;
      }
      if (typeof showToast === "function") {
        showToast(text);
      }
    }

    if (typeof showToast === "function") {
      showToast("正在下载最新页面资源…");
    }

    let preservedScrollMemory = null;
    try {
      if (typeof saveCurrentSessionScrollForReload === "function") {
        preservedScrollMemory = saveCurrentSessionScrollForReload();
      }
    } catch (e) {}

    // 有进展不误杀 (Progress-aware Sliding Budget)：
    // 单步无进展超时保持 20s，若持续有下载进展则自动续期（总上限 65s），兼顾弱网/VPN 与真死锁检测
    const STALL_TIMEOUT_MS = 20000;
    const MAX_TOTAL_BUDGET_MS = 65000;
    const reloadStartTs = Date.now();
    const controller = new AbortController();
    let budgetTimer = null;

    function touchProgress() {
      if (controller.signal.aborted) return;
      if (budgetTimer) clearTimeout(budgetTimer);
      const elapsed = Date.now() - reloadStartTs;
      const remainingCap = Math.max(2000, MAX_TOTAL_BUDGET_MS - elapsed);
      const nextTimeout = Math.min(STALL_TIMEOUT_MS, remainingCap);
      budgetTimer = setTimeout(() => {
        controller.abort(new Error("资源下载超时（超过20秒预算）"));
      }, nextTimeout);
    }

    touchProgress();

    // Browser storage/SW promises do not accept AbortSignal. Bound them to
    // the same deadline and remove each abort listener after settlement.
    function withinBudget(promise, softStepLimitMs) {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason || new Error("资源下载超时"));
        if (controller.signal.aborted) return onAbort();
        let stepTimer = null;
        if (Number.isFinite(softStepLimitMs) && softStepLimitMs > 0) {
          stepTimer = setTimeout(() => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(new Error("STEP_SOFT_TIMEOUT"));
          }, softStepLimitMs);
        }
        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => {
          if (stepTimer) clearTimeout(stepTimer);
          controller.signal.removeEventListener("abort", onAbort);
        });
      });
    }

    let htmlFetchedOk = false;
    let completedAssetsCount = 0;
    let totalAssetsCount = 0;

    try {
      // 1. Service Worker 更新采用 4.5s 软限时保护：在手机 VPN 下若 SW 预缓存慢，不阻塞主页面刷新
      try {
        const swContainer = navigator.serviceWorker;
        if (swContainer?.controller) {
          const swUrl = new URL(swContainer.controller.scriptURL);
          if (swUrl.origin === window.location.origin && swUrl.pathname === "/sw.js") {
            const reg = await withinBudget(swContainer.getRegistration(window.location.href), 3500);
            if (reg && reg.scope === new URL("/", window.location.origin).href) {
              await withinBudget(reg.update(), 4000);
              touchProgress();
              const pendingWorker = reg.installing || reg.waiting;
              if (pendingWorker && pendingWorker.state !== "activated") {
                await withinBudget(new Promise((resolve, reject) => {
                  const finish = (error) => {
                    pendingWorker.removeEventListener("statechange", onState);
                    controller.signal.removeEventListener("abort", onAbort);
                    error ? reject(error) : resolve();
                  };
                  const onAbort = () => finish(controller.signal.reason || new Error("离线缓存更新超时"));
                  const onState = () => {
                    if (pendingWorker.state === "activated") finish();
                    else if (pendingWorker.state === "redundant") finish(new Error("离线缓存更新失败"));
                  };
                  pendingWorker.addEventListener("statechange", onState);
                  controller.signal.addEventListener("abort", onAbort, { once: true });
                  controller.signal.aborted ? onAbort() : onState();
                }), 4000);
              }
            }
          }
        }
      } catch (swErr) {
        if (controller.signal.aborted) throw swErr;
        console.warn("[Pi Enh] SW update soft-skipped to prioritize main reload:", swErr?.message || swErr);
      }

      touchProgress();

      // 2. 清理 Pi 离线缓存（带 3.5s 软限时）
      try {
        if (window.caches && typeof window.caches.keys === "function") {
          const names = await withinBudget(window.caches.keys(), 3500);
          await withinBudget(Promise.all(names.filter((name) => name.startsWith("pi-web-"))
            .map((name) => window.caches.delete(name))), 3500);
          touchProgress();
        }
      } catch (cacheErr) {
        if (controller.signal.aborted) throw cacheErr;
      }

      // 3. 保留 SessionStorage / LocalStorage / IndexedDB / Cookies，不调用 clear()，确保用户草稿与状态不丢失
      if (preservedScrollMemory && typeof SESSION_SCROLL_STORAGE_KEY !== "undefined") {
        try {
          window.sessionStorage.setItem(SESSION_SCROLL_STORAGE_KEY, preservedScrollMemory);
        } catch (_) {}
      }

      // 4. 获取最新 HTML 文档文本 (带 _bust，no-store 避免命中 HTML 本地缓存)
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set("_bust", Date.now().toString());
      const htmlRes = await fetch(currentUrl.href, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0"
        }
      });
      touchProgress();
      if (!htmlRes.ok) {
        throw new Error(`获取最新页面失败: HTTP ${htmlRes.status}`);
      }

      const htmlContentType = (htmlRes.headers.get("content-type") || "").toLowerCase();
      if (!htmlContentType.includes("text/html")) {
        throw new Error(`最新页面类型不匹配(${htmlContentType || "未知"})，非有效HTML`);
      }

      if (htmlRes.redirected && htmlRes.url) {
        const redirectedUrl = new URL(htmlRes.url);
        if (redirectedUrl.pathname.includes("/login") || redirectedUrl.pathname.includes("/signin")) {
          throw new Error("页面已重定向至登录页，请重新登录");
        }
      }

      const htmlText = await htmlRes.text();
      touchProgress();

      // 4.2 收集最新 HTML 中的同源 /_next/static/ JS 与 CSS 资源及增强脚本 URL
      const docBaseUrl = window.location.href;
      const origin = window.location.origin;

      function parseNextStaticUrl(urlStr) {
        if (!urlStr || typeof urlStr !== "string") return null;
        try {
          const parsed = new URL(urlStr, docBaseUrl);
          if (parsed.origin !== origin) return null;
          if (!parsed.pathname.startsWith("/_next/static/")) return null;
          const isJs = parsed.pathname.endsWith(".js");
          const isCss = parsed.pathname.endsWith(".css");
          if (!isJs && !isCss) return null;
          parsed.hash = ""; // 保留 parsed.search，只去 hash
          return parsed.href;
        } catch (_) {
          return null;
        }
      }

      function parseEnhancementScriptUrl(urlStr) {
        if (!urlStr || typeof urlStr !== "string") return null;
        try {
          const parsed = new URL(urlStr, docBaseUrl);
          if (parsed.origin !== origin) return null;
          if (parsed.pathname !== "/pi-web-enhancements.js") return null;
          parsed.hash = "";
          return parsed.href;
        } catch (_) {
          return null;
        }
      }

      const latestHtmlUrls = new Set();
      let latestEnhancementUrl = null;
      try {
        const doc = new DOMParser().parseFromString(htmlText, "text/html");
        doc.querySelectorAll("script[src]").forEach((s) => {
          const srcAttr = s.getAttribute("src");
          const u = parseNextStaticUrl(srcAttr);
          if (u) latestHtmlUrls.add(u);
          const enhU = parseEnhancementScriptUrl(srcAttr);
          if (enhU) latestEnhancementUrl = enhU;
        });
        doc.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
          const u = parseNextStaticUrl(l.getAttribute("href"));
          if (u) latestHtmlUrls.add(u);
        });
        doc.querySelectorAll('link[rel="preload"]').forEach((l) => {
          const as = l.getAttribute("as");
          if (as === "script" || as === "style") {
            const u = parseNextStaticUrl(l.getAttribute("href"));
            if (u) latestHtmlUrls.add(u);
          }
        });
      } catch (parseErr) {
        console.warn("[Pi Enh] DOMParser parse html failed:", parseErr);
      }

      // 关键：最新HTML至少必须包含1个Next js/css资源，当前文档合并不能掩盖最新HTML缺资源
      if (latestHtmlUrls.size === 0) {
        throw new Error("最新HTML未检测到有效Next.js静态资源，取消刷新以防白屏");
      }
      htmlFetchedOk = true;

      // 记录当前页面已经成功加载过的静态资源集合（用于区分未变的巨型哈希 vendor chunk）
      const alreadyLoadedUrls = new Set();
      document.querySelectorAll("script[src]").forEach((s) => {
        const u = parseNextStaticUrl(s.getAttribute("src"));
        if (u) alreadyLoadedUrls.add(u);
      });
      document.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
        const u = parseNextStaticUrl(l.getAttribute("href"));
        if (u) alreadyLoadedUrls.add(u);
      });
      if (typeof performance !== "undefined" && typeof performance.getEntriesByType === "function") {
        performance.getEntriesByType("resource").forEach((entry) => {
          if (entry.name && (entry.initiatorType === "script" || entry.initiatorType === "link" || entry.initiatorType === "css")) {
            const u = parseNextStaticUrl(entry.name);
            if (u) alreadyLoadedUrls.add(u);
          }
        });
      }

      // 仅以最新 HTML 所需的首屏静态资源 (+ 可选增强脚本) 为刷新预热目标，
      // 严禁将当前旧 DOM 已加载的历史静态资源（如旧哈希 CSS、旧 chunks）混入 staticUrls，
      // 避免服务器已清理下线的旧文件 404 导致强制刷新被意外阻断。
      const staticUrls = new Set(latestHtmlUrls);
      if (latestEnhancementUrl) {
        staticUrls.add(latestEnhancementUrl);
      }

      // 判断资源是否需要 cache: "reload" 强制穿透，还是走 cache: "no-cache" (ETag 304 协商免下载不变的 MB 级 vendor 包)
      const isSmallAssetSet = latestHtmlUrls.size <= 6;
      function shouldForceReloadAsset(assetUrl) {
        if (isSmallAssetSet) return true;
        try {
          const parsed = new URL(assetUrl);
          const p = parsed.pathname;
          // 增强脚本走 no-cache (若 ?v= 或 ETag 没变直接 304 省下 2.3MB；若变了自动 200 拉取最新)
          if (p === "/pi-web-enhancements.js") return false;
          // 所有 CSS、App 路由入口 chunk、main/webpack 引导脚本，或最新 HTML 新增的资源强制 reload
          if (p.endsWith(".css")) return true;
          if (p.includes("/chunks/app/") || p.includes("/chunks/pages/") || p.includes("/webpack-") || p.includes("/main-")) return true;
          if (!alreadyLoadedUrls.has(assetUrl)) return true;
          // 其余已在当前页面加载过的带 16 位 content-hash 的大型第三方 vendor chunk 走 no-cache 条件校验
          return false;
        } catch (_) {
          return true;
        }
      }

      // 4.3 限制并发 (6) 拉取/校验并实时刷新进度与续期预算
      const urlList = Array.from(staticUrls);
      totalAssetsCount = urlList.length;
      let nextIdx = 0;
      const concurrency = Math.min(6, Math.max(1, urlList.length));

      async function worker() {
        while (nextIdx < urlList.length) {
          if (controller.signal.aborted) {
            throw new Error("刷新操作已中断或超时");
          }
          const idx = nextIdx++;
          const assetUrl = urlList[idx];
          const cacheMode = shouldForceReloadAsset(assetUrl) ? "reload" : "no-cache";
          const res = await fetch(assetUrl, {
            method: "GET",
            cache: cacheMode,
            signal: controller.signal
          });
          touchProgress();
          if (!res.ok) {
            throw new Error(`静态资源拉取失败(${res.status}): ${assetUrl}`);
          }
          const ct = (res.headers.get("content-type") || "").toLowerCase();
          const parsedAsset = new URL(assetUrl);
          const isCss = parsedAsset.pathname.endsWith(".css");
          const isJs = parsedAsset.pathname.endsWith(".js");
          if (isCss && !ct.includes("text/css")) {
            throw new Error(`CSS资源类型不匹配(${ct}): ${assetUrl}`);
          }
          if (isJs && !ct.includes("javascript") && !ct.includes("ecmascript")) {
            throw new Error(`JS资源类型不匹配(${ct}): ${assetUrl}`);
          }
          // 完整消费 response 数据流以触发浏览器网络栈落盘更新
          await res.text();
          completedAssetsCount++;
          touchProgress();
          if (totalAssetsCount > 3) {
            updateReloadProgressToast(`正在更新页面资源 (${completedAssetsCount}/${totalAssetsCount})…`);
          }
        }
      }

      if (urlList.length > 0) {
        await Promise.all(Array.from({ length: concurrency }, () => worker()));
      }

      clearTimeout(budgetTimer);

      // 5. 完整成功后：构建目标 URL，保留已有业务 query/hash，新增 _reload 时间戳
      let targetHref = window.location.href;
      try {
        const targetUrl = new URL(window.location.href);
        targetUrl.searchParams.delete("_bust");
        targetUrl.searchParams.set("_reload", Date.now().toString());
        targetHref = targetUrl.href;
      } catch (_) {}

      if (typeof showToast === "function") {
        showToast("资源下载完成，正在刷新…");
      }
      window.__PI_ENH_FORCE_RELOAD_STATE__ = { status: "success", error: null };

      // 6. 不移除 beforeunload，有界延迟后正常执行 replace 导航
      setTimeout(() => {
        try {
          window.location.replace(targetHref);
        } catch (_) {
          window.location.href = targetHref;
        }
      }, 100);

    } catch (err) {
      controller.abort(); // 关键：取消同轮所有在途请求，防止继续下载与重试冲突
      clearTimeout(budgetTimer);

      // 弱网优雅降级：若最新 HTML 已验证通过且已有部分静态资源下载成功（非 500 故障、非 0 进展死锁），
      // 则直接带 _reload 导航让浏览器利用已预热缓存完成剩余加载，避免移动 VPN 弱网下死循环报错
      const isTimeoutLike = /超时|中断|aborted/i.test(String(err?.message || ""));
      if (isTimeoutLike && htmlFetchedOk && completedAssetsCount > 0) {
        let fallbackHref = window.location.href;
        try {
          const fallbackUrl = new URL(window.location.href);
          fallbackUrl.searchParams.delete("_bust");
          fallbackUrl.searchParams.set("_reload", Date.now().toString());
          fallbackHref = fallbackUrl.href;
        } catch (_) {}
        if (typeof showToast === "function") {
          showToast("核心资源已就绪，正在刷新页面…");
        }
        window.__PI_ENH_FORCE_RELOAD_STATE__ = { status: "success", error: null, degradedFallback: true };
        setTimeout(() => {
          try {
            window.location.replace(fallbackHref);
          } catch (_) {
            window.location.href = fallbackHref;
          }
        }, 100);
        return;
      }

      isForceReloading = false; // 释放锁，允许重试
      window.__PI_ENH_FORCE_RELOAD_STATE__ = { status: "failed", error: err.message };
      console.error("[Pi Enh] 强刷失败:", err);
      if (typeof showToast === "function") {
        showToast(`更新失败: ${err.message || "资源下载异常"}，请重试`);
      }
    }
  }

  window.__PI_ENH_FORCE_HARD_RELOAD__ = forceHardReloadApp;

  function resolveCurrentPiInstanceInfo() {
    return {
      id: "current-origin",
      type: "process",
      displayName: "Agent Web Plus 当前实例",
      bridgeCandidateUrls: [],
      manualCommand: "agent-web",
    };
  }

  async function resolveTargetPiBridge(instanceInfo) {
    const candidates = Array.isArray(instanceInfo?.bridgeCandidateUrls) ? instanceInfo.bridgeCandidateUrls : [];
    for (const candidate of candidates) {
      try {
        const response = await fetch(`${candidate}/ping?_t=${Date.now()}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(1500),
        });
        const identity = await response.json().catch(() => null);
        if (response.ok && identity?.ok === true) return candidate;
      } catch (error) {}
    }
    throw new Error("当前实例未配置重启接口，请在运行服务的主机上重启。");
  }

  function triggerManualRestartPiWebModal() {
    const instanceInfo = resolveCurrentPiInstanceInfo();
    const existing = document.querySelector(".pi-enh-restart-backdrop");
    if (existing) existing.remove();

    const backdrop = document.createElement("div");
    backdrop.className = "pi-enh-restart-backdrop";
    const modal = document.createElement("div");
    modal.className = "pi-enh-restart-modal";
    modal.innerHTML = `
      <div class="pi-enh-restart-modal-header">
        <div class="pi-enh-restart-modal-icon" aria-hidden="true">!</div>
        <h3 class="pi-enh-restart-modal-title">Agent Web Plus 当前实例</h3>
      </div>
      <div class="pi-enh-restart-modal-body">
        <p>当前实例未配置重启接口，请在运行服务的主机上重启。</p>
        <p>请使用启动此服务时的 <code>${instanceInfo.manualCommand}</code> 命令，或通过该服务对应的进程管理器重启。重启会中断当前连接；服务恢复后请刷新页面。</p>
      </div>
      <div class="pi-enh-restart-modal-actions">
        <button type="button" class="pi-enh-restart-btn-cancel">关闭</button>
      </div>
    `;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    modal.querySelector(".pi-enh-restart-btn-cancel")?.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) backdrop.remove();
    });
  }

  window.__PI_ENH_MANUAL_RESTART_PI_WEB__ = triggerManualRestartPiWebModal;


// ==========================================
// 全局用量与成本大盘 (Usage & Cost Dashboard)
// ==========================================

function formatTokenNumber(num) {
  if (typeof num !== "number" || isNaN(num) || num <= 0) return "0";
  if (num >= 1000000) return (num / 1000000).toFixed(2) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "k";
  return num.toLocaleString();
}

function renderUsagePanel(panel, nav) {
  if (!panel) return;
  if (typeof window !== "undefined" && window.PiUsagePanel && typeof window.PiUsagePanel.render === "function") {
    try {
      window.PiUsagePanel.render(panel, nav, {
        enabled: () => isPluginEnabled("usage-cost-dashboard"),
        openSession: (sid, meta) => {
          if (!knownSessionsMap.has(sid)) {
            showToast("该会话属于其他实例或已删除；用量仍保留", null, 3500);
            return;
          }
          if (sid) {
            const closeBtn = panel.closest(".settings-dialog-backdrop, [role='dialog']")?.querySelector(".settings-dialog-close, button.config-close-button");
            if (closeBtn) closeBtn.click();
            const targetItem = document.querySelector(`[data-pi-enh-session-id="${sid}"], [data-session-id="${sid}"], a[href*="session=${sid}"]`);
            if (targetItem) {
              targetItem.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
            } else {
              try { window.location.href = `/?session=${encodeURIComponent(sid)}`; } catch (e) {}
            }
          }
        },
      });
    } catch (err) {
      console.error("[UsagePanel] 顶层调用 render 发生异常:", err);
      panel.innerHTML = `<div class="pi-enh-usage-panel-content" style="padding:24px 0;max-width:900px;margin:0 auto;color:#f4f4f5;">
        <div style="background:#27272a;border:1px solid rgba(239,68,68,0.4);border-radius:8px;padding:20px;">
          <div style="color:#f87171;font-weight:600;margin-bottom:8px;">⚠️ 用量大盘渲染失败</div>
          <div style="color:#a1a1aa;font-size:12px;font-family:monospace;">${String(err?.message || err)}</div>
        </div>
      </div>`;
    }
  } else {
    panel.innerHTML = `<div class="pi-enh-usage-panel-content" style="padding:60px 0;text-align:center;color:var(--text-dim);">
      <div class="pi-enh-history-spinner" style="width:24px;height:24px;border-width:2px;margin:0 auto 12px;"></div>
      <div>正在载入用量统计组件...</div>
    </div>`;
    const loadingView = panel.firstElementChild;
    window.__PI_ENH_LOAD_OPTIONAL__("usage-panel").then(() => {
      // A visited native host stays mounted while hidden. Complete its load so
      // returning to Usage cannot strand the host on the loading view.
      if (panel.isConnected && panel.firstElementChild === loadingView && isPluginEnabled("usage-cost-dashboard")) {
        renderUsagePanel(panel, nav);
      }
    }).catch(() => {
      if (!panel.isConnected || panel.firstElementChild !== loadingView) return;
      panel.innerHTML = '<div role="alert">用量统计组件加载失败，请重试。 <button type="button">重试</button></div>';
      panel.querySelector("button")?.addEventListener("click", () => renderUsagePanel(panel, nav), { once: true });
    });
  }
}

function openUsageDashboard() {
  triggerShortcutNavigation("usage");
}

function toggleUsageDashboard() {
  const existingNav = document.querySelector(".settings-section-tabs");
  const usageTab = existingNav?.querySelector?.("[data-pi-enh-tab='usage']");
  if (usageTab && usageTab.getAttribute("aria-current") === "page") {
    const closeBtn = document.querySelector(".settings-dialog-close, button.config-close-button");
    if (closeBtn) closeBtn.click();
  } else {
    triggerShortcutNavigation("usage");
  }
}

window.__PI_ENH_OPEN_USAGE_DASHBOARD__ = openUsageDashboard;
window.__PI_ENH_TOGGLE_USAGE_DASHBOARD__ = toggleUsageDashboard;
window.__PI_ENH_RENDER_USAGE_PANEL__ = renderUsagePanel;


  function renderNotificationPanel(panel, nav) {
    if (!panel) return;
    if (!panel.classList.contains("pi-enh-notifications-panel")) panel.classList.add("pi-enh-notifications-panel");
    if (!panel) return;
    if (!panel.classList.contains("pi-enh-notifications-panel")) panel.classList.add("pi-enh-notifications-panel");
    const settings = readNotificationSettings();
    const enabledCount = NOTIFICATION_CHANNELS.filter((item) => settings[item.id] !== false).length;
    const grouped = [...new Set(NOTIFICATION_CHANNELS.map((item) => item.group))];
    const history = readNotificationHistory().slice(0, 60);
    const sourceLabels = { native: "Agent", toast: "网页增强", "attention-inpage": "站内提醒", "attention-sound": "提示音", "attention-desktop": "桌面通知" };
    const getDesktopDiagnostic = () => {
      if (typeof window === "undefined" || typeof Notification === "undefined") return "不支持";
      if (!window.isSecureContext) return "HTTP不支持";
      if (Notification.permission === "denied") return "拒绝";
      if (Notification.permission === "default") return "未授权";
      if (Notification.permission === "granted") return "可用";
      return "未知";
    };
    const formatTime = (timestamp) => {
      try { return new Date(timestamp).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch (e) { return ""; }
    };
    const escape = (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");

    panel.innerHTML = `
      <div class="settings-general-container pi-enh-plugins-shell">
        <section class="pi-enh-plugins-toolbar" aria-label="通知管理工具栏">
          <div class="pi-enh-plugins-heading-row">
            <div class="pi-enh-plugins-title-wrap">
              <h2 class="settings-general-title pi-enh-plugins-title">
                <span>通知管理</span>
                <span class="pi-enh-module-version">${enabledCount} / ${NOTIFICATION_CHANNELS.length} 类已开启</span>
              </h2>
              <p class="pi-enh-plugins-description">按来源和级别控制通知是否显示、响铃或发送到桌面；设置即时生效并保存在当前浏览器。</p>
            </div>
            <div class="pi-enh-plugins-actions" aria-label="通知批量操作">
              <button type="button" class="pi-enh-btn-sm" data-notification-action="enable-all">全部开启</button>
              <button type="button" class="pi-enh-btn-sm" data-notification-action="disable-all">全部静音</button>
              <button type="button" class="pi-enh-btn-sm" data-notification-action="reset">恢复默认</button>
            </div>
          </div>
        </section>
        ${grouped.map((group) => `
          <section class="pi-enh-notification-group" aria-label="${escape(group)}">
            <h3 class="pi-enh-notification-group-title">${escape(group)}</h3>
            <div class="pi-enh-plugins-list" style="padding: 0;">
              ${NOTIFICATION_CHANNELS.filter((item) => item.group === group).map((item) => {
                const enabled = settings[item.id] !== false;
                return `<article class="pi-enh-plugin-item" data-notification-row="${item.id}" data-enabled="${enabled ? "true" : "false"}">
                  <div class="pi-enh-plugin-copy">
                    <div class="pi-enh-plugin-name-row"><span class="pi-enh-plugin-name">${escape(item.name)}</span><span class="pi-enh-plugin-category">${escape(item.group)}</span>${item.id === "attention-desktop" ? `<span class="pi-enh-module-version" data-desktop-diagnostic style="font-size:11px;margin-left:6px;">能力：${escape(getDesktopDiagnostic())}</span>` : ""}</div>
                    <div class="pi-enh-plugin-desc">${escape(item.desc)}</div>
                  </div>
                  <button type="button" role="switch" aria-checked="${enabled ? "true" : "false"}" aria-label="${escape(item.name)}" title="${enabled ? "点击静音" : "点击开启"}" class="config-switch" data-notification-toggle="${item.id}"><span class="config-switch-knob" aria-hidden="true"></span></button>
                </article>`;
              }).join("")}
            </div>
          </section>
        `).join("")}
        <section class="pi-enh-notification-history" aria-label="通知历史">
          <div class="pi-enh-notification-history-head">
            <div>
              <h3 class="pi-enh-notification-group-title" style="display: inline-flex; align-items: center; gap: 7px;">通知历史 <span class="pi-enh-module-version">最近 ${history.length} 条</span></h3>
              <div class="pi-enh-plugin-desc" style="margin-top: 4px;">被静音的通知仍会记录在这里，便于事后排查。</div>
            </div>
            <button type="button" class="pi-enh-btn-sm" data-notification-action="clear-history" ${history.length ? "" : "disabled"}>清空历史</button>
          </div>
          <div class="pi-enh-notification-history-list">
            ${history.length ? history.map((item) => {
              const status = item.suppressed ? "已静音" : "已显示";
              const statusClass = item.suppressed ? "is-suppressed" : "";
              const source = sourceLabels[item.channel] || "系统";
              return `<article class="pi-enh-notification-history-item">
                <div class="pi-enh-notification-history-meta">${escape(formatTime(item.timestamp))}<br><span class="pi-enh-notification-history-status ${statusClass}">${escape(status)} · ${escape(getNotificationTypeLabel(item.type))}</span></div>
                <div class="pi-enh-notification-history-message"><span class="pi-enh-notification-history-status">${escape(source)} · ${escape(item.settingId || "")}</span><br>${escape(item.message)}</div>
              </article>`;
            }).join("") : `<div class="pi-enh-notification-history-empty">暂无通知历史</div>`}
          </div>
        </section>
      </div>
    `;

    for (const toggle of panel.querySelectorAll("[data-notification-toggle]")) {
      toggle.addEventListener("click", () => {
        const id = toggle.getAttribute("data-notification-toggle");
        setNotificationEnabled(id, !isNotificationEnabled(id));
        renderNotificationPanel(panel, nav);
      });
    }
    panel.querySelector('[data-notification-action="enable-all"]')?.addEventListener("click", () => {
      for (const item of NOTIFICATION_CHANNELS) setNotificationEnabled(item.id, true);
      renderNotificationPanel(panel, nav);
    });
    panel.querySelector('[data-notification-action="disable-all"]')?.addEventListener("click", () => {
      for (const item of NOTIFICATION_CHANNELS) setNotificationEnabled(item.id, false);
      renderNotificationPanel(panel, nav);
    });
    panel.querySelector('[data-notification-action="reset"]')?.addEventListener("click", () => {
      resetNotificationSettings();
      renderNotificationPanel(panel, nav);
    });
    panel.querySelector('[data-notification-action="clear-history"]')?.addEventListener("click", () => {
      clearNotificationHistory();
      renderNotificationPanel(panel, nav);
    });
  }

  archivedPanelSearchQuery = "";
  selectedArchivedIds = new Set();
  lastCheckedArchivedIndex = null;
  isDateCleanPanelOpen = false;
  archivedDateCutoffValue = "";

  function getDefaultArchivedDateCutoff() {
    const d = new Date(Date.now() - 30 * 86400000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function getArchivedEntryTimestamp(entry) {
    if (!entry) return 0;
    if (entry.archivedAt && Number(entry.archivedAt) > 0) return Number(entry.archivedAt);
    const session = knownSessionsMap.get(entry.id);
    const rawTime = session?.modified || session?.createdAt || session?.updatedAt || session?.lastModified || session?.time || session?.timestamp;
    if (rawTime) {
      const parsed = typeof rawTime === "number" ? rawTime : Date.parse(rawTime);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return 0;
  }

  function getSessionIdsBeforeDate(dateStr, entries) {
    if (!dateStr || !Array.isArray(entries)) return [];
    const parts = String(dateStr).split("-").map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return [];
    const cutoffTime = new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0).getTime();
    if (isNaN(cutoffTime)) return [];
    const matched = [];
    for (const entry of entries) {
      const t = getArchivedEntryTimestamp(entry);
      if (t > 0 && t < cutoffTime) {
        matched.push(entry.id);
      }
    }
    return matched;
  }

  async function executeBatchDeleteArchived(targetIds, panel, nav, triggerBtn) {
    if (!targetIds || targetIds.length === 0) return;
    const initialBtnHtml = triggerBtn ? triggerBtn.innerHTML : "";
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.innerHTML = `<span style="font-size: 11.5px;">正在删除 (0/${targetIds.length})...</span>`;
    }

    showToast(`正在后台删除 ${targetIds.length} 个会话…`, sessionDeleteIcon);

    let successCount = 0;
    let failCount = 0;
    const succeededIds = new Set();

    try {
      for (let i = 0; i < targetIds.length; i++) {
        const sid = targetIds[i];
        if (triggerBtn) {
          triggerBtn.innerHTML = `<span style="font-size: 11.5px;">正在删除 (${i + 1}/${targetIds.length})...</span>`;
        }
        try {
          await deleteArchivedSession(sid);
          successCount++;
          succeededIds.add(sid);
          selectedArchivedIds.delete(sid);
        } catch (err) {
          failCount++;
          console.warn("[pi-enh] 批量删除底层实体清理提示:", sid, err);
        }
      }

      if (succeededIds.size > 0) {
        const archivedEntriesBefore = readStoredArchivedEntries();
        const nextEntries = archivedEntriesBefore.filter((e) => e && !succeededIds.has(e.id));
        writeStoredArchivedEntries(nextEntries);
        if (Array.isArray(window.__PI_ENH_ARCHIVED_MANIFEST__)) {
          window.__PI_ENH_ARCHIVED_MANIFEST__ = window.__PI_ENH_ARCHIVED_MANIFEST__.filter((e) => (typeof e === "string" ? !succeededIds.has(e) : !succeededIds.has(e?.id)));
        }
        void persistArchivedSessionsToServer(nextEntries, undefined, true);
      }
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.innerHTML = initialBtnHtml;
      }
      requestSessionListRefresh(false, true);
      if (panel && nav) {
        renderArchivedPanel(panel, nav);
      }
    }

    if (failCount === 0) {
      showToast(`已成功删除 ${successCount} 个已归档会话`, sessionDeleteIcon);
    } else if (successCount === 0) {
      showToast(`删除失败：${failCount} 个会话未能删除，已保留选中`, sessionDeleteIcon);
    } else {
      showToast(`批量删除完成：成功 ${successCount} 个，失败 ${failCount} 个（已保留选中）`, sessionDeleteIcon);
    }
  }

  function formatArchiveDate(archivedAt) {
    if (!archivedAt) return "";
    const d = new Date(archivedAt);
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const isSameYear = d.getFullYear() === now.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const isToday = isSameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    if (isToday) return `今天 ${hh}:${mm}`;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = isSameYear && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate();
    if (isYesterday) return `昨天 ${hh}:${mm}`;
    if (isSameYear) return `${m}/${day} ${hh}:${mm}`;
    return `${d.getFullYear()}/${m}/${day} ${hh}:${mm}`;
  }

  function formatCwdShort(cwd) {
    if (!cwd) return "";
    const s = String(cwd).trim();
    if (s.length <= 22) return s;
    const parts = s.split(/[\\/]/).filter(Boolean);
    if (parts.length >= 2) {
      const sep = s.includes("\\") ? "\\" : "/";
      return `${parts[0]}${sep}…${sep}${parts[parts.length - 1]}`;
    }
    return s.slice(0, 20) + "…";
  }

  function renderArchivedPanel(panel, nav) {
    if (!panel) return;
    if (!panel.classList.contains("pi-enh-archived-panel")) panel.classList.add("pi-enh-archived-panel");
    const allEntries = readStoredArchivedEntries();
    const needsTitleSync = allEntries.some((e) => !e.name || e.name === e.id || !knownSessionTitles.has(e.id));
    if (needsTitleSync) {
      addManagedTimeout(syncArchivedTitles, 0);
    }

    // 清除已不在列表中的失效勾选项
    const allEntryIds = new Set(allEntries.map((e) => e.id));
    for (const sid of selectedArchivedIds) {
      if (!allEntryIds.has(sid)) selectedArchivedIds.delete(sid);
    }

    const query = archivedPanelSearchQuery.trim().toLowerCase();
    const filteredEntries = allEntries.filter((entry) => {
      if (!query) return true;
      const title = (knownSessionTitles.get(entry.id) || entry.name || "").toLowerCase();
      const id = (entry.id || "").toLowerCase();
      const cwd = (entry.cwd || "").toLowerCase();
      return title.includes(query) || id.includes(query) || cwd.includes(query);
    });

    const isSearching = Boolean(query);
    const countBadgeText = isSearching ? `显示 ${filteredEntries.length} / ${allEntries.length} 个` : `共 ${allEntries.length} 个`;

    const effectiveDateValue = archivedDateCutoffValue || getDefaultArchivedDateCutoff();
    const idsBeforeDate = getSessionIdsBeforeDate(effectiveDateValue, allEntries);
    const beforeDateCount = idsBeforeDate.length;

    const selectedCount = selectedArchivedIds.size;
    const filteredSelectedCount = filteredEntries.filter((e) => selectedArchivedIds.has(e.id)).length;
    const isAllSelected = filteredEntries.length > 0 && filteredSelectedCount === filteredEntries.length;

    panel.innerHTML = `
      <div class="settings-general-container" style="display: flex; flex-direction: column; gap: 10px; min-height: 100%;">
        <div class="pi-enh-archived-toolbar">
          <div class="pi-enh-archived-header-row">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <h2 class="settings-general-title" style="margin: 0; font-size: 15px; font-weight: 600; color: var(--text); display: flex; align-items: center; gap: 8px;">
                <span>已归档</span>
                <span style="font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-weight: 500;" data-archived-count>${countBadgeText}</span>
              </h2>
            </div>
            ${allEntries.length > 0 ? `
              <button type="button" class="pi-enh-btn-sm" data-action="restore-all-archived" style="white-space: nowrap; padding: 4px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; flex-shrink: 0;">
                全部还原
              </button>
            ` : ""}
          </div>
          <p style="margin: 4px 0 10px; font-size: 11.5px; color: var(--text-muted); line-height: 1.45;">
            这些会话已从侧边栏主列表中隐藏。支持批量选择、按住 Shift 连续多选、一键还原或彻底删除，亦可按日期批量清理。
          </p>

          ${allEntries.length > 0 ? `
            <div style="display: flex; align-items: center; gap: 10px;">
              <label class="pi-enh-plugin-search-wrap" style="flex: 1 1 auto; width: 100%;">
                <svg class="pi-enh-plugin-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
                <input class="pi-enh-plugin-search" type="search" data-archived-search aria-label="搜索已归档会话" placeholder="搜索已归档会话标题、ID 或工作目录…" value="${archivedPanelSearchQuery}">
              </label>
            </div>

            <div class="pi-enh-archived-batch-bar">
              <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap; width: 100%;">
                <label class="pi-enh-archived-select-all-wrap" style="display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; font-size: 12.5px; font-weight: 500; color: var(--text);">
                  <input type="checkbox" data-action="toggle-select-all-archived" class="pi-enh-archived-checkbox" ${isAllSelected ? "checked" : ""}>
                  <span>全选</span>
                </label>
                <span style="font-size: 12px; color: var(--text-muted); line-height: 1.2;" data-archived-selection-info>
                  ${selectedCount > 0 ? `已勾选 <strong style="color: var(--text);">${selectedCount}</strong> 项` : `共 ${filteredEntries.length} 项`}
                </span>

                <div style="margin-left: auto; display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                  ${selectedCount > 0 ? `
                    <button type="button" class="pi-enh-btn-sm" data-action="batch-restore-selected" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 12px; border-radius: 6px; cursor: pointer;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>
                      <span>批量还原 (${selectedCount})</span>
                    </button>
                    <button type="button" class="pi-enh-btn-sm pi-enh-archived-delete-btn" data-action="batch-delete-selected" data-stage="init" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 12px; border-radius: 6px; cursor: pointer;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>
                      <span>批量删除 (${selectedCount})</span>
                    </button>
                    <button type="button" class="pi-enh-btn-sm" data-action="clear-archived-selection" style="padding: 4px 10px; font-size: 12px; border-radius: 6px; cursor: pointer;">
                      取消选择
                    </button>
                  ` : ""}
                  <button type="button" class="pi-enh-btn-sm" data-action="toggle-date-clean-panel" style="display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 12px; border-radius: 6px; cursor: pointer; background: ${isDateCleanPanelOpen ? 'var(--bg-hover)' : 'transparent'};">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                    <span>按日期清理${isDateCleanPanelOpen ? " ▲" : " ▼"}</span>
                  </button>
                </div>
              </div>
            </div>

            ${isDateCleanPanelOpen ? `
              <div class="pi-enh-archived-date-panel">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                  <div style="font-size: 13px; font-weight: 500; color: var(--text); display: flex; align-items: center; gap: 6px;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg>
                    <span>按日期批量清理对话</span>
                  </div>
                  <span style="font-size: 11.5px; color: var(--text-muted);">清理在此日期（00:00:00）之前归档的所有会话</span>
                </div>

                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                  <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text);">
                    <span>选择截止日期：</span>
                    <input type="date" class="pi-enh-archived-date-input" data-archived-date-input value="${effectiveDateValue}">
                  </label>

                  <div style="display: inline-flex; align-items: center; gap: 4px;">
                    <button type="button" class="pi-enh-btn-sm" data-action="quick-date-preset" data-days="7" style="padding: 2px 8px; font-size: 11.5px;">7天前</button>
                    <button type="button" class="pi-enh-btn-sm" data-action="quick-date-preset" data-days="30" style="padding: 2px 8px; font-size: 11.5px;">30天前</button>
                    <button type="button" class="pi-enh-btn-sm" data-action="quick-date-preset" data-days="60" style="padding: 2px 8px; font-size: 11.5px;">60天前</button>
                    <button type="button" class="pi-enh-btn-sm" data-action="quick-date-preset" data-days="90" style="padding: 2px 8px; font-size: 11.5px;">90天前</button>
                  </div>
                </div>

                <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 6px; border-top: 1px solid var(--border, #27272a); flex-wrap: wrap;">
                  <div style="font-size: 12px; color: var(--text);">
                    符合条件的早于此日期的会话：<strong style="color: ${beforeDateCount > 0 ? 'var(--accent, #3b82f6)' : 'var(--text-muted)'}; font-size: 13px;" data-date-clean-count>${beforeDateCount}</strong> 个
                  </div>
                  <div style="display: inline-flex; align-items: center; gap: 8px;">
                    <button type="button" class="pi-enh-btn-sm" data-action="select-before-date" ${beforeDateCount === 0 ? "disabled" : ""} style="padding: 4px 10px; font-size: 12px;">
                      勾选这 ${beforeDateCount} 个会话
                    </button>
                    <button type="button" class="pi-enh-btn-sm pi-enh-archived-delete-btn" data-action="delete-before-date" data-stage="init" ${beforeDateCount === 0 ? "disabled" : ""} style="padding: 4px 10px; font-size: 12px;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>
                      <span>一键删除 (${beforeDateCount})</span>
                    </button>
                  </div>
                </div>
              </div>
            ` : ""}
          ` : ""}
        </div>

        ${allEntries.length === 0 ? `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 56px 20px; color: var(--text-muted); text-align: center;">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.35; margin-bottom: 12px;">
              <path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path>
            </svg>
            <div style="font-size: 14px; font-weight: 500; color: var(--text);">暂无已归档的会话</div>
            <div style="font-size: 12px; margin-top: 5px; max-width: 340px; line-height: 1.5;">
              鼠标悬浮在左侧侧边栏会话行上，点击右侧的“⋯”按钮并选择“归档会话”，即可将不需要频繁查阅的会话收纳至此处。
            </div>
          </div>
        ` : isSearching && filteredEntries.length === 0 ? `
          <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 48px 20px; color: var(--text-muted); text-align: center;">
            <div style="font-size: 13.5px; color: var(--text);">未找到匹配“${archivedPanelSearchQuery}”的已归档会话</div>
            <div style="font-size: 12px; margin-top: 5px;">请尝试缩短关键词或搜索其他词汇。</div>
          </div>
        ` : `
          <div style="display: flex; flex-direction: column; gap: 8px; max-width: 100%;">
            ${filteredEntries.map((entry, index) => {
              const displayName = knownSessionTitles.get(entry.id) || (entry.name && entry.name !== entry.id ? entry.name : entry.id.slice(0, 12));
              const fullDateStr = entry.archivedAt ? new Date(entry.archivedAt).toLocaleString() : "";
              const shortDateStr = formatArchiveDate(entry.archivedAt);
              const isSelected = selectedArchivedIds.has(entry.id);
              const shortCwd = formatCwdShort(entry.cwd);
              return `
                <div class="pi-enh-archived-item${isSelected ? " is-selected" : ""}">
                  <div class="pi-enh-archived-item-main">
                    <label class="pi-enh-archived-checkbox-wrap" title="选择会话（按住 Shift 可连续多选）">
                      <input type="checkbox" class="pi-enh-archived-checkbox" data-action="toggle-select-archived" data-session-id="${encodeURIComponent(entry.id)}" data-index="${index}" ${isSelected ? "checked" : ""}>
                    </label>
                    <div class="pi-enh-archived-title-row">
                      <svg class="pi-enh-archived-title-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
                      <span class="pi-enh-archived-title" title="${escapeHtml(displayName)}（点击可展开/收起完整标题）">${escapeHtml(displayName)}</span>
                    </div>
                  </div>
                  <div class="pi-enh-archived-item-footer">
                    <div class="pi-enh-archived-meta-row">
                      ${entry.cwd ? `
                        <span class="pi-enh-archived-meta-tag pi-enh-archived-meta-cwd" title="工作目录: ${escapeHtml(entry.cwd)}">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                          <span class="pi-enh-archived-tag-text">${escapeHtml(shortCwd)}</span>
                        </span>
                      ` : ""}
                      ${shortDateStr ? `
                        <span class="pi-enh-archived-meta-tag pi-enh-archived-meta-date" title="归档时间: ${fullDateStr}">
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 14"></polyline></svg>
                          <span class="pi-enh-archived-tag-text">${shortDateStr}</span>
                        </span>
                      ` : ""}
                      <span class="pi-enh-archived-meta-tag pi-enh-archived-meta-id" title="完整会话 ID: ${entry.id}">
                        <span class="pi-enh-archived-tag-text">ID: ${entry.id.slice(0, 8)}…</span>
                      </span>
                    </div>
                    <div class="pi-enh-archived-actions">
                      <button type="button" class="pi-enh-btn-sm pi-enh-archived-restore-btn" data-action="restore-archived-session" data-session-id="${encodeURIComponent(entry.id)}" title="还原到侧边栏主列表">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>
                        <span>还原</span>
                      </button>
                      <button type="button" class="pi-enh-btn-sm pi-enh-archived-delete-btn" data-action="delete-archived-session" data-session-id="${encodeURIComponent(entry.id)}" data-stage="init" title="彻底删除此会话">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
                        <span>删除</span>
                      </button>
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        `}
      </div>
    `;

    const searchInput = panel.querySelector("[data-archived-search]");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        archivedPanelSearchQuery = searchInput.value || "";
        renderArchivedPanel(panel, nav);
        const nextInput = panel.querySelector("[data-archived-search]");
        if (nextInput) {
          nextInput.focus();
          const len = nextInput.value.length;
          try { nextInput.setSelectionRange?.(len, len); } catch (err) {}
        }
      });
    }

    // 勾选与 Shift 连续多选事件监听
    const checkboxes = panel.querySelectorAll('[data-action="toggle-select-archived"]');
    for (const cb of checkboxes) {
      cb.addEventListener("click", (e) => {
        e.stopPropagation();
        const currIndex = Number(cb.getAttribute("data-index"));
        const isShift = Boolean(e.shiftKey);
        const isChecked = cb.checked;
        const sid = decodeURIComponent(cb.getAttribute("data-session-id") || "");

        if (isShift && lastCheckedArchivedIndex !== null && lastCheckedArchivedIndex !== currIndex) {
          const start = Math.min(lastCheckedArchivedIndex, currIndex);
          const end = Math.max(lastCheckedArchivedIndex, currIndex);
          for (let i = start; i <= end; i++) {
            const item = filteredEntries[i];
            if (item && item.id) {
              if (isChecked) {
                selectedArchivedIds.add(item.id);
              } else {
                selectedArchivedIds.delete(item.id);
              }
            }
          }
        } else {
          if (isChecked) {
            if (sid) selectedArchivedIds.add(sid);
          } else {
            if (sid) selectedArchivedIds.delete(sid);
          }
        }
        lastCheckedArchivedIndex = currIndex;
        renderArchivedPanel(panel, nav);
      });
    }

    // 全选/全不选切换
    const selectAllCb = panel.querySelector('[data-action="toggle-select-all-archived"]');
    if (selectAllCb) {
      selectAllCb.addEventListener("change", () => {
        const checked = selectAllCb.checked;
        for (const entry of filteredEntries) {
          if (checked) {
            selectedArchivedIds.add(entry.id);
          } else {
            selectedArchivedIds.delete(entry.id);
          }
        }
        lastCheckedArchivedIndex = null;
        renderArchivedPanel(panel, nav);
      });
    }

    // 批量还原
    const batchRestoreBtn = panel.querySelector('[data-action="batch-restore-selected"]');
    if (batchRestoreBtn) {
      batchRestoreBtn.addEventListener("click", async () => {
        const idsToRestore = [...selectedArchivedIds];
        if (idsToRestore.length === 0) return;
        try {
          const restoreFn = (typeof restoreArchivedSessions === "function")
            ? restoreArchivedSessions
            : (typeof window !== "undefined" ? window.__PI_ENH_RESTORE_ARCHIVED_SESSIONS__ : null);
          const result = restoreFn ? await restoreFn(idsToRestore) : 0;
          const restoredCount = typeof result === "object" && result !== null ? (result.restoredCount ?? Number(result)) : Number(result);
          const succeeded = (result && typeof result === "object" && Array.isArray(result.succeededIds))
            ? result.succeededIds
            : idsToRestore;
          for (const sid of succeeded) {
            selectedArchivedIds.delete(sid);
          }
          lastCheckedArchivedIndex = null;
          invalidateCodexArchivedEntries();
          requestSessionListRefresh(false, true);
          if (typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
            try { window.__PI_ENH_RERENDER_SESSIONS__(); } catch (e) {}
          }
          renderArchivedPanel(panel, nav);
          showToast(`已批量还原 ${restoredCount} 个会话`, sessionArchiveIcon);
        } catch (err) {
          const succeeded = Array.isArray(err?.succeededIds) ? err.succeededIds : [];
          if (succeeded.length > 0) {
            for (const sid of succeeded) {
              selectedArchivedIds.delete(sid);
            }
            lastCheckedArchivedIndex = null;
            invalidateCodexArchivedEntries();
            requestSessionListRefresh(false, true);
            if (typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
              try { window.__PI_ENH_RERENDER_SESSIONS__(); } catch (e) {}
            }
            renderArchivedPanel(panel, nav);
            showToast(`已还原 ${succeeded.length} 项，其余未确认已保留`, undefined, 4000);
          } else {
            showToast(err?.message || "批量还原未确认，已保留归档状态", undefined, 3500);
          }
        }
      });
    }

    // 批量删除（两阶段确认）
    const batchDeleteBtn = panel.querySelector('[data-action="batch-delete-selected"]');
    if (batchDeleteBtn) {
      batchDeleteBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const stage = batchDeleteBtn.getAttribute("data-stage") || "init";
        if (stage !== "confirm") {
          batchDeleteBtn.setAttribute("data-stage", "confirm");
          batchDeleteBtn.classList.add("pi-enh-archived-delete-confirming");
          batchDeleteBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>确认彻底删除 (${selectedArchivedIds.size}) 项？</span>
          `;
          if (batchDeleteBtn._confirmTimer) clearTimeout(batchDeleteBtn._confirmTimer);
          batchDeleteBtn._confirmTimer = setTimeout(() => {
            batchDeleteBtn.setAttribute("data-stage", "init");
            batchDeleteBtn.classList.remove("pi-enh-archived-delete-confirming");
            renderArchivedPanel(panel, nav);
          }, 5000);
          return;
        }

        if (batchDeleteBtn._confirmTimer) clearTimeout(batchDeleteBtn._confirmTimer);
        const targetIds = [...selectedArchivedIds];
        executeBatchDeleteArchived(targetIds, panel, nav, batchDeleteBtn);
      });
    }

    // 取消选择
    const clearSelectionBtn = panel.querySelector('[data-action="clear-archived-selection"]');
    if (clearSelectionBtn) {
      clearSelectionBtn.addEventListener("click", () => {
        selectedArchivedIds.clear();
        lastCheckedArchivedIndex = null;
        renderArchivedPanel(panel, nav);
      });
    }

    // 展开/收起按日期清理面板
    const toggleDateCleanBtn = panel.querySelector('[data-action="toggle-date-clean-panel"]');
    if (toggleDateCleanBtn) {
      toggleDateCleanBtn.addEventListener("click", () => {
        isDateCleanPanelOpen = !isDateCleanPanelOpen;
        renderArchivedPanel(panel, nav);
      });
    }

    // 日期选择框输入
    const dateInput = panel.querySelector("[data-archived-date-input]");
    if (dateInput) {
      dateInput.addEventListener("change", () => {
        archivedDateCutoffValue = dateInput.value || getDefaultArchivedDateCutoff();
        renderArchivedPanel(panel, nav);
      });
    }

    // 快捷天数预设
    const presetBtns = panel.querySelectorAll('[data-action="quick-date-preset"]');
    for (const pb of presetBtns) {
      pb.addEventListener("click", () => {
        const days = Number(pb.getAttribute("data-days")) || 30;
        const d = new Date(Date.now() - days * 86400000);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        archivedDateCutoffValue = `${yyyy}-${mm}-${dd}`;
        renderArchivedPanel(panel, nav);
      });
    }

    // 勾选指定日期前的会话
    const selectBeforeDateBtn = panel.querySelector('[data-action="select-before-date"]');
    if (selectBeforeDateBtn) {
      selectBeforeDateBtn.addEventListener("click", () => {
        const ids = getSessionIdsBeforeDate(effectiveDateValue, allEntries);
        for (const id of ids) {
          selectedArchivedIds.add(id);
        }
        renderArchivedPanel(panel, nav);
        showToast(`已勾选 ${ids.length} 个早于 ${effectiveDateValue} 的会话`, sessionArchiveIcon);
      });
    }

    // 一键删除指定日期前的所有会话（两阶段确认）
    const deleteBeforeDateBtn = panel.querySelector('[data-action="delete-before-date"]');
    if (deleteBeforeDateBtn) {
      deleteBeforeDateBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const stage = deleteBeforeDateBtn.getAttribute("data-stage") || "init";
        const ids = getSessionIdsBeforeDate(effectiveDateValue, allEntries);
        if (ids.length === 0) return;

        if (stage !== "confirm") {
          deleteBeforeDateBtn.setAttribute("data-stage", "confirm");
          deleteBeforeDateBtn.classList.add("pi-enh-archived-delete-confirming");
          deleteBeforeDateBtn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>确认彻底删除这 ${ids.length} 个会话？</span>
          `;
          if (deleteBeforeDateBtn._confirmTimer) clearTimeout(deleteBeforeDateBtn._confirmTimer);
          deleteBeforeDateBtn._confirmTimer = setTimeout(() => {
            deleteBeforeDateBtn.setAttribute("data-stage", "init");
            deleteBeforeDateBtn.classList.remove("pi-enh-archived-delete-confirming");
            renderArchivedPanel(panel, nav);
          }, 5000);
          return;
        }

        if (deleteBeforeDateBtn._confirmTimer) clearTimeout(deleteBeforeDateBtn._confirmTimer);
        executeBatchDeleteArchived(ids, panel, nav, deleteBeforeDateBtn);
      });
    }

    for (const btn of panel.querySelectorAll('[data-action="restore-archived-session"]')) {
      btn.addEventListener("click", async () => {
        let sessionId = "";
        try { sessionId = decodeURIComponent(btn.getAttribute("data-session-id") || ""); } catch (e) {}
        try {
          const restoreFn = (typeof restoreArchivedSession === "function")
            ? restoreArchivedSession
            : (typeof window !== "undefined" ? window.__PI_ENH_RESTORE_ARCHIVED_SESSION__ : null);
          const ok = restoreFn ? await restoreFn(sessionId) : false;
          if (!ok) return;
          selectedArchivedIds.delete(sessionId);
          invalidateCodexArchivedEntries();
          requestSessionListRefresh(false, true);
          if (typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
            try { window.__PI_ENH_RERENDER_SESSIONS__(); } catch (e) {}
          }
          renderArchivedPanel(panel, nav);
          showToast("已还原会话", sessionArchiveIcon);
        } catch (err) {
          showToast(err?.message || "还原未确认，已保留归档状态", undefined, 3500);
        }
      });
    }

    function resetDeleteBtn(targetBtn) {
      if (!targetBtn) return;
      if (targetBtn._confirmTimer) {
        clearTimeout(targetBtn._confirmTimer);
        targetBtn._confirmTimer = null;
      }
      targetBtn.setAttribute("data-stage", "init");
      targetBtn.classList.remove("pi-enh-archived-delete-confirming");
      targetBtn.title = "彻底删除此会话";
      targetBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
        <span>删除</span>
      `;
    }

    const deleteButtons = panel.querySelectorAll('[data-action="delete-archived-session"]');
    for (const btn of deleteButtons) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const stage = btn.getAttribute("data-stage") || "init";
        if (stage !== "confirm") {
          for (const otherBtn of deleteButtons) {
            if (otherBtn !== btn && otherBtn.getAttribute("data-stage") === "confirm") {
              resetDeleteBtn(otherBtn);
            }
          }
          btn.setAttribute("data-stage", "confirm");
          btn.classList.add("pi-enh-archived-delete-confirming");
          btn.title = "再次点击彻底删除此会话";
          btn.innerHTML = `
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            <span>确认</span>
          `;
          if (btn._confirmTimer) clearTimeout(btn._confirmTimer);
          btn._confirmTimer = setTimeout(() => {
            resetDeleteBtn(btn);
          }, 4000);
          return;
        }

        if (btn._confirmTimer) {
          clearTimeout(btn._confirmTimer);
          btn._confirmTimer = null;
        }
        btn.disabled = true;
        btn.innerHTML = `<span style="font-size: 11.5px;">正在删除...</span>`;

        let sessionId = "";
        try { sessionId = decodeURIComponent(btn.getAttribute("data-session-id") || ""); } catch (err) {}
        if (!sessionId) return;

        if (getCurrentArchivedEngine() === "codex") {
          selectedArchivedIds.delete(sessionId);
          (async () => {
            try {
              await deleteArchivedSession(sessionId);
              invalidateCodexArchivedEntries();
              requestSessionListRefresh(false, true);
              renderArchivedPanel(panel, nav);
              showToast("已彻底删除会话", sessionDeleteIcon);
            } catch (err) {
              showToast(err?.message || "删除会话未确认，已保留状态", undefined, 3500);
            }
          })();
          return;
        }

        // 彻底移出归档列表：本地 localStorage、全局 manifest 及选中态全部立即清理
        const archivedEntriesBeforeDelete = readStoredArchivedEntries();
        const nextEntries = archivedEntriesBeforeDelete.filter((entry) => entry && entry.id !== sessionId);
        writeStoredArchivedEntries(nextEntries);
        if (Array.isArray(window.__PI_ENH_ARCHIVED_MANIFEST__)) {
          window.__PI_ENH_ARCHIVED_MANIFEST__ = window.__PI_ENH_ARCHIVED_MANIFEST__.filter((entry) => (typeof entry === "string" ? entry !== sessionId : entry?.id !== sessionId));
        }
        selectedArchivedIds.delete(sessionId);
        renderArchivedPanel(panel, nav);
        showToast("已删除归档会话", sessionDeleteIcon);

        (async () => {
          // 立即无防抖写回权威服务端 models-config
          try {
            await persistArchivedSessionsToServer(nextEntries, undefined, true);
          } catch (e) {
            console.warn("[pi-enh] 归档删除服务端同步异常:", e);
          }
          // 异步清理底层磁盘实体文件（非阻塞，绝不反向复活已删除条目）
          try {
            await deleteArchivedSession(sessionId);
          } catch (err) {
            console.warn("[pi-enh] 会话底层实体文件清理提示 (非阻塞):", err);
          }
          requestSessionListRefresh(false, true);
        })();
      });
    }

    panel.addEventListener("click", (e) => {
      if (!e.target.closest || !e.target.closest('[data-action="delete-archived-session"]')) {
        for (const b of deleteButtons) {
          if (b.getAttribute("data-stage") === "confirm") {
            resetDeleteBtn(b);
          }
        }
      }
    });

    panel.querySelector('[data-action="restore-all-archived"]')?.addEventListener("click", async () => {
      const all = allEntries;
      if (all.length === 0) return;
      const allIds = all.map((item) => item.id).filter(Boolean);
      try {
        const restoreFn = (typeof restoreArchivedSessions === "function")
          ? restoreArchivedSessions
          : (typeof window !== "undefined" ? window.__PI_ENH_RESTORE_ARCHIVED_SESSIONS__ : null);
        const result = restoreFn ? await restoreFn(allIds) : 0;
        const restoredCount = typeof result === "object" && result !== null ? (result.restoredCount ?? Number(result)) : Number(result);
        const succeeded = (result && typeof result === "object" && Array.isArray(result.succeededIds))
          ? result.succeededIds
          : allIds;
        for (const sid of succeeded) {
          selectedArchivedIds.delete(sid);
        }
        lastCheckedArchivedIndex = null;
        invalidateCodexArchivedEntries();
        requestSessionListRefresh(false, true);
        if (typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
          try { window.__PI_ENH_RERENDER_SESSIONS__(); } catch (e) {}
        }
        renderArchivedPanel(panel, nav);
        showToast(`已全部还原 ${restoredCount} 个会话`, sessionArchiveIcon);
      } catch (err) {
        const succeeded = Array.isArray(err?.succeededIds) ? err.succeededIds : [];
        if (succeeded.length > 0) {
          for (const sid of succeeded) {
            selectedArchivedIds.delete(sid);
          }
          lastCheckedArchivedIndex = null;
          invalidateCodexArchivedEntries();
          requestSessionListRefresh(false, true);
          if (typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
            try { window.__PI_ENH_RERENDER_SESSIONS__(); } catch (e) {}
          }
          renderArchivedPanel(panel, nav);
          showToast(`已还原 ${succeeded.length} 项，其余未确认已保留`, undefined, 4000);
        } else {
          showToast(err?.message || "还原未确认，已保留归档状态", undefined, 3500);
        }
      }
    });

    for (const titleEl of panel.querySelectorAll(".pi-enh-archived-title")) {
      titleEl.addEventListener("click", (e) => {
        e.stopPropagation();
        titleEl.classList.toggle("is-expanded");
      });
    }
  }

  window.__PI_ENH_SET_ARCHIVED_SEARCH__ = function (q) {
    archivedPanelSearchQuery = String(q || "");
    const panel = document.querySelector(".pi-enh-archived-panel");
    const nav = document.querySelector(".settings-section-tabs");
    if (panel) renderArchivedPanel(panel, nav);
  };
  window.__PI_ENH_GET_SELECTED_ARCHIVED_IDS__ = () => [...selectedArchivedIds];
  window.__PI_ENH_CLEAR_ARCHIVED_SELECTION__ = () => {
    selectedArchivedIds.clear();
    lastCheckedArchivedIndex = null;
    const panel = document.querySelector(".pi-enh-archived-panel");
    const nav = document.querySelector(".settings-section-tabs");
    if (panel) renderArchivedPanel(panel, nav);
  };
  window.__PI_ENH_SELECT_ARCHIVED_BEFORE_DATE__ = (dateStr) => {
    const allEntries = readStoredArchivedEntries();
    const ids = getSessionIdsBeforeDate(dateStr, allEntries);
    for (const id of ids) selectedArchivedIds.add(id);
    const panel = document.querySelector(".pi-enh-archived-panel");
    const nav = document.querySelector(".settings-section-tabs");
    if (panel) renderArchivedPanel(panel, nav);
    return ids;
  };
  window.__PI_ENH_SET_ARCHIVED_DATE_CUTOFF__ = (dateStr) => {
    archivedDateCutoffValue = String(dateStr || "");
    const panel = document.querySelector(".pi-enh-archived-panel");
    const nav = document.querySelector(".settings-section-tabs");
    if (panel) renderArchivedPanel(panel, nav);
  };
  window.__PI_ENH_TOGGLE_DATE_CLEAN_PANEL__ = (force) => {
    isDateCleanPanelOpen = force !== undefined ? Boolean(force) : !isDateCleanPanelOpen;
    const panel = document.querySelector(".pi-enh-archived-panel");
    const nav = document.querySelector(".settings-section-tabs");
    if (panel) renderArchivedPanel(panel, nav);
  };
  window.__PI_ENH_EXECUTE_BATCH_DELETE_ARCHIVED__ = executeBatchDeleteArchived;

  const enhancementPanelFilter = { query: "", category: "all" };

  function escapeQuickActionHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function quickActionsSyncLabel() {
    if (quickActionsSyncStatus === "syncing") return "正在同步";
    if (quickActionsSyncStatus === "dirty") return "本地有修改，尚未同步";
    if (quickActionsSyncStatus === "error") return "同步失败，AI 继续使用上一版";
    if (quickActionsSyncStatus === "loading") return "正在同步";
    return "已同步到 AI";
  }

  function renderQuickActionsEditorBody(disabled) {
    const actions = quickActionsDraftConfig.actions;
    const rows = actions.map((action, index) => `
      <article class="pi-enh-quick-config-row" data-quick-action-row="${index}">
        <div class="pi-enh-quick-config-row-head">
          <strong>${escapeQuickActionHtml(action.label)}</strong>
          <span class="pi-enh-quick-config-priority">优先级 ${action.priority}</span>
          <label class="pi-enh-quick-config-enabled"><input type="checkbox" data-quick-action-field="enabled" data-quick-action-index="${index}" ${action.enabled ? "checked" : ""} ${disabled ? "disabled" : ""}>启用</label>
        </div>
        <div class="pi-enh-quick-config-grid">
          <label><span>按钮名称</span><input type="text" maxlength="24" data-quick-action-field="label" data-quick-action-index="${index}" value="${escapeQuickActionHtml(action.label)}" ${disabled ? "disabled" : ""}></label>
          <label><span>发送内容</span><input type="text" maxlength="200" data-quick-action-field="message" data-quick-action-index="${index}" value="${escapeQuickActionHtml(action.message)}" ${disabled ? "disabled" : ""}></label>
          <label class="pi-enh-quick-config-condition"><span>AI 匹配条件</span><textarea maxlength="500" rows="2" data-quick-action-field="condition" data-quick-action-index="${index}" ${disabled ? "disabled" : ""}>${escapeQuickActionHtml(action.condition)}</textarea></label>
          <label><span>点击行为</span><select data-quick-action-field="mode" data-quick-action-index="${index}" ${disabled ? "disabled" : ""}><option value="send" ${action.mode === "send" ? "selected" : ""}>直接发送</option><option value="fill" ${action.mode === "fill" ? "selected" : ""}>仅填入输入框</option></select></label>
          <label><span>优先级</span><input type="number" data-quick-action-field="priority" data-quick-action-index="${index}" value="${action.priority}" ${disabled ? "disabled" : ""}></label>
        </div>
        <div class="pi-enh-quick-config-actions">
          <button type="button" class="pi-enh-btn-sm" data-quick-action-command="up" data-quick-action-index="${index}" ${disabled || index === 0 ? "disabled" : ""}>上移</button>
          <button type="button" class="pi-enh-btn-sm" data-quick-action-command="down" data-quick-action-index="${index}" ${disabled || index === actions.length - 1 ? "disabled" : ""}>下移</button>
          <button type="button" class="pi-enh-btn-sm" data-quick-action-command="duplicate" data-quick-action-index="${index}" ${disabled || actions.length >= QUICK_ACTIONS_MAX_ITEMS ? "disabled" : ""}>复制</button>
          <button type="button" class="pi-enh-btn-sm" data-quick-action-command="delete" data-quick-action-index="${index}" ${disabled ? "disabled" : ""}>删除</button>
        </div>
      </article>`).join("");
    return `
      <summary>管理快捷回复 · <span data-quick-actions-sync-state>${quickActionsSyncLabel()}</span></summary>
      <div class="pi-enh-quick-config-body">
        <div class="pi-enh-quick-config-toolbar">
          <span>全局共享 · ${actions.length}/${QUICK_ACTIONS_MAX_ITEMS} 项</span>
          <div>
            <button type="button" class="pi-enh-btn-sm" data-quick-action-command="add" ${disabled || actions.length >= QUICK_ACTIONS_MAX_ITEMS ? "disabled" : ""}>新增</button>
            <button type="button" class="pi-enh-btn-sm" data-quick-action-command="reset" ${disabled ? "disabled" : ""}>恢复默认</button>
            <button type="button" class="pi-enh-btn-sm pi-enh-btn-primary" data-quick-action-command="save" ${disabled ? "disabled" : ""}>保存并同步</button>
          </div>
        </div>
        ${rows || '<div class="pi-enh-quick-config-empty">暂无快捷回复。可新增动作；无匹配时仍保留 ⚡。</div>'}
      </div>`;
  }

  function renderQuickActionsEditor(disabled) {
    return `<details class="pi-enh-quick-config-editor" data-quick-actions-editor ${disabled ? "data-disabled=true" : ""}>${renderQuickActionsEditorBody(disabled)}</details>`;
  }

  function refreshQuickActionsEditorDom(root = document) {
    const editor = root?.querySelector?.("[data-quick-actions-editor]");
    if (!editor) return;
    const wasOpen = Boolean(editor.open || editor.hasAttribute?.("open"));
    const moduleDisabled = !isModuleEnabled("composer-workflow") || !isPluginEnabled("quick-action-buttons");
    editor.innerHTML = renderQuickActionsEditorBody(moduleDisabled);
    if (wasOpen) editor.setAttribute?.("open", "");
  }

  function updateQuickActionDraft(index, field, value) {
    const actions = quickActionsDraftConfig.actions.map(cloneQuickAction);
    if (!Number.isInteger(index) || index < 0 || index >= actions.length) return false;
    if (field === "enabled") actions[index].enabled = Boolean(value);
    else if (field === "priority") actions[index].priority = Number.parseInt(value, 10);
    else if (["label", "message", "condition", "mode"].includes(field)) actions[index][field] = String(value);
    else return false;
    const normalized = normalizeQuickActionsConfig({ ...quickActionsDraftConfig, actions });
    if (!normalized) return false;
    quickActionsDraftConfig = normalized;
    quickActionsDraftGeneration += 1;
    quickActionsSyncStatus = "dirty";
    persistQuickActionsDraft();
    return true;
  }

  function createCustomQuickAction(source = null) {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return {
      id: `custom-${suffix}`,
      label: source ? `${source.label}副本`.slice(0, 24) : "新快捷回复",
      message: source?.message || "新快捷回复",
      condition: source?.condition || "请描述此快捷回复应在什么语义场景下显示。",
      mode: source?.mode || "fill",
      priority: source?.priority || 10,
      enabled: true,
    };
  }

  function mutateQuickActions(command, index = -1) {
    let actions = quickActionsDraftConfig.actions.map(cloneQuickAction);
    if (command === "add" && actions.length < QUICK_ACTIONS_MAX_ITEMS) actions.push(createCustomQuickAction());
    else if (command === "duplicate" && actions[index] && actions.length < QUICK_ACTIONS_MAX_ITEMS) actions.splice(index + 1, 0, createCustomQuickAction(actions[index]));
    else if (command === "delete" && actions[index]) actions.splice(index, 1);
    else if (command === "up" && index > 0) [actions[index - 1], actions[index]] = [actions[index], actions[index - 1]];
    else if (command === "down" && index >= 0 && index < actions.length - 1) [actions[index], actions[index + 1]] = [actions[index + 1], actions[index]];
    else if (command === "reset") actions = DEFAULT_QUICK_ACTIONS_CONFIG.actions.map(cloneQuickAction);
    else return false;
    if (["up", "down"].includes(command)) {
      actions.forEach((action, position) => { action.priority = (actions.length - position) * 10; });
    }
    const normalized = normalizeQuickActionsConfig({ ...quickActionsDraftConfig, actions });
    if (!normalized) return false;
    quickActionsDraftConfig = normalized;
    quickActionsDraftGeneration += 1;
    quickActionsSyncStatus = "dirty";
    persistQuickActionsDraft();
    return true;
  }

  function bindQuickActionsEditor(panel) {
    panel.addEventListener("input", (event) => {
      const field = event.target?.getAttribute?.("data-quick-action-field");
      if (!field || field === "enabled" || field === "mode") return;
      const index = Number.parseInt(event.target.getAttribute("data-quick-action-index"), 10);
      updateQuickActionDraft(index, field, event.target.value);
      const state = panel.querySelector("[data-quick-actions-sync-state]");
      if (state) state.textContent = quickActionsSyncLabel();
    });
    panel.addEventListener("change", (event) => {
      const field = event.target?.getAttribute?.("data-quick-action-field");
      if (!field) return;
      const index = Number.parseInt(event.target.getAttribute("data-quick-action-index"), 10);
      const value = field === "enabled" ? Boolean(event.target.checked) : event.target.value;
      if (updateQuickActionDraft(index, field, value)) refreshQuickActionsEditorDom(panel);
    });
    panel.addEventListener("click", (event) => {
      const button = event.target?.closest?.("[data-quick-action-command]");
      const command = button?.getAttribute?.("data-quick-action-command");
      if (!command || button.disabled) return;
      const index = Number.parseInt(button.getAttribute("data-quick-action-index"), 10);
      if (command === "save") {
        void saveQuickActionsConfig(quickActionsDraftConfig);
      } else if (mutateQuickActions(command, index)) {
        refreshQuickActionsEditorDom(panel);
        if (command === "reset") void saveQuickActionsConfig(quickActionsDraftConfig);
      }
    });
  }

  function renderFeatureToggle(plugin, disabled) {
    const enabled = isPluginSelected(plugin.id);
    return `
      <div class="pi-enh-module-feature" data-plugin-row="${plugin.id}">
        <div class="pi-enh-module-feature-copy">
          <span class="pi-enh-module-feature-name">${plugin.name}</span>
          <span class="pi-enh-module-feature-desc">${plugin.desc}</span>
          ${plugin.id === "session-attention-sound" ? `<button type="button" class="pi-enh-btn-sm" data-attention-sound-preview ${disabled ? "disabled" : ""}>试听审批提示音</button>` : ""}
        </div>
        <button type="button" role="switch" aria-checked="${enabled ? "true" : "false"}" aria-label="${plugin.name}" title="${enabled ? "点击禁用" : "点击启用"}" class="config-switch" data-plugin-toggle="${plugin.id}" ${disabled ? "disabled" : ""}>
          <span class="config-switch-knob" aria-hidden="true"></span>
        </button>
      </div>`;
  }

  const SUBAGENT_DISPATCH_CLIENT_ID = "subagent-dispatch-control";
  const SUBAGENT_DISPATCH_PREF_KEY = "pi-enh-plugin-subagent-dispatch-enabled";
  const SUBAGENT_DISPATCH_ORIGIN_SESSION_KEY = "pi-enh-plugin-subagent-dispatch-origin-session";
  const SUBAGENT_DISPATCH_RESUME_TOKEN_KEY = "pi-enh-plugin-subagent-dispatch-resume-token";
  const SUBAGENT_DISPATCH_MODULE_ID = "subagent-dispatch";

  let subagentDispatchCommitPromise = Promise.resolve();
  let subagentDispatchGeneration = 0;

  function getSubagentDispatchOriginSessionId() {
    try {
      let raw = "";
      if (typeof getCurrentSessionId === "function") {
        raw = getCurrentSessionId() || "";
      }
      if (!raw && typeof window !== "undefined" && window.location) {
        raw = new URLSearchParams(window.location.search).get("session") || "";
      }
      const match = String(raw).trim().match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      return match ? match[0] : "";
    } catch (e) {
      return "";
    }
  }

  async function syncSubagentDispatchRemoteState() {
    const currentGen = ++subagentDispatchGeneration;
    try {
      const isNative = window.__PI_ENH_NATIVE_STATE_API__ === true;
        const url = isNative
          ? `${getDurableStateBaseUrl()}/enhancement-state`
          : `${getDurableStateBaseUrl()}/enhancement-state?instance=${getDurableStateInstanceParam()}`;
      const data = await fetchSubagentJson(url, { timeoutMs: 20000 });
      if (currentGen !== subagentDispatchGeneration) return false;
      const clients = data?.state?.enhancementSettingsByClient;
      if (!data || data.ok !== true || !Number.isInteger(data.revision) || data.revision < 0 || !clients || typeof clients !== "object" || Array.isArray(clients)) {
        return false;
      }
      const remoteSettings = clients[SUBAGENT_DISPATCH_CLIENT_ID];
      let remoteEnabled = true;
      if (remoteSettings !== undefined) {
        if (!remoteSettings || typeof remoteSettings !== "object" || Array.isArray(remoteSettings)) return false;
        if (SUBAGENT_DISPATCH_PREF_KEY in remoteSettings) {
          const rawVal = remoteSettings[SUBAGENT_DISPATCH_PREF_KEY];
          if (rawVal !== "true" && rawVal !== "false") return false;
          remoteEnabled = rawVal === "true";
        }
      } else {
        // 合法 schema 且缺 flag：mirror 默认 true，解决 localfalse/servertrue 矛盾
        remoteEnabled = true;
      }
      if (currentGen !== subagentDispatchGeneration) return false;
      if (isModuleEnabled(SUBAGENT_DISPATCH_MODULE_ID) !== remoteEnabled) {
        setModuleEnabled(SUBAGENT_DISPATCH_MODULE_ID, remoteEnabled);
      }
      return true;
    } catch (e) {
      // 离线或异常保留本地，明确返回 false
      return false;
    }
  }

  async function commitSubagentDispatchRemoteState(enabled) {
    const isCurrentlyEnabled = isModuleEnabled(SUBAGENT_DISPATCH_MODULE_ID);
    const opId = generateDecorationOpUuid();
    const timestamp = Date.now();
    const isNative = window.__PI_ENH_NATIVE_STATE_API__ === true;
        const url = isNative
          ? `${getDurableStateBaseUrl()}/enhancement-state/operations`
          : `${getDurableStateBaseUrl()}/enhancement-state/operations?instance=${getDurableStateInstanceParam()}`;
    const originSession = getSubagentDispatchOriginSessionId();

    const values = {
      [SUBAGENT_DISPATCH_PREF_KEY]: String(enabled),
      [SUBAGENT_DISPATCH_ORIGIN_SESSION_KEY]: originSession,
    };

    // 协议规范：enabled && 当前权威/已确认本地module为false才设本次opId，关闭时空串，已 true 普通提交不得制造 token 重放
    const shouldSendResumeToken = !enabled || (enabled && !isCurrentlyEnabled);
    if (shouldSendResumeToken) {
      values[SUBAGENT_DISPATCH_RESUME_TOKEN_KEY] = !enabled ? "" : opId;
    }

    const payload = {
      operations: [
        {
          opId,
          type: "preferences_snapshot",
          timestamp,
          clientId: SUBAGENT_DISPATCH_CLIENT_ID,
          values,
        },
      ],
    };

    const result = await fetchSubagentJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      timeoutMs: 20000,
    });

    if (!result || result.ok !== true) {
      throw new Error(result?.error || "服务端写入状态失败");
    }

    const revision = Number(result?.revision);
    const ackOps = Array.isArray(result?.acknowledgedOpIds) ? result.acknowledgedOpIds : [];
    const clientPrefs = result?.state?.enhancementSettingsByClient?.[SUBAGENT_DISPATCH_CLIENT_ID];

    if (
      !Number.isInteger(revision) ||
      revision <= 0 ||
      !ackOps.includes(opId) ||
      !clientPrefs ||
      typeof clientPrefs !== "object" ||
      Array.isArray(clientPrefs)
    ) {
      throw new Error("服务端未确认写入或落盘状态不完整");
    }

    // 严谨 ACK：验证同一次 preferences_snapshot 中发送的各字段精确值及 opId/revision 后才本地镜像；
    // 缺 token 的普通提交保留服务端旧 token
    for (const [key, expectedVal] of Object.entries(values)) {
      if (clientPrefs[key] !== expectedVal) {
        throw new Error("服务端未确认写入或落盘状态不完整");
      }
    }

    subagentDispatchGeneration++;
    setModuleEnabled(SUBAGENT_DISPATCH_MODULE_ID, enabled);
    return true;
  }

  function enqueueSubagentDispatchCommit(enabled) {
    const task = () => commitSubagentDispatchRemoteState(enabled);
    subagentDispatchCommitPromise = subagentDispatchCommitPromise.then(task, task);
    return subagentDispatchCommitPromise;
  }

  if (typeof window !== "undefined") {
    window.__PI_ENH_SYNC_SUBAGENT_DISPATCH_REMOTE_STATE__ = syncSubagentDispatchRemoteState;
    window.__PI_ENH_COMMIT_SUBAGENT_DISPATCH_REMOTE_STATE__ = commitSubagentDispatchRemoteState;
    window.__PI_ENH_GET_DURABLE_STATE_BASE_URL__ = getDurableStateBaseUrl;
    window.__PI_ENH_GET_DURABLE_STATE_INSTANCE_PARAM__ = getDurableStateInstanceParam;
    window.__PI_ENH_SUBAGENT_DISPATCH_CLIENT_ID__ = SUBAGENT_DISPATCH_CLIENT_ID;
    window.__PI_ENH_SUBAGENT_DISPATCH_PREF_KEY__ = SUBAGENT_DISPATCH_PREF_KEY;
    window.__PI_ENH_SUBAGENT_DISPATCH_ORIGIN_SESSION_KEY__ = SUBAGENT_DISPATCH_ORIGIN_SESSION_KEY;
    window.__PI_ENH_SUBAGENT_DISPATCH_RESUME_TOKEN_KEY__ = SUBAGENT_DISPATCH_RESUME_TOKEN_KEY;
  }

  const SUBAGENT_MODEL_UNAVAILABLE_VALUE = "__subagent_model_unavailable__";
  const SUBAGENT_THINKING_LEVELS = [
    { value: "", label: "遵循默认 (inherit)" },
    { value: "off", label: "关闭 (off)" },
    { value: "minimal", label: "极简 (minimal)" },
    { value: "low", label: "低深度 (low)" },
    { value: "medium", label: "中深度 (medium)" },
    { value: "high", label: "高深度 (high)" },
    { value: "xhigh", label: "超高深度 (xhigh)" },
    { value: "max", label: "最大深度 (max)" },
  ];

  function normalizeSubagentModel(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function normalizeSubagentThinking(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function normalizeSubagentCwd(value) {
    const cwd = typeof value === "string" ? value.trim() : "";
    if (!cwd || cwd.includes("...")) return "";
    return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(cwd) ? cwd : "";
  }

  function getActiveSubagentCwd() {
    let sessionId = "";
    try {
      sessionId = typeof getCurrentSessionId === "function"
        ? (getCurrentSessionId() || "")
        : new URLSearchParams(window.location.search).get("session") || "";
      const sessionCwd = normalizeSubagentCwd(window.__PI_CURRENT_SESSION_DATA__?.info?.cwd);
      if (sessionCwd) return sessionCwd;
      if (sessionId && typeof knownSessionsMap !== "undefined" && knownSessionsMap?.get) {
        const knownSession = knownSessionsMap.get(sessionId);
        const knownCwd = normalizeSubagentCwd(knownSession?.cwd || knownSession?.projectRoot);
        if (knownCwd) return knownCwd;
      }
    } catch (e) {}

    try {
      if (typeof getEffectiveComposerCwdSyncOrEmpty === "function") {
        const composerCwd = normalizeSubagentCwd(getEffectiveComposerCwdSyncOrEmpty());
        if (composerCwd) return composerCwd;
      }
    } catch (e) {}

    try {
      const workspaceEl = document.querySelector("[data-current-cwd]") || document.querySelector(".workspace-picker-button");
      const candidates = [
        workspaceEl?.getAttribute("data-current-cwd"),
        workspaceEl?.getAttribute("title"),
        workspaceEl?.textContent,
      ];
      for (const candidate of candidates) {
        const cwd = normalizeSubagentCwd(candidate);
        if (cwd) return cwd;
      }
    } catch (e) {}
    return "";
  }

  const SUBAGENT_SETTINGS_TIMEOUT_MS = 20000;
  const SUBAGENT_PROFILES_TIMEOUT_MS = 20000;
  const SUBAGENT_MODELS_TIMEOUT_MS = 30000;

  async function fetchSubagentJson(url, options = {}) {
    const { timeoutMs = 20000, ...requestOptions } = options || {};
    let timeoutController = null;
    let timeoutId = null;
    const parentSignal = requestOptions.signal;
    let signal = parentSignal;
    let abortHandler = null;

    if (typeof AbortController === "function") {
      timeoutController = new AbortController();
      if (parentSignal) {
        if (parentSignal.aborted) {
          try { timeoutController.abort(parentSignal.reason); } catch (_) {}
        } else {
          abortHandler = () => {
            try { timeoutController.abort(parentSignal.reason); } catch (_) {}
          };
          parentSignal.addEventListener("abort", abortHandler);
        }
      }
      signal = timeoutController.signal;
      if (Number(timeoutMs) > 0) {
        timeoutId = setTimeout(() => {
          try { timeoutController.abort(new Error(`Timeout after ${timeoutMs}ms`)); } catch (_) {}
        }, Number(timeoutMs));
      }
    }
    try {
      const response = await fetch(url, {
        ...requestOptions,
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
      let data = {};
      try { data = await response.json(); } catch (e) {}
      if (!response.ok || data?.error) {
        throw new Error(typeof data?.error === "string" ? data.error : `HTTP ${response.status}`);
      }
      return data && typeof data === "object" ? data : {};
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (parentSignal && abortHandler) {
        try { parentSignal.removeEventListener("abort", abortHandler); } catch (_) {}
      }
    }
  }

  function syncSubagentModelControlDisabled(control) {
    if (!control) return;
    const state = control.__piEnhSubagentModelState;
    const featureId = control.getAttribute("data-subagent-model-feature") || "";
    const row = control.closest("[data-module-row]");
    const moduleId = row?.getAttribute("data-module-row") || "";
    const moduleDisabled = moduleId ? !isModuleEnabled(moduleId) : false;
    const featureDisabled = featureId ? !isPluginEnabled(featureId) : false;
    const commonDisabled = moduleDisabled || featureDisabled;

    // 禁用/特性禁用不能让重新读取按钮永久不可用！
    const reload = control.querySelector("[data-subagent-model-reload]");
    if (reload) {
      reload.disabled = Boolean(state?.loading) || Boolean(state?.savingProfiles && state.savingProfiles.size > 0);
    }

    // 只在 models 慢时 thinking 不必全禁用，select 按各自依赖 loaded/settingsLoaded/saving 状态
    for (const select of control.querySelectorAll("select[data-subagent-profile-model]")) {
      const prof = (select.getAttribute("data-subagent-profile-model") || "").toLowerCase();
      const isSavingThis = state?.savingProfiles?.has(prof);
      const canEditModel = Boolean(state?.settingsLoaded && state?.modelsLoaded && !state?.modelsError);
      select.disabled = commonDisabled || isSavingThis || !canEditModel;
    }

    for (const select of control.querySelectorAll("select[data-subagent-profile-thinking]")) {
      const prof = (select.getAttribute("data-subagent-profile-thinking") || "").toLowerCase();
      const isSavingThis = state?.savingProfiles?.has(prof);
      const canEditThinking = Boolean(state?.settingsLoaded);
      select.disabled = commonDisabled || isSavingThis || !canEditThinking;
    }
  }

  function renderSubagentModelControl(control, state) {
    if (!control || !state) return;
    const cwdNode = control.querySelector("[data-subagent-model-cwd]");
    const statusNode = control.querySelector("[data-subagent-model-status]");
    const matrixBody = control.querySelector("[data-subagent-matrix-body]");
    if (cwdNode) {
      cwdNode.textContent = state.cwd ? `当前 cwd：${state.cwd}` : "当前 cwd：未检测到有效工作目录";
      cwdNode.title = state.cwd || "";
    }

    if (!matrixBody) return;

    const profiles = Array.isArray(state.profiles) ? state.profiles : [];
    const hasProfiles = profiles.length > 0;

    // 初次读取且尚无任何 profile 时展示 loading
    if (state.loading && !hasProfiles && !state.profilesLoaded) {
      matrixBody.innerHTML = `<div class="pi-enh-subagent-message">正在读取子 Agent 列表、模型配置与服务端状态…</div>`;
      if (statusNode) statusNode.textContent = "正在读取子 Agent 列表与可用模型…";
      syncSubagentModelControlDisabled(control);
      return;
    }

    // 独立区分错误：profile 失败且没有已有 profile
    if (state.profilesError && !hasProfiles) {
      matrixBody.innerHTML = `<div class="pi-enh-subagent-message" data-error>无法读取子 Agent profile 列表；请检查连接后点击“重新读取”。</div>`;
      if (statusNode) statusNode.textContent = "子 Agent profile 列表读取失败。";
      syncSubagentModelControlDisabled(control);
      return;
    }

    // 独立区分错误：settings 失败且没有已有 profile
    if ((!state.settingsLoaded || state.settingsError) && !hasProfiles) {
      matrixBody.innerHTML = `<div class="pi-enh-subagent-message" data-error>无法读取服务端子任务设置；请检查连接后点击“重新读取”。</div>`;
      if (statusNode) statusNode.textContent = "服务端设置读取失败。";
      syncSubagentModelControlDisabled(control);
      return;
    }

    // 不错误显示空 profile：当且仅当 profilesLoaded 且 profiles 数组为空且无 profilesError 时，才显示未检测到
    if (!state.loading && state.profilesLoaded && profiles.length === 0 && !state.profilesError) {
      matrixBody.innerHTML = `<div class="pi-enh-subagent-message">${state.cwd ? "当前 cwd 下未检测到任何子 Agent profile。" : "当前没有有效 cwd，无法加载子 Agent 列表。"}</div>`;
      if (statusNode) statusNode.textContent = state.cwd ? "未找到可配置的子 Agent。" : "请在有效工作区会话下配置子 Agent。";
      syncSubagentModelControlDisabled(control);
      return;
    }

    // 如果 matrixBody 内当前只包含提示信息（.pi-enh-subagent-message），清空它准备渲染列表
    if (matrixBody.querySelector(".pi-enh-subagent-message")) {
      while (matrixBody.firstChild) matrixBody.removeChild(matrixBody.firstChild);
    }

    // profiles 更新成功后删除不在最新列表中的旧行（saving 中的除外）
    if (state.profilesLoaded) {
      const activeProfKeys = new Set(profiles.map((p) => String(p?.name || "").trim().toLowerCase()).filter(Boolean));
      for (const existingRow of matrixBody.querySelectorAll("[data-subagent-row]")) {
        const profKey = (existingRow.getAttribute("data-subagent-row") || "").trim().toLowerCase();
        if (profKey && !activeProfKeys.has(profKey) && !state.savingProfiles?.has(profKey)) {
          existingRow.remove();
        }
      }
    }

    const models = Array.isArray(state.models) ? state.models : [];
    const modelOptions = models.map((m) => {
      const provider = typeof m?.provider === "string" ? m.provider.trim() : "";
      const id = typeof m?.id === "string" ? m.id.trim() : "";
      if (!provider || !id) return null;
      const value = `${provider}/${id}`;
      const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : id;
      return { value, label: `${name} (${value})` };
    }).filter(Boolean);

    const overrides = state.overrides && typeof state.overrides === "object" ? state.overrides : {};

    for (const profile of profiles) {
      const profName = String(profile?.name || "").trim();
      if (!profName) continue;
      const profKey = profName.toLowerCase();
      const profOverride = overrides[profKey] || {};
      const configuredModel = normalizeSubagentModel(profOverride.model);
      const configuredThinking = normalizeSubagentThinking(profOverride.thinking) || "";
      const isSaving = state.savingProfiles?.has(profKey);

      // 就地更新以保护正在操作或保存的元素，不重绘破坏正在保存选择
      let row = matrixBody.querySelector(`[data-subagent-row="${CSS.escape ? CSS.escape(profName) : profName}"]`);
      if (row) {
        if (isSaving) {
          const statusSpan = row.querySelector(`[data-subagent-row-status="${profName}"]`);
          if (statusSpan) {
            statusSpan.textContent = "保存中…";
            statusSpan.style.color = "var(--text-muted)";
          }
          continue;
        }

        // 非 saving 状态下，增量更新 model 下拉菜单选项（慢 models 渐进到达时更新 options）
        const modelSelect = row.querySelector(`select[data-subagent-profile-model="${profName}"]`);
        if (modelSelect && document.activeElement !== modelSelect) {
          const defaultModelOpt = document.createElement("option");
          defaultModelOpt.value = "";
          defaultModelOpt.textContent = profile.model ? `遵循 profile (${profile.model})` : "遵循主会话模型";

          while (modelSelect.firstChild) modelSelect.removeChild(modelSelect.firstChild);
          modelSelect.appendChild(defaultModelOpt);

          let found = false;
          for (const m of modelOptions) {
            const opt = document.createElement("option");
            opt.value = m.value;
            opt.textContent = m.label;
            if (m.value === configuredModel) {
              opt.selected = true;
              found = true;
            }
            modelSelect.appendChild(opt);
          }
          if (configuredModel && !found) {
            const missingOpt = document.createElement("option");
            if (state.modelsLoaded) {
              missingOpt.value = SUBAGENT_MODEL_UNAVAILABLE_VALUE;
              missingOpt.textContent = `不可用: ${configuredModel}`;
              missingOpt.disabled = true;
            } else if (state.modelsError) {
              missingOpt.value = configuredModel;
              missingOpt.textContent = `${configuredModel} (模型列表加载失败)`;
            } else {
              missingOpt.value = configuredModel;
              missingOpt.textContent = `${configuredModel} (加载中…)`;
            }
            missingOpt.selected = true;
            modelSelect.appendChild(missingOpt);
          }
          if (!configuredModel) defaultModelOpt.selected = true;
        }

        const thinkingSelect = row.querySelector(`select[data-subagent-profile-thinking="${profName}"]`);
        if (thinkingSelect && document.activeElement !== thinkingSelect) {
          thinkingSelect.value = configuredThinking || "";
        }
        continue;
      }

      // 新增一行 profile
      row = document.createElement("div");
      row.className = "pi-enh-subagent-row";
      row.setAttribute("data-subagent-row", profName);

      const scopeText = profile.scope === "builtin" ? "内置" : profile.scope === "project" ? "项目" : "全局";
      const displayName = profile.displayName || profName;
      const desc = profile.description || "无描述";

      const infoCol = document.createElement("div");
      infoCol.className = "pi-enh-subagent-row-info";
      infoCol.innerHTML = `
        <div class="pi-enh-subagent-row-heading">
          <strong class="pi-enh-subagent-row-name">${escapeQuickActionHtml(displayName)}</strong>
          <span class="pi-enh-subagent-row-scope">${escapeQuickActionHtml(scopeText)}</span>
          ${profile.model ? `<span class="pi-enh-subagent-row-default" title="Profile 自身默认模型: ${escapeQuickActionHtml(profile.model)}">(默认: ${escapeQuickActionHtml(profile.model)})</span>` : ""}
        </div>
        <span class="pi-enh-subagent-row-description" title="${escapeQuickActionHtml(desc)}">${escapeQuickActionHtml(desc)}</span>
      `;
      row.appendChild(infoCol);

      const ctrlCol = document.createElement("div");
      ctrlCol.className = "pi-enh-subagent-row-controls";

      // Model Select
      const modelLabel = document.createElement("label");
      modelLabel.innerHTML = `<span>模型:</span>`;
      const modelSelect = document.createElement("select");
      modelSelect.setAttribute("data-subagent-profile-model", profName);
      modelSelect.setAttribute("aria-label", `${displayName} 模型`);

      const defaultModelOpt = document.createElement("option");
      defaultModelOpt.value = "";
      defaultModelOpt.textContent = profile.model ? `遵循 profile (${profile.model})` : "遵循主会话模型";
      modelSelect.appendChild(defaultModelOpt);

      let foundConfigured = false;
      for (const m of modelOptions) {
        const opt = document.createElement("option");
        opt.value = m.value;
        opt.textContent = m.label;
        if (m.value === configuredModel) {
          opt.selected = true;
          foundConfigured = true;
        }
        modelSelect.appendChild(opt);
      }
      if (configuredModel && !foundConfigured) {
        const missingOpt = document.createElement("option");
        if (state.modelsLoaded) {
          missingOpt.value = SUBAGENT_MODEL_UNAVAILABLE_VALUE;
          missingOpt.textContent = `不可用: ${configuredModel}`;
          missingOpt.disabled = true;
        } else if (state.modelsError) {
          missingOpt.value = configuredModel;
          missingOpt.textContent = `${configuredModel} (模型列表加载失败)`;
        } else {
          missingOpt.value = configuredModel;
          missingOpt.textContent = `${configuredModel} (加载中…)`;
        }
        missingOpt.selected = true;
        modelSelect.appendChild(missingOpt);
      }
      if (!configuredModel) defaultModelOpt.selected = true;
      modelLabel.appendChild(modelSelect);
      ctrlCol.appendChild(modelLabel);

      // Thinking Select
      const thinkingLabel = document.createElement("label");
      thinkingLabel.innerHTML = `<span>思考:</span>`;
      const thinkingSelect = document.createElement("select");
      thinkingSelect.setAttribute("data-subagent-profile-thinking", profName);
      thinkingSelect.setAttribute("aria-label", `${displayName} 思考深度`);

      for (const lvl of SUBAGENT_THINKING_LEVELS) {
        const opt = document.createElement("option");
        opt.value = lvl.value;
        opt.textContent = lvl.label;
        if (lvl.value === configuredThinking) opt.selected = true;
        thinkingSelect.appendChild(opt);
      }
      thinkingLabel.appendChild(thinkingSelect);
      ctrlCol.appendChild(thinkingLabel);

      // Status indicator
      const statusSpan = document.createElement("span");
      statusSpan.setAttribute("data-subagent-row-status", profName);
      statusSpan.className = "pi-enh-subagent-row-status";
      if (isSaving) statusSpan.textContent = "保存中…";
      ctrlCol.appendChild(statusSpan);

      row.appendChild(ctrlCol);
      matrixBody.appendChild(row);
    }

    if (statusNode) {
      const warnings = [];
      if (state.settingsError) warnings.push("服务端设置读取失败(已保留已有配置)");
      if (state.profilesError) warnings.push("子 Agent profiles 更新失败");
      if (state.modelsError) warnings.push("模型列表加载失败");

      if (warnings.length > 0) {
        statusNode.textContent = warnings.join("；") + "。";
      } else if (state.loading) {
        statusNode.textContent = "已加载子 Agent profiles；正在读取最新模型配置…";
      } else {
        statusNode.textContent = "每个子 Agent 独立配置模型与思考深度；单次调用显式参数优先。";
      }
    }
    syncSubagentModelControlDisabled(control);
  }

  async function loadSubagentModelControl(control, state) {
    if (!control || !state) return;
    try { state.controller?.abort(); } catch (e) {}
    const token = (state.requestToken || 0) + 1;
    state.requestToken = token;
    state.loading = true;
    state.settingsError = null;
    state.modelsError = null;
    state.profilesError = null;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    state.controller = controller;
    renderSubagentModelControl(control, state);

    const sessionId = (typeof getCurrentSessionId === "function" ? getCurrentSessionId() : "") || new URLSearchParams(window.location.search).get("session") || "";
    const isCurrent = () => control.isConnected && control.__piEnhSubagentModelState === state && state.requestToken === token;

    // The native workspace picker no longer exports the old DOM/global cwd contract.
    // Read this session's canonical header, never guess another workspace or POST default-cwd.
    if (!state.cwd && sessionId) {
      try {
        const sessionData = await fetchSubagentJson(`/api/sessions/${encodeURIComponent(sessionId)}?tree=summary&tail=1&deferThinking=1&deferMedia=1`, { signal: controller?.signal, timeoutMs: SUBAGENT_SETTINGS_TIMEOUT_MS });
        if (!isCurrent()) return;
        state.cwd = normalizeSubagentCwd(sessionData?.info?.cwd);
        if (!state.cwd) state.profilesError = new Error("当前会话工作目录无效");
      } catch (error) {
        if (!isCurrent()) return;
        state.profilesError = error;
      }
    }

    // 接口独立超时：设置与 profile 20s，models 30s
    // 独立渐进渲染：慢 models 不得阻塞 profiles/设置，区分错误并保留已有覆盖
    const settingsPromise = fetchSubagentJson("/api/subagents/settings", {
      signal: controller?.signal,
      timeoutMs: SUBAGENT_SETTINGS_TIMEOUT_MS,
    }).then((data) => {
      if (!isCurrent()) return;
      if (data && typeof data === "object" && data.subagentOverrides && typeof data.subagentOverrides === "object") {
        const nextOverrides = { ...data.subagentOverrides };
        if (state.savingProfiles && state.savingProfiles.size > 0 && state.overrides) {
          for (const savingProf of state.savingProfiles) {
            if (state.overrides[savingProf] !== undefined) {
              nextOverrides[savingProf] = state.overrides[savingProf];
            }
          }
        }
        state.overrides = nextOverrides;
      }
      state.globalModel = normalizeSubagentModel(data?.subagentModel);
      state.settingsLoaded = true;
      state.settingsError = null;
      renderSubagentModelControl(control, state);
    }).catch((err) => {
      if (!isCurrent()) return;
      state.settingsError = err;
      renderSubagentModelControl(control, state);
    });

    const profilesPromise = (state.profilesError && !state.cwd
      ? Promise.reject(state.profilesError)
      : state.cwd ? fetchSubagentJson(`/api/subagents/profiles?cwd=${encodeURIComponent(state.cwd)}`, {
          signal: controller?.signal,
          timeoutMs: SUBAGENT_PROFILES_TIMEOUT_MS,
        })
      : Promise.resolve({ profiles: [] })
    ).then((data) => {
      if (!isCurrent()) return;
      if (Array.isArray(data?.profiles)) {
        state.profiles = data.profiles;
        state.profilesLoaded = true;
        state.profilesError = null;
      } else {
        state.profilesError = new Error("子 Agent profiles 格式无效");
      }
      renderSubagentModelControl(control, state);
    }).catch((err) => {
      if (!isCurrent()) return;
      state.profilesError = err;
      renderSubagentModelControl(control, state);
    });

    const modelsPromise = (state.cwd
      ? fetchSubagentJson(`/api/models?cwd=${encodeURIComponent(state.cwd)}`, {
          signal: controller?.signal,
          timeoutMs: SUBAGENT_MODELS_TIMEOUT_MS,
        })
      : Promise.resolve({ modelList: [] })
    ).then((data) => {
      if (!isCurrent()) return;
      if (Array.isArray(data?.modelList)) {
        state.models = data.modelList;
        state.modelsLoaded = true;
        state.modelsError = data.modelError ? new Error(String(data.modelError)) : null;
      } else {
        state.modelsError = new Error("可用模型列表格式无效");
      }
      renderSubagentModelControl(control, state);
    }).catch((err) => {
      if (!isCurrent()) return;
      state.modelsError = err;
      renderSubagentModelControl(control, state);
    });

    try {
      await Promise.allSettled([settingsPromise, profilesPromise, modelsPromise]);
    } finally {
      if (isCurrent()) {
        state.loading = false;
        if (state.controller === controller) state.controller = null;
        renderSubagentModelControl(control, state);
      }
    }
  }

  async function saveSubagentProfileOverride(control, state, profileName) {
    if (!control || !state || !state.settingsLoaded || !profileName) return;
    const profKey = profileName.toLowerCase();
    const modelSelect = control.querySelector(`select[data-subagent-profile-model="${profileName}"]`);
    const thinkingSelect = control.querySelector(`select[data-subagent-profile-thinking="${profileName}"]`);
    if (!modelSelect || !thinkingSelect) return;

    const rawModel = String(modelSelect.value || "");
    if (rawModel === SUBAGENT_MODEL_UNAVAILABLE_VALUE) return;
    const nextModel = normalizeSubagentModel(rawModel);
    const nextThinking = normalizeSubagentThinking(thinkingSelect.value);

    const prevOverride = state.overrides?.[profKey] || {};
    const prevModel = normalizeSubagentModel(prevOverride.model);
    const prevThinking = normalizeSubagentThinking(prevOverride.thinking);

    if (nextModel === prevModel && nextThinking === prevThinking) return;

    if (!state.savingProfiles) state.savingProfiles = new Set();
    state.savingProfiles.add(profKey);

    const statusNode = control.querySelector(`[data-subagent-row-status="${profileName}"]`);
    if (statusNode) {
      statusNode.textContent = "保存中…";
      statusNode.style.color = "var(--text-muted)";
    }
    syncSubagentModelControlDisabled(control);

    try {
      const data = await fetchSubagentJson("/api/subagents/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profileOverride: {
            profile: profileName,
            model: nextModel,
            thinking: nextThinking,
          },
        }),
        timeoutMs: SUBAGENT_SETTINGS_TIMEOUT_MS,
      });

      if (!control.isConnected || control.__piEnhSubagentModelState !== state) return;

      state.overrides = (data && typeof data === "object" && data.subagentOverrides && typeof data.subagentOverrides === "object")
        ? data.subagentOverrides
        : state.overrides || {};

      state.savingProfiles.delete(profKey);
      if (statusNode) {
        statusNode.textContent = "✓ 已存";
        statusNode.style.color = "#22c55e";
        setTimeout(() => {
          if (control.isConnected && statusNode.textContent === "✓ 已存") statusNode.textContent = "";
        }, 2500);
      }
      syncSubagentModelControlDisabled(control);
      if (typeof showToast === "function") {
        showToast(`子 Agent [${profileName}] 配置已保存`);
      }
    } catch (error) {
      if (!control.isConnected || control.__piEnhSubagentModelState !== state) return;
      console.warn(`[Agent Web Plus Enhancements] 保存子 Agent ${profileName} 配置失败:`, error);
      state.savingProfiles.delete(profKey);
      // Rollback
      if (prevModel) modelSelect.value = prevModel;
      else modelSelect.value = "";
      thinkingSelect.value = prevThinking || "";
      if (statusNode) {
        statusNode.textContent = "失败";
        statusNode.style.color = "#ef4444";
      }
      syncSubagentModelControlDisabled(control);
      if (typeof showToast === "function") {
        showToast(`子 Agent [${profileName}] 配置保存失败，请重试`, null, 5000);
      }
    }
  }

  function bindSubagentModelControls(panel) {
    for (const control of panel.querySelectorAll("[data-subagent-model-control]")) {
      const state = {
        cwd: getActiveSubagentCwd(),
        profiles: [],
        models: [],
        overrides: {},
        globalModel: null,
        loading: false,
        savingProfiles: new Set(),
        settingsLoaded: false,
        profilesLoaded: false,
        modelsLoaded: false,
        settingsError: null,
        modelsError: null,
        profilesError: null,
        requestToken: 0,
        controller: null,
      };
      control.__piEnhSubagentModelState = state;
      const reload = control.querySelector("[data-subagent-model-reload]");
      reload?.addEventListener("click", () => {
        // 防二次点击：仅当不在 loading 且没有正在 saving 的 profile 时执行重新读取
        if (!state.loading && (!state.savingProfiles || state.savingProfiles.size === 0)) {
          void loadSubagentModelControl(control, state);
        }
      });

      control.addEventListener("change", (event) => {
        const target = event.target;
        if (!target || target.tagName !== "SELECT") return;
        const profName = target.getAttribute("data-subagent-profile-model") || target.getAttribute("data-subagent-profile-thinking");
        if (profName) {
          void saveSubagentProfileOverride(control, state, profName);
        }
      });

      void loadSubagentModelControl(control, state);
    }
  }

  function renderModuleSettingControl(setting, disabled) {
    if (setting.kind === "subagent-model") {
      const featureId = escapeQuickActionHtml(setting.featureId || "");
      const label = escapeQuickActionHtml(setting.label || "子 Agent 独立模型与思考深度");
      const description = escapeQuickActionHtml(setting.description || "为每个子 Agent 独立配置专属模型与思考深度；单次调用显式参数优先。");
      return `<div class="pi-enh-subagent-model-setting" data-subagent-model-control data-subagent-model-feature="${featureId}">
        <div class="pi-enh-subagent-model-header">
          <div class="pi-enh-subagent-model-copy">
            <span class="pi-enh-subagent-model-label">${label}</span>
            <span class="pi-enh-subagent-model-description">${description}</span>
            <span class="pi-enh-subagent-model-policy-hint" data-subagent-model-policy-hint>关闭仅禁止新派发；已运行任务继续。重新开启后，运行会话按需恢复委派，不重复任务。</span>
            <span class="pi-enh-subagent-model-cwd" data-subagent-model-cwd>当前 cwd：读取中…</span>
          </div>
          <button type="button" class="pi-enh-btn-sm" data-subagent-model-reload ${disabled ? "disabled" : ""}>重新读取</button>
        </div>
        <div class="pi-enh-subagent-matrix-body" data-subagent-matrix-body>
          <div class="pi-enh-subagent-message">正在读取状态…</div>
        </div>
        <span class="pi-enh-subagent-model-status" data-subagent-model-status role="status" aria-live="polite">正在读取模型设置…</span>
      </div>`;
    }
    if (setting.kind === "action") {
      return `<button type="button" class="pi-enh-btn-sm" data-plugin-action="${setting.action}" ${disabled ? "disabled" : ""}>${setting.label}</button>`;
    }
    const definition = getPluginSettingDefinition(setting.featureId, setting.key);
    if (!definition) return "";
    const value = getPluginSetting(setting.featureId, setting.key);
    const identity = `${setting.featureId}:${setting.key}`;
    const legacyDataAttribute = setting.featureId === "minimap-full-nav" && setting.key === "initialTurns" ? "data-minimap-initial-turns" : setting.featureId === "minimap-full-nav" && setting.key === "stepTurns" ? "data-minimap-step-turns" : setting.featureId === "session-pin-archive" && setting.key === "retentionDays" ? "data-archive-retention-select" : "";
    if (definition.type === "select") {
      const getOptionLabel = (option) => {
        if (setting.key === "autoRestoreOnPrompt") {
          return option === 1 ? "自动唤醒（恢复至列表并置顶）" : "保持归档（不自动恢复）";
        }
        if (setting.key === "deviceMode") {
          if (option === "desktop") return "强制电脑桌面（Enter 发送，Shift+Enter 换行）";
          if (option === "mobile") return "强制移动端（Enter 换行，点击发送）";
          return "智能自动识别（精准区分触屏电脑与手机）";
        }
        return option === 0 ? "永不自动删除" : `${option} 天后自动删除`;
      };
      return `<label class="pi-enh-plugin-number-setting"><span>${setting.label}</span><select ${legacyDataAttribute} data-plugin-setting="${identity}" aria-label="${setting.label}" ${disabled ? "disabled" : ""}>${definition.options.map((option) => `<option value="${option}" ${String(value) === String(option) ? "selected" : ""}>${getOptionLabel(option)}</option>`).join("")}</select></label>`;
    }
    if (definition.type === "range") {
      const isMobile = typeof isMobileEnvironment === "function" && isMobileEnvironment();
      const minVal = isMobile && setting.key === "maxSessions" ? 5 : definition.min;
      const maxVal = isMobile && setting.key === "maxSessions" ? 30 : definition.max;
      const currentVal = isMobile && setting.key === "maxSessions" ? getSessionMemoryCacheLimit() : value;
      const hintText = isMobile && setting.key === "maxSessions" ? "(手机端默认15，推荐10~25)" : setting.key === "swipeDistance" ? "(默认30，推荐20~50)" : "(推荐 30~80)";
      return `<div class="pi-enh-plugin-range-setting" style="display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;"><span>${setting.label}</span><input type="range" data-plugin-setting-range="${identity}" min="${minVal}" max="${maxVal}" step="${definition.step || 1}" value="${currentVal}" ${disabled ? "disabled" : ""} style="width:110px;accent-color:var(--accent,#38bdf8);cursor:pointer;" aria-label="${setting.label}滑块"><input ${legacyDataAttribute} type="number" inputmode="numeric" data-plugin-setting="${identity}" aria-label="${setting.label}" min="${minVal}" max="${maxVal}" step="${definition.step || 1}" value="${currentVal}" ${disabled ? "disabled" : ""} style="width:48px;padding:2px 4px;border-radius:5px;background:var(--bg-hover,rgba(255,255,255,0.08));border:1px solid var(--border,#27272a);color:var(--text,#f4f4f5);font-size:11.5px;text-align:center;"><span>${setting.unit || ""}</span><span style="font-size:11px;opacity:0.65;color:var(--text-muted,#a1a1aa);">${hintText}</span></div>`;
    }
    return `<label class="pi-enh-plugin-number-setting"><span>${setting.label}</span><input ${legacyDataAttribute} type="number" inputmode="numeric" data-plugin-setting="${identity}" aria-label="${setting.label}" min="${definition.min}" max="${definition.max}" step="1" value="${value}" ${disabled ? "disabled" : ""}><span>${setting.unit || ""}</span></label>`;
  }

  function moduleStateLabel(state, enabled) {
    if (typeof enabled === "boolean") {
      if (!enabled) return `已关闭 0/${state.total}`;
      return `${state.selected === state.total ? "全部开启" : (state.selected === 0 ? "已启用" : "部分开启")} ${state.selected}/${state.total}`;
    }
    return state.state === "off" ? `已关闭 0/${state.total}` : `${state.state === "partial" ? "部分开启" : "全部开启"} ${state.active}/${state.total}`;
  }

  if (typeof window !== "undefined") {
    window.moduleStateLabel = moduleStateLabel;
  }

  function getKernelHealthSummary() {
    const kh = (typeof window !== "undefined" && window.__PI_ENH_KERNEL_HEALTH__) || null;
    const isolatedList = Array.isArray(kh?.isolatedErrors) ? kh.isolatedErrors : [];
    const syncErrCount = (typeof syncOperationErrors !== "undefined" && syncOperationErrors instanceof Map) ? syncOperationErrors.size : 0;
    const totalIsolated = isolatedList.length + syncErrCount;
    const isInline = typeof document !== "undefined" && !document.getElementById("pi-web-enhancements-script");
    const modeLabel = isInline ? "首帧 0ms 内联直出" : "热载沙箱运行中";
    const state = totalIsolated === 0 ? "healthy" : "isolated-warn";
    const text = totalIsolated === 0
      ? `微内核沙箱：0 异常 · ${modeLabel}`
      : `微内核沙箱：已隔离 ${totalIsolated} 项异常 · ${modeLabel}`;
    const bootTimeStr = kh?.bootedAt ? new Date(kh.bootedAt).toLocaleTimeString() : "即时";
    const editionStr = kh?.edition || "agent-web-standalone-1.0.0";
    const detailLines = [
      `发行版内核：${editionStr} (v${ENHANCEMENT_SUITE_VERSION})`,
      `加载模式：${isInline ? "layout chunk 编译期静态内联 (0 网络请求 / 0ms 延迟)" : "动态热重载模式"}`,
      `首屏同步挂载：${kh?.initialSyncCompleted !== false ? "已完成 (initialDomSyncImmediate)" : "等待中"}`,
      `启动时间：${bootTimeStr}`,
      `已注册插件：${ENHANCEMENT_PLUGINS.length} 项 (${ENHANCEMENT_MODULES.length} 个模块)`,
      `异常隔离计数：${totalIsolated} 项`,
    ];
    if (isolatedList.length > 0) {
      detailLines.push(`隔离详情：${isolatedList.map((e) => `${e.step}: ${e.error}`).join("; ")}`);
    }
    return {
      state,
      text,
      title: detailLines.join(" | "),
      totalIsolated,
      isInline,
    };
  }

  const KERNEL_SHIELD_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline></svg>';

  function renderKernelHealthBadgeHtml() {
    const summary = getKernelHealthSummary();
    return `<span class="pi-enh-kernel-health-badge" data-kernel-health-badge data-state="${summary.state}" title="${escapeQuickActionHtml(summary.title)}">${KERNEL_SHIELD_SVG}<span data-kernel-health-text>${escapeQuickActionHtml(summary.text)}</span></span>`;
  }

  function syncEnhancementPanelControls() {
    const panel = document.querySelector(".pi-enh-plugins-panel");
    if (!panel) return;
    for (const row of panel.querySelectorAll("[data-module-row]")) {
      const id = row.getAttribute("data-module-row");
      const state = getModuleState(id);
      if (!state) continue;
      const enabled = isModuleEnabled(id);
      const disabled = !enabled;
      row.setAttribute("data-enabled", String(enabled));
      const master = row.querySelector("[data-module-toggle]");
      const label = row.querySelector("[data-module-status]");

      if (id === SUBAGENT_DISPATCH_MODULE_ID) {
        if (master) {
          master.setAttribute("aria-checked", String(enabled));
          master.setAttribute("data-state", enabled ? "on" : "off");
          master.setAttribute("title", enabled ? "关闭整组，保留子功能选择" : (state.selected ? "恢复之前的子功能选择" : "开启默认子功能（不启用实验与授权功能）"));
        }
        if (label) {
          label.textContent = moduleStateLabel(state, enabled);
          label.setAttribute("data-state", enabled ? "on" : "off");
        }
      } else {
        // 其他七模块严格保留原有 mixed aria 与 partial 状态机
        if (master) {
          master.setAttribute("aria-checked", state.state === "partial" ? "mixed" : String(state.state === "on"));
          master.setAttribute("data-state", state.state);
          master.setAttribute("title", state.active ? "关闭整组，保留子功能选择" : (state.selected ? "恢复之前的子功能选择" : "开启默认子功能（不启用实验与授权功能）"));
        }
        if (label) {
          label.textContent = moduleStateLabel(state);
          label.setAttribute("data-state", state.state);
        }
      }
      const details = row.querySelector("[data-module-settings]");
      details?.setAttribute("data-module-disabled", String(disabled));
      for (const toggle of row.querySelectorAll("[data-plugin-toggle]")) {
        const selected = isPluginSelected(toggle.getAttribute("data-plugin-toggle"));
        toggle.setAttribute("aria-checked", String(selected));
        toggle.setAttribute("title", selected ? "点击禁用" : "点击启用");
        toggle.disabled = disabled;
      }
      for (const input of row.querySelectorAll("[data-plugin-setting]")) {
        const [featureId, key] = input.getAttribute("data-plugin-setting").split(":");
        input.disabled = disabled || !isPluginEnabled(featureId);
        if (document.activeElement !== input) input.value = String(getPluginSetting(featureId, key));
      }
      for (const range of row.querySelectorAll("[data-plugin-setting-range]")) {
        const [featureId, key] = range.getAttribute("data-plugin-setting-range").split(":");
        range.disabled = disabled || !isPluginEnabled(featureId);
        if (document.activeElement !== range) range.value = String(getPluginSetting(featureId, key));
      }
      for (const control of row.querySelectorAll("[data-subagent-model-control]")) {
        syncSubagentModelControlDisabled(control);
      }
      for (const action of row.querySelectorAll("[data-plugin-action], [data-attention-sound-preview]")) action.disabled = disabled;
    }
    refreshQuickActionsEditorDom(panel);
    const count = panel.querySelector("[data-enabled-count]");
    if (count) count.textContent = `${ENHANCEMENT_MODULES.filter(m => getModuleState(m.id).active > 0).length} / ${ENHANCEMENT_MODULES.length} 个模块已启用`;
    const khBadge = panel.querySelector("[data-kernel-health-badge]");
    if (khBadge) {
      const summary = getKernelHealthSummary();
      khBadge.setAttribute("data-state", summary.state);
      khBadge.setAttribute("title", summary.title);
      const khText = khBadge.querySelector("[data-kernel-health-text]");
      if (khText) khText.textContent = summary.text;
      else khBadge.innerHTML = `${KERNEL_SHIELD_SVG}<span data-kernel-health-text>${escapeQuickActionHtml(summary.text)}</span>`;
    }
  }

  function updateSyncCardView(card, data) {
    if (!card) return;
    const badge = card.querySelector("[data-sync-badge]");
    const sourceDetail = card.querySelector("[data-sync-source-detail]");
    const targetDetail = card.querySelector("[data-sync-target-detail]");
    const windowsDetail = card.querySelector("[data-sync-windows-detail]");
    const macDetail = card.querySelector("[data-sync-mac-detail]");
    const syncBtn = card.querySelector('[data-sync-action="sync"]');
    const rollbackBtn = card.querySelector('[data-sync-action="rollback"]');
    const targetToggles = card.querySelectorAll("[data-sync-target-toggle]");
    const notice = card.querySelector("[data-sync-notice]");
    const message = data?.message || "跨实例同步后端未配置";

    if (badge) {
      badge.setAttribute("data-state", "DISCONNECTED");
      badge.textContent = message;
    }
    if (notice) notice.textContent = "不同独立实例间的增强插件分发需要部署同步后端，目前未配置。此状态不影响同一后台内由 Agent Web Plus 原生共享的会话与置顶状态。";
    if (sourceDetail) sourceDetail.textContent = "Agent Web Plus 当前实例";
    if (targetDetail) targetDetail.textContent = "目标实例 1 · 未配置";
    if (windowsDetail) windowsDetail.textContent = "目标实例 2 · 未配置";
    if (macDetail) macDetail.textContent = "目标实例 3 · 未配置";
    for (const toggle of targetToggles) toggle.disabled = true;
    if (syncBtn) syncBtn.disabled = true;
    if (rollbackBtn) rollbackBtn.disabled = true;
  }

  async function fetchSyncStatus(card) {
    updateSyncCardView(card, { ok: false, message: "跨实例同步后端未配置" });
    return null;
  }

  function initCrossDeviceSyncController(card) {
    if (!card) return;
    updateSyncCardView(card, { ok: false, message: "跨实例同步后端未配置" });
    card.querySelector('[data-sync-action="refresh"]')?.addEventListener("click", () => {
      fetchSyncStatus(card);
      showToast("跨实例同步后端未配置");
    });
  }

  function applyEnhancementPanelFilter(panel) {
    const query = enhancementPanelFilter.query.trim().toLocaleLowerCase();
    let visibleCount = 0;

    for (const row of panel.querySelectorAll("[data-module-row]")) {
      const module = getEnhancementModule(row.getAttribute("data-module-row"));
      const featureText = module?.features.map((featureId) => {
        const plugin = ENHANCEMENT_PLUGINS.find((item) => item.id === featureId);
        return plugin ? `${plugin.name} ${plugin.desc}` : "";
      }).join(" ") || "";
      const matchesCategory = enhancementPanelFilter.category === "all" || module?.category === enhancementPanelFilter.category;
      const searchable = module ? `${module.name} ${module.desc} ${module.category} ${featureText}`.toLocaleLowerCase() : "";
      const visible = Boolean(matchesCategory && (!query || searchable.includes(query)));
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    }

    for (const button of panel.querySelectorAll("[data-plugin-category]")) {
      const active = button.getAttribute("data-plugin-category") === enhancementPanelFilter.category;
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }

    const resultCount = panel.querySelector("[data-plugin-count]");
    if (resultCount) {
      const filtering = Boolean(query || enhancementPanelFilter.category !== "all");
      resultCount.textContent = filtering ? `显示 ${visibleCount} / ${ENHANCEMENT_MODULES.length} 个模块` : `共 ${ENHANCEMENT_MODULES.length} 个模块`;
    }
    const emptyState = panel.querySelector("[data-plugin-empty]");
    if (emptyState) emptyState.hidden = visibleCount !== 0;
  }

  function renderEnhancementsPanel(panel, nav) {
    if (!panel) return;
    if (!panel.classList.contains("pi-enh-plugins-panel")) panel.classList.add("pi-enh-plugins-panel");
    if (!panel) return;
    if (!panel.classList.contains("pi-enh-plugins-panel")) panel.classList.add("pi-enh-plugins-panel");
    // Keep the v3 renderer as a one-release recovery surface while v4 modules
    // migrate existing browser preferences. Normal users always get modules.
    if (!window.__PI_ENH_LEGACY_SETTINGS_RENDERER__) return renderEnhancementModulesPanel(panel, nav);

    const enabledCount = ENHANCEMENT_PLUGINS.filter((p) => isPluginEnabled(p.id)).length;
    const categories = [...new Set(ENHANCEMENT_PLUGINS.map((plugin) => plugin.category))];
    const archivedSessionIds = [...readStoredSessionIds(ARCHIVED_SESSION_STORAGE_KEY)];
    panel.innerHTML = `
      <div class="settings-general-container pi-enh-plugins-shell">
        <section class="pi-enh-plugins-toolbar" aria-label="增强插件管理工具栏">
          <div class="pi-enh-plugins-heading-row">
            <div class="pi-enh-plugins-title-wrap">
              <h2 class="settings-general-title pi-enh-plugins-title">
                <span>网页增强插件</span>
                <span class="pi-enh-plugins-enabled-count" data-enabled-count>${enabledCount} / ${ENHANCEMENT_PLUGINS.length} 已启用</span>
              </h2>
              <p class="pi-enh-plugins-description">管理网页端交互、显示及保护增强特性。设置即时生效，并保存在当前浏览器。</p>
            </div>
            <div class="pi-enh-plugins-actions" aria-label="批量操作">
              <button type="button" class="pi-enh-btn-sm pi-enh-btn-primary" data-action="hot-reload" title="无感重新加载最新前端补丁，无需刷新或重启后台">↻ 重新热载</button>
              <button type="button" class="pi-enh-btn-sm" data-action="force-hard-reload" style="color: #fca5a5; border-color: rgba(239, 68, 68, 0.38);" title="穿透 HTTP 强缓存更新前端静态资源并强制刷新">⚡ 强制刷新</button>
              <button type="button" class="pi-enh-btn-sm" data-action="enable-all" title="开启全部增强">全部开启</button>
              <button type="button" class="pi-enh-btn-sm" data-action="disable-all" title="关闭全部增强">全部关闭</button>
              <button type="button" class="pi-enh-btn-sm" data-action="reset-defaults" title="恢复默认开启状态">恢复默认</button>
            </div>
          </div>
          <div class="pi-enh-plugins-filter-row" role="search">
            <label class="pi-enh-plugin-search-wrap">
              <svg class="pi-enh-plugin-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
              <input class="pi-enh-plugin-search" type="search" data-plugin-search aria-label="搜索增强插件" placeholder="搜索插件…" autocomplete="off">
            </label>
            <div class="pi-enh-category-filters" role="group" aria-label="按类别筛选">
              <button type="button" class="pi-enh-category-btn" data-plugin-category="all" aria-pressed="${enhancementPanelFilter.category === "all" ? "true" : "false"}">全部</button>
              ${categories.map((category) => `<button type="button" class="pi-enh-category-btn" data-plugin-category="${category}" aria-pressed="${enhancementPanelFilter.category === category ? "true" : "false"}">${category}</button>`).join("")}
            </div>
            <span class="pi-enh-plugin-result-count" data-plugin-count aria-live="polite">共 ${ENHANCEMENT_PLUGINS.length} 个</span>
          </div>
        </section>

        <div class="pi-enh-sync-card" data-pi-enh-sync-card>
          <div class="pi-enh-sync-header">
            <div class="pi-enh-sync-title-wrap">
              <span class="pi-enh-sync-title">跨实例增强插件分发</span>
              <span class="pi-enh-sync-status-badge" data-sync-badge data-state="DISCONNECTED">跨实例同步后端未配置</span>
            </div>
            <div class="pi-enh-sync-actions">
              <button type="button" class="pi-enh-btn-sm pi-enh-btn-primary" data-sync-action="sync" title="跨实例同步后端未配置" disabled>跨实例分发未配置</button>
              <button type="button" class="pi-enh-btn-sm" data-sync-action="rollback" title="跨实例同步后端未配置" disabled>跨实例回滚未配置</button>
              <button type="button" class="pi-enh-btn-sm" data-sync-action="refresh" title="显示跨实例同步配置状态">刷新</button>
            </div>
          </div>
          <p data-sync-notice style="margin: 0 0 10px; color: var(--text-muted); font-size: 12px; line-height: 1.5;">不同独立实例间的增强插件分发需要部署同步后端，目前未配置。此状态不影响同一后台内由 Agent Web Plus 原生共享的会话与置顶状态。</p>
          <div class="pi-enh-sync-body" data-sync-body>
            <div class="pi-enh-sync-node pi-enh-sync-node-source" data-sync-node="source"><span class="pi-enh-sync-node-name">Agent Web Plus 当前实例（源）</span><span class="pi-enh-sync-node-detail" data-sync-source-detail>当前实例</span></div>
            <div class="pi-enh-sync-arrow" data-sync-arrow aria-hidden="true">➔</div>
            <div class="pi-enh-sync-targets-col">
              <div class="pi-enh-sync-node" data-sync-node="target-colleague"><label class="pi-enh-sync-target-check-wrap" title="目标实例 1 尚未配置"><span class="pi-enh-sync-node-name">目标实例 1</span><input type="checkbox" class="pi-enh-sync-checkbox" data-sync-target-toggle="colleague" aria-label="目标实例 1 自动同步" disabled></label><span class="pi-enh-sync-node-detail" data-sync-target-detail>未配置</span></div>
              <div class="pi-enh-sync-node" data-sync-node="target-windows"><label class="pi-enh-sync-target-check-wrap" title="目标实例 2 尚未配置"><span class="pi-enh-sync-node-name">目标实例 2</span><input type="checkbox" class="pi-enh-sync-checkbox" data-sync-target-toggle="windows" aria-label="目标实例 2 自动同步" disabled></label><span class="pi-enh-sync-node-detail" data-sync-windows-detail>未配置</span></div>
              <div class="pi-enh-sync-node" data-sync-node="target-mac"><label class="pi-enh-sync-target-check-wrap" title="目标实例 3 尚未配置"><span class="pi-enh-sync-node-name">目标实例 3</span><input type="checkbox" class="pi-enh-sync-checkbox" data-sync-target-toggle="mac" aria-label="目标实例 3 自动同步" disabled></label><span class="pi-enh-sync-node-detail" data-sync-mac-detail>未配置</span></div>
            </div>
          </div>
        </div>

        <div class="pi-enh-plugins-list">
          ${ENHANCEMENT_PLUGINS.map((plugin) => {
            const enabled = isPluginEnabled(plugin.id);
            return `
              <div class="pi-enh-plugin-item" data-plugin-row="${plugin.id}" data-plugin-category-name="${plugin.category}" data-enabled="${enabled ? "true" : "false"}">
                <div class="pi-enh-plugin-copy">
                  <div class="pi-enh-plugin-name-row">
                    <span class="pi-enh-plugin-name">${plugin.name}</span>
                    <span class="pi-enh-plugin-category">${plugin.category}</span>
                  </div>
                  <div class="pi-enh-plugin-desc">${plugin.desc}</div>
                  ${plugin.id === "session-memory-cache" ? `
                    <div class="pi-enh-cache-settings-row" style="margin-top: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--text-muted, #a1a1aa);">
                      <span>缓存上限：</span>
                      <input type="range" data-session-cache-limit-range min="${typeof isMobileEnvironment === "function" && isMobileEnvironment() ? 5 : 15}" max="${typeof isMobileEnvironment === "function" && isMobileEnvironment() ? 30 : 100}" step="5" value="${getSessionMemoryCacheLimit()}" style="width: 110px; accent-color: var(--accent, #38bdf8); cursor: pointer;" aria-label="会话缓存容量滑块">
                      <input type="number" data-session-cache-limit-input min="${typeof isMobileEnvironment === "function" && isMobileEnvironment() ? 5 : 15}" max="${typeof isMobileEnvironment === "function" && isMobileEnvironment() ? 30 : 100}" step="5" value="${getSessionMemoryCacheLimit()}" style="width: 48px; padding: 2px 4px; border-radius: 5px; background: var(--bg-hover, rgba(255,255,255,0.08)); border: 1px solid var(--border, #27272a); color: var(--text, #f4f4f5); font-size: 11.5px; text-align: center;" aria-label="会话缓存容量数值">
                      <span>个会话</span>
                      <span style="font-size: 11px; opacity: 0.65;">${typeof isMobileEnvironment === "function" && isMobileEnvironment() ? "(手机端默认15，推荐10~25)" : "(推荐 30~80)"}</span>
                    </div>
                    <div class="pi-enh-cache-toolbar" style="margin-top: 6px; display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-muted, #a1a1aa);">
                      <span data-cache-count-label>内存 ${sessionMemoryCache.size}/${getSessionMemoryCacheLimit()} · 持久 ${Object.keys(persistentSessionManifest).length} 个会话</span>
                      <button type="button" class="pi-enh-btn-sm" data-action="clear-session-cache" style="padding: 2px 8px; font-size: 11px;">🧹 清空缓存</button>
                    </div>
                  ` : ""}
                  ${plugin.id === "minimap-full-nav" ? `
                    <div class="pi-enh-plugin-number-settings" aria-label="会话导航轮数设置">
                      <label class="pi-enh-plugin-number-setting">
                        <span>初始显示</span>
                        <input data-minimap-initial-turns min="5" max="50" step="1" value="${getMinimapHistorySettings().initialTurns}" type="number" inputmode="numeric" aria-label="会话导航初始显示轮数">
                        <span>轮</span>
                      </label>
                      <label class="pi-enh-plugin-number-setting">
                        <span>每次加载</span>
                        <input data-minimap-step-turns min="1" max="50" step="1" value="${getMinimapHistorySettings().stepTurns}" type="number" inputmode="numeric" aria-label="会话导航每次加载轮数">
                        <span>轮</span>
                      </label>
                    </div>
                  ` : ""}
                  ${plugin.id === "session-attention-sound" ? `<button type="button" class="config-btn" data-attention-sound-preview>试听审批提示音</button>` : ""}
                  ${plugin.id === "session-attention-desktop" ? `
                    <button type="button" class="config-btn" data-desktop-notification-permission style="margin-top:8px">${typeof Notification !== "undefined" && Notification.permission === "granted" ? "通知权限已允许" : "手动授权浏览器通知"}</button>
                  ` : ""}
                  ${plugin.id === "session-pin-archive" ? `
                    <div style="margin-top: 8px; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--text-muted, #a1a1aa);">
                      <span>归档保留期限：</span>
                      <select data-archive-retention-select style="padding: 2px 8px; border-radius: 5px; background: var(--bg-hover, rgba(255,255,255,0.08)); border: 1px solid var(--border, #27272a); color: var(--text, #f4f4f5); font-size: 11.5px;">
                        <option value="7">7 天后自动删除</option>
                        <option value="30">30 天后自动删除</option>
                        <option value="60">60 天后自动删除 (默认)</option>
                        <option value="90">90 天后自动删除</option>
                        <option value="180">180 天后自动删除</option>
                        <option value="0">永不自动删除</option>
                      </select>
                      <span style="margin-left: 6px;">新任务唤醒：</span>
                      <select data-archive-auto-restore-select style="padding: 2px 8px; border-radius: 5px; background: var(--bg-hover, rgba(255,255,255,0.08)); border: 1px solid var(--border, #27272a); color: var(--text, #f4f4f5); font-size: 11.5px;">
                        <option value="1">自动唤醒（恢复至列表并置顶）</option>
                        <option value="0">保持归档（不自动恢复）</option>
                      </select>
                    </div>
                  ` : ""}
                </div>
                <button type="button" role="switch" aria-checked="${enabled ? "true" : "false"}" aria-label="${plugin.name}" title="${enabled ? "点击禁用" : "点击启用"}" class="config-switch" data-plugin-toggle="${plugin.id}">
                  <span class="config-switch-knob" aria-hidden="true"></span>
                </button>
              </div>
            `;
          }).join("")}
        </div>
        <div class="pi-enh-plugin-empty" data-plugin-empty role="status" hidden>没有匹配的插件，请调整搜索词或分类。</div>
      </div>
    `;

    initCrossDeviceSyncController(panel.querySelector("[data-pi-enh-sync-card]"));

    const searchInput = panel.querySelector("[data-plugin-search]");
    if (searchInput) {
      searchInput.value = enhancementPanelFilter.query;
      searchInput.addEventListener("input", () => {
        enhancementPanelFilter.query = searchInput.value || "";
        applyEnhancementPanelFilter(panel);
      });
    }
    for (const categoryButton of panel.querySelectorAll("[data-plugin-category]")) {
      categoryButton.addEventListener("click", () => {
        enhancementPanelFilter.category = categoryButton.getAttribute("data-plugin-category") || "all";
        applyEnhancementPanelFilter(panel);
      });
    }

    // Bind action buttons
    panel.querySelector('[data-action="hot-reload"]')?.addEventListener("click", () => {
      if (typeof window.__PI_ENH_RELOAD__ === "function") {
        if (typeof window.__PI_WEB_ENHANCEMENTS_CLEANUP__ === "function") {
          try { window.__PI_WEB_ENHANCEMENTS_CLEANUP__(); } catch (e) {}
        }
        window.__PI_ENH_PENDING_TOAST__ = { message: "已成功热载最新补丁，会话零中断" };
        window.__PI_ENH_RELOAD__();
        addManagedTimeout(() => renderEnhancementsPanel(panel, nav), 200);
      } else {
        showToast("已处于最新热载状态");
      }
    });

    panel.querySelector('[data-action="force-hard-reload"]')?.addEventListener("click", forceHardReloadApp);

    panel.querySelector('[data-action="enable-all"]')?.addEventListener("click", () => {
      for (const p of ENHANCEMENT_PLUGINS) setPluginEnabled(p.id, true);
      scheduleUsageLedgerPrefetch();
      renderEnhancementsPanel(panel, nav);
      showToast("已开启所有增强插件");
    });
    panel.querySelector('[data-action="disable-all"]')?.addEventListener("click", () => {
      for (const p of ENHANCEMENT_PLUGINS) setPluginEnabled(p.id, false);
      cancelUsageLedgerPrefetch();
      renderEnhancementsPanel(panel, nav);
      showToast("已关闭所有增强插件");
    });
    panel.querySelector('[data-action="reset-defaults"]')?.addEventListener("click", () => {
      for (const p of ENHANCEMENT_PLUGINS) setPluginEnabled(p.id, p.defaultEnabled);
      if (isPluginEnabled("usage-cost-dashboard")) scheduleUsageLedgerPrefetch();
      else cancelUsageLedgerPrefetch();
      renderEnhancementsPanel(panel, nav);
      showToast("已恢复默认增强设置");
    });

    panel.querySelector('[data-action="clear-session-cache"]')?.addEventListener("click", async () => {
      await clearSessionCaches();
      const label = panel.querySelector("[data-cache-count-label]");
      if (label) label.textContent = `内存 0/${getSessionMemoryCacheLimit()} · 持久 0 个会话`;
      showToast("已清空会话双层缓存");
    });

    const sessionCacheRange = panel.querySelector("[data-session-cache-limit-range]");
    const sessionCacheInput = panel.querySelector("[data-session-cache-limit-input]");
    if (sessionCacheRange && sessionCacheInput) {
      sessionCacheRange.addEventListener("input", () => {
        sessionCacheInput.value = sessionCacheRange.value;
      });
      const updateSessionCacheLimit = (val) => {
        const nextLimit = setSessionMemoryCacheLimit(val);
        sessionCacheRange.value = String(nextLimit);
        sessionCacheInput.value = String(nextLimit);
        const countLabel = panel.querySelector("[data-cache-count-label]");
        if (countLabel) countLabel.textContent = `内存 ${sessionMemoryCache.size}/${nextLimit} · 持久 ${Object.keys(persistentSessionManifest).length} 个会话`;
        showToast(`已设置会话缓存上限为 ${nextLimit} 个会话`);
      };
      sessionCacheRange.addEventListener("change", () => updateSessionCacheLimit(sessionCacheRange.value));
      sessionCacheInput.addEventListener("change", () => updateSessionCacheLimit(sessionCacheInput.value));
    }

    for (const restoreButton of panel.querySelectorAll('[data-action="restore-archived-session"]')) {
      restoreButton.addEventListener("click", async () => {
        let sessionId = "";
        try { sessionId = decodeURIComponent(restoreButton.getAttribute("data-session-id") || ""); } catch (e) {}
        try {
          const ok = await restoreArchivedSession(sessionId);
          if (!ok) return;
          invalidateCodexArchivedEntries();
          requestSessionListRefresh(false, true);
          if (typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
            try { window.__PI_ENH_RERENDER_SESSIONS__(); } catch (e) {}
          }
          renderEnhancementsPanel(panel, nav);
          showToast("已还原会话", sessionArchiveIcon);
        } catch (err) {
          showToast(err instanceof Error ? err.message : "还原会话失败", "error");
        }
      });
    }

    const retentionSelect = panel.querySelector("[data-archive-retention-select]");
    if (retentionSelect) {
      retentionSelect.value = String(getArchiveRetentionDays());
      retentionSelect.addEventListener("change", () => {
        const days = setArchiveRetentionDays(retentionSelect.value);
        showToast(days > 0 ? `已设置归档满 ${days} 天自动删除` : "已设置为永不自动删除归档会话");
        purgeExpiredArchives();
      });
    }

    const minimapInitialInput = panel.querySelector("[data-minimap-initial-turns]");
    if (minimapInitialInput) {
      minimapInitialInput.addEventListener("change", () => {
        const turns = setMinimapInitialTurns(minimapInitialInput.value);
        minimapInitialInput.value = String(turns);
        showToast(`会话导航初始显示 ${turns} 轮`);
      });
    }
    const minimapStepInput = panel.querySelector("[data-minimap-step-turns]");
    if (minimapStepInput) {
      minimapStepInput.addEventListener("change", () => {
        const turns = setMinimapStepTurns(minimapStepInput.value);
        minimapStepInput.value = String(turns);
        showToast(`会话导航每次加载 ${turns} 轮`);
      });
    }

    panel.querySelector("[data-desktop-notification-permission]")?.addEventListener("click", () => { void requestDesktopAttentionPermission(); });

    // Bind toggles
    for (const toggle of panel.querySelectorAll("[data-plugin-toggle]")) {
      toggle.addEventListener("click", () => {
        const id = toggle.getAttribute("data-plugin-toggle");
        const plugin = ENHANCEMENT_PLUGINS.find((p) => p.id === id);
        const current = toggle.getAttribute("aria-checked") === "true";
        const next = !current;
        setPluginEnabled(id, next);
        if (id === "usage-cost-dashboard") {
          if (next && isPluginEnabled(id)) scheduleUsageLedgerPrefetch();
          else cancelUsageLedgerPrefetch();
        }
        toggle.setAttribute("aria-checked", next ? "true" : "false");
        toggle.setAttribute("title", next ? "点击禁用" : "点击启用");
        const row = toggle.closest("[data-plugin-row]");
        if (row) row.setAttribute("data-enabled", next ? "true" : "false");
        showToast(`${next ? "已启用" : "已停用"}: ${plugin ? plugin.name : id}`);
        const countBadge = panel.querySelector("[data-enabled-count]");
        if (countBadge) {
          const newCount = ENHANCEMENT_PLUGINS.filter((p) => isPluginEnabled(p.id)).length;
          countBadge.textContent = `${newCount} / ${ENHANCEMENT_PLUGINS.length} 已启用`;
        }
      });
    }
    applyEnhancementPanelFilter(panel);
  }

  // ==========================================
  // Silent ETag / Mtime Poller (静默热载探针)
  // ==========================================
  currentScriptTag = null;
  pollerIntervalId = null;

  function isBrowserIdleForHotReload() {
    const isBusy = typeof isLiveRunning === "function" ? isLiveRunning() : Boolean(findActiveStopButton());
    if (isBusy) return false;
    const active = document.activeElement;
    if (active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable)) {
      return false;
    }
    if (document.querySelector(".pi-enh-menu, .pi-enh-quote-bar, .pi-enh-annotation-editor, .pi-enh-annotation-list")) {
      return false;
    }
    return true;
  }

  let usageLedgerPrefetchCancel = null;
  let usageLedgerPrefetchStarted = false;

  function cancelUsageLedgerPrefetch() {
    if (usageLedgerPrefetchCancel) {
      usageLedgerPrefetchCancel();
      usageLedgerPrefetchCancel = null;
    }
  }

  function scheduleUsageLedgerPrefetch() {
    if (isDisposed || isLoginPage() || !isPluginEnabled("usage-cost-dashboard") || usageLedgerPrefetchStarted || usageLedgerPrefetchCancel) return;

    let cancelled = false;
    let idleId = null;
    let timerId = null;
    let loadListener = null;
    let visibilityListener = null;
    let prefetchAbortController = null;

    const removeVisibilityListener = () => {
      if (visibilityListener) document.removeEventListener("visibilitychange", visibilityListener);
      visibilityListener = null;
    };
    const cancel = () => {
      cancelled = true;
      if (prefetchAbortController) {
        prefetchAbortController.abort();
        prefetchAbortController = null;
      }
      if (loadListener) window.removeEventListener("load", loadListener);
      loadListener = null;
      removeVisibilityListener();
      if (idleId !== null && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idleId);
      idleId = null;
      if (timerId !== null) clearTimeout(timerId);
      timerId = null;
    };

    const waitUntilVisible = () => {
      if (cancelled || visibilityListener) return;
      visibilityListener = () => {
        if (document.visibilityState === "hidden") return;
        removeVisibilityListener();
        scheduleIdle();
      };
      document.addEventListener("visibilitychange", visibilityListener);
    };

    const run = async () => {
      idleId = null;
      timerId = null;
      if (cancelled || isDisposed || !isPluginEnabled("usage-cost-dashboard")) return;
      if (document.visibilityState === "hidden") {
        waitUntilVisible();
        return;
      }
      const loadOptional = window.__PI_ENH_LOAD_OPTIONAL__;
      if (typeof loadOptional !== "function") return;
      try {
        const usagePanel = await loadOptional("usage-panel");
        if (cancelled || isDisposed || !isPluginEnabled("usage-cost-dashboard")) return;
        if (document.visibilityState === "hidden") {
          waitUntilVisible();
          return;
        }
        if (typeof usagePanel?.prefetch !== "function") return;
        usageLedgerPrefetchStarted = true;
        prefetchAbortController = typeof AbortController === "function" ? new AbortController() : null;
        void usagePanel.prefetch(prefetchAbortController?.signal).catch(() => {});
      } catch (_) {
        // Keep startup quiet; opening Usage remains the visible retry path.
      }
    };

    const scheduleIdle = () => {
      if (cancelled || isDisposed || !isPluginEnabled("usage-cost-dashboard")) return;
      if (document.visibilityState === "hidden") {
        waitUntilVisible();
        return;
      }
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(run, { timeout: 5000 });
      } else {
        timerId = setTimeout(run, 1200);
      }
    };

    const afterLoad = () => {
      loadListener = null;
      scheduleIdle();
    };
    usageLedgerPrefetchCancel = cancel;
    if (document.readyState === "complete") afterLoad();
    else {
      loadListener = afterLoad;
      window.addEventListener("load", loadListener, { once: true });
    }
  }

  async function checkScriptUpdate() {
    if (isLoginPage()) return;
    try {
      const res = await fetch("/pi-web-enhancements.js", { method: "HEAD", cache: "no-cache" });
      if (!res.ok) return;
      const tag = res.headers.get("etag") || res.headers.get("last-modified");
      if (!tag) return;
      if (currentScriptTag === null) {
        currentScriptTag = tag;
        return;
      }
      if (tag !== currentScriptTag) {
        if (!isBrowserIdleForHotReload()) return;
        currentScriptTag = tag;
        if (typeof window.__PI_ENH_RELOAD__ === "function") {
          if (typeof window.__PI_WEB_ENHANCEMENTS_CLEANUP__ === "function") {
            try { window.__PI_WEB_ENHANCEMENTS_CLEANUP__(); } catch (e) {}
          }
          // 静默无感热载，控制台记录即可，绝不弹窗打扰用户
          console.log("[Agent Web Plus Enhancements] Silently reloading latest patch...");
          window.__PI_ENH_RELOAD__();
        }
      }
    } catch (e) {}
  }

  // 遵照 AGENTS.md 铁律：网页增强脚本改动一律只同步纯静态文件，由用户自主决定何时刷新页面或重启。
  // 严禁在浏览器后台运行每3秒的高频热载轮询，防止在用户正常交互与流式输出期间突然销毁 DOM 与掐断 EventSource 连接导致页面崩溃。
  // 若需手动检查更新，可通过控制台调用 window.__PI_ENH_CHECK_UPDATE__()
  window.__PI_ENH_CHECK_UPDATE__ = checkScriptUpdate;

  async function checkImmutableBundleAndHotSyncOnBoot() {
    if (typeof window === "undefined" || isLoginPage()) return;
    try {
      const res = await fetch(`/pi-web-enhancement-loader.js?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const text = await res.text();
      const m = text.match(/window\.__PI_ENH_ASSET_BUILD__\s*=\s*"([a-f0-9]{16})"/);
      const serverBuild = m ? m[1] : null;
      const currentBuild = window.__PI_ENH_ASSET_BUILD__;
      if (serverBuild && currentBuild && serverBuild !== currentBuild) {
        console.warn(`[Pi Enh] Stale immutable bundle detected (local: ${currentBuild}, server: ${serverBuild}). Auto-healing browser disk cache...`);
        try {
          const scripts = Array.from(document.querySelectorAll("script[src]"))
            .map((s) => s.getAttribute("src"))
            .filter((src) => src && (src.includes("/chunks/app/layout-") || src.includes("/chunks/app/page-")));
          for (const s of scripts) {
            void fetch(s, { cache: "reload" }).catch(() => {});
          }
        } catch (_) {}
        if (typeof window.__PI_ENH_RELOAD__ === "function") {
          if (typeof window.__PI_WEB_ENHANCEMENTS_CLEANUP__ === "function") {
            try { window.__PI_WEB_ENHANCEMENTS_CLEANUP__(); } catch (_) {}
          }
          window.__PI_ENH_RELOAD__(true);
        }
      }
    } catch (_) {}
  }

  if (typeof window !== "undefined") {
    setTimeout(checkImmutableBundleAndHotSyncOnBoot, 1200);
  }

  // Register clean teardown hook for safe zero-downtime hot-reloads
  window.__PI_WEB_ENHANCEMENTS_CLEANUP__ = function () {
    if (isDisposed) return;
    isDisposed = true;
    cancelUsageLedgerPrefetch();

    try {
      // 0. Disconnect and restore document title observer and descriptor (only restore if still owned)
      if (titleObserver) {
        try { titleObserver.disconnect(); } catch (e) {}
        titleObserver = null;
      }
      if (headObserver) {
        try { headObserver.disconnect(); } catch (e) {}
        headObserver = null;
      }
      if (typeof document !== "undefined" && installedTitleGetter) {
        try {
          const curDesc = Object.getOwnPropertyDescriptor(document, "title");
          if (curDesc && curDesc.get === installedTitleGetter && curDesc.set === installedTitleSetter) {
            if (hadOwnTitleDesc && prevOwnTitleDesc) {
              try { Object.defineProperty(document, "title", prevOwnTitleDesc); } catch (e) {}
            } else {
              try { delete document.title; } catch (e) {}
            }
          }
        } catch (e) {}
      }

      // 1. Disconnect and nullify MutationObserver to prevent infinite loops and memory leaks
      if (chatObserver) {
        try { chatObserver.disconnect(); } catch (e) {}
        chatObserver = null;
      }
      if (sidebarObserver) {
        try { sidebarObserver.disconnect(); } catch (e) {}
        sidebarObserver = null;
      }
      observedTarget = null;
      isMutatingInternally = false;
      syncScheduled = false;
      hasDeferredSync = false;
      if (domSyncTimerId !== null) {
        try { clearTimeout(domSyncTimerId); } catch (e) {}
        domSyncTimerId = null;
      }
      if (domSyncFrameId !== null && typeof cancelAnimationFrame === "function") {
        try { cancelAnimationFrame(domSyncFrameId); } catch (e) {}
        domSyncFrameId = null;
      }

      // 2. Abort pending metrics requests and invalidate token
      ++metricsScheduleToken;
      if (metricsScheduleTimer !== null) {
        try { clearManagedTimeout(metricsScheduleTimer); } catch (e) {}
        metricsScheduleTimer = null;
      }
      if (metricsAbortController) {
        try { metricsAbortController.abort(); } catch (e) {}
        metricsAbortController = null;
      }

      // 2.1 Clear pending models-config debounces and resolve pending resolvers to false
      if (pendingPersistDecorationsTimer) {
        clearTimeout(pendingPersistDecorationsTimer);
        pendingPersistDecorationsTimer = null;
      }
      while (pendingPersistDecorationsResolvers.length > 0) {
        try { pendingPersistDecorationsResolvers.shift()(false); } catch (e) {}
      }

      if (pendingPersistArchivedTimer) {
        clearTimeout(pendingPersistArchivedTimer);
        pendingPersistArchivedTimer = null;
      }
      while (pendingPersistArchivedResolvers.length > 0) {
        try { pendingPersistArchivedResolvers.shift()(false); } catch (e) {}
      }

      if (pendingPersistPinnedTimer) {
        clearTimeout(pendingPersistPinnedTimer);
        pendingPersistPinnedTimer = null;
      }
      while (pendingPersistPinnedResolvers.length > 0) {
        try { pendingPersistPinnedResolvers.shift()(false); } catch (e) {}
      }

      // 2.2 Abort any inflight models-config bounded fetches
      for (const controller of activeModelsConfigAbortControllers) {
        try { controller.abort(); } catch (e) {}
      }
      activeModelsConfigAbortControllers.clear();

      // 2.3 Cancel pending session revalidations
      for (const handle of activeRevalidationHandles) {
        try {
          if (handle.type === "idle" && typeof window !== "undefined" && typeof window.cancelIdleCallback === "function") {
            window.cancelIdleCallback(handle.id);
          } else if (handle.type === "timeout") {
            clearTimeout(handle.id);
          }
        } catch (e) {}
      }
      activeRevalidationHandles.clear();

      // 2.4 Clear queue message detail cache and bump generation
      clearQueueDetailCache();

      // 3. Clear all managed active event listeners and timers
      while (activeCleanups.length > 0) {
        try {
          const cleanup = activeCleanups.pop();
          cleanup();
        } catch (e) {}
      }
      managedTimeoutCleanups.clear();

      if (restoreTitleTimer !== null) {
        try { clearManagedTimeout(restoreTitleTimer); } catch (e) {}
        restoreTitleTimer = null;
      }

      // Explicitly clear legacy interval handles if any
      try { clearInterval(mainSyncIntervalId); } catch (e) {}
      try { clearInterval(liveStopwatchIntervalId); } catch (e) {}
      try { clearInterval(thinkingIntervalId); } catch (e) {}
      try { clearInterval(pollerIntervalId); } catch (e) {}
      try { clearInterval(projectStatusIntervalId); } catch (e) {}
      try { setProjectStatusMonitoring(false); } catch (e) {}
      isProjectStatusMonitoringActive = false;

      // 4. Thorough DOM cleanup
      removeQuickActionButtons();
      window.dispatchEvent(new CustomEvent("pi:scroll-bottom-preferences", { detail: { enabled: false } }));
      removeLocalPathLauncher();
      removeProjectStatusIndicators();
      removeCompactionEnhancements();
      removeOrphanProcessBars();
      document.documentElement?.classList.remove("pi-enh-tool-collapse-active");
      document.documentElement?.classList.remove("pi-enh-native-message-font-active");
      removeDraftRestoredBadge();
      removeSessionPinArchiveControls();
      if (typeof setSessionBatchMode === "function") setSessionBatchMode(false);
      if (typeof removeSessionBatchTrigger === "function") removeSessionBatchTrigger();
      if (typeof removeSessionBatchBar === "function") removeSessionBatchBar();
      if (typeof closeBatchDeleteModal === "function") closeBatchDeleteModal();
      removeComposerFilePaste();
      removeComposerImageZoom();
      removeImageDblClickPreview();
      syncStreamingThinkingGuard(false);
      removeAnnotationUi();
      removeBottomShortcutsBar();
      if (typeof cleanupSessionScrollTracking === "function") {
        try { cleanupSessionScrollTracking(); } catch (e) {}
      }
      // 清除可能存在的 Toast 节点与定时器，绝不在样式卸载时残留 DOM 导致掉落到左下角
      if (typeof dismissToast === "function") {
        try { dismissToast(true); } catch (e) {}
      }
      cleanupSettingsNativeBridge();
      for (const el of document.querySelectorAll(".pi-enh-menu, .pi-enh-quote-bar, #pi-enh-protocol-frame, .pi-enh-draft-badge, .pi-enh-search-group-divider, .pi-enh-search-archived-badge, .pi-enh-search-restore-btn, .pi-enh-attachments-bar, .pi-enh-attachment-card, .pi-enh-video-preview-backdrop, dialog.pi-enh-image-zoom-dialog, .pi-enh-toast, .pi-enh-annotation-rail")) {
        try { el.remove(); } catch (e) {}
      }
      if (durationTooltip && durationTooltip.parentNode) {
        try { durationTooltip.parentNode.removeChild(durationTooltip); } catch (e) {}
        durationTooltip = null;
      }
      if (usageTooltip && usageTooltip.parentNode) {
        try { usageTooltip.parentNode.removeChild(usageTooltip); } catch (e) {}
        usageTooltip = null;
      }
      activeTooltipType = null;
      delete window.__PI_WEB_ENHANCEMENTS_LOADED__;
      for (const b of document.querySelectorAll(".pi-enh-duration-badge")) {
        try { b.remove(); } catch (e) {}
      }
      for (const h of document.querySelectorAll(".pi-enh-minimap-header")) {
        try { h.remove(); } catch (e) {}
      }

      delete window.__PI_ENH_ACTIVE_CLEANUPS_COUNT__;
      delete window.__PI_ENH_CLEAR_MANAGED_TIMEOUT__;
      delete window.__PI_ENH_ADD_MANAGED_TIMEOUT__;
      delete window.__PI_ENH_WITH_MUTATION_GUARD__;
      delete window.__PI_ENH_SCHEDULE_DOM_SYNC__;
      delete window.__PI_ENH_HAS_DEFERRED_SYNC__;
      delete window.__PI_ENH_SCHEDULE_CURRENT_SESSION_METRICS__;
      delete window.__PI_ENH_METRICS_ABORT_CONTROLLER__;
      delete window.__PI_ENH_IS_PROJECT_STATUS_MONITORING__;
      delete window.__PI_ENH_SYNC_COMPACTION__;
      delete window.__PI_ENH_REMOVE_COMPACTION__;
      delete window.__PI_ENH_FETCH_QUEUED_MESSAGE_DETAIL__;
      delete window.__PI_ENH_GET_QUEUE_DETAIL_CACHE_STATS__;
      delete window.__PI_ENH_RECONCILE_USER_MESSAGE__;
      delete window.__PI_ENH_SESSION_HISTORY_ORDER_GUARD__;
      delete window.__PI_ENH_SYNC_SUBAGENT_DISPATCH_REMOTE_STATE__;
      delete window.__PI_ENH_COMMIT_SUBAGENT_DISPATCH_REMOTE_STATE__;
      delete window.__PI_ENH_GET_DURABLE_STATE_BASE_URL__;
      delete window.__PI_ENH_GET_DURABLE_STATE_INSTANCE_PARAM__;
    } catch (e) {
      console.warn("[Agent Web Plus Enhancements] cleanup warning:", e);
    }
  };

  window.__PI_ENH_ACTIVE_CLEANUPS_COUNT__ = () => activeCleanups.length;
  window.__PI_ENH_CLEAR_MANAGED_TIMEOUT__ = clearManagedTimeout;
  window.__PI_ENH_ADD_MANAGED_TIMEOUT__ = addManagedTimeout;
  window.__PI_ENH_WITH_MUTATION_GUARD__ = withMutationGuard;
  window.__PI_ENH_SCHEDULE_DOM_SYNC__ = scheduleDomSync;
  window.__PI_ENH_HAS_DEFERRED_SYNC__ = () => hasDeferredSync;
  window.__PI_ENH_SCHEDULE_CURRENT_SESSION_METRICS__ = scheduleCurrentSessionMetrics;
  Object.defineProperty(window, "__PI_ENH_METRICS_ABORT_CONTROLLER__", {
    configurable: true,
    get() { return metricsAbortController; }
  });
  window.__PI_ENH_IS_PROJECT_STATUS_MONITORING__ = () => isProjectStatusMonitoringActive;
  window.__PI_ENH_SYNC_COMPACTION__ = syncCompactionCards;
  window.__PI_ENH_REMOVE_COMPACTION__ = removeCompactionEnhancements;
  window.__PI_ENH_FETCH_QUEUED_MESSAGE_DETAIL__ = fetchQueuedMessageDetail;
  window.__PI_ENH_GET_QUEUE_ATTACHMENT_REVISION__ = () => queueAttachmentRevision;
  window.__PI_ENH_GET_QUEUE_DETAIL_CACHE_STATS__ = () => ({
    count: queuedMessageDetailCache.size,
    bytes: currentQueueDetailCacheBytes,
    generation: queueDetailCacheGeneration,
    inFlightCount: queuedMessageDetailInFlight.size,
  });
  window.__PI_ENH_SESSION_HISTORY_ORDER_GUARD__ = {
    handleStreamEvent: handleSessionHistoryOrderStreamEvent,
    handleAction: handleSessionHistoryOrderAction,
    wrapFetch: wrapSessionHistoryOrderGuard,
    shouldProtect: shouldProtectSessionHistoryOrder,
    isMessagesUpToDate: isMessagesUpToDateWithWatermark,
    clearState: clearSessionHistoryOrderState,
    getState: getOrCreateHistoryOrderState,
    extractNormalizedHistoryKey,
  };
  window.__PI_ENH_IS_PLUGIN_ENABLED__ = isPluginEnabled;


  const kernelHealth = window.__PI_ENH_KERNEL_HEALTH__ || {
    edition: `agent-web-standalone-${ENHANCEMENT_SUITE_VERSION}`,
    version: ENHANCEMENT_SUITE_VERSION,
    bootedAt: Date.now(),
    initialSyncCompleted: false,
    isolatedErrors: [],
  };
  kernelHealth.edition = `agent-web-standalone-${ENHANCEMENT_SUITE_VERSION}`;
  kernelHealth.version = ENHANCEMENT_SUITE_VERSION;
  window.__PI_ENH_KERNEL_HEALTH__ = kernelHealth;
  window.__PI_WEB_STANDALONE_VERSION__ = ENHANCEMENT_SUITE_VERSION;
  function runIsolatedKernelStep(stepName, fn) {
    try {
      if (typeof fn === "function") fn();
    } catch (err) {
      kernelHealth.isolatedErrors.push({
        step: stepName,
        error: String(err && err.message ? err.message : err),
        at: Date.now(),
      });
      console.warn(`[Agent Web Plus Kernel Sandbox] Isolated error in ${stepName}:`, err);
    }
  }
  window.__PI_ENH_RUN_ISOLATED_STEP__ = runIsolatedKernelStep;
  window.__PI_ENH_SYNC_SUBAGENT_DISPATCH_REMOTE_STATE__ = syncSubagentDispatchRemoteState;
  window.__PI_ENH_COMMIT_SUBAGENT_DISPATCH_REMOTE_STATE__ = commitSubagentDispatchRemoteState;
  window.__PI_ENH_GET_DURABLE_STATE_BASE_URL__ = getDurableStateBaseUrl;
  window.__PI_ENH_GET_DURABLE_STATE_INSTANCE_PARAM__ = getDurableStateInstanceParam;

  window.__PI_WEB_ENHANCEMENTS_LOADED__ = true;
  runIsolatedKernelStep("initialDomSyncImmediate", () => {
    if (!isLoginPage()) {
      runAllSyncOperations();
      kernelHealth.initialSyncCompleted = true;
    }
  });
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => {
      if (!isDisposed && !isLoginPage()) {
        runIsolatedKernelStep("initialDomSyncAnimationFrame", () => runAllSyncOperations());
      }
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      if (!isDisposed && !isLoginPage()) {
        runIsolatedKernelStep("initialDomSyncDOMContentLoaded", () => runAllSyncOperations());
      }
    }, { once: true });
  }

  // 页面加载完成后后台静默预热模型设置数据（延迟 1.2s，避免首屏主资源竞争，确保后续点击 0ms 秒开）
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      try {
        if (!isDisposed && !isLoginPage() && getComposerExecutionEngineHint(getCurrentSessionId()) === "pi" && typeof window.__PI_ENH_PRELOAD_MODELS_CACHE__ === "function") {
          window.__PI_ENH_PRELOAD_MODELS_CACHE__();
        }
      } catch (e) {}
    }, 1200);
  }

  if (typeof setTimeout === "function") {
    setTimeout(() => {
      if (!isDisposed && !isLoginPage() && getComposerExecutionEngineHint(getCurrentSessionId()) === "pi") scheduleUsageLedgerPrefetch();
    }, 1200);
  }

  // 页面加载完成后后台静默探测上游更新（延迟 1.5s，避免首屏主资源竞争）
  if (typeof setTimeout === "function") {
    setTimeout(() => {
      try {
        if (!isDisposed && !isLoginPage() && typeof window.__PI_ENH_CHECK_AGENT_UPDATE__ === "function") {
          window.__PI_ENH_CHECK_AGENT_UPDATE__(false);
        }
      } catch (e) {}
    }, 1500);
  }

  console.log(`[Agent Web Plus Enhancements] v${ENHANCEMENT_SUITE_VERSION} Loaded: Module Settings Manager active.`);
})();
