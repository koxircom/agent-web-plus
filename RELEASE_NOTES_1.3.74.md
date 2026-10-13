# PI Web Plus 1.3.74 · Pi Agent SDK 1.2.0

## 中文

- **Pi Agent SDK 1.2.0**：内置 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 统一升级至 1.2.0。Web 安装包保持独立隔离，不会强制修改主机全局 Pi CLI。
- **LLM Wiki 静默协同模式与隔离支持**：适配 `@zosmaai/pi-llm-wiki` 知识库扩展，后台静默索引与文档协同，消除非必要的通知打扰与会话上下文污染；完善隐藏 Entry 与导航锚点兼容。
- **大图延迟加载与流式端点**：优化用户消息与工具结果中的大图片加载逻辑，采用专用流式端点按需加载，彻底消灭内存暴涨与本地缓存 `QuotaExceededError` 配额溢出风险。
- **会话恢复与历史导航加固**：加固会话离线视图缓存与只读回放机制，未完成任务与草稿恢复更加稳健，消除移动端多会话切换时的界面闪烁与软键盘争夺。
- **输入框与交互体验优化**：原生输入框高度拖拽锁定与微光动效支持，桌面端与移动端保持统一丝滑体验。

验收：45 项核心定向单测全绿通过（聚焦 MessageView、ChatWindow、MessageDisplay、SessionRecovery 等）；离线包解包及 `pi-web --help` 健全性验证通过；生产环境 1280px 桌面与 390px 移动端只读加载验收通过。

## English

- **Pi Agent SDK 1.2.0**: Pin all four embedded dependencies (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`) to 1.2.0. Installing Web does not modify or overwrite the host global Pi CLI.
- **LLM Wiki Quiet Mode & Clean Integration**: Full support for `@zosmaai/pi-llm-wiki` background indexing and knowledge collaboration without noisy notifications or context pollution; enhanced custom entry handling and navigation anchors.
- **Large Image Defer & Streaming Delivery**: Defer base64 image hydration in transcripts to dedicated streaming routes, preventing browser memory exhaustion and local storage `QuotaExceededError` crashes.
- **Session Recovery & Navigation Durability**: Strengthen offline history view caching and read-only replay; eliminate UI flickering and mobile virtual keyboard focus conflicts during rapid session switching.
- **Composer Polish**: Support manual height drag locking and glowing accents with seamless cross-device responsiveness.

Validation: 45 focused test suites passed; clean offline archive unpacking and `pi-web --help` sanity verified; 1280px desktop and 390px mobile read-only verification confirmed.

## Artifact

- BUILD_ID: `wwRgmRdUhtytpB7HWQLo3`
- SHA256: `5a563e23bf15f6289fff6d08af82fee5a2fa106091590f44de393a274a5b13de`
- Target Version: `1.3.74`

```bash
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.74/pi-web-plus-1.3.74.tgz
```
