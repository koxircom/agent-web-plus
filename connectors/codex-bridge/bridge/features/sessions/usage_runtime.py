"""Serve immutable usage bytes while a separate process owns the large index."""
import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

from bridge.features.sessions.usage import CodexUsageCollector, MAX_CACHE_BYTES, REFRESH_TTL, USAGE_ERROR, _iso_now

LOG = logging.getLogger(__name__)
WIRE_NAME = 'codex-usage-response-v1.wire'
WORKER_TIMEOUT = 15 * 60


def publish_snapshot(directory, scope, snapshot):
    value = dict(snapshot)
    error = value.pop('error', None)
    value.pop('loading', None)
    body = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
    if len(body) > MAX_CACHE_BYTES:
        raise ValueError('Usage response exceeds its size limit')
    header = json.dumps({'version': 1, 'scopeFingerprint': scope, 'bytes': len(body),
                         'sha256': hashlib.sha256(body).hexdigest(), 'error': error},
                        ensure_ascii=False, separators=(',', ':')).encode()
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix='.codex-usage-response-', dir=directory)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(header + b'\n' + body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / WIRE_NAME)
    finally:
        Path(temporary).unlink(missing_ok=True)


class UsageSnapshotRuntime:
    def __init__(self, bridge):
        self.scope_reader = CodexUsageCollector(bridge)  # Paths only; never _load here.
        self.path = self.scope_reader.data_dir / WIRE_NAME
        self.lock = threading.RLock()
        self.scope = None
        self.stamp = None
        self.body = None
        self.snapshot_error = None
        self.error = None
        self.refreshing = False
        self.last_refresh = 0.0
        self.worker = None
        self.thread = None
        self.closed = False
        self.payload_cache = None

    def _read_wire(self, scope):
        try:
            stat = self.path.stat()
            stamp = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
            if self.path.is_symlink() or stat.st_size > MAX_CACHE_BYTES + 8192:
                raise ValueError('Invalid usage response file')
            if stamp == self.stamp:
                return
            with self.path.open('rb') as stream:
                header = stream.readline(8193)
                if len(header) > 8192 or not header.endswith(b'\n'):
                    raise ValueError('Invalid usage response header')
                meta = json.loads(header)
                if meta.get('version') != 1 or meta.get('scopeFingerprint') != scope:
                    return
                body = stream.read(MAX_CACHE_BYTES + 1)
            if (len(body) > MAX_CACHE_BYTES or len(body) != meta.get('bytes')
                    or not body.startswith(b'{') or not body.endswith(b'}')
                    or hashlib.sha256(body).hexdigest() != meta.get('sha256')):
                raise ValueError('Incomplete usage response')
            self.body, self.stamp = body, stamp
            self.snapshot_error = meta.get('error') if isinstance(meta.get('error'), str) else None
            self.payload_cache = None
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError):
            self.error = USAGE_ERROR

    def response(self, force=False):
        try:
            scope = self.scope_reader._scope_fingerprint()
        except Exception:
            scope = None
        with self.lock:
            if scope != self.scope:
                self.scope, self.body, self.stamp = scope, None, None
                self.snapshot_error = self.error = None
                self.payload_cache = None
                self.last_refresh = 0.0
            if scope is None:
                self.error = USAGE_ERROR
            else:
                self._read_wire(scope)
                if not self.closed and not self.refreshing and (force or time.monotonic() - self.last_refresh >= REFRESH_TTL):
                    self.refreshing = True
                    self.error = None
                    self.thread = threading.Thread(target=self._refresh, args=(scope,),
                                                   name='codex-usage-worker-monitor', daemon=True)
                    try:
                        self.thread.start()
                    except RuntimeError:
                        self.refreshing = False
                        self.error = USAGE_ERROR
                        self.last_refresh = time.monotonic()
            error = self.error or self.snapshot_error
            if self.body is None:
                return json.dumps({'version': 2, 'generatedAt': _iso_now(), 'snapshotId': 'codex-loading',
                                   'engine': 'codex', 'buckets': [], 'sessions': {},
                                   'sources': {'codex': {'fileCount': 0, 'scannedAt': None}},
                                   'loading': self.refreshing, **({'error': error or USAGE_ERROR} if not self.refreshing else {})},
                                  ensure_ascii=False).encode()
            key = (id(self.body), self.refreshing, error)
            if self.payload_cache is None or self.payload_cache[0] != key:
                suffix = b',"loading":' + (b'true' if self.refreshing else b'false')
                if error:
                    suffix += b',"error":' + json.dumps(error, ensure_ascii=False).encode()
                self.payload_cache = (key, self.body[:-1] + suffix + b'}')
            return self.payload_cache[1]

    def _refresh(self, scope):
        process = None
        try:
            request = {'dataDirectory': str(self.scope_reader.data_dir), 'scopeFingerprint': scope,
                       'homes': [str(p) for p in self.scope_reader._homes()],
                       'workspaces': [{'path': str(p)} for p in self.scope_reader._workspace_roots()]}
            with self.lock:
                if self.closed:
                    return
                process = self.worker = subprocess.Popen(
                    [sys.executable, '-m', 'bridge.features.sessions.usage_worker'],
                    cwd=Path(__file__).resolve().parents[3], stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            LOG.info('Codex usage worker started pid=%s', process.pid)
            try:
                _, _ = process.communicate(json.dumps(request).encode(), timeout=WORKER_TIMEOUT)
            except subprocess.TimeoutExpired:
                process.kill()
                process.communicate()
                raise RuntimeError('Usage worker deadline exceeded')
            if process.returncode != 0:
                raise RuntimeError('Usage worker failed')
            with self.lock:
                if not self.closed and scope == self.scope:
                    self._read_wire(scope)
                    self.error = None if self.body is not None else USAGE_ERROR
        except Exception as exc:
            LOG.warning('Codex usage worker did not publish a complete snapshot: %s', type(exc).__name__)
            with self.lock:
                if scope == self.scope:
                    self.error = USAGE_ERROR
        finally:
            with self.lock:
                self.refreshing = False
                self.last_refresh = time.monotonic() if scope == self.scope else 0.0
                if self.worker is process:
                    self.worker = None

    def close(self):
        with self.lock:
            self.closed = True
            process, thread = self.worker, self.thread
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(2)
        if thread is not None and thread is not threading.current_thread():
            thread.join(1)
