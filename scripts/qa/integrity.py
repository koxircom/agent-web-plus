#!/usr/bin/env python3
"""Read-only receipt/catalog/file audit. Never deletes, restores or resends."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from datetime import datetime, timezone


def inspect(agent_dir, ledger=None, catalog=None, verify_entries=False, limit=2000, byte_budget=32 * 1024 * 1024):
    agent = Path(agent_dir)
    findings, files, owners = [], {}, {}
    def issue(code, subject, severity="critical", **details):
        findings.append({"code": code, "subject": subject, "severity": severity, **details})
    root = agent / "sessions"
    if not root.is_dir():
        issue("session_root_unavailable", str(root))
    try:
        paths = []
        if root.is_dir():
            for project in root.iterdir():
                if not project.is_dir(): continue
                try: paths.extend(path for path in project.iterdir() if path.name.endswith(".jsonl"))
                except OSError as error:
                    if error.errno not in (2, 20): issue("project_unreadable", project.name, errno=error.errno)
        paths.sort()
        if len(paths) > limit:
            issue("inventory_limit", "sessions", severity="warning", limit=limit)
        for path in paths[:limit]:
            try:
                with path.open("rb") as stream:
                    prefix = stream.read(65536)
                header = None
                for line in prefix.splitlines():
                    try: header = json.loads(line); break
                    except (ValueError, UnicodeError): continue
                if not isinstance(header, dict) or header.get("type") != "session" or not isinstance(header.get("id"), str):
                    issue("invalid_header", path.name); continue
                sid = header["id"]
                if sid in files: issue("duplicate_session_id", sid)
                files[sid] = path
                owners[hashlib.sha256(sid.encode()).hexdigest()] = sid
            except OSError as error:
                issue("unreadable_session", path.name, errno=error.errno)
    except OSError as error:
        issue("inventory_read_failed", "sessions", errno=error.errno)
    if ledger:
        for sid, row in ledger.get("sessions", {}).items():
            sid = row.get("id", sid)
            owners[hashlib.sha256(sid.encode()).hexdigest()] = sid
    if catalog is not None:
        ids = {row["id"] for row in catalog.get("sessions", []) if not row.get("transient") and not row.get("submissionPending")}
        for sid in sorted(set(files) - ids): issue("catalog_omits_file", sid)
        for sid in sorted(ids - set(files)): issue("catalog_has_no_file", sid)
    expected_deleted = set()
    journal = agent / "state" / "session-deletions-v1.jsonl"
    if journal.exists():
        try:
            with journal.open(encoding="utf-8-sig") as stream:
                for line in stream:
                    try: record = json.loads(line)
                    except ValueError:
                        issue("malformed_deletion_audit", "audit", severity="warning"); continue
                    if record.get("phase") in ("completed", "failed-or-partial"):
                        expected_deleted.update(record.get("deletedIds", []))
        except OSError as error:
            issue("deletion_audit_unreadable", "audit", severity="warning", errno=error.errno)
    receipts, verified, checks = 0, 0, {}
    receipt_root = agent / "state" / "prompt-deliveries-v1"
    receipt_paths = []
    if receipt_root.exists():
        try:
            for folder in receipt_root.iterdir():
                if folder.is_dir(): receipt_paths.extend(folder.glob("*.json"))
        except OSError as error: issue("receipt_inventory_failed", "receipts", severity="warning", errno=error.errno)
    receipt_paths.sort()
    if len(receipt_paths) > limit:
        issue("receipt_limit", "receipts", severity="warning", limit=limit)
    for path in receipt_paths[:limit]:
        try:
            if path.stat().st_size > 8 * 1024 * 1024:
                issue("receipt_size_limit", path.name, severity="warning"); continue
            row = json.loads(path.read_text(encoding="utf-8-sig"))
            if row.get("receipt", {}).get("status") != "committed": continue
            receipts += 1
            sid, entry_id = owners.get(path.parent.name), row["receipt"].get("entryId")
            if not sid:
                issue("unmapped_committed_receipt", path.parent.name, severity="warning"); continue
            if sid not in files:
                if sid not in expected_deleted: issue("committed_session_missing", sid)
                continue
            if entry_id: checks.setdefault(sid, set()).add(entry_id)
        except (OSError, ValueError, TypeError) as error:
            issue("receipt_unreadable", path.name, severity="warning", errorType=type(error).__name__)
    if verify_entries:
        for sid, expected in checks.items():
            found, complete = set(), False
            try:
                with files[sid].open("rb") as stream:
                    while byte_budget > 0:
                        line = stream.readline(min(byte_budget, 16 * 1024 * 1024))
                        byte_budget -= len(line)
                        if not line: complete = True; break
                        if not line.endswith(b"\n"):
                            issue("entry_scan_budget", sid, severity="warning"); break
                        try: entry = json.loads(line)
                        except (ValueError, UnicodeError): continue
                        if entry.get("id") in expected and entry.get("type") == "message" and entry.get("message", {}).get("role") == "user":
                            found.add(entry["id"])
                        if found == expected: complete = True; break
                verified += len(found)
                for entry_id in sorted(expected - found):
                    issue("committed_entry_missing" if complete else "entry_not_verified_budget", sid,
                          severity="critical" if complete else "warning", entryId=entry_id)
            except OSError as error: issue("entry_read_failed", sid, errno=error.errno)
    return {"schema": 1, "at": datetime.now(timezone.utc).isoformat(), "readOnly": True,
            "status": "passed" if not findings else "findings", "sessionFiles": len(files),
            "committedReceipts": receipts, "entryVerificationRequested": verify_entries,
            "verifiedEntries": verified, "findings": findings,
            "limits": {"items": limit, "remainingScanBytes": byte_budget}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--agent-dir", required=True)
    parser.add_argument("--ledger")
    parser.add_argument("--catalog")
    parser.add_argument("--verify-entries", action="store_true")
    parser.add_argument("--limit", type=int, default=2000)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    load = lambda path: json.loads(Path(path).read_text(encoding="utf-8-sig")) if path else None
    result = inspect(args.agent_dir, load(args.ledger), load(args.catalog), args.verify_entries, args.limit)
    output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(output), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream: json.dump(result, stream, ensure_ascii=False, indent=2)
    print(json.dumps({"status": result["status"], "files": result["sessionFiles"], "findings": len(result["findings"]), "output": str(output)}))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__": raise SystemExit(main())
