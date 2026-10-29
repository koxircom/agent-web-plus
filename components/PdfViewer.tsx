"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask, TextLayer } from "pdfjs-dist";
import styles from "./PdfViewer.module.css";

const ASSETS = "/pdfjs/6.4.299/";
type PdfModule = typeof import("pdfjs-dist");
let modulePromise: Promise<PdfModule> | undefined;
function loadPdf() {
  // Only load on opening a PDF. Keep the legacy browser build out of SSR and the chat bundle.
  const url = ASSETS + "legacy/build/pdf.min.mjs";
  return modulePromise ??= import(/* webpackIgnore: true */ url).then((pdf: PdfModule) => {
    pdf.GlobalWorkerOptions.workerSrc = ASSETS + "legacy/build/pdf.worker.min.mjs";
    return pdf;
  }).catch(error => { modulePromise = undefined; throw error; });
}

export default function PdfViewer({ url, initialPage = 1 }: { url: string; initialPage?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [pageInput, setPageInput] = useState(String(initialPage));
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordRequest, setPasswordRequest] = useState<{ update: (password: string) => void; incorrect: boolean } | null>(null);

  useEffect(() => { setPage(Math.max(1, Math.floor(initialPage))); }, [initialPage]);
  useEffect(() => { setPageInput(String(page)); }, [page]);

  useEffect(() => {
    const node = scroll.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(1, node.clientWidth - 24)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    setDocument(null); setError(null); setLoading(true); setPasswordRequest(null); setPassword("");
    loadPdf().then(pdf => {
      if (!active) return;
      task = pdf.getDocument({ url, cMapUrl: ASSETS + "cmaps/", cMapPacked: true,
        standardFontDataUrl: ASSETS + "standard_fonts/", wasmUrl: ASSETS + "wasm/" });
      task.onPassword = (update: (password: string) => void, reason: number) => {
        if (active) { setPasswordRequest({ update, incorrect: reason === pdf.PasswordResponses.INCORRECT_PASSWORD }); setLoading(false); }
      };
      return task.promise.then(doc => {
        if (!active) return;
        setDocument(doc); setPage(value => Math.min(doc.numPages, Math.max(1, value)));
        setPasswordRequest(null); setPassword(""); setLoading(false);
      });
    }).catch(nextError => {
      if (active) { setError("PDF 无法加载，请重试或下载原文件。" + (nextError instanceof Error ? " " + nextError.message : "")); setLoading(false); }
    });
    return () => { active = false; void task?.destroy().catch(() => {}); };
  }, [url]);

  useEffect(() => {
    if (!document || !width || !host.current) return;
    let active = true;
    let render: RenderTask | undefined;
    let text: TextLayer | undefined;
    const node = host.current;
    setRendering(true); setError(null);
    Promise.all([document.getPage(Math.min(document.numPages, page)), loadPdf()]).then(async ([pdfPage, pdf]) => {
      if (!active) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: width / base.width * zoom });
      // Bound bitmap memory on phones, large pages and high device pixel ratios.
      const ratio = Math.min(window.devicePixelRatio || 1, 2, 8192 / viewport.width, 8192 / viewport.height,
        Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      const canvas = window.document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
      canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
      canvas.style.width = viewport.width + "px"; canvas.style.height = viewport.height + "px";
      canvas.setAttribute("aria-label", "PDF 第 " + page + " 页");
      const layer = window.document.createElement("div");
      layer.className = styles.textLayer;
      layer.style.setProperty("--total-scale-factor", String(viewport.scale));
      node.style.width = viewport.width + "px"; node.style.height = viewport.height + "px";
      node.replaceChildren(canvas, layer);
      render = pdfPage.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (!active) return;
      text = new pdf.TextLayer({ textContentSource: pdfPage.streamTextContent(), container: layer, viewport });
      await text.render();
      if (active) { node.dataset.renderedPage = String(page); setRendering(false); }
    }).catch(nextError => {
      if (active) { setError("PDF 页面无法显示，请重试或下载原文件。" + (nextError instanceof Error ? " " + nextError.message : "")); setRendering(false); }
    });
    return () => { active = false; render?.cancel(); text?.cancel(); delete node.dataset.renderedPage; };
  }, [document, page, width, zoom]);

  const navigate = (value: number) => {
    if (!document) return;
    setPage(Math.max(1, Math.min(document.numPages, Math.floor(value) || 1)));
    scroll.current?.scrollTo(0, 0);
  };
  return <div className={styles.viewer} data-pdf-viewer="native" data-pdf-page={page}>
    <div className={styles.toolbar} role="toolbar" aria-label="PDF 阅读工具">
      <button type="button" aria-label="上一页" disabled={!document || page <= 1} onClick={() => navigate(page - 1)}>‹</button>
      <form onSubmit={e => { e.preventDefault(); navigate(Number(pageInput)); }}>
        <label>页码<input aria-label="PDF 页码" inputMode="numeric" value={pageInput} disabled={!document}
          onChange={e => setPageInput(e.target.value)} onBlur={() => { navigate(Number(pageInput)); setPageInput(String(Math.max(1, Math.min(document?.numPages || 1, Math.floor(Number(pageInput)) || 1)))); }} /> / {document?.numPages ?? "—"}</label>
      </form>
      <button type="button" aria-label="下一页" disabled={!document || page >= document.numPages} onClick={() => navigate(page + 1)}>›</button>
      <select aria-label="PDF 缩放" value={zoom} onChange={e => setZoom(Number(e.target.value))}>
        <option value={1}>适合宽度</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option>
      </select>
      <a className={styles.original} href={url + "#page=" + page} target="_blank" rel="noopener noreferrer">打开原文件</a>
    </div>
    {loading && <div className={styles.status} role="status">正在加载 PDF…</div>}
    {passwordRequest && <form className={styles.passwordForm} onSubmit={e => { e.preventDefault(); passwordRequest.update(password); setPassword(""); setPasswordRequest(null); setLoading(true); }}>
      <label>{passwordRequest.incorrect ? "密码不正确，请重试：" : "此 PDF 需要密码："}<input type="password" aria-label="PDF 密码" value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button type="submit">打开 PDF</button>
    </form>}
    {error && <div className={`${styles.status} ${styles.error}`} role="alert">{error}</div>}
    {rendering && <div className={styles.status} role="status">正在显示第 {page} 页…</div>}
    <div className={styles.scroll} ref={scroll}>
      <div className={styles.page} ref={host} style={{ visibility: document && !error ? "visible" : "hidden" } as CSSProperties} />
    </div>
  </div>;
}
