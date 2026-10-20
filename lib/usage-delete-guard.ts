import { SessionManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import * as nodeModuleNamespace from "module";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "path";
import { fileURLToPath } from "url";

export interface SealAndDeleteOptions {
  sessionsRoot?: string;
  stateFile?: string;
  outputFile?: string;
  source?: string;
  workerScript?: string;
  timeout?: number;
  lockTimeoutMs?: number;
  sealForDelete?: boolean;
}

export interface SealAndDeleteResult {
  ok: boolean;
  deletedCount: number;
}

export type OnSessionDeletedCallback = (sessionId: string, filePath: string) => void;

export interface UsageDeleteGuardModule {
  GUARD_VERSION: number;
  deletedPaths: Set<string>;
  isPathDeleted: (filePath: string) => boolean;
  installSessionWriteGuard: (SessionManagerClass: unknown) => boolean;
  sealAndDeleteSync: (
    targetsInput: Map<string, string> | Array<[string, string]> | Record<string, string>,
    onDeleted?: OnSessionDeletedCallback | null,
    options?: SealAndDeleteOptions,
  ) => SealAndDeleteResult;
}

declare global {
  var __piUsageDeleteGuardModule: UsageDeleteGuardModule | undefined;
  var __piUsageDeleteGuardBinDir: string | undefined;
  var __piUsageDeleteGuardDefaultOptions: SealAndDeleteOptions | undefined;
}

const REQUIRED_GUARD_FILES = [
  "pi-usage-delete-guard.cjs",
  "pi-usage-seal-worker.cjs",
  "usage-storage-paths.cjs",
  "generate-usage-ledger.js",
  "usage-ledger-core.js",
] as const;

type CreateRequireFn = (filename: string) => NodeRequire;

interface CallSiteLike {
  getFileName?: () => string | null | undefined;
  getScriptNameOrSourceURL?: () => string | null | undefined;
}

function hasCompleteGuardBinDir(binDir: string): boolean {
  return REQUIRED_GUARD_FILES.every((fileName) => existsSync(join(binDir, fileName)));
}

function verifyGuardBinInRoot(pkgRoot: string): string {
  const resolvedRoot = resolvePath(pkgRoot);
  const candidateBin = join(resolvedRoot, "bin", "usage-guard");
  if (hasCompleteGuardBinDir(candidateBin)) {
    return candidateBin;
  }
  throw new Error(`[usage-delete-guard] Incomplete or missing usage-guard bin directory in: ${pkgRoot}`);
}

function searchUpwardForGuardBin(startDir: string): string | null {
  let current = resolvePath(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(current, "bin", "usage-guard");
    if (hasCompleteGuardBinDir(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findDotNextPackageRoot(startDir: string): string | null {
  let current = resolvePath(startDir);
  for (let depth = 0; depth < 16; depth += 1) {
    if (basename(current) === ".next") {
      const parent = dirname(current);
      return parent !== current ? parent : null;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function isPiWebPackageRoot(dir: string): boolean {
  const pkgJsonPath = join(dir, "package.json");
  if (!existsSync(pkgJsonPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as { name?: string };
    return pkg.name === "@agegr/pi-web";
  } catch {
    return false;
  }
}

function findOwningPackageRoot(startDir: string): string | null {
  const dotNextRoot = findDotNextPackageRoot(startDir);
  if (dotNextRoot) return dotNextRoot;

  let current = resolvePath(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    const guardBinDir = join(current, "bin", "usage-guard");
    if (existsSync(guardBinDir) || isPiWebPackageRoot(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function normalizeRuntimeFilePath(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.startsWith("node:") ||
    trimmed.startsWith("internal/") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("webpack-internal:") ||
    trimmed.startsWith("rsc:")
  ) {
    return null;
  }
  let filePath = trimmed;
  if (trimmed.startsWith("file://")) {
    try {
      filePath = fileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  if (!isAbsolute(filePath)) return null;
  if (filePath.includes(join("node_modules", "jiti"))) return null;
  return filePath;
}

function getRuntimeModuleFilePath(): string | null {
  const origPrepare = Error.prepareStackTrace;
  try {
    let sites: CallSiteLike[] = [];
    Error.prepareStackTrace = (_err, stack) => {
      sites = Array.isArray(stack) ? (stack as CallSiteLike[]) : [];
      return "";
    };
    const probe = new Error();
    void probe.stack;
    for (const site of sites) {
      const candidate =
        normalizeRuntimeFilePath(site.getFileName?.()) ??
        normalizeRuntimeFilePath(site.getScriptNameOrSourceURL?.());
      if (candidate) return candidate;
    }
  } catch {
    // Fallback to string stack parsing below
  } finally {
    Error.prepareStackTrace = origPrepare;
  }

  const stackText = new Error().stack ?? "";
  for (const line of stackText.split("\n")) {
    const match =
      line.match(/\((file:\/\/[^)]+|\/[^):]+|[A-Za-z]:\\[^):]+)/) ??
      line.match(/at\s+(file:\/\/\S+|\/[^:\s]+|[A-Za-z]:\\[^:\s]+)/);
    if (match?.[1]) {
      const candidate = normalizeRuntimeFilePath(match[1]);
      if (candidate) return candidate;
    }
  }
  return null;
}

function getNativeCreateRequire(): CreateRequireFn {
  const proc = process as unknown as {
    getBuiltinModule?: (id: string) => Record<string, unknown> | undefined;
  };
  const methodKey = ["create", "Require"].join("");
  if (typeof proc.getBuiltinModule === "function") {
    const builtinMod = (proc.getBuiltinModule("node:module") ??
      proc.getBuiltinModule("module")) as Record<string, unknown> | undefined;
    const fn = builtinMod?.[methodKey];
    if (typeof fn === "function") {
      return (fn as CreateRequireFn).bind(builtinMod);
    }
  }
  const fallbackMod = nodeModuleNamespace as unknown as Record<string, unknown>;
  const fallbackFn = fallbackMod?.[methodKey];
  if (typeof fallbackFn === "function") {
    return (fallbackFn as CreateRequireFn).bind(fallbackMod);
  }
  throw new Error("[usage-delete-guard] Native module.createRequire is unavailable");
}

export function loadNativeCommonJs<T>(scriptPath: string): T {
  const absPath = resolvePath(scriptPath);
  const createReq = getNativeCreateRequire();
  const runtimeRequire = createReq(absPath);
  return runtimeRequire(absPath) as T;
}

/**
 * Resolve the trusted package-internal `bin/usage-guard` directory.
 * Locates the owning package root from the active runtime bundle/module path
 * (e.g. `<pkgRoot>/.next/server/...` or `<pkgRoot>/lib/...`) without relying
 * on a fixed `process.cwd()` or webpack-inlined `import.meta.url`.
 * Fails closed when any required guard/worker script is missing.
 */
export function resolveUsageGuardBinDir(customPkgRoot?: string): string {
  if (customPkgRoot) {
    return verifyGuardBinInRoot(customPkgRoot);
  }

  const runtimeFile = getRuntimeModuleFilePath();
  if (runtimeFile) {
    const owningRoot = findOwningPackageRoot(dirname(runtimeFile));
    if (owningRoot) {
      return verifyGuardBinInRoot(owningRoot);
    }
  }

  if (typeof process.argv[1] === "string" && process.argv[1].trim()) {
    const argvBin = searchUpwardForGuardBin(dirname(resolvePath(process.argv[1])));
    if (argvBin) return argvBin;
  }

  const foundFromCwd = searchUpwardForGuardBin(process.cwd());
  if (foundFromCwd) return foundFromCwd;

  throw new Error("[usage-delete-guard] Trusted bin/usage-guard directory not found or incomplete");
}

export function loadUsageDeleteGuard(customPkgRoot?: string): UsageDeleteGuardModule {
  const binDir = resolveUsageGuardBinDir(customPkgRoot);
  if (globalThis.__piUsageDeleteGuardModule && globalThis.__piUsageDeleteGuardBinDir === binDir) {
    return globalThis.__piUsageDeleteGuardModule;
  }
  const guardScriptPath = join(binDir, "pi-usage-delete-guard.cjs");
  const guardModule = loadNativeCommonJs<UsageDeleteGuardModule>(guardScriptPath);
  globalThis.__piUsageDeleteGuardModule = guardModule;
  globalThis.__piUsageDeleteGuardBinDir = binDir;
  return guardModule;
}

export function ensureSessionWriteGuardInstalled(SessionManagerClass: unknown = SessionManager): boolean {
  const guard = loadUsageDeleteGuard();
  return guard.installSessionWriteGuard(SessionManagerClass);
}

export const GUARD_VERSION = loadUsageDeleteGuard().GUARD_VERSION;

export const deletedPaths = loadUsageDeleteGuard().deletedPaths;

export function isPathDeleted(filePath: string): boolean {
  return loadUsageDeleteGuard().isPathDeleted(filePath);
}

export function installSessionWriteGuard(SessionManagerClass: unknown = SessionManager): boolean {
  return ensureSessionWriteGuardInstalled(SessionManagerClass);
}

export function sealAndDeleteSync(
  targetsInput: Map<string, string> | Array<[string, string]> | Record<string, string>,
  onDeleted?: OnSessionDeletedCallback | null,
  options: SealAndDeleteOptions = {},
): SealAndDeleteResult {
  ensureSessionWriteGuardInstalled();
  const guard = loadUsageDeleteGuard();
  const binDir = resolveUsageGuardBinDir();
  const defaultOpts = globalThis.__piUsageDeleteGuardDefaultOptions ?? {};
  const mergedOptions: SealAndDeleteOptions = {
    ...defaultOpts,
    ...options,
  };
  if (!mergedOptions.workerScript) {
    mergedOptions.workerScript = join(binDir, "pi-usage-seal-worker.cjs");
  }
  if (!mergedOptions.sessionsRoot) {
    mergedOptions.sessionsRoot = process.env.PI_SESSIONS_DIR || join(getAgentDir(), "sessions");
  }
  return guard.sealAndDeleteSync(targetsInput, onDeleted, mergedOptions);
}

ensureSessionWriteGuardInstalled();
