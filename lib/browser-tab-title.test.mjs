import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  BROWSER_TAB_TITLE_MAX_CODEPOINTS,
  normalizeBrowserTabTitle,
  sanitizeRawBrowserTabTitle,
  resolveAgentDir,
  getAgentWebSettingsPath,
  readAgentWebSettings,
  writeAgentWebSettings,
  MalformedSettingsError,
  SettingsConflictError,
} from "./browser-tab-title.ts";

test("normalizeBrowserTabTitle & sanitizeRawBrowserTabTitle", () => {
  assert.equal(normalizeBrowserTabTitle(null), "");
  assert.equal(normalizeBrowserTabTitle(undefined), "");
  assert.equal(normalizeBrowserTabTitle(""), "");
  assert.equal(normalizeBrowserTabTitle("   \t  "), "");

  // 控制字符与换行
  const dirty = "Hello\r\nWorld\x00\x1b\x7f\x80\x9f!";
  assert.equal(normalizeBrowserTabTitle(dirty), "HelloWorld!");

  // Unicode 80 码点截断与 Emoji
  const emojis85 = "🚀".repeat(85);
  const normalizedEmojis = normalizeBrowserTabTitle(emojis85);
  assert.equal(Array.from(normalizedEmojis).length, 80);
  assert.equal(normalizedEmojis, "🚀".repeat(80));

  // sanitizeRawBrowserTabTitle 保留首尾空格，截断 80
  const rawWithSpaces = "  " + "🔥".repeat(85) + "  ";
  const sanitizedRaw = sanitizeRawBrowserTabTitle(rawWithSpaces);
  assert.equal(Array.from(sanitizedRaw).length, 80);
  assert.ok(sanitizedRaw.startsWith("  "));
});

