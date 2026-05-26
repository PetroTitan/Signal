import { describe, expect, it } from "vitest";
import { creativeBlockerCopy } from "./approval-readiness.shared";

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
