"""Focused fixtures for the read-only native Codex usage ledger."""
import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.features.sessions.usage import CodexUsageCollector


SESSION = '4c415d98-57ef-4e6c-b2ed-3c48486c735a'


class CodexUsageLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = self.root / 'codex-home'
        self.workspace = self.root / 'workspace'
        self.data = self.root / 'bridge-data'
        (self.home / 'sessions').mkdir(parents=True)
        self.workspace.mkdir()
        self.database = sqlite3.connect(self.home / 'state_test.sqlite')
        self.database.execute('''CREATE TABLE threads (
            id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT,
            rollout_path TEXT, model_provider TEXT, model TEXT,
            source TEXT, thread_source TEXT, archived INTEGER
        )''')
        self.database.commit()
        self.bridge = SimpleNamespace(
            store=SimpleNamespace(home=self.home), history_home=None,
            workspaces=[{'key': 'fixture', 'path': self.workspace}], data_dir=self.data,
        )
        self.collector = CodexUsageCollector(self.bridge)

    def tearDown(self):
        self.database.close()
        self.temp.cleanup()

    @staticmethod
    def record(kind, timestamp, payload):
        return json.dumps({'type': kind, 'timestamp': timestamp, 'payload': payload},
                          separators=(',', ':')).encode('utf-8') + b'\n'

    @staticmethod
    def token(timestamp, input_tokens, cached, output, last=None):
        usage = {'input_tokens': input_tokens, 'cached_input_tokens': cached,
                 'output_tokens': output, 'total_tokens': input_tokens + output}
        payload = {'type': 'token_count', 'info': {'total_token_usage': usage}}
        if last is not None:
            payload['info']['last_token_usage'] = last
        return CodexUsageLedgerTests.record('event_msg', timestamp, payload)

    def add_session(self, identifier=SESSION, *, path=None, cwd=None, model='model-a',
                    provider='openai', source='{}', thread_source=''):
        rollout = path or (self.home / 'sessions' / f'{identifier}.jsonl')
        rollout.parent.mkdir(parents=True, exist_ok=True)
        if not rollout.exists():
            rollout.write_bytes(b'')
        self.database.execute(
            'INSERT OR REPLACE INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (identifier, 'Fixture title', None, str(cwd or self.workspace), str(rollout),
             provider, model, source, thread_source, 0),
        )
        self.database.commit()
        return rollout

    def test_native_cumulative_deltas_skip_duplicate_snapshots_and_subtract_cache(self):
        path = self.add_session()
        path.write_bytes(
            self.record('turn_context', '2026-10-17T15:00:00Z', {'model': 'model-a'})
            + self.token('2026-10-17T15:01:00Z', 100, 70, 20,
                         {'input_tokens': 100, 'cached_input_tokens': 70, 'output_tokens': 20})
            + self.token('2026-10-17T15:01:00Z', 100, 70, 20)
            + self.token('2026-10-17T15:02:00Z', 160, 110, 40)
        )

        ledger = self.collector.refresh_sync()
        bucket, = ledger['buckets']
        self.assertEqual((bucket['inputTokens'], bucket['cacheReadTokens'], bucket['outputTokens']),
                         (50, 110, 40))
        self.assertEqual((bucket['totalTokens'], bucket['records'], bucket['calls']), (200, 2, 0))
        self.assertEqual(bucket['source'], 'codex')
        self.assertEqual(bucket['engine'], 'codex')
        self.assertEqual(len(bucket['timeline'][0]), 12)
        self.assertEqual(ledger['sessions']['codex:' + SESSION]['executionEngine'], 'codex')

    def test_beijing_day_and_model_switch_split_buckets(self):
        path = self.add_session()
        path.write_bytes(
            self.record('turn_context', '2026-10-17T15:59:00Z', {'model': 'model-a'})
            + self.token('2026-10-17T15:59:59Z', 10, 2, 3)
            + self.record('turn_context', '2026-10-17T16:00:00Z', {'model': 'model-b'})
            + self.token('2026-10-17T16:00:01Z', 4, 1, 2,
                         {'input_tokens': 4, 'cached_input_tokens': 1, 'output_tokens': 2})
        )

        buckets = self.collector.refresh_sync()['buckets']
        self.assertEqual({(item['model'], item['day']) for item in buckets}, {
            ('model-a', '2026-10-17'), ('model-b', '2026-10-18')})
        self.assertTrue(all(item['timeline'][0][0] is not None for item in buckets))

    def test_first_inherited_counter_uses_last_call_and_zero_is_not_usage(self):
        path = self.add_session()
        path.write_bytes(
            self.token('2026-10-18T01:00:00Z', 500, 100, 50,
                       {'input_tokens': 40, 'cached_input_tokens': 10, 'output_tokens': 8})
            + self.token('2026-10-18T01:01:00Z', 0, 0, 0,
                         {'input_tokens': 0, 'cached_input_tokens': 0, 'output_tokens': 0})
            + self.token('2026-10-18T01:02:00Z', 5, 2, 2,
                         {'input_tokens': 5, 'cached_input_tokens': 2, 'output_tokens': 2})
        )

        bucket, = self.collector.refresh_sync()['buckets']
        self.assertEqual((bucket['inputTokens'], bucket['cacheReadTokens'], bucket['outputTokens']),
                         (33, 12, 10))
        self.assertEqual(bucket['records'], 2)
        self.assertEqual(bucket['totalTokens'], 55)

    def test_deleted_history_keeps_observed_usage_and_reports_missing_files(self):
        path = self.add_session(cwd=self.workspace / 'removed-project')
        path.write_bytes(self.token('2026-10-18T01:00:00Z', 10, 2, 3))
        before = self.collector.refresh_sync()
        self.assertEqual(before['buckets'][0]['totalTokens'], 13)
        path.unlink()
        after = self.collector.refresh_sync()
        self.assertEqual(after['buckets'], before['buckets'])
        self.assertEqual(after['sources']['codex']['unavailableHistoryCount'], 1)
        self.assertFalse(after['sources']['codex']['complete'])

    def test_append_scan_keeps_complete_offset_and_finishes_partial_tail_once(self):
        path = self.add_session()
        prefix = self.token('2026-10-18T01:00:00Z', 10, 2, 3)
        pending = self.token('2026-10-18T01:01:00Z', 20, 4, 6).rstrip(b'\n')
        path.write_bytes(prefix + pending[:35])

        first = self.collector.refresh_sync()
        self.assertEqual(first['buckets'][0]['records'], 1)
        cached = next(iter(self.collector.files.values()))
        self.assertEqual(cached['offset'], len(prefix))
        self.assertTrue(cached['partialTail'])
        self.assertFalse(first['sources']['codex']['complete'])
        self.assertIn('尚未写完', first['error'])

        with path.open('ab') as stream:
            stream.write(pending[35:] + b'\n')
        second = self.collector.refresh_sync()
        bucket, = second['buckets']
        self.assertEqual(bucket['records'], 2)
        self.assertEqual(bucket['totalTokens'], 26)
        self.assertFalse(next(iter(self.collector.files.values()))['partialTail'])
        self.assertTrue(second['sources']['codex']['complete'])

    def test_counter_reset_without_last_usage_is_reported_as_a_gap(self):
        path = self.add_session()
        path.write_bytes(
            self.token('2026-10-18T01:00:00Z', 100, 30, 10)
            + self.token('2026-10-18T01:01:00Z', 5, 1, 2)
        )

        ledger = self.collector.refresh_sync()
        self.assertEqual(ledger['sources']['codex']['counterGapCount'], 1)
        self.assertFalse(ledger['sources']['codex']['complete'])
        self.assertIn('last_token_usage', ledger['error'])
        self.assertEqual(ledger['buckets'][0]['missingUsage'], 0)

    def test_rollout_and_workspace_confinement_and_native_subagent_role(self):
        inside = self.add_session(source=json.dumps({
            'subagent': {'thread_spawn': {'parent_thread_id': 'parent-thread'}}
        }))
        inside.write_bytes(self.token('2026-10-18T01:00:00Z', 10, 1, 2))

        outside_rollout = self.root / 'outside.jsonl'
        outside_rollout.write_bytes(self.token('2026-10-18T01:00:00Z', 900, 0, 0))
        self.add_session('5c415d98-57ef-4e6c-b2ed-3c48486c735a', path=outside_rollout)

        outside_workspace = self.root / 'outside-workspace'
        outside_workspace.mkdir()
        escaped = self.add_session('6c415d98-57ef-4e6c-b2ed-3c48486c735a', cwd=outside_workspace)
        escaped.write_bytes(self.token('2026-10-18T01:00:00Z', 800, 0, 0))

        ledger = self.collector.refresh_sync()
        self.assertEqual(ledger['sources']['codex']['fileCount'], 1)
        self.assertEqual(len(ledger['buckets']), 1)
        self.assertEqual(ledger['buckets'][0]['role'], 'subagent')
        self.assertEqual(ledger['buckets'][0]['totalTokens'], 12)
        self.assertEqual(ledger['buckets'][0]['calls'], 1)
        with inside.open('ab') as stream:
            stream.write(self.token('2026-10-18T01:01:00Z', 20, 2, 4))
        self.assertEqual(self.collector.refresh_sync()['buckets'][0]['calls'], 1)

    def test_persisted_snapshot_is_rejected_when_workspace_scope_changes(self):
        path = self.add_session()
        path.write_bytes(self.token('2026-10-18T01:00:00Z', 10, 1, 2))
        self.collector.refresh_sync()

        other_workspace = self.root / 'other-workspace'
        other_workspace.mkdir()
        self.bridge.workspaces = [{'key': 'other', 'path': other_workspace}]
        restarted = CodexUsageCollector(self.bridge)
        restarted._load()

        self.assertIsNone(restarted.snapshot)
        self.assertEqual(restarted.files, {})

    def test_failed_initial_refresh_respects_backoff_but_explicit_refresh_retries(self):
        self.collector._load()
        self.collector.error = '索引失败'
        self.collector.last_refresh = time.monotonic()
        starts = []
        self.collector._start_refresh_locked = lambda: starts.append(True)

        ordinary = self.collector.response()
        self.assertFalse(ordinary['loading'])
        self.assertEqual(ordinary['error'], '索引失败')
        self.assertEqual(starts, [])

        self.collector.response(force=True)
        self.assertEqual(starts, [True])

    def test_parent_metadata_and_subtask_name_are_scoped_without_changing_tokens(self):
        child = '6cc044b6-6892-41f2-b552-b279d4888146'
        parent_path = self.add_session()
        parent_path.write_bytes(self.token('2026-10-18T04:00:00Z', 100, 10, 20))
        child_path = self.add_session(child, source=json.dumps({'subagent': {'thread_spawn': {
            'parent_thread_id': SESSION, 'agent_nickname': '审查助手'}}}), thread_source='subagent')
        self.database.execute('UPDATE threads SET name = ?, title = ? WHERE id = ?', ('', '', child)); self.database.commit()
        child_path.write_bytes(self.token('2026-10-18T04:02:00Z', 50, 5, 10))
        result = self.collector.refresh_sync()
        self.assertEqual(result['sessions']['codex:' + child]['parentSessionId'], 'codex:' + SESSION)
        self.assertEqual(result['sessions']['codex:' + child]['title'], '子任务 · 审查助手')
        self.assertEqual(sum(b['totalTokens'] for b in result['buckets']), 180)
        again = self.collector.refresh_sync()
        self.assertEqual(again['buckets'], result['buckets'])
        # A parent outside the configured workspace must not leak through lineage.
        self.database.execute('UPDATE threads SET cwd = ? WHERE id = ?', (str(self.root / 'outside'), SESSION)); self.database.commit()
        scoped = self.collector.refresh_sync()
        self.assertNotIn('parentSessionId', scoped['sessions']['codex:' + child])
        self.assertNotIn('codex:' + SESSION, scoped['sessions'])


if __name__ == '__main__':
    unittest.main()
