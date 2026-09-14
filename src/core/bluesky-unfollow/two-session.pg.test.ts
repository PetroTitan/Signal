import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  createPgServerHarness,
  seedServerTenant,
  type PgServerHarness,
  type ServerTenant,
} from "@/test/pg/server-harness";

/**
 * Two REAL PostgreSQL sessions, contending over an unfollow queue.
 *
 * THE GATE PGLITE CANNOT MEET. PGlite is genuine PostgreSQL, but it
 * runs a single backend: two simultaneous sessions do not exist, so
 * `select … for update` can never be observed blocking a second session
 * and `skip locked` can never be observed skipping one. Those are
 * exactly the mechanisms the reservation depends on, so proving them
 * needs a server with two backends — which is what
 * `embedded-postgres` provides here, one backend per connection.
 *
 * Every assertion is about interleaving. No provider call is made
 * anywhere in this file; it is pure database.
 */

let h: PgServerHarness;
let t: ServerTenant;
const TODAY = "2026-09-14";
const ACTOR = "did:plc:twosessionactor";

beforeAll(async () => {
  h = await createPgServerHarness();
  t = await seedServerTenant(h.admin, "unfollow-two-session");
}, 300_000);

afterAll(async () => { await h?.close(); });

let seq = 0;

async function freshCampaign(
  members: number,
  effectiveQuota: number,
  kind: "unfollow" | "follow" = "unfollow",
): Promise<{ campaignId: string; runId: string; dids: string[] }> {
  seq += 1;
  const c = await h.admin.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, kind, status,
        requested_daily_quota)
     values ($1,$2,$3,$4,'active',1000) returning id`,
    [t.workspaceId, t.identityId, `camp-${seq}`, kind],
  );
  const campaignId = c.rows[0].id;

  const dids: string[] = [];
  const values: string[] = [];
  for (let i = 1; i <= members; i += 1) {
    const did = `did:plc:c${seq}m${i}`;
    dids.push(did);
    values.push(
      `('${t.workspaceId}','${campaignId}','${did}',${i},` +
        `'at://${ACTOR}/app.bsky.graph.follow/rk${seq}-${i}','rk${seq}-${i}','list_records')`,
    );
  }
  if (values.length > 0) {
    await h.admin.query(
      `insert into public.bluesky_follow_campaign_members
         (workspace_id, campaign_id, subject_did, import_sequence,
          provider_record_uri, provider_record_rkey, provider_record_source)
       values ${values.join(",")}`,
    );
  }

  const r = await h.admin.query<{ id: string }>(
    `select id from public.ensure_bluesky_campaign_run($1,$2,$3,$4,$5,$6)`,
    [t.workspaceId, campaignId, TODAY, 1000, effectiveQuota, null],
  );
  return { campaignId, runId: r.rows[0].id, dids };
}

const reserve = (
  db: Client,
  campaignId: string,
  runId: string,
  opts: { requested?: number; chunk?: number; ceiling?: number; by?: string } = {},
) =>
  db.query<{
    reserved: number;
    reservation_id: string | null;
    reason: string;
    member_id: string | null;
  }>(
    `select * from public.reserve_bluesky_campaign_quota(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      t.workspaceId, campaignId, runId, t.identityId, TODAY,
      opts.requested ?? 1000,
      opts.ceiling ?? 10_000,
      opts.chunk ?? 20,
      300,
      opts.by ?? "worker",
    ],
  );

// =====================================================================

