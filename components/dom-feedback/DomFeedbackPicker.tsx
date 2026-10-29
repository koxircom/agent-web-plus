"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { collectDomFeedbackTarget, type DomFeedbackTarget } from "../../lib/dom-feedback/target";
import { normalizeDomFeedbackFrameEvent, type DomFeedbackPickerSource } from "./frame-protocol";
import { getDomSourceHint, normalizeDomSourceHint, resolveDomSource, type DomSourceHint } from "../../lib/dom-feedback/source";
import styles from "./DomFeedbackPicker.module.css";

export type { DomFeedbackPickerSource } from "./frame-protocol";

type Selection = {
  target: DomFeedbackTarget;
  origin: "host" | "frame";
  element: HTMLElement | null;
  hint: DomSourceHint | null;
  html?: string;
};

type HoverRect = { left: number; top: number; width: number; height: number };

export type DomFeedbackPickerProps = {
  onCancel: () => void;
  onSave: (target: DomFeedbackTarget, comment: string, screenshot?: File) => void | Promise<void>;
  source: DomFeedbackPickerSource;
  captureElement?: (element: HTMLElement) => Promise<File>;
  captureTarget?: (target: DomFeedbackTarget) => Promise<File>;
};

function eventElement(target: EventTarget | null): HTMLElement | null {
  let element = target as (Element & { parentElement: Element | null }) | null;
  if (element && element.nodeType !== 1) element = element.parentElement;
  while (element && element.namespaceURI !== "http://www.w3.org/1999/xhtml") element = element.parentElement;
  return element as HTMLElement | null;
}

function isPickerUi(element: Element | null): boolean {
  return Boolean(element?.closest("[data-dom-feedback-ignore]"));
}

function sendFrameMode(frame: HTMLIFrameElement, action: "enable" | "disable"): void {
  const token = frame.dataset.domFeedbackToken?.trim();
  if (!token || token.length > 512 || !frame.contentWindow) return;
  frame.contentWindow.postMessage({ type: "pi-dom-feedback-control", action, token }, "*");
}

