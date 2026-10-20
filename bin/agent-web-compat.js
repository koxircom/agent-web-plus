"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Display names and command names must never select a different data store.
function resolveDataPath(value, home, cwd) {
  const expanded = value === "~" ? home
    : value.startsWith(`~${path.sep}`) || value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  return path.resolve(cwd, expanded);
}

function sameDirectory(first, second) {
  const canonical = (value) => {
    try { return fs.realpathSync(value); }
    catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return value;
      throw error;
    }
  };
  return canonical(first) === canonical(second);
}

function prepareAgentWebEnvironment(env = process.env, { home = os.homedir(), cwd = process.cwd() } = {}) {
  const legacy = env.PI_CODING_AGENT_DIR;
  const renamed = env.AGENT_WEB_DATA_DIR;
  // Preserve an existing explicit Pi override, including its original spelling.
  // An explicit new alias may only coexist when both resolve to the same store.
  if (legacy && renamed && !sameDirectory(resolveDataPath(legacy, home, cwd), resolveDataPath(renamed, home, cwd))) {
    throw new Error("AGENT_WEB_DATA_DIR 与 PI_CODING_AGENT_DIR 指向不同目录；请统一为原数据目录后启动，原数据未移动。");
  }
  const selected = legacy || (renamed ? resolveDataPath(renamed, home, cwd) : path.join(home, ".pi", "agent"));
  env.PI_CODING_AGENT_DIR = selected;
  return selected;
}

module.exports = { prepareAgentWebEnvironment };
