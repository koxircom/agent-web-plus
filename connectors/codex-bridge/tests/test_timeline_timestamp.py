"""Tests for native timestamp pass-through, normalization, and merge persistence."""

import json
import tempfile
import unittest
from pathlib import Path

from bridge.clients.codex.wsl_history import WslHistory
from bridge.features.sessions.model import normalize_state, normalize_timestamp
from bridge.features.sessions.timeline import Timeline


class TimelineTimestampTests(unittest.TestCase):
    def test_normalize_timestamp_formats(self):
        # Epoch ms integers
        self.assertEqual(normalize_timestamp(1729500000123), 1729500000123)
        # Epoch seconds integers -> scaled to ms
        self.assertEqual(normalize_timestamp(1729500000), 1729500000000)
        # Digit strings
        self.assertEqual(normalize_timestamp("1729500000123"), 1729500000123)
        self.assertEqual(normalize_timestamp("1729500000"), 1729500000000)
        # ISO 8601 UTC
        self.assertEqual(normalize_timestamp("2026-10-21T06:25:00.123Z"), 1792563900123)
        self.assertEqual(normalize_timestamp("2026-10-21T06:25:00Z"), 1792563900000)
        # Invalid / missing values return None, never fabricated
        for bad in (
            None,
            "",
            "   ",
            "not-a-date",
            True,
            False,
            -1,
            0,
            float("nan"),
            float("inf"),
        ):
            self.assertIsNone(normalize_timestamp(bad))

    def test_rollout_record_timestamp_passthrough(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / "home"
            path = home / "sessions" / "rollout.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            records = [
                {
                    "timestamp": "2026-10-21T06:25:00.000Z",
                    "type": "event_msg",
                    "payload": {"type": "task_started", "turn_id": "turn-1"},
                },
                {
                    "timestamp": "2026-10-21T06:25:01.100Z",
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "user",
                        "id": "msg-user-1",
                        "content": [{"type": "input_text", "text": "用户提问"}],
                    },
                },
                {
                    "timestamp": "2026-10-21T06:25:05.500Z",
                    "type": "response_item",
                    "payload": {
                        "type": "message",
                        "role": "assistant",
                        "id": "msg-asst-1",
                        "content": [{"type": "text", "text": "模型回答"}],
                    },
                },
                {
                    "timestamp": "2026-10-21T06:25:06.000Z",
                    "type": "event_msg",
                    "payload": {
                        "type": "item_completed",
                        "turn_id": "turn-1",
                        "item": {
                            "type": "UserMessage",
                            "id": "native-user-1",
                            "content": [{"type": "text", "text": "用户提问"}],
                        },
                    },
                },
                {
                    "timestamp": "2026-10-21T06:25:07.000Z",
                    "type": "event_msg",
                    "payload": {"type": "task_complete"},
                },
            ]
            path.write_text("".join(json.dumps(r) + "\n" for r in records))
            store = WslHistory(home, [{"key": "fixture", "path": root}])
            saved = store._history("fixture", {"rollout_path": str(path), "cwd": root})
            state = normalize_state(saved)
            timeline = Timeline()
            timeline.update({**state, "sequence": 1})

            user_row = next(r for r in timeline.rows if r["role"] == "user")
            asst_row = next(r for r in timeline.rows if r["role"] == "assistant")
            self.assertEqual(user_row["timestamp"], 1792563901100)
            self.assertEqual(asst_row["timestamp"], 1792563905500)

    def test_missing_timestamp_stays_undefined_not_faked_from_turn(self):
        # Turn has a turnStartedAtMs, but messages do not have individual timestamps.
        # User message must NOT adopt the turn's start or completion time.
        live = {
            "id": "fixture",
            "turns": [
                {
                    "turnId": "turn-notime",
                    "status": "completed",
                    "turnStartedAtMs": 1792563900000,
                    "items": [
                        {
                            "id": "user-msg-1",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "没有时间的提问"}],
                        },
                        {
                            "id": "asst-msg-1",
                            "type": "agentMessage",
                            "text": "没有时间的回答",
                        },
                    ],
                }
            ],
        }
        state = normalize_state(live)
        timeline = Timeline()
        timeline.update({**state, "sequence": 1})
        for r in timeline.rows:
            self.assertNotIn(
                "timestamp", r, f"Row {r['key']} should not fabricate a timestamp"
            )

    def test_history_and_sse_merge_preserves_known_timestamp(self):
        timeline = Timeline()
        # First update: event with timestamp
        turn_v1 = {
            "turnId": "turn-live",
            "status": "inProgress",
            "items": [
                {
                    "id": "item-u1",
                    "type": "userMessage",
                    "timestamp": 1792563900123,
                    "content": [{"type": "text", "text": "提问"}],
                },
                {
                    "id": "item-a1",
                    "type": "agentMessage",
                    "timestamp": 1792563905000,
                    "text": "流式中...",
                },
            ],
        }
        timeline.update(
            {**normalize_state({"id": "fix", "turns": [turn_v1]}), "sequence": 1}
        )
        self.assertEqual(timeline.rows[0]["timestamp"], 1792563900123)
        self.assertEqual(timeline.rows[1]["timestamp"], 1792563905000)

        # Second update: delta or partial update without timestamp
        turn_v2 = {
            "turnId": "turn-live",
            "status": "completed",
            "items": [
                {
                    "id": "item-u1",
                    "type": "userMessage",
                    "content": [{"type": "text", "text": "提问"}],
                },
                {"id": "item-a1", "type": "agentMessage", "text": "流式完成答案"},
            ],
        }
        timeline.update(
            {**normalize_state({"id": "fix", "turns": [turn_v2]}), "sequence": 2}
        )
        # Known timestamps must NOT be cleared by later message without timestamp
        self.assertEqual(timeline.rows[0]["timestamp"], 1792563900123)
        self.assertEqual(timeline.rows[1]["timestamp"], 1792563905000)

    def test_paging_timestamps_are_stable_no_drift(self):
        live = {
            "id": "fixture",
            "turns": [
                {
                    "turnId": f"t-{i}",
                    "status": "completed",
                    "items": [
                        {
                            "id": f"u-{i}",
                            "type": "userMessage",
                            "timestamp": 1792563900000 + i * 1000,
                            "content": [{"type": "text", "text": f"Q{i}"}],
                        },
                        {
                            "id": f"a-{i}",
                            "type": "agentMessage",
                            "timestamp": 1792563900500 + i * 1000,
                            "text": f"A{i}",
                        },
                    ],
                }
                for i in range(10)
            ],
        }
        timeline = Timeline()
        timeline.update({**normalize_state(live), "sequence": 1})
        page1 = timeline.page(limit=4)
        page2 = timeline.page(limit=4, before=page1["before"])

        # Compare timestamps on page rows with authoritative original rows
        for r in page1["rows"] + page2["rows"]:
            expected_row = next(
                orig for orig in timeline.rows if orig["key"] == r["key"]
            )
            self.assertEqual(
                r["timestamp"],
                expected_row["timestamp"],
                "Timestamp drifted across pages",
            )


if __name__ == "__main__":
    unittest.main()
