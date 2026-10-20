import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../enhancements/modules/05-composer-and-input-workflow.js', import.meta.url), 'utf8');
const file = ts.createSourceFile('composer.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const wantedFunctions = new Set([
  'parseExtensionStatus',
  'normalizeComposerModeState',
  'getComposerExecutionEngineHint',
  'getSessionComposerMode',
  'getComposerGoalState',
  'commitComposerModeState',
  'requestSwitchComposerMode',
  'querySessionModeState',
  'handleComposerGoalAction',
]);
const functionTexts = [];
function visit(n) {
  if (ts.isFunctionDeclaration(n) && wantedFunctions.has(n.name?.text)) functionTexts.push(n.getText(file));
  ts.forEachChild(n, visit);
}
visit(file);

function reply(data, ok = true) {
  return { ok, status: ok ? 200 : 409, json: async () => data };
}

function status(mode, extra = {}) {
  return {
    version: 1,
    mode,
    ...extra,
  };
}

function extensionReply(snapshot) {
  return { success: true, extensionStatuses: [{ key: 'composer-modes', text: JSON.stringify(snapshot) }] };
}

function setup({ id = 'codex:thread', engine = 'codex', initialState = null, replies = [] } = {}) {
  const calls = [];
  const notices = [];
  const scope = {
    pendingNewComposerMode: null,
    composerModesStateMap: new Map(initialState ? [[id, initialState]] : []),
    getEffectiveComposerSessionId: () => id,
    getCurrentProjectStatusKey: () => 'project',
    findComposerTextarea: () => ({ focus() {}, closest: () => ({ dataset: { piExecutionEngine: engine } }) }),
    syncComposerModes() {},
    syncComposerModesBottomStatus() {},
    closeComposerAddMenu() {},
    showToast: (message) => notices.push(message),
    lastObservedModesSessionId: id,
    composerModeFetchToken: 0,
    composerModeSwitching: false,
    isGoalActionRunning: false,
    window: {
      fetch: async (url, init = {}) => {
        calls.push({ url, init });
        return replies.shift() || reply({ success: false }, false);
      },
    },
  };
  const api = new Function('scope', `with (scope) { ${functionTexts.join('\n')}\nreturn {
    getComposerExecutionEngineHint,
    getSessionComposerMode,
    normalizeComposerModeState,
    requestSwitchComposerMode,
    handleComposerGoalAction,
  }; }`)(scope);
  return { scope, calls, notices, ...api };
}

test('Codex plan/goal uses declared capabilities and commits the authoritative set_composer_mode snapshot', async () => {
  const snapshot = status('goal', {
    goal: '完成目标',
    goalStatus: 'active',
    goalIdentity: { objective: '完成目标', createdAt: 1730000000000 },
    goalElapsedMs: 1250,
    capabilities: { goal: true, plan: true },
  });
  const h = setup({
    id: 'codex:thread',
    initialState: status('normal', { capabilities: { goal: true, plan: true } }),
    replies: [reply(extensionReply(snapshot))],
  });

  assert.equal(await h.requestSwitchComposerMode('goal', 'codex:thread'), true);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { type: 'set_composer_mode', mode: 'goal' });
  assert.equal(h.scope.composerModesStateMap.get('codex:thread').goalIdentity.createdAt, 1730000000000);
  assert.equal(h.scope.composerModesStateMap.get('codex:thread').goalElapsedMs, 1250);
  assert.deepEqual(h.scope.composerModesStateMap.get('codex:thread').capabilities, { goal: true, plan: true });
});

test('new Codex mode staging calls set_composer_mode before prompt even without an earlier capability snapshot', async () => {
  const snapshot = status('goal', {
    goal: '新会话目标',
    goalStatus: 'active',
    goalIdentity: { objective: '新会话目标', createdAt: 1730000000000 },
    capabilities: { goal: true, plan: true },
  });
  const h = setup({ id: 'codex:new', replies: [reply(extensionReply(snapshot))] });
  h.scope.pendingNewComposerMode = { mode: 'goal', engine: 'codex', project: 'project', sessionId: 'codex:new' };

  assert.equal(await h.requestSwitchComposerMode('goal', 'codex:new'), true);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { type: 'set_composer_mode', mode: 'goal' });
  assert.deepEqual(h.scope.composerModesStateMap.get('codex:new').capabilities, { goal: true, plan: true });
});

