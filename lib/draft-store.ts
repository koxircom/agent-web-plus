import {
  isBase64ImageWithinLimits,
} from "./image-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
}

const drafts = new Map<string, ChatDraft>();
const DRAFT_STORAGE_PREFIX = "pi-enh-composer-draft-v3:";
const DRAFT_NEW_SCOPED_PREFIX = `${DRAFT_STORAGE_PREFIX}new-scoped:`;
const MAX_PERSISTED_DRAFTS = 10;
const MAX_PERSISTED_IMAGES = 10;
const NEW_DRAFT_MAX_AGE_MS = 7 * 86400 * 1000;
const knownPersistedDraftKeys = new Set<string>();
const hydratedScopedDraftOwners = new Map<string, string>();
let draftMaintenanceCounter = 0;
const pendingPersistence = new Map<string, ReturnType<typeof setTimeout>>();

interface PersistedChatDraft extends ChatDraft {
  version: 3;
  ownerKey: string;
  updatedAt: number;
}

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0;
}

function isNewSessionDraftOwnerKey(key: string): boolean {
  return key.startsWith("new:") || key.startsWith("parked-new:");
}

function getDraftCwdFromOwnerKey(key: string): string {
  if (key.startsWith("new:")) {
    // AppShell's refresh ID includes the cwd; the owner also appends it.
    // Decode that existing format without treating the ID's colon as a cwd.
    if (key.startsWith("new:initial:")) {
      const tail = key.slice("new:initial:".length);
      const middle = (tail.length - 1) / 2;
      if (Number.isInteger(middle) && tail[middle] === ":"
        && tail.slice(0, middle) === tail.slice(middle + 1)) {
        return tail.slice(0, middle);
      }
    }
    const parts = key.split(":");
    if (parts.length >= 3) return parts.slice(2).join(":");
    if (parts.length === 2) return parts[1];
  } else if (key.startsWith("parked-new:")) {
    return key.slice("parked-new:".length);
  }

  try {
    if (typeof window !== "undefined") {
      const cwd = new URLSearchParams(window.location.search).get("cwd");
      if (cwd) return cwd;
      const project = document.querySelector("[data-project-dir], .sidebar-project-name")
        ?.getAttribute("data-project-dir");
      if (project) return project;
    }
  } catch {
    // Storage remains keyed to the default workspace when browser context is unavailable.
  }
  return "default";
}

function draftStorageKey(key: string): string {
  return DRAFT_STORAGE_PREFIX + encodeURIComponent(key);
}

function scopedDraftStorageKey(cwd: string): string {
  return DRAFT_NEW_SCOPED_PREFIX + encodeURIComponent(cwd || "default");
}

function validPersistedDraft(value: unknown): value is PersistedChatDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedChatDraft>;
  return candidate.version === 3
    && typeof candidate.ownerKey === "string"
    && typeof candidate.value === "string"
    && Array.isArray(candidate.images)
    && candidate.images.length <= MAX_PERSISTED_IMAGES
    && candidate.images.every((image) => (
      image && typeof image.data === "string" && image.data.length > 0
      && typeof image.mimeType === "string" && image.mimeType.startsWith("image/")
    ));
}

function getLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function isDraftPersistenceEnabled(): boolean {
  try {
    if (typeof window !== "undefined") {
      const hook = (window as unknown as { __PI_ENH_IS_PLUGIN_ENABLED__?: (id: string) => boolean }).__PI_ENH_IS_PLUGIN_ENABLED__;
      if (hook) return hook("composer-draft-cache");
    }
    const storage = getLocalStorage();
    const settings = JSON.parse(storage?.getItem("pi-enh-settings-v1") || "null");
    if (settings?.features?.["composer-draft-cache"]?.enabled === false) return false;
    return storage?.getItem("pi-enh-plugin-composer-draft-cache") !== "false";
  } catch { return false; }
}

function cancelDraftPersistence(key: string): void {
  const timer = pendingPersistence.get(key);
  if (timer !== undefined) clearTimeout(timer);
  pendingPersistence.delete(key);
}

