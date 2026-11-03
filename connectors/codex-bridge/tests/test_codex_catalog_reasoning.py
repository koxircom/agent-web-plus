import unittest
from unittest.mock import patch

from bridge.clients.codex.catalog import Catalog, CatalogError


class ApiCatalogReasoningTests(unittest.TestCase):
    def setUp(self):
        self.catalog = Catalog('/tmp/codex-home', '/bin/true', allow_background_refresh=False)
        self.config = {
            'model_provider': 'custom',
            'model_reasoning_effort': 'high',
            'model_providers': {
                'custom': {
                    'base_url': 'https://provider.invalid/v1',
                    'experimental_bearer_token': 'test-token',
                },
            },
        }

    def request_for(self, native_page=None, native_error=None):
        calls = []

        def request(method, params, timeout=90):
            calls.append((method, params, timeout))
            if method == 'config/read':
                return {'config': self.config}
            if method == 'model/list':
                if native_error:
                    raise native_error
                return native_page or {'data': [], 'nextCursor': None}
            raise AssertionError(f'unexpected RPC method: {method}')

        return request, calls

    def test_merges_reasoning_only_for_exact_model_ids(self):
        request, calls = self.request_for({
            'data': [
                {
                    'model': 'gpt-6-astra',
                    'displayName': 'Native Astra label',
                    'supportedReasoningEfforts': [
                        {'reasoningEffort': 'low'},
                        {'reasoningEffort': 'high'},
                        {'reasoningEffort': 'ultra'},
                    ],
                    'defaultReasoningEffort': 'low',
                    'isDefault': True,
                },
                {
                    'model': 'gpt-6-luna',
                    'displayName': 'gpt-6-luna-alias',
                    'supportedReasoningEfforts': [{'reasoningEffort': 'max'}],
                    'defaultReasoningEffort': 'medium',
                },
            ],
            'nextCursor': None,
        })

        with patch('bridge.clients.codex.catalog.model_ids', return_value=[
                'gpt-6-astra', 'gpt-6-luna-alias', 'gpt-image-2']):
            value = self.catalog.read_models(request, '/workspace')

        rows = {row['model']: row for row in value['models']}
        self.assertEqual(value['modelSource'], 'api')
        self.assertEqual(value['currentEffort'], 'high')
        self.assertEqual(set(rows), {'gpt-6-astra', 'gpt-6-luna-alias', 'gpt-image-2'})
        self.assertEqual(rows['gpt-6-astra']['displayName'], 'gpt-6-astra')
        self.assertEqual(rows['gpt-6-astra']['defaultReasoningEffort'], 'low')
        self.assertEqual([effort['reasoningEffort'] for effort in rows['gpt-6-astra']['supportedReasoningEfforts']],
                         ['low', 'high', 'ultra'])
        self.assertNotIn('isDefault', rows['gpt-6-astra'])
        self.assertNotIn('supportedReasoningEfforts', rows['gpt-6-luna-alias'])
        self.assertNotIn('defaultReasoningEffort', rows['gpt-6-luna-alias'])
        self.assertNotIn('supportedReasoningEfforts', rows['gpt-image-2'])
        self.assertEqual([method for method, _, _ in calls], ['config/read', 'model/list'])
        self.assertEqual(calls[-1][2], 12)

    def test_native_catalog_failure_preserves_api_model_ids(self):
        for failure in (CatalogError('native catalog unavailable'), OSError('runtime pipe closed')):
            with self.subTest(failure=type(failure).__name__):
                request, _ = self.request_for(native_error=failure)

                with patch('bridge.clients.codex.catalog.model_ids', return_value=['custom-one', 'custom-two']):
                    value = self.catalog.read_models(request, '/workspace')

                self.assertEqual(value['modelSource'], 'api')
                self.assertEqual([row['model'] for row in value['models']], ['custom-one', 'custom-two'])
                self.assertNotIn('supportedReasoningEfforts', value['models'][0])
                self.assertNotIn('defaultReasoningEffort', value['models'][0])

    def test_matching_native_model_without_capabilities_remains_unknown(self):
        request, _ = self.request_for({
            'data': [{'model': 'gpt-image-2', 'isDefault': True}],
            'nextCursor': None,
        })

        with patch('bridge.clients.codex.catalog.model_ids', return_value=['gpt-image-2']):
            value = self.catalog.read_models(request, '/workspace')

        self.assertEqual(value['models'], [{'model': 'gpt-image-2', 'displayName': 'gpt-image-2'}])


if __name__ == '__main__':
    unittest.main()
