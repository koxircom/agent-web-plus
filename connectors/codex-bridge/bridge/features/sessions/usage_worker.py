"""Private finite index worker; it has no execution or authentication client."""
import json
import sys
from pathlib import Path
from types import SimpleNamespace

from bridge.features.sessions.usage import CodexUsageCollector
from bridge.features.sessions.usage_runtime import publish_snapshot


def main():
    raw = sys.stdin.buffer.read(65537)
    if len(raw) > 65536:
        raise ValueError('Usage worker input exceeds its limit')
    request = json.loads(raw)
    homes = request['homes']
    if not 1 <= len(homes) <= 2:
        raise ValueError('Invalid usage source homes')
    bridge = SimpleNamespace(data_dir=Path(request['dataDirectory']),
                             store=SimpleNamespace(home=homes[0]),
                             history_home=homes[1] if len(homes) > 1 else None,
                             workspaces=request['workspaces'])
    collector = CodexUsageCollector(bridge)
    scope = collector._scope_fingerprint()
    if scope != request['scopeFingerprint']:
        raise ValueError('Usage scope changed')
    collector._load()
    if collector.snapshot is not None:
        publish_snapshot(collector.data_dir, scope, collector.snapshot)
    snapshot = collector.refresh_sync(copy_result=False)
    publish_snapshot(collector.data_dir, scope, snapshot)


if __name__ == '__main__':
    main()
