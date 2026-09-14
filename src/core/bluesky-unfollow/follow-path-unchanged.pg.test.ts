import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createPgHarness,
  seedTenant,
  type PgHarness,
  type Tenant,
} from "@/test/pg/harness";

/**
 * The Follow path, after this migration replaced two of its functions.
 *
 * `20260914000001` uses `create or replace` on
 * `claim_bluesky_campaign_action` and `fold_bluesky_ledger_outcomes`.
 * Both are deployed Follow code, and `create or replace` rewrites the
 * WHOLE body — so the follow branch inside each had to be reproduced,
 * and a reproduction can drift from what it reproduces.
 *
 * These tests are the control on that. They exercise the follow branch
 * end to end and assert the counters it moves, so a divergence is
 * caught here rather than discovered as a wrong follow count in
 * production.
 */

let h: PgHarness;
let t: Tenant;
const TODAY = "2026-09-14";
const ACTOR = "did:plc:followpathactor";

beforeAll(async () => {
  h = await createPgHarness();
  t = await seedTenant(h.db, "follow-unchanged");
}, 180_000);
afterAll(async () => { await h?.close(); });

async function followCampaign(name: string) {
  const c = await h.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, status)
     values ($1,$2,$3,'active') returning id`,
    [t.workspaceId, t.identityId, name],
  );
  return c.rows[0].id;
}

async function member(campaignId: string, did: string, seq: number) {
  const m = await h.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaign_members
       (workspace_id, campaign_id, subject_did, import_sequence)
     values ($1,$2,$3,$4) returning id`,
    [t.workspaceId, campaignId, did, seq],
  );
  return m.rows[0].id;
}

async function run(campaignId: string, localDate: string) {
  const r = await h.db.query<{ id: string }>(
    `select id from public.ensure_bluesky_campaign_run($1,$2,$3,100,100,null)`,
    [t.workspaceId, campaignId, localDate],
  );
  return r.rows[0].id;
}

describe("a campaign created without a kind is still a FOLLOW campaign", () => {
  it("the column defaults, so every deployed row keeps working", async () => {
    const c = await followCampaign("defaulted");
    const r = await h.db.query<{ kind: string }>(
      `select kind from public.bluesky_follow_campaigns where id = $1`,
      [c],
    );
    expect(r.rows[0].kind).toBe("follow");
  });

  it("claim_bluesky_campaign_action still grants it the mutation", async () => {
    const c = await followCampaign("claim works");
    const runId = await run(c, TODAY);
    const m = await member(c, "did:plc:followsubject", 1);

    const v = await h.db.query<{
      action_id: string;
      may_mutate: boolean;
      needs_reconcile: boolean;
      terminal: boolean;
    }>(
      `select * from public.claim_bluesky_campaign_action(
         $1,$2,$3,$4,$5,$6,null,$7,null,null)`,
      [t.workspaceId, c, runId, m, t.identityId, "did:plc:followsubject", ACTOR],
    );
    expect(v.rows[0].may_mutate).toBe(true);
    expect(v.rows[0].needs_reconcile).toBe(false);
    expect(v.rows[0].terminal).toBe(false);

    const row = await h.db.query<Record<string, unknown>>(
      `select action_type, status, provider_in_flight_at, started_at,
              initiator_kind, source_target_profile_ids
         from public.bluesky_relationship_actions where id = $1`,
      [v.rows[0].action_id],
    );
    // Every field the deployed version wrote, still written.
    expect(row.rows[0].action_type).toBe("follow");
    expect(row.rows[0].status).toBe("running");
    expect(row.rows[0].started_at).not.toBeNull();
    expect(row.rows[0].initiator_kind).toBe("operator_batch");

    // AND NO IN-FLIGHT MARKER. This is the assertion this file was
    // written with backwards, and the one the deployed real-PostgreSQL
    // suites caught: creating the row says "this worker intends to
    // handle this member", NOT "a request is in flight". Conflating the
    // two is the defect 20260911000005 fixed — a crash between claiming
    // and sending then silenced the member permanently, because every
    // later pass read the marker as "something may have been sent".
    expect(row.rows[0].provider_in_flight_at).toBeNull();
  });

  it("a second claim with NO marker still permits the FIRST attempt", async () => {
    // The member is owed its first attempt: a worker claimed the row
    // and died before spending its unit, so nothing was ever sent.
    const c = await followCampaign("no marker");
    const runId = await run(c, TODAY);
    const m = await member(c, "did:plc:nomarker", 1);

    const call = () =>
      h.db.query<Record<string, boolean | string>>(
        `select * from public.claim_bluesky_campaign_action(
           $1,$2,$3,$4,$5,$6,null,$7,null,null)`,
        [t.workspaceId, c, runId, m, t.identityId, "did:plc:nomarker", ACTOR],
      );

    const first = await call();
    expect(first.rows[0].may_mutate).toBe(true);

    const second = await call();
    expect(second.rows[0].may_mutate).toBe(true);
    expect(second.rows[0].needs_reconcile).toBe(false);
    expect(second.rows[0].action_id).toBe(first.rows[0].action_id);
  });

  it("a second claim WITH a marker is RECONCILE-ONLY", async () => {
    const c = await followCampaign("second claim");
    const runId = await run(c, TODAY);
    const m = await member(c, "did:plc:secondclaim", 1);

    const call = () =>
      h.db.query<Record<string, boolean | string>>(
        `select * from public.claim_bluesky_campaign_action(
           $1,$2,$3,$4,$5,$6,null,$7,null,null)`,
        [t.workspaceId, c, runId, m, t.identityId, "did:plc:secondclaim", ACTOR],
      );

    const first = await call();
    expect(first.rows[0].may_mutate).toBe(true);

    // A createRecord MAY have reached a real person. The MARKER is what
    // says so — not the status.
    await h.db.query(
      `update public.bluesky_relationship_actions
          set provider_in_flight_at = now() where id = $1`,
      [first.rows[0].action_id],
    );

    const second = await call();
    expect(second.rows[0].may_mutate).toBe(false);
    expect(second.rows[0].needs_reconcile).toBe(true);
    expect(second.rows[0].action_id).toBe(first.rows[0].action_id);
  });

  it("a terminal action is reported terminal, as before", async () => {
    const c = await followCampaign("terminal claim");
    const runId = await run(c, TODAY);
    const m = await member(c, "did:plc:terminalclaim", 1);

    const first = await h.db.query<Record<string, string>>(
      `select * from public.claim_bluesky_campaign_action(
         $1,$2,$3,$4,$5,$6,null,$7,null,null)`,
      [t.workspaceId, c, runId, m, t.identityId, "did:plc:terminalclaim", ACTOR],
    );
    await h.db.query(
      `update public.bluesky_relationship_actions
          set status = 'succeeded' where id = $1`,
      [first.rows[0].action_id],
    );

    const again = await h.db.query<Record<string, boolean | string>>(
      `select * from public.claim_bluesky_campaign_action(
         $1,$2,$3,$4,$5,$6,null,$7,null,null)`,
      [t.workspaceId, c, runId, m, t.identityId, "did:plc:terminalclaim", ACTOR],
    );
    expect(again.rows[0].terminal).toBe(true);
    expect(again.rows[0].existing_status).toBe("succeeded");
  });
});

