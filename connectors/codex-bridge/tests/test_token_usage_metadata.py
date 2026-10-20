"""Cumulative Codex token totals stay distinct from last-request context use."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge.features.sessions.model import normalize_state
from bridge.features.sessions.store import SessionStore


class TokenUsageMetadataTests(unittest.TestCase):
    @staticmethod
    def state(info):
        return {'id': 'fixture', 'latestTokenUsageInfo': info,
                'turns': [{'turnId': 'turn', 'items': []}]}

    def test_live_cumulative_totals_and_last_request_occupancy_are_separate(self):
        normalized = normalize_state(self.state({
            'total': {'inputTokens': 420, 'cachedInputTokens': 120, 'outputTokens': 80,
                      'reasoningOutputTokens': 24, 'totalTokens': 500},
            'last': {'totalTokens': 48}, 'modelContextWindow': 1000,
        }))
        self.assertEqual(normalized['tokenUsage'], {
            'inputTokens': 420, 'cachedInputTokens': 120, 'outputTokens': 80,
            'reasoningOutputTokens': 24, 'totalTokens': 500})
        self.assertEqual(normalized['contextUsage']['usedTokens'], 48)

    def test_history_maps_native_total_fields_and_preserves_last_and_window(self):
        with tempfile.TemporaryDirectory() as root:
            home = Path(root) / 'home'
            path = home / 'sessions' / 'rollout.jsonl'
            path.parent.mkdir(parents=True)
            record = {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
                'total_token_usage': {'input_tokens': 420, 'cached_input_tokens': 120,
                                      'output_tokens': 80, 'reasoning_output_tokens': 24,
                                      'total_tokens': 500},
                'last_token_usage': {'input_tokens': 40, 'output_tokens': 8, 'total_tokens': 48},
                'model_context_window': 1000}}}
            path.write_text(json.dumps(record) + '\n')
            saved = SessionStore(home)._history('fixture', {'rollout_path': str(path), 'cwd': root})
        self.assertEqual(saved['latestTokenUsageInfo'], {
            'modelContextWindow': 1000, 'last': {'totalTokens': 48},
            'total': {'inputTokens': 420, 'cachedInputTokens': 120, 'outputTokens': 80,
                      'reasoningOutputTokens': 24, 'totalTokens': 500}})
        normalized = normalize_state(saved)
        self.assertEqual(normalized['tokenUsage']['totalTokens'], 500)
        self.assertEqual(normalized['contextUsage']['usedTokens'], 48)

    def test_missing_optional_fields_and_zero_counts_are_valid(self):
        normalized = normalize_state(self.state({'total': {
            'inputTokens': 0, 'outputTokens': 0, 'totalTokens': 0}}))
        self.assertEqual(normalized['tokenUsage'], {
            'inputTokens': 0, 'cachedInputTokens': 0, 'outputTokens': 0,
            'reasoningOutputTokens': 0, 'totalTokens': 0})

    def test_incomplete_or_invalid_counts_are_unavailable(self):
        valid = {'inputTokens': 10, 'cachedInputTokens': 2, 'outputTokens': 3,
                 'reasoningOutputTokens': 1, 'totalTokens': 13}
        invalid_totals = [
            {'outputTokens': 3, 'totalTokens': 13},
            {**valid, 'inputTokens': True},
            {**valid, 'outputTokens': -1},
            {**valid, 'totalTokens': 13.0},
            {**valid, 'cachedInputTokens': False},
            {**valid, 'reasoningOutputTokens': -1},
            {**valid, 'cachedInputTokens': 11},
        ]
        self.assertIsNone(normalize_state(self.state({'last': {'totalTokens': 7}}))['tokenUsage'])
        for total in invalid_totals:
            with self.subTest(total=total):
                self.assertIsNone(normalize_state(self.state({'total': total}))['tokenUsage'])


if __name__ == '__main__':
    unittest.main()
