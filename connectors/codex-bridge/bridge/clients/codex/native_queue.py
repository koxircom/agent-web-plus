"""Observe the original app-server queue; never copy it into a second executor."""
import base64
import copy
import mimetypes
import threading
import time
from pathlib import Path

from bridge.clients.codex.standalone_composer import goal_rpc_unsupported


class NativeQueue:
    def __init__(self, backend):
        self.backend = backend
        self.lock = threading.RLock()
        self.cache = {}

    def invalidate(self, thread_id=None):
        with self.lock:
            for key in ([thread_id] if thread_id else list(self.cache)):
                if key in self.cache:
                    self.cache[key] = (0, self.cache[key][1])

    def read(self, thread_id, *, fresh=False):
        # Queue reads are small, serialized and separate from chat/event locks.
        # A failed read never fabricates an empty queue or consumes anything.
        with self.lock:
            saved = self.cache.get(thread_id)
            if saved and not fresh and time.monotonic() - saved[0] < 1:
                return copy.deepcopy(saved[1])
            items, cursor, cursors = [], None, set()
            try:
                while True:
                    response = self.backend.request('thread/queue/list', {'threadId': thread_id, 'cursor': cursor}, timeout=5)
                    if not isinstance(response.get('data'), list):
                        raise ValueError('原生队列响应格式无效')
                    items.extend(response['data'])
                    cursor = response.get('nextCursor')
                    if cursor is None:
                        break
                    if cursor in cursors or len(items) > 500:
                        raise ValueError('原生队列分页无效')
                    cursors.add(cursor)
            except Exception as error:
                if goal_rpc_unsupported(error):
                    return []  # Older executors retain the existing web queue.
                if saved and not fresh:
                    return copy.deepcopy(saved[1])
                raise
            if any(not isinstance(item, dict) or not isinstance(item.get('id'), str)
                   or not isinstance(item.get('input'), list) for item in items):
                raise ValueError('原生队列条目格式无效')
            self.cache[thread_id] = (time.monotonic(), items)
            while len(self.cache) > 64:
                self.cache.pop(next(iter(self.cache)))
            return copy.deepcopy(items)

    def mutate(self, thread_id, method, **params):
        try:
            return self.backend.request(method, {'threadId': thread_id, **params}, timeout=10)
        finally:
            self.invalidate(thread_id)


def text(item):
    return '\n'.join(part.get('text', '') for part in item['input'] if part.get('type') == 'text')


def rows(items, receipts=None):
    receipts = receipts or {}
    result = [{'id': item['id'], 'text': text(item), 'status': 'queued', 'mode': 'queue',
             'attachments': [Path(part.get('path', '')).name or '图片' for part in item['input']
                             if part.get('type') in ('image', 'localImage')]}
            for item in items]
    for row, item in zip(result, items):
        receipt = receipts.get(item.get('clientUserMessageId'))
        if receipt and receipt.get('queueOwner') == 'native':
            row['text'] = receipt['text']
            row['attachments'] = [a['name'] for a in receipt.get('attachments', [])]
            if receipt.get('clientRequestId'):
                row['clientRequestId'] = receipt['clientRequestId']
    return result


def merge(submissions, items, receipts=None):
    # A native client ID identifies a user message, not an HTTP delivery ID.
    # Never guess either identity from equal text.
    known = {row['id'] for row in submissions}
    return submissions + rows([item for item in items if item['id'] not in known
                               and item.get('clientUserMessageId') not in known], receipts)


def detail(item):
    images = []
    for part in item['input']:
        if part.get('type') == 'text':
            continue
        if part.get('type') == 'image' and str(part.get('url', '')).startswith('data:image/'):
            header, data = part['url'].split(',', 1)
            if not header.endswith(';base64'):
                raise ValueError('图片格式暂不支持撤回，请在 Codex 桌面处理')
            images.append({'data': data, 'mimeType': header[5:-7]})
        elif part.get('type') == 'localImage':
            path = Path(part['path']).resolve(strict=True)
            if not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
                raise ValueError('图片不可读取，请在 Codex 桌面处理')
            mime = mimetypes.guess_type(path.name)[0] or ''
            if not mime.startswith('image/'):
                raise ValueError('图片类型不可确认，请在 Codex 桌面处理')
            images.append({'data': base64.b64encode(path.read_bytes()).decode('ascii'), 'mimeType': mime})
        else:
            # Preserve rich app inputs instead of silently dropping their context.
            raise ValueError('这条原生消息包含其他附件，请在 Codex 桌面编辑或撤回')
    return {'token': item['id'], 'text': text(item), 'kind': 'followUp', 'images': images}


