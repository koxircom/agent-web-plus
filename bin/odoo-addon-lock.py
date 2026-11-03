#!/usr/bin/env python3
"""Small CLI tool for Odoo addon cooperative locking.

Provides cooperative locking for addon source editing and deployment resources
(e.g., 'test-deployment') across Pi sessions sharing the same instance state.
Guarantees fail-closed concurrency via atomic mkdir, strict whitelist regex,
session idempotency, non-owner release rejection, and safe cleanups.
"""

import argparse
import contextlib
import datetime
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_STATE_ROOT = "/root/.pi/agent/state/odoo-addon-locks"
RESOURCE_REGEX = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
DEFAULT_INSTANCE_ID = "synology:30141"
DEFAULT_INSTANCE_LABEL = "群晖30141"
PROTOCOL_VERSION = "odoo-addon-lan-v1"
FRAME_LIMIT_BYTES = 1024 * 1024  # 1 MiB
DEFAULT_RESUME_TASK = "继续原会话中因Odoo插件锁等待暂停的原任务；先核对最新源码、原待办和授权边界，不新增发布、外发或权限操作。"


def load_lan_config(config_path: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Load and validate odoo-lan-config.json.

    Returns:
        None if file does not exist (unconfigured).
        dict with enabled=False if explicitly disabled.
        validated config dict if enabled=True.
    Raises:
        ValueError if file exists but is malformed, missing required fields, or unreadable.
    """
    if config_path and str(config_path).strip():
        cfg_file = Path(str(config_path).strip()).resolve()
    elif os.environ.get("ODOO_LAN_CONFIG_FILE"):
        cfg_file = Path(os.environ["ODOO_LAN_CONFIG_FILE"].strip()).resolve()
    else:
        agent_dir = (
            os.environ.get("PI_CODING_AGENT_DIR")
            or os.environ.get("PI_AGENT_DIR")
            or "/root/.pi/agent"
        )
        cfg_file = Path(agent_dir).resolve() / "state" / "odoo-lan-config.json"

    try:
        raw = cfg_file.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except Exception as e:
        raise ValueError(
            f"Failed to read Odoo LAN configuration from '{cfg_file}': {e}"
        )

    try:
        data = json.loads(raw)
    except Exception as e:
        raise ValueError(
            f"Malformed Odoo LAN configuration in '{cfg_file}': invalid JSON ({e})"
        )

    if not isinstance(data, dict):
        raise ValueError(
            f"Malformed Odoo LAN configuration in '{cfg_file}': expected JSON object"
        )

    if "enabled" not in data or not isinstance(data["enabled"], bool):
        raise ValueError(
            f"Malformed Odoo LAN configuration in '{cfg_file}': missing or non-boolean 'enabled' field"
        )

    if not data["enabled"]:
        return {"enabled": False}

    if data.get("version") != 1:
        raise ValueError(
            f"Malformed Odoo LAN configuration: expected version 1, got {data.get('version')}"
        )

    if not data.get("instanceId") or not isinstance(data.get("instanceId"), str):
        raise ValueError(
            "Malformed Odoo LAN configuration: instanceId string is required"
        )

    if not data.get("instanceLabel") or not isinstance(data.get("instanceLabel"), str):
        raise ValueError(
            "Malformed Odoo LAN configuration: instanceLabel string is required"
        )

    role = data.get("role")
    if role not in ("authority", "client"):
        raise ValueError(f"Malformed Odoo LAN configuration: invalid role '{role}'")

    if not data.get("authorityScript") or not isinstance(
        data.get("authorityScript"), str
    ):
        raise ValueError(
            "Malformed Odoo LAN configuration: authorityScript string is required"
        )

    if role == "client":
        ssh = data.get("ssh")
        if (
            not isinstance(ssh, dict)
            or not ssh.get("host")
            or not ssh.get("user")
            or not ssh.get("identityFile")
            or not ssh.get("container")
        ):
            raise ValueError(
                "Malformed Odoo LAN configuration: client role requires complete ssh config (host, user, identityFile, container)"
            )

    return data


def validate_resource_name(resource: str) -> str:
    """Validate resource or module name against strict whitelist regex."""
    if not resource or not isinstance(resource, str):
        raise ValueError("Resource name cannot be empty")
    cleaned = resource.strip()
    if not RESOURCE_REGEX.match(cleaned):
        raise ValueError(
            f"Invalid resource name '{resource}': must match pattern ^[a-zA-Z0-9][a-zA-Z0-9_-]{{0,63}}$"
        )
    return cleaned


def get_state_root(cli_root: Optional[str] = None) -> Path:
    """Resolve lock state directory root."""
    if cli_root and str(cli_root).strip():
        return Path(cli_root.strip()).resolve()
    env_root = os.environ.get("ODOO_ADDON_LOCKS_DIR")
    if env_root and env_root.strip():
        return Path(env_root.strip()).resolve()
    return Path(DEFAULT_STATE_ROOT).resolve()


def resolve_session_id(cli_session: Optional[str] = None) -> Optional[str]:
    """Resolve session ID from CLI argument or environment."""
    if cli_session and str(cli_session).strip():
        return str(cli_session).strip()
    env_sid = os.environ.get("PI_SESSION_ID")
    if env_sid and env_sid.strip():
        return env_sid.strip()
    return None


def resolve_session_title(
    session_id: Optional[str], cli_title: Optional[str] = None
) -> str:
    """Resolve human-readable session title."""
    if cli_title and str(cli_title).strip():
        return str(cli_title).strip()

    if session_id:
        # 1. 尝试从 pi-web-session-index.json 解析真实标题
        index_file = Path("/root/.pi/agent/pi-web-session-index.json")
        if index_file.is_file():
            try:
                with open(index_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                entries = data.get("entries", {})
                for entry in entries.values():
                    info = entry.get("info", {})
                    if info.get("id") == session_id:
                        name = info.get("name")
                        if name and str(name).strip():
                            return str(name).strip()
            except Exception:
                pass

        # 2. 尝试从 PI_SESSION_FILE 头部解析
        session_file = os.environ.get("PI_SESSION_FILE")
        if session_file and os.path.isfile(session_file):
            try:
                with open(session_file, "r", encoding="utf-8") as f:
                    first_line = f.readline()
                    if first_line:
                        sdata = json.loads(first_line)
                        name = sdata.get("name") or sdata.get("title")
                        if name and str(name).strip():
                            return str(name).strip()
            except Exception:
                pass

    return "未命名会话"


def resolve_owner_pid(cli_pid: Optional[Any] = None) -> int:
    """Resolve owner PID."""
    if cli_pid is not None:
        try:
            return int(cli_pid)
        except (ValueError, TypeError):
            pass
    return os.getpid()


def resolve_host(cli_host: Optional[str] = None) -> str:
    """Resolve host identifier."""
    if cli_host and str(cli_host).strip():
        return str(cli_host).strip()
    return socket.gethostname()


def _now_iso() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class AddonLockManager:
    """Manages cooperative locks for Odoo addons and deployment resources."""

    def __init__(
        self,
        state_root: Optional[Path] = None,
        instance_id: str = DEFAULT_INSTANCE_ID,
        instance_label: str = DEFAULT_INSTANCE_LABEL,
    ):
        self.state_root = state_root or get_state_root()
        self.instance_id = instance_id
        self.instance_label = instance_label
        self._current_mutation_marker = None

    def _mark_mutated(self) -> None:
        """Mark that current transaction mutated on-disk state."""
        if hasattr(self, "_current_mutation_marker") and callable(
            self._current_mutation_marker
        ):
            self._current_mutation_marker()

    @contextlib.contextmanager
    def _transaction(self, timeout_sec: float = 2.0):
        """Atomic mkdir transaction gate bounded to <= 2.0s monotonic time with dirty failclosed guard."""
        self.state_root.mkdir(parents=True, exist_ok=True)
        dirty_marker = self.state_root / ".dirty"
        txn_dir = self.state_root / ".txn.lock"
        start_time = time.monotonic()
        acquired = False
        while True:
            try:
                txn_dir.mkdir()
                acquired = True
                break
            except FileExistsError:
                if time.monotonic() - start_time > timeout_sec:
                    raise TimeoutError(
                        f"Transaction contention timeout ({timeout_sec}s)"
                    )
                time.sleep(0.02)

        # Check integrity after transaction admission: a live writer's temporary
        # dirty marker is not a failure, but a leftover marker must fail closed.
        if dirty_marker.exists():
            txn_dir.rmdir()
            raise RuntimeError("Lock authority is DIRTY fail-closed after an interrupted transaction; manual recovery required")
        mutated = False

        def mark_dirty():
            nonlocal mutated
            if not mutated:
                mutated = True
                dirty_marker.touch()

        self._current_mutation_marker = mark_dirty

        try:
            yield mark_dirty
            if mutated and dirty_marker.exists():
                try:
                    dirty_marker.unlink()
                except Exception:
                    pass
        finally:
            self._current_mutation_marker = None
            if acquired:
                try:
                    txn_dir.rmdir()
                except Exception:
                    pass

    def _get_generation(self) -> int:
        gen_file = self.state_root / ".generation"
        if not gen_file.is_file():
            for lock_dir in self.state_root.glob("*.lock"):
                metadata = lock_dir / "metadata.json"
                handoff = lock_dir / "handoff.json"
                for stored in (metadata, handoff):
                    if stored.is_file():
                        record = json.loads(stored.read_text(encoding="utf-8"))
                        if record.get("token") or record.get("generation"):
                            raise ValueError("Missing .generation alongside modern grants; refusing counter reset")
            return 0
        try:
            val = int(gen_file.read_text(encoding="utf-8").strip())
            if val < 0:
                raise ValueError("Negative generation")
            return val
        except Exception as e:
            raise ValueError(f"Corrupt .generation file in {self.state_root}: {e}")

    def _next_generation(self) -> int:
        self._mark_mutated()
        curr = self._get_generation()
        nxt = curr + 1
        gen_file = self.state_root / ".generation"
        tmp_file = self.state_root / ".generation.tmp"
        try:
            tmp_file.write_text(str(nxt), encoding="utf-8")
            tmp_file.replace(gen_file)
        except Exception as e:
            raise IOError(f"Failed to bump .generation file: {e}")
        return nxt

    def _get_revision(self) -> int:
        rev_file = self.state_root / ".revision"
        if not rev_file.is_file():
            return 0
        try:
            val = int(rev_file.read_text(encoding="utf-8").strip())
            if val < 0:
                raise ValueError("Negative revision")
            return val
        except Exception as e:
            raise ValueError(f"Corrupt .revision file in {self.state_root}: {e}")

    def _bump_revision(self) -> int:
        self._mark_mutated()
        rev = self._get_revision() + 1
        rev_file = self.state_root / ".revision"
        tmp_file = self.state_root / ".revision.tmp"
        try:
            tmp_file.write_text(str(rev), encoding="utf-8")
            tmp_file.replace(rev_file)
        except Exception as e:
            raise IOError(f"Failed to bump .revision file: {e}")
        return rev

    def _lock_dir(self, resource: str) -> Path:
        valid_res = validate_resource_name(resource)
        return self.state_root / f"{valid_res}.lock"

    def _metadata_path(self, lock_dir: Path) -> Path:
        return lock_dir / "metadata.json"

    def _handoff_path(self, lock_dir: Path) -> Path:
        return lock_dir / "handoff.json"

    def _queue_path(self, lock_dir: Path) -> Path:
        return lock_dir / "queue.json"

    def _read_metadata(self, lock_dir: Path) -> Tuple[bool, Optional[Dict[str, Any]]]:
        """Read and validate metadata JSON inside a lock directory."""
        meta_file = self._metadata_path(lock_dir)
        if not meta_file.is_file():
            return False, None
        try:
            with open(meta_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and isinstance(data.get("session_id"), str) and data["session_id"].strip():
                if "legacy" in data and type(data["legacy"]) is not bool:
                    return False, None
                # Only the original pre-LAN shape or an explicit migrated legacy
                # record may use legacy release. Lost modern credentials are corruption.
                original_legacy = not any(key in data for key in ("instance_id", "token", "generation", "legacy"))
                if original_legacy:
                    data["instance_id"] = DEFAULT_INSTANCE_ID
                    data["instance_label"] = DEFAULT_INSTANCE_LABEL
                    data["legacy"] = True
                elif data.get("legacy") is not True:
                    if not isinstance(data.get("instance_id"), str) or not data["instance_id"]:
                        return False, None
                    if not isinstance(data.get("token"), str) or not data["token"] or type(data.get("generation")) is not int or data["generation"] <= 0:
                        return False, None
                return True, data
            return False, None
        except Exception:
            return False, None

    def _write_metadata(self, lock_dir: Path, data: Dict[str, Any]) -> None:
        self._mark_mutated()
        tmp_file = lock_dir / "metadata.json.tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, self._metadata_path(lock_dir))

    def _read_handoff(self, lock_dir: Path) -> Tuple[bool, Optional[Dict[str, Any]]]:
        h_file = self._handoff_path(lock_dir)
        if not h_file.is_file():
            return False, None
        try:
            with open(h_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            if (
                isinstance(data, dict)
                and isinstance(data.get("handoff_id"), str) and data["handoff_id"]
                and isinstance(data.get("token"), str) and data["token"]
                and isinstance(data.get("session_id"), str) and data["session_id"]
                and isinstance(data.get("instance_id"), str) and data["instance_id"]
                and type(data.get("generation")) is int and data["generation"] > 0
                and isinstance(data.get("resume_task"), str)
            ):
                return True, data
            return False, None
        except Exception:
            return False, None

    def _write_handoff(self, lock_dir: Path, data: Dict[str, Any]) -> None:
        self._mark_mutated()
        tmp_file = lock_dir / "handoff.json.tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, self._handoff_path(lock_dir))

    def _read_queue(self, lock_dir: Path) -> List[Dict[str, Any]]:
        q_file = self._queue_path(lock_dir)
        if not q_file.exists():
            return []
        if not q_file.is_file():
            raise ValueError("Corrupt queue.json: expected an ordinary state file, not a directory")
        try:
            with open(q_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            raise ValueError(f"Corrupt queue.json in {lock_dir}: {e}")
        if not isinstance(data, list):
            raise ValueError(
                f"Corrupt queue.json in {lock_dir}: expected list, got {type(data).__name__}"
            )
        for idx, item in enumerate(data):
            if not isinstance(item, dict) or not isinstance(item.get("session_id"), str) or not item["session_id"] or not isinstance(item.get("instance_id"), str) or not item["instance_id"] or not isinstance(item.get("queue_id"), str) or not item["queue_id"] or type(item.get("sequence")) is not int or item["sequence"] != idx + 1 or not isinstance(item.get("resume_task"), str):
                raise ValueError(
                    f"Corrupt queue entry at index {idx} in {q_file}: invalid structure"
                )
        return data

    def _write_queue(self, lock_dir: Path, queue: List[Dict[str, Any]]) -> None:
        self._mark_mutated()
        tmp_file = lock_dir / "queue.json.tmp"
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(queue, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_file, self._queue_path(lock_dir))

    def _clean_lock_dir(self, lock_dir: Path) -> None:
        """Safely clean lock directory if empty of business state."""
        self._mark_mutated()
        for fname in [
            "metadata.json",
            "handoff.json",
            "queue.json",
            "metadata.json.tmp",
            "handoff.json.tmp",
            "queue.json.tmp",
        ]:
            p = lock_dir / fname
            if p.exists():
                try:
                    p.unlink()
                except Exception:
                    pass
        try:
            lock_dir.rmdir()
        except Exception:
            pass

    def _check_hold_and_wait(
        self, requesting_res: str, session_id: str, instance_id: str
    ) -> None:
        """Reject hold-and-wait deadlock attempt if session already holds another resource."""
        if not self.state_root.is_dir():
            return
        for item in self.state_root.iterdir():
            if (
                item.is_dir()
                and item.name.endswith(".lock")
                and item.name != ".txn.lock"
            ):
                res_name = item.name[:-5]
                if res_name == requesting_res:
                    continue
                pending_handoff_valid, pending_handoff = self._read_handoff(item)
                pending_queue = self._read_queue(item)
                if (pending_handoff_valid and pending_handoff and pending_handoff.get("session_id") == session_id and pending_handoff.get("instance_id") == instance_id) or any(waiter.get("session_id") == session_id and waiter.get("instance_id") == instance_id for waiter in pending_queue):
                    raise ValueError("Another Odoo wait/handoff must settle before entering a second conflicting queue")
                valid_meta, meta = self._read_metadata(item)
                if valid_meta and meta:
                    m_sid = meta.get("session_id")
                    m_iid = meta.get("instance_id") or DEFAULT_INSTANCE_ID
                    if m_sid == session_id and m_iid == instance_id:
                        raise ValueError(
                            f"Hold-and-wait rejected: session already holds resource '{res_name}', cannot queue for '{requesting_res}'"
                        )

    def acquire(
        self,
        resource: str,
        session_id: str,
        title: Optional[str] = None,
        owner_pid: Optional[int] = None,
        host: Optional[str] = None,
        source_root: Optional[str] = None,
        instance_id: Optional[str] = None,
        instance_label: Optional[str] = None,
        resume_task: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> Tuple[str, str, Dict[str, Any]]:
        """Acquire lock atomically. Returns (status, message, data). status: 'acquired' | 'queued'."""
        valid_res = validate_resource_name(resource)
        if not session_id or not str(session_id).strip():
            raise ValueError("session_id is required to acquire lock")

        inst_id = instance_id or self.instance_id
        inst_lbl = instance_label or self.instance_label

        with self._transaction():
            lock_dir = self._lock_dir(valid_res)
            preexisting = lock_dir.exists()
            lock_dir.mkdir(parents=True, exist_ok=True)

            valid_meta, meta = self._read_metadata(lock_dir)
            valid_h, handoff = self._read_handoff(lock_dir)
            queue = self._read_queue(lock_dir)

            if valid_meta and meta:
                # 已处于 held 状态
                m_sid = meta.get("session_id")
                m_iid = meta.get("instance_id") or DEFAULT_INSTANCE_ID
                if m_sid == session_id and m_iid == inst_id:
                    # 同 session 同 instance 幂等获取
                    return (
                        "acquired",
                        "Lock already acquired by current session (idempotent)",
                        meta,
                    )

                # 产生冲突：检查 Hold-and-wait 死锁防范
                self._check_hold_and_wait(valid_res, session_id, inst_id)

                # 检查是否已在队列中
                for q_item in queue:
                    if (
                        q_item.get("session_id") == session_id
                        and q_item.get("instance_id") == inst_id
                    ):
                        return (
                            "queued",
                            f"Already in queue at position {q_item.get('sequence', 1)}",
                            q_item,
                        )

                # 追加进 FIFO 队列
                q_id = f"q-{uuid.uuid4().hex[:12]}"
                seq = len(queue) + 1
                q_entry = {
                    "resource": valid_res,
                    "queue_id": q_id,
                    "sequence": seq,
                    "session_id": session_id,
                    "title": resolve_session_title(session_id, title),
                    "host": resolve_host(host),
                    "owner_pid": resolve_owner_pid(owner_pid),
                    "instance_id": inst_id,
                    "instance_label": inst_lbl,
                    "resume_task": str(resume_task or "continue task"),
                    "reason": str(reason or ""),
                    "source_root": str(source_root or "/workspace/odoo"),
                    "enqueued_at": _now_iso(),
                }
                queue.append(q_entry)
                self._write_queue(lock_dir, queue)
                self._bump_revision()
                return (
                    "queued",
                    f"Contended: enqueued at position {seq}",
                    q_entry,
                )

            elif valid_h and handoff:
                # 处于 handoff 状态
                h_sid = handoff.get("session_id")
                h_iid = handoff.get("instance_id")
                if h_sid == session_id and h_iid == inst_id:
                    return (
                        "queued",
                        "Resource is reserved for current session in handoff, please ack",
                        handoff,
                    )

                self._check_hold_and_wait(valid_res, session_id, inst_id)

                for q_item in queue:
                    if (
                        q_item.get("session_id") == session_id
                        and q_item.get("instance_id") == inst_id
                    ):
                        return (
                            "queued",
                            f"Already in queue at position {q_item.get('sequence', 1)}",
                            q_item,
                        )

                q_id = f"q-{uuid.uuid4().hex[:12]}"
                seq = len(queue) + 1
                q_entry = {
                    "resource": valid_res,
                    "queue_id": q_id,
                    "sequence": seq,
                    "session_id": session_id,
                    "title": resolve_session_title(session_id, title),
                    "host": resolve_host(host),
                    "owner_pid": resolve_owner_pid(owner_pid),
                    "instance_id": inst_id,
                    "instance_label": inst_lbl,
                    "resume_task": str(resume_task or "continue task"),
                    "reason": str(reason or ""),
                    "source_root": str(source_root or "/workspace/odoo"),
                    "enqueued_at": _now_iso(),
                }
                queue.append(q_entry)
                self._write_queue(lock_dir, queue)
                self._bump_revision()
                return (
                    "queued",
                    f"Contended (handoff active): enqueued at position {seq}",
                    q_entry,
                )

            else:
                # 既无有效 metadata 也无有效 handoff
                # 检查是否存在损坏文件：fail-closed
                if (lock_dir / "metadata.json").exists():
                    raise ValueError(
                        "Blocked: lock directory exists but metadata is corrupt (fail-closed)"
                    )
                if (lock_dir / "handoff.json").exists():
                    raise ValueError(
                        "Blocked: lock directory exists but handoff is corrupt (fail-closed)"
                    )

                if preexisting:
                    raise ValueError("Blocked: pre-existing lock directory has no certified owner/handoff (fail-closed)")
                # 当前为空闲状态，直接获取 held 锁
                token = uuid.uuid4().hex
                gen = self._next_generation()
                resolved_title = resolve_session_title(session_id, title)
                resolved_pid = resolve_owner_pid(owner_pid)
                resolved_host = resolve_host(host)

                meta_data = {
                    "resource": valid_res,
                    "session_id": session_id,
                    "title": resolved_title,
                    "host": resolved_host,
                    "owner_pid": resolved_pid,
                    "created": _now_iso(),
                    "source_root": str(source_root or "/workspace/odoo"),
                    "instance_id": inst_id,
                    "instance_label": inst_lbl,
                    "token": token,
                    "generation": gen,
                    "legacy": False,
                }
                self._write_metadata(lock_dir, meta_data)
                self._bump_revision()
                return "acquired", "Lock acquired successfully", meta_data

    def release(
        self,
        resource: str,
        session_id: str,
        instance_id: Optional[str] = None,
        token: Optional[str] = None,
        generation: Optional[int] = None,
    ) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        """Release lock safely. Non-owner release is strictly rejected."""
        valid_res = validate_resource_name(resource)
        if not session_id or not str(session_id).strip():
            raise ValueError("session_id is required to release lock")

        inst_id = instance_id or self.instance_id

        with self._transaction():
            lock_dir = self._lock_dir(valid_res)
            if not lock_dir.exists():
                return True, "Lock does not exist (already free)", None

            valid_meta, meta = self._read_metadata(lock_dir)
            if not valid_meta or not meta:
                return (
                    False,
                    "Refused: lock metadata missing or corrupt, cannot verify owner (fail-closed)",
                    None,
                )

            meta_sid = meta.get("session_id")
            meta_iid = meta.get("instance_id") or DEFAULT_INSTANCE_ID
            is_legacy = (
                meta.get("legacy", False)
                or not meta.get("instance_id")
                or not meta.get("token")
            )

            if is_legacy:
                # 兼容旧锁释放契约：同 instance 且同 SID 允许释放；foreign instance 同 SID 必须拒绝！
                if inst_id != meta_iid:
                    return (
                        False,
                        f"Refused: foreign instance '{inst_id}' with same session ID cannot release legacy lock",
                        None,
                    )
                if session_id != meta_sid:
                    return (
                        False,
                        f"Refused: lock is held by '{meta.get('title') or '未命名会话（标题尚未生成）'}', cannot release",
                        None,
                    )
            else:
                # 新锁：必须同时存在且精确匹配 instance + SID + token + generation
                if not token or str(token).strip() == "":
                    return (
                        False,
                        "Refused: token is required to release non-legacy lock",
                        None,
                    )
                if generation is None:
                    return (
                        False,
                        "Refused: generation is required to release non-legacy lock",
                        None,
                    )
                try:
                    gen_int = int(generation)
                except (ValueError, TypeError):
                    return (
                        False,
                        "Refused: invalid generation format",
                        None,
                    )

                if inst_id != meta_iid:
                    return (
                        False,
                        f"Refused: lock belongs to instance '{meta_iid}', not '{inst_id}'",
                        None,
                    )
                if session_id != meta_sid:
                    return (
                        False,
                        f"Refused: lock is held by session '{meta_sid}'",
                        None,
                    )
                if str(token).strip() != str(meta.get("token", "")).strip():
                    return False, "Refused: token mismatch", None
                if gen_int != int(meta.get("generation", 0)):
                    return (
                        False,
                        f"Refused: generation mismatch (expected {meta.get('generation')}, got {gen_int})",
                        None,
                    )

            # 释放成功：检查队列调度 handoff
            try:
                queue = self._read_queue(lock_dir)
            except Exception as e:
                return (
                    False,
                    f"Refused: lock queue is corrupt ({e}), fail-closed to prevent queue loss",
                    None,
                )

            if queue:
                next_item = queue.pop(0)
                for i, q in enumerate(queue):
                    q["sequence"] = i + 1
                self._write_queue(lock_dir, queue)

                new_handoff_id = f"h-{uuid.uuid4().hex[:12]}"
                new_token = f"t-{uuid.uuid4().hex[:16]}"
                new_generation = self._next_generation()
                handoff_data = {
                    "resource": valid_res,
                    "handoff_id": new_handoff_id,
                    "token": new_token,
                    "generation": new_generation,
                    "session_id": next_item["session_id"],
                    "title": next_item.get("title", ""),
                    "host": next_item.get("host", ""),
                    "owner_pid": next_item.get("owner_pid", 0),
                    "instance_id": next_item.get("instance_id", DEFAULT_INSTANCE_ID),
                    "instance_label": next_item.get(
                        "instance_label", DEFAULT_INSTANCE_LABEL
                    ),
                    "resume_task": next_item.get("resume_task", ""),
                    "source_root": next_item.get("source_root", "/workspace/odoo"),
                    "created_at": _now_iso(),
                }
                self._write_handoff(lock_dir, handoff_data)

                # 删除旧 metadata.json
                meta_file = self._metadata_path(lock_dir)
                if meta_file.exists():
                    self._mark_mutated()
                    meta_file.unlink()

                self._bump_revision()
                return (
                    True,
                    f"Lock released and handoff scheduled for session '{next_item['session_id']}'",
                    handoff_data,
                )
            else:
                # 队列为空，彻底释放清理目录
                self._clean_lock_dir(lock_dir)
                self._bump_revision()
                return True, "Lock released successfully", None

    def ack(
        self,
        resource: str,
        session_id: str,
        instance_id: Optional[str] = None,
        handoff_id: Optional[str] = None,
        token: Optional[str] = None,
        generation: Optional[int] = None,
    ) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        """Acknowledge handoff and transition lock to held."""
        valid_res = validate_resource_name(resource)
        if not session_id or not str(session_id).strip():
            raise ValueError("session_id is required to ack handoff")

        if not handoff_id or str(handoff_id).strip() == "":
            return False, "Refused: handoff_id is required to ack handoff", None
        if not token or str(token).strip() == "":
            return False, "Refused: token is required to ack handoff", None
        if generation is None:
            return False, "Refused: generation is required to ack handoff", None
        try:
            gen_int = int(generation)
        except (ValueError, TypeError):
            return False, "Refused: invalid generation format", None

        inst_id = instance_id or self.instance_id

        with self._transaction():
            lock_dir = self._lock_dir(valid_res)
            if not lock_dir.exists():
                return False, "Resource is not locked or in handoff state", None

            valid_h, handoff = self._read_handoff(lock_dir)
            if not valid_h or not handoff:
                return False, "Resource is not in handoff state", None

            if handoff.get("handoff_id") != handoff_id:
                return (
                    False,
                    f"Handoff ID mismatch: expected '{handoff.get('handoff_id')}', got '{handoff_id}'",
                    None,
                )

            if handoff.get("token") != token:
                return False, "Handoff token mismatch", None

            if int(handoff.get("generation", 0)) != gen_int:
                return (
                    False,
                    f"Handoff generation mismatch: expected {handoff.get('generation')}, got {gen_int}",
                    None,
                )

            if handoff.get("session_id") != session_id:
                return (
                    False,
                    f"Handoff target session mismatch: expected '{handoff.get('session_id')}', got '{session_id}'",
                    None,
                )

            if handoff.get("instance_id") != inst_id:
                return (
                    False,
                    f"Handoff target instance mismatch: expected '{handoff.get('instance_id')}', got '{inst_id}'",
                    None,
                )

            # 转换为 held 状态
            meta = {
                "resource": valid_res,
                "session_id": handoff["session_id"],
                "title": handoff.get("title", ""),
                "host": handoff.get("host", ""),
                "owner_pid": handoff.get("owner_pid", 0),
                "created": _now_iso(),
                "source_root": handoff.get("source_root", "/workspace/odoo"),
                "instance_id": handoff["instance_id"],
                "instance_label": handoff.get("instance_label", ""),
                "token": handoff["token"],
                "generation": handoff["generation"],
                "legacy": False,
            }
            self._write_metadata(lock_dir, meta)

            h_file = self._handoff_path(lock_dir)
            if h_file.exists():
                self._mark_mutated()
                h_file.unlink()

            self._bump_revision()
            return True, "Handoff acknowledged and converted to held", meta

    def cancel(
        self,
        resource: str,
        session_id: str,
        instance_id: Optional[str] = None,
        queue_id: Optional[str] = None,
        handoff_id: Optional[str] = None,
    ) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        """Cancel queued wait or unaccepted handoff only. NEVER cancels held business locks."""
        valid_res = validate_resource_name(resource)
        if not session_id or not str(session_id).strip():
            raise ValueError("session_id is required to cancel")

        inst_id = instance_id or self.instance_id

        with self._transaction():
            lock_dir = self._lock_dir(valid_res)
            if not lock_dir.exists():
                return False, "Resource lock directory does not exist", None

            valid_meta, meta = self._read_metadata(lock_dir)
            valid_h, handoff = self._read_handoff(lock_dir)
            queue = self._read_queue(lock_dir)

            # 1. 尝试从 queue 中取消
            target_q_idx = -1
            for idx, q_item in enumerate(queue):
                if handoff_id or q_item.get("session_id") != session_id or q_item.get("instance_id") != inst_id:
                    continue
                if queue_id and q_item.get("queue_id") == queue_id:
                    target_q_idx = idx
                    break
                elif not queue_id:
                    target_q_idx = idx
                    break

            if target_q_idx >= 0:
                removed_q = queue.pop(target_q_idx)
                for i, q in enumerate(queue):
                    q["sequence"] = i + 1
                self._write_queue(lock_dir, queue)
                if not valid_meta and not valid_h and not queue:
                    self._clean_lock_dir(lock_dir)
                self._bump_revision()
                return (
                    True,
                    f"Cancelled queue entry {removed_q.get('queue_id')}",
                    removed_q,
                )

            # 2. 检查是否取消未确认的 handoff
            if valid_h and handoff:
                target_match = False
                target_match = (
                    not queue_id
                    and handoff.get("session_id") == session_id
                    and handoff.get("instance_id") == inst_id
                    and (not handoff_id or handoff.get("handoff_id") == handoff_id)
                )

                if target_match:
                    h_file = self._handoff_path(lock_dir)
                    if h_file.exists():
                        self._mark_mutated()
                        h_file.unlink()

                    if queue:
                        next_item = queue.pop(0)
                        for i, q in enumerate(queue):
                            q["sequence"] = i + 1
                        self._write_queue(lock_dir, queue)

                        new_handoff_id = f"h-{uuid.uuid4().hex[:12]}"
                        new_token = f"t-{uuid.uuid4().hex[:16]}"
                        new_generation = self._next_generation()
                        next_handoff = {
                            "resource": valid_res,
                            "handoff_id": new_handoff_id,
                            "token": new_token,
                            "generation": new_generation,
                            "session_id": next_item["session_id"],
                            "title": next_item.get("title", ""),
                            "host": next_item.get("host", ""),
                            "owner_pid": next_item.get("owner_pid", 0),
                            "instance_id": next_item.get(
                                "instance_id", DEFAULT_INSTANCE_ID
                            ),
                            "instance_label": next_item.get(
                                "instance_label", DEFAULT_INSTANCE_LABEL
                            ),
                            "resume_task": next_item.get("resume_task", ""),
                            "source_root": next_item.get(
                                "source_root", "/workspace/odoo"
                            ),
                            "created_at": _now_iso(),
                        }
                        self._write_handoff(lock_dir, next_handoff)
                        self._bump_revision()
                        return (
                            True,
                            f"Cancelled handoff and scheduled next waiter '{next_item['session_id']}'",
                            next_handoff,
                        )
                    else:
                        if not valid_meta:
                            self._clean_lock_dir(lock_dir)
                        self._bump_revision()
                        return True, "Cancelled handoff (no more waiters)", None

            # 3. 如果当前处于 held 状态：绝对禁止取消业务持锁！
            if valid_meta and meta:
                return (
                    False,
                    "Cannot cancel held business lock; release must be used instead",
                    None,
                )

            return False, "No matching queue or handoff found to cancel", None

    def get_snapshot(self) -> Dict[str, Any]:
        """Produce full OdooLanSnapshot matching OdooLanSnapshot TypeScript interface under transaction protection."""
        with self._transaction():
            resources: List[Dict[str, Any]] = []
            if self.state_root.is_dir():
                for item in sorted(self.state_root.iterdir()):
                    if (
                        item.is_dir()
                        and item.name.endswith(".lock")
                        and item.name != ".txn.lock"
                    ):
                        res_name = item.name[:-5]
                        valid_meta, meta = self._read_metadata(item)
                        valid_h, handoff = self._read_handoff(item)
                        try:
                            queue = self._read_queue(item)
                        except Exception as q_err:
                            resources.append(
                                {
                                    "resource": res_name,
                                    "status": "unknown",
                                    "queue": [],
                                    "error": f"queue corrupt: {q_err}",
                                }
                            )
                            continue

                        queue_dtos = []
                        for q in queue:
                            queue_dtos.append(
                                {
                                    "sessionId": q.get("session_id", ""),
                                    "sessionName": q.get("title", ""),
                                    "ownerPid": q.get("owner_pid", 0),
                                    "sourceRoot": q.get("source_root"),
                                    "instanceId": q.get("instance_id", DEFAULT_INSTANCE_ID),
                                    "instanceLabel": q.get(
                                        "instance_label", DEFAULT_INSTANCE_LABEL
                                    ),
                                    "queueId": q.get("queue_id", ""),
                                    "sequence": q.get("sequence", 0),
                                    "resumeTask": q.get("resume_task", ""),
                                    "reason": q.get("reason"),
                                    "enqueuedAt": q.get("enqueued_at", ""),
                                }
                            )

                        if valid_meta and meta:
                            owner_dto = {
                                "sessionId": meta.get("session_id", ""),
                                "sessionName": meta.get("title", ""),
                                "ownerPid": meta.get("owner_pid", 0),
                                "sourceRoot": meta.get("source_root"),
                                "instanceId": meta.get("instance_id")
                                or DEFAULT_INSTANCE_ID,
                                "instanceLabel": meta.get("instance_label")
                                or DEFAULT_INSTANCE_LABEL,
                                "token": meta.get("token"),
                                "generation": meta.get("generation"),
                                "legacy": bool(
                                    meta.get("legacy", False)
                                    or not meta.get("instance_id")
                                    or not meta.get("token")
                                ),
                            }
                            resources.append(
                                {
                                    "resource": res_name,
                                    "status": "held",
                                    "owner": owner_dto,
                                    "queue": queue_dtos,
                                }
                            )
                        elif valid_h and handoff:
                            handoff_dto = {
                                "sessionId": handoff.get("session_id", ""),
                                "sessionName": handoff.get("title", ""),
                                "ownerPid": handoff.get("owner_pid", 0),
                                "sourceRoot": handoff.get("source_root"),
                                "instanceId": handoff.get(
                                    "instance_id", DEFAULT_INSTANCE_ID
                                ),
                                "instanceLabel": handoff.get(
                                    "instance_label", DEFAULT_INSTANCE_LABEL
                                ),
                                "token": handoff.get("token", ""),
                                "generation": handoff.get("generation", 1),
                                "handoffId": handoff.get("handoff_id", ""),
                                "resumeTask": handoff.get("resume_task", ""),
                                "createdAt": handoff.get("created_at", ""),
                            }
                            resources.append(
                                {
                                    "resource": res_name,
                                    "status": "handoff",
                                    "handoff": handoff_dto,
                                    "queue": queue_dtos,
                                }
                            )
                        else:
                            if (item / "metadata.json").exists() or (
                                item / "handoff.json"
                            ).exists():
                                resources.append(
                                    {
                                        "resource": res_name,
                                        "status": "unknown",
                                        "queue": queue_dtos,
                                        "error": "metadata or handoff file corrupt",
                                    }
                                )
                            elif queue:
                                resources.append(
                                    {
                                        "resource": res_name,
                                        "status": "unknown",
                                        "queue": queue_dtos,
                                        "error": "queue exists but neither owner nor handoff present",
                                    }
                                )

            return {
                "protocol": PROTOCOL_VERSION,
                "version": 1,
                "revision": self._get_revision(),
                "updatedAt": _now_iso(),
                "resources": resources,
            }

    def status(
        self, resource: Optional[str] = None, current_session: Optional[str] = None
    ) -> Dict[str, Any]:
        """Check status of a single resource or all active locks (legacy CLI view)."""
        if resource:
            valid_res = validate_resource_name(resource)
            lock_dir = self._lock_dir(valid_res)
            if not lock_dir.exists():
                return {
                    "resource": valid_res,
                    "status": "free",
                    "locked": False,
                }
            valid_meta, meta = self._read_metadata(lock_dir)
            valid_h, handoff = self._read_handoff(lock_dir)
            queue = self._read_queue(lock_dir)

            if valid_meta and meta:
                is_owner = (
                    (meta.get("session_id") == current_session)
                    if current_session
                    else False
                )
                return {
                    "resource": valid_res,
                    "status": "locked",
                    "locked": True,
                    "is_owner": is_owner,
                    "metadata": meta,
                    "queue_length": len(queue),
                }
            elif valid_h and handoff:
                return {
                    "resource": valid_res,
                    "status": "handoff",
                    "locked": True,
                    "handoff": handoff,
                    "queue_length": len(queue),
                }
            return {
                "resource": valid_res,
                "status": "unknown",
                "locked": True,
                "blocked": True,
                "error": "lock directory exists but metadata missing or corrupt",
            }

        results: List[Dict[str, Any]] = []
        if self.state_root.is_dir():
            for item in sorted(self.state_root.iterdir()):
                if (
                    item.is_dir()
                    and item.name.endswith(".lock")
                    and item.name != ".txn.lock"
                ):
                    res_name = item.name[:-5]
                    valid_meta, meta = self._read_metadata(item)
                    valid_h, handoff = self._read_handoff(item)
                    queue = self._read_queue(item)
                    if valid_meta and meta:
                        is_owner = (
                            (meta.get("session_id") == current_session)
                            if current_session
                            else False
                        )
                        results.append(
                            {
                                "resource": res_name,
                                "status": "locked",
                                "locked": True,
                                "is_owner": is_owner,
                                "metadata": meta,
                                "queue_length": len(queue),
                            }
                        )
                    elif valid_h and handoff:
                        results.append(
                            {
                                "resource": res_name,
                                "status": "handoff",
                                "locked": True,
                                "handoff": handoff,
                                "queue_length": len(queue),
                            }
                        )
                    else:
                        results.append(
                            {
                                "resource": res_name,
                                "status": "unknown",
                                "locked": True,
                                "blocked": True,
                                "error": "metadata missing or corrupt",
                            }
                        )
        return {
            "state_root": str(self.state_root),
            "locks": results,
            "total_locked": len(results),
        }


def run_serve(manager: AddonLockManager) -> None:
    """Run persistent JSON-lines stdio server."""
    out_lock = threading.Lock()

    def send_line(obj: Dict[str, Any]) -> None:
        raw = json.dumps(obj, ensure_ascii=False)
        data = (raw + "\n").encode("utf-8")
        if len(data) > FRAME_LIMIT_BYTES:
            err_resp = {
                "id": obj.get("id"),
                "ok": False,
                "error": "Frame size exceeds 1MiB limit",
            }
            data = (json.dumps(err_resp, ensure_ascii=False) + "\n").encode("utf-8")
        with out_lock:
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()

    last_rev = manager._get_revision()
    stop_event = threading.Event()

    def monitor_thread() -> None:
        nonlocal last_rev
        while not stop_event.is_set():
            time.sleep(0.15)
            try:
                curr_rev = manager._get_revision()
                if curr_rev != last_rev:
                    last_rev = curr_rev
                    snap = manager.get_snapshot()
                    send_line({"event": "changed", "snapshot": snap})
            except Exception:
                pass

    t = threading.Thread(target=monitor_thread, daemon=True)
    t.start()

    try:
        while True:
            line_bytes = sys.stdin.buffer.readline()
            if not line_bytes:
                break
            if len(line_bytes) > FRAME_LIMIT_BYTES:
                send_line(
                    {
                        "id": None,
                        "ok": False,
                        "error": "Incoming frame exceeds 1MiB limit",
                    }
                )
                continue
            line = line_bytes.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except Exception as e:
                send_line({"id": None, "ok": False, "error": f"Invalid JSON line: {e}"})
                continue

            req_id = msg.get("id")
            cmd = msg.get("command") or {}
            action = cmd.get("action")

            actor = cmd.get("actor") or {}
            # Trusted startup instance overrides incoming payload
            inst_id = manager.instance_id
            inst_lbl = manager.instance_label

            sid = actor.get("sessionId")
            sname = actor.get("sessionName")
            pid = actor.get("ownerPid")
            sroot = actor.get("sourceRoot")

            try:
                if action == "status":
                    snap = manager.get_snapshot()
                    send_line({"id": req_id, "ok": True, "result": snap})
                elif action == "acquire":
                    res = cmd.get("resource")
                    if not res:
                        raise ValueError("resource is required for acquire")
                    if not sid:
                        raise ValueError("actor.sessionId is required for acquire")
                    status_val, msg_val, data_val = manager.acquire(
                        resource=res,
                        session_id=sid,
                        title=sname,
                        owner_pid=pid,
                        source_root=sroot,
                        instance_id=inst_id,
                        instance_label=inst_lbl,
                        resume_task=cmd.get("resumeTask") or DEFAULT_RESUME_TASK,
                        reason=cmd.get("reason"),
                    )
                    snap = manager.get_snapshot()
                    last_rev = manager._get_revision()
                    result_payload: Dict[str, Any] = {
                        "status": status_val,
                        "resource": res,
                        "snapshot": snap,
                    }
                    if status_val == "acquired":
                        result_payload["token"] = data_val.get("token")
                        result_payload["generation"] = data_val.get("generation")
                        result_payload["legacy"] = data_val.get("legacy", False)
                    elif status_val == "queued":
                        result_payload["queueId"] = data_val.get("queue_id")
                        result_payload["position"] = data_val.get("sequence")
                    send_line({"id": req_id, "ok": True, "result": result_payload})
                elif action == "release":
                    res = cmd.get("resource")
                    if not res:
                        raise ValueError("resource is required for release")
                    if not sid:
                        raise ValueError("actor.sessionId is required for release")
                    ok, msg_val, h_data = manager.release(
                        resource=res,
                        session_id=sid,
                        instance_id=inst_id,
                        token=cmd.get("token"),
                        generation=cmd.get("generation"),
                    )
                    if not ok:
                        send_line({"id": req_id, "ok": False, "error": msg_val})
                    else:
                        snap = manager.get_snapshot()
                        last_rev = manager._get_revision()
                        send_line(
                            {
                                "id": req_id,
                                "ok": True,
                                "result": {
                                    "status": "released",
                                    "resource": res,
                                    "snapshot": snap,
                                },
                            }
                        )
                elif action == "ack":
                    res = cmd.get("resource")
                    if not res:
                        raise ValueError("resource is required for ack")
                    if not sid:
                        raise ValueError("actor.sessionId is required for ack")
                    hid = cmd.get("handoffId")
                    tok = cmd.get("token")
                    gen = cmd.get("generation")
                    ok, msg_val, m_data = manager.ack(
                        resource=res,
                        session_id=sid,
                        instance_id=inst_id,
                        handoff_id=hid,
                        token=tok,
                        generation=gen,
                    )
                    if not ok:
                        send_line({"id": req_id, "ok": False, "error": msg_val})
                    else:
                        snap = manager.get_snapshot()
                        last_rev = manager._get_revision()
                        send_line(
                            {
                                "id": req_id,
                                "ok": True,
                                "result": {
                                    "status": "acknowledged",
                                    "resource": res,
                                    "token": m_data.get("token") if m_data else tok,
                                    "generation": m_data.get("generation")
                                    if m_data
                                    else gen,
                                    "snapshot": snap,
                                },
                            }
                        )
                elif action == "cancel":
                    res = cmd.get("resource")
                    if not res:
                        raise ValueError("resource is required for cancel")
                    if not sid:
                        raise ValueError("actor.sessionId is required for cancel")
                    qid = cmd.get("queueId")
                    hid = cmd.get("handoffId")
                    ok, msg_val, c_data = manager.cancel(
                        resource=res,
                        session_id=sid,
                        instance_id=inst_id,
                        queue_id=qid,
                        handoff_id=hid,
                    )
                    if not ok:
                        send_line({"id": req_id, "ok": False, "error": msg_val})
                    else:
                        snap = manager.get_snapshot()
                        last_rev = manager._get_revision()
                        send_line(
                            {
                                "id": req_id,
                                "ok": True,
                                "result": {
                                    "status": "cancelled",
                                    "resource": res,
                                    "queueId": qid
                                    or (c_data.get("queue_id") if c_data else None),
                                    "snapshot": snap,
                                },
                            }
                        )
                else:
                    send_line(
                        {
                            "id": req_id,
                            "ok": False,
                            "error": f"Unknown action: '{action}'",
                        }
                    )
            except Exception as e:
                send_line({"id": req_id, "ok": False, "error": str(e)})
    finally:
        stop_event.set()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Cooperative lock CLI for Odoo addon source writing and deployments"
    )
    parser.add_argument(
        "--state-root",
        dest="state_root",
        default=None,
        help="Custom state root directory for addon locks",
    )
    parser.add_argument(
        "--session",
        dest="session_id",
        default=None,
        help="Session ID (defaults to PI_SESSION_ID env)",
    )
    parser.add_argument(
        "--instance-id",
        dest="instance_id",
        default=DEFAULT_INSTANCE_ID,
        help="Instance identity (e.g. synology:30141)",
    )
    parser.add_argument(
        "--instance-label",
        dest="instance_label",
        default=DEFAULT_INSTANCE_LABEL,
        help="Human-readable instance label (e.g. 群晖30141)",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output in JSON format",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    # status
    p_status = subparsers.add_parser("status", help="Query lock status")
    p_status.add_argument(
        "resource", nargs="?", help="Resource or addon name (optional)"
    )
    p_status.add_argument("--json", action="store_true", help="Output in JSON format")

    # acquire
    p_acquire = subparsers.add_parser("acquire", help="Acquire a lock atomically")
    p_acquire.add_argument(
        "resource", help="Resource or addon name (e.g., kx_srm, test-deployment)"
    )
    p_acquire.add_argument("--title", help="Human readable session title")
    p_acquire.add_argument("--pid", type=int, help="Owner PID")
    p_acquire.add_argument("--host", help="Hostname")
    p_acquire.add_argument("--source-root", help="Odoo addon source root directory")
    p_acquire.add_argument("--resume-task", help="Resume task description on handoff")
    p_acquire.add_argument("--reason", help="Acquire or queue reason")
    p_acquire.add_argument("--json", action="store_true", help="Output in JSON format")

    # release
    p_release = subparsers.add_parser("release", help="Release an existing lock")
    p_release.add_argument("resource", help="Resource or addon name")
    p_release.add_argument("--token", help="Lock token")
    p_release.add_argument("--generation", type=int, help="Lock generation")
    p_release.add_argument("--json", action="store_true", help="Output in JSON format")

    # ack
    p_ack = subparsers.add_parser("ack", help="Acknowledge handoff to held")
    p_ack.add_argument("resource", help="Resource or addon name")
    p_ack.add_argument("--handoff-id", help="Handoff ID")
    p_ack.add_argument("--token", help="Handoff token")
    p_ack.add_argument("--generation", type=int, help="Handoff generation")
    p_ack.add_argument("--json", action="store_true", help="Output in JSON format")

    # cancel
    p_cancel = subparsers.add_parser("cancel", help="Cancel queue wait or handoff")
    p_cancel.add_argument("resource", help="Resource or addon name")
    p_cancel.add_argument("--queue-id", help="Queue entry ID")
    p_cancel.add_argument("--handoff-id", help="Handoff ID")
    p_cancel.add_argument("--json", action="store_true", help="Output in JSON format")

    # serve
    p_serve = subparsers.add_parser("serve", help="Run persistent stdio server")
    p_serve.add_argument(
        "--instance-id",
        dest="instance_id",
        default=argparse.SUPPRESS,
        help="Override instance id",
    )
    p_serve.add_argument(
        "--instance-label",
        dest="instance_label",
        default=argparse.SUPPRESS,
        help="Override instance label",
    )
    p_serve.add_argument(
        "--state-root",
        dest="state_root",
        default=argparse.SUPPRESS,
        help="Override state root",
    )

    return parser


def run_client_cli_via_ssh(
    lan_config: Dict[str, Any], command: str, args: Any, session_id: Optional[str]
) -> int:
    """Execute a single CLI command through SSH stdio to the authoritative instance."""
    ssh_cfg = lan_config.get("ssh") or {}
    port = str(ssh_cfg.get("port", 22))
    identity_file = ssh_cfg.get("identityFile", "")
    user = ssh_cfg.get("user", "")
    host = ssh_cfg.get("host", "")
    container = ssh_cfg.get("container", "")
    authority_script = lan_config.get("authorityScript", "")

    inst_id = lan_config.get("instanceId", DEFAULT_INSTANCE_ID)
    inst_lbl = lan_config.get("instanceLabel", DEFAULT_INSTANCE_LABEL)

    ssh_bin = os.environ.get("ODOO_LAN_SSH_BIN", "ssh")

    ssh_cmd = [
        ssh_bin,
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=8",
        "-p",
        port,
        "-i",
        identity_file,
        f"{user}@{host}",
        "/usr/local/bin/docker",
        "exec",
        "-i",
        container,
        "python3",
        authority_script,
        "serve",
        "--instance-id",
        inst_id,
        "--instance-label",
        inst_lbl,
    ]

    if lan_config.get("stateRoot"):
        ssh_cmd.extend(["--state-root", str(lan_config["stateRoot"])])
    cmd_payload: Dict[str, Any] = {"action": command}
    if command == "status":
        if getattr(args, "resource", None):
            cmd_payload["resource"] = args.resource
    elif command == "acquire":
        cmd_payload["resource"] = args.resource
        cmd_payload["actor"] = {
            "sessionId": session_id,
            "sessionName": resolve_session_title(
                session_id, getattr(args, "title", None)
            ),
            "ownerPid": resolve_owner_pid(getattr(args, "pid", None)),
            "sourceRoot": getattr(args, "source_root", None) or "/workspace/odoo",
        }
        if getattr(args, "resume_task", None):
            cmd_payload["resumeTask"] = args.resume_task
        if getattr(args, "reason", None):
            cmd_payload["reason"] = args.reason
    elif command == "release":
        cmd_payload["resource"] = args.resource
        cmd_payload["actor"] = {"sessionId": session_id}
        if getattr(args, "token", None):
            cmd_payload["token"] = args.token
        if getattr(args, "generation", None) is not None:
            cmd_payload["generation"] = args.generation
    elif command == "ack":
        cmd_payload["resource"] = args.resource
        cmd_payload["actor"] = {"sessionId": session_id}
        if getattr(args, "handoff_id", None):
            cmd_payload["handoffId"] = args.handoff_id
        if getattr(args, "token", None):
            cmd_payload["token"] = args.token
        if getattr(args, "generation", None) is not None:
            cmd_payload["generation"] = args.generation
    elif command == "cancel":
        cmd_payload["resource"] = args.resource
        cmd_payload["actor"] = {"sessionId": session_id}
        if getattr(args, "queue_id", None):
            cmd_payload["queueId"] = args.queue_id
        if getattr(args, "handoff_id", None):
            cmd_payload["handoffId"] = args.handoff_id

    req_msg = {"id": "cli-rpc-1", "command": cmd_payload}
    raw_req = json.dumps(req_msg, ensure_ascii=False) + "\n"

    try:
        proc = subprocess.Popen(
            ssh_cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
    except Exception as e:
        err_msg = f"Failed to execute SSH gateway transport ({ssh_bin}): {e}"
        if getattr(args, "json", False):
            print(json.dumps({"success": False, "error": err_msg}, ensure_ascii=False))
        else:
            print(f"[error] {err_msg}", file=sys.stderr)
        return 1

    try:
        proc.stdin.write(raw_req)
        proc.stdin.flush()
    except Exception as e:
        proc.kill()
        err_msg = f"Failed to send request to authoritative instance: {e}"
        if getattr(args, "json", False):
            print(json.dumps({"success": False, "error": err_msg}, ensure_ascii=False))
        else:
            print(f"[error] {err_msg}", file=sys.stderr)
        return 1

    resp_obj = None
    while True:
        line = proc.stdout.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            if parsed.get("id") == "cli-rpc-1":
                resp_obj = parsed
                break
        except Exception:
            continue

    try:
        proc.stdin.close()
        proc.terminate()
        proc.wait(timeout=2)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass

    is_json = getattr(args, "json", False)

    if not resp_obj:
        stderr_out = proc.stderr.read()
        err_msg = f"No response received from authoritative instance: {stderr_out.strip() or 'transport closed'}"
        if is_json:
            print(json.dumps({"success": False, "error": err_msg}, ensure_ascii=False))
        else:
            print(f"[error] {err_msg}", file=sys.stderr)
        return 1

    if not resp_obj.get("ok"):
        err_text = resp_obj.get("error", "Unknown command error")
        if is_json:
            print(json.dumps({"success": False, "error": err_text}, ensure_ascii=False))
        else:
            print(f"[REFUSED] {err_text}", file=sys.stderr)
        return 1

    result = resp_obj.get("result", {})
    if command == "acquire":
        status_val = result.get("status")
        if status_val == "acquired":
            if is_json:
                print(
                    json.dumps(
                        {
                            "success": True,
                            "message": "Lock acquired via LAN authority",
                            "metadata": result,
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                )
            else:
                print(f"[OK] Lock acquired via LAN authority -> {args.resource}")
                if result.get("token"):
                    print(f"Release credentials (own grant): token={result['token']} generation={result['generation']}")
            return 0
        elif status_val == "queued":
            if is_json:
                print(
                    json.dumps(
                        {
                            "success": False,
                            "queued": True,
                            "message": f"Contended: enqueued at position {result.get('position')}",
                            "queue": result,
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                )
            else:
                print(
                    f"[QUEUED] Contended: enqueued at position {result.get('position')} -> {args.resource} (queueId: {result.get('queueId')})",
                    file=sys.stderr,
                )
            return 75
        else:
            if is_json:
                print(
                    json.dumps(
                        {"success": False, "error": "Unexpected acquire status"},
                        ensure_ascii=False,
                    )
                )
            else:
                print("[BLOCKED] Unexpected acquire status", file=sys.stderr)
            return 1

    elif command == "release":
        if is_json:
            print(
                json.dumps(
                    {
                        "success": True,
                        "message": "Lock released via LAN authority",
                        "result": result,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print(f"[OK] Lock released via LAN authority -> {args.resource}")
        return 0

    elif command == "ack":
        if is_json:
            print(
                json.dumps(
                    {
                        "success": True,
                        "message": "Handoff acknowledged via LAN authority",
                        "metadata": result,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print(f"[OK] Handoff acknowledged via LAN authority -> {args.resource}")
        return 0

    elif command == "cancel":
        if is_json:
            print(
                json.dumps(
                    {
                        "success": True,
                        "message": "Cancelled via LAN authority",
                        "data": result,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        else:
            print(f"[OK] Cancelled via LAN authority -> {args.resource}")
        return 0

    elif command == "status":
        if is_json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            snap = (
                result
                if result.get("protocol") == PROTOCOL_VERSION
                else result.get("snapshot", {})
            )
            res_list = snap.get("resources", [])
            if getattr(args, "resource", None):
                target_r = next(
                    (r for r in res_list if r.get("resource") == args.resource), None
                )
                if not target_r:
                    print(f"[FREE] Resource '{args.resource}' is available.")
                else:
                    st = target_r.get("status")
                    if st == "held":
                        owner = target_r.get("owner", {})
                        owner_tag = (
                            " (current session)"
                            if session_id and owner.get("sessionId") == session_id
                            else ""
                        )
                        print(
                            f"[LOCKED] Resource '{args.resource}' is locked by {owner.get('sessionId')}{owner_tag}"
                        )
                        print(
                            f"         Instance: {owner.get('instanceLabel')} ({owner.get('instanceId')})"
                        )
                        print(f"         Title: {owner.get('sessionName')}")
                    elif st == "handoff":
                        h = target_r.get("handoff", {})
                        print(
                            f"[HANDOFF] Resource '{args.resource}' is in handoff for {h.get('sessionId')}"
                        )
                    else:
                        print(
                            f"[UNKNOWN/BLOCKED] Resource '{args.resource}' error: {target_r.get('error')}"
                        )
            else:
                print(
                    f"Active addon locks via LAN authority ({lan_config.get('instanceId')}): {len(res_list)}"
                )
                for r in res_list:
                    owner = r.get("owner") or r.get("handoff") or {}
                    owner_tag = (
                        " (you)"
                        if session_id and owner.get("sessionId") == session_id
                        else ""
                    )
                    print(
                        f" - {r.get('resource')}: status={r.get('status')} owner='{owner.get('sessionName') or '未命名会话'}'{owner_tag}"
                    )
        return 0

    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # 1. 尝试加载 LAN 配置
    try:
        lan_config = load_lan_config()
    except ValueError as e:
        print(f"[error] {e}", file=sys.stderr)
        return 1

    # 2. 检查 LAN 启用时禁止 --state-root 或 ODOO_ADDON_LOCKS_DIR 旁路本地
    if lan_config and lan_config.get("enabled") is True:
        if args.command != "serve":
            if (
                getattr(args, "state_root", None) is not None
                or os.environ.get("ODOO_ADDON_LOCKS_DIR")
            ):
                print(
                    "[error] LAN collaboration is enabled: overriding --state-root or ODOO_ADDON_LOCKS_DIR is prohibited to prevent local bypass",
                    file=sys.stderr,
                )
                return 1

    session_id = resolve_session_id(getattr(args, "session_id", None))

    # A legacy command-line retry must not silently override a persisted user Stop.
    # The native tool reconciles the old queue/handoff before clearing captured epochs.
    if lan_config and lan_config.get("enabled") and args.command == "acquire" and session_id:
        agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or os.environ.get("PI_AGENT_DIR") or "/root/.pi/agent"
        stop_dir = Path(agent_dir) / "state" / "odoo-lan-cancelled" / hashlib.sha256(session_id.encode()).hexdigest()
        if stop_dir.is_dir() and any(stop_dir.iterdir()):
            print("[error] 原会话停止意图仍有效；请使用内置odoo_addon_lock重新申请并核验旧排队，本次未写锁。", file=sys.stderr)
            return 1

    # 3. 如果启用 LAN 且当前 role 为 client，且不是 serve 命令，走 SSH CLI gateway
    if (
        lan_config
        and lan_config.get("enabled") is True
        and lan_config.get("role") == "client"
    ):
        if args.command != "serve":
            return run_client_cli_via_ssh(lan_config, args.command, args, session_id)

    # 4. 本地 Authority 模式 或 未配置/Disabled 模式
    cfg_state_root = (
        lan_config.get("stateRoot")
        if (lan_config and lan_config.get("enabled"))
        else None
    )
    cli_state_root = getattr(args, "state_root", None) or cfg_state_root
    state_root = get_state_root(cli_state_root)

    instance_id = getattr(args, "instance_id", None)
    if not instance_id or instance_id == DEFAULT_INSTANCE_ID:
        if lan_config and lan_config.get("instanceId"):
            instance_id = lan_config["instanceId"]
        else:
            instance_id = DEFAULT_INSTANCE_ID

    instance_label = getattr(args, "instance_label", None)
    if not instance_label or instance_label == DEFAULT_INSTANCE_LABEL:
        if lan_config and lan_config.get("instanceLabel"):
            instance_label = lan_config["instanceLabel"]
        else:
            instance_label = DEFAULT_INSTANCE_LABEL

    manager = AddonLockManager(
        state_root=state_root,
        instance_id=instance_id,
        instance_label=instance_label,
    )
    session_id = resolve_session_id(getattr(args, "session_id", None))

    if args.command == "serve":
        run_serve(manager)
        return 0

    elif args.command == "status":
        try:
            res_status = manager.status(args.resource, current_session=session_id)
            if args.json:
                print(json.dumps(res_status, ensure_ascii=False, indent=2))
            else:
                if args.resource:
                    status_text = res_status.get("status", "unknown")
                    if status_text == "free":
                        print(f"[FREE] Resource '{args.resource}' is available.")
                    elif status_text == "locked":
                        meta = res_status.get("metadata", {})
                        owner_tag = (
                            " (current session)" if res_status.get("is_owner") else ""
                        )
                        print(
                            f"[LOCKED] Resource '{args.resource}' is locked by {meta.get('session_id')}{owner_tag}"
                        )
                        print(f"         Title: {meta.get('title')}")
                        print(
                            f"         Host: {meta.get('host')} | PID: {meta.get('owner_pid')}"
                        )
                        print(f"         Created: {meta.get('created')}")
                        if res_status.get("queue_length", 0) > 0:
                            print(f"         Waiters: {res_status.get('queue_length')}")
                    elif status_text == "handoff":
                        h = res_status.get("handoff", {})
                        print(
                            f"[HANDOFF] Resource '{args.resource}' is in handoff for {h.get('session_id')}"
                        )
                        print(f"         Title: {h.get('title')}")
                        print(f"         Resume: {h.get('resume_task')}")
                    else:
                        print(
                            f"[UNKNOWN/BLOCKED] Resource '{args.resource}' has corrupt/missing metadata."
                        )
                else:
                    locks = res_status.get("locks", [])
                    print(f"Active addon locks in {state_root}: {len(locks)}")
                    for lock in locks:
                        meta = lock.get("metadata") or lock.get("handoff") or {}
                        owner_tag = " (you)" if lock.get("is_owner") else ""
                        print(
                            f" - {lock.get('resource')}: status={lock.get('status')} owner='{meta.get('title') or '未命名会话（标题尚未生成）'}'{owner_tag}"
                        )
            return 0
        except ValueError as e:
            if args.json:
                print(json.dumps({"error": str(e)}, ensure_ascii=False))
            else:
                print(f"[error] {e}", file=sys.stderr)
            return 1

    elif args.command == "acquire":
        if not session_id:
            err_msg = (
                "Cannot acquire: session ID is required (--session or PI_SESSION_ID)"
            )
            if args.json:
                print(
                    json.dumps({"success": False, "error": err_msg}, ensure_ascii=False)
                )
            else:
                print(f"[error] {err_msg}", file=sys.stderr)
            return 1

        try:
            status_val, msg, data = manager.acquire(
                resource=args.resource,
                session_id=session_id,
                title=args.title,
                owner_pid=args.pid,
                host=args.host,
                source_root=args.source_root,
                instance_id=instance_id,
                instance_label=instance_label,
                resume_task=getattr(args, "resume_task", None) or DEFAULT_RESUME_TASK,
                reason=getattr(args, "reason", None),
            )
            if status_val == "acquired":
                if args.json:
                    print(
                        json.dumps(
                            {"success": True, "message": msg, "metadata": data},
                            ensure_ascii=False,
                            indent=2,
                        )
                    )
                else:
                    print(f"[OK] {msg} -> {args.resource}")
                    if data.get("token"):
                        print(f"Release credentials (own grant): token={data['token']} generation={data['generation']}")
                return 0
            elif status_val == "queued":
                # Non-zero queued exit code (75) to prevent `acquire && edit`
                if args.json:
                    print(
                        json.dumps(
                            {
                                "success": False,
                                "queued": True,
                                "message": msg,
                                "queue": data,
                            },
                            ensure_ascii=False,
                            indent=2,
                        )
                    )
                else:
                    print(
                        f"[QUEUED] {msg} -> {args.resource} (queueId: {data.get('queue_id')})",
                        file=sys.stderr,
                    )
                return 75
            else:
                if args.json:
                    print(
                        json.dumps({"success": False, "error": msg}, ensure_ascii=False)
                    )
                else:
                    print(f"[BLOCKED] {msg}", file=sys.stderr)
                return 1
        except ValueError as e:
            if args.json:
                print(
                    json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)
                )
            else:
                print(f"[error] {e}", file=sys.stderr)
            return 1

    elif args.command == "release":
        if not session_id:
            err_msg = (
                "Cannot release: session ID is required (--session or PI_SESSION_ID)"
            )
            if args.json:
                print(
                    json.dumps({"success": False, "error": err_msg}, ensure_ascii=False)
                )
            else:
                print(f"[error] {err_msg}", file=sys.stderr)
            return 1

        try:
            ok, msg, h_data = manager.release(
                args.resource,
                session_id=session_id,
                instance_id=instance_id,
                token=getattr(args, "token", None),
                generation=getattr(args, "generation", None),
            )
            if args.json:
                out_payload: Dict[str, Any] = {"success": ok, "message": msg}
                if h_data:
                    out_payload["handoff"] = h_data
                print(json.dumps(out_payload, ensure_ascii=False, indent=2))
            else:
                if ok:
                    print(f"[OK] {msg} -> {args.resource}")
                else:
                    print(f"[REFUSED] {msg}", file=sys.stderr)
            return 0 if ok else 1
        except ValueError as e:
            if args.json:
                print(
                    json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)
                )
            else:
                print(f"[error] {e}", file=sys.stderr)
            return 1

    elif args.command == "ack":
        if not session_id:
            err_msg = "Cannot ack: session ID is required (--session or PI_SESSION_ID)"
            if args.json:
                print(
                    json.dumps({"success": False, "error": err_msg}, ensure_ascii=False)
                )
            else:
                print(f"[error] {err_msg}", file=sys.stderr)
            return 1

        try:
            ok, msg, meta = manager.ack(
                args.resource,
                session_id=session_id,
                instance_id=instance_id,
                handoff_id=getattr(args, "handoff_id", None),
                token=getattr(args, "token", None),
                generation=getattr(args, "generation", None),
            )
            if args.json:
                print(
                    json.dumps(
                        {"success": ok, "message": msg, "metadata": meta},
                        ensure_ascii=False,
                        indent=2,
                    )
                )
            else:
                if ok:
                    print(f"[OK] {msg} -> {args.resource}")
                else:
                    print(f"[REFUSED] {msg}", file=sys.stderr)
            return 0 if ok else 1
        except ValueError as e:
            if args.json:
                print(
                    json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)
                )
            else:
                print(f"[error] {e}", file=sys.stderr)
            return 1

    elif args.command == "cancel":
        if not session_id:
            err_msg = (
                "Cannot cancel: session ID is required (--session or PI_SESSION_ID)"
            )
            if args.json:
                print(
                    json.dumps({"success": False, "error": err_msg}, ensure_ascii=False)
                )
            else:
                print(f"[error] {err_msg}", file=sys.stderr)
            return 1

        try:
            ok, msg, c_data = manager.cancel(
                args.resource,
                session_id=session_id,
                instance_id=instance_id,
                queue_id=getattr(args, "queue_id", None),
                handoff_id=getattr(args, "handoff_id", None),
            )
            if args.json:
                print(
                    json.dumps(
                        {"success": ok, "message": msg, "data": c_data},
                        ensure_ascii=False,
                        indent=2,
                    )
                )
            else:
                if ok:
                    print(f"[OK] {msg} -> {args.resource}")
                else:
                    print(f"[REFUSED] {msg}", file=sys.stderr)
            return 0 if ok else 1
        except ValueError as e:
            if args.json:
                print(
                    json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)
                )
            else:
                print(f"[error] {e}", file=sys.stderr)
            return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
