"""Codex runtime errors with stable gateway semantics."""
import re

from bridge.features.sessions.side_chat import SideChatError


ACTIVE_WRITER_MESSAGE = (
    '此会话正由其他 Codex 进程写入，当前网页不能接续发送。'
    '请在原端释放会话后重试，或新建网页会话；待发送内容会保留。'
)


class ActiveWriterConflict(SideChatError):
    """Codex rejected an operation before this gateway could own the thread."""

    code = 'codex_active_writer'
    kind = 'active_writer'
    dispatched = False
    status_code = 409

    def __init__(self):
        super().__init__(ACTIVE_WRITER_MESSAGE)
        self.rpc_error = {'code': -32600, 'message': 'thread already has an active writer'}

    def payload(self):
        return {'error': str(self), 'code': self.code, 'kind': self.kind,
                'dispatched': self.dispatched}


def is_active_writer_error(error):
    rpc_error = getattr(error, 'rpc_error', None)
    if not isinstance(rpc_error, dict) or rpc_error.get('code') != -32600:
        return False
    message = rpc_error.get('message')
    return isinstance(message, str) and re.search(r'\balready has an active writer\b', message, re.IGNORECASE) is not None