def operate(chat, command, native, items):
    """Only exact native tokens are operated on; existing desktop owns dispatch."""
    action, token = command.get('type'), command.get('token')
    item = next((item for item in items if item['id'] == token), None)
    if item is None:
        raise ValueError('原生队列已变化，请刷新后重试')
    result = {'version': 2}
    receipt = chat.submissions.get(item.get('clientUserMessageId'))
    def recall_detail():
        if receipt and receipt.get('queueOwner') == 'native':
            from bridge.clients.codex.standalone_queue import detail as local_detail
            return local_detail(chat, token, receipt)
        return detail(item)
    if action == 'get_queued_message':
        return recall_detail()
    if action == 'reorder_queued_message':
        ids = [item['id'] for item in items]
        if command.get('tokens') != ids or command.get('targetToken') not in ids:
            raise ValueError('队列已变化，或包含不同来源的消息，请刷新后重试')
        target = ids.index(command['targetToken'])
        ids.remove(token)
        ids.insert(target, token)
        native.mutate(chat.id, 'thread/queue/reorder', queuedSubmissionIds=ids)
    elif action in ('delete_queued_message', 'recall_queued_message'):
        payload = recall_detail() if action == 'recall_queued_message' else {}
        response = native.mutate(chat.id, 'thread/queue/delete', queuedSubmissionId=token)
        if not response.get('deleted'):
            raise ValueError('这条消息已执行或移除，请刷新队列')
        result.update(payload, success=True)
        receipt = chat.submissions.get(item.get('clientUserMessageId'))
        if receipt and receipt.get('queueOwner') == 'native':
            receipt['status'] = 'recalled' if action == 'recall_queued_message' else 'cancelled'
            chat.persist()
            if receipt.get('clientRequestId'):
                result['cancelledPromptRequestIds'] = [receipt['clientRequestId']]
                if action == 'recall_queued_message':
                    result['recalledPromptRequestIds'] = [receipt['clientRequestId']]
    elif action == 'promote_queued_message':
        from bridge.clients.codex.native_promotion import promote
        promote(chat, item, native)
    else:
        raise ValueError('请逐条操作原生队列，避免跨来源批量修改')
    return result


def _confirmed_history(chat, submission):
    history = chat.bridge.history if chat.shared else chat.bridge.web_history
    check = getattr(history, 'confirmed_user_receipt', None)
    if callable(check):
        try:
            return check(chat.id, submission)
        except (KeyError, OSError):
            pass
    return False


def handoff(chat, submission, row, *, allow_send=True):
    """One durable dispatch attempt; lost responses are reconciled, never replayed.

    The native 0.162.1 API does NOT deduplicate clientUserMessageId. Persist the
    attempt before transport, and retry only a transport-proven not-sent write.
    """
    native = chat.bridge._native_queue(chat.id)
    if native is None:
        raise ValueError('当前运行时不支持原生共享队列，请空闲后发送')
    try:
        items = native.read(chat.id, fresh=True)
    except Exception:
        # Reading has no write side effects. Prepared input can safely wait.
        return {'id': submission, 'status': 'queued'}
    matched = next((item for item in items if item.get('clientUserMessageId') == submission), None)
    if matched:
        row.update(status='queued', nativeQueueId=matched['id'], nativeQueueConfirmed=True, nativeQueueStage='confirmed')
    elif row.get('nativeQueueStage') != 'prepared' or not allow_send:
        if _confirmed_history(chat, submission):
            row.update(status='accepted', nativeQueueConfirmed=True, nativeQueueStage='delivered')
        else:
            return {'id': submission, 'status': row['status']}
    else:
        # Build/validate references before committing the one write attempt.
        inputs = chat._submission_input(row)
        row.update(status='unknown', nativeQueueStage='sending')
        chat.persist()
        try:
            response = native.mutate(chat.id, 'thread/queue/add', input=inputs, clientUserMessageId=submission)
            item = response.get('queuedSubmission') or {}
            if not isinstance(item.get('id'), str) or item.get('clientUserMessageId') != submission:
                raise ValueError('原生队列入队结果尚未确认')
            row.update(status='accepted' if row.get('nativeQueueStage') == 'delivered' else 'queued',
                       nativeQueueId=item['id'], nativeQueueConfirmed=True,
                       nativeQueueStage='delivered' if row.get('nativeQueueStage') == 'delivered' else 'confirmed')
        except Exception as error:
            if getattr(error, 'rpc_error', None):
                row.update(status='failed', nativeQueueStage='rejected', error=str(error))
                chat.persist()
                raise
            if getattr(error, 'dispatched', None) is False:
                row.update(status='queued', nativeQueueStage='prepared')
            else:
                row.update(status='unknown', nativeQueueStage='uncertain')
            chat.persist()
            # LAN/HTTP callers already have a durable receipt. Automatic checks
            # will observe the original client ID rather than add another item.
            return {'id': submission, 'status': row['status']}
    row.pop('error', None)
    chat.persist()
    with chat.condition:
        chat.changed()
    return {'id': submission, 'status': row['status'], 'nativeQueueConfirmed': True,
            **({'nativeQueueId': row['nativeQueueId']} if row.get('nativeQueueId') else {})}


def reconcile_handoffs(chat):
    # Called by this chat's existing worker, outside its event/condition lock.
    # It has no turn/start branch for native-owned items.
    for submission, row in list(chat.submissions.items()):
        if row.get('nativePromotion') or row.get('queueOwner') != 'native' or row.get('nativeQueueConfirmed') or row['status'] not in ('queued', 'unknown'):
            continue
        try:
            handoff(chat, submission, row)
        except Exception:
            # Keep durable input. A definite rejection is projected to the caller;
            # uncertain writes are query-only on the next pass.
            continue
