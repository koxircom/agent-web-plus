"""定向 fork helper：按选定用户轮次之前分支，与现有 Desktop 共享原生线程。"""

import copy
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

_SCHEMA_CACHE = {}


def validate_thread_fork_schema(executable):
    """必须查询实际 executable 的 ThreadForkParams schema 具备 beforeTurnId 及 deferGoalContinuation。

    缓存绑定 executable 实际 mtime/身份。
    """
    if not executable:
        raise ValueError("找不到 Codex 运行时路径")

    resolved_str = shutil.which(str(executable)) or str(executable)
    resolved = Path(resolved_str)
    try:
        resolved_path = resolved.resolve(strict=True)
    except (OSError, RuntimeError) as e:
        raise ValueError(f"无法定位 Codex 可执行文件: {executable}") from e

    stat = resolved_path.stat()
    cache_key = (str(resolved_path), stat.st_mtime_ns, stat.st_size)
    if cache_key in _SCHEMA_CACHE:
        if _SCHEMA_CACHE[cache_key]:
            return True
        raise ValueError(
            "此 Codex 版本暂不支持安全分支（缺少 beforeTurnId 或 deferGoalContinuation）"
        )

    kwargs = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    with tempfile.TemporaryDirectory(prefix="fork-schema-") as folder:
        try:
            result = subprocess.run(
                [
                    str(resolved_path),
                    "app-server",
                    "generate-json-schema",
                    "--experimental",
                    "--out",
                    folder,
                ],
                capture_output=True,
                check=False,
                timeout=30,
                **kwargs,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            # 瞬态错误不永久记入不支持缓存
            raise ValueError("无法检查 Codex 运行时分支能力，请检查运行环境") from exc

        paths = list(Path(folder).rglob("ThreadForkParams.json"))
        if result.returncode or not paths:
            _SCHEMA_CACHE[cache_key] = False
            raise ValueError("此 Codex 版本暂不支持安全分支，请升级 Codex")

        try:
            properties = json.loads(paths[0].read_text(encoding="utf-8")).get(
                "properties", {}
            )
        except Exception as exc:
            _SCHEMA_CACHE[cache_key] = False
            raise ValueError("解析 ThreadForkParams.json 失败") from exc

        if not {"beforeTurnId", "deferGoalContinuation"} <= set(properties.keys()):
            _SCHEMA_CACHE[cache_key] = False
            raise ValueError(
                "此 Codex 版本暂不支持安全分支（缺少 beforeTurnId 或 deferGoalContinuation 支持）"
            )

        _SCHEMA_CACHE[cache_key] = True
        return True


def execute_fork_action(bridge, thread_id, body, entry=None):
    """验证并执行分支操作，严格遵循白名单与持久 pending 意图。"""
    uuid.UUID(thread_id)
    raw_request_id = body.get("requestId") or body.get("id")
    if not isinstance(raw_request_id, str) or not raw_request_id.strip():
        raise ValueError("缺少有效的分支请求标识")
    request_id = raw_request_id.strip()
    if len(request_id) > 64:
        raise ValueError("分支请求标识长度超出限制")
    try:
        uuid.UUID(request_id)
    except (ValueError, AttributeError) as exc:
        raise ValueError("分支请求标识必须为有效的UUID格式") from exc

    key = body.get("key")
    version = body.get("version")
    if (
        not isinstance(key, str)
        or not key.strip()
        or not isinstance(version, str)
        or not version.strip()
    ):
        raise ValueError("分支参数无效，请提供消息 key 与 version")

    client_epoch = body.get("epoch")
    if not isinstance(client_epoch, str) or not client_epoch.strip():
        raise ValueError("分支参数无效，请提供消息轮次标识 (epoch)")

    # 保持 Bridge.lock 贯穿幂等检查→pending→RPC→receipt
    with bridge.lock:
        # 同源 scope 验证在重放 receipt 前也要执行
        source_entry = entry or bridge._scoped_record(thread_id)
        source_cwd = source_entry.get("cwd")
        if not source_cwd:
            raise ValueError("源会话缺少有效的工作区路径")
        try:
            resolved_source_cwd = Path(source_cwd).resolve(strict=True)
        except (OSError, RuntimeError) as e:
            raise PermissionError("源会话工作区无效") from e

        # 1. 检查已有的创建记录（幂等性保护：同 requestId 同 payload 返回原 receipt，异 payload 拒绝）
        with bridge.registry_lock:
            prior = copy.deepcopy(bridge.records.get("creations", {}).get(request_id))

        if prior:
            if (
                prior.get("action") != "fork"
                or prior.get("sourceThreadId") != thread_id
                or prior.get("key") != key
                or prior.get("version") != version
                or prior.get("epoch") != client_epoch
            ):
                raise ValueError("同一请求标识不能用于不同的分支操作")
            if prior.get("deleted"):
                raise ValueError("此创建请求对应的分支会话已删除，请重新新建聊天")

            child_id = prior.get("id") or prior.get("childId")
            if prior.get("status") == "created" and child_id:
                # 查 receipt.deleted 并核 child 身份
                with bridge.registry_lock:
                    child_entry = bridge.records.get("threads", {}).get(child_id)
                if not child_entry or child_entry.get("deleted"):
                    raise ValueError("分支会话已删除或不存在")
                if child_entry.get("parent") != thread_id:
                    raise ValueError("分支会话来源标识不匹配")
                forked_from = child_entry.get("forkedFrom") or {}
                if forked_from.get("threadId") != thread_id:
                    raise ValueError("分支会话父级关系不匹配")

                return {
                    "ok": True,
                    "id": child_id,
                    "childId": child_id,
                    "status": "created",
                    "title": prior.get("title") or child_entry.get("title"),
                    "cwd": prior.get("cwd") or child_entry.get("cwd"),
                    "named": prior.get("named", True),
                    "reused": True,
                }
            raise ValueError("上次分支创建结果未确认，请检查记录，避免重复创建")

        # 2. 从自身 timeline 验证，不能信任客户提供的伪造数据
        chat = bridge.session(thread_id, attach=False)
        with chat.condition:
            chat.timeline.update(bridge._with_title_override(thread_id, chat.view()))

            # 与自身 Timeline.epoch 严格比对
            if client_epoch != chat.timeline.epoch:
                raise ValueError("选定的消息位置已变化，请刷新后重试")

            position = chat.timeline.positions.get(key)
            if position is None:
                raise ValueError("选定的消息位置已变化，请刷新后重试")
            row = chat.timeline.rows[position]
            if row.get("version") != version:
                raise ValueError("选定的消息内容已变化，请刷新后重试")
            if row.get("role") != "user":
                raise ValueError("仅支持在用户消息处创建分支")
            if not row.get("forkable"):
                raise ValueError("此消息不支持创建分支")
            before_turn_id = row["turnId"]
            if not before_turn_id or before_turn_id == "history":
                raise ValueError("无法获取有效的轮次标识进行分支")

            source_title = (
                source_entry.get("title") or chat.state.get("title") or "未命名聊天"
            )

            # 核 prefix 必须恰好源选定 turn 之前完整 native turn IDs，不止“不含未来”
            source_view = chat.view()
            source_is_partial = source_view.get("historyComplete") is False
            expected_prefix_turn_ids = []
            excluded_turn_ids = set()
            reached_target = False
            for t in source_view.get("turns", []):
                if t.get("id") == before_turn_id:
                    reached_target = True
                if reached_target and t.get("id"):
                    excluded_turn_ids.add(t["id"])
            for t in source_view.get("turns", []):
                t_id = t.get("id")
                if t_id == before_turn_id:
                    break
                if t_id and t_id != "history":
                    expected_prefix_turn_ids.append(t_id)

        title = (source_title[:80] + " · 分支").strip()

        # 3. schema 检查必须在写 pending 前（明确 unsupported 不能永久 pending）
        validate_thread_fork_schema(bridge.executable)

        # 4. 创建持久 pending 意图，先 save 再 RPC！
        with bridge.registry_lock:
            bridge.records.setdefault("creations", {})
            bridge.records["creations"][request_id] = {
                "action": "fork",
                "sourceThreadId": thread_id,
                "beforeTurnId": before_turn_id,
                "key": key,
                "version": version,
                "epoch": client_epoch,
                "title": title,
                "cwd": str(resolved_source_cwd),
                "status": "pending",
                "at": time.time(),
            }
            bridge.save()

        # 5. 执行 RPC（同 backend historySocket -> SharedRuntime，不另起不同 Home）
        backend = (
            bridge._history_backend()
            if (bridge.history_socket and source_entry.get("runtime") == "history")
            else bridge.runtime
        )
        backend.start()

        # 精确白名单参数：threadId, beforeTurnId, deferGoalContinuation, ephemeral, excludeTurns
        params = {
            "threadId": thread_id,
            "beforeTurnId": before_turn_id,
            "deferGoalContinuation": True,
            "ephemeral": False,
            "excludeTurns": False,
        }

        try:
            result = backend.request("thread/fork", params, timeout=30)
        except Exception as exc:
            # 超时或未知响应绝不自动重复 thread/fork/回退 thread/start（防多建会话）
            raise ValueError("分支创建结果待确认，请刷新检查，避免重复创建") from exc

        # 6. 校验返回结果
        thread = result.get("thread") or {}
        child_id = thread.get("id")
        if not child_id:
            raise ValueError("分支结果未返回有效的会话标识")
        try:
            uuid.UUID(child_id)
        except (ValueError, AttributeError) as exc:
            raise ValueError("分支结果会话标识格式无效") from exc
        if child_id == thread_id:
            raise ValueError("分支结果与源会话标识相同，分支无效")

        if thread.get("ephemeral") is True:
            raise ValueError("分支会话不能为临时会话")

        raw_child_cwd = thread.get("cwd")
        if not raw_child_cwd or not isinstance(raw_child_cwd, str):
            raise ValueError("分支结果未返回有效的工作区路径")
        try:
            resolved_child_cwd = Path(raw_child_cwd).resolve(strict=True)
        except (OSError, RuntimeError) as e:
            raise PermissionError("分支工作区无效") from e

        # child_cwd 实际需精确等于源 canonical cwd；不同 cwd 同 workspace 也拒绝
        if resolved_child_cwd != resolved_source_cwd:
            raise PermissionError("分支返回的工作区与源会话工作区不一致")

        # turns 缺失不能当 [] 首轮成功
        if "turns" not in thread or not isinstance(thread["turns"], list):
            raise ValueError("分支结果未返回轮次列表")
        child_turns = thread["turns"]
        actual_child_turn_ids = [t.get("id") for t in child_turns if t.get("id")]
        matches_prefix = actual_child_turn_ids == expected_prefix_turn_ids
        if source_is_partial:
            # Loaded history may be a suffix. The native beforeTurnId schema
            # guarantees the cutoff; verify every known predecessor and reject
            # the selected/future turns without mistaking unloaded ancestors
            # for an invalid extra prefix.
            matches_prefix = (len(actual_child_turn_ids) >= len(expected_prefix_turn_ids)
                and (not expected_prefix_turn_ids or actual_child_turn_ids[-len(expected_prefix_turn_ids):] == expected_prefix_turn_ids)
                and not excluded_turn_ids.intersection(actual_child_turn_ids))
        if not matches_prefix:
            raise ValueError("分支结果轮次与源选定轮次之前的轮次不一致")

        # 7. 检验 rollout path 与 Desktop 同步证据
        target_home = (
            bridge.history_home
            if (bridge.history_socket and source_entry.get("runtime") == "history")
            else bridge.store.home
        )
        raw_path = thread.get("path")
        thread_path = bridge._validated_rollout_path(raw_path, target_home)
        if raw_path and not thread_path:
            raise PermissionError("分支返回的会话存储路径不在合法的存储目录内")
        if thread_path:
            try:
                with open(thread_path, "rb") as f:
                    f.read(1)
            except OSError as e:
                raise PermissionError("分支会话存储文件不可读取") from e
        if source_entry.get("runtime") == "history" and not thread_path:
            raise PermissionError(
                "未验证分支存储路径位于同一桌面主目录，无法建立桌面同步"
            )

        # 8. 诚实两阶段 receipt：
        # 阶段一：先持久 childId 再单独命名，命名失败保留 child 可核状态，不允许再发 thread/fork
        child_runtime = source_entry.get(
            "runtime", "history" if bridge.history_socket else "web"
        )
        child_entry = {
            "title": title,
            "cwd": str(resolved_source_cwd),
            "runtime": child_runtime,
            "createdAt": time.time(),
            "updatedAt": time.time(),
            "parent": thread_id,
            "forkedFrom": {
                "threadId": thread_id,
                "beforeTurnId": before_turn_id,
            },
        }
        # 保留模型/权限/cwd 继承白名单
        for attr in ("model", "effort", "approvalPolicy", "permissionMode"):
            if attr in source_entry and source_entry[attr] is not None:
                child_entry[attr] = source_entry[attr]
        if thread_path:
            child_entry["path"] = thread_path

        with bridge.registry_lock:
            bridge.records["threads"][child_id] = child_entry
            bridge.records["creations"][request_id]["id"] = child_id
            bridge.records["creations"][request_id]["childId"] = child_id
            bridge.records["creations"][request_id]["status"] = "created"
            bridge.save()

        # 阶段二：单独对 thread/name/set 命名，命名失败保留 child 可核状态，不假报 title
        named = True
        try:
            backend.request(
                "thread/name/set", {"threadId": child_id, "name": title}, timeout=15
            )
        except (OSError, RuntimeError, ValueError, TimeoutError):
            named = False

        with bridge.registry_lock:
            bridge.records["creations"][request_id]["named"] = named
            if not named:
                bridge.records["creations"][request_id]["titleApplied"] = False
                child_entry["title"] = "未命名分支"
            bridge.save()

        # 挂载 live Chat 并启动队列，不停止源线程
        from bridge.clients.codex.standalone import Chat

        child_chat = Chat(bridge, child_id, result, backend)
        bridge.live[child_id] = child_chat
        bridge._start_queue(child_chat)

        return {
            "ok": True,
            "id": child_id,
            "childId": child_id,
            "sourceThreadId": thread_id,
            "cwd": str(resolved_source_cwd),
            "title": title if named else "未命名分支",
            "named": named,
            "status": "created",
        }
