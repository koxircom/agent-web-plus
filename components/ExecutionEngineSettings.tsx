"use client";

import type { CodexCompatibilityReport } from "@/lib/execution-engines/codex-compatibility";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfigButton, ConfigField, ConfigSwitch } from "./SettingsUi";

type ExecutionEngine = "pi" | "codex";

interface ExecutionEngineSettingsState {
  defaultEngine: ExecutionEngine;
  codex: {
    enabled: boolean;
    url: string;
    username: string;
    hasPassword: boolean;
  };
}

interface ExecutionEngineCheckResult {
  connected: boolean;
  compatibility?: CodexCompatibilityReport;
  projects: Array<{ key: string; name: string; cwd: string }>;
  error?: string;
}

const INITIAL_SETTINGS: ExecutionEngineSettingsState = {
  defaultEngine: "pi",
  codex: { enabled: false, url: "", username: "", hasPassword: false },
};

function getErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string" && data.error) {
    return data.error;
  }
  return fallback;
}

function parseSettings(value: unknown): ExecutionEngineSettingsState {
  if (!value || typeof value !== "object") throw new Error("设置服务返回的数据格式无效。");
  const data = value as Partial<ExecutionEngineSettingsState>;
  const codex = data.codex;
  if ((data.defaultEngine !== "pi" && data.defaultEngine !== "codex") || !codex || typeof codex !== "object") {
    throw new Error("设置服务返回的数据格式无效。");
  }
  return {
    defaultEngine: data.defaultEngine,
    codex: {
      enabled: Boolean(codex.enabled),
      url: typeof codex.url === "string" ? codex.url : "",
      username: typeof codex.username === "string" ? codex.username : "",
      hasPassword: Boolean(codex.hasPassword),
    },
  };
}