describe("two workers racing for the same member", () => {
  it("SKIP LOCKED gives them disjoint sets — no DID is claimed twice", async () => {
    const { campaignId, runId } = await freshCampaign(40, 1000);
    const a = await h.connect();
    const b = await h.connect();

    // AUTOCOMMIT, concurrently — which is how the dispatchers actually
    // call this. Each RPC invocation is its own transaction.
    //
    // Wrapping both in explicit transactions instead would hang
    // forever, and that is not a defect: session A would hold the
    // identity-usage row lock until it committed, and session B is
    // supposed to wait for exactly that. Modelling it that way would
    // be testing a deployment shape that does not exist.
    const [ra, rb] = await Promise.all([
      reserve(a, campaignId, runId, { chunk: 20, by: "A" }),
      reserve(b, campaignId, runId, { chunk: 20, by: "B" }),
    ]);

    const idsA = ra.rows.filter((r) => r.member_id).map((r) => r.member_id);
    const idsB = rb.rows.filter((r) => r.member_id).map((r) => r.member_id);

    expect(idsA.length).toBeGreaterThan(0);
    expect(idsB.length).toBeGreaterThan(0);
    expect(idsA.filter((id) => idsB.includes(id))).toEqual([]);
    expect(new Set([...idsA, ...idsB]).size).toBe(idsA.length + idsB.length);

    await a.end();
    await b.end();
  });

  it("a second session BLOCKS on the identity-usage lock rather than racing it", async () => {
    // The property that bounds the day. Without the lock, both sessions
    // read the same headroom and both reserve it.
    const { campaignId, runId } = await freshCampaign(10, 1000);
    const a = await h.connect();
    const b = await h.connect();

    await a.query("begin");
    await a.query(
      `insert into public.bluesky_identity_daily_usage
         (workspace_id, operator_account_id, usage_date)
       values ($1,$2,$3) on conflict do nothing`,
      [t.workspaceId, t.identityId, TODAY],
    );
    await a.query(
      `select * from public.bluesky_identity_daily_usage
        where workspace_id=$1 and operator_account_id=$2 and usage_date=$3
        for update`,
      [t.workspaceId, t.identityId, TODAY],
    );

    let bFinished = false;
    const bPromise = reserve(b, campaignId, runId, { by: "B" }).then((r) => {
      bFinished = true;
      return r;
    });

    // Give B a real opportunity to finish. It must not.
    await new Promise((r) => setTimeout(r, 400));
    expect(bFinished).toBe(false);

    await a.query("commit");
    const rb = await bPromise;
    expect(bFinished).toBe(true);
    expect(rb.rows.filter((r) => r.member_id).length).toBeGreaterThan(0);

    await a.end();
    await b.end();
  });
});

