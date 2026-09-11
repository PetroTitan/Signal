import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPgServerHarness,
  seedServerTenant,
  type PgServerHarness,
  type ServerTenant,
} from "./server-harness";

/**
 * Quota accounting across a crash between per-member work and chunk
 * settlement.
 *
 * A worker converts reserved quota into ATTEMPTS one member at a time,
 * but reports the chunk's totals only at the end. If it dies in
 * between, the attempts it really made exist nowhere in the run's
 * counters — the settlement that would have recorded them never ran.
 *
 * So the question this file asks is narrow and quantitative: after such
 * a crash, how many mutation slots does the NEXT worker receive? The
 * only safe answer is "the quota minus what was really attempted".
 *
 * Pure database. No provider call is made anywhere in this file; a
 * "mutation slot" is a unit of quota the database is willing to hand
 * out, which is the thing that bounds real follows.
 */

let h: PgServerHarness;
let t: ServerTenant;
/**
 * The identity under test, recreated per campaign.
 *
 * `bluesky_identity_daily_usage` is keyed by (workspace, identity,
 * date), so sharing one identity carries every test's consumption into
 * the next — a `follows_created` assertion would then be reading the
 * whole file's history rather than this test's.
 */
let identityId: string;
const TODAY = "2026-09-11";

beforeAll(async () => {
  h = await createPgServerHarness();
  t = await seedServerTenant(h.admin, "crash-acct");
}, 300_000);

afterAll(async () => {
  await h?.close();
});

async function freshCampaign(members: number, effectiveQuota: number) {
  const acct = await h.admin.query<{ id: string }>(
    `insert into public.growth_accounts
       (workspace_id, platform, handle, display_name, status)
     values ($1,'bluesky',$2,$2,'active') returning id`,
    [t.workspaceId, `id-${Math.random().toString(36).slice(2, 10)}.bsky.social`],
  );
  identityId = acct.rows[0].id;

  const c = await h.admin.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, status, requested_daily_quota)
     values ($1,$2,$3,'active',100) returning id`,
    [t.workspaceId, identityId, `c-${Math.random().toString(36).slice(2, 8)}`],
  );
  const campaignId = c.rows[0].id;
  const values: string[] = [];
  for (let i = 1; i <= members; i += 1) {
    values.push(`('${t.workspaceId}','${campaignId}','did:plc:m${i}',${i})`);
  }
  await h.admin.query(
    `insert into public.bluesky_follow_campaign_members
       (workspace_id, campaign_id, subject_did, import_sequence)
     values ${values.join(",")}`,
  );
  const r = await h.admin.query<{ id: string }>(
    `select id from public.ensure_bluesky_campaign_run($1,$2,$3,$4,$5,$6)`,
    [t.workspaceId, campaignId, TODAY, 100, effectiveQuota, null],
  );
  return { campaignId, runId: r.rows[0].id };
}

const reserve = (
  campaignId: string,
  runId: string,
  chunk: number,
  by = "worker",
) =>
  h.admin.query<{
    reserved: number;
    reservation_id: string | null;
    reason: string;
    member_id: string | null;
  }>(
    `select * from public.reserve_bluesky_campaign_quota(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [t.workspaceId, campaignId, runId, identityId, TODAY, 100, 10_000, chunk, 300, by],
  );

/**
 * Exactly what the worker does per member, in order, for a member that
 * reaches the provider and succeeds.
 */
async function workOneMember(
  campaignId: string,
  runId: string,
  reservationId: string,
  memberId: string,
  subjectDid: string,
): Promise<void> {
  const claim = await h.admin.query<{ action_id: string }>(
    `select * from public.claim_bluesky_campaign_action(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      t.workspaceId, campaignId, runId, memberId, identityId,
      subjectDid, `${subjectDid}.handle`, "did:plc:actor", "actor.test", null,
    ],
  );
  const actionId = claim.rows[0].action_id;

  // The unit is spent HERE, immediately before the provider call and in
  // its own transaction. This is the whole point: a process killed on
  // the next line still leaves the day's books showing the attempt.
  const unit = await h.admin.query<{ consumed: boolean }>(
    `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
    [
      t.workspaceId, campaignId, runId, reservationId, memberId,
      actionId, identityId,
    ],
  );
  expect(unit.rows[0].consumed).toBe(true);

  // ── the provider mutation would happen HERE ──

  // The audit row is finalised: in-flight marker cleared, status
  // succeeded. This is `completeCampaignAction`.
  await h.admin.query(
    `update public.bluesky_relationship_actions
        set status='succeeded', provider_in_flight_at=null,
            follow_uri='at://x', follow_rkey='rk', finished_at=now()
      where id=$1`,
    [actionId],
  );
  // And the member is persisted. This is `persist()`, which always
  // clears the lease.
  await h.admin.query(
    `update public.bluesky_follow_campaign_members
        set status='succeeded', lease_expires_at=null, claimed_at=null,
            attempt_count=attempt_count+1, completed_at=now()
      where id=$1`,
    [memberId],
  );
}

