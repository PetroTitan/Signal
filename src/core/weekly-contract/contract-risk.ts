/**
 * Maps the global risk vocabulary onto the contract risk ceiling.
 *
 * The product elsewhere talks about four risk levels:
 *   low | medium | high | blocked
 * (See src/core/risk/.) The contract ceiling is only the first three —
 * `blocked` is never authorized regardless of the contract.
 */

import type { RiskLevel } from "@/lib/supabase/types";
import {
  RISK_CEILING_RANK,
  type WeeklyContractRiskCeiling,
} from "./approval-contract-types";

/**
 * True when the candidate risk fits under (or equals) the contract
 * ceiling. `blocked` always returns false.
 */
export function fitsUnderRiskCeiling(
  candidate: RiskLevel,
  ceiling: WeeklyContractRiskCeiling,
): boolean {
  if (candidate === "blocked") return false;
  const candidateRank = RISK_CEILING_RANK[candidate];
  const ceilingRank = RISK_CEILING_RANK[ceiling];
  return candidateRank <= ceilingRank;
}

export function describeRiskCeiling(
  ceiling: WeeklyContractRiskCeiling,
): string {
  switch (ceiling) {
    case "low":
      return "Low — only the safest content runs automatically.";
    case "medium":
      return "Medium — standard posts and comments may run; sensitive content escalates.";
    case "high":
      return "High — most content runs unless flagged by the risk engine.";
  }
}
