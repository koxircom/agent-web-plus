"""Bounded phone projections. Original desktop state stays authoritative.

Cursors belong to one in-memory timeline epoch. Replacement/reordered desktop
history invalidates them explicitly; appending or editing text does not.
"""
import hashlib
import json
import re
import uuid
from collections import OrderedDict

from bridge.features.sessions.model import normalize_timestamp

PAGE_BYTES = 192 * 1024
TEXT_PREVIEW = 8000
DETAIL_CHARS = 16000
INTERNAL_CITATION = re.compile(r'<oai-mem-citation\b[^>]*>.*?</oai-mem-citation\s*>',
                               re.IGNORECASE | re.DOTALL)


def visible_text(message):
    text = message.get('text') or ''
    if message.get('output'):
        text += '\n\n' + message['output']
    if message.get('role') == 'assistant':
        text = INTERNAL_CITATION.sub('', text).rstrip()
    return text


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


class Timeline:
    def __init__(self):
        self.epoch = uuid.uuid4().hex
        self.sequence = -1
        self.rows = []
        self.order_origin = 0
        self.details = {}
        self.positions = {}
        self.versions = OrderedDict()
        self.meta = {}

    def update(self, view):
        if self.sequence == view['sequence']:
            # Display metadata can change without a new native turn/event.
            self.meta.update({k: v for k, v in view.items() if k != 'turns'})
            return
        old_timestamps = {row['key']: row['timestamp'] for row in self.rows if 'timestamp' in row}
        activation_ids = set(view.get('goalActivationIds') or ())
        rows, details = [], {}
        for turn in view['turns']:
            occurrences = {}
            first_user = next((m for m in turn['messages'] if m['role'] == 'user'), None)
            for message in turn['messages']:
                if message.get('requestId') and message['requestId'] in activation_ids:
                    continue
                # Acknowledged input and its native echo are one user entry.
                identity = ([turn['id'], 'user-request', message['requestId']]
                            if message.get('role') == 'user' and message.get('requestId')
                            else [turn['id'], message.get('id'), message.get('kind')])
                base = hashlib.sha256(encoded(identity)).hexdigest()[:24]
                ordinal = occurrences.get(base, 0)
                occurrences[base] = ordinal + 1
                key = base + '-' + str(ordinal)
                text = visible_text(message)
                activity = message['role'] == 'activity'
                row = {k: message[k] for k in ('role', 'kind', 'status', 'title', 'phase', 'requestId', 'deliveryConfirmed', 'timestamp') if k in message}
                if 'timestamp' in row:
                    normalized = normalize_timestamp(row['timestamp'])
                    if normalized is not None:
                        row['timestamp'] = normalized
                    else:
                        row.pop('timestamp', None)
                if 'timestamp' not in row and key in old_timestamps:
                    row['timestamp'] = old_timestamps[key]
                version = hashlib.sha256(encoded([text, turn.get('model'), turn.get('effort'),
                                                 message.get('requestId'), message.get('attachments'), message.get('deliveryConfirmed'),
                                                 row.get('timestamp')])).hexdigest()[:24]
                row.update(key=key, turnId=turn['id'], order=len(rows), version=version,
                           text=text[:180 if activity else TEXT_PREVIEW],
                           truncated=(activity and bool(text)) or len(text) > TEXT_PREVIEW, turnStatus=turn.get('status'),
                           editable=turn.get('actionable', True) and message is first_user and message.get('kind') == 'userMessage',
                           forkable=bool(turn.get('actionable', True) and turn.get('id') and turn.get('id') != 'history' and message is first_user and message.get('kind') == 'userMessage' and message.get('role') == 'user'))
                if message['role'] == 'assistant':
                    row.update({k:turn[k] for k in ('model','effort') if turn.get(k)})
                if message.get('attachments'):
                    row['attachments'] = [{k: str(a[k])[:300] for k in ('type', 'name', 'path', 'uploadId', 'mime', 'thumb', 'desktopId') if k in a}
                                          for a in message['attachments'][:20]]
                rows.append(row)
                details[key] = text
            if turn.get('error'):
                key = hashlib.sha256(encoded([turn['id'], 'error'])).hexdigest()[:24] + '-error'
                text = turn['error'] if isinstance(turn['error'], str) else json.dumps(turn['error'], ensure_ascii=False)
                err_ts = normalize_timestamp(turn.get('errorTimestamp') or turn.get('timestamp')) or old_timestamps.get(key)
                error_row = dict(key=key, turnId=turn['id'], order=len(rows), role='error', text=text[:TEXT_PREVIEW],
                                 truncated=len(text) > TEXT_PREVIEW, version=hashlib.sha256(text.encode()).hexdigest()[:24])
                if err_ts is not None:
                    error_row['timestamp'] = err_ts
                rows.append(error_row)
                details[key] = text
        old_keys = [row['key'] for row in self.rows]
        new_keys = [row['key'] for row in rows]
        # Prepending saved turns preserves existing row keys and cursors.
        first = new_keys.index(old_keys[0]) if old_keys and old_keys[0] in new_keys else 0
        if old_keys != new_keys[first:first + len(old_keys)]:
            self.epoch = uuid.uuid4().hex
            self.versions.clear()
            self.order_origin = 0
        elif old_keys:
            self.order_origin -= first
        for index, row in enumerate(rows):
            row['order'] = self.order_origin + index
        self.sequence = view['sequence']
        self.rows, self.details = rows, details
        self.positions = {row['key']: i for i, row in enumerate(rows)}
        self.meta = {k: v for k, v in view.items() if k != 'turns'}
        self.meta['latestUserTurnId'] = next((t['id'] for t in reversed(view['turns'])
                                              if any(m['role'] == 'user'
                                                     and (not m.get('requestId') or m['requestId'] not in activation_ids)
                                                     for m in t['messages'])), None)
        self.versions[self.sequence] = {row['key']: hashlib.sha256(encoded(row)).digest() for row in rows}
        while len(self.versions) > 16:
            self.versions.popitem(last=False)

    def cursor(self, key):
        return self.epoch + '.' + key

    def position(self, cursor):
        epoch, _, key = cursor.partition('.')
        if epoch != self.epoch or key not in self.positions:
            return None
        return self.positions[key]

    def page(self, limit=20, before=None):
        end = self.position(before) if before else len(self.rows)
        if end is None:
            return {**self.page(), 'reset': True}
        limit = max(1, min(1000, limit))
        selected, size = [], 0
        for row in reversed(self.rows[max(0, end - limit):end]):
            cost = len(encoded(row))
            if selected and size + cost > PAGE_BYTES:
                break
            selected.append(row)
            size += cost
        selected.reverse()
        start = end - len(selected)
        return {'epoch': self.epoch, 'sequence': self.sequence, 'rows': selected,
                'before': self.cursor(selected[0]['key']) if selected else None,
                'hasMore': start > 0 or self.meta.get('savedHistoryMore', False), 'meta': self.meta}

    def changes(self, after, epoch, start):
        first = self.position(start) if start else None
        if epoch != self.epoch or after not in self.versions or (start and first is None):
            return {**self.page(), 'reset': True}
        previous, current = self.versions[after], self.versions[self.sequence]
        rows = [row for row in self.rows[first or 0:]
                if previous.get(row['key']) != current[row['key']]]
        if len(rows) > 100 or sum(len(encoded(row)) for row in rows) > PAGE_BYTES:
            return {**self.page(), 'reset': True}
        return {'epoch': self.epoch, 'sequence': self.sequence, 'rows': rows, 'meta': self.meta}

    def detail(self, cursor, offset=0, version=None):
        position = self.position(cursor)
        if position is None:
            raise ValueError('这条内容已更新，请重新打开聊天')
        row = self.rows[position]
        text = self.details[row['key']]
        offset = max(0, min(offset, len(text))) if version == row['version'] else 0
        end = min(len(text), offset + DETAIL_CHARS)
        return {'key': row['key'], 'version': row['version'], 'text': text[offset:end],
                'offset': offset, 'next': end if end < len(text) else None}
