#!/usr/bin/env python3
"""在已有 GitHub 登录的容器中扫描并发布；默认仅预检，不上传。"""
import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('publication', Path(__file__).with_name('check-publication.py'))
SCANNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SCANNER)
REPO = 'koxircom/pi-web-plus'


def gh(*args, allow_missing=False):
    result = subprocess.run(['gh', *args], capture_output=True, text=True,
                            env={**os.environ, 'GH_HOST': 'github.com', 'GH_PROMPT_DISABLED': '1'}, timeout=180)
    if result.returncode:
        if allow_missing and '(HTTP 404)' in result.stderr:
            return None
        # Never echo CLI diagnostics: they may contain credential or local path data.
        raise ValueError('GitHub 操作失败，已停止；请在发布容器内核查认证、网络或权限')
    return result.stdout


def api(endpoint, **kwargs):
    result = gh('api', '--hostname', 'github.com', endpoint, **kwargs)
    return json.loads(result) if result is not None else None


def authentication():
    if not Path('/.dockerenv').exists():
        raise ValueError('发布只能在指定容器中执行，不能回退到本机认证')
    if any(os.environ.get(name) for name in ('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN')):
        raise ValueError('发布入口只使用容器已保存的认证，不接受环境变量令牌覆盖')
    gh('auth', 'status', '--hostname', 'github.com')
    login = api('user')['login']
    if login != REPO.split('/')[0]:
        raise ValueError('容器登录账号与指定仓库所有者不一致')
    permissions = api('repos/' + REPO).get('permissions', {})
    if not (permissions.get('push') or permissions.get('admin')):
        raise ValueError('容器现有认证没有仓库发布权限')
    return {'account': login, 'repository': REPO, 'authentication': 'container-saved-gh'}


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def tag_commit(tag):
    obj = api(f'repos/{REPO}/git/ref/tags/{tag}')['object']
    for _ in range(5):
        if obj['type'] == 'commit':
            return obj['sha']
        if obj['type'] != 'tag':
            break
        obj = api(f'repos/{REPO}/git/tags/{obj["sha"]}')['object']
    raise ValueError('远程标签未指向有效提交')


def publish(args, receipt):
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', args.tag or ''):
        raise ValueError('必须指定合法版本标签')
    if not re.fullmatch(r'[0-9a-f]{40}', args.target or ''):
        raise ValueError('必须指定已经推送的完整提交 SHA')
    root = args.root.resolve()
    if json.loads((root / 'package.json').read_text())['version'] != args.tag[1:]:
        raise ValueError('源码版本与发布标签不一致')
    if not args.asset or not args.notes_file:
        raise ValueError('必须指定附件和发布说明')
    inputs = [*args.asset, args.notes_file]
    if len({p.name for p in inputs}) != len(inputs):
        raise ValueError('附件与发布说明不能重名')
    if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', p.name) for p in inputs):
        raise ValueError('附件文件名只能包含字母、数字、点、横线与下划线')
    for path in inputs:
        if path.is_symlink() or not path.is_file():
            raise ValueError('附件与发布说明必须是普通文件')
        if path.stat().st_size > SCANNER.MAX_TOTAL:
            raise ValueError('附件超过扫描大小限制')
    # The same immutable staging copies are scanned, uploaded and hashed.
    with tempfile.TemporaryDirectory(prefix='agent-web-release-') as temporary:
        stage = Path(temporary)
        for path in inputs:
            shutil.copyfile(path, stage / path.name)
        scans = [{'kind': 'source', **SCANNER.inspect(root)}]
        scans += [{'kind': 'attachment', 'name': p.name, **SCANNER.inspect_artifact(stage / p.name)} for p in inputs]
        receipt['scans'] = scans
        if any(scan['status'] != 'passed' for scan in scans):
            raise ValueError('脱敏扫描未通过，禁止创建 Release 或上传任何附件')
        receipt.update(authentication())
        if tag_commit(args.tag) != args.target:
            raise ValueError('远程标签与指定提交不一致')
        if api(f'repos/{REPO}/releases/tags/{args.tag}', allow_missing=True) is not None:
            raise ValueError('该版本 Release 已存在；禁止覆盖或追加未审核附件')
        assets = [stage / p.name for p in args.asset]
        receipt['assets'] = [{'name': p.name, 'size': p.stat().st_size, 'sha256': digest(p)} for p in assets]
        if not args.apply:
            receipt['status'] = 'preflight-passed'
            return
        repository = 'https://github.com/' + REPO
        gh('release', 'create', args.tag, '--repo', repository, '--verify-tag', '--draft',
           '--title', args.tag, '--notes-file', str(stage / args.notes_file.name))
        receipt['draftCreated'] = True
        gh('release', 'upload', args.tag, *map(str, assets), '--repo', repository)
        release = api(f'repos/{REPO}/releases/tags/{args.tag}')
        if not release['draft'] or {a['name'] for a in release['assets']} != {p.name for p in assets}:
            raise ValueError('草稿附件集合不一致，已停止公开发布')
        downloads = stage / 'downloaded'
        downloads.mkdir()
        for asset in receipt['assets']:
            gh('release', 'download', args.tag, '--repo', repository, '--pattern', asset['name'], '--dir', str(downloads))
            if digest(downloads / asset['name']) != asset['sha256']:
                raise ValueError('上传附件下载回读指纹不一致，草稿未公开')
        prerelease = '-' in args.tag
        gh('release', 'edit', args.tag, '--repo', repository, '--draft=false',
           '--prerelease=' + str(prerelease).lower(), '--latest=' + str(not prerelease).lower())
        published = api(f'repos/{REPO}/releases/tags/{args.tag}')
        if published['draft'] or published['prerelease'] != prerelease:
            raise ValueError('发布状态回读不一致，需要人工核查')
        if not prerelease and api(f'repos/{REPO}/releases/latest')['tag_name'] != args.tag:
            raise ValueError('Latest 版本回读不一致，需要人工核查')
        receipt.update(status='published-and-verified', url=published['html_url'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--tag')
    parser.add_argument('--target')
    parser.add_argument('--asset', type=Path, action='append', default=[])
    parser.add_argument('--notes-file', type=Path)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--check-auth', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    receipt = {'repository': REPO, 'tag': args.tag, 'apply': args.apply, 'status': 'failed', 'draftCreated': False}
    try:
        if args.check_auth:
            if args.apply:
                raise ValueError('认证预检不能同时指定 --apply')
            receipt.update(authentication(), status='authentication-verified')
        else:
            publish(args, receipt)
    except json.JSONDecodeError:
        receipt['error'] = '发布元数据不是有效 JSON，已停止'
    except ValueError as error:
        receipt['error'] = str(error)
    except (OSError, KeyError, subprocess.SubprocessError):
        receipt['error'] = '发布未完成；请核查脱敏报告、容器认证及远程标签。已创建的草稿保留供核查，不自动重试上传。'
    if args.report:
        args.report.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(receipt, ensure_ascii=False, indent=2))
    return 1 if receipt['status'] == 'failed' else 0


if __name__ == '__main__':
    raise SystemExit(main())
