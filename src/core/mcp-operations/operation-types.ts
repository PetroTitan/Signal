import type { AuditSource } from "./audit-source";

/**
 * Every operation Claude / Codex / MCP-connected tools can perform
 * inside Signal, enumerated and typed. New operations must be added
 * here first; any write that does not map to one of these is rejected
 * at the boundary.
 *
 * The create flow is intentionally split into `_create_pending` (AI
 * proposes a record) and `_confirm` (user accepts it) so the audit
 * trail captures both halves and the user is always the gating step.
 */
export const MCP_OPERATION_TYPES = [
  "product_profile_suggest",
  "product_profile_create_pending",
  "product_profile_confirm",
  "account_profile_suggest",
  "account_profile_create_pending",
  "account_profile_confirm",
  "screenshot_account_import",
  "screenshot_product_import",
  "weekly_plan_suggest",
  "db_integrity_check",
  "rls_check",
  "smoke_test_run",
  "migration_plan_prepare",
  "migration_apply_request",
  "pr_readiness_check",
  "deployment_readiness_check",
  "production_smoke_test",
] as const;

export type McpOperationType = (typeof MCP_OPERATION_TYPES)[number];

export const MCP_OPERATION_LABELS: Record<McpOperationType, string> = {
  product_profile_suggest: "Suggest product profile",
  product_profile_create_pending: "Create product (pending review)",
  product_profile_confirm: "Confirm product",
  account_profile_suggest: "Suggest account profile",
  account_profile_create_pending: "Create account (pending review)",
  account_profile_confirm: "Confirm account",
  screenshot_account_import: "Import account from screenshot",
  screenshot_product_import: "Import product from screenshot",
  weekly_plan_suggest: "Suggest weekly plan",
  db_integrity_check: "Database integrity check",
  rls_check: "RLS policy check",
  smoke_test_run: "Workspace smoke test",
  migration_plan_prepare: "Prepare migration plan",
  migration_apply_request: "Request migration apply",
  pr_readiness_check: "PR readiness check",
  deployment_readiness_check: "Deployment readiness check",
  production_smoke_test: "Production smoke test",
};

export function operationDefaultSource(op: McpOperationType): AuditSource {
  if (op === "screenshot_account_import" || op === "screenshot_product_import") {
    return "screenshot_import";
  }
  return "mcp_operation";
}
