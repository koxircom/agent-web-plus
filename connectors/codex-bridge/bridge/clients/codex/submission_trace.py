"""Evidence-only submission phases. Model prose never verifies task results."""
import copy
import time

from bridge.features.sessions.model import items_array, ordered_turns


LABELS = {"task_received": "已接收任务", "attachment_read": "已读取附件",
          "operation_executed": "已执行操作", "result_verified": "已验证结果"}
OPERATIONS = {"commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"}


def new_trace():
    return {"version": 1, "bridgeReceivedAt": time.time(), "stages": {key: {"label": label, "status": "pending"}
                                       for key, label in LABELS.items()}}


def record(trace, stage, status, **evidence):
    previous = trace["stages"][stage]
    value = {"label": LABELS[stage], "status": status, **evidence}
    if {k: v for k, v in previous.items() if k != "at"} == value:
        return False
    trace["stages"][stage] = {**value, "at": time.time()}
    return True


def observe(entry, state):
    """Use only the exact acknowledged native turn, never the latest turn/text."""
    trace = entry.get("trace")
    if not trace or not entry.get("nativeTurnId"):
        return False
    before = copy.deepcopy(trace)
    turn = next((t for t in ordered_turns(state) if (t.get("turnId") or t.get("id")) == entry["nativeTurnId"]), None)
    if not turn:
        return False
    outcomes = []
    for item in items_array(turn.get("items")):
        kind = item.get("type")
        if kind not in OPERATIONS or item.get("status") not in ("completed", "failed", "declined"):
            continue
        row = {"itemId": item.get("id"), "type": kind, "status": item["status"]}
        if kind == "commandExecution" and isinstance(item.get("exitCode"), int):
            row["exitCode"] = item["exitCode"]
        outcomes.append(row)
    if outcomes:
        previous = trace["stages"]["operation_executed"].get("operations", [])
        merged = {r["itemId"]: r for r in previous}
        merged.update({r["itemId"]: r for r in outcomes})
        outcomes = list(merged.values())
        failed = any(r["status"] != "completed" or r.get("exitCode", 0) != 0 for r in outcomes)
        record(trace, "operation_executed", "failed" if failed else "confirmed",
               evidence="native_operation_items", turnId=entry["nativeTurnId"], operations=outcomes)
    status = turn.get("status")
    if status in ("completed", "failed", "interrupted"):
        trace["nativeTurnStatus"] = status
        if not outcomes and trace["stages"]["operation_executed"]["status"] == "pending":
            record(trace, "operation_executed", "unknown", reason="no_native_operation_evidence")
        record(trace, "result_verified", "pending", reason="independent_verification_required",
               nativeTurnStatus=status)
        error = turn.get("error") or {}
        message = str(error.get("message", "")) if isinstance(error, dict) else str(error)
        paths = entry.get("attachmentPaths", [])
        identifies_attachment = any(p.lower() in message.lower() or p.replace("\\", "/").lower() in message.lower() for p in paths)
        if identifies_attachment and "image" in message.lower() and any(word in message.lower() for word in ("read", "access", "permission")):
            record(trace, "attachment_read", "failed", code="native_attachment_read_failed",
                   evidence="native_turn_error", turnId=entry["nativeTurnId"])
    return trace != before
