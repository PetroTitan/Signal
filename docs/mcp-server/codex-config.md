# Connecting Codex

Codex doesn't speak Signal's HTTP bridge natively. Like Claude Code, the integration today is either:

1. A direct `curl` / `fetch` from a Codex tool the operator wired manually, or
2. A small MCP wrapper that forwards `tools/call` to `/api/mcp`.

## Direct call from a Codex tool

If the operator's Codex setup exposes a generic HTTP tool, point it at:

```
POST https://<your-signal-host>/api/mcp
Authorization: Bearer <operator_token>
Content-Type: application/json

{ "tool": "signal.<name>", "args": { ... } }
```

Read the response envelope's `status` field. Successful calls have `ok=true` and `status="completed"`. Failures are structured — never raw stack traces.

## What scopes Codex typically needs

- `repo_patch` workflows usually need only **read** scopes from Signal: `workspace:read`, `products:read`, `accounts:read`, `weekly_plans:read`, `contracts:read`, `execution:read`.
- For **PR summaries** that reference the workspace state, add `verification:run` so Codex can read the latest pipeline verdict.
- For **drafting plan items**, add `weekly_plans:write_pending`.

Avoid handing Codex a token with broader scopes than it needs.

## Blocked tools

If Codex calls any name in the blocked list (`signal.publish.live`, `signal.social.create_account`, etc.), the response is `status="blocked"` with a 403. The audit row records the attempt; the operator sees it on `/settings/mcp`.

## See also

- [./claude-code-config.md](./claude-code-config.md)
- [./security-model.md](./security-model.md)
- [./tool-reference.md](./tool-reference.md)
