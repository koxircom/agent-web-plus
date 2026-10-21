import { createGithubReleaseChecker } from "./pi-update";
import { codexBridgeJson } from "./execution-engines/codex-bridge-client";
import { isNewerReleaseVersion } from "./release-version";
import type { CodexCliReleaseStatus } from "./api-types";

const latest = createGithubReleaseChecker({ repository: "openai/codex", tagPrefix: "rust-v" });
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface NormalizedCodexCliStatus {
  installedVersion: string | null;
  runningVersion: string | null;
  runtimeStatus: CodexCliReleaseStatus["runtimeStatus"];
  activationState: CodexCliReleaseStatus["activationState"];
  activationMessage: string;
}

export function normalizeCodexCliStatus(value: unknown): NormalizedCodexCliStatus {
  const status = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const hasInstalledVersion = Object.prototype.hasOwnProperty.call(status, "codexCliInstalledVersion");
  const installedRaw = hasInstalledVersion ? status.codexCliInstalledVersion : status.codexCliVersion;
  const installedVersion = typeof installedRaw === "string" && VERSION.test(installedRaw) ? installedRaw : null;
  const runningRaw = status.codexCliRunningVersion;
  const runningVersion = typeof runningRaw === "string" && VERSION.test(runningRaw) ? runningRaw : null;
  const runtime = status.codexCliRuntimeStatus;
  const runtimeStatus: CodexCliReleaseStatus["runtimeStatus"] =
    runtime === "running" || runtime === "stopped" ? runtime : "unknown";
  const activation = status.codexCliActivationState;
  const activationState: CodexCliReleaseStatus["activationState"] =
    activation === "current" ||
    activation === "waiting_for_idle" ||
    activation === "switching" ||
    activation === "error" ||
    activation === "manual"
      ? activation
      : "manual";
  const fallbackMessage: Record<typeof activationState, string> = {
    current: "当前 CLI 版本已生效",
    waiting_for_idle: "等待当前任务空闲后切换",
    switching: "正在切换 CLI 版本",
    error: "CLI 版本切换失败",
    manual: "CLI 激活状态暂不可用",
  };
  return {
    installedVersion,
    runningVersion,
    runtimeStatus,
    activationState,
    activationMessage:
      typeof status.codexCliActivationMessage === "string" && status.codexCliActivationMessage
        ? status.codexCliActivationMessage
        : fallbackMessage[activationState],
  };
}

export const FALLBACK_CODEX_CLI_STATUS: NormalizedCodexCliStatus = {
  installedVersion: null,
  runningVersion: null,
  runtimeStatus: "unknown",
  activationState: "manual",
  activationMessage: "CLI 激活状态暂不可用",
};

export interface CodexCliReleaseOptions {
  localOnly?: boolean;
}

export async function getCodexCliReleaseStatus(options?: CodexCliReleaseOptions): Promise<CodexCliReleaseStatus> {
  const localOnly = options?.localOnly === true;
  const readCli = () =>
    codexBridgeJson("/api/projects?includeVersion=1")
      .then(normalizeCodexCliStatus)
      .catch(() => FALLBACK_CODEX_CLI_STATUS);

  if (localOnly) {
    const cli = await readCli();
    return {
      ...cli,
      currentVersion: cli.installedVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: "",
      ...(!cli.installedVersion ? { versionError: "Codex CLI 版本暂不可用" } : {}),
    };
  }

  // The connector caches --version. Release checks share Pi's single-flight,
  // success cache and failure backoff; neither blocks the editable composer.
  const [cli, release] = await Promise.all([
    readCli(),
    latest(),
  ]);
  return {
    ...cli,
    currentVersion: cli.installedVersion,
    ...release,
    releaseUrl: release.releaseUrl || "",
    updateAvailable: Boolean(
      cli.installedVersion && release.latestVersion && isNewerReleaseVersion(release.latestVersion, cli.installedVersion)
    ),
    ...(!cli.installedVersion ? { versionError: "Codex CLI 版本暂不可用" } : {}),
    ...(!release.latestVersion ? { updateError: "暂时无法检查 Codex CLI 更新" } : {}),
  };
}
