import { normalizeDomFeedbackTarget, type DomFeedbackTarget } from "../../lib/dom-feedback/target";

export type DomFeedbackPickerSource = {
  sourceSessionId?: string;
  executionEngine?: "pi" | "codex";
};

type TargetEvent = { data: unknown; source: MessageEvent["source"] };
type FeedbackFrame = Pick<HTMLIFrameElement, "contentWindow" | "dataset">;

/** Validate the iframe bridge identity before normalizing its target payload. */
export function normalizeDomFeedbackFrameEvent(
  event: TargetEvent,
  frame: FeedbackFrame,
  source: DomFeedbackPickerSource,
): DomFeedbackTarget | null {
  const token = frame.dataset.domFeedbackToken?.trim();
  if (!token || token.length > 512 || event.source !== frame.contentWindow) return null;
  const data = event.data as { type?: unknown; token?: unknown; target?: unknown } | null;
  if (!data || data.type !== "pi-dom-feedback-target" || data.token !== token) return null;
  const target = normalizeDomFeedbackTarget(data.target);
  if (!target) return null;
  return normalizeDomFeedbackTarget({
    ...target,
    source: {
      ...target.source,
      // Only the host resolver may attach code locations after identity validation.
      codeLocation: undefined,
      filePath: frame.dataset.domFeedbackFilePath ?? null,
      sourceSessionId: source.sourceSessionId ?? null,
      executionEngine: source.executionEngine === "pi" || source.executionEngine === "codex" ? source.executionEngine : "unknown",
    },
  });
}
