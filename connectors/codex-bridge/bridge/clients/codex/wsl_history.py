"""Read existing WSL histories without acquiring their execution ownership."""
import threading
import time
import uuid
from pathlib import Path

from bridge.features.sessions.model import normalize_state
from bridge.features.sessions.store import SessionStore
from bridge.features.sessions.timeline import Timeline


class WslHistory(SessionStore):
    def __init__(self, home, workspaces):
        super().__init__(home)
        self.workspaces = [{**item, 'path': Path(item['path']).resolve(strict=True)}
                           for item in workspaces]
        self.sessions = {}
        self.lock = threading.RLock()

    def user_message_count(self, identifier):
        path = self.rollout_path(self.get(identifier))
        if path is None:
            raise ValueError('会话记录不在 Codex 数据目录中')
        return self._count_user_messages(Path(path))

    def navigation_index(self, identifier):
        path = self.rollout_path(self.get(identifier))
        if path is None:
            raise ValueError('会话记录不在 Codex 数据目录中')
        snapshot = self._user_navigation(Path(path))
        return {'available': True, 'totalTurns': snapshot['count'],
                'turns': list(snapshot['previews'])}

    def workspace(self, cwd):
        path = Path(cwd).resolve()
        matches = [item for item in self.workspaces if path.is_relative_to(item['path'])]
        if not matches:
            return None
        return max(matches, key=lambda item: len(item['path'].parts))

    def rollout_path(self, meta):
        """Return a rollout path only when it resolves inside this Codex home."""
        value = meta.get('rollout_path') if isinstance(meta, dict) else None
        if not isinstance(value, str) or not value:
            return None
        try:
            path = Path(value).resolve(strict=True)
            if not path.is_file():
                return None
            for folder in ('sessions', 'archived_sessions'):
                try:
                    root = (self.home / folder).resolve(strict=True)
                except OSError:
                    continue
                if path.is_relative_to(root):
                    return str(path)
        except (OSError, RuntimeError, ValueError):
            pass
        return None

    def _rows(self, query='', limit=100, offset=0, archived=False, identifier=None, identifiers=None):
        scopes, params = [], []
        for item in self.workspaces:
            root, prefix = str(item['path']), str(item['path']) + '/'
            scopes.append('(cwd = ? OR substr(cwd, 1, ?) = ?)')
            params.extend([root, len(prefix), prefix])
        where = ['(' + ' OR '.join(scopes) + ')', 'archived = ?',
                 "COALESCE(source, '') NOT LIKE '%\"subagent\"%'",
                 "COALESCE(thread_source, '') != 'subagent'"]
        params.append(int(archived))
        if identifier is not None:
            uuid.UUID(identifier)
            # A deep link may refer to either an active or archived thread.
            where[1] = '1 = 1'
            params.pop()
            where.append('id = ?')
            params.append(identifier)
        if identifiers is not None:
            if not identifiers or len(identifiers) > 500:
                return []
            for value in identifiers:
                uuid.UUID(value)
            where[1] = '1 = 1'
            params.pop()
            where.append('id IN (' + ','.join('?' for _ in identifiers) + ')')
            params.extend(identifiers)
        if query:
            where.append('(name LIKE ? OR title LIKE ? OR cwd LIKE ?)')
            params.extend(['%' + query + '%'] * 3)
        with self._connect() as conn:
            rows = conn.execute('SELECT * FROM threads WHERE ' + ' AND '.join(where) +
                ' ORDER BY COALESCE(recency_at_ms, recency_at * 1000, updated_at * 1000) DESC, id DESC LIMIT ? OFFSET ?',
                params + [limit, offset]).fetchall()
        # Resolve each distinct cwd once per snapshot, retaining symlink checks.
        scopes_by_cwd = {}
        result = []
        for row in rows:
            cwd = row['cwd']
            if cwd not in scopes_by_cwd:
                scopes_by_cwd[cwd] = self.workspace(cwd)
            if scopes_by_cwd[cwd]:
                result.append(dict(row))
        return result

    def get_many(self, identifiers):
        return {row['id']: row for row in self._rows(identifiers=identifiers, limit=len(identifiers))}

    def get(self, identifier):
        rows = self._rows(identifier=identifier, limit=1)
        if not rows:
            raise KeyError('找不到指定 WSL 工作区内的会话')
        return rows[0]

    def list(self, query='', limit=100, offset=0, archived=False):
        result, projects = [], {}
        for r in self._rows(query, limit, offset, archived):
            if r['cwd'] not in projects:
                projects[r['cwd']] = self.workspace(r['cwd'])
            project = projects[r['cwd']]
            path = self.rollout_path(r)
            result.append({'id': r['id'], 'title': r.get('name') or r['title'] or '未命名聊天',
                 'cwd': r['cwd'], 'host': 'local', 'hostLabel': 'WSL Codex',
                 'projectName': project['name'], 'projectKey': project['key'],
                 'recency': r.get('recency_at_ms') or (r.get('recency_at') or r['updated_at']) * 1000,
                 'updatedAt': r['updated_at'], 'path': path, 'archived': bool(r['archived']),
                 'connected': False, 'historyOnly': False, 'resumableHistory': True})
        return result

    def session(self, identifier, full=False, turn_limit=None):
        meta = self.get(identifier)
        with self.lock:
            session = self.sessions.get(identifier)
            if session is None:
                if len(self.sessions) >= 32:
                    old = next((key for key, value in self.sessions.items() if not value.viewers), None)
                    if old:
                        del self.sessions[old]
                session = self.sessions[identifier] = HistorySession(self, identifier)
            session.refresh(meta, full, turn_limit)
            return session


class HistorySession:
    def __init__(self, store, identifier):
        self.store, self.id = store, identifier
        self.condition = threading.Condition(threading.RLock())
        self.timeline = Timeline()
        self.sequence, self.viewers = 0, 0
        self.touched = time.monotonic()
        self.submissions = {}
        self.limit, self.fingerprint = 1, None
        # This flag describes a healthy history transport, never an app owner.
        self.connected = True

    def refresh(self, meta, full=False, turn_limit=None):
        with self.condition:
            if full:
                self.limit = None
            elif turn_limit and self.limit is not None:
                self.limit = max(self.limit, turn_limit)
            stat = Path(meta['rollout_path']).stat()
            fingerprint = (stat.st_ino, stat.st_size, stat.st_mtime_ns,
                           meta.get('name'), meta.get('title'), self.limit)
            if fingerprint != self.fingerprint:
                self.state = self.store._history(self.id, meta, self.limit)
                self.fingerprint = fingerprint
                self.sequence += 1
                self.condition.notify_all()

    def view(self, *, include_turns=True):
        result = normalize_state(self.state, True, include_turns=include_turns)
        return {**result, 'sequence': self.sequence, 'historyOnly': False, 'resumableHistory': True,
                'status': 'idle',
                'requests': [], 'submissions': [], 'connecting': False, 'activating': False,
                'connectionError': None, 'loadingHistory': False, 'savedHistoryMore': False,
                'host': 'local', 'hostLabel': 'WSL Codex', 'files': [], 'forkedFrom': None,
                'goalRuntimeAvailable': False, 'goalTransport': 'history', 'goalActivationIds': []}
