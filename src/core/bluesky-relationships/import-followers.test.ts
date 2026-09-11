import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./test-support/fake-db";
import { addTargetProfile, importFollowers } from "./import-followers.server";

/**
 * Import integration tests, against a fake that enforces the real
 * unique constraints and the real completion CHECK.
 *
 * The point of using a constraint-enforcing fake rather than a mock is
 * that several of these properties ARE the constraints: "a duplicate
 * import creates no second row" is only meaningfully tested if the
 * thing being written to would have refused one.
 */

const WORKSPACE = "ws-1";
const IDENTITY = "acct-1";
const TARGET_DID = "did:plc:target";

interface PageSpec {
  dids: string[];
  cursor: string | null;
  status?: number;
  body?: unknown;
  rateLimitRemaining?: number;
}

/** A fetch stub that serves a scripted sequence of follower pages. */
function followerFetch(pages: PageSpec[], record?: { urls: string[] }) {
  let index = 0;
  return (async (url: string) => {
    record?.urls.push(url);
    if (url.includes("getProfile")) {
      return new Response(
        JSON.stringify({
          did: TARGET_DID,
          handle: "target.bsky.social",
          displayName: "Target",
          followersCount: 999,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    if (page.status && page.status >= 400) {
      return new Response(JSON.stringify(page.body ?? { error: "Boom" }), {
        status: page.status,
        headers: { "content-type": "application/json" },
      });
    }
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (page.rateLimitRemaining !== undefined) {
      headers["ratelimit-remaining"] = String(page.rateLimitRemaining);
      headers["ratelimit-limit"] = "3000";
    }
    return new Response(
      JSON.stringify({
        followers: page.dids.map((did, i) => ({
          did,
          handle: `follower-${i}.bsky.social`,
          displayName: `Follower ${i}`,
        })),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      }),
      { status: 200, headers },
    );
  }) as unknown as typeof fetch;
}

async function seedTarget(db: FakeDb): Promise<string> {
  const result = await addTargetProfile({
    workspaceId: WORKSPACE,
    operatorAccountId: IDENTITY,
    identifier: "target.bsky.social",
    createdBy: "user-1",
    fetchImpl: followerFetch([{ dids: [], cursor: null }]),
    db: db.client(),
  });
  return result.target!.id;
}

describe("addTargetProfile — resolution and DID identity", () => {
  let db: FakeDb;
  beforeEach(() => {
    db = new FakeDb();
  });

  it("stores the canonical DID and keeps what the operator typed", async () => {
    const result = await addTargetProfile({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      identifier: "@target.bsky.social",
      createdBy: "user-1",
      fetchImpl: followerFetch([{ dids: [], cursor: null }]),
      db: db.client(),
    });
    expect(result.ok).toBe(true);
    expect(result.target?.subject_did).toBe(TARGET_DID);
    // The leading @ is stripped for the provider call but the resolved
    // form is recorded for the audit trail.
    expect(result.target?.requested_identifier).toBe("target.bsky.social");
  });

  it("re-adding the SAME account under a NEW handle updates one row", async () => {
    const first = await addTargetProfile({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      identifier: "old-handle.bsky.social",
      createdBy: "user-1",
      fetchImpl: followerFetch([{ dids: [], cursor: null }]),
      db: db.client(),
    });
    const second = await addTargetProfile({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      identifier: "new-handle.bsky.social",
      createdBy: "user-1",
      fetchImpl: followerFetch([{ dids: [], cursor: null }]),
      db: db.client(),
    });
    expect(second.target?.id).toBe(first.target?.id);
    expect(db.rows("bluesky_target_profiles")).toHaveLength(1);
  });

  it("reports a provider not-found rather than storing a placeholder", async () => {
    const result = await addTargetProfile({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      identifier: "nope.bsky.social",
      createdBy: "user-1",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ error: "InvalidRequest", message: "Profile not found" }),
          { status: 400, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      db: db.client(),
    });
    expect(result.ok).toBe(false);
    expect(db.rows("bluesky_target_profiles")).toHaveLength(0);
  });
});

describe("importFollowers — pagination and completion", () => {
  let db: FakeDb;
  let targetId: string;
  beforeEach(async () => {
    db = new FakeDb();
    targetId = await seedTarget(db);
  });

  it("walks every page and completes only when the cursor runs out", async () => {
    const result = await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      fetchImpl: followerFetch([
        { dids: ["did:plc:a", "did:plc:b"], cursor: "c1" },
        { dids: ["did:plc:c"], cursor: "c2" },
        { dids: ["did:plc:d"], cursor: null },
      ]),
      db: db.client(),
    });
    expect(result.complete).toBe(true);
    expect(result.followersSeen).toBe(4);
    expect(db.rows("bluesky_candidates")).toHaveLength(4);
    const run = db.rows("bluesky_import_runs")[0];
    expect(run.status).toBe("completed");
    expect(run.cursor_exhausted).toBe(true);
  });

  it("does NOT complete on short pages — the verified 5/3/4 shape", async () => {
    // Every page here is shorter than the requested limit, and more
    // data remains. A length-based completion rule would stop at page
    // one and report success.
    const result = await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      pageSize: 100,
      pageBudget: 2,
      startedBy: "user-1",
      fetchImpl: followerFetch([
        { dids: ["did:plc:a", "did:plc:b", "did:plc:c"], cursor: "c1" },
        { dids: ["did:plc:d", "did:plc:e"], cursor: "c2" },
      ]),
      db: db.client(),
    });
    expect(result.complete).toBe(false);
    const run = db.rows("bluesky_import_runs")[0];
    expect(run.status).toBe("paused");
    expect(run.cursor_exhausted).toBe(false);
    expect(run.cursor).toBe("c2");
  });

  it("resumes from the persisted cursor instead of restarting", async () => {
    const record = { urls: [] as string[] };
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      pageBudget: 1,
      startedBy: "user-1",
      fetchImpl: followerFetch([{ dids: ["did:plc:a"], cursor: "cursor-page-2" }]),
      db: db.client(),
    });

    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      pageBudget: 1,
      startedBy: "user-1",
      fetchImpl: followerFetch([{ dids: ["did:plc:b"], cursor: null }], record),
      db: db.client(),
    });

    const followerCalls = record.urls.filter((u) => u.includes("getFollowers"));
    expect(followerCalls[0]).toContain("cursor=cursor-page-2");
    // One run, continued — not two runs racing each other.
    expect(db.rows("bluesky_import_runs")).toHaveLength(1);
    expect(db.rows("bluesky_import_runs")[0].followers_seen).toBe(2);
    expect(db.rows("bluesky_import_runs")[0].cursor_exhausted).toBe(true);
  });

  it("recovers from a mid-import failure without advancing the cursor", async () => {
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      pageBudget: 5,
      startedBy: "user-1",
      fetchImpl: followerFetch([
        { dids: ["did:plc:a"], cursor: "cursor-2" },
        { dids: [], cursor: null, status: 502, body: { error: "UpstreamFailure" } },
      ]),
      db: db.client(),
    });

    const run = db.rows("bluesky_import_runs")[0];
    expect(run.status).toBe("failed");
    expect(run.cursor).toBe("cursor-2");
    expect(run.cursor_exhausted).toBe(false);
    // The page that succeeded is kept; the one that failed is not lost,
    // it is simply still pending behind the same cursor.
    expect(db.rows("bluesky_candidates")).toHaveLength(1);

    const resumed = await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      fetchImpl: followerFetch([{ dids: ["did:plc:b"], cursor: null }]),
      db: db.client(),
    });
    expect(resumed.complete).toBe(true);
    expect(db.rows("bluesky_candidates")).toHaveLength(2);
  });

  it("pauses before the provider's rate-limit window is spent", async () => {
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      pageBudget: 10,
      startedBy: "user-1",
      fetchImpl: followerFetch([
        { dids: ["did:plc:a"], cursor: "c1", rateLimitRemaining: 5 },
      ]),
      db: db.client(),
    });
    const run = db.rows("bluesky_import_runs")[0];
    expect(run.status).toBe("paused");
    expect(run.stop_reason).toBe("rate_limited");
    expect(run.cursor).toBe("c1");
  });

  it("queries the provider by DID, never by the stored handle", async () => {
    const record = { urls: [] as string[] };
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      fetchImpl: followerFetch([{ dids: [], cursor: null }], record),
      db: db.client(),
    });
    const call = record.urls.find((u) => u.includes("getFollowers"))!;
    expect(call).toContain(encodeURIComponent(TARGET_DID));
    expect(call).not.toContain("target.bsky.social");
  });
});

