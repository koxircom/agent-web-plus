const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const modulesDir = path.join(root, 'enhancements', 'modules');
const mod08Path = path.join(modulesDir, '08-settings-panels-and-lifecycle.js');

console.log('=== [Test] 快捷方式权威配置与非空 Guard 静态契约验证 ===');

assert.ok(fs.existsSync(mod08Path), '08-settings-panels-and-lifecycle.js 必须存在');
const mod08Code = fs.readFileSync(mod08Path, 'utf-8');

// 1. 断言：无 /pi-shortcuts-manifest.json 静态清单 URL
assert.strictEqual(
  mod08Code.includes('/pi-shortcuts-manifest.json'),
  false,
  '08 模块严禁残留 /pi-shortcuts-manifest.json 请求或静态 fallback 分支'
);
assert.strictEqual(
  mod08Code.includes('pi-shortcuts-manifest'),
  false,
  '08 模块严禁残留任何 pi-shortcuts-manifest 标识'
);
console.log('✓ 断言通过: 08 模块已完全移除 /pi-shortcuts-manifest.json 静态清单 fallback');

// 2. 断言：保留权威 /api/models-config 的 GET 与 PUT 同步契约
assert.match(
  mod08Code,
  /activeFetch\(\s*["']\/api\/models-config["']\s*,\s*\{\s*cache:\s*["']no-store["']\s*\}\s*\)/,
  '08 模块必须保留从权威服务端配置 GET /api/models-config 拉取 quickShortcuts'
);

assert.match(
  mod08Code,
  /activeFetch\(\s*["']\/api\/models-config["']\s*,\s*\{[\s\S]*?method:\s*["']PUT["'][\s\S]*?body:\s*JSON\.stringify\(putPayload\)/,
  '08 模块必须保留向权威服务端配置 PUT /api/models-config 同步 quickShortcuts'
);
console.log('✓ 断言通过: 保留 /api/models-config 权威 GET/PUT 双向持久化通道');

// 3. 断言：保留内置非空 Guards 与 localRevision 机制，确保不清空已有配置
// Guard A: remoteList 为空时必须 return 早退，严禁抹空已有本地快捷项
assert.match(
  mod08Code,
  /if\s*\(!remoteList\s*\|\|\s*remoteList\.length\s*===\s*0\)\s*return;/,
  '必须保留 remoteList 非空守卫，远端或兜底清单为空时严禁覆盖或清空本地数据'
);

// Guard B: setStoredQuickShortcuts 防空降级保底
assert.match(
  mod08Code,
  /if\s*\(!Array\.isArray\(list\)\s*\|\|\s*list\.length\s*===\s*0\)\s*\{\s*list\s*=\s*\[\{\s*id:\s*["']settings["']/,
  '必须保留 setStoredQuickShortcuts 防空降级保底'
);

// Guard C: 保持 localRevision 读取与更新守卫
assert.match(
  mod08Code,
  /function\s+getLocalShortcutsRevision\(\)/,
  '必须保留 getLocalShortcutsRevision 逻辑'
);
assert.match(
  mod08Code,
  /function\s+setLocalShortcutsRevision\(rev\)/,
  '必须保留 setLocalShortcutsRevision 逻辑'
);
assert.match(
  mod08Code,
  /shortcutsRevision/,
  '必须保留 shortcutsRevision 判定逻辑'
);
console.log('✓ 断言通过: 内置非空 Guards 与 localRevision 防清空机制完整');

// 4. 断言：注释序号准确（1. 权威服务端配置 / 2. 兜底内置清单）
assert.match(
  mod08Code,
  /\/\/\s*1\.\s*优先从权威服务端配置\s*\/api\/models-config\s*拉取/,
  '注释序号 1 必须准确标注从 /api/models-config 拉取'
);
assert.match(
  mod08Code,
  /\/\/\s*2\.\s*兜底内置清单/,
  '注释序号 2 必须准确标注兜底内置清单'
);
console.log('✓ 断言通过: syncManifestQuickShortcuts 逻辑注释序号准确');

// 5. 编译验证：08 模块与所有增强模块 vm.Script 语法解析 (0 SyntaxError)
const expectedModules = [
  '01-bootstrap-and-core-state.js',
  '02-plugin-registry-and-settings-schema.js',
  '03-session-cache-and-sync-engine.js',
  '04-sidebar-and-session-management.js',
  '05-composer-and-input-workflow.js',
  '06-chat-view-and-tool-cards.js',
  '07-kernel-scheduler-and-observers.js',
  '08-settings-panels-and-lifecycle.js',
];
const fileList = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.js')).sort();
assert.deepEqual(fileList, expectedModules, '模块目录必须为 8 个标准模块');

const combined = fileList.map((f) => fs.readFileSync(path.join(modulesDir, f), 'utf-8')).join('\n');
assert.doesNotThrow(() => {
  new vm.Script(combined, { filename: 'modules-combined.vm.js' });
}, '8 模块组合代码必须通过 vm.Script 语法编译验证');
console.log('✓ 断言通过: 8 模块组合 vm.Script 语法编译 0 错误');

console.log('=== [Test] test/native-shortcuts-authority.test.cjs 全部通过 ===');
