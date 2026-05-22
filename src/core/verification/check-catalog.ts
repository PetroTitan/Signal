/**
 * Phase E2.5 — verification check catalog.
 *
 * Single source of truth for the checks the pipeline runs and the
 * label / risk metadata the UI shows. Each entry maps to a runner
 * function exported from `src/repositories/verification/`.
 */

export const VERIFICATION_CHECKS = [
  "env_check",
  "auth_check",
  "rls_check",
  "db_integrity_check",
  "route_protection_check",
  "demo_boundary_check",
  "execution_dry_run_smoke",
  "production_smoke_test",
  "pr_readiness_check",
] as const;
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];

export const VERIFICATION_CHECK_LABELS: Record<VerificationCheck, string> = {
  env_check: "Environment check",
  auth_check: "Auth check",
  rls_check: "RLS check",
  db_integrity_check: "Database integrity check",
  route_protection_check: "Route protection check",
  demo_boundary_check: "Demo boundary check",
  execution_dry_run_smoke: "End-to-end execution dry-run",
  production_smoke_test: "Workspace smoke test",
  pr_readiness_check: "PR readiness gate",
};

/**
 * Whether the check's failure should block a merge. The PR-readiness
 * gate uses this to compute `blocked` vs `needs_review`.
 */
export const CHECK_BLOCKS_MERGE: Record<VerificationCheck, boolean> = {
  env_check: false,
  auth_check: true,
  rls_check: true,
  db_integrity_check: true,
  route_protection_check: true,
  demo_boundary_check: true,
  execution_dry_run_smoke: true,
  production_smoke_test: false,
  pr_readiness_check: true,
};
