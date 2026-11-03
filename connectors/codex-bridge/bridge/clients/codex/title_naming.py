"""Project the title worker's status without changing native thread metadata."""
import json
import time
from pathlib import Path

PLACEHOLDERS = {'新聊天', '新对话', '未命名聊天', '未命名会话', 'new chat', 'new conversation'}


def read_status(home):
    path = Path(home) / 'title-naming-status.json'
    try:
        if path.stat().st_size > 512_000:
            return {'serviceError': True}
        data = json.loads(path.read_text(encoding='utf-8'))
        if (not isinstance(data, dict) or data.get('version') != 1
                or not isinstance(data.get('checkedAt'), (int, float))
                or not isinstance(data.get('failures'), dict)):
            return {'serviceError': True}
        if not 0 <= time.time() - data['checkedAt'] <= 60:
            return {'serviceError': True}
        return data
    except FileNotFoundError:
        return None  # This Codex home may not have an automatic title worker.
    except (OSError, ValueError):
        return {'serviceError': True}


def project_status(row, snapshot):
    if snapshot is None or not (row.get('first_user_message') or '').strip():
        return None
    name = (row.get('name') or '').strip()
    import re
    base = re.sub(r'^(?:(?:🟢|🔵)\s*)?[ON]\s+', '', name)
    if base.casefold() not in PLACEHOLDERS:
        return None
    if snapshot.get('serviceError'):
        return {'status': 'failed', 'message': '自动命名服务暂不可用，恢复后将自动重试'}
    failure = (snapshot.get('failures') or {}).get(row['id'])
    if not isinstance(failure, dict) or failure.get('observedName') != row.get('name'):
        return None
    message = ('未能提取首条请求标题，可手工重命名' if failure.get('code') == 'request_unavailable'
               else '自动命名失败，稍后将自动重试；也可手工重命名')
    return {'status': 'failed', 'message': message}
