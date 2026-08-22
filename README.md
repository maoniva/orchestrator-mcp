# orchestrator-mcp

A stateless MCP server that lets an agent discover, create, observe, and manage real, visible threads in T3 Code. Its adapter boundary is intended to support Claude, Codex, Cursor, and other thread hosts later without changing the MCP tool contract.

This project uses the MCP TypeScript SDK v2 and modern Streamable HTTP (protocol revision `2026-07-28`). Every MCP request gets a fresh server instance; it issues no `Mcp-Session-Id` and keeps no caller session state. T3 remains the system of record for projects and threads.

> T3's orchestration endpoints are currently internal APIs. This adapter is tested against T3 Code server `0.0.33`, but may need updates as T3 evolves.

## What it exposes

- `list_platforms` — configured thread hosts and capabilities
- `orchestrator_status` — connection, authentication, and environment identity
- `list_projects` — project IDs, paths, and default model selection
- `list_models` — live providers, models, authentication state, and option descriptors (including valid reasoning levels)
- `list_threads` — visible T3 threads, optionally filtered by project and including archived threads
- `spawn_thread` — idempotently creates a thread and starts its first turn
- `get_thread_status` — execution phase, pending attention, plan progress, and latest assistant output
- `wait_for_thread` — waits for turn completion or full background-work quiescence
- `send_follow_up` — idempotently starts the next turn in an existing thread
- `interrupt_thread` — interrupts the active turn without removing the thread
- `stop_thread_session` — stops the provider session and background work
- `set_thread_lifecycle` — archive, unarchive, settle, or reactivate; never deletes

`spawn_thread` validates the provider instance, model slug, reasoning level, and arbitrary model options against T3's live catalog before dispatching anything. All state-changing tools require an idempotency key.

## Install and run

Requires Node.js 20 or newer and a running T3 Code server.

```bash
npm install
npm run build
```

Issue a T3 bearer token and keep it in the server process environment:

```bash
export T3_BEARER_TOKEN="$(npx -y t3@latest auth session issue \
  --ttl 30d \
  --label orchestrator-mcp \
  --subject orchestrator-mcp \
  --token-only)"
npm start
```

The defaults are:

```text
MCP endpoint: http://127.0.0.1:3939/mcp
Health check: http://127.0.0.1:3939/healthz
T3 endpoint:  http://127.0.0.1:3773
```

Copy [`.env.example`](.env.example) if you want to manage the settings with an environment loader. The server does not load `.env` files itself.

The T3 token is used only for upstream T3 calls. `ORCHESTRATOR_MCP_BEARER_TOKEN` independently protects this server's MCP endpoint. It is optional on loopback and mandatory if `ORCHESTRATOR_HOST` is not a loopback address.

The adapter itself needs T3's `orchestration:read` and `orchestration:operate` capabilities. As of T3 `0.0.33`, `auth session issue` grants a broader session scope set, so treat this credential as sensitive and prefer a short TTL. If T3 adds per-scope issuance, narrow it to those two orchestration scopes.

## Connect a client

