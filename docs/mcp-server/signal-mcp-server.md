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

`signal-mcp-http-bridge`. Single POST endpoint, JSON request, JSON response:

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

Phase F0 does **not** implement the native MCP streaming protocol. The HTTP bridge is documented honestly as such. A future phase can wrap each tool call in the MCP stdio / SSE envelopes; the dispatcher is shape-compatible.

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

## See also

- [./operator-token-setup.md](./operator-token-setup.md)
- [./claude-code-config.md](./claude-code-config.md)
- [./codex-config.md](./codex-config.md)
- [./tool-permissions.md](./tool-permissions.md)
- [./security-model.md](./security-model.md)
- [./tool-reference.md](./tool-reference.md)
