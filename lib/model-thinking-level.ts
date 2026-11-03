export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
const order: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** Use the API capability list; unknown capabilities and automatic selection stay automatic. */
export function clampModelThinkingLevel(level: ModelThinkingLevel | null, supported?: readonly string[] | null): ModelThinkingLevel | null {
  if (level === null || !supported || supported.length === 0) return level;
  if (supported.includes(level)) return level;
  const index = order.indexOf(level);
  // Match Pi SDK clampThinkingLevel: choose the next supported level, or the highest below it.
  return order.slice(index).find(candidate => supported.includes(candidate))
    ?? order.slice(0, index).reverse().find(candidate => supported.includes(candidate))
    ?? "off";
}
