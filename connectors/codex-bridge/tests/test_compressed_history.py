import ctypes
import ctypes.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from bridge.clients.codex.wsl_history import WslHistory
from bridge.features.sessions.store import SessionStore


def compress(data):
    lib = ctypes.CDLL(ctypes.util.find_library('zstd'))
    lib.ZSTD_compressBound.argtypes = [ctypes.c_size_t]
    lib.ZSTD_compressBound.restype = ctypes.c_size_t
    lib.ZSTD_compress.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
    lib.ZSTD_compress.restype = ctypes.c_size_t
    output = ctypes.create_string_buffer(lib.ZSTD_compressBound(len(data)))
    size = lib.ZSTD_compress(output, len(output), data, len(data), 1)
    return output.raw[:size]


class CompressedHistoryTests(unittest.TestCase):
    def test_compressed_history_and_navigation_preserve_real_content(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / 'home'
            path = home / 'sessions' / 'rollout.jsonl'
            path.parent.mkdir(parents=True)
            records = [
                {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'turn-1'}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': '原始问题'}]}},
                {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'text', 'text': '原始回答'}]}},
                {'type': 'event_msg', 'payload': {'type': 'task_complete'}},
            ]
            compressed = path.with_name(path.name + '.zst')
            compressed.write_bytes(compress((''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in records)).encode()))
            meta = {'rollout_path': str(path), 'cwd': root}
            store = WslHistory(home, [{'key': 'fixture', 'name': 'fixture', 'path': root}])
            with patch.object(store, 'get', return_value=meta):
                session = store.session('fixture')
                self.assertEqual(store.navigation_index('fixture')['totalTurns'], 1)
            self.assertIn('原始问题', json.dumps(session.state, ensure_ascii=False))
            self.assertIn('原始回答', json.dumps(session.state, ensure_ascii=False))
            self.assertFalse(path.exists())
            self.assertTrue(compressed.exists())

    def test_corrupt_and_truncated_streams_fail_without_silent_empty_history(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'rollout.jsonl.zst'
            for contents in (b'not zstd', compress(b'hello\n')[:-1]):
                path.write_bytes(contents)
                with self.assertRaises(ValueError):
                    SessionStore._recent_lines(path, None)

    def test_large_stream_and_expansion_limit(self):
        from bridge.features.sessions.compressed_rollout import open_rollout
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'rollout.jsonl.zst'
            content = (b'0123456789abcdef' * 65536) + b'\n'
            path.write_bytes(compress(content))
            with open_rollout(path) as stream:
                self.assertEqual(stream.read(), content)
            with patch('bridge.features.sessions.compressed_rollout.MAX_EXPANDED_BYTES', 10):
                with self.assertRaises(ValueError):
                    with open_rollout(path):
                        pass

    def test_rejects_compressed_symlink_outside_codex_home(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / 'home'
            directory = home / 'sessions'
            directory.mkdir(parents=True)
            other = Path(root) / 'external.zst'
            other.write_bytes(compress(b'{}\n'))
            path = directory / 'rollout.jsonl'
            path.with_name(path.name + '.zst').symlink_to(other)
            store = WslHistory(home, [{'key': 'fixture', 'name': 'fixture', 'path': root}])
            self.assertIsNone(store.rollout_path({'rollout_path': str(path)}))
            with self.assertRaises(ValueError):
                store._history('fixture', {'rollout_path': str(path), 'cwd': root})


if __name__ == '__main__':
    unittest.main()
