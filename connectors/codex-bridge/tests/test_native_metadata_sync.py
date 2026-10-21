"""Comprehensive tests for native metadata synchronization:
pin/unpin, archive/unarchive, live/idle rename, bounded readback verification,
external native mutation precedence over stale web maps/overrides, and safety guards.
"""

import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.native_metadata import PINNED_SECTION_ID
from bridge.clients.codex.standalone import StandaloneBridge
from bridge.clients.codex.wsl_history import WslHistory

THREAD_1 = "01901234-5678-7000-8000-000000000001"
THREAD_2 = "01901234-5678-7000-8000-000000000002"


class MockBackend:
    def __init__(self, db_path=None):
        self.calls = []
        self.db_path = db_path
        self.simulate_empty_ack = False
        self.timeout_on_method = None
        self.status = "idle"
        self.queue = []

    def request(self, method, params, timeout=30):
        self.calls.append((method, params))
        if self.timeout_on_method == method:
            raise TimeoutError(f"{method} request timed out")
        if method == "thread/resume":
            return {
                "thread": {
                    "id": params.get("threadId"),
                    "status": {"type": self.status},
                    "cwd": sqlite3.connect(self.db_path).execute("SELECT cwd FROM threads WHERE id = ?", (params['threadId'],)).fetchone()[0],
                }
            }
        if method == "thread/queue/list":
            return {"data": self.queue, "nextCursor": None}

        # If simulate_empty_ack is True, return empty dict without mutating DB
        if self.simulate_empty_ack:
            return {}

        # Mutate the test SQLite DB if provided to simulate native app-server behavior
        if self.db_path and Path(self.db_path).exists():
            thread_id = params.get("threadId")
            with sqlite3.connect(self.db_path) as conn:
                if method == "thread/section/move":
                    conn.execute(
                        "UPDATE threads SET thread_section_id = ? WHERE id = ?",
                        (params.get("sectionId"), thread_id),
                    )
                elif method == "thread/archive":
                    conn.execute(
                        "UPDATE threads SET archived = 1 WHERE id = ?", (thread_id,)
                    )
                elif method == "thread/unarchive":
                    conn.execute(
                        "UPDATE threads SET archived = 0 WHERE id = ?", (thread_id,)
                    )
                elif method == "thread/name/set":
                    conn.execute(
                        "UPDATE threads SET name = ?, title = ? WHERE id = ?",
                        (params.get("name"), params.get("name"), thread_id),
                    )
                conn.commit()

        return {}


class NativeMetadataSyncTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.home = self.root / ".codex"
        self.home.mkdir(parents=True)
        (self.home / "sessions").mkdir(parents=True)
        self.db_path = str(self.home / "state_5.sqlite")
        self._init_db(self.db_path)

        self.workspace_dir = self.root / "workspace"
        self.workspace_dir.mkdir(parents=True)

        self.workspaces = [
            {"name": "ws", "key": "ws-key", "path": str(self.workspace_dir)}
        ]
        self.history = WslHistory(self.home, self.workspaces)
        self.backend = MockBackend(self.db_path)

        self.bridge = StandaloneBridge.__new__(StandaloneBridge)
        self.bridge.lock = threading.RLock()
        self.bridge.registry_lock = threading.RLock()
        self.bridge.records = {
            "threads": {
                THREAD_1: {
                    "cwd": str(self.workspace_dir),
                    "runtime": "history",
                    "title": "会话一",
                    "archived": False,
                },
            },
            "titleOverrides": {},
            "creations": {},
        }
        self.bridge.workspaces = self.workspaces
        self.bridge.runtime = self.backend
        self.bridge.history = self.history
        self.bridge.live = {}
        self.bridge.path = self.root / "web-threads.json"
        self.bridge.save = lambda: self.bridge.path.write_text("{}")
        self.bridge._thread_path = lambda tid, e: f"/threads/{tid}"
        self.bridge._title_override = lambda tid: self.bridge.records[
            "titleOverrides"
        ].get(tid)
        self.bridge._history_backend = lambda: self.backend

    def tearDown(self):
        self.temp_dir.cleanup()

    def _init_db(self, path, include_section=True):
        with sqlite3.connect(path) as conn:
            section_col = ", thread_section_id TEXT" if include_section else ""
            conn.execute(f"""
                CREATE TABLE threads (
                    id TEXT PRIMARY KEY,
                    cwd TEXT,
                    name TEXT,
                    title TEXT,
                    archived INTEGER DEFAULT 0,
                    updated_at INTEGER,
                    recency_at INTEGER,
                    recency_at_ms INTEGER,
                    source TEXT,
                    thread_source TEXT,
                    originator TEXT
                    {section_col}
                )
            """)
            # Insert THREAD_1
            conn.execute(
                """
                INSERT INTO threads (id, cwd, name, title, archived, updated_at, originator)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    THREAD_1,
                    str(self.root / "workspace"),
                    "会话一",
                    "会话一",
                    0,
                    1000,
                    "Codex Desktop",
                ),
            )
            conn.commit()

    def test_list_contains_pinned_archived_and_native_metadata(self):
        """Metadata list contract returns pinned, archived, and nativeMetadata fields."""
        sessions = self.bridge.list(archived=False)
        self.assertEqual(len(sessions), 1)
        item = sessions[0]
        self.assertEqual(item["id"], THREAD_1)
        self.assertFalse(item["pinned"])
        self.assertFalse(item["archived"])
        self.assertEqual(
            item["nativeMetadata"],
            {
                "desktopShared": True,
                "pinningSupported": True,
            },
        )

    def test_idle_pin_and_unpin_with_bounded_readback(self):
        """Idle thread pin and unpin successfully verify through read-only SQLite."""
        # Pin
        res = self.bridge.message_action(THREAD_1, {"action": "pin"})
        self.assertTrue(res["ok"])
        self.assertTrue(res["session"]["pinned"])
        self.assertEqual(res["session"]["nativeMetadata"]["pinningSupported"], True)
        self.assertIn(
            (
                "thread/section/move",
                {
                    "threadId": THREAD_1,
                    "sectionId": PINNED_SECTION_ID,
                    "beforeThreadId": None,
                },
            ),
            self.backend.calls,
        )

        # Verify list now returns pinned=True
        sessions = self.bridge.list(archived=False)
        self.assertTrue(sessions[0]["pinned"])

        # Pin again when already pinned: must not send redundant RPC
        self.backend.calls.clear()
        res_noop = self.bridge.message_action(THREAD_1, {"action": "pin"})
        self.assertTrue(res_noop["ok"])
        self.assertTrue(res_noop["session"]["pinned"])
        self.assertEqual(self.backend.calls, [])

        # Unpin
        res_unpin = self.bridge.message_action(THREAD_1, {"action": "unpin"})
        self.assertTrue(res_unpin["ok"])
        self.assertFalse(res_unpin["session"]["pinned"])
        self.assertIn(
            (
                "thread/section/move",
                {"threadId": THREAD_1, "sectionId": None, "beforeThreadId": None},
            ),
            self.backend.calls,
        )

    def test_idle_archive_and_restore_with_bounded_readback(self):
        """Idle archive and unarchive update authoritative DB and reflect in queries."""
        # Archive
        res = self.bridge.message_action(THREAD_1, {"action": "archive"})
        self.assertTrue(res["ok"])
        self.assertTrue(res["session"]["archived"])
        self.assertIn(("thread/archive", {"threadId": THREAD_1}), self.backend.calls)

        # archived=False should now be empty
        self.assertEqual(self.bridge.list(archived=False), [])
        # archived=True must include the archived session
        archived_list = self.bridge.list(archived=True)
        self.assertEqual(len(archived_list), 1)
        self.assertEqual(archived_list[0]["id"], THREAD_1)
        self.assertTrue(archived_list[0]["archived"])

        # Archive again when already archived: must not send redundant RPC
        self.backend.calls.clear()
        res_noop = self.bridge.message_action(THREAD_1, {"action": "archive"})
        self.assertTrue(res_noop["ok"])
        self.assertTrue(res_noop["session"]["archived"])
        self.assertEqual(self.backend.calls, [])

        # Restore (unarchive)
        res_unarchive = self.bridge.message_action(THREAD_1, {"action": "unarchive"})
        self.assertTrue(res_unarchive["ok"])
        self.assertFalse(res_unarchive["session"]["archived"])
        self.assertIn(("thread/unarchive", {"threadId": THREAD_1}), self.backend.calls)

        # Verify back in active list
        self.assertEqual(len(self.bridge.list(archived=False)), 1)
        self.assertEqual(self.bridge.list(archived=True), [])

    def test_live_thread_pin_archive_and_rename(self):
        """Live chat instance executes actions through chat.backend and updates chat state."""

        class MockChat:
            def __init__(self, backend):
                self.backend = backend
                self.actions = threading.RLock()
                self.condition = threading.Condition()
                self.connected = True
                self.submissions = {}
                self.state = {
                    "title": "会话一",
                    "requests": [],
                    "threadRuntimeStatus": {"type": "idle"},
                }

            def changed(self):
                pass

        chat = MockChat(self.backend)
        self.bridge.live[THREAD_1] = chat

        # Live Pin
        res = self.bridge.message_action(THREAD_1, {"action": "pin"})
        self.assertTrue(res["ok"])
        self.assertTrue(res["session"]["pinned"])

        # Live Archive
        res_arc = self.bridge.message_action(THREAD_1, {"action": "archive"})
        self.assertTrue(res_arc["ok"])
        self.assertTrue(res_arc['session']['archived'])

        # Live Rename
        self.bridge.view = lambda _tid: {"title": chat.state["title"]}
        view = self.bridge.rename(THREAD_1, "实时新标题")
        self.assertEqual(chat.state["title"], "实时新标题")
        self.assertEqual(view["title"], "实时新标题")
        self.assertIn(
            ("thread/name/set", {"threadId": THREAD_1, "name": "实时新标题"}),
            self.backend.calls,
        )

    def test_external_native_mutation_overrides_stale_web_maps_and_overrides(self):
        """Desktop external DB changes take authority over stale records and titleOverrides."""
        # 1. Desktop renamed the thread externally in SQLite
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                'UPDATE threads SET name = "桌面权威名称", title = "桌面权威名称" WHERE id = ?',
                (THREAD_1,),
            )
            conn.commit()

        # Set stale local titleOverride and local record
        self.bridge.records["titleOverrides"][THREAD_1] = "旧的覆盖标题"
        self.bridge.records["threads"][THREAD_1]["title"] = "旧的记录标题"

        # Listing must return Desktop name, ignoring stale titleOverride
        sessions = self.bridge.list(archived=False)
        self.assertEqual(sessions[0]["title"], "桌面权威名称")
        self.assertEqual(sessions[0]["name"], "桌面权威名称")

        # 2. Desktop archived the thread externally in SQLite
        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE threads SET archived = 1 WHERE id = ?", (THREAD_1,))
            conn.commit()

        # Local record still has archived: False
        self.bridge.records["threads"][THREAD_1]["archived"] = False

        # Query archived=False: thread must NOT appear
        self.assertEqual(self.bridge.list(archived=False), [])

        # Query archived=True: thread MUST appear from native authority
        archived_sessions = self.bridge.list(archived=True)
        self.assertEqual(len(archived_sessions), 1)
        self.assertEqual(archived_sessions[0]["id"], THREAD_1)
        self.assertTrue(archived_sessions[0]["archived"])

    def test_rename_clears_stale_title_override(self):
        """Authoritative rename clears old titleOverride and updates shared records."""
        self.bridge.records["titleOverrides"][THREAD_1] = "旧覆盖"
        self.bridge.view = lambda _tid: {"id": THREAD_1, "title": "新改的名称"}

        self.bridge.rename(THREAD_1, "新改的名称")
        self.assertNotIn(THREAD_1, self.bridge.records["titleOverrides"])
        self.assertEqual(
            self.bridge.records["threads"][THREAD_1]["title"], "新改的名称"
        )

    def test_unsupported_pinning_when_schema_lacks_section_column(self):
        """Schema without thread_section_id reports pinningSupported=False and rejects pin."""
        temp_dir2 = tempfile.TemporaryDirectory()
        try:
            home2 = Path(temp_dir2.name) / ".codex"
            home2.mkdir(parents=True)
            db_path2 = str(home2 / "state_4.sqlite")
            self._init_db(db_path2, include_section=False)
            history2 = WslHistory(home2, self.workspaces)
            self.bridge.history = history2

            sessions = self.bridge.list(archived=False)
            self.assertFalse(sessions[0]["pinned"])
            self.assertFalse(sessions[0]["nativeMetadata"]["pinningSupported"])

            with self.assertRaisesRegex(ValueError, "不支持原生置顶"):
                self.bridge.message_action(THREAD_1, {"action": "pin"})
        finally:
            temp_dir2.cleanup()

    def test_empty_ack_without_native_mutation_raises_error(self):
        """Backend returning empty ACK without actual SQLite change fails readback."""
        self.backend.simulate_empty_ack = True
        with self.assertRaisesRegex(ValueError, "未确认置顶状态变更"):
            self.bridge.message_action(THREAD_1, {"action": "pin"})

        with self.assertRaisesRegex(ValueError, "未确认归档状态变更"):
            self.bridge.message_action(THREAD_1, {"action": "archive"})

        self.bridge.view = lambda _tid: {}
        with self.assertRaisesRegex(ValueError, "未确认名称变更"):
            self.bridge.rename(THREAD_1, "永远不生效的名称")

    def test_timeout_does_not_repeat_write_or_save_local_success(self):
        """Timeout on native RPC propagates and never leaves fake local success."""
        self.backend.timeout_on_method = "thread/section/move"
        with self.assertRaisesRegex(TimeoutError, "thread/section/move"):
            self.bridge.message_action(THREAD_1, {"action": "pin"})
        self.assertFalse(self.bridge.list(archived=False)[0]["pinned"])

        self.backend.timeout_on_method = "thread/archive"
        with self.assertRaisesRegex(TimeoutError, "thread/archive"):
            self.bridge.message_action(THREAD_1, {"action": "archive"})
        self.assertFalse(self.bridge.records["threads"][THREAD_1].get("archived"))

    def test_unauthorized_id_and_out_of_scope_rejection(self):
        """Actions on unknown or out-of-scope thread IDs fail immediately."""
        unauthorized = "01901234-5678-7000-8000-999999999999"
        with self.assertRaises(KeyError):
            self.bridge.message_action(unauthorized, {"action": "pin"})

        with self.assertRaises(ValueError):
            self.bridge.message_action("not-a-valid-uuid", {"action": "pin"})

    def test_busy_and_queued_guards(self):
        """Actions are blocked when thread is active, queued, or waiting for requests."""
        # 1. Local submissions queued
        self.bridge.records["threads"][THREAD_1]["submissions"] = {
            "sub1": {"status": "queued"}
        }
        with self.assertRaisesRegex(ValueError, "处理队列"):
            self.bridge.message_action(THREAD_1, {"action": "archive"})
        self.bridge.view = lambda _identifier: {'title': self.history.get(THREAD_1)['name']}
        self.assertEqual(self.bridge.rename(THREAD_1, '新名称')['title'], '新名称')
        self.bridge.records["threads"][THREAD_1]["submissions"].clear()

        # 2. Live chat waiting for requests
        class BusyChat:
            def __init__(self):
                self.actions = threading.RLock()
                self.backend = self_backend
                self.submissions = {}
                self.state = {
                    "requests": [{"id": "req1"}],
                    "threadRuntimeStatus": {"type": "idle"},
                }

        self_backend = self.backend
        self.bridge.live[THREAD_1] = BusyChat()
        with self.assertRaisesRegex(ValueError, "处理当前问题"):
            self.bridge.message_action(THREAD_1, {"action": "archive"})

        # 3. Live chat active
        self.bridge.live[THREAD_1].state = {
            "requests": [],
            "threadRuntimeStatus": {"type": "active"},
        }
        self.backend.status = 'active'
        with self.assertRaisesRegex(ValueError, "正在执行任务"):
            self.bridge.message_action(THREAD_1, {"action": "archive"})
        self.bridge.live.clear()
        with self.assertRaisesRegex(ValueError, '正在执行任务'):
            self.bridge.message_action(THREAD_1, {'action':'archive'})
        self.assertFalse(any(method == 'thread/archive' for method, _ in self.backend.calls))


if __name__ == "__main__":
    unittest.main()
