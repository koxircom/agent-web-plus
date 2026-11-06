"""Navigation count cache hits and reads are isolated per rollout file."""
import json
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

from bridge.features.sessions import store as store_module
from bridge.features.sessions.store import SessionStore
from test_compressed_history import compress


def user(text):
    return json.dumps({'type': 'response_item', 'payload': {
        'type': 'message', 'role': 'user',
        'content': [{'type': 'input_text', 'text': text}],
    }}, ensure_ascii=False) + '\n'


class NavigationReadIsolationTests(unittest.TestCase):
    def test_foreground_compressed_count_survives_sidebar_metadata_reads(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'foreground.jsonl.zst'
            path.write_bytes(compress(user('当前会话').encode()))
            store = SessionStore(root)
            expected = store._user_navigation(path)
            for index in range(12):
                background = Path(root) / f'background-{index}.jsonl'
                background.write_text(user(f'后台会话 {index}'))
                store._user_navigation(background)
            with patch.object(store_module, 'open_rollout',
                              side_effect=AssertionError('sidebar reads evicted unchanged foreground count')):
                self.assertIs(store._user_navigation(path), expected)

    def test_compressed_fingerprint_cache_hit_skips_open_and_changed_file_reloads(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'rollout.jsonl.zst'
            path.write_bytes(compress(user('首次压缩输入').encode()))
            store = SessionStore(root)

            first = store._user_navigation(path)
            self.assertEqual(first['count'], 1)
            self.assertEqual(first['previews'][0]['preview'], '首次压缩输入')

            with patch.object(store_module, 'open_rollout',
                              side_effect=AssertionError('unchanged compressed cache hit reopened rollout')):
                cached = store._user_navigation(path)
            self.assertEqual(cached, first)

            path.write_bytes(compress((user('首次压缩输入') + user('文件指纹改变后输入')).encode()))
            refreshed = store._user_navigation(path)
            self.assertEqual(refreshed['count'], 2)
            self.assertEqual(refreshed['previews'][-1]['preview'], '文件指纹改变后输入')

    def test_slow_rollout_open_does_not_hold_global_user_count_lock(self):
        with tempfile.TemporaryDirectory() as root:
            slow_path = Path(root) / 'slow.jsonl'
            fast_path = Path(root) / 'fast.jsonl'
            slow_path.write_text(user('慢会话输入'))
            fast_path.write_text(user('快会话输入'))
            store = SessionStore(root)
            open_real = store_module.open_rollout
            entered, release, fast_finished = threading.Event(), threading.Event(), threading.Event()
            failures, counts = [], []

            @contextmanager
            def delayed_open(path, *args, **kwargs):
                if Path(path) == slow_path:
                    entered.set()
                    if not release.wait(3):
                        raise AssertionError('test did not release slow rollout open')
                with open_real(path, *args, **kwargs) as stream:
                    yield stream

            def read_slow():
                try:
                    store._user_navigation(slow_path)
                except BaseException as error:
                    failures.append(error)

            def read_fast():
                try:
                    counts.append(store._user_navigation(fast_path)['count'])
                except BaseException as error:
                    failures.append(error)
                finally:
                    fast_finished.set()

            slow = threading.Thread(target=read_slow, daemon=True)
            fast = threading.Thread(target=read_fast, daemon=True)
            with patch.object(store_module, 'open_rollout', delayed_open):
                slow.start()
                try:
                    self.assertTrue(entered.wait(1), 'slow rollout open did not start')
                    fast.start()
                    self.assertTrue(fast_finished.wait(0.5),
                                    'an unrelated user count waited for the slow rollout')
                finally:
                    release.set()
                    slow.join(2)
                    if fast.ident is not None:
                        fast.join(2)

            self.assertFalse(slow.is_alive(), 'slow user count did not stop')
            self.assertFalse(fast.is_alive(), 'fast user count did not stop')
            self.assertFalse(failures, failures)
            self.assertEqual(counts, [1])


if __name__ == '__main__':
    unittest.main()
