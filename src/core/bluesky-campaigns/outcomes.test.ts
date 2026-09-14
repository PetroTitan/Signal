import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  BACKOFF_MAX_MS,
  classifyOutcome,
  MAX_MEMBER_ATTEMPTS,
  outcomeFromGraphFailure,
  type CampaignOutcomeKind,
} from "./outcomes";

const ALL: CampaignOutcomeKind[] = [
  "succeeded",
  "dry_run",
  "already_following",
  "actor_not_found",
  "ineligible",
  "retryable_transport_failure",
  "rate_limited",
  "authentication_expired",
  "structural_provider_failure",
  "cancelled",
];

describe("every outcome is classified explicitly", () => {
  it("no outcome falls through to a default", () => {
    for (const kind of ALL) {
      const d = classifyOutcome({ kind, attemptCount: 1 });
      expect(d.kind, kind).toBe(kind);
      expect(typeof d.consumesQuota).toBe("boolean");
      expect(typeof d.countsAsSuccess).toBe("boolean");
      expect(typeof d.countsAsFailure).toBe("boolean");
      expect(d.memberStatus).toBeTruthy();
      expect(d.next.kind).toBeTruthy();
    }
  });

  it("no outcome leaves a member in a non-terminal, non-retryable limbo", () => {
    for (const kind of ALL) {
      const d = classifyOutcome({ kind, attemptCount: 1 });
      const terminal = [
        "succeeded",
        "already_following",
        "protected",
        "skipped",
        "failed_structural",
        "cancelled",
      ];
      expect(terminal.includes(d.memberStatus) || d.retryable, kind).toBe(true);
      // Crucially: nothing stays `running` or `claimed`.
      expect(d.memberStatus).not.toBe("running");
      expect(d.memberStatus).not.toBe("claimed");
      expect(d.memberStatus).not.toBe("queued");
    }
  });
});

describe("401 stops the campaign for reauthorization", () => {
  it("transitions the campaign, not just the member", () => {
    const d = classifyOutcome({ kind: "authentication_expired", attemptCount: 1 });
    expect(d.next.kind).toBe("stop_campaign");
    if (d.next.kind !== "stop_campaign") return;
    expect(d.next.campaignStatus).toBe("reauthorization_required");
    expect(d.next.reason).toContain("reconnected");
  });

  it("does not consume quota or count as a failure", () => {
    // Nothing was attempted against the member, and retrying would only
    // burn createSession budget (300/day per account).
    const d = classifyOutcome({ kind: "authentication_expired", attemptCount: 1 });
    expect(d.consumesQuota).toBe(false);
    expect(d.countsAsFailure).toBe(false);
    expect(d.retryable).toBe(true);
  });
});

describe("429 stops the run and honours the reset", () => {
  it("stops the run rather than the campaign", () => {
    const resumeAfter = new Date("2026-09-11T13:00:00Z");
    const d = classifyOutcome({ kind: "rate_limited", attemptCount: 1, resumeAfter });
    expect(d.next.kind).toBe("stop_run");
    if (d.next.kind !== "stop_run") return;
    expect(d.next.resumeAfter).toBe(resumeAfter);
  });

  it("leaves the member retryable and charges no quota", () => {
    const d = classifyOutcome({ kind: "rate_limited", attemptCount: 1 });
    expect(d.retryable).toBe(true);
    expect(d.consumesQuota).toBe(false);
    expect(d.countsAsFailure).toBe(false);
  });
});

describe("transport failures retry within a bounded policy", () => {
  it("stays retryable below the attempt ceiling", () => {
    for (let n = 1; n < MAX_MEMBER_ATTEMPTS; n += 1) {
      const d = classifyOutcome({
        kind: "retryable_transport_failure",
        attemptCount: n,
      });
      expect(d.retryable, `attempt ${n}`).toBe(true);
      expect(d.memberStatus).toBe("retryable");
      // Not finished, so it has not consumed a quota unit yet.
      expect(d.consumesQuota).toBe(false);
    }
  });

  it("becomes terminal at the ceiling — 'retry forever' is not a policy", () => {
    const d = classifyOutcome({
      kind: "retryable_transport_failure",
      attemptCount: MAX_MEMBER_ATTEMPTS,
    });
    expect(d.retryable).toBe(false);
    expect(d.memberStatus).toBe("failed_structural");
    // The attempts were really made, so they cost quota.
    expect(d.consumesQuota).toBe(true);
  });

  it("counts as a failure for the consecutive-failure breaker", () => {
    expect(
      classifyOutcome({ kind: "retryable_transport_failure", attemptCount: 1 })
        .countsAsFailure,
    ).toBe(true);
  });
});

