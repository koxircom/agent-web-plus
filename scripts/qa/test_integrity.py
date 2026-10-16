import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from integrity import inspect


class Integrity(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.root = Path(self.temp.name)
        (self.root / "sessions" / "project").mkdir(parents=True)
    def tearDown(self): self.temp.cleanup()
    def session(self, sid="s", eid="user"):
        path = self.root / "sessions" / "project" / (sid + ".jsonl")
        path.write_text(json.dumps({"type": "session", "id": sid}) + "\n" + json.dumps({"type": "message", "id": eid, "message": {"role": "user", "content": "private"}}) + "\n")
        return path
    def receipt(self, sid="s", eid="user"):
        folder = self.root / "state" / "prompt-deliveries-v1" / hashlib.sha256(sid.encode()).hexdigest()
        folder.mkdir(parents=True)
        (folder / "receipt.json").write_text(json.dumps({"requestId": "r", "receipt": {"status": "committed", "entryId": eid}}))
    def test_valid(self):
        self.session(); self.receipt(); result = inspect(self.root, verify_entries=True)
        self.assertEqual(result["status"], "passed"); self.assertEqual(result["verifiedEntries"], 1)
        self.assertNotIn("private", json.dumps(result))
    def test_missing_file_is_not_fixed_or_attributed(self):
        path = self.session(); self.receipt(); path.unlink()
        result = inspect(self.root, {"sessions": {"s": {"id": "s"}}})
        self.assertEqual(result["findings"][0]["code"], "committed_session_missing")
        self.assertFalse(path.exists())
    def test_explicit_completed_delete_is_distinct(self):
        self.receipt(); journal = self.root / "state" / "session-deletions-v1.jsonl"
        journal.write_text(json.dumps({"phase": "completed", "deletedIds": ["s"]}) + "\n")
        self.assertEqual(inspect(self.root, {"sessions": {"s": {"id": "s"}}})["status"], "passed")
    def test_planned_delete_does_not_prove_completion(self):
        self.receipt(); (self.root / "state" / "session-deletions-v1.jsonl").write_text(json.dumps({"phase": "planned", "resolvedIds": ["s"]}) + "\n")
        self.assertEqual(inspect(self.root, {"sessions": {"s": {"id": "s"}}})["findings"][0]["code"], "committed_session_missing")
    def test_missing_user_entry(self):
        self.session(eid="other"); self.receipt()
        self.assertEqual(inspect(self.root, verify_entries=True)["findings"][0]["code"], "committed_entry_missing")
    def test_catalog_membership_and_budget(self):
        self.session(); self.receipt()
        codes = {x["code"] for x in inspect(self.root, catalog={"sessions": []}, verify_entries=True, byte_budget=1)["findings"]}
        self.assertIn("catalog_omits_file", codes); self.assertIn("entry_not_verified_budget", codes)
    def test_duplicate_header(self):
        path = self.session(); (path.parent / "second.jsonl").write_bytes(path.read_bytes())
        self.assertEqual(inspect(self.root)["findings"][0]["code"], "duplicate_session_id")


if __name__ == "__main__": unittest.main()
