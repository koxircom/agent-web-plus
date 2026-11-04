const EXPLORER_OPEN_STORAGE_KEY = "pi-web:file-explorer:open";
export const EXPLORER_VISIBLE_STORAGE_KEY = "pi-web:file-explorer:visible";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadExplorerOpen(storage: StorageLike | null = getBrowserStorage()): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(EXPLORER_OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveExplorerOpen(
  open: boolean,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(EXPLORER_OPEN_STORAGE_KEY, String(open));
  } catch {
    // Persistence is best-effort; privacy mode and storage quotas must not break the explorer.
  }
}

export function loadExplorerVisible(storage: StorageLike | null = getBrowserStorage()): boolean {
  try {
    return storage?.getItem(EXPLORER_VISIBLE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function saveExplorerVisible(visible: boolean, storage: StorageLike | null = getBrowserStorage()): void {
  try {
    storage?.setItem(EXPLORER_VISIBLE_STORAGE_KEY, String(visible));
  } catch {
    // Keep the current page usable when storage is unavailable.
  }
}
