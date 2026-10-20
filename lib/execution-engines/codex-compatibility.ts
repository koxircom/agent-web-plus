import protocol from "../../connectors/codex-bridge/protocol.json";

export interface CodexCompatibilityReport {
  status: "verified" | "legacy";
  protocolVersion?: number;
  message: string;
}
export class CodexCompatibilityError extends Error {
  readonly code = "codex_incompatible";
}
const labels: Record<string, string> = {
  "timeline-v1": "会话历史", "prompt-identity-v1": "消息身份确认",
  "queue-v2": "消息队列", "workspace-files-v1": "工作区文件",
};
/** The API major/capabilities are the contract; product release numbers may differ. */
export function inspectCodexCompatibility(value: unknown, legacyRuntime?: unknown): CodexCompatibilityReport {
  if (value === undefined) {
    if (!legacyRuntime || typeof legacyRuntime !== "object" || (legacyRuntime as { mode?: unknown }).mode !== "standalone") {
      throw new CodexCompatibilityError("此地址不是受支持的独立 Codex 连接器。请使用 Agent Web Plus 安装包附带的连接器，旧版桌面 Bridge 不能直接替代。");
    }
    return { status: "legacy", message: "已连接旧版独立连接器，但它没有声明接口版本，尚不能确认全部能力。建议升级为本项目附带的连接器；现有会话会保留。" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodexCompatibilityError("连接器的接口声明格式不正确，请更新连接器。");
  const descriptor = value as { protocol?: unknown; version?: unknown; capabilities?: unknown };
  if (descriptor.protocol !== protocol.protocol || descriptor.version !== protocol.version) {
    throw new CodexCompatibilityError("连接器接口协议与当前 Agent Web Plus 不兼容。请使用同一 Agent Web Plus 安装包附带的连接器。");
  }
  if (!Array.isArray(descriptor.capabilities) || !descriptor.capabilities.every(item => typeof item === "string")) {
    throw new CodexCompatibilityError("连接器未提供有效的接口能力声明，请更新连接器。");
  }
  const capabilities = new Set(descriptor.capabilities);
  const missing = protocol.capabilities.filter(item => !capabilities.has(item));
  if (missing.length) throw new CodexCompatibilityError(`连接器缺少所需能力：${missing.map(item => labels[item] || item).join("、")}。请更新连接器。`);
  return { status: "verified", protocolVersion: protocol.version, message: `接口兼容检查通过（协议 ${protocol.version}）。` };
}