test('new Codex mode staging remains pending when an old backend omits capabilities', async () => {
  const snapshot = status('goal', { goal: '目标', goalStatus: 'active' });
  const h = setup({ id: 'codex:new-old', replies: [reply(extensionReply(snapshot))] });
  const staged = { mode: 'goal', engine: 'codex', project: 'project', sessionId: 'codex:new-old' };
  h.scope.pendingNewComposerMode = staged;

  assert.equal(await h.requestSwitchComposerMode('goal', 'codex:new-old'), false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { type: 'set_composer_mode', mode: 'goal' });
  assert.equal(h.scope.pendingNewComposerMode, staged);
});

test('Codex with old or missing capability snapshot queries once and fails closed without setting mode', async () => {
  const oldState = { state: { extensionStatuses: [{ key: 'composer-modes', text: JSON.stringify(status('normal')) }] } };
  const h = setup({ id: 'codex:old', replies: [reply(oldState)] });
  const draft = { text: '保留这段正文'.repeat(200), images: [{ data: 'AQID', mimeType: 'image/png' }] };
  const before = JSON.stringify(draft);

  assert.equal(await h.requestSwitchComposerMode('plan', 'codex:old'), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init.method, 'GET');
  assert.equal(h.scope.composerModesStateMap.get('codex:old').capabilities, undefined);
  assert.equal(JSON.stringify(draft), before);
});

test('new Codex draft stages engine and project without claiming activation', async () => {
  const h = setup({ id: null, engine: 'codex' });
  assert.equal(await h.requestSwitchComposerMode('goal'), true);
  assert.deepEqual(h.scope.pendingNewComposerMode, { mode: 'goal', engine: 'codex', project: 'project' });
  assert.equal(h.getSessionComposerMode(null), 'goal');
  assert.equal(h.calls.length, 0);
});

const cacheSource = fs.readFileSync(new URL('../enhancements/modules/03-session-cache-and-sync-engine.js', import.meta.url), 'utf8');
const cacheFile = ts.createSourceFile('cache.js', cacheSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let pendingPromptGuard = null;
function findGuard(n) {
  if (ts.isIfStatement(n) && n.expression.getText(cacheFile) === 'queueRequestBody && isPluginEnabled("composer-modes")') {
    pendingPromptGuard = n.getText(cacheFile);
  }
  ts.forEachChild(n, findGuard);
}
findGuard(cacheFile);
assert.ok(pendingPromptGuard, 'new-session mode preflight guard exists');

async function runPendingPromptGuard({ pending, owner, body, switchResult }) {
  const scope = {
    queueRequestBody: Promise.resolve(body),
    pendingNewComposerMode: pending,
    isPluginEnabled: () => true,
    getCurrentProjectStatusKey: () => 'project',
    extractSessionIdFromUrl: () => owner,
    requestUrl: `/api/agent/${encodeURIComponent(owner)}`,
    requestSwitchComposerMode: async () => switchResult,
    Response,
  };
  const result = await new Function('scope', `with (scope) { return (async () => { ${pendingPromptGuard} })(); }`)(scope);
  return { result, scope };
}

test('first Codex prompt is blocked when mode confirmation fails, preserving text and image payload', async () => {
  const body = JSON.stringify({ type: 'prompt', message: '原文不能丢', images: [{ data: 'AQID', mimeType: 'image/png' }] });
  const pending = { sessionId: 'codex:thread', mode: 'goal', engine: 'codex', project: 'project' };
  const { result, scope } = await runPendingPromptGuard({ pending, owner: 'codex:thread', body, switchResult: false });

  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'prompt_rejected');
  assert.equal(await scope.queueRequestBody, body);
  assert.equal(scope.pendingNewComposerMode, pending);
});

test('first Codex prompt proceeds only after set mode confirmation and clears its staged state', async () => {
  const body = JSON.stringify({ type: 'prompt', message: '正文与附件不变', images: [{ data: 'AQID', mimeType: 'image/png' }] });
  const pending = { sessionId: 'codex:thread', mode: 'goal', engine: 'codex', project: 'project' };
  const { result, scope } = await runPendingPromptGuard({ pending, owner: 'codex:thread', body, switchResult: true });

  assert.equal(result, undefined);
  assert.equal(await scope.queueRequestBody, body);
  assert.equal(scope.pendingNewComposerMode, null);
});

