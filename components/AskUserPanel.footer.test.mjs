import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssSource = await readFile(new URL("../app/ask-user.css", import.meta.url), "utf8");
const panelSource = await readFile(new URL("./AskUserPanel.tsx", import.meta.url), "utf8");

test("removes redundant header and tools from JSX and ask-user.css", () => {
  assert.doesNotMatch(cssSource, /\.pi-native-ask-answer-tools/, "Old answer-tools CSS rule should be deleted");
  assert.doesNotMatch(cssSource, /\.pi-native-ask-header\b/, "Header CSS rule should be deleted");
  assert.doesNotMatch(cssSource, /\.pi-native-ask-heading\b/, "Heading CSS rule should be deleted");
  assert.doesNotMatch(cssSource, /\.pi-native-ask-close\b/, "Close button CSS rule should be deleted");
  assert.doesNotMatch(cssSource, /\.pi-native-ask-link\b/, "Link button CSS rule should be deleted");
  assert.doesNotMatch(cssSource, /\.pi-native-ask-footer-tools\b/, "Footer tools container CSS should be deleted");
  assert.doesNotMatch(panelSource, /AskQuestionHeader/, "AskQuestionHeader component should be eliminated");
  assert.doesNotMatch(panelSource, /pi-native-ask-footer-tools/, "Footer tools container should be removed from JSX");
  assert.doesNotMatch(panelSource, /notesOpen|collapsed/, "Old notes toggles and inaccessible collapsed state must be removed");
  assert.match(panelSource, /request.method === "custom" \? "取消" : "稍后回答"/, "Async questions defer without cancelling the native task");
  assert.doesNotMatch(panelSource, />\s*直接回答\s*<\/button>/, "Direct answer button should be removed");
  assert.doesNotMatch(panelSource, /补充回答/, "Add notes button should be removed");
});

test("custom answer input resides inside footer with persistent visibility and accessibility", () => {
  const askPanelSlice = panelSource.slice(panelSource.indexOf("export function AskUserPanel"));
  const bodySlice = askPanelSlice.slice(askPanelSlice.indexOf('className="pi-native-ask-body"'));
  const footerStart = bodySlice.indexOf('className="pi-native-ask-footer"');
  const bodyContent = bodySlice.slice(0, footerStart);

  assert.doesNotMatch(bodyContent, /pi-native-ask-notes/, "Notes container must not duplicate inside selection body");
  assert.match(askPanelSlice, /<input[^>]*aria-label="自定义回答"/, "Input has accessible label '自定义回答'");
  assert.match(askPanelSlice, /placeholder=\{question.allowFreeform \? "自定义回答…" : "补充说明…"\}/, "Input respects freeform versus comment-only tool intent");
});

test("footer consolidates custom input and actions on the same row with exact button heights", () => {
  const askPanelSlice = panelSource.slice(panelSource.indexOf("export function AskUserPanel"));
  assert.match(askPanelSlice, /className="pi-native-ask-footer-actions"/, "Footer has actions row container");
  assert.match(askPanelSlice, /className="pi-native-ask-footer-main"/, "Footer has right main actions container");
  assert.match(askPanelSlice, /className="pi-native-ask-cancel"/, "Cancel button present");
  assert.match(askPanelSlice, /className="pi-native-ask-submit"/, "Submit button present");

  // Single control height variable on card (desktop 40px)
  assert.match(
    cssSource,
    /\.pi-native-ask-card\s*\{[^}]*--pi-native-ask-control-height:\s*40px;/,
    "Desktop card declares single source of truth --pi-native-ask-control-height: 40px"
  );

  // Shared sizing rules across input, cancel, and submit
  assert.match(
    cssSource,
    /\.pi-native-ask-input,\s*\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?height:\s*var\(--pi-native-ask-control-height\);[\s\S]*?min-height:\s*var\(--pi-native-ask-control-height\);[\s\S]*?max-height:\s*var\(--pi-native-ask-control-height\);/,
    "Input, cancel, and submit share unified box-sizing and control height variable"
  );
});

