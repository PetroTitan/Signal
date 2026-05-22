import type { McpOperationType } from "@/core/mcp-operations";

/**
 * Catalog of MCP checks the operator can invoke from /settings/mcp.
 *
 * Phase E2.5 wires real implementations for env / auth / rls /
 * db_integrity / route_protection / demo_boundary / production_smoke /
 * the end-to-end dry-run pipeline. Anything still unwired keeps
 * `wired: false` and renders as a disabled "Prepared, not connected"
 * button.
 */
export interface McpCheckDef {
  key: string;
  label: string;
  description: string;
  /** Which operation type the runner records on mcp_operation_runs. */
  operationType: McpOperationType | null;
  wired: boolean;
}

export const MCP_CHECKS: McpCheckDef[] = [
  {
    key: "smoke_test_run",
    label: "Workspace smoke test",
    description:
      "Reads workspace, products, accounts, and activity rows under the current user's session. No writes.",
    operationType: "smoke_test_run",
    wired: true,
  },
  {
    key: "env_check",
    label: "Environment check",
    description:
      "Verifies Supabase env vars resolve and the URL is valid. Reports OAuth + token-encryption configuration.",
    operationType: null,
    wired: true,
  },
  {
    key: "auth_check",
    label: "Auth check",
    description:
      "Confirms the session cookie is valid and the user has a workspace membership.",
    operationType: null,
    wired: true,
  },
  {
    key: "db_integrity_check",
    label: "Database integrity check",
    description:
      "Counts workspace-scoped rows and probes execution_items for orphaned queue or contract references.",
    operationType: "db_integrity_check",
    wired: true,
  },
  {
    key: "rls_check",
    label: "RLS check",
    description:
      "Probes every workspace-scoped table; refuses to pass if any row's workspace_id leaks across the membership boundary.",
    operationType: "rls_check",
    wired: true,
  },
  {
    key: "route_protection_check",
    label: "Route protection check",
    description:
      "Static check that middleware fails closed on missing env and redirects unauthenticated requests to /login.",
    operationType: null,
    wired: true,
  },
  {
    key: "demo_boundary_check",
    label: "Demo boundary check",
    description:
      "Confirms the engine safety envelope refuses demo workspaces and that the contract evaluator returns demo_mode_blocked.",
    operationType: null,
    wired: true,
  },
  {
    key: "oauth_safety_check",
    label: "OAuth safety check",
    description:
      "Static-analysis probe: no publishing scopes, no token leakage in domain types, cipher gate present, state tokens one-shot, disconnect clears tokens.",
    operationType: null,
    wired: true,
  },
  {
    key: "execution_safety_check",
    label: "Execution safety check",
    description:
      "Verifies the engine refuses without active contract, external_publish is hard-blocked, dry-run declares no external calls, logs are append-only.",
    operationType: null,
    wired: true,
  },
  {
    key: "weekly_contract_check",
    label: "Weekly contract check",
    description:
      "Verifies the contract evaluator covers every reason code, gates on demo mode, and soft-blocks paused contracts.",
    operationType: null,
    wired: true,
  },
  {
    key: "supabase_mcp_probe_check",
    label: "Supabase MCP probe",
    description:
      "Reads the data plane through Signal's authenticated session (internal_db_probe mode). Verifies tables, RLS, and read-only SQL — never claims direct MCP unless the bridge is wired.",
    operationType: null,
    wired: true,
  },
  {
    key: "execution_dry_run_smoke",
    label: "End-to-end execution dry-run",
    description:
      "Walks product → account → plan item → contract → queue → item → authorize → dry-run, then cleans up. Tagged with a verification_run_id.",
    operationType: null,
    wired: true,
  },
  {
    key: "pr_readiness_check",
    label: "PR readiness check",
    description:
      "Aggregates the other checks into a ready_to_merge / needs_review / blocked verdict. Runs as part of the full pipeline.",
    operationType: "pr_readiness_check",
    wired: false,
  },
  {
    key: "production_smoke_test",
    label: "Production smoke test checklist",
    description:
      "Read-only probe of preview / production endpoints. Read-only by contract.",
    operationType: "production_smoke_test",
    wired: false,
  },
];
