import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  ACTOR_DID,
  createUnfollowFixture,
  makeMembers,
  makeRun,
  makeUnfollowCampaign,
  mockSession,
  providerDouble,
  type UnfollowFixture,
} from "./test-support/harness";

vi.mock("@/core/bluesky-relationships/session.server", () => mockSession());

import { processUnfollowChunk } from "./worker.server";
import { toUnfollowVerdict } from "@/repositories/bluesky-unfollow-repository";

let f: UnfollowFixture;
const NOW = new Date("2026-09-14T12:00:00Z");
const TODAY = "2026-09-14";

beforeAll(async () => {
  f = await createUnfollowFixture("protection");
}, 180_000);
afterAll(async () => { await f?.close(); });

async function reserve(campaignId: string, runId: string, requested = 100) {
  const r = await f.db.query<Record<string, string | null>>(
    `select * from public.reserve_bluesky_campaign_quota(
       $1,$2,$3,$4,$5::date,$6,1000,20,300,'w1')`,
    [f.tenant.workspaceId, campaignId, runId, f.tenant.identityId, TODAY, requested],
  );
  const rows = r.rows.filter((x) => x.member_id !== null);
  return {
    reservationId: r.rows[0]?.reservation_id ?? null,
    reason: r.rows[0]?.reason ?? "queue_empty",
    reserved: rows.length,
    members: rows.map((x) => ({
      id: x.member_id as string,
      subject_did: x.subject_did as string,
      current_handle: x.current_handle,
      import_sequence: Number(x.import_sequence ?? 0),
      attempt_count: Number(x.attempt_count ?? 0),
      provider_record_rkey: x.provider_record_rkey,
    })),
  };
}

async function runChunk(
  campaignId: string,
  runId: string,
  provider: ReturnType<typeof providerDouble>,
  session?: Record<string, unknown>,
) {
  const res = await reserve(campaignId, runId);
  const c = await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaigns where id = $1`, [campaignId]);
  return processUnfollowChunk({
    campaign: c.rows[0] as never,
    runId,
    session: (session ?? {
      ok: true, actorDid: ACTOR_DID, actorHandle: "op", accessJwt: "jwt",
      service: "https://bsky.social",
      refreshOnce: async () => ({ ok: false, message: "no" }),
    }) as never,
    members: res.members,
    reservationId: res.reservationId as string,
    quotaRemaining: res.reserved,
    consecutiveFailures: 0,
    claimedBy: "w1",
    initiatedBy: f.tenant.ownerId,
    now: NOW,
    fetchImpl: provider.fetchImpl,
    db: f.client,
    sleep: async () => undefined,
    interRequestMs: 0,
  });
}

const member = async (id: string) =>
  (await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaign_members where id = $1`, [id],
  )).rows[0];

// =====================================================================