describe("importFollowers — deduplication by DID", () => {
  let db: FakeDb;
  let targetId: string;
  beforeEach(async () => {
    db = new FakeDb();
    targetId = await seedTarget(db);
  });

  it("a duplicate import creates no second candidate row", async () => {
    const pages = () => followerFetch([{ dids: ["did:plc:a", "did:plc:b"], cursor: null }]);
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      fetchImpl: pages(),
      db: db.client(),
    });
    const second = await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      restart: true,
      fetchImpl: pages(),
      db: db.client(),
    });
    expect(db.rows("bluesky_candidates")).toHaveLength(2);
    expect(second.candidatesCreated).toBe(0);
    expect(second.candidatesUpdated).toBe(2);
  });

  it("a changed handle updates metadata and loses no history", async () => {
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      fetchImpl: followerFetch([{ dids: ["did:plc:renamed"], cursor: null }]),
      db: db.client(),
    });

    // Give the row the kind of state a rename must not destroy.
    const candidate = db.rows("bluesky_candidates")[0];
    const originalId = candidate.id;
    const firstDiscovered = candidate.first_discovered_at;
    candidate.relationship_state = "following";
    candidate.follow_rkey = "3keep";
    candidate.follow_uri = "at://did:plc:me/app.bsky.graph.follow/3keep";
    candidate.protected = true;

    // Same DID comes back with a different handle.
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      restart: true,
      fetchImpl: (async (url: string) => {
        if (url.includes("getProfile")) {
          return new Response(JSON.stringify({ did: TARGET_DID, handle: "t" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            followers: [
              {
                did: "did:plc:renamed",
                handle: "brand-new-handle.bsky.social",
                displayName: "Renamed",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
      db: db.client(),
    });

    expect(db.rows("bluesky_candidates")).toHaveLength(1);
    const after = db.rows("bluesky_candidates")[0];
    expect(after.id).toBe(originalId);
    expect(after.handle).toBe("brand-new-handle.bsky.social");
    // Everything keyed off the row survives the rename.
    expect(after.first_discovered_at).toBe(firstDiscovered);
    expect(after.relationship_state).toBe("following");
    expect(after.follow_rkey).toBe("3keep");
    expect(after.protected).toBe(true);
  });

  it("one DID found under two targets is ONE candidate with TWO sources", async () => {
    const secondTarget = await addTargetProfile({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      identifier: "other.bsky.social",
      createdBy: "user-1",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ did: "did:plc:other-target", handle: "other.bsky.social" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
      db: db.client(),
    });

    const shared = followerFetch([{ dids: ["did:plc:shared"], cursor: null }]);
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      fetchImpl: shared,
      db: db.client(),
    });
    await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: IDENTITY,
      targetProfileId: secondTarget.target!.id,
      startedBy: "user-1",
      fetchImpl: followerFetch([{ dids: ["did:plc:shared"], cursor: null }]),
      db: db.client(),
    });

    expect(db.rows("bluesky_candidates")).toHaveLength(1);
    const sources = db.rows("bluesky_candidate_sources");
    expect(sources).toHaveLength(2);
    // The first attribution is not replaced by the second.
    expect(new Set(sources.map((s) => s.target_profile_id))).toEqual(
      new Set([targetId, secondTarget.target!.id]),
    );
  });

  it("a re-sighting increments times_seen without losing first_seen_at", async () => {
    const run = () =>
      importFollowers({
        workspaceId: WORKSPACE,
        operatorAccountId: IDENTITY,
        targetProfileId: targetId,
        startedBy: "user-1",
        restart: true,
        fetchImpl: followerFetch([{ dids: ["did:plc:a"], cursor: null }]),
        db: db.client(),
      });
    await run();
    const firstSeen = db.rows("bluesky_candidate_sources")[0].first_seen_at;
    await run();
    expect(db.rows("bluesky_candidate_sources")).toHaveLength(1);
    expect(db.rows("bluesky_candidate_sources")[0].times_seen).toBe(2);
    expect(db.rows("bluesky_candidate_sources")[0].first_seen_at).toBe(firstSeen);
  });
});

describe("importFollowers — workspace and identity scope", () => {
  it("refuses a target belonging to another workspace", async () => {
    const db = new FakeDb();
    const targetId = await seedTarget(db);
    const result = await importFollowers({
      workspaceId: "ws-OTHER",
      operatorAccountId: IDENTITY,
      targetProfileId: targetId,
      startedBy: "user-1",
      fetchImpl: followerFetch([{ dids: ["did:plc:a"], cursor: null }]),
      db: db.client(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not in this workspace");
    expect(db.rows("bluesky_candidates")).toHaveLength(0);
  });

  it("refuses a target belonging to another identity in the same workspace", async () => {
    const db = new FakeDb();
    const targetId = await seedTarget(db);
    const result = await importFollowers({
      workspaceId: WORKSPACE,
      operatorAccountId: "acct-OTHER",
      targetProfileId: targetId,
      startedBy: "user-1",
      fetchImpl: followerFetch([{ dids: ["did:plc:a"], cursor: null }]),
      db: db.client(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("different identity");
    expect(db.rows("bluesky_candidates")).toHaveLength(0);
  });
});
