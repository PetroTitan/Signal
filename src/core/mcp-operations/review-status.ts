/**
 * Review-first lifecycle for AI-assisted records. Anything created
 * through the MCP-operations layer lands as `pending_review` unless the
 * user explicitly confirmed during the import flow. Pending records
 * cannot be scheduled or published.
 */
export const REVIEW_STATUSES = [
  "pending_review",
  "confirmed",
  "rejected",
  "needs_edit",
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending_review: "Pending review",
  confirmed: "Confirmed",
  rejected: "Rejected",
  needs_edit: "Needs edit",
};

export const REVIEW_STATUS_HINTS: Record<ReviewStatus, string> = {
  pending_review:
    "Created by an MCP/AI operation. Review fields before using this record in plans or schedules.",
  confirmed: "Reviewed and confirmed by a member of this workspace.",
  rejected: "Reviewed and rejected. Kept for audit; not used downstream.",
  needs_edit: "Reviewed and flagged for edits before confirming.",
};

export function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}

/**
 * The single source of truth: only `confirmed` records may be consumed
 * by downstream planning / scheduling / publishing. Everything else is
 * audit-only until the user acts on it.
 */
export function isUsableForOperations(status: ReviewStatus): boolean {
  return status === "confirmed";
}
