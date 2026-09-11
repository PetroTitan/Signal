import { describe, expect, it } from "vitest";
import {
  chunkDids,
  isFollowedBy,
  isFollowing,
  relationshipLabel,
  relationshipsUnavailable,
  resolveRelationship,
} from "./relationship-state";
import type { GraphFailure, RelationshipObservation } from "./atproto-graph";

const answered = (
  followingUri: string | null,
  followedByUri: string | null,
): RelationshipObservation => ({
  did: "did:plc:subject",
  known: true,
  followingUri,
  followedByUri,
});

describe("resolveRelationship — the four observable states", () => {
  it("both directions → mutual", () => {
    const r = resolveRelationship(
      answered(
        "at://did:plc:actor/app.bsky.graph.follow/3a",
        "at://did:plc:subject/app.bsky.graph.follow/3b",
      ),
    );
    expect(r.state).toBe("mutual");
    expect(r.followRecord).toEqual({
      uri: "at://did:plc:actor/app.bsky.graph.follow/3a",
      rkey: "3a",
    });
  });

  it("we follow them → following, with the record key captured", () => {
    const r = resolveRelationship(
      answered("at://did:plc:actor/app.bsky.graph.follow/3a", null),
    );
    expect(r.state).toBe("following");
    expect(r.followRecord?.rkey).toBe("3a");
  });

  it("they follow us → follows_you, and no follow record of ours", () => {
    const r = resolveRelationship(
      answered(null, "at://did:plc:subject/app.bsky.graph.follow/3b"),
    );
    expect(r.state).toBe("follows_you");
    expect(r.followRecord).toBeNull();
  });

  it("answered with neither key → not_following", () => {
    const r = resolveRelationship(answered(null, null));
    expect(r.state).toBe("not_following");
    expect(r.unknownReason).toBeNull();
  });
});

describe("resolveRelationship — non-observations stay unknown", () => {
  it("a DID the provider omitted is unknown, never not_following", () => {
    const r = resolveRelationship({
      did: "did:plc:silent",
      known: false,
      reason: "absent",
    });
    expect(r.state).toBe("unknown");
    expect(r.state).not.toBe("not_following");
    expect(r.unknownReason).toBeTruthy();
  });

  it("#notFoundActor is unknown with its own explanation", () => {
    const r = resolveRelationship({
      did: "gone.bsky.social",
      known: false,
      reason: "not_found_actor",
    });
    expect(r.state).toBe("unknown");
    expect(r.unknownReason).toContain("could not resolve");
  });

  it("keeps state=following when the follow URI is unparseable, but exposes no record", () => {
    // We observed the edge — that part is real — but we cannot name the
    // record, so unfollow will have to reconcile rather than guess.
    const r = resolveRelationship(answered("not-an-at-uri", null));
    expect(r.state).toBe("following");
    expect(r.followRecord).toBeNull();
  });
});

describe("relationshipsUnavailable", () => {
  const failure = (kind: GraphFailure["kind"]): GraphFailure => ({
    ok: false,
    kind,
    status: kind === "network" ? 0 : 500,
    errorCode: null,
    message: "provider said no",
    rateLimit: null,
  });

  it("maps EVERY requested DID to unknown — and can produce nothing else", () => {
    const dids = ["did:plc:a", "did:plc:b", "did:plc:c"];
    for (const kind of [
      "network",
      "rate_limited",
      "auth",
      "provider_error",
      "not_found",
    ] as const) {
      const results = relationshipsUnavailable(dids, failure(kind));
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.state).toBe("unknown");
        expect(r.followRecord).toBeNull();
        expect(r.unknownReason).toBeTruthy();
      }
    }
  });

  it("says rate limiting means unknown, explicitly not 'unfollowed'", () => {
    const [r] = relationshipsUnavailable(["did:plc:a"], failure("rate_limited"));
    expect(r.unknownReason).toContain("not confirmed as unfollowed");
  });
});

describe("state predicates", () => {
  it("isFollowing covers following and mutual only", () => {
    expect(isFollowing("following")).toBe(true);
    expect(isFollowing("mutual")).toBe(true);
    expect(isFollowing("follows_you")).toBe(false);
    expect(isFollowing("not_following")).toBe(false);
    expect(isFollowing("unknown")).toBe(false);
  });

  it("isFollowedBy covers follows_you and mutual only", () => {
    expect(isFollowedBy("follows_you")).toBe(true);
    expect(isFollowedBy("mutual")).toBe(true);
    expect(isFollowedBy("following")).toBe(false);
    expect(isFollowedBy("unknown")).toBe(false);
  });

  it("labels every state, including unknown", () => {
    for (const state of [
      "unknown",
      "not_following",
      "following",
      "follows_you",
      "mutual",
    ] as const) {
      expect(relationshipLabel(state).length).toBeGreaterThan(0);
    }
    expect(relationshipLabel("unknown")).toBe("Unknown");
  });
});

describe("chunkDids", () => {
  it("chunks to the provider's 30-account maximum", () => {
    const dids = Array.from({ length: 65 }, (_, i) => `did:plc:${i}`);
    const chunks = chunkDids(dids, 30);
    expect(chunks.map((c) => c.length)).toEqual([30, 30, 5]);
    expect(chunks.flat()).toEqual(dids);
  });

  it("returns nothing for an empty list", () => {
    expect(chunkDids([], 30)).toEqual([]);
  });
});
