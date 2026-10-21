"""Read-only discovery and detail viewer for native Codex subagents."""

import sqlite3
import uuid
from pathlib import Path

from bridge.features.sessions.store import StoreUnavailable


def _find_authoritative_store(bridge, thread_id):
    """Find the authoritative store owning parent thread while respecting workspace scopes."""
    candidate_stores = []
    for attr in ("history", "web_history", "store"):
        st = getattr(bridge, attr, None)
        if st is not None and st not in candidate_stores:
            candidate_stores.append(st)

    workspaces = getattr(bridge, "workspaces", None)
    records = getattr(bridge, "records", {}).get("threads", {})
    record_entry = records.get(thread_id)

    found_store = None
    found_meta = None
    for store in candidate_stores:
        if not hasattr(store, "_connect"):
            continue
        try:
            with store._connect() as conn:
                row = conn.execute(
                    "SELECT * FROM threads WHERE id = ?", (thread_id,)
                ).fetchone()
                if row:
                    found_store = store
                    found_meta = dict(row)
                    break
        except (StoreUnavailable, sqlite3.Error, OSError, ValueError, TypeError):
            # Capture database missing or corrupt errors without 500, fallback to next candidate
            continue

    if found_store is not None and found_meta is not None:
        if found_meta.get("thread_source") == "subagent" or '"subagent"' in (
            found_meta.get("source") or ""
        ):
            raise KeyError("不是主会话")
        cwd = found_meta.get("cwd") or (
            record_entry.get("cwd") if record_entry else None
        )
        if cwd and workspaces:
            resolved_cwd = Path(cwd).resolve()
            if not any(
                resolved_cwd.is_relative_to(item["path"]) for item in workspaces
            ):
                raise PermissionError("会话目录不在此入口的项目范围内")
        return found_store, found_meta

    # 2. Check if registered in live bridge records (adopted web parent)
    if record_entry:
        if record_entry.get("thread_source") == "subagent" or '"subagent"' in (
            record_entry.get("source") or ""
        ):
            raise KeyError("不是主会话")
        cwd = record_entry.get("cwd")
        if cwd and workspaces:
            resolved_cwd = Path(cwd).resolve()
            if not any(
                resolved_cwd.is_relative_to(item["path"]) for item in workspaces
            ):
                raise PermissionError("会话目录不在此入口的项目范围内")
        for store in candidate_stores:
            if hasattr(store, "_connect"):
                return store, record_entry

    raise KeyError("找不到这个会话")


def subagents(bridge, thread_id, agent_id=None):
    """View Codex native subagents in read-only mode."""
    uuid.UUID(str(thread_id))
    if agent_id:
        uuid.UUID(str(agent_id))

    store, parent_meta = _find_authoritative_store(bridge, thread_id)

    if not agent_id:
        return store.subagents(thread_id, verified_parent=parent_meta)
    return store.subagent_history(thread_id, agent_id, verified_parent=parent_meta)
