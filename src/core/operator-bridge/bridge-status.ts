/**
 * Phase E2.8 — typed state transitions for operator_bridge_requests.
 */

import type { BridgeRequestStatus } from "./bridge-types";

const VALID_TRANSITIONS: Record<
  BridgeRequestStatus,
  ReadonlyArray<BridgeRequestStatus>
> = {
  draft: ["pending_operator", "cancelled"],
  pending_operator: ["copied", "running", "cancelled", "expired"],
  copied: ["running", "result_submitted", "cancelled", "expired"],
  running: ["result_submitted", "cancelled", "expired"],
  result_submitted: ["verified", "failed_verification", "rejected"],
  verified: ["completed", "rejected"],
  failed_verification: ["pending_operator", "cancelled"],
  expired: [],
  cancelled: [],
  rejected: [],
  completed: [],
};

export class BridgeStatusError extends Error {
  constructor(
    message: string,
    public readonly from: BridgeRequestStatus,
    public readonly to: BridgeRequestStatus,
  ) {
    super(message);
    this.name = "BridgeStatusError";
  }
}

export function canTransition(
  from: BridgeRequestStatus,
  to: BridgeRequestStatus,
): boolean {
  if (from === to) return false;
  return VALID_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: BridgeRequestStatus,
  to: BridgeRequestStatus,
): void {
  if (!canTransition(from, to)) {
    throw new BridgeStatusError(
      `Invalid operator-bridge request transition: ${from} → ${to}`,
      from,
      to,
    );
  }
}

export const TERMINAL_STATUSES = new Set<BridgeRequestStatus>([
  "expired",
  "cancelled",
  "rejected",
  "completed",
]);

export function isTerminal(status: BridgeRequestStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
