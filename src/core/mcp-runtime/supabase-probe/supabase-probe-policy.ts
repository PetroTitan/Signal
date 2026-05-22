/**
 * Phase E2.7 — Supabase probe policy.
 *
 * The probe is *not* a database console. These are the rules the
 * probe enforces unconditionally — they are not configurable.
 */

export const SUPABASE_PROBE_ALLOWED = [
  "List tables in the public schema.",
  "Read schema metadata for known Signal tables.",
  "Verify RLS is enabled on workspace-scoped tables.",
  "Count the operator's workspace rows in safe tables.",
  "Run a single read-only SELECT against an audited table to verify reachability.",
] as const;

export const SUPABASE_PROBE_BLOCKED = [
  "Destructive SQL (INSERT / UPDATE / DELETE / DROP / ALTER / TRUNCATE).",
  "Service-role-key access.",
  "Reading raw OAuth tokens, including encrypted columns.",
  "auth.users dumps or any read of the `auth` schema.",
  "Cross-workspace reads.",
  "Bypassing RLS.",
  "Reading any column whose name contains `secret`, `password`, or `token`.",
] as const;

export const SUPABASE_PROBE_HARD_GUARANTEES = [
  "No service-role key is ever used.",
  "Every query the probe issues runs as the authenticated session.",
  "Every query is bounded by a timeout.",
  "Every probe attempt writes an mcp_connector_probes row.",
  "Every probe attempt writes an activity event.",
  "Probe results never include token values, even when the probe touches platform_connections.",
] as const;

/**
 * Per-query timeout. The probe is a fast sanity check; any individual
 * SQL call is canceled past this many milliseconds and the capability
 * marked `missing` with reason `timeout`.
 */
export const SUPABASE_PROBE_QUERY_TIMEOUT_MS = 8_000;

/**
 * Whole-probe timeout. The /settings/mcp UI fails closed if the probe
 * has not completed within this window.
 */
export const SUPABASE_PROBE_TOTAL_TIMEOUT_MS = 30_000;
