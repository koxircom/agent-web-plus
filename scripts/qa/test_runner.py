#!/usr/bin/env python3
"""Hermetic self-test for scripts/qa/run.py.

It uses a temporary repository and a fake ``node`` executable. No project
dependencies, network, browser, or real test command are required.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Dict, List


HERE = Path(__file__).resolve().parent
RUNNER = HERE / "run.py"


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def run_runner(repo: Path, output: Path, fake_bin: Path, *args: str) -> subprocess.CompletedProcess:
    environment = os.environ.copy()
    environment["PATH"] = str(fake_bin) + os.pathsep + environment.get("PATH", "")
    return subprocess.run(
        [sys.executable, str(repo / "scripts" / "qa" / "run.py"), "--output-dir", str(output), *args],
        cwd=str(repo),
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        shell=False,
    )


def state(output: Path) -> Dict[str, Any]:
    return json.loads((output / "latest.json").read_text(encoding="utf-8"))


def shard_status(data: Dict[str, Any], name: str) -> Dict[str, Any]:
    for record in data["shards"]:
        if record["name"] == name:
            return record
    raise AssertionError(f"missing shard {name}")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def diagnostics(output: Path) -> str:
    if not (output / "latest.json").is_file():
        return "no latest.json"
    data = state(output)
    logs = {}
    for record in data.get("shards", []):
        log_path = record.get("logPath")
        if isinstance(log_path, str) and (output / log_path).is_file():
            logs[record.get("name")] = (output / log_path).read_text(encoding="utf-8", errors="replace")
    return json.dumps({"state": data, "logs": logs}, ensure_ascii=False)


def main() -> int:
    if not RUNNER.is_file():
        raise AssertionError(f"missing runner: {RUNNER}")
    with tempfile.TemporaryDirectory(prefix="pi-quality-runner-") as temporary:
        root = Path(temporary) / "repo"
        qa = root / "scripts" / "qa"
        fake_bin = Path(temporary) / "fake-bin"
        output = Path(temporary) / "quality-output"
        root.mkdir(parents=True)
        qa.mkdir(parents=True)
        fake_bin.mkdir(parents=True)
        shutil.copy2(RUNNER, qa / "run.py")
        fake_impl = fake_bin / "fake-node.py"
        fake_script = """#!/usr/bin/env python3
import os
import sys
import time
from pathlib import Path

if sys.argv[1:] == ["--version"]:
    print("v22.19.0-fake")
    raise SystemExit(0)
counter = os.environ.get("FAKE_NODE_COUNTER")
if counter:
    path = Path(counter)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write("run\\n")
mutate = os.environ.get("FAKE_NODE_MUTATE")
if mutate:
    time.sleep(0.05)
    Path(mutate).write_text("mutated during shard\\n", encoding="utf-8")
if "--sleep" in sys.argv:
    time.sleep(0.05)
