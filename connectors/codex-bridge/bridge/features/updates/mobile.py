"""Authenticated Android update assistance, restricted to this project's releases."""
from contextlib import contextmanager
import hashlib
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler, HTTPSHandler

from bridge.features.auth.tls import client_context
from bridge.features.workspace.workspace import download_range

REPO = 'https://github.com/try2love/codex-mobile-bridge'
API = 'https://api.github.com/repos/try2love/codex-mobile-bridge/releases?per_page=100'
MAX_SIZE = 512 * 1024 * 1024
MAX_METADATA = 4 * 1024 * 1024
CACHE_SECONDS = 24 * 60 * 60


def version_key(value):
    match = re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|preview|rc)\.(0|[1-9]\d*))?', value if isinstance(value, str) and len(value) <= 80 else '')
    if not match:
        raise ValueError('更新版本无效')
    return tuple(int(match[i]) for i in (1, 2, 3)) + (('alpha', 'beta', 'preview', 'rc').index(match[4]) if match[4] else 4, int(match[5] or 0))


def asset_name(version):
    version_key(version)
    return 'Codex-Mobile-Bridge-' + version + '-Android.apk'


def asset_url(version):
    return REPO + '/releases/download/v' + version + '/' + asset_name(version)


def redirect_allowed(url):
    try:
        value = urlsplit(url)
        return (value.scheme == 'https' and value.username is None and value.password is None
                and value.port in (None, 443) and value.hostname in (
                    'github.com', 'objects.githubusercontent.com',
                    'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'))
    except ValueError:
        return False


class ReleaseRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Metadata is never redirected; APK redirects never carry gateway credentials.
        if req.full_url == API or not redirect_allowed(newurl):
            raise ValueError('更新下载地址发生不允许的跳转')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class MobileUpdates:
    def __init__(self, directory):
        self.directory = Path(directory) / 'mobile-updates'
        self.lock = threading.RLock()
        self.catalog_lock = threading.Lock()
        self.catalog = None
        self.catalog_time = 0
        self.jobs = {}
        self.closed = threading.Event()

    def _open(self, url):
        opener = build_opener(ReleaseRedirect(), HTTPSHandler(context=client_context()))
        return opener.open(Request(url, headers={'User-Agent': 'Codex-Mobile-Bridge',
                                                'Accept': 'application/vnd.github+json' if url == API else 'application/octet-stream',
                                                'Accept-Encoding': 'identity'}), timeout=15)

    def releases(self):
        with self.catalog_lock:
            if self.catalog is not None and time.monotonic() - self.catalog_time < 300:
                return self.catalog
            try:
                with self._open(API) as response:
                    if response.status != 200:
                        raise ValueError('GitHub 版本信息不可用')
                    raw = response.read(MAX_METADATA + 1)
                if len(raw) > MAX_METADATA:
                    raise ValueError('GitHub 版本信息过大')
                rows = json.loads(raw)
                if not isinstance(rows, list):
                    raise ValueError('GitHub 版本信息无效')
                releases = []
                for row in rows:
                    if not isinstance(row, dict) or row.get('draft') is not False:
                        continue
                    tag = row.get('tag_name', '')
                    if not isinstance(tag, str) or not tag.startswith('v'):
                        continue
                    version = tag[1:]
                    try:
                        version_key(version)
                    except ValueError:
                        continue
                    assets = row.get('assets')
                    for asset in assets if isinstance(assets, list) else []:
                        if not isinstance(asset, dict) or asset.get('name') != asset_name(version) or asset.get('browser_download_url') != asset_url(version):
                            continue
                        size, digest = asset.get('size'), asset.get('digest', '')
                        valid_size = type(size) is int and 0 < size <= MAX_SIZE
                        valid_digest = isinstance(digest, str) and re.fullmatch(r'sha256:[a-fA-F0-9]{64}', digest)
                        notes = row.get('body') or ''
                        releases.append({'version': version, 'size': size if valid_size else -1, 'sha256': digest[7:].lower() if valid_digest else None,
                                         'notes': notes[:12000] if isinstance(notes, str) else '',
                                         'prerelease': row.get('prerelease') is not False or '-' in version})
                self.catalog, self.catalog_time = releases, time.monotonic()
                return releases
            except (OSError, ValueError, HTTPException) as exc:
                raise ValueError('电脑无法获取 GitHub 版本信息，请检查电脑网络后重试') from exc

    def check(self, current):
        key = version_key(current)
        candidates = [r for r in self.releases() if version_key(r['version']) > key
                      and ('-' in current or not r['prerelease'])]
        selected = max(candidates, key=lambda r: version_key(r['version'])) if candidates else None
        if selected and (selected['size'] <= 0 or selected['sha256'] is None):
            raise ValueError('发布信息已变化或缺少校验信息，请重新检查更新')
        return {'supported': True, 'release': selected}

    def _cleanup(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        now = time.time()
        for identifier, job in list(self.jobs.items()):
            if job['state'] != 'downloading' and not job['readers'] and now - job['used'] > CACHE_SECONDS:
                del self.jobs[identifier]
        retained = {key + suffix for key in self.jobs for suffix in ('.apk', '.part')}
        for file in self.directory.iterdir():
            if re.fullmatch(r'[a-f0-9]{64}\.(apk|part)', file.name) and file.name not in retained:
                file.unlink(missing_ok=True)

    @staticmethod
    def _status(job):
        return {key: job[key] for key in ('id', 'state', 'downloaded', 'size', 'error')}

    def prepare(self, value):
        if not isinstance(value, dict) or set(value) != {'version', 'size', 'sha256'}:
            raise ValueError('更新请求无效')
        version_key(value['version'])
        if type(value['size']) is not int or not isinstance(value['sha256'], str):
            raise ValueError('更新请求无效')
        release = next((r for r in self.releases() if r['size'] > 0 and r['sha256'] is not None and all(r[k] == value[k] for k in value)), None)
        if release is None:
            raise ValueError('发布信息已变化或缺少校验信息，请重新检查更新')
        identifier = hashlib.sha256((release['version'] + ':' + release['sha256']).encode()).hexdigest()
        with self.lock:
            if self.closed.is_set():
                raise ValueError('网关正在关闭')
            self._cleanup()
            old = self.jobs.get(identifier)
            if old and old['state'] != 'failed':
                old['used'] = time.time()
                return self._status(old)
            if any(j['state'] == 'downloading' for j in self.jobs.values()):
                raise ValueError('电脑正在下载其他更新，请稍后重试')
            if old:
                del self.jobs[identifier]
            while len(self.jobs) >= 2:
                idle = [j for j in self.jobs.values() if not j['readers']]
                if not idle:
                    raise ValueError('电脑正在传送更新，请稍后重试')
                oldest = min(idle, key=lambda j: j['used'])
                del self.jobs[oldest['id']]
            self._cleanup()
            job = {**release, 'id': identifier, 'state': 'downloading', 'downloaded': 0,
                   'error': '', 'used': time.time(), 'readers': 0}
            self.jobs[identifier] = job
            threading.Thread(target=self._download, args=(job,), daemon=True, name='mobile-update').start()
            return self._status(job)

    def _download(self, job):
        staging = self.directory / (job['id'] + '.part')
        target = self.directory / (job['id'] + '.apk')
        error = ''
        try:
            digest, count, deadline = hashlib.sha256(), 0, time.monotonic() + 600
            with self._open(asset_url(job['version'])) as response:
                if response.status != 200 or response.headers.get('Content-Encoding', 'identity') != 'identity':
                    raise ValueError('安装包下载响应无效')
                length = response.headers.get('Content-Length')
                if length is not None and int(length) != job['size']:
                    raise ValueError('安装包大小与发布信息不一致')
                with os.fdopen(os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as output:
                    while True:
                        if self.closed.is_set() or time.monotonic() > deadline:
                            raise ValueError('安装包下载超时或网关已关闭')
                        block = response.read(65536)
                        if not block:
                            break
                        count += len(block)
                        if count > job['size']:
                            raise ValueError('安装包大小与发布信息不一致')
                        output.write(block)
                        digest.update(block)
                        with self.lock:
                            job['downloaded'] = count
                    output.flush()
                    os.fsync(output.fileno())
            if count != job['size'] or digest.hexdigest() != job['sha256']:
                raise ValueError('安装包校验失败，请重新检查更新')
            staging.replace(target)
        except (OSError, ValueError, HTTPException) as exc:
            error = str(exc) if isinstance(exc, ValueError) else '电脑下载失败，请检查电脑网络和存储后重试'
        finally:
            # Keep the job non-retryable until its old staging file is gone.
            # Otherwise an old worker can unlink the replacement attempt's file.
            try:
                staging.unlink(missing_ok=True)
            except OSError:
                error = '电脑下载失败，请检查电脑网络和存储后重试'
            with self.lock:
                job['state'], job['error'], job['used'] = 'failed' if error else 'ready', error, time.time()

    def status(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            if job is None or time.time() - job['used'] > CACHE_SECONDS:
                raise ValueError('更新缓存已过期，请重新下载')
            job['used'] = time.time()
            return self._status(job)

    @contextmanager
    def download(self, identifier, range_header='', if_range=''):
        with self.lock:
            self.status(identifier)
            job = self.jobs[identifier]
            if job['state'] != 'ready':
                raise ValueError('电脑尚未完成更新下载')
            path = self.directory / (identifier + '.apk')
            if path.is_symlink():
                raise ValueError('更新缓存无效')
            stream = path.open('rb')
            if os.fstat(stream.fileno()).st_size != job['size']:
                stream.close()
                raise ValueError('更新缓存已变化，请重新下载')
            job['readers'] += 1
            selection = download_range(job['size'], '"sha256-' + job['sha256'] + '"', range_header, if_range)
        try:
            stream.seek(selection['offset'])
            yield {**selection, 'name': asset_name(job['version'])}, stream
        finally:
            stream.close()
            with self.lock:
                job['readers'] -= 1

    def close(self):
        self.closed.set()
