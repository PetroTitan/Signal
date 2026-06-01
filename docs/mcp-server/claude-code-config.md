# Connecting Claude Code

Signal exposes a **real MCP endpoint** at `/api/mcp/http`. It speaks MCP
Streamable HTTP / JSON-RPC 2.0 (`initialize`, `notifications/initialized`,
`tools/list`, `tools/call`), so Claude Code's built-in HTTP transport (and
`mcp-remote`) connect to it directly — no local wrapper needed.

> The older `/api/mcp` endpoint is an **internal custom HTTP API**, not MCP.
> It expects a `{ "tool": "...", "args": {} }` body and answers a JSON-RPC
> `initialize` with `Request must include a 'tool' string.`. **Do not point
> `mcp-remote` or `claude mcp add` at `/api/mcp`** — use `/api/mcp/http`.

## Add the server to Claude Code

```bash
claude mcp add --transport http signal \
  https://signal.webmasterid.com/api/mcp/http \
  --header "Authorization: Bearer <SIGNAL_TOKEN>"
```

Mint `<SIGNAL_TOKEN>` in Signal under **/settings/mcp/tokens** (it looks like
`sigt_…`). Grant only the scopes the assistant needs — see
[./operator-token-setup.md](./operator-token-setup.md) and
[./tool-permissions.md](./tool-permissions.md).

**Never** paste the token into a tracked file. Claude Code stores the header
in its own MCP config; prefer your OS keychain / a per-user env for the value.

## Quick check (curl)

You can drive the endpoint by hand with raw JSON-RPC:

```bash
# 1) initialize — protocol + capability negotiation
curl -X POST https://<your-signal-host>/api/mcp/http \
  -H "Authorization: Bearer sigt_<your_token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

# 2) tools/list — the Signal tool surface, each with name/description/inputSchema
curl -X POST https://<your-signal-host>/api/mcp/http \
  -H "Authorization: Bearer sigt_<your_token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) tools/call — invoke a tool
curl -X POST https://<your-signal-host>/api/mcp/http \
  -H "Authorization: Bearer sigt_<your_token>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"signal.workspace.get","arguments":{}}}'
```

`initialize` returns `protocolVersion`, `serverInfo`, and
`capabilities.tools`. `tools/call` returns an MCP result whose `content[0]`
text and `structuredContent` carry the full Signal tool envelope —
including `status`, `warnings`, `requires_user_approval`, and `audit_id`.

## Auth behavior

| Situation | Response |
| --- | --- |
| No `Authorization` header | HTTP 401, JSON-RPC error `-32001` (`error_code: missing_authorization`) |
| Malformed `Bearer` / bad token shape | HTTP 401, JSON-RPC error `-32001` |
| Unknown / revoked / expired token | HTTP 401, JSON-RPC error `-32001` |
| Valid token, missing tool scope | tool result with `isError: true` (the Signal envelope explains the missing scopes) |

`initialize`, `notifications/initialized`, and `ping` are open (protocol
negotiation only). `tools/list` and `tools/call` require a valid token.

## What Claude Code can do once connected

Claude Code can call any tool in [./tool-reference.md](./tool-reference.md)
whose `required_scopes` are present on the token. Typical workflows:

- **Read mode** — `signal.workspace.get`, `signal.products.list`,
  `signal.weekly_plan.current`, `signal.execution.queue_status`.
- **Prepare mode** — `signal.weekly_plan.prepare_item`,
  `signal.upload_creative_asset`, `signal.accounts.prepare`,
  `signal.products.prepare` to draft pending-review rows.
- **Report mode** — `signal.reports.submit` after running a local check.

What Claude Code **cannot** do via MCP:

- Publish externally, confirm pending records, or activate weekly contracts.
- Read encrypted tokens, OAuth state, or any column on the secret deny-list.
- Call any name on the explicit deny-list (e.g. `signal.publish.live`) — the
  dispatcher blocks it and returns an `isError` tool result.

The deny-list, scopes, audit logging, and operator approval are enforced by
the **same internal dispatcher** the legacy `/api/mcp` uses — the MCP endpoint
only changes the transport, never the safety model.

## See also

- [./signal-mcp-server.md](./signal-mcp-server.md)
- [./codex-config.md](./codex-config.md)
- [./operator-token-setup.md](./operator-token-setup.md)
- [./tool-reference.md](./tool-reference.md)
