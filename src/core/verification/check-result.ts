/**
 * Phase E2.5 — verification check result envelope.
 *
 * Every check returns the same shape so the aggregator and the UI
 * don't need to know which check produced the row.
 */

export const CHECK_STATUSES = ["pass", "warning", "fail"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CheckResult {
  /** Canonical key (snake_case). Mirrors mcp-operations operation type
   *  when one exists. */
  check: string;
  label: string;
  status: CheckStatus;
  summary: string;
  /** Bulleted detail lines for the UI. Avoid logging secrets. */
  details: string[];
  /** True when the caller needs to act (set env, run migration, etc.) */
  requiresUserAction: boolean;
  /** Optional discriminator used by the PR-readiness gate. */
  blocksMerge?: boolean;
  durationMs: number;
}

export function pass(input: {
  check: string;
  label: string;
  summary: string;
  details?: string[];
  durationMs: number;
  blocksMerge?: boolean;
}): CheckResult {
  return {
    check: input.check,
    label: input.label,
    status: "pass",
    summary: input.summary,
    details: input.details ?? [],
    requiresUserAction: false,
    blocksMerge: input.blocksMerge ?? false,
    durationMs: input.durationMs,
  };
}

export function warn(input: {
  check: string;
  label: string;
  summary: string;
  details?: string[];
  durationMs: number;
  requiresUserAction?: boolean;
  blocksMerge?: boolean;
}): CheckResult {
  return {
    check: input.check,
    label: input.label,
    status: "warning",
    summary: input.summary,
    details: input.details ?? [],
    requiresUserAction: input.requiresUserAction ?? false,
    blocksMerge: input.blocksMerge ?? false,
    durationMs: input.durationMs,
  };
}

export function fail(input: {
  check: string;
  label: string;
  summary: string;
  details?: string[];
  durationMs: number;
  requiresUserAction?: boolean;
  blocksMerge?: boolean;
}): CheckResult {
  return {
    check: input.check,
    label: input.label,
    status: "fail",
    summary: input.summary,
    details: input.details ?? [],
    requiresUserAction: input.requiresUserAction ?? true,
    blocksMerge: input.blocksMerge ?? true,
    durationMs: input.durationMs,
  };
}

export interface VerificationReport {
  runId: string;
  verificationRunId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: CheckResult[];
  prVerdict: PrReadinessVerdict;
}

export const PR_VERDICTS = ["ready_to_merge", "needs_review", "blocked"] as const;
export type PrReadinessVerdict = (typeof PR_VERDICTS)[number];

export interface PrReadinessSummary {
  verdict: PrReadinessVerdict;
  blockers: string[];
  warnings: string[];
}
