# Connector probe transport

The `mcp_connector_probes` table is generic across connector kinds and supports three transport modes via the `mode` column. Each row's mode declares how the probe was actually performed.

## direct_mcp

Signal calls a real MCP bridge endpoint that fronts the connector. The bridge runs allowed operations (list_tables, list_migrations, etc.) and returns structured results.

**Status:** not implemented. The runtime types and DB column are in place; no transport code exists yet.

**When this lands**, the `runSupabaseDataPlaneProbe` runner gains a sibling that issues HTTP calls to the bridge instead of PostgREST. The result shape stays identical — `mode='direct_mcp'` is the only visible difference, and the UI flips from "DB probe healthy" to "Connected".

## operator_bridge

The operator's connected assistant (Claude Code / Codex / Opus) runs the probe externally, then posts a signed result back to Signal. The Signal side validates the signature / operation id and stamps the row.

**Status:** not implemented. Useful in environments where Signal cannot reach the MCP transport but the operator can.

**When this lands**, we need:

1. A signed-result inbox endpoint (`POST /api/mcp/probe-result`) that requires both the operator's session and a per-probe HMAC.
2. A short-lived nonce baked into the `mcp_connector_probes` row at open time.
3. The same `SupabaseProbeResult` shape posted back — the validator writes it through `completeProbe`.

## internal_db_probe (Phase E2.7 default)

Signal uses its existing authenticated Supabase session and verifies what the data plane looks like from the inside. The probe issues fixed PostgREST queries (no SQL string building), times them out per call, and reports honest results.

The probe is intentionally narrow:

- Reads only known tables listed in `SUPABASE_PROBE_REQUIRED_TABLES`.
- Asserts RLS by selecting `workspace_id` and checking the cross-workspace boundary.
- Never reads the `auth` schema.
- Never touches encrypted-token columns.
- Treats `list_migrations` as `not_tested` rather than faking a pass.

**This is what runs today** when the operator clicks **Run Supabase probe**.

## Why three modes

A single probe surface that supports all three transports lets the same UI render the same evidence regardless of how the probe ran. When the direct bridge ships, no UI change is required — only the runner and the mode label.

## See also

- [./supabase-mcp-connector-probe.md](./supabase-mcp-connector-probe.md)
- [./internal-db-probe-vs-mcp.md](./internal-db-probe-vs-mcp.md)
- [./supabase-probe-security.md](./supabase-probe-security.md)
