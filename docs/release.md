# Agent Web Plus 发布流程

发布仓库为 [`koxircom/agent-web-plus`](https://github.com/koxircom/agent-web-plus/releases)。内部包名继续使用 `@agegr/pi-web`，保留 `pi-web`、`agent-web` 命令和旧数据目录；不发布到公共 npm 注册表。

## 唯一认证入口

维护者统一在已登记的发布容器内使用现有 GitHub CLI 登录。SSH 别名、容器名和运维启动器放在私有部署目录；公开源码不保存设备地址、密码或令牌。发布脚本拒绝环境变量令牌覆盖，不导出认证，不回退到调用电脑的 `gh` 登录。

容器内预检：

```bash
python3 scripts/publish-release.py --check-auth
```

维护环境的统一启动器通过 SSH 调用上述脚本，所有 `--root`、`--asset`、`--notes-file` 参数都是容器内路径。日常发布使用该启动器，不分别在各电脑登录 GitHub。更换发布容器属于维护操作，需要重新核查账号和仓库权限。

## 认证权限与可选 CI

常规源码推送与 Release 发布使用容器已有的仓库权限。上传前的源码、发布说明、最终附件扫描由本项目发布脚本强制执行，不依赖 GitHub Actions；日常发布不要求增加账号权限。

可选的 GitHub Actions 脱敏检查模板保存在 [`docs/ci/publication-check.yml.example`](ci/publication-check.yml.example)。维护者需要自动检查每次推送或拉取请求时，可另行启用：将模板复制到 `.github/workflows/publication-check.yml`，并由具备 `workflow` 权限的认证提交。该可选流程不作为容器发布的前置条件；模板中的检查与发布脚本门禁均予保留。

## 1. 准备源码和构建产物

使用 Node.js >=22.19、Python >=3.11，从已审查的源码构建。生产构建只能在独立发布目录运行，不能占用开发或运行中实例的 `.next`。源码和依赖的真实路径必须使用不含个人账号的构建目录；不要将依赖符号链接回个人 HOME。TypeScript 增量缓存不属于发布内容。

```bash
npm run check:publication
npm run build
npm pack
```

`prepack` 也执行源码脱敏扫描及已有质量关卡。最终附件另放在源码目录外，命名为 `pi-web-plus-<版本>.tgz`；保持安装地址兼容。检查压缩包结构、在隔离前缀安装，并验证 `pi-web --help` 和 `agent-web --help`。这些验收沿用当前变更的有效证据，不重复无关全量回归。

## 2. 提交并核对远程标签

审查并提交当前变更，标签格式为 `v<版本>`，必须与 `package.json.version` 一致。在同一已登记容器内推送源码及本次标签：

```bash
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin main
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin "v${VERSION}"
```

`origin` 必须为 `https://github.com/koxircom/agent-web-plus.git`。不要使用 `--tags` 推送无关标签；不要强推或重写历史。只有源码已完成审查、脱敏及本次必要验收，才推送；上传入口会再次核对远程标签指向的完整提交 SHA。

## 3. 先预检，再显式发布

在容器内运行（维护者可通过统一 SSH 启动器执行同样参数）：

```bash
python3 scripts/publish-release.py \
  --root /workspace/source \
  --tag "v${VERSION}" \
  --target "$COMMIT_SHA" \
  --asset "/workspace/artifacts/pi-web-plus-${VERSION}.tgz" \
  --notes-file /workspace/artifacts/release-notes.md
```

默认只预检，不创建 Release、不上传附件。需要正式发布时，在同一命令后添加 `--apply`。可重复传 `--asset` 上传校验文件；重复附件名会被拒绝。

关卡顺序：

1. 将附件和发布说明复制到独立临时目录。
2. 扫描源码及临时副本中的实际内容，包括压缩包内 `.next`、测试目录、JSON 配置及发布说明。报告只包含路径、行号与类别，不输出命中值。
3. 核对容器已保存的认证、账号、仓库权限、版本与远程标签。任何失败立即停止。
4. `--apply` 创建草稿，上传已扫描副本；不覆盖或追加已有 Release。
5. 下载附件并比对 SHA256，一致后公开。稳定版设为 Latest，预发布版保留 prerelease 标记，不设为 Latest。

支持 `.tgz`、`.tar.gz`、`.tar`、`.zip`、MP4 视频及文本校验附件。MP4 会校验文件头并对实际文件字节执行相同敏感内容扫描；画面与音轨还须在制作环节人工核查，字节扫描不能证明画面已经脱敏。损坏、加密、嵌套压缩包、链接、路径穿越、空包和超出扫描上限均阻止上传。扫描识别凭据格式、非空敏感配置、私钥、个人目录和私有网络地址；不执行自动替换，也不能代替泄露密钥的吊销。

## 4. 回执与失败处理

统一启动器在私有运维目录保存最近回执，包括扫描结果、账号、仓库、标签、附件 SHA256 和终态。也可直接给容器脚本传 `--report`，报告放在源码之外。

扫描失败时修复报告指出的源文件，再重新构建；不能跳过关卡。上传或回读失败时停止，已创建的 Release 保持草稿，先核对草稿附件再决定下一步，不自动覆盖或重传。

草稿可能不会由按标签查询的接口返回；发布工具会补查已认证的 Release 列表，避免误判不存在。若本次回执已经创建草稿且附件均完整，可在相同参数上显式添加 `--finalize-draft <Release数字ID> --apply` 继续收尾。此入口必须匹配标签、指定草稿 ID 和当前账号所有者；仍重新扫描源码与附件、校验资产集合、下载比对 SHA256，全部通过才公开，不创建新草稿或重新上传。草稿附件缺失或指纹不符时停止并保留草稿。

发布本身不会升级运行实例。实例升级仍须明确目标及授权，保留原会话、置顶、设置、用量账本和实例配置，并按维护流程切换。不得把 GitHub 发布成功当作运行实例升级完成。

## README 中直接播放介绍视频

Release 的 MP4 附件用于可选下载。README 的播放器使用 GitHub 视频附件地址，独立放在一个段落中；不要把封面链接到 Release 下载地址充当在线播放。

通过同一容器发布入口执行：

```bash
python3 scripts/publish-release.py --readme-video \
  --root /workspace/source --target "$MAIN_COMMIT_SHA" \
  --asset /workspace/artifacts/introduction.mp4
```

先预检，再增加 `--apply`。此模式要求当前 main 的完整提交、一个不超过 10 MB 的 MP4，复用容器已有认证；扫描源码和实际视频后上传，不创建 issue、PR 或 Release。回读 GitHub 渲染的播放资源并核对 SHA256，只公开永久附件地址，不保存临时播放凭据。

回执保存在发布容器用户的 `.local/state/agent-web-publisher/readme-videos/`。已得到附件地址但核验未完成时，同一文件再次执行只恢复读取核验；上传结果不明时禁止重新上传。将返回地址提交到 README 后，使用未登录的手机尺寸浏览器确认播放器可播放、进度前进且不触发下载。

旧五步流程保存在 [历史发布清单](archive/release-checklist-before-container-gate.md)，只供追溯。


## 向已有 Release 追加介绍视频

已公开的软件版本不因补充视频重新打包或移动标签。通过统一容器启动器传入原版本、标签对应的完整提交 SHA、公开 Release 数字 ID，以及一个已检查的 MP4：

```bash
python3 scripts/publish-release.py \
  --root /workspace/source \
  --tag "v${VERSION}" --target "$COMMIT_SHA" \
  --asset /workspace/artifacts/Agent-Web-Plus-Introduction-1080p.mp4 \
  --notes-file /workspace/artifacts/video-notes.md \
  --append-media-to "$RELEASE_ID"
```

默认只预检；明确发布后添加 `--apply`。此入口仍检查源码、说明、实际视频副本、容器认证与标签，且只接受当前账号拥有的公开 Release 和一个新名称的 MP4。发布说明文件作为新增视频段落追加，保留原文。

上传前后核对原有软件包的附件 ID、名称、大小和 GitHub 摘要；视频下载回读 SHA256 一致后才追加说明。不会覆盖同名附件、移动标签、改变 Latest 或重新上传软件包。视频追加不能在原 Release 中建立独立草稿，因此上传后立即可见；若回读或并发检查失败，停止并保留附件供核查，不自动覆盖或重传。
