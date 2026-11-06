"""Usage preloading must not parse the index in the interactive gateway."""
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from bridge.features.sessions import usage
from bridge.features.sessions.usage_runtime import UsageSnapshotRuntime, publish_snapshot
import test_usage_ledger as usage_fixtures


class UsageRuntimeIsolationTests(unittest.TestCase):
    def test_snapshot_request_does_not_load_cursor_index_in_gateway(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root / 'home'
            home.mkdir()
            bridge = SimpleNamespace(data_dir=root / 'data', store=SimpleNamespace(home=home),
                                     history_home=None, workspaces=[{'path': root}])
            release = threading.Event()
            started = threading.Event()
            class Worker:
                pid = 999999
                returncode = None
                def __init__(self, *args, **kwargs):
                    started.set()
                def communicate(self, *args, **kwargs):
                    release.wait(3)
                    self.returncode = 0
                    return None, b''
                def poll(self):
                    return self.returncode
                def terminate(self):
                    release.set()
                def wait(self, *args):
                    release.set()
                    self.returncode = 0
                    return 0
            try:
                with patch.object(usage.CodexUsageCollector, '_load',
                                  side_effect=AssertionError('usage request parsed the entire index')):
                    with patch('subprocess.Popen', Worker):
                        result = usage.usage_snapshot(bridge)
                        result = json.loads(result) if isinstance(result, bytes) else result
                        self.assertEqual(result['snapshotId'], 'codex-loading')
                        self.assertTrue(result['loading'])
                        self.assertTrue(started.wait(1), 'worker monitor did not start')
            finally:
                release.set()
                usage.close_usage_runtime(bridge)

    def test_worker_publishes_real_usage_and_cached_reads_do_not_start_more_workers(self):
        fixture = usage_fixtures.CodexUsageLedgerTests()
        fixture.setUp()
        runtime = UsageSnapshotRuntime(fixture.bridge)
        try:
            path = fixture.add_session()
            path.write_bytes(fixture.token('2026-11-05T10:00:00Z', 100, 40, 20))
            first = json.loads(runtime.response())
            self.assertTrue(first['loading'])
            deadline = time.monotonic() + 8
            while runtime.refreshing and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertFalse(runtime.refreshing, 'finite index worker did not finish')
            with patch.object(runtime, '_refresh', side_effect=AssertionError('duplicate worker')):
                result = json.loads(runtime.response())
                again = runtime.response()
            self.assertFalse(result['loading'])
            self.assertNotIn('error', result)
            self.assertEqual(result['buckets'][0]['totalTokens'], 120)
            self.assertEqual(json.loads(again)['snapshotId'], result['snapshotId'])
            self.assertIs(again, runtime.response())
        finally:
            runtime.close()
            fixture.tearDown()

    def test_scope_change_never_returns_previous_workspace_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            home = root / 'home';home.mkdir()
            workspace = root / 'workspace';workspace.mkdir()
            bridge = SimpleNamespace(data_dir=root / 'data', store=SimpleNamespace(home=home),
                                     history_home=None, workspaces=[{'path': workspace}])
            runtime = UsageSnapshotRuntime(bridge)
            scope = runtime.scope_reader._scope_fingerprint()
            publish_snapshot(bridge.data_dir, scope, {'version': 2, 'snapshotId': 'old-workspace',
                                                     'buckets': [], 'sessions': {'private': {}}})
            runtime.last_refresh = time.monotonic()
            runtime.scope = scope
            self.assertEqual(json.loads(runtime.response())['snapshotId'], 'old-workspace')
            other = root / 'other';other.mkdir()
            bridge.workspaces = [{'path': other}]
            with patch.object(runtime, '_refresh', return_value=None):
                result = json.loads(runtime.response())
            self.assertNotEqual(result['snapshotId'], 'old-workspace')
            self.assertEqual(result['sessions'], {})
            runtime.close()

    def test_corrupt_wire_keeps_last_complete_snapshot_and_reports_error(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);home=root/'home';home.mkdir()
            bridge=SimpleNamespace(data_dir=root/'data',store=SimpleNamespace(home=home),
                                   history_home=None,workspaces=[{'path':root}])
            runtime=UsageSnapshotRuntime(bridge);scope=runtime.scope_reader._scope_fingerprint()
            publish_snapshot(bridge.data_dir,scope,{'version':2,'snapshotId':'complete','buckets':[],'sessions':{}})
            runtime.scope=scope;runtime.last_refresh=time.monotonic()
            self.assertEqual(json.loads(runtime.response())['snapshotId'],'complete')
            runtime.path.write_bytes(b'incomplete')
            result=json.loads(runtime.response())
            self.assertEqual(result['snapshotId'],'complete');self.assertIn('error',result)
            runtime.close()


if __name__ == '__main__':
    unittest.main()
