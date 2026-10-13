"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AskUserQuestion, ExtensionUiRequest } from "@/lib/types";
import { buildAskAnswerInputs, readAskTerminal } from "@/lib/ask-user";
import { isEnhancementPluginFastActive } from "@/lib/enhancement-settings.generated";
import { allowsAutomaticEditableFocus } from "@/hooks/useIsMobile";
import { useI18n } from "@/hooks/useI18n";

type Request = Extract<ExtensionUiRequest, { method: "custom" }>;
type Input = (request: Request, data: string | string[]) => Promise<boolean | undefined>;

export function ExtensionWaitingCount({ count }: { count: number }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return <span role="status" style={{ color: "var(--text-dim)", fontSize: 11, flexShrink: 0, whiteSpace: "nowrap" }}>
    {t("chat.extensionMoreWaiting", { count })}
  </span>;
}

function subscribePreference(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener("pi-native-composer-preferences-change", listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener("pi-native-composer-preferences-change", listener);
  };
}

/** Keep the legacy switch, with React owning both renderer and cleanup. */
export function AskUserSurface({ request, onInput, fallback, waitingCount = 0 }: { request: Request; onInput: Input; fallback: React.ReactNode; waitingCount?: number }) {
  const enabled = useSyncExternalStore(subscribePreference, () => isEnhancementPluginFastActive("ask-user-web-native"), () => true);
  const terminal = readAskTerminal(request.lines);
  const question: AskUserQuestion | undefined = request.askUser ?? (terminal.question && /\bask_user\b/.test(terminal.text) ? {
    toolCallId: request.id, question: terminal.question,
    options: terminal.options.map(option => ({ title: option.title })),
    allowMultiple: /\d+\.\s+\[/.test(terminal.text),
    allowFreeform: terminal.freeform, allowComment: terminal.comment,
  } : undefined);
  return enabled && question ? <AskUserPanel key={request.id} request={request} question={question} waitingCount={waitingCount} onInput={onInput} /> : fallback;
}

// The same question surface handles plain input/editor requests, without a terminal overlay.
type TextRequest = Extract<ExtensionUiRequest, { method: "input" | "editor" }>;
export function AskUserTextPanel({ request, onRespond, waitingCount = 0 }: { request: TextRequest; onRespond: (request: TextRequest, response: { value: string } | { cancelled: true }) => void; waitingCount?: number }) {
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [now, setNow] = useState(() => Date.now());
  const sending = useRef(false);
  useEffect(() => {
    if (request.expiresAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);
  // ask_user uses a plain input request for answers without choices.
  const contextMarker = request.title.indexOf("\n\nContext:\n");
  const title = contextMarker < 0 ? request.title : request.title.slice(0, contextMarker);
  const context = contextMarker < 0 ? "" : request.title.slice(contextMarker + "\n\nContext:\n".length);
  const canSend = request.method === "editor" || Boolean(value.trim());
  const expiresHint = request.expiresAt === undefined ? "" : `${Math.max(0, Math.ceil((request.expiresAt - now) / 1000))} 秒后到期`;
  const respond = (skip = false) => {
    if (sending.current || (!skip && !canSend)) return;
    sending.current = true;
    onRespond(request, skip ? { cancelled: true } : { value });
  };
  return <div className="pi-native-extension-host pi-native-ask-host">
    <section className="pi-native-ask-card" role="dialog" aria-label={title} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.repeat) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); return; }
      if (event.key === "Enter") {
        if ((event.target as HTMLElement).matches("input")) {
          event.preventDefault(); respond();
        } else if ((event.ctrlKey || event.metaKey) && (event.target as HTMLElement).matches("textarea")) {
          event.preventDefault(); respond();
        }
      }
    }}>
      <div className="pi-native-ask-question-row"><h2 className="pi-native-ask-question">{title}</h2><ExtensionWaitingCount count={waitingCount} /></div>
      {(context || request.method === "editor") && (
        <div className="pi-native-ask-body">
          {context && <details className="pi-native-ask-context"><summary>查看背景与方案</summary><div>{context}</div></details>}
          {request.method === "editor" && (
            <div className="pi-native-ask-notes">
              <textarea aria-label="回答" autoFocus={allowsAutomaticEditableFocus()} placeholder="输入你的回答…" rows={3} value={value} onChange={event => setValue(event.target.value)} />
            </div>
          )}
        </div>
      )}
      <footer className="pi-native-ask-footer">
        {expiresHint ? <div className="pi-native-ask-hint" role="status">{expiresHint}</div> : null}
        <div className="pi-native-ask-footer-actions">
          {request.method === "input" && (
            <input
              type="text"
              className="pi-native-ask-input"
              aria-label="回答"
              autoFocus={allowsAutomaticEditableFocus()}
              placeholder={request.placeholder || "输入你的回答…"}
              value={value}
              onChange={event => setValue(event.target.value)}
            />
          )}
          <div className="pi-native-ask-footer-main">
            <button type="button" className="pi-native-ask-cancel" onClick={() => respond(true)}>
              <span className="pi-native-ask-button-label">取消</span>
            </button>
            <button type="button" className="pi-native-ask-submit" disabled={!canSend} onClick={() => respond()}>
              <span className="pi-native-ask-button-label">发送</span>
            </button>
          </div>
        </div>
      </footer>
    </section>
  </div>;
}

