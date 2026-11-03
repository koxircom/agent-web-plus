import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { readSessionAddonUpdates, getSessionAddonUpdatesManifestPath } from "./session-addon-updates.ts";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.resolve(import.meta.dirname, "..") },
  interopDefault: true,
});
const { GET: routeGet } = await jiti.import("../app/api/session-addon-updates/route.ts");

test("returns unconfigured structure with available: false on ENOENT", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-addon-updates-test-"));
  try {
    const result = await readSessionAddonUpdates(tmpDir);
    assert.deepEqual(result, {
      version: 1,
      revision: 0,
      sessions: {},
      latestByAddon: {},
      available: false,
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("reads valid manifest, sets available: true and does not leak file paths", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-addon-updates-test-"));
  try {
    const scriptsDir = path.join(tmpDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const manifestFile = path.join(scriptsDir, "pi-odoo-addons-manifest.json");

    const validPayload = {
      version: 1,
      revision: 123456789,
      updatedAt: "2026-11-01T12:00:00.000Z",
      sessions: {
        "session-1": [
          { technical: "kx_srm", status: "18.0.1.0（已更新）" },
        ],
        "session-2": [],
      },
      latestByAddon: {
        "kx_srm": {
          sessionId: "session-1",
          updatedAt: "2026-11-01T12:00:00.000Z",
        },
      },
      filePath: "/secret/path/to/leak",
    };

    await fs.writeFile(manifestFile, JSON.stringify(validPayload), "utf-8");

    const result = await readSessionAddonUpdates(tmpDir);
    assert.equal(result.version, 1);
    assert.equal(result.revision, 123456789);
    assert.equal(result.updatedAt, "2026-11-01T12:00:00.000Z");
    assert.equal(result.available, true);
    assert.deepEqual(result.sessions, validPayload.sessions);
    assert.deepEqual(result.latestByAddon, validPayload.latestByAddon);
    assert.equal("filePath" in result, false);
    assert.equal(JSON.stringify(result).includes(tmpDir), false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("throws status 500 on invalid JSON without clearing or returning fallback data", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-addon-updates-test-"));
  try {
    const scriptsDir = path.join(tmpDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const manifestFile = path.join(scriptsDir, "pi-odoo-addons-manifest.json");

    await fs.writeFile(manifestFile, "{ invalid json ...", "utf-8");

    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("throws status 500 when sessions is not a plain object or malformed", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-addon-updates-test-"));
  try {
    const scriptsDir = path.join(tmpDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const manifestFile = path.join(scriptsDir, "pi-odoo-addons-manifest.json");

    // Case 1: sessions is an array
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: [] }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );

    // Case 2: sessions entry is not an array (null or string)
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: { "s-1": "invalid" } }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );

    // Case 3: sessions entry is null
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: { "s-1": null } }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );

    // Case 4: item missing technical or invalid
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: { "s-1": [{ technical: "" }] } }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );

    await fs.writeFile(manifestFile, JSON.stringify({ sessions: { "s-1": [{ technical: "ok", name: 123 }] } }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("throws status 500 on malformed latestByAddon instead of silently falling back to empty object", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-addon-updates-test-"));
  try {
    const scriptsDir = path.join(tmpDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const manifestFile = path.join(scriptsDir, "pi-odoo-addons-manifest.json");

    // Case 1: latestByAddon is a string
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: {}, latestByAddon: "invalid" }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );

    // Case 2: latestByAddon entry is not a plain object
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: {}, latestByAddon: { "kx_srm": "not-an-object" } }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );

    // Case 3: entry missing updatedAt
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: {}, latestByAddon: { "kx_srm": { sessionId: "s-1" } } }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );

    // Case 4: entry sessionId is not a string
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: {}, latestByAddon: { "kx_srm": { sessionId: 123, updatedAt: "2026-01-01" } } }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("throws status 500 when revision is negative or non-finite", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-addon-updates-test-"));
  try {
    const scriptsDir = path.join(tmpDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const manifestFile = path.join(scriptsDir, "pi-odoo-addons-manifest.json");

    // Negative revision
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: {}, revision: -1 }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );

    // Non-number revision
    await fs.writeFile(manifestFile, JSON.stringify({ sessions: {}, revision: "123" }), "utf-8");
    await assert.rejects(
      async () => {
        await readSessionAddonUpdates(tmpDir);
      },
      (err) => {
        assert.equal(err.status, 500);
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("strips unknown metadata from items without mutating technical/name/status string formats", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-addon-updates-test-"));
  try {
    const scriptsDir = path.join(tmpDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const manifestFile = path.join(scriptsDir, "pi-odoo-addons-manifest.json");

    const payload = {
      sessions: {
        "session-test": [
          {
            technical: "kx_test_mod",
            name: "  Preserve Untrimmed Name  ",
            status: "18.0.1.0 (Testing) ",
            updatedAt: "2026-11-01T12:00:00Z",
            extraFieldToStrip: "internal_secret",
            arbitraryMeta: { nested: true },
          },
        ],
      },
      latestByAddon: {
        "kx_test_mod": {
          sessionId: "session-test",
          updatedAt: "2026-11-01T12:00:00Z",
        },
      },
    };

    await fs.writeFile(manifestFile, JSON.stringify(payload), "utf-8");

    const result = await readSessionAddonUpdates(tmpDir);
    const item = result.sessions["session-test"][0];

    assert.equal(item.technical, "kx_test_mod");
    assert.equal(item.name, "  Preserve Untrimmed Name  ");
    assert.equal(item.status, "18.0.1.0 (Testing) ");
    assert.equal(item.updatedAt, "2026-11-01T12:00:00Z");
    assert.equal("extraFieldToStrip" in item, false);
    assert.equal("arbitraryMeta" in item, false);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("API route returns fixed 500 error and never leaks filesystem paths or sensitive keys", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-addon-updates-fixture-leak-test-"));
  const origEnv = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = tmpDir;
    const scriptsDir = path.join(tmpDir, "scripts");
    await fs.mkdir(scriptsDir, { recursive: true });
    const manifestFile = path.join(scriptsDir, "pi-odoo-addons-manifest.json");

    // Write malformed JSON that triggers error
    await fs.writeFile(manifestFile, "{ invalid malformed JSON with sensitive /volume1/secret/key ...", "utf-8");

    const response = await routeGet();
    assert.equal(response.status, 500);

    const body = await response.json();
    assert.deepEqual(body, {
      error: "获取插件更新状态失败 / Failed to read session addon updates",
    });

    const bodyStr = JSON.stringify(body);
    assert.equal(bodyStr.includes(tmpDir), false);
    assert.equal(bodyStr.includes("/volume1"), false);
    assert.equal(bodyStr.includes("sensitive"), false);
    assert.equal(bodyStr.includes("manifest"), false);
    assert.equal(bodyStr.includes("JSON"), false);
  } finally {
    if (origEnv !== undefined) {
      process.env.PI_CODING_AGENT_DIR = origEnv;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

