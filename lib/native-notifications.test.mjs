import assert from "node:assert/strict";
import test from "node:test";
import {
  NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY,
  NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY,
  createNativeNotificationPolicy,
  initializeNativeNotificationPolicy,
} from "./native-notifications.ts";

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    read(key) {
      return values.get(key) ?? null;
    },
  };
}

function preference(channels) {
  return JSON.stringify({ schemaVersion: 1, channels });
}

function createEventTarget(storage) {
  const listeners = new Map();
  const dispatchedEvents = [];
  return {
    localStorage: storage,
    dispatchedEvents,
    addEventListener(type, listener) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    dispatchEvent(event) {
      dispatchedEvents.push(event);
      for (const listener of listeners.get(event.type) ?? []) listener(event);
      return true;
    },
    emit(type, event) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.length ?? 0;
    },
  };
}

test("a persisted preference is applied before enhancement scripts load and muted notices enter history", () => {
  const storage = createStorage({
    [NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY]: preference({
      "native-warning": false,
    }),
  });
  const policy = initializeNativeNotificationPolicy({ localStorage: storage });

  assert.ok(policy);
  assert.equal(
    policy.admitNativeNotification({
      id: "warning-1",
      message: "Server connection failed",
      type: "warning",
    }),
    false,
  );
  assert.deepEqual(
    policy.history().map(({ sourceId, settingId, suppressed }) => ({
      sourceId,
      settingId,
      suppressed,
    })),
    [{ sourceId: "warning-1", settingId: "native-warning", suppressed: true }],
  );
});

test("the same native notification id is recorded only once", () => {
  const policy = createNativeNotificationPolicy({
    targetWindow: { localStorage: createStorage() },
    isNotificationCenterEnabled: () => true,
    now: () => 1234,
    createId: () => "history-id",
  });
  const notice = { id: "event-1", message: "Request failed", type: "error" };

  assert.equal(policy.admitNativeNotification(notice), true);
  assert.equal(policy.admitNativeNotification(notice), true);
  assert.equal(policy.history().length, 1);
  assert.equal(policy.history()[0].sourceId, "event-1");
});

test("severity defaults keep warning and error visible while ordinary info is muted", () => {
  const policy = createNativeNotificationPolicy({
    targetWindow: { localStorage: createStorage() },
    isNotificationCenterEnabled: () => true,
  });

  assert.equal(
    policy.isNativeNotificationEnabled("A warning", "warning"),
    true,
  );
  assert.equal(policy.isNativeNotificationEnabled("An error", "error"), true);
  assert.equal(
    policy.isNativeNotificationEnabled("An update", "success"),
    true,
  );
  assert.equal(policy.isNativeNotificationEnabled("An update", "info"), false);
});

test("disabling the notification center leaves native notices visible and skips history", () => {
  const storage = createStorage();
  const policy = createNativeNotificationPolicy({
    targetWindow: { localStorage: storage },
    isNotificationCenterEnabled: () => false,
  });

  assert.equal(
    policy.isNativeNotificationEnabled("An info message", "info"),
    true,
  );
  assert.equal(
    policy.admitNativeNotification({
      id: "event-2",
      message: "An info message",
      type: "info",
    }),
    true,
  );
  assert.deepEqual(policy.history(), []);
  assert.equal(storage.read(NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY), null);
});

test("storage failures fail open without throwing during admission", () => {
  const targetWindow = {};
  Object.defineProperty(targetWindow, "localStorage", {
    get() {
      throw new Error("storage unavailable");
    },
  });
  const policy = createNativeNotificationPolicy({
    targetWindow,
    isNotificationCenterEnabled: () => true,
  });

  assert.equal(policy.isNativeNotificationEnabled("Warning", "warning"), true);
  assert.equal(
    policy.admitNativeNotification({
      id: "event-3",
      message: "Warning",
      type: "warning",
    }),
    true,
  );
  assert.deepEqual(
    policy.history().map(({ sourceId, message, suppressed }) => ({
      sourceId,
      message,
      suppressed,
    })),
    [{ sourceId: "event-3", message: "Warning", suppressed: false }],
  );
});

test("notification history is capped at 100 entries", () => {
  const policy = createNativeNotificationPolicy({
    targetWindow: { localStorage: createStorage() },
    isNotificationCenterEnabled: () => true,
    createId: (() => {
      let id = 0;
      return () => `history-${++id}`;
    })(),
  });
  for (let index = 0; index < 105; index += 1) {
    policy.record(`message-${index}`, "error");
  }

  assert.equal(policy.history().length, 100);
  assert.equal(policy.history()[0].message, "message-104");
  assert.equal(policy.history()[99].message, "message-5");
});

test("setting changes and reset dispatch the policy change event", () => {
  const targetWindow = createEventTarget(createStorage());
  const policy = createNativeNotificationPolicy({
    targetWindow,
    isNotificationCenterEnabled: () => true,
  });

  assert.equal(policy.setEnabled("native-info", true), true);
  policy.reset();

  assert.deepEqual(
    targetWindow.dispatchedEvents.map(({ type }) => type),
    [
      "pi-native-notification-policy-change",
      "pi-native-notification-policy-change",
    ],
  );
});

test("a storage event invalidates cached preferences and dispatches a policy change", () => {
  const storage = createStorage();
  const targetWindow = createEventTarget(storage);
  const policy = createNativeNotificationPolicy({
    targetWindow,
    isNotificationCenterEnabled: () => true,
  });

  assert.equal(policy.isNativeNotificationEnabled("An update", "info"), false);
  assert.equal(targetWindow.listenerCount("storage"), 1);
  storage.setItem(
    NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY,
    preference({ "native-info": true }),
  );
  targetWindow.emit("storage", {
    key: NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY,
  });

  assert.equal(policy.isNativeNotificationEnabled("An update", "info"), true);
  assert.deepEqual(
    targetWindow.dispatchedEvents.map(({ type }) => type),
    ["pi-native-notification-policy-change"],
  );
});

test("cross-tab history is refreshed before appending, and storage clear resets both caches", () => {
  const storage = createStorage();
  const targetWindow = createEventTarget(storage);
  const policy = createNativeNotificationPolicy({ targetWindow, isNotificationCenterEnabled: () => true });
  policy.record("first", "warning");
  const otherTab = { ...policy.history()[0], id: "other-tab", message: "second" };
  storage.setItem(NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY, JSON.stringify([otherTab, ...policy.history()]));
  targetWindow.emit("storage", { key: NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY });
  policy.record("third", "warning");
  assert.deepEqual(policy.history().map(row => row.message), ["third", "second", "first"]);
  policy.setEnabled("native-info", true);
  storage.setItem(NATIVE_NOTIFICATION_SETTINGS_STORAGE_KEY, preference({}));
  storage.setItem(NATIVE_NOTIFICATION_HISTORY_STORAGE_KEY, "[]");
  targetWindow.emit("storage", { key: null });
  assert.equal(policy.isNativeNotificationEnabled("info", "info"), false);
  assert.deepEqual(policy.history(), []);
  assert.equal(targetWindow.listenerCount("storage"), 1);
});
