import { describe, expect, it } from "vitest";
import {
  getFollowers,
  getRelationships,
  resolveProfile,
  rkeyFromAtUri,
} from "./atproto-graph";
import { resolveRelationship } from "./relationship-state";
import { applyPage } from "./import-plan";

/**
 * READ-ONLY smoke test against the LIVE Bluesky API.
 *
 * Skipped unless `BLUESKY_LIVE_SMOKE=1`, so the ordinary suite stays
 * hermetic and fast. Run it with:
 *
 *   BLUESKY_LIVE_SMOKE=1 npx vitest run src/core/bluesky-relationships/live-smoke.test.ts
 *
 * It exercises the shipped client functions rather than curl, so what
 * is verified is the code that runs in production — including the
 * parsing, the limit clamping, and the unknown-vs-not_following
 * distinction.
 *
 * Every endpoint here is a READ. No write endpoint is referenced in
 * this file: there is no import of `createFollowRecord` or
 * `deleteFollowRecord`, and no real relationship is created or deleted
 * to demonstrate anything. Verifying a mutation would mean following
 * or unfollowing a real person's real account, which is not something
 * to do for a test.
 *
 * The reads all go to the public AppView, which requires no
 * credentials, so this needs no secrets and touches no operator
 * session.
 */

const LIVE = process.env.BLUESKY_LIVE_SMOKE === "1";
const suite = LIVE ? describe : describe.skip;

/** A large, stable, public account. Chosen for follower-list depth. */
const SUBJECT = "bsky.app";

suite("live Bluesky (read-only)", () => {
  it("resolves a handle to a DID and back to the same account", async () => {
    const byHandle = await resolveProfile({ actor: SUBJECT });
    expect(byHandle.ok).toBe(true);
    if (!byHandle.ok) return;
    expect(byHandle.profile.did).toMatch(/^did:/);

    const byDid = await resolveProfile({ actor: byHandle.profile.did });
    expect(byDid.ok).toBe(true);
    if (!byDid.ok) return;
    expect(byDid.profile.did).toBe(byHandle.profile.did);
  }, 30_000);

  it("classifies a nonexistent handle as not_found, not as a generic error", async () => {
    const missing = await resolveProfile({
      actor: "definitely-not-a-real-handle-91827.bsky.social",
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.kind).toBe("not_found");
  }, 30_000);

  it("paginates followers, and never completes while a cursor remains", async () => {
    const profile = await resolveProfile({ actor: SUBJECT });
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;

    let cursor: string | null = null;
    let state = {
      status: "running" as const,
      cursor: null as string | null,
      cursorExhausted: false,
      pagesFetched: 0,
      followersSeen: 0,
    };
    const dids: string[] = [];

    for (let i = 0; i < 3; i += 1) {
      const page = await getFollowers({
        // By DID: the target's handle may have changed since it was added.
        actor: profile.profile.did,
        limit: 5,
        cursor,
      });
      expect(page.ok).toBe(true);
      if (!page.ok) return;

      const progress = applyPage({
        state,
        page: page.page,
        newFollowerCount: page.page.followers.length,
        pageBudget: 99,
      });

      // The account has tens of millions of followers, so every page in
      // this window carries a cursor and the run must never complete.
      expect(page.page.cursor).not.toBeNull();
      expect(progress.status).toBe("running");
      expect(progress.cursorExhausted).toBe(false);

      dids.push(...page.page.followers.map((f) => f.did));
      cursor = page.page.cursor;
      state = {
        status: "running",
        cursor: progress.cursor,
        cursorExhausted: progress.cursorExhausted,
        pagesFetched: progress.pagesFetched,
        followersSeen: progress.followersSeen,
      };
    }

    expect(dids.length).toBeGreaterThan(0);
    // Deduplication is meaningful only if the provider does not repeat.
    expect(new Set(dids).size).toBe(dids.length);
    for (const did of dids) expect(did).toMatch(/^did:/);
  }, 60_000);

  it("returns an observation for every requested DID", async () => {
    const profile = await resolveProfile({ actor: SUBJECT });
    if (!profile.ok) return;
    const page = await getFollowers({ actor: profile.profile.did, limit: 10 });
    if (!page.ok) return;

    const others = page.page.followers.map((f) => f.did);
    const rel = await getRelationships({ actor: profile.profile.did, others });
    expect(rel.ok).toBe(true);
    if (!rel.ok) return;

    // Not "most of them" — every one, so no caller can fill a gap with
    // a default.
    for (const did of others) {
      expect(rel.observations.has(did)).toBe(true);
      const resolved = resolveRelationship(rel.observations.get(did)!);
      expect([
        "unknown",
        "not_following",
        "following",
        "follows_you",
        "mutual",
      ]).toContain(resolved.state);
    }
  }, 60_000);

  it("refuses more than 30 others rather than silently truncating", async () => {
    const profile = await resolveProfile({ actor: SUBJECT });
    if (!profile.ok) return;
    const result = await getRelationships({
      actor: profile.profile.did,
      others: Array.from({ length: 31 }, (_, i) => `did:plc:notreal${i}`),
    });
    expect(result.ok).toBe(false);
  }, 30_000);

  it("treats an unresolvable DID as an ANSWERED 'no edge', not as unknown", async () => {
    const profile = await resolveProfile({ actor: SUBJECT });
    if (!profile.ok) return;
    const result = await getRelationships({
      actor: profile.profile.did,
      others: ["did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observation = result.observations.get("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")!;
    // The provider DID answer — with an object carrying neither key —
    // so this is a real observation of no relationship, distinct from
    // the unknown a transport failure produces.
    expect(observation.known).toBe(true);
    expect(resolveRelationship(observation).state).toBe("not_following");
  }, 30_000);

  it("parses a real follow-record URI into a usable record key", async () => {
    const profile = await resolveProfile({ actor: SUBJECT });
    if (!profile.ok) return;
    const page = await getFollowers({ actor: profile.profile.did, limit: 10 });
    if (!page.ok) return;
    const rel = await getRelationships({
      actor: profile.profile.did,
      others: page.page.followers.map((f) => f.did),
    });
    if (!rel.ok) return;

    const edges = [...rel.observations.values()].flatMap((o) =>
      o.known ? [o.followingUri, o.followedByUri].filter(Boolean) : [],
    ) as string[];
    // Everyone in a follower list follows the subject, so followedBy is
    // guaranteed to be populated.
    expect(edges.length).toBeGreaterThan(0);

    for (const uri of edges) {
      expect(uri).toMatch(/^at:\/\/did:[^/]+\/app\.bsky\.graph\.follow\/.+$/);
      const rkey = rkeyFromAtUri(uri);
      expect(rkey).toBeTruthy();
      // The key is the URI's own last segment and nothing else.
      expect(uri.endsWith(`/${rkey}`)).toBe(true);
    }
  }, 60_000);
});
