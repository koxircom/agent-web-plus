"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { loadImagePreview, preloadImageCapabilities } from "@/lib/image-capabilities";

interface ImagePreviewProps {
  src: string;
  alt?: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function ImagePreview({ src, alt = "", children, className, style }: ImagePreviewProps) {
  const { t } = useI18n();
  const previewLabel = t("chat.previewImage");
  const triggerLabel = alt.trim() ? `${previewLabel}: ${alt}` : previewLabel;
  const [open, setOpen] = useState(false);
  const [Dialog, setDialog] = useState<typeof import("./ImagePreviewDialog").ImagePreviewDialog | null>(null);
  const [failed, setFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open || Dialog) return;
    let cancelled = false;
    const cancelPending = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("keydown", cancelPending);
    loadImagePreview().then((module) => {
      if (!cancelled) setDialog(() => module.ImagePreviewDialog);
    }).catch(() => {
      if (!cancelled) { setFailed(true); setOpen(false); }
    });
    return () => {
      cancelled = true;
      document.removeEventListener("keydown", cancelPending);
    };
  }, [open, Dialog]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={className}
        style={{ display: "block", padding: 0, border: "none", background: "none", color: "inherit", cursor: "zoom-in", ...style }}
        onClick={() => { setFailed(false); setOpen(true); preloadImageCapabilities(); }}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={open && !Dialog}
        title={previewLabel}
      >
        {children}
      </button>
      {open && Dialog && <Dialog src={src} alt={alt} triggerRef={triggerRef} onClose={() => setOpen(false)} />}
      {failed && <span role="alert">图片预览加载失败，请重试</span>}
    </>
  );
}
