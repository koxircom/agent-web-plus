import copy
import sqlite3
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.clients.codex.standalone import StandaloneBridge


class StandaloneActivityStaleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.workspace_dir = self.root / 'workspace'
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        self.outside_dir = self.root / 'outside'
        self.outside_dir.mkdir(parents=True, exist_ok=True)

        self.bridge = StandaloneBridge.__new__(StandaloneBridge)
        self.bridge.lock = threading.RLock()
        self.bridge.registry_lock = threading.RLock()
        self.bridge.records = {'threads': {}}
        self.bridge.workspaces = [{'path': self.workspace_dir}]
        self.bridge.live = {}
        self.bridge.history = None

    def tearDown(self):
        self.tmp.cleanup()

    def test_stale_history_and_live_multi_session_skips_deleted_and_keeps_live_status(self):
        """2+ 会话场景：明确缺失的合法历史会话跳过，存在的活跃和历史会话完整返回真实状态，不置全 idle。"""
        live_id = str(uuid.uuid4())
        hist_id = str(uuid.uuid4())
        stale_id = str(uuid.uuid4())

        self.bridge.records['threads'][live_id] = {
            'cwd': str(self.workspace_dir),
            'updatedAt': 1234.5,
            'runtime': 'web',
        }

        class MockChat:
            connected = True
            def view(self, include_turns=False):
                return {'status': 'active', 'requests': ['req1']}

        self.bridge.live[live_id] = MockChat()

        class MockHistory:
            def get_many(self, wanted):
                # stale_id 明确缺失，只有 hist_id 返回
                res = {}
                if hist_id in wanted:
                    res[hist_id] = {'updated_at': 1000.0}
                return res

            def get(self, identifier):
                if identifier == hist_id:
                    return {'updated_at': 1000.0}
                raise KeyError('找不到指定 WSL 工作区内的会话')

        self.bridge.history = MockHistory()

        results = self.bridge.activity([stale_id, live_id, hist_id])
        # stale_id 应被跳过，结果仅包含 live_id 与 hist_id
        self.assertEqual(len(results), 2)
        by_id = {r['id']: r for r in results}

        self.assertNotIn(stale_id, by_id)
        self.assertIn(live_id, by_id)
        self.assertIn(hist_id, by_id)

        # 验证真实状态完整返回，live 会话绝不能被置为 fake idle
        self.assertEqual(by_id[live_id]['status'], 'active')
        self.assertTrue(by_id[live_id]['connected'])
        self.assertTrue(by_id[live_id]['hasPendingRequests'])
        self.assertEqual(by_id[live_id]['recency'], 1234.5 * 1000)

        # 验证历史会话状态
        self.assertEqual(by_id[hist_id]['status'], 'idle')
        self.assertFalse(by_id[hist_id]['connected'])
        self.assertTrue(by_id[hist_id]['resumableHistory'])
        self.assertEqual(by_id[hist_id]['recency'], 1000.0 * 1000)

    def test_concurrent_registry_delete_skips_truly_missing_and_returns_remaining(self):
        """并发删除场景：registry 删除并发引发 _record KeyError 时只对真正不存在跳过，其余正常返回。"""
        live_id = str(uuid.uuid4())
        deleted_id = str(uuid.uuid4())

        self.bridge.records['threads'][live_id] = {
            'cwd': str(self.workspace_dir),
            'updatedAt': 2000.0,
            'runtime': 'web',
        }
        # 初始时 deleted_id 在 records 中，但进入循环前被并发删除
        self.bridge.records['threads'][deleted_id] = {
            'cwd': str(self.workspace_dir),
            'updatedAt': 1500.0,
            'runtime': 'web',
        }

        class MockChat:
            connected = False
            def view(self, include_turns=False):
                return {'status': 'idle', 'requests': []}

        self.bridge.live[live_id] = MockChat()

        class MockHistory:
            def get_many(self, wanted):
                return {}
            def get(self, identifier):
                raise KeyError('找不到指定 WSL 工作区内的会话')

        self.bridge.history = MockHistory()

        # 模拟并发删除：调用 _record 时 deleted_id 已被移出 records 且 history 中也不存在
        original_record = self.bridge._record
        def simulated_record(identifier):
            if identifier == deleted_id:
                with self.bridge.registry_lock:
                    self.bridge.records['threads'].pop(deleted_id, None)
                raise KeyError(identifier)
            return original_record(identifier)

        self.bridge._record = simulated_record

        results = self.bridge.activity([deleted_id, live_id])
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]['id'], live_id)
        self.assertEqual(results[0]['recency'], 2000.0 * 1000)

    def test_invalid_uuid_raises_value_error(self):
        """保持 UUID 校验：非法 UUID 绝不能当成明确缺失静默跳过，必须抛出 ValueError。"""
        valid_id = str(uuid.uuid4())
        self.bridge.records['threads'][valid_id] = {
            'cwd': str(self.workspace_dir),
            'updatedAt': 1000.0,
            'runtime': 'web',
        }

        # 非法 UUID 格式
        with self.assertRaises(ValueError):
            self.bridge.activity([valid_id, 'not-a-valid-uuid'])

        # 非字符串类型
        with self.assertRaises(ValueError):
            self.bridge.activity([valid_id, 12345])

    def test_permission_error_out_of_scope_is_not_swallowed(self):
        """保持权限校验：会话目录越权（跨 workspace 目录）必须抛出 PermissionError，绝不吞掉。"""
        live_id = str(uuid.uuid4())
        out_of_scope_id = str(uuid.uuid4())

        self.bridge.records['threads'][live_id] = {
            'cwd': str(self.workspace_dir),
            'updatedAt': 1000.0,
            'runtime': 'web',
        }
        self.bridge.records['threads'][out_of_scope_id] = {
            'cwd': str(self.outside_dir),
            'updatedAt': 1000.0,
            'runtime': 'web',
        }

        with self.assertRaises(PermissionError):
            self.bridge.activity([live_id, out_of_scope_id])

    def test_unrestored_wsl_history_permission_error_is_not_swallowed(self):
        """保持权限校验：_record 抛出未恢复 WSL 会话的 PermissionError 绝不吞掉。"""
        unrestored_id = str(uuid.uuid4())
        valid_id = str(uuid.uuid4())

        self.bridge.records['threads'][valid_id] = {
            'cwd': str(self.workspace_dir),
            'updatedAt': 1000.0,
            'runtime': 'web',
        }

        class MockHistory:
            def get_many(self, wanted):
                return {}
            def get(self, identifier):
                if identifier == unrestored_id:
                    return {'cwd': str(self.workspace_dir)}
                raise KeyError('not found')

        self.bridge.history = MockHistory()

        # 模拟并发恢复态回退：不在 wanted_ids 且 _record 抛 PermissionError
        original_record = self.bridge._record
        def simulated_record(identifier):
            if identifier == unrestored_id:
                raise PermissionError('此 WSL 会话尚未恢复')
            return original_record(identifier)

        self.bridge._record = simulated_record

        # unrestored_id 在 records['threads'] 快照阶段出现，随后 _record 抛 PermissionError
        self.bridge.records['threads'][unrestored_id] = {
            'cwd': str(self.workspace_dir),
            'updatedAt': 500.0,
            'runtime': 'web',
        }
        with self.assertRaises(PermissionError):
            self.bridge.activity([valid_id, unrestored_id])

    def test_backend_database_error_is_not_swallowed(self):
        """保持后端错误透明：history 数据库故障（如 SQLite 损坏/操作异常）必须向上抛出，绝不吞掉。"""
        hist_id = str(uuid.uuid4())
        live_id = str(uuid.uuid4())

        self.bridge.records['threads'][live_id] = {
            'cwd': str(self.workspace_dir),
            'updatedAt': 1000.0,
            'runtime': 'web',
        }

        class BrokenHistory:
            def get_many(self, wanted):
                raise sqlite3.DatabaseError('database disk image is malformed')
            def get(self, identifier):
                raise sqlite3.DatabaseError('database disk image is malformed')

        self.bridge.history = BrokenHistory()

        with self.assertRaises(sqlite3.DatabaseError):
            self.bridge.activity([hist_id, live_id])


if __name__ == '__main__':
    unittest.main()