/** Memory commits immediately. Merge durable writes so typing with attachments
 * does not encode large base64 payloads on every keystroke. Clear cancels the
 * pending owner synchronously; an old timer can never restore a sent draft. */
function queueDraftPersistence(key: string): boolean {
  cancelDraftPersistence(key);
  if (!isDraftPersistenceEnabled() || !getLocalStorage()) return false;
  const timer = setTimeout(() => {
    pendingPersistence.delete(key);
    const draft = drafts.get(key);
    if (draft) savePersistedDraft(key, draft);
  }, 150);
  // Node discovery tests should not be kept alive by a browser-only draft timer.
  (timer as unknown as { unref?: () => void }).unref?.();
  pendingPersistence.set(key, timer);
  return true;
}

export function flushDraftPersistence(): void {
  for (const key of [...pendingPersistence.keys()]) {
    cancelDraftPersistence(key);
    const draft = drafts.get(key);
    if (draft) savePersistedDraft(key, draft);
  }
}

/** A server recall backup can be released only after its draft is durable. */
export function persistDraftNow(key: string): boolean {
  cancelDraftPersistence(key);
  const draft = drafts.get(key);
  return Boolean(draft && savePersistedDraft(key, draft));
}

function readPersistedDraft(key: string): ChatDraft | null {
  hydratedScopedDraftOwners.delete(key);
  const storage = getLocalStorage();
  if (!storage || !key || !isDraftPersistenceEnabled()) return null;

  try {
    const raw = storage.getItem(draftStorageKey(key));
    let exact: PersistedChatDraft | null = null;
    if (raw) {
      const persisted: unknown = JSON.parse(raw);
      if (validPersistedDraft(persisted) && persisted.ownerKey === key) {
        exact = persisted;
      }
    }

    if (!isNewSessionDraftOwnerKey(key)) return exact ? cloneDraft(exact) : null;
    const scopedRaw = storage.getItem(scopedDraftStorageKey(getDraftCwdFromOwnerKey(key)));
    if (!scopedRaw) return exact ? cloneDraft(exact) : null;
    const scoped: unknown = JSON.parse(scopedRaw);
    if (!validPersistedDraft(scoped)
      || !isNewSessionDraftOwnerKey(scoped.ownerKey)
      || getDraftCwdFromOwnerKey(scoped.ownerKey) !== getDraftCwdFromOwnerKey(key)) {
      return exact ? cloneDraft(exact) : null;
    }
    const isNonEmpty = Boolean(scoped.value || scoped.images.length);
    const isRecent = !scoped.updatedAt || Date.now() - scoped.updatedAt < NEW_DRAFT_MAX_AGE_MS;
    // A temporary new-session owner may be newer than the refresh owner's
    // previous value. Never resurrect that older exact draft ahead of it.
    const current = isNonEmpty && isRecent && (!exact || scoped.updatedAt > exact.updatedAt)
      ? scoped : exact;
    if (current === scoped) hydratedScopedDraftOwners.set(key, scoped.ownerKey);
    return current ? cloneDraft(current) : null;
  } catch {
    return null;
  }
}

