# Agent Web Plus 1.4.12

本版聚焦 Codex Desktop 原生状态双向同步、真实交互时间归一、用户消息前分支防护、Pi 会话分支用量继承防重及删除 lookup 守卫修复。

## 核心改进

- **Codex Desktop 原生状态双向同步**：
  - 仅对具备原生等价状态的操作（置顶 Pin/Unpin、归档 Archive/Unarchive、会话重命名、会话删除）与 Codex Desktop 原生存储共享。
  - 标签与颜色等展示型功能作为 Web 专属偏好独立存储，不强行向 Desktop 反向回写或伪造同步能力。
- **真实交互时间与日期归一**：
  - 会话排序与展示时间严格基于真实对话交互时间戳推导，避免仅修改标题或元数据导致日期虚假跃迁。
  - 缺失时间戳时平稳降级，严禁以当前客户端时间伪造历史记录。
- **用户消息前分支保护**：
  - 遵循 Codex 原生分支语义，仅首条可分支用户提问暴露“新会话”操作，中途注入或不可分支消息严格隐藏分支入口。
  - 分支触发携带稳定客户端请求标识并精确回传新会话 ID。
- **Pi 分支用量隔离与删除入账守卫**：
  - 引入 `fork-provenance` 继承机制，分支会话历史继承消息用量不重复计入新增账本；历史 legacy 账本保持只读，不进行任何自动重写。
  - 修复 `GET /api/sessions/[id]?lookup=1` 会话删除前入账守卫能力证明，杜绝删除过程中的并发 409 误拦截。
- **真实浏览器与多设备拓扑防护**：
  - 桌面（1280px）与移动端（390px）完成上下文菜单、置顶、归档与错误恢复验证，严格断言列表项无几何重叠（verticalDelta >= 0）。

## 安装与升级

```bash
npm install -g https://github.com/koxircom/agent-web-plus/releases/download/v1.4.12/agent-web-plus-1.4.12.tgz
agent-web --no-open
```
