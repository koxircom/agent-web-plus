/**
 * @file lib/branding.ts
 * Agent Web Plus 自有独立版核心品牌规范与矢量事实源。
 * 纯常数与纯函数，无 React hooks 与 window 依赖，可安全用于 Next Server Components 与 SSR metadata。
 */

import {
  ENHANCEMENT_METADATA,
  createFastPluginReader,
  type StorageGetter,
} from "./enhancement-settings.generated.ts";

export const BRAND_NAME = "Agent Web Plus";
export const BRAND_SHORT_NAME = "Agent Web Plus";
export const BRANDING_PREFERENCE_KEY = "pi-web-plus-branding";
export const BRANDING_PREFERENCE_CHANGE_EVENT = "pi-web-plus-branding-change";
export const BRAND_GITHUB_URL = "https://github.com/koxircom/agent-web-plus";
export const CODEX_BRAND_SYMBOL_PATH = "M51 66 79 94 51 122M96 122h37";
export const CODEX_CLI_GITHUB_URL = "https://github.com/openai/codex";

/**
 * 矢量图标与字标几何常量（唯一事实源）
 * exact 816x186 viewBox：引擎符号与 Agent Web Plus 字标共用同一几何。
 */
export const BRAND_SVG_CONSTANTS = {
  viewBox: "0 0 816 186",
  width: 215,
  height: 49,
  mainDiscColor: "url(#flatBlueViolet)",
  plusDiscColor: "#6250E9",
  symbolColor: "#FFFFFF",
  piPath:
    "M67.7,59.5H132.7C135.9,59.5 136.1,62.9 135.4,67.2C134.8,71.3 133.9,73.5 130.4,73.5H114.1L107.7,107.5C106.3,114.4 106.7,118.8 110.8,121.2C114.6,123.3 121.1,123.8 124.9,119.8C126.7,117.9 128.6,120 129.5,123C131.7,130.9 122.2,137.5 113.8,137.5C101.1,137.5 92.2,131.4 93.7,114.9C94.1,105.5 97.7,86.3 100.5,73.5H82.1L75.5,108.4C72.9,122.1 66.6,137.5 55.6,137.5C49.5,137.5 45.8,132.7 48,127.2C49.6,123.8 54.5,122 57.5,116C62.4,106.5 65.3,89.4 68.7,73.7H60.2C56.7,73.7 55.3,75.4 53.1,78.4C50.5,82.3 43.5,82.9 44.9,77.2C47.2,67.1 56.2,59.5 67.7,59.5Z",
  plusPath:
    "M162.7,19.5L169.7,19.5L169.7,20.5L170.7,20.5L170.7,33.5L182.7,33.5L182.7,40.5L171.7,40.5L171.7,41.5L170.7,41.5L170.7,54.5L162.7,54.5L162.7,41.5L150.7,41.5L150.7,40.5L149.7,40.5L149.7,33.5L162.7,33.5Z",
  wordmark: {
    piX: 230,
    webX: 346,
    plusX: 620,
    y: 138,
    text: BRAND_NAME,
    fontSize: 64,
    fontWeight: 700,
    letterSpacing: "normal",
  },
} as const;

// 欢迎页沿用原生字标/图标比例；长品牌名需要相应加宽画布。
export const WELCOME_BRAND_SVG_CONSTANTS = {
  ...BRAND_SVG_CONSTANTS,
  viewBox: "0 0 1080 186",
  wordmark: {
    ...BRAND_SVG_CONSTANTS.wordmark,
    fontSize: 94,
    plusX: 803,
  },
} as const;

/**
 * 单独圆盘图标（用于方形 App 图标、登录页图标等）的 viewBox 与路径
 * 居中于 200x200 画布
 */
export const BRAND_ICON_SVG_CONSTANTS = {
  viewBox: "0 0 200 200",
  width: 200,
  height: 200,
  transform: "translate(13.7 21.6) scale(0.84)",
} as const;

/**
 * 读取品牌装饰偏好状态（开/关）
 * 注意：base 名字和 logo 属于自有独立版身份，无论此开关状态为何，基础标识均为 Agent Web Plus。
 * 开关仅控制附加紧凑头距、字体和间距等微调装饰。
 * 使用 generated canonical reader factory，无额外私有算法。
 */
export function isBrandingDecorationsActive(
  storageGetter?: StorageGetter,
): boolean {
  if (storageGetter) {
    return createFastPluginReader(storageGetter, ENHANCEMENT_METADATA)(BRANDING_PREFERENCE_KEY);
  }
  // 在服务端/无 window 状态下，默认启用
  if (typeof window === "undefined" || !window.localStorage) {
    return true;
  }
  try {
    return createFastPluginReader((k) => window.localStorage.getItem(k), ENHANCEMENT_METADATA)(BRANDING_PREFERENCE_KEY);
  } catch {
    return true;
  }
}

/**
 * 生成独立 SVG 字符串
 */
export function buildPiWebPlusBrandSvgString(textColor = "currentColor"): string {
  const c = BRAND_SVG_CONSTANTS;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${c.viewBox}" width="${c.width}" height="${c.height}" fill="none" role="img" aria-label="π+ ${c.wordmark.text}"><title>π+ ${c.wordmark.text}</title><defs><linearGradient id="flatBlueViolet" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#4F5AE8"/><stop offset="100%" stop-color="#7850E8"/></linearGradient><linearGradient id="plusGradient" gradientUnits="userSpaceOnUse" x1="${c.wordmark.plusX}" y1="56" x2="${c.wordmark.plusX + 150}" y2="140"><stop offset="0%" stop-color="#6E67F8"/><stop offset="25%" stop-color="#585BF9"/><stop offset="52%" stop-color="#3B4FFB"/><stop offset="78%" stop-color="#2563EB"/><stop offset="100%" stop-color="#1D4ED8"/></linearGradient></defs><g id="brand-graphic"><circle id="flat-main-disc" cx="91.2" cy="96" r="87.5" fill="url(#flatBlueViolet)"/><path id="symbol-pi" fill="${c.symbolColor}" d="${c.piPath}"/><circle id="flat-plus-disc" cx="167" cy="38" r="34" fill="${c.plusDiscColor}" stroke="${c.symbolColor}" stroke-width="1.6"/><path id="symbol-plus" fill="${c.symbolColor}" d="${c.plusPath}"/></g><g id="brand-typography"><text data-pi-brand-part="wordmark" x="${c.wordmark.piX}" y="${c.wordmark.y}" fill="${textColor}" font-family="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif" font-size="${c.wordmark.fontSize}" font-weight="${c.wordmark.fontWeight}" letter-spacing="${c.wordmark.letterSpacing}"><tspan fill="${textColor}">Agent Web </tspan><tspan fill="url(#plusGradient)">Plus</tspan></text></g></svg>`;
}
