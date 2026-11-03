"""Windows Desktop adapter; the Desktop remains the sole turn executor.

Reuse the existing version-11 snapshot/revision owner and native turn payloads.
An explicitly configured, short-lived metadata helper may create an empty thread.
It exits before Desktop takeover; it never receives a turn or user message.
"""

import copy
import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import ClassVar

import tomllib

from bridge.app.service import Bridge
from bridge.clients.codex.attachment_readability import AttachmentReadError, check_attachments
from bridge.clients.codex.ipc import IPCError
from bridge.clients.codex.submission_trace import new_trace, observe, record
from bridge.features.sessions.create import CreationUnavailable, create_empty, open_in_desktop
from bridge.features.workspace.project_scopes import (
    get_scoped_worktree_info,
    resolve_scoped_cwd,
)


def native_directory(value):
    """Unify extended local-drive aliases only after filesystem identity proof."""
    resolved = Path(value).resolve(strict=True)
    text = str(resolved)
    if text.startswith("\\\\?\\") and len(text) > 6 and text[5:7] == ":\\":
        alias = Path(text[4:])
        if alias.is_dir() and alias.samefile(resolved):
            return alias.resolve(strict=True)
    return resolved


class NativeRejected(ValueError):
    code = "submission_rejected"
    dispatched = False
    retryable = False


class NativeUnknown(IPCError):
    code = "submission_unknown"
    dispatched = None
    retryable = False


class DesktopCatalog:
    """Read actual Desktop metadata only. Never start another app-server."""

    executable = None

    def __init__(self, home):
        self.home = Path(home)

    def get_kind(self, kind, cwd, **options):
        if kind != "models":
            raise NativeRejected("Windows 桌面基础接入尚不提供技能目录，请在桌面操作。")
        cache = self.home / "models_cache.json"
        if not cache.is_file() or cache.stat().st_size > 16 * 1024 * 1024:
            raise NativeRejected(
                "尚未取得真实桌面模型目录，请先在 Codex 桌面加载模型。"
            )
        raw = json.loads(cache.read_text(encoding="utf-8-sig"))
        if not isinstance(raw.get("models"), list):
            raise NativeRejected("桌面模型缓存格式不兼容，未使用预设模型替代。")
        config = self.home / "config.toml"
        selected = (
            tomllib.loads(config.read_text(encoding="utf-8-sig"))
            if config.exists()
            else {}
        )
        models = []
        for row in raw["models"]:
            if not isinstance(row, dict) or not isinstance(row.get("slug"), str):
                continue
            levels = row.get("supported_reasoning_levels")
            efforts = [
                level["effort"]
                for level in levels or []
                if isinstance(level, dict) and isinstance(level.get("effort"), str)
            ]
            models.append(
                {
                    "id": row["slug"],
                    "name": row.get("display_name") or row["slug"],
                    "efforts": efforts,
                    "defaultEffort": row.get("default_reasoning_level"),
                    "isDefault": row["slug"] == selected.get("model"),
                }
            )
        if not models:
            raise NativeRejected("真实桌面模型目录为空，未伪造默认模型。")
        return {
            "kind": "models",
            "models": models,
            "modelSource": "desktop-models-cache",
            "currentModel": selected.get("model"),
            "cacheFetchedAt": raw.get("fetched_at"),
        }

    def get(self, cwd, **options):
        return self.get_kind("models", cwd, **options)


class Projects:
    def __init__(self, rows):
        self.rows = rows

    def projects(self):
        return [
            {"key": r["key"], "name": r["name"], "cwd": str(r["path"]), "host": "local"}
            for r in self.rows
        ]


class Clients:
    def __init__(self, bridge):
        self.bridge = bridge

    def require_enabled(self, provider):
        if provider != "codex":
            raise NativeRejected("此入口仅连接本机 Codex 桌面。")

    def clients(self):
        status = self.bridge.runtime_status()
        return {
            "gatewayRunning": True,
            "clients": [
                {
                    "id": "codex",
                    "name": "Windows Codex Desktop",
                    "enabled": True,
                    "installed": True,
                    "configured": True,
                    "selectable": False,
                    "running": status["connected"],
                    "connected": status["connected"],
                    "state": "connected" if status["connected"] else "unavailable",
                }
            ],
        }

    def toggle_client(self, value):
        raise NativeRejected("桌面应用生命周期由 Windows 用户管理，此入口不启动或退出桌面。")

    def close(self):
        pass