/**
 * Claim the audit row and spend the unit, exactly as the worker does.
 *
 * `consume` requires the action it is about: the marker it raises says
 * "a request for THIS action is in flight", and an attempt that cannot
 * name its action cannot raise it.
 */
async function spendOne(
  campaignId: string,
  runId: string,
  reservationId: string,
  memberId: string,
  subjectDid = "did:plc:m1",
): Promise<{ consumed: boolean; refused_reason: string | null }> {
  const claim = await h.admin.query<{ action_id: string }>(
    `select * from public.claim_bluesky_campaign_action(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      t.workspaceId, campaignId, runId, memberId, identityId,
      subjectDid, `${subjectDid}.h`, "did:plc:actor", "actor.test", null,
    ],
  );
  const out = await h.admin.query<{
    consumed: boolean;
    refused_reason: string | null;
  }>(
    `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
    [
      t.workspaceId, campaignId, runId, reservationId, memberId,
      claim.rows[0].action_id, identityId,
    ],
  );
  return out.rows[0];
}

describe("a crash between per-member work and chunk settlement", () => {
  it("does not reopen quota that was really spent", async () => {
    const { campaignId, runId } = await freshCampaign(400, 100);

    // Worker A reserves a chunk and completes FOUR members — four real
    // follows, as far as Bluesky is concerned.
    const first = await reserve(campaignId, runId, 20, "A");
    const reservationId = first.rows[0].reservation_id!;
    const members = first.rows
      .filter((r) => r.member_id)
      .map((r) => r.member_id as string);
    expect(members.length).toBe(20);

    for (let i = 0; i < 4; i += 1) {
      await workOneMember(
        campaignId, runId, reservationId, members[i], `did:plc:m${i + 1}`,
      );
    }

    // ── A DIES. Settlement never runs. Leases and the reservation
    //    lapse on their own clocks; nothing else happens.
    await h.admin.query(
      `update public.bluesky_follow_campaign_members
          set lease_expires_at = now() - interval '1 minute'
        where reservation_id=$1 and status in ('claimed','running')`,
      [reservationId],
    );
    await h.admin.query(
      `update public.bluesky_campaign_quota_reservations
          set expires_at = now() - interval '1 minute'
        where id=$1 and status='open'`,
      [reservationId],
    );

    // Worker B now takes over and reserves as much as it is allowed,
    // repeatedly, until the database stops handing out slots.
    let handedOut = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const r = await reserve(campaignId, runId, 20, "B");
      const n = r.rows.filter((x) => x.member_id).length;
      if (n === 0) break;
      handedOut += n;
    }

    const outstanding = await h.admin.query<{ n: string }>(
      `select coalesce(sum(reserved_count),0) n
         from public.bluesky_campaign_quota_reservations
        where run_id=$1 and status in ('open','held')`,
      [runId],
    );

    // THE assertion. Four follows really happened, so at most 96 more
    // slots may ever be issued.
    expect(handedOut).toBeLessThanOrEqual(96);

    // And the total the day could possibly produce — what was really
    // attempted plus everything still promised — must not exceed 100.
    expect(4 + Number(outstanding.rows[0].n)).toBeLessThanOrEqual(100);
  }, 180_000);

  it("counts the four attempts even though nothing ever settled", async () => {
    const { campaignId, runId } = await freshCampaign(200, 100);
    const first = await reserve(campaignId, runId, 20, "A");
    const reservationId = first.rows[0].reservation_id!;
    const members = first.rows
      .filter((r) => r.member_id)
      .map((r) => r.member_id as string);

    for (let i = 0; i < 4; i += 1) {
      await workOneMember(
        campaignId, runId, reservationId, members[i], `did:plc:m${i + 1}`,
      );
    }

    // Settlement never runs, so the ONLY record of these four attempts
    // is what was written per member as they happened.
    const run = await h.admin.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(Number(run.rows[0].attempted_count)).toBe(4);

    const ledger = await h.admin.query<{ n: string }>(
      `select count(*) n from public.bluesky_campaign_attempt_ledger
        where reservation_id=$1 and provider_intent_at is not null`,
      [reservationId],
    );
    expect(Number(ledger.rows[0].n)).toBe(4);

    // And the reservation is down to the 16 it has not spent.
    const res = await h.admin.query<{ reserved_count: number }>(
      `select reserved_count from public.bluesky_campaign_quota_reservations
        where id=$1`,
      [reservationId],
    );
    expect(Number(res.rows[0].reserved_count)).toBe(16);
  }, 120_000);

  it("the sweep recovers the outcomes the dead worker never reported", async () => {
    const { campaignId, runId } = await freshCampaign(200, 100);
    const first = await reserve(campaignId, runId, 20, "A");
    const reservationId = first.rows[0].reservation_id!;
    const members = first.rows
      .filter((r) => r.member_id)
      .map((r) => r.member_id as string);

    for (let i = 0; i < 4; i += 1) {
      await workOneMember(
        campaignId, runId, reservationId, members[i], `did:plc:m${i + 1}`,
      );
    }
    await h.admin.query(
      `update public.bluesky_campaign_quota_reservations
          set expires_at = now() - interval '1 minute' where id=$1`,
      [reservationId],
    );

    await h.admin.query(
      `select public.sweep_bluesky_quota_reservations($1,$2,$3)`,
      [t.workspaceId, identityId, TODAY],
    );

    // Four real follows, folded from the durable rows rather than from
    // a worker's memory — there is no worker any more.
    const run = await h.admin.query<{
      attempted_count: number;
      succeeded_count: number;
    }>(
      `select attempted_count, succeeded_count
         from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(Number(run.rows[0].succeeded_count)).toBe(4);
    expect(Number(run.rows[0].attempted_count)).toBe(4);

    const usage = await h.admin.query<{ follows_created: number }>(
      `select follows_created from public.bluesky_identity_daily_usage
        where workspace_id=$1 and operator_account_id=$2 and usage_date=$3`,
      [t.workspaceId, identityId, TODAY],
    );
    expect(Number(usage.rows[0].follows_created)).toBe(4);
    expect(campaignId).toBeTruthy();
  }, 120_000);

  it("folding twice does not double-count", async () => {
    const { campaignId, runId } = await freshCampaign(200, 100);
    const first = await reserve(campaignId, runId, 20, "A");
    const reservationId = first.rows[0].reservation_id!;
    const members = first.rows
      .filter((r) => r.member_id)
      .map((r) => r.member_id as string);
    for (let i = 0; i < 3; i += 1) {
      await workOneMember(
        campaignId, runId, reservationId, members[i], `did:plc:m${i + 1}`,
      );
    }

    await h.admin.query(`select public.fold_bluesky_ledger_outcomes($1)`, [
      reservationId,
    ]);
    await h.admin.query(`select public.fold_bluesky_ledger_outcomes($1)`, [
      reservationId,
    ]);

    const run = await h.admin.query<{ succeeded_count: number }>(
      `select succeeded_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(Number(run.rows[0].succeeded_count)).toBe(3);
  }, 120_000);

  it("an attempt whose outcome is UNKNOWN still consumes its unit", async () => {
    // The conservative direction. A worker that died between the
    // provider call and recording the result leaves an action nobody
    // can classify — and that unit must never come back, because the
    // follow may well have happened.
    const { campaignId, runId } = await freshCampaign(200, 10);
    const first = await reserve(campaignId, runId, 10, "A");
    const reservationId = first.rows[0].reservation_id!;
    const memberId = first.rows.filter((r) => r.member_id)[0].member_id!;

    const claim = await h.admin.query<{ action_id: string }>(
      `select * from public.claim_bluesky_campaign_action(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        t.workspaceId, campaignId, runId, memberId, identityId,
        "did:plc:m1", "m1.handle", "did:plc:actor", "actor.test", null,
      ],
    );
    await h.admin.query(
      `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
      [
        t.workspaceId, campaignId, runId, reservationId, memberId,
        claim.rows[0].action_id, identityId,
      ],
    );
    // ── dies here: the action stays mid-flight forever ──

    await h.admin.query(
      `update public.bluesky_campaign_quota_reservations
          set expires_at = now() - interval '1 minute' where id=$1`,
      [reservationId],
    );
    await h.admin.query(
      `select public.sweep_bluesky_quota_reservations($1,$2,$3)`,
      [t.workspaceId, identityId, TODAY],
    );

    const run = await h.admin.query<{
      attempted_count: number;
      succeeded_count: number;
    }>(
      `select attempted_count, succeeded_count
         from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    // Counted as an attempt, counted as no success. Unknown is not
    // optimism.
    expect(Number(run.rows[0].attempted_count)).toBe(1);
    expect(Number(run.rows[0].succeeded_count)).toBe(0);

    // And only 9 slots remain of the 10.
    let handedOut = 0;
    for (let i = 0; i < 5; i += 1) {
      const r = await reserve(campaignId, runId, 10, "B");
      const n = r.rows.filter((x) => x.member_id && x.reason === "granted").length;
      if (n === 0) break;
      handedOut += n;
    }
    expect(handedOut).toBeLessThanOrEqual(9);
  }, 120_000);

  it("settlement refuses a reservation from another campaign or day", async () => {
    const a = await freshCampaign(50, 50);
    const identityA = identityId;
    const ra = await reserve(a.campaignId, a.runId, 10, "A");
    const reservationA = ra.rows[0].reservation_id!;
    // A second campaign on its own identity, so "wrong campaign" and
    // "wrong identity" can be distinguished.
    const b = await freshCampaign(50, 50);
    const identityB = identityId;

    const settle = (
      workspaceId: string,
      campaignId: string,
      runId: string,
      identityId: string,
      usageDate: string,
    ) =>
      h.admin.query<{ settled: boolean; refused_reason: string | null }>(
        `select * from public.apply_bluesky_run_outcome(
           $1,$2,$3,$4,$5,$6, 0, null, null, null)`,
        [workspaceId, campaignId, runId, identityId, usageDate, reservationA],
      );

    // Wrong run AND wrong campaign.
    const wrongRun = await settle(
      t.workspaceId, b.campaignId, b.runId, identityB, TODAY,
    );
    expect(wrongRun.rows[0].settled).toBe(false);
    expect(wrongRun.rows[0].refused_reason).toBe("campaign_mismatch");

    // Right campaign and run, wrong IDENTITY — a different account's
    // budget entirely.
    const wrongIdentity = await settle(
      t.workspaceId, a.campaignId, a.runId, identityB, TODAY,
    );
    expect(wrongIdentity.rows[0].settled).toBe(false);
    expect(wrongIdentity.rows[0].refused_reason).toBe("identity_mismatch");

    // Right everything but the day.
    const wrongDay = await settle(
      t.workspaceId, a.campaignId, a.runId, identityA, "2026-09-12",
    );
    expect(wrongDay.rows[0].settled).toBe(false);
    expect(wrongDay.rows[0].refused_reason).toBe("usage_date_mismatch");

    // Right everything.
    const ok = await settle(
      t.workspaceId, a.campaignId, a.runId, identityA, TODAY,
    );
    expect(ok.rows[0].settled).toBe(true);
  }, 120_000);

  it("the provider-intent stamp is immutable", async () => {
    const { campaignId, runId } = await freshCampaign(20, 20);
    const first = await reserve(campaignId, runId, 5, "A");
    const reservationId = first.rows[0].reservation_id!;
    const memberId = first.rows.filter((r) => r.member_id)[0].member_id!;
    await spendOne(campaignId, runId, reservationId, memberId);

    // The record of a public action is not editable, by anyone.
    await expect(
      h.admin.query(
        `update public.bluesky_campaign_attempt_ledger
            set provider_intent_at = null
          where reservation_id=$1 and member_id=$2`,
        [reservationId, memberId],
      ),
    ).rejects.toThrow(/immutable/i);
    expect(campaignId).toBeTruthy();
  }, 120_000);

  it("consuming the same member twice spends one unit", async () => {
    const { campaignId, runId } = await freshCampaign(20, 20);
    const first = await reserve(campaignId, runId, 5, "A");
    const reservationId = first.rows[0].reservation_id!;
    const memberId = first.rows.filter((r) => r.member_id)[0].member_id!;

    const one = await spendOne(campaignId, runId, reservationId, memberId);
    const two = await spendOne(campaignId, runId, reservationId, memberId);
    expect(one.consumed).toBe(true);
    expect(two.consumed).toBe(false);

    const run = await h.admin.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(Number(run.rows[0].attempted_count)).toBe(1);
    expect(campaignId).toBeTruthy();
  }, 120_000);

  it("refuses to fund a mutation beyond the reservation", async () => {
    const { campaignId, runId } = await freshCampaign(20, 20);
    const first = await reserve(campaignId, runId, 2, "A");
    const reservationId = first.rows[0].reservation_id!;
    const members = first.rows
      .filter((r) => r.member_id)
      .map((r) => r.member_id as string);

    for (const [i, m] of members.entries()) {
      await spendOne(campaignId, runId, reservationId, m, `did:plc:m${i + 1}`);
    }

    // A member this reservation never paid for.
    const other = await h.admin.query<{ id: string }>(
      `select id from public.bluesky_follow_campaign_members
        where campaign_id=$1 and id <> all($2::uuid[]) limit 1`,
      [campaignId, members],
    );
    const refused = await spendOne(
      campaignId, runId, reservationId, other.rows[0].id, "did:plc:other",
    );
    expect(refused.consumed).toBe(false);
    expect(refused.refused_reason).toBe("reservation_exhausted");

    const run = await h.admin.query<{ attempted_count: number }>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(Number(run.rows[0].attempted_count)).toBe(2);
  }, 120_000);
});
