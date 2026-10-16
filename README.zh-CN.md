> **PI Web Plus 1.3.38** 基于 Pi Coding Agent 1.0.4。通过 [GitHub Releases](https://github.com/koxircom/pi-web-plus/releases/tag/v1.3.38) 安装预构建包；本地服务默认只监听 `127.0.0.1`。

> 1.3.38：移除侧边栏重复的文字状态标签和旧资源，补充脱敏实景图；包含截至 1.3.37 的改进，基于 Pi Coding Agent 1.0.4。

# PI Web Plus

[项目主介绍](./README.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

PI Web Plus 是 [Pi Coding Agent](https://github.com/earendil-works/pi) 的本地浏览器工作台，基于 [agegr/pi-web](https://github.com/agegr/pi-web) 开源项目持续维护。它与 pi 共用本机配置和会话文件，让你在浏览器中继续对话、运行智能体、管理模型，并查看项目文件。

## PI Web Plus 的特色

- **手机图片编辑**：点开输入框里的图片即可裁剪，或用画笔、矩形标注；保存时可替换当前附件，也可将标注图下载到本地。编辑工具适配手机触控。
- **会话分组与标签**：会话按项目和 worktree 归集；可置顶、归档、标记未读，并添加多维彩色标签，便于整理长期任务。
- **增强会话搜索**：用 `Ctrl+F`（macOS 为 `⌘F`）打开搜索，查找会话正文并查看命中片段；选择结果可回到对应消息。项目与归档搜索结果可折叠。
- **紧凑输入与队列操作**：窄屏友好的输入区将模型和思考级别放在一起；运行中的任务可切换后续模型，并查看、取回排队消息，不打断当前回复。
- **会话驻留与阅读恢复**：近期会话视图可在标签页缓存并预载；切换回来时恢复该会话的消息锚点和阅读位置。长历史采用分页与视口虚拟化，并支持手机与电脑间同步会话更新。
- **轻量引用与过程阅读**：选中文字即可复制或引用，给引用添加带序号的可选评论；工具结果集中折叠，便于连续阅读任务说明和回复。
- **本地项目工作区**：浏览和上传项目文件、查看 Git diff、预览常见文本与媒体文件，并通过 Git worktree 切换工作目录。模型、Provider 登录、插件包和技能也可从网页管理。

PI Web Plus 保留并扩展 agegr 的 pi-web 开源项目，许可证及原版权声明见 [MIT License](./LICENSE)。本项目使用 [Pi Coding Agent](https://github.com/earendil-works/pi)。

## 实际界面

以下图片均在独立演示环境中拍摄。项目、对话、图片和标签全部为虚构示例，不含真实会话、账号、密钥或设备地址。

### 会话工作区

项目会话列表、文件浏览器与对话区集中展示；运行状态沿用列表左侧指示，不再增加右侧文字状态标签。

![会话工作区](docs/screenshots/overview.png)

### 图片预览

点击会话中的图片可打开独立预览，关闭后回到原来的阅读位置。

![图片预览](docs/screenshots/image-preview.png)

### 会话导航

按轮次查看问题摘要，定位长会话中的对应消息，并管理导航书签。

![会话导航](docs/screenshots/navigation.png)

### 引用与评论

鼠标完成文本选择后显示复制与引用操作；引用可附加简短评论，再汇总到输入框。

![引用与评论](docs/screenshots/quote.png)

### 正文搜索

搜索会话正文并查看命中片段，点击结果跳转到对应消息。

![正文搜索](docs/screenshots/search.png)

### 分类与标签

为会话添加彩色标签，按任务类别整理项目；标签可统一维护。

![会话分类](docs/screenshots/categories.png)

### 增强功能

按功能模块管理阅读导航、输入附件、引用、会话列表和通知偏好。

![增强设置](docs/screenshots/enhancements.png)

### 设置页面

统一管理外观、聊天布局、模型、技能和子代理；公开示例仅展示界面偏好。

![设置页面](docs/screenshots/settings.png)

## 快速开始

PI Web Plus 要求 Node.js 22.19.0 或更高版本（`node >=22.19`）。先用 `node --version` 检查版本，然后从 [`koxircom/pi-web-plus` GitHub Releases](https://github.com/koxircom/pi-web-plus/releases) 全局安装官方预构建 `.tgz` 发行包并启动 `pi-web`：

```bash
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.38/pi-web-plus-1.3.38.tgz
pi-web
```

> **重要说明**：内部 `package.json` 的包名仍保留为 `@agegr/pi-web` 以维持运行时兼容，但 PI Web Plus 仅通过 [`koxircom/pi-web-plus` GitHub Releases](https://github.com/koxircom/pi-web-plus/releases) 的 `.tgz` 资产分发。**切勿从公共 npm 源拉取或安装 `@agegr/pi-web`**，公共 npm 源上的 `@agegr/pi-web` 是上游原版包，并非 PI Web Plus 发行包。

服务就绪后，命令行会尝试自动打开浏览器。如果没有打开，请访问 [http://127.0.0.1:30141](http://127.0.0.1:30141)。Pi Web 默认仅监听 `127.0.0.1`。

如果尚未配置模型 Provider，请打开**模型（Models）**面板登录或添加 API Key。

上面的命令安装的是 v1.3.38。安装或升级到其他版本时，请先用 `Ctrl+C` 停止正在运行的进程，将链接中的 `v1.3.38` 和 `1.3.38` 替换为 [GitHub Releases](https://github.com/koxircom/pi-web-plus/releases) 中对应的目标版本号 `<version>` 后重新执行安装命令：

```bash
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v<version>/pi-web-plus-<version>.tgz
```

卸载时运行 `npm uninstall -g @agegr/pi-web`。

## 配置

端口和主机名以命令行参数为准，优先于对应的环境变量。`--no-open` 与 `PI_WEB_NO_OPEN=1` 中任意一个都会关闭自动打开浏览器。运行 `pi-web --help`（或 `-h`）可打印启动选项并以退出码 0 结束，不会启动服务；未知参数会报错并以退出码 1 结束。

| 参数或环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `--help`、`-h` | 打印启动选项并退出 | — |
| `--port <端口>`、`-p <端口>` 或 `PORT` | 服务端口 | `30141` |
| `--hostname <主机>`、`-H <主机>` 或 `PI_WEB_HOSTNAME` | 监听主机名 | `127.0.0.1` |
| `--no-open` 或 `PI_WEB_NO_OPEN=1` | 不自动打开浏览器 | 自动打开 |
| `PI_WEB_ALLOWED_HOSTS` | 额外允许的代理或自定义主机名，多个值用逗号分隔，必须精确匹配 | 未设置 |
| `PI_WEB_PASSWORD` | 启用浏览器密码登录；API 客户端可使用用户名为 `pi` 的 Basic Auth | 不启用认证 |

例如：

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### 远程访问

监听非回环地址会暴露一个可执行高权限操作的智能体。在可信局域网中使用时，请设置足够长的随机密码：

```bash
PI_WEB_PASSWORD='足够长的随机密码' pi-web --hostname 0.0.0.0
```

密码认证不会加密连接。不要通过明文 HTTP 将 Pi Web 暴露到互联网；远程访问应使用可信反向代理提供 HTTPS，或通过可信 VPN。如果反向代理传递外部主机名，请把该名称精确加入 `PI_WEB_ALLOWED_HOSTS`。这个白名单不会改变 Pi Web 的监听地址。

### HTTP 代理

服务端的模型和 API 请求会读取标准的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY` 环境变量。

macOS 或 Linux（通过 [GitHub Release `.tgz` 安装包](https://github.com/koxircom/pi-web-plus/releases/download/v1.3.38/pi-web-plus-1.3.38.tgz)安装并启动）：

```bash
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.38/pi-web-plus-1.3.38.tgz
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
pi-web
```

Windows PowerShell：

```powershell
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.38/pi-web-plus-1.3.38.tgz
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
pi-web
```

## 注意事项

- **智能体数据**：Pi Web 默认读取 `~/.pi/agent` 下的 pi 数据，包括 `sessions/<编码后的工作目录>/<时间戳>_<uuid>.jsonl` 中的会话文件。可通过 `PI_CODING_AGENT_DIR` 指定其他 pi agent 目录。
- **文件系统访问**：Pi Web 必须能读取智能体数据目录及会话记录中的工作目录。与现有 pi 会话共用数据时，请让 Pi Web 运行在与 pi 相同的文件系统环境中。
- **共享配置**：模型面板使用 pi 的模型、设置和凭据存储，因此两种界面都能看到相关更改。
- **文件访问边界**：文件浏览器仅能访问在 Pi Web 中选择过的工作目录，以及它已识别的项目或会话根目录；它不是通用的文件系统浏览器。
- **Git worktree**：切换器何时显示、如何创建 worktree，以及删除会产生什么影响，见 [Pi Web 里的 Worktree](./docs/worktrees.zh-CN.md)。

## 开发

```bash
npm install
npm run dev
```

开发服务器运行在 [http://127.0.0.1:30141](http://127.0.0.1:30141)。常用检查命令：

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

日常开发时不要运行 `next build` 或 `npm run build`。它们会写入 `.next/`，可能干扰开发服务器；仅在发布流程中执行构建。

贡献者文档：[国际化](./docs/i18n.md)和[发布流程](./docs/release.md)。

## 仓库结构

```text
app/             Next.js 界面和 API 路由
components/      React 界面组件
hooks/           客户端状态和交互 hooks
lib/             会话、智能体、模型、文件、Git 和安全逻辑
public/          静态资源和 PWA 文件
bin/             npm CLI 入口及启动参数解析
docs/            面向用户和贡献者的专题文档
demo/            发布到 GitHub Pages 的静态演示站（见 demo/README.md）
```

架构说明和详细文件地图见 [AGENTS.md](./AGENTS.md)。

## 许可证

[MIT](./LICENSE)
