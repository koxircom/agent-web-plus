/**
 * Composer Modes Extension
 *
 * Provides authoritative backend state management for Codex-style composer modes:
 * - normal: Full execution access with active tool set
 * - plan: Read-only exploration and plan generation (restricts tools to read, grep, find, ls)
 * - goal: Injects and maintains overarching user objective across agent turns
 *
 * Reference:
 * - Adapted from official plan-mode example:
 *   /usr/local/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/plan-mode/index.ts
 * - Adheres to Pi extensions specification (docs/extensions.md)
 */

import { getCurrentTools, getDeclaredTools, getToolStateChanges } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ComposerMode = "normal" | "plan" | "goal";

export interface ComposerModeState {
  version: 1;
  mode: ComposerMode;
  pendingMode?: ComposerMode;
  activeMode?: ComposerMode;
  pending?: boolean;
  goal?: string;
  toolsBeforePlan?: string[];
  pausePending?: boolean;
  paused?: boolean;
  goalStatus?: "active" | "idle" | "paused" | "pending";
  goalElapsedMs?: number;
  goalActiveSinceMs?: number;
}

export const ALLOWED_PLAN_TOOLS = new Set<string>(["read", "grep", "find", "ls"]);

export default function composerModesExtension(pi: ExtensionAPI): void {
  let currentMode: ComposerMode = "normal";
  let pendingMode: ComposerMode | undefined;
  let modeToolProjectionPending = false;
  let currentGoal: string | undefined = undefined;
  let toolsBeforePlan: string[] | undefined = undefined;
  let pausePending: boolean = false;
  let paused: boolean = false;
  let goalElapsedMs: number = 0;
  let goalActiveSinceMs: number | undefined = undefined;
  let goalActiveSinceHr: bigint | undefined = undefined;
  // Bounded per-user-run continuation: never turn a persistent Goal into an infinite loop.
  const MAX_GOAL_CONTINUATIONS = 3;
  let goalAutoContinuations = 0;
  let goalRunUsedTool = false;

  function getElapsedMs(): number {
    return Math.max(0, Math.floor(goalElapsedMs));
  }

  function getCurrentSegmentMs(): number {
    if (goalActiveSinceHr !== undefined) {
      const deltaNs = process.hrtime.bigint() - goalActiveSinceHr;
      return Math.max(0, Number(deltaNs / BigInt(1_000_000)));
    }
    if (goalActiveSinceMs !== undefined) {
      return Math.max(0, Date.now() - goalActiveSinceMs);
    }
    return 0;
  }

  function startGoalTimer(): void {
    if (goalActiveSinceMs !== undefined || goalActiveSinceHr !== undefined) {
      freezeGoalTimer();
    }
    goalActiveSinceMs = Date.now();
    goalActiveSinceHr = process.hrtime.bigint();
  }

  function freezeGoalTimer(): void {
    if (goalActiveSinceMs !== undefined || goalActiveSinceHr !== undefined) {
      goalElapsedMs += getCurrentSegmentMs();
      goalActiveSinceMs = undefined;
      goalActiveSinceHr = undefined;
    }
  }

  function resetGoalTimer(): void {
    goalElapsedMs = 0;
    goalActiveSinceMs = undefined;
    goalActiveSinceHr = undefined;
  }

  function getGoalStatus(ctx?: ExtensionContext): "active" | "idle" | "paused" | "pending" | undefined {
    if (currentMode !== "goal" || !currentGoal) return undefined;
    if (paused) return "paused";
    if (pausePending) return "pending";
    if (!ctx) return "idle";
    return ctx.isIdle() ? "idle" : "active";
  }

  function updateStatus(ctx: ExtensionContext): void {
    const isGoal = currentMode === "goal" && Boolean(currentGoal);
    const goalStatus = getGoalStatus(ctx);
    const payload: ComposerModeState = {
      version: 1,
      mode: pendingMode ?? currentMode,
      activeMode: currentMode,
      ...(pendingMode !== undefined ? { pending: true, pendingMode } : {}),
      ...(currentGoal ? { goal: currentGoal } : {}),
      ...(toolsBeforePlan ? { toolsBeforePlan } : {}),
      ...(currentMode === "goal" && pausePending ? { pausePending: true } : {}),
      ...(currentMode === "goal" && paused ? { paused: true } : {}),
      ...(isGoal && goalStatus ? { goalStatus } : {}),
      ...(isGoal ? { goalElapsedMs: getElapsedMs() } : {}),
      ...(isGoal && goalActiveSinceMs !== undefined ? { goalActiveSinceMs } : {}),
    };
    ctx.ui.setStatus("composer-modes", JSON.stringify(payload));
  }

  function persistState(ctx?: ExtensionContext): void {
    const isGoal = currentMode === "goal" && Boolean(currentGoal);
    const goalStatus = getGoalStatus(ctx);
    pi.appendEntry("composer-modes", {
      version: 1,
      mode: currentMode,
      pendingMode,
      goal: currentGoal,
      toolsBeforePlan,
      pausePending: currentMode === "goal" ? pausePending : undefined,
      paused: currentMode === "goal" ? paused : undefined,
      goalStatus: isGoal ? goalStatus : undefined,
      goalElapsedMs: isGoal ? getElapsedMs() : undefined,
      goalActiveSinceMs: isGoal && goalActiveSinceMs !== undefined ? goalActiveSinceMs : undefined,
    });
  }

  function enablePlanModeTools(): void {
    if (toolsBeforePlan === undefined) {
      toolsBeforePlan = pi.getActiveTools();
    }
    // Take the strict intersection of existing active tools and allowed plan tools
    const safeTools = (toolsBeforePlan || []).filter((name) => ALLOWED_PLAN_TOOLS.has(name));
    pi.setActiveTools(safeTools);
  }

  function restoreTools(): void {
    if (toolsBeforePlan !== undefined) {
      pi.setActiveTools(toolsBeforePlan);
      toolsBeforePlan = undefined;
    }
  }

  function setMode(newMode: ComposerMode, ctx: ExtensionContext): void {
    if (currentMode === newMode) { updateStatus(ctx); persistState(ctx); return; }
    const oldMode = currentMode;
    modeToolProjectionPending = oldMode === "plan" || newMode === "plan";
    currentMode = newMode;

    if (newMode === "plan") {
      enablePlanModeTools();
      ctx.ui.notify("已进入计划模式（只读方案与分析，写操作工具已禁用）", "info");
    } else {
      if (oldMode === "plan") {
        restoreTools();
        ctx.ui.notify("已退出计划模式，恢复执行权限", "info");
      }
    }

    if (newMode !== "goal") {
      currentGoal = undefined;
      pausePending = false;
      paused = false;
      goalAutoContinuations = 0;
      resetGoalTimer();
    } else {
      resetGoalTimer();
    }

    updateStatus(ctx);
    persistState(ctx);
  }

  // Register authoritative slash command for switching modes
  pi.registerCommand("composer-mode", {
    description: "Switch composer mode: normal | plan | goal | status",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "").toLowerCase();

      if (sub === "status" || !sub) {
        if (parts.length > 1) {
          ctx.ui.notify(`命令 status 不接受多余参数: "${raw}"`, "error");
          return;
        }
        updateStatus(ctx);
        const goalInfo = currentGoal ? ` (目标: ${currentGoal})` : "";
        const pauseInfo = currentMode === "goal" ? (paused ? " [已暂停]" : (pausePending ? " [等待暂停]" : "")) : "";
        ctx.ui.notify(`当前主输入框模式: ${currentMode}${goalInfo}${pauseInfo}`, "info");
        return;
      }

      if (!["normal", "plan", "goal"].includes(sub)) {
        ctx.ui.notify(`无效的模式参数 "${sub}"。允许的值: normal, plan, goal, status`, "error");
        return;
      }

      // 严格参数检查：plan 和 normal 拒绝多余参数（例如 "plan garbage"）
      if ((sub === "plan" || sub === "normal") && parts.length > 1) {
        ctx.ui.notify(`模式 "${sub}" 不接受多余参数 "${parts.slice(1).join(" ")}"`, "error");
        return;
      }

      // Keep this run's tool guard and goal intact. Only delivery of the next
      // user message activates the selection, including queued follow-ups.
      if (!ctx.isIdle()) {
        if (parts.length > 1) {
          ctx.ui.notify("运行中请先选择目标模式，再在下一条消息中填写目标。", "error");
          return;
        }
        pendingMode = sub === currentMode ? undefined : sub as ComposerMode;
        updateStatus(ctx);
        persistState(ctx);
        return;
      }
      pendingMode = undefined;

      if (sub === "goal" && parts.length > 1) {
        const nextGoal = raw.slice(parts[0].length).trim();
        if (nextGoal) {
          if (nextGoal !== currentGoal) {
            currentGoal = nextGoal;
            resetGoalTimer();
            pausePending = false;
            paused = false;
          }
          if (currentMode === "goal") {
            updateStatus(ctx);
            persistState(ctx);
            return;
          }
        }
      }

      setMode(sub as ComposerMode, ctx);
    },
  });

  // Register unambiguous slash command for controlling goal pause/resume
  pi.registerCommand("composer-goal", {
    description: "Control active goal pause/resume: pause | resume",
    handler: async (args, ctx) => {
      const raw = (args || "").trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      const action = (parts[0] || "").toLowerCase();

      if (currentMode !== "goal") {
        ctx.ui.notify("当前非目标模式，无法执行目标暂停/继续控制", "warning");
        return;
      }

      if (action !== "pause" && action !== "resume" && action !== "unpause") {
        ctx.ui.notify(`无效的目标控制参数 "${raw}"。允许的值: pause, resume`, "error");
        return;
      }

      if (parts.length > 1) {
        ctx.ui.notify(`命令 composer-goal ${action} 不接受多余参数: "${raw}"`, "error");
        return;
      }

      if (action === "pause") {
        if (paused) {
          ctx.ui.notify("目标已处于暂停状态", "info");
          return;
        }

        // 真实控制：先设置 paused=true 冻结计时器并持久发布，再 ctx.abort() 仅终止当前 Pi 轮，阻断后续续跑
        pausePending = false;
        paused = true;
        freezeGoalTimer();
        updateStatus(ctx);
        persistState(ctx);
        ctx.ui.notify("目标已暂停，后续执行不再注入目标上下文", "info");

        if (!ctx.isIdle()) {
          const abortFn = (ctx as any).abort;
          if (typeof abortFn !== "function") {
            throw new Error("Extension context does not support abort: ctx.abort is missing");
          }
          abortFn.call(ctx);
        }
        return;
      }

      if (action === "resume" || action === "unpause") {
        if (!pausePending && !paused) {
          ctx.ui.notify("当前目标未处于暂停或等待暂停状态", "info");
          return;
        }

        pausePending = false;
        paused = false;
        // resume 保持不自动发送新 prompt 语义，等待用户下一条输入；正常在 agent_start 确认后计时
        if (!ctx.isIdle()) {
          startGoalTimer();
        }
        updateStatus(ctx);
        persistState(ctx);
        ctx.ui.notify("已恢复目标正常推进，等待用户下一条输入", "info");
        return;
      }
    },
  });

  // Strict tool_call whitelist guard for plan mode:
  // Disallow bash, edit, write, subagent, and any unknown custom write tools.
  pi.on("tool_call", async (event) => {
    if (currentMode !== "plan") return;

    if (!ALLOWED_PLAN_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `[计划模式限制] 工具 "${event.toolName}" 在计划模式下被禁用。计划模式仅允许只读调研工具（${Array.from(ALLOWED_PLAN_TOOLS).join(", ")}）。请先退出计划模式再执行。`,
      };
    }
  });

  // Pi Web can restore its native preset after session_start; reapply before every turn.
  pi.on("turn_start", async () => {
    if (currentMode === "plan") enablePlanModeTools();
  });

  function applyPendingMode(ctx: ExtensionContext): void {
    if (pendingMode === undefined) return;
    const next = pendingMode;
    pendingMode = undefined;
    setMode(next, ctx);
  }

  function captureGoal(text: string, ctx: ExtensionContext): void {
    if (currentMode !== "goal" || currentGoal || !text || text.startsWith("/")) return;
    currentGoal = text;
    resetGoalTimer();
    pausePending = false;
    paused = false;
    updateStatus(ctx);
    persistState(ctx);
  }

  // Idle prompts apply before before_agent_start. Streaming input is only an
  // admission to the queue, so it cannot change current execution permissions.
  pi.on("input", async (event, ctx) => {
    if (ctx.isIdle() && event.source !== "extension") {
      applyPendingMode(ctx);
      captureGoal(typeof event.text === "string" ? event.text.trim() : "", ctx);
    }
    return { action: "continue" };
  });
  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "user") return;
    applyPendingMode(ctx);
    goalAutoContinuations = 0;
    goalRunUsedTool = false;
    const content = event.message.content;
    const text = typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
    captureGoal(text.trim(), ctx);
  });

  // The user's next explicit prompt starts a new, strictly bounded Goal work cycle.
  // Automatic continuation below does not re-enter before_agent_start.
  pi.on("agent_start", async (_event, ctx) => {
    goalRunUsedTool = false;
    if (currentMode === "goal" && currentGoal && !paused) {
      startGoalTimer();
      if (ctx) updateStatus(ctx);
    }
  });
  pi.on("turn_end", async (event) => {
    modeToolProjectionPending = false;
    if (event.toolResults.length > 0) goalRunUsedTool = true;
  });

  function modeContext() {
    if (currentMode === "plan") {
      return {
        customType: "composer-plan-context",
        content: `[PLAN MODE ACTIVE]
仅调研与方案，不执行，待用户退出计划。
当前处于计划模式，所有修改与执行操作已被系统禁用。
请使用只读工具（read, grep, find, ls）进行代码与环境调研，并给出清晰分步的方案与设计分析，待用户退出计划模式后再由用户决定执行。`,
        display: false,
      };
    }

    if (currentMode === "goal" && currentGoal) {
      if (paused) {
        return;
      }
      return {
        customType: "composer-goal-context",
        content: `[GOAL ACTIVE]
用户设定的持续目标：
${currentGoal}

说明：请围绕上述目标推进方案与实施，定义可衡量的成果。本目标不扩大原安全授权与确认边界，无无限续跑权限；遇高风险或不确定操作仍需按规则暂停确认。`,
        display: false,
      };
    }
  }
  pi.on("before_agent_start", async () => {
    if (currentMode === "goal") goalAutoContinuations = 0;
    const message = modeContext();
    return message ? { message } : undefined;
  });

  // Codex-style evidence loop, but deliberately bounded. Pi checks this only after
  // the current agent run, automatic retries and queued user work have finished.
  // At entry event.context.canContinue is normally false (last role is assistant);
  // the custom_message draft gives the next request valid runnable user context.
  pi.on("agent_before_settle", async (event, ctx) => {
    if (currentMode !== "goal" || !currentGoal || paused || pausePending ||
        event.outcome !== "completed" || !goalRunUsedTool ||
        goalAutoContinuations >= MAX_GOAL_CONTINUATIONS ||
        event.context.pendingMessages.length > 0 ||
        event.context.llmMessages.length === 0 || !ctx.model) return;
    goalAutoContinuations++;
    return {
      entries: [{
        type: "custom_message",
        customType: "composer-goal-continuation",
        content: `[GOAL CHECK ${goalAutoContinuations}/${MAX_GOAL_CONTINUATIONS}]
当前目标：${currentGoal}
请依据刚刚实际运行的工具结果，核对完成条件和验证证据。若已完成、遇到阻塞、需要用户授权、或没有安全的下一步，请直接给出结果并停止调用工具。若未完成且有明确的安全下一步，只推进一小步并验收。禁止超出原授权边界；预算到期必须报告未完成之处，不得宣称已完成。`,
        display: false,
      }],
      continue: true,
    };
  });

  // agent_settled 任何无 continuation 最终进入 idle，freezeTimer，goalStatus='idle'
  pi.on("agent_settled", async (_event, ctx) => {
    if (currentMode === "goal" && currentGoal) {
      freezeGoalTimer();
      if (pausePending) {
        pausePending = false;
        paused = true;
        ctx.ui.notify("目标已暂停推进，后续执行不再注入目标上下文", "info");
      }
      updateStatus(ctx);
      persistState(ctx);
    }
  });

  // Context filtering to clean up transient context injection messages
  // 去重并仅保留本轮当前模式目标，旧 goal/plan 彻底移除，普通用户消息绝不误伤
  pi.on("context", async (event) => {
    const messages = event.messages.filter(message => {
      const type = (message as AgentMessage & { customType?: string }).customType;
      return type !== "composer-plan-context" && type !== "composer-goal-context";
    });
    const context = modeContext();
    if (context) messages.push({ role: "custom", ...context, timestamp: Date.now() });
    return { messages };
  });

  // SDK 1.x declares the next loadout before delivering queued user messages.
  // A mode change at message_start therefore needs this public projection hook
  // to keep the provider declarations in step with Pi's executable tool set.
  pi.on("context_with_system", async (event) => {
    if (currentMode !== "plan" && !modeToolProjectionPending) return;
    const active = new Set(pi.getActiveTools());
    const declared = getDeclaredTools(event.messages).filter(tool => active.has(tool.name));
    const changes = getToolStateChanges(getCurrentTools(event.messages), declared);
    if (changes.toolsAdded.length === 0 && changes.toolsRemoved.length === 0) return;
    return { messages: [...event.messages, { role: "system", content: "", ...changes, timestamp: Date.now() }] };
  });

  // Restore state from current branch (respecting session tree navigation and branching)
  function restoreFromSessionBranch(ctx: ExtensionContext): void {
    try {
      const branch = ctx.sessionManager?.getBranch?.() || ctx.sessionManager?.getEntries?.() || [];
      const modeEntry = [...branch].reverse().find(
        (e: any) => e.type === "custom" && e.customType === "composer-modes" && e.data,
      ) as { data?: ComposerModeState } | undefined;

      const targetMode: ComposerMode = modeEntry?.data?.mode || "normal";
      const savedPending = modeEntry?.data?.pendingMode;
      pendingMode = savedPending && ["normal", "plan", "goal"].includes(savedPending) ? savedPending : undefined;
      const targetGoal: string | undefined = modeEntry?.data?.goal;
      const targetToolsBeforePlan: string[] | undefined = modeEntry?.data?.toolsBeforePlan;
      const targetPausePending: boolean = targetMode === "goal" ? Boolean(modeEntry?.data?.pausePending) : false;
      const targetPaused: boolean = targetMode === "goal" ? Boolean(modeEntry?.data?.paused) : false;
      const rawElapsed = modeEntry?.data?.goalElapsedMs;
      const rawActiveSince = modeEntry?.data?.goalActiveSinceMs;
      const hasTimingFields = typeof rawElapsed === "number" || typeof rawActiveSince === "number";
      goalAutoContinuations = 0;
      goalRunUsedTool = false;

      if (targetMode === "plan") {
        if (targetToolsBeforePlan) {
          toolsBeforePlan = targetToolsBeforePlan;
        }
        currentMode = "plan";
        currentGoal = undefined;
        pausePending = false;
        paused = false;
        resetGoalTimer();
        enablePlanModeTools();
      } else {
        // If currently in plan mode, restore tools before changing mode
        if (currentMode === "plan" || toolsBeforePlan !== undefined) {
          restoreTools();
        }
        if (targetToolsBeforePlan) {
          pi.setActiveTools(targetToolsBeforePlan);
          toolsBeforePlan = undefined;
        }
        currentMode = targetMode;
        currentGoal = targetGoal;
        if (currentMode === "goal" && currentGoal) {
          let resolvedPending = targetPausePending;
          let resolvedPaused = targetPaused;
          if (resolvedPending && ctx.isIdle()) {
            resolvedPending = false;
            resolvedPaused = true;
          }

          pausePending = resolvedPending;
          paused = resolvedPaused;

          const baseElapsed = typeof rawElapsed === "number" ? Math.max(0, rawElapsed) : 0;
          if (!hasTimingFields) {
            // 分支恢复旧 v1 goal 缺计时字段不得伪造旧历史：从恢复当下 0 开始记录
            goalElapsedMs = 0;
            goalActiveSinceMs = undefined;
            goalActiveSinceHr = undefined;
          } else {
            // “restore idle不把离线time累加”
            if (ctx.isIdle()) {
              goalElapsedMs = baseElapsed;
              goalActiveSinceMs = undefined;
              goalActiveSinceHr = undefined;
            } else {
              const wallDelta = typeof rawActiveSince === "number" ? Math.max(0, Date.now() - rawActiveSince) : 0;
              goalElapsedMs = baseElapsed + (paused ? 0 : wallDelta);
              if (!paused) {
                startGoalTimer();
              }
            }
          }
        } else {
          pausePending = false;
          paused = false;
          resetGoalTimer();
        }
      }

      updateStatus(ctx);
    } catch {
      // Never silently drop an active read-only guard on a recovery failure.
      if (currentMode === "plan") pi.setActiveTools([]);
      ctx.ui.notify("模式状态恢复失败，保留当前限制，请检查会话状态。", "error");
      updateStatus(ctx);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreFromSessionBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromSessionBranch(ctx);
  });
}
