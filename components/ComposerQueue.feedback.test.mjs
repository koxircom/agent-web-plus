import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./ComposerQueue.tsx", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../hooks/useComposerQueueBridge.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("./ComposerQueue.css", import.meta.url), "utf8");

test("successful queue actions have no feedback callback, state or timer", () => {
  assert.doesNotMatch(bridge, /onToast|已转为立即引导|已移回输入框编辑|已全部移回输入框编辑/);
  assert.doesNotMatch(source, /feedbackTimer|setFeedback|onToast|type:\s*"(?:info|success)"/);
});

test("real errors keep a single nonempty alert outside queue layout flow", () => {
  assert.match(bridge, /setErrorMessage\(msg\)/);
  assert.match(source, /setReorderError\("队列排序确认超时，请刷新同步"\)/);
  assert.match(source, /const errorMessage = \(reorderError \|\| bridge.errorMessage \|\| ""\)\.trim\(\)/);
  assert.match(source, /\{errorMessage && \([\s\S]*?role="alert" className="pi-enh-queue-feedback pi-enh-queue-error"/);
  assert.match(css, /\.pi-enh-queue-error\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.pi-enh-queue-list:empty\s*\{\s*display:\s*none/);
});

test("two-click deletion confirmation remains independent from removed feedback", () => {
  assert.match(source, /confirmation\?\.signature === signature && confirmation\.index === originalIdx/);
  assert.match(source, /confirmTimer\.current = setTimeout\(\(\) => setConfirmation\(null\), 3500\)/);
  assert.match(source, /confirming \? "再次点击确认删除" : "删除此排队消息"/);
});
