"""Incremental, read-only usage accounting for native Codex rollout files.

Only token_count and turn_context records are decoded. Other JSONL records can
contain large conversation or tool payloads, so they are streamed past without
being parsed or retained.
"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import uuid
from zoneinfo import ZoneInfo

from bridge.features.sessions.store import SessionStore, StoreUnavailable


LOG = logging.getLogger(__name__)
FIELDS = (
    'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
    'totalTokens', 'messageCount', 'calls', 'records', 'costNano',
    'unpricedTokens', 'missingUsage',
)
ZERO = {field: 0 for field in FIELDS}
TZ_BEIJING = ZoneInfo('Asia/Shanghai')
REFRESH_TTL = 30.0
CHUNK_SIZE = 64 * 1024
PREFIX_LIMIT = 8192
MAX_USAGE_LINE = 256 * 1024
MAX_FILES = 50000
MAX_CACHE_BYTES = 128 * 1024 * 1024
MAX_SAFE_INTEGER = 9_007_199_254_740_991
USAGE_ERROR = 'Codex 用量索引暂不可用，正在保留上次完整统计；请稍后重试。'


class UsageScanError(RuntimeError):
    """An incomplete scan must not be reported as a complete ledger."""


def _iso_now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _day(timestamp_ms):
    if timestamp_ms is None:
        return 'unknown'
    try:
        return datetime.fromtimestamp(timestamp_ms / 1000, TZ_BEIJING).date().isoformat()
    except (OverflowError, OSError, ValueError):
        return 'unknown'


def _timestamp_ms(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        value = int(value)
        return value if abs(value) >= 100_000_000_000 else value * 1000
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return int(parsed.timestamp() * 1000)
    except (ValueError, OverflowError, OSError):
        return None


def _native_count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= MAX_SAFE_INTEGER else None


def _native_usage(value):
    if not isinstance(value, dict):
        return None
    input_tokens = _native_count(value.get('input_tokens'))
    output_tokens = _native_count(value.get('output_tokens'))
    cached_tokens = value.get('cached_input_tokens', 0)
    cached_tokens = _native_count(cached_tokens)
    if input_tokens is None or output_tokens is None or cached_tokens is None:
        return None
    if cached_tokens > input_tokens:
        return None
    return {'input': input_tokens, 'cached': cached_tokens, 'output': output_tokens}


def _counter_total(value):
    return value['input'] + value['output']


def _agent_spawn(meta):
    try:
        source = json.loads(meta.get('source') or '{}')
    except (TypeError, ValueError):
        return {}
    subagent = source.get('subagent') if isinstance(source, dict) else None
    spawn = subagent.get('thread_spawn') if isinstance(subagent, dict) else None
    return spawn if isinstance(spawn, dict) else {}


def _is_subagent(meta):
    return meta.get('thread_source') == 'subagent' or bool(_agent_spawn(meta).get('parent_thread_id'))


def _is_within(path, root):
    try:
        return path == root or path.is_relative_to(root)
    except (AttributeError, OSError, RuntimeError, ValueError):
        return False


def _interesting(prefix):
    """Cheap JSONL prefilter; native records put their top-level type first."""
    compact_context = b'"type":"turn_context"'
    spaced_context = b'"type": "turn_context"'
    if compact_context in prefix or spaced_context in prefix:
        return True
    event = b'"type":"event_msg"' in prefix or b'"type": "event_msg"' in prefix
    token = b'"type":"token_count"' in prefix or b'"type": "token_count"' in prefix
    return event and token


def _iter_usage_records(stream, start_offset):
    """Yield only complete, small usage/context records with their end offsets.

    Large irrelevant records are discarded in bounded chunks. An incomplete
    final line is deliberately left at the prior newline so the next refresh
    can finish it safely.
    """
    stream.seek(start_offset)
    chunk_start = start_offset
    prefix = bytearray()
    selected = None
    processed = start_offset

    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            break
        index = 0
        while index < len(chunk):
            newline = chunk.find(b'\n', index)
            end = len(chunk) if newline < 0 else newline
            piece = chunk[index:end]
            if selected is not None:
                if len(selected) + len(piece) > MAX_USAGE_LINE:
                    raise UsageScanError('Codex 用量记录超过安全解析上限。')
                selected.extend(piece)
            elif len(prefix) < PREFIX_LIMIT:
                remaining = PREFIX_LIMIT - len(prefix)
                prefix.extend(piece[:remaining])
                if _interesting(prefix):
                    selected = bytearray(prefix)
                    if len(piece) > remaining:
                        if len(selected) + len(piece) - remaining > MAX_USAGE_LINE:
                            raise UsageScanError('Codex 用量记录超过安全解析上限。')
                        selected.extend(piece[remaining:])

            if newline < 0:
                break
            line_end = chunk_start + newline + 1
            if selected is not None:
                yield bytes(selected), line_end
            processed = line_end
            prefix = bytearray()
            selected = None
            index = newline + 1

        chunk_start += len(chunk)

    yield None, processed


def _zero_file(session_id, model, provider, role):
    return {
        'sessionId': session_id,
        'model': model or 'unknown',
        'provider': provider or 'unknown',
        'role': role,
        'offset': 0,
        'size': 0,
        'mtimeNs': 0,
        'prefix': '',
        'boundary': '',
        'counters': None,
        'counterGapCount': 0,
        'subagentCounted': False,
        'buckets': {},
    }


def _counter_delta(state, info):
    cumulative = _native_usage(info.get('total_token_usage'))
    last = _native_usage(info.get('last_token_usage'))
    if cumulative is None:
        return None

    previous = state.get('counters')
    state['counters'] = cumulative
    if previous is None:
        # Some rollout files begin after inherited history. In that case the
        # cumulative total is a prefix; only the native last-call counters are
        # attributable to this file's first observed event.
        if last is not None and _counter_total(cumulative) > _counter_total(last):
            return last
        return cumulative

    reset = any(cumulative[key] < previous[key] for key in ('input', 'cached', 'output'))
    if reset:
        if last is not None:
            return last
        state['counterGapCount'] = state.get('counterGapCount', 0) + 1
        return {'input': 0, 'cached': 0, 'output': 0}
    return {key: cumulative[key] - previous[key] for key in ('input', 'cached', 'output')}


def _merge_usage(target, values):
    for field in FIELDS:
        target[field] += values.get(field, 0)


class CodexUsageCollector:
    """One bounded background indexer for a StandaloneBridge instance."""

    def __init__(self, bridge):
        self.bridge = bridge
        self.data_dir = Path(bridge.data_dir).resolve()
        self.cache_path = self.data_dir / 'codex-usage-ledger-v2.json'
        self.lock = threading.RLock()
        self.loaded = False
        self.files = {}
        self.snapshot = None
        self.scope_fingerprint = None
        self.error = None
        self.refreshing = False
        self.last_refresh = 0.0

    def _load(self):
        if self.loaded:
            return
        self.loaded = True
        try:
            expected_scope = self._scope_fingerprint()
        except UsageScanError:
            self.scope_fingerprint = None
            self.error = USAGE_ERROR
            self.last_refresh = time.monotonic()
            return
        self.scope_fingerprint = expected_scope
        try:
            if self.cache_path.is_symlink() or self.cache_path.stat().st_size > MAX_CACHE_BYTES:
                return
            cached = json.loads(self.cache_path.read_text(encoding='utf-8'))
            if (not isinstance(cached, dict) or cached.get('version') != 2
                    or not isinstance(cached.get('files'), dict)
                    or cached.get('scopeFingerprint') != expected_scope):
                return
            snapshot = cached.get('snapshot')
            if isinstance(snapshot, dict) and snapshot.get('version') == 2 and isinstance(snapshot.get('buckets'), list):
                self.snapshot = snapshot
            self.files = cached['files']
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError):
            LOG.warning('Codex usage cache could not be loaded; rebuilding aggregate cursors')

    def response(self, force=False):
        with self.lock:
            self._load()
            try:
                current_scope = self._scope_fingerprint()
            except UsageScanError:
                current_scope = None
            if current_scope != self.scope_fingerprint:
                # A workspace/home change invalidates both aggregate output and
                # cursors before any cached session metadata can be returned.
                self.files = {}
                self.snapshot = None
                self.scope_fingerprint = current_scope
                self.error = USAGE_ERROR if current_scope is None else None
                self.last_refresh = time.monotonic() if current_scope is None else 0.0
            now = time.monotonic()
            retry_due = now - self.last_refresh >= REFRESH_TTL
            failure_backoff = (self.error is not None and self.snapshot is None and not retry_due)
            if not self.refreshing and (force or (retry_due and not failure_backoff)):
                if current_scope is not None:
                    self._start_refresh_locked()
            if self.snapshot is None:
                result = {
                    'version': 2,
                    'generatedAt': _iso_now(),
                    'snapshotId': 'codex-loading',
                    'engine': 'codex',
                    'buckets': [],
                    'sessions': {},
                    'sources': {'codex': {'fileCount': 0, 'scannedAt': None}},
                    'loading': self.refreshing,
                }
            else:
                result = deepcopy(self.snapshot)
                result['loading'] = self.refreshing
                if self.refreshing and not self.error:
                    result.pop('error', None)
            if self.error:
                result['error'] = self.error
            return result

    def _start_refresh_locked(self):
        self.refreshing = True
        self.error = None
        worker = threading.Thread(target=self._refresh_worker, name='codex-usage-index', daemon=True)
        try:
            worker.start()
        except RuntimeError:
            self.refreshing = False
            self.error = USAGE_ERROR
            self.last_refresh = time.monotonic()

    def _refresh_worker(self):
        try:
            self.refresh_sync()
        except Exception as exc:  # keep last complete snapshot on every failure
            LOG.warning('Codex usage index refresh failed: %s', type(exc).__name__)
            with self.lock:
                self.error = USAGE_ERROR
                self.last_refresh = time.monotonic()
        finally:
            with self.lock:
                self.refreshing = False

    def refresh_sync(self):
        """Run one deterministic scan; exposed for narrow unit tests."""
        scope = self._scope_fingerprint()
        with self.lock:
            self._load()
            old_files = deepcopy(self.files) if self.scope_fingerprint == scope else {}
        files, snapshot = self._scan(old_files)
        if self._scope_fingerprint() != scope:
            raise UsageScanError('Codex 项目或历史目录在索引期间发生变化，未更新统计。')
        self._persist(files, snapshot, scope)
        with self.lock:
            self.files = files
            self.snapshot = snapshot
            self.scope_fingerprint = scope
            self.error = None
            self.last_refresh = time.monotonic()
        return deepcopy(snapshot)

    def _workspace_roots(self):
        roots = set()
        for item in getattr(self.bridge, 'workspaces', ()):
            raw = item.get('path') if isinstance(item, dict) else None
            if not raw:
                continue
            try:
                roots.add(Path(raw).resolve(strict=True))
            except (OSError, RuntimeError, ValueError) as exc:
                raise UsageScanError('Codex 项目范围暂不可用，无法完成用量索引。') from exc
        if not roots:
            raise UsageScanError('没有可用的 Codex 项目范围，无法完成用量索引。')
        return roots

    def _scope_fingerprint(self):
        roots = sorted(str(path) for path in self._workspace_roots())
        homes = sorted(str(path) for path in self._homes())
        value = json.dumps({'workspaces': roots, 'homes': homes},
                           sort_keys=True, separators=(',', ':')).encode('utf-8')
        return hashlib.sha256(value).hexdigest()

    def _homes(self):
        homes = []
        store_home = getattr(getattr(self.bridge, 'store', None), 'home', None)
        for value in (getattr(self.bridge, 'history_home', None), store_home):
            if value is None:
                continue
            try:
                home = Path(value).resolve(strict=True)
            except (OSError, RuntimeError, ValueError) as exc:
                raise UsageScanError('Codex 历史目录暂不可用，无法完成用量索引。') from exc
            if home not in homes:
                homes.append(home)
        if not homes:
            raise UsageScanError('没有可用的 Codex 历史目录，无法完成用量索引。')
        return homes

    def _candidates(self, roots):
        by_session = {}
        unavailable_sessions = set()
        homes = self._homes()
        for home in homes:
            store = SessionStore(home)
            try:
                with store._connect() as conn:
                    columns = {row[1] for row in conn.execute('PRAGMA table_info(threads)')}
                    required = {'id', 'cwd', 'rollout_path'}
                    if not required.issubset(columns):
                        raise UsageScanError('Codex 会话数据库缺少用量索引所需字段。')
                    optional = ('name', 'title', 'model_provider', 'model', 'source', 'thread_source')
                    fields = ['id', 'cwd', 'rollout_path'] + [name for name in optional if name in columns]
                    rows = conn.execute('SELECT ' + ','.join(fields) + ' FROM threads').fetchall()
            except (StoreUnavailable, sqlite3.Error, OSError) as exc:
                raise UsageScanError('读取 Codex 会话数据库失败，未更新统计。') from exc

            allowed_rollouts = []
            for name in ('sessions', 'archived_sessions'):
                try:
                    root = (home / name).resolve(strict=True)
                    if root.is_dir() and _is_within(root, home):
                        allowed_rollouts.append(root)
                except (OSError, RuntimeError, ValueError):
                    continue

            for row in rows:
                meta = dict(row)
                identifier = meta.get('id')
                raw_cwd, raw_path = meta.get('cwd'), meta.get('rollout_path')
                if not isinstance(identifier, str) or not identifier or not isinstance(raw_cwd, str) or not raw_cwd:
                    continue
                try:
                    identifier = str(uuid.UUID(identifier))
                except ValueError:
                    continue
                if not isinstance(raw_path, str) or not raw_path:
                    continue
                try:
                    # Historical working directories may have been removed;
                    # resolve existing symlink ancestors while retaining scope.
                    cwd = Path(raw_cwd).resolve()
                    if not any(_is_within(cwd, root) for root in roots):
                        continue
                    path = Path(raw_path).resolve()
                    if not any(_is_within(path, root) for root in allowed_rollouts):
                        continue
                    if not path.is_file():
                        unavailable_sessions.add('codex:' + identifier)
                        continue
                    stat = path.stat()
                except (OSError, RuntimeError, ValueError) as exc:
                    raise UsageScanError('读取 Codex rollout 文件失败，未更新统计。') from exc

                title = meta.get('name') or meta.get('title')
                if not isinstance(title, str) or not title:
                    spawn = _agent_spawn(meta)
                    agent_name = spawn.get('agent_nickname') or str(spawn.get('agent_path') or '').rsplit('/', 1)[-1]
                    title = ('子任务 · ' + str(agent_name)[:128]) if _is_subagent(meta) and agent_name else ('子任务' if _is_subagent(meta) else '未命名会话')
                meta.update(cwd=str(cwd), title=title,
                            path=str(path), stat=stat, home=str(home))
                previous = by_session.get(identifier)
                if previous is None or (stat.st_mtime_ns, str(path)) > (previous['stat'].st_mtime_ns, previous['path']):
                    by_session[identifier] = meta

        # Identical physical files can be referenced from two homes or rows.
        # Keep one deterministic owner to avoid counting the same rollout twice.
        candidates, seen = [], set()
        for identifier, meta in sorted(by_session.items(), key=lambda item: (-item[1]['stat'].st_mtime_ns, item[0])):
            stat = meta['stat']
            identity = f"{stat.st_dev}:{stat.st_ino}"
            if identity in seen:
                continue
            seen.add(identity)
            meta['identity'] = identity
            meta['sessionId'] = 'codex:' + identifier
            meta['model'] = meta.get('model') if isinstance(meta.get('model'), str) and meta.get('model') else 'unknown'
            meta['provider'] = meta.get('model_provider') if isinstance(meta.get('model_provider'), str) and meta.get('model_provider') else 'unknown'
            meta['role'] = 'subagent' if _is_subagent(meta) else 'main'
            candidates.append(meta)
        if len(candidates) > MAX_FILES:
            raise UsageScanError('Codex 历史文件数量超过安全索引上限。')
        in_scope = {meta['sessionId'] for meta in candidates}
        for meta in candidates:
            try:
                parent = 'codex:' + str(uuid.UUID(_agent_spawn(meta).get('parent_thread_id', '')))
            except (ValueError, TypeError, AttributeError):
                continue
            if parent in in_scope and parent != meta['sessionId']:
                meta['parentSessionId'] = parent
        unavailable_sessions.difference_update(meta['sessionId'] for meta in candidates)
        return candidates, len(homes), unavailable_sessions

    def _scan(self, old_files):
        roots = self._workspace_roots()
        candidates, home_count, unavailable_sessions = self._candidates(roots)
        files = {}
        sessions = {}
        partial_file_count = 0
        counter_gap_count = 0
        for meta in candidates:
            identity = meta['identity']
            old = old_files.get(identity)
            if (not isinstance(old, dict) or old.get('sessionId') != meta['sessionId']
                    or old.get('identity') != identity):
                old = _zero_file(meta['sessionId'], meta['model'], meta['provider'], meta['role'])
            state = self._scan_file(meta, deepcopy(old))
            state.update(identity=identity, sessionId=meta['sessionId'])
            files[identity] = state
            if state.get('partialTail'):
                partial_file_count += 1
            counter_gap_count += state.get('counterGapCount', 0)
            sessions[meta['sessionId']] = {
                'name': meta['title'], 'title': meta['title'], 'cwd': meta['cwd'],
                'executionEngine': 'codex', 'role': meta['role'],
                **({'parentSessionId': meta['parentSessionId']} if meta.get('parentSessionId') else {}),
            }

        # Preserve already observed accounting for deleted rollout files that
        # still have an in-scope native database row; never invent absent usage.
        for identity, state in old_files.items():
            if state.get('sessionId') in unavailable_sessions and identity not in files:
                files[identity] = state
                previous = (self.snapshot or {}).get('sessions', {}).get(state['sessionId'])
                if previous:
                    sessions[state['sessionId']] = previous

        buckets = self._buckets(files)
        scanned_at = _iso_now()
        sources = {'codex': {'fileCount': len(files), 'homeCount': home_count,
                             'partialFileCount': partial_file_count,
                             'counterGapCount': counter_gap_count,
                             'unavailableHistoryCount': len(unavailable_sessions),
                             'complete': partial_file_count == 0 and counter_gap_count == 0 and not unavailable_sessions,
                             'scannedAt': scanned_at}}
        canonical = json.dumps({'fileCount': len(files), 'sessions': sessions, 'buckets': buckets},
                               ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        snapshot = {
            'version': 2, 'generatedAt': scanned_at,
            'snapshotId': hashlib.sha256(canonical).hexdigest()[:20],
            'engine': 'codex', 'buckets': buckets, 'sessions': sessions,
            'sources': sources, 'loading': False,
        }
        if partial_file_count or counter_gap_count:
            reasons = []
            if partial_file_count:
                reasons.append('部分 Codex 日志末尾尚未写完，当前统计只含完整记录')
            if counter_gap_count:
                reasons.append('部分计数器重置缺少 last_token_usage，相关缺口未计入')
            snapshot['error'] = '；'.join(reasons) + '。'
        return files, snapshot

    def _scan_file(self, meta, state):
        path = Path(meta['path'])
        stat = meta['stat']
        current_prefix = ''
        current_boundary = ''
        try:
            with path.open('rb') as stream:
                opened_stat = os.fstat(stream.fileno())
                if (opened_stat.st_dev, opened_stat.st_ino) != (stat.st_dev, stat.st_ino):
                    raise UsageScanError('Codex rollout 文件在索引期间发生变化，未更新统计。')
                current_prefix = stream.read(256).hex()
                offset = state.get('offset', 0)
                if not isinstance(offset, int) or offset < 0:
                    offset = 0
                reset = (offset > stat.st_size
                         or state.get('prefix', current_prefix) != current_prefix
                         or state.get('size') == stat.st_size and state.get('mtimeNs') not in (None, stat.st_mtime_ns))
                if not reset and offset:
                    stream.seek(max(0, offset - 64))
                    current_boundary = stream.read(min(64, offset)).hex()
                    if state.get('boundary', current_boundary) != current_boundary:
                        reset = True
                if reset:
                    state = _zero_file(meta['sessionId'], meta['model'], meta['provider'], meta['role'])
                    offset = 0
                    current_boundary = ''
                state['identity'] = meta['identity']
                state['sessionId'] = meta['sessionId']
                state['model'] = state.get('model') or meta['model']
                state['provider'] = state.get('provider') or meta['provider']
                state['role'] = meta['role']
                start_offset = offset
                state['partialTail'] = False

                # The iterator decodes only filtered lines. Its return value is
                # the final complete-line cursor; partial bytes are rescanned.
                stream.seek(start_offset)
                processed = start_offset
                for raw, end_offset in _iter_usage_records(stream, start_offset):
                    processed = end_offset
                    if raw is None:
                        continue
                    try:
                        record = json.loads(raw)
                    except (ValueError, UnicodeDecodeError) as exc:
                        raise UsageScanError('Codex 用量记录格式无效，未更新统计。') from exc
                    payload = record.get('payload') if isinstance(record, dict) else None
                    if not isinstance(payload, dict):
                        continue
                    if record.get('type') == 'turn_context':
                        settings = (payload.get('collaboration_mode') or {}).get('settings') or {}
                        model = payload.get('model') or settings.get('model')
                        if isinstance(model, str) and model:
                            state['model'] = model
                        provider = payload.get('model_provider')
                        if isinstance(provider, str) and provider:
                            state['provider'] = provider
                    elif record.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                        info = payload.get('info')
                        if not isinstance(info, dict):
                            continue
                        delta = _counter_delta(state, info)
                        if delta is None:
                            continue
                        cache_read = min(delta['cached'], delta['input'])
                        noncache_input = max(0, delta['input'] - cache_read)
                        output = delta['output']
                        total = noncache_input + cache_read + output
                        if total <= 0:
                            continue
                        timestamp_ms = _timestamp_ms(record.get('timestamp') or payload.get('timestamp'))
                        self._add_event(state, _day(timestamp_ms), timestamp_ms,
                                        noncache_input, output, cache_read, total)
                state['offset'] = processed
                read_end = stream.tell()
                final_stat = path.stat()
                if (final_stat.st_dev, final_stat.st_ino) != (opened_stat.st_dev, opened_stat.st_ino):
                    raise UsageScanError('Codex rollout 文件在索引期间发生变化，未更新统计。')
                if final_stat.st_size != read_end:
                    raise UsageScanError('Codex rollout 文件在索引期间继续更新，未更新统计。')
                state['partialTail'] = processed < read_end
                state['size'] = final_stat.st_size
                state['mtimeNs'] = final_stat.st_mtime_ns
                with path.open('rb') as stream:
                    state['prefix'] = stream.read(256).hex()
                    if processed:
                        stream.seek(max(0, processed - 64))
                        state['boundary'] = stream.read(min(64, processed)).hex()
                    else:
                        state['boundary'] = ''
        except UsageScanError:
            raise
        except (OSError, RuntimeError, ValueError) as exc:
            raise UsageScanError('读取 Codex rollout 文件失败，未更新统计。') from exc
        return state

    @staticmethod
    def _add_event(state, day, timestamp_ms, input_tokens, output_tokens, cache_read, total):
        key = json.dumps([state['sessionId'], day, state.get('role', 'main'),
                          state.get('provider', 'unknown'), state.get('model') or 'unknown'],
                         ensure_ascii=False, separators=(',', ':'))
        bucket = state['buckets'].setdefault(key, deepcopy(ZERO))
        values = deepcopy(ZERO)
        calls = int(state.get('role') == 'subagent' and not state.get('subagentCounted'))
        if calls:
            state['subagentCounted'] = True
        values.update(inputTokens=input_tokens, outputTokens=output_tokens,
                      cacheReadTokens=cache_read, totalTokens=total,
                      messageCount=1, calls=calls, records=1,
                      unpricedTokens=total)
        _merge_usage(bucket, values)
        timeline_key = '' if timestamp_ms is None else str(timestamp_ms)
        timeline = bucket.setdefault('_timeline', {})
        point = timeline.setdefault(timeline_key, deepcopy(ZERO))
        _merge_usage(point, values)

    @staticmethod
    def _buckets(files):
        merged = {}
        for state in files.values():
            for raw_key, source in state.get('buckets', {}).items():
                try:
                    session_id, day, role, provider, model = json.loads(raw_key)
                except (ValueError, TypeError):
                    continue
                key = (session_id, day, role, provider, model)
                bucket = merged.get(key)
                if bucket is None:
                    bucket = deepcopy(ZERO)
                    bucket.update(sessionId=session_id, day=day, role=role,
                                  provider=provider, model=model,
                                  engine='codex', source='codex', _timeline={})
                    merged[key] = bucket
                _merge_usage(bucket, source)
                for timestamp, values in source.get('_timeline', {}).items():
                    point = bucket['_timeline'].setdefault(timestamp, deepcopy(ZERO))
                    _merge_usage(point, values)

        output = []
        for bucket in merged.values():
            timeline = bucket.pop('_timeline')
            timeline_rows = []
            for timestamp, values in timeline.items():
                ts = None if timestamp == '' else int(timestamp)
                timeline_rows.append((ts, [values[field] for field in FIELDS]))
            timeline_rows.sort(key=lambda row: (-1 if row[0] is None else row[0]))
            bucket['timeline'] = [[timestamp, *values] for timestamp, values in timeline_rows]
            output.append(bucket)
        output.sort(key=lambda item: (item['day'], item['sessionId'], item['model'], item['role']))
        return output

    def _persist(self, files, snapshot, scope_fingerprint):
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            payload = json.dumps({'version': 2, 'scopeFingerprint': scope_fingerprint,
                                  'files': files, 'snapshot': snapshot},
                                 ensure_ascii=False, separators=(',', ':')).encode('utf-8')
            if len(payload) > MAX_CACHE_BYTES:
                raise UsageScanError('Codex 用量缓存超过安全保存上限。')
            fd, temporary = tempfile.mkstemp(prefix='.codex-usage-', suffix='.tmp', dir=self.data_dir)
            try:
                os.fchmod(fd, 0o600)
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(payload)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.cache_path)
                os.chmod(self.cache_path, 0o600)
            finally:
                try:
                    os.unlink(temporary)
                except FileNotFoundError:
                    pass
        except UsageScanError:
            raise
        except OSError as exc:
            raise UsageScanError('保存 Codex 用量索引失败，未更新统计。') from exc


_COLLECTOR_GUARD = threading.Lock()
_COLLECTOR_ATTR = '_codex_usage_ledger_collector_v2'


def usage_snapshot(bridge, force=False):
    """Return a cached snapshot immediately and schedule one bounded refresh."""
    with _COLLECTOR_GUARD:
        collector = getattr(bridge, _COLLECTOR_ATTR, None)
        if collector is None:
            collector = CodexUsageCollector(bridge)
            setattr(bridge, _COLLECTOR_ATTR, collector)
    return collector.response(force=force)

