  // ==========================================
  // 3. Task Total Duration & Turn Usage Tooltips (点击展开耗时拆解与消耗明细气泡)
  // ==========================================
  durationTooltip = null;
  usageTooltip = null;
  let activeTooltipType = null; // "duration" | "usage" | null

  function getDurationTooltip() {
    if (!durationTooltip) {
      durationTooltip = document.createElement("div");
      durationTooltip.className = "pi-enh-tooltip";
      durationTooltip.style.display = "none";
      document.body.appendChild(durationTooltip);
    }
    return durationTooltip;
  }

  function hideDurationTooltip() {
    if (durationTooltip) {
      durationTooltip.style.display = "none";
      durationTooltip.style.visibility = "visible";
      durationTooltip.__currentBadge = null;
    }
    if (activeTooltipType === "duration") {
      activeTooltipType = null;
    }
  }

  function getUsageTooltip() {
    if (!usageTooltip) {
      usageTooltip = document.createElement("div");
      usageTooltip.className = "pi-enh-tooltip pi-enh-usage-tooltip";
      usageTooltip.style.display = "none";
      document.body.appendChild(usageTooltip);
    }
    return usageTooltip;
  }

  function hideUsageTooltip() {
    if (usageTooltip) {
      usageTooltip.style.display = "none";
      usageTooltip.style.visibility = "visible";
      usageTooltip.__currentBadge = null;
    }
    if (activeTooltipType === "usage") {
      activeTooltipType = null;
    }
  }

  function hideAllTooltips() {
    hideDurationTooltip();
    hideUsageTooltip();
  }

  function getComposerTopBoundary() {
    try {
      const textarea = findComposerTextarea();
      if (textarea) {
        const box = textarea.closest("form, [data-pi-native-composer-host], .chat-content > div:last-child") || textarea.parentElement?.parentElement || textarea;
        if (box && typeof box.getBoundingClientRect === "function") {
          const rect = box.getBoundingClientRect();
          if (rect.top > 80 && rect.top < window.innerHeight) {
            return rect.top;
          }
        }
      }
    } catch (e) {}
    return window.innerHeight - 90;
  }

  function updateActiveTooltipPosition() {
    let tt = null;
    let badge = null;
    let defaultWidth = 340;

    if (activeTooltipType === "usage" && usageTooltip && usageTooltip.style.display !== "none") {
      tt = usageTooltip;
      badge = usageTooltip.__currentBadge;
      defaultWidth = Math.min(window.innerWidth - 24, 480);
    } else if (activeTooltipType === "duration" && durationTooltip && durationTooltip.style.display !== "none") {
      tt = durationTooltip;
      badge = durationTooltip.__currentBadge;
      const maxAllowedWidth = Math.min(window.innerWidth - 24, 420);
      tt.style.maxWidth = `${maxAllowedWidth}px`;
      defaultWidth = maxAllowedWidth;
    }

    if (!tt || !badge || !badge.isConnected) {
      return;
    }

    const rect = badge.getBoundingClientRect();
    const composerTop = getComposerTopBoundary();

    // 1. 防遮挡输入框：当徽章滚入或贴近底部输入框上沿（距离小于 14px），弹窗立即优雅隐藏，绝对不遮挡输入框！
    if (rect.top >= composerTop - 14 || rect.bottom >= composerTop + 10) {
      tt.style.visibility = "hidden";
      return;
    }

    // 2. 防顶端越界：当徽章滚到屏幕过上方（距离顶部小于 24px），弹窗超出可视区，平滑隐藏
    if (rect.top < 24 || rect.bottom < -40) {
      tt.style.visibility = "hidden";
      return;
    }

    if (activeTooltipType === "usage") {
      // 空间不足时明细内部滚动，不能无限加高
      // 徽章上方留出 12px 屏幕安全边距和 8px 呼吸间距，最大可用高度为 rect.top - 20
      // 桌面最大限制为 560px，在靠近顶部或居中时按可用空间收敛，保证摘要卡片始终在可视区
      const maxUsageHeight = Math.max(200, Math.min(560, rect.top - 20));
      tt.style.maxHeight = `${maxUsageHeight}px`;
    }

    tt.style.visibility = "visible";
    const ttWidth = tt.offsetWidth || parseInt(tt.style.width, 10) || defaultWidth;
    const ttHeight = tt.offsetHeight || 215;

    let posX = Math.max(12, Math.min(rect.left + rect.width / 2 - ttWidth / 2, window.innerWidth - ttWidth - 12));
    // 垂直位置：永远且必须保持在徽章（小字）的正上方，留 8px 呼吸间距，绝对不翻转到下方遮挡正文与输入框
    let posY = rect.top - ttHeight - 8;
    if (activeTooltipType === "usage" && posY < 12) {
      posY = 12;
    }

    tt.style.left = `${posX}px`;
    tt.style.top = `${posY}px`;
  }

  function handleTooltipScrollOrResize() {
    if (!activeTooltipType) return;
    updateActiveTooltipPosition();
  }

  addManagedListener(window, "scroll", handleTooltipScrollOrResize, { capture: true, passive: true });
  addManagedListener(window, "resize", handleTooltipScrollOrResize, { passive: true });

  function formatSec(sec) {
    if (sec < 60) return `${Number(sec).toFixed(1)}s`;
    if (sec < 3600) {
      const min = Math.floor(sec / 60);
      const rem = Math.round(sec % 60);
      return `${min}分${rem}秒`;
    }
    const hr = Math.floor(sec / 3600);
    const min = Math.floor((sec % 3600) / 60);
    const rem = Math.round(sec % 60);
    return rem > 0 ? `${hr}小时${min}分${rem}秒` : `${hr}小时${min}分`;
  }

  // Session turn metrics cache: entryId -> { totalSec, queueSec, toolCounts, uTime, aTime }
  const knownTurnMetrics = new Map();
  const MAX_KNOWN_TURN_METRICS = 200;
  function setKnownTurnMetric(entryId, metrics) {
    if (!entryId) return;
    if (knownTurnMetrics.size >= MAX_KNOWN_TURN_METRICS) {
      const firstKey = knownTurnMetrics.keys().next().value;
      if (firstKey) knownTurnMetrics.delete(firstKey);
    }
    knownTurnMetrics.set(entryId, metrics);
  }
  window.__PI_ENH_KNOWN_TURN_METRICS__ = knownTurnMetrics;
  window.__PI_ENH_FORMAT_SEC__ = formatSec;

  // Active session turn start tracking: sessionId -> { startTime: number, startEntryId: string | null, authoritative: boolean }
  const activeSessionTurns = new Map();
  function recordActiveTurnStart(sessionId, startTime, entryId = null, authoritative = false) {
    if (!sessionId || !startTime || startTime <= 0) return;
    const existing = activeSessionTurns.get(sessionId);
    // Ordinary composer/steering submissions only provide a provisional hint.
    // Once a turn has a start, never move it forward until a new agent_start
    // explicitly establishes an independent turn (or metrics calibrate it).
    if (existing && !authoritative) {
      return;
    }
    const validStartTime = Math.min(startTime, Date.now());
    activeSessionTurns.set(sessionId, {
      startTime: validStartTime,
      startEntryId: entryId || existing?.startEntryId || null,
      authoritative: Boolean(authoritative),
    });
  }
  function getActiveTurnStartTime(sessionId) {
    if (!sessionId) return null;
    const tracked = activeSessionTurns.get(sessionId);
    if (tracked && tracked.startTime > 0) {
      return tracked.startTime;
    }
    return null;
  }
  function clearActiveTurn(sessionId) {
    if (!sessionId) return;
    activeSessionTurns.delete(sessionId);
  }
  window.__PI_ENH_ACTIVE_TURNS__ = activeSessionTurns;
  window.__PI_ENH_RECORD_ACTIVE_TURN_START__ = recordActiveTurnStart;
  window.__PI_ENH_GET_ACTIVE_TURN_START__ = getActiveTurnStartTime;
  window.__PI_ENH_CLEAR_ACTIVE_TURN__ = clearActiveTurn;

  // Per-assistant-step throughput. This intentionally uses provider-reported
  // `usage.output`, not rendered thinking text: Gemini may stream encrypted or
  // empty thinking blocks, which made Agent Web Plus's native CJK estimate stay at 0.
  const knownStepSpeeds = new Map();
  const liveStepSpeeds = new Map();
  const MAX_KNOWN_STEP_SPEEDS = 500;
  const MAX_LIVE_STEP_SPEEDS = 50;

  function scheduleModelSpeedSync() {
    addManagedTimeout(() => {
      if (!isDisposed) syncAllModelSpeedBadges();
    }, 0);
  }

  function handleModelSpeedStreamEvent(sessionId, eventData) {
    if (!sessionId || !eventData || typeof eventData !== "object") return;
    const type = eventData.type;
    const now = Date.now();

    if (type === "agent_start") {
      liveStepSpeeds.delete(sessionId);
      // SSE agent_start is the only explicit boundary for a new independent
      // turn. Invalidate both the per-session authoritative cache and the
      // current-page fallback so the stopwatch cannot inherit an old turn.
      clearActiveTurn(sessionId);
      if (sessionId === getCurrentSessionId()) {
        activeTurnStartTime = null;
        activeTurnEntryId = null;
        recordActiveTurnStart(sessionId, now, null, false);
        // The provisional `now` start is replaced by the new user timestamp
        // when session metrics arrive; start calibration immediately.
        scheduleCurrentSessionMetrics(0);
      }
      scheduleModelSpeedSync();
      return;
    }

    if (type === "message_start" && eventData.message?.role === "assistant") {
      const reportedStart = Number(eventData.message.timestamp) || 0;
      const startedAt = reportedStart > 0 && reportedStart <= now && now - reportedStart < 10 * 60 * 1000
        ? reportedStart
        : now;
      liveStepSpeeds.set(sessionId, {
        startedAt,
        output: 0,
        durationSec: 0,
        tps: 0,
        live: true,
        exact: false,
      });
      scheduleModelSpeedSync();
      return;
    }

    if (type !== "message_update" && type !== "message_end") return;
    const message = eventData.message;
    if (type === "message_end" && message?.role !== "assistant") return;
    const output = Number(type === "message_update" ? eventData.usage?.output : message?.usage?.output) || 0;
    if (output <= 0) return;

    let state = liveStepSpeeds.get(sessionId);
    if (!state || output < state.output) {
      const reportedStart = Number(message?.timestamp) || 0;
      state = {
        startedAt: reportedStart > 0 && reportedStart <= now ? reportedStart : now,
        output: 0,
        durationSec: 0,
        tps: 0,
        live: true,
        exact: false,
      };
    }
    const durationSec = Math.max(0.1, (now - state.startedAt) / 1000);
    state.output = output;
    state.durationSec = durationSec;
    state.tps = output / durationSec;
    state.live = type === "message_update";
    state.exact = false;
    liveStepSpeeds.set(sessionId, state);

    if (liveStepSpeeds.size > MAX_LIVE_STEP_SPEEDS) {
      for (const cachedSessionId of liveStepSpeeds.keys()) {
        if (cachedSessionId === sessionId) continue;
        liveStepSpeeds.delete(cachedSessionId);
        break;
      }
    }
    scheduleModelSpeedSync();
  }

  window.__PI_ENH_LIVE_STEP_SPEEDS__ = liveStepSpeeds;
  window.__PI_ENH_HANDLE_MODEL_SPEED_STREAM_EVENT__ = handleModelSpeedStreamEvent;

  function setKnownStepSpeed(entryId, metrics) {
    if (!entryId || !metrics || !(metrics.output > 0) || !(metrics.durationSec > 0)) return;
    const existing = knownStepSpeeds.get(entryId);
    if (existing && existing.exact && !metrics.exact) return;
    if (knownStepSpeeds.size >= MAX_KNOWN_STEP_SPEEDS && !knownStepSpeeds.has(entryId)) {
      const firstKey = knownStepSpeeds.keys().next().value;
      if (firstKey) knownStepSpeeds.delete(firstKey);
    }
    knownStepSpeeds.set(entryId, {
      output: metrics.output,
      durationSec: metrics.durationSec,
      tps: metrics.output / metrics.durationSec,
      exact: Boolean(metrics.exact),
    });
  }
  window.__PI_ENH_KNOWN_STEP_SPEEDS__ = knownStepSpeeds;

  function modelSpeedColor(tps) {
    if (tps >= 50) return "#0369a1";
    if (tps >= 30) return "#3f6212";
    if (tps >= 15) return "#92400e";
    return "#be123c";
  }

  function upsertModelSpeedBadge(msg, metrics) {
    if (!msg || typeof msg.querySelectorAll !== "function") return;
    const hosts = msg.querySelectorAll('[data-pi-model-speed-host]');
    if (!hosts || hosts.length === 0) return;

    for (let h = 0; h < hosts.length; h++) {
      const host = hosts[h];
      const badges = host.querySelectorAll(".pi-enh-model-speed");
      let badge = badges[0] || null;
      for (let i = 1; i < badges.length; i++) {
        badges[i].remove();
      }

      // Only completed steps with provider usage and reliable timestamps qualify.
      if (!metrics || !(metrics.tps > 0)) {
        if (badge) badge.remove();
        continue;
      }

      const tps = Math.max(0, metrics.tps);
      const text = `${tps.toFixed(1)} t/s`;
      const isLive = Boolean(metrics.live);
      const title = isLive
        ? `运行中实时平均速度：${tps.toFixed(1)} t/s（当前供应商输出 Tokens ÷ 本次模型请求已用时间）`
        : `已完成单步端到端平均速度：${tps.toFixed(1)} t/s（供应商输出 Tokens ÷ 请求总耗时）`;
      const bg = modelSpeedColor(tps);

      if (!badge) {
        badge = document.createElement("span");
        badge.className = "pi-enh-model-speed";
        badge.style.padding = "1px 6px";
        badge.style.borderRadius = "4px";
        badge.style.color = "#fff";
        badge.style.fontSize = "11px";
        badge.style.fontWeight = "400";
        badge.style.display = "inline-flex";
        badge.style.alignItems = "center";
        badge.style.cursor = "default";
        host.appendChild(badge);
      }

      if (badge.textContent !== text) badge.textContent = text;
      if (badge.style.background !== bg) badge.style.background = bg;
      if (badge.getAttribute("title") !== title) badge.setAttribute("title", title);
      badge.setAttribute("data-live", isLive ? "true" : "false");
      badge.setAttribute("data-output-tokens", String(Math.round(metrics.output || 0)));
    }
  }

  function getMessageEntryId(el) {
    if (!el || typeof el.getAttribute !== "function") return null;
    return el.getAttribute("data-entry-id") ||
           el.closest?.("[data-entry-id]")?.getAttribute("data-entry-id") ||
           el.querySelector?.("[data-entry-id]")?.getAttribute("data-entry-id") ||
           null;
  }

  function syncAllModelSpeedBadges() {
    if (!isPluginEnabled("model-generation-speed")) {
      for (const badge of document.querySelectorAll(".pi-enh-model-speed")) {
        badge.remove();
      }
      return;
    }

    const assistantMsgs = document.querySelectorAll('div[data-message-role="assistant"]');
    const currentSessionId = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    const streamed = currentSessionId ? (liveStepSpeeds.get(currentSessionId) || null) : null;

    for (let index = 0; index < assistantMsgs.length; index++) {
      const msg = assistantMsgs[index];
      const entryId = getMessageEntryId(msg) || `msg-${index}`;
      const recorded = knownStepSpeeds.get(entryId) || null;
      const isLatest = index === assistantMsgs.length - 1;
      const metrics = isLatest && streamed?.tps > 0 && (streamed.live || !recorded)
        ? streamed
        : recorded;
      upsertModelSpeedBadge(msg, metrics);
    }
  }

  function findTimestampElement(footer) {
    if (!footer) return null;
    const marked = footer.querySelector('span[data-pi-enh-timestamp="true"]');
    if (marked) return marked;
    const spans = footer.querySelectorAll("span");
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i];
      if (s.classList && (s.classList.contains("pi-enh-duration-badge") || s.classList.contains("pi-enh-live-timer") || s.classList.contains("pi-enh-usage-dot"))) continue;
      const text = (s.textContent || "").trim();
      if (/\d{1,2}:\d{2}/.test(text) || /\d{1,2}月\d{1,2}日/.test(text) || (s.style && s.style.marginLeft === "auto")) {
        s.setAttribute("data-pi-enh-timestamp", "true");
        return s;
      }
    }
    return null;
  }

  function findUserMessages() {
    return document.querySelectorAll
      ? Array.from(document.querySelectorAll('[data-message-role="user"]'))
      : [];
  }

  function insertDurationBadge(msg, totalSec, queueSec = 0, toolCounts = {}, uTime = 0, aTime = 0, activeSec = null, pausedSec = 0, steerCount = 0, interruptCount = 0) {
    if (!msg || totalSec <= 0) return;
    const footer = msg.querySelector('div[style*="margin-top: 4px"], div[style*="marginTop: 4px"]') ||
                   msg.querySelector('div[style*="gap: 8px"]') ||
                   msg.lastElementChild;
    if (!footer) return;

    // Remove any live timer from this completed message
    const liveTimer = footer.querySelector(".pi-enh-live-timer");
    if (liveTimer) liveTimer.remove();

    // Remove the legacy compiled-bundle badge so this script remains the
    // single source of truth for the visible total duration.
    for (const legacyBadge of msg.querySelectorAll('div[title="任务执行总耗时"]')) {
      if (!String(legacyBadge.className || "").split(/\s+/).includes("pi-enh-duration-badge")) {
        legacyBadge.remove();
      }
    }

    let badge = msg.querySelector(".pi-enh-duration-badge");
    const copyBtn = findCopyButton(footer);
    const usageEl = typeof findUsageElement === "function" ? findUsageElement(footer) : null;
    const timeSpan = findTimestampElement(footer);

    function anchorBadgeElement(targetBadge) {
      targetBadge.style.marginLeft = "auto";
      targetBadge.style.marginRight = "4px";
      if (timeSpan) {
        if (timeSpan.style && timeSpan.style.marginLeft === "auto") {
          timeSpan.style.marginLeft = "0";
        }
        if (targetBadge.nextElementSibling !== timeSpan) {
          footer.insertBefore(targetBadge, timeSpan);
        }
      } else if (copyBtn) {
        if (targetBadge.previousElementSibling !== copyBtn) {
          copyBtn.after(targetBadge);
        }
      } else if (usageEl) {
        if (targetBadge.previousElementSibling !== usageEl) {
          usageEl.after(targetBadge);
        }
      } else if (targetBadge.parentElement !== footer) {
        footer.appendChild(targetBadge);
      }
    }

    if (!badge) {
      badge = document.createElement("div");
      badge.className = "pi-enh-duration-badge";
      badge.setAttribute("title", "任务执行总耗时");
      badge.style.fontSize = "11px";
      badge.style.color = "#38bdf8";
      badge.style.fontWeight = "500";
      badge.style.display = "inline-flex";
      badge.style.alignItems = "center";
      badge.style.gap = "3px";
      badge.style.whiteSpace = "nowrap";
      badge.style.flexShrink = "0";
      badge.style.cursor = "pointer";

      anchorBadgeElement(badge);
    } else {
      anchorBadgeElement(badge);
    }

    const realActiveSec = activeSec !== null ? activeSec : Math.max(1, totalSec - pausedSec);
    badge.setAttribute("data-total-sec", String(totalSec));
    badge.setAttribute("data-active-sec", String(realActiveSec));
    badge.setAttribute("data-paused-sec", String(pausedSec));
    badge.setAttribute("data-steer-count", String(steerCount));
    badge.setAttribute("data-interrupt-count", String(interruptCount));
    badge.setAttribute("data-queue-sec", String(queueSec));
    badge.setAttribute("data-tools", JSON.stringify(toolCounts || {}));
    if (uTime) badge.setAttribute("data-u-time", String(uTime));
    if (aTime) badge.setAttribute("data-a-time", String(aTime));

    let badgeText = `⏱️ ${formatSec(totalSec)}`;
    if (pausedSec > 3) {
      badgeText = `⏱️ ${formatSec(realActiveSec)} (含中断${formatSec(pausedSec)})`;
    }
    // Reassigning textContent replaces its child text node. With the chat
    // MutationObserver this would cause a self-triggering render loop.
    if (badge.textContent !== badgeText) badge.textContent = badgeText;
    msg.setAttribute("data-pi-enh-completed", "true");
  }

  function parseSessionData(data, explicitSessionId = null) {
    if (!data) return;
    const context = data.context;
    if (!context || !Array.isArray(context.messages)) return;
    const messages = context.messages;
    const entryIds = Array.isArray(context.entryIds) ? context.entryIds : [];

    function parseTime(t) {
      if (typeof t === "number") return isFinite(t) ? t : 0;
      if (!t) return 0;
      const parsed = Date.parse(t);
      return isNaN(parsed) || !isFinite(parsed) ? 0 : parsed;
    }

    function extractCompletedAt(msg) {
      if (!msg || typeof msg.completedAt === "undefined") return 0;
      const parsed = parseTime(msg.completedAt);
      return (typeof parsed === "number" && isFinite(parsed) && parsed > 0) ? parsed : 0;
    }

    let entryCompletionTimes = null;

    function getTreeEntryCompletionTime(targetId) {
      if (!targetId) return 0;
      if (entryCompletionTimes === null) {
        entryCompletionTimes = new Map();
        if (data && data.tree) {
          const visited = new Set();
          const stack = [data.tree];
          while (stack.length > 0) {
            const current = stack.pop();
            if (!current || typeof current !== "object") continue;
            if (visited.has(current)) continue;
            visited.add(current);

            if (Array.isArray(current)) {
              for (let i = 0; i < current.length; i++) {
                const item = current[i];
                if (item && typeof item === "object") stack.push(item);
              }
              continue;
            }

            const outerTime = parseTime(current.timestamp);

            const isCurrentMsg = !current.type || current.type === "message";
            if (current.id && isCurrentMsg && outerTime > 0) {
              entryCompletionTimes.set(current.id, outerTime);
            }

            if (current.entry && typeof current.entry === "object") {
              const entry = current.entry;
              const entryId = entry.id || current.id;
              const entryTime = parseTime(entry.timestamp) || outerTime;
              const isEntryMsg = entry.type ? entry.type === "message" : isCurrentMsg;
              if (entryId && isEntryMsg && entryTime > 0) {
                entryCompletionTimes.set(entryId, entryTime);
              }
            }

            const children = current.children;
            if (children) {
              if (Array.isArray(children)) {
                for (let i = 0; i < children.length; i++) {
                  const child = children[i];
                  if (child && typeof child === "object") stack.push(child);
                }
              } else if (typeof children === "object") {
                stack.push(children);
              }
            }
          }
        }
      }
      return entryCompletionTimes.get(targetId) || 0;
    }

    function extractText(content) {
      if (!content) return "";
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content.map((c) => c.text || "").join(" ").trim();
      }
      return "";
    }

    function isResumeInstruction(text) {
      if (!text) return false;
      const trimmed = text.trim();
      if (/^(继续|接着做|接着写|接着干|请继续|继续吧|接着完成|继续上面的任务|继续上面|好|继续推进|continue|go on|resume)$/i.test(trimmed)) return true;
      if (/^继续|^接着/i.test(trimmed) && trimmed.length <= 25) return true;
      return false;
    }

    let initialUMsg = null;
    let firstAMsg = null;
    let lastAMsg = null;
    let lastAEntryId = null;
    let lastAbortedAMsg = null;
    let steerCount = 0;
    let interruptCount = 0;
    let accumulatedPausedMs = 0;
    let toolCounts = {};
    let toolEntryIds = [];
    const toolCallToMainModel = new Map();
    let turnUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      stepCount: 0,
      toolStepCount: 0,
      model: null,
      subagent: {
        callCount: 0,
        agents: [],
        items: [],
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        actualCost: 0,
        hypotheticalMainCost: 0,
        savedCost: 0,
        savedRatio: "0.0",
        savings: null,
      },
    };
    let lastStepUsage = null;
    let hasTerminalStop = false;

    function isAssistantTerminalMessage(msg) {
      if (!msg) return false;
      if (msg.stopReason && msg.stopReason !== "toolUse") return true;
      if (Array.isArray(msg.content)) {
        const hasUnfinishedTool = msg.content.some((b) => {
          if (!b || b.type !== "toolCall") return false;
          const name = b.toolName || b.name || "";
          return name !== "select_quick_action" && name !== "ask_user";
        });
        if (!hasUnfinishedTool && msg.content.length > 0) return true;
        const hasTerminalTool = msg.content.some((b) => {
          if (!b || b.type !== "toolCall") return false;
          const name = b.toolName || b.name || "";
          return name === "select_quick_action" || name === "ask_user";
        });
        if (hasTerminalTool) return true;
      } else if (!msg.stopReason) {
        return true;
      }
      return false;
    }

    let latestAMsgInTurn = null;
    let latestAEntryIdInTurn = null;

    function finalizeTurn(isAtTurnBoundary = false) {
      const targetAMsg = lastAMsg || (isAtTurnBoundary ? latestAMsgInTurn : null);
      const targetAEntryId = lastAEntryId || (isAtTurnBoundary ? latestAEntryIdInTurn : null);
      const targetModel = targetAMsg?.model || (targetAMsg?.message && targetAMsg.message.model) || turnUsage.model || "";
      turnUsage.model = targetModel;

      if (turnUsage.subagent && turnUsage.subagent.callCount > 0 && turnUsage.subagent.totalTokens > 0) {
        const turnMainCost = turnUsage.cost || 0;
        const savings = computeSubagentSavings(turnUsage.subagent.items, targetModel, turnMainCost);
        turnUsage.subagent.savings = savings;
        if (savings) {
          turnUsage.subagent.hypotheticalMainCost = savings.hypotheticalMainCost;
          turnUsage.subagent.actualCost = savings.actualCost;
          turnUsage.subagent.savedCost = savings.savedCost;
          turnUsage.subagent.savedRatio = savings.savedRatio;
          turnUsage.subagent.canEstimate = savings.canEstimate;
        }
      }

      if (initialUMsg && targetAMsg && targetAEntryId) {
        const uTime = parseTime(initialUMsg.timestamp);
        const aStartTime = parseTime(targetAMsg.timestamp);
        const aCompletedAt = extractCompletedAt(targetAMsg);
        const hasCompletedAt = aCompletedAt > 0 && isFinite(aCompletedAt) && aCompletedAt >= aStartTime;
        const aTime = hasCompletedAt ? aCompletedAt : aStartTime;
        const durationSource = hasCompletedAt ? "completedAt" : "timestamp";
        const fTime = (firstAMsg && parseTime(firstAMsg.timestamp)) || aStartTime;
        if (uTime && aTime && aTime >= uTime) {
          const totalSec = Math.max(1, Math.round((aTime - uTime) / 1000));
          const pausedSec = Math.max(0, Math.round(accumulatedPausedMs / 1000));
          const activeSec = Math.max(1, totalSec - pausedSec);
          const queueSec = Math.max(0, Math.round((fTime - uTime) / 1000));
          setKnownTurnMetric(targetAEntryId, {
            totalSec,
            activeSec,
            pausedSec,
            queueSec,
            steerCount,
            interruptCount,
            toolCounts: { ...toolCounts },
            toolEntryIds: [...toolEntryIds],
            uTime,
            aTime,
            durationSource,
            turnUsage: { ...turnUsage, model: targetModel },
            lastStepUsage: (targetAMsg.usage || lastStepUsage) ? { ...(targetAMsg.usage || lastStepUsage), model: targetAMsg?.model || targetModel } : null,
          });
        }
      } else if (!initialUMsg && targetAMsg && targetAEntryId && turnUsage.stepCount > 0) {
        // 兜底保障：当历史由于极端截断未包含 user 起点消息时，依然为终态 assistant 消息记录多步执行耗时与累计 Token/费用
        const fTime = (firstAMsg && parseTime(firstAMsg.timestamp)) || 0;
        const aStartTime = parseTime(targetAMsg.timestamp);
        const aCompletedAt = extractCompletedAt(targetAMsg);
        const hasCompletedAt = aCompletedAt > 0 && isFinite(aCompletedAt) && aCompletedAt >= aStartTime;
        const aTime = hasCompletedAt ? aCompletedAt : aStartTime;
        const durationSource = hasCompletedAt ? "completedAt" : "timestamp";
        const totalSec = (fTime > 0 && aTime >= fTime) ? Math.max(1, Math.round((aTime - fTime) / 1000)) : 1;
        setKnownTurnMetric(targetAEntryId, {
          totalSec,
          activeSec: totalSec,
          pausedSec: 0,
          queueSec: 0,
          steerCount,
          interruptCount,
          toolCounts: { ...toolCounts },
          toolEntryIds: [...toolEntryIds],
          uTime: fTime || aTime,
          aTime,
          durationSource,
          turnUsage: { ...turnUsage, model: targetModel },
          lastStepUsage: (targetAMsg.usage || lastStepUsage) ? { ...(targetAMsg.usage || lastStepUsage), model: targetAMsg?.model || targetModel } : null,
          isTruncatedTurn: true,
        });
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const entryId = entryIds[i] || msg.id || null;

      if (msg.role === "user") {
        const userText = extractText(msg.content);
        const msgTime = parseTime(msg.timestamp);
        const lastATime = latestAMsgInTurn ? parseTime(latestAMsgInTurn.timestamp) : 0;
        const hasLongElapsed = lastATime > 0 && msgTime > lastATime && (msgTime - lastATime > 45000);

        // 判断 1：如果前序处于运行中（尚无任何终态 stop），当前属于中途引导 (Steering)
        // 防御性增强：若用户发送时间距上个助手回复已相隔超过 45 秒，绝非同一运行生命周期的中途插话，强制结算并开启新回合
        const isMidTurnSteer = initialUMsg && !hasTerminalStop && !lastAbortedAMsg && !hasLongElapsed;

        // 判断 2：如果前序被中止或出错，用户发送指令继续，当前属于中断恢复 (Resume)
        const isResumeAfterAbort = initialUMsg && lastAbortedAMsg && (
          isResumeInstruction(userText) || !hasTerminalStop
        );

        if (isMidTurnSteer) {
          steerCount += 1;
        } else if (isResumeAfterAbort) {
          interruptCount += 1;
          const abortStartTime = parseTime(lastAbortedAMsg.timestamp);
          const abortCompletedAt = extractCompletedAt(lastAbortedAMsg);
          const abortTime = (abortCompletedAt > 0 && isFinite(abortCompletedAt) && abortCompletedAt >= abortStartTime)
            ? abortCompletedAt
            : abortStartTime;
          if (msgTime > abortTime && abortTime > 0) {
            accumulatedPausedMs += (msgTime - abortTime);
          }
          lastAbortedAMsg = null;
          hasTerminalStop = false;
        } else {
          finalizeTurn(true);
          initialUMsg = msg;
          firstAMsg = null;
          lastAMsg = null;
          lastAEntryId = null;
          latestAMsgInTurn = null;
          latestAEntryIdInTurn = null;
          lastAbortedAMsg = null;
          hasTerminalStop = false;
          steerCount = 0;
          interruptCount = 0;
          accumulatedPausedMs = 0;
          toolCounts = {};
          toolEntryIds = [];
          toolCallToMainModel.clear();
          turnUsage = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: 0,
            stepCount: 0,
            toolStepCount: 0,
            model: null,
            subagent: {
              callCount: 0,
              agents: [],
              items: [],
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              actualCost: 0,
              hypotheticalMainCost: 0,
              savedCost: 0,
              savedRatio: "0.0",
              savings: null,
            },
          };
          lastStepUsage = null;
        }
      } else if (msg.role === "assistant") {
        if (!firstAMsg) firstAMsg = msg;
        latestAMsgInTurn = msg;
        if (entryId) latestAEntryIdInTurn = entryId;
        const msgModel = msg.model || (msg.message && msg.message.model) || null;
        if (msgModel && !turnUsage.model) {
          turnUsage.model = msgModel;
        }
        const assistantStartedAt = parseTime(msg.timestamp);
        const stepCompletedAt = extractCompletedAt(msg);
        let assistantCompletedAt = (stepCompletedAt > 0 && isFinite(stepCompletedAt) && stepCompletedAt >= assistantStartedAt) ? stepCompletedAt : 0;
        if (!assistantCompletedAt && entryId && msg.usage && (msg.usage.output || 0) > 0 && assistantStartedAt > 0) {
          const fallbackEnd = getTreeEntryCompletionTime(entryId);
          if (fallbackEnd > 0 && isFinite(fallbackEnd) && fallbackEnd >= assistantStartedAt) {
            assistantCompletedAt = fallbackEnd;
          }
        }
        if (entryId && msg.usage && (msg.usage.output || 0) > 0 && assistantStartedAt > 0 && assistantCompletedAt - assistantStartedAt >= 100) {
          setKnownStepSpeed(entryId, {
            output: msg.usage.output,
            durationSec: (assistantCompletedAt - assistantStartedAt) / 1000,
            exact: true,
          });
        }
        turnUsage.stepCount++;
        let hasTool = false;
        let isTerminalAction = false;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === "toolCall") {
              hasTool = true;
              const name = b.toolName || b.name || "tool";
              toolCounts[name] = (toolCounts[name] || 0) + 1;
              const callId = b.toolCallId || b.id;
              if (callId) {
                toolCallToMainModel.set(callId, msgModel || turnUsage.model || "");
              }
              if (name === "select_quick_action" || name === "ask_user") {
                isTerminalAction = true;
              }
            }
          }
        }
        if (hasTool && !isTerminalAction) {
          turnUsage.toolStepCount++;
          if (entryId) toolEntryIds.push(entryId);
        }
        if (msg.usage) {
          turnUsage.input += msg.usage.input || 0;
          turnUsage.output += msg.usage.output || 0;
          turnUsage.cacheRead += msg.usage.cacheRead || 0;
          turnUsage.cacheWrite += msg.usage.cacheWrite || 0;
          turnUsage.totalTokens += msg.usage.totalTokens || (
            (msg.usage.input || 0) + (msg.usage.output || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0)
          );
          if (msg.usage.cost && typeof msg.usage.cost.total === "number") {
            turnUsage.cost += msg.usage.cost.total;
          }
        }

        if (msg.stopReason === "aborted" || msg.stopReason === "error") {
          lastAbortedAMsg = msg;
        } else if (isAssistantTerminalMessage(msg)) {
          lastAMsg = msg;
          lastStepUsage = msg.usage || null;
          if (entryId) lastAEntryId = entryId;
          hasTerminalStop = true;
          lastAbortedAMsg = null;
        }
      } else if (msg.role === "toolResult" && (msg.toolName === "subagent" || msg.name === "subagent")) {
        const details = msg.details || (msg.message && msg.message.details);
        const callId = msg.toolCallId || msg.tool_call_id || msg.id || null;
        let matchedMainModel = callId ? toolCallToMainModel.get(callId) : null;
        let isFallbackMainModel = false;
        if (!matchedMainModel) {
          matchedMainModel = turnUsage.model || "";
          isFallbackMainModel = true;
        }

        if (details && Array.isArray(details.results)) {
          for (const r of details.results) {
            if (!r || !r.usage) continue;
            turnUsage.subagent.callCount++;
            const aName = r.agent || "subagent";
            const aModel = r.model || "";
            const aModelDisplay = formatModelDisplayName(aModel);
            const label = `${aName}${aModelDisplay ? ` (${aModelDisplay})` : ""}`;
            if (!turnUsage.subagent.agents.includes(label)) {
              turnUsage.subagent.agents.push(label);
            }
            const inTok = r.usage.input || 0;
            const outTok = r.usage.output || 0;
            const crTok = r.usage.cacheRead || 0;
            const cwTok = r.usage.cacheWrite || 0;
            const totTok = inTok + outTok + crTok + cwTok;

            turnUsage.subagent.input += inTok;
            turnUsage.subagent.output += outTok;
            turnUsage.subagent.cacheRead += crTok;
            turnUsage.subagent.cacheWrite += cwTok;
            turnUsage.subagent.totalTokens += totTok;

            const recCost = (typeof r.usage.cost === "number" && r.usage.cost > 0)
              ? r.usage.cost
              : ((typeof r.cost === "number" && r.cost > 0) ? r.cost : null);

            turnUsage.subagent.items.push({
              agent: aName,
              model: aModel,
              mainModel: matchedMainModel,
              isFallbackMainModel,
              usage: {
                input: inTok,
                output: outTok,
                cacheRead: crTok,
                cacheWrite: cwTok,
                cost: recCost,
              },
              totalTokens: totTok,
            });
          }
        }
      }
    }
    finalizeTurn(false);

    const activeSessionId = explicitSessionId || getCurrentSessionId();
    if (activeSessionId) {
      if (initialUMsg && !hasTerminalStop) {
        const uTime = parseTime(initialUMsg.timestamp);
        if (uTime > 0) {
          recordActiveTurnStart(activeSessionId, uTime, initialUMsg.id || null, true);
        }
      } else if (hasTerminalStop) {
        if (typeof isChatSessionRunning === "function" && !isChatSessionRunning()) {
          clearActiveTurn(activeSessionId);
        }
      }
    }

    syncAllDurationBadges();
    syncAllUsageBadges();
    syncAllModelSpeedBadges();
    syncAllTaskToolAutoCollapse();
  }

  const TASK_TOOL_AUTO_COLLAPSE_MARKER = "data-pi-enh-task-tool-auto-collapsed";

  function syncToolCardLayoutStability() {
    const enabled = isPluginEnabled("tool-card-layout-stability");
    if (document.documentElement) {
      document.documentElement.classList.toggle("pi-enh-tool-card-layout-stability-active", enabled);
    }
  }

  function syncTaskToolCollapseActiveState() {
    const enabled = isPluginEnabled("task-tool-auto-collapse");
    if (document.documentElement) {
      document.documentElement.classList.toggle("pi-enh-tool-collapse-active", enabled);
      document.documentElement.classList.toggle(
        "pi-enh-chat-running",
        Boolean(typeof isChatSessionRunning === "function" && isChatSessionRunning())
      );
    }
  }

  function isNativeToolCardToggle(button) {
    const style = button?.style;
    return Boolean(
      style &&
      style.cursor === "pointer" &&
      style.fontSize === "12px" &&
      style.textAlign === "left" &&
      (style.flex === "1" || String(style.flex).startsWith("1 ")) &&
      style.padding === "6px 10px"
    );
  }

  const SUBAGENT_PREVIEW_ORIGINAL_ATTR = "data-pi-enh-subagent-preview-original";
  const SUBAGENT_BROADCAST_HIDDEN_ATTR = "data-pi-enh-subagent-broadcast-hidden";
  const SUBAGENT_BROADCAST_DISPLAY_ATTR = "data-pi-enh-subagent-broadcast-display";

  function getSubagentModelLabel(agentName) {
    const normalized = String(agentName || "").trim().toLowerCase();
    if (/^gemini-flash-(?:scout|worker)$/.test(normalized)) return "Gemini 3.8 Flash High";
    if (/^luna-(?:scout|worker)$/.test(normalized)) return "Luna Max";
    return "";
  }

  function getSubagentCardParts(button) {
    if (!isNativeToolCardToggle(button)) return null;
    const children = Array.from(button.children || []);
    const spans = children.filter((child) => child?.tagName === "SPAN");
    if (spans.length < 2 || String(spans[0].textContent || "").trim().toLowerCase() !== "subagent") return null;
    return { toolLabel: spans[0], preview: spans[1] };
  }

  function restoreSubagentDispatchCards() {
    for (const preview of document.querySelectorAll(`[${SUBAGENT_PREVIEW_ORIGINAL_ATTR}]`)) {
      if (preview.childNodes.length === 1 && preview.childNodes[0].nodeType === 3) {
        preview.childNodes[0].nodeValue = preview.getAttribute(SUBAGENT_PREVIEW_ORIGINAL_ATTR) || preview.textContent;
      } else {
        preview.textContent = preview.getAttribute(SUBAGENT_PREVIEW_ORIGINAL_ATTR) || preview.textContent;
      }
      preview.removeAttribute(SUBAGENT_PREVIEW_ORIGINAL_ATTR);
    }
    for (const el of document.querySelectorAll(`[${SUBAGENT_BROADCAST_HIDDEN_ATTR}]`)) {
      el.style.display = el.getAttribute(SUBAGENT_BROADCAST_DISPLAY_ATTR) || "";
      el.removeAttribute(SUBAGENT_BROADCAST_HIDDEN_ATTR);
      el.removeAttribute(SUBAGENT_BROADCAST_DISPLAY_ATTR);
    }
  }

  function isLegacySubagentBroadcastParagraph(paragraph) {
    const text = String(paragraph?.textContent || "").replace(/\s+/g, " ").trim();
    return /^(?:[⚡🌙]\s*)?调度子代理\s*[：:]\s*[\w.-]+\s*[｜|]\s*挂载模型\s*[：:]\s*\S.+$/u.test(text);
  }

  function isSubagentRoleDescriptionParagraph(paragraph) {
    const text = String(paragraph?.textContent || "").replace(/\s+/g, " ").trim();
    return /^(?:它|由它|子代理)(?:负责|主要负责|只读|协助|执行|处理)/.test(text);
  }

  function syncSubagentDispatchCards() {
    if (!isPluginEnabled("subagent-dispatch-cards")) {
      restoreSubagentDispatchCards();
      return;
    }

    for (const button of document.querySelectorAll("button")) {
      const parts = getSubagentCardParts(button);
      if (!parts) continue;
      const original = parts.preview.getAttribute(SUBAGENT_PREVIEW_ORIGINAL_ATTR) || String(parts.preview.textContent || "").trim();
      const agentName = original.split(" · ")[0].trim();
      const modelLabel = getSubagentModelLabel(agentName);
      if (!modelLabel) continue;
      if (!parts.preview.hasAttribute(SUBAGENT_PREVIEW_ORIGINAL_ATTR)) {
        parts.preview.setAttribute(SUBAGENT_PREVIEW_ORIGINAL_ATTR, original);
      }
      const targetText = `${agentName} · ${modelLabel}`;
      if (parts.preview.textContent !== targetText) {
        if (parts.preview.childNodes.length === 1 && parts.preview.childNodes[0].nodeType === 3) {
          parts.preview.childNodes[0].nodeValue = targetText;
        } else {
          parts.preview.textContent = targetText;
        }
      }
    }

    for (const msgText of document.querySelectorAll('div[data-message-role="assistant"] div[data-message-text="true"]')) {
      const paragraphs = Array.from(msgText.querySelectorAll('.markdown-body > p'));
      if (paragraphs.length === 0) continue;

      const hasBroadcastHeader = paragraphs.some(isLegacySubagentBroadcastParagraph);
      if (!hasBroadcastHeader) continue;

      const nonBroadcastParagraphs = paragraphs.filter((p) => !isLegacySubagentBroadcastParagraph(p) && !isSubagentRoleDescriptionParagraph(p));
      if (nonBroadcastParagraphs.length === 0) {
        if (!msgText.hasAttribute(SUBAGENT_BROADCAST_HIDDEN_ATTR)) {
          msgText.setAttribute(SUBAGENT_BROADCAST_DISPLAY_ATTR, msgText.style.display || "");
          msgText.setAttribute(SUBAGENT_BROADCAST_HIDDEN_ATTR, "true");
          msgText.style.display = "none";
        }
      } else {
        for (let i = 0; i < paragraphs.length; i++) {
          const p = paragraphs[i];
          if (isLegacySubagentBroadcastParagraph(p)) {
            if (!p.hasAttribute(SUBAGENT_BROADCAST_HIDDEN_ATTR)) {
              p.setAttribute(SUBAGENT_BROADCAST_DISPLAY_ATTR, p.style.display || "");
              p.setAttribute(SUBAGENT_BROADCAST_HIDDEN_ATTR, "true");
              p.style.display = "none";
            }
            const nextP = paragraphs[i + 1];
            if (nextP && isSubagentRoleDescriptionParagraph(nextP) && !nextP.hasAttribute(SUBAGENT_BROADCAST_HIDDEN_ATTR)) {
              nextP.setAttribute(SUBAGENT_BROADCAST_DISPLAY_ATTR, nextP.style.display || "");
              nextP.setAttribute(SUBAGENT_BROADCAST_HIDDEN_ATTR, "true");
              nextP.style.display = "none";
            }
          }
        }
      }
    }
  }

  function isNativeProcessGroupToggle(button) {
    if (!button || !button.hasAttribute("aria-expanded")) return false;
    const title = String(button.getAttribute("title") || "").toLowerCase();
    const label = String(button.getAttribute("aria-label") || "").toLowerCase();
    const text = String(button.textContent || "").toLowerCase();
    const matchesTitle = /(?:收起|展开)处理详情|(?:collapse|expand)\s*process/.test(title);
    const matchesLabel = /(?:收起|展开)处理详情|(?:collapse|expand)\s*process/.test(label);
    const matchesText = text.includes("处理详情") || text.includes("process details") || (text.includes("次工具调用") && text.includes("条消息"));
    return matchesTitle || matchesLabel || matchesText;
  }

  function collapseAllProcessDetailsGroups() {
    if (isChatSessionRunning()) return;
    for (const button of document.querySelectorAll("button")) {
      if (!isNativeProcessGroupToggle(button)) continue;
      if (button.hasAttribute(TASK_TOOL_AUTO_COLLAPSE_MARKER)) continue;

      // Mark collapsed groups too, before the user's first manual expansion.
      button.setAttribute(TASK_TOOL_AUTO_COLLAPSE_MARKER, "true");
      if (button.getAttribute("aria-expanded") === "true") {
        try { button.click(); } catch (e) {}
      }
    }
  }

  function isAssistantMessageFinished(message, index, totalMessages, isRunning) {
    if (isRunning) {
      // 处理期间保持整个回合可见；只在任务结算后折叠。
      return false;
    }
    // 非运行状态下，排在前面的消息全部属于历史已完成回合
    if (index < totalMessages - 1) return true;

    // 针对最后一条消息：如果已被记录完成，或属于已终结回合中的工具调用，判定为完成
    const entryId = getMessageEntryId(message);
    if (entryId && knownTurnMetrics.has(entryId)) return true;
    if (message.hasAttribute("data-pi-enh-completed")) return true;
    for (const metrics of knownTurnMetrics.values()) {
      if (metrics.toolEntryIds && metrics.toolEntryIds.includes(entryId)) return true;
    }
    return false;
  }

  function collapseAllNativeToolCards() {
    const isRunning = typeof isChatSessionRunning === "function" ? isChatSessionRunning() : false;
    const assistantMessages = Array.from(document.querySelectorAll('div[data-message-role="assistant"]'));
    if (assistantMessages.length === 0) return;

    for (let i = 0; i < assistantMessages.length; i++) {
      const message = assistantMessages[i];
      if (!isAssistantMessageFinished(message, i, assistantMessages.length, isRunning)) {
        continue;
      }

      for (const button of message.querySelectorAll("button")) {
        if (!isNativeToolCardToggle(button)) continue;
        const toolCard = button.parentElement?.parentElement;
        if (!toolCard) continue;
        toolCard.setAttribute("data-pi-enh-tool-card", "true");
        if (toolCard.hasAttribute(TASK_TOOL_AUTO_COLLAPSE_MARKER)) continue;

        // 原生工具卡片折叠时仅有 header（children.length === 1）；展开时有更多子元素
        if ((toolCard.children?.length || 0) > 1) {
          try {
            button.click();
          } catch (e) {}
        }
        toolCard.setAttribute(TASK_TOOL_AUTO_COLLAPSE_MARKER, "true");
      }
    }
  }

  function syncAllTaskToolAutoCollapse() {
    syncTaskToolCollapseActiveState();
    // Native React grouping owns the first render and completion transition.
    // Never scan/click/hide its messages during scrolling or periodic sync.
    if (window.__PI_ENH_NATIVE_PROCESS_COLLAPSE__ === 1) {
      if (orphanOriginalDisplay.size) removeOrphanProcessBars();
      return;
    }
    if (!isPluginEnabled("task-tool-auto-collapse")) {
      removeOrphanProcessBars();
      return;
    }
    collapseAllProcessDetailsGroups();
    collapseAllNativeToolCards();
    aggregateOrphanProcessSteps();
  }

  function hasPendingToolCollapse() {
    if (!isPluginEnabled("task-tool-auto-collapse")) return false;
    if (window.__PI_ENH_NATIVE_PROCESS_COLLAPSE__ === 1) return false;

    const scroll = getChatScrollContainer() || document.querySelector(".chat-content");
    if (!scroll) return false;

    // 仅在当前会话聊天区内检查实际未折叠目标，杜绝全局遍历
    const buttons = scroll.querySelectorAll("button");
    for (const button of buttons) {
      if (isNativeProcessGroupToggle(button) && !button.hasAttribute(TASK_TOOL_AUTO_COLLAPSE_MARKER)) {
        if (button.getAttribute("aria-expanded") === "true") return true;
      }
      if (isNativeToolCardToggle(button)) {
        const toolCard = button.parentElement?.parentElement;
        if (toolCard && !toolCard.hasAttribute(TASK_TOOL_AUTO_COLLAPSE_MARKER)) {
          if ((toolCard.children?.length || 0) > 1) return true;
        }
      }
    }

    // 孤立纯过程消息检查实际未折叠目标，严禁根据普通 assistant 条数盲判
    if (typeof isChatSessionRunning === "function" && isChatSessionRunning()) return false;
    const orphanCandidates = scroll.querySelectorAll('div[data-message-role="assistant"]:not([data-pi-enh-orphan-grouped])');
    for (const msg of orphanCandidates) {
      if (msg.closest('[data-pi-enh-orphan-grouped="true"]')) continue;
      const row = msg.parentElement?.getAttribute("data-entry-id") === msg.getAttribute("data-entry-id") ? msg.parentElement : msg;
      if (row && window.getComputedStyle(row).display === "none") continue;
      if (isPureProcessAssistantMessage(msg)) {
        return true;
      }
    }
    return false;
  }
  window.__PI_ENH_HAS_PENDING_TOOL_COLLAPSE__ = hasPendingToolCollapse;
  window.__PI_ENH_FORCE_TOOL_COLLAPSE__ = syncAllTaskToolAutoCollapse;

  // ==========================================
  // 孤立纯过程消息吸附聚合器 (Orphan Process Aggregator)
  // ==========================================
  orphanOriginalDisplay = new Map();

  function hasNativeProcessBlock(el) {
    return Array.from(el.querySelectorAll("button")).some((button) =>
      isNativeToolCardToggle(button) || /^(thinking|思考)$/i.test(button.getAttribute("title") || "")
    );
  }

  function isPureProcessAssistantMessage(el) {
    if (!el || el.getAttribute("data-message-role") !== "assistant") return false;
    if (el.querySelector('[role="alert"]')) return false;
    const blockContainer = el.querySelector('div[style*="flex-direction: column"]');
    if (blockContainer) {
      const blocks = Array.from(blockContainer.children);
      if (blocks.length > 0) {
        const lastIdx = blocks.findLastIndex(hasNativeProcessBlock);
        return lastIdx === blocks.length - 1;
      }
    }
    const textNode = el.querySelector('[data-message-text="true"]');
    return !textNode?.textContent?.trim() && hasNativeProcessBlock(el);
  }

  function restoreOrphanNode(node) {
    if (!orphanOriginalDisplay.has(node)) return;
    node.style.display = orphanOriginalDisplay.get(node);
    node.removeAttribute("data-pi-enh-orphan-grouped");
    node.removeAttribute("data-pi-enh-orphan-expanded");
    orphanOriginalDisplay.delete(node);
  }

  function aggregateOrphanProcessSteps() {
    const scroll = getChatScrollContainer() || document.querySelector(".chat-content");
    if (!scroll) { removeOrphanProcessBars(); return; }
    const isRunning = isChatSessionRunning();
    const lists = new Set();
    // Native layout: scroll > padding > list > [data-entry-id] > MessageView.
    // Never wrap/reparent React-owned messages or regroup native process details.
    for (const message of scroll.querySelectorAll('div[data-message-role="assistant"]')) {
      let inNativeGroup = false;
      for (let p = message.parentElement; p && p !== scroll; p = p.parentElement) {
        if (Array.from(p.children).some((child) => child.tagName?.toLowerCase() === "button" && isNativeProcessGroupToggle(child))) {
          inNativeGroup = true;
          break;
        }
      }
      if (inNativeGroup) continue;
      const parent = message.parentElement;
      const row = parent?.getAttribute("data-entry-id") === message.getAttribute("data-entry-id") ? parent : message;
      if (row?.parentElement) lists.add(row.parentElement);
    }

    const oldBars = Array.from(document.querySelectorAll(".pi-enh-orphan-process-bar"));
    const usedBars = new Set(), usedNodes = new Set();
    for (const list of lists) {
      let rows = Array.from(list.children).filter((row) => !row.classList.contains("pi-enh-orphan-process-bar"));
      if (isRunning) {
        // The whole live tail stays available, not merely the last DOM child.
        const anchor = rows.findLastIndex((row) => row.getAttribute("data-message-role") === "user" ||
          row.querySelector('[data-message-role="user"]') || row.querySelector(".markdown-user-message") || row.querySelector(".markdown-compaction-message"));
        rows = anchor < 0 ? [] : rows.slice(0, anchor);
      }
      let group = [], anchorRow = null, stepCount = 0;
      const flush = () => {
        if (!group.length) return;
        const bar = oldBars.find((bar) => !usedBars.has(bar) && bar.__boundOrphanNodes?.some((node) => group.includes(node)));
        const active = applyOrphanProcessBar(group, anchorRow, stepCount, bar);
        usedBars.add(active);
        group.forEach((node) => usedNodes.add(node));
        group = []; anchorRow = null; stepCount = 0;
      };
      for (const row of rows) {
        const message = row.getAttribute("data-message-role") === "assistant" ? row :
          Array.from(row.children).find((child) => child.getAttribute("data-message-role") === "assistant");
        if (isPureProcessAssistantMessage(message)) {
          anchorRow ||= row; group.push(row); stepCount++;
        } else if (group.length && row.getAttribute("role") === "alert" && /websocket|error|failed|network/i.test(row.textContent || "")) {
          group.push(row);
        } else {
          // Keep the final answer and its footer visible; fold all blocks up to and
          // including the last process block (matching native React eI() processBlocks).
          const blockContainer = message?.querySelector('div[style*="flex-direction: column"]');
          const blocks = blockContainer ? Array.from(blockContainer.children) : [];
          const lastProcessIdx = blocks.findLastIndex(hasNativeProcessBlock);
          const prefix = lastProcessIdx >= 0 ? blocks.slice(0, lastProcessIdx + 1) : [];
          if (prefix.length) { anchorRow ||= row; group.push(...prefix); stepCount++; }
          flush();
        }
      }
      flush();
    }
    for (const bar of oldBars) if (!usedBars.has(bar)) bar.remove();
    for (const node of orphanOriginalDisplay.keys()) if (!usedNodes.has(node)) restoreOrphanNode(node);
  }

  function applyOrphanProcessBar(nodes, anchorRow = nodes[0], stepCount = nodes.length, existingBar = null) {
    if (!nodes || nodes.length === 0) return;
    const parent = anchorRow.parentElement;
    if (!parent) return;

    let bar = existingBar;
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "pi-enh-orphan-process-bar";
      bar.style.marginBottom = "12px";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "pi-enh-orphan-process-toggle";
      toggle.setAttribute("aria-expanded", "false");
      toggle.style.display = "inline-flex";
      toggle.style.alignItems = "center";
      toggle.style.gap = "7px";
      toggle.style.padding = "4px 10px";
      toggle.style.border = "1px solid var(--border, #27272a)";
      toggle.style.borderRadius = "6px";
      toggle.style.background = "color-mix(in srgb, var(--bg-selected, #27272a) 40%, transparent)";
      toggle.style.color = "var(--text-muted, #a1a1aa)";
      toggle.style.fontSize = "12px";
      toggle.style.fontWeight = "500";
      toggle.style.cursor = "pointer";

      const label = document.createElement("span");
      label.className = "pi-enh-orphan-label";
      const arrow = document.createElement("span");
      arrow.className = "pi-enh-orphan-arrow";
      arrow.textContent = "⌄";
      toggle.append(label, arrow);

      toggle.addEventListener("click", () => {
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        const next = !expanded;
        toggle.setAttribute("aria-expanded", next ? "true" : "false");
        const arrow = toggle.querySelector(".pi-enh-orphan-arrow");
        if (arrow) arrow.textContent = next ? "⌃" : "⌄";
        for (const item of bar.__boundOrphanNodes || []) {
          if (next) item.setAttribute("data-pi-enh-orphan-expanded", "true");
          else item.removeAttribute("data-pi-enh-orphan-expanded");
          item.style.display = next ? (orphanOriginalDisplay.get(item) || "") : "none";
        }
      });

      bar.appendChild(toggle);
    }
    if (anchorRow.previousElementSibling !== bar) parent.insertBefore(bar, anchorRow);

    bar.__boundOrphanNodes = nodes;
    const label = bar.querySelector(".pi-enh-orphan-label");
    const summary = `🛠️ 执行过程 · ${stepCount} 个中间步骤`;
    if (label.textContent !== summary) label.textContent = summary;
    const toggle = bar.querySelector(".pi-enh-orphan-process-toggle");
    const isExpanded = toggle ? toggle.getAttribute("aria-expanded") === "true" : false;

    for (const item of nodes) {
      if (!orphanOriginalDisplay.has(item)) orphanOriginalDisplay.set(item, item.style.display || "");
      if (!item.hasAttribute("data-pi-enh-orphan-grouped")) item.setAttribute("data-pi-enh-orphan-grouped", "true");
      if (isExpanded) item.setAttribute("data-pi-enh-orphan-expanded", "true");
      else item.removeAttribute("data-pi-enh-orphan-expanded");
      const display = isExpanded ? orphanOriginalDisplay.get(item) : "none";
      if (item.style.display !== display) item.style.display = display;
    }
    return bar;
  }

  function removeOrphanProcessBars() {
    for (const bar of document.querySelectorAll(".pi-enh-orphan-process-bar")) {
      bar.remove();
    }
    for (const node of orphanOriginalDisplay.keys()) restoreOrphanNode(node);
  }

  // History prepend and folding must share the same final-layout reading anchor.
  let historyScrollBinding = null;
  let historyRestoreFrame = null;
  let historyAcceptedPage = null;

  async function deduplicateHistoryPage(url, response) {
    if (!isPluginEnabled("history-scroll-stability")) return response;
    try {
      const data = await response.clone().json();
      const context = data?.context;
      if (!Array.isArray(context?.messages) || !Array.isArray(context.entryIds) || context.messages.length !== context.entryIds.length) return response;
      const params = new URLSearchParams(url.split("?")[1] || "");
      const scope = `${getCurrentSessionId()}:${params.get("leafId") || ""}`;
      if (historyAcceptedPage?.scope !== scope) {
        const loaded = window.__PI_ENH_GET_HISTORY_STATE__?.();
        const ids = loaded?.sessionId === getCurrentSessionId() && Array.isArray(loaded.entryIds)
          ? loaded.entryIds
          : Array.from(getChatScrollContainer()?.querySelectorAll("[data-entry-id]") || []).map(n => n.getAttribute("data-entry-id"));
        historyAcceptedPage = { scope, ids: new Set(ids), cursor: null, hasMore: true };
      }
      const state = historyAcceptedPage;
      const keep = [];
      context.entryIds.forEach((id, index) => {
        if (!state.ids.has(id)) { state.ids.add(id); keep.push(index); }
      });
      if (keep.length || !state.cursor) {
        state.cursor = context.oldestEntryId;
        state.hasMore = context.hasMore;
      } else if (context.hasMore === false) {
        state.hasMore = false;
      }
      if (keep.length === context.entryIds.length) return response;
      if (keep.length === 0 && context.hasMore) {
        state.cursor = context.oldestEntryId;
        return response;
      }
      return createCachedResponse({ ...data, context: {
        ...context, messages: keep.map(index => context.messages[index]),
        entryIds: keep.map(index => context.entryIds[index]),
        oldestEntryId: state.cursor, hasMore: state.hasMore,
      } }, response.headers, "HISTORY-DEDUP");
    } catch (e) {
      return response; // Native loader retains its normal error handling.
    }
  }

  function cancelHistoryScrollRestore() {
    if (historyRestoreFrame !== null) window.cancelAnimationFrame?.(historyRestoreFrame);
    historyRestoreFrame = null;
  }

  const HISTORY_TAIL_ATTACH_PX = 80;

  function getHistoryTailDistance(scroll) {
    return Math.max(0, (scroll?.scrollHeight || 0) - (scroll?.clientHeight || 0) - (scroll?.scrollTop || 0));
  }

  function cancelHistoryTailFrame(binding) {
    if (!binding || binding.tailFrame == null) return;
    if (binding.tailFrameKind === "timeout") window.clearTimeout?.(binding.tailFrame);
    else window.cancelAnimationFrame?.(binding.tailFrame);
    binding.tailFrame = null;
    binding.tailFrameKind = null;
  }

  function markHistoryTailGesture(binding) {
    if (binding !== historyScrollBinding) return;
    binding.tailGestureUntil = Date.now() + 1400;
    cancelHistoryTailFrame(binding);
  }

  function blurComposerForMinimapNavigation() {
    const active = document.activeElement;
    if (active?.matches?.('.pi-enh-formatted-composer[contenteditable="true"], textarea.chat-input-textarea')) {
      active.blur();
    }
  }

  let minimapNavigationScrollGuard = null;
  let minimapNativeRevealScrollBlock = null;

  function clearNativeMinimapRevealScrollBlock() {
    const block = minimapNativeRevealScrollBlock;
    if (!block) return;
    minimapNativeRevealScrollBlock = null;
    if (block.timer !== null) clearManagedTimeout(block.timer);
  }

  function suppressNativeMinimapRevealScroll(scroll) {
    clearNativeMinimapRevealScrollBlock();
    if (!scroll) return;
    const block = { scroll, timer: null, expiresAt: Date.now() + 2200 };
    minimapNativeRevealScrollBlock = block;
    block.timer = addManagedTimeout(() => {
      if (minimapNativeRevealScrollBlock === block) clearNativeMinimapRevealScrollBlock();
    }, 2200);
  }

  function clearMinimapNavigationScrollGuard() {
    const guard = minimapNavigationScrollGuard;
    if (!guard) return;
    minimapNavigationScrollGuard = null;
    if (guard.timer !== null) clearManagedTimeout(guard.timer);
    if (guard.scroll.scrollTo === guard.wrapped) guard.scroll.scrollTo = guard.original;
  }

  function guardMinimapNavigationFromAutoFollow(scroll) {
    clearMinimapNavigationScrollGuard();
    if (!scroll || typeof scroll.scrollTo !== "function") return;
    const original = scroll.scrollTo;
    const sessionId = getCurrentSessionId();
    const wrapped = function (...args) {
      const options = args[0];
      const maxTop = Math.max(0, this.scrollHeight - this.clientHeight);
      if (this === scroll && minimapNativeRevealScrollBlock?.scroll === scroll &&
          Date.now() < minimapNativeRevealScrollBlock.expiresAt && options?.behavior === "smooth") {
        return;
      }
      if (this === scroll && options?.behavior === "smooth" && Number(options.top) >= maxTop - 30 && maxTop > 120) {
        clearMinimapNavigationScrollGuard(); // Explicitly returning to the tail should re-enable live follow.
      }
      if (this === scroll && sessionId === getCurrentSessionId() && isPluginEnabled("minimap-full-nav") &&
          options?.behavior === "auto" && Number(options.top) >= maxTop - 30 && maxTop > 120) {
        return;
      }
      return original.apply(this, args);
    };
    scroll.scrollTo = wrapped;
    const guard = { scroll, original, wrapped, timer: null };
    minimapNavigationScrollGuard = guard;
    guard.timer = addManagedTimeout(() => {
      if (minimapNavigationScrollGuard === guard) clearMinimapNavigationScrollGuard();
    }, 4000);
  }

  activeCleanups.push(clearMinimapNavigationScrollGuard);
  activeCleanups.push(clearNativeMinimapRevealScrollBlock);

  function releaseHistoryTailForMinimapNavigation(nativeOwner = false) {
    blurComposerForMinimapNavigation();
    const scroll = getChatScrollContainer();
    // The native streaming follower keeps its own isNearBottomRef. Unlike a
    // gesture inside the chat, clicking the sibling minimap never updates it.
    // Leave the tail and notify its scroll listener before React's navigation
    // click runs, so queued streaming frames cannot reclaim the viewport.
    if (scroll) {
      const maxTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
      const distance = maxTop - scroll.scrollTop;
      if (maxTop > 120 && distance <= 8) {
        scroll.scrollTop = maxTop - 24;
        scroll.dispatchEvent(new Event("scroll"));
      }
    }
    const currentSid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    if (typeof isSessionScrollRestoring === "function" && isSessionScrollRestoring(currentSid)) {
      cancelActiveScrollRestore("minimap-navigation");
    }
    cancelHistoryScrollRestore();
    cancelVirtualHistoryAnchor?.("minimap-navigation");
    // Stream updates can race the smooth first-turn jump while React still
    // considers the viewport attached to the tail. Ignore only its automatic
    // bottom-follow calls for this navigation; explicit smooth bottom clicks
    // and normal following outside this short window remain untouched.
    if (!nativeOwner) guardMinimapNavigationFromAutoFollow(scroll);
    if (!isPluginEnabled("history-scroll-stability")) return;
    if (!historyScrollBinding || historyScrollBinding.sessionId !== currentSid || historyScrollBinding.scroll !== getChatScrollContainer()) {
      syncHistoryScrollStability(true);
    }
    const binding = historyScrollBinding;
    if (!binding || (currentSid && binding.sessionId !== currentSid)) return;
    const now = Date.now();
    const alreadyNavigating = now <= (binding.tailMinimapNavUntil || 0);
    binding.tailPinned = false;
    binding.tailGestureUntil = now + 1400;
    binding.tailMinimapNavUntil = now + 1400;
    if (!alreadyNavigating) {
      binding.tailMinimapNavLeftBottom = getHistoryTailDistance(binding.scroll) > 2;
    } else if (getHistoryTailDistance(binding.scroll) > 2) {
      binding.tailMinimapNavLeftBottom = true;
    }
    binding.tailLastTop = binding.scroll?.scrollTop || 0;
    cancelHistoryTailFrame(binding);
  }

  // Native navigation announces intent; history-memory plugins cancel their own
  // pending restore, without intercepting the React renderer or its scrollTo.
  const handleNativeMinimapNavigation = () => releaseHistoryTailForMinimapNavigation(true);
  document.addEventListener("pi:minimap-navigation", handleNativeMinimapNavigation);
  activeCleanups.push(() => document.removeEventListener("pi:minimap-navigation", handleNativeMinimapNavigation));

  function updateHistoryTailAttachment(binding) {
    if (binding !== historyScrollBinding) return;
    const scroll = binding.scroll;
    const top = scroll.scrollTop || 0;
    const distance = getHistoryTailDistance(scroll);
    const inMinimapNav = Date.now() <= (binding.tailMinimapNavUntil || 0);
    if (inMinimapNav && distance > 2) {
      binding.tailMinimapNavLeftBottom = true;
    }
    const movingUpByGesture = (Date.now() <= binding.tailGestureUntil && top < binding.tailLastTop - 1)
      || (inMinimapNav && top < binding.tailLastTop);
    const earlyMinimapTailScroll = inMinimapNav && (!binding.tailMinimapNavLeftBottom || top <= binding.tailLastTop + 1);
    if (movingUpByGesture) {
      binding.tailPinned = false;
    } else if (!binding.tailPinned && distance <= 2 && !earlyMinimapTailScroll) {
      if (typeof isScrollRestoreProtectedForSession === "function" && isScrollRestoreProtectedForSession(binding.sessionId)) {
        binding.tailPinned = false;
      } else {
        binding.tailPinned = true;
      }
    }
    binding.tailLastTop = top;
  }

  function refreshHistoryTailObservedContent(binding) {
    const content = binding.scroll.firstElementChild || null;
    if (!binding.tailObserver || content === binding.tailContent) return;
    if (binding.tailContent) binding.tailObserver.unobserve?.(binding.tailContent);
    binding.tailContent = content;
    if (content) binding.tailObserver.observe(content);
  }

  function isCurrentHistoryTailBinding(binding) {
    return binding === historyScrollBinding
      && binding.sessionId === getCurrentSessionId()
      && isPluginEnabled("history-scroll-stability");
  }

  function bindHistoryTailStability(binding) {
    const scroll = binding.scroll;
    if (scroll.hasAttribute("data-pi-native-scroll-owner")) return;
    const isProtected = typeof isScrollRestoreProtectedForSession === "function" && isScrollRestoreProtectedForSession(binding.sessionId);
    const isSparse = (scroll.scrollHeight || 0) <= (scroll.clientHeight || 0) + 40;
    binding.tailPinned = !isProtected && !isSparse && (getHistoryTailDistance(scroll) <= HISTORY_TAIL_ATTACH_PX);
    binding.tailGestureUntil = 0;
    binding.tailMinimapNavUntil = 0;
    binding.tailMinimapNavLeftBottom = false;
    binding.tailLastTop = scroll.scrollTop || 0;
    binding.tailLastHeight = scroll.scrollHeight || 0;
    const Resize = window.ResizeObserver;
    if (typeof Resize !== "function") return;
    binding.tailObserver = new Resize(() => {
      if (!isCurrentHistoryTailBinding(binding)) return;
      const nextHeight = scroll.scrollHeight || 0;
      const grew = nextHeight > binding.tailLastHeight + 1;
      binding.tailLastHeight = nextHeight;
      if (!grew || !binding.tailPinned || binding.tailFrame != null) return;
      const follow = () => {
        binding.tailFrame = null;
        binding.tailFrameKind = null;
        if (!isCurrentHistoryTailBinding(binding) || !binding.tailPinned) return;
        if (typeof isScrollRestoreProtectedForSession === "function" && isScrollRestoreProtectedForSession(binding.sessionId)) {
          binding.tailPinned = false;
          return;
        }
        scroll.scrollTop = Math.max(0, (scroll.scrollHeight || 0) - (scroll.clientHeight || 0));
        binding.tailLastTop = scroll.scrollTop || 0;
        binding.tailLastHeight = scroll.scrollHeight || 0;
      };
      if (typeof window.requestAnimationFrame === "function") {
        binding.tailFrameKind = "raf";
        binding.tailFrame = window.requestAnimationFrame(follow);
      } else {
        binding.tailFrameKind = "timeout";
        binding.tailFrame = window.setTimeout?.(follow, 0);
      }
    });
    binding.tailObserver.observe(scroll);
    refreshHistoryTailObservedContent(binding);
  }

  function armHistoryScrollRestore() {
    if (!isPluginEnabled("history-scroll-stability")) return;
    if (typeof window.__PI_ENH_PREPARE_HISTORY_COMMIT__ === "function") {
      cancelHistoryScrollRestore();
      window.__PI_ENH_PREPARE_HISTORY_COMMIT__();
      return;
    }
    if (typeof window.requestAnimationFrame !== "function") return;
    const scroll = getChatScrollContainer();
    if (!scroll || typeof scroll.getBoundingClientRect !== "function") return;
    const viewport = scroll.getBoundingClientRect();
    const candidates = Array.from(scroll.querySelectorAll("[data-entry-id]"));
    const anchor = candidates.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
    });
    if (!anchor) return;
    const entryId = anchor.getAttribute("data-entry-id");
    const offset = anchor.getBoundingClientRect().top - viewport.top;
    const sessionId = getCurrentSessionId();
    cancelHistoryScrollRestore();
    let frames = 0;
    const restore = () => {
      historyRestoreFrame = null;
      if (!isPluginEnabled("history-scroll-stability") || sessionId !== getCurrentSessionId() || getChatScrollContainer() !== scroll) return;
      // Native effects can compensate after MutationObserver folding. Reconcile a
      // bounded frame window only; any new user gesture cancels it immediately.
      const current = Array.from(scroll.querySelectorAll("[data-entry-id]")).find((node) =>
        node.getAttribute("data-entry-id") === entryId && node.getBoundingClientRect().height > 0);
      if (current) {
        const delta = current.getBoundingClientRect().top - scroll.getBoundingClientRect().top - offset;
        if (Math.abs(delta) > 1) scroll.scrollTop += delta;
      }
      if (++frames < 12) historyRestoreFrame = window.requestAnimationFrame(restore);
    };
    historyRestoreFrame = window.requestAnimationFrame(restore);
  }

  function getHistoryPageKey(state) {
    const ids = Array.isArray(state?.entryIds) ? state.entryIds : [];
    return `${state?.sessionId || ""}:${ids.length}:${ids[0] || ""}:${ids[ids.length - 1] || ""}`;
  }

  function isHistorySentinelVisible(scroll, sentinel) {
    if (!scroll || !sentinel) return false;
    if (typeof scroll.getBoundingClientRect !== "function" || typeof sentinel.getBoundingClientRect !== "function") return scroll.scrollTop <= 16;
    const viewport = scroll.getBoundingClientRect();
    const target = sentinel.getBoundingClientRect();
    return target.height >= 0 && target.bottom > viewport.top && target.top < viewport.bottom;
  }

  // Feedback is owned by this plugin, never by React's translated sentinel text.
  function showHistoryFeedback(binding, phase, text) {
    if (binding !== historyScrollBinding) return;
    if (binding.hideTimer != null) window.clearTimeout?.(binding.hideTimer);
    binding.hideTimer = null;
    binding.phase = phase;
    if (!binding.status) {
      const status = document.createElement("div");
      status.className = "pi-enh-history-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.setAttribute("aria-atomic", "true");
      binding.scroll.parentElement?.appendChild(status);
      binding.status = status;
    }
    const rect = binding.scroll.getBoundingClientRect();
    const status = binding.status;
    status.hidden = phase === "idle";
    binding.scroll.classList.toggle("pi-enh-history-feedback-active", !status.hidden);
    status.setAttribute("data-state", phase);
    status.style.top = `${rect.top + Math.max(8, (binding.pull?.distance || 0) / 2 - 10)}px`;
    status.style.left = `${(rect.left || 0) + (rect.width || binding.scroll.clientWidth || 300) / 2}px`;
    status.style.maxWidth = `${Math.max(120, (rect.width || 300) - 24)}px`;
    if (text != null && status.textContent !== text) status.textContent = text;
    const busy = ["loading", "slow", "waiting"].includes(phase);
    if (busy) binding.sentinel?.setAttribute("aria-busy", "true");
    else binding.sentinel?.removeAttribute("aria-busy");
    if (phase === "success" || phase === "end") {
      binding.hideTimer = window.setTimeout?.(() => {
        binding.hideTimer = null;
        if (binding === historyScrollBinding && !binding.pending && !binding.requests.size) showHistoryFeedback(binding, "idle");
      }, 1600) ?? null;
    }
  }

  // ==========================================
  // Virtual History Scroll Anchor Stabilization (虚拟滚动前插阅读锚点纠偏)
  // ==========================================
  let activeVirtualHistoryAnchor = null;
  let historyExpandGestureSeq = 0;
  let historyExpandConsumedSeq = 0;
  let historyExpandSessionId = null;

  function markHistoryExpandUserGesture() {
    const sid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    if (sid !== historyExpandSessionId) {
      historyExpandSessionId = sid;
      historyExpandConsumedSeq = 0;
    }
    historyExpandGestureSeq++;
  }

  addManagedListener(window, "wheel", (e) => {
    if (e.deltaY < 0 && e.target?.closest?.(".chat-content")) {
      markHistoryExpandUserGesture();
    }
  }, { capture: true, passive: true });
  addManagedListener(window, "touchmove", (e) => {
    if (e.target?.closest?.(".chat-content")) {
      markHistoryExpandUserGesture();
    }
  }, { capture: true, passive: true });
  addManagedListener(window, "pointerdown", (e) => {
    if (e.target?.closest?.(".chat-content")) {
      markHistoryExpandUserGesture();
    }
  }, { capture: true, passive: true });
  addManagedListener(window, "keydown", (e) => {
    if (["ArrowUp", "PageUp", "Home"].includes(e.key)) {
      markHistoryExpandUserGesture();
    }
  }, { capture: true, passive: true });

  function cancelVirtualHistoryAnchor(reason = "cancelled") {
    const task = activeVirtualHistoryAnchor;
    if (!task) return;
    activeVirtualHistoryAnchor = null;
    if (task.rafId !== null) {
      window.cancelAnimationFrame?.(task.rafId);
      task.rafId = null;
    }
    if (task.prePaintObserver) {
      try { task.prePaintObserver.disconnect(); } catch {}
      task.prePaintObserver = null;
    }
    task.cleanupListeners?.();
  }

  function reconcileVirtualHistoryAnchorNow(task) {
    if (!task || task !== activeVirtualHistoryAnchor) return false;
    const scroll = task.scroll;
    if (!scroll || scroll.isConnected === false) return false;
    const currentFirst = scroll.querySelector("[data-entry-id]");
    const currentFirstId = currentFirst?.getAttribute("data-entry-id");
    if (!task.prepended) {
      if (currentFirstId && currentFirstId !== task.initialFirstId) {
        task.prepended = true;
        task.prependedAt = performance.now();
      } else {
        return false;
      }
    }
    if (isPluginEnabled("task-tool-auto-collapse")) {
      try { syncAllTaskToolAutoCollapse(); } catch {}
    }
    if (isPluginEnabled("compaction-auto-collapse") && typeof syncCompactionCards === "function") {
      try { syncCompactionCards(); } catch {}
    }
    let targetNode = null;
    if (task.anchorNode &&
        task.anchorNode.isConnected !== false &&
        task.anchorNode.getAttribute?.("data-entry-id") === task.anchorEntryId &&
        (typeof scroll.contains === "function" ? scroll.contains(task.anchorNode) : true)) {
      targetNode = task.anchorNode;
    }
    if (!targetNode && task.anchorEntryId) {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
        try {
          targetNode = scroll.querySelector(`[data-entry-id="${CSS.escape(task.anchorEntryId)}"]`);
        } catch {}
      }
      if (!targetNode) {
        const candidates = typeof scroll.querySelectorAll === "function"
          ? scroll.querySelectorAll("[data-entry-id]")
          : [];
        for (let i = 0; i < candidates.length; i++) {
          if (candidates[i]?.getAttribute?.("data-entry-id") === task.anchorEntryId) {
            targetNode = candidates[i];
            break;
          }
        }
      }
      if (targetNode) task.anchorNode = targetNode;
    }
    if (!targetNode || typeof targetNode.getBoundingClientRect !== "function") return false;
    const targetRect = targetNode.getBoundingClientRect();
    if (targetRect.height <= 0) return false;
    const viewportRect = scroll.getBoundingClientRect();
    const currentOffset = targetRect.top - viewportRect.top;
    const delta = currentOffset - task.initialOffset;
    if (Math.abs(delta) > 0.5) {
      scroll.scrollTop += delta;
      return true;
    }
    return false;
  }

  function bindVirtualAnchorUserGestures(task) {
    const scroll = task.scroll;
    if (!scroll || typeof scroll.addEventListener !== "function") return;
    const cancelOwned = (reason) => {
      if (activeVirtualHistoryAnchor === task) {
        cancelVirtualHistoryAnchor(reason);
      }
    };
    const onWheel = (e) => {
      // 触发加载的同一次上滚惯性事件（尚未 prepend 或刚 prepend 120ms 内仍在向上滚）不能杀死锚点保护
      if (!task.prepended && (e?.deltaY ?? 0) <= 0 && scroll.scrollTop <= 24) return;
      if (task.prepended && (e?.deltaY ?? 0) <= 0 && (performance.now() - (task.prependedAt || 0)) < 120) return;
      cancelOwned("user-wheel");
    };
    const onTouchStart = () => cancelOwned("user-touchstart");
    const onPointerDown = () => cancelOwned("user-pointerdown");
    const onPointerMove = (e) => {
      if (e.buttons) cancelOwned("user-pointermove-drag");
    };
    const onKeyDown = (e) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
        cancelOwned("user-keydown");
      }
    };

    scroll.addEventListener("wheel", onWheel, { passive: true });
    scroll.addEventListener("touchstart", onTouchStart, { passive: true });
    scroll.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroll.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener?.("keydown", onKeyDown, { passive: true });

    task.cleanupListeners = () => {
      scroll.removeEventListener("wheel", onWheel);
      scroll.removeEventListener("touchstart", onTouchStart);
      scroll.removeEventListener("pointerdown", onPointerDown);
      scroll.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener?.("keydown", onKeyDown);
      task.cleanupListeners = null;
    };
  }

  function triggerVirtualHistoryAnchor(task) {
    if (!task || task !== activeVirtualHistoryAnchor) return;
    if (typeof isDisposed !== "undefined" && isDisposed) {
      cancelVirtualHistoryAnchor("disposed");
      return;
    }
    const currentSid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    const currentScroll = typeof getChatScrollContainer === "function" ? getChatScrollContainer() : null;
    if (!isPluginEnabled("session-virtual-scroll") ||
        !currentSid || currentSid !== task.sessionId ||
        !currentScroll || currentScroll !== task.scroll ||
        currentScroll.isConnected === false) {
      cancelVirtualHistoryAnchor("task-invalidated-before-trigger");
      return;
    }

    const startTime = performance.now();
    let stableStartTime = null;

    const step = () => {
      if (task !== activeVirtualHistoryAnchor) return;
      if (typeof isDisposed !== "undefined" && isDisposed) {
        cancelVirtualHistoryAnchor("disposed");
        return;
      }
      const sid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
      const scr = typeof getChatScrollContainer === "function" ? getChatScrollContainer() : null;
      if (!isPluginEnabled("session-virtual-scroll") ||
          !sid || sid !== task.sessionId ||
          !scr || scr !== task.scroll ||
          scr.isConnected === false) {
        cancelVirtualHistoryAnchor("task-invalidated-during-step");
        return;
      }

      const now = performance.now();
      // 1500ms 有界超时
      if (now - startTime > 1500) {
        cancelVirtualHistoryAnchor("timeout-1500ms");
        return;
      }

      // 必须观察真实 prepend（首 ID 变化）后才纠偏，不能提前 stable 退出
      if (!task.prepended) {
        const currentFirst = task.scroll.querySelector("[data-entry-id]");
        const currentFirstId = currentFirst?.getAttribute("data-entry-id");
        if (currentFirstId && currentFirstId !== task.initialFirstId) {
          task.prepended = true;
          task.prependedAt = now;
        } else {
          task.rafId = window.requestAnimationFrame(step);
          return;
        }
      }

      // 观察到 prepend，按同 entryId 实际 offset 差调整 scrollTop，不按总高
      // 优先缓存捕获的 anchor 节点，失效才用 CSS.escape 安全查找或等价安全方法
      let targetNode = null;
      if (task.anchorNode &&
          task.anchorNode.isConnected !== false &&
          task.anchorNode.getAttribute?.("data-entry-id") === task.anchorEntryId &&
          (typeof task.scroll.contains === "function" ? task.scroll.contains(task.anchorNode) : true)) {
        targetNode = task.anchorNode;
      }
      if (!targetNode && task.anchorEntryId) {
        if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
          try {
            targetNode = task.scroll.querySelector(`[data-entry-id="${CSS.escape(task.anchorEntryId)}"]`);
          } catch {}
        }
        if (!targetNode) {
          const candidates = typeof task.scroll.querySelectorAll === "function"
            ? task.scroll.querySelectorAll("[data-entry-id]")
            : [];
          for (let i = 0; i < candidates.length; i++) {
            if (candidates[i]?.getAttribute?.("data-entry-id") === task.anchorEntryId) {
              targetNode = candidates[i];
              break;
            }
          }
        }
        if (targetNode) {
          task.anchorNode = targetNode;
        }
      }

      if (!targetNode || typeof targetNode.getBoundingClientRect !== "function") {
        cancelVirtualHistoryAnchor("anchor-node-lost");
        return;
      }

      const targetRect = targetNode.getBoundingClientRect();
      if (targetRect.height <= 0) {
        task.rafId = window.requestAnimationFrame(step);
        return;
      }

      const viewportRect = task.scroll.getBoundingClientRect();
      const currentOffset = targetRect.top - viewportRect.top;
      const delta = currentOffset - task.initialOffset;

      if (Math.abs(delta) > 0.5) {
        task.scroll.scrollTop += delta;
        stableStartTime = null; // 产生补偿调整，重置稳定窗口
      } else {
        if (stableStartTime === null) {
          stableStartTime = now;
        } else if (now - stableStartTime >= 200) {
          // 至少 200ms 持续稳定，正常完成
          cancelVirtualHistoryAnchor("stable-settled");
          return;
        }
      }

      task.rafId = window.requestAnimationFrame(step);
    };

    task.rafId = window.requestAnimationFrame(step);
  }

  function isSameOriginHistoryUrl(url) {
    if (!url) return false;
    try {
      return new URL(url, window.location.origin).origin === window.location.origin;
    } catch {
      return false;
    }
  }

  // Native IntersectionObserver/minimap loads do not call the enhancement loader.
  // Observe the actual paginated GET too, including the body read and HTTP errors.
  function beginHistoryPageRequest(url, input, init) {
    // Native ChatWindow captures and commits its own history viewport.
    if (getChatScrollContainer()?.hasAttribute("data-pi-native-scroll-owner")) return null;
    if (!isSameOriginHistoryUrl(url)) return null;
    const method = String(init?.method || input?.method || "GET").toUpperCase();
    if (method !== "GET") return null;
    const reqSid = extractSessionIdFromUrl(url);
    const currentSid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    if (!reqSid || !currentSid || reqSid !== currentSid) return null;
    if (!/\/context\?/.test(url) || !/[?&]before=/.test(url) || /[?&]metricsOnly=/.test(url)) return null;

    const stabilityEnabled = isPluginEnabled("history-scroll-stability");
    const virtualEnabled = isPluginEnabled("session-virtual-scroll");
    if (!stabilityEnabled && !virtualEnabled) return null;

    historyExpandSessionId = currentSid;
    historyExpandConsumedSeq = historyExpandGestureSeq;

    let virtualTask = null;
    if (virtualEnabled) {
      cancelVirtualHistoryAnchor("new-page-request");
      const scroll = typeof getChatScrollContainer === "function" ? getChatScrollContainer() : null;
      if (scroll && typeof scroll.getBoundingClientRect === "function") {
        const viewport = scroll.getBoundingClientRect();
        const entries = Array.from(scroll.querySelectorAll("[data-entry-id]"));
        const anchor = entries.find((node) => {
          const rect = node.getBoundingClientRect();
          return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
        const firstEntry = entries[0];
        const initialFirstId = firstEntry ? firstEntry.getAttribute("data-entry-id") : null;
        if (anchor) {
          const anchorEntryId = anchor.getAttribute("data-entry-id");
          const initialOffset = anchor.getBoundingClientRect().top - viewport.top;
          virtualTask = {
            sessionId: currentSid,
            scroll,
            anchorNode: anchor,
            anchorEntryId,
            initialOffset,
            initialFirstId,
            prepended: false,
            prependedAt: 0,
            rafId: null,
            prePaintObserver: null,
            cleanupListeners: null,
          };
          activeVirtualHistoryAnchor = virtualTask;
          bindVirtualAnchorUserGestures(virtualTask);
          if (typeof MutationObserver === "function") {
            try {
              const obs = new MutationObserver(() => {
                if (activeVirtualHistoryAnchor === virtualTask) {
                  reconcileVirtualHistoryAnchorNow(virtualTask);
                }
              });
              obs.observe(scroll, { childList: true, subtree: true });
              virtualTask.prePaintObserver = obs;
            } catch {}
          }
        }
      }
    }

    if (!stabilityEnabled) {
      return {
        init,
        async finish(response, error) {
          try {
            if (error || !response?.ok) {
              if (virtualTask && virtualTask === activeVirtualHistoryAnchor) {
                cancelVirtualHistoryAnchor("request-failed");
              }
              return;
            }
            if (virtualTask && virtualTask === activeVirtualHistoryAnchor) {
              triggerVirtualHistoryAnchor(virtualTask);
            }
          } catch (e) {
            if (virtualTask && virtualTask === activeVirtualHistoryAnchor) {
              cancelVirtualHistoryAnchor("finish-error");
            }
          }
        },
      };
    }

    // React may start paging before the 800ms enhancement sync has bound the DOM.
    // Bind now without recursively starting a second pagination request.
    if (!historyScrollBinding || historyScrollBinding.sessionId !== getCurrentSessionId()) syncHistoryScrollStability(true);
    const binding = historyScrollBinding;
    if (!binding) {
      if (virtualTask && virtualTask === activeVirtualHistoryAnchor) {
        cancelVirtualHistoryAnchor("binding-failed");
      }
      return null;
    }
    // Earlier-history prepends own the reading anchor. Never let a queued tail
    // follow override that restore, including when a short transcript is both
    // at the top and at the bottom.
    binding.tailPinned = false;
    cancelHistoryTailFrame(binding);
    const token = { slow: null, timeout: null, timedOut: false };
    binding.requests.add(token);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const originalSignal = init?.signal || input?.signal;
    const abort = () => controller?.abort(originalSignal.reason);
    if (originalSignal?.aborted) abort();
    else originalSignal?.addEventListener?.("abort", abort, { once: true });
    showHistoryFeedback(binding, "loading", "正在加载更早消息…");
    token.slow = window.setTimeout?.(() => {
      if (binding.requests.has(token)) showHistoryFeedback(binding, "slow", "响应较慢，仍在加载…");
    }, 5000);
    token.timeout = window.setTimeout?.(() => {
      token.timedOut = true;
      controller?.abort(new Error("History request timed out"));
    }, 20000);
    return {
      init: controller ? { ...init, signal: controller.signal } : init,
      async finish(response, error) {
        try {
          window.clearTimeout?.(token.slow);
          window.clearTimeout?.(token.timeout);
          originalSignal?.removeEventListener?.("abort", abort);
          binding.requests.delete(token);
          if (binding !== historyScrollBinding || binding.sessionId !== getCurrentSessionId()) {
            if (virtualTask && virtualTask === activeVirtualHistoryAnchor) {
              if (!error && response?.ok && !originalSignal?.aborted) triggerVirtualHistoryAnchor(virtualTask);
              else cancelVirtualHistoryAnchor("request-invalid-after-binding-change");
            }
            return;
          }
          if (originalSignal?.aborted) {
            if (!binding.requests.size) showHistoryFeedback(binding, "idle");
            if (virtualTask && virtualTask === activeVirtualHistoryAnchor) cancelVirtualHistoryAnchor("signal-aborted");
            return;
          }
          if (error || !response?.ok) {
            binding.blockAuto = true;
            const reason = token.timedOut ? "加载超时" : response ? `加载失败（HTTP ${response.status}）` : "连接失败";
            showHistoryFeedback(binding, "error", `${reason}，请下拉重试`);
            if (virtualTask && virtualTask === activeVirtualHistoryAnchor) cancelVirtualHistoryAnchor("request-failed");
            return;
          }
          if (!binding.requests.size) {
            // 立即启动锚点帧守护，不等待 response.clone().json() 造成帧滞后
            if (virtualTask && virtualTask === activeVirtualHistoryAnchor) {
              triggerVirtualHistoryAnchor(virtualTask);
            }
            // Let React commit and its native anchor restore before another auto page.
            binding.retryAfter = Date.now() + 450;
            let context;
            try { context = (await response.clone().json())?.context; } catch { /* Show failure; native parser still owns the response. */ }
            if (binding !== historyScrollBinding) {
              if (virtualTask && virtualTask === activeVirtualHistoryAnchor) {
                if (!originalSignal?.aborted && Array.isArray(context?.messages) && Array.isArray(context?.entryIds)) triggerVirtualHistoryAnchor(virtualTask);
                else cancelVirtualHistoryAnchor("invalid-context-after-binding-change");
              }
              return;
            }
            if (!Array.isArray(context?.messages) || !Array.isArray(context?.entryIds)) {
              binding.blockAuto = true;
              showHistoryFeedback(binding, "error", "加载数据异常，请下拉重试");
              if (virtualTask && virtualTask === activeVirtualHistoryAnchor) cancelVirtualHistoryAnchor("invalid-context");
              return;
            }
            if (context?.hasMore === false) showHistoryFeedback(binding, "end", "已到最早消息");
            else showHistoryFeedback(binding, "success", "已加载更早消息");
          }
        } catch (e) {
          if (virtualTask && virtualTask === activeVirtualHistoryAnchor) {
            cancelVirtualHistoryAnchor("finish-exception");
          }
          throw e;
        }
      },
    };
  }

  function cleanupHistoryScrollStability() {
    cancelHistoryScrollRestore();
    historyAcceptedPage = null;
    const binding = historyScrollBinding;
    historyScrollBinding = null;
    if (!binding) return;
    for (const [type, fn] of binding.listeners) binding.scroll.removeEventListener(type, fn);
    binding.observer?.disconnect?.();
    binding.tailObserver?.disconnect?.();
    cancelHistoryTailFrame(binding);
    for (const id of [binding.retryTimer, binding.hideTimer]) if (id != null) window.clearTimeout?.(id);
    for (const token of binding.requests) {
      window.clearTimeout?.(token.slow);
      window.clearTimeout?.(token.timeout);
    }
    binding.status?.remove();
    binding.scroll.style.removeProperty("--pi-history-pull");
    binding.scroll.classList?.remove("pi-enh-history-scroll-container", "pi-enh-history-pulling", "pi-enh-history-feedback-active");
    binding.sentinel?.removeAttribute?.("data-pi-enh-history-sentinel");
    binding.sentinel?.removeAttribute?.("aria-busy");
    for (const button of binding.scroll.querySelectorAll?.(".pi-enh-history-load-earlier") || []) button.remove();
  }

  const HISTORY_SENTINEL_STYLE_ID = "pi-enh-history-sentinel-styles";
  const HISTORY_SENTINEL_STYLE_CONTENT = `
    .chat-content button[data-pi-enh-history-sentinel="true"] {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
      margin: 10px auto 16px auto !important;
      padding: 8px 20px !important;
      min-height: 38px !important;
      border-radius: 999px !important;
      border: 1px solid color-mix(in srgb, var(--accent, #60a5fa) 45%, transparent) !important;
      background: color-mix(in srgb, var(--accent, #60a5fa) 12%, var(--bg-panel, #242424)) !important;
      color: var(--text, #e8e8e8) !important;
      font-size: 13px !important;
      font-weight: 500 !important;
      line-height: 1.5 !important;
      cursor: pointer !important;
      transition: all 0.15s ease !important;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12) !important;
      touch-action: manipulation !important;
    }
    .chat-content button[data-pi-enh-history-sentinel="true"]:hover {
      background: color-mix(in srgb, var(--accent, #60a5fa) 24%, var(--bg-hover, #2e2e2e)) !important;
      border-color: var(--accent, #60a5fa) !important;
    }
    .chat-content button[data-pi-enh-history-sentinel="true"]:active {
      transform: scale(0.96) !important;
    }
  `;

  function ensureHistorySentinelStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById(HISTORY_SENTINEL_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = HISTORY_SENTINEL_STYLE_ID;
    style.textContent = HISTORY_SENTINEL_STYLE_CONTENT;
    (document.head || document.documentElement).appendChild(style);
  }

  function syncHistoryScrollStability(suppressAuto = false) {
    const scroll = getChatScrollContainer();
    if (!isPluginEnabled("history-scroll-stability") || !scroll || scroll.hasAttribute("data-pi-native-scroll-owner")) { cleanupHistoryScrollStability(); return; }
    ensureHistorySentinelStyles();
    const sessionId = getCurrentSessionId();
    if (historyScrollBinding && (historyScrollBinding.scroll !== scroll || historyScrollBinding.sessionId !== sessionId)) cleanupHistoryScrollStability();
    if (!historyScrollBinding) {
      const binding = {
        scroll, sessionId, listeners: [], pending: false, requests: new Set(),
        sentinel: null, observer: null, status: null, phase: "idle", pull: null,
        retryTimer: null, hideTimer: null, blockAuto: false,
        autoPageKey: null, autoAttemptKey: null, autoAttempts: 0, retryAfter: 0, lastGestureAt: 0,
        tailObserver: null, tailContent: null, tailFrame: null, tailFrameKind: null,
        tailPinned: false, tailGestureUntil: 0, tailMinimapNavUntil: 0, tailMinimapNavLeftBottom: false, tailLastTop: 0, tailLastHeight: 0,
      };
      historyScrollBinding = binding;
      scroll.classList?.add("pi-enh-history-scroll-container");
      const listen = (type, fn, passive = true) => { scroll.addEventListener(type, fn, { passive }); binding.listeners.push([type, fn]); };
      bindHistoryTailStability(binding);
      binding.load = (source = "gesture", suppliedPageKey = null) => {
        if (binding !== historyScrollBinding || binding.pending || binding.requests.size || !isPluginEnabled("history-scroll-stability")) return Promise.resolve(false);
        const state = window.__PI_ENH_GET_HISTORY_STATE__?.();
        if (state?.sessionId && state.sessionId !== sessionId) return Promise.resolve(false);
        const hasMore = Boolean(state?.hasEarlierMessages || state?.hasLocalEarlier);
        if (!hasMore) {
          if (source !== "auto") showHistoryFeedback(binding, "end", "已到最早消息");
          return Promise.resolve(false);
        }
        const sentinel = binding.sentinel || scroll.querySelector(".py-3.text-center");
        if (typeof window.__PI_ENH_LOAD_EARLIER__ !== "function" && (!sentinel || typeof sentinel.click !== "function")) {
          if (source !== "auto") showHistoryFeedback(binding, "error", "历史加载尚未就绪，请稍后下拉重试");
          return Promise.resolve(false);
        }
        const pageKey = suppliedPageKey || getHistoryPageKey(state);
        if (source === "auto") {
          if (binding.pull || binding.blockAuto || Date.now() < binding.retryAfter || binding.autoPageKey === pageKey) return Promise.resolve(false);
          if (binding.autoAttemptKey !== pageKey) { binding.autoAttemptKey = pageKey; binding.autoAttempts = 0; }
          if (binding.autoAttempts >= 3) return Promise.resolve(false);
          binding.autoAttempts++;
        } else {
          if (source !== "pull" && Date.now() - binding.lastGestureAt < 600) return Promise.resolve(false);
          binding.lastGestureAt = Date.now();
          binding.autoAttemptKey = pageKey;
          binding.autoAttempts = 0;
          binding.blockAuto = false;
        }
        binding.autoPageKey = pageKey;
        binding.tailPinned = false;
        cancelHistoryTailFrame(binding);
        binding.pending = true;
        showHistoryFeedback(binding, "loading", "正在加载更早消息…");
        return Promise.resolve().then(() => {
          if (binding !== historyScrollBinding || sessionId !== getCurrentSessionId()) return false;
          const historyStep = typeof isMobileEnvironment === "function" && isMobileEnvironment() ? 50 : 80;
          if (typeof window.__PI_ENH_LOAD_EARLIER__ === "function") {
            return window.__PI_ENH_LOAD_EARLIER__(historyStep, `chat-${source}`);
          }
          if (sentinel && typeof sentinel.click === "function") {
            sentinel.click();
            return true;
          }
          return false;
        }).then((loaded) => {
          if (binding !== historyScrollBinding || binding.blockAuto) return loaded;
          if (loaded === false && sentinel && typeof sentinel.click === "function" && (state?.hasLocalEarlier || sentinel.offsetParent !== null)) {
            try { sentinel.click(); loaded = true; } catch {}
          }
          if (loaded === false && getHistoryPageKey(window.__PI_ENH_GET_HISTORY_STATE__?.()) === pageKey) {
            binding.autoPageKey = null;
            binding.retryAfter = Date.now() + 400;
            if (binding.autoAttempts >= 3) {
              binding.blockAuto = true;
              showHistoryFeedback(binding, "error", "暂未能加载，请再次下拉重试");
            } else {
              showHistoryFeedback(binding, "waiting", "等待历史记录同步…");
              binding.retryTimer = window.setTimeout?.(() => {
                binding.retryTimer = null;
                if (binding === historyScrollBinding) syncHistoryScrollStability();
              }, 450) ?? null;
            }
          } else if (["loading", "waiting"].includes(binding.phase)) {
            showHistoryFeedback(binding, "success", "已加载更早消息");
          }
          return loaded;
        }).catch(() => {
          if (binding === historyScrollBinding && binding.phase !== "error") {
            binding.blockAuto = true;
            showHistoryFeedback(binding, "error", "加载失败，请下拉重试");
          }
          return false;
        }).finally(() => {
          binding.pending = false;
          if (binding === historyScrollBinding) syncHistoryScrollStability();
        });
      };
      binding.maybeAutoLoad = () => {
        const currentSid = getCurrentSessionId();
        if (currentSid !== historyExpandSessionId || historyExpandGestureSeq <= historyExpandConsumedSeq) {
          return false;
        }
        const sentinel = binding.sentinel || scroll.querySelector(".py-3.text-center");
        const state = window.__PI_ENH_GET_HISTORY_STATE__?.();
        const hasMore = Boolean(state?.hasEarlierMessages || state?.hasLocalEarlier);
        if (binding.pull || binding.blockAuto || !sentinel || !hasMore || !isHistorySentinelVisible(scroll, sentinel)) return false;
        historyExpandConsumedSeq = historyExpandGestureSeq;
        binding.load("auto", getHistoryPageKey(state));
        return true;
      };
      const loadFromVisibleGesture = () => {
        cancelHistoryScrollRestore();
        const sentinel = binding.sentinel || scroll.querySelector(".py-3.text-center");
        if (sentinel && isHistorySentinelVisible(scroll, sentinel)) binding.load("gesture");
      };
      const resetPull = () => {
        binding.pull = null;
        scroll.style.removeProperty("--pi-history-pull");
        scroll.classList.remove("pi-enh-history-pulling");
      };
      const findScrollableSubContainer = (target, root) => {
        let el = target && typeof target === "object" ? (target.parentElement !== undefined ? target : target.parentElement) : null;
        while (el && el !== root && el !== document.body && el !== document.documentElement) {
          if (el.scrollHeight > el.clientHeight + 1) {
            const style = window.getComputedStyle?.(el);
            const oy = style?.overflowY;
            if (oy === "auto" || oy === "scroll" || oy === "overlay") return el;
          }
          el = el.parentElement;
        }
        return null;
      };
      listen("touchstart", (event) => {
        markHistoryTailGesture(binding);
        cancelHistoryScrollRestore();
        if (event.touches?.length !== 1 || scroll.scrollTop > 0 ||
            event.target?.closest?.("input, textarea, button, a, select, pre, [contenteditable=true], [data-minimap-preview-box]")) return;
        const subScroll = findScrollableSubContainer(event.target, scroll);
        if (subScroll && subScroll.scrollTop > 1) return;
        const touch = event.touches[0];
        binding.pull = { x: touch.clientX, y: touch.clientY, distance: 0, subScroll };
      });
      listen("touchmove", (event) => {
        const pull = binding.pull;
        if (!pull) return;
        if (event.touches?.length !== 1) { resetPull(); showHistoryFeedback(binding, binding.pending || binding.requests.size ? "loading" : "idle", "正在加载更早消息…"); return; }
        const touch = event.touches[0], dy = touch.clientY - pull.y, dx = touch.clientX - pull.x;
        if (pull.subScroll) {
          if (dy > 0 && pull.subScroll.scrollTop > 1) {
            resetPull();
            return;
          }
          if (dy < 0 && pull.subScroll.scrollTop < pull.subScroll.scrollHeight - pull.subScroll.clientHeight - 1) {
            resetPull();
            return;
          }
        }
        if (scroll.scrollTop > 0 || Math.abs(dx) > Math.abs(dy) || dy < 0) {
          resetPull();
          if (["pull", "armed"].includes(binding.phase)) showHistoryFeedback(binding, "idle");
          return;
        }
        if (dy < 6) return;
        if (event.cancelable) event.preventDefault();
        pull.distance = Math.min(88, dy * 0.5);
        scroll.style.setProperty("--pi-history-pull", `${pull.distance}px`);
        scroll.classList.add("pi-enh-history-pulling");
        if (binding.pending || binding.requests.size) {
          showHistoryFeedback(binding, binding.phase === "slow" ? "slow" : "loading", binding.phase === "slow" ? "响应较慢，仍在加载…" : "正在加载更早消息…");
        } else showHistoryFeedback(binding, pull.distance >= 36 ? "armed" : "pull", pull.distance >= 36 ? "松开加载更早消息" : "下拉加载更早消息");
      }, false);
      listen("touchend", () => {
        const pull = binding.pull;
        resetPull();
        if (!pull) return;
        if (binding.pending || binding.requests.size) return;
        if (pull.distance >= 36) binding.load("pull");
        else if (["pull", "armed"].includes(binding.phase)) showHistoryFeedback(binding, "idle");
      });
      listen("touchcancel", () => {
        resetPull();
        if (["pull", "armed"].includes(binding.phase)) showHistoryFeedback(binding, "idle");
      });
      listen("wheel", (event) => { markHistoryTailGesture(binding); cancelHistoryScrollRestore(); if (event.deltaY < 0) loadFromVisibleGesture(); });
      listen("pointerdown", () => { markHistoryTailGesture(binding); cancelHistoryScrollRestore(); });
      listen("pointermove", (event) => { if (event.buttons) { markHistoryTailGesture(binding); cancelHistoryScrollRestore(); } });
      listen("pointerup", (event) => { if (event.pointerType !== "touch") loadFromVisibleGesture(); });
      listen("keydown", (event) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) { markHistoryTailGesture(binding); cancelHistoryScrollRestore(); }
        if (["ArrowUp", "PageUp", "Home"].includes(event.key)) loadFromVisibleGesture();
      });
      listen("scroll", () => { updateHistoryTailAttachment(binding); cancelHistoryScrollRestore(); binding.maybeAutoLoad(); });
    }
    const binding = historyScrollBinding;
    refreshHistoryTailObservedContent(binding);
    const sentinel = scroll.querySelector(".py-3.text-center");
    const state = window.__PI_ENH_GET_HISTORY_STATE__?.();
    for (const button of scroll.querySelectorAll?.(".pi-enh-history-load-earlier") || []) button.remove();
    const hasMore = Boolean(state?.hasEarlierMessages || state?.hasLocalEarlier);
    if (!sentinel || !hasMore) {
      binding.observer?.disconnect?.();
      binding.observer = null;
      binding.sentinel?.removeAttribute?.("data-pi-enh-history-sentinel");
      binding.sentinel?.removeAttribute?.("aria-busy");
      binding.sentinel = null;
      return;
    }
    if (binding.sentinel !== sentinel) {
      binding.observer?.disconnect?.();
      binding.sentinel?.removeAttribute?.("data-pi-enh-history-sentinel");
      binding.sentinel = sentinel;
      sentinel.setAttribute("data-pi-enh-history-sentinel", "true");
      sentinel.style.cursor = "pointer";
      sentinel.setAttribute("title", "轻点或下拉加载更早消息");
      if (!sentinel.querySelector(".pi-enh-sentinel-badge")) {
        sentinel.innerHTML = `<span class="pi-enh-sentinel-badge"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 5px; flex-shrink: 0; display: inline-block; vertical-align: -1.5px;"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>加载更早历史消息 (轻点或下拉加载)</span>`;
      }
      if (!sentinel.__piClickHandlerAttached) {
        sentinel.__piClickHandlerAttached = true;
        sentinel.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          markHistoryExpandUserGesture();
          binding.load("gesture");
        });
      }
      if (typeof window.IntersectionObserver === "function") {
        binding.observer = new window.IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) binding.maybeAutoLoad();
        }, { root: scroll, threshold: 0 });
        binding.observer.observe(sentinel);
      }
    }
    if (!suppressAuto) binding.maybeAutoLoad();
  }

  activeCleanups.push(cleanupHistoryScrollStability);

  // ==========================================
  // 3.7. Compaction Summary Auto-Collapse Plugin (会话压缩摘要自动折叠)
  // ==========================================
  function syncCompactionActiveState() {
    const enabled = isPluginEnabled("compaction-auto-collapse");
    if (document.documentElement) {
      document.documentElement.classList.toggle("pi-enh-compaction-collapse-active", enabled);
    }
  }

  function syncCompactionCards() {
    syncCompactionActiveState();
    const enabled = isPluginEnabled("compaction-auto-collapse");
    if (!enabled) {
      removeCompactionEnhancements();
      return;
    }

    const allSpans = document.querySelectorAll("span");
    for (const s of allSpans) {
      if ((s.textContent || "").trim() !== "compaction") continue;
      const header = s.parentElement;
      if (!header) continue;
      const body = header.nextElementSibling || header.nextSibling;
      if (!body) continue;

      header.classList.add("pi-enh-compaction-header");
      body.classList.add("pi-enh-compaction-body");

      let toggleBtn = header.querySelector(".pi-enh-compaction-toggle-btn");
      if (!toggleBtn) {
        toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "pi-enh-compaction-toggle-btn";
        toggleBtn.setAttribute("aria-expanded", "false");
        toggleBtn.setAttribute("title", "展开/收起压缩摘要");
        toggleBtn.setAttribute("aria-label", "展开/收起压缩摘要");
        toggleBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" class="pi-enh-compaction-arrow"><polyline points="2 3.5 5 6.5 8 3.5"></polyline></svg>`;

        // 如果前面的元素没有 auto margin，给 toggleBtn 设置 marginLeft = "auto"
        const hasAutoMargin = Array.from(header.children).some(
          (c) => c !== toggleBtn && (c.style?.marginLeft === "auto" || c.style?.marginInlineStart === "auto")
        );
        if (!hasAutoMargin) {
          toggleBtn.style.marginLeft = "auto";
        }
        header.appendChild(toggleBtn);

        const handleToggle = (e) => {
          e.stopPropagation();
          const isExpanded = toggleBtn.getAttribute("aria-expanded") === "true";
          const next = !isExpanded;
          toggleBtn.setAttribute("aria-expanded", next ? "true" : "false");
          const arrow = toggleBtn.querySelector(".pi-enh-compaction-arrow");
          if (arrow) arrow.style.transform = next ? "rotate(180deg)" : "none";
          if (next) {
            header.setAttribute("data-user-expanded", "true");
            body.setAttribute("data-user-expanded", "true");
            body.style.display = "";
          } else {
            header.removeAttribute("data-user-expanded");
            body.removeAttribute("data-user-expanded");
            body.style.display = "none";
          }
        };

        toggleBtn.addEventListener("click", handleToggle);

        if (header._piEnhCompactionHeaderClick) {
          try {
            header.removeEventListener("click", header._piEnhCompactionHeaderClick);
          } catch (e) {}
          header._piEnhCompactionHeaderClick = null;
        }

        const handleHeaderClick = (e) => {
          if (e.target === toggleBtn || toggleBtn.contains(e.target)) return;
          handleToggle(e);
        };
        header._piEnhCompactionHeaderClick = handleHeaderClick;
        header.addEventListener("click", handleHeaderClick);
      }

      const isExpanded = toggleBtn.getAttribute("aria-expanded") === "true";
      if (!isExpanded) {
        header.removeAttribute("data-user-expanded");
        body.style.display = "none";
      } else {
        header.setAttribute("data-user-expanded", "true");
        body.style.display = "";
      }
    }
  }

  function removeCompactionEnhancements() {
    for (const btn of document.querySelectorAll(".pi-enh-compaction-toggle-btn")) {
      btn.remove();
    }
    for (const el of document.querySelectorAll(".pi-enh-compaction-header")) {
      if (el._piEnhCompactionHeaderClick) {
        try {
          el.removeEventListener("click", el._piEnhCompactionHeaderClick);
        } catch (e) {}
        el._piEnhCompactionHeaderClick = null;
      }
      el.classList.remove("pi-enh-compaction-header");
      el.removeAttribute("data-user-expanded");
    }
    for (const el of document.querySelectorAll(".pi-enh-compaction-body")) {
      el.classList.remove("pi-enh-compaction-body");
      el.removeAttribute("data-user-expanded");
      el.style.display = "";
    }
  }

  // Pi Mail presentation and disclosure are owned by CustomMessageView.

  function getCurrentSessionId() {
    return new URLSearchParams(window.location.search).get("session");
  }

  let observedSessionId = getCurrentSessionId();

  function hasCompleteTurnStart(messages) {
    if (!messages || messages.length === 0) return false;
    const firstUserIndex = messages.findIndex((m) => m.role === "user");
    if (firstUserIndex === -1) return false;
    // 如果最前面的 user 消息紧接着前一条是工具调用或工具结果，说明是中途 Steering 消息，需要继续向上拉取真实起点
    if (firstUserIndex > 0) {
      const priorMsg = messages[firstUserIndex - 1];
      if (priorMsg.role === "toolResult") return false;
      if (priorMsg.role === "assistant" && priorMsg.stopReason === "toolUse") return false;
    }
    return true;
  }

  let metricsScheduleToken = 0;
  let metricsScheduleTimer = null;
  let metricsAbortController = null;
  function scheduleCurrentSessionMetrics(delay = 0) {
    const token = ++metricsScheduleToken;
    try { metricsAbortController?.abort(); } catch (e) {}
    metricsAbortController = null;
    if (metricsScheduleTimer !== null) {
      try { clearManagedTimeout(metricsScheduleTimer); } catch (e) {}
      metricsScheduleTimer = null;
    }
    // 优化：手机端切换会话平滑缓冲 500ms，消除旧的 8000ms（8秒）超长挂起与状态断档
    const effectiveDelay = isMobileEnvironment() ? Math.max(500, delay) : delay;
    const timer = addManagedTimeout(() => {
      if (metricsScheduleTimer === timer) metricsScheduleTimer = null;
      if (token !== metricsScheduleToken || isDisposed) return;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      metricsAbortController = controller;
      Promise.resolve(fetchCurrentSessionMetrics(controller?.signal))
        .finally(() => {
          if (metricsAbortController === controller) metricsAbortController = null;
        });
    }, effectiveDelay);
    metricsScheduleTimer = timer;
  }

  let lastNativeMetricsInput = null;
  async function fetchSessionDataWithTurnStart(sessionId, signal) {
    if (signal?.aborted || isDisposed) return null;
    const options = "deferThinking=1&deferMedia=1&metricsOnly=1";
    const encodedId = encodeURIComponent(sessionId);
    const memEntry = typeof sessionMemoryCache !== "undefined" ? sessionMemoryCache.get(sessionId) : null;
    const memHit = (memEntry && !memEntry.isRunning && !memEntry.needsFreshSync && !memEntry.hasPendingAgentEnd)
      ? findCompatibleSessionDetail(memEntry, `/api/sessions/${encodedId}?deferThinking=1&deferMedia=1&tail=1000`)
      : null;
    const nativeReader = window.__PI_WEB_GET_RESIDENT_SESSION_DATA__;
    let data = typeof nativeReader === "function" ? nativeReader(sessionId) : null;
    // A registered native owner will notify when its first read settles.
    // Starting another read here would race and duplicate that request.
    if ((typeof nativeReader === "function" || sessionId.startsWith("codex:")) && !data) return null;
    const nativeInput = data ? { sessionId, messages: data.context?.messages,
      entryIds: data.context?.entryIds, tree: data.tree } : null;
    if (nativeInput && lastNativeMetricsInput?.sessionId === sessionId
        && lastNativeMetricsInput.messages === nativeInput.messages
        && lastNativeMetricsInput.entryIds === nativeInput.entryIds
        && lastNativeMetricsInput.tree === nativeInput.tree) return null;
    if (data) {
      // The existing native context, including user-paged history, is authoritative.
    } else if (memHit?.data?.context?.messages?.length) {
      data = memHit.data;
    } else if (inFlightSessionDetailRequests.has(sessionId)) {
      data = await inFlightSessionDetailRequests.get(sessionId);
      if (!data) {
        const response = await fetch(`/api/sessions/${encodedId}?${options}&tail=1000`, signal ? { signal } : undefined);
        if (signal?.aborted || isDisposed || !response || !response.ok) return null;
        data = await response.json();
      }
    } else {
      // 首次请求即携带 tail=1000，一次性满足绝大部分复杂长会话（如数百步工具链）全量解析需求
      const response = await fetch(`/api/sessions/${encodedId}?${options}&tail=1000`, signal ? { signal } : undefined);
      if (signal?.aborted || isDisposed) return null;
      if (!response || !response.ok) return null;
      data = await response.json();
    }
    if (signal?.aborted || isDisposed) return null;
    let context = data?.context;
    let pagesLoaded = 0;

    // 当会话超过 1000 条且尚未获取到当前回合完整起点时，向前安全分页追溯（最多 10 页，每页 1000 条）
    while (
      !sessionId.startsWith("codex:") &&
      context?.hasMore &&
      (!hasCompleteTurnStart(context.messages)
        // A user at the page edge may be steering within an older turn.
        || context.messages?.[0]?.role === "user") &&
      context.oldestEntryId &&
      pagesLoaded < 10
    ) {
      if (signal?.aborted || isDisposed) return null;
      const olderResponse = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/context?${options}&before=${encodeURIComponent(context.oldestEntryId)}&tail=1000`,
        signal ? { signal } : undefined,
      );
      if (signal?.aborted || isDisposed) return null;
      if (!olderResponse || !olderResponse.ok) break;
      const olderData = await olderResponse.json();
      if (signal?.aborted || isDisposed) return null;
      const olderContext = olderData?.context;
      if (!olderContext?.messages?.length) break;

      context = {
        ...context,
        messages: [...olderContext.messages, ...context.messages],
        entryIds: [...(olderContext.entryIds || []), ...(context.entryIds || [])],
        oldestEntryId: olderContext.oldestEntryId,
        hasMore: olderContext.hasMore,
      };
      data = { ...data, context };
      pagesLoaded += 1;
    }
    if (signal?.aborted || isDisposed) return null;
    if (nativeInput && getCurrentSessionId() === sessionId) lastNativeMetricsInput = nativeInput;
    return data;
  }

  function fetchCurrentSessionMetrics(signal) {
    if (isDisposed || isLoginPage()) return;
    try {
      const sessionId = getCurrentSessionId();
      observedSessionId = sessionId || null;
      if (sessionId) {
        return fetchSessionDataWithTurnStart(sessionId, signal)
          .then((data) => {
            if (signal?.aborted || isDisposed) return;
            if (data && getCurrentSessionId() === sessionId) {
              parseSessionData(data, sessionId);
            }
          })
          .catch(() => {});
      }
    } catch (e) {}
  }

  function syncAllDurationBadges() { 
    if (!isPluginEnabled("turn-duration")) {
      for (const staleBadge of document.querySelectorAll(".pi-enh-duration-badge")) {
        staleBadge.remove();
      }
      return;
    }
    const isRunning = (typeof isLiveRunning === "function" ? isLiveRunning() : Boolean(findActiveStopButton())) || Boolean(document.querySelector(".animate-spin"));
    const assistantMsgs = document.querySelectorAll('div[data-message-role="assistant"]');
    const userMsgs = findUserMessages();
    const lastUserMsg = userMsgs.length > 0 ? userMsgs[userMsgs.length - 1] : null;

    for (let i = 0; i < assistantMsgs.length; i++) {
      const msg = assistantMsgs[i];
      const entryId = getMessageEntryId(msg);
      const metrics = entryId ? knownTurnMetrics.get(entryId) : null;

      // 关键防御：如果当前处于运行中（isRunning），且该助手消息属于当前活跃回合（位于最新 user 消息之后），
      // 绝不能提前打上静态完成徽章或 completed 属性，展示空间留给跳动的实时秒表
      if (isRunning && lastUserMsg && typeof lastUserMsg.compareDocumentPosition === "function") {
        const isPreceding = Boolean(lastUserMsg.compareDocumentPosition(msg) & 2);
        if (!isPreceding && msg !== lastUserMsg) {
          continue;
        }
      }

      // Tool-use entries and stale DOM estimates are not completed turns.
      // Remove them rather than leaving an incorrect "total" duration visible.
      if (!metrics) {
        let isKnownTool = false;
        for (const m of knownTurnMetrics.values()) {
          if (m.toolEntryIds && m.toolEntryIds.includes(entryId)) {
            isKnownTool = true;
            break;
          }
        }
        const existingBadge = msg.querySelector(".pi-enh-duration-badge");
        const hasValidExistingBadge = existingBadge && Number(existingBadge.getAttribute("data-total-sec")) > 0;
        // 关键保护：只要已拥有大于 0 秒的有效耗时徽章，且并非中间临时工具卡片，坚决保留绝不误删
        if (hasValidExistingBadge && !isKnownTool) {
          const footer = msg.querySelector('div[style*="margin-top: 4px"], div[style*="marginTop: 4px"]') ||
                         msg.querySelector('div[style*="gap: 8px"]') ||
                         msg.lastElementChild;
          if (footer && typeof findTimestampElement === "function") {
            const timeSpan = findTimestampElement(footer);
            if (timeSpan && existingBadge.nextElementSibling !== timeSpan) {
              footer.insertBefore(existingBadge, timeSpan);
            }
          }
          continue;
        }

        for (const staleBadge of msg.querySelectorAll(".pi-enh-duration-badge")) {
          staleBadge.remove();
        }
        msg.removeAttribute("data-pi-enh-completed");
        continue;
      }

      insertDurationBadge(
        msg,
        metrics.totalSec,
        metrics.queueSec,
        metrics.toolCounts,
        metrics.uTime,
        metrics.aTime,
        metrics.activeSec,
        metrics.pausedSec,
        metrics.steerCount,
        metrics.interruptCount
      );
    }
  }

  function findUsageElement(footer) {
    if (!footer) return null;
    const children = footer.children || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.classList && child.classList.contains("pi-enh-duration-badge")) continue;
      if (child.classList && child.classList.contains("pi-enh-live-timer")) continue;
      if (child.tagName && child.tagName.toLowerCase() === "button") continue;
      const text = child.textContent || "";
      if (text.includes(" in") || text.includes(" out") || text.includes("$") || text.includes("cache")) {
        return child;
      }
    }
    return null;
  }

  function findCopyButton(container) {
    if (!container) return null;
    try {
      const q = container.querySelector('button[title*="Copy" i], button[title*="复制" i]');
      if (q) return q;
    } catch (e) {}
    const buttons = container.querySelectorAll("button");
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      const title = (b.getAttribute("title") || "").toLowerCase();
      const text = (b.textContent || "").toLowerCase();
      if (title.includes("copy") || title.includes("复制") || text.includes("复制") || text.includes("copy")) {
        return b;
      }
    }
    return null;
  }

  // 各模型基准费率表 (USD / 百万 Tokens: [input, output, cacheRead, cacheWrite])
  // DeepSeek 低峰时段最便宜一档费率: [0.15, 0.60, 0.003]
  const DEEPSEEK_CHEAPEST_OFFPEAK_RATES = [0.15, 0.60, 0.003];

  function stripProviderPrefix(rawModel) {
    if (!rawModel) return "";
    const s = String(rawModel).trim();
    // 仅剥离标准合法的 provider 标识符前缀（如 cliproxyapi/、openai-codex/、anthropic/、models/ 等）
    return s.replace(/^[a-zA-Z0-9_\-\.]+\//, "");
  }

  function formatModelDisplayName(rawModel) {
    if (!rawModel || rawModel === "默认模型" || rawModel === "unknown" || rawModel === "未知") return "未知模型";
    const clean = stripProviderPrefix(rawModel);
    const m = clean.toLowerCase().trim();
    if (m === "gpt-6-astra") return "GPT-6 Astra";
    if (m === "gpt-6.1-sol") return "GPT-6.1 Sol";
    if (m === "gpt-6-sol") return "GPT-6 Sol";
    if (m === "gpt-6-luna") return "GPT-6 Luna";
    if (m === "gpt-5.6-luna") return "GPT-5.6 Luna";
    if (m === "gpt-5.6-sol") return "GPT-5.6 Sol";
    if (m === "gpt-5.6-terra") return "GPT-5.6 Terra";
    if (m === "gpt-5.5") return "GPT-5.5";
    if (m === "gpt-5.4") return "GPT-5.4";
    if (m === "gpt-5.4-mini") return "GPT-5.4 mini";
    if (m === "gpt-5.4-nano") return "GPT-5.4 nano";
    if (m === "gpt-5.4-pro") return "GPT-5.4 Pro";
    if (m === "gpt-5") return "GPT-5";
    if (m === "gpt-5-mini") return "GPT-5 mini";
    if (m === "o3") return "o3";
    if (m === "o3-mini") return "o3-mini";
    if (m === "o3-pro") return "o3-pro";
    if (m === "o4-mini") return "o4-mini";
    if (m === "o1") return "o1";
    if (m === "gemini-3.8-flash-high") return "Gemini 3.8 Flash High";
    if (m === "gemini-2.0-flash") return "Gemini 2.0 Flash";
    if (m === "gemini-1.5-pro") return "Gemini 1.5 Pro";
    if (m === "claude-3-7-sonnet") return "Claude 3.7 Sonnet";
    if (m === "claude-3-5-sonnet") return "Claude 3.5 Sonnet";
    if (m === "deepseek-chat") return "DeepSeek V3";
    if (m === "deepseek-reasoner") return "DeepSeek R1";
    return clean.replace(/^models?\//i, "").replace(/-/g, " ");
  }

  function resolveModelPricing(rawModel) {
    if (!rawModel || rawModel === "默认模型" || rawModel === "unknown") {
      return {
        rates: [0.15, 0.60, 0.003, 0.003],
        category: "基准",
        label: "基准参考价",
        isExplicit: false,
      };
    }
    const clean = stripProviderPrefix(rawModel);
    const m = clean.toLowerCase().trim();

    // 运行时优先读取全局账本标准费率
    const ledgerRates = (typeof window !== "undefined" && window.PiUsageLedger?.STANDARD_RATES)
      || (typeof globalThis !== "undefined" && globalThis.PiUsageLedger?.STANDARD_RATES);

    // 1. Gemini 系列
    if (m.includes("gemini")) {
      if (m.includes("pro")) {
        const rates = (ledgerRates && ledgerRates["gemini-1.5-pro"]) || [1.25, 5.00, 0.3125, 0.3125];
        return {
          rates,
          category: "Gemini Pro",
          label: "Gemini Pro 参考价",
          isExplicit: true,
        };
      }
      // Gemini Flash 系列 (Gemini 3.8 Flash High, Gemini 2.0 Flash 等)
      // 参考标准：输入 $0.10/M, 输出 $0.40/M, 缓存读取/写入 $0.025/M
      const rates = (ledgerRates && ledgerRates["gemini-3.8-flash-high"]) || [0.10, 0.40, 0.025, 0.025];
      return {
        rates,
        category: "Gemini Flash",
        label: "Gemini Flash 参考价",
        isExplicit: true,
      };
    }

    // 2. GPT / OpenAI 系列
    if (m.includes("gpt") || m.includes("openai") || m.includes("astra") || m.includes("luna") || m.includes("sol") || m.includes("terra") || m.includes("o1") || m.includes("o3")) {
      if (m === "gpt-6.1-sol") {
        const rates = (ledgerRates && ledgerRates["gpt-6.1-sol"]) || [2.00, 10.00, 0.10, 2.50];
        return {
          rates,
          category: "GPT-6.1 Sol",
          label: "GPT-6.1 Sol Standard 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("gpt-6-sol")) {
        const rates = (ledgerRates && ledgerRates["gpt-6-sol"]) || [2.00, 10.00, 0.20, 2.50];
        return {
          rates,
          category: "GPT-6 Sol",
          label: "GPT-6 Sol 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("gpt-6-luna")) {
        const rates = (ledgerRates && ledgerRates["gpt-6-luna"]) || [0.10, 0.50, 0.01, 0.125];
        return {
          rates,
          category: "GPT-6 Luna",
          label: "GPT-6 Luna 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("astra") || m.includes("gpt-6")) {
        const rates = (ledgerRates && ledgerRates["gpt-6-astra"]) || [10.00, 50.00, 1.00, 12.50];
        return {
          rates,
          category: "GPT-6 Astra",
          label: "GPT-6 Astra 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("sol")) {
        const rates = (ledgerRates && ledgerRates["gpt-5.6-sol"]) || [4.00, 20.00, 0.40, 5.00];
        return {
          rates,
          category: "GPT-5.6 Sol",
          label: "GPT-5.6 Sol 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("terra")) {
        const rates = (ledgerRates && ledgerRates["gpt-5.6-terra"]) || [2.00, 12.00, 0.20, 2.50];
        return {
          rates,
          category: "GPT-5.6 Terra",
          label: "GPT-5.6 Terra 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("luna")) {
        const rates = (ledgerRates && ledgerRates["gpt-5.6-luna"]) || [0.20, 1.20, 0.02, 0.25];
        return {
          rates,
          category: "GPT-5.6 Luna",
          label: "GPT-5.6 Luna 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("o3-pro")) {
        const rates = (ledgerRates && ledgerRates["o3-pro"]) || [20.00, 80.00, 0.00, 0.00];
        return {
          rates,
          category: "OpenAI o3-pro",
          label: "o3-pro 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("o3-mini")) {
        const rates = (ledgerRates && ledgerRates["o3-mini"]) || [1.10, 4.40, 0.55, 0.00];
        return {
          rates,
          category: "OpenAI o3-mini",
          label: "o3-mini 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("o3")) {
        const rates = (ledgerRates && ledgerRates["o3"]) || [2.00, 8.00, 0.50, 0.00];
        return {
          rates,
          category: "OpenAI o3",
          label: "o3 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("o4-mini")) {
        const rates = (ledgerRates && ledgerRates["o4-mini"]) || [1.10, 4.40, 0.275, 0.00];
        return {
          rates,
          category: "OpenAI o4-mini",
          label: "o4-mini 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("o1-pro")) {
        return {
          rates: [150.00, 600.00, 0.00, 0.00],
          category: "OpenAI o1-pro",
          label: "o1-pro 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("o1")) {
        return {
          rates: [15.00, 60.00, 7.50, 0.00],
          category: "OpenAI o1",
          label: "o1 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("gpt-5.5")) {
        const rates = (ledgerRates && ledgerRates["gpt-5.5"]) || [5.00, 30.00, 0.50, 0.00];
        return {
          rates,
          category: "GPT-5.5",
          label: "GPT-5.5 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("gpt-5.4-pro")) {
        const rates = (ledgerRates && ledgerRates["gpt-5.4-pro"]) || [30.00, 180.00, 0.00, 0.00];
        return {
          rates,
          category: "GPT-5.4 Pro",
          label: "GPT-5.4 Pro 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("gpt-5.4-mini")) {
        const rates = (ledgerRates && ledgerRates["gpt-5.4-mini"]) || [0.75, 4.50, 0.075, 0.00];
        return {
          rates,
          category: "GPT-5.4 mini",
          label: "GPT-5.4-mini 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("gpt-5.4-nano")) {
        const rates = (ledgerRates && ledgerRates["gpt-5.4-nano"]) || [0.20, 1.25, 0.02, 0.00];
        return {
          rates,
          category: "GPT-5.4 nano",
          label: "GPT-5.4-nano 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("gpt-5.4")) {
        const rates = (ledgerRates && ledgerRates["gpt-5.4"]) || [2.50, 15.00, 0.25, 0.00];
        return {
          rates,
          category: "GPT-5.4",
          label: "GPT-5.4 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("gpt-5-mini")) {
        const rates = (ledgerRates && ledgerRates["gpt-5-mini"]) || [0.25, 2.00, 0.025, 0.00];
        return {
          rates,
          category: "GPT-5 Mini",
          label: "GPT-5-mini 参考价",
          isExplicit: true,
        };
      }
      if (m === "gpt-5" || m.includes("gpt-5.1") || m.includes("gpt-5-chat")) {
        const rates = (ledgerRates && ledgerRates["gpt-5"]) || [1.25, 10.00, 0.125, 0.00];
        return {
          rates,
          category: "GPT-5",
          label: "GPT-5 参考价",
          isExplicit: true,
        };
      }
      if (m.includes("mini") || m.includes("nano")) {
        const rates = (ledgerRates && ledgerRates["gpt-4o-mini"]) || [0.15, 0.60, 0.075, 0.075];
        return {
          rates,
          category: "GPT Mini",
          label: "GPT-4o-mini 参考价",
          isExplicit: true,
        };
      }
      // 默认 GPT 旗舰大模型 (GPT-4o, GPT-5 等)
      const rates = (ledgerRates && ledgerRates["gpt-4o"]) || [2.50, 10.00, 1.25, 1.25];
      return {
        rates,
        category: "GPT 旗舰",
        label: "GPT 参考价",
        isExplicit: true,
      };
    }

    // 3. Claude 系列
    if (m.includes("claude")) {
      if (m.includes("haiku")) {
        return {
          rates: [0.80, 4.00, 0.08, 0.08],
          category: "Claude Haiku",
          label: "Claude Haiku 参考价",
          isExplicit: true,
        };
      }
      const rates = (ledgerRates && ledgerRates["claude-3.7-sonnet"]) || [3.00, 15.00, 0.30, 0.30];
      return {
        rates,
        category: "Claude Sonnet",
        label: "Claude 参考价",
        isExplicit: true,
      };
    }

    // 4. DeepSeek 系列
    if (m.includes("deepseek")) {
      if (m.includes("reasoner") || m.includes("r1")) {
        const rates = (ledgerRates && ledgerRates["deepseek-v4-pro"]) || [1.32, 3.96, 0.044, 0.044];
        return {
          rates,
          category: "DeepSeek R1",
          label: "DeepSeek R1 参考价",
          isExplicit: true,
        };
      }
      const rates = (ledgerRates && ledgerRates["deepseek-flash"]) || [0.30, 1.20, 0.006, 0.006];
      return {
        rates,
        category: "DeepSeek V3",
        label: "DeepSeek 参考价",
        isExplicit: true,
      };
    }

    return {
      rates: [2.50, 10.00, 1.25, 1.25],
      category: "GPT 旗舰",
      label: "参考价",
      isExplicit: false,
    };
  }

  function computeSubagentSavings(itemsInput, fallbackTurnModel = "", turnMainCost = 0) {
    let rawItems = itemsInput;
    if (rawItems && typeof rawItems === "object" && !Array.isArray(rawItems)) {
      rawItems = Array.isArray(rawItems.items) ? rawItems.items : [rawItems];
    }
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return null;
    }

    let totalTokens = 0;
    let callCount = 0;
    let actualCost = 0;
    let hypotheticalMainCost = 0;
    let canEstimate = true;
    let estimateReason = "";
    let hasRecordedCost = false;
    let hasEstimatedCost = false;
    let hasFallbackMainModel = false;
    const mainModelsUsed = new Set();
    const subAgentsUsed = new Set();

    for (const item of rawItems) {
      if (!item) continue;
      callCount++;
      const usage = item.usage || {};
      const inTok = Number(usage.input) || 0;
      const outTok = Number(usage.output) || 0;
      const crTok = Number(usage.cacheRead) || 0;
      const cwTok = Number(usage.cacheWrite) || 0;
      const itemTotalTokens = (typeof item.totalTokens === "number" && item.totalTokens > 0)
        ? item.totalTokens
        : (inTok + outTok + crTok + cwTok);
      totalTokens += itemTotalTokens;

      const agentName = item.agent || "subagent";
      const subModel = item.model || "";
      if (agentName) subAgentsUsed.add(agentName);

      // 1. 确定主模型
      const mainModel = item.mainModel || fallbackTurnModel || "";
      if (item.isFallbackMainModel || !item.mainModel) {
        hasFallbackMainModel = true;
      }
      if (mainModel) mainModelsUsed.add(mainModel);

      // 2. 检查主模型定价
      const mainPricing = resolveModelPricing(mainModel);
      if (!mainPricing || !mainPricing.isExplicit) {
        canEstimate = false;
        if (!estimateReason) {
          estimateReason = `主控模型 (${formatModelDisplayName(mainModel) || "默认"}) 价格未配置，暂无法估算`;
        }
      } else if (cwTok > 0 && (!mainPricing.rates || mainPricing.rates.length < 4)) {
        canEstimate = false;
        if (!estimateReason) {
          estimateReason = "主控模型缺少缓存写入 (Cache Write) 计费单价，暂无法完整估算";
        }
      }

      let itemHypCost = 0;
      if (mainPricing && mainPricing.isExplicit) {
        const mr = mainPricing.rates;
        const mrCw = (mr && mr.length >= 4) ? mr[3] : 0;
        itemHypCost = (inTok * mr[0] + outTok * mr[1] + crTok * mr[2] + cwTok * mrCw) / 1000000;
        hypotheticalMainCost += itemHypCost;
      }

      // 3. 计算子 Agent 费用 (优先真实 recorded cost > 0，未记录或 <= 0 时按参考价估算)
      let itemSubCost = 0;
      const recordedCost = (typeof usage.cost === "number" && usage.cost > 0)
        ? usage.cost
        : ((typeof item.cost === "number" && item.cost > 0) ? item.cost : null);

      if (recordedCost !== null) {
        itemSubCost = recordedCost;
        hasRecordedCost = true;
      } else {
        hasEstimatedCost = true;
        const subPricing = resolveModelPricing(subModel || agentName);
        if (!subPricing || !subPricing.isExplicit) {
          canEstimate = false;
          if (!estimateReason) {
            estimateReason = `子 Agent 模型 (${formatModelDisplayName(subModel) || agentName}) 价格未配置，暂无法估算`;
          }
        } else if (cwTok > 0 && (!subPricing.rates || subPricing.rates.length < 4)) {
          canEstimate = false;
          if (!estimateReason) {
            estimateReason = "子 Agent 缺少缓存写入 (Cache Write) 计费单价，暂无法完整估算";
          }
        } else {
          const sr = subPricing.rates;
          const srCw = (sr && sr.length >= 4) ? sr[3] : 0;
          itemSubCost = (inTok * sr[0] + outTok * sr[1] + crTok * sr[2] + cwTok * srCw) / 1000000;
        }
      }
      actualCost += itemSubCost;
    }

    // 主模型显示名称：若多次委派对应不同主模型，显示“各次委派时的主模型”
    let mainModelDisplayName = "";
    const distinctMainModels = Array.from(mainModelsUsed).filter(Boolean);
    if (distinctMainModels.length === 1) {
      mainModelDisplayName = formatModelDisplayName(distinctMainModels[0]);
    } else if (distinctMainModels.length > 1) {
      mainModelDisplayName = "各次委派时的主模型";
    } else {
      mainModelDisplayName = formatModelDisplayName(fallbackTurnModel) || "主模型";
    }

    if (!canEstimate) {
      return {
        canEstimate: false,
        estimateReason: estimateReason || "暂无法完整估算",
        callCount,
        totalTokens,
        actualCost,
        hypotheticalMainCost,
        savedCost: 0,
        savedRatio: "0.0",
        diffType: "unknown",
        mainModelDisplayName,
        hasRecordedCost,
        hasEstimatedCost,
        hasFallbackMainModel,
        isSubCent: false,
      };
    }

    const savedCost = hypotheticalMainCost - actualCost;
    const absDiff = Math.abs(savedCost);
    let diffType = "neutral";
    let savedRatio = "0.0";
    let overallSavedRatio = "0.0";
    const isSubCent = absDiff > 0 && absDiff < 0.01;

    // 用户新规则：按原本全部由高级模型（主会话+子任务全由高级模型自跑）对比，整单少花多少百分比
    const allMainTotalCost = (turnMainCost || 0) + hypotheticalMainCost;
    const actualTotalCost = (turnMainCost || 0) + actualCost;

    if (savedCost > 1e-6) {
      diffType = "saved";
      savedRatio = hypotheticalMainCost > 0 ? ((savedCost / hypotheticalMainCost) * 100).toFixed(1) : "0.0";
      overallSavedRatio = allMainTotalCost > 0 ? ((savedCost / allMainTotalCost) * 100).toFixed(1) : savedRatio;
    } else if (savedCost < -1e-6) {
      diffType = "extra";
      const extra = -savedCost;
      savedRatio = hypotheticalMainCost > 0 ? ((extra / hypotheticalMainCost) * 100).toFixed(1) : "0.0";
      overallSavedRatio = allMainTotalCost > 0 ? ((extra / allMainTotalCost) * 100).toFixed(1) : savedRatio;
    } else {
      diffType = "neutral";
      savedRatio = "0.0";
      overallSavedRatio = "0.0";
    }

    return {
      canEstimate: true,
      estimateReason: "",
      callCount,
      totalTokens,
      actualCost,
      hypotheticalMainCost,
      turnMainCost: Number(turnMainCost || 0),
      allMainTotalCost,
      actualTotalCost,
      savedCost,
      savedRatio,
      overallSavedRatio,
      diffType,
      mainModelDisplayName,
      hasRecordedCost,
      hasEstimatedCost,
      hasFallbackMainModel,
      isSubCent,
    };
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderSubagentSavingsHtml(s) {
    if (!s) return "";

    if (!s.canEstimate) {
      return `
        <div class="pi-enh-subagent-savings-box">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
            <span style="font-size: 15px; font-weight: 600; color: var(--text-dim, #a1a1aa);">暂无法估算省钱</span>
            <span style="font-size: 10px; color: var(--text-dim, #71717a); border: 1px solid rgba(255,255,255,0.12); border-radius: 3px; padding: 1px 4px;">参考估算受限</span>
          </div>
          <div style="font-size: 10.5px; color: var(--text-dim, #71717a); margin-top: 4px; line-height: 1.4;">
            ${escapeHtml(s.estimateReason || "缺少模型参考定价或缓存写入计费标准")}
          </div>
        </div>
      `;
    }

    let headlineAmountHtml = "";
    let metaText = "";
    const countTokensText = `${s.callCount || 0}次委派 · ${(s.totalTokens || 0).toLocaleString()} Tokens`;

    if (s.diffType === "saved") {
      const amountStr = s.isSubCent ? "<$0.01" : `$${s.savedCost.toFixed(2)}`;
      headlineAmountHtml = `<span style="font-size: 20px; font-weight: 700; color: #22d3ee; font-variant-numeric: tabular-nums; line-height: 1.15;">委派省了 ${amountStr}</span><span style="font-size: 11px; font-weight: 600; color: #67e8f9; background: rgba(6,182,212,0.15); border: 1px solid rgba(6,182,212,0.3); border-radius: 4px; padding: 1px 6px; margin-left: 4px; vertical-align: middle;">整单少花 ${s.overallSavedRatio}%</span>`;
      metaText = `子任务自身降本 ${s.savedRatio}% · ${countTokensText}`;
    } else if (s.diffType === "extra") {
      const extraCost = -s.savedCost;
      const amountStr = s.isSubCent ? "<$0.01" : `$${extraCost.toFixed(2)}`;
      headlineAmountHtml = `<span style="font-size: 20px; font-weight: 700; color: #fbbf24; font-variant-numeric: tabular-nums; line-height: 1.15;">委派多花 ${amountStr}</span><span style="font-size: 11px; font-weight: 600; color: #fde68a; background: rgba(245,158,11,0.15); border: 1px solid rgba(245,158,11,0.3); border-radius: 4px; padding: 1px 6px; margin-left: 4px; vertical-align: middle;">整单多花 ${s.overallSavedRatio}%</span>`;
      metaText = `子任务自身多花 ${s.savedRatio}% · ${countTokensText}`;
    } else {
      headlineAmountHtml = `<span style="font-size: 18px; font-weight: 600; color: #e4e4e7; font-variant-numeric: tabular-nums; line-height: 1.15;">未产生价差</span>`;
      metaText = `0.0% · ${countTokensText}`;
    }

    let subCostSourceHint = "子费用";
    if (s.hasRecordedCost && s.hasEstimatedCost) {
      subCostSourceHint = "子费用部分估算";
    } else if (s.hasRecordedCost) {
      subCostSourceHint = "子费用记录值";
    } else if (s.hasEstimatedCost) {
      subCostSourceHint = "子费用估算";
    }
    const actualCostLabel = `实际主+子 M+S(${subCostSourceHint})`;

    const safeMainModel = escapeHtml(s.mainModelDisplayName || "主模型");
    const fallbackHintHtml = s.hasFallbackMainModel
      ? `<div style="font-size: 10px; color: #fbbf24; margin-top: 3px; line-height: 1.35;">* 委派未记录主模型，按回合主模型估价</div>`
      : "";

    return `
      <div class="pi-enh-subagent-savings-box">
        <div style="display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;">
          ${headlineAmountHtml}
          <span style="font-size: 10px; color: var(--text-dim, #a1a1aa); border: 1px solid rgba(255,255,255,0.14); border-radius: 3px; padding: 0 4px; vertical-align: middle;">参考估算</span>
        </div>
        <div style="font-size: 11.5px; color: #e4e4e7; margin-top: 5px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
          <span>原本全部由 ${safeMainModel} 做 $${(s.allMainTotalCost || s.hypotheticalMainCost).toFixed(4)}</span>
          <span style="color: var(--text-dim, #71717a);">→</span>
          <span>${actualCostLabel} $${(s.actualTotalCost || s.actualCost).toFixed(4)}</span>
        </div>
        <div style="font-size: 11px; color: #cbd5e1; margin-top: 4px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap;">
          <span>主模型直接 M: $${(s.turnMainCost || 0).toFixed(4)}</span>
          <span style="color: var(--text-dim, #71717a);">·</span>
          <span>子 Agent 实际 S: $${(s.actualCost || 0).toFixed(4)}</span>
          <span style="color: var(--text-dim, #71717a);">·</span>
          <span>假设全主模型 M+H: $${(s.allMainTotalCost || s.hypotheticalMainCost).toFixed(4)}</span>
        </div>
        <div style="font-size: 11px; color: var(--text-dim, #a1a1aa); margin-top: 4px;">
          ${metaText}
        </div>
        <div style="font-size: 10px; color: var(--text-dim, #71717a); margin-top: 6px; border-top: 1px dashed rgba(255,255,255,0.07); padding-top: 4px; line-height: 1.35;">
          * 回合范围参考估算，按原本全部由高级模型运行重算，非实际账单节省保证
          ${fallbackHintHtml}
        </div>
      </div>
    `;
  }

  function resolveTurnCostInfo(turnUsage, lastStepUsage, preferredModel = null) {
    if (!turnUsage) {
      return {
        totalCost: 0,
        lastCost: 0,
        currency: "$",
        isEstimate: false,
        label: "",
        modelName: "",
        modelDisplayName: "默认模型",
        modelCategory: "",
        rates: [0, 0, 0],
        deepseekTotalCost: 0,
        deepseekLastCost: 0,
        multiplier: "1.0",
        hasSubagent: false,
        combinedInput: 0,
        combinedOutput: 0,
        combinedCacheRead: 0,
        effectiveTotalCost: 0,
      };
    }

    const rawModel = preferredModel || turnUsage.model || lastStepUsage?.model || "";
    const modelDisplayName = formatModelDisplayName(rawModel);
    const pricing = resolveModelPricing(rawModel);
    const rates = pricing.rates;

    let totalCost = 0;
    let lastCost = 0;
    let isEstimate = false;

    if (typeof turnUsage.cost === "number" && turnUsage.cost > 0) {
      totalCost = turnUsage.cost;
      lastCost = lastStepUsage?.cost?.total || 0;
      isEstimate = false;
    } else {
      totalCost = ((turnUsage.input || 0) * rates[0] + (turnUsage.output || 0) * rates[1] + (turnUsage.cacheRead || 0) * rates[2]) / 1000000;
      lastCost = (((lastStepUsage?.input || 0) * rates[0] + (lastStepUsage?.output || 0) * rates[1] + (lastStepUsage?.cacheRead || 0) * rates[2])) / 1000000;
      isEstimate = true;
    }

    const subagent = turnUsage.subagent;
    const hasSubagent = Boolean(subagent && subagent.callCount > 0 && subagent.totalTokens > 0);

    let subagentInput = 0;
    let subagentOutput = 0;
    let subagentCacheRead = 0;
    let subagentActualCost = 0;

    if (hasSubagent) {
      subagentInput = Number(subagent.input) || 0;
      subagentOutput = Number(subagent.output) || 0;
      subagentCacheRead = Number(subagent.cacheRead) || 0;
      // 容错兜底：若子 agent 仅有 totalTokens 且缺少细分，按纯输入兜底计入
      if (subagentInput + subagentOutput + subagentCacheRead === 0 && subagent.totalTokens > 0) {
        subagentInput = subagent.totalTokens;
      }
      if (typeof subagent.actualCost === "number" && subagent.actualCost > 0) {
        subagentActualCost = subagent.actualCost;
      } else if (subagent.savings && typeof subagent.savings.actualCost === "number") {
        subagentActualCost = subagent.savings.actualCost;
      } else if (Array.isArray(subagent.items) && subagent.items.length > 0 && typeof computeSubagentSavings === "function") {
        const computed = computeSubagentSavings(subagent.items, rawModel, totalCost);
        if (computed && typeof computed.actualCost === "number") {
          subagentActualCost = computed.actualCost;
        }
      }
    }

    // 合并主模型与子 Agent 的 Tokens 消耗
    const combinedInput = (turnUsage.input || 0) + subagentInput;
    const combinedOutput = (turnUsage.output || 0) + subagentOutput;
    const combinedCacheRead = (turnUsage.cacheRead || 0) + subagentCacheRead;

    // 折算成 DeepSeek 最便宜一档（低峰时段 Flash）的价格（按合并 Token 计算）
    const dsRates = DEEPSEEK_CHEAPEST_OFFPEAK_RATES;
    const deepseekTotalCost = ((combinedInput) * dsRates[0] + (combinedOutput) * dsRates[1] + (combinedCacheRead) * dsRates[2]) / 1000000;
    const deepseekLastCost = (((lastStepUsage?.input || 0) * dsRates[0] + (lastStepUsage?.output || 0) * dsRates[1] + (lastStepUsage?.cacheRead || 0) * dsRates[2])) / 1000000;

    // 对比倍数：使用对齐的合并总支出（主模型实际/估算费用 + 子 Agent 实际/估算费用）对比 DeepSeek 合并折算价
    const effectiveTotalCost = totalCost + subagentActualCost;
    let multiplier = "1.0";
    if (deepseekTotalCost > 0 && effectiveTotalCost > 0) {
      const rawMult = effectiveTotalCost / deepseekTotalCost;
      multiplier = rawMult >= 10 ? rawMult.toFixed(1) : (rawMult >= 1 ? rawMult.toFixed(1) : rawMult.toFixed(2));
    }

    return {
      totalCost,
      lastCost,
      currency: "$",
      isEstimate,
      label: pricing.label,
      modelName: rawModel,
      modelDisplayName,
      modelCategory: pricing.category,
      rates,
      deepseekTotalCost,
      deepseekLastCost,
      multiplier,
      hasSubagent,
      combinedInput,
      combinedOutput,
      combinedCacheRead,
      effectiveTotalCost,
    };
  }

  function formatTurnUsageText(u, stepCount, lastStepUsage = null) {
    const q = [];
    if (u.input) q.push(`${u.input.toLocaleString()} in`);
    if (u.output) q.push(`${u.output.toLocaleString()} out`);
    if (u.cacheRead) q.push(`${u.cacheRead.toLocaleString()} cache R`);
    if (u.cacheWrite) q.push(`${u.cacheWrite.toLocaleString()} cache W`);
    const costInfo = resolveTurnCostInfo(u, lastStepUsage);
    if (costInfo.totalCost > 0) {
      q.push(`${costInfo.currency}${costInfo.totalCost.toFixed(4)}`);
    }
    const partsText = q.join(" · ");
    return stepCount > 1 ? `总计 ${partsText} (${stepCount}步)` : partsText;
  }

  function renderTurnUsageHTML(targetText) {
    if (!targetText) return "";
    const parts = targetText.split(" · ");
    const chunkHtmls = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part) continue;
      const stepMatch = part.match(/^(.*?)(\s*\(\d+步\))$/);
      if (stepMatch) {
        const mainPart = stepMatch[1].trim();
        const stepPart = stepMatch[2].trim();
        if (mainPart) {
          chunkHtmls.push(`<span class="pi-enh-usage-chunk">${mainPart}</span> <span class="pi-enh-usage-chunk">${stepPart}</span>`);
        } else {
          chunkHtmls.push(`<span class="pi-enh-usage-chunk">${stepPart}</span>`);
        }
      } else {
        chunkHtmls.push(`<span class="pi-enh-usage-chunk">${part}</span>`);
      }
    }

    return chunkHtmls.join(' <span class="pi-enh-usage-dot">·</span> ');
  }

  function clearTurnUsageBadge(usageEl) {
    const raw = usageEl.getAttribute("data-pi-enh-raw-usage");
    if (raw !== null && usageEl.textContent !== raw) usageEl.textContent = raw;
    for (const attr of ["data-pi-enh-raw-usage", "data-pi-enh-rendered-text", "data-turn-usage", "data-last-step-usage"]) {
      usageEl.removeAttribute(attr);
    }
    usageEl.classList?.remove("pi-enh-usage-badge");
    if ((usageEl.getAttribute("title") || "").includes("回合真实消耗")) usageEl.removeAttribute("title");
    if (usageEl.style?.cursor === "pointer") usageEl.style.removeProperty("cursor");
    if (usageTooltip?.__currentBadge === usageEl) hideUsageTooltip();
  }

  function syncAllUsageBadges() {
    const enabled = isPluginEnabled("turn-usage-total");
    const assistantMsgs = document.querySelectorAll('div[data-message-role="assistant"]');

    for (const msg of assistantMsgs) {
      const footer = msg.querySelector('div[style*="margin-top: 4px"], div[style*="marginTop: 4px"]') ||
                     msg.querySelector('div[style*="gap: 8px"]') ||
                     msg.footer ||
                     msg.lastElementChild;
      if (!footer) continue;
      const usageEl = findUsageElement(footer);
      if (!usageEl) continue;

      if (!enabled) {
        clearTurnUsageBadge(usageEl);
        continue;
      }

      const entryId = getMessageEntryId(msg);
      const metrics = entryId ? knownTurnMetrics.get(entryId) : null;
      let turnUsage = metrics?.turnUsage || null;
      let lastStepUsage = metrics?.lastStepUsage || null;

      // 无完整权威 metrics 时必须保留原生 DOM 文本，绝不伪造“回合真实总计”，绝不回退当前 composer/Gemini 模型
      if (!turnUsage) {
        clearTurnUsageBadge(usageEl);
        continue;
      }

      const stepCount = turnUsage.stepCount || 1;

      // 多步回合（stepCount > 1）：替换文本为回合汇总文字并高亮
      if (stepCount > 1) {
        const targetText = formatTurnUsageText(turnUsage, stepCount, lastStepUsage);
        if (!usageEl.hasAttribute("data-pi-enh-raw-usage")) {
          usageEl.setAttribute("data-pi-enh-raw-usage", usageEl.textContent || "");
        }

        const prevRendered = usageEl.getAttribute("data-pi-enh-rendered-text");
        if (prevRendered !== targetText) {
          usageEl.setAttribute("data-pi-enh-rendered-text", targetText);
          usageEl.innerHTML = renderTurnUsageHTML(targetText);
          // 如果是 Node.js 虚拟 DOM 测试环境，同步 _textContent，确保单元测试单步断言通过
          if (typeof usageEl._textContent === "string" && !usageEl.isConnected) {
            usageEl._textContent = targetText;
          }
        }
      }

      // 无论单步还是多步，统一挂载交互类与详情元数据，保证点击 100% 弹出消耗明细
      if (usageEl.classList && usageEl.classList.add) {
        usageEl.classList.add("pi-enh-usage-badge");
      }
      usageEl.setAttribute("data-turn-usage", JSON.stringify(turnUsage));
      if (lastStepUsage) {
        usageEl.setAttribute("data-last-step-usage", JSON.stringify(lastStepUsage));
      }
      const modelDisplayName = formatModelDisplayName(turnUsage.model);
      usageEl.setAttribute("title", `点击查看 ${modelDisplayName} 回合真实消耗与 DeepSeek 折算明细`);
      usageEl.style.cursor = "pointer";
    }
  }

  const syncOperationErrors = new Map();
  const MAX_RECORDED_SYNC_ERRORS = 50;
  const SYNC_ERROR_THROTTLE_MS = 10000;

  function recordSyncStepError(fnName, err) {
    const errorObj = err instanceof Error ? err : new Error(String(err || "Unknown sync operation error"));
    const errSig = `${fnName}:${errorObj.name || "Error"}:${errorObj.message || ""}`;
    const now = Date.now();
    const existing = syncOperationErrors.get(fnName);

    if (existing && existing.signature === errSig && (now - existing.lastLoggedAt) < SYNC_ERROR_THROTTLE_MS) {
      return;
    }

    if (syncOperationErrors.size >= MAX_RECORDED_SYNC_ERRORS && !syncOperationErrors.has(fnName)) {
      const oldestKey = syncOperationErrors.keys().next().value;
      if (oldestKey) syncOperationErrors.delete(oldestKey);
    }
    syncOperationErrors.set(fnName, { signature: errSig, error: errorObj, lastLoggedAt: now });

    console.error(`[Agent Web Plus Enhancements] Sync operation "${fnName}" failed:`, errorObj);
  }

  function recordSyncStepSuccess(fnName) {
    if (syncOperationErrors.has(fnName)) {
      syncOperationErrors.delete(fnName);
    }
  }

  function executeSyncStep(fn) {
    if (isDisposed || typeof fn !== "function") return;
    const fnName = fn.name || "anonymousSyncStep";
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        result.then(
          () => { if (!isDisposed) recordSyncStepSuccess(fnName); },
          (err) => { if (!isDisposed) recordSyncStepError(fnName, err); }
        );
      } else {
        recordSyncStepSuccess(fnName);
      }
    } catch (err) {
      recordSyncStepError(fnName, err);
    }
  }

  // ==========================================
  // 对话轮次序号 (Turn Number Indicator)
  // ==========================================
  function clearAllTurnNumberBadges() {
    if (typeof document === "undefined" || !document.querySelectorAll) return;
    const badges = document.querySelectorAll(".pi-enh-turn-number-badge");
    for (let i = 0; i < badges.length; i++) {
      badges[i].remove();
    }
  }

  function syncAllTurnNumberBadges() {
    if (!isPluginEnabled("turn-number-indicator")) {
      clearAllTurnNumberBadges();
      return;
    }

    const userMsgs = findUserMessages();
    if (!userMsgs || userMsgs.length === 0) {
      clearAllTurnNumberBadges();
      return;
    }

    let offset = 0;
    try {
      if (typeof readMinimapHistoryState === "function") {
        const historyState = readMinimapHistoryState(userMsgs.length);
        if (historyState && Number.isFinite(historyState.totalTurns) && historyState.totalTurns > userMsgs.length) {
          offset = historyState.totalTurns - userMsgs.length;
        }
      }
    } catch (e) {}

    for (let i = 0; i < userMsgs.length; i++) {
      const msg = userMsgs[i];
      const turnNumber = offset + i + 1;
      const timeSpan = findTimestampElement(msg);
      if (!timeSpan || !timeSpan.parentElement) continue;

      const parent = timeSpan.parentElement;
      let badge = null;
      const prev = timeSpan.previousElementSibling;
      if (prev && prev.classList && prev.classList.contains("pi-enh-turn-number-badge")) {
        badge = prev;
      } else {
        badge = parent.querySelector(".pi-enh-turn-number-badge");
      }

      const badgeText = `#${turnNumber}`;
      const badgeTitle = `第 ${turnNumber} 轮对话`;

      if (!badge) {
        badge = document.createElement("span");
        badge.className = "pi-enh-turn-number-badge";
        badge.textContent = badgeText;
        badge.setAttribute("title", badgeTitle);
        badge.setAttribute("data-turn-number", String(turnNumber));

        if (timeSpan.style && timeSpan.style.marginLeft === "auto") {
          timeSpan.style.marginLeft = "0";
          badge.style.marginLeft = "auto";
        }
        parent.insertBefore(badge, timeSpan);
      } else {
        if (badge.nextElementSibling !== timeSpan) {
          parent.insertBefore(badge, timeSpan);
        }
        if (timeSpan.style && timeSpan.style.marginLeft === "auto") {
          timeSpan.style.marginLeft = "0";
          badge.style.marginLeft = "auto";
        }
        if (badge.textContent !== badgeText) {
          badge.textContent = badgeText;
        }
        if (badge.getAttribute("title") !== badgeTitle) {
          badge.setAttribute("title", badgeTitle);
        }
        if (badge.getAttribute("data-turn-number") !== String(turnNumber)) {
          badge.setAttribute("data-turn-number", String(turnNumber));
        }
      }
    }
  }

  // ==========================================
  // Pi Coding Agent 上游更新检查与轻量提示 (https://github.com/earendil-works/pi)
  // ==========================================
  const PI_AGENT_UPDATE_STORAGE_KEY = "pi_enh_agent_update_cache_v2";
  const PI_AGENT_UPDATE_CACHE_TTL = 6 * 3600 * 1000;
  const PI_AGENT_OFFICIAL_REPO = "https://github.com/earendil-works/pi";

  function parseSemVer(v) {
    if (!v) return null;
    const clean = String(v).replace(/^v/i, "").trim();
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(clean);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  function isNewerSemVer(latest, current) {
    const l = parseSemVer(latest);
    const c = parseSemVer(current);
    if (!l || !c) return false;
    for (let i = 0; i < 3; i++) {
      if (l[i] > c[i]) return true;
      if (l[i] < c[i]) return false;
    }
    return false;
  }

  function ensurePiAgentUpdateStyle() {
    if (document.getElementById("pi-enh-agent-update-style")) return;
    const style = document.createElement("style");
    style.id = "pi-enh-agent-update-style";
    style.textContent = `
      .pi-enh-agent-update-badge {
        display: inline-flex;
        align-items: center;
        gap: 3.5px;
        margin-left: 6px;
        padding: 1px 7px 1px 6px;
        border-radius: 9999px;
        font-size: 10px;
        font-weight: 600;
        font-family: var(--font-mono, monospace);
        background: rgba(16, 185, 129, 0.12);
        color: #10b981;
        border: 1px solid rgba(16, 185, 129, 0.35);
        text-decoration: none;
        cursor: pointer;
        line-height: 1.35;
        vertical-align: middle;
        transition: all 0.18s ease;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
        flex-shrink: 0;
      }
      .pi-enh-agent-update-badge:hover {
        background: rgba(16, 185, 129, 0.22);
        border-color: rgba(16, 185, 129, 0.6);
        color: #059669;
        transform: translateY(-0.5px);
        text-decoration: none;
        box-shadow: 0 2px 5px rgba(16, 185, 129, 0.2);
      }
      .pi-enh-agent-update-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #10b981;
        box-shadow: 0 0 5px rgba(16, 185, 129, 0.9);
        animation: pi-enh-agent-dot-pulse 2s infinite ease-in-out;
        flex-shrink: 0;
      }
      @keyframes pi-enh-agent-dot-pulse {
        0%, 100% { opacity: 0.55; transform: scale(0.9); }
        50% { opacity: 1; transform: scale(1.15); box-shadow: 0 0 8px rgba(16, 185, 129, 1); }
      }
    `;
    document.head.appendChild(style);
  }

  function getPiAgentUpdateState() {
    if (!window.__PI_AGENT_UPDATE_STATE__) {
      const currentVer = (typeof window !== "undefined" && window.__PI_OFFICIAL_AGENT_VERSION__) || "0.99.1";
      window.__PI_AGENT_UPDATE_STATE__ = {
        currentVersion: currentVer,
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: `${PI_AGENT_OFFICIAL_REPO}/releases`,
        checkedAt: 0,
        isChecking: false,
        error: null,
      };
      try {
        const raw = localStorage.getItem(PI_AGENT_UPDATE_STORAGE_KEY);
        if (raw) {
          const cached = JSON.parse(raw);
          if (cached && cached.latestVersion && cached.checkedAt) {
            if (Date.now() - cached.checkedAt <= PI_AGENT_UPDATE_CACHE_TTL && cached.currentVersion === currentVer) {
              window.__PI_AGENT_UPDATE_STATE__.latestVersion = cached.latestVersion;
              window.__PI_AGENT_UPDATE_STATE__.updateAvailable = Boolean(cached.updateAvailable);
              window.__PI_AGENT_UPDATE_STATE__.releaseUrl = cached.releaseUrl || `${PI_AGENT_OFFICIAL_REPO}/releases/tag/v${cached.latestVersion}`;
              window.__PI_AGENT_UPDATE_STATE__.checkedAt = cached.checkedAt;
            }
          }
        }
      } catch (e) {}
    }
    return window.__PI_AGENT_UPDATE_STATE__;
  }

  let piAgentCheckInFlight = null;
  let piAgentCheckInFlightIncludesUpstream = false;

  async function checkPiAgentUpdate(force = false) {
    const state = getPiAgentUpdateState();
    if (piAgentCheckInFlight) {
      if (!force || piAgentCheckInFlightIncludesUpstream) return piAgentCheckInFlight;
      return piAgentCheckInFlight.then(() => checkPiAgentUpdate(true));
    }

    if (!force && state.checkedAt && Date.now() - state.checkedAt <= PI_AGENT_UPDATE_CACHE_TTL) {
      return state;
    }

    state.isChecking = true;
    state.error = null;
    piAgentCheckInFlightIncludesUpstream = Boolean(force);

    piAgentCheckInFlight = (async () => {
      try {
        let latestVer = null;
        // 策略 0: 优先读取同源静态清单 /pi-agent-update-manifest.json (离线/内网高可用保护)
        try {
          const ctrl = new AbortController();
          const tid = setTimeout(() => ctrl.abort(), 2000);
          const resp = await fetch("/pi-agent-update-manifest.json?t=" + Date.now(), {
            signal: ctrl.signal,
            cache: "no-store",
          });
          clearTimeout(tid);
          if (resp && resp.ok) {
            const json = await resp.json();
            if (json && typeof json.latestVersion === "string" && json.latestVersion.trim()) {
              latestVer = json.latestVersion.trim();
            }
          }
        } catch (e) {}

        if (force) {
          // 只有用户显式点“立即检查更新”时才访问上游公网服务。
          // 页面初始化和后台静默刷新只读取同源静态清单，避免阻塞首屏网络。
          try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 4000);
            const resp = await fetch("https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest", {
              signal: ctrl.signal,
              cache: "no-store",
            });
            clearTimeout(tid);
            if (resp && resp.ok) {
              const json = await resp.json();
              if (json && typeof json.version === "string" && json.version.trim()) {
                const npmVer = json.version.trim();
                if (!latestVer || isNewerSemVer(npmVer, latestVer)) {
                  latestVer = npmVer;
                }
              }
            }
          } catch (e) {}

          // 策略 2: 备用访问 GitHub releases/latest API
          try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 4000);
            const resp = await fetch("https://api.github.com/repos/earendil-works/pi/releases/latest", {
              signal: ctrl.signal,
              cache: "no-store",
              headers: { Accept: "application/vnd.github.v3+json" },
            });
            clearTimeout(tid);
            if (resp && resp.ok) {
              const json = await resp.json();
              const tag = (json && typeof json.tag_name === "string" ? json.tag_name : "").replace(/^v/i, "").trim();
              if (tag && (!latestVer || isNewerSemVer(tag, latestVer))) {
                latestVer = tag;
              }
            }
          } catch (e) {}
        }

        if (latestVer) {
          state.latestVersion = latestVer;
          state.updateAvailable = isNewerSemVer(latestVer, state.currentVersion);
          state.releaseUrl = `${PI_AGENT_OFFICIAL_REPO}/releases/tag/v${latestVer}`;
          state.checkedAt = Date.now();
          try {
            localStorage.setItem(PI_AGENT_UPDATE_STORAGE_KEY, JSON.stringify({
              currentVersion: state.currentVersion,
              latestVersion: state.latestVersion,
              updateAvailable: state.updateAvailable,
              releaseUrl: state.releaseUrl,
              checkedAt: state.checkedAt,
            }));
          } catch (e) {}
        } else {
          // 未获取到版本时（网络超时或离线），记录冷却时间戳，避免高频重试阻塞主线程
          state.checkedAt = Date.now();
        }
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
        state.checkedAt = Date.now();
      } finally {
        state.isChecking = false;
        piAgentCheckInFlight = null;
        piAgentCheckInFlightIncludesUpstream = false;
        // 关键防护：仅在成功探测到新版本时才触发 DOM 同步，失败/无变化时静默，杜绝死循环风暴
        if (state.latestVersion && typeof scheduleDomSync === "function") {
          scheduleDomSync();
        }
      }
      return state;
    })();

    return piAgentCheckInFlight;
  }

  window.__PI_ENH_CHECK_AGENT_UPDATE__ = checkPiAgentUpdate;

  function syncPiAgentUpdateBadge(el, officialPiVer) {
    if (!el || el.closest?.("[data-pi-native-version-header]")) return;
    ensurePiAgentUpdateStyle();
    const enabled = isPluginEnabled("pi-agent-update-notice");
    const state = getPiAgentUpdateState();

    if (enabled && !state.latestVersion && !state.isChecking && !state.checkedAt) {
      checkPiAgentUpdate(false);
    }

    const existingBadge = el.querySelector(".pi-enh-agent-update-badge");

    const curVer = officialPiVer || state.currentVersion;
    const isNewer = Boolean(
      state.latestVersion && curVer && isNewerSemVer(state.latestVersion, curVer)
    );

    if (!enabled || !state.updateAvailable || !isNewer) {
      if (existingBadge) {
        existingBadge.style.display = "none";
        existingBadge.remove();
      }
      return;
    }

    if (!existingBadge) {
      el.style.display = "inline-flex";
      el.style.alignItems = "center";
      el.style.gap = "2px";
      el.style.flexWrap = "nowrap";

      const badge = document.createElement("a");
      badge.className = "pi-enh-agent-update-badge";
      badge.target = "_blank";
      badge.rel = "noopener noreferrer";
      badge.href = state.releaseUrl;
      badge.title = `Pi Agent 上游新版本 v${state.latestVersion} 发布，点击查看 Release 说明`;
      badge.innerHTML = `
        <span class="pi-enh-agent-update-dot"></span>
        <span>Update: v${state.latestVersion}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M17 7H7M17 7V17"/></svg>
      `;
      el.appendChild(badge);
    } else {
      if ((existingBadge.getAttribute("href") || "") !== state.releaseUrl) {
        existingBadge.href = state.releaseUrl;
      }
      const labelSpan = existingBadge.querySelector("span:nth-child(2)");
      if (labelSpan && labelSpan.textContent !== `Update: v${state.latestVersion}`) {
        labelSpan.textContent = `Update: v${state.latestVersion}`;
      }
    }
  }

  function syncStandaloneVersionDom() {
    try {
      const spans = document.querySelectorAll("span");
      const officialPiVer = (typeof window !== "undefined" && window.__PI_OFFICIAL_AGENT_VERSION__) || "0.99.1";
      for (let i = 0; i < spans.length; i++) {
        const el = spans[i];
        if (el.closest?.("[data-pi-native-version-header]")) continue;
        if (el.childNodes && el.childNodes.length === 2 && el.childNodes[0].nodeType === 3) {
          const prefix = el.childNodes[0].nodeValue || "";
          const inner = el.querySelector("span");
          if (!inner) continue;
          if (/^web\s+$/i.test(prefix)) {
            const targetWebVer = `v${ENHANCEMENT_SUITE_VERSION}`;
            if (inner.textContent !== targetWebVer) inner.textContent = targetWebVer;
          } else if (/^pi\s+$/i.test(prefix)) {
            const targetPiVer = `v${officialPiVer}`;
            if (inner.textContent !== targetPiVer) inner.textContent = targetPiVer;
            syncPiAgentUpdateBadge(el, officialPiVer);
          }
        }
      }
    } catch (e) {}
  }

  const ALL_SYNC_STEPS = [
    { fn: syncStandaloneVersionDom, scope: "full" },
    { fn: syncWorkspacePickerHover, scope: "full" },
    { fn: syncAllDurationBadges, scope: "chat-text" },
    { fn: syncAllTurnNumberBadges, scope: "chat-text" },
    { fn: syncAllUsageBadges, scope: "chat-text" },
    { fn: syncAllModelSpeedBadges, scope: "chat-text" },
    { fn: syncAllTaskToolAutoCollapse, scope: "chat-text" },
    { fn: syncSubagentDispatchCards, scope: "full" },
    { fn: syncHistoryScrollStability, scope: "chat-text" },
    { fn: syncCompactionCards, scope: "chat-text" },
    { fn: hideQuickActionAnalysisCards, scope: "full" },
    { fn: syncQuickActionButtons, scope: "full" },
    { fn: syncEmptySendContinue, scope: "full" },
    { fn: syncBottomShortcutsBar, scope: "full" },
    { fn: syncProjectStatusIndicators, scope: "full" },
    { fn: syncScrollbarPlugin, scope: "chat-text" },
    { fn: syncNativeMessageFont, scope: "full" },
    { fn: syncSessionVirtualScroll, scope: "full" },
    { fn: syncMinimapEnhancements, scope: "chat-text" },
    { fn: syncSessionScrollTracking, scope: "chat-text" },
    { fn: syncLocalPathLauncher, scope: "full" },
    { fn: syncSessionPinArchiveControls, scope: "full" },
    { fn: syncSessionBatchActions, scope: "full" },
    { fn: syncSessionModelLabels, scope: "full" },
    { fn: syncSessionItemCompact, scope: "full" },
    { fn: syncSessionColorEffects, scope: "full" },
    { fn: syncSessionTags, scope: "full" },
    { fn: syncSessionSectionHeaders, scope: "full" },
    { fn: syncSessionSearchTagFilterBar, scope: "full" },
    { fn: highlightSearchResultsKeywords, scope: "full" },
    { fn: syncSearchResultsArchivedDecoration, scope: "full" },
    { fn: syncSearchResultsFoldingBars, scope: "full" },
    { fn: syncComposerFilePaste, scope: "full" },
    { fn: syncComposerImageZoom, scope: "full" },
    { fn: syncRunningModelSwitch, scope: "full" },
    { fn: syncComposerQueuePanel, scope: "full" },
    { fn: syncComposerToolButtons, scope: "full" },
    { fn: syncComposerMarkdownFormat, scope: "full" },
    { fn: syncComposerModes, scope: "full" },
    { fn: syncAtMentionPluginsFeature, scope: "full" },
    { fn: syncComposerCleanPlaceholder, scope: "full" },
    { fn: syncImageDblClickPreview, scope: "full" },
    { fn: syncSessionPanelBinding, scope: "full" },
    { fn: syncFilePanelOverlayGuard, scope: "full" },
    { fn: syncSearchButtonHint, scope: "full" },
    { fn: syncStreamingThinkingGuard, scope: "chat-text" },
    { fn: syncMarkdownViewerMode, scope: "full" },
    { fn: syncExcelViewerMode, scope: "full" },
    { fn: checkAndAutoRecoverAccessDenied, scope: "full" }
  ];

  function runAllSyncOperations(scopeOrOptions) {
    if (isDisposed) return;
    const targetScope = (typeof scopeOrOptions === "string" ? scopeOrOptions : scopeOrOptions?.scope) === "chat-text"
      ? "chat-text"
      : "full";

    withMutationGuard(() => {
      if (isDisposed) return;
      for (let i = 0; i < ALL_SYNC_STEPS.length; i++) {
        if (isDisposed) return;
        const step = ALL_SYNC_STEPS[i];
        if (targetScope === "chat-text" && step.scope !== "chat-text") {
          continue;
        }
        executeSyncStep(step.fn);
      }
    });
  }

  window.__PI_ENH_RUN_ALL_SYNC_OPERATIONS__ = runAllSyncOperations;
  window.__PI_ENH_EXECUTE_SYNC_STEP__ = executeSyncStep;
  window.__PI_ENH_SYNC_OPERATION_ERRORS__ = syncOperationErrors;
  window.__PI_ENH_SYNC_TURN_NUMBERS__ = syncAllTurnNumberBadges;
  window.__PI_ENH_CLEAR_TURN_NUMBERS__ = clearAllTurnNumberBadges;

  setProjectStatusMonitoring(isPluginEnabled("project-status-indicator"));
  addManagedListener(window, "online", () => {
    projectStatusNextPoll = 0;
    refreshProjectInteractions();
    const currentId = getActiveSessionId() || getCurrentSessionId();
    if (currentId) scheduleTerminalSyncCheck(currentId, { reason: "online", force: true });
  });
  addManagedListener(window, "resize", () => {
    syncSessionItemCompact();
    syncMinimapEnhancements();
  });
  addManagedListener(document, "visibilitychange", () => {
    setProjectStatusMonitoring(isPluginEnabled("project-status-indicator"));
    if (document.visibilityState === "visible") {
      syncProjectStatusIndicators();
      // 手机端/前台切回：静默确保当前会话快照与状态对齐，绝不触发全屏重载
      const currentId = getActiveSessionId() || getCurrentSessionId();
      if (currentId) {
        // Unified verifier owns both the authoritative read and React commit; no competing cache-only preload.
        if (typeof scheduleTerminalSyncCheck === "function") {
          scheduleTerminalSyncCheck(currentId, { reason: "visibility" });
        }
      }
      if (typeof scheduleDomSync === "function") {
        scheduleDomSync("full");
      }
    }
  });
  addManagedListener(window, "pageshow", (event) => {
    // 页面从 BFCache 或后台恢复
    if (event.persisted) {
      if (document.visibilityState !== "hidden") {
        setProjectStatusMonitoring(isPluginEnabled("project-status-indicator"));
      }
      const currentId = getActiveSessionId() || getCurrentSessionId();
      if (currentId) {
        if (typeof scheduleTerminalSyncCheck === "function") {
          scheduleTerminalSyncCheck(currentId, { reason: "pageshow" });
        }
      }
      if (document.visibilityState !== "hidden" && typeof scheduleDomSync === "function") {
        scheduleDomSync("full");
      }
    }
  });
  addManagedListener(window, "pagehide", () => setProjectStatusMonitoring(false));
  activeCleanups.push(() => {
    projectStatusDisposed = true;
    setProjectStatusMonitoring(false);
    if (window.__PI_ENH_COMPOSE_WINDOW_TITLE__ === composeProjectWindowTitle) {
      delete window.__PI_ENH_COMPOSE_WINDOW_TITLE__;
      delete window.__PI_ENH_CLEAR_SESSION_ATTENTION__;
      delete window.__PI_ENH_MARK_LOCAL_ACTIVE_SESSION_ATTENTION__;
      delete window.__PI_ENH_GET_EFFECTIVE_PROJECT_STATUS_ENTRY__;
    }
    if (window.__PI_ENH_RUNNING_SNAPSHOT__ === getProjectStatusRunningSnapshot) delete window.__PI_ENH_RUNNING_SNAPSHOT__;
    removeProjectStatusIndicators();
  });

  let lastRecordedRunningState = false;
  const mainSyncIntervalId = addManagedInterval(() => {
    if (isLoginPage()) return;
    const isRunning = typeof isChatSessionRunning === "function" && isChatSessionRunning();
    const runningStateChanged = lastRecordedRunningState !== isRunning;
    if (lastRecordedRunningState && !isRunning) {
      // 任务刚刚执行完成：立即主动拉取最新 metrics，秒级渲染耗时与总用量
      scheduleCurrentSessionMetrics(50);
      scheduleCurrentSessionMetrics(300);
    }
    lastRecordedRunningState = isRunning;

    let sessionChanged = false;
    const sessionId = getCurrentSessionId();
    if (sessionId !== observedSessionId) {
      sessionChanged = true;
      const oldSessionId = observedSessionId;
      observedSessionId = sessionId;
      autoLoadEarlierTriggered = false;
      handleSessionSwitchLiveCleanup();
      if (oldSessionId && typeof captureSessionPanelState === "function") {
        captureSessionPanelState(oldSessionId);
      }
      if (typeof applySessionPanelState === "function") {
        applySessionPanelState(sessionId);
      }
      if (isPluginEnabled("task-tool-auto-collapse")) {
        syncAllTaskToolAutoCollapse();
      }
      syncComposerMarkdownFormat();
      syncComposerModes();
      syncComposerQueuePanel();
      scheduleCurrentSessionMetrics(300);
      if (sessionId && typeof scheduleTerminalSyncCheck === "function") {
        scheduleTerminalSyncCheck(sessionId, { reason: "session_switch" });
      }
    }
    if (typeof syncComposerDraftSessionContext === "function") {
      syncComposerDraftSessionContext();
    }
    const isForeground = typeof document === "undefined" || document.visibilityState !== "hidden";
    if (isForeground) {
      // DOM/config changes and navigation already invalidate their own scopes.
      // Keep lifecycle reconciliation, but do not rescan unchanged messages.
      if (sessionChanged || runningStateChanged) {
        if (typeof scheduleDomSync === "function") {
          scheduleDomSync("full");
        }
      }
    }
    // Restoration is entry-scoped. A periodic sync may persist an unsent draft,
    // but may never re-request recovery for the currently active owner.
    if (typeof attemptComposerDraftRestore === "function" && typeof hasPendingComposerDraftRestore === "function"
      && hasPendingComposerDraftRestore()) {
      attemptComposerDraftRestore();
    }
    if (typeof syncComposerDraftOnInterval === "function") {
      syncComposerDraftOnInterval();
    }
  }, 800);
  addManagedListener(window, "pi-native-session-data-change", (event) => {
    if (event.detail?.sessionId === getCurrentSessionId()) scheduleCurrentSessionMetrics(0);
  });
  scheduleCurrentSessionMetrics(200);
  addManagedListener(window, "popstate", () => {
    clearHistorySyncWarning();
    handleSessionSwitchLiveCleanup();
    const oldSessionId = observedSessionId;
    const newSessionId = getCurrentSessionId();
    syncComposerMarkdownFormat();
    syncComposerModes();
    syncComposerQueuePanel();
    if (typeof syncComposerDraftSessionContext === "function") {
      syncComposerDraftSessionContext();
    }
    scheduleCurrentSessionMetrics(0);
    try {
      const currentSessionId = getSessionIdFromCurrentUrl();
      if (currentSessionId && typeof markProjectCompletionRead === "function") {
        markProjectCompletionRead(currentSessionId);
        if (typeof syncProjectStatusIndicators === "function") {
          syncProjectStatusIndicators();
        }
      }
      if (currentSessionId && typeof scheduleTerminalSyncCheck === "function") {
        scheduleTerminalSyncCheck(currentSessionId, { reason: "session_switch" });
      }
    } catch (e) {}
  });
  addManagedListener(window, "beforeunload", () => {
    if (typeof saveCurrentSessionScrollForReload === "function") {
      saveCurrentSessionScrollForReload();
    }
    if (typeof saveCurrentComposerDraft === "function") {
      saveCurrentComposerDraft();
    }
  });
  addManagedListener(window, "pagehide", () => {
    if (typeof saveCurrentSessionScrollForReload === "function") {
      saveCurrentSessionScrollForReload();
    }
    if (typeof saveCurrentComposerDraft === "function") {
      saveCurrentComposerDraft();
    }
  });

  // Next.js changes ?session= with History API rather than popstate. The
  // enhancement may have started on /login, so refetch after either client-side
  // navigation method once the selected session is present in the URL.
  for (const method of ["pushState", "replaceState"]) {
    const original = window.history && window.history[method];
    if (typeof original !== "function" || original.__piEnhDurationWrapped) continue;
    const wrapped = function (...args) {
      // 关键修复：URL 规范化防御！
      // 拦截并纠正任何带有会话 UUID 路径的 History 操作，将 pathname 严格纠正为 /，
      // 避免 Next.js 的 router.replace(window.location.pathname) 将错误的 UUID 路径作为目标导致 404！
      if (args.length >= 3 && typeof args[2] === "string") {
        try {
          const rawArg = args[2];
          const parsed = new URL(rawArg, window.location.href);
          const rawPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawPath)) {
            if (!parsed.searchParams.has("session")) {
              parsed.searchParams.set("session", rawPath);
            }
            parsed.pathname = "/";
            args[2] = parsed.pathname + (parsed.search ? parsed.search : "");
          } else if (rawArg.startsWith("?")) {
            const winPath = window.location.pathname.replace(/^\/+|\/+$/g, "");
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(winPath)) {
              args[2] = "/" + rawArg;
            }
          }
        } catch (e) {}
      }
      clearHistorySyncWarning();
      handleSessionSwitchLiveCleanup();
      const currentSidBefore = getCurrentSessionId();
      // Draft ownership comes from ChatInput, never from either history URL.
      saveCurrentComposerDraft();
      const result = original.apply(this, args);
      if (typeof syncComposerDraftSessionContext === "function") {
        syncComposerDraftSessionContext();
      }
      if (isPluginEnabled("task-tool-auto-collapse")) {
        syncAllTaskToolAutoCollapse();
      }
      if (isPluginEnabled("session-model-label")) {
        syncSessionModelLabels();
      }
      if (typeof syncComposerModes === "function") {
        syncComposerModes();
      }
      if (typeof syncComposerQueuePanel === "function") {
        syncComposerQueuePanel();
      }
      scheduleCurrentSessionMetrics(0);
      try {
        const urlArg = args[2];
        let targetSessionId = null;
        if (typeof urlArg === "string") {
          const match = urlArg.match(/[?&]session=([^&#]+)/);
          if (match) targetSessionId = decodeURIComponent(match[1]);
        }
        const currentSessionId = targetSessionId || getSessionIdFromCurrentUrl();
        if (currentSessionId && typeof markProjectCompletionRead === "function") {
          markProjectCompletionRead(currentSessionId);
          if (typeof syncProjectStatusIndicators === "function") {
            syncProjectStatusIndicators();
          }
        }
        if (currentSessionId && typeof scheduleTerminalSyncCheck === "function") {
          scheduleTerminalSyncCheck(currentSessionId, { reason: "session_switch" });
        }
      } catch (e) {}
      return result;
    };
    wrapped.__piEnhDurationWrapped = true;
    window.history[method] = wrapped;
    activeCleanups.push(() => {
      if (window.history[method] === wrapped) window.history[method] = original;
    });
  }

  // ==========================================
  // 3.5. Native Message Font, Scrollbar & Minimap Full Navigation Plugins
  // ==========================================
  function syncNativeMessageFont() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("pi-enh-native-message-font-active", isPluginEnabled("native-message-font"));
  }

  function syncScrollbarPlugin() {
    const enabled = isPluginEnabled("chat-scrollbar");
    if (enabled) {
      if (document.documentElement && !document.documentElement.classList.contains("pi-enh-scrollbar-active")) {
        document.documentElement.classList.add("pi-enh-scrollbar-active");
      }
    } else {
      if (document.documentElement && document.documentElement.classList.contains("pi-enh-scrollbar-active")) {
        document.documentElement.classList.remove("pi-enh-scrollbar-active");
      }
    }
  }

  function syncSessionVirtualScroll() {
    if (typeof isDisposed !== "undefined" && isDisposed) {
      cancelVirtualHistoryAnchor?.("disposed");
      return;
    }
    const enabled = isPluginEnabled("session-virtual-scroll");
    if (!enabled) {
      cancelVirtualHistoryAnchor?.("virtual-scroll-disabled");
    } else if (activeVirtualHistoryAnchor) {
      const currentSid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
      const currentScroll = typeof getChatScrollContainer === "function" ? getChatScrollContainer() : null;
      if (!currentSid || currentSid !== activeVirtualHistoryAnchor.sessionId ||
          !currentScroll || currentScroll !== activeVirtualHistoryAnchor.scroll ||
          currentScroll.isConnected === false) {
        cancelVirtualHistoryAnchor?.("session-or-container-changed");
      }
    }
    if (typeof document !== "undefined" && document.documentElement) {
      if (enabled) {
        document.documentElement.classList.add("pi-enh-virtual-scroll-active");
      } else {
        document.documentElement.classList.remove("pi-enh-virtual-scroll-active");
      }
    }
  }
  syncSessionVirtualScroll();
  activeCleanups.push(() => cancelVirtualHistoryAnchor?.("module-cleanup"));

  // ==========================================
  // Directory Picker Modal Enhancement (选择目录弹窗悬停与新增文件夹)
  // ==========================================
  let activeCreatedFolderToHighlight = null;

  async function createDirectoryOnServer(parentPath, folderName) {
    if (!folderName || typeof folderName !== "string") {
      throw new Error("文件夹名称无效");
    }
    const trimmed = folderName.trim();
    if (!trimmed) {
      throw new Error("文件夹名称不能为空");
    }
    if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === ".." || trimmed === ".") {
      throw new Error("文件夹名称不能包含路径分隔符或特殊字符");
    }

    const cleanParent = (parentPath || "").trim();
    const isWindows = cleanParent.includes("\\") || /^[a-zA-Z]:/.test(cleanParent);
    const sep = isWindows ? "\\" : "/";
    const fullPath = cleanParent.endsWith("/") || cleanParent.endsWith("\\")
      ? `${cleanParent}${trimmed}`
      : `${cleanParent}${sep}${trimmed}`;

    // 优先尝试以 cleanParent 为终端 cwd 启动，如果受限则回退到 /workspace
    let termRes = null;
    try {
      if (cleanParent) {
        termRes = await fetch("/api/terminal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: cleanParent })
        });
      }
    } catch (e) {}

    if (!termRes || !termRes.ok) {
      termRes = await fetch("/api/terminal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: "/workspace" })
      });
    }

    if (!termRes.ok) {
      const errData = await termRes.json().catch(() => ({}));
      throw new Error(errData.error || `启动终端服务失败 (HTTP ${termRes.status})`);
    }

    const termData = await termRes.json();
    const termId = termData?.id;
    if (!termId) {
      throw new Error("未能获取终端会话 ID");
    }

    try {
      const safePath = "'" + fullPath.replace(/'/g, "'\\''") + "'";
      const cmd = `mkdir -p ${safePath}\r`;
      const inputRes = await fetch(`/api/terminal/${encodeURIComponent(termId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "input", data: cmd })
      });
      if (!inputRes.ok) {
        throw new Error("发送创建目录命令失败");
      }
      // 等待 250ms 确保目录落盘
      await new Promise((r) => setTimeout(r, 250));
      return { success: true, folderName: trimmed, fullPath };
    } finally {
      try {
        await fetch(`/api/terminal/${encodeURIComponent(termId)}`, { method: "DELETE" });
      } catch (e) {}
    }
  }

  function toggleInlineNewFolderRow(picker) {
    if (!picker) return;
    const list = picker.querySelector(".directory-picker-list");
    if (!list) return;

    let existingRow = list.querySelector(".directory-picker-new-folder-row");
    if (existingRow) {
      const input = existingRow.querySelector(".directory-picker-new-folder-input");
      if (input) {
        input.focus();
        input.select();
      }
      return;
    }

    const pathInput = picker.querySelector("input.directory-picker-path");
    const currentPath = pathInput ? pathInput.value.trim() : "";

    const row = document.createElement("div");
    row.className = "directory-picker-new-folder-row";
    row.innerHTML = `
      <div class="directory-picker-new-folder-inner">
        <svg class="directory-picker-new-folder-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true">
          <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z"></path>
        </svg>
        <input type="text" class="directory-picker-new-folder-input" placeholder="新建文件夹名称..." autocomplete="off" spellcheck="false" />
        <div class="directory-picker-new-folder-actions">
          <button type="button" class="directory-picker-new-folder-btn-submit" title="创建 (Enter)">创建</button>
          <button type="button" class="directory-picker-new-folder-btn-cancel" title="取消 (Esc)">取消</button>
        </div>
      </div>
      <div class="directory-picker-new-folder-error" style="display: none;"></div>
    `;

    const input = row.querySelector(".directory-picker-new-folder-input");
    const submitBtn = row.querySelector(".directory-picker-new-folder-btn-submit");
    const cancelBtn = row.querySelector(".directory-picker-new-folder-btn-cancel");
    const errorBox = row.querySelector(".directory-picker-new-folder-error");

    const showError = (msg) => {
      if (!errorBox) return;
      errorBox.textContent = msg;
      errorBox.style.display = msg ? "block" : "none";
    };

    const closeRow = () => {
      row.remove();
    };

    const doSubmit = async () => {
      const name = input ? input.value.trim() : "";
      if (!name) {
        showError("请输入文件夹名称");
        input?.focus();
        return;
      }
      if (name.includes("/") || name.includes("\\") || name === ".." || name === ".") {
        showError("文件夹名称不能包含路径分隔符");
        input?.focus();
        return;
      }

      // 检查当前列表中是否已存在同名条目
      const entries = Array.from(list.querySelectorAll(".directory-picker-entry span"));
      const exists = entries.some((span) => span.textContent.trim() === name);
      if (exists) {
        showError("该文件夹已存在");
        input?.focus();
        return;
      }

      showError("");
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = "创建中…";
      }
      if (cancelBtn) cancelBtn.disabled = true;
      if (input) input.disabled = true;

      try {
        const res = await createDirectoryOnServer(currentPath, name);
        activeCreatedFolderToHighlight = res.folderName;
        closeRow();

        // 刷新目录列表：触发提交刷新
        const form = picker.querySelector("form");
        if (form) {
          form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        } else {
          const goBtn = picker.querySelector("form button.directory-picker-action");
          if (goBtn) goBtn.click();
        }
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "创建";
        }
        if (cancelBtn) cancelBtn.disabled = false;
        if (input) {
          input.disabled = false;
          input.focus();
        }
      }
    };

    submitBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void doSubmit();
    });

    cancelBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeRow();
    });

    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        void doSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRow();
      }
    });

    // 插入到列表开头
    if (list.firstChild) {
      list.insertBefore(row, list.firstChild);
    } else {
      list.appendChild(row);
    }

    // 聚焦输入框
    setTimeout(() => {
      input?.focus();
      input?.select();
    }, 50);
  }

  function enhanceDirectoryPickerModal() {
    if (!isPluginEnabled("workspace-picker-hover")) return;
    const picker = document.querySelector(".directory-picker-panel");
    if (!picker || picker.hasAttribute("data-pi-native-directory-picker")) return;

    // 1. 移除顶栏可能残留的重复新建按钮，让输入框自然充满并紧挨“转到”按钮
    const oldTopBtn = picker.querySelector(".directory-picker-top-new-folder-btn");
    if (oldTopBtn) {
      oldTopBtn.remove();
    }

    // 2. 底栏增强：调整两端对齐并在左侧加入“新建文件夹”主按钮
    const footer = picker.querySelector(".directory-picker-footer");
    if (footer && !footer.querySelector(".directory-picker-new-folder-btn")) {
      footer.style.display = "flex";
      footer.style.justifyContent = "space-between";
      footer.style.alignItems = "center";

      let leftBox = footer.querySelector(".directory-picker-footer-left");
      if (!leftBox) {
        leftBox = document.createElement("div");
        leftBox.className = "directory-picker-footer-left";
        leftBox.innerHTML = `
          <button type="button" class="directory-picker-action directory-picker-new-folder-btn" title="在当前目录下新建文件夹">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink:0;">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
              <line x1="12" y1="11" x2="12" y2="17"></line>
              <line x1="9" y1="14" x2="15" y2="14"></line>
            </svg>
            <span>新建文件夹</span>
          </button>
        `;
        leftBox.querySelector("button")?.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleInlineNewFolderRow(picker);
        });
        footer.insertBefore(leftBox, footer.firstChild);
      }

      // 移除/隐藏冗余的“取消”按钮（弹窗已有右上角关闭按钮、Esc和点击遮罩关闭）
      for (const btn of footer.querySelectorAll("button")) {
        if (
          !btn.classList.contains("directory-picker-new-folder-btn") &&
          !btn.style.background?.includes("var(--accent)") &&
          /取消|cancel/i.test(btn.textContent || "")
        ) {
          btn.style.display = "none";
        }
      }
    }

    // 3. 检查是否有刚刚新建的目录项需要高亮
    if (activeCreatedFolderToHighlight) {
      const list = picker.querySelector(".directory-picker-list");
      if (list) {
        const spans = Array.from(list.querySelectorAll(".directory-picker-entry span"));
        const targetSpan = spans.find((s) => s.textContent.trim() === activeCreatedFolderToHighlight);
        if (targetSpan) {
          const entryBtn = targetSpan.closest(".directory-picker-entry");
          if (entryBtn) {
            entryBtn.classList.add("pi-enh-newly-created-pulse");
            entryBtn.scrollIntoView({ block: "nearest", behavior: "smooth" });
            const toClear = activeCreatedFolderToHighlight;
            setTimeout(() => {
              entryBtn.classList.remove("pi-enh-newly-created-pulse");
              if (activeCreatedFolderToHighlight === toClear) {
                activeCreatedFolderToHighlight = null;
              }
            }, 2500);
          }
        }
      }
    }
  }

  function syncWorkspacePickerHover() {
    const enabled = isPluginEnabled("workspace-picker-hover");
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.classList.toggle("pi-enh-workspace-picker-hover-active", enabled);
      if (enabled) {
        enhanceDirectoryPickerModal();
      }
    }
  }
  syncWorkspacePickerHover();

  // Native ChatMinimap owns rendering, navigation gestures, history loading and styles.
  // Keep only the settings/state adapters consumed by the enhancement registry and HUD.
  minimapHistoryDisplayState = new Map();
  autoLoadEarlierTriggered = false;

  function clampMinimapTurnSetting(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Math.max(1, Math.min(50, Number.isFinite(parsed) ? parsed : fallback));
  }

  function getMinimapHistorySettings() {
    return {
      initialTurns: Math.max(5, clampMinimapTurnSetting(getPluginSetting("minimap-full-nav", "initialTurns"), 5)),
      stepTurns: clampMinimapTurnSetting(getPluginSetting("minimap-full-nav", "stepTurns"), 5),
    };
  }

  function setMinimapInitialTurns(value) {
    minimapHistoryDisplayState.clear();
    return setPluginSetting("minimap-full-nav", "initialTurns", value);
  }

  function setMinimapStepTurns(value) {
    return setPluginSetting("minimap-full-nav", "stepTurns", value);
  }

  function readMinimapHistoryState(loadedTurns) {
    let nativeState = null;
    try {
      nativeState = typeof window.__PI_ENH_GET_HISTORY_STATE__ === "function"
        ? window.__PI_ENH_GET_HISTORY_STATE__()
        : null;
    } catch (e) {}

    const currentSessionId = getCurrentSessionId();
    const nativeSessionId = nativeState?.sessionId || currentSessionId;
    const sameSession = !currentSessionId || !nativeSessionId || currentSessionId === nativeSessionId;
    const nativeTotal = sameSession ? Number(nativeState?.totalTurns) : 0;
    const totalTurns = Number.isFinite(nativeTotal) && nativeTotal > 0
      ? Math.max(loadedTurns, Math.floor(nativeTotal))
      : loadedTurns;
    return {
      sessionId: currentSessionId || nativeSessionId || "current",
      totalTurns,
      hasEarlierMessages: sameSession && (Boolean(nativeState?.hasEarlierMessages) || totalTurns > loadedTurns),
    };
  }

  function isMinimapPreviewOpen() {
    try {
      return typeof window.__PI_ENH_IS_MINIMAP_OPEN__ === "function"
        ? Boolean(window.__PI_ENH_IS_MINIMAP_OPEN__())
        : false;
    } catch (e) {
      return false;
    }
  }

  function getNativeMinimapOpenRatio(clientY) {
    if (!Number.isFinite(clientY)) return undefined;
    const rail = document.querySelector("[data-minimap-native-owner]");
    const rect = rail?.getBoundingClientRect?.();
    return rect
      ? Math.max(0, Math.min(1, (clientY - rect.top) / (rect.height || 1)))
      : undefined;
  }

  function openMinimapPreview(clientY) {
    if (typeof window.__PI_ENH_OPEN_MINIMAP__ !== "function") return false;
    try {
      window.__PI_ENH_OPEN_MINIMAP__(getNativeMinimapOpenRatio(clientY));
      return true;
    } catch (e) {
      return false;
    }
  }

  function closeMinimapPreview() {
    if (typeof window.__PI_ENH_CLOSE_MINIMAP__ !== "function") return false;
    try {
      window.__PI_ENH_CLOSE_MINIMAP__();
      return true;
    } catch (e) {
      return false;
    }
  }

  function animateCloseMinimapPreview(onComplete) {
    if (typeof window.__PI_ENH_CLOSE_MINIMAP__ === "function") {
      try { window.__PI_ENH_CLOSE_MINIMAP__(true); } catch (e) {}
    }
    if (typeof onComplete === "function") onComplete();
  }

  let lastMinimapPreferences = "";
  function syncMinimapEnhancements() {
    const preferences = JSON.stringify({ enabled: isPluginEnabled("minimap-full-nav"), ...getMinimapHistorySettings() });
    if (preferences === lastMinimapPreferences) return;
    lastMinimapPreferences = preferences;
    window.dispatchEvent(new CustomEvent("pi:minimap-preferences-change", {
      detail: {
        featureId: "minimap-full-nav",
        enabled: isPluginEnabled("minimap-full-nav"),
        settings: getMinimapHistorySettings(),
      },
    }));
  }

  window.__PI_ENH_OPEN_MINIMAP_PREVIEW__ = openMinimapPreview;
  window.__PI_ENH_CLOSE_MINIMAP_PREVIEW__ = closeMinimapPreview;
  window.__PI_ENH_ANIMATE_CLOSE_MINIMAP_PREVIEW__ = animateCloseMinimapPreview;
  window.__PI_ENH_GET_MINIMAP_HISTORY_SETTINGS__ = getMinimapHistorySettings;
  window.__PI_ENH_SET_MINIMAP_INITIAL_TURNS__ = setMinimapInitialTurns;
  window.__PI_ENH_SET_MINIMAP_STEP_TURNS__ = setMinimapStepTurns;
  window.__PI_ENH_SYNC_MINIMAP__ = syncMinimapEnhancements;

  // React owns the arrow, its geometry and its click lifecycle.
  // Shared history helpers still use the explicit native scroll owner.
  function getChatScrollContainer() {
    return document.querySelector("[data-pi-native-scroll-owner]");
  }

  function getChatContentContainer() {
    return document.querySelector(".chat-content");
  }

  function syncScrollBottomPreferences() {
    window.dispatchEvent(new CustomEvent("pi:scroll-bottom-preferences", {
      detail: { enabled: isPluginEnabled("scroll-to-bottom") },
    }));
  }
  syncScrollBottomPreferences();

  // Native ChatWindow owns tab-local positions and restores them before paint.
  const SESSION_SCROLL_STORAGE_KEY = "pi-enh-session-scroll-memory-v2";
  let sessionClickCaptureAttached = false;
  function saveCurrentSessionScrollForReload() {
    window.dispatchEvent(new Event("pi-chat-save-scroll-position"));
    try { return sessionStorage.getItem(SESSION_SCROLL_STORAGE_KEY); } catch (_) { return null; }
  }
  function isSessionScrollRestoring(sid = getCurrentSessionId()) {
    const scroll = getChatScrollContainer();
    return scroll?.dataset?.piNativeScrollOwner === sid && scroll.dataset.piNativeScrollRestoring === "true";
  }
  function isScrollRestoreProtectedForSession(sid) { return isSessionScrollRestoring(sid); }
  function cancelActiveScrollRestore() {
    window.dispatchEvent(new Event("pi-chat-cancel-scroll-restore"));
  }
  function handleSessionSwitchPreflight(targetSid) {
    if (!targetSid) return;
    try {
      const targetEntry = sessionMemoryCache?.get?.(targetSid);
      if (!targetEntry) return;

      if (targetEntry.needsFreshSync && !targetEntry.isRunning) {
        targetEntry._lastRevalidatedAt = 0;
        targetEntry._skipNextRevalidationUntil = 0;
        return;
      }

      // 时间戳、完整性与服务端版本由 cachedSessionFetch 针对实际请求的候选快照判断。
      // 不扫描其他 URL 变体：预热的 tail=80/无参别名并非全历史，不能因其条数少而清空整个会话。
    } catch (e) {}
  }

  function isSessionActionControlTargetInChat(target) {
    if (!target || typeof target.closest !== "function") return false;
    if (typeof window.__PI_ENH_IS_SESSION_ACTION_CONTROL__ === "function") {
      try { return window.__PI_ENH_IS_SESSION_ACTION_CONTROL__(target); } catch (_) {}
    }
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

  function handleSessionClickCapture(event) {
    const target = event.target;
    if (!target || isSessionActionControlTargetInChat(target)) return;
    const sessionEl = target.closest?.("[data-pi-enh-session-id], [data-session-id], [data-search-session-id], .pi-enh-session-row-host, .session-row");
    if (!sessionEl) return;
    const targetSid = sessionEl.getAttribute("data-pi-enh-session-id") ||
                      sessionEl.getAttribute("data-session-id") ||
                      sessionEl.getAttribute("data-search-session-id");
    const currentSid = getCurrentSessionId();
    if (targetSid && targetSid !== currentSid) {
      if (currentSid && typeof clearTerminalReconcileTimers === "function") {
        clearTerminalReconcileTimers(currentSid);
      }
      handleSessionSwitchPreflight(targetSid);
      if (currentSid && typeof captureSessionPanelState === "function") {
        captureSessionPanelState(currentSid);
      }
    }
  }

  function syncSessionScrollTracking() {
    if (sessionClickCaptureAttached) return;
    sessionClickCaptureAttached = true;
    addManagedListener(document, "pointerdown", handleSessionClickCapture, { capture: true, passive: true });
    addManagedListener(document, "click", handleSessionClickCapture, { capture: true, passive: true });
  }

  // ==========================================
  // 3.6. Code Block Scan Guard (代码块免扫描保护)
  // ==========================================
  const CODE_SCAN_GUARD_MARKER = "data-pi-enh-code-scan-protected";
  const CODE_SCAN_GUARD_ATTRIBUTES = {
    translate: "no",
    "data-no-translate": "true",
    spellcheck: "false",
  };
  codeBlockScanObserver = null;

  function protectCodeBlockElement(element) {
    if (!element || typeof element.setAttribute !== "function" || element.hasAttribute(CODE_SCAN_GUARD_MARKER)) return;
    const previous = {};
    for (const [name, value] of Object.entries(CODE_SCAN_GUARD_ATTRIBUTES)) {
      previous[name] = element.hasAttribute(name) ? element.getAttribute(name) : null;
      element.setAttribute(name, value);
    }
    element.setAttribute(CODE_SCAN_GUARD_MARKER, JSON.stringify(previous));
  }

  function protectCodeBlocksIn(root) {
    if (!root || !isPluginEnabled("code-block-scan-guard")) return;
    const tagName = root.tagName?.toLowerCase();
    if (tagName === "pre" || tagName === "code") protectCodeBlockElement(root);
    if (typeof root.querySelectorAll === "function") {
      for (const element of root.querySelectorAll("pre, code")) protectCodeBlockElement(element);
    }
  }

  function restoreCodeBlockScanAttributes() {
    for (const element of document.querySelectorAll(`[${CODE_SCAN_GUARD_MARKER}]`)) {
      let previous = {};
      try { previous = JSON.parse(element.getAttribute(CODE_SCAN_GUARD_MARKER) || "{}"); } catch (e) {}
      for (const name of Object.keys(CODE_SCAN_GUARD_ATTRIBUTES)) {
        if (previous[name] === null || previous[name] === undefined) element.removeAttribute(name);
        else element.setAttribute(name, previous[name]);
      }
      element.removeAttribute(CODE_SCAN_GUARD_MARKER);
    }
  }

  function startCodeBlockScanGuard() {
    if (!isPluginEnabled("code-block-scan-guard")) return;
    const scanRoot = document.body || document.documentElement;
    if (!scanRoot) return;
    protectCodeBlocksIn(scanRoot);
    if (codeBlockScanObserver || typeof MutationObserver !== "function") return;
    try {
      codeBlockScanObserver = new MutationObserver((records) => {
        if (!isPluginEnabled("code-block-scan-guard")) return;
        for (const record of records || []) {
          for (const node of record.addedNodes || []) protectCodeBlocksIn(node);
        }
      });
      codeBlockScanObserver.observe(scanRoot, { childList: true, subtree: true });
    } catch (e) {}
  }

  function stopCodeBlockScanGuard() {
    if (codeBlockScanObserver) {
      codeBlockScanObserver.disconnect();
      codeBlockScanObserver = null;
    }
    restoreCodeBlockScanAttributes();
  }

  startCodeBlockScanGuard();
  activeCleanups.push(stopCodeBlockScanGuard);

  // ==========================================
  // 3.7. Local Path Launcher Plugin (本地路径快捷唤起与直达)
  // ==========================================
  function extractLocalPath(raw) {
    if (typeof raw !== "string") return null;
    let text = raw.trim();
    text = text.replace(/^[`"']+|[`"']+$/g, "").trim();
    if (!text || text.includes("\n") || text.length > 260) return null;

    // 1. file:/// 协议形式
    if (/^file:\/\/\/[a-zA-Z]:/i.test(text)) {
      let p = text.replace(/^file:\/\/\//i, "");
      try {
        p = decodeURIComponent(p);
      } catch (e) {}
      return p.replace(/\//g, "\\");
    }

    // Linux / 容器内绝对路径及 file:/// 形式
    if (/^file:\/\/\/(workspace|root|home|srv|volume\d+|tmp|var|opt|etc)\//i.test(text)) {
      let p = text.replace(/^file:\/\//i, "");
      try { p = decodeURIComponent(p); } catch (e) {}
      return p;
    }
    if (/^\/(workspace|root|home|srv|volume\d+|tmp|var|opt|etc)\//i.test(text)) {
      return text;
    }

    // 2. Windows 盘符路径：C:\... 或 C:/...
    if (/^[a-zA-Z]:[\\/]/i.test(text)) {
      return text.replace(/\//g, "\\");
    }

    // 3. Windows UNC 路径：\\server\share\... 或 //server/share/...
    if (/^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/i.test(text)) {
      return text.replace(/\//g, "\\");
    }

    return null;
  }

  function triggerSilentProtocol(url) {
    try {
      let frame = document.getElementById("pi-enh-protocol-frame");
      if (!frame) {
        frame = document.createElement("iframe");
        frame.id = "pi-enh-protocol-frame";
        frame.style.display = "none";
        document.body.appendChild(frame);
      }
      frame.src = url;
    } catch (err) {
      window.location.href = url;
    }
  }

  function flashPathBtn(btn, tempText, duration = 1200) {
    if (!btn.hasAttribute("data-orig-icon")) {
      btn.setAttribute("data-orig-icon", btn.innerHTML);
    }
    const orig = btn.getAttribute("data-orig-icon");
    btn.innerHTML = tempText || "✓";
    btn.classList.add("flashed");

    if (btn._flashTimer) clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      btn.innerHTML = orig;
      btn.classList.remove("flashed");
      btn.removeAttribute("data-orig-icon");
      btn._flashTimer = null;
    }, duration);
  }

  function normalizeToLocalFsPath(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.trim().replace(/^[`"']+|[`"']+$/g, "").trim();
    if (!s) return null;
    if (/^file:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        if (u.protocol === "file:") {
          let p = decodeURIComponent(u.pathname || "");
          if (u.hostname) return `//${u.hostname}${p.startsWith("/") ? p : "/" + p}`;
          if (/^\/[a-zA-Z]:\//.test(p)) return p.slice(1);
          return p;
        }
      } catch (e) {
        let p = s.replace(/^file:\/\/\//i, "/").replace(/^file:\/\//i, "/");
        try { p = decodeURIComponent(p); } catch (err) {}
        if (/^\/[a-zA-Z]:\//.test(p)) return p.slice(1);
        return p;
      }
    }
    const cleanNoQuery = s.split("#")[0].split("?")[0].trim();
    let decoded = cleanNoQuery;
    try { decoded = decodeURIComponent(cleanNoQuery); } catch (e) {}
    if (/^\/(workspace|root|home|srv|volume\d+|tmp|var|opt|etc)\//i.test(decoded)) {
      return decoded;
    }
    if (/^[a-zA-Z]:[\\/]/i.test(decoded)) {
      return decoded.replace(/\\/g, "/");
    }
    return null;
  }

  function getActiveSessionIdForFileApi() {
    try {
      if (typeof getCurrentSessionId === "function") {
        const sid = getCurrentSessionId();
        if (sid) return sid;
      }
      if (typeof window !== "undefined" && window.location?.search) {
        return new URLSearchParams(window.location.search).get("session") || "";
      }
    } catch (e) {}
    return "";
  }

  function buildLocalFileApiUrl(rawPath, explicitSessionId) {
    const fsPath = normalizeToLocalFsPath(rawPath);
    if (!fsPath) return null;
    const encodedSegments = fsPath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    if (!encodedSegments) return null;
    const sid = explicitSessionId !== undefined ? explicitSessionId : getActiveSessionIdForFileApi();
    return `/api/files/${encodedSegments}?type=read${sid ? `&sessionId=${encodeURIComponent(sid)}` : ""}`;
  }
  window.__PI_ENH_BUILD_LOCAL_FILE_API_URL__ = buildLocalFileApiUrl;

  const sessionMarkdownImageMapCache = new Map();

  async function fetchSessionMarkdownImages(sessionId) {
    if (!sessionId) return [];
    if (sessionMarkdownImageMapCache.has(sessionId)) {
      return sessionMarkdownImageMapCache.get(sessionId);
    }
    const promise = (async () => {
      try {
        const fetchFn = originalWindowFetch || (typeof fetch === "function" ? fetch : null);
        if (!fetchFn) return [];
        const res = await fetchFn(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
        if (!res || !res.ok) return [];
        const data = await res.json();
        const found = [];
        const regex = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
        const scanText = (txt) => {
          if (typeof txt !== "string" || !txt.includes("![")) return;
          let m;
          regex.lastIndex = 0;
          while ((m = regex.exec(txt)) !== null) {
            const alt = (m[1] || "").trim();
            const rawUrl = (m[2] || "").trim();
            const apiUrl = buildLocalFileApiUrl(rawUrl, sessionId);
            if (apiUrl) {
              found.push({ alt, rawUrl, apiUrl });
            }
          }
        };
        const walk = (obj) => {
          if (!obj) return;
          if (typeof obj === "string") {
            scanText(obj);
          } else if (Array.isArray(obj)) {
            for (const item of obj) walk(item);
          } else if (typeof obj === "object") {
            for (const val of Object.values(obj)) walk(val);
          }
        };
        walk(data);
        return found;
      } catch (e) {
        return [];
      }
    })();
    sessionMarkdownImageMapCache.set(sessionId, promise);
    return promise;
  }

  function syncLocalMarkdownImages() {
    if (!document.querySelectorAll) return;
    const sid = getActiveSessionIdForFileApi();
    const imgs = document.querySelectorAll(
      ".markdown-body img:not([data-pi-img-resolved]), [data-chat-scroll-container] img:not([data-pi-img-resolved]), main img:not([data-pi-img-resolved])"
    );
    for (const img of imgs) {
      const rawSrc = (img.getAttribute("src") || "").trim();
      if (rawSrc) {
        if (rawSrc.startsWith("/api/files/")) {
          if (sid && !rawSrc.includes("sessionId=")) {
            const sep = rawSrc.includes("?") ? "&" : "?";
            img.setAttribute("src", `${rawSrc}${sep}sessionId=${encodeURIComponent(sid)}`);
          }
          img.setAttribute("data-pi-img-resolved", "true");
          continue;
        }
        const mappedUrl = buildLocalFileApiUrl(rawSrc, sid);
        if (mappedUrl) {
          img.setAttribute("data-orig-src", rawSrc);
          img.setAttribute("src", mappedUrl);
          img.setAttribute("data-pi-img-resolved", "true");
          continue;
        }
        if (/^(https?:|data:|blob:)/i.test(rawSrc)) {
          img.setAttribute("data-pi-img-resolved", "true");
          continue;
        }
      }

      // 若 src 为空（被旧版 rehype-sanitize 剥离了 file:/// 的 src）
      if (!rawSrc) {
        const container = img.closest?.(".markdown-body") || img.parentElement;
        let recoveredUrl = null;
        if (container && typeof container.querySelectorAll === "function") {
          const links = container.querySelectorAll("a[href]");
          for (const a of links) {
            const href = (a.getAttribute("href") || "").trim();
            const cleanHref = href.split("?")[0].split("#")[0];
            if (/\.(png|jpg|jpeg|gif|webp|svg|bmp|avif)$/i.test(cleanHref)) {
              const apiUrl = buildLocalFileApiUrl(href, sid);
              if (apiUrl) {
                recoveredUrl = apiUrl;
                break;
              }
            }
          }
        }
        if (recoveredUrl) {
          img.setAttribute("src", recoveredUrl);
          img.setAttribute("data-pi-img-resolved", "true");
          continue;
        }
        if (sid && !img.hasAttribute("data-pi-img-fetching")) {
          img.setAttribute("data-pi-img-fetching", "true");
          const altText = (img.getAttribute("alt") || "").trim();
          fetchSessionMarkdownImages(sid).then((list) => {
            if (!Array.isArray(list) || list.length === 0) return;
            const match = (altText && list.find((item) => item.alt === altText)) || list[list.length - 1];
            if (match && match.apiUrl && !img.getAttribute("src")) {
              img.setAttribute("src", match.apiUrl);
              img.setAttribute("data-pi-img-resolved", "true");
            }
          });
        }
      }
    }
  }

  function syncLocalPathLauncher() {
    if (!isPluginEnabled("local-path-launcher")) {
      removeLocalPathLauncher();
      return;
    }

    syncLocalMarkdownImages();

    // 1. 立即清理任何误入右侧文件预览面板、设置弹窗或侧边栏的历史遗留 actions 元素
    const leakedActions = document.querySelectorAll(
      "#file-panel .pi-enh-path-actions, .file-viewer-shell .pi-enh-path-actions, .markdown-file-preview .pi-enh-path-actions, [data-panel='file'] .pi-enh-path-actions, #session-sidebar .pi-enh-path-actions, [role='dialog'] .pi-enh-path-actions"
    );
    for (const leaked of leakedActions) {
      leaked.remove();
    }

    // 2. 严格限制扫描范围：仅作用于聊天消息区域（.chat-content）内的行内代码块，绝对排除右侧文件预览
    const chatContainer = document.querySelector(".chat-content");
    if (!chatContainer) return;

    const codeElements = chatContainer.querySelectorAll("code:not([data-pi-path-enhanced])");
    for (const code of codeElements) {
      // 立即打上处理标记，杜绝每次轮询都把数百个非路径 code 块重新扫描一遍！
      code.setAttribute("data-pi-path-enhanced", "true");

      // 绝对排除右侧面板、代码块 (pre code)、输入框及模态框
      if (code.closest("#file-panel, .file-viewer-shell, .markdown-file-preview, [data-panel='file'], pre, [data-pi-native-composer-host], [role='dialog']")) {
        continue;
      }

      const text = code.textContent || "";
      const cleanPath = extractLocalPath(text);
      if (!cleanPath) continue;

      // 3. 强力防重复检查：若其相邻下一个兄弟元素已经是 .pi-enh-path-actions，直接更新路径并跳过插入
      const nextEl = code.nextElementSibling;
      if (nextEl && nextEl.classList.contains("pi-enh-path-actions")) {
        nextEl.setAttribute("data-path", cleanPath);
        continue;
      }

      // 4. 若父容器内当前 code 后面紧邻包含旧 actions，先更新以防累积
      let sibling = code.nextSibling;
      while (sibling && sibling.nodeType === 3 && !sibling.textContent.trim()) {
        sibling = sibling.nextSibling;
      }
      if (sibling && sibling.nodeType === 1 && sibling.classList?.contains("pi-enh-path-actions")) {
        sibling.setAttribute("data-path", cleanPath);
        continue;
      }

      const actionsSpan = document.createElement("span");
      actionsSpan.className = "pi-enh-path-actions";
      actionsSpan.setAttribute("data-path", cleanPath);
      actionsSpan.setAttribute("title", `本地路径: ${cleanPath}`);

      const viewBtn = document.createElement("button");
      viewBtn.type = "button";
      viewBtn.className = "pi-enh-path-btn pi-enh-path-view";
      viewBtn.setAttribute("title", "在右侧文件窗口中打开浏览 (View in Right Panel)");
      viewBtn.setAttribute("data-act", "view");
      viewBtn.innerHTML = "👁️";

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "pi-enh-path-btn pi-enh-path-open";
      openBtn.setAttribute("title", "在 Windows 资源管理器中打开并定位 (Open in Explorer)");
      openBtn.setAttribute("data-act", "open");
      openBtn.innerHTML = "📂";

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "pi-enh-path-btn pi-enh-path-copy";
      copyBtn.setAttribute("title", "复制 Windows 本地绝对路径 (Copy Path)");
      copyBtn.setAttribute("data-act", "copy");
      copyBtn.innerHTML = "📋";

      actionsSpan.appendChild(viewBtn);
      actionsSpan.appendChild(openBtn);
      actionsSpan.appendChild(copyBtn);

      if (typeof code.after === "function") {
        code.after(actionsSpan);
      } else if (code.parentElement) {
        code.parentElement.insertBefore(actionsSpan, code.nextSibling || null);
      }
    }
  }

  function removeLocalPathLauncher() {
    for (const el of document.querySelectorAll(".pi-enh-path-actions")) {
      el.remove();
    }
    for (const code of document.querySelectorAll("[data-pi-path-enhanced]")) {
      code.removeAttribute("data-pi-path-enhanced");
    }
  }

  function onLocalPathClick(e) {
    const btn = e.target && typeof e.target.closest === "function" ? e.target.closest(".pi-enh-path-btn") : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    const container = btn.closest(".pi-enh-path-actions");
    const rawPath = container ? container.getAttribute("data-path") : null;
    if (!rawPath) return;

    const act = btn.getAttribute("data-act") || (
      btn.classList.contains("pi-enh-path-open") ? "open" : "copy"
    );

    if (act === "copy") {
      copyText(rawPath, "已复制本地路径: " + rawPath);
      flashPathBtn(btn, "✓");
    } else if (act === "view") {
      flashPathBtn(btn, "✓", 800);
      openFileInRightViewer(rawPath);
    } else if (act === "open") {
      flashPathBtn(btn, "⏳", 4000);
      // 优先通过本地免确认 HTTP 桥接直开资源管理器，彻底避免浏览器外部协议确认弹窗
      fetch("http://127.0.0.1:30149/open?path=" + encodeURIComponent(rawPath), {
        method: "GET",
        mode: "cors",
      })
        .then((res) => {
          if (res.ok) {
            flashPathBtn(btn, "✓", 1200);
            showToast("已打开 Windows 资源管理器并定位");
          } else {
            throw new Error("Bridge status " + res.status);
          }
        })
        .catch(() => {
          // 兜底降级方案：调用系统注册协议
          const piOpenUrl = "pi-open://" + encodeURIComponent(rawPath);
          triggerSilentProtocol(piOpenUrl);
          flashPathBtn(btn, "✓", 1200);
          showToast("已调起 Windows 资源管理器");
        });
    }
  }

  addManagedListener(document, "click", onLocalPathClick);

  // ==========================================
  // 3.8. Obsidian & Markdown Viewer Plugin (Obsidian 笔记与 Markdown 预览增强)
  // ==========================================
  async function handleObsidianFileFetch(input, init, urlStr, activeFetch) {
    if (!isPluginEnabled("obsidian-markdown-viewer")) return null;

    const baseOrigin = (typeof window !== "undefined" && window.location?.origin) ||
      (typeof window !== "undefined" && window.location?.href) ||
      "http://127.0.0.1:30141";

    let parsedUrl;
    try {
      parsedUrl = new URL(urlStr, baseOrigin);
    } catch (e) {
      return null;
    }

    const pathname = parsedUrl.pathname;
    if (!pathname.startsWith("/api/files/")) return null;

    const rawPath = pathname.slice("/api/files/".length);
    if (!rawPath) return null;

    const reqType = parsedUrl.searchParams.get("type") || "list";
    if (reqType !== "read" && reqType !== "meta" && reqType !== "download") {
      return null;
    }

    let candidatePath = "";
    try {
      candidatePath = decodeURIComponent(rawPath);
    } catch (e) {
      candidatePath = rawPath;
    }

    // 智能识别外部 UNC / 群晖共享 / 知识库路径
    const isUncOrObsidian = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+)[\\/]/.test(candidatePath)
      || /^(\\\\|\/\/)/.test(candidatePath)
      || candidatePath.includes("Obsidian");

    if (isUncOrObsidian) {
      if (/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+)[\\/]/.test(candidatePath)) {
        candidatePath = "\\\\" + candidatePath.replace(/\//g, "\\");
      } else if (/^[a-zA-Z]:[\\/]/.test(candidatePath)) {
        candidatePath = candidatePath.replace(/\//g, "\\");
      }

      // 针对明确外部 UNC 路径直接由本地高速桥接服务（30149）读取，避开原生后端超时挂起
      try {
        const rawFetch = originalWindowFetch || (typeof fetch === "function" ? fetch : activeFetch);
        const bridgeUrl = `http://127.0.0.1:30149/read-file?path=${encodeURIComponent(candidatePath)}`;
        const bridgeResp = await rawFetch(bridgeUrl, {
          method: "GET",
          mode: "cors"
        });

        if (bridgeResp && bridgeResp.ok) {
          const bridgeData = await bridgeResp.json();
          if (bridgeData && bridgeData.ok) {
            const lang = bridgeData.language || "markdown";

            if (reqType === "read") {
              const payload = {
                content: bridgeData.content,
                nextOffset: bridgeData.size,
                truncated: false,
                language: lang,
                size: bridgeData.size
              };
              return new Response(JSON.stringify(payload), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              });
            }

            if (reqType === "meta") {
              const payload = {
                size: bridgeData.size,
                language: lang,
                mime: lang === "markdown" ? "text/markdown" : "text/plain",
                previewKind: null
              };
              return new Response(JSON.stringify(payload), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              });
            }

            if (reqType === "download") {
              const filename = candidatePath.split(/[\\/]/).pop() || "note.md";
              return new Response(bridgeData.content, {
                status: 200,
                headers: {
                  "Content-Type": "text/markdown; charset=utf-8",
                  "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`
                }
              });
            }
          }
        }
      } catch (err) {}
    }

    // 非明确外部路径：优先让原生后端尝试
    let nativeResp = null;
    try {
      nativeResp = await activeFetch(input, init);
    } catch (e) {}

    // 若原生能正常读取（HTTP 200），直接使用原生响应
    if (nativeResp && nativeResp.ok) {
      return nativeResp;
    }

    // 原生失败（403 Access denied、404 等），尝试通过本地桥接服务（30149）二次兜底读取
    if (!isUncOrObsidian) {
      if (/^[a-zA-Z]:[\\/]/.test(candidatePath)) {
        candidatePath = candidatePath.replace(/\//g, "\\");
      }

      try {
        const rawFetch = originalWindowFetch || (typeof fetch === "function" ? fetch : activeFetch);
        const bridgeUrl = `http://127.0.0.1:30149/read-file?path=${encodeURIComponent(candidatePath)}`;
        const bridgeResp = await rawFetch(bridgeUrl, {
          method: "GET",
          mode: "cors"
        });

        if (bridgeResp && bridgeResp.ok) {
          const bridgeData = await bridgeResp.json();
          if (bridgeData && bridgeData.ok) {
            const lang = bridgeData.language || "markdown";

            if (reqType === "read") {
              const payload = {
                content: bridgeData.content,
                nextOffset: bridgeData.size,
                truncated: false,
                language: lang,
                size: bridgeData.size
              };
              return new Response(JSON.stringify(payload), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              });
            }

            if (reqType === "meta") {
              const payload = {
                size: bridgeData.size,
                language: lang,
                mime: lang === "markdown" ? "text/markdown" : "text/plain",
                previewKind: null
              };
              return new Response(JSON.stringify(payload), {
                status: 200,
                headers: { "Content-Type": "application/json" }
              });
            }
          }
        }
      } catch (err) {}
    }

    return nativeResp;
  }

  function syncMarkdownViewerMode() {
    const enabled = isPluginEnabled("obsidian-markdown-viewer");
    window.dispatchEvent(new CustomEvent("pi:obsidian-markdown-viewer-preferences-change", {
      detail: { enabled },
    }));
  }

  // 全局直达文件浏览窗口（点击链接直接在右侧浏览窗口查看）
  cachedNativeOnOpenFile = null;

  function findNativeOnOpenFile() {
    if (typeof cachedNativeOnOpenFile === "function") return cachedNativeOnOpenFile;
    const candidates = [
      document.getElementById("session-sidebar"),
      document.getElementById("file-panel"),
      document.querySelector(".sidebar-container"),
      document.querySelector(".right-panel-container"),
      document.body,
    ].filter(Boolean);

    for (const root of candidates) {
      const els = [root, ...Array.from(root.querySelectorAll("*"))];
      for (const el of els) {
        for (const k in el) {
          if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) {
            let fiber = el[k];
            while (fiber) {
              const fn = fiber.memoizedProps?.onOpenFile || fiber.pendingProps?.onOpenFile;
              if (typeof fn === "function") {
                cachedNativeOnOpenFile = fn;
                return fn;
              }
              fiber = fiber.return;
            }
          }
        }
      }
    }
    return null;
  }

  function openFileInRightViewer(rawPath) {
    if (!rawPath || typeof rawPath !== "string") return false;
    let cleanPath = rawPath.trim();
    if (cleanPath.startsWith("file:///")) {
      cleanPath = cleanPath.slice("file://".length);
      try { cleanPath = decodeURIComponent(cleanPath); } catch (e) {}
    } else if (cleanPath.startsWith("file://")) {
      cleanPath = cleanPath.slice("file:/".length);
      try { cleanPath = decodeURIComponent(cleanPath); } catch (e) {}
    }

    const onOpenFile = findNativeOnOpenFile();
    const fileName = cleanPath.split("/").pop() || cleanPath.split("\\").pop() || cleanPath;

    if (typeof onOpenFile === "function") {
      try {
        onOpenFile(cleanPath, fileName);
        setTimeout(() => {
          if (!isFilePanelOpen()) {
            openFilePanel();
          }
        }, 150);
        return true;
      } catch (e) {}
    }

    openFilePanel();
    return false;
  }
  window.__PI_ENH_OPEN_FILE_IN_RIGHT_VIEWER__ = openFileInRightViewer;

  // 原生 MarkdownBody 已负责普通文件链接；兼容层只处理自己生成的文件控件。
  function onLegacyFileLinkClick(e) {
    if (e.defaultPrevented || e.button !== 0 || e.shiftKey || e.altKey) return;
    const a = e.target?.closest?.(".pi-enh-file-link, [data-file-path]");
    if (!a) return;
    const rawPath = a.getAttribute("data-file-path");
    const href = rawPath || a.getAttribute("href") || "";
    if (!href || /^https?:/i.test(href)) return;
    const filePath = rawPath || normalizeToLocalFsPath(href);
    if (!filePath) return;
    e.preventDefault();
    e.stopPropagation();
    openFileInRightViewer(filePath);
  }
  addManagedListener(document, "click", onLegacyFileLinkClick, true);

  // FileViewer calls this after its native content commits; no full-page observer is added.
  window.__PI_ENH_SYNC_FILE_VIEWER__ = () => {
    if (isDisposed) return;
    executeSyncStep(syncMarkdownViewerMode);
    executeSyncStep(syncExcelViewerMode);
  };

  function checkAndAutoRecoverAccessDenied() {
    if (!isPluginEnabled("obsidian-markdown-viewer")) return;

    const errorDivs = Array.from(document.querySelectorAll('div[style*="#f87171"], div[style*="rgb(248, 113, 113)"]'));
    const accessDeniedDiv = errorDivs.find((d) => /Access denied/i.test(d.textContent || ""));
    if (!accessDeniedDiv) return;

    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
    const tabTitle = activeTab?.querySelector("span[title]")?.getAttribute("title") || "";
    if (!tabTitle) return;

    if (/\.md$/i.test(tabTitle) || /\.markdown$/i.test(tabTitle) || tabTitle.includes("Obsidian")) {
      if (accessDeniedDiv.__piRecoverAttempted) return;
      accessDeniedDiv.__piRecoverAttempted = true;

      accessDeniedDiv.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:24px;color:var(--text-muted);font-size:13px;">
          <span>🔄 正在通过安全本地通道自愈加载知识库笔记...</span>
          <button type="button" class="pi-enh-btn-sm" style="padding:4px 12px;font-size:12px;cursor:pointer;">点击重新加载</button>
        </div>
      `;

      const btn = accessDeniedDiv.querySelector("button");
      if (btn) {
        btn.addEventListener("click", () => {
          if (activeTab) activeTab.click();
        });
      }

      setTimeout(() => {
        if (activeTab) activeTab.click();
      }, 300);
    }
  }

  function removeMarkdownViewerEnhancements() {
    window.dispatchEvent(new CustomEvent("pi:obsidian-markdown-viewer-preferences-change", {
      detail: { enabled: false },
    }));
  }

  // ==========================================================================
  // Excel Sheet Interactive Preview (Excel 在线交互表格预览)
  // ==========================================================================
  let activeExcelViewerPath = null;
  let excelUserExplicitSourcePaths = new Set();
  let excelWorkbookCache = new Map(); // path -> { workbook, activeSheet, searchQuery, loading, error }
  function getXlsxEngine() {
    return window.XLSX && typeof window.XLSX.read === "function" ? window.XLSX : null;
  }

  function ensureXlsxEngine() {
    return window.__PI_ENH_LOAD_OPTIONAL__("xlsx-engine");
  }

  function getExcelColName(idx) {
    let name = "";
    let n = idx;
    while (n >= 0) {
      name = String.fromCharCode((n % 26) + 65) + name;
      n = Math.floor(n / 26) - 1;
    }
    return name;
  }

  function formatExcelCellValue(val) {
    if (val == null || val === "") return "";
    if (val instanceof Date) {
      const y = val.getFullYear();
      const m = String(val.getMonth() + 1).padStart(2, "0");
      const d = String(val.getDate()).padStart(2, "0");
      return y + "-" + m + "-" + d;
    }
    if (typeof val === "number") {
      return String(val);
    }
    return String(val);
  }

  function syncExcelViewerMode() {
    if (!isPluginEnabled("excel-sheet-preview")) {
      removeExcelViewerEnhancements();
      return;
    }

    const viewerShell = document.querySelector(".file-viewer-shell");
    if (!viewerShell) {
      activeExcelViewerPath = null;
      return;
    }

    const pathEl = viewerShell.querySelector(".file-viewer-path");
    const rawPath = pathEl?.getAttribute("title") || pathEl?.textContent || "";
    const cleanPath = (rawPath || "").trim();
    const isExcel = /\.(xlsx|xls|csv|tsv)$/i.test(cleanPath);

    if (!isExcel) {
      removeExcelViewerEnhancements();
      activeExcelViewerPath = null;
      return;
    }

    // 用户显式要求查看纯文本源码
    if (excelUserExplicitSourcePaths.has(cleanPath)) {
      const container = viewerShell.querySelector(".pi-enh-excel-container");
      if (container) container.style.display = "none";
      const nativeContent = viewerShell.querySelector(".file-viewer-content");
      if (nativeContent) nativeContent.style.display = "";
      decorateExcelSourceSwitcher(viewerShell, cleanPath);
      return;
    }

    // 隐藏原生纯文本容器（避免乱码闪烁）
    const nativeContent = viewerShell.querySelector(".file-viewer-content");
    if (nativeContent && nativeContent.style.display !== "none") {
      nativeContent.style.display = "none";
    }

    // 检查缓存状态
    let state = excelWorkbookCache.get(cleanPath);
    if (!state) {
      state = { workbook: null, activeSheet: "", searchQuery: "", loading: true, error: null };
      excelWorkbookCache.set(cleanPath, state);
      loadExcelWorkbook(cleanPath, viewerShell);
    }

    renderExcelViewer(viewerShell, cleanPath);
  }

  function loadExcelWorkbook(filePath, viewerShell) {
    const encoded = encodeURIComponent(filePath.replace(/^[\\/]+/, ""));
    const downloadUrl = "/api/files/" + encoded + "?type=download";

    fetch(downloadUrl)
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
        return res.arrayBuffer();
      })
      .then(async (buf) => {
        const XLSX = await ensureXlsxEngine();
        if (!XLSX) throw new Error("Excel 解析引擎初始化失败");
        const isCsv = /\.csv$/i.test(filePath);
        const readOpts = isCsv ? { type: "array" } : { type: "array", cellStyles: true, cellDates: true };
        const wb = XLSX.read(new Uint8Array(buf), readOpts);
        const state = excelWorkbookCache.get(filePath) || {};
        state.workbook = wb;
        state.activeSheet = (wb.SheetNames && wb.SheetNames[0]) || "Sheet1";
        state.loading = false;
        state.error = null;
        excelWorkbookCache.set(filePath, state);
        renderExcelViewer(viewerShell, filePath);
      })
      .catch((err) => {
        console.error("[pi-enh-excel] 加载解析失败:", err);
        const state = excelWorkbookCache.get(filePath) || {};
        state.loading = false;
        state.error = err.message || "文件读取解析失败";
        excelWorkbookCache.set(filePath, state);
        renderExcelViewer(viewerShell, filePath);
      });
  }

  function renderExcelViewer(viewerShell, filePath) {
    let container = viewerShell.querySelector(".pi-enh-excel-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "pi-enh-excel-container";
      viewerShell.appendChild(container);
    }
    container.style.display = "flex";

    const state = excelWorkbookCache.get(filePath) || { loading: true };

    if (state.loading) {
      container.innerHTML = `
        <div class="pi-enh-excel-status-spinner">
          <div style="font-size:22px;animation:spin 1s linear infinite;">⏳</div>
          <div>正在解析 Excel 表格数据...</div>
        </div>
      `;
      return;
    }

    if (state.error || !state.workbook) {
      container.innerHTML = `
        <div class="pi-enh-excel-status-spinner">
          <div style="font-size:22px;">⚠️</div>
          <div style="color:#f87171;">无法解析该表格: ${escapeHtml(state.error || "未知格式")}</div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button type="button" class="pi-enh-excel-btn" data-action="retry">重新加载</button>
            <button type="button" class="pi-enh-excel-btn" data-action="source">查看原始文本</button>
          </div>
        </div>
      `;
      container.querySelector('[data-action="retry"]')?.addEventListener("click", () => {
        excelWorkbookCache.delete(filePath);
        syncExcelViewerMode();
      });
      container.querySelector('[data-action="source"]')?.addEventListener("click", () => {
        excelUserExplicitSourcePaths.add(filePath);
        syncExcelViewerMode();
      });
      return;
    }

    const wb = state.workbook;
    const sheetNames = wb.SheetNames || [];
    const activeSheetName = state.activeSheet || sheetNames[0] || "";
    const sheet = wb.Sheets[activeSheetName] || {};

    const XLSX = getXlsxEngine();
    const rows = XLSX ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) : [];
    const totalRows = rows.length;
    let maxCols = 0;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].length > maxCols) maxCols = rows[i].length;
    }
    if (maxCols === 0 && totalRows === 0) maxCols = 5;

    // 解析合并单元格 (Merges)
    const merges = sheet["!merges"] || [];
    const mergeMap = new Map(); // "r,c" -> { rowSpan, colSpan, skip }
    for (const m of merges) {
      const sR = m.s.r;
      const sC = m.s.c;
      const eR = m.e.r;
      const eC = m.e.c;
      mergeMap.set(sR + "," + sC, { rowSpan: eR - sR + 1, colSpan: eC - sC + 1, skip: false });
      for (let r = sR; r <= eR; r++) {
        for (let c = sC; c <= eC; c++) {
          if (r !== sR || c !== sC) {
            mergeMap.set(r + "," + c, { skip: true });
          }
        }
      }
    }

    const ext = (filePath.split(".").pop() || "xlsx").toUpperCase();
    const query = (state.searchQuery || "").trim().toLowerCase();

    // 构造 HTML
    let tableHtml = '<table class="pi-enh-excel-table"><thead><tr><th class="pi-enh-excel-th pi-enh-excel-corner"></th>';
    for (let c = 0; c < maxCols; c++) {
      tableHtml += `<th class="pi-enh-excel-th">${getExcelColName(c)}</th>`;
    }
    tableHtml += '</tr></thead><tbody>';

    let matchCount = 0;
    const maxRenderRows = Math.min(totalRows, 1500); // 性能保护：首屏最多渲染1500行
    for (let r = 0; r < maxRenderRows; r++) {
      const rowData = rows[r] || [];
      tableHtml += `<tr class="pi-enh-excel-tr"><td class="pi-enh-excel-row-num">${r + 1}</td>`;
      for (let c = 0; c < maxCols; c++) {
        const mInfo = mergeMap.get(r + "," + c);
        if (mInfo && mInfo.skip) continue;

        const val = rowData[c];
        const strVal = formatExcelCellValue(val);
        const isNum = typeof val === "number" && !isNaN(val);
        const isDate = val instanceof Date;

        let isMatch = false;
        if (query && strVal && strVal.toLowerCase().includes(query)) {
          isMatch = true;
          matchCount++;
        }

        const cls = ["pi-enh-excel-td"];
        if (isNum) cls.push("num");
        if (isDate) cls.push("date");
        if (isMatch) cls.push("is-match");

        let spanAttr = "";
        if (mInfo && mInfo.rowSpan > 1) spanAttr += ` rowspan="${mInfo.rowSpan}"`;
        if (mInfo && mInfo.colSpan > 1) spanAttr += ` colspan="${mInfo.colSpan}"`;

        tableHtml += `<td class="${cls.join(" ")}" data-r="${r}" data-c="${c}" title="${escapeHtml(strVal)}"${spanAttr}>${escapeHtml(strVal)}</td>`;
      }
      tableHtml += '</tr>';
    }
    if (totalRows > maxRenderRows) {
      tableHtml += `<tr><td colspan="${maxCols + 1}" style="text-align:center;padding:12px;color:var(--text-dim);font-size:11px;">⚠️ 已显示前 ${maxRenderRows} 行，更多行请下载原件查看</td></tr>`;
    }
    tableHtml += '</tbody></table>';

    // 构造底栏 Sheet 切换 Tabs
    let tabsHtml = '';
    if (sheetNames.length > 0) {
      tabsHtml += '<div class="pi-enh-excel-bottom-bar">';
      for (const name of sheetNames) {
        const isActive = name === activeSheetName;
        tabsHtml += `<button type="button" class="pi-enh-excel-tab ${isActive ? "is-active" : ""}" data-sheet="${escapeHtml(name)}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.75;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>${escapeHtml(name)}</button>`;
      }
      tabsHtml += '</div>';
    }

    container.innerHTML = `
      <div class="pi-enh-excel-toolbar">
        <span class="pi-enh-excel-badge">${ext}</span>
        <span class="pi-enh-excel-meta" title="${escapeHtml(activeSheetName)}">
          ${escapeHtml(activeSheetName)} · ${totalRows} 行 × ${maxCols} 列 ${sheetNames.length > 1 ? "(" + sheetNames.length + "个工作表)" : ""}
        </span>
        <div class="pi-enh-excel-search">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6;flex-shrink:0;"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <input type="text" placeholder="搜索单元格..." value="${escapeHtml(state.searchQuery || "")}" />
          ${query ? `<span style="font-size:10px;color:#34d399;flex-shrink:0;">${matchCount}项</span>` : ""}
        </div>
        <button type="button" class="pi-enh-excel-btn" data-action="copy" title="复制当前工作表为TSV表格"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>复制数据</button>
        <button type="button" class="pi-enh-excel-btn" data-action="download" title="下载原文件"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>下载原件</button>
        <button type="button" class="pi-enh-excel-btn" data-action="toggle-source" title="切换到纯文本源码查看"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>文本源码</button>
      </div>
      <div class="pi-enh-excel-grid-wrap">
        ${tableHtml}
      </div>
      ${tabsHtml}
    `;

    // 绑定事件：搜索输入
    const searchInput = container.querySelector(".pi-enh-excel-search input");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        state.searchQuery = e.target.value || "";
        renderExcelViewer(viewerShell, filePath);
      });
      if (state.searchQuery) {
        searchInput.focus();
        searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
      }
    }

    // 绑定事件：复制工作表 TSV
    container.querySelector('[data-action="copy"]')?.addEventListener("click", () => {
      try {
        const tsv = rows.map((r) => (r || []).map((v) => formatExcelCellValue(v).replace(/\t/g, " ")).join("\t")).join("\n");
        navigator.clipboard.writeText(tsv);
        showToast("已复制当前工作表数据至剪贴板", null, 1800);
      } catch (e) {
        showToast("复制失败", null, 1800);
      }
    });

    // 绑定事件：下载原件
    container.querySelector('[data-action="download"]')?.addEventListener("click", () => {
      const encoded = encodeURIComponent(filePath.replace(/^[\\/]+/, ""));
      const a = document.createElement("a");
      a.href = "/api/files/" + encoded + "?type=download";
      a.download = filePath.split("/").pop() || "download.xlsx";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    // 绑定事件：切换到文本源码
    container.querySelector('[data-action="toggle-source"]')?.addEventListener("click", () => {
      excelUserExplicitSourcePaths.add(filePath);
      syncExcelViewerMode();
    });

    // 绑定事件：切换工作表 Tab
    for (const tabBtn of container.querySelectorAll(".pi-enh-excel-tab")) {
      tabBtn.addEventListener("click", () => {
        const targetSheet = tabBtn.getAttribute("data-sheet");
        if (targetSheet && targetSheet !== state.activeSheet) {
          state.activeSheet = targetSheet;
          state.searchQuery = "";
          renderExcelViewer(viewerShell, filePath);
        }
      });
    }

    // 绑定事件：单元格点击高亮
    container.querySelector(".pi-enh-excel-grid-wrap")?.addEventListener("click", (e) => {
      const cell = e.target?.closest?.(".pi-enh-excel-td");
      if (cell) {
        container.querySelectorAll(".pi-enh-excel-td.is-selected").forEach((el) => el.classList.remove("is-selected"));
        cell.classList.add("is-selected");
      }
    });
  }

  function decorateExcelSourceSwitcher(viewerShell, filePath) {
    let customBtn = viewerShell.querySelector(".pi-enh-excel-switch-btn");
    if (!customBtn) {
      const controls = viewerShell.querySelector(".file-viewer-controls") || viewerShell.querySelector(".file-viewer-toolbar");
      if (!controls) return;
      customBtn = document.createElement("button");
      customBtn.type = "button";
      customBtn.className = "pi-enh-excel-switch-btn pi-enh-excel-btn";
      customBtn.innerHTML = "📊 表格预览";
      customBtn.title = "返回 Excel 交互表格预览";
      customBtn.style.marginLeft = "6px";
      customBtn.addEventListener("click", () => {
        excelUserExplicitSourcePaths.delete(filePath);
        syncExcelViewerMode();
      });
      controls.appendChild(customBtn);
    }
  }

  function removeExcelViewerEnhancements() {
    for (const el of document.querySelectorAll(".pi-enh-excel-container")) {
      el.remove();
    }
    for (const el of document.querySelectorAll(".pi-enh-excel-switch-btn")) {
      el.remove();
    }
    const nativeContent = document.querySelector(".file-viewer-shell .file-viewer-content");
    if (nativeContent && nativeContent.style.display === "none") {
      nativeContent.style.display = "";
    }
    activeExcelViewerPath = null;
  }


  addManagedListener(document, "click", (e) => {
    const link = e.target?.closest?.("a, [role='tab'], .file-viewer-mode-button");
    if (link) {
      if (link.tagName === "A" && (link.getAttribute("href")?.includes("/session/") || link.getAttribute("href") === "/")) {
        queueMicrotask(() => {
          if (isDisposed) return;
          syncComposerMarkdownFormat();
          syncComposerModes();
        });
      }
      if (!isDisposed) {
        addManagedTimeout(scheduleDomSync, 50);
        addManagedTimeout(scheduleDomSync, 300);
        addManagedTimeout(scheduleDomSync, 800);
      }
    }
  });
