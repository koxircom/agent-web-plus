import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { normalizeDomFeedbackFrameEvent } = await createJiti(import.meta.url).import("./frame-protocol.ts");

function target() {
  return {
    version: 1,
    selector: '[data-testid="preview-save"]',
    selectorKind: "testid",
    tag: "button",
    role: "button",
    attributes: { "data-testid": "preview-save", role: "button" },
    visibleText: "Save preview",
    parentSummary: "Preview Save preview",
    rect: { x: 12, y: 30, width: 80, height: 32 },
    viewport: { width: 900, height: 700 },
    source: {
      pageUrl: "file:///workspace/demo.html?temporary=secret#section",
      filePath: "/workspace/demo.html",
      sourceSessionId: "untrusted-session",
      executionEngine: "codex",
      page: 3,
    },
  };
}

test("accepts a controlled iframe target only from its exact window and token", () => {
  const contentWindow = {};
  const frame = { contentWindow, dataset: { domFeedbackToken: "frame-token", domFeedbackFilePath: "/trusted/preview.html" } };
  const event = { source: contentWindow, data: { type: "pi-dom-feedback-target", token: "frame-token", target: target() } };
  const result = normalizeDomFeedbackFrameEvent(event, frame, { sourceSessionId: "codex:active", executionEngine: "pi" });

  assert.equal(result.source.sourceSessionId, "codex:active");
  assert.equal(result.source.executionEngine, "pi");
  assert.equal(result.source.filePath, "/trusted/preview.html", "the host iframe registration owns the source path");
  assert.equal(result.source.pageUrl, "file:///workspace/demo.html");
  assert.equal(result.source.page, 3);
  assert.equal(normalizeDomFeedbackFrameEvent({ ...event, source: {} }, frame, {}), null);
  assert.equal(normalizeDomFeedbackFrameEvent({ ...event, data: { ...event.data, token: "other" } }, frame, {}), null);
  assert.equal(normalizeDomFeedbackFrameEvent({ ...event, data: { ...event.data, type: "other" } }, frame, {}), null);

  const unregisteredFrame = { contentWindow, dataset: { domFeedbackToken: "frame-token" } };
  assert.equal(normalizeDomFeedbackFrameEvent(event, unregisteredFrame, {}).source.filePath, null,
    "missing host file metadata remains unknown instead of trusting frame payload");
});

test("rejects malformed bridge payloads and does not trust source identity supplied by the frame", () => {
  const contentWindow = {};
  const frame = { contentWindow, dataset: { domFeedbackToken: "frame-token" } };
  const event = { source: contentWindow, data: { type: "pi-dom-feedback-target", token: "frame-token", target: target() } };
  assert.equal(normalizeDomFeedbackFrameEvent({ ...event, data: { ...event.data, target: { ...target(), extra: "bad" } } }, frame, {}), null);

  const result = normalizeDomFeedbackFrameEvent(event, frame, {});
  assert.equal(result.source.sourceSessionId, null);
  assert.equal(result.source.executionEngine, "unknown");
});
