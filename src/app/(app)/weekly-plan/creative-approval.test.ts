import { describe, expect, it } from "vitest";
import { creativeBlockerCopy } from "./approval-readiness.shared";
import { toCreativeStatusToken } from "./_creative-approval-controls";

/**
 * Regression guards for the creative approval deadlock fix.
 *
 * The server actions themselves require a Supabase session +
 * workspace membership + a real creative row, so they're exercised
 * via integration smoke (manual QA in the PR). These tests pin the
 * pure pieces:
 *
 *   - the operator-facing copy for `creative_not_approved` is the
 *     new actionable wording (the failing case the deadlock report
 *     called out)
 *   - the copy mentions a concrete next step (approve or reject)
 *   - other reason codes are unchanged
 */

describe("creativeBlockerCopy — actionable deadlock copy", () => {
  it("creative_not_approved → actionable copy that names BOTH choices", () => {
    const copy = creativeBlockerCopy("creative_not_approved");
    expect(copy).toMatch(/cannot be approved/i);
    expect(copy).toMatch(/still pending review/i);
    expect(copy).toMatch(/approve or reject the creative/i);
    // Regression: the old copy ("Creative needs to be approved
    // before the post can be approved.") is replaced.
    expect(copy).not.toBe(
      "Creative needs to be approved before the post can be approved.",
    );
  });

  it("other reason codes keep their existing operator copy", () => {
    expect(creativeBlockerCopy("creative_missing")).toMatch(/missing/i);
    expect(creativeBlockerCopy("creative_missing_asset")).toMatch(/asset url/i);
    expect(creativeBlockerCopy("creative_missing_alt_text")).toMatch(
      /alt text/i,
    );
    expect(creativeBlockerCopy("creative_rejected")).toMatch(/rejected/i);
    expect(creativeBlockerCopy("creative_only_planned")).toMatch(/planned/i);
    expect(creativeBlockerCopy("creative_missing_license_or_attribution")).toMatch(
      /license/i,
    );
    expect(creativeBlockerCopy("creative_missing_prompt")).toMatch(/prompt/i);
  });

  it("null reason code → calm fallback (no operator-confusing message)", () => {
    expect(creativeBlockerCopy(null)).toMatch(/not ready/i);
  });
});

// ---------------------------------------------------------------------
// approveCreativeAction / rejectCreativeAction — TYPE-level pin
// ---------------------------------------------------------------------
//
// The two new server actions export typed results. These tests
// assert the shapes a future refactor cannot silently change without
// breaking the UI component that consumes them.

describe("ApproveCreativeResult / RejectCreativeResult — shape stability", () => {
  it("ApproveCreativeResult.ok variant has creativeId + status:'approved'", async () => {
    // Type-only check via a local assignment — succeeds at compile
    // time if the shape is preserved.
    const ok: import("./_actions").ApproveCreativeResult = {
      ok: true,
      error: null,
      creativeId: "c-1",
      status: "approved",
    };
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.creativeId).toBe("c-1");
      expect(ok.status).toBe("approved");
    }
  });

  it("RejectCreativeResult.ok variant has creativeId + status:'rejected'", async () => {
    const ok: import("./_actions").RejectCreativeResult = {
      ok: true,
      error: null,
      creativeId: "c-1",
      status: "rejected",
    };
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.creativeId).toBe("c-1");
      expect(ok.status).toBe("rejected");
    }
  });
});

// ---------------------------------------------------------------------
// toCreativeStatusToken — shared narrow used by card + modal
// ---------------------------------------------------------------------
//
// Both the weekly-plan card and the compose modal map raw
// `weekly_plan_item_creatives.status` strings into the operator-
// facing token through this single helper. Tests pin the mapping so
// the modal cannot drift into a different token vocabulary than the
// card (the bug this PR is fixing: modal rendered no approval
// controls because it didn't even know the status existed).

describe("toCreativeStatusToken — shared mapping", () => {
  it("null / undefined → 'none' (no creative attached)", () => {
    expect(toCreativeStatusToken(null)).toBe("none");
    expect(toCreativeStatusToken(undefined)).toBe("none");
  });

  it("'approved' → 'approved'", () => {
    expect(toCreativeStatusToken("approved")).toBe("approved");
  });

  it("'rejected' → 'rejected'", () => {
    expect(toCreativeStatusToken("rejected")).toBe("rejected");
  });

  it("'planned' → 'planned'", () => {
    expect(toCreativeStatusToken("planned")).toBe("planned");
  });

  it("'pending_review' → 'pending_review' (the case that surfaces the buttons)", () => {
    expect(toCreativeStatusToken("pending_review")).toBe("pending_review");
  });

  it("any other / future string → 'pending_review' (conservative fallback)", () => {
    // The controls component refuses to show approve/reject when the
    // creative isn't pending review. Any unrecognized future status
    // should NOT default to "approved" — that would silently bypass
    // the approval boundary.
    expect(toCreativeStatusToken("some_future_state")).toBe("pending_review");
    expect(toCreativeStatusToken("")).toBe("none");
  });
});

// ---------------------------------------------------------------------
// Compose modal surface — invariants the production fix preserves
// ---------------------------------------------------------------------
//
// These tests pin the shape contract that lets the compose modal
// render the approval controls. They assert via TypeScript: the
// existingItem.creative shape now carries `status`. Without it the
// modal couldn't know whether to render the buttons.

describe("FounderComposeSheetExistingItem.creative.status (shape contract)", () => {
  it("must accept a 'pending_review' status value at the type level", () => {
    type Existing = import(
      "@/components/founder-compose/founder-compose-sheet"
    ).FounderComposeSheetExistingItem;
    // A pending_review creative payload must satisfy the type — if
    // the `status` field is dropped in a future refactor, this fails
    // to compile.
    const sample: Existing["creative"] = {
      id: "c-1",
      assetUrl: "https://example.com/x.jpg",
      altText: "alt",
      sourceType: "uploaded",
      status: "pending_review",
    };
    expect(sample?.status).toBe("pending_review");
  });
});
