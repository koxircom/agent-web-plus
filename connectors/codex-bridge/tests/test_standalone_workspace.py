import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import StandaloneBridge


class StandaloneWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp(prefix="codex-standalone-ws-")
        self.ws_root = Path(self.temp_dir).resolve()
        self.workspaces = [
            {"key": "local|test", "name": "TestWS", "path": str(self.ws_root)}
        ]

    def test_create_chat_with_valid_scoped_cwd(self):
        sub = self.ws_root / "feature-a"
        sub.mkdir()

        calls = []

        class MockBackend:
            def start(self):
                pass

            def request(self, method, params, timeout=30):
                calls.append((method, params))
                if method == "thread/start":
                    return {"thread": {"id": str(uuid.uuid4()), "cwd": params["cwd"]}}
                if method == "thread/name/set":
                    return {"ok": True}
                return {}

        bridge = StandaloneBridge.__new__(StandaloneBridge)
        bridge.workspaces = [
            {"key": "local|test", "name": "TestWS", "path": self.ws_root}
        ]
        bridge.workspace_by_key = {"local|test": bridge.workspaces[0]}
        bridge.history_socket = None
        bridge.runtime = MockBackend()
        bridge.lock = threading.RLock()
        bridge.registry_lock = threading.RLock()
        bridge.records = {"creations": {}, "threads": {}}
        bridge.live = {}
        bridge.uploads = None
        bridge.save = lambda: None
        bridge.history_home = None
        bridge.store = SimpleNamespace(home=Path(self.temp_dir))
        bridge._validated_rollout_path = lambda p, h: None

        req_id = str(uuid.uuid4())
        res = bridge.create_chat("local|test", "测试新聊天", req_id, cwd=str(sub))
        self.assertTrue(res["opened"])
        self.assertEqual(res["cwd"], str(sub))

        start_calls = [c for c in calls if c[0] == "thread/start"]
        self.assertEqual(len(start_calls), 1)
        self.assertEqual(start_calls[0][1]["cwd"], str(sub))

    def test_create_chat_idempotency_checks_cwd_and_legacy_records(self):
        sub1 = self.ws_root / "ws-sub1"
        sub1.mkdir()
        sub2 = self.ws_root / "ws-sub2"
        sub2.mkdir()

        calls = []

        class MockBackend:
            def start(self):
                pass

            def request(self, method, params, timeout=30):
                calls.append((method, params))
                if method == "thread/start":
                    return {"thread": {"id": str(uuid.uuid4()), "cwd": params["cwd"]}}
                if method == "thread/name/set":
                    return {"ok": True}
                return {}

        bridge = StandaloneBridge.__new__(StandaloneBridge)
        bridge.workspaces = [
            {"key": "local|test", "name": "TestWS", "path": self.ws_root}
        ]
        bridge.workspace_by_key = {"local|test": bridge.workspaces[0]}
        bridge.history_socket = None
        bridge.runtime = MockBackend()
        bridge.lock = threading.RLock()
        bridge.registry_lock = threading.RLock()
        bridge.records = {"creations": {}, "threads": {}}
        bridge.live = {}
        bridge.uploads = None
        bridge.save = lambda: None
        bridge.history_home = None
        bridge.store = SimpleNamespace(home=Path(self.temp_dir))
        bridge._validated_rollout_path = lambda p, h: None

        req_id = str(uuid.uuid4())
        # First creation succeeds
        res1 = bridge.create_chat("local|test", "会话A", req_id, cwd=str(sub1))
        thread_id = res1["id"]

        # Same requestId, same cwd and title -> idempotent return
        res2 = bridge.create_chat("local|test", "会话A", req_id, cwd=str(sub1))
        self.assertEqual(res2["id"], thread_id)

        # Same requestId, different cwd -> fails
        with self.assertRaises(ValueError) as ctx:
            bridge.create_chat("local|test", "会话A", req_id, cwd=str(sub2))
        self.assertIn("工作区", str(ctx.exception))

        # Test legacy creation record without 'cwd' field, inferring from thread entry
        legacy_req_id = str(uuid.uuid4())
        legacy_thread_id = str(uuid.uuid4())
        bridge.records["creations"][legacy_req_id] = {"title": "旧版会话", "id": legacy_thread_id}
        bridge.records["threads"][legacy_thread_id] = {"title": "旧版会话", "cwd": str(sub1)}

        # Legacy same cwd -> succeeds
        legacy_res = bridge.create_chat("local|test", "旧版会话", legacy_req_id, cwd=str(sub1))
        self.assertEqual(legacy_res["id"], legacy_thread_id)

        # Legacy different cwd -> fails
        with self.assertRaises(ValueError):
            bridge.create_chat("local|test", "旧版会话", legacy_req_id, cwd=str(sub2))

    def test_create_chat_with_escaped_cwd_rejected(self):
        bridge = StandaloneBridge.__new__(StandaloneBridge)
        bridge.workspaces = [
            {"key": "local|test", "name": "TestWS", "path": self.ws_root}
        ]
        bridge.workspace_by_key = {"local|test": bridge.workspaces[0]}
        req_id = str(uuid.uuid4())
        with self.assertRaises(PermissionError):
            bridge.create_chat(
                "local|test", "逃逸聊天", req_id, cwd=tempfile.gettempdir()
            )

    def test_http_api_whitelist_enforcement(self):
        from bridge.api.httpd import Handler

        class MockServer:
            def __init__(self, bridge_obj):
                self.bridge = bridge_obj
                self.auth = SimpleNamespace(config={"mode": "none"}, permitted=lambda ip: True)
                self.notifications = None
                self.mobile_updates = None

        class DummyBridge:
            standalone = True
            def worktree_info(self, cwd): return {"isGit": True, "cwd": cwd}
            def create_worktree(self, cwd, branch): return {"path": cwd, "branch": branch}
            def browse_directories(self, path): return {"path": path or ""}
            def validate_cwd(self, cwd): return {"cwd": cwd}
            def create_chat(self, project, title, req_id, cwd=None): return {"id": req_id}

        bridge = DummyBridge()
        server = MockServer(bridge)

        def make_handler(req_path, write_mode):
            h = Handler.__new__(Handler)
            h.server = server
            h.write = write_mode
            h.path = req_path
            h.headers = {}
            h.client = lambda: {"ip": "127.0.0.1"}
            h.check_request = lambda write: None
            h.authorized = lambda write: True
            h.outputs = []
            h.output = lambda status, body: h.outputs.append((status, body))
            return h

        # 1. /api/projects/worktrees GET with extra query params fails
        h = make_handler("/api/projects/worktrees?cwd=/path&illegal=1", write_mode=False)
        h.handle_method(write=False)
        self.assertEqual(h.outputs[0][0], 400)

        # 2. /api/projects/worktrees GET with valid query succeeds
        h = make_handler("/api/projects/worktrees?cwd=/path", write_mode=False)
        h.handle_method(write=False)
        self.assertEqual(h.outputs[0][0], 200)

        # 3. /api/projects/worktrees POST with extra query fails
        h = make_handler("/api/projects/worktrees?extra=1", write_mode=True)
        h.read_json = lambda: {"cwd": "/path", "branch": "br"}
        h.handle_method(write=True)
        self.assertEqual(h.outputs[0][0], 400)

        # 4. /api/projects/browse POST returns 405
        h = make_handler("/api/projects/browse", write_mode=True)
        h.handle_method(write=True)
        self.assertEqual(h.outputs[0][0], 405)

        # 5. /api/projects/resolve GET returns 405
        h = make_handler("/api/projects/resolve", write_mode=False)
        h.handle_method(write=False)
        self.assertEqual(h.outputs[0][0], 405)

        # 6. Non-standalone bridge create_chat doesn't pass cwd
        non_standalone_bridge = SimpleNamespace(
            standalone=False,
            create_chat=lambda project, title, req_id: {"id": req_id, "legacy": True}
        )
        server.bridge = non_standalone_bridge
        h = make_handler("/api/sessions", write_mode=True)
        h.read_json = lambda: {"project": "p", "title": "t", "id": "1", "cwd": "/some/cwd"}
        h.handle_method(write=True)
        self.assertEqual(h.outputs[0][0], 200)
        self.assertTrue(h.outputs[0][1].get("legacy"))


if __name__ == "__main__":
    unittest.main()
