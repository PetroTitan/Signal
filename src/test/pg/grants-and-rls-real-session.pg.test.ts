import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  createPgServerHarness,
  seedServerTenant,
  type PgServerHarness,
  type ServerTenant,
} from "./server-harness";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Privileges and RLS, evaluated by PostgreSQL for a GENUINE
 * non-superuser session.
 *
 * `set role` from a superuser session is what the PGlite suite does,
 * and it is a fair model of PostgREST — but a superuser that switched
 * roles is still a session that started as a superuser, and a test
 * that relies on it cannot notice a privilege it silently retained.
 * Here a LOGIN role is created, granted `authenticated`, and a second
 * connection is opened AS that role. What it can and cannot do is what
 * a signed-in client with the anon key could and could not do over
 * HTTP.
 */

/**
 * Every bluesky function a signed-in client may EXECUTE, pinned from the
 * shipped migrations. Three are trigger functions (harmless to call,
 * granted to PUBLIC by PostgreSQL's default) and one is the RLS helper
 * the policies themselves evaluate. No worker or quota RPC is here, and
 * none may be added without a reviewer seeing it in this list.
 */
const AUTHENTICATED_MAY_EXECUTE: string[] = [
  "bluesky_attempt_ledger_is_append_only",
  "bluesky_batch_membership_is_frozen",
  "bluesky_campaign_kind_is_immutable",
  "can_manage_bluesky_campaigns",
];

let h: PgServerHarness;
let t: ServerTenant;
let asUser: Client;
const ROLE = "app_user_under_test";

beforeAll(async () => {
  h = await createPgServerHarness();
  t = await seedServerTenant(h.admin, "rls-real");
  await h.admin.query(
    `do $$ begin
       if not exists (select 1 from pg_roles where rolname = '${ROLE}') then
         create role ${ROLE} login password 'under-test' nosuperuser nobypassrls noinherit;
       end if;
     end $$;`,
  );
  await h.admin.query(`grant authenticated to ${ROLE}`);
  asUser = await h.connect();
  // The harness connects as postgres; become the login role for real.
  // `set session authorization` is allowed to a superuser and yields a
  // session whose current AND session user is the login role — no
  // superuser is retained. (A direct password login would be the same
  // session; the harness does not expose per-connection credentials.)
  await asUser.query(`set session authorization ${ROLE}`);
  await asUser.query(`set role authenticated`);
  await asUser.query(
    `select set_config('request.jwt.claims', $1, false)`,
    [JSON.stringify({ sub: t.userId, role: "authenticated" })],
  );
}, 300_000);
afterAll(async () => { await h?.close(); });

describe("the session really is not a superuser", () => {
  it("reports itself as the login role with no superuser or bypassrls", async () => {
    const r = await asUser.query<{ session_user: string; current_user: string; su: boolean; bypass: boolean }>(
      `select session_user, current_user,
              (select rolsuper from pg_roles where rolname = session_user) as su,
              (select rolbypassrls from pg_roles where rolname = current_user) as bypass`,
    );
    expect(r.rows[0].session_user).toBe(ROLE);
    expect(r.rows[0].current_user).toBe("authenticated");
    expect(r.rows[0].su).toBe(false);
    expect(r.rows[0].bypass).toBe(false);
  });
});

describe("RPC EXECUTE stays service_role-only", () => {
  /** Worker and quota RPCs: every overload, looked up by name. */
  const WORKER_RPCS = [
    "reserve_bluesky_campaign_quota",
    "consume_bluesky_member_quota",
    "apply_bluesky_run_outcome",
    "fold_bluesky_ledger_outcomes",
    "sweep_bluesky_quota_reservations",
    "release_bluesky_campaign_members_owned",
    "acquire_bluesky_run_dispatch_lease",
    "release_bluesky_run_dispatch_lease",
    "claim_bluesky_campaign_action",
    "ensure_bluesky_campaign_run",
    "resume_bluesky_campaign_run",
    "resume_bluesky_campaign_run_after_recovery",
    "reopen_bluesky_campaign_action",
    "defer_bluesky_campaign_member",
    "bluesky_campaign_conservation",
    "bluesky_campaign_may_complete",
    "record_bluesky_identity_usage",
    // Identity-session coordination (20260917000002). Token state moves
    // ONLY through these, and only the service role may call them.
    "acquire_bluesky_refresh_lease",
    "release_bluesky_refresh_lease",
    "commit_bluesky_refreshed_session",
    "fail_bluesky_refresh",
    "recover_bluesky_reauthorized_campaigns",
    "stop_bluesky_campaigns_for_identity",
    // 20260917000004
    "bluesky_local_date_safe",
    "bluesky_recovery_health",
  ];

  it.each(WORKER_RPCS)("%s: every overload — authenticated and anon cannot execute, service_role can", async (name) => {
    const r = await h.admin.query<{ sig: string; auth: boolean; anon: boolean; svc: boolean }>(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('authenticated', p.oid, 'execute') as auth,
              has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('service_role', p.oid, 'execute') as svc
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`, [name]);
    expect(r.rows.length, `${name} exists`).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.auth, row.sig).toBe(false);
      expect(row.anon, row.sig).toBe(false);
      expect(row.svc, row.sig).toBe(true);
    }
  });

  it("…and the real session is refused when it tries", async () => {
    await expect(
      asUser.query(`select * from public.bluesky_campaign_may_complete($1, $2)`, [t.workspaceId, t.workspaceId]),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("the set of bluesky functions a signed-in client may execute is exactly the intended set", async () => {
    // Pinned. A migration that widens EXECUTE on any bluesky function
    // shows up here as a new name; a reviewer decides whether it was
    // meant, rather than the grant slipping through.
    const r = await h.admin.query<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like '%bluesky%'
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`);
    expect(r.rows.map((x) => x.proname)).toEqual(AUTHENTICATED_MAY_EXECUTE);
  });
});

