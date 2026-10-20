import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const summarySource = await readFile(new URL("./SessionUsageSummary.tsx", import.meta.url), "utf8");
const mobileHookSource = await readFile(new URL("../hooks/useIsMobile.ts", import.meta.url), "utf8");

test("keeps shared action access beside statistics in the mobile toolbar", () => {
  assert.match(mobileHookSource, /NARROW_MOBILE_QUERY = "\(max-width: 480px\)"/);
  assert.match(source, /const isNarrowMobile = useIsNarrowMobile\(\);/);
  assert.match(source, /data-mobile-toolbar-more="true"/);
  assert.match(source, /\{renderChatToolbarActions\(true\)\}/);
  assert.match(source, /\{renderSessionStatsButton\(true\)\}/);
});

test("uses a compact narrow-mobile toolbar with a floating action layer", () => {
  assert.match(source, /data-mobile-toolbar="true"[\s\S]*?flex: 1,[\s\S]*?minWidth: 0/);
  assert.match(
    source,
    /data-mobile-toolbar-actions="true"[\s\S]*?position: "absolute"[\s\S]*?right: 0,[\s\S]*?left: TOP_BAR_ICON_BUTTON_SIZE/,
  );

  for (const action of ["history", "name", "agents", "branches", "system", "tools"]) {
    assert.match(source, new RegExp(`data-mobile-toolbar-action=(?:\\{mobile \\? )?"${action}"`));
  }
});

test("only renders the Agents switcher when the active session family has subagents", () => {
  assert.match(source, /const hasSubagentSessions = Boolean\(activeSessionFamily\?\.subagents\.length\)/);
  assert.match(source, /\{hasSubagentSessions && \(\s*<button[\s\S]*?toggleTopPanel\("agents", mobile\)/);
  assert.match(source, /activeTopPanel === "agents" && activeSessionFamily && selectedSession/);
});

test("keeps the Agents panel open while switching sessions and positions it at the left", () => {
  assert.match(source, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(
    source,
    /if \(activeTopPanel === "agents"\)[\s\S]*?left: topBarRect\.left[\s\S]*?width: Math\.min\(AGENT_PANEL_WIDTH, topBarRect\.width\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleSelectSession\}/);
});

test("only renders branch toolbar controls for sessions with branches", () => {
  assert.match(source, /const sessionHasBranches = hasSessionBranches\(branchTree\)/);
  assert.match(source, /\{piExecutionReady && sessionHasBranches && \(mobile \? \(/);
  assert.match(source, /\{isMobile && piExecutionReady && sessionHasBranches && \(/);
  assert.match(source, /panel === "branches" \? null : panel/);
});

test("keeps the shared statistics control out of interaction and focus while its mobile layer is covered", () => {
  assert.match(source, /<SessionUsageSummary mobile=\{mobile\} covered=\{mobile && mobileToolbarMoreOpen\}/);
  assert.match(summarySource, /disabled=\{disabled\|\|covered\}/);
  assert.match(summarySource, /tabIndex=\{covered\?-1:undefined\}/);
  assert.match(summarySource, /aria-hidden=\{covered\|\|undefined\}/);
});

test("closes the mobile action layer on outside click, Escape, layout changes, and session changes", () => {
  assert.match(source, /event\.composedPath\(\)\.includes\(toolbar\)/);
  assert.match(source, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(source, /event\.key !== "Escape"[\s\S]*?setMobileToolbarMoreOpen\(false\)/);
  assert.match(source, /\}, \[isMobile, isNarrowMobile, selectedSession\?\.id, newSessionDraftId\]\);/);
});

test("keeps the mobile action layer open after using an expanded action", () => {
  const toggleTopPanel = source.match(/const toggleTopPanel = useCallback\([\s\S]*?\n  \}, \[isMobile, isNarrowMobile\]\);/)?.[0];
  const historyHandler = source.match(/onClick=\{\(\) => \{[\s\S]*?handleViewFullHistory\(\);[\s\S]*?\n          \}\}/)?.[0];
  const autoNameHandler = source.match(/onClick=\{\(\) => \{[\s\S]*?void handleAutoName\(\);[\s\S]*?\n              \}\}/)?.[0];

  for (const handler of [toggleTopPanel, historyHandler, autoNameHandler]) {
    assert.ok(handler);
    assert.doesNotMatch(handler, /setMobileToolbarMoreOpen\(false\)/);
    assert.match(handler, /setMobileToolbarMoreOpen\(true\)/);
  }

  assert.match(source, /toggleTopPanel\("branches", true\)/);
  assert.match(source, /handleSystemInfoToggle\("system", mobile\)/);
  assert.match(source, /handleSystemInfoToggle\("tools", mobile\)/);
  assert.match(source, /onClick=\{\(\) => toggleTopPanel\("session"\)\}/);
});

test("keeps theme and language in settings instead of the chat toolbar", () => {
  assert.doesNotMatch(source, /renderThemeButton/);
  assert.doesNotMatch(source, /renderLanguageButton/);
  assert.doesNotMatch(source, /toggleTopPanel\("language"/);
  assert.doesNotMatch(source, /data-mobile-toolbar-action=\{mobile \? "theme"/);
  assert.doesNotMatch(source, /data-mobile-toolbar-action=\{mobile \? "language"/);
  assert.match(source, /import \{ useTheme \} from "@\/hooks\/useTheme"/);
  assert.match(source, /useTheme\(\);/);
});

test("shows real context occupancy and capacity alongside cumulative tokens in the same shared summary", () => {
  assert.match(source, /usage=\{\{contextUsage,tokens:/);
  assert.match(summarySource, /data-context-usage="true"/);
  assert.match(summarySource, /上下文 \{used\} \/ \{window\}/);
  assert.match(summarySource, /data-token-usage="true"/);
  assert.doesNotMatch(summarySource, /executionEngine|codex:/);
});

test("places trust warnings below the mobile toolbar and the file toggle in toolbar flow", () => {
  assert.match(source, /\{isMobile && renderProjectTrustWarning\(true\)\}/);
  assert.match(source, /data-mobile-trust-banner=\{mobileBanner \? "true" : undefined\}/);
  assert.doesNotMatch(source, /File panel toggle — always visible at top-right/);
  assert.doesNotMatch(source, /position: "fixed", top: "env\(safe-area-inset-top\)"/);
});

test("closes top-bar dropdowns when the file panel expands to full width", () => {
  assert.match(
    source,
    /const handleRightPanelExpandToggle = useCallback\(\(\) => \{\s*setActiveTopPanel\(null\);\s*setRightPanelExpanded\(\(expanded\) => !expanded\);/,
  );
  assert.match(source, /onClick=\{handleRightPanelExpandToggle\}/);
  assert.match(source, /if \(rightPanelFullWidth\) setActiveTopPanel\(null\);/);
});
