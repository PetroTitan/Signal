# Supabase MCP connector probe

Phase E2.7 turns the Supabase connector status from a placeholder into a real, verifiable probe. The probe runs in **internal_db_probe** mode by default — Signal verifies the data plane through its *own* authenticated session, not through a direct MCP bridge. The UI labels the mode honestly so the operator can tell what they're looking at.

## What the probe verifies

Five capabilities:

| Capability | Verified by |
| --- | --- |
| `list_tables` | Head-select on every required table. |
| `read_schema_metadata` | Same probe; degraded if anything is missing. |
| `check_rls_status` | Selecting from `activity_events` and asserting every `workspace_id` matches the operator's workspace. RLS leak ⇒ missing. |
| `list_migrations` | `not_tested` — `supabase_migrations.schema_migrations` is not exposed to authenticated users. Honest, not a fake pass. |
| `read_workspace_tables` | Select the operator's own `workspaces` row. |
| `readonly_sql_probe` | Single head-select against `mcp_operation_runs`. |

## What the probe refuses to do

- Destructive SQL.
- Service-role-key access.
- Reading the `auth` schema.
- Selecting encrypted token columns (`access_token_encrypted` / `refresh_token_encrypted`).
- Selecting any column whose name contains `secret`, `password`, or `token`.
- Cross-workspace reads.
- Unrestricted SQL.

These are listed in `src/core/mcp-runtime/supabase-probe/supabase-probe-policy.ts` and surfaced on `/settings/mcp`.

## How to run

`/settings/mcp` has a **Run Supabase probe** button at the top of the Supabase card. Clicking it:

1. Opens an `mcp_operation_runs` row (status `running`).
2. Opens a `mcp_connector_probes` row (status `running`, mode `internal_db_probe`).
3. Runs the five capability checks under a per-query timeout (`SUPABASE_PROBE_QUERY_TIMEOUT_MS`, 8 s).
4. Updates the probe row with capability results, health, and evidence.
5. Closes the `mcp_operation_runs` row with `completed` or `failed`.
6. Writes a `mcp.supabase_probe_completed` (or `mcp.supabase_probe_failed`) activity event.

The card then re-renders with the new status, mode label, and per-capability verdicts.

## Status label policy

The probe never claims "MCP connected" when running in `internal_db_probe` mode. Labels:

| Mode | Healthy | Degraded | Failed |
| --- | --- | --- | --- |
| `internal_db_probe` | DB probe healthy | DB probe degraded | DB probe failed |
| `operator_bridge` | MCP probe healthy (operator bridge) | MCP probe degraded (operator bridge) | MCP probe degraded (operator bridge) |
| `direct_mcp` | Connected | Degraded | Failed |

## See also

- [./connector-probe-transport.md](./connector-probe-transport.md)
- [./supabase-probe-security.md](./supabase-probe-security.md)
- [./internal-db-probe-vs-mcp.md](./internal-db-probe-vs-mcp.md)
- [./real-mcp-runtime-integration.md](./real-mcp-runtime-integration.md)
