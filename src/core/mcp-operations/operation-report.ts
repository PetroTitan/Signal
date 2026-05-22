/**
 * Shape every automated check returns. The check runner aggregates
 * these into `OperationCheckReport` and persists a summary in
 * `mcp_operation_runs.metadata`.
 */
export type CheckStatus = "pass" | "warning" | "fail";

export const CHECK_NAMES = [
  "env_check",
  "auth_check",
  "rls_check",
  "migration_check",
  "route_render_check",
  "repo_build_check",
  "db_integrity_check",
  "demo_boundary_check",
  "no_secret_leak_check",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export interface CheckResult {
  check: CheckName | string;
  status: CheckStatus;
  summary: string;
  details: string[];
  requiresUserAction: boolean;
  durationMs?: number;
}

export interface OperationCheckReport {
  allPass: boolean;
  startedAt: string;
  durationMs: number;
  checks: CheckResult[];
  /** Count by status — convenient for summary copy. */
  totals: { pass: number; warning: number; fail: number };
}

export function aggregateChecks(
  checks: CheckResult[],
  startedAt: string,
  durationMs: number,
): OperationCheckReport {
  const totals = checks.reduce(
    (acc, c) => {
      acc[c.status] += 1;
      return acc;
    },
    { pass: 0, warning: 0, fail: 0 },
  );
  return {
    allPass: totals.fail === 0,
    startedAt,
    durationMs,
    checks,
    totals,
  };
}

export function checkPass(
  check: CheckName | string,
  summary: string,
  details: string[] = [],
  durationMs?: number,
): CheckResult {
  return {
    check,
    status: "pass",
    summary,
    details,
    requiresUserAction: false,
    durationMs,
  };
}

export function checkWarn(
  check: CheckName | string,
  summary: string,
  details: string[] = [],
  durationMs?: number,
): CheckResult {
  return {
    check,
    status: "warning",
    summary,
    details,
    requiresUserAction: true,
    durationMs,
  };
}

export function checkFail(
  check: CheckName | string,
  summary: string,
  details: string[] = [],
  durationMs?: number,
): CheckResult {
  return {
    check,
    status: "fail",
    summary,
    details,
    requiresUserAction: true,
    durationMs,
  };
}
