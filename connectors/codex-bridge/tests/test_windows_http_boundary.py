"""HTTP boundary contract tests for Windows Native and Linux standalone gateways.

Pure fake bridge implementations only; does not depend on active Windows desktop backend.
"""

import json
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.api.httpd import GatewayServer
from bridge.clients.codex.ipc import IPCError

THREAD_ID = "00000000-0000-0000-0000-000000000001"


class NativeRejected(ValueError):
    def __init__(self, message="桌面实例拒绝发送"):
        super().__init__(message)
        self.dispatched = False
        self.code = "submission_rejected"
        self.retryable = False


class NativeUnknown(IPCError):
    def __init__(self, message="桌面实例连接中断，投递状态未知"):
        super().__init__(message)
        self.dispatched = None
        self.code = "submission_unknown"
        self.retryable = False


class FakeNativeBridge:
    def __init__(self):
        self.standalone = True
        self.windows_desktop = True
        self.compatibility = {
            "protocol": "agent-web-codex-windows-desktop",
            "version": 1,
            "platform": "win32",
            "capabilities": ["timeline-v1", "prompt-identity-v1", "desktop-owner-v1"],
        }
        self.host_errors = []
        self.clients = None
        self.hosts = SimpleNamespace(
            projects=lambda: [{"key": "win|p1", "name": "P1", "path": "C:\\p1"}]
        )
        self.last_send_kwargs = None
        self.next_send_exception = None

    def for_host(self, host="local"):
        return self

    def runtime_status(self):
        return {
            "mode": "windows_desktop",
            "platform": "win32",
            "connected": True,
            "owner": "codex-desktop-main",
        }

    def send(
        self,
        thread_id,
        text,
        item_id,
        mode,
        skills,
        work_mode=None,
        attachments=None,
        ui_locale=None,
        client_request_id=None,
    ):
        self.last_send_kwargs = {
            "thread_id": thread_id,
            "text": text,
            "id": item_id,
            "mode": mode,
            "skills": skills,
            "work_mode": work_mode,
            "attachments": attachments,
            "ui_locale": ui_locale,
            "client_request_id": client_request_id,
        }
        if self.next_send_exception:
            exc = self.next_send_exception
            self.next_send_exception = None
            raise exc
        return {"status": "accepted", "id": item_id}


class FakeLinuxBridge:
    def __init__(self, workspace_path):
        self.standalone = True
        self.windows_desktop = False
        self.root = Path(workspace_path)
        self.runtime = SimpleNamespace(running=True)
        self.host_errors = []
        self.clients = None
        self.hosts = SimpleNamespace(
            projects=lambda: [
                {"key": "linux|p1", "name": "P1", "path": str(workspace_path)}
            ]
        )
        self.next_send_exception = None

    def for_host(self, host="local"):
        return self

    def send(
        self,
        thread_id,
        text,
        item_id,
        mode,
        skills,
        work_mode=None,
        attachments=None,
        ui_locale=None,
        client_request_id=None,
    ):
        if self.next_send_exception:
            exc = self.next_send_exception
            self.next_send_exception = None
            raise exc
        return {"status": "accepted", "id": item_id}


class WindowsHttpBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.web_dir = self.data_dir / "web"
        self.web_dir.mkdir()

    def tearDown(self):
        self.temp_dir.cleanup()

    def _start_server(self, bridge):
        config = {
            "auth": {"mode": "none"},
            "origins": ["http://127.0.0.1:0"],
            "port": 0,
            "localAccess": True,
        }
        server = GatewayServer(
            ("127.0.0.1", 0),
            bridge,
            config,
            self.web_dir,
            data_dir=str(self.data_dir),
            api_only=True,
        )
        port = server.server_address[1]
        server.origins.add(f"http://127.0.0.1:{port}")
        server.hosts.add(f"127.0.0.1:{port}")
        token, session = server.auth.login("", "", "127.0.0.1")
        server.timeout = 0.1
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def request(method, path, body=None):
            url = f"http://127.0.0.1:{port}{path}"
            data = json.dumps(body).encode("utf-8") if body is not None else None
            req = urllib.request.Request(
                url,
                data=data,
                method=method,
                headers={
                    "Content-Type": "application/json",
                    "Origin": f"http://127.0.0.1:{port}",
                    "Cookie": f"{server.auth.cookie_name}={token}",
                    "X-CSRF-Token": session["csrf"],
                },
            )
            try:
                with urllib.request.urlopen(req) as resp:
                    return resp.status, json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                return exc.code, json.loads(exc.read().decode("utf-8"))

        return server, request

    def test_native_runtime_status_calls_bridge_method(self):
        bridge = FakeNativeBridge()
        server, req = self._start_server(bridge)
        try:
            status, body = req("GET", "/api/runtime")
            self.assertEqual(status, 200)
            self.assertEqual(body["mode"], "windows_desktop")
            self.assertEqual(body["platform"], "win32")
            self.assertTrue(body["connected"])
            self.assertEqual(body["owner"], "codex-desktop-main")
        finally:
            server.shutdown()
            server.server_close()

    def test_linux_runtime_status_preserves_original_behavior(self):
        bridge = FakeLinuxBridge(self.data_dir)
        server, req = self._start_server(bridge)
        try:
            status, body = req("GET", "/api/runtime")
            self.assertEqual(status, 200)
            self.assertEqual(body["mode"], "standalone")
            self.assertEqual(body["workspace"], str(self.data_dir))
            self.assertTrue(body["connected"])
        finally:
            server.shutdown()
            server.server_close()

    def test_accounts_denial_message_distinguishes_native_desktop_from_wsl(self):
        native_bridge = FakeNativeBridge()
        server_nat, req_nat = self._start_server(native_bridge)
        try:
            status, body = req_nat("GET", "/api/accounts")
            self.assertEqual(status, 400)
            self.assertIn("Windows 原生桌面会话", body.get("error", ""))
            self.assertIn("桌面应用管理", body.get("error", ""))
            self.assertNotIn("WSL", body.get("error", ""))
        finally:
            server_nat.shutdown()
            server_nat.server_close()

        linux_bridge = FakeLinuxBridge(self.data_dir)
        server_lin, req_lin = self._start_server(linux_bridge)
        try:
            status, body = req_lin("GET", "/api/accounts")
            self.assertEqual(status, 400)
            self.assertIn("WSL", body.get("error", ""))
        finally:
            server_lin.shutdown()
            server_lin.server_close()

    def test_native_send_passes_client_request_id(self):
        bridge = FakeNativeBridge()
        server, req = self._start_server(bridge)
        try:
            status, body = req(
                "POST",
                f"/api/sessions/{THREAD_ID}/send",
                {
                    "text": "hello",
                    "id": "sub-1",
                    "clientRequestId": "req-client-123",
                    "mode": "send",
                },
            )
            self.assertEqual(status, 200)
            self.assertEqual(body["status"], "accepted")
            self.assertEqual(
                bridge.last_send_kwargs["client_request_id"], "req-client-123"
            )
        finally:
            server.shutdown()
            server.server_close()

    def test_native_rejected_value_error_returns_specific_json_identity(self):
        bridge = FakeNativeBridge()
        bridge.next_send_exception = NativeRejected("用户在桌面取消或拒绝操作")
        server, req = self._start_server(bridge)
        try:
            status, body = req(
                "POST",
                f"/api/sessions/{THREAD_ID}/send",
                {"text": "hello", "id": "sub-rejected", "mode": "send"},
            )
            self.assertEqual(status, 400)
            self.assertEqual(body.get("code"), "submission_rejected")
            self.assertIs(body.get("dispatched"), False)
            self.assertIs(body.get("retryable"), False)
            self.assertIn("用户在桌面取消或拒绝操作", body.get("error", ""))
        finally:
            server.shutdown()
            server.server_close()

    def test_native_unknown_ipc_error_returns_specific_json_identity(self):
        bridge = FakeNativeBridge()
        bridge.next_send_exception = NativeUnknown("桌面IPC断开连接")
        server, req = self._start_server(bridge)
        try:
            status, body = req(
                "POST",
                f"/api/sessions/{THREAD_ID}/send",
                {"text": "hello", "id": "sub-unknown", "mode": "send"},
            )
            self.assertEqual(status, 409)
            self.assertEqual(body.get("code"), "submission_unknown")
            self.assertIsNone(body.get("dispatched"))
            self.assertIs(body.get("retryable"), False)
            self.assertIn("桌面IPC断开连接", body.get("error", ""))
        finally:
            server.shutdown()
            server.server_close()

    def test_generic_value_error_and_ipc_error_preserve_linux_behavior(self):
        bridge = FakeLinuxBridge(self.data_dir)
        server, req = self._start_server(bridge)
        try:
            # 普通 ValueError
            bridge.next_send_exception = ValueError("输入格式错误")
            status, body = req(
                "POST",
                f"/api/sessions/{THREAD_ID}/send",
                {"text": "bad", "id": "sub-ve", "mode": "send"},
            )
            self.assertEqual(status, 400)
            self.assertEqual(body.get("error"), "输入格式错误")
            self.assertNotIn("code", body)
            self.assertNotIn("dispatched", body)

            # 普通 IPCError
            bridge.next_send_exception = IPCError("底座通信失败")
            status, body = req(
                "POST",
                f"/api/sessions/{THREAD_ID}/send",
                {"text": "bad", "id": "sub-ipc", "mode": "send"},
            )
            self.assertEqual(status, 409)
            self.assertEqual(body.get("code"), "desktop_unavailable")
            self.assertEqual(body.get("error"), "底座通信失败")
            self.assertNotIn("dispatched", body)
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
