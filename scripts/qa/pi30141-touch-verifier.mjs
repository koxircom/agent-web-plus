const WIDTHS = [390, 800, 1124];
const ENGINES = ["pi", "codex"];
const SAMPLE_WINDOW_MS = 400;
const MIN_POST_FRAMES = 2;

function fail(message) {
  throw new Error(`Invalid Windows touch receipt: ${message}`);
}

export function resolveBuildId(rscBuildIds) {
  const unique = [...new Set(rscBuildIds.filter((value) => typeof value === "string" && value))];
  if (unique.length === 1) return { buildId: unique[0], source: "unique-rsc-b" };
  return { buildId: null, source: unique.length ? "ambiguous-rsc-b" : "unavailable" };
}

export function extractRscBuildIds(html) {
  return [...String(html).matchAll(/\\"b\\":\\"([^\\"]+)/g)].map((match) => match[1]);
}

function assertProbeEnvelope(result) {
  if (result?.schemaVersion !== 1 || !Array.isArray(result.frames) || result.frames.length < 3 || !Array.isArray(result.touchEvents)) fail("incomplete interaction evidence");
  if (!result.mutationObserver || !Array.isArray(result.mutationObserver.transitions)) fail("file-panel MutationObserver evidence is missing");
  if (!Number.isFinite(result.postGestureDurationMs) || result.postGestureDurationMs < SAMPLE_WINDOW_MS || !Number.isInteger(result.postGestureFrames) || result.postGestureFrames < MIN_POST_FRAMES) fail("post-gesture sampling is too short");
  const measured = result.viewport?.measured;
  if (!measured || !Number.isFinite(measured.width) || !Number.isFinite(measured.height) || !Number.isFinite(measured.dpr) || !Number.isFinite(measured.touches)) fail("measured CSS viewport, DPR, or touch count is missing");
}

export function assertNoFlashEvidence(result) {
  assertProbeEnvelope(result);
  if (result.frames.some((frame) => frame.panelVisible) || result.mutationObserver.transitions.some((transition) => transition.panelVisible)) fail("the panel flashed during the gesture");
  if (!result.touchEvents.some((event) => event.trusted && event.type === "touchstart" && event.touchCount === 3)) fail("trusted three-finger touchstart was not delivered");
  const terminal = result.gesture === "cancel" ? "touchcancel" : result.gesture === "end" ? "touchend" : null;
  if (!terminal || !result.touchEvents.some((event) => event.trusted && event.type === terminal && event.touchCount === 0)) fail(`trusted ${terminal || "terminal"} event was not delivered`);
  if (result.finalPanelOpen !== false) fail("the panel did not finish closed");
}

export function assertLongPressEvidence(result) {
  assertProbeEnvelope(result);
  if (result.gesture !== "longPress" || result.inputOrigin !== "ego_browser_cdp_touch_dispatch" || result.holdMs < 1000 || !result.touchEvents.some((event) => event.trusted && event.type === "touchstart" && event.touchCount === 1) || !result.touchEvents.some((event) => event.trusted && event.type === "touchend" && event.touchCount === 0)) fail("native long-press touch events are missing");
  if (!result.nativeSelection || typeof result.contextMenuSeen !== "boolean" || typeof result.cancelDelivered !== "boolean") fail("native long-press capability evidence is incomplete");
  if (result.frames.some((frame) => frame.panelVisible) || result.mutationObserver.transitions.some((transition) => transition.panelVisible) || result.finalPanelOpen) fail("the panel opened or flashed during text selection");
}

