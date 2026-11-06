"""Long histories keep image identities without rescanning a ledger per turn."""
import copy
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import test_shared_bridge
from bridge.features.sessions.timeline import Timeline


class HistoryAttachmentBatchTests(unittest.TestCase):
    def test_multiple_turns_share_one_ledger_read_without_leaking_paths(self):
        with tempfile.TemporaryDirectory() as root:
            bridge, _, _ = test_shared_bridge.SharedBridgeTests().fixture(root)
            sid = test_shared_bridge.ID
            lookups, images, turns = [], {}, []
            for n in range(8):
                path = str(Path(root) / ('image-%d.png' % n))
                images[path] = {'id': 'upload-%d' % n, 'image': 'image/png', 'name': 'image-%d.png' % n}
                turns.append({'id': 'turn-%d' % n, 'status': 'completed', 'messages': [
                    {'id': 'user-%d' % n, 'role': 'user', 'kind': 'userMessage', 'text': '图片',
                     'attachments': [{'type': 'localImage', 'path': path}]}]})
            def by_path(thread, paths):
                self.assertEqual(thread, sid)
                lookups.append(set(paths))
                return {p: images[p] for p in paths}
            bridge.uploads = SimpleNamespace(by_path=by_path)
            saved = SimpleNamespace(id=sid, condition=threading.RLock(), submissions={}, timeline=Timeline(), sequence=1,
                                    view=lambda **_: {'id': sid, 'sequence': 1, 'title': '图片记录', 'turns': copy.deepcopy(turns)})
            bridge.session = lambda *_args, **_kwargs: saved
            bridge._native_queue_items = lambda _: []
            result = bridge.timeline_read(sid)
            self.assertEqual(len(result['rows']), 8)
            self.assertEqual([r['attachments'][0]['uploadId'] for r in result['rows']], ['upload-%d' % n for n in range(8)])
            self.assertTrue(all('path' not in r['attachments'][0] for r in result['rows']))
            self.assertEqual(lookups, [set(images)], 'each timeline projection has one scoped ledger read')


if __name__ == '__main__':
    unittest.main()
