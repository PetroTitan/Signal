/**
 * Phase E2.6 — runtime check vocabulary.
 *
 * Single source of truth for the *new* check keys this phase adds.
 * The existing verification keys (env_check, auth_check, …) keep
 * living in `src/core/verification/check-catalog.ts`.
 */

export const RUNTIME_CHECKS = [
  "oauth_safety_check",
  "execution_safety_check",
  "weekly_contract_check",
] as const;
export type RuntimeCheck = (typeof RUNTIME_CHECKS)[number];

export const RUNTIME_CHECK_LABELS: Record<RuntimeCheck, string> = {
  oauth_safety_check: "OAuth safety check",
  execution_safety_check: "Execution safety check",
  weekly_contract_check: "Weekly contract check",
};

export const RUNTIME_CHECK_BLOCKS_MERGE: Record<RuntimeCheck, boolean> = {
  oauth_safety_check: true,
  execution_safety_check: true,
  weekly_contract_check: true,
};
