#!/usr/bin/env python3
"""
同步与清理 Agent Web Plus 的 Release 说明文档。
规则：
1. 统一收纳：所有 Release 说明统一存放于 docs/releases/ 目录，根目录不再存放 RELEASE_NOTES_*.md。
2. 生命周期对齐：以 GitHub 线上真实存在的 Releases 为权威基准。
   - 线上有的版本，本地保留对应说明文件；
   - 线上已被删除或不存在的版本，本地对应说明同步删除；
   - 线上有但本地缺失的版本，自动从 GitHub Release API 拉取正文补齐。
3. 索引导航：自动在 docs/releases/README.md 生成清晰的版本目录表。
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = 'koxircom/agent-web-plus'


def run_gh_api(endpoint):
    res = subprocess.run(
        ['gh', 'api', '--hostname', 'github.com', endpoint],
        capture_output=True,
        text=True,
        env={**os.environ, 'GH_HOST': 'github.com', 'GH_PROMPT_DISABLED': '1'},
        timeout=60
    )
    if res.returncode != 0:
        raise RuntimeError(f"GitHub API 请求失败: {res.stderr.strip()}")
    return json.loads(res.stdout)


def fetch_online_releases():
    """获取 GitHub 线上所有非草稿 Release"""
    releases = run_gh_api(f'repos/{REPO}/releases?per_page=100')
    result = {}
    for r in releases:
        if r.get('draft'):
            continue
        tag = r['tag_name']
        version = tag.lstrip('v')
        result[version] = {
            'tag': tag,
            'name': r.get('name') or tag,
            'body': r.get('body') or '',
            'published_at': (r.get('published_at') or '')[:10],
            'html_url': r.get('html_url') or f"https://github.com/{REPO}/releases/tag/{tag}"
        }
    return result


def audit_repository(repo_root: Path, online_releases: dict):
    """审计当前仓库内的 Release 说明文件分布"""
    root_files = list(repo_root.glob('RELEASE_NOTES_*.md'))
    docs_releases_dir = repo_root / 'docs' / 'releases'
    docs_files = []
    if docs_releases_dir.exists():
        docs_files = [f for f in docs_releases_dir.glob('*.md') if f.name != 'README.md']

    root_to_migrate = []
    root_to_delete = []
    for f in root_files:
        m = re.match(r'RELEASE_NOTES_(.+)\.md', f.name)
        if not m:
            continue
        v = m.group(1)
        if v in online_releases:
            root_to_migrate.append((f, v))
        else:
            root_to_delete.append((f, v))

    docs_to_keep = []
    docs_to_delete = []
    for f in docs_files:
        name = f.stem.lstrip('v')
        if name in online_releases:
            docs_to_keep.append((f, name))
        else:
            docs_to_delete.append((f, name))

    existing_versions = {v for _, v in root_to_migrate} | {v for _, v in docs_to_keep}
    missing_online = [v for v in online_releases if v not in existing_versions]

    return {
        'root_to_migrate': root_to_migrate,
        'root_to_delete': root_to_delete,
        'docs_to_keep': docs_to_keep,
        'docs_to_delete': docs_to_delete,
        'missing_online': missing_online
    }


def sync_releases(repo_root: Path, online_releases: dict, apply: bool = False):
    report = audit_repository(repo_root, online_releases)
    docs_releases_dir = repo_root / 'docs' / 'releases'

    print("=" * 60)
    print(f"Agent Web Plus Release 说明同步与清理审计")
    print(f"仓库路径: {repo_root}")
    print(f"GitHub 线上有效 Release 总数: {len(online_releases)}")
    print("=" * 60)

    print(f"\n1. 根目录下待清理的僵尸文件 (线上无对应 Release，共 {len(report['root_to_delete'])} 个):")
    for f, v in sorted(report['root_to_delete'], key=lambda x: x[1]):
        print(f"   [-] {f.name} (版本 {v} 在线上不存在或已下线)")

    print(f"\n2. 根目录下待迁移至 docs/releases/ 的文件 (共 {len(report['root_to_migrate'])} 个):")
    for f, v in sorted(report['root_to_migrate'], key=lambda x: x[1]):
        print(f"   [→] {f.name} -> docs/releases/v{v}.md")

    print(f"\n3. docs/releases/ 下待清理的历史未发布/已淘汰文件 (共 {len(report['docs_to_delete'])} 个):")
    for f, v in sorted(report['docs_to_delete'], key=lambda x: x[1]):
        print(f"   [-] docs/releases/{f.name} (版本 {v} 在线上无对应 Release)")

    print(f"\n4. 线上存在但本地缺失、待拉取补齐的版本 (共 {len(report['missing_online'])} 个):")
    for v in sorted(report['missing_online']):
        print(f"   [+] 从 GitHub Release API 同步 -> docs/releases/v{v}.md")

    if not apply:
        print("\n[INFO] 当前为预览审计模式 (Dry Run)。添加 --apply 参数以执行真正迁移与清理。")
        return

    # 执行迁移与清理
    docs_releases_dir.mkdir(parents=True, exist_ok=True)

    # 1. 清理根目录僵尸文件
    for f, _ in report['root_to_delete']:
        f.unlink()
        print(f"已删除: {f.name}")

    # 2. 迁移根目录有效文件到 docs/releases/v{v}.md
    for f, v in report['root_to_migrate']:
        target = docs_releases_dir / f"v{v}.md"
        content = f.read_text(encoding='utf-8')
        target.write_text(content, encoding='utf-8')
        f.unlink()
        print(f"已迁移并清理根文件: {f.name} -> docs/releases/{target.name}")

    # 3. 清理 docs/releases/ 下无 Release 的文件
    for f, _ in report['docs_to_delete']:
        f.unlink()
        print(f"已删除无 Release 说明: docs/releases/{f.name}")

    # 4. 补齐线上有但本地缺失的文件
    for v in report['missing_online']:
        info = online_releases[v]
        target = docs_releases_dir / f"v{v}.md"
        body = info['body'].strip()
        if not body:
            body = f"# Agent Web Plus {v}\n\n详见 [{info['name']}]({info['html_url']})\n"
        elif not body.startswith('#'):
            body = f"# Agent Web Plus {v}\n\n" + body
        target.write_text(body + '\n', encoding='utf-8')
        print(f"已从 GitHub 补齐: docs/releases/{target.name}")

    # 5. 生成/更新 docs/releases/README.md 索引导航
    readme_lines = [
        "# Agent Web Plus 发行说明索引 (Release Notes)",
        "",
        "本目录集中管理 Agent Web Plus 所有线上正式版本的发布说明。",
        "所有说明与 [GitHub Releases](https://github.com/koxircom/agent-web-plus/releases) 保持严格 1:1 生命周期对齐。",
        "",
        "| 版本 (Tag) | 发行名称 | 发布日期 | 详细说明 | 线上 Release 页面 |",
        "| :--- | :--- | :--- | :--- | :--- |"
    ]

    def parse_ver(v):
        parts = [int(p) if p.isdigit() else 0 for p in re.findall(r'\d+', v)]
        return parts

    sorted_versions = sorted(online_releases.keys(), key=parse_ver, reverse=True)
    for v in sorted_versions:
        info = online_releases[v]
        tag = info['tag']
        name = info['name'].replace('|', '-')
        date = info['published_at'] or '-'
        doc_link = f"[{tag}说明](v{v}.md)"
        gh_link = f"[GitHub Release]({info['html_url']})"
        readme_lines.append(f"| `{tag}` | {name} | {date} | {doc_link} | {gh_link} |")

    readme_lines.append("")
    readme_path = docs_releases_dir / 'README.md'
    readme_path.write_text('\n'.join(readme_lines) + '\n', encoding='utf-8')
    print(f"\n已生成统一版本索引导航: docs/releases/README.md")
    print("Release 说明清理与归纳全部完成！根目录已彻底清空所有 RELEASE_NOTES_*.md。")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1], help='Git 仓库根目录')
    parser.add_argument('--apply', action='store_true', help='执行真正迁移与清理')
    args = parser.parse_args()

    repo_root = args.root.resolve()
    online_releases = fetch_online_releases()
    sync_releases(repo_root, online_releases, apply=args.apply)


if __name__ == '__main__':
    main()
