import importlib.util
import io
import json
import os
import tarfile
import tempfile
import unittest
import zipfile
from types import SimpleNamespace
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
        release = {'id': 123, 'tag_name': self.tag, 'author': {'login': 'koxircom'},
                   'draft': self.draft, 'prerelease': '-' in self.tag,
                   'assets': [{'name': n} for n in self.assets],
                   'html_url': 'https://github.com/' + publisher.REPO + '/releases/tag/' + self.tag}
        if '/releases/tags/' in endpoint:
            return release if self.draft is False else None
        if '/releases?per_page=100&page=' in endpoint:
            return [] if self.draft is None else [release]
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
        elif args[:2] == ('release', 'edit') or args[0] == 'api':
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

    def test_existing_draft_is_found_when_tag_endpoint_omits_it(self):
        fake = FakeGitHub(self.args.tag, self.args.target)
        fake.draft = True
        with self.assertRaisesRegex(ValueError, 'Release 已存在'):
            self.invoke(fake)
        self.assertEqual(fake.commands, [])

    def test_explicit_finalize_downloads_before_publishing_without_upload(self):
        fake = FakeGitHub(self.args.tag, self.args.target)
        fake.draft = True
        fake.assets[self.asset.name] = self.original
        self.args.finalize_draft = 123
        receipt = self.invoke(fake)
        self.assertEqual(receipt['status'], 'published-and-verified')
        self.assertEqual(receipt['resumedDraftId'], 123)
        self.assertEqual(fake.commands[0][1], 'download')
        self.assertEqual(fake.commands[1][0], 'api')
        self.assertIn('repos/' + publisher.REPO + '/releases/123', fake.commands[1])

    def test_finalize_wrong_id_or_published_release_is_rejected(self):
        for draft, identity in [(True, 456), (False, 123)]:
            fake = FakeGitHub(self.args.tag, self.args.target)
            fake.draft = draft
            self.args.finalize_draft = identity
            with self.assertRaisesRegex(ValueError, '草稿身份或所有者不符'):
                self.invoke(fake)
            self.assertEqual(fake.commands, [])

    def test_finalize_rejects_different_owner(self):
        fake = FakeGitHub(self.args.tag, self.args.target)
        fake.draft = True
        self.args.finalize_draft = 123
        original_api = fake.api
        def foreign_owner(endpoint, **kwargs):
            result = original_api(endpoint, **kwargs)
            if isinstance(result, list):
                for row in result:
                    row['author']['login'] = 'another-user'
            return result
        fake.api = foreign_owner
        with self.assertRaisesRegex(ValueError, '草稿身份或所有者不符'):
            self.invoke(fake)
        self.assertEqual(fake.commands, [])

    def test_finalize_missing_assets_does_not_upload(self):
        fake = FakeGitHub(self.args.tag, self.args.target)
        fake.draft = True
        self.args.finalize_draft = 123
        with self.assertRaisesRegex(ValueError, '草稿附件集合不一致'):
            self.invoke(fake)
        self.assertEqual(fake.commands, [])

    def test_finalize_corrupt_download_keeps_draft(self):
        fake = FakeGitHub(self.args.tag, self.args.target, corrupt=True)
        fake.draft = True
        fake.assets[self.asset.name] = self.original
        self.args.finalize_draft = 123
        with self.assertRaisesRegex(ValueError, '下载回读指纹不一致'):
            self.invoke(fake)
        self.assertTrue(fake.draft)
        self.assertEqual([c[1] for c in fake.commands], ['download'])

    def test_requires_saved_container_auth_without_env_override(self):
        with patch.dict(os.environ, {'GH_TOKEN': 'not-a-real-token'}), patch.object(Path, 'exists', return_value=True), patch.object(publisher, 'gh') as gh:
            with self.assertRaisesRegex(ValueError, '不接受环境变量令牌'):
                publisher.authentication()
            gh.assert_not_called()
        with patch.object(Path, 'exists', return_value=False):
            with self.assertRaisesRegex(ValueError, '不能回退到本机认证'):
                publisher.authentication()


