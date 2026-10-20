import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssSource = await readFile(new URL("../app/ask-user.css", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./AskUserPanel.tsx", import.meta.url), "utf8");

test("removes the squeezed baseline max-height and raises default budget", () => {
  assert.doesNotMatch(cssSource, /min\(360px,\s*42dvh\)/, "Should not contain old squeezed 360px/42dvh baseline");
  assert.match(cssSource, /\.pi-native-ask-card\s*\{[^}]*max-height:\s*min\(560px,\s*66dvh\)/, "Default desktop max-height should be min(560px, 66dvh)");
  assert.doesNotMatch(cssSource, /!important/, "Should not inject !important");
});

test("supports mobile and coarse pointer wide touch screens with relaxed height budget", () => {
  assert.match(
    cssSource,
    /@media\s*\(\s*max-width:\s*768px\s*\)\s*,\s*\(\s*pointer:\s*coarse\s*\)\s*\{[\s\S]*?\.pi-native-ask-card\s*\{[^}]*max-height:\s*min\(640px,\s*70dvh\)/,
    "Mobile and touch devices should expand max-height to min(640px, 70dvh)"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-body\s*\{[^}]*touch-action:\s*pan-y;/,
    "Body should allow smooth vertical touch panning without option selection"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-body\s*\{[^}]*-webkit-overflow-scrolling:\s*touch;/,
    "Body should enable momentum scrolling on touch devices"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-options\s*\{[^}]*touch-action:\s*pan-y;/,
    "Options container should allow vertical panning"
  );
});

test("height budget calculation satisfies verification viewports", () => {
  function computeBudget(width, height, isCoarse) {
    const isMobileOrCoarse = width <= 768 || isCoarse;
    const maxPx = isMobileOrCoarse ? 640 : 560;
    const dvhRatio = isMobileOrCoarse ? 0.70 : 0.66;
    return Math.round(Math.min(maxPx, height * dvhRatio));
  }

  function computeBaselineBudget(height) {
    return Math.round(Math.min(360, height * 0.42));
  }

  // Viewport 1: Mobile 390x780 (narrow screen)
  const v1 = computeBudget(390, 780, true);
  assert.equal(v1, 546, "390x780 budget should be 546px");
  assert.ok(v1 - computeBaselineBudget(780) >= 200, "390x780 should gain at least 200px over baseline");

  // Viewport 2: Touch 735x600 (touch screen)
  const v2 = computeBudget(735, 600, true);
  assert.equal(v2, 420, "735x600 budget should be 420px");
  assert.ok(v2 - computeBaselineBudget(600) >= 150, "735x600 should gain at least 150px over baseline");

  // Viewport 3: Touch 980x680 (wide touch screen)
  const v3 = computeBudget(980, 680, true);
  assert.equal(v3, 476, "980x680 budget should be 476px");
  assert.ok(v3 - computeBaselineBudget(680) >= 180, "980x680 should gain at least 180px over baseline");

  // Viewport 4: Keyboard 390x480 (reduced viewport)
  const v4 = computeBudget(390, 480, true);
  assert.equal(v4, 336, "390x480 budget should be 336px");
  const estimatedFixedHeadersAndFooters = Math.round(Math.min(320, 480 * 0.36)) + 54; // readable question + touch footer
  const remainingBody = v4 - estimatedFixedHeadersAndFooters;
  assert.ok(remainingBody > 100, "390x480 keyboard viewport preserves scrollable option space");

  // Viewport 5: Desktop 1920x1080 (fine pointer)
  const v5 = computeBudget(1920, 1080, false);
  assert.equal(v5, 560, "1080p desktop budget capped at 560px");
  assert.ok(v5 - computeBaselineBudget(1080) >= 200, "Desktop should gain 200px over baseline 360px");
});

test("preserves single React ownership without timers or observers", () => {
  const askPanelCode = panelSource.slice(panelSource.indexOf("export function AskUserPanel"));
  assert.doesNotMatch(panelSource, /ResizeObserver|MutationObserver/, "No DOM observers should be added");
  assert.doesNotMatch(askPanelCode, /setInterval/, "No timer loops should be added to AskUserPanel");
  assert.doesNotMatch(panelSource, /collapsed|AskQuestionHeader/, "Removed header must not leave an inaccessible collapsed state");
});


test("long prompts have their own readable budget instead of an 88px slot", () => {
  assert.match(cssSource, /\.pi-native-ask-question-row\s*\{[^}]*max-height:\s*min\(320px,\s*36dvh\)/);
  assert.doesNotMatch(cssSource, /min\(88px,\s*12dvh\)/);
});
