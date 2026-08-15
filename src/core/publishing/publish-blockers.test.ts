import { describe, expect, it } from "vitest";

import {
  evaluatePublishBlockers,
  providerWasAttempted,
  resolveCreativeState,
  resolvePublishingState,
  type BlockerCreativeInput,
  type BlockerItemInput,
} from "./publish-blockers";
import { evaluateRetryEligibility } from "./retry-eligibility";

/**
 * Regression suite for the Bluesky publishing incident.
 *
 * The production card simultaneously displayed:
 *
 *     "Creative approved"
 *     "Creative must be approved before the post itself can be
 *      approved. Approve the creative below…"
 *
 * while the real blocker — no publishing identity attached — appeared
 * on no surface at all, and the post sat `paused` with a generic
 * "Bluesky didn't publish this post."
 *
 * The fixtures below are the ACTUAL production row values, so these
 * tests fail if the incident becomes representable again.
 */

/** weekly_plan_items 7be1588e — the incident item, verbatim. */
function incidentItem(over: Partial<BlockerItemInput> = {}): BlockerItemInput {
  return {
    id: "7be1588e-1421-4b15-bae5-00cbe87de61c",
    status: "pending_approval",
    platform: "bluesky",
    contentType: "post",
    intent: null,
    title: null, // Bluesky posts are titleless by design
    body: "9 apps live. Not one of them is cool.",
    accountId: "8096e0b4-ff98-4f1c-8746-b8870c043d71",
    scheduledAt: "2026-08-15T13:55:00+00:00",
    riskLevel: null,
    metadata: {},
    ...over,
  };
}

/** weekly_plan_item_creatives cb61b3ff — approved, asset present, alt set. */
function incidentCreative(
  over: Partial<BlockerCreativeInput> = {},
): BlockerCreativeInput {
  return {
    id: "cb61b3ff-6cdf-417e-b4e5-52f292419570",
    status: "approved",
    sourceType: "uploaded",
    assetUrl: "https://storage.example/creative.jpg",
    altText: "#myiosapps",
    sourceUrl: null,
    ...over,
  };
}

function evaluate(
  item: BlockerItemInput,
  creative: BlockerCreativeInput | null,
  over: { requireSchedule?: boolean; requireIdentity?: boolean } = {},
) {
  return evaluatePublishBlockers({
    item,
    creative,
    allowedStatuses: [item.status],
    requireSchedule: over.requireSchedule ?? true,
    requireIdentity: over.requireIdentity ?? true,
  });
}

function codes(v: { blockers: { code: string }[] }): string[] {
  return v.blockers.map((b) => b.code);
}

// =====================================================================
// 1 + 2 — the exact production contradiction
// =====================================================================

describe("1. creative approved with no other blockers", () => {
  it("never reports a creative-approval blocker", () => {
    const v = evaluate(incidentItem(), incidentCreative());
    expect(codes(v)).not.toContain("creative_pending_review");
    expect(codes(v)).not.toContain("creative_missing");
    expect(v.canApprovePost).toBe(true);
  });

  it("does not warn about the creative either", () => {
    const v = evaluate(incidentItem(), incidentCreative());
    expect(v.warnings.map((w) => w.code)).toEqual([]);
  });
});

describe("2. creative approved + alt text missing", () => {
  const v = evaluate(incidentItem(), incidentCreative({ altText: null }));

  it("keeps the creative APPROVED — approval is not revoked", () => {
    expect(resolveCreativeState(incidentCreative({ altText: null }))).toBe(
      "approved",
    );
  });

  it("blocks on alt text, naming the real action", () => {
    expect(codes(v)).toContain("creative_missing_alt_text");
    expect(
      v.blockers.find((b) => b.code === "creative_missing_alt_text")!.message,
    ).toMatch(/alt text/i);
  });

  it("does NOT say the creative needs approving", () => {
    // The incident's exact failure mode: an alt-text problem presented
    // as a creative-approval problem.
    expect(codes(v)).not.toContain("creative_pending_review");
  });

  it("points the operator at the creative row, not the post", () => {
    expect(
      v.blockers.find((b) => b.code === "creative_missing_alt_text")!.entityId,
    ).toBe("cb61b3ff-6cdf-417e-b4e5-52f292419570");
  });
});

