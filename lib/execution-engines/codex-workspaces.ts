import "server-only";
import { codexBridgeJson } from "./codex-bridge-client";
import { codexProjectKey } from "./codex-projection";

export interface CodexWorktreeEntry {
  path: string;
  branch: string;
  isMain: boolean;
}

export interface CodexWorktreeResponse {
  projectRoot: string;
  projectKey: string;
  isGit: boolean;
  isTopLevel: boolean;
  currentWorktreePath: string | null;
  worktrees: CodexWorktreeEntry[];
  error?: string;
}

export async function fetchCodexWorktrees(cwd: string): Promise<CodexWorktreeResponse> {
  const result = await codexBridgeJson(`/api/projects/worktrees?cwd=${encodeURIComponent(cwd)}`);
  const root = result.projectRoot || cwd;
  return {
    projectRoot: root,
    projectKey: result.projectKey?.startsWith("codex:") ? result.projectKey : codexProjectKey(root),
    isGit: Boolean(result.isGit),
    isTopLevel: Boolean(result.isTopLevel),
    currentWorktreePath: result.currentWorktreePath ?? null,
    worktrees: Array.isArray(result.worktrees) ? result.worktrees : [],
  };
}

export async function createCodexWorktree(cwd: string, branch: string): Promise<{ path: string; branch: string }> {
  return await codexBridgeJson("/api/projects/worktrees", { cwd, branch }, { timeout: 35000 });
}

export async function browseCodexDirectories(path?: string | null): Promise<{
  path: string;
  parentPath: string | null;
  directories: { name: string; path: string }[];
}> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  const result = await codexBridgeJson(`/api/projects/browse${query}`);
  return {
    path: result.path || "",
    parentPath: result.parentPath ?? null,
    directories: Array.isArray(result.directories) ? result.directories : [],
  };
}

export async function validateCodexCwd(cwd: string): Promise<{
  success: boolean;
  cwd: string;
  projectRoot: string;
  projectKey: string;
  isGit: boolean;
}> {
  return await codexBridgeJson("/api/projects/resolve", { cwd });
}
