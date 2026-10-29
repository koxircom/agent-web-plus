
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

console.log("=== Testing Batch Selection & Mobile Swipe Logic ===");

const bundlePath = path.join(__dirname, "..", "..", "public", "pi-web-enhancements.js");
const code = fs.readFileSync(bundlePath, "utf8");

// Assert critical strings exist in the bundle
assert(code.includes("isBatchTouchDragging"), "Bundle must contain isBatchTouchDragging");
assert(code.includes("batchTouchTargetState"), "Bundle must contain batchTouchTargetState");
assert(code.includes("pi-enh-menu-item-disabled"), "Bundle must contain pi-enh-menu-item-disabled");
assert(code.includes("多选状态下不支持重命名"), "Bundle must contain rename disabled hint");
assert(code.includes("接力提示词仅支持单个会话"), "Bundle must contain copy-prompt disabled hint");
assert(code.includes("从磁盘重载仅支持单个会话"), "Bundle must contain reload-session disabled hint");
assert(code.includes("handleBatchTouchAutoScroll"), "Bundle must contain edge auto-scroll handler");

console.log("✓ Bundle static token verification passed.");

// Check syntax and structure
const script = new vm.Script(code);
console.log("✓ Script compilation and vm.Script syntax test passed.");
