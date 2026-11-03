"use client";
import { useEffect } from "react";
import { useBrowserTabTitle } from "./useBrowserTabTitle";
import { mountTabThemeColor } from "@/lib/browser-tab-appearance";
import { mountTabFavicon } from "@/lib/tab-favicon";

export function useTabFavicon(engine: "pi" | "codex") {
  const { appearance } = useBrowserTabTitle();
  const logoColor = appearance?.logoColor ?? "", themeColor = appearance?.themeColor ?? "";
  useEffect(() => mountTabFavicon(engine, document, window, logoColor), [engine, logoColor]);
  useEffect(() => mountTabThemeColor(themeColor, document), [themeColor]);
}