export function DomFeedbackPicker({ onCancel, onSave, source, captureElement, captureTarget }: DomFeedbackPickerProps) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sourceStatus, setSourceStatus] = useState<"idle" | "loading" | "done">("idle");
  const [comment, setComment] = useState("");
  const [hover, setHover] = useState<HoverRect | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [screenshotRequested, setScreenshotRequested] = useState(false);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotStatus, setScreenshotStatus] = useState<"idle" | "capturing" | "error">("idle");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "error" | "saved">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveAttemptRef = useRef<"idle" | "saving" | "saved">("idle");
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const hoverElementRef = useRef<HTMLElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const screenshotGenerationRef = useRef(0);
  const picking = selection === null;
  const sourceSessionId = source.sourceSessionId;
  const executionEngine = source.executionEngine;

  useEffect(() => {
    if (!picking) return;
    const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[data-dom-feedback-token]"));
    for (const frame of frames) sendFrameMode(frame, "enable");

    const flushHover = () => {
      animationFrameRef.current = null;
      const element = hoverElementRef.current;
      if (!element?.isConnected || isPickerUi(element)) {
        setHover(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
        setHover(null);
        return;
      }
      setHover({ left: rect.left, top: rect.top, width: Math.max(0, rect.width), height: Math.max(0, rect.height) });
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const element = eventElement(event.target);
      hoverElementRef.current = element && !isPickerUi(element) ? element : null;
      if (animationFrameRef.current === null) animationFrameRef.current = requestAnimationFrame(flushHover);
    };
    const onClick = (event: MouseEvent) => {
      const element = eventElement(event.target);
      if (!element || isPickerUi(element)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const filePath = element.closest("[data-dom-feedback-file-path]")?.getAttribute("data-dom-feedback-file-path") ?? undefined;
      const pageValue = element.closest("[data-pdf-page]")?.getAttribute("data-pdf-page");
      const page = pageValue && /^\d+$/.test(pageValue) ? Number(pageValue) : undefined;
      const target = collectDomFeedbackTarget(element, { sourceSessionId, executionEngine, filePath, page });
      if (!target) {
        setPickerError("此位置不可读取，请选择可见的普通页面元素。");
        cancelRef.current?.focus({ preventScroll: true });
        return;
      }
      setPickerError(null);
      setComment("");
      const hint = getDomSourceHint(element);
      setSourceStatus(hint ? "loading" : "done");
      setSelection({ target, origin: "host", element, hint });
      setScreenshotRequested(false);
      setScreenshot(null);
      setScreenshotStatus("idle");
      setSaveStatus("idle");
      setSaveError(null);
      saveAttemptRef.current = "idle";
    };
    const onMessage = (event: MessageEvent) => {
      for (const frame of frames) {
        if (!frame.isConnected) continue;
        const token = frame.dataset.domFeedbackToken?.trim();
        const data = event.data as { type?: unknown; token?: unknown } | null;
        if (!token || event.source !== frame.contentWindow || data?.token !== token) continue;
        if (data.type === "pi-dom-feedback-cancel") {
          onCancel();
          return;
        }
        if (data.type !== "pi-dom-feedback-target") continue;
        const target = normalizeDomFeedbackFrameEvent(event, frame, { sourceSessionId, executionEngine });
        if (!target) continue;
        setPickerError(null);
        setComment("");
        const hint = normalizeDomSourceHint((event.data as { hint?: unknown }).hint);
        setSourceStatus(hint ? "loading" : "done");
        setSelection({ target, origin: "frame", element: null, hint, html: frame.srcdoc });
        setScreenshotRequested(false);
        setScreenshot(null);
        setScreenshotStatus("idle");
        setSaveStatus("idle");
        setSaveError(null);
        saveAttemptRef.current = "idle";
        break;
      }
    };
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("click", onClick, true);
    window.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("message", onMessage);
      if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      hoverElementRef.current = null;
      for (const frame of frames) sendFrameMode(frame, "disable");
    };
  }, [sourceSessionId, executionEngine, picking, onCancel]);

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  useEffect(() => {
    if (selection) commentRef.current?.focus();
  }, [selection]);

  const captureScreenshot = useCallback(async () => {
    if (!selection) return;
    const capture = selection.origin === "frame"
      ? (captureTarget ? () => captureTarget(selection.target) : null)
      : (captureElement && selection.element ? () => captureElement(selection.element!) : null);
    if (!capture) return;
    const generation = ++screenshotGenerationRef.current;
    setScreenshotStatus("capturing");
    setScreenshot(null);
    try {
      const file = await capture();
      if (generation !== screenshotGenerationRef.current) return;
      if (!file || typeof file.name !== "string" || typeof file.size !== "number" || typeof file.arrayBuffer !== "function") {
        throw new Error("截图回调没有返回文件");
      }
      setScreenshot(file);
      setScreenshotStatus("idle");
    } catch {
      if (generation !== screenshotGenerationRef.current) return;
      setScreenshotStatus("error");
    }
  }, [captureElement, captureTarget, selection]);

  const canCapture = Boolean(selection && (selection.origin === "frame" ? captureTarget : captureElement));
  const changeScreenshotRequested = (checked: boolean) => {
    setScreenshotRequested(checked);
    setScreenshot(null);
    setScreenshotStatus("idle");
    screenshotGenerationRef.current++;
    if (checked) void captureScreenshot();
  };

  // Resolve only after a selection. Cancelled/changed selections never receive
  // stale results. The bounded lookup never delays opening the comment editor.
  useEffect(() => {
    if (!selection) { setSourceStatus("idle"); return; }
    const controller = new AbortController();
    if (!selection.hint) { setSourceStatus("done"); return () => controller.abort(); }
    setSourceStatus("loading");
    void resolveDomSource(selection.hint, { html: selection.html, pageUrl: window.location.href, filePath: selection.origin === "frame" ? selection.target.source.filePath : null, sourceSessionId, executionEngine, signal: controller.signal })
      .then(location => {
        if (controller.signal.aborted) return;
        if (location) setSelection(current => current === selection
          ? { ...current, target: { ...current.target, source: { ...current.target.source, codeLocation: location } } } : current);
        setSourceStatus("done");
      }).catch(() => { if (!controller.signal.aborted) setSourceStatus("done"); });
    return () => controller.abort();
    // The target is enriched in place for this selection, never start a second lookup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.hint, selection?.html]);

  const save = async () => {
    if (sourceStatus === "loading" || saveAttemptRef.current !== "idle" || !selection || !comment.trim() || (screenshotRequested && !screenshot) || screenshotStatus === "capturing") return;
    saveAttemptRef.current = "saving";
    setSaveStatus("saving");
    setSaveError(null);
    try {
      await onSave(selection.target, comment.trim(), screenshotRequested ? screenshot ?? undefined : undefined);
      saveAttemptRef.current = "saved";
      setSaveStatus("saved");
    } catch (error) {
      saveAttemptRef.current = "idle";
      setSaveStatus("error");
      setSaveError(error instanceof Error ? error.message : "保存失败，请重试。");
    }
  };

  return createPortal(
    <div className={styles.layer}>
      {picking ? (
        <>
          {hover && <div className={styles.highlight} style={{ left: hover.left, top: hover.top, width: hover.width, height: hover.height }} aria-hidden="true" />}
          <div className={styles.pickToolbar} data-dom-feedback-ignore="" role="status">
            <span>点击要反馈的页面位置；触屏可滚动后点选</span>
            {pickerError && <span className={styles.inlineError}>{pickerError}</span>}
            <button ref={cancelRef} type="button" className={styles.secondaryButton} onClick={onCancel}>取消</button>
          </div>
        </>
      ) : (
        <div className={styles.dialogBackdrop} data-dom-feedback-ignore="">
          <section className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="dom-feedback-title">
            <header className={styles.header}>
              <div>
                <h2 id="dom-feedback-title">添加界面反馈</h2>
                <p>添加到输入区，随下一条消息发送。</p>
              </div>
              <button type="button" className={styles.iconButton} aria-label="取消" onClick={onCancel}>×</button>
            </header>
            <div className={styles.targetSummary}>
              <strong>{selection.target.tag}{selection.target.role ? ` · ${selection.target.role}` : ""}</strong>
              <code>{selection.target.selector}</code>
              <p role="status" aria-live="polite">{sourceStatus === "loading" ? "正在定位源码…" : selection.target.source.codeLocation
                ? `源码：${selection.target.source.codeLocation.filePath}:${selection.target.source.codeLocation.line}${selection.target.source.codeLocation.column ? ":" + selection.target.source.codeLocation.column : ""}`
                : "未提供可用源码映射，保留 DOM 定位。"}</p>
              {selection.target.visibleText && <p>{selection.target.visibleText}</p>}
            </div>
            <label className={styles.fieldLabel} htmlFor="dom-feedback-comment">反馈备注</label>
            <textarea
              id="dom-feedback-comment"
              ref={commentRef}
              className={styles.comment}
              value={comment}
              onChange={event => setComment(event.currentTarget.value)}
                placeholder="例如：这个按钮在窄屏下不容易找到……"
                maxLength={4000}
              rows={4}
            />
            {canCapture && (
              <div className={styles.screenshotRow}>
                <label><input type="checkbox" checked={screenshotRequested} disabled={screenshotStatus === "capturing"}
                  onChange={event => changeScreenshotRequested(event.currentTarget.checked)} /> 附上当前位置截图</label>
                {screenshotStatus === "capturing" && <span>正在截取…</span>}
                {screenshotStatus === "error" && <span className={styles.inlineError}>截图失败，可重试或取消截图。</span>}
                {screenshotStatus === "error" && screenshotRequested && <button type="button" className={styles.textButton} onClick={() => void captureScreenshot()}>重试</button>}
                {screenshot && <span>{screenshot.name || "截图已就绪"}</span>}
              </div>
            )}
            {saveError && <p className={styles.inlineError} role="alert">{saveError}</p>}
            {saveStatus === "saved" && <p className={styles.success} role="status">备注已添加到输入区</p>}
            <footer className={styles.footer}>
              <button type="button" className={styles.secondaryButton} onClick={onCancel}>{saveStatus === "saved" ? "关闭" : "取消"}</button>
              <button type="button" className={styles.primaryButton} onClick={() => void save()}
                disabled={sourceStatus === "loading" || !comment.trim() || saveStatus === "saving" || saveStatus === "saved"
                  || (screenshotRequested && (!screenshot || screenshotStatus === "capturing"))}>
                {saveStatus === "saving" ? "添加中…" : saveStatus === "saved" ? "已添加" : "添加备注"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>, document.body,
  );
}

export default DomFeedbackPicker;
