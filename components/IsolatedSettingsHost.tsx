"use client";

import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import { settingsExtensionRegistry, type SettingsExtensionContext } from "@/lib/settings-extensions";

interface Props {
  id: string;
  sectionId: string;
  className: string;
  onClose: () => void;
  activateSection: (id: string) => boolean;
  availableSections: readonly string[];
  cwd: string | null;
  sessionId: string | null;
  hideWhenEmpty?: boolean;
  showLoading?: boolean;
  fill?: boolean;
  active?: boolean;
}

const noServerRenderer = () => undefined;

/** React owns the empty host; the registered renderer exclusively owns its children. */
export function IsolatedSettingsHost(props: Props) {
  const { id, sectionId, className, hideWhenEmpty, showLoading, fill, active = true } = props;
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement>(null);
  const [mountFailed, setMountFailed] = useState(false);
  const [mountAttempt, setMountAttempt] = useState(0);
  const currentProps = useRef(props);
  currentProps.current = props;

  const subscribe = useCallback(
    (listener: () => void) => settingsExtensionRegistry.subscribeRenderer(id, listener),
    [id],
  );
  const getRenderer = useCallback(() => settingsExtensionRegistry.getRenderer(id), [id]);
  const renderer = useSyncExternalStore(subscribe, getRenderer, noServerRenderer);

  // Mount the renderer before paint rather than briefly showing an empty host.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !renderer || !active) return;

    const context: SettingsExtensionContext = {
      onClose: () => currentProps.current.onClose(),
      activateSection: (nextId) => currentProps.current.activateSection(nextId),
      nav: {
        currentSection: sectionId,
        get availableSections() { return currentProps.current.availableSections; },
        get cwd() { return currentProps.current.cwd; },
        get sessionId() { return currentProps.current.sessionId; },
      },
    };

    let cleanup: (() => void) | void;
    try {
      cleanup = renderer(host, context);
      setMountFailed(false);
    } catch (error) {
      host.replaceChildren();
      console.error(`Error mounting settings host ${id}:`, error);
      setMountFailed(true);
    }

    return () => {
      try {
        if (typeof cleanup === "function") cleanup();
      } catch (error) {
        console.error(`Error cleaning up settings host ${id}:`, error);
      } finally {
        host.replaceChildren();
      }
    };
  }, [id, renderer, sectionId, mountAttempt, active]);

  return (
    <>
      {showLoading && (!renderer || mountFailed) && (
        <div className="settings-extension-loading" role={mountFailed ? "alert" : "status"}>
          {mountFailed ? <div>此设置页加载失败。 <button type="button" onClick={() => {
            setMountFailed(false);
            setMountAttempt((attempt) => attempt + 1);
          }}>重试加载</button></div> : t("i18n.loading")}
        </div>
      )}
      <div
        ref={hostRef}
        className={className}
        data-host-id={id}
        hidden={Boolean(hideWhenEmpty && !renderer)}
        style={fill ? { width: "100%", height: "100%", minHeight: 0 } : undefined}
      />
    </>
  );
}
