import { clipCodePoints, CONTROL_AND_LINEBREAK_RE } from "./browser-tab-title-normalization.ts";

export interface BrowserTabAppearance {
  titleTemplate: string;
  logoColor: string;
  themeColor: string;
}
export const DEFAULT_TAB_APPEARANCE: BrowserTabAppearance = Object.freeze({
  titleTemplate: "{project} - {app}", logoColor: "", themeColor: "",
});
export function isTabColor(value: unknown): value is string {
  return typeof value === "string" && (value === "" || /^#[0-9a-fA-F]{6}$/.test(value));
}
export function isBrowserTabAppearance(value: unknown): value is BrowserTabAppearance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && Object.keys(v).every(k => ["titleTemplate", "logoColor", "themeColor"].includes(k))
    && typeof v.titleTemplate === "string" && v.titleTemplate.trim().length > 0
    && Array.from(v.titleTemplate).length <= 160
    && v.titleTemplate === v.titleTemplate.replace(CONTROL_AND_LINEBREAK_RE, "")
    && !/[{}]/.test(v.titleTemplate.replace(/\{(project|agent|text|app)\}/g, ""))
    && isTabColor(v.logoColor) && isTabColor(v.themeColor);
}
export function sameBrowserTabAppearance(a: BrowserTabAppearance | null, b: BrowserTabAppearance | null): boolean {
  return a === b || (a !== null && b !== null && a.titleTemplate === b.titleTemplate && a.logoColor === b.logoColor && a.themeColor === b.themeColor);
}
export function formatBrowserTabTitle(appearance: BrowserTabAppearance, values: {project: string; agent: string; text: string; app: string}): string {
  const parts = appearance.titleTemplate.split(/(\{(?:project|agent|text|app)\})/g);
  const separator = /^\s*[-|/:,\u00b7\u2022\u2013\u2014]+\s*$/;
  for (let i = 1; i < parts.length; i += 2) {
    const key = parts[i].slice(1, -1) as keyof typeof values;
    const value = values[key];
    parts[i] = value;
    if (!value.trim()) {
      if (i > 1 && separator.test(parts[i - 1])) parts[i - 1] = "";
      else if (i + 1 < parts.length && separator.test(parts[i + 1])) parts[i + 1] = "";
    }
  }
  const title = parts.join("");
  return clipCodePoints(title.replace(CONTROL_AND_LINEBREAK_RE, "").trim(), 160) || values.project || values.app;
}

/** Own only theme-color metadata, restoring each original media-specific fallback. */
export function mountTabThemeColor(color: string, doc: Document) {
  if (!color || !isTabColor(color)) return () => {};
  const metas = Array.from(doc.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  const created = metas.length ? null : doc.createElement("meta");
  if (created) { created.name = "theme-color"; doc.head.appendChild(created); metas.push(created); }
  const originals = metas.map(e => e.getAttribute("content"));
  for (const e of metas) e.content = color;
  return () => metas.forEach((e, i) => {
    if (e === created) e.remove();
    else if (originals[i] === null) e.removeAttribute("content");
    else e.setAttribute("content", originals[i]!);
  });
}
