import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('publisher', Path(__file__).with_name('publish-release.py'))
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)
scanner = publisher.SCANNER


def tarball(path, name, data, kind=tarfile.REGTYPE):
    with tarfile.open(path, 'w:gz') as archive:
        entry = tarfile.TarInfo(name)
        entry.type = kind
        entry.size = len(data) if kind == tarfile.REGTYPE else 0
        archive.addfile(entry, io.BytesIO(data) if entry.size else None)


class ArtifactScannerTest(unittest.TestCase):
    def check_tar(self, name, data, kind=tarfile.REGTYPE):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'package.tgz'
            tarball(path, name, data, kind)
            return scanner.inspect_artifact(path)

    def test_scans_compiled_next_files_without_echoing_credentials(self):
        secret = 'sk-' + 'Z' * 30
        result = self.check_tar('package/.next/server/app.js', ('const key="' + secret + '"').encode())
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn(secret, json.dumps(result))
        self.assertIn('unmarked-credential-shape', str(result))

    def test_fixture_directory_cannot_hide_token(self):
        result = self.check_tar('package/demo/mock/test.js', ('ghp_' + 'Q' * 30).encode())
        self.assertEqual(result['status'], 'failed')

    def test_catches_arbitrary_json_secret_and_private_key(self):
        self.assertEqual(self.check_tar('package/config.json', b'{"apiKey":"opaque-live-value"}')['status'], 'failed')
        self.assertEqual(self.check_tar('package/certificate.txt', b'-----BEGIN ' + b'PRIVATE KEY-----')['status'], 'failed')

    def test_zip_content_is_scanned(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'source.zip'
            with zipfile.ZipFile(path, 'w') as archive:
                archive.writestr('.next/server/main.js', 'const path="/home/private_operator/work"')
            self.assertEqual(scanner.inspect_artifact(path)['status'], 'failed')

    def test_rejects_traversal_links_nested_and_corrupt_archives(self):
        for name, data, kind in [('../escape.txt', b'ok', tarfile.REGTYPE), ('package/link', b'', tarfile.SYMTYPE), ('package/inner.zip', b'opaque', tarfile.REGTYPE)]:
            with self.subTest(name=name):
                self.assertEqual(self.check_tar(name, data, kind)['status'], 'failed')
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'bad.tgz'
            path.write_bytes(b'not-an-archive')
            self.assertEqual(scanner.inspect_artifact(path)['status'], 'failed')

    def test_clean_runtime_asset_is_allowed(self):
        self.assertEqual(self.check_tar('package/.next/server/main.js', b'console.log("ready")')['status'], 'passed')

    def test_build_cache_cannot_be_published(self):
        self.assertEqual(self.check_tar('package/tsconfig.tsbuildinfo', b'{}')['status'], 'failed')

    def test_routes_translation_keys_and_dynamic_auth_prefix_are_not_secrets(self):
        data = b'''const paths=["/api/home/route"]; const labels={"settings.web-password":"UI label","settings.password":"UI label"}; const headers={Authorization:"Bearer "+runtimeToken}; const inputType=hidden?"password":"text"; const other=hidden ? "password" : "text";'''
        self.assertEqual(self.check_tar('package/.next/server/main.js', data)['status'], 'passed')

    def test_exact_secret_fields_and_relative_home_paths_still_block(self):
        for data in [b'const config={password:"opaque-live-value"}', b'const headers={\n Authorization: "Bearer opaque-live-value"}', b'const path="../../../home/private_operator/work"']:
            with self.subTest(dataType='synthetic'):
                self.assertEqual(self.check_tar('package/.next/server/main.js', data)['status'], 'failed')


class FakeGitHub:
    def __init__(self, tag, target, corrupt=False):
        self.tag, self.target, self.corrupt = tag, target, corrupt
        self.commands, self.assets, self.draft = [], {}, None

    def api(self, endpoint, **kwargs):
        if '/git/ref/tags/' in endpoint:
            return {'object': {'type': 'commit', 'sha': self.target}}
        if endpoint.endswith('/releases/latest'):
            return {'tag_name': self.tag}
        if '/releases/tags/' in endpoint:
            if self.draft is None:
                return None
            return {'draft': self.draft, 'prerelease': '-' in self.tag, 'assets': [{'name': n} for n in self.assets], 'html_url': 'https://github.com/' + publisher.REPO + '/releases/tag/' + self.tag}
        raise AssertionError(endpoint)

    def gh(self, *args):
        self.commands.append(args)
        if args[:2] == ('release', 'create'):
            self.draft = True
        elif args[:2] == ('release', 'upload'):
            for name in args[3:args.index('--repo')]:
                path = Path(name)
                self.assets[path.name] = path.read_bytes()
        elif args[:2] == ('release', 'download'):
            name = args[args.index('--pattern') + 1]
            directory = Path(args[args.index('--dir') + 1])
            (directory / name).write_bytes(b'corrupt' if self.corrupt else self.assets[name])
        elif args[:2] == ('release', 'edit'):
            self.draft = False
        return ''


class PublisherTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / 'source'
        self.root.mkdir()
        (self.root / 'package.json').write_text('{"version":"2.0.0"}')
        self.asset = self.base / 'package.tgz'
        tarball(self.asset, 'package/main.js', b'console.log("ready")')
        self.original = self.asset.read_bytes()
        self.notes = self.base / 'notes.md'
        self.notes.write_text('发布说明：修复同步。')
        self.args = type('Args', (), dict(root=self.root, tag='v2.0.0', target='a' * 40, asset=[self.asset], notes_file=self.notes, apply=True))()

    def invoke(self, fake, authentication=None):
        receipt = {}
        with patch.object(publisher, 'authentication', side_effect=authentication or (lambda: {'account': 'koxircom'})), patch.object(publisher, 'api', side_effect=fake.api), patch.object(publisher, 'gh', side_effect=fake.gh):
            publisher.publish(self.args, receipt)
        return receipt

    def test_sensitive_asset_blocks_all_github_calls(self):
        tarball(self.asset, 'package/.next/chunk.js', ('sk-' + 'Z' * 32).encode())
        fake = FakeGitHub(self.args.tag, self.args.target)
        with self.assertRaisesRegex(ValueError, '脱敏扫描未通过'):
            self.invoke(fake)
        self.assertEqual(fake.commands, [])

    def test_sensitive_notes_block_upload_too(self):
        self.notes.write_text('ghp_' + 'Z' * 32)
        fake = FakeGitHub(self.args.tag, self.args.target)
        with self.assertRaisesRegex(ValueError, '脱敏扫描未通过'):
            self.invoke(fake)
        self.assertEqual(fake.commands, [])

    def test_preflight_never_mutates(self):
        self.args.apply = False
        fake = FakeGitHub(self.args.tag, self.args.target)
        self.assertEqual(self.invoke(fake)['status'], 'preflight-passed')
        self.assertEqual(fake.commands, [])

    def test_upload_uses_scanned_snapshot_and_verifies_download(self):
        fake = FakeGitHub(self.args.tag, self.args.target)
        def authentication():
            self.asset.write_bytes(b'changed-after-scan')
            return {'account': 'koxircom'}
        receipt = self.invoke(fake, authentication)
        self.assertEqual(receipt['status'], 'published-and-verified')
        self.assertEqual(fake.assets[self.asset.name], self.original)
        self.assertEqual([c[1] for c in fake.commands], ['create', 'upload', 'download', 'edit'])
        self.assertIn('--draft', fake.commands[0])

    def test_bad_download_keeps_draft(self):
        fake = FakeGitHub(self.args.tag, self.args.target, corrupt=True)
        with self.assertRaisesRegex(ValueError, '下载回读指纹不一致'):
            self.invoke(fake)
        self.assertTrue(fake.draft)
        self.assertFalse(any(c[1] == 'edit' for c in fake.commands))

    def test_remote_tag_mismatch_blocks_upload(self):
        fake = FakeGitHub(self.args.tag, 'b' * 40)
        with self.assertRaisesRegex(ValueError, '提交不一致'):
            self.invoke(fake)
        self.assertEqual(fake.commands, [])

    def test_requires_saved_container_auth_without_env_override(self):
        with patch.dict(os.environ, {'GH_TOKEN': 'not-a-real-token'}), patch.object(Path, 'exists', return_value=True), patch.object(publisher, 'gh') as gh:
            with self.assertRaisesRegex(ValueError, '不接受环境变量令牌'):
                publisher.authentication()
            gh.assert_not_called()
        with patch.object(Path, 'exists', return_value=False):
            with self.assertRaisesRegex(ValueError, '不能回退到本机认证'):
                publisher.authentication()


if __name__ == '__main__':
    unittest.main()