describe("fold_bluesky_ledger_outcomes still counts FOLLOWS as follows", () => {
  it("a created record moves succeeded_count AND follows_created", async () => {
    const c = await followCampaign("fold follow");
    const runId = await run(c, "2026-09-20");
    const m = await member(c, "did:plc:foldfollow", 1);

    const res = await h.db.query<{ id: string }>(
      `insert into public.bluesky_campaign_quota_reservations
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reserved_count, status, claimed_by, expires_at)
       values ($1,$2,$3,$4,'2026-09-20',1,'open','w', now() + interval '5 min')
       returning id`,
      [t.workspaceId, c, runId, t.identityId],
    );
    const action = await h.db.query<{ id: string }>(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did, actor_did,
          status, campaign_id, campaign_run_id, campaign_member_id, follow_uri)
       values ($1,$2,'follow','did:plc:foldfollow',$3,'succeeded',$4,$5,$6,$7)
       returning id`,
      [
        t.workspaceId, t.identityId, ACTOR, c, runId, m,
        `at://${ACTOR}/app.bsky.graph.follow/rk1`,
      ],
    );
    await h.db.query(
      `insert into public.bluesky_campaign_attempt_ledger
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reservation_id, member_id, action_id, provider_intent_at)
       values ($1,$2,$3,$4,'2026-09-20',$5,$6,$7, now())`,
      [t.workspaceId, c, runId, t.identityId, res.rows[0].id, m, action.rows[0].id],
    );
    await h.db.query(
      `insert into public.bluesky_identity_daily_usage
         (workspace_id, operator_account_id, usage_date)
       values ($1,$2,'2026-09-20') on conflict do nothing`,
      [t.workspaceId, t.identityId],
    );

    const folded = await h.db.query<{ fold_bluesky_ledger_outcomes: number }>(
      `select public.fold_bluesky_ledger_outcomes($1)`,
      [res.rows[0].id],
    );
    expect(Number(folded.rows[0].fold_bluesky_ledger_outcomes)).toBe(1);

    const runRow = await h.db.query<Record<string, number>>(
      `select succeeded_count, already_following_count, already_absent_count,
              failed_count, skipped_count
         from public.bluesky_follow_campaign_runs where id = $1`,
      [runId],
    );
    expect(Number(runRow.rows[0].succeeded_count)).toBe(1);
    // The FOLLOW column, not the unfollow one.
    expect(Number(runRow.rows[0].already_absent_count)).toBe(0);

    const usage = await h.db.query<Record<string, number>>(
      `select follows_created, unfollows_deleted
         from public.bluesky_identity_daily_usage
        where operator_account_id = $1 and usage_date = '2026-09-20'`,
      [t.identityId],
    );
    // THE ASSERTION THIS FILE EXISTS FOR. A follow must raise the
    // follow counter and nothing else — the unfollow branch raises
    // `unfollows_deleted` from the same two facts, so a mis-routed
    // branch would be invisible except here.
    expect(Number(usage.rows[0].follows_created)).toBe(1);
    expect(Number(usage.rows[0].unfollows_deleted)).toBe(0);
  });

  it("an ALREADY-FOLLOWING outcome counts as such and spends no record", async () => {
    const c = await followCampaign("fold already");
    const runId = await run(c, "2026-09-21");
    const m = await member(c, "did:plc:foldalready", 1);

    const res = await h.db.query<{ id: string }>(
      `insert into public.bluesky_campaign_quota_reservations
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reserved_count, status, claimed_by, expires_at)
       values ($1,$2,$3,$4,'2026-09-21',1,'open','w', now() + interval '5 min')
       returning id`,
      [t.workspaceId, c, runId, t.identityId],
    );
    const action = await h.db.query<{ id: string }>(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did, actor_did,
          status, campaign_id, campaign_run_id, campaign_member_id)
       values ($1,$2,'follow','did:plc:foldalready',$3,'succeeded',$4,$5,$6)
       returning id`,
      [t.workspaceId, t.identityId, ACTOR, c, runId, m],
    );
    await h.db.query(
      `insert into public.bluesky_campaign_attempt_ledger
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reservation_id, member_id, action_id)
       values ($1,$2,$3,$4,'2026-09-21',$5,$6,$7)`,
      [t.workspaceId, c, runId, t.identityId, res.rows[0].id, m, action.rows[0].id],
    );
    await h.db.query(
      `insert into public.bluesky_identity_daily_usage
         (workspace_id, operator_account_id, usage_date)
       values ($1,$2,'2026-09-21') on conflict do nothing`,
      [t.workspaceId, t.identityId],
    );

    await h.db.query(`select public.fold_bluesky_ledger_outcomes($1)`, [
      res.rows[0].id,
    ]);

    const runRow = await h.db.query<Record<string, number>>(
      `select succeeded_count, already_following_count
         from public.bluesky_follow_campaign_runs where id = $1`,
      [runId],
    );
    // Succeeded WITHOUT a follow_uri is the already-following path:
    // observed, not created, and no provider budget was spent.
    expect(Number(runRow.rows[0].succeeded_count)).toBe(0);
    expect(Number(runRow.rows[0].already_following_count)).toBe(1);

    const usage = await h.db.query<Record<string, number>>(
      `select follows_created from public.bluesky_identity_daily_usage
        where operator_account_id = $1 and usage_date = '2026-09-21'`,
      [t.identityId],
    );
    expect(Number(usage.rows[0].follows_created)).toBe(0);
  });

  it("folding is IDEMPOTENT — a row is counted exactly once", async () => {
    const c = await followCampaign("fold twice");
    const runId = await run(c, "2026-09-22");
    const m = await member(c, "did:plc:foldtwice", 1);
    const res = await h.db.query<{ id: string }>(
      `insert into public.bluesky_campaign_quota_reservations
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reserved_count, status, claimed_by, expires_at)
       values ($1,$2,$3,$4,'2026-09-22',1,'open','w', now() + interval '5 min')
       returning id`,
      [t.workspaceId, c, runId, t.identityId],
    );
    const action = await h.db.query<{ id: string }>(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did, actor_did,
          status, campaign_id, campaign_run_id, campaign_member_id, follow_uri)
       values ($1,$2,'follow','did:plc:foldtwice',$3,'succeeded',$4,$5,$6,$7)
       returning id`,
      [t.workspaceId, t.identityId, ACTOR, c, runId, m, `at://${ACTOR}/a/b`],
    );
    await h.db.query(
      `insert into public.bluesky_campaign_attempt_ledger
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reservation_id, member_id, action_id, provider_intent_at)
       values ($1,$2,$3,$4,'2026-09-22',$5,$6,$7, now())`,
      [t.workspaceId, c, runId, t.identityId, res.rows[0].id, m, action.rows[0].id],
    );

    const a = await h.db.query<{ fold_bluesky_ledger_outcomes: number }>(
      `select public.fold_bluesky_ledger_outcomes($1)`, [res.rows[0].id]);
    const b = await h.db.query<{ fold_bluesky_ledger_outcomes: number }>(
      `select public.fold_bluesky_ledger_outcomes($1)`, [res.rows[0].id]);
    expect(Number(a.rows[0].fold_bluesky_ledger_outcomes)).toBe(1);
    expect(Number(b.rows[0].fold_bluesky_ledger_outcomes)).toBe(0);

    const runRow = await h.db.query<Record<string, number>>(
      `select succeeded_count from public.bluesky_follow_campaign_runs where id = $1`,
      [runId],
    );
    expect(Number(runRow.rows[0].succeeded_count)).toBe(1);
  });
});