function removePersistedDraft(key: string): boolean {
  const storage = getLocalStorage();
  if (!storage || !key) return false;
  try {
    storage.removeItem(draftStorageKey(key));
    knownPersistedDraftKeys.delete(draftStorageKey(key));
    if (isNewSessionDraftOwnerKey(key)) {
      const scopedKey = scopedDraftStorageKey(getDraftCwdFromOwnerKey(key));
      const scopedRaw = storage.getItem(scopedKey);
      if (scopedRaw) {
        try {
          const scoped: unknown = JSON.parse(scopedRaw);
          if (validPersistedDraft(scoped) && scoped.ownerKey === key) {
            storage.removeItem(scopedKey);
          }
        } catch {
          // Leave malformed shared workspace data untouched.
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function savePersistedDraft(key: string, draft: ChatDraft): boolean {
  if (!key || typeof draft.value !== "string" || !isDraftPersistenceEnabled()) return false;
  if (isEmptyDraft(draft)) return removePersistedDraft(key);

  // Keep the full in-memory composer state when more than ten images are
  // temporarily present, but do not leave an older durable snapshot behind.
  if (draft.images.length > MAX_PERSISTED_IMAGES || !draft.images.every((image) => (
    image && typeof image.data === "string" && image.data.length > 0
    && typeof image.mimeType === "string" && image.mimeType.startsWith("image/")
  ))) {
    removePersistedDraft(key);
    return false;
  }

  const storage = getLocalStorage();
  if (!storage) return false;
  try {
    const persisted: PersistedChatDraft = {
      version: 3,
      ownerKey: key,
      value: draft.value,
      images: draft.images.map(({ data, mimeType }) => ({ data, mimeType })),
      updatedAt: Date.now(),
    };
    const storageKey = draftStorageKey(key);
    const serialized = JSON.stringify(persisted);
    storage.setItem(storageKey, serialized);
    if (isNewSessionDraftOwnerKey(key)) {
      storage.setItem(scopedDraftStorageKey(getDraftCwdFromOwnerKey(key)), serialized);
    }

    const isNewKey = !knownPersistedDraftKeys.has(storageKey);
    knownPersistedDraftKeys.add(storageKey);
    if (!isNewKey && ++draftMaintenanceCounter < 50) return true;
    draftMaintenanceCounter = 0;

    const persistedKeys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const candidate = storage.key(index);
      if (candidate?.startsWith(DRAFT_STORAGE_PREFIX) && !candidate.startsWith(DRAFT_NEW_SCOPED_PREFIX)) {
        persistedKeys.push(candidate);
      }
    }
    if (persistedKeys.length > MAX_PERSISTED_DRAFTS) {
      persistedKeys.sort((left, right) => {
        try {
          const leftDraft = JSON.parse(storage.getItem(left) || "null") as Partial<PersistedChatDraft>;
          const rightDraft = JSON.parse(storage.getItem(right) || "null") as Partial<PersistedChatDraft>;
          return (leftDraft.updatedAt || 0) - (rightDraft.updatedAt || 0);
        } catch {
          return 0;
        }
      });
      for (const oldKey of persistedKeys.slice(0, persistedKeys.length - MAX_PERSISTED_DRAFTS)) {
        if (oldKey !== storageKey) {
          storage.removeItem(oldKey);
          knownPersistedDraftKeys.delete(oldKey);
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  if (draft) return cloneDraft(draft);
  const persisted = readPersistedDraft(key);
  if (!persisted) return null;
  const stored = cloneDraft(persisted);
  drafts.set(key, stored);
  // Promote a workspace-scoped provisional draft to this page's current key so
  // subsequent native clear/rekey operations remove the exact durable owner.
  savePersistedDraft(key, stored);
  return cloneDraft(stored);
}

export function getDraftInMemory(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): boolean {
  hydratedScopedDraftOwners.delete(key);
  if (isEmptyDraft(draft)) {
    cancelDraftPersistence(key);
    drafts.delete(key);
    return removePersistedDraft(key);
  }
  const stored = cloneDraft(draft);
  drafts.set(key, stored);
  return queueDraftPersistence(key);
}

export function clearDraft(key: string): boolean {
  hydratedScopedDraftOwners.delete(key);
  cancelDraftPersistence(key);
  drafts.delete(key);
  return removePersistedDraft(key);
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  const nextIsPreviousScopedAlias = hydratedScopedDraftOwners.get(nextKey) === previousKey;
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next && !nextIsPreviousScopedAlias
    ? mergeRestoredSubmissionDraft(next.value, next.images, previous.value, previous.images)
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDraftPersistence);
  window.addEventListener("beforeunload", flushDraftPersistence);
  (window as Window & {
    __PI_NATIVE_DRAFT_STORE__?: {
      version: 1;
      get: typeof getDraft;
      set: typeof setDraft;
      clear: typeof clearDraft;
      flush: typeof flushDraftPersistence;
    };
  }).__PI_NATIVE_DRAFT_STORE__ = {
    version: 1,
    get: getDraft,
    set: setDraft,
    clear: clearDraft,
    flush: flushDraftPersistence,
  };
}
