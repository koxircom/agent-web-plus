import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const selectorSource = await readFile(new URL("./ThinkingSelector.tsx", import.meta.url), "utf8");
const session = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const thinkingControl = source.slice(source.indexOf("{onThinkingLevelChange && ("));

// The SDK re-reads the thinking level before every model request of a run,
// so a change made mid-run applies from the next request (#851).
test("keeps one thinking control and lets it change the level while the session is busy", () => {
  assert.doesNotMatch(source, /isStreaming && onThinkingLevelChange/);
  assert.doesNotMatch(thinkingControl, /<span\s+title=\{t\("chat\.currentReasoning"/);
  const selectorStart = thinkingControl.indexOf("<ThinkingSelector");
  const selector = thinkingControl.slice(selectorStart, thinkingControl.indexOf("/>", selectorStart) + 2);
  assert.match(selector, /disabled=\{false\}/);
  assert.match(selectorSource, /disabled=\{disabled\}/);
  assert.match(selectorSource, /onClick=\{\(\) => \{ updateAnchor\(\); setOpen\(\(current\) => !current\); \}\}/);
  assert.match(selectorSource, /useEffect\(\(\) => \{ if \(disabled\) setOpen\(false\); \}, \[disabled\]\)/);
  assert.match(thinkingControl, /title=\{isStreaming/);
  assert.match(thinkingControl, /为下一条消息设置思考深度：\$\{thinkingDisplayLabel\}/);
  assert.match(thinkingControl, /t\("chat\.changeReasoning", \{ level: thinkingDisplayLabel \}\)/);
});

test("shows the resolved level and treats auto as an uncommitted default", () => {
  assert.match(source, /resolvedThinkingLevel = thinkingLevel && thinkingLevel !== "auto"/);
  assert.match(source, /isAutoThinkingSelection/);
  assert.match(thinkingControl, /value=\{isAutoThinkingSelection \? "auto" : resolvedThinkingLevel \?\? "auto"\}/);
  assert.match(thinkingControl, /onChange=\{onThinkingLevelChange\}/);
});

test("session hook layers thinking like the model selector", () => {
  assert.match(session, /displayThinkingLevel = isNew/);
  assert.match(session, /newSessionThinkingLevel \?\? newSessionDefaultThinkingLevel/);
  assert.match(session, /isAutoThinkingSelection: isNew && newSessionThinkingLevel === null/);
  assert.match(session, /if \(state\?\.thinkingLevel !== undefined\) \{\s*setLiveThinkingLevel\(asConcreteThinkingLevel\(state\.thinkingLevel\)\);/);
  const start = session.slice(session.indexOf('case "agent_start":'), session.indexOf('case "agent_end":'));
  assert.doesNotMatch(start, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`\)/);
  assert.match(session, /if \(level === "auto"\) \{/);
});
