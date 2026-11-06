"""Streaming changes must not re-hash unchanged historical tool bodies."""
import copy
import hashlib
import unittest
from unittest.mock import patch

from bridge.features.sessions import timeline


class TimelineProjectionWorkTests(unittest.TestCase):
    def view(self):
        return {'sequence': 1, 'turns': [
            {'id': 'saved', 'status': 'completed', 'model': 'model', 'messages': [
                {'id': 'tool', 'role': 'activity', 'kind': 'commandExecution',
                 'text': '历史工具输出' * 100_000}]},
            {'id': 'live', 'status': 'inProgress', 'model': 'model', 'messages': [
                {'id': 'answer', 'role': 'assistant', 'kind': 'agentMessage', 'text': '答复'}]},
        ]}

    def test_live_delta_work_excludes_unchanged_historical_body(self):
        view = self.view()
        projection = timeline.Timeline()
        projection.update(view)
        old_key = projection.rows[0]['key']
        old_version = projection.rows[0]['version']
        old_cursor = projection.cursor(old_key)
        old_text = projection.detail(old_cursor)['text']
        view['sequence'] += 1
        view['turns'][-1]['messages'][0]['text'] += '继续输出'

        original_hash = hashlib.sha256
        hashed_bytes = 0

        class CountedHash:
            def __init__(self, data=b'', *args, **kwargs):
                nonlocal hashed_bytes
                hashed_bytes += len(data)
                self.inner = original_hash(data, *args, **kwargs)

            def update(self, data):
                nonlocal hashed_bytes
                hashed_bytes += len(data)
                self.inner.update(data)

            def digest(self):
                return self.inner.digest()

            def hexdigest(self):
                return self.inner.hexdigest()

        with patch.object(timeline.hashlib, 'sha256', CountedHash):
            projection.update(view)

        self.assertLess(hashed_bytes, 64 * 1024,
                        'a small live delta re-hashed the historical transcript')
        self.assertEqual(projection.rows[0]['version'], old_version)
        self.assertEqual(projection.detail(old_cursor)['text'], old_text)
        self.assertEqual(projection.rows[-1]['text'], '答复继续输出')

    def test_same_preview_with_changed_detail_invalidates_opaque_version(self):
        view = self.view()
        projection = timeline.Timeline()
        projection.update(view)
        before = copy.deepcopy(projection.page(limit=10))
        cursor = projection.cursor(projection.rows[0]['key'])
        version = projection.rows[0]['version']
        text = view['turns'][0]['messages'][0]['text']
        view['turns'][0]['messages'][0]['text'] = text + '末尾变化'
        view['sequence'] += 1
        projection.update(view)
        self.assertNotEqual(projection.rows[0]['version'], version)
        self.assertEqual(projection.rows[0]['text'], before['rows'][0]['text'])
        changes = projection.changes(before['sequence'], before['epoch'], before['before'])
        self.assertIn(cursor.split('.', 1)[1], [row['key'] for row in changes['rows']])
        detail = projection.detail(cursor, offset=len(text) - 4, version=projection.rows[0]['version'])
        self.assertTrue(detail['text'].endswith('末尾变化'))


if __name__ == '__main__':
    unittest.main()
