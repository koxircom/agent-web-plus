import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadNativeCommonJs, resolveUsageGuardBinDir } from "./usage-delete-guard";
import * as os from "node:os";
import path from "node:path";

export type UsageLedgerMode = "native-local" | "legacy-central";
export type UsageLedger = Record<string, unknown> & {
  version: 2;
  buckets: unknown[];
  generatedAt?: string;
  snapshotId?: string;
};

type UsageLedgerResult = { ledger: UsageLedger; mode: UsageLedgerMode };
type ServiceOptions = {
  cwd?: string;
  platform?: string;
  resolveNativeLedgerPath?: (source: string) => string;
  generate?: (source: string, cwd: string) => Promise<void>;
  validate?: (ledger: unknown) => asserts ledger is UsageLedger;
};

const guardBinDir = resolveUsageGuardBinDir();
const storagePaths = loadNativeCommonJs<{
  resolveUsageStorage: (options?: { source?: string }) => {
    enabled: boolean;
    globalLedgerFile?: string;
  };
  resolveUsagePathsForLedger: (options?: { source?: string }) => {
    outputFile: string;
  };
}>(path.join(guardBinDir, "usage-storage-paths.cjs"));
const ledgerCore = loadNativeCommonJs<{
  validate: (ledger: unknown) => unknown;
}>(path.join(guardBinDir, "usage-ledger-core.js"));

function readValidLedger(filePath: string, validate: (ledger: unknown) => unknown): UsageLedger | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 2 ||
      !Array.isArray((value as { buckets?: unknown }).buckets)) return null;
  try {
    validate(value);
    return value as UsageLedger;
  } catch {
    return null;
  }
}

function defaultNativeLedgerPath(source: string): string {
  return storagePaths.resolveUsagePathsForLedger({ source }).outputFile;
}

function runGenerator(source: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = path.join(guardBinDir, "generate-usage-ledger.js");
    const child = spawn(process.execPath, [script, "--source", source], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    child.stderr?.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 4096) stderr += String(chunk).slice(0, 4096 - stderr.length);
    });
    child.once("error", error => finish(error));
    child.once("spawn", () => {
      try {
        if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Lowering priority is best-effort on platforms that disallow it.
      }
    });
    const timeoutMs = Number(process.env.PI_USAGE_GENERATOR_TIMEOUT_MS) || 180_000;
    timeout = setTimeout(() => {
      child.kill();
      finish(new Error("Usage ledger generation timed out"));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Usage ledger generator exited (${code ?? signal ?? "unknown"})`));
    });
  });
}

function modeError(message: string, mode: UsageLedgerMode) {
  const error = new Error(message) as Error & { mode: UsageLedgerMode };
  error.mode = mode;
  return error;
}

export function createUsageLedgerService(options: ServiceOptions = {}) {
  const cwd = options.cwd || process.cwd();
  const platform = options.platform || process.platform;
  const validate = options.validate || ledgerCore.validate;
  const nativeSource = platform === "win32" ? "windows" : "nas";
  const resolveNativePath = options.resolveNativeLedgerPath || defaultNativeLedgerPath;
  const generate = options.generate || runGenerator;
  let generation: Promise<void> | null = null;

  const publicLedgerPath = path.join(cwd, "public", "pi-usage-ledger.json");

  function readCentral(): UsageLedgerResult | null {
    const configured = typeof process.env.PI_USAGE_DATA_DIR === "string" && process.env.PI_USAGE_DATA_DIR.trim().length > 0;
    let globalLedgerPath: string | null = null;
    if (configured) {
      // The shared-storage resolver deliberately fails closed when its marker
      // or any required NAS file is missing or unsafe.
      const storage = storagePaths.resolveUsageStorage({ source: "nas" });
      globalLedgerPath = storage.enabled ? storage.globalLedgerFile || null : null;
    }

    if (globalLedgerPath) {
      const globalLedger = readValidLedger(globalLedgerPath, validate);
      if (globalLedger) return { ledger: globalLedger, mode: "legacy-central" };
    }
    const publicLedger = readValidLedger(publicLedgerPath, validate);
    if (publicLedger) return { ledger: publicLedger, mode: "legacy-central" };
    if (configured) {
      throw modeError("Configured central usage ledger is missing or invalid", "legacy-central");
    }
    return null;
  }

  async function runSingleflight(source: string) {
    if (!generation) {
      generation = generate(source, cwd).finally(() => { generation = null; });
    }
    return generation;
  }

  async function readNative(): Promise<UsageLedgerResult> {
    const nativeLedgerPath = resolveNativePath(nativeSource);
    const existing = readValidLedger(nativeLedgerPath, validate);
    if (existing) return { ledger: existing, mode: "native-local" };
    await runSingleflight(nativeSource);
    const generated = readValidLedger(nativeLedgerPath, validate);
    if (!generated) throw modeError("Native usage ledger generation produced no valid snapshot", "native-local");
    return { ledger: generated, mode: "native-local" };
  }

  async function get(): Promise<UsageLedgerResult> {
    const central = readCentral();
    if (central) return central;
    return readNative();
  }

  async function post(): Promise<UsageLedgerResult> {
    const central = readCentral();
    if (central) return central;
    await runSingleflight(nativeSource);
    const generated = readValidLedger(resolveNativePath(nativeSource), validate);
    if (!generated) throw modeError("Native usage ledger generation produced no valid snapshot", "native-local");
    return { ledger: generated, mode: "native-local" };
  }

  return { get, post };
}

const serviceKey = Symbol.for("pi-web.usage-ledger-service");
type ServiceGlobal = typeof globalThis & { [serviceKey]?: ReturnType<typeof createUsageLedgerService> };

function getService() {
  const target = globalThis as ServiceGlobal;
  return target[serviceKey] ||= createUsageLedgerService();
}

export function getUsageLedger() {
  return getService().get();
}

export function refreshUsageLedger() {
  return getService().post();
}
