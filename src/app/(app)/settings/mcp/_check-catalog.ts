import type { McpOperationType } from "@/core/mcp-operations";

/**
 * Catalog of MCP checks the operator can invoke from /settings/mcp.
 * Each entry maps to either an `McpOperationType` (when wired) or
 * a documentation-only stub.
 *
 * Honest UI rule: if `wired` is false, the button is disabled and
 * labeled "Prepared, not connected". No check is allowed to fake a
 * success.
 */
export interface McpCheckDef {
  key: string;
  label: string;
  description: string;
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
      "Verifies Supabase env vars resolve and the URL is reachable from this runtime.",
    operationType: null,
    wired: false,
  },
  {
    key: "auth_check",
    label: "Auth check",
    description:
      "Confirms the session cookie is valid and the user has a workspace membership.",
    operationType: null,
    wired: false,
  },
  {
    key: "db_integrity_check",
    label: "Database integrity check",
    description:
      "Walks foreign keys and constraints on workspace-scoped tables; reports orphans and inconsistencies.",
    operationType: "db_integrity_check",
    wired: false,
  },
  {
    key: "rls_check",
    label: "RLS check",
    description:
      "Probes every workspace-scoped table to confirm RLS is enabled and the policies match expectations.",
    operationType: "rls_check",
    wired: false,
  },
  {
    key: "route_protection_check",
    label: "Route protection check",
    description:
      "Verifies middleware rejects unauthenticated requests on every /(app) route.",
    operationType: null,
    wired: false,
  },
  {
    key: "demo_boundary_check",
    label: "Demo boundary check",
    description:
      "Confirms demo workspaces never authorize execution and demo data never leaks into real reads.",
    operationType: null,
    wired: false,
  },
  {
    key: "pr_readiness_check",
    label: "PR readiness check",
    description:
      "Runs lint, typecheck, and build locally; surfaces uncommitted files and missing tests.",
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
