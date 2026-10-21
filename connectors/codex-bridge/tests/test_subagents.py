"""Tests for native Codex subagents discovery, lineage, boundary security, and read-only views."""

import itertools
import json
import sqlite3
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bridge.clients.codex.subagent_views import subagents
from bridge.features.sessions.store import SessionStore


def create_schema(conn):
    conn.execute("""
        CREATE TABLE threads (
            id TEXT PRIMARY KEY,
            title TEXT,
            name TEXT,
            cwd TEXT,
            rollout_path TEXT,
            source TEXT,
            thread_source TEXT,
            originator TEXT,
            updated_at REAL,
            created_at REAL,
            archived INTEGER DEFAULT 0,
            status TEXT
        )
    """)


class MockBridge:
    def __init__(self, store, workspaces=None, records=None):
        self.store = store
        self.history = None
        self.web_history = None
        self.workspaces = workspaces or []
        self.records = records or {"threads": {}}


class SubagentViewsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="codex-test-subagents-")
        self.home = Path(self.temp_dir.name).resolve()
        self.sessions_dir = self.home / "sessions"
        self.sessions_dir.mkdir(parents=True)
        self.workspace_dir = self.home / "workspace"
        self.workspace_dir.mkdir(parents=True)

        self.db_path = self.home / "state_1.sqlite"
        with sqlite3.connect(self.db_path) as conn:
            create_schema(conn)

        self.store = SessionStore(self.home)
        self.bridge = MockBridge(
            self.store,
            workspaces=[{"path": self.workspace_dir, "name": "test", "key": "test"}],
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def _insert_thread(
        self,
        thread_id,
        name=None,
        title=None,
        parent_id=None,
        rollout_content=None,
        originator="Codex Desktop",
        thread_source=None,
        cwd=None,
        nickname=None,
        role=None,
        archived=0,
    ):
        cwd = cwd or str(self.workspace_dir)
        source = {}
        if parent_id:
            thread_source = "subagent"
            source = {
                "subagent": {
                    "thread_spawn": {
                        "parent_thread_id": parent_id,
                        "agent_nickname": nickname or "子探针",
                        "agent_role": role or "explorer",
                        "agent_path": "/subagents/explorer",
                    }
                }
            }

        rollout_path = None
        if rollout_content is not None:
            r_file = self.sessions_dir / f"{thread_id}.jsonl"
            r_file.write_text(rollout_content, encoding="utf-8")
            rollout_path = str(r_file)

        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO threads (id, title, name, cwd, rollout_path, source, thread_source, originator, updated_at, created_at, archived)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1000.0, 1000.0, ?)
                """,
                (
                    thread_id,
                    title,
                    name,
                    cwd,
                    rollout_path,
                    json.dumps(source),
                    thread_source,
                    originator,
                    archived,
                ),
            )

    def test_parent_child_and_grandchild_lineage(self):
        parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())
        grandchild_id = str(uuid.uuid4())

        self._insert_thread(parent_id, name="主任务")
        self._insert_thread(
            child_id,
            parent_id=parent_id,
            nickname="子助手",
            role="coder",
            rollout_content='{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}\n{"type":"event_msg","payload":{"type":"task_completed"}}\n',
        )
        self._insert_thread(
            grandchild_id,
            parent_id=child_id,
            nickname="孙助手",
            role="reviewer",
            rollout_content='{"type":"event_msg","payload":{"type":"task_started","turn_id":"t2"}}\n{"type":"event_msg","payload":{"type":"task_completed"}}\n',
        )

        res = subagents(self.bridge, parent_id)
        agents = res["agents"]
        self.assertEqual(len(agents), 2)
        ids = {a["id"] for a in agents}
        self.assertEqual(ids, {child_id, grandchild_id})
        self.assertFalse(res["limited"])

        # Title formatting: not UUID
        child_agent = next(a for a in agents if a["id"] == child_id)
        self.assertEqual(child_agent["nickname"], "子助手")
        self.assertEqual(child_agent["role"], "coder")
        self.assertIn("子助手", child_agent["title"])
        self.assertEqual(child_agent["status"], "completed")

        # Detail for child
        child_detail = subagents(self.bridge, parent_id, child_id)
        self.assertEqual(child_detail["id"], child_id)
        self.assertEqual(child_detail["status"], "completed")

        # Detail for grandchild: lineage through parent
        grandchild_detail = subagents(self.bridge, parent_id, grandchild_id)
        self.assertEqual(grandchild_detail["id"], grandchild_id)
        self.assertEqual(grandchild_detail["status"], "completed")

    def test_reject_cross_parent_access(self):
        parent_a = str(uuid.uuid4())
        parent_b = str(uuid.uuid4())
        child_b = str(uuid.uuid4())

        self._insert_thread(parent_a, name="父会话A")
        self._insert_thread(parent_b, name="父会话B")
        self._insert_thread(
            child_b,
            parent_id=parent_b,
            rollout_content='{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}\n',
        )

        # parent_a cannot access child_b
        with self.assertRaises(KeyError) as cm:
            subagents(self.bridge, parent_a, child_b)
        self.assertIn("子智能体不属于此聊天", str(cm.exception))

    def test_unknown_status_not_forced_completed(self):
        parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())

        self._insert_thread(parent_id, name="主任务")
        # Rollout has no task_completed
        self._insert_thread(
            child_id,
            parent_id=parent_id,
            nickname="未知状态子智能体",
            rollout_content='{"type":"event_msg","payload":{"type":"something_else"}}\n',
        )

        res = subagents(self.bridge, parent_id)
        agent = res["agents"][0]
        self.assertEqual(agent["status"], "unknown")
        self.assertNotEqual(agent["status"], "completed")

    def test_rollout_path_escape_rejected(self):
        parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())

        # An external file outside codex home
        external_file = self.home.parent / "escape.jsonl"
        external_file.write_text("{}", encoding="utf-8")

        self._insert_thread(parent_id, name="主任务")
        self._insert_thread(child_id, parent_id=parent_id)
        # Manually alter rollout_path in DB to point outside home
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE threads SET rollout_path = ? WHERE id = ?",
                (str(external_file), child_id),
            )

        with self.assertRaises(ValueError) as cm:
            subagents(self.bridge, parent_id, child_id)
        self.assertIn("不在 Codex 数据目录中", str(cm.exception))

    def test_adopted_web_parent_not_empty(self):
        web_parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())

        # Originator is web/none instead of Codex Desktop
        self._insert_thread(
            web_parent_id,
            name="网页主任务",
            originator="web",
            rollout_content='{"type":"event_msg","payload":{"type":"task_started","turn_id":"t0"}}\n',
        )
        self._insert_thread(
            child_id,
            parent_id=web_parent_id,
            nickname="网页子智能体",
            rollout_content='{"type":"event_msg","payload":{"type":"task_completed"}}\n',
        )

        res = subagents(self.bridge, web_parent_id)
        self.assertEqual(len(res["agents"]), 1)
        self.assertEqual(res["agents"][0]["id"], child_id)

    def test_workspace_scope_violation_rejected(self):
        outside_parent_id = str(uuid.uuid4())
        self._insert_thread(
            outside_parent_id,
            name="外部任务",
            cwd="/completely/outside/project",
        )
        with self.assertRaises(PermissionError) as cm:
            subagents(self.bridge, outside_parent_id)
        self.assertIn("项目范围", str(cm.exception))


    def test_limit_128_subagents(self):
        parent_id = str(uuid.uuid4())
        self._insert_thread(parent_id, name="上限测试主任务")
        for i in range(130):
            cid = str(uuid.uuid4())
            self._insert_thread(cid, parent_id=parent_id, nickname=f"子任务{i}")

        res = subagents(self.bridge, parent_id)
        self.assertEqual(len(res["agents"]), 128)
        self.assertTrue(res["limited"])

    def test_lineage_depth_protection(self):
        # 33 levels deep should be rejected (limit is 32)
        chain = [str(uuid.uuid4()) for _ in range(35)]
        self._insert_thread(chain[0], name="顶层根会话")
        for p, c in itertools.pairwise(chain):
            self._insert_thread(c, parent_id=p, nickname="链条节点")

        # chain[33] is 33 steps from chain[0], exceeds 32
        with self.assertRaises(KeyError) as cm:
            subagents(self.bridge, chain[0], chain[33])
        self.assertIn("子智能体不属于此聊天", str(cm.exception))

    def test_subagent_cannot_impersonate_parent(self):
        parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())
        grandchild_id = str(uuid.uuid4())

        self._insert_thread(parent_id, name="主任务")
        self._insert_thread(child_id, parent_id=parent_id, nickname="中间子任务")
        self._insert_thread(grandchild_id, parent_id=child_id, nickname="孙任务")

        # child_id is a subagent, cannot impersonate as root parent to list or inspect
        with self.assertRaises(KeyError) as cm:
            subagents(self.bridge, child_id)
        self.assertIn("不是主会话", str(cm.exception))

    def test_no_storedb_candidate_fallback(self):
        # Create a mock store with no database file (will throw sqlite3.OperationalError/OSError)
        empty_home = self.home / "empty_store_home"
        empty_home.mkdir(parents=True)
        broken_store = SessionStore(empty_home)

        # Place broken store first in bridge candidate chain
        self.bridge.history = broken_store
        self.bridge.web_history = self.store

        parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())
        self._insert_thread(parent_id, name="容错回退任务")
        self._insert_thread(child_id, parent_id=parent_id, nickname="回退子任务")

        # Subagents discovery must not fail with 500/OperationalError, but smoothly fallback to web_history
        res = subagents(self.bridge, parent_id)
        self.assertEqual(len(res["agents"]), 1)
        self.assertEqual(res["agents"][0]["id"], child_id)

    def test_ancestor_cross_home_rejected(self):
        parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())
        grandchild_id = str(uuid.uuid4())

        external_file = self.home.parent / "external_ancestor.jsonl"
        external_file.write_text("{}", encoding="utf-8")

        self._insert_thread(parent_id, name="主任务")
        self._insert_thread(child_id, parent_id=parent_id, nickname="中间子任务")
        self._insert_thread(
            grandchild_id,
            parent_id=child_id,
            nickname="孙任务",
            rollout_content='{"type":"event_msg","payload":{"type":"task_completed"}}\n',
        )

        # Alter ancestor's rollout_path to be outside home
        with sqlite3.connect(self.db_path) as conn:
            conn.execute(
                "UPDATE threads SET rollout_path = ? WHERE id = ?",
                (str(external_file), child_id),
            )

        with self.assertRaises(ValueError) as cm:
            subagents(self.bridge, parent_id, grandchild_id)
        self.assertIn("不在 Codex 数据目录中", str(cm.exception))

    def test_adopted_web_parent_from_records_reuse(self):
        web_parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())

        # Web parent only in records, not in threads table of primary DB
        self.bridge.records = {
            "threads": {
                web_parent_id: {
                    "id": web_parent_id,
                    "name": "Live Web Parent",
                    "cwd": str(self.workspace_dir),
                    "source": "web",
                }
            }
        }
        self._insert_thread(child_id, parent_id=web_parent_id, nickname="Web派生子任务")

        res = subagents(self.bridge, web_parent_id)
        self.assertEqual(len(res["agents"]), 1)
        self.assertEqual(res["agents"][0]["nickname"], "Web派生子任务")

    def test_pure_read_only_no_database_mutation(self):
        parent_id = str(uuid.uuid4())
        child_id = str(uuid.uuid4())
        self._insert_thread(parent_id, name="主任务")
        self._insert_thread(
            child_id,
            parent_id=parent_id,
            nickname="只读子智能体",
            rollout_content='{"type":"event_msg","payload":{"type":"task_started","turn_id":"t1"}}\n{"type":"event_msg","payload":{"type":"task_complete"}}\n',
        )

        with sqlite3.connect(self.db_path) as conn:
            before_count = conn.execute("SELECT COUNT(*) FROM threads").fetchone()[0]

        subagents(self.bridge, parent_id)
        subagents(self.bridge, parent_id, child_id)

        with sqlite3.connect(self.db_path) as conn:
            after_count = conn.execute("SELECT COUNT(*) FROM threads").fetchone()[0]

        self.assertEqual(before_count, after_count)


if __name__ == "__main__":
    unittest.main()
