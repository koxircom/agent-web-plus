export type DomCodeLocation = {
  filePath: string;
  line: number;
  column: number | null;
  method: "react-debug-source" | "sourcemap";
  componentName: string | null;
};
export type DomSourceHint = {
  direct?: DomCodeLocation;
  frames: Array<{ url: string; line: number; column: number }>;
  componentName: string | null;
};

/** Serialized into the controlled iframe. Inspect only the picked node/ancestors;
 * never invoke a component, callback, page-defined getter, or DevTools hook. */
export function getDomSourceHint(element: Element): DomSourceHint | null {
  try {
    const own = (value: unknown, key: string): unknown => {
      if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
      const d = Object.getOwnPropertyDescriptor(value, key);
      return d && 'value' in d ? d.value : undefined;
    };
    let node: Element | null = element;
    let fiber: unknown;
    for (let depth = 0; node && depth < 16; depth++, node = node.parentElement) {
      const keys = Object.getOwnPropertyNames(node);
      const key = keys.slice(0, 256).find(k => k.startsWith('__reactFiber$'));
      if (key) { fiber = own(node, key); break; }
    }
    const frames: DomSourceHint['frames'] = [];
    let componentName: string | null = null;
    const seen = new Set<unknown>();
    for (let depth = 0; fiber && depth < 32 && !seen.has(fiber); depth++) {
      seen.add(fiber);
      const type = own(fiber, 'type');
      const name = own(type, 'displayName') ?? own(type, 'name');
      if (!componentName && typeof name === 'string') componentName = name.slice(0, 128) || null;
      const source = own(fiber, '_debugSource');
      const filePath = own(source, 'fileName'), line = own(source, 'lineNumber'), column = own(source, 'columnNumber');
      if (typeof filePath === 'string' && filePath.length <= 1024 && Number.isSafeInteger(line) && Number(line) > 0 && Number(line) <= 1e7) {
        return { direct: { filePath, line: Number(line), column: Number.isSafeInteger(column) && Number(column) > 0 ? Number(column) : null, method: 'react-debug-source', componentName }, frames: [], componentName };
      }
      const error = own(fiber, '_debugStack');
      let stack = own(error, 'stack');
      // New Chromium stores Error.stack as a native accessor. Read that exact
      // native getter only; arbitrary page-defined accessors remain untouched.
      if (stack === undefined && error instanceof Error) {
        const d = Object.getOwnPropertyDescriptor(error, 'stack');
        if (d?.get && /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(d.get))) stack = d.get.call(error);
      }
      if (typeof stack === 'string' && stack.length <= 16384) {
        for (const text of stack.split('\n').slice(1, 12)) {
          const match = text.trim().match(/(?:\(|@|\s)((?:https?:\/\/|file:\/\/\/|about:srcdoc|webpack-internal:\/\/\/)[^\s]*?):(\d+):(\d+)\)?$/);
          if (!match) continue;
          const url = match[1], line = Number(match[2]), column = Number(match[3]);
          if (url.length <= 2048 && line > 0 && line <= 1e7 && column > 0 && column <= 1e7 && !frames.some(f => f.url === url && f.line === line && f.column === column)) frames.push({ url, line, column });
          if (frames.length === 4) break;
        }
      }
      if (frames.length) break;
      // React 19 creation stacks belong to the owner; return is the fallback
      // for renderers that omit owner metadata. Both traversals are bounded.
      fiber = own(fiber, '_debugOwner') ?? own(fiber, 'return');
    }
    return frames.length ? { frames, componentName } : null;
  } catch { return null; }
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = Object.getPrototypeOf(value);
  return (p === null || p === Object.prototype) && Reflect.ownKeys(value).every(k => typeof k === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k) && 'value' in Object.getOwnPropertyDescriptor(value, k)!);
}
function sourcePath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let path = value.trim();
  if (/^(data|javascript|blob):/i.test(path)) return null;
  if (/^https?:\/\//i.test(path)) {
    try { const u = new URL(path); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; path = u.toString(); } catch { return null; }
  } else path = path.split(/[?#]/, 1)[0];
  return path || null;
}
export function normalizeDomCodeLocation(value: unknown): DomCodeLocation | null {
  try {
    if (!record(value) || Object.keys(value).some(k => !['filePath', 'line', 'column', 'method', 'componentName'].includes(k))) return null;
    const filePath = sourcePath(value.filePath);
    if (!filePath || !Number.isSafeInteger(value.line) || Number(value.line) < 1 || Number(value.line) > 1e7 || (value.method !== 'react-debug-source' && value.method !== 'sourcemap')) return null;
    if (value.column !== null && (!Number.isSafeInteger(value.column) || Number(value.column) < 1 || Number(value.column) > 1e7)) return null;
    if (value.componentName !== null && (typeof value.componentName !== 'string' || value.componentName.length > 128 || /[\u0000-\u001f]/.test(value.componentName))) return null;
    return { filePath, line: Number(value.line), column: value.column as number | null, method: value.method, componentName: value.componentName as string | null };
  } catch { return null; }
}
export function normalizeDomSourceHint(value: unknown): DomSourceHint | null {
  try {
    if (!record(value) || Object.keys(value).some(k => !['direct', 'frames', 'componentName'].includes(k)) || !Array.isArray(value.frames) || value.frames.length > 4) return null;
    if (value.componentName !== null && (typeof value.componentName !== 'string' || value.componentName.length > 128)) return null;
    const frames: DomSourceHint['frames'] = [];
    for (const f of value.frames) {
      if (!record(f) || Object.keys(f).some(k => !['url', 'line', 'column'].includes(k)) || typeof f.url !== 'string' || f.url.length > 2048 || !/^(https?:\/\/|file:\/\/\/|about:srcdoc|webpack-internal:\/\/\/)/.test(f.url) || !Number.isSafeInteger(f.line) || Number(f.line) < 1 || Number(f.line) > 1e7 || !Number.isSafeInteger(f.column) || Number(f.column) < 1 || Number(f.column) > 1e7) return null;
      frames.push({ url: f.url, line: Number(f.line), column: Number(f.column) });
    }
    const direct = value.direct === undefined ? undefined : normalizeDomCodeLocation(value.direct);
    if (direct === null) return null;
    return { ...(direct ? { direct } : {}), frames, componentName: value.componentName as string | null };
  } catch { return null; }
}

const MAX_BYTES = 1024 * 1024;
/** Bounded streamed read; same-origin public scripts/maps only, no API requests,
 * redirects or arbitrary file fetches. Preview-inline maps need no network. */
export async function loadDomSourceAsset(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
  if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES || !response.body) throw Error('source unavailable');
  const reader = response.body.getReader();
  let size = 0, output = '';
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw Error('source too large');
      output += decoder.decode(part.value, { stream: true });
    }
    return output + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function resolveDomSource(hintValue: unknown, options: {
  html?: string;
  pageUrl: string;
  filePath?: string | null;
  sourceSessionId?: string | null;
  executionEngine?: "pi" | "codex" | "unknown";
  signal: AbortSignal;
  load?: (url: string, signal: AbortSignal) => Promise<string>;
}): Promise<DomCodeLocation | null> {
  const hint = normalizeDomSourceHint(hintValue);
  if (!hint || options.signal.aborted) return null;
  if (hint.direct) return hint.direct;
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(abort, 2500);
  const load = options.load ?? loadDomSourceAsset;
  const assets = new Map<string, Promise<string | null>>();
  const read = (url: string): Promise<string | null> => {
    let result = assets.get(url);
    if (!result) { result = load(url, controller.signal).catch(() => null); assets.set(url, result); }
    return result;
  };
  const safeUrl = (raw: string, base: string): string | null => {
    try {
      const url = new URL(raw, base), page = new URL(options.pageUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== page.origin || url.username || url.password || /^\/api(?:\/|$)/i.test(decodeURIComponent(url.pathname)) || !/\.(?:[cm]?js|map)$/i.test(url.pathname)) return null;
      return url.href;
    } catch { return null; }
  };
  // Local previews keep their opaque iframe sandbox. Read only sibling assets
  // through the existing authenticated/engine-aware file route, never file://.
  const localUrl = (raw: string, base: string): string | null => {
    if (!options.filePath || !/^(?:\/|[a-zA-Z]:[\\/])/.test(options.filePath)) return null;
    try {
      const preview = new URL('file://' + (options.filePath.startsWith('/') ? '' : '/') + options.filePath.replace(/\\/g, '/'));
      const dir = new URL('.', preview), url = new URL(raw, base === 'about:srcdoc' ? preview.href : base);
      if (url.protocol !== 'file:' || url.host || url.search || url.hash || !/\.(?:[cm]?js|map)$/i.test(url.pathname) || !url.pathname.startsWith(dir.pathname) || /%2f|%5c|%00/i.test(url.pathname)) return null;
      let file = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:\//.test(file)) file = file.slice(1);
      const encoded = file.split('/').map(encodeURIComponent).join('/').replace(/^\//, '');
      const query = new URLSearchParams({ type: 'download' });
      if (options.sourceSessionId) query.set('sessionId', options.sourceSessionId);
      if (options.executionEngine === 'pi' || options.executionEngine === 'codex') query.set('engine', options.executionEngine);
      return new URL('/api/files/' + encoded + '?' + query, options.pageUrl).href;
    } catch { return null; }
  };
  try {
    const html = options.html && options.html.length <= 2 * MAX_BYTES ? options.html : '';
    for (const frame of hint.frames) {
      if (controller.signal.aborted) return null;
      let code: string | null = null, line = frame.line, column = frame.column - 1;
      // Raw script offsets preserve HTML line/column positions; parsing the DOM
      // would normalize newlines and lose the actual generated coordinates.
      for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
        const text = match[1];
        const sourceUrl = [...text.matchAll(/\/\/[#@]\s*sourceURL=([^\s]+)/g)].at(-1)?.[1];
        if (sourceUrl === frame.url) { code = text; break; }
        if (frame.url !== 'about:srcdoc') continue;
        const start = match.index! + match[0].indexOf('>') + 1;
        const before = html.slice(0, start), startLine = before.split('\n').length;
        const startColumn = start - (before.lastIndexOf('\n') + 1);
        const lines = text.split('\n');
        if (line < startLine || line >= startLine + lines.length) continue;
        line = frame.line - startLine + 1;
        if (line === 1) column -= startColumn;
        code = text;
        break;
      }
      let generatedUrl = frame.url;
      if (code === null) {
        const url = safeUrl(frame.url, options.pageUrl) ?? localUrl(frame.url, options.pageUrl);
        if (!url) continue;
        code = await read(url);
        // Keep the actual script URL as the base for its sibling map.
        generatedUrl = frame.url;
      }
      if (!code || code.length > MAX_BYTES || controller.signal.aborted || column < 0) continue;
      const mapRef = [...code.matchAll(/(?:\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)\s*\*\/)/g)].at(-1);
      const ref = mapRef?.[1] ?? mapRef?.[2];
      if (!ref || ref.length > MAX_BYTES) continue;
      let text: string | null = null;
      if (ref.startsWith('data:')) {
        const data = ref.match(/^data:application\/json(?:;charset=[\w-]+)?(;base64)?,(.*)$/);
        if (data) { try { text = data[1] ? new TextDecoder().decode(Uint8Array.from(atob(data[2]), c => c.charCodeAt(0))) : decodeURIComponent(data[2]); } catch { /* fallback */ } }
      } else {
        const url = safeUrl(ref, generatedUrl) ?? localUrl(ref, generatedUrl);
        if (url) text = await read(url);
      }
      if (!text || text.length > MAX_BYTES || controller.signal.aborted) continue;
      try {
        const map = JSON.parse(text);
        if (!record(map) || map.version !== 3 || typeof map.mappings !== 'string' || map.mappings.length > 512 * 1024 || !Array.isArray(map.sources) || map.sources.length > 1024 || !map.sources.every(s => typeof s === 'string' && s.length <= 2048) || !Array.isArray(map.names) || map.names.length > 10000 || (map.sourceRoot !== undefined && (typeof map.sourceRoot !== 'string' || map.sourceRoot.length > 1024))) continue;
        // Source contents are unnecessary: neither retain nor send them.
        const { TraceMap, originalPositionFor } = await import('@jridgewell/trace-mapping');
        if (controller.signal.aborted) return null;
        const mapped = originalPositionFor(new TraceMap({ version: 3, sources: map.sources, names: map.names, mappings: map.mappings, sourceRoot: map.sourceRoot as string | undefined }), { line, column });
        if (mapped.source === null || mapped.line === null || mapped.column === null || /(?:^|\/)node_modules\//.test(mapped.source)) continue;
        const location = normalizeDomCodeLocation({ filePath: mapped.source, line: mapped.line, column: mapped.column + 1, method: 'sourcemap', componentName: hint.componentName });
        if (location) return location;
      } catch { /* Broken/unsupported maps must not block feedback. */ }
    }
    return null;
  } finally { clearTimeout(timeout); options.signal.removeEventListener('abort', abort); controller.abort(); }
}
