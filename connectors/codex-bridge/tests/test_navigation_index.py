import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from bridge.features.sessions.store import SessionStore
from bridge.clients.codex.wsl_history import WslHistory


def user(text):
    return json.dumps({'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': text}]}}, ensure_ascii=False) + '\n'


class NavigationIndexTests(unittest.TestCase):
    def test_append_partial_and_rewrite_keep_count_and_bounded_previews(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'rollout.jsonl'
            path.write_text(user('重复') + user('重复'))
            store = SessionStore(root)
            first = store._user_navigation(path)
            self.assertEqual(first['count'], 2)
            self.assertEqual([r['number'] for r in first['previews']], [1, 2])
            self.assertIs(first, store._user_navigation(path))
            partial = user('第三')
            with path.open('a') as stream: stream.write(partial[:-1])
            self.assertEqual(store._user_navigation(path)['count'], 2)
            with path.open('a') as stream: stream.write('\n' + user('长' * 1000))
            snapshot = store._user_navigation(path)
            self.assertEqual(snapshot['count'], 4)
            self.assertEqual(snapshot['previews'][-2]['preview'], '第三')
            self.assertEqual(len(snapshot['previews'][-1]['preview']), 512)
            path.write_text(user('替换'))
            self.assertEqual(store._user_navigation(path)['count'], 1)

    def test_preview_storage_is_bounded_and_tool_bodies_not_returned(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'rollout.jsonl'
            path.write_text(''.join(user(str(n)) for n in range(1010)) + json.dumps({'type': 'response_item', 'payload': {'type': 'function_call_output', 'output': 'secret tool body'}}) + '\n')
            snapshot = SessionStore(root)._user_navigation(path)
            self.assertEqual(snapshot['count'], 1010)
            self.assertEqual(len(snapshot['previews']), 1000)
            self.assertEqual(snapshot['previews'][0]['number'], 11)
            self.assertNotIn('secret tool body', json.dumps(snapshot['previews']))

    def test_scoped_index_never_loads_session_or_history_body(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'sessions' / 'rollout.jsonl'; path.parent.mkdir(); path.write_text(user('原输入'))
            store = WslHistory(root, [{'path': root, 'key': 'demo', 'name': 'demo'}])
            with patch.object(store, 'get', return_value={'rollout_path': str(path)}), patch.object(store, 'session', side_effect=AssertionError('session attached')), patch.object(store, '_history', side_effect=AssertionError('body read')):
                result = store.navigation_index('demo')
            self.assertEqual(result, {'available': True, 'totalTurns': 1, 'turns': [{'number': 1, 'preview': '原输入'}]})
            with patch.object(store, 'get', side_effect=KeyError('outside workspace')):
                with self.assertRaises(KeyError): store.navigation_index('outside')

if __name__ == '__main__': unittest.main()
