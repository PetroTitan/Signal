/**
 * Phase E2.7 — labels + grouping for the probe capability matrix.
 */

import type { SupabaseProbeCapability } from "./supabase-probe-types";

export interface CapabilityCategory {
  label: string;
  capabilities: SupabaseProbeCapability[];
}

export const SUPABASE_PROBE_CATEGORIES: CapabilityCategory[] = [
  {
    label: "Schema",
    capabilities: ["list_tables", "read_schema_metadata", "list_migrations"],
  },
  {
    label: "Safety",
    capabilities: ["check_rls_status", "read_workspace_tables"],
  },
  {
    label: "Reachability",
    capabilities: ["readonly_sql_probe"],
  },
];

/**
 * Capabilities the probe *will not even attempt*. They are listed here
 * so the UI can render the boundary explicitly.
 */
export const SUPABASE_PROBE_REFUSED_CAPABILITIES = [
  "destructive_sql",
  "service_role_access",
  "token_read",
  "auth_user_dump",
  "secret_read",
  "unrestricted_sql",
] as const;
export type SupabaseProbeRefusedCapability =
  (typeof SUPABASE_PROBE_REFUSED_CAPABILITIES)[number];

export const SUPABASE_PROBE_REFUSED_CAPABILITY_REASONS: Record<
  SupabaseProbeRefusedCapability,
  string
> = {
  destructive_sql: "Writes are out of scope for the probe.",
  service_role_access: "Service-role key is never used by Signal.",
  token_read: "Encrypted token columns are projected away by the repository.",
  auth_user_dump: "Reading the auth schema is forbidden.",
  secret_read: "Columns matching secret/password/token are never selected.",
  unrestricted_sql: "Probe only runs fixed, audited statements.",
};
