import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";
import {
  createPgServerHarness,
  seedServerTenant,
  type PgServerHarness,
  type ServerTenant,
} from "./server-harness";

/**
 * Three defects in the intent/settlement machinery, on a real server.
 *
 * All three need genuine PostgreSQL: one is about a deadlock between
 * two backends, one about a join that only misbehaves when a member has
 * more than one action row, and one about state left behind by a
 * transaction that never committed.
 *
 * No provider call is made anywhere in this file.
 */

let h: PgServerHarness;
let t: ServerTenant;
let identityId: string;
const TODAY = "2026-09-11";

beforeAll(async () => {
  h = await createPgServerHarness();
  t = await seedServerTenant(h.admin, "intent");
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

const reserve = (campaignId: string, runId: string, chunk: number, by = "w") =>
  h.admin.query<{
    reservation_id: string | null;
    reason: string;
    member_id: string | null;
  }>(
    `select * from public.reserve_bluesky_campaign_quota(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [t.workspaceId, campaignId, runId, identityId, TODAY, 100, 10_000, chunk, 300, by],
  );

const claim = (
  campaignId: string,
  runId: string,
  memberId: string,
  subjectDid: string,
  db: Client = h.admin,
) =>
  db.query<{
    action_id: string;
    may_mutate: boolean;
    needs_reconcile: boolean;
    terminal: boolean;
  }>(
    `select * from public.claim_bluesky_campaign_action(
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      t.workspaceId, campaignId, runId, memberId, identityId,
      subjectDid, `${subjectDid}.h`, "did:plc:actor", "actor.test", null,
    ],
  );

// =====================================================================
// 1. A crash BEFORE provider intent
// =====================================================================

describe("a crash before provider intent", () => {
  it("leaves the member able to send its FIRST createRecord", async () => {
    // The worker claims the audit row, and then dies — or the quota
    // call fails — before anything reaches Bluesky. Nothing was sent.
    //
    // The member must therefore still be allowed exactly one first
    // attempt. Treating it as "possibly already mutated" is not
    // caution: nothing was in flight, and the profile is never followed
    // at all, silently, for the life of the campaign.
    const { campaignId, runId } = await freshCampaign(5, 5);
    const res = await reserve(campaignId, runId, 5);
    const memberId = res.rows.filter((r) => r.member_id)[0].member_id!;

    const first = await claim(campaignId, runId, memberId, "did:plc:m1");
    expect(first.rows[0].may_mutate).toBe(true);

    // ── dies here. No consume, so no ledger intent exists. ──
    const ledger = await h.admin.query<{ n: string }>(
      `select count(*) n from public.bluesky_campaign_attempt_ledger
        where member_id=$1 and provider_intent_at is not null`,
      [memberId],
    );
    expect(Number(ledger.rows[0].n)).toBe(0);

    // The audit row must not claim a mutation was in flight, because
    // none ever was.
    const action = await h.admin.query<{ provider_in_flight_at: string | null }>(
      `select provider_in_flight_at from public.bluesky_relationship_actions
        where campaign_member_id=$1`,
      [memberId],
    );
    expect(action.rows[0].provider_in_flight_at).toBeNull();

    // So the next worker may send the first mutation.
    const second = await claim(campaignId, runId, memberId, "did:plc:m1");
    expect(second.rows[0].needs_reconcile).toBe(false);
    expect(second.rows[0].may_mutate).toBe(true);
  }, 120_000);

  it("a crash AFTER provider intent stays reconciliation-only", async () => {
    // The other side of the same line. Once intent is stamped, a
    // mutation may have reached a real person and nothing may be sent
    // again until truth says otherwise.
    const { campaignId, runId } = await freshCampaign(5, 5);
    const res = await reserve(campaignId, runId, 5);
    const reservationId = res.rows[0].reservation_id!;
    const memberId = res.rows.filter((r) => r.member_id)[0].member_id!;

    const first = await claim(campaignId, runId, memberId, "did:plc:m1");
    await h.admin.query(
      `select * from public.consume_bluesky_member_quota(
         $1,$2,$3,$4,$5,$6,$7)`,
      [
        t.workspaceId, campaignId, runId, reservationId, memberId,
        first.rows[0].action_id, identityId,
      ],
    );

    const action = await h.admin.query<{ provider_in_flight_at: string | null }>(
      `select provider_in_flight_at from public.bluesky_relationship_actions
        where campaign_member_id=$1`,
      [memberId],
    );
    expect(action.rows[0].provider_in_flight_at).not.toBeNull();

    const second = await claim(campaignId, runId, memberId, "did:plc:m1");
    expect(second.rows[0].needs_reconcile).toBe(true);
    expect(second.rows[0].may_mutate).toBe(false);
  }, 120_000);
});

// =====================================================================
// 2. Lock order
// =====================================================================

describe("lock order across the quota functions", () => {
  it("consume and settle do not deadlock against each other", async () => {
    // A deliberate ABBA setup, with the blocking under our control
    // rather than left to chance.
    //
    // Session A holds the identity-usage row, which is exactly what
    // `reserve` and `apply_bluesky_run_outcome` hold for the length of
    // their transaction. Session B then runs `consume`.
    //
    // If `consume` reaches for the RESERVATION before the usage row, it
    // parks holding the reservation and waits for A — while A, going on
    // to settle, waits for the reservation. Neither can proceed and
    // Postgres kills one with "deadlock detected".
    //
    // With one global lock order there is no cycle: B blocks on the
    // usage row holding nothing at all, and simply proceeds once A is
    // done.
    const { campaignId, runId } = await freshCampaign(20, 20);
    const res = await reserve(campaignId, runId, 5);
    const reservationId = res.rows[0].reservation_id!;
    const memberId = res.rows.filter((r) => r.member_id)[0].member_id!;
    const claimed = await claim(campaignId, runId, memberId, "did:plc:m1");
    const actionId = claimed.rows[0].action_id;

    const a = await h.connect();
    const b = await h.connect();
    const errors: string[] = [];

    await a.query("begin");
    await a.query(
      `select * from public.bluesky_identity_daily_usage
        where workspace_id=$1 and operator_account_id=$2 and usage_date=$3
        for update`,
      [t.workspaceId, identityId, TODAY],
    );

    // B tries to spend a unit. It must not end up holding the
    // reservation while waiting for the usage row.
    const bWork = b
      .query(
        `select * from public.consume_bluesky_member_quota(
           $1,$2,$3,$4,$5,$6,$7)`,
        [
          t.workspaceId, campaignId, runId, reservationId, memberId,
          actionId, identityId,
        ],
      )
      .catch((err: Error) => {
        errors.push(`B: ${err.message}`);
      });

    // Give B time to reach its first lock.
    await new Promise((r) => setTimeout(r, 400));

    // A now settles the SAME reservation, still holding the usage row.
    const aWork = a
      .query(
        `select * from public.apply_bluesky_run_outcome(
           $1,$2,$3,$4,$5,$6, 0, null, null, null)`,
        [t.workspaceId, campaignId, runId, identityId, TODAY, reservationId],
      )
      .then(() => a.query("commit"))
      .catch((err: Error) => {
        errors.push(`A: ${err.message}`);
        return a.query("rollback");
      });

    await Promise.all([aWork, bWork]);

    expect(errors.filter((e) => /deadlock detected/i.test(e))).toEqual([]);

    await a.end();
    await b.end();
  }, 120_000);

  it("every quota function takes identity usage first", async () => {
    // The property behind the test above, asserted directly on the
    // shipped source so a future edit cannot quietly reintroduce the
    // cycle. A textual check is weak on its own — it is here to
    // localise the failure, with the deadlock test as the real proof.
    const { readFileSync, readdirSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const sql = readdirSync(dir)
      .filter((f) => f >= "20260911000003" && f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(path.join(dir, f), "utf8"))
      .join("\n");

    // The LAST definition of each function is what ships.
    const bodyOf = (name: string): string => {
      const marker = `create or replace function public.${name}(`;
      const at = sql.lastIndexOf(marker);
      expect(at, name).toBeGreaterThan(-1);
      const end = sql.indexOf("\n$$;", at);
      return sql.slice(at, end);
    };

    for (const fn of [
      "consume_bluesky_member_quota",
      "apply_bluesky_run_outcome",
      "reserve_bluesky_campaign_quota",
    ]) {
      const body = bodyOf(fn);
      const usage = body.indexOf("bluesky_identity_daily_usage");
      const reservation = body.indexOf("bluesky_campaign_quota_reservations");
      expect(usage, `${fn} must touch identity usage`).toBeGreaterThan(-1);
      if (reservation > -1) {
        expect(usage, `${fn} locks usage before reservation`).toBeLessThan(
          reservation,
        );
      }
    }
  }, 60_000);
});

// =====================================================================
// 3. Folding the EXACT action
// =====================================================================

describe("folding an outcome", () => {
  it("uses the action the ledger names, not whatever shares the member", async () => {
    // A member can legitimately carry more than one action row: the
    // partial unique index only forbids a second NON-skipped one. An
    // earlier skipped attempt plus a later successful one is ordinary.
    //
    // Joining on member_id alone then matches both, and one member
    // reports two outcomes — a success AND a skip — from a single
    // attempt. The ledger already records which action it paid for.
    const { campaignId, runId } = await freshCampaign(5, 5);
    const res = await reserve(campaignId, runId, 5);
    const reservationId = res.rows[0].reservation_id!;
    const memberId = res.rows.filter((r) => r.member_id)[0].member_id!;

    // An older, skipped attempt.
    await h.admin.query(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did,
          status, campaign_id, campaign_run_id, campaign_member_id)
       values ($1,$2,'follow','did:plc:m1','skipped',$3,$4,$5)`,
      [t.workspaceId, identityId, campaignId, runId, memberId],
    );

    // Then the real one, which succeeds.
    const live = await claim(campaignId, runId, memberId, "did:plc:m1");
    const actionId = live.rows[0].action_id;
    await h.admin.query(
      `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
      [
        t.workspaceId, campaignId, runId, reservationId, memberId,
        actionId, identityId,
      ],
    );
    await h.admin.query(
      `update public.bluesky_relationship_actions
          set status='succeeded', provider_in_flight_at=null,
              follow_uri='at://x', follow_rkey='rk', finished_at=now()
        where id=$1`,
      [actionId],
    );

    await h.admin.query(`select public.fold_bluesky_ledger_outcomes($1)`, [
      reservationId,
    ]);

    const run = await h.admin.query<{
      succeeded_count: number;
      skipped_count: number;
      already_following_count: number;
      failed_count: number;
    }>(
      `select succeeded_count, skipped_count, already_following_count,
              failed_count
         from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    expect(Number(run.rows[0].succeeded_count)).toBe(1);
    expect(Number(run.rows[0].skipped_count)).toBe(0);
    expect(Number(run.rows[0].already_following_count)).toBe(0);
    expect(Number(run.rows[0].failed_count)).toBe(0);

    // One attempt, one outcome. Never two.
    const usage = await h.admin.query<{ follows_created: number }>(
      `select follows_created from public.bluesky_identity_daily_usage
        where workspace_id=$1 and operator_account_id=$2 and usage_date=$3`,
      [t.workspaceId, identityId, TODAY],
    );
    expect(Number(usage.rows[0].follows_created)).toBe(1);
  }, 120_000);

  it("a ledger row with no action at all folds as exactly one unknown", async () => {
    // The legacy shape: rows written before `action_id` was recorded.
    // It must stay deterministic and must never fan out.
    const { campaignId, runId } = await freshCampaign(5, 5);
    const res = await reserve(campaignId, runId, 5);
    const reservationId = res.rows[0].reservation_id!;
    const memberId = res.rows.filter((r) => r.member_id)[0].member_id!;

    // Two action rows, neither named by the ledger.
    for (const status of ["skipped", "failed"]) {
      await h.admin.query(
        `insert into public.bluesky_relationship_actions
           (workspace_id, operator_account_id, action_type, subject_did,
            status, campaign_id, campaign_run_id, campaign_member_id)
         values ($1,$2,'follow','did:plc:m1',$3,$4,$5,$6)`,
        [t.workspaceId, identityId, status, campaignId, runId, memberId],
      );
    }

    const folded = await h.admin.query<{ fold_bluesky_ledger_outcomes: number }>(
      `select public.fold_bluesky_ledger_outcomes($1)`,
      [reservationId],
    );
    // Five ledger rows for five claimed members — five folds, not six
    // and not nine.
    expect(Number(folded.rows[0].fold_bluesky_ledger_outcomes)).toBe(5);

    const run = await h.admin.query<{
      succeeded_count: number;
      skipped_count: number;
      failed_count: number;
    }>(
      `select succeeded_count, skipped_count, failed_count
         from public.bluesky_follow_campaign_runs where id=$1`,
      [runId],
    );
    const total =
      Number(run.rows[0].succeeded_count) +
      Number(run.rows[0].skipped_count) +
      Number(run.rows[0].failed_count);
    expect(total).toBeLessThanOrEqual(5);
  }, 120_000);
});

// =====================================================================
// 4. Losing the audit-row race
// =====================================================================

describe("two workers claiming the same member", () => {
  it("the loser is DENIED — not terminal, and not reconciliation", async () => {
    // Produced through the database, not simulated.
    //
    // Both sessions look for the audit row, both find nothing (neither
    // has committed), and both insert. The unique index lets exactly
    // one through; the other lands in the RPC's `unique_violation`
    // handler.
    //
    // Every field of the verdict it gets back matters, and the
    // combination is the point: NOT terminal (the winner is still
    // working), NOT reconciliation (nothing has been sent on the
    // loser's behalf and no provider intent exists for it), and NOT
    // permitted. It means "this member is not yours".
    const { campaignId, runId } = await freshCampaign(5, 5);
    const res = await reserve(campaignId, runId, 5);
    const memberId = res.rows.filter((r) => r.member_id)[0].member_id!;

    const a = await h.connect();
    const b = await h.connect();
    await a.query("begin");
    await b.query("begin");

    // A inserts and holds the transaction open.
    const winner = await claim(campaignId, runId, memberId, "did:plc:m1", a);
    expect(winner.rows[0].may_mutate).toBe(true);

    // B reaches the same insert and blocks on the unique index.
    const loserWork = claim(campaignId, runId, memberId, "did:plc:m1", b);
    await new Promise((r) => setTimeout(r, 300));

    await a.query("commit");
    const loser = await loserWork;

    expect(loser.rows[0].may_mutate).toBe(false);
    expect(loser.rows[0].needs_reconcile).toBe(false);
    expect(loser.rows[0].terminal).toBe(false);
    // And it points at the winner's row, not a second one.
    expect(loser.rows[0].action_id).toBe(winner.rows[0].action_id);

    await b.query("commit");

    const actions = await h.admin.query<{ n: string }>(
      `select count(*) n from public.bluesky_relationship_actions
        where campaign_member_id=$1`,
      [memberId],
    );
    expect(Number(actions.rows[0].n)).toBe(1);

    await a.end();
    await b.end();
  }, 120_000);

  it("releasing by id alone would clear the new owner's lease", async () => {
    // The hazard the ownership-checked release exists for. A worker
    // whose lease lapsed still believes it holds these rows.
    const { campaignId, runId } = await freshCampaign(5, 5);
    const first = await reserve(campaignId, runId, 5, "worker-A");
    const memberIds = first.rows
      .filter((r) => r.member_id)
      .map((r) => r.member_id as string);
    const reservationA = first.rows[0].reservation_id!;

    // A's lease lapses and B reclaims everything.
    await h.admin.query(
      `update public.bluesky_follow_campaign_members
          set lease_expires_at = now() - interval '1 minute'
        where campaign_id=$1`,
      [campaignId],
    );
    await h.admin.query(
      `update public.bluesky_campaign_quota_reservations
          set expires_at = now() - interval '1 minute'
        where id=$1`,
      [reservationA],
    );
    const second = await reserve(campaignId, runId, 5, "worker-B");
    const reservationB = second.rows[0].reservation_id!;
    expect(reservationB).not.toBe(reservationA);

    // A now finishes its chunk and hands back what it "leased but never
    // attempted". With ownership checked, it releases NOTHING.
    const released = await h.admin.query<{ n: number }>(
      `select public.release_bluesky_campaign_members_owned(
         $1,$2,$3,$4,$5) n`,
      [t.workspaceId, campaignId, memberIds, "worker-A", reservationA],
    );
    expect(Number(released.rows[0].n)).toBe(0);

    // B still holds every row.
    const held = await h.admin.query<{ n: string }>(
      `select count(*) n from public.bluesky_follow_campaign_members
        where campaign_id=$1 and claimed_by='worker-B'
          and reservation_id=$2 and status='claimed'`,
      [campaignId, reservationB],
    );
    expect(Number(held.rows[0].n)).toBe(memberIds.length);

    // And B can still hand back its own.
    const bReleased = await h.admin.query<{ n: number }>(
      `select public.release_bluesky_campaign_members_owned(
         $1,$2,$3,$4,$5) n`,
      [t.workspaceId, campaignId, memberIds, "worker-B", reservationB],
    );
    expect(Number(bReleased.rows[0].n)).toBe(memberIds.length);
  }, 120_000);
});
