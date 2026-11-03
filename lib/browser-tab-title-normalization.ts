export const BROWSER_TAB_TITLE_MAX_CODEPOINTS = 80;

// 去除换行（\r, \n）、C0 控制字符（0x00-0x1F）、DEL（0x7F）及 C1 控制字符（0x80-0x9F）
export const CONTROL_AND_LINEBREAK_RE = /[\r\n\u0000-\u001F\u007F-\u009F]/g;

export function clipCodePoints(str: string, maxCodePoints: number): string {
  const codePoints = Array.from(str);
  return codePoints.length > maxCodePoints
    ? codePoints.slice(0, maxCodePoints).join("")
    : str;
}

export function normalizeBrowserTabTitle(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const withoutControls = raw.replace(CONTROL_AND_LINEBREAK_RE, "");
  const truncated = clipCodePoints(withoutControls, BROWSER_TAB_TITLE_MAX_CODEPOINTS);
  return truncated.trim();
}

export function sanitizeRawBrowserTabTitle(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const withoutControls = raw.replace(CONTROL_AND_LINEBREAK_RE, "");
  return clipCodePoints(withoutControls, BROWSER_TAB_TITLE_MAX_CODEPOINTS);
}
