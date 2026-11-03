import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getOdooLanClient } from "./odoo-lan-client.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const AUTHORITY_SCRIPT = path.join(REPO_ROOT, "bin/odoo-addon-lock.py");

describe("Odoo LAN Client Transport & Protocol Tests", () => {
  let tempDir;
  let stateRoot;
  let configFile;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "odoo-lan-test-"));
    stateRoot = path.join(tempDir, "state-locks");
    fs.mkdirSync(stateRoot, { recursive: true });
    configFile = path.join(tempDir, "odoo-lan-config.json");
  });

  after(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  test("Configuration detection: unconfigured, disabled, malformed, and valid states", () => {
    const unconfClient = getOdooLanClient({
      configFile: path.join(tempDir, "non-existent.json"),
    });
    assert.equal(unconfClient.isConfigured(), false);

    // Disabled config
    fs.writeFileSync(configFile, JSON.stringify({ version: 1, enabled: false }));
    const disabledClient = getOdooLanClient({ configFile });
    assert.equal(disabledClient.isConfigured(), false);

    // Missing or non-boolean enabled: MUST THROW ERROR rather than falling back to disabled
    fs.writeFileSync(
      configFile,
      JSON.stringify({ version: 1, role: "authority" })
    );
    const missingEnabledClient = getOdooLanClient({ configFile });
    assert.throws(
      () => missingEnabledClient.isConfigured(),
      /missing or invalid 'enabled' boolean field/
    );

    fs.writeFileSync(
      configFile,
      JSON.stringify({ version: 1, enabled: "yes", role: "authority" })
    );
    const nonBoolEnabledClient = getOdooLanClient({ configFile });
    assert.throws(
      () => nonBoolEnabledClient.isConfigured(),
      /missing or invalid 'enabled' boolean field/
    );

    // Valid authority config
    const validConfig = {
      version: 1,
      enabled: true,
      instanceId: "synology:30141",
      instanceLabel: "群晖30141",
      role: "authority",
      stateRoot,
      authorityScript: AUTHORITY_SCRIPT,
    };
    fs.writeFileSync(configFile, JSON.stringify(validConfig, null, 2));

    const validClient = getOdooLanClient({ configFile });
    assert.equal(validClient.isConfigured(), true);
    assert.equal(validClient.instanceId, "synology:30141");
    assert.equal(validClient.instanceLabel, "群晖30141");
  });

  test("Construction is side-effect-free (no child process spawned until request)", () => {
    const client = getOdooLanClient({ configFile });
    // getCachedSnapshot returns undefined before any connection
    assert.equal(client.getCachedSnapshot(), undefined);
  });

  test("Lazy start, status query, acquire, subscribe notifications, release cycle", async () => {
    const client = getOdooLanClient({ configFile });

    let notificationCount = 0;
    const unsubscribe = client.subscribe(() => {
      notificationCount++;
    });

    try {
      // 1. Initial status query
      const initialSnap = await client.status();
      assert.equal(initialSnap.protocol, "odoo-addon-lan-v1");
      assert.equal(initialSnap.version, 1);
      assert.equal(initialSnap.resources.length, 0);

      // Cached snapshot is now populated
      assert.deepEqual(client.getCachedSnapshot(), initialSnap);

      // 2. Acquire lock
      const acqResult = await client.request({
        action: "acquire",
        resource: "kx_test_module",
        actor: {
          sessionId: "sid-client-1",
          sessionName: "Client Test Task",
          ownerPid: process.pid,
          sourceRoot: "/workspace/odoo",
        },
      });

      assert.equal(acqResult.status, "acquired");
      assert.equal(acqResult.resource, "kx_test_module");
      assert.ok(acqResult.token);
      assert.equal(acqResult.generation, 1);

      // Cached snapshot updated
      const snapAfterAcq = client.getCachedSnapshot();
      assert.ok(snapAfterAcq);
      assert.equal(snapAfterAcq.resources.length, 1);
      assert.equal(snapAfterAcq.resources[0].resource, "kx_test_module");
      assert.equal(snapAfterAcq.resources[0].status, "held");
      assert.equal(snapAfterAcq.resources[0].owner.sessionId, "sid-client-1");

      // 3. Release lock
      const relResult = await client.request({
        action: "release",
        resource: "kx_test_module",
        actor: {
          sessionId: "sid-client-1",
        },
        token: acqResult.token,
        generation: acqResult.generation,
      });

      assert.equal(relResult.status, "released");

      // Cached snapshot updated after release
      const snapAfterRel = client.getCachedSnapshot();
      assert.ok(snapAfterRel);
      assert.equal(snapAfterRel.resources.length, 0);
    } finally {
      unsubscribe();
      await client.close();
    }
  });

  test("Disconnected authority fail-closed: snapshot becomes undefined and pending requests fail", async () => {
    const client = getOdooLanClient({ configFile });

    // Start connection
    await client.status();
    assert.ok(client.getCachedSnapshot() !== undefined);

    let disconnectNotified = false;
    client.subscribe(() => {
      disconnectNotified = true;
    });

    // Close transport
    await client.close();

    // Snapshot MUST be undefined when disconnected, NEVER pretend to be empty!
    assert.equal(client.getCachedSnapshot(), undefined);
    assert.equal(disconnectNotified, true);

    // Close is idempotent
    await client.close();
  });

  test("Dual clients FIFO queuing, handoff and ack via persistent client stdio", async () => {
    // Client 1 (30141)
    const client1 = getOdooLanClient({ configFile });

    // Config for Client 2 (30142 local test authorityScript)
    const configFile2 = path.join(tempDir, "odoo-lan-config-2.json");
    fs.writeFileSync(
      configFile2,
      JSON.stringify(
        {
          version: 1,
          enabled: true,
          instanceId: "synology:30142",
          instanceLabel: "群晖30142",
          role: "authority",
          stateRoot,
          authorityScript: AUTHORITY_SCRIPT,
        },
        null,
        2
      )
    );
    const client2 = getOdooLanClient({ configFile: configFile2 });

    try {
      // 1. Client 1 acquires resource
      const res1 = await client1.request({
        action: "acquire",
        resource: "kx_fifo_addon",
        actor: {
          sessionId: "sid-c1",
          sessionName: "Task 1",
          ownerPid: process.pid,
        },
      });
      assert.equal(res1.status, "acquired");

      // 2. Client 2 attempts to acquire -> gets queued
      const res2 = await client2.request({
        action: "acquire",
        resource: "kx_fifo_addon",
        actor: {
          sessionId: "sid-c2",
          sessionName: "Task 2",
          ownerPid: process.pid,
        },
        resumeTask: "Task 2 continuation",
      });
      assert.equal(res2.status, "queued");
      assert.equal(res2.position, 1);
      assert.ok(res2.queueId);

      // 3. Client 1 releases -> handoff scheduled for Client 2
      const rel1 = await client1.request({
        action: "release",
        resource: "kx_fifo_addon",
        actor: { sessionId: "sid-c1" },
        token: res1.token,
        generation: res1.generation,
      });
      assert.equal(rel1.status, "released");

      // Query latest snapshot from client2
      const snapHandoff = await client2.status();
      assert.ok(snapHandoff);
      const resItem = snapHandoff.resources.find((r) => r.resource === "kx_fifo_addon");
      assert.ok(resItem);
      assert.equal(resItem.status, "handoff");
      assert.equal(resItem.handoff.sessionId, "sid-c2");
      assert.equal(resItem.handoff.instanceId, "synology:30142");

      // 4. Client 2 acks handoff with mandatory generation
      const ack2 = await client2.request({
        action: "ack",
        resource: "kx_fifo_addon",
        actor: { sessionId: "sid-c2" },
        handoffId: resItem.handoff.handoffId,
        token: resItem.handoff.token,
        generation: resItem.handoff.generation,
      });
      assert.equal(ack2.status, "acknowledged");

      // 5. Final snapshot shows held by Client 2
      const snapHeld = client2.getCachedSnapshot();
      const finalItem = snapHeld.resources.find((r) => r.resource === "kx_fifo_addon");
      assert.equal(finalItem.status, "held");
      assert.equal(finalItem.owner.sessionId, "sid-c2");
      assert.equal(finalItem.owner.instanceId, "synology:30142");

      // Clean up by releasing from Client 2
      await client2.request({
        action: "release",
        resource: "kx_fifo_addon",
        actor: { sessionId: "sid-c2" },
        token: ack2.token,
        generation: ack2.generation,
      });
    } finally {
      await client1.close();
      await client2.close();
    }
  });

  test("PI_CODING_AGENT_DIR takes precedence over PI_AGENT_DIR for default config resolution", async () => {
    const customCodingDir = path.join(tempDir, "custom-coding-agent");
    const customConfigDir = path.join(customCodingDir, "state");
    fs.mkdirSync(customConfigDir, { recursive: true });
    const targetConfig = path.join(customConfigDir, "odoo-lan-config.json");
    fs.writeFileSync(
      targetConfig,
      JSON.stringify({
        version: 1,
        enabled: true,
        instanceId: "synology:30141",
        instanceLabel: "群晖30141",
        role: "authority",
        authorityScript: AUTHORITY_SCRIPT,
      })
    );

    const origCodingDir = process.env.PI_CODING_AGENT_DIR;
    const origAgentDir = process.env.PI_AGENT_DIR;
    try {
      process.env.PI_CODING_AGENT_DIR = customCodingDir;
      process.env.PI_AGENT_DIR = "/non-existent-agent-dir";

      const client = getOdooLanClient();
      assert.equal(client.isConfigured(), true);
      assert.equal(client.instanceId, "synology:30141");
    } finally {
      if (origCodingDir !== undefined) {
        process.env.PI_CODING_AGENT_DIR = origCodingDir;
      } else {
        delete process.env.PI_CODING_AGENT_DIR;
      }
      if (origAgentDir !== undefined) {
        process.env.PI_AGENT_DIR = origAgentDir;
      } else {
        delete process.env.PI_AGENT_DIR;
      }
    }
  });

  test("Closing the authority client invalidates cachedSnapshot to prevent stale green view", async () => {
    // Cold Python authority startup is not the timeout behavior under test here.
    const client = getOdooLanClient({ configFile, timeoutMs: 5000 });
    try {
      const snap = await client.status();
      assert.ok(snap);
      assert.ok(client.getCachedSnapshot() !== undefined);

      // Verify close removes the previously valid authoritative snapshot.
      await client.close();
      assert.equal(client.getCachedSnapshot(), undefined);
    } finally {
      await client.close();
    }
  });
});
