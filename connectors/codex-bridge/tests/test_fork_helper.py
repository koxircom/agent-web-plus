"""测试 Codex 定向 fork helper：按选定用户轮次之前分支，与现有 Desktop 共享原生线程。"""

import json
import os
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from bridge.clients.codex.fork_helper import (
    _SCHEMA_CACHE,
    execute_fork_action,
    validate_thread_fork_schema,
)
from bridge.features.sessions.timeline import Timeline


class MockChat:
    def __init__(self, thread_id, state):
        self.id = thread_id
        self.state = state
        self.condition = threading.RLock()
        self.timeline = Timeline()
        self.sequence = state.get("sequence", 1)

    def view(self, **_kwargs):
        import copy

        return copy.deepcopy(self.state)


def create_schema_fixture(folder: Path, *, supported: bool = True):
    """创建真实临时可执行脚本 fixture，用于生成测试 schema，避免测试后门。"""
    script_path = folder / ("fake_codex.bat" if os.name == "nt" else "fake_codex.sh")
    properties = {
        "deferGoalContinuation": {},
    }
    if supported:
        properties["beforeTurnId"] = {}

    schema_json = json.dumps({"properties": properties})

    if os.name == "nt":
        script_content = f'@echo off\r\nmkdir "%~6" 2>nul\r\necho {schema_json} > "%~6\\ThreadForkParams.json"\r\nexit /b 0\r\n'
    else:
        script_content = f'#!/bin/sh\nfor arg in "$@"; do\n  if [ "$prev" = "--out" ]; then\n    mkdir -p "$arg"\n    cat << \'EOF\' > "$arg/ThreadForkParams.json"\n{schema_json}\nEOF\n  fi\n  prev="$arg"\ndone\nexit 0\n'

    script_path.write_text(script_content, encoding="utf-8")
    script_path.chmod(0o755)
    return script_path


class ForkHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.records_path = self.base_dir / "records.json"
        self.source_id = str(uuid.uuid4())
        self.child_id = str(uuid.uuid4())
        self.ws_path = self.base_dir / "workspace"
        self.ws_path.mkdir(parents=True, exist_ok=True)

        self.history_home = self.base_dir / "desktop-history"
        (self.history_home / "sessions").mkdir(parents=True, exist_ok=True)
        self.valid_rollout = self.history_home / "sessions" / f"{self.child_id}.jsonl"
        self.valid_rollout.write_text('{"type":"session"}\n', encoding="utf-8")

        self.records = {
            "threads": {
                self.source_id: {
                    "title": "源测试会话",
                    "cwd": str(self.ws_path),
                    "runtime": "history",
                    "createdAt": time.time(),
                    "updatedAt": time.time(),
                    "model": "gpt-5.6-turbo",
                    "effort": "high",
                }
            },
            "creations": {},
            "titleOverrides": {},
        }

        # 使用合理 native UUID 值作为 turn IDs，不使用非真实的 'turn-1'
        self.turn_id_1 = str(uuid.uuid4())
        self.turn_id_2 = str(uuid.uuid4())
        self.turn_id_3 = str(uuid.uuid4())

        self.state = {
            "id": self.source_id,
            "title": "源测试会话",
            "sequence": 1,
            "cwd": str(self.ws_path),
            "turns": [
                {
                    "id": self.turn_id_1,
                    "actionable": True,
                    "status": "completed",
                    "messages": [
                        {
                            "id": str(uuid.uuid4()),
                            "role": "user",
                            "kind": "userMessage",
                            "text": "问题一",
                        },
                        {
                            "id": str(uuid.uuid4()),
                            "role": "assistant",
                            "kind": "message",
                            "text": "回答一",
                        },
                    ],
                },
                {
                    "id": self.turn_id_2,
                    "actionable": True,
                    "status": "completed",
                    "messages": [
                        {
                            "id": str(uuid.uuid4()),
                            "role": "user",
                            "kind": "userMessage",
                            "text": "问题二",
                        },
                        {
                            "id": str(uuid.uuid4()),
                            "role": "assistant",
                            "kind": "message",
                            "text": "回答二",
                        },
                    ],
                },
                {
                    "id": self.turn_id_3,
                    "actionable": True,
                    "status": "completed",
                    "messages": [
                        {
                            "id": str(uuid.uuid4()),
                            "role": "user",
                            "kind": "userMessage",
                            "text": "问题三",
                        },
                        {
                            "id": str(uuid.uuid4()),
                            "role": "assistant",
                            "kind": "message",
                            "text": "回答三",
                        },
                    ],
                },
            ],
        }

        self.chat = MockChat(self.source_id, self.state)
        self.chat.timeline.update(self.state)

        self.rpc_calls = []

        class MockBackend:
            def __init__(self, outer):
                self.outer = outer

            def start(self):
                pass

            def request(self, method, params, timeout=None):
                self.outer.rpc_calls.append((method, params, timeout))
                if method == "thread/fork":
                    before_turn_id = params["beforeTurnId"]
                    # 模拟返回排除 beforeTurnId 及其后的所有轮次，保留恰好之前的前缀轮次
                    remaining_turns = []
                    for t in self.outer.state["turns"]:
                        if t["id"] == before_turn_id:
                            break
                        remaining_turns.append({"id": t["id"]})
                    return {
                        "thread": {
                            "id": self.outer.child_id,
                            "cwd": str(self.outer.ws_path),
                            "turns": remaining_turns,
                            "path": str(self.outer.valid_rollout),
                            "ephemeral": False,
                        }
                    }
                if method == "thread/name/set":
                    return {"ok": True}
                return {}

        self.backend = MockBackend(self)

        class MockStore:
            home = self.base_dir

        self.executable_fixture = create_schema_fixture(self.base_dir, supported=True)

        class MockBridge:
            def __init__(self, outer):
                self.outer = outer
                self.records = outer.records
                self.registry_lock = threading.RLock()
                self.lock = threading.RLock()
                self.executable = str(outer.executable_fixture)
                self.uploads = {}
                self.catalog_reader = None
                self.history_home = outer.history_home
                self.history_socket = "mock-socket"
                self.runtime = outer.backend
                self.store = MockStore()
                self.workspaces = [{"path": outer.ws_path, "name": "test-ws"}]
                self.live = {outer.source_id: outer.chat}

            def _scoped_record(self, thread_id):
                if thread_id not in self.records["threads"]:
                    raise PermissionError("会话不存在或无权访问")
                return self.records["threads"][thread_id]

            def session(self, thread_id, attach=False):
                return self.outer.chat

            def _with_title_override(self, _id, view):
                return view

            def _history_backend(self):
                return self.runtime

            def _validated_rollout_path(self, path, home):
                if not path:
                    return None
                resolved = Path(path).resolve()
                if not resolved.is_file():
                    return None
                try:
                    if resolved.is_relative_to((Path(home) / "sessions").resolve()):
                        return str(resolved)
                except (OSError, RuntimeError, ValueError):
                    pass
                return None

            def save(self):
                pass

            def _start_queue(self, _chat):
                pass

        self.bridge = MockBridge(self)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_fork_before_second_turn_excludes_current_and_future_turns(self):
        """在中段（第2轮）之前分支：前缀恰好包含第一轮，排除第2轮及以后的轮次。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )
        self.assertTrue(u2_row["forkable"])

        req_id = str(uuid.uuid4())
        body = {
            "requestId": req_id,
            "key": u2_row["key"],
            "version": u2_row["version"],
            "epoch": self.chat.timeline.epoch,
        }

        result = execute_fork_action(self.bridge, self.source_id, body)
        self.assertTrue(result["ok"])
        self.assertEqual(result["childId"], self.child_id)
        self.assertNotEqual(result["childId"], self.source_id)

        fork_calls = [c for c in self.rpc_calls if c[0] == "thread/fork"]
        self.assertEqual(len(fork_calls), 1)
        _method, params, _timeout = fork_calls[0]
        self.assertEqual(
            params,
            {
                "threadId": self.source_id,
                "beforeTurnId": self.turn_id_2,
                "deferGoalContinuation": True,
                "ephemeral": False,
                "excludeTurns": False,
            },
        )

        child_entry = self.bridge.records["threads"].get(self.child_id)
        self.assertIsNotNone(child_entry)
        self.assertEqual(child_entry["parent"], self.source_id)
        self.assertEqual(
            child_entry["forkedFrom"],
            {
                "threadId": self.source_id,
                "beforeTurnId": self.turn_id_2,
            },
        )
        self.assertEqual(child_entry["cwd"], str(self.ws_path))
        self.assertEqual(child_entry["model"], "gpt-5.6-turbo")
        self.assertEqual(child_entry["effort"], "high")
        self.assertEqual(child_entry["path"], str(self.valid_rollout))

        creation = self.bridge.records["creations"].get(req_id)
        self.assertEqual(creation["status"], "created")
        self.assertEqual(creation["id"], self.child_id)
        self.assertTrue(creation["named"])

    def test_fork_before_first_turn_produces_empty_prefix(self):
        """在首轮之前分支：生成空前缀。"""
        u1_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_1 and r.get("role") == "user"
        )
        self.assertTrue(u1_row["forkable"])

        req_id = str(uuid.uuid4())
        body = {
            "requestId": req_id,
            "key": u1_row["key"],
            "version": u1_row["version"],
            "epoch": self.chat.timeline.epoch,
        }

        result = execute_fork_action(self.bridge, self.source_id, body)
        self.assertTrue(result["ok"])
        self.assertEqual(result["childId"], self.child_id)

        fork_calls = [c for c in self.rpc_calls if c[0] == "thread/fork"]
        self.assertEqual(fork_calls[-1][1]["beforeTurnId"], self.turn_id_1)

    def test_duplicate_request_id_with_different_payload_is_rejected(self):
        """重复 requestId 但不同 payload（如不同 key）：拒绝并报错。"""
        u1_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_1 and r.get("role") == "user"
        )
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )
        req_id = str(uuid.uuid4())

        execute_fork_action(
            self.bridge,
            self.source_id,
            {
                "requestId": req_id,
                "key": u1_row["key"],
                "version": u1_row["version"],
                "epoch": self.chat.timeline.epoch,
            },
        )

        with self.assertRaises(ValueError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": req_id,
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("不同", str(cm.exception))

    def test_fork_does_not_stop_source_chat_and_mounts_child(self):
        """分支后，源 live chat 保持活跃未关闭，且新 child_chat 已挂载进 bridge.live。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )
        res = execute_fork_action(
            self.bridge,
            self.source_id,
            {
                "requestId": str(uuid.uuid4()),
                "key": u2_row["key"],
                "version": u2_row["version"],
                "epoch": self.chat.timeline.epoch,
            },
        )
        self.assertIn(self.source_id, self.bridge.live)
        self.assertIn(self.child_id, self.bridge.live)
        self.assertEqual(res["childId"], self.child_id)

    def test_timeout_fails_closed_and_never_replays_or_falls_back_to_start(self):
        """超时仅发起一次 RPC，绝不自动重试或回退到 thread/start。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )

        class TimeoutBackend:
            def __init__(self, outer):
                self.outer = outer

            def start(self):
                pass

            def request(self, method, params, timeout=None):
                self.outer.rpc_calls.append((method, params, timeout))
                raise TimeoutError("RPC timed out")

        self.bridge.runtime = TimeoutBackend(self)
        with self.assertRaises(ValueError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": str(uuid.uuid4()),
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("待确认", str(cm.exception))
        fork_calls = [c for c in self.rpc_calls if c[0] == "thread/fork"]
        self.assertEqual(len(fork_calls), 1)
        start_calls = [c for c in self.rpc_calls if c[0] == "thread/start"]
        self.assertEqual(len(start_calls), 0)

    def test_idempotent_duplicate_request_id_returns_same_receipt(self):
        """重复 requestId：同 payload 返回原 receipt，核实 child 身份，不发起第二次 RPC。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )
        req_id = str(uuid.uuid4())
        body = {
            "requestId": req_id,
            "key": u2_row["key"],
            "version": u2_row["version"],
            "epoch": self.chat.timeline.epoch,
        }

        res1 = execute_fork_action(self.bridge, self.source_id, body)
        res2 = execute_fork_action(self.bridge, self.source_id, body)
        self.assertEqual(res1["childId"], res2["childId"])
        self.assertTrue(res2.get("reused"))
        fork_calls = [c for c in self.rpc_calls if c[0] == "thread/fork"]
        self.assertEqual(len(fork_calls), 1)

    def test_concurrent_same_request_id_executes_fork_only_once(self):
        """并发同 requestId：线程安全互斥，RPC 仅执行 1 次，两线程获取同一 childId。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )
        req_id = str(uuid.uuid4())
        body = {
            "requestId": req_id,
            "key": u2_row["key"],
            "version": u2_row["version"],
            "epoch": self.chat.timeline.epoch,
        }

        results = []
        errors = []

        def worker():
            try:
                res = execute_fork_action(self.bridge, self.source_id, body)
                results.append(res)
            except (OSError, RuntimeError, ValueError, TimeoutError) as e:
                errors.append(e)

        t1 = threading.Thread(target=worker)
        t2 = threading.Thread(target=worker)
        t1.start()
        t2.start()
        t1.join()
        t2.join()

        self.assertEqual(len(errors), 0, f"并发请求抛出异常: {errors}")
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["childId"], results[1]["childId"])
        fork_calls = [c for c in self.rpc_calls if c[0] == "thread/fork"]
        self.assertEqual(
            len(fork_calls), 1, "并发同 requestId 应仅调用 1 次 thread/fork"
        )

    def test_stale_epoch_is_rejected(self):
        """客户端传入过期的 epoch 时，严格拒绝并报错，不执行 RPC，无 pending。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )
        req_id = str(uuid.uuid4())
        body = {
            "requestId": req_id,
            "key": u2_row["key"],
            "version": u2_row["version"],
            "epoch": "stale-epoch-" + uuid.uuid4().hex,
        }

        with self.assertRaises(ValueError) as cm:
            execute_fork_action(self.bridge, self.source_id, body)
        self.assertIn("变化", str(cm.exception))

        fork_calls = [c for c in self.rpc_calls if c[0] == "thread/fork"]
        self.assertEqual(len(fork_calls), 0)
        self.assertNotIn(req_id, self.bridge.records.get("creations", {}))

    def test_invalid_or_non_uuid_request_id_is_rejected(self):
        """requestId 必须是有效且长度有界的 UUID 格式。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )
        # 非 UUID
        with self.assertRaises(ValueError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": "not-a-uuid",
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("UUID", str(cm.exception))

        # 超长请求
        with self.assertRaises(ValueError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": "a" * 70,
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("长度", str(cm.exception))

    def test_different_cwd_even_in_same_workspace_is_rejected(self):
        """分支返回的 cwd 必须精确等于源 canonical cwd；不同 cwd 即便同 workspace 也拒绝。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )

        sub_ws = self.ws_path / "subdir"
        sub_ws.mkdir()
        turn_id_1 = self.turn_id_1
        valid_rollout = self.valid_rollout

        class DifferentCwdBackend:
            def start(self):
                pass

            def request(self, method, _params, timeout=None):
                if method == "thread/fork":
                    return {
                        "thread": {
                            "id": str(uuid.uuid4()),
                            "cwd": str(sub_ws),
                            "turns": [{"id": turn_id_1}],
                            "path": str(valid_rollout),
                        }
                    }
                return {}

        self.bridge.runtime = DifferentCwdBackend()
        req_id = str(uuid.uuid4())
        with self.assertRaises(PermissionError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": req_id,
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("不一致", str(cm.exception))

    def test_missing_cwd_and_missing_turns_are_rejected(self):
        """thread.get('cwd') 缺失不能回退源冒充确认；turns 缺失不能当 [] 首轮成功。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )

        turn_id_1 = self.turn_id_1
        ws_path = self.ws_path

        # 缺失 cwd
        class MissingCwdBackend:
            def start(self):
                pass

            def request(self, method, _params, timeout=None):
                if method == "thread/fork":
                    return {
                        "thread": {
                            "id": str(uuid.uuid4()),
                            "turns": [{"id": turn_id_1}],
                        }
                    }
                return {}

        self.bridge.runtime = MissingCwdBackend()
        with self.assertRaises(ValueError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": str(uuid.uuid4()),
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("工作区路径", str(cm.exception))

        # 缺失 turns
        class MissingTurnsBackend:
            def start(self):
                pass

            def request(self, method, _params, timeout=None):
                if method == "thread/fork":
                    return {
                        "thread": {
                            "id": str(uuid.uuid4()),
                            "cwd": str(ws_path),
                        }
                    }
                return {}

        self.bridge.runtime = MissingTurnsBackend()
        with self.assertRaises(ValueError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": str(uuid.uuid4()),
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("轮次", str(cm.exception))

    def test_prefix_turns_mismatch_is_rejected(self):
        """核 prefix 必须恰好源选定 turn 之前完整 native turn IDs，多了或少了均拒绝。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )

        ws_path = self.ws_path
        valid_rollout = self.valid_rollout

        # 假造返回包含错误的 turn id
        class BadPrefixBackend:
            def start(self):
                pass

            def request(self, method, _params, timeout=None):
                if method == "thread/fork":
                    return {
                        "thread": {
                            "id": str(uuid.uuid4()),
                            "cwd": str(ws_path),
                            "turns": [{"id": str(uuid.uuid4())}],  # 不匹配 turn_id_1
                            "path": str(valid_rollout),
                        }
                    }
                return {}

        self.bridge.runtime = BadPrefixBackend()
        with self.assertRaises(ValueError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": str(uuid.uuid4()),
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("轮次", str(cm.exception))

    def test_ephemeral_child_thread_is_rejected(self):
        """必须确认 ephemeral 不是 true。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )

        ws_path = self.ws_path
        turn_id_1 = self.turn_id_1

        class EphemeralBackend:
            def start(self):
                pass

            def request(self, method, _params, timeout=None):
                if method == "thread/fork":
                    return {
                        "thread": {
                            "id": str(uuid.uuid4()),
                            "cwd": str(ws_path),
                            "turns": [{"id": turn_id_1}],
                            "ephemeral": True,
                        }
                    }
                return {}

        self.bridge.runtime = EphemeralBackend()
        with self.assertRaises(ValueError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": str(uuid.uuid4()),
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertIn("临时", str(cm.exception))

    def test_native_child_name_error_safely_recovers_child_receipt_without_refork(
        self,
    ):
        """thread/name/set 命名失败保留 child 可核状态，诚实记录两阶段 receipt，重发不再次 fork。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )

        class NameErrorBackend:
            def __init__(self, outer):
                self.outer = outer
                self.fork_count = 0

            def start(self):
                pass

            def request(self, method, params, timeout=None):
                if method == "thread/fork":
                    self.fork_count += 1
                    return {
                        "thread": {
                            "id": self.outer.child_id,
                            "cwd": str(self.outer.ws_path),
                            "turns": [{"id": self.outer.turn_id_1}],
                            "path": str(self.outer.valid_rollout),
                        }
                    }
                if method == "thread/name/set":
                    raise RuntimeError("Native name set failed")
                return {}

        backend = NameErrorBackend(self)
        self.bridge.runtime = backend
        req_id = str(uuid.uuid4())
        body = {
            "requestId": req_id,
            "key": u2_row["key"],
            "version": u2_row["version"],
            "epoch": self.chat.timeline.epoch,
        }

        # 首次调用：命名失败但两阶段 receipt 依然持久化了 childId
        res1 = execute_fork_action(self.bridge, self.source_id, body)
        self.assertTrue(res1["ok"])
        self.assertFalse(res1.get("named", True))
        self.assertEqual(res1["childId"], self.child_id)
        self.assertIn(self.child_id, self.bridge.records["threads"])

        # 第二次相同请求重试：安全恢复已有 receipt，不再调用 thread/fork
        res2 = execute_fork_action(self.bridge, self.source_id, body)
        self.assertTrue(res2["ok"])
        self.assertTrue(res2.get("reused"))
        self.assertEqual(res2["childId"], self.child_id)
        self.assertEqual(backend.fork_count, 1, "不得再次发起 thread/fork")

    def test_schema_unsupported_rejects_before_pending_without_leaving_pending_record(
        self,
    ):
        """真实的 schema unsupported 必须在写 pending 前拒绝，不能留下永久 pending 记录。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )
        unsupported_fixture = create_schema_fixture(self.base_dir, supported=False)
        self.bridge.executable = str(unsupported_fixture)
        _SCHEMA_CACHE.clear()

        req_id = str(uuid.uuid4())
        body = {
            "requestId": req_id,
            "key": u2_row["key"],
            "version": u2_row["version"],
            "epoch": self.chat.timeline.epoch,
        }

        with self.assertRaises(ValueError) as cm:
            execute_fork_action(self.bridge, self.source_id, body)
        self.assertIn("不支持", str(cm.exception))

        # 验证没有残留 pending 记录
        self.assertNotIn(req_id, self.bridge.records.get("creations", {}))

    def test_schema_transient_failure_does_not_cache_permanently(self):
        """进程超时等暂时性错误不能永久缓存为 False。"""
        with tempfile.TemporaryDirectory() as td:
            fixture = create_schema_fixture(Path(td), supported=True)
            _SCHEMA_CACHE.clear()

            with patch("subprocess.run", side_effect=TimeoutError("Process timed out")):
                with self.assertRaises(ValueError) as cm:
                    validate_thread_fork_schema(str(fixture))
                self.assertIn("无法检查", str(cm.exception))

            # 验证 _SCHEMA_CACHE 中没有缓存 False
            self.assertFalse(any(v is False for v in _SCHEMA_CACHE.values()))

            # 瞬态错误消除后能够直接成功
            self.assertTrue(validate_thread_fork_schema(str(fixture)))

    def test_unverified_rollout_path_rejects_desktop_history_sync(self):
        """未验证 childpath 实际位于正确同一 home 时不能返回 Desktop 同步成功，拒伪造 path。"""
        u2_row = next(
            r
            for r in self.chat.timeline.rows
            if r.get("turnId") == self.turn_id_2 and r.get("role") == "user"
        )

        # 伪造一个位于 /tmp 的路径，不属于 history_home
        fake_path = self.base_dir / "evil" / "fake.jsonl"
        fake_path.parent.mkdir(parents=True, exist_ok=True)
        fake_path.write_text('{"type":"session"}\n', encoding="utf-8")

        ws_path = self.ws_path
        turn_id_1 = self.turn_id_1

        class FakePathBackend:
            def start(self):
                pass

            def request(self, method, _params, timeout=None):
                if method == "thread/fork":
                    return {
                        "thread": {
                            "id": str(uuid.uuid4()),
                            "cwd": str(ws_path),
                            "turns": [{"id": turn_id_1}],
                            "path": str(fake_path),
                        }
                    }
                return {}

        self.bridge.runtime = FakePathBackend()
        with self.assertRaises(PermissionError) as cm:
            execute_fork_action(
                self.bridge,
                self.source_id,
                {
                    "requestId": str(uuid.uuid4()),
                    "key": u2_row["key"],
                    "version": u2_row["version"],
                    "epoch": self.chat.timeline.epoch,
                },
            )
        self.assertTrue("目录" in str(cm.exception) or "同步" in str(cm.exception))


if __name__ == "__main__":
    unittest.main()
