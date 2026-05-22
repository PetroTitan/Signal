/**
 * Phase E2 execution policy — what the runner may and may not do.
 *
 * The policy is *strictly narrower* than the weekly contract. The
 * contract describes the envelope; this policy describes the runner's
 * current capabilities inside it. Today the runner only does dry-run
 * evaluation.
 */

export const EXECUTION_POLICY_ALLOWED = [
  "Evaluate execution authorization against the active weekly contract.",
  "Persist `allowed` / `soft_block` / `hard_block` decisions to execution_authorizations.",
  "Update execution_items through the documented state machine.",
  "Append rows to execution_logs and execution_attempts.",
  "Run dry-run actions that describe what would have happened.",
  "Convert approved weekly_plan_items into execution_items.",
] as const;

export const EXECUTION_POLICY_REQUIRES_APPROVAL = [
  "Activate or revoke a weekly contract.",
  "Authorize an execution item (operator confirms or runs the dry-run flow).",
  "Move an item out of `backlogged` back into the live queue.",
] as const;

export const EXECUTION_POLICY_BLOCKED = [
  "Calling any external platform API (Reddit, X, LinkedIn, etc.).",
  "OAuth or password-based platform login.",
  "Browser-automation publishing.",
  "Auto-commenting on external platforms.",
  "AI freeform execution outside the declared action types.",
  "Background cron / scheduled jobs without operator approval.",
  "Payment / billing changes.",
] as const;

export const EXECUTION_POLICY_HARD_GUARANTEES = [
  "No active contract = no execution.",
  "No `allowed` authorization row = no execution.",
  "No confirmed plan item = no execution.",
  "No external platform calls.",
  "No silent failures — every attempt writes an execution_attempts row.",
  "No raw errors in the UI — repositories throw `RepositoryError` and actions return `ActionResult`.",
  "Every denial logs *why* in execution_logs with the matching reason code.",
] as const;
