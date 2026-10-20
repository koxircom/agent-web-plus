"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  getEnhancementSearchResultDataProps,
  getSessionSearchCatalogScope,
  processEnhancementSearchResults,
} from "@/lib/enhancement-sidebar-bridge";
import { formatRelativeTime } from "@/lib/i18n/format";
import type { SessionInfo } from "@/lib/types";
import type { SessionSearchResponse } from "@/lib/session-search";

export function SessionSearch({ executionEngine = "pi", open, query, children, sessions, selectedSessionId, onSelectSession, onUnavailableSession }: {
  executionEngine?: "pi" | "codex";
  open: boolean;
  query: string;
  children: ReactNode;
  sessions: readonly SessionInfo[];
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, entryId?: string, blockIndex?: number) => void;
  onUnavailableSession?: (sessionId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<{ query: string; scope?: string; response?: SessionSearchResponse; failed?: boolean }>({ query: "" });
  const [selectionMessage, setSelectionMessage] = useState<"unavailable" | "failed" | null>(null);
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const selectionSerial = useRef(0);
  const lookupController = useRef<AbortController | null>(null);
  const catalog = useMemo(() => new Map(sessions.filter((session) => !session.transient && !session.submissionPending)
    .map((session) => [session.id, session])), [sessions]);
  const catalogRef = useRef(catalog);
  catalogRef.current = catalog;
  const scope = getSessionSearchCatalogScope(sessions);
  const search = query.trim();
  const response = state.query === search && state.scope === scope ? state.response : undefined;
  const failed = state.query === search && state.scope === scope && state.failed;

  // Revalidate membership/title changes, without restarting on every agent tick.
  useEffect(() => {
    if (!open || !search) return;
    const controller = new AbortController();
    setState({ query: search, scope });
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/sessions/search?${new URLSearchParams({ q: search, engine: executionEngine })}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as SessionSearchResponse;
        if (!controller.signal.aborted) setState({ query: search, scope, response: data });
      } catch {
        if (!controller.signal.aborted) setState({ query: search, scope, failed: true });
      }
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, search, scope, executionEngine]);

  useEffect(() => {
    setOpeningSessionId(null);
    return () => {
      selectionSerial.current++;
      lookupController.current?.abort();
    };
  }, [open, search, scope, executionEngine]);

  async function selectResult(session: SessionInfo, entryId?: string, blockIndex?: number) {
    lookupController.current?.abort();
    const controller = new AbortController();
    lookupController.current = controller;
    const serial = ++selectionSerial.current;
    setSelectionMessage(null);
    setOpeningSessionId(session.id);
    try {
      const result = await fetch(`/api/sessions/${encodeURIComponent(session.id)}?lookup=1`, {
        cache: "no-store", signal: controller.signal,
      });
      if (controller.signal.aborted || serial !== selectionSerial.current) return;
      if (result.status === 404) {
        setSelectionMessage("unavailable");
        setState((current) => current.response ? { ...current, response: {
          ...current.response, results: current.response.results.filter((item) => item.session.id !== session.id),
        } } : current);
        onUnavailableSession?.(session.id);
        return;
      }
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      const identity = await result.json() as { sessionId?: string; exists?: boolean };
      if (controller.signal.aborted || serial !== selectionSerial.current) return;
      if (identity.sessionId !== session.id || identity.exists !== true) throw new Error("Invalid session lookup");
      const current = catalogRef.current.get(session.id);
      if (current) onSelectSession(current, entryId, blockIndex);
    } catch {
      if (!controller.signal.aborted && serial === selectionSerial.current) setSelectionMessage("failed");
    } finally {
      if (serial === selectionSerial.current) setOpeningSessionId(null);
    }
  }

  const results = processEnhancementSearchResults(response?.results)
    .filter((item) => catalog.has(item.session.id))
    .map((item) => ({ ...item, session: catalog.get(item.session.id)! }));

  return !open || !search ? children : (
    <div className="min-h-20 flex-1 overflow-y-auto" aria-busy={!response && !failed}>
      <div role="status" className="px-3 py-2 text-xs text-text-muted">
        {failed ? t("sidebar.sessionSearchFailed") : !response ? t("sidebar.sessionSearching")
          : results.length === 0 ? t("sidebar.sessionSearchEmpty")
          : t("sidebar.sessionSearchCount", { count: results.length })}
      </div>
      {selectionMessage && <div role="status" className="px-3 pb-2 text-xs text-text-muted">
        {t(selectionMessage === "unavailable" ? "sidebar.sessionSearchUnavailable" : "sidebar.sessionSearchOpenFailed")}
      </div>}
      {response?.truncated && (
        <div role="status" className="px-3 pb-2 text-xs text-text-muted">{t("sidebar.sessionSearchPartial")}</div>
      )}
      {results.map((item) => {
        const { session, entryId, blockIndex, before, match, after } = item;
        return (
        <button
          key={session.id}
          type="button"
          {...getEnhancementSearchResultDataProps(item)}
          onClick={() => void selectResult(session, entryId, blockIndex)}
          disabled={openingSessionId === session.id}
          aria-current={session.id === selectedSessionId ? "true" : undefined}
          className={`block w-full cursor-pointer border-b border-border px-3 py-2 text-left hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-accent ${session.id === selectedSessionId ? "bg-bg-selected" : ""}`}
        >
          <span className="block truncate text-xs font-medium text-text">{session.name || session.firstMessage}</span>
          <span className="mt-1 flex min-w-0 gap-2 text-[10px] text-text-dim">
            <span className="min-w-0 flex-1 truncate" title={session.cwd}>{session.cwd}</span>
            <span className="shrink-0">{formatRelativeTime(session.modified, locale)}</span>
          </span>
          <span className="mt-1 block text-xs leading-relaxed wrap-anywhere text-text-muted">
            {before}<mark className="rounded-sm bg-accent/20 text-text">{match}</mark>{after}
          </span>
        </button>
        );
      })}
    </div>
  );
}
