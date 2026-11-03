import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from bridge.clients.codex.title_naming import read_status, project_status
from bridge.clients.codex.wsl_history import WslHistory

class TitleNamingTests(unittest.TestCase):
    def setUp(self):
        self.row = {'id': 'chat', 'name': '🟢 O 新聊天', 'first_user_message': '修复标题'}
        self.state = {'version': 1, 'checkedAt': time.time(), 'serviceError': False,
                      'failures': {'chat': {'observedName': self.row['name'], 'code': 'save_failed'}}}

    def test_error_is_generic_and_contains_no_request_or_exception(self):
        result = project_status(self.row, self.state)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('自动重试', result['message'])
        self.assertNotIn('修复标题', json.dumps(result, ensure_ascii=False))

    def test_recovery_removes_failure_without_changing_title(self):
        self.assertIsNotNone(project_status(self.row, self.state))
        self.state['failures'] = {}
        self.assertIsNone(project_status(self.row, self.state))

    def test_manual_rename_and_empty_chats_are_not_failed(self):
        for name in ['🟢 O 我的标题', '🟢 O A主控 | 修复', 'addon | 修改']:
            self.assertIsNone(project_status({**self.row, 'name': name}, self.state))
        self.assertIsNone(project_status({**self.row, 'first_user_message': ''}, self.state))

    def test_failure_for_different_observed_name_is_ignored(self):
        self.state['failures']['chat']['observedName'] = '🔵 N 新聊天'
        self.assertIsNone(project_status(self.row, self.state))

    def test_worker_outage_shown_only_on_unresolved_placeholder(self):
        self.assertIn('暂不可用', project_status(self.row, {'serviceError': True})['message'])
        self.assertIsNone(project_status({**self.row, 'name': '现有标题'}, {'serviceError': True}))

    def test_absent_file_is_unsupported_stale_and_corrupt_file_are_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertIsNone(read_status(root))
            file = root / 'title-naming-status.json'
            file.write_text(json.dumps(self.state))
            self.assertFalse(read_status(root)['serviceError'])
            self.state['checkedAt'] = time.time() - 61
            file.write_text(json.dumps(self.state))
            self.assertTrue(read_status(root)['serviceError'])
            file.write_text('{broken')
            self.assertTrue(read_status(root)['serviceError'])
            file.write_text('x' * 512001)
            self.assertTrue(read_status(root)['serviceError'])

    def test_scoped_history_list_projects_status_from_single_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'title-naming-status.json').write_text(json.dumps(self.state))
            history = object.__new__(WslHistory)
            history.home = root
            row = {**self.row, 'cwd': str(root), 'title': 'fallback', 'updated_at': 1, 'archived': 0}
            with patch.object(history, '_rows', return_value=[row]), patch.object(history, 'workspace', return_value={'name':'Test','key':'test'}), patch.object(history, 'rollout_path', return_value=None):
                result = history.list()[0]
            self.assertEqual(result['titleNaming']['status'], 'failed')
            self.assertEqual(result['title'], self.row['name'])

if __name__ == '__main__': unittest.main()
