"""Small protocol helpers for the standalone Codex composer."""

from bridge.features.sessions.goal import goal_identity, normalize_goal


COMPOSER_MODES = {'normal', 'plan', 'goal'}


def composer_mode(value):
    if value not in COMPOSER_MODES:
        raise ValueError('输入模式无效')
    return value


def submission_work_mode(selected, stored, prior=None, *, steer=False):
    if steer:
        return None
    if selected is None:
        selected = (prior or {}).get('workMode')
        if selected is None:
            selected = {'normal': 'default'}.get(stored, stored)
    elif selected == 'normal':
        selected = 'default'
    if selected not in ('default', 'plan', 'goal'):
        raise ValueError('输入模式无效')
    return selected


def goal_rpc_unsupported(error):
    rpc_error = getattr(error, 'rpc_error', None)
    if not isinstance(rpc_error, dict):
        return False
    message = str(rpc_error.get('message') or '').lower()
    return rpc_error.get('code') in (-32601, 'method_not_found') or 'method not found' in message


def composer_state(mode, goal, *, goal_known, goal_capable=True, revision=0):
    result = {'version': 1, 'mode': mode, 'revision': revision, 'goalKnown': bool(goal_known),
              'capabilities': {'goal': bool(goal_capable), 'plan': True}}
    goal = normalize_goal(goal) if goal_known else None
    if goal is not None:
        result.update(goal=goal['objective'], paused=goal['status'] == 'paused',
                      goalStatus=goal['status'], goalIdentity=goal_identity(goal))
        elapsed = goal.get('timeUsedSeconds')
        if isinstance(elapsed, (int, float)) and elapsed >= 0:
            result['goalElapsedMs'] = int(elapsed * 1000)
    return result


def native_goal(result):
    """Preserve the distinction between a valid empty response and bad data."""
    if not isinstance(result, dict) or 'goal' not in result:
        raise ValueError('原生目标响应格式无效')
    value = result.get('goal')
    if value is None:
        return None
    normalized = normalize_goal(value)
    if normalized is None:
        raise ValueError('原生目标响应格式无效')
    return normalized
