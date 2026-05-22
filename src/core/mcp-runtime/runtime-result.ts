/**
 * Phase E2.6 — extended CheckResult shape that adds an `evidence`
 * field. The original `CheckResult` in `src/core/verification/
 * check-result.ts` keeps its API for backwards compat; this is the
 * superset the runtime checks return.
 */

import type {
  CheckResult,
  CheckStatus,
} from "@/core/verification";

export type { CheckStatus };

export interface RuntimeCheckResult extends CheckResult {
  /**
   * Structured evidence (file paths read, table counts probed,
   * verdicts derived). Renders under the summary on /settings/mcp.
   * `null` when the check has no useful evidence to attach.
   */
  evidence: Record<string, unknown> | null;
}

export function attachEvidence(
  result: CheckResult,
  evidence: Record<string, unknown> | null,
): RuntimeCheckResult {
  return { ...result, evidence };
}
