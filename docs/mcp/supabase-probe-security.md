# Supabase probe security

The Supabase MCP probe is a *verification* surface, not a database console. The security boundary is encoded in `src/core/mcp-runtime/supabase-probe/supabase-probe-policy.ts` and enforced by the runner in `src/repositories/mcp-connectors/supabase-mcp-connector.ts`.

## Hard guarantees

1. **No service-role key.** The probe uses `createSupabaseServerClient`, the same authenticated session every other server action uses. There is no code path that imports a service-role key.
2. **No raw SQL.** All queries go through PostgREST's typed client. No string concatenation, no template literals, no `rpc('execute_sql', …)`.
3. **No destructive operations.** The probe never issues `insert` / `update` / `delete` / `drop` / `alter`. Adding one is a regression caught by the `oauth_safety_check` + manual review.
4. **No secret column reads.** The required-tables list omits the `auth` schema; encrypted-token columns are projected away by the repository layer and the probe never selects them.
5. **No cross-workspace reads.** Every probe query filters by the operator's workspace where the table has a `workspace_id`; the RLS check itself asserts the boundary.
6. **No timeouts past `SUPABASE_PROBE_QUERY_TIMEOUT_MS` (8 s) per call.** Total probe wall time is capped at `SUPABASE_PROBE_TOTAL_TIMEOUT_MS` (30 s).

## What the probe touches

| Table | Operation | Reason |
| --- | --- | --- |
| every required table | `select('*', { head: true, count: 'exact' }).limit(0)` | Table presence check, no rows fetched. |
| `activity_events` | `select('workspace_id').limit(20)` | RLS leak detection. |
| `workspaces` | `select('id').eq('id', wid).limit(1)` | Confirm the operator can read their own row. |
| `mcp_operation_runs` | `select('id', { head: true, count: 'exact' }).limit(0)` | Read-only SQL smoke. |
| `mcp_connector_probes` | `insert` / `update` (own row) | Records the probe attempt itself. |
| `activity_events` | `insert` | Writes the activity event. |
| `mcp_operation_runs` | `insert` / `update` (own row) | Records the operation run for the probe. |

## What the probe refuses

- `destructive_sql` — INSERT / UPDATE / DELETE on arbitrary tables.
- `service_role_access` — using the service-role key.
- `token_read` — selecting `access_token_encrypted` / `refresh_token_encrypted` / similar.
- `auth_user_dump` — any read of `auth.users` or other `auth.*` tables.
- `secret_read` — columns whose name contains `secret`, `password`, or `token`.
- `unrestricted_sql` — caller-supplied SQL strings.

These are listed in `SUPABASE_PROBE_REFUSED_CAPABILITIES` and surface to the operator as the "Blocked" section of the probe documentation page.

## Audit

Every probe attempt produces:

- One `mcp_connector_probes` row (workspace-scoped, append-friendly history).
- One `mcp_operation_runs` row (so the probe is in the operator's audit trail alongside every other operation).
- One activity event (`mcp.supabase_probe_completed` or `mcp.supabase_probe_failed`).

The probe never logs any value from a table cell beyond `workspace_id` (used in RLS check) and table presence counts.

## See also

- [./supabase-mcp-connector-probe.md](./supabase-mcp-connector-probe.md)
- [./internal-db-probe-vs-mcp.md](./internal-db-probe-vs-mcp.md)
- [./real-mcp-runtime-integration.md](./real-mcp-runtime-integration.md)
