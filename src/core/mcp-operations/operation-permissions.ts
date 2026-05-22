import type { McpOperationType } from "./operation-types";

/**
 * Five-level risk model. Every operation maps to exactly one. Used by
 * `assertOperationAllowed` to decide whether to run, gate, or refuse.
 *
 *   safe_read           — read-only inspection. No DB writes, no I/O
 *                         that touches an external service in a
 *                         user-visible way.
 *   local_write         — writes to the local working tree only
 *                         (files, drafts, prepared migrations). No
 *                         remote effects.
 *   remote_write        — writes to remote systems (Supabase, GitHub
 *                         branches, Vercel preview env, etc.) that
 *                         are reversible.
 *   production_impacting — touches production data, merges PRs,
 *                         redeploys production, or marks a record
 *                         confirmed-and-usable.
 *   blocked             — never executes from MCP. Listed so the
 *                         policy is self-documenting in code.
 */
export const RISK_LEVELS = [
  "safe_read",
  "local_write",
  "remote_write",
  "production_impacting",
  "blocked",
] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Approval mode the runner enforces before executing an operation.
 *
 *   no_approval_needed                — operation runs immediately.
 *   approval_required                  — the operation lands in
 *                                        `pending_approval`, the user
 *                                        clicks Approve, then it runs.
 *   explicit_text_confirmation_required — same as above but the user
 *                                        must type a confirmation
 *                                        phrase (e.g. project name).
 *                                        Reserved for the most
 *                                        destructive ops.
 *   blocked                            — never offered to the user.
 *                                        The runner refuses to even
 *                                        record an attempt.
 */
export const APPROVAL_MODES = [
  "no_approval_needed",
  "approval_required",
  "explicit_text_confirmation_required",
  "blocked",
] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const ALLOWED_ENVIRONMENTS = [
  "any",
  "local_only",
  "preview_or_production",
  "production_only",
] as const;
export type AllowedEnvironment = (typeof ALLOWED_ENVIRONMENTS)[number];

/**
 * Full permission record for a single operation type.
 */
export interface OperationPermission {
  operationType: McpOperationType;
  riskLevel: RiskLevel;
  approvalMode: ApprovalMode;
  allowedEnvironment: AllowedEnvironment;
  reversible: boolean;
  writesDatabase: boolean;
  /** Writes files in the repository working tree. */
  writesRepository: boolean;
  /** Touches production (merge, redeploy, confirmed data). */
  touchesProduction: boolean;
  /** True when the operation cannot run without a connected MCP tool
   *  (e.g. supabase MCP for apply_migration). Locally-runnable ops
   *  like running `npm run lint` are false. */
  requiresMcpTool: boolean;
  /** What the operation is expected to produce — used to inform the
   *  runner whether the result should land in mcp_operation_runs as
   *  a structured report. */
  expectedReport:
    | "boolean"
    | "summary"
    | "checks_list"
    | "extraction"
    | "pr_text"
    | "migration_plan"
    | "none";
}

const P = (
  operationType: McpOperationType,
  riskLevel: RiskLevel,
  approvalMode: ApprovalMode,
  partial: Partial<OperationPermission>,
): OperationPermission => ({
  operationType,
  riskLevel,
  approvalMode,
  allowedEnvironment: "any",
  reversible: true,
  writesDatabase: false,
  writesRepository: false,
  touchesProduction: false,
  requiresMcpTool: false,
  expectedReport: "summary",
  ...partial,
});

/**
 * The canonical permission table. Any change to what an operation may
 * do goes here; the runner reads from this single source of truth.
 */
export const OPERATION_PERMISSIONS: Record<McpOperationType, OperationPermission> = {
  // ── Read-only suggestions (no DB writes) ───────────────────────────
  product_profile_suggest: P(
    "product_profile_suggest",
    "safe_read",
    "no_approval_needed",
    { expectedReport: "extraction" },
  ),
  account_profile_suggest: P(
    "account_profile_suggest",
    "safe_read",
    "no_approval_needed",
    { expectedReport: "extraction" },
  ),
  weekly_plan_suggest: P(
    "weekly_plan_suggest",
    "safe_read",
    "no_approval_needed",
    { expectedReport: "summary" },
  ),

  // ── Diagnostics ────────────────────────────────────────────────────
  smoke_test_run: P("smoke_test_run", "safe_read", "no_approval_needed", {
    expectedReport: "checks_list",
  }),
  db_integrity_check: P(
    "db_integrity_check",
    "safe_read",
    "no_approval_needed",
    {
      requiresMcpTool: true,
      expectedReport: "checks_list",
    },
  ),
  rls_check: P("rls_check", "safe_read", "no_approval_needed", {
    requiresMcpTool: true,
    expectedReport: "checks_list",
  }),
  pr_readiness_check: P(
    "pr_readiness_check",
    "safe_read",
    "no_approval_needed",
    { expectedReport: "checks_list" },
  ),
  deployment_readiness_check: P(
    "deployment_readiness_check",
    "safe_read",
    "no_approval_needed",
    { expectedReport: "checks_list" },
  ),
  production_smoke_test: P(
    "production_smoke_test",
    "safe_read",
    "no_approval_needed",
    {
      allowedEnvironment: "preview_or_production",
      expectedReport: "checks_list",
    },
  ),

  // ── Local writes (drafts, prepared plans) ──────────────────────────
  migration_plan_prepare: P(
    "migration_plan_prepare",
    "local_write",
    "no_approval_needed",
    {
      writesRepository: true,
      expectedReport: "migration_plan",
    },
  ),

  // ── Remote writes ──────────────────────────────────────────────────
  screenshot_account_import: P(
    "screenshot_account_import",
    "remote_write",
    "approval_required",
    {
      writesDatabase: true,
      expectedReport: "summary",
    },
  ),
  screenshot_product_import: P(
    "screenshot_product_import",
    "remote_write",
    "approval_required",
    {
      writesDatabase: true,
      expectedReport: "summary",
    },
  ),
  product_profile_create_pending: P(
    "product_profile_create_pending",
    "remote_write",
    "approval_required",
    {
      writesDatabase: true,
      expectedReport: "summary",
    },
  ),
  account_profile_create_pending: P(
    "account_profile_create_pending",
    "remote_write",
    "approval_required",
    {
      writesDatabase: true,
      expectedReport: "summary",
    },
  ),

  // ── Production-impacting (confirmed writes, applied migrations) ─────
  product_profile_confirm: P(
    "product_profile_confirm",
    "production_impacting",
    "approval_required",
    {
      writesDatabase: true,
      touchesProduction: true,
      expectedReport: "summary",
    },
  ),
  account_profile_confirm: P(
    "account_profile_confirm",
    "production_impacting",
    "approval_required",
    {
      writesDatabase: true,
      touchesProduction: true,
      expectedReport: "summary",
    },
  ),
  migration_apply_request: P(
    "migration_apply_request",
    "production_impacting",
    "explicit_text_confirmation_required",
    {
      requiresMcpTool: true,
      touchesProduction: true,
      writesDatabase: true,
      reversible: false,
      expectedReport: "migration_plan",
    },
  ),
};

export function getPermission(op: McpOperationType): OperationPermission {
  return OPERATION_PERMISSIONS[op];
}

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  safe_read: "Safe read",
  local_write: "Local write",
  remote_write: "Remote write",
  production_impacting: "Production impacting",
  blocked: "Blocked",
};

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  no_approval_needed: "No approval needed",
  approval_required: "Approval required",
  explicit_text_confirmation_required: "Explicit confirmation required",
  blocked: "Blocked",
};
