'use client';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { formatDomFeedbackQuote, type DomFeedbackTarget } from '@/lib/dom-feedback/target';
import { captureElement, captureFrameTarget } from '@/lib/dom-feedback/capture';

const Picker = dynamic(() => import('./dom-feedback/DomFeedbackPicker').then(module => module.DomFeedbackPicker), { ssr: false });
type Bridge = Window & {
  __PI_ENH_IS_PLUGIN_ENABLED__?: (id: string) => boolean;
  __PI_ENH_SET_PLUGIN__?: (id: string, value: boolean) => void;
  __PI_ENH_ANNOTATIONS__?: { add(quote: string, comment: string, options: { kind: 'dom' }): unknown; sync(): void };
};

export function DomFeedbackControl({ sessionId, engine, onImages }: {
  sessionId?: string; engine: 'pi' | 'codex'; onImages(files: File[]): void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState(false);
  const captureController = useRef<AbortController | null>(null);
  const close = () => { captureController.current?.abort(); setActive(false); };
  useEffect(() => () => captureController.current?.abort(), []);
  useEffect(() => {
    const sync = () => {
      const bridge = window as Bridge;
      setReady(Boolean(bridge.__PI_ENH_ANNOTATIONS__ && bridge.__PI_ENH_IS_PLUGIN_ENABLED__));
      const next = Boolean(bridge.__PI_ENH_IS_PLUGIN_ENABLED__?.('dom-feedback'));
      setEnabled(next);
      if (!next) { captureController.current?.abort(); setActive(false); }
    };
    sync();
    window.addEventListener('pi-dom-feedback-ready', sync);
    window.addEventListener('pi-dom-feedback-preferences-change', sync);
    return () => {
      window.removeEventListener('pi-dom-feedback-ready', sync);
      window.removeEventListener('pi-dom-feedback-preferences-change', sync);
    };
  }, []);
  useEffect(() => { captureController.current?.abort(); setActive(false); }, [sessionId, engine]);
  const save = (target: DomFeedbackTarget, comment: string, screenshot?: File) => {
    const routeSession = new URLSearchParams(window.location.search).get("session") || undefined;
    if (routeSession !== sessionId || target.source.sourceSessionId !== (sessionId ?? null) || target.source.executionEngine !== engine) throw new Error("会话已切换，请重新选取位置");
    const annotations = (window as Bridge).__PI_ENH_ANNOTATIONS__;
    if (!annotations) throw new Error('标注功能正在加载，请稍后重试');
    annotations.add(formatDomFeedbackQuote(target), comment, { kind: 'dom' });
    annotations.sync();
    if (screenshot) onImages([screenshot]);
    close();
  };
  return <>
    <button type="button" data-dom-feedback-ignore data-dom-feedback-control aria-label={enabled ? '标注界面或预览' : '开启界面标注'}
      title={!sessionId ? '先打开一个会话再添加标注' : enabled ? '点击元素，添加备注' : '界面标注已关闭，点击开启'} disabled={!ready || !sessionId}
      onClick={() => { if (!enabled) (window as Bridge).__PI_ENH_SET_PLUGIN__?.('dom-feedback', true); else { captureController.current?.abort(); captureController.current = new AbortController(); setActive(true); } }}
      style={{ flexShrink: 0, width: 36, height: 36, border: 0, borderRight: '1px solid var(--border)', background: 'none', color: enabled ? 'var(--text-muted)' : 'var(--text-dim)', cursor: ready ? 'pointer' : 'wait' }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 3v16l4-5 4 7 3-2-4-7 7-1Z" /><path d="M17 3v4m-2-2h4" /></svg>
    </button>
    {active && <Picker source={{ sourceSessionId: sessionId, executionEngine: engine }} onCancel={close} onSave={save}
      captureElement={element => captureElement(element, captureController.current?.signal)} captureTarget={target => captureFrameTarget(target, captureController.current?.signal)} />}
  </>;
}
