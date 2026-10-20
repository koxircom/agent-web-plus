"""Pi Web v2 queue contract over the existing durable Codex submission ledger."""
import base64
import copy
from pathlib import Path
from bridge.clients.codex.native_queue import rows as native_rows, operate as native_operate


def queued(chat):
    return [(key, row) for key, row in chat.submissions.items() if row['status'] in ('queued', 'failed', 'unknown') and row.get('queueOwner') != 'native']


def messages(chat):
    from bridge.clients.codex.standalone import pending_submissions
    from bridge.clients.codex.native_queue import merge
    rows = merge(pending_submissions(chat.submissions), chat.bridge._native_queue_items(chat.id), chat.submissions)
    return {'steering': [r['text'] for r in rows if r.get('mode') == 'steer'],
            'followUp': [r['text'] for r in rows if r.get('mode') != 'steer']}


def detail(chat, token, row):
    files = chat.uploads.resolve(chat.id, row.get('attachmentIds', [])) if chat.uploads else []
    # Pi's recall payload supports images. Refuse unsupported attachments before
    # removing anything, rather than silently losing a file on recall.
    if any(not f.get('image') for f in files):
        raise ValueError('这条消息包含文件附件，请保留队列或删除后重新添加文件')
    images = [{'data': base64.b64encode(Path(f['localPath']).read_bytes()).decode('ascii'),
               'mimeType': f['image']} for f in files]
    return {'token': token, 'text': row['text'],
            'kind': 'steering' if row['mode'] == 'steer' else 'followUp', 'images': images}


