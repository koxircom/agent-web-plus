import assert from "node:assert/strict";
import { extractRscBuildIds, resolveBuildId, assertLongPressEvidence, assertNoFlashEvidence, assertSelectedTextCancelEvidence, verifyTouchReceipt } from "./pi30141-touch-verifier.mjs";

const assetSha256 = "a".repeat(64);
const expected = { expectedBuildId: "build-61", expectedAssetSha256: assetSha256 };

function makeCase(engine, width, gesture) {
  const terminal = gesture === "cancel" ? "touchcancel" : "touchend";
  return {
    schemaVersion: 1,
    engine,
    gesture,
    viewport: {
      requestedCss: { width, height: 1000 },
      measured: { width, height: 1000, dpr: 1.5, touches: 5 },
    },
    touchEvents: [
      { type: "touchstart", trusted: true, touchCount: 1 },
      { type: "touchstart", trusted: true, touchCount: 3 },
      { type: terminal, trusted: true, touchCount: 0 },
    ],
    frames: [{ panelVisible: false }, { panelVisible: false }, { panelVisible: false }],
    mutationObserver: { target: "file-panel", transitions: [] },
    postGestureDurationMs: 416,
    postGestureFrames: 2,
    finalPanelOpen: false,
  };
}

function makeLongPress(engine, width) {
  return {
    ...makeCase(engine, width, "longPress"),
    touchEvents: [{ type: "touchstart", trusted: true, touchCount: 1 }, { type: "touchend", trusted: true, touchCount: 0 }],
    nativeSelection: { observed: false, insideTarget: false, selectedLength: 0 },
    contextMenuSeen: false,
    cancelDelivered: false,
    inputOrigin: "ego_browser_cdp_touch_dispatch",
    holdMs: 1000,
  };
}

function makeSelectedTextCancel(engine, width) {
  return {
    ...makeCase(engine, width, "selectedTextControlledCancel"),
    status: "observed",
    touchEvents: [{ type: "touchstart", trusted: true, touchCount: 1 }, { type: "touchcancel", trusted: true, touchCount: 0 }],
    cancelOrigin: "test_harness_cdp_controlled",
    selectionBeforeCancel: { observed: true, insideTarget: true, selectedLength: 4 },
    selectionAfterCancel: { observed: true, insideTarget: true, selectedLength: 4 },
    inputOrigin: "native_mouse_double_click_then_ego_cdp_touch_dispatch",
  };
}

