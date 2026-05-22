# Connecting Claude Code

Claude Code does not call Signal's HTTP bridge natively yet. The bridge is JSON-over-HTTP, so the integration path today is a tiny custom MCP server that Claude Code launches locally and forwards calls to Signal.

## Quick check (curl)

Before wiring Claude Code, verify the token works:

```bash
curl -X POST https://<your-signal-host>/api/mcp \
  -H "Authorization: Bearer sigt_<your_token>" \
  -H "Content-Type: application/json" \
  -d '{"tool": "signal.workspace.get", "args": {}}'
```

Expected: `200` and a JSON envelope with `ok=true`, `tool="signal.workspace.get"`, and your workspace info under `data.workspace`.

## Wrapping as an MCP server (minimal stdio bridge)

Claude Code reads MCP servers from `~/.config/claude-code/mcp.json` (or the project-local equivalent). Until Signal speaks native MCP, point Claude Code at a small wrapper that forwards each tool call to the HTTP bridge:

```bash
# ~/bin/signal-mcp-stdio (executable)
#!/usr/bin/env bash
exec node ~/signal-mcp-stdio.js
```

```js
// ~/signal-mcp-stdio.js — minimal sketch, not a complete MCP server
//
// The shape below illustrates the contract. A production wrapper
// should implement the MCP JSON-RPC envelope (tools/list, tools/call)
// and forward each tools/call into a POST against /api/mcp.
```

Once a real MCP wrapper ships, add it to `mcp.json`:

```json
{
  "mcpServers": {
    "signal": {
      "command": "signal-mcp-stdio",
      "env": {
        "SIGNAL_MCP_URL": "https://<your-signal-host>/api/mcp",
        "SIGNAL_MCP_TOKEN": "sigt_..."
      }
    }
  }
}
```

**Important:** never paste the token directly into a tracked config file. Use a per-user env file or your OS keychain.

## What Claude Code can do once connected

Claude Code can call any tool in [./tool-reference.md](./tool-reference.md) whose `required_scopes` are present on the token. Typical workflows:

- **Read mode** — call `signal.workspace.get`, `signal.products.list`, `signal.contracts.active`, `signal.execution.queue_status` to understand what's in the workspace.
- **Prepare mode** — call `signal.products.prepare`, `signal.accounts.prepare`, `signal.weekly_plan.prepare_item` to draft pending-review rows.
- **Report mode** — call `signal.reports.submit` after running a local check; the operator reviews in `/settings/mcp`.

What Claude Code **cannot** do via the MCP server:

- Publish externally.
- Confirm pending records.
- Activate weekly contracts.
- Read encrypted tokens, OAuth state, or any column on the secret deny-list.

## See also

- [./codex-config.md](./codex-config.md)
- [./operator-token-setup.md](./operator-token-setup.md)
- [./tool-reference.md](./tool-reference.md)
