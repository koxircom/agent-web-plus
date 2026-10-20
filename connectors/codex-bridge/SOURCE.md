# Codex headless connector

This optional connector is adapted from the local `Codex Mobile Bridge` Python
version 2.0.3 plus the Pi Web standalone WSL adapter snapshot. That source directory had no Git metadata when inspected, so
there is no source commit to record.

## Source layout and copied resources

- `standalone_main.py` is the standalone server entrypoint.
- `bridge/` contains the Python import closure reachable from that entrypoint,
  `GatewayServer`, and `StandaloneBridge`, plus package `__init__.py` files.
  It retains the native session/event, authentication, workspace, catalog,
  and authorization implementations used by the API.
- `web/assets.json` is retained because `bridge.api.assets` reads it at import
  time to build the fixed static-resource map. No other web frontend assets are
  included; the headless gateway rejects every request outside `/api/`.
- The source `LICENSE` is preserved verbatim as `LICENSE.codex-mobile-bridge`.

The connector does not include the source `desktop/`, `mobile/`, `node_modules/`,
or `__pycache__/` trees, nor any runtime executable, configuration, credentials,
session records, or other runtime data. `package.json` is not needed by the
Python entrypoint or its resource locator.

## API surface added here

Every route passes through the existing configured Host and Origin checks,
authentication, and write CSRF validation before the added dispatch.

| Route | Method | Parameters | Behavior |
| --- | --- | --- | --- |
| `/api/projects/workspace` | GET | `project`, `operation`, optional `path`; for `list`, optional `hidden`, `search`, `offset` | `list`, `info`, `preview`, and `download` call native `workspace.operate` using only the configured workspace selected by its exact key. `download` returns the native JSON/base64 result. |
| `/api/projects/workspace` | POST | `project`, `operation=upload`, `path`; bounded raw body, 0–20 MiB | Calls native `workspace.operate(..., 'upload', ...)` with base64 data. The native atomic upload rejects a different existing file and preserves traversal and symlink checks. |
| `/api/projects/catalog` | GET | `project`, `kind=models\|skills` | Calls `catalog_reader.get_kind(kind, str(configured_project_path))`; it does not create or attach a chat. |

The workspace API does not read the session registry, call session/create or
resume methods, or acquire a Desktop owner. The server-owned Codex session
runtime is lazy-started only by session operations. A catalog cache miss may
start the existing catalog-only `app-server` reader to enumerate models or
Skills; it does not create a thread or chat.

Static call-path evidence: `StandaloneBridge.__init__` creates the lazy runtime
wrapper without spawning it; the project workspace handler calls
`workspace.operate` directly. `thread/start` remains in the separate
`create_chat` method, while catalog reads use `Catalog.get_kind` and its
`model/list` or `skills/list` requests.

## Entry and security boundary

`standalone_main.py --config <external-config>` binds to loopback as configured
by the existing standalone entrypoint and constructs the existing
`GatewayServer` with `api_only=True`. Existing authentication configuration,
allowed origins, CSRF tokens, project keys, native path validation, and session
event routes remain authoritative. There is no alternate login or permission
mode in this connector.

Pi Web adapter modifications include lazy runtime startup, API-only routing, strict configured-project workspace/catalog APIs, stable client request identity, and atomic automatic queue selection. Relative imports are included in the source closure; no browser assets are served.