function makeReceipt() {
  const build = {
    buildId: expected.expectedBuildId,
    buildIdSource: "unique-rsc-b",
    assetFingerprint: { url: "/_next/static/chunks/app.js", sha256: assetSha256, loadedByCurrentPage: true },
  };
  return {
    schemaVersion: 1,
    status: "passed",
    failures: [],
    browser: { isWindows: true, platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    build,
    buildByEngine: { pi: build, codex: build },
    cases: ["pi", "codex"].flatMap((engine) => [390, 800, 1124].flatMap((width) => [
      makeCase(engine, width, "cancel"),
      makeCase(engine, width, "end"),
      makeLongPress(engine, width),
      makeSelectedTextCancel(engine, width),
    ])),
  };
}

const receipt = makeReceipt();
assert.equal(verifyTouchReceipt(receipt, expected).requiredCaseCount, 12);
assert.throws(
  () => verifyTouchReceipt({ ...receipt, cases: receipt.cases.filter((item) => !(item.engine === "pi" && item.viewport.requestedCss.width === 390 && item.gesture === "selectedTextControlledCancel")) }, expected),
  /long-press contract cases/,
  "every engine and width must include a selected-text controlled-cancel case",
);
assertNoFlashEvidence(receipt.cases[0]);
assert.throws(
  () => verifyTouchReceipt({ noFlash: true, sampledFrames: 12, touches: receipt.cases[0].touchEvents }, expected),
  /current schema/,
  "legacy round receipts must not satisfy the fixed gate",
);
assert.throws(() => verifyTouchReceipt({ ...receipt, cases: receipt.cases.slice(1) }, expected), /exactly 12 cancel\/end cases/);
assert.throws(() => verifyTouchReceipt(receipt, { ...expected, expectedAssetSha256: "b".repeat(64) }), /asset SHA-256 is stale/);
assert.throws(() => verifyTouchReceipt({ ...receipt, cases: receipt.cases.map((item, index) => index ? item : { ...item, frames: [{ panelVisible: true }, ...item.frames.slice(1)] }) }, expected), /panel-visible frame/);
const rscHtml = String.raw`<script>self.__next_f.push([0,"1:{\"b\":\"iqGll3KXLky8LLHH3yz1j\"}"])</script>`;
assert.deepEqual(extractRscBuildIds(rscHtml), ["iqGll3KXLky8LLHH3yz1j"]);
assert.deepEqual(resolveBuildId(extractRscBuildIds(rscHtml), null), { buildId: "iqGll3KXLky8LLHH3yz1j", source: "unique-rsc-b" });
assert.deepEqual(resolveBuildId([]), { buildId: null, source: "unavailable" }, "generic chunk URLs must not be treated as build IDs");

const oldLongPress = {
  ...makeLongPress("pi", 390),
};
assertLongPressEvidence(oldLongPress);
assert.throws(() => assertLongPressEvidence({ ...oldLongPress, frames: [{ panelVisible: false }, { panelVisible: true }, { panelVisible: false }] }), /opened or flashed/);
assert.throws(() => assertLongPressEvidence({ ...oldLongPress, finalPanelOpen: true }), /opened or flashed/);
assertSelectedTextCancelEvidence({
  ...makeCase("pi", 390, "cancel"),
  gesture: "selectedTextControlledCancel",
  touchEvents: [{ type: "touchstart", trusted: true, touchCount: 1 }, { type: "touchcancel", trusted: true, touchCount: 0 }],
  frames: [{ panelVisible: false }, { panelVisible: false }, { panelVisible: false }],
  finalPanelOpen: false,
  cancelOrigin: "test_harness_cdp_controlled",
  selectionBeforeCancel: { observed: true, insideTarget: true, selectedLength: 4 },
  selectionAfterCancel: { observed: true, insideTarget: true, selectedLength: 4 },
});
assert.throws(() => assertSelectedTextCancelEvidence({ ...oldLongPress, gesture: "selectedTextControlledCancel" }), /controlled CDP input/);
assert.throws(() => assertSelectedTextCancelEvidence({
  ...makeSelectedTextCancel("pi", 390),
  selectionBeforeCancel: { observed: false, insideTarget: false, selectedLength: 0 },
  selectionAfterCancel: { observed: false, insideTarget: false, selectedLength: 0 },
}), /same selected text/);
assert.throws(() => assertSelectedTextCancelEvidence({
  ...makeSelectedTextCancel("pi", 390),
  selectionAfterCancel: { observed: true, insideTarget: true, selectedLength: 3 },
}), /same selected text/);
assert.throws(() => assertSelectedTextCancelEvidence({
  ...makeCase("pi", 390, "cancel"),
  gesture: "selectedTextControlledCancel",
  touchEvents: [{ type: "touchstart", trusted: true, touchCount: 1 }, { type: "touchcancel", trusted: true, touchCount: 0 }],
  frames: [{ panelVisible: false }, { panelVisible: true }, { panelVisible: false }],
  finalPanelOpen: false,
  cancelOrigin: "test_harness_cdp_controlled",
  selectionBeforeCancel: { observed: true, insideTarget: true, selectedLength: 4 },
  selectionAfterCancel: { observed: true, insideTarget: true, selectedLength: 4 },
}), /opened or flashed/);
assert.throws(() => assertSelectedTextCancelEvidence({
  ...makeCase("pi", 390, "cancel"),
  gesture: "selectedTextControlledCancel",
  touchEvents: [{ type: "touchstart", trusted: true, touchCount: 1 }, { type: "touchcancel", trusted: true, touchCount: 0 }],
  frames: [{ panelVisible: false }, { panelVisible: false }, { panelVisible: false }],
  finalPanelOpen: true,
  cancelOrigin: "test_harness_cdp_controlled",
  selectionBeforeCancel: { observed: true, insideTarget: true, selectedLength: 4 },
  selectionAfterCancel: { observed: true, insideTarget: true, selectedLength: 4 },
}), /opened or flashed/);

console.log("touch verifier contract checks passed");
