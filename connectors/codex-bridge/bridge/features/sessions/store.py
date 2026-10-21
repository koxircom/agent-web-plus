"""Read-only discovery and history for existing desktop chats."""
import copy
import json
import logging
import os
import shutil
import sqlite3
import tempfile
import threading
from collections import OrderedDict
from contextlib import ExitStack, closing, contextmanager
from pathlib import Path

from bridge.features.sessions.model import normalize_state, text_content


def runtime_context_input(payload):
    """Recognize a standalone runtime envelope, never user text similarity.

    A native UserMessage receipt can still prove that a user deliberately sent
    this literal envelope; readers retain that receipt as the authority.
    """
    content = payload.get('content', [])
    if (not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict)
            or content[0].get('type') != 'input_text'):
        return False
    text = text_content(content).strip()
    return (text.startswith('<environment_context>') and text.endswith('</environment_context>')
            and '<current_date>' in text and '<timezone>' in text and '<filesystem' in text)


class StoreUnavailable(RuntimeError):
    pass


class SessionStore:
    def __init__(self, codex_home):
        self.home = Path(codex_home).resolve()
        self.history_cache = OrderedDict()
        self.history_lock = threading.Lock()
        self.user_count_cache = OrderedDict()
        self.user_count_lock = threading.Lock()
        self.receipt_cache = OrderedDict()
        self.receipt_lock = threading.Lock()

    def _user_navigation(self, path):
        """Count persisted inputs without loading their bodies into chat history.

        Rollouts append. Cache a count, bounded input previews and file boundary, not transcripts;
        read the appended suffix and reset on truncation/replacement/rewrite.
        """
        with self.user_count_lock, path.open('rb') as stream:
            stat = os.fstat(stream.fileno())
            stamp = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
            key = str(path)
            cached = self.user_count_cache.get(key)
            if cached and cached['stamp'] == stamp:
                return cached
            count, offset, previews = 0, 0, []
            pending_context, turn_id = None, None
            if cached and cached['stamp'][0] == stat.st_ino and stat.st_size > cached['offset']:
                stream.seek(max(0, cached['offset'] - 64))
                if stream.read(min(64, cached['offset'])) == cached['boundary']:
                    count, offset = cached['count'], cached['offset']
                    previews = list(cached['previews'])
                    pending_context, turn_id = cached.get('pending_context'), cached.get('turn_id')
            stream.seek(offset)
            while True:
                line = stream.readline()
                if not line or not line.endswith(b'\n'):
                    break  # A concurrent writer's partial record is not committed.
                offset = stream.tell()
                if b'"response_item"' not in line[:200] and not (b'"event_msg"' in line[:200]
                        and any(tag in line[:512] for tag in (b'"task_started"', b'"UserMessage"', b'"userMessage"'))):
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                payload = record.get('payload') or {}
                if record.get('type') == 'event_msg':
                    if payload.get('type') == 'task_started':
                        turn_id, pending_context = payload.get('turn_id'), None
                    elif payload.get('type') == 'item_completed':
                        item = payload.get('item') or {}
                        if (pending_context and item.get('type') in ('UserMessage', 'userMessage')
                                and item.get('id') and payload.get('turn_id', turn_id) == pending_context['turnId']):
                            # A genuine user can send the literal runtime envelope.
                            count += 1
                            previews.append({'number': count, 'preview': pending_context['preview']})
                            previews = previews[-1000:]
                            pending_context = None
                    continue
                if payload.get('type') == 'message' and payload.get('role') == 'user':
                    text = text_content(payload.get('content', []))
                    if runtime_context_input(payload):
                        pending_context = {'turnId': turn_id, 'preview': text.strip()[:512] or '[图片]'}
                        continue
                    pending_context = None
                    count += 1
                    previews.append({'number': count, 'preview': text.strip()[:512] or '[图片]'})
                    previews = previews[-1000:]
            stream.seek(max(0, offset - 64))
            boundary = stream.read(min(64, offset))
            self.user_count_cache[key] = dict(stamp=stamp, count=count, offset=offset, boundary=boundary, previews=previews, pending_context=pending_context, turn_id=turn_id)
            self.user_count_cache.move_to_end(key)
            while len(self.user_count_cache) > 8:
                self.user_count_cache.popitem(last=False)
            return self.user_count_cache[key]

    def confirmed_user_receipt(self, thread_id, client_id):
        """Check the persisted native identity, independent of the visible tail.

        Never infer delivery from text, turn completion or an RPC admission.
        Stream only matching records; retain no prompt bodies. Negative results
        are cached only for the same file fingerprint, so late appends retry.
        """
        meta = self.get(thread_id)
        resolved = Path(meta['rollout_path']).resolve()
        if not any(root.resolve() in resolved.parents for root in (self.home / 'sessions', self.home / 'archived_sessions')):
            raise ValueError('会话记录路径不在 Codex 数据目录中')
        with self.receipt_lock, resolved.open('rb') as stream:
            stat = os.fstat(stream.fileno())
            key = (str(resolved), stat.st_ino, stat.st_size, stat.st_mtime_ns, client_id)
            if key in self.receipt_cache:
                self.receipt_cache.move_to_end(key)
                return self.receipt_cache[key]
            needle = client_id.encode('utf-8')
            confirmed = False
            for line in stream:
                if not line.endswith(b'\n') or needle not in line or b'"item_completed"' not in line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    continue
                payload = record.get('payload') or {}
                item = payload.get('item') or {}
                if (record.get('type') == 'event_msg' and payload.get('type') == 'item_completed'
                        and item.get('type') in ('UserMessage', 'userMessage') and item.get('id')
                        and (item.get('client_id') or item.get('clientId')) == client_id):
                    confirmed = True
                    break
            self.receipt_cache[key] = confirmed
            while len(self.receipt_cache) > 64:
                self.receipt_cache.popitem(last=False)
            return confirmed

    def _count_user_messages(self, path):
        return self._user_navigation(path)['count']

    @contextmanager
    def _connect(self):
        database = None
        try:
            databases = sorted(self.home.glob("state_*.sqlite"), key=lambda p: p.stat().st_mtime, reverse=True)
            if not databases:
                raise StoreUnavailable("暂时找不到 Codex 会话数据库，请打开电脑 Codex 后重试。")
            database = databases[0]
            with ExitStack() as stack:
                target = database
                wal = Path(str(database) + '-wal')
                with database.open('rb') as source:
                    wal_mode = source.read(20)[18:20] == b'\x02\x02'
                if wal_mode and not wal.exists():
                    # macOS SQLite can fail on a read-only WAL database with no
                    # sidecars. Read a stable, private copy; never initialize or
                    # mark the live database immutable, which would miss WAL data.
                    def fingerprint():
                        stat = database.stat()
                        return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns
                    before = fingerprint()
                    folder = stack.enter_context(tempfile.TemporaryDirectory(prefix='codex-mobile-history-'))
                    target = Path(folder) / 'history.sqlite'
                    if wal.exists():
                        raise StoreUnavailable("Codex 会话数据库正在更新，请稍后重试。")
                    shutil.copyfile(database, target)
                    if wal.exists() or fingerprint() != before:
                        raise StoreUnavailable("Codex 会话数据库正在更新，请稍后重试。")
                mode = 'ro' if target == database else 'rw'
                conn = stack.enter_context(closing(sqlite3.connect(target.as_uri() + '?mode=' + mode, uri=True, timeout=3)))
                conn.row_factory = sqlite3.Row
                yield conn
        except (OSError, sqlite3.Error) as exc:
            logging.getLogger(__name__).warning('Session database read failed: database=%s sqlite=%s wal=%s shm=%s error=%s',
                database, getattr(exc, 'sqlite_errorname', type(exc).__name__),
                bool(database and Path(str(database) + '-wal').exists()),
                bool(database and Path(str(database) + '-shm').exists()), exc)
            raise StoreUnavailable("暂时无法读取 Codex 会话数据库，请稍后重试或重新打开电脑 Codex。") from exc

    def list(self, query="", limit=100, offset=0, archived=False):
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute("PRAGMA table_info(threads)")}
            fields = [name for name in ("id", "name", "title", "cwd", "updated_at", "updated_at_ms", "recency_at", "recency_at_ms", "model_provider", "model", "originator", "source", "archived", "is_pinned") if name in columns]
            where = ["archived = ?"]
            params = [int(archived)]
            if "originator" in columns:
                # Older desktop imports have no originator but retain their app source.
                where.append("(originator IN ('Codex Desktop', 'codex_work_desktop', 'codex_mobile_bridge') OR (originator IS NULL AND source = 'vscode'))")
            if "thread_source" in columns:
                where.append("COALESCE(thread_source, '') != 'subagent'")
            if "source" in columns:
                where.append("COALESCE(source, '') NOT LIKE '%\"subagent\"%'")
            if query:
                search_fields = [name for name in ("name", "title", "cwd") if name in columns]
                where.append("(" + " OR ".join(name + " LIKE ?" for name in search_fields) + ")")
                params += ["%" + query + "%"] * len(search_fields)
            recency = "COALESCE(recency_at_ms, recency_at * 1000, updated_at * 1000)" if "recency_at_ms" in columns else "COALESCE(recency_at, updated_at)" if "recency_at" in columns else "updated_at"
            rows = conn.execute("SELECT " + ",".join(fields) + " FROM threads WHERE " + " AND ".join(where) + " ORDER BY " + recency + " DESC, id DESC LIMIT ? OFFSET ?", params + [limit, offset]).fetchall()
            return [dict(row) for row in rows]

    def notification_changes(self, since=0):
        """Only metadata changed since discovery; never read rollout history."""
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(threads)')}
            clocks = [name + ('' if name.endswith('_ms') else ' * 1000')
                      for name in ('updated_at', 'updated_at_ms', 'recency_at', 'recency_at_ms') if name in columns]
            clock = 'MAX(' + ','.join('COALESCE(' + c + ',0)' for c in clocks) + ',0)'
            owner = "(originator IN ('Codex Desktop', 'codex_work_desktop', 'codex_mobile_bridge') OR (originator IS NULL AND source = 'vscode'))" if 'originator' in columns else '1'
            filters = [owner, clock + ' >= ?']
            if 'thread_source' in columns:
                filters.append("COALESCE(thread_source, '') != 'subagent'")
            if 'source' in columns:
                filters.append("COALESCE(source, '') NOT LIKE '%\"subagent\"%'")
            return [dict(row) for row in conn.execute('SELECT id, ' + clock +
                    ' AS changed_at FROM threads WHERE ' + ' AND '.join(filters), (since,))]

    def lifecycle_threads(self):
        """Desktop roots and their complete agent subtree, using metadata only."""
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(threads)')}
            fields = [name for name in ('id', 'originator', 'source') if name in columns]
            rows = [dict(row) for row in conn.execute('SELECT ' + ','.join(fields) + ' FROM threads')]
        desktop = {row['id'] for row in rows if 'originator' not in columns
                   or row.get('originator') in ('Codex Desktop', 'codex_work_desktop', 'codex_mobile_bridge')
                   or (row.get('originator') is None and row.get('source') == 'vscode')}
        children = {}
        for row in rows:
            parent = self._agent_source(row).get('parent_thread_id')
            if isinstance(parent, str):
                children.setdefault(parent, []).append(row['id'])
        pending = list(desktop)
        while pending:
            for child in children.get(pending.pop(), []):
                if child not in desktop:
                    desktop.add(child)
                    pending.append(child)
        return [{'id': identifier} for identifier in sorted(desktop)]

    def recencies(self, identifiers):
        if not identifiers:
            return {}
        with self._connect() as conn:
            columns = {r[1] for r in conn.execute('PRAGMA table_info(threads)')}
            fields = [name for name in ('recency_at_ms', 'recency_at', 'updated_at_ms', 'updated_at') if name in columns]
            rows = conn.execute('SELECT id,' + ','.join(fields) + ' FROM threads WHERE id IN (' + ','.join('?' for _ in identifiers) + ')', identifiers)
            return {r['id']: next((r[k] * (1 if k.endswith('_ms') else 1000) for k in fields if r[k]), 0) for r in rows}

    def get(self, thread_id):
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)).fetchone()
            if not row:
                raise KeyError("找不到这个桌面会话")
            result = dict(row)
            desktop = result.get("originator") in ("Codex Desktop", "codex_work_desktop", "codex_mobile_bridge") or (result.get("originator") is None and result.get("source") == "vscode")
            if not desktop or result.get("thread_source") == "subagent" or '"subagent"' in (result.get("source") or ""):
                raise KeyError("不是桌面 App 会话")
            return result

    @staticmethod
    def _recent_lines(path, turn_limit):
        """Read complete turns backwards without parsing the older rollout prefix."""
        if turn_limit is None:
            return path.read_bytes(), True
        with path.open('rb') as stream:
            stream.seek(0, 2)
            position = stream.tell()
            parts, pending, starts = [], [], 0
            while position:
                size = min(position, 65536)
                position -= size
                stream.seek(position)
                chunk = stream.read(size)
                # JSONL records can contain megabytes of image/tool data. Keep
                # unfinished fragments without repeatedly copying/scanning the
                # growing line at every 64 KB boundary.
                fragments = chunk.split(b'\n')
                if len(fragments) == 1 and position:
                    pending.append(chunk)
                    continue
                tail = fragments.pop() + b''.join(reversed(pending))
                lines = [fragment + b'\n' for fragment in fragments]
                if tail:
                    lines.append(tail)
                pending = [lines.pop(0)] if position else []
                for line in reversed(lines):
                    parts.append(line)
                    if b'"task_started"' not in line:
                        continue
                    try:
                        record = json.loads(line)
                    except ValueError:
                        continue
                    if record.get('type') == 'event_msg' and record.get('payload', {}).get('type') == 'task_started':
                        starts += 1
                        if starts >= turn_limit:
                            return b''.join(reversed(parts)), position == 0 and len(parts) == len(lines)
            return b''.join(reversed(parts)), True

    def history(self, thread_id, turn_limit=None):
        return self._history(thread_id, self.get(thread_id), turn_limit)

    @staticmethod
    def _agent_source(meta):
        try:
            source = json.loads(meta.get('source') or '{}')
            spawn = source.get('subagent', {}).get('thread_spawn', {})
            return spawn if isinstance(spawn, dict) else {}
        except (ValueError, AttributeError):
            return {}

    @staticmethod
    def _is_uuid(val):
        if not isinstance(val, str):
            return False
        try:
            import uuid as _uuid
            _uuid.UUID(val.strip())
            return True
        except (ValueError, AttributeError):
            return False

    @classmethod
    def _resolve_subagent_title(cls, meta, spawn):
        nickname = meta.get("agent_nickname") or spawn.get("agent_nickname")
        role = meta.get("agent_role") or spawn.get("agent_role")
        if nickname and role:
            return f"{nickname} ({role})"
        if nickname:
            return nickname
        if role:
            return role
        for candidate in (meta.get("name"), meta.get("title")):
            if candidate and isinstance(candidate, str) and candidate.strip():
                trimmed = candidate.strip()
                if not cls._is_uuid(trimmed):
                    return trimmed if len(trimmed) <= 40 else trimmed[:40] + "..."
        return "子智能体"

    def _is_path_in_home(self, path_str):
        if not path_str or not isinstance(path_str, str):
            return False
        try:
            p = Path(path_str).resolve()
            home = self.home.resolve()
            for folder in ("sessions", "archived_sessions"):
                root = (home / folder).resolve()
                if p.is_relative_to(root):
                    return True
        except (OSError, ValueError):
            pass
        return False

    @staticmethod
    def _detect_subagent_status(path):
        """Detect turn/task status from rollout suffix without loading whole transcript."""
        try:
            resolved = Path(path).resolve()
            if not resolved.is_file():
                return "unknown"
            with resolved.open("rb") as f:
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 32768))
                tail = f.read()
            lines = tail.splitlines()
            for line in reversed(lines):
                try:
                    rec = json.loads(line)
                except (ValueError, TypeError, json.JSONDecodeError):
                    continue
                payload = rec.get("payload", {})
                p_type = payload.get("type")
                if p_type in ("task_complete", "task_completed"):
                    return "completed"
                if p_type == "task_failed" or payload.get("error"):
                    return "failed"
                if p_type == "task_started":
                    return "inProgress"
                if rec.get("type") == "turn_status":
                    s = rec.get("status")
                    if s:
                        return s
            return "unknown"
        except OSError:
            return "unknown"

    def subagents(self, thread_id, verified_parent=None):
        parent_meta = verified_parent if verified_parent is not None else self.get(thread_id)
        if parent_meta.get("thread_source") == "subagent" or '"subagent"' in (parent_meta.get("source") or ""):
            raise KeyError("不是主会话")
        parent_rollout = parent_meta.get("rollout_path")
        if parent_rollout and not self._is_path_in_home(parent_rollout):
            raise ValueError("会话记录路径不在 Codex 数据目录中")

        result, pending, seen = [], [thread_id], {thread_id}
        limited = False
        with self._connect() as conn:
            while pending and len(result) < 128:
                parent = pending.pop(0)
                rows = conn.execute(
                    "SELECT * FROM threads WHERE source LIKE ? ORDER BY updated_at DESC LIMIT 129",
                    ("%" + parent + "%",),
                ).fetchall()
                for row in rows:
                    meta = dict(row)
                    spawn = self._agent_source(meta)
                    if spawn.get("parent_thread_id") != parent or meta["id"] in seen:
                        continue
                    seen.add(meta["id"])
                    pending.append(meta["id"])

                    status = "unknown"
                    if meta.get("status") and meta["status"] != "unknown":
                        status = meta["status"]
                    elif self._is_path_in_home(meta.get("rollout_path")):
                        status = self._detect_subagent_status(meta["rollout_path"])

                    title = self._resolve_subagent_title(meta, spawn)
                    result.append({
                        "id": meta["id"],
                        "parentId": parent,
                        "title": title,
                        "nickname": meta.get("agent_nickname") or spawn.get("agent_nickname"),
                        "role": meta.get("agent_role") or spawn.get("agent_role"),
                        "path": meta.get("agent_path") or spawn.get("agent_path"),
                        "updated": meta.get("updated_at"),
                        "archived": bool(meta.get("archived")),
                        "status": status,
                    })
                    if len(result) >= 128:
                        limited = True
                        break
        return {"agents": result, "limited": limited}

    def subagent_history(self, thread_id, agent_id, verified_parent=None):
        parent_meta = verified_parent if verified_parent is not None else self.get(thread_id)
        if parent_meta.get("thread_source") == "subagent" or '"subagent"' in (parent_meta.get("source") or ""):
            raise KeyError("不是主会话")
        parent_rollout = parent_meta.get("rollout_path")
        if parent_rollout and not self._is_path_in_home(parent_rollout):
            raise ValueError("会话记录路径不在 Codex 数据目录中")

        with self._connect() as conn:
            current = agent_id
            seen = set()
            target = None
            ancestors = []
            while current != thread_id:
                if current in seen or len(seen) >= 32:
                    raise KeyError("子智能体不属于此聊天")
                seen.add(current)
                row = conn.execute("SELECT * FROM threads WHERE id = ?", (current,)).fetchone()
                if not row:
                    raise KeyError("子智能体不存在")
                meta = dict(row)
                ancestors.append(meta)
                if target is None:
                    target = meta
                current = self._agent_source(meta).get("parent_thread_id")
                if not current:
                    raise KeyError("子智能体不属于此聊天")

        if target is None:
            raise KeyError("请选择子智能体")

        for anc in ancestors:
            anc_path = anc.get("rollout_path")
            if not anc_path or not self._is_path_in_home(anc_path):
                raise ValueError("会话记录路径不在 Codex 数据目录中")

        target_path = Path(target["rollout_path"]).resolve()
        if not target_path.is_file():
            raise KeyError("子智能体会话记录文件不存在")

        state = self._history(agent_id, target, 20)
        view = normalize_state(state, False)
        spawn = self._agent_source(target)
        last_turn_status = view["turns"][-1].get("status") if view.get("turns") else None
        detected_status = self._detect_subagent_status(target_path)
        status = (
            last_turn_status
            if last_turn_status not in (None, "unknown")
            else detected_status
            if detected_status != "unknown"
            else (view.get("status") if view.get("status") not in (None, "idle", "unknown", "notLoaded") else "unknown")
        )

        return {
            "id": agent_id,
            "parentId": thread_id,
            "title": self._resolve_subagent_title(target, spawn),
            "nickname": target.get("agent_nickname") or spawn.get("agent_nickname"),
            "role": target.get("agent_role") or spawn.get("agent_role"),
            "status": status,
            "turns": view.get("turns", []),
            "historyComplete": view.get("historyComplete", True),
            "saved": True,
            "updated": target.get("updated_at"),
            "archived": bool(target.get("archived")),
        }

    def _history(self, thread_id, meta, turn_limit=None):
        path = Path(meta["rollout_path"])
        # The file path must be an actual rollout in this user's Codex home.
        resolved = path.resolve()
        if not any(root.resolve() in resolved.parents for root in (self.home / "sessions", self.home / "archived_sessions")):
            raise ValueError("会话记录路径不在 Codex 数据目录中")
        stat = resolved.stat()
        cache_key = (str(resolved), stat.st_ino, stat.st_size, stat.st_mtime_ns, turn_limit)
        with self.history_lock:
            cached = self.history_cache.get(cache_key)
            if cached is not None:
                self.history_cache.move_to_end(cache_key)
                result = copy.deepcopy(cached)
                result.update(title=meta.get('name') or meta.get('title'), cwd=meta['cwd'])
                result['modelProvider'] = meta.get('model_provider')
                if meta.get('model'):
                    result['latestModel'] = meta['model']
                return result
        raw, complete = self._recent_lines(resolved, turn_limit)
        items, turns, current = [], [], None
        pending_user = None
        user_receipts = set()
        token_usage = None
        for line in raw.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            payload = record.get("payload", {})
            if record.get("type") == "event_msg" and payload.get("type") == "task_started":
                current = {"turnId": payload.get("turn_id"), "status": "inProgress", "items": []}
                pending_user = None
                user_receipts = set()
                turns.append(current)
                items = current["items"]
            elif record.get("type") == "event_msg" and payload.get("type") == "token_count":
                info = payload.get('info')
                if isinstance(info, dict):
                    token_usage = {'modelContextWindow': info.get('model_context_window')}
                    last = info.get('last_token_usage')
                    if isinstance(last, dict):
                        token_usage['last'] = {'totalTokens': last.get('total_tokens')}
                    total = info.get('total_token_usage')
                    if isinstance(total, dict):
                        token_usage['total'] = {
                            camel: total[native]
                            for native, camel in (
                                ('input_tokens', 'inputTokens'),
                                ('cached_input_tokens', 'cachedInputTokens'),
                                ('output_tokens', 'outputTokens'),
                                ('reasoning_output_tokens', 'reasoningOutputTokens'),
                                ('total_tokens', 'totalTokens'))
                            if native in total}
            elif record.get("type") == "turn_context" and current is not None:
                settings = (payload.get('collaboration_mode') or {}).get('settings') or {}
                current['params'] = {'model':payload.get('model') or settings.get('model'),
                                     'effort':payload.get('effort') or settings.get('reasoning_effort')}
            elif record.get("type") == "event_msg" and payload.get("type") in ("task_complete", "task_completed", "turn_aborted"):
                if current:
                    current["status"] = "completed" if payload["type"] in ("task_complete", "task_completed") else "interrupted"
            elif record.get("type") == "event_msg" and payload.get("type") == "item_completed":
                item = payload.get("item", {})
                if (isinstance(item, dict) and item.get("type") in ("UserMessage", "userMessage")
                        and current is not None and pending_user is not None
                        and item.get("id") and item["id"] not in user_receipts
                        and payload.get("turn_id", current["turnId"]) == current["turnId"]):
                    # A rollout writes the model input and then its native user
                    # receipt. They are one input, with different record IDs.
                    # Keep the receipt's live identity/client ID through saved
                    # completion reads; never collapse messages by their text.
                    pending_user.pop("_runtimeContext", None)
                    pending_user["id"] = item["id"]
                    client_id = item.get("client_id") or item.get("clientId")
                    if client_id:
                        pending_user["clientId"] = str(client_id)
                    user_receipts.add(item["id"])
                    pending_user = None
                elif isinstance(item, dict) and item.get("type") in ("ImageView", "imageView"):
                    # ImageView evidence only exists in event records. Preserve it
                    # so saved history can still render the image after restart.
                    if current is None:
                        current = {"turnId": "history", "status": "completed", "items": []}
                        turns.append(current)
                        items = current["items"]
                    items.append({"id": item.get("id", str(len(items))), "type": "ImageView", "path": item.get("path", "")})
            elif record.get("type") == "response_item":
                if current is None:
                    current = {"turnId": "history", "status": "completed", "items": []}
                    turns.append(current)
                    items = current["items"]
                if payload.get("type") == "message" and payload.get("role") in ("user", "assistant"):
                    role = payload["role"]
                    if role == "user":
                        pending_user = {"id": payload.get("id") or str(len(items)), "type": "userMessage", "content": payload.get("content", [])}
                        if runtime_context_input(payload):
                            pending_user["_runtimeContext"] = True
                        items.append(pending_user)
                    else:
                        items.append({"id": str(len(items)), "type": "agentMessage", "text": "\n".join(x.get("text", "") for x in payload.get("content", []) if isinstance(x, dict)), "phase": payload.get("phase")})
                elif payload.get("type") in ("agent_message", "agentMessage"):
                    items.append({"id": payload.get("id", str(len(items))), "type": "agentMessage", "text": payload.get("text", "")})
                elif payload.get("type") in ("function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"):
                    items.append({"id": payload.get("call_id", str(len(items))), "type": "storedToolEvent", **payload})
        for turn in turns:
            turn["items"] = [item for item in turn["items"] if not item.pop("_runtimeContext", False)]
        result = {"id": thread_id, "title": meta.get("name") or meta.get("title"), "cwd": meta["cwd"],
                "latestModel": meta.get('model') or next((t['params']['model'] for t in reversed(turns) if (t.get('params') or {}).get('model')), None),
                "latestReasoningEffort": next((t['params']['effort'] for t in reversed(turns) if (t.get('params') or {}).get('effort')), None),
                "modelProvider": meta.get("model_provider"),
                "latestTokenUsageInfo": token_usage, "tokenUsageFromHistory": True,
                "turns": turns, "turnsPagination": {"hasLoadedOldest": complete}, "requests": [], "threadRuntimeStatus": {"type": "notLoaded"}}
        with self.history_lock:
            if len(raw) <= 4 * 1024 * 1024:
                self.history_cache[cache_key] = result
            while len(self.history_cache) > 8:
                self.history_cache.popitem(last=False)
        return copy.deepcopy(result)