For Codex, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.orchestrator]
url = "http://127.0.0.1:3939/mcp"
```

If you set `ORCHESTRATOR_MCP_BEARER_TOKEN`, make the same secret available to the Codex process and add:

```toml
bearer_token_env_var = "ORCHESTRATOR_MCP_BEARER_TOKEN"
```

Any MCP client supporting Streamable HTTP can use the same endpoint. A useful agent workflow is:

1. Call `orchestrator_status`.
2. Call `list_projects` and `list_models`; use the returned IDs and option values exactly.
3. Choose `workspace.mode` explicitly and call `spawn_thread` with a stable idempotency key.
4. Call `wait_for_thread`, or poll `get_thread_status` when the caller needs custom scheduling.
5. Continue with `send_follow_up`, or use the interruption/session/lifecycle tools when needed.

Example `spawn_thread` arguments:

```json
{
  "platform": "t3",
  "idempotency_key": "payment-fix-ticket-4821-v1",
  "project": "ecosconnect",
  "prompt": "Implement the payment fix",
  "title": "Payment fix",
  "provider": "codex",
  "model": "gpt-5.6-sol",
  "reasoning_level": "high",
  "runtime_mode": "full-access",
  "interaction_mode": "default",
  "workspace": {
    "mode": "worktree",
    "base_branch": "main",
    "branch": "agent/payment-fix",
    "start_from_origin": true,
    "run_setup_script": true
  }
}
```

If `provider`, `model`, or model options are omitted, the project default is used when possible. With no project default, the first available provider and its default model are selected. There is intentionally no workspace default: every caller must choose either `{"mode":"project"}` or `worktree` explicitly.

### Idempotency

Use a stable, caller-generated `idempotency_key` for one logical action, such as a ticket ID plus an operation/version suffix. Repeating the exact call with the same key does not create another thread or duplicate a follow-up. A deduplicated result has `deduplicated: true` and may have `dispatchSequence: null` because no new T3 command was sent.

For spawn, the effective project, prompt, model selection, modes, and workspace settings are fingerprinted into a deterministic thread ID. Reusing a spawn key with changed arguments therefore conflicts rather than silently targeting the original thread. Auto-generated worktree branch names are deterministic when an idempotency key is present.

For actions on an existing thread, keys are scoped to that action. Reuse a key only for an exact retry; use a new key for a new prompt or lifecycle transition. T3's persistent command receipts provide retry durability even though this MCP server itself stores no session or idempotency database.

### Waiting and lifecycle

`wait_for_thread` supports two conditions:

- `turn_terminal` returns when the current turn completes, is interrupted, errors, or needs approval/user input.
- `quiescent` additionally waits for provider background work to stop.

Both conditions return early with `attention_required` rather than hanging on an approval or user-input request. The maximum wait per call is five minutes and MCP cancellation aborts the poll immediately.

`interrupt_thread` targets the active turn. `stop_thread_session` is stronger: it stops provider background activity too. Archiving through `set_thread_lifecycle` is reversible and uses T3's native cleanup behavior; deletion is deliberately not exposed.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `T3_BASE_URL` | `http://127.0.0.1:3773` | Running T3 Code server |
| `T3_BEARER_TOKEN` | — | T3 session token required for discovery and dispatch |
| `T3_REQUEST_TIMEOUT_MS` | `15000` | Per-request upstream timeout |
| `ORCHESTRATOR_HOST` | `127.0.0.1` | MCP bind address |
| `ORCHESTRATOR_PORT` | `3939` | MCP port |
| `ORCHESTRATOR_MCP_BEARER_TOKEN` | — | Optional inbound MCP bearer token; required off-loopback |
| `ORCHESTRATOR_ALLOWED_HOSTS` | loopback hosts | Comma-separated Host/Origin allowlist for DNS-rebinding protection |

List and revoke T3 sessions with:

```bash
npx -y t3@latest auth session list
npx -y t3@latest auth session revoke <session-id>
```

Do not reuse the T3 bearer token as the inbound MCP bearer token, commit either token, or expose this endpoint publicly without a proper authentication and TLS boundary.

## Architecture and next adapters

The MCP-facing registry depends on a small `ThreadPlatformAdapter` interface. T3 uses authenticated HTTP for project/thread snapshots. Provider/model discovery and every mutation use short-lived authenticated WebSocket RPCs so bootstrap worktrees and lifecycle cleanup follow T3's native orchestration path. No connection is retained between MCP requests.

A future adapter should implement status, project/workspace discovery, provider/model discovery, thread listing, spawn, waiting, and the lifecycle operations its native host genuinely supports. A host that cannot make a thread visible in its native app should report that limitation instead of pretending a subprocess is an app thread.

Likely next additions are approval/user-input responses, parent/child provenance, concurrency limits, and optional result/diff retrieval.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Tests use an in-process MCP v2 client and mocked T3 orchestration calls. They do not create real T3 threads.
