import { isBrowserTabAppearance, type BrowserTabAppearance } from "./browser-tab-appearance.ts";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  BROWSER_TAB_TITLE_MAX_CODEPOINTS,
  CONTROL_AND_LINEBREAK_RE,
  clipCodePoints,
  normalizeBrowserTabTitle,
  sanitizeRawBrowserTabTitle,
} from "./browser-tab-title-normalization.ts";

export {
  BROWSER_TAB_TITLE_MAX_CODEPOINTS,
  CONTROL_AND_LINEBREAK_RE,
  clipCodePoints,
  normalizeBrowserTabTitle,
  sanitizeRawBrowserTabTitle,
};

const require = createRequire(import.meta.url);
const { withAgentStateLock } = require("./agent-state-mutex.cjs");

export const AGENT_WEB_SETTINGS_FILE = "agent-web-settings.json";

export interface AgentWebSettings {
  version: 1;
  revision: number;
  title: string;
  tabAppearance?: BrowserTabAppearance | null;
  [key: string]: unknown;
}

export interface BrowserTabTitleSnapshot {
  rawTitle: string;
  customTitle: string;
  revision: number;
  version: number;
}

export class MalformedSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSettingsError";
  }
}

export class SettingsConflictError extends Error {
  currentRevision: number;
  requestedRevision: number;
  constructor(message: string, currentRevision: number, requestedRevision: number) {
    super(message);
    this.name = "SettingsConflictError";
    this.currentRevision = currentRevision;
    this.requestedRevision = requestedRevision;
  }
}



export function resolveAgentDir(explicitAgentDir?: string): string {
  if (explicitAgentDir) return path.resolve(explicitAgentDir);
  const envDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR;
  if (envDir) return path.resolve(envDir);
  try {
    const fromSdk = getAgentDir();
    if (fromSdk) return path.resolve(fromSdk);
  } catch {}
  return path.resolve(path.join(os.homedir(), ".pi", "agent"));
}

export function getAgentWebSettingsPath(agentDir?: string): string {
  return path.join(resolveAgentDir(agentDir), AGENT_WEB_SETTINGS_FILE);
}

export async function readAgentWebSettings(agentDir?: string): Promise<{ settings: AgentWebSettings; exists: boolean }> {
  const filePath = getAgentWebSettingsPath(agentDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "ENOENT") {
        return {
          settings: { version: 1, revision: 0, title: "" },
          exists: false,
        };
      }
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedSettingsError("Failed to parse agent-web-settings.json: invalid JSON (fail closed)");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedSettingsError("Malformed agent-web-settings.json: root must be an object (fail closed)");
  }

  const obj = parsed as Record<string, unknown>;

  // 严格校验已有文件的 schema：禁止静默抹除或默认 fallback，不匹配则 fail closed
  if (obj.version !== 1) {
    throw new MalformedSettingsError("Malformed agent-web-settings.json: invalid or missing version (fail closed)");
  }
  if (
    typeof obj.revision !== "number" ||
    !Number.isSafeInteger(obj.revision) ||
    obj.revision < 0
  ) {
    throw new MalformedSettingsError("Malformed agent-web-settings.json: invalid or missing revision (fail closed)");
  }
  if (typeof obj.title !== "string") {
    throw new MalformedSettingsError("Malformed agent-web-settings.json: invalid or missing title (fail closed)");
  }
  if (obj.title !== sanitizeRawBrowserTabTitle(obj.title)) {
    throw new MalformedSettingsError("Malformed agent-web-settings.json: title violates raw sanity limits (fail closed)");
  }

  if (obj.tabAppearance != null && !isBrowserTabAppearance(obj.tabAppearance)) {
    throw new MalformedSettingsError("Malformed browser tab appearance settings (fail closed)");
  }

  const settings: AgentWebSettings = {
    ...obj,
    version: 1,
    revision: obj.revision,
    title: obj.title,
  };

  return { settings, exists: true };
}

export async function writeAgentWebSettings(
  updates: { title: string; revision: number; appearance?: BrowserTabAppearance | null },
  agentDir?: string
): Promise<AgentWebSettings> {
  const resolvedDir = resolveAgentDir(agentDir);
  const filePath = getAgentWebSettingsPath(resolvedDir);

  return await withAgentStateLock(resolvedDir, async () => {
    // 1. 读取当前文件，malformed fail closed
    const { settings: current, exists } = await readAgentWebSettings(resolvedDir);

    // 2. 检查 revision optimistic concurrency
    const expectedRevision = exists ? current.revision : 0;
    if (updates.revision !== expectedRevision) {
      throw new SettingsConflictError(
        `Revision mismatch: expected ${expectedRevision}, got ${updates.revision}`,
        expectedRevision,
        updates.revision
      );
    }

    // 3. 构建新设置并保留已有 unknown 字段，不触碰 models/credentials
    const nextRevision = expectedRevision + 1;
    const sanitizedTitle = sanitizeRawBrowserTabTitle(updates.title);

    if (updates.appearance != null && !isBrowserTabAppearance(updates.appearance)) throw new Error("Invalid browser tab appearance");
    const nextSettings: AgentWebSettings = {
      ...current,
      version: 1,
      revision: nextRevision,
      title: sanitizedTitle,
      ...(updates.appearance !== undefined ? { tabAppearance: updates.appearance } : {}),
    };

    // 4. 确保目录存在
    await fs.mkdir(resolvedDir, { recursive: true, mode: 0o700 });

    // 5. 写入临时文件并通过 fsync 和原子 rename 提交
    const tmpPath = path.join(
      resolvedDir,
      `.agent-web-settings.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );

    let tmpCreated = false;
    try {
      const jsonStr = JSON.stringify(nextSettings, null, 2) + "\n";
      const fileHandle = await fs.open(tmpPath, "wx", 0o600);
      tmpCreated = true;
      try {
        await fileHandle.writeFile(jsonStr, "utf8");
        await fileHandle.sync();
      } finally {
        await fileHandle.close();
      }

      try {
        await fs.chmod(tmpPath, 0o600);
      } catch {}

      await fs.rename(tmpPath, filePath);
      tmpCreated = false;

      // tmp rename 后 dir fsync 兼容 windows / 不支持目录 fsync 的平台
      try {
        const dirHandle = await fs.open(resolvedDir, "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      } catch {
        // 兼容 Windows (EPERM/EISDIR) 等平台
      }
    } catch (err) {
      if (tmpCreated) {
        try {
          await fs.unlink(tmpPath);
        } catch {}
      }
      throw err;
    }

    return nextSettings;
  });
}