class FakeMediaGitHub(FakeGitHub):
    def __init__(self, tag, target, corrupt=False):
        super().__init__(tag, target, corrupt)
        self.draft = False
        self.assets = {'installer.tgz': b'existing-installer', 'SHA256SUMS': b'existing-checksum'}
        self.body = '原有软件发布说明。'

    def api(self, endpoint, **kwargs):
        result = super().api(endpoint, **kwargs)
        if isinstance(result, dict) and 'assets' in result:
            result['body'] = self.body
            result['assets'] = [{'name': name, 'id': index + 1, 'size': len(data),
                'digest': 'sha256:' + __import__('hashlib').sha256(data).hexdigest(),
                'browser_download_url': 'https://example.invalid/' + name}
                for index, (name, data) in enumerate(self.assets.items())]
        return result

    def gh(self, *args):
        if args[0] == 'api':
            self.commands.append(args)
            self.body = json.loads(Path(args[args.index('--input') + 1]).read_text())['body']
            return ''
        return super().gh(*args)


class MediaPublisherTest(unittest.TestCase):
    invoke = PublisherTest.invoke
    def setUp(self):
        PublisherTest.setUp(self)
        self.asset = self.base / 'introduction.mp4'
        self.asset.write_bytes(b'\x00\x00\x00\x18ftypisom' + b'\x00' * 20)
        self.args.asset = [self.asset]
        self.args.append_media_to = 123
        self.notes.write_text('## 视频介绍\n新视频的公开下载链接。')

    # Reuse the existing fake transport helper, not the parent's test cases.
    def test_media_append_preserves_software_and_verifies_before_notes(self):
        fake = FakeMediaGitHub(self.args.tag, self.args.target)
        original = dict(fake.assets)
        receipt = self.invoke(fake)
        self.assertEqual(receipt['status'], 'media-published-and-verified')
        self.assertEqual([c[1] if c[0] == 'release' else c[0] for c in fake.commands], ['upload', 'download', 'api'])
        self.assertTrue(fake.body.startswith('原有软件发布说明。'))
        self.assertIn('视频介绍', fake.body)
        for name, data in original.items(): self.assertEqual(fake.assets[name], data)
        self.assertEqual(receipt['preservedAssets'], sorted(original))

    def test_media_preflight_never_uploads_or_edits(self):
        self.args.apply = False
        fake = FakeMediaGitHub(self.args.tag, self.args.target)
        self.assertEqual(self.invoke(fake)['status'], 'media-preflight-passed')
        self.assertEqual(fake.commands, [])

    def test_media_existing_name_never_clobbers(self):
        fake = FakeMediaGitHub(self.args.tag, self.args.target)
        fake.assets[self.asset.name] = b'already-published'
        with self.assertRaisesRegex(ValueError, '同名附件已存在'):
            self.invoke(fake)
        self.assertEqual(fake.commands, [])

    def test_media_wrong_release_or_owner_is_rejected(self):
        fake = FakeMediaGitHub(self.args.tag, self.args.target)
        self.args.append_media_to = 456
        with self.assertRaisesRegex(ValueError, '身份或所有者不符'):
            self.invoke(fake)
        self.assertEqual(fake.commands, [])

    def test_media_corrupt_readback_does_not_edit_notes_or_retry(self):
        fake = FakeMediaGitHub(self.args.tag, self.args.target, corrupt=True)
        with self.assertRaisesRegex(ValueError, '视频下载回读指纹不一致'):
            self.invoke(fake)
        self.assertEqual([c[1] for c in fake.commands], ['upload', 'download'])
        self.assertEqual(fake.body, '原有软件发布说明。')

    def test_media_rejects_fake_mp4_and_sensitive_bytes_before_github(self):
        for content in (b'not-a-video', b'\x00\x00\x00\x18ftypisom\x00' + ('sk-' + 'Z' * 32).encode()):
            self.asset.write_bytes(content)
            fake = FakeMediaGitHub(self.args.tag, self.args.target)
            with self.assertRaisesRegex(ValueError, '脱敏扫描未通过'):
                self.invoke(fake)
            self.assertEqual(fake.commands, [])


class ReadmeVideoPublisherTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        root = self.base / 'source'; root.mkdir()
        (root / 'README.md').write_text('视频介绍')
        self.video = self.base / 'introduction.mp4'
        self.video.write_bytes(b'\x00\x00\x00\x18ftypisom' + b'\x00' * 20)
        self.args = SimpleNamespace(root=root, asset=[self.video], target='a'*40,
            tag=None, notes_file=None, append_media_to=None, finalize_draft=None, apply=True)
        self.uploads = []
        self.url = 'https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000001'
        def api(endpoint):
            return {'id':123} if endpoint == 'repos/'+publisher.REPO else {'object':{'sha':self.args.target}}
        def upload(*args):
            if 'markdown' in args:
                return '<video src="https://private-user-images.githubusercontent.com/1/00000000-0000-4000-8000-000000000001.mp4?jwt=example"></video>'
            self.uploads.append(args)
            self.assertIn('https://uploads.github.com/user-attachments/assets?', args[5])
            return json.dumps({'url':self.url})
        def download(command, **kwargs):
            Path(command[command.index('--output')+1]).write_bytes(self.video.read_bytes())
            return SimpleNamespace(returncode=0)
        for patcher in (patch.object(publisher,'authentication',return_value={'account':'koxircom'}),
                        patch.object(publisher,'api',side_effect=api), patch.object(publisher,'gh',side_effect=upload),
                        patch.object(publisher.subprocess,'run',side_effect=download),
                        patch.object(publisher.Path,'home',return_value=self.base/'home')):
            patcher.start();self.addCleanup(patcher.stop)

    def test_preflight_has_no_upload(self):
        self.args.apply=False;receipt={}
        publisher.publish_readme_video(self.args,receipt)
        self.assertEqual(receipt['status'],'readme-video-preflight-passed')
        self.assertEqual(self.uploads,[])

    def test_verified_upload_reuses_receipt_without_creating_issue_or_release(self):
        for expected in (False,True):
            receipt={};publisher.publish_readme_video(self.args,receipt)
            self.assertEqual(receipt['url'],self.url)
            self.assertEqual(receipt['reused'],expected)
        self.assertEqual(len(self.uploads),1)

    def test_sensitive_video_is_rejected_before_upload(self):
        self.video.write_bytes(self.video.read_bytes()+('sk-'+'Z'*30).encode())
        with self.assertRaisesRegex(ValueError,'脱敏扫描失败'):
            publisher.publish_readme_video(self.args,{})
        self.assertEqual(self.uploads,[])

    def test_uploaded_receipt_resumes_rendered_media_verification_without_reupload(self):
        directory=self.base/'home/.local/state/agent-web-publisher/readme-videos'
        directory.mkdir(parents=True)
        (directory/(publisher.digest(self.video)+'.json')).write_text(json.dumps({'status':'uploaded-awaiting-verification','url':self.url}))
        receipt={};publisher.publish_readme_video(self.args,receipt)
        self.assertEqual(receipt['status'],'readme-video-verified')
        self.assertTrue(receipt['reused'])
        self.assertEqual(self.uploads,[])

    def test_uncertain_upload_is_not_repeated(self):
        with patch.object(publisher,'gh',side_effect=ValueError('unknown')) as transport:
            with self.assertRaisesRegex(ValueError,'unknown'):
                publisher.publish_readme_video(self.args,{})
            with self.assertRaisesRegex(ValueError,'禁止重复上传'):
                publisher.publish_readme_video(self.args,{})
            self.assertEqual(transport.call_count,1)


if __name__ == '__main__':
    unittest.main()