describe("3. creative awaiting approval", () => {
  it("says so when a creative is required", () => {
    const v = evaluate(
      incidentItem({ platform: "instagram", intent: "media_post" }),
      incidentCreative({ status: "pending_review" }),
      { requireSchedule: false },
    );
    expect(codes(v)).toContain("creative_pending_review");
  });

  it("warns rather than blocks where the creative is optional", () => {
    // resolvePublishCreative only publishes status="approved", so an
    // unreviewed creative is dropped and the post goes out text-only.
    // Real, worth saying — but not a blocker, and calling it one is
    // what the incident banner did.
    const v = evaluate(
      incidentItem(),
      incidentCreative({ status: "pending_review" }),
    );
    expect(codes(v)).not.toContain("creative_pending_review");
    expect(v.warnings.map((w) => w.code)).toContain("creative_pending_review");
    expect(v.canApprovePost).toBe(true);
  });
});

describe("4. replaced creative", () => {
  it("judges only the currently attached creative", () => {
    // An approval belonging to a previous creative must not make a new
    // pending one look approved. The evaluator is given the CURRENT
    // creative and has no memory of any other, which is the property.
    const replaced = incidentCreative({
      id: "new-creative-id",
      status: "pending_review",
      altText: null,
    });
    const v = evaluate(
      incidentItem({ platform: "instagram", intent: "media_post" }),
      replaced,
      { requireSchedule: false },
    );
    expect(codes(v)).toContain("creative_pending_review");
    for (const b of v.blockers) {
      if (b.code.startsWith("creative_")) {
        expect(b.entityId).toBe("new-creative-id");
      }
    }
  });
});

// =====================================================================
// THE INCIDENT — missing publishing identity
// =====================================================================

describe("identity guard — the actual cause of the production failure", () => {
  it("blocks approval when no identity is attached", () => {
    const v = evaluate(incidentItem({ accountId: null }), incidentCreative());
    expect(codes(v)).toContain("identity_not_attached");
    expect(v.canApprovePost).toBe(false);
  });

  it("names the action, not the symptom", () => {
    // The scheduler said "Account review_status must be 'confirmed'
    // (is 'unknown')" — describing a confirmation problem when there
    // was no identity at all.
    const v = evaluate(incidentItem({ accountId: null }), incidentCreative());
    const b = v.blockers.find((x) => x.code === "identity_not_attached")!;
    expect(b.message).toMatch(/identity/i);
    expect(b.message).not.toMatch(/confirmed/i);
  });

  it("does NOT block the hold path — parking a post without one is allowed", () => {
    const v = evaluate(incidentItem({ accountId: null }), incidentCreative(), {
      requireSchedule: false,
      requireIdentity: false,
    });
    expect(codes(v)).not.toContain("identity_not_attached");
  });

  it("never reports a creative problem when the identity is what is missing", () => {
    // The incident in one assertion.
    const v = evaluate(incidentItem({ accountId: null }), incidentCreative());
    expect(codes(v).filter((c) => c.startsWith("creative_"))).toEqual([]);
  });
});

// =====================================================================
// 5 — post approved, execution failed
// =====================================================================

describe("5. post approved + execution failed", () => {
  it("does not regress to pre-approval creative guidance", () => {
    const v = evaluate(
      incidentItem({ status: "paused" }),
      incidentCreative(),
      {},
    );
    expect(codes(v).filter((c) => c.startsWith("creative_"))).toEqual([]);
    expect(v.warnings.map((w) => w.code)).toEqual([]);
  });
});

// =====================================================================
// 6-9 — publishing state and retry classes, from persisted truth
// =====================================================================

/** The exact persisted outcome from both incident execution items. */
const INCIDENT_OUTCOME = {
  status: "blocked",
  reason_code: "account_not_confirmed",
  reason_detail: "Account review_status must be 'confirmed' (is 'unknown').",
  external_id: null,
  external_url: null,
};

