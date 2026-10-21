# Agent Web Plus 1.4.10

本版聚焦产品品牌与安装包命名收敛，明确产品层次架构，并同步更新离线状态页、各语言文档与兼容边界。

## 品牌层次架构

- **统一总品牌**：**Agent Web Plus** 作为整体产品的总名称，涵盖 **Pi Web Plus** 与 **Codex Web Plus** 两个引擎入口。
- **共享统一工作台**：**Pi Web Plus** 为 Pi Agent 的浏览器入口，**Codex Web Plus** 为 Codex CLI 的浏览器入口。两者共享同一个网页前端与后端服务，无需分别安装。
- **界面菜单实际选项**：左上角引擎切换菜单实际显示项维持为 **Pi Agent** 与 **Codex**，平滑贴合日常使用习惯。

## 安装包规范与下载

- **规范安装包命名**：从 1.4.10 起，官方 Release 规范安装包统一采用 `agent-web-plus-<版本>.tgz`（例如 `agent-web-plus-1.4.10.tgz`）。
- **历史资产与兼容保留**：既有 Release 中的历史包下载链接完整保留供版本追溯；npm 内部包名、启动命令 `agent-web` 及兼容别名 `pi-web`、默认数据目录与浏览器存储完全兼容，支持原位平滑升级。

## 离线页面与文档更新

- **离线页面字标升级**：离线状态页标题与矢量字标统一对齐 Agent Web Plus，提供清晰的断网与离线状态指示。
- **各语言文档同步**：同步更新中文、日文、俄文等多份 README，准确介绍双引擎工作台架构，统一安装示例为新规范安装包。

## 安装与升级

```bash
npm install -g https://github.com/koxircom/agent-web-plus/releases/download/v1.4.10/agent-web-plus-1.4.10.tgz
agent-web --no-open
```

升级前请停止当前运行的服务进程；既有会话、模型配置、用量账本与置顶均原位保留。
