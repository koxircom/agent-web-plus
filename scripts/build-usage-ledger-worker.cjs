const esbuild = require("esbuild");
const path = require("node:path");

function buildWorker() {
  const root = path.resolve(__dirname, "..");
  esbuild.buildSync({
    entryPoints: [path.join(root, "lib/usage-ledger-worker-entry.ts")],
    outfile: path.join(root, "bin/usage-guard/usage-ledger-worker.mjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    packages: "external",
    banner: { js: 'import { createRequire as workerCreateRequire } from "node:module"; const require = workerCreateRequire(import.meta.url);' },
    alias: { "server-only": path.join(root, "scripts/usage-worker-server-only.cjs") },
  });
  console.log("[build-usage-ledger-worker] Built internal statistics worker");
}

if (require.main === module) buildWorker();
module.exports = { buildWorker };
