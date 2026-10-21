"use client";

import React, { useState, useEffect } from "react";
import { PiWebBrand } from "./PiWebBrand";
import { useI18n } from "@/hooks/useI18n";
import { BRAND_GITHUB_URL, CODEX_CLI_GITHUB_URL } from "@/lib/branding";
import type { AppUpdateResponse, CodexCliReleaseStatus } from "@/lib/api-types";
import { isNewerReleaseVersion } from "@/lib/release-version";
import type { PiAgentReleaseStatus } from "@/lib/pi-update";

export interface NewSessionBrandHeaderProps {
  isMobile?: boolean;
  updateData?: AppUpdateResponse | null;
  releaseNotesLabel?: (version: string) => string;
  appVersion?: string;
  piVersion?: string;
  executionEngine?: "pi" | "codex";
  /** Injected status is useful when the caller already owns a Codex status snapshot. */
  codexStatus?: CodexCliReleaseStatus | null;
}

type NewSessionReleaseUpdate = Pick<AppUpdateResponse, "currentVersion" | "latestVersion" | "updateAvailable" | "releaseUrl">;

export function NewSessionUpdateLink({
  label,
  updateData,
  installedVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
}: {
  label: (version: string) => string;
  installedVersion?: string;
  updateData?: NewSessionReleaseUpdate | null;
}) {
  const [fetchedUpdate, setFetchedUpdate] = useState<NewSessionReleaseUpdate | null>(null);
  const update = updateData === undefined ? fetchedUpdate : updateData;

  useEffect(() => {
    if (updateData !== undefined) return;
    const controller = new AbortController();
    void fetch("/api/app-update", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<AppUpdateResponse>;
      })
      .then((result) => {
        if (result?.updateAvailable && result.latestVersion && result.releaseUrl) {
          setFetchedUpdate(result);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [updateData]);

  if (!update?.updateAvailable || !isNewerReleaseVersion(update.latestVersion, installedVersion)) return null;
  const accessibleLabel = label(update.latestVersion);

  return (
    <a
      href={update.releaseUrl}
      target="_blank"
      rel="noopener noreferrer"
      data-pi-element="release-notes-link"
      title={accessibleLabel}
      aria-label={accessibleLabel}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "var(--bg-hover)";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
      }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        alignSelf: "center",
        gap: 3,
        minHeight: 0,
        minWidth: 0,
        padding: 0,
        background: "transparent",
        borderRadius: 5,
        color: "var(--accent)",
        fontSize: 11,
        fontWeight: 600,
        lineHeight: 1.2,
        textDecoration: "none",
        transition: "background 0.12s",
        whiteSpace: "nowrap",
        flexShrink: 1,
        maxWidth: "100%",
      }}
    >
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>v{update.latestVersion}</span>
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        <path d="M7 17 17 7" />
        <path d="M7 7h10v10" />
      </svg>
    </a>
  );
}

