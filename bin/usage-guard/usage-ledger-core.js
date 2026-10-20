/* Shared, side-effect-free accounting used by the generator and Usage plugin. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PiUsageLedger = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "messageCount", "calls", "records", "costNano", "unpricedTokens", "missingUsage"];
  const empty = () => Object.fromEntries(fields.map(k => [k, 0]));
  function add(to, from) { for (const k of fields) to[k] += from[k] || 0; return to; }
  function day(timestamp) {
    const ms = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
    return Number.isFinite(ms) ? new Date(ms + 8 * 3600000).toISOString().slice(0, 10) : "unknown";
  }

  const MODEL_CANONICAL_MAP = {
    "gemini-3.8-flash-high": { key: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
    "gemini-3.8-flash": { key: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
    "gemini-3.8-flash-exp-a": { key: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
    "gemini-3.8-flash-exp": { key: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
    "gemini-2.0-flash": { key: "gemini-2.0-flash", name: "Gemini 2.0 Flash" },
    "gemini-1.5-pro": { key: "gemini-1.5-pro", name: "Gemini 1.5 Pro" },
    "gpt-6-astra": { key: "gpt-6-astra", name: "GPT-6 Astra" },
    "gpt-6.1-sol": { key: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
    "gpt-6-sol": { key: "gpt-6-sol", name: "GPT-6 Sol" },
    "gpt-6-luna": { key: "gpt-6-luna", name: "GPT-6 Luna" },
    "gpt-5.6-sol": { key: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    "gpt-5.6-terra": { key: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
    "gpt-5.6-luna": { key: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    "gpt-5.5": { key: "gpt-5.5", name: "GPT-5.5" },
    "gpt-5.4": { key: "gpt-5.4", name: "GPT-5.4" },
    "gpt-5.4-mini": { key: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    "gpt-5.4-nano": { key: "gpt-5.4-nano", name: "GPT-5.4 nano" },
    "gpt-5.4-pro": { key: "gpt-5.4-pro", name: "GPT-5.4 Pro" },
    "gpt-5": { key: "gpt-5", name: "GPT-5" },
    "gpt-5-mini": { key: "gpt-5-mini", name: "GPT-5 mini" },
    "gpt-4o-mini": { key: "gpt-4o-mini", name: "GPT-4o mini" },
    "gpt-4o": { key: "gpt-4o", name: "GPT-4o" },
    "o3": { key: "o3", name: "o3" },
    "o3-mini": { key: "o3-mini", name: "o3-mini" },
    "o3-pro": { key: "o3-pro", name: "o3-pro" },
    "o4-mini": { key: "o4-mini", name: "o4-mini" },
    "o1": { key: "o1", name: "o1" },
    "claude-3.7-sonnet": { key: "claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
    "claude-3.5-sonnet": { key: "claude-3.5-sonnet", name: "Claude 3.5 Sonnet" },
    "deepseek-flash": { key: "deepseek-flash", name: "DeepSeek V4.1 Flash" },
    "deepseek-v4-pro": { key: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    "system-summaries": { key: "system-summaries", name: "工具 / 压缩摘要" },
  };

  // Pi SDK 模型目录参考价/基准价，非账单 (USD / 1M Tokens: [input, output, cacheRead, cacheWrite])
  const STANDARD_RATES = {
    "gemini-3.8-flash-high": [0.10, 0.40, 0.025, 0.025], // Google 官方 Gemini 3.8 Flash High 定价
    "gemini-3.8-flash": [0.10, 0.40, 0.025, 0.025],
    "gemini-3.8-flash-exp-a": [0.10, 0.40, 0.025, 0.025],
    "gemini-3.8-flash-exp": [0.10, 0.40, 0.025, 0.025],
    "gemini-2.0-flash": [0.10, 0.40, 0.025, 0.025],
    "gemini-1.5-pro": [1.25, 5.00, 0.3125, 0.3125],
    "gpt-6-astra": [10.00, 50.00, 1.00, 12.50],
    "gpt-6.1-sol": [2.00, 10.00, 0.10, 2.50], // OpenAI 官方 Standard 定价 (https://developers.openai.com/api/docs/pricing)
    "gpt-6-sol": [2.00, 10.00, 0.20, 2.50],
    "gpt-6-luna": [0.10, 0.50, 0.01, 0.125],
    "gpt-5.6-sol": [4.00, 20.00, 0.40, 5.00], // 最新官方调整下调 20%
    "gpt-5.6-terra": [2.00, 12.00, 0.20, 2.50],
    "gpt-5.6-luna": [0.20, 1.20, 0.02, 0.25],
    "gpt-5.5": [5.00, 30.00, 0.50, 0.00],
    "gpt-5.4": [2.50, 15.00, 0.25, 0.00],
    "gpt-5.4-mini": [0.75, 4.50, 0.075, 0.00],
    "gpt-5.4-nano": [0.20, 1.25, 0.02, 0.00],
    "gpt-5.4-pro": [30.00, 180.00, 0.00, 0.00],
    "gpt-5": [1.25, 10.00, 0.125, 0.00],
    "gpt-5-mini": [0.25, 2.00, 0.025, 0.00],
    "gpt-4o-mini": [0.15, 0.60, 0.075, 0.075],
    "gpt-4o": [2.50, 10.00, 1.25, 1.25],
    "o3": [2.00, 8.00, 0.50, 0.00],
    "o3-mini": [1.10, 4.40, 0.55, 0.00],
    "o3-pro": [20.00, 80.00, 0.00, 0.00],
    "o4-mini": [1.10, 4.40, 0.275, 0.00],
    "o1": [15.00, 60.00, 7.50, 0.00],
    "claude-3.7-sonnet": [3.00, 15.00, 0.30, 0.30],
    "claude-3.5-sonnet": [3.00, 15.00, 0.30, 0.30],
    "deepseek-flash": [0.30, 1.20, 0.006, 0.006], // DeepSeek 官网最新标准高峰价 (空闲5折为 [0.15, 0.60, 0.003, 0.003])
    "deepseek-v4-pro": [1.32, 3.96, 0.044, 0.044], // DeepSeek 官网最新 Pro 高峰价 (空闲5折为 [0.66, 1.98, 0.022, 0.022])
    "system-summaries": [2.50, 10.00, 1.25, 1.25],
  };

  // 规范模型归一化映射：仅显式完整别名白名单，未知保持原样，system仅无模型时归为system-summaries
  function canonicalModel(model, provider, role) {
    const raw = String(model || "").trim();
    const m = raw.toLowerCase();
    if (!m || m === "unknown") {
      if (role === "system") return { key: "system-summaries", name: "工具 / 压缩摘要" };
      return { key: "unknown", name: "未记录模型" };
    }
    if (MODEL_CANONICAL_MAP[m]) return MODEL_CANONICAL_MAP[m];
    const base = m.includes("/") ? m.split("/").pop() : m;
    if (MODEL_CANONICAL_MAP[base]) return MODEL_CANONICAL_MAP[base];
    return { key: raw, name: raw };
  }

  function isValidDay(d) {
    if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    const [y, m, dayNum] = d.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, dayNum));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === dayNum;
  }

  function name(id) {
    return canonicalModel(id, null, null).name;
  }

  // Only validated Codex lineage changes the conversation dimension. Physical
  // execution buckets, dates, roles and Pi's existing ownership stay intact.
  function conversationId(ledger, id) {
    const seen = new Set([id]);
    let current = id;
    while (true) {
      const parent = ledger.sessions?.[current]?.parentSessionId;
      if (typeof parent !== "string" || !parent.startsWith("codex:") || !ledger.sessions?.[parent]) return current;
      if (seen.has(parent)) return id;
      seen.add(parent);
      current = parent;
    }
  }

  function aggregate(ledger, options = {}) {
    const total = empty(), roles = { main: empty(), subagent: empty(), system: empty() };
    const models = new Map(), sessions = new Map(), allModels = new Map(), physicalSessions = new Set();
    const now = options.now ?? Date.now(), range = options.timeRange || "all";

    const validRanges = ["all", "today", "yesterday", "24h", "7d", "30d", "custom"];
    if (options.timeRange && !validRanges.includes(options.timeRange)) {
      throw new Error(`Invalid timeRange: ${options.timeRange}`);
    }
    const validRoles = ["all", "main", "subagent", "system"];
    if (options.role && !validRoles.includes(options.role)) {
      throw new Error(`Invalid role: ${options.role}`);
    }
    const validEngines = ["all", "pi", "codex"];
    if (options.engine !== undefined && !validEngines.includes(options.engine)) {
      throw new Error(`Invalid engine: ${options.engine}`);
    }
    const selectedEngine = options.engine === undefined ? "all" : options.engine;
    if (options.now !== undefined && (typeof options.now !== "number" || !Number.isFinite(options.now))) {
      throw new Error("Invalid now timestamp");
    }

    const hasModelFilter = Boolean(options.model && options.model !== "all");
    let optCanonicalKey = null;
    let optRaw = null;
    if (hasModelFilter) {
      optRaw = String(options.model).trim();
      const optCanonical = canonicalModel(optRaw);
      if (MODEL_CANONICAL_MAP[optCanonical.key]) {
        optCanonicalKey = optCanonical.key;
      }
    }

    let windowStart = -Infinity, windowEnd = Infinity;
    let startCutoff = "", endCutoff = "";

    if (range === "today") {
      startCutoff = day(now);
      endCutoff = day(now);
    } else if (range === "yesterday") {
      startCutoff = day(now - 86400000);
      endCutoff = day(now - 86400000);
    } else if (range === "24h") {
      windowStart = now - 86400000;
      windowEnd = now;
    } else if (range === "7d") {
      startCutoff = day(now - 6 * 86400000);
      endCutoff = day(now);
    } else if (range === "30d") {
      startCutoff = day(now - 29 * 86400000);
      endCutoff = day(now);
    } else if (range === "custom") {
      if (options.startDate != null && options.startDate !== "") {
        if (!isValidDay(options.startDate)) throw new Error(`Invalid custom startDate: ${options.startDate}`);
        startCutoff = options.startDate;
      }
      if (options.endDate != null && options.endDate !== "") {
        if (!isValidDay(options.endDate)) throw new Error(`Invalid custom endDate: ${options.endDate}`);
        endCutoff = options.endDate;
      }
      if (startCutoff && endCutoff && startCutoff > endCutoff) {
        throw new Error(`Invalid custom date range: startDate ${startCutoff} > endDate ${endCutoff}`);
      }
    }

    let excludedTokens = 0, excludedRecords = 0;

    for (const b of ledger.buckets || []) {
      const bucketEngine = b.engine === undefined ? "pi" : b.engine;
      if (bucketEngine !== "pi" && bucketEngine !== "codex") {
        throw new Error(`Invalid bucket engine: ${bucketEngine}`);
      }
      if (selectedEngine !== "all" && bucketEngine !== selectedEngine) continue;

      const c = canonicalModel(b.model, b.provider, b.role);
      const cKey = c.key;
      allModels.set(cKey, c.name);

      let matchExecutionCandidate = true;
      if (hasModelFilter) {
        if (optCanonicalKey) {
          matchExecutionCandidate = (cKey === optCanonicalKey);
        } else {
          const fullBucketModel = (b.provider && b.provider !== "unknown") ? `${b.provider}/${b.model}` : b.model;
          matchExecutionCandidate = (cKey === optRaw || b.model === optRaw || fullBucketModel === optRaw);
        }
      }

      let matchControllerCandidate = false;
      let ctrlCanonical = null;
      if (b.role === "subagent" && b.controllerModel && b.controllerModel !== "unknown") {
        ctrlCanonical = canonicalModel(b.controllerModel, null, "main");
        if (!hasModelFilter) {
          matchControllerCandidate = true;
        } else {
          if (optCanonicalKey) {
            matchControllerCandidate = (ctrlCanonical.key === optCanonicalKey);
          } else {
            const fullCtrlModel = (b.controllerProvider && b.controllerProvider !== "unknown") ? `${b.controllerProvider}/${b.controllerModel}` : b.controllerModel;
            matchControllerCandidate = (ctrlCanonical.key === optRaw || b.controllerModel === optRaw || fullCtrlModel === optRaw);
          }
        }
      }

      // 如果既非目标执行模型，也非目标 controller 的调度子任务，则跳过
      if (!matchExecutionCandidate && !matchControllerCandidate) continue;

      let item;
      if (range === "24h") {
        let dayStart = -Infinity, dayEnd = Infinity;
        let dayKnown = false;
        if (b.day !== "unknown") {
          dayStart = Date.parse(`${b.day}T00:00:00+08:00`);
          dayEnd = dayStart + 86400000;
          dayKnown = Number.isFinite(dayStart);
        }
        const overlaps24h = !dayKnown || (dayEnd > windowStart && dayStart <= windowEnd);

        if (Array.isArray(b.timeline)) {
          const filtered = { ...b, ...empty() };
          let matched = 0;
          for (const entry of b.timeline) {
            const ts = entry[0];
            if (typeof ts === "number" && Number.isFinite(ts)) {
              if (ts > windowStart && ts <= windowEnd) {
                matched++;
                for (let i = 0; i < fields.length; i++) {
                  filtered[fields[i]] += entry[1 + i] || 0;
                }
              }
            } else {
              if (overlaps24h) {
                excludedTokens += entry[1 + 4] || 0;
                excludedRecords += entry[1 + 7] || 0;
              }
            }
          }
          if (matched === 0) continue;
          item = filtered;
        } else {
          if (!overlaps24h) {
            continue;
          }
          if (dayKnown && dayStart > windowStart && dayEnd - 1 <= windowEnd) {
            item = { ...b };
          } else {
            excludedTokens += b.totalTokens;
            excludedRecords += b.records;
            continue;
          }
        }
      } else {
        if (startCutoff && (b.day === "unknown" || b.day < startCutoff)) continue;
        if (endCutoff && (b.day === "unknown" || b.day > endCutoff)) continue;
        item = { ...b };
      }

      // 智能价格核算：有原生上报优先原值；旧桶整个桶 cost=0 时全桶补价；不得对 cost>0 且部分 unpriced 用比例近似冒充精确
      let effectiveCostNano = bucketEngine === "codex" ? 0 : (item.costNano || 0);
      let effectiveUnpriced = item.unpricedTokens || 0;
      if (bucketEngine !== "codex" && item.totalTokens > 0) {
        const rate = STANDARD_RATES[cKey];
        if (rate) {
          if (effectiveCostNano <= 0) {
            const estUsd = ((item.inputTokens || 0) * rate[0] + (item.outputTokens || 0) * rate[1] + (item.cacheReadTokens || 0) * rate[2] + (item.cacheWriteTokens || 0) * (rate[3] || 0)) / 1e6;
            effectiveCostNano = Math.round(estUsd * 1e9);
            effectiveUnpriced = 0;
          }
        }
      }

      item = { ...item, costNano: effectiveCostNano, unpricedTokens: effectiveUnpriced };

      const matchRole = !options.role || options.role === "all" || b.role === options.role;

      // 1. 物理执行维度：必须匹配执行模型筛选与角色筛选
      if (matchExecutionCandidate && matchRole) {
        add(total, item);
        add(roles[item.role], item);
        if (bucketEngine === "codex") {
          total.codexTokens = (total.codexTokens || 0) + item.totalTokens;
          roles[item.role].codexTokens = (roles[item.role].codexTokens || 0) + item.totalTokens;
        }

        if (!models.has(cKey)) {
          models.set(cKey, {
            ...empty(),
            key: cKey,
            name: c.name,
            providerList: new Set(),
            sessionIds: new Set(),
            roles: { main: empty(), subagent: empty(), system: empty() },
            dispatchedSubagents: { tokens: 0, calls: 0, messages: 0, pricingComplete: true },
            workerSubagents: { tokens: 0, calls: 0, messages: 0 },
          });
        }
        const m = models.get(cKey);
        add(m, item);
        add(m.roles[item.role], item);
        if (bucketEngine === "codex") {
          m.codexTokens = (m.codexTokens || 0) + item.totalTokens;
          m.roles[item.role].codexTokens = (m.roles[item.role].codexTokens || 0) + item.totalTokens;
        }
        const groupId = bucketEngine === "codex" ? conversationId(ledger, item.sessionId) : item.sessionId;
        physicalSessions.add(item.sessionId);
        m.sessionIds.add(groupId);
        if (b.provider && b.provider !== "unknown") m.providerList.add(b.provider);

        if (b.role === "subagent") {
          m.workerSubagents.tokens += item.totalTokens;
          m.workerSubagents.calls += item.calls;
          m.workerSubagents.messages += item.messageCount;
        }

        if (!sessions.has(groupId)) {
          sessions.set(groupId, { ...(ledger.sessions?.[groupId] || {}), ...empty(), id: groupId,
            mainTokens: 0, subagentTokens: 0, subagentIds: new Set(), subtaskDetails: new Map() });
        }
        const group = sessions.get(groupId);
        add(group, item);
        if (bucketEngine === "codex") {
          group.codexTokens = (group.codexTokens || 0) + item.totalTokens;
          if (item.role === "subagent") {
            group.subagentTokens += item.totalTokens;
            group.subagentIds.add(item.sessionId);
          } else group.mainTokens += item.totalTokens;
        }
        // These rows explain already-counted Codex physical usage. They never
        // flow back into aggregate totals, and require a validated parent link.
        if (bucketEngine === "codex" && item.role === "subagent" && groupId !== item.sessionId) {
          const detailDay = typeof b.day === "string" ? b.day : "unknown";
          const detailKey = JSON.stringify([item.sessionId, detailDay]);
          let detail = group.subtaskDetails.get(detailKey);
          if (!detail) {
            const childSession = ledger.sessions?.[item.sessionId] || {};
            detail = {
              ...empty(), sessionId: item.sessionId,
              name: childSession.name || childSession.title || item.sessionId,
              day: detailDay, codexTokens: 0,
            };
            group.subtaskDetails.set(detailKey, detail);
          }
          add(detail, item);
          detail.codexTokens += item.totalTokens;
        }
      }

      // 2. 调度归属维度：双向子代理归属，仅记录发起调用的主控模型（非加和信息，不计入物理总量）
      // controller dispatch 必须遵守执行角色筛选：role=main 时不展示来自 role=subagent 的 dispatch/savings；role=all 或 role=subagent 时可展示
      if (matchControllerCandidate && ctrlCanonical && matchRole) {
        const ctrl = ctrlCanonical;
        if (!models.has(ctrl.key)) {
          models.set(ctrl.key, {
            ...empty(),
            key: ctrl.key,
            name: ctrl.name,
            providerList: new Set(),
            sessionIds: new Set(),
            roles: { main: empty(), subagent: empty(), system: empty() },
            dispatchedSubagents: { tokens: 0, calls: 0, messages: 0, pricingComplete: true },
            workerSubagents: { tokens: 0, calls: 0, messages: 0 },
          });
        }
        const cm = models.get(ctrl.key);
        if (cm.dispatchedSubagents.pricingComplete === undefined) {
          cm.dispatchedSubagents.pricingComplete = true;
        }
        cm.dispatchedSubagents.tokens += item.totalTokens;
        cm.dispatchedSubagents.calls += item.calls;
        cm.dispatchedSubagents.messages += item.messageCount;
        if (bucketEngine === "codex") cm.dispatchedSubagents.codexTokens = (cm.dispatchedSubagents.codexTokens || 0) + item.totalTokens;

        // 子 Agent 实际费用：优先使用已按事件精确聚合的 item.costNano（item.costNano 是唯一实际费用入口）
        // 只有 unpricedTokens === 0 才算该子桶完整定价。
        // 若任何选中调度子桶未完整定价，整个 controller 的 savings 标记为 pricingComplete=false
        const mainRate = STANDARD_RATES[ctrl.key];
        const isSubPriced = bucketEngine !== "codex" && (item.unpricedTokens || 0) === 0;
        const hasHypMainCost = bucketEngine !== "codex" && Boolean(mainRate && (item.cacheWriteTokens === 0 || mainRate.length >= 4));

        if (isSubPriced && hasHypMainCost) {
          const actualSubCost = (item.costNano || 0) / 1e9;
          const mrCw = mainRate[3] || 0;
          const hypMainCost = ((item.inputTokens || 0) * mainRate[0] + (item.outputTokens || 0) * mainRate[1] + (item.cacheReadTokens || 0) * mainRate[2] + (item.cacheWriteTokens || 0) * mrCw) / 1e6;
          cm.dispatchedSubagents.actualCost = (cm.dispatchedSubagents.actualCost || 0) + actualSubCost;
          cm.dispatchedSubagents.hypotheticalCost = (cm.dispatchedSubagents.hypotheticalCost || 0) + hypMainCost;
        } else {
          cm.dispatchedSubagents.pricingComplete = false;
        }
      }
    }

    const modelBreakdowns = [...models.values()].map(m => {
      const d = m.dispatchedSubagents;
      if (d) {
        if (d.calls > 0 && d.pricingComplete && d.hypotheticalCost > 0) {
          d.savedCost = Math.max(0, d.hypotheticalCost - d.actualCost);
          d.subSavedRatio = ((d.savedCost / d.hypotheticalCost) * 100).toFixed(1);
          const mainCost = (m.roles.main.costNano || 0) / 1e9;
          d.allMainTotalCost = mainCost + d.hypotheticalCost;
          d.actualTotalCost = mainCost + d.actualCost;
          d.overallSavedRatio = d.allMainTotalCost > 0 ? ((d.savedCost / d.allMainTotalCost) * 100).toFixed(1) : d.subSavedRatio;
        } else {
          d.pricingComplete = false;
          d.savedCost = 0;
          d.actualCost = 0;
          d.hypotheticalCost = 0;
          delete d.subSavedRatio;
          delete d.overallSavedRatio;
          delete d.allMainTotalCost;
          delete d.actualTotalCost;
        }
      }
      return {
        ...m,
        provider: m.providerList.size > 0 ? [...m.providerList].join(" · ") : "未记录渠道", 
        providerList: undefined,
        sessionCount: m.sessionIds.size,
        sessionIds: undefined,
        percentage: total.totalTokens ? Number(((m.totalTokens / total.totalTokens) * 100).toFixed(1)) : 0,
      };
    }).sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      ...total,
      roles,
      modelBreakdowns,
      allModels: [...allModels],
      sessionCount: sessions.size,
      physicalSessionCount: physicalSessions.size,
      topSessions: [...sessions.values()].map(({ subagentIds, subtaskDetails, ...session }) => ({
        ...session,
        subagentCount: subagentIds.size,
        subtasks: [...subtaskDetails.values()].sort((a, b) =>
          b.day.localeCompare(a.day) || b.totalTokens - a.totalTokens || a.name.localeCompare(b.name)),
      })).sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 10),
      timeCoverage: { excludedTokens, excludedRecords },
    };
  }

  function validate(ledger) {
    if (ledger.version !== 2 || !Array.isArray(ledger.buckets)) throw new Error("Unsupported Usage ledger schema");
    for (const b of ledger.buckets) {
      if (b.engine !== undefined && b.engine !== "pi" && b.engine !== "codex") throw new Error(`Invalid bucket engine: ${b.engine}`);
      if (!["main", "subagent", "system"].includes(b.role)) throw new Error("Invalid execution role");
      if (b.day !== "unknown") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(b.day)) throw new Error(`Invalid day format: ${b.day}`);
        const [y, m, d] = b.day.split("-").map(Number);
        const dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
          throw new Error(`Invalid calendar date: ${b.day}`);
        }
      }
      for (const k of fields) {
        if (!Number.isSafeInteger(b[k]) || b[k] < 0) throw new Error(`Invalid ${k}`);
      }
      if (b.totalTokens !== b.inputTokens + b.outputTokens + b.cacheReadTokens + b.cacheWriteTokens) {
        throw new Error("Token components do not reconcile");
      }

      if (b.timeline !== null && b.timeline !== undefined) {
        if (!Array.isArray(b.timeline)) throw new Error("Timeline must be an array or null");
        const tlSum = empty();
        for (const entry of b.timeline) {
          if (!Array.isArray(entry) || entry.length < 1 + fields.length) throw new Error("Invalid timeline entry structure");
          const ts = entry[0];
          if (ts !== null) {
            if (typeof ts !== "number" || !Number.isSafeInteger(ts)) throw new Error("Invalid timeline timestamp");
            if (b.day !== "unknown" && day(ts) !== b.day) {
              throw new Error(`Timeline timestamp day mismatch: ${day(ts)} vs bucket ${b.day}`);
            }
          }
          for (let i = 0; i < fields.length; i++) {
            const v = entry[1 + i];
            const k = fields[i];
            if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid timeline field ${k}`);
            tlSum[k] += v;
            if (!Number.isSafeInteger(tlSum[k])) throw new Error(`Timeline integer overflow for ${k}`);
          }
          const entryTotal = entry[1 + 4]; // totalTokens
          const entryComp = entry[1 + 0] + entry[1 + 1] + entry[1 + 2] + entry[1 + 3];
          if (entryTotal !== entryComp) throw new Error("Timeline entry token components do not reconcile");
        }
        for (const k of fields) {
          if (tlSum[k] !== b[k]) {
            throw new Error(`Timeline sum mismatch for ${k}: ${tlSum[k]} vs ${b[k]}`);
          }
        }
      }
    }
    const a = aggregate(ledger);
    for (const k of fields) {
      if (!Number.isSafeInteger(a[k]) || a[k] < 0) throw new Error(`Invalid aggregated total ${k}`);
      if (a[k] !== a.modelBreakdowns.reduce((s, m) => s + m[k], 0)) throw new Error(`Model mismatch: ${k}`);
      if (a[k] !== Object.values(a.roles).reduce((s, r) => s + r[k], 0)) throw new Error(`Role mismatch: ${k}`);
      if (ledger.totals && a[k] !== ledger.totals[k]) {
        // 成本与未定价属于派生核算字段（受 STANDARD_RATES 费率基准表与智能补价规则控制）
        // 只要底层物理 token 与记录计数量完全一致，允许平滑自愈对齐快照 totals，杜绝费率基准演进导致面板报错
        if (k === "costNano" || k === "unpricedTokens") {
          const tokensMatch = ledger.totals.totalTokens === a.totalTokens &&
                              ledger.totals.inputTokens === a.inputTokens &&
                              ledger.totals.outputTokens === a.outputTokens &&
                              ledger.totals.cacheReadTokens === a.cacheReadTokens;
          if (tokensMatch) {
            ledger.totals[k] = a[k];
            continue;
          }
        }
        throw new Error(`Snapshot mismatch: ${k}`);
      }
    }
    return a;
  }

  return { fields, empty, add, day, name, canonicalModel, STANDARD_RATES, aggregate, validate };
});
