import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "./harness";

/**
 * The worker RPCs, executed by real PostgreSQL as service_role.
 *
 * The fake reproduces these functions' logic; this proves the functions
 * themselves compile, run, and produce the same answers — under the
 * role the worker actually uses.
 */

let h: PgHarness;
let t: Tenant;
let campaignId: string;
let runId: string;
let identityId: string;
const TODAY = "2026-09-11";

/**
 * A campaign on its OWN identity.
 *
 * `bluesky_identity_daily_usage` is keyed by (workspace, identity, date),
 * so reusing one identity would carry every test's consumption into the
 * next one. The ceiling is a property of the identity, not the campaign —
 * the test that asserts two campaigns share a ceiling opts back in by
 * passing an explicit identity.
 *
 * `requested_daily_quota` on the campaign is restricted to a fixed set of
 * operator-selectable values, so a test wanting a small quota expresses it
 * as the RUN's effective quota (which the schema only requires to be <=
 * requested) rather than by inventing an illegal campaign quota.
 */
async function freshCampaign(
  members: number,
  effectiveQuota = 100,
  sharedIdentityId?: string,
): Promise<{ campaignId: string; runId: string }> {
  if (sharedIdentityId) {
    identityId = sharedIdentityId;
  } else {
    const acct = await h.db.query<{ id: string }>(
      `insert into public.growth_accounts
         (workspace_id, platform, handle, display_name, status)
       values ($1,'bluesky',$2,$2,'active') returning id`,
      [t.workspaceId, `id-${crypto.randomUUID().slice(0, 8)}.bsky.social`],
    );
    identityId = acct.rows[0].id;
  }

  const c = await h.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, status, requested_daily_quota)
     values ($1,$2,$3,'active',100) returning id`,
    [t.workspaceId, identityId, `camp-${crypto.randomUUID().slice(0, 8)}`],
  );
  campaignId = c.rows[0].id;

  for (let i = 1; i <= members; i += 1) {
    await h.db.query(
      `insert into public.bluesky_follow_campaign_members
         (workspace_id, campaign_id, subject_did, import_sequence)
       values ($1,$2,$3,$4)`,
      [t.workspaceId, campaignId, `did:plc:m${i}`, i],
    );
  }

  const r = await h.db.query<{ id: string }>(
    `select id from public.ensure_bluesky_campaign_run($1,$2,$3,$4,$5,$6)`,
    [t.workspaceId, campaignId, TODAY, 100, effectiveQuota, null],
  );
  runId = r.rows[0].id;
  return { campaignId, runId };
}

const reserve = (requested: number, chunk = 20, ceiling = 1000) =>
  h.db.query<{
    reserved: number;
    reservation_id: string | null;
    reason: string;
    member_id: string | null;
  }>(
    `select * from public.reserve_bluesky_campaign_quota(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      t.workspaceId, campaignId, runId, identityId, TODAY,
      requested, ceiling, chunk, 300, "worker-1",
    ],
  );

beforeAll(async () => {
  h = await createPgHarness();
  t = await seedTenant(h.db, "rpc");
}, 180_000);

afterAll(async () => {
  await h?.close();
});


/**
 * Claim the audit row and spend the unit, exactly as the worker does.
 *
 * `consume` requires the action it is about: the marker it raises says
 * "a request for THIS action is in flight", and an attempt that cannot
 * name its action cannot raise it.
 */
async function spendOne(
  db: { query: typeof h.db.query },
  campaignId: string,
  runId: string,
  reservationId: string,
  memberId: string,
): Promise<void> {
  const claim = await db.query<{ action_id: string }>(
    `select * from public.claim_bluesky_campaign_action(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      t.workspaceId, campaignId, runId, memberId, identityId,
      `did:plc:${memberId.slice(0, 8)}`, "h.test", "did:plc:actor",
      "actor.test", null,
    ],
  );
  await db.query(
    `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
    [
      t.workspaceId, campaignId, runId, reservationId, memberId,
      claim.rows[0].action_id, identityId,
    ],
  );
}