describe("protection", () => {
  it("the acting identity can never unfollow ITSELF", async () => {
    // First, unconditional, and not overridable by any setting. An
    // attempt would mean the DID resolution that built the queue was
    // wrong about who is acting.
    const c = await makeUnfollowCampaign(f, "self protection");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [{ did: ACTOR_DID, sequence: 1 }]);

    const provider = providerDouble({
      relationships: {
        [ACTOR_DID]: {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    const chunk = await runChunk(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    expect(chunk.protectedCount).toBe(1);
    expect(chunk.quotaConsumed).toBe(0);
    const row = await member(m);
    expect(row.status).toBe("protected");
    expect(String(row.protected_reason)).toMatch(/acting account itself/i);
  });

  it("PROTECTION IS RE-CHECKED between import and execution", async () => {
    // THE CASE THIS EXISTS FOR. A queue frozen last week must not
    // unfollow someone the operator protected yesterday. The import ran
    // when the member was unprotected; the allowlist entry lands after.
    const c = await makeUnfollowCampaign(f, "late protection");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:protectedlate", sequence: 1 },
    ]);
    // Queued, not protected, exactly as the import left it.
    expect((await member(m)).status).toBe("queued");

    // The operator changes their mind AFTER the queue was frozen.
    await f.db.query(
      `insert into public.bluesky_unfollow_allowlist
         (workspace_id, operator_account_id, subject_did, reason)
       values ($1,$2,$3,'A friend.')`,
      [f.tenant.workspaceId, f.tenant.identityId, "did:plc:protectedlate"],
    );

    const provider = providerDouble({
      relationships: {
        "did:plc:protectedlate": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    const chunk = await runChunk(c, r, provider);

    expect(provider.deletes).toHaveLength(0);
    expect(chunk.protectedCount).toBe(1);
    const row = await member(m);
    expect(row.status).toBe("protected");
    expect(String(row.protected_reason)).toMatch(/Never unfollow list/i);
  });

  it("MUTATION CONTROL — remove the allowlist entry and the delete happens", async () => {
    // Proves the previous test failed for the intended reason. Without
    // this, a test asserting "nothing was deleted" would pass just as
    // well against a worker that deletes nothing at all.
    const c = await makeUnfollowCampaign(f, "protection removed");
    const r = await makeRun(f, c, TODAY);
    await makeMembers(f, c, [{ did: "did:plc:unprotected", sequence: 1 }]);

    const provider = providerDouble({
      relationships: {
        "did:plc:unprotected": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    const chunk = await runChunk(c, r, provider);
    expect(provider.deletes).toHaveLength(1);
    expect(chunk.protectedCount).toBe(0);
  });

  it("a WORKSPACE-WIDE allowlist entry protects across every identity", async () => {
    const c = await makeUnfollowCampaign(f, "global protection");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:globalprotected", sequence: 1 },
    ]);
    await f.db.query(
      `insert into public.bluesky_unfollow_allowlist
         (workspace_id, operator_account_id, subject_did, reason)
       values ($1, null, $2, 'Company account.')`,
      [f.tenant.workspaceId, "did:plc:globalprotected"],
    );
    const provider = providerDouble({
      relationships: {
        "did:plc:globalprotected": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    await runChunk(c, r, provider);
    expect(provider.deletes).toHaveLength(0);
    expect((await member(m)).status).toBe("protected");
  });

  it("the relationships-list `protected` flag is honoured too", async () => {
    const c = await makeUnfollowCampaign(f, "candidate protection");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:candprotected", sequence: 1 },
    ]);
    await f.db.query(
      `insert into public.bluesky_candidates
         (workspace_id, operator_account_id, subject_did, handle, protected)
       values ($1,$2,$3,'cand.bsky.social',true)`,
      [f.tenant.workspaceId, f.tenant.identityId, "did:plc:candprotected"],
    );
    const provider = providerDouble({
      relationships: {
        "did:plc:candprotected": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    await runChunk(c, r, provider);
    expect(provider.deletes).toHaveLength(0);
    expect(String((await member(m)).protected_reason)).toMatch(
      /relationships list/i,
    );
  });

  it("a protected member already unfollowed reads as PROTECTED, not as a result", async () => {
    // "Protected" is the honest reason Signal will not act, and it
    // stays true if the operator follows them again tomorrow.
    const c = await makeUnfollowCampaign(f, "protected and absent");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:protectedabsent", sequence: 1 },
    ]);
    await f.db.query(
      `insert into public.bluesky_unfollow_allowlist
         (workspace_id, operator_account_id, subject_did)
       values ($1,$2,$3)`,
      [f.tenant.workspaceId, f.tenant.identityId, "did:plc:protectedabsent"],
    );
    const provider = providerDouble({
      relationships: { "did:plc:protectedabsent": {} },
    });
    await runChunk(c, r, provider);
    expect((await member(m)).status).toBe("protected");
  });
});

describe("quota accounting", () => {
  it("a unit is consumed at PROVIDER INTENT — not at claim, not at settlement", async () => {
    const c = await makeUnfollowCampaign(f, "intent accounting");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:intentpoint", sequence: 1 },
    ]);

    const before = await f.db.query<Record<string, number>>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [r],
    );
    expect(Number(before.rows[0].attempted_count)).toBe(0);

    // A claim alone must not move it.
    await reserve(c, r);
    const afterClaim = await f.db.query<Record<string, number>>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [r],
    );
    expect(Number(afterClaim.rows[0].attempted_count)).toBe(0);

    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status='queued', claimed_by=null, lease_expires_at=null
        where id=$1`,
      [m],
    );
    await f.db.query(
      `update public.bluesky_campaign_quota_reservations
          set status='expired', reserved_count=0 where campaign_id=$1`,
      [c],
    );

    const provider = providerDouble({
      relationships: {
        "did:plc:intentpoint": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    await runChunk(c, r, provider);

    const after = await f.db.query<Record<string, number>>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [r],
    );
    expect(Number(after.rows[0].attempted_count)).toBe(1);
  });

  it("a member with 3 units left attempts 3, not 20 and not 0", async () => {
    const c = await makeUnfollowCampaign(f, "partial quota");
    const r = await makeRun(f, c, TODAY, 3);
    const seeds = Array.from({ length: 10 }, (_, i) => ({
      did: `did:plc:partial${i}`,
      sequence: i + 1,
    }));
    await makeMembers(f, c, seeds);

    const provider = providerDouble({
      relationships: Object.fromEntries(
        seeds.map((s) => [
          s.did,
          { following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-${s.sequence}` },
        ]),
      ),
    });

    const chunk = await runChunk(c, r, provider);
    expect(provider.deletes).toHaveLength(3);
    expect(chunk.quotaConsumed).toBe(3);
  });

  it("the run's effective quota can never exceed what the operator requested", async () => {
    // The database refuses it outright, because a bug that widened it
    // would have Signal attempting more than was approved.
    const c = await makeUnfollowCampaign(f, "quota ceiling");
    await expect(
      f.db.query(
        `insert into public.bluesky_follow_campaign_runs
           (workspace_id, campaign_id, local_date, requested_daily_quota,
            effective_daily_quota)
         values ($1,$2,'2026-10-01',100,101)`,
        [f.tenant.workspaceId, c],
      ),
    ).rejects.toThrow(/effective_lte_requested|violates check/i);
  });
});

