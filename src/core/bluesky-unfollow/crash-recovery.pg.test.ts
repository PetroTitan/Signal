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

/**
 * What a killed serverless function leaves behind, and what the next
 * worker is allowed to do about it.
 *
 * THE LINE THAT DIVIDES EVERY CASE
 * --------------------------------
 * `bluesky_campaign_attempt_ledger.provider_intent_at`. It is stamped
 * in the SAME TRANSACTION that spends the quota unit and raises the
 * in-flight marker, one statement before the request, and it is never
 * cleared. So:
 *
 *   no intent   →  nothing was sent. Safe to send exactly one delete.
 *   intent      →  a delete MAY have gone out. Reconcile; send nothing.
 *
 * There is no state in between, because the three writes commit
 * together or not at all.
 *
 * WHY "deleteRecord IS IDEMPOTENT" IS NOT A DEFENCE
 * -------------------------------------------------
 * It is tempting to argue a repeat delete is harmless. It is not.
 * Between the lost request and the retry the operator may have
 * re-followed, minting a record under a NEW key — and the retry aims at
 * whatever key is current. Idempotence protects the request from being
 * repeated; it does not protect the world from having moved on.
 */

let f: UnfollowFixture;
const NOW = new Date("2026-09-14T12:00:00Z");
const TODAY = "2026-09-14";

beforeAll(async () => {
  f = await createUnfollowFixture("crash");
}, 180_000);
afterAll(async () => { await f?.close(); });

async function reserve(campaignId: string, runId: string) {
  const r = await f.db.query<Record<string, string | null>>(
    `select * from public.reserve_bluesky_campaign_quota(
       $1,$2,$3,$4,$5::date,100,1000,20,300,'w1')`,
    [f.tenant.workspaceId, campaignId, runId, f.tenant.identityId, TODAY],
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
  reservedOverride?: number,
) {
  const res = await reserve(campaignId, runId);
  if (res.members.length === 0) return { chunk: null, reason: res.reason };
  const c = await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaigns where id = $1`,
    [campaignId],
  );
  const chunk = await processUnfollowChunk({
    campaign: c.rows[0] as never,
    runId,
    session: {
      ok: true,
      actorDid: ACTOR_DID,
      actorHandle: "operator.bsky.social",
      accessJwt: "jwt",
      service: "https://bsky.social",
      refreshOnce: async () => ({ ok: false, message: "no" }),
    } as never,
    members: res.members,
    reservationId: res.reservationId as string,
    quotaRemaining: reservedOverride ?? res.reserved,
    consecutiveFailures: 0,
    claimedBy: "w1",
    initiatedBy: f.tenant.ownerId,
    now: NOW,
    fetchImpl: provider.fetchImpl,
    db: f.client,
    sleep: async () => undefined,
    interRequestMs: 0,
  });
  return { chunk, reason: res.reason };
}

/**
 * What a real kill leaves. Nothing in the process runs — no catch, no
 * finally, no cleanup — so the campaign stays ACTIVE, the ledger keeps
 * whatever it had committed, and the member stays leased until the
 * lease lapses. Here the lease is expired directly, which is what the
 * clock would have done.
 */
async function expireLeases(campaignId: string) {
  await f.db.query(
    `update public.bluesky_follow_campaign_members
        set lease_expires_at = now() - interval '1 hour'
      where campaign_id = $1 and status in ('claimed', 'running')`,
    [campaignId],
  );
  await f.db.query(
    `update public.bluesky_campaign_quota_reservations
        set expires_at = now() - interval '1 hour'
      where campaign_id = $1 and status = 'open'`,
    [campaignId],
  );
}

async function member(id: string) {
  const r = await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaign_members where id = $1`,
    [id],
  );
  return r.rows[0];
}

async function ledgerFor(memberId: string) {
  const r = await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_campaign_attempt_ledger
      where member_id = $1 order by created_at`,
    [memberId],
  );
  return r.rows;
}

async function actions(campaignId: string) {
  const r = await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_relationship_actions
      where campaign_id = $1 order by created_at, id`,
    [campaignId],
  );
  return r.rows;
}

// =====================================================================