print("fake node", " ".join(sys.argv[1:]))
raise SystemExit(7 if "--fail" in sys.argv else 0)
"""
        write(fake_impl, fake_script)
        if os.name == "nt":
            fake_node = fake_bin / "node.cmd"
            write(fake_node, f'@echo off\r\n"{sys.executable}" "%~dp0fake-node.py" %*\r\n')
        else:
            fake_node = fake_bin / "node"
            write(fake_node, fake_script)
            fake_node.chmod(fake_node.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        fake_command = [sys.executable, str(fake_impl)]
        write(root / "package.json", '{"name":"quality-fixture","version":"0.0.1","dependencies":{"react":"19.0.0"}}\n')
        write(root / "package-lock.json", '{"name":"quality-fixture","version":"0.0.1","lockfileVersion":3,"packages":{"":{"dependencies":{"react":"19.0.0"}}}}\n')
        write(root / "node_modules" / "fake-sdk" / "package.json", '{"name":"fake-sdk","version":"1.0.0"}\n')
        write(root / "node_modules" / "next" / "package.json", '{"name":"next","version":"16.0.0"}\n')
        write(root / "node_modules" / "react" / "package.json", '{"name":"react","version":"19.0.0"}\n')
        write(root / "app" / "source.ts", "export const source = 1;\n")
        write(root / "tests" / "pass.mjs", "test fixture\n")
        write(root / "tests" / "fail.mjs", "test fixture\n")
        counter = Path(temporary) / "counter.txt"
        manifest = {
            "schema": 1,
            "runnerVersion": "1",
            "runtime": {"requiredPackages": ["fake-sdk", "next", "react"]},
            "fingerprint": {
                "paths": ["app", "tests", "scripts", "package.json", "package-lock.json"],
                "excludeDirs": ["node_modules", ".next", "output", ".quality-runs"],
                "excludeFilePatterns": ["*.bundle.js", "*.cache"],
            },
            "suites": {
                "focused": {
                    "shards": [
                        {"name": "pass", "command": fake_command + ["--pass"], "files": ["tests/pass.mjs"], "env": {"FAKE_NODE_COUNTER": str(counter)}, "timeoutSeconds": 10},
                        {"name": "fail", "command": fake_command + ["--fail"], "files": ["tests/fail.mjs"], "env": {"FAKE_NODE_COUNTER": str(counter)}, "timeoutSeconds": 10},
                        {"name": "missing", "command": fake_command + ["--pass"], "files": ["tests/does-not-exist.mjs"], "env": {"FAKE_NODE_COUNTER": str(counter)}, "timeoutSeconds": 10},
                    ]
                },
                "mutation": {
                    "shards": [
                        {"name": "mutate-source", "command": fake_command + ["--mutate"], "files": ["tests/pass.mjs"], "env": {"FAKE_NODE_MUTATE": str(root / "app" / "source.ts"), "FAKE_NODE_COUNTER": str(counter)}, "timeoutSeconds": 10}
                    ]
                }
            }
        }
        write(qa / "manifest.json", json.dumps(manifest, indent=2) + "\n")

        listed = run_runner(root, output, fake_bin, "--list")
        require(listed.returncode == 0, f"--list failed: {listed.stdout}\n{listed.stderr}")
        require("focused" in listed.stdout and "pass" in listed.stdout, "--list omitted the fixture suite")

        first = run_runner(root, output, fake_bin, "--suite", "focused", "--shard", "pass")
        require(first.returncode == 0, f"initial pass failed: {first.stdout}\n{first.stderr}\n{diagnostics(output)}")
        first_state = state(output)
        require(shard_status(first_state, "pass")["status"] == "passed", "initial pass did not pass")
        require(counter.read_text(encoding="utf-8").count("run\n") == 1, "initial pass did not run exactly once")

        resumed = run_runner(root, output, fake_bin, "--suite", "focused", "--shard", "pass", "--resume")
        require(resumed.returncode == 0, f"resume failed: {resumed.stdout}\n{resumed.stderr}")
        resumed_state = state(output)
        require(shard_status(resumed_state, "pass").get("resumed") is True, "same fingerprint did not resume the passed shard")
        require(counter.read_text(encoding="utf-8").count("run\n") == 1, "resume reran a verified passed shard")

        partial = run_runner(root, output, fake_bin, "--suite", "focused", "--shard", "fail", "--resume")
        require(partial.returncode != 0, "selected failing shard unexpectedly passed")
        partial_state = state(output)
        require(shard_status(partial_state, "pass").get("resumed") is True, "partial resume discarded an unselected verified pass")
        require(shard_status(partial_state, "fail")["status"] == "failed", "selected failing shard was not executed")
        require(shard_status(partial_state, "missing")["status"] == "not_run", "unproven unselected shard was not left not_run")
        require(counter.read_text(encoding="utf-8").count("run\n") == 2, "partial resume ran the preserved pass")

        (output / "latest.json").write_text("{broken json\n", encoding="utf-8")
        corrupt_resume = run_runner(root, output, fake_bin, "--suite", "focused", "--shard", "pass", "--resume")
        require(corrupt_resume.returncode == 0, f"corrupt-state recovery failed: {corrupt_resume.stdout}\n{corrupt_resume.stderr}")
        require(shard_status(state(output), "pass").get("resumed") is not True, "corrupt JSON was trusted as a pass")
        require(counter.read_text(encoding="utf-8").count("run\n") == 3, "corrupt JSON did not force a rerun")

        (root / "app" / "source.ts").write_text("export const source = 2;\n", encoding="utf-8")
        changed = run_runner(root, output, fake_bin, "--suite", "focused", "--shard", "pass", "--resume")
        require(changed.returncode == 0, f"changed fingerprint run failed: {changed.stdout}\n{changed.stderr}")
        require(shard_status(state(output), "pass").get("resumed") is not True, "source change incorrectly resumed the old pass")
        require(counter.read_text(encoding="utf-8").count("run\n") == 4, "source change did not rerun the shard")

        (root / "node_modules" / "fake-sdk" / "package.json").write_text('{"name":"fake-sdk","version":"1.0.1"}\n', encoding="utf-8")
        sdk_changed = run_runner(root, output, fake_bin, "--suite", "focused", "--shard", "pass", "--resume")
        require(sdk_changed.returncode == 0, f"installed SDK change run failed: {sdk_changed.stdout}\n{sdk_changed.stderr}")
        require(shard_status(state(output), "pass").get("resumed") is not True, "installed SDK change incorrectly resumed the old pass")
        require(counter.read_text(encoding="utf-8").count("run\n") == 5, "installed SDK change did not rerun the shard")

        mutation_output = Path(temporary) / "mutation-output"
        mutated = run_runner(root, mutation_output, fake_bin, "--suite", "mutation")
        require(mutated.returncode != 0, "source mutation during a shard returned success")
        mutated_state = state(mutation_output)
        require(mutated_state.get("failureReason") == "source_changed_during_run", "source mutation was not recorded as source_changed_during_run")
        mutation_runs = counter.read_text(encoding="utf-8").count("run\n")
        mutated_resume = run_runner(root, mutation_output, fake_bin, "--suite", "mutation", "--resume")
        require(mutated_resume.returncode == 0, "post-mutation resume did not execute a fresh shard")
        require(counter.read_text(encoding="utf-8").count("run\n") == mutation_runs + 1, "source_changed_during_run incorrectly reused a cached pass")

        collected = run_runner(root, output, fake_bin, "--suite", "focused")
        require(collected.returncode != 0, "failure collection returned success")
        collected_state = state(output)
        require(shard_status(collected_state, "pass")["status"] == "passed", "safe passing shard was not completed")
        require(shard_status(collected_state, "fail")["status"] == "failed", "failed shard was not recorded")
        require(shard_status(collected_state, "missing")["status"] == "blocked", "missing-file shard was allowed to pass")
        require((output / shard_status(collected_state, "fail")["logPath"]).is_file(), "failed shard log was not written")

        result = {
            "status": "passed",
            "checks": [
                "list",
                "resume_same_fingerprint_and_command",
                "partial_resume_preserves_unselected_pass",
                "corrupt_state_rejected",
                "source_change_invalidates_resume",
                "installed_sdk_change_invalidates_resume",
                "source_change_during_run_blocks_pass",
                "source_changed_run_cannot_resume_cache",
                "failure_collection_continues",
                "missing_file_blocked",
            ],
            "counterRuns": counter.read_text(encoding="utf-8").count("run\n"),
            "finalShardStatuses": {record["name"]: record["status"] for record in collected_state["shards"]},
        }
        print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, indent=2), file=sys.stderr)
        raise
