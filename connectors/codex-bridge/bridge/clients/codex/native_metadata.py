"""Native metadata is authoritative; the bridge never writes the Codex database."""

import time
from contextlib import nullcontext
from pathlib import Path

from bridge.features.sessions.model import async_requests

PINNED_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318"


def _store(bridge, entry):
    store = (
        bridge.history
        if entry.get("runtime") == "history"
        else getattr(bridge, "web_history", None)
    )
    if store is None:
        raise ValueError("原生状态读取不可用，尚未修改会话")
    return store


def _read(bridge, identifier, entry):
    meta = _store(bridge, entry).get(identifier)
    if Path(meta["cwd"]).resolve(strict=True) != Path(entry["cwd"]).resolve(
        strict=True
    ):
        raise PermissionError("原生会话目录与已授权目录不一致")
    return meta


def build_session_metadata(bridge, thread_id, entry=None):
    entry = entry or bridge._scoped_record(thread_id)
    meta = _read(bridge, thread_id, entry)
    store = _store(bridge, entry)
    project = store.workspace(meta["cwd"])
    if project is None:
        raise PermissionError("会话目录不在此入口的项目范围内")
    updated = meta.get("updated_at", 0)
    title = meta.get("name") or meta.get("title") or "未命名聊天"
    chat = bridge.live.get(thread_id)
    return {
        "id": thread_id,
        "title": title,
        "name": title,
        "cwd": meta["cwd"],
        "host": "local",
        "hostLabel": "WSL Codex",
        "projectName": project["name"],
        "projectKey": project["key"],
        "recency": meta.get("recency_at_ms")
        or (meta.get("recency_at") or updated) * 1000,
        "updatedAt": updated,
        "path": store.rollout_path(meta),
        "connected": bool(chat and chat.connected),
        "archived": bool(meta.get("archived")),
        "pinned": meta.get("thread_section_id") == PINNED_SECTION_ID,
        "nativeMetadata": {
            "desktopShared": entry.get("runtime") == "history",
            "pinningSupported": "thread_section_id" in meta,
        },
    }


def _archive_guard(bridge, identifier, entry, chat, backend):
    submissions = chat.submissions if chat else entry.get("submissions", {})
    if any(row.get("status") in ("queued", "unknown") for row in submissions.values()):
        raise ValueError("会话还有待发送或待确认的消息，请处理队列后再归档")
    if chat and (chat.state.get("requests") or async_requests(chat.state)):
        raise ValueError("会话正在等待回复，请处理当前问题后再归档")
    # Desktop may own a running thread even when this web process has no live Chat.
    thread = backend.request(
        "thread/resume", {"threadId": identifier, "excludeTurns": True}, timeout=10
    )["thread"]
    if Path(thread.get("cwd", "")).resolve() != Path(entry["cwd"]).resolve():
        raise PermissionError("运行时返回的项目目录与已授权目录不一致")
    if thread.get("status", {}).get("type") != "idle":
        raise ValueError("会话正在执行任务或等待回复，请结束当前任务后再归档")
    queued = backend.request("thread/queue/list", {"threadId": identifier}, timeout=5)
    if (
        not isinstance(queued.get("data"), list)
        or queued["data"]
        or queued.get("nextCursor") is not None
    ):
        raise ValueError("会话还有待发送消息或队列状态未确认，请处理队列后再归档")


def _operate(
    bridge, identifier, action, *, title=None, timeout=10.0, verify_timeout=2.0
):
    if action == "rename":
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 120:
            raise ValueError("请输入 1–120 字的聊天名称")
        title = title.strip()
    chat = bridge.live.get(identifier)
    # Same actions -> bridge lock order as deletion; retain locks through native
    # write AND confirmation, not just through a racy preflight check.
    with chat.actions if chat else nullcontext(), bridge.lock:
        if bridge.live.get(identifier) is not chat:
            raise ValueError("会话状态已变化，请刷新后重试")
        entry = bridge._scoped_record(identifier)
        before = _read(bridge, identifier, entry)
        if action in ("pin", "unpin"):
            if "thread_section_id" not in before:
                raise ValueError("当前 Codex 版本不支持原生置顶")
            field, target = (
                "thread_section_id",
                PINNED_SECTION_ID if action == "pin" else None,
            )
            method = "thread/section/move"
            params = {
                "threadId": identifier,
                "sectionId": target,
                "beforeThreadId": None,
            }
            label = "置顶状态"
        elif action in ("archive", "unarchive"):
            field, target = "archived", int(action == "archive")
            method, params, label = (
                "thread/" + action,
                {"threadId": identifier},
                "归档状态",
            )
        else:
            field, target = "name", title
            method, params, label = (
                "thread/name/set",
                {"threadId": identifier, "name": title},
                "名称",
            )
        before_value = (before.get('name') or before.get('title')) if action == 'rename' else before.get(field)
        if before_value != target:
            backend = (
                chat.backend
                if chat
                else (
                    bridge._history_backend()
                    if entry.get("runtime") == "history"
                    else bridge.runtime
                )
            )
            if action == "archive":
                _archive_guard(bridge, identifier, entry, chat, backend)
            # Archived threads intentionally cannot be resumed. Restoration is
            # the native unarchive operation itself, not a pre-resume.
            # A transport timeout is unknown, not permission to resend. Readback
            # polling below never repeats a write or changes another state owner.
            backend.request(method, params, timeout=timeout)
            deadline = time.monotonic() + verify_timeout
            while True:
                current = _read(bridge, identifier, entry)
                current_value = (current.get('name') or current.get('title')) if action == 'rename' else current.get(field)
                if current_value == target:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError(
                        f"执行端未确认{label}变更，请刷新核对；不会自动重复操作"
                    )
                time.sleep(min(0.05, remaining))
        if action == "rename":
            with bridge.registry_lock:
                # Legacy overrides are retained until explicit successful rename;
                # never bulk-migrate real user data on startup/listing.
                bridge.records["titleOverrides"].pop(identifier, None)
                if identifier in bridge.records["threads"]:
                    bridge.records["threads"][identifier]["title"] = title
                bridge.save()
            if chat:
                with chat.condition:
                    chat.state["name"] = title
                    chat.state["title"] = title
                    chat.changed()
        return {
            "ok": True,
            "session": build_session_metadata(bridge, identifier, entry),
        }


def execute_pin_action(
    bridge, thread_id, action, entry, timeout=10.0, verify_timeout=2.0
):
    return _operate(
        bridge, thread_id, action, timeout=timeout, verify_timeout=verify_timeout
    )


def execute_archive_action(
    bridge, thread_id, action, entry, timeout=10.0, verify_timeout=2.0
):
    return _operate(
        bridge, thread_id, action, timeout=timeout, verify_timeout=verify_timeout
    )


def execute_rename(bridge, thread_id, title, entry, timeout=10.0, verify_timeout=2.0):
    _operate(
        bridge,
        thread_id,
        "rename",
        title=title,
        timeout=timeout,
        verify_timeout=verify_timeout,
    )
    return bridge.view(thread_id)
