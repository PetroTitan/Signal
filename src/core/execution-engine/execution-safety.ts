/**
 * Hard guarantees the engine enforces before any state-modifying call.
 *
 * These checks fail closed. They are intentionally redundant with the
 * weekly contract evaluator — defense in depth.
 */

import type { WeeklyContract } from "@/core/weekly-contract";

export interface SafetyCheckInput {
  contract: WeeklyContract | null;
  isDemoWorkspace: boolean;
  /** Operator-driven dry-run vs. background runner. Phase E2 only
   *  permits operator-driven dry-runs. */
  invocation: "operator_dry_run" | "background_runner" | "external_publish";
}

export type SafetyVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

export function assertEngineSafetyEnvelope(
  input: SafetyCheckInput,
): SafetyVerdict {
  if (input.invocation === "external_publish") {
    return {
      allowed: false,
      reason:
        "External publishing is not implemented in Phase E2. Use dry-run only.",
    };
  }

  if (input.invocation === "background_runner") {
    return {
      allowed: false,
      reason:
        "Background runner is gated until a separate phase wires safe scheduling.",
    };
  }

  if (input.isDemoWorkspace) {
    return {
      allowed: false,
      reason: "Demo workspaces never authorize execution.",
    };
  }

  if (!input.contract) {
    return {
      allowed: false,
      reason:
        "No active weekly contract. Approve a contract before running the queue.",
    };
  }

  if (input.contract.status !== "active") {
    return {
      allowed: false,
      reason: `Active contract required; current status is "${input.contract.status}".`,
    };
  }

  return { allowed: true };
}
