"""Controller-owned checks: exercise the existing owner snapshot and dispatch DTO."""

import json
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.app.service import LiveSession
from bridge.clients.codex.ipc import IPCError
from bridge.clients.codex.windows_desktop import (
    DesktopCatalog,
    NativeRejected,
    NativeUnknown,
    WindowsDesktopBridge,
)


class NativeOwnerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.bridge = WindowsDesktopBridge(
            self.home,
            self.root / "data",
            [{"key": "native", "name": "Native", "path": str(self.root)}],
        )
        self.thread = str(uuid.uuid4())
        self.bridge.store = Mock()
        self.bridge.store.home = self.home
        self.bridge.store.get.return_value = {"id": self.thread, "cwd": str(self.root)}
        self.bridge.store.confirmed_user_receipt.return_value = False
        self.session = LiveSession(self.thread)
        self.bridge.live[self.thread] = self.session
        self.bridge.ipc = Mock()
        self.bridge.ipc.request.return_value = {
            "result": {
                "method": "thread-follower-start-turn",
                "result": {"turn": {"id": "native-turn"}},
            }
        }
        self.snapshot("idle")

    def tearDown(self):
        self.bridge.close()
        self.tmp.cleanup()

    def snapshot(self, status):
        self.session.discovering = True
        self.bridge._event(
            {
                "method": "thread-stream-state-changed",
                "version": 11,
                "sourceClientId": "desktop-owner",
                "params": {
                    "hostId": "local",
                    "conversationId": self.thread,
                    "change": {
                        "type": "snapshot",
                        "revision": 8,
                        "conversationState": {
                            "id": self.thread,
                            "cwd": str(self.root),
                            "turns": [],
                            "threadRuntimeStatus": {"type": status},
                            "latestModel": "actual-model",
                        },
                    },
                },
            }
        )

    def test_idle_uses_real_owner_and_existing_array_dto(self):
        identity = str(uuid.uuid4())
        result = self.bridge.send(
            self.thread,
            "fixture only",
            identity,
            mode="auto",
            client_request_id="web-request",
        )
        self.assertEqual(result["status"], "accepted")
        args, opts = self.bridge.ipc.request.call_args
        self.assertEqual(args[0], "thread-follower-start-turn")
        request = args[1]["turnStart"]["request"]
        self.assertEqual(request["threadId"], self.thread)
        self.assertEqual(
            request["input"],
            [{"type": "text", "text": "fixture only", "text_elements": []}],
        )
        self.assertEqual(request["clientUserMessageId"], identity)
        self.assertTrue(args[1]["turnStart"]["context"]["inheritThreadSettings"])
        self.assertNotIn("model", request)
        self.assertEqual(opts["target"], "desktop-owner")
        self.assertEqual(
            self.bridge.submissions[self.thread + ":" + identity]["clientRequestId"],
            "web-request",
        )
        self.bridge.send(
            self.thread,
            "fixture only",
            identity,
            mode="auto",
            client_request_id="web-request",
        )
        self.assertEqual(self.bridge.ipc.request.call_count, 1)

    def test_busy_unknown_missing_owner_and_disconnect_never_dispatch(self):
        for status in ["active", "unknown"]:
            self.snapshot(status)
            with self.assertRaises(NativeRejected):
                self.bridge.send(self.thread, "fixture", str(uuid.uuid4()))
        self.snapshot("idle")
        self.session.owner = None
        with self.assertRaises(NativeRejected):
            self.bridge.send(self.thread, "fixture", str(uuid.uuid4()))
        self.snapshot("idle")
        self.bridge._disconnected()
        with self.assertRaises(NativeRejected):
            self.bridge.send(self.thread, "fixture", str(uuid.uuid4()))
        self.bridge.ipc.request.assert_not_called()

    def test_patch_revision_and_owner_checks_are_reused(self):
        self.bridge._event(
            {
                "method": "thread-stream-state-changed",
                "version": 11,
                "sourceClientId": "desktop-owner",
                "params": {
                    "hostId": "local",
                    "conversationId": self.thread,
                    "change": {
                        "type": "patches",
                        "baseRevision": 8,
                        "revision": 9,
                        "patches": [
                            {
                                "op": "replace",
                                "path": ["threadRuntimeStatus", "type"],
                                "value": "active",
                            }
                        ],
                    },
                },
            }
        )
        self.assertEqual(self.session.state["threadRuntimeStatus"]["type"], "active")
        self.assertEqual(self.session.revision, 9)
        with self.assertRaises(NativeRejected):
            self.bridge.send(self.thread, "fixture", str(uuid.uuid4()))
        self.bridge.ipc.request.assert_not_called()

    def test_uncertain_ipc_failure_is_durable_never_replayed(self):
        identity = str(uuid.uuid4())
        self.bridge.ipc.request.side_effect = IPCError("Disconnected after send")
        for _ in range(2):
            with self.assertRaises(NativeUnknown):
                self.bridge.send(self.thread, "fixture", identity)
        self.assertEqual(self.bridge.ipc.request.call_count, 1)
        saved = json.loads(self.bridge.ledger_path.read_text())
        self.assertEqual(saved[self.thread + ":" + identity]["status"], "unknown")
        self.assertIsNone(NativeUnknown.dispatched)

    def test_malformed_success_does_not_fake_acceptance(self):
        self.bridge.ipc.request.return_value = {"result": {"ok": True}}
        with self.assertRaises(NativeUnknown):
            self.bridge.send(self.thread, "fixture", str(uuid.uuid4()))

    def test_exact_persisted_receipt_reconciles_unknown_metadata_without_redispatch(self):
        confirmed_id, same_text_id, missing_id = [str(uuid.uuid4()) for _ in range(3)]
        for submission_id in (confirmed_id, same_text_id, missing_id):
            self.bridge.submissions[self.thread + ":" + submission_id] = {
                "text": "same text",
                "status": "unknown",
                "error": "waiting for confirmation",
            }
        self.bridge.store.confirmed_user_receipt.side_effect = (
            lambda thread_id, client_id: client_id == confirmed_id
        )

        view = self.bridge.view(self.thread, metadata=True)

        self.assertEqual(
            {row["id"]: row["status"] for row in view["submissions"]},
            {same_text_id: "unknown", missing_id: "unknown"},
        )
        self.assertEqual(
            self.bridge.submissions[self.thread + ":" + confirmed_id]["status"],
            "accepted",
        )
        self.assertNotIn(
            "error", self.bridge.submissions[self.thread + ":" + confirmed_id]
        )
        receipt = self.bridge.submission_receipt(self.thread, confirmed_id)
        self.assertEqual(receipt["status"], "accepted")
        self.assertTrue(receipt["deliveryConfirmed"])
        self.bridge.ipc.request.assert_not_called()

    def test_exact_receipt_does_not_promote_failed_or_cancelled_submissions(self):
        submission_ids = [str(uuid.uuid4()) for _ in range(2)]
        for submission_id, status in zip(submission_ids, ("failed", "cancelled")):
            self.bridge.submissions[self.thread + ":" + submission_id] = {
                "text": "fixture",
                "status": status,
            }
        self.bridge.store.confirmed_user_receipt.return_value = True

        for submission_id, status in zip(submission_ids, ("failed", "cancelled")):
            receipt = self.bridge.submission_receipt(self.thread, submission_id)
            self.assertEqual(receipt["status"], status)
            self.assertTrue(receipt["deliveryConfirmed"])
            self.assertEqual(
                self.bridge.submissions[self.thread + ":" + submission_id]["status"],
                status,
            )
        self.bridge.ipc.request.assert_not_called()

    def test_queue_steer_goal_and_secondary_runtimes_refused(self):
        for mode in ["queue", "steer"]:
            with self.assertRaises(NativeRejected):
                self.bridge.send(self.thread, "fixture", str(uuid.uuid4()), mode=mode)
        for method in [
            "create_chat",
            "message_action",
            "rename",
            "side_chat",
            "create_worktree",
            "set_goal_status",
            "queue_actions",
            "terminal",
        ]:
            with self.assertRaises(NativeRejected):
                getattr(self.bridge, method)(self.thread)
        self.bridge.ipc.request.assert_not_called()

    def enable_creation(self):
        executable = self.root / "metadata-codex.exe"
        executable.write_bytes(b"test fixture only")
        self.bridge.creation_executable = str(executable)
        self.bridge._refresh_async = Mock()
        return str(executable)

    def test_explicit_creation_reuses_metadata_helper_and_waits_for_desktop_owner(self):
        executable = self.enable_creation()
        identity = str(uuid.uuid4())
        with patch("bridge.clients.codex.windows_desktop.create_empty", return_value=self.thread) as create, \
             patch("bridge.clients.codex.windows_desktop.open_in_desktop") as opened:
            first = self.bridge.create_chat("native", "New chat", identity, cwd=str(self.root))
            second = self.bridge.create_chat("native", "New chat", identity, cwd=str(self.root))
        create.assert_called_once_with(executable, self.home, str(self.root), "New chat")
        self.assertEqual(first["id"], second["id"])
        self.assertTrue(first["desktopOwnerConfirmed"])
        self.assertEqual(opened.call_count, 2)
        self.bridge.ipc.request.assert_not_called()  # No turn, settings or model message.

    def test_creation_unknown_is_durable_and_cannot_repeat_the_helper(self):
        self.enable_creation()
        identity = str(uuid.uuid4())
        with patch("bridge.clients.codex.windows_desktop.create_empty", side_effect=RuntimeError("Lost acknowledgement")) as create:
            for _ in range(2):
                with self.assertRaises(NativeUnknown):
                    self.bridge.create_chat("native", "New chat", identity)
        self.assertEqual(create.call_count, 1)
        self.assertNotIn("id", json.loads(self.bridge.creations_path.read_text())[identity])

    def test_created_thread_waiting_for_owner_is_reused_on_manual_retry(self):
        self.enable_creation()
        self.session.connected = False
        identity = str(uuid.uuid4())
        with patch("bridge.clients.codex.windows_desktop.create_empty", return_value=self.thread) as create, \
             patch("bridge.clients.codex.windows_desktop.open_in_desktop"), \
             patch.object(self.session.condition, "wait_for", side_effect=[False, True]):
            with self.assertRaisesRegex(NativeUnknown, "等待桌面接管"):
                self.bridge.create_chat("native", "New chat", identity)
            self.snapshot("idle")
            self.bridge.create_chat("native", "New chat", identity)
        self.assertEqual(create.call_count, 1)
        self.bridge.ipc.request.assert_not_called()

    def test_creation_rejects_wrong_project_escape_and_changed_identity(self):
        self.enable_creation()
        with patch("bridge.clients.codex.windows_desktop.create_empty", return_value=self.thread) as create, \
             patch("bridge.clients.codex.windows_desktop.open_in_desktop"):
            with self.assertRaises(NativeRejected):
                self.bridge.create_chat("missing", "New chat", str(uuid.uuid4()))
            with self.assertRaises(PermissionError):
                self.bridge.create_chat("native", "New chat", str(uuid.uuid4()), cwd=str(self.root.parent))
            identity = str(uuid.uuid4())
            self.bridge.create_chat("native", "New chat", identity)
            with self.assertRaises(NativeRejected):
                self.bridge.create_chat("native", "Other chat", identity)
        self.assertEqual(create.call_count, 1)

    def test_canonical_directory_response_includes_project_root_and_key(self):
        result = self.bridge.validate_cwd(str(self.root))
        self.assertEqual(result["projectRoot"], str(self.root))
        self.assertEqual(result["projectKey"], "native")

    def test_same_identity_different_content_refused_distinct_requests_preserved(self):
        first = str(uuid.uuid4())
        self.bridge.send(self.thread, "same text", first)
        with self.assertRaises(NativeRejected):
            self.bridge.send(self.thread, "different text", first)
        self.bridge.send(self.thread, "same text", str(uuid.uuid4()))
        self.assertEqual(self.bridge.ipc.request.call_count, 2)

    def test_catalog_maps_native_recency_and_authoritative_name_without_now_fallback(self):
        self.bridge.store.list.return_value = [{"id": self.thread, "cwd": str(self.root),
            "name": "native-current-name", "title": "legacy-name", "updated_at": 1000, "recency_at_ms": 1200000}]
        row = self.bridge.list()[0]
        self.assertEqual(row["title"], "native-current-name")
        self.assertEqual(row["recency"], 1200000)
        self.assertEqual(row["updatedAt"], 1000)

    def test_metadata_probe_and_optional_index_have_honest_contracts(self):
        view = self.bridge.view(self.thread, metadata=True)
        self.assertEqual(view["model"], "actual-model")
        self.assertEqual(view["nativeDesktopLimits"]["queue"], False)
        self.assertFalse(self.bridge.navigation_index(self.thread)["available"])

    def test_real_model_metadata_not_invented_defaults(self):
        with self.assertRaises(NativeRejected):
            DesktopCatalog(self.home).get_kind("models", str(self.root))
        (self.home / "models_cache.json").write_text(
            json.dumps(
                {
                    "models": [
                        {
                            "slug": "real-cache-id",
                            "display_name": "Actual fixture",
                            "supported_reasoning_levels": [{"effort": "medium"}],
                            "default_reasoning_level": "medium",
                        }
                    ]
                }
            )
        )
        (self.home / "config.toml").write_text('model="real-cache-id"\n')
        catalog = DesktopCatalog(self.home).get_kind("models", str(self.root))
        self.assertEqual(catalog["models"][0]["id"], "real-cache-id")
        self.assertEqual(catalog["models"][0]["efforts"], ["medium"])
        self.assertTrue(catalog["models"][0]["isDefault"])

    def test_outside_scope_refused_before_native_calls(self):
        other = self.root.parent
        self.bridge.store.get.return_value = {"cwd": str(other)}
        with self.assertRaises(PermissionError):
            self.bridge.view(self.thread)
        self.bridge.ipc.request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