test("readAgentWebSettings: no init when file does not exist", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tab-title-noinit-"));
  try {
    const { settings, exists } = await readAgentWebSettings(tmpDir);
    assert.equal(exists, false);
    assert.equal(settings.version, 1);
    assert.equal(settings.revision, 0);
    assert.equal(settings.title, "");

    // 确认没有自动生成文件（GET readonly no init）
    const settingsPath = getAgentWebSettingsPath(tmpDir);
    await assert.rejects(fs.access(settingsPath));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeAgentWebSettings: atomic write, revision bump, keeps unknown fields, permissions 600", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tab-title-write-"));
  try {
    const settingsPath = getAgentWebSettingsPath(tmpDir);

    // 先写入初始带 unknown 字段的设置
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify({
        version: 1,
        revision: 2,
        title: "Initial Title",
        customPluginData: { foo: "bar" },
        themeChoice: "dark",
      }),
      { mode: 0o600 }
    );

    // 1. 尝试以错误的 revision 写入 -> 触发 409 Conflict
    await assert.rejects(
      writeAgentWebSettings({ title: "Conflicting Title", revision: 1 }, tmpDir),
      (err) => {
        assert.ok(err instanceof SettingsConflictError);
        assert.equal(err.currentRevision, 2);
        assert.equal(err.requestedRevision, 1);
        return true;
      }
    );

    // 2. 以正确的 revision 写入 -> 成功递增 revision，保留 unknown 字段
    const next = await writeAgentWebSettings({ title: "Updated Title", revision: 2 }, tmpDir);
    assert.equal(next.version, 1);
    assert.equal(next.revision, 3);
    assert.equal(next.title, "Updated Title");
    assert.deepEqual(next.customPluginData, { foo: "bar" });
    assert.equal(next.themeChoice, "dark");

    // 3. 验证落盘文件内容与权限
    const diskContent = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.equal(diskContent.revision, 3);
    assert.equal(diskContent.title, "Updated Title");
    assert.deepEqual(diskContent.customPluginData, { foo: "bar" });

    // 文件权限检查
    const stat = await fs.stat(settingsPath);
    // mode 包含文件类型，掩码 0o777 得到权限位
    const perm = stat.mode & 0o777;
    assert.equal(perm, 0o600);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("readAgentWebSettings: malformed fail-closed, does not reset or overwrite", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tab-title-malformed-"));
  try {
    const settingsPath = getAgentWebSettingsPath(tmpDir);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(settingsPath, "{ malformed json content ... }");

    // 读取损坏文件抛出 MalformedSettingsError
    await assert.rejects(
      readAgentWebSettings(tmpDir),
      (err) => err instanceof MalformedSettingsError
    );

    // 写入时遇到损坏文件也拒绝盲目覆盖重置，fail closed 抛出
    await assert.rejects(
      writeAgentWebSettings({ title: "New", revision: 0 }, tmpDir),
      (err) => err instanceof MalformedSettingsError
    );

    // 确认磁盘内容未被重置覆盖
    const rawAfter = await fs.readFile(settingsPath, "utf8");
    assert.equal(rawAfter, "{ malformed json content ... }");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("readAgentWebSettings: rejects wrong version, invalid revision, bad title, and ENOTDIR (fail-closed)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tab-title-corrupt-fields-"));
  const settingsPath = getAgentWebSettingsPath(tmpDir);
  try {
    await fs.mkdir(tmpDir, { recursive: true });

    // 1. wrong version
    await fs.writeFile(settingsPath, JSON.stringify({ version: 2, revision: 1, title: "OK" }));
    await assert.rejects(readAgentWebSettings(tmpDir), (err) => err instanceof MalformedSettingsError);

    // 2. missing revision or negative / non-safeinteger
    await fs.writeFile(settingsPath, JSON.stringify({ version: 1, revision: -1, title: "OK" }));
    await assert.rejects(readAgentWebSettings(tmpDir), (err) => err instanceof MalformedSettingsError);

    await fs.writeFile(settingsPath, JSON.stringify({ version: 1, revision: 1.5, title: "OK" }));
    await assert.rejects(readAgentWebSettings(tmpDir), (err) => err instanceof MalformedSettingsError);

    await fs.writeFile(settingsPath, JSON.stringify({ version: 1, title: "OK" }));
    await assert.rejects(readAgentWebSettings(tmpDir), (err) => err instanceof MalformedSettingsError);

    // 3. title is not string
    await fs.writeFile(settingsPath, JSON.stringify({ version: 1, revision: 0, title: 123 }));
    await assert.rejects(readAgentWebSettings(tmpDir), (err) => err instanceof MalformedSettingsError);

    // 4. title violates raw sanity limits (contains control chars or exceeds max codepoints)
    await fs.writeFile(settingsPath, JSON.stringify({ version: 1, revision: 0, title: "Line\nBreak" }));
    await assert.rejects(readAgentWebSettings(tmpDir), (err) => err instanceof MalformedSettingsError);

    // 5. ENOTDIR 严禁被当作 missing (exists: false)
    // 创建一个普通文件作为父路径，使得 readFile 报 ENOTDIR
    const notADirParent = path.join(tmpDir, "file-not-dir");
    await fs.writeFile(notADirParent, "dummy");
    await assert.rejects(
      readAgentWebSettings(notADirParent),
      (err) => typeof err === "object" && err !== null && err.code === "ENOTDIR"
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("writeAgentWebSettings: concurrent multi-process file write safety and serialization", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-tab-title-concurrent-proc-"));
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    // 初始写入 revision 0
    await writeAgentWebSettings({ title: "Start", revision: 0 }, tmpDir);

    // 编写独立的子进程脚本，两进程通过 jiti 真正跨进程并发竞争写入
    const script = `
      import { createJiti } from "jiti";
      const jiti = createJiti(import.meta.url);
      const { writeAgentWebSettings, readAgentWebSettings } = await jiti.import("/workspace/agent-web-plus/lib/browser-tab-title.ts");
      const tmpDir = process.argv[1];
      const title = process.argv[2];
      for (let i = 0; i < 10; i++) {
        try {
          const { settings } = await readAgentWebSettings(tmpDir);
          await writeAgentWebSettings({ title: title + "_" + i, revision: settings.revision }, tmpDir);
          break;
        } catch {
          await new Promise(r => setTimeout(r, 20 + Math.random() * 20));
        }
      }
    `;

    const opts = { cwd: "/workspace/agent-web-plus" };
    const p1 = execFileAsync("node", ["--input-type=module", "-e", script, tmpDir, "P1"], opts);
    const p2 = execFileAsync("node", ["--input-type=module", "-e", script, tmpDir, "P2"], opts);

    await Promise.all([p1, p2]);

    const { settings } = await readAgentWebSettings(tmpDir);
    assert.ok(settings.revision >= 2, "并发 2 进程写入后 revision 应成功递增");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