describe("reserve_bluesky_campaign_quota", () => {
  it("reserves and claims exactly the granted number", async () => {
    await freshCampaign(100, 100);
    const r = await reserve(100, 20);
    expect(r.rows).toHaveLength(20);
    expect(r.rows[0].reserved).toBe(20);

    const run = await h.db.query<{ reserved_count: number }>(
      `select reserved_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(run.rows[0].reserved_count).toBe(20);

    const claimed = await h.db.query<{ n: number }>(
      `select count(*)::int n from public.bluesky_follow_campaign_members
        where campaign_id=$1 and status='claimed'`,
      [campaignId],
    );
    expect(claimed.rows[0].n).toBe(20);
  });

  it("a second reservation sees the first as SPENT", async () => {
    // This is the property that bounds total attempts. Before the fix
    // the second caller saw "0 used today" and reserved the full quota
    // again.
    await freshCampaign(200, 40);
    const first = await reserve(40, 40);
    expect(first.rows).toHaveLength(40);
    const second = await reserve(40, 40);
    // Nothing left: the whole quota is reserved by the first caller.
    expect(second.rows.filter((x) => x.member_id !== null)).toHaveLength(0);
  });

  it("never grants more than the campaign quota across many calls", async () => {
    await freshCampaign(500, 50);
    let total = 0;
    for (let i = 0; i < 10; i += 1) {
      const r = await reserve(50, 20);
      total += r.rows.filter((x) => x.member_id !== null).length;
    }
    expect(total).toBe(50);
  });

  it("never grants more than the identity ceiling", async () => {
    await freshCampaign(500, 100);
    // Upsert, not update: the usage row does not exist until the first
    // reservation creates it, so a bare UPDATE matches nothing and the
    // test would assert against an untouched ceiling.
    const seeded = await h.db.query(
      `insert into public.bluesky_identity_daily_usage
         (workspace_id, operator_account_id, usage_date, follows_created)
       values ($1,$2,$3,990)
       on conflict (workspace_id, operator_account_id, usage_date)
       do update set follows_created = 990`,
      [t.workspaceId, identityId, TODAY],
    );
    expect(seeded.affectedRows).toBe(1);
    const r = await reserve(1000, 100, 1000);
    expect(r.rows.filter((x) => x.member_id !== null).length).toBeLessThanOrEqual(10);
  });

  it("caps TWO campaigns that share one identity at that identity's ceiling", async () => {
    // The ceiling belongs to the Bluesky account, not to the campaign.
    // Two campaigns driving the same identity must not each get a full
    // allowance — that is how an account gets rate-limited into the ground.
    await freshCampaign(200, 100);
    const shared = identityId;
    const firstCampaign = campaignId;
    const firstRun = runId;

    await freshCampaign(200, 100, shared);
    expect(campaignId).not.toBe(firstCampaign);

    const call = (cId: string, rId: string) =>
      h.db.query<{ member_id: string | null }>(
        `select * from public.reserve_bluesky_campaign_quota(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [t.workspaceId, cId, rId, shared, TODAY, 100, 30, 100, 300, "w"],
      );

    const a = await call(firstCampaign, firstRun);
    const b = await call(campaignId, runId);
    const granted =
      a.rows.filter((x) => x.member_id !== null).length +
      b.rows.filter((x) => x.member_id !== null).length;
    expect(granted).toBe(30);
  });

  it("reserves nothing for a run that is not running", async () => {
    await freshCampaign(50, 50);
    await h.db.query(
      `update public.bluesky_follow_campaign_runs set status='paused' where id=$1`,
      [runId],
    );
    const r = await reserve(50, 20);
    expect(r.rows.filter((x) => x.member_id !== null)).toHaveLength(0);
  });

  it("claims in import_sequence order, skipping finished rows", async () => {
    await freshCampaign(100, 100);
    await h.db.query(
      `update public.bluesky_follow_campaign_members
          set status='succeeded' where campaign_id=$1 and import_sequence <= 60`,
      [campaignId],
    );
    const r = await reserve(100, 5);
    const seqs = await h.db.query<{ import_sequence: string }>(
      `select import_sequence from public.bluesky_follow_campaign_members
        where id = any($1::uuid[]) order by import_sequence`,
      [r.rows.map((x) => x.member_id)],
    );
    expect(seqs.rows.map((x) => Number(x.import_sequence))).toEqual([
      61, 62, 63, 64, 65,
    ]);
  });

  it("reclaims an expired lease AND its reservation", async () => {
    await freshCampaign(10, 10);
    const first = await reserve(10, 10);
    expect(first.rows).toHaveLength(10);

    // The worker dies. `reserve` issues the member leases and the
    // reservation with the SAME duration, so both lapse together —
    // expiring one without the other models a state production cannot
    // reach.
    await h.db.query(
      `update public.bluesky_follow_campaign_members
          set lease_expires_at = now() - interval '1 minute'
        where campaign_id=$1 and status='claimed'`,
      [campaignId],
    );
    await h.db.query(
      `update public.bluesky_campaign_quota_reservations
          set expires_at = now() - interval '1 minute'
        where run_id=$1 and status='open'`,
      [runId],
    );

    const second = await reserve(10, 10);
    // The rows come back AND the quota comes back — otherwise one crash
    // on a small quota consumes the day and blocks its own recovery.
    expect(second.rows.filter((x) => x.member_id !== null)).toHaveLength(10);
  });
});

describe("apply_bluesky_run_outcome", () => {
  /** Spend one unit the way the worker does, just before a mutation. */
  const consume = (reservationId: string, memberId: string) =>
    spendOne(h.db, campaignId, runId, reservationId, memberId);

  const settle = (reservationId: string) =>
    h.db.query<{ settled: boolean; already_settled: boolean }>(
      `select * from public.apply_bluesky_run_outcome(
         $1,$2,$3,$4,$5,$6, 0, null, null, null)`,
      [t.workspaceId, campaignId, runId, identityId, TODAY, reservationId],
    );

  it("counts what was SPENT, not what the caller claims", async () => {
    // Settlement takes no totals at all now. The numbers come from the
    // ledger the worker wrote as it went, which is the only version
    // that survives the worker.
    await freshCampaign(50, 50);
    const res = await reserve(50, 20);
    const reservationId = res.rows[0].reservation_id!;
    const members = res.rows
      .filter((r) => r.member_id)
      .map((r) => r.member_id as string);

    for (let i = 0; i < 5; i += 1) await consume(reservationId, members[i]);

    const run = await h.db.query<{
      attempted_count: number;
      reserved_count: number;
    }>(
      `select attempted_count, reserved_count
         from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    // Five units moved from promised to spent, before any settlement.
    expect(run.rows[0].attempted_count).toBe(5);
    expect(run.rows[0].reserved_count).toBe(15);

    await settle(reservationId);

    const after = await h.db.query<{
      attempted_count: number;
      reserved_count: number;
    }>(
      `select attempted_count, reserved_count
         from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    // Settling returns the 15 that were never spent, and leaves the 5
    // that were.
    expect(after.rows[0].attempted_count).toBe(5);
    expect(after.rows[0].reserved_count).toBe(0);
  });

  it("two DIFFERENT reservations ACCUMULATE — no lost update", async () => {
    await freshCampaign(50, 50);
    const first = await reserve(50, 5);
    for (const r of first.rows.filter((x) => x.member_id)) {
      await consume(first.rows[0].reservation_id!, r.member_id!);
    }
    await settle(first.rows[0].reservation_id!);

    const second = await reserve(50, 5);
    for (const r of second.rows.filter((x) => x.member_id)) {
      await consume(second.rows[0].reservation_id!, r.member_id!);
    }
    await settle(second.rows[0].reservation_id!);

    const run = await h.db.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    // Absolute writes from a stale snapshot would give 5.
    expect(run.rows[0].attempted_count).toBe(10);
  });

  it("settling the SAME reservation twice applies nothing twice", async () => {
    await freshCampaign(50, 50);
    const res = await reserve(50, 10);
    const reservationId = res.rows[0].reservation_id!;
    for (const r of res.rows.filter((x) => x.member_id)) {
      await consume(reservationId, r.member_id!);
    }

    const one = await settle(reservationId);
    const two = await settle(reservationId);
    expect(one.rows[0].settled).toBe(true);
    expect(two.rows[0].settled).toBe(false);
    expect(two.rows[0].already_settled).toBe(true);

    const run = await h.db.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(run.rows[0].attempted_count).toBe(10);
  });

  it("a reservation from ANOTHER run settles nothing", async () => {
    await freshCampaign(50, 50);
    const foreign = await reserve(50, 10);
    const foreignReservation = foreign.rows[0].reservation_id!;

    // A different campaign, a different run.
    await freshCampaign(50, 50);
    const before = await h.db.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );

    const out = await settle(foreignReservation);
    expect(out.rows[0].settled).toBe(false);

    const after = await h.db.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(after.rows[0].attempted_count).toBe(before.rows[0].attempted_count);
  });
});

describe("claim_bluesky_campaign_action", () => {
  it("creates the audit row and permits the mutation once", async () => {
    await freshCampaign(5, 5);
    const m = await h.db.query<{ id: string }>(
      `select id from public.bluesky_follow_campaign_members
        where campaign_id=$1 order by import_sequence limit 1`,
      [campaignId],
    );
    const first = await h.db.query<{
      action_id: string;
      may_mutate: boolean;
      needs_reconcile: boolean;
      terminal: boolean;
    }>(
      `select * from public.claim_bluesky_campaign_action(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        t.workspaceId, campaignId, runId, m.rows[0].id, identityId,
        "did:plc:m1", "m1.bsky.social", "did:plc:actor", "actor.bsky.social", null,
      ],
    );
    expect(first.rows[0].may_mutate).toBe(true);

    const reclaim = () =>
      h.db.query<{ may_mutate: boolean; needs_reconcile: boolean }>(
        `select * from public.claim_bluesky_campaign_action(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          t.workspaceId, campaignId, runId, m.rows[0].id, identityId,
          "did:plc:m1", "m1.bsky.social", "did:plc:actor", "actor.bsky.social",
          null,
        ],
      );

    // A second claim while nothing has been SENT still permits the
    // mutation. This used to refuse, and refusing was the defect: a
    // worker that claimed the row and died before spending its unit
    // left the member permanently in reconciliation-only mode, so it
    // was never followed at all.
    const second = await reclaim();
    expect(second.rows[0].may_mutate).toBe(true);
    expect(second.rows[0].needs_reconcile).toBe(false);

    // Once a unit is spent, the marker is up and the answer flips.
    const res = await reserve(5, 5);
    await h.db.query(
      `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
      [
        t.workspaceId, campaignId, runId, res.rows[0].reservation_id,
        m.rows[0].id, first.rows[0].action_id, identityId,
      ],
    );
    const third = await reclaim();
    expect(third.rows[0].may_mutate).toBe(false);
    expect(third.rows[0].needs_reconcile).toBe(true);

    const rows = await h.db.query<{ n: number }>(
      `select count(*)::int n from public.bluesky_relationship_actions
        where campaign_id=$1 and campaign_member_id=$2`,
      [campaignId, m.rows[0].id],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("the unique index really rejects a second non-skipped action", async () => {
    await freshCampaign(3, 3);
    const m = await h.db.query<{ id: string }>(
      `select id from public.bluesky_follow_campaign_members
        where campaign_id=$1 order by import_sequence limit 1`,
      [campaignId],
    );
    const insert = () =>
      h.db.query(
        `insert into public.bluesky_relationship_actions
           (workspace_id, operator_account_id, action_type, subject_did,
            status, campaign_id, campaign_member_id)
         values ($1,$2,'follow','did:plc:x','succeeded',$3,$4)`,
        [t.workspaceId, identityId, campaignId, m.rows[0].id],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key value/i);
  });
});

describe("resume_bluesky_campaign_run", () => {
  it("returns a rate-limited run to running once the reset has passed", async () => {
    await freshCampaign(50, 50);
    await h.db.query(
      `update public.bluesky_follow_campaign_runs
          set status='rate_limited', rate_limited_until = now() - interval '1 minute'
        where id=$1`,
      [runId],
    );
    const r = await h.db.query<{ status: string; rate_limited_until: string | null }>(
      `select * from public.resume_bluesky_campaign_run($1,$2)`,
      [t.workspaceId, runId],
    );
    expect(r.rows[0].status).toBe("running");
    expect(r.rows[0].rate_limited_until).toBeNull();
  });

  it("does NOT resume before the reset", async () => {
    await freshCampaign(50, 50);
    await h.db.query(
      `update public.bluesky_follow_campaign_runs
          set status='rate_limited', rate_limited_until = now() + interval '1 hour'
        where id=$1`,
      [runId],
    );
    const r = await h.db.query<{ status: string }>(
      `select * from public.resume_bluesky_campaign_run($1,$2)`,
      [t.workspaceId, runId],
    );
    expect(r.rows[0].status).toBe("rate_limited");
  });

  it("NEVER resumes a run an operator paused", async () => {
    await freshCampaign(50, 50);
    await h.db.query(
      `update public.bluesky_follow_campaign_runs set status='paused' where id=$1`,
      [runId],
    );
    const r = await h.db.query<{ status: string }>(
      `select * from public.resume_bluesky_campaign_run($1,$2)`,
      [t.workspaceId, runId],
    );
    expect(r.rows[0].status).toBe("paused");
  });

  it("creates no second run for the day", async () => {
    await freshCampaign(50, 50);
    await h.db.query(
      `update public.bluesky_follow_campaign_runs
          set status='rate_limited', rate_limited_until = now() - interval '1 second'
        where id=$1`,
      [runId],
    );
    await h.db.query(`select * from public.resume_bluesky_campaign_run($1,$2)`, [
      t.workspaceId, runId,
    ]);
    const n = await h.db.query<{ n: number }>(
      `select count(*)::int n from public.bluesky_follow_campaign_runs
        where campaign_id=$1`,
      [campaignId],
    );
    expect(n.rows[0].n).toBe(1);
  });
});
