"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const sourceRoot = path.resolve(__dirname, "../..");
const runner = path.join(__dirname, "run.py");
const candidates = [];
if (process.env.PYTHON3) candidates.push({ file: process.env.PYTHON3, prefix: [] });
if (process.platform === "win32") {
  candidates.push({ file: "py", prefix: ["-3"] });
  candidates.push({ file: "python", prefix: [] });
} else {
  candidates.push({ file: "python3", prefix: [] });
  candidates.push({ file: "python", prefix: [] });
}

let selected = null;
for (const candidate of candidates) {
  const probe = spawnSync(candidate.file, [...candidate.prefix, "-c", "import sys; assert sys.version_info >= (3, 8)"], {
    cwd: sourceRoot,
    stdio: "ignore",
    shell: false,
  });
  if (!probe.error && probe.status === 0) {
    selected = candidate;
    break;
  }
}

if (!selected) {
  console.error("release-gate: Python 3 executable not found");
  process.exit(2);
}
if (!fs.existsSync(runner)) {
  console.error(`release-gate: missing ${runner}`);
  process.exit(2);
}

const runnerArgs = process.argv.includes("--list") ? ["--list"] : ["--suite", "release", "--resume"];
const result = spawnSync(selected.file, [...selected.prefix, runner, ...runnerArgs], {
  cwd: sourceRoot,
  stdio: "inherit",
  shell: false,
});
if (result.error) {
  console.error(`release-gate: failed to start Python runner: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status === null ? 1 : result.status);
