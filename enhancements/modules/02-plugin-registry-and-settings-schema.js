  // ==========================================
  // 0. Enhancement Plugins Registry (网页插件注册与管理)
  // ==========================================
  const ENHANCEMENT_PLUGINS = [
    {
      id: "stop-fast-response",
      name: "停止即时响应",
      desc: "消除停止与中断指令被后台 SSE 连接准备阻塞的延迟，直通发送 abort 请求，并提供正在停止即时反馈与网络去重。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "general-settings-dashboard",
      name: "常规设置双列布局与服务重启",
      desc: "将设置弹窗“常规”面板优化为现代双列卡片仪表盘布局，消除右侧大片空白，并在页面维护模块增加一键重启 Agent Web Plus 服务功能。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "model-generation-speed",
      name: "单步端到端 Token/s",
      desc: "模型运行时实时显示供应商输出 Token/s，单步结束后保留平均速度，并在会话数据落盘后锁定精确值。", 
      category: "运行监控",
      defaultEnabled: true,
    },
    {
      id: "turn-duration",
      name: "任务总耗时显示",
      desc: "任务完成后在消息底部显示精确的总耗时徽章（如 ⏱️ 3分29秒），鼠标悬浮或手机点击可查看排队、模型生成与工具调用的耗时拆解。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "turn-number-indicator",
      name: "对话轮次序号",
      desc: "在每一轮用户消息下面的时间左边显示轮次序号（如 #1、#2），直观掌握对话轮次与上下文深度。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "task-tool-auto-collapse",
      name: "任务完成自动折叠工具过程",
      desc: "任务处理、等待模型及工具调用期间保持全部过程展开；仅任务完成后自动折叠本轮过程（bash、wiki 等）。最终答复保持可见，工具卡片仍可按需手动展开。", 
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "tool-card-layout-stability",
      name: "工具卡片布局稳定与全宽左对齐",
      desc: "限制所有会话中工具调用卡片在聊天列内伸缩与截断长路径，并在移动端与桌面端保持工具卡片及思考胶囊 100% 全宽撑满与文字左对齐，根除居中悬挂或向右阶梯式偏移。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "subagent-dispatch-cards",
      name: "子代理调度原生折叠卡片",
      desc: "隐藏旧式“调度子代理”正文播报，并在 Agent Web Plus 原生 subagent 折叠卡片中补充无图标模型名；保留原生耗时、展开箭头和交互。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "subagent-model-override",
      name: "子任务模型",
      desc: "统一设置所有子 Agent profile 使用的模型；单次 Agent 调用显式指定 model 时优先。",
      category: "偏好记忆",
      defaultEnabled: true,
    },
    {
      id: "history-scroll-stability",
      name: "历史滚动位置稳定",
      desc: "自动加载早期记录并保留阅读位置；打开已完成会话后若已在底部，后续正文、图片与缓存校验加载期间持续贴底，主动上滚立即停止；支持手机阻尼下拉、慢响应和超时重试提示。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "session-scroll-restore",
      name: "会话切换记忆阅读位置",
      desc: "按会话保存消息锚点与阅读偏移；返回时等待内容就绪并校正延迟布局，避免自动贴底覆盖位置，主动滚动即交还控制。",
      version: "2.0.1",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "session-virtual-scroll",
      name: "长会话视口虚拟化渲染",
      desc: "采用现代浏览器硬件级 content-visibility 视口虚拟化技术：自动跳过视口外历史消息的排版与代码高亮，将数百轮长会话的首次渲染与切换耗时降低90%以上，彻底根除CPU主线程卡顿。",
      category: "性能优化",
      defaultEnabled: true,
    },
    {
      id: "compaction-auto-collapse",
      name: "会话压缩摘要自动折叠",
      desc: "会话历史压缩（compaction）卡片默认自动收起大段长篇摘要，仅保留一行标题横条；点击顶部栏随时展开或重新收起。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "pi-mail-auto-collapse",
      name: "协作消息自动折叠",
      desc: "跨会话协作消息长卡片默认收起为单行亲民摘要，仅呈现「协作消息 · 已收到」并支持随时展开/收起及原文复制。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "live-stopwatch",
      name: "实时执行秒表",
      desc: "任务运行中在会话内显示执行时长；标签页标题由统一状态管理，避免计时前缀闪烁。", 
      category: "运行监控",
      defaultEnabled: true,
    },
    {
      id: "model-scope-warning",
      name: "隐藏模型范围警告",
      desc: "隐藏输入区的模型范围警告，并在模型菜单对应选项后显示黄色提示图标；关闭插件后恢复原生警告。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "quick-quote",
      name: "划选引用与注释",
      desc: "划选对话文本后可一键引用，或保存多条带可选评论的引用注释；输入框上方实时显示 x 条注释，并在发送时作为结构化上下文附带给 Agent。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "settings-tab-shortcuts",
      name: "设置选项卡快捷入口",
      desc: "双击设置弹窗的任意选项卡，可快速将其添加到侧边栏左下角的快捷入口；再次双击可取消。",
      category: "快捷操作",
      defaultEnabled: true,
    },
    {
      id: "context-menu",
      name: "会话列表右键快捷菜单",
      desc: "在左侧侧边栏会话列表上右键单击，弹出快捷菜单：复制会话 ID、文件路径、跨 Agent 接力提示词与工作目录。",
      category: "快捷操作",
      defaultEnabled: true,
    },
    {
      id: "thinking-persistence",
      name: "思考深度记忆与自动恢复",
      desc: "记住当前选择的思考等级（high/medium/low/max 等），切换会话或新建会话时自动保持你的偏好。",
      category: "偏好记忆",
      defaultEnabled: true,
    },
    {
      id: "enhancement-settings-archive",
      name: "浏览器增强偏好归档",
      desc: "在支持的独立存储模式下，将本浏览器的增强插件与模块设置按独立 ClientId 安全归档至后端，防止浏览器缓存清理丢失。",
      category: "偏好记忆",
      defaultEnabled: true,
    },
    {
      id: "chat-scrollbar",
      name: "对话区域原生滚动条",
      desc: "恢复并美化右侧对话内容的原生垂直滚动条，方便直观拖拽滑块与快速定位长会话。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "native-message-font",
      name: "助手正文原生字号",
      desc: "将助手 Markdown 正文恢复为 Agent Web Plus 原生 14px 排版；不改变消息底部的时间、Token 消耗和费用显示。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "turn-usage-total",
      name: "回合真实消耗与Token汇总",
      desc: "自动按回合（Turn）累加该轮任务中所有工具调用与模型交互产生的真实 Token 及总费用，纠正原生界面仅显示单步零头的缺陷，并支持鼠标悬浮查看明细对比。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "minimap-full-nav",
      name: "会话导航按需加载与全量序号",
      desc: "显示完整历史总轮数与绝对序号；支持按需向上加载更早历史、屏幕边缘点按/纵向拖拽快切及触屏右滑关闭；拖拽松手按最终触点落定，重新点击当前选中方块可收起导航。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "esc-guard",
      name: "ESC 键误触中止保护",
      desc: "拦截意外按下键盘 ESC 键中止正在执行的任务；任务终止仅响应页面上显式点击的“停止”按钮。",
      category: "安全防护",
      defaultEnabled: true,
    },
    {
      id: "mobile-enter-newline",
      name: "手机软键盘换行保护",
      desc: "在手机等移动设备上，软键盘点击“换行”仅插入新行而不发送消息；发送任务需显式点击屏幕上的“发送”或“引导”按钮；电脑桌面端保持原生回车发送体验。",
      category: "安全防护",
      defaultEnabled: true,
    },
    {
      id: "composer-clean-placeholder",
      name: "清空输入框提示词",
      desc: "清空主输入框中冗长繁杂的占位提示词（如‘输入 / 使用命令，输入 @ 查找文件’），去除折行干扰，优化中文字体呈现，保持输入框纯净极简。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "ask-user-web-native",
      name: "ask_user 网页原生选择器",
      desc: "原生稳定问答卡片：先选择、再确认，选项说明直接可读，背景与补充意见按需展开；关闭后使用终端兼容视图。", 
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "project-status-indicator",
      name: "跨项目会话状态提示",
      desc: "精简标签页标题，移除冗余 Agent Web Plus 标识与跳动的计时秒数。运行中以蓝色小球 🔵 纯净指示，需要确认 🟠、错误 🔴、已完成 🟢 显示状态文字与对应颜色小球；多标签页一目了然。", 
      category: "运行监控",
      defaultEnabled: true,
    },
    {
      id: "session-attention-sound",
      name: "审批专属提示音",
      desc: "待确认或输入时播放三声短音，区别于完成音；同一问题只响一次，遵守声音总开关。首次需点击页面激活，可在这里试听。",
      category: "运行监控",
      defaultEnabled: true,
    },
    {
      id: "session-attention-desktop",
      name: "桌面待处理提醒",
      desc: "依赖跨项目状态提示。需要确认或输入时发送系统通知，点击直达任务；仅手动授权后生效，不展示问题正文。浏览器关闭或休眠时不保证送达。",
      category: "运行监控",
      defaultEnabled: false,
    },
    {
      id: "ask-user-batch-prototype",
      name: "ask_user 四题批量原型",
      desc: "仅用于预览四题批量问答的自动下一题、上一题、复杂选项说明与汇总提交；不会向 Agent 提交任何答案。",
      category: "交互增强",
      defaultEnabled: false,
    },
    {
      id: "quick-action-buttons",
      name: "AI 快捷回复",
      desc: "每轮真正结束后独立分析下一步，将原生发送按钮变成“开始实施”等预设或动态动作；点击发送对应指令，手动输入时还原，不再唤醒主会话或新增按钮。",
      category: "快捷操作",
      defaultEnabled: false,
    },
    {
      id: "empty-send-continue",
      name: "空输入一键继续",
      desc: "已有会话空闲且输入框、图片、文件和引用均为空时启用原生发送按钮；电脑或手机点击后直接发送“继续”，便于快速恢复意外中断的任务。",
      category: "快捷操作",
      defaultEnabled: true,
    },
    {
      id: "scroll-to-bottom",
      name: "回到底部悬浮快捷按钮",
      desc: "向上浏览历史消息离开底部时，在输入框上方浮现类似 Codex 的向下箭头圆钮，点击一键平滑滚动到最新消息。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "local-path-launcher",
      name: "本地路径快捷唤起与直达",
      desc: "自动识别对话消息中的本地文件路径与 file:// 链接，在右侧快捷提供 📂 直接打开资源管理器与 📋 一键复制按钮。",
      category: "快捷操作",
      defaultEnabled: true,
    },
    {
      id: "session-history-integrity",
      name: "会话记录实时校验",
      desc: "严格模式：每次打开会话都强制向服务器等待完整重新拉取（会带来 1~2 秒读盘等待），若追求极速秒开建议保持关闭，由“会话双层秒开缓存”处理。",
      category: "安全防护",
      defaultEnabled: false,
    },
    {
      id: "session-history-order-guard",
      name: "会话消息防回退",
      desc: "防止慢速历史请求覆盖已到达的最新流式消息，自动对齐消息版本并覆盖乱序并发旧响应。",
      category: "安全防护",
      defaultEnabled: true,
    },
    {
      id: "session-memory-cache",
      name: "会话双层秒开缓存",
      desc: "最近已访问会话优先保留在当前标签页内存（默认50个，支持15~100自由调节），并持久保存会话快照；切换、刷新或手机标签页恢复时秒开缓存，空闲时静默校验，彻底消除切会话读盘等待。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "usage-cost-dashboard",
      name: "全局用量与成本大盘",
      desc: "展示 Usage 服务端快照、角色模型拆分与费用非账单（SDK 记录），快捷键 Alt+U 随时唤起并支持一键穿透直达会话。",
      category: "运行监控",
      defaultEnabled: true,
    },
    {
      id: "cross-device-session-sync",
      name: "跨端与多标签页会话秒级同步",
      desc: "利用 BroadcastChannel 共享通道与服务端 sessionListVersion 版本感知：同浏览器多标签页 0ms 瞬间广播，手机/电脑多端每2秒自动比对；某一端任务完成或会话更新后，所有在线设备无需切换会话即可实现无感静默实时同步更新。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "code-block-scan-guard",
      name: "代码块免扫描保护",
      desc: "为新增的 pre/code 代码块增量添加禁止翻译与拼写检查属性，减少第三方文本扫描干扰；关闭时恢复原始属性。",
      category: "性能优化",
      defaultEnabled: true,
    },
    {
      id: "session-pin-archive",
      name: "Codex 式会话置顶与归档",
      desc: "在会话悬浮的更多菜单中置顶、标为未读或归档；置顶会话支持服务端清单跨浏览器统一读取；归档会话从主列表隐藏，可在设置中统一还原或删除；在已归档会话中布置新任务时自动唤醒恢复至列表。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "session-section-headers",
      name: "会话置顶与最近分组标题",
      desc: "模仿 Codex 桌面端，在左侧栏存在置顶会话时分别展示 Pinned 与 Recents 视觉分组小标题，清晰区隔置顶与常规会话。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "session-model-label",
      name: "会话模型与思考深度",
      desc: "在会话列表中显示该会话当前活动分支的模型名与思考深度；悬浮可查看完整 Provider 信息。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "session-item-compact",
      name: "会话列表紧凑与排版自适应",
      desc: "优化会话列表在手机浏览器与窄屏侧边栏的排版：手机端精简掉排不下的“多少条消息”，时间与标签强制单行防折行撑高，模型名称支持自适应省略截断，彻底避免挤压导致标题丢失与文字竖排问题。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "session-color",
      name: "会话背景颜色",
      desc: "在会话右键菜单中用六种低饱和预设色标记会话；颜色仅保存于当前浏览器，可随时清除。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "session-tags",
      name: "会话彩色标签与多维管理",
      desc: "支持为会话打上多维彩色标签，快速归类与检索；标签颜色自动分配与固定，支持在右键菜单或设置中自由管理。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "session-odoo-addons",
      name: "Odoo 插件更新状态胶囊",
      desc: "在会话项下方展示该会话更新的 Odoo 插件圆角药丸标签（最新插件显示绿点与绿色边框、历史修改显示白点与白框，纯白文字、微光发光底纹，每行一个插件）。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "session-dblclick-rename",
      name: "双击编辑会话",
      desc: "双击左侧会话列表中的任意会话即可直接进入重命名编辑输入框，按 Enter 保存，按 Escape 取消；编辑状态自动隐藏模型徽标并优化输入框宽度。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "composer-draft-cache",
      name: "输入框草稿与图片本地记忆",
      desc: "按原生草稿 ID 隔离保存文字与图片，同一 ID 刷新后恢复；旧版缓存保留但不自动导入。原生 ID 改变时不猜测恢复。",
      category: "偏好记忆",
      defaultEnabled: true,
    },
    {
      id: "composer-file-paste",
      name: "输入框文件直接粘贴与拖放",
      desc: "支持添加、粘贴（Ctrl+V）或拖拽图片、视频与各类文件：以附件卡片显示原始文件名、类型与大小；支持视频在线播放预览，并在会话进行中与历史复盘时在用户气泡顶部呈现高颜值附件卡片，隔离上传至 .pi-uploads/<会话>，支持一键预览与下载。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "session-search-shortcut",
      name: "会话搜索 Ctrl+F 快捷键",
      desc: "按下 Ctrl+F (或 ⌘F) 快捷展开侧边栏会话搜索框并全选聚焦，再次按下或按 Esc 即可一键退出搜索；同时支持按 Esc 快捷关闭设置等模态弹窗。",
      category: "快捷操作",
      defaultEnabled: true,
    },
    {
      id: "session-search-project-folding",
      name: "会话搜索项目与归档折叠",
      desc: "默认优先呈现本项目的匹配会话；其他项目与已归档的匹配会话默认折叠收起，清晰呈现匹配总数徽章，支持一键点击展开/收起。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "mobile-swipe-drawer",
      name: "移动端手势滑出会话、导航与文件面板",
      desc: "在手机触摸屏上，向右滑动滑出打开会话列表面板，侧边栏打开时向左滑动收起；屏幕右边缘向左滑打开会话导航，会话导航打开时向右滑收起；文件面板打开时向右滑动收起文件面板（代码块与水平滚动区域优先内部滚动不冲突）。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "composer-image-zoom",
      name: "输入框图片放大与标注",
      desc: "点击输入框图片进入默认矩形标注；支持 Ctrl/Cmd+Z 30+ 次撤销，桌面滚轮与手机双指上下滑实时调节屏幕可见边框/画笔粗细。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "codex-composer-layout",
      name: "Cursor 风格紧凑输入框",
      desc: "编辑区与底栏统一网格，发送按键采用 Cursor 纯色圆形向上箭头 (↑)，模型居左、操作居右；停止按钮图标化，适配手机窄屏。", 
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "composer-model-reasoning-pill",
      name: "模型与思考一体胶囊",
      desc: "将底栏的模型名称、思考深度与下拉箭头整合为 Cursor/Codex 风格的连贯圆角立体胶囊，保留各自原生选择菜单与切换行为。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "running-model-switch",
      name: "任务运行中切换后续模型",
      desc: "任务执行期间保持模型选择器可用；切换后的模型由 Pi 原生 set_model 通道保存，并用于后续排队消息，不中断当前正在生成的回复。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "composer-queue-panel",
      name: "Cursor 风格外置消息队列",
      desc: "排队消息独立显示在输入框上方，每条末尾提供转为引导的箭头。单条操作需服务端原子队列接口；旧后端保持安全禁用，不会清空再重发。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "composer-format-toggle",
      name: "显示格式化切换按钮",
      desc: "默认隐藏底栏的格式化/纯文本按钮，仅在需要时开启；不影响 Markdown 粘贴渲染和 Ctrl/Cmd+M 快捷键。",
      category: "显示增强",
      defaultEnabled: false,
    },
    {
      id: "composer-compact-button",
      name: "显示压缩上下文按钮",
      desc: "控制输入框底栏是否显示“压缩上下文”快捷按钮；默认隐藏以保持底栏清爽，可在需要压缩大长文上下文时开启。",
      category: "显示增强",
      defaultEnabled: false,
    },
    {
      id: "composer-tool-preset",
      name: "显示工具预设选择按钮",
      desc: "控制输入框底栏是否显示工具预设（如 default）切换按钮；默认隐藏，可在需要切换内置工具集时开启。",
      category: "显示增强",
      defaultEnabled: false,
    },
    {
      id: "composer-markdown-format",
      name: "输入框粘贴保持格式与 Markdown 渲染",
      desc: "参考 Codex 体验：从其他位置复制富文本粘贴时无损保留粗体、行内代码、代码块与列表等格式并转为标准 Markdown；输入框内实时将 Markdown 语法渲染为带格式的内容显示，提升长文与提示词阅读舒适度，支持就地编辑与纯文本视图一键切换。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "composer-modes",
      name: "主输入框模式（目标/计划）",
      desc: "Codex 风格目标与计划模式切换，接通后端只读计划与目标注入扩展，提供专属加号菜单、底栏指示器与快捷键",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "at-mention-plugins",
      name: "@ 提及聚焦插件与目标",
      desc: "输入 @ 时优先唤起插件功能（如 Chrome use）、工作流目标与计划的快捷补全菜单，彻底停用无用的文件扫描。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "image-dblclick-preview",
      name: "图片双击弹窗预览",
      desc: "双击右侧文件预览、对话消息及页面中的任意图片，即可以全屏弹窗打开；支持滚轮缩放、拖拽平移、标注与全屏查看，复用图片查看器能力。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "session-panel-binding",
      name: "右侧面板会话绑定与状态记忆",
      desc: "右侧文件面板与当前会话深度绑定；切换会话时自动恢复该会话的面板开闭状态，避免上个会话打开的面板在其他会话中残留干扰。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "file-panel-overlay-guard",
      name: "右侧预览窗口防遮挡与层级守护",
      desc: "当打开右侧文件/预览窗口时，确保预览窗口位于最顶层，底部输入框与工具栏自动沉降在下层，彻底杜绝底部元素遮挡预览内容。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "client-crash-diagnostics",
      name: "客户端异常取证",
      desc: "只在本标签页保留最近 20 条异常堆栈，刷新后仍可导出；不上传内容、不拦截错误、不自动刷新。",
      category: "安全防护",
      defaultEnabled: true,
    },
    {
      id: "streaming-thinking-guard",
      name: "流式思考聚合与防刷屏守卫",
      desc: "借鉴 Codex CLI 单例思考模型：当模型深度推理产生大量细碎空思考块（如 💡...）时，自动将其聚合为一个动态单例指示器并折叠多余空节点，防止数千个空灯泡刷屏及移动端 DOM 爆炸卡顿。",
      category: "安全防护",
      defaultEnabled: true,
    },
    {
      id: "notification-center",
      name: "通知管理与历史",
      desc: "按通知来源和级别控制站内提示、提示音及桌面通知，并保留最近通知历史供随时查看。",
      category: "偏好记忆",
      defaultEnabled: true,
    },
    {
      id: "obsidian-markdown-viewer",
      name: "Obsidian 笔记与 Markdown 预览增强",
      desc: "打通群晖 NAS 与外部知识库路径读取权限，解决右侧面板 Access denied 问题；打开 Markdown 文件时默认呈现格式化预览，并提供便捷的源码/预览切换开关。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "excel-sheet-preview",
      name: "Excel 表格在线预览",
      desc: "在右侧文件面板中直接交互式预览 Excel（.xlsx / .xls / .csv）工作簿，支持多工作表标签切换、冻结表头、行列标尺与单元格搜索。",
      category: "显示增强",
      defaultEnabled: true,
    },
    {
      id: "workspace-picker-hover",
      name: "工作区菜单悬停高亮",
      desc: "为侧边栏工作区/项目下拉菜单中的所有选项（历史路径、使用默认目录、自定义路径）添加平滑悬停与点击交互反馈，防止视觉上产生卡顿感。",
      category: "交互增强",
      defaultEnabled: true,
    },
    {
      id: "session-batch-actions",
      name: "会话批量管理与删除",
      desc: "支持在左侧会话列表进行鼠标多选、Shift 范围连续选择、全选并一键批量彻底删除会话。",
      category: "快捷操作",
      defaultEnabled: true,
    },
    {
      id: "pi-agent-update-notice",
      name: "Pi Agent 更新提示",
      desc: "实时检测上游官方 Pi Coding Agent (https://github.com/earendil-works/pi) 的版本发布。当有新版本时，在新建会话页面与设置面板中以轻量徽章形式醒目提示，并提供直达 Release 链接。",
      category: "运行监控",
      defaultEnabled: true,
    },
    {
      id: "pi-web-plus-branding",
      name: "Agent Web Plus 品牌装饰",
      desc: "控制侧边栏与界面的附加紧凑头距、字体和间距等品牌装饰样式；原生「π+ Agent Web Plus」自有基础品牌标识始终保持生效。",
      version: "1.0.0",
      category: "显示增强",
      defaultEnabled: true,
    },
  ];

  const ENHANCEMENT_SUITE_VERSION = window.__PI_WEB_STANDALONE_VERSION__ || "1.0.5";
  const ENHANCEMENT_SETTINGS_SCHEMA_VERSION = 1;
  const ENHANCEMENT_SETTINGS_STORAGE_KEY = "pi-enh-settings-v1";
  const ENHANCEMENT_PLUGIN_SETTINGS = {
    "minimap-full-nav": {
      initialTurns: { type: "number", defaultValue: 5, min: 1, max: 50, legacyKey: "pi-enh-minimap-initial-turns" },
      stepTurns: { type: "number", defaultValue: 5, min: 1, max: 50, legacyKey: "pi-enh-minimap-step-turns" },
    },
    "session-pin-archive": {
      retentionDays: { type: "select", defaultValue: 60, options: [7, 30, 60, 90, 180, 0], legacyKey: "pi-enh-archive-retention-days" },
      autoRestoreOnPrompt: { type: "select", defaultValue: 1, options: [1, 0], legacyKey: "pi-enh-archive-auto-restore-on-prompt" },
    },
    "session-memory-cache": {
      maxSessions: { type: "range", defaultValue: 50, min: 15, max: 100, step: 5, legacyKey: "pi-enh-session-cache-max-sessions" },
      maxSessionsMobile: { type: "range", defaultValue: 15, min: 5, max: 30, step: 5, legacyKey: "pi-enh-session-cache-max-sessions-mobile" },
    },
    "mobile-swipe-drawer": {
      swipeDistance: { type: "range", defaultValue: 30, min: 10, max: 120, step: 5, legacyKey: "pi-enh-swipe-distance" },
    },
    "mobile-enter-newline": {
      deviceMode: { type: "select", defaultValue: "auto", options: ["auto", "desktop", "mobile"], legacyKey: "pi-enh-mobile-enter-device-mode" },
    },
  };
  const ENHANCEMENT_MODULES = [
    { id: "task-insights", name: "任务运行信息", desc: "集中管理任务耗时、速度和回合用量信息。", category: "运行监控", version: "1.0.0", defaultEnabled: true, features: ["model-generation-speed", "turn-duration", "turn-number-indicator", "live-stopwatch", "turn-usage-total", "usage-cost-dashboard", "pi-agent-update-notice"] },
    { id: "conversation-navigation", name: "对话阅读与导航", desc: "管理过程折叠、工具卡片布局、滚动稳定、会话导航和回到底部工具。", category: "交互增强", version: "1.0.0", defaultEnabled: true, features: ["task-tool-auto-collapse", "tool-card-layout-stability", "subagent-dispatch-cards", "history-scroll-stability", "session-scroll-restore", "session-virtual-scroll", "compaction-auto-collapse", "pi-mail-auto-collapse", "chat-scrollbar", "native-message-font", "minimap-full-nav", "scroll-to-bottom", "image-dblclick-preview"] },
    { id: "subagent-dispatch", name: "子 Agent 调度", desc: "管理全部子任务统一使用的服务端模型；实际模型由服务端动态读取。", category: "偏好记忆", version: "1.0.0", defaultEnabled: true, features: ["subagent-model-override"] },
    { id: "selection-context", name: "划选引用与上下文", desc: "管理文本划选引用、注释与发送上下文。", category: "交互增强", version: "1.0.0", defaultEnabled: true, features: ["quick-quote"] },
    { id: "session-sidebar", name: "会话列表增强", desc: "管理会话列表的快捷菜单、归档、标签、布局、颜色、快捷入口和搜索。", category: "交互增强", version: "1.0.0", defaultEnabled: true, features: ["context-menu", "session-pin-archive", "session-section-headers", "session-model-label", "session-item-compact", "session-color", "session-tags", "session-odoo-addons", "session-dblclick-rename", "session-search-shortcut", "session-search-project-folding", "session-batch-actions", "settings-tab-shortcuts", "mobile-swipe-drawer"] },
    { id: "composer-workflow", name: "输入与附件增强", desc: "管理编辑器快捷操作、草稿、附件和移动端输入保护。", category: "交互增强", version: "1.0.0", defaultEnabled: true, features: ["stop-fast-response", "quick-action-buttons", "empty-send-continue", "composer-draft-cache", "composer-file-paste", "composer-image-zoom", "mobile-enter-newline", "composer-clean-placeholder", "codex-composer-layout", "composer-model-reasoning-pill", "composer-queue-panel", "running-model-switch", "composer-markdown-format", "composer-format-toggle", "composer-compact-button", "composer-tool-preset", "composer-modes", "at-mention-plugins"] },
    { id: "ask-user-experience", name: "ask_user 交互", desc: "管理网页原生问答选择器与批量原型预览。", category: "交互增强", version: "1.1.1", defaultEnabled: true, features: ["ask-user-web-native", "ask-user-batch-prototype"] },
    { id: "background-attention", name: "后台会话提醒", desc: "管理跨项目状态、提示音与桌面通知。", category: "运行监控", version: "1.0.0", defaultEnabled: true, features: ["project-status-indicator", "session-attention-sound", "session-attention-desktop"] },
    { id: "notification-management", name: "通知管理", desc: "管理所有站内通知、网页操作提示、提示音与桌面提醒，并查看通知历史。", category: "偏好记忆", version: "1.0.0", defaultEnabled: true, features: ["notification-center"] },
    { id: "safety-performance", name: "安全与性能保护", desc: "管理误触保护、模型警告可见性和代码块扫描保护。", category: "安全防护", version: "1.0.0", defaultEnabled: true, features: ["model-scope-warning", "esc-guard", "code-block-scan-guard", "streaming-thinking-guard", "client-crash-diagnostics"] },
    { id: "local-workspace", name: "本地工作区工具", desc: "管理本地路径直达和会话缓存。", category: "快捷操作", version: "1.0.0", defaultEnabled: true, features: ["local-path-launcher", "obsidian-markdown-viewer", "excel-sheet-preview", "session-memory-cache", "session-history-integrity", "session-history-order-guard", "cross-device-session-sync", "session-panel-binding", "file-panel-overlay-guard", "general-settings-dashboard", "workspace-picker-hover", "pi-web-plus-branding"] },
    { id: "preference-memory", name: "偏好记忆", desc: "管理思考深度的跨会话记忆与浏览器增强设置归档。", category: "偏好记忆", version: "1.0.0", defaultEnabled: true, features: ["thinking-persistence", "enhancement-settings-archive"] },
  ];
  const ENHANCEMENT_MODULE_SETTINGS = {
    "safety-performance": [
      { kind: "action", action: "download-crash-diagnostics", label: "导出客户端异常记录（仅本地）" },
    ],
    "subagent-dispatch": [
      { kind: "subagent-model", featureId: "subagent-model-override", key: "subagentModel", label: "子任务模型", description: "覆盖 worker、scout 等所有 profile 自带的模型；单次 Agent 调用显式传入 model 时仍优先。" },
    ],
    "composer-workflow": [
      { kind: "setting", featureId: "mobile-enter-newline", key: "deviceMode", label: "回车设备模式" },
    ],
    "conversation-navigation": [
      { kind: "setting", featureId: "minimap-full-nav", key: "initialTurns", label: "初始显示", unit: "轮" },
      { kind: "setting", featureId: "minimap-full-nav", key: "stepTurns", label: "每次加载", unit: "轮" },
    ],
    "session-sidebar": [
      { kind: "setting", featureId: "session-pin-archive", key: "retentionDays", label: "归档保留期限", unit: "天" },
      { kind: "setting", featureId: "session-pin-archive", key: "autoRestoreOnPrompt", label: "新任务自动唤醒会话" },
      { kind: "setting", featureId: "mobile-swipe-drawer", key: "swipeDistance", label: "触发滑动距离", unit: "px" },
      { kind: "action", action: "sync-pinned-manifest", label: "重新读取统一置顶配置（自动刷新页面）" },
    ],
    "background-attention": [
      { kind: "action", action: "request-desktop-notification", label: "手动授权浏览器通知" },
    ],
    "local-workspace": [
      { kind: "setting", featureId: "session-memory-cache", key: "maxSessions", label: "内存缓存上限", unit: "个会话" },
      { kind: "action", action: "clear-session-cache", label: "清空会话缓存" },
    ],
  };
  for (const module of ENHANCEMENT_MODULES) module.settings = ENHANCEMENT_MODULE_SETTINGS[module.id] || [];
  let initialRawEnhancementStorage = null;
  let initialParsedEnhancementConfig = null;
  let hasStoredEnhancementConfigInitially = false;
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      initialRawEnhancementStorage = localStorage.getItem(ENHANCEMENT_SETTINGS_STORAGE_KEY);
      if (initialRawEnhancementStorage) {
        hasStoredEnhancementConfigInitially = true;
        try {
          initialParsedEnhancementConfig = JSON.parse(initialRawEnhancementStorage);
        } catch (e) {}
      }
    }
  } catch (e) {}

  let enhancementConfig = null;

  function readEnhancementStorage(key) {
    try {
      if (typeof localStorage !== "undefined") {
        if (typeof localStorage.getItem === "function") return localStorage.getItem(key);
        if (typeof localStorage === "object" && localStorage !== null && key in localStorage) return localStorage[key];
      }
      return null;
    } catch (e) { return null; }
  }

  function writeEnhancementConfig() {
    let prevRaw = null;
    try {
      if (typeof localStorage !== "undefined" && localStorage) {
        prevRaw = localStorage.getItem(ENHANCEMENT_SETTINGS_STORAGE_KEY);
      }
    } catch (e) {}

    try {
      localStorage.setItem(ENHANCEMENT_SETTINGS_STORAGE_KEY, JSON.stringify(enhancementConfig));
    } catch (e) {}

    const nextRaw = JSON.stringify(enhancementConfig);
    if (hasStoredEnhancementConfigInitially && prevRaw !== nextRaw) {
      if (typeof queuePreferencesSnapshotIfNeeded === "function") {
        queuePreferencesSnapshotIfNeeded();
      }
    }
  }

  function getPluginSettingDefinition(featureId, key) {
    return ENHANCEMENT_PLUGIN_SETTINGS[featureId]?.[key] || null;
  }

  function normalizePluginSetting(definition, value) {
    if (!definition) return undefined;
    if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return definition.defaultValue;
    if (definition.type === "number" || definition.type === "range") {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) return definition.defaultValue;
      const clamped = Math.min(definition.max, Math.max(definition.min, Math.round(numeric)));
      if (definition.step && definition.step > 1) {
        return Math.round(clamped / definition.step) * definition.step;
      }
      return clamped;
    }
    if (definition.type === "select") {
      const numeric = Number(value);
      return definition.options.includes(numeric) ? numeric : definition.defaultValue;
    }
    return value === undefined ? definition.defaultValue : value;
  }

  function createDefaultEnhancementConfig(includeLegacyPreferences) {
    const config = {
      schemaVersion: ENHANCEMENT_SETTINGS_SCHEMA_VERSION,
      suiteVersion: ENHANCEMENT_SUITE_VERSION,
      modules: {},
      features: {},
      settings: {},
    };
    for (const module of ENHANCEMENT_MODULES) {
      config.modules[module.id] = { enabled: module.defaultEnabled };
    }
    for (const plugin of ENHANCEMENT_PLUGINS) {
      const legacyValue = includeLegacyPreferences ? readEnhancementStorage(`pi-enh-plugin-${plugin.id}`) : null;
      config.features[plugin.id] = { enabled: legacyValue === null ? plugin.defaultEnabled : legacyValue === "true" };
    }
    for (const [featureId, definitions] of Object.entries(ENHANCEMENT_PLUGIN_SETTINGS)) {
      config.settings[featureId] = {};
      for (const [key, definition] of Object.entries(definitions)) {
        const legacyValue = includeLegacyPreferences && definition.legacyKey ? readEnhancementStorage(definition.legacyKey) : null;
        config.settings[featureId][key] = normalizePluginSetting(definition, legacyValue === null ? definition.defaultValue : legacyValue);
      }
    }
    return config;
  }

  function normalizeEnhancementConfig(raw) {
    const config = createDefaultEnhancementConfig(false);
    if (!raw || typeof raw !== "object") return config;

    // 保全异构/未知 schema 原始配置
    if (raw.schemaVersion !== ENHANCEMENT_SETTINGS_SCHEMA_VERSION) {
      config._unsupportedSchemaVersion = raw.schemaVersion;
      config._rawUnsupportedConfig = raw;
    }

    // 保全未知 modules
    if (raw.modules && typeof raw.modules === "object" && !Array.isArray(raw.modules)) {
      for (const [k, v] of Object.entries(raw.modules)) {
        if (!config.modules[k]) config.modules[k] = typeof v === "object" && v ? { ...v } : v;
      }
    }
    for (const module of ENHANCEMENT_MODULES) {
      const enabled = raw.modules?.[module.id]?.enabled;
      if (typeof enabled === "boolean") config.modules[module.id].enabled = enabled;
    }

    // 保全未知 features
    if (raw.features && typeof raw.features === "object" && !Array.isArray(raw.features)) {
      for (const [k, v] of Object.entries(raw.features)) {
        if (!config.features[k]) config.features[k] = typeof v === "object" && v ? { ...v } : v;
      }
    }
    for (const plugin of ENHANCEMENT_PLUGINS) {
      const enabled = raw.features?.[plugin.id]?.enabled;
      if (typeof enabled === "boolean") config.features[plugin.id].enabled = enabled;
    }

    // 保全未知 settings
    if (raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)) {
      for (const [featId, sMap] of Object.entries(raw.settings)) {
        if (!config.settings[featId]) {
          config.settings[featId] = typeof sMap === "object" && sMap ? { ...sMap } : sMap;
        } else if (typeof sMap === "object" && sMap && !Array.isArray(sMap)) {
          for (const [k, v] of Object.entries(sMap)) {
            if (config.settings[featId][k] === undefined) {
              config.settings[featId][k] = v;
            }
          }
        }
      }
    }
    for (const [featureId, definitions] of Object.entries(ENHANCEMENT_PLUGIN_SETTINGS)) {
      if (!config.settings[featureId]) config.settings[featureId] = {};
      for (const [key, definition] of Object.entries(definitions)) {
        config.settings[featureId][key] = normalizePluginSetting(definition, raw.settings?.[featureId]?.[key]);
      }
    }

    // 保全顶层未知属性
    for (const [k, v] of Object.entries(raw)) {
      if (!(k in config) && k !== "schemaVersion" && k !== "modules" && k !== "features" && k !== "settings") {
        config[k] = v;
      }
    }

    return config;
  }

  function getEnhancementConfig() {
    if (enhancementConfig) return enhancementConfig;
    const stored = readEnhancementStorage(ENHANCEMENT_SETTINGS_STORAGE_KEY);
    let parsed = null;
    if (stored) {
      hasStoredEnhancementConfigInitially = true;
      try { parsed = JSON.parse(stored); } catch (e) {}
    }
    if (parsed) {
      enhancementConfig = normalizeEnhancementConfig(parsed);
      // 只读获取已有配置时绝不自动 writeEnhancementConfig() 覆盖原始 storage，杜绝默默丢弃未知字段
    } else {
      // Reading defaults (or malformed saved JSON) must not overwrite user storage.
      enhancementConfig = createDefaultEnhancementConfig(true);
    }
    return enhancementConfig;
  }

  function getPluginSetting(featureId, key) {
    const definition = getPluginSettingDefinition(featureId, key);
    if (!definition) return undefined;
    return getEnhancementConfig().settings[featureId]?.[key] ?? definition.defaultValue;
  }

  function setPluginSetting(featureId, key, value) {
    const definition = getPluginSettingDefinition(featureId, key);
    if (!definition) return undefined;
    const normalized = normalizePluginSetting(definition, value);
    hasStoredEnhancementConfigInitially = true;
    const config = getEnhancementConfig();
    config.settings[featureId] ||= {};
    config.settings[featureId][key] = normalized;
    config.suiteVersion = ENHANCEMENT_SUITE_VERSION;
    if (definition.legacyKey) {
      try { localStorage.setItem(definition.legacyKey, String(normalized)); } catch (e) {}
    }
    writeEnhancementConfig();
    if (featureId === "minimap-full-nav") {
      if (key === "initialTurns") minimapHistoryDisplayState.clear();
      syncMinimapEnhancements();
    } else if (featureId === "session-memory-cache" && key === "maxSessions") {
      enforceSessionCacheLRU();
      if (canUsePersistentSessionCache()) void queuePersistentCacheTask(async () => {
        const cache = await window.caches.open(PERSISTENT_SESSION_CACHE_NAME);
        await enforcePersistentSessionLRU(cache);
      }).catch(() => {});
    }
    syncEnhancementPanelControls();
    return normalized;
  }

  function getEnhancementModule(moduleId) {
    return ENHANCEMENT_MODULES.find((module) => module.id === moduleId) || null;
  }

  function getModuleForPlugin(featureId) {
    return ENHANCEMENT_MODULES.find((module) => module.features.includes(featureId)) || null;
  }

  function isModuleEnabled(moduleId) {
    const module = getEnhancementModule(moduleId);
    if (!module) return true;
    const enabled = getEnhancementConfig().modules[moduleId]?.enabled;
    return typeof enabled === "boolean" ? enabled : module.defaultEnabled;
  }

  function setModuleEnabled(moduleId, enabled) {
    const module = getEnhancementModule(moduleId);
    if (!module) return;
    const previous = new Map(module.features.map(id => [id, isPluginEnabled(id)]));
    hasStoredEnhancementConfigInitially = true;
    const config = getEnhancementConfig();
    config.modules[moduleId] ||= {};
    config.modules[moduleId].enabled = Boolean(enabled);
    config.suiteVersion = ENHANCEMENT_SUITE_VERSION;
    writeEnhancementConfig();
    for (const featureId of module.features) {
      const next = isPluginEnabled(featureId);
      if (next !== previous.get(featureId)) onPluginStateChanged(featureId, next);
    }
    syncEnhancementPanelControls();
  }

  function isPluginSelected(id) {
    return getEnhancementConfig().features[id]?.enabled === true;
  }

  function getModuleState(moduleId) {
    const module = getEnhancementModule(moduleId);
    if (!module) return null;
    const selected = module.features.filter(isPluginSelected).length;
    const active = isModuleEnabled(moduleId) ? selected : 0;
    const total = module.features.length;
    const state = active === 0 ? "off" : active === total ? "on" : "partial";
    return { state, active, selected, total };
  }

  function toggleModuleFromPanel(moduleId) {
    const module = getEnhancementModule(moduleId);
    const state = getModuleState(moduleId);
    if (!module || !state) return;
    if (state.active > 0) { setModuleEnabled(moduleId, false); return; }
    // All children explicitly off: enable only safe defaults, never opt-in previews/permissions.
    if (state.selected === 0) {
      for (const id of module.features) {
        const plugin = ENHANCEMENT_PLUGINS.find(p => p.id === id);
        if (plugin?.defaultEnabled) setPluginEnabled(id, true);
      }
    }
    setModuleEnabled(moduleId, true);
  }

  function resetEnhancementSettings() {
    hasStoredEnhancementConfigInitially = true;
    const previous = new Map(ENHANCEMENT_PLUGINS.map(p => [p.id, isPluginEnabled(p.id)]));
    const defaults = createDefaultEnhancementConfig(false);
    Object.assign(getEnhancementConfig(), defaults);
    writeEnhancementConfig();
    for (const plugin of ENHANCEMENT_PLUGINS) {
      try { localStorage.setItem(`pi-enh-plugin-${plugin.id}`, String(plugin.defaultEnabled)); } catch (e) {}
      const next = isPluginEnabled(plugin.id);
      if (next !== previous.get(plugin.id)) onPluginStateChanged(plugin.id, next);
    }
    for (const [id, definitions] of Object.entries(ENHANCEMENT_PLUGIN_SETTINGS)) {
      for (const [key, definition] of Object.entries(definitions)) setPluginSetting(id, key, definition.defaultValue);
    }
    try { localStorage.removeItem(SHORTCUT_TIP_STORAGE_KEY); } catch (e) {}
    syncEnhancementPanelControls();
  }

  function isPluginEnabled(id) {
    const plugin = ENHANCEMENT_PLUGINS.find((p) => p.id === id);
    if (!plugin) return true;
    const module = getModuleForPlugin(id);
    if (module && !isModuleEnabled(module.id)) return false;
    const enabled = getEnhancementConfig().features[id]?.enabled;
    return typeof enabled === "boolean" ? enabled : plugin.defaultEnabled;
  }

  function setPluginEnabled(id, enabled) {
    const plugin = ENHANCEMENT_PLUGINS.find((p) => p.id === id);
    if (!plugin) return;
    const previous = isPluginEnabled(id);
    hasStoredEnhancementConfigInitially = true;
    const config = getEnhancementConfig();
    config.features[id] ||= {};
    config.features[id].enabled = Boolean(enabled);
    config.suiteVersion = ENHANCEMENT_SUITE_VERSION;
    try { localStorage.setItem(`pi-enh-plugin-${id}`, enabled ? "true" : "false"); } catch (e) {}
    writeEnhancementConfig();
    const next = isPluginEnabled(id);
    if (next !== previous) onPluginStateChanged(id, next);
    syncEnhancementPanelControls();
    if (typeof window !== "undefined" && window.__PI_WEB_SETTINGS_NATIVE__ && typeof window.__PI_WEB_SETTINGS_NATIVE__.notifyPreferencesChanged === "function") {
      try {
        window.__PI_WEB_SETTINGS_NATIVE__.notifyPreferencesChanged();
      } catch (e) {}
    }
  }

  function onPluginStateChanged(id, enabled) {
    if (id === "settings-tab-shortcuts") syncBottomShortcutsBar(true);
    if (id === "stop-fast-response") {
      if (!enabled) {
        if (typeof window !== "undefined" && typeof window.__PI_ENH_CLEAR_STOP_FEEDBACK__ === "function") {
          try { window.__PI_ENH_CLEAR_STOP_FEEDBACK__(); } catch (_) {}
        }
        if (typeof window !== "undefined" && typeof window.__PI_ENH_REMOVE_STOP_STYLE__ === "function") {
          try { window.__PI_ENH_REMOVE_STOP_STYLE__(); } catch (_) {}
        }
      } else {
        if (typeof window !== "undefined" && typeof window.__PI_ENH_ENSURE_STOP_STYLE__ === "function") {
          try { window.__PI_ENH_ENSURE_STOP_STYLE__(); } catch (_) {}
        }
      }
    }
    if (id === "client-crash-diagnostics") {
      window.__PI_ENH_CRASH_DIAGNOSTICS__?.setEnabled(enabled);
    } else if (id === "notification-center") {
      applyNotificationVisibility();
      if (enabled) {
        initNotificationCapture();
      }
    } else if (id === "obsidian-markdown-viewer") {
      if (!enabled) removeMarkdownViewerEnhancements();
      else syncMarkdownViewerMode();
    } else if (id === "excel-sheet-preview") {
      if (!enabled && typeof removeExcelViewerEnhancements === "function") removeExcelViewerEnhancements();
      else if (typeof syncExcelViewerMode === "function") syncExcelViewerMode();
    } else if (id === "model-scope-warning") {
      syncModelScopeWarnings();
    } else if (id === "turn-duration") {
      if (!enabled) {
        for (const badge of document.querySelectorAll(".pi-enh-duration-badge")) {
          badge.remove();
        }
      } else {
        syncAllDurationBadges();
      }
    } else if (id === "turn-number-indicator") {
      if (!enabled) {
        if (typeof clearAllTurnNumberBadges === "function") {
          clearAllTurnNumberBadges();
        } else if (typeof window !== "undefined" && typeof window.__PI_ENH_CLEAR_TURN_NUMBERS__ === "function") {
          window.__PI_ENH_CLEAR_TURN_NUMBERS__();
        }
      } else {
        if (typeof syncAllTurnNumberBadges === "function") {
          syncAllTurnNumberBadges();
        } else if (typeof window !== "undefined" && typeof window.__PI_ENH_SYNC_TURN_NUMBERS__ === "function") {
          window.__PI_ENH_SYNC_TURN_NUMBERS__();
        }
      }
    } else if (id === "model-generation-speed") {
      if (!enabled) {
        for (const badge of document.querySelectorAll(".pi-enh-model-speed")) {
          badge.remove();
        }
      } else {
        syncAllModelSpeedBadges();
      }
    } else if (id === "tool-card-layout-stability") {
      syncToolCardLayoutStability();
    } else if (id === "subagent-dispatch-cards") {
      syncSubagentDispatchCards();
    } else if (id === "task-tool-auto-collapse") {
      if (window.__PI_ENH_NATIVE_PROCESS_COLLAPSE__ === 1) {
        window.dispatchEvent(new Event("pi-enh-process-collapse-change"));
      }
      syncTaskToolCollapseActiveState();
      if (enabled) {
        syncAllTaskToolAutoCollapse();
      } else {
        removeOrphanProcessBars();
      }
    } else if (id === "history-scroll-stability") {
      if (enabled) syncHistoryScrollStability();
      else cleanupHistoryScrollStability();
    } else if (id === "session-scroll-restore") {
      syncSessionScrollTracking();
      if (!enabled && typeof cancelActiveScrollRestore === "function") {
        cancelActiveScrollRestore("plugin-disabled");
      }
    } else if (id === "session-virtual-scroll") {
      syncSessionVirtualScroll();
    } else if (id === "workspace-picker-hover") {
      syncWorkspacePickerHover();
    } else if (id === "compaction-auto-collapse") {
      syncCompactionActiveState();
      if (enabled) {
        syncCompactionCards();
      } else {
        removeCompactionEnhancements();
      }
    } else if (id === "pi-mail-auto-collapse") {
      if (typeof syncPiMailActiveState === "function") {
        syncPiMailActiveState();
      } else if (typeof window !== "undefined" && typeof window.__PI_ENH_SYNC_PI_MAIL_ACTIVE_STATE__ === "function") {
        window.__PI_ENH_SYNC_PI_MAIL_ACTIVE_STATE__();
      }
      if (enabled) {
        if (typeof syncPiMailCards === "function") {
          syncPiMailCards();
        } else if (typeof window !== "undefined" && typeof window.__PI_ENH_SYNC_PI_MAIL_CARDS__ === "function") {
          window.__PI_ENH_SYNC_PI_MAIL_CARDS__();
        }
      } else {
        if (typeof removePiMailEnhancements === "function") {
          removePiMailEnhancements();
        } else if (typeof window !== "undefined" && typeof window.__PI_ENH_REMOVE_PI_MAIL_ENHANCEMENTS__ === "function") {
          window.__PI_ENH_REMOVE_PI_MAIL_ENHANCEMENTS__();
        }
      }
    } else if (id === "live-stopwatch") {
      if (!enabled) {
        for (const timer of document.querySelectorAll(".pi-enh-live-timer")) {
          timer.remove();
        }
        if (document.title.startsWith("⏱️ ")) {
          document.title = document.title.replace(/^⏱️\s+[\d.]+s\s+·\s+/, "");
        }
      }
    } else if (id === "turn-usage-total") {
      if (!enabled) hideUsageTooltip();
      syncAllUsageBadges();
    } else if (id === "quick-quote") {
      if (!enabled && typeof hideQuoteBar === "function") {
        if (composerSubmissionInFlight?.snapshot) cancelComposerNativeSubmission();
        hideQuoteBar();
        removeAnnotationUi();
      } else if (enabled && typeof syncAnnotationComposer === "function") {
        syncAnnotationComposer();
      }
    } else if (id === "context-menu") {
      if (!enabled && typeof closeMenu === "function") {
        closeMenu();
      }
    } else if (id === "ask-user-web-native") {
      window.dispatchEvent(new Event("pi-native-composer-preferences-change"));
    } else if (id === "project-status-indicator") {
      setProjectStatusMonitoring(enabled);
      if (!enabled) removeProjectStatusIndicators();
      else syncProjectStatusIndicators();
    } else if (id === "session-attention-sound") {
      if (!enabled) disposeApprovalSound();
      else void unlockApprovalSound();
      setProjectStatusMonitoring(isPluginEnabled("project-status-indicator"));
    } else if (id === "session-attention-desktop") {
      if (!enabled) disposeDesktopAttention();
      setProjectStatusMonitoring(isPluginEnabled("project-status-indicator"));
    } else if (id === "ask-user-batch-prototype") {
      if (!enabled) removeAskUserBatchPrototype();
      else showAskUserBatchPrototype();
    } else if (id === "quick-action-buttons") {
      quickActionsDraftConfig = { ...quickActionsDraftConfig, enabled: Boolean(enabled) };
      quickActionsDraftGeneration += 1;
      if (["dirty", "error"].includes(quickActionsSyncStatus)) persistQuickActionsDraft();
      if (window.__PI_ENH_DISABLE_QUICK_ACTION_CONTEXT_FETCH__) {
        setQuickActionsConfig({ ...quickActionsConfig, enabled: Boolean(enabled) }, "test");
      } else {
        void saveQuickActionsConfig({ ...quickActionsConfig, enabled: Boolean(enabled) });
      }
      if (!enabled) removeQuickActionButtons();
      else syncQuickActionButtons();
    } else if (id === "empty-send-continue") {
      if (!enabled) removeEmptySendContinue();
      else syncEmptySendContinue();
    } else if (id === "chat-scrollbar") {
      syncScrollbarPlugin();
    } else if (id === "native-message-font") {
      syncNativeMessageFont();
    } else if (id === "minimap-full-nav") {
      syncMinimapEnhancements();
    } else if (id === "scroll-to-bottom") {
      if (!enabled) removeScrollBottomButton();
      else syncScrollBottomButton();
    } else if (id === "local-path-launcher") {
      if (!enabled) removeLocalPathLauncher();
      else syncLocalPathLauncher();
    } else if (id === "session-memory-cache") {
      window.dispatchEvent(new CustomEvent("pi:session-cache-change"));
      if (!enabled) {
        if (!isPluginEnabled("session-history-integrity")) {
          window.__PI_ENH_CLEAR_TERMINAL_RECONCILE_TIMERS__?.();
        }
        if (typeof clearDomSessionSnapshots === "function") {
          clearDomSessionSnapshots();
        }
        void clearSessionCaches();
      }
    } else if (id === "cross-device-session-sync") {
      syncCrossDeviceSessionSync(enabled);
    } else if (id === "session-history-integrity") {
      clearHistorySyncWarning();
      if (!enabled) {
        if (!isPluginEnabled("session-memory-cache")) {
          window.__PI_ENH_CLEAR_TERMINAL_RECONCILE_TIMERS__?.();
        }
      }
      if (enabled) void clearSessionCaches();
    } else if (id === "session-history-order-guard") {
      if (!enabled) clearSessionHistoryOrderState();
    } else if (id === "code-block-scan-guard") {
      if (enabled) startCodeBlockScanGuard();
      else stopCodeBlockScanGuard();
    } else if (id === "streaming-thinking-guard") {
      syncStreamingThinkingGuard(enabled);
    } else if (id === "session-pin-archive") {
      if (!enabled) {
        removeSessionPinArchiveControls();
        removeSessionSectionHeaders();
      } else {
        syncSessionPinArchiveControls();
        void syncManifestPinnedEntries();
        void syncManifestArchivedEntries();
      }
      syncSessionOdooAddonsLayout();
      syncSessionSectionHeaders();
      window.__PI_ENH_RERENDER_SESSIONS__?.();
    } else if (id === "session-section-headers") {
      if (!enabled) removeSessionSectionHeaders();
      syncSessionOdooAddonsLayout();
      syncSessionSectionHeaders();
      window.__PI_ENH_RERENDER_SESSIONS__?.();
    } else if (id === "session-model-label") {
      if (!enabled) removeSessionModelLabels();
      else syncSessionModelLabels();
    } else if (id === "session-item-compact") {
      if (!enabled) removeSessionItemCompact();
      else syncSessionItemCompact();
    } else if (id === "session-color") {
      if (!enabled) removeSessionColorEffects();
      else syncSessionColorEffects();
    } else if (id === "session-tags") {
      if (!enabled) {
        removeSessionTagsRowAll();
        closeSessionTagsPopover();
        const tagMenuItem = activeMenu?.querySelector('[data-action="open-session-tags"]');
        if (tagMenuItem) {
          clearTimeout(tagMenuItem._openSubmenuTimer);
          clearTimeout(tagMenuItem._closeSubmenuTimer);
          tagMenuItem.remove();
        }
      } else {
        syncSessionTags();
      }
    } else if (id === "session-odoo-addons") {
      if (enabled && typeof refreshSessionOdooAddonsManifest === "function") {
        void refreshSessionOdooAddonsManifest({ force: true, reason: "plugin-toggle" });
      }
      syncSessionOdooAddons();
      requestSessionListRefresh();
    } else if (id === "session-dblclick-rename") {
      // 双击监听内部实时校验 isPluginEnabled("session-dblclick-rename")，无需额外重排 DOM
    } else if (id === "composer-draft-cache") {
      if (!enabled) {
        stopComposerDraftCache();
      } else {
        restoreComposerDraftIfNeeded();
      }
    } else if (id === "composer-file-paste") {
      if (!enabled) {
        removeComposerFilePaste();
      } else {
        syncComposerFilePaste();
      }
    } else if (id === "composer-image-zoom") {
      if (!enabled) {
        removeComposerImageZoom();
      } else {
        syncComposerImageZoom();
      }
    } else if (id === "codex-composer-layout" || id === "composer-model-reasoning-pill") {
      window.dispatchEvent(new Event("pi-native-composer-preferences-change"));
    } else if (id === "composer-clean-placeholder") {
      if (!enabled) {
        removeComposerCleanPlaceholder();
      } else {
        syncComposerCleanPlaceholder();
      }
    } else if (id === "composer-queue-panel") {
      if (enabled) syncComposerQueuePanel();
      else removeComposerQueuePanel();
    } else if (id === "composer-format-toggle") {
      syncComposerMarkdownFormat();
    } else if (id === "composer-compact-button" || id === "composer-tool-preset") {
      syncComposerToolButtons();
    } else if (id === "running-model-switch") {
      if (!enabled) {
        restoreRunningModelSwitch();
      } else {
        syncRunningModelSwitch();
      }
    } else if (id === "composer-markdown-format") {
      if (!enabled) {
        removeComposerMarkdownFormat();
      } else {
        syncComposerMarkdownFormat();
      }
    } else if (id === "composer-modes") {
      window.dispatchEvent(new Event("pi-native-composer-preferences-change"));
      if (!enabled) {
        handleComposerModesDisabled();
      } else {
        syncComposerModes();
      }
    } else if (id === "at-mention-plugins") {
      syncAtMentionPluginsPluginState(Boolean(enabled));
    } else if (id === "image-dblclick-preview") {
      if (!enabled) {
        removeImageDblClickPreview();
      } else {
        syncImageDblClickPreview();
      }
    } else if (id === "session-panel-binding") {
      if (enabled) {
        syncSessionPanelBinding();
      }
    } else if (id === "file-panel-overlay-guard") {
      if (enabled) {
        syncFilePanelOverlayGuard();
      } else {
        removeFilePanelOverlayGuard();
      }
    } else if (id === "thinking-persistence") {
      if (!enabled) {
        restoredThinkingSessionScopes.clear();
      }
    } else if (id === "enhancement-settings-archive") {
      if (enabled) {
        hasStoredEnhancementConfigInitially = true;
        if (typeof queuePreferencesSnapshotIfNeeded === "function") {
          queuePreferencesSnapshotIfNeeded();
        }
      }
    } else if (id === "session-search-shortcut") {
      syncSearchButtonHint();
    } else if (id === "session-batch-actions") {
      if (!enabled) {
        setSessionBatchMode(false);
        removeSessionBatchTrigger();
        removeSessionBatchBar();
      } else {
        syncSessionBatchTriggerButton();
      }
    } else if (id === "mobile-swipe-drawer") {
      syncMobileSwipeDrawer(enabled);
    } else if (id === "pi-web-plus-branding") {
      if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
        try {
          window.dispatchEvent(new CustomEvent("pi-web-plus-branding-change", { detail: { enabled } }));
        } catch (_) {
          window.dispatchEvent(new Event("pi-web-plus-branding-change"));
        }
      }
    }
  }

  const MODEL_SCOPE_WARNING_MARKER = "data-pi-enh-model-scope-warning";
  const MODEL_SCOPE_WARNING_ORIGINAL_DISPLAY = "data-pi-enh-model-scope-warning-display";
  const MODEL_SCOPE_WARNING_ICON_SELECTOR = ".pi-enh-model-scope-warning-icon";
  const MODEL_SCOPE_WARNING_TEXT_MARKERS = [
    "模型范围警告",
    "model scope warning",
    "no models match pattern",
  ];
  const MODEL_SCOPE_WARNING_PATTERN_RE = /no models match(?:es)? pattern\s+(?:["“'‘]([^"”'’\r\n]+)["”'’]|([^\s,;]+))/gi;
  const MODEL_SCOPE_WARNING_REASONING_SUFFIX_RE = /:(?:none|off|minimal|low|medium|high|xhigh|max)$/i;

  function isModelScopeWarningCard(card) {
    if (!card || card.getAttribute?.("role") !== "alert") return false;
    const text = String(card.textContent || "").toLocaleLowerCase();
    return MODEL_SCOPE_WARNING_TEXT_MARKERS.some((marker) => text.includes(marker.toLocaleLowerCase()));
  }

  function restoreModelScopeWarningCard(card) {
    if (!card?.hasAttribute?.(MODEL_SCOPE_WARNING_MARKER)) return;
    if (card.style) {
      card.style.display = card.getAttribute(MODEL_SCOPE_WARNING_ORIGINAL_DISPLAY) || "";
    }
    card.removeAttribute(MODEL_SCOPE_WARNING_MARKER);
    card.removeAttribute(MODEL_SCOPE_WARNING_ORIGINAL_DISPLAY);
  }

  function removeModelScopeWarningIndicators() {
    for (const icon of document.querySelectorAll(MODEL_SCOPE_WARNING_ICON_SELECTOR)) {
      icon.remove();
    }
  }

  function clearModelScopeWarningVisibility() {
    for (const card of document.querySelectorAll('[role="alert"]')) {
      restoreModelScopeWarningCard(card);
    }
    removeModelScopeWarningIndicators();
    document.documentElement?.classList?.remove("pi-enh-model-scope-warning-hidden");
  }

  function normalizeModelScopeIdentity(value) {
    return String(value || "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  }

  function collectModelScopeWarningPatterns(cards) {
    const patternsByModel = new Map();
    for (const card of cards) {
      const text = String(card.textContent || "");
      MODEL_SCOPE_WARNING_PATTERN_RE.lastIndex = 0;
      let match;
      while ((match = MODEL_SCOPE_WARNING_PATTERN_RE.exec(text))) {
        const rawPattern = String(match[1] || match[2] || "").trim().replace(/[.!?]+$/, "");
        const modelRef = rawPattern.replace(MODEL_SCOPE_WARNING_REASONING_SUFFIX_RE, "").trim();
        if (!modelRef) continue;
        const key = modelRef.toLocaleLowerCase();
        let warning = patternsByModel.get(key);
        if (!warning) {
          const parts = modelRef.split("/").filter(Boolean);
          warning = {
            modelRef,
            provider: parts.length > 1 ? parts[0] : "",
            modelName: parts[parts.length - 1] || modelRef,
            rawPatterns: new Set(),
          };
          patternsByModel.set(key, warning);
        }
        warning.rawPatterns.add(rawPattern);
      }
    }
    return Array.from(patternsByModel.values());
  }

  function getModelScopeOptionProvider(option, listbox) {
    const group = option?.parentElement;
    if (!group || group === listbox) return "";
    for (const child of Array.from(group.children || [])) {
      if (child === option || child.matches?.('button[role="option"]')) continue;
      if (child.querySelector?.('button[role="option"]')) continue;
      const label = String(child.textContent || "").trim();
      if (label) return label;
    }
    return "";
  }

  function modelScopeWarningMatchesOption(option, listbox, warning) {
    const modelNameIdentity = normalizeModelScopeIdentity(warning.modelName);
    const modelRefIdentity = normalizeModelScopeIdentity(warning.modelRef);
    const explicitModel = option.getAttribute("data-model-id") ||
      option.getAttribute("data-model") ||
      option.getAttribute("data-provider-model") ||
      option.getAttribute("value") || "";
    if (explicitModel) {
      const explicitIdentity = normalizeModelScopeIdentity(explicitModel.replace(MODEL_SCOPE_WARNING_REASONING_SUFFIX_RE, ""));
      if (explicitIdentity === modelRefIdentity || explicitIdentity === modelNameIdentity) {
        const explicitProvider = option.getAttribute("data-provider") || "";
        return !warning.provider || !explicitProvider ||
          normalizeModelScopeIdentity(explicitProvider) === normalizeModelScopeIdentity(warning.provider);
      }
    }

    const labelNode = option.querySelector?.("[title]");
    const label = String(labelNode?.getAttribute("title") || labelNode?.textContent || option.textContent || "").trim();
    const labelIdentity = normalizeModelScopeIdentity(label);
    if (!modelNameIdentity || !labelIdentity.includes(modelNameIdentity)) return false;

    const provider = option.getAttribute("data-provider") || getModelScopeOptionProvider(option, listbox);
    return !warning.provider || !provider ||
      normalizeModelScopeIdentity(provider) === normalizeModelScopeIdentity(warning.provider);
  }

  function createModelScopeWarningIcon(warning) {
    const svgNamespace = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(svgNamespace, "svg");
    icon.classList.add("pi-enh-model-scope-warning-icon");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("width", "15");
    icon.setAttribute("height", "15");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "#eab308");
    icon.setAttribute("stroke-width", "2");
    icon.setAttribute("stroke-linecap", "round");
    icon.setAttribute("stroke-linejoin", "round");
    icon.setAttribute("role", "img");
    icon.style.cssText = "display:block;width:15px;height:15px;flex:0 0 15px;margin-left:6px;color:#eab308";

    const triangle = document.createElementNS(svgNamespace, "path");
    triangle.setAttribute("d", "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z");
    const exclamation = document.createElementNS(svgNamespace, "path");
    exclamation.setAttribute("d", "M12 9v4");
    const dot = document.createElementNS(svgNamespace, "circle");
    dot.setAttribute("cx", "12");
    dot.setAttribute("cy", "17");
    dot.setAttribute("r", "0.5");
    dot.setAttribute("fill", "#eab308");
    dot.setAttribute("stroke", "none");
    icon.append(triangle, exclamation, dot);
    return icon;
  }

  function syncModelScopeWarningIndicators(warnings) {
    const matchedOptions = new Set();
    if (warnings.length) {
      for (const listbox of document.querySelectorAll('.model-selector div[role="listbox"]')) {
        for (const option of listbox.querySelectorAll('[role="option"]')) {
          const matchedWarnings = warnings.filter((warning) => modelScopeWarningMatchesOption(option, listbox, warning));
          if (!matchedWarnings.length) continue;
          matchedOptions.add(option);
          let icon = option.querySelector(MODEL_SCOPE_WARNING_ICON_SELECTOR);
          if (!icon) {
            icon = createModelScopeWarningIcon(matchedWarnings[0]);
            option.appendChild(icon);
          }
          const tooltip = `模型范围警告：${matchedWarnings.flatMap((warning) =>
            Array.from(warning.rawPatterns, (pattern) => `No models match pattern "${pattern}"`)
          ).join("；")}`;
          if (icon.getAttribute("title") !== tooltip) icon.setAttribute("title", tooltip);
          if (icon.getAttribute("aria-label") !== tooltip) icon.setAttribute("aria-label", tooltip);
        }
      }
    }
    for (const icon of document.querySelectorAll(MODEL_SCOPE_WARNING_ICON_SELECTOR)) {
      if (!matchedOptions.has(icon.parentElement)) icon.remove();
    }
    return matchedOptions.size;
  }

  function syncModelScopeWarnings() {
    const matchingCards = [];
    for (const card of document.querySelectorAll('[role="alert"]')) {
      if (isModelScopeWarningCard(card)) {
        matchingCards.push(card);
      } else {
        restoreModelScopeWarningCard(card);
      }
    }

    if (!isPluginEnabled("model-scope-warning")) {
      for (const card of matchingCards) restoreModelScopeWarningCard(card);
      removeModelScopeWarningIndicators();
      document.documentElement?.classList?.remove("pi-enh-model-scope-warning-hidden");
      return;
    }

    for (const card of matchingCards) {
      if (!card.hasAttribute(MODEL_SCOPE_WARNING_MARKER)) {
        card.setAttribute(MODEL_SCOPE_WARNING_ORIGINAL_DISPLAY, card.style?.display || "");
      }
      card.setAttribute(MODEL_SCOPE_WARNING_MARKER, "true");
      if (card.style && card.style.display !== "none") card.style.display = "none";
    }

    const warningPatterns = collectModelScopeWarningPatterns(matchingCards);
    syncModelScopeWarningIndicators(warningPatterns);
    document.documentElement?.classList?.toggle("pi-enh-model-scope-warning-hidden", matchingCards.length > 0);
  }

  window.__PI_ENH_SYNC_MODEL_SCOPE_WARNINGS__ = syncModelScopeWarnings;
  window.__PI_ENH_PLUGINS__ = ENHANCEMENT_PLUGINS;
  window.__PI_ENH_MODULES__ = ENHANCEMENT_MODULES;
  window.__PI_ENH_SUITE_VERSION__ = ENHANCEMENT_SUITE_VERSION;
  window.__PI_ENH_IS_MODULE_ENABLED__ = isModuleEnabled;
  window.__PI_ENH_SET_MODULE__ = setModuleEnabled;
  window.__PI_ENH_GET_MODULE_STATE__ = getModuleState;
  window.__PI_ENH_RESET_SETTINGS__ = resetEnhancementSettings;
  window.__PI_ENH_CRASH_DIAGNOSTICS__?.setEnabled(isPluginEnabled("client-crash-diagnostics"));
  window.__PI_ENH_IS_PLUGIN_ENABLED__ = isPluginEnabled;
  window.__PI_ENH_SET_PLUGIN__ = setPluginEnabled;
  window.__PI_ENH_GET_PLUGIN_SETTING__ = getPluginSetting;
  window.__PI_ENH_SET_PLUGIN_SETTING__ = setPluginSetting;
  window.__PI_ENH_CONFIG__ = getEnhancementConfig();

  // User-message identity and reconciliation belong to the native session hook.

  // ==========================================
  // 0.1 Codex-style Session Pin & Archive (会话置顶与归档状态)
  // ==========================================
  const PINNED_SESSION_STORAGE_KEY = "pi-enh-session-pinned";
  const ARCHIVED_SESSION_STORAGE_KEY = "pi-enh-session-archived";
  const RECENTLY_RESTORED_ARCHIVED_KEY = "pi-enh-recently-restored-archived-v1";

  function getRecentlyRestoredArchivedIds() {
    try {
      const raw = localStorage.getItem(RECENTLY_RESTORED_ARCHIVED_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return new Set();
      const now = Date.now();
      const valid = new Set();
      for (const [id, ts] of Object.entries(parsed)) {
        if (id && typeof ts === "number" && now - ts < 120000) {
          valid.add(id);
        }
      }
      return valid;
    } catch (e) {
      return new Set();
    }
  }

  function markSessionAsRecentlyRestored(sessionId) {
    if (!sessionId) return;
    try {
      const raw = localStorage.getItem(RECENTLY_RESTORED_ARCHIVED_KEY);
      const parsed = (raw && typeof raw === "string") ? JSON.parse(raw) : {};
      parsed[sessionId] = Date.now();
      const now = Date.now();
      for (const [id, ts] of Object.entries(parsed)) {
        if (now - Number(ts) >= 120000) delete parsed[id];
      }
      localStorage.setItem(RECENTLY_RESTORED_ARCHIVED_KEY, JSON.stringify(parsed));
    } catch (e) {}
    if (typeof window !== "undefined" && window.__PI_ENH_RECENTLY_RESTORED_ARCHIVED_IDS__ instanceof Set) {
      window.__PI_ENH_RECENTLY_RESTORED_ARCHIVED_IDS__.add(sessionId);
    }
  }

  function unmarkSessionAsRecentlyRestored(sessionId) {
    if (!sessionId) return;
    try {
      const raw = localStorage.getItem(RECENTLY_RESTORED_ARCHIVED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && sessionId in parsed) {
          delete parsed[sessionId];
          localStorage.setItem(RECENTLY_RESTORED_ARCHIVED_KEY, JSON.stringify(parsed));
        }
      }
    } catch (e) {}
    if (typeof window !== "undefined" && window.__PI_ENH_RECENTLY_RESTORED_ARCHIVED_IDS__ instanceof Set) {
      window.__PI_ENH_RECENTLY_RESTORED_ARCHIVED_IDS__.delete(sessionId);
    }
  }
  const SESSION_MODEL_STORAGE_KEY = "pi-enh-session-model-meta-v1";
  const knownSessionTitles = new Map();
  const knownSessionsMap = new Map();
  const SESSION_MODEL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  const sessionModelMetadata = new Map();
  const sessionModelRequests = new Set();
  const pendingModelMetadataQueue = [];
  let activeModelMetadataWorkers = 0;

  function loadPersistedSessionModelMetadata() {
    try {
      const raw = localStorage.getItem(SESSION_MODEL_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return;
      for (const [sId, item] of Object.entries(parsed)) {
        if (!sId || !item || typeof item !== "object" || !item.modelId) continue;
        const updatedAt = Number(item.updatedAt) || 0;
        sessionModelMetadata.set(sId, {
          provider: item.provider || "",
          modelId: item.modelId || "",
          thinkingLevel: item.thinkingLevel || "off",
          expiresAt: updatedAt + SESSION_MODEL_CACHE_TTL_MS,
          updatedAt,
        });
      }
    } catch (e) {}
  }
  loadPersistedSessionModelMetadata();

  function persistSessionModelMetadata() {
    try {
      const validEntries = [];
      for (const [sId, meta] of sessionModelMetadata.entries()) {
        if (!sId || !meta?.modelId) continue;
        validEntries.push({
          id: sId,
          provider: meta.provider || "",
          modelId: meta.modelId || "",
          thinkingLevel: meta.thinkingLevel || "off",
          updatedAt: meta.updatedAt || Date.now(),
        });
      }
      validEntries.sort((a, b) => b.updatedAt - a.updatedAt);
      const trimmed = validEntries.slice(0, 200);
      const toStore = {};
      for (const item of trimmed) {
        toStore[item.id] = {
          provider: item.provider,
          modelId: item.modelId,
          thinkingLevel: item.thinkingLevel,
          updatedAt: item.updatedAt,
        };
      }
      localStorage.setItem(SESSION_MODEL_STORAGE_KEY, JSON.stringify(toStore));
    } catch (e) {}
  }

  function recordSessionModelMetadataFromPayload(sessionId, payload) {
    if (!sessionId || !payload?.context?.model?.modelId) return;
    const m = payload.context.model;
    const now = Date.now();
    sessionModelMetadata.set(sessionId, {
      provider: m.provider || "",
      modelId: m.modelId || "",
      thinkingLevel: payload.context.thinkingLevel || "off",
      expiresAt: now + SESSION_MODEL_CACHE_TTL_MS,
      updatedAt: now,
    });
    persistSessionModelMetadata();
  }

  function removeSessionModelLabels() {
    for (const badge of document.querySelectorAll(".pi-enh-session-model-badge")) badge.remove();
  }

  function findSessionMessageCountElement(row) {
    if (!row?.querySelectorAll) return null;
    const elements = Array.from(row.querySelectorAll("*"));
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const text = elements[index].textContent || "";
      if (/^\s*[\d,.]+\s*(?:条消息|messages?|msgs?)\s*$/i.test(text)) {
        const el = elements[index];
        el.classList.add("pi-enh-session-msg-count");
        if (!el.hasAttribute("title") && text.trim()) {
          el.setAttribute("title", text.trim());
        }
        return el;
      }
    }
    return null;
  }

  function removeSessionItemCompact() {
    document.documentElement?.classList?.remove("pi-enh-session-compact-active");
  }

  function syncSessionItemCompact() {
    if (!isPluginEnabled("session-item-compact")) {
      removeSessionItemCompact();
      return;
    }
    document.documentElement?.classList?.add("pi-enh-session-compact-active");

    const isMobile = typeof isMobileEnvironment === "function" && isMobileEnvironment();
    document.documentElement?.classList?.toggle("pi-enh-mobile", !!isMobile);

    const rows = document.querySelectorAll(".pi-enh-session-row-host");
    for (const row of rows) {
      findSessionMessageCountElement(row);

      const contentHost = row.querySelector("div[style*='flex: 1'], div[style*='flex:1']") || row.firstElementChild;
      if (contentHost && contentHost.children && contentHost.children.length >= 2) {
        const titleDiv = contentHost.children[0];
        const metaDiv = contentHost.children[1];
        if (titleDiv && !titleDiv.classList.contains("pi-enh-session-title")) {
          titleDiv.classList.add("pi-enh-session-title");
        }
        if (metaDiv && !metaDiv.classList.contains("pi-enh-session-meta")) {
          metaDiv.classList.add("pi-enh-session-meta");
        }
        if (metaDiv && metaDiv.firstElementChild && !metaDiv.firstElementChild.classList.contains("pi-enh-session-time")) {
          metaDiv.firstElementChild.classList.add("pi-enh-session-time");
        }
      }
    }
  }

  function renderSessionModelLabel(row, metadata) {
    const existing = row.querySelector(".pi-enh-session-model-badge");
    // 关键守卫：若当前行处于编辑状态（包含 input 或标记为 editing），严禁强行显示模型名字
    if (row.querySelector("input") || row.getAttribute("data-pi-enh-editing") === "true") {
      existing?.remove();
      return;
    }
    if (!metadata?.modelId) {
      existing?.remove();
      return;
    }
    const badge = existing || document.createElement("span");
    if (!existing) badge.className = "pi-enh-session-model-badge";

    const messageCount = findSessionMessageCountElement(row);
    if (messageCount?.parentElement) {
      if (badge.parentElement !== messageCount.parentElement || messageCount.nextSibling !== badge) {
        if (badge.parentElement) badge.remove();
        messageCount.after(badge);
      }
    } else {
      // 安全锚定回退：必须挂在第二行元数据容器内，绝不允许直接挂在顶层 row 上挤压标题
      const metaContainer = row.querySelector(".pi-enh-session-meta") ||
        row.querySelector("div[style*='flex: 1'] > div:last-child") ||
        row.querySelector("div[style*='flex:1'] > div:last-child");
      if (metaContainer) {
        if (badge.parentElement !== metaContainer) {
          if (badge.parentElement) badge.remove();
          metaContainer.appendChild(badge);
        }
      } else {
        // 若找不到第二行元数据容器，说明当前处于编辑、加载或非标准布局，严禁挂在顶层 row 上！
        badge.remove();
        return;
      }
    }

    const thinkingLevel = metadata.thinkingLevel || "off";
    const nextText = `${metadata.modelId} · ${thinkingLevel}`;
    const nextTitle = `${metadata.provider || "未知 Provider"} / ${metadata.modelId} · 思考深度：${thinkingLevel}`;
    const nextAria = `模型 ${metadata.modelId}，思考深度 ${thinkingLevel}`;

    if (badge.textContent !== nextText) badge.textContent = nextText;
    if (badge.getAttribute("title") !== nextTitle) badge.setAttribute("title", nextTitle);
    if (badge.getAttribute("aria-label") !== nextAria) badge.setAttribute("aria-label", nextAria);
  }

  async function fetchSessionModelMetadata(sessionId) {
    if (!sessionId || sessionModelRequests.has(sessionId)) return;
    sessionModelRequests.add(sessionId);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=1&deferMedia=1&tail=1`, { cache: "no-store" });
      if (!response?.ok) {
        sessionModelMetadata.set(sessionId, {
          provider: "",
          modelId: "",
          thinkingLevel: "off",
          expiresAt: Date.now() + 5000,
          updatedAt: Date.now(),
        });
        return;
      }
      const payload = await response.json(); 
      const model = payload?.context?.model;
      const now = Date.now();
      sessionModelMetadata.set(sessionId, {
        provider: model?.provider || "",
        modelId: model?.modelId || "",
        thinkingLevel: payload?.context?.thinkingLevel || "off",
        expiresAt: now + SESSION_MODEL_CACHE_TTL_MS,
        updatedAt: now,
      });
      if (model?.modelId) {
        persistSessionModelMetadata();
      }
    } catch (e) {
      sessionModelMetadata.set(sessionId, {
        provider: "",
        modelId: "",
        thinkingLevel: "off",
        expiresAt: Date.now() + 5000,
        updatedAt: Date.now(),
      });
    } finally {
      sessionModelRequests.delete(sessionId);
      if (isPluginEnabled("session-model-label")) syncSessionModelLabels();
    }
  }

  function enqueueSessionModelMetadata(sessionId) {
    if (!sessionId || sessionModelRequests.has(sessionId) || pendingModelMetadataQueue.includes(sessionId)) return;
    pendingModelMetadataQueue.push(sessionId);
    pumpSessionModelMetadataQueue();
  }

  function pumpSessionModelMetadataQueue() {
    if (activeModelMetadataWorkers >= 1 || pendingModelMetadataQueue.length === 0) return;
    activeModelMetadataWorkers++;
    setTimeout(async () => {
      try {
        while (pendingModelMetadataQueue.length > 0 && !isDisposed && isPluginEnabled("session-model-label")) {
          // 若当前有主会话详情正在加载，优先让路给主会话切换
          if (typeof inFlightSessionDetailRequests !== "undefined" && inFlightSessionDetailRequests.size > 0) {
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }
          const sid = pendingModelMetadataQueue.shift();
          if (!sid) continue;
          const existing = sessionModelMetadata.get(sid);
          if (existing && existing.modelId && existing.expiresAt > Date.now()) continue;
          await fetchSessionModelMetadata(sid);
          await new Promise((r) => setTimeout(r, 80));
        }
      } finally {
        activeModelMetadataWorkers = Math.max(0, activeModelMetadataWorkers - 1);
      }
    }, 600);
  }

  function syncSessionModelLabels() {
    if (!isPluginEnabled("session-model-label")) {
      removeSessionModelLabels();
      return;
    }
    const now = Date.now();
    for (const row of document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]")) {
      const sessionId = row.getAttribute("data-pi-enh-session-id");
      if (!sessionId) continue;
      const metadata = sessionModelMetadata.get(sessionId);
      if (metadata && metadata.modelId) {
        renderSessionModelLabel(row, metadata);
      }
      if (!metadata || metadata.expiresAt <= now) {
        enqueueSessionModelMetadata(sessionId);
      }
    }
  }

  const SESSION_COLOR_STORAGE_KEY = "pi-enh-session-colors-v1";
  const SESSION_COLORS_REVISION_KEY = "pi-enh-session-colors-rev";
  const SESSION_COLOR_PRESETS = [
    { id: "blue", name: "蓝色", value: "#60a5fa" },
    { id: "green", name: "绿色", value: "#34d399" },
    { id: "yellow", name: "黄色", value: "#fbbf24" },
    { id: "orange", name: "橙色", value: "#fb923c" },
    { id: "red", name: "红色", value: "#fb7185" },
    { id: "purple", name: "紫色", value: "#a78bfa" },
  ];
  const SESSION_COLOR_IDS = new Set(SESSION_COLOR_PRESETS.map((preset) => preset.id));

  function getLocalSessionColorsRevision() {
    try {
      return Number(localStorage.getItem(SESSION_COLORS_REVISION_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setLocalSessionColorsRevision(rev) {
    try {
      localStorage.setItem(SESSION_COLORS_REVISION_KEY, String(rev));
    } catch (e) {}
  }

  let modelsConfigLock = Promise.resolve();
  function runWithModelsConfigLock(task) {
    const nextLock = modelsConfigLock.then(() => task(), () => task());
    modelsConfigLock = nextLock.catch(() => {});
    return nextLock;
  }

  const MODELS_CONFIG_TIMEOUT_MS = 15000;
  const activeModelsConfigAbortControllers = new Set();

  async function fetchModelsConfigBounded(url, options = {}, timeoutMs = MODELS_CONFIG_TIMEOUT_MS) {
    if (isDisposed) {
      throw new Error("Instance disposed");
    }
    const activeFetch = baseFetch || originalWindowFetch || (typeof window !== "undefined" && window.fetch ? window.fetch : fetch);
    if (!activeFetch) {
      throw new Error("Fetch unavailable");
    }

    const controller = new AbortController();
    activeModelsConfigAbortControllers.add(controller);

    let timedOut = false;
    let timerId = null;
    let abortHandler = null;

    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch (e) {}
        reject(new Error("MODELS_CONFIG_TIMEOUT"));
      }, timeoutMs);
    });

    const abortPromise = new Promise((_, reject) => {
      if (controller.signal.aborted) {
        reject(new Error("MODELS_CONFIG_ABORTED"));
      } else {
        abortHandler = () => {
          reject(new Error("MODELS_CONFIG_ABORTED"));
        };
        try {
          controller.signal.addEventListener("abort", abortHandler, { once: true });
        } catch (e) {}
      }
    });

    try {
      const fetchPromise = (async () => {
        const init = {
          ...options,
          signal: controller.signal,
        };
        const resp = await activeFetch(url, init);
        let json = null;
        if (options.readJson !== false && resp && (resp.ok || resp.status === 200)) {
          json = await resp.json();
        }
        return { resp, json };
      })();

      const result = await Promise.race([fetchPromise, timeoutPromise, abortPromise]);
      return result;
    } catch (err) {
      if (timedOut || err?.message === "MODELS_CONFIG_TIMEOUT" || err?.message === "MODELS_CONFIG_ABORTED" || err?.name === "AbortError") {
        const error = new Error(timedOut ? "Network timeout (15s) while accessing models-config" : (err?.message || "Aborted"));
        error.isTimeout = timedOut;
        error.isAbort = true;
        throw error;
      }
      throw err;
    } finally {
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (abortHandler) {
        try { controller.signal.removeEventListener("abort", abortHandler); } catch (e) {}
        abortHandler = null;
      }
      activeModelsConfigAbortControllers.delete(controller);
    }
  }

  // ==========================================
  // 会话背景颜色与标签持久化纯操作与状态管理 (Session Decorations Safety Engine)
  // ==========================================
  const DECORATION_OP_PREFIX = "pi-enh-decoration-op-v2:";
  const DURABLE_STATE_REVISION_KEY = "pi-enh-durable-state-rev";
  const CLIENT_ID_STORAGE_KEY = "pi-enh-client-id";
  let lastKnownOutboxTimestamp = 0;
  let durableStateCommitLock = Promise.resolve();

  function notifySaveWarning(message = "尚未可靠保存，请勿关闭页面") {
    try {
      if (typeof showToast === "function") {
        showToast(message, undefined, 6000);
      } else {
        console.warn("[pi-enh] " + message);
      }
    } catch (e) {
      console.warn("[pi-enh] " + message);
    }
  }

  let durableRetryAttempt = 0;
  let durableRetryTimer = null;
  const DURABLE_RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

  function getDurableRetryDelay(attempt) {
    const idx = Math.min(attempt, DURABLE_RETRY_DELAYS.length - 1);
    return DURABLE_RETRY_DELAYS[idx];
  }

  function scheduleDurableStateRetry() {
    if (isDisposed || !isDurableStateEnabled()) return;
    if (durableRetryTimer) return;
    if (pendingDecorationOperations.length === 0) {
      durableRetryAttempt = 0;
      return;
    }
    if (durableRetryAttempt >= DURABLE_RETRY_DELAYS.length) {
      console.warn("[pi-enh] 独立状态重试达上限(30s)，暂停定时轮询，等待网络恢复(online)或用户新操作");
      return;
    }
    const delay = getDurableRetryDelay(durableRetryAttempt);
    durableRetryAttempt++;
    durableRetryTimer = setTimeout(() => {
      durableRetryTimer = null;
      if (!isDisposed && isDurableStateEnabled() && pendingDecorationOperations.length > 0) {
        void persistDecorationsToServer();
      }
    }, delay);
  }

  function resetDurableRetry() {
    durableRetryAttempt = 0;
    if (durableRetryTimer) {
      clearTimeout(durableRetryTimer);
      durableRetryTimer = null;
    }
  }

  function isValidDurablePostResponse(result, sentOpIds) {
    if (!result || typeof result !== "object" || result.ok !== true) return false;
    if (result.storageVersion !== 1) return false;
    if (!Number.isInteger(result.revision) || result.revision <= 0) return false;
    if (!result.state || typeof result.state !== "object" || Array.isArray(result.state)) return false;

    if (!Array.isArray(result.state.sessionTagsDefinitions)) return false;
    if (!result.state.sessionTagMappings || typeof result.state.sessionTagMappings !== "object" || Array.isArray(result.state.sessionTagMappings)) return false;
    if (!result.state.sessionColors || typeof result.state.sessionColors !== "object" || Array.isArray(result.state.sessionColors)) return false;
    if (!result.state.enhancementSettingsByClient || typeof result.state.enhancementSettingsByClient !== "object" || Array.isArray(result.state.enhancementSettingsByClient)) return false;

    if (!Array.isArray(result.acknowledgedOpIds)) return false;
    const sentSet = new Set(sentOpIds);
    for (const ackId of result.acknowledgedOpIds) {
      if (typeof ackId !== "string" || !sentSet.has(ackId)) {
        return false;
      }
    }
    return new Set(result.acknowledgedOpIds).size === sentSet.size;
  }

  function isDurableStateEnabled() {
    return typeof window !== "undefined" && !!window &&
      window.__PI_ENH_DURABLE_STATE_ENABLED__ === true &&
      window.__PI_ENH_NATIVE_STATE_API__ === true;
  }

  function getDurableStateBaseUrl() {
    return "/api";
  }

  function getDurableStateInstanceParam() {
    try {
      const port = window.location?.port;
      if (port === "30142") return "30142";
      return "30141";
    } catch (e) {
      return "30141";
    }
  }

  function getLocalDurableStateRevision() {
    try {
      return Number(localStorage.getItem(DURABLE_STATE_REVISION_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setLocalDurableStateRevision(rev) {
    try {
      localStorage.setItem(DURABLE_STATE_REVISION_KEY, String(rev));
    } catch (e) {}
  }

  function generateDecorationOpUuid() {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch (e) {}
    try {
      if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
        const buf = new Uint8Array(16);
        crypto.getRandomValues(buf);
        buf[6] = (buf[6] & 0x0f) | 0x40;
        buf[8] = (buf[8] & 0x3f) | 0x80;
        const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      }
    } catch (e) {}
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getOrCreateClientId() {
    try {
      let id = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
      if (!id || typeof id !== "string" || id.length < 8) {
        id = "client_" + generateDecorationOpUuid();
        localStorage.setItem(CLIENT_ID_STORAGE_KEY, id);
      }
      return id;
    } catch (e) {
      return "client_fallback_" + generateDecorationOpUuid();
    }
  }

  function getNextOutboxTimestamp() {
    const ts = Math.max(Date.now(), lastKnownOutboxTimestamp + 1);
    lastKnownOutboxTimestamp = ts;
    return ts;
  }

  function sanitizeOperationForServer(op) {
    if (!op || typeof op !== "object") return null;
    const opId = String(op.opId || "");
    const timestamp = Number(op.timestamp) || Date.now();
    const type = op.type;

    switch (type) {
      case "tag_create": {
        if (!op.tag || typeof op.tag !== "object") return null;
        const tag = {
          id: String(op.tag.id || ""),
          name: String(op.tag.name || "").slice(0, 100),
        };
        if (op.tag.color) tag.color = String(op.tag.color).slice(0, 50);
        if (op.tag.createdAt !== undefined) tag.createdAt = op.tag.createdAt;
        if (op.tag.updatedAt !== undefined) tag.updatedAt = op.tag.updatedAt;
        return { opId, type, timestamp, tag };
      }
      case "tag_update": {
        if (!op.tagId || !op.updates || typeof op.updates !== "object") return null;
        const updates = {};
        if (op.updates.name !== undefined) updates.name = String(op.updates.name).slice(0, 100);
        if (op.updates.color !== undefined) updates.color = String(op.updates.color).slice(0, 50);
        return { opId, type, timestamp, tagId: String(op.tagId), updates };
      }
      case "tag_delete": {
        if (!op.tagId) return null;
        return { opId, type, timestamp, tagId: String(op.tagId) };
      }
      case "session_tag_add":
      case "session_tag_remove": {
        if (!op.sessionId || !op.tagId) return null;
        return { opId, type, timestamp, sessionId: String(op.sessionId), tagId: String(op.tagId) };
      }
      case "session_tag_clear":
      case "session_color_clear": {
        if (!op.sessionId) return null;
        return { opId, type, timestamp, sessionId: String(op.sessionId) };
      }
      case "session_color_set": {
        if (!op.sessionId || typeof op.color !== "string") return null;
        return { opId, type, timestamp, sessionId: String(op.sessionId), color: String(op.color).slice(0, 50) };
      }
      case "preferences_snapshot": {
        if (!op.clientId || !op.values || typeof op.values !== "object") return null;
        const safeValues = {};
        for (const [k, v] of Object.entries(op.values)) {
          if ((k === "pi-enh-settings-v1" || k.startsWith("pi-enh-plugin-")) && typeof v === "string") {
            safeValues[k] = v;
          }
        }
        return { opId, type, timestamp, clientId: String(op.clientId), values: safeValues };
      }
      default:
        return null;
    }
  }

  function collectPreferenceSnapshotValues() {
    const values = {};
    if (typeof localStorage === "undefined" || !localStorage) return values;
    try {
      const mainSettings = localStorage.getItem(ENHANCEMENT_SETTINGS_STORAGE_KEY);
      if (typeof mainSettings === "string") {
        values[ENHANCEMENT_SETTINGS_STORAGE_KEY] = mainSettings;
      }
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith("pi-enh-plugin-")) {
          const val = localStorage.getItem(key);
          if (typeof val === "string") {
            values[key] = val;
          }
        }
      }
    } catch (e) {}
    return values;
  }

  function queuePreferencesSnapshotIfNeeded(snapshotValues = null) {
    if (!isDurableStateEnabled()) return;
    if (!isPluginEnabled("enhancement-settings-archive")) return;
    if (!hasStoredEnhancementConfigInitially) return;

    const clientId = getOrCreateClientId();
    const values = snapshotValues || collectPreferenceSnapshotValues();
    if (Object.keys(values).length === 0) return;
    const serialized = JSON.stringify(values);
    let lastPendingSnapshot = null;
    for (let i = pendingDecorationOperations.length - 1; i >= 0; i--) {
      const op = pendingDecorationOperations[i];
      if (op && op.type === "preferences_snapshot" && op.clientId === clientId) {
        lastPendingSnapshot = op;
        break;
      }
    }
    if (lastPendingSnapshot) {
      if (JSON.stringify(lastPendingSnapshot.values) === serialized) return;
    } else {
      try { if (localStorage.getItem("pi-enh-preferences-archived-v1") === serialized) return; } catch (e) {}
    }

    recordDecorationOperation({
      type: "preferences_snapshot",
      clientId,
      values,
    });
    void persistDecorationsToServer();
  }

  function restorePendingDecorationOperationsFromStorage() {
    if (!isDurableStateEnabled()) return;
    if (typeof localStorage === "undefined" || !localStorage) return;
    try {
      const recovered = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(DECORATION_OP_PREFIX)) {
          try {
            const raw = localStorage.getItem(key);
            if (raw) {
              let op = null;
              try {
                op = JSON.parse(raw);
              } catch (jsonErr) {
                console.warn("[pi-enh] 发现损坏的 Outbox 记录(坏JSON)，保全原键不删除:", key, jsonErr?.message);
                continue;
              }
              if (op && typeof op === "object" && op.opId && op.type) {
                recovered.push(op);
                const ts = Number(op.timestamp) || 0;
                if (ts > lastKnownOutboxTimestamp) {
                  lastKnownOutboxTimestamp = ts;
                }
              } else {
                console.warn("[pi-enh] 发现无效或未知类型的 Outbox 记录，保全原键不删除:", key, op);
              }
            }
          } catch (e) {
            console.warn("[pi-enh] 读取 Outbox 异常，保全原键:", key, e?.message);
          }
        }
      }
      if (recovered.length > 0) {
        recovered.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
        const existingIds = new Set(pendingDecorationOperations.map((o) => o.opId));
        for (const op of recovered) {
          if (!existingIds.has(op.opId)) {
            pendingDecorationOperations.push(op);
            existingIds.add(op.opId);
          }
        }
        pendingDecorationOperations.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
      }
    } catch (e) {}
  }

  function applyDurableStateToLocal(state) {
    if (!state || typeof state !== "object") return;

    if (Array.isArray(state.sessionTagsDefinitions)) {
      const rawDefs = state.sessionTagsDefinitions;
      const rawMappings = (state.sessionTagMappings && typeof state.sessionTagMappings === "object" && !Array.isArray(state.sessionTagMappings))
        ? state.sessionTagMappings
        : {};

      const { defs: replayedDefs, mappings: replayedMappings } = replayPendingDecorationOperations(rawDefs, rawMappings);
      writeSessionTagsDefinitions(replayedDefs);
      writeSessionTagMappings(replayedMappings);
      syncSessionTags();
      window.__PI_ENH_RERENDER_SESSIONS__?.();
    }

    if (state.sessionColors && typeof state.sessionColors === "object" && !Array.isArray(state.sessionColors)) {
      const validRemoteColors = Object.fromEntries(
        Object.entries(state.sessionColors).filter(([sId, c]) => sId && SESSION_COLOR_IDS.has(c))
      );
      for (const op of pendingDecorationOperations) {
        if (op && op.type === "session_color_set" && op.sessionId && SESSION_COLOR_IDS.has(op.color)) {
          validRemoteColors[op.sessionId] = op.color;
        } else if (op && op.type === "session_color_clear" && op.sessionId) {
          delete validRemoteColors[op.sessionId];
        }
      }
      writeSessionColors(validRemoteColors);
      syncSessionColorEffects();
    }
  }

  let activeDurableStateSyncPromise = null;
  async function syncDurableState(force = false) {
    if (isDisposed) return Promise.resolve();
    if (activeDurableStateSyncPromise) return activeDurableStateSyncPromise;
    activeDurableStateSyncPromise = (async () => {
      try {
        const isNative = window.__PI_ENH_NATIVE_STATE_API__ === true;
        const endpoint = isNative
          ? `${getDurableStateBaseUrl()}/enhancement-state`
          : `${getDurableStateBaseUrl()}/enhancement-state?instance=${getDurableStateInstanceParam()}`;
        let res, data;
        try {
          const fetchRes = await fetchModelsConfigBounded(endpoint, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            readJson: true,
          }, 15000);
          res = fetchRes?.resp;
          data = fetchRes?.json;
        } catch (netErr) {
          console.warn("[pi-enh] 独立状态服务读取离线或失败，保留本地缓存:", netErr?.message);
          return;
        }

        if (!res?.ok || !isValidDurablePostResponse({ ...data, acknowledgedOpIds: [] }, [])) {
          console.warn("[pi-enh] 独立状态服务返回异常或格式错误:", res?.status);
          return;
        }

        const remoteRevision = Number(data.revision) || 0;
        const localDurableRev = getLocalDurableStateRevision();
        const currentLocalDefs = readSessionTagsDefinitions();
        const currentLocalMappings = readSessionTagMappings();
        const isLocalEmpty = currentLocalDefs.length === 0 && Object.keys(currentLocalMappings).length === 0;

        // 契约规则 5：即使 force 也拒绝低于当前 durableRev 响应；晚到 GET 绝不覆盖已 ack 的 POST
        if (localDurableRev > 0 && remoteRevision < localDurableRev) {
          console.warn(`[pi-enh] 远端 revision (${remoteRevision}) 低于本地当前 revision (${localDurableRev})，即使 force 也拒绝回退覆盖本地状态`);
          return;
        }

        const shouldApply = (localDurableRev === 0 && isLocalEmpty) || (remoteRevision >= localDurableRev);
        if (!shouldApply) return;

        const backupResult = saveSessionTagsBackupSnapshotIfNeeded(
          currentLocalDefs,
          currentLocalMappings,
          localDurableRev,
          data.state.sessionTagsDefinitions,
          data.state.sessionTagMappings
        );
        if (backupResult && backupResult.needed && !backupResult.ok) {
          console.error("[pi-enh] 本地标签快照备份写入失败，放弃覆盖本地状态:", backupResult.error);
          return;
        }

        applyDurableStateToLocal(data.state);

        if (remoteRevision > 0) {
          setLocalDurableStateRevision(remoteRevision);
        }

        const tagsPanel = typeof document !== "undefined" ? document.querySelector(".pi-enh-tags-panel") : null;
        const nav = typeof document !== "undefined" ? document.querySelector(".settings-section-tabs") : null;
        if (tagsPanel && tagsPanel.style.display !== "none" && typeof renderTagsPanel === "function") {
          renderTagsPanel(tagsPanel, nav);
        }
      } catch (e) {
        console.error("[pi-enh] 独立状态同步异常:", e);
      } finally {
        activeDurableStateSyncPromise = null;
      }
    })();
    return activeDurableStateSyncPromise;
  }

  let decorationOpSequence = 0;
  pendingDecorationOperations = [];
  let pendingPersistDecorationsTimer = null;
  let pendingPersistDecorationsResolvers = [];

  function recordDecorationOperation(op) {
    decorationOpSequence += 1;
    const opId = generateDecorationOpUuid();
    const timestamp = getNextOutboxTimestamp();
    const record = {
      ...op,
      opId,
      timestamp,
    };
    if (isDurableStateEnabled() && typeof localStorage !== "undefined" && localStorage && typeof localStorage.setItem === "function") {
      try {
        localStorage.setItem(DECORATION_OP_PREFIX + opId, JSON.stringify(record));
      } catch (e) {
        console.error("[pi-enh] 无法写入本地 Outbox 键:", e);
        notifySaveWarning("尚未可靠保存，请勿关闭页面");
      }
    }
    pendingDecorationOperations.push(record);
    return record;
  }

  function applyDecorationOperations(baseConfig, operations) {
    const updatedConfig = {
      ...baseConfig,
      sessionColors: { ...(baseConfig?.sessionColors || {}) },
      sessionTagsDefinitions: Array.isArray(baseConfig?.sessionTagsDefinitions)
        ? baseConfig.sessionTagsDefinitions.map((t) => ({ ...t }))
        : [],
      sessionTagMappings:
        baseConfig?.sessionTagMappings && typeof baseConfig.sessionTagMappings === "object" && !Array.isArray(baseConfig.sessionTagMappings)
          ? Object.fromEntries(
              Object.entries(baseConfig.sessionTagMappings).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v])
            )
          : {},
    };

    let hasColorChanges = false;
    let hasTagChanges = false;
    const tagIdRemap = new Map();

    for (const op of operations) {
      if (!op || typeof op !== "object") continue;

      if (op.type === "preferences_snapshot") {
        continue;
      }

      if (op.type === "session_color_set") {
        if (op.sessionId && typeof op.color === "string" && SESSION_COLOR_IDS.has(op.color)) {
          updatedConfig.sessionColors[op.sessionId] = op.color;
          hasColorChanges = true;
        }
      } else if (op.type === "session_color_clear") {
        if (op.sessionId && updatedConfig.sessionColors[op.sessionId]) {
          delete updatedConfig.sessionColors[op.sessionId];
          hasColorChanges = true;
        }
      } else if (op.type === "tag_create") {
        if (op.tag && op.tag.id && typeof op.tag.name === "string") {
          const trimmedName = op.tag.name.trim().toLowerCase();
          const existingRemote = updatedConfig.sessionTagsDefinitions.find(
            (t) => (t?.name || "").trim().toLowerCase() === trimmedName
          );
          if (existingRemote) {
            // 同名 create 若 remote 已有须用其原 ID 并重映射同批次新关联，禁止自动删除已有不同 ID 的同名定义
            tagIdRemap.set(op.tag.id, existingRemote.id);
          } else {
            updatedConfig.sessionTagsDefinitions.push({ ...op.tag });
          }
          hasTagChanges = true;
        }
      } else if (op.type === "tag_update") {
        const targetId = tagIdRemap.get(op.tagId) || op.tagId;
        const targetTag = updatedConfig.sessionTagsDefinitions.find((t) => t.id === targetId);
        if (targetTag && op.updates) {
          if (typeof op.updates.name === "string" && op.updates.name.trim()) {
            targetTag.name = op.updates.name.trim();
          }
          if (typeof op.updates.color === "string" && op.updates.color.trim()) {
            targetTag.color = op.updates.color.trim();
          }
          hasTagChanges = true;
        }
      } else if (op.type === "tag_delete") {
        const targetId = tagIdRemap.get(op.tagId) || op.tagId;
        const beforeLen = updatedConfig.sessionTagsDefinitions.length;
        updatedConfig.sessionTagsDefinitions = updatedConfig.sessionTagsDefinitions.filter((t) => t.id !== targetId);
        if (updatedConfig.sessionTagsDefinitions.length !== beforeLen) {
          hasTagChanges = true;
        }
        for (const sId of Object.keys(updatedConfig.sessionTagMappings)) {
          if (Array.isArray(updatedConfig.sessionTagMappings[sId]) && updatedConfig.sessionTagMappings[sId].includes(targetId)) {
            updatedConfig.sessionTagMappings[sId] = updatedConfig.sessionTagMappings[sId].filter((id) => id !== targetId);
            if (updatedConfig.sessionTagMappings[sId].length === 0) {
              delete updatedConfig.sessionTagMappings[sId];
            }
            hasTagChanges = true;
          }
        }
      } else if (op.type === "session_tag_add") {
        if (op.sessionId && op.tagId) {
          const targetId = tagIdRemap.get(op.tagId) || op.tagId;
          // Reject only this new invalid association; never clean historical mappings.
          if (!updatedConfig.sessionTagsDefinitions.some((tag) => tag?.id === targetId)) continue;
          const currentList = Array.isArray(updatedConfig.sessionTagMappings[op.sessionId])
            ? [...updatedConfig.sessionTagMappings[op.sessionId]]
            : [];
          if (!currentList.includes(targetId)) {
            currentList.push(targetId);
            updatedConfig.sessionTagMappings[op.sessionId] = currentList;
            hasTagChanges = true;
          }
        }
      } else if (op.type === "session_tag_remove") {
        if (op.sessionId && op.tagId) {
          const targetId = tagIdRemap.get(op.tagId) || op.tagId;
          if (Array.isArray(updatedConfig.sessionTagMappings[op.sessionId])) {
            const filtered = updatedConfig.sessionTagMappings[op.sessionId].filter((id) => id !== targetId);
            if (filtered.length !== updatedConfig.sessionTagMappings[op.sessionId].length) {
              if (filtered.length === 0) {
                delete updatedConfig.sessionTagMappings[op.sessionId];
              } else {
                updatedConfig.sessionTagMappings[op.sessionId] = filtered;
              }
              hasTagChanges = true;
            }
          }
        }
      } else if (op.type === "session_tag_clear") {
        if (op.sessionId && updatedConfig.sessionTagMappings[op.sessionId]) {
          delete updatedConfig.sessionTagMappings[op.sessionId];
          hasTagChanges = true;
        }
      }
    }

    if (!hasColorChanges) {
      if (baseConfig && typeof baseConfig.sessionColors !== "undefined") {
        updatedConfig.sessionColors = baseConfig.sessionColors;
      } else {
        delete updatedConfig.sessionColors;
      }
      if (baseConfig && typeof baseConfig.sessionColorsRevision !== "undefined") {
        updatedConfig.sessionColorsRevision = baseConfig.sessionColorsRevision;
      } else {
        delete updatedConfig.sessionColorsRevision;
      }
    }

    if (!hasTagChanges) {
      if (baseConfig && typeof baseConfig.sessionTagsDefinitions !== "undefined") {
        updatedConfig.sessionTagsDefinitions = baseConfig.sessionTagsDefinitions;
      } else {
        delete updatedConfig.sessionTagsDefinitions;
      }
      if (baseConfig && typeof baseConfig.sessionTagMappings !== "undefined") {
        updatedConfig.sessionTagMappings = baseConfig.sessionTagMappings;
      } else {
        delete updatedConfig.sessionTagMappings;
      }
      if (baseConfig && typeof baseConfig.sessionTagsRevision !== "undefined") {
        updatedConfig.sessionTagsRevision = baseConfig.sessionTagsRevision;
      } else {
        delete updatedConfig.sessionTagsRevision;
      }
    }

    return {
      updatedConfig,
      hasColorChanges,
      hasTagChanges,
      tagIdRemap,
    };
  }

  function applyLocalTagRemap(remap) {
    if (!remap || !(remap instanceof Map) || remap.size === 0) return;
    try {
      const defs = readSessionTagsDefinitions();
      let defsChanged = false;
      for (const tag of defs) {
        if (tag && remap.has(tag.id)) {
          tag.id = remap.get(tag.id);
          defsChanged = true;
        }
      }
      if (defsChanged) {
        const seen = new Set();
        const uniqueDefs = [];
        for (const t of defs) {
          if (!seen.has(t.id)) {
            seen.add(t.id);
            uniqueDefs.push(t);
          }
        }
        writeSessionTagsDefinitions(uniqueDefs);
      }

      const mappings = readSessionTagMappings();
      let mappingsChanged = false;
      for (const [sId, list] of Object.entries(mappings)) {
        if (Array.isArray(list)) {
          let listModified = false;
          const nextList = list.map((id) => {
            if (remap.has(id)) {
              listModified = true;
              return remap.get(id);
            }
            return id;
          });
          if (listModified) {
            mappings[sId] = Array.from(new Set(nextList));
            mappingsChanged = true;
          }
        }
      }
      if (mappingsChanged) {
        writeSessionTagMappings(mappings);
      }

      for (const op of pendingDecorationOperations) {
        if (!op) continue;
        if (op.tagId && remap.has(op.tagId)) {
          op.tagId = remap.get(op.tagId);
        }
        if (op.tag && op.tag.id && remap.has(op.tag.id)) {
          op.tag.id = remap.get(op.tag.id);
        }
      }
    } catch (e) {}
  }

  async function persistDecorationsToServer() {
    if (isDisposed) return Promise.resolve(false);
    // 契约不变量：无待提交操作时公开 persist 函数不发起请求
    if (pendingDecorationOperations.length === 0) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      pendingPersistDecorationsResolvers.push(resolve);
      if (pendingPersistDecorationsTimer) {
        clearTimeout(pendingPersistDecorationsTimer);
      }
      pendingPersistDecorationsTimer = setTimeout(() => {
        pendingPersistDecorationsTimer = null;
        const currentResolvers = pendingPersistDecorationsResolvers;
        pendingPersistDecorationsResolvers = [];

        if (isDurableStateEnabled()) {
          durableStateCommitLock = durableStateCommitLock.then(async () => {
            if (isDisposed) {
              currentResolvers.forEach((r) => r(false));
              return false;
            }
            if (pendingDecorationOperations.length === 0) {
              currentResolvers.forEach((r) => r(true));
              return true;
            }

            const batchToCommit = pendingDecorationOperations.slice(0, 100).map((op) => JSON.parse(JSON.stringify(op)));
            const sanitizedOperations = batchToCommit.map(sanitizeOperationForServer).filter(Boolean);

            if (sanitizedOperations.length === 0) {
              // 契约规则 2：sanitizedOperations 为空绝不许无 ack 删键，严禁假成功！
              console.warn("[pi-enh] 当前批次操作无可规范化提交项，保留本地队列与键，禁止无 ack 删除");
              currentResolvers.forEach((r) => r(false));
              return false;
            }

            const sentOpIds = sanitizedOperations.map((o) => o.opId);

            try {
              const isNative = window.__PI_ENH_NATIVE_STATE_API__ === true;
        const endpoint = isNative
          ? `${getDurableStateBaseUrl()}/enhancement-state/operations`
          : `${getDurableStateBaseUrl()}/enhancement-state/operations?instance=${getDurableStateInstanceParam()}`;
              let resp, result;
              try {
                const fetchRes = await fetchModelsConfigBounded(endpoint, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify({ operations: sanitizedOperations }),
                  readJson: true,
                }, 15000);
                resp = fetchRes?.resp;
                result = fetchRes?.json;
              } catch (netErr) {
                console.error("[pi-enh] 独立状态服务提交网络/超时异常:", netErr?.message);
                scheduleDurableStateRetry();
                currentResolvers.forEach((r) => r(false));
                return false;
              }

              if (!resp?.ok) {
                console.error("[pi-enh] 独立状态服务提交失败:", resp?.status, resp?.statusText);
                scheduleDurableStateRetry();
                currentResolvers.forEach((r) => r(false));
                return false;
              }

              // 契约规则 3：严格要求 storageVersion=1、正整数 revision、完整合法 state 四字段、ack 数组全部在本次 sentIds 内
              if (!isValidDurablePostResponse(result, sentOpIds)) {
                console.error("[pi-enh] 独立状态服务响应缺失合法字段或 ACK 不在本次 sentIds 内，拒绝清空队列:", result);
                scheduleDurableStateRetry();
                currentResolvers.forEach((r) => r(false));
                return false;
              }

              // 响应完全合法，成功处理 ack
              resetDurableRetry();

              const ackSet = new Set(result.acknowledgedOpIds);
              for (const op of sanitizedOperations) {
                if (op.type === "preferences_snapshot" && ackSet.has(op.opId)) {
                  try { localStorage.setItem("pi-enh-preferences-archived-v1", JSON.stringify(op.values)); } catch (e) {}
                }
              }
              for (const id of ackSet) {
                try { localStorage?.removeItem(DECORATION_OP_PREFIX + id); } catch (e) {}
              }
              pendingDecorationOperations = pendingDecorationOperations.filter((op) => !ackSet.has(op.opId));

              if (result.tagIdRemap && typeof result.tagIdRemap === "object") {
                const remapMap = new Map(Object.entries(result.tagIdRemap));
                if (remapMap.size > 0) {
                  applyLocalTagRemap(remapMap);
                }
              }

              const respRev = Number(result.revision) || 0;
              const currentLocalRev = getLocalDurableStateRevision();
              // 契约规则 5：POST 响应也拒绝低于当前 revision 覆盖
              if (respRev >= currentLocalRev) {
                setLocalDurableStateRevision(respRev);
                if (result.state && typeof result.state === "object") {
                  applyDurableStateToLocal(result.state);
                }
              } else {
                console.warn(`[pi-enh] POST 响应 revision (${respRev}) 低于本地 (${currentLocalRev})，保留本地较新版本`);
              }

              if (pendingDecorationOperations.length > 0 && !isDisposed) {
                void persistDecorationsToServer();
              }

              currentResolvers.forEach((r) => r(true));
              return true;
            } catch (err) {
              console.error("[pi-enh] 独立状态服务处理异常:", err?.message || err);
              scheduleDurableStateRetry();
              currentResolvers.forEach((r) => r(false));
              return false;
            }
          }).catch((err) => {
            scheduleDurableStateRetry();
            currentResolvers.forEach((r) => r(false));
            return false;
          });
          return;
        }

        runWithModelsConfigLock(async () => {
          if (isDisposed) {
            currentResolvers.forEach((r) => r(false));
            return false;
          }

          // 必须在获得锁后取当前未提交队列快照，批次深拷贝
          if (pendingDecorationOperations.length === 0) {
            currentResolvers.forEach((r) => r(true));
            return true;
          }

          const batchToCommit = pendingDecorationOperations.map((op) => JSON.parse(JSON.stringify(op)));

          try {
            let currentConfig = null;
            try {
              const { resp: getResp, json: data } = await fetchModelsConfigBounded("/api/models-config", { cache: "no-store", readJson: true });
              if (getResp?.ok && data && typeof data === "object" && !Array.isArray(data) && data.providers && typeof data.providers === "object" && !Array.isArray(data.providers)) {
                currentConfig = data;
              } else {
                console.error("[pi-enh] models-config GET returned invalid data structure for decorations");
              }
            } catch (e) {
              console.error("[pi-enh] models-config GET network error for decorations:", e?.message || "network error");
            }

            if (!currentConfig || isDisposed) {
              // 失败保留，不制造重试循环
              currentResolvers.forEach((r) => r(false));
              return false;
            }

            // 应用待提交操作批次至远端最新 config 的克隆
            const { updatedConfig, hasColorChanges, hasTagChanges, tagIdRemap } = applyDecorationOperations(currentConfig, batchToCommit);

            // 若无实质修改，直接清理当前批次
            if (!hasColorChanges && !hasTagChanges) {
              const batchIds = new Set(batchToCommit.map((op) => op.opId));
              for (const id of batchIds) {
                try { localStorage?.removeItem(DECORATION_OP_PREFIX + id); } catch (e) {}
              }
              pendingDecorationOperations = pendingDecorationOperations.filter((op) => !batchIds.has(op.opId));
              currentResolvers.forEach((r) => r(true));
              return true;
            }

            const putPayload = { ...updatedConfig };
            const now = Date.now();
            if (hasColorChanges) {
              putPayload.sessionColorsRevision = now;
            }
            if (hasTagChanges) {
              putPayload.sessionTagsRevision = now;
            }

            const { resp: putResp } = await fetchModelsConfigBounded("/api/models-config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(putPayload),
              readJson: false,
            });

            const ok = Boolean(putResp?.ok) && !isDisposed;
            if (!ok) {
              console.error("[pi-enh] persistDecorationsToServer PUT failed:", putResp?.status, putResp?.statusText);
              // 失败保留，不制造重试循环
              currentResolvers.forEach((r) => r(false));
              return false;
            }

            // 批次成功仅移除该批次操作，不吞并在途新操作
            const batchIds = new Set(batchToCommit.map((op) => op.opId));
            for (const id of batchIds) {
              try { localStorage?.removeItem(DECORATION_OP_PREFIX + id); } catch (e) {}
            }
            pendingDecorationOperations = pendingDecorationOperations.filter((op) => !batchIds.has(op.opId));

            // 若发生同名新建重用远端 ID，同步更新本地 definitions, mappings 与队列
            if (tagIdRemap && tagIdRemap.size > 0) {
              applyLocalTagRemap(tagIdRemap);
            }

            // 更新本地 revision
            if (hasColorChanges) {
              setLocalSessionColorsRevision(now);
            }
            if (hasTagChanges) {
              setLocalSessionTagsRevision(now);
            }

            currentResolvers.forEach((r) => r(true));
            return true;
          } catch (err) {
            console.error("[pi-enh] persistDecorationsToServer error:", err?.message || "unknown error");
            // 失败保留，不制造重试循环
            currentResolvers.forEach((r) => r(false));
            return false;
          }
        });
      }, 150);
    });
  }

  async function persistSessionColorsToServer(colorsObj) {
    const colors = colorsObj || readSessionColors();
    const revision = isDurableStateEnabled() ? getLocalDurableStateRevision() : getLocalSessionColorsRevision();

    // 1. 同设备跨标签页广播
    try {
      crossDeviceSyncChannel?.postMessage({
        type: "session_colors_updated",
        sessionColors: colors,
        revision: revision,
        at: Date.now(),
      });
    } catch (e) {}

    // 2. 统一合流操作批次持久化至服务端 models-config
    return persistDecorationsToServer();
  }

  let activeSessionColorsSyncPromise = null;
  function syncManifestSessionColors(force = false) {
    if (isDurableStateEnabled()) {
      return syncDurableState(force);
    }
    if (activeSessionColorsSyncPromise) return activeSessionColorsSyncPromise;
    activeSessionColorsSyncPromise = (async () => {
      try {
        const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
        if (!activeFetch) return;

        const resp = await activeFetch("/api/models-config", { cache: "no-store" });
        if (!resp?.ok) return;
        const data = await resp.json();
        const remoteColors = data?.sessionColors;
        const remoteRevision = Number(data?.sessionColorsRevision) || 0;

        if (!remoteColors || typeof remoteColors !== "object" || Array.isArray(remoteColors)) return;

        const localRev = getLocalSessionColorsRevision();
        const localRaw = localStorage.getItem(SESSION_COLOR_STORAGE_KEY);
        const isLocalEmpty = !localRaw || localRaw === "{}";

        // 服务端权威判定：新终端/空配置或服务端版本更新时强制对齐
        const shouldApply = force || isLocalEmpty || (remoteRevision > 0 && remoteRevision >= localRev);

        if (shouldApply) {
          const validRemoteColors = Object.fromEntries(
            Object.entries(remoteColors).filter(([sessionId, color]) => sessionId && SESSION_COLOR_IDS.has(color))
          );
          // 重放本地待处理的颜色操作，避免丢本地明确编辑
          for (const op of pendingDecorationOperations) {
            if (op && op.type === "session_color_set" && op.sessionId && SESSION_COLOR_IDS.has(op.color)) {
              validRemoteColors[op.sessionId] = op.color;
            } else if (op && op.type === "session_color_clear" && op.sessionId) {
              delete validRemoteColors[op.sessionId];
            }
          }
          writeSessionColors(validRemoteColors);
          if (remoteRevision > 0) setLocalSessionColorsRevision(remoteRevision);
          syncSessionColorEffects();
        }
      } catch (e) {
      } finally {
        activeSessionColorsSyncPromise = null;
      }
    })();
    return activeSessionColorsSyncPromise;
  }

  function readSessionColors() {
    try {
      const stored = JSON.parse(localStorage.getItem(SESSION_COLOR_STORAGE_KEY) || "{}");
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
      return Object.fromEntries(Object.entries(stored).filter(([sessionId, color]) => sessionId && SESSION_COLOR_IDS.has(color)));
    } catch (e) {
      return {};
    }
  }

  function writeSessionColors(colors) {
    try {
      localStorage.setItem(SESSION_COLOR_STORAGE_KEY, JSON.stringify(colors));
    } catch (e) {
      console.error("[pi-enh] 写入本地会话颜色失败:", e);
      notifySaveWarning("尚未可靠保存，请勿关闭页面");
    }
  }

  function removeSessionColorEffects() {
    for (const row of document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]")) {
      row.removeAttribute("data-pi-enh-session-color");
    }
  }

  function syncSessionColorEffects() {
    if (!isPluginEnabled("session-color")) {
      removeSessionColorEffects();
      return;
    }
    const colors = readSessionColors();
    for (const row of document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]")) {
      const sessionId = row.getAttribute("data-pi-enh-session-id");
      const color = colors[sessionId];
      if (color) row.setAttribute("data-pi-enh-session-color", color);
      else row.removeAttribute("data-pi-enh-session-color");
    }
  }

  function setSessionColor(sessionId, color) {
    if (!sessionId || !SESSION_COLOR_IDS.has(color)) return false;
    const colors = readSessionColors();
    colors[sessionId] = color;
    writeSessionColors(colors);
    syncSessionColorEffects();
    recordDecorationOperation({
      type: "session_color_set",
      sessionId: sessionId,
      color: color,
    });
    void persistSessionColorsToServer(colors);
    return true;
  }

  function clearSessionColor(sessionId) {
    if (!sessionId) return false;
    const colors = readSessionColors();
    if (!colors[sessionId]) return false;
    delete colors[sessionId];
    writeSessionColors(colors);
    syncSessionColorEffects();
    recordDecorationOperation({
      type: "session_color_clear",
      sessionId: sessionId,
    });
    void persistSessionColorsToServer(colors);
    return true;
  }

  function renderSessionColorMenuItems(sessionId) {
    if (!sessionId || !isPluginEnabled("session-color")) return "";
    const selected = readSessionColors()[sessionId] || "";
    const choices = SESSION_COLOR_PRESETS.map((preset) => `
      <button type="button" class="pi-enh-session-color-choice${selected === preset.id ? " is-selected" : ""}" data-action="set-session-color" data-session-color="${preset.id}" style="--pi-enh-session-color-choice: ${preset.value};" title="设为${preset.name}背景" aria-label="设为${preset.name}背景"></button>
    `).join("");
    return `
      <div class="pi-enh-menu-sep"></div>
      <div class="pi-enh-session-color-label">会话背景颜色</div>
      <div class="pi-enh-session-color-grid" role="group" aria-label="会话背景颜色">${choices}</div>
      <div class="pi-enh-menu-item" data-action="clear-session-color"><span>清除背景颜色</span></div>
    `;
  }

  window.__PI_ENH_SET_SESSION_COLOR__ = setSessionColor;
  window.__PI_ENH_CLEAR_SESSION_COLOR__ = clearSessionColor;
  window.__PI_ENH_SYNC_MANIFEST_SESSION_COLORS__ = syncManifestSessionColors;
  window.__PI_ENH_PERSIST_SESSION_COLORS_TO_SERVER__ = persistSessionColorsToServer;

  // ==========================================
  // 会话多维彩色标签 (Session Tags & Multi-dimensional Management)
  // ==========================================
  const SESSION_TAGS_STORAGE_KEY = "pi-enh-session-tags-definitions-v1";
  const SESSION_TAG_MAPPING_STORAGE_KEY = "pi-enh-session-tags-mapping-v1";
  const SESSION_TAGS_REVISION_KEY = "pi-enh-session-tags-rev";

  function getLocalSessionTagsRevision() {
    try {
      return Number(localStorage.getItem(SESSION_TAGS_REVISION_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setLocalSessionTagsRevision(rev) {
    try {
      localStorage.setItem(SESSION_TAGS_REVISION_KEY, String(rev));
    } catch (e) {}
  }

  async function persistSessionTagsToServer() {
    const defs = readSessionTagsDefinitions();
    const mappings = readSessionTagMappings();
    const revision = isDurableStateEnabled() ? getLocalDurableStateRevision() : getLocalSessionTagsRevision();

    // 1. 同设备跨标签页广播
    try {
      crossDeviceSyncChannel?.postMessage({
        type: "session_tags_updated",
        sessionTagsDefinitions: defs,
        sessionTagMappings: mappings,
        revision: revision,
        at: Date.now(),
      });
    } catch (e) {}

    // 2. 统一合流操作批次持久化至服务端 models-config
    return persistDecorationsToServer();
  }

  const SESSION_TAGS_BACKUP_SNAPSHOT_KEY = "pi-enh-session-tags-backup-snapshot-v1";
  const SESSION_TAGS_BACKUP_LATEST_SNAPSHOT_KEY = "pi-enh-session-tags-backup-latest-snapshot-v1";

  function saveSessionTagsBackupSnapshotIfNeeded(localDefs, localMappings, localRev, remoteDefs, remoteMappings) {
    try {
      if (typeof localStorage === "undefined" || !localStorage) {
        return { needed: false, ok: true };
      }

      const hasLocalDefs = Array.isArray(localDefs) && localDefs.length > 0;
      const hasLocalMappings =
        localMappings && typeof localMappings === "object" && !Array.isArray(localMappings) && Object.keys(localMappings).length > 0;
      if (!hasLocalDefs && !hasLocalMappings) {
        return { needed: false, ok: true };
      }

      let isDifferentOrMore = false;
      if (!Array.isArray(remoteDefs) || remoteDefs.length === 0) {
        isDifferentOrMore = true;
      } else {
        const remoteTagMap = new Map();
        for (const t of remoteDefs) {
          if (t && t.id) remoteTagMap.set(t.id, t);
        }
        for (const t of localDefs) {
          if (!t || !t.id) continue;
          const remoteT = remoteTagMap.get(t.id);
          if (!remoteT || remoteT.name !== t.name || remoteT.color !== t.color) {
            isDifferentOrMore = true;
            break;
          }
        }
        if (!isDifferentOrMore && hasLocalMappings) {
          const safeRemoteMappings = (remoteMappings && typeof remoteMappings === "object" && !Array.isArray(remoteMappings)) ? remoteMappings : {};
          for (const [sId, tagIds] of Object.entries(localMappings)) {
            if (Array.isArray(tagIds) && tagIds.length > 0) {
              const remoteIds = Array.isArray(safeRemoteMappings[sId]) ? safeRemoteMappings[sId] : [];
              const remoteSet = new Set(remoteIds);
              for (const tid of tagIds) {
                if (!remoteSet.has(tid)) {
                  isDifferentOrMore = true;
                  break;
                }
              }
            }
            if (isDifferentOrMore) break;
          }
        }
      }

      if (!isDifferentOrMore) {
        return { needed: false, ok: true };
      }

      const snapshot = {
        definitions: localDefs,
        mappings: localMappings,
        revision: localRev,
        savedAt: Date.now(),
      };
      const snapshotStr = JSON.stringify(snapshot);

      // 原首次快照保留（已有快照则不覆盖）
      const existingFirst = localStorage.getItem(SESSION_TAGS_BACKUP_SNAPSHOT_KEY);
      if (!existingFirst) {
        localStorage.setItem(SESSION_TAGS_BACKUP_SNAPSHOT_KEY, snapshotStr);
      }

      // 追加/更新单独 latest 快照保存后续不同本地数据（不覆盖首次）
      localStorage.setItem(SESSION_TAGS_BACKUP_LATEST_SNAPSHOT_KEY, snapshotStr);

      return { needed: true, ok: true };
    } catch (e) {
      console.error("[pi-enh] Failed to save session tags backup snapshot:", e);
      return { needed: true, ok: false, error: e };
    }
  }

  function replayPendingDecorationOperations(baseDefs, baseMappings, operations = pendingDecorationOperations) {
    const fakeConfig = {
      sessionTagsDefinitions: baseDefs,
      sessionTagMappings: baseMappings,
    };
    const { updatedConfig, tagIdRemap } = applyDecorationOperations(fakeConfig, operations || []);
    if (tagIdRemap && tagIdRemap.size > 0) {
      applyLocalTagRemap(tagIdRemap);
    }
    return {
      defs: updatedConfig.sessionTagsDefinitions,
      mappings: updatedConfig.sessionTagMappings,
      tagIdRemap,
    };
  }

  let activeSessionTagsSyncPromise = null;
  function syncManifestSessionTags(force = false) {
    if (isDurableStateEnabled()) {
      return syncDurableState(force);
    }
    if (isDisposed) return Promise.resolve();
    if (activeSessionTagsSyncPromise) return activeSessionTagsSyncPromise;
    activeSessionTagsSyncPromise = runWithModelsConfigLock(async () => {
      if (isDisposed) return;
      try {
        const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
        if (!activeFetch) return;

        let remoteDefs = null;
        let remoteMappings = null;
        let remoteRevision = 0;
        let isAuthoritativeRemote = false;

        // 1. 优先从权威服务端配置 /api/models-config 拉取
        try {
          const { resp, json: data } = await fetchModelsConfigBounded("/api/models-config", { cache: "no-store", readJson: true });
          if (resp?.ok) {
            // 契约：服务端字段缺失/类型错误不能被当成合法空数据清本地
            if (
              data &&
              typeof data === "object" &&
              !Array.isArray(data) &&
              data.providers &&
              typeof data.providers === "object" &&
              !Array.isArray(data.providers) &&
              Array.isArray(data.sessionTagsDefinitions) &&
              data.sessionTagMappings && typeof data.sessionTagMappings === "object" && !Array.isArray(data.sessionTagMappings)
            ) {
              remoteDefs = data.sessionTagsDefinitions;
              remoteMappings = (data?.sessionTagMappings && typeof data.sessionTagMappings === "object" && !Array.isArray(data.sessionTagMappings)) ? data.sessionTagMappings : {};
              remoteRevision = Number(data?.sessionTagsRevision) || 0;
              isAuthoritativeRemote = true;
            }
          }
        } catch (e) {}

        const currentLocalDefs = readSessionTagsDefinitions();
        const currentLocalMappings = readSessionTagMappings();
        const localRev = getLocalSessionTagsRevision();
        const isLocalEmpty = currentLocalDefs.length === 0 && Object.keys(currentLocalMappings).length === 0;

        // 契约：无有效远端时不得静态 fallback 覆盖非空本地
        if (!isAuthoritativeRemote) {
          if (!isLocalEmpty) {
            return;
          }
          // 即使 force 也不能用静态清单替换非空本地缓存；空端仅只读兜底。
          try {
            const res = await activeFetch("/pi-tags-manifest.json?v=" + Date.now(), { cache: "no-store" });
            if (res?.ok) {
              const json = await res.json();
              if (Array.isArray(json?.definitions)) {
                remoteDefs = json.definitions;
                remoteMappings = (json?.mappings && typeof json.mappings === "object" && !Array.isArray(json.mappings)) ? json.mappings : {};
                remoteRevision = Number(json?.revision) || 0;
              }
            }
          } catch (e) {}

          // 兜底内置 Manifest（如启动时 patch-pi-web.js 注入的静态备份，绝对不触发写入）
          if (!Array.isArray(remoteDefs) && typeof window !== "undefined" && window.__PI_ENH_TAGS_MANIFEST__) {
            try {
              const injected = window.__PI_ENH_TAGS_MANIFEST__;
              if (Array.isArray(injected?.definitions)) {
                remoteDefs = injected.definitions;
                remoteMappings = (injected?.mappings && typeof injected.mappings === "object" && !Array.isArray(injected.mappings)) ? injected.mappings : {};
                remoteRevision = Number(injected?.revision) || 0;
              }
            } catch (e) {}
          }
        }

        // 契约不变量：远端未返回有效定义列表时只读拉取安全退出，严禁任何远端空/失败→自动persist！
        if (!Array.isArray(remoteDefs)) return;

        // 请求/版本校验：旧 GET 回晚时（remoteRevision 比本地当前 revision 更旧）且非 force，绝不覆盖本地新状态！
        if (remoteRevision > 0 && remoteRevision < localRev && !force) {
          return;
        }

        // 判定是否应当应用：强制对齐、本地为空、或者服务端为权威有效返回、或远端版本更新
        const shouldApply = force || isLocalEmpty || isAuthoritativeRemote || (remoteRevision > 0 && remoteRevision >= localRev);
        if (!shouldApply) return;

        // 应用远端前若本地有不同/更多数据，先保存本地 tag 定义 + mapping + revision 到独立 localStorage 恢复快照
        const backupResult = saveSessionTagsBackupSnapshotIfNeeded(currentLocalDefs, currentLocalMappings, localRev, remoteDefs, remoteMappings);
        // 契约：需要备份而 storage 写失败时不应用远端
        if (backupResult && backupResult.needed && !backupResult.ok) {
          console.error("[pi-enh] 放弃应用远端配置：本地标签快照备份写入失败，防止数据丢失", backupResult.error);
          return;
        }

        // 服务端有效版本优先：基准采用远端数据，本地未持久化的明确待处理操作重放于其上，避免丢本地明确编辑
        const { defs: replayedDefs, mappings: replayedMappings } = replayPendingDecorationOperations(remoteDefs, remoteMappings);

        writeSessionTagsDefinitions(replayedDefs);
        writeSessionTagMappings(replayedMappings);

        // 契约不变量：不要用 Date.now 伪造只读同步 revision，采用远端实际 revision
        if (remoteRevision > 0) {
          setLocalSessionTagsRevision(remoteRevision);
        }

        syncSessionTags();
        window.__PI_ENH_RERENDER_SESSIONS__?.();

        const tagsPanel = typeof document !== "undefined" ? document.querySelector(".pi-enh-tags-panel") : null;
        const nav = typeof document !== "undefined" ? document.querySelector(".settings-section-tabs") : null;
        if (tagsPanel && tagsPanel.style.display !== "none" && typeof renderTagsPanel === "function") {
          renderTagsPanel(tagsPanel, nav);
        }
      } catch (e) {
      } finally {
        activeSessionTagsSyncPromise = null;
      }
    });
    return activeSessionTagsSyncPromise;
  }

  const DEFAULT_TAG_PALETTE = [
    { name: "天蓝", color: "#38bdf8", bg: "rgba(56, 189, 248, 0.16)", border: "rgba(56, 189, 248, 0.35)" },
    { name: "翠绿", color: "#34d399", bg: "rgba(52, 211, 153, 0.16)", border: "rgba(52, 211, 153, 0.35)" },
    { name: "珊瑚橙", color: "#fb923c", bg: "rgba(251, 146, 60, 0.16)", border: "rgba(251, 146, 60, 0.35)" },
    { name: "玫红", color: "#f472b6", bg: "rgba(244, 114, 182, 0.16)", border: "rgba(244, 114, 182, 0.35)" },
    { name: "紫罗兰", color: "#a78bfa", bg: "rgba(167, 139, 250, 0.16)", border: "rgba(167, 139, 250, 0.35)" },
    { name: "青碧", color: "#2dd4bf", bg: "rgba(45, 212, 191, 0.16)", border: "rgba(45, 212, 191, 0.35)" },
    { name: "琥珀黄", color: "#facc15", bg: "rgba(250, 204, 21, 0.16)", border: "rgba(250, 204, 21, 0.35)" },
    { name: "朱红", color: "#fb7185", bg: "rgba(251, 113, 133, 0.16)", border: "rgba(251, 113, 133, 0.35)" },
    { name: "靛蓝", color: "#818cf8", bg: "rgba(129, 140, 248, 0.16)", border: "rgba(129, 140, 248, 0.35)" },
    { name: "薄荷绿", color: "#4ade80", bg: "rgba(74, 222, 128, 0.16)", border: "rgba(74, 222, 128, 0.35)" },
    { name: "洋红", color: "#e879f9", bg: "rgba(232, 121, 249, 0.16)", border: "rgba(232, 121, 249, 0.35)" },
    { name: "石墨灰", color: "#9ca3af", bg: "rgba(156, 163, 175, 0.16)", border: "rgba(156, 163, 175, 0.35)" },
  ];

  function getTagPaletteItem(colorHex) {
    const hex = (colorHex || "").toLowerCase();
    const found = DEFAULT_TAG_PALETTE.find((item) => item.color.toLowerCase() === hex);
    if (found) return found;
    return {
      name: "自定义",
      color: colorHex || "#9ca3af",
      bg: "rgba(156, 163, 175, 0.16)",
      border: "rgba(156, 163, 175, 0.35)",
    };
  }

  function readSessionTagsDefinitions() {
    try {
      const raw = localStorage.getItem(SESSION_TAGS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((t) => t && typeof t === "object" && t.id && t.name);
    } catch (e) {
      return [];
    }
  }

  function writeSessionTagsDefinitions(tags) {
    try {
      localStorage.setItem(SESSION_TAGS_STORAGE_KEY, JSON.stringify(tags || []));
    } catch (e) {
      console.error("[pi-enh] 写入本地标签定义失败:", e);
      notifySaveWarning("尚未可靠保存，请勿关闭页面");
    }
  }

  function readSessionTagMappings() {
    try {
      const raw = localStorage.getItem(SESSION_TAG_MAPPING_STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed;
    } catch (e) {
      return {};
    }
  }

  function writeSessionTagMappings(mapping) {
    try {
      localStorage.setItem(SESSION_TAG_MAPPING_STORAGE_KEY, JSON.stringify(mapping || {}));
    } catch (e) {
      console.error("[pi-enh] 写入本地标签映射失败:", e);
      notifySaveWarning("尚未可靠保存，请勿关闭页面");
    }
  }

  function getRecommendedTagColor(existingTags) {
    const tags = Array.isArray(existingTags) ? existingTags : readSessionTagsDefinitions();
    const counts = new Map();
    for (const item of DEFAULT_TAG_PALETTE) {
      counts.set(item.color.toLowerCase(), 0);
    }
    for (const t of tags) {
      if (t?.color) {
        const c = t.color.toLowerCase();
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    let minCount = Infinity;
    let candidates = [];
    for (const item of DEFAULT_TAG_PALETTE) {
      const count = counts.get(item.color.toLowerCase()) || 0;
      if (count < minCount) {
        minCount = count;
        candidates = [item];
      } else if (count === minCount) {
        candidates.push(item);
      }
    }
    const chosen = candidates[Math.floor(Math.random() * candidates.length)] || DEFAULT_TAG_PALETTE[0];
    return chosen;
  }

  function createSessionTag(name, color = null) {
    const trimmed = (name || "").trim();
    if (!trimmed) return null;
    const existingTags = readSessionTagsDefinitions();
    const found = existingTags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
    if (found) return found;

    const assignedColor = color || getRecommendedTagColor(existingTags).color;
    const newTag = {
      id: "tag_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7),
      name: trimmed,
      color: assignedColor,
      createdAt: Date.now(),
    };
    existingTags.push(newTag);
    writeSessionTagsDefinitions(existingTags);
    syncSessionTags();
    recordDecorationOperation({
      type: "tag_create",
      tag: { ...newTag },
    });
    void persistSessionTagsToServer();
    return newTag;
  }

  function updateSessionTag(tagId, updates) {
    if (!tagId || !updates) return false;
    const existingTags = readSessionTagsDefinitions();
    const idx = existingTags.findIndex((t) => t.id === tagId);
    if (idx === -1) return false;

    const appliedUpdates = {};
    if (typeof updates.name === "string" && updates.name.trim()) {
      existingTags[idx].name = updates.name.trim();
      appliedUpdates.name = existingTags[idx].name;
    }
    if (typeof updates.color === "string" && updates.color.trim()) {
      existingTags[idx].color = updates.color.trim();
      appliedUpdates.color = existingTags[idx].color;
    }
    writeSessionTagsDefinitions(existingTags);
    syncSessionTags();
    recordDecorationOperation({
      type: "tag_update",
      tagId: tagId,
      updates: appliedUpdates,
    });
    void persistSessionTagsToServer();
    return true;
  }

  function deleteSessionTag(tagId) {
    if (!tagId) return false;
    const existingTags = readSessionTagsDefinitions();
    const filtered = existingTags.filter((t) => t.id !== tagId);
    writeSessionTagsDefinitions(filtered);

    // 清除会话中对该标签的映射
    const mappings = readSessionTagMappings();
    let changed = false;
    const sessionsBecameEmpty = [];
    for (const sessionId of Object.keys(mappings)) {
      if (Array.isArray(mappings[sessionId]) && mappings[sessionId].includes(tagId)) {
        mappings[sessionId] = mappings[sessionId].filter((id) => id !== tagId);
        if (mappings[sessionId].length === 0) {
          delete mappings[sessionId];
          sessionsBecameEmpty.push(sessionId);
        }
        changed = true;
      }
    }
    if (changed) {
      writeSessionTagMappings(mappings);
      for (const sid of sessionsBecameEmpty) {
        applyInstantVirtualListLayout(sid, true, false);
      }
    }
    syncSessionTags();
    requestSessionListRefresh(false, true);
    recordDecorationOperation({
      type: "tag_delete",
      tagId: tagId,
    });
    void persistSessionTagsToServer();
    return true;
  }

  function getSessionTagIds(sessionId) {
    if (!sessionId) return [];
    const mappings = readSessionTagMappings();
    const ids = mappings[sessionId];
    if (!Array.isArray(ids)) return [];
    const validTags = readSessionTagsDefinitions();
    const validIdSet = new Set(validTags.map((t) => t.id));
    return ids.filter((id) => validIdSet.has(id));
  }

  function getSessionTags(sessionId) {
    const validTags = readSessionTagsDefinitions();
    const validMap = new Map(validTags.map((t) => [t.id, t]));
    return getSessionTagIds(sessionId).map((id) => validMap.get(id)).filter(Boolean);
  }

  function applyInstantVirtualListLayout(changedSessionId, arg2, arg3) {
    if (!changedSessionId) return;

    let delta = 0;
    let newHeight = 0;
    let isTagged = false;

    if (typeof arg2 === "number" && typeof arg3 === "number") {
      // 显式高度模式：applyInstantVirtualListLayout(sessionId, oldTotalHeight, newTotalHeight)
      if (arg2 === arg3) return;
      delta = arg3 - arg2;
      newHeight = arg3;
    } else {
      // 兼容原有标签模式：applyInstantVirtualListLayout(sessionId, hadTagsBefore, hasTagsNow)
      const hadTagsBefore = !!arg2;
      const hasTagsNow = !!arg3;
      if (hadTagsBefore === hasTagsNow) return;
      delta = hasTagsNow ? (SESSION_TAGGED_ITEM_HEIGHT - SESSION_NORMAL_ITEM_HEIGHT) : -(SESSION_TAGGED_ITEM_HEIGHT - SESSION_NORMAL_ITEM_HEIGHT);
      newHeight = (hasTagsNow ? SESSION_TAGGED_ITEM_HEIGHT : SESSION_NORMAL_ITEM_HEIGHT) +
        getSessionOdooAddonsExtraHeight(getSessionOdooAddons(changedSessionId).length);
      isTagged = hasTagsNow;
    }

    const row = getSessionRowById(changedSessionId);
    if (!row) return;

    const currentWrapper = row.parentElement;
    if (!currentWrapper) return;
    const listContainer = currentWrapper.parentElement;
    if (!listContainer) return;

    const currentTop = parseFloat(currentWrapper.style.top) || 0;

    // 1. 同步提升当前项与其外层 wrapper 高度
    currentWrapper.style.height = newHeight + "px";
    row.style.height = newHeight + "px";
    if (isTagged) {
      row.setAttribute("data-pi-enh-has-tags", "true");
    } else if (typeof arg2 !== "number") {
      row.removeAttribute("data-pi-enh-has-tags");
    }

    // 2. 瞬时原子推进下方所有兄弟节点，绝对不留哪怕 1 毫秒的重叠与溢出延迟
    for (const child of listContainer.children) {
      if (child === currentWrapper) continue;
      const childTop = parseFloat(child.style.top);
      if (!isNaN(childTop) && childTop > currentTop) {
        child.style.top = (childTop + delta) + "px";
      }
    }

    // 3. 同步扩充容器总高度
    const containerHeight = parseFloat(listContainer.style.height);
    if (!isNaN(containerHeight)) {
      listContainer.style.height = (containerHeight + delta) + "px";
    }

    // 4. 同步请求 React 刷新以彻底对齐底层 virtualizer 状态
    requestSessionListRefresh(false, true);
  }

  function toggleSessionTag(sessionId, tagId) {
    if (!sessionId || !tagId) return false;
    const hadTagsBefore = getSessionTagIds(sessionId).length > 0;
    const mappings = readSessionTagMappings();
    const current = Array.isArray(mappings[sessionId]) ? [...mappings[sessionId]] : [];
    const idx = current.indexOf(tagId);
    let isAdded = false;
    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      current.push(tagId);
      isAdded = true;
    }
    if (current.length === 0) {
      delete mappings[sessionId];
    } else {
      mappings[sessionId] = current;
    }
    writeSessionTagMappings(mappings);
    const hasTagsNow = getSessionTagIds(sessionId).length > 0;
    applyInstantVirtualListLayout(sessionId, hadTagsBefore, hasTagsNow);
    const row = getSessionRowById(sessionId);
    if (row) syncSessionTagsRow(row, sessionId);
    recordDecorationOperation({
      type: isAdded ? "session_tag_add" : "session_tag_remove",
      sessionId: sessionId,
      tagId: tagId,
    });
    void persistSessionTagsToServer();
    return isAdded;
  }

  function addSessionTag(sessionId, tagId) {
    if (!sessionId || !tagId) return false;
    const hadTagsBefore = getSessionTagIds(sessionId).length > 0;
    const mappings = readSessionTagMappings();
    const current = Array.isArray(mappings[sessionId]) ? [...mappings[sessionId]] : [];
    if (!current.includes(tagId)) {
      current.push(tagId);
      mappings[sessionId] = current;
      writeSessionTagMappings(mappings);
      const hasTagsNow = true;
      applyInstantVirtualListLayout(sessionId, hadTagsBefore, hasTagsNow);
      const row = getSessionRowById(sessionId);
      if (row) syncSessionTagsRow(row, sessionId);
      recordDecorationOperation({
        type: "session_tag_add",
        sessionId: sessionId,
        tagId: tagId,
      });
      void persistSessionTagsToServer();
      return true;
    }
    return true;
  }

  function clearSessionTags(sessionId) {
    if (!sessionId) return false;
    const hadTagsBefore = getSessionTagIds(sessionId).length > 0;
    const mappings = readSessionTagMappings();
    if (!mappings[sessionId]) return false;
    delete mappings[sessionId];
    writeSessionTagMappings(mappings);
    applyInstantVirtualListLayout(sessionId, hadTagsBefore, false);
    const row = getSessionRowById(sessionId);
    if (row) syncSessionTagsRow(row, sessionId);
    recordDecorationOperation({
      type: "session_tag_clear",
      sessionId: sessionId,
    });
    void persistSessionTagsToServer();
    return true;
  }

  function countSessionTagUsage(tagId) {
    if (!tagId) return 0;
    const mappings = readSessionTagMappings();
    let count = 0;
    for (const sid of Object.keys(mappings)) {
      if (Array.isArray(mappings[sid]) && mappings[sid].includes(tagId)) {
        count += 1;
      }
    }
    return count;
  }

  function syncSessionTagsRow(row, sessionId) {
    if (!row || !sessionId) return;

    // 行内重命名守卫：处于编辑状态时隐藏标签
    if (!isPluginEnabled("session-tags") || row.querySelector("input") || row.getAttribute("data-pi-enh-editing") === "true") {
      row.querySelector(".pi-enh-session-tags-row")?.remove();
      row.removeAttribute("data-pi-enh-has-tags");
      return;
    }

    const tags = getSessionTags(sessionId);
    let tagsRow = row.querySelector(".pi-enh-session-tags-row");

    if (tags.length === 0) {
      tagsRow?.remove();
      row.removeAttribute("data-pi-enh-has-tags");
      return;
    }

    row.setAttribute("data-pi-enh-has-tags", "true");

    if (!tagsRow) {
      tagsRow = document.createElement("div");
      tagsRow.className = "pi-enh-session-tags-row";
    }

    const contentHost = row.querySelector(".pi-enh-session-meta")?.parentElement ||
      row.querySelector("div[style*='flex: 1'], div[style*='flex:1']") ||
      row.firstElementChild;

    if (!contentHost) {
      tagsRow.remove();
      return;
    }

    const metaDiv = contentHost.querySelector(".pi-enh-session-meta") ||
      (contentHost.children && contentHost.children.length >= 2 ? contentHost.children[1] : null);

    if (metaDiv && metaDiv.nextSibling !== tagsRow) {
      metaDiv.after(tagsRow);
    } else if (tagsRow.parentElement !== contentHost) {
      contentHost.appendChild(tagsRow);
    }

    const visibleTags = tags.slice(0, 2);
    const overflowCount = tags.length - visibleTags.length;

    let pillsHtml = visibleTags.map((tag) => {
      const palette = getTagPaletteItem(tag.color);
      return `<span class="pi-enh-session-tag-pill" style="background:${palette.bg};border:1px solid ${palette.border};color:${palette.color};" title="${escapeHtml(tag.name)}">
        <span class="pi-enh-tag-dot" style="background:${tag.color};"></span>
        <span class="pi-enh-tag-name">${escapeHtml(tag.name)}</span>
      </span>`;
    }).join("");

    if (overflowCount > 0) {
      const allTagNames = tags.map((t) => t.name).join("、");
      pillsHtml += `<span class="pi-enh-session-tag-pill pi-enh-session-tag-more" style="background:rgba(156,163,175,0.16);border:1px solid rgba(156,163,175,0.35);color:#9ca3af;" title="全部标签：${escapeHtml(allTagNames)}">+${overflowCount}</span>`;
    }

    if (tagsRow.__renderedHtml !== pillsHtml || !tagsRow.firstElementChild) {
      tagsRow.innerHTML = pillsHtml;
      tagsRow.__renderedHtml = pillsHtml;
    }
  }

  function removeSessionTagsRowAll() {
    for (const el of document.querySelectorAll(".pi-enh-session-tags-row")) {
      el.remove();
    }
    for (const row of document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-has-tags]")) {
      row.removeAttribute("data-pi-enh-has-tags");
    }
  }

  function syncSessionTags() {
    if (!isPluginEnabled("session-tags")) {
      removeSessionTagsRowAll();
      syncSessionOdooAddonsLayout();
      return;
    }
    const rows = document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]");
    for (const row of rows) {
      const sessionId = row.getAttribute("data-pi-enh-session-id");
      if (sessionId) {
        syncSessionTagsRow(row, sessionId);
      }
    }
    syncSessionOdooAddonsLayout();
  }

  let activeSessionTagsPopover = null;
  let activeSessionTagsCleanup = null;
  let activeSessionTagsTriggerItem = null;

  function closeSessionTagsPopover(alsoCloseMenu = false) {
    if (activeSessionTagsCleanup) {
      activeSessionTagsCleanup();
      activeSessionTagsCleanup = null;
    }
    if (activeSessionTagsPopover) {
      activeSessionTagsPopover.remove();
      activeSessionTagsPopover = null;
    }
    if (activeSessionTagsTriggerItem) {
      activeSessionTagsTriggerItem.classList.remove("is-submenu-open");
      if (activeSessionTagsTriggerItem._openSubmenuTimer) {
        clearTimeout(activeSessionTagsTriggerItem._openSubmenuTimer);
        activeSessionTagsTriggerItem._openSubmenuTimer = null;
      }
      if (activeSessionTagsTriggerItem._closeSubmenuTimer) {
        clearTimeout(activeSessionTagsTriggerItem._closeSubmenuTimer);
        activeSessionTagsTriggerItem._closeSubmenuTimer = null;
      }
      activeSessionTagsTriggerItem = null;
    }
    if (activeMenu) {
      const activeItem = activeMenu.querySelector('.pi-enh-menu-item[data-action="open-session-tags"]');
      if (activeItem) activeItem.classList.remove("is-submenu-open");
    }
    if (alsoCloseMenu) {
      closeMenu();
    }
  }

  function openSessionTagsPopover(sessionId, triggerItem, event, triggerRect) {
    if (activeSessionTagsPopover && activeSessionTagsPopover.getAttribute("data-session-id") === sessionId) {
      if (triggerItem) {
        activeSessionTagsTriggerItem = triggerItem;
        triggerItem.classList.add("is-submenu-open");
      }
      return activeSessionTagsPopover;
    }
    closeSessionTagsPopover(false);
    if (!sessionId || !isPluginEnabled("session-tags")) return;

    const popover = document.createElement("div");
    popover.className = "pi-enh-session-tags-popover";
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "会话标签选择器");
    popover.setAttribute("data-session-id", sessionId);

    activeSessionTagsTriggerItem = triggerItem || null;
    if (triggerItem) triggerItem.classList.add("is-submenu-open");

    let allTags = readSessionTagsDefinitions();
    let currentTagIds = new Set(getSessionTagIds(sessionId));
    let recommendedColorItem = getRecommendedTagColor(allTags);

    popover.innerHTML = `
      <div class="pi-enh-tags-search-box">
        <input type="text" class="pi-enh-tags-search-input" placeholder="搜索或快速新建标签..." />
      </div>
      <div class="pi-enh-tags-list" role="listbox"></div>
      <div class="pi-enh-tags-popover-footer">
        <button type="button" class="pi-enh-tags-footer-btn pi-enh-tags-manage-btn" data-action="manage-tags">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
          <span>标签管理</span>
        </button>
        <button type="button" class="pi-enh-tags-footer-btn pi-enh-tags-clear-btn" data-action="clear-tags">清除所有标签</button>
      </div>
    `;

    const searchInput = popover.querySelector(".pi-enh-tags-search-input");
    const listEl = popover.querySelector(".pi-enh-tags-list");

    function renderList(query = "") {
      const q = (query || "").trim().toLowerCase();
      const filtered = allTags.filter((t) => t.name.toLowerCase().includes(q));
      const exactMatch = allTags.some((t) => t.name.toLowerCase() === q);

      let html = "";
      if (q && !exactMatch) {
        html += `
          <div class="pi-enh-tag-option pi-enh-tag-create-option" data-tag-name="${escapeHtml(query.trim())}">
            <span class="pi-enh-tag-dot" style="background:${recommendedColorItem.color};"></span>
            <span class="pi-enh-tag-name">+ 创建新标签 "${escapeHtml(query.trim())}"</span>
          </div>
        `;
      }

      if (filtered.length === 0 && !q) {
        html += `<div class="pi-enh-tag-empty">暂无标签，可输入上方文字直接创建</div>`;
      } else {
        for (const tag of filtered) {
          const isSelected = currentTagIds.has(tag.id);
          html += `
            <div class="pi-enh-tag-option${isSelected ? " is-selected" : ""}" data-tag-id="${tag.id}">
              <span class="pi-enh-tag-dot" style="background:${tag.color};"></span>
              <span class="pi-enh-tag-name">${escapeHtml(tag.name)}</span>
              <span class="pi-enh-tag-check">${isSelected ? "✓" : ""}</span>
            </div>
          `;
        }
      }

      listEl.innerHTML = html;
    }

    renderList("");

    let isComposing = false;
    searchInput.addEventListener("compositionstart", () => {
      isComposing = true;
    });
    searchInput.addEventListener("compositionend", () => {
      isComposing = false;
      renderList(searchInput.value);
    });

    searchInput.addEventListener("input", () => {
      renderList(searchInput.value);
    });

    searchInput.addEventListener("keydown", (e) => {
      // 阻止冒泡，避免向上冒泡触发任何全局快捷键
      e.stopPropagation();

      if (e.key === "Enter") {
        // 如果输入法正在打字/选词中，绝对不处理回车，防止未完成的拼音把子菜单关闭
        if (isComposing || e.isComposing || e.keyCode === 229) {
          return;
        }
        e.preventDefault();
        const trimmed = searchInput.value.trim();
        if (!trimmed) return;
        const exact = allTags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
        if (exact) {
          toggleSessionTag(sessionId, exact.id);
          currentTagIds = new Set(getSessionTagIds(sessionId));
          showToast(`已为会话打上「${exact.name}」标签`);
          closeSessionTagsPopover(true);
        } else {
          const created = createSessionTag(trimmed, recommendedColorItem.color);
          if (created) {
            allTags = readSessionTagsDefinitions();
            toggleSessionTag(sessionId, created.id);
            currentTagIds = new Set(getSessionTagIds(sessionId));
            recommendedColorItem = getRecommendedTagColor(allTags);
            searchInput.value = "";
            renderList("");
            showToast(`已创建并为会话打上「${created.name}」标签`);
            closeSessionTagsPopover(true);
          }
        }
      } else if (e.key === "Escape") {
        e.stopPropagation();
        closeSessionTagsPopover(false);
      }
    });

    searchInput.addEventListener("keyup", (e) => {
      e.stopPropagation();
    });
    searchInput.addEventListener("keypress", (e) => {
      e.stopPropagation();
    });

    searchInput.addEventListener("focus", () => {
      if (activeSessionTagsTriggerItem) {
        if (activeSessionTagsTriggerItem._closeSubmenuTimer) {
          clearTimeout(activeSessionTagsTriggerItem._closeSubmenuTimer);
          activeSessionTagsTriggerItem._closeSubmenuTimer = null;
        }
        activeSessionTagsTriggerItem.classList.add("is-submenu-open");
      }
    });

    searchInput.addEventListener("blur", () => {
      setTimeout(() => {
        if (!activeSessionTagsPopover) return;
        const isHovering = (typeof activeSessionTagsPopover.matches === "function" && activeSessionTagsPopover.matches(":hover")) ||
          (activeSessionTagsTriggerItem && typeof activeSessionTagsTriggerItem.matches === "function" && activeSessionTagsTriggerItem.matches(":hover"));
        if (!isHovering && (!document.activeElement || !activeSessionTagsPopover.contains(document.activeElement))) {
          closeSessionTagsPopover(false);
        }
      }, 150);
    });

    listEl.addEventListener("click", (e) => {
      const createItem = e.target.closest(".pi-enh-tag-create-option");
      if (createItem) {
        const tagName = createItem.getAttribute("data-tag-name");
        if (tagName) {
          const created = createSessionTag(tagName, recommendedColorItem.color);
          if (created) {
            allTags = readSessionTagsDefinitions();
            toggleSessionTag(sessionId, created.id);
            currentTagIds = new Set(getSessionTagIds(sessionId));
            recommendedColorItem = getRecommendedTagColor(allTags);
            searchInput.value = "";
            renderList("");
            showToast(`已创建并为会话打上「${created.name}」标签`);
            closeSessionTagsPopover(true);
          }
        }
        return;
      }

      const optionItem = e.target.closest("[data-tag-id]");
      if (optionItem) {
        const tagId = optionItem.getAttribute("data-tag-id");
        if (tagId) {
          const wasSelected = currentTagIds.has(tagId);
          toggleSessionTag(sessionId, tagId);
          currentTagIds = new Set(getSessionTagIds(sessionId));
          const targetTag = allTags.find((t) => t.id === tagId);
          const tagName = targetTag ? targetTag.name : "标签";
          showToast(wasSelected ? `已移除会话「${tagName}」标签` : `已为会话打上「${tagName}」标签`);
          closeSessionTagsPopover(true);
        }
      }
    });

    popover.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (action === "manage-tags") {
        closeSessionTagsPopover(true);
        triggerShortcutNavigation("tags");
      } else if (action === "clear-tags") {
        clearSessionTags(sessionId);
        currentTagIds.clear();
        showToast("已清除会话所有标签");
        closeSessionTagsPopover(true);
      }
    });

    // 鼠标移入二级子菜单，取消关闭延时并保持父级项高亮
    popover.addEventListener("mouseenter", () => {
      if (activeSessionTagsTriggerItem && activeSessionTagsTriggerItem._closeSubmenuTimer) {
        clearTimeout(activeSessionTagsTriggerItem._closeSubmenuTimer);
        activeSessionTagsTriggerItem._closeSubmenuTimer = null;
      }
      if (activeSessionTagsTriggerItem) {
        activeSessionTagsTriggerItem.classList.add("is-submenu-open");
      }
    });

    // 鼠标移出二级子菜单，延时平滑关闭（若输入框正处于聚焦或编辑状态，绝不关闭）
    popover.addEventListener("mouseleave", () => {
      if (document.activeElement && popover.contains(document.activeElement)) {
        return;
      }
      if (activeSessionTagsTriggerItem) {
        if (activeSessionTagsTriggerItem._closeSubmenuTimer) {
          clearTimeout(activeSessionTagsTriggerItem._closeSubmenuTimer);
        }
        activeSessionTagsTriggerItem._closeSubmenuTimer = setTimeout(() => {
          if (document.activeElement && popover.contains(document.activeElement)) return;
          closeSessionTagsPopover(false);
        }, 220);
      } else {
        setTimeout(() => {
          if (document.activeElement && popover.contains(document.activeElement)) return;
          closeSessionTagsPopover(false);
        }, 220);
      }
    });

    document.body.appendChild(popover);
    activeSessionTagsPopover = popover;

    const pWidth = 230;
    const pHeight = 260;
    const padding = 8;
    let x = 0;
    let y = 0;

    const rect = triggerRect || (triggerItem?.getBoundingClientRect ? triggerItem.getBoundingClientRect() : null);
    if (rect && rect.width > 0) {
      if (rect.right + pWidth + padding <= window.innerWidth) {
        x = rect.right + 2;
      } else if (rect.left - pWidth - 2 >= padding) {
        x = rect.left - pWidth - 2;
      } else {
        x = Math.max(padding, window.innerWidth - pWidth - padding);
      }
      y = Math.max(padding, Math.min(rect.top - 4, window.innerHeight - pHeight - padding));
    } else if (event) {
      x = Math.max(padding, Math.min((event.clientX || 0) + 4, window.innerWidth - pWidth - padding));
      y = Math.max(padding, Math.min((event.clientY || 0) - 4, window.innerHeight - pHeight - padding));
    } else {
      x = 100;
      y = 100;
    }

    popover.style.left = `${Math.round(x)}px`;
    popover.style.top = `${Math.round(y)}px`;

    const onDocPointerDown = (evt) => {
      if (popover && !popover.contains(evt.target) && !triggerItem?.contains?.(evt.target) && !(activeMenu && activeMenu.contains(evt.target))) {
        closeSessionTagsPopover(false);
      }
    };
    const onDocKeyDown = (evt) => {
      if (evt.key === "Escape") {
        evt.stopPropagation();
        closeSessionTagsPopover(false);
      }
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("keydown", onDocKeyDown, true);
    document.addEventListener("keydown", onDocKeyDown, true);

    activeSessionTagsCleanup = () => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("keydown", onDocKeyDown, true);
      document.removeEventListener("keydown", onDocKeyDown, true);
    };
  }

  function renderTagsPanel(panel, nav) {
    if (!panel) return;
    if (!panel.classList.contains("pi-enh-tags-panel")) {
      panel.classList.add("pi-enh-tags-panel");
    }

    let allTags = readSessionTagsDefinitions();
    let currentNewColor = getRecommendedTagColor(allTags).color;

    panel.innerHTML = `
      <div style="margin-bottom: 20px;">
        <h2 style="font-size: 18px; font-weight: 600; margin: 0 0 6px;">会话标签管理</h2>
        <div style="font-size: 12px; color: var(--text-muted, #a1a1aa); line-height: 1.5;">
          自定义多维标签与固定色彩体系，可在会话右键菜单中快速打标；新建标签将智能分配均衡色彩，并在整个界面中保持视觉统一。
        </div>
      </div>

      <!-- 新建标签卡片 -->
      <div class="pi-enh-tags-card">
        <div style="font-size: 13px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>
          <span>新建标签</span>
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 12px;">
          <input type="text" class="pi-enh-tag-add-name-input" placeholder="输入新标签名称（例如：重要、工作、复盘）" style="flex: 1 1 200px; min-width: 180px; padding: 7px 10px; background: var(--bg-subtle, rgba(125, 125, 125, 0.08)); border: 1px solid var(--border, #27272a); border-radius: 6px; color: var(--text, #f4f4f5); font-size: 13px; outline: none;" />
          <button type="button" class="pi-enh-btn-primary pi-enh-tag-add-btn" style="padding: 7px 14px; background: var(--accent, #38bdf8); color: #09090b; font-weight: 600; font-size: 12px; border-radius: 6px; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            <span>添加标签</span>
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-muted, #71717a);">
          <span>标签色彩：</span>
          <div class="pi-enh-tag-color-palette-grid">
            ${DEFAULT_TAG_PALETTE.map((p) => `
              <button type="button" class="pi-enh-tag-color-dot-choice${p.color.toLowerCase() === currentNewColor.toLowerCase() ? " is-active" : ""}" data-color="${p.color}" title="${p.name}" style="background: ${p.color};"></button>
            `).join("")}
          </div>
          <button type="button" class="pi-enh-tag-random-color-btn" style="background: none; border: 1px solid var(--border, #27272a); border-radius: 4px; padding: 2px 7px; color: var(--text-muted, #71717a); cursor: pointer; font-size: 11px; margin-left: 6px;">换随机色</button>
        </div>
      </div>

      <!-- 标签管理列表 -->
      <div class="pi-enh-tags-card" style="padding: 0; overflow: hidden;">
        <div style="padding: 12px 16px; border-bottom: 1px solid var(--border, #27272a); font-size: 13px; font-weight: 600; display: flex; align-items: center; justify-content: space-between;">
          <span>已有标签列表 (${allTags.length})</span>
        </div>
        <div class="pi-enh-tag-table-wrap">
          ${renderTagsTableContent(allTags)}
        </div>
      </div>
    `;

    const paletteBtns = panel.querySelectorAll(".pi-enh-tag-color-dot-choice");
    paletteBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        currentNewColor = btn.getAttribute("data-color");
        paletteBtns.forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
      });
    });

    const randomBtn = panel.querySelector(".pi-enh-tag-random-color-btn");
    randomBtn?.addEventListener("click", () => {
      const rec = getRecommendedTagColor(allTags);
      currentNewColor = rec.color;
      paletteBtns.forEach((b) => {
        if (b.getAttribute("data-color").toLowerCase() === rec.color.toLowerCase()) {
          b.classList.add("is-active");
        } else {
          b.classList.remove("is-active");
        }
      });
    });

    const addNameInput = panel.querySelector(".pi-enh-tag-add-name-input");
    const addBtn = panel.querySelector(".pi-enh-tag-add-btn");
    const handleAdd = () => {
      const val = (addNameInput.value || "").trim();
      if (!val) {
        showToast("标签名称不能为空", null, 2500);
        addNameInput?.focus();
        return;
      }
      if (allTags.some((t) => t.name.toLowerCase() === val.toLowerCase())) {
        showToast("已存在同名标签", null, 2500);
        addNameInput?.focus();
        return;
      }
      const created = createSessionTag(val, currentNewColor);
      if (created) {
        showToast(`已创建标签「${created.name}」`);
        renderTagsPanel(panel, nav);
      }
    };
    addBtn?.addEventListener("click", handleAdd);
    addNameInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAdd();
      }
    });

    bindTagsTableActions(panel, nav);
  }

  function renderTagsTableContent(allTags) {
    if (allTags.length === 0) {
      return `
        <div style="padding: 32px 16px; text-align: center; color: var(--text-muted, #71717a); font-size: 13px;">
          暂无自定义标签。在上方输入名称并点击「添加标签」开始创建。
        </div>
      `;
    }

    return `
      <table class="pi-enh-tag-table">
        <thead>
          <tr>
            <th style="width: 70px; text-align: center;">颜色</th>
            <th style="min-width: 180px;">标签名称</th>
            <th style="width: 140px; text-align: center;">标记会话数</th>
            <th style="width: 120px; text-align: right; padding-right: 18px;">操作</th>
          </tr>
        </thead>
        <tbody>
          ${allTags.map((tag) => {
            const usageCount = countSessionTagUsage(tag.id);
            const palette = getTagPaletteItem(tag.color);
            return `
              <tr data-tag-row-id="${tag.id}">
                <td style="text-align: center;">
                  <div style="position: relative; display: inline-flex; align-items: center; justify-content: center;">
                    <button type="button" class="pi-enh-tag-row-color-btn" data-action="pick-color" data-tag-id="${tag.id}" title="点击修改颜色" style="width: 22px; height: 22px; border-radius: 50%; background: ${tag.color}; border: 2px solid rgba(255,255,255,0.25); cursor: pointer; padding: 0;"></button>
                  </div>
                </td>
                <td>
                  <div class="pi-enh-tag-name-cell" style="display: flex; align-items: center; gap: 8px;">
                    <span class="pi-enh-session-tag-pill" style="background:${palette.bg};border:1px solid ${palette.border};color:${palette.color};">
                      <span class="pi-enh-tag-dot" style="background:${tag.color};"></span>
                      <span class="pi-enh-tag-name">${escapeHtml(tag.name)}</span>
                    </span>
                    <button type="button" class="pi-enh-tag-rename-btn" data-action="start-rename" data-tag-id="${tag.id}" title="修改名称" style="background:none;border:none;color:var(--text-muted,#71717a);cursor:pointer;padding:2px;font-size:11px;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path></svg>
                    </button>
                  </div>
                </td>
                <td style="text-align: center;">
                  <span style="font-size: 12px; color: var(--text-muted, #a1a1aa); white-space: nowrap;">${usageCount} 个会话</span>
                </td>
                <td style="text-align: right; padding-right: 18px;">
                  <button type="button" class="pi-enh-tag-delete-btn" data-action="delete-tag" data-tag-id="${tag.id}" data-stage="init" style="background: none; border: 1px solid rgba(239, 68, 68, 0.35); color: #fb7185; border-radius: 4px; padding: 4px 10px; font-size: 11px; cursor: pointer; white-space: nowrap;">
                    删除
                  </button>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    `;
  }

  function bindTagsTableActions(panel, nav) {
    const tableWrap = panel.querySelector(".pi-enh-tag-table-wrap");
    if (!tableWrap) return;

    tableWrap.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      const tagId = btn.getAttribute("data-tag-id");
      if (!tagId) return;

      if (action === "pick-color") {
        openTagRowColorPicker(btn, tagId, () => {
          renderTagsPanel(panel, nav);
        });
      } else if (action === "start-rename") {
        const row = btn.closest("tr");
        const nameCell = row?.querySelector(".pi-enh-tag-name-cell");
        if (!nameCell) return;
        const allTags = readSessionTagsDefinitions();
        const tag = allTags.find((t) => t.id === tagId);
        if (!tag) return;

        nameCell.innerHTML = `
          <input type="text" class="pi-enh-tag-rename-input" value="${escapeHtml(tag.name)}" style="padding: 3px 6px; font-size: 12px; background: var(--bg-subtle, #27272a); border: 1px solid var(--accent, #38bdf8); border-radius: 4px; color: var(--text, #f4f4f5); outline: none; width: 140px;" />
          <button type="button" class="pi-enh-tag-save-rename-btn" style="background: var(--accent, #38bdf8); border: none; border-radius: 4px; color: #000; font-size: 11px; padding: 3px 7px; cursor: pointer; font-weight: 600;">保存</button>
          <button type="button" class="pi-enh-tag-cancel-rename-btn" style="background: none; border: none; color: var(--text-muted, #71717a); font-size: 11px; padding: 3px 5px; cursor: pointer;">取消</button>
        `;
        const input = nameCell.querySelector(".pi-enh-tag-rename-input");
        input?.focus();
        input?.select();

        const save = () => {
          const newName = input.value.trim();
          if (!newName) {
            showToast("名称不能为空");
            renderTagsPanel(panel, nav);
            return;
          }
          if (newName !== tag.name && allTags.some((t) => t.name.toLowerCase() === newName.toLowerCase())) {
            showToast("已存在同名标签");
            renderTagsPanel(panel, nav);
            return;
          }
          updateSessionTag(tagId, { name: newName });
          showToast(`已重命名标签为「${newName}」`);
          renderTagsPanel(panel, nav);
        };

        nameCell.querySelector(".pi-enh-tag-save-rename-btn")?.addEventListener("click", save);
        nameCell.querySelector(".pi-enh-tag-cancel-rename-btn")?.addEventListener("click", () => {
          renderTagsPanel(panel, nav);
        });
        input?.addEventListener("keydown", (evt) => {
          if (evt.key === "Enter") {
            evt.preventDefault();
            save();
          } else if (evt.key === "Escape") {
            renderTagsPanel(panel, nav);
          }
        });
      } else if (action === "delete-tag") {
        const stage = btn.getAttribute("data-stage");
        if (stage !== "confirm") {
          btn.setAttribute("data-stage", "confirm");
          btn.textContent = "确认删除？";
          btn.style.background = "rgba(239, 68, 68, 0.2)";
          btn.style.borderColor = "#ef4444";
          setTimeout(() => {
            if (btn.isConnected && btn.getAttribute("data-stage") === "confirm") {
              btn.setAttribute("data-stage", "init");
              btn.textContent = "删除";
              btn.style.background = "none";
              btn.style.borderColor = "rgba(239, 68, 68, 0.3)";
            }
          }, 3500);
        } else {
          deleteSessionTag(tagId);
          showToast("已删除标签及其所有会话映射");
          renderTagsPanel(panel, nav);
        }
      }
    });
  }

  function openTagRowColorPicker(anchorBtn, tagId, onChange) {
    document.querySelector(".pi-enh-tag-row-picker-popup")?.remove();
    const popup = document.createElement("div");
    popup.className = "pi-enh-tag-row-picker-popup";
    popup.style.cssText = "position: fixed; z-index: 100010; background: #18181b; border: 1px solid rgba(255,255,255,0.15); border-radius: 8px; padding: 8px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; width: 160px; box-shadow: 0 10px 25px rgba(0,0,0,0.5);";

    popup.innerHTML = DEFAULT_TAG_PALETTE.map((p) => `
      <button type="button" data-color="${p.color}" title="${p.name}" style="width: 18px; height: 18px; border-radius: 50%; background: ${p.color}; border: 1px solid rgba(255,255,255,0.2); cursor: pointer; padding: 0;"></button>
    `).join("");

    document.body.appendChild(popup);
    const rect = anchorBtn.getBoundingClientRect();
    popup.style.left = `${Math.max(8, rect.left)}px`;
    popup.style.top = `${Math.max(8, rect.bottom + 4)}px`;

    const closePopup = () => {
      popup.remove();
      document.removeEventListener("pointerdown", onDown, true);
    };

    const onDown = (e) => {
      if (!popup.contains(e.target) && e.target !== anchorBtn) {
        closePopup();
      }
    };
    setTimeout(() => {
      document.addEventListener("pointerdown", onDown, true);
    }, 10);

    popup.addEventListener("click", (e) => {
      const choice = e.target.closest("[data-color]");
      if (!choice) return;
      const col = choice.getAttribute("data-color");
      if (col) {
        updateSessionTag(tagId, { color: col });
        closePopup();
        if (typeof onChange === "function") onChange();
      }
    });
  }

  window.__PI_ENH_READ_SESSION_TAGS__ = readSessionTagsDefinitions;
  window.__PI_ENH_WRITE_SESSION_TAGS__ = writeSessionTagsDefinitions;
  window.__PI_ENH_READ_SESSION_TAG_MAPPINGS__ = readSessionTagMappings;
  window.__PI_ENH_WRITE_SESSION_TAG_MAPPINGS__ = writeSessionTagMappings;
  window.__PI_ENH_CREATE_SESSION_TAG__ = createSessionTag;
  window.__PI_ENH_UPDATE_SESSION_TAG__ = updateSessionTag;
  window.__PI_ENH_DELETE_SESSION_TAG__ = deleteSessionTag;
  window.__PI_ENH_TOGGLE_SESSION_TAG__ = toggleSessionTag;
  window.__PI_ENH_ADD_SESSION_TAG__ = addSessionTag;
  window.__PI_ENH_CLEAR_SESSION_TAGS__ = clearSessionTags;
  window.__PI_ENH_SYNC_SESSION_TAGS__ = syncSessionTags;
  window.__PI_ENH_SYNC_MANIFEST_SESSION_TAGS__ = syncManifestSessionTags;
  window.__PI_ENH_PERSIST_SESSION_TAGS_TO_SERVER__ = persistSessionTagsToServer;
  window.__PI_ENH_PERSIST_DECORATIONS_TO_SERVER__ = persistDecorationsToServer;
  window.__PI_ENH_OPEN_SESSION_TAGS_POPOVER__ = openSessionTagsPopover;
  window.__PI_ENH_CLOSE_SESSION_TAGS_POPOVER__ = closeSessionTagsPopover;
  window.__PI_ENH_DEFAULT_TAG_PALETTE__ = DEFAULT_TAG_PALETTE;

  restorePendingDecorationOperationsFromStorage();
  // All queue/config declarations now exist: archive the real pre-normalization preferences.
  if (isDurableStateEnabled()) {
    const initialPreferences = collectPreferenceSnapshotValues();
    if (initialRawEnhancementStorage !== null) initialPreferences[ENHANCEMENT_SETTINGS_STORAGE_KEY] = initialRawEnhancementStorage;
    if (Object.keys(initialPreferences).length > 0) {
      hasStoredEnhancementConfigInitially = true;
      queuePreferencesSnapshotIfNeeded(initialPreferences);
    }
  }
  if (isDurableStateEnabled() && pendingDecorationOperations.length > 0) {
    void persistDecorationsToServer();
  }

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    const handleDurableStateOnline = () => {
      if (isDisposed) return;
      if (!isDurableStateEnabled()) return; // 禁用模式绝不回放旧队列
      if (pendingDecorationOperations.length > 0) {
        resetDurableRetry();
        void persistDecorationsToServer();
      }
    };
    window.addEventListener("online", handleDurableStateOnline);

    const handleStorageOutboxEvent = (e) => {
      if (isDisposed || !isDurableStateEnabled()) return;
      if (e && e.key && e.key.startsWith(DECORATION_OP_PREFIX)) {
        restorePendingDecorationOperationsFromStorage();
        if (pendingDecorationOperations.length > 0) {
          scheduleDurableStateRetry();
        }
      }
    };
    window.addEventListener("storage", handleStorageOutboxEvent);

    activeCleanups.push(() => {
      try { window.removeEventListener("online", handleDurableStateOnline); } catch (e) {}
      try { window.removeEventListener("storage", handleStorageOutboxEvent); } catch (e) {}
      resetDurableRetry();
      pendingPersistDecorationsResolvers.splice(0).forEach(resolve => resolve(false));
      if (pendingPersistDecorationsTimer) {
        clearTimeout(pendingPersistDecorationsTimer);
        pendingPersistDecorationsTimer = null;
      }
    });
  }

  // ==========================================
  // Odoo 插件更新状态胶囊 (Odoo Addon Update Badges)
  // 纯白外框、圆形胶囊、纯白字体、底纹发光质感，仅显示技术名称（无中文），每行一个插件
  // ==========================================
  // 会话归属由服务器记录器确定；不再从聊天 DOM / 浏览器旧缓存猜测。
  try {
    localStorage.removeItem("pi-enh-session-odoo-addons-v1");
    localStorage.removeItem("pi-enh-session-odoo-addons-v2");
  } catch (e) {}
  const SESSION_ODOO_ADDON_BASE_MARGIN = 4;
  const SESSION_ODOO_ADDON_ROW_HEIGHT = 24;
  const SESSION_ODOO_ADDONS_MANIFEST_URL = "/pi-odoo-addons-manifest.json";
  const SESSION_ODOO_ADDONS_POLL_INTERVAL_MS = 15000;
  const SESSION_ODOO_ADDONS_MIN_REFRESH_GAP_MS = 3000;

  function getSessionOdooAddonsExtraHeight(addonsCount) {
    if (!addonsCount || addonsCount <= 0) return 0;
    return SESSION_ODOO_ADDON_BASE_MARGIN + addonsCount * SESSION_ODOO_ADDON_ROW_HEIGHT;
  }

  function normalizeOdooAddonsLatestByAddon(latestByAddon) {
    if (!latestByAddon || typeof latestByAddon !== "object" || Array.isArray(latestByAddon)) return {};
    const normalized = {};
    for (const [tech, entry] of Object.entries(latestByAddon)) {
      if (typeof tech !== "string" || !/^[a-z][a-z0-9_]*$/.test(tech)) continue;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const sessionId = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
      if (!sessionId) continue;
      const updatedAt = typeof entry.updatedAt === "string" ? entry.updatedAt.trim() : "";
      normalized[tech] = { sessionId, updatedAt };
    }
    return normalized;
  }

  function isLatestSessionForOdooAddon(sessionId, technical, manifest = window.__PI_ENH_ODOO_ADDONS_MANIFEST__) {
    if (typeof sessionId !== "string" || !sessionId.trim()) return false;
    if (typeof technical !== "string" || !/^[a-z][a-z0-9_]*$/.test(technical)) return false;
    const latestByAddon = manifest?.latestByAddon;
    if (!latestByAddon || typeof latestByAddon !== "object" || Array.isArray(latestByAddon)) return false;
    const entry = latestByAddon[technical];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const latestSid = typeof entry.sessionId === "string" ? entry.sessionId.trim() : "";
    if (!latestSid) return false;
    return latestSid === sessionId.trim();
  }

  function isConfirmedOdooAddonStatus(status) {
    if (typeof status !== "string") return false;
    const s = status.trim();
    if (!s) return false;

    // 排除明确的未安装、失败、未改动、需人工审核、纯兼容但未改
    if (/未安装|uninstalled|not\s+installed/i.test(s)) return false;
    if (/需人工审核|待讨论|未成功|部署失败|升级失败|failed/i.test(s)) return false;
    if (/未改动|未改|未更新|未升级|无变动|无变化|未变动|unchanged/i.test(s)) return false;
    if (/兼容但未改|保持兼容[，,\s]+未改|兼容[，,\s]+无变动/i.test(s)) return false;

    const hasUpdateWord = /已更新|已升级|已部署|已发布|已修改|updated|upgraded/i.test(s);
    const hasCompatWord = /保持兼容|已保持兼容|兼容|compatible/i.test(s);
    const hasVersionChange =
      /(?:\d+\.)+\d+.*?(?:->|→|至|=>).*?(?:\d+\.)+\d+/i.test(s) ||
      /v?\d+(?:\.\d+)+.*?(?:->|→|至|=>).*?v?\d+(?:\.\d+)+/i.test(s);

    if (hasUpdateWord) {
      return true;
    }

    // 只有状态中有可证明版本变动的 X→Y 且兼容时保留；纯兼容带单个版本号（如 18.0.1.1.426（已保持兼容））属未改隐藏
    if (hasCompatWord && hasVersionChange) {
      return true;
    }

    // 纯安装-only（如已安装、installed、`.90` 已安装、(installed)）或纯版本号无更新证据均返回 false 隐藏
    return false;
  }

  function normalizeSessionOdooAddonItems(items, sessionId = "", manifest = window.__PI_ENH_ODOO_ADDONS_MANIFEST__) {
    if (!Array.isArray(items)) return [];
    const unique = new Map();
    for (const item of items) {
      const technical = typeof item === "string" ? item : item?.technical;
      if (typeof technical !== "string" || !/^[a-z][a-z0-9_]*$/.test(technical)) continue;
      const status = typeof item?.status === "string" ? item.status : "";
      if (!isConfirmedOdooAddonStatus(status)) continue;

      const normalizedItem = { technical, status };
      if (item?.updatedAt) {
        normalizedItem.updatedAt = item.updatedAt;
      }
      if (item?.name) {
        normalizedItem.name = item.name;
      }
      const isLatest = sessionId ? isLatestSessionForOdooAddon(sessionId, technical, manifest) : false;
      Object.defineProperty(normalizedItem, "isLatest", {
        value: isLatest,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      unique.set(technical, normalizedItem);
    }
    return [...unique.values()];
  }

  function isValidOdooAddonsManifestPayload(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    if (!data.sessions || typeof data.sessions !== "object" || Array.isArray(data.sessions)) return false;
    for (const val of Object.values(data.sessions)) {
      if (val !== null && val !== undefined && !Array.isArray(val)) {
        return false;
      }
    }
    return true;
  }

  function computeOdooAddonsSessionsSignature(manifest) {
    if (!isValidOdooAddonsManifestPayload(manifest)) return "";
    const sessions = manifest.sessions;
    const keys = Object.keys(sessions).sort();
    const parts = [];
    for (const sid of keys) {
      const normalized = normalizeSessionOdooAddonItems(sessions[sid], sid, manifest);
      if (normalized.length === 0) continue;
      const itemStr = normalized
        .map((it) => `${it.technical}:${it.status}${it.isLatest ? "@latest" : ""}`)
        .join(",");
      parts.push(`${sid}=[${itemStr}]`);
    }
    if (parts.length === 0) return "";
    const latestMap = normalizeOdooAddonsLatestByAddon(manifest.latestByAddon);
    const latestKeys = Object.keys(latestMap).sort();
    if (latestKeys.length > 0) {
      const latestStr = latestKeys
        .map((tech) => `${tech}:${latestMap[tech].sessionId}:${latestMap[tech].updatedAt}`)
        .join(",");
      parts.push(`__latest__=[${latestStr}]`);
    }
    return parts.join("|");
  }

  function getSessionOdooAddons(sessionId) {
    if (!sessionId || !isPluginEnabled("session-odoo-addons")) return [];
    const manifest = window.__PI_ENH_ODOO_ADDONS_MANIFEST__;
    const items = manifest?.sessions?.[sessionId];
    return normalizeSessionOdooAddonItems(items, sessionId, manifest);
  }

  function syncSessionOdooAddonsHeight(row, sessionId) {
    const height = getSessionItemHeight(sessionId) + "px";
    if (row.style.height !== height) row.style.height = height;
    const wrapper = row.parentElement;
    if (wrapper?.style.position === "absolute" && wrapper.style.height !== height) wrapper.style.height = height;
  }

  function removeSessionOdooAddonsAll() {
    for (const row of document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-has-odoo-addons='true']")) {
      row.querySelector(".pi-enh-session-odoo-addons")?.remove();
      row.removeAttribute("data-pi-enh-has-odoo-addons");
      syncSessionOdooAddonsHeight(row, row.dataset.piEnhSessionId);
    }
  }

  function syncSessionOdooAddonsRow(row, sessionId) {
    if (!row || !sessionId) return;

    if (!isPluginEnabled("session-odoo-addons") || row.querySelector("input") || row.getAttribute("data-pi-enh-editing") === "true") {
      row.querySelector(".pi-enh-session-odoo-addons")?.remove();
      row.removeAttribute("data-pi-enh-has-odoo-addons");
      syncSessionOdooAddonsHeight(row, sessionId);
      return;
    }

    const addons = getSessionOdooAddons(sessionId);
    let container = row.querySelector(".pi-enh-session-odoo-addons");

    if (addons.length === 0) {
      container?.remove();
      row.removeAttribute("data-pi-enh-has-odoo-addons");
      syncSessionOdooAddonsHeight(row, sessionId);
      return;
    }

    if (row.getAttribute("data-pi-enh-has-odoo-addons") !== "true") row.setAttribute("data-pi-enh-has-odoo-addons", "true");

    if (!container) {
      container = document.createElement("div");
      container.className = "pi-enh-session-odoo-addons";
    }

    // 独立的全宽第二行，不挤占第一行标题、标签与操作按钮，也不继承元数据截断。
    if (container.parentElement !== row) row.appendChild(container);

    // 渲染每个插件一行：仅显示插件的技术标识名称（不显示中文，如仅显示 kx_srm）
    let html = "";
    const activeManifest = window.__PI_ENH_ODOO_ADDONS_MANIFEST__;
    for (const addon of addons) {
      const tech = (typeof addon === "string" ? addon : (addon.technical || addon.name || "")).trim();
      if (!tech) continue;
      const isLatest = isLatestSessionForOdooAddon(sessionId, tech, activeManifest);
      const baseTooltip = addon.status ? `${tech} · ${addon.status}` : tech;
      const tooltip = isLatest ? `${baseTooltip} · 最新实际更新会话` : `${baseTooltip} · 历史更新会话`;
      const ariaLabel = isLatest ? `${tech}（最新实际更新会话）` : `${tech}（历史更新会话）`;
      const pillClass = isLatest ? "pi-enh-odoo-addon-pill is-latest" : "pi-enh-odoo-addon-pill";

      html += `<div class="pi-enh-odoo-addon-row">
        <span class="${pillClass}" data-pi-enh-latest="${isLatest ? "true" : "false"}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(ariaLabel)}">
          <span class="pi-enh-odoo-addon-dot" aria-hidden="true"></span>
          <span class="pi-enh-odoo-addon-name">${escapeHtml(tech)}</span>
        </span>
      </div>`;
    }

    // 不重复替换相同节点，避免 MutationObserver 自激和悬停/选择闪烁。
    if (container.__renderedHtml !== html && container.innerHTML !== html) {
      container.innerHTML = html;
    }
    container.__renderedHtml = html;
    syncSessionOdooAddonsHeight(row, sessionId);
  }

  function syncSessionOdooAddonsLayout() {
    // React owns the filtered list, including an empty result. Never restore
    // bootstrap groups or request another render from a layout observation:
    // an engine/project switch can legitimately hide every catalogue row.

    const rows = document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]");
    if (!rows || rows.length === 0) {
      if (typeof removeSessionSectionHeaders === "function") removeSessionSectionHeaders();
      return;
    }

    // 按其所属虚拟列表容器 container = row.parentElement?.parentElement 分组
    const containerMap = new Map();
    for (const row of rows) {
      const wrapper = row.parentElement;
      if (!wrapper || wrapper.style.position !== "absolute") continue;
      const container = wrapper.parentElement;
      if (!container) continue;
      let list = containerMap.get(container);
      if (!list) {
        list = [];
        containerMap.set(container, list);
      }
      list.push({ row, wrapper, sid: row.dataset.piEnhSessionId });
    }

    const hasKnownGroups =
      Array.isArray(latestKnownSessionGroups) &&
      latestKnownSessionGroups.length > 0 &&
      latestKnownSessionGroups.every((group) => Boolean(group?.root?.id));
    const indices = hasKnownGroups ? new Map(latestKnownSessionGroups.map((group, index) => [group.root.id, index])) : null;

    for (const [container, entries] of containerMap.entries()) {
      let allHit = hasKnownGroups && indices !== null;
      if (allHit) {
        for (const entry of entries) {
          if (!indices.has(entry.sid)) {
            allHit = false;
            break;
          }
        }
      }

      if (allHit) {
        const groups = latestKnownSessionGroups;
        for (const entry of entries) {
          const index = indices.get(entry.sid);
          const top = getSessionItemTop(index, groups) + "px";
          if (entry.wrapper.style.top !== top) entry.wrapper.style.top = top;
          syncSessionOdooAddonsHeight(entry.row, entry.sid);
        }
        const height = (SESSION_NORMAL_ITEM_HEIGHT * groups.length + getSessionHeadersHeight(groups)) + "px";
        if (container.style.height !== height) container.style.height = height;
        const pinnedCount = getPinnedSessionCount(groups);
        const recents = container.querySelector(".pi-enh-session-section-recents");
        if (recents && pinnedCount && recents.getAttribute("data-pi-enh-fallback") === "true") {
          const top = (getSessionItemTop(pinnedCount, groups) - SESSION_RECENTS_HEADER_HEIGHT) + "px";
          if (recents.style.top !== top) recents.style.top = top;
        }
      } else if (typeof removeSessionSectionHeaders === "function") {
        removeSessionSectionHeaders(container);
      }
    }
    if (typeof syncSessionSectionHeaders === "function") {
      syncSessionSectionHeaders();
    }
  }

  function syncSessionOdooAddons() {
    if (!isPluginEnabled("session-odoo-addons")) {
      removeSessionOdooAddonsAll();
      syncSessionOdooAddonsLayout();
      return;
    }

    const rows = document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]");
    for (const row of rows) {
      const sessionId = row.getAttribute("data-pi-enh-session-id");
      if (sessionId) {
        syncSessionOdooAddonsRow(row, sessionId);
      }
    }
    syncSessionOdooAddonsLayout();
  }

  let activeOdooAddonsRefreshPromise = null;
  let activeOdooAddonsAbortController = null;
  let odooAddonsPollTimer = null;
  let lastOdooAddonsRefreshAttemptAt = 0;
  let hasSyncedAuthoritativeOdooAddonsManifest = false;
  let isOdooAddonsRefreshDisposed = false;

  function isOdooAddonsPageHidden() {
    try {
      if (typeof document !== "undefined") {
        if (document.visibilityState === "hidden" || document.hidden === true) {
          return true;
        }
      }
    } catch (e) {}
    return false;
  }

  function cancelSessionOdooAddonsRefresh() {
    if (activeOdooAddonsAbortController) {
      try {
        activeOdooAddonsAbortController.abort();
      } catch (e) {}
      activeOdooAddonsAbortController = null;
    }
    activeOdooAddonsRefreshPromise = null;
  }

  function refreshSessionOdooAddonsManifest(options = {}) {
    const opts = typeof options === "boolean" ? { force: options } : (options || {});
    const force = Boolean(opts.force);

    if (isDisposed || isOdooAddonsRefreshDisposed) {
      return Promise.resolve({ updated: false, changed: false, skipped: true, reason: "disposed" });
    }
    if (!isPluginEnabled("session-odoo-addons") && !force) {
      return Promise.resolve({ updated: false, changed: false, skipped: true, reason: "plugin-disabled" });
    }
    if (typeof isLoginPage === "function" && isLoginPage()) {
      return Promise.resolve({ updated: false, changed: false, skipped: true, reason: "login-page" });
    }
    if (isOdooAddonsPageHidden() && !opts.allowHidden) {
      return Promise.resolve({ updated: false, changed: false, skipped: true, reason: "hidden" });
    }

    if (activeOdooAddonsRefreshPromise) {
      return activeOdooAddonsRefreshPromise;
    }

    const now = Date.now();
    const minGap = typeof opts.minGapMs === "number" ? opts.minGapMs : SESSION_ODOO_ADDONS_MIN_REFRESH_GAP_MS;
    if (!force && lastOdooAddonsRefreshAttemptAt > 0 && (now - lastOdooAddonsRefreshAttemptAt) < minGap) {
      return Promise.resolve({ updated: false, changed: false, skipped: true, reason: "throttled" });
    }

    lastOdooAddonsRefreshAttemptAt = now;

    const currentPromise = (async () => {
      let controller = null;
      try {
        const activeFetch =
          typeof window !== "undefined" && typeof window.fetch === "function"
            ? window.fetch.bind(window)
            : (typeof fetch === "function" ? fetch : null);
        if (!activeFetch) {
          return { updated: false, changed: false, skipped: true, reason: "no-fetch" };
        }

        if (typeof AbortController === "function") {
          controller = new AbortController();
          activeOdooAddonsAbortController = controller;
        }

        const fetchOpts = { cache: "no-store" };
        if (controller && controller.signal) {
          fetchOpts.signal = controller.signal;
        }

        const res = await activeFetch(`${SESSION_ODOO_ADDONS_MANIFEST_URL}?v=${Date.now()}`, fetchOpts);
        if (isDisposed || isOdooAddonsRefreshDisposed || (controller && controller.signal && controller.signal.aborted)) {
          return { updated: false, changed: false, skipped: true, reason: "aborted" };
        }
        if (!res || !res.ok) {
          return { updated: false, changed: false, error: `HTTP_${res ? res.status : "NO_RESPONSE"}` };
        }

        const nextManifest = await res.json();
        if (isDisposed || isOdooAddonsRefreshDisposed || (controller && controller.signal && controller.signal.aborted)) {
          return { updated: false, changed: false, skipped: true, reason: "aborted" };
        }
        if (!isValidOdooAddonsManifestPayload(nextManifest)) {
          return { updated: false, changed: false, error: "INVALID_PAYLOAD" };
        }

        const currentManifest = window.__PI_ENH_ODOO_ADDONS_MANIFEST__;
        const curValid = isValidOdooAddonsManifestPayload(currentManifest);
        const curRev = curValid ? (Number(currentManifest.revision) || 0) : 0;
        const nextRev = Number(nextManifest.revision) || 0;
        const curUpdatedAt = curValid && typeof currentManifest.updatedAt === "string" ? currentManifest.updatedAt : "";
        const nextUpdatedAt = typeof nextManifest.updatedAt === "string" ? nextManifest.updatedAt : "";
        const curSig = computeOdooAddonsSessionsSignature(currentManifest);
        const nextSig = computeOdooAddonsSessionsSignature(nextManifest);

        // Fail-closed 防空抹除守卫：若当前已有非空插件且远端返回既无 revision 又无任何会话条目的空壳，保留旧值
        const nextSessionKeysCount = Object.keys(nextManifest.sessions).length;
        if (curSig !== "" && nextSig === "" && nextSessionKeysCount === 0 && nextRev <= 0) {
          return { updated: false, changed: false, error: "EMPTY_UNVERSIONED_MANIFEST" };
        }
        if (hasSyncedAuthoritativeOdooAddonsManifest && curSig !== "" && nextSig === "" && nextRev > 0 && nextRev < curRev) {
          return { updated: false, changed: false, skipped: true, reason: "stale-revision" };
        }

        hasSyncedAuthoritativeOdooAddonsManifest = true;

        const contentChanged = !curValid || curSig !== nextSig;
        const versionChanged = !curValid || curRev !== nextRev || curUpdatedAt !== nextUpdatedAt;
        if (!contentChanged && !versionChanged) {
          return { updated: false, changed: false, revision: curRev };
        }

        window.__PI_ENH_ODOO_ADDONS_MANIFEST__ = nextManifest;
        syncSessionOdooAddons();
        if (contentChanged) {
          try {
            window.__PI_ENH_RERENDER_SESSIONS__?.();
          } catch (e) {}
        }
        return { updated: true, changed: contentChanged, versionChanged, revision: nextRev };
      } catch (err) {
        return { updated: false, changed: false, error: err && err.message ? err.message : "FETCH_ERROR" };
      } finally {
        if (activeOdooAddonsAbortController === controller) {
          activeOdooAddonsAbortController = null;
        }
        if (activeOdooAddonsRefreshPromise === currentPromise) {
          activeOdooAddonsRefreshPromise = null;
        }
      }
    })();

    activeOdooAddonsRefreshPromise = currentPromise;
    return currentPromise;
  }

  function setupSessionOdooAddonsAutoRefresh() {
    if (typeof window !== "undefined" && window.__PI_ENH_ODOO_ADDONS_REFRESH_CONTROLLER__?.cleanup) {
      try {
        window.__PI_ENH_ODOO_ADDONS_REFRESH_CONTROLLER__.cleanup();
      } catch (e) {}
    }

    isOdooAddonsRefreshDisposed = false;

    const onVisibilityChange = () => {
      if (!isOdooAddonsPageHidden() && isPluginEnabled("session-odoo-addons")) {
        void refreshSessionOdooAddonsManifest({ reason: "visibility" });
      }
    };

    const onWindowFocus = () => {
      if (!isOdooAddonsPageHidden() && isPluginEnabled("session-odoo-addons")) {
        void refreshSessionOdooAddonsManifest({ reason: "focus" });
      }
    };

    const onWindowOnline = () => {
      if (!isOdooAddonsPageHidden() && isPluginEnabled("session-odoo-addons")) {
        void refreshSessionOdooAddonsManifest({ force: true, reason: "online" });
      }
    };

    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("focus", onWindowFocus);
      window.addEventListener("online", onWindowOnline);
    }

    if (odooAddonsPollTimer) {
      clearInterval(odooAddonsPollTimer);
      odooAddonsPollTimer = null;
    }
    if (typeof setInterval === "function") {
      odooAddonsPollTimer = setInterval(() => {
        if (isDisposed || isOdooAddonsRefreshDisposed || isOdooAddonsPageHidden()) return;
        if (!isPluginEnabled("session-odoo-addons")) return;
        if (typeof isLoginPage === "function" && isLoginPage()) return;
        void refreshSessionOdooAddonsManifest({ reason: "poll" });
      }, SESSION_ODOO_ADDONS_POLL_INTERVAL_MS);
    }

    const cleanup = () => {
      isOdooAddonsRefreshDisposed = true;
      cancelSessionOdooAddonsRefresh();
      if (odooAddonsPollTimer) {
        clearInterval(odooAddonsPollTimer);
        odooAddonsPollTimer = null;
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        try { document.removeEventListener("visibilitychange", onVisibilityChange); } catch (e) {}
      }
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        try { window.removeEventListener("focus", onWindowFocus); } catch (e) {}
        try { window.removeEventListener("online", onWindowOnline); } catch (e) {}
      }
    };

    if (Array.isArray(activeCleanups)) {
      activeCleanups.push(cleanup);
    }

    if (typeof window !== "undefined") {
      window.__PI_ENH_ODOO_ADDONS_REFRESH_CONTROLLER__ = {
        refresh: refreshSessionOdooAddonsManifest,
        cancel: cancelSessionOdooAddonsRefresh,
        cleanup,
        getPollTimer: () => odooAddonsPollTimer,
      };
    }

    if (!isOdooAddonsPageHidden() && isPluginEnabled("session-odoo-addons") && !(typeof isLoginPage === "function" && isLoginPage())) {
      void refreshSessionOdooAddonsManifest({ force: true, reason: "bootstrap-reconcile" });
    }

    return cleanup;
  }

  setupSessionOdooAddonsAutoRefresh();

  window.__PI_ENH_GET_SESSION_ODOO_ADDONS__ = getSessionOdooAddons;
  // 旧的客户端写入口作废：只有带明确 session ID 的记录器可写持久清单。
  delete window.__PI_ENH_SET_SESSION_ODOO_ADDONS__;
  window.__PI_ENH_SYNC_SESSION_ODOO_ADDONS__ = syncSessionOdooAddons;
  window.__PI_ENH_REFRESH_SESSION_ODOO_ADDONS_MANIFEST__ = refreshSessionOdooAddonsManifest;
  window.__PI_ENH_CANCEL_SESSION_ODOO_ADDONS_REFRESH__ = cancelSessionOdooAddonsRefresh;

  function computeSessionTitle(session) {
    if (!session) return "";
    if (session.name) return session.name;
    let firstMsg = session.firstMessage || "";
    const skillMatch = firstMsg.match(/^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/);
    if (skillMatch) {
      firstMsg = skillMatch[4] ? `/skill:${skillMatch[1]} ${skillMatch[4]}` : `/skill:${skillMatch[1]}`;
    }
    return firstMsg.slice(0, 50) || (session.id ? session.id.slice(0, 12) : "未命名会话");
  }

  function extractSessionTitleFromRow(row, fallbackId) {
    if (!row) return fallbackId ? fallbackId.slice(0, 12) : "";
    const titleDiv = row.querySelector("div[title]");
    const divTitle = titleDiv?.getAttribute("title")?.trim();
    if (divTitle && divTitle !== fallbackId) return divTitle;

    const spanText = titleDiv?.querySelector("span")?.textContent?.trim();
    if (spanText && spanText !== fallbackId) return spanText;

    const anySpan = row.querySelector("span");
    const text = anySpan?.textContent?.trim();
    if (text && text !== fallbackId) return text;

    return fallbackId ? fallbackId.slice(0, 12) : "";
  }

  const ARCHIVED_REVISION_STORAGE_KEY = "pi-enh-session-archived-rev";

  function getLocalArchivedRevision() {
    try {
      return Number(localStorage.getItem(ARCHIVED_REVISION_STORAGE_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setLocalArchivedRevision(rev) {
    try {
      localStorage.setItem(ARCHIVED_REVISION_STORAGE_KEY, String(rev));
    } catch (e) {}
  }

  function normalizeArchivedEntry(item) {
    if (!item) return null;
    if (typeof item === "string") {
      const id = item.trim();
      if (!id) return null;
      const cached = knownSessionTitles?.get(id);
      return { id, name: cached || id, cwd: "", archivedAt: Date.now() };
    }
    if (typeof item === "object" && item.id) {
      const id = String(item.id).trim();
      if (!id) return null;
      const cached = knownSessionTitles?.get(id);
      const resolvedName = (item.name && item.name !== id) ? item.name : (cached || item.name || id);
      return {
        id,
        name: resolvedName,
        cwd: typeof item.cwd === "string" ? item.cwd : "",
        archivedAt: typeof item.archivedAt === "number" && !isNaN(item.archivedAt) && item.archivedAt > 0 ? item.archivedAt : Date.now(),
      };
    }
    return null;
  }

  function mergeSingleArchivedEntry(base, incoming) {
    if (!base) return incoming;
    if (!incoming) return base;

    let bestName = base.name || "";
    const incName = incoming.name || "";
    const isBaseGeneric = !bestName || bestName === base.id || bestName === base.id.slice(0, 12);
    const isIncGeneric = !incName || incName === incoming.id || incName === incoming.id.slice(0, 12);

    if (isBaseGeneric && !isIncGeneric) {
      bestName = incName;
    } else if (!isBaseGeneric && !isIncGeneric) {
      if (incName.length > bestName.length) bestName = incName;
    }

    const bestCwd = base.cwd ? base.cwd : (incoming.cwd || "");

    let bestArchivedAt = base.archivedAt;
    const incArchivedAt = incoming.archivedAt;
    if (typeof incArchivedAt === "number" && !isNaN(incArchivedAt) && incArchivedAt > 0) {
      if (typeof bestArchivedAt !== "number" || isNaN(bestArchivedAt) || bestArchivedAt <= 0) {
        bestArchivedAt = incArchivedAt;
      } else {
        bestArchivedAt = Math.min(bestArchivedAt, incArchivedAt);
      }
    } else if (typeof bestArchivedAt !== "number" || isNaN(bestArchivedAt) || bestArchivedAt <= 0) {
      bestArchivedAt = Date.now();
    }

    return {
      id: base.id,
      name: bestName || base.id.slice(0, 12),
      cwd: bestCwd,
      archivedAt: bestArchivedAt,
    };
  }

  function readStoredArchivedEntries() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ARCHIVED_SESSION_STORAGE_KEY) || "[]");
      if (!Array.isArray(parsed)) return [];
      const restoredIds = getRecentlyRestoredArchivedIds();
      return parsed
        .map(normalizeArchivedEntry)
        .filter((e) => Boolean(e) && !restoredIds.has(e.id));
    } catch (e) {
      return [];
    }
  }

  function writeStoredArchivedEntries(entries) {
    try {
      localStorage.setItem(ARCHIVED_SESSION_STORAGE_KEY, JSON.stringify(entries));
    } catch (e) {}
  }

  // 版本号只用于同步排序；归档内容相同时不重复重写整个 models.json。
  function archivedEntriesHaveSameContent(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    const canonical = (value) => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") {
        const result = {};
        for (const key of Object.keys(value).sort()) result[key] = canonical(value[key]);
        return result;
      }
      return value;
    };
    return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
  }

  let pendingPersistArchivedTimer = null;
  let pendingPersistArchivedResolvers = [];
  let latestArchivedEntriesToPersist = null;
  let hasPendingArchivedPush = false;
  let archivedPersistSeq = 0;
  let archivedPersistFailures = 0;
  const MAX_ARCHIVED_PERSIST_FAILURES = 3;

  async function persistArchivedSessionsToServer(entriesToPersist, customRevision, immediate = false, automatic = false) {
    if (isDisposed) return Promise.resolve(false);
    const currentEntries = Array.isArray(entriesToPersist) ? entriesToPersist : readStoredArchivedEntries();
    latestArchivedEntriesToPersist = currentEntries;
    const revision = customRevision || Math.max(Date.now(), getLocalArchivedRevision() + 1);
    setLocalArchivedRevision(revision);
    hasPendingArchivedPush = true;
    const writeSeq = ++archivedPersistSeq;
    if (!automatic) archivedPersistFailures = 0;

    // 1. 同设备跨标签页广播
    try {
      crossDeviceSyncChannel?.postMessage({
        type: "archived_sessions_updated",
        archivedEntries: currentEntries,
        revision: revision,
        at: Date.now()
      });
    } catch (e) {}

    // 2. 向服务端 models-config 持久化
    return new Promise((resolve) => {
      pendingPersistArchivedResolvers.push(resolve);

      const triggerPersist = () => {
        if (pendingPersistArchivedTimer) {
          clearTimeout(pendingPersistArchivedTimer);
          pendingPersistArchivedTimer = null;
        }
        const currentResolvers = pendingPersistArchivedResolvers;
        pendingPersistArchivedResolvers = [];

        runWithModelsConfigLock(async () => {
          if (isDisposed) {
            archivedPersistFailures++;
            currentResolvers.forEach((r) => r(false));
            return false;
          }
          try {
            let currentConfig = null;
            try {
              const { resp: getResp, json: data } = await fetchModelsConfigBounded("/api/models-config", { cache: "no-store", readJson: true });
              if (getResp?.ok && data && typeof data === "object" && !Array.isArray(data) && data.providers && typeof data.providers === "object" && !Array.isArray(data.providers)) {
                currentConfig = data;
              } else {
                console.error("[pi-enh] models-config GET returned invalid data for archived sessions");
              }
            } catch (e) {
              console.error("[pi-enh] models-config GET network error for archived sessions:", e?.message || "network error");
            }

            if (!currentConfig || isDisposed) {
              archivedPersistFailures++;
              currentResolvers.forEach((r) => r(false));
              return false;
            }

            const latestEntries = latestArchivedEntriesToPersist || readStoredArchivedEntries();
            const serverRev = Number(currentConfig.archivedRevision) || 0;
            if (archivedEntriesHaveSameContent(currentConfig.archivedSessions, latestEntries)) {
              window.__PI_ENH_ARCHIVED_MANIFEST__ = latestEntries;
              // 不清除 GET 期间新排队的真实改动。
              if (writeSeq === archivedPersistSeq) {
                hasPendingArchivedPush = false;
                setLocalArchivedRevision(serverRev);
              }
              archivedPersistFailures = 0;
              currentResolvers.forEach((r) => r(true));
              return true;
            }
            const finalRevision = Math.max(Date.now(), serverRev + 1, getLocalArchivedRevision() || revision);
            setLocalArchivedRevision(finalRevision);

            const putPayload = {
              ...currentConfig,
              archivedSessions: latestEntries,
              archivedRevision: finalRevision
            };

            const { resp: putResp } = await fetchModelsConfigBounded("/api/models-config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(putPayload),
              readJson: false,
            });

            const ok = Boolean(putResp?.ok) && !isDisposed;
            if (ok) {
              window.__PI_ENH_ARCHIVED_MANIFEST__ = latestEntries;
              if (writeSeq === archivedPersistSeq) {
                hasPendingArchivedPush = false;
              }
              archivedPersistFailures = 0;
            } else {
              archivedPersistFailures++;
              console.error("[pi-enh] persistArchivedSessionsToServer PUT failed:", putResp?.status, putResp?.statusText);
            }
            currentResolvers.forEach((r) => r(ok));
            return ok;
          } catch (err) {
            archivedPersistFailures++;
            console.error("[pi-enh] persistArchivedSessionsToServer error:", err?.message || "unknown error");
            currentResolvers.forEach((r) => r(false));
            return false;
          }
        });
      };

      if (immediate) {
        triggerPersist();
      } else {
        if (pendingPersistArchivedTimer) {
          clearTimeout(pendingPersistArchivedTimer);
        }
        pendingPersistArchivedTimer = setTimeout(triggerPersist, 150);
      }
    });
  }

  let isSyncingArchivedTitles = false;
  async function syncArchivedTitles() {
    if (isLoginPage() || isSyncingArchivedTitles) return;
    isSyncingArchivedTitles = true;
    try {
      const res = await fetch("/api/sessions", { cache: "no-store" });
      if (!res?.ok) return;
      const data = await res.json();
      const sessions = Array.isArray(data?.sessions) ? data.sessions : [];

      for (const s of sessions) {
        if (!s?.id) continue;
        knownSessionsMap.set(s.id, s);
        const title = computeSessionTitle(s);
        knownSessionTitles.set(s.id, title);
      }

      const entries = readStoredArchivedEntries();
      let updated = false;
      for (const entry of entries) {
        const found = sessions.find((s) => s.id === entry.id);
        if (found) {
          const freshTitle = computeSessionTitle(found);
          if (entry.name !== freshTitle || entry.name === entry.id || !entry.name) {
            entry.name = freshTitle;
            updated = true;
          }
          if (found.cwd && !entry.cwd) {
            entry.cwd = found.cwd;
            updated = true;
          }
        }
      }
      if (updated) {
        writeStoredArchivedEntries(entries);
        void persistArchivedSessionsToServer(entries);
        const panel = document.querySelector(".pi-enh-archived-panel");
        const nav = document.querySelector(".settings-section-tabs");
        if (panel && panel.style.display !== "none") {
          renderArchivedPanel(panel, nav);
        }
      }
    } catch (e) {
    } finally {
      isSyncingArchivedTitles = false;
    }
  }

  let activeArchivedSyncPromise = null;
  function syncManifestArchivedEntries(force = false) {
    if (activeArchivedSyncPromise) return activeArchivedSyncPromise;
    activeArchivedSyncPromise = (async () => {
      try {
        const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
        if (!activeFetch) return;

        let remoteFetchSuccess = false;
        let remoteHasArchivedConfig = false;
        let remoteEntries = null;
        let remoteRevision = 0;

        try {
          const resp = await activeFetch("/api/models-config", { cache: "no-store" });
          if (resp?.ok) {
            remoteFetchSuccess = true;
            const data = await resp.json();
            if (data && typeof data === "object" && "archivedSessions" in data) {
              remoteHasArchivedConfig = true;
              remoteRevision = Number(data.archivedRevision) || 0;
              if (Array.isArray(data.archivedSessions)) {
                remoteEntries = data.archivedSessions.map(normalizeArchivedEntry).filter(Boolean);
              } else {
                remoteEntries = [];
              }
              const restoredIds = getRecentlyRestoredArchivedIds();
              if (restoredIds.size > 0 && Array.isArray(remoteEntries)) {
                const prevCount = remoteEntries.length;
                remoteEntries = remoteEntries.filter((e) => !restoredIds.has(e.id));
                if (remoteEntries.length < prevCount) {
                  remoteRevision = Math.max(Date.now(), remoteRevision + 1);
                  void persistArchivedSessionsToServer(remoteEntries, remoteRevision, true);
                }
              }
            }
          }
        } catch (e) {}

        // 显式区分 models-config GET 成功与失败：GET 失败不覆盖也不写
        if (!remoteFetchSuccess) {
          return;
        }

        const localRev = getLocalArchivedRevision();
        const localEntries = readStoredArchivedEntries();

        // 首次迁移：localRev === 0
        if (localRev === 0) {
          let staticManifestList = [];
          if (!remoteHasArchivedConfig) {
            if (Array.isArray(window.__PI_ENH_ARCHIVED_MANIFEST__) && window.__PI_ENH_ARCHIVED_MANIFEST__.length > 0) {
              staticManifestList = window.__PI_ENH_ARCHIVED_MANIFEST__.map(normalizeArchivedEntry).filter(Boolean);
            } else {
              try {
                const res = await activeFetch("/pi-archived-manifest.json?v=" + Date.now(), { cache: "no-store" });
                if (res?.ok) {
                  const json = await res.json();
                  if (Array.isArray(json)) {
                    staticManifestList = json.map(normalizeArchivedEntry).filter(Boolean);
                  }
                }
              } catch (e) {}
            }
          }

          const mergedMap = new Map();
          for (const item of staticManifestList) {
            if (item?.id) mergedMap.set(item.id, item);
          }
          if (Array.isArray(remoteEntries)) {
            for (const item of remoteEntries) {
              if (item?.id) {
                const existing = mergedMap.get(item.id);
                mergedMap.set(item.id, mergeSingleArchivedEntry(existing, item));
              }
            }
          }
          let hasLocalAdditions = false;
          for (const item of localEntries) {
            if (item?.id) {
              const existing = mergedMap.get(item.id);
              if (!existing) {
                hasLocalAdditions = true;
                mergedMap.set(item.id, item);
              } else {
                const merged = mergeSingleArchivedEntry(existing, item);
                if (merged.name !== existing.name || merged.cwd !== existing.cwd) {
                  hasLocalAdditions = true;
                }
                mergedMap.set(item.id, merged);
              }
            }
          }

          const mergedEntries = Array.from(mergedMap.values());

          if (remoteHasArchivedConfig && !hasLocalAdditions && remoteRevision > 0) {
            writeStoredArchivedEntries(remoteEntries);
            setLocalArchivedRevision(remoteRevision);
            window.__PI_ENH_ARCHIVED_MANIFEST__ = remoteEntries;
          } else {
            const newRev = Math.max(Date.now(), remoteRevision + 1);
            writeStoredArchivedEntries(mergedEntries);
            setLocalArchivedRevision(newRev);
            window.__PI_ENH_ARCHIVED_MANIFEST__ = mergedEntries;
            void persistArchivedSessionsToServer(mergedEntries, newRev);
          }

          window.__PI_ENH_RERENDER_SESSIONS__?.();
          const panel = document.querySelector(".pi-enh-archived-panel");
          const nav = document.querySelector(".settings-section-tabs");
          if (panel && panel.style.display !== "none") {
            renderArchivedPanel(panel, nav);
          }
          return;
        }

        // 非首次迁移：localRev > 0
        // 2) GET 成功但服务端尚无 archivedSessions 且 localRev>0 时，补写本地快照（包括空数组）
        if (!remoteHasArchivedConfig) {
          if (archivedPersistFailures >= MAX_ARCHIVED_PERSIST_FAILURES) return;
          const pushRev = Math.max(Date.now(), localRev);
          setLocalArchivedRevision(pushRev);
          window.__PI_ENH_ARCHIVED_MANIFEST__ = localEntries;
          void persistArchivedSessionsToServer(localEntries, pushRev, false, true);
          return;
        }

        // 相同内容只对齐服务端版本，终止不同标签页互相抬高版本号的反馈循环。
        if (remoteRevision > 0 && archivedEntriesHaveSameContent(remoteEntries, localEntries)) {
          setLocalArchivedRevision(remoteRevision);
          hasPendingArchivedPush = false;
          archivedPersistFailures = 0;
          window.__PI_ENH_ARCHIVED_MANIFEST__ = remoteEntries;
          return;
        }

        // 3) GET 成功且 remoteRevision < localRev 时，视本地为更新状态并补写
        if (remoteRevision < localRev || hasPendingArchivedPush) {
          if (archivedPersistFailures >= MAX_ARCHIVED_PERSIST_FAILURES) {
            return;
          }
          const pushRev = Math.max(Date.now(), localRev);
          setLocalArchivedRevision(pushRev);
          window.__PI_ENH_ARCHIVED_MANIFEST__ = localEntries;
          void persistArchivedSessionsToServer(localEntries, pushRev, false, true);
          return;
        }

        // 3) remoteRevision > localRev 时仍远端权威覆盖；force 时也允许应用
        const shouldApply = force || (remoteRevision > 0 && remoteRevision > localRev);
        if (shouldApply) {
          let changed = !Array.isArray(localEntries) || localEntries.length !== remoteEntries.length;
          if (!changed) {
            for (let i = 0; i < localEntries.length; i++) {
              if (localEntries[i]?.id !== remoteEntries[i]?.id) {
                changed = true;
                break;
              }
            }
          }
          writeStoredArchivedEntries(remoteEntries);
          if (remoteRevision > 0) setLocalArchivedRevision(remoteRevision);
          window.__PI_ENH_ARCHIVED_MANIFEST__ = remoteEntries;
          if (changed || force) {
            window.__PI_ENH_RERENDER_SESSIONS__?.();
            const panel = document.querySelector(".pi-enh-archived-panel");
            const nav = document.querySelector(".settings-section-tabs");
            if (panel && panel.style.display !== "none") {
              renderArchivedPanel(panel, nav);
            }
          }
        }
      } catch (e) {
      } finally {
        activeArchivedSyncPromise = null;
      }
    })();
    return activeArchivedSyncPromise;
  }

  window.__PI_ENH_SYNC_ARCHIVED_TITLES__ = syncArchivedTitles;
  window.__PI_ENH_SYNC_MANIFEST_ARCHIVED__ = syncManifestArchivedEntries;
  window.__PI_ENH_PERSIST_ARCHIVED_TO_SERVER__ = persistArchivedSessionsToServer;
  window.__PI_ENH_GET_LOCAL_ARCHIVED_REVISION__ = getLocalArchivedRevision;
  window.__PI_ENH_SET_LOCAL_ARCHIVED_REVISION__ = setLocalArchivedRevision;

  function readManifestPinnedIds() {
    let manifestList = Array.isArray(window.__PI_ENH_PINNED_MANIFEST__)
      ? window.__PI_ENH_PINNED_MANIFEST__
      : [];
    if (!Array.isArray(manifestList) && manifestList && typeof manifestList === "object") {
      if (Array.isArray(manifestList.pinned)) manifestList = manifestList.pinned;
      else if (Array.isArray(manifestList.sessions)) manifestList = manifestList.sessions;
    }
    if (!Array.isArray(manifestList)) return [];
    const ids = [];
    for (const item of manifestList) {
      if (typeof item === "string" && item.trim()) {
        ids.push(item.trim());
      } else if (item && typeof item === "object" && typeof item.id === "string" && item.id.trim()) {
        ids.push(item.id.trim());
      }
    }
    return ids;
  }

  window.__PI_ENH_READ_MANIFEST_PINNED__ = readManifestPinnedIds;

  const PINNED_REVISION_STORAGE_KEY = "pi-enh-session-pinned-rev";

  function getLocalPinnedRevision() {
    try {
      return Number(localStorage.getItem(PINNED_REVISION_STORAGE_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  }

  function setLocalPinnedRevision(rev) {
    try {
      localStorage.setItem(PINNED_REVISION_STORAGE_KEY, String(rev));
    } catch (e) {}
  }

  let pendingPersistPinnedTimer = null;
  let pendingPersistPinnedResolvers = [];
  let latestPinnedIdsToPersist = null;

  async function persistPinnedSessionsToServer(pinnedIdsSet) {
    if (isDisposed) return Promise.resolve(false);
    const ids = Array.from(pinnedIdsSet || readStoredSessionIds(PINNED_SESSION_STORAGE_KEY));
    latestPinnedIdsToPersist = ids;
    if (pinnedIdsSet) {
      writeStoredSessionIds(PINNED_SESSION_STORAGE_KEY, ids);
    }
    const revision = Date.now();
    setLocalPinnedRevision(revision);

    // 1. 同设备跨标签页广播
    try {
      crossDeviceSyncChannel?.postMessage({
        type: "pinned_sessions_updated",
        pinnedIds: ids,
        revision: revision,
        at: Date.now()
      });
    } catch (e) {}

    // 2. 防抖向服务端 models.json 持久化
    return new Promise((resolve) => {
      pendingPersistPinnedResolvers.push(resolve);

      if (pendingPersistPinnedTimer) {
        clearTimeout(pendingPersistPinnedTimer);
      }

      pendingPersistPinnedTimer = setTimeout(() => {
        pendingPersistPinnedTimer = null;
        const currentResolvers = pendingPersistPinnedResolvers;
        pendingPersistPinnedResolvers = [];

        runWithModelsConfigLock(async () => {
          if (isDisposed) {
            currentResolvers.forEach((r) => r(false));
            return false;
          }
          try {
            let currentConfig = null;
            try {
              const { resp: getResp, json: data } = await fetchModelsConfigBounded("/api/models-config", { cache: "no-store", readJson: true });
              if (getResp?.ok && data && typeof data === "object" && !Array.isArray(data) && data.providers && typeof data.providers === "object" && !Array.isArray(data.providers)) {
                currentConfig = data;
              } else {
                console.error("[pi-enh] models-config GET returned invalid data for pinned sessions");
              }
            } catch (e) {
              console.error("[pi-enh] models-config GET network error for pinned sessions:", e?.message || "network error");
            }

            if (!currentConfig || isDisposed) {
              currentResolvers.forEach((r) => r(false));
              return false;
            }

            const currentIds = latestPinnedIdsToPersist || Array.from(readStoredSessionIds(PINNED_SESSION_STORAGE_KEY));
            const pinnedSessionsPayload = currentIds.map((id) => {
              const title = knownSessionTitles.get(id) || "";
              return {
                id,
                name: title,
                pinnedAt: Date.now()
              };
            });

            const putPayload = {
              ...currentConfig,
              pinnedSessions: pinnedSessionsPayload,
              pinnedRevision: revision
            };

            const { resp: putResp } = await fetchModelsConfigBounded("/api/models-config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(putPayload),
              readJson: false,
            });

            const ok = Boolean(putResp?.ok) && !isDisposed;
            if (ok) {
              window.__PI_ENH_PINNED_MANIFEST__ = pinnedSessionsPayload;
            } else {
              console.error("[pi-enh] persistPinnedSessionsToServer PUT failed:", putResp?.status, putResp?.statusText);
            }
            currentResolvers.forEach((r) => r(ok));
            return ok;
          } catch (err) {
            console.error("[pi-enh] persistPinnedSessionsToServer error:", err?.message || "unknown error");
            currentResolvers.forEach((r) => r(false));
            return false;
          }
        });
      }, 150);
    });
  }

  let activePinnedSyncPromise = null;
  function syncManifestPinnedEntries(force = false) {
    if (activePinnedSyncPromise) return activePinnedSyncPromise;
    activePinnedSyncPromise = (async () => {
      try {
        const activeFetch = typeof window !== "undefined" && window.fetch ? window.fetch : (typeof fetch === "function" ? fetch : null);
        if (!activeFetch) return;

        let remoteIds = null;
        let remoteRevision = 0;
        let remotePayload = null;

        // 1. 优先从权威服务端配置 /api/models-config 拉取
        try {
          const resp = await activeFetch("/api/models-config", { cache: "no-store" });
          if (resp?.ok) {
            const data = await resp.json();
            if (Array.isArray(data?.pinnedSessions)) {
              remoteIds = data.pinnedSessions.map((e) => (typeof e === "string" ? e.trim() : e?.id?.trim())).filter(Boolean);
              remoteRevision = Number(data?.pinnedRevision) || 0;
              remotePayload = data.pinnedSessions;
            }
          }
        } catch (e) {}

        // 2. 回退从静态资产清单 /pi-pinned-manifest.json 读取（仅缺失时用）
        if (remoteIds === null) {
          try {
            const res = await activeFetch("/pi-pinned-manifest.json?v=" + Date.now(), { cache: "no-store" });
            if (res?.ok) {
              const json = await res.json();
              const arr = Array.isArray(json) ? json : (Array.isArray(json?.pinned) ? json.pinned : (Array.isArray(json?.sessions) ? json.sessions : null));
              if (Array.isArray(arr)) {
                remoteIds = arr.map((e) => (typeof e === "string" ? e.trim() : e?.id?.trim())).filter(Boolean);
                remotePayload = arr;
              }
            }
          } catch (e) {}
        }

        // 3. 兜底内置清单（仅缺失时用）
        if (remoteIds === null) {
          const builtIn = readManifestPinnedIds();
          if (builtIn.length > 0) {
            remoteIds = builtIn;
          }
        }

        if (remoteIds === null) return;

        const localRev = getLocalPinnedRevision();
        const localRaw = localStorage.getItem(PINNED_SESSION_STORAGE_KEY);
        const isFirstVisit = (localRaw === null);

        const currentStored = readStoredSessionIds(PINNED_SESSION_STORAGE_KEY);
        const nextSet = new Set(remoteIds);
        let collectionChanged = nextSet.size !== currentStored.size;
        if (!collectionChanged) {
          for (const id of nextSet) {
            if (!currentStored.has(id)) {
              collectionChanged = true;
              break;
            }
          }
        }

        // 判定是否应当覆盖或更新本地状态：
        // 1) 显式强制刷新
        // 2) 首次访问（localRaw === null）：必须接受服务端返回的配置（即使是空数组 [] rev 0），确立权威并落盘
        // 3) 远端 revision 严格大于本地 revision
        // 4) 远端 revision 存在且与本地 revision 相同：无论集合是否相同，仍需更新权威 rev 与 manifest
        const shouldApply = force || isFirstVisit || (remoteRevision > 0 && remoteRevision > localRev) || (remoteRevision >= 0 && remoteRevision === localRev);

        if (shouldApply) {
          // 始终更新权威 manifest 与 revision
          if (remoteRevision >= 0) {
            setLocalPinnedRevision(Math.max(localRev, remoteRevision));
          }
          if (remotePayload) {
            window.__PI_ENH_PINNED_MANIFEST__ = remotePayload;
          }

          // 若首次访问、强制刷新、远端更新、或集合发生变化，则持久化到本地
          const needStorageWrite = isFirstVisit || force || (remoteRevision > localRev) || collectionChanged;
          if (needStorageWrite) {
            writeStoredSessionIds(PINNED_SESSION_STORAGE_KEY, nextSet);
          }

          if (collectionChanged || force || isFirstVisit) {
            window.__PI_ENH_RERENDER_SESSIONS__?.();
            syncSessionPinArchiveControls();
          }
        }
      } catch (e) {
      } finally {
        activePinnedSyncPromise = null;
      }
    })();
    return activePinnedSyncPromise;
  }

  window.__PI_ENH_SYNC_MANIFEST_PINNED__ = syncManifestPinnedEntries;
  window.__PI_ENH_PERSIST_PINNED_TO_SERVER__ = persistPinnedSessionsToServer;

  function readStoredSessionIds(storageKey) {
    if (storageKey === ARCHIVED_SESSION_STORAGE_KEY) {
      return new Set(readStoredArchivedEntries().map((e) => e.id));
    }
    let localParsed = [];
    let hasLocalRecord = false;
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) {
        hasLocalRecord = true;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) localParsed = parsed.filter((id) => typeof id === "string" && id);
      }
    } catch (e) {}

    if (storageKey === PINNED_SESSION_STORAGE_KEY) {
      // 若本地从未保存过置顶数据，以统一清单初始化；若已有本地记录，严格以本地状态为准
      if (!hasLocalRecord) {
        const manifestIds = readManifestPinnedIds();
        if (manifestIds.length > 0) {
          return new Set(manifestIds);
        }
      }
    }
    return new Set(localParsed);
  }

  function writeStoredSessionIds(storageKey, ids) {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...ids]));
    } catch (e) {}
  }

  const pendingDeletedSessionIds = window.__PI_ENH_PENDING_DELETED_SESSION_IDS__ instanceof Set
    ? window.__PI_ENH_PENDING_DELETED_SESSION_IDS__
    : new Set();
  window.__PI_ENH_PENDING_DELETED_SESSION_IDS__ = pendingDeletedSessionIds;

  // 记录已确认删除的会话 ID 及其过期时间，确保在后端数据完全同步前绝对不会闪现复活
  const confirmedDeletedSessionIds = window.__PI_ENH_CONFIRMED_DELETED_SESSION_IDS__ instanceof Map
    ? window.__PI_ENH_CONFIRMED_DELETED_SESSION_IDS__
    : new Map();
  window.__PI_ENH_CONFIRMED_DELETED_SESSION_IDS__ = confirmedDeletedSessionIds;

  function isSessionDeleted(sessionId) {
    if (!sessionId) return false;
    if (pendingDeletedSessionIds.has(sessionId)) return true;
    const expiresAt = confirmedDeletedSessionIds.get(sessionId);
    if (expiresAt) {
      if (Date.now() < expiresAt) return true;
      confirmedDeletedSessionIds.delete(sessionId);
    }
    return false;
  }

  function markSessionAsDeleted(sessionId, retentionMs = 60000) {
    if (!sessionId) return;
    pendingDeletedSessionIds.add(sessionId);
    confirmedDeletedSessionIds.set(sessionId, Date.now() + retentionMs);
    try {
      if (typeof window !== "undefined" && typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
        window.__PI_ENH_RERENDER_SESSIONS__();
      }
    } catch (e) {}
  }

  function markSessionDeleteConfirmed(sessionId, retentionMs = 60000) {
    if (!sessionId) return;
    pendingDeletedSessionIds.delete(sessionId);
    confirmedDeletedSessionIds.set(sessionId, Date.now() + retentionMs);
  }

  function restoreSessionDeleteState(sessionId) {
    if (!sessionId) return;
    pendingDeletedSessionIds.delete(sessionId);
    confirmedDeletedSessionIds.delete(sessionId);
    try {
      if (typeof window !== "undefined" && typeof window.__PI_ENH_RERENDER_SESSIONS__ === "function") {
        window.__PI_ENH_RERENDER_SESSIONS__();
      }
    } catch (e) {}
  }

  function cleanupDeletedSessionEverywhere(sessionId) {
    if (!sessionId) return;
    try { sessionMemoryCache.delete(sessionId); } catch (e) {}
    try { void invalidatePersistentSession(sessionId); } catch (e) {}
    try { knownSessionsMap.delete(sessionId); } catch (e) {}
    try { knownSessionTitles.delete(sessionId); } catch (e) {}
    try { persistentSessionEpochs.delete(sessionId); } catch (e) {}
    try { markSessionRunning(sessionId, false); } catch (e) {}
    try {
      const pinnedIds = readStoredSessionIds(PINNED_SESSION_STORAGE_KEY);
      if (pinnedIds.has(sessionId)) {
        pinnedIds.delete(sessionId);
        writeStoredSessionIds(PINNED_SESSION_STORAGE_KEY, pinnedIds);
        if (Array.isArray(window.__PI_ENH_PINNED_MANIFEST__)) {
          window.__PI_ENH_PINNED_MANIFEST__ = window.__PI_ENH_PINNED_MANIFEST__.filter((e) => (typeof e === "string" ? e !== sessionId : e?.id !== sessionId));
        }
        void persistPinnedSessionsToServer(pinnedIds);
      }
      restoreArchivedSession(sessionId);
      try { clearSessionTags(sessionId); } catch (e) {}
      try {
        const uIds = readUnreadSessionIds();
        if (uIds.has(sessionId)) {
          uIds.delete(sessionId);
          writeUnreadSessionIds(uIds);
          if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
            window.__PI_ENH_SET_UNREAD_SESSION__(sessionId, false);
          }
        }
      } catch (e) {}
    } catch (e) {}
  }

  latestKnownSessionGroups = [];
  let activeSessionFilterTagId = "all";
  let microtaskSidebarSyncPending = false;

  function scheduleImmediateSidebarRowsSync() {
    if (microtaskSidebarSyncPending) return;
    microtaskSidebarSyncPending = true;
    queueMicrotask(() => {
      microtaskSidebarSyncPending = false;
      if (isDisposed) return;
      if (typeof syncSidebarRowsImmediate === "function") {
        syncSidebarRowsImmediate();
      } else if (typeof syncSessionSectionHeaders === "function") {
        syncSessionSectionHeaders();
      }
    });
  }

  function processSessionGroups(groups) {
    if (!Array.isArray(groups)) return groups;
    const isPinArchiveEnabled = isPluginEnabled("session-pin-archive");
    const pinnedIds = isPinArchiveEnabled ? readStoredSessionIds(PINNED_SESSION_STORAGE_KEY) : new Set();
    const archivedIds = isPinArchiveEnabled ? readStoredSessionIds(ARCHIVED_SESSION_STORAGE_KEY) : new Set();

    const filtered = [];
    const presentRootIds = new Set();
    const tagMappings = (isPluginEnabled("session-tags") && activeSessionFilterTagId !== "all") ? readSessionTagMappings() : null;

    for (const group of groups) {
      const rootId = group?.root?.id;
      if (!rootId) continue;
      if (group.root) {
        const prev = knownSessionsMap.get(rootId);
        if (!prev || !prev.modified || (group.root.modified && group.root.modified > prev.modified)) {
          knownSessionsMap.set(rootId, group.root);
          knownSessionTitles.set(rootId, computeSessionTitle(group.root));
        } else if (!knownSessionTitles.has(rootId)) {
          knownSessionTitles.set(rootId, computeSessionTitle(group.root));
        }
      }
      if (archivedIds.has(rootId) || isSessionDeleted(rootId)) {
        continue;
      }
      // 标签快速过滤：若选中了某个特定标签，仅保留拥有该标签的会话
      if (tagMappings && activeSessionFilterTagId !== "all") {
        const tIds = tagMappings[rootId];
        if (!Array.isArray(tIds) || !tIds.includes(activeSessionFilterTagId)) {
          continue;
        }
      }
      if (Array.isArray(group.subagents) && group.subagents.length > 0) {
        group.subagents = group.subagents.filter((sub) => sub?.id && !isSessionDeleted(sub.id));
      }
      filtered.push(group);
      presentRootIds.add(rootId);
    }

    // 置顶排序：仅对当前项目/工作区原生存活的会话按置顶状态排在最前，
    // 严格按所属项目隔离，严禁将其他项目的置顶会话跨工作区注入当前列表
    const result = !isPinArchiveEnabled
      ? filtered
      : filtered.sort((left, right) => Number(pinnedIds.has(right?.root?.id)) - Number(pinnedIds.has(left?.root?.id)));

    latestKnownSessionGroups = result;
    scheduleImmediateSidebarRowsSync();
    return result;
  }

  // ==========================================
  // 会话置顶与最近分组小标题 (Session Section Headers)
  // ==========================================
  const SESSION_PINNED_HEADER_HEIGHT = 28;
  SESSION_RECENTS_HEADER_HEIGHT = 34;
  SESSION_NORMAL_ITEM_HEIGHT = 54;
  SESSION_TAGGED_ITEM_HEIGHT = 72;
  const SESSION_TAG_ROW_EXTRA = 18; // 72 - 54

  // 虚拟列表布局快照与前缀高度缓存 (单次布局批次 O(N+K)，零 TTL 强一致性)
  let sessionLayoutSnapshot = null;

  function safeGetLocalStorageItem(key) {
    try {
      return (typeof localStorage !== "undefined" && typeof localStorage?.getItem === "function")
        ? localStorage.getItem(key)
        : null;
    } catch (e) {
      return null;
    }
  }

  function getPinnedManifestSignature() {
    const m = (typeof window !== "undefined" && window?.__PI_ENH_PINNED_MANIFEST__) || null;
    if (!m) return null;
    if (Array.isArray(m)) {
      return m.map((item) => (typeof item === "string" ? item : (item?.id || ""))).join(",");
    }
    if (typeof m === "object" && Array.isArray(m.pinned)) {
      return m.pinned.map((item) => (typeof item === "string" ? item : (item?.id || ""))).join(",");
    }
    return String(m);
  }

  function isSessionLayoutSnapshotValid(snapshot) {
    if (!snapshot) return false;

    const rawPinned = safeGetLocalStorageItem(PINNED_SESSION_STORAGE_KEY);
    if (snapshot.rawPinned !== rawPinned) return false;
    if (rawPinned === null && snapshot.pinnedManifestSig !== getPinnedManifestSignature()) return false;

    const rawTagMappings = safeGetLocalStorageItem(SESSION_TAG_MAPPING_STORAGE_KEY);
    if (snapshot.rawTagMappings !== rawTagMappings) return false;

    const rawTagDefs = safeGetLocalStorageItem(SESSION_TAGS_STORAGE_KEY);
    if (snapshot.rawTagDefs !== rawTagDefs) return false;

    const tagsEnabled = isPluginEnabled("session-tags");
    if (snapshot.tagsEnabled !== tagsEnabled) return false;

    const addonsEnabled = isPluginEnabled("session-odoo-addons");
    if (snapshot.addonsEnabled !== addonsEnabled) return false;

    const pinArchiveEnabled = isPluginEnabled("session-pin-archive");
    if (snapshot.pinArchiveEnabled !== pinArchiveEnabled) return false;

    const sectionHeadersEnabled = isPluginEnabled("session-section-headers");
    if (snapshot.sectionHeadersEnabled !== sectionHeadersEnabled) return false;

    const manifest = (typeof window !== "undefined" && window?.__PI_ENH_ODOO_ADDONS_MANIFEST__) || null;
    if (snapshot.manifest !== manifest) return false;

    return true;
  }

  function ensureSessionLayoutSnapshot(groups) {
    if (!Array.isArray(groups)) return null;

    if (
      sessionLayoutSnapshot &&
      sessionLayoutSnapshot.groups === groups &&
      sessionLayoutSnapshot.groupsLength === groups.length &&
      isSessionLayoutSnapshotValid(sessionLayoutSnapshot)
    ) {
      return sessionLayoutSnapshot;
    }

    const rawPinned = safeGetLocalStorageItem(PINNED_SESSION_STORAGE_KEY);
    const pinnedManifestSig = rawPinned === null ? getPinnedManifestSignature() : null;
    const rawTagMappings = safeGetLocalStorageItem(SESSION_TAG_MAPPING_STORAGE_KEY);
    const rawTagDefs = safeGetLocalStorageItem(SESSION_TAGS_STORAGE_KEY);

    const tagsEnabled = isPluginEnabled("session-tags");
    const addonsEnabled = isPluginEnabled("session-odoo-addons");
    const pinArchiveEnabled = isPluginEnabled("session-pin-archive");
    const sectionHeadersEnabled = isPluginEnabled("session-section-headers");
    const manifest = (typeof window !== "undefined" && window?.__PI_ENH_ODOO_ADDONS_MANIFEST__) || null;

    // 1. 置顶统计 (单次批次仅读取/解析 1 次)
    let pinnedCount = 0;
    if (pinArchiveEnabled && sectionHeadersEnabled) {
      const pinnedIds = readStoredSessionIds(PINNED_SESSION_STORAGE_KEY);
      if (pinnedIds && pinnedIds.size > 0) {
        for (const group of groups) {
          const rootId = group?.root?.id;
          if (rootId && pinnedIds.has(rootId)) {
            pinnedCount += 1;
          } else {
            break;
          }
        }
      }
    }

    // 2. 标签定义与映射解析 (单次批次各仅解析 1 次，内部只读查表，不写全局可变缓存)
    let tagMappings = null;
    let validTagIds = null;
    if (tagsEnabled) {
      try {
        tagMappings = readSessionTagMappings();
      } catch (e) {}
      try {
        const validTags = readSessionTagsDefinitions();
        if (Array.isArray(validTags) && validTags.length > 0) {
          validTagIds = new Set(validTags.map((t) => t?.id).filter(Boolean));
        }
      } catch (e) {}
    }

    const total = groups.length;
    let baseHeadersHeight = 0;
    if (pinnedCount > 0) {
      baseHeadersHeight = (pinnedCount < total)
        ? (SESSION_PINNED_HEADER_HEIGHT + SESSION_RECENTS_HEADER_HEIGHT)
        : SESSION_PINNED_HEADER_HEIGHT;
    }

    // 3. 单次 O(N) 遍历预计算：单项高度、前缀 Top 累加数组、Recents 标题位置与总高度补偿
    const itemHeightsMap = new Map();
    const itemTops = new Array(total + 1);
    let extraHeight = 0;

    let currentTop = pinnedCount > 0 ? SESSION_PINNED_HEADER_HEIGHT : 0;
    itemTops[0] = currentTop;
    let recentsHeaderTop = 0;

    for (let i = 0; i < total; i++) {
      const group = groups[i];
      const rootId = group?.root?.id;
      let h = SESSION_NORMAL_ITEM_HEIGHT;

      if (rootId) {
        if (tagsEnabled && tagMappings && validTagIds) {
          const tIds = tagMappings[rootId];
          if (Array.isArray(tIds) && tIds.some((id) => validTagIds.has(id))) {
            h += SESSION_TAG_ROW_EXTRA;
          }
        }
        if (addonsEnabled) {
          try {
            const addons = getSessionOdooAddons(rootId);
            if (addons && addons.length > 0) {
              h += getSessionOdooAddonsExtraHeight(addons.length);
            }
          } catch (e) {}
        }
        itemHeightsMap.set(rootId, h);
      }

      if (h > SESSION_NORMAL_ITEM_HEIGHT) {
        extraHeight += (h - SESSION_NORMAL_ITEM_HEIGHT);
      }

      currentTop += h;
      if (pinnedCount > 0 && i === pinnedCount - 1 && pinnedCount < total) {
        recentsHeaderTop = currentTop;
        currentTop += SESSION_RECENTS_HEADER_HEIGHT;
      }
      itemTops[i + 1] = currentTop;
    }

    const headersHeight = baseHeadersHeight + extraHeight;

    sessionLayoutSnapshot = {
      groups,
      groupsLength: total,
      rawPinned,
      pinnedManifestSig,
      rawTagMappings,
      rawTagDefs,
      tagsEnabled,
      addonsEnabled,
      pinArchiveEnabled,
      sectionHeadersEnabled,
      manifest,
      pinnedCount,
      headersHeight,
      itemHeightsMap,
      itemTops,
      recentsHeaderTop,
    };

    return sessionLayoutSnapshot;
  }

  function getSessionItemHeight(sessionId) {
    if (!sessionId) return SESSION_NORMAL_ITEM_HEIGHT;
    if (sessionLayoutSnapshot && isSessionLayoutSnapshotValid(sessionLayoutSnapshot)) {
      if (sessionLayoutSnapshot.itemHeightsMap && sessionLayoutSnapshot.itemHeightsMap.has(sessionId)) {
        return sessionLayoutSnapshot.itemHeightsMap.get(sessionId);
      }
    } else {
      sessionLayoutSnapshot = null;
    }

    let h = SESSION_NORMAL_ITEM_HEIGHT;
    if (isPluginEnabled("session-tags")) {
      try {
        const mappings = readSessionTagMappings();
        const tagIds = mappings[sessionId];
        if (Array.isArray(tagIds) && tagIds.length > 0) {
          const validTags = readSessionTagsDefinitions();
          const validTagIds = new Set(validTags.map((t) => t.id));
          if (tagIds.some((id) => validTagIds.has(id))) {
            h += SESSION_TAG_ROW_EXTRA;
          }
        }
      } catch (e) {}
    }
    if (isPluginEnabled("session-odoo-addons")) {
      try {
        const addons = getSessionOdooAddons(sessionId);
        if (addons && addons.length > 0) {
          h += getSessionOdooAddonsExtraHeight(addons.length);
        }
      } catch (e) {}
    }
    return h;
  }

  function getPinnedSessionCount(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return 0;
    const isPinArchiveEnabled = isPluginEnabled("session-pin-archive");
    const isSectionHeadersEnabled = isPluginEnabled("session-section-headers");
    if (!isPinArchiveEnabled || !isSectionHeadersEnabled) return 0;

    const snapshot = ensureSessionLayoutSnapshot(groups);
    if (snapshot) {
      return snapshot.pinnedCount;
    }

    const pinnedIds = readStoredSessionIds(PINNED_SESSION_STORAGE_KEY);
    if (!pinnedIds || pinnedIds.size === 0) return 0;
    let count = 0;
    for (const group of groups) {
      const rootId = group?.root?.id;
      if (rootId && pinnedIds.has(rootId)) {
        count += 1;
      } else {
        break;
      }
    }
    return count;
  }

  function getSessionHeadersHeight(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return 0;
    const snapshot = ensureSessionLayoutSnapshot(groups);
    return snapshot ? snapshot.headersHeight : 0;
  }

  function getSessionItemTop(index, groups) {
    if (Array.isArray(groups)) {
      const snapshot = ensureSessionLayoutSnapshot(groups);
      if (snapshot && Array.isArray(snapshot.itemTops)) {
        if (index <= 0) return snapshot.itemTops[0] || 0;
        if (index < snapshot.itemTops.length) return snapshot.itemTops[index];
        return snapshot.itemTops[snapshot.itemTops.length - 1];
      }
    }
    const pinnedCount = getPinnedSessionCount(groups);
    const defaultTop = 54 * index;
    if (pinnedCount <= 0) return defaultTop;
    if (index < pinnedCount) {
      return SESSION_PINNED_HEADER_HEIGHT + defaultTop;
    }
    return SESSION_PINNED_HEADER_HEIGHT + SESSION_RECENTS_HEADER_HEIGHT + defaultTop;
  }

  function getSessionHeaders(r, groups) {
    const pinnedCount = getPinnedSessionCount(groups);
    if (pinnedCount <= 0 || !r || typeof r.jsx !== "function") return [];
    const total = Array.isArray(groups) ? groups.length : 0;
    const headers = [];

    // Pinned Header
    headers.push(
      r.jsx("div", {
        key: "pi-enh-header-pinned",
        className: "pi-enh-session-section-header pi-enh-session-section-pinned",
        "data-pi-enh-section": "pinned",
        style: {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: SESSION_PINNED_HEADER_HEIGHT,
          display: "flex",
          alignItems: "center",
          paddingLeft: 14,
          paddingRight: 8,
          fontSize: 12,
          fontWeight: 400,
          color: "var(--text-muted, #71717a)",
          userSelect: "none",
          pointerEvents: "none",
          letterSpacing: "0.01em",
        },
        children: "Pinned",
      })
    );

    // Recents Header (仅当存在非置顶的最近会话时才渲染)
    if (pinnedCount < total) {
      let recentsTop = 0;
      if (
        sessionLayoutSnapshot &&
        sessionLayoutSnapshot.groups === groups &&
        sessionLayoutSnapshot.pinnedCount === pinnedCount &&
        isSessionLayoutSnapshotValid(sessionLayoutSnapshot)
      ) {
        recentsTop = sessionLayoutSnapshot.recentsHeaderTop;
      } else {
        let pinnedSessionsHeight = 0;
        for (let i = 0; i < pinnedCount && i < groups.length; i++) {
          const rootId = groups[i]?.root?.id;
          pinnedSessionsHeight += getSessionItemHeight(rootId);
        }
        recentsTop = SESSION_PINNED_HEADER_HEIGHT + pinnedSessionsHeight;
      }
      headers.push(
        r.jsx("div", {
          key: "pi-enh-header-recents",
          className: "pi-enh-session-section-header pi-enh-session-section-recents",
          "data-pi-enh-section": "recents",
          style: {
            position: "absolute",
            top: recentsTop,
            left: 0,
            right: 0,
            height: SESSION_RECENTS_HEADER_HEIGHT,
            display: "flex",
            alignItems: "flex-end",
            paddingLeft: 14,
            paddingRight: 8,
            paddingBottom: 5,
            fontSize: 12,
            fontWeight: 400,
            color: "var(--text-muted, #71717a)",
            userSelect: "none",
            pointerEvents: "none",
            letterSpacing: "0.01em",
          },
          children: "Recents",
        })
      );
    }

    return headers;
  }

  function resolveVirtualContainerSessionGroups(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    if (
      !Array.isArray(latestKnownSessionGroups) ||
      latestKnownSessionGroups.length === 0 ||
      !latestKnownSessionGroups.every((group) => Boolean(group?.root?.id))
    ) {
      return null;
    }

    const indices = new Map(
      latestKnownSessionGroups.map((group, index) => [group.root.id, index])
    );

    for (const entry of entries) {
      if (!entry.sid || !indices.has(entry.sid)) {
        return null;
      }
    }

    return {
      groups: latestKnownSessionGroups,
      indices,
    };
  }

  function removeSessionSectionHeaders(targetContainer = null) {
    if (typeof document === "undefined") return;
    const scope = targetContainer && typeof targetContainer.querySelectorAll === "function" ? targetContainer : document;
    const fallbackNodes = scope.querySelectorAll('.pi-enh-session-section-header[data-pi-enh-fallback="true"]');
    if (!fallbackNodes || fallbackNodes.length === 0) return;
    const doRemove = () => {
      for (const node of fallbackNodes) {
        if (targetContainer && node.parentElement !== targetContainer) continue;
        node.remove();
      }
    };
    if (typeof withMutationGuard === "function") {
      withMutationGuard(doRemove);
    } else {
      doRemove();
    }
  }

  function applySessionSectionHeaderStyle(el, section, topPx) {
    if (!el || !el.style) return;
    const isPinned = section === "pinned";
    const expectedHeight = (isPinned ? SESSION_PINNED_HEADER_HEIGHT : SESSION_RECENTS_HEADER_HEIGHT) + "px";
    const expectedTop = isPinned ? "0px" : topPx;
    const expectedAlign = isPinned ? "center" : "flex-end";
    const expectedText = isPinned ? "Pinned" : "Recents";

    if (el.style.position !== "absolute") el.style.position = "absolute";
    if (el.style.top !== expectedTop) el.style.top = expectedTop;
    if (el.style.left !== "0px") el.style.left = "0px";
    if (el.style.right !== "0px") el.style.right = "0px";
    if (el.style.height !== expectedHeight) el.style.height = expectedHeight;
    if (el.style.display !== "flex") el.style.display = "flex";
    if (el.style.alignItems !== expectedAlign) el.style.alignItems = expectedAlign;
    if (el.style.paddingLeft !== "14px") el.style.paddingLeft = "14px";
    if (el.style.paddingRight !== "8px") el.style.paddingRight = "8px";
    if (!isPinned && el.style.paddingBottom !== "5px") el.style.paddingBottom = "5px";
    if (el.style.fontSize !== "12px") el.style.fontSize = "12px";
    if (el.style.fontWeight !== "400") el.style.fontWeight = "400";
    if (el.style.color !== "var(--text-muted, #71717a)") el.style.color = "var(--text-muted, #71717a)";
    if (el.style.userSelect !== "none") el.style.userSelect = "none";
    if (el.style.pointerEvents !== "none") el.style.pointerEvents = "none";
    if (el.style.letterSpacing !== "0.01em") el.style.letterSpacing = "0.01em";
    if (el.textContent !== expectedText) el.textContent = expectedText;
  }

  function syncSessionSectionHeaders() {
    if (isDisposed || typeof document === "undefined") return;

    if (!Array.isArray(latestKnownSessionGroups) || !latestKnownSessionGroups.length) {
      if (Array.isArray(window.__PI_ENH_EARLY_SESSION_GROUPS__) && window.__PI_ENH_EARLY_SESSION_GROUPS__.length > 0) {
        processSessionGroups(window.__PI_ENH_EARLY_SESSION_GROUPS__);
      }
    }

    const rows = document.querySelectorAll(".pi-enh-session-row-host[data-pi-enh-session-id]");
    if (!rows || rows.length === 0) {
      removeSessionSectionHeaders();
      return;
    }

    const containerMap = new Map();
    for (const row of rows) {
      const sid = row.getAttribute("data-pi-enh-session-id") || row.dataset?.piEnhSessionId;
      if (!sid) continue;
      const wrapper = row.parentElement;
      if (!wrapper || wrapper.tagName !== "DIV" || wrapper.style.position !== "absolute") continue;
      const container = wrapper.parentElement;
      if (!container || container.tagName !== "DIV" || container.style.position !== "relative") continue;
      if (typeof container.closest === "function" && container.closest(".settings-dialog-backdrop, [role='dialog']")) continue;
      let list = containerMap.get(container);
      if (!list) {
        list = [];
        containerMap.set(container, list);
      }
      list.push({ row, wrapper, sid });
    }

    if (containerMap.size === 0) {
      removeSessionSectionHeaders();
      return;
    }

    const headersFeatureActive = isPluginEnabled("session-pin-archive") && isPluginEnabled("session-section-headers");

    const syncDom = () => {
      const activePinnedContainers = new Set();

      for (const [container, entries] of containerMap.entries()) {
        const childHeaders = Array.from(container.children).filter(
          (el) => el.classList && el.classList.contains("pi-enh-session-section-header")
        );
        const nativeHeaders = childHeaders.filter(
          (el) => el.getAttribute("data-pi-enh-fallback") !== "true"
        );
        const fallbackHeaders = childHeaders.filter(
          (el) => el.getAttribute("data-pi-enh-fallback") === "true"
        );

        if (nativeHeaders.length > 0) {
          for (const fh of fallbackHeaders) fh.remove();
          continue;
        }

        const resolved = headersFeatureActive
          ? resolveVirtualContainerSessionGroups(entries)
          : null;

        if (!resolved) {
          for (const fh of fallbackHeaders) fh.remove();
          continue;
        }

        const groups = resolved.groups;
        const pinnedCount = getPinnedSessionCount(groups);
        const total = groups.length;

        if (pinnedCount <= 0) {
          for (const fh of fallbackHeaders) fh.remove();
          continue;
        }

        activePinnedContainers.add(container);

        const pinnedCandidates = fallbackHeaders.filter(
          (el) => el.classList.contains("pi-enh-session-section-pinned") || el.getAttribute("data-pi-enh-section") === "pinned"
        );
        let pinnedEl = pinnedCandidates[0] || null;
        for (let i = 1; i < pinnedCandidates.length; i++) {
          pinnedCandidates[i].remove();
        }
        if (!pinnedEl) {
          pinnedEl = document.createElement("div");
          pinnedEl.className = "pi-enh-session-section-header pi-enh-session-section-pinned";
          pinnedEl.setAttribute("data-pi-enh-section", "pinned");
          pinnedEl.setAttribute("data-pi-enh-fallback", "true");
        }
        applySessionSectionHeaderStyle(pinnedEl, "pinned", "0px");
        if (pinnedEl.parentElement !== container) {
          container.insertBefore(pinnedEl, container.firstChild);
        }

        const recentsCandidates = fallbackHeaders.filter(
          (el) => el.classList.contains("pi-enh-session-section-recents") || el.getAttribute("data-pi-enh-section") === "recents"
        );
        let recentsEl = recentsCandidates[0] || null;
        for (let i = 1; i < recentsCandidates.length; i++) {
          recentsCandidates[i].remove();
        }

        if (pinnedCount < total) {
          const recentsTopPx = (getSessionItemTop(pinnedCount, groups) - SESSION_RECENTS_HEADER_HEIGHT) + "px";
          if (!recentsEl) {
            recentsEl = document.createElement("div");
            recentsEl.className = "pi-enh-session-section-header pi-enh-session-section-recents";
            recentsEl.setAttribute("data-pi-enh-section", "recents");
            recentsEl.setAttribute("data-pi-enh-fallback", "true");
          }
          applySessionSectionHeaderStyle(recentsEl, "recents", recentsTopPx);
          if (recentsEl.parentElement !== container) {
            container.insertBefore(recentsEl, pinnedEl.nextSibling);
          }
        } else if (recentsEl) {
          recentsEl.remove();
          recentsEl = null;
        }

        for (const fh of fallbackHeaders) {
          if (fh !== pinnedEl && fh !== recentsEl && fh.parentElement === container) {
            fh.remove();
          }
        }
      }

      for (const stray of document.querySelectorAll('.pi-enh-session-section-header[data-pi-enh-fallback="true"]')) {
        if (!stray.parentElement || !activePinnedContainers.has(stray.parentElement)) {
          stray.remove();
        }
      }
    };

    if (typeof withMutationGuard === "function") {
      withMutationGuard(syncDom);
    } else {
      syncDom();
    }
  }

  if (Array.isArray(activeCleanups)) {
    activeCleanups.push(() => {
      removeSessionSectionHeaders();
    });
  }

  window.__PI_ENH_GET_SESSION_HEADERS_HEIGHT__ = getSessionHeadersHeight;
  window.__PI_ENH_GET_SESSION_HEADERS__ = getSessionHeaders;
  window.__PI_ENH_GET_SESSION_ITEM_TOP__ = getSessionItemTop;
  window.__PI_ENH_GET_SESSION_ITEM_HEIGHT__ = getSessionItemHeight;
  window.__PI_ENH_GET_PINNED_SESSION_COUNT__ = getPinnedSessionCount;
  window.__PI_ENH_SYNC_SESSION_SECTION_HEADERS__ = syncSessionSectionHeaders;
  window.__PI_ENH_REMOVE_SESSION_SECTION_HEADERS__ = removeSessionSectionHeaders;

  function toggleSessionPin(sessionId) {
    if (!sessionId) return false;
    const pinnedIds = readStoredSessionIds(PINNED_SESSION_STORAGE_KEY);
    const isPinned = pinnedIds.has(sessionId);
    if (isPinned) pinnedIds.delete(sessionId);
    else pinnedIds.add(sessionId);
    writeStoredSessionIds(PINNED_SESSION_STORAGE_KEY, pinnedIds);
    if (Array.isArray(window.__PI_ENH_PINNED_MANIFEST__)) {
      window.__PI_ENH_PINNED_MANIFEST__ = window.__PI_ENH_PINNED_MANIFEST__.filter((e) => (typeof e === "string" ? e !== sessionId : e?.id !== sessionId));
      if (!isPinned) window.__PI_ENH_PINNED_MANIFEST__.push(sessionId);
    }
    if (Array.isArray(latestKnownSessionGroups) && latestKnownSessionGroups.length > 0) {
      processSessionGroups(latestKnownSessionGroups);
    }
    syncSessionOdooAddonsLayout();
    syncSessionSectionHeaders();
    void persistPinnedSessionsToServer(pinnedIds);
    return !isPinned;
  }

  function archiveSession(sessionId, meta = {}) {
    if (!sessionId) return false;
    unmarkSessionAsRecentlyRestored(sessionId);
    const entries = readStoredArchivedEntries();
    if (entries.some((e) => e.id === sessionId)) {
      writeStoredArchivedEntries(entries);
      void persistArchivedSessionsToServer(entries, undefined, true);
      return true;
    }
    const knownTitle = knownSessionTitles.get(sessionId);
    const finalName = (meta.name && meta.name !== sessionId) ? meta.name : (knownTitle || meta.name || sessionId.slice(0, 12));
    entries.unshift({
      id: sessionId,
      name: finalName,
      cwd: meta.cwd || "",
      archivedAt: meta.archivedAt || Date.now(),
    });
    writeStoredArchivedEntries(entries);
    if (Array.isArray(window.__PI_ENH_ARCHIVED_MANIFEST__)) {
      window.__PI_ENH_ARCHIVED_MANIFEST__ = window.__PI_ENH_ARCHIVED_MANIFEST__.filter((e) => (typeof e === "string" ? e !== sessionId : e?.id !== sessionId));
      window.__PI_ENH_ARCHIVED_MANIFEST__.unshift(entries[0]);
    }
    try {
      const uIds = readUnreadSessionIds();
      if (uIds.has(sessionId)) {
        uIds.delete(sessionId);
        writeUnreadSessionIds(uIds);
        if (typeof window !== "undefined" && typeof window.__PI_ENH_SET_UNREAD_SESSION__ === "function") {
          window.__PI_ENH_SET_UNREAD_SESSION__(sessionId, false);
        }
      }
    } catch (e) {}
    void persistArchivedSessionsToServer(entries, undefined, true);
    return true;
  }

  function restoreArchivedSessions(sessionIds) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return 0;
    const targetSet = new Set(sessionIds.map((id) => (typeof id === "string" ? id.trim() : id?.id)).filter(Boolean));
    if (targetSet.size === 0) return 0;

    const entries = readStoredArchivedEntries();
    const next = entries.filter((e) => !targetSet.has(e.id));
    const restoredCount = entries.length - next.length;
    if (restoredCount === 0) return 0;

    for (const sid of targetSet) {
      markSessionAsRecentlyRestored(sid);
    }

    writeStoredArchivedEntries(next);
    if (Array.isArray(window.__PI_ENH_ARCHIVED_MANIFEST__)) {
      window.__PI_ENH_ARCHIVED_MANIFEST__ = window.__PI_ENH_ARCHIVED_MANIFEST__.filter((e) => {
        const id = typeof e === "string" ? e : e?.id;
        return id && !targetSet.has(id);
      });
    }
    void persistArchivedSessionsToServer(next, undefined, true);
    return restoredCount;
  }

  function restoreArchivedSession(sessionId) {
    if (!sessionId) return false;
    return restoreArchivedSessions([sessionId]) > 0;
  }

  function isArchiveAutoRestoreOnPromptEnabled() {
    const val = getPluginSetting("session-pin-archive", "autoRestoreOnPrompt");
    return val === undefined || Number(val) === 1 || val === true;
  }

  function handleSessionWakeupIfArchived(sessionId) {
    if (!sessionId || !isPluginEnabled("session-pin-archive") || !isArchiveAutoRestoreOnPromptEnabled()) {
      return false;
    }
    const archivedIds = readStoredSessionIds(ARCHIVED_SESSION_STORAGE_KEY);
    if (!archivedIds.has(sessionId)) return false;

    if (restoreArchivedSession(sessionId)) {
      requestSessionListRefresh();
      showToast("已自动唤醒会话并恢复至列表", sessionArchiveIcon);
      const panel = document.querySelector(".pi-enh-archived-panel");
      const nav = document.querySelector(".settings-section-tabs");
      if (panel && panel.style.display !== "none") {
        renderArchivedPanel(panel, nav);
      }
      return true;
    }
    return false;
  }

  // ==========================================
  // 0.1.1 Search Results Grouping & Retention Management
  // ==========================================
  const RETENTION_DAYS_STORAGE_KEY = "pi-enh-archive-retention-days";
  const DEFAULT_RETENTION_DAYS = 60;

  function getArchiveRetentionDays() {
    return getPluginSetting("session-pin-archive", "retentionDays") ?? DEFAULT_RETENTION_DAYS;
  }

  function setArchiveRetentionDays(days) {
    return setPluginSetting("session-pin-archive", "retentionDays", days);
  }

  async function purgeExpiredArchives() {
    const retentionDays = getArchiveRetentionDays();
    if (retentionDays <= 0) return 0;

    const cutoffTime = Date.now() - (retentionDays * 86400000);
    const entries = readStoredArchivedEntries();
    const expired = entries.filter((e) => e.archivedAt && e.archivedAt < cutoffTime);
    if (expired.length === 0) return 0;

    let purgedCount = 0;
    const successfullyPurgedIds = new Set();
    for (const exp of expired) {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(exp.id)}`, { method: "DELETE" });
        if (res && (res.ok || res.status === 404)) {
          successfullyPurgedIds.add(exp.id);
          purgedCount += 1;
        } else {
          throw new Error(`HTTP ${res?.status || 'unavailable'}`);
        }
      } catch (e) {
        console.error('[pi-enh] expired archive deletion failed; entry retained:', exp.id, e);
      }
    }

    if (purgedCount > 0) {
      const remaining = readStoredArchivedEntries().filter((e) => !successfullyPurgedIds.has(e.id));
      writeStoredArchivedEntries(remaining);
      if (Array.isArray(window.__PI_ENH_ARCHIVED_MANIFEST__)) {
        window.__PI_ENH_ARCHIVED_MANIFEST__ = window.__PI_ENH_ARCHIVED_MANIFEST__.filter((e) => (typeof e === "string" ? !successfullyPurgedIds.has(e) : !successfullyPurgedIds.has(e?.id)));
      }
      void persistArchivedSessionsToServer(remaining, undefined, true);
      requestSessionListRefresh();
      const panel = document.querySelector(".pi-enh-archived-panel");
      const nav = document.querySelector(".settings-section-tabs");
      if (panel && panel.style.display !== "none") {
        renderArchivedPanel(panel, nav);
      }
    }

    return purgedCount;
  }

  function getSessionProjectKey(session) {
    return String(session?.projectKey || session?.projectRoot || session?.cwd || "other")
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLowerCase();
  }

  function isSessionInCurrentProject(session, currentProjectKey) {
    if (!currentProjectKey) return true;
    const sessionKey = getSessionProjectStatusKey(session);
    if (!sessionKey) return false;
    if (sessionKey === currentProjectKey) return true;
    if (sessionKey.startsWith(currentProjectKey + "\\")) return true;
    return false;
  }

  function processSearchResults(results) {
    if (!Array.isArray(results) || results.length === 0) {
      return results;
    }
    const isFoldingEnabled = isPluginEnabled("session-search-project-folding");
    const isArchivePluginEnabled = isPluginEnabled("session-pin-archive");
    const archivedIds = isArchivePluginEnabled ? readStoredSessionIds(ARCHIVED_SESSION_STORAGE_KEY) : new Set();
    const currentProjectKey = getCurrentProjectStatusKey();

    const currentActive = [];
    const otherProjectsMap = new Map();
    const archived = [];

    for (const item of results) {
      const sessionId = item.session?.id;
      const isArchived = Boolean(sessionId && archivedIds.has(sessionId));

      if (isArchived) {
        archived.push({
          ...item,
          isArchived: true,
          searchGroup: "archived",
        });
      } else if (isFoldingEnabled && currentProjectKey && !isSessionInCurrentProject(item.session, currentProjectKey)) {
        const pKey = getSessionProjectKey(item.session);
        const pTitle = item.session?.projectRoot || item.session?.cwd || "其他项目";
        if (!otherProjectsMap.has(pKey)) {
          otherProjectsMap.set(pKey, { projectKey: pKey, projectTitle: pTitle, items: [] });
        }
        const enrichedItem = {
          ...item,
          isArchived: false,
          isOtherProject: true,
          searchGroup: "other",
          searchProjectKey: pKey,
          searchProjectTitle: pTitle,
        };
        otherProjectsMap.get(pKey).items.push(enrichedItem);
      } else {
        currentActive.push({
          ...item,
          isArchived: false,
          isCurrentProject: true,
          searchGroup: "current",
        });
      }
    }

    const otherItems = [];
    for (const group of otherProjectsMap.values()) {
      if (group.items.length > 0) {
        group.items[0].isFirstInProject = true;
        group.items[0].projectSearchCount = group.items.length;
        group.items[0].projectTitle = group.projectTitle;
        group.items[0].projectKey = group.projectKey;
        otherItems.push(...group.items);
      }
    }

    if (otherItems.length > 0) {
      otherItems[0].isFirstOther = true;
      otherItems[0].otherSearchCount = otherItems.length;
    }

    if (archived.length > 0) {
      // The native React search renderer owns this marker, which guarantees a
      // single divider even while a query is repeatedly re-rendered.
      archived[0].isFirstArchived = true;
      archived[0].archivedSearchCount = archived.length;
    }

    return [...currentActive, ...otherItems, ...archived];
  }

  async function deleteArchivedSession(sessionId) {
    if (!sessionId) return false;
    markSessionAsDeleted(sessionId);

    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
      if (!resp || (!resp.ok && resp.status !== 404)) {
        restoreSessionDeleteState(sessionId);
        const detail = resp ? await resp.json().catch(() => ({})) : {};
        throw new Error(typeof detail.error === "string" ? detail.error : "无法连接执行端，请稍后重试");
      }

      markSessionDeleteConfirmed(sessionId);
      cleanupDeletedSessionEverywhere(sessionId);

      try {
        const currentId = (typeof getCurrentSessionId === "function" ? getCurrentSessionId() : null) ||
          (typeof window !== "undefined" && window.location ? new URLSearchParams(window.location.search).get("session") : null);
        const notifyNativeDeletion = typeof window !== "undefined" ? window.__PI_ENH_SESSION_DELETED__ : null;
        if (typeof notifyNativeDeletion === "function") {
          notifyNativeDeletion(sessionId);
        }
        if (currentId === sessionId && typeof window !== "undefined" && window.location) {
          const url = new URL(window.location.href);
          if (url.searchParams.has("session")) {
            url.searchParams.delete("session");
            window.history.replaceState(null, "", url.pathname + (url.search ? url.search : ""));
          }
        }
        requestSessionListRefresh(false, true);
      } catch (e) {}

      return true;
    } catch (err) {
      restoreSessionDeleteState(sessionId);
      throw err;
    }
  }

  window.__PI_ENH_PROCESS_SESSION_GROUPS__ = processSessionGroups;
  window.__PI_ENH_TOGGLE_SESSION_PIN__ = toggleSessionPin;
  window.__PI_ENH_ARCHIVE_SESSION__ = archiveSession;
  window.__PI_ENH_RESTORE_ARCHIVED_SESSION__ = restoreArchivedSession;
  window.__PI_ENH_RESTORE_ARCHIVED_SESSIONS__ = restoreArchivedSessions;
  window.__PI_ENH_UNMARK_RECENTLY_RESTORED__ = unmarkSessionAsRecentlyRestored;
  window.__PI_ENH_GET_RECENTLY_RESTORED__ = getRecentlyRestoredArchivedIds;
  window.__PI_ENH_DELETE_ARCHIVED_SESSION__ = deleteArchivedSession;
  window.__PI_ENH_HANDLE_SESSION_WAKEUP_IF_ARCHIVED__ = handleSessionWakeupIfArchived;
  window.__PI_ENH_IS_ARCHIVE_AUTO_RESTORE_ENABLED__ = isArchiveAutoRestoreOnPromptEnabled;
  window.__PI_ENH_PROCESS_SEARCH_RESULTS__ = processSearchResults;
  window.__PI_ENH_GET_ARCHIVE_RETENTION_DAYS__ = getArchiveRetentionDays;
  window.__PI_ENH_SET_ARCHIVE_RETENTION_DAYS__ = setArchiveRetentionDays;
  window.__PI_ENH_PURGE_EXPIRED_ARCHIVES__ = purgeExpiredArchives;

