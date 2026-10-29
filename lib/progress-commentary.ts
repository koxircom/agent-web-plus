import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const PROGRESS_COMMENTARY_GUIDANCE = `[Pi Web progress communication / 关键步骤进展前置提示与 Steering 引导规范 (Codex 范式)]
执行非简单单步任务或多步工具调用时，必须严格遵循以下前台沟通规则（完全对齐 Codex 行为），方便用户实时掌握进展并随时进行 Steering 转向引导：

1. 【调用工具前必须发言 (Start with an update before tools)】：
   - 凡是用户请求需要调用工具，在发起第一个工具调用前，必须先在正文中输出 1~2 句公开简明的文字，告知用户确认了什么、将要执行的具体里程碑是什么；
   - 严禁在调用第一个工具前一言不发直接盲跑！

2. 【关键里程碑转换必须发言 (Share updates at milestone transitions)】：
   - 每完成一组关键操作（如：定位出根因准备修改、修改完毕准备运行测试、单测通过准备构建部署等阶段节点），在发起下一批工具调用前，必须输出 1~2 句阶段更新（说明当前发现是什么、下一步具体要做什么）；
   - 严禁在多步工具调用之间长时间保持无声沉默；严禁让用户连续面对多个空白工具折叠条！

3. 【必须作为普通公开正文输出 (Ordinary Public Text Only)】：
   - 所有中间进展说明必须作为公开的 Assistant 消息直接发送到对话流中，绝不能仅写在 Thinking/Reasoning 思考块中！

4. 【聚焦关键里程碑，严禁琐碎报菜名 (Milestone-level, Not a Tool Log)】：
   - 一般是关键的一些步骤说下，而不是每一个工具调用都说明！属于同一子目标的连续只读检查、搜索或短命令归为一个整体阶段，严禁对每一次具体工具调用都发一条播报，避免刷屏干扰用户；
   - 示例：
     - 开场：“我先检查侧边栏事件绑定与状态管理，定位未识别多选的原因。”
     - 转换：“已查明根因：状态版本在切换时被误淘汰；接下来修改 04 模块中的右键菜单逻辑，并重新构建验证。”

## Intermediate commentary (Codex alignment)
As you work, you MUST share concise, meaningful updates in the conversation before calling tools and between major phases.
If the user's request requires calling tools, start with a message in public assistant text before the first tool call. The user appreciates concise, verifiable milestone updates to steer ongoing work.`;

/** Append once to the SDK's current prompt; retain project/user/extension instructions. */
export function withProgressCommentary(systemPrompt: string): string {
  return systemPrompt.includes("[Pi Web progress communication")
    ? systemPrompt
    : `${systemPrompt}\n\n${PROGRESS_COMMENTARY_GUIDANCE}`;
}

export function createProgressCommentaryExtension(): InlineExtension {
  return {
    name: "pi-web-progress-commentary",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => ({ systemPrompt: withProgressCommentary(event.systemPrompt) }));
    },
  };
}
