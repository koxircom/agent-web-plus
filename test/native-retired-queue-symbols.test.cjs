const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const modulesDir = path.join(root, 'enhancements', 'modules');

console.log('=== [Test] 断言 8 个增强模块零已退休队列符号及 vm.Script 语法验证 ===');

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

const retiredQueueSymbols = [
  '__PI_ENH_FETCH_QUEUED_MESSAGE_DETAIL__',
  '__PI_ENH_GET_QUEUE_ATTACHMENT_REVISION__',
  '__PI_ENH_GET_QUEUE_DETAIL_CACHE_STATS__',
  'fetchQueuedMessageDetail',
  'queueAttachmentRevision',
  'queuedMessageDetailCache',
  'currentQueueDetailCacheBytes',
  'queueDetailCacheGeneration',
  'queuedMessageDetailInFlight',
  'clearQueueDetailCache',
];

const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.js')).sort();
assert.deepEqual(files, expectedModules, '模块清单必须严格为 8 个标准增强模块');

const fileContents = [];

for (const modFile of files) {
  const filePath = path.join(modulesDir, modFile);
  const code = fs.readFileSync(filePath, 'utf-8');
  fileContents.push(code);

  // 1. 静态断言：逐个核查模块，断言零退休队列符号残留
  for (const sym of retiredQueueSymbols) {
    const hasSymbol = code.includes(sym);
    assert.strictEqual(
      hasSymbol,
      false,
      `模块 ${modFile} 违规残留已退休队列符号: ${sym}`
    );
  }

  console.log(`✓ 模块 ${modFile}: 静态断言零退休队列符号通过`);
}

// 2. 真实 8 模块整体组合 vm.Script 语法解析验证
console.log('--- 运行 8 个增强模块组合 vm.Script 语法编译验证 ---');
const combinedSource = fileContents.join('\n');

try {
  new vm.Script(combinedSource, {
    filename: 'enhancements-combined-modules.vm.js',
    displayErrors: true,
  });
  console.log('✓ 实际 8 个增强模块组合 vm.Script 语法验证通过 (0 SyntaxError)');
} catch (syntaxErr) {
  assert.fail(`8 模块组合代码存在语法解析错误: ${syntaxErr.message}`);
}

console.log('=== [Test] 全部 8 模块静态契约与 vm.Script 语法验证 100% 通过 ===');
