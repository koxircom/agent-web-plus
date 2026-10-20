import type { TabOpen } from "./tab-session";

export interface InitialNavigation {
  requestedCwd: string | null;
  engine?: "pi" | "codex";
  sessionId: string | null;
  sidebarCollapsed: boolean;
}

export function getInitialNavigation(
  searchParams: Pick<URLSearchParams, "get">,
): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;

  const sessionId = requestedCwd ? null : (searchParams.get("session") || null);
  const hint = searchParams.get("engine");
  const engine = hint === "pi" || hint === "codex"
    ? (sessionId ? (sessionId.startsWith("codex:") ? "codex" : "pi") : hint) : undefined;

  return {
    ...(engine ? { engine } : {}),
    requestedCwd,
    sessionId,
    sidebarCollapsed: searchParams.get("sidebar") === "collapsed",
  };
}

/**
 * Apply per-tab memory to a navigation snapshot that was taken from the URL
 * alone. Returns the same object when the URL already chose a cwd or session,
 * or when this tab has nothing stored.
 *
 * A remembered session fills `sessionId`. A remembered new-session composer
 * fills `requestedCwd` so reload shows that UI instead of the previous chat.
 *
 * Call this after mount. Reading sessionStorage during the first client render
 * (including a `useState` initializer) makes SSR HTML diverge from the client
 * tree — sessionStorage is empty on the server — and React reports a
 * hydration text mismatch in the sidebar / placeholder.
 */
export function withTabOpen(
  navigation: InitialNavigation,
  tabOpen: TabOpen | null,
): InitialNavigation {
  // Old cwd-only links can use this tab's exact composer context. Never borrow
  // another directory's engine, or override an explicit link/session identity.
  if (navigation.requestedCwd && !navigation.engine && tabOpen?.kind === "new"
    && tabOpen.cwd === navigation.requestedCwd && tabOpen.engine) {
    return { ...navigation, engine: tabOpen.engine };
  }
  if (navigation.requestedCwd || navigation.sessionId || !tabOpen
    || (navigation.engine && (tabOpen.kind === "session"
      ? (tabOpen.sessionId.startsWith("codex:") ? "codex" : "pi") : tabOpen.engine) !== navigation.engine)) {
    return navigation;
  }
  if (tabOpen.kind === "session") {
    return { ...navigation, sessionId: tabOpen.sessionId };
  }
  return { ...navigation, requestedCwd: tabOpen.cwd, ...(tabOpen.engine ? { engine: tabOpen.engine } : {}) };
}

/** A route/tab selection outranks the shared default for new tabs. */
export function navigationEngine(navigation: InitialNavigation): "pi" | "codex" | undefined {
  return navigation.sessionId
    ? (navigation.sessionId.startsWith("codex:") ? "codex" : "pi")
    : navigation.engine;
}