test('staged Pi mode cannot leak into a Codex conversation', async () => {
  const body = JSON.stringify({ type: 'prompt', message: 'Codex 原文', images: [{ data: 'AQID', mimeType: 'image/png' }] });
  const pending = { sessionId: 'pi-thread', mode: 'plan', engine: 'pi', project: 'project' };
  const { result, scope } = await runPendingPromptGuard({ pending, owner: 'codex:thread', body, switchResult: false });

  assert.equal(result, undefined);
  assert.equal(await scope.queueRequestBody, body);
  assert.equal(scope.pendingNewComposerMode, null);
});

test('Pi mode keeps its set_composer_mode request path', async () => {
  const snapshot = status('plan', { toolsBeforePlan: ['read'] });
  const h = setup({ id: 'pi-thread', engine: 'pi', replies: [reply(extensionReply(snapshot))] });

  assert.equal(await h.requestSwitchComposerMode('plan', 'pi-thread'), true);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), { type: 'set_composer_mode', mode: 'plan' });
  assert.equal(h.scope.composerModesStateMap.get('pi-thread').mode, 'plan');
});

test('Codex goal pause uses composer_goal_action with an identity and never sends a slash prompt', async () => {
  const identity = { objective: '持续完成工作', createdAt: '2026-10-18T10:00:00Z' };
  const initial = status('goal', {
    goal: identity.objective,
    goalStatus: 'active',
    goalIdentity: identity,
    capabilities: { goal: true, plan: true },
  });
  const returned = status('goal', {
    goal: identity.objective,
    goalStatus: 'paused',
    goalIdentity: identity,
    paused: true,
    capabilities: { goal: true, plan: true },
  });
  const h = setup({ id: 'codex:goal', initialState: initial, replies: [reply(extensionReply(returned))] });

  assert.equal(await h.handleComposerGoalAction('pause', 'codex:goal'), true);
  assert.deepEqual(JSON.parse(h.calls[0].init.body), {
    type: 'composer_goal_action',
    action: 'pause',
    expected: identity,
  });
  assert.equal(h.calls.some(({ init }) => JSON.parse(init.body).type === 'prompt'), false);
  assert.equal(h.scope.composerModesStateMap.get('codex:goal').goalStatus, 'paused');
});

test('Pi goal controls retain the registered-extension command route', async () => {
  const initial = status('goal', { goal: 'Pi 目标', paused: false, pausePending: false });
  const returned = status('goal', { goal: 'Pi 目标', paused: true, pausePending: false });
  const h = setup({
    id: 'pi-goal',
    engine: 'pi',
    initialState: initial,
    replies: [
      reply({ success: true, commands: [{ name: 'composer-goal' }] }),
      reply({ success: true }),
      reply(extensionReply(returned)),
    ],
  });

  assert.equal(await h.handleComposerGoalAction('pause', 'pi-goal'), true);
  assert.equal(JSON.parse(h.calls[0].init.body).type, 'get_commands');
  assert.deepEqual(JSON.parse(h.calls[1].init.body), { type: 'prompt', message: '/composer-goal pause' });
  assert.deepEqual(JSON.parse(h.calls[2].init.body), { type: 'get_state' });
});

test('normal mode normalization removes goal identity and timing while retaining capabilities', () => {
  const h = setup();
  assert.deepEqual(h.normalizeComposerModeState(status('normal', {
    goal: 'stale',
    goalIdentity: { objective: 'stale', createdAt: 1 },
    goalStatus: 'paused',
    goalElapsedMs: 300,
    goalActiveSinceMs: 100,
    pausePending: true,
    capabilities: { goal: true, plan: false },
  })), {
    version: 1,
    mode: 'normal',
    capabilities: { goal: true, plan: false },
  });
});

test('new creation endpoint has no engine owner and must preserve Codex staged mode', async () => {
 const pending={mode:'plan',engine:'codex',project:'project'};
 const body=JSON.stringify({type:'ensure_session',cwd:'/isolated/project'});
 const {result,scope}=await runPendingPromptGuard({pending,owner:'new',body,switchResult:false});
 assert.equal(result,undefined); assert.equal(scope.pendingNewComposerMode,pending); assert.equal(await scope.queueRequestBody,body);
});
