/**
 * Cadence accounting for the weekly operating contract.
 *
 * Three ceilings, evaluated in order:
 *   1. max_actions_total            — over the whole week.
 *   2. max_actions_per_day          — within a single local day.
 *   3. max_actions_per_platform_per_day — per-platform daily cap.
 *
 * `null` on any ceiling means "no limit on this axis."
 */

import type { WeeklyContract } from "./approval-contract-types";

export interface ActionCountSnapshot {
  /** Total `allowed` authorizations attributed to this contract. */
  totalAllowed: number;
  /** Local-day -> allowed count, keyed as "YYYY-MM-DD". */
  perDay: Record<string, number>;
  /** "platform|YYYY-MM-DD" -> allowed count. */
  perPlatformPerDay: Record<string, number>;
}

export interface CadenceEvaluationInput {
  contract: WeeklyContract;
  snapshot: ActionCountSnapshot;
  /** Local-day key, e.g. "2026-05-22". */
  evaluatedOnLocalDay: string;
  platform: string | null;
}

export type CadenceVerdict =
  | { kind: "ok" }
  | { kind: "total_exceeded" }
  | { kind: "per_day_exceeded" }
  | { kind: "per_platform_exceeded" };

export function evaluateCadence(input: CadenceEvaluationInput): CadenceVerdict {
  const { contract, snapshot, evaluatedOnLocalDay, platform } = input;

  if (
    contract.maxActionsTotal !== null &&
    snapshot.totalAllowed >= contract.maxActionsTotal
  ) {
    return { kind: "total_exceeded" };
  }

  if (contract.maxActionsPerDay !== null) {
    const used = snapshot.perDay[evaluatedOnLocalDay] ?? 0;
    if (used >= contract.maxActionsPerDay) {
      return { kind: "per_day_exceeded" };
    }
  }

  if (contract.maxActionsPerPlatformPerDay !== null && platform) {
    const key = `${platform}|${evaluatedOnLocalDay}`;
    const used = snapshot.perPlatformPerDay[key] ?? 0;
    if (used >= contract.maxActionsPerPlatformPerDay) {
      return { kind: "per_platform_exceeded" };
    }
  }

  return { kind: "ok" };
}

export function emptyActionCountSnapshot(): ActionCountSnapshot {
  return { totalAllowed: 0, perDay: {}, perPlatformPerDay: {} };
}

/**
 * Helper to roll allowed authorization rows up into a snapshot. Used by
 * the repository when feeding the engine.
 */
export function aggregateSnapshot(
  rows: ReadonlyArray<{
    outcome: string;
    platform: string | null;
    created_at: string;
  }>,
  localDayFor: (iso: string) => string,
): ActionCountSnapshot {
  const snap = emptyActionCountSnapshot();
  for (const row of rows) {
    if (row.outcome !== "allowed") continue;
    snap.totalAllowed += 1;
    const day = localDayFor(row.created_at);
    snap.perDay[day] = (snap.perDay[day] ?? 0) + 1;
    if (row.platform) {
      const key = `${row.platform}|${day}`;
      snap.perPlatformPerDay[key] = (snap.perPlatformPerDay[key] ?? 0) + 1;
    }
  }
  return snap;
}
