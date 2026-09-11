import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "./harness";

/**
 * RLS, evaluated by PostgreSQL.
 *
 * The previous milestone asserted policy TEXT and said so. This runs
 * them: `set role authenticated` plus `request.jwt.claims` is exactly
 * what PostgREST does for a signed-in client, so a row that comes back
 * here is a row that would come back over HTTP.
 *
 * THE THREAT MODEL
 * ----------------
 * A server action is not an authorization boundary. Any signed-in user
 * holds the anon key and can POST to /rest/v1/<table> directly, never
 * touching the action. So the question is not "does the action check
 * the permission" — it does — but "what happens when the action is
 * bypassed entirely".
 *
 * Before this hotfix the answer was: a `viewer` could insert and
 * activate a campaign, because the policies granted write to any
 * workspace member.
 */

let h: PgHarness;
let a: Tenant;
let b: Tenant;
let campaignA: string;

beforeAll(async () => {
  h = await createPgHarness();
  a = await seedTenant(h.db, "rls-a");
  b = await seedTenant(h.db, "rls-b");

  const c = await h.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, status)
     values ($1,$2,'workspace A campaign','draft') returning id`,
    [a.workspaceId, a.identityId],
  );
  campaignA = c.rows[0].id;

  await h.db.query(
    `insert into public.bluesky_follow_campaign_members
       (workspace_id, campaign_id, subject_did, import_sequence)
     values ($1,$2,'did:plc:a-member',1)`,
    [a.workspaceId, campaignA],
  );
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const count = async (table: string): Promise<number> => {
  const r = await h.db.query<{ n: number }>(
    `select count(*)::int as n from public.${table}`,
  );
  return r.rows[0].n;
};

describe("reads are workspace-scoped by the database", () => {
  it("a member of workspace A sees A's campaigns", async () => {
    const n = await h.asUser(a.ownerId, () => count("bluesky_follow_campaigns"));
    expect(n).toBe(1);
  });

  it("a member of workspace B sees NONE of A's campaigns", async () => {
    // Not "filtered by the query" — B's session literally cannot see
    // the row, so a direct PostgREST GET returns nothing.
    const n = await h.asUser(b.ownerId, () => count("bluesky_follow_campaigns"));
    expect(n).toBe(0);
  });

  it("B cannot read A's queue even knowing the campaign id", async () => {
    const r = await h.asUser(b.ownerId, () =>
      h.db.query(
        `select id from public.bluesky_follow_campaign_members
          where campaign_id = $1`,
        [campaignA],
      ),
    );
    expect(r.rows).toEqual([]);
  });

  it("an unauthenticated session sees nothing at all", async () => {
    const r = await h.asRole("anon", () =>
      h.db.query<{ n: number }>(
        `select count(*)::int as n from public.bluesky_follow_campaigns`,
      ),
    );
    expect(r.rows[0].n).toBe(0);
  });

  it("every member role can READ — visibility is not the control", async () => {
    for (const user of [a.ownerId, a.adminId, a.viewerId]) {
      const n = await h.asUser(user, () => count("bluesky_follow_campaigns"));
      expect(n).toBe(1);
    }
  });
});

describe("writes require connect_platforms, not membership", () => {
  const insertCampaign = (workspaceId: string, identityId: string, name: string) =>
    h.db.query(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name)
       values ($1,$2,$3)`,
      [workspaceId, identityId, name],
    );

  it("owner CAN create a campaign", async () => {
    await expect(
      h.asUser(a.ownerId, () => insertCampaign(a.workspaceId, a.identityId, "by owner")),
    ).resolves.toBeDefined();
  });

  it("admin CAN create a campaign", async () => {
    await expect(
      h.asUser(a.adminId, () => insertCampaign(a.workspaceId, a.identityId, "by admin")),
    ).resolves.toBeDefined();
  });

  it("VIEWER CANNOT create a campaign — this was the hole", async () => {
    // Before the hotfix the policy said `is_workspace_member`, so this
    // succeeded: a viewer could create and activate an autonomous
    // follow campaign by calling PostgREST directly.
    await expect(
      h.asUser(a.viewerId, () =>
        insertCampaign(a.workspaceId, a.identityId, "by viewer"),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("VIEWER CANNOT activate an existing campaign", async () => {
    await expect(
      h.asUser(a.viewerId, () =>
        h.db.query(
          `update public.bluesky_follow_campaigns
              set status='active' where id=$1`,
          [campaignA],
        ),
      ),
    ).resolves.toBeDefined();
    // The UPDATE affects zero rows rather than raising — RLS filters
    // the USING clause — so assert the row did not move.
    const r = await h.db.query<{ status: string }>(
      `select status from public.bluesky_follow_campaigns where id=$1`,
      [campaignA],
    );
    expect(r.rows[0].status).toBe("draft");
  });

  it("VIEWER CANNOT add members to a queue", async () => {
    await expect(
      h.asUser(a.viewerId, () =>
        h.db.query(
          `insert into public.bluesky_follow_campaign_members
             (workspace_id, campaign_id, subject_did, import_sequence)
           values ($1,$2,'did:plc:viewer-added',999)`,
          [a.workspaceId, campaignA],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("VIEWER CANNOT engage or release a kill switch", async () => {
    await expect(
      h.asUser(a.viewerId, () =>
        h.db.query(
          `insert into public.bluesky_campaign_kill_switches
             (workspace_id, operator_account_id, engaged)
           values ($1, null, false)`,
          [a.workspaceId],
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("an owner of workspace B cannot write into workspace A", async () => {
    // Being privileged somewhere is not being privileged everywhere.
    await expect(
      h.asUser(b.ownerId, () =>
        insertCampaign(a.workspaceId, a.identityId, "cross-tenant write"),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("anon cannot write anything", async () => {
    await h.db.exec("set role anon;");
    const attempt = h.db.query(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name)
       values ($1,$2,'by anon')`,
      [a.workspaceId, a.identityId],
    );
    await expect(attempt).rejects.toThrow(/row-level security/i);
    await h.db.exec("reset role;");
  });
});

describe("history and runs are not deletable through the API", () => {
  it("no DELETE policy exists on runs or identity usage", async () => {
    const r = await h.db.query<{ tablename: string; cmd: string }>(
      `select tablename, cmd from pg_policies
        where schemaname='public'
          and tablename in ('bluesky_follow_campaign_runs',
                            'bluesky_identity_daily_usage')
          and cmd = 'DELETE'`,
    );
    expect(r.rows).toEqual([]);
  });

  it("even an owner cannot delete a run", async () => {
    const c = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name)
       values ($1,$2,'has-run') returning id`,
      [a.workspaceId, a.identityId],
    );
    await h.db.query(
      `insert into public.bluesky_follow_campaign_runs
         (workspace_id, campaign_id, local_date, requested_daily_quota,
          effective_daily_quota)
       values ($1,$2,'2026-09-20',100,100)`,
      [a.workspaceId, c.rows[0].id],
    );
    await h.asUser(a.ownerId, () =>
      h.db.query(`delete from public.bluesky_follow_campaign_runs`),
    );
    const r = await h.db.query<{ n: number }>(
      `select count(*)::int n from public.bluesky_follow_campaign_runs
        where campaign_id = $1`,
      [c.rows[0].id],
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("an activated campaign cannot be deleted, only a draft", async () => {
    const c = await h.db.query<{ id: string }>(
      `insert into public.bluesky_follow_campaigns
         (workspace_id, operator_account_id, name, status)
       values ($1,$2,'activated','active') returning id`,
      [a.workspaceId, a.identityId],
    );
    await h.asUser(a.ownerId, () =>
      h.db.query(`delete from public.bluesky_follow_campaigns where id=$1`, [
        c.rows[0].id,
      ]),
    );
    const r = await h.db.query<{ n: number }>(
      `select count(*)::int n from public.bluesky_follow_campaigns where id=$1`,
      [c.rows[0].id],
    );
    // Deleting it would orphan the follows it already made from the
    // record explaining why they happened.
    expect(r.rows[0].n).toBe(1);
  });
});

describe("the permission function mirrors the TypeScript matrix", () => {
  it("owner and admin hold it; editor, reviewer and viewer do not", async () => {
    // A ladder would be wrong: a reviewer may approve content and still
    // must not act as the account in public.
    const expected: Record<string, boolean> = {
      owner: true,
      admin: true,
      editor: false,
      reviewer: false,
      viewer: false,
    };
    for (const [role, allowed] of Object.entries(expected)) {
      const u = await h.db.query<{ id: string }>(
        `insert into auth.users (email) values ($1) returning id`,
        [`matrix-${role}@example.test`],
      );
      await h.db.query(
        `insert into public.workspace_members (workspace_id, user_id, role)
         values ($1,$2,$3)`,
        [a.workspaceId, u.rows[0].id, role],
      );
      const r = await h.asUser(u.rows[0].id, () =>
        h.db.query<{ ok: boolean }>(
          `select public.can_manage_bluesky_campaigns($1) as ok`,
          [a.workspaceId],
        ),
      );
      expect(r.rows[0].ok, role).toBe(allowed);
    }
  });
});
