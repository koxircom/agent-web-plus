import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from 'node:fs';
import { computeUserTurnNumbers } from "./turn-number.ts";

test("computeUserTurnNumbers: handles empty messages or no user messages", () => {
  assert.equal(computeUserTurnNumbers({ messages: [] }).size, 0);
  assert.equal(
    computeUserTurnNumbers({
      messages: [{ role: "assistant" }, { role: "toolResult" }],
    }).size,
    0
  );
});

test("computeUserTurnNumbers: non-user messages are not counted; counts user messages sequentially from #1 when no earlier messages", () => {
  const messages = [
    { role: "user", content: "first user prompt" },
    { role: "assistant", content: "assistant response" },
    { role: "toolResult", toolCallId: "call_1" },
    { role: "assistant", content: "assistant answer" },
    { role: "user", content: "second user prompt" },
    { role: "assistant", content: "second response" },
    { role: "custom", customType: "compaction" },
    { role: "user", content: "third user prompt" },
  ];

  const turnMap = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: 3,
    hasEarlierMessages: false,
  });

  assert.equal(turnMap.size, 3);
  assert.equal(turnMap.get(0), 1);
  assert.equal(turnMap.get(4), 2);
  assert.equal(turnMap.get(7), 3);
  // Ensure non-user indices are not in the map
  assert.equal(turnMap.has(1), false);
  assert.equal(turnMap.has(2), false);
  assert.equal(turnMap.has(3), false);
  assert.equal(turnMap.has(5), false);
  assert.equal(turnMap.has(6), false);
});

test("computeUserTurnNumbers: identical user prompt texts with distinct entries are each counted once", () => {
  const messages = [
    { role: "user", content: "retry this command" },
    { role: "assistant", content: "failed" },
    { role: "user", content: "retry this command" },
    { role: "assistant", content: "succeeded" },
    { role: "user", content: "retry this command" },
  ];

  const turnMap = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: 3,
    hasEarlierMessages: false,
  });

  assert.equal(turnMap.size, 3);
  assert.equal(turnMap.get(0), 1);
  assert.equal(turnMap.get(2), 2);
  assert.equal(turnMap.get(4), 3);
});

test("computeUserTurnNumbers: long session with known total 100 and 3 loaded tail users must be #98, #99, #100", () => {
  const messages = [
    { role: "user", content: "tail user 1" },
    { role: "assistant", content: "tail assistant 1" },
    { role: "user", content: "tail user 2" },
    { role: "assistant", content: "tail assistant 2" },
    { role: "user", content: "tail user 3" },
    { role: "assistant", content: "tail assistant 3" },
  ];

  const turnMap = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: 100,
    hasEarlierMessages: true,
  });

  assert.equal(turnMap.size, 3);
  assert.equal(turnMap.get(0), 98);
  assert.equal(turnMap.get(2), 99);
  assert.equal(turnMap.get(4), 100);
});

test("computeUserTurnNumbers: adding a new user turn advances total from 100 to 101 without mutating previous turn numbers", () => {
  const messagesBefore = [
    { role: "user", content: "tail user 1" },
    { role: "assistant", content: "tail assistant 1" },
    { role: "user", content: "tail user 2" },
    { role: "assistant", content: "tail assistant 2" },
    { role: "user", content: "tail user 3" },
    { role: "assistant", content: "tail assistant 3" },
  ];

  const turnMapBefore = computeUserTurnNumbers({
    messages: messagesBefore,
    navigationTotalTurns: 100,
    hasEarlierMessages: true,
  });

  assert.equal(turnMapBefore.get(0), 98);
  assert.equal(turnMapBefore.get(2), 99);
  assert.equal(turnMapBefore.get(4), 100);

  // User sends turn 101
  const messagesAfter = [
    ...messagesBefore,
    { role: "user", content: "new turn user 4" },
  ];

  const turnMapAfter = computeUserTurnNumbers({
    messages: messagesAfter,
    navigationTotalTurns: 101,
    hasEarlierMessages: true,
  });

  assert.equal(turnMapAfter.size, 4);
  assert.equal(turnMapAfter.get(0), 98);
  assert.equal(turnMapAfter.get(2), 99);
  assert.equal(turnMapAfter.get(4), 100);
  assert.equal(turnMapAfter.get(6), 101);
});

