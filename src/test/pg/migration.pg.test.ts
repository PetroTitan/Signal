import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "./harness";

/**
 * The migrations, executed against a REAL PostgreSQL server.
 *
 * Everything here would have been green under text inspection and red
 * against a server — which is the whole reason this file exists.
 */

let h: PgHarness;
let a: Tenant;

beforeAll(async () => {
  h = await createPgHarness();
  a = await seedTenant(h.db, "a");
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe("the migration chain applies for real", () => {
  it("is PostgreSQL, not an emulation", async () => {
    const r = await h.db.query<{ version: string }>("select version()");
    expect(r.rows[0].version).toContain("PostgreSQL");
  });

  it("creates every campaign table", async () => {
    const r = await h.db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema='public' and table_name like 'bluesky_%'
        order by table_name`,
    );
    const names = r.rows.map((x) => x.table_name);
    for (const t of [
      "bluesky_follow_campaigns",
      "bluesky_follow_campaign_members",
      "bluesky_follow_campaign_runs",
      "bluesky_campaign_member_sources",
      "bluesky_identity_daily_usage",
      "bluesky_campaign_kill_switches",
      "bluesky_relationship_actions",
    ]) {
      expect(names, t).toContain(t);
    }
  });

  it("creates every worker RPC", async () => {
    const r = await h.db.query<{ proname: string }>(
      `select proname from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and proname like '%bluesky%'
        order by proname`,
    );
    const names = r.rows.map((x) => x.proname);
    for (const fn of [
      "claim_bluesky_campaign_members",
      "release_bluesky_campaign_members",
      "ensure_bluesky_campaign_run",
      "record_bluesky_identity_usage",
      "reserve_bluesky_campaign_quota",
      "sweep_bluesky_quota_reservations",
      "acquire_bluesky_run_dispatch_lease",
      "release_bluesky_run_dispatch_lease",
      "apply_bluesky_run_outcome",
      "claim_bluesky_campaign_action",
      "resume_bluesky_campaign_run",
    ]) {
      expect(names, fn).toContain(fn);
    }
  });

  it("is idempotent — applying the hotfix twice changes nothing", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const sql = readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260911000003_campaign_concurrency_hotfix.sql",
      ),
      "utf8",
    );
    await expect(h.db.exec(sql)).resolves.toBeDefined();
  }, 60_000);
});

describe("RPC EXECUTE — the defect that made the feature inert", () => {
  const WORKER_RPCS = [
    "claim_bluesky_campaign_members",
    "release_bluesky_campaign_members",
    "ensure_bluesky_campaign_run",
    "record_bluesky_identity_usage",
    "reserve_bluesky_campaign_quota",
    "sweep_bluesky_quota_reservations",
    "acquire_bluesky_run_dispatch_lease",
    "release_bluesky_run_dispatch_lease",
    "apply_bluesky_run_outcome",
    "claim_bluesky_campaign_action",
    "resume_bluesky_campaign_run",
  ];

  it("service_role can EXECUTE every worker RPC", async () => {
    // Before the hotfix every one of these was false, so the deployed
    // worker could not claim a single member.
    for (const fn of WORKER_RPCS) {
      const r = await h.db.query<{ ok: boolean }>(
        `select has_function_privilege('service_role', p.oid, 'EXECUTE') as ok
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and p.proname = $1`,
        [fn],
      );
      expect(r.rows.length, `${fn} not found`).toBeGreaterThan(0);
      for (const row of r.rows) expect(row.ok, `${fn}`).toBe(true);
    }
  });

  it("anon and authenticated CANNOT execute them", async () => {
    // They take a workspace id as an argument and are SECURITY DEFINER,
    // so a client able to call them directly could act across
    // workspaces.
    for (const role of ["anon", "authenticated"]) {
      for (const fn of WORKER_RPCS) {
        const r = await h.db.query<{ ok: boolean }>(
          `select has_function_privilege($1, p.oid, 'EXECUTE') as ok
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname='public' and p.proname = $2`,
          [role, fn],
        );
        for (const row of r.rows) expect(row.ok, `${role}/${fn}`).toBe(false);
      }
    }
  });

  it("every SECURITY DEFINER function pins search_path", async () => {
    const r = await h.db.query<{ proname: string; cfg: string[] | null }>(
      `select proname, proconfig as cfg from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.prosecdef and proname like '%bluesky%'`,
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.cfg, row.proname).toBeTruthy();
      expect(row.cfg!.join(","), row.proname).toContain("search_path=public");
    }
  });

  it("the worker can actually CALL a RPC as service_role", async () => {
    // has_function_privilege is a claim; this is the execution. Before
    // the hotfix this raised "permission denied for function".
    const c = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name)
       values ($1,$2,'rpc-exec') returning id`,
      [a.workspaceId, a.identityId],
    );
    await h.asServiceRole(async () => {
      const r = await h.db.query<{ id: string; effective_daily_quota: number }>(
        `select * from public.ensure_bluesky_campaign_run($1,$2,$3,$4,$5,$6)`,
        [a.workspaceId, c.rows[0].id, "2026-09-11", 100, 100, null],
      );
      expect(r.rows[0].id).toBeTruthy();
      expect(r.rows[0].effective_daily_quota).toBe(100);
    });
  });
});

describe("tenant integrity is enforced by the schema", () => {
  it("a campaign cannot name an identity from another workspace", async () => {
    const b = await seedTenant(h.db, "b");
    await expect(
      h.db.query(
        `insert into public.bluesky_follow_campaigns
           (workspace_id, operator_account_id, name)
         values ($1, $2, 'cross-tenant')`,
        [a.workspaceId, b.identityId],
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it("a member cannot name a campaign from another workspace", async () => {
    const b = await seedTenant(h.db, "c");
    const c = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name)
       values ($1,$2,'mine') returning id`,
      [a.workspaceId, a.identityId],
    );
    // Same campaign id, WRONG workspace id — the composite FK is what
    // rejects this. UUID secrecy and application filtering would not.
    await expect(
      h.db.query(
        `insert into public.bluesky_follow_campaign_members
           (workspace_id, campaign_id, subject_did, import_sequence)
         values ($1,$2,'did:plc:x',1)`,
        [b.workspaceId, c.rows[0].id],
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it("a run cannot belong to a campaign from another workspace", async () => {
    const b = await seedTenant(h.db, "d");
    const c = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name)
       values ($1,$2,'mine2') returning id`,
      [a.workspaceId, a.identityId],
    );
    await expect(
      h.db.query(
        `insert into public.bluesky_follow_campaign_runs
           (workspace_id, campaign_id, local_date, requested_daily_quota,
            effective_daily_quota)
         values ($1,$2,'2026-09-11',100,100)`,
        [b.workspaceId, c.rows[0].id],
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it("the effective quota CHECK really rejects an over-wide run", async () => {
    const c = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name)
       values ($1,$2,'quota-check') returning id`,
      [a.workspaceId, a.identityId],
    );
    await expect(
      h.db.query(
        `insert into public.bluesky_follow_campaign_runs
           (workspace_id, campaign_id, local_date, requested_daily_quota,
            effective_daily_quota)
         values ($1,$2,'2026-09-12',100,500)`,
        [a.workspaceId, c.rows[0].id],
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("the one-run-per-local-day unique index really rejects a duplicate", async () => {
    const c = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name)
       values ($1,$2,'dup-run') returning id`,
      [a.workspaceId, a.identityId],
    );
    const insert = () =>
      h.db.query(
        `insert into public.bluesky_follow_campaign_runs
           (workspace_id, campaign_id, local_date, requested_daily_quota,
            effective_daily_quota)
         values ($1,$2,'2026-09-13',100,100)`,
        [a.workspaceId, c.rows[0].id],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key value/i);
  });
});

describe("kill switches — the write that used to error", () => {
  it("ON CONFLICT works for the workspace-global switch", async () => {
    // Before the hotfix this raised "there is no unique or exclusion
    // constraint matching the ON CONFLICT specification", because the
    // target was a PARTIAL unique index. The switch could not be
    // engaged at all.
    const upsert = (engaged: boolean, reason: string) =>
      h.db.query(
        `insert into public.bluesky_campaign_kill_switches
           (workspace_id, operator_account_id, engaged, reason)
         values ($1, null, $2, $3)
         on conflict (workspace_id, identity_key)
         do update set engaged = excluded.engaged, reason = excluded.reason`,
        [a.workspaceId, engaged, reason],
      );

    await upsert(true, "incident");
    await upsert(true, "still an incident");   // update
    await upsert(false, "released");            // release

    const r = await h.db.query<{ engaged: boolean; reason: string; n: string }>(
      `select engaged, reason, count(*) over () as n
         from public.bluesky_campaign_kill_switches
        where workspace_id = $1 and operator_account_id is null`,
      [a.workspaceId],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].engaged).toBe(false);
    expect(r.rows[0].reason).toBe("released");
  });

  it("a per-identity switch coexists with the global one", async () => {
    await h.db.query(
      `insert into public.bluesky_campaign_kill_switches
         (workspace_id, operator_account_id, engaged, reason)
       values ($1,$2,true,'this identity')
       on conflict (workspace_id, identity_key)
       do update set engaged = excluded.engaged`,
      [a.workspaceId, a.identityId],
    );
    const r = await h.db.query<{ n: number }>(
      `select count(*)::int as n from public.bluesky_campaign_kill_switches
        where workspace_id = $1`,
      [a.workspaceId],
    );
    // One global + one identity.
    expect(r.rows[0].n).toBe(2);
  });

  it("a second global switch for one workspace is rejected", async () => {
    await expect(
      h.db.query(
        `insert into public.bluesky_campaign_kill_switches
           (workspace_id, operator_account_id, engaged)
         values ($1, null, true)`,
        [a.workspaceId],
      ),
    ).rejects.toThrow(/duplicate key value/i);
  });
});
