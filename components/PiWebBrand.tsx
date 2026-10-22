"use client";

import React from "react";
import { BRAND_SVG_CONSTANTS, WELCOME_BRAND_SVG_CONSTANTS, BRAND_ICON_SVG_CONSTANTS, BRAND_NAME, CODEX_BRAND_SYMBOL_PATH } from "@/lib/branding";

export interface PiWebBrandProps {
  variant?: "pi" | "codex";
  presentation?: "compact" | "welcome";
  className?: string;
  style?: React.CSSProperties;
  width?: number | string;
  height?: number | string;
  ariaLabel?: string;
  title?: string;
  priority?: boolean;
}

/**
 * Agent Web Plus 核心原生矢量品牌标识组件 (816x186 exact viewBox, 纯矢量无外链)
 * 平面蓝紫渐变双圆 + 精准贝塞尔白色 π 与独立 + 徽标 + 渐变 Plus
 * 文本字标采用 fill="currentColor"，自动适配暗黑/浅色及各种自定义 CSS 主题，
 * 支持 SSR 与首屏 0ms 秒开。
 */
export function PiWebBrand({
  variant = "pi",
  presentation = "compact",
  className,
  style,
  width = 215,
  height = 49,
  ariaLabel,
  title,
}: PiWebBrandProps) {
  const c = presentation === "welcome" ? WELCOME_BRAND_SVG_CONSTANTS : BRAND_SVG_CONSTANTS;
  const id = React.useId();
  const codex = variant === "codex";
  const label = codex ? BRAND_NAME : `π+ ${BRAND_NAME}`;
  const graphicGradient = codex ? `${id}-codex-disc` : "flatBlueViolet";
  const textGradient = codex ? `${id}-codex-plus` : "plusGradient";
  const wordmark = c.wordmark;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={c.viewBox}
      data-pi-brand-engine={variant}
      width={width}
      height={height}
      preserveAspectRatio="xMinYMid meet"
      fill="none"
      role="img"
      aria-label={ariaLabel ?? label}
      className={className}
      style={{
        display: "block",
        flexShrink: 0,
        maxWidth: "100%",
        objectFit: "contain",
        objectPosition: "left center",
        ...style,
      }}
    >
      {(title ?? label) && <title>{title ?? label}</title>}
      <defs>
        <linearGradient id={graphicGradient} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4F5AE8" />
          <stop offset="100%" stopColor="#7850E8" />
        </linearGradient>
        <linearGradient id={textGradient} gradientUnits="userSpaceOnUse"
          x1={wordmark.plusX} y1={56}
          x2={wordmark.plusX + 150} y2={140}>
          <stop offset="0%" stopColor="#6E67F8" />
          <stop offset="25%" stopColor="#585BF9" />
          <stop offset="52%" stopColor="#3B4FFB" />
          <stop offset="78%" stopColor="#2563EB" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
      <g id="brand-graphic">
        <circle id="flat-main-disc" cx="91.2" cy="96" r="87.5" fill={`url(#${graphicGradient})`} />
        {codex ? (
          <path data-pi-brand-part="codex-symbol" d={CODEX_BRAND_SYMBOL_PATH}
            stroke={c.symbolColor} strokeWidth="13" strokeLinecap="round" strokeLinejoin="round" />
        ) : <path id="symbol-pi" fill={c.symbolColor} d={c.piPath} />}
        <circle id="flat-plus-disc" cx="167" cy="38" r="34" fill={c.plusDiscColor} stroke={c.symbolColor} strokeWidth="1.6" />
        <path id="symbol-plus" fill={c.symbolColor} d={c.plusPath} />
      </g>
      <g id="brand-typography">
        <text
          data-pi-brand-part="wordmark"
          fill="currentColor"
          fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
          fontSize={c.wordmark.fontSize}
          fontWeight={c.wordmark.fontWeight}
          letterSpacing={c.wordmark.letterSpacing}
          x={wordmark.piX}
          y={wordmark.y}
        >
          <tspan fill="currentColor">Agent Web </tspan>
          <tspan fill={`url(#${textGradient})`}>Plus</tspan>
        </text>
      </g>
    </svg>
  );
}

export interface PiWebBrandIconProps {
  className?: string;
  style?: React.CSSProperties;
  size?: number | string;
  ariaLabel?: string;
}

/**
 * 单独圆盘 π+ 原生矢量图标组件（用于方形头像、登录页品牌等）
 */
export function PiWebBrandIcon({
  className,
  style,
  size = 48,
  ariaLabel = `π+ ${BRAND_NAME}`,
}: PiWebBrandIconProps) {
  const c = BRAND_SVG_CONSTANTS;
  const icon = BRAND_ICON_SVG_CONSTANTS;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={icon.viewBox}
      width={size}
      height={size}
      fill="none"
      role="img"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: "block",
        flexShrink: 0,
        ...style,
      }}
    >
      <defs>
        <linearGradient id="iconFlatBlueViolet" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4F5AE8" />
          <stop offset="100%" stopColor="#7850E8" />
        </linearGradient>
      </defs>
      <g transform={icon.transform}>
        <g id="icon-brand-graphic">
          <circle id="icon-flat-main-disc" cx="91.2" cy="96" r="87.5" fill="url(#iconFlatBlueViolet)" />
          <path id="icon-symbol-pi" fill={c.symbolColor} d={c.piPath} />
          <circle id="icon-flat-plus-disc" cx="167" cy="38" r="34" fill={c.plusDiscColor} stroke={c.symbolColor} strokeWidth="1.6" />
          <path id="icon-symbol-plus" fill={c.symbolColor} d={c.plusPath} />
        </g>
      </g>
    </svg>
  );
}

export default PiWebBrand;