class WindowsDesktopBridge(Bridge):
    # Select scoped project APIs and disable unrelated account/updater managers,
    # NOT the standalone runtime or its compatibility descriptor.
    standalone = True
    windows_desktop = True
    compatibility: ClassVar[dict] = {
        "protocol": "agent-web-codex-windows-desktop",
        "version": 1,
        "platform": "win32",
        "capabilities": ["timeline-v1", "prompt-identity-v1", "desktop-owner-v1"],
    }

    def __init__(self, codex_home, data_dir, workspaces, ipc_path=None, creation_executable=None):
        if not workspaces:
            raise ValueError("必须显式配置 Windows 原生项目目录。")
        self.workspaces = []
        for row in workspaces:
            root = native_directory(row["path"])
            if not root.is_dir() or not row.get("key") or not row.get("name"):
                raise ValueError("Windows 项目配置无效。")
            self.workspaces.append(
                {"key": row["key"], "name": row["name"], "path": root}
            )
        super().__init__(codex_home, data_dir, ipc_path=ipc_path)
        self.hosts = Projects(self.workspaces)
        self.catalog_reader = DesktopCatalog(codex_home)
        self.creation_executable = creation_executable
        self.compatibility = {**type(self).compatibility, "capabilities": [
            *type(self).compatibility["capabilities"],
            *(["desktop-create-v1"] if creation_executable else []),
        ]}
        self.clients = Clients(self)
        # No account switching or auxiliary execution is permitted on this adapter.
        self.accounts = None
        self.account = None
        self.goal = None
        self.goal_transport = "none"
        for row in self.submissions.values():
            if row.get("status") not in ("accepted", "failed"):
                row["status"] = "unknown"

    def for_host(self, host="local"):
        if host != "local":
            raise NativeRejected("此入口只连接 Windows 本机，不转发 WSL 或远程主机。")
        return self

    def _record(self, thread_id):
        uuid.UUID(thread_id)
        row = self.store.get(thread_id)
        cwd = native_directory(row.get("cwd", ""))
        resolve_scoped_cwd(str(cwd), self.workspaces)
        return {**row, "cwd": str(cwd)}

    def session(self, thread_id, *args, **kwargs):
        self._record(thread_id)
        return super().session(thread_id, *args, **kwargs)

    def list(self, query="", limit=100, offset=0, archived=False):
        filtered = []
        raw_offset = 0
        while len(filtered) < offset + limit:
            page = self.store.list(
                query=query, limit=100, offset=raw_offset, archived=archived
            )
            for row in page:
                try:
                    cwd = native_directory(row.get("cwd", ""))
                    project, _ = resolve_scoped_cwd(str(cwd), self.workspaces)
                except (ValueError, OSError):
                    continue
                filtered.append(
                    {
                        **row,
                        "cwd": str(cwd),
                        "title": row.get("name") if row.get("name") is not None else row.get("title", ""),
                        "updatedAt": row.get("updated_at"),
                        "recency": next((row[key] * scale for key, scale in (
                            ("recency_at_ms", 1), ("recency_at", 1000),
                            ("updated_at_ms", 1), ("updated_at", 1000))
                            if isinstance(row.get(key), (int, float)) and row[key] > 0), None),
                        "project": project["key"],
                        "projectName": project["name"],
                        "host": "local",
                        "hostLabel": "Windows 原生桌面",
                    }
                )
            if len(page) < 100:
                break
            raw_offset += len(page)
        return filtered[offset : offset + limit]

    def _maintain(self):
        # Only maintain passive subscriptions. In particular NEVER drain a queue.
        while not self.closed.wait(3):
            with self.lock:
                sessions = list(self.live.values())
            for session in sessions:
                if session.viewers > 0 and not session.connected:
                    self._refresh_async(session)

    def activate(self, thread_id):
        # Base activate() navigates the desktop. This adapter never does that.
        return self._target(thread_id)

    def _target(self, thread_id):
        session = self.session(thread_id, attach=False)
        with session.condition:
            if not session.connected or not session.owner or session.revision is None:
                raise NativeRejected(
                    "尚无原生实时快照，请先在 Codex 桌面打开此会话并等待连接。"
                )
        return session

    def _goal_runtime_available(self):
        return False

    def _overlay_native_goal(self, session, thread_id, view):
        # Do not project a partial goal feature or run sidecar RPCs.
        view["goal"] = None
        view["composerState"] = {
            "version": 1,
            "mode": "normal",
            "capabilities": {"goal": False, "plan": False},
        }
        view["nativeDesktopLimits"] = {
            "queue": False,
            "automaticActivation": False,
            "newSessions": bool(self.creation_executable),
        }
        return view

    def runtime_status(self):
        error = None
        try:
            self.ipc.connect()
        except (IPCError, OSError) as exc:
            error = str(exc)
        return {
            "mode": "windows-desktop",
            "platform": "win32",
            "connected": bool(self.ipc.client_id and self.ipc.socket),
            "transport": "windows-named-pipe",
            "error": error,
        }

    def validate_cwd(self, cwd):
        project, path = resolve_scoped_cwd(cwd, self.workspaces)
        return {"valid": True, "cwd": str(path), "project": project["key"],
                "projectRoot": str(project["path"]), "projectKey": project["key"]}

    def create_chat(self, project_key=None, title=None, request_id=None, cwd=None):
        if not self.creation_executable:
            return self._unsupported()
        executable = Path(self.creation_executable)
        if not executable.is_absolute() or not executable.is_file():
            raise NativeRejected("Windows 原生建会话程序不可用，请核对桌面运行配置；未创建会话。")
        if not isinstance(request_id, str):
            raise NativeRejected("创建请求标识无效。")
        uuid.UUID(request_id)
        if not isinstance(title, str) or not title.strip() or len(title) > 120:
            raise NativeRejected("请输入 1–120 字的聊天名称。")
        project = next((row for row in self.workspaces if row["key"] == project_key), None)
        if project is None:
            raise NativeRejected("请选择已配置的 Windows Codex 工作区。")
        _, target = resolve_scoped_cwd(cwd or str(project["path"]), [project])
        title = title.strip()
        try:
            self.ipc.connect()
        except (IPCError, OSError) as exc:
            raise NativeRejected("请先打开 Windows Codex 桌面并等待连接；未创建会话。") from exc
        with self.create_lock:
            entry = self.creations.get(request_id)
            if entry:
                if (entry.get("project"), entry.get("cwd"), entry.get("title")) != (project_key, str(target), title):
                    raise NativeRejected("同一创建请求不能用于不同目录或内容。")
                if not entry.get("id"):
                    raise NativeUnknown("上次建会话结果待确认，请先核对桌面列表；不会自动重复创建。")
            else:
                entry = {"project": project_key, "cwd": str(target), "title": title, "host": "local", "at": time.time()}
                self.creations[request_id] = entry
                self._save_creations()
                try:
                    # Existing metadata-only helper waits for process exit before returning.
                    identifier = create_empty(str(executable), self.codex_home, str(target), title)
                    uuid.UUID(identifier)
                except CreationUnavailable as exc:
                    del self.creations[request_id]
                    self._save_creations()
                    raise NativeRejected(str(exc)) from exc
                except Exception as exc:
                    raise NativeUnknown("建会话结果待确认，请核对桌面列表；不会自动重复创建。") from exc
                entry["id"] = identifier
                self._save_creations()
        try:
            # Activation is restricted to this explicit creation request, never history reads.
            open_in_desktop(entry["id"], "local")
        except OSError as exc:
            raise NativeUnknown("空会话已创建，请在 Codex 桌面打开后重试；不会重复创建。") from exc
        session = self.session(entry["id"], attach=False)
        self._refresh_async(session, force=True)
        with session.condition:
            ready = session.condition.wait_for(
                lambda: (session.connected and session.owner and session.revision is not None) or self.closed.is_set(),
                timeout=15,
            )
            if not ready or not session.connected or not session.owner or session.revision is None:
                raise NativeUnknown("空会话已创建，正在等待桌面接管；请稍后重试，原文已保留且不会重复创建。")
        return {"id": entry["id"], "host": "local", "opened": True, "desktopOwnerConfirmed": True}

    def worktree_info(self, cwd):
        project, path = resolve_scoped_cwd(cwd, self.workspaces)
        return get_scoped_worktree_info(path, project)

    def browse_directories(self, path=None):
        if path:
            self.validate_cwd(path)
        return {
            "directories": [
                {"path": str(p["path"]), "name": p["name"]} for p in self.workspaces
            ]
        }

    def send(
        self,
        thread_id,
        text,
        submission_id,
        mode="send",
        skills=None,
        *,
        work_mode=None,
        attachments=None,
        ui_locale=None,
        client_request_id=None,
        **options,
    ):
        uuid.UUID(submission_id)
        if (
            mode not in ("auto", "send")
            or work_mode not in (None, "default")
            or skills
            or options
        ):
            raise NativeRejected(
                "Windows 桌面基础接入仅支持空闲直接发送；排队、补充、目标与计划请在桌面操作。"
            )
        session = self._target(thread_id)
        key = thread_id + ":" + submission_id
        files = self.uploads.resolve(thread_id, attachments or [])
        if (
            not isinstance(text, str)
            or (not text.strip() and not files)
            or len(text) > 100000
        ):
            raise NativeRejected("请输入有效消息。")
        fingerprint = hashlib.sha256(
            json.dumps(
                [text, attachments or [], client_request_id], ensure_ascii=False
            ).encode()
        ).hexdigest()
        with session.action_lock:
            with self.submit_lock:
                prior = self.submissions.get(key)
                if prior:
                    if prior.get("fingerprint") != fingerprint:
                        raise NativeRejected("同一请求标识不能用于不同内容。")
                    if prior["status"] == "unknown":
                        raise NativeUnknown(
                            "上次结果待确认，未自动重发；请核对桌面历史。"
                        )
                    return {
                        "id": submission_id,
                        "status": prior["status"],
                        "duplicate": True,
                        "nativeQueueConfirmed": False,
                        "error": prior.get("error"),
                        **({"trace": copy.deepcopy(prior["trace"])} if prior.get("trace") else {}),
                        **({"errorCode": prior["errorCode"]} if prior.get("errorCode") else {}),
                    }
            with session.condition:
                status = (
                    (session.state or {}).get("threadRuntimeStatus", {}).get("type")
                )
                if (
                    not session.connected
                    or session.revision is None
                    or status != "idle"
                ):
                    raise NativeRejected(
                        "原生状态不是已确认空闲；未发送。网页不建立第二个队列。"
                    )
            entry = {
                "text": text,
                "mode": "send",
                "status": "unknown",
                "at": time.time(),
                "skills": [],
                "fingerprint": fingerprint,
                "clientRequestId": client_request_id,
                "attachments": attachments or [],
                "attachmentNames": [f["name"] for f in files],
                "attachmentPaths": [f["path"] for f in files],
                "trace": new_trace(),
            }
            with self.submit_lock:
                self.submissions[key] = entry
                self._save_ledger()
            try:
                # Existing production DTO: input array, threadId, inherited native
                # settings and attachment context. No default model/permissions.
                result = self._dispatch(session, key, entry)
                response = result.get("result") or {}
                turn = response.get("turn") or (response.get("result") or {}).get(
                    "turn"
                )
                if not isinstance(turn, dict) or not isinstance(turn.get("id"), str):
                    raise NativeUnknown(
                        "桌面回执缺少原生轮次身份，结果待确认，不会自动重发。"
                    )
                with self.submit_lock:
                    entry["nativeTurnId"] = turn["id"]
                    record(entry["trace"], "task_received", "confirmed",
                           evidence="native_rpc_acknowledgement", turnId=turn["id"])
                    self._save_ledger()
                self._reconcile_traces(thread_id)
                return {**result, "nativeQueueConfirmed": False,
                        "trace": copy.deepcopy(entry["trace"])}
            except AttachmentReadError as exc:
                with self.submit_lock:
                    entry["status"] = "failed"
                    entry["error"] = str(exc)
                    entry["errorCode"] = exc.code
                    entry["trace"]["receiverReadability"] = {
                        **exc.evidence, "at": time.time()
                    }
                    record(entry["trace"], "attachment_read", **exc.evidence)
                    self._save_ledger()
                raise
            except Exception as exc:
                with self.submit_lock:
                    self.submissions[key]["status"] = "unknown"
                    self.submissions[key]["error"] = "桌面操作结果待确认；未重发。"
                    record(entry["trace"], "task_received", "unknown",
                           reason="native_acknowledgement_unconfirmed")
                    self._save_ledger()
                raise NativeUnknown(
                    "桌面操作结果待确认；请核对会话，未自动重发。"
                ) from exc

    def _dispatch(self, session, key, entry):
        try:
            files = self.uploads.resolve(session.id, entry.get("attachments", []))
        except (OSError, ValueError) as exc:
            raise AttachmentReadError(
                "receiver_attachment_unavailable",
                "附件读取检查失败：附件已不可用；未发送。",
            ) from exc
        proof = check_attachments(self.ipc, files, self.creation_executable)
        with self.submit_lock:
            entry["trace"]["receiverReadability"] = {**proof, "at": time.time()}
            if proof["status"] == "not_applicable":
                record(entry["trace"], "attachment_read", **proof)
            else:
                record(entry["trace"], "attachment_read", "pending",
                       reason="native_content_read_acknowledgement_unavailable")
            self._save_ledger()
        return super()._dispatch(session, key, entry)

    def _reconcile_traces(self, thread_id):
        with self.submit_lock:
            wanted = {
                row.get("nativeTurnId")
                for key, row in self.submissions.items()
                if key.startswith(thread_id + ":") and row.get("trace")
                and row.get("nativeTurnId")
            }
        session = self.live.get(thread_id)
        if not wanted or session is None:
            return
        from bridge.features.sessions.model import items_array, ordered_turns

        with session.condition:
            if not session.connected or session.revision is None:
                return
            turns = [
                {
                    "turnId": turn.get("turnId") or turn.get("id"),
                    "status": turn.get("status"),
                    "error": turn.get("error"),
                    "items": [
                        {key: item[key] for key in ("id", "type", "status", "exitCode") if key in item}
                        for item in items_array(turn.get("items"))
                    ],
                }
                for turn in ordered_turns(session.state or {})
                if (turn.get("turnId") or turn.get("id")) in wanted
            ]
        with self.submit_lock:
            changed = False
            for key, entry in self.submissions.items():
                if key.startswith(thread_id + ":"):
                    changed = observe(entry, {"turns": turns}) or changed
            if changed:
                self._save_ledger()

    def _event(self, message):
        super()._event(message)
        params = message.get("params") or {}
        if (
            message.get("method") == "thread-stream-state-changed"
            and params.get("hostId") == "local"
        ):
            self._reconcile_traces(params.get("conversationId", ""))

    def submission_receipt(self, thread_id, submission_id):
        self._record(thread_id)
        uuid.UUID(submission_id)
        self._reconcile_traces(thread_id)
        confirmed = self._reconcile_submission_receipt(thread_id, submission_id)
        with self.submit_lock:
            row = copy.deepcopy(
                self.submissions.get(thread_id + ":" + submission_id) or {}
            )
        return {
            "id": submission_id,
            "status": row.get("status", "unknown"),
            "deliveryConfirmed": confirmed,
            "nativeQueueConfirmed": False,
            **({"trace": row["trace"]} if row.get("trace") else {}),
            **({"error": row["error"], "errorCode": row.get("errorCode")}
               if row.get("error") else {}),
        }

    def _reconcile_submission_receipt(self, thread_id, submission_id):
        key = thread_id + ":" + submission_id
        with self.submit_lock:
            row = self.submissions.get(key)
            if row is None:
                return False
        try:
            confirmed = self.store.confirmed_user_receipt(thread_id, submission_id)
        except (KeyError, OSError):
            return False
        if not confirmed:
            return False
        with self.submit_lock:
            row = self.submissions.get(key)
            changed = False
            if row and row.get("status") == "unknown":
                row["status"] = "accepted"
                row.pop("error", None)
                changed = True
            if (
                row
                and row.get("status") == "accepted"
                and row.get("trace")
                and row["trace"]["stages"]["task_received"]["status"] != "confirmed"
            ):
                record(
                    row["trace"],
                    "task_received",
                    "confirmed",
                    evidence="native_persisted_user_receipt",
                )
                changed = True
            if changed:
                self._save_ledger()
        return True

    def _submission_meta(self, session, view):
        with self.submit_lock:
            unknown_ids = [
                key.rsplit(":", 1)[-1]
                for key, row in self.submissions.items()
                if key.startswith(session.id + ":") and row.get("status") == "unknown"
            ]
        for submission_id in unknown_ids:
            self._reconcile_submission_receipt(session.id, submission_id)
        return super()._submission_meta(session, view)

    def view(self, thread_id, *args, **kwargs):
        if kwargs.pop("metadata", False):
            kwargs["attach"] = False
        result = super().view(thread_id, *args, **kwargs)
        if result.get("cwd"):
            result["cwd"] = str(native_directory(result["cwd"]))
        return result

    def timeline_read(self, thread_id, mode="page", **options):
        result = super().timeline_read(thread_id, mode, **options)
        if result.get("meta", {}).get("cwd"):
            result["meta"]["cwd"] = str(native_directory(result["meta"]["cwd"]))
        with self.submit_lock:
            identities = {
                k.split(":")[-1]: v.get("clientRequestId")
                for k, v in self.submissions.items()
                if k.startswith(thread_id + ":") and v.get("clientRequestId")
            }
        for row in result.get("rows", []):
            if row.get("requestId") in identities:
                row["requestId"] = identities[row["requestId"]]
        return result

    def settings(self, thread_id, model, effort, *, fast_mode=None):
        catalog = self.catalog_reader.get_kind("models", self._record(thread_id)["cwd"])
        known = next((row for row in catalog["models"] if row["id"] == model), None)
        if not known or effort not in known["efforts"] or fast_mode is not None:
            raise NativeRejected("所选设置不在真实桌面模型能力中，或尚不支持 Fast 设置；未修改。")
        try:
            result = super().settings(thread_id, model, effort)
        except IPCError as exc:
            raise NativeUnknown("桌面设置结果待确认，请刷新核对；未自动重发。") from exc
        if not result.get("confirmed"):
            raise NativeUnknown("尚未收到原生设置确认，请刷新核对；未自动重发。")
        return self.view(thread_id)

    def set_composer_mode(self, thread_id, mode):
        if mode != "normal":
            return self._unsupported()
        return self.view(thread_id)

    def workspace(self, thread_id, action, params):
        self._record(thread_id)
        return super().workspace(thread_id, action, params)

    def upload(self, thread_id, identifier, name, data):
        self._record(thread_id)
        return super().upload(thread_id, identifier, name, data)

    def navigation_index(self, thread_id):
        self._record(thread_id)
        return {"available": False, "reason": "Windows 桌面基础接入未提供独立导航索引；历史分页仍可用。"}

    def full_history(self, thread_id):
        # The original rollout reader supports inactive sessions without activation.
        session = self.session(thread_id, attach=False)
        with session.condition:
            session.history_limit = None
            session.set_history(self.store.history(thread_id, turn_limit=None))
        return self.view(thread_id)

    def _unsupported(self, *args, **kwargs):
        raise NativeRejected(
            "Windows 桌面基础接入尚不支持此操作，请在 Codex 桌面处理；没有启动替代执行端。"
        )

    create_worktree = rename = message_action = side_chat = _unsupported
    permissions = set_goal_status = cancel_goal = edit_goal = _unsupported
    cancel_queued = queue_actions = ignore_submission = _unsupported
    terminal = _unsupported
