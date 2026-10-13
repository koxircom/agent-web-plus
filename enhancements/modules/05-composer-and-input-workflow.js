  // ==========================================
  // 2.6 AI Quick Actions (同轮 AI 结构化选择 + 安全兜底)
  // ==========================================
  const QUICK_ACTIONS_BRIDGE_URL = "http://127.0.0.1:30149/quick-actions";
  function getQuickActionsBridgeUrl() {
    if (typeof window === "undefined" || !window.location) return QUICK_ACTIONS_BRIDGE_URL;
    // Only the Windows desktop ships the local quick-actions bridge; Macs persist locally.
    if (typeof navigator !== "undefined" && !/Win/i.test(navigator.platform || "")) return null;
    const host = window.location.hostname;
    if (!host) return QUICK_ACTIONS_BRIDGE_URL;
    if (host !== "127.0.0.1" && host !== "localhost") return null;
    return QUICK_ACTIONS_BRIDGE_URL;
  }
  const QUICK_ACTIONS_STORAGE_KEY = "pi-enh-ai-quick-actions-v1";
  const QUICK_ACTIONS_DRAFT_STORAGE_KEY = "pi-enh-ai-quick-actions-draft-v1";
  const QUICK_ACTIONS_TOOL_NAME = "select_quick_action";
  const QUICK_ACTIONS_MAX_ITEMS = 12;
  const QUICK_ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
  const DEFAULT_QUICK_ACTIONS_CONFIG = {
    schemaVersion: 1,
    revision: 1,
    enabled: true,
    actions: [
      {
        id: "install-production",
        label: "安装到正式版",
        message: "安装到正式版",
        condition: "测试版、候选版或临时环境已经验证完成，但正式版或生产环境尚未更新，可以进入正式发布阶段。",
        mode: "send",
        priority: 100,
        enabled: true,
      },
      {
        id: "start-implementation",
        label: "开始实施",
        message: "开始实施",
        condition: "方案已经明确并等待用户批准，可以开始实施。",
        mode: "send",
        priority: 50,
        enabled: true,
      },
    ],
  };

  function cloneQuickAction(action) {
    return {
      id: action.id,
      label: action.label,
      message: action.message,
      condition: action.condition,
      mode: action.mode,
      priority: action.priority,
      enabled: action.enabled,
    };
  }

  function cloneQuickActionsConfig(config) {
    return {
      schemaVersion: 1,
      revision: config.revision,
      enabled: config.enabled,
      actions: config.actions.map(cloneQuickAction),
    };
  }

  function normalizeQuickAction(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const allowed = ["id", "label", "message", "condition", "mode", "priority", "enabled"];
    const keys = Object.keys(value);
    if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) return null;
    const validText = (text, max) => typeof text === "string" && text.trim() && [...text].length <= max;
    if (!validText(value.id, 64) || !QUICK_ACTION_ID_RE.test(value.id)) return null;
    if (!validText(value.label, 24) || !validText(value.message, 200) || !validText(value.condition, 500)) return null;
    if (value.mode !== "send" && value.mode !== "fill") return null;
    if (!Number.isSafeInteger(value.priority) || typeof value.enabled !== "boolean") return null;
    return cloneQuickAction(value);
  }

  function normalizeQuickActionsConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const allowed = ["schemaVersion", "revision", "enabled", "actions"];
    const keys = Object.keys(value);
    if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) return null;
    if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.enabled !== "boolean") return null;
    if (!Array.isArray(value.actions) || value.actions.length > QUICK_ACTIONS_MAX_ITEMS) return null;
    const actions = [];
    const ids = new Set();
    for (const candidate of value.actions) {
      const action = normalizeQuickAction(candidate);
      if (!action || ids.has(action.id)) return null;
      ids.add(action.id);
      actions.push(action);
    }
    return { schemaVersion: 1, revision: value.revision, enabled: value.enabled, actions };
  }

  function readCachedQuickActionsConfig() {
    try {
      const cached = normalizeQuickActionsConfig(JSON.parse(localStorage.getItem(QUICK_ACTIONS_STORAGE_KEY) || "null"));
      if (cached) return cached;
    } catch (e) {}
    return null;
  }

  function readCachedQuickActionsDraft(baseConfig) {
    try {
      const envelope = JSON.parse(localStorage.getItem(QUICK_ACTIONS_DRAFT_STORAGE_KEY) || "null");
      const config = normalizeQuickActionsConfig(envelope?.config);
      if (config && Number.isSafeInteger(envelope?.baseRevision) && envelope.baseRevision === baseConfig.revision) {
        return { baseRevision: envelope.baseRevision, config };
      }
    } catch (e) {}
    return null;
  }

  const cachedQuickActionsConfig = readCachedQuickActionsConfig();
  quickActionsConfig = cloneQuickActionsConfig(cachedQuickActionsConfig || DEFAULT_QUICK_ACTIONS_CONFIG);
  const cachedQuickActionsDraft = readCachedQuickActionsDraft(quickActionsConfig);
  quickActionsDraftConfig = cloneQuickActionsConfig(cachedQuickActionsDraft?.config || quickActionsConfig);
  let quickActionsDraftBaseRevision = cachedQuickActionsDraft?.baseRevision || quickActionsConfig.revision;
  quickActionsDraftGeneration = 0;
  let quickActionsConfigSource = cachedQuickActionsConfig ? "cache" : "default";
  quickActionsSyncStatus = cachedQuickActionsDraft ? "dirty" : (cachedQuickActionsConfig ? "synced" : "loading");
  let quickActionsConfigRequest = null;
  let quickActionsSaveRequest = null;
  let quickActionSelection = null;
  let quickActionSelectionSessionId = null;
  let quickActionContextRequest = null;
  let quickActionLastContextScanAt = 0;
  let quickActionButton = null;
  let quickActionFallbackTrigger = null;
  let quickActionMenu = null;
  let activeTextareaInputListener = null;
  let activeTextareaElement = null;
  isComposing = false;

  function persistQuickActionsCache(config) {
    try { localStorage.setItem(QUICK_ACTIONS_STORAGE_KEY, JSON.stringify(config)); } catch (e) {}
  }

  function persistQuickActionsDraft() {
    try {
      localStorage.setItem(QUICK_ACTIONS_DRAFT_STORAGE_KEY, JSON.stringify({
        baseRevision: quickActionsDraftBaseRevision,
        config: quickActionsDraftConfig,
      }));
    } catch (e) {}
  }

  function clearQuickActionsDraftCache() {
    try { localStorage.removeItem(QUICK_ACTIONS_DRAFT_STORAGE_KEY); } catch (e) {}
  }

  function getEnabledQuickActions(config = quickActionsConfig) {
    if (!config?.enabled) return [];
    return config.actions
      .map((action, index) => ({ action, index }))
      .filter(({ action }) => action.enabled)
      .sort((left, right) => right.action.priority - left.action.priority || left.index - right.index)
      .map(({ action }) => action);
  }

  function quickActionIcon(action) {
    if (action.id === "install-production") return "📦";
    if (action.id === "start-implementation") return "🚀";
    return "⚡";
  }

  function setQuickActionsConfig(config, source = "test", resetDraft = true) {
    const normalized = normalizeQuickActionsConfig(config);
    if (!normalized) return false;
    quickActionsConfig = normalized;
    quickActionsConfigSource = source;
    persistQuickActionsCache(normalized);
    if (resetDraft) {
      quickActionsDraftConfig = cloneQuickActionsConfig(normalized);
      quickActionsDraftBaseRevision = normalized.revision;
      quickActionsDraftGeneration += 1;
      clearQuickActionsDraftCache();
    }
    if (quickActionSelection && quickActionSelection.revision !== normalized.revision) quickActionSelection = null;
    closeQuickActionMenu();
    syncQuickActionButtons();
    return true;
  }

  async function loadQuickActionsConfig(force = false) {
    const bridgeUrl = getQuickActionsBridgeUrl();
    if (!bridgeUrl) return cloneQuickActionsConfig(quickActionsConfig);
    if (quickActionsConfigRequest && !force) return quickActionsConfigRequest;
    const hadPendingDraft = ["dirty", "error"].includes(quickActionsSyncStatus);
    const draftGenerationAtRequest = quickActionsDraftGeneration;
    if (!hadPendingDraft) quickActionsSyncStatus = "loading";
    quickActionsConfigRequest = (async () => {
      try {
        const fetcher = baseFetch || window.fetch;
        const response = await fetcher(QUICK_ACTIONS_BRIDGE_URL, { cache: "no-store" });
        if (!response?.ok) throw new Error(`HTTP ${response?.status || "error"}`);
        const config = normalizeQuickActionsConfig(await response.json());
        if (!config) throw new Error("配置格式无效");
        const preserveDraft = hadPendingDraft || quickActionsDraftGeneration !== draftGenerationAtRequest;
        setQuickActionsConfig(config, "bridge", !preserveDraft);
        if (preserveDraft) {
          quickActionsDraftBaseRevision = config.revision;
          quickActionsSyncStatus = "dirty";
          persistQuickActionsDraft();
        } else {
          quickActionsSyncStatus = "synced";
        }
        return cloneQuickActionsConfig(config);
      } catch (error) {
        quickActionsSyncStatus = "error";
        return null;
      } finally {
        quickActionsConfigRequest = null;
        refreshQuickActionsEditorDom();
      }
    })();
    return quickActionsConfigRequest;
  }

  async function saveQuickActionsConfig(config) {
    if (quickActionsSaveRequest) return quickActionsSaveRequest;
    const normalized = normalizeQuickActionsConfig(config);
    if (!normalized) {
      quickActionsSyncStatus = "dirty";
      refreshQuickActionsEditorDom();
      return null;
    }
    const bridgeUrl = getQuickActionsBridgeUrl();
    if (!bridgeUrl) {
      setQuickActionsConfig(normalized, "local", true);
      showToast("快捷回复已保存在本机浏览器");
      return cloneQuickActionsConfig(normalized);
    }
    const submittedSignature = JSON.stringify(normalized);
    quickActionsSyncStatus = "syncing";
    refreshQuickActionsEditorDom();
    quickActionsSaveRequest = (async () => {
      try {
        const fetcher = baseFetch || window.fetch;
        const response = await fetcher(QUICK_ACTIONS_BRIDGE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(normalized),
        });
        if (!response?.ok) throw new Error(`HTTP ${response?.status || "error"}`);
        const saved = normalizeQuickActionsConfig(await response.json());
        if (!saved) throw new Error("配置响应无效");
        const hasNewerDraft = JSON.stringify(quickActionsDraftConfig) !== submittedSignature;
        setQuickActionsConfig(saved, "bridge", !hasNewerDraft);
        if (hasNewerDraft) {
          quickActionsDraftBaseRevision = saved.revision;
          quickActionsSyncStatus = "dirty";
          persistQuickActionsDraft();
          showToast("上一版已同步；当前编辑仍待保存");
        } else {
          quickActionsSyncStatus = "synced";
          showToast("快捷回复已同步到 AI");
        }
        return cloneQuickActionsConfig(saved);
      } catch (error) {
        quickActionsSyncStatus = "error";
        persistQuickActionsDraft();
        showToast("快捷回复同步失败，AI 继续使用上一版");
        return null;
      } finally {
        quickActionsSaveRequest = null;
        refreshQuickActionsEditorDom();
      }
    })();
    return quickActionsSaveRequest;
  }

  function extractNormalText(content) {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
  }

  function matchConservativeQuickReplyFromText(rawText, config, options = {}) {
    if (typeof rawText !== "string" || !config || !config.enabled) return null;

    // 1. 屏蔽代码块（``` ... ```）与行内代码（`...`）
    let cleanText = rawText.replace(/```[\s\S]*?```/g, " ");
    cleanText = cleanText.replace(/`[^`\n]+`/g, " ");

    // 2. 屏蔽 Markdown 引用块（以 > 开头的行）
    cleanText = cleanText.replace(/^>[^\n]*$/gm, " ");

    // 3. 屏蔽行内示例/举例（例如、比如、举例、示例、样例后跟冒号或空格的内容）
    cleanText = cleanText.replace(/(?:例如|比如|举例|示例|样例|如)[:：\s][^\n。！？；]*/g, " ");

    // 4. 屏蔽引号引用（中英文单双引号包裹的文本）
    cleanText = cleanText.replace(/(?:“[^”\n]*”|‘[^’\n]*’|"[^"\n]*"|'[^'\n]*'|「[^」\n]*」)/g, " ");

    cleanText = cleanText.trim();
    if (!cleanText) return null;

    // 5. 全局否定 / 失败 / 未完成 / 阻碍防线
    const hasNegativeTest = /(?:测试|验证)[^\n。！？]*?(?:未通过|失败|尚未通过|未完成|尚未完成|存在报错|出现报错|有报错|发生异常)/.test(cleanText);
    const hasNegativeDeploy = /(?:请勿|切勿|严禁|暂不|不要|不能|不可|未|尚未|失败|暂缓|无法|禁止|不必|不用|无需)(?:[^\n。！？]*?)(?:发布|更新|升级|安装|上线)(?:到|至)?(?:正式|生产)/.test(cleanText) ||
      /(?:不进行|暂不进行|无需进行|不执行|暂不执行)(?:[^\n。！？]*?)(?:后续操作|发布|更新|升级|安装)/.test(cleanText);

    // 全局不进行后续操作 / 仅说明现状
    const hasNoFollowUp = /(?:只说明现状|仅说明现状|说明现状)[^\n。！？]*?(?:不进行|暂不进行|无需进行|不执行)/.test(cleanText) ||
      /(?:不进行|暂不进行|无需进行|不执行)[^\n。！？]*?(?:后续操作|进一步操作|其他操作)/.test(cleanText);

    // 6. 已完成状态防线（已发布、已上线）
    const hasAlreadyCompleted = /(?:正式|生产)(?:环境|版)?[^\n。！？]*?(?:已(?:完成|成功)?(?:发布|升级|更新|上线)|已经(?:发布|升级|更新|上线))/.test(cleanText);

    // 7. 多项互斥选项防线（方案1/2、选项A/B、二选一等）
    const hasMultipleOptions = /(?:方案[一1二2三3A-Za-z]|选项[一1二2三3A-Za-z]|两(?:个|种)方案|三(?:个|种)方案|以下(?:几|两|三)个(?:可选|方案|方向)|请选择|二选一)/.test(cleanText);

    // 8. 优先匹配已启用的配置动作（如 install-production）
    const actions = Array.isArray(config.actions) ? config.actions.filter((a) => a.enabled) : [];
    const installProdAction = actions.find((a) => a.id === "install-production");

    if (installProdAction && !hasNegativeTest && !hasNegativeDeploy && !hasNoFollowUp && !hasAlreadyCompleted && !hasMultipleOptions) {
      const testVerified = /(?:测试|候选|临时)(?:环境|容器|库)?[^\n。！？]*?(?:已验证通过|测试通过|验证通过|已通过验证|测试顺利完成|运行平稳无报错)/.test(cleanText) ||
        /(?:测试|单元测试)[^\n。！？]*?(?:0 failed|全部通过|验证通过)/.test(cleanText);

      // 必须有明确的下一步发布建议，不能仅凭正式旧版（严禁将“仍运行原版本”或“尚未更新”单独当作建议）
      const deploySuggested = /(?:确认无误后)?(?:建议|可(?:一键)?|可以|支持|下一步可|下一步可以)(?:直接)?(?:发布|平滑升级|更新|安装|上线)(?:到|至)?(?:正式|生产)(?:环境|版)?/.test(cleanText) ||
        /(?:可一键发布|可以发布|建议发布|支持发布)(?:到|至)?(?:正式|生产)(?:环境|版)?/.test(cleanText);

      if (testVerified && deploySuggested) {
        return {
          id: installProdAction.id,
          label: installProdAction.label,
          message: installProdAction.message,
          condition: installProdAction.condition || "测试版、候选版或临时环境已经验证完成，但正式版或生产环境尚未更新，可以进入正式发布阶段。",
          mode: installProdAction.mode || "send",
          priority: installProdAction.priority ?? 100,
          enabled: true,
        };
      }
    }

    // 9. 单一明确通用动态动作匹配（如“下一步可以直接导出 PDF 文件。”）
    if (!hasMultipleOptions && !hasNegativeTest && !hasNoFollowUp) {
      const stepMatch = cleanText.match(/(?:下一步|接下来)([^\n。！？]*)/);
      if (stepMatch) {
        const fullSentence = stepMatch[0];
        const afterMarker = stepMatch[1];

        // 多个或/或者/或是/同时多个建议不猜
        const hasMultipleAdvice = /(?:或|或者|或是|以及|同时|也可以|也可|还可以|另外|二选一)/.test(fullSentence);
        if (!hasMultipleAdvice) {
          // 如果整篇文本有多个“下一步”或“接下来”，说明有多个动作步骤，不盲目猜单一动作
          const stepMarkers = cleanText.match(/(?:下一步|接下来)/g);
          if (!stepMarkers || stepMarkers.length === 1) {
            const actionMatch = afterMarker.match(/^(?:可以直接|可以|可直接|建议)?\s*([^\n，。！？；]{2,24})/);
            if (actionMatch) {
              const candidateAction = actionMatch[1].trim();
              const phraseMatch = candidateAction.match(/^(?:直接)?(导出[^\n，。！？；]{2,16}|开始[^\n，。！？；]{2,16}|生成[^\n，。！？；]{2,16}|查看[^\n，。！？；]{2,16}|运行[^\n，。！？；]{2,16}|排查[^\n，。！？；]{2,16})/);
              if (phraseMatch) {
                const rawAction = phraseMatch[1].trim();
                const isVague = /(?:优化|重构|考虑|观察|思考|注意)/.test(rawAction);
                // 否定/未完成阻断所有相关动态路径
                const isDeployAction = /(?:发布|更新|升级|安装|上线)/.test(rawAction);
                if (isDeployAction && hasNegativeDeploy) return null;

                // 检查该动作动词是否在正文中被否定（如“请勿导出”、“未完成导出”等）
                const verb = rawAction.slice(0, 2);
                const actionNegated = new RegExp(`(?:请勿|切勿|严禁|暂不|不要|不能|不可|未|尚未|失败|暂缓|无法|禁止)[^\\n。！？]*?${verb}`).test(cleanText);
                if (actionNegated) return null;

                // 安全动态动作：不要原始 shell 命令或 URL
                const isUnsafe = /(?:^|\s)(?:bash|sh|sudo|rm|curl|wget|npm|pnpm|yarn|docker|git|node|python)\b/.test(rawAction) ||
                  /[|;&`$><]/.test(rawAction) ||
                  /https?:\/\/|\/api\/|localhost|127\.0\.0\.1/.test(rawAction) ||
                  /^\.\//.test(rawAction);

                if (!isVague && !isUnsafe && rawAction.length >= 2 && rawAction.length <= 24) {
                  const cleanLabel = rawAction.replace(/^[请可直接]+/, "").trim();
                  const actionLabel = (cleanLabel || rawAction).slice(0, 24);
                  const actionMessage = rawAction.startsWith("请") ? rawAction : `请${rawAction}`;
                  return {
                    id: "custom",
                    label: actionLabel,
                    message: actionMessage.slice(0, 200),
                    condition: "助手建议的下一步操作",
                    mode: "send",
                    priority: 0,
                    enabled: true,
                  };
                }
              }
            }
          }
        }
      }
    }

    return null;
  }

  function parseQuickActionTurnMessages(messages, entryIds = [], config = quickActionsConfig, currentSessionId = (typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null)) {
    if (!Array.isArray(messages) || !config?.enabled) return null;
    // 元数据会话缺失时不能当有效 ready 或凭空复活兜底
    if (!currentSessionId) return null;

    let latestUserIndex = -1;
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]?.role === "user") latestUserIndex = index;
    }
    let latestAssistantIndex = -1;
    for (let index = messages.length - 1; index > latestUserIndex; index -= 1) {
      if (messages[index]?.role === "assistant") { latestAssistantIndex = index; break; }
    }
    const latestAssistantId = entryIds[latestAssistantIndex] || messages[latestAssistantIndex]?.id;

    // 1. Post-turn 结构化分析记录具有最高权威性（压制一切旧工具和文本兜底）
    let hasAuthoritativeAnalysis = false;
    for (let index = messages.length - 1; index > latestAssistantIndex && latestAssistantIndex >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "custom" || message.customType !== "pi-quick-action-analysis") continue;

      // 只要该助手消息后面存在分析记录，无论是否合法，都说明已有 post-turn 机制介入，绝不能凭空复活兜底
      hasAuthoritativeAnalysis = true;

      const details = message.details;
      // 元数据会话缺失/不匹配、schema 非法记录不能当有效 ready
      if (!details || details.schemaVersion !== 1 || !details.sessionId || details.sessionId !== currentSessionId) {
        return null;
      }
      if (details.assistantEntryId !== latestAssistantId) return null;

      // A failed classifier is not a decision of "none". Keep the conservative
      // final-answer path available, but never revive pending/none/stale data.
      if (details.status === "error" && details.action === null && details.revision === config.revision) {
        hasAuthoritativeAnalysis = false;
        break;
      }
      if (details.status !== "ready" || details.revision !== config.revision) return null;
      const action = normalizeQuickAction(details.action);
      if (!action?.enabled) return null;
      const configured = config.actions.find((item) => item.id === action.id && item.enabled);
      if (!configured && action.id !== "custom") return null;
      return {
        schemaVersion: 1,
        revision: details.revision,
        sessionId: details.sessionId,
        assistantEntryId: details.assistantEntryId,
        status: "ready",
        action: cloneQuickAction(configured || action),
        reason: typeof details.reason === "string" ? details.reason : "",
      };
    }
    if (hasAuthoritativeAnalysis) return null;

    // 2. 兼容历史旧版 toolResult 记录（select_quick_action）
    const selections = [];
    for (let index = latestUserIndex + 1; index < messages.length; index += 1) {
      const message = messages[index];
      if (message?.role !== "toolResult" || message.toolName !== QUICK_ACTIONS_TOOL_NAME) continue;
      const details = message.details;
      if (!details || details.schemaVersion !== 1 || !Number.isSafeInteger(details.revision)) continue;
      const action = normalizeQuickAction(details.action);
      if (!action || !action.enabled || details.revision !== config.revision) continue;
      const configured = config.actions.find((item) => item.id === action.id && item.enabled);
      if (!configured && action.id !== "custom") continue;
      const targetAction = cloneQuickAction(configured || action);
      let assistantIndex = index - 1;
      while (assistantIndex > latestUserIndex && messages[assistantIndex]?.role !== "assistant") assistantIndex -= 1;
      const assistantEntryId = assistantIndex > latestUserIndex ? (entryIds[assistantIndex] || messages[assistantIndex]?.id || null) : null;
      if (!assistantEntryId || assistantEntryId !== latestAssistantId) continue;
      selections.push({
        schemaVersion: 1,
        revision: details.revision,
        sessionId: currentSessionId,
        assistantEntryId,
        status: "ready",
        action: targetAction,
        reason: typeof details.reason === "string" ? details.reason.trim().slice(0, 200) : "",
      });
    }
    if (selections.length > 0) {
      selections.sort((left, right) => right.action.priority - left.action.priority);
      return selections[0];
    }

    // 3. 保守最终回答兼容兜底（无 post-turn 结果且无有效工具选择时）
    if (latestAssistantIndex >= 0 && latestAssistantId) {
      const assistantMsg = messages[latestAssistantIndex];
      // 严格只允许 stopReason === "stop"，坚决移除 (!stopReason && !isChatSessionRunning()) 宽松分支
      const isStopped = assistantMsg?.stopReason === "stop";
      if (isStopped) {
        const assistantText = extractNormalText(assistantMsg?.content);
        if (assistantText.trim()) {
          const fallbackAction = matchConservativeQuickReplyFromText(assistantText, config, {
            sessionId: currentSessionId,
            assistantEntryId: latestAssistantId,
          });
          if (fallbackAction) {
            return {
              schemaVersion: 1,
              version: "fallback-text-v1",
              revision: config.revision,
              sessionId: currentSessionId,
              assistantEntryId: latestAssistantId,
              source: "text-fallback",
              status: "ready",
              action: cloneQuickAction(fallbackAction),
              reason: fallbackAction.id === "install-production" ? "matched-conservative-install-production" : "matched-conservative-dynamic-action",
            };
          }
        }
      }
    }

    return null;
  }

  function parseQuickActionMessages(messages, entryIds = []) {
    return parseQuickActionTurnMessages(messages, entryIds, quickActionsConfig, getCurrentSessionId());
  }

  async function refreshQuickActionSelection(force = false) {
    if (window.__PI_ENH_DISABLE_QUICK_ACTION_CONTEXT_FETCH__ || !isPluginEnabled("quick-action-buttons")) return null;
    const sessionId = getCurrentSessionId();
    if (!sessionId || isChatSessionRunning()) return null;
    if (quickActionSelectionSessionId !== sessionId) {
      quickActionSelectionSessionId = sessionId;
      quickActionSelection = null;
    }
    const now = Date.now();
    if (quickActionContextRequest || (!force && now - quickActionLastContextScanAt < 1200)) return quickActionContextRequest;
    quickActionLastContextScanAt = now;
    quickActionContextRequest = (async () => {
      try {
        const fetcher = baseFetch || window.fetch;
        const response = await fetcher(`/api/sessions/${encodeURIComponent(sessionId)}/context?deferThinking=1&deferMedia=1&tail=24`, { cache: "no-store" });
        if (!response?.ok) return null;
        const payload = await response.json();
        if (sessionId !== getCurrentSessionId() || isChatSessionRunning() || !isPluginEnabled("quick-action-buttons")) return null;
        quickActionSelection = parseQuickActionMessages(payload?.context?.messages || [], payload?.context?.entryIds || []);
        hideQuickActionToolCards();
        syncQuickActionButtons();
        return quickActionSelection;
      } catch (e) {
        return null;
      } finally {
        quickActionContextRequest = null;
      }
    })();
    return quickActionContextRequest;
  }

  function hideQuickActionAnalysisCards() {
    const spans = document.querySelectorAll("span");
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i];
      if (String(span.textContent || "").trim() === "pi-quick-action-analysis") {
        const card = span.closest('div[style*="margin-bottom"]') || span.parentElement?.parentElement?.parentElement;
        if (card && card.style.display !== "none") {
          card.style.display = "none";
        }
      }
    }
  }

  function restoreQuickActionToolCards() {
    for (const card of document.querySelectorAll('[data-pi-enh-quick-tool-hidden="true"]')) {
      card.style.display = card.getAttribute("data-pi-enh-quick-tool-display") || "";
      card.removeAttribute("data-pi-enh-quick-tool-hidden");
      card.removeAttribute("data-pi-enh-quick-tool-display");
    }
  }

  function hideQuickActionToolCards() {
    if (!isPluginEnabled("quick-action-buttons")) return restoreQuickActionToolCards();
    for (const message of document.querySelectorAll('div[data-message-role="assistant"]')) {
      for (const span of message.querySelectorAll("span")) {
        if (String(span.textContent || "").trim() !== QUICK_ACTIONS_TOOL_NAME) continue;
        const button = span.closest?.("button");
        const card = button?.parentElement?.parentElement;
        if (!button || !card || card === message || card.getAttribute("data-pi-enh-quick-tool-hidden") === "true") continue;
        card.setAttribute("data-pi-enh-quick-tool-display", card.style.display || "");
        card.setAttribute("data-pi-enh-quick-tool-hidden", "true");
        card.style.display = "none";
      }
    }
  }

  function isAgentStopButton(btn) {
    if (!btn || btn.disabled) return false;
    // 排除消息体（用户/助手消息）、代码块、文件预览、工具卡片内部的任何按钮
    if (typeof btn.closest === "function" && btn.closest('div[data-message-role], pre, code, .pi-enh-tool-card, [data-pi-enh-tool-card], #chat-message-list')) {
      return false;
    }
    const title = String(btn.getAttribute("title") || "").trim();
    const ariaLabel = String(btn.getAttribute("aria-label") || "").trim();
    const text = String(btn.textContent || "").trim();

    // 排除文件打开、代码复制、路径查看等操作
    if (/^(打开|查看|运行|open|view|copy|复制)\b/i.test(ariaLabel) || /^(打开|查看|运行|open|view|copy|复制)\b/i.test(title)) {
      return false;
    }
    if (/\.(py|sh|js|ts|json|md|txt|html|css|yaml|yml|sql|rs|go|c|cpp|h)\b/i.test(title) ||
        /\.(py|sh|js|ts|json|md|txt|html|css|yaml|yml|sql|rs|go|c|cpp|h)\b/i.test(ariaLabel) ||
        /\.(py|sh|js|ts|json|md|txt|html|css|yaml|yml|sql|rs|go|c|cpp|h)\b/i.test(text)) {
      return false;
    }

    if (btn.classList?.contains?.("pi-enh-cursor-stop")) return true;
    if (typeof btn.querySelector === "function" && btn.querySelector('svg rect[x="1.5"]')) return true;

    // 仅匹配明确属于中止/停止 Agent 的交互按钮
    const stopRegex = /^(停止\s*Agent|停止代理|停止|中止|取消|Stop\s*Agent|Stop|Cancel\s*Agent|Cancel)$/i;
    return stopRegex.test(title) || stopRegex.test(ariaLabel) || stopRegex.test(text);
  }

  function getComposerSearchScopes(textarea = findComposerTextarea(), fallbackRoot = document) {
    const scopes = [];
    const addScope = (node) => {
      if (node && typeof node.querySelectorAll === "function" && !scopes.includes(node)) {
        scopes.push(node);
      }
    };
    if (fallbackRoot && fallbackRoot !== document) {
      addScope(fallbackRoot);
    }
    if (textarea) {
      addScope(textarea.closest?.("[data-pi-native-composer-host]"));
      addScope(textarea.closest?.(".pi-enh-cursor-composer"));
      addScope(textarea.closest?.("form"));
      addScope(textarea.closest?.(".chat-input-container, [data-chat-input-wrap], .relative.shrink-0"));
      addScope(textarea.closest?.(".chat-content > div"));
      addScope(textarea.parentElement?.parentElement);
      addScope(textarea.parentElement);
    }
    if (scopes.length === 0) {
      addScope(fallbackRoot || document);
    }
    return scopes;
  }

  function getComposerEffectivePlaceholder(textarea = findComposerTextarea()) {
    if (!textarea) return "";
    const direct = String(textarea.getAttribute?.("placeholder") || textarea.placeholder || "");
    if (direct) return direct;
    if (
      (typeof isPluginEnabled === "function" && isPluginEnabled("composer-clean-placeholder")) ||
      textarea.classList?.contains?.("pi-enh-clean-placeholder")
    ) {
      return String(textarea.getAttribute?.("data-pi-orig-placeholder") || "");
    }
    return "";
  }

  function isRunningPlaceholderText(ph) {
    const text = String(ph || "");
    return (
      text.includes("引导") ||
      text.includes("排队") ||
      text.includes("运行中") ||
      text.includes("代理正在运行") ||
      text.includes("Steer") ||
      text.includes("running")
    );
  }

  function findActiveStopButton(root = document) {
    const textarea = findComposerTextarea();
    const scopes = getComposerSearchScopes(textarea, root);
    for (const scope of scopes) {
      const buttons = scope.querySelectorAll("button");
      for (const btn of buttons) {
        if (isAgentStopButton(btn)) return btn;
      }
    }
    return null;
  }

  function isComposerIndicatingRunning() {
    if (findActiveStopButton()) return true;

    const textarea = findComposerTextarea();
    if (textarea) {
      const ph = getComposerEffectivePlaceholder(textarea);
      if (isRunningPlaceholderText(ph)) return true;
    }
    const scopes = getComposerSearchScopes(textarea, document);
    for (const scope of scopes) {
      for (const btn of scope.querySelectorAll("button")) {
        // 排除消息体、工具卡片、以及外部队列面板内部的按钮
        if (typeof btn.closest === "function" && btn.closest(".pi-enh-queue-panel, div[data-message-role], pre, code, .pi-enh-tool-card, [data-pi-enh-tool-card], #chat-message-list")) {
          continue;
        }
        if (
          btn.hasAttribute?.("data-pi-enh-quick-reply") ||
          btn.getAttribute?.("title")?.includes("快捷回复") ||
          btn.getAttribute?.("aria-label")?.includes("快捷回复")
        ) {
          continue;
        }
        if (isAgentStopButton(btn)) return true;
        const text = (btn.textContent || "").trim();
        const title = btn.getAttribute("title") || "";
        if (text === "引导" || text === "后续消息" || title.includes("引导") || title.includes("后续消息")) return true;
      }
    }
    return false;
  }

  function isComposerExplicitlyIdle() {
    const textarea = findComposerTextarea();
    if (!textarea) return false;
    if (isComposerIndicatingRunning()) return false;
    const ph = getComposerEffectivePlaceholder(textarea).trim();
    if (ph && !isRunningPlaceholderText(ph)) {
      return true;
    }
    return false;
  }

  function isServerRunningForSession(sid) {
    if (!sid) return false;

    // 终态保护检查：若该会话有可验证的终态证据（agent_settled/prompt_done），且未出现新轮次 agent_start 或明确 stop 按钮，
    // 则陈旧滞后的 statusEntry.execution === "running" 或 runningSessionIds 绝不能复活秒表与运行态。
    const isSettledFn = typeof isSessionTerminallySettled === "function"
      ? isSessionTerminallySettled
      : (typeof window !== "undefined" ? window.__PI_ENH_IS_SESSION_TERMINALLY_SETTLED__ : null);
    if (typeof isSettledFn === "function" && isSettledFn(sid)) {
      return false;
    }

    const hasRunningIdsList =
      typeof projectStatusLastPayload !== "undefined" &&
      Array.isArray(projectStatusLastPayload?.runningSessionIds);
    const inRunningIds = hasRunningIdsList && projectStatusLastPayload.runningSessionIds.includes(sid);

    if (typeof projectStatusModel !== "undefined" && projectStatusModel?.health?.().state === "live" && projectStatusModel?.entry) {
      const statusEntry = projectStatusModel.entry(sid);
      if (statusEntry?.execution === "running") {
        return true;
      }
      if (!inRunningIds && (
        ["ended", "completed", "idle", "stopped"].includes(statusEntry?.execution) ||
        ["completed", "idle", "stopped", "interrupted"].includes(statusEntry?.status)
      )) {
        return false;
      }
    }

    if (inRunningIds) {
      const healthy = typeof isProjectStatusHealthy === "function" ? isProjectStatusHealthy() : true;
      if (healthy) {
        const memEntry = typeof sessionMemoryCache !== "undefined" ? sessionMemoryCache?.get?.(sid) : null;
        if (!memEntry || memEntry.isRunning !== false) {
          return true;
        }
      }
    }
    return false;
  }

  function isChatSessionRunning(sessionId) {
    const currentSid = getCurrentSessionId();
    const sid = sessionId || currentSid;
    const isCurrent = !sid || !currentSid || sid === currentSid;

    if (isCurrent && isComposerIndicatingRunning()) {
      return true;
    }

    if (sid) {
      if (isCurrent && isComposerExplicitlyIdle()) {
        return false;
      }
      if (isServerRunningForSession(sid)) {
        return true;
      }
      if (typeof projectStatusModel !== "undefined" && projectStatusModel?.health?.().state === "live" && projectStatusModel?.entry) {
        const statusEntry = projectStatusModel.entry(sid);
        if (["ended", "completed", "idle", "stopped"].includes(statusEntry?.execution) ||
            ["completed", "idle", "stopped", "interrupted"].includes(statusEntry?.status)) {
          return false;
        }
      }
    }

    return isCurrent ? isComposerIndicatingRunning() : false;
  }
  window.__PI_ENH_IS_CHAT_SESSION_RUNNING__ = isChatSessionRunning;
  window.__PI_ENH_FIND_ACTIVE_STOP_BUTTON__ = findActiveStopButton;

  function onCompositionStart() {
    isComposing = true;
    removeQuickActionDoms();
  }

  function onCompositionEnd() {
    isComposing = false;
    addManagedTimeout(() => syncQuickActionButtons(), 20);
  }

  function isComposerInputEmpty(textarea) {
    if (!textarea || isComposing) return false;
    const val = typeof textarea.value === "string" ? textarea.value : "";
    return val.trim().length === 0;
  }

  function closeQuickActionMenu() {
    if (quickActionMenu) {
      quickActionMenu.remove();
      quickActionMenu = null;
    }
  }

  function executeQuickCommand(command, autoSend = true) {
    closeQuickActionMenu();
    const textarea = findComposerTextarea();
    if (!textarea || !setComposerTextareaValue(textarea, command)) return;
    if (typeof window !== "undefined" && window.__PI_ENH_SUPPRESS_AUTO_SEND__) return;

    // 安全守卫 1：兜底菜单手动选取时，仅填充输入框并给轻提示，由用户核对后自主点击发送
    if (!autoSend) {
      showToast("已填入输入框，请核对后发送", null, 1800);
      return;
    }

    // 安全守卫 2：空会话/新建会话无任何助手消息时，绝对不自动回车发送，防止无上下文创建多余会话
    const assistantMsgs = document.querySelectorAll ? document.querySelectorAll('div[data-message-role="assistant"]') : [];
    if (assistantMsgs.length === 0) {
      showToast("空会话无上下文，已填入输入框供核对", null, 1800);
      return;
    }

    addManagedTimeout(() => {
      sendComposerText(textarea);
    }, 0);
  }

  function openQuickActionMenu(anchor) {
    if (quickActionMenu) {
      closeQuickActionMenu();
      return;
    }
    const menu = document.createElement("div");
    menu.className = "pi-enh-quick-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "快捷操作菜单");

    for (const item of getEnabledQuickActions()) {
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "pi-enh-quick-menu-item";
      opt.setAttribute("role", "menuitem");
      opt.setAttribute("data-pi-enh-quick-action", item.id);
      opt.textContent = `${quickActionIcon(item)} ${item.label}`;
      opt.addEventListener("click", (e) => {
        e.stopPropagation();
        executeQuickCommand(item.message, true);
      });
      menu.appendChild(opt);
    }

    if (anchor && anchor.parentElement) {
      anchor.parentElement.appendChild(menu);
    } else {
      document.body.appendChild(menu);
    }
    quickActionMenu = menu;
  }

  function bindComposerInputListener(textarea) {
    if (activeTextareaElement === textarea) return;
    if (activeTextareaElement && activeTextareaInputListener) {
      activeTextareaElement.removeEventListener("input", activeTextareaInputListener);
      activeTextareaElement.removeEventListener("compositionstart", onCompositionStart);
      activeTextareaElement.removeEventListener("compositionend", onCompositionEnd);
      activeTextareaElement.removeEventListener("keyup", activeTextareaInputListener);
    }
    activeTextareaElement = textarea;
    if (!textarea) {
      activeTextareaInputListener = null;
      return;
    }
    let lastWasEmpty = !textarea.value || textarea.value.trim().length === 0;
    let quickActionDebounceTimer = null;
    activeTextareaInputListener = () => {
      if (isComposing) return;
      const isEmpty = !textarea.value || textarea.value.trim().length === 0;
      // 状态发生空/非空突变（如完全删空或输入首字），立即无延迟同步
      if (isEmpty !== lastWasEmpty) {
        lastWasEmpty = isEmpty;
        if (quickActionDebounceTimer) {
          clearTimeout(quickActionDebounceTimer);
          quickActionDebounceTimer = null;
        }
        syncQuickActionButtons();
      } else {
        // 持续删除或输入中（长文本长按 Backspace），防抖 160ms，绝不阻塞主线程
        if (!quickActionDebounceTimer) {
          quickActionDebounceTimer = setTimeout(() => {
            quickActionDebounceTimer = null;
            if (!isComposing) syncQuickActionButtons();
          }, 160);
        }
      }
    };
    textarea.addEventListener("input", activeTextareaInputListener);
    textarea.addEventListener("compositionstart", onCompositionStart);
    textarea.addEventListener("compositionend", onCompositionEnd);
    textarea.addEventListener("keyup", activeTextareaInputListener);
  }

  function removeQuickActionDoms(scope = document) {
    restoreAllQuickReplyButtons(scope);
    for (const actionBar of scope.querySelectorAll(".pi-enh-quick-actions")) {
      actionBar.remove();
    }
    for (const button of scope.querySelectorAll(".pi-enh-quick-start-button")) {
      button.remove();
    }
    for (const trigger of scope.querySelectorAll(".pi-enh-quick-fallback-trigger")) {
      trigger.remove();
    }
    for (const menu of scope.querySelectorAll(".pi-enh-quick-menu")) {
      menu.remove();
    }
    quickActionButton = null;
    quickActionFallbackTrigger = null;
    quickActionMenu = null;
  }

  function removeQuickActionButtons(scope = document) {
    removeQuickActionDoms(scope);
    restoreQuickActionToolCards();
    if (activeTextareaElement && activeTextareaInputListener) {
      activeTextareaElement.removeEventListener("input", activeTextareaInputListener);
      activeTextareaElement.removeEventListener("compositionstart", onCompositionStart);
      activeTextareaElement.removeEventListener("compositionend", onCompositionEnd);
      activeTextareaElement.removeEventListener("keyup", activeTextareaInputListener);
      activeTextareaElement = null;
      activeTextareaInputListener = null;
    }
    isComposing = false;
  }

  // Shared by the image-zoom plugin. Never search message history as fallback.
  function findComposerImageContainer(textarea) {
    return textarea?.closest?.("[data-pi-native-composer-host]")?.querySelector('div[style*="flex-wrap"], div[style*="flexWrap"]') || null;
  }

  function isNativeImagePreviewTrigger(el) {
    if (!el || !el.tagName || el.tagName.toLowerCase() !== "button") return false;
    const hasPopup = typeof el.getAttribute === "function"
      ? el.getAttribute("aria-haspopup")
      : el.attributes?.["aria-haspopup"];
    if (hasPopup !== "dialog") return false;
    if (el.classList?.contains?.("image-preview-close")) return false;
    if (el.hasAttribute?.("data-no-zoom") || el.hasAttribute?.("data-pi-enh-no-zoom")) return false;
    if (String(el.textContent || "").trim() !== "") return false;
    const children = Array.from(el.children || []);
    if (children.length !== 1) return false;
    const onlyChild = children[0];
    return Boolean(onlyChild && onlyChild.tagName && onlyChild.tagName.toLowerCase() === "img");
  }

  function unwrapNativeImagePreviewTarget(el) {
    if (!el || !el.tagName) return el;
    if (isNativeImagePreviewTrigger(el)) {
      return Array.from(el.children || [])[0] || el;
    }
    return el;
  }

  function getComposerAttachmentItemContainer(img) {
    if (!img || !img.parentElement) return null;
    const parent = img.parentElement;
    if (isNativeImagePreviewTrigger(parent)) {
      return parent.parentElement || null;
    }
    return parent;
  }

  function getComposerAttachmentRemoveButton(img) {
    const itemContainer = getComposerAttachmentItemContainer(img);
    if (!itemContainer) return null;
    const children = Array.from(itemContainer.children || []);
    return children.find((c) => c && c.tagName && c.tagName.toLowerCase() === "button" && !isNativeImagePreviewTrigger(c)) || null;
  }

  function findComposerTextarea() {
    return document.querySelector("textarea.chat-input-textarea") ||
      document.querySelector('textarea[style*="fontFamily"]') ||
      document.querySelector("form textarea") ||
      document.querySelector("textarea");
  }

  function setComposerTextareaValue(textarea, value, { focus = true } = {}) {
    if (!textarea) return false;
    try {
      const proto = Object.getPrototypeOf(textarea);
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype || {}, "value")?.set;
      if (setter) setter.call(textarea, value);
      else textarea.value = value;
    } catch (e) {
      textarea.value = value;
    }
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    if (focus) {
      textarea.focus();
      if (typeof textarea.setSelectionRange === "function") {
        textarea.setSelectionRange(value.length, value.length);
      }
    }
    return true;
  }

  function isNativeComposerLayoutButton(button) {
    if (!button || typeof button.closest !== "function") return false;
    const layout = button.closest("[data-pi-native-composer-layout]");
    if (!layout) return false;
    if (button.closest(".pi-native-ask-host, .pi-native-ask-card")) return false;
    return true;
  }

  function isNativeComposerSendButton(button) {
    if (!button || button.disabled) return false;
    if (!isNativeComposerLayoutButton(button)) return false;
    const className = String(button.className || "");
    if (/\bpi-enh-quick-(?:start-button|fallback-trigger|menu-item)\b/.test(className)) return false;

    const labels = [
      button.textContent,
      button.getAttribute?.("aria-label"),
      button.getAttribute?.("title"),
    ].map((value) => String(value || "").trim()).filter(Boolean);

    return labels.some((label) => /^(?:发送(?:消息)?|send(?: message)?)(?:\s|$|[（(])/i.test(label));
  }

  function findNativeComposerSendButton(textarea) {
    if (!textarea) return null;
    const layout = textarea.closest?.("[data-pi-native-composer-layout]");
    if (!layout) return null;
    const roots = [layout];
    const visited = new Set();

    for (const root of roots) {
      if (visited.has(root) || typeof root.querySelectorAll !== "function") continue;
      visited.add(root);
      const button = Array.from(root.querySelectorAll("button")).find(isNativeComposerSendButton);
      if (button) return button;
    }
    return null;
  }

  function dispatchComposerSubmitShortcut(textarea) {
    textarea.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
  }

  function sendComposerText(textarea, attempt = 0) {
    if (!textarea) return false;
    recordActiveTurnStart(getCurrentSessionId(), Date.now(), null, false);
    const nativeSendButton = findNativeComposerSendButton(textarea);
    if (nativeSendButton && !nativeSendButton.disabled) {
      emptySendContinuePassthrough = true;
      try {
        nativeSendButton.click();
      } finally {
        emptySendContinuePassthrough = false;
      }
      return true;
    }

    // React may enable the native send button a few frames after the input event.
    if (attempt < 15) {
      addManagedTimeout(() => sendComposerText(textarea, attempt + 1), 30);
      return true;
    }

    // Compatibility fallback for Pi Web variants without a discoverable send button.
    dispatchComposerSubmitShortcut(textarea);
    return true;
  }

  // ==========================================
  // 2.7 Empty Send Continues Existing Session (空输入点击发送“继续”)
  // ==========================================
  const EMPTY_SEND_CONTINUE_ATTR = "data-pi-enh-empty-send-continue";
  let emptySendContinueArmed = false;
  emptySendContinuePassthrough = false;
  let emptySendContinueComposing = false;

  function isEmptySendContinueButton(button) {
    if (!button) return false;
    if (!isNativeComposerLayoutButton(button)) return false;
    const className = String(button.className || "");
    if (/\bpi-enh-quick-(?:start-button|fallback-trigger|menu-item)\b/.test(className)) return false;
    const labels = [
      button.textContent,
      button.getAttribute?.("aria-label"),
      button.getAttribute?.("title"),
      button.getAttribute?.("data-pi-enh-original-text"),
      button.getAttribute?.("data-pi-enh-original-aria"),
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return labels.some((label) => /^(?:发送(?:消息)?|send(?: message)?)(?:\s|$|[（(])/i.test(label));
  }

  function getEmptySendContinueButtons(textarea) {
    if (!textarea) return [];
    const layout = textarea.closest?.("[data-pi-native-composer-layout]");
    if (!layout) return [];
    const roots = [layout];
    const buttons = [];
    const visited = new Set();
    for (const root of roots) {
      if (visited.has(root) || typeof root.querySelectorAll !== "function") continue;
      visited.add(root);
      for (const button of root.querySelectorAll("button")) {
        if (isEmptySendContinueButton(button) && !buttons.includes(button)) buttons.push(button);
      }
    }
    return buttons;
  }

  function composerHasAnySendPayload(textarea) {
    if (!textarea) return false;
    if (String(textarea.value || "").trim()) return true;
    if (typeof pendingComposerAttachments !== "undefined" && Array.isArray(pendingComposerAttachments) && pendingComposerAttachments.length > 0) return true;
    if (typeof listAnnotations === "function" && listAnnotations().length > 0) return true;
    const root = textarea.closest?.("[data-pi-native-composer-host]") || textarea.closest?.("form") || textarea.parentElement?.parentElement || textarea.parentElement;
    if (root?.querySelector?.(".pi-enh-attachment-card")) return true;
    const nativeImageContainer = findComposerImageContainer(textarea);
    if (nativeImageContainer?.querySelectorAll?.("img")?.length) return true;
    if (root?.querySelectorAll?.("img")?.length) return true;
    return false;
  }

  function hasExistingConversation() {
    const currentId = getCurrentSessionId();
    if (currentId) return true;
    if (document.querySelector('div[data-message-role], div[data-entry-id], .markdown-user-message, [class*="markdown-"], [class*="chat-message"], div[style*="var(--user-bg)"], div[style*="var(--bg-user)"], .chat-message, article')) {
      return true;
    }
    if (currentId && typeof sessionMemoryCache !== "undefined" && sessionMemoryCache?.has?.(currentId)) {
      const entry = sessionMemoryCache.get(currentId);
      if (entry?.messages?.length > 0) return true;
    }
    return false;
  }

  function canUseEmptySendContinue(textarea) {
    return isPluginEnabled("empty-send-continue")
      && !emptySendContinueComposing
      && hasExistingConversation()
      && !isChatSessionRunning()
      && !composerHasAnySendPayload(textarea);
  }

  function restoreEmptySendContinueButton(button, textarea = findComposerTextarea()) {
    if (!button) return;
    button.removeAttribute(EMPTY_SEND_CONTINUE_ATTR);
    if (isEmptySendContinueButton(button) && !composerHasAnySendPayload(textarea)) {
      button.disabled = true;
      button.setAttribute("disabled", "");
    }
  }

  function clearEmptySendContinueButtons() {
    for (const button of document.querySelectorAll(`[${EMPTY_SEND_CONTINUE_ATTR}]`)) {
      restoreEmptySendContinueButton(button);
    }
  }

  function removeEmptySendContinue() {
    clearEmptySendContinueButtons();
    emptySendContinueArmed = false;
    emptySendContinuePassthrough = false;
    emptySendContinueComposing = false;
  }

  function syncEmptySendContinue() {
    const textarea = findComposerTextarea();
    const candidates = getEmptySendContinueButtons(textarea);
    const eligible = Boolean(textarea && canUseEmptySendContinue(textarea));

    for (const button of document.querySelectorAll(`[${EMPTY_SEND_CONTINUE_ATTR}]`)) {
      if (!eligible || !candidates.includes(button)) restoreEmptySendContinueButton(button, textarea);
    }
    if (!eligible) return;

    for (const button of candidates) {
      button.setAttribute(EMPTY_SEND_CONTINUE_ATTR, "true");
      button.disabled = false;
      button.removeAttribute("disabled");
      button.removeAttribute("aria-disabled");
    }
  }

  function consumeEmptySendContinueClick(event) {
    if (emptySendContinuePassthrough) return false;
    const button = event?.target?.closest?.("button");
    const textarea = findComposerTextarea();
    if (!button || !textarea || !isEmptySendContinueButton(button)) return false;
    if (button.hasAttribute?.("data-pi-enh-quick-reply")) return false;

    if (emptySendContinueArmed) {
      event.preventDefault?.();
      event.stopPropagation?.();
      event.stopImmediatePropagation?.();
      return true;
    }
    if (!canUseEmptySendContinue(textarea)) return false;

    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    emptySendContinueArmed = true;
    setComposerTextareaValue(textarea, "继续");

    addManagedTimeout(() => {
      try {
        sendComposerText(textarea);
      } finally {
        emptySendContinueArmed = false;
        addManagedTimeout(syncEmptySendContinue, 50);
      }
    }, 0);
    return true;
  }

  addManagedListener(document, "mousedown", (event) => {
    const button = event?.target?.closest?.("button");
    const textarea = findComposerTextarea();
    if (!button || !textarea || !isEmptySendContinueButton(button) || !canUseEmptySendContinue(textarea)) return;
    button.setAttribute(EMPTY_SEND_CONTINUE_ATTR, "true");
    button.disabled = false;
    button.removeAttribute("disabled");
  }, true);
  addManagedListener(document, "click", consumeEmptySendContinueClick, true);
  addManagedListener(document, "compositionstart", (event) => {
    if (event?.target === findComposerTextarea()) {
      emptySendContinueComposing = true;
      clearEmptySendContinueButtons();
    }
  }, true);
  addManagedListener(document, "compositionend", (event) => {
    if (event?.target !== findComposerTextarea()) return;
    emptySendContinueComposing = false;
    addManagedTimeout(syncEmptySendContinue, 20);
  }, true);
  activeCleanups.push(removeEmptySendContinue);
  window.__PI_ENH_HANDLE_EMPTY_SEND_CONTINUE_CLICK__ = consumeEmptySendContinueClick;
  window.__PI_ENH_SYNC_EMPTY_SEND_CONTINUE__ = syncEmptySendContinue;
  window.__PI_ENH_GET_EMPTY_SEND_CONTINUE_STATE__ = () => {
    const textarea = findComposerTextarea();
    return {
      enabled: isPluginEnabled("empty-send-continue"),
      hasConversation: hasExistingConversation(),
      running: isChatSessionRunning(),
      composing: emptySendContinueComposing,
      hasPayload: composerHasAnySendPayload(textarea),
      candidateCount: getEmptySendContinueButtons(textarea).length,
      eligible: Boolean(textarea && canUseEmptySendContinue(textarea)),
    };
  };

  // ==========================================
  // 3.4 Composer Draft & Image Cache (原生草稿持久层兼容桥)
  // ==========================================
  // ChatInput/draft-store owns composer state and v3 storage. These wrappers
  // serve enhancement flows that recover an inactive queue owner.
  let draftListeners = [];
  let draftSyncQueued = false;
  let draftRuntimeGeneration = 0;

  function getNativeDraftStore() {
    try {
      const store = typeof window !== "undefined" ? window.__PI_NATIVE_DRAFT_STORE__ : null;
      return store?.version === 1 ? store : null;
    } catch {
      return null;
    }
  }

  function validDraftImages(images) {
    return Array.isArray(images) && images.length <= 10 && images.every((img) =>
      img && typeof img.data === "string" && img.data.length > 0
      && typeof img.mimeType === "string" && img.mimeType.startsWith("image/"));
  }

  function getPersistedDraft(key) {
    return getNativeDraftStore()?.get(key) || null;
  }

  function removePersistedDraft(key) {
    return getNativeDraftStore()?.clear(key) ?? false;
  }

  function savePersistedDraft(key, draft) {
    if (!isPluginEnabled("composer-draft-cache") || !key
      || typeof draft?.value !== "string" || !validDraftImages(draft.images)) return false;
    const store = getNativeDraftStore();
    if (!store) return false;
    return store.set(key, draft);
  }

  function committedComposerFiber(fieldset) {
    const prop = Object.keys(fieldset).find((key) => key.startsWith("__reactFiber$"));
    const fiber = prop && fieldset[prop];
    for (const candidate of [fiber, fiber?.alternate]) {
      if (!candidate) continue;
      let root = candidate;
      let depth = 0;
      while (root.return && depth++ < 100) root = root.return;
      if (root.tag === 3 && root.stateNode?.current === root) return candidate;
    }
    return null;
  }

  function readNativeComposerDraft() {
    // Compatibility adapter for Pi Web 0.9.1 ChatInput. Locate state by semantic
    // identity rather than hook indices; if upstream changes, fail closed.
    const textarea = document.querySelector("textarea.chat-input-textarea");
    const fieldset = textarea?.closest("[data-pi-native-composer-host]");
    if (!fieldset?.isConnected) return null;
    let owner = committedComposerFiber(fieldset);
    for (let depth = 0; owner && depth < 12; depth++, owner = owner.return) {
      const props = owner.memoizedProps;
      if (typeof props?.draftKey !== "string" || !props.draftKey || typeof props.onSend !== "function") continue;
      const handle = (props.ref || owner.ref)?.current;
      if (typeof handle?.restoreSubmission !== "function") return null;
      const hookNodes = [];
      const hooks = [];
      for (let hook = owner.memoizedState; hook && hooks.length < 128; hook = hook.next) {
        hookNodes.push(hook);
        hooks.push(hook.memoizedState);
      }
      if (!hooks.some((ref) => ref?.current === textarea)) return null;
      // Official contiguous refs: draftKeyRef, valueRef, attachedImagesRef,
      // pendingImageCountRef. Match the complete schema, not a numeric index.
      const matches = [];
      for (let i = 0; i < hooks.length - 3; i++) {
        if (hooks[i]?.current === props.draftKey && typeof hooks[i + 1]?.current === "string"
          && validDraftImages(hooks[i + 2]?.current)
          && typeof hooks[i + 3]?.current === "number") matches.push(i);
      }
      if (matches.length !== 1) return null;
      const i = matches[0];
      const imagesRef = hooks[i + 2];
      const imageStateHooks = hookNodes.filter((hook) =>
        hook.memoizedState === imagesRef.current && typeof hook.queue?.dispatch === "function");
      const native = { key: props.draftKey, keyRef: hooks[i], valueRef: hooks[i + 1],
        imagesRef, pendingRef: hooks[i + 3], textarea, fieldset, handle,
        imageStateHook: imageStateHooks.length === 1 ? imageStateHooks[0] : null };
      return native;
    }
    return null;
  }

  function getCurrentDraftKey() {
    return readNativeComposerDraft()?.key || null;
  }

  function nativeDraftSnapshot(ctx) {
    if (!ctx || ctx.keyRef.current !== ctx.key || typeof ctx.valueRef.current !== "string"
      || !validDraftImages(ctx.imagesRef.current)) return null;
    return {
      value: ctx.valueRef.current,
      images: ctx.imagesRef.current.map(({ data, mimeType }) => ({ data, mimeType }))
    };
  }

  function persistNativeDraft(ctx = readNativeComposerDraft()) {
    if (!isPluginEnabled("composer-draft-cache") || !ctx) return false;
    const snapshot = nativeDraftSnapshot(ctx);
    if (!snapshot) return false;
    return !snapshot.value && !snapshot.images.length
      ? removePersistedDraft(ctx.key)
      : savePersistedDraft(ctx.key, snapshot);
  }

  function saveCurrentComposerDraft() {
    return persistNativeDraft();
  }

  function queueNativeDraftSync() {
    if (draftSyncQueued || !isPluginEnabled("composer-draft-cache")) return;
    draftSyncQueued = true;
    const generation = draftRuntimeGeneration;
    Promise.resolve().then(() => {
      if (generation !== draftRuntimeGeneration) return;
      draftSyncQueued = false;
      persistNativeDraft();
    });
  }

  // Compatibility entry points remain for the session lifecycle module. Draft
  // hydration is synchronous in native getDraft(); periodic DOM restore is gone.
  function attemptComposerDraftRestore() { return false; }
  function hasPendingComposerDraftRestore() { return false; }
  function restoreComposerDraftIfNeeded() { return false; }
  function syncComposerDraftOnInterval() {}
  function syncComposerDraftSessionContext() { saveCurrentComposerDraft(); }
  function notifySessionChangedForDraft() { saveCurrentComposerDraft(); }

  function ensureDraftListeners() {
    if (draftListeners.length) return;
    const flush = () => { saveCurrentComposerDraft(); getNativeDraftStore()?.flush?.(); };
    window.addEventListener("beforeunload", flush, true);
    draftListeners.push(() => window.removeEventListener("beforeunload", flush, true));
    window.addEventListener("pagehide", flush, true);
    draftListeners.push(() => window.removeEventListener("pagehide", flush, true));
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibilityChange, true);
    draftListeners.push(() => document.removeEventListener("visibilitychange", onVisibilityChange, true));
  }

  function stopComposerDraftCache() {
    draftRuntimeGeneration++;
    draftSyncQueued = false;
    for (const cleanup of draftListeners.splice(0)) cleanup();
  }

  activeCleanups.push(stopComposerDraftCache);
  if (isPluginEnabled("composer-draft-cache")) ensureDraftListeners();
  window.__PI_ENH_GET_PERSISTED_DRAFT__ = getPersistedDraft;
  window.__PI_ENH_SAVE_PERSISTED_DRAFT__ = savePersistedDraft;
  window.__PI_ENH_REMOVE_PERSISTED_DRAFT__ = removePersistedDraft;
  window.__PI_ENH_RESTORE_COMPOSER_DRAFT__ = restoreComposerDraftIfNeeded;
  window.__PI_ENH_GET_CURRENT_DRAFT_KEY__ = getCurrentDraftKey;
  window.__PI_ENH_NOTIFY_SESSION_CHANGED_FOR_DRAFT__ = notifySessionChangedForDraft;
  window.__PI_ENH_DRAFT_CACHE_VERSION__ = 3;

  // ==========================================
  // 3.5 Composer File Direct Paste & Drop (输入框文件直接粘贴与拖放 - ChatGPT 风格卡片与防堆积自动清理)
  // ==========================================
  const TEXT_FILE_EXTENSIONS = new Set([
    // 编程语言与脚本
    "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "pyw", "rs", "go", "java", "c", "cpp", "cxx", "cc", "h", "hpp", "hxx",
    "cs", "php", "rb", "swift", "kt", "kts", "scala", "clj", "cljs", "ex", "exs", "erl", "hrl", "lua", "pl", "pm",
    "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "psm1", "vbs", "awk", "sed",
    // 网页与样式
    "html", "htm", "xhtml", "vue", "svelte", "astro", "css", "scss", "sass", "less", "styl",
    // 数据结构与配置
    "json", "jsonl", "jsonc", "yaml", "yml", "toml", "ini", "conf", "config", "cfg", "env",
    "xml", "svg", "sql", "graphql", "gql", "prisma",
    // 文本、文档与差异
    "md", "markdown", "mdx", "txt", "log", "rtf", "tex", "diff", "patch",
    // 结构化表格
    "csv", "tsv",
    // 构建与运维
    "dockerfile", "makefile", "gemfile", "pipfile", "procfile"
  ]);

  const VIDEO_FILE_EXTENSIONS = new Set([
    "mp4", "m4v", "mov", "webm", "mkv", "avi", "flv", "wmv", "3gp", "ogv", "mpeg", "mpg", "m2ts", "mts"
  ]);

  const COMPOSER_TEXT_SIZE_LIMIT = 64 * 1024; // 64KB 文本限制，优先内存暂存零磁盘占用
  const SESSION_UPLOADS_KEY = "pi-enh-session-uploads";

  let pendingComposerAttachments = [];
  let lastComposerSubmissionState = null;

  function getComposerSubmissionState() {
    let hasAnnotations = false;
    try {
      hasAnnotations = isPluginEnabled("quick-quote")
        && typeof listAnnotations === "function" && listAnnotations().length > 0;
    } catch {}
    const textarea = findComposerTextarea();
    const hasQuickReply = Boolean(isPluginEnabled("quick-action-buttons")
      && textarea
      && !isChatSessionRunning()
      && isComposerInputEmpty(textarea)
      && !composerHasAnySendPayload(textarea)
      && getActiveQuickReply());
    return {
      hasAnnotations,
      hasAttachments: isPluginEnabled("composer-file-paste") && pendingComposerAttachments.length > 0,
      hasQuickReply,
    };
  }

  function notifyComposerSubmissionStateChange() {
    const state = getComposerSubmissionState();
    const signature = `${state.hasAnnotations ? 1 : 0}:${state.hasAttachments ? 1 : 0}:${state.hasQuickReply ? 1 : 0}`;
    if (lastComposerSubmissionState === signature) return;
    lastComposerSubmissionState = signature;
    window.dispatchEvent(new Event("pi-enh-composer-submission-state-change"));
  }

  function formatFileSize(bytes) {
    if (typeof bytes !== "number" || isNaN(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1).replace(/\.0$/, "") + " KB";
    return (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "") + " MB";
  }

  function isVideoFile(fileOrName, mimeType) {
    if (!fileOrName && !mimeType) return false;
    const rawMime = typeof mimeType === "string"
      ? mimeType.trim().toLowerCase()
      : (typeof fileOrName === "object" && fileOrName && typeof fileOrName.type === "string" ? fileOrName.type.trim().toLowerCase() : "");
    if (rawMime.startsWith("video/")) return true;
    const rawName = typeof fileOrName === "string"
      ? fileOrName.trim().toLowerCase()
      : (typeof fileOrName === "object" && fileOrName && typeof fileOrName.name === "string" ? fileOrName.name.trim().toLowerCase() : "");
    if (!rawName) return false;
    const clean = rawName.split(/[?#]/)[0];
    const base = clean.split(/[\\/]/).pop() || clean;
    const ext = base.includes(".") ? base.split(".").pop() : "";
    return Boolean(ext && VIDEO_FILE_EXTENSIONS.has(ext));
  }

  function isTextFile(file) {
    if (!file) return false;
    if (file.type && file.type.toLowerCase().startsWith("video/")) return false;
    const name = (file.name || "").trim().toLowerCase();
    const base = name.split(/[\\/]/).pop() || name;
    if (base === "dockerfile" || base.startsWith("dockerfile.") ||
        base === "makefile" || base === "gnumakefile" ||
        base.startsWith(".env") || base.startsWith(".git") ||
        base === "license" || base === "cname") {
      return true;
    }
    const ext = base.includes(".") ? base.split(".").pop() : "";
    if (ext && VIDEO_FILE_EXTENSIONS.has(ext)) {
      return false;
    }
    if (ext && TEXT_FILE_EXTENSIONS.has(ext)) {
      return true;
    }
    if (file.type) {
      if (file.type.startsWith("text/")) return true;
      if (file.type === "application/json" ||
          file.type === "application/javascript" ||
          file.type === "application/xml" ||
          file.type === "application/x-yaml") {
        return true;
      }
    }
    return false;
  }

  function getLanguageForFilename(filename) {
    const clean = (filename || "").trim().toLowerCase();
    const base = clean.split(/[\\/]/).pop() || clean;
    if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
    if (base === "makefile" || base === "gnumakefile") return "makefile";
    if (base.startsWith(".env")) return "bash";
    const ext = base.includes(".") ? base.split(".").pop() : "";
    const langMap = {
      js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", mjs: "javascript", cjs: "javascript",
      py: "python", pyw: "python", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", h: "c", hpp: "cpp",
      cs: "csharp", php: "php", rb: "ruby", swift: "swift", kt: "kotlin", scala: "scala", lua: "lua",
      sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", bat: "bat", cmd: "bat",
      html: "html", htm: "html", css: "css", scss: "scss", less: "less", vue: "vue", svelte: "svelte",
      json: "json", jsonl: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", svg: "xml",
      md: "markdown", markdown: "markdown", mdx: "markdown", txt: "text", log: "text",
      sql: "sql", graphql: "graphql", gql: "graphql", csv: "csv", tsv: "tsv", diff: "diff", patch: "diff"
    };
    return langMap[ext] || ext || "text";
  }

  function getFileCategoryMeta(filename, mimeType) {
    const clean = (filename || "").trim().toLowerCase();
    const ext = clean.includes(".") ? clean.split(".").pop() : "";

    // 基础折角文档模板辅助函数 (对齐用户提供的经典红白折角 PDF 模板规范)
    const buildDocSvg = (themeColor, foldColor, badgeText, textColor = "#FFFFFF") => {
      const fontSize = badgeText.length >= 4 ? "12.5" : "14.5";
      return `<svg width="34" height="34" viewBox="0 0 100 100" fill="none"><path d="M26 12h38l18 18v54c0 4.4-3.6 8-8 8H26c-4.4 0-8-3.6-8-8V20c0-4.4 3.6-8 8-8z" fill="#FFFFFF" stroke="${themeColor}" stroke-width="7" stroke-linejoin="round"/><path d="M64 12v18h18" fill="${foldColor}" stroke="${themeColor}" stroke-width="6" stroke-linejoin="round"/><line x1="32" y1="28" x2="54" y2="28" stroke="#9CA3AF" stroke-width="4.5" stroke-linecap="round"/><line x1="32" y1="38" x2="68" y2="38" stroke="#9CA3AF" stroke-width="4.5" stroke-linecap="round"/><line x1="32" y1="48" x2="68" y2="48" stroke="#9CA3AF" stroke-width="4.5" stroke-linecap="round"/><rect x="12" y="56" width="52" height="24" rx="4.5" fill="${themeColor}"/><text x="38" y="73.5" fill="${textColor}" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="${fontSize}" font-weight="900" text-anchor="middle" letter-spacing="0.5">${badgeText}</text></svg>`;
    };

    // 1. PDF Document (严格对齐用户提供的红白折角 PDF 标志模板)
    if (ext === "pdf" || mimeType?.includes("pdf")) {
      return {
        typeLabel: "PDF Document",
        bgColor: "transparent",
        iconSvg: buildDocSvg("#EF4444", "#FEE2E2", "PDF", "#FFFFFF")
      };
    }
    // 2. Spreadsheet (以模板为标准的绿色 Excel 风格)
    if (["xlsx", "xls", "csv", "tsv", "numbers", "ods"].includes(ext) || mimeType?.includes("sheet") || mimeType?.includes("csv")) {
      return {
        typeLabel: ext === "csv" ? "CSV Data" : "Excel Spreadsheet",
        bgColor: "transparent",
        iconSvg: buildDocSvg("#107C41", "#DCFCE7", ext === "csv" ? "CSV" : "XLS", "#FFFFFF")
      };
    }
    // 3. Word Document (以模板为标准的蓝色 Word 风格)
    if (["docx", "doc", "odt", "rtf", "pages"].includes(ext) || mimeType?.includes("word") || mimeType?.includes("officedocument")) {
      return {
        typeLabel: "Word Document",
        bgColor: "transparent",
        iconSvg: buildDocSvg("#185ABD", "#DBEAFE", "DOC", "#FFFFFF")
      };
    }
    // 4. Code & Scripts (代码与配置)
    if (TEXT_FILE_EXTENSIONS.has(ext) || ["json", "yaml", "yml", "py", "ts", "js", "rs", "go"].includes(ext)) {
      const lang = getLanguageForFilename(filename);
      const labelMap = {
        python: "Python Script", javascript: "JavaScript File", typescript: "TypeScript File",
        json: "JSON Config", yaml: "YAML Config", rust: "Rust Code", go: "Go Code",
        markdown: "Markdown Note", bash: "Shell Script", text: "Text Document"
      };

      if (ext === "py" || ext === "pyw" || lang === "python") {
        return {
          typeLabel: "Python Script",
          bgColor: "transparent",
          iconSvg: buildDocSvg("#387EB8", "#E0F2FE", "PY", "#FFE052")
        };
      }
      if (ext === "ts" || ext === "tsx" || lang === "typescript") {
        return {
          typeLabel: "TypeScript File",
          bgColor: "transparent",
          iconSvg: buildDocSvg("#3178C6", "#DBEAFE", "TS", "#FFFFFF")
        };
      }
      if (ext === "js" || ext === "jsx" || lang === "javascript") {
        return {
          typeLabel: "JavaScript File",
          bgColor: "transparent",
          iconSvg: buildDocSvg("#EAB308", "#FEF9C3", "JS", "#000000")
        };
      }
      if (["json", "yaml", "yml", "toml"].includes(ext)) {
        return {
          typeLabel: labelMap[lang] || "Config File",
          bgColor: "transparent",
          iconSvg: buildDocSvg("#0D9488", "#CCFBF1", ext.toUpperCase().slice(0, 4), "#FFFFFF")
        };
      }
      return {
        typeLabel: labelMap[lang] || `${lang.toUpperCase()} Code`,
        bgColor: "transparent",
        iconSvg: buildDocSvg("#7C3AED", "#EDE9FE", "CODE", "#FFFFFF")
      };
    }
    // 5. Video (视频文件 - 在 Archive 之前)
    if (isVideoFile(filename, mimeType)) {
      const badge = (ext || "VIDEO").toUpperCase().slice(0, 5);
      const fontSize = badge.length >= 4 ? "11.5" : "13.5";
      return {
        isVideo: true,
        typeLabel: `${(ext || "VIDEO").toUpperCase()} Video`,
        bgColor: "transparent",
        iconSvg: `<svg width="34" height="34" viewBox="0 0 100 100" fill="none"><rect x="14" y="14" width="72" height="72" rx="16" fill="#EDE9FE" stroke="#8B5CF6" stroke-width="6.5"/><circle cx="50" cy="42" r="15" fill="#8B5CF6" fill-opacity="0.16"/><path d="M45 33.5L60 42L45 50.5V33.5Z" fill="#8B5CF6" stroke="#8B5CF6" stroke-width="3" stroke-linejoin="round"/><rect x="18" y="64" width="64" height="22" rx="5" fill="#8B5CF6"/><text x="50" y="79.5" fill="#FFFFFF" font-family="-apple-system, BlinkMacSystemFont, Arial, sans-serif" font-size="${fontSize}" font-weight="900" text-anchor="middle" letter-spacing="0.5">${badge}</text></svg>`
      };
    }
    // 6. Archive (压缩包)
    if (["zip", "tar", "gz", "tgz", "7z", "rar"].includes(ext)) {
      return {
        typeLabel: "Archive",
        bgColor: "transparent",
        iconSvg: buildDocSvg("#D97706", "#FEF3C7", "ZIP", "#FFFFFF")
      };
    }
    // 6. Generic File (通用文件)
    return {
      typeLabel: (ext ? ext.toUpperCase() + " " : "") + "File",
      bgColor: "transparent",
      iconSvg: buildDocSvg("#64748B", "#F1F5F9", (ext || "FILE").toUpperCase().slice(0, 4), "#FFFFFF")
    };
  }

  function formatTextFileSnippet(filename, content) {
    const lang = getLanguageForFilename(filename);
    const safeContent = content.endsWith("\n") ? content : content + "\n";
    return `### \`${filename}\`\n\`\`\`${lang}\n${safeContent}\`\`\`\n`;
  }

  function encodePathForApi(p) {
    const norm = (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")) ? p.replace(/\\/g, "/") : p;
    return norm.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  }

  function getEffectiveComposerCwdSyncOrEmpty() {
    const sessionId = getCurrentSessionId();
    if (sessionId && window.__PI_CURRENT_SESSION_DATA__?.info?.cwd) {
      return window.__PI_CURRENT_SESSION_DATA__.info.cwd;
    }
    try {
      const workspaceEl = document.querySelector("[data-current-cwd]") ||
        document.querySelector(".workspace-picker-button");
      const domCwd = workspaceEl?.getAttribute("data-current-cwd") || workspaceEl?.textContent?.trim() || "";
      if (domCwd && domCwd.length > 1 && !domCwd.includes("...")) {
        return domCwd;
      }
    } catch (e) {}
    return "";
  }

  async function getEffectiveComposerCwd() {
    const sessionId = getCurrentSessionId();
    if (sessionId && window.__PI_CURRENT_SESSION_DATA__?.info?.cwd) {
      return window.__PI_CURRENT_SESSION_DATA__.info.cwd;
    }
    try {
      const workspaceEl = document.querySelector("[data-current-cwd]") ||
        document.querySelector(".workspace-picker-button");
      const domCwd = workspaceEl?.getAttribute("data-current-cwd") || workspaceEl?.textContent?.trim() || "";
      if (domCwd && domCwd.length > 1 && !domCwd.includes("...")) {
        return domCwd;
      }
    } catch (e) {}
    if (sessionId) {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=1&deferMedia=1`);
        if (res.ok) {
          const data = await res.json();
          if (data?.info?.cwd) return data.info.cwd;
        }
      } catch (e) {}
    }
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        if (data?.cwd) return data.cwd;
      }
    } catch (e) {}
    return "";
  }

  // --- 本地磁盘安全删除接口调用 ---
  async function deleteLocalTempFiles(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return { ok: true, deleted: [], errors: [] };
    try {
      const response = await fetch("http://127.0.0.1:30149/cleanup-files", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: filePaths }),
      });
      let data = {};
      try { data = await response.json(); } catch (e) {}
      const errors = Array.isArray(data?.errors) ? data.errors : [];
      return { ok: Boolean(response?.ok) && data?.ok !== false && errors.length === 0, deleted: data?.deleted || [], errors };
    } catch (e) {
      console.warn("[Composer File Paste] delete local temp files error:", e);
      return { ok: false, deleted: [], errors: [{ error: e?.message || String(e) }] };
    }
  }

  function recordSessionUploadedFile(sessionId, filePath) {
    if (!sessionId || !filePath) return;
    try {
      const raw = localStorage.getItem(SESSION_UPLOADS_KEY);
      const map = raw ? JSON.parse(raw) : {};
      map[sessionId] = map[sessionId] || [];
      if (!map[sessionId].includes(filePath)) {
        map[sessionId].push(filePath);
        localStorage.setItem(SESSION_UPLOADS_KEY, JSON.stringify(map));
      }
    } catch (e) {}
  }

  function unrecordSessionUploadedFile(sessionId, filePath) {
    if (!sessionId || !filePath) return;
    try {
      const raw = localStorage.getItem(SESSION_UPLOADS_KEY);
      const map = raw ? JSON.parse(raw) : {};
      const remaining = Array.isArray(map[sessionId]) ? map[sessionId].filter((item) => item !== filePath) : [];
      if (remaining.length > 0) {
        map[sessionId] = remaining;
      } else {
        delete map[sessionId];
      }
      localStorage.setItem(SESSION_UPLOADS_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  async function prepareComposerUploadDirectory(cwd, sessionId) {
    if (!cwd) throw new Error("未检测到当前有效的工作区目录");
    if (!sessionId) throw new Error("请先创建会话，再添加文档或压缩包附件");
    try {
      const res = await fetch("http://127.0.0.1:30149/prepare-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, sessionId }),
      });
      if (res?.ok) {
        const data = await res.json();
        const relativeDir = String(data?.relativeDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        if (data?.uploadDir && relativeDir.startsWith(".pi-uploads/")) {
          return { uploadDir: data.uploadDir, relativeDir };
        }
      }
    } catch (e) {
      // 30149 本地桥接服务未运行或连接超时，平滑降级
    }
    const sep = String(cwd).includes("\\") ? "\\" : "/";
    const relativeDir = `.pi-uploads/${sessionId}`;
    const uploadDir = String(cwd).replace(/[\\/]+$/, "") + sep + ".pi-uploads" + sep + sessionId;
    return { uploadDir, relativeDir, fallback: true };
  }

  async function cleanupSessionUploadedFiles(sessionId) {
    if (!sessionId) return;
    try {
      const raw = localStorage.getItem(SESSION_UPLOADS_KEY);
      if (!raw) return;
      const map = JSON.parse(raw);
      const files = map[sessionId];
      if (Array.isArray(files) && files.length > 0) {
        const cleanup = await deleteLocalTempFiles(files);
        if (!cleanup.ok) {
          showToast("会话附件暂未清理；下次删除会话时将自动重试", null, 4500);
          return false;
        }
        showToast(`已自动清理会话关联的 ${files.length} 个临时附件`, null, 3000);
      }
      delete map[sessionId];
      localStorage.setItem(SESSION_UPLOADS_KEY, JSON.stringify(map));
      return true;
    } catch (e) {}
  }

  function bindComposerDraftFiles(newSessionId) {
    if (!newSessionId) return;
    try {
      const raw = localStorage.getItem(SESSION_UPLOADS_KEY);
      if (!raw) return;
      const map = JSON.parse(raw);
      for (const [key, files] of Object.entries(map)) {
        if (key.startsWith("draft-") && Array.isArray(files) && files.length > 0) {
          map[newSessionId] = [...(map[newSessionId] || []), ...files];
          delete map[key];
        }
      }
      localStorage.setItem(SESSION_UPLOADS_KEY, JSON.stringify(map));
    } catch (e) {}
  }
  window.__PI_ENH_BIND_COMPOSER_DRAFT_FILES__ = bindComposerDraftFiles;

  async function uploadComposerFile(file, cwd, safeUploadName) {
    if (!cwd) throw new Error("未检测到当前有效的工作区目录");
    const encodedPath = encodePathForApi(cwd);
    const formData = new FormData();
    let uploadItem = file;
    if (typeof Blob !== "undefined" && !(file instanceof Blob)) {
      try {
        uploadItem = new Blob([file.content || ""], { type: file.type || "application/octet-stream" });
      } catch (e) {}
    }
    formData.append("files", uploadItem, safeUploadName || file.name || "upload.bin");

    let res = await fetch(`/api/files/${encodedPath}?type=upload&conflict=overwrite`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      let errMsg = `上传失败 (HTTP ${res.status})`;
      let errData = {};
      try {
        errData = await res.json();
        if (errData.error) errMsg = errData.error;
      } catch (e) {}
      if (res.status === 413) {
        errMsg = `文件超过单次上传上限 (25MB): ${errData.error || ""}`.replace(/:\s*$/, "");
      }
      throw new Error(errMsg);
    }
    return await res.json();
  }

  const INLINE_VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);
  const INLINE_VIDEO_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/ogg"]);

  function getAttachmentExtension(filename) {
    const clean = String(filename || "").split(/[?#]/)[0];
    const base = clean.split(/[\\/]/).pop() || clean;
    const dotIndex = base.lastIndexOf(".");
    return dotIndex > 0 ? base.slice(dotIndex + 1).toLowerCase() : "";
  }

  function isInlineVideoAttachment(att) {
    const ext = getAttachmentExtension(att?.name) || getAttachmentExtension(att?.serverRelativePath);
    if (INLINE_VIDEO_EXTENSIONS.has(ext)) return true;
    if (ext) return false;
    return INLINE_VIDEO_MIME_TYPES.has(String(att?.type || "").trim().toLowerCase());
  }

  function getMimeTypeFromExt(filename) {
    const ext = getAttachmentExtension(filename);
    const map = {
      pdf: "application/pdf",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      doc: "application/msword",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      mp4: "video/mp4",
      m4v: "video/mp4",
      mov: "video/quicktime",
      webm: "video/webm",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
      flv: "video/x-flv",
      wmv: "video/x-ms-wmv",
      "3gp": "video/3gpp",
      ogv: "video/ogg",
      mpeg: "video/mpeg",
      mpg: "video/mpeg",
      m2ts: "video/mp2t",
      mts: "video/mp2t",
      txt: "text/plain",
      json: "application/json",
      csv: "text/csv",
      zip: "application/zip",
      tar: "application/x-tar",
      gz: "application/gzip",
    };
    return map[ext] || "application/octet-stream";
  }

  function resolveAttachmentApiUrl(att, cwd, type = "read") {
    const relPath = att.serverRelativePath || att.name;
    let fullPath = relPath;
    if (cwd && !relPath.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(relPath) && !relPath.startsWith("\\\\")) {
      const sep = String(cwd).includes("\\") ? "\\" : "/";
      fullPath = String(cwd).replace(/[\\/]+$/, "") + sep + relPath.replace(/^\/+/, "");
    }
    const encoded = encodePathForApi(fullPath);
    return `/api/files/${encoded}?type=${type}`;
  }

  let activeVideoPreviewBackdrop = null;
  let activeVideoPreviewEscHandler = null;
  let activeVideoPreviewObjectUrl = "";
  let activeVideoPreviewRequestToken = 0;

  function revokeVideoPreviewObjectUrl(url) {
    if (!url || typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
    try { URL.revokeObjectURL(url); } catch (e) {}
  }

  function revokeActiveVideoPreviewObjectUrl() {
    revokeVideoPreviewObjectUrl(activeVideoPreviewObjectUrl);
    activeVideoPreviewObjectUrl = "";
  }

  async function fetchVideoDownloadObjectUrl(att, cwd) {
    const downloadUrl = (att?.serverRelativePath || att?.name)
      ? resolveAttachmentApiUrl(att, cwd, "download")
      : "";
    if (!downloadUrl || typeof fetch !== "function" || typeof URL === "undefined"
      || typeof URL.createObjectURL !== "function" || typeof Blob === "undefined") return "";
    try {
      const response = await fetch(downloadUrl);
      if (!response?.ok) return "";
      const responseBlob = await response.blob();
      const attachmentMime = String(att?.type || "").trim();
      const fallbackMime = getMimeTypeFromExt(att?.name || att?.serverRelativePath);
      const mimeType = attachmentMime || fallbackMime || responseBlob.type || "";
      const playableBlob = mimeType && responseBlob.type !== mimeType
        ? new Blob([responseBlob], { type: mimeType })
        : responseBlob;
      return URL.createObjectURL(playableBlob);
    } catch (e) {
      return "";
    }
  }

  function closeVideoPreviewModal() {
    activeVideoPreviewRequestToken++;
    revokeActiveVideoPreviewObjectUrl();
    if (activeVideoPreviewEscHandler && typeof document !== "undefined") {
      document.removeEventListener("keydown", activeVideoPreviewEscHandler, true);
      activeVideoPreviewEscHandler = null;
    }
    if (activeVideoPreviewBackdrop) {
      try {
        const video = activeVideoPreviewBackdrop.querySelector?.("video");
        if (video) {
          try { video.pause?.(); } catch (e) {}
          video.removeAttribute?.("src");
          try { video.load?.(); } catch (e) {}
        }
        activeVideoPreviewBackdrop.remove?.();
      } catch (e) {}
      activeVideoPreviewBackdrop = null;
    }
  }

  function openVideoPreviewModal(att, cwd) {
    if (!att) return null;
    const effectiveCwd = cwd || getEffectiveComposerCwdSyncOrEmpty();
    const hasAttachmentPath = Boolean(att.serverRelativePath || att.name);
    const inlineVideo = isInlineVideoAttachment(att);
    const apiReadUrl = hasAttachmentPath
      ? resolveAttachmentApiUrl(att, effectiveCwd, "read")
      : "";
    const apiDownloadUrl = hasAttachmentPath
      ? resolveAttachmentApiUrl(att, effectiveCwd, "download")
      : "";
    // The read endpoint is a Range-capable inline stream only for the five
    // MIME extensions supported by the server. Other videos must never receive
    // its JSON metadata response as a <video> source.
    const videoSrc = att.previewUrl || (inlineVideo ? apiReadUrl : "");
    const fallbackVideoSrc = videoSrc || apiDownloadUrl;
    if (!fallbackVideoSrc) return null;

    if (typeof document === "undefined" || !document.body || typeof document.createElement !== "function") {
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(fallbackVideoSrc, "_blank");
      }
      return null;
    }

    closeVideoPreviewModal();
    const requestToken = activeVideoPreviewRequestToken;
    let currentVideoSource = videoSrc || apiDownloadUrl;

    const meta = getFileCategoryMeta(att.name, att.type);
    const sizeStr = att.sizeStr || formatFileSize(att.size);
    const subtitleText = sizeStr ? `${meta.typeLabel} · ${sizeStr}` : meta.typeLabel;
    const rawName = String(att.name || "视频预览");

    const backdrop = document.createElement("div");
    backdrop.className = "pi-enh-video-preview-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", `视频预览: ${rawName}`);

    const modal = document.createElement("div");
    modal.className = "pi-enh-video-preview-modal";
    modal.addEventListener("click", (e) => e.stopPropagation());

    const header = document.createElement("div");
    header.className = "pi-enh-video-preview-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "pi-enh-video-preview-title-wrap";

    const titleEl = document.createElement("div");
    titleEl.className = "pi-enh-video-preview-title";
    titleEl.textContent = rawName;
    titleEl.title = rawName;

    const subtitleEl = document.createElement("div");
    subtitleEl.className = "pi-enh-video-preview-subtitle";
    subtitleEl.textContent = subtitleText;

    titleWrap.appendChild(titleEl);
    titleWrap.appendChild(subtitleEl);

    const actions = document.createElement("div");
    actions.className = "pi-enh-video-preview-actions";

    const openTabBtn = document.createElement("button");
    openTabBtn.type = "button";
    openTabBtn.className = "pi-enh-video-preview-btn";
    openTabBtn.title = "新窗口打开";
    openTabBtn.textContent = "新窗口打开";
    openTabBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const targetUrl = currentVideoSource || apiDownloadUrl;
      if (typeof window !== "undefined" && typeof window.open === "function") {
        window.open(targetUrl, "_blank");
      }
    });

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "pi-enh-video-preview-btn";
    downloadBtn.title = "下载视频";
    downloadBtn.textContent = "下载";
    downloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (att.previewUrl && !att.serverRelativePath) {
        const a = document.createElement("a");
        a.href = att.previewUrl;
        a.download = rawName;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 100);
      } else {
        downloadAttachmentFile(att, effectiveCwd);
      }
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "pi-enh-video-preview-btn pi-enh-video-preview-close";
    closeBtn.title = "关闭预览 (Esc)";
    closeBtn.setAttribute("aria-label", "关闭视频预览");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeVideoPreviewModal();
    });

    actions.appendChild(openTabBtn);
    actions.appendChild(downloadBtn);
    actions.appendChild(closeBtn);

    header.appendChild(titleWrap);
    header.appendChild(actions);

    const body = document.createElement("div");
    body.className = "pi-enh-video-preview-body";

    const player = document.createElement("video");
    player.className = "pi-enh-video-preview-player";
    player.controls = true;
    player.autoplay = true;
    player.playsInline = true;
    player.preload = "metadata";
    player.setAttribute("controls", "");
    player.setAttribute("playsinline", "");
    player.setAttribute("preload", "metadata");
    if (videoSrc) player.src = videoSrc;

    body.appendChild(player);
    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        closeVideoPreviewModal();
      }
    });

    activeVideoPreviewEscHandler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === "function") {
          e.stopImmediatePropagation();
        }
        closeVideoPreviewModal();
      }
    };
    document.addEventListener("keydown", activeVideoPreviewEscHandler, true);

    const playPlayer = () => {
      try {
        const playPromise = player.play?.();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {});
        }
      } catch (e) {}
    };

    document.body.appendChild(backdrop);
    activeVideoPreviewBackdrop = backdrop;
    if (videoSrc) {
      playPlayer();
    } else {
      void (async () => {
        const objectUrl = await fetchVideoDownloadObjectUrl(att, effectiveCwd);
        if (requestToken !== activeVideoPreviewRequestToken || activeVideoPreviewBackdrop !== backdrop) {
          revokeVideoPreviewObjectUrl(objectUrl);
          return;
        }
        if (objectUrl) {
          activeVideoPreviewObjectUrl = objectUrl;
          currentVideoSource = objectUrl;
          player.src = objectUrl;
        } else {
          // A binary download URL is still a safe fallback; unlike type=read,
          // it cannot be mistaken for the endpoint's JSON metadata response.
          currentVideoSource = apiDownloadUrl;
          player.src = apiDownloadUrl;
        }
        try { player.load?.(); } catch (e) {}
        playPlayer();
      })();
    }
    return backdrop;
  }

  function attachVideoThumbnailToIconWrap(iconWrap, videoSrc, fallbackSvg) {
    if (!iconWrap || !videoSrc || typeof document === "undefined" || typeof document.createElement !== "function") return;
    try {
      iconWrap.classList.add("pi-enh-attachment-icon-video");
      iconWrap.innerHTML = "";
      const videoEl = document.createElement("video");
      videoEl.className = "pi-enh-attachment-video-thumb";
      videoEl.src = videoSrc;
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.preload = "metadata";
      videoEl.setAttribute("muted", "");
      videoEl.setAttribute("playsinline", "");
      videoEl.setAttribute("preload", "metadata");
      videoEl.addEventListener("loadeddata", () => {
        try {
          if (videoEl.currentTime === 0 && videoEl.duration > 0.1) {
            videoEl.currentTime = 0.1;
          }
        } catch (e) {}
      }, { once: true });
      videoEl.addEventListener("error", () => {
        iconWrap.classList.remove("pi-enh-attachment-icon-video");
        iconWrap.innerHTML = fallbackSvg;
      }, { once: true });

      const badge = document.createElement("span");
      badge.className = "pi-enh-attachment-video-play-badge";
      badge.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v14l11-7-11-7z"/></svg>`;

      iconWrap.appendChild(videoEl);
      iconWrap.appendChild(badge);
    } catch (e) {
      iconWrap.innerHTML = fallbackSvg;
    }
  }

  function openAttachmentPreview(att, cwd) {
    if (!att) return;
    const effectiveCwd = cwd || getEffectiveComposerCwdSyncOrEmpty();
    if (isVideoFile(att.name, att.type)) {
      openVideoPreviewModal(att, effectiveCwd);
      return;
    }
    const ext = (att.name || "").split(".").pop().toLowerCase();
    const type = ext === "docx" ? "preview" : "read";
    const url = resolveAttachmentApiUrl(att, effectiveCwd, type);
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank");
    }
  }

  function downloadAttachmentFile(att, cwd) {
    const url = resolveAttachmentApiUrl(att, cwd, "download");
    if (typeof document !== "undefined") {
      const a = document.createElement("a");
      a.href = url;
      a.download = att.name || "download";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => a.remove(), 100);
    }
  }

  // --- 用户消息气泡内全生命周期附件卡片渲染 ---
  function createUserMessageAttachmentPillCard(att, cwd) {
    const card = document.createElement("div");
    card.className = "pi-enh-msg-attachment-pill";
    card.setAttribute("data-attachment-name", att.name || "");
    if (att.serverRelativePath) card.setAttribute("data-attachment-path", att.serverRelativePath);

    const meta = getFileCategoryMeta(att.name, att.type);
    const sizeStr = att.sizeStr || formatFileSize(att.size);
    const descText = sizeStr ? `${meta.typeLabel} · ${sizeStr}` : meta.typeLabel;
    const rawName = String(att.name || "未命名文件");

    const iconWrap = document.createElement("div");
    iconWrap.className = "pi-enh-msg-attachment-icon";
    iconWrap.style.background = meta.bgColor;
    iconWrap.innerHTML = meta.iconSvg;
    if (meta.isVideo) {
      card.classList.add("pi-enh-attachment-card-video");
      card.title = "点击预览播放视频";
      const videoSrc = att.previewUrl || (
        isInlineVideoAttachment(att) && (att.serverRelativePath || att.name)
          ? resolveAttachmentApiUrl(att, cwd, "read")
          : ""
      );
      if (videoSrc) {
        attachVideoThumbnailToIconWrap(iconWrap, videoSrc, meta.iconSvg);
      }
    }

    const metaWrap = document.createElement("div");
    metaWrap.className = "pi-enh-msg-attachment-meta";

    const nameEl = document.createElement("div");
    nameEl.className = "pi-enh-msg-attachment-name";
    nameEl.textContent = rawName;
    nameEl.title = `${rawName} (${descText})`;

    const descEl = document.createElement("div");
    descEl.className = "pi-enh-msg-attachment-desc";
    descEl.textContent = descText;

    metaWrap.appendChild(nameEl);
    metaWrap.appendChild(descEl);

    const actionsWrap = document.createElement("div");
    actionsWrap.className = "pi-enh-msg-attachment-actions";

    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "pi-enh-msg-attachment-btn";
    previewBtn.title = "预览/查看文件";
    previewBtn.setAttribute("aria-label", "预览文件");
    previewBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    previewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      openAttachmentPreview(att, cwd);
    });

    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "pi-enh-msg-attachment-btn";
    downloadBtn.title = "下载文件";
    downloadBtn.setAttribute("aria-label", "下载文件");
    downloadBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;
    downloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      downloadAttachmentFile(att, cwd);
    });

    actionsWrap.appendChild(previewBtn);
    actionsWrap.appendChild(downloadBtn);

    card.appendChild(iconWrap);
    card.appendChild(metaWrap);
    card.appendChild(actionsWrap);

    card.addEventListener("click", (e) => {
      if (e.target.closest(".pi-enh-msg-attachment-btn")) return;
      openAttachmentPreview(att, cwd);
    });

    return card;
  }

  function extractOriginalFilename(rawPathOrName) {
    const base = String(rawPathOrName || "").split(/[\\/]/).pop() || "";
    if (!base.startsWith(".pi-upload-")) return base;
    let rest = base.slice(".pi-upload-".length);
    const m = rest.match(/^[a-z0-9]+-(.+?\.[a-zA-Z0-9]+)$/);
    if (m) {
      const firstPart = rest.slice(0, rest.indexOf("-"));
      if (/\d/.test(firstPart) || firstPart.length >= 8) {
        const sub = m[1];
        const dashIdx = sub.indexOf("-");
        if (dashIdx > 0) {
          const secondPart = sub.slice(0, dashIdx);
          if (/\d/.test(secondPart) || secondPart.length >= 8) {
            return sub.slice(dashIdx + 1);
          }
        }
        return m[1];
      }
    }
    return rest;
  }

  function extractAttachmentsFromUserMessage(msgEl, currentSessionId) {
    const attachments = [];
    const seen = new Set();
    const text = msgEl ? (msgEl.textContent || "") : "";

    // 1. 匹配标准附件标注: [附件: 采购协议.pdf (@.pi-uploads/xxx/.pi-upload-yyy-采购协议.pdf) - 150 KB]
    const regexNew = /\[附件:\s*([^\]\(@]+?)\s*(?:\(@?([^)]+)\))?\s*(?:-\s*([^\]]+))?\]/g;
    let match;
    while ((match = regexNew.exec(text)) !== null) {
      const rawFirst = (match[1] || "").trim();
      const rawSecond = (match[2] || "").trim();
      const rawSize = (match[3] || "").trim();

      let name = rawFirst;
      let relPath = rawSecond || "";

      if (rawFirst.startsWith("@") || rawFirst.includes(".pi-upload")) {
        relPath = rawFirst.replace(/^@/, "");
        name = extractOriginalFilename(relPath);
      } else if (relPath && (!name || name.startsWith("att-") || name.includes(".pi-upload"))) {
        name = extractOriginalFilename(relPath);
      }

      const key = relPath || name;
      if (name && !seen.has(key)) {
        seen.add(key);
        attachments.push({
          id: "msg-att-" + Math.random().toString(36).slice(2, 9),
          name: name,
          serverRelativePath: relPath,
          sizeStr: rawSize,
          type: getMimeTypeFromExt(name),
        });
      }
    }

    // 2. 匹配旧版简单格式 [附件: @...]
    const regexOld = /\[附件:\s*@?([^\s\]]+)\]/g;
    while ((match = regexOld.exec(text)) !== null) {
      const rawPath = match[1].trim();
      const name = extractOriginalFilename(rawPath);
      if (name && !seen.has(rawPath)) {
        seen.add(rawPath);
        attachments.push({
          id: "msg-att-" + Math.random().toString(36).slice(2, 9),
          name: name,
          serverRelativePath: rawPath,
          type: getMimeTypeFromExt(name),
        });
      }
    }

    // 3. 检查是否有当前会话关联的上传记录
    if (attachments.length === 0 && currentSessionId) {
      try {
        const raw = localStorage.getItem(SESSION_UPLOADS_KEY);
        if (raw) {
          const map = JSON.parse(raw);
          const files = map[currentSessionId];
          if (Array.isArray(files) && files.length > 0) {
            const allUserMsgs = document.querySelectorAll(".markdown-user-message");
            if (allUserMsgs[0] === msgEl) {
              for (const fileAbs of files) {
                const name = extractOriginalFilename(fileAbs);
                if (name && !seen.has(fileAbs)) {
                  seen.add(fileAbs);
                  attachments.push({
                    id: "msg-att-" + Math.random().toString(36).slice(2, 9),
                    name: name,
                    serverRelativePath: fileAbs,
                    serverAbsPath: fileAbs,
                    type: getMimeTypeFromExt(name),
                  });
                }
              }
            }
          }
        }
      } catch (e) {}
    }

    return attachments;
  }

  function hideAttachmentSyntaxInMessage(msgEl) {
    if (!msgEl) return;
    try {
      if (typeof document === "undefined" || typeof document.createTreeWalker !== "function") return;
      const walker = document.createTreeWalker(msgEl, 4 /* NodeFilter.SHOW_TEXT */, null, false);
      const nodesToReplace = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && /\[附件:\s*[^\]]+\]/.test(node.nodeValue)) {
          nodesToReplace.push(node);
        }
      }
      for (const textNode of nodesToReplace) {
        const val = textNode.nodeValue;
        const parts = val.split(/(\[附件:\s*[^\]]+\])/);
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          if (/^\[附件:\s*[^\]]+\]$/.test(p)) {
            const span = document.createElement("span");
            span.className = "pi-enh-msg-attachment-hidden-mark";
            span.textContent = p;
            span.style.display = "none";
            frag.appendChild(span);
          } else if (p) {
            frag.appendChild(document.createTextNode(p));
          }
        }
        textNode.parentNode?.replaceChild(frag, textNode);
      }
    } catch (e) {}
  }

  function hideDimensionNotesInMessage(msgEl) {
    if (!msgEl) return;
    try {
      if (typeof document === "undefined" || typeof document.createTreeWalker !== "function") return;
      const dimRegex = /\[Image:\s*original\s+[^\]]+\]/i;
      const walker = document.createTreeWalker(msgEl, 4 /* NodeFilter.SHOW_TEXT */, null, false);
      const nodesToReplace = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue && dimRegex.test(node.nodeValue)) {
          nodesToReplace.push(node);
        }
      }
      for (const textNode of nodesToReplace) {
        const val = textNode.nodeValue;
        const parts = val.split(/(\[Image:\s*original\s+[^\]]+\])/i);
        const frag = document.createDocumentFragment();
        for (const p of parts) {
          if (/^\[Image:\s*original\s+[^\]]+\]$/i.test(p)) {
            const span = document.createElement("span");
            span.className = "pi-enh-msg-dimension-hidden-mark";
            span.textContent = p;
            span.style.display = "none";
            frag.appendChild(span);
          } else if (p) {
            frag.appendChild(document.createTextNode(p));
          }
        }
        const parent = textNode.parentNode;
        parent?.replaceChild(frag, textNode);
        if (parent && parent !== msgEl && parent.nodeType === 1) {
          const visibleText = parent.textContent?.replace(dimRegex, "").trim();
          if (!visibleText && parent.children.length > 0) {
            const allHidden = Array.from(parent.children).every(
              (c) => c.classList?.contains("pi-enh-msg-dimension-hidden-mark") || c.classList?.contains("pi-enh-msg-attachment-hidden-mark") || c.style?.display === "none"
            );
            if (allHidden) {
              parent.setAttribute("data-pi-enh-empty-container-hidden", "true");
              parent.style.display = "none";
            }
          }
        }
      }
    } catch (e) {}
  }

  function syncUserMessageAttachmentCards() {
    if (typeof document === "undefined") return;

    const userMessages = document.querySelectorAll(".markdown-user-message");
    if (!userMessages || userMessages.length === 0) return;

    const currentSessionId = getCurrentSessionId();
    const cwd = window.__PI_CURRENT_SESSION_DATA__?.info?.cwd || "";

    for (const msgEl of userMessages) {
      hideAttachmentSyntaxInMessage(msgEl);
      hideDimensionNotesInMessage(msgEl);

      const bubble = msgEl.parentElement;
      if (!bubble) continue;

      if (!isPluginEnabled("composer-file-paste")) {
        continue;
      }

      const attachments = extractAttachmentsFromUserMessage(msgEl, currentSessionId);
      let bar = bubble.querySelector(".pi-enh-message-attachments");

      if (attachments.length === 0) {
        if (bar) bar.remove();
        continue;
      }

      const renderKey = attachments.map((a) => `${a.name}|${a.serverRelativePath || ""}|${a.sizeStr || ""}`).join(";;;");
      if (bar && bar.getAttribute("data-attachments-key") === renderKey) {
        continue;
      }

      if (!bar) {
        bar = document.createElement("div");
        bar.className = "pi-enh-message-attachments";
        bubble.insertBefore(bar, msgEl);
      } else {
        if (typeof bar.replaceChildren === "function") {
          bar.replaceChildren();
        } else {
          bar.innerHTML = "";
        }
      }
      bar.setAttribute("data-attachments-key", renderKey);

      for (const att of attachments) {
        const card = createUserMessageAttachmentPillCard(att, cwd);
        bar.appendChild(card);
      }
    }
  }

  function removeUserMessageAttachmentCards() {
    if (typeof document === "undefined") return;
    const bars = document.querySelectorAll(".pi-enh-message-attachments");
    for (const bar of bars) bar.remove();
    const hiddenMarks = document.querySelectorAll(".pi-enh-msg-attachment-hidden-mark");
    for (const mark of hiddenMarks) {
      mark.style.display = "";
      mark.classList.remove("pi-enh-msg-attachment-hidden-mark");
    }
    const hiddenDimMarks = document.querySelectorAll(".pi-enh-msg-dimension-hidden-mark");
    for (const mark of hiddenDimMarks) {
      mark.style.display = "";
      mark.classList.remove("pi-enh-msg-dimension-hidden-mark");
    }
    const emptyContainers = document.querySelectorAll('[data-pi-enh-empty-container-hidden="true"]');
    for (const c of emptyContainers) {
      c.style.display = "";
      c.removeAttribute("data-pi-enh-empty-container-hidden");
    }
  }

  function revokeAttachmentPreviewUrl(att) {
    if (att && att.previewUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      try { URL.revokeObjectURL(att.previewUrl); } catch (e) {}
      att.previewUrl = "";
    }
  }

  // --- ChatGPT 风格胶囊卡片渲染与管理 ---
  function createAttachmentPillCard(att, onRemove) {
    const card = document.createElement("div");
    card.className = "pi-enh-attachment-card";
    card.setAttribute("data-attachment-id", att.id);
    card.style.flexShrink = "0";

    const meta = getFileCategoryMeta(att.name, att.type);
    const sizeStr = formatFileSize(att.size);
    const descText = sizeStr ? `${meta.typeLabel} · ${sizeStr}` : meta.typeLabel;

    // 确保真实文件名未经 URL 编码/转义，保留中文、空格与原始字符
    const rawName = String(att.name || "未命名文件");

    const iconWrap = document.createElement("div");
    iconWrap.className = "pi-enh-attachment-icon-wrap";
    iconWrap.style.background = meta.bgColor;
    iconWrap.innerHTML = meta.iconSvg;

    if (meta.isVideo) {
      card.classList.add("pi-enh-attachment-card-video");
      card.title = "点击预览播放视频";
      const cwd = getEffectiveComposerCwdSyncOrEmpty();
      const videoSrc = att.previewUrl || (
        isInlineVideoAttachment(att) && (att.serverRelativePath || att.name)
          ? resolveAttachmentApiUrl(att, cwd, "read")
          : ""
      );
      if (videoSrc) {
        attachVideoThumbnailToIconWrap(iconWrap, videoSrc, meta.iconSvg);
      }
      card.addEventListener("click", (e) => {
        if (e.target?.closest?.(".pi-enh-attachment-remove")) return;
        e.stopPropagation();
        openAttachmentPreview(att, getEffectiveComposerCwdSyncOrEmpty());
      });
    }

    const metaWrap = document.createElement("div");
    metaWrap.className = "pi-enh-attachment-meta";

    const nameEl = document.createElement("div");
    nameEl.className = "pi-enh-attachment-name";
    nameEl.textContent = rawName;
    nameEl.title = rawName;

    const descEl = document.createElement("div");
    descEl.className = "pi-enh-attachment-desc";
    descEl.textContent = descText;

    metaWrap.appendChild(nameEl);
    metaWrap.appendChild(descEl);

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "pi-enh-attachment-remove";
    removeBtn.setAttribute("aria-label", "移除附件");
    removeBtn.title = "移除该附件";
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      onRemove(att);
    });

    card.appendChild(iconWrap);
    card.appendChild(metaWrap);
    card.appendChild(removeBtn);

    return card;
  }

  function findComposerAttachmentBar(textarea) {
    if (!textarea) return null;
    const host = textarea.parentElement || textarea;
    const grandParent = host.parentElement;
    const composerCard = textarea.closest?.('.pi-enh-cursor-composer, [data-pi-native-composer-host] > div[style*="max-width"]') || grandParent;
    return composerCard?.querySelector?.(".pi-enh-attachments-bar") || grandParent?.querySelector?.(".pi-enh-attachments-bar") || host?.querySelector?.(".pi-enh-attachments-bar") || null;
  }

  function syncComposerAttachmentBar(textarea) {
    if (!textarea) return;
    const host = textarea.parentElement || textarea;
    const grandParent = host.parentElement;
    const composerCard = textarea.closest?.('.pi-enh-cursor-composer, [data-pi-native-composer-host] > div[style*="max-width"]') || grandParent;
    let bar = findComposerAttachmentBar(textarea);

    if (pendingComposerAttachments.length === 0) {
      if (bar) bar.remove();
      if (typeof syncEmptySendContinue === "function") syncEmptySendContinue();
      return;
    }

    // 查找原生图片预览容器（绝不移动或重排原生图片节点，增强自有 bar 挂入其中复用同一 flex 行）
    const nativeImgContainer = composerCard?.querySelector?.(
      'div[style*="flex-wrap"]:has(img), .pi-enh-cursor-attachments'
    );

    if (nativeImgContainer) {
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "pi-enh-attachments-bar";
        nativeImgContainer.appendChild(bar);
      } else if (bar.parentElement !== nativeImgContainer) {
        nativeImgContainer.appendChild(bar);
      }
    } else {
      // 只有文件或原生图片容器卸载时：bar 挂到 composerCard 下的 host 之前，占据 grid-row: 1 顶行
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "pi-enh-attachments-bar";
        if (grandParent) {
          grandParent.insertBefore(bar, host);
        } else {
          host.appendChild(bar);
        }
      } else if (bar.parentElement !== grandParent && grandParent) {
        grandParent.insertBefore(bar, host);
      }
    }

    // 主同步循环每 800ms 执行一次；队列未变化时绝不能重建卡片，否则入场动画会造成闪动。
    const renderKey = pendingComposerAttachments.map((att) => [att.id, att.name, att.size, att.type, att.serverRelativePath || "", att.isText ? "text" : "file"].join("\u001f")).join("\u001e");
    if (bar.getAttribute("data-pi-enh-attachments-key") === renderKey) {
      if (typeof syncEmptySendContinue === "function") syncEmptySendContinue();
      return;
    }

    // 显式移除旧卡片：兼容原生 DOM 与轻量测试 DOM，避免重复渲染附件。
    if (typeof bar.replaceChildren === "function") {
      bar.replaceChildren();
    } else {
      for (const child of Array.from(bar.children || [])) child.remove?.();
      bar.innerHTML = "";
    }
    for (const att of pendingComposerAttachments) {
      const card = createAttachmentPillCard(att, async (targetAtt) => {
        revokeAttachmentPreviewUrl(targetAtt);
        pendingComposerAttachments = pendingComposerAttachments.filter(x => x.id !== targetAtt.id);
        notifyComposerSubmissionStateChange();
        syncComposerAttachmentBar(textarea);
        if (targetAtt.serverAbsPath) {
          const cleanup = await deleteLocalTempFiles([targetAtt.serverAbsPath]);
          if (cleanup.ok) {
            unrecordSessionUploadedFile(targetAtt.sessionId, targetAtt.serverAbsPath);
          } else {
            showToast("附件已从输入框移除，临时文件将在删除会话时自动重试清理", null, 4500);
          }
        }
      });
      bar.appendChild(card);
    }
    bar.setAttribute("data-pi-enh-attachments-key", renderKey);
    if (typeof syncEmptySendContinue === "function") syncEmptySendContinue();
  }

  let composerFileProcessingGeneration = 0;

  async function processComposerFiles(files, textarea) {
    if (!files || files.length === 0 || !textarea) return;
    const generation = composerFileProcessingGeneration;
    const isCurrent = () => generation === composerFileProcessingGeneration
      && (!activeComposerPasteTextarea || activeComposerPasteTextarea === textarea)
      && isPluginEnabled("composer-file-paste");

    for (const file of files) {
      if (!isCurrent()) return;
      const isText = isTextFile(file) && (typeof file.size !== "number" || file.size <= COMPOSER_TEXT_SIZE_LIMIT);

      if (isText) {
        // 纯文本/代码文件：保存在内存附件卡片中，零磁盘残留！
        try {
          let textContent = "";
          if (typeof file.text === "function") {
            textContent = await file.text();
          } else if (typeof FileReader !== "undefined") {
            textContent = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result || ""));
              reader.onerror = reject;
              reader.readAsText(file);
            });
          }
          if (!isCurrent()) return;

          const attId = "att-" + Math.random().toString(36).slice(2, 9);
          pendingComposerAttachments.push({
            id: attId,
            name: file.name, // 原始未转义文件名！
            size: file.size,
            type: file.type,
            isText: true,
            textContent: textContent,
            uploaded: false,
          });

          notifyComposerSubmissionStateChange();
          syncComposerAttachmentBar(textarea);
          showToast(`已添加附件: ${file.name}`, null, 2400);
        } catch (err) {
          if (!isCurrent()) return;
          console.error("[Composer File Paste] 读取文本失败:", err);
          showToast(`读取文件失败: ${file.name}`, null, 4000);
        }
      } else {
        // 二进制/文档/大文件：先创建会话隔离目录，再经 Pi Web 原生上传接口写入。
        showToast(`正在上传附件: ${file.name}...`, null, 2400);
        try {
          const cwd = await getEffectiveComposerCwd();
          if (!isCurrent()) return;
          const sessionId = getCurrentSessionId() || ("draft-" + Math.random().toString(36).slice(2, 10));
          const prepared = await prepareComposerUploadDirectory(cwd, sessionId);
          if (!isCurrent()) return;
          const originalName = String(file.name || "upload.bin").replace(/[\\/\0]/g, "_");
          const uniqueId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
          const safeUploadName = `.pi-upload-${uniqueId}-${originalName}`;

          let uploadTargetDir = prepared.uploadDir;
          const sep = String(cwd).includes("\\") ? "\\" : "/";
          let serverRelativePath = `${prepared.relativeDir}/${safeUploadName}`;
          let serverAbsPath = String(prepared.uploadDir).replace(/[\\/]+$/, "") + sep + safeUploadName;

          try {
            await uploadComposerFile(file, uploadTargetDir, safeUploadName);
          } catch (uploadErr) {
            if (String(uploadErr.message || "").includes("Upload directory not found") || String(uploadErr.message || "").includes("404")) {
              uploadTargetDir = cwd;
              serverRelativePath = safeUploadName;
              serverAbsPath = String(cwd).replace(/[\\/]+$/, "") + sep + safeUploadName;
              await uploadComposerFile(file, uploadTargetDir, safeUploadName);
            } else {
              throw uploadErr;
            }
          }

          if (!isCurrent()) {
            await deleteLocalTempFiles([serverAbsPath]);
            return;
          }
          recordSessionUploadedFile(sessionId, serverAbsPath);

          let previewUrl = "";
          if (isVideoFile(file.name, file.type) && typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined" && file instanceof Blob) {
            try { previewUrl = URL.createObjectURL(file); } catch (e) {}
          }

          const attId = "att-" + Math.random().toString(36).slice(2, 9);
          pendingComposerAttachments.push({
            id: attId,
            name: file.name, // 原始真实未转义文件名
            size: file.size,
            type: file.type || getMimeTypeFromExt(file.name),
            isText: false,
            isVideo: isVideoFile(file.name, file.type),
            previewUrl,
            sessionId,
            serverRelativePath,
            serverAbsPath,
            uploaded: true,
          });

          notifyComposerSubmissionStateChange();
          syncComposerAttachmentBar(textarea);
          showToast(`已添加附件: ${file.name}`, null, 3000);
        } catch (err) {
          if (!isCurrent()) return;
          console.error("[Composer File Paste] 上传失败:", err);
          showToast(`上传失败: ${err.message || file.name}`, null, 4500);
        }
      }
    }
  }

  activeComposerPasteTextarea = null;
  let activeComposerPasteHost = null;
  let activeComposerFileInput = null;
  let composerPasteHandler = null;
  let composerDragOverHandler = null;
  let composerDragLeaveHandler = null;
  let composerDropHandler = null;
  let composerHostDragOverHandler = null;
  let composerHostDragLeaveHandler = null;
  let composerHostDropHandler = null;
  let composerFileInputChangeHandler = null;
  let composerDocumentPickerInput = null;
  let composerDocumentPickerGeneration = 0;

  function removeComposerDocumentPicker() {
    composerDocumentPickerGeneration += 1;
    composerDocumentPickerInput?.remove();
    composerDocumentPickerInput = null;
  }

  function openComposerDocumentPicker(card) {
    if (!isPluginEnabled("composer-file-paste")) {
      showToast("请先启用文件附件功能", null, 2400);
      return;
    }
    const textarea = findComposerTextarea();
    if (!textarea || !card?.isConnected) return;
    removeComposerDocumentPicker();
    const generation = composerDocumentPickerGeneration;
    const root = textarea.closest("[data-pi-native-composer-host]") || textarea.closest("form");
    const imageInput = root?.querySelector('input[type="file"]');
    const isCurrent = () => generation === composerDocumentPickerGeneration
      && card.isConnected && textarea.isConnected && findComposerTextarea() === textarea
      && isPluginEnabled("composer-file-paste");
    const consumeFiles = (files) => {
      if (!isCurrent()) return;
      const images = files.filter((file) => file.type.startsWith("image/") && !isVideoFile(file.name, file.type));
      const attachments = files.filter((file) => !images.includes(file));
      if (images.length) {
        // Images still enter the existing native ChatInput handler, never a second image owner.
        if (imageInput && typeof DataTransfer !== "undefined") {
          const transfer = new DataTransfer();
          images.forEach((file) => transfer.items.add(file));
          imageInput.files = transfer.files;
          imageInput.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          showToast("此浏览器请使用输入框图片按钮添加图片", null, 3000);
        }
      }
      if (attachments.length) void processComposerFiles(attachments, textarea);
    };
    const openInputFallback = () => {
      if (!isCurrent()) return;
      // Independent enhancement-owned host: do not retarget React's media input.
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.hidden = true;
      input.setAttribute("data-pi-document-picker", "true");
      const ua = navigator.userAgent;
      // Chromium Android treats octet-stream as unrestricted GET_CONTENT and avoids media-only
      // routing. Other browsers retain the standard accept-less arbitrary-file input.
      if (/Android/i.test(ua) && /(?:Chrome|Chromium)\//i.test(ua)) {
        input.accept = "application/octet-stream";
      }
      const cleanup = () => {
        input.remove();
        if (composerDocumentPickerInput === input) composerDocumentPickerInput = null;
      };
      input.addEventListener("cancel", cleanup, { once: true });
      input.addEventListener("change", () => {
        const files = Array.from(input.files || []);
        cleanup();
        consumeFiles(files);
      }, { once: true });
      document.body.appendChild(input);
      composerDocumentPickerInput = input;
      input.click();
    };
    // ACTION_OPEN_DOCUMENT on supporting Android browsers opens the actual document picker.
    // Never rely on it on HTTP or unsupported Safari/Firefox, and never reopen after Cancel.
    if (window.isSecureContext && typeof window.showOpenFilePicker === "function") {
      let selection;
      try {
        selection = window.showOpenFilePicker({
          id: "pi-web-attachments", multiple: true, excludeAcceptAllOption: false, startIn: "downloads",
        });
      } catch (_) {
        openInputFallback();
        return;
      }
      Promise.resolve(selection).then(async (handles) => {
        if (!isCurrent()) return;
        const files = await Promise.all(handles.map((handle) => handle.getFile()));
        consumeFiles(files);
      }).catch((error) => {
        if (!isCurrent() || error?.name === "AbortError") return;
        // User activation may have expired: request an explicit next click, not a hidden second picker.
        showToast("文件选择未完成，请重试或使用浏览器的文件上传入口", null, 4000);
      });
    } else {
      openInputFallback();
    }
  }

  const COMPOSER_EXTENDED_FILE_ACCEPT = "image/*,video/*";

  function syncComposerFileInputAndToolbar(textarea) {
    if (typeof document === "undefined") return;
    const root = textarea?.closest?.("[data-pi-native-composer-host]") || textarea?.closest?.("form") || document;
    const fileInput = root.querySelector?.('input[type="file"]') ||
      document.querySelector?.('[data-pi-native-composer-host] input[type="file"], form input[type="file"]');
    if (fileInput) {
      if (!fileInput.hasAttribute("data-pi-orig-accept")) {
        fileInput.setAttribute("data-pi-orig-accept", fileInput.getAttribute("accept") || "image/*");
      }
      if (activeComposerFileInput !== fileInput || !fileInput.__piEnhFileInputBound) {
        if (activeComposerFileInput && composerFileInputChangeHandler) {
          activeComposerFileInput.removeEventListener("change", composerFileInputChangeHandler, true);
          activeComposerFileInput.__piEnhFileInputBound = false;
        }
        composerFileInputChangeHandler = (event) => {
          if (!isPluginEnabled("composer-file-paste")) return;
          const input = event.currentTarget || fileInput;
          const selectedFiles = Array.from(input?.files || []);
          if (selectedFiles.length === 0) return;

          const imageFiles = [];
          const nonImageFiles = [];
          for (const f of selectedFiles) {
            const isImg = Boolean(f.type && f.type.startsWith("image/")) && !isVideoFile(f.name, f.type);
            if (isImg) {
              imageFiles.push(f);
            } else {
              nonImageFiles.push(f);
            }
          }

          if (nonImageFiles.length === 0) return;

          const targetTextarea = findComposerTextarea() || textarea;
          if (imageFiles.length === 0) {
            event.stopPropagation();
            if (typeof event.stopImmediatePropagation === "function") {
              event.stopImmediatePropagation();
            }
            try { input.value = ""; } catch (e) {}
            void processComposerFiles(nonImageFiles, targetTextarea);
          } else {
            try {
              if (typeof DataTransfer !== "undefined") {
                const dt = new DataTransfer();
                for (const img of imageFiles) dt.items.add(img);
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype || {}, "files")?.set;
                if (setter) setter.call(input, dt.files);
                else input.files = dt.files;
              }
            } catch (e) {}
            void processComposerFiles(nonImageFiles, targetTextarea);
          }
        };
        fileInput.addEventListener("change", composerFileInputChangeHandler, true);
        fileInput.__piEnhFileInputBound = true;
        activeComposerFileInput = fileInput;
      }
    }

    const attachBtns = document.querySelectorAll?.('button[data-pi-attach-image]') || [];
    for (const btn of attachBtns) {
      if (!btn.__piEnhAttachClickHandler) {
        btn.__piEnhAttachClickHandler = () => {
          const r = btn.closest("[data-pi-native-composer-host]") || btn.closest("form") || document;
          const fi = r.querySelector?.('input[type="file"]') ||
            document.querySelector?.('[data-pi-native-composer-host] input[type="file"], form input[type="file"]');
          if (fi) fi.setAttribute("accept", "image/*,video/*");
        };
        btn.addEventListener("click", btn.__piEnhAttachClickHandler, true);
      }
      if (!btn.hasAttribute("data-pi-orig-title")) {
        btn.setAttribute("data-pi-orig-title", btn.getAttribute("title") || "");
      }
      if (!btn.hasAttribute("data-pi-orig-aria")) {
        btn.setAttribute("data-pi-orig-aria", btn.getAttribute("aria-label") || "");
      }
      if (btn.getAttribute("title") !== "添加图片或视频") {
        btn.setAttribute("title", "添加图片或视频");
      }
      if (btn.getAttribute("aria-label") !== "添加图片或视频") {
        btn.setAttribute("aria-label", "添加图片或视频");
      }
    }
  }

  function restoreComposerFileInputAndToolbar() {
    removeComposerDocumentPicker();
    if (activeComposerFileInput) {
      if (composerFileInputChangeHandler) {
        activeComposerFileInput.removeEventListener("change", composerFileInputChangeHandler, true);
      }
      activeComposerFileInput.__piEnhFileInputBound = false;
      activeComposerFileInput = null;
    }
    composerFileInputChangeHandler = null;
    if (typeof document === "undefined") return;
    const inputs = document.querySelectorAll?.('input[type="file"][data-pi-orig-accept]') || [];
    for (const input of inputs) {
      const origAccept = input.getAttribute("data-pi-orig-accept");
      if (origAccept !== null) input.setAttribute("accept", origAccept);
      input.removeAttribute("data-pi-orig-accept");
      input.__piEnhFileInputBound = false;
    }
    const attachBtns = document.querySelectorAll?.('button[data-pi-attach-image]') || [];
    for (const btn of attachBtns) {
      if (btn.__piEnhAttachClickHandler) {
        btn.removeEventListener("click", btn.__piEnhAttachClickHandler, true);
        delete btn.__piEnhAttachClickHandler;
      }
      if (btn.hasAttribute("data-pi-orig-title")) {
        const origTitle = btn.getAttribute("data-pi-orig-title");
        if (origTitle) btn.setAttribute("title", origTitle);
        else btn.removeAttribute("title");
        btn.removeAttribute("data-pi-orig-title");
      }
      if (btn.hasAttribute("data-pi-orig-aria")) {
        const origAria = btn.getAttribute("data-pi-orig-aria");
        if (origAria) btn.setAttribute("aria-label", origAria);
        else btn.removeAttribute("aria-label");
        btn.removeAttribute("data-pi-orig-aria");
      }
    }
  }

  function removeComposerFilePaste() {
    composerFileProcessingGeneration++;
    closeVideoPreviewModal();
    for (const att of pendingComposerAttachments) {
      revokeAttachmentPreviewUrl(att);
    }
    restoreComposerFileInputAndToolbar();
    if (activeComposerPasteTextarea) {
      if (composerPasteHandler) {
        activeComposerPasteTextarea.removeEventListener("paste", composerPasteHandler, true);
      }
      if (composerDragOverHandler) {
        activeComposerPasteTextarea.removeEventListener("dragover", composerDragOverHandler);
      }
      if (composerDragLeaveHandler) {
        activeComposerPasteTextarea.removeEventListener("dragleave", composerDragLeaveHandler);
      }
      if (composerDropHandler) {
        activeComposerPasteTextarea.removeEventListener("drop", composerDropHandler);
      }
      try {
        activeComposerPasteTextarea.classList.remove("pi-enh-composer-drop-active");
      } catch (e) {}
      activeComposerPasteTextarea.__piEnhFilePasteBound = false;

      const bar = findComposerAttachmentBar(activeComposerPasteTextarea);
      if (bar) bar.remove();

      activeComposerPasteTextarea = null;
    }
    if (activeComposerPasteHost) {
      if (composerHostDragOverHandler) {
        activeComposerPasteHost.removeEventListener("dragover", composerHostDragOverHandler, true);
      }
      if (composerHostDragLeaveHandler) {
        activeComposerPasteHost.removeEventListener("dragleave", composerHostDragLeaveHandler, true);
      }
      if (composerHostDropHandler) {
        activeComposerPasteHost.removeEventListener("drop", composerHostDropHandler, true);
      }
      try {
        activeComposerPasteHost.classList.remove("pi-enh-composer-drop-active");
      } catch (e) {}
      activeComposerPasteHost.__piEnhHostDropBound = false;
      activeComposerPasteHost = null;
    }
    if (typeof document !== "undefined") {
      for (const el of document.querySelectorAll?.(".pi-enh-composer-drop-active") || []) {
        try { el.classList.remove("pi-enh-composer-drop-active"); } catch (e) {}
      }
    }
    composerPasteHandler = null;
    composerDragOverHandler = null;
    composerDragLeaveHandler = null;
    composerDropHandler = null;
    composerHostDragOverHandler = null;
    composerHostDragLeaveHandler = null;
    composerHostDropHandler = null;
    pendingComposerAttachments = [];
    notifyComposerSubmissionStateChange();
    removeUserMessageAttachmentCards();
  }

  function syncComposerFilePaste() {
    if (!isPluginEnabled("composer-file-paste")) {
      removeComposerFilePaste();
      return;
    }
    syncUserMessageAttachmentCards();
    const textarea = findComposerTextarea();
    if (!textarea) {
      if (activeComposerPasteTextarea) {
        removeComposerFilePaste();
      }
      return;
    }

    syncComposerFileInputAndToolbar(textarea);

    if (activeComposerPasteTextarea === textarea && textarea.__piEnhFilePasteBound) {
      syncComposerAttachmentBar(textarea);
      return;
    }

    removeComposerFilePaste();
    syncComposerFileInputAndToolbar(textarea);

    activeComposerPasteTextarea = textarea;
    textarea.__piEnhFilePasteBound = true;

    composerPasteHandler = (event) => {
      if (!isPluginEnabled("composer-file-paste")) return;
      const files = Array.from(event.clipboardData?.files || []);
      const items = Array.from(event.clipboardData?.items || []);
      const itemFiles = items
        .filter((it) => it && it.kind === "file" && typeof it.getAsFile === "function")
        .map((it) => it.getAsFile())
        .filter(Boolean);
      const allFiles = files.length > 0 ? files : itemFiles;
      if (!allFiles || allFiles.length === 0) return;

      // 如果全部为纯图片文件（且非视频），放行给原生图片处理
      const nonImageFiles = allFiles.filter((f) => !(f.type && f.type.startsWith("image/")) || isVideoFile(f.name, f.type));
      if (nonImageFiles.length === 0) return;

      event.preventDefault();
      event.stopPropagation();
      processComposerFiles(nonImageFiles, textarea);
    };

    const getDropHighlightTarget = () =>
      textarea.closest?.('.pi-enh-cursor-composer, [data-pi-native-composer-host] > div[style*="max-width"]') ||
      activeComposerPasteHost ||
      textarea;

    composerDragOverHandler = (event) => {
      if (!isPluginEnabled("composer-file-paste")) return;
      const types = Array.from(event.dataTransfer?.types || []);
      if (types.includes("Files")) {
        event.preventDefault();
        try { event.dataTransfer.dropEffect = "copy"; } catch (e) {}
        textarea.classList.add("pi-enh-composer-drop-active");
        getDropHighlightTarget()?.classList?.add?.("pi-enh-composer-drop-active");
      }
    };

    composerDragLeaveHandler = () => {
      try {
        textarea.classList.remove("pi-enh-composer-drop-active");
      } catch (e) {}
    };

    composerDropHandler = (event) => {
      try {
        textarea.classList.remove("pi-enh-composer-drop-active");
        getDropHighlightTarget()?.classList?.remove?.("pi-enh-composer-drop-active");
      } catch (e) {}
      if (!isPluginEnabled("composer-file-paste") || event.__piEnhDropHandled) return;
      const files = Array.from(event.dataTransfer?.files || []);
      if (!files || files.length === 0) return;

      const nonImageFiles = files.filter((f) => !(f.type && f.type.startsWith("image/")) || isVideoFile(f.name, f.type));
      if (nonImageFiles.length === 0) return;

      event.__piEnhDropHandled = true;
      event.preventDefault();
      event.stopPropagation();
      processComposerFiles(nonImageFiles, textarea);
    };

    textarea.addEventListener("paste", composerPasteHandler, true);
    textarea.addEventListener("dragover", composerDragOverHandler);
    textarea.addEventListener("dragleave", composerDragLeaveHandler);
    textarea.addEventListener("drop", composerDropHandler);

    const composerHost = textarea.closest?.("[data-pi-native-composer-host]") || textarea.closest?.("form") || textarea.parentElement;
    if (composerHost && composerHost !== textarea) {
      activeComposerPasteHost = composerHost;
      composerHost.__piEnhHostDropBound = true;

      composerHostDragOverHandler = (event) => {
        if (!isPluginEnabled("composer-file-paste")) return;
        const types = Array.from(event.dataTransfer?.types || []);
        if (types.includes("Files")) {
          event.preventDefault();
          try { event.dataTransfer.dropEffect = "copy"; } catch (e) {}
          textarea.classList.add("pi-enh-composer-drop-active");
          getDropHighlightTarget()?.classList?.add?.("pi-enh-composer-drop-active");
        }
      };

      composerHostDragLeaveHandler = (event) => {
        if (event.relatedTarget && composerHost.contains?.(event.relatedTarget)) return;
        try {
          textarea.classList.remove("pi-enh-composer-drop-active");
          getDropHighlightTarget()?.classList?.remove?.("pi-enh-composer-drop-active");
          composerHost.classList.remove("pi-enh-composer-drop-active");
        } catch (e) {}
      };

      composerHostDropHandler = (event) => {
        try {
          textarea.classList.remove("pi-enh-composer-drop-active");
          getDropHighlightTarget()?.classList?.remove?.("pi-enh-composer-drop-active");
          composerHost.classList.remove("pi-enh-composer-drop-active");
        } catch (e) {}
        if (!isPluginEnabled("composer-file-paste") || event.__piEnhDropHandled) return;
        const files = Array.from(event.dataTransfer?.files || []);
        if (!files || files.length === 0) return;

        const nonImageFiles = files.filter((f) => !(f.type && f.type.startsWith("image/")) || isVideoFile(f.name, f.type));
        if (nonImageFiles.length === 0) return;

        event.__piEnhDropHandled = true;
        event.preventDefault();
        event.stopPropagation();
        processComposerFiles(nonImageFiles, textarea);
      };

      composerHost.addEventListener("dragover", composerHostDragOverHandler, true);
      composerHost.addEventListener("dragleave", composerHostDragLeaveHandler, true);
      composerHost.addEventListener("drop", composerHostDropHandler, true);
    }

    syncComposerAttachmentBar(textarea);
    syncUserMessageAttachmentCards();
  }

  activeCleanups.push(removeComposerFilePaste);
  window.__PI_ENH_IS_TEXT_FILE__ = isTextFile;
  window.__PI_ENH_IS_VIDEO_FILE__ = isVideoFile;
  window.__PI_ENH_OPEN_VIDEO_PREVIEW__ = openVideoPreviewModal;
  window.__PI_ENH_CLOSE_VIDEO_PREVIEW__ = closeVideoPreviewModal;
  window.__PI_ENH_GET_LANG_FOR_FILENAME__ = getLanguageForFilename;
  window.__PI_ENH_FORMAT_TEXT_SNIPPET__ = formatTextFileSnippet;
  window.__PI_ENH_PROCESS_COMPOSER_FILES__ = processComposerFiles;
  window.__PI_ENH_GET_EFFECTIVE_CWD__ = getEffectiveComposerCwd;
  window.__PI_ENH_SYNC_COMPOSER_FILE_PASTE__ = syncComposerFilePaste;
  window.__PI_ENH_REMOVE_COMPOSER_FILE_PASTE__ = removeComposerFilePaste;
  window.__PI_ENH_SYNC_USER_MESSAGE_ATTACHMENTS__ = syncUserMessageAttachmentCards;
  window.__PI_ENH_REMOVE_USER_MESSAGE_ATTACHMENTS__ = removeUserMessageAttachmentCards;
  window.__PI_ENH_HIDE_DIMENSION_NOTES__ = hideDimensionNotesInMessage;
  function appendComposerAttachmentsToSubmission(body, attachments) {
    let extraText = "";
    for (const att of attachments) {
      if (att.isText && att.textContent) {
        const lang = getLanguageForFilename(att.name);
        const safeText = att.textContent.endsWith("\n") ? att.textContent : `${att.textContent}\n`;
        extraText += `\n\n### \`${att.name}\`\n\`\`\`${lang}\n${safeText}\`\`\`\n`;
      } else if (att.serverRelativePath) {
        extraText += `\n\n[附件: @${att.serverRelativePath}]`;
      }
    }
    const text = String(body || "");
    return text.trim() ? `${text}${extraText}` : extraText.trim();
  }

  // Decode the existing submission format, only for a contiguous attachment
  // suffix. Ordinary fenced code elsewhere in the message remains plain text.
  function parseSubmittedComposerAttachments(body) {
    const text = String(body || "");
    const pattern = /(?:\n\n|^)(?:### `([^`\n]+)`\n```[^`\n]*\n([\s\S]*?)```\n?|\[附件: @([^\]\n]+)\])/g;
    const matches = Array.from(text.matchAll(pattern));
    if (!matches.length || text.slice(matches.at(-1).index + matches.at(-1)[0].length).trim()) return { text, attachments: [] };
    let first = matches.length - 1;
    while (first > 0) {
      const preceding = matches[first - 1];
      if (text.slice(preceding.index + preceding[0].length, matches[first].index).trim()) break;
      first -= 1;
    }
    const attachments = matches.slice(first).map((match) => match[3] ? {
      name: extractOriginalFilename(match[3]), serverRelativePath: match[3],
      type: getMimeTypeFromExt(extractOriginalFilename(match[3])), isText: false,
    } : {
      name: match[1], textContent: match[2], isText: true,
      size: new TextEncoder().encode(match[2]).length, type: getMimeTypeFromExt(match[1]),
    });
    return { text: text.slice(0, matches[first].index), attachments };
  }

  function restoreSubmittedComposerAttachments(body) {
    if (!isPluginEnabled("composer-file-paste")) return String(body || "");
    // Never replace a draft's own files with historical attachments.
    if (pendingComposerAttachments.length) return null;
    const restored = parseSubmittedComposerAttachments(body);
    pendingComposerAttachments = restored.attachments.map((attachment) => ({
      ...attachment, id: "restored-" + crypto.randomUUID(),
    }));
    notifyComposerSubmissionStateChange();
    syncComposerAttachmentBar(findComposerTextarea());
    return restored.text;
  }

  window.__PI_ENH_RESTORE_COMPOSER_ATTACHMENTS__ = restoreSubmittedComposerAttachments;

  function prepareComposerSubmission(kind, body) {
    const attachmentSnapshot = isPluginEnabled("composer-file-paste")
      ? pendingComposerAttachments.slice()
      : [];
    const bodyWithAttachments = appendComposerAttachmentsToSubmission(body, attachmentSnapshot);
    const prepareAnnotations = window.__PI_ENH_PREPARE_ANNOTATION_SUBMISSION__;
    const annotationSubmission = typeof prepareAnnotations === "function"
      ? prepareAnnotations(kind, bodyWithAttachments)
      : null;
    if (!attachmentSnapshot.length && !annotationSubmission) return null;

    let committed = false;
    return {
      text: annotationSubmission?.text ?? bodyWithAttachments,
      commit() {
        if (committed) return;
        committed = true;
        annotationSubmission?.commit?.();
        if (!attachmentSnapshot.length) return;
        const submittedIds = new Set(attachmentSnapshot.map((attachment) => attachment.id));
        pendingComposerAttachments = pendingComposerAttachments.filter((attachment) => !submittedIds.has(attachment.id));
        attachmentSnapshot.forEach(revokeAttachmentPreviewUrl);
        notifyComposerSubmissionStateChange();
        syncComposerAttachmentBar(findComposerTextarea());
      },
      kind,
    };
  }

  window.__PI_ENH_PREPARE_COMPOSER_SUBMISSION__ = prepareComposerSubmission;
  window.__PI_ENH_GET_COMPOSER_SUBMISSION_STATE__ = getComposerSubmissionState;
  window.__PI_ENH_GET_PENDING_ATTACHMENTS__ = () => pendingComposerAttachments;
  window.__PI_ENH_CLEAR_PENDING_ATTACHMENTS__ = () => {
    for (const attachment of pendingComposerAttachments) revokeAttachmentPreviewUrl(attachment);
    pendingComposerAttachments = [];
    notifyComposerSubmissionStateChange();
    syncComposerAttachmentBar(findComposerTextarea());
  };
  window.__PI_ENH_CLEANUP_SESSION_FILES__ = cleanupSessionUploadedFiles;
  notifyComposerSubmissionStateChange();

  // ==========================================
  // 3.55 Composer Image Zoom (输入框图片附件点击放大)
  // ==========================================
  activeZoomDialog = null;

  function isComposerAttachmentImage(el) {
    if (!el || !el.tagName || el.tagName.toLowerCase() !== "img") return false;
    let p = el.parentElement;
    while (p) {
      const tag = p.tagName ? p.tagName.toLowerCase() : "";
      if (tag === "dialog" || tag === "pre" || tag === "code") {
        return false;
      }
      if (tag === "button") {
        if (p !== el.parentElement || !isNativeImagePreviewTrigger(p)) {
          return false;
        }
      }
      const pCls = typeof p.className === "string" ? p.className : "";
      if (
        pCls.includes("chat-message")
        || pCls.includes("markdown-body")
        || p.hasAttribute?.("data-message-role")
        || p.hasAttribute?.("data-entry-id")
      ) {
        return false;
      }
      p = p.parentElement;
    }
    const itemContainer = getComposerAttachmentItemContainer(el);
    if (!itemContainer) return false;
    const itemTag = itemContainer.tagName ? itemContainer.tagName.toLowerCase() : "";
    if (itemTag === "button") return false;
    const hasRemoveBtn = Boolean(getComposerAttachmentRemoveButton(el));
    if (!hasRemoveBtn) return false;

    let curr = itemContainer;
    while (curr) {
      const tag = curr.tagName ? curr.tagName.toLowerCase() : "";
      const cls = curr.className || "";
      const style = (typeof curr.getAttribute === "function" ? curr.getAttribute("style") : curr.attributes?.style) || "";
      if (
        tag === "form"
        || curr.hasAttribute?.("data-pi-native-composer-host")
        || cls.includes("chat-input-container")
        || style.includes("flex-wrap")
        || style.includes("flexWrap")
      ) {
        return true;
      }
      curr = curr.parentElement;
    }

    const textarea = findComposerTextarea();
    if (textarea) {
      const container = findComposerImageContainer(textarea);
      if (container && typeof container.contains === "function" && container.contains(el)) {
        return true;
      }
    }
    return false;
  }

  function replaceComposerImageState(ctx, index, expectedImage, replacement) {
    const images = ctx?.imagesRef?.current;
    const stateHook = ctx?.imageStateHook;
    if (!Array.isArray(images) || !Number.isInteger(index) || index < 0 || index >= images.length) return false;
    if (images[index] !== expectedImage || !validDraftImages([replacement])) return false;
    if (!stateHook || stateHook.memoizedState !== images || typeof stateHook.queue?.dispatch !== "function") return false;

    const editedImage = {
      data: replacement.data,
      mimeType: replacement.mimeType,
      previewUrl: replacement.previewUrl || `data:${replacement.mimeType};base64,${replacement.data}`,
    };
    const nextImages = images.slice();
    nextImages[index] = editedImage;
    ctx.imagesRef.current = nextImages;
    try {
      stateHook.queue.dispatch(nextImages);
    } catch (error) {
      ctx.imagesRef.current = images;
      return false;
    }

    const oldPreviewUrl = expectedImage?.previewUrl;
    if (typeof oldPreviewUrl === "string" && oldPreviewUrl.startsWith("blob:")
      && oldPreviewUrl !== editedImage.previewUrl && typeof URL?.revokeObjectURL === "function") {
      addManagedTimeout(() => {
        try { URL.revokeObjectURL(oldPreviewUrl); } catch (error) {}
      }, 0);
    }
    return true;
  }

  const HISTORY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
  const HISTORY_IMAGE_FAST_PATH_MAX_BYTES = 1024 * 1024;

  function historyImageBase64ByteLength(data) {
    if (typeof data !== "string" || !data || data.length % 4 !== 0) return null;
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const dataEnd = data.length - padding;
    for (let index = 0; index < dataEnd; index += 1) {
      const code = data.charCodeAt(index);
      if (!((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
        || (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f)) return null;
    }
    for (let index = dataEnd; index < data.length; index += 1) {
      if (data[index] !== "=") return null;
    }
    return (data.length / 4) * 3 - padding;
  }

  function parseHistoryImageDataUrl(source) {
    if (typeof source !== "string" || source.slice(0, 5).toLowerCase() !== "data:") return null;
    const comma = source.indexOf(",");
    if (comma < 0) return null;
    const header = source.slice(5, comma);
    const base64Marker = header.toLowerCase().lastIndexOf(";base64");
    if (base64Marker < 0 || base64Marker !== header.length - 7) return null;
    const mimeType = header.slice(0, base64Marker).split(";")[0].trim().toLowerCase();
    if (!mimeType.startsWith("image/")) return null;
    const data = source.slice(comma + 1);
    const byteLength = historyImageBase64ByteLength(data);
    return byteLength === null ? null : { data, mimeType, byteLength };
  }

  function appendComposerImageState(ctx, image) {
    const images = ctx?.imagesRef?.current;
    const stateHook = ctx?.imageStateHook;
    const mimeType = typeof image?.mimeType === "string" ? image.mimeType.toLowerCase() : "";
    const byteLength = historyImageBase64ByteLength(image?.data);
    if (!Array.isArray(images) || images.length >= 10 || ctx.keyRef?.current !== ctx.key
      || ctx.pendingRef?.current > 0 || byteLength === null || byteLength > HISTORY_IMAGE_MAX_BYTES
      || !mimeType.startsWith("image/") || !stateHook || stateHook.memoizedState !== images
      || typeof stateHook.queue?.dispatch !== "function") return false;

    const nextImages = images.concat({
      data: image.data,
      mimeType,
      previewUrl: typeof image.previewUrl === "string" && image.previewUrl
        ? image.previewUrl : `data:${mimeType};base64,${image.data}`,
    });
    if (!validDraftImages(nextImages)) return false;
    ctx.imagesRef.current = nextImages;
    try {
      stateHook.queue.dispatch(nextImages);
    } catch (error) {
      ctx.imagesRef.current = images;
      return false;
    }
    try { queueNativeDraftSync(); } catch (error) {}
    return true;
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string"
        ? resolve(reader.result) : reject(new Error("图片读取失败"));
      reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
      reader.onabort = () => reject(new Error("图片读取已取消"));
      reader.readAsDataURL(blob);
    });
  }

  function getComposerImageEditContext(target) {
    const native = readNativeComposerDraft();
    if (!native?.imageStateHook) return null;
    const textarea = findComposerTextarea();
    const container = findComposerImageContainer(textarea);
    if (!container?.querySelectorAll) return null;
    const images = Array.from(container.querySelectorAll("img")).filter(isComposerAttachmentImage);
    const index = images.indexOf(target);
    const expectedImage = native.imagesRef.current?.[index];
    if (index < 0 || !expectedImage || !validDraftImages([expectedImage])) return null;
    return {
      index,
      expectedImage,
      editSrc: `data:${expectedImage.mimeType};base64,${expectedImage.data}`,
    };
  }

  let imageEditorOpenGeneration = 0;
  let imageEditorFactory = null;
  let imageEditorOpen = null;
  function openComposerImageZoomModal(src, alt = "图片预览", editContext = null, galleryContext = null, options = null) {
    if (!src || isDisposed) return;
    const generation = ++imageEditorOpenGeneration;
    const apply = factory => {
      if (isDisposed || generation !== imageEditorOpenGeneration) return;
      if (imageEditorFactory !== factory) {
        imageEditorFactory = factory;
        imageEditorOpen = factory.create({
          HISTORY_IMAGE_FAST_PATH_MAX_BYTES, HISTORY_IMAGE_MAX_BYTES,
          appendComposerImageState, closeComposerImageZoomModal, isMobileEnvironment,
          parseHistoryImageDataUrl, readBlobAsDataUrl, readNativeComposerDraft,
          replaceComposerImageState, showToast,
          get activeZoomDialog() { return activeZoomDialog; },
          set activeZoomDialog(value) { activeZoomDialog = value; },
        });
      }
      imageEditorOpen(src, alt, editContext, galleryContext, options);
    };
    const stamp = window.__PI_OPTIONAL_LOADED_ASSETS__?.get("image-editor");
    if (stamp?.value === imageEditorFactory && imageEditorOpen) {
      apply(imageEditorFactory);
      return;
    }
    if (typeof window.__PI_ENH_LOAD_OPTIONAL__ !== "function") {
      showToast("图片编辑组件暂时不可用，请刷新后重试", "error");
      return;
    }
    const cancelPending = event => {
      if (event.key !== "Escape" || event.isComposing || generation !== imageEditorOpenGeneration) return;
      event.preventDefault();
      event.stopPropagation();
      closeComposerImageZoomModal();
    };
    document.addEventListener("keydown", cancelPending, true);
    window.__PI_ENH_LOAD_OPTIONAL__("image-editor").then(apply).catch(() => {
      if (!isDisposed && generation === imageEditorOpenGeneration) {
        showToast("图片编辑组件加载失败，请重试", "error");
      }
    }).finally(() => document.removeEventListener("keydown", cancelPending, true));
  }

  function closeComposerImageZoomModal() {
    imageEditorOpenGeneration += 1;
    if (activeZoomDialog) {
      const cleanup = activeZoomDialog.__piEnhCleanup;
      if (typeof cleanup === "function") {
        cleanup();
      } else {
        if (activeZoomDialog.open && typeof activeZoomDialog.close === "function") {
          try { activeZoomDialog.close(); } catch (e) {}
        }
        try { activeZoomDialog.remove(); } catch (e) {}
        activeZoomDialog = null;
      }
    }
    if (document.body.style && document.body.style.overflow === "hidden") {
      document.body.style.overflow = "";
    }
  }

  function syncComposerImageZoom() {
    if (!isPluginEnabled("composer-image-zoom")) return;
    const textarea = findComposerTextarea();
    if (!textarea) return;
    const container = findComposerImageContainer(textarea);
    if (!container) return;
    const imgs = container.querySelectorAll ? container.querySelectorAll("img") : [];
    for (const img of imgs) {
      if (isComposerAttachmentImage(img)) {
        img.classList?.add("pi-enh-composer-zoomable-img");
        if (!img.hasAttribute || !img.hasAttribute("title") || img.getAttribute("title") === "") {
          img.setAttribute?.("title", "点击放大预览");
        }
      }
    }
  }

  function removeComposerImageZoom() {
    closeComposerImageZoomModal();
    const imgs = document.querySelectorAll ? document.querySelectorAll(".pi-enh-composer-zoomable-img") : [];
    for (const img of imgs) {
      img.classList?.remove("pi-enh-composer-zoomable-img");
      if (img.getAttribute && img.getAttribute("title") === "点击放大预览") {
        img.removeAttribute("title");
      }
    }
  }

  // ==========================================
  // Streaming Thinking Guard (流式思考聚合与防刷屏守卫)
  // ==========================================
  function syncStreamingThinkingGuard() {
    // Native MessageView owns empty-thinking filtering. Compatibility cleanup only.
    const root = document.documentElement;
    if (root.classList.contains("pi-enh-streaming-thinking-guard-active")) {
      root.classList.remove("pi-enh-streaming-thinking-guard-active");
    }
    for (const el of document.querySelectorAll("[data-pi-enh-thinking-folded]")) {
      el.removeAttribute("data-pi-enh-thinking-folded");
    }
    for (const badge of document.querySelectorAll(".pi-enh-thinking-aggregate-badge")) {
      badge.remove();
    }
  }

  function handleComposerImageClick(event) {
    if (!isPluginEnabled("composer-image-zoom")) return;
    const rawTarget = event.target;
    if (!rawTarget) return;
    const enclosingButton = rawTarget.closest ? rawTarget.closest("button") : null;
    if (enclosingButton && !isNativeImagePreviewTrigger(enclosingButton)) return;
    const target = unwrapNativeImagePreviewTarget(rawTarget);
    if (isComposerAttachmentImage(target)) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();

      const textarea = findComposerTextarea();
      let container = findComposerImageContainer(textarea);
      if (!container) {
        let p = getComposerAttachmentItemContainer(target) || target.parentElement;
        while (p) {
          const style = (typeof p.getAttribute === "function" ? p.getAttribute("style") : p.attributes?.style) || "";
          const cls = p.className || "";
          if (style.includes("flex-wrap") || style.includes("flexWrap") || cls.includes("chat-input-container")) {
            container = p;
            break;
          }
          p = p.parentElement;
        }
      }

      const native = readNativeComposerDraft();
      let domImgs = [];
      if (container && container.querySelectorAll) {
        domImgs = Array.from(container.querySelectorAll("img")).filter(isComposerAttachmentImage);
      }
      if (domImgs.length === 0 || !domImgs.includes(target)) {
        domImgs = [target];
      }

      const initialIndex = Math.max(0, domImgs.indexOf(target));
      const items = domImgs.map((imgEl, idx) => {
        const src = (typeof imgEl.getAttribute === "function" ? imgEl.getAttribute("src") : imgEl.attributes?.src) || imgEl.src || "";
        const alt = (typeof imgEl.getAttribute === "function" ? imgEl.getAttribute("alt") : imgEl.attributes?.alt) || imgEl.alt || `第 ${idx + 1} 张截图`;
        let editCtx = null;
        if (native?.imageStateHook && Array.isArray(native.imagesRef?.current)) {
          const expectedImage = native.imagesRef.current[idx];
          if (expectedImage && validDraftImages([expectedImage])) {
            editCtx = {
              index: idx,
              expectedImage,
              editSrc: `data:${expectedImage.mimeType};base64,${expectedImage.data}`,
            };
          }
        }
        return { src, alt, editContext: editCtx, domElement: imgEl };
      });

      const currentItem = items[initialIndex] || { src: target.src, alt: target.alt, editContext: null };
      openComposerImageZoomModal(currentItem.src, currentItem.alt, currentItem.editContext, { items, initialIndex });
    }
  }

  function handleComposerImageMouseOver(event) {
    if (!isPluginEnabled("composer-image-zoom")) return;
    const rawTarget = event.target;
    if (!rawTarget) return;
    const enclosingButton = rawTarget.closest ? rawTarget.closest("button") : null;
    if (enclosingButton && !isNativeImagePreviewTrigger(enclosingButton)) return;
    const target = unwrapNativeImagePreviewTarget(rawTarget);
    if (isComposerAttachmentImage(target)) {
      target.classList?.add("pi-enh-composer-zoomable-img");
      if (!target.hasAttribute || !target.hasAttribute("title") || target.getAttribute("title") === "") {
        target.setAttribute?.("title", "点击放大预览");
      }
    }
  }

  addManagedListener(document, "click", handleComposerImageClick, true);
  addManagedListener(document, "mouseover", handleComposerImageMouseOver, true);

  window.__PI_ENH_IS_COMPOSER_IMAGE__ = isComposerAttachmentImage;
  window.__PI_ENH_IS_NATIVE_IMAGE_PREVIEW_TRIGGER__ = isNativeImagePreviewTrigger;
  window.__PI_ENH_GET_COMPOSER_IMAGE_CONTAINER_ITEM__ = getComposerAttachmentItemContainer;
  window.__PI_ENH_GET_COMPOSER_IMAGE_REMOVE_BUTTON__ = getComposerAttachmentRemoveButton;
  window.__PI_ENH_REPLACE_COMPOSER_IMAGE_STATE__ = replaceComposerImageState;
  window.__PI_ENH_IS_IMAGE_ZOOM_ACTIVE__ = () => Boolean(activeZoomDialog && activeZoomDialog.open);
  window.__PI_ENH_OPEN_IMAGE_ZOOM__ = openComposerImageZoomModal;
  window.__PI_ENH_CLOSE_IMAGE_ZOOM__ = closeComposerImageZoomModal;
  window.__PI_ENH_SYNC_COMPOSER_IMAGE_ZOOM__ = syncComposerImageZoom;
  window.__PI_ENH_REMOVE_COMPOSER_IMAGE_ZOOM__ = removeComposerImageZoom;

  // ==========================================
  // 3.55.1 Running Model Switch (任务运行中切换后续模型)
  // ==========================================
  const RUNNING_MODEL_SWITCH_MARKER = "data-pi-enh-running-model-switch";

  function isComposerTaskRunning() {
    const fieldset = document.querySelector("[data-pi-native-composer-host]");
    if (!fieldset) return false;
    return Array.from(fieldset.querySelectorAll("button")).some((button) => {
      const text = String(button.textContent || "").trim().toLowerCase();
      const title = String(button.getAttribute("title") || button.getAttribute("aria-label") || "").trim().toLowerCase();
      return text === "停止" || text === "stop" || title.includes("停止") || title.includes("stop");
    });
  }

  function findComposerModelSelectorButton() {
    return document.querySelector('.model-selector button[aria-haspopup="listbox"], .model-selector > button');
  }

  function restoreRunningModelSwitch() {
    const button = findComposerModelSelectorButton();
    if (!button) return;
    button.removeAttribute(RUNNING_MODEL_SWITCH_MARKER);
    // 原生单一所有权：绝对不篡改原生 button.disabled，由 React 原生组件自主管理
  }

  function syncRunningModelSwitch() {
    const button = findComposerModelSelectorButton();
    if (!button) return;
    if (!isPluginEnabled("running-model-switch") || !isComposerTaskRunning()) {
      button.removeAttribute(RUNNING_MODEL_SWITCH_MARKER);
      return;
    }
    button.setAttribute(RUNNING_MODEL_SWITCH_MARKER, "true");
  }

  function guardDisabledRunningModelSwitch(event) {
    // 原生 React ChatInput 已完全原生支持运行态选择下一条消息模型，
    // 外部脚本彻底退出拦截，杜绝强制禁用按钮或阻止点击导致的菜单意外关闭
    return;
  }

  addManagedListener(document, "click", guardDisabledRunningModelSwitch, true);

  // 保护原生模型选择器在会话流式输出期间不被高频重绘或脱落节点触发的伪 Outside Click 误关
  function guardModelSelectorDuringStreaming(event) {
    const listbox = document.querySelector('div[role="listbox"]');
    if (!listbox) return;
    const target = event.target;
    // 如果事件源节点在流式更新或重排中已被移除脱离 DOM 树，阻止其冒泡触发 outside-click
    if (target && !target.isConnected) {
      event.stopPropagation();
      return;
    }
    const modelBtn = findComposerModelSelectorButton();
    if ((modelBtn && (modelBtn === target || modelBtn.contains(target))) || listbox.contains(target)) {
      return;
    }
  }

  addManagedListener(document, "mousedown", guardModelSelectorDuringStreaming, true);
  addManagedListener(document, "pointerdown", guardModelSelectorDuringStreaming, true);

  window.__PI_ENH_SYNC_RUNNING_MODEL_SWITCH__ = syncRunningModelSwitch;
  window.__PI_ENH_RESTORE_RUNNING_MODEL_SWITCH__ = restoreRunningModelSwitch;

  // Dedicated IndexedDB & In-Memory Attachment Store for Queue Submissions
  const QUEUE_IDB_NAME = "pi-enh-queue-attachments-db";
  const QUEUE_IDB_STORE = "submissions";

  function openQueueIDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB unavailable"));
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("IndexedDB open timeout"));
        }
      }, 3000);

      const request = indexedDB.open(QUEUE_IDB_NAME, 1);
      request.onblocked = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          reject(new Error("IndexedDB open blocked"));
        }
      };
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(QUEUE_IDB_STORE)) {
          const store = db.createObjectStore(QUEUE_IDB_STORE, { keyPath: "id" });
          store.createIndex("sessionId", "sessionId", { unique: false });
        }
      };
      request.onsuccess = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          resolve(request.result);
        } else {
          request.result.close();
        }
      };
      request.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          reject(request.error || new Error("IndexedDB open error"));
        }
      };
    });
  }

  async function idbSaveSubmission(item) {
    let db = null;
    try {
      db = await openQueueIDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_IDB_STORE, "readwrite");
        tx.objectStore(QUEUE_IDB_STORE).put(item);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (_) {
      return false;
    } finally {
      try { db?.close(); } catch (_) {}
    }
  }

  async function idbLoadSubmissions(sessionId) {
    let db = null;
    try {
      db = await openQueueIDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(QUEUE_IDB_STORE, "readonly");
        const index = tx.objectStore(QUEUE_IDB_STORE).index("sessionId");
        const req = index.getAll(sessionId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    } catch (_) {
      return [];
    } finally {
      try { db?.close(); } catch (_) {}
    }
  }

  const MAX_QUEUE_DETAIL_CACHE_ITEMS = 30;
  const MAX_QUEUE_DETAIL_CACHE_BYTES = 24 * 1024 * 1024; // 24MiB
  let currentQueueDetailCacheBytes = 0;
  let queueDetailCacheGeneration = 0;

  function estimateQueueDetailSize(detail) {
    if (!detail || typeof detail !== "object") return 0;
    let bytes = 128;
    if (typeof detail.text === "string") {
      bytes += detail.text.length * 2;
    }
    if (Array.isArray(detail.images)) {
      for (const img of detail.images) {
        if (img && typeof img.data === "string") {
          bytes += img.data.length * 2 + 64;
        }
      }
    }
    return bytes;
  }

  const queueSubmissionMemoryStore = new Map(); // sessionId -> Array<Submission>
  const queuedMessageDetailCache = new Map(); // `${sessionId}:${token}` -> { detail, size }
  const queuedMessageDetailInFlight = new Map(); // `${sessionId}:${token}` -> Promise
  const queuedMessageDetailAbortControllers = new Map(); // `${sessionId}:${token}` -> AbortController
  const hydratedSessions = new Set();
  let queueAttachmentRevision = 0;

  function evictQueueDetailCacheLRU() {
    while (queuedMessageDetailCache.size > MAX_QUEUE_DETAIL_CACHE_ITEMS || currentQueueDetailCacheBytes > MAX_QUEUE_DETAIL_CACHE_BYTES) {
      const oldestKey = queuedMessageDetailCache.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = queuedMessageDetailCache.get(oldestKey);
      queuedMessageDetailCache.delete(oldestKey);
      if (entry && typeof entry.size === "number") {
        currentQueueDetailCacheBytes = Math.max(0, currentQueueDetailCacheBytes - entry.size);
      }
    }
  }

  function getFromQueueDetailCache(cacheKey) {
    if (isDisposed) return null;
    if (!queuedMessageDetailCache.has(cacheKey)) return null;
    const entry = queuedMessageDetailCache.get(cacheKey);
    queuedMessageDetailCache.delete(cacheKey);
    queuedMessageDetailCache.set(cacheKey, entry);
    return entry?.detail || null;
  }

  function putIntoQueueDetailCache(cacheKey, detail) {
    if (isDisposed || !detail) return;
    const size = estimateQueueDetailSize(detail);
    if (size > MAX_QUEUE_DETAIL_CACHE_BYTES) {
      return;
    }
    if (queuedMessageDetailCache.has(cacheKey)) {
      const old = queuedMessageDetailCache.get(cacheKey);
      currentQueueDetailCacheBytes = Math.max(0, currentQueueDetailCacheBytes - (old?.size || 0));
      queuedMessageDetailCache.delete(cacheKey);
    }
    queuedMessageDetailCache.set(cacheKey, { detail, size });
    currentQueueDetailCacheBytes += size;
    evictQueueDetailCacheLRU();
  }

  function clearQueueDetailCache() {
    queueDetailCacheGeneration++;
    queuedMessageDetailCache.clear();
    currentQueueDetailCacheBytes = 0;
    for (const controller of queuedMessageDetailAbortControllers.values()) {
      try { controller.abort(); } catch (e) {}
    }
    queuedMessageDetailAbortControllers.clear();
    queuedMessageDetailInFlight.clear();
  }

  function notifyQueueAttachmentUpdated() {
    queueAttachmentRevision++;
    if (isPluginEnabled("composer-queue-panel") && composerQueuePanel?.isConnected) {
      syncComposerQueuePanel(true);
    }
  }

  function saveRecalledToOwnerPersistedDraft(ownerKey, text, images) {
    if (!ownerKey) return;
    const existing = (typeof getPersistedDraft === "function" ? getPersistedDraft(ownerKey) : null) || { value: "", images: [] };
    const mergedText = [text, existing.value].filter(Boolean).join("\n\n");
    const existingImgs = Array.isArray(existing.images) ? existing.images : [];
    const recallImgs = Array.isArray(images) ? images : [];
    const mergedImgs = [...recallImgs, ...existingImgs];

    if (mergedImgs.length <= 10 && savePersistedDraft(ownerKey, { value: mergedText, images: mergedImgs })) return true;
    // Do not truncate or silently lose large Base64 payloads to localStorage quota.
    downloadQueueRecovery(ownerKey, text, recallImgs);
    return false;
  }

  function downloadQueueRecovery(ownerKey, text, images) {
    const blob = new Blob([JSON.stringify({ version: 1, ownerKey, text, images }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pi-queue-recovery-${Date.now()}.json`;
    link.click();
    addManagedTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("输入框状态已变化，完整召回图文已导出恢复文件；未覆盖当前输入", null, 6000);
  }

  function getEffectiveQueueSessionId(explicitSid) {
    if (explicitSid && typeof explicitSid === "string" && !explicitSid.startsWith("new:")) {
      return explicitSid;
    }
    const fromUrl = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    if (fromUrl) return fromUrl;
    if (typeof getEffectiveComposerSessionId === "function") {
      const fromComposer = getEffectiveComposerSessionId();
      if (fromComposer && !fromComposer.startsWith("new:")) return fromComposer;
    }
    const fromScroll = document.querySelector?.("[data-pi-native-scroll-owner]")?.getAttribute?.("data-pi-native-scroll-owner");
    if (fromScroll && !fromScroll.startsWith("new:")) return fromScroll;
    return explicitSid || null;
  }

  function deliverRecalledQueuePayload(ownerKey, keyRef, route, text, images) {
    const current = readNativeComposerDraft();
    const effectiveRoute = getEffectiveQueueSessionId(route);
    const activeRoute = getEffectiveQueueSessionId();
    if (activeRoute === effectiveRoute && current?.key === ownerKey && current.keyRef === keyRef
      && current.pendingRef.current === 0 && current.imagesRef.current.length + images.length <= 10) {
      current.handle.restoreSubmission(text, images, ownerKey);
      current.textarea?.focus();
      return true;
    }
    return saveRecalledToOwnerPersistedDraft(ownerKey, text, images);
  }

  async function hydrateSessionQueueAttachments(sessionId) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (!activeSid) return;
    try {
      const persisted = await idbLoadSubmissions(activeSid);
      if (Array.isArray(persisted) && persisted.length > 0) {
        const existing = queueSubmissionMemoryStore.get(activeSid) || [];
        const existingIds = new Set(existing.map((x) => x.id));
        for (const item of persisted) {
          if (!existingIds.has(item.id)) {
            existing.push(item);
          }
        }
        existing.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        queueSubmissionMemoryStore.set(activeSid, existing);
        notifyQueueAttachmentUpdated();
      }
    } catch (_) {}
  }

  function triggerSessionHydration(sessionId) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (!activeSid || hydratedSessions.has(activeSid)) return;
    hydratedSessions.add(activeSid);
    void hydrateSessionQueueAttachments(activeSid);
  }

  function recordCapturedSubmissionAttachment(sessionId, kind, text, rawImages) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (!activeSid) return;
    const cleanText = typeof text === "string" ? text.trim() : "";
    const images = (Array.isArray(rawImages) ? rawImages : []).map((img, idx) => {
      const raw = img.data || img.src || "";
      const cleanB64 = raw.replace(/^data:[^;]+;base64,/, "");
      const mime = img.mimeType || (raw.startsWith("data:") ? raw.slice(5, raw.indexOf(";")) : "image/png");
      return {
        data: cleanB64,
        mimeType: mime,
        alt: img.alt || `图片附件 ${idx + 1}`,
      };
    });

    const submission = {
      id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()) + Math.random(),
      sessionId: activeSid,
      kind,
      text: cleanText,
      images,
      timestamp: Date.now(),
    };

    let list = queueSubmissionMemoryStore.get(activeSid);
    if (!list) {
      list = [];
      queueSubmissionMemoryStore.set(activeSid, list);
    }
    list.push(submission); // Never evict a possibly still-pending attachment by count.

    void idbSaveSubmission(submission);
    notifyQueueAttachmentUpdated();
  }

  // Native React owns queue rendering; this adapter owns secure RPC/recovery only.
  composerQueuePanel = null;
  let composerQueueLastEntriesSignature = "";
  let composerQueueCurrentEntries = [];
  let composerQueueRequest = null;
  let composerQueueBusy = false;
  const composerQueueUnsupported = new Set();
  let composerQueueActionsState = null;
  const composerQueueErrors = new Map();

  function showQueueUnavailable(sessionId, signature, entries) {
    const targetSid = getEffectiveQueueSessionId(sessionId);
    if (composerQueueUnsupported.has(targetSid)) {
      showQueueSecurityWarningToast("队列未改动：当前服务不支持安全队列操作");
      return;
    }
    const error = composerQueueErrors.get(targetSid) || "队列状态尚未获取";
    if (/Queue desynchronized/i.test(error)) {
      showToast("队列显示与执行状态不同步，原图文已保留；正在重新读取状态", null, 3500);
    } else {
      showToast("队列状态暂不可用，原图文已保留；正在重新读取状态", null, 3500);
    }
    loadComposerQueueTokens(targetSid, signature, entries);
  }

  function handleQueueOperationError(sessionId, errorMsg, defaultPrefix = "操作") {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    const raw = String(errorMsg || "");
    if (/unknown command|unsupported command|未安装|不支持.*(?:命令|接口)/i.test(raw)) {
      if (activeSid) composerQueueUnsupported.add(activeSid);
      composerQueueActionsState = null;
      showQueueSecurityWarningToast("队列未改动：当前服务不支持安全队列操作");
    } else {
      showToast(`${defaultPrefix}失败: ${raw || "请求异常"}`, null, 3000);
    }
  }

  function removeComposerQueuePanel() {
    clearQueueDetailCache();
    composerQueuePanel = null;
    composerQueueLastEntriesSignature = "";
    composerQueueCurrentEntries = [];
    composerQueueActionsState = null;
    window.dispatchEvent(new CustomEvent("pi:native-queue-details", { detail: { signature: "", enabled: false, busy: false, images: [] } }));
  }

  async function fetchQueuedMessageDetail(sessionId, token) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (isDisposed || !activeSid || !token) return null;
    const cacheKey = `${activeSid}:${token}`;
    const cached = getFromQueueDetailCache(cacheKey);
    if (cached) {
      return cached;
    }
    if (queuedMessageDetailInFlight.has(cacheKey)) {
      return await queuedMessageDetailInFlight.get(cacheKey);
    }
    const capturedGeneration = queueDetailCacheGeneration;
    const controller = new AbortController();
    queuedMessageDetailAbortControllers.set(cacheKey, controller);

    const p = (async () => {
      try {
        const res = await window.fetch(`/api/agent/${encodeURIComponent(activeSid)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "get_queued_message", token }),
          signal: controller.signal,
        });
        const json = await res.json();
        if (res.ok && json.success && json.data) {
          if (capturedGeneration === queueDetailCacheGeneration && !isDisposed) {
            putIntoQueueDetailCache(cacheKey, json.data);
            notifyQueueAttachmentUpdated();
          }
          return json.data;
        }
      } catch (_) {}
      return null;
    })();
    queuedMessageDetailInFlight.set(cacheKey, p);
    try {
      return await p;
    } finally {
      if (queuedMessageDetailAbortControllers.get(cacheKey) === controller) {
        queuedMessageDetailAbortControllers.delete(cacheKey);
      }
      if (queuedMessageDetailInFlight.get(cacheKey) === p) {
        queuedMessageDetailInFlight.delete(cacheKey);
      }
    }
  }

  async function loadComposerQueueTokens(sessionId, entriesSignature, entries) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (!activeSid || composerQueueRequest || composerQueueUnsupported.has(activeSid)) return;
    composerQueueRequest = entriesSignature;
    try {
      const response = await window.fetch(`/api/agent/${encodeURIComponent(activeSid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_queue_actions" }),
      });
      const result = await response.json();
      const data = result?.data;
      if (!response.ok || result.success === false) {
        composerQueueActionsState = null;
        composerQueueErrors.set(activeSid, String(result?.error || "队列状态请求失败"));
        if (/unknown command|unsupported command|不支持.*(?:命令|接口)/i.test(String(result?.error || ""))) {
          composerQueueUnsupported.add(activeSid);
        }
        return;
      }
      if (!isPluginEnabled("composer-queue-panel") || !composerQueuePanel?.isConnected
        || entriesSignature !== composerQueueLastEntriesSignature) return;

      composerQueueErrors.delete(activeSid);
      if (data?.version === 2) {
        const steering = Array.isArray(data.steering) ? data.steering : [];
        const followUp = Array.isArray(data.followUp) ? data.followUp : [];
        const totalServerCount = steering.length + followUp.length;

        if (totalServerCount !== entries.length) {
          composerQueueActionsState = null;
          return;
        }
        let isMatch = true;
        for (let i = 0; i < entries.length; i++) {
          const domEntry = entries[i];
          const serverItem = i < steering.length ? steering[i] : followUp[i - steering.length];
          const expectedKind = i < steering.length ? "steer" : "follow-up";
          if (domEntry.kind !== expectedKind || (domEntry.text || "").trim() !== (serverItem?.text || "").trim()) {
            isMatch = false;
            break;
          }
        }
        if (!isMatch) {
          composerQueueActionsState = null;
          return;
        }

        composerQueueActionsState = {
          sessionId: activeSid,
          signature: entriesSignature,
          version: 2,
          reorder: data.reorder === true,
          steering,
          followUp,
        };

        const allItems = [...steering, ...followUp];
        for (const item of allItems) {
          const cacheKey = `${activeSid}:${item.token}`;
          if (item.imageCount > 0 && !queuedMessageDetailCache.has(cacheKey)) {
            void fetchQueuedMessageDetail(activeSid, item.token);
          }
        }
        if (entriesSignature === composerQueueLastEntriesSignature) {
          notifyQueueAttachmentUpdated();
        }
      } else if (data?.version === 1) {
        const expectedFollowUp = entries.filter(e => e.kind === "follow-up");
        if (!Array.isArray(data.followUp) || data.followUp.length !== expectedFollowUp.length
          || expectedFollowUp.some((e, i) => e.text !== data.followUp[i].text)) return;
        composerQueueActionsState = {
          sessionId: activeSid,
          signature: entriesSignature,
          version: 1,
          steering: [],
          followUp: Array.isArray(data.followUp) ? data.followUp : [],
        };
      }
    } catch (error) {
      composerQueueActionsState = null;
      composerQueueErrors.set(activeSid, String(error?.message || "网络异常"));
    } finally {
      composerQueueRequest = null;
      if (composerQueueLastEntriesSignature && composerQueueLastEntriesSignature !== entriesSignature) {
        syncComposerQueuePanel(false, activeSid);
      }
    }
  }

  async function promoteComposerQueuedMessage(entryIndex, sessionId, signature) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (composerQueueBusy || !activeSid || signature !== composerQueueLastEntriesSignature) return;
    const hasSecure = composerQueueActionsState && (composerQueueActionsState.version === 1 || composerQueueActionsState.version === 2) && !composerQueueUnsupported.has(activeSid);
    if (!hasSecure) {
      showQueueUnavailable(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
      return;
    }
    if (composerQueueActionsState.sessionId !== activeSid || composerQueueActionsState.signature !== signature) {
      showToast("队列状态已更新，请重试", null, 3000);
      return;
    }
    composerQueueBusy = true;
    publishNativeQueueDetails(activeSid);

    try {
      const hasSecure = composerQueueActionsState.version === 1 || composerQueueActionsState.version === 2;
      if (!hasSecure) {
        showQueueUnavailable(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
        return;
      }

      let token = null;
      if (composerQueueActionsState.version === 2) {
        const steerCount = composerQueueActionsState.steering?.length || 0;
        const followUpIdx = entryIndex >= steerCount ? entryIndex - steerCount : -1;
        if (followUpIdx >= 0 && followUpIdx < composerQueueActionsState.followUp.length) {
          token = composerQueueActionsState.followUp[followUpIdx]?.token;
        }
      } else if (composerQueueActionsState.version === 1) {
        const steerCount = composerQueueCurrentEntries.filter((entry) => entry.kind === "steer").length;
        const followUpIdx = entryIndex >= steerCount ? entryIndex - steerCount : -1;
        if (followUpIdx >= 0 && followUpIdx < composerQueueActionsState.followUp.length) {
          token = composerQueueActionsState.followUp[followUpIdx]?.token;
        }
      }

      if (!token) {
        showQueueUnavailable(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
        return;
      }

      const res = await window.fetch(`/api/agent/${encodeURIComponent(activeSid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "promote_queued_message", token }),
      });
      const r = await res.json();
      if (res.ok && r?.success) {
        showToast("已转为立即引导，将在下一个执行点优先处理", null, 2000);
      } else {
        showToast(`转引导失败: ${r?.error || "请求异常"}`, null, 3000);
      }
    } catch (error) {
      handleQueueOperationError(activeSid, error.message, "转引导");
    } finally {
      composerQueueBusy = false;
      syncComposerQueuePanel(false, activeSid);
    }
  }

  async function reorderComposerQueuedMessage(index, targetIndex, sessionId, signature) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    const state = composerQueueActionsState;
    if (composerQueueBusy || !activeSid || signature !== composerQueueLastEntriesSignature
      || state?.signature !== signature || state?.sessionId !== activeSid || !state.reorder) return;
    const items = [...state.steering, ...state.followUp];
    const entries = composerQueueCurrentEntries;
    if (!Number.isInteger(index) || !Number.isInteger(targetIndex) || !items[index] || !items[targetIndex]
      || entries[index]?.kind !== entries[targetIndex]?.kind || index === targetIndex) return;
    composerQueueBusy = true;
    publishNativeQueueDetails(activeSid);
    try {
      const res = await window.fetch(`/api/agent/${encodeURIComponent(activeSid)}`, {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({type: "reorder_queued_message", tokens: items.map(item => item.token), token: items[index].token, targetToken: items[targetIndex].token}),
      });
      const result = await res.json();
      if (!res.ok || result?.success !== true || result.data?.version !== 2) throw new Error(result?.error || "排序失败");
    } catch (error) { handleQueueOperationError(activeSid, error.message, "排序"); }
    finally {
      composerQueueBusy = false;
      composerQueueActionsState = null;
      syncComposerQueuePanel(false, activeSid);
    }
  }

  async function recallSingleQueuedMessage(entryIndex, sessionId, signature) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (composerQueueBusy || !activeSid || signature !== composerQueueLastEntriesSignature) return;
    const hasSecure = composerQueueActionsState && composerQueueActionsState.version === 2 && !composerQueueUnsupported.has(activeSid);
    if (!hasSecure) {
      showQueueUnavailable(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
      return;
    }
    if (composerQueueActionsState.sessionId !== activeSid || composerQueueActionsState.signature !== signature) {
      showToast("队列状态已更新，请重试", null, 3000);
      return;
    }

    const native = readNativeComposerDraft();
    if (!native || native.keyRef?.current !== native.key || (native.pendingRef?.current || 0) > 0) {
      showToast("输入框正在处理中或不可用，无法安全移回", null, 3000);
      return;
    }

    const capturedOwner = native.key;
    const capturedKeyRef = native.keyRef;
    const capturedRoute = activeSid;
    const capturedSignature = signature;

    const steerList = composerQueueActionsState.steering || [];
    const followUpList = composerQueueActionsState.followUp || [];
    let token = null;
    if (entryIndex < steerList.length) {
      token = steerList[entryIndex]?.token;
    } else {
      const fIdx = entryIndex - steerList.length;
      token = followUpList[fIdx]?.token;
    }

    if (!token) {
      showQueueUnavailable(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
      return;
    }

    composerQueueBusy = true;
    publishNativeQueueDetails(activeSid);

    try {
      const payload = await fetchQueuedMessageDetail(activeSid, token);
      if (!payload) {
        showToast("获取排队消息详情失败，队列未改动", null, 3000);
        return;
      }
      const currentImages = Array.isArray(native.imagesRef?.current) ? native.imagesRef.current : [];
      const recallImages = Array.isArray(payload.images) ? payload.images : [];
      if (currentImages.length + recallImages.length > 10) {
        showToast("移回编辑失败：合并后图片数量超过 10 张上限", null, 3000);
        return;
      }

      const beforeMutation = readNativeComposerDraft();
      if (getEffectiveQueueSessionId() !== capturedRoute || composerQueueLastEntriesSignature !== capturedSignature
        || !beforeMutation || beforeMutation.key !== capturedOwner || beforeMutation.keyRef !== capturedKeyRef
        || beforeMutation.pendingRef.current > 0 || beforeMutation.imagesRef.current.length + recallImages.length > 10) return;

      let res;
      let result;
      try {
        res = await window.fetch(`/api/agent/${encodeURIComponent(activeSid)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "recall_queued_message", token }),
        });
        result = await res.json();
      } catch (networkErr) {
        downloadQueueRecovery(capturedOwner, payload.text, recallImages);
        showToast("召回结果未确认，原图文已导出备份；不会自动重发，请核对队列状态", null, 6000);
        return;
      }

      const resData = result?.data || result;
      if (!res.ok || result?.success !== true || (resData?.version !== 2 && result?.version !== 2)) {
        throw new Error(result?.error || "召回失败");
      }

      if (deliverRecalledQueuePayload(capturedOwner, capturedKeyRef, capturedRoute, payload.text, recallImages)) {
        showToast(getEffectiveQueueSessionId() === capturedRoute ? "已移回输入框编辑" : "已保存至原会话草稿", null, 1800);
      }
    } catch (error) {
      handleQueueOperationError(activeSid, error.message, "移回编辑");
    } finally {
      composerQueueBusy = false;
      syncComposerQueuePanel(false, activeSid);
    }
  }

  async function recallAllQueuedMessages(sessionId, signature, entries) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (composerQueueBusy || !activeSid || signature !== composerQueueLastEntriesSignature) return;
    const hasSecure = composerQueueActionsState && composerQueueActionsState.version === 2 && !composerQueueUnsupported.has(activeSid);
    if (!hasSecure) {
      showQueueUnavailable(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
      return;
    }
    if (composerQueueActionsState.sessionId !== activeSid || composerQueueActionsState.signature !== signature) {
      showToast("队列状态已更新，请重试", null, 3000);
      return;
    }

    const native = readNativeComposerDraft();
    if (!native || native.keyRef?.current !== native.key || (native.pendingRef?.current || 0) > 0) {
      showToast("输入框正在处理中或不可用，无法安全移回", null, 3000);
      return;
    }

    const capturedOwner = native.key;
    const capturedKeyRef = native.keyRef;
    const capturedRoute = activeSid;
    const capturedSignature = signature;

    const steerList = composerQueueActionsState.steering || [];
    const followUpList = composerQueueActionsState.followUp || [];
    const allItems = [...steerList, ...followUpList];
    const expectedTokens = allItems.map((x) => x.token);

    if (expectedTokens.length !== entries.length || expectedTokens.some((tok) => !tok)) {
      showToast("队列信息不完整，无法全部移回", null, 3000);
      return;
    }

    const totalImagesInQueue = allItems.reduce((acc, x) => acc + (x.imageCount || 0), 0);
    const currentImages = Array.isArray(native.imagesRef?.current) ? native.imagesRef.current : [];
    if (totalImagesInQueue + currentImages.length > 10) {
      showToast("超过 10 张上限，已阻止全部移回以防丢图", null, 3000);
      return;
    }

    composerQueueBusy = true;
    publishNativeQueueDetails(activeSid);

    try {
      const backup = [];
      for (const token of expectedTokens) {
        const detail = await fetchQueuedMessageDetail(activeSid, token);
        if (!detail) { showToast("详情尚未完整读取，队列未改动", null, 3000); return; }
        backup.push(detail);
      }
      const backupText = backup.map(e => e.text).filter(Boolean).join("\n\n");
      const backupImages = backup.flatMap(e => e.images || []);
      const beforeMutation = readNativeComposerDraft();
      if (getEffectiveQueueSessionId() !== capturedRoute || composerQueueLastEntriesSignature !== capturedSignature
        || !beforeMutation || beforeMutation.key !== capturedOwner || beforeMutation.keyRef !== capturedKeyRef
        || beforeMutation.pendingRef.current > 0 || beforeMutation.imagesRef.current.length + backupImages.length > 10) return;

      let res;
      let result;
      try {
        res = await window.fetch(`/api/agent/${encodeURIComponent(activeSid)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "recall_all_queued_messages", tokens: expectedTokens }),
        });
        result = await res.json();
      } catch (netErr) {
        downloadQueueRecovery(capturedOwner, backupText, backupImages);
        showToast("召回结果未确认，原图文已导出备份；不会自动重发，请核对队列状态", null, 6000);
        return;
      }

      const resData = result?.data || result;
      if (!res.ok || result?.success !== true || (resData?.version !== 2 && result?.version !== 2)) {
        throw new Error(result?.error || "全部召回失败");
      }

      const returnedEntries = result.data?.entries || [];
      const combinedTexts = returnedEntries.map((e) => e.text).filter(Boolean).join("\n\n");
      const combinedImages = returnedEntries.flatMap((e) => e.images || []);

      if (deliverRecalledQueuePayload(capturedOwner, capturedKeyRef, capturedRoute, combinedTexts, combinedImages)) {
        showToast(getEffectiveQueueSessionId() === capturedRoute ? "已全部移回输入框编辑" : "已保存至原会话草稿", null, 1800);
      }
    } catch (error) {
      handleQueueOperationError(activeSid, error.message, "全部移回");
    } finally {
      composerQueueBusy = false;
      syncComposerQueuePanel(false, activeSid);
    }
  }

  async function deleteSingleQueuedMessage(entryIndex, sessionId, signature) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (composerQueueBusy || !activeSid || signature !== composerQueueLastEntriesSignature) return;
    const hasSecure = composerQueueActionsState && composerQueueActionsState.version === 2 && !composerQueueUnsupported.has(activeSid);
    if (!hasSecure) {
      showQueueUnavailable(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
      return;
    }
    if (composerQueueActionsState.sessionId !== activeSid || composerQueueActionsState.signature !== signature) {
      showToast("队列状态已更新，请重试", null, 3000);
      return;
    }

    const steerList = composerQueueActionsState.steering || [];
    const followUpList = composerQueueActionsState.followUp || [];
    const token = entryIndex < steerList.length ? steerList[entryIndex]?.token : followUpList[entryIndex - steerList.length]?.token;

    if (!token) {
      showQueueUnavailable(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
      return;
    }

    composerQueueBusy = true;
    publishNativeQueueDetails(activeSid);

    try {
      const res = await window.fetch(`/api/agent/${encodeURIComponent(activeSid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "delete_queued_message", token }),
      });
      const result = await res.json();
      const resData = result?.data || result;
      if (!res.ok || result?.success !== true || (resData?.version !== 2 && result?.version !== 2)) {
        throw new Error(result?.error || "删除失败");
      }

      showToast("已删除该条排队消息", null, 1800);
    } catch (error) {
      handleQueueOperationError(activeSid, error.message, "删除");
    } finally {
      composerQueueBusy = false;
      syncComposerQueuePanel(false, activeSid);
    }
  }

  function getQueueEntryAttachments(sessionId, entryText, entryIndex, entryKind, entryToken) {
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (!activeSid) return [];
    const cleanText = (entryText || "").trim();

    // 1. 若后端 v2 权威接口返回了该 token 的详情（包含 empty []），优先终结！绝不向下 fallback！
    if (entryToken) {
      const cacheKey = `${activeSid}:${entryToken}`;
      const detail = getFromQueueDetailCache(cacheKey);
      if (detail) {
        if (Array.isArray(detail?.images)) {
          return detail.images.map((img, i) => ({
            data: img.data,
            mimeType: img.mimeType || "image/png",
            alt: img.alt || `图片附件 ${i + 1}`,
          }));
        }
      }
    }

    // 2. unsupported 场景或未拿到 v2 详情时：按 kind + 提交记录严格唯一匹配
    const list = queueSubmissionMemoryStore.get(activeSid);
    if (Array.isArray(list) && list.length > 0) {
      const matching = list.filter((s) => s.kind === entryKind && (s.text || "").trim() === cleanText);
      if (matching.length === 1 && Array.isArray(matching[0].images) && matching[0].images.length > 0) {
        return matching[0].images;
      }
    }

    return [];
  }

  function publishNativeQueueDetails(explicitSid = null) {
    const sessionId = getEffectiveQueueSessionId(explicitSid);
    const items = composerQueueActionsState?.signature === composerQueueLastEntriesSignature
      ? [...(composerQueueActionsState.steering || []), ...(composerQueueActionsState.followUp || [])] : [];
    window.dispatchEvent(new CustomEvent("pi:native-queue-details", { detail: {
      signature: composerQueueLastEntriesSignature,
      enabled: isPluginEnabled("composer-queue-panel"),
      busy: composerQueueBusy,
      reorder: composerQueueActionsState?.signature === composerQueueLastEntriesSignature && composerQueueActionsState?.reorder === true,
      images: composerQueueCurrentEntries.map((entry, i) => getQueueEntryAttachments(sessionId, entry.text, i, entry.kind, items[i]?.token)),
    } }));
  }

  function syncComposerQueuePanel(isAttachmentUpdateOnly = false, explicitSid = null) {
    if (!isPluginEnabled("composer-queue-panel")) {
      publishNativeQueueDetails(explicitSid);
      return;
    }
    if (!composerQueuePanel?.isConnected || !composerQueueCurrentEntries.length) return;
    const activeSid = getEffectiveQueueSessionId(explicitSid);
    publishNativeQueueDetails(activeSid);
    // Only React explicit snapshot event refreshes tokens; never DOM scans/timers.
    if (!isAttachmentUpdateOnly && activeSid && !composerQueueBusy) {
      void loadComposerQueueTokens(activeSid, composerQueueLastEntriesSignature, composerQueueCurrentEntries);
    }
  }

  const handleNativeQueueSnapshot = (event) => {
    const detail = event.detail;
    if (!detail || !Array.isArray(detail.entries)) return;
    const activeSid = getEffectiveQueueSessionId(detail.sessionId);
    if (!activeSid) return;
    composerQueuePanel = detail.host;
    const signature = JSON.stringify([activeSid, detail.entries]);
    const changed = signature !== composerQueueLastEntriesSignature;
    composerQueueCurrentEntries = detail.entries;
    composerQueueLastEntriesSignature = signature;
    if (changed) composerQueueActionsState = null;
    if (!detail.entries.length) { clearQueueDetailCache(); return; }
    syncComposerQueuePanel(!changed, activeSid);
    triggerSessionHydration(activeSid);
  };
  const handleNativeQueueAction = (event) => {
    const { action, index, targetIndex, sessionId, signature } = event.detail || {};
    const activeSid = getEffectiveQueueSessionId(sessionId);
    if (!isPluginEnabled("composer-queue-panel") || !activeSid || signature !== composerQueueLastEntriesSignature) return;
    if (action === "recall") void recallSingleQueuedMessage(index, activeSid, signature);
    else if (action === "recallAll") void recallAllQueuedMessages(activeSid, signature, composerQueueCurrentEntries);
    else if (action === "delete") void deleteSingleQueuedMessage(index, activeSid, signature);
    else if (action === "promote") void promoteComposerQueuedMessage(index, activeSid, signature);
    else if (action === "reorder") void reorderComposerQueuedMessage(index, targetIndex, activeSid, signature);
    else if (action === "gallery") {
      const items = composerQueueActionsState?.signature === signature
        ? [...(composerQueueActionsState.steering || []), ...(composerQueueActionsState.followUp || [])] : [];
      const entry = composerQueueCurrentEntries[index];
      if (!entry) return;
      const images = getQueueEntryAttachments(activeSid, entry.text, index, entry.kind, items[index]?.token);
      const gallery = images.map((img, i) => ({src: `data:${img.mimeType};base64,${img.data}`, alt: img.alt || `图片附件 ${i + 1}`}));
      if (gallery.length) openComposerImageZoomModal(gallery[0].src, gallery[0].alt, null, {items: gallery, initialIndex: 0}, {autoEdit: false, source: "queue"});
    }
  };
  window.addEventListener("pi:native-queue-snapshot", handleNativeQueueSnapshot);
  window.addEventListener("pi:native-queue-action", handleNativeQueueAction);
  activeCleanups.push(() => {
    window.removeEventListener("pi:native-queue-snapshot", handleNativeQueueSnapshot);
    window.removeEventListener("pi:native-queue-action", handleNativeQueueAction);
    removeComposerQueuePanel();
  });
  window.__PI_ENH_SYNC_COMPOSER_QUEUE__ = () => publishNativeQueueDetails();

  // Foundation composer layout, pill and resize belong to native React/static CSS.

  // ==========================================
  // 3.54.5 Composer Model / Thinking Switch Auto Focus (切换模型或思考深度后光标自动对焦输入框)
  // ==========================================
  function isModelOrThinkingSelectorTarget(target) {
    if (target?.closest?.("[data-pi-native-thinking-selector]")) return false;
    if (!target) return false;
    const el = target.nodeType === 1 ? target : target.parentElement;
    if (!el || typeof el.closest !== "function") return false;

    // 严格排除设置弹窗与模态框（dialog, .settings-modal, [data-modal]）
    if (el.closest('dialog, .settings-modal, [data-modal]')) {
      return false;
    }

    // 1. 模型选择器下拉选项：div[role="listbox"] button[role="option"]
    if (
      el.closest('div[role="listbox"] button[role="option"]') ||
      (el.closest('div[role="listbox"]') && el.closest('button[role="option"]'))
    ) {
      return true;
    }

    // 2. 思考深度选项（[data-pi-thinking-control] 下拉项）
    const thinkingControl = el.closest('[data-pi-thinking-control]');
    if (thinkingControl) {
      // 严格排除思考深度的触发/展开按钮（如 [data-pi-thinking-control] > button 或 [data-pi-thinking-button]）
      if (el.closest('[data-pi-thinking-control] > button, [data-pi-thinking-button]')) {
        return false;
      }

      // 匹配思考深度下拉选项：位于下拉浮层中的按钮、具有 option/menuitem 角色或 data-thinking-level 的选项
      if (
        el.closest(
          '[data-pi-thinking-control] div[style*="position: absolute"] button, ' +
          '[data-pi-thinking-control] div[style*="position:absolute"] button, ' +
          '[data-pi-thinking-control] button[data-thinking-level], ' +
          '[data-pi-thinking-control] [role="option"], ' +
          '[data-pi-thinking-control] [role="menuitem"]'
        )
      ) {
        return true;
      }

      // 兜底支持：思考控件内非顶层触发按钮的任意下拉选项按钮
      const btn = el.closest('button');
      if (btn && btn.parentElement !== thinkingControl) {
        return true;
      }
    }

    return false;
  }

  function handleModelSwitchAutoDocClick(e) {
    if (!isModelOrThinkingSelectorTarget(e?.target)) return;
    if (typeof isMobileEnvironment === "function" && isMobileEnvironment()) return;
    focusComposerTextarea();
  }

  function handleModelSwitchAutoDocKeydown(e) {
    if (!e || (e.key !== "Enter" && e.key !== "Escape")) return;
    const target = e.target || (typeof document !== "undefined" ? document.activeElement : null);
    if (!isModelOrThinkingSelectorTarget(target)) return;
    if (typeof isMobileEnvironment === "function" && isMobileEnvironment()) return;
    focusComposerTextarea();
  }

  addManagedListener(document, "click", handleModelSwitchAutoDocClick, true);
  addManagedListener(document, "keydown", handleModelSwitchAutoDocKeydown, true);

  window.__PI_ENH_IS_MODEL_OR_THINKING_TARGET__ = isModelOrThinkingSelectorTarget;
  window.__PI_ENH_FOCUS_COMPOSER_TEXTAREA__ = focusComposerTextarea;

  // ==========================================
  // 3.55.1 Composer Tool Buttons Visibility (压缩上下文与工具预设按钮显隐控制)
  // ==========================================
  function syncComposerToolButtons() {
    const showCompact = isPluginEnabled("composer-compact-button");
    const showToolPreset = isPluginEnabled("composer-tool-preset");

    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.classList.toggle("pi-enh-hide-composer-compact", !showCompact);
      document.documentElement.classList.toggle("pi-enh-hide-composer-tool-preset", !showToolPreset);
    }

    const fieldset = document.querySelector("[data-pi-native-composer-host]");
    if (!fieldset) return;

    for (const btn of fieldset.querySelectorAll("button")) {
      const title = (btn.getAttribute("title") || "").toLowerCase();
      const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
      const hasCompactSvg = Boolean(btn.querySelector('polyline[points*="4 14 10 14"]'));
      const hasToolPresetSvg = Boolean(btn.querySelector('path[d*="M14.7 6.3"]'));

      const isCompact = title.includes("压缩上下文") || aria.includes("压缩上下文") || title.includes("compact context") || aria.includes("compact context") || hasCompactSvg;
      const isToolPreset = title.includes("更改工具预设") || aria.includes("更改工具预设") || title.includes("tool preset") || aria.includes("tool preset") || hasToolPresetSvg;

      if (isCompact) {
        btn.setAttribute("data-pi-enh-composer-compact", "true");
        const parent = btn.parentElement;
        if (parent && parent !== fieldset && parent.tagName.toLowerCase() === "div" && parent.children.length === 1) {
          parent.setAttribute("data-pi-enh-composer-compact-wrap", "true");
        }
      }

      if (isToolPreset) {
        btn.setAttribute("data-pi-enh-composer-tool-preset", "true");
        const parent = btn.parentElement;
        if (parent && parent !== fieldset && parent.tagName.toLowerCase() === "div" && parent.children.length === 1) {
          parent.setAttribute("data-pi-enh-composer-tool-preset-wrap", "true");
        }
      }
    }
  }

  window.__PI_ENH_SYNC_COMPOSER_TOOL_BUTTONS__ = syncComposerToolButtons;
  syncComposerToolButtons();

  // ==========================================
  // 3.55.2 Codex Style Markdown Formatting & Smart Paste (输入框粘贴保持格式与 Markdown 渲染)
  // ==========================================
  let activeComposerFormatTextarea = null;
  isComposingInput = false;
  let composerCompositionEndedAt = 0;
  let lastCompositionKeyReleased = false;
  let composerFormatTextareaCleanup = null;

  function onComposerFormatCompositionStart() {
    isComposingInput = true;
    lastCompositionKeyReleased = false;
  }

  function onComposerFormatCompositionEnd() {
    isComposingInput = false;
    composerCompositionEndedAt = Date.now();
  }

  function blockComposerCompositionShortcut(event) {
    const composing = isComposingInput || event.isComposing || event.keyCode === 229
      || (Date.now() - composerCompositionEndedAt < 100 && !lastCompositionKeyReleased);
    if (!composing) return false;
    if (event.key === "Enter") {
      if (!isComposingInput && !event.isComposing) event.preventDefault();
      event.stopPropagation();
    }
    return true;
  }

  const composerUndoStack = [];
  const composerRedoStack = [];
  const MAX_COMPOSER_UNDO = 100;
  let undoDebounceTimer = null;
  let lastUndoCharsCount = 0;

  function pushComposerUndo(value) {
    if (typeof value !== "string") return;
    if (composerUndoStack[composerUndoStack.length - 1] === value) return;
    composerUndoStack.push(value);
    if (composerUndoStack.length > MAX_COMPOSER_UNDO) composerUndoStack.shift();
    composerRedoStack.length = 0;
  }

  function shouldTriggerInstantUndo(newValue, oldValue) {
    if (!newValue || !oldValue) return true;
    if (newValue.length < oldValue.length) return true;
    if (Math.abs(newValue.length - lastUndoCharsCount) >= 10) return true;
    return /[\s\n，。！？；：、,.!?;:]$/.test(newValue);
  }

  function applyComposerSnapshot(text) {
    const textarea = activeComposerFormatTextarea || findComposerTextarea();
    if (!textarea) return;
    setComposerTextareaValue(textarea, text, { focus: false });
    const cursor = String(text || "").length;
    try { textarea.setSelectionRange(cursor, cursor); } catch (_) {}
    textarea.focus();
  }

  function performComposerUndo() {
    if (undoDebounceTimer) clearTimeout(undoDebounceTimer);
    undoDebounceTimer = null;
    if (composerUndoStack.length <= 1) return;
    const current = composerUndoStack.pop();
    composerRedoStack.push(current);
    applyComposerSnapshot(composerUndoStack[composerUndoStack.length - 1] || "");
  }

  function performComposerRedo() {
    if (undoDebounceTimer) clearTimeout(undoDebounceTimer);
    undoDebounceTimer = null;
    const next = composerRedoStack.pop();
    if (typeof next !== "string") return;
    composerUndoStack.push(next);
    applyComposerSnapshot(next);
  }

  function cleanMarkdownText(md) {
    if (!md || typeof md !== "string") return "";
    return md
      .replace(/\u200B/g, "")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      // 限制连续空行最多为 1 行空行
      .replace(/\n{3,}/g, "\n\n")
      // 消除列表项之间多余的空行，保持紧凑优雅
      .replace(/(\n\s*(?:[-*+•◦▪▫–—]|\d+\.)\s+[^\n]+)\n+(?=\s*(?:[-*+•◦▪▫–—]|\d+\.)\s+)/g, "$1\n")
      .trim();
  }

  function htmlToMarkdown(html) {
    if (!html || typeof html !== "string") return "";
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (!doc || !doc.body) return "";

      function cleanText(text) {
        return text.replace(/\u00a0/g, " ");
      }

      function parseHtmlNode(node, context = {}) {
        if (!node) return "";
        if (node.nodeType === Node.TEXT_NODE) {
          let text = cleanText(node.textContent || "");
          if (!context.inPre) {
            text = text.replace(/[\t ]+/g, " ");
          }
          return text;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return "";

        const tag = node.tagName.toLowerCase();
        const style = node.getAttribute("style") || "";
        const isBold = tag === "strong" || tag === "b" || /font-weight:\s*(bold|[6-9]00)/i.test(style);
        const isItalic = tag === "em" || tag === "i" || /font-style:\s*italic/i.test(style);
        const isStrike = tag === "s" || tag === "del" || tag === "strike" || /text-decoration:\s*line-through/i.test(style);
        const isCode = (tag === "code" || tag === "kbd") && !context.inPre;

        // 图片标签：绝不把图片内容塞进输入框，只保留 alt 提示或忽略
        if (tag === "img") {
          const alt = node.getAttribute("alt") || "";
          return alt ? `[图片: ${alt}]` : "";
        }

        if (tag === "pre") {
          const codeChild = node.querySelector("code");
          const langClass = (codeChild?.className || node.className || "").match(/language-([a-zA-Z0-9_-]+)/);
          const lang = langClass ? langClass[1] : "";
          const rawCode = (codeChild || node).textContent || "";
          const cleanCode = rawCode.replace(/^\n+|\n+$/g, "");
          return `\n\`\`\`${lang}\n${cleanCode}\n\`\`\`\n`;
        }
        if (tag === "br") return "\n";
        if (tag === "hr") return "\n---\n";

        let inner = "";
        for (let child of node.childNodes) {
          inner += parseHtmlNode(child, {
            ...context,
            inPre: context.inPre || tag === "pre",
          });
        }

        if (isCode) {
          const trimmed = inner.trim();
          return trimmed ? `\`${trimmed}\`` : "";
        }
        if (isBold) {
          const trimmed = inner.trim();
          return trimmed ? `**${trimmed}**` : "";
        }
        if (isItalic) {
          const trimmed = inner.trim();
          return trimmed ? `*${trimmed}*` : "";
        }
        if (isStrike) {
          const trimmed = inner.trim();
          return trimmed ? `~~${trimmed}~~` : "";
        }

        if (/^h[1-6]$/.test(tag)) {
          const level = parseInt(tag[1], 10);
          const prefix = "#".repeat(level);
          return `\n\n${prefix} ${inner.trim()}\n\n`;
        }
        if (tag === "blockquote") {
          const lines = inner.trim().split("\n").map((l) => `> ${l}`).join("\n");
          return `\n\n${lines}\n\n`;
        }
        if (tag === "a") {
          const href = node.getAttribute("href");
          const trimmed = inner.trim();
          if (!href || href === "#" || href === trimmed) return trimmed;
          return `[${trimmed}](${href})`;
        }
        if (tag === "li") {
          const isOrdered = context.isOrdered;
          const index = context.index || 1;
          const depth = context.depth || 0;
          const indent = "  ".repeat(depth);
          const bullet = isOrdered ? `${index}. ` : "- ";
          return `\n${indent}${bullet}${inner.trim()}`;
        }
        if (tag === "ul" || tag === "ol") {
          const isOrdered = tag === "ol";
          const depth = (context.depth !== undefined) ? context.depth + 1 : 0;
          let listItems = "";
          let idx = 1;
          for (let child of node.childNodes) {
            if (child.nodeType === Node.ELEMENT_NODE && child.tagName.toLowerCase() === "li") {
              listItems += parseHtmlNode(child, { ...context, isOrdered, index: idx++, depth });
            } else {
              listItems += parseHtmlNode(child, { ...context, depth });
            }
          }
          return `\n${listItems}\n`;
        }
        if (tag === "p" || tag === "div") {
          const trimmed = inner.trim();
          return trimmed ? `\n\n${trimmed}\n\n` : "";
        }
        return inner;
      }

      return cleanMarkdownText(parseHtmlNode(doc.body));
    } catch (e) {
      return "";
    }
  }

  function hasSubstantialRichFormatting(html) {
    if (!html || typeof html !== "string") return false;
    return /<\s*(?:strong|b|em|i|code|kbd|pre|h[1-6]|ul|ol|li|blockquote|table|tr|th|td|hr)\b/i.test(html) ||
      /style\s*=\s*["'][^"']*(?:font-weight\s*:\s*(?:bold|[6-9]00)|font-style\s*:\s*italic|font-family\s*:\s*monospace)/i.test(html);
  }

  function insertMarkdownIntoComposer(md, targetTextarea = null) {
    const textarea = targetTextarea || (document.activeElement instanceof HTMLTextAreaElement
      ? document.activeElement : (activeComposerFormatTextarea || findComposerTextarea()));
    if (!textarea || textarea.tagName !== "TEXTAREA") return;

    if (undoDebounceTimer) {
      clearTimeout(undoDebounceTimer);
      undoDebounceTimer = null;
    }
    const oldValue = textarea.value || "";
    const start = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : oldValue.length;
    const end = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : start;
    const beforeText = oldValue.slice(0, start);
    const afterText = oldValue.slice(end);
    let insertion = String(md || "");
    if (beforeText && !beforeText.endsWith("\n")
      && /^(\s*(?:#{1,6}\s|[-*+•◦▪▫–—]\s|\d+\.\s|>\s*|```|~~~))/.test(insertion)) {
      insertion = "\n" + insertion;
    }
    const nextValue = beforeText + insertion + afterText;
    const nextCursor = start + insertion.length;
    pushComposerUndo(oldValue);
    setComposerTextareaValue(textarea, nextValue, { focus: false });
    try { textarea.setSelectionRange(nextCursor, nextCursor); } catch (_) {}
    textarea.focus();
    pushComposerUndo(nextValue);
    lastUndoCharsCount = nextValue.length;
  }

  function handleComposerMarkdownPaste(event) {
    if (!isPluginEnabled("composer-markdown-format")) return;
    const textarea = event.target instanceof HTMLTextAreaElement ? event.target : null;
    if (!textarea || textarea !== findComposerTextarea()) return;

    const html = event.clipboardData?.getData("text/html") || "";
    const plain = event.clipboardData?.getData("text/plain") || "";
    const files = Array.from(event.clipboardData?.files || []);
    const items = Array.from(event.clipboardData?.items || []);
    const itemFiles = items
      .filter((item) => item && item.kind === "file" && typeof item.getAsFile === "function")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    const allClipboardFiles = files.length > 0 ? files : itemFiles;
    const nonImageFiles = allClipboardFiles.filter((file) =>
      !(file.type && file.type.startsWith("image/")) || isVideoFile(file.name, file.type));

    if (nonImageFiles.length > 0 && isPluginEnabled("composer-file-paste")) {
      event.preventDefault();
      event.stopPropagation();
      void processComposerFiles(nonImageFiles, textarea);
      return;
    }

    const imageFiles = allClipboardFiles.filter((file) =>
      file.type?.startsWith("image/") && !isVideoFile(file.name, file.type));
    // Native ChatInput owns image paste. File-picker accept is mutable (the
    // attachment plugin allows arbitrary files), so never consume or relay an
    // image through a selector that can disappear after the first selection.
    if (imageFiles.length > 0) return;

    if (html && hasSubstantialRichFormatting(html)) {
      const markdown = htmlToMarkdown(html);
      if (markdown) {
        event.preventDefault();
        event.stopPropagation();
        insertMarkdownIntoComposer(markdown, textarea);
        return;
      }
    }

    if (!plain || !plain.trim()) return;
    const hasMarkdown = /(^|\n)\s*(?:#{1,6}\s|[-*+•◦▪▫–—]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|__[^_]+__|`[^`\n]+`|\[[^\]]+\]\([^)]+\)/.test(plain);
    if (!hasMarkdown) return; // Let the native textarea preserve ordinary paste, caret, IME and undo.
    event.preventDefault();
    event.stopPropagation();
    insertMarkdownIntoComposer(plain, textarea);
  }

  function instantlyClearComposerSurface(textarea, expectedOwner) {
    if (!textarea) textarea = findComposerTextarea();
    if (!textarea) return false;

    // 修复不变量 1：只可在 readNativeComposerDraft 同一 textarea/owner 且原生 valueRef/imagesRef 已经空、非 composition 时进行视觉清空
    const native = readNativeComposerDraft();
    if (!native) return false;
    if (expectedOwner && native.key !== expectedOwner) return false;
    if (native.keyRef.current !== native.key || native.textarea !== textarea || !textarea.isConnected) return false;
    if (isComposingInput || (typeof native.textarea.isComposing === "boolean" && native.textarea.isComposing)) return false;

    const nativeVal = typeof native.valueRef?.current === "string" ? native.valueRef.current : null;
    const nativeImgs = Array.isArray(native.imagesRef?.current) ? native.imagesRef.current : null;
    if (nativeVal !== "" || !nativeImgs || nativeImgs.length > 0) {
      return false;
    }

    // Native refs own consumption; a delayed controlled DOM commit is not a second authority.
    // Native React refs own content and layout; no DOM value or height writes here.
    return true;
  }

  // 点击后等待原生消费及 DOM 提交完成，再同步可见表面；不提前清草稿。
  addManagedListener(document, "click", (event) => {
    const btn = event.target?.closest?.("button");
    if (!btn) return;
    const isSend = btn.classList.contains("pi-enh-cursor-send") ||
                   btn.classList.contains("pi-enh-cursor-followup") ||
                   btn.classList.contains("pi-enh-cursor-steer") ||
                   (btn.closest("[data-pi-native-composer-host]") && (btn.textContent.includes("发送") || btn.textContent.includes("引导") || btn.textContent.includes("后续消息")));
    if (isSend && !btn.disabled) {
      const native = readNativeComposerDraft();
      const capturedOwner = native?.key;
      const capturedKeyRef = native?.keyRef;
      const capturedValueRef = native?.valueRef;
      const capturedImagesRef = native?.imagesRef;
      const capturedRoute = getCurrentSessionId();
      const capturedTextarea = native?.textarea || findComposerTextarea();
      if (capturedTextarea && capturedOwner) {
        const attemptClear = () => {
          const capturedAccepted = capturedKeyRef?.current === capturedOwner
            && capturedValueRef?.current === ""
            && Array.isArray(capturedImagesRef?.current) && capturedImagesRef.current.length === 0;
          if (capturedAccepted) {
            saveCurrentComposerDraft();
          }
          const currentNative = readNativeComposerDraft();
          // document click 的微任务必须校验捕获的 owner 未切换，若未确认原实例已消费则还需校验 keyRef/textarea
          if (!currentNative || currentNative.key !== capturedOwner || getCurrentSessionId() !== capturedRoute) return false;
          if (!capturedAccepted && (currentNative.textarea !== capturedTextarea || currentNative.keyRef !== capturedKeyRef)) return false;
          const val = typeof currentNative.valueRef?.current === "string" ? currentNative.valueRef.current : null;
          const imgs = Array.isArray(currentNative.imagesRef?.current) ? currentNative.imagesRef.current : null;
          if (val === "" && (!imgs || imgs.length === 0)) {
            return instantlyClearComposerSurface(currentNative.textarea, capturedOwner);
          }
          return false;
        };

        queueMicrotask(() => {
          if (attemptClear()) return;
          // Observe one commit, not a polling window that might clear a later edit.
          // Slower native results are reflected by the regular controlled-value sync.
          requestAnimationFrame(attemptClear);
        });
      }
    }
  }, false);

  function syncComposerMarkdownFormat() {
    if (!isPluginEnabled("composer-markdown-format")) {
      removeComposerMarkdownFormat();
      return;
    }

    const textarea = findComposerTextarea();
    if (!textarea || textarea.tagName !== "TEXTAREA") {
      removeComposerMarkdownFormat();
      return;
    }

    if (activeComposerFormatTextarea !== textarea) {
      composerFormatTextareaCleanup?.();
      composerFormatTextareaCleanup = null;
      isComposingInput = false;
      composerCompositionEndedAt = 0;
      composerUndoStack.length = 0;
      composerRedoStack.length = 0;
      pushComposerUndo(textarea.value || "");
      lastUndoCharsCount = (textarea.value || "").length;
      activeComposerFormatTextarea = textarea;
    }
    if (composerFormatTextareaCleanup) return;

    const onKeyDown = (event) => {
      if (blockComposerCompositionShortcut(event)) return;
      if ((event.ctrlKey || event.metaKey) && (event.key === "z" || event.key === "Z")) {
        if (event.shiftKey && composerRedoStack.length) {
          event.preventDefault();
          performComposerRedo();
        } else if (!event.shiftKey && composerUndoStack.length > 1) {
          event.preventDefault();
          performComposerUndo();
        }
      } else if ((event.ctrlKey || event.metaKey) && (event.key === "y" || event.key === "Y")
        && composerRedoStack.length) {
        event.preventDefault();
        performComposerRedo();
      }
    };
    const onInput = () => {
      const value = textarea.value || "";
      const previous = composerUndoStack[composerUndoStack.length - 1] || "";
      if (shouldTriggerInstantUndo(value, previous)) {
        pushComposerUndo(value);
        lastUndoCharsCount = value.length;
        if (undoDebounceTimer) clearTimeout(undoDebounceTimer);
        undoDebounceTimer = null;
      } else {
        if (undoDebounceTimer) clearTimeout(undoDebounceTimer);
        undoDebounceTimer = setTimeout(() => {
          undoDebounceTimer = null;
          if (textarea.isConnected && activeComposerFormatTextarea === textarea) {
            pushComposerUndo(textarea.value || "");
            lastUndoCharsCount = (textarea.value || "").length;
          }
        }, 350);
      }
    };

    textarea.addEventListener("paste", handleComposerMarkdownPaste, true);
    textarea.addEventListener("keydown", onKeyDown);
    textarea.addEventListener("input", onInput);
    textarea.addEventListener("compositionstart", onComposerFormatCompositionStart);
    textarea.addEventListener("compositionend", onComposerFormatCompositionEnd);
    composerFormatTextareaCleanup = () => {
      textarea.removeEventListener("paste", handleComposerMarkdownPaste, true);
      textarea.removeEventListener("keydown", onKeyDown);
      textarea.removeEventListener("input", onInput);
      textarea.removeEventListener("compositionstart", onComposerFormatCompositionStart);
      textarea.removeEventListener("compositionend", onComposerFormatCompositionEnd);
    };
  }

  function removeComposerMarkdownFormat() {
    composerFormatTextareaCleanup?.();
    composerFormatTextareaCleanup = null;
    isComposingInput = false;
    composerCompositionEndedAt = 0;
    if (undoDebounceTimer) clearTimeout(undoDebounceTimer);
    undoDebounceTimer = null;
    activeComposerFormatTextarea = null;
  }

  window.__PI_ENH_SYNC_COMPOSER_MARKDOWN_FORMAT__ = syncComposerMarkdownFormat;
  window.__PI_ENH_REMOVE_COMPOSER_MARKDOWN_FORMAT__ = removeComposerMarkdownFormat;
  window.__PI_ENH_HTML_TO_MARKDOWN__ = htmlToMarkdown;

  activeCleanups.push(removeComposerMarkdownFormat);
  window.__PI_ENH_SYNC_COMPOSER_MARKDOWN_FORMAT__ = syncComposerMarkdownFormat;
  window.__PI_ENH_REMOVE_COMPOSER_MARKDOWN_FORMAT__ = removeComposerMarkdownFormat;
  window.__PI_ENH_HTML_TO_MARKDOWN__ = htmlToMarkdown;

  // ==========================================
  // 3.55.25 Composer Clean Placeholder (清空主输入框提示词与字体优化)
  // ==========================================
  function syncComposerCleanPlaceholder() {}
  function removeComposerCleanPlaceholder() {}
  window.__PI_ENH_SYNC_COMPOSER_CLEAN_PLACEHOLDER__ = syncComposerCleanPlaceholder;
  window.__PI_ENH_REMOVE_COMPOSER_CLEAN_PLACEHOLDER__ = removeComposerCleanPlaceholder;

  // ==========================================
  // 3.55.3 Composer Modes (Codex Style Goal & Plan Modes)
  // ==========================================
  const COMPOSER_MODES_STYLE_ID = "pi-enh-composer-modes-style";
  composerModesStateMap = new Map(); // sessionId -> { mode: "normal"|"plan"|"goal", goal?: string, pausePending?: boolean, paused?: boolean }
  let composerModeSwitching = false;
  let isGoalActionRunning = false;
  pendingNewComposerMode = null; // {mode, project, sessionId?}; never a server success claim
  let composerAddMenuEl = null;
  let composerAddMenuContext = null;
  let composerModesEventsBound = false;
  let lastObservedModesSessionId = null;
  let composerModeFetchToken = 0;
  let lastComposerGoalMismatchKey = null;

  // Shared same-origin SVG geometry keeps the native menu and React controls aligned.
  const SVG_GOAL_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><use href="/icons/composer-mode-icons.svg#goal"></use></svg>`;
  const SVG_PLAN_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><use href="/icons/composer-mode-icons.svg#plan"></use></svg>`;
  const SVG_ATTACH_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`;
  const SVG_IMAGE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
  const SVG_CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

  function parseExtensionStatus(data, key) {
    const statuses = data?.extensionStatuses || data?.data?.extensionStatuses;
    if (!statuses) return null;
    let text = null;
    if (Array.isArray(statuses)) {
      const item = statuses.find((s) => s && (s.key === key || s.id === key));
      text = item?.text ?? item?.value ?? null;
    } else if (typeof statuses === "object") {
      text = statuses[key] ?? null;
    }
    if (!text) return null;
    if (typeof text === "object") return text;
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  let pendingComposerNavOverride = null; // { mode: "new" | "session", sessionId: string | null, fromUrlSessionId: string | null, until: number }
  let lastTrackedModeUrlSessionId = undefined;
  let lastTrackedModeNativeDraftKey = undefined;
  let syntheticUrlSessionForNewDraft = null; // { sessionId: string, whileDraftKey: string | null }

  function readComposerNativeDraftKey() {
    try {
      const textarea = findComposerTextarea();
      const fieldset = textarea?.closest?.("[data-pi-native-composer-host]");
      if (!fieldset || !fieldset.isConnected) return null;
      let owner = typeof committedComposerFiber === "function" ? committedComposerFiber(fieldset) : null;
      for (let depth = 0; owner && depth < 12; depth++, owner = owner.return) {
        const dk = owner.memoizedProps?.draftKey;
        if (typeof dk === "string" && dk.length > 0) {
          return dk;
        }
      }
    } catch (e) {}
    return null;
  }

  function isNewSessionWelcomeDomVisible() {
    try {
      const brandLogo = document.querySelector?.('img[data-pi-brand-logo], img[src*="apple-touch-icon"]');
      if (!brandLogo) return false;
      const rect = brandLogo.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      const msgs = document.querySelectorAll?.('div[data-message-role], [data-entry-id]');
      return !msgs || msgs.length === 0;
    } catch (e) {
      return false;
    }
  }

  function getEffectiveComposerSessionId() {
    const urlSessionId = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    const nativeDraftKey = readComposerNativeDraftKey();

    const urlChanged = lastTrackedModeUrlSessionId !== undefined && urlSessionId !== lastTrackedModeUrlSessionId;
    const draftKeyChanged = lastTrackedModeNativeDraftKey !== undefined && nativeDraftKey !== lastTrackedModeNativeDraftKey;

    if (draftKeyChanged && nativeDraftKey) {
      if (syntheticUrlSessionForNewDraft && syntheticUrlSessionForNewDraft.whileDraftKey !== nativeDraftKey) {
        syntheticUrlSessionForNewDraft = null;
      }
    }
    if (urlChanged) {
      if (urlSessionId && nativeDraftKey && nativeDraftKey.startsWith("new:") && !draftKeyChanged) {
        syntheticUrlSessionForNewDraft = { sessionId: urlSessionId, whileDraftKey: nativeDraftKey };
      } else if (!urlSessionId) {
        syntheticUrlSessionForNewDraft = null;
      }
    }

    lastTrackedModeUrlSessionId = urlSessionId;
    lastTrackedModeNativeDraftKey = nativeDraftKey;

    // 1. 捕获阶段点击「新建会话」或「侧边栏其他会话」后的瞬时零延迟覆盖（在 Next.js URL 异步更新完成前生效）
    if (pendingComposerNavOverride) {
      if (Date.now() < pendingComposerNavOverride.until) {
        if (pendingComposerNavOverride.mode === "new") {
          if (!urlSessionId) {
            pendingComposerNavOverride = null;
            return null;
          }
          if (urlSessionId === pendingComposerNavOverride.fromUrlSessionId) {
            return null;
          }
          pendingComposerNavOverride = null;
        } else if (pendingComposerNavOverride.mode === "session" && pendingComposerNavOverride.sessionId) {
          if (urlSessionId === pendingComposerNavOverride.sessionId) {
            pendingComposerNavOverride = null;
            return urlSessionId;
          }
          if (urlSessionId === pendingComposerNavOverride.fromUrlSessionId) {
            return pendingComposerNavOverride.sessionId;
          }
          pendingComposerNavOverride = null;
        }
      } else {
        pendingComposerNavOverride = null;
      }
    }

    // 2. 在同一个欢迎页草稿下主动通过 replaceState / __PI_ENH_SET_COMPOSER_MODE_STATE__ 绑定的会话 ID
    if (
      syntheticUrlSessionForNewDraft &&
      syntheticUrlSessionForNewDraft.sessionId &&
      urlSessionId === syntheticUrlSessionForNewDraft.sessionId &&
      (!nativeDraftKey || nativeDraftKey === syntheticUrlSessionForNewDraft.whileDraftKey)
    ) {
      return syntheticUrlSessionForNewDraft.sessionId;
    }

    // 3. 原生 ChatInput React Fiber 的实时 draftKey（第 0ms 同步反映新建会话 "new:..." 或目标会话 ID，杜绝 URL 滞后串台）
    if (typeof nativeDraftKey === "string" && nativeDraftKey) {
      if (nativeDraftKey.startsWith("new:")) {
        return null;
      }
      return nativeDraftKey;
    }

    // 4. 若无 Fiber draftKey 但页面明确处于新建会话欢迎页，且无合成绑定，则绝不继承滞后的旧 URL sessionId
    if (isNewSessionWelcomeDomVisible() && !syntheticUrlSessionForNewDraft) {
      return null;
    }

    return urlSessionId;
  }

  function ensureComposerModesStyle() {
    if (typeof document === "undefined" || !document.documentElement) return;
    document.documentElement.setAttribute("data-pi-composer-modes-active", "true");
    let style = document.getElementById(COMPOSER_MODES_STYLE_ID);
    if (style) return;
    style = document.createElement("style");
    style.id = COMPOSER_MODES_STYLE_ID;
    style.textContent = `
      .pi-enh-composer-add-menu {
        position: fixed !important; left: 0; box-sizing: border-box !important;
        width: max-content !important; min-width: 180px !important;
        background: var(--bg-panel, #1e1e20) !important;
        border: 1px solid var(--border, #3f3f46) !important; border-radius: 10px !important;
        box-shadow: 0 8px 24px rgba(0,0,0,.35), 0 2px 6px rgba(0,0,0,.15) !important;
        padding: 4px !important; display: flex !important; flex-direction: column !important;
        gap: 2px !important; z-index: 10040 !important; user-select: none !important;
      }
      html[data-theme="light"] .pi-enh-composer-add-menu,
      [data-theme="light"] .pi-enh-composer-add-menu {
        background: var(--bg-panel, #fff) !important; border-color: var(--border, #e4e4e7) !important;
      }
      .pi-enh-composer-menu-item {
        display: flex !important; align-items: center !important; gap: 7px !important;
        padding: 6px 8px !important; border-radius: 6px !important; background: transparent !important;
        border: none !important; color: var(--text, #f4f4f5) !important; cursor: pointer !important;
        text-align: left !important; width: 100% !important; font-size: 13px !important;
        font-weight: 500 !important; box-sizing: border-box !important;
      }
      .pi-enh-composer-menu-item:hover { background: color-mix(in srgb, var(--text, #fff) 8%, transparent) !important; }
      .pi-enh-composer-menu-item.active { background: color-mix(in srgb, var(--text, #fff) 12%, transparent) !important; }
      .pi-enh-composer-menu-item:focus-visible { outline: 2px solid var(--text-muted, #a1a1aa); outline-offset: 1px; }
      .pi-enh-composer-menu-icon { display: inline-flex !important; align-items: center !important; justify-content: center !important; width: 18px !important; height: 18px !important; flex-shrink: 0 !important; color: var(--text-muted, #a1a1aa) !important; }
      .pi-enh-composer-menu-label { display: flex !important; align-items: center !important; flex: 1 1 auto !important; min-width: 0 !important; }
      .pi-enh-composer-menu-title { white-space: nowrap !important; font-size: 13px !important; }
      .pi-enh-composer-menu-desc { font-size: 12px !important; color: var(--text-dim, #71717a) !important; margin-left: 6px !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; }
      .pi-enh-composer-menu-kbd { margin-left: auto !important; font-size: 10px !important; color: var(--text-dim, #71717a) !important; padding: 1px 4px !important; border-radius: 3px !important; border: 1px solid var(--border, #3f3f46) !important; line-height: 1.2 !important; flex-shrink: 0 !important; }
      .pi-enh-composer-menu-check { margin-left: 4px !important; display: flex !important; align-items: center !important; color: var(--text-muted, #a1a1aa) !important; flex-shrink: 0 !important; }
      .pi-enh-composer-modes-disabled-notice { display: inline-flex !important; align-items: center !important; gap: 8px !important; padding: 4px 10px !important; margin: 4px 0 !important; border-radius: 6px !important; background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent) !important; border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 40%, transparent) !important; color: var(--text, #f4f4f5) !important; font-size: 12px !important; }
      .pi-enh-composer-modes-disabled-notice button { background: color-mix(in srgb, var(--warning, #f59e0b) 30%, transparent) !important; border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 60%, transparent) !important; color: var(--text, #f4f4f5) !important; border-radius: 4px !important; padding: 2px 8px !important; font-size: 11px !important; cursor: pointer !important; }
      html[data-pi-composer-modes-active="true"] .extension-status-line[aria-label*='"version":1'] .extension-status-text,
      html[data-pi-composer-modes-active="true"] .extension-status-line[title*='"version":1'] .extension-status-text { visibility: hidden !important; }
    `;
    document.head.appendChild(style);
  }

  function getSessionComposerMode(sessionId) {
    if (!sessionId) return pendingNewComposerMode?.project === getCurrentProjectStatusKey() ? pendingNewComposerMode.mode : "normal";
    return composerModesStateMap.get(sessionId)?.mode || "normal";
  }

  function getComposerGoalState(sessionId = getEffectiveComposerSessionId()) {
    const state = sessionId ? composerModesStateMap.get(sessionId) : null;
    const goal = state?.mode === "goal" ? String(state.goal || "").trim() : "";
    if (!sessionId || !goal) return null;
    const paused = Boolean(state.paused);
    const pausePending = Boolean(state.pausePending);
    return {
      sessionId,
      mode: "goal",
      goal: String(state.goal),
      paused,
      pausePending,
      goalElapsedMs: typeof state.goalElapsedMs === "number" ? state.goalElapsedMs : null,
      goalActiveSinceMs: typeof state.goalActiveSinceMs === "number" ? state.goalActiveSinceMs : null,
      statusKey: pausePending ? "pending" : paused ? "paused" : "active",
      action: paused || pausePending ? "resume" : "pause",
    };
  }

  function dispatchComposerModeChange(sessionId = getEffectiveComposerSessionId()) {
    const mode = getSessionComposerMode(sessionId);
    const stored = sessionId ? composerModesStateMap.get(sessionId) : null;
    const state = stored ? { ...stored } : null;
    try {
      window.dispatchEvent(new CustomEvent("pi-enh-composer-mode-change", {
        detail: { sessionId: sessionId || null, mode, state, goalState: getComposerGoalState(sessionId) },
      }));
    } catch (_) {}
  }

  window.__PI_ENH_GET_COMPOSER_GOAL_STATE__ = getComposerGoalState;

  function emitComposerAddMenuChange(open) {
    try {
      window.dispatchEvent(new CustomEvent("pi-enh-composer-add-menu-change", { detail: { open: Boolean(open) } }));
    } catch (_) {}
  }

  function closeComposerAddMenu() {
    const wasOpen = Boolean(composerAddMenuEl);
    if (composerAddMenuEl) {
      try { composerAddMenuEl.remove(); } catch (_) {}
      composerAddMenuEl = null;
    }
    composerAddMenuContext = null;
    if (wasOpen) emitComposerAddMenuChange(false);
  }

  window.__PI_ENH_OPEN_COMPOSER_ADD_MENU__ = (anchor) => {
    if (!isPluginEnabled("composer-modes") || !anchor || typeof anchor.closest !== "function") return false;
    if (composerAddMenuEl && composerAddMenuContext?.addBtn === anchor) {
      closeComposerAddMenu();
      return false;
    }
    const host = anchor.closest("[data-pi-composer-mode-host]");
    const card = anchor.closest(".pi-enh-cursor-composer") || anchor.closest("[data-pi-native-composer-host]") || host?.closest(".pi-enh-cursor-composer, [data-pi-native-composer-host]");
    if (!card) return false;
    openComposerAddMenu(card, anchor);
    return Boolean(composerAddMenuEl);
  };

  function positionComposerAddMenu() {
    if (!composerAddMenuEl || !composerAddMenuContext) return;
    const { card, addBtn } = composerAddMenuContext;
    if (!card || !card.isConnected || (addBtn && !addBtn.isConnected)) {
      closeComposerAddMenu();
      return;
    }
    const cardRect = card.getBoundingClientRect();
    // 关键铁律约束：加号菜单宽度严禁超过下方输入框卡片的宽度！
    const maxAllowedWidth = Math.max(160, Math.floor(cardRect.width));
    composerAddMenuEl.style.maxWidth = `${maxAllowedWidth}px`;

    const menuRect = composerAddMenuEl.getBoundingClientRect();
    const finalLeft = Math.max(8, Math.min(cardRect.left, window.innerWidth - menuRect.width - 8));
    composerAddMenuEl.style.left = finalLeft + "px";
    composerAddMenuEl.style.top = Math.max(8, cardRect.top >= menuRect.height + 16 ? cardRect.top - menuRect.height - 8 : Math.min(cardRect.bottom + 8, window.innerHeight - menuRect.height - 8)) + "px";

    // 边界双重保险：若菜单右侧超出输入框右边缘，精确截断收紧
    if (finalLeft + menuRect.width > cardRect.right) {
      composerAddMenuEl.style.maxWidth = `${Math.max(160, Math.floor(cardRect.right - finalLeft))}px`;
    }
  }

  function openComposerAddMenu(card, addBtn) {
    closeComposerAddMenu();
    if (!card || !addBtn) return;

    const sessionId = getEffectiveComposerSessionId();
    const currentMode = getSessionComposerMode(sessionId);

    const menu = document.createElement("div");
    menu.className = "pi-enh-composer-add-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "输入框模式与附件菜单");

    // 1. 添加文件入口（支持任意类型：文档、代码、CAD模型与压缩包等）
    const fileItem = document.createElement("button");
    fileItem.type = "button";
    fileItem.className = "pi-enh-composer-menu-item";
    fileItem.title = "添加任意类型的文件";
    fileItem.innerHTML = `
      <span class="pi-enh-composer-menu-icon">${SVG_ATTACH_ICON}</span>
      <span class="pi-enh-composer-menu-label">
        <span class="pi-enh-composer-menu-title">添加文件</span>
        <span class="pi-enh-composer-menu-desc">任意类型文件</span>
      </span>
    `;
    fileItem.addEventListener("click", (e) => {
      e.stopPropagation();
      closeComposerAddMenu();
      openComposerDocumentPicker(card);
    });
    menu.appendChild(fileItem);

    // 2. 目标模式入口（按截图说明：‘设置要持续追求的目标’）
    const goalItem = document.createElement("button");
    goalItem.type = "button";
    goalItem.className = `pi-enh-composer-menu-item${currentMode === "goal" ? " active" : ""}`;
    goalItem.setAttribute("aria-label", "目标模式：设置要持续追求的目标");
    goalItem.title = "设置要持续追求的目标";
    goalItem.innerHTML = `
      <span class="pi-enh-composer-menu-icon">${SVG_GOAL_ICON}</span>
      <span class="pi-enh-composer-menu-label">
        <span class="pi-enh-composer-menu-title">目标</span>
        <span class="pi-enh-composer-menu-desc">设置要持续追求的目标</span>
      </span>
      ${currentMode === "goal" ? `<span class="pi-enh-composer-menu-check">${SVG_CHECK_ICON}</span>` : ""}
    `;
    goalItem.addEventListener("click", (e) => {
      e.stopPropagation();
      closeComposerAddMenu();
      const target = currentMode === "goal" ? "normal" : "goal";
      void requestSwitchComposerMode(target);
    });
    menu.appendChild(goalItem);

    // 3. 计划模式入口（按截图说明：‘开启计划模式’，附 Shift+Tab 快捷键提示）
    const planItem = document.createElement("button");
    planItem.type = "button";
    planItem.className = `pi-enh-composer-menu-item${currentMode === "plan" ? " active" : ""}`;
    planItem.setAttribute("aria-label", "计划模式：开启计划模式");
    planItem.title = "开启计划模式；快捷键 Shift+Tab";
    planItem.innerHTML = `
      <span class="pi-enh-composer-menu-icon">${SVG_PLAN_ICON}</span>
      <span class="pi-enh-composer-menu-label">
        <span class="pi-enh-composer-menu-title">计划</span>
        <span class="pi-enh-composer-menu-desc">开启计划模式</span>
      </span>
      <span class="pi-enh-composer-menu-kbd">Shift+Tab</span>
      ${currentMode === "plan" ? `<span class="pi-enh-composer-menu-check">${SVG_CHECK_ICON}</span>` : ""}
    `;
    planItem.addEventListener("click", (e) => {
      e.stopPropagation();
      closeComposerAddMenu();
      const target = currentMode === "plan" ? "normal" : "plan";
      void requestSwitchComposerMode(target);
    });
    menu.appendChild(planItem);

    // Portal outside the composer stacking context: native new-chat logo must never overlap the menu.
    document.body.appendChild(menu);
    menu.style.bottom = "auto";
    composerAddMenuEl = menu;
    composerAddMenuContext = { card, addBtn, openWidth: window.innerWidth };
    positionComposerAddMenu();
    emitComposerAddMenuChange(true);
  }

  async function requestSwitchComposerMode(targetMode, targetSessionId) {
    if (!["normal", "plan", "goal"].includes(targetMode)) return false;
    findComposerTextarea()?.focus();
    const sessionId = targetSessionId || getEffectiveComposerSessionId();
    if (!sessionId) {
      pendingNewComposerMode = targetMode === "normal" ? null : {mode: targetMode, project: getCurrentProjectStatusKey()};
      syncComposerModes();
      findComposerTextarea()?.focus();
      return true;
    }

    if (composerModeSwitching) {
      return false;
    }
    composerModeSwitching = true;

    try {
      // One atomic request saves the next-input mode and reads the extension's
      // authoritative result; no prompt execution or speculative UI state.
      composerModeFetchToken++;
      const postStateRes = await window.fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "set_composer_mode", mode: targetMode }),
      });
      const postStateData = await postStateRes.json().catch(() => null);
      if (!postStateRes.ok || postStateData?.success !== true) {
        showToast(postStateData?.error || "模式切换失败，请检查网络后重试", null, 3000);
        return false;
      }
      const parsed = parseExtensionStatus(postStateData, "composer-modes");
      const realMode = parsed?.mode;

      // No status is NOT proof of normal mode. Fail closed on malformed responses.
      if (parsed?.version !== 1 || postStateData?.success === false || realMode !== targetMode) {
        showToast(`模式切换未生效（当前仍为 ${realMode}），可能状态忙碌或参数受限`, null, 3000);
        return false;
      }

      // 真实生效后，才更新本地会话模式状态
      composerModeFetchToken++;
      const updatedSwitchState = {
        mode: realMode,
        goal: parsed?.goal,
        pausePending: Boolean(parsed?.pausePending),
        paused: Boolean(parsed?.paused),
      };
      if (typeof parsed?.goalElapsedMs === "number") {
        updatedSwitchState.goalElapsedMs = parsed.goalElapsedMs;
      }
      if (typeof parsed?.goalActiveSinceMs === "number") {
        updatedSwitchState.goalActiveSinceMs = parsed.goalActiveSinceMs;
      }
      composerModesStateMap.set(sessionId, updatedSwitchState);
      syncComposerModes();
      syncComposerGoalBar();
      return true;
    } catch (err) {
      showToast("切换模式发生异常，请检查网络", null, 3000);
      return false;
    } finally {
      composerModeSwitching = false;
    }
  }

  async function querySessionModeState(sessionId) {
    if (!sessionId) return;
    const token = ++composerModeFetchToken;
    try {
      // 使用只读 GET /api/agent/:id，绝不对休眠历史会话发 POST 触发服务端 startRpcSession 冷启动阻塞
      const res = await window.fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
        method: "GET",
        cache: "no-store",
      });
      if (token !== composerModeFetchToken || getEffectiveComposerSessionId() !== sessionId) return;
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      if (data && data.running === false && !data.state) return;
      const stateObj = data?.state || (data && typeof data === "object" && "extensionStatuses" in data ? data : null);
      const parsed = parseExtensionStatus(stateObj || data, "composer-modes");
      if (parsed?.mode) {
        const updatedQueryState = {
          mode: parsed.mode,
          goal: parsed.goal,
          pausePending: Boolean(parsed.pausePending),
          paused: Boolean(parsed.paused),
        };
        if (typeof parsed.goalElapsedMs === "number") {
          updatedQueryState.goalElapsedMs = parsed.goalElapsedMs;
        }
        if (typeof parsed.goalActiveSinceMs === "number") {
          updatedQueryState.goalActiveSinceMs = parsed.goalActiveSinceMs;
        }
        composerModesStateMap.set(sessionId, updatedQueryState);
        syncComposerModes();
        syncComposerGoalBar();
      } else if (stateObj && Array.isArray(stateObj.extensionStatuses)) {
        composerModesStateMap.set(sessionId, { mode: "normal" });
        syncComposerModes();
        syncComposerGoalBar();
      }
    } catch (e) {}
  }

  // ==========================================
  // 3.55.3.1 原生底栏状态文本清洗（隐藏/人性化 composer-modes JSON，保留其他扩展状态）
  // ==========================================
  const ALLOWED_COMPOSER_MODE_KEYS = new Set([
    "version",
    "mode",
    "goal",
    "toolsBeforePlan",
    "pausePending",
    "paused",
    "goalElapsedMs",
    "goalActiveSinceMs",
  ]);
  const composerModesTextNodeMap = new Map(); // TextNode -> { raw: string, formatted: string }
  const composerModesAttrMap = new Map(); // Element -> Map<attrName, { raw: string, formatted: string }>
  let composerModesStatusObserver = null;

  function extractTopLevelJsonBlocks(text) {
    if (!text || typeof text !== "string") return [];
    const blocks = [];
    let inString = false;
    let escape = false;
    let depth = 0;
    let startIndex = -1;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === "{") {
        if (depth === 0) {
          startIndex = i;
        }
        depth++;
      } else if (ch === "}") {
        if (depth > 0) {
          depth--;
          if (depth === 0 && startIndex !== -1) {
            blocks.push({
              start: startIndex,
              end: i + 1,
              raw: text.slice(startIndex, i + 1),
            });
            startIndex = -1;
          }
        }
      }
    }
    return blocks;
  }

  function sanitizeGoalInlineText(text) {
    if (!text || typeof text !== "string") return "";
    let s = text.trim();
    // 0. 处理可能的字面转义 \n
    s = s.replace(/\\n/g, "\n");
    // 1. 去除引用符号 > 与 HTML 转义的 &gt;
    s = s.replace(/^[ \t]*>[ \t]*/gm, "");
    s = s.replace(/^[ \t]*&gt;[ \t]*/gm, "");
    // 2. 去除粗体、斜体、删除线
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
    s = s.replace(/\*([^*]+)\*/g, "$1");
    s = s.replace(/__([^_]+)__/g, "$1");
    s = s.replace(/_([^_]+)_/g, "$1");
    s = s.replace(/~~([^~]+)~~/g, "$1");
    // 3. 去除行内代码反引号
    s = s.replace(/`([^`]+)`/g, "$1");
    // 4. 去除标题前缀 #
    s = s.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
    // 5. 将换行符转为空格
    s = s.replace(/\r?\n+/g, " ");
    // 6. 再次清理换行后连接处可能残留的 > 与 &gt;
    s = s.replace(/[ \t]+(?:>|&gt;)[ \t]*/g, " ");
    // 7. 合并多余空白
    s = s.replace(/\s{2,}/g, " ");
    return s.trim();
  }

  function cleanupStatusText(text) {
    if (!text || typeof text !== "string") return "";
    let s = text.trim();
    s = s.replace(/([|·•,])\s*(?:[|·•,]\s*)+/g, "$1 ");
    s = s.replace(/^[\s|·•,]+/, "");
    s = s.replace(/[\s|·•,]+$/, "");
    s = s.replace(/\s{2,}/g, " ");
    return s.trim();
  }

  function formatComposerModesStatusText(rawText, options = {}) {
    if (!rawText || typeof rawText !== "string") return "";
    const blocks = extractTopLevelJsonBlocks(rawText);
    if (!blocks.length) return rawText;

    let hasMatchedMode = false;
    let result = rawText;

    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      let parsed = null;
      try {
        parsed = JSON.parse(b.raw);
      } catch (e) {
        continue;
      }

      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        parsed.version !== 1 ||
        typeof parsed.mode !== "string" ||
        !["normal", "plan", "goal"].includes(parsed.mode)
      ) {
        continue;
      }

      // 仅该扩展允许的键（version, mode, goal, toolsBeforePlan），任何包含额外无关键的 JSON 均原样保留不修改
      const parsedKeys = Object.keys(parsed);
      const hasDisallowedKey = parsedKeys.some((k) => !ALLOWED_COMPOSER_MODE_KEYS.has(k));
      if (hasDisallowedKey) {
        continue;
      }

      hasMatchedMode = true;
      let replacement = "";
      if (options.hideAll || options.stripForBadge) {
        replacement = "";
      } else if (parsed.mode === "normal") {
        replacement = options.normalLabel ?? "";
      } else if (parsed.mode === "plan") {
        replacement = options.planLabel ?? "计划模式";
      } else if (parsed.mode === "goal") {
        if (parsed.goal && typeof parsed.goal === "string" && parsed.goal.trim()) {
          const cleanGoal = sanitizeGoalInlineText(parsed.goal);
          replacement = options.goalPrefix ? `${options.goalPrefix}${cleanGoal}` : `目标: ${cleanGoal}`;
        } else {
          replacement = options.goalLabel ?? "目标模式";
        }
      }

      result = result.slice(0, b.start) + replacement + result.slice(b.end);
    }

    if (!hasMatchedMode) {
      return rawText;
    }

    return cleanupStatusText(result);
  }

  function clearGoalTimer() {}

  function removeComposerGoalBar() {
    dispatchComposerModeChange();
  }

  async function handleComposerGoalAction(action, targetSessionId, btnEl) {
    if (isGoalActionRunning) return;
    const sid = targetSessionId || (typeof getEffectiveComposerSessionId === "function" ? getEffectiveComposerSessionId() : getCurrentSessionId());
    if (!sid) return;

    isGoalActionRunning = true;

    try {
      // 0. 检查后端扩展命令是否已注册，防止旧会话尚未加载扩展时将 /composer-goal 当作普通用户消息发给模型
      const cmdRes = await window.fetch(`/api/agent/${encodeURIComponent(sid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_commands" }),
      });
      if (!cmdRes.ok) {
        showToast("无法获取会话命令列表，已拒绝发送目标控制指令", null, 2500);
        return false;
      }
      const cmdData = await cmdRes.json().catch(() => null);
      if (cmdData && cmdData.success === false) {
        showToast("获取会话命令列表失败，已拒绝发送目标控制指令", null, 2500);
        return false;
      }
      const commands = cmdData?.data?.commands || cmdData?.commands || [];
      const hasComposerGoal = Array.isArray(commands) && commands.some(
        (c) => c?.name === "composer-goal" || c?.name === "/composer-goal"
      );
      if (!hasComposerGoal) {
        showToast("该会话未加载 composer-goal 命令，需等待空闲后输入 /reload 重新加载", null, 4000);
        return false;
      }

      // 1. 发送真实 POST 扩展命令（/composer-goal pause|resume 在忙碌中亦被允许）
      const promptRes = await window.fetch(`/api/agent/${encodeURIComponent(sid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "prompt", message: `/composer-goal ${action}` }),
      });

      if (!promptRes.ok) {
        showToast("目标控制请求失败，请稍后重试", null, 2500);
        return false;
      }
      const promptData = await promptRes.json().catch(() => null);
      if (promptData && promptData.success === false) {
        showToast(`目标控制被拒绝: ${promptData.error || "未知原因"}`, null, 3000);
        return false;
      }

      // 2. 回读对应会话状态确认（必须读取真实扩展状态，绝不伪造成功）
      const postStateRes = await window.fetch(`/api/agent/${encodeURIComponent(sid)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_state" }),
      });

      if (!postStateRes.ok) {
        showToast("回读会话状态失败，未更新目标状态", null, 2500);
        return false;
      }

      const postStateData = await postStateRes.json().catch(() => null);
      const parsed = parseExtensionStatus(postStateData, "composer-modes");

      if (!parsed || parsed.version !== 1 || parsed.mode !== "goal" || postStateData?.success === false) {
        showToast("回读状态异常或目标模式已改变，操作未确认", null, 3000);
        return false;
      }

      const newPending = Boolean(parsed.pausePending);
      const newPaused = Boolean(parsed.paused);

      if (action === "pause" && !newPending && !newPaused) {
        showToast("暂停未生效，请检查会话状态", null, 3000);
        return false;
      }
      if (action === "resume" && (newPending || newPaused)) {
        showToast("恢复未生效，请重试", null, 3000);
        return false;
      }

      // 3. 真实确认后更新本地会话模式映射
      const prev = composerModesStateMap.get(sid) || {};
      const updatedActionState = {
        ...prev,
        mode: parsed.mode || "goal",
        goal: parsed.goal || prev.goal,
        pausePending: newPending,
        paused: newPaused,
      };
      if (typeof parsed?.goalElapsedMs === "number") {
        updatedActionState.goalElapsedMs = parsed.goalElapsedMs;
      }
      if (typeof parsed?.goalActiveSinceMs === "number") {
        updatedActionState.goalActiveSinceMs = parsed.goalActiveSinceMs;
      } else {
        delete updatedActionState.goalActiveSinceMs;
      }
      composerModesStateMap.set(sid, updatedActionState);

      // 4. 刷新目标独立行
      syncComposerGoalBar();
      syncComposerModesBottomStatus();
      return true;
    } catch (e) {
      showToast("操作发生异常，请检查网络", null, 3000);
      return false;
    } finally {
      isGoalActionRunning = false;
    }
  }

  function syncComposerGoalBar() {
    dispatchComposerModeChange();
  }

  let isCleaningComposerModesStatus = false;

  function syncComposerModesBottomStatus() {
    if (!isPluginEnabled("composer-modes")) {
      restoreComposerModesBottomStatus();
      return;
    }
    if (isCleaningComposerModesStatus) return;
    isCleaningComposerModesStatus = true;
    try {
      ensureComposerModesStatusObserver();

      // 1. 清理已断开连接的节点与元素，杜绝内存泄漏
      for (const [node] of composerModesTextNodeMap) {
        if (!node.isConnected) {
          composerModesTextNodeMap.delete(node);
        }
      }
      for (const [el] of composerModesAttrMap) {
        if (!el.isConnected) {
          composerModesAttrMap.delete(el);
        }
      }

      // 2. 状态行根节点定位（优先整体状态行，避免重复处理；normal空状态绝不隐藏整行，保留其它扩展）
      const lines = document.querySelectorAll(
        '.extension-status-line[role="status"], .extension-status-line'
      );
      const roots = lines.length > 0
        ? Array.from(lines)
        : Array.from(document.querySelectorAll('.extension-status-text'));

      if (!roots.length) return;

      for (const root of roots) {
        if (!root.isConnected) continue;

        // 提取并维护左侧目标胶囊（Badge）
        let activeGoalInfo = null;
        let activePlanInfo = null;

        const allText = root.textContent || "";
        let jsonBlocks = extractTopLevelJsonBlocks(allText);

        // 若当前 DOM 文本已被 TreeWalker 清洗，从记录的 raw 文本中恢复检测模式，避免 MutationObserver 重复触发时误删 Badge
        if (!jsonBlocks.length) {
          for (const [node, record] of composerModesTextNodeMap) {
            if (node.isConnected && root.contains(node) && record.raw) {
              const rawBlocks = extractTopLevelJsonBlocks(record.raw);
              if (rawBlocks.length) {
                jsonBlocks = rawBlocks;
                break;
              }
            }
          }
        }

        for (let bi = 0; bi < jsonBlocks.length; bi++) {
          try {
            const p = JSON.parse(jsonBlocks[bi].raw);
            if (p && p.version === 1) {
              if (p.mode === "goal" && p.goal && typeof p.goal === "string" && p.goal.trim()) {
                activeGoalInfo = p;
                const currentSid = typeof getEffectiveComposerSessionId === "function"
                  ? getEffectiveComposerSessionId()
                  : (typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null);
                if (currentSid) {
                  const prev = composerModesStateMap.get(currentSid);
                  // 仅当会话状态映射已为 goal 且 goal 文本与 p.goal 一致时，才从底栏 status 更新暂停状态；
                  // 防止会话切换瞬间残留的旧状态栏 raw JSON 将旧 goal 污染写入新会话缓存，缓存不一致时以真实回读为准
                  if (prev && prev.mode === "goal" && prev.goal === p.goal) {
                    const nextPending = Boolean(p.pausePending);
                    const nextPaused = Boolean(p.paused);
                    const nextElapsed = typeof p.goalElapsedMs === "number" ? p.goalElapsedMs : undefined;
                    const nextActiveSince = typeof p.goalActiveSinceMs === "number" ? p.goalActiveSinceMs : undefined;
                    if (
                      Boolean(prev.pausePending) !== nextPending ||
                      Boolean(prev.paused) !== nextPaused ||
                      prev.goalElapsedMs !== nextElapsed ||
                      prev.goalActiveSinceMs !== nextActiveSince
                    ) {
                      const updatedBottomState = {
                        ...prev,
                        mode: "goal",
                        goal: p.goal,
                        pausePending: nextPending,
                        paused: nextPaused,
                      };
                      if (nextElapsed !== undefined) {
                        updatedBottomState.goalElapsedMs = nextElapsed;
                      } else {
                        delete updatedBottomState.goalElapsedMs;
                      }
                      if (nextActiveSince !== undefined) {
                        updatedBottomState.goalActiveSinceMs = nextActiveSince;
                      } else {
                        delete updatedBottomState.goalActiveSinceMs;
                      }
                      composerModesStateMap.set(currentSid, updatedBottomState);
                      syncComposerGoalBar();
                    }
                  } else {
                    const mismatchKey = `${currentSid}|${p.goal}`;
                    if (lastComposerGoalMismatchKey !== mismatchKey) {
                      lastComposerGoalMismatchKey = mismatchKey;
                      void querySessionModeState(currentSid);
                    }
                  }
                }
              } else if (p.mode === "plan") {
                activePlanInfo = p;
              }
            }
          } catch (e) {}
        }

        if (!activeGoalInfo && !activePlanInfo) {
          const currentSid = typeof getEffectiveComposerSessionId === "function"
            ? getEffectiveComposerSessionId()
            : (typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null);
          const sessionState = currentSid ? composerModesStateMap.get(currentSid) : null;
          if (sessionState?.mode === "goal" && sessionState?.goal?.trim()) {
            activeGoalInfo = sessionState;
          } else if (sessionState?.mode === "plan") {
            activePlanInfo = sessionState;
          }
        }

        // 底栏不再放置目标胶囊，如有遗留一律清除，将底栏空间完全留给 LSP / Mail 扩展
        const isStatusLine = root.classList?.contains("extension-status-line");
        const statusLineEl = isStatusLine ? root : root.closest?.(".extension-status-line");

        if (statusLineEl && statusLineEl.isConnected && typeof statusLineEl.querySelector === "function") {
          const badgeEl = statusLineEl.querySelector(".pi-enh-status-goal-badge");
          if (badgeEl) {
            badgeEl.remove();
          }
        }

        // 3. TreeWalker 遍历具体 Text 节点并修改 nodeValue，保留所有 React 原生元素和 ANSI span
        if (typeof document.createTreeWalker === "function") {
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
          let node = walker.nextNode();
          while (node) {
            if (node.isConnected) {
              if (!node.parentElement?.closest?.(".pi-enh-status-goal-badge")) {
                const current = node.nodeValue || "";
                const record = composerModesTextNodeMap.get(node);

                // 若当前内容正是我们格式化的文本且 React 未写入新状态，跳过
                if (record && current === record.formatted) {
                  // no-op
                } else {
                  // 全新节点或 React 更新写入了新内容，以当前文本作为 raw 基准；底栏彻底清洗 composer-modes 文本留给其它扩展
                  const raw = current;
                  const formatted = formatComposerModesStatusText(raw, { stripForBadge: true });
                  if (formatted !== raw) {
                    composerModesTextNodeMap.set(node, { raw, formatted });
                    node.nodeValue = formatted;
                  } else if (record) {
                    composerModesTextNodeMap.delete(node);
                  }
                }
              }
            }
            node = walker.nextNode();
          }
        }

        // 4. 属性清洗（title 与 aria-label 避免向用户悬停露出原始 JSON，同样条件式存储）
        const elementsWithAttrs = [];
        if (root.hasAttribute?.("title") || root.hasAttribute?.("aria-label")) {
          elementsWithAttrs.push(root);
        }
        if (typeof root.querySelectorAll === "function") {
          const children = root.querySelectorAll("[title], [aria-label]");
          for (let i = 0; i < children.length; i++) {
            elementsWithAttrs.push(children[i]);
          }
        }

        for (const el of elementsWithAttrs) {
          if (!el.isConnected) continue;
          let attrMap = composerModesAttrMap.get(el);

          for (const attrName of ["title", "aria-label"]) {
            if (!el.hasAttribute(attrName)) continue;
            const current = el.getAttribute(attrName) || "";
            const record = attrMap?.get(attrName);

            if (record && current === record.formatted) {
              continue;
            }

            const raw = current;
            const formatted = formatComposerModesStatusText(raw);
            if (formatted !== raw) {
              if (!attrMap) {
                attrMap = new Map();
                composerModesAttrMap.set(el, attrMap);
              }
              attrMap.set(attrName, { raw, formatted });
              el.setAttribute(attrName, formatted);
            } else if (record) {
              attrMap.delete(attrName);
              if (attrMap.size === 0) {
                composerModesAttrMap.delete(el);
              }
            }
          }
        }
      }
    } finally {
      isCleaningComposerModesStatus = false;
    }
  }

  function restoreComposerModesBottomStatus() {
    if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
      document.querySelectorAll(".pi-enh-status-goal-badge").forEach(el => {
        try { el.remove(); } catch (e) {}
      });
    }
    if (composerModesStatusObserver) {
      try { composerModesStatusObserver.disconnect(); } catch (e) {}
      composerModesStatusObserver = null;
    }

    // 1. 条件式还原 Text 节点：仅当节点仍连接且内容等于 formatted 才恢复 raw，绝不覆盖 React 新写入
    for (const [node, record] of composerModesTextNodeMap) {
      if (node.isConnected && node.nodeValue === record.formatted) {
        node.nodeValue = record.raw;
      }
    }
    composerModesTextNodeMap.clear();

    // 2. 条件式还原属性：仅当元素仍连接且属性值等于 formatted 才恢复 raw
    for (const [el, attrMap] of composerModesAttrMap) {
      if (el.isConnected) {
        for (const [attrName, record] of attrMap) {
          if (el.getAttribute(attrName) === record.formatted) {
            el.setAttribute(attrName, record.raw);
          }
        }
      }
    }
    composerModesAttrMap.clear();
  }

  function ensureComposerModesStatusObserver() {
    if (!isPluginEnabled("composer-modes")) {
      if (composerModesStatusObserver) {
        try { composerModesStatusObserver.disconnect(); } catch (e) {}
        composerModesStatusObserver = null;
      }
      return;
    }
    if (composerModesStatusObserver) return;
    if (typeof MutationObserver !== "function") return;

    composerModesStatusObserver = new MutationObserver((mutations) => {
      if (isCleaningComposerModesStatus) return;
      let shouldSync = false;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === "childList") {
          const target = m.target;

          // 彻底忽略本插件自身徽章、目标横条与浮层卡片的变动，防止自触发
          if (
            target?.classList?.contains("pi-enh-status-goal-badge") ||
            target?.classList?.contains("pi-enh-goal-tooltip-card") ||
            target?.classList?.contains("pi-enh-composer-goal-bar") ||
            target?.closest?.(".pi-enh-status-goal-badge, .pi-enh-goal-tooltip-card, .pi-enh-composer-goal-bar")
          ) {
            continue;
          }
          let isOurOwnChange = false;
          for (let j = 0; j < m.addedNodes.length; j++) {
            const an = m.addedNodes[j];
            if (an.nodeType === 1 && (an.classList?.contains("pi-enh-status-goal-badge") || an.classList?.contains("pi-enh-goal-tooltip-card") || an.classList?.contains("pi-enh-composer-goal-bar"))) {
              isOurOwnChange = true;
              break;
            }
          }
          for (let j = 0; j < m.removedNodes.length; j++) {
            const rn = m.removedNodes[j];
            if (rn.nodeType === 1 && (rn.classList?.contains("pi-enh-status-goal-badge") || rn.classList?.contains("pi-enh-goal-tooltip-card") || rn.classList?.contains("pi-enh-composer-goal-bar"))) {
              isOurOwnChange = true;
              break;
            }
          }
          if (isOurOwnChange) continue;

          // 1. 检查目标容器是否为 status 相关（React 更新 status-text 内部 childList TextNode）
          if (
            target && target.nodeType === 1 &&
            (target.classList?.contains("extension-status-text") ||
             target.classList?.contains("extension-status-line") ||
             target.classList?.contains("extension-status-shelf") ||
             target.closest?.(".extension-status-shelf, .extension-status-line"))
          ) {
            shouldSync = true;
            break;
          }

          // 2. 检查新增节点：仅检查 relevant class，严禁在普通消息节点做昂贵 querySelector
          for (let j = 0; j < m.addedNodes.length; j++) {
            const node = m.addedNodes[j];
            if (node.nodeType === 1) {
              const cl = node.classList;
              if (
                cl?.contains("extension-status-shelf") ||
                cl?.contains("extension-status-line") ||
                cl?.contains("extension-status-text")
              ) {
                shouldSync = true;
                break;
              }
              // 仅当整块新建挂载 chat-content 容器时才扫描内部状态栏
              if (cl?.contains("chat-content") && node.querySelector?.(".extension-status-shelf, .extension-status-line, .extension-status-text")) {
                shouldSync = true;
                break;
              }
            }
          }
        } else if (m.type === "characterData") {
          const parent = m.target.parentElement;
          if (parent?.closest?.(".extension-status-shelf, .extension-status-line")) {
            shouldSync = true;
          }
        }
        if (shouldSync) break;
      }
      if (shouldSync) {
        syncComposerModesBottomStatus();
        syncComposerGoalBar();
      }
    });

    try {
      const root = document.documentElement || document.body;
      if (root) {
        composerModesStatusObserver.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    } catch (e) {}
  }

  function handleComposerModesResize() {
    if (!composerAddMenuEl) return;
    const currentWidth = window.innerWidth;
    // 宽度发生变化（如横竖屏切换或拉伸窗口）：合理关闭菜单
    if (composerAddMenuContext && typeof composerAddMenuContext.openWidth === "number" && composerAddMenuContext.openWidth !== currentWidth) {
      closeComposerAddMenu();
      return;
    }
    // 视口高度发生变化（如移动端虚拟键盘收起/弹出）：保持菜单打开，重新计算定位以紧贴 composer
    positionComposerAddMenu();
    if (typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => {
        if (composerAddMenuEl) positionComposerAddMenu();
      });
    }
  }

  function handleComposerModesDocClick(e) {
    const target = e.target;
    if (target && typeof target.closest === "function" && isPluginEnabled("composer-modes")) {
      const btnOrLink = target.closest("button, a");
      if (btnOrLink) {
        const title = String(btnOrLink.getAttribute("title") || "");
        const ariaLabel = String(btnOrLink.getAttribute("aria-label") || "");
        const text = String(btnOrLink.textContent || "").replace(/\s+/g, " ").trim();
        const isNewSessionBtn =
          title.includes("新建会话") ||
          title.includes("New session") ||
          ariaLabel.includes("新建会话") ||
          ariaLabel.includes("New session") ||
          text === "新建" ||
          text === "+ 新建" ||
          text === "New" ||
          text === "+ New" ||
          btnOrLink.hasAttribute("data-pi-enh-new-session");
        if (isNewSessionBtn) {
          const urlSid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
          pendingComposerNavOverride = { mode: "new", sessionId: null, fromUrlSessionId: urlSid, until: Date.now() + 5000 };
          syntheticUrlSessionForNewDraft = null;
          pendingNewComposerMode = null;
          clearGoalTimer();
          removeComposerGoalBar();
          syncComposerModes();
        }
      }
      const sessionRow = target.closest("[data-pi-enh-session-id], [data-session-id], a[href*='session=']");
      if (sessionRow && !target.closest(".pi-enh-session-menu-btn, .pi-enh-archived-checkbox, input[type='checkbox']")) {
        let clickedSid = sessionRow.getAttribute("data-pi-enh-session-id") || sessionRow.getAttribute("data-session-id") || null;
        if (!clickedSid && sessionRow.tagName === "A") {
          const href = sessionRow.getAttribute("href") || "";
          const m = href.match(/[?&]session=([^&#]+)/);
          if (m) {
            try { clickedSid = decodeURIComponent(m[1]); } catch (err) {}
          }
        }
        if (clickedSid) {
          const curSid = getEffectiveComposerSessionId();
          if (clickedSid !== curSid) {
            const urlSid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
            pendingComposerNavOverride = { mode: "session", sessionId: clickedSid, fromUrlSessionId: urlSid, until: Date.now() + 5000 };
            syntheticUrlSessionForNewDraft = null;
            syncComposerGoalBar();
            syncComposerModes();
          }
        }
      }
    }

    const anchor = composerAddMenuContext?.addBtn;
    const targetInsideAnchor = Boolean(anchor && (anchor === e.target || anchor.contains?.(e.target)));
    if (composerAddMenuEl && !composerAddMenuEl.contains(e.target) && !targetInsideAnchor) {
      closeComposerAddMenu();
    }
  }

  function handleComposerModesDocKeydown(e) {
    if (e.key === "Escape" && composerAddMenuEl) {
      closeComposerAddMenu();
    }
    if (e.ctrlKey && e.altKey && (e.key === "n" || e.key === "N") && isPluginEnabled("composer-modes")) {
      const urlSid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
      pendingComposerNavOverride = { mode: "new", sessionId: null, fromUrlSessionId: urlSid, until: Date.now() + 5000 };
      syntheticUrlSessionForNewDraft = null;
      pendingNewComposerMode = null;
      clearGoalTimer();
      removeComposerGoalBar();
      syncComposerModes();
    }
  }

  function bindComposerModesEvents() {
    if (!composerModesEventsBound) {
      composerModesEventsBound = true;
      document.addEventListener("click", handleComposerModesDocClick, true);
      document.addEventListener("keydown", handleComposerModesDocKeydown, true);
      window.addEventListener("resize", handleComposerModesResize);
      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", handleComposerModesResize);
      }
    }
  }

  function unbindComposerModesEvents() {
    if (composerModesEventsBound) {
      document.removeEventListener("click", handleComposerModesDocClick, true);
      document.removeEventListener("keydown", handleComposerModesDocKeydown, true);
      window.removeEventListener("resize", handleComposerModesResize);
      if (window.visualViewport) {
        window.visualViewport.removeEventListener("resize", handleComposerModesResize);
      }
      composerModesEventsBound = false;
    }
  }

  function syncComposerModes() {
    const observedId = getEffectiveComposerSessionId();
    const sessionChanged = observedId !== lastObservedModesSessionId;
    if (sessionChanged) {
      lastObservedModesSessionId = observedId;
      closeComposerAddMenu();
      if (pendingNewComposerMode?.sessionId && pendingNewComposerMode.sessionId !== observedId) pendingNewComposerMode = null;
      if (observedId) void querySessionModeState(observedId);
    }

    if (!isPluginEnabled("composer-modes")) {
      removeComposerModes();
      dispatchComposerModeChange(observedId);
      return;
    }

    ensureComposerModesStyle();
    ensureComposerModesStatusObserver();
    bindComposerModesEvents();
    document.querySelectorAll(".pi-enh-composer-modes-disabled-notice").forEach((el) => el.remove());
    if (pendingNewComposerMode && pendingNewComposerMode.project !== getCurrentProjectStatusKey()) pendingNewComposerMode = null;
    syncComposerModesBottomStatus();
    dispatchComposerModeChange(observedId);
  }

  addManagedListener(window, "pi-native-composer-preferences-change", syncComposerModes);

  async function requestExitModeWithVerification(sessionId) {
    if (!sessionId) return false;
    const res = await window.fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "/composer-mode normal" }),
    }).catch(() => null);
    if (!res || !res.ok) {
      showToast("请求退出模式失败，写权限未恢复", null, 3000);
      return false;
    }
    const stateRes = await window.fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "get_state" }),
    }).catch(() => null);
    const postData = await stateRes?.json?.().catch(() => null);
    const parsed = parseExtensionStatus(postData, "composer-modes");
    const realMode = parsed?.mode;
    if (stateRes?.ok && postData?.success !== false && parsed?.version === 1 && realMode === "normal") {
      composerModesStateMap.set(sessionId, { mode: "normal" });
      dispatchComposerModeChange(sessionId);
      document.querySelectorAll(".pi-enh-composer-modes-disabled-notice").forEach((el) => {
        try { el.remove(); } catch (e) {}
      });
      showToast("已成功退出模式并恢复常规权限", null, 2500);
      return true;
    } else {
      showToast(`退出模式失败（当前仍为 ${realMode}），写权限未恢复`, null, 3000);
      return false;
    }
  }

  function removeComposerModes(options = {}) {
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.removeAttribute("data-pi-composer-modes-active");
    }
    closeComposerAddMenu();
    const textarea = findComposerTextarea();
    unbindComposerModesEvents();
    restoreComposerModesBottomStatus();
    removeComposerGoalBar();

    // 安全不变量：禁用仅关闭常规 UI 增强，严禁自动恢复写权限。
    // 若后台仍处于 plan 或 goal 激活模式，必须保留简明状态提醒条与回读退出按钮，不可在关闭时默默失去状态
    const currentSessionId = getEffectiveComposerSessionId();
    const currentMode = getSessionComposerMode(currentSessionId);
    if ((currentMode === "plan" || currentMode === "goal") && currentSessionId && !options.forceCleanNotice) {
      const card = textarea?.closest?.(".pi-enh-cursor-composer") || textarea?.closest?.("[data-pi-native-composer-host]");
      if (card && !card.querySelector(".pi-enh-composer-modes-disabled-notice")) {
        const notice = document.createElement("div");
        notice.className = "pi-enh-composer-modes-disabled-notice";
        const modeText = currentMode === "plan" ? "只读计划模式" : "目标模式";
        notice.innerHTML = `
          <span>后台仍处于${modeText}${currentMode === "plan" ? "（只读）" : ""}，界面增强已关闭</span>
          <button type="button">退出${currentMode === "plan" ? "只读计划" : "目标"}模式</button>
        `;
        const exitBtn = notice.querySelector("button");
        exitBtn.addEventListener("click", () => {
          void requestExitModeWithVerification(currentSessionId);
        });
        card.insertBefore(notice, card.firstChild);
      }
    } else {
      document.querySelectorAll(".pi-enh-composer-modes-disabled-notice").forEach((el) => {
        try { el.remove(); } catch (e) {}
      });
    }

    // 只有当没有遗留后台提醒条时，才清理样式表
    const hasNotice = Boolean(document.querySelector(".pi-enh-composer-modes-disabled-notice"));
    if (!hasNotice) {
      const style = document.getElementById(COMPOSER_MODES_STYLE_ID);
      if (style) {
        try { style.remove(); } catch (e) {}
      }
    }
    dispatchComposerModeChange(currentSessionId);
  }

  function handleComposerModesDisabled() {
    // 禁用插件仅关闭常规 UI 增强（加号菜单、快捷键、placeholder），严禁自动恢复写权限！
    // 若后台 plan 或 goal 激活，保留简明状态提醒与退出按钮，回读成功后才退出并清理
    pendingNewComposerMode = null;
    removeComposerModes({ preserveBackgroundNotice: true });
  }

  activeCleanups.push(() => removeComposerModes({ forceCleanNotice: true }));
  window.__PI_ENH_SYNC_COMPOSER_MODES__ = syncComposerModes;
  window.__PI_ENH_REMOVE_COMPOSER_MODES__ = removeComposerModes;
  window.__PI_ENH_GET_COMPOSER_MODE__ = getSessionComposerMode;
  window.__PI_ENH_SWITCH_COMPOSER_MODE__ = requestSwitchComposerMode;
  window.__PI_ENH_GET_CURRENT_SESSION_ID__ = getCurrentSessionId;
  window.__PI_ENH_GET_EFFECTIVE_COMPOSER_SESSION_ID__ = getEffectiveComposerSessionId;
  window.__PI_ENH_FORMAT_COMPOSER_MODES_STATUS_TEXT__ = formatComposerModesStatusText;
  window.__PI_ENH_SYNC_COMPOSER_MODES_BOTTOM_STATUS__ = syncComposerModesBottomStatus;
  window.__PI_ENH_RESTORE_COMPOSER_MODES_BOTTOM_STATUS__ = restoreComposerModesBottomStatus;
  window.__PI_ENH_COMPOSER_MODES_TEXT_NODE_MAP__ = composerModesTextNodeMap;
  window.__PI_ENH_COMPOSER_MODES_ATTR_MAP__ = composerModesAttrMap;
  window.__PI_ENH_SET_COMPOSER_MODE_STATE__ = (sessionId, state) => {
    pendingComposerNavOverride = null;
    if (sessionId) {
      syntheticUrlSessionForNewDraft = {
        sessionId,
        whileDraftKey: readComposerNativeDraftKey(),
      };
    }
    composerModesStateMap.set(sessionId, state);
    syncComposerModes();
    syncComposerGoalBar();
  };
  window.__PI_ENH_SYNC_COMPOSER_GOAL_BAR__ = syncComposerGoalBar;
  window.__PI_ENH_REMOVE_COMPOSER_GOAL_BAR__ = removeComposerGoalBar;
  window.__PI_ENH_HANDLE_COMPOSER_GOAL_ACTION__ = handleComposerGoalAction;

  // ==========================================
  // 3.55.4 At-Mention Plugins & Workflow Directives (@ 提及聚焦插件与目标计划)
  // ==========================================
  const AT_MENTION_STYLE_ID = "pi-enh-at-mention-style";
  let atMentionMenuEl = null;
  let activeAtTextarea = null;
  let currentAtMatch = null;
  let currentFilteredAtItems = [];
  let currentActiveAtIndex = 0;
  let cachedExtraSessionSkills = [];
  let lastFetchedSkillsSessionId = null;
  let isAtMentionGlobalClickBound = false;

  const BASE_AT_MENTION_ITEMS = [
    // 🧩 插件与技能（重点展示 Chrome use 及其它核心高频插件）
    {
      id: "chrome-use",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "chrome-use",
      badge: "推荐",
      subtitle: "Chrome 自动化浏览器 · 真实网页操作/数据抓取/验证",
      insertText: "@chrome-use ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>',
      keywords: ["chrome-use", "chrome", "browser", "浏览器", "网页", "抓取", "爬虫", "自动化"],
      priority: 100,
    },
    {
      id: "subagent",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "subagent",
      badge: "并行",
      subtitle: "子代理协作 · 派发独立工作代理执行任务",
      insertText: "@subagent ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"></rect><circle cx="12" cy="5" r="2"></circle><path d="M12 7v4"></path><line x1="8" y1="16" x2="8" y2="16"></line><line x1="16" y1="16" x2="16" y2="16"></line></svg>',
      keywords: ["subagent", "agent", "子代理", "派发", "并行", "worker", "scout"],
      priority: 95,
    },
    {
      id: "web_search",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "web_search",
      badge: "联网",
      subtitle: "联网深度搜索 · 多源检索与事实查证",
      insertText: "@web_search ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
      keywords: ["web_search", "web", "search", "联网", "搜索", "查资料", "检索"],
      priority: 90,
    },
    {
      id: "playwright",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "playwright",
      badge: "测试",
      subtitle: "端到端自动化测试 · 网页回归与控制台核验",
      insertText: "@playwright ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f472b6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>',
      keywords: ["playwright", "e2e", "test", "测试", "截图", "无头浏览器"],
      priority: 85,
    },
    {
      id: "systematic-debugging",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "systematic-debugging",
      badge: "排错",
      subtitle: "系统化调试 · 根因定位与防猜测试验",
      insertText: "@systematic-debugging ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="14" x="8" y="6" rx="4"></rect><path d="m19 7-3 2"></path><path d="m5 7 3 2"></path><path d="m19 19-3-2"></path><path d="m5 19 3-2"></path><path d="M20 13h-4"></path><path d="M4 13h4"></path><path d="m10 4 1 2"></path><path d="m14 4-1 2"></path></svg>',
      keywords: ["systematic-debugging", "debug", "排错", "根因", "定位", "bug"],
      priority: 80,
    },
    {
      id: "synology-docker-ops",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "synology-docker-ops",
      badge: "NAS",
      subtitle: "群晖 10.0.0.2 NAS 容器与存储安全运维",
      insertText: "@synology-docker-ops ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2dd4bf" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 13h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h4"></path><path d="M2 13h4a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H2"></path><path d="M20 21a8 8 0 0 0-16 0"></path><rect x="9" y="3" width="6" height="6" rx="1"></rect></svg>',
      keywords: ["synology-docker-ops", "synology", "nas", "群晖", "docker", "容器"],
      priority: 75,
    },
    {
      id: "local-clash-proxy",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "local-clash-proxy",
      badge: "网络",
      subtitle: "局域网双轨代理 · 本地/群晖 Clash 路由分流",
      insertText: "@local-clash-proxy ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>',
      keywords: ["local-clash-proxy", "clash", "proxy", "代理", "局域网"],
      priority: 70,
    },
    {
      id: "haier-codex-remote",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "haier-codex-remote",
      badge: "服务器",
      subtitle: "海尔服务器共享 Codex 容器与环境直连",
      insertText: "@haier-codex-remote ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a3e635" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"></rect><rect x="2" y="14" width="20" height="8" rx="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>',
      keywords: ["haier-codex-remote", "haier", "海尔", "服务器", "远程", "codex"],
      priority: 65,
    },
    {
      id: "android-automate",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "android-automate",
      badge: "移动端",
      subtitle: "Android 自动化 · Redmi K80 等多设备控制",
      insertText: "@android-automate ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>',
      keywords: ["android-automate", "android", "手机", "k80", "miro", "安卓"],
      priority: 60,
    },
    {
      id: "llm-wiki",
      category: "plugin",
      categoryLabel: "🧩 插件与技能",
      title: "llm-wiki",
      badge: "知识库",
      subtitle: "持久化 LLM Wiki 知识沉淀与双向链接回溯",
      insertText: "@llm-wiki ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#c084fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>',
      keywords: ["llm-wiki", "wiki", "知识库", "笔记", "知识", "沉淀"],
      priority: 55,
    },

    // 🎯 目标与计划工作流指令
    {
      id: "target-goal",
      category: "workflow",
      categoryLabel: "🎯 目标与计划",
      title: "目标 (Goal)",
      badge: "指令",
      subtitle: "明确当前任务的核心目标与最终交付标准",
      insertText: "@目标: ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg>',
      keywords: ["目标", "goal", "target", "核心目标", "目的", "交付", "mb"],
      priority: 50,
    },
    {
      id: "workflow-plan",
      category: "workflow",
      categoryLabel: "🎯 目标与计划",
      title: "计划 (Plan)",
      badge: "指令",
      subtitle: "制定分步推演计划、执行路径与依赖关系",
      insertText: "@计划: ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#818cf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><rect x="8" y="2" width="8" height="4" rx="1"></rect><path d="M9 14h6"></path><path d="M9 18h6"></path><path d="M9 10h2"></path></svg>',
      keywords: ["计划", "plan", "steps", "步骤", "执行计划", "阶段", "jh"],
      priority: 45,
    },
    {
      id: "workflow-todo",
      category: "workflow",
      categoryLabel: "🎯 目标与计划",
      title: "待办清单 (Todo)",
      badge: "指令",
      subtitle: "列出当前任务必须逐项完成的 Checklist",
      insertText: "@待办: ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11 3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
      keywords: ["待办", "todo", "list", "清单", "任务", "checklist", "db"],
      priority: 40,
    },
    {
      id: "workflow-constraint",
      category: "workflow",
      categoryLabel: "🎯 目标与计划",
      title: "约束与红线 (Constraint)",
      badge: "指令",
      subtitle: "强调核心不变量、禁止事项与安全边界",
      insertText: "@约束: ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
      keywords: ["约束", "constraint", "禁止", "铁律", "边界", "安全", "ys"],
      priority: 35,
    },
    {
      id: "workflow-idea",
      category: "workflow",
      categoryLabel: "🎯 目标与计划",
      title: "技术思路 (Idea)",
      badge: "指令",
      subtitle: "架构设想、技术选型与备选方案分析",
      insertText: "@思路: ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#eab308" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"></path></svg>',
      keywords: ["思路", "idea", "方案", "架构", "设计", "推演", "sl"],
      priority: 30,
    },
    {
      id: "workflow-acceptance",
      category: "workflow",
      categoryLabel: "🎯 目标与计划",
      title: "验收标准 (Acceptance)",
      badge: "指令",
      subtitle: "设定自动化测试、视觉核验与零用户复测要求",
      insertText: "@验收: ",
      icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><path d="m9 12 2 2 4-4"></path></svg>',
      keywords: ["验收", "acceptance", "验证", "测试", "证据", "标准", "ys"],
      priority: 25,
    },
  ];

  function ensureAtMentionStyles() {
    let style = document.getElementById(AT_MENTION_STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = AT_MENTION_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `
      /* @ 提及增强插件样式 */
      .pi-enh-at-mention-active .pi-enh-cursor-composer div[style*="max-height: min(48vh"],
      .pi-enh-at-mention-active .pi-enh-cursor-composer div[style*="max-height:min(48vh"],
      .pi-enh-at-mention-active div[style*="max-height: min(48vh"][style*="z-index: 120"] {
        display: none !important;
      }

      .pi-enh-at-mention-menu {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 8px);
        z-index: 130;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.16);
        overflow: hidden;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        max-height: min(48vh, 420px);
        user-select: none;
      }

      .pi-enh-at-mention-menu .pi-enh-at-items-scroll::-webkit-scrollbar {
        width: 5px;
      }
      .pi-enh-at-mention-menu .pi-enh-at-items-scroll::-webkit-scrollbar-thumb {
        background: var(--border);
        border-radius: 3px;
      }

      .pi-enh-at-item {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 10px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--text);
        cursor: pointer;
        text-align: left;
        box-sizing: border-box;
        transition: background 0.1s, border-color 0.1s;
        outline: none;
      }
      .pi-enh-at-item:hover,
      .pi-enh-at-item.is-active {
        background: var(--bg-selected) !important;
      }
      .pi-enh-at-item:focus {
        outline: none;
      }
    `;
  }

  function removeAtMentionStyles() {
    const style = document.getElementById(AT_MENTION_STYLE_ID);
    if (style) {
      try { style.remove(); } catch (e) {}
    }
    if (document.documentElement) {
      document.documentElement.classList.remove("pi-enh-at-mention-active");
    }
  }

  async function fetchExtraSessionSkills(sessionId) {
    if (!sessionId || sessionId === lastFetchedSkillsSessionId) return;
    lastFetchedSkillsSessionId = sessionId;
    try {
      const res = await window.fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_commands" }),
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      const commands = data?.data?.commands || [];
      const skillCmds = commands.filter((c) => c?.source === "skill" && c?.name);
      const existingIds = new Set(BASE_AT_MENTION_ITEMS.map((x) => x.id));
      const extra = [];
      for (const cmd of skillCmds) {
        const rawName = cmd.name.replace(/^skill:/, "");
        if (existingIds.has(rawName)) continue;
        extra.push({
          id: rawName,
          category: "plugin",
          categoryLabel: "🧩 插件与技能",
          title: rawName,
          badge: "技能",
          subtitle: cmd.description || `系统技能 ${rawName}`,
          insertText: `@${rawName} `,
          icon: "⚡",
          keywords: [rawName, "skill", "技能"],
          priority: 20,
        });
      }
      cachedExtraSessionSkills = extra;
      if (atMentionMenuEl && atMentionMenuEl.isConnected && activeAtTextarea && currentAtMatch) {
        renderAtMentionMenu(activeAtTextarea, currentAtMatch);
      }
    } catch (e) {}
  }

  function getAtMentionCandidates(query) {
    const q = (query || "").trim().toLowerCase();
    const all = [...BASE_AT_MENTION_ITEMS, ...(cachedExtraSessionSkills || [])];
    if (!q) {
      return all.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    const scored = [];
    for (const item of all) {
      let score = 0;
      const id = (item.id || "").toLowerCase();
      const title = (item.title || "").toLowerCase();
      const sub = (item.subtitle || "").toLowerCase();
      const keys = item.keywords || [];

      if (id === q || title === q) score += 100;
      else if (id.startsWith(q) || title.startsWith(q)) score += 80;
      else if (keys.some((k) => k.toLowerCase() === q)) score += 75;
      else if (keys.some((k) => k.toLowerCase().startsWith(q))) score += 60;
      else if (id.includes(q) || title.includes(q)) score += 50;
      else if (sub.includes(q)) score += 30;
      else if (keys.some((k) => k.toLowerCase().includes(q))) score += 20;

      if (score > 0) {
        scored.push({ item, score: score + (item.priority || 0) * 0.1 });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.item);
  }

  function extractAtMentionMatch(textarea) {
    if (!textarea) return null;
    const text = textarea.value || "";
    if (text.indexOf("@") === -1) return null;
    const cursor = typeof textarea.selectionStart === "number" ? textarea.selectionStart : text.length;
    const textBefore = text.slice(0, cursor);
    if (textBefore.indexOf("@") === -1) return null;
    const match = /(?:^|\s)@([^\s]*)$/.exec(textBefore);
    if (!match) return null;
    const query = match[1] || "";
    const atStart = textBefore.length - query.length - 1;
    return {
      start: atStart,
      query,
      cursor,
    };
  }

  function applyAtMentionCompletion(item) {
    if (!item || !activeAtTextarea || !currentAtMatch) {
      closeAtMentionMenu();
      return;
    }
    const textarea = activeAtTextarea;
    const val = textarea.value || "";
    const atStart = currentAtMatch.start;
    const cursor = typeof textarea.selectionStart === "number" ? textarea.selectionStart : val.length;
    const before = val.slice(0, atStart);
    const after = val.slice(cursor);

    const insertText = item.insertText;
    const newVal = before + insertText + after;
    const newCursor = before.length + insertText.length;

    if (typeof setComposerTextareaValue === "function") {
      setComposerTextareaValue(textarea, newVal, { focus: true });
    } else {
      const proto = window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : null;
      const nativeSetter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
      if (nativeSetter) {
        nativeSetter.call(textarea, newVal);
      } else {
        textarea.value = newVal;
      }
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (typeof syncComposerMarkdownFormat === "function") {
      try { syncComposerMarkdownFormat(); } catch (e) {}
    }

    closeAtMentionMenu();

    requestAnimationFrame(() => {
      try {
        textarea.focus();
        textarea.setSelectionRange(newCursor, newCursor);
      } catch (e) {}
    });
  }

  function getActiveAtMentionMenu(textarea) {
    if (!isPluginEnabled("at-mention-plugins") || activeAtTextarea !== textarea || !atMentionMenuEl?.isConnected) return null;
    return { count: currentFilteredAtItems?.length || 0 };
  }

  function moveActiveAtMentionItem(delta) {
    const count = currentFilteredAtItems?.length || 0;
    if (!atMentionMenuEl?.isConnected || count === 0) return;
    currentActiveAtIndex = (currentActiveAtIndex + delta + count) % count;
    updateAtMentionActiveItem();
  }

  function applyActiveAtMentionItem() {
    if (!atMentionMenuEl?.isConnected) return false;
    const targetItem = currentFilteredAtItems?.[currentActiveAtIndex];
    if (!targetItem) return false;
    applyAtMentionCompletion(targetItem);
    return true;
  }

  function renderAtMentionMenu(textarea, match) {
    if (!isPluginEnabled("at-mention-plugins")) {
      closeAtMentionMenu();
      return;
    }

    const items = getAtMentionCandidates(match.query);
    currentFilteredAtItems = items;
    if (currentActiveAtIndex >= items.length) {
      currentActiveAtIndex = 0;
    }

    const container = textarea.closest(".pi-enh-cursor-contents")
      || textarea.closest("[data-pi-native-composer-host] > div")
      || textarea.parentElement;
    if (!container) return;

    if (!atMentionMenuEl) {
      atMentionMenuEl = document.createElement("div");
      atMentionMenuEl.className = "pi-enh-at-mention-menu";
      atMentionMenuEl.setAttribute("data-pi-at-menu", "true");
      atMentionMenuEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
    }

    const matchCountText = items.length === 1 ? "1 个匹配项" : `${items.length} 个匹配项`;
    let html = `
      <div style="padding: 8px 12px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--text-dim); flex-shrink: 0; background: var(--bg);">
        <span style="font-weight: 500; display: flex; align-items: center; gap: 5px;">
          <span>@ 插件功能与指令</span>
          <span style="opacity: 0.6;">·</span>
          <span>${matchCountText}</span>
        </span>
        <span style="font-family: var(--font-mono); font-size: 10px; opacity: 0.85;">Tab / Enter · ↑↓ 选择 · Esc</span>
      </div>
      <div class="pi-enh-at-items-scroll" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px;">
    `;

    if (items.length === 0) {
      html += `
        <div style="padding: 16px 12px; font-size: 12px; color: var(--text-dim); text-align: center;">
          未找到匹配的插件功能或指令
        </div>
      `;
    } else {
      let lastCategory = null;
      items.forEach((item, index) => {
        if (!match.query && item.categoryLabel && item.categoryLabel !== lastCategory) {
          lastCategory = item.categoryLabel;
          html += `
            <div style="padding: 6px 8px 3px; font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--text-dim); letter-spacing: 0.03em;">
              ${item.categoryLabel}
            </div>
          `;
        }

        const active = index === currentActiveAtIndex;
        const bg = active ? "var(--bg-selected)" : "transparent";
        const badgeHtml = item.badge ? `<span style="display: inline-block; font-size: 9.5px; padding: 1px 5px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); font-weight: 500; margin-left: 6px; vertical-align: middle;">${item.badge}</span>` : "";

        html += `
          <button
            type="button"
            class="pi-enh-at-item ${active ? 'is-active' : ''}"
            data-index="${index}"
            style="
              width: 100%;
              display: flex;
              align-items: center;
              justify-content: space-between;
              gap: 8px;
              padding: 7px 10px;
              border: none;
              border-radius: 8px;
              background: ${bg};
              color: var(--text);
              cursor: pointer;
              text-align: left;
              box-sizing: border-box;
              transition: background 0.1s;
              outline: none;
            "
          >
            <div style="display: flex; align-items: center; gap: 9px; min-width: 0; flex: 1 1 auto;">
              <span style="font-size: 16px; flex-shrink: 0; line-height: 1; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px; background: var(--bg-panel); border: 1px solid var(--border);">${item.icon || '⚡'}</span>
              <div style="min-width: 0; flex: 1 1 auto;">
                <div style="display: flex; align-items: center; line-height: 1.2;">
                  <span style="font-size: 13px; font-weight: 600; font-family: var(--font-mono); color: var(--text);">${item.title}</span>
                  ${badgeHtml}
                </div>
                <div style="font-size: 11px; color: var(--text-dim); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  ${item.subtitle || ''}
                </div>
              </div>
            </div>
            <div style="flex-shrink: 0; font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); background: var(--bg-panel); padding: 2px 6px; border-radius: 4px; border: 1px solid var(--border);">
              ${item.insertText.trim()}
            </div>
          </button>
        `;
      });
    }

    html += `</div>`;
    atMentionMenuEl.innerHTML = html;

    const btnNodes = atMentionMenuEl.querySelectorAll("button.pi-enh-at-item");
    btnNodes.forEach((btn) => {
      const idx = Number(btn.getAttribute("data-index"));
      btn.addEventListener("mouseenter", () => {
        currentActiveAtIndex = idx;
        updateAtMentionActiveItem();
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        applyAtMentionCompletion(items[idx]);
      });
    });

    if (!atMentionMenuEl.parentElement || atMentionMenuEl.parentElement !== container) {
      container.appendChild(atMentionMenuEl);
    }

    updateAtMentionActiveItem();
  }

  function updateAtMentionActiveItem() {
    if (!atMentionMenuEl) return;
    const btnNodes = atMentionMenuEl.querySelectorAll("button.pi-enh-at-item");
    btnNodes.forEach((btn, idx) => {
      const active = idx === currentActiveAtIndex;
      btn.style.background = active ? "var(--bg-selected)" : "transparent";
      if (active) {
        btn.classList.add("is-active");
        try {
          btn.scrollIntoView({ block: "nearest", inline: "nearest" });
        } catch (e) {}
      } else {
        btn.classList.remove("is-active");
      }
    });
  }

  function closeAtMentionMenu() {
    if (atMentionMenuEl) {
      try { atMentionMenuEl.remove(); } catch (e) {}
      atMentionMenuEl = null;
    }
    currentAtMatch = null;
    currentFilteredAtItems = [];
    currentActiveAtIndex = 0;
  }

  function checkAndHandleTextareaInput(textarea) {
    if (!isPluginEnabled("at-mention-plugins")) {
      closeAtMentionMenu();
      return;
    }
    activeAtTextarea = textarea;
    const match = extractAtMentionMatch(textarea);
    if (!match) {
      if (currentAtMatch || atMentionMenuEl) {
        closeAtMentionMenu();
      }
      return;
    }
    currentAtMatch = match;
    renderAtMentionMenu(textarea, match);

    const sid = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    if (sid) {
      fetchExtraSessionSkills(sid);
    }
  }

  function bindAtMentionToTextarea(textarea) {
    if (!textarea || textarea.__piAtMentionBound) return;
    textarea.__piAtMentionBound = true;

    textarea.addEventListener("input", () => {
      checkAndHandleTextareaInput(textarea);
    });

    textarea.addEventListener("click", () => {
      checkAndHandleTextareaInput(textarea);
    });

    textarea.addEventListener("keyup", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
        checkAndHandleTextareaInput(textarea);
      }
    });

    textarea.addEventListener("blur", () => {
      setTimeout(() => {
        if (atMentionMenuEl && !atMentionMenuEl.contains(document.activeElement)) {
          closeAtMentionMenu();
        }
      }, 200);
    });

  }

  function syncAtMentionPluginsFeature() {
    const enabled = isPluginEnabled("at-mention-plugins");
    window.__PI_ENH_DISABLE_NATIVE_AT_FILES__ = Boolean(enabled);

    if (document.documentElement) {
      document.documentElement.classList.toggle("pi-enh-at-mention-active", Boolean(enabled));
    }

    if (!enabled) {
      closeAtMentionMenu();
      removeAtMentionStyles();
      return;
    }

    ensureAtMentionStyles();

    if (!isAtMentionGlobalClickBound) {
      isAtMentionGlobalClickBound = true;
      document.addEventListener("click", (e) => {
        if (atMentionMenuEl && !atMentionMenuEl.contains(e.target)) {
          const ta = activeAtTextarea;
          if (!ta || !ta.contains(e.target)) {
            closeAtMentionMenu();
          }
        }
      });
    }

    const textareas = document.querySelectorAll("textarea.chat-input-textarea, textarea");
    textareas.forEach((ta) => bindAtMentionToTextarea(ta));
  }

  function syncAtMentionPluginsPluginState(enabled) {
    window.__PI_ENH_DISABLE_NATIVE_AT_FILES__ = Boolean(enabled);
    if (!enabled) {
      closeAtMentionMenu();
      removeAtMentionStyles();
    } else {
      syncAtMentionPluginsFeature();
    }
  }

  window.__PI_ENH_SYNC_AT_MENTIONS__ = syncAtMentionPluginsFeature;
  window.__PI_ENH_GET_ACTIVE_AT_MENTION_MENU__ = getActiveAtMentionMenu;
  window.__PI_ENH_MOVE_ACTIVE_AT_MENTION__ = moveActiveAtMentionItem;
  window.__PI_ENH_APPLY_ACTIVE_AT_MENTION__ = applyActiveAtMentionItem;
  window.__PI_ENH_GET_AT_MENTION_CANDIDATES__ = getAtMentionCandidates;
  window.__PI_ENH_APPLY_AT_MENTION__ = applyAtMentionCompletion;
  window.__PI_ENH_CLOSE_AT_MENTION_MENU__ = closeAtMentionMenu;
  window.__PI_ENH_EXTRACT_AT_MATCH__ = extractAtMentionMatch;

  // ==========================================
  // 3.56 Image Preview (历史消息单击预览，其余图片双击预览)
  // ==========================================
  function isEligibleDblClickImage(el) {
    if (!el || !el.tagName || el.tagName.toLowerCase() !== "img") return false;
    if (isComposerAttachmentImage(el)) return false;
    let p = el.parentElement;
    while (p) {
      const tag = p.tagName ? p.tagName.toLowerCase() : "";
      if (tag === "dialog" || tag === "pre" || tag === "code") {
        return false;
      }
      if (tag === "button") {
        if (p !== el.parentElement || !isNativeImagePreviewTrigger(p)) {
          return false;
        }
      }
      const cls = p.className || "";
      if (typeof cls === "string" && (
        cls.includes("pi-enh-image-zoom-dialog")
        || cls.includes("image-preview-dialog")
        || cls.includes("pi-enh-plugins-panel")
        || cls.includes("pi-enh-notifications-panel")
        || cls.includes("pi-enh-queue-panel")
        || cls.includes("pi-enh-queue-image-badge")
      )) {
        return false;
      }
      p = p.parentElement;
    }
    const nw = el.naturalWidth || el.width || 0;
    const nh = el.naturalHeight || el.height || 0;
    const cw = el.clientWidth || 0;
    const ch = el.clientHeight || 0;
    if ((nw > 0 && nw <= 24 && nh > 0 && nh <= 24) || (cw > 0 && cw <= 24 && ch > 0 && ch <= 24)) {
      return false;
    }
    const src = el.currentSrc || el.src || el.getAttribute?.("src") || "";
    if (!src || (src.startsWith("data:image/svg+xml") && src.length < 100)) {
      return false;
    }
    if (el.hasAttribute?.("data-no-zoom") || el.hasAttribute?.("data-pi-enh-no-zoom")) {
      return false;
    }
    return true;
  }

  function collectGalleryImages(target) {
    const filePanel = target.closest?.("#file-panel, .right-panel-container, [data-panel='file']");
    if (filePanel) {
      const imgs = Array.from(filePanel.querySelectorAll("img")).filter(isEligibleDblClickImage);
      if (imgs.length > 0 && imgs.includes(target)) {
        return {
          items: imgs.map((img, i) => ({
            src: img.currentSrc || img.src || img.getAttribute("src") || "",
            alt: img.alt || img.getAttribute("alt") || `第 ${i + 1} 张图片`,
            domElement: img,
          })),
          initialIndex: imgs.indexOf(target),
        };
      }
    }

    const messageEl = target.closest?.("[data-message-role], .chat-message, [data-message-id]");
    if (messageEl) {
      const imgs = Array.from(messageEl.querySelectorAll("img")).filter(isEligibleDblClickImage);
      if (imgs.length > 0 && imgs.includes(target)) {
        return {
          items: imgs.map((img, i) => ({
            src: img.currentSrc || img.src || img.getAttribute("src") || "",
            alt: img.alt || img.getAttribute("alt") || `第 ${i + 1} 张图片`,
            domElement: img,
          })),
          initialIndex: imgs.indexOf(target),
        };
      }
    }

    const chatContainer = target.closest?.(".chat-container, [data-chat-scroll-container], main, .chat-column");
    if (chatContainer) {
      const imgs = Array.from(chatContainer.querySelectorAll("img")).filter(isEligibleDblClickImage);
      if (imgs.length > 1 && imgs.includes(target)) {
        return {
          items: imgs.map((img, i) => ({
            src: img.currentSrc || img.src || img.getAttribute("src") || "",
            alt: img.alt || img.getAttribute("alt") || `第 ${i + 1} 张图片`,
            domElement: img,
          })),
          initialIndex: imgs.indexOf(target),
        };
      }
    }

    const src = target.currentSrc || target.src || target.getAttribute?.("src") || "";
    const alt = target.alt || target.getAttribute?.("alt") || "图片预览";
    return {
      items: [{ src, alt, domElement: target }],
      initialIndex: 0,
    };
  }

  function isHistoryMessageImageTarget(target) {
    return Boolean(target?.closest?.("[data-message-role], .chat-message, [data-message-id]"));
  }

  function handleImageDblClick(event) {
    if (!isPluginEnabled("image-dblclick-preview")) return;
    const rawTarget = event.target;
    if (!rawTarget) return;
    const enclosingButton = rawTarget.closest ? rawTarget.closest("button") : null;
    if (enclosingButton && !isNativeImagePreviewTrigger(enclosingButton)) return;
    const target = unwrapNativeImagePreviewTarget(rawTarget);
    if (!isEligibleDblClickImage(target) || isHistoryMessageImageTarget(target)) return;

    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();

    const gallery = collectGalleryImages(target);
    const currentItem = gallery.items[gallery.initialIndex] || {
      src: target.currentSrc || target.src || target.getAttribute?.("src") || "",
      alt: target.alt || target.getAttribute?.("alt") || "图片预览",
    };

    openComposerImageZoomModal(currentItem.src, currentItem.alt, null, gallery, { autoEdit: false, dblClickPreview: true });
  }

  function handleImageMouseOver(event) {
    if (!isPluginEnabled("image-dblclick-preview")) return;
    const rawTarget = event.target;
    if (!rawTarget) return;
    const enclosingButton = rawTarget.closest ? rawTarget.closest("button") : null;
    if (enclosingButton && !isNativeImagePreviewTrigger(enclosingButton)) return;
    const target = unwrapNativeImagePreviewTarget(rawTarget);
    if (isEligibleDblClickImage(target)) {
      target.classList?.add("pi-enh-dblclick-zoomable");
      const inPanel = Boolean(target.closest?.("#file-panel, .right-panel-container, [data-panel='file']"));
      const hint = isHistoryMessageImageTarget(target) ? "单击全屏预览" : inPanel ? "点击全屏预览" : "双击全屏预览";
      if (!target.hasAttribute || !target.hasAttribute("title") || target.getAttribute("title") === "" || target.getAttribute("title").includes("全屏预览")) {
        target.setAttribute?.("title", hint);
      }
    }
  }

  function handleImageClick(event) {
    if (!isPluginEnabled("image-dblclick-preview")) return;
    const rawTarget = event.target;
    if (!rawTarget) return;
    const enclosingButton = rawTarget.closest ? rawTarget.closest("button") : null;
    if (enclosingButton && !isNativeImagePreviewTrigger(enclosingButton)) return;
    const target = unwrapNativeImagePreviewTarget(rawTarget);
    if (!isEligibleDblClickImage(target)) return;

    // 重点：如果在右侧文件浏览窗口内部，单击立即打开大图全屏预览！
    const filePanel = target.closest?.("#file-panel, .right-panel-container, [data-panel='file']");
    if (filePanel) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();

      const gallery = collectGalleryImages(target);
      const currentItem = gallery.items[gallery.initialIndex] || {
        src: target.currentSrc || target.src || target.getAttribute?.("src") || "",
        alt: target.alt || target.getAttribute?.("alt") || "图片预览",
      };

      openComposerImageZoomModal(
        currentItem.src,
        currentItem.alt,
        null,
        gallery,
        { autoEdit: false, dblClickPreview: true }
      );
      return;
    }

    if (isHistoryMessageImageTarget(target)) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();

      const gallery = collectGalleryImages(target);
      const currentItem = gallery.items[gallery.initialIndex] || {
        src: target.currentSrc || target.src || target.getAttribute?.("src") || "",
        alt: target.alt || target.getAttribute?.("alt") || "图片预览",
      };
      openComposerImageZoomModal(
        currentItem.src,
        currentItem.alt,
        null,
        gallery,
        { autoEdit: false, allowAddToConversation: true, dblClickPreview: true }
      );
      return;
    }

    // 保留非历史原生 ImagePreview 的点击行为，确保双击插件关闭/卸载时仍可使用原生预览。
    if (isNativeImagePreviewTrigger(target.parentElement)) {
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
    }
  }

  function syncImageDblClickPreview() {
    if (!isPluginEnabled("image-dblclick-preview")) return;
    const imgs = document.querySelectorAll ? document.querySelectorAll("img") : [];
    for (const img of imgs) {
      if (isEligibleDblClickImage(img)) {
        img.classList?.add("pi-enh-dblclick-zoomable");
        const inPanel = Boolean(img.closest?.("#file-panel, .right-panel-container, [data-panel='file']"));
        const hint = isHistoryMessageImageTarget(img) ? "单击全屏预览" : inPanel ? "点击全屏预览" : "双击全屏预览";
        if (!img.hasAttribute || !img.hasAttribute("title") || img.getAttribute("title") === "" || img.getAttribute("title").includes("全屏预览")) {
          img.setAttribute?.("title", hint);
        }
      }
    }
  }

  function removeImageDblClickPreview() {
    if (activeZoomDialog && activeZoomDialog.__isDblClickPreview) {
      closeComposerImageZoomModal();
    }
    const imgs = document.querySelectorAll ? document.querySelectorAll(".pi-enh-dblclick-zoomable") : [];
    for (const img of imgs) {
      img.classList?.remove("pi-enh-dblclick-zoomable");
      if (img.getAttribute && img.getAttribute("title")?.includes("全屏预览")) {
        img.removeAttribute("title");
      }
    }
  }

  addManagedListener(document, "click", handleImageClick, true);
  addManagedListener(document, "dblclick", handleImageDblClick, true);
  addManagedListener(document, "mouseover", handleImageMouseOver, true);

  window.__PI_ENH_IS_DBLCLICK_IMAGE__ = isEligibleDblClickImage;
  window.__PI_ENH_HANDLE_IMAGE_DBLCLICK__ = handleImageDblClick;
  window.__PI_ENH_SYNC_IMAGE_DBLCLICK_PREVIEW__ = syncImageDblClickPreview;
  window.__PI_ENH_REMOVE_IMAGE_DBLCLICK_PREVIEW__ = removeImageDblClickPreview;

  // ==========================================
  // 3.57 Session Panel Binding (右侧面板会话绑定与状态记忆)
  // ==========================================
  const SESSION_PANEL_STORAGE_KEY = "pi-enh-session-panel-states-v1";
  let sessionPanelStates = new Map();
  let isApplyingPanelState = false;
  let sessionPanelEventsAttached = false;
  let lastObservedPanelSessionId = null;

  function loadPersistedSessionPanelStates() {
    try {
      const raw = localStorage.getItem(SESSION_PANEL_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          sessionPanelStates = new Map(Object.entries(parsed));
        }
      }
    } catch (e) {}
  }

  function persistSessionPanelStates() {
    try {
      const obj = Object.fromEntries(sessionPanelStates);
      localStorage.setItem(SESSION_PANEL_STORAGE_KEY, JSON.stringify(obj));
    } catch (e) {}
  }

  function getSessionPanelState(sessionId) {
    if (!sessionId) return false;
    loadPersistedSessionPanelStates();
    return sessionPanelStates.get(sessionId) === true;
  }

  function setSessionPanelState(sessionId, isOpen) {
    if (!sessionId) return;
    loadPersistedSessionPanelStates();
    sessionPanelStates.set(sessionId, Boolean(isOpen));
    persistSessionPanelStates();
  }

  function isFilePanelOpen() {
    const panel = getFilePanelElement();
    if (!panel) return false;
    if (panel.classList.contains("right-panel-open")) return true;
    if (panel.classList.contains("right-panel-closed")) return false;
    const rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null;
    return Boolean(rect && rect.width > 0 && rect.right > 0);
  }

  function openFilePanel() {
    if (isFilePanelOpen()) return true;
    const toggleBtn = document.querySelector('button[aria-controls="file-panel"][aria-expanded="false"]')
      || document.querySelector('button[aria-controls="file-panel"]');
    if (toggleBtn) {
      try {
        toggleBtn.click();
        return true;
      } catch (e) {}
    }
    return false;
  }

  function closeFilePanel() {
    if (!isFilePanelOpen()) return true;
    const hideBtn = document.querySelector('button[title="隐藏文件面板"], button[aria-label="隐藏文件面板"], button[aria-controls="file-panel"][title*="隐藏"], button[aria-controls="file-panel"][aria-label*="隐藏"]') ||
                    document.querySelector('#file-panel button[aria-controls="file-panel"]') ||
                    document.querySelector('button[aria-controls="file-panel"]');
    if (hideBtn && typeof hideBtn.click === "function") {
      hideBtn.click();
      return true;
    }
    return false;
  }

  function captureSessionPanelState(sessionId) {
    if (!isPluginEnabled("session-panel-binding")) return;
    const sid = sessionId || getCurrentSessionId();
    if (!sid || isApplyingPanelState) return;
    const currentOpen = isFilePanelOpen();
    setSessionPanelState(sid, currentOpen);
  }

  function applySessionPanelState(sessionId) {
    if (!isPluginEnabled("session-panel-binding")) return;
    const sid = sessionId || getCurrentSessionId();
    lastObservedPanelSessionId = sid;
    if (!sid) {
      if (isFilePanelOpen()) {
        isApplyingPanelState = true;
        closeFilePanel();
        addManagedTimeout(() => { isApplyingPanelState = false; }, 80);
      }
      return;
    }

    const shouldOpen = getSessionPanelState(sid);
    const currentOpen = isFilePanelOpen();

    if (shouldOpen === currentOpen) return;

    isApplyingPanelState = true;
    if (shouldOpen) {
      openFilePanel();
    } else {
      closeFilePanel();
    }

    addManagedTimeout(() => {
      const nowOpen = isFilePanelOpen();
      if (nowOpen !== shouldOpen) {
        if (shouldOpen) openFilePanel();
        else closeFilePanel();
      }
      isApplyingPanelState = false;
    }, 60);
  }

  function handlePanelUserToggle(event) {
    if (!isPluginEnabled("session-panel-binding") || isApplyingPanelState) return;
    const target = event.target;
    if (!target) return;
    const btn = target.closest?.('button[aria-controls="file-panel"], .right-panel-overlay-backdrop');
    if (btn) {
      addManagedTimeout(() => {
        const sid = getCurrentSessionId();
        if (sid && !isApplyingPanelState) {
          captureSessionPanelState(sid);
        }
      }, 60);
    }
  }

  function syncSessionPanelBinding() {
    if (!isPluginEnabled("session-panel-binding")) return;
    loadPersistedSessionPanelStates();

    if (!sessionPanelEventsAttached) {
      sessionPanelEventsAttached = true;
      addManagedListener(document, "click", handlePanelUserToggle, true);
    }

    const sid = getCurrentSessionId();
    if (sid) {
      if (lastObservedPanelSessionId !== sid) {
        lastObservedPanelSessionId = sid;
        applySessionPanelState(sid);
      } else if (!isApplyingPanelState) {
        const currentOpen = isFilePanelOpen();
        const savedOpen = getSessionPanelState(sid);
        if (currentOpen !== savedOpen) {
          setSessionPanelState(sid, currentOpen);
        }
      }
    }
  }

  window.__PI_ENH_GET_SESSION_PANEL_STATE__ = getSessionPanelState;
  window.__PI_ENH_SET_SESSION_PANEL_STATE__ = setSessionPanelState;
  window.__PI_ENH_APPLY_SESSION_PANEL_STATE__ = applySessionPanelState;
  window.__PI_ENH_CAPTURE_SESSION_PANEL_STATE__ = captureSessionPanelState;
  window.__PI_ENH_IS_FILE_PANEL_OPEN__ = isFilePanelOpen;
  window.__PI_ENH_OPEN_FILE_PANEL__ = openFilePanel;
  window.__PI_ENH_CLOSE_FILE_PANEL__ = closeFilePanel;
  window.__PI_ENH_SYNC_SESSION_PANEL_BINDING__ = syncSessionPanelBinding;

  // 1. Esc 快捷键单键关闭右侧文件浏览窗口（若有全屏图片预览/模态框，优先让其关闭）
  addManagedListener(document, "keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;

    // 检查是否有开启的模态弹窗（图片放大预览 dialog、批量删除 modal 等）
    const openModal = document.querySelector("dialog[open], .image-preview-dialog, .pi-enh-image-zoom-dialog, .pi-enh-batch-modal-backdrop");
    if (openModal) {
      return; // 模态弹窗有自身的 Esc 关闭生命周期，避免重复关闭
    }

    if (isFilePanelOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closeFilePanel();
      showToast("已收起文件浏览窗口", null, 1200);
    }
  }, true);

  // 2. 双击右侧面板顶部标题/工具栏空白区域自动折叠回原位
  addManagedListener(document, "dblclick", (event) => {
    const target = event.target;
    if (!target) return;
    // 排除按钮、链接、输入框、Tab 选项卡等交互元素
    if (target.closest?.("button, a, input, textarea, select, [role='tab'], .file-viewer-mode-button, .pi-enh-md-btn")) {
      return;
    }

    const panelHeader = target.closest?.("#file-panel .file-viewer-toolbar, #file-panel > div:first-child, .right-panel-container > div:first-child");
    if (panelHeader && isFilePanelOpen()) {
      event.preventDefault();
      event.stopPropagation();
      closeFilePanel();
      showToast("已折叠文件浏览窗口", null, 1200);
    }
  }, true);

  // ==========================================
  // 3.55 File Panel Overlay & Stacking Guard (右侧预览窗口防遮挡与层级守护)
  // ==========================================
  const FILE_PANEL_OVERLAY_GUARD_STYLE_ID = "pi-enh-file-panel-overlay-guard-style";
  let filePanelStateObserver = null;

  function ensureFilePanelOverlayGuardStyle() {
    if (document.getElementById(FILE_PANEL_OVERLAY_GUARD_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = FILE_PANEL_OVERLAY_GUARD_STYLE_ID;
    style.textContent = `
      /* ==========================================================================
         右侧预览窗口防遮挡与层级守护 (File Panel Overlay & Stacking Guard)
         ========================================================================== */

      /* 1. 宽屏分屏模式 (>= 960px)：右侧面板脱离默认 position:static，赋予独立的相对定位与高层级 */
      @media (min-width: 960px) {
        #file-panel.right-panel-container:not(.right-panel-full-width),
        .right-panel-container:not(.right-panel-full-width) {
          position: relative !important;
          z-index: 100 !important;
          background: var(--bg) !important;
        }
        /* 补偿 #file-panel 左边框 1px；保持外层固定宽度与开关动画不变 */
        #file-panel.right-panel-container:not(.right-panel-full-width) > * {
          width: calc(var(--right-panel-width, clamp(360px, 42vw, 640px)) - 1px);
          min-width: 299px;
        }
      }

      /* 2. 中小屏、平板、折叠屏与移动端抽屉模式 (< 960px)：确保抽屉浮层与背景遮罩绝对在顶层 */
      @media (max-width: 959px) {
        #file-panel.right-panel-container.right-panel-open,
        .right-panel-container.right-panel-open {
          position: fixed !important;
          z-index: 400 !important;
          background: var(--bg) !important;
        }
        .right-panel-overlay-backdrop.is-open {
          z-index: 390 !important;
        }
      }

      /* 3. 全宽全屏预览模式下同样保持顶层 */
      .right-panel-container.right-panel-open.right-panel-full-width {
        position: fixed !important;
        z-index: 400 !important;
        background: var(--bg) !important;
      }

      /* 4. 当右侧面板处于打开状态时，强制压低左侧聊天区域及底部输入框/状态条层级，使其绝对在“下面一层” */
      html.pi-file-panel-open .chat-content,
      html.pi-file-panel-open .chat-content > div:last-child,
      html.pi-file-panel-open .chat-content .relative.shrink-0,
      html.pi-file-panel-open fieldset,
      html.pi-file-panel-open .pi-enh-cursor-composer,
      html:has(#file-panel.right-panel-open) .chat-content,
      html:has(#file-panel.right-panel-open) .chat-content > div:last-child,
      html:has(#file-panel.right-panel-open) .chat-content .relative.shrink-0,
      html:has(#file-panel.right-panel-open) fieldset,
      html:has(#file-panel.right-panel-open) .pi-enh-cursor-composer {
        z-index: 10 !important;
      }

      /* 5. 底部输入框内所有常驻按钮、胶囊、状态栏在面板打开时，层级严格限定在 11，绝不外溢到预览窗口上 */
      html.pi-file-panel-open .pi-enh-cursor-composer .model-selector,
      html.pi-file-panel-open .pi-enh-cursor-composer [data-pi-thinking-control],
      html.pi-file-panel-open .pi-enh-cursor-composer .pi-enh-cursor-send,
      html.pi-file-panel-open .pi-enh-cursor-composer .pi-enh-cursor-actions,
      html.pi-file-panel-open .chat-content > div:last-child > div:last-child,
      html:has(#file-panel.right-panel-open) .pi-enh-cursor-composer .model-selector,
      html:has(#file-panel.right-panel-open) .pi-enh-cursor-composer [data-pi-thinking-control],
      html:has(#file-panel.right-panel-open) .pi-enh-cursor-composer .pi-enh-cursor-send,
      html:has(#file-panel.right-panel-open) .pi-enh-cursor-composer .pi-enh-cursor-actions,
      html:has(#file-panel.right-panel-open) .chat-content > div:last-child > div:last-child {
        z-index: 11 !important;
      }

      /* 6. 滚动到底部悬浮按钮在面板打开时也必须在“下面一层” */
      html.pi-file-panel-open .chat-scroll-to-bottom,
      html:has(#file-panel.right-panel-open) .chat-scroll-to-bottom {
        z-index: 15 !important;
      }
    `;
    document.head.appendChild(style);
  }

  function updateFilePanelOpenState() {
    if (!isPluginEnabled("file-panel-overlay-guard")) {
      document.documentElement.classList.remove("pi-file-panel-open");
      return;
    }
    const panel = getFilePanelElement();
    const isOpen = Boolean(panel && (panel.classList.contains("right-panel-open") || (panel.offsetWidth > 0 && !panel.classList.contains("right-panel-closed"))));
    document.documentElement.classList.toggle("pi-file-panel-open", isOpen);
  }

  function syncFilePanelOverlayGuard() {
    if (!isPluginEnabled("file-panel-overlay-guard")) {
      removeFilePanelOverlayGuard();
      return;
    }

    ensureFilePanelOverlayGuardStyle();
    updateFilePanelOpenState();

    const panel = getFilePanelElement();
    if (panel && !filePanelStateObserver) {
      filePanelStateObserver = new MutationObserver(() => {
        updateFilePanelOpenState();
      });
      filePanelStateObserver.observe(panel, {
        attributes: true,
        attributeFilter: ["class", "style"]
      });
    }
  }

  function removeFilePanelOverlayGuard() {
    const style = document.getElementById(FILE_PANEL_OVERLAY_GUARD_STYLE_ID);
    if (style) style.remove();
    document.documentElement.classList.remove("pi-file-panel-open");
    if (filePanelStateObserver) {
      filePanelStateObserver.disconnect();
      filePanelStateObserver = null;
    }
  }

  window.__PI_ENH_SYNC_FILE_PANEL_OVERLAY_GUARD__ = syncFilePanelOverlayGuard;
  window.__PI_ENH_REMOVE_FILE_PANEL_OVERLAY_GUARD__ = removeFilePanelOverlayGuard;
  window.__PI_ENH_UPDATE_FILE_PANEL_OPEN_STATE__ = updateFilePanelOpenState;

  // ==========================================
  // 3.6 Mobile Enter Newline Guard (手机软键盘换行保护与防误发)
  // ==========================================
  /**
   * 极度强韧的多维设备环境检测引擎 (Enhanced Desktop vs Mobile Environment Detector)
   * 准确区分：
   * 1. 传统桌面电脑 (Windows / macOS / Linux x86)
   * 2. 现代带触控屏的 Windows 笔记本 / 2合1设备 / 外接数位板 (Surface, Yoga, ThinkPad 等，maxTouchPoints > 0)
   * 3. 电脑端分屏窄视口 (如半屏 600~960px 宽度)
   * 4. 移动端手机 (Redmi K80, Redmi K50, iPhone, Android 手机等，无 fine pointer，无 hover)
   * 5. 移动端平板 (iPad, Android Pad)
   */
  function isMobileEnvironment() {
    try {
      // 0. 优先尊重显式运行时覆盖 (开发者/测试覆盖)
      if (typeof window !== "undefined") {
        if (window.__PI_FORCE_MOBILE__ === true) return true;
        if (window.__PI_FORCE_MOBILE__ === false) return false;
      }

      // 1. 优先尊重用户偏好设置 (显式设置: "desktop" | "mobile" | "auto")
      try {
        const configuredMode = typeof getPluginSetting === "function"
          ? getPluginSetting("mobile-enter-newline", "deviceMode")
          : null;
        if (configuredMode === "desktop") return false;
        if (configuredMode === "mobile") return true;

        if (typeof localStorage !== "undefined") {
          const directOverride = localStorage.getItem("pi-enh-device-mode-override");
          if (directOverride === "desktop") return false;
          if (directOverride === "mobile") return true;
        }
      } catch (e) {}

      const nav = typeof navigator !== "undefined" ? navigator : null;
      if (!nav) return false;
      const win = typeof window !== "undefined" ? window : null;

      // 提取核心媒介与指针交互特征 (Pointer & Hover & Touch)
      let hasFinePointer = false;
      let hasCoarsePointer = false;
      let hasHover = false;
      let hasTouch = false;

      if (win) {
        hasFinePointer = Boolean(win.matchMedia && win.matchMedia("(pointer: fine)").matches);
        hasCoarsePointer = Boolean(win.matchMedia && win.matchMedia("(pointer: coarse)").matches);
        hasHover = Boolean(win.matchMedia && win.matchMedia("(hover: hover)").matches);
        hasTouch = "ontouchstart" in win || (typeof nav.maxTouchPoints === "number" && nav.maxTouchPoints > 0);
      }

      // 2. 现代 UserAgentData API (Chromium 90+ 原生高置信度平台信号)
      if (nav.userAgentData) {
        const uad = nav.userAgentData;
        const uadPlatform = (uad.platform || "").toLowerCase();
        const isDesktopPlatform = /windows|macos|mac|linux|chrome os|cros/i.test(uadPlatform);

        // A. 明确声明 mobile === false 且 platform 为已知桌面操作系统 -> 100% 确认为电脑桌面端！
        if (uad.mobile === false && isDesktopPlatform) {
          return false;
        }

        // B. 明确声明 mobile === true 且 platform 为移动系统 -> 100% 确认为移动端！
        if (uad.mobile === true && /android|ios|iphone|ipod/i.test(uadPlatform)) {
          return true;
        }
      }

      // 3. User-Agent 强特征深度交叉比对
      const ua = nav.userAgent || "";

      // 桌面操作系统强特征（严格排除各种移动变体与仿真标识）：
      const isWindowsDesktop = /Windows NT/i.test(ua) && !/Windows Phone|Mobile|Android/i.test(ua);
      const isMacDesktop = /Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad|iPod|Mobile/i.test(ua);
      const isLinuxDesktop = /Linux|X11/i.test(ua) && !/Android|Mobile/i.test(ua);

      // 移动操作系统强特征：
      const isAndroidMobile = /Android/i.test(ua) && /Mobile/i.test(ua);
      const isAndroidTablet = /Android/i.test(ua) && !/Mobile/i.test(ua);
      const isIOSPhone = /iPhone|iPod/i.test(ua);
      const isIPad = /iPad/i.test(ua) || (isMacDesktop && nav.maxTouchPoints > 1 && !hasFinePointer);
      const isOtherMobileUA = /webOS|BlackBerry|IEMobile|Opera Mini|Mobile|Silk|Kindle|HarmonyOS|HMOS/i.test(ua);

      // 4. 电脑桌面端强置信度防线（防止 Surface / 触控笔记本 / 分屏电脑误判）：
      if (isWindowsDesktop || isMacDesktop || isLinuxDesktop) {
        // 关键点：现代 Windows 笔记本电脑、带触控屏的 PC 或插了数位屏的台式机，
        // 系统可能支持触屏 (hasTouch=true 甚至 pointer: coarse=true)，
        // 但只要主设备具备精细指针 (pointer: fine) 或支持鼠标悬停 (hover: hover)，
        // 或者没有显式的移动端标识，就 100% 属于电脑桌面环境！
        if (hasFinePointer || hasHover || !isOtherMobileUA) {
          return false;
        }
      }

      // 5. 移动端手机强特征确认：
      if (isAndroidMobile || isIOSPhone || isOtherMobileUA) {
        return true;
      }

      // 6. 平板电脑判定 (iPad / Android Tablet)：
      if (isIPad || isAndroidTablet) {
        // 如果平板连接了物理键盘和鼠标（具有 pointer: fine 且 hover: hover），视为桌面交互模式
        if (hasFinePointer && hasHover) return false;
        return true;
      }

      // 7. 纯指针与硬件交互能力兜底判定 (用于无 UA 或特殊 Webview 环境)：
      if (win) {
        // 如果主指针是粗触控设备、完全不支持 hover 且支持触控，属于移动端
        if (hasTouch && hasCoarsePointer && !hasFinePointer && !hasHover) {
          return true;
        }

        // 视口与屏幕物理尺寸辅助（仅在无桌面强特征且纯触控时生效）：
        const screenWidth = typeof win.screen !== "undefined" && win.screen ? win.screen.width : win.innerWidth;
        const screenHeight = typeof win.screen !== "undefined" && win.screen ? win.screen.height : win.innerHeight;
        const isSmallPhysicalScreen = Math.min(screenWidth, screenHeight) <= 600;

        if (hasTouch && !hasFinePointer && isSmallPhysicalScreen) {
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  window.__PI_ENH_IS_MOBILE_ENV__ = isMobileEnvironment;

  // ==========================================
  // Mobile Swipe Drawer (手机手势右滑打开会话与关闭文件面板)
  // ==========================================
  let mobileSwipeTracking = false;
  let mobileSwipeStartX = 0;
  let mobileSwipeStartY = 0;
  let mobileSwipeStartTime = 0;
  let mobileSwipeEligible = false;
  let mobileSwipeDirection = null; // "open" | "close"
  let mobileSwipeTargetType = null; // "session-sidebar" | "file-panel"
  let mobileSwipeInitialOpen = false;
  let mobileSwipeInitialFilePanelOpen = false;
  let mobileSwipeIntent = null; // null | "horizontal" | "vertical"
  let mobileSwipeResetTimer = null;
  let mobileSwipeCachedWidth = 280;

  function getSessionSidebarElement() {
    return (typeof document !== "undefined" && (document.getElementById("session-sidebar") || document.querySelector(".sidebar-container, .sessions-sidebar"))) || null;
  }

  function getSidebarBackdropElement() {
    return (typeof document !== "undefined" && document.querySelector(".sidebar-overlay-backdrop")) || null;
  }

  function getFilePanelElement() {
    return (typeof document !== "undefined" && (document.getElementById("file-panel") || document.querySelector(".right-panel-container"))) || null;
  }

  function isMobileDrawerMode() {
    if (typeof window === "undefined") return true;
    return window.innerWidth <= 640;
  }

  function getMobileSwipeTriggerDistance() {
    const configured = getPluginSetting("mobile-swipe-drawer", "swipeDistance");
    return typeof configured === "number" && configured > 0 ? configured : 30;
  }

  function isSessionSidebarOpen() {
    const sidebar = getSessionSidebarElement();
    if (sidebar) {
      if (sidebar.classList.contains("sidebar-open")) return true;
      if (sidebar.classList.contains("sidebar-closed")) return false;
      const rect = typeof sidebar.getBoundingClientRect === "function" ? sidebar.getBoundingClientRect() : null;
      if (rect) {
        return rect.width > 30 && rect.right >= 100;
      }
    }
    const btn = getSidebarToggleButton();
    if (btn) {
      const label = (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").toLowerCase();
      if (label.includes("隐藏") || label.includes("hide")) return true;
      if (label.includes("显示") || label.includes("show")) return false;
    }
    return false;
  }

  function getSidebarToggleButton() {
    if (typeof document === "undefined") return null;
    const exactBtn = document.querySelector(
      'button[aria-label="显示侧边栏"], button[title="显示侧边栏"], button[aria-label="隐藏侧边栏"], button[title="隐藏侧边栏"], ' +
      'button[aria-label="Show sidebar"], button[title="Show sidebar"], button[aria-label="Hide sidebar"], button[title="Hide sidebar"]'
    );
    if (exactBtn) return exactBtn;

    const fuzzyBtn = document.querySelector('button[aria-label*="侧边栏"], button[title*="侧边栏"], button[aria-label*="sidebar" i], button[title*="sidebar" i]');
    if (fuzzyBtn) return fuzzyBtn;

    const allButtons = document.querySelectorAll("button");
    for (const btn of allButtons) {
      const lines = btn.querySelectorAll ? btn.querySelectorAll("line") : [];
      if (lines.length === 3) return btn;
    }

    const topBar = document.querySelector("header, [class*='header'], [style*='padding-top']");
    if (topBar) {
      const firstBtn = topBar.querySelector("button");
      if (firstBtn) return firstBtn;
    }
    return null;
  }

  function openSessionSidebar() {
    if (isSessionSidebarOpen()) return true;
    const btn = getSidebarToggleButton();
    if (btn && typeof btn.click === "function") {
      btn.click();
      return true;
    }
    return false;
  }

  function closeSessionSidebar() {
    if (!isSessionSidebarOpen()) return true;
    const btn = getSidebarToggleButton();
    if (btn && typeof btn.click === "function") {
      const label = (btn.getAttribute("aria-label") || btn.getAttribute("title") || "").toLowerCase();
      if (label.includes("隐藏") || label.includes("hide")) {
        btn.click();
        return true;
      }
    }
    const backdrop = getSidebarBackdropElement();
    if (backdrop && typeof backdrop.click === "function") {
      backdrop.click();
      return true;
    }
    if (btn && typeof btn.click === "function") {
      btn.click();
      return true;
    }
    return false;
  }

  function resetMobileSwipeStyles() {
    if (mobileSwipeResetTimer) {
      clearTimeout(mobileSwipeResetTimer);
      mobileSwipeResetTimer = null;
    }
    const sidebar = getSessionSidebarElement();
    const backdrop = getSidebarBackdropElement();
    const filePanel = getFilePanelElement();
    if (sidebar && sidebar.style) {
      sidebar.style.transition = "";
      sidebar.style.transform = "";
      sidebar.style.willChange = "";
    }
    if (backdrop) {
      const isOpen = isSessionSidebarOpen();
      if (backdrop.style) {
        backdrop.style.transition = "";
        // 关键防护：关闭状态下必须强制透明且隐藏，严禁留空导致黑蒙层覆盖聊天区造成白字变暗/变黑
        if (!isOpen) {
          backdrop.style.opacity = "0";
          backdrop.style.pointerEvents = "none";
          backdrop.style.visibility = "hidden";
        } else {
          backdrop.style.opacity = "1";
          backdrop.style.pointerEvents = "auto";
          backdrop.style.visibility = "visible";
        }
      }
      backdrop.setAttribute("data-drawer-active", isOpen ? "true" : "false");
      if (typeof document !== "undefined" && document.documentElement) {
        document.documentElement.classList.toggle("pi-sidebar-drawer-active", isOpen);
      }
    }
    if (filePanel && filePanel.style) {
      filePanel.style.transition = "";
      filePanel.style.transform = "";
    }
  }

  // 关键防护：精准识别拖动调整宽度（Resize Handle / isResizing），坚决避让绝不误关闭侧边栏
  function isResizeHandleElement(target) {
    if (!target) return false;
    let cur = target;
    let depth = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && depth < 6) {
      if (typeof cur.getAttribute === "function") {
        const resizeHandle = cur.getAttribute("data-resize-handle");
        if (resizeHandle === "sidebar" || resizeHandle === "right-panel" || resizeHandle) return true;
        const ariaControls = cur.getAttribute("aria-controls");
        if ((ariaControls === "session-sidebar" || ariaControls === "file-panel") && (cur.className || "").includes("resize")) return true;
      }
      const cls = (
        (typeof cur.className === "string" ? cur.className : "") ||
        (typeof cur.getAttribute === "function" ? cur.getAttribute("class") || "" : "")
      ).toLowerCase();
      if (
        cls.includes("resize-handle") ||
        cls.includes("sidebar-resize") ||
        cls.includes("is-resizing") ||
        cls.includes("sidebar-resizing") ||
        cls.includes("panel-resize")
      ) {
        return true;
      }
      cur = cur.parentElement;
      depth++;
    }
    if (typeof document !== "undefined") {
      if (document.querySelector(".is-resizing, .sidebar-resizing, .right-panel-resizing, [data-resizing='true']")) {
        return true;
      }
    }
    return false;
  }

  // 最高优先级检查：仅对真实代码块、输入控件与具备横向滚动的局部容器排他，严禁跨层级误杀聊天消息
  function isCodeBlockOrScrollableElement(target) {
    if (!target) return false;
    let cur = target;

    // 1. 输入控件、按钮、富文本及整个输入卡片容器内部：绝对豁免手势拦截，保障任何点击与输入100%直达
    if (typeof cur.closest === "function") {
      try {
        if (cur.closest("input, textarea, select, button, [data-pi-native-composer-host], .pi-enh-cursor-composer, .pi-enh-queue-panel, .pi-enh-cursor-actions, .chat-input-container, [data-chat-input-wrap]")) {
          return true;
        }
        // 2. 核心代码块标签：用户触摸在 pre、code、table 或代码卡片内部
        if (cur.closest("pre, code, table, .code-block, .markdown-code-block, [data-code-block]")) {
          return true;
        }
      } catch (e) {}
    }

    // 3. 向上就近检查（最多 5 层，绝不跨越到全局消息容器），确认当前局部元素是否具备横向滚动特征
    let depth = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && depth < 5) {
      const tag = (cur.tagName || "").toUpperCase();
      if (tag === "PRE" || tag === "CODE" || tag === "TABLE") {
        return true;
      }

      const cls = (
        (typeof cur.className === "string" ? cur.className : "") ||
        (typeof cur.getAttribute === "function" ? cur.getAttribute("class") || "" : "")
      ).toLowerCase();

      // 精确匹配代码容器类名特征
      if (
        cls.includes("code-block") ||
        cls.includes("markdown-code") ||
        cls.includes("syntax") ||
        cls.includes("highlight") ||
        cls.includes("prism") ||
        cls.includes("hljs") ||
        cls.includes("line-numbers") ||
        cls.includes("snippet") ||
        cls.includes("overflow-x-auto") ||
        cls.includes("scrollable-x")
      ) {
        return true;
      }

      // 检查当前容器自身样式：必须当前容器自身 overflowX 为 auto 或 scroll 且实际超宽
      if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
        try {
          const style = window.getComputedStyle(cur);
          const overflowX = style.overflowX;
          const isScrollable = overflowX === "auto" || overflowX === "scroll";
          if (isScrollable && cur.scrollWidth > cur.clientWidth + 2) {
            return true;
          }
        } catch (e) {}
      }

      cur = cur.parentElement;
      depth++;
    }

    return false;
  }

  function isTouchOnHorizontalScrollable(target) {
    return isCodeBlockOrScrollableElement(target);
  }

  function isTopLayerModalActive(target) {
    if (activeZoomDialog && activeZoomDialog.open) return true;
    if (typeof document !== "undefined") {
      const openModal = document.querySelector("dialog[open], .image-preview-dialog, .pi-enh-image-zoom-dialog");
      if (openModal) return true;
    }
    if (target && typeof target.closest === "function") {
      if (target.closest("dialog, .image-preview-dialog, .pi-enh-image-zoom-dialog, .pi-enh-plugins-panel")) {
        return true;
      }
    }
    return false;
  }

  function handleMobileSwipeTouchStart(e) {
    if (!isPluginEnabled("mobile-swipe-drawer")) return;
    if (mobileSwipeResetTimer) {
      resetMobileSwipeStyles();
    }
    if (!e || !e.touches || e.touches.length !== 1) {
      mobileSwipeTracking = false;
      return;
    }

    const touch = e.touches[0];
    const targetEl = (touch && touch.target) || e?.target;
    let pointEl = null;
    if (typeof document !== "undefined" && typeof document.elementFromPoint === "function") {
      try { pointEl = document.elementFromPoint(touch.clientX, touch.clientY); } catch (err) {}
    }

    // 0. 核心防护：如果触摸点落在输入框、任何按钮、排队面板或输入卡片内部，绝对退出手势追踪，绝不拦截！
    if (
      (targetEl && targetEl.closest && targetEl.closest("button, [data-pi-native-composer-host], .pi-enh-cursor-composer, .pi-enh-queue-panel, input, textarea")) ||
      (pointEl && pointEl.closest && pointEl.closest("button, [data-pi-native-composer-host], .pi-enh-cursor-composer, .pi-enh-queue-panel, input, textarea"))
    ) {
      mobileSwipeTracking = false;
      mobileSwipeEligible = false;
      return;
    }

    // 1. 弹窗模式下完全避让
    if (isTopLayerModalActive(targetEl) || isTopLayerModalActive(pointEl)) {
      mobileSwipeTracking = false;
      mobileSwipeEligible = false;
      return;
    }

    // 2. 关键防护：触摸点在调整侧边栏宽度的分隔手柄上，坚决避让，杜绝误触关闭侧边栏！
    if (isResizeHandleElement(targetEl) || isResizeHandleElement(pointEl)) {
      mobileSwipeTracking = false;
      mobileSwipeEligible = false;
      return;
    }

    // 3. 触摸点位于代码块、可水平滚动区域或输入控件内，避让其内部滚动与输入
    if (isCodeBlockOrScrollableElement(targetEl) || isCodeBlockOrScrollableElement(pointEl)) {
      mobileSwipeTracking = false;
      mobileSwipeEligible = false;
      return;
    }

    const winWidth = typeof window !== "undefined" && typeof window.innerWidth === "number" ? window.innerWidth : 390;
    const isDrawer = isMobileDrawerMode();
    const isSidebarCurrentlyOpen = isSessionSidebarOpen();

    // 4. 起始 X 范围检测：
    // 当侧边栏已打开时，用户想左滑收起，允许在屏幕任意水平位置（包括侧边栏内部、右边缘外及遮罩层）触发！
    // 仅当侧边栏关闭时，才限制最大起始 X 坐标，防止与主聊天右侧区域发生歧义
    if (!isSidebarCurrentlyOpen) {
      const maxStartX = isDrawer ? Math.max(280, winWidth * 0.85) : Math.min(580, winWidth * 0.75);
      if (touch.clientX > maxStartX) {
        mobileSwipeTracking = false;
        mobileSwipeEligible = false;
        return;
      }
    }

    mobileSwipeStartX = touch.clientX;
    mobileSwipeStartY = touch.clientY;
    mobileSwipeStartTime = Date.now();
    mobileSwipeTracking = true;
    mobileSwipeEligible = true;
    mobileSwipeIntent = null;

    mobileSwipeInitialFilePanelOpen = isFilePanelOpen();
    mobileSwipeInitialOpen = isSidebarCurrentlyOpen;

    // 缓存侧边栏宽度并准备 GPU 合成层，消除滑动期间每次 touchmove 的强制重排（Reflow）
    const currentSidebar = getSessionSidebarElement();
    if (currentSidebar) {
      mobileSwipeCachedWidth = currentSidebar.offsetWidth || (currentSidebar.getBoundingClientRect && currentSidebar.getBoundingClientRect().width) || 280;
      if (currentSidebar.style) currentSidebar.style.willChange = "transform";
    } else {
      mobileSwipeCachedWidth = 280;
    }
  }

  function handleMobileSwipeTouchMove(e) {
    if (!mobileSwipeTracking || !mobileSwipeEligible || !isPluginEnabled("mobile-swipe-drawer")) return;
    if (!e || !e.touches || e.touches.length !== 1) return;

    const touch = e.touches[0];
    const targetEl = (touch && touch.target) || e?.target;

    if (isTopLayerModalActive(targetEl) || isResizeHandleElement(targetEl)) {
      if (mobileSwipeTracking) resetMobileSwipeStyles();
      mobileSwipeTracking = false;
      mobileSwipeEligible = false;
      return;
    }

    const deltaX = touch.clientX - mobileSwipeStartX;
    const deltaY = touch.clientY - mobileSwipeStartY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // 1. 意图探测死区与极速锁定（降至 4px，手势极为敏锐跟手）
    if (mobileSwipeIntent === null) {
      // 在 4px 死区内微小移动暂不动作
      if (absX < 4 && absY < 4) return;

      // 用户非常明确在纵向浏览聊天记录时，安全让位给原生纵向滚动
      if (absY >= 12 && absY > absX * 1.35) {
        mobileSwipeIntent = "vertical";
        mobileSwipeTracking = false;
        mobileSwipeEligible = false;
        resetMobileSwipeStyles();
        return;
      }

      // 水平位移具备主导性时，立即锁定手势意图为水平滑动
      if (absX >= 4 && absX >= absY * 0.65) {
        mobileSwipeIntent = "horizontal";
      }
    }

    // 2. 意图已锁定为水平滑动：立即阻止原生滚动抢占，保持跟手平滑响应
    if (mobileSwipeIntent === "horizontal") {
      if (e.cancelable && typeof e.preventDefault === "function") {
        e.preventDefault();
      }

      // 优先判定：右侧文件面板打开且向右滑，驱动文件面板关闭
      if (mobileSwipeInitialFilePanelOpen && deltaX > 0) {
        const filePanel = getFilePanelElement();
        if (filePanel) {
          filePanel.style.transition = "none";
          filePanel.style.transform = `translateX(${deltaX}px)`;
        }
        return;
      }

      // 会话列表滑动逻辑
      const isDrawer = isMobileDrawerMode();
      const sidebar = getSessionSidebarElement();
      const backdrop = getSidebarBackdropElement();
      if (!sidebar) return;

      const sidebarWidth = mobileSwipeCachedWidth || 280;

      if (deltaX > 0 && !mobileSwipeInitialOpen) {
        // 向右划：拉出会话列表抽屉
        const offset = Math.min(deltaX, sidebarWidth);
        sidebar.style.transition = "none";
        sidebar.style.transform = isDrawer ? `translateX(calc(-100% + ${offset}px))` : `translateX(${offset - sidebarWidth}px)`;
        if (backdrop && backdrop.style) {
          backdrop.style.transition = "none";
          backdrop.style.visibility = "visible";
          backdrop.style.opacity = String(Math.min(1, Math.max(0, offset / sidebarWidth)));
          backdrop.style.pointerEvents = "auto";
          backdrop.setAttribute("data-drawer-active", "true");
          if (typeof document !== "undefined" && document.documentElement) {
            document.documentElement.classList.add("pi-sidebar-drawer-active");
          }
        }
      } else if (deltaX < 0 && mobileSwipeInitialOpen) {
        // 向左划：推回收起会话列表抽屉
        const offset = Math.max(deltaX, -sidebarWidth);
        sidebar.style.transition = "none";
        sidebar.style.transform = `translateX(${offset}px)`;
        if (backdrop && backdrop.style) {
          backdrop.style.transition = "none";
          backdrop.style.opacity = String(Math.min(1, Math.max(0, 1 + offset / sidebarWidth)));
        }
      }
    }
  }

  function snapBackMobileSwipe() {
    const isDrawer = isMobileDrawerMode();
    const sidebar = getSessionSidebarElement();
    const backdrop = getSidebarBackdropElement();
    const filePanel = getFilePanelElement();
    if (sidebar && sidebar.style) {
      sidebar.style.transition = "transform 0.18s ease";
      sidebar.style.transform = mobileSwipeInitialOpen ? "translateX(0)" : (isDrawer ? "translateX(-100%)" : "");
    }
    if (backdrop && backdrop.style) {
      backdrop.style.transition = "opacity 0.18s ease";
      backdrop.style.opacity = mobileSwipeInitialOpen ? "1" : "0";
      if (!mobileSwipeInitialOpen) {
        backdrop.style.pointerEvents = "none";
        backdrop.style.visibility = "hidden";
        backdrop.setAttribute("data-drawer-active", "false");
      }
    }
    if (filePanel && filePanel.style) {
      filePanel.style.transition = "transform 0.18s ease";
      filePanel.style.transform = mobileSwipeInitialFilePanelOpen ? "translateX(0)" : "translateX(100%)";
    }
    mobileSwipeResetTimer = setTimeout(() => {
      resetMobileSwipeStyles();
      mobileSwipeResetTimer = null;
    }, 200);
  }

  function handleMobileSwipeTouchEnd(e) {
    if (isTopLayerModalActive(e?.target) || isResizeHandleElement(e?.target)) {
      if (mobileSwipeTracking) resetMobileSwipeStyles();
      mobileSwipeTracking = false;
      mobileSwipeEligible = false;
      return;
    }
    if (!mobileSwipeTracking || !isPluginEnabled("mobile-swipe-drawer")) {
      mobileSwipeTracking = false;
      return;
    }
    mobileSwipeTracking = false;

    const touch = (e && e.changedTouches && e.changedTouches[0]) || null;
    if (!touch) {
      resetMobileSwipeStyles();
      return;
    }

    const deltaX = touch.clientX - mobileSwipeStartX;
    const deltaY = touch.clientY - mobileSwipeStartY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const elapsed = Date.now() - mobileSwipeStartTime;

    // 动态根据用户配置的阈值进行判定：
    // triggerDist：拖拽阈值（默认 30px，可在设置中自由调节 10~120px）
    // flickDist：快速轻拂扫动阈值（triggerDist * 0.55，最低 14px）
    const triggerDist = getMobileSwipeTriggerDistance();
    const flickDist = Math.max(14, Math.round(triggerDist * 0.55));
    const isHorizontal = mobileSwipeIntent === "horizontal" || absX >= absY * 0.65;
    const isFlick = elapsed < 380 && absX >= flickDist;
    const isDrag = absX >= triggerDist;

    if (isHorizontal && (isFlick || isDrag)) {
      // 场景 1：右侧文件面板打开且向右划 -> 关闭文件面板
      if (mobileSwipeInitialFilePanelOpen && deltaX > 0) {
        const filePanel = getFilePanelElement();
        if (filePanel && filePanel.style) {
          filePanel.style.transition = "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)";
          filePanel.style.transform = "translateX(100%)";
        }
        closeFilePanel();
        mobileSwipeResetTimer = setTimeout(() => {
          resetMobileSwipeStyles();
          mobileSwipeResetTimer = null;
        }, 240);
        return;
      }

      const isDrawer = isMobileDrawerMode();

      // 场景 2：向右划（deltaX > 0）且当前未开 -> 打开会话列表面板！
      if (deltaX > 0 && !mobileSwipeInitialOpen) {
        const sidebar = getSessionSidebarElement();
        const backdrop = getSidebarBackdropElement();
        if (sidebar && sidebar.style) {
          sidebar.style.transition = "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)";
          sidebar.style.transform = "translateX(0)";
        }
        if (backdrop && backdrop.style) {
          backdrop.style.transition = "opacity 0.22s ease";
          backdrop.style.opacity = "1";
          backdrop.style.pointerEvents = "auto";
          backdrop.style.visibility = "visible";
          backdrop.setAttribute("data-drawer-active", "true");
        }
        openSessionSidebar();
        mobileSwipeResetTimer = setTimeout(() => {
          resetMobileSwipeStyles();
          mobileSwipeResetTimer = null;
        }, 240);
        return;
      }

      // 场景 3：向左划（deltaX < 0）且当前已开 -> 收起会话列表面板
      if (deltaX < 0 && (mobileSwipeInitialOpen || isSessionSidebarOpen())) {
        const sidebar = getSessionSidebarElement();
        const backdrop = getSidebarBackdropElement();
        if (sidebar && sidebar.style) {
          sidebar.style.transition = "transform 0.22s cubic-bezier(0.16, 1, 0.3, 1)";
          sidebar.style.transform = isDrawer ? "translateX(-100%)" : "translateX(-20px)";
        }
        if (backdrop && backdrop.style) {
          backdrop.style.transition = "opacity 0.22s ease";
          backdrop.style.opacity = "0";
          backdrop.setAttribute("data-drawer-active", "false");
        }
        closeSessionSidebar();
        mobileSwipeResetTimer = setTimeout(() => {
          resetMobileSwipeStyles();
          mobileSwipeResetTimer = null;
        }, 240);
        return;
      }

      snapBackMobileSwipe();
    } else {
      snapBackMobileSwipe();
    }
  }

  function handleMobileSwipeTouchCancel(e) {
    if (mobileSwipeTracking && mobileSwipeEligible) {
      const touch = (e && e.changedTouches && e.changedTouches[0]) || null;
      if (touch) {
        const deltaX = touch.clientX - mobileSwipeStartX;
        const deltaY = touch.clientY - mobileSwipeStartY;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);
        const elapsed = Date.now() - mobileSwipeStartTime;
        const triggerDist = getMobileSwipeTriggerDistance();
        const flickDist = Math.max(14, Math.round(triggerDist * 0.55));
        const isHorizontal = mobileSwipeIntent === "horizontal" || absX >= absY * 0.65;
        if (isHorizontal && (absX >= triggerDist || (elapsed < 380 && absX >= flickDist))) {
          if (deltaX > 0 && !mobileSwipeInitialOpen) {
            openSessionSidebar();
            mobileSwipeTracking = false;
            mobileSwipeResetTimer = setTimeout(() => {
              resetMobileSwipeStyles();
              mobileSwipeResetTimer = null;
            }, 240);
            return;
          } else if (deltaX < 0 && (mobileSwipeInitialOpen || isSessionSidebarOpen())) {
            closeSessionSidebar();
            mobileSwipeTracking = false;
            resetMobileSwipeStyles();
            return;
          }
        }
      }
    }
    mobileSwipeTracking = false;
    snapBackMobileSwipe();
  }

  function syncMobileSwipeDrawer(enabled) {
    if (!enabled) {
      resetMobileSwipeStyles();
    }
  }

  if (typeof document !== "undefined") {
    addManagedListener(document, "touchstart", handleMobileSwipeTouchStart, { passive: true, capture: true });
    addManagedListener(document, "touchmove", handleMobileSwipeTouchMove, { passive: false, capture: true });
    addManagedListener(document, "touchend", handleMobileSwipeTouchEnd, { passive: true, capture: true });
    addManagedListener(document, "touchcancel", handleMobileSwipeTouchCancel, { passive: true, capture: true });
  } else if (typeof window !== "undefined") {
    addManagedListener(window, "touchstart", handleMobileSwipeTouchStart, { passive: true });
    addManagedListener(window, "touchmove", handleMobileSwipeTouchMove, { passive: false });
    addManagedListener(window, "touchend", handleMobileSwipeTouchEnd, { passive: true });
    addManagedListener(window, "touchcancel", handleMobileSwipeTouchCancel, { passive: true });
  }

  window.__PI_ENH_MOBILE_SWIPE__ = {
    isSessionSidebarOpen,
    openSessionSidebar,
    closeSessionSidebar,
    isFilePanelOpen,
    closeFilePanel,
    getSidebarToggleButton,
    isCodeBlockOrScrollableElement,
    isTouchOnHorizontalScrollable,
    isResizeHandleElement,
    getSwipeTriggerDistance: getMobileSwipeTriggerDistance,
    isMobileDrawerMode,
    handleTouchStart: handleMobileSwipeTouchStart,
    handleTouchMove: handleMobileSwipeTouchMove,
    handleTouchEnd: handleMobileSwipeTouchEnd,
    handleTouchCancel: handleMobileSwipeTouchCancel,
    resetStyles: resetMobileSwipeStyles,
  };

  // ==========================================
  // PWA Standalone Mode & Android Back Gesture Navigation Guard
  // ==========================================
  function isPwaStandaloneMode() {
    if (typeof window === "undefined") return false;
    return Boolean(
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      (window.navigator && window.navigator.standalone === true) ||
      (window.location && new URLSearchParams(window.location.search).get("pwa") === "1")
    );
  }

  function syncPwaStandaloneState() {
    if (typeof document === "undefined" || !document.documentElement) return;
    const standalone = isPwaStandaloneMode();
    document.documentElement.classList.toggle("pi-pwa-standalone", standalone);
    if (document.body) {
      if (standalone) document.body.setAttribute("data-pwa", "standalone");
      else document.body.removeAttribute("data-pwa");
    }
  }

  try {
    if (typeof window !== "undefined" && window.matchMedia) {
      const pwaMedia = window.matchMedia("(display-mode: standalone)");
      if (pwaMedia.addEventListener) pwaMedia.addEventListener("change", syncPwaStandaloneState);
    }
  } catch (e) {}
  syncPwaStandaloneState();

  // Android 系统返回键 / 侧滑手势智能守卫（优先关闭打开的 Modal/Drawer，防止意外退出应用）
  function handleBackNavigationGuard(e) {
    // 1. 优先关闭大图放大预览
    const zoomDialog = document.querySelector("dialog[open], .image-preview-dialog, .pi-enh-image-zoom-dialog");
    if (zoomDialog) {
      const closeBtn = zoomDialog.querySelector("button[aria-label*='Close'], button[title*='关闭'], .pi-enh-image-preview-close, button");
      if (closeBtn) {
        closeBtn.click();
        return;
      } else if (typeof zoomDialog.close === "function") {
        zoomDialog.close();
        return;
      }
    }

    // 2. 优先关闭设置面板
    const settingsDialog = document.querySelector(".settings-dialog, [role='dialog'][aria-modal='true']");
    if (settingsDialog) {
      const closeBtn = settingsDialog.querySelector("button[aria-label*='Close'], button[title*='关闭'], button[aria-label*='关闭']");
      if (closeBtn) {
        closeBtn.click();
        return;
      }
    }

    // 3. 优先收起移动端侧边栏抽屉
    if (isMobileDrawerMode() && isSessionSidebarOpen()) {
      closeSessionSidebar();
      return;
    }
  }

  if (typeof window !== "undefined") {
    addManagedListener(window, "popstate", handleBackNavigationGuard);
  }

  window.__PI_ENH_PWA__ = {
    isPwaStandaloneMode,
    syncPwaStandaloneState,
    handleBackNavigationGuard,
  };

  // ==========================================
  // Session Search Shortcut (Ctrl+F / Cmd+F)
  // ==========================================
  function getSessionSearchButton() {
    return document.querySelector('button[aria-controls="session-search-input"]') ||
      document.querySelector('button[title*="搜索对话"], button[aria-label*="搜索对话"]') ||
      document.querySelector('button[title*="Search sessions" i], button[aria-label*="Search sessions" i]');
  }

  function getSessionSearchInput() {
    return document.getElementById("session-search-input") ||
      document.querySelector('input[type="search"][placeholder*="搜索所有对话"], input[type="search"][aria-label*="搜索所有对话"]');
  }

  function isSessionSearchOpen() {
    const btn = getSessionSearchButton();
    if (btn && btn.getAttribute("aria-expanded") === "true") return true;
    const input = getSessionSearchInput();
    if (input && (input.offsetParent !== null || input.isConnected)) return true;
    return false;
  }

  function syncSearchButtonHint() {
    const btn = getSessionSearchButton();
    if (!btn) return;
    const enabled = isPluginEnabled("session-search-shortcut");
    const rawTitle = btn.getAttribute("data-pi-orig-title") || btn.getAttribute("title") || "搜索对话";
    if (!btn.hasAttribute("data-pi-orig-title")) {
      btn.setAttribute("data-pi-orig-title", rawTitle.replace(/\s*\(Ctrl\+F\)/gi, "").trim());
    }
    const origTitle = btn.getAttribute("data-pi-orig-title");

    if (enabled) {
      const hintTitle = `${origTitle} (Ctrl+F)`;
      if (btn.getAttribute("title") !== hintTitle) {
        btn.setAttribute("title", hintTitle);
      }
      if (btn.hasAttribute("aria-label")) {
        const origAria = btn.getAttribute("data-pi-orig-aria") || btn.getAttribute("aria-label") || origTitle;
        if (!btn.hasAttribute("data-pi-orig-aria")) {
          btn.setAttribute("data-pi-orig-aria", origAria.replace(/\s*\(Ctrl\+F\)/gi, "").trim());
        }
        const hintAria = `${btn.getAttribute("data-pi-orig-aria")} (Ctrl+F)`;
        if (btn.getAttribute("aria-label") !== hintAria) {
          btn.setAttribute("aria-label", hintAria);
        }
      }
    } else {
      if (btn.getAttribute("title") !== origTitle) {
        btn.setAttribute("title", origTitle);
      }
      if (btn.hasAttribute("data-pi-orig-aria")) {
        btn.setAttribute("aria-label", btn.getAttribute("data-pi-orig-aria"));
      }
    }
  }

  function toggleSessionSearch() {
    const btn = getSessionSearchButton();
    if (!btn) return false;

    const isOpen = isSessionSearchOpen();
    if (isOpen) {
      // 再次按下就关闭
      btn.click();
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.id === "session-search-input" || activeEl.closest?.("#session-search-input"))) {
        try { activeEl.blur(); } catch (e) {}
      }
      const composer = Array.from(document.querySelectorAll(".chat-input-textarea, textarea.chat-input, textarea")).find((el) => el.offsetWidth > 0 && el.offsetHeight > 0 && getComputedStyle(el).visibility !== "hidden");
      if (composer) {
        try { composer.focus(); } catch (e) {}
      }
    } else {
      // 快捷打开并全选聚焦
      btn.click();
      let attempts = 0;
      const focusSearchInput = () => {
        const input = getSessionSearchInput();
        if (input) {
          try {
            input.focus();
            if (typeof input.select === "function") input.select();
          } catch (e) {}
        } else if (attempts < 12) {
          attempts++;
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(focusSearchInput);
          } else {
            setTimeout(focusSearchInput, 16);
          }
        }
      };
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(focusSearchInput);
      } else {
        setTimeout(focusSearchInput, 16);
      }
    }
    return true;
  }

  function handleSearchShortcutKeydown(e) {
    if (!isPluginEnabled("session-search-shortcut")) return;

    // 匹配 Ctrl+F / Cmd+F，且不带 Alt 和 Shift
    const isCtrlOrCmd = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
    const isKeyF = e.key === "f" || e.key === "F" || e.code === "KeyF" || e.keyCode === 70;
    if (!isCtrlOrCmd || !isKeyF) return;

    // 如果当前处于模态设置弹窗等 dialog 内，放行
    const modal = document.querySelector('.settings-dialog-backdrop, [role="dialog"]');
    const searchBtn = getSessionSearchButton();
    if (modal) {
      if (!searchBtn) return;
      if (typeof modal.contains === "function" && !modal.contains(searchBtn)) return;
      if (modal !== searchBtn && modal.parentElement !== searchBtn) return;
    }

    if (typeof e.preventDefault === "function") e.preventDefault();
    if (typeof e.stopPropagation === "function") e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();

    toggleSessionSearch();
  }

  addManagedListener(document, "keydown", handleSearchShortcutKeydown, true);

  window.__PI_ENH_TOGGLE_SESSION_SEARCH__ = toggleSessionSearch;
  window.__PI_ENH_IS_SESSION_SEARCH_OPEN__ = isSessionSearchOpen;
  window.__PI_ENH_HANDLE_SEARCH_SHORTCUT_KEYDOWN__ = handleSearchShortcutKeydown;
  window.__PI_ENH_SYNC_SEARCH_BUTTON_HINT__ = syncSearchButtonHint;
  window.__PI_ENH_GET_SESSION_SEARCH_BUTTON__ = getSessionSearchButton;
  window.__PI_ENH_GET_SESSION_SEARCH_INPUT__ = getSessionSearchInput;

  // ==========================================
  // 会话列表批量管理与删除 (Session Batch Actions)
  // ==========================================
  isSessionBatchMode = false;
  const selectedSessionBatchIds = new Set();
  let lastBatchClickedSessionId = null;
  batchDeleteModal = null;
  let isBatchDragging = false;
  let batchDragTargetState = true;
  let batchDeleteInFlight = false;

  let cachedActiveSessionIds = null;
  let cachedLatestGroupsRef = null;
  let cachedGroupsLength = 0;

  function getAllActiveSessionIds(forceRefresh = false) {
    const currentGroups = Array.isArray(latestKnownSessionGroups) && latestKnownSessionGroups.length > 0
      ? latestKnownSessionGroups
      : null;

    if (
      !forceRefresh &&
      currentGroups !== null &&
      cachedActiveSessionIds !== null &&
      cachedLatestGroupsRef === currentGroups &&
      cachedGroupsLength === currentGroups.length
    ) {
      return cachedActiveSessionIds;
    }

    const ids = new Set();
    if (currentGroups) {
      for (let i = 0; i < currentGroups.length; i++) {
        const rootId = currentGroups[i]?.root?.id;
        if (rootId) {
          ids.add(rootId);
        }
      }
    }
    const currentDomRows = document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]");
    for (let i = 0; i < currentDomRows.length; i++) {
      const sid = currentDomRows[i].getAttribute("data-pi-enh-session-id");
      if (sid) {
        ids.add(sid);
      }
    }

    const result = Array.from(ids);
    if (currentGroups) {
      cachedActiveSessionIds = result;
      cachedLatestGroupsRef = currentGroups;
      cachedGroupsLength = currentGroups.length;
    } else {
      cachedActiveSessionIds = null;
      cachedLatestGroupsRef = null;
      cachedGroupsLength = 0;
    }
    return result;
  }

  function getSessionTitleForBatch(sessionId) {
    if (!sessionId) return "";
    const row = getSessionRowById(sessionId);
    if (row) {
      const title = extractSessionTitleFromRow(row, sessionId);
      if (title && title !== sessionId) return title;
    }
    if (Array.isArray(latestKnownSessionGroups)) {
      const group = latestKnownSessionGroups.find((g) => g?.root?.id === sessionId);
      if (group?.root) {
        const name = group.root.name || group.root.title;
        if (name) return name;
        const firstMsg = group.root.firstMessage;
        if (firstMsg) return firstMsg.slice(0, 36);
      }
    }
    return sessionId.slice(0, 14) + "...";
  }

  function syncSessionBatchTriggerButton() {
    const enabled = isPluginEnabled("session-batch-actions");
    let btn = document.getElementById("pi-enh-session-batch-btn");

    if (!enabled) {
      if (btn) btn.remove();
      return;
    }

    const searchBtn = getSessionSearchButton();
    const targetContainer = searchBtn?.parentElement;
    if (!targetContainer) return;

    if (!btn) {
      btn = document.createElement("button");
      btn.id = "pi-enh-session-batch-btn";
      btn.type = "button";
      btn.className = "pi-enh-session-batch-trigger";
      btn.setAttribute("aria-label", "批量管理会话");
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><line x1="14" y1="4" x2="21" y2="4"></line><line x1="14" y1="9" x2="19" y2="9"></line><line x1="14" y1="15" x2="21" y2="15"></line><line x1="14" y1="20" x2="19" y2="20"></line></svg>`;

      if (searchBtn.nextSibling) {
        targetContainer.insertBefore(btn, searchBtn.nextSibling);
      } else {
        targetContainer.appendChild(btn);
      }
    }

    if (!btn._piEnhBatchBound) {
      btn._piEnhBatchBound = true;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setSessionBatchMode(!isSessionBatchMode);
      });
    }

    btn.classList.toggle("is-active", isSessionBatchMode);
    btn.title = isSessionBatchMode ? "退出批量管理 (Esc)" : "批量管理会话 (多选/复制 ID/删除)";
  }

  function removeSessionBatchTrigger() {
    const btn = document.getElementById("pi-enh-session-batch-btn");
    if (btn) btn.remove();
  }

  function syncSessionBatchBar() {
    const enabled = isPluginEnabled("session-batch-actions");
    let bar = document.getElementById("pi-enh-session-batch-bar");

    if (!enabled || !isSessionBatchMode) {
      if (bar) bar.remove();
      return;
    }

    const sidebar = document.querySelector(".sidebar-container, #session-sidebar, .sessions-sidebar");
    const mainCol = sidebar?.firstElementChild;
    if (!mainCol || mainCol.children.length < 2) return;

    const listContainer = mainCol.children[1];

    if (!bar) {
      bar = document.createElement("div");
      bar.id = "pi-enh-session-batch-bar";
      bar.className = "pi-enh-session-batch-bar";
      // The toolbar owns these nodes. Replacing them during sidebar layout
      // notifications triggers another virtual-list resize/render notification.
      bar.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
          <label class="pi-enh-session-batch-select-all" title="全选所有会话">
            <input type="checkbox" data-action="batch-select-all" >
            <span>全选</span>
          </label>
          <span data-batch-selection-count style="font-size: 11.5px; color: var(--text-muted); line-height: 1; white-space: nowrap;">
            未选择
          </span>
        </div>
        <div class="pi-enh-session-batch-actions">
          <button type="button" class="pi-enh-session-batch-btn" data-action="batch-copy-ids" style="padding: 6px;" disabled aria-label="复制所选会话 ID" title="复制所选会话 ID">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
          <button type="button" class="pi-enh-session-batch-btn pi-enh-session-batch-btn-danger" data-action="batch-delete" style="padding: 6px;" disabled aria-label="删除所选会话" title="删除所选会话">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6M14 11v6"></path></svg>
          </button>
        </div>
      `;
      bar.querySelector('input[data-action="batch-select-all"]').addEventListener("change", (e) => {
        e.stopPropagation();
        toggleSelectAllBatch(e.currentTarget.checked);
      });
      bar.querySelector('[data-action="batch-delete"]').addEventListener("click", (e) => {
        e.stopPropagation();
        openBatchDeleteModal();
      });
      bar.querySelector('[data-action="batch-copy-ids"]').addEventListener("click", (e) => {
        e.stopPropagation();
        const ids = Array.from(selectedSessionBatchIds);
        if (ids.length) copyText(ids.join("\n"), `已复制 ${ids.length} 个会话 ID（每行一个）`);
      });
      mainCol.insertBefore(bar, listContainer);
    }

    const total = getAllActiveSessionIds(false).length;
    const selectedCount = selectedSessionBatchIds.size;
    const selectAll = bar.querySelector('input[data-action="batch-select-all"]');
    if (selectAll) {
      const isChecked = total > 0 && selectedCount >= total;
      const isIndeterminate = selectedCount > 0 && selectedCount < total;
      if (selectAll.checked !== isChecked) selectAll.checked = isChecked;
      if (selectAll.indeterminate !== isIndeterminate) selectAll.indeterminate = isIndeterminate;
      if (selectAll.disabled !== batchDeleteInFlight) selectAll.disabled = batchDeleteInFlight;
    }

    const count = bar.querySelector('[data-batch-selection-count]');
    if (count) {
      const countText = selectedCount ? `已选 ${selectedCount} 项` : "未选择";
      if (count.textContent !== countText) count.textContent = countText;
    }

    const copy = bar.querySelector('[data-action="batch-copy-ids"]');
    const remove = bar.querySelector('[data-action="batch-delete"]');
    const isActionDisabled = selectedCount === 0 || batchDeleteInFlight;
    if (copy && copy.disabled !== isActionDisabled) copy.disabled = isActionDisabled;
    if (remove && remove.disabled !== isActionDisabled) remove.disabled = isActionDisabled;

    const copyTitle = selectedCount ? `复制已选 ${selectedCount} 个会话 ID（每行一个）` : "请先勾选要复制 ID 的会话";
    const deleteTitle = selectedCount ? `彻底删除已选 ${selectedCount} 个会话` : "请先勾选要删除的会话";
    if (copy && copy.title !== copyTitle) copy.title = copyTitle;
    if (remove && remove.title !== deleteTitle) remove.title = deleteTitle;
  }

  function removeSessionBatchBar() {
    const bar = document.getElementById("pi-enh-session-batch-bar");
    if (bar) bar.remove();
  }

  function ensureBatchCheckboxOnRow(row, sessionId) {
    let wrap = row.querySelector(".pi-enh-session-batch-checkbox-wrap");
    if (!wrap) {
      wrap = document.createElement("label");
      wrap.className = "pi-enh-session-batch-checkbox-wrap";
      wrap.setAttribute("title", "选择会话（按住 Shift 连续多选）");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "pi-enh-session-batch-checkbox";
      checkbox.setAttribute("data-session-id", sessionId);
      wrap.appendChild(checkbox);
      row.insertBefore(wrap, row.firstElementChild);
    }
    return wrap;
  }

  function updateSingleBatchRow(sessionId, isSelected, explicitRow = null) {
    const row = explicitRow || (typeof CSS !== "undefined" && CSS.escape
      ? document.querySelector(`.pi-enh-session-row-host[data-pi-enh-session-id="${CSS.escape(sessionId)}"]`)
      : getSessionRowById(sessionId));
    if (!row) return;

    if (!isSessionBatchMode) {
      const wrap = row.querySelector(".pi-enh-session-batch-checkbox-wrap");
      if (wrap) wrap.remove();
      row.classList.remove("is-batch-selected");
      return;
    }

    let wrap = row.querySelector(".pi-enh-session-batch-checkbox-wrap");
    if (!wrap) {
      wrap = ensureBatchCheckboxOnRow(row, sessionId);
    }
    const checkbox = wrap.querySelector(".pi-enh-session-batch-checkbox");
    if (checkbox && checkbox.checked !== isSelected) {
      checkbox.checked = isSelected;
    }
    row.classList.toggle("is-batch-selected", isSelected);
  }

  function syncSessionBatchRowStates() {
    const enabled = isPluginEnabled("session-batch-actions");
    const rows = document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]");

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const sessionId = row.getAttribute("data-pi-enh-session-id");
      if (!sessionId) continue;

      let wrap = row.querySelector(".pi-enh-session-batch-checkbox-wrap");

      if (!enabled || !isSessionBatchMode) {
        if (wrap) wrap.remove();
        row.classList.remove("is-batch-selected");
        continue;
      }

      if (!wrap) {
        wrap = ensureBatchCheckboxOnRow(row, sessionId);
      }

      const isSelected = selectedSessionBatchIds.has(sessionId);
      const checkbox = wrap.querySelector(".pi-enh-session-batch-checkbox");
      if (checkbox && checkbox.checked !== isSelected) {
        checkbox.checked = isSelected;
      }

      row.classList.toggle("is-batch-selected", isSelected);
    }
  }

  function toggleSessionBatchSelect(sessionId, targetChecked, isShift, explicitRow = null) {
    if (batchDeleteInFlight) return;
    if (!sessionId) return;

    if (isShift && lastBatchClickedSessionId && lastBatchClickedSessionId !== sessionId) {
      const allIds = getAllActiveSessionIds(false);
      const prevIndex = allIds.indexOf(lastBatchClickedSessionId);
      const currIndex = allIds.indexOf(sessionId);

      if (prevIndex !== -1 && currIndex !== -1) {
        const start = Math.min(prevIndex, currIndex);
        const end = Math.max(prevIndex, currIndex);
        const affectedIds = new Set();
        for (let i = start; i <= end; i++) {
          const id = allIds[i];
          affectedIds.add(id);
          if (targetChecked) {
            selectedSessionBatchIds.add(id);
          } else {
            selectedSessionBatchIds.delete(id);
          }
        }
        lastBatchClickedSessionId = sessionId;

        withMutationGuard(() => {
          syncSessionBatchBar();
          const rows = document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]");
          for (let i = 0; i < rows.length; i++) {
            const sid = rows[i].getAttribute("data-pi-enh-session-id");
            if (sid && affectedIds.has(sid)) {
              updateSingleBatchRow(sid, targetChecked, rows[i]);
            }
          }
        });
        return;
      }
    }

    if (targetChecked) {
      selectedSessionBatchIds.add(sessionId);
    } else {
      selectedSessionBatchIds.delete(sessionId);
    }
    lastBatchClickedSessionId = sessionId;

    withMutationGuard(() => {
      updateSingleBatchRow(sessionId, targetChecked, explicitRow);
      syncSessionBatchBar();
    });
  }

  function toggleSelectAllBatch(checked) {
    if (batchDeleteInFlight) return;
    if (checked) {
      const allIds = getAllActiveSessionIds(true);
      for (let i = 0; i < allIds.length; i++) {
        selectedSessionBatchIds.add(allIds[i]);
      }
    } else {
      selectedSessionBatchIds.clear();
    }
    lastBatchClickedSessionId = null;
    withMutationGuard(() => {
      syncSessionBatchBar();
      syncSessionBatchRowStates();
    });
  }

  function setSessionBatchMode(active) {
    isSessionBatchMode = Boolean(active);
    document.documentElement.classList.toggle("pi-enh-session-batch-active", isSessionBatchMode);

    if (!isSessionBatchMode) {
      selectedSessionBatchIds.clear();
      lastBatchClickedSessionId = null;
      isBatchDragging = false;
      closeBatchDeleteModal();
    }

    withMutationGuard(() => {
      syncSessionBatchTriggerButton();
      syncSessionBatchBar();
      syncSessionBatchRowStates();
    });
  }

  function closeBatchDeleteModal() {
    if (batchDeleteInFlight) return;
    if (batchDeleteModal) {
      batchDeleteModal.remove();
      batchDeleteModal = null;
    }
  }

  function openBatchDeleteModal() {
    if (batchDeleteInFlight) return;
    closeBatchDeleteModal();
    const targetIds = Array.from(selectedSessionBatchIds);
    if (targetIds.length === 0) return;

    const count = targetIds.length;
    const previewHtml = targetIds.slice(0, 6).map((sid) => {
      const title = getSessionTitleForBatch(sid);
      return `<div class="pi-enh-batch-modal-item">· ${escapeHtml(title)}</div>`;
    }).join("");
    const overflowCount = count - 6;
    const overflowHtml = overflowCount > 0 ? `<div class="pi-enh-batch-modal-item" style="color: var(--text-muted); font-style: italic;">... 等共 ${count} 个会话</div>` : "";

    const backdrop = document.createElement("div");
    backdrop.id = "pi-enh-batch-delete-modal";
    backdrop.className = "pi-enh-batch-modal-backdrop";
    backdrop.innerHTML = `
      <div class="pi-enh-batch-modal" role="dialog" aria-modal="true" aria-labelledby="pi-enh-batch-modal-title">
        <div class="pi-enh-batch-modal-header" id="pi-enh-batch-modal-title">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
          <span>批量删除会话</span>
        </div>
        <div class="pi-enh-batch-modal-body">
          <div style="font-weight: 500;">确定要彻底删除已选中的 <strong>${count}</strong> 个会话吗？</div>
          <div style="margin-top: 4px; font-size: 12px; color: var(--text-muted);">此操作将从磁盘中永久移除对应会话文件，<strong>无法恢复</strong>。</div>
          <div class="pi-enh-batch-modal-list">
            ${previewHtml}
            ${overflowHtml}
          </div>
        </div>
        <div class="pi-enh-batch-modal-footer">
          <button type="button" class="pi-enh-btn-sm" data-action="cancel" style="padding: 6px 14px; font-size: 12.5px; border-radius: 6px; cursor: pointer; background: var(--bg-hover); border: 1px solid var(--border); color: var(--text);">取消</button>
          <button type="button" class="pi-enh-btn-sm" data-action="confirm" style="padding: 6px 16px; font-size: 12.5px; border-radius: 6px; font-weight: 500; cursor: pointer; background: #ef4444; border: 1px solid transparent; color: #fff;">确认彻底删除</button>
        </div>
      </div>
    `;

    const cancelBtn = backdrop.querySelector('[data-action="cancel"]');
    const confirmBtn = backdrop.querySelector('[data-action="confirm"]');

    cancelBtn?.addEventListener("click", () => {
      closeBatchDeleteModal();
    });

    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) {
        closeBatchDeleteModal();
      }
    });

    confirmBtn?.addEventListener("click", async () => {
      if (cancelBtn) {
        cancelBtn.disabled = true;
        cancelBtn.style.opacity = "0.5";
        cancelBtn.style.pointerEvents = "none";
      }
      await executeBatchDeleteSessions(targetIds, confirmBtn);
    });

    document.body.appendChild(backdrop);
    batchDeleteModal = backdrop;
    confirmBtn?.focus();
  }

  async function executeBatchDeleteSessions(targetIds, confirmBtn) {
    if (batchDeleteInFlight || !Array.isArray(targetIds) || targetIds.length === 0) return;
    targetIds = Array.from(new Set(targetIds));
    batchDeleteInFlight = true;
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = `正在删除 (0/${targetIds.length})...`;
    }
    // Paint the busy state before any local bookkeeping. One request serves up
    // to 100 sessions; do not rerender the entire sidebar for every pending ID.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const activeSessionId = typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null;
    let shouldResetActiveView = false;
    let successCount = 0;
    const failedIds = new Set();
    let transportFailed = false;
    for (const sid of targetIds) markSessionAsDeleted(sid, 60000, false);
    try { window.__PI_ENH_RERENDER_SESSIONS__?.(); } catch (e) {}

    for (let offset = 0; offset < targetIds.length; offset += 100) {
      const ids = targetIds.slice(offset, offset + 100);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 30000);
      let results = new Map();
      let deletedIds = [];
      try {
        const response = await fetch("/api/sessions/batch-delete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids }), signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.results) || !Array.isArray(payload.deletedSessionIds)) throw new Error("无效的删除回执");
        results = new Map(payload.results.map((result) => [result.id, result]));
        deletedIds = payload.deletedSessionIds.filter((id) => typeof id === "string" && id);
      } catch (err) {
        transportFailed = true;
        console.warn("[pi-enh] Batch deletion receipt unavailable:", err?.message || String(err));
      } finally {
        clearTimeout(deadline);
      }
      const confirmedIds = new Set(deletedIds);
      for (const sid of ids) {
        if (results.get(sid)?.ok === true) confirmedIds.add(sid);
        if (confirmedIds.has(sid)) successCount++;
        else {
          failedIds.add(sid);
          restoreSessionDeleteState(sid, false);
        }
      }
      for (const sid of confirmedIds) {
        markSessionDeleteConfirmed(sid);
        selectedSessionBatchIds.delete(sid);
        cleanupDeletedSessionEverywhere(sid);
        try { window.__PI_ENH_SESSION_DELETED__?.(sid); } catch (e) {}
        try { void cleanupSessionUploadedFiles(sid).catch(() => {}); } catch (e) {}
        if (sid === activeSessionId) shouldResetActiveView = true;
      }
      if (confirmBtn) confirmBtn.textContent = `正在删除 (${offset + ids.length}/${targetIds.length})...`;
      // If the connection is lost, stop submitting more destructive requests.
      // An aborted request may have committed: refresh server truth; never
      // automatically resend it or claim that its files were restored.
      if (transportFailed) {
        for (const sid of targetIds.slice(offset + ids.length)) {
          failedIds.add(sid);
          restoreSessionDeleteState(sid, false);
        }
        break;
      }
    }

    if (shouldResetActiveView) {
      try { window.history.replaceState(null, "", "/"); } catch (e) {}
    }
    batchDeleteInFlight = false;
    closeBatchDeleteModal();
    if (failedIds.size === 0) setSessionBatchMode(false);
    else {
      selectedSessionBatchIds.clear();
      for (const sid of failedIds) selectedSessionBatchIds.add(sid);
      syncSessionBatchBar();
      syncSessionBatchRowStates();
      try { window.__PI_ENH_RERENDER_SESSIONS__?.(); } catch (e) {}
    }
    requestSessionListRefresh(false, true);
    if (transportFailed) {
      showToast(`连接中断或等待超时：已确认删除 ${successCount} 个，${failedIds.size} 个结果待确认。刷新列表后可重试。`, sessionDeleteIcon);
    } else if (failedIds.size) {
      showToast(`已删除 ${successCount} 个，${failedIds.size} 个未删除，已保留选择，可重试。`, sessionDeleteIcon);
    } else {
      showToast(`已成功彻底删除 ${successCount} 个会话`, sessionDeleteIcon);
    }
  }

  // 鼠标点击捕获监听：快捷激活批量模式与单选/连选
  addManagedListener(document, "click", (event) => {
    if (!isPluginEnabled("session-batch-actions")) return;
    const target = event.target;
    const row = target?.closest?.(".pi-enh-session-row-host[data-pi-enh-session-id]");
    if (!row) return;

    const sessionId = row.getAttribute("data-pi-enh-session-id");
    if (!sessionId) return;

    // 1. 普通模式下，按住 Ctrl/Cmd 或 Shift 点击会话行：直接激活批量管理模式！
    if (!isSessionBatchMode && (event.shiftKey || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      setSessionBatchMode(true);
      toggleSessionBatchSelect(sessionId, true, false, row);
      return;
    }

    // 2. 批量模式下：
    if (isSessionBatchMode) {
      // 排除更多菜单按钮等操作
      if (target.closest(".pi-enh-session-overflow, .pi-enh-session-menu, [data-session-action]")) {
        return;
      }

      const isDirectCheckbox = Boolean(
        target.matches?.(".pi-enh-session-batch-checkbox") ||
        target.classList?.contains("pi-enh-session-batch-checkbox")
      );

      if (isDirectCheckbox) {
        // 直接 input 点击：不要 preventDefault，避免 browser canceled activation 回滚
        // 保留 stopPropagation 阻止 native navigation
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

        const targetChecked = Boolean(target.checked);
        toggleSessionBatchSelect(sessionId, targetChecked, event.shiftKey, row);
      } else {
        // label / row 点击：照常 preventDefault 阻止二次 click 与原生导航
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();

        const nextChecked = !selectedSessionBatchIds.has(sessionId);
        toggleSessionBatchSelect(sessionId, nextChecked, event.shiftKey, row);
      }
    }
  }, true);

  // 鼠标拖拽划选支持 (Drag Select)
  addManagedListener(document, "mousedown", (event) => {
    if (!isSessionBatchMode || event.button !== 0) return;
    const row = event.target?.closest?.(".pi-enh-session-row-host[data-pi-enh-session-id]");
    if (!row || event.target.closest(".pi-enh-session-overflow, .pi-enh-session-menu, [data-session-action]")) return;
    const sessionId = row.getAttribute("data-pi-enh-session-id");
    if (!sessionId) return;

    isBatchDragging = true;
    const checkbox = row.querySelector(".pi-enh-session-batch-checkbox");
    if (event.target === checkbox) {
      batchDragTargetState = !checkbox.checked;
    } else {
      batchDragTargetState = !selectedSessionBatchIds.has(sessionId);
    }
  }, true);

  addManagedListener(document, "mouseover", (event) => {
    if (!isSessionBatchMode || !isBatchDragging) return;
    const row = event.target?.closest?.(".pi-enh-session-row-host[data-pi-enh-session-id]");
    if (!row) return;
    const sessionId = row.getAttribute("data-pi-enh-session-id");
    if (!sessionId) return;

    // 状态无变化直接跳过，避免高频无谓重复渲染与全量扫描
    const currentlySelected = selectedSessionBatchIds.has(sessionId);
    if (currentlySelected === batchDragTargetState) {
      return;
    }

    if (batchDragTargetState) {
      selectedSessionBatchIds.add(sessionId);
    } else {
      selectedSessionBatchIds.delete(sessionId);
    }
    lastBatchClickedSessionId = sessionId;

    withMutationGuard(() => {
      updateSingleBatchRow(sessionId, batchDragTargetState, row);
      syncSessionBatchBar();
    });
  }, true);

  addManagedListener(window, "mouseup", () => {
    isBatchDragging = false;
  }, true);

  function syncSessionBatchActions() {
    if (!isPluginEnabled("session-batch-actions")) {
      if (isSessionBatchMode) setSessionBatchMode(false);
      removeSessionBatchTrigger();
      removeSessionBatchBar();
      return;
    }
    syncSessionBatchTriggerButton();
    if (isSessionBatchMode) {
      syncSessionBatchBar();
      syncSessionBatchRowStates();
    }
  }

  window.__PI_ENH_SET_SESSION_BATCH_MODE__ = setSessionBatchMode;
  window.__PI_ENH_IS_SESSION_BATCH_MODE__ = () => isSessionBatchMode;
  window.__PI_ENH_GET_SELECTED_BATCH_SESSION_IDS__ = () => Array.from(selectedSessionBatchIds);
  window.__PI_ENH_TOGGLE_SESSION_BATCH_SELECT__ = toggleSessionBatchSelect;
  window.__PI_ENH_TOGGLE_SELECT_ALL_BATCH__ = toggleSelectAllBatch;
  window.__PI_ENH_EXECUTE_BATCH_DELETE_SESSIONS__ = executeBatchDeleteSessions;
  window.__PI_ENH_SYNC_SESSION_BATCH_ACTIONS__ = syncSessionBatchActions;

  function latestAssistantAwaitsUserReply() {
    const assistants = Array.from(document.querySelectorAll('div[data-message-role="assistant"]'));
    if (assistants.length === 0) return false;
    const users = Array.from(document.querySelectorAll('div[data-message-role="user"]'));
    if (users.length === 0) return true;
    const latestAssistant = assistants[assistants.length - 1];
    const latestUser = users[users.length - 1];
    if (typeof latestAssistant.compareDocumentPosition !== "function") return true;
    return (latestAssistant.compareDocumentPosition(latestUser) & 4) === 0;
  }

  function getLatestAssistantEntryId() {
    const assistants = Array.from(document.querySelectorAll('div[data-message-role="assistant"]'));
    return assistants[assistants.length - 1]?.getAttribute?.("data-entry-id") || null;
  }

  const QUICK_REPLY_BUTTON_ATTR = "data-pi-enh-quick-reply";
  const QUICK_REPLY_ORIGINAL_TEXT_ATTR = "data-pi-enh-original-text";
  const QUICK_REPLY_ORIGINAL_TITLE_ATTR = "data-pi-enh-original-title";
  const QUICK_REPLY_ORIGINAL_ARIA_ATTR = "data-pi-enh-original-aria";

  const SYSTEM_RESERVED_WORDS = /^(?:后续消息|引导|发送|排队|停止|取消|确定|确认|继续|重试|撤回|删除|编辑|复制|查看|设置|提交|yes|no|ok|cancel|send|steer|follow-?up|stop|retry|continue|报错|错误|代码|如下|链接|命令|日志|信息|详情|结果|内容|参数)$/i;

  function extractEphemeralQuickReply(assistantElement) {
    if (!assistantElement) return null;
    let target = assistantElement;
    if (typeof assistantElement.cloneNode === "function") {
      const clone = assistantElement.cloneNode(true);
      if (clone && typeof clone.querySelectorAll === "function") {
        for (const el of clone.querySelectorAll("pre, code, .pi-enh-tool-card, [data-pi-enh-tool-card], blockquote, [data-pi-enh-annotation-badge]")) {
          if (typeof el.remove === "function") el.remove();
        }
        target = clone;
      }
    }
    const text = String(target.textContent || "").trim();
    if (!text) return null;

    const patterns = [
      /回复(?:我)?(?:一声|一句|一个|下)?(?:“|「|『|")([^"”」』\n\r]{1,24})(?:”|」|』|")/g,
      /请(?:您)?回复(?:我)?(?:“|「|『|")([^"”」』\n\r]{1,24})(?:”|」|』|")/g,
      /可(?:以)?回复(?:我)?(?:“|「|『|")([^"”」』\n\r]{1,24})(?:”|」|』|")/g,
      /(?:请|可|若想|如需)(?:输入|发送)(?:“|「|『|")([^"”」』\n\r]{1,24})(?:”|」|』|")/g,
      /(?:回复|发送|输入)【([^】\n\r]{1,24})】/g,
      /【(?:回复|发送|输入)([^】\n\r]{1,24})】/g,
      /(?:please\s+)?reply\s+(?:with\s+)?["\x27]([^"\x27\n\r]{1,24})["\x27]/gi,
    ];

    let candidates = [];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        let val = String(match[1] || "").trim();
        val = val.replace(/^[，。！？、：；,\.!?:;]+|[，。！？、：；,\.!?:;]+$/g, "").trim();
        if (val && val.length >= 1 && val.length <= 20) {
          if (!SYSTEM_RESERVED_WORDS.test(val)) {
            const after = text.slice(match.index + match[0].length, match.index + match[0].length + 4);
            if (!/^[后时之比如]/.test(after)) {
              candidates.push({ text: val, index: match.index });
            }
          }
        }
      }
      if (candidates.length > 0) break;
    }
    return candidates.length ? candidates[candidates.length - 1].text : null;
  }

  function isNativeSendButton(button) {
    if (!button) return false;
    if (!isNativeComposerLayoutButton(button)) return false;
    const className = String(button.className || "");
    if (/\bpi-enh-quick-(?:start-button|fallback-trigger|menu-item)\b/.test(className)) return false;
    const labels = [
      button.textContent,
      button.getAttribute?.("aria-label"),
      button.getAttribute?.("title"),
      button.getAttribute?.(QUICK_REPLY_ORIGINAL_TEXT_ATTR),
      button.getAttribute?.(QUICK_REPLY_ORIGINAL_ARIA_ATTR),
    ].map((value) => String(value || "").trim()).filter(Boolean);
    return labels.some((label) => /^(?:发送(?:消息)?|send(?: message)?)(?:\s|$|[（(])/i.test(label));
  }

  function findNativeSendButtons(textarea) {
    if (!textarea) return [];
    const layout = textarea.closest?.("[data-pi-native-composer-layout]");
    if (!layout) return [];
    const roots = [layout];
    const buttons = [];
    const visited = new Set();
    for (const root of roots) {
      if (visited.has(root) || typeof root.querySelectorAll !== "function") continue;
      visited.add(root);
      for (const button of root.querySelectorAll("button")) {
        if (isNativeSendButton(button) && !buttons.includes(button)) buttons.push(button);
      }
    }
    return buttons;
  }

  const quickReplyButtonState = new WeakMap();

  function replaceButtonSendText(button, reply) {
    if (!button || !reply?.text) return;
    let state = quickReplyButtonState.get(button);
    if (!state || !button.contains(state.node)) {
      const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (/^(发送(?:消息)?|send(?: message)?)$/i.test(node.nodeValue.trim())) break;
      }
      let createdNode = false;
      if (!node) {
        const walker2 = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        while ((node = walker2.nextNode())) {
          if (/(?:发送|send)/i.test(node.nodeValue)) break;
        }
      }
      if (!node) {
        node = document.createTextNode(button.textContent || "发送");
        button.appendChild(node);
        createdNode = true;
      }
      state = { node, text: node.nodeValue, title: button.getAttribute("title"), aria: button.getAttribute("aria-label"), createdNode };
      quickReplyButtonState.set(button, state);
      button.setAttribute(QUICK_REPLY_ORIGINAL_TEXT_ATTR, state.text.trim());
    }
    state.reply = reply;
    state.sessionId = getCurrentSessionId();
    state.assistantEntryId = getLatestAssistantEntryId();
    // Idempotent DOM writes avoid a MutationObserver feedback loop.
    if (state.node.nodeValue !== reply.text) state.node.nodeValue = reply.text;
    if (button.getAttribute(QUICK_REPLY_BUTTON_ATTR) !== reply.text) button.setAttribute(QUICK_REPLY_BUTTON_ATTR, reply.text);
    const title = `${reply.mode === "fill" ? "填入" : "发送"}：${reply.message}`;
    if (button.getAttribute("title") !== title) button.setAttribute("title", title);
    if (button.getAttribute("aria-label") !== reply.text) button.setAttribute("aria-label", reply.text);
  }

  function restoreButtonSendText(button) {
    if (!button?.hasAttribute(QUICK_REPLY_BUTTON_ATTR)) return;
    const state = quickReplyButtonState.get(button);
    if (state) {
      if (button.contains(state.node)) {
        if (state.createdNode) state.node.remove();
        else state.node.nodeValue = state.text;
      }
      for (const [name, value] of [["title", state.title], ["aria-label", state.aria]]) {
        if (value === null) button.removeAttribute(name); else button.setAttribute(name, value);
      }
    }
    for (const attr of [QUICK_REPLY_BUTTON_ATTR, QUICK_REPLY_ORIGINAL_TEXT_ATTR, QUICK_REPLY_ORIGINAL_TITLE_ATTR, QUICK_REPLY_ORIGINAL_ARIA_ATTR]) button.removeAttribute(attr);
    quickReplyButtonState.delete(button);
  }

  function restoreAllQuickReplyButtons(scope = document) {
    if (!scope || typeof scope.querySelectorAll !== "function") return;
    for (const button of scope.querySelectorAll(`[${QUICK_REPLY_BUTTON_ATTR}]`)) {
      restoreButtonSendText(button);
    }
  }

  function getActiveQuickReply() {
    if (!latestAssistantAwaitsUserReply()) return null;
    const selection = currentQuickActionSelection();
    if (selection?.action?.label) {
      return {
        id: selection.action.id,
        text: selection.action.label,
        message: selection.action.message || selection.action.label,
        mode: selection.action.mode || "send",
        source: selection.source || "tool",
      };
    }
    return null;
  }

  let quickReplySending = false;
  let quickReplyPassthrough = false;
  let quickReplySendingButton = null;

  function consumeQuickReplyClick(event) {
    if (quickReplyPassthrough) return false;
    const button = event?.target?.closest?.("button");
    if (!isNativeComposerLayoutButton(button)) return false;
    const stop = () => { event.preventDefault?.(); event.stopPropagation?.(); event.stopImmediatePropagation?.(); };
    if (quickReplySending && button === quickReplySendingButton) { stop(); return true; }
    if (!button?.hasAttribute(QUICK_REPLY_BUTTON_ATTR)) return false;
    const state = quickReplyButtonState.get(button);
    const textarea = findComposerTextarea();
    if (!state || !textarea || !isPluginEnabled("quick-action-buttons") || isChatSessionRunning() ||
        state.sessionId !== getCurrentSessionId() || state.assistantEntryId !== getLatestAssistantEntryId() ||
        !isComposerInputEmpty(textarea) || composerHasAnySendPayload(textarea)) {
      restoreButtonSendText(button);
      return false;
    }
    stop();
    const { reply, sessionId, assistantEntryId } = state;
    restoreButtonSendText(button);
    if (!setComposerTextareaValue(textarea, reply.message)) return true;
    if (reply.mode === "fill") return true;
    quickReplySending = true;
    quickReplySendingButton = button;
    addManagedTimeout(() => {
      try {
        if (window.__PI_ENH_SUPPRESS_AUTO_SEND__ || !isPluginEnabled("quick-action-buttons") ||
            isChatSessionRunning() || sessionId !== getCurrentSessionId() ||
            assistantEntryId !== getLatestAssistantEntryId() || !textarea.isConnected || textarea.value !== reply.message) return;
        quickReplyPassthrough = true;
        sendComposerText(textarea);
      } finally {
        quickReplyPassthrough = false;
        quickReplySending = false;
        quickReplySendingButton = null;
        addManagedTimeout(syncQuickActionButtons, 50);
      }
    }, 20);
    return true;
  }

  addManagedListener(document, "click", consumeQuickReplyClick, true);
  activeCleanups.push(restoreAllQuickReplyButtons);

  function currentQuickActionSelection() {
    if (!quickActionSelection || !quickActionsConfig.enabled) return null;
    const currentSessionId = getCurrentSessionId();
    if (quickActionSelectionSessionId && currentSessionId && quickActionSelectionSessionId !== currentSessionId) return null;
    const latestAssistantEntryId = getLatestAssistantEntryId();
    if (!quickActionSelection.assistantEntryId || !latestAssistantEntryId || quickActionSelection.assistantEntryId !== latestAssistantEntryId) return null;
    if (quickActionSelection.revision !== quickActionsConfig.revision) return null;
    if (quickActionSelection.action?.id === "custom") {
      return quickActionSelection;
    }
    const configured = quickActionsConfig.actions.find((action) => action.id === quickActionSelection.action?.id && action.enabled);
    if (!configured) return null;
    return { ...quickActionSelection, action: cloneQuickAction(configured) };
  }

  function syncQuickActionButtons() {
    notifyComposerSubmissionStateChange();
    if (!isPluginEnabled("quick-action-buttons")) {
      removeQuickActionButtons();
      return;
    }

    for (const actionBar of document.querySelectorAll(".pi-enh-quick-actions")) actionBar.remove();
    hideQuickActionToolCards();
    if (!window.__PI_ENH_DISABLE_QUICK_ACTION_CONTEXT_FETCH__) void refreshQuickActionSelection();

    const textarea = findComposerTextarea();
    if (!textarea) {
      removeQuickActionDoms();
      return;
    }
    bindComposerInputListener(textarea);

    if (isChatSessionRunning() || !isComposerInputEmpty(textarea) || composerHasAnySendPayload(textarea)) {
      removeQuickActionDoms();
      return;
    }

    const host = textarea.parentElement || (typeof getChatInputArea === "function" ? getChatInputArea() : null);
    if (!host) {
      removeQuickActionDoms();
      return;
    }

    // 已选中的快捷动作复用原生发送按钮；没有已选动作时保留 ⚡ 菜单入口。
    host.querySelector(".pi-enh-quick-start-button")?.remove();
    quickActionButton = null;
    const reply = getActiveQuickReply();
    if (reply) {
      host.querySelector(".pi-enh-quick-fallback-trigger")?.remove();
      quickActionFallbackTrigger = null;
      for (const button of findNativeSendButtons(textarea)) replaceButtonSendText(button, reply);
      return;
    }

    restoreAllQuickReplyButtons();
    // 顺应用户明确需求：彻底移除输入框闪电 (⚡) 快捷菜单，防止与镜头附件或发送按键重叠
    host.querySelector(".pi-enh-quick-fallback-trigger")?.remove();
    for (const el of document.querySelectorAll(".pi-enh-quick-fallback-trigger, .pi-enh-quick-menu")) {
      el.remove();
    }
    quickActionFallbackTrigger = null;
  }

  window.__PI_ENH_HANDLE_QUICK_REPLY_CLICK__ = consumeQuickReplyClick;
  window.__PI_ENH_GET_EPHEMERAL_QUICK_REPLY__ = () => null;
  window.__PI_ENH_EXTRACT_EPHEMERAL_QUICK_REPLY__ = () => null;
  window.__PI_ENH_GET_QUICK_ACTION_CONFIG__ = () => cloneQuickActionsConfig(quickActionsConfig);
  window.__PI_ENH_GET_QUICK_ACTION_DRAFT__ = () => cloneQuickActionsConfig(quickActionsDraftConfig);
  window.__PI_ENH_SET_QUICK_ACTION_CONFIG__ = (config) => setQuickActionsConfig(config, "test");
  window.__PI_ENH_UPDATE_QUICK_ACTION_DRAFT__ = updateQuickActionDraft;
  window.__PI_ENH_PARSE_QUICK_ACTION_MESSAGES__ = parseQuickActionMessages;
  window.__PI_ENH_SET_QUICK_ACTION_SELECTION__ = (selection) => {
    if (selection === null) {
      quickActionSelection = null;
      quickActionSelectionSessionId = getCurrentSessionId();
      syncQuickActionButtons();
      return true;
    }
    const action = normalizeQuickAction(selection?.action);
    if (!action || selection?.schemaVersion !== 1 || !Number.isSafeInteger(selection?.revision)) return false;
    quickActionSelection = {
      schemaVersion: 1,
      revision: selection.revision,
      action,
      reason: typeof selection.reason === "string" ? selection.reason.slice(0, 200) : "",
      assistantEntryId: selection.assistantEntryId || getLatestAssistantEntryId(),
    };
    quickActionSelectionSessionId = getCurrentSessionId();
    syncQuickActionButtons();
    return Boolean(currentQuickActionSelection());
  };
  window.__PI_ENH_REFRESH_QUICK_ACTION_SELECTION__ = () => refreshQuickActionSelection(true);
  window.__PI_ENH_LOAD_QUICK_ACTION_CONFIG__ = () => loadQuickActionsConfig(true);
  window.__PI_ENH_SYNC_QUICK_ACTIONS__ = syncQuickActionButtons;
  window.__PI_ENH_SAVE_QUICK_ACTION_CONFIG__ = saveQuickActionsConfig;
  window.__PI_ENH_GET_QUICK_ACTION_STATE__ = () => ({
    syncStatus: quickActionsSyncStatus,
    configSource: quickActionsConfigSource,
    selection: currentQuickActionSelection(),
    architecture: "post-turn-v2",
    sessionId: quickActionSelectionSessionId,
    guards: (() => {
      const textarea = findComposerTextarea();
      return {
        hasTextarea: Boolean(textarea),
        inputEmpty: isComposerInputEmpty(textarea),
        hasPayload: composerHasAnySendPayload(textarea),
        running: isChatSessionRunning(),
        awaitsReply: latestAssistantAwaitsUserReply(),
      };
    })(),
  });
  if (!window.__PI_ENH_DISABLE_QUICK_ACTION_CONTEXT_FETCH__) {
    void loadQuickActionsConfig().then(() => refreshQuickActionSelection(true));
  }

  addManagedListener(document, "click", (e) => {
    if (!quickActionMenu) return;
    if (e.target.closest && (e.target.closest(".pi-enh-quick-menu") || e.target.closest(".pi-enh-quick-fallback-trigger"))) {
      return;
    }
    closeQuickActionMenu();
  });

  // ==========================================
  // 新建会话光标自动聚焦输入框
  // ==========================================
  function findActiveComposerEditable() {
    const textarea = findComposerTextarea();
    return textarea && textarea.isConnected ? textarea : null;
  }

  function focusComposerEditable({ force = false } = {}) {
    const native = readNativeComposerDraft();
    if (typeof native?.handle?.focusEditable === "function") return native.handle.focusEditable();
    if (isMobileEnvironment()) return false;
    const el = findActiveComposerEditable();
    if (!el || !el.isConnected) return false;
    if (window.getComputedStyle(el).display === "none") return false;

    const active = document.activeElement;
    if (!force && active && active !== document.body && active !== el) {
      const isOther = (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable) &&
                      !active.closest("[data-pi-native-composer-host], form, .chat-input-textarea, .pi-enh-cursor-composer");
      if (isOther) return false;
    }

    try {
      el.focus({ preventScroll: true });
      const len = el.value ? el.value.length : 0;
      el.setSelectionRange(len, len);
      return document.activeElement === el;
    } catch (e) {
      return false;
    }
  }

  function triggerNewSessionComposerFocus() {
    if (isMobileEnvironment()) return;
    let frameCount = 0;
    const maxFrames = 15;
    const poll = () => {
      frameCount++;
      const focused = focusComposerEditable({ force: true });
      if (focused || frameCount >= maxFrames || isDisposed) return;
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  }

  function isNewSessionButton(target) {
    if (!target || typeof target.closest !== "function") return false;
    const btn = target.closest("button, a, [role='button']");
    if (!btn) return false;
    const title = (btn.getAttribute("title") || "").trim();
    const aria = (btn.getAttribute("aria-label") || "").trim();
    const text = (btn.textContent || "").trim();
    if (/新建会话|New session/i.test(title) || /新建会话|New session/i.test(aria)) return true;
    if (/^(?:\+\s*)?(?:新建|New)$/i.test(text) && btn.closest(".sidebar-container, aside, div[style*='borderBottom']")) return true;
    return false;
  }

  // 点击新建按钮触发聚焦
  addManagedListener(document, "click", (e) => {
    if (isNewSessionButton(e.target)) {
      triggerNewSessionComposerFocus();
    }
  }, true);

  // 全局新建会话快捷键
  addManagedListener(document, "keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === "n" || e.key === "N")) {
      triggerNewSessionComposerFocus();
    }
  }, true);

  // 聚焦只由明确的输入/新建动作触发；正文拖选造成的失焦应交给浏览器。
  window.__PI_ENH_FOCUS_COMPOSER__ = focusComposerEditable;

  // The native queue responds synchronously. Announce readiness only after
  // its composer/session dependencies have finished initializing.
  window.dispatchEvent(new Event("pi:native-queue-ready"));
