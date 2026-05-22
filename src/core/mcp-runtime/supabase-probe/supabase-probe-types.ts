/**
 * Phase E2.7 — Supabase probe types.
 *
 * The probe verifies what Signal can reach via its *own* authenticated
 * session (Option C — internal_db_probe). When a real MCP bridge is
 * wired, the mode flips to `direct_mcp` and the same result envelope
 * carries the verdict back.
 *
 * Honesty rule: the `mode` field is the operator's only signal of how
 * the probe was performed. The UI must render the mode and never
 * claim "MCP connected" when the mode is `internal_db_probe`.
 */

import type {
  McpProbeHealth,
  McpProbeMode,
  McpProbeStatus,
} from "@/lib/supabase/types";

export type { McpProbeHealth, McpProbeMode, McpProbeStatus };

export const SUPABASE_PROBE_CAPABILITIES = [
  "list_tables",
  "read_schema_metadata",
  "check_rls_status",
  "list_migrations",
  "read_workspace_tables",
  "readonly_sql_probe",
] as const;
export type SupabaseProbeCapability =
  (typeof SUPABASE_PROBE_CAPABILITIES)[number];

export const SUPABASE_PROBE_CAPABILITY_LABELS: Record<
  SupabaseProbeCapability,
  string
> = {
  list_tables: "List tables",
  read_schema_metadata: "Read schema metadata",
  check_rls_status: "Check RLS status",
  list_migrations: "List migrations",
  read_workspace_tables: "Read workspace-scoped tables",
  readonly_sql_probe: "Run a read-only SQL probe",
};

export const SUPABASE_PROBE_CAPABILITY_VERDICTS = [
  "verified",
  "missing",
  "not_tested",
] as const;
export type SupabaseProbeCapabilityVerdict =
  (typeof SUPABASE_PROBE_CAPABILITY_VERDICTS)[number];

export interface SupabaseProbeCapabilityResults
  extends Record<SupabaseProbeCapability, SupabaseProbeCapabilityVerdict> {}

export interface SupabaseProbeEvidence {
  table_count: number;
  rls_enabled_count: number;
  required_table_count: number;
  required_tables_missing: string[];
  warnings: string[];
}

export interface SupabaseProbeResult {
  connector: "supabase_mcp";
  mode: McpProbeMode;
  status: "healthy" | "degraded" | "failed";
  capabilities: SupabaseProbeCapabilityResults;
  evidence: SupabaseProbeEvidence;
  checked_at: string;
}

/**
 * Tables Signal expects to exist in the public schema. The probe
 * counts present/missing and reports the diff in the evidence block.
 */
export const SUPABASE_PROBE_REQUIRED_TABLES = [
  "workspaces",
  "workspace_members",
  "workspace_settings",
  "products",
  "growth_accounts",
  "activity_events",
  "weekly_plans",
  "weekly_plan_items",
  "approval_events",
  "backlog_items",
  "scheduled_items",
  "risk_events",
  "draft_variants",
  "mcp_operation_runs",
  "weekly_approval_contracts",
  "weekly_contract_accounts",
  "weekly_contract_products",
  "weekly_contract_platforms",
  "weekly_contract_allowed_actions",
  "weekly_contract_execution_windows",
  "execution_authorizations",
  "execution_queues",
  "execution_items",
  "execution_logs",
  "execution_attempts",
  "platform_connections",
  "oauth_state_tokens",
  "mcp_connector_probes",
] as const;
