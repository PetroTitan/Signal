import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  ACTOR_DID,
  createUnfollowFixture,
  makeMembers,
  makeRun,
  makeUnfollowCampaign,
  mockSession,
  providerDouble,
  type UnfollowFixture,
} from "./test-support/harness";

vi.mock("@/core/bluesky-relationships/session.server", () => mockSession());

import { processUnfollowChunk } from "./worker.server";

/**
 * Delete safety, against the REAL migration.
 *
 * Every RPC these tests exercise is the one that deploys — claimed,
 * consumed, folded and settled by the shipped SQL, not by a TypeScript
 * stand-in. The assertions are almost all counts of `deleteRecord`
 * calls, because that number is the only one that corresponds to
 * something happening to a real person's account.
 */

let f: UnfollowFixture;
const NOW = new Date("2026-09-14T12:00:00Z");
const TODAY = "2026-09-14";

beforeAll(async () => {
  f = await createUnfollowFixture("delete-safety");
}, 180_000);
afterAll(async () => { await f?.close(); });

async function campaign(name: string, opts = {}) {
  return makeUnfollowCampaign(f, name, opts);
}

async function reserve(campaignId: string, runId: string, chunk = 20) {
  const r = await f.db.query<{
    reserved: number;
    reservation_id: string;
    reason: string;
    member_id: string | null;
    subject_did: string | null;
    current_handle: string | null;
    import_sequence: string | null;
    attempt_count: number | null;
    provider_record_rkey: string | null;
  }>(
    `select * from public.reserve_bluesky_campaign_quota(
       $1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10)`,
    [
      f.tenant.workspaceId, campaignId, runId, f.tenant.identityId, TODAY,
      100, 1000, chunk, 300, "test-worker",
    ],
  );
  const rows = r.rows.filter((x) => x.member_id !== null);
  return {
    reservationId: r.rows[0]?.reservation_id ?? null,
    reason: r.rows[0]?.reason ?? "queue_empty",
    reserved: rows.length,
    members: rows.map((x) => ({
      id: x.member_id as string,
      subject_did: x.subject_did as string,
      current_handle: x.current_handle,
      import_sequence: Number(x.import_sequence ?? 0),
      attempt_count: Number(x.attempt_count ?? 0),
      provider_record_rkey: x.provider_record_rkey,
    })),
  };
}

async function campaignRow(id: string) {
  const r = await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaigns where id = $1`,
    [id],
  );
  return r.rows[0];
}

async function memberRow(id: string) {
  const r = await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaign_members where id = $1`,
    [id],
  );
  return r.rows[0];
}

