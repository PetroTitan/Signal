# MCP connector UI

`/settings/mcp` is Signal's operator-facing surface for the MCP layer. It does five things:

1. shows the **declared status** of every assistant and tool the operator may connect to Signal,
2. lists the **read-only checks** the operator can run from the browser,
3. surfaces **pending MCP approvals** with explicit Approve / Reject buttons,
4. logs **operation run history** from `mcp_operation_runs`,
5. summarizes the **safety boundary** so the operator can reason about what the runner will and will not do.

The page is reachable from the Configure group in the sidebar.

## Why "declared" status

Signal does not run an MCP client itself. Claude Code, Codex, and Claude Opus connect from the operator's local environment, and the Supabase / GitHub MCPs are configured through the assistant — not through Signal. That means we cannot infer connection state by reading the Signal process.

The page therefore uses a fixed status vocabulary in `src/core/mcp-operations/connector-status.ts`:

```
not_configured | configured | connected | unavailable | manual | placeholder
```

Until a real probe is wired, every status is **placeholder** or **manual**. The UI says so explicitly. We never render "Connected" unless we can verify it.

## Connectors today

| Key             | Category    | Default state | Why |
| --------------- | ----------- | ------------- | --- |
| `claude_code`   | assistant   | placeholder   | Runs on the operator's machine. |
| `codex`         | assistant   | placeholder   | Same. |
| `claude_opus`   | assistant   | placeholder   | API-key driven; key lives outside Signal. |
| `supabase_mcp`  | data_plane  | placeholder   | Configured via the assistant. |
| `github_mcp`    | vcs         | placeholder   | Same. |
| `vercel`        | deploy_plane| manual        | Vercel is read manually; redeploys are gated separately. |

To replace a `placeholder` with `connected`, write a probe that returns true only when the connector has been observed within the recent window, and update `connector-status.ts` accordingly.

## Honesty rule

A check that does not have a real implementation must:

- mark `wired: false` in `_check-catalog.ts`,
- render the **"Prepared, not connected"** disabled button,
- never call a server action that pretends to succeed.

This is enforced in `_run-check-button.tsx`.

## See also

- [./check-runner.md](./check-runner.md)
- [./operation-approval-ui.md](./operation-approval-ui.md)
- [./mcp-operations-policy.md](./mcp-operations-policy.md)
