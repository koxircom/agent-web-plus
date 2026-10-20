"use client";
import { useEffect } from "react";
import { mountTabFavicon } from "@/lib/tab-favicon";

export function useTabFavicon(engine: "pi" | "codex") {
  useEffect(() => mountTabFavicon(engine, document, window), [engine]);
}
