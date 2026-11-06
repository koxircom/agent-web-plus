# Codex headless connector

## Maintenance revision 1.4.61.3

- Fixed false busy rejection during deletion for sessions in confirmed terminal `systemError` status.
- Added strict secondary preflight verification (`thread/read` with `includeTurns: true`) for `systemError`: validates that the thread ID, authorized workspace cwd, and runtime status remain `systemError` (or have safely transitioned to `idle`/`notLoaded`), and confirms that the `turns` array is non-empty with all turn statuses in terminal states (`completed`, `failed`, `interrupted`) and at least one terminal turn present.
- In-progress turns, unknown/malformed turn data, empty turns, status transitions to `active`, or preflight RPC failures fail closed and prevent native deletion dispatch.
- Normal `idle` and `notLoaded` sessions do not incur additional RPC overhead.
- Preserves all invariants: active/unknown/missing rejections, authorized cwd checks, permission checks, native queue checks, and single-attempt non-retrying native delete.
- Distinguishes exact error statuses in logging and user messaging rather than classifying all non-idle states as busy.
- Candidate connector maintenance revision 1.4.61.3; the actual backend remains at 1.4.61.2 until a controlled service switch.
- This is a connector-only maintenance revision; the Web application version remains 1.4.61.

## Maintenance revision 1.4.61.1

- Empty native threads with an exact no-rollout preflight response and fresh scoped store absence still receive queue validation and one native deletion request. Preflight failures are distinguished from uncertain delete receipts; no destructive request is retried.
- Batched activity snapshots omit confirmed missing session IDs left by stale catalogs while preserving scope, UUID, permission, and storage-error checks.
- This is a connector-only maintenance revision; the Web application version remains 1.4.61.

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

## Windows attachment readability and submission phases

The Windows Desktop adapter checks attachments before native dispatch using
the token of every matching app-server child of the connected Desktop pipe
broker. The expected executable and process creation time are checked. Reads
run on a disposable thread, compare the full byte count and SHA-256 with the
stored upload, and always restore the thread token. This does not change ACLs,
enable privileges, or create a second executor. Unknown checks fail closed.

New ledger rows persist `trace` with separate `task_received`, `attachment_read`,
`operation_executed`, and `result_verified` stages. Read the same trace through
the authenticated existing `GET /api/sessions/{thread}/submissions/{request}`
endpoint; request IDs and native turn IDs, rather than text, identify evidence.
Known preflight failures return `dispatched:false`, `retryable:false`, and a
specific code such as `receiver_attachment_access_denied`.

`receiverReadability` records the preflight separately. A successful token read
proves filesystem readability at that instant, not that the model consumed the
image. Without a native content-read acknowledgement, `attachment_read` stays
pending. Operation evidence requires terminal native operation items from the
acknowledged turn; an assistant's prose or a completed turn cannot verify a
business result. `result_verified` remains pending with
`independent_verification_required` until independent verification is available.
An exact persisted UserMessage receipt may settle a previously unknown task_received
stage. Age, matching text, active status, or that receipt alone never confirms
attachment consumption, operation success, or business-result verification.

### Provenance and Differences

- **Provenance**: Restored from the active runtime baseline (`/app/connectors/codex-bridge`) to bring `/workspace/agent-web-plus/connectors/codex-bridge` in alignment with the Windows Desktop adapter contract without whole-runtime overwrite.
- **Recovered modules**: `bridge/clients/codex/{title_naming.py, windows_desktop.py, attachment_readability.py, submission_trace.py}`, `windows_desktop_main.py`.
- **Integrated modifications**: `bridge/api/httpd.py` (runtime_status handling for Windows desktop, distinction of native desktop error messages, and structured ValueError/IPCError status/code/dispatched/retryable extraction) and `bridge/clients/codex/wsl_history.py` (titleNaming projection integration).


## Maintenance revision 1.4.81.1

- Publish compact activity snapshots at native state changes, so sidebar status reads do not wait on history projection locks. Native execution and question status remain authoritative.
- Resolve upload attachment metadata once per timeline projection instead of rescanning the ledger per loaded turn. Existing path and symlink validation remains in place.
- Record slow requests and failures in the gateway service journal using route templates, status, duration and validated trace IDs. Request bodies, response bodies, dynamic paths, queries and conversation IDs are omitted; normal long polls are excluded from slow-request alarms.
- This is a standalone WSL gateway maintenance revision. The Web application version and independent Codex executor are unchanged.

## Maintenance revision 1.4.81.2

- Preserve response status for image/download routes that send headers directly, so diagnostics do not misreport successful responses as failures.

Compressed navigation counts now check the file fingerprint before opening/decompressing a cached rollout. Slow counter reads serialize only per file; other conversations remain independent. Append/replacement invalidation and the existing history scope checks remain authoritative.

## Maintenance revision 1.4.81.3

Read-only native history observation shares failed attempts for up to ten seconds, so concurrent readers do not repeat slow failing resume calls serially. The existing scoped saved history remains readable. Native events and explicit forced retry invalidate the cooldown; native sends, queue mutations and execution ownership do not use it.

## Maintenance revision 1.4.81.4

Standalone GET poll, changes and SSE channels observe sessions without attaching the native writer. This reuses the bounded history observer path; legacy bridge signatures and all native send/queue paths stay unchanged.

## Maintenance revision 1.4.81.5

Compact per-file navigation indexes now retain up to 64 sessions and promote cache hits. Sidebar model/history probes therefore no longer evict unchanged foreground counts after only eight distinct reads. Fingerprint invalidation and exact persisted input counts remain authoritative.