describe("6. provider not attempted", () => {
  it("classifies the incident outcome as refused before the provider", () => {
    expect(resolvePublishingState(INCIDENT_OUTCOME)).toBe(
      "refused_before_provider",
    );
    expect(providerWasAttempted(INCIDENT_OUTCOME)).toBe(false);
  });

  it("is retry class A — safe, via the canonical predicate", () => {
    const verdict = evaluateRetryEligibility(INCIDENT_OUTCOME);
    expect(verdict.outcomeClass).toBe("safe_or_conditional_retry");
    expect(verdict.operatorRetryAllowed).toBe(true);
  });

  it("treats every pre-provider gate the same way", () => {
    for (const reason_code of [
      "oauth_not_connected",
      "oauth_token_not_stored",
      "publishing_disabled",
      "risk_level_blocked",
      "platform_not_supported",
      "missing_subreddit",
      "subreddit_not_allowlisted",
    ]) {
      expect(
        resolvePublishingState({ status: "blocked", reason_code }),
        reason_code,
      ).toBe("refused_before_provider");
    }
  });
});

describe("7. unknown outcome", () => {
  const outcome = {
    status: "failed",
    reason_code: "publish_outcome_unknown",
    external_id: null,
    external_url: null,
  };

  it("is reported as unknown, not as a plain failure", () => {
    expect(resolvePublishingState(outcome)).toBe("unknown");
    expect(providerWasAttempted(outcome)).toBe(true);
  });

  it("generic retry is refused by the canonical predicate", () => {
    const v = evaluateRetryEligibility(outcome);
    expect(v.operatorRetryAllowed).toBe(false);
    expect(v.automaticRetryAllowed).toBe(false);
    expect(v.requiresExplicitRecovery).toBe(true);
  });
});

describe("8. partial success", () => {
  const outcome = {
    status: "failed",
    reason_code: "publish_partial_success",
    external_id: null,
    external_url: null,
  };

  it("is reported as partial", () => {
    expect(resolvePublishingState(outcome)).toBe("partial");
  });

  it("generic retry is refused", () => {
    expect(evaluateRetryEligibility(outcome).operatorRetryAllowed).toBe(false);
  });
});

describe("9. already-published evidence", () => {
  it("provider evidence outranks the status field", () => {
    // A row that ended `failed` but carries a permalink IS published.
    const outcome = {
      status: "failed",
      reason_code: "platform_api_error",
      external_id: null,
      external_url: "https://bsky.app/profile/x/post/abc",
    };
    expect(resolvePublishingState(outcome)).toBe("published");
    expect(evaluateRetryEligibility(outcome).operatorRetryAllowed).toBe(false);
  });

  it("an external id alone is enough", () => {
    expect(
      resolvePublishingState({ status: "blocked", external_id: "at://abc" }),
    ).toBe("published");
  });
});

describe("10. connection failure is not a creative failure", () => {
  it("reports the connection blocker, never a creative one", () => {
    const outcome = {
      status: "blocked",
      reason_code: "oauth_not_connected",
      reason_detail: "OAuth connection must be 'connected' (is 'expired').",
    };
    expect(resolvePublishingState(outcome)).toBe("refused_before_provider");
    // And the approval evaluator says nothing about creatives for a
    // fully-formed creative.
    const v = evaluate(incidentItem(), incidentCreative());
    expect(codes(v).filter((c) => c.startsWith("creative_"))).toEqual([]);
  });
});

describe("no outcome yet", () => {
  it("is not_attempted, and retry is unconstrained", () => {
    expect(resolvePublishingState(null)).toBe("not_attempted");
    expect(evaluateRetryEligibility(null).outcomeClass).toBe("no_prior_attempt");
  });
});

// =====================================================================
// Blocker ordering + completeness
// =====================================================================

describe("blocker quality", () => {
  it("every message is imperative, not a rule statement", () => {
    const v = evaluate(
      incidentItem({ accountId: null, body: "", status: "pending_approval" }),
      incidentCreative({ status: "approved", altText: null }),
    );
    expect(v.blockers.length).toBeGreaterThan(1);
    for (const b of v.blockers) {
      expect(b.message.length).toBeGreaterThan(10);
      // "must be" is the phrasing of the banner this incident removed.
      expect(b.message, b.code).not.toMatch(/must be approved/i);
    }
  });

  it("carries a machine-readable code and an entity for every blocker", () => {
    const v = evaluate(
      incidentItem({ accountId: null }),
      incidentCreative({ altText: null }),
    );
    for (const b of v.blockers) {
      expect(b.code).toBeTruthy();
      expect(b.entityId).toBeTruthy();
    }
  });
});