async function actionRows(campaignId: string) {
  const r = await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_relationship_actions
      where campaign_id = $1 order by created_at, id`,
    [campaignId],
  );
  return r.rows;
}

async function run(
  campaignId: string,
  runId: string,
  provider: ReturnType<typeof providerDouble>,
  over: Record<string, unknown> = {},
) {
  const res = await reserve(campaignId, runId);
  const c = await campaignRow(campaignId);
  return processUnfollowChunk({
    campaign: c as never,
    runId,
    session: {
      ok: true,
      actorDid: ACTOR_DID,
      actorHandle: "operator.bsky.social",
      accessJwt: "jwt",
      service: "https://bsky.social",
      refreshOnce: async () => ({ ok: false, message: "no" }),
    } as never,
    members: res.members,
    reservationId: res.reservationId as string,
    quotaRemaining: res.reserved,
    consecutiveFailures: 0,
    claimedBy: "test-worker",
    initiatedBy: f.tenant.ownerId,
    now: NOW,
    fetchImpl: provider.fetchImpl,
    db: f.client,
    sleep: async () => undefined,
    interRequestMs: 0,
    ...over,
  });
}

// =====================================================================

describe("the exact record, and nothing else", () => {
  it("deletes the record the PROVIDER reports, in the acting repo and the follow collection", async () => {
    const c = await campaign("exact record");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [{ did: "did:plc:exact", sequence: 1 }]);

    const provider = providerDouble({
      relationships: {
        "did:plc:exact": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });

    const chunk = await run(c, r, provider);

    expect(provider.deletes).toHaveLength(1);
    expect(provider.deletes[0]).toMatchObject({
      rkey: "rk-1",
      repo: ACTOR_DID,
      collection: "app.bsky.graph.follow",
    });
    expect(chunk.succeeded).toBe(1);
    expect(chunk.recordsDeleted).toBe(1);

    const member = await memberRow(m);
    expect(member.status).toBe("succeeded");

    // The action row records the record that WAS deleted — which is
    // also how settlement tells a destruction from a no-op.
    const actions = await actionRows(c);
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe("unfollow");
    expect(actions[0].status).toBe("succeeded");
    expect(actions[0].follow_rkey).toBe("rk-1");
    expect(actions[0].follow_uri).toBe(
      `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
    );
    // Cleared on every terminal path.
    expect(actions[0].provider_in_flight_at).toBeNull();
  });

  it("A STALE STORED RKEY IS NEVER USED — the fresh one wins", async () => {
    // THE DEFECT THIS PREVENTS.
    //
    // A queue can be frozen for weeks. In that time the operator may
    // unfollow by hand and follow again, which mints a NEW record under
    // a NEW key and destroys the old one. Deleting the STORED key would
    // SUCCEED — deleteRecord "ensures it doesn't exist", and it already
    // doesn't — so Signal would report an unfollow while the live
    // follow stayed exactly where it was.
    const c = await campaign("stale rkey");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:stale", sequence: 1, storedRkey: "OLD-KEY" },
    ]);

    const provider = providerDouble({
      relationships: {
        "did:plc:stale": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/NEW-KEY`,
        },
      },
    });

    await run(c, r, provider);

    expect(provider.deletes).toHaveLength(1);
    expect(provider.deletes[0].rkey).toBe("NEW-KEY");
    expect(provider.deletes.map((d) => d.rkey)).not.toContain("OLD-KEY");

    // And the queue is corrected, so the audit trail names what was
    // actually removed.
    const member = await memberRow(m);
    expect(member.provider_record_rkey).toBe("NEW-KEY");
    expect(member.provider_record_source).toBe("relationship_read");
  });

  it("a stale CID is NOT sent as swapRecord for a different record", async () => {
    // `swapRecord` is a compare-and-swap. Sending the old record's CID
    // against the new record would make the PDS refuse a delete that is
    // perfectly correct — a self-inflicted failure.
    const c = await campaign("stale cid");
    const r = await makeRun(f, c, TODAY);
    await makeMembers(f, c, [
      {
        did: "did:plc:stalecid",
        sequence: 1,
        storedRkey: "OLD",
        storedCid: "bafyOLDCID",
      },
    ]);

    const provider = providerDouble({
      relationships: {
        "did:plc:stalecid": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/NEW`,
        },
      },
    });

    await run(c, r, provider);
    expect(provider.deletes[0].rkey).toBe("NEW");
    expect(provider.deletes[0].swap).toBeUndefined();
  });

  it("the CID IS sent when it describes the same record", async () => {
    const c = await campaign("matching cid");
    const r = await makeRun(f, c, TODAY);
    await makeMembers(f, c, [
      {
        did: "did:plc:samecid",
        sequence: 1,
        storedRkey: "SAME",
        storedCid: "bafySAME",
      },
    ]);
    const provider = providerDouble({
      relationships: {
        "did:plc:samecid": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/SAME`,
        },
      },
    });
    await run(c, r, provider);
    expect(provider.deletes[0].swap).toBe("bafySAME");
  });

  it("a following URI naming ANOTHER repository is refused, not deleted", async () => {
    const c = await campaign("wrong repo");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:wrongrepo", sequence: 1 },
    ]);

    const provider = providerDouble({
      relationships: {
        "did:plc:wrongrepo": {
          following: "at://did:plc:SOMEONEELSE/app.bsky.graph.follow/rk-1",
        },
      },
    });

    const chunk = await run(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    expect(chunk.failed).toBe(1);
    const member = await memberRow(m);
    expect(member.status).toBe("failed_structural");
    expect(String(member.last_error_message)).toMatch(
      /different Bluesky account/i,
    );
  });

  it("a following URI in ANOTHER collection is refused, not deleted", async () => {
    // An rkey is only unique within a collection. The same key can name
    // a like, a block or a post, and deleteRecord takes the collection
    // as a parameter — so a wrong collection deletes a real record of
    // the wrong kind.
    const c = await campaign("wrong collection");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:wrongcoll", sequence: 1 },
    ]);
    const provider = providerDouble({
      relationships: {
        "did:plc:wrongcoll": {
          following: `at://${ACTOR_DID}/app.bsky.feed.like/rk-1`,
        },
      },
    });

    await run(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    const member = await memberRow(m);
    expect(member.status).toBe("failed_structural");
    expect(String(member.last_error_message)).toMatch(/not a follow/i);
  });

  it("an unparseable following URI becomes UNKNOWN, never a guessed key", async () => {
    const c = await campaign("unparseable uri");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:badURI", sequence: 1 },
    ]);
    const provider = providerDouble({
      relationships: { "did:plc:badURI": { following: "not-an-at-uri" } },
    });

    await run(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    const member = await memberRow(m);
    // Retryable, not terminal: we know the edge exists and simply could
    // not identify the record this time.
    expect(member.status).toBe("retryable");
    // And no action row at all — nothing was intended.
    expect(await actionRows(c)).toHaveLength(0);
  });
});

