/** Update client-owned session context without navigating/remounting the shell. */
export function replaceSessionUrl(url: string): void {
  if (typeof window === "undefined") return;
  const next = new URL(url, window.location.href);
  if (next.origin !== window.location.origin || next.pathname !== window.location.pathname) {
    throw new Error("Session navigation must stay on the current page");
  }
  if (next.href === window.location.href) return;
  // Next patches the native History API to keep useSearchParams synchronized.
  window.history.replaceState(null, "", next.pathname + next.search + next.hash);
}

/** A directory belongs to an execution host; persist both in shareable links. */
export function newSessionUrl(cwd: string, engine: "pi" | "codex"): string {
  return `?engine=${engine}&cwd=${encodeURIComponent(cwd)}`;
}
