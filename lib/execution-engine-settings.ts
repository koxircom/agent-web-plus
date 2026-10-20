import "server-only";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

export interface ExecutionEngineSettings {
  defaultEngine: "pi" | "codex";
  codex: { enabled: boolean; url: string; username: string; password: string };
}
const defaults: ExecutionEngineSettings = {
  defaultEngine: "pi", codex: { enabled: false, url: "", username: "", password: "" },
};
export async function readExecutionEngineSettings(): Promise<ExecutionEngineSettings> {
  try {
    const value = JSON.parse(await readFile(join(getAgentDir(), "execution-engines.json"), "utf8"));
    return { ...defaults, ...value, codex: { ...defaults.codex, ...value.codex } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(defaults);
    throw error;
  }
}
export function publicExecutionEngineSettings(value: ExecutionEngineSettings) {
  const { password, ...codex } = value.codex;
  return { defaultEngine: value.defaultEngine, codex: { ...codex, hasPassword: Boolean(password) } };
}
export async function saveExecutionEngineSettings(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("执行引擎配置格式不正确");
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(k => !["defaultEngine", "codex"].includes(k))) throw new Error("未知执行引擎配置字段");
  const current = await readExecutionEngineSettings();
  if (input.defaultEngine !== undefined) {
    if (input.defaultEngine !== "pi" && input.defaultEngine !== "codex") throw new Error("执行引擎不受支持");
    current.defaultEngine = input.defaultEngine;
  }
  if (input.codex !== undefined) {
    if (!input.codex || typeof input.codex !== "object" || Array.isArray(input.codex)) throw new Error("Codex 配置格式不正确");
    const codex = input.codex as Record<string, unknown>;
    if (Object.keys(codex).some(k => !["enabled", "url", "username", "password", "clearPassword"].includes(k))) throw new Error("未知 Codex 配置字段");
    for (const key of ["url", "username", "password"] as const) {
      if (codex[key] !== undefined && typeof codex[key] !== "string") throw new Error("Codex 配置应为文本");
      if (typeof codex[key] === "string" && (key !== "password" || codex[key])) current.codex[key] = codex[key] as string;
    }
    if (codex.enabled !== undefined) {
      if (typeof codex.enabled !== "boolean") throw new Error("启用状态不正确");
      current.codex.enabled = codex.enabled;
    }
    if (codex.clearPassword !== undefined && typeof codex.clearPassword !== "boolean") throw new Error("清除密码状态不正确");
    if (current.codex.username.length > 200 || current.codex.password.length > 1000 || current.codex.url.length > 2048) throw new Error("连接配置内容过长");
    if (codex.clearPassword === true) current.codex.password = "";
  }
  if (current.codex.url) {
    const url = new URL(current.codex.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("请输入不含凭据、参数和片段的 HTTP(S) 服务地址");
    current.codex.url = url.href.replace(/\/$/, "");
  }
  if (current.defaultEngine === "codex" && (!current.codex.enabled || !current.codex.url)) throw new Error("请先启用并配置 Codex 服务");
  await mkdir(getAgentDir(), { recursive: true, mode: 0o700 });
  const file = join(getAgentDir(), "execution-engines.json");
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(current, null, 2), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
  return publicExecutionEngineSettings(current);
}
export const isCodexSessionId = (id: string) => /^codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
export function codexThreadId(id: string) {
  if (!isCodexSessionId(id)) throw new Error("Codex 会话标识不正确");
  return id.slice(6);
}

export async function codexConnectionIdentity() {
  return createHash("sha256").update(JSON.stringify((await readExecutionEngineSettings()).codex)).digest("hex");
}