describe("structural failures stop the MEMBER, never the campaign", () => {
  it("is terminal for the member, counts toward the breaker, and continues", () => {
    // Changed 2026-09-14. A structural 4xx is Bluesky's verdict on ONE
    // request — a malformed record, a subject it will not accept. The
    // deployed policy stopped the whole campaign on the first such
    // member, which stranded every queued member behind it until an
    // operator noticed. A systemic problem shows up as MANY structural
    // failures in a row, and `max_consecutive_failures` is what stops
    // the run for that.
    const d = classifyOutcome({ kind: "structural_provider_failure", attemptCount: 1 });
    expect(d.retryable).toBe(false);
    expect(d.memberStatus).toBe("failed_structural");
    expect(d.countsAsFailure).toBe(true);
    expect(d.consumesQuota).toBe(true);
    expect(d.next.kind).toBe("continue");
  });

  it("an unrecognised provider error is structural, not retryable", () => {
    // Retrying an unknown error indefinitely is how a bug becomes a
    // sustained burst against someone else's service.
    expect(outcomeFromGraphFailure({ kind: "provider_error", status: 400 })).toBe(
      "structural_provider_failure",
    );
    expect(outcomeFromGraphFailure({ kind: "provider_error", status: 418 })).toBe(
      "structural_provider_failure",
    );
  });

  it("a 5xx is treated as transport, inside the bounded policy", () => {
    for (const status of [500, 502, 503]) {
      expect(outcomeFromGraphFailure({ kind: "provider_error", status })).toBe(
        "retryable_transport_failure",
      );
    }
  });
});

describe("already_following never costs the operator a follow", () => {
  it("consumes no quota and is not a failure", () => {
    const d = classifyOutcome({ kind: "already_following", attemptCount: 1 });
    expect(d.consumesQuota).toBe(false);
    expect(d.countsAsFailure).toBe(false);
    expect(d.countsAsSuccess).toBe(false);
    expect(d.memberStatus).toBe("already_following");
    expect(d.next.kind).toBe("continue");
  });
});

describe("a stale queue does not trip the breakers", () => {
  it("a deleted account is skipped, not counted as a failure", () => {
    // A 100k queue imported months ago will legitimately contain
    // accounts that no longer exist. Counting those as provider
    // failures would pause a perfectly healthy campaign.
    const d = classifyOutcome({ kind: "actor_not_found", attemptCount: 1 });
    expect(d.memberStatus).toBe("skipped");
    expect(d.countsAsFailure).toBe(false);
    expect(d.consumesQuota).toBe(false);
    expect(d.next.kind).toBe("continue");
  });

  it("an ineligible account is terminal and neutral", () => {
    const d = classifyOutcome({ kind: "ineligible", attemptCount: 1 });
    expect(d.memberStatus).toBe("protected");
    expect(d.retryable).toBe(false);
    expect(d.countsAsFailure).toBe(false);
  });
});

describe("dry run creates nothing and claims nothing", () => {
  it("is recorded as skipped, never as a success", () => {
    // If a dry run recorded `succeeded` it would inflate the success
    // rate, satisfy the completion check, and look like real progress.
    const d = classifyOutcome({ kind: "dry_run", attemptCount: 1 });
    expect(d.memberStatus).toBe("skipped");
    expect(d.countsAsSuccess).toBe(false);
    expect(d.consumesQuota).toBe(false);
    expect(d.countsAsFailure).toBe(false);
    expect(d.retryable).toBe(false);
  });
});

describe("graph-failure mapping", () => {
  it("maps each client failure kind to the right outcome", () => {
    expect(outcomeFromGraphFailure({ kind: "auth", status: 401 })).toBe(
      "authentication_expired",
    );
    expect(outcomeFromGraphFailure({ kind: "rate_limited", status: 429 })).toBe(
      "rate_limited",
    );
    expect(outcomeFromGraphFailure({ kind: "not_found", status: 400 })).toBe(
      "actor_not_found",
    );
    expect(outcomeFromGraphFailure({ kind: "network", status: 0 })).toBe(
      "retryable_transport_failure",
    );
  });
});

describe("retry backoff", () => {
  it("grows exponentially and is capped", () => {
    const noJitter = () => 0.5;
    const delays = [1, 2, 3, 4, 8].map((n) => backoffDelayMs(n, noJitter));
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
    expect(backoffDelayMs(20, noJitter)).toBeLessThanOrEqual(BACKOFF_MAX_MS * 1.2);
  });

  it("spreads retries so a failed chunk does not retry in lockstep", () => {
    // Jitter here is collision avoidance, not traffic disguising: it is
    // applied only to RETRY timing, never to normal request spacing.
    const a = backoffDelayMs(2, () => 0);
    const b = backoffDelayMs(2, () => 1);
    expect(a).not.toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it("never returns a non-positive delay", () => {
    for (let n = 1; n <= 10; n += 1) {
      expect(backoffDelayMs(n, () => 0)).toBeGreaterThan(0);
    }
  });
});

describe("no outcome authorises an unfollow", () => {
  it("no decision mentions unfollow or delete", () => {
    // This system follows. It has no unfollow path at all.
    for (const kind of ALL) {
      const d = classifyOutcome({ kind, attemptCount: 1 });
      expect(JSON.stringify(d).toLowerCase()).not.toContain("unfollow");
      expect(JSON.stringify(d).toLowerCase()).not.toContain("deleterecord");
    }
  });
});
