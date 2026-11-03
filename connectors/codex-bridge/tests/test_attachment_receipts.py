import hashlib
import json
import sys
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_windows_desktop as fixtures
import test_windows_http_boundary as httpfixtures
from bridge.clients.codex.attachment_readability import AttachmentReadError, check_attachments, same_creation_time
from bridge.clients.codex.windows_desktop import NativeUnknown
from bridge.clients.codex.submission_trace import new_trace, observe


class ReceiverReadabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "fixture.png"
        self.path.write_bytes(b"\x89PNG\r\n\x1a\nfixture")
        self.row = {"id": "attachment", "name": self.path.name, "path": str(self.path),
                    "size": self.path.stat().st_size, "sha256": hashlib.sha256(self.path.read_bytes()).hexdigest()}
        self.entries = []

    def tearDown(self):
        self.tmp.cleanup()

    @contextmanager
    def identity(self, receiver):
        self.entries.append(("enter", receiver["pid"]))
        try:
            yield
        finally:
            self.entries.append(("exit", receiver["pid"]))

    def run_check(self):
        with patch("bridge.clients.codex.attachment_readability.receiver_processes", return_value=[{"pid": 12}, {"pid": 13}]), \
             patch("bridge.clients.codex.attachment_readability.receiver_identity", self.identity):
            return check_attachments(None, [self.row])

    def test_reads_exact_content_for_every_receiver_not_just_uploader(self):
        proof = self.run_check()
        self.assertEqual(proof["receiverCount"], 2)
        self.assertEqual(proof["evidence"], "receiver_token_read_sha256")
        self.assertEqual(proof["modelContentRead"], "unobserved")
        self.assertEqual(self.entries, [("enter", 12), ("exit", 12), ("enter", 13), ("exit", 13)])

    def test_content_changed_is_rejected_and_identity_restored(self):
        self.path.write_bytes(b"different")
        with self.assertRaises(AttachmentReadError) as error:
            self.run_check()
        self.assertEqual(error.exception.code, "receiver_attachment_changed")
        self.assertEqual(self.entries, [("enter", 12), ("exit", 12)])

    def test_access_denied_identifies_attachment_and_restores_identity(self):
        with patch("pathlib.Path.open", side_effect=PermissionError("denied")):
            with self.assertRaises(AttachmentReadError) as error:
                self.run_check()
        self.assertEqual(error.exception.code, "receiver_attachment_access_denied")
        self.assertEqual(error.exception.evidence["attachmentId"], "attachment")
        self.assertFalse(error.exception.dispatched)
        self.assertEqual(self.entries, [("enter", 12), ("exit", 12)])

    def test_no_attachments_does_not_require_receiver(self):
        with patch("bridge.clients.codex.attachment_readability.receiver_processes") as probe:
            self.assertEqual(check_attachments(None, [])["status"], "not_applicable")
            probe.assert_not_called()

    def test_wmi_microsecond_precision_does_not_look_like_pid_reuse(self):
        self.assertTrue(same_creation_time(134373662580749553, 134373662580749550))
        self.assertFalse(same_creation_time(134373662580749560, 134373662580749550))

    def test_invalid_metadata_never_starts_receiver_probe(self):
        for update in [{"size": 21 * 1024 * 1024}, {"size": True}, {"sha256": "invalid"}]:
            with self.subTest(update=update), patch("bridge.clients.codex.attachment_readability.receiver_processes") as probe:
                with self.assertRaises(AttachmentReadError) as error:
                    check_attachments(None, [{**self.row, **update}])
                self.assertEqual(error.exception.code, "receiver_attachment_metadata_invalid")
                probe.assert_not_called()


