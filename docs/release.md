# Agent Web Plus 发布流程

发布仓库保持 [`koxircom/pi-web-plus`](https://github.com/koxircom/pi-web-plus/releases)。内部包名继续使用 `@agegr/pi-web`，保留 `pi-web`、`agent-web` 命令和旧数据目录；不发布到公共 npm 注册表。

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

`origin` 必须为 `https://github.com/koxircom/pi-web-plus.git`。不要使用 `--tags` 推送无关标签；不要强推或重写历史。只有源码已完成审查、脱敏及本次必要验收，才推送；上传入口会再次核对远程标签指向的完整提交 SHA。

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

支持 `.tgz`、`.tar.gz`、`.tar`、`.zip` 及文本校验附件。损坏、加密、嵌套压缩包、链接、路径穿越、空包和超出扫描上限均阻止上传。扫描识别凭据格式、非空敏感配置、私钥、个人目录和私有网络地址；不执行自动替换，也不能代替泄露密钥的吊销。

## 4. 回执与失败处理

统一启动器在私有运维目录保存最近回执，包括扫描结果、账号、仓库、标签、附件 SHA256 和终态。也可直接给容器脚本传 `--report`，报告放在源码之外。

扫描失败时修复报告指出的源文件，再重新构建；不能跳过关卡。上传或回读失败时停止，已创建的 Release 保持草稿，先核对草稿附件再决定下一步，不自动覆盖或重传。

发布本身不会升级运行实例。实例升级仍须明确目标及授权，保留原会话、置顶、设置、用量账本和实例配置，并按维护流程切换。不得把 GitHub 发布成功当作运行实例升级完成。

旧五步流程保存在 [历史发布清单](archive/release-checklist-before-container-gate.md)，只供追溯。