export function ExecutionEngineSettings() {
  const [settings, setSettings] = useState(INITIAL_SETTINGS);
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingError, setLoadingError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<ExecutionEngineCheckResult | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const checkGenerationRef = useRef(0);
  const checkControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      checkGenerationRef.current += 1;
      checkControllerRef.current?.abort();
      checkControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/execution-engines", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(getErrorMessage(data, `读取执行引擎设置失败（HTTP ${response.status}）。`));
        return parseSettings(data);
      })
      .then((data) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setSettings(data);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setLoadingError(error instanceof Error ? error.message : "读取执行引擎设置失败。");
      });
    return () => controller.abort();
  }, []);

  const checkSavedConfiguration = useCallback(async (): Promise<ExecutionEngineCheckResult | null> => {
    if (!mountedRef.current) return null;
    checkControllerRef.current?.abort();
    const controller = new AbortController();
    checkControllerRef.current = controller;
    const generation = ++checkGenerationRef.current;
    setChecking(true);
    setCheckError(null);
    const isCurrent = () => mountedRef.current && generation === checkGenerationRef.current && !controller.signal.aborted;
    try {
      const response = await fetch("/api/execution-engines/check", { method: "POST", cache: "no-store", signal: controller.signal });
      const data = await response.json().catch(() => null) as Partial<ExecutionEngineCheckResult> | null;
      if (!response.ok) {
        if (isCurrent()) {
          setCheckResult(null);
          setCheckError(`Codex 连接检测未通过：${getErrorMessage(data, `连接检测失败（HTTP ${response.status}）`)}`);
        }
        return null;
      }
      if (typeof data?.connected !== "boolean" || !Array.isArray(data.projects)) {
        if (isCurrent()) {
          setCheckResult(null);
          setCheckError("Codex 连接检测未通过：连接检测返回的数据格式无效。");
        }
        return null;
      }
      const result = data as ExecutionEngineCheckResult;
      if (isCurrent()) {
        setCheckResult(result);
        if (!result.connected) {
          setCheckError(`Codex 连接检测未通过：${result.error || "请确认项目自带的 Codex 执行端已在执行主机运行，并检查服务地址和认证信息。"}`);
        }
      }
      return isCurrent() ? result : null;
    } catch (error) {
      if (!controller.signal.aborted && isCurrent()) {
        setCheckResult(null);
        setCheckError(`Codex 连接检测未通过：${error instanceof Error ? error.message : "无法连接检测服务。"}`);
      }
      return null;
    } finally {
      if (isCurrent()) setChecking(false);
      if (checkControllerRef.current === controller) checkControllerRef.current = null;
    }
  }, []);

  const save = useCallback(async () => {
    if (!mountedRef.current) return;
    setSaveError(null);
    setCheckError(null);
    if (settings.defaultEngine === "codex" && !settings.codex.enabled) {
      setSaveError("请先启用 Codex，再将其设为默认执行引擎。");
      return;
    }

    setSaving(true);
    try {
      const codex: Record<string, unknown> = {
        enabled: settings.codex.enabled,
        url: settings.codex.url.trim(),
        username: settings.codex.username,
        ...(password ? { password } : {}),
        ...(clearPassword ? { clearPassword: true } : {}),
      };
      const response = await fetch("/api/execution-engines", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultEngine: settings.defaultEngine, codex }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(getErrorMessage(data, `保存执行引擎设置失败（HTTP ${response.status}）。`));

      const saved = parseSettings(data);
      if (mountedRef.current) {
        setSettings(saved);
        setPassword("");
        setClearPassword(false);
        setCheckResult(null);
      }
      const check = saved.defaultEngine === "codex" ? await checkSavedConfiguration() : null;
      const cwd = check?.connected && typeof check.projects[0]?.cwd === "string" ? check.projects[0].cwd : null;
      window.dispatchEvent(new CustomEvent("pi-web:execution-engine-changed", {
        detail: { engine: saved.defaultEngine, cwd, projects: check?.projects, codexEnabled: saved.codex.enabled },
      }));
    } catch (error) {
      if (mountedRef.current) setSaveError(error instanceof Error ? error.message : "保存执行引擎设置失败。");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [settings, password, clearPassword, checkSavedConfiguration]);

  const setCodexEnabled = (enabled: boolean) => {
    setSettings((current) => {
      const codex = { ...current.codex, enabled };
      return !enabled && current.defaultEngine === "codex"
        ? { defaultEngine: "pi", codex }
        : { ...current, codex };
    });
  };

  return (
    <section className="settings-general settings-general-section" aria-labelledby="execution-engine-title">
      <h2 id="execution-engine-title" style={{ margin: "0 0 8px", fontSize: 16 }}>执行引擎</h2>
      <p style={{ margin: "0 0 18px", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6 }}>
        选择新会话默认使用的执行引擎。切换默认引擎不会停止正在运行的后台任务。
      </p>

      {loadingError && <div role="alert" style={{ marginBottom: 12, color: "#dc2626" }}>{loadingError}</div>}

      <ConfigField label="默认执行引擎" style={{ marginBottom: 18 }}>
        <select
          aria-label="默认执行引擎"
          value={settings.defaultEngine}
          disabled={!loaded || saving}
          onChange={(event) => setSettings((current) => ({
            ...current,
            defaultEngine: event.target.value === "codex" ? "codex" : "pi",
          }))}
          style={{ width: "100%", maxWidth: 420, minHeight: 36, padding: "6px 9px", color: "var(--text)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6 }}
        >
          <option value="pi">Pi Agent</option>
          <option value="codex" disabled={!settings.codex.enabled}>Codex</option>
        </select>
      </ConfigField>

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <strong style={{ fontSize: 14 }}>Codex</strong>
          <ConfigSwitch
            checked={settings.codex.enabled}
            disabled={!loaded || saving}
            label="启用 Codex"
            onChange={setCodexEnabled}
          />
        </div>
        <p style={{ margin: "0 0 14px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.6 }}>
          使用本项目自带的 Codex 执行端。先在已安装并登录 Codex CLI 的执行主机上启动执行端，再填写服务地址；CLI 的安装和登录需在该主机完成。用户名和密码用于执行端认证，并保存在 Agent Web Plus 服务端；密码不会回显，留空表示保留已保存密码。
        </p>

        <div style={{ display: "grid", gap: 12, maxWidth: 560 }}>
          <ConfigField label="服务地址">
            <input
              type="url"
              value={settings.codex.url}
              disabled={!loaded || saving}
              placeholder="https://codex-execution.example.com"
              onChange={(event) => setSettings((current) => ({ ...current, codex: { ...current.codex, url: event.target.value } }))}
              style={{ width: "100%", minHeight: 36, padding: "7px 9px", color: "var(--text)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6 }}
            />
          </ConfigField>
          <ConfigField label="用户名">
            <input
              type="text"
              autoComplete="username"
              value={settings.codex.username}
              disabled={!loaded || saving}
              onChange={(event) => setSettings((current) => ({ ...current, codex: { ...current.codex, username: event.target.value } }))}
              style={{ width: "100%", minHeight: 36, padding: "7px 9px", color: "var(--text)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6 }}
            />
          </ConfigField>
          <ConfigField label={settings.codex.hasPassword ? "新密码（已保存密码已隐藏）" : "密码"}>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              disabled={!loaded || saving}
              onChange={(event) => {
                setPassword(event.target.value);
                if (event.target.value) setClearPassword(false);
              }}
              placeholder={settings.codex.hasPassword ? "留空以保留已保存密码" : "输入执行端认证密码"}
              style={{ width: "100%", minHeight: 36, padding: "7px 9px", color: "var(--text)", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 6 }}
            />
          </ConfigField>
          {settings.codex.hasPassword && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: 12 }}>
              <input
                type="checkbox"
                checked={clearPassword}
                disabled={!loaded || saving || Boolean(password)}
                onChange={(event) => setClearPassword(event.target.checked)}
              />
              清除服务端已保存的密码
            </label>
          )}
        </div>
      </div>

      {(saveError || checkError) && (
        <div role="alert" style={{ marginTop: 14, color: "#dc2626", fontSize: 13 }}>
          {saveError || checkError}
        </div>
      )}
      {checkResult?.connected && (
        <div role="status" style={{ marginTop: 14, color: "var(--text-muted)", fontSize: 13 }}>
          <div>Codex 后端已连接。</div>
          {checkResult.compatibility && <div data-codex-compatibility={checkResult.compatibility.status}
            style={{ marginTop: 6, color: checkResult.compatibility.status === "legacy" ? "var(--text)" : "var(--text-muted)" }}>
            {checkResult.compatibility.message}
          </div>}
          {checkResult.projects.length > 0 ? (
            <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
              {checkResult.projects.map((project) => <li key={project.key}>{project.name} — <code>{project.cwd}</code></li>)}
            </ul>
          ) : <div>后端尚未提供可用项目。</div>}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 18 }}>
        <ConfigButton variant="primary" disabled={!loaded || saving || checking} onClick={() => void save()}>
          {saving ? "保存中…" : "保存设置"}
        </ConfigButton>
        <ConfigButton disabled={!loaded || checking || !settings.codex.enabled || settings.defaultEngine !== "codex"} onClick={() => void checkSavedConfiguration()}>
          {checking ? "检测中…" : "检测已保存配置"}
        </ConfigButton>
      </div>
    </section>
  );
}
