/**
 * Phase E2.6 — what the MCP runtime may and may not do.
 *
 * These are policy strings the UI renders and the runner enforces.
 * Editing this list is a policy decision, not a code change.
 */

export const RUNTIME_POLICY_ALLOWED = [
  "Verify connector readiness (probe whatever Signal can probe).",
  "Run safe_read checks (env, auth, RLS, DB integrity, route protection, demo boundary, OAuth safety, execution safety, weekly contract).",
  "Open mcp_operation_runs rows and append output summaries.",
  "Walk the end-to-end execution dry-run pipeline with tagged test data.",
  "Prepare imports and produce confidence-scored field maps (when AI extraction is wired).",
  "Compute PR readiness verdicts.",
] as const;

export const RUNTIME_POLICY_REQUIRES_APPROVAL = [
  "Apply Supabase migrations to the remote project.",
  "Write confirmed product or account data (vs. pending_review).",
  "Push a branch to origin.",
  "Open a pull request.",
  "Promote a screenshot-imported record from pending_review to confirmed.",
  "Enable scheduled execution of a weekly plan.",
] as const;

export const RUNTIME_POLICY_PRODUCTION_IMPACTING = [
  "Merge a pull request.",
  "Trigger a production redeploy.",
  "Enable live execution (flip workspace_settings.execution_mode = 'live').",
  "Publish externally on any platform (Reddit / X / LinkedIn).",
] as const;

export const RUNTIME_POLICY_NEVER = [
  "Autonomous publishing.",
  "External social account creation.",
  "Browser automation for social platforms.",
  "Platform login automation.",
  "Password / cookie / session / 2FA / recovery-code handling.",
  "Service-role key exposure to the client.",
  "Unapproved production mutation.",
  "Bypassing weekly contracts.",
] as const;

/**
 * Explicit-text confirmation phrase the operator must type to approve a
 * production-impacting operation. The phrase is deterministic so the
 * operator can't approve the wrong run by accident.
 */
export function productionApprovalPhrase(operationRunId: string): string {
  return `approve production operation ${operationRunId}`;
}