class AttachmentReceiptTests(unittest.TestCase):
    snapshot = fixtures.NativeOwnerTest.snapshot
    setUp = fixtures.NativeOwnerTest.setUp
    tearDown = fixtures.NativeOwnerTest.tearDown

    def attach(self):
        identity = str(uuid.uuid4())
        self.bridge.uploads.put(self.thread, identity, "fixture.png", b"\x89PNG\r\n\x1a\nfixture")
        return identity

    def event(self, turns, *, owner="desktop-owner", revision=9):
        self.bridge._event({"method": "thread-stream-state-changed", "version": 11,
                           "sourceClientId": owner, "params": {"hostId": "local", "conversationId": self.thread,
                           "change": {"type": "snapshot", "revision": revision,
                           "conversationState": {"id": self.thread, "turns": turns,
                                                 "threadRuntimeStatus": {"type": "idle"}}}}})

    def test_receiver_denial_is_durable_and_never_dispatches_or_replays(self):
        submission, attachment = str(uuid.uuid4()), self.attach()
        failure = AttachmentReadError("receiver_attachment_access_denied", "接收方不能读取；未发送。", attachment={"id": attachment, "name": "fixture.png"}, winerror=5)
        with patch("bridge.clients.codex.windows_desktop.check_attachments", side_effect=failure) as probe:
            with self.assertRaises(AttachmentReadError):
                self.bridge.send(self.thread, "fixture", submission, attachments=[attachment])
            duplicate = self.bridge.send(self.thread, "fixture", submission, attachments=[attachment])
        self.assertEqual(probe.call_count, 1)
        self.bridge.ipc.request.assert_not_called()
        self.assertEqual(duplicate["status"], "failed")
        receipt = self.bridge.submission_receipt(self.thread, submission)
        self.assertEqual(receipt["errorCode"], "receiver_attachment_access_denied")
        stage = receipt["trace"]["stages"]["attachment_read"]
        self.assertEqual((stage["status"], stage["winerror"]), ("failed", 5))
        saved = json.loads(self.bridge.ledger_path.read_text())
        self.assertEqual(saved[self.thread + ":" + submission]["trace"], receipt["trace"])

    def test_readability_does_not_falsely_claim_model_read_or_result_verified(self):
        submission, attachment = str(uuid.uuid4()), self.attach()
        proof = {"status": "confirmed", "evidence": "receiver_token_read_sha256", "receiverPids": [12]}
        with patch("bridge.clients.codex.windows_desktop.check_attachments", return_value=proof):
            result = self.bridge.send(self.thread, "fixture", submission, attachments=[attachment])
        trace = result["trace"]
        self.assertEqual(trace["stages"]["task_received"]["status"], "confirmed")
        self.assertEqual(trace["receiverReadability"]["status"], "confirmed")
        self.assertEqual(trace["stages"]["attachment_read"]["status"], "pending")
        self.assertEqual(trace["stages"]["result_verified"]["status"], "pending")

    def test_exact_native_turn_records_operation_but_not_assistant_claim(self):
        submission = str(uuid.uuid4())
        self.bridge.send(self.thread, "fixture", submission)
        self.event([{"turnId": "native-turn", "status": "completed", "items": [
            {"type": "commandExecution", "id": "check", "status": "completed", "exitCode": 0},
            {"type": "agentMessage", "id": "answer", "phase": "final_answer", "text": "Everything verified"}]}])
        stages = self.bridge.submission_receipt(self.thread, submission)["trace"]["stages"]
        self.assertEqual(stages["operation_executed"]["status"], "confirmed")
        self.assertEqual(stages["result_verified"]["reason"], "independent_verification_required")
        self.assertEqual(stages["attachment_read"]["status"], "not_applicable")

    def test_other_turn_and_untrusted_owner_cannot_supply_execution_evidence(self):
        submission = str(uuid.uuid4())
        self.bridge.send(self.thread, "fixture", submission)
        item = {"type": "commandExecution", "id": "other", "status": "completed", "exitCode": 0}
        self.event([{"turnId": "unrelated", "status": "completed", "items": [item]}])
        self.event([{"turnId": "native-turn", "status": "completed", "items": [item]}], owner="wrong-owner")
        self.assertEqual(self.bridge.submission_receipt(self.thread, submission)["trace"]["stages"]["operation_executed"]["status"], "pending")

    def test_failed_operation_retains_exit_code_and_sparse_snapshot_cannot_erase_it(self):
        submission = str(uuid.uuid4())
        self.bridge.send(self.thread, "fixture", submission)
        self.event([{"turnId": "native-turn", "status": "completed", "items": [
            {"type": "commandExecution", "id": "failed", "status": "completed", "exitCode": 7}]}])
        self.event([{"turnId": "native-turn", "status": "completed", "items": [
            {"type": "commandExecution", "id": "another", "status": "completed", "exitCode": 0}]}], revision=10)
        stage = self.bridge.submission_receipt(self.thread, submission)["trace"]["stages"]["operation_executed"]
        self.assertEqual(stage["status"], "failed")
        self.assertEqual(stage["operations"][0]["exitCode"], 7)

    def test_malformed_native_ack_does_not_confirm_task_receipt(self):
        submission = str(uuid.uuid4())
        self.bridge.ipc.request.return_value = {"result": {"ok": True}}
        with self.assertRaises(NativeUnknown):
            self.bridge.send(self.thread, "fixture", submission)
        receipt = self.bridge.submission_receipt(self.thread, submission)
        self.assertNotEqual(receipt["trace"]["stages"]["task_received"]["status"], "confirmed")

    def test_late_exact_receipt_confirms_first_stage_without_resending(self):
        submission = str(uuid.uuid4())
        self.bridge.ipc.request.return_value = {"result": {"ok": True}}
        with self.assertRaises(NativeUnknown):
            self.bridge.send(self.thread, "fixture", submission)
        self.bridge.store.confirmed_user_receipt.return_value = True
        receipt = self.bridge.submission_receipt(self.thread, submission)
        self.assertEqual(receipt["status"], "accepted")
        stage = receipt["trace"]["stages"]["task_received"]
        self.assertEqual(
            (stage["status"], stage["evidence"]),
            ("confirmed", "native_persisted_user_receipt"),
        )
        self.bridge.ipc.request.assert_called_once()

    def test_only_matching_native_image_error_fails_attachment_stage(self):
        entry = {"trace": new_trace(), "nativeTurnId": "t", "attachmentPaths": ["C:/uploads/exact.png"]}
        state = {"turns": [{"turnId": "t", "status": "failed", "items": [],
                             "error": {"message": "Could not read local image C:/uploads/other.png: access denied"}}]}
        observe(entry, state)
        self.assertEqual(entry["trace"]["stages"]["attachment_read"]["status"], "pending")
        state["turns"][0]["error"]["message"] = "Could not read local image C:/uploads/exact.png: access denied"
        observe(entry, state)
        self.assertEqual(entry["trace"]["stages"]["attachment_read"]["code"], "native_attachment_read_failed")


class AttachmentHttpErrorTests(unittest.TestCase):
    setUp = httpfixtures.WindowsHttpBoundaryTests.setUp
    tearDown = httpfixtures.WindowsHttpBoundaryTests.tearDown
    _start_server = httpfixtures.WindowsHttpBoundaryTests._start_server

    def test_preflight_failure_keeps_machine_code_and_known_non_dispatch(self):
        bridge = httpfixtures.FakeNativeBridge()
        bridge.next_send_exception = AttachmentReadError("receiver_attachment_access_denied", "接收方读取附件失败；未发送。", winerror=5)
        server, request = self._start_server(bridge)
        try:
            status, body = request("POST", f"/api/sessions/{httpfixtures.THREAD_ID}/send", {"text": "fixture", "id": "fixture", "mode": "send"})
            self.assertEqual(status, 400)
            self.assertEqual(body["code"], "receiver_attachment_access_denied")
            self.assertIs(body["dispatched"], False)
            self.assertIs(body["retryable"], False)
            self.assertIn("接收方读取附件失败", body["error"])
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
