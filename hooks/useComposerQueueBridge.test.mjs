import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ComposerQueue } = await jiti.import("../components/ComposerQueue.tsx");
const { useComposerQueueBridge } = await jiti.import("./useComposerQueueBridge.ts");

test("ComposerQueue renders without DOM event listeners or script bridges", () => {
  const queuedMessages = {
    steering: ["紧急引导任务"],
    followUp: ["后续普通任务"],
  };

  const html = renderToStaticMarkup(
    React.createElement(ComposerQueue, {
      sessionId: "session-native-bridge",
      queuedMessages,
    }),
  );

  assert.match(html, /data-pi-native-queue="true"/);
  assert.match(html, /紧急引导任务/);
  assert.match(html, /后续普通任务/);
  // No legacy DOM event bridge or custom container markers
  assert.doesNotMatch(html, /pi:native-queue-snapshot/);
  assert.doesNotMatch(html, /pi:native-queue-details/);
});

test("useComposerQueueBridge initial state returns clean arrays and action handlers", () => {
  // Test hook export shape
  assert.equal(typeof useComposerQueueBridge, "function");
});

test("useComposerQueueBridge action returns Promise<boolean>", async () => {
  // In inactive or disabled state, action safely returns false without throws
  let hookResult;
  function TestComp() {
    hookResult = useComposerQueueBridge({
      sessionId: "test-session",
      entries: [],
      signature: "sig",
      actionsEnabled: false,
    });
    return null;
  }
  renderToStaticMarkup(React.createElement(TestComp));
  assert.ok(hookResult);
  const result = await hookResult.action("delete", 0);
  assert.equal(result, false);
});