export function NewSessionBrandHeader({
  isMobile = false,
  updateData,
  releaseNotesLabel,
  appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0",
  piVersion = process.env.NEXT_PUBLIC_PI_VERSION ?? "0.0.0",
  executionEngine = "pi",
  codexStatus,
}: NewSessionBrandHeaderProps) {
  const { t } = useI18n();
  const [piRelease, setPiRelease] = useState<PiAgentReleaseStatus | null>(null);
  const [fetchedCodexStatus, setFetchedCodexStatus] = useState<CodexCliReleaseStatus | null>(null);
  const activeCodexStatus = codexStatus !== undefined ? codexStatus : fetchedCodexStatus;

  useEffect(() => {
    if (executionEngine !== "pi") return;
    const controller = new AbortController();
    let active = true;
    void fetch("/api/pi-update", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<PiAgentReleaseStatus>;
      })
      .then((result) => {
        if (active && result?.latestVersion && result.releaseUrl) setPiRelease(result);
      })
      .catch(() => {});
    return () => {
      active = false;
      controller.abort();
    };
  }, [executionEngine]);

  useEffect(() => {
    if (executionEngine !== "codex") return;
    if (codexStatus !== undefined) {
      setFetchedCodexStatus(null);
      return;
    }

    const controller = new AbortController();
    let active = true;
    let inFlight = false;
    setFetchedCodexStatus(null);
    const refreshCodexStatus = async () => {
      if (!active || document.visibilityState === "hidden" || inFlight) return;
      inFlight = true;
      try {
        let roundFreshLocal: CodexCliReleaseStatus | null = null;
        try {
          const localResponse = await fetch("/api/codex-update?localOnly=1", { signal: controller.signal });
          if (localResponse.ok) {
            const localResult = (await localResponse.json()) as CodexCliReleaseStatus;
            const isLocalValid =
              (Boolean(localResult.installedVersion) ||
                localResult.runtimeStatus === "running" ||
                localResult.runtimeStatus === "stopped") &&
              !localResult.versionError;
            if (isLocalValid) {
              roundFreshLocal = localResult;
              if (active) {
                setFetchedCodexStatus((prev) => {
                  if (!prev) return localResult;
                  return {
                    ...prev,
                    installedVersion: localResult.installedVersion,
                    currentVersion: localResult.currentVersion,
                    runningVersion: localResult.runningVersion,
                    runtimeStatus: localResult.runtimeStatus,
                    activationState: localResult.activationState,
                    activationMessage: localResult.activationMessage,
                    versionError: undefined,
                  };
                });
              }
            }
          }
        } catch {
          // 快路由异常不阻断后续完整请求
        }

        if (!active) return;

        try {
          const response = await fetch("/api/codex-update", { signal: controller.signal });
          if (!response.ok) throw new Error(`Codex update status request failed (${response.status})`);
          const result = (await response.json()) as CodexCliReleaseStatus;
          if (!active) return;

          const isResultLocalValid =
            (Boolean(result.installedVersion) ||
              result.runtimeStatus === "running" ||
              result.runtimeStatus === "stopped") &&
            !result.versionError;

          setFetchedCodexStatus((prev) => {
            // 场景 1：full 响应包含有效的本地状态（最新 fresh）
            if (isResultLocalValid) {
              return {
                ...result,
                versionError: undefined,
              };
            }

            // 场景 2：full 响应的本地状态无效（例如 connector read 失败，versionError，installed: null, runtime: unknown）
            // 但是本轮快路由刚读到了 valid 快照 roundFreshLocal：绝不得擦除刚读到的 valid 快照！
            if (roundFreshLocal) {
              const installed = roundFreshLocal.installedVersion;
              const latest = result.latestVersion;
              const updateAvailable = Boolean(installed && latest && isNewerReleaseVersion(latest, installed));
              return {
                ...roundFreshLocal,
                latestVersion: latest,
                updateAvailable,
                releaseUrl: result.releaseUrl || "",
                updateError: result.updateError,
                versionError: undefined,
              };
            }

            // 场景 3：本轮快路由无效，full 的本地状态也无效（本轮本地读失败且 full 也无有效 local 字段）
            const prevInstalled = prev?.installedVersion ?? prev?.currentVersion ?? null;
            if (prevInstalled) {
              return {
                installedVersion: prevInstalled,
                currentVersion: prevInstalled,
                runningVersion: null,
                runtimeStatus: "unknown",
                activationState: "manual",
                activationMessage: "运行状态暂不可用",
                latestVersion: result.latestVersion ?? null,
                updateAvailable: false,
                releaseUrl: result.releaseUrl || "",
                versionError: "状态读取失败",
                updateError: result.updateError,
              };
            }

            // 场景 4：初始两者皆失败（初始 bothfail 仍 unknown）
            return {
              installedVersion: null,
              currentVersion: null,
              runningVersion: null,
              runtimeStatus: "unknown",
              activationState: "manual",
              activationMessage: "运行状态暂不可用",
              latestVersion: result.latestVersion ?? null,
              updateAvailable: false,
              releaseUrl: result.releaseUrl || "",
              versionError: result.versionError || "Codex CLI 版本暂不可用",
              updateError: result.updateError,
            };
          });
        } catch {
          if (!active) return;
          setFetchedCodexStatus((prev) => {
            // full 抛出网络异常（或 non-ok 抛出）进 catch：
            // 场景 A：GH 更新失败但本轮本地 fresh 成功应保持当前真实状态，仅 updateError！
            if (roundFreshLocal) {
              return {
                ...roundFreshLocal,
                latestVersion: null,
                updateAvailable: false,
                releaseUrl: "",
                updateError: "Codex CLI 更新检查失败",
                versionError: undefined,
              };
            }

            // 场景 B：本轮本地读失败且 full 也失败（双失败）
            const prevInstalled = prev?.installedVersion ?? prev?.currentVersion ?? null;
            if (prevInstalled) {
              return {
                installedVersion: prevInstalled,
                currentVersion: prevInstalled,
                runningVersion: null,
                runtimeStatus: "unknown",
                activationState: "manual",
                activationMessage: "运行状态暂不可用",
                latestVersion: null,
                updateAvailable: false,
                releaseUrl: "",
                versionError: "状态读取失败",
                updateError: "Codex CLI 更新检查失败",
              };
            }

            // 场景 C：初始双失败
            return {
              currentVersion: null,
              installedVersion: null,
              runningVersion: null,
              runtimeStatus: "unknown",
              activationState: "manual",
              activationMessage: "运行状态暂不可用",
              latestVersion: null,
              updateAvailable: false,
              releaseUrl: "",
              versionError: "Codex CLI 版本读取失败",
              updateError: "Codex CLI 更新检查失败",
            };
          });
        }
      } finally {
        inFlight = false;
      }
    };
    const refreshTimer = window.setInterval(() => { void refreshCodexStatus(); }, 30_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshCodexStatus();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    void refreshCodexStatus();
    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      controller.abort();
    };
  }, [executionEngine, codexStatus]);

  const getReleaseLabel = releaseNotesLabel ?? ((version: string) => t("appUpdate.releaseNotes", { version }));
  const isPending = codexStatus === undefined && fetchedCodexStatus === null;
  const installedCodexVersion = activeCodexStatus?.installedVersion ?? activeCodexStatus?.currentVersion ?? null;

  return (
    <div
      data-pi-element="new-session-brand-header"
      data-pi-native-version-header="true"
      className="mb-3 w-full"
      style={{
        paddingLeft: 16,
        paddingRight: isMobile ? 16 : 52,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) auto",
          alignItems: "end",
          gap: 12,
          maxWidth: "var(--chat-content-max-width, 820px)",
          margin: "0 auto",
          fontFamily: "var(--font-mono)",
        }}
      >
        <div
          data-pi-element="brand-and-update-row"
          style={{
            display: "flex",
            alignItems: "end",
            minWidth: 0,
          }}
        >
          {executionEngine === "codex" ? (
            <a
              href={BRAND_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="打开 Agent Web Plus GitHub 仓库"
              title={`打开 Agent Web Plus GitHub 仓库 (${BRAND_GITHUB_URL})`}
              style={{ display: "block", width: "100%", maxWidth: isMobile ? 180 : 200, minWidth: 0, color: "var(--text)", textDecoration: "none" }}
            >
              <PiWebBrand
                variant="codex"
                width={isMobile ? 180 : 200}
                height={isMobile ? 28.8 : 32}
                style={{ width: "100%", height: "auto", maxWidth: isMobile ? 180 : 200, flexShrink: 1 }}
              />
            </a>
          ) : (
            <PiWebBrand
              width={isMobile ? 180 : 200}
              height={isMobile ? 28.8 : 32}
              style={{ width: "100%", height: "auto", maxWidth: isMobile ? 180 : 200, flexShrink: 1 }}
            />
          )}
        </div>
        <div
          data-pi-element="version-info-col"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 2,
            minWidth: 0,
            maxWidth: "100%",
            justifySelf: "end",
          }}
        >
          <div data-pi-element="web-version-row" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, minWidth: 0, maxWidth: "100%" }}>
          <a
            href={BRAND_GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-pi-element="web-version"
            title={`打开 GitHub 仓库 (${BRAND_GITHUB_URL})`}
            style={{
              fontSize: 11,
              whiteSpace: "nowrap",
              flexShrink: 0,
              color: "var(--text-muted)",
              textDecoration: "none",
              cursor: "pointer",
              transition: "opacity 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.75")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            web <span style={{ color: "var(--text)" }}>v{appVersion}</span>
          </a>
          <NewSessionUpdateLink label={getReleaseLabel} updateData={updateData} installedVersion={appVersion} />
          </div>
          {executionEngine === "codex" ? (
            <>
              <div data-pi-element="codex-cli-version-row" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, minWidth: 0, maxWidth: "100%" }}>
                <a
                  href={CODEX_CLI_GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-pi-element="codex-cli-version"
                  title={`打开 OpenAI Codex CLI GitHub 仓库 (${CODEX_CLI_GITHUB_URL})`}
                  style={{ display: "inline-flex", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 1, textDecoration: "none", cursor: "pointer", transition: "opacity 0.15s" }}
                  onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.75")}
                  onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
                >
                  CLI 已安装 <span style={{ color: "var(--text)" }}>{
                    installedCodexVersion
                      ? (activeCodexStatus?.versionError ? `v${installedCodexVersion}（上次读取）` : `v${installedCodexVersion}`)
                      : isPending
                        ? "正在读取"
                        : "版本暂不可用"
                  }</span>
                </a>
                {activeCodexStatus?.updateError ? (
                  <span data-pi-element="codex-cli-update-unavailable" style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", minWidth: 0, maxWidth: 96, overflow: "hidden", textOverflow: "ellipsis", flexShrink: 1 }}>更新检查暂不可用</span>
                ) : installedCodexVersion && activeCodexStatus?.updateAvailable && activeCodexStatus.latestVersion && activeCodexStatus.releaseUrl ? (
                  <NewSessionUpdateLink
                    label={getReleaseLabel}
                    updateData={{
                      currentVersion: installedCodexVersion,
                      latestVersion: activeCodexStatus.latestVersion,
                      updateAvailable: true,
                      releaseUrl: activeCodexStatus.releaseUrl,
                    }}
                    installedVersion={installedCodexVersion}
                  />
                ) : null}
              </div>
              <div data-pi-element="codex-cli-running-version-row" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", minWidth: 0, maxWidth: "100%" }}>
                <span data-pi-element="codex-cli-running-version" style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {isPending
                    ? "正在读取"
                    : activeCodexStatus?.runtimeStatus === "stopped"
                      ? "未运行"
                      : activeCodexStatus?.runtimeStatus === "running" && activeCodexStatus.runningVersion && !activeCodexStatus?.versionError
                        ? `运行中 v${activeCodexStatus.runningVersion}`
                        : installedCodexVersion && activeCodexStatus?.versionError
                          ? "状态读取失败"
                          : "运行状态暂不可用"}
                </span>
              </div>
              {activeCodexStatus && ["waiting_for_idle", "switching", "error"].includes(activeCodexStatus.activationState ?? "") ? (
                <span data-pi-element="codex-cli-activation" style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                  {activeCodexStatus.activationState === "waiting_for_idle" ? "待任务空闲后切换"
                    : activeCodexStatus.activationState === "switching" ? "正在切换运行版本" : "切换待确认，后台将重试"}
                </span>
              ) : null}
            </>
          ) : (
          <div data-pi-element="pi-version-row" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, minWidth: 0, maxWidth: "100%" }}>
            <a
              href="https://pi.dev/"
              target="_blank"
              rel="noopener noreferrer"
              data-pi-element="pi-version"
              title={`当前已安装的 Pi Agent 版本：v${piVersion}；打开 Pi Agent 官方网站`}
              aria-label={`Pi Agent 当前版本 v${piVersion}，在新标签页打开官方网站`}
              style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0, textDecoration: "none", cursor: "pointer", transition: "opacity 0.15s" }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.75")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              pi <span style={{ color: "var(--text)" }}>v{piVersion}</span>
            </a>
            {piRelease?.latestVersion && piRelease.releaseUrl && isNewerReleaseVersion(piRelease.latestVersion, piVersion) ? (
              <a
                href={piRelease.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-pi-element="pi-latest-release"
                title={`GitHub 官方最新版本：v${piRelease.latestVersion}（当前已安装：v${piVersion}）`}
                aria-label={`在 GitHub 查看 Pi Agent 最新版本 v${piRelease.latestVersion}；当前已安装 v${piVersion}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 3, minWidth: 0, fontSize: 11, color: "var(--accent)", textDecoration: "none", whiteSpace: "nowrap" }}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>v{piRelease.latestVersion}</span><span style={{ flexShrink: 0 }}>↗</span>
              </a>
            ) : null}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default NewSessionBrandHeader;