def operate(chat, command):
    """Serialize with send/consume; tokens are durable, thread-scoped UUIDs.

    No clear-and-requeue, text matching, or automatic write retry is involved.
    """
    action = command.get('type')
    native = chat.bridge._native_queue(chat.id)
    native_items = native.read(chat.id, fresh=action != 'get_queue_actions') if native else []
    if action == 'promote_queued_message' and any(
        row.get('nativePromotion', {}).get('queueId') == command.get('token')
        for row in chat.submissions.values()):
        return {'version': 2, 'success': True, 'queuedMessages': messages(chat)}
    if any(item['id'] == command.get('token') for item in native_items):
        with chat.actions:
            result = native_operate(chat, command, native, native_items)
            result['queuedMessages'] = messages(chat)
            return result
    if native_items and action in ('clear_queue', 'recall_all_queued_messages', 'reorder_queued_message'):
        raise ValueError('队列包含原生消息，请逐条操作，避免跨来源批量修改')
    with chat.actions:
        with chat.condition:
            rows = queued(chat)
            ordered = [item for item in rows if item[1]['mode'] == 'steer'] + [item for item in rows if item[1]['mode'] != 'steer']
            if action == 'get_queue_actions':
                def items(steering):
                    return [{'token': k, 'text': r['text'],
                             'status': r['status'], **({'error': r['error']} if r.get('error') else {}),
                             'imageCount': sum(bool(a.get('image')) for a in r.get('attachments', []))}
                            for k, r in ordered if (r['mode'] == 'steer') == steering]
                from bridge.clients.codex.standalone import pending_submissions
                transfers = [row for row in pending_submissions(chat.submissions)
                             if any(r.get('nativePromotion') and r.get('nativeQueueId') == row['id'] for r in chat.submissions.values())
                             and row['id'] not in {item['id'] for item in native_items}]
                transfer_items = [{'token': row['id'], 'text': row['text'], 'status': row['status'],
                                   'imageCount': len(row['attachments'])} for row in transfers]
                follow_up = items(False) + [{'token': row['id'], 'text': row['text'], 'status': 'queued',
                    'imageCount': len(row['attachments'])} for row in native_rows(native_items, chat.submissions)] + [
                        item for item, row in zip(transfer_items, transfers) if row.get('mode') != 'steer']
                return {'version': 2, 'reorder': not ordered if native_items else not any(r['status'] == 'unknown' for _, r in ordered), 'steering': items(True) + [item for item, row in zip(transfer_items, transfers) if row.get('mode') == 'steer'], 'followUp': follow_up}
            tokens = [k for k, _ in ordered]
            all_items = action in ('recall_all_queued_messages', 'clear_queue')
            if action in ('recall_all_queued_messages', 'reorder_queued_message') and command.get('tokens') != tokens:
                raise ValueError('队列已更新，请刷新后重试')
            token = command.get('token')
            if not all_items and (not isinstance(token, str) or token not in tokens):
                raise ValueError('这条消息已发送或已移除，请刷新队列')
            selected = ordered if all_items else [(token, chat.submissions[token])]
            if action != 'get_queued_message' and any(row['status'] == 'unknown' for _, row in selected):
                raise ValueError('发送结果仍待确认，内容已保留；请先核对原任务，不能自动重发或删除')
            if action == 'get_queued_message':
                return detail(chat, *selected[0])
            if action == 'reorder_queued_message':
                if any(row['status'] == 'unknown' for _, row in ordered):
                    raise ValueError('发送结果仍待确认，请确认后再调整队列顺序')
                target = command.get('targetToken')
                if target not in tokens or ((chat.submissions[target]['mode'] == 'steer') != (selected[0][1]['mode'] == 'steer')):
                    raise ValueError('只能调整同类排队消息的顺序')
            elif action not in ('promote_queued_message', 'recall_queued_message', 'delete_queued_message', 'recall_all_queued_messages', 'clear_queue'):
                raise ValueError('队列操作不受支持')
            result = {'version': 2}
            if action in ('get_queued_message', 'recall_queued_message', 'recall_all_queued_messages'):
                details = [detail(chat, k, row) for k, row in selected]
                result.update({'entries': details} if all_items else details[0])
            # catalog is a live service reference, not deepcopy-able.
            before = {k: dict(row) for k, row in chat.submissions.items()}
            ids = [row.get('clientRequestId') for _, row in selected if row.get('clientRequestId')]
            if action == 'reorder_queued_message':
                keys = list(chat.submissions)
                slots = [i for i, k in enumerate(keys) if k in tokens]
                reordered = [k for k in keys if k in tokens]
                target_index = reordered.index(command['targetToken'])
                reordered.remove(token)
                reordered.insert(target_index, token)
                for i, k in zip(slots, reordered):
                    keys[i] = k
                chat.submissions = {k: chat.submissions[k] for k in keys}
            elif action != 'promote_queued_message':
                for _, row in selected:
                    row['status'] = 'recalled' if action.startswith('recall_') else 'cancelled'
                result.update(success=True, cancelledPromptRequestIds=ids)
                if action.startswith('recall_'):
                    result['recalledPromptRequestIds'] = ids
            if action != 'promote_queued_message':
                with chat.bridge.registry_lock:
                    previous_record = copy.deepcopy(chat.bridge.records['threads'][chat.id])
                    try:
                        chat.persist()
                    except Exception:
                        chat.submissions = before
                        chat.bridge.records['threads'][chat.id] = previous_record
                        raise
            if action != 'promote_queued_message':
                result['queuedMessages'] = messages(chat)
                chat.changed()
                return result
        # Native dispatch must run outside the condition: RPC notifications use
        # the same lock. The actions lock still prevents queue consumption.
        chat.refresh_shared_state()
        with chat.condition:
            row = chat.submissions[token]
            if row['mode'] == 'steer':
                raise ValueError('这条消息已经是引导消息')
            active = chat.state['threadRuntimeStatus']['type'] == 'active'
            if chat.state['requests']:
                raise ValueError('请先处理当前任务的确认，再补充引导')
            if not active:
                chat.queue_event.set()
                return {**result, 'queuedMessages': messages(chat)}
            original = dict(row)
            row.update(mode='steer', workMode=None)
        try:
            outcome = chat._dispatch(token, row)
        except Exception:
            with chat.condition:
                # Only an explicit pre-dispatch or native rejection is safe to
                # restore. Unknown/accepted writes must never be replayed.
                if row['status'] in ('queued', 'failed'):
                    chat.submissions[token] = original
                    chat.persist()
                    chat.changed()
            raise
        if outcome['status'] == 'unknown':
            raise ValueError('引导结果待确认，请核对任务记录，不要重复发送')
        return {**result, 'queuedMessages': messages(chat)}