export function AskUserPanel({ request, question, onInput, waitingCount = 0 }: { request: Request; question: AskUserQuestion; onInput: Input; waitingCount?: number }) {
  const [selected, setSelected] = useState<number[]>(() => {
    const checked = readAskTerminal(request.lines).options.flatMap((option, index) => option.checked ? [index] : []);
    return readAskTerminal(request.lines).mode === "freeform" ? [] : checked.length ? checked : question.options.length ? [0] : [];
  });
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const firstOption = useRef<HTMLButtonElement>(null);
  const terminalMode = readAskTerminal(request.lines).mode;
  const hint = error || (busy ? "正在提交，等待确认…" : "");

  const hasNotes = Boolean(notes.trim());
  const freeform = Boolean(question.allowFreeform && hasNotes);
  const hasCustomInput = question.allowFreeform || question.allowComment;

  const canSubmit = !busy && (freeform || selected.length > 0);

  useEffect(() => {
    if (allowsAutomaticEditableFocus()) firstOption.current?.focus({ preventScroll: true });
  }, []);

  async function send(data: string[]) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError("");
    try {
      if (!await onInput(request, data)) throw new Error("回答未确认送达，请检查连接后重试。");
      // Closure belongs to the server's request id, never a local timer.
      // If the terminal opens an editor instead, allow continuing it in place.
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "回答发送失败");
      sending.current = false; setBusy(false);
    }
  }

  // A remounted server-side editor is a continuation of this same question.
  // Do not replace the card with a terminal dialog or clear the draft.
  useEffect(() => {
    if (terminalMode !== "select") {
      sending.current = false; setBusy(false);
      if (terminalMode === "freeform") setSelected([]);
    }
  }, [terminalMode]);

  function submit() {
    if (sending.current || busy) return;
    try { void send(buildAskAnswerInputs(question, request.lines, selected, notes, freeform)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : (freeform ? "请输入自定义回答" : "请选择答案")); }
  }

  function choose(index: number, toggle = true) {
    if (busy) return;
    setError("");
    setSelected(current => question.allowMultiple
      ? current.includes(index) ? current.filter(value => value !== index) : [...current, index].sort((a, b) => a - b)
      : toggle && question.allowFreeform && current.includes(index) ? [] : [index]);
  }

  return <div className="pi-native-ask-host" data-pi-native-ask-owner={request.id}>
    <section className="pi-native-ask-card" role="dialog" aria-label={question.question} aria-busy={busy} data-ask-user-picker
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || event.repeat || busy) return;
        const target = event.target as HTMLElement;
        if (target.matches("input")) {
          if (event.key === "Enter") { event.preventDefault(); submit(); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
          return;
        }
        const option = target.closest<HTMLButtonElement>("[data-ask-option]");
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); return; }
        if (/^[1-9]$/.test(event.key) && Number(event.key) <= question.options.length) {
          event.preventDefault(); choose(Number(event.key) - 1, false); return;
        }
        if (option && ["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-ask-option]"));
          const index = buttons.indexOf(option);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          if (!question.allowMultiple) setSelected([next]);
          buttons[next]?.focus({ preventScroll: true }); buttons[next]?.scrollIntoView({ block: "nearest" });
        }
        if (option && event.key === "Enter") { event.preventDefault(); submit(); }
      }}>
      <div className="pi-native-ask-question-row"><h2 className="pi-native-ask-question">{question.question}</h2><ExtensionWaitingCount count={waitingCount} /></div>
      <div className="pi-native-ask-body">
        {question.context && <details className="pi-native-ask-context"><summary>查看背景与方案</summary><div>{question.context}</div></details>}
        <div className="pi-native-ask-options" role="group" aria-label={question.allowMultiple ? "多选答案" : "单选答案"}>
          {question.options.map((option, index) => {
            const isSelected = !freeform && selected.includes(index);
            return <button key={index} ref={index === 0 ? firstOption : undefined} type="button" className="pi-native-ask-option" data-ask-option={index} aria-pressed={isSelected} disabled={busy} onClick={() => choose(index)}>
              <span className="pi-native-ask-index">{index + 1}</span>
              <span className="pi-native-ask-copy"><span className="pi-native-ask-label">{option.title}</span>{option.description && <span className="pi-native-ask-description">{option.description}</span>}</span>
              <span className="pi-native-ask-check" aria-hidden="true">
                {isSelected ? (
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />
                  </svg>
                ) : null}
              </span>
            </button>;
          })}
        </div>
      </div>
      <footer className="pi-native-ask-footer">
        {hint ? <div className="pi-native-ask-hint" role="status">{hint}</div> : null}
        <div className="pi-native-ask-footer-actions">
          {hasCustomInput && (
            <input
              type="text"
              className="pi-native-ask-input"
              aria-label="自定义回答"
              placeholder={question.allowFreeform ? "自定义回答…" : "补充说明…"}
              value={notes}
              disabled={busy}
              onChange={event => { setNotes(event.target.value); setError(""); }}
            />
          )}
          <div className="pi-native-ask-footer-main">
            <button type="button" className="pi-native-ask-cancel" disabled={busy} onClick={() => void send(["\x03"])}>
              <span className="pi-native-ask-button-label">取消</span>
            </button>
            <button type="button" className="pi-native-ask-submit" disabled={!canSubmit} onClick={submit}>
              <span className="pi-native-ask-button-label">{busy ? "发送中…" : "发送"}</span>
            </button>
          </div>
        </div>
      </footer>
    </section>
  </div>;
}
