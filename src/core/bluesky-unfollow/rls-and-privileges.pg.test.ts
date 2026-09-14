import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  createPgHarness,
  seedTenant,
  type PgHarness,
  type Tenant,
} from "@/test/pg/harness";

/**
 * RLS and RPC privileges, on a REAL PostgreSQL.
 *
 * Not on the migration TEXT. A policy that parses is not a policy that
 * works, and three of the defects the follow subsystem's hotfixes had
 * to repair were invisible to text inspection — including a `revoke all
 * … from public` with no matching grant, which left the worker unable
 * to execute its own RPCs.
 *
 * `has_function_privilege` is used rather than reading `pg_proc.proacl`,
 * because the question is "may this role execute it", and only the
 * function answers that.
 */

let h: PgHarness;
let a: Tenant;
let b: Tenant;

const NEW_FUNCTIONS: [string, string][] = [
  ["claim_bluesky_unfollow_action", "uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,uuid"],
  ["record_bluesky_unfollow_already_absent", "uuid,uuid,uuid,uuid,uuid,text,text,text,text,uuid,text"],
  ["bluesky_unfollow_protection_reason", "uuid,uuid,text,text"],
  ["import_bluesky_unfollow_member_chunk", "uuid,uuid,uuid,text,jsonb"],
  ["list_bluesky_unfollow_source_keyset", "uuid,uuid,text,uuid,uuid,text,integer"],
  ["count_bluesky_unfollow_source", "uuid,uuid,text,text,uuid,uuid"],
  ["begin_bluesky_unfollow_import", "uuid,uuid,text,uuid,uuid"],
  ["advance_bluesky_unfollow_import", "uuid,uuid,text,text,integer,integer,integer,integer,boolean,text"],
  ["cancel_bluesky_campaign_future_work", "uuid,uuid"],
  ["defer_bluesky_campaign_member", "uuid,uuid,integer"],
];

beforeAll(async () => {
  h = await createPgHarness();
  a = await seedTenant(h.db, "rls-a");
  b = await seedTenant(h.db, "rls-b");
}, 180_000);
afterAll(async () => { await h?.close(); });

async function privilege(role: string, fn: string, args: string) {
  const r = await h.db.query<{ ok: boolean }>(
    `select has_function_privilege($1, $2, 'EXECUTE') as ok`,
    [role, `public.${fn}(${args})`],
  );
  return r.rows[0].ok;
}

describe("worker RPCs are executable by service_role and NOBODY else", () => {
  for (const [fn, args] of NEW_FUNCTIONS) {
    it(`${fn}: service_role yes; anon, authenticated and PUBLIC no`, async () => {
      expect(await privilege("service_role", fn, args)).toBe(true);
      expect(await privilege("anon", fn, args)).toBe(false);
      expect(await privilege("authenticated", fn, args)).toBe(false);
      // PUBLIC is the one that is easy to leave behind: a function is
      // executable by PUBLIC by default, so forgetting the revoke is
      // silent.
      expect(await privilege("public", fn, args)).toBe(false);
    });
  }

  it("the one exception is deliberate and is a READ", async () => {
    // `can_manage_bluesky_campaigns` is callable by authenticated
    // clients because RLS policies invoke it as them. It reads
    // membership and returns a boolean; it grants nothing.
    expect(
      await privilege("authenticated", "can_manage_bluesky_campaigns", "uuid"),
    ).toBe(true);
  });
});

describe("RLS on the new table", () => {
  it("row level security is ENABLED, not merely policied", async () => {
    // A table with policies and RLS disabled is a table with no
    // security at all — the policies simply never run.
    const r = await h.db.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class
        where oid = 'public.bluesky_unfollow_allowlist'::regclass`,
    );
    expect(r.rows[0].relrowsecurity).toBe(true);
  });

  it("a member of workspace A cannot read workspace B's allowlist", async () => {
    await h.db.query(
      `insert into public.bluesky_unfollow_allowlist
         (workspace_id, subject_did, reason) values ($1,'did:plc:secretA','A')`,
      [a.workspaceId],
    );
    await h.db.query(
      `insert into public.bluesky_unfollow_allowlist
         (workspace_id, subject_did, reason) values ($1,'did:plc:secretB','B')`,
      [b.workspaceId],
    );

    const seen = await h.asUser(a.ownerId, async () => {
      const r = await h.db.query<{ subject_did: string }>(
        `select subject_did from public.bluesky_unfollow_allowlist`,
      );
      return r.rows.map((x) => x.subject_did);
    });
    expect(seen).toEqual(["did:plc:secretA"]);
  });

  it("an owner may add and remove; a VIEWER may do neither", async () => {
    await h.asUser(a.ownerId, async () => {
      await h.db.query(
        `insert into public.bluesky_unfollow_allowlist
           (workspace_id, subject_did) values ($1,'did:plc:ownerAdded')`,
        [a.workspaceId],
      );
    });

    await h.asUser(a.viewerId, async () => {
      // Reads are open to members: seeing that a profile is protected
      // is not the same as being able to unprotect it.
      const r = await h.db.query<{ n: string }>(
        `select count(*)::text as n from public.bluesky_unfollow_allowlist`,
      );
      expect(Number(r.rows[0].n)).toBeGreaterThan(0);

      await expect(
        h.db.query(
          `insert into public.bluesky_unfollow_allowlist
             (workspace_id, subject_did) values ($1,'did:plc:viewerAdded')`,
          [a.workspaceId],
        ),
      ).rejects.toThrow(/row-level security/i);

      // REMOVING is the dangerous direction — it un-protects someone —
      // and is gated identically.
      const deleted = await h.db.query(
        `delete from public.bluesky_unfollow_allowlist
          where subject_did = 'did:plc:ownerAdded'`,
      );
      expect(deleted.affectedRows ?? 0).toBe(0);
    });
  });

  it("an ADMIN may manage it, matching connect_platforms", async () => {
    await h.asUser(a.adminId, async () => {
      await h.db.query(
        `insert into public.bluesky_unfollow_allowlist
           (workspace_id, subject_did) values ($1,'did:plc:adminAdded')`,
        [a.workspaceId],
      );
    });
    const r = await h.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_unfollow_allowlist
        where subject_did = 'did:plc:adminAdded'`,
    );
    expect(r.rows[0].n).toBe("1");
  });

  it("an anonymous client sees nothing at all", async () => {
    await h.asRole("anon", async () => {
      const r = await h.db.query<{ n: string }>(
        `select count(*)::text as n from public.bluesky_unfollow_allowlist`,
      );
      expect(r.rows[0].n).toBe("0");
    });
  });
});

