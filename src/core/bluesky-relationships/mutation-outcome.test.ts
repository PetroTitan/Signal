import { describe, expect, it } from "vitest";
import {
  classifyFollowOutcome,
  classifyUnfollowOutcome,
  looksLikeAlreadyExists,
  preflightFollow,
  preflightUnfollow,
  reconcileFollow,
  reconcileUnfollow,
} from "./mutation-outcome";
import type { GraphFailure } from "./atproto-graph";
import type { ResolvedRelationship } from "./relationship-state";

const failure = (over: Partial<GraphFailure> = {}): GraphFailure => ({
  ok: false,
  kind: "provider_error",
  status: 500,
  errorCode: null,
  message: "boom",
  rateLimit: null,
  ...over,
});

const resolved = (
  over: Partial<ResolvedRelationship> = {},
): ResolvedRelationship => ({
  did: "did:plc:subject",
  state: "not_following",
  followRecord: null,
  unknownReason: null,
  ...over,
});

describe("classifyFollowOutcome", () => {
  it("a confirmed create is applied, with the record identity kept", () => {
    const outcome = classifyFollowOutcome({
      ok: true,
      record: { uri: "at://did:plc:a/app.bsky.graph.follow/3x", rkey: "3x", cid: "c" },
      rateLimit: null,
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind !== "applied") return;
    expect(outcome.followRecord).toEqual({
      uri: "at://did:plc:a/app.bsky.graph.follow/3x",
      rkey: "3x",
      cid: "c",
    });
  });

  it("a network failure is AMBIGUOUS — the write may have landed", () => {
    const outcome = classifyFollowOutcome(failure({ kind: "network", status: 0 }));
    expect(outcome.kind).toBe("ambiguous");
    if (outcome.kind !== "ambiguous") return;
    expect(outcome.reason).toContain("two records");
  });

  it("a 5xx is ambiguous", () => {
    expect(classifyFollowOutcome(failure({ status: 502 })).kind).toBe("ambiguous");
    expect(classifyFollowOutcome(failure({ status: 500 })).kind).toBe("ambiguous");
  });

  it("a 2xx with an unreadable body is ambiguous, never applied", () => {
    const outcome = classifyFollowOutcome(failure({ status: 200 }));
    expect(outcome.kind).toBe("ambiguous");
  });

  it("a 400 is a definite rejection", () => {
    const outcome = classifyFollowOutcome(
      failure({ status: 400, errorCode: "InvalidRequest" }),
    );
    expect(outcome.kind).toBe("rejected");
  });

  it("a rate limit halts the batch and stays resumable", () => {
    const outcome = classifyFollowOutcome(failure({ kind: "rate_limited", status: 429 }));
    expect(outcome.kind).toBe("halt");
    if (outcome.kind !== "halt") return;
    expect(outcome.resumable).toBe(true);
  });

  it("an auth failure halts the batch and is NOT resumable without re-authentication", () => {
    const outcome = classifyFollowOutcome(failure({ kind: "auth", status: 401 }));
    expect(outcome.kind).toBe("halt");
    if (outcome.kind !== "halt") return;
    expect(outcome.resumable).toBe(false);
  });

  it("has no outcome that instructs a retry", () => {
    const kinds = new Set<string>();
    for (const f of [
      failure({ kind: "network", status: 0 }),
      failure({ status: 502 }),
      failure({ status: 400 }),
      failure({ kind: "rate_limited", status: 429 }),
      failure({ kind: "auth", status: 401 }),
    ]) {
      kinds.add(classifyFollowOutcome(f).kind);
    }
    expect([...kinds].sort()).toEqual(["ambiguous", "halt", "rejected"]);
  });
});

describe("classifyUnfollowOutcome", () => {
  it("a confirmed delete is applied", () => {
    expect(classifyUnfollowOutcome({ ok: true, rateLimit: null }).kind).toBe("applied");
  });

  it("a network failure is ambiguous even though deleteRecord is idempotent", () => {
    // Idempotence makes a repeat harmless; it does not make it correct
    // to send one automatically, so the same operator gate applies.
    expect(classifyUnfollowOutcome(failure({ kind: "network", status: 0 })).kind).toBe(
      "ambiguous",
    );
  });

  it("a 400 is a definite rejection", () => {
    expect(classifyUnfollowOutcome(failure({ status: 400 })).kind).toBe("rejected");
  });
});

describe("reconcileFollow — read truth, never re-send", () => {
  it("following → succeeded, and the record key is captured for later", () => {
    const r = reconcileFollow(
      resolved({
        state: "following",
        followRecord: { uri: "at://did:plc:a/app.bsky.graph.follow/3x", rkey: "3x" },
      }),
    );
    expect(r.status).toBe("succeeded");
    expect(r.followRecord?.rkey).toBe("3x");
    expect(r.operatorMayReissue).toBe(false);
  });

  it("mutual counts as following", () => {
    expect(reconcileFollow(resolved({ state: "mutual" })).status).toBe("succeeded");
  });

  it("unknown → reconciliation_required, and the operator is NOT told to re-issue", () => {
    const r = reconcileFollow(
      resolved({ state: "unknown", unknownReason: "Bluesky was unreachable." }),
    );
    expect(r.status).toBe("reconciliation_required");
    // Unknown on top of unknown: re-sending could duplicate a follow
    // that already exists.
    expect(r.operatorMayReissue).toBe(false);
    expect(r.note).toContain("unreachable");
  });

  it("not_following → reconciliation_required, explicitly NOT treated as proof of failure", () => {
    const r = reconcileFollow(resolved({ state: "not_following" }));
    expect(r.status).toBe("reconciliation_required");
    expect(r.status).not.toBe("failed");
    expect(r.note).toContain("not proof");
    expect(r.note).toContain("delay");
    // Advisory only: nothing in this subsystem acts on it.
    expect(r.operatorMayReissue).toBe(true);
  });

  it("can only ever conclude succeeded or reconciliation_required", () => {
    const statuses = new Set(
      (["following", "mutual", "unknown", "not_following", "follows_you"] as const).map(
        (state) => reconcileFollow(resolved({ state })).status,
      ),
    );
    expect([...statuses].sort()).toEqual(["reconciliation_required", "succeeded"]);
  });
});

describe("reconcileUnfollow", () => {
  it("not_following → succeeded", () => {
    expect(reconcileUnfollow(resolved({ state: "not_following" })).status).toBe(
      "succeeded",
    );
  });

  it("follows_you → succeeded (our follow is gone; theirs is not ours to change)", () => {
    expect(reconcileUnfollow(resolved({ state: "follows_you" })).status).toBe(
      "succeeded",
    );
  });

  it("still following → reconciliation_required, with the real record key learned", () => {
    const r = reconcileUnfollow(
      resolved({
        state: "following",
        followRecord: { uri: "at://did:plc:a/app.bsky.graph.follow/3y", rkey: "3y" },
      }),
    );
    expect(r.status).toBe("reconciliation_required");
    expect(r.followRecord?.rkey).toBe("3y");
    expect(r.note).toContain("did not re-send");
  });

  it("still following with no usable URI offers nothing to re-issue", () => {
    const r = reconcileUnfollow(resolved({ state: "following", followRecord: null }));
    expect(r.status).toBe("reconciliation_required");
    expect(r.operatorMayReissue).toBe(false);
  });

  it("unknown → reconciliation_required", () => {
    expect(reconcileUnfollow(resolved({ state: "unknown" })).status).toBe(
      "reconciliation_required",
    );
  });
});

describe("preflightFollow", () => {
  const actorDid = "did:plc:actor";

  it("proceeds for an unknown relationship — unknown is not a refusal", () => {
    expect(
      preflightFollow({ subjectDid: "did:plc:s", actorDid, currentState: "unknown" }),
    ).toEqual({ proceed: true });
  });

  it("proceeds for not_following and follows_you", () => {
    expect(
      preflightFollow({ subjectDid: "did:plc:s", actorDid, currentState: "not_following" })
        .proceed,
    ).toBe(true);
    expect(
      preflightFollow({ subjectDid: "did:plc:s", actorDid, currentState: "follows_you" })
        .proceed,
    ).toBe(true);
  });

  it("skips when already following — a second create would duplicate the record", () => {
    const d = preflightFollow({
      subjectDid: "did:plc:s",
      actorDid,
      currentState: "following",
    });
    expect(d.proceed).toBe(false);
    if (d.proceed) return;
    expect(d.status).toBe("skipped");
    expect(d.reason).toContain("second follow record");
  });

  it("skips mutual", () => {
    const d = preflightFollow({ subjectDid: "did:plc:s", actorDid, currentState: "mutual" });
    expect(d.proceed).toBe(false);
  });

  it("fails a subject that is not a DID", () => {
    const d = preflightFollow({
      subjectDid: "someone.bsky.social",
      actorDid,
      currentState: "unknown",
    });
    expect(d.proceed).toBe(false);
    if (d.proceed) return;
    expect(d.status).toBe("failed");
    expect(d.reason).toContain("handle is never used as identity");
  });

  it("refuses to follow itself", () => {
    const d = preflightFollow({
      subjectDid: actorDid,
      actorDid,
      currentState: "unknown",
    });
    expect(d.proceed).toBe(false);
  });
});

describe("preflightUnfollow", () => {
  it("excludes a protected relationship before every other consideration", () => {
    const d = preflightUnfollow({
      subjectDid: "did:plc:s",
      currentState: "following",
      protectedRelationship: true,
      followRkey: "3x",
    });
    expect(d.proceed).toBe(false);
    if (d.proceed) return;
    expect(d.status).toBe("skipped");
    expect(d.reason).toContain("Protected");
  });

  it("stays excluded when protected even if every other signal says go", () => {
    for (const state of ["following", "mutual", "unknown"] as const) {
      const d = preflightUnfollow({
        subjectDid: "did:plc:s",
        currentState: state,
        protectedRelationship: true,
        followRkey: "3x",
      });
      expect(d.proceed).toBe(false);
    }
  });

  it("refuses without a record key rather than guessing one", () => {
    const d = preflightUnfollow({
      subjectDid: "did:plc:s",
      currentState: "following",
      protectedRelationship: false,
      followRkey: null,
    });
    expect(d.proceed).toBe(false);
    if (d.proceed) return;
    expect(d.status).toBe("failed");
    expect(d.reason).toContain("never derived from");
  });

  it("skips when we are already not following", () => {
    const d = preflightUnfollow({
      subjectDid: "did:plc:s",
      currentState: "not_following",
      protectedRelationship: false,
      followRkey: "3x",
    });
    expect(d.proceed).toBe(false);
    if (d.proceed) return;
    expect(d.status).toBe("skipped");
  });

  it("proceeds for following/mutual/unknown when a record key is known", () => {
    for (const state of ["following", "mutual", "unknown"] as const) {
      expect(
        preflightUnfollow({
          subjectDid: "did:plc:s",
          currentState: state,
          protectedRelationship: false,
          followRkey: "3x",
        }),
      ).toEqual({ proceed: true });
    }
  });
});

describe("looksLikeAlreadyExists", () => {
  it("recognises a PDS that enforces uniqueness", () => {
    expect(
      looksLikeAlreadyExists(failure({ errorCode: "RecordAlreadyExists" })),
    ).toBe(true);
    expect(
      looksLikeAlreadyExists(failure({ message: "Follow already exists" })),
    ).toBe(true);
  });

  it("does not fire on an ordinary error", () => {
    expect(looksLikeAlreadyExists(failure({ message: "Internal Server Error" }))).toBe(
      false,
    );
  });
});
