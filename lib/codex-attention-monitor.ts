import "server-only";
import { readExecutionEngineSettings } from "./execution-engine-settings";
import { codexAttentionNotificationsEnabled, notifyCodexAttention } from "./codex-attention-notifications";
import type { CodexRequest } from "./execution-engines/codex-projection";

type PendingSession = { sessionId: string; title?: string; requests: CodexRequest[] };
type MonitorOptions = {
  enabled?: () => Promise<boolean>;
  read?: (signal: AbortSignal) => Promise<PendingSession[]>;
  notify?: typeof notifyCodexAttention;
};

/** Observe live pending state on the server; never open a thread or send a model message. */
export function createCodexAttentionMonitor(options: MonitorOptions = {}) {
  let active: Promise<void> | null = null;
  const controller = new AbortController();
  const enabled = options.enabled ?? (async () => (await readExecutionEngineSettings()).codex.enabled && await codexAttentionNotificationsEnabled());
  const read = options.read ?? (async signal => (await import("./execution-engines/codex-engine")).readCodexAttentionSnapshot(signal));
  const notify = options.notify ?? notifyCodexAttention;
  const tick = () => active ||= (async () => {
    if (controller.signal.aborted || !await enabled()) return;
    const sessions = await read(controller.signal);
    if (controller.signal.aborted) return;
    for (const session of sessions) for (const request of session.requests) {
      const questions = request.supported && Array.isArray(request.params.questions) ? request.params.questions : [];
      // The durable notification ledger owns deduplication. Re-observing a
      // pending request also recovers failures before its first POST reservation.
      notify({ sessionId: session.sessionId,
        requestId: String(request.id), kind: questions.length ? "question" : "manual-action" });
    }
  })().finally(() => { active = null; });
  return { tick, stop: async () => { controller.abort(); await active?.catch(() => {}); } };
}

const key = Symbol.for("agent-web:codex-attention-monitor");
type RunningMonitor = { stop: () => Promise<void> };
const globals = globalThis as unknown as Record<symbol, RunningMonitor | undefined>;
export function startCodexAttentionMonitor(): void {
  if (globals[key]) return;
  const monitor = createCodexAttentionMonitor();
  let stopped = false, warned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try { await monitor.tick(); warned = false; }
    catch { if (!warned && !stopped) console.warn("Codex 飞书待处理通知暂时无法读取，将在下次检查恢复。"); warned = true; }
    finally { if (!stopped) { timer = setTimeout(run, 15_000); timer.unref(); } }
  };
  globals[key] = { stop: async () => { stopped = true; if (timer) clearTimeout(timer); await monitor.stop(); delete globals[key]; } };
  void run();
}
export async function stopCodexAttentionMonitor(): Promise<void> { await globals[key]?.stop(); }
