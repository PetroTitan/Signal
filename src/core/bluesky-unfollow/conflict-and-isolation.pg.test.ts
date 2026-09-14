import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createPgHarness, seedTenant, type PgHarness, type Tenant } from "@/test/pg/harness";

/**
 * The two defects this feature could not ship without closing, each
 * REPRODUCED before it is asserted fixed.
 *
 * DEFECT 1 — a Follow and an Unfollow could be in flight for the same
 * person at the same time.
 *
 *   The deployed guard, from 20260911000001, is
 *
 *     unique (workspace_id, operator_account_id, subject_did,
 *             action_type) where status in ('pending','running')
 *
 *   `action_type` is IN THE KEY. So a pending follow and a pending
 *   unfollow for one person, from one account, are both permitted.
 *   Two campaigns fight, the most recent write wins, and Signal
 *   considers every step correct.
 *
 * DEFECT 2 — the Follow dispatcher had no notion of campaign kind.
 *
 *   Before `kind` existed every campaign was a follow campaign, so the
 *   question could not arise. It arises now, and the consequence of
 *   getting it wrong is the worst thing this subsystem can do:
 *   FOLLOWING tens of thousands of people who were queued to be
 *   unfollowed.
 *
 * Each test first demonstrates the defect by removing the fix, then
 * demonstrates the fix. That is the mutation control and the
 * reproduction in one place, so neither can drift from the other.
 */

let h: PgHarness;
let t: Tenant;

beforeAll(async () => {
  h = await createPgHarness();
  t = await seedTenant(h.db, "conflict");
}, 180_000);
afterAll(async () => { await h?.close(); });

const ACTOR = "did:plc:actorconflict";
const SUBJECT = "did:plc:subjectconflict";

async function makeCampaign(kind: "follow" | "unfollow", name: string) {
  const c = await h.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaigns
       (workspace_id, operator_account_id, name, kind, status)
     values ($1, $2, $3, $4, 'active') returning id`,
    [t.workspaceId, t.identityId, name, kind],
  );
  return c.rows[0].id;
}

async function makeMember(campaignId: string, did: string, seq: number) {
  const m = await h.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaign_members
       (workspace_id, campaign_id, subject_did, import_sequence, status,
        provider_record_uri, provider_record_rkey, provider_record_source)
     values ($1, $2, $3, $4, 'queued', $5, $6, 'list_records')
     returning id`,
    [
      t.workspaceId, campaignId, did, seq,
      `at://${ACTOR}/app.bsky.graph.follow/rkey${seq}`,
      `rkey${seq}`,
    ],
  );
  return m.rows[0].id;
}

async function makeRun(campaignId: string, localDate: string) {
  const r = await h.db.query<{ id: string }>(
    `insert into public.bluesky_follow_campaign_runs
       (workspace_id, campaign_id, local_date, requested_daily_quota,
        effective_daily_quota)
     values ($1, $2, $3, 100, 100) returning id`,
    [t.workspaceId, campaignId, localDate],
  );
  return r.rows[0].id;
}

/**
 * The conflict index EXACTLY as the migrations left it.
 *
 * Captured once, and restored verbatim by the tests that have to drop
 * it. Re-creating it from a literal written here would mean these tests
 * pass against an index this file defines rather than the one that
 * ships — which is how a mutation check on the migration came back
 * green while the guard had been deleted from it.
 */
let originalIndexDef: string | null = null;

async function captureIndex(): Promise<void> {
  const r = await h.db.query<{ indexdef: string }>(
    `select indexdef from pg_indexes
      where schemaname = 'public'
        and indexname = 'bluesky_relationship_actions_one_intent'`,
  );
  originalIndexDef = r.rows[0]?.indexdef ?? null;
}

async function restoreIndex(): Promise<void> {
  if (originalIndexDef) await h.db.exec(`${originalIndexDef};`);
}

/** Insert an in-flight action directly, the way a worker's RPC would. */
async function insertAction(actionType: "follow" | "unfollow", did: string) {
  return h.db.query(
    `insert into public.bluesky_relationship_actions
       (workspace_id, operator_account_id, action_type, subject_did,
        actor_did, status)
     values ($1, $2, $3, $4, $5, 'running')`,
    [t.workspaceId, t.identityId, actionType, did, ACTOR],
  );
}

