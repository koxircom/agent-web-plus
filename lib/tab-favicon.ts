import { BRAND_ICON_SVG_CONSTANTS, BRAND_NAME, BRAND_SVG_CONSTANTS, CODEX_BRAND_SYMBOL_PATH } from "./branding";

export interface TabStatusSnapshot {
  count?: number;
  running?: number;
  attention?: number;
  hasAttention?: boolean;
  healthy?: boolean;
}

/** Shared brand geometry; only the active engine chooses the base symbol. */
export function buildTabFaviconSvg(engine: "pi" | "codex", status?: TabStatusSnapshot): string {
  const c = BRAND_SVG_CONSTANTS;
  const attention = status?.hasAttention === true;
  const raw = status?.healthy !== false && (status?.count ?? 0) > 0
    ? (attention ? status?.attention : status?.running) : 0;
  const count = typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  const symbol = engine === "codex"
    ? `<path data-brand-symbol="codex" d="${CODEX_BRAND_SYMBOL_PATH}" stroke="${c.symbolColor}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path data-brand-symbol="pi" fill="${c.symbolColor}" d="${c.piPath}"/>`;
  const plus = count ? "" : `<circle cx="167" cy="38" r="34" fill="${c.plusDiscColor}" stroke="${c.symbolColor}" stroke-width="1.6"/><path fill="${c.symbolColor}" d="${c.plusPath}"/>`;
  const badge = count > 9 ? "9+" : String(count);
  const counter = count ? `<circle cx="167" cy="38" r="34" fill="${attention ? "#f59e0b" : "#3b82f6"}" stroke="#FFFFFF" stroke-width="3"/><text x="167" y="${badge.length > 1 ? 46 : 47}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${badge.length > 1 ? 22 : 26}" font-weight="700" fill="white">${badge}</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" data-brand-engine="${engine}"><title>${BRAND_NAME}</title><defs><linearGradient id="tab-disc" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#4F5AE8"/><stop offset="100%" stop-color="#7850E8"/></linearGradient></defs><g transform="${BRAND_ICON_SVG_CONSTANTS.transform}"><circle cx="91.2" cy="96" r="87.5" fill="url(#tab-disc)"/>${symbol}${plus}</g>${counter}</svg>`;
}

/** The native tab owner updates all metadata fallbacks together, then restores
 * their original attributes on unmount. No observer, timer or second icon owner. */
export function mountTabFavicon(engine: "pi" | "codex", doc: Document, win: Window) {
  const icons = Array.from(doc.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
  const created = icons.length === 0 ? doc.createElement("link") : null;
  if (created) { created.rel = "icon"; doc.head.appendChild(created); icons.push(created); }
  const attributes = ["href", "type", "sizes"] as const;
  const originals = icons.map(icon => attributes.map(name => icon.getAttribute(name)));
  let previous = "";
  const refresh = () => {
    const status = (win as Window & { __PI_WEB_PROJECT_TAB_STATUS__?: TabStatusSnapshot }).__PI_WEB_PROJECT_TAB_STATUS__;
    const href = `data:image/svg+xml,${encodeURIComponent(buildTabFaviconSvg(engine, status))}`;
    if (href === previous) return;
    previous = href;
    for (const icon of icons) { icon.href = href; icon.type = "image/svg+xml"; icon.sizes.value = "any"; }
  };
  refresh();
  win.addEventListener("pi-web-project-tab-status-change", refresh);
  return () => {
    win.removeEventListener("pi-web-project-tab-status-change", refresh);
    for (let i = 0; i < icons.length; i++) {
      if (icons[i] === created) { icons[i].remove(); continue; }
      attributes.forEach((name, j) => {
        const value = originals[i][j];
        if (value === null) icons[i].removeAttribute(name); else icons[i].setAttribute(name, value);
      });
    }
  };
}