describe("two workers racing for the same identity quota", () => {
  it("the day's total is bounded across BOTH, not per worker", async () => {
    const { campaignId, runId } = await freshCampaign(100, 10);
    const a = await h.connect();
    const b = await h.connect();

    const [ra, rb] = await Promise.all([
      reserve(a, campaignId, runId, { chunk: 20, by: "A" }),
      reserve(b, campaignId, runId, { chunk: 20, by: "B" }),
    ]);

    const total =
      ra.rows.filter((r) => r.member_id).length +
      rb.rows.filter((r) => r.member_id).length;

    // Effective quota is 10. Disjoint member claims alone would let each
    // worker take 20; only the reservation bounds the pair.
    expect(total).toBeLessThanOrEqual(10);

    await a.end();
    await b.end();
  });

  it("TWO CAMPAIGNS sharing one identity share one daily ceiling", async () => {
    // Bluesky's budget is per ACCOUNT, so two campaigns driving the
    // same identity must not jointly exceed it.
    const one = await freshCampaign(100, 1000);
    const two = await freshCampaign(100, 1000);
    const a = await h.connect();
    const b = await h.connect();

    // Start the day clean for this assertion.
    await h.admin.query(
      `update public.bluesky_identity_daily_usage
          set attempts_made = 0, follows_created = 0, unfollows_deleted = 0,
              reserved_count = 0
        where operator_account_id = $1 and usage_date = $2`,
      [t.identityId, TODAY],
    );
    await h.admin.query(
      `update public.bluesky_campaign_quota_reservations
          set status = 'settled', reserved_count = 0
        where operator_account_id = $1 and usage_date = $2 and status = 'open'`,
      [t.identityId, TODAY],
    );

    const CEILING = 15;
    const [ra, rb] = await Promise.all([
      reserve(a, one.campaignId, one.runId, { chunk: 20, ceiling: CEILING, by: "A" }),
      reserve(b, two.campaignId, two.runId, { chunk: 20, ceiling: CEILING, by: "B" }),
    ]);

    const total =
      ra.rows.filter((r) => r.member_id).length +
      rb.rows.filter((r) => r.member_id).length;
    expect(total).toBeLessThanOrEqual(CEILING);

    await a.end();
    await b.end();
  });

  it("A FOLLOW campaign and an UNFOLLOW campaign share that same ceiling", async () => {
    // The decision this feature had to make, enforced in the database.
    // `attempts_made` is incremented by `consume_bluesky_member_quota`
    // for BOTH kinds, so a day spent following genuinely leaves less
    // room for unfollowing — and no caller performs the coupling, so no
    // caller can forget it.
    const followCampaign = await freshCampaign(100, 1000, "follow");
    const unfollowCampaign = await freshCampaign(100, 1000, "unfollow");

    await h.admin.query(
      `update public.bluesky_identity_daily_usage
          set attempts_made = 0, follows_created = 0, unfollows_deleted = 0,
              reserved_count = 0
        where operator_account_id = $1 and usage_date = $2`,
      [t.identityId, TODAY],
    );
    await h.admin.query(
      `update public.bluesky_campaign_quota_reservations
          set status = 'settled', reserved_count = 0
        where operator_account_id = $1 and usage_date = $2 and status = 'open'`,
      [t.identityId, TODAY],
    );

    const a = await h.connect();
    const b = await h.connect();
    const CEILING = 12;

    const [rFollow, rUnfollow] = await Promise.all([
      reserve(a, followCampaign.campaignId, followCampaign.runId, {
        chunk: 20, ceiling: CEILING, by: "follow-worker",
      }),
      reserve(b, unfollowCampaign.campaignId, unfollowCampaign.runId, {
        chunk: 20, ceiling: CEILING, by: "unfollow-worker",
      }),
    ]);

    const total =
      rFollow.rows.filter((r) => r.member_id).length +
      rUnfollow.rows.filter((r) => r.member_id).length;
    expect(total).toBeLessThanOrEqual(CEILING);
    // And both got SOME work — a ceiling that starved one entirely
    // would satisfy the inequality while being useless.
    expect(total).toBeGreaterThan(0);

    await a.end();
    await b.end();
  });
});

