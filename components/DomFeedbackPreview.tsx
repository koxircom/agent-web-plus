'use client';
import { useEffect, useId, useMemo, useState } from 'react';
import { buildAnnotatedPreview } from '@/lib/dom-feedback/preview';

export function DomFeedbackPreview({ content, filePath, title }: { content: string; filePath: string; title: string }) {
  const token = useId();
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const document = useMemo(() => origin ? buildAnnotatedPreview(content, token, filePath, origin) : content, [content, token, filePath, origin]);
  if (!origin) return <div role="status" style={{ padding: 12, color: "var(--text-muted)" }}>正在加载预览…</div>;
  return <iframe srcDoc={document} sandbox="allow-scripts" title={title} data-dom-feedback-token={token} data-dom-feedback-file-path={filePath}
    style={{ width: '100%', height: '100%', border: 'none', background: 'var(--bg)' }} />;
}
