## 中文

- 离线页统一为 Pi Web Plus 紫色 Pi+ 品牌和中文提示，支持重试回到原入口；Logo 内联，无额外图片或字体请求。
- 修复 Windows 会话文件同步使用只读句柄导致保存确认失败的问题；仍须确认消息真实落盘后才标记保存成功。
- 修复已由服务端保留的旧消息占满本地 20 条待接收名额、阻塞新消息的问题；保留旧原文，不自动重复发送。
- 包含此前本地版本的会话历史同步、最近轮次刷新保留、检索及手机导航修复。
- 内嵌官方 Pi SDK 四个依赖固定为 **1.3.0**。安装 Pi Web Plus 不会自动更新主机全局 Pi Agent CLI，CLI 需单独更新。

验证：发布质量门禁 12 个分片通过；Windows 原生持久化测试 16 项、浏览器可靠发送测试 8 项、离线缓存测试 10 项通过。已安装环境完成桌面/手机离线重试验证；Windows 原会话实际发送、回复、保存确认和刷新保留验证通过。

最低 Node.js：**22.19.0**。

```sh
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.87/pi-web-plus-1.3.87.tgz
```

升级前保留配置和会话备份。安装包不携带实例凭据、会话记录、实例清单或用量账本。Service Worker 离线能力仍受浏览器安全上下文限制，不会绕过普通 HTTP 的限制。

源码以 `release/v1.3.87` 分支及 `v1.3.87` 标签记录已验收版本；保留 `main` 上并行开发的自动复盘功能，未将其混入本次安装包。

## English

- Brand the offline fallback with the purple Pi+ identity, Chinese copy and a retry action returning to the original entry. The inline logo adds no image/font requests.
- Fix Windows persistence confirmation by syncing the existing transcript through a writable, non-truncating handle. A committed receipt still requires an actual persisted message.
- Keep server-retained originals from consuming the local 20-request admission limit. Preserve old content and never automatically replay it.
- Include the locally validated history synchronization, latest-turn refresh retention, search and mobile navigation fixes since the previous GitHub release.
- Pin all four embedded official Pi SDK packages to **1.3.0**. The global Pi Agent CLI is a separate installation.

Validation: all 12 release-gate shards passed; 16 native Windows persistence tests, 8 browser delivery tests and 10 service-worker tests passed. Installed desktop/mobile offline recovery and a real Windows send/reply/commit/refresh flow were verified.

Requires Node.js **22.19.0+**. Back up configuration and sessions before upgrading. The archive excludes instance credentials, transcripts, instance manifests and usage ledgers. Browser secure-context requirements still apply to Service Workers.

The accepted source is preserved on `release/v1.3.87` and tag `v1.3.87`; parallel automatic-learning work on `main` is retained and is not part of this artifact.

SHA256 (`pi-web-plus-1.3.87.tgz`):
`973843af6117899827be48ac402bbb6bd25607fd99df1c4a602c1f0bee7028ec`
