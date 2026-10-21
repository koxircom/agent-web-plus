"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const readline = require("node:readline");
const crypto = require("node:crypto");
const core = require("./usage-ledger-core.js");
const {
  resolveAgentDir,
  resolveDefaultScriptsDir,
  resolveUsagePathsForLedger,
  acquireUsageLock,
  releaseUsageLock,
} = require("./usage-storage-paths.cjs");

const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

function atomicWrite(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value), "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) {}
    throw err;
  }
  if (process.platform === "win32") {
    return;
  }
  try {
    const dirFd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch (e) {
    const code = e && e.code;
    const ignorable = ["EINVAL", "EISDIR", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EBADF"];
    if (!code || !ignorable.includes(code)) {
      throw e;
    }
  }
}

function atomicWriteIfChanged(file, value) {
  const content = JSON.stringify(value);
  if (fs.existsSync(file)) {
    try {
      const existing = fs.readFileSync(file, "utf8");
      if (existing === content) {
        return false;
      }
    } catch (_) {}
  }
  atomicWrite(file, value);
  return true;
}

function deepClone(val) {
  if (val === null || typeof val !== "object") {
    return val;
  }
  if (Array.isArray(val)) {
    const copy = new Array(val.length);
    for (let i = 0; i < val.length; i++) {
      copy[i] = deepClone(val[i]);
    }
    return copy;
  }
  const copy = {};
  for (const k of Object.keys(val)) {
    copy[k] = deepClone(val[k]);
  }
  return copy;
}

function deepValueEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") {
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepValueEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepValueEqual(a[k], b[k])) return false;
  }
  return true;
}

function normalizeStateForComparison(state) {
  if (!state || typeof state !== "object") return state;
  const copy = deepClone(state);
  if (copy.sources && typeof copy.sources === "object") {
    for (const src of Object.keys(copy.sources)) {
      if (copy.sources[src] && typeof copy.sources[src] === "object") {
        delete copy.sources[src].scannedAt;
      }
    }
  }
  if (copy.sessions && typeof copy.sessions === "object") {
    for (const sid of Object.keys(copy.sessions)) {
      const sess = copy.sessions[sid];
      if (sess && typeof sess === "object" && sess.ingestion && typeof sess.ingestion === "object") {
        delete sess.ingestion.scannedAt;
      }
    }
  }
  return copy;
}

function normalizeLedgerForComparison(ledger) {
  if (!ledger || typeof ledger !== "object") return ledger;
  const copy = deepClone(ledger);
  delete copy.generatedAt;
  delete copy.snapshotId;
  if (copy.sources && typeof copy.sources === "object") {
    for (const src of Object.keys(copy.sources)) {
      if (copy.sources[src] && typeof copy.sources[src] === "object") {
        delete copy.sources[src].scannedAt;
      }
    }
  }
  if (copy.sessions && typeof copy.sessions === "object") {
    for (const sid of Object.keys(copy.sessions)) {
      const sess = copy.sessions[sid];
      if (sess && typeof sess === "object" && sess.ingestion && typeof sess.ingestion === "object") {
        delete sess.ingestion.scannedAt;
      }
    }
  }
  return copy;
}

function isStateBusinessEqual(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const normA = normalizeStateForComparison(a);
  const normB = normalizeStateForComparison(b);
  return deepValueEqual(normA, normB);
}

function isLedgerBusinessEqual(a, b) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const normA = normalizeLedgerForComparison(a);
  const normB = normalizeLedgerForComparison(b);
  return deepValueEqual(normA, normB);
}

function acquireLock(lockFile) {
  return acquireUsageLock(lockFile, { timeoutMs: 8000 });
}

function releaseLock(lockFile, fd = null) {
  releaseUsageLock(lockFile, fd);
}

function readState(file) {
  if (!fs.existsSync(file)) return { version: 2, events: {}, sessions: {}, sources: {} };
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  if (state.version !== 2 || !state.events) throw new Error(`Invalid private state: ${file}`);
  return state;
}

