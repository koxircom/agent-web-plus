# Release Checklist

PI Web Plus releases are distributed exclusively through [`koxircom/pi-web-plus` GitHub Releases](https://github.com/koxircom/pi-web-plus/releases):

- GitHub Release tag: `v<version>` in `koxircom/pi-web-plus` (for example, `v1.3.8`)
- Release tarball asset: `pi-web-plus-<version>.tgz` (for example, `pi-web-plus-1.3.8.tgz`)
- Official install command (replace `<version>` when targeting another release):
  ```bash
  npm install -g https://github.com/koxircom/pi-web-plus/releases/download/v1.3.8/pi-web-plus-1.3.8.tgz
  ```

> **Release Invariants**:
> - `package.json` keeps `"name": "@agegr/pi-web"` (alongside `"piWebEdition": "koxir-standalone"` and `"standalone": true`) for internal runtime compatibility, but **never publish to or pull from the public npm registry**.
> - **Web SDK `1.0.2` vs. Global Pi Agent CLI**: PI Web Plus `v1.3.8` unifies `@earendil-works/pi-*` Web dependencies at `1.0.2`; installing Pi Web does **not** automatically upgrade the global `pi` Agent CLI on the host.
> - **Tarball excludes `node_modules/`**: `pi-web-plus-1.3.8.tgz` ships prebuilt `.next/`, `bin/`, and `public/` assets without `node_modules/`, requiring standard dependency installation (or verified offline `node_modules/` reuse).
> - **Protect custom manifests, sessions, and ledgers**: Staging and instance upgrades must preserve instance-specific `public/pi-*-manifest.json`, session files (`~/.pi/agent/sessions/`), and usage ledgers (`pi-usage-ledger.json` / `~/.pi/agent/state/`).
> - **Pushing `main` alone is not a release**: every release must complete all 5 steps below — preflight & version preparation, offline build + `npm pack` + tarball verification, clean install verification, GitHub Release asset upload + `Latest` verification, and running-instance synchronization.

Use this 5-step checklist from a clean `main` checkout with Node.js `>=22.19.0`.

## 1. Preflight & Version Preparation

Verify Node.js (`node >=22.19`), repository state, GitHub CLI authentication, package metadata, and quality checks:

```bash
node --version
git status --short --branch
git log --oneline --decorate -5
gh auth status
node -e "const p=require('./package.json'); console.log(p.name, p.version, p.piWebEdition, p.standalone)"
npm test
node_modules/.bin/tsc --noEmit
npm run lint
```

Expected:

- Node.js is `22.19.0` or newer (`>=22.19.0`).
- `git status` is clean, or only contains the intentional version bump (`package.json` and `package-lock.json`, e.g. `1.3.8`).
- `package.json` retains `"name": "@agegr/pi-web"`, `"piWebEdition": "koxir-standalone"`, and `"standalone": true`.
- GitHub CLI is authenticated with write/release access to `koxircom/pi-web-plus`.

## 2. Offline Build, `npm pack`, and Tarball Verification

Run the production build and pack the PI Web Plus tarball locally. Do not run `next build` during normal development; release packaging is the exception.

```bash
VERSION=$(node -p "require('./package.json').version")
npm run build
PACK_FILE=$(npm pack)
mv "$PACK_FILE" "pi-web-plus-${VERSION}.tgz"
ls -lh "pi-web-plus-${VERSION}.tgz"
```

Inspect the archive to verify that required runtime files are included and development/cache artifacts are excluded:

```bash
tar -ztvf "pi-web-plus-${VERSION}.tgz" | head -n 40
tar -ztf "pi-web-plus-${VERSION}.tgz" | rg "^package/(bin/pi-web\.js|package\.json|\.next/BUILD_ID|public/)"
! tar -ztf "pi-web-plus-${VERSION}.tgz" | rg "^package/\.next/(cache|dev)/|\.js\.map$"
```

## 3. Clean Install Verification

Before tagging or uploading the release asset, verify that `pi-web-plus-${VERSION}.tgz` installs cleanly into an isolated prefix and that the `pi-web` CLI entrypoint works:

```bash
TMP_PREFIX=$(mktemp -d)
npm install -g --prefix "$TMP_PREFIX" "./pi-web-plus-${VERSION}.tgz"
"$TMP_PREFIX/bin/pi-web" --help
rm -rf "$TMP_PREFIX"
```

## 4. Commit, Tag, Upload GitHub Release Asset, and Verify `Latest`

Commit the version bump (if not already committed), create the annotated `v<version>` tag, and push `main` and tags to `koxircom/pi-web-plus`:

```bash
git diff -- package.json package-lock.json
git add package.json package-lock.json
git commit -m "Release v${VERSION}"
git tag -a "v${VERSION}" -m "v${VERSION}"
git push origin main --tags
```

Prepare bilingual (Chinese and English) release notes from the commit range `v<previous>..v${VERSION}`:

```bash
git log --oneline --decorate "v<previous>..v${VERSION}"
git diff --stat "v<previous>..v${VERSION}"
```

Create the GitHub Release on `koxircom/pi-web-plus`, attach `pi-web-plus-${VERSION}.tgz`, and mark it as `Latest` (required because `/api/app-update` checks `releases/latest`):

```bash
gh release create "v${VERSION}" \
  "./pi-web-plus-${VERSION}.tgz#pi-web-plus-${VERSION}.tgz" \
  --repo koxircom/pi-web-plus \
  --verify-tag \
  --latest \
  --title "v${VERSION}" \
  --notes-file release-notes.md
```

Verify the published release metadata, asset URL, and `isLatest: true` status:

```bash
gh release view "v${VERSION}" \
  --repo koxircom/pi-web-plus \
  --json tagName,isDraft,assets,url
gh api repos/koxircom/pi-web-plus/releases/latest --jq '.tag_name'
```

Expected:

- `isDraft` is `false`, and the `/releases/latest` API returns `v${VERSION}`.
- `assets` contains `pi-web-plus-${VERSION}.tgz` with download URL `https://github.com/koxircom/pi-web-plus/releases/download/v${VERSION}/pi-web-plus-${VERSION}.tgz`.

## 5. Synchronize Running Instances

Pushing `main` or publishing a GitHub Release does **not** automatically update running Pi Web environments. After verifying the release asset and `Latest` status, upgrade target running instances from the official GitHub Release tarball (for example, `v1.3.8`):

```bash
npm install -g "https://github.com/koxircom/pi-web-plus/releases/download/v${VERSION}/pi-web-plus-${VERSION}.tgz"
```

After installation:

- Verify the installed `package.json` reports `"version": "${VERSION}"`, `"piWebEdition": "koxir-standalone"`, and `"standalone": true`.
- Restart or reload the target service following the environment's maintenance protocol and confirm `/login` (HTTP 200) and version status.
- Remove the local temporary `pi-web-plus-${VERSION}.tgz` artifact from the working tree so `git status` remains clean.


## 2026-10-14 主动质量门禁

当前可执行质量闭环见 [quality.md](quality.md)。打包 prepack 强制执行同源码/已安装依赖指纹的分片 release gate；失败、缺文件、运行中漂移不能打包。原生完整包、只读运行入口及空闲受控发布仍各自验收。历史版本说明保留作为历史，不作为当前 SDK/目标基线。