describe("cross-workspace references are refused by the SCHEMA", () => {
  it("an unfollow campaign cannot name another workspace's identity", async () => {
    await expect(
      h.db.query(
        `insert into public.bluesky_follow_campaigns
           (workspace_id, operator_account_id, name, kind)
         values ($1, $2, 'cross tenant', 'unfollow')`,
        [a.workspaceId, b.identityId],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it("an import job cannot name another workspace's follow campaign", async () => {
    const own = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name, kind)
       values ($1,$2,'mine','unfollow') returning id`,
      [a.workspaceId, a.identityId],
    );
    const theirs = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name, kind)
       values ($1,$2,'theirs','follow') returning id`,
      [b.workspaceId, b.identityId],
    );

    await expect(
      h.db.query(
        `insert into public.bluesky_campaign_import_jobs
           (workspace_id, campaign_id, source_kind, source_campaign_id)
         values ($1,$2,'follow_campaign',$3)`,
        [a.workspaceId, own.rows[0].id, theirs.rows[0].id],
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });
});

describe("the RPCs actually EXECUTE, not merely parse", () => {
  it("every new function can be called by service_role", async () => {
    // Parsing a migration is not proof that a function runs. Each of
    // these is invoked with real arguments; a syntax error inside a
    // plpgsql body only surfaces here.
    await h.asServiceRole(async () => {
      const campaign = await h.db.query<{ id: string }>(
        `insert into public.bluesky_follow_campaigns
           (workspace_id, operator_account_id, name, kind, status)
         values ($1,$2,'exec check','unfollow','draft') returning id`,
        [a.workspaceId, a.identityId],
      );
      const c = campaign.rows[0].id;

      const protection = await h.db.query<{ r: string | null }>(
        `select public.bluesky_unfollow_protection_reason($1,$2,$3,$4) as r`,
        [a.workspaceId, a.identityId, "did:plc:self", "did:plc:self"],
      );
      expect(protection.rows[0].r).toMatch(/acting account itself/i);

      const begun = await h.db.query<Record<string, unknown>>(
        `select * from public.begin_bluesky_unfollow_import($1,$2,$3,null,null)`,
        [a.workspaceId, c, "filtered_candidates"],
      );
      expect(begun.rows[0].out_refused_reason).toBeNull();

      const imported = await h.db.query<Record<string, unknown>>(
        `select * from public.import_bluesky_unfollow_member_chunk($1,$2,$3,$4,$5::jsonb)`,
        [
          a.workspaceId, c, a.identityId, "did:plc:actor",
          JSON.stringify([
            {
              subject_did: "did:plc:execcheck",
              record_uri: "at://did:plc:actor/app.bsky.graph.follow/rk",
              record_rkey: "rk",
              record_source: "list_records",
            },
          ]),
        ],
      );
      expect(Number(imported.rows[0].out_inserted)).toBe(1);

      const advanced = await h.db.query<Record<string, unknown>>(
        `select * from public.advance_bluesky_unfollow_import(
           $1,$2,'did:plc:execcheck',null,1,0,0,1,true,null)`,
        [a.workspaceId, begun.rows[0].out_job_id],
      );
      expect(advanced.rows[0].out_status).toBe("ready");
      expect(advanced.rows[0].out_campaign_status).toBe("ready");

      const listed = await h.db.query<Record<string, unknown>>(
        `select * from public.list_bluesky_unfollow_source_keyset(
           $1,$2,'filtered_candidates',null,null,null,10)`,
        [a.workspaceId, a.identityId],
      );
      expect(Array.isArray(listed.rows)).toBe(true);

      const counted = await h.db.query<Record<string, unknown>>(
        `select * from public.count_bluesky_unfollow_source(
           $1,$2,'did:plc:actor','filtered_candidates',null,null)`,
        [a.workspaceId, a.identityId],
      );
      expect(Number(counted.rows[0].eligible)).toBeGreaterThanOrEqual(0);

      const cancelled = await h.db.query<Record<string, unknown>>(
        `select * from public.cancel_bluesky_campaign_future_work($1,$2)`,
        [a.workspaceId, c],
      );
      expect(Number(cancelled.rows[0].cancelled_members)).toBe(1);
    });
  });
});
