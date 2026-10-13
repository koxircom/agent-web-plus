import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  settingsExtensionRegistry,
  isExtensionEnabled,
  LEGACY_SETTINGS_EXTENSIONS,
} = await jiti.import("./settings-extensions.ts");

test("registers and unregisters renderers via ABI", () => {
  let mounted = false;
  const unregister = settingsExtensionRegistry.registerRenderer("enhancements", () => {
    mounted = true;
  });

  const renderer = settingsExtensionRegistry.getRenderer("enhancements");
  assert.equal(typeof renderer, "function");
  renderer();
  assert.equal(mounted, true);

  unregister();
  assert.equal(settingsExtensionRegistry.getRenderer("enhancements"), undefined);
});

test("native double-click dispatch preserves one action owner and unregisters safely", () => {
  let calls = 0;
  assert.equal(settingsExtensionRegistry.invokeTabAction("models"), false);
  const releaseOld = settingsExtensionRegistry.registerTabAction("models", () => { calls += 100; });
  const releaseCurrent = settingsExtensionRegistry.registerTabAction("models", () => { calls++; });
  releaseOld();
  assert.equal(settingsExtensionRegistry.invokeTabAction("models"), true);
  assert.equal(calls, 1);
  releaseCurrent();
  assert.equal(settingsExtensionRegistry.invokeTabAction("models"), false);
});

test("activateSection returns false when modal is not open", () => {
  assert.equal(settingsExtensionRegistry.activateSection("enhancements"), false);
  assert.equal(settingsExtensionRegistry.isModalOpen(), false);
  assert.equal(settingsExtensionRegistry.getActiveSection(), null);
});

test("isExtensionEnabled checks canonical metadata", () => {
  const enhancementsDef = LEGACY_SETTINGS_EXTENSIONS.find((e) => e.id === "enhancements");
  assert.equal(isExtensionEnabled(enhancementsDef), true);

  const notificationsDef = LEGACY_SETTINGS_EXTENSIONS.find((e) => e.id === "notifications");
  // With mock storage disabled
  const disabledStorage = (key) => {
    if (key === "pi-enh-settings-v1") {
      return JSON.stringify({
        features: { "notification-center": { enabled: false } },
      });
    }
    return null;
  };
  assert.equal(isExtensionEnabled(notificationsDef, disabledStorage), false);

  const enabledStorage = (key) => {
    if (key === "pi-enh-settings-v1") {
      return JSON.stringify({
        features: { "notification-center": { enabled: true } },
      });
    }
    return null;
  };
  assert.equal(isExtensionEnabled(notificationsDef, enabledStorage), true);
});

test("notifies renderer subscribers on register, replacement, and unregister", () => {
  let calls = 0;
  const unsubscribe = settingsExtensionRegistry.subscribeRenderer("enhancements", () => {
    calls++;
  });

  // 1. Register
  const unregister1 = settingsExtensionRegistry.registerRenderer("enhancements", () => {});
  assert.equal(calls, 1);

  // 2. Replacement
  const unregister2 = settingsExtensionRegistry.registerRenderer("enhancements", () => {});
  assert.equal(calls, 2);

  // 3. Unregister old one (no-op since replaced)
  unregister1();
  assert.equal(calls, 2);

  // 4. Unregister active
  unregister2();
  assert.equal(calls, 3);
  assert.equal(settingsExtensionRegistry.getRenderer("enhancements"), undefined);

  unsubscribe();
  settingsExtensionRegistry.registerRenderer("enhancements", () => {});
  assert.equal(calls, 3); // Unsubscribed
});


test("shortcut snapshots normalize ids and preserve identity across equal syncs", () => {
  const r = settingsExtensionRegistry;
  r.setSidebarShortcuts(null);
  let notifications = 0;
  const release = r.subscribeSidebarShortcuts(() => notifications++);
  r.setSidebarShortcuts([{ id: "settings", label: "常规" }, { id: "general", label: "duplicate" }, { id: "bad", label: "ignored" }]);
  const first = r.getSidebarShortcuts();
  assert.deepEqual(first, [{ id: "general", label: "常规" }]);
  r.setSidebarShortcuts([{ id: "general", label: "常规" }]);
  assert.equal(r.getSidebarShortcuts(), first);
  assert.equal(notifications, 1);
  r.setSidebarShortcuts([{ id: "models", label: "模型" }]);
  assert.equal(notifications, 2);
  r.setSidebarShortcuts(null);
  assert.equal(r.getSidebarShortcuts(), null);
  assert.equal(notifications, 3);
  release();
});
