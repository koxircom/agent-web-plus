"""Run the explicitly configured Windows Native Codex Desktop gateway."""

import argparse
import json
import logging
import os
import signal
import threading
from pathlib import Path

from bridge.api.httpd import GatewayServer
from bridge.clients.codex.windows_desktop import WindowsDesktopBridge

logger = logging.getLogger(__name__)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    if os.name != "nt":
        raise RuntimeError("Windows Desktop gateway requires native Windows")
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )

    # 严禁导入 Standalone / runtime_update / fcntl
    # Optional creationExecutable is used only for short-lived empty-thread metadata.
    # User turns continue through the existing Desktop owner, not this helper.
    bridge = WindowsDesktopBridge(
        codex_home=config["codexHome"],
        data_dir=config["dataDirectory"],
        workspaces=config.get("workspaces"),
        ipc_path=config.get("ipcPath"),
        creation_executable=config.get("creationExecutable"),
    )

    server = GatewayServer(
        ("127.0.0.1", config["port"]),
        bridge,
        config,
        Path(__file__).parent / "web",
        data_dir=config["dataDirectory"],
        api_only=True,
    )

    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, lambda *_: stop.set())
        except (ValueError, AttributeError):
            pass

    server.timeout = 0.5
    logger.info("Windows 原生 Codex 桌面网关已启动 port=%s", config["port"])
    try:
        while not stop.is_set() and not bridge.closed.is_set():
            server.handle_request()
    finally:
        server.server_close()
        bridge.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
