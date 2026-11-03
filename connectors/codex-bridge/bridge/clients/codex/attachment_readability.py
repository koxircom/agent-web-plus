"""Read exact upload bytes using the existing Desktop receiver's Windows token.

No ACL edits, privilege enabling, helper executors, or alternate user logons.
An unavailable receiver check is unknown, never a successful uploader check.
"""
import ctypes
import hashlib
import json
import os
import re
import subprocess
import threading
from contextlib import contextmanager
from ctypes import wintypes
from pathlib import Path

from bridge.features.workspace.uploads import MAX_FILE, MAX_FILES, MAX_TOTAL


class AttachmentReadError(ValueError):
    dispatched = False
    retryable = False
    stage = "attachment_read"

    def __init__(self, code, message, *, attachment=None, winerror=None, unknown=False):
        super().__init__(message)
        self.code = code
        self.evidence = {"code": code, "status": "unknown" if unknown else "failed"}
        if attachment:
            self.evidence["attachmentId"] = attachment.get("id")
            self.evidence["name"] = attachment.get("name")
        if winerror is not None:
            self.evidence["winerror"] = winerror


def same_creation_time(kernel_ticks, wmi_ticks):
    # WMI timestamps have microsecond precision; FILETIME also includes 100 ns.
    return kernel_ticks // 10 == wmi_ticks // 10


