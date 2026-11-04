"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../modules/04-sidebar-and-session-management.js"), "utf8");
const helperStart = source.indexOf("  function buildAgentRelayPrompt(");
const helperEnd = source.indexOf("\n  function isLegalAbsolutePath(", helperStart);
assert(helperStart >= 0 && helperEnd > helperStart, "relay prompt helper must remain in the sidebar responsibility module");
const context = { URL };
vm.createContext(context);
vm.runInContext(`${source.slice(helperStart, helperEnd)}\nthis.buildAgentRelayPrompt = buildAgentRelayPrompt;`, context);
const buildAgentRelayPrompt = context.buildAgentRelayPrompt;

test("relay prompt keeps the target session identity and complete path metadata", () => {
  const sessionPath = `C:\\fixture\\${"nested folder\\".repeat(18)}session history\\2026-11-04.jsonl`;
  const cwd = "C:\\fixture\\Projects\\Target Repo";
  const projectRoot = "C:\\fixture\\Projects";
  const prompt = buildAgentRelayPrompt({
    origin: "https://example.test",
    sessionId: "codex:target-row-session",
    engine: "codex",
    title: "Target session title",
    sessionPath,
    cwd,
    projectRoot,
  });

  assert.match(prompt, /引擎: Codex/);
  assert.match(prompt, /Session ID: codex:target-row-session/);
  assert.match(prompt, /Session URL: https:\/\/example\.test\/\?session=codex%3Atarget-row-session/);
  assert.ok(prompt.includes("Target session title"));
  assert.ok(prompt.includes(sessionPath), "the full long Windows session path must not be display-truncated");
  assert.ok(prompt.includes(cwd));
  assert.ok(prompt.includes(projectRoot));
  assert.match(prompt, /先通过指定 Session URL\/ID 读取该会话的完整历史/);
  assert.match(prompt, /相关锁\/租约及持有人/);
  assert.match(prompt, /不要遍历、发送命令或无差别控制其它会话/);
});

test("relay URL drops credentials and query secrets and missing paths stay unprovided", () => {
  const prompt = buildAgentRelayPrompt({
    origin: "https://user:password@example.test/app?token=secret-token#fragment",
    sessionId: "pi-session-42",
    engine: "pi",
  });

  assert.match(prompt, /引擎: Pi Agent/);
  assert.match(prompt, /Session URL: https:\/\/example\.test\/\?session=pi-session-42/);
  assert.doesNotMatch(prompt, /user:password|secret-token|fragment/);
  assert.match(prompt, /会话标题: 未提供/);
  assert.match(prompt, /会话记录文件: 未提供/);
  assert.match(prompt, /工作目录 \(cwd\): 未提供/);
  assert.match(prompt, /项目根目录 \(projectRoot\): 未提供/);
  assert.doesNotMatch(prompt, /pi-session-42\.jsonl/);
});

test("copy-prompt is bound to the right-click row id, engine, and resolved row path", () => {
  const menuStart = source.indexOf('addManagedListener(window, "pi-web:session-row-contextmenu"');
  const actionStart = source.indexOf('      } else if (action === "copy-prompt") {', menuStart);
  const actionEnd = source.indexOf('      } else if (action === "copy-cwd") {', actionStart);
  assert(menuStart >= 0 && actionStart > menuStart && actionEnd > actionStart);
  const menuContext = source.slice(menuStart, actionStart);
  const action = source.slice(actionStart, actionEnd);

  assert.match(menuContext, /const \{ id, path, cwd, name, clientX, clientY, executionEngine \} = event\.detail \|\| \{\};/);
  assert.match(menuContext, /isCodexSession\(id, executionEngine\)/);
  assert.match(action, /sessionId: id/);
  assert.match(action, /engine: isCodex \? "codex" : "pi"/);
  assert.match(action, /sessionPath: validRolloutPath/);
  assert.match(action, /cwd: cwd \|\| rawSession\?\.cwd/);
});