test("footer hint occupies an independent line only when busy, error, or timer content is present", () => {
  assert.match(panelSource, /\{hint \? <div className="pi-native-ask-hint" role="status">\{hint\}<\/div> : null\}/, "AskUserPanel renders hint only when non-empty");
  assert.match(panelSource, /\{expiresHint \? <div className="pi-native-ask-hint" role="status">\{expiresHint\}<\/div> : null\}/, "AskUserTextPanel renders hint only when non-empty");
  assert.doesNotMatch(cssSource, /!important/, "No !important override injected");
});

test("restrains button border radius from 999px pill to compact small rounded corners", () => {
  assert.doesNotMatch(cssSource, /border-radius:\s*999px/, "Pill border radius 999px must be eliminated");
  assert.match(cssSource, /\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[^}]*border-radius:\s*8px;/, "Cancel and submit buttons use restrained 8px border radius");
});

test("maintains 44px touch height for options and buttons at 44px on touch devices", () => {
  assert.match(
    cssSource,
    /@media\s*\(\s*max-width:\s*768px\s*\)\s*,\s*\(\s*pointer:\s*coarse\s*\)\s*\{[\s\S]*?\.pi-native-ask-option\s*\{[^}]*min-height:\s*44px;/,
    "Touch devices must preserve 44px touch height for selectable options"
  );
  assert.match(
    cssSource,
    /@media\s*\(\s*max-width:\s*768px\s*\)\s*,\s*\(\s*pointer:\s*coarse\s*\)\s*\{[\s\S]*?\.pi-native-ask-card\s*\{[^}]*--pi-native-ask-control-height:\s*44px;/,
    "Touch devices update --pi-native-ask-control-height to 44px for reliable touch targets"
  );

  const mobileBlockMatch = cssSource.match(/@media\s*\(\s*max-width:\s*768px\s*\)\s*,\s*\(\s*pointer:\s*coarse\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(mobileBlockMatch, "Mobile media query block must exist");
  const mobileCss = mobileBlockMatch[1];

  assert.doesNotMatch(
    mobileCss,
    /(?:\.pi-native-ask-cancel|\.pi-native-ask-submit|\.pi-native-ask-input)\s*\{[^}]*(?:min-|max-)?height:\s*44px;/,
    "Touch devices eliminate duplicate height, min-height, and max-height overrides on controls"
  );

  const footerPaddingMatch = mobileCss.match(/\.pi-native-ask-footer\s*\{[^}]*padding:\s*(\d+)px\s*(\d+)px\s*(\d+)px;/);
  assert.ok(footerPaddingMatch, "Mobile footer padding must be explicitly defined");
  const topPad = Number(footerPaddingMatch[1]);
  const bottomPad = Number(footerPaddingMatch[3]);
  const buttonHeight = 44;
  const normalFooterHeight = buttonHeight + topPad + bottomPad;

  assert.ok(normalFooterHeight <= 56, `Normal touch footer height (${normalFooterHeight}px) must be <= 56px`);
});

test("prevents horizontal overflow with responsive wrapping and supports 390px/320px screens", () => {
  assert.match(cssSource, /\.pi-native-ask-input\s*\{[^}]*flex:\s*1\s+1\s+0%/, "Input must have flex: 1 1 0% to fit single row");
  assert.match(cssSource, /\.pi-native-ask-input\s*\{[^}]*min-width:\s*0;/, "Input must have min-width: 0 to prevent overflowing narrow viewports");

  // Width budget calculation for 390px and 320px screens:
  // "跳过" (~44px) + gap(6px) + "发送" (~44px) = 94px
  // 320px ultra-narrow viewport: card width ~318px, padding 24px -> available ~294px
  // 294px - 94px(actions) - 8px(gap) = ~192px available for input
  const actionsWidth = 94;
  const available320 = 320 - 2 - 24;
  assert.ok(available320 - actionsWidth > 150, "320px screen accommodates both input and actions comfortably");
});

test("AskUserTextPanel shares the compact footer without regression", () => {
  const textPanelSlice = panelSource.slice(panelSource.indexOf("export function AskUserTextPanel"), panelSource.indexOf("export function AskUserPanel"));
  assert.match(textPanelSlice, /className="pi-native-ask-footer-actions"/, "Text panel uses same compact actions container");
  assert.match(textPanelSlice, /className="pi-native-ask-footer-main"/, "Text panel right-aligns cancel and submit");
  assert.match(textPanelSlice, /className="pi-native-ask-cancel"/, "Text panel keeps cancel button");
  assert.match(textPanelSlice, /className="pi-native-ask-submit"/, "Text panel keeps submit button");
  assert.doesNotMatch(textPanelSlice, /AskQuestionHeader/, "Text panel also removes redundant header");
});

test("prevents font:inherit high specificity override, centers button labels, and guards four unified label spans", () => {
  // 1. Anti-regression against high-specificity .card button overriding button classes
  assert.doesNotMatch(
    cssSource,
    /\.pi-native-ask-card\s+button\s*\{[^}]*font:\s*inherit/,
    "Forbidden: high-specificity '.pi-native-ask-card button' font:inherit override must be eliminated"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-card\s+:where\(button\)\s*\{[^}]*font:\s*inherit;/,
    "Must use zero-specificity :where(button) inside .pi-native-ask-card to preserve button class font rules"
  );

  // 2. Buttons use inline-flex with exact vertical and horizontal centering properties
  assert.match(
    cssSource,
    /\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[^}]*display:\s*inline-flex;/,
    "Buttons must use display: inline-flex"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[^}]*align-items:\s*center;/,
    "Buttons must align items center"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[^}]*justify-content:\s*center;/,
    "Buttons must justify content center"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[^}]*padding-block:\s*0;/,
    "Buttons must explicitly zero padding-block"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[^}]*text-align:\s*center;/,
    "Buttons must set text-align center"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[^}]*line-height:\s*1;/,
    "Buttons must set line-height 1"
  );
  assert.match(
    cssSource,
    /\.pi-native-ask-cancel,\s*\.pi-native-ask-submit\s*\{[^}]*white-space:\s*nowrap;/,
    "Buttons must set white-space nowrap"
  );
  assert.doesNotMatch(
    cssSource,
    /\.pi-native-ask-cancel[^}]*transform:\s*translate|\.pi-native-ask-submit[^}]*transform:\s*translate/,
    "Buttons must not use translateY shift hacks"
  );

  // 3. Four cancel/submit buttons across Picker and TextPanel share identical label span class
  const labelSpanMatches = panelSource.match(/<span className="pi-native-ask-button-label">/g) || [];
  assert.equal(labelSpanMatches.length, 4, "Exactly four cancel/submit buttons must wrap their label in pi-native-ask-button-label");
  assert.match(panelSource, /<span className="pi-native-ask-button-label">\{busy \? "发送中…" : "发送"\}<\/span>/, "Busy text expression preserved");

  // 4. Label span line-height 1 and progressive enhancement with text-box-trim
  assert.match(
    cssSource,
    /\.pi-native-ask-button-label\s*\{[^}]*line-height:\s*1;/,
    "Button label span must have line-height: 1"
  );
  assert.match(
    cssSource,
    /@supports\s*\(\s*text-box-trim:\s*trim-both\s*\)\s*and\s*\(\s*text-box-edge:\s*cap alphabetic\s*\)\s*\{[\s\S]*?\.pi-native-ask-button-label\s*\{[\s\S]*?text-box-trim:\s*trim-both;[\s\S]*?text-box-edge:\s*cap alphabetic;/,
    "Button label span progressively enhances with text-box-trim: trim-both and text-box-edge: cap alphabetic"
  );
  assert.doesNotMatch(
    cssSource,
    /ideographic-ink/,
    "Forbidden: ideographic-ink must not be used"
  );
});
