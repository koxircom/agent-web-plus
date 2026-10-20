"""Durable native-queue -> active-turn transfer, never delete-and-forget.

The native API has no atomic promote operation. Exact queue deletion is the
ownership gate: only a proven `deleted: true` permits steering. Ambiguous writes
are reconciled by identity, never replayed as another user message.
"""
import copy


def pending(row):
    return bool(row.get('nativePromotion')) and row.get('status') in ('queued', 'unknown', 'failed')


def _save(chat):
    chat.persist()
    with chat.condition:
        chat.changed()


def resume(chat, submission, row, native):
    from bridge.clients.codex.native_queue import _confirmed_history, handoff
    marker = row['nativePromotion']
    if marker['stage'] == 'done':
        return
    if _confirmed_history(chat, submission):
        row.update(status='accepted', nativeQueueStage='delivered', nativeQueueConfirmed=True)
        marker['stage'] = 'done'
        _save(chat)
        return
    if marker['stage'] in ('deleting', 'delete_uncertain'):
        items = native.read(chat.id, fresh=True)
        if not any(item['id'] == marker['queueId'] for item in items):
            # Another client may have consumed it. Absence is not permission to
            # submit it again. The original input remains in the journal.
            if row['status'] != 'unknown' or marker['stage'] != 'delete_uncertain':
                row['status'] = 'unknown'
                marker['stage'] = 'delete_uncertain'
                _save(chat)
            return
        marker['stage'] = 'deleting'
        _save(chat)  # Persist exact input before removing the native row.
        try:
            result = native.mutate(chat.id, 'thread/queue/delete', queuedSubmissionId=marker['queueId'])
        except Exception as error:
            if getattr(error, 'rpc_error', None) or getattr(error, 'dispatched', None) is False:
                # Exact native item remains the owner; a later click can retry.
                row.update(status='queued', nativeQueueConfirmed=True, nativeQueueStage='confirmed')
                row.pop('nativePromotion', None)
            else:
                marker['stage'] = 'delete_uncertain'
                row['status'] = 'unknown'
            _save(chat)
            raise
        if not result.get('deleted'):
            marker['stage'] = 'delete_uncertain'
            row['status'] = 'unknown'
            _save(chat)
            return
        marker['stage'] = 'detached'
        _save(chat)
    if marker['stage'] == 'detached':
        # Read only the latest turn, not a large thread's entire history.
        turns = native.backend.request('thread/turns/list', {
            'threadId': chat.id, 'limit': 1, 'sortDirection': 'desc'})['data']
        active = next((turn for turn in turns if turn.get('status') == 'inProgress'), None)
        if active is None:
            # Current turn ended during the click. Restore the exact native
            # input and let its single owner dispatch it normally.
            marker['stage'] = 'restoring'
            row.update(mode='queue', status='queued', nativeQueueStage='prepared', nativeQueueConfirmed=False)
            _save(chat)
        else:
            row.update(mode='steer', workMode=None, status='unknown', turnId=active['id'])
            marker['stage'] = 'steering'
            _save(chat)
            try:
                result = native.mutate(chat.id, 'turn/steer', expectedTurnId=active['id'],
                                       input=copy.deepcopy(row['nativeQueueInput']), clientUserMessageId=submission)
                if result.get('turnId') != active['id']:
                    raise ValueError('引导回执格式无效')
            except Exception as error:
                if row.get('nativeQueueStage') == 'delivered':
                    marker['stage'] = 'done'  # User echo arrived before RPC reply.
                elif getattr(error, 'rpc_error', None) or getattr(error, 'dispatched', None) is False:
                    # Rejection/no write is definitive; safely return to native
                    # queue (including an expected-turn race), never drop input.
                    marker['stage'] = 'restoring'
                    row.update(mode='queue', status='queued', nativeQueueStage='prepared', nativeQueueConfirmed=False)
                # A lost steer reply stays query-only, even after process restart.
                _save(chat)
                if marker['stage'] == 'steering':
                    return
            else:
                row.update(status='accepted', nativeQueueStage='delivered', nativeQueueConfirmed=True)
                marker['stage'] = 'done'
                _save(chat)
    if marker['stage'] == 'restoring':
        handoff(chat, submission, row)
        if row.get('nativeQueueConfirmed'):
            marker['stage'] = 'done'
            _save(chat)


def promote(chat, item, native):
    submission = item['clientUserMessageId']
    row = chat.submissions.get(submission)
    if row and row.get('nativePromotion', {}).get('queueId') == item['id']:
        return  # Duplicate click/HTTP retry cannot perform another steer.
    if row is None:
        from bridge.clients.codex.native_queue import text
        row = {'text': text(item), 'attachments': [], 'attachmentIds': [], 'skills': [],
               'catalog': chat.bridge.catalog_reader, 'mode': 'queue', 'workMode': 'default'}
        chat.submissions[submission] = row
    row.update(queueOwner='native', status='queued', nativeQueueId=item['id'],
               nativeQueueInput=copy.deepcopy(item['input']), nativeQueueConfirmed=False,
               nativePromotion={'queueId': item['id'], 'stage': 'deleting'})
    _save(chat)
    try:
        resume(chat, submission, row, native)
    finally:
        chat.queue_event.set()


def reconcile(chat):
    for submission, row in list(chat.submissions.items()):
        if not pending(row):
            continue
        try:
            resume(chat, submission, row, chat.bridge._native_queue(chat.id))
        except Exception:
            # Prepared/detached reads are safe to retry; uncertain native writes
            # have already advanced to query-only phases in resume().
            continue
