import type {
  CheckResult,
  PrReadinessSummary,
} from "./check-result";

/**
 * Phase E2.5 — derive a single ship-readiness verdict from the
 * collected check results.
 *
 * Rules (see docs/mcp/pr-readiness-gate.md):
 *
 *   blocked         — any check is `fail` with blocksMerge=true.
 *                     Includes: auth_check, rls_check, db_integrity_check,
 *                     route_protection_check, demo_boundary_check,
 *                     execution_dry_run_smoke (E2E).
 *
 *   needs_review    — at least one `warning` requires user action, OR
 *                     any non-blocking `fail`.
 *
 *   ready_to_merge  — everything is `pass`.
 */
export function summarizePrReadiness(
  results: ReadonlyArray<CheckResult>,
): PrReadinessSummary {
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const r of results) {
    if (r.status === "fail" && (r.blocksMerge ?? true)) {
      blockers.push(`${r.label}: ${r.summary}`);
    } else if (r.status === "fail") {
      warnings.push(`${r.label}: ${r.summary}`);
    } else if (r.status === "warning") {
      warnings.push(`${r.label}: ${r.summary}`);
    }
  }

  if (blockers.length > 0) {
    return { verdict: "blocked", blockers, warnings };
  }
  if (warnings.length > 0) {
    return { verdict: "needs_review", blockers, warnings };
  }
  return { verdict: "ready_to_merge", blockers, warnings };
}
