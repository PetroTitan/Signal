# Signal MCP server

Phase F0 ships the **Signal MCP HTTP bridge** at `/api/mcp`. External AI operators (Claude Code, Codex, Claude Opus) authenticate with a workspace-scoped bearer token and call a narrow, audited tool surface.

Signal is the control plane:

- workspace database
- approval system
- policy engine
- weekly contract authority
- execution state machine
- audit trail
- MCP tool provider

The operator's assistant remains the agent. Signal never reaches into it.

## Transport

Two endpoints share one internal dispatcher (auth → scopes → deny-list →
audit → approval). Pick by client:

### `/api/mcp/http` — real MCP (use this for Claude Code / mcp-remote)

MCP Streamable HTTP / JSON-RPC 2.0. Supports `initialize`,
`notifications/initialized`, `tools/list`, and `tools/call`:

```
POST https://<your-signal-host>/api/mcp/http
Authorization: Bearer <operator_token>
Content-Type: application/json

{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "signal.products.list", "arguments": {} } }
```

`initialize` returns `protocolVersion`, `serverInfo`, and
`capabilities.tools`. `tools/list` returns every supported tool with `name`,
`description`, and `inputSchema`. `tools/call` forwards to the same dispatcher
and returns the Signal envelope as MCP result `content` + `structuredContent`.
A missing/invalid token is a JSON-RPC `-32001` auth error (HTTP 401). `GET`
returns 405 (POST-only; no server-initiated SSE stream). Wiring instructions:
[./claude-code-config.md](./claude-code-config.md).

### `/api/mcp` — internal custom HTTP API (NOT MCP)

Single POST, custom envelope. This is **not** an MCP server and must **not**
be used with `mcp-remote` or `claude mcp add` — a JSON-RPC `initialize` body
is rejected with `Request must include a 'tool' string.`:

```
POST https://<your-signal-host>/api/mcp
Authorization: Bearer <operator_token>
Content-Type: application/json

{
  "tool": "signal.products.list",
  "args": {}
}
```

`GET /api/mcp` is a public discovery endpoint that returns the tool registry, allowed scopes, blocked scopes, and the explicit deny-list. It never requires authentication.

## Response envelope

```json
{
  "ok": true,
  "tool": "signal.products.list",
  "status": "completed",
  "summary": "12 product(s)",
  "data": { "products": [ ... ] },
  "warnings": [],
  "requires_user_approval": false,
  "audit_id": "..."
}
```

Failure responses use the same shape with `ok=false` and `status` in `{ unauthorized | blocked | failed }`. No raw exceptions ever leak.

## Tool surface

8 read-only + 5 prepare/write-pending + 4 verification/dry-run tools, plus 11 explicitly blocked names. Each tool declares `required_scopes`, `risk_level`, `approval_mode`, `writes_database`, and `touches_production`. See [./tool-reference.md](./tool-reference.md).

## Where MCP-created work shows up

External operators create *pending* work; the Signal operator approves it. Every write-pending tool routes into `/approval-queue` so there is one central review surface.

- `signal.weekly_plan.prepare_item` → `weekly_plan_items.status='pending_approval'` (or `'draft'` with `save_as_draft: true`). Pending items appear in **`/approval-queue`** under "Weekly plan items awaiting approval."
- `signal.products.prepare` → `products.review_status='pending_review'`. Appears in `/approval-queue` under "Product profiles awaiting review."
- `signal.accounts.prepare` → `growth_accounts.review_status='pending_review'`. Appears in `/approval-queue` under "Account profiles awaiting review."

Approving a product or account only confirms the profile inside Signal. It does not connect OAuth, publish, schedule, or execute. Live execution still requires an active weekly contract + an execution queue + dry-run/live gate.

## See also

- [./operator-token-setup.md](./operator-token-setup.md)
- [./claude-code-config.md](./claude-code-config.md)
- [./codex-config.md](./codex-config.md)
- [./tool-permissions.md](./tool-permissions.md)
- [./security-model.md](./security-model.md)
- [./tool-reference.md](./tool-reference.md)