describe("crash BEFORE provider intent", () => {
  it("the next worker sends EXACTLY ONE first delete", async () => {
    const c = await makeUnfollowCampaign(f, "crash before intent");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:beforeintent", sequence: 1 },
    ]);

    // Worker 1 reserves and claims, then dies before touching the
    // provider. Nothing else runs.
    const res = await reserve(c, r);
    expect(res.members).toHaveLength(1);
    // No intent was stamped.
    const before = await ledgerFor(m);
    expect(before).toHaveLength(1);
    expect(before[0].provider_intent_at).toBeNull();

    await expireLeases(c);

    // Worker 2 picks it up.
    const provider = providerDouble({
      relationships: {
        "did:plc:beforeintent": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    const { chunk } = await runChunk(c, r, provider);

    expect(provider.deletes).toHaveLength(1);
    expect(chunk?.succeeded).toBe(1);
    expect((await member(m)).status).toBe("succeeded");

    // Exactly one action row, ever.
    expect(await actions(c)).toHaveLength(1);
  });
});

describe("crash AFTER provider intent", () => {
  it("the next worker sends ZERO deletes and reconciles instead", async () => {
    const c = await makeUnfollowCampaign(f, "crash after intent");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:afterintent", sequence: 1 },
    ]);

    // Worker 1 gets as far as the provider, then dies with the request
    // outcome unknown. The stamp is already durable.
    const provider1 = providerDouble({
      relationships: {
        "did:plc:afterintent": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
      // The socket dropped: no response ever came back.
      defaultDelete: { status: 502, body: { error: "BadGateway" } },
    });
    await runChunk(c, r, provider1);
    expect(provider1.deletes).toHaveLength(1);

    const afterFirst = await ledgerFor(m);
    expect(afterFirst[0].provider_intent_at).not.toBeNull();

    // Force the action into the unresolved state a KILL would leave —
    // a 502 is handled gracefully, whereas a kill leaves the marker up.
    await f.db.query(
      `update public.bluesky_relationship_actions
          set status = 'running', provider_in_flight_at = now(),
              finished_at = null
        where campaign_id = $1`,
      [c],
    );
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status = 'claimed', next_attempt_at = null,
              claimed_by = 'w1', claimed_at = now(),
              lease_expires_at = now() + interval '5 minutes'
        where id = $1`,
      [m],
    );
    await expireLeases(c);

    // Worker 2. The relationship still shows the follow — which is NOT
    // proof the delete failed, and re-sending could remove a follow the
    // operator has since deliberately re-created.
    const provider2 = providerDouble({
      relationships: {
        "did:plc:afterintent": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    await runChunk(c, r, provider2);

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR.
    expect(provider2.deletes).toHaveLength(0);
    // It DID read truth — reconciliation is reads, not silence.
    expect(provider2.relationshipReads).toBeGreaterThan(0);

    const row = await member(m);
    expect(row.status).toBe("retryable");
    const act = await actions(c);
    expect(act).toHaveLength(1);
    expect(act[0].status).toBe("reconciliation_required");
    expect(String(act[0].reconciliation_note)).toMatch(/nothing was re-sent/i);

    // No second unit was spent: the ledger holds ONE intent, and the
    // run counted ONE attempt.
    const ledger = await ledgerFor(m);
    expect(ledger.filter((l) => l.provider_intent_at !== null)).toHaveLength(1);
  });

  it("reconciliation CONCLUDES when Bluesky confirms the follow is gone", async () => {
    const c = await makeUnfollowCampaign(f, "reconcile concludes");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:concludes", sequence: 1 },
    ]);

    const provider1 = providerDouble({
      relationships: {
        "did:plc:concludes": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
      defaultDelete: { status: 502, body: { error: "BadGateway" } },
    });
    await runChunk(c, r, provider1);

    await f.db.query(
      `update public.bluesky_relationship_actions
          set status = 'running', provider_in_flight_at = now(), finished_at = null
        where campaign_id = $1`,
      [c],
    );
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status = 'claimed', next_attempt_at = null,
              claimed_by = 'w1', claimed_at = now(),
              lease_expires_at = now() + interval '5 minutes'
        where id = $1`,
      [m],
    );
    await expireLeases(c);

    // The delete DID land after all — Bluesky now reports no follow.
    const provider2 = providerDouble({
      relationships: { "did:plc:concludes": {} },
    });
    await runChunk(c, r, provider2);

    expect(provider2.deletes).toHaveLength(0);
    const row = await member(m);
    // A concluded reconciliation is a terminal, honest success.
    expect(row.status).toBe("already_not_following");
    const act = await actions(c);
    expect(act[0].status).toBe("succeeded");
    // NULL, because THIS pass destroyed nothing — it discovered the
    // record was gone. Settlement must not count a deletion twice.
    expect(act[0].follow_uri).toBeNull();
  });

  it("a slow reconciliation cannot monopolise the tick", async () => {
    // An unresolved member is claimable REGARDLESS of headroom, so
    // without a backoff it would be re-claimed the instant its lease
    // clears — every iteration, for the whole tick — while healthy
    // queued members wait behind it.
    const c = await makeUnfollowCampaign(f, "no monopoly");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:monopolist", sequence: 1 },
    ]);

    const p1 = providerDouble({
      relationships: {
        "did:plc:monopolist": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
      defaultDelete: { status: 502, body: { error: "BadGateway" } },
    });
    await runChunk(c, r, p1);
    await f.db.query(
      `update public.bluesky_relationship_actions
          set status = 'running', provider_in_flight_at = now(), finished_at = null
        where campaign_id = $1`,
      [c],
    );
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status = 'claimed', next_attempt_at = null,
              claimed_by = 'w1', claimed_at = now(),
              lease_expires_at = now() + interval '5 minutes'
        where id = $1`,
      [m],
    );
    await expireLeases(c);

    const p2 = providerDouble({
      relationships: {
        "did:plc:monopolist": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    await runChunk(c, r, p2);

    const row = await member(m);
    expect(row.status).toBe("retryable");

    // TWO SEPARATE CLAIMS, PROVEN SEPARATELY.
    //
    // (a) the WORKER pushes an unresolved member out by the
    //     reconciliation backoff, measured from the instant it was
    //     given — not by the much shorter transport retry a failed
    //     request would get.
    const next = new Date(String(row.next_attempt_at)).getTime();
    expect(next - NOW.getTime()).toBeGreaterThanOrEqual(9 * 60_000);

    // (b) the RESERVATION RPC refuses a member whose backoff has not
    //     elapsed, so the same tick cannot pick it up again.
    //
    // These are asserted apart because the worker writes its timestamp
    // from an INJECTED instant while Postgres compares against its own
    // `now()`. Collapsing them into one assertion would make this test
    // pass or fail depending on the hour it was run at, which is a
    // property of the test rather than of the system.
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set next_attempt_at = now() + interval '10 minutes' where id = $1`,
      [m],
    );
    await expireLeases(c);
    const again = await reserve(c, r);
    expect(again.members.map((x) => x.id)).not.toContain(m);

    // And it IS picked up once the backoff has elapsed — otherwise this
    // test would pass just as well against a member nothing can ever
    // claim, which would be a far worse bug than the one it is for.
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set next_attempt_at = now() - interval '1 minute' where id = $1`,
      [m],
    );
    const later = await reserve(c, r);
    expect(later.members.map((x) => x.id)).toContain(m);
  });
});

describe("a zero-unit reservation cannot fund a delete", () => {
  it("THE DATABASE refuses, whatever the worker believes it may spend", async () => {
    // This is the guarantee that keeps reconciliation read-only. A
    // takeover reservation hands back members REGARDLESS of quota, so
    // the only thing standing between it and a provider call is
    // `consume_bluesky_member_quota` refusing a reservation with
    // nothing left to spend.
    //
    // Asserted against the RPC directly rather than through the worker,
    // because a worker-level assertion passes for whichever reason
    // happens to hold — and a mutation control showed the worker's own
    // quota check is not currently the one that bites.
    const c = await makeUnfollowCampaign(f, "zero unit reservation");
    const r = await makeRun(f, c, TODAY);
    const [m] = await makeMembers(f, c, [
      { did: "did:plc:zerounit", sequence: 1 },
    ]);

    const res = await f.db.query<{ id: string }>(
      `insert into public.bluesky_campaign_quota_reservations
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reserved_count, status, claimed_by, expires_at)
       values ($1,$2,$3,$4,$5::date,0,'open','w1', now() + interval '5 minutes')
       returning id`,
      [f.tenant.workspaceId, c, r, f.tenant.identityId, TODAY],
    );
    const reservationId = res.rows[0].id;

    const action = await f.db.query<{ id: string }>(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did,
          actor_did, status, campaign_id, campaign_run_id, campaign_member_id,
          follow_uri, follow_rkey)
       values ($1,$2,'unfollow','did:plc:zerounit',$3,'running',$4,$5,$6,$7,'rk-1')
       returning id`,
      [
        f.tenant.workspaceId, f.tenant.identityId, ACTOR_DID, c, r, m,
        `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
      ],
    );

    const verdict = await f.db.query<{
      consumed: boolean;
      already_consumed: boolean;
      refused_reason: string | null;
    }>(
      `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
      [
        f.tenant.workspaceId, c, r, reservationId, m,
        action.rows[0].id, f.tenant.identityId,
      ],
    );

    expect(verdict.rows[0].consumed).toBe(false);
    expect(verdict.rows[0].already_consumed).toBe(false);
    expect(verdict.rows[0].refused_reason).toBe("reservation_exhausted");

    // And nothing was stamped: no intent, no in-flight marker. A
    // refusal that still marked intent would put the member into
    // permanent reconciliation for a request nobody made.
    const ledger = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_campaign_attempt_ledger
        where reservation_id = $1 and provider_intent_at is not null`,
      [reservationId],
    );
    expect(ledger.rows[0].n).toBe("0");

    const marker = await f.db.query<{ provider_in_flight_at: string | null }>(
      `select provider_in_flight_at from public.bluesky_relationship_actions
        where id = $1`,
      [action.rows[0].id],
    );
    expect(marker.rows[0].provider_in_flight_at).toBeNull();
  });

  it("a reservation belonging to another campaign is refused by ownership", async () => {
    const mine = await makeUnfollowCampaign(f, "ownership mine");
    const theirs = await makeUnfollowCampaign(f, "ownership theirs");
    const runMine = await makeRun(f, mine, TODAY);
    const runTheirs = await makeRun(f, theirs, TODAY);
    const [m] = await makeMembers(f, mine, [
      { did: "did:plc:ownership", sequence: 1 },
    ]);

    const res = await f.db.query<{ id: string }>(
      `insert into public.bluesky_campaign_quota_reservations
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reserved_count, status, claimed_by, expires_at)
       values ($1,$2,$3,$4,$5::date,10,'open','w1', now() + interval '5 minutes')
       returning id`,
      [f.tenant.workspaceId, theirs, runTheirs, f.tenant.identityId, TODAY],
    );

    const action = await f.db.query<{ id: string }>(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did,
          actor_did, status, campaign_id, campaign_run_id, campaign_member_id)
       values ($1,$2,'unfollow','did:plc:ownership',$3,'running',$4,$5,$6)
       returning id`,
      [f.tenant.workspaceId, f.tenant.identityId, ACTOR_DID, mine, runMine, m],
    );

    const verdict = await f.db.query<{ refused_reason: string | null }>(
      `select * from public.consume_bluesky_member_quota($1,$2,$3,$4,$5,$6,$7)`,
      [
        f.tenant.workspaceId, mine, runMine, res.rows[0].id, m,
        action.rows[0].id, f.tenant.identityId,
      ],
    );
    expect(verdict.rows[0].refused_reason).toBe("campaign_mismatch");
  });
});

