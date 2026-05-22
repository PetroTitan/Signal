/**
 * Phase E2.7 — typed probe errors. Converted to a failed
 * `mcp_connector_probes` row by the runner; never surfaced raw to the
 * UI.
 */

export const SUPABASE_PROBE_ERROR_CODES = [
  "env_missing",
  "auth_missing",
  "connector_unavailable",
  "insufficient_permissions",
  "timeout",
  "schema_mismatch",
  "rls_mismatch",
  "policy_violation",
  "unknown_error",
] as const;
export type SupabaseProbeErrorCode =
  (typeof SUPABASE_PROBE_ERROR_CODES)[number];

export class SupabaseProbeError extends Error {
  constructor(
    public readonly code: SupabaseProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SupabaseProbeError";
  }
}

export const SUPABASE_PROBE_ERROR_MESSAGES: Record<
  SupabaseProbeErrorCode,
  string
> = {
  env_missing: "Supabase env vars are not configured.",
  auth_missing: "No authenticated session to run the probe.",
  connector_unavailable: "Supabase data plane is unreachable.",
  insufficient_permissions: "Probe lacks the permissions it expected.",
  timeout: "Probe timed out before completion.",
  schema_mismatch: "Required tables are missing.",
  rls_mismatch: "RLS is not enabled on a required table.",
  policy_violation: "Probe attempted an operation it is not allowed to run.",
  unknown_error: "Probe failed for an unknown reason.",
};

export function isProbeError(err: unknown): err is SupabaseProbeError {
  return err instanceof SupabaseProbeError;
}
