"""Bounded backwards reads must scan long JSONL records only once."""
import io
import json
import unittest
from bridge.features.sessions.store import SessionStore


class LongLineTests(unittest.TestCase):
    def read(self, raw, limit):
        costs = []
        class Block(bytes):
            def __add__(self, other):
                return Block(bytes(self) + other)
            def splitlines(self, *args, **kwargs):
                costs.append(len(self))
                return super().splitlines(*args, **kwargs)
            def split(self, *args, **kwargs):
                costs.append(len(self))
                return super().split(*args, **kwargs)
        class Stream(io.BytesIO):
            def read(self, *args):
                return Block(super().read(*args))
        class File:
            def open(self, _mode): return Stream(raw)
            def read_bytes(self): return raw
        result = SessionStore._recent_lines(File(), limit)
        return result, sum(costs)

    def test_large_record_has_linear_scan_cost_and_exact_tail(self):
        def start(i):
            return json.dumps({'type':'event_msg','payload':{'type':'task_started','turn_id':str(i)}}).encode() + b'\n'
        wanted = start(2) + b'{"output":"' + b'x' * (6 * 1024 * 1024) + b'"}\n'
        raw = start(1) + b'{}\n' + wanted
        (tail, complete), scanned = self.read(raw, 1)
        self.assertEqual(tail, wanted)
        self.assertFalse(complete)
        self.assertLessEqual(scanned, len(raw) * 2)

    def test_boundaries_empty_crlf_and_unterminated_record(self):
        for raw in (b'', b'{}', b'{}\n', b'{}\r\n', b'x' * 140000,
                    b'{}\n' + b'x' * 140000 + b'\r\n{}', b'{}\n\n{}\n'):
            with self.subTest(size=len(raw)):
                (tail, complete), _ = self.read(raw, 4)
                self.assertEqual(tail, raw)
                self.assertTrue(complete)

if __name__ == '__main__':
    unittest.main()
