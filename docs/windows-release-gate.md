# Windows 触控发布门禁

影响共享触控/右侧面板的版本，切换运行包前必须在 Windows ego lite 中执行 `scripts/qa/pi30141-touch-gate.mjs`，并验证回执：

```
node scripts/qa/windows-touch-deployment-gate.mjs CANDIDATE_ROOT WINDOWS_RECEIPT.json
```

配置样例在 `scripts/qa/pi30141-touch-gate.config.example.json`。复用任务自己的 TaskSpace 与 Page，配置 Pi/Codex 隔离历史会话；不创建模型生成请求。输出回执保存在源码外。

固定矩阵为 Pi/Codex × 390/800/1124 CSS 像素。每个组合检查三指取消、三指结束、长按，以及真实鼠标选字后长按并送达受控 touchcancel。探针从输入前持续到结束后至少400ms，同时记录requestAnimationFrame几何状态和面板class/style变化。任何中间帧或样式变化显示面板、事件未实际送达、选区丢失、缺项、构建或资源哈希不符均拒绝发布；只检查最终关闭状态不算通过。

原生长按没有生成操作系统选区时，回执必须明确列为能力缺口，不能声称完成实体触屏验收。真实鼠标选字和受控取消检查是必需项，不能以能力缺口跳过。实体触屏行为仍需在可用设备上实测。

Linux prepack执行门禁契约测试，不伪造Windows结果或启动外部桌面。部署方必须将上述验证命令作为切换前置条件，绑定待安装包的BUILD_ID和实际资源字节，并保存回执SHA256；缺少回执即停止。部署后再在真实入口回读相同指纹并检查直接受影响交互。