def receiver_processes(ipc, expected_executable):
    """Resolve only app-server children of the connected local Desktop broker."""
    if os.name != "nt" or not expected_executable:
        raise AttachmentReadError("receiver_probe_unavailable", "附件读取检查未完成：此入口需要 Windows 接收进程；未发送。", unknown=True)
    api = ctypes.WinDLL("kernel32", use_last_error=True)
    get_pid = api.GetNamedPipeServerProcessId
    get_pid.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG)]
    get_pid.restype = wintypes.BOOL
    pid = wintypes.ULONG()
    with ipc.lock:
        handle = getattr(ipc.socket, "handle", None)
        if handle is None or not get_pid(handle, ctypes.byref(pid)):
            raise AttachmentReadError("receiver_probe_unavailable", "附件读取检查未完成：无法确认当前桌面接收进程；未发送。", unknown=True)
    # The PID is an integer obtained from the live pipe, never user command text.
    script = (
        f"@(Get-CimInstance Win32_Process -Filter 'ParentProcessId={pid.value}' | "
        "Where-Object { $_.Name -ieq 'codex.exe' -and $_.CommandLine -match '(^|\\s)app-server(\\s|$)' } | "
        "ForEach-Object { @{pid=$_.ProcessId; executable=$_.ExecutablePath; createdTicks=$_.CreationDate.ToUniversalTime().ToFileTimeUtc()} }) | ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                                capture_output=True, text=True, timeout=8, check=True,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        rows = json.loads(result.stdout or "[]")
        rows = rows if isinstance(rows, list) else [rows]
        if not rows or len(rows) > 16 or any(not isinstance(r, dict) or not isinstance(r.get("pid"), int)
                or not isinstance(r.get("createdTicks"), int) or not isinstance(r.get("executable"), str)
                or os.path.normcase(os.path.normpath(r["executable"])) != os.path.normcase(os.path.normpath(expected_executable)) for r in rows):
            raise ValueError("Receiver identity unavailable")
        return rows
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise AttachmentReadError("receiver_probe_unavailable", "附件读取检查未完成：无法定位当前桌面的 Codex 接收进程；未发送。", unknown=True) from exc


@contextmanager
def receiver_identity(process):
    """Impersonate an existing receiver token on this thread and always restore it."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE, *([ctypes.POINTER(wintypes.FILETIME)] * 4)]
    kernel.GetProcessTimes.restype = wintypes.BOOL
    security.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    security.OpenProcessToken.restype = wintypes.BOOL
    security.DuplicateTokenEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, ctypes.c_int, ctypes.c_int, ctypes.POINTER(wintypes.HANDLE)]
    security.DuplicateTokenEx.restype = wintypes.BOOL
    security.ImpersonateLoggedOnUser.argtypes = [wintypes.HANDLE]
    security.ImpersonateLoggedOnUser.restype = wintypes.BOOL
    security.RevertToSelf.argtypes = []
    security.RevertToSelf.restype = wintypes.BOOL
    handle = token = duplicate = None
    impersonating = False
    try:
        handle = kernel.OpenProcess(0x1000, False, process["pid"])
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        created, exited, kernel_time, user_time = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not same_creation_time(created.dwHighDateTime << 32 | created.dwLowDateTime, process["createdTicks"]):
            raise ValueError("Receiver process identity changed")
        size = wintypes.DWORD(32768)
        image = ctypes.create_unicode_buffer(size.value)
        if not kernel.QueryFullProcessImageNameW(handle, 0, image, ctypes.byref(size)):
            raise ctypes.WinError(ctypes.get_last_error())
        if os.path.normcase(image.value) != os.path.normcase(process["executable"]):
            raise ValueError("Receiver process changed")
        token, duplicate = wintypes.HANDLE(), wintypes.HANDLE()
        if not security.OpenProcessToken(handle, 0x000A, ctypes.byref(token)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not security.DuplicateTokenEx(token, 0x000C, None, 2, 2, ctypes.byref(duplicate)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not security.ImpersonateLoggedOnUser(duplicate):
            raise ctypes.WinError(ctypes.get_last_error())
        impersonating = True
        yield
    finally:
        try:
            if impersonating and not security.RevertToSelf():
                raise ctypes.WinError(ctypes.get_last_error())
        finally:
            for value in (duplicate, token, handle):
                if value:
                    kernel.CloseHandle(value)


def _check_attachments(ipc, files, expected_executable):
    if not files:
        return {"status": "not_applicable", "reason": "no_attachments"}
    receivers = receiver_processes(ipc, expected_executable)
    checked = []
    for receiver in receivers:
        try:
            with receiver_identity(receiver):
                for row in files:
                    try:
                        digest = hashlib.sha256()
                        size = 0
                        with Path(row["path"]).open("rb") as stream:
                            while chunk := stream.read(1024 * 1024):
                                size += len(chunk)
                                if size > row["size"]:
                                    break
                                digest.update(chunk)
                        if size != row["size"] or digest.hexdigest() != row["sha256"]:
                            raise AttachmentReadError("receiver_attachment_changed", "附件读取检查失败：接收方读取的内容与上传内容不一致；未发送。", attachment=row)
                    except OSError as exc:
                        denied = isinstance(exc, PermissionError)
                        code = "receiver_attachment_access_denied" if denied else "receiver_attachment_unreadable"
                        raise AttachmentReadError(code, f"附件读取检查失败：接收方无法读取「{row['name']}」；未发送。", attachment=row,
                                                  winerror=getattr(exc, "winerror", None)) from exc
            checked.append(receiver["pid"])
        except AttachmentReadError:
            raise
        except (OSError, ValueError) as exc:
            raise AttachmentReadError("receiver_probe_unavailable", "附件读取检查未完成：无法使用接收方身份验证；未发送。", winerror=getattr(exc, "winerror", None), unknown=True) from exc
    return {"status": "confirmed", "evidence": "receiver_token_read_sha256", "receiverCount": len(checked),
            "attachments": [{"id": r["id"], "sha256": r["sha256"], "size": r["size"]} for r in files],
            "scope": "filesystem_readability_only", "modelContentRead": "unobserved"}


def check_attachments(ipc, files, expected_executable=None):
    if not files:
        return {"status": "not_applicable", "reason": "no_attachments"}
    if (len(files) > MAX_FILES or any(not isinstance(r, dict) or not isinstance(r.get("size"), int)
            or isinstance(r.get("size"), bool) or not 0 < r["size"] <= MAX_FILE
            or not isinstance(r.get("sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", r["sha256"])
            or not all(isinstance(r.get(k), str) and r[k] for k in ("id", "name", "path")) for r in files)
            or sum(r["size"] for r in files) > MAX_TOTAL):
        raise AttachmentReadError("receiver_attachment_metadata_invalid", "附件读取检查失败：附件元数据无效；未发送。")
    # Never impersonate on a reusable HTTP worker. Even a failed RevertToSelf
    # cannot leave another request running with the receiver's token.
    finished = threading.Event()
    outcome = {}

    def run():
        try:
            outcome["proof"] = _check_attachments(ipc, files, expected_executable)
        except Exception as exc:
            outcome["error"] = exc
        finally:
            finished.set()

    threading.Thread(target=run, name="attachment-receiver-probe", daemon=True).start()
    if not finished.wait(12):
        raise AttachmentReadError("receiver_probe_timeout", "附件读取检查超时：尚未确认接收方可读；未发送。", unknown=True)
    if "error" in outcome:
        raise outcome["error"]
    return outcome["proof"]
