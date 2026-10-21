import { isCodexSessionId, codexThreadId } from "../execution-engine-settings";
import { codexBridgeJson, CodexBridgeError } from "./codex-bridge-client";

export interface CodexSubagentItem {
  id: string;
  parentId: string;
  title: string;
  nickname?: string;
  role?: string;
  path?: string;
  updated?: number;
  archived: boolean;
  status: string;
}

export interface CodexSubagentsListResponse {
  agents: CodexSubagentItem[];
  limited: boolean;
}

export interface CodexSubagentMessage {
  id: string;
  role: string;
  kind?: string;
  text?: string;
  title?: string;
  output?: string;
}

export interface CodexSubagentTurn {
  id: string;
  status?: string;
  messages: CodexSubagentMessage[];
}

export interface CodexSubagentDetailResponse {
  id: string;
  parentId: string;
  title: string;
  nickname?: string;
  role?: string;
  status: string;
  turns: CodexSubagentTurn[];
  historyComplete?: boolean;
  saved: boolean;
  updated?: number;
  archived?: boolean;
}

export async function fetchCodexSubagents(
  threadId: string,
  agentId?: string | null,
  signal?: AbortSignal
): Promise<CodexSubagentsListResponse | CodexSubagentDetailResponse> {
  if (!isCodexSessionId(threadId)) {
    throw new CodexBridgeError("非 Codex 会话不支持原生子智能体", 400);
  }
  const rawId = codexThreadId(threadId);
  const query = agentId ? `?id=${encodeURIComponent(agentId)}` : "";
  return await codexBridgeJson(`/api/sessions/${rawId}/subagents${query}`, undefined, { signal });
}
