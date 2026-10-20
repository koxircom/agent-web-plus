export type ExecutionEngine = "pi" | "codex";

/** Session identity wins; a new composer supplies its engine explicitly.
 * The shared default is only for older callers that supplied no context. */
export function resolveExecutionEngine(
  requested: unknown,
  fallback: ExecutionEngine,
  sessionId?: string | null,
): ExecutionEngine {
  if (requested !== undefined && requested !== null && requested !== "pi" && requested !== "codex") {
    throw new RangeError("执行引擎无效，请选择 Pi Agent 或 Codex");
  }
  if (sessionId) return sessionId.startsWith("codex:") ? "codex" : "pi";
  return requested === "pi" || requested === "codex" ? requested : fallback;
}