describe("RLS for a real session", () => {
  let mine: string;
  let theirs: string;

  beforeAll(async () => {
    mine = (await h.admin.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name, kind, status, requested_daily_quota, timezone,
          execution_window_start_minute, execution_window_end_minute, created_by)
       values ($1, $2, 'mine', 'follow', 'active', 100, 'UTC', 0, 1440, $3) returning id`,
      [t.workspaceId, t.identityId, t.userId])).rows[0].id;
    const other = await seedServerTenant(h.admin, "rls-real-other");
    theirs = (await h.admin.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name, kind, status, requested_daily_quota, timezone,
          execution_window_start_minute, execution_window_end_minute, created_by)
       values ($1, $2, 'theirs', 'unfollow', 'active', 100, 'UTC', 0, 1440, $3) returning id`,
      [other.workspaceId, other.identityId, other.userId])).rows[0].id;
  });

  it("sees its own workspace's campaigns and not another's", async () => {
    const r = await asUser.query<{ id: string }>(`select id from public.bluesky_follow_campaigns`);
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("cannot read another workspace's members, runs, ledger, reservations or actions", async () => {
    for (const table of [
      "bluesky_follow_campaign_members",
      "bluesky_follow_campaign_runs",
      "bluesky_campaign_attempt_ledger",
      "bluesky_campaign_quota_reservations",
      "bluesky_relationship_actions",
    ]) {
      const r = await asUser.query<{ n: string }>(
        `select count(*)::text as n from public.${table} where campaign_id = $1`, [theirs]);
      expect(Number(r.rows[0].n), table).toBe(0);
    }
  });

  it("cannot move a campaign it does not own, and cannot forge the dispatch order", async () => {
    const r = await asUser.query(
      `update public.bluesky_follow_campaigns set status = 'cancelled' where id = $1 returning id`, [theirs]);
    expect(r.rowCount).toBe(0);
    const s = await asUser.query(
      `update public.bluesky_follow_campaigns set last_dispatched_at = now() where id = $1 returning id`, [theirs]);
    expect(s.rowCount).toBe(0);
    const still = await h.admin.query<{ status: string; at: Date | null }>(
      `select status, last_dispatched_at as at from public.bluesky_follow_campaigns where id = $1`, [theirs]);
    expect(still.rows[0].status).toBe("active");
    expect(still.rows[0].at).toBeNull();
  });
});

describe("the fairness migration", () => {
  it("is idempotent: applying it a second time changes nothing and fails nothing", async () => {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20260916000001_campaign_dispatch_fairness.sql"),
      "utf8",
    );
    await h.admin.query(sql);
    await h.admin.query(sql);
    const col = await h.admin.query<{ data_type: string; is_nullable: string }>(
      `select data_type, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'bluesky_follow_campaigns'
          and column_name = 'last_dispatched_at'`);
    expect(col.rows).toHaveLength(1);
    expect(col.rows[0].data_type).toBe("timestamp with time zone");
    expect(col.rows[0].is_nullable).toBe("YES");
  });

  it("changes no function privilege: after a second apply the executable set is the pinned set", async () => {
    const r = await h.admin.query<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like '%bluesky%'
          and has_function_privilege('authenticated', p.oid, 'execute')
        order by 1`);
    expect(r.rows.map((x) => x.proname)).toEqual(AUTHENTICATED_MAY_EXECUTE);
    const svc = await h.admin.query<{ n: string }>(
      `select count(*)::text as n
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like '%bluesky_campaign%'
          and not has_function_privilege('service_role', p.oid, 'execute')`);
    expect(Number(svc.rows[0].n)).toBe(0);
  });
});
