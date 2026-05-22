/**
 * Weekly contract lifecycle transitions.
 *
 * Status flow:
 *   draft → pending_approval → approved → active → (expired | paused | revoked)
 *   active ↔ paused      (operator may resume)
 *   active → expired     (after week_end, automatic)
 *   any → revoked        (operator may revoke)
 *
 * Nothing outside the operator may activate a contract. The runner
 * never bumps state on its own except for the two automatic paths:
 * `expired` when the calendar week passes, and `paused` when a
 * configured trigger fires.
 */

import type { WeeklyContractStatus } from "./approval-contract-types";

export const VALID_TRANSITIONS: Record<
  WeeklyContractStatus,
  ReadonlyArray<WeeklyContractStatus>
> = {
  draft: ["pending_approval", "revoked"],
  pending_approval: ["approved", "draft", "revoked"],
  approved: ["active", "revoked"],
  active: ["paused", "expired", "revoked"],
  paused: ["active", "expired", "revoked"],
  expired: ["revoked"],
  revoked: [],
};

export class ContractStatusError extends Error {
  constructor(
    message: string,
    public readonly from: WeeklyContractStatus,
    public readonly to: WeeklyContractStatus,
  ) {
    super(message);
    this.name = "ContractStatusError";
  }
}

export function canTransition(
  from: WeeklyContractStatus,
  to: WeeklyContractStatus,
): boolean {
  if (from === to) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: WeeklyContractStatus,
  to: WeeklyContractStatus,
): void {
  if (!canTransition(from, to)) {
    throw new ContractStatusError(
      `Invalid contract status transition: ${from} → ${to}`,
      from,
      to,
    );
  }
}

export function isAuthorizingStatus(status: WeeklyContractStatus): boolean {
  return status === "active";
}
