# Internal DB probe vs. direct MCP

The Supabase connector card on `/settings/mcp` shows the result of whichever mode actually ran. The two modes verify different things, and the UI labels them differently so the operator can tell them apart.

## What internal_db_probe verifies

- Required Signal tables exist and are reachable from Signal's authenticated session.
- RLS is enabled and prevents cross-workspace reads.
- One read-only PostgREST call against `mcp_operation_runs` returns a 2xx within the timeout.
- The operator can read their own `workspaces` row.

It does **not** verify:

- That the operator's Claude / Codex / Opus instance is connected to the Supabase MCP server.
- That the Supabase MCP server can run `apply_migration`, `list_migrations`, or any privileged tool.
- That there's a working bridge between Signal and the operator's MCP client.

That's why a healthy internal_db_probe still shows up as a **warning** in the verification pipeline rather than a pass: it tells you something about Signal's view of the database, not about the MCP connector.

## What direct_mcp (future) would verify

When a direct MCP bridge is wired, the same probe surface will:

- Call `list_tables` through MCP and compare against the required-tables list.
- Call `list_migrations` through MCP — finally testable, not just "not_tested".
- Call `get_advisors` and surface anything in the report.
- Verify `apply_migration` is reachable *without* invoking it.

A healthy direct_mcp probe would show "Connected" in the UI and pass the `supabase_mcp_probe_check` outright.

## What operator_bridge (future) would verify

Same surface, different transport: the operator's assistant runs the probe externally and posts the structured result back to Signal. The verification pipeline accepts a signed result as a pass.

## Why the warning is a warning

`supabase_mcp_probe_check` returns `warning` (not `fail`) on a healthy `internal_db_probe`. The PR readiness gate doesn't block on it. This is intentional: the project does not require direct MCP to merge.

If a deployment wants to enforce direct-MCP-only, flip `CHECK_BLOCKS_MERGE.supabase_mcp_probe_check` to `true` and require the operator to upgrade to `operator_bridge` or `direct_mcp` before any PR can land.

## See also

- [./supabase-mcp-connector-probe.md](./supabase-mcp-connector-probe.md)
- [./connector-probe-transport.md](./connector-probe-transport.md)
- [./supabase-probe-security.md](./supabase-probe-security.md)
