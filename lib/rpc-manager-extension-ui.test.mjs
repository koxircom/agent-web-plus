import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, handler = async () => {}) {
  let ui;
  const errors = [];
  const inner = {
    sessionId: "extension-ui-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: {}, abort() {} },
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
    // Use the SDK's actual command dispatch and idle-agent abort paths.
    prompt: AgentSession.prototype.prompt,
    _tryExecuteExtensionCommand: AgentSession.prototype._tryExecuteExtensionCommand,
    abort: AgentSession.prototype.abort,
    waitForIdle: AgentSession.prototype.waitForIdle,
    _extensionRunner: {
      getCommand: () => ({ handler: () => handler(ui) }),
      createCommandContext: () => ({}),
      emitError: (error) => errors.push(error),
    },
    extensionRunner: {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  ui = wrapper.createExtensionUiContext();
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, ui, events, errors };
}

for (const method of ["select", "confirm", "input", "editor", "custom"]) {
  test(`Stop unwinds a command waiting on ${method} and closes its UI`, async (t) => {
    let continued = false;
    let disposed = 0;
    const { wrapper, events, errors } = setup(t, async (ui) => {
      if (method === "custom") {
        await ui.custom(() => ({ render: () => ["Choose"], dispose: () => { disposed += 1; } }));
      } else {
        await ui[method]("Choose", method === "select" ? ["A", "B"] : "Details");
      }
      continued = true;
    });
    const sending = wrapper.send({ type: "prompt", message: "/choose" });
    await nextTurn();
    const request = events.find((event) => event.method === method);
    assert.ok(request);
    assert.equal(wrapper.isRunning(), true);

    await wrapper.send({ type: "abort" });
    await sending;
    await nextTurn();
    assert.equal(continued, false);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(wrapper.pendingUiRequests.size, 0);
    assert.equal(wrapper.pendingUiResponses.size, 0);
    assert.equal(wrapper.activeCustomUis.size, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /cancelled by Stop/);
    assert.ok(events.some((event) => event.id === request.id && (event.type === "extension_ui_closed" || event.closed)));
    assert.ok(events.some((event) => event.type === "prompt_done"));
    assert.equal(disposed, method === "custom" ? 1 : 0);
    const replay = [];
    wrapper.onEvent((event) => replay.push(event))();
    assert.equal(replay.some((event) => event.id === request.id), false);

    // A later explicit command can ask again; answering still resumes it.
    const nextSending = wrapper.send({ type: "prompt", message: "/choose" });
    await nextTurn();
    const nextRequest = events.findLast((event) => event.method === method && !event.closed);
    assert.notEqual(nextRequest.id, request.id);
    if (method === "custom") wrapper.closeCustomUi(nextRequest.id, "A");
    else await wrapper.send({ type: "extension_ui_response", id: nextRequest.id, value: "A", confirmed: true });
    await nextSending;
    assert.equal(continued, true);
  });
}

test("normal cancel and caller abort keep UI defaults and notify all subscribers", async (t) => {
  const { wrapper, ui, events } = setup(t);
  const pending = ui.select("Choose", ["A"]);
  const request = events.at(-1);
  await wrapper.send({ type: "extension_ui_response", id: request.id, cancelled: true });
  assert.equal(await pending, undefined);
  assert.deepEqual(events.at(-1), { type: "extension_ui_closed", id: request.id });

  const controller = new AbortController();
  const confirm = ui.confirm("Confirm", "Continue?", { signal: controller.signal });
  controller.abort();
  assert.equal(await confirm, false);
  assert.equal(wrapper.pendingUiRequests.size, 0);
});

test("fast interaction snapshots share live SSE requests and forget answered questions", async (t) => {
  const { wrapper, ui, events } = setup(t);
  assert.deepEqual(wrapper.getPendingExtensionUiRequests(), []);
  const choice = ui.select("Choose", ["A"]);
  const request = events.at(-1);
  assert.deepEqual(wrapper.getPendingExtensionUiRequests(), [request]);
  // Mutating the returned array must not change the live pending map.
  wrapper.getPendingExtensionUiRequests().pop();
  assert.equal(wrapper.getPendingExtensionUiRequests().length, 1);
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "A" });
  await choice;
  assert.deepEqual(wrapper.getPendingExtensionUiRequests(), []);

  const custom = ui.custom(() => ({ render: () => ["Choose custom"] }));
  await nextTurn();
  const customRequest = events.findLast(event => event.method === "custom");
  assert.deepEqual(wrapper.getPendingExtensionUiRequests(), [customRequest]);
  wrapper.closeCustomUi(customRequest.id, "A");
  await custom;
  assert.deepEqual(wrapper.getPendingExtensionUiRequests(), []);
});

test("Stop cancels a custom UI factory that has not mounted yet", async (t) => {
  const { wrapper, ui, events } = setup(t);
  let finishFactory;
  let disposed = false;
  const pending = ui.custom(() => new Promise((resolve) => { finishFactory = resolve; }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await nextTurn();
  await wrapper.send({ type: "abort" });
  await rejected;
  finishFactory({ render: () => ["Late panel"], dispose: () => { disposed = true; } });
  await nextTurn();
  assert.equal(disposed, true);
  assert.equal(events.some((event) => event.method === "custom"), false);
  assert.equal(wrapper.activeCustomUis.size, 0);
  await assert.rejects(ui.select("Reopen after Stop", ["A"]), { name: "AbortError" });
});

test("Stop before custom UI initialization does not invoke the factory", async (t) => {
  const { wrapper, ui } = setup(t);
  let invoked = false;
  const pending = ui.custom(() => { invoked = true; return { render: () => [] }; });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await wrapper.send({ type: "abort" });
  await rejected;
  assert.equal(invoked, false);
});


test("Pi-Droid readiness is silent while actionable and requested notifications remain visible", (t) => {
  const { ui, events } = setup(t);
  const ready = "Pi-Droid ready — 36 tools registered, no app adaptors";
  ui.notify(ready, "info");
  ui.notify(ready, "info");
  ui.notify("Pi-Droid ready — 40 tools registered, 1 app adaptor(s): telegram", "info");
  assert.equal(events.length, 0);

  const retained = [
    ["设备连接失败，请检查连接。", "error"],
    ["缺少设备控制权限。", "warning"],
    ["设备状态：连接正常。", "info"],
    [ready, "warning"],
    [ready, "error"],
    ["Pi-Droid ready — 36 tools registered, no app adaptors\n设备连接失败", "info"],
  ];
  for (const [message, type] of retained) ui.notify(message, type);
  assert.deepEqual(events.map(({ message, notifyType }) => [message, notifyType]), retained);
});


test("optional mail discovery is diagnostic while invoked mail failures remain visible", (t) => {
  const { ui, events } = setup(t);
  ui.notify("Pi Mail presence could not start; peer discovery may be unavailable.", "warning");
  assert.equal(events.length, 0);
  ui.notify("邮件协作操作失败：无法写入邮件目录。", "error");
  ui.notify("Pi Mail presence could not start; peer discovery may be unavailable.", "error");
  assert.equal(events.length, 2);
});
