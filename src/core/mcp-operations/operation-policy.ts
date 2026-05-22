import {
  getPermission,
  type ApprovalMode,
  type RiskLevel,
} from "./operation-permissions";
import type { McpOperationType } from "./operation-types";

/**
 * Human-readable summaries of the policy boundary. Used by the
 * /settings/mcp page and the docs.
 */
export const MCP_POLICY_ALLOWED_NO_APPROVAL = [
  "Inspect repository contents and types.",
  "Read Supabase schema, RLS policies, and row counts via MCP.",
  "Run lint / typecheck / build locally.",
  "Suggest product or account fields from a prompt or screenshot.",
  "Prepare draft code, draft docs, draft migration files.",
  "Run smoke tests, DB integrity checks, RLS checks, PR-readiness checks.",
] as const;

export const MCP_POLICY_REQUIRES_APPROVAL = [
  "Apply Supabase migrations to the remote project.",
  "Modify production data.",
  "Push commits to a remote branch.",
  "Open or merge a pull request.",
  "Trigger a production redeploy.",
  "Promote a screenshot-imported account or product from pending_review to confirmed.",
  "Enable scheduled execution of a weekly plan.",
] as const;

export const MCP_POLICY_BLOCKED = [
  "Create external social accounts on the user's behalf.",
  "Log into Reddit / X / LinkedIn through any browser-automation path.",
  "Store passwords, cookies, session tokens, 2FA codes, or recovery codes.",
  "Bypass platform safety systems (no anti-detect, no fingerprint spoofing, no proxy rotation).",
  "Publish, post, or comment without an explicit approved workflow.",
  "Modify payment or billing configuration.",
  "Read or use the Supabase service-role key from the client.",
] as const;

/**
 * Caller-supplied context that may relax some defaults.
 */
export interface OperationContext {
  /** Set when the user has already confirmed the extracted fields in
   *  the import UI. Lets the runner skip the default
   *  `pending_review` state. */
  confirmedByUser: boolean;
}

/**
 * Typed error raised by policy assertions.
 */
export class OperationPolicyError extends Error {
  constructor(
    message: string,
    public readonly operationType: McpOperationType,
    public readonly code:
      | "blocked"
      | "needs_confirmation"
      | "no_workspace"
      | "unsupported",
  ) {
    super(message);
    this.name = "OperationPolicyError";
  }
}

/**
 * Returns the review_status a write-side operation should attach to
 * the persisted record. Defaults to `pending_review` so the user is
 * always the gating step.
 */
export function assertConfirmationOrPending(
  _operationType: McpOperationType,
  ctx: OperationContext,
): "confirmed" | "pending_review" {
  return ctx.confirmedByUser ? "confirmed" : "pending_review";
}

/**
 * Convenience summary used by docs and the /settings/mcp surface.
 */
export interface OperationSummary {
  operationType: McpOperationType;
  riskLevel: RiskLevel;
  approvalMode: ApprovalMode;
  reversible: boolean;
  touchesProduction: boolean;
}

export function summarizeOperation(op: McpOperationType): OperationSummary {
  const p = getPermission(op);
  return {
    operationType: p.operationType,
    riskLevel: p.riskLevel,
    approvalMode: p.approvalMode,
    reversible: p.reversible,
    touchesProduction: p.touchesProduction,
  };
}
