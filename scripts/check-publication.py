#!/usr/bin/env python3
"""Read-only publication gate. Reports paths/categories, never matched values."""
import argparse
import json
import re
import tarfile
import zipfile
from pathlib import Path, PurePosixPath

EXCLUDED = {'.git', 'node_modules', '.next', '__pycache__', '.quality-runs'}
FORBIDDEN_DIRS = {'runtime', 'acceptance', '.codex', '.pi', 'sessions', 'state'}
TOKEN = re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,})\b')
HOME = re.compile(r'(?<![\w./-])(?:(?:file://)?/home/|(?:\.\./)+home/|/Users/|[A-Za-z]:[/\\]+Users[/\\]+)([\w.-]+)')
DEMO_USERS = {'demo', 'user', 'example', 'test', 'testuser', 'alice', 'bob', 'alex', 'runner', 'node', 'someone', 'me', 'username', 'xxx', 'you'}
PRIVATE_URL = re.compile(r'https?://(?:10(?:[.]\d{1,3}){3}|192[.]168(?:[.]\d{1,3}){2}|172[.](?:1[6-9]|2\d|3[01])(?:[.]\d{1,3}){2})(?=[:/"\s]|$)')
SECRET_FIELDS = {'apikey', 'api_key', 'access_token', 'refresh_token', 'authorization', 'client_secret', 'password'}
PRIVATE_KEY = re.compile(r'-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----')
LITERAL_SECRET = re.compile(r'''(?i)(?<![\w.$/-])(?P<quote>["']?)(?P<field>api_?key|access_token|refresh_token|client_secret|password|authorization)\b(?P=quote)\s*[:=]\s*["'](?P<value>[^"'\r\n]+)["']''')
ARCHIVES = ('.tgz', '.tar.gz', '.tar', '.zip', '.gz', '.7z', '.rar', '.xz', '.bz2')
MAX_MEMBER = 64 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_MEMBERS = 20000

def placeholder(value):
    value = value.strip()
    return (not value or value.startswith(('${', '<', 'process.env.', 'env:'))
            or value.lower() in {'password', 'secret', 'token', 'example', 'placeholder', 'redacted', 'test', 'dummy', 'bearer', 'basic'}
            or bool(re.fullmatch(r'(?:test|fake|dummy|fixture|example|placeholder|invalid)[-_][\w.-]+', value, re.I)))

def inspect_entry(name, data, *, artifact=False):
    """Share content rules between source files and the exact uploaded bytes."""
    rel = PurePosixPath(name)
    findings = []
    def fail(category, line=None):
        row = {'path': TOKEN.sub('[redacted]', name), 'category': category}
        if line is not None:
            row['line'] = line
        findings.append(row)
    parts = rel.parts[1:] if rel.parts and rel.parts[0] == 'package' else rel.parts
    if (parts and parts[0] in FORBIDDEN_DIRS) or rel.name in {'auth.json', 'config.toml', 'connector.json', 'execution-engines.json', 'hosts.yml', '.git-credentials'} or rel.suffix in {'.pem', '.key', '.log', '.tsbuildinfo'} or rel.name.startswith('.env'):
        fail('runtime-or-secret-file')
    text = data.decode('utf-8', errors='replace')
    is_test = any(part in {'tests', 'e2e', 'mock'} for part in rel.parts) or '.test.' in rel.name or rel.name.startswith('test_')
    for number, line in enumerate(text.splitlines(), 1):
        if PRIVATE_KEY.search(line):
            fail('private-key', number)
        for token in TOKEN.findall(line):
            if (artifact or not is_test) and not re.search(r'test|fake|dummy|fixture|example|placeholder|invalid', token, re.I):
                fail('unmarked-credential-shape', number)
        if (artifact or not is_test) and any(m.group(1).lower() not in DEMO_USERS for m in HOME.finditer(line)):
            fail('personal-home-path', number)
        if PRIVATE_URL.search(line.replace('\\.', '.')) and (artifact or not is_test):
            fail('private-network-endpoint', number)
    if artifact:
        for match in LITERAL_SECRET.finditer(text):
            separator = text[match.end('field') + len(match.group('quote')):match.start('value')].lstrip()[0]
            if separator == ':':
                position = match.start() - 1
                while position >= 0 and text[position].isspace():
                    position -= 1
                # Object properties follow { or ,. A ternary such as
                # hidden ? "password" : "text" is an input type, not a secret.
                if position < 0 or text[position] not in '{,':
                    continue
            if not placeholder(match.group('value')):
                fail('credential-literal', text.count('\n', 0, match.start()) + 1)
    if rel.suffix == '.json' and (artifact or 'mock' in rel.parts):
        try:
            doc = json.loads(text)
        except ValueError:
            fail('invalid-json')
        else:
            def walk(value):
                if isinstance(value, dict):
                    for key, item in value.items():
                        if key.lower() in SECRET_FIELDS and isinstance(item, str) and item.strip() and (not artifact or not placeholder(item)):
                            fail('credential-field-in-artifact' if artifact else 'credential-field-in-demo-fixture')
                        walk(item)
                elif isinstance(value, list):
                    for item in value:
                        walk(item)
            walk(doc)
    return findings