describe("crash after a SUCCESSFUL response, before settlement", () => {
  it("settlement folds the durable ledger, not the lost worker's memory", async () => {
    const c = await makeUnfollowCampaign(f, "crash before settle");
    const r = await makeRun(f, c, TODAY);
    const ids = await makeMembers(f, c, [
      { did: "did:plc:settled1", sequence: 1 },
      { did: "did:plc:settled2", sequence: 2 },
    ]);

    const provider = providerDouble({
      relationships: {
        "did:plc:settled1": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
        "did:plc:settled2": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-2`,
        },
      },
    });
    const res = await reserve(c, r);
    const campaignRow = await f.db.query<Record<string, unknown>>(
      `select * from public.bluesky_follow_campaigns where id = $1`,
      [c],
    );
    await processUnfollowChunk({
      campaign: campaignRow.rows[0] as never,
      runId: r,
      session: {
        ok: true, actorDid: ACTOR_DID, actorHandle: "op",
        accessJwt: "jwt", service: "https://bsky.social",
        refreshOnce: async () => ({ ok: false, message: "no" }),
      } as never,
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
    expect(provider.deletes).toHaveLength(2);

    // THE WORKER DIES HERE. `applyRunOutcome` is never called, so the
    // run's succeeded_count is still zero and the reservation is open.
    let runRow = await f.db.query<Record<string, number>>(
      `select succeeded_count, attempted_count from
         public.bluesky_follow_campaign_runs where id = $1`,
      [r],
    );
    expect(Number(runRow.rows[0].succeeded_count)).toBe(0);
    // But the ATTEMPTS survive: they were counted at provider intent,
    // one member at a time.
    expect(Number(runRow.rows[0].attempted_count)).toBe(2);

    // The sweep recovers it — the same fold settlement would have run.
    await expireLeases(c);
    await f.db.query(
      `select public.sweep_bluesky_quota_reservations($1,$2,$3::date)`,
      [f.tenant.workspaceId, f.tenant.identityId, TODAY],
    );

    runRow = await f.db.query<Record<string, number>>(
      `select succeeded_count, already_absent_count, failed_count
         from public.bluesky_follow_campaign_runs where id = $1`,
      [r],
    );
    expect(Number(runRow.rows[0].succeeded_count)).toBe(2);

    // And the identity's DELETE count moved — never its follow count.
    const usage = await f.db.query<Record<string, number>>(
      `select follows_created, unfollows_deleted, provider_points_spent
         from public.bluesky_identity_daily_usage
        where operator_account_id = $1 and usage_date = $2::date`,
      [f.tenant.identityId, TODAY],
    );
    expect(Number(usage.rows[0].unfollows_deleted)).toBe(2);
    expect(Number(usage.rows[0].follows_created)).toBe(0);
    // DELETE costs 1 point each, per the published limits.
    expect(Number(usage.rows[0].provider_points_spent)).toBe(2);

    expect(ids).toHaveLength(2);
  });

  it("DUPLICATE settlement applies nothing twice", async () => {
    const c = await makeUnfollowCampaign(f, "duplicate settlement");
    const r = await makeRun(f, c, TODAY);
    await makeMembers(f, c, [{ did: "did:plc:dupsettle", sequence: 1 }]);

    const provider = providerDouble({
      relationships: {
        "did:plc:dupsettle": {
          following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-1`,
        },
      },
    });
    const res = await reserve(c, r);
    const campaignRow = await f.db.query<Record<string, unknown>>(
      `select * from public.bluesky_follow_campaigns where id = $1`, [c]);
    await processUnfollowChunk({
      campaign: campaignRow.rows[0] as never,
      runId: r,
      session: {
        ok: true, actorDid: ACTOR_DID, actorHandle: "op", accessJwt: "jwt",
        service: "https://bsky.social",
        refreshOnce: async () => ({ ok: false, message: "no" }),
      } as never,
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

    const usageBefore = await f.db.query<Record<string, number>>(
      `select coalesce(unfollows_deleted, 0) as n
         from public.bluesky_identity_daily_usage
        where operator_account_id = $1 and usage_date = $2::date`,
      [f.tenant.identityId, TODAY],
    );
    const beforeCount = Number(usageBefore.rows[0]?.n ?? 0);

    const settle = () =>
      f.db.query<Record<string, unknown>>(
        `select * from public.apply_bluesky_run_outcome(
           $1,$2,$3,$4,$5::date,$6,0,null,null,null)`,
        [
          f.tenant.workspaceId, c, r, f.tenant.identityId, TODAY,
          res.reservationId,
        ],
      );

    const first = await settle();
    expect(first.rows[0].settled).toBe(true);
    const second = await settle();
    expect(second.rows[0].settled).toBe(false);
    expect(second.rows[0].already_settled).toBe(true);

    const runRow = await f.db.query<Record<string, number>>(
      `select succeeded_count from public.bluesky_follow_campaign_runs where id = $1`,
      [r],
    );
    expect(Number(runRow.rows[0].succeeded_count)).toBe(1);

    const usage = await f.db.query<Record<string, number>>(
      `select unfollows_deleted from public.bluesky_identity_daily_usage
        where operator_account_id = $1 and usage_date = $2::date`,
      [f.tenant.identityId, TODAY],
    );
    // The identity counter is SHARED by every campaign on this account,
    // which is the point of it — so the assertion is on the delta. One
    // deletion, settled twice, moves it by one.
    expect(Number(usage.rows[0].unfollows_deleted) - beforeCount).toBe(1);
  });
});