test("computeUserTurnNumbers: prepending earlier history preserves existing turn numbers", () => {
  // Originally loaded 4 messages (total 101, turns 98..101)
  // Now older history is loaded: 2 older user messages prepended
  const messagesPrepended = [
    { role: "user", content: "older user 96" },
    { role: "assistant", content: "older assistant 96" },
    { role: "user", content: "older user 97" },
    { role: "assistant", content: "older assistant 97" },
    { role: "user", content: "tail user 98" },
    { role: "assistant", content: "tail assistant 98" },
    { role: "user", content: "tail user 99" },
    { role: "assistant", content: "tail assistant 99" },
    { role: "user", content: "tail user 100" },
    { role: "assistant", content: "tail assistant 100" },
    { role: "user", content: "new turn user 101" },
  ];

  const turnMap = computeUserTurnNumbers({
    messages: messagesPrepended,
    navigationTotalTurns: 101,
    hasEarlierMessages: true,
  });

  assert.equal(turnMap.size, 6);
  assert.equal(turnMap.get(0), 96);
  assert.equal(turnMap.get(2), 97);
  assert.equal(turnMap.get(4), 98);
  assert.equal(turnMap.get(6), 99);
  assert.equal(turnMap.get(8), 100);
  assert.equal(turnMap.get(10), 101);
});

test("computeUserTurnNumbers: partial history missing total turns conservatively shows NO turn number and never falsely claims #1", () => {
  const messages = [
    { role: "user", content: "some middle user message" },
    { role: "assistant", content: "some assistant response" },
    { role: "user", content: "another middle user message" },
  ];

  // Case A: navigationTotalTurns is undefined
  const mapUndefined = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: undefined,
    hasEarlierMessages: true,
  });
  assert.equal(mapUndefined.size, 0);

  // Case B: navigationTotalTurns is null
  const mapNull = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: null,
    hasEarlierMessages: true,
  });
  assert.equal(mapNull.size, 0);

  // Case C: navigationTotalTurns is 0 (or smaller than loaded users)
  const mapZero = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: 0,
    hasEarlierMessages: true,
  });
  assert.equal(mapZero.size, 0);

  const mapTooSmall = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: 1, // loaded 2 users, but total says 1
    hasEarlierMessages: true,
  });
  assert.equal(mapTooSmall.size, 0);

  // Case D: decimal float is rejected
  const mapDecimal = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: 10.5,
    hasEarlierMessages: true,
  });
  assert.equal(mapDecimal.size, 0);

  // Case E: NaN is rejected
  const mapNaN = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: NaN,
    hasEarlierMessages: true,
  });
  assert.equal(mapNaN.size, 0);

  // Case F: Infinity & -Infinity are rejected
  const mapInfinity = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: Infinity,
    hasEarlierMessages: true,
  });
  assert.equal(mapInfinity.size, 0);

  const mapNegInfinity = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: -Infinity,
    hasEarlierMessages: true,
  });
  assert.equal(mapNegInfinity.size, 0);

  // Case G: Negative integer is rejected
  const mapNegative = computeUserTurnNumbers({
    messages,
    navigationTotalTurns: -5,
    hasEarlierMessages: true,
  });
  assert.equal(mapNegative.size, 0);
});

// Retired mutation paths must not be inherited by a future release snapshot.
test("turn numbers have one native renderer and no legacy DOM writer", () => {
  for (const file of ["02-plugin-registry-and-settings-schema.js", "06-chat-view-and-tool-cards.js"]) {
    const source=readFileSync(new URL("../enhancements/modules/"+file, import.meta.url),"utf8");
    assert.doesNotMatch(source,/syncAllTurnNumberBadges|clearAllTurnNumberBadges|__PI_ENH_(?:SYNC|CLEAR)_TURN_NUMBERS__/);
  }
  const view=readFileSync(new URL("../components/MessageView.tsx",import.meta.url),"utf8");
  assert.match(view,/data-turn-number=\{String\(turnNumber\)\}/);
});
