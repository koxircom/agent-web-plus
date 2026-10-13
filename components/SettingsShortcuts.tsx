"use client";

import { useSyncExternalStore } from "react";
import { useI18n } from "@/hooks/useI18n";
import { settingsExtensionRegistry } from "@/lib/settings-extensions";
import { getLastSettingsSection, settingsSectionRequiresProject, type SettingsSection } from "@/lib/settings-navigation";
import { SettingsSectionIcon, preloadSettingsSection } from "./SettingsPanel";

const serverShortcuts = () => null;

/** React keeps button identity across late preferences, relabels and reorders. */
export function SettingsShortcuts({ cwd, onOpen }: { cwd: string | null; onOpen: (section: SettingsSection) => void }) {
  const { t } = useI18n();
  const shortcuts = useSyncExternalStore(
    settingsExtensionRegistry.subscribeSidebarShortcuts,
    settingsExtensionRegistry.getSidebarShortcuts,
    serverShortcuts,
  );
  const rows = shortcuts?.length ? shortcuts : [
    { id: "models" as const, label: t("common.models") },
    { id: "skills" as const, label: t("common.skills") },
    { id: "general" as const, label: t("common.settings") },
  ];
  return rows.map(({ id, label }) => {
    const disabled = settingsSectionRequiresProject(id) && !cwd;
    return <button key={id} type="button" className="pi-enh-shortcut-btn" data-shortcut-id={id}
      disabled={disabled} aria-label={label}
      title={disabled ? t("settings.projectRequired") : shortcuts ? `${label}（点击直达，双击可移除）` : label}
      onPointerEnter={() => preloadSettingsSection(id)} onFocus={() => preloadSettingsSection(id)}
      onClick={() => onOpen(shortcuts || id !== "general" ? id : getLastSettingsSection(cwd))}
      onDoubleClick={() => { if (shortcuts) settingsExtensionRegistry.invokeTabAction(id); }}>
      <SettingsSectionIcon section={id} size={14} strokeWidth={2} /><span>{label}</span>
    </button>;
  });
}

/** A preference can remove the opener; return to a surviving toolbar control. */
export function resolveSettingsShortcutFocus(host: HTMLElement | null, opener: Element): Element | null {
  const id = opener.getAttribute("data-shortcut-id");
  if (!id) return opener;
  const buttons = Array.from(host?.querySelectorAll<HTMLButtonElement>("button[data-shortcut-id]:not(:disabled)") ?? []);
  return buttons.find(button => button.dataset.shortcutId === id) ?? buttons[0] ?? null;
}
