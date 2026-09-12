import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPgServerHarness,
  seedServerTenant,
  type PgServerHarness,
  type ServerTenant,
} from "./server-harness";
import { DAILY_QUOTA_OPTIONS } from "@/core/bluesky-campaigns/quota";

/**
 * The quota set and the durable import, against a real server.
 *
 * The quota CHECK is a database constraint, so a UI that offers 300 and
 * a schema that rejects it is a runtime failure no amount of TypeScript
 * catches. And a keyset walk is only correct if the index and the
 * ORDER BY agree — which is a question for PostgreSQL, not a fake.
 *
 * No provider call is made anywhere in this file.
 */

let h: PgServerHarness;
let t: ServerTenant;
let identityId: string;
const TODAY = "2026-09-12";

beforeAll(async () => {
  h = await createPgServerHarness();
  t = await seedServerTenant(h.admin, "setup");
  identityId = t.identityId;
}, 300_000);

afterAll(async () => {
  await h?.close();
});

const newCampaign = (quota: number, name = `c-${Math.random()}`) =>
  h.admin.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, status, requested_daily_quota)
     values ($1,$2,$3,'draft',$4) returning id`,
    [t.workspaceId, identityId, name, quota],
  );

describe("the daily quota set, in the schema", () => {
  it("accepts every 100 from 100 to 1,000", async () => {
    for (const quota of [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]) {
      const r = await newCampaign(quota);
      expect(r.rows[0].id, `quota ${quota}`).toBeTruthy();
    }
  }, 120_000);

  it("accepts 300 — the value the old set skipped", async () => {
    const r = await newCampaign(300, "three-hundred");
    const back = await h.admin.query<{ requested_daily_quota: number }>(
      `select requested_daily_quota from public.bluesky_follow_campaigns
        where id=$1`,
      [r.rows[0].id],
    );
    expect(Number(back.rows[0].requested_daily_quota)).toBe(300);
  }, 60_000);

  it("rejects anything off the set, including inside the range", async () => {
    for (const quota of [0, 50, 99, 150, 250, 1001, 1100, 5000, -100]) {
      await expect(newCampaign(quota), `quota ${quota}`).rejects.toThrow(
        /check constraint/i,
      );
    }
  }, 120_000);

  it("the schema and the UI offer the SAME set", async () => {
    // The two could drift silently: a widened constant with an
    // unapplied migration offers an option every save rejects.
    const rows = await h.admin.query<{ def: string }>(
      `select pg_get_constraintdef(oid) def
         from pg_constraint
        where conrelid = 'public.bluesky_follow_campaigns'::regclass
          and contype = 'c'
          and pg_get_constraintdef(oid) ilike '%requested_daily_quota%'`,
    );
    expect(rows.rows).toHaveLength(1);
    const inSchema = (rows.rows[0].def.match(/\d+/g) ?? []).map(Number).sort(
      (a, b) => a - b,
    );
    expect(inSchema).toEqual([...DAILY_QUOTA_OPTIONS].sort((a, b) => a - b));
  }, 60_000);

  it("does not raise the ceiling above 1,000", async () => {
    await expect(newCampaign(2000)).rejects.toThrow(/check constraint/i);
  }, 60_000);
});

describe("the keyset candidate walk", () => {
  async function seedCandidates(count: number, targetId?: string) {
    const acct = await h.admin.query<{ id: string }>(
      `insert into public.growth_accounts
         (workspace_id, platform, handle, display_name, status)
       values ($1,'bluesky',$2,$2,'active') returning id`,
      [t.workspaceId, `walk-${Math.random().toString(36).slice(2, 9)}.test`],
    );
    const scopedIdentity = acct.rows[0].id;

    // Seven consecutive rows share a timestamp, so the order is total
    // only because the DID breaks the tie.
    const values: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const bucket = Math.floor(i / 7);
      values.push(
        `('${t.workspaceId}','${scopedIdentity}','did:plc:${String(i).padStart(7, "0")}','not_following', now() - (${bucket} * interval '1 second'))`,
      );
    }
    await h.admin.query(
      `insert into public.bluesky_candidates
         (workspace_id, operator_account_id, subject_did, relationship_state,
          last_discovered_at)
       values ${values.join(",")}`,
    );

    if (targetId) {
      await h.admin.query(
        `insert into public.bluesky_candidate_sources
           (workspace_id, candidate_id, target_profile_id)
         select $1, c.id, $2 from public.bluesky_candidates c
          where c.operator_account_id = $3`,
        [t.workspaceId, targetId, scopedIdentity],
      );
    }
    return scopedIdentity;
  }

  it("visits every row exactly once across many windows", async () => {
    const scoped = await seedCandidates(5_000);
    const seen = new Set<string>();
    let afterAt: string | null = null;
    let afterDid: string | null = null;

    for (let window = 0; window < 200; window += 1) {
      const page: { rows: { subject_did: string; last_discovered_at: string }[] } =
        await h.admin.query<{
          subject_did: string;
          last_discovered_at: string;
        }>(
        `select * from public.list_bluesky_candidates_keyset(
           $1,$2,$3,$4,$5,$6,$7)`,
        [
          t.workspaceId, scoped, ["not_following"], null, afterAt, afterDid, 100,
        ],
      );
      if (page.rows.length === 0) break;
      for (const row of page.rows) {
        // Never twice. An OFFSET walk over a table being written to
        // fails exactly here.
        expect(seen.has(row.subject_did)).toBe(false);
        seen.add(row.subject_did);
      }
      const last = page.rows[page.rows.length - 1];
      afterAt = last.last_discovered_at;
      afterDid = last.subject_did;
    }

    expect(seen.size).toBe(5_000);
  }, 180_000);

  it("scopes to one imported list and does not mix in another", async () => {
    const targetA = await h.admin.query<{ id: string }>(
      `insert into public.bluesky_target_profiles
         (workspace_id, operator_account_id, subject_did, handle,
          requested_identifier)
       values ($1,$2,$3,$4,$4) returning id`,
      [t.workspaceId, identityId, `did:plc:targetA${Date.now()}`, "a.test"],
    );
    const aId = targetA.rows[0].id;
    const scopedA = await seedCandidates(300, aId);
    await seedCandidates(400);

    const counts = await h.admin.query<{
      eligible: number;
      protected_excluded: number;
    }>(
      `select * from public.count_bluesky_candidates_eligible($1,$2,$3,$4)`,
      [t.workspaceId, scopedA, ["not_following"], aId],
    );
    // Only list A. Not 700, and not 400.
    expect(Number(counts.rows[0].eligible)).toBe(300);
  }, 180_000);
});

describe("import job checkpoints", () => {
  it("resumes rather than restarting, and never rewinds", async () => {
    const c = await newCampaign(300, "job-test");
    const campaignId = c.rows[0].id;

    const begin = await h.admin.query<{ out_job_id: string }>(
      `select * from public.begin_bluesky_campaign_import($1,$2,$3,$4)`,
      [t.workspaceId, campaignId, "candidates", null],
    );
    const jobId = begin.rows[0].out_job_id;

    const advance = (at: string, did: string) =>
      h.admin.query<{ out_cursor_at: string; out_cursor_did: string }>(
        `select * from public.advance_bluesky_campaign_import(
           $1,$2,$3,$4,null,10,0,0,1,false,null)`,
        [t.workspaceId, jobId, at, did],
      );

    await advance("2026-09-01T00:00:10Z", "did:plc:b");
    // Further along the scan: an OLDER timestamp.
    const forward = await advance("2026-09-01T00:00:05Z", "did:plc:a");
    expect(forward.rows[0].out_cursor_did).toBe("did:plc:a");

    // A slower caller trying to rewind is ignored — this is what makes
    // two concurrent imports safe rather than merely lucky.
    const rewind = await advance("2026-09-01T00:00:20Z", "did:plc:z");
    expect(rewind.rows[0].out_cursor_did).toBe("did:plc:a");
    expect(Date.parse(rewind.rows[0].out_cursor_at)).toBe(
      Date.parse("2026-09-01T00:00:05Z"),
    );
  }, 120_000);

  it("refuses to rebuild a queue from a different list", async () => {
    const c = await newCampaign(300, "mix-test");
    const campaignId = c.rows[0].id;
    await h.admin.query(
      `select * from public.begin_bluesky_campaign_import($1,$2,$3,$4)`,
      [t.workspaceId, campaignId, "candidates", null],
    );
    const mixed = await h.admin.query<{ out_refused_reason: string | null }>(
      `select * from public.begin_bluesky_campaign_import($1,$2,$3,$4)`,
      [t.workspaceId, campaignId, "target_followers", null],
    );
    expect(mixed.rows[0].out_refused_reason).toBe("source_mismatch");
  }, 120_000);

  it("only service_role may execute the new functions", async () => {
    for (const fn of [
      "list_bluesky_candidates_keyset",
      "count_bluesky_candidates_eligible",
      "begin_bluesky_campaign_import",
      "advance_bluesky_campaign_import",
    ]) {
      const r = await h.admin.query<{
        svc: boolean;
        anon: boolean;
        auth: boolean;
      }>(
        `select
           has_function_privilege('service_role', p.oid, 'EXECUTE') svc,
           has_function_privilege('anon', p.oid, 'EXECUTE') anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname=$1`,
        [fn],
      );
      expect(r.rows.length, fn).toBeGreaterThan(0);
      expect(r.rows[0].svc, `${fn} service_role`).toBe(true);
      expect(r.rows[0].anon, `${fn} anon`).toBe(false);
      expect(r.rows[0].auth, `${fn} authenticated`).toBe(false);
    }
  }, 120_000);

  it("the import-job table is workspace-scoped and not writable by users", async () => {
    const policies = await h.admin.query<{ cmd: string }>(
      `select cmd from pg_policies
        where tablename='bluesky_campaign_import_jobs'`,
    );
    // Read-only for members; the worker is service_role and bypasses RLS.
    expect(policies.rows.map((p) => p.cmd)).toEqual(["SELECT"]);

    const rls = await h.admin.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class
        where oid='public.bluesky_campaign_import_jobs'::regclass`,
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
  }, 60_000);

  it("replays cleanly", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const sql = readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260912000001_campaign_setup_and_scale_import.sql",
      ),
      "utf8",
    );
    await expect(h.admin.query(sql)).resolves.toBeDefined();

    // And it really is a replay, not a no-op against missing objects.
    const t2 = await h.admin.query<{ n: string }>(
      `select count(*) n from pg_tables
        where tablename='bluesky_campaign_import_jobs'`,
    );
    expect(Number(t2.rows[0].n)).toBe(1);
    expect(TODAY).toBeTruthy();
  }, 120_000);
});
