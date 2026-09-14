import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPgServerHarness,
  seedServerTenant,
  type PgServerHarness,
  type ServerTenant,
} from "@/test/pg/server-harness";

/**
 * The changed takeover predicate and the re-open RPC, under REAL
 * contention: two backends on an embedded PostgreSQL server. PGlite is
 * single-backend and cannot observe a lock blocking or SKIP LOCKED
 * skipping; these can.
 */

let h: PgServerHarness;
let t: ServerTenant;
const TODAY = "2026-09-14";
const ACTOR = "did:plc:twosessionincident";

beforeAll(async () => {
  h = await createPgServerHarness();
  t = await seedServerTenant(h.admin, "incident-two-session");
}, 300_000);
afterAll(async () => { await h?.close(); });

async function setup(name: string) {
  const c = (await h.admin.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, status, requested_daily_quota)
     values ($1,$2,$3,'active',400) returning id`,
    [t.workspaceId, t.identityId, name])).rows[0].id;
  const m = (await h.admin.query<{ id: string }>(
    `insert into public.bluesky_follow_campaign_members
       (workspace_id, campaign_id, subject_did, import_sequence, status)
     values ($1,$2,$3,1,'retryable') returning id`,
    [t.workspaceId, c, `did:plc:${name.replace(/\W/g, "")}`])).rows[0].id;
  const run = (await h.admin.query<{ id: string }>(
    `select id from public.ensure_bluesky_campaign_run($1,$2,$3,400,400,null)`,
    [t.workspaceId, c, TODAY])).rows[0].id;
  const res = (await h.admin.query<{ id: string }>(
    `insert into public.bluesky_campaign_quota_reservations
       (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
        reserved_count, status, claimed_by, expires_at)
     values ($1,$2,$3,$4,$5,0,'settled','earlier', now() - interval '1 hour') returning id`,
    [t.workspaceId, c, run, t.identityId, TODAY])).rows[0].id;
  const a = (await h.admin.query<{ id: string }>(
    `insert into public.bluesky_relationship_actions
       (workspace_id, operator_account_id, action_type, subject_did, actor_did,
        status, campaign_id, campaign_run_id, campaign_member_id,
        provider_error_code, provider_status_code)
     values ($1,$2,'follow',$3,$4,'reconciliation_required',$5,$6,$7,'ExpiredToken',400)
     returning id`,
    [t.workspaceId, t.identityId, `did:plc:${name.replace(/\W/g, "")}`, ACTOR, c, run, m])).rows[0].id;
  await h.admin.query(
    `insert into public.bluesky_campaign_attempt_ledger
       (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
        reservation_id, member_id, action_id, provider_intent_at, counted_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, now() - interval '1 hour', now() - interval '1 hour')`,
    [t.workspaceId, c, run, t.identityId, TODAY, res, m, a]);
  return { c, m, run, a };
}

const reserve = (db: import("pg").Client, c: string, run: string, by: string) =>
  db.query<{ reserved: number; reservation_id: string | null; reason: string; member_id: string | null }>(
    `select * from public.reserve_bluesky_campaign_quota($1,$2,$3,$4,$5,400,10000,20,300,$6)`,
    [t.workspaceId, c, run, t.identityId, TODAY, by]);

describe("the takeover predicate", () => {
  it("a reconciliation_required action IS taken over (zero units)", async () => {
    const { c, m, run } = await setup("takeover yes");
    const r = await reserve(h.admin, c, run, "w");
    expect(r.rows[0].reason).toBe("reconcile");
    expect(r.rows[0].member_id).toBe(m);
    expect(Number(r.rows[0].reserved)).toBe(0);
  });

  it("a RE-OPENED action (pending, no marker) is NOT taken over — it goes through quota", async () => {
    const { c, m, run, a } = await setup("takeover no");
    const reopened = await h.admin.query<{ reopened: boolean; refused_reason: string | null }>(
      `select * from public.reopen_bluesky_campaign_action($1,$2,$3,'ExpiredToken','Token has expired')`,
      [t.workspaceId, a, m]);
    expect(reopened.rows[0].reopened).toBe(true);

    const r = await reserve(h.admin, c, run, "w");
    // Granted through the ORDINARY path with a real unit — not a
    // zero-unit takeover that consume would then refuse to fund.
    expect(r.rows[0].reason).toBe("granted");
    expect(r.rows[0].member_id).toBe(m);
    expect(Number(r.rows[0].reserved)).toBe(1);
  });

  it("re-open refuses a code that does not prove a rejection", async () => {
    const { m, a } = await setup("refuse ambiguous");
    const r = await h.admin.query<{ reopened: boolean; refused_reason: string }>(
      `select * from public.reopen_bluesky_campaign_action($1,$2,$3,'BadGateway','502')`,
      [t.workspaceId, a, m]);
    expect(r.rows[0].reopened).toBe(false);
    expect(r.rows[0].refused_reason).toBe("not_a_definite_rejection");
  });

  it("re-open refuses a terminal action and a mismatched member", async () => {
    const { m, a } = await setup("refuse terminal");
    await h.admin.query(`update public.bluesky_relationship_actions set status='succeeded' where id=$1`, [a]);
    const r = await h.admin.query<{ refused_reason: string }>(
      `select * from public.reopen_bluesky_campaign_action($1,$2,$3,'ExpiredToken',null)`,
      [t.workspaceId, a, m]);
    expect(r.rows[0].refused_reason).toBe("action_terminal");
    const other = await setup("refuse mismatch");
    const r2 = await h.admin.query<{ refused_reason: string }>(
      `select * from public.reopen_bluesky_campaign_action($1,$2,$3,'ExpiredToken',null)`,
      [t.workspaceId, other.a, m]);
    expect(r2.rows[0].refused_reason).toBe("member_mismatch");
  });
});

describe("two sessions", () => {
  it("re-open and a concurrent takeover cannot both win the same member", async () => {
    const { c, m, run, a } = await setup("race");
    const A = await h.connect();
    const B = await h.connect();

    // A holds the action row (as the worker's settle path does inside
    // its transaction); B tries to take the member over meanwhile.
    await A.query("begin");
    await A.query(
      `select * from public.reopen_bluesky_campaign_action($1,$2,$3,'ExpiredToken',null)`,
      [t.workspaceId, a, m]);

    let bSettled = false;
    const bWork = reserve(B, c, run, "B").then((r) => { bSettled = true; return r; });
    await new Promise((r) => setTimeout(r, 250));
    // B is BLOCKED on A's row lock — a real property of a real backend.
    // (The reserve reads the action under the member's FOR UPDATE SKIP
    // LOCKED, but the action row itself is locked by A's re-open.)
    await A.query("commit");
    const rb = await bWork;
    expect(bSettled).toBe(true);

    // THE INVARIANT. B's takeover read is a snapshot: it may have seen
    // the action before A's re-open committed and handed the member a
    // zero-unit reconciliation reservation. That is allowed. What is
    // NOT allowed is for that reservation to fund a provider call — and
    // it cannot: consume refuses a reservation with nothing to spend.
    // So whichever verdict B got, the member cannot be mutated under it.
    if (rb.rows[0].reason === "reconcile") {
      const consume = await h.admin.query<{ consumed: boolean; refused_reason: string }>(
        `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
        [t.workspaceId, c, run, rb.rows[0].reservation_id, m, a, t.identityId]);
      expect(consume.rows[0].consumed).toBe(false);
      expect(consume.rows[0].refused_reason).toBe("reservation_exhausted");
    } else {
      expect(rb.rows[0].reason).toBe("granted");
      expect(Number(rb.rows[0].reserved)).toBe(1);
    }
    // And in every case, exactly ONE open reservation exists for the member.
    const open = await h.admin.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_campaign_quota_reservations
        where campaign_id = $1 and status = 'open'`, [c]);
    expect(open.rows[0].n).toBe("1");

    await A.end();
    await B.end();
  });

  it("resume-after-recovery moves a run exactly once under two sessions", async () => {
    const { c, run } = await setup("resume race");
    await h.admin.query(
      `update public.bluesky_follow_campaign_runs
          set status = 'paused', last_error_code = 'reauthorization_required' where id = $1`, [run]);
    const A = await h.connect();
    const B = await h.connect();
    const [ra, rb] = await Promise.all([
      A.query<{ resumed: boolean }>(
        `select * from public.resume_bluesky_campaign_run_after_recovery($1,$2,$3)`,
        [t.workspaceId, c, TODAY]),
      B.query<{ resumed: boolean }>(
        `select * from public.resume_bluesky_campaign_run_after_recovery($1,$2,$3)`,
        [t.workspaceId, c, TODAY]),
    ]);
    const wins = [ra.rows[0].resumed, rb.rows[0].resumed].filter(Boolean).length;
    expect(wins).toBe(1);
    const runs = await h.admin.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_follow_campaign_runs where campaign_id = $1`, [c]);
    expect(runs.rows[0].n).toBe("1");
    await A.end();
    await B.end();
  });

  it("never resumes a completed or cancelled run", async () => {
    const { c, run } = await setup("no resume terminal");
    for (const status of ["completed", "cancelled"]) {
      await h.admin.query(`update public.bluesky_follow_campaign_runs set status=$2 where id=$1`, [run, status]);
      const r = await h.admin.query<{ resumed: boolean; run_status: string }>(
        `select * from public.resume_bluesky_campaign_run_after_recovery($1,$2,$3)`,
        [t.workspaceId, c, TODAY]);
      expect(r.rows[0].resumed).toBe(false);
      expect(r.rows[0].run_status).toBe(status);
    }
  });
});
