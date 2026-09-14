import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  classifyUnfollowOutcome,
  MAX_MEMBER_ATTEMPTS,
  outcomeFromGraphFailure,
  type UnfollowOutcomeKind,
} from "./outcomes";
import { consumesQuota } from "./quota";

/**
 * The failure policy, tested directly.
 *
 * These are pure functions, and they are tested as such because a
 * mutation check found the alternative wanting: asserting
 * `quotaConsumed === 0` through the worker proved nothing about the
 * `already_not_following` branch, because that path returns before the
 * classifier is consulted. Flipping `consumesQuota` to `true` there
 * changed no observable behaviour and no test noticed.
 *
 * A policy that nothing currently reads is still a policy — the next
 * caller will read it — so it is pinned here, where flipping it is
 * visible.
 */

const ALL: UnfollowOutcomeKind[] = [
  "succeeded",
  "dry_run",
  "already_not_following",
  "protected",
  "conflict",
  "no_record_target",
  "retryable_transport_failure",
  "rate_limited",
  "authentication_expired",
  "structural_provider_failure",
  "cancelled",
];

describe("which outcomes consume a unit of the day's quota", () => {
  it("ONLY outcomes where Signal actually sent something", () => {
    const consuming = ALL.filter(
      (kind) =>
        classifyUnfollowOutcome({ kind, attemptCount: 1 }).consumesQuota,
    );
    expect(consuming.sort()).toEqual([
      "structural_provider_failure",
      "succeeded",
    ]);
  });

  it("already_not_following consumes NOTHING — the requirement is explicit", () => {
    const d = classifyUnfollowOutcome({
      kind: "already_not_following",
      attemptCount: 1,
    });
    expect(d.consumesQuota).toBe(false);
    // And it is a SUCCESS: the operator's intent holds.
    expect(d.countsAsSuccess).toBe(true);
    expect(d.countsAsFailure).toBe(false);
    expect(d.memberStatus).toBe("already_not_following");
    expect(d.retryable).toBe(false);
    // The shared quota vocabulary agrees, so the two cannot drift.
    expect(consumesQuota("already_not_following")).toBe(false);
  });

  it("protected and conflict consume nothing and are never retried", () => {
    for (const kind of ["protected", "conflict"] as const) {
      const d = classifyUnfollowOutcome({ kind, attemptCount: 1 });
      expect(d.consumesQuota, kind).toBe(false);
      expect(d.retryable, kind).toBe(false);
      expect(consumesQuota(kind), kind).toBe(false);
    }
  });

  it("a dry run consumes nothing and is recorded as SKIPPED, never succeeded", () => {
    const d = classifyUnfollowOutcome({ kind: "dry_run", attemptCount: 1 });
    expect(d.consumesQuota).toBe(false);
    expect(d.memberStatus).toBe("skipped");
    expect(d.countsAsSuccess).toBe(false);
  });

  it("an exhausted retry DOES consume — requests were genuinely made", () => {
    const before = classifyUnfollowOutcome({
      kind: "retryable_transport_failure",
      attemptCount: MAX_MEMBER_ATTEMPTS - 1,
    });
    expect(before.consumesQuota).toBe(false);
    expect(before.retryable).toBe(true);

    const after = classifyUnfollowOutcome({
      kind: "retryable_transport_failure",
      attemptCount: MAX_MEMBER_ATTEMPTS,
    });
    expect(after.consumesQuota).toBe(true);
    expect(after.retryable).toBe(false);
    expect(after.memberStatus).toBe("failed_structural");
  });
});

describe("a 429 stops the RUN, never the campaign", () => {
  it("so the scheduler can come back to it", () => {
    // `stop_campaign` would move the campaign to a status the
    // dispatcher's listing does not include, and a status the
    // dispatcher cannot list is a status it cannot leave. A 429 is the
    // most ordinary thing that can happen to a bulk job.
    const d = classifyUnfollowOutcome({
      kind: "rate_limited",
      attemptCount: 1,
      resumeAfter: new Date("2026-09-14T13:00:00Z"),
    });
    expect(d.next.kind).toBe("stop_run");
    if (d.next.kind === "stop_run") {
      expect(d.next.resumeAfter?.toISOString()).toBe("2026-09-14T13:00:00.000Z");
    }
    // The member was never attempted: the request was refused before it
    // reached the record.
    expect(d.consumesQuota).toBe(false);
    expect(d.memberStatus).toBe("retryable");
  });

  it("an expired session DOES stop the campaign — it needs a human", () => {
    const d = classifyUnfollowOutcome({
      kind: "authentication_expired",
      attemptCount: 1,
    });
    expect(d.next.kind).toBe("stop_campaign");
    if (d.next.kind === "stop_campaign") {
      expect(d.next.campaignStatus).toBe("reauthorization_required");
    }
  });
});

describe("an unreadable provider answer is never an outcome", () => {
  it("anything unrecognised is RETRYABLE, not a success and not terminal", () => {
    expect(outcomeFromGraphFailure({ kind: "something_new", status: 0 })).toBe(
      "retryable_transport_failure",
    );
    expect(outcomeFromGraphFailure({ kind: "provider_error", status: 503 })).toBe(
      "retryable_transport_failure",
    );
  });

  it("a 4xx that is not auth or rate limiting describes the REQUEST", () => {
    // Retrying the same request cannot change a malformed rkey or a
    // collection that does not exist.
    expect(outcomeFromGraphFailure({ kind: "provider_error", status: 400 })).toBe(
      "structural_provider_failure",
    );
  });

  it("rate limiting and auth are recognised by KIND, not by status", () => {
    // bsky.social returns an expired token as HTTP 400 with the reason
    // in the body. A switch keyed on status routes that to
    // provider_error and never refreshes.
    expect(outcomeFromGraphFailure({ kind: "auth", status: 400 })).toBe(
      "authentication_expired",
    );
    expect(outcomeFromGraphFailure({ kind: "rate_limited", status: 200 })).toBe(
      "rate_limited",
    );
  });
});

describe("no outcome authorises a FOLLOW", () => {
  it("no decision mentions following or creating a record", () => {
    for (const kind of ALL) {
      const json = JSON.stringify(
        classifyUnfollowOutcome({ kind, attemptCount: 1 }),
      ).toLowerCase();
      expect(json, kind).not.toContain("createrecord");
      // "already_not_following" legitimately contains the word, so the
      // check is on the ACT, not the substring.
      expect(json, kind).not.toMatch(/"follow"|create_follow/);
    }
  });
});

describe("retry backoff", () => {
  it("grows, is capped, and never lands in the past", () => {
    const at = (n: number) => backoffDelayMs(n, () => 0.5);
    expect(at(1)).toBeLessThan(at(2));
    expect(at(2)).toBeLessThan(at(3));
    expect(at(50)).toBeLessThanOrEqual(60 * 60_000 * 1.2);
    for (let n = 1; n <= 20; n += 1) {
      expect(backoffDelayMs(n, () => 0)).toBeGreaterThanOrEqual(1_000);
      expect(backoffDelayMs(n, () => 1)).toBeGreaterThanOrEqual(1_000);
    }
  });
});
