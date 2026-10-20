"""Status reads stay bounded independently of the loaded transcript size."""
import tempfile
import unittest
from unittest.mock import patch
import test_history_prefix_growth as fixtures
from bridge.features.sessions import model


class MetadataProjectionTests(unittest.TestCase):
    def test_metadata_preserves_runtime_fields_without_projecting_bodies(self):
        with tempfile.TemporaryDirectory() as root:
            bridge, chat, _ = fixtures.PrefixGrowthTests().make(root, 4)
            chat.state['turns'][-1]['items'][-1]['text'] = '长历史正文' * 100000
            full = chat.view()
            with patch.object(model, 'normalize_item', side_effect=AssertionError('metadata projected a body')):
                meta = bridge.view(fixtures.ID, metadata=True)
            self.assertEqual(meta, {**full, 'turns': []})
            self.assertTrue(full['turns'][-1]['messages'][-1]['text'])

    def test_activity_uses_metadata_and_keeps_native_active_status(self):
        with tempfile.TemporaryDirectory() as root:
            bridge, chat, _ = fixtures.PrefixGrowthTests().make(root, 4)
            chat.state['threadRuntimeStatus'] = {'type': 'active'}
            bridge.records['threads'][fixtures.ID]['updatedAt'] = 1
            with patch.object(model, 'normalize_item', side_effect=AssertionError('activity projected a body')):
                result = bridge.activity([fixtures.ID])
            self.assertEqual(result[0]['status'], 'active')
            self.assertTrue(result[0]['connected'])

    def test_cached_page_and_heartbeat_reuse_rows_and_keep_navigation_metadata(self):
        with tempfile.TemporaryDirectory() as root:
            bridge, chat, _ = fixtures.PrefixGrowthTests().make(root, 4)
            first = bridge.timeline_read(fixtures.ID, limit=1000)
            with patch.object(model, 'normalize_item', side_effect=AssertionError('unchanged rows rebuilt')):
                again = bridge.timeline_read(fixtures.ID, limit=1000)
                delta = bridge.timeline_read(fixtures.ID, 'changes', after=first['sequence'],
                                             epoch=first['epoch'], start=first['before'])
            self.assertEqual(first['rows'], again['rows'])
            self.assertEqual(first['meta']['latestUserTurnId'], again['meta']['latestUserTurnId'])
            self.assertEqual(delta['rows'], [])

    def test_native_event_invalidates_projection(self):
        with tempfile.TemporaryDirectory() as root:
            bridge, chat, _ = fixtures.PrefixGrowthTests().make(root, 4)
            first = bridge.timeline_read(fixtures.ID, limit=1000)
            chat.state['turns'][-1]['items'][-1]['text'] = '真实事件更新'
            with chat.condition:
                chat.changed()
            updated = bridge.timeline_read(fixtures.ID, limit=1000)
            self.assertEqual(updated['epoch'], first['epoch'])
            self.assertEqual(updated['rows'][-1]['text'], '真实事件更新')

if __name__ == '__main__':
    unittest.main()