export function assertSelectedTextCancelEvidence(result) {
  assertProbeEnvelope(result);
  if (result.gesture !== "selectedTextControlledCancel" || result.cancelOrigin !== "test_harness_cdp_controlled") fail("selected-text cancellation is not labeled as controlled CDP input");
  const before = result.selectionBeforeCancel;
  const after = result.selectionAfterCancel;
  if (!before?.observed || !before.insideTarget || !after?.observed || !after.insideTarget || !Number.isInteger(before.selectedLength) || before.selectedLength <= 0 || !Number.isInteger(after.selectedLength) || after.selectedLength !== before.selectedLength) fail("native selection was not preserved with the same selected text");
  if (!result.touchEvents.some((event) => event.trusted && event.type === "touchstart" && event.touchCount === 1) || !result.touchEvents.some((event) => event.trusted && event.type === "touchcancel" && event.touchCount === 0)) fail("controlled touch events are missing");
  if (result.frames.some((frame) => frame.panelVisible) || result.mutationObserver.transitions.some((transition) => transition.panelVisible) || result.finalPanelOpen) fail("the panel opened or flashed during selected-text cancellation");
}

function verifyCase(item, engine, width, gesture) {
  if (!item || item.schemaVersion !== 1 || item.engine !== engine || item.gesture !== gesture) fail(`missing ${engine}/${width}/${gesture} current-schema case`);
  const viewport = item.viewport;
  if (viewport?.requestedCss?.width !== width || viewport?.measured?.width !== width || viewport?.measured?.height !== viewport?.requestedCss?.height || !Number.isFinite(viewport?.measured?.dpr) || viewport.measured.dpr <= 0 || viewport?.measured?.touches < 3) {
    fail(`${engine}/${width}/${gesture} did not use the measured ${width}px CSS viewport and touch input`);
  }
  if (!Array.isArray(item.frames) || item.frames.length < 3 || item.frames.some((frame) => typeof frame.panelVisible !== "boolean" || frame.panelVisible)) fail(`${engine}/${width}/${gesture} contains a panel-visible frame or lacks frame samples`);
  if (!item.mutationObserver || item.mutationObserver.target !== "file-panel" || !Array.isArray(item.mutationObserver.transitions)) fail(`${engine}/${width}/${gesture} lacks the current file-panel MutationObserver trace`);
  if (item.mutationObserver.transitions.some((transition) => !["class", "style"].includes(transition.attribute) || typeof transition.panelVisible !== "boolean" || transition.panelVisible)) fail(`${engine}/${width}/${gesture} contains a panel-visible or malformed class/style transition`);
  if (!Number.isFinite(item.postGestureDurationMs) || item.postGestureDurationMs < 400 || !Number.isInteger(item.postGestureFrames) || item.postGestureFrames < 2) fail(`${engine}/${width}/${gesture} ended sampling too early`);
  if (item.finalPanelOpen !== false) fail(`${engine}/${width}/${gesture} did not finish with the panel closed`);
  if (!Array.isArray(item.touchEvents)) fail(`${engine}/${width}/${gesture} lacks delivered browser touch events`);
  if (!item.touchEvents.some((event) => event.trusted && event.type === "touchstart" && event.touchCount === 3)) fail(`${engine}/${width}/${gesture} did not deliver a trusted three-finger start`);
  const terminal = gesture === "cancel" ? "touchcancel" : "touchend";
  if (!item.touchEvents.some((event) => event.trusted && event.type === terminal && event.touchCount === 0)) fail(`${engine}/${width}/${gesture} did not deliver a trusted ${terminal}`);
}