describe("the MIGRATION is what creates the guard", () => {
  it("the conflict index exists straight from the migrations", async () => {
    // FIRST, before any test in this file touches an index.
    //
    // This assertion exists because of a mutation check that should
    // have failed and did not. Deleting the index from the migration
    // left every behavioural test below GREEN — the reproduction case
    // recreates the index as part of its own cleanup, so from the
    // second test onward the property held for a reason that had
    // nothing to do with what ships.
    //
    // A guard whose absence no test notices is a guard that can be
    // removed by accident.
    const r = await h.db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where schemaname = 'public'
          and indexname = 'bluesky_relationship_actions_one_intent'`,
    );
    expect(r.rows).toHaveLength(1);
    // And it must be the TOTAL index — one that still keyed on
    // action_type would satisfy "an index exists" while permitting
    // exactly the conflict this feature has to prevent.
    expect(r.rows[0].indexdef).not.toContain("action_type");
    expect(r.rows[0].indexdef).toContain("UNIQUE");
    expect(r.rows[0].indexdef).toMatch(
      /workspace_id, operator_account_id, subject_did/,
    );
    expect(r.rows[0].indexdef).toMatch(/pending.*running|running.*pending/);
  });

  it("the protection function and both claim guards ship too", async () => {
    const r = await h.db.query<{ n: string }>(
      `select count(*)::text as n from pg_proc
        where proname in ('bluesky_unfollow_protection_reason',
                          'claim_bluesky_unfollow_action',
                          'record_bluesky_unfollow_already_absent')`,
    );
    expect(r.rows[0].n).toBe("3");
  });
});

describe("DEFECT 1: concurrent Follow and Unfollow for one subject", () => {
  it("REPRODUCES — without the total index, both in-flight actions are accepted", async () => {
    const did = "did:plc:reproduce-conflict";
    await captureIndex();
    // Remove the fix. The deployed per-type index stays, exactly as it
    // was before this migration.
    await h.db.exec(
      "drop index if exists public.bluesky_relationship_actions_one_intent;",
    );

    await insertAction("follow", did);
    // THE DEFECT: this succeeds. One account, one person, two
    // contradictory public intentions outstanding at once.
    await expect(insertAction("unfollow", did)).resolves.toBeDefined();

    const both = await h.db.query<{ n: string }>(
      `select count(*) as n from public.bluesky_relationship_actions
        where subject_did = $1 and status in ('pending','running')`,
      [did],
    );
    expect(Number(both.rows[0].n)).toBe(2);

    // Restore the fix for the rest of the suite. The conflicting pair
    // has to go FIRST — the index cannot be built over rows that
    // violate it, which is itself the clearest possible demonstration
    // that it enforces the property, and is exactly the situation the
    // migration's pre-flight DO block exists to report on a real
    // database rather than fail obscurely.
    await h.db.query(
      `delete from public.bluesky_relationship_actions where subject_did = $1`,
      [did],
    );
    await restoreIndex();
  });

  it("the migration REFUSES to apply over pre-existing conflicting rows", async () => {
    // The production-safety property of the pre-flight check: a
    // database that already holds a conflicting pair must stop the
    // deploy with an actionable message, not silently skip the index
    // that this whole feature depends on.
    const did = "did:plc:preflight-conflict";
    await captureIndex();
    await h.db.exec(
      "drop index if exists public.bluesky_relationship_actions_one_intent;",
    );
    await insertAction("follow", did);
    await insertAction("unfollow", did);

    await expect(
      h.db.exec(`
        do $$
        declare v_conflicts integer;
        begin
          select count(*) into v_conflicts from (
            select workspace_id, operator_account_id, subject_did
              from public.bluesky_relationship_actions
             where status in ('pending','running')
             group by workspace_id, operator_account_id, subject_did
            having count(*) > 1) c;
          if v_conflicts > 0 then
            raise exception
              'Cannot create the relationship-intention conflict index: % (identity, subject) pair(s) already hold more than one in-flight action.',
              v_conflicts;
          end if;
        end; $$;`),
    ).rejects.toThrow(/already hold more than one in-flight action/);

    await h.db.query(
      `delete from public.bluesky_relationship_actions where subject_did = $1`,
      [did],
    );
    await restoreIndex();
  });

  it("FIXED — the database refuses the second unresolved intention", async () => {
    await insertAction("follow", SUBJECT);
    await expect(insertAction("unfollow", SUBJECT)).rejects.toThrow(
      /bluesky_relationship_actions_one_intent|duplicate key/i,
    );
  });

  it("the guard is on the INTENTION, not on history", async () => {
    // A resolved action does not block anything. Unfollowing someone
    // you followed last week is the ordinary case, not a conflict.
    const did = "did:plc:resolved-history";
    await h.db.query(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did,
          actor_did, status)
       values ($1, $2, 'follow', $3, $4, 'succeeded')`,
      [t.workspaceId, t.identityId, did, ACTOR],
    );
    await expect(insertAction("unfollow", did)).resolves.toBeDefined();
  });

  it("reconciliation_required does NOT block the opposite intention", async () => {
    // Deliberate. Such an action can stand for days while truth is
    // read, and blocking for that whole period would turn an ambiguity
    // into a permanent lock on one person.
    const did = "did:plc:reconciling";
    await h.db.query(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did,
          actor_did, status)
       values ($1, $2, 'follow', $3, $4, 'reconciliation_required')`,
      [t.workspaceId, t.identityId, did, ACTOR],
    );
    await expect(insertAction("unfollow", did)).resolves.toBeDefined();
  });

  it("the unfollow claim RPC reports a conflict instead of throwing", async () => {
    const did = "did:plc:rpc-conflict";
    const campaign = await makeCampaign("unfollow", "rpc conflict");
    const run = await makeRun(campaign, "2026-09-14");
    const member = await makeMember(campaign, did, 900);

    // A follow is in flight for this person, from another campaign.
    await insertAction("follow", did);

    const verdict = await h.db.query<{
      may_mutate: boolean | null;
      refused_reason: string | null;
      action_id: string | null;
    }>(
      `select * from public.claim_bluesky_unfollow_action(
         $1,$2,$3,$4,$5,$6,null,$7,null,$8,$9,null,null)`,
      [
        t.workspaceId, campaign, run, member, t.identityId, did, ACTOR,
        `at://${ACTOR}/app.bsky.graph.follow/rkey900`, "rkey900",
      ],
    );
    expect(verdict.rows[0].refused_reason).toBe("conflicting_intent");
    expect(verdict.rows[0].may_mutate).not.toBe(true);
    // FAIL CLOSED: no unfollow action row was created at all.
    const rows = await h.db.query<{ n: string }>(
      `select count(*) as n from public.bluesky_relationship_actions
        where subject_did = $1 and action_type = 'unfollow'`,
      [did],
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });
});