describe("already not following — the neutral success", () => {
  it("consumes NO quota and sends NO delete", async () => {
    const c = await campaign("already absent");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:absent", sequence: 1 },
    ]);

    // The provider answers, and reports no `following` key. That is a
    // real observation of absence, which is the only thing that
    // produces this branch.
    const provider = providerDouble({
      relationships: { "did:plc:absent": {} },
    });

    const chunk = await run(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    expect(chunk.alreadyNotFollowing).toBe(1);
    expect(chunk.quotaConsumed).toBe(0);
    expect(chunk.attempted).toBe(0);

    const member = await memberRow(m);
    expect(member.status).toBe("already_not_following");

    // No ledger intent was stamped, so the day's books show no attempt.
    const ledger = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_campaign_attempt_ledger
        where member_id = $1 and provider_intent_at is not null`,
      [m],
    );
    expect(ledger.rows[0].n).toBe("0");

    // The audit row exists and has a NULL follow_uri — which is exactly
    // how settlement tells "nothing to destroy" from "destroyed".
    const actions = await actionRows(c);
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe("succeeded");
    expect(actions[0].follow_uri).toBeNull();
    expect(actions[0].reconciled_state).toBe("not_following");
  });

  it("a FAILED relationship lookup is unknown, never already-absent", async () => {
    // The rule the whole relationship subsystem is built on: a failure
    // to observe is not an observation of absence. Collapsing them
    // would turn an outage into a wave of members wrongly recorded as
    // already unfollowed — and the operator would never learn that the
    // people they wanted unfollowed still are followed.
    const c = await campaign("lookup failed");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:outage", sequence: 1 },
    ]);
    const provider = providerDouble({
      relationshipsFail: { status: 500, body: { error: "InternalServerError" } },
    });

    const chunk = await run(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    expect(chunk.alreadyNotFollowing).toBe(0);
    const member = await memberRow(m);
    expect(member.status).toBe("retryable");
    expect(String(member.last_error_code)).toBe("relationship_unknown");
  });

  it("a DID the provider omitted is unknown, never already-absent", async () => {
    const c = await campaign("omitted did");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:omitted", sequence: 1 },
    ]);
    // `relationships: {}` means the double returns #notFoundActor.
    const provider = providerDouble({ relationships: {} });

    await run(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    const member = await memberRow(m);
    expect(member.status).toBe("retryable");
  });
});

describe("a dry run makes zero Bluesky mutations", () => {
  it("sends no delete, spends no quota unit, and is recorded as skipped", async () => {
    const c = await campaign("dry run", { dryRun: true });
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:dryrun", sequence: 1 },
    ]);
    const provider = providerDouble({
      relationships: {
        "did:plc:dryrun": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });

    const chunk = await run(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    expect(provider.creates).toHaveLength(0);
    expect(chunk.quotaConsumed).toBe(0);

    const member = await memberRow(m);
    expect(member.status).toBe("skipped");

    // The unit is spent at provider intent, and a dry run never reaches
    // it — so the ledger shows no intent and the day's quota is intact.
    const ledger = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_campaign_attempt_ledger
        where member_id = $1 and provider_intent_at is not null`,
      [m],
    );
    expect(ledger.rows[0].n).toBe("0");

    const runRow = await f.db.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id = $1`,
      [r],
    );
    expect(Number(runRow.rows[0].attempted_count)).toBe(0);
  });
});
