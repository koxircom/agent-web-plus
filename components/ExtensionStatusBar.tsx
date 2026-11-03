"use client";

import { useEffect, useState } from "react";
import { stripAnsi } from "@/lib/ansi";
import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { isSettingsPluginEnabled, settingsExtensionRegistry } from "@/lib/settings-extensions";
import { AnsiText } from "./AnsiText";
import { ExtensionWidgets } from "./ExtensionWidgets";

export function sanitizeExtensionStatusText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, " ").replace(/ +/g, " ").trim())
    .join("\n")
    .trim();
}

export function formatExtensionStatusLine(statuses: ExtensionStatusItem[]): string {
  return [...statuses]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ text }) => sanitizeExtensionStatusText(text))
    .join(" ");
}

export function getSafeSessionTitle(session: { name?: string; id?: string } | null | undefined): string {
  if (!session) return "会话";
  const raw = typeof session.name === "string" ? session.name.trim() : "";
  if (!raw) return "会话";
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
  if (isUuid || raw === session.id) return "会话";
  return raw;
}

export interface ExtensionStatusBarProps {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  session?: { name?: string; id?: string } | null;
  sidebarCollapsed?: boolean;
  collapsedTitle?: string | null;
  onExpandSidebar?: () => void;
  enabled?: boolean;
  renderSlot?: boolean;
}

export function ExtensionStatusBar({
  statuses,
  widgets = [],
  session,
  sidebarCollapsed = false,
  collapsedTitle = null,
  onExpandSidebar,
  enabled: controlledEnabled,
  renderSlot = false,
}: ExtensionStatusBarProps) {
  const [pluginEnabled, setPluginEnabled] = useState(() => {
    if (controlledEnabled !== undefined) return controlledEnabled;
    return isSettingsPluginEnabled("collapsed-sidebar-session-title");
  });

  useEffect(() => {
    if (controlledEnabled !== undefined) {
      setPluginEnabled(controlledEnabled);
      return;
    }
    const sync = () => {
      setPluginEnabled(isSettingsPluginEnabled("collapsed-sidebar-session-title"));
    };
    sync();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", sync);
      window.addEventListener("pi-collapsed-title-toggle", sync);
      const unsubscribePreferences = settingsExtensionRegistry.subscribePreferences(sync);
      return () => {
        window.removeEventListener("storage", sync);
        window.removeEventListener("pi-collapsed-title-toggle", sync);
        unsubscribePreferences();
      };
    }
  }, [controlledEnabled]);

  const isFeatureEnabled = controlledEnabled !== undefined ? controlledEnabled : pluginEnabled;

  // Composer protocol state belongs to the shared mode controls, not a JSON footer.
  // Keep it in the session hook for GET/SSE synchronization; other extensions render normally.
  const visibleStatuses = statuses.filter(status => status.key !== "composer-modes");

  const effectiveTitle = collapsedTitle ?? (session ? getSafeSessionTitle(session) : null);
  const showCollapsedTitle = Boolean(isFeatureEnabled && sidebarCollapsed && effectiveTitle);

  const hasShelfContent = visibleStatuses.length > 0 || widgets.length > 0 || showCollapsedTitle;

  if (!hasShelfContent) {
    if (renderSlot) {
      return <div className="chat-composer-status-slot" aria-hidden="true" />;
    }
    return null;
  }

  const statusLine = formatExtensionStatusLine(visibleStatuses);
  const plainStatusLine = stripAnsi(statusLine);
  const shelfClassName = `extension-status-shelf${widgets.length > 0 ? " has-widgets" : ""}${visibleStatuses.length > 0 ? " has-status" : ""}${showCollapsedTitle ? " has-collapsed-title" : ""}`;

  return (
    <div className={shelfClassName}>
      {widgets.length > 0 && <ExtensionWidgets widgets={widgets} />}
      {showCollapsedTitle ? (
        <div
          role="button"
          tabIndex={0}
          aria-label={`当前会话：${effectiveTitle}（点击展开会话列表）`}
          title={`当前会话：${effectiveTitle}（点击展开会话列表）`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onExpandSidebar?.();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onExpandSidebar?.();
            }
          }}
          className="pi-enh-collapsed-session-title-badge"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "2px 8px",
            fontSize: "11px",
            lineHeight: "1.4",
            color: "var(--text-muted, #a1a1aa)",
            background: "color-mix(in srgb, var(--accent, #3b82f6) 5%, var(--bg-panel, #18181b))",
            border: "1px solid color-mix(in srgb, var(--accent, #3b82f6) 22%, transparent)",
            borderRadius: "6px",
            maxWidth: "min(360px, 60vw)",
            cursor: "pointer",
            userSelect: "none",
            transition: "background 0.15s ease, border-color 0.15s ease, transform 0.1s ease",
            flexShrink: 0,
            boxSizing: "border-box",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "color-mix(in srgb, var(--accent, #3b82f6) 12%, var(--bg-panel, #18181b))";
            e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent, #3b82f6) 38%, transparent)";
            e.currentTarget.style.color = "var(--text, #ffffff)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "color-mix(in srgb, var(--accent, #3b82f6) 5%, var(--bg-panel, #18181b))";
            e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent, #3b82f6) 22%, transparent)";
            e.currentTarget.style.color = "var(--text-muted, #a1a1aa)";
          }}
        >
          <span
            className="pi-enh-collapsed-session-title-badge-icon"
            aria-hidden="true"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <span
            className="pi-enh-collapsed-session-title-badge-text"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            {effectiveTitle}
          </span>
        </div>
      ) : (
        visibleStatuses.length > 0 && (
          <div
            role="status"
            className="extension-status-line"
            aria-label={plainStatusLine}
            title={plainStatusLine}
          >
            <span className="extension-status-text">
              <AnsiText text={statusLine} />
            </span>
          </div>
        )
      )}
    </div>
  );
}
