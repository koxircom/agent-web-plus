const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const core = require("../enhancements/usage-ledger-core.js");

function usageBucket({ engine = "codex", sessionId, day, role, model, events }) {
  const totals = core.empty();
  const timeline = events.map(({ timestamp, tokens }) => {
    const values = core.empty();
    values.inputTokens = tokens;
    values.totalTokens = tokens;
    values.messageCount = 1;
    values.calls = 1;
    values.records = 1;
    core.add(totals, values);
    return [timestamp, ...core.fields.map(field => values[field])];
  });
  return { ...totals, engine, sessionId, day, role, model, provider: "openai", timeline };
}

function atBeijing(day, hour = 12) {
  return Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00+08:00`);
}

function fixture() {
  const parent = "codex:parent";
  const first = "codex:child-one";
  const second = "codex:child-two";
  const orphan = "codex:orphan";
  return {
    version: 2,
    sessions: {
      [parent]: { title: "父会话" },
      [first]: { name: "自动任务 Alpha", parentSessionId: parent },
      [second]: { title: "自动任务 Beta", parentSessionId: parent },
      [orphan]: { title: "孤立子任务" },
    },
    buckets: [
      usageBucket({ sessionId: parent, day: "2026-10-18", role: "main", model: "gpt-5.6-sol", events: [{ timestamp: atBeijing("2026-10-18"), tokens: 100 }] }),
      usageBucket({ sessionId: first, day: "2026-10-18", role: "subagent", model: "gpt-5.6-sol", events: [{ timestamp: atBeijing("2026-10-18"), tokens: 25 }] }),
      usageBucket({ sessionId: first, day: "2026-10-19", role: "subagent", model: "gpt-6-luna", events: [{ timestamp: atBeijing("2026-10-19"), tokens: 15 }] }),
      usageBucket({ sessionId: second, day: "2026-10-18", role: "subagent", model: "gpt-6-luna", events: [{ timestamp: atBeijing("2026-10-18"), tokens: 50 }] }),
      usageBucket({ sessionId: orphan, day: "2026-10-18", role: "subagent", model: "gpt-5.6-sol", events: [{ timestamp: atBeijing("2026-10-18"), tokens: 8 }] }),
    ],
  };
}

test("Codex subtask detail is an explanation of parent totals, not an added charge", () => {
  const stats = core.aggregate(fixture(), { engine: "codex" });
  const parent = stats.topSessions.find(session => session.id === "codex:parent");

  assert.equal(stats.totalTokens, 198);
  assert.equal(parent.totalTokens, 190);
  assert.equal(parent.mainTokens, 100);
  assert.equal(parent.subagentTokens, 90);
  assert.equal(parent.subtasks.reduce((sum, task) => sum + task.totalTokens, 0), parent.subagentTokens);
  assert.deepEqual(parent.subtasks.map(task => [task.name, task.day, task.totalTokens]), [
    ["自动任务 Alpha", "2026-10-19", 15],
    ["自动任务 Beta", "2026-10-18", 50],
    ["自动任务 Alpha", "2026-10-18", 25],
  ]);
  assert.equal(stats.topSessions.find(session => session.id === "codex:orphan").subtasks.length, 0);
});

test("subtask details inherit engine, role, model, and Beijing date filters", () => {
  const ledger = fixture();
  const customDay = core.aggregate(ledger, {
    engine: "codex", role: "all", model: "gpt-5.6-sol", timeRange: "custom",
    startDate: "2026-10-18", endDate: "2026-10-18",
  });
  const parentForDay = customDay.topSessions.find(session => session.id === "codex:parent");
  assert.equal(parentForDay.totalTokens, 125);
  assert.deepEqual(parentForDay.subtasks.map(task => [task.name, task.day, task.totalTokens]), [
    ["自动任务 Alpha", "2026-10-18", 25],
  ]);

  const mainOnly = core.aggregate(ledger, { engine: "codex", role: "main" });
  const mainParent = mainOnly.topSessions.find(session => session.id === "codex:parent");
  assert.equal(mainParent.totalTokens, 100);
  assert.equal(mainParent.subtasks.length, 0);

  const subagentOnly = core.aggregate(ledger, { engine: "codex", role: "subagent" });
  const subagentParent = subagentOnly.topSessions.find(session => session.id === "codex:parent");
  assert.equal(subagentParent.totalTokens, 90);
  assert.equal(subagentParent.subtasks.reduce((sum, task) => sum + task.totalTokens, 0), 90);

  assert.equal(core.aggregate(ledger, { engine: "pi" }).topSessions.length, 0);
});

test("24-hour filtering includes only matched timeline usage and the panel states Codex fees are unavailable", () => {
  const parent = "codex:parent";
  const child = "codex:child";
  const ledger = {
    version: 2,
    sessions: {
      [parent]: { title: "父会话" },
      [child]: { name: "边界自动任务", parentSessionId: parent },
    },
    buckets: [
      usageBucket({ sessionId: parent, day: "2026-10-18", role: "main", model: "gpt-5.6-sol", events: [{ timestamp: atBeijing("2026-10-18", 21), tokens: 10 }] }),
      usageBucket({ sessionId: child, day: "2026-10-18", role: "subagent", model: "gpt-6-luna", events: [
        { timestamp: atBeijing("2026-10-18", 19), tokens: 7 },
        { timestamp: atBeijing("2026-10-18", 21), tokens: 13 },
      ] }),
    ],
  };
  const stats = core.aggregate(ledger, {
    engine: "codex", timeRange: "24h", now: atBeijing("2026-10-19", 20),
  });
  const parentStats = stats.topSessions.find(session => session.id === parent);
  assert.equal(parentStats.totalTokens, 23);
  assert.deepEqual(parentStats.subtasks.map(task => [task.name, task.day, task.totalTokens]), [
    ["边界自动任务", "2026-10-18", 13],
  ]);

  const panelSource = fs.readFileSync(path.join(__dirname, "../enhancements/pi-usage-panel.js"), "utf8");
  assert.match(panelSource, /data-usage-subtask-details/);
  assert.match(panelSource, /调用日期（北京时间）/);
  assert.match(panelSource, /<td[^>]*>Codex 未提供费用<\/td>/);
});
