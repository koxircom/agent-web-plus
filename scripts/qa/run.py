#!/usr/bin/env python3
"""Deterministic, resumable quality shards for pi-web.

The runner deliberately owns only test-process orchestration. It never starts a
web server, installs dependencies, talks to an API, or manages Docker.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


RUNNER_VERSION = "1"
MAX_WORKERS = 2
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
MANIFEST_PATH = SCRIPT_DIR / "manifest.json"
DEFAULT_OUTPUT_DIR = SCRIPT_DIR / ".quality-runs"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def write_private_json(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp_name, 0o600)
        except OSError:
            pass
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            try:
                os.unlink(temp_name)
            except OSError:
                pass


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def rel_posix(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def path_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def load_manifest() -> Dict[str, Any]:
    try:
        manifest = read_json(MANIFEST_PATH)
    except Exception as error:
        raise RuntimeError(f"cannot read manifest: {error}")
    if not isinstance(manifest, dict) or manifest.get("schema") != 1:
        raise RuntimeError("manifest schema must be 1")
    if manifest.get("runnerVersion") != RUNNER_VERSION:
        raise RuntimeError("manifest runnerVersion does not match this runner")
    suites = manifest.get("suites")
    if not isinstance(suites, dict) or not suites:
        raise RuntimeError("manifest must define suites")
    for suite_name, suite in suites.items():
        if not isinstance(suite, dict) or not isinstance(suite.get("shards"), list) or not suite["shards"]:
            raise RuntimeError(f"suite {suite_name!r} has no shards")
        seen = set()
        for shard in suite["shards"]:
            if not isinstance(shard, dict) or not isinstance(shard.get("name"), str):
                raise RuntimeError(f"suite {suite_name!r} contains an invalid shard")
            name = shard["name"]
            if name in seen:
                raise RuntimeError(f"suite {suite_name!r} repeats shard {name!r}")
            seen.add(name)
            if not isinstance(shard.get("command"), list) or not shard["command"] or not all(isinstance(item, str) and item for item in shard["command"]):
                raise RuntimeError(f"shard {suite_name}/{name} has an invalid command")
            if not isinstance(shard.get("files"), list) or not all(isinstance(item, str) and item for item in shard["files"]):
                raise RuntimeError(f"shard {suite_name}/{name} has an invalid files list")
    return manifest


def excluded(rel_path: str, fingerprint: Dict[str, Any]) -> bool:
    parts = Path(rel_path).parts
    excluded_dirs = set(fingerprint.get("excludeDirs", []))
    if any(part in excluded_dirs for part in parts[:-1]):
        return True
    return any(fnmatch.fnmatch(parts[-1], pattern) for pattern in fingerprint.get("excludeFilePatterns", []))


def fingerprint_paths(manifest: Dict[str, Any]) -> List[Path]:
    config = manifest.get("fingerprint") or {}
    paths = config.get("paths")
    if not isinstance(paths, list) or not paths:
        raise RuntimeError("fingerprint.paths must be a non-empty list")
    found: Dict[str, Path] = {}
    for raw in paths:
        if not isinstance(raw, str) or not raw:
            raise RuntimeError("fingerprint path must be a non-empty string")
        candidate = (REPO_ROOT / raw).resolve()
        if not path_within(candidate, REPO_ROOT):
            raise RuntimeError(f"fingerprint path escapes repository: {raw}")
        if not candidate.exists():
            raise RuntimeError(f"missing fingerprint path: {raw}")
        if candidate.is_file():
            relative = rel_posix(candidate, REPO_ROOT)
            if not excluded(relative, config):
                found[relative] = candidate
            continue
        for current, dir_names, file_names in os.walk(candidate, topdown=True, followlinks=False):
            current_path = Path(current)
            dir_names[:] = sorted(name for name in dir_names if name not in set(config.get("excludeDirs", [])))
            for file_name in sorted(file_names):
                file_path = current_path / file_name
                if not file_path.is_file():
                    continue
                relative = rel_posix(file_path, REPO_ROOT)
                if not excluded(relative, config):
                    found[relative] = file_path
    return [found[key] for key in sorted(found)]


def node_runtime() -> Dict[str, Any]:
    executable = shutil.which("node")
    resolved = os.path.realpath(executable) if executable else None
    try:
        result = subprocess.run(["node", "--version"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=5, shell=False)
        output = (result.stdout or "").strip()
        version = output if result.returncode == 0 and output else f"unavailable:{result.returncode}"
    except Exception as error:
        version = f"unavailable:{type(error).__name__}"
    return {"version": version, "path": resolved}


def installed_package_json(package_name: str) -> Path:
    return REPO_ROOT / "node_modules" / Path(*package_name.split("/")) / "package.json"


def sdk_versions(manifest: Dict[str, Any]) -> Dict[str, Any]:
    package_path = REPO_ROOT / "package.json"
    lock_path = REPO_ROOT / "package-lock.json"
    package: Dict[str, Any] = {}
    lock: Dict[str, Any] = {}
    try:
        package = read_json(package_path)
    except Exception:
        package = {"error": "package.json unreadable"}
    try:
        lock = read_json(lock_path)
    except Exception:
        lock = {"error": "package-lock.json unreadable"}
    configured_runtime = manifest.get("runtime") or {}
    names = configured_runtime.get("requiredPackages") or [
        "next", "react", "react-dom", "typescript", "playwright", "esbuild",
        "@earendil-works/pi-agent-core", "@earendil-works/pi-ai",
        "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui",
    ]
    dependency_maps = [package.get("dependencies", {}), package.get("devDependencies", {})]
    declared = {name: mapping.get(name) for mapping in dependency_maps for name in names if name in mapping}
    lock_root = lock.get("packages", {}).get("", {}) if isinstance(lock, dict) else {}
    installed: Dict[str, Any] = {}
    missing = []
    for name in names:
        package_json = installed_package_json(name)
        if not package_json.is_file():
            missing.append(name)
            installed[name] = {"missing": True, "path": str(package_json)}
            continue
        try:
            package_data = read_json(package_json)
            installed[name] = {
                "version": package_data.get("version"),
                "sha256": sha256_file(package_json),
                "path": str(package_json.resolve()),
            }
        except Exception as error:
            missing.append(name)
            installed[name] = {"error": str(error), "path": str(package_json)}
    return {
        "packageVersion": package.get("version"),
        "declared": declared,
        "lockRootDependencies": lock_root.get("dependencies", {}) if isinstance(lock_root, dict) else {},
        "requiredPackages": names,
        "installed": installed,
        "missing": missing,
    }


def build_fingerprint(manifest: Dict[str, Any], suite_name: str) -> Tuple[str, Dict[str, Any]]:
    files = []
    for path in fingerprint_paths(manifest):
        relative = rel_posix(path, REPO_ROOT)
        files.append({"path": relative, "sha256": sha256_file(path), "size": path.stat().st_size})
    payload: Dict[str, Any] = {
        "runnerVersion": RUNNER_VERSION,
        "suite": suite_name,
        "manifestSuites": manifest.get("suites"),
        "fingerprintConfig": manifest.get("fingerprint"),
        "files": files,
        "runtime": {"node": node_runtime(), "sdk": sdk_versions(manifest)},
    }
    return sha256_bytes(canonical_json(payload).encode("utf-8")), payload


def command_signature(suite_name: str, shard: Dict[str, Any]) -> str:
    value = {
        "suite": suite_name,
        "name": shard["name"],
        "command": shard["command"],
        "cwd": shard.get("cwd", "."),
        "files": shard["files"],
        "env": shard.get("env", {}),
        "timeoutSeconds": shard.get("timeoutSeconds", 300),
    }
    return sha256_bytes(canonical_json(value).encode("utf-8"))


def safe_name(value: str) -> str:
    return "".join(char if char.isalnum() or char in "._-" else "_" for char in value)


def check_shard_files(shard: Dict[str, Any]) -> List[str]:
    missing = []
    for raw in shard["files"]:
        path = (REPO_ROOT / raw).resolve()
        if not path_within(path, REPO_ROOT) or not path.is_file():
            missing.append(raw)
    cwd = (REPO_ROOT / shard.get("cwd", ".")).resolve()
    if not path_within(cwd, REPO_ROOT) or not cwd.is_dir():
        missing.append(f"cwd:{shard.get('cwd', '.')}")
    return missing


def log_hash(path: Path) -> str:
    return sha256_file(path) if path.is_file() else ""


def make_private(path: Path, mode: int = 0o600) -> None:
    try:
        os.chmod(path, mode)
    except OSError:
        pass


def prior_resume_record(prior: Dict[str, Any], shard: Dict[str, Any], fingerprint: str, signature: str, output_dir: Path) -> Optional[Dict[str, Any]]:
    if not isinstance(prior, dict) or prior.get("schema") != 1 or prior.get("fingerprint") != fingerprint:
        return None
    if prior.get("failureReason") == "source_changed_during_run":
        return None
    prior_shards = prior.get("shards")
    if not isinstance(prior_shards, list):
        return None
    record = next((item for item in prior_shards if isinstance(item, dict) and item.get("name") == shard["name"]), None)
    if not record or record.get("status") != "passed" or record.get("exitCode") != 0 or record.get("commandSignature") != signature:
        return None
    log_path = record.get("logPath")
    if not isinstance(log_path, str):
        return None
    absolute_log = (output_dir / log_path).resolve()
    if not path_within(absolute_log, output_dir) or not absolute_log.is_file():
        return None
    if record.get("logSha256") != log_hash(absolute_log):
        return None
    reused = dict(record)
    reused["resumed"] = True
    reused["resumeSourceRunId"] = prior.get("runId")
    return reused


def persist_state(state: Dict[str, Any], output_dir: Path) -> None:
    run_path = output_dir / f"{state['runId']}.json"
    latest_path = output_dir / "latest.json"
    write_private_json(run_path, state)
    write_private_json(latest_path, state)


def execute_shard(repo_root: Path, output_dir: Path, suite_name: str, shard: Dict[str, Any], run_id: str) -> Dict[str, Any]:
    name = shard["name"]
    log_relative = Path("logs") / f"{safe_name(run_id)}__{safe_name(suite_name)}__{safe_name(name)}.log"
    log_path = output_dir / log_relative
    log_path.parent.mkdir(parents=True, exist_ok=True)
    start = now_iso()
    timeout = float(shard.get("timeoutSeconds", 300))
    cwd = (repo_root / shard.get("cwd", ".")).resolve()
    env = os.environ.copy()
    env.update({str(key): str(value) for key, value in (shard.get("env") or {}).items()})
    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            log.write(f"$ {' '.join(shard['command'])}\n")
            log.flush()
            process = subprocess.Popen(shard["command"], cwd=str(cwd), env=env, stdout=log, stderr=subprocess.STDOUT, shell=False)
            try:
                exit_code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                exit_code = process.wait()
                make_private(log_path)
                return {
                    "name": name, "status": "failed", "reason": "timeout", "exitCode": exit_code,
                    "startedAt": start, "finishedAt": now_iso(), "logPath": log_relative.as_posix(), "logSha256": log_hash(log_path),
                }
        make_private(log_path)
    except FileNotFoundError as error:
        log_path.write_text(f"executable not found: {error}\n", encoding="utf-8")
        make_private(log_path)
        return {"name": name, "status": "blocked", "reason": "executable_not_found", "exitCode": None,
                "startedAt": start, "finishedAt": now_iso(), "logPath": log_relative.as_posix(), "logSha256": log_hash(log_path)}
    except Exception as error:
        log_path.write_text(f"runner exception: {type(error).__name__}: {error}\n", encoding="utf-8")
        make_private(log_path)
        return {"name": name, "status": "failed", "reason": "runner_exception", "error": str(error), "exitCode": None,
                "startedAt": start, "finishedAt": now_iso(), "logPath": log_relative.as_posix(), "logSha256": log_hash(log_path)}
    return {
        "name": name,
        "status": "passed" if exit_code == 0 else "failed",
        "reason": "exit_zero" if exit_code == 0 else "nonzero_exit",
        "exitCode": exit_code,
        "startedAt": start,
        "finishedAt": now_iso(),
        "logPath": log_relative.as_posix(),
        "logSha256": log_hash(log_path),
    }


def parse_shard_names(raw_values: Optional[Sequence[str]], shards: List[Dict[str, Any]]) -> List[str]:
    all_names = [shard["name"] for shard in shards]
    if not raw_values:
        return all_names
    selected: List[str] = []
    for raw in raw_values:
        for value in raw.split(","):
            value = value.strip()
            if not value:
                continue
            if value.isdigit():
                index = int(value) - 1
                if index < 0 or index >= len(all_names):
                    raise ValueError(f"unknown shard index: {value}")
                value = all_names[index]
            if value not in all_names:
                raise ValueError(f"unknown shard: {value}")
            if value not in selected:
                selected.append(value)
    if not selected:
        raise ValueError("--shard selected no shards")
    return selected


def list_suites(manifest: Dict[str, Any]) -> None:
    result = {}
    for suite_name, suite in manifest["suites"].items():
        result[suite_name] = [{"name": shard["name"], "command": shard["command"], "files": shard["files"]} for shard in suite["shards"]]
    print(json.dumps({"sourceRoot": str(REPO_ROOT), "suites": result}, ensure_ascii=False, indent=2))


def load_prior(output_dir: Path) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    path = output_dir / "latest.json"
    if not path.is_file():
        return None, "no_latest_state"
    try:
        prior = read_json(path)
    except Exception as error:
        return None, f"invalid_latest_json:{error}"
    if not isinstance(prior, dict) or prior.get("schema") != 1 or not isinstance(prior.get("shards"), list):
        return None, "invalid_latest_schema"
    return prior, None


def run(args: argparse.Namespace) -> int:
    manifest = load_manifest()
    if args.list:
        list_suites(manifest)
        return 0
    suite_name = args.suite or "focused"
    suites = manifest["suites"]
    if suite_name not in suites:
        raise ValueError(f"unknown suite: {suite_name}; choose from {', '.join(suites)}")
    suite = suites[suite_name]
    shards = suite["shards"]
    selected_names = parse_shard_names(args.shard, shards)
    selected_set = set(selected_names)
    output_dir = Path(args.output_dir).expanduser().resolve() if args.output_dir else DEFAULT_OUTPUT_DIR.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    make_private(output_dir, 0o700)
    fingerprint, fingerprint_details = build_fingerprint(manifest, suite_name)
    runtime_missing = list(fingerprint_details.get("runtime", {}).get("sdk", {}).get("missing", []))
    if str(fingerprint_details.get("runtime", {}).get("node", {}).get("version", "")).startswith("unavailable:"):
        runtime_missing.append("node")

    prior = None
    resume_reason = None
    if args.resume:
        prior, resume_reason = load_prior(output_dir)

    if prior and prior.get("fingerprint") == fingerprint and prior.get("suite") == suite_name:
        run_id = str(prior.get("runId")) if isinstance(prior.get("runId"), str) else f"quality-{datetime.now().strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"
    else:
        run_id = f"quality-{datetime.now().strftime('%Y%m%dT%H%M%S')}-{os.getpid()}"

    shard_records: List[Dict[str, Any]] = []
    runnable: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
    for shard in shards:
        name = shard["name"]
        signature = command_signature(suite_name, shard)
        missing = check_shard_files(shard)
        if name in selected_set and missing:
            shard_records.append({"name": name, "status": "blocked", "reason": "missing_files", "missingFiles": missing, "commandSignature": signature})
            continue
        if name in selected_set and runtime_missing:
            shard_records.append({"name": name, "status": "blocked", "reason": "missing_runtime_dependency", "missingDependencies": runtime_missing, "commandSignature": signature})
            continue
        reused = prior_resume_record(prior, shard, fingerprint, signature, output_dir) if args.resume and prior and not runtime_missing and not missing else None
        if reused:
            if name not in selected_set:
                reused["reason"] = "verified_pass_not_selected"
            shard_records.append(reused)
            continue
        if name not in selected_set:
            shard_records.append({"name": name, "status": "not_run", "reason": "not_selected", "commandSignature": signature})
            continue
        record = {"name": name, "status": "not_run", "reason": "pending", "commandSignature": signature}
        shard_records.append(record)
        runnable.append((shard, record))

    state: Dict[str, Any] = {
        "schema": 1,
        "runnerVersion": RUNNER_VERSION,
        "runId": run_id,
        "startedAt": now_iso(),
        "finishedAt": None,
        "status": "running",
        "suite": suite_name,
        "selectedShards": selected_names,
        "sourceRoot": str(REPO_ROOT),
        "outputDir": str(output_dir),
        "fingerprint": fingerprint,
        "fingerprintDetails": fingerprint_details,
        "runtimeMissing": runtime_missing,
        "resume": {"requested": bool(args.resume), "sourceRunId": prior.get("runId") if prior else None, "rejection": resume_reason},
        "shards": shard_records,
    }
    persist_state(state, output_dir)

    def update_record(name: str, result: Dict[str, Any]) -> None:
        for index, record in enumerate(state["shards"]):
            if record.get("name") == name:
                state["shards"][index] = {**record, **result}
                break

    if runnable:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(execute_shard, REPO_ROOT, output_dir, suite_name, shard, run_id): (shard, record) for shard, record in runnable}
            for future in as_completed(futures):
                shard, _record = futures[future]
                try:
                    result = future.result()
                except Exception as error:
                    result = {"name": shard["name"], "status": "failed", "reason": "worker_exception", "error": str(error), "exitCode": None, "finishedAt": now_iso()}
                update_record(shard["name"], result)
                persist_state(state, output_dir)

    selected_records = [record for record in state["shards"] if record.get("name") in selected_set]
    if any(record.get("status") in {"failed", "blocked", "not_run"} for record in selected_records):
        state["status"] = "failed"
    elif selected_records and all(record.get("status") == "passed" for record in selected_records):
        state["status"] = "passed" if all(record.get("status") == "passed" for record in state["shards"]) else "partial-passed"
    else:
        state["status"] = "failed"
    state["allShardsPassed"] = all(record.get("status") == "passed" for record in state["shards"])
    try:
        final_fingerprint, final_details = build_fingerprint(manifest, suite_name)
        state["fingerprintAfterRun"] = final_fingerprint
        state["fingerprintDetailsAfterRun"] = final_details
        if final_fingerprint != fingerprint:
            state["status"] = "failed"
            state["allShardsPassed"] = False
            state["failureReason"] = "source_changed_during_run"
            state["sourceChangedDuringRun"] = {"before": fingerprint, "after": final_fingerprint}
    except Exception as error:
        state["status"] = "failed"
        state["allShardsPassed"] = False
        state["failureReason"] = "source_changed_during_run"
        state["sourceChangedDuringRun"] = {"before": fingerprint, "after": None, "error": str(error)}
    state["finishedAt"] = now_iso()
    persist_state(state, output_dir)

    counts = {status: sum(1 for record in state["shards"] if record.get("status") == status) for status in ("passed", "failed", "blocked", "not_run")}
    resumed = sum(1 for record in selected_records if record.get("resumed"))
    print(f"quality suite={suite_name} status={state['status']} fingerprint={fingerprint[:12]} passed={counts['passed']} failed={counts['failed']} blocked={counts['blocked']} not_run={counts['not_run']} resumed={resumed} output={output_dir}")
    return 0 if state["status"] in ("passed", "partial-passed") else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run deterministic pi-web quality shards.")
    parser.add_argument("--list", action="store_true", help="list manifest suites and shards without executing them")
    parser.add_argument("--suite", help="suite name (default: focused)")
    parser.add_argument("--shard", action="append", help="repeatable shard name or one-based index")
    parser.add_argument("--resume", action="store_true", help="reuse only verified passed shards with the same fingerprint and command")
    parser.add_argument("--output-dir", help="private JSON state and log directory")
    args = parser.parse_args(argv)
    try:
        return run(args)
    except (RuntimeError, ValueError) as error:
        print(f"quality error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
