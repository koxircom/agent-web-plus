import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jitiSource = async (url) => (await readFile(url, "utf8")).replace(/\r\n/g, "\n");
const source = await jitiSource(new URL("./useAgentSession.ts", import.meta.url));
const chatWindowSource = await jitiSource(new URL("../components/ChatWindow.tsx", import.meta.url));
const chatInputSource = await jitiSource(new URL("../components/ChatInput.tsx", import.meta.url));
const appShellSource = await jitiSource(new URL("../components/AppShell.tsx", import.meta.url));

// Evaluate the actual callback/prop, rather than require an incidental source
// spelling or a text slice that can include an unrelated effect.
const hookFile = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
const chatFile = ts.createSourceFile("chat.tsx", chatWindowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(file, predicate) {
  const matches = [];
  const visit = (node) => {
    if (predicate(node)) matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.equal(matches.length, 1, "Expected exactly one source contract");
  return matches[0];
}
function evaluate(node, file, scope) {
  const js = ts.transpileModule(`(${node.getText(file)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText.trim().replace(/;$/, "");
  return new Function("scope", `with (scope) { return ${js}; }`)(scope);
}
function callback(name, scope, file = hookFile) {
  const declaration = findNode(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === name);
  return evaluate(declaration.initializer.arguments[0], file, scope);
}
function messageViewProp(name, scope) {
  const attr = findNode(chatFile, (node) => ts.isJsxAttribute(node)
    && node.name.text === name && node.parent.parent.tagName?.getText(chatFile) === "MessageView");
  return evaluate(attr.initializer.expression, chatFile, scope);
}
const jiti = createJiti(import.meta.url);
const { getToolExecutionProgress } = await jiti.import("../lib/tool-execution-progress.ts");
const { completeActiveToolResult, getToolPublicStatus } = await jiti.import("../lib/tool-public-status.ts");
const { isNestedToolExecutionEvent, isSystemMessageEvent } = await jiti.import("../lib/agent-event-wire.ts");
const { markLatestAssistantRetryAttempt } = await jiti.import("../lib/message-display.ts");
const queueHelpers = await jiti.import("../lib/extension-ui-queue.ts");
const promptRecovery = await jiti.import("../lib/prompt-recovery.ts");
const ref = (current) => ({ current });
const noop = () => {};
function hookHarness() {
  const state = { messages: [], activeToolResults: new Map(), phase: null, retryInfo: null, dialogs: [], custom: [], restores: [], commands: [], reconciles: [], settlements: [], closes: 0 };
  const setter = (key) => (value) => { state[key] = typeof value === "function" ? value(state[key]) : value; };
  const scope = {
    ...queueHelpers, ...promptRecovery, sessionIdRef: ref("session"), session: { id: "session" },
    agentRunningRef: ref(false), bashRunningRef: ref(false), promptRunIdRef: ref(0), agentStateRevisionRef: ref(0), extensionUiRevisionRef: ref(0),
    rpcPromptPendingRef: ref(false), optimisticUserMessageRef: ref(null), preparationRef: ref(null),
    entryIdsRef: ref([]), pendingScrollToUserRef: ref(false), ensuringNewSessionRef: ref(null),
    isNew: false, newSessionCwd: null, composerDraftKey: "draft", newSessionDraftKey: null,
    setMessages: setter("messages"), setAgentPhase: setter("phase"), setRetryInfo: setter("retryInfo"), setActiveToolResults: setter("activeToolResults"),
    setExtensionDialogs: setter("dialogs"), setExtensionCustomUis: setter("custom"),
    setAgentRunning: noop, setPromptAnchorActive: noop, setPromptScrollRevision: noop, setStopRequested: noop, dispatch: noop,
    markOptimisticUserMessage: noop, bumpSessionEpoch: noop, cancelEventStreamGrace: noop, addNotice: noop,
    invalidatesSessionHistory: () => false, normalizeToolCalls: (value) => value,
    isSystemMessageEvent, isNestedToolExecutionEvent, CODEMODE_TOOL_NAME: "codemode",
    getToolExecutionProgress, completeActiveToolResult, markLatestAssistantRetryAttempt,
    isPromptRejectedError: (error) => error.code === "rejected",
    waitForPromptPreparation: (operation) => operation,
    ensureEventsConnected: async () => {}, loadSession: async () => {},
    closeEvents: () => { state.closes++; },
    restoreSubmission: (...args) => state.restores.push(args),
    reconcileAgentState: async (...args) => { state.reconciles.push(args); },
    waitForPromptSettlement: async (...args) => { state.settlements.push(args); },
    sendAgentCommand: async (...args) => { state.commands.push(args); },
    isBlockingExtensionUiRequest: () => true, onAttentionNeeded: noop,
  };
  scope.handleExtensionUiRequest = callback("handleExtensionUiRequest", scope);
  scope.handleAgentEvent = callback("handleAgentEvent", scope);
  return { state, scope };
}

test("auto retry turns the completed provider failure into a non-terminal attempt", () => {
  const { scope, state } = hookHarness();
  state.messages = [{
    role: "assistant",
    provider: "openai-codex-responses",
    model: "gpt-6.1-sol",
    content: [],
    stopReason: "error",
    errorMessage: "Codex error: temporary upstream failure",
  }];

  scope.handleAgentEvent({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    errorMessage: "temporary upstream failure",
  });

  assert.equal(state.messages[0].retryAttempt, true);
  assert.deepEqual(state.retryInfo, {
    attempt: 1,
    maxAttempts: 3,
    errorMessage: "temporary upstream failure",
  });

  scope.handleAgentEvent({ type: "auto_retry_end" });
  assert.equal(state.retryInfo, null);
});

test("only an authoritative pending-ID snapshot supersedes the fast interaction read", () => {
  const { scope } = hookHarness();
  scope.handleAgentEvent({ type: "connected", isStreaming: false });
  assert.equal(scope.extensionUiRevisionRef.current, 0, "dormant SSE proxy has no pending-request knowledge");
  scope.handleAgentEvent({ type: "connected", isStreaming: false, pendingExtensionUiIds: [] });
  assert.equal(scope.extensionUiRevisionRef.current, 1);
  scope.handleAgentEvent({ type: "extension_ui_request", id: "question", method: "select", title: "Choose", options: ["A"] });
  assert.equal(scope.extensionUiRevisionRef.current, 2);
  scope.handleAgentEvent({ type: "extension_ui_closed", id: "question" });
  assert.equal(scope.extensionUiRevisionRef.current, 3);
});

test("keeps the session event stream open through the idle grace window", async (t) => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => void checkServerIdle\(\), EVENT_STREAM_IDLE_GRACE_MS\)/);
  assert.match(graceSource, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`\)/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /notifyPromptStage\(promptRunIdRef\.current\)/);
  assert.match(promptDoneSource, /if \(!sdkAgentActiveRef\.current\) \{[\s\S]*?notifyPromptStage\(runId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(sendSource, /const definitivelyRejected = !promptRequestStarted/);
  assert.match(sendSource, /if \(!definitivelyRejected && sentSessionId\) \{[\s\S]*?waitForPromptSettlement/);
  t.mock.method(console, "error", noop);
  // Rejection describes this submission, not an unrelated run in this session.
  for (const outcome of ["rejected", "ambiguous", "before-dispatch", "no-session", "cancelled"]) {
    const { scope, state } = hookHarness();
    const error = Object.assign(new Error(outcome), { code: outcome });
    if (outcome === "no-session") scope.session = null;
    if (["before-dispatch", "cancelled"].includes(outcome)) {
      scope.ensureEventsConnected = async () => {
        if (outcome === "cancelled") scope.preparationRef.current.abort();
        throw error;
      };
    } else scope.sendAgentCommand = async () => { throw error; };
    await callback("handleSend", scope)("message");
    assert.equal(state.restores.length, outcome === "ambiguous" || outcome === "cancelled" ? 0 : 1, outcome);
    assert.equal(state.closes, outcome === "no-session" || outcome === "cancelled" ? 1 : 0, outcome);
    assert.deepEqual(state.reconciles, outcome === "rejected" || outcome === "before-dispatch" ? [["session"]] : [], outcome);
    assert.deepEqual(state.settlements, outcome === "ambiguous" ? [["session", 1]] : [], outcome);
    if (outcome === "cancelled") {
      assert.equal(state.commands[0][1].type, "retain_stopped_prompt");
      assert.equal(state.commands[0][1].message, "message");
    }
  }
  assert.doesNotMatch(
    sendSource,
    /rpcPromptPendingRef\.current = false;\s*agentRunningRef\.current = false;\s*closeEvents\(\)/,
  );
});

test("a rejected submission preserves a different run reported by the server", () => {
  const reconcileSource = source.slice(
    source.indexOf("  const reconcileAgentState = useCallback"),
    source.indexOf("  // Recovery net for missed SSE events"),
  );

  assert.match(reconcileSource, /sessionIdRef\.current !== sid/);
  assert.match(reconcileSource, /if \(busy\) \{[\s\S]*?sdkAgentActiveRef\.current = Boolean\(state\.isStreaming\)/);
  assert.match(reconcileSource, /rpcPromptPendingRef\.current = Boolean\(state\.isPromptRunning\)/);
  assert.match(reconcileSource, /if \(!agentRunningRef\.current\) return;[\s\S]*?finishPromptWithoutStream/);
});

test("opening System or Tools lazily starts a dormant session without sending a prompt", () => {
  const loadSystemInfoSource = source.slice(
    source.indexOf("  const loadSystemInfo = useCallback"),
    source.indexOf("  const loadSlashCommands = useCallback"),
  );
  const loaderEffectSource = source.slice(
    source.indexOf("  useEffect(() => {\n    onSystemInfoLoaderChange"),
    source.indexOf("  useEffect(() => {\n    if (!onBranchDataChange) return;"),
  );

  assert.match(loadSystemInfoSource, /sessionIdRef\.current \?\? await ensureNewSession\(\)/);
  assert.doesNotMatch(loadSystemInfoSource, /promoteNewSession\(\)/);
  assert.match(loadSystemInfoSource, /sendAgentCommand<AgentStateResponse>\(sid, \{ type: "get_state" \}\)/);
  assert.match(loadSystemInfoSource, /loadTools\(sid\)/);
  assert.doesNotMatch(loadSystemInfoSource, /type: "prompt"/);
  assert.match(loadSystemInfoSource, /setSystemPrompt\(state\.systemPrompt \?\? ""\)/);
  assert.match(loaderEffectSource, /onSystemInfoLoaderChange\?\.\(loadSystemInfo\)/);
  assert.match(loaderEffectSource, /onSystemInfoLoaderChange\?\.\(null\)/);
  assert.match(appShellSource, /onClick=\{\(\) => handleSystemInfoToggle\("system", mobile\)\}/);
  assert.match(appShellSource, /onClick=\{\(\) => handleSystemInfoToggle\("tools", mobile\)\}/);
  assert.match(appShellSource, /systemInfoLoaderRef\.current/);
  assert.doesNotMatch(appShellSource, /systemPrompt !== null \|\| systemInfoLoading/);
  assert.match(appShellSource, /const loadId = \+\+systemInfoLoadIdRef\.current/);
  assert.match(appShellSource, /systemInfoLoadIdRef\.current === loadId/);
  assert.match(
    appShellSource,
    /handleSystemInfoLoaderChange[\s\S]*?systemInfoLoadIdRef\.current \+= 1;[\s\S]*?setSystemInfoLoading\(false\)/,
  );
});

test("new-session promotion rekeys drafts before publishing the real session", () => {
  const promoteSource = source.slice(
    source.indexOf("  const promoteNewSession = useCallback"),
    source.indexOf("  const ensureNewSession = useCallback"),
  );

  assert.match(promoteSource, /draftKeyAliasesRef\.current\.set\(provisionalDraftKey, sid\)/);
  assert.match(promoteSource, /input\.rekeyDraft\(provisionalDraftKey, sid\)/);
  assert.ok(
    promoteSource.indexOf("input.rekeyDraft(provisionalDraftKey, sid)")
      < promoteSource.indexOf("onSessionCreated?.({"),
  );
  assert.match(promoteSource, /}, provisionalDraftKey\)/);
  assert.match(chatWindowSource, /draftKey=\{session\?\.id \?\? newSessionDraftKey \?\? undefined\}/);
});

test("fresh sessions use the preference while persisted and live sessions restore their selection", () => {
  const preferenceSource = source.slice(
    source.indexOf("  const setToolPresetState"),
    source.indexOf("  const scrollToBottom"),
  );
  const loadToolsSource = source.slice(
    source.indexOf("  const loadTools = useCallback"),
    source.indexOf("  const promoteNewSession"),
  );
  const changeSource = source.slice(
    source.indexOf("  const handleToolPresetChange = useCallback"),
    source.indexOf("  const scrollUserMsgToTop"),
  );

  assert.match(
    preferenceSource,
    /const existingSessionId = session\?\.id;[\s\S]*?useLayoutEffect\(\(\) => \{\s*if \(!existingSessionId && \(!isNew \|\| sessionIdRef\.current\)\) return;\s*setToolPresetState\(getPreferredToolPreset\(\)\)/,
  );
  assert.match(source, /if \(agentState\?\.running\) \{\s*loadTools\(session\.id\)/);
  assert.match(source, /d\.toolNames !== undefined \? getPresetFromToolNames\(d\.toolNames\) : CONFIGURED_TOOL_PRESET/);
  assert.match(changeSource, /setPreferredToolPreset\(preset\)/);
  assert.match(changeSource, /type: "set_tools",\s*\.\.\.\(toolNames !== undefined \? \{ toolNames \} : \{\}\),/);
  assert.match(changeSource, /activeSessionId !== sid \|\| result\?\.recreated/);
  assert.match(changeSource, /result\?\.recreated[\s\S]*?maintainEventsConnected\(activeSessionId\)/);
  assert.match(changeSource, /sessionIdRef\.current = activeSessionId/);
  assert.doesNotMatch(loadToolsSource, /setPreferredToolPreset/);
});

test("sessions the user never overrode follow pi's configured defaultTools (#700)", () => {
  const ensureSource = source.slice(
    source.indexOf("  const ensureNewSession = useCallback"),
    source.indexOf("  const loadSystemInfo = useCallback"),
  );
  const loadToolsSource = source.slice(
    source.indexOf("  const loadTools = useCallback"),
    source.indexOf("  const promoteNewSession"),
  );

  // A new session must omit toolNames entirely rather than pin pi-web's own preset.
  assert.match(ensureSource, /\.\.\.\(toolNames !== undefined \? \{ toolNames \} : \{\}\),/);
  assert.doesNotMatch(ensureSource, /^ +toolNames,$/m);
  assert.match(ensureSource, /sessionToolsPinnedRef\.current = toolNames !== undefined/);

  // An unpinned session keeps saying "configured" instead of borrowing whichever
  // preset its resolved tools happen to match.
  assert.match(
    loadToolsSource,
    /setToolPresetState\(sessionToolsPinnedRef\.current \? getPresetFromTools\(tools\) : CONFIGURED_TOOL_PRESET\)/,
  );
});

test("session mount probes external appends and interrupted hydration retries only once", () => {
  const loadSessionSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("sessionHookMountedRef.current = false"),
  );
  assert.match(loadSessionSource, /options\?: \{ force\?: boolean; streamRetry\?: boolean(?:; abortRetry\?: boolean)?(?:; signal\?: AbortSignal)?; resident\?: boolean \}/);
  assert.match(loadSessionSource, /!options\?\.streamRetry/);
  assert.match(loadSessionSource, /if \(ownsCurrentView\(\)\) void loadSession\(sid, true, includeState, \{ force: true, streamRetry: true \}\)/);
  assert.match(loadSessionSource, /options\?\.resident && !options.force/);
  assert.match(loadSessionSource, /force: options\?\.force \|\| Boolean\(options\?\.resident && !reuseResident\)/);
  // Cold misses still probe disk; certified resident views avoid history re-fetch.
  assert.match(loadSessionSource, /buildSessionSyncUrl\(\{[^}]*force: options\?\.force/);
  assert.match(loadSessionSource, /d\.wrapperRebuilt[\s\S]*?eventConnectionRef\.current\?\.close\(\)[\s\S]*?maintain\(sid\)/);
  assert.match(mountSource, /loadSession\(session\.id, !cached, true, \{ resident: true \}\)/);
  assert.match(source, /await loadSession\(sid\)/);
  assert.equal([...source.matchAll(/\{ force: true \}/g)].length, 1);
});

test("forking stays available during a run while in-session branch switches wait for it", () => {
  const forkSource = source.slice(
    source.indexOf("  const handleFork = useCallback"),
    source.indexOf("  const handleNavigate = useCallback"),
  );
  const leafChangeSource = source.slice(
    source.indexOf("  const handleLeafChange = useCallback"),
    source.indexOf("  const handleModelChange = useCallback"),
  );

  // Fork copies into a new file, so only a shell command blocks it; the
  // in-session edit still waits because pi refuses navigate_tree mid-run.
  assert.match(chatWindowSource, /onFork=\{bashRunning \|\| isNew \? undefined : handleFork\}/);
  const handleFork = noop;
  const handleNavigate = noop;
  // Editing is gated by navigation; its content callback need not disappear.
  for (const busy of [false, true]) {
    const scope = { bashRunning: false, isNew: false, sessionBusy: busy, handleFork, handleNavigate };
    assert.equal(messageViewProp("onFork", scope), handleFork);
    assert.equal(messageViewProp("onNavigate", scope), busy ? undefined : handleNavigate);
  }
  for (const blocked of [{ bashRunning: true, isNew: false }, { bashRunning: false, isNew: true }]) {
    assert.equal(messageViewProp("onFork", { ...blocked, handleFork }), undefined);
  }
  assert.match(chatWindowSource, /onAskInNewChat && quotedSelection\.sourceEntryId && !bashRunning &&/);
  assert.match(forkSource, /addNotice\(\{ type: "error", message:/);

  assert.match(leafChangeSource, /if \(bashRunningRef\.current \|\| agentRunningRef\.current \|\| isCompacting\) return;/);
  assert.match(source, /const branchSwitchLocked = agentRunning \|\| bashRunning \|\| isCompacting;/);
  assert.match(source, /onBranchDataChange\(data\?\.tree \?\? \[\], activeLeafId, handleLeafChange, branchSwitchLocked\)/);
  assert.match(appShellSource, /setBranchSwitchLocked\(locked\)/);
  assert.equal((appShellSource.match(/locked=\{branchSwitchLocked\}/g) ?? []).length, 2);
});

test("first user messages expose both branch actions and edit before their own entry", () => {
  const navigateSource = source.slice(
    source.indexOf("  const handleNavigate = useCallback"),
    source.indexOf("  const handleLeafChange = useCallback"),
  );

  assert.match(chatWindowSource, /onFork=\{bashRunning \|\| isNew \? undefined : handleFork\}/);
  assert.doesNotMatch(chatWindowSource, /idx === 0 && msg\.role === "user"/);
  assert.doesNotMatch(chatWindowSource, /prevAssistantEntryId/);
  assert.match(navigateSource, /type: "navigate_tree",\s*targetId: entryId/);
  assert.match(navigateSource, /await loadSession\(sid\)/);
});

test("an empty persisted session displays the model it will use on first send", () => {
  assert.match(
    source,
    /currentModel \?\? \(data\?\.context\.messages\.length === 0 \? newSessionDefaultModel : null\)/,
  );
  assert.match(source, /setNewSessionDefaultModel\(displayDefaultModel/);
});

test("the selector prefers the live wrapper model over persisted response metadata", () => {
  assert.match(source, /model\?: \{ provider: string; id: string \}/);
  assert.match(source, /const currentModel = currentModelOverride \?\? liveModel \?\? data\?\.context\.model \?\? pendingModel \?\? null/);
  assert.match(source, /syncLiveModel\(liveState\)/);
  assert.match(source, /syncLiveModel\(state\);[\s\S]*?const busy = data\.running/);
});

test("existing-session prompts rely on the persisted tool selection", () => {
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );
  const existingSessionPrompt = sendSource.slice(sendSource.indexOf("} else if (session)"));

  assert.match(existingSessionPrompt, /type: "prompt",\s*message,/);
  assert.doesNotMatch(existingSessionPrompt, /toolNames:/);
  assert.doesNotMatch(sendSource, /restoreSubmission, toolPreset\]\);/);
});

test("submission recovery updates live refs before a possible session rekey", () => {
  const restoreMethod = chatInputSource.slice(
    chatInputSource.indexOf("    restoreSubmission(text:"),
    chatInputSource.indexOf("    insertText(text:"),
  );

  assert.ok(
    restoreMethod.indexOf("valueRef.current = restoredDraft.value")
      < restoreMethod.indexOf("setValue((current) =>"),
  );
  assert.ok(
    restoreMethod.indexOf("attachedImagesRef.current = restoredImages")
      < restoreMethod.indexOf("setAttachedImages((current) =>"),
  );
});

test("stale fresh-session completion cannot replace the active composer", () => {
  const cwdChangeSource = appShellSource.slice(
    appShellSource.indexOf("  const handleCwdChange = useCallback"),
    appShellSource.indexOf("  const handleSelectSession = useCallback"),
  );
  const newSessionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleNewSession = useCallback"),
    appShellSource.indexOf("  // Global keyboard shortcuts"),
  );
  const createdSource = appShellSource.slice(
    appShellSource.indexOf("  const handleSessionCreated = useCallback"),
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
  );

  assert.match(newSessionSource, /const draftKey = `new:\$\{sessionId\}:\$\{cwd\}`/);
  assert.match(newSessionSource, /activeNewSessionDraftKeyRef\.current = draftKey/);
  assert.match(createdSource, /activeNewSessionDraftKeyRef\.current !== sourceDraftKey/);
  assert.match(cwdChangeSource, /const currentFreshCwd = newSessionCwd \?\? activeCwd/);
  assert.match(
    cwdChangeSource,
    /currentProject === newProject\s*&& \(selectedSession !== null \|\| currentFreshCwd === cwd\)/,
  );
  assert.match(cwdChangeSource, /if \(currentProject !== newProject\) \{[\s\S]*?setFileTabs\(\[\]\)/);
  assert.match(
    appShellSource,
    /useLayoutEffect\(\(\) => \{\s*activeNewSessionDraftKeyRef\.current = newSessionDraftKey;/,
  );
  assert.ok(
    createdSource.indexOf("activeNewSessionDraftKeyRef.current !== sourceDraftKey")
      < createdSource.indexOf("setSelectedSession(sessionWithProject)"),
  );
});

test("abandoned fresh-session drafts are cleared and cannot be recreated by late rejection", () => {
  const restoreSource = source.slice(
    source.indexOf("  const restoreSubmission = useCallback"),
    source.indexOf("  const sessionStats = useMemo"),
  );
  const mountSource = source.slice(
    source.indexOf("  // Load session on mount"),
    source.indexOf("  useEffect(() => {\n    onSystemPromptChange"),
  );

  assert.match(restoreSource, /!sessionHookMountedRef\.current[\s\S]*?!newSessionPromotedRef\.current/);
  assert.match(mountSource, /const abandonedDraftKey = isNew \? newSessionDraftKey : null/);
  assert.match(mountSource, /clearDraft\(abandonedDraftKey\)/);
});

test("streaming submissions cannot be stranded in an idle direct queue", async (t) => {
  t.mock.method(console, "error", noop);
  const images = [{ mimeType: "image/png", data: "image" }];
  for (const behavior of ["steer", "followUp"]) {
    for (const outcome of ["accepted", "rejected", "ambiguous", "before-dispatch", "no-session"]) {
      const { scope, state } = hookHarness();
      const order = [];
      const error = Object.assign(new Error(outcome), { code: outcome });
      scope.ensureEventsConnected = async () => {
        order.push("connect");
        if (outcome === "before-dispatch") throw error;
      };
      scope.sendAgentCommand = async (...args) => {
        order.push("prompt");
        state.commands.push(args);
        if (outcome !== "accepted") throw error;
        args[2].onPromptRegistered({ sessionId: "session", requestId: "request" });
      };
      if (outcome === "no-session") scope.sessionIdRef.current = null;
      let registered;
      await callback("sendStreamingPrompt", scope)("queued", behavior, images, (identity) => { registered = identity; });
      const dispatched = ["accepted", "rejected", "ambiguous"].includes(outcome);
      assert.equal(state.commands.length, dispatched ? 1 : 0, outcome);
      if (dispatched) {
        assert.deepEqual(order, ["connect", "prompt"]);
        assert.deepEqual(state.commands[0].slice(0, 2), ["session", {
          type: "prompt", message: "queued", streamingBehavior: behavior,
          images: [{ type: "image", mimeType: "image/png", data: "image" }],
        }]);
      }
      assert.deepEqual(state.restores, ["rejected", "before-dispatch", "no-session"].includes(outcome)
        ? [["queued", images, "draft"]] : [], outcome);
      assert.deepEqual(registered, outcome === "accepted" ? { sessionId: "session", requestId: "request", draftKey: "draft" } : undefined);
    }
  }
});

test("built-in clone switches to the independent child session", () => {
  const builtinSource = source.slice(
    source.indexOf("  const handleBuiltinSlashCommand"),
    source.indexOf("  // Let AgentSession.prompt decide atomically"),
  );

  assert.match(builtinSource, /case "clone"/);
  assert.match(builtinSource, /type: "clone",\s+leafId: activeLeafId/);
  assert.match(builtinSource, /agentRunningRef\.current \|\| bashRunningRef\.current/);
  assert.match(builtinSource, /onSessionForked\?\.\(result\.newSessionId\)/);
});

test("post-accept prompt errors do not duplicate the user submission", () => {
  const promptErrorSource = source.slice(
    source.indexOf('case "prompt_error"'),
    source.indexOf('case "extension_error"'),
  );

  assert.match(promptErrorSource, /addNotice/);
  assert.doesNotMatch(promptErrorSource, /restoreSubmission/);
});

test("delegates event stream readiness and keeps one running status row", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  assert.match(source, /new AgentEventConnection\(\{/);
  assert.match(source, /shouldMaintain: \(sid\)[\s\S]*?sessionIdRef\.current === sid/);
  assert.match(ensureSource, /eventConnectionRef\.current!\.ensureConnected\(sid\)/);
  assert.match(ensureSource, /eventConnectionRef\.current!\.maintain\(sid\)/);
  assert.match(chatWindowSource, /const hasStreamingContent = Boolean\(streamState\.streamingMessage\?\.content\.length\)/);
  assert.match(chatWindowSource, /streamState\.isStreaming && hasStreamingContent && streamState\.streamingMessage/);
  assert.match(chatWindowSource, /agentRunning && \(\s*<div data-pi-native-agent-status="true"/);
  assert.doesNotMatch(chatWindowSource, /agentRunning && !hasStreamingContent && agentPhase/);
  assert.match(chatWindowSource, /return null;/);
});

test("uses one absolute agent-readiness deadline instead of a five-second transport deadline", () => {
  assert.match(source, /EVENT_STREAM_READY_TIMEOUT_MS = 60_000/);
  assert.doesNotMatch(source, /EVENT_STREAM_OPEN_TIMEOUT_MS/);
});

test("uses server pagination state instead of guessing from rendered rows", () => {
  const loadContextSource = source.slice(
    source.indexOf("const loadContext = useCallback"),
    source.indexOf("const loadTools = useCallback"),
  );
  assert.match(source, /const \[hasEarlierMessages, setHasEarlierMessages\] = useState\(data\?\.context.hasMore \?\? false\)/);
  assert.match(source, /setHasEarlierMessages\(d\.context\.hasMore\)/);
  assert.match(source, /setHistoryCursor\(d\.context\.oldestEntryId\)/);
  assert.match(loadContextSource, /setData\(\(prev\) => \{[\s\S]*messages: \[\.\.\.d\.context\.messages, \.\.\.prev\.context\.messages\]/);
  assert.match(chatWindowSource, /const oldestId = historyCursor/);
  assert.doesNotMatch(chatWindowSource, /const oldestId = entryIds\[0\]/);
  assert.match(chatWindowSource, /if \(!hasEarlierMessages\) return/);
  assert.match(chatWindowSource, /const hasMore = startIndex > 0 \|\| hasEarlierMessages/);
  assert.doesNotMatch(chatWindowSource, /rendered\.length >= visibleCount/);
});

test("keeps the selected session warm while idle and renews its lease", () => {
  assert.match(source, /sessionRunning\?: boolean/);
  assert.match(
    source,
    /const sid = session\?\.id;[\s\S]*?if \(!sid \|\| data\?\.sessionId !== sid\) return;[\s\S]*?maintainEventsConnected\(sid\)/,
  );
  assert.match(source, /sessionPropIdRef\.current === sid/);
  assert.match(source, /SESSION_LEASE_RENEW_INTERVAL_MS = 30_000/);
  assert.match(source, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}\/lease`/);
  assert.match(source, /setInterval\(\(\) => void renewLease\(\), SESSION_LEASE_RENEW_INTERVAL_MS\)/);
  assert.match(source, /result\.renewed === 0[\s\S]*?closeEvents\(\)[\s\S]*?maintainEventsConnected\(sid\)/);
  assert.match(source, /if \(sessionPropIdRef\.current === sid\) \{[\s\S]*?cancelEventStreamGrace\(\);[\s\S]*?return;/);
  assert.match(source, /maintainEventsConnected\(sid\)/);
  assert.doesNotMatch(source, /void connectEvents\(/);
  assert.match(chatWindowSource, /sessionRunning\?: boolean/);
  assert.match(chatWindowSource, /session, sessionRunning, newSessionCwd/);
  assert.match(appShellSource, /runningSessionIds\.has\(selectedSession\.id\)/);
  assert.match(appShellSource, /onRunningSessionIdsChange=\{handleRunningSessionIdsChange\}/);
});

test("opens the selected session's event stream even when Strict Mode re-runs effects", () => {
  // Strict Mode re-runs effects in declaration order after a simulated
  // unmount. The mount-only effect's cleanup flips sessionHookMountedRef to
  // false and only restores it when it re-runs, which happens after the
  // warm-session effect. That effect must therefore re-assert the ref itself
  // or shouldMaintain() refuses to open the stream on mount and on every
  // switch back to a running session.
  const warmSource = source.slice(
    source.indexOf("  // Keep the selected session warm even while its agent is idle."),
    source.indexOf("    const renewLease = async () => {"),
  );
  assert.match(warmSource, /sessionHookMountedRef\.current = true;\s*maintainEventsConnected\(sid\);/);
  assert.ok(
    warmSource.indexOf("sessionHookMountedRef.current = true;")
      < warmSource.indexOf("maintainEventsConnected(sid);"),
  );
  const mountSource = source.slice(
    source.indexOf("  useEffect(() => {\n    sessionHookMountedRef.current = true;"),
    source.indexOf("  useEffect(() => {\n    onSystemPromptChange?.(systemPrompt);"),
  );
  assert.match(mountSource, /return \(\) => \{\s*sessionHookMountedRef\.current = false;/);
  assert.match(mountSource, /closeEvents\(\);\s*\};\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\s*\}, \[\]\);/);
});

test("keeps one reducer-owned assistant partial and consumes Pi JSON deltas", () => {
  const connectedSource = source.slice(
    source.indexOf('case "connected"'),
    source.indexOf('case "agent_start"'),
  );
  const streamSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const messageEndSource = source.slice(
    source.indexOf('case "message_end"'),
    source.indexOf('case "tool_execution_start"'),
  );

  assert.match(source, /streamReducer,[\s\S]*type ClientAssistantMessageEvent/);
  assert.doesNotMatch(source, /streamingMessageRef/);
  assert.match(connectedSource, /dispatch\(\{ type: "end" \}\)/);
  assert.match(connectedSource, /event\.isStreaming === true/);
  assert.match(connectedSource, /agentRunningRef\.current = true/);
  assert.match(streamSource, /msg\?\.role === "assistant"[\s\S]*dispatch\(\{ type: "snapshot", message: msg \}\)/);
  assert.match(streamSource, /event\.assistantMessageEvent as ClientAssistantMessageEvent/);
  assert.match(streamSource, /dispatch\(\{ type: "delta", event: delta \}\)/);
  assert.match(streamSource, /delta\.type !== "toolcall_start" && delta\.type !== "toolcall_delta"/);
  assert.doesNotMatch(streamSource, /case "message_delta"/);
  assert.match(messageEndSource, /const completed = event\.message as AgentMessage/);
  // Transcript system messages (Pi >= 0.86 prompt and tool loadout) never enter the chat.
  assert.match(streamSource, /if \(isSystemMessageEvent\(event\)\) break;/);
  assert.match(messageEndSource, /if \(isSystemMessageEvent\(event\)\) break;/);
  assert.match(messageEndSource, /normalizeToolCalls\(completed\)/);
  assert.match(messageEndSource, /dispatch\(\{ type: "end" \}\)/);
  assert.doesNotMatch(messageEndSource, /streamState\.streamingMessage/);
});

test("restoring a running session does not clear an SSE snapshot", () => {
  const mountSource = source.slice(
    source.indexOf("// Load session on mount"),
    source.indexOf("useEffect(() => {\n    onSystemPromptChange"),
  );

  assert.match(mountSource, /dispatch\(\{ type: "resume" \}\)/);
  assert.doesNotMatch(mountSource, /dispatch\(\{ type: "start" \}\)/);
});

test("tracks tool execution progress privately and shows public tool outcomes", () => {
  const { scope, state } = hookHarness();
  const phaseDeclaration = findNode(chatFile, (node) => ts.isFunctionDeclaration(node) && node.name?.text === "phaseLabel");
  const phaseLabel = evaluate(phaseDeclaration, chatFile, {});
  const block = { toolCallId: "shell", toolName: "bash" };
  scope.handleAgentEvent({ type: "tool_execution_start", ...block });
  scope.handleAgentEvent({ type: "tool_execution_update", ...block, partialResult: { content: [{ type: "text", text: "private progress" }] } });
  assert.equal(state.phase.tools[0].progress, "private progress");
  assert.equal(phaseLabel(state.phase, (key) => key), "chat.runningTool");
  assert.equal(getToolPublicStatus(block, state.activeToolResults.get("shell")), "running");
  scope.handleAgentEvent({ type: "tool_execution_end", ...block, isError: true });
  assert.equal(getToolPublicStatus(block, state.activeToolResults.get("shell")), "failure");
  assert.equal(state.phase.kind, "waiting_model");
});

test("reconnects active shell output to its streaming tool call", () => {
  for (const toolName of ["bash", "powershell"]) {
    const { scope, state } = hookHarness();
    scope.agentRunningRef.current = true;
    const block = { toolCallId: "shell", toolName };
    scope.handleAgentEvent({ type: "tool_execution_update", ...block, partialResult: { content: [{ type: "text", text: "partial output" }] } });
    scope.handleAgentEvent({ type: "tool_execution_update", toolCallId: "other", toolName, partialResult: { content: [{ type: "text", text: "other output" }] } });
    const partial = state.activeToolResults.get("shell");
    assert.equal(partial.content[0].text, "partial output");
    assert.equal(partial.inProgress, true);
    scope.handleAgentEvent({ type: "tool_execution_end", ...block, isError: false });
    const completed = state.activeToolResults.get("shell");
    assert.equal(completed.content, partial.content);
    assert.equal(getToolPublicStatus(block, completed), "success");
    const transcript = { role: "toolResult", ...block, content: [{ type: "text", text: "final output" }], isError: false };
    scope.handleAgentEvent({ type: "message_end", message: transcript });
    assert.equal(state.activeToolResults.has("shell"), false);
    assert.equal(state.activeToolResults.has("other"), true);
    const map = callback("toolResultsMap", { activeToolResults: state.activeToolResults, messages: state.messages }, chatFile)();
    assert.equal(map.get("shell"), transcript);
    assert.equal(map.get("other"), state.activeToolResults.get("other"));
  }
  assert.match(chatWindowSource, /const displayMessages =[\s\S]*?\[\.\.\.messages, streamState\.streamingMessage\]/);
  assert.match(chatWindowSource, /message=\{msg\}\s*isStreaming=\{isStreaming\}\s*toolResults=\{toolResultsMap\}/);
  assert.doesNotMatch(chatWindowSource, /<MessageView message=\{streamState\.streamingMessage as AgentMessage\}/);
});

test("reports a running script's newest call as its progress", () => {
  const updateSource = source.slice(
    source.indexOf('case "tool_execution_update"'),
    source.indexOf('case "tool_execution_end"'),
  );
  // A codemode snapshot has no text content, so the generic progress would stay empty.
  assert.match(
    updateSource,
    /name === CODEMODE_TOOL_NAME\s*\? getCodemodeProgress\(event\.partialResult\)\s*: getToolExecutionProgress\(event\.partialResult\)/,
  );
});

test("keeps calls a tool made itself out of the running tools", () => {
  // A codemode script's nested calls would otherwise show as top-level running
  // tools beside the script that made them.
  for (const [from, to] of [
    ['case "tool_execution_start"', 'case "tool_execution_update"'],
    ['case "tool_execution_update"', 'case "tool_execution_end"'],
    ['case "tool_execution_end"', 'case "queue_update"'],
  ]) {
    const caseSource = source.slice(source.indexOf(from), source.indexOf(to));
    const guard = caseSource.indexOf("if (isNestedToolExecutionEvent(event)) break;");
    assert.notEqual(guard, -1, `${from} must skip nested tool events`);
    assert.ok(guard < caseSource.indexOf("const id = event.toolCallId"), `${from} must skip them before using the id`);
  }
  assert.match(source, /import \{ isNestedToolExecutionEvent, isSystemMessageEvent \} from "@\/lib\/agent-event-wire";/);
});

test("plays the enabled sound once when an extension dialog appears over an empty slot", () => {
  const soundSource = chatWindowSource.slice(
    chatWindowSource.indexOf("const surfaced = "),
    chatWindowSource.indexOf("}, [completionNotificationsEnabled, extensionDialog]);"),
  );
  assert.match(chatWindowSource, /extensionDialogShownRef = useRef\(false\)/);
  // A dialog queued behind another surfaces right after the user answers that one,
  // so only the transition from no dialog to a dialog sounds.
  assert.match(soundSource, /const surfaced = Boolean\(extensionDialog\) && !extensionDialogShownRef\.current;/);
  assert.match(soundSource, /extensionDialogShownRef\.current = Boolean\(extensionDialog\);\s+if \(!completionNotificationsEnabled \|\| !surfaced\) return;/);
  assert.match(soundSource, /playDoneSoundRef\.current\(\)/);
});

test("queues extension dialogs and custom panels by request id instead of sharing one slot", async () => {
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const respondSource = source.slice(
    source.indexOf("  const respondToExtensionUi = useCallback"),
    source.indexOf("  const sendExtensionCustomInput = useCallback"),
  );
  const closedSource = source.slice(
    source.indexOf('      case "extension_ui_closed":'),
    source.indexOf("  handleAgentEventRef.current = handleAgentEvent;"),
  );

  assert.match(
    source,
    /import \{\s+enqueueExtensionUiRequest,\s+removeExtensionUiRequest,\s+retainExtensionUiRequests,\s+upsertExtensionUiRequest,\s+\} from "@\/lib\/extension-ui-queue"/,
  );
  // A (re)connect drops what the server no longer holds; its replay follows.
  const connectedSource = source.slice(source.indexOf('      case "connected": {'), source.indexOf('      case "agent_start":'));
  assert.match(connectedSource, /const pending = new Set\(event\.pendingExtensionUiIds as string\[\]\);/);
  assert.match(connectedSource, /setExtensionDialogs\(\(queue\) => retainExtensionUiRequests\(queue, pending\)\);/);
  assert.match(connectedSource, /setExtensionCustomUis\(\(queue\) => retainExtensionUiRequests\(queue, pending\)\);/);
  assert.match(source, /const \[extensionDialogs, setExtensionDialogs\] = useState<ExtensionUiDialogRequest\[\]>\(\[\]\)/);
  assert.match(source, /const \[extensionCustomUis, setExtensionCustomUis\] = useState<ExtensionUiCustomRequest\[\]>\(\[\]\)/);
  assert.doesNotMatch(source, /setExtensionDialog\(|setExtensionCustomUi\(/);
  assert.match(
    extensionRequestSource,
    /case "editor":\s+setExtensionDialogs\(\(queue\) => enqueueExtensionUiRequest\(queue, request\)\)/,
  );
  // A custom panel re-renders under its id: replace it where it stands, drop it on close.
  assert.match(
    extensionRequestSource,
    /case "custom":\s+setExtensionCustomUis\(\(queue\) => request\.closed\s+\? removeExtensionUiRequest\(queue, request\.id\)\s+: upsertExtensionUiRequest\(queue, request\)\)/,
  );
  assert.match(respondSource, /setExtensionDialogs\(\(queue\) => removeExtensionUiRequest\(queue, request\.id\)\)/);
  assert.match(closedSource, /setExtensionDialogs\(\(queue\) => removeExtensionUiRequest\(queue, event\.id as string\)\)/);
  // The hook keeps exposing what is on screen under the old names, plus how many wait behind it.
  assert.match(source, /const extensionDialog = extensionDialogs\[0\] \?\? null;/);
  assert.match(source, /const waitingExtensionDialogCount = Math\.max\(0, extensionDialogs\.length - 1\);/);
  assert.match(source, /const extensionCustomUi = extensionCustomUis\[0\] \?\? null;/);
  assert.match(source, /const waitingExtensionCustomUiCount = Math\.max\(0, extensionCustomUis\.length - 1\);/);
  const { scope, state } = hookHarness();
  const first = { id: "dialog-1", method: "confirm", title: "First", message: "Continue?" };
  const second = { id: "dialog-2", method: "editor", title: "Second" };
  const custom = { id: "custom-1", method: "custom", lines: ["First render"] };
  for (const request of [first, second, first, custom]) scope.handleExtensionUiRequest(request);
  scope.handleExtensionUiRequest({ ...custom, lines: ["Updated render"] });
  assert.deepEqual(state.dialogs, [first, second]);
  assert.deepEqual(state.custom.map((request) => request.lines), [["Updated render"]]);
  // Execute the hook's projections and verify the returned interface without
  // requiring the properties to remain adjacent in a destructuring statement.
  for (const name of ["extensionDialog", "waitingExtensionDialogCount", "extensionCustomUi", "waitingExtensionCustomUiCount"]) {
    const declaration = findNode(hookFile, (node) => ts.isVariableDeclaration(node) && node.name.getText(hookFile) === name);
    const project = () => evaluate(declaration.initializer, hookFile, { extensionDialogs: state.dialogs, extensionCustomUis: state.custom });
    assert.deepEqual(project(), { extensionDialog: first, waitingExtensionDialogCount: 1, extensionCustomUi: state.custom[0], waitingExtensionCustomUiCount: 0 }[name]);
    findNode(hookFile, (node) => ts.isShorthandPropertyAssignment(node) && node.name.text === name);
    findNode(chatFile, (node) => ts.isBindingElement(node) && node.name.getText(chatFile) === name);
  }
  await callback("respondToExtensionUi", scope)(first, { confirmed: true });
  assert.deepEqual(state.dialogs, [second]);
  scope.handleAgentEvent({ type: "extension_ui_closed", id: second.id });
  assert.deepEqual(state.dialogs, []);
  scope.handleExtensionUiRequest({ ...custom, closed: true });
  assert.deepEqual(state.custom, []);
  // Reconnect keeps only server-held requests; duplicate replay stays idempotent.
  scope.handleExtensionUiRequest(first);
  scope.handleExtensionUiRequest(second);
  scope.handleExtensionUiRequest(custom);
  scope.handleAgentEvent({ type: "connected", pendingExtensionUiIds: [second.id], isStreaming: false });
  scope.handleExtensionUiRequest(second);
  assert.deepEqual(state.dialogs, [second]);
  assert.deepEqual(state.custom, []);
});

test("drops queued extension UI when a tool change rebuilds the wrapper", () => {
  const setToolsSource = source.slice(
    source.indexOf("  const handleToolPresetChange = useCallback"),
    source.indexOf("  const scrollToMessage = useCallback"),
  );
  // The old wrapper closes its event stream before cancelling its pending requests,
  // so their extension_ui_closed events never reach this hook.
  assert.match(
    setToolsSource,
    /if \(activeSessionId !== sid \|\| result\?\.recreated\) \{[\s\S]*?closeEvents\(\);[\s\S]*?setExtensionDialogs\(\[\]\);\s+setExtensionCustomUis\(\[\]\);[\s\S]*?maintainEventsConnected\(activeSessionId\)/,
  );
  // A tool change that keeps the wrapper keeps its pending requests on screen.
  const unconditional = setToolsSource.slice(setToolsSource.indexOf("      setSlashCommands([]);"));
  assert.doesNotMatch(unconditional, /setExtensionDialogs|setExtensionCustomUis/);
});

test("suppresses sounds and browser attention for the active subagent session", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(chatWindowSource, /completionNotificationsEnabled = session\?\.relation\?\.kind !== "subagent"/);
  assert.match(chatWindowSource, /completionNotificationsEnabled && soundEnabledRef\.current/);
  assert.match(chatWindowSource, /!completionNotificationsEnabled \|\| !surfaced/);
  assert.match(completionSource, /selectedSession\?\.relation\?\.kind === "subagent"\) return/);
  assert.match(attentionSource, /selectedSession\?\.relation\?\.kind === "subagent"\) return/);
});

test("routes blocking extension requests through deduplicated browser attention notifications", () => {
  const completionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAgentEnd = useCallback"),
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
  );
  const extensionRequestSource = source.slice(
    source.indexOf("  const handleExtensionUiRequest = useCallback"),
    source.indexOf("  const settleUiStage = useCallback"),
  );
  const attentionSource = appShellSource.slice(
    appShellSource.indexOf("  const handleAttentionNeeded = useCallback"),
    appShellSource.indexOf("  const handleAutoName = useCallback"),
  );

  assert.match(
    extensionRequestSource,
    /isBlockingExtensionUiRequest\(request\)[\s\S]*?onAttentionNeeded\?\.\(request\)/,
  );
  assert.match(chatWindowSource, /onAttentionNeeded, onSessionCreated/);
  assert.match(completionSource, /if \(!shouldShowBrowserNotification\(\)\) return/);
  assert.doesNotMatch(completionSource, /pushActive/);
  assert.match(completionSource, /tag: targetSession \? `pi-session-complete:\$\{targetSession\.id\}`/);
  assert.doesNotMatch(completionSource, /document\.visibilityState === "visible"/);
  assert.match(attentionSource, /shouldShowBrowserNotification\(\)/);
  assert.match(attentionSource, /claimExtensionAttentionNotification\(request, notifiedAttentionRequestIdsRef\.current\)/);
  assert.match(attentionSource, /tag: `pi-extension-ui:\$\{request\.id\}`/);
  assert.match(appShellSource, /onAttentionNeeded=\{handleAttentionNeeded\}/);
});

test("keeps live following cancellable when the user scrolls away from the tail", () => {
  const streamUpdateSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const scrollHandlerSource = source.slice(
    source.indexOf("const handleScrollPositionChange"),
    source.indexOf("// Load session on mount"),
  );
  const scrollToBottomSource = source.slice(
    source.indexOf("const scrollToBottom"),
    source.indexOf("const currentModel"),
  );

  assert.match(source, /const liveFollowFrameRef = useRef<number \| null>\(null\)/);
  assert.match(source, /const previousScrollTopRef = useRef\(0\)/);
  assert.match(source, /const wasAttached = isNearBottomRef\.current;[\s\S]*?const isAttached = getLiveFollowAttached\([\s\S]*?wasAttached,[\s\S]*?previousScrollTopRef\.current,[\s\S]*?scrollTop,[\s\S]*?clientHeight,[\s\S]*?scrollHeight/);
  assert.match(scrollHandlerSource, /const isAgentRunning = agentRunningRef\.current;[\s\S]*?isAgentRunning\s*\? CHAT_SCROLL_REATTACH_TOLERANCE\s*:\s*CHAT_SCROLL_TAIL_TOLERANCE/);
  assert.match(source, /previousScrollTopRef\.current = scrollTop/);
  assert.match(scrollToBottomSource, /const container = scrollContainerRef\.current;\s*if \(!container\) return;/);
  assert.match(scrollToBottomSource, /container\.scrollTo\(\{ top: container\.scrollHeight, behavior \}\);\s*previousScrollTopRef\.current = container\.scrollTop;/);
  assert.doesNotMatch(scrollToBottomSource, /scrollIntoView/);
  assert.match(streamUpdateSource, /liveFollowFrameRef\.current === null/);
  assert.match(streamUpdateSource, /requestAnimationFrame\(\(\) => \{[\s\S]*?liveFollowFrameRef\.current = null;[\s\S]*?if \(isNearBottomRef\.current\) scrollToBottom\("auto"\)/);
  assert.match(scrollHandlerSource, /!wasAttached && isAttached && isAgentRunning[\s\S]*?scrollToBottom\("auto"\)/);
  assert.match(scrollHandlerSource, /cancelAnimationFrame\(liveFollowFrameRef\.current\)/);
  assert.match(source, /previousScrollTopRef\.current = container\.scrollTop;\s*container\.addEventListener\("scroll", handleScrollPositionChange/);
  assert.doesNotMatch(source, /SCROLL_BOTTOM_THRESHOLD|completionScrollAllowedRef|ignoreProgrammaticScrollUntilRef/);
});

test("restores an in-page session viewport without the default tail jump", () => {
  assert.match(source, /const initialScrollDoneRef = useRef\(Boolean\(opts\.deferInitialScroll\)\)/);
  assert.match(source, /const scrollToMessage = useCallback\(\(element: HTMLElement, viewportOffset = 16\)/);
  assert.match(source, /container\.scrollTop\s+- viewportOffset/);
  assert.match(chatWindowSource, /deferInitialScroll: Boolean\(pendingScrollRestore\)/);
  assert.match(chatWindowSource, /isScrollAtTail\(container\.scrollTop, container\.clientHeight, container\.scrollHeight\)/);
  assert.match(chatWindowSource, /findChatScrollAnchor\(/);
  assert.match(chatWindowSource, /while \(hasMore && before && !controller\.signal\.aborted\)/);
  assert.match(chatWindowSource, /context\.oldestEntryId === position\.oldestEntryId/);
  assert.match(chatWindowSource, /if \(!context\) \{\s*outcome = "error";\s*scrollToBottom\("instant"\);\s*setPendingScrollRestore\(null\);/);
  assert.match(chatWindowSource, /scrollToMessage\(element, position\.anchorOffset\)/);
  assert.match(chatWindowSource, /visibility: pendingScrollRestore \? "hidden" : undefined/);
});

test("keeps a newly sent user message at the top while its response starts", () => {
  const streamUpdateSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const userScrollSource = source.slice(
    source.indexOf("const scrollUserMsgToTop"),
    source.indexOf("const handleScrollPositionChange"),
  );
  const scrollEffectSource = source.slice(
    source.indexOf("useLayoutEffect(() => {\n    if (opts.deferInitialScroll) return;"),
    source.indexOf("// Load the model list"),
  );

  assert.match(streamUpdateSource, /!pendingScrollToUserRef\.current && isNearBottomRef\.current/);
  assert.match(source, /const \[promptAnchorActive, setPromptAnchorActive\] = useState\(false\)/);
  assert.match(source, /pendingScrollToUserRef\.current = true;\s*setPromptAnchorActive\(true\)/);
  assert.match(userScrollSource, /const targetTop = Math\.min\(Math\.max\(0, elAbsTop - 16\), maxScrollTop\)/);
  assert.match(userScrollSource, /cancelAnimationFrame\(liveFollowFrameRef\.current\)/);
  assert.match(userScrollSource, /isNearBottomRef\.current = true/);
  assert.match(userScrollSource, /previousScrollTopRef\.current = targetTop/);
  assert.match(userScrollSource, /container\.scrollTo\(\{ top: targetTop, behavior: "auto" \}\)/);
  assert.match(scrollEffectSource, /pendingScrollToUserRef\.current = false;[\s\S]*?scrollUserMsgToTop\(\)/);
  assert.match(chatWindowSource, /const contentEnd = spacer\.getBoundingClientRect\(\)\.top[\s\S]*?getPromptAnchorSpacerHeight\([\s\S]*?targetTop,[\s\S]*?contentEnd,[\s\S]*?container\.clientHeight/);
  assert.match(chatWindowSource, /<div ref=\{promptAnchorSpacerRef\} aria-hidden="true" \/>/);
  assert.match(chatWindowSource, /const promptAnchorAdjustmentDoneRef = useRef\(false\)/);
  assert.match(chatWindowSource, /promptAnchorAdjustmentDoneRef\.current = false/);
  assert.match(chatWindowSource, /const isInitialMeasurement = !promptAnchorAdjustmentDoneRef\.current;[\s\S]*?promptAnchorAdjustmentDoneRef\.current = true;[\s\S]*?if \(isInitialMeasurement\) scrollUserMsgToTop\(\)/);
});

test("keeps prompt anchor measurement outside the React update cycle", () => {
  const anchorEffectStart = chatWindowSource.indexOf(
    "useLayoutEffect(() => {\n    const spacer = promptAnchorSpacerRef.current;",
  );
  assert.notEqual(anchorEffectStart, -1);
  const syncEffectStart = chatWindowSource.indexOf(
    "useLayoutEffect(() => {\n    promptAnchorUpdateRef.current?.();",
    anchorEffectStart,
  );
  assert.notEqual(syncEffectStart, -1);
  const anchorLifecycleEffectSource = chatWindowSource.slice(
    anchorEffectStart,
    syncEffectStart,
  );
  const anchorSyncEffectSource = chatWindowSource.slice(
    syncEffectStart,
    chatWindowSource.indexOf("const availableThinkingLevels"),
  );

  assert.doesNotMatch(anchorLifecycleEffectSource, /\bset[A-Z][A-Za-z0-9]*\s*\(/);
  assert.doesNotMatch(anchorSyncEffectSource, /\bset[A-Z][A-Za-z0-9]*\s*\(/);
  assert.doesNotMatch(chatWindowSource, /setPromptAnchorSpacer|useState[^\n]*promptAnchorSpacer/);
  assert.doesNotMatch(anchorLifecycleEffectSource, /streamState\.streamingMessage/);
  assert.match(anchorLifecycleEffectSource, /spacer\.style\.height = nextPromptAnchorSpacerHeight > 0/);
  assert.match(anchorLifecycleEffectSource, /promptAnchorUpdateRef\.current = updatePromptAnchorSpacer/);
  assert.match(anchorLifecycleEffectSource, /new ResizeObserver\(schedulePromptAnchorMeasure\)/);
  assert.match(anchorLifecycleEffectSource, /observer\?\.observe\(messageContent\)/);
  assert.match(anchorLifecycleEffectSource, /if \(disposed \|\| promptAnchorMeasureFrameRef\.current !== null\) return/);
  assert.match(anchorLifecycleEffectSource, /promptAnchorMeasureFrameRef\.current = requestAnimationFrame\(\(\) => \{\s*promptAnchorMeasureFrameRef\.current = null;\s*updatePromptAnchorSpacer\(\)/);
  assert.match(anchorLifecycleEffectSource, /disposed = true;[\s\S]*?promptAnchorUpdateRef\.current === updatePromptAnchorSpacer[\s\S]*?cancelAnimationFrame\(promptAnchorMeasureFrameRef\.current\)/);
  assert.match(anchorSyncEffectSource, /promptAnchorUpdateRef\.current\?\.\(\);\s*\}, \[streamState\.streamingMessage\]\)/);
  assert.match(chatWindowSource, /<div ref=\{messageContentRef\}[^>]*style=\{\{/);
});

test("uses the prompt anchor as the only trailing message spacer", () => {
  assert.match(chatWindowSource, /<div ref=\{promptAnchorSpacerRef\} aria-hidden="true" \/>[\s\S]*?<\/div>/);
  assert.doesNotMatch(chatWindowSource, /bottomComposer(?:Ref|Height|ScrollFrameRef)/);
  assert.doesNotMatch(chatWindowSource, /new ResizeObserver\(updateBottomComposerHeight\)/);
});

test("keeps a detached viewport in place when streaming completes", () => {
  const effect = findNode(hookFile, (node) => ts.isCallExpression(node)
    && node.expression.getText(hookFile) === "useLayoutEffect"
    && node.arguments[0]?.getText(hookFile).includes("opts.deferInitialScroll"));
  for (const running of [false, true]) {
    for (const attached of [false, true]) {
      const scrolls = [];
      const scope = {
        opts: { deferInitialScroll: false }, messages: [{}],
        pendingScrollToUserRef: ref(false), initialScrollDoneRef: ref(true),
        agentRunningRef: ref(running), isNearBottomRef: ref(attached),
        scrollToBottom: (behavior) => scrolls.push(behavior), scrollUserMsgToTop: () => scrolls.push("user"),
      };
      const run = evaluate(effect.arguments[0], hookFile, scope);
      run();
      assert.deepEqual(scrolls, !running && attached ? ["auto"] : [], `running=${running}, attached=${attached}`);
      scope.opts.deferInitialScroll = true;
      scope.pendingScrollToUserRef.current = true;
      scope.initialScrollDoneRef.current = false;
      scrolls.length = 0;
      run();
      assert.deepEqual(scrolls, [], "Restoring a saved viewport must defer initial scrolling");
    }
  }
  assert.match(source, /addEventListener\("scroll", handleScrollPositionChange/);
});

test("auto-compact slash command toggles session auto-compaction", () => {
  const commandSource = source.slice(
    source.indexOf('case "auto-compact"'),
    source.indexOf('case "reload"'),
  );
  assert.ok(commandSource.length > 0, "auto-compact case not found before reload case");
  assert.match(commandSource, /sendAgentCommand<AgentStateResponse>\(sid, \{\s*type: "get_state"\s*\}\)/);
  assert.match(commandSource, /!\(liveState\?\.autoCompactionEnabled \?\? true\)/);
  assert.match(commandSource, /sendAgentCommand\(sid, \{\s*type: "set_auto_compaction",\s*enabled: nextEnabled,\s*\}\)/);
  assert.match(commandSource, /setAutoCompactionEnabled\(nextEnabled\)/);
  assert.doesNotMatch(commandSource, /!autoCompactionEnabled/);
  // State mirrors the wrapper so the toggle reflects server-side changes too.
  assert.match(source, /setAutoCompactionEnabled\(state\?\.autoCompactionEnabled \?\? true\)/);
  assert.match(source, /setAutoCompactionEnabled\(liveState\.autoCompactionEnabled \?\? true\)/);
});

test("loadSession suppresses AbortError from polluting UI error and conducts bounded retry while preserving real errors", async () => {
  const loadSessionSource = source.slice(
    source.indexOf("  const loadSession = useCallback"),
    source.indexOf("  const loadContext = useCallback"),
  );

  // 1. Evaluate the actual request options: fresh reads preserve caller aborts.
  const loadDeclaration = findNode(hookFile, node => ts.isVariableDeclaration(node) && node.name.getText(hookFile) === "loadSession");
  const historyFetch = findNode(loadDeclaration, node => ts.isCallExpression(node)
    && node.expression.getText(hookFile) === "fetch" && node.arguments[0]?.getText(hookFile) === "url");
  const signal = new AbortController().signal;
  assert.deepEqual(evaluate(historyFetch.arguments[1], hookFile, { options: { signal } }), { cache: "no-store", signal });
  assert.deepEqual(evaluate(historyFetch.arguments[1], hookFile, { options: undefined }), { cache: "no-store" });
  assert.match(loadSessionSource, /const stateRes = await fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(sid\)\}\/state`, options\?\.signal \? \{ signal: options\.signal \} : undefined\);/);

  // 2. AbortError detection & UI error suppression (positive & negative cases)
  assert.match(source, /export function isAbortError\(e: unknown\): boolean/);
  assert.match(loadSessionSource, /if \(isAbortError\(e\)\) \{/);
  assert.match(loadSessionSource, /const isExplicitCallerAbort = Boolean\(options\?\.signal\?\.aborted\);/);
  assert.match(loadSessionSource, /const canRetry = ownsCurrentView\(\) && !options\?\.abortRetry && !isExplicitCallerAbort;/);

  // Real errors (HTTP 500, network offline TypeError, sync rejected) are preserved and visible
  assert.match(loadSessionSource, /if \(isCurrentRead\(\)\) setError\(String\(e\)\);\s*return "error";/);

  // 3. Bounded non-blocking retry (single-attempt, prevents infinite loop)
  assert.match(loadSessionSource, /willRetryAbort = true;/);
  assert.match(loadSessionSource, /queueMicrotask\(\(\) => \{[\s\S]*?if \(ownsCurrentView\(\)\) \{[\s\S]*?void loadSession\(sid, showLoading && !dataRef\.current, includeState, \{[\s\S]*?\.\.\.options,[\s\S]*?force: true,[\s\S]*?abortRetry: true,[\s\S]*?\}\);/);

  // 4. Preserving existing non-blank history and immediate loading release
  assert.match(loadSessionSource, /if \(willRetryAbort\) \{[\s\S]*?if \(dataRef\.current\) setLoading\(false\);[\s\S]*?\} else if/);

  // 5. Unit test isAbortError logic directly
  const testIsAbortError = (e) => {
    if (!e) return false;
    if (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") {
      return true;
    }
    if (typeof e === "object" && e !== null && "name" in e && e.name === "AbortError") {
      return true;
    }
    return false;
  };

  // Positive cases (must be true)
  const domAbortError = typeof DOMException !== "undefined" ? new DOMException("The user aborted a request.", "AbortError") : { name: "AbortError", message: "aborted" };
  assert.equal(testIsAbortError(domAbortError), true, "DOMException AbortError must be recognized");
  assert.equal(testIsAbortError({ name: "AbortError" }), true, "Plain object with name AbortError must be recognized");
  assert.equal(testIsAbortError(Object.assign(new Error("operation aborted"), { name: "AbortError" })), true, "Error with name AbortError must be recognized");

  // Negative cases (must be false so real errors are NEVER swallowed)
  assert.equal(testIsAbortError(new Error("HTTP 500")), false, "HTTP 500 Error must NOT be treated as AbortError");
  assert.equal(testIsAbortError(new TypeError("Failed to fetch")), false, "TypeError Failed to fetch must NOT be treated as AbortError");
  assert.equal(testIsAbortError(new Error("Session sync rejected: invalid delta")), false, "Sync rejection must NOT be treated as AbortError");
  assert.equal(testIsAbortError(null), false, "null must NOT be treated as AbortError");
  assert.equal(testIsAbortError(undefined), false, "undefined must NOT be treated as AbortError");
  assert.equal(testIsAbortError("AbortError string"), false, "Plain string must NOT be treated as AbortError");
});


test("queued user delivery acquires a fresh native scroll intent without duplicating the optimistic prompt", () => {
  const { state, scope } = hookHarness();
  let revision = 0;
  scope.agentRunningRef.current = true;
  scope.setPromptScrollRevision = (update) => { revision = update(revision); };
  const initial = { role: "user", content: "initial", timestamp: 1 };
  state.messages = [initial];
  scope.optimisticUserMessageRef.current = { message: initial };
  scope.handleAgentEvent({ type: "message_end", message: initial });
  assert.equal(revision, 0, "the initial echo preserves the existing intent");
  assert.equal(state.messages.length, 1);
  const queued = { role: "user", content: "next turn", timestamp: 2 };
  scope.handleAgentEvent({ type: "message_end", message: queued });
  assert.equal(revision, 1, JSON.stringify({ messages: state.messages, optimistic: scope.optimisticUserMessageRef.current, pending: scope.pendingScrollToUserRef.current }));
  assert.equal(scope.pendingScrollToUserRef.current, true);
  assert.equal(state.messages.at(-1), queued);
});


test("new user turns cancel a stale history restore while ordinary pagination keeps its anchor", () => {
  const effect = findNode(chatFile, (node) => ts.isCallExpression(node)
    && node.expression.getText(chatFile) === "useLayoutEffect"
    && node.arguments[0]?.getText(chatFile).includes("historyPromptRevisionRef.current !=="));
  for (const revision of [1, 2]) {
    const container = { scrollTop: 100, scrollHeight: 2000 };
    const scope = { historyPromptRevisionRef: ref(1), promptScrollRevision: revision,
      prevScrollDistanceRef: ref(1500), pendingHistoryVisibleCountRef: ref(null),
      loadingOlderRef: ref(true), visibleCount: 50, scrollContainerRef: ref(container),
      restoreScrollTop: (height, distance) => height - distance };
    scope.activeHistoryLoadRef = ref({ kind: revision === 1 ? "local" : "network" });
    scope.clearHistoryLoadGuard = operation => { if (operation.kind === "local") scope.loadingOlderRef.current = false; };
    evaluate(effect.arguments[0], chatFile, scope)();
    assert.equal(container.scrollTop, revision === 1 ? 500 : 100);
    assert.equal(scope.prevScrollDistanceRef.current, null);
    assert.equal(scope.loadingOlderRef.current, revision !== 1, "in-flight fetch remains guarded");
  }
});


test("cancelled local history restoration releases its page guard after the render page mounts", () => {
  const effect = findNode(chatFile, (node) => ts.isCallExpression(node)
    && node.expression.getText(chatFile) === "useLayoutEffect"
    && node.arguments[0]?.getText(chatFile).includes("historyPromptRevisionRef.current !=="));
  const container = { scrollTop: 900, scrollHeight: 2000 };
  const scope = { historyPromptRevisionRef: ref(1), promptScrollRevision: 2,
    prevScrollDistanceRef: ref(1500), pendingHistoryVisibleCountRef: ref(100),
    loadingOlderRef: ref(true), visibleCount: 50, scrollContainerRef: ref(container),
    restoreScrollTop: () => { throw Error("old anchor must not be restored"); } };
  scope.activeHistoryLoadRef = ref({ kind: "local" });
  scope.clearHistoryLoadGuard = () => { scope.loadingOlderRef.current = false; };
  const run = evaluate(effect.arguments[0], chatFile, scope);
  run();
  assert.equal(scope.loadingOlderRef.current, true);
  scope.visibleCount = 100;
  run();
  assert.equal(scope.loadingOlderRef.current, false);
  assert.equal(scope.pendingHistoryVisibleCountRef.current, null);
  assert.equal(container.scrollTop, 900);
});


test("receipt recovery clock survives changing UI callbacks without losing their latest owner", async () => {
  const effect = findNode(hookFile,node=>ts.isCallExpression(node) && node.expression.getText(hookFile)==="useEffect"
    && node.arguments[0]?.getText(hookFile).includes("const pending = unconfirmedSubmissions"));
  const row={requestId:"r",sessionId:"s",status:"uncertain"};
  const scope={unconfirmedSubmissions:[row],isPromptSubmissionDispatching:()=>false,confirmPendingSubmission:async()=>{},document:{visibilityState:"visible",addEventListener(){},removeEventListener(){}},window:{addEventListener(){},removeEventListener(){}},setInterval(fn,ms){assert.equal(ms,8000);scope.tick=fn;return 1;},clearInterval(){},};
  let owner=0,reads=[];scope.confirmPendingSubmission=async()=>{reads.push(owner);};
  // Model React's event function: stable scheduling, current callback on dispatch.
  scope.confirmUncertainSubmission=async row=>scope.confirmPendingSubmission(row);
  const dependencies=()=>evaluate(effect.arguments[1],hookFile,scope);
  const first=dependencies();
  const cleanup=evaluate(effect.arguments[0],hookFile,scope)();
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(reads,[0]);
  for(owner=1;owner<=30;owner++){
    scope.confirmPendingSubmission=async()=>{reads.push(owner);};
    assert.deepEqual(dependencies(),first,"ordinary UI callback changes must not restart immediate recovery");
  }
  scope.tick();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(reads,[0,31]);
  cleanup();scope.tick();await new Promise(resolve=>setImmediate(resolve));assert.equal(reads.length,2);
});


test("a running reconnect reads missed history while retaining the active run", () => {
  const { scope } = hookHarness();
  const reads = [];
  scope.sdkAgentActiveRef = ref(false);
  scope.loadSession = async (sid) => { reads.push(sid); };
  scope.handleAgentEvent({ type: "connected", isStreaming: true });
  assert.deepEqual(reads, ["session"]);
  assert.equal(scope.agentRunningRef.current, true);
  assert.equal(scope.sdkAgentActiveRef.current, true);
});


test("a cold session hydrates before SSE while cached and Strict Mode mounts still subscribe immediately", () => {
  const start = source.indexOf("  // Keep the selected session warm even while its agent is idle.");
  const effect = findNode(hookFile, node => ts.isCallExpression(node)
    && node.expression.getText(hookFile) === "useEffect" && node.getStart(hookFile) > start
    && node.arguments[0]?.getText(hookFile).includes("data?.sessionId !== sid"));
  const subscribed = [], closed = [];
  const scope = { session: { id: "session" }, data: null, sessionHookMountedRef: ref(true),
    sessionIdRef: ref("session"), maintainEventsConnected: sid => subscribed.push(sid),
    eventConnectionRef: ref({ close: () => closed.push(true) }) };
  const mount = evaluate(effect.arguments[0], hookFile, scope);
  assert.equal(mount(), undefined);
  assert.equal(subscribed.length, 0, "message_end and connected cannot starve the initial HTTP snapshot");
  scope.data = { sessionId: "other" };
  mount(); assert.equal(subscribed.length, 0, "a prior session's resident data is not hydration");
  scope.data = { sessionId: "session", context: { messages: [] } };
  const cleanup = mount(); assert.deepEqual(subscribed, ["session"]);
  cleanup(); assert.equal(closed.length, 1);
  scope.sessionHookMountedRef.current = false;
  mount(); assert.equal(scope.sessionHookMountedRef.current, true);
  assert.deepEqual(subscribed, ["session", "session"], "Strict Mode reopens the hydrated view");
});

test("lease recovery cannot subscribe to a cold session before history hydration", async () => {
  const declaration = findNode(hookFile, node => ts.isVariableDeclaration(node) && node.name.getText(hookFile) === "renewLease");
  const calls = [];
  const scope = { disposed: false, renewing: false, sid: "session", sessionIdRef: ref("session"), sessionPropIdRef: ref("session"),
    dataRef: ref(null), fetch: async () => ({ ok: true, json: async () => ({ renewed: 0 }) }),
    closeEvents: () => calls.push("close"), maintainEventsConnected: sid => calls.push(sid) };
  const renew = evaluate(declaration.initializer, hookFile, scope);
  await renew(); assert.deepEqual(calls, []);
  scope.dataRef.current = { sessionId: "session" };
  await renew(); assert.deepEqual(calls, ["close", "session"]);
});