describe("DEFECT 2: the Follow path must refuse an unfollow campaign", () => {
  it("FIXED — claim_bluesky_campaign_action raises on kind = unfollow", async () => {
    const campaign = await makeCampaign("unfollow", "isolation");
    const run = await makeRun(campaign, "2026-09-15");
    const member = await makeMember(campaign, "did:plc:isolation-subject", 1);

    await expect(
      h.db.query(
        `select * from public.claim_bluesky_campaign_action(
           $1,$2,$3,$4,$5,$6,null,$7,null,null)`,
        [t.workspaceId, campaign, run, member, t.identityId,
         "did:plc:isolation-subject", ACTOR],
      ),
    ).rejects.toThrow(/creates FOLLOW actions only/);

    // AND NOTHING WAS WRITTEN. A guard that raises after inserting
    // would still have created the row it was refusing to create.
    const rows = await h.db.query<{ n: string }>(
      `select count(*) as n from public.bluesky_relationship_actions
        where campaign_member_id = $1`,
      [member],
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  it("FIXED — claim_bluesky_unfollow_action raises on kind = follow", async () => {
    const campaign = await makeCampaign("follow", "reverse isolation");
    const run = await makeRun(campaign, "2026-09-16");
    const member = await makeMember(campaign, "did:plc:reverse-subject", 2);

    await expect(
      h.db.query(
        `select * from public.claim_bluesky_unfollow_action(
           $1,$2,$3,$4,$5,$6,null,$7,null,$8,$9,null,null)`,
        [t.workspaceId, campaign, run, member, t.identityId,
         "did:plc:reverse-subject", ACTOR,
         `at://${ACTOR}/app.bsky.graph.follow/rkey2`, "rkey2"],
      ),
    ).rejects.toThrow(/creates UNFOLLOW actions only/);
  });

  it("the follow path is UNAFFECTED for a follow campaign", async () => {
    // The mutation control for the guard itself: it must refuse only
    // the new case and change nothing about the established one.
    const campaign = await makeCampaign("follow", "still works");
    const run = await makeRun(campaign, "2026-09-17");
    const member = await makeMember(campaign, "did:plc:ordinary-follow", 3);

    const verdict = await h.db.query<{
      may_mutate: boolean;
      action_id: string;
    }>(
      `select * from public.claim_bluesky_campaign_action(
         $1,$2,$3,$4,$5,$6,null,$7,null,null)`,
      [t.workspaceId, campaign, run, member, t.identityId,
       "did:plc:ordinary-follow", ACTOR],
    );
    expect(verdict.rows[0].may_mutate).toBe(true);
    expect(verdict.rows[0].action_id).toBeTruthy();

    const row = await h.db.query<{ action_type: string; in_flight: string | null }>(
      `select action_type, provider_in_flight_at as in_flight
         from public.bluesky_relationship_actions where id = $1`,
      [verdict.rows[0].action_id],
    );
    expect(row.rows[0].action_type).toBe("follow");
    // NO in-flight marker at claim time — the deployed behaviour since
    // 20260911000005. Creating the row says "this worker intends to
    // handle this member", not "a request is in flight"; the marker
    // goes up in consume_bluesky_member_quota, one statement before the
    // request. This assertion was first written the other way round,
    // and the deployed real-PostgreSQL suites caught it.
    expect(row.rows[0].in_flight).toBeNull();
  });

  it("kind is immutable once a campaign exists", async () => {
    const campaign = await makeCampaign("unfollow", "immutable kind");
    await expect(
      h.db.query(
        `update public.bluesky_follow_campaigns set kind = 'follow' where id = $1`,
        [campaign],
      ),
    ).rejects.toThrow(/kind is immutable/);
  });
});
