"""Run the explicitly configured, server-owned WSL Codex gateway."""
import argparse
import json
import logging
import os
import signal
import socket
import threading
from pathlib import Path

from bridge.api.httpd import GatewayServer
from bridge.clients.codex.standalone import StandaloneBridge


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    bridge = StandaloneBridge(config['codexHome'], config['dataDirectory'], config['workspace'], config['executable'],
                              history_home=config.get('historyHome'), workspaces=config.get('workspaces'),
                              history_socket=config.get('historySocket'), runtime_updates=config.get('runtimeUpdates'))
    server = GatewayServer(('127.0.0.1', config['port']), bridge, config,
                           Path(__file__).parent / 'web', data_dir=config['dataDirectory'], api_only=True)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    def activate_runtime_when_idle():
        while not stop.is_set() and not bridge.closed.is_set():
            try:
                bridge.runtime_updates.step()
            except Exception:
                logging.error("CLI 空闲切换检查失败，保留当前运行时，下次继续检查")
            stop.wait(15)
    activation_worker = None
    if bridge.runtime_updates.enabled:
        activation_worker = threading.Thread(target=activate_runtime_when_idle, daemon=True)
        activation_worker.start()
    server.timeout = .5
    logging.info('WSL 独立网关已启动 port=%s workspace=%s', config['port'], config['workspace'])
    notify = os.environ.get('NOTIFY_SOCKET')
    if notify:
        with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as notification:
            notification.connect('\0' + notify[1:] if notify.startswith('@') else notify)
            notification.sendall(b'READY=1\nSTATUS=WSL Codex gateway ready')
    try:
        while not stop.is_set() and not bridge.closed.is_set():
            server.handle_request()
    finally:
        unexpected_disconnect = bridge.closed.is_set() and not stop.is_set()
        server.server_close()
        bridge.close()
    return 1 if unexpected_disconnect else 0


if __name__ == '__main__':
    raise SystemExit(main())
