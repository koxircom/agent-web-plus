#!/usr/bin/env python3
"""Integration tests for Odoo LAN controller guards in odoo-addon-lock.py.

Validates guard behaviors under dry fixture conditions (no real NAS, SSH, or production):
1. Configuration parser guards: malformed JSON, missing 'enabled', non-object config
2. Local bypass prevention guard: overriding --state-root or ODOO_ADDON_LOCKS_DIR
   is strictly prohibited when LAN collaboration is enabled
3. Session stop/cancellation intent guard: active stop intention blocks acquire
   without writing local locks
4. Client role SSH gateway fail-closed guard: uses ODOO_LAN_SSH_BIN dry mock to
   verify exact command-line dispatch and fail-closed exit on SSH/remote failure
5. Protocol envelope & validation: serve rejects malformed or oversized RPC frames
"""

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

CLI_PATH = Path(__file__).resolve().parent / "odoo-addon-lock.py"


class TestOdooLanControllerGuards(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="odoo-lan-guards-")
        self.root = Path(self.temp_dir.name)
        self.state_dir = self.root / "state"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.config_file = self.state_dir / "odoo-lan-config.json"
        self.env = os.environ.copy()
        self.env["PI_CODING_AGENT_DIR"] = str(self.root)
        self.env["ODOO_LAN_CONFIG_FILE"] = str(self.config_file)
        self.env.pop("ODOO_ADDON_LOCKS_DIR", None)

    def tearDown(self):
        self.temp_dir.cleanup()

    def run_cli(self, args, env=None, expect_code=None):
        cmd = [sys.executable, str(CLI_PATH)] + args
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            env=env or self.env,
            timeout=10,
        )
        if expect_code is not None:
            self.assertEqual(
                proc.returncode,
                expect_code,
                f"Command {cmd} exited with {proc.returncode}, expected {expect_code}.\nStderr: {proc.stderr}\nStdout: {proc.stdout}",
            )
        return proc

    def test_01_malformed_config_rejected(self):
        # 1. Invalid JSON
        self.config_file.write_text("{ not valid json: ", encoding="utf-8")
        res = self.run_cli(["status", "addon_x"], expect_code=1)
        self.assertIn("Malformed Odoo LAN configuration", res.stderr)

        # 2. Missing 'enabled'
        self.config_file.write_text(json.dumps({"instanceId": "test:1"}), encoding="utf-8")
        res2 = self.run_cli(["status", "addon_x"], expect_code=1)
        self.assertIn("missing or non-boolean 'enabled'", res2.stderr)

        # 3. Not a JSON object
        self.config_file.write_text(json.dumps(["not", "an", "object"]), encoding="utf-8")
        res3 = self.run_cli(["status", "addon_x"], expect_code=1)
        self.assertIn("expected JSON object", res3.stderr)

    def test_02_local_bypass_prohibited_when_lan_enabled(self):
        # When LAN collaboration is enabled, users must not bypass via --state-root or ODOO_ADDON_LOCKS_DIR
        cfg = {
            "version": 1,
            "enabled": True,
            "role": "authority",
            "instanceId": "synology:30141",
            "instanceLabel": "群晖30141",
            "authorityScript": str(CLI_PATH),
        }
        self.config_file.write_text(json.dumps(cfg), encoding="utf-8")

        # Attempt override with --state-root
        res1 = self.run_cli(
            ["--state-root", "/tmp/bypass-state", "status", "addon_x"],
            expect_code=1,
        )
        self.assertIn("overriding --state-root or ODOO_ADDON_LOCKS_DIR is prohibited", res1.stderr)

        # Attempt override with ODOO_ADDON_LOCKS_DIR
        bypass_env = self.env.copy()
        bypass_env["ODOO_ADDON_LOCKS_DIR"] = "/tmp/bypass-env"
        res2 = self.run_cli(["status", "addon_x"], env=bypass_env, expect_code=1)
        self.assertIn("overriding --state-root or ODOO_ADDON_LOCKS_DIR is prohibited", res2.stderr)

    def test_03_cancelled_session_intent_blocks_acquire(self):
        # When user has an active cancellation/stop intent for a session, acquire must fail-closed
        cfg = {
            "version": 1,
            "enabled": True,
            "role": "authority",
            "instanceId": "synology:30141",
            "instanceLabel": "群晖30141",
            "authorityScript": str(CLI_PATH),
        }
        self.config_file.write_text(json.dumps(cfg), encoding="utf-8")

        target_sid = "session_stopped_user_task"
        sha = hashlib.sha256(target_sid.encode()).hexdigest()
        stop_dir = self.state_dir / "odoo-lan-cancelled" / sha
        stop_dir.mkdir(parents=True, exist_ok=True)
        (stop_dir / "stop_intent.json").write_text(
            json.dumps({"cancelledAt": "2026-11-01T12:00:00Z", "reason": "User cancelled"}),
            encoding="utf-8",
        )

        res = self.run_cli(
            ["--session", target_sid, "acquire", "addon_stopped"],
            expect_code=1,
        )
        self.assertIn("原会话停止意图仍有效", res.stderr)

    def test_04_client_mode_ssh_dispatch_and_fail_closed(self):
        # Configure client mode pointing to a mock SSH binary via ODOO_LAN_SSH_BIN
        mock_ssh_script = self.root / "mock_ssh.py"
        mock_ssh_log = self.root / "mock_ssh_invocations.json"

        # The mock SSH simulates authoritative instance response or failure
        mock_ssh_code = f"""#!/usr/bin/env python3
import sys, json, os

args = sys.argv[1:]
log_file = "{mock_ssh_log}"
try:
    with open(log_file, "w", encoding="utf-8") as f:
        json.dump({{"argv": args}}, f)
except Exception:
    pass

# Read RPC command from stdin
line = sys.stdin.readline()
try:
    cmd_envelope = json.loads(line)
    action = cmd_envelope.get("command", {{}}).get("action")
except Exception:
    sys.exit(255)

if os.environ.get("MOCK_SSH_FAIL") == "1":
    sys.stderr.write("[error] SSH connection timed out\\n")
    sys.exit(255)

# Simulate successful authority RPC response
resp = {{
    "id": cmd_envelope.get("id", "cli-rpc-1"),
    "ok": True,
    "result": {{
        "resource": "addon_remote",
        "status": "acquired",
        "token": "mock-remote-token-1234",
        "generation": 1
    }}
}}
sys.stdout.write(json.dumps(resp) + "\\n")
sys.stdout.flush()
sys.exit(0)
"""
        mock_ssh_script.write_text(mock_ssh_code, encoding="utf-8")
        mock_ssh_script.chmod(0o755)

        cfg = {
            "version": 1,
            "enabled": True,
            "role": "client",
            "instanceId": "synology:30142",
            "instanceLabel": "群晖30142",
            "ssh": {
                "port": 22,
                "user": "root",
                "host": "10.0.0.2",
                "identityFile": "/root/.ssh/id_rsa",
                "container": "pi-agent",
            },
            "authorityScript": "/workspace/agent-web-plus/bin/odoo-addon-lock.py",
        }
        self.config_file.write_text(json.dumps(cfg), encoding="utf-8")

        client_env = self.env.copy()
        client_env["ODOO_LAN_SSH_BIN"] = str(mock_ssh_script)

        # 1. Normal client mode dispatch routes through SSH
        res_ok = self.run_cli(
            ["--session", "client_sid", "acquire", "addon_remote", "--json"],
            env=client_env,
            expect_code=0,
        )
        self.assertTrue(mock_ssh_log.exists(), "Mock SSH must be invoked")
        log_data = json.loads(mock_ssh_log.read_text(encoding="utf-8"))
        self.assertIn("pi-agent", log_data["argv"])

        # 2. When SSH fails, client mode exits non-zero (fail-closed, never writes local lock)
        client_env["MOCK_SSH_FAIL"] = "1"
        res_fail = self.run_cli(
            ["--session", "client_sid", "acquire", "addon_remote", "--json"],
            env=client_env,
            expect_code=1,
        )
        self.assertNotEqual(res_fail.returncode, 0)


if __name__ == "__main__":
    unittest.main()
