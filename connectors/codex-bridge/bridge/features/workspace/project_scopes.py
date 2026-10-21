"""Project-scoped path validation, Git repository and worktree isolation for Codex."""

import os
import re
import stat
import subprocess
import threading
from pathlib import Path

SAFE_BRANCH_PATTERN = re.compile(r"^[a-zA-Z0-9._/-]+$")


def _read_stream_bounded(stream, limit, result_list):
    """Read stream with bounded memory, discarding subsequent bytes so child does not block."""
    chunks = []
    total = 0
    try:
        while True:
            chunk = stream.read(min(65536, max(1, limit - total)))
            if not chunk:
                break
            if total < limit:
                take = min(len(chunk), limit - total)
                chunks.append(chunk[:take])
                total += take
            else:
                while stream.read(65536):
                    pass
                break
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except OSError:
            pass
        result_list.append(b"".join(chunks))


def run_git_command(cwd, args, timeout=10, limit=2 * 1024 * 1024, pass_fds=()):
    """Run an isolated git inspection/mutation command with bounded timeout and safe environment."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        {
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_NO_LAZY_FETCH": "1",
            "LC_ALL": "C",
        }
    )
    base_cmd = [
        "git",
        "--no-pager",
        "--no-optional-locks",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "protocol.allow=never",
        "-c",
        "core.hooksPath=/dev/null",
    ]
    try:
        process = subprocess.Popen(
            base_cmd + args,
            cwd=str(cwd),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=pass_fds,
        )
    except FileNotFoundError:
        raise ValueError("执行端未安装 Git") from None

    stdout_buf = []
    stderr_buf = []
    t_out = threading.Thread(target=_read_stream_bounded, args=(process.stdout, limit, stdout_buf))
    t_err = threading.Thread(target=_read_stream_bounded, args=(process.stderr, limit, stderr_buf))
    t_out.daemon = True
    t_err.daemon = True
    t_out.start()
    t_err.start()

    expired = threading.Event()

    def on_timeout():
        expired.set()
        try:
            process.kill()
        except OSError:
            pass

    timer = threading.Timer(timeout, on_timeout)
    timer.start()
    try:
        process.wait()
        t_out.join()
        t_err.join()
        if expired.is_set():
            raise ValueError("Git 操作超时，请检查仓库状态后重试")
        out = stdout_buf[0] if stdout_buf else b""
        err = stderr_buf[0] if stderr_buf else b""
        return process.returncode, out, err
    finally:
        timer.cancel()
        if process.poll() is None:
            try:
                process.kill()
                process.wait()
            except OSError:
                pass


def resolve_scoped_cwd(candidate_path, workspaces, must_exist=True):
    """Validate that candidate_path resolves strictly within one of the configured workspaces.

    Returns (matching_workspace, canonical_path).
    Raises ValueError or PermissionError on violation.
    """
    if not isinstance(candidate_path, str) or not candidate_path.strip():
        raise ValueError("工作区路径不能为空")
    candidate_path = candidate_path.strip()
    if len(candidate_path) > 4096 or any(ord(c) < 32 for c in candidate_path):
        raise ValueError("路径包含非法字符")

    path = Path(candidate_path)
    if not path.is_absolute():
        raise ValueError("工作区路径必须为绝对路径")

    try:
        resolved = path.resolve(strict=must_exist)
    except FileNotFoundError:
        raise ValueError(f"目录不存在: {candidate_path}")
    except OSError as err:
        raise ValueError(f"无法访问路径: {err}")

    # Check for symlink traversal or escape against configured workspaces
    matching_ws = None
    for ws in workspaces:
        ws_path = Path(ws["path"]).resolve(strict=True)
        if resolved == ws_path or resolved.is_relative_to(ws_path):
            matching_ws = ws
            break

    if not matching_ws:
        raise PermissionError("所选目录超出已配置的 Codex 工作区范围")

    if must_exist and not resolved.is_dir():
        raise ValueError(f"所选路径不是有效目录: {candidate_path}")

    return matching_ws, resolved


def browse_scoped_directories(canonical_cwd, workspace):
    """List direct child directories within canonical_cwd without leaking external symlinks."""
    ws_path = Path(workspace["path"]).resolve(strict=True)
    if not (canonical_cwd == ws_path or canonical_cwd.is_relative_to(ws_path)):
        raise PermissionError("目录超出项目范围")

    parent_path = "/" if canonical_cwd == ws_path else str(canonical_cwd.parent)
    dirs = []
    try:
        with os.scandir(canonical_cwd) as it:
            for entry in it:
                if entry.name.startswith("."):
                    continue
                try:
                    st = entry.stat(follow_symlinks=False)
                    if stat.S_ISDIR(st.st_mode):
                        # Ensure real path does not escape configured workspace
                        target = Path(entry.path).resolve()
                        if target.is_relative_to(ws_path):
                            dirs.append({"name": entry.name, "path": str(entry.path)})
                except OSError:
                    continue
    except OSError as e:
        raise ValueError(f"无法读取目录: {e}")

    dirs.sort(key=lambda d: d["name"].casefold())
    return {
        "path": str(canonical_cwd),
        "parentPath": parent_path,
        "directories": dirs,
    }


def get_scoped_worktree_info(canonical_cwd, workspace):
    """Inspect git repository and worktrees for canonical_cwd.

    If not a git repository, returns { isGit: False, ... } gracefully without raising.
    Stable projectRoot and UI projectKey are derived from the native main worktree.
    """
    ws_path = Path(workspace["path"]).resolve(strict=True)
    code, out, _ = run_git_command(
        canonical_cwd, ["rev-parse", "--is-inside-work-tree"], timeout=10
    )
    if code != 0 or out.strip() != b"true":
        return {
            "isGit": False,
            "projectRoot": str(ws_path),
            "projectKey": f"codex:{ws_path!s}",
            "configKey": workspace["key"],
            "isTopLevel": False,
            "currentWorktreePath": None,
            "worktrees": [],
        }

    # Verify git common-dir stays inside authorized workspace
    code, common_dir_bytes, _ = run_git_command(
        canonical_cwd, ["rev-parse", "--git-common-dir"], timeout=10
    )
    if code != 0 or not common_dir_bytes.strip():
        return {
            "isGit": False,
            "projectRoot": str(ws_path),
            "projectKey": f"codex:{ws_path!s}",
            "configKey": workspace["key"],
            "isTopLevel": False,
            "currentWorktreePath": None,
            "worktrees": [],
        }

    common_dir_str = os.fsdecode(common_dir_bytes.strip())
    common_dir = (
        (canonical_cwd / common_dir_str).resolve()
        if not Path(common_dir_str).is_absolute()
        else Path(common_dir_str).resolve()
    )
    if not (common_dir == ws_path or common_dir.is_relative_to(ws_path)):
        raise PermissionError("Git common-dir 超出项目授权范围")

    # List worktrees using NUL-delimited porcelain output to prevent quotedpath/newline ambiguity
    code, wt_data, _ = run_git_command(
        canonical_cwd, ["worktree", "list", "--porcelain", "-z"], timeout=10
    )
    if code != 0:
        raise ValueError("无法列出 Git 工作树")

    raw_items = wt_data.split(b"\x00")
    records = []
    current_entry = {}
    for item in raw_items:
        if not item:
            if current_entry:
                records.append(current_entry)
                current_entry = {}
            continue
        if item.startswith(b"worktree "):
            current_entry["path"] = os.fsdecode(item[len(b"worktree ") :])
        elif item.startswith(b"branch "):
            ref = os.fsdecode(item[len(b"branch ") :])
            current_entry["branch"] = ref.removeprefix("refs/heads/")
        elif item.startswith(b"HEAD "):
            current_entry["head"] = os.fsdecode(item[len(b"HEAD ") :])
        elif item == b"bare":
            current_entry["bare"] = True
        elif item == b"detached":
            current_entry["detached"] = True
    if current_entry:
        records.append(current_entry)

    if not records:
        raise ValueError("无法解析 Git 工作树列表")

    # Native Git guarantees records[0] is the main worktree
    main_raw_path = records[0].get("path")
    if not main_raw_path:
        raise ValueError("无法确定 Git 主仓库路径")
    try:
        main_root = Path(main_raw_path).resolve(strict=True)
    except OSError as e:
        raise PermissionError(f"Git 主仓库路径无效或符号链接损坏: {e}") from None

    if not (main_root == ws_path or main_root.is_relative_to(ws_path)):
        raise PermissionError("Git 仓库根路径超出项目授权范围")

    worktrees = []
    current_worktree_path = None

    for rec in records:
        if rec.get("bare") or not rec.get("path"):
            continue
        wt_path_str = rec["path"]
        try:
            wt_resolved = Path(wt_path_str).resolve(strict=True)
        except OSError as e:
            raise PermissionError(f"工作树路径无法解析或符号链接损坏: {wt_path_str} ({e})") from None

        if not (wt_resolved == ws_path or wt_resolved.is_relative_to(ws_path)):
            raise PermissionError(f"工作树路径超出项目授权根: {wt_path_str}")

        is_main = (wt_resolved == main_root)
        branch_name = rec.get("branch") or (
            rec.get("head")[:8] if rec.get("head") else "detached"
        )
        worktrees.append(
            {
                "path": str(wt_resolved),
                "branch": branch_name,
                "isMain": is_main,
            }
        )

        if (canonical_cwd == wt_resolved or canonical_cwd.is_relative_to(wt_resolved)) and (
            current_worktree_path is None or len(str(wt_resolved)) > len(current_worktree_path)
        ):
            current_worktree_path = str(wt_resolved)

    is_top_level = any(canonical_cwd == Path(wt["path"]) for wt in worktrees)
    return {
        "isGit": True,
        "projectRoot": str(main_root),
        "projectKey": f"codex:{main_root!s}",
        "configKey": workspace["key"],
        "isTopLevel": is_top_level,
        "currentWorktreePath": current_worktree_path,
        "worktrees": worktrees,
    }


def create_scoped_worktree(canonical_cwd, branch, workspace):
    """Safely create a new worktree in a controlled directory inside workspace scope."""
    if not isinstance(branch, str) or not branch.strip():
        raise ValueError("分支名称不能为空")
    branch = branch.strip()
    if (
        len(branch) > 200
        or branch.startswith("-")
        or not SAFE_BRANCH_PATTERN.fullmatch(branch)
    ):
        raise ValueError("分支名称无效或包含非法字符")

    # Validate ref format
    code, _, _ = run_git_command(
        canonical_cwd, ["check-ref-format", "--branch", branch], timeout=5
    )
    if code != 0:
        raise ValueError("分支名称格式不符合 Git 规范")

    wt_info = get_scoped_worktree_info(canonical_cwd, workspace)
    if not wt_info.get("isGit"):
        raise ValueError("当前目录不是 Git 工作区，无法创建工作树")

    main_root = Path(wt_info["projectRoot"]).resolve(strict=True)
    ws_path = Path(workspace["path"]).resolve(strict=True)

    # Check if branch already checked out
    for wt in wt_info.get("worktrees", []):
        if wt.get("branch") == branch:
            raise ValueError(f"分支 '{branch}' 已在工作树 '{wt.get('path')}' 中检出")

    # Determine controlled storage location
    sanitized_branch = re.sub(r"[^a-zA-Z0-9._-]", "-", branch)
    # Prefer sibling directory <repoRoot>-worktrees if it stays within workspace
    sibling_wt_base = main_root.parent / f"{main_root.name}-worktrees"
    if sibling_wt_base.resolve().is_relative_to(ws_path):
        target_path = (sibling_wt_base / sanitized_branch).resolve()
    else:
        # Fall back to inside repo .worktrees
        target_path = (main_root / ".worktrees" / sanitized_branch).resolve()

    if not target_path.is_relative_to(ws_path):
        raise PermissionError("目标工作树目录超出已配置的项目授权根")

    if target_path.exists():
        raise ValueError(f"目标工作树目录已存在: {target_path}")

    target_parent = target_path.parent
    target_parent.mkdir(parents=True, exist_ok=True, mode=0o755)

    # Check whether branch exists locally
    code, _, _ = run_git_command(
        main_root,
        ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
        timeout=10,
    )
    branch_exists = code == 0

    # Pin both directories across exec, not merely during a preflight check.
    # This connector runs on Linux/WSL; procfs is mandatory, never a weak fallback.
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    parent_fd = os.open(target_parent, flags)
    try:
        main_fd = os.open(main_root, flags)
        try:
            for fd in (parent_fd, main_fd):
                physical = Path(os.readlink(f"/proc/self/fd/{fd}"))
                if not physical.is_relative_to(ws_path) or os.fstat(fd).st_uid != os.getuid():
                    raise PermissionError("工作树目录归属或授权范围已改变")
            filter_code, filter_keys, _ = run_git_command(main_root, [
                'config', '--name-only', '--get-regexp', r'^filter\..*\.(smudge|process|required)$'])
            if filter_code not in (0, 1):
                raise ValueError("无法确认仓库过滤器配置")
            cmd = []
            for key in filter_keys.decode('utf-8', 'strict').splitlines():
                cmd.extend(['-c', key + ('=false' if key.endswith('.required') else '=')])
            cmd.extend(["worktree", "add"])
            if not branch_exists:
                cmd.extend(["-b", branch])
            cmd.append(f"/proc/self/fd/{parent_fd}/{target_path.name}")
            if branch_exists:
                cmd.append(branch)
            code, out, err = run_git_command(f"/proc/self/fd/{main_fd}", cmd, timeout=30,
                                             pass_fds=(parent_fd, main_fd))
            if code != 0:
                err_msg = (err or out).decode('utf-8', 'replace').strip()
                raise ValueError(f"工作树操作未完成，请先核对现有工作树再重试: {err_msg}")
            target_path = Path(os.readlink(f"/proc/self/fd/{parent_fd}")) / target_path.name
            if not target_path.resolve(strict=True).is_relative_to(ws_path):
                raise PermissionError("新工作树授权范围已改变")
        finally:
            os.close(main_fd)
    finally:
        os.close(parent_fd)

    # Post-creation safety validation on target directory fd
    target_flags = os.O_RDONLY | os.O_DIRECTORY
    if hasattr(os, "O_NOFOLLOW"):
        target_flags |= os.O_NOFOLLOW
    try:
        target_fd = os.open(str(target_path), target_flags)
        try:
            if os.path.exists(f"/proc/self/fd/{target_fd}"):
                real_target = Path(os.path.realpath(f"/proc/self/fd/{target_fd}")).resolve()
                if not (real_target == ws_path or real_target.is_relative_to(ws_path)):
                    raise PermissionError("新建工作树发生符号链接逃逸")
        finally:
            os.close(target_fd)
    except OSError as e:
        raise PermissionError(f"新建工作树安全验证失败: {e}") from None

    # Post-creation validation: verify common-dir matches main_root
    code, new_common_bytes, _ = run_git_command(
        target_path, ["rev-parse", "--git-common-dir"], timeout=10
    )
    if code != 0 or not new_common_bytes.strip():
        raise ValueError("创建的工作树无法读取仓库元数据")
    new_common_str = os.fsdecode(new_common_bytes.strip())
    new_common = (
        (target_path / new_common_str).resolve()
        if not Path(new_common_str).is_absolute()
        else Path(new_common_str).resolve()
    )
    orig_code, orig_common_bytes, _ = run_git_command(
        main_root, ["rev-parse", "--git-common-dir"], timeout=10
    )
    if orig_code == 0 and orig_common_bytes.strip():
        orig_common_str = os.fsdecode(orig_common_bytes.strip())
        orig_common = (
            (main_root / orig_common_str).resolve()
            if not Path(orig_common_str).is_absolute()
            else Path(orig_common_str).resolve()
        )
        if new_common != orig_common:
            raise PermissionError("新建工作树的仓库归属校验失败")

    return {
        "path": str(target_path),
        "branch": branch,
    }


def remove_scoped_worktree(canonical_cwd, path_to_remove, force=False):
    """Forbidden for Codex by security contract."""
    raise PermissionError("Codex 执行端不支持通过网页删除工作树，请在 WSL 终端中管理")
