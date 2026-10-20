// Only known recovery destinations cross the wire; never execute server-supplied URLs or commands.
export type NoticeRecovery = "connection" | "session" | "codex-client";

export function readNoticeRecovery(value: unknown): NoticeRecovery | undefined {
  return value === "connection" || value === "session" || value === "codex-client" ? value : undefined;
}

export function noticeRecoveryFromError(error: unknown): NoticeRecovery | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("recovery" in error) {
    const recovery = readNoticeRecovery(error.recovery);
    if (recovery) return recovery;
  }
  const code = "code" in error ? error.code : undefined;
  if (code === "codex_connection_required") return "connection";
  if (code === "codex_session_refresh") return "session";
  if (code === "codex_operation_unsupported") return "codex-client";
  return undefined;
}

export function noticeRecoveryHelp(recovery?: NoticeRecovery): string {
  switch (recovery) {
    case "connection": return "打开连接设置，检查执行引擎是否启用、服务地址与认证是否正确，再使用设置里的检测按钮。此操作不会重新发送消息。";
    case "session": return "刷新会话状态，重新读取最新消息、队列和待回答的问题。此操作不会重新发送消息；尚未确认的操作请先核对结果。";
    case "codex-client": return "回到发起任务的 Codex 桌面应用或 CLI，打开同一会话处理待确认操作。此网页暂时不能代为处理，无需因此停止任务。可以复制下方会话信息，帮助定位同一任务。";
    default: return "先保留输入内容，核对会话中是否已有执行结果，避免重复发送。若仍无法继续，请复制下方问题信息，通过项目的问题反馈入口提交；提交前请删除私人内容。";
  }
}