describe("authentication expiry", () => {
  it("refreshes AT MOST ONCE and duplicates no accounting", async () => {
    const c = await makeUnfollowCampaign(f, "auth refresh");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:refresh", sequence: 1 },
    ]);

    let refreshCalls = 0;
    const provider = providerDouble({
      relationships: {
        "did:plc:refresh": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
      // The first delete is rejected as an expired token; the second,
      // after the refresh, succeeds.
      deleteResponses: {
        "rk-1": { status: 200, body: {} },
      },
    });
    // Override: first call 400/ExpiredToken, second 200.
    let deleteCalls = 0;
    const base = provider.fetchImpl;
    provider.fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.includes("deleteRecord")) {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          // Record the attempt in the double, then answer with an
          // expired token exactly as bsky.social does — HTTP 400 with
          // the reason in the BODY, which is the shape that made an
          // earlier version of this system never refresh at all.
          await base(url, init);
          return new Response(
            JSON.stringify({ error: "ExpiredToken", message: "Token has expired" }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
      }
      return base(url, init);
    }) as typeof fetch;

    const chunk = await runChunk(c, r, provider, {
      ok: true,
      actorDid: ACTOR_DID,
      actorHandle: "op",
      accessJwt: "old-jwt",
      service: "https://bsky.social",
      refreshOnce: async () => {
        refreshCalls += 1;
        return {
          ok: true as const,
          actorDid: ACTOR_DID,
          actorHandle: "op",
          accessJwt: "new-jwt",
          service: "https://bsky.social",
          // The renewed session refuses to refresh again — which is
          // what caps renewals at one without counting anything.
          refreshOnce: async () => ({ ok: false as const, message: "already refreshed" }),
        };
      },
    });

    expect(refreshCalls).toBe(1);
    expect(deleteCalls).toBe(2);
    expect(chunk.succeeded).toBe(1);

    // ONE action row, ONE ledger intent, ONE attempt. The refresh and
    // its retry sit BELOW the consume line, so none of the accounting
    // ran a second time.
    const actions = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_relationship_actions
        where campaign_id = $1`, [c]);
    expect(actions.rows[0].n).toBe("1");

    const ledger = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_campaign_attempt_ledger
        where member_id = $1 and provider_intent_at is not null`, [m]);
    expect(ledger.rows[0].n).toBe("1");

    const runRow = await f.db.query<Record<string, number>>(
      `select attempted_count from public.bluesky_follow_campaign_runs where id=$1`,
      [r]);
    expect(Number(runRow.rows[0].attempted_count)).toBe(1);
  });

  it("a refresh that FAILS stops the campaign instead of retrying per member", async () => {
    const c = await makeUnfollowCampaign(f, "auth dead");
    const r = await makeRun(f, c, TODAY);
    await makeMembers(f, c, [
      { did: "did:plc:dead1", sequence: 1 },
      { did: "did:plc:dead2", sequence: 2 },
      { did: "did:plc:dead3", sequence: 3 },
    ]);
    const provider = providerDouble({
      relationships: {
        "did:plc:dead1": { following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1` },
        "did:plc:dead2": { following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-2` },
        "did:plc:dead3": { following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-3` },
      },
      defaultDelete: {
        status: 400,
        body: { error: "ExpiredToken", message: "Token has expired" },
      },
    });

    const chunk = await runChunk(c, r, provider);

    expect(chunk.next).toEqual(
      expect.objectContaining({
        kind: "stop_campaign",
        campaignStatus: "reauthorization_required",
      }),
    );
    // ONE provider call, not one per remaining member.
    expect(provider.deletes).toHaveLength(1);
  });
});

describe("the claim verdict is a CLOSED set that fails closed", () => {
  const target = { recordUri: "at://a/b/c", recordRkey: "c", recordCid: null };

  it("an unknown verdict grants NO permission", () => {
    const v = toUnfollowVerdict(
      {
        action_id: "a1", may_mutate: null, needs_reconcile: null,
        terminal: null, refused_reason: null, protected_reason: null,
        existing_status: "some_future_status",
      },
      target,
    );
    expect(v.kind).toBe("denied");
  });

  it("a terminal row with an UNRECOGNISED status is denied, not guessed", () => {
    const v = toUnfollowVerdict(
      {
        action_id: "a1", may_mutate: false, needs_reconcile: false,
        terminal: true, refused_reason: null, protected_reason: null,
        existing_status: "quarantined",
      },
      target,
    );
    expect(v.kind).toBe("denied");
  });

  it("may_mutate WITHOUT an action id grants nothing", () => {
    const v = toUnfollowVerdict(
      {
        action_id: null, may_mutate: true, needs_reconcile: false,
        terminal: false, refused_reason: null, protected_reason: null,
        existing_status: null,
      },
      target,
    );
    expect(v.kind).toBe("denied");
  });

  it("may_mutate with an EMPTY record key grants nothing", () => {
    const v = toUnfollowVerdict(
      {
        action_id: "a1", may_mutate: true, needs_reconcile: false,
        terminal: false, refused_reason: null, protected_reason: null,
        existing_status: null,
      },
      { recordUri: "", recordRkey: "", recordCid: null },
    );
    expect(v.kind).toBe("denied");
  });

  it("a refusal wins over every other flag", () => {
    const v = toUnfollowVerdict(
      {
        action_id: "a1", may_mutate: true, needs_reconcile: false,
        terminal: false, refused_reason: "conflicting_intent",
        protected_reason: null, existing_status: null,
      },
      target,
    );
    expect(v.kind).toBe("conflict");
  });

  it("only the granting verdict carries a permit, and it names the exact record", () => {
    const v = toUnfollowVerdict(
      {
        action_id: "a1", may_mutate: true, needs_reconcile: false,
        terminal: false, refused_reason: null, protected_reason: null,
        existing_status: null,
      },
      { recordUri: "at://x/y/rk", recordRkey: "rk", recordCid: "cid1" },
    );
    expect(v.kind).toBe("may_mutate");
    if (v.kind === "may_mutate") {
      expect(v.permit.rkey).toBe("rk");
      expect(v.permit.uri).toBe("at://x/y/rk");
      expect(v.permit.cid).toBe("cid1");
    }
  });
});
