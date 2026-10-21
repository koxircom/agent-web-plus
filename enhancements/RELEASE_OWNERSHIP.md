# Pi Web 发布防叠层检查

`check-release-ownership.cjs` 是针对该候选源码树的窄范围发布门禁。它导出纯函数 `checkReleaseOwnership(sources)`，检查已知的 React/native 所有权契约；命令行只读取传入目录中的源码，并以中文输出逐项结果。

已接入 `npm run build` 的 prebuild 和 `npm pack` 的 prepack；enhancement builder 的 --build/--verify 也会先执行门禁。从候选根目录单独调用：

```sh
node enhancements/check-release-ownership.cjs --source-dir .
```

门禁当前锁定这些可从源码确认的行为：

- `ChatInput` 只保留一个受控的 `textarea.chat-input-textarea`，隐藏文件选择器仍是唯一 `input`，并保留原生布局 ownership 标记；module05 的适配器首先定位这块 React textarea。
- module05 不能重新创建第二个 textarea、`contentEditable` 或 `textbox`。普通附件、快捷操作、图片、模型/思考控制等既有业务增强不受影响；检查器不禁止 `document.createElement` 或一般 DOM 增强。
- `SettingsPanel` 的五个原生区与启用的 legacy 扩展沿同一导航列表渲染，面板只有一个对话框根节点。
- `ChatMinimap` 隐藏占位和可见轨道都立即标记 `data-minimap-native-owner`。module06仅保留偏好事件与原生接口适配；旧渲染、手势、移动导航和样式实现已经删除，门禁禁止它们重新进入主包。
- module07 的编辑区变更过滤以原生 textarea 为目标，并保留菜单和对话框自己的同步处理。
- `PiWebBrand` 保留 inline SVG `Agent Web Plus` 字标，不把旧图片叠回品牌组件。
- builder 将 01/05/06/07 纳入固定模块规格，`Buffer.concat` 后覆盖写主 bundle 与 public 镜像；`runVerify` 仍检查主 bundle 字节一致和镜像中核心 bundle 只出现一次。

`enhancements/tests/release-ownership.test.cjs` 含纯内存 fixture：一个有效 ownership 样例，以及新增第二编辑器、缺失设置 section、minimap 加载期/已退役交互恢复、图片品牌叠层和追加写 bundle 等负向样例。测试由主控统一运行。

## 适用边界

这是源码结构门禁，不替代 Odoo/Pi Web 的运行时或浏览器验收。它不解析任意 JavaScript 语义，也不为 module08 的设置扩展、用量面板资源是否内联、bundle 产物是否与候选 hash 相符作结论；后两项已由 builder 拒绝重新内联 XLSX/用量面板，并校验可选资产内容哈希、SRI 与模块/镜像字节一致性。若有意改变上述已知 ownership 契约，应同时调整此检查器、fixture 和说明，再由主控完成候选验收。

## 本轮按需资源

SheetJS 0.20.3 从已接受源码原样提取，没有升级或从外部下载；首次打开工作表才载入。用量面板首次打开或确需删除前封存用量时载入。两个资产以内容哈希命名、完整 SHA256 SRI 验证并长期缓存；可变用量账本仍独立按需读取，不纳入该缓存规则。失败/超时不会保留 pending，重试重新发起请求。PrismAsyncLight 异步载入轻量核心及对应语法，未知语言、流式和高亮不可用时保持可读文本。

已处理的交付反复来自 JSX 开闭标签替换不完整及测试假设旧英文界面；防护落在产品源码的受影响组件测试，断言实际中文按钮与流式/未知语言状态，并由构建编译阻止不成对标签进入发布。

FileViewer 与聊天代码块都使用 AsyncLight 入口和两个 deep ESM 主题，builder 拒绝恢复同步 Prism/CJS 主题入口。`scripts/check-client-budget.cjs` 在 postbuild/prepack 检查真实主入口 HTML 引入的唯一静态脚本与增强脚本，阈值分别为750000/600000 gzip字节，合计1350000。登录页不允许替代主入口，变量会话数据不纳入静态预算。

中文文件路径回归来自旧 document capture listener接管原生普通链接，持久防护在 native-file-links测试中：普通链接让位、兼容href只解码一次、raw filesystem路径保留百分号。搜索验收按已有“高亮命中”语义，避免把测试假设变为无授权功能变更。

## 1.2.0 原生样式接管
共享样式必须由app/layout.tsx导入app/enhancements.css；禁止恢复共享styleEl注入、Logo预缓存或Node.insertBefore全局覆盖。侧栏原生入口只有在增强快捷栏已经挂载时才可隐藏；仅有host标记不代表接管完成。首屏预算同时计算JS与CSS，避免把样式移出脚本后误报下载节省。

## 弱网发送可见性发布验收

“发送后消息持续可见”是消息发送、历史加载、SSE 确认或会话恢复相关改动的发布必验项。首次采用及相关路径变更时，在当前指纹的隔离实例完成下列检查；同一指纹、环境与路径已有有效回执时复用证据，不重复执行。不因无关小版本更新而扩大回归。

- 桌面文字与手机图片消息：真实界面点击发送后立即显示用户消息；人为延迟实际发送 POST 的响应，并在等待期间刷新历史记录，消息不能消失或闪回旧状态。图片与文字均保留。
- 相同文字：先保留一条同文历史消息，再提交新消息；等待期间两条都可见，服务器确认后本次提交仅保留一条正式记录，不误合并旧消息；单次操作仅一次 POST。
- 明确拒绝：仅对 accepted=false 等明确未接收结果移除临时消息并恢复草稿；超时或确认不明不得自行重复发送。
- 显示与确认分开：立即显示不等于服务器接收或持久化成功。本地消息只属于显示层，不能进入已确认历史缓存或认证基线；收到对应确认后再交接为正式消息。

回执至少记录候选源码指纹、BUILD_ID、实际隔离入口、桌面/手机视口、请求次数、延迟期间连续帧的可见性、历史刷新/确认/拒绝结果及截图。通过标准为本轮目标消息首个可见样本在500毫秒内，随后至确认/拒绝之间无消失帧；这是受控隔离验收阈值，不作为公网速度承诺。源码门禁、构建成功或 HTTP 200 不能替代上述浏览器证据，也不要声称 npm prebuild/prepack 已自动运行这一浏览器检查。

隔离脚本先等待真实历史渲染与附件就绪，显式管理模拟模型的挂起/释放；只能创建并清理自有隔离会话，不使用用户模型凭据、生产会话或后台 LLM 巡检。检查通过立即停止，不重复构建或全量测试。

首次证据（2026-10-05，1.3.19隔离候选）：`[脱敏历史验收目录]/REPORT.md` 与 `receipt.json`，BUILD_ID `nJ4PWAPMij1LOk7C44wnW`。此证据只证明该指纹的隔离实例通过，不代表正式部署或其他设备已经生效。
