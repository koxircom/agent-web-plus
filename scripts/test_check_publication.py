import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('publication', Path(__file__).with_name('check-publication.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PublicationGateTest(unittest.TestCase):
    def test_reports_credential_field_without_value(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); p = root/'demo/mock'; p.mkdir(parents=True)
            (p/'config.json').write_text(json.dumps({'providers': {'example': {'apiKey': 'not-a-real-but-nonempty-value'}}}))
            result = module.inspect(root)
            self.assertEqual(result['status'], 'failed')
            self.assertNotIn('not-a-real-but-nonempty-value', json.dumps(result))
            self.assertIn('credential-field-in-demo-fixture', str(result))
    def test_rejects_personal_paths_and_live_private_endpoints(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'unsafe.js').write_text('const a="/home/private_operator/work"; fetch("http://10.22.33.44:8080");')
            categories = {r['category'] for r in module.inspect(root)['findings']}
            self.assertEqual(categories, {'personal-home-path', 'private-network-endpoint'})
    def test_allows_reserved_examples_and_legacy_compatibility_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'safe.js').write_text('const path="/home/demo/.pi/agent"; const url="https://example.invalid"; const key="pi-web:settings-navigation";')
            self.assertEqual(module.inspect(root)['status'], 'passed')
    def test_excludes_untracked_build_and_dependencies_but_blocks_runtime_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); (root/'.next').mkdir(); (root/'.next/ignored.js').write_text('sk-'+'z'*24)
            (root/'tsconfig.tsbuildinfo').write_text('/home/private_operator/cache')
            (root/'auth.json').write_text('{}')
            self.assertEqual(module.inspect(root)['findings'], [{'path':'auth.json','category':'runtime-or-secret-file'}])

if __name__ == '__main__':
    unittest.main()