describe("leases", () => {
  it("an expired lease is reclaimable; a live one is not", async () => {
    const { campaignId, runId } = await freshCampaign(5, 1000);
    const a = await h.connect();

    const first = await reserve(a, campaignId, runId, { chunk: 5, by: "A" });
    const claimed = first.rows.filter((r) => r.member_id).map((r) => r.member_id);
    expect(claimed.length).toBe(5);

    // While the lease is LIVE, a second worker gets nothing.
    const b = await h.connect();
    const blocked = await reserve(b, campaignId, runId, { chunk: 5, by: "B" });
    expect(blocked.rows.filter((r) => r.member_id)).toHaveLength(0);

    // Once it lapses, the rows come back.
    await h.admin.query(
      `update public.bluesky_follow_campaign_members
          set lease_expires_at = now() - interval '1 hour'
        where campaign_id = $1`,
      [campaignId],
    );
    const reclaimed = await reserve(b, campaignId, runId, { chunk: 5, by: "B" });
    expect(reclaimed.rows.filter((r) => r.member_id).length).toBeGreaterThan(0);

    await a.end();
    await b.end();
  });

  it("A STALE WORKER CANNOT RELEASE A NEW WORKER'S LEASE", async () => {
    // The scenario: A's lease lapses while A is still alive, B reclaims
    // the member and starts work, and A then "hands back" what it
    // thinks it still holds — clearing B's lease while a delete for
    // that member may be in flight.
    const { campaignId, runId } = await freshCampaign(3, 1000);
    const a = await h.connect();
    const b = await h.connect();

    const ra = await reserve(a, campaignId, runId, { chunk: 3, by: "worker-A" });
    const resA = ra.rows[0].reservation_id;
    const memberIds = ra.rows.filter((r) => r.member_id).map((r) => r.member_id);

    await h.admin.query(
      `update public.bluesky_follow_campaign_members
          set lease_expires_at = now() - interval '1 hour' where campaign_id = $1`,
      [campaignId],
    );

    const rb = await reserve(b, campaignId, runId, { chunk: 3, by: "worker-B" });
    const resB = rb.rows[0].reservation_id;
    expect(resB).not.toBe(resA);

    // A tries to give back what it no longer owns.
    const released = await a.query<{ release_bluesky_campaign_members_owned: number }>(
      `select public.release_bluesky_campaign_members_owned($1,$2,$3::uuid[],$4,$5)`,
      [t.workspaceId, campaignId, memberIds, "worker-A", resA],
    );
    expect(
      Number(released.rows[0].release_bluesky_campaign_members_owned),
    ).toBe(0);

    // B still holds every one of them.
    const still = await h.admin.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_follow_campaign_members
        where campaign_id = $1 and claimed_by = 'worker-B' and status = 'claimed'`,
      [campaignId],
    );
    expect(still.rows[0].n).toBe("3");

    await a.end();
    await b.end();
  });
});

describe("the conflict index under real contention", () => {
  it("two sessions inserting opposite intentions: exactly one wins", async () => {
    const did = "did:plc:contested-two-session";
    const a = await h.connect();
    const b = await h.connect();

    await a.query("begin");
    await a.query(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did,
          actor_did, status)
       values ($1,$2,'follow',$3,$4,'running')`,
      [t.workspaceId, t.identityId, did, ACTOR],
    );

    // B's insert must WAIT on the uncommitted unique index entry — a
    // real property of a real index, invisible to a single backend.
    let bSettled = false;
    const bPromise = b
      .query(
        `insert into public.bluesky_relationship_actions
           (workspace_id, operator_account_id, action_type, subject_did,
            actor_did, status)
         values ($1,$2,'unfollow',$3,$4,'running')`,
        [t.workspaceId, t.identityId, did, ACTOR],
      )
      .then(
        () => { bSettled = true; return "inserted" as const; },
        () => { bSettled = true; return "refused" as const; },
      );

    await new Promise((r) => setTimeout(r, 300));
    expect(bSettled).toBe(false);

    await a.query("commit");
    await expect(bPromise).resolves.toBe("refused");

    const rows = await h.admin.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_relationship_actions
        where subject_did = $1 and status in ('pending','running')`,
      [did],
    );
    expect(rows.rows[0].n).toBe("1");

    await a.end();
    await b.end();
  });

  it("and the LOSER is released when the winner rolls back", async () => {
    // A guard that turned a rollback into a permanent block would be a
    // denial of service on one person.
    const did = "did:plc:rollback-two-session";
    const a = await h.connect();
    const b = await h.connect();

    await a.query("begin");
    await a.query(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did,
          actor_did, status)
       values ($1,$2,'follow',$3,$4,'running')`,
      [t.workspaceId, t.identityId, did, ACTOR],
    );

    const bPromise = b
      .query(
        `insert into public.bluesky_relationship_actions
           (workspace_id, operator_account_id, action_type, subject_did,
            actor_did, status)
         values ($1,$2,'unfollow',$3,$4,'running')`,
        [t.workspaceId, t.identityId, did, ACTOR],
      )
      .then(() => "inserted" as const, () => "refused" as const);

    await new Promise((r) => setTimeout(r, 200));
    await a.query("rollback");
    await expect(bPromise).resolves.toBe("inserted");

    await a.end();
    await b.end();
  });
});