export function verifyTouchReceipt(receipt, expected) {
  if (!receipt || receipt.schemaVersion !== 1 || receipt.status !== "passed") fail("missing current schema or successful gate status");
  if (!Array.isArray(receipt.failures) || receipt.failures.length !== 0) fail("receipt contains failures or lacks the failure ledger");
  if (!expected || !expected.expectedBuildId || !/^[a-f0-9]{64}$/i.test(expected.expectedAssetSha256 || "")) fail("expected build ID and asset SHA-256 are required");
  if (receipt.browser?.isWindows !== true || !/windows|win32|win64/i.test(`${receipt.browser?.platform || ""} ${receipt.browser?.userAgent || ""}`)) fail("Windows browser identity is missing");
  if (receipt.build?.buildId !== expected.expectedBuildId) fail("build ID is stale or mismatched");
  if (receipt.build?.buildIdSource !== "unique-rsc-b") fail("the live unique RSC build marker is missing");
  const actualAsset = receipt.build?.assetFingerprint;
  if (actualAsset?.sha256 !== expected.expectedAssetSha256.toLowerCase() || actualAsset?.loadedByCurrentPage !== true) fail("asset SHA-256 is stale, mismatched, or was not loaded by the current page");
  if (expected.expectedAssetUrl && actualAsset.url !== expected.expectedAssetUrl) fail("asset URL is stale or mismatched");
  const engines = expected.engines || ENGINES;
  const widths = expected.widths || WIDTHS;
  if (JSON.stringify(engines) !== JSON.stringify(ENGINES) || JSON.stringify(widths) !== JSON.stringify(WIDTHS)) fail("the fixed Pi/Codex by 390/800/1124 matrix is required");
  for (const engine of engines) {
    const engineBuild = receipt.buildByEngine?.[engine];
    if (engineBuild?.buildId !== expected.expectedBuildId || engineBuild.buildIdSource !== "unique-rsc-b" || engineBuild.assetFingerprint?.sha256 !== expected.expectedAssetSha256.toLowerCase() || engineBuild.assetFingerprint?.loadedByCurrentPage !== true) {
      fail(`${engine} build or asset fingerprint is stale or missing`);
    }
  }

function verifyLongPress(item, engine, width) {
  if (!item || item.schemaVersion !== 1 || item.engine !== engine || item.gesture !== "longPress") fail(`missing ${engine}/${width}/longPress case`);
  assertLongPressEvidence(item);
  if (item.viewport?.requestedCss?.width !== width || item.viewport?.measured?.width !== width) fail(`${engine}/${width} longPress viewport mismatch`);
}

function verifySelectedTextCancel(item, engine, width) {
  if (!item || item.schemaVersion !== 1 || item.engine !== engine || item.gesture !== "selectedTextControlledCancel" || item.status !== "observed") fail(`missing observed ${engine}/${width} selected-text cancel case`);
  assertSelectedTextCancelEvidence(item);
  if (item.viewport?.requestedCss?.width !== width || item.viewport?.measured?.width !== width) fail(`${engine}/${width} selected-text viewport mismatch`);
}
  const requiredCount = engines.length * widths.length * 2;
  const requiredCases = receipt.cases?.filter((item) => item.gesture === "cancel" || item.gesture === "end");
  if (!Array.isArray(requiredCases) || requiredCases.length !== requiredCount) fail(`expected exactly ${requiredCount} cancel/end cases`);
  const keys = new Set();
  for (const engine of engines) {
    for (const width of widths) {
      for (const gesture of ["cancel", "end"]) {
        const key = `${engine}/${width}/${gesture}`;
        const matching = requiredCases.filter((item) => item.engine === engine && item.viewport?.requestedCss?.width === width && item.gesture === gesture);
        if (matching.length !== 1 || keys.has(key)) fail(`missing or duplicate ${key}`);
        verifyCase(matching[0], engine, width, gesture);
        keys.add(key);
      }
      const longPress = receipt.cases.filter((item) => item.engine === engine && item.gesture === "longPress" && item.viewport?.requestedCss?.width === width);
      const selected = receipt.cases.filter((item) => item.engine === engine && item.gesture === "selectedTextControlledCancel" && item.viewport?.requestedCss?.width === width);
      if (longPress.length !== 1 || selected.length !== 1) fail(`missing or duplicate ${engine}/${width} long-press contract cases`);
      verifyLongPress(longPress[0], engine, width);
      verifySelectedTextCancel(selected[0], engine, width);
    }
  }
  return { status: "passed", requiredCaseCount: requiredCount, engines, widths, buildId: receipt.build.buildId, assetSha256: actualAsset.sha256 };
}