def inspect(root):
    findings = []
    count = 0
    for path in sorted(root.rglob('*')):
        rel = path.relative_to(root)
        if any(part in EXCLUDED for part in rel.parts):
            continue
        if path.suffix == '.tsbuildinfo':
            continue  # Unpublished TypeScript incremental cache; artifacts never skip it.
        if not path.is_file():
            continue
        count += 1
        if path.is_symlink():
            findings.append({'path': rel.as_posix(), 'category': 'symlink-not-public-source'})
            continue
        try:
            data = path.read_bytes()
        except OSError:
            findings.append({'path': rel.as_posix(), 'category': 'unreadable-file'})
            continue
        if path.suffix == '.tgz':
            findings.append({'path': rel.as_posix(), 'category': 'runtime-or-secret-file'})
        findings.extend(inspect_entry(rel.as_posix(), data))
    return {'status': 'failed' if findings else 'passed', 'filesScanned': count, 'findings': findings}

def inspect_artifact(path):
    """Do not extract archives or skip build directories, binary data or tests."""
    findings, seen = [], set()
    total = 0
    def member(name, size, read, regular=True, directory=False):
        nonlocal total
        normalized = name.replace('\\', '/')
        rel = PurePosixPath(normalized)
        if rel.is_absolute() or '..' in rel.parts or re.match(r'^[A-Za-z]:', normalized):
            raise ValueError('unsafe-archive-path')
        if directory:
            return
        if not regular:
            raise ValueError('archive-link-or-special-file')
        if normalized in seen:
            raise ValueError('duplicate-archive-member')
        seen.add(normalized)
        total += size
        if size > MAX_MEMBER or total > MAX_TOTAL or len(seen) > MAX_MEMBERS:
            raise ValueError('artifact-scan-limit')
        if normalized.lower().endswith(ARCHIVES):
            raise ValueError('nested-archive-not-scanned')
        data = read()
        if len(data) != size:
            raise ValueError('truncated-archive-member')
        findings.extend(inspect_entry(normalized, data, artifact=True))
    try:
        if path.is_symlink() or not path.is_file():
            raise ValueError('artifact-must-be-regular-file')
        if path.name.endswith(('.tgz', '.tar.gz', '.tar')):
            with tarfile.open(path, 'r:*') as archive:
                for entry in archive:
                    member(entry.name, entry.size, lambda e=entry: archive.extractfile(e).read(MAX_MEMBER + 1), entry.isfile(), entry.isdir())
        elif path.name.endswith('.zip'):
            with zipfile.ZipFile(path) as archive:
                for entry in archive.infolist():
                    if entry.flag_bits & 1:
                        raise ValueError('encrypted-archive')
                    mode = (entry.external_attr >> 16) & 0o170000
                    member(entry.filename, entry.file_size, lambda e=entry: archive.read(e), mode in {0, 0o100000}, entry.is_dir())
        elif path.suffix.lower() in {'.md', '.txt', '.json', '.sha256'} or path.name == 'SHA256SUMS':
            member(path.name, path.stat().st_size, path.read_bytes)
        else:
            raise ValueError('unsupported-artifact-format')
        if not seen:
            raise ValueError('empty-artifact')
    except (OSError, ValueError, tarfile.TarError, zipfile.BadZipFile, RuntimeError, EOFError):
        findings.append({'path': path.name, 'category': 'artifact-unreadable-or-unsafe'})
    return {'status': 'failed' if findings else 'passed', 'filesScanned': len(seen), 'findings': findings}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path('.'))
    parser.add_argument('--artifact', type=Path, action='append', default=[])
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    result = inspect(args.root.resolve())
    for artifact in args.artifact:
        report = inspect_artifact(artifact)
        result['filesScanned'] += report['filesScanned']
        result['findings'].extend(report['findings'])
    result['status'] = 'failed' if result['findings'] else 'passed'
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if args.report:
        args.report.write_text(payload + '\n', encoding='utf-8')
    print(payload)
    return 0 if result['status'] == 'passed' else 1

if __name__ == '__main__':
    raise SystemExit(main())