function scanFiles(dir) {
  // Only the explicit session business directory; never scan NAS runtime dirs.
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? scanFiles(path.join(dir, d.name)) : d.isFile() && d.name.endsWith(".jsonl") ? [path.join(dir, d.name)] : []);
}

function usageValues(usage, count = 1) {
  const n = key => {
    const v = usage?.[key] ?? 0;
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Invalid usage field ${key}`);
    return v;
  };
  const v = { ...core.empty(), inputTokens: n("input"), outputTokens: n("output"), cacheReadTokens: n("cacheRead"), cacheWriteTokens: n("cacheWrite"), records: count };
  v.totalTokens = v.inputTokens + v.outputTokens + v.cacheReadTokens + v.cacheWriteTokens;
  const cost = typeof usage?.cost === "number" ? usage.cost : usage?.cost?.total;
  if (cost != null && (!Number.isFinite(cost) || cost < 0)) throw new Error("Invalid SDK cost");
  v.costNano = Math.round((cost || 0) * 1e9);
  v.unpricedTokens = cost > 0 ? 0 : v.totalTokens;
  v.missingUsage = usage ? 0 : count;
  return v;
}

function modelOf(m, fallback = {}) {
  return { provider: m.provider || fallback.provider || "unknown", model: m.responseModel || m.model || fallback.model || "unknown" };
}

function resolveSystemModel(explicit = {}, lastAssistant = {}, current = {}) {
  const explicitModel = explicit.responseModel || explicit.model || explicit.modelId;
  if (explicitModel && explicitModel !== "unknown") {
    return {
      provider: explicit.provider || "unknown",
      model: explicitModel,
    };
  }
  if (lastAssistant && lastAssistant.model && lastAssistant.model !== "unknown") {
    return {
      provider: lastAssistant.provider || "unknown",
      model: lastAssistant.model,
    };
  }
  if (current && current.model && current.model !== "unknown") {
    return {
      provider: current.provider || "unknown",
      model: current.model,
    };
  }
  return {
    provider: explicit.provider || "unknown",
    model: "unknown",
  };
}

function messageKey(m, fallbackKey) {
  return hash(["message", m.timestamp || fallbackKey, m.provider, m.responseModel || m.model, m.responseId, m.content, m.usage]);
}

function putEvent(state, event) {
  const old = state.events[event.key];
  if (!old) {
    state.events[event.key] = { ...event };
    return;
  }

  const a = core.fields.map(k => old[k] || 0);
  const b = core.fields.map(k => event[k] || 0);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`Conflicting usage event ${event.key}`);
  }

  if (event.role === "subagent" && old.role !== "subagent") {
    Object.assign(old, event);
  }

  if (event.timestamp != null) {
    if (old.timestamp == null || old.timestamp !== event.timestamp) {
      old.timestamp = event.timestamp;
      old.day = core.day(event.timestamp);
    }
  }

  if ((!old.model || old.model === "unknown") && event.model && event.model !== "unknown") {
    old.model = event.model;
    if (event.provider && event.provider !== "unknown") {
      old.provider = event.provider;
    } else if (!old.provider || old.provider === "unknown") {
      old.provider = event.provider || "unknown";
    }
  }

  if (event.controllerResolved) {
    old.controllerModel = event.controllerModel;
    old.controllerProvider = event.controllerProvider;
    old.controllerResolved = true;
  } else if (event.controllerModel && !old.controllerModel) {
    old.controllerModel = event.controllerModel;
    old.controllerProvider = event.controllerProvider;
  }
}

function extractToolCalls(m) {
  const calls = new Map();
  if (Array.isArray(m?.toolCalls)) {
    for (const tc of m.toolCalls) {
      if (tc?.id) calls.set(tc.id, { id: tc.id, name: tc.name || "" });
    }
  }
  if (Array.isArray(m?.content)) {
    for (const part of m.content) {
      if (part?.id && (part.type === "toolCall" || part.type === "tool_call" || part.type === "toolUse" || part.type === "tool_use")) {
        calls.set(part.id, { id: part.id, name: part.name || "" });
      }
    }
  }
  return Array.from(calls.values());
}

const FORK_PROVENANCE_TYPE = "pi-web:fork-provenance";

async function scanSession(file, state, source, audit, options = {}) {
  let sessionId, current = {}, lastAssistant = {}, lineNo = 0, lastEntryId = null;
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
  const statBefore = fs.statSync(file);
  const initialPartial = audit.partialLines;
  const pendingToolCalls = new Set();
  const pendingSubagentCalls = new Set();
  const abandonedToolCalls = new Set();
  const toolCallControllers = new Map();
  let hasSessionHeader = false;
  let hasParentSession = false;
  let hasUnaccountedNestedUsage = false;

  let forkProvenance = null;
  const inheritedEntryIds = new Set();
  const entryOrigins = new Map();
  let parentSessionId = null;
  const deferredEmits = [];

  function applyProvenance(data) {
    if (!data || typeof data !== "object") return;
    forkProvenance = data;
    if (data.parentSessionId && typeof data.parentSessionId === "string") {
      parentSessionId = data.parentSessionId;
    }
    if (Array.isArray(data.inheritedEntryIds)) {
      for (const id of data.inheritedEntryIds) {
        if (typeof id === "string" && id) inheritedEntryIds.add(id);
      }
    }
    if (data.entryOrigins && typeof data.entryOrigins === "object") {
      for (const [id, orig] of Object.entries(data.entryOrigins)) {
        if (orig && typeof orig.sessionId === "string") {
          entryOrigins.set(id, orig);
        }
      }
    }
  }

  function flushDeferredEmits() {
    while (deferredEmits.length > 0) {
      const emit = deferredEmits.shift();
      emit();
    }
  }

  function scheduleOrEmit(emitFn) {
    if (hasParentSession) {
      deferredEmits.push(emitFn);
    } else {
      emitFn();
    }
  }

  const stream = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  let pending = null;
  async function processLine(line, final = false) {
    lineNo++;
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); }
    catch (err) {
      if (final) { audit.partialLines++; return; }
      throw new Error(`${path.basename(file)}:${lineNo}: malformed JSON`);
    }
    if (e.type === "session") {
      sessionId = e.id;
      if (!sessionId) throw new Error("Session header missing id");
      hasSessionHeader = true;
      hasParentSession = Boolean(e.parentSession);
      const old = state.sessions[sessionId] || {};
      state.sessions[sessionId] = {
        ...old,
        id: sessionId,
        title: old.title || (e.name || sessionId.slice(0, 12)),
        sources: [...new Set([...(old.sources || []), source])],
        availableOn: [...new Set([...(old.availableOn || []), source])],
      };
      return;
    }
    if (!hasSessionHeader || !sessionId) throw new Error("Missing session header");
    if (e.id) lastEntryId = e.id;
    if (e.type === "session_info" && e.name) state.sessions[sessionId].title = e.name;
    if (e.type === "model_change") current = { provider: e.provider, model: e.modelId };
    if (e.type === "custom" && e.customType === FORK_PROVENANCE_TYPE) {
      applyProvenance(e.data);
      return;
    }
    const eTs = (typeof e.timestamp === "number" ? e.timestamp : (e.timestamp ? Date.parse(e.timestamp) : null)) || null;
    const base = { sessionId, source, day: core.day(eTs || e.timestamp) };
    const m = e.message;
    if (e.type === "message" && m?.role === "user") {
      if (pendingToolCalls.size > 0) {
        for (const id of pendingToolCalls) abandonedToolCalls.add(id);
        pendingToolCalls.clear();
      }
    } else if (e.type === "message" && m?.role === "assistant") {
      lastAssistant = modelOf(m, current);
      const mTs = (typeof m.timestamp === "number" ? m.timestamp : (m.timestamp ? Date.parse(m.timestamp) : null)) || null;
      const eventTs = mTs || eTs;
      const tcCalls = extractToolCalls(m);
      const isExplicitStop = (m.stopReason === "stop" || m.stopReason === "end_turn") && tcCalls.length === 0;
      if (isExplicitStop && pendingToolCalls.size > 0) {
        for (const id of pendingToolCalls) abandonedToolCalls.add(id);
        pendingToolCalls.clear();
      }
      for (const tc of tcCalls) {
        toolCallControllers.set(tc.id, lastAssistant);
        if (tc.name === "subagent") {
          pendingSubagentCalls.add(tc.id);
        } else {
          pendingToolCalls.add(tc.id);
        }
      }

      const assistantModel = { ...lastAssistant };
      const entryId = e.id;
      const msgUsage = m.usage;
      const msgContent = m.content;
      const msgTimestamp = m.timestamp;
      const msgProvider = m.provider;
      const msgResponseModel = m.responseModel || m.model;
      const msgResponseId = m.responseId;

      scheduleOrEmit(() => {
        const isInherited = Boolean(entryId && inheritedEntryIds.has(entryId));
        const origin = isInherited
          ? (entryOrigins.get(entryId) || (parentSessionId ? { sessionId: parentSessionId } : null))
          : null;
        const targetSid = origin?.sessionId || sessionId;
        const targetBase = { sessionId: targetSid, source, day: core.day(eventTs || eTs) };
        const eventKey = hash([
          "message",
          msgTimestamp || [targetSid, entryId],
          msgProvider,
          msgResponseModel,
          msgResponseId,
          msgContent,
          msgUsage,
        ]);

        putEvent(state, {
          ...targetBase,
          ...assistantModel,
          ...usageValues(msgUsage),
          timestamp: eventTs,
          day: core.day(eventTs),
          key: eventKey,
          role: "main",
          messageCount: 1,
        });
        if (!isInherited) {
          audit.assistant++;
        }
      });
    } else if (e.type === "message" && m?.role === "toolResult") {
      if (m.toolCallId) {
        pendingToolCalls.delete(m.toolCallId);
        pendingSubagentCalls.delete(m.toolCallId);
        abandonedToolCalls.delete(m.toolCallId);
      }
      if (m.toolName === "subagent" && Array.isArray(m.details?.results)) {
        const entryId = e.id;
        const toolCallId = m.toolCallId;
        const detailsResults = m.details.results;
        const ctrlInfo = (toolCallId && toolCallControllers.get(toolCallId)) || null;
        const ctrlModel = ctrlInfo ? ctrlInfo.model : "";
        const ctrlProvider = ctrlInfo ? ctrlInfo.provider : "";
        const controllerResolved = Boolean(ctrlInfo);
        const lastAssocAssistant = { ...lastAssistant };

        scheduleOrEmit(() => {
          const isInherited = Boolean(entryId && inheritedEntryIds.has(entryId));
          const origin = isInherited
            ? (entryOrigins.get(entryId) || (parentSessionId ? { sessionId: parentSessionId } : null))
            : null;
          const targetSid = origin?.sessionId || sessionId;
          const targetBase = { sessionId: targetSid, source, day: core.day(eTs || e.timestamp) };
          const seenResults = new Set();

          for (const [i, r] of detailsResults.entries()) {
            const taskKey = hash(["task", toolCallId || entryId, i, r.agent, r.step]);
            if (seenResults.has(taskKey)) continue;
            seenResults.add(taskKey);
            const parts = String(r.model || "unknown").split("/");
            const fallback = {
              provider: parts.length > 1 ? parts.shift() : "unknown",
              model: parts.join("/"),
            };
            const rawMsgs = Array.isArray(r.messages) ? r.messages : [];
            for (const rawMsg of rawMsgs) {
              if (!rawMsg || typeof rawMsg !== "object" || !rawMsg.role) {
                audit.unknownWrappers = (audit.unknownWrappers || 0) + 1;
              }
              if (rawMsg && typeof rawMsg === "object" && rawMsg.role !== "assistant" && rawMsg.usage) {
                const u = rawMsg.usage;
                const uTokens = usageValues(u).totalTokens;
                if (uTokens > 0) {
                  if (!audit.unaccountedNestedUsage) audit.unaccountedNestedUsage = { count: 0, tokens: 0 };
                  audit.unaccountedNestedUsage.count++;
                  audit.unaccountedNestedUsage.tokens += uTokens;
                  hasUnaccountedNestedUsage = true;
                }
              }
            }
            const messages = rawMsgs.filter((x) => x && x.role === "assistant");
            const totals = messages.reduce((a, x) => core.add(a, usageValues(x.usage)), core.empty());
            const declared = usageValues(r.usage);
            if (messages.length) {
              for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costNano"]) {
                if (Math.abs(totals[k] - declared[k]) > (k === "costNano" ? messages.length : 0)) {
                  throw new Error(`Subagent detail mismatch ${k}: ${taskKey}`);
                }
              }
              if (r.usage?.turns != null && messages.length !== r.usage.turns) {
                throw new Error(`Subagent turn mismatch: ${taskKey}`);
              }
              for (const [j, child] of messages.entries()) {
                const childTs =
                  (typeof child.timestamp === "number"
                    ? child.timestamp
                    : child.timestamp
                      ? Date.parse(child.timestamp)
                      : null) || eTs;
                putEvent(state, {
                  ...targetBase,
                  ...modelOf(child, fallback),
                  controllerModel: ctrlModel,
                  controllerProvider: ctrlProvider,
                  controllerResolved,
                  ...usageValues(child.usage),
                  key: messageKey(child, [taskKey, j]),
                  role: "subagent",
                  agent: r.agent || "unknown",
                  taskKey,
                  timestamp: childTs,
                  day: core.day(childTs),
                  messageCount: 1,
                });
              }
            } else {
              putEvent(state, {
                ...targetBase,
                ...fallback,
                controllerModel: ctrlModel,
                controllerProvider: ctrlProvider,
                controllerResolved,
                ...declared,
                key: `${taskKey}:aggregate`,
                role: "subagent",
                agent: r.agent || "unknown",
                taskKey,
                timestamp: eTs,
                day: core.day(eTs),
                messageCount: r.usage?.turns ?? 0,
              });
              if (declared.totalTokens && !isInherited) audit.aggregateOnlyTasks++;
            }
            const actual = messages[0] ? modelOf(messages[0], fallback) : fallback;
            putEvent(state, {
              ...targetBase,
              ...actual,
              controllerModel: ctrlModel,
              controllerProvider: ctrlProvider,
              controllerResolved,
              ...core.empty(),
              key: taskKey,
              role: "subagent",
              agent: r.agent || "unknown",
              taskKey,
              timestamp: eTs,
              day: core.day(eTs),
              calls: 1,
            });
            if (!isInherited) {
              audit.subagentResults++;
            }
          }
        });
      } else if (m.usage) {
        const ctrlInfo = (m.toolCallId && toolCallControllers.get(m.toolCallId)) || null;
        const ctxAssistant = ctrlInfo || lastAssistant;
        const sysModel = resolveSystemModel(
          { provider: m?.provider || e.provider, model: m?.responseModel || m?.model || e.responseModel || e.model },
          ctxAssistant,
          current,
        );
        const entryId = e.id;
        const entryTs = e.timestamp;
        const toolResultUsage = m.usage;

        scheduleOrEmit(() => {
          const isInherited = Boolean(entryId && inheritedEntryIds.has(entryId));
          const origin = isInherited
            ? (entryOrigins.get(entryId) || (parentSessionId ? { sessionId: parentSessionId } : null))
            : null;
          const targetSid = origin?.sessionId || sessionId;
          const targetBase = { sessionId: targetSid, source, day: core.day(eTs || entryTs) };

          putEvent(state, {
            ...targetBase,
            ...sysModel,
            ...usageValues(toolResultUsage),
            timestamp: eTs,
            day: core.day(eTs),
            key: hash(["system", entryId, entryTs, toolResultUsage]),
            role: "system",
          });
          if (!isInherited) {
            audit.system++;
          }
        });
      }
    } else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
      const explicit = {
        provider: e.provider || m?.provider,
        model: e.responseModel || e.model || e.modelId || m?.responseModel || m?.model,
      };
      const sysModel = resolveSystemModel(explicit, lastAssistant, current);
      const entryId = e.id;
      const entryTs = e.timestamp;
      const compUsage = e.usage;

      scheduleOrEmit(() => {
        const isInherited = Boolean(entryId && inheritedEntryIds.has(entryId));
        const origin = isInherited
          ? (entryOrigins.get(entryId) || (parentSessionId ? { sessionId: parentSessionId } : null))
          : null;
        const targetSid = origin?.sessionId || sessionId;
        const targetBase = { sessionId: targetSid, source, day: core.day(eTs || entryTs) };

        putEvent(state, {
          ...targetBase,
          ...sysModel,
          ...usageValues(compUsage),
          timestamp: eTs,
          day: core.day(eTs),
          key: hash(["system", entryId, entryTs, compUsage]),
          role: "system",
        });
        if (!isInherited) {
          audit.system++;
        }
      });
    }
  }
  for await (const line of stream) {
    if (pending !== null) await processLine(pending);
    pending = line;
  }
  if (pending !== null) await processLine(pending, true);

  flushDeferredEmits();

  if (!hasSessionHeader || !sessionId) {
    throw new Error(`Empty or missing session header: ${path.basename(file)}`);
  }

  let statAfter = null;
  try {
    if (fs.existsSync(file)) {
      statAfter = fs.statSync(file);
    }
  } catch (e) {
    statAfter = null;
  }

  const filePartialLines = audit.partialLines - initialPartial;

  const isSessionQuiet = Boolean(
    statAfter &&
    statBefore.mtimeMs === statAfter.mtimeMs &&
    statBefore.size === statAfter.size &&
    (options.sealForDelete === true ||
     (Array.isArray(options.runningSessionIds) && !options.runningSessionIds.includes(sessionId)) ||
     (Date.now() - statAfter.mtimeMs > 15000))
  );

  if (isSessionQuiet && (pendingToolCalls.size > 0 || pendingSubagentCalls.size > 0)) {
    for (const id of pendingToolCalls) abandonedToolCalls.add(id);
    for (const id of pendingSubagentCalls) abandonedToolCalls.add(id);
    pendingToolCalls.clear();
    pendingSubagentCalls.clear();
  }

  audit.pendingSubagentCalls = (audit.pendingSubagentCalls || 0) + pendingSubagentCalls.size;
  audit.abandonedToolCalls = (audit.abandonedToolCalls || 0) + abandonedToolCalls.size;
  const complete = Boolean(
    statAfter &&
    statBefore.mtimeMs === statAfter.mtimeMs &&
    statBefore.size === statAfter.size &&
    filePartialLines === 0 &&
    pendingToolCalls.size === 0 &&
    pendingSubagentCalls.size === 0 &&
    !hasUnaccountedNestedUsage
  );
  if (sessionId && state.sessions[sessionId]) {
    state.sessions[sessionId].ingestion = {
      source,
      scannedAt: new Date().toISOString(),
      mtimeMs: statAfter ? statAfter.mtimeMs : null,
      size: statAfter ? statAfter.size : null,
      lastEntryId,
      pendingToolCalls: pendingToolCalls.size,
      pendingSubagentCalls: pendingSubagentCalls.size,
      abandonedToolCalls: abandonedToolCalls.size,
      complete,
    };
  }
}

function mergeStates(states) {
  const out = { version: 2, events: {}, sessions: {}, sources: {} };
  for (const s of states) {
    Object.assign(out.sources, s.sources);
    for (const e of Object.values(s.events)) putEvent(out, e);
    for (const [id, rec] of Object.entries(s.sessions)) {
      const old = out.sessions[id];
      out.sessions[id] = {
        ...rec,
        sources: [...new Set([...(old?.sources || []), ...rec.sources])],
        availableOn: [...new Set([...(old?.availableOn || []), ...rec.availableOn])],
        ingestion: rec.ingestion || old?.ingestion,
      };
    }
  }
  return out;
}

function buildLedger(state, legacy = null) {
  const bucketsMap = new Map();
  for (const rawE of Object.values(state.events)) {
    let e = rawE;
    if ((e.costNano || 0) === 0 && (e.totalTokens || 0) > 0) {
      const c = core.canonicalModel(e.model, e.provider, e.role);
      const rate = core.STANDARD_RATES[c.key];
      if (rate) {
        const estUsd = ((e.inputTokens || 0) * rate[0] +
                        (e.outputTokens || 0) * rate[1] +
                        (e.cacheReadTokens || 0) * rate[2] +
                        (e.cacheWriteTokens || 0) * rate[3]) / 1e6;
        e = {
          ...rawE,
          costNano: Math.round(estUsd * 1e9),
          unpricedTokens: 0,
        };
      }
    }
    const key = JSON.stringify([e.sessionId, e.day, e.role, e.provider, e.model, e.agent || "", e.controllerModel || ""]);
    if (!bucketsMap.has(key)) {
      bucketsMap.set(key, {
        ...core.empty(),
        sessionId: e.sessionId,
        day: e.day,
        role: e.role,
        provider: e.provider,
        model: e.model,
        agent: e.agent || "",
        controllerModel: e.controllerModel || "",
        _events: [],
      });
    }
    const b = bucketsMap.get(key);
    core.add(b, e);
    b._events.push(e);
  }
  const buckets = [];
  for (const b of bucketsMap.values()) {
    const events = b._events;
    delete b._events;
    events.sort((x, y) => {
      const xt = (typeof x.timestamp === "number" && Number.isFinite(x.timestamp)) ? x.timestamp : null;
      const yt = (typeof y.timestamp === "number" && Number.isFinite(y.timestamp)) ? y.timestamp : null;
      if (xt !== null && yt !== null) return xt - yt;
      if (xt !== null) return -1;
      if (yt !== null) return 1;
      return 0;
    });
    b.timeline = events.map(e => {
      const ts = (typeof e.timestamp === "number" && Number.isFinite(e.timestamp)) ? e.timestamp : null;
      return [ts, ...core.fields.map(k => e[k] || 0)];
    });
    buckets.push(b);
  }
  const unverifiedLegacy = Object.values(legacy?.unverifiedLegacy || legacy?.sessions || {}).filter(s => !state.sessions[s.id]).map(s => ({ id: s.id, title: s.title, totalTokens: s.totalTokens || 0, reason: "旧账本汇总无原始记录；未并入可核验总计" }));
  const ledger = { version: 2, generatedAt: new Date().toISOString(), timezone: "Asia/Shanghai", costBasis: "SDK记录值优先，非实际账单；SDK 零费率按 Pi SDK 模型目录基准精确补价，未知模型保持未定价", sources: state.sources, sessions: state.sessions, buckets, unverifiedLegacy };
  const a = core.aggregate(ledger);
  ledger.totals = Object.fromEntries(core.fields.map(k => [k, a[k]]));
  ledger.snapshotId = hash([ledger.sources, ledger.sessions, ledger.buckets]).slice(0, 16);
  core.validate(ledger);
  return ledger;
}

async function generateUsageLedger(options = {}) {
  const agentDir = resolveAgentDir();
  const scriptsDir = resolveDefaultScriptsDir();
  const resolvedPaths = resolveUsagePathsForLedger(options, scriptsDir);
  const source = resolvedPaths.source;
  const stateFile = resolvedPaths.stateFile;
  const outputFile = resolvedPaths.outputFile;
  const lockFile = resolvedPaths.lockFile;
  const root = options.sessionsRoot || process.env.PI_SESSIONS_DIR || path.join(agentDir, "sessions");

  const lockFd = acquireLock(lockFile);
  try {
    let oldState = null;
    if (fs.existsSync(stateFile)) {
      try {
        oldState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (oldState.version !== 2 || !oldState.events) oldState = null;
      } catch (_) {
        oldState = null;
      }
    }

    const state = readState(stateFile);
    for (const s of Object.values(state.sessions)) s.availableOn = s.availableOn.filter(x => x !== source);
    const audit = { assistant: 0, subagentResults: 0, system: 0, partialLines: 0, aggregateOnlyTasks: 0, abandonedToolCalls: 0 };
    const files = scanFiles(root);
    const colleagueRoot = options.colleagueSessionsRoot !== undefined
      ? options.colleagueSessionsRoot
      : (!options.sessionsRoot ? path.join(agentDir, "colleague-sessions") : null);
    if (colleagueRoot && fs.existsSync(colleagueRoot) && colleagueRoot !== root) {
      try {
        const colleagueFiles = scanFiles(colleagueRoot);
        files.push(...colleagueFiles);
      } catch (_) {}
    }
    files.sort();
    for (const file of files) await scanSession(file, state, source, audit, options);
    state.sources[source] = { scannedAt: new Date().toISOString(), fileCount: files.length, audit };
    let oldLedger = null;
    if (fs.existsSync(outputFile)) {
      try {
        oldLedger = JSON.parse(fs.readFileSync(outputFile, "utf8"));
      } catch (_) {
        oldLedger = null;
      }
    }

    const isStateEqual = Boolean(oldState && isStateBusinessEqual(state, oldState));
    if (isStateEqual) {
      for (const src of Object.keys(oldState.sources || {})) {
        if (state.sources[src] && oldState.sources[src]?.scannedAt) {
          state.sources[src].scannedAt = oldState.sources[src].scannedAt;
        }
      }
      for (const sid of Object.keys(oldState.sessions || {})) {
        if (state.sessions[sid]?.ingestion && oldState.sessions[sid]?.ingestion?.scannedAt) {
          state.sessions[sid].ingestion.scannedAt = oldState.sessions[sid].ingestion.scannedAt;
        }
      }
    }

    let ledger = buildLedger(state);
    let canReuseOldLedger = false;
    if (isStateEqual && oldLedger) {
      try {
        core.validate(oldLedger);
        const expectedOldSnapshotId = hash([oldLedger.sources, oldLedger.sessions, oldLedger.buckets]).slice(0, 16);
        if (oldLedger.snapshotId === expectedOldSnapshotId && isLedgerBusinessEqual(ledger, oldLedger)) {
          canReuseOldLedger = true;
        }
      } catch (_) {
        canReuseOldLedger = false;
      }
    }

    if (canReuseOldLedger) {
      ledger.generatedAt = oldLedger.generatedAt;
      ledger.snapshotId = oldLedger.snapshotId;
    }

    if (options.write !== false) {
      atomicWriteIfChanged(stateFile, state);
      atomicWriteIfChanged(outputFile, ledger);
    }
    console.log(`[usage] ${source}: ${files.length} files, ${Object.keys(state.events).length} retained events; ${ledger.totals.totalTokens} tokens`);
    return { state, ledger };
  } finally {
    releaseLock(lockFile, lockFd);
  }
}

if (require.main === module) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = ({ "--source": "source", "--state": "stateFile", "--output": "outputFile", "--sessions": "sessionsRoot" })[args[i]];
    if (!key || !args[i + 1]) throw new Error(`Invalid argument ${args[i]}`);
    options[key] = args[i + 1];
  }
  generateUsageLedger(options).catch(e => { console.error(e); process.exitCode = 1; });
}

module.exports = {
  generateUsageLedger,
  scanSession,
  mergeStates,
  buildLedger,
  usageValues,
  messageKey,
  atomicWrite,
  atomicWriteIfChanged,
  readState,
  putEvent,
  isStateBusinessEqual,
  isLedgerBusinessEqual,
};
