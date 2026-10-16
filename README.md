> **PI Web Plus v1.3.39** 基于 Pi Coding Agent 1.0.4。通过 [GitHub Releases](https://github.com/koxircom/pi-web-plus/releases/tag/v1.3.39) 安装预构建包；本地服务默认只监听 `127.0.0.1`。

> 1.3.39：移除侧边栏重复的文字状态标签和旧资源，补充脱敏实景图；包含截至 1.3.37 的改进，基于 Pi Coding Agent 1.0.4。

# PI Web Plus

[简体中文说明](./README.zh-CN.md) | [日本語](./README.ja.md) | [Русский](./README.ru.md)

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

## Quick Start

PI Web Plus requires Node.js 22.19.0 or newer (`node >=22.19`). Check your version with `node --version`, then install the prebuilt release tarball from [`koxircom/pi-web-plus` GitHub Releases](https://github.com/koxircom/pi-web-plus/releases) and start `pi-web`:

```bash
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.39/pi-web-plus-1.3.39.tgz
pi-web
```

> **Important**: The package name in `package.json` remains `@agegr/pi-web` for compatibility, but PI Web Plus is distributed exclusively through [`koxircom/pi-web-plus` GitHub Releases](https://github.com/koxircom/pi-web-plus/releases). Do **not** pull or install `@agegr/pi-web` from the public npm registry; that is the legacy upstream package, not the PI Web Plus release.

The CLI opens a browser after the server is ready. If it does not, open [http://127.0.0.1:30141](http://127.0.0.1:30141). Pi Web listens only on `127.0.0.1` by default.

If no model provider is configured yet, open the **Models** panel to sign in or add an API key.

The command above installs v1.3.39. To install or upgrade to another release, stop the running process with `Ctrl+C`, replace `v1.3.39` and `1.3.39` in the URL with the target `<version>` from [GitHub Releases](https://github.com/koxircom/pi-web-plus/releases), and run the install command again:

```bash
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v<version>/pi-web-plus-<version>.tgz
```

To uninstall, run `npm uninstall -g @agegr/pi-web`.

## Configuration

For port and hostname, command-line options override the corresponding environment variables. Either `--no-open` or `PI_WEB_NO_OPEN=1` disables automatic browser opening. Run `pi-web --help` (or `-h`) to print startup options and exit without starting the server. Unknown options exit with an error.

| Option or environment variable | Purpose | Default |
| --- | --- | --- |
| `--help`, `-h` | Print startup options and exit | — |
| `--port <port>`, `-p <port>`, or `PORT` | Server port | `30141` |
| `--hostname <host>`, `-H <host>`, or `PI_WEB_HOSTNAME` | Bind hostname | `127.0.0.1` |
| `--no-open` or `PI_WEB_NO_OPEN=1` | Do not open a browser automatically | Browser opens |
| `PI_WEB_SKIP_VERSION_CHECK=1` | Disable Pi Web update checks | Unset |
| `PI_WEB_ALLOWED_HOSTS` | Additional exact proxy or custom hostnames, comma-separated | Unset |
| `PI_WEB_PASSWORD` | Enable browser password login; API clients may use Basic Auth with username `pi` | Authentication disabled |
| `PI_WEB_IDLE_TIMEOUT_MS` | Session idle timeout in milliseconds, up to `2147483647`; `0` disables idle shutdown; invalid or out-of-range values use the default | `600000` (10 min) |

For example:

```bash
pi-web --help
pi-web -p 8080 -H 0.0.0.0 --no-open
```

### Remote Access

Binding to a non-loopback address exposes an agent that can execute high-privilege actions. On a trusted LAN, require a long random password:

```bash
PI_WEB_PASSWORD='a-long-random-password' pi-web --hostname 0.0.0.0
```

Password authentication does not encrypt the connection. Do not expose Pi Web over plain HTTP to the internet; use HTTPS through a trusted reverse proxy or a trusted VPN. If a reverse proxy sends an external hostname, add that exact name to `PI_WEB_ALLOWED_HOSTS`. This allow-list does not change the address Pi Web binds to.

### HTTP Proxy

Server-side model and API requests honor the standard `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` environment variables.

On macOS or Linux (after installing the [GitHub Release tarball](https://github.com/koxircom/pi-web-plus/releases/download/v1.3.39/pi-web-plus-1.3.39.tgz)):

```bash
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.39/pi-web-plus-1.3.39.tgz
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
pi-web
```

On Windows PowerShell:

```powershell
npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.39/pi-web-plus-1.3.39.tgz
$env:HTTP_PROXY = "http://127.0.0.1:7890"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
pi-web
```

## Notes

- **Agent data**: Pi Web reads pi data from `~/.pi/agent` by default, including session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`. Set `PI_CODING_AGENT_DIR` to use another pi agent directory.
- **Filesystem access**: Pi Web must be able to read the agent data directory and the working directories recorded by its sessions. Run Pi Web in the same filesystem environment as pi when sharing existing sessions.
- **Shared configuration**: the Models panel uses pi's model, settings, and credential storage, so changes are visible to both interfaces.
- **File access boundary**: the file browser is limited to working directories selected in Pi Web and project or session roots it already knows about; it is not a general filesystem browser.
- **Git worktrees**: see [Worktrees in Pi Web](./docs/worktrees.md) for switcher visibility, worktree creation, and removal behavior.

### Downstream Session Context Menu

Electron wrappers and other downstream integrations can provide a session-row
context menu without patching `SessionSidebar`. Listen for the cancelable
`pi-web:session-row-contextmenu` browser event and call `preventDefault()`
synchronously when the integration will handle it:

```js
window.addEventListener("pi-web:session-row-contextmenu", (event) => {
  event.preventDefault();
  const { id, path, cwd, name, clientX, clientY, refresh } = event.detail;

  void openSessionMenu({ id, path, cwd, name, clientX, clientY }).then((changed) => {
    if (changed) refresh();
  });
});
```

The detail object contains `id`, `path`, `cwd`, optional `name`, pointer
coordinates, and a `refresh()` callback for actions that change the session
list. If no listener cancels the extension event, Pi Web preserves the
browser's native context menu. This hook is browser-side and independent of
Pi agent extensions.

### Extension Session Liveness

Server-side Pi extensions with detached work can prevent automatic idle
session eviction through the versioned global registry:

```js
const liveness = globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")];
const release = liveness?.version === 1
  ? liveness.register({
      name: "my-extension",
      sessionId,
      sessionFile: sessionFile || undefined,
      isActive: () => detachedJobs.size > 0,
    })
  : () => {};
```

Register once per active extension session and call the returned idempotent
`release` function on session shutdown, replacement, or reload. `isActive`
must be synchronous, cheap, and scoped to the supplied exact session id or
file. Provider errors fail safe by preserving that session. This lease only
affects automatic idle eviction; explicit shutdown and Stop fallback cleanup
still take precedence.

## Development

```bash
npm install
npm run dev
```

The development server runs at [http://127.0.0.1:30141](http://127.0.0.1:30141). Run the common checks with:

```bash
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Do not run `next build` or `npm run build` during normal development. It writes to `.next/` and can interfere with the development server; leave builds for release work.

Contributor guides: [Internationalization](./docs/i18n.md) and [Release process](./docs/release.md).

## Repository Layout

```text
app/             Next.js UI and API routes
components/      React UI components
hooks/           Client state and interaction hooks
lib/             Session, agent, model, file, Git, and security logic
public/          Static assets and PWA files
bin/             npm CLI entrypoint and launch option parsing
docs/            Focused user and contributor guides
demo/            Static browser demo published to GitHub Pages (see demo/README.md)
```

See [AGENTS.md](./AGENTS.md) for the architecture notes and detailed file map.

## License

[MIT](./LICENSE)
