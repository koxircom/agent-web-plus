"""Shared CLI activation entrypoint for the installer and the web gateway."""
import argparse
import json
from pathlib import Path
from bridge.clients.codex.runtime_update import RuntimeUpdate


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--reconcile', action='store_true')
    mode.add_argument('--activity', action='store_true')
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    controller = RuntimeUpdate(config['executable'], config.get('historyHome'), config.get('historySocket'), config.get('runtimeUpdates'))
    if args.activity:
        try:
            result = controller.activity()
        except Exception:
            result = {'busy': True, 'message': '原生任务状态无法确认，继续等待空闲'}
    else:
        result = controller.status()
        if args.reconcile:
            # Only the gateway worker performs activation. Installers acknowledge
            # the pending transition, so their service cgroup never owns Codex.
            result = {'phase': result['codexCliActivationState'],
                      'message': result['codexCliActivationMessage']}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
