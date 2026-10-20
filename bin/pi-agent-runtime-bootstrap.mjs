// Agent Web Plus Native SDK Runtime Bootstrap
// Preloaded into Next.js server child process via Node.js --import.
// Captures official SDK evidence without starting an AgentSession or making LLM calls.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const bootstrapRequire = createRequire(import.meta.url);
bootstrapRequire("./agent-web-compat.js").prepareAgentWebEnvironment();
try {
  const { prepareWindowsShellEnvironment } = bootstrapRequire("./windows-shells.cjs");
  prepareWindowsShellEnvironment();
} catch (error) {
  console.warn("[pi-web] Failed to prepare Windows shell environment:", error);
}

function sha256Hex(bufferOrString) {
  return crypto.createHash("sha256").update(bufferOrString).digest("hex");
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  fs.renameSync(tmp, filePath);
}

function findPackageJson(entryPath) {
  let dir = path.dirname(path.resolve(entryPath));
  while (dir && dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        if (pkg && pkg.name === "@earendil-works/pi-coding-agent") {
          return candidate;
        }
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return null;
}

export async function captureRuntimeBootstrap() {
  const portEnv = process.env.PI_WEB_PORT;
  if (!portEnv) {
    // Only capture inside the listening Next.js child process where PI_WEB_PORT is explicitly set.
    return;
  }
  const parsedPort = Number.parseInt(portEnv, 10);
  const portNumber = Number.isFinite(parsedPort) ? parsedPort : Number(portEnv);
  const nowMs = Date.now();
  let agentDir = null;

  try {
    const req = createRequire(import.meta.url);
    let entryPath = null;

    // 1. Primary: createRequire.resolve
    try {
      entryPath = req.resolve("@earendil-works/pi-coding-agent");
    } catch {
      // 2. Fallback: import.meta.resolve
      if (typeof import.meta.resolve === "function") {
        try {
          const resolvedUrl = await import.meta.resolve("@earendil-works/pi-coding-agent");
          if (resolvedUrl) {
            entryPath = fileURLToPath(resolvedUrl);
          }
        } catch {}
      }
      // 3. Fallback: probe node_modules resolution paths
      if (!entryPath && typeof req.resolve.paths === "function") {
        const paths = req.resolve.paths("@earendil-works/pi-coding-agent") || [];
        for (const searchPath of paths) {
          const candidatePkg = path.join(searchPath, "@earendil-works", "pi-coding-agent", "package.json");
          if (fs.existsSync(candidatePkg)) {
            try {
              const parsed = JSON.parse(fs.readFileSync(candidatePkg, "utf8"));
              const rel = parsed.main || parsed.exports?.["."]?.import || "dist/index.js";
              const candidateEntry = path.join(path.dirname(candidatePkg), rel);
              if (fs.existsSync(candidateEntry)) {
                entryPath = candidateEntry;
                break;
              }
            } catch {}
          }
        }
      }
    }

    if (!entryPath) {
      throw new Error("无法定位 @earendil-works/pi-coding-agent SDK 入口");
    }

    const entryRealpath = fs.realpathSync(entryPath);
    const entryUrl = pathToFileURL(entryRealpath).href;

    // Dynamic import actual sdk entry via file URL (cross-platform safe including Windows drive paths)
    const sdk = await import(entryUrl);
    const sdkVersion = sdk.VERSION || (sdk.default && sdk.default.VERSION);
    if (!sdkVersion || typeof sdkVersion !== "string") {
      throw new Error(`SDK 模块未导出有效的 VERSION: ${String(sdkVersion)}`);
    }

    if (typeof sdk.getAgentDir === "function") {
      agentDir = sdk.getAgentDir();
    } else {
      agentDir = path.join(process.env.HOME || "/root", ".pi", "agent");
    }

    const entryBuffer = fs.readFileSync(entryRealpath);
    const entrySha256 = sha256Hex(entryBuffer);

    const packageJsonPath = findPackageJson(entryRealpath);
    if (!packageJsonPath) {
      throw new Error(`无法找到 SDK package.json: ${entryRealpath}`);
    }
    const packageRealpath = fs.realpathSync(packageJsonPath);
    const packageBuffer = fs.readFileSync(packageRealpath);
    const packageSha256 = sha256Hex(packageBuffer);

    const evidence = {
      schema: 1,
      pid: process.pid,
      port: Number.isFinite(portNumber) ? portNumber : 0,
      sdk_version: sdkVersion,
      sdk_package_realpath: packageRealpath,
      sdk_package_sha256: packageSha256,
      sdk_entry_realpath: entryRealpath,
      sdk_entry_sha256: entrySha256,
      captured_at_ms: nowMs,
    };

    const targetFile = path.join(agentDir, "state", `pi-agent-runtime-${portNumber}.json`);
    writeAtomic(targetFile, JSON.stringify(evidence, null, 2) + "\n");
  } catch (error) {
    // 失败写 error 证据且不阻止 Next 既有启动
    try {
      const fallbackDir = agentDir || path.join(process.env.HOME || "/root", ".pi", "agent");
      const targetFile = path.join(fallbackDir, "state", `pi-agent-runtime-${portNumber}.json`);
      const errorEvidence = {
        schema: 1,
        pid: process.pid,
        port: Number.isFinite(portNumber) ? portNumber : 0,
        error: error instanceof Error ? error.message : String(error),
        error_stack: error instanceof Error ? error.stack : undefined,
        captured_at_ms: nowMs,
      };
      writeAtomic(targetFile, JSON.stringify(errorEvidence, null, 2) + "\n");
    } catch {
      // 容错：即使写 error 证据也失败，不阻止 Next 既有启动
    }
  }
}

// 自动执行顶层捕获，不建 AgentSession，不调用 LLM
await captureRuntimeBootstrap();
