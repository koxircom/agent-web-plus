#!/usr/bin/env python3
"""Integration tests for odoo-addon-lock.py CLI tool.

Validates fail-closed cooperative locking semantics in dry-run isolated state:
1. Atomic lock acquisition and JSON metadata output (token, generation, instance)
2. Status querying for locked and unlocked resources
3. Lock exclusivity: second session acquire fails/queues
4. Fail-closed release rejections:
   - Non-owner session rejection
   - Token mismatch rejection
   - Generation mismatch rejection
   - Missing token/generation rejection for non-legacy locks
   - Cross-instance release rejection
5. Authorized release with exact session + instance + token + generation
6. Resource name validation and rejection of path traversal attempts
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CLI_PATH = Path(__file__).resolve().parent / "odoo-addon-lock.py"


class TestOdooAddonLockCLI(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="odoo-lock-test-")
        self.state_root = Path(self.temp_dir.name) / "locks"
        self.state_root.mkdir(parents=True, exist_ok=True)
        self.env = os.environ.copy()
        # Ensure LAN config does not interfere with local state-root tests
        self.env.pop("ODOO_LAN_CONFIG_FILE", None)
        self.env.pop("ODOO_ADDON_LOCKS_DIR", None)
        self.env["PI_CODING_AGENT_DIR"] = str(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_cli(self, args, session_id=None, instance_id=None, expect_code=None):
        cmd = [sys.executable, str(CLI_PATH), "--state-root", str(self.state_root)]
        if session_id:
            cmd.extend(["--session", session_id])
        if instance_id:
            cmd.extend(["--instance-id", instance_id])
        cmd.extend(args)

        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            env=self.env,
            timeout=10,
        )
        if expect_code is not None:
            self.assertEqual(
                proc.returncode,
                expect_code,
                f"Command {cmd} returned {proc.returncode}, expected {expect_code}.\nStderr: {proc.stderr}\nStdout: {proc.stdout}",
            )
        return proc

    def test_01_acquire_and_status_success(self):
        # 1. Acquire lock
        res = self.run_cli(
            [
                "acquire", "addon_alpha",
                "--title", "Task Alpha",
                "--json",
            ],
            session_id="session_alpha_1",
            instance_id="synology:30141",
            expect_code=0,
        )
        data = json.loads(res.stdout)
        self.assertTrue(data.get("success"), f"Expected success: {data}")
        self.assertIn("acquired successfully", data.get("message", "").lower())
        meta = data.get("metadata") or {}
        self.assertEqual(meta.get("session_id"), "session_alpha_1")
        self.assertEqual(meta.get("instance_id"), "synology:30141")
        self.assertTrue(meta.get("token"), "Metadata must contain lock token")
        self.assertEqual(meta.get("generation"), 1)

        # 2. Status check reflects held lock
        status_res = self.run_cli(["status", "addon_alpha", "--json"], expect_code=0)
        status_data = json.loads(status_res.stdout)
        self.assertTrue(status_data.get("locked"))
        status_meta = status_data.get("metadata") or {}
        self.assertEqual(status_meta.get("session_id"), "session_alpha_1")
        self.assertEqual(status_meta.get("instance_id"), "synology:30141")
        self.assertEqual(status_meta.get("token"), meta.get("token"))
        self.assertEqual(status_meta.get("generation"), 1)

    def test_02_lock_exclusivity(self):
        # First session acquires
        self.run_cli(
            ["acquire", "addon_beta", "--json"],
            session_id="session_holder",
            expect_code=0,
        )

        # Second session attempts acquire -> must be refused / non-zero
        conflict_res = self.run_cli(
            ["acquire", "addon_beta", "--json"],
            session_id="session_intruder",
        )
        self.assertNotEqual(
            conflict_res.returncode,
            0,
            "Second session acquire must fail closed when lock is already held",
        )
        data = json.loads(conflict_res.stdout)
        self.assertFalse(data.get("success"))

    def test_03_release_fail_closed_checks(self):
        # Setup: Acquire lock
        acq_res = self.run_cli(
            [
                "acquire", "addon_gamma",
                "--json",
            ],
            session_id="session_owner",
            instance_id="synology:30141",
            expect_code=0,
        )
        meta = json.loads(acq_res.stdout)["metadata"]
        valid_token = meta["token"]
        valid_gen = str(meta["generation"])

        # 1. Non-owner session rejection
        res_non_owner = self.run_cli(
            [
                "release", "addon_gamma",
                "--token", valid_token,
                "--generation", valid_gen,
                "--json",
            ],
            session_id="session_wrong_owner",
            instance_id="synology:30141",
            expect_code=1,
        )
        data_non_owner = json.loads(res_non_owner.stdout)
        self.assertFalse(data_non_owner.get("success"))
        self.assertIn("session_owner", data_non_owner.get("message", ""))

        # 2. Token mismatch rejection
        res_bad_token = self.run_cli(
            [
                "release", "addon_gamma",
                "--token", "invalid-token-123456",
                "--generation", valid_gen,
                "--json",
            ],
            session_id="session_owner",
            instance_id="synology:30141",
            expect_code=1,
        )
        data_bad_token = json.loads(res_bad_token.stdout)
        self.assertFalse(data_bad_token.get("success"))
        self.assertIn("token mismatch", data_bad_token.get("message", "").lower())

        # 3. Generation mismatch rejection
        res_bad_gen = self.run_cli(
            [
                "release", "addon_gamma",
                "--token", valid_token,
                "--generation", "999",
                "--json",
            ],
            session_id="session_owner",
            instance_id="synology:30141",
            expect_code=1,
        )
        data_bad_gen = json.loads(res_bad_gen.stdout)
        self.assertFalse(data_bad_gen.get("success"))
        self.assertIn("generation mismatch", data_bad_gen.get("message", "").lower())

        # 4. Missing token or generation rejection
        res_missing_token = self.run_cli(
            [
                "release", "addon_gamma",
                "--generation", valid_gen,
                "--json",
            ],
            session_id="session_owner",
            instance_id="synology:30141",
            expect_code=1,
        )
        data_missing_token = json.loads(res_missing_token.stdout)
        self.assertFalse(data_missing_token.get("success"))
        self.assertIn("token is required", data_missing_token.get("message", "").lower())

        res_missing_gen = self.run_cli(
            [
                "release", "addon_gamma",
                "--token", valid_token,
                "--json",
            ],
            session_id="session_owner",
            instance_id="synology:30141",
            expect_code=1,
        )
        data_missing_gen = json.loads(res_missing_gen.stdout)
        self.assertFalse(data_missing_gen.get("success"))
        self.assertIn("generation is required", data_missing_gen.get("message", "").lower())

        # 5. Cross-instance release rejection
        res_foreign_instance = self.run_cli(
            [
                "release", "addon_gamma",
                "--token", valid_token,
                "--generation", valid_gen,
                "--json",
            ],
            session_id="session_owner",
            instance_id="synology:30142",
            expect_code=1,
        )
        data_foreign = json.loads(res_foreign_instance.stdout)
        self.assertFalse(data_foreign.get("success"))
        self.assertIn("synology:30141", data_foreign.get("message", ""))

    def test_04_authorized_release_success(self):
        # Acquire
        acq_res = self.run_cli(
            [
                "acquire", "addon_delta",
                "--json",
            ],
            session_id="session_valid",
            instance_id="synology:30141",
            expect_code=0,
        )
        meta = json.loads(acq_res.stdout)["metadata"]

        # Valid release
        rel_res = self.run_cli(
            [
                "release", "addon_delta",
                "--token", meta["token"],
                "--generation", str(meta["generation"]),
                "--json",
            ],
            session_id="session_valid",
            instance_id="synology:30141",
            expect_code=0,
        )
        rel_data = json.loads(rel_res.stdout)
        self.assertTrue(rel_data.get("success"))

        # Verify status is now unlocked
        status_res = self.run_cli(["status", "addon_delta", "--json"], expect_code=0)
        status_data = json.loads(status_res.stdout)
        self.assertFalse(status_data.get("locked"))

    def test_05_invalid_resource_names_rejected(self):
        invalid_resources = [
            "../escape",
            "foo/bar",
            "foo\\bar",
            "bad space",
            "-invalid_start",
            "_invalid_start",
        ]
        for bad_res in invalid_resources:
            proc = self.run_cli(
                ["acquire", bad_res, "--json"],
                session_id="session_test",
            )
            self.assertNotEqual(
                proc.returncode,
                0,
                f"Resource name '{bad_res}' must be rejected with non-zero exit code",
            )


if __name__ == "__main__":
    unittest.main()
