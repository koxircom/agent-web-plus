import type { DomFeedbackTarget } from './target';

// Self contained so the controlled opaque preview can use the identical bounds.
export async function captureBoundedElement(element: HTMLElement, toBlob: (node: HTMLElement, options: Record<string, unknown>) => Promise<Blob | null>, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw new Error('截图已取消');
  const box = element.getBoundingClientRect();
  if (!(box.width > 0 && box.height > 0) || box.width > 2400 || box.height > 2400) throw new Error('选取范围较大，请选择更小的区域');
  const walker = element.ownerDocument.createTreeWalker(element, 1);
  for (let count = 0; walker.nextNode(); count++) if (count === 400) throw new Error('选取范围较大，请选择更小的区域，或关闭截图');
  const scale = Math.min(1, 1280 / box.width, 800 / box.height);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { controller.abort(); reject(new Error('截图已取消')); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('截图超时，可关闭截图后继续')); }, 8000);
  });
  let blob: Blob | null;
  try { blob = await Promise.race([toBlob(element, {
    pixelRatio: 1, canvasWidth: Math.ceil(box.width * scale), canvasHeight: Math.ceil(box.height * scale),
    skipFonts: true, cacheBust: false, fetchRequestInit: { signal: controller.signal },
    filter: (node: HTMLElement) => !node.matches?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-dom-feedback-ignore],script'),
  }), timeout, cancelled]); } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
  if (!blob || blob.size > 4 * 1024 * 1024) throw new Error('截图未能生成，备注已保留，可关闭截图后继续');
  return blob;
}

export async function captureElement(element: HTMLElement, signal?: AbortSignal): Promise<File> {
  const { toBlob } = await import('html-to-image');
  if (signal?.aborted) throw new Error('截图已取消');
  return new File([await captureBoundedElement(element, toBlob, signal)], '界面标注.png', { type: 'image/png' });
}

export async function captureFrameTarget(target: DomFeedbackTarget, signal?: AbortSignal): Promise<File> {
  if (signal?.aborted) throw new Error('截图已取消');
  const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[data-dom-feedback-token]'));
  const frame = frames.find(item => item.dataset.domFeedbackFilePath === target.source.filePath);
  if (!frame?.contentWindow) throw new Error('预览已切换，请重新选取');
  const token = frame.dataset.domFeedbackToken;
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); window.removeEventListener('message', receive); signal?.removeEventListener('abort', abort); };
    const abort = () => {
      finish();
      try { frame.contentWindow?.postMessage({ type: 'pi-dom-feedback-control', action: 'cancel-capture', token, requestId }, '*'); } catch {}
      reject(new Error('截图已取消'));
    };
    const receive = (event: MessageEvent) => {
      const data = event.data;
      if (event.source !== frame.contentWindow || data?.token !== token || data?.requestId !== requestId || data?.type !== 'pi-dom-feedback-capture') return;
      finish();
      if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > 4 * 1024 * 1024) return reject(new Error('预览截图失败，请关闭截图后继续'));
      resolve(new File([data.bytes], '预览标注.png', { type: 'image/png' }));
    };
    const timer = setTimeout(() => { finish(); reject(new Error('预览截图超时，请关闭截图后继续')); }, 16000);
    window.addEventListener('message', receive);
    signal?.addEventListener('abort', abort, { once: true });
    try { frame.contentWindow!.postMessage({ type: 'pi-dom-feedback-control', action: 'capture', token, requestId, selector: target.selector }, '*'); }
    catch { finish(); reject(new Error('预览已关闭，请重新选取')); }
  });
}
