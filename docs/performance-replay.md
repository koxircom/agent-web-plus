# Pi Web 性能回放与回归门禁

此回放用于判断界面变更是否产生实测收益。它不是模型吞吐量测试，也不能替代用户设备上的网络和触屏验证。生产代码不包含计时探针；测试不向模型发送提示词。

## 固定负载

`tests/performance-replay.pw.mjs` 使用真实 ChatWindow、useAgentSession 和 ChatInput，在本机回环服务提供 1,000 条合成历史消息，并顺序发送 360 个固定增量。每条增量请求间隔 2ms，主线程负载会延长实际间隔。因此 `elapsedMs` 是界面回放耗时，不是模型生成速度。

桌面 1280px、手机 390px 各运行三次独立页面，以中位数对比。原生输入框每 100ms 接收一次 React onChange；`inputP95Ms` 测量事件派发到 React 提交，不包含物理按键、触屏或显示器延迟。

同一浏览器、依赖、生产 profiling 构建和 CSS 条件下记录 CPU 时间、React 提交次数、渲染时间、回放耗时及输入 P95。另检查 Ask User 即时呈现、终态退出“等待模型”、停止按钮消失，以及增量顺序完整且无重复。所有请求被限制在隔离回环服务，非 GET 仅容许被测试服务接管的租约续约。

## 执行

依赖要求：Node 22、项目锁定依赖、Playwright Chromium。先对当前候选完成定向检查，再跑回放。两次回放顺序执行，期间不要运行构建、另一套浏览器测试或其他重负载。

```bash
# 在候选源码根目录运行；baseline 指向本次改动前的冻结副本。
# 共用同一份 CSS，防止测量时引入无关样式差异。
PI_PERF_SOURCE_ROOT=/absolute/path/to/baseline \
PI_PERF_CSS_DIR=/absolute/path/to/reference-build/.next/static/css \
PI_PERF_LABEL=before PI_PERF_OUTPUT=/tmp/pi-perf-before.json \
node tests/performance-replay.pw.mjs

PI_PERF_CSS_DIR=/absolute/path/to/reference-build/.next/static/css \
PI_PERF_LABEL=after PI_PERF_OUTPUT=/tmp/pi-perf-after.json \
node tests/performance-replay.pw.mjs

node scripts/compare-performance-replays.mjs /tmp/pi-perf-before.json /tmp/pi-perf-after.json
```

`PI_PERF_SAMPLES` 和 `PI_PERF_WIDTHS` 仅供发现问题时缩小范围；最终对比必须每种视口至少三次。保存源码指纹、浏览器/Node 版本、构建 ID、原始 JSON 和比较结果。不得用改动前测试通过代替最终候选验收。首屏资源体积应从冻结源码在独立构建副本中重新生成后比较，不复用来源不完全匹配的旧产物；冻结源码本身保持不变。

共享 NAS 的计时有噪声，比较工具把 CPU、渲染、回放耗时增加超过 10% 视为明显回退；输入门限为基线 P95 × 1.1 + 8ms；每次 Ask User 和终态响应必须小于 1s。小于门限的变化不自动意味着提速，应同时查看原始样本和确定性的请求/字节/扫描次数。

## 配套行为检查

- `node tests/sidebar-request.pw.mjs`：原生侧栏的首次请求、刷新键、目录变化和手动刷新；使用 `PI_PERF_SOURCE_ROOT` 和 `PI_PERF_BASELINE=1` 对照旧实现。
- `node tests/enhancement-idle.pw.mjs`：真实增强脚本空闲期间扫描计数，以及文本替换、结构变化后的更新。
- `node tests/markdown-lazy.pw.mjs`：普通文本不加载公式引擎；多处公式共用一次加载；安全清洗和公式渲染仍生效。该夹具不代替 Next 编译结果。
- 构建后 `node tests/compiled-math.pw.mjs`：启动隔离 Next 服务和临时 Agent 状态目录，验证真正编译后的公式 CSS 延迟加载，并清理临时会话。使用现有密码建立测试 Cookie，不修改凭据；拦截产品非 GET 请求。
- `node tests/mobile-prompt-scroll.pw.mjs`：发送、流式消息、键盘变化、历史分页、排队消息和手动阅读位置。使用真实组件与合成数据。

## 2026-10-11 的优化取舍

保留侧栏首次重复请求修复、删除空闲全量 DOM 扫描、按需加载公式。尝试过流式帧合并，但第一版增加 CPU/提交，第二版仍未取得稳定 CPU 收益，提交次数反而增加；已完整撤回，保留原流式状态所有权和事件处理实现。以后重新优化该路径，先使用本回放证明收益，再决定是否保留；不要仅凭更少 setter 或更少事件推断更快。
