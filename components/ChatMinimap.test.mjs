import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith(".module.css")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: "export default new Proxy({}, { get: (_, key) => String(key) });",
    };
  },
});

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  computeUserTurnNumbers,
  getUserPreview,
  createTurnNodes,
  layoutNodes,
  getMinimapHistorySettings,
  readMinimapHistoryState,
} = await jiti.import("./ChatMinimap.tsx");

test("getUserPreview extracts trimmed string content", () => {
  assert.equal(getUserPreview({ role: "user", content: "  hello world  " }), "hello world");
});

test("getUserPreview strips image coordinate dimension note and falls back to [图片] when text is only note", () => {
  assert.equal(
    getUserPreview({
      role: "user",
      content: "分析下图片\n\n[Image: original 2248x2480, displayed at 1813x2000. Multiply coordinates by 1.24 to map to original image.]"
    }),
    "分析下图片"
  );
  assert.equal(
    getUserPreview({
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        { type: "text", text: "[Image: original 2248x2480, displayed at 1813x2000. Multiply coordinates by 1.24 to map to original image.]" }
      ]
    }),
    "[图片]"
  );
});

test("getUserPreview extracts multi-block text and handles image attachments gracefully", () => {
  assert.equal(
    getUserPreview({
      role: "user",
      content: [
        { type: "text", text: "Line 1" },
        { type: "text", text: "Line 2" },
      ],
    }),
    "Line 1\nLine 2",
  );

  assert.equal(
    getUserPreview({
      role: "user",
      content: [
        { type: "image", data: "base64...", mimeType: "image/png" },
        { type: "text", text: "Look at this chart" },
      ],
    }),
    "Look at this chart",
  );

  assert.equal(
    getUserPreview({
      role: "user",
      content: [
        { type: "image", data: "base64...", mimeType: "image/png" },
      ],
    }),
    "[图片]",
  );
});

test("computeUserTurnNumbers calculates 1-based serials with totalTurns history offset", () => {
  // Scenario: 12 total user turns in session history, but only the latest 3 user turns are currently loaded.
  const turns = [
    {
      userTurnNumber: 0,
      userMessage: { role: "user", content: "Turn 10" },
      scrollTop: 100,
    },
    {
      userTurnNumber: 0,
      userMessage: { role: "user", content: "Turn 11" },
      scrollTop: 200,
    },
    {
      userTurnNumber: 0,
      userMessage: { role: "user", content: "Turn 12" },
      scrollTop: 300,
    },
  ];

  computeUserTurnNumbers(turns, 12);

  assert.equal(turns[0].userTurnNumber, 10);
  assert.equal(turns[1].userTurnNumber, 11);
  assert.equal(turns[2].userTurnNumber, 12);
});

test("computeUserTurnNumbers calculates correct offset when single user turn is loaded", () => {
  const turns = [
    {
      userTurnNumber: 0,
      userMessage: { role: "user", content: "Latest user prompt" },
      scrollTop: 450,
    },
  ];

  computeUserTurnNumbers(turns, 12);

  assert.equal(turns[0].userTurnNumber, 12);
});

test("computeUserTurnNumbers falls back safely to loaded user count when history state is unavailable (SSR safe)", () => {
  const turns = [
    {
      userTurnNumber: 0,
      userMessage: { role: "user", content: "First" },
      scrollTop: 100,
    },
    {
      userTurnNumber: 0,
      userMessage: { role: "user", content: "Second" },
      scrollTop: 200,
    },
  ];

  computeUserTurnNumbers(turns, null);

  assert.equal(turns[0].userTurnNumber, 1);
  assert.equal(turns[1].userTurnNumber, 2);
});

test("createTurnNodes and layoutNodes distribute user nodes predictably", () => {
  const turns = [
    { userTurnNumber: 1, userMessage: { role: "user", content: "1" }, scrollTop: 10 },
    { userTurnNumber: 2, userMessage: { role: "user", content: "2" }, scrollTop: 20 },
    { userTurnNumber: 3, userMessage: { role: "user", content: "3" }, scrollTop: 30 },
  ];
  const nodes = createTurnNodes(turns);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].targetTurn.userTurnNumber, 1);
  assert.equal(nodes[1].targetTurn.userTurnNumber, 2);
  assert.equal(nodes[2].targetTurn.userTurnNumber, 3);

  const layout = layoutNodes(nodes, 600);
  assert.equal(layout.nodes.length, 3);
  assert.equal(layout.nodes[0].topRatio, 12 / 600);
  assert(layout.gap > 0);
});

test("getMinimapHistorySettings falls back to initialTurns>=5 and stepTurns=5 safely", () => {
  const fallback = getMinimapHistorySettings();
  assert.equal(fallback.initialTurns, 5);
  assert.equal(fallback.stepTurns, 5);

  // Mock global settings
  globalThis.window = {
    __PI_ENH_GET_MINIMAP_HISTORY_SETTINGS__: () => ({ initialTurns: 1, stepTurns: 10 }),
  };
  const overridden = getMinimapHistorySettings();
  assert.equal(overridden.initialTurns, 5, "initialTurns must have min clamp of 5");
  assert.equal(overridden.stepTurns, 10);
  delete globalThis.window;
});

test("readMinimapHistoryState strictly respects bridge hasEarlierMessages and session info", () => {
  // 1. SSR / no bridge
  const ssr = readMinimapHistoryState(4);
  assert.equal(ssr.sessionId, "current");
  assert.equal(ssr.totalTurns, 4);
  assert.equal(ssr.hasEarlierMessages, false);

  // 2. Bridge available
  globalThis.window = {
    __PI_ENH_GET_HISTORY_STATE__: () => ({
      sessionId: "session-xyz",
      totalTurns: 20,
      hasEarlierMessages: true,
    }),
  };
  const bridged = readMinimapHistoryState(5);
  assert.equal(bridged.sessionId, "session-xyz");
  assert.equal(bridged.totalTurns, 20);
  assert.equal(bridged.hasEarlierMessages, true);

  // 3. Invariant: hasEarlier=false stops even if totalTurns > loadedTurns
  globalThis.window = {
    __PI_ENH_GET_HISTORY_STATE__: () => ({
      sessionId: "session-xyz",
      totalTurns: 50,
      hasEarlierMessages: false,
    }),
  };
  const stopped = readMinimapHistoryState(5);
  assert.equal(stopped.totalTurns, 50);
  assert.equal(stopped.hasEarlierMessages, false, "Must not infer hasEarlierMessages solely from totalTurns");
  delete globalThis.window;
});
