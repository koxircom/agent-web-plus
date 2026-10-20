# Agent Web Plus

**在电脑和手机的同一个网页工作台，使用 Pi Agent 与 Codex。**

Agent Web Plus 原名 **Pi Web Plus**。现在它支持两种执行引擎：Pi Agent 在 Web 服务所在环境运行；Codex 通过项目内置执行端连接你自己的 Codex CLI。两种引擎共用聊天、输入框、会话导航与设置界面，切换时保留各自的会话和工作目录。

手机是同一后台的访问入口。将 Web 服务部署在自己的电脑、WSL 或服务器后，可以在另一台设备上继续查看同一会话、跟踪执行过程、发送后续消息。

[下载安装包](https://github.com/koxircom/agent-web-plus/releases/latest) · [Codex 配置](docs/codex-engine.md) · [旧用户升级](docs/agent-web-compatibility.md) · [反馈问题](https://github.com/koxircom/agent-web-plus/issues)

## 视频介绍

点击下方播放器，即可在当前页面观看完整介绍，无需下载。

https://github.com/user-attachments/assets/e9a60ee1-a29c-447c-8a8f-9ac49dc8a0ca

介绍 Pi Web Plus 更名、Pi Agent / Codex Agent 切换、电脑与手机接续会话，以及 Codex 的连接配置。包含中文解说、中文字幕和真实界面演示，时长 2分03秒。

[可选：保存 MP4 到手机（1080p · 约8.8MB）](https://github.com/koxircom/agent-web-plus/releases/download/v1.4.2/Agent-Web-Plus-Introduction-1080p.mp4)

## 在 Pi Agent 与 Codex Agent 之间切换

**左上角的 Agent 名称就是切换入口。** 点击名称旁的下拉箭头，在 **Pi Agent** 与 **Codex** 之间选择；界面中的「Codex」就是本文所说的 Codex Agent。手机和电脑使用同一个入口。

### 第一次启用 Codex

1. 在执行主机准备自己的 **Codex CLI**、登录状态和工作区，并启动本项目附带的 Codex 执行端。执行端通常运行在 Linux / WSL，需要 Python 3.11+，不强制使用 Docker。
2. 打开 **设置 → 执行引擎**，启用 **Codex**，填写 Web 服务端可访问的执行端地址。只有执行端启用了密码认证时才填写对应账号和密码。
3. 点击 **保存设置**，再点击 **检测已保存配置**，确认连接和工作区可用。
4. 回到左上角，点击 **Pi Agent ▾ → Codex**，选择工作目录，打开已有 Codex 会话，或点击 **＋** 新建 Codex 会话。
5. 要继续使用 Pi，点击 **Codex ▾ → Pi Agent**。Pi 的模型仍在 **设置 → 模型** 中配置，Codex 使用执行主机自己的 CLI 登录及模型配置。

Codex 未启用时，下拉菜单中的 Codex 选项不可选。开启开关本身不会安装 CLI 或启动执行端，完整步骤见 [Codex 安装与连接](docs/codex-engine.md)。

### 切换后，哪些内容会跟着变化

| 项目 | Pi Agent | Codex Agent |
| --- | --- | --- |
| 会话列表 | Pi 的本机会话 | Codex 执行端允许访问的原生会话 |
| 工作目录 | Web 服务所在环境的目录 | Codex 执行主机上的工作区目录 |
| 新建会话 | 「＋」创建 Pi 会话 | 「＋」创建 Codex 会话 |
| 模型与登录 | Pi 的模型提供方、凭据与配置 | Codex CLI 自己的登录、模型与思考深度 |
| 执行能力 | Pi 工具、扩展、技能等能力 | 执行端声明支持的 Codex 原生能力 |

聊天布局、输入框、图片编辑、会话导航和设置仍使用同一套前端。两种引擎各自保留会话归属和工作目录；切换不会把 Pi 会话转换成 Codex 会话，也不会停止原来在后台运行的任务。新建会话使用当前选中的 Agent。

## Codex Agent 可以做什么

- **继续原生会话**：查看 Codex 工作区、会话历史、模型回复和工具执行过程，发送文本、图片和文件附件；长会话可通过轮次导航定位。
- **排队与引导**：给运行中的任务添加普通后续消息，查看或调整队列，取回、删除条目，或将排队内容引导到当前任务。断线后从后台核对状态与交接记录。
- **目标与计划**：使用 Codex 原生目标和计划模式，目标摘要持续显示在输入框上方。发送成功后，下一条输入回到普通模式；已有目标继续按原生状态显示。
- **上下文与用量**：查看上下文占用和 Token 消耗；在用量统计中选择 **Pi Agent / Codex / 全部**，并展开子任务名称、日期与消耗。Codex 未提供费用时明确显示不可得。
- **电脑、手机接续**：访问同一个 Web 后台即可查看同一会话。浏览器关闭或临时断网不代表 Codex 任务结束，重连后读取后台状态。
- **辨认 CLI 版本**：分别显示已安装版本与运行中版本。管理员启用运行时更新后，在满足空闲条件时切换进程。

### 与 Codex 桌面端共享历史和队列

需要将执行端的 `historyHome`、`historySocket` 配置到桌面端使用的同一个原生运行时，且 CLI 支持相应队列接口。配置完成后，网页与桌面接续同一会话，**普通消息共用 Codex 原生队列**。独立运行时之间不会自动共享；只填写服务地址也不会自动找到任意电脑上的桌面会话。

计划/目标模式暂不能逐条保存在原生队列中，因此任务忙碌时，此类输入留在草稿，提示空闲后发送。队列交接由后台保存原文、附件和请求标识，并核对回执；结果不明时不盲目重发，也不承诺任何故障下都恰好执行一次。

Codex 尚未对接 Pi 专用分支、工具预设、手动压缩、终端、HTML 导出及会话删除；相应入口按引擎能力显示。具体部署和能力范围见 [Codex 配置说明](docs/codex-engine.md)。

## 两种 Agent 共用的工作台功能

| 场景 | 当前能力 |
| --- | --- |
| 两种 Agent，一个工作台 | 左上角切换 Pi Agent / Codex；公共界面与交互统一维护，执行能力按引擎显示。 |
| 管理长期任务 | 工作目录分组、会话置顶、归档、彩色标签、正文搜索及长会话轮次导航。 |
| 在手机上继续工作 | 自适应聊天界面、触控图片编辑、文件附件、草稿与阅读位置恢复。 |
| 排队和补充消息 | 查看后台队列、取回或删除条目、向进行中的任务补充内容；重连后核对后台状态。 |
| 查看目标和计划 | Codex 支持原生目标状态与计划模式；已有目标显示在输入框上方。 |
| 看清上下文与用量 | 顶栏显示上下文和 Token；用量统计可按 Pi、Codex 或全部筛选，并展开子任务明细。 |
| 区分 CLI 版本 | 分别显示已安装与运行中版本；启用运行时更新后，在满足空闲条件时切换进程。 |
| 复用项目经验 | 内置自动复盘与经验检索，技能候选经确认后采用，见 [自动复盘](docs/automatic-learning.md)。 |
| 接续原有数据 | 兼容旧命令、配置目录、会话、置顶与设置；改名无需重新建立历史。 |

## 安装与启动

项目显示名为 Agent Web Plus，GitHub 仓库名已同步为 `koxircom/agent-web-plus`。本文介绍面向 **1.4.0**（Pi SDK **1.3.0**）。需要 Node.js **22.19.0 或更新版本**，推荐 Node.js 24 LTS。

> 本页介绍 **1.4.0 双引擎功能**，旧版 Pi Web Plus 不包含全部 Codex 能力。请从本仓库正式 Releases 下载对应版本，并保留原数据目录；实际可用安装包以 Releases 页面为准。

```bash
npm install -g https://github.com/koxircom/agent-web-plus/releases/download/v1.4.0/pi-web-plus-1.4.0.tgz
agent-web --no-open
```

也可下载源码 ZIP 后解压构建，或使用 Git：

```bash
git clone https://github.com/koxircom/agent-web-plus.git agent-web-plus
cd agent-web-plus
npm ci
npm run build
node bin/agent-web.js
```

服务默认只监听 `127.0.0.1:30141`。浏览器没有自动打开时，访问 [本机工作台](http://127.0.0.1:30141)。运行源码无需全局安装其他 Pi Web 包。

正式构建包与 SHA256 校验文件在 [GitHub Releases](https://github.com/koxircom/agent-web-plus/releases/latest)。仅从本仓库正式发布的构建包安装；不要把 npm 上的上游 `@agegr/pi-web` 当作本项目的新版本。

### 仅使用 Pi Agent

打开「设置 → 模型」添加自己的模型凭据或登录提供方，然后在左上角选择 **Pi Agent**。已有 Pi 用户保持原来的数据目录即可，默认读取 `~/.pi/agent`。

### 启用 Codex Agent

安装 Web 后，按上方 [第一次启用 Codex](#第一次启用-codex) 完成执行端配置，再从左上角切换。执行端随本项目提供，仍需要用户自己的 Codex CLI 和登录状态。详细配置见 [Codex 安装与连接](docs/codex-engine.md)。

## 原用户升级：数据与命令兼容

- 推荐命令为 `agent-web`，原 `pi-web` 继续可用；源码直接启动可用 `node bin/agent-web.js` 或 `node bin/pi-web.js`。
- 默认数据目录继续是 `~/.pi/agent`，原 `PI_CODING_AGENT_DIR` 与 `PI_WEB_*` 配置继续有效。
- 新别名 `AGENT_WEB_DATA_DIR` 可以指向原数据目录。两个目录变量同时存在时必须指向同一目录，冲突时拒绝启动，不自动搬移或合并数据。
- 会话身份、置顶、设置、Cookie、localStorage 和 IndexedDB 的兼容键保留。保持原主机和端口，浏览器仍能找到原草稿与偏好。
- npm 包内部标识暂保留 `@agegr/pi-web`，以便既有构建包原位升级；项目品牌与源码仓库由本项目独立维护。不要同时安装另一份上游包覆盖它。

完整说明见 [改名兼容与数据接续](docs/agent-web-compatibility.md)。升级前停止旧进程，备份原数据目录；升级后继续使用同一目录，不需要清空历史或重新建立置顶。

## 局域网访问

如需让手机访问，使用自己的主机局域网地址，并设置访问密码：

```bash
# 将示例密码替换为自己的长随机密码，不要提交到仓库。
PI_WEB_PASSWORD='replace-with-your-own-long-random-password' \
node bin/agent-web.js --hostname 0.0.0.0 --no-open
```

Windows PowerShell：

```powershell
$env:PI_WEB_PASSWORD = "replace-with-your-own-long-random-password"
node bin/agent-web.js --hostname 0.0.0.0 --no-open
```

手机访问 `http://你的主机地址:30141`。公网访问应使用 HTTPS 反向代理或可信 VPN；配置外部域名时，将准确域名加入 `PI_WEB_ALLOWED_HOSTS`。模型请求可使用标准 `HTTP_PROXY`、`HTTPS_PROXY` 与 `NO_PROXY`。

`node bin/agent-web.js --help` 可查看端口和监听选项。原环境变量不因改名改变。

## 部署边界

公开源码不包含个人会话、账号、私有主机清单或特定设备重启脚本。同一后台的会话和置顶通过原生状态接口共享；跨不同独立服务器的软件分发、重启和回滚，需要部署者自己的管理方式，项目不自动探测私人设备。

`demo/mock/captured/` 目录名仅为保留导入兼容，其中的配置为界面夹具，不包含登录令牌。`docs/screenshots/` 为历史名称下的合成演示图，不作为当前版本的功能验收。

## 开发与检查

```bash
npm ci
npm run dev
# 类型检查
npx tsc --noEmit
# 发布前脱敏检查
python3 scripts/check-publication.py --root .
```

不要在运行同一 checkout 的开发服务时执行 `next build`。执行引擎和数据迁移的检查应使用隔离目录，不要在真实用户会话中创建测试消息。

## 开源与署名

本项目基于 [agegr/pi-web](https://github.com/agegr/pi-web) 持续维护，使用 [Pi Coding Agent](https://github.com/earendil-works/pi) 与可选的 [Codex CLI](https://github.com/openai/codex)。保留原作者版权与 MIT 许可证；依赖和连接器来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
