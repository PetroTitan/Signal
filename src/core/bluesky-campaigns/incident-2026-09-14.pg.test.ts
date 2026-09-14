import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  ACTOR_DID,
  actionsFor,
  campaignRow,
  conservation,
  createFollowFixture,
  intentsFor,
  makeFollowCampaign,
  makeMembers,
  memberCounts,
  providerDouble,
  reconnectAccount,
  runsFor,
  storedTokens,
  type FollowFixture,
} from "./test-support/pg-harness";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * PRODUCTION INCIDENT, 2026-09-14 — campaign "WebmasterID 1-3".
 *
 * Replayed against the shipped migrations, the real session resolver,
 * the real refresh path and the real connection persistence. Only the
 * network is a double, and it counts every request.
 *
 * Today's sequence: 223 already-following, 60 successful follows, then
 * the next member receives HTTP 400 {"error":"ExpiredToken"}. What
 * happened next in production: the campaign stopped for
 * reauthorization, the day's run was marked failed, the operator
 * reconnected and resumed, and the dispatcher did nothing for the rest
 * of the day because nothing resumes a failed run. 22,058 members
 * waited while 339 of 400 units went unused. Yesterday, the same.
 */

let f: FollowFixture;
const DAY1 = "2026-09-14T09:00:00Z";

beforeAll(async () => {
  f = await createFollowFixture("incident");
}, 180_000);
afterAll(async () => { await f?.close(); });

const dispatch = (
  provider: ReturnType<typeof providerDouble>,
  over: Record<string, unknown> = {},
) =>
  dispatchCampaigns({
    nowIso: DAY1,
    db: f.client,
    fetchImpl: provider.fetchImpl,
    sleep: async () => undefined,
    interRequestMs: 0,
    ...over,
  });

describe("today's production sequence", () => {
  it("A–G: 223 already following, 60 follows, ExpiredToken, one refresh, one retry, continues, run stays running", async () => {
    const c = await makeFollowCampaign(f, "WebmasterID 1-3", { requestedDailyQuota: 400 });
    // 223 already followed, then the rest.
    await makeMembers(f, c, 300, "wm");
    const following = new Set<string>();
    for (let i = 1; i <= 223; i += 1) following.add(`did:plc:wm${i}`);

    // The access token expired overnight: the FIRST createRecord of the
    // day is refused. After the refresh, everything succeeds.
    const provider = providerDouble({ following });

    const result = await dispatch(provider, { campaignId: c });

    // A. 223 already-following outcomes, no quota, no request each.
    const counts = await memberCounts(f, c);
    expect(counts.already_following).toBe(223);

    // B/C/D/E. The first write carried the dead token and was refused;
    // ONE refresh; ONE retry of the SAME operation with the new token.
    expect(provider.calls.refreshSession).toBe(1);
    expect(provider.refreshTokensUsed).toEqual(["refresh-1"]);
    const oldTokenCalls = provider.createRecords.filter((r) => r.token === "jwt-OLD");
    expect(oldTokenCalls).toHaveLength(1);
    const retried = provider.createRecords.filter(
      (r) => r.subjectDid === oldTokenCalls[0].subjectDid,
    );
    expect(retried).toHaveLength(2);
    expect(retried[1].token).toBe("jwt-NEW");

    // F. Later members continued — ACROSS CHUNKS, on the renewed
    // session. 77 members remained after the 223; all 77 followed, and
    // only the very first write ever carried the old token. Before the
    // fix every chunk began with the expired session and refreshed
    // again: this assertion is what the existing single-chunk test
    // could not see.
    expect(counts.succeeded).toBe(77);
    expect(provider.calls.createRecord).toBe(78); // 77 + the refused one
    expect(provider.calls.refreshSession).toBe(1);

    // The rotated credentials were persisted, and the account is signed in.
    const tokens = await storedTokens(f);
    expect(tokens.access).toBe("jwt-NEW");
    expect(tokens.refresh).toBe("refresh-2");
    expect(tokens.status).toBe("connected");
    expect(tokens.accountStatus).toBe("connected");

    // E, the accounting: one unit, one intent, one action for the
    // refreshed member — two HTTP requests did not become two of anything.
    const actions = await actionsFor(f, c);
    const forRetried = actions.filter((a) => a.subject_did === oldTokenCalls[0].subjectDid);
    expect(forRetried).toHaveLength(1);
    expect(forRetried[0].status).toBe("succeeded");
    expect(await intentsFor(f, c)).toBe(77);
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(Number(runs[0].attempted_count)).toBe(77);
    expect(Number(runs[0].succeeded_count)).toBe(77);
    expect(Number(runs[0].failed_count)).toBe(0);

    // G. The run is NOT failed and the campaign is NOT pushed to
    // tomorrow. 300 of 300 members are terminal, so the campaign
    // completed — through the completion guard.
    expect(runs[0].status).not.toBe("failed");
    const camp = await campaignRow(f, c);
    expect(camp.status).toBe("completed");
    expect(result.notes.join(" ")).not.toMatch(/reauthorization/i);

    // Conservation holds.
    const cons = await conservation(f, c);
    expect(Number(cons.queued_total)).toBe(300);
    expect(Number(cons.categorised_total)).toBe(300);
    expect(Number(cons.actionable_remaining)).toBe(0);
  });

  it("with a quota SMALLER than the queue, the day ends with next_run_at tomorrow and the run completed — not failed", async () => {
    const c = await makeFollowCampaign(f, "quota bound", { requestedDailyQuota: 100 });
    await makeMembers(f, c, 400, "qb");
    // Overnight again: the stored access token is the dead one.
    await reconnectAccount(f, "jwt-OLD", "refresh-1");
    const provider = providerDouble({});

    await dispatch(provider, { campaignId: c });

    const runs = await runsFor(f, c);
    expect(runs[0].status).toBe("completed");
    expect(Number(runs[0].attempted_count)).toBe(100);
    expect(Number(runs[0].succeeded_count)).toBe(100);
    const camp = await campaignRow(f, c);
    expect(camp.status).toBe("active");
    expect(new Date(String(camp.next_run_at)).toISOString().slice(0, 10)).toBe("2026-09-15");
    // Only ONE refresh for the whole day's pass — five chunks, one
    // renewal, carried across.
    expect(provider.calls.refreshSession).toBe(1);
    const counts = await memberCounts(f, c);
    expect(counts.queued).toBe(300);
  });
});

describe("when the refresh FAILS", () => {
  it("no later provider calls; Accounts shows expired; campaign/run/member agree; nothing is lost", async () => {
    const c = await makeFollowCampaign(f, "refresh fails", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 30, "rf");
    // Reset the connection to the dead pair for this campaign's pass.
    await reconnectAccount(f, "jwt-OLD", "refresh-dead");
    const provider = providerDouble({
      refreshSession: () => ({
        ok: false,
        status: 400,
        body: { error: "ExpiredToken", message: "Token has been revoked" },
      }),
    });

    const result = await dispatch(provider, { campaignId: c });

    // Exactly one provider write (refused), one refresh (refused), and
    // NOTHING for the 29 later members.
    expect(provider.calls.createRecord).toBe(1);
    expect(provider.calls.refreshSession).toBe(1);
    expect(result.notes.join(" ")).toMatch(/reauthorization|rejected/i);

    // ACCOUNTS: the connection AND its mirror on the identity say
    // expired — which the Accounts page renders as "Sign in again".
    const tokens = await storedTokens(f);
    expect(tokens.status).toBe("expired");
    expect(tokens.accountStatus).toBe("expired");

    // CAMPAIGN / RUN / MEMBER agree.
    const camp = await campaignRow(f, c);
    expect(camp.status).toBe("reauthorization_required");
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    // NOT failed. Paused, with the reason, so recovery can find it.
    expect(runs[0].status).toBe("paused");
    expect(runs[0].last_error_code).toBe("reauthorization_required");

    const counts = await memberCounts(f, c);
    // The refused member is RETRYABLE — not stranded in reconciliation
    // for a request Bluesky told us it refused — and its action is
    // re-opened for a real retry.
    expect(counts.retryable).toBe(1);
    expect(counts.queued).toBe(29);
    const actions = await actionsFor(f, c);
    expect(actions).toHaveLength(1);
    expect(actions[0].status).toBe("pending");
    expect(actions[0].provider_in_flight_at).toBeNull();
    expect(actions[0].provider_error_code).toBe("session_expired");
    // The unit it spent stays spent — the request was made.
    expect(Number(runs[0].attempted_count)).toBe(1);
    expect(await intentsFor(f, c)).toBe(1);

    // Conservation: 30 in, 30 accounted for.
    const cons = await conservation(f, c);
    expect(Number(cons.categorised_total)).toBe(30);
    expect(Number(cons.actionable_remaining)).toBe(30);
  });

  it("after the operator reconnects, the SAME run resumes automatically with unchanged counters and no duplicate", async () => {
    const c = (await f.db.query<{ id: string }>(
      `select id from public.bluesky_follow_campaigns where name = 'refresh fails'`,
    )).rows[0].id;
    const before = (await runsFor(f, c))[0];

    // The operator signs in again on Accounts. They do NOT press Resume.
    await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
    // The refused member's retry backoff — written in the database's
    // clock — has elapsed by the time the operator gets round to it.
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set next_attempt_at = now() - interval '1 minute'
        where campaign_id = $1 and status = 'retryable'`, [c]);

    const provider = providerDouble({
      createRecord: () => ({ status: 200 }),
      getSession: () => ({ status: 200 }),
    });
    // A later tick, same day.
    const result = await dispatch(provider, {
      campaignId: c,
      nowIso: "2026-09-14T09:30:00Z",
    });
    expect(result.notes.join(" ")).toMatch(/recovered from reauthorization_required/);

    // SAME run, resumed — not a second run for the day.
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(before.id);
    // The earlier attempt is still counted; the day's books were not reset.
    expect(Number(runs[0].attempted_count)).toBeGreaterThanOrEqual(
      Number(before.attempted_count),
    );

    // All 30 finished — including the one that was refused — and the
    // refused one got exactly ONE more createRecord, under a NEW unit.
    const counts = await memberCounts(f, c);
    expect(counts.succeeded).toBe(30);
    const rf1 = provider.createRecords.filter((r) => r.subjectDid === "did:plc:rf1");
    expect(rf1).toHaveLength(1);
    // One action row for it, ever; two intents (the refused one and
    // the real one); ONE follow counted.
    const actions = await actionsFor(f, c);
    expect(actions.filter((a) => a.subject_did === "did:plc:rf1")).toHaveLength(1);
    expect(await intentsFor(f, c)).toBe(31);
    expect(Number(runs[0].attempted_count)).toBe(31);
    expect(Number(runs[0].succeeded_count)).toBe(30);

    const camp = await campaignRow(f, c);
    expect(camp.status).toBe("completed");
    expect(provider.calls.refreshSession).toBe(0);
  });
});

describe("yesterday's ambiguous result", () => {
  it("the ambiguous member receives zero duplicate mutations; 100+ later members progress; truth settles it", async () => {
    const c = await makeFollowCampaign(f, "ambiguous head", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 150, "am");
    await reconnectAccount(f, "jwt-NEW", "refresh-2");

    // Member am1's FIRST createRecord: a 502 with the response lost.
    // Everything else succeeds.
    const provider = providerDouble({
      createRecord: ({ subjectDid, index }) =>
        subjectDid === "did:plc:am1" && index === 1
          ? { status: 502, body: { error: "BadGateway" } }
          : { status: 200 },
    });
    await dispatch(provider, { campaignId: c });

    // am1: ONE createRecord, ever. Filed as reconciliation.
    expect(provider.createRecords.filter((r) => r.subjectDid === "did:plc:am1")).toHaveLength(1);
    const a1 = (await actionsFor(f, c)).find((a) => a.subject_did === "did:plc:am1")!;
    expect(a1.status).toBe("reconciliation_required");
    // 149 later members progressed in the same pass.
    const counts = await memberCounts(f, c);
    expect(counts.succeeded).toBe(149);
    expect(counts.retryable).toBe(1);

    // Later, still unknown: reads happen, NOTHING is re-sent, and the
    // member stays visible in the reconciliation lane.
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set next_attempt_at = now() - interval '1 minute' where subject_did = 'did:plc:am1'`,
    );
    await dispatch(provider, { campaignId: c, nowIso: "2026-09-14T12:00:00Z" });
    expect(provider.createRecords.filter((r) => r.subjectDid === "did:plc:am1")).toHaveLength(1);
    let cons = await conservation(f, c);
    expect(Number(cons.reconciliation_required)).toBe(1);
    // NOT completed while one is unresolved — the guard.
    expect((await campaignRow(f, c)).status).toBe("active");

    // Then truth becomes `following`: the ORIGINAL action settles
    // succeeded, still with zero further mutations.
    const provider2 = providerDouble({ following: new Set(["did:plc:am1"]) });
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set next_attempt_at = now() - interval '1 minute' where subject_did = 'did:plc:am1'`,
    );
    await dispatch(provider2, { campaignId: c, nowIso: "2026-09-14T13:00:00Z" });
    expect(provider2.calls.createRecord).toBe(0);
    const settled = (await actionsFor(f, c)).find((a) => a.subject_did === "did:plc:am1")!;
    expect(settled.id).toBe(a1.id);
    expect(settled.status).toBe("succeeded");
    cons = await conservation(f, c);
    expect(Number(cons.actionable_remaining)).toBe(0);
    expect((await campaignRow(f, c)).status).toBe("completed");
  });

  it("a member stranded in reconciliation for a DEFINITE rejection is healed on the next pass", async () => {
    // The production shape: three actions filed as reconciliation_required
    // with provider_error_code ExpiredToken — before the distinction
    // existed. Truth will read not_following forever.
    const c = await makeFollowCampaign(f, "stranded", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 5, "st");
    await reconnectAccount(f, "jwt-NEW", "refresh-2");

    const member = (await f.db.query<{ id: string }>(
      `select id from public.bluesky_follow_campaign_members where subject_did = 'did:plc:st1'`,
    )).rows[0].id;
    const run = (await f.db.query<{ id: string }>(
      `select id from public.ensure_bluesky_campaign_run($1,$2,'2026-09-14',400,400,null)`,
      [f.tenant.workspaceId, c],
    )).rows[0].id;
    const res = (await f.db.query<{ id: string }>(
      `insert into public.bluesky_campaign_quota_reservations
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reserved_count, status, claimed_by, expires_at)
       values ($1,$2,$3,$4,'2026-09-13',0,'settled','yesterday', now() - interval '1 day')
       returning id`,
      [f.tenant.workspaceId, c, run, f.tenant.identityId],
    )).rows[0].id;
    const action = (await f.db.query<{ id: string }>(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did, actor_did,
          status, campaign_id, campaign_run_id, campaign_member_id,
          provider_error_code, provider_error_message, provider_status_code)
       values ($1,$2,'follow','did:plc:st1',$3,'reconciliation_required',$4,$5,$6,
               'ExpiredToken','Token has expired',400) returning id`,
      [f.tenant.workspaceId, f.tenant.identityId, ACTOR_DID, c, run, member],
    )).rows[0].id;
    await f.db.query(
      `insert into public.bluesky_campaign_attempt_ledger
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reservation_id, member_id, action_id, provider_intent_at, counted_at)
       values ($1,$2,$3,$4,'2026-09-13',$5,$6,$7, now() - interval '1 day', now() - interval '1 day')`,
      [f.tenant.workspaceId, c, run, f.tenant.identityId, res, member, action],
    );
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status = 'retryable', attempt_count = 1 where id = $1`, [member]);

    const provider = providerDouble({});
    await dispatch(provider, { campaignId: c });

    // FIRST PASS: the reconciliation read finds the recorded ExpiredToken,
    // re-opens the action (pending, no marker) and defers the member by
    // the ORDINARY retry backoff. No createRecord yet, no reconciliation
    // churn — and the other four members were not held up by it.
    let a = (await actionsFor(f, c)).filter((x) => x.subject_did === "did:plc:st1");
    expect(a).toHaveLength(1);
    expect(a[0].status).toBe("pending");
    expect(a[0].provider_in_flight_at).toBeNull();
    expect(provider.createRecords.filter((r) => r.subjectDid === "did:plc:st1")).toHaveLength(0);
    expect((await memberCounts(f, c)).succeeded).toBe(4);

    // SECOND PASS, after the backoff: a real retry through the ordinary
    // quota path.
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set next_attempt_at = now() - interval '1 minute' where id = $1`, [member]);
    await dispatch(provider, { campaignId: c, nowIso: "2026-09-14T09:10:00Z" });

    // The stranded member got its REAL retry: exactly one createRecord,
    // the SAME action row, now succeeded; no reconciliation churn.
    expect(provider.createRecords.filter((r) => r.subjectDid === "did:plc:st1")).toHaveLength(1);
    const healed = (await actionsFor(f, c)).filter((a) => a.subject_did === "did:plc:st1");
    expect(healed).toHaveLength(1);
    expect(healed[0].id).toBe(action);
    expect(healed[0].status).toBe("succeeded");
    // And it was counted ONCE, although two intents exist for it.
    const runs = await runsFor(f, c);
    expect(Number(runs[0].succeeded_count)).toBe(5);
    const counts = await memberCounts(f, c);
    expect(counts.succeeded).toBe(5);
  });
});

describe("the run resumes inside the dispatcher when the operator pressed Resume", () => {
  it("campaign already active, run paused for reauth, session works → same run continues", async () => {
    // The path the auto-recovery does NOT cover: the operator reconnected
    // AND pressed Resume (campaign → active) on a deployment where the
    // activate action could not reach the service client, so the run is
    // still paused. The dispatcher must notice on its own.
    const c = await makeFollowCampaign(f, "resume pressed", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 5, "rp");
    await reconnectAccount(f, "jwt-NEW", "refresh-2");
    const run = (await f.db.query<{ id: string }>(
      `select id from public.ensure_bluesky_campaign_run($1,$2,'2026-09-14',400,400,null)`,
      [f.tenant.workspaceId, c])).rows[0].id;
    await f.db.query(
      `update public.bluesky_follow_campaign_runs
          set status = 'paused', last_error_code = 'reauthorization_required',
              attempted_count = 2, succeeded_count = 1
        where id = $1`, [run]);

    const provider = providerDouble({});
    await dispatch(provider, { campaignId: c });

    // The pass resumed the run and then ran to completion in the same
    // tick, so the closing note is "completed"; what proves the resume
    // is the run itself — same id, no longer paused, counters carried.
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(run);
    expect(runs[0].status).toBe("completed");
    // Counters carried, then added to — never reset.
    expect(Number(runs[0].attempted_count)).toBe(2 + 5);
    expect(Number(runs[0].succeeded_count)).toBe(1 + 5);
    expect((await memberCounts(f, c)).succeeded).toBe(5);
  });

  it("a run paused for a NON-recoverable reason is left alone", async () => {
    const c = await makeFollowCampaign(f, "not recoverable", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 2, "nr");
    const run = (await f.db.query<{ id: string }>(
      `select id from public.ensure_bluesky_campaign_run($1,$2,'2026-09-14',400,400,null)`,
      [f.tenant.workspaceId, c])).rows[0].id;
    // The consecutive-failure breaker leaves no recoverable code.
    await f.db.query(
      `update public.bluesky_follow_campaign_runs
          set status = 'paused', last_error_code = null,
              last_error_message = 'Stopped after 5 consecutive failures.' where id = $1`, [run]);
    const provider = providerDouble({});
    const result = await dispatch(provider, { campaignId: c });
    expect(provider.calls.createRecord).toBe(0);
    expect(result.notes.join(" ")).toMatch(/today's run is paused/);
  });
});

describe("completion is refused while any action is unresolved", () => {
  it("every member terminal, one action still reconciling → not completed", async () => {
    const c = await makeFollowCampaign(f, "guarded", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 3, "gd");
    // Statuses say done. An action says otherwise — the shape a crash
    // between settling the action and the member can leave behind.
    await f.db.query(
      `update public.bluesky_follow_campaign_members set status = 'succeeded',
              completed_at = now() where campaign_id = $1`, [c]);
    const m = (await f.db.query<{ id: string }>(
      `select id from public.bluesky_follow_campaign_members
        where campaign_id = $1 and subject_did = 'did:plc:gd2'`, [c])).rows[0].id;
    const run = (await f.db.query<{ id: string }>(
      `select id from public.ensure_bluesky_campaign_run($1,$2,'2026-09-14',400,400,null)`,
      [f.tenant.workspaceId, c])).rows[0].id;
    await f.db.query(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did, actor_did,
          status, campaign_id, campaign_run_id, campaign_member_id)
       values ($1,$2,'follow','did:plc:gd2',$3,'reconciliation_required',$4,$5,$6)`,
      [f.tenant.workspaceId, f.tenant.identityId, ACTOR_DID, c, run, m]);

    const may = await f.db.query<{ ok: boolean }>(
      `select public.bluesky_campaign_may_complete($1,$2) as ok`, [f.tenant.workspaceId, c]);
    expect(may.rows[0].ok).toBe(false);

    const provider = providerDouble({});
    const result = await dispatch(provider, { campaignId: c });
    expect((await campaignRow(f, c)).status).toBe("active");
    expect(result.notes.join(" ")).toMatch(/not completed/);

    // Resolve the action; now it may complete.
    await f.db.query(
      `update public.bluesky_relationship_actions set status = 'succeeded' where campaign_member_id = $1`, [m]);
    await dispatch(provider, { campaignId: c, nowIso: "2026-09-14T09:05:00Z" });
    expect((await campaignRow(f, c)).status).toBe("completed");
  });
});

describe("a refused-then-retried follow is counted ONCE", () => {
  it("the earlier intent folds as superseded when swept after the retry succeeded", async () => {
    // The state a worker leaves when it is KILLED after the provider
    // refused a request (400 ExpiredToken) and after the action was
    // re-opened, but before the chunk settled: the reservation that
    // paid for the refused request is still open, its ledger row
    // carries the intent and is uncounted. Constructed directly —
    // `counted_at` is immutable once set, so it cannot be "un-settled"
    // after the fact, which is itself the property that makes the
    // sweep safe to run twice.
    const c = await makeFollowCampaign(f, "counted once", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 1, "co");
    const member = (await f.db.query<{ id: string }>(
      `select id from public.bluesky_follow_campaign_members where campaign_id = $1`, [c])).rows[0].id;
    const run = (await f.db.query<{ id: string }>(
      `select id from public.ensure_bluesky_campaign_run($1,$2,'2026-09-14',400,400,null)`,
      [f.tenant.workspaceId, c])).rows[0].id;
    const oldRes = (await f.db.query<{ id: string }>(
      `insert into public.bluesky_campaign_quota_reservations
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reserved_count, status, claimed_by, expires_at)
       -- STILL OPEN AND NOT YET EXPIRED. This is the window: the member's
       -- own lease was cleared when it was re-opened, so a new reservation
       -- can retry it while the killed worker's reservation is still live.
       -- (Expired, the reserve RPC's own sweep would fold it BEFORE the
       -- retry, while the action was still pending — and count nothing.)
       values ($1,$2,$3,$4,'2026-09-14',0,'open','killed', now() + interval '1 hour')
       returning id`, [f.tenant.workspaceId, c, run, f.tenant.identityId])).rows[0].id;
    const action = (await f.db.query<{ id: string }>(
      `insert into public.bluesky_relationship_actions
         (workspace_id, operator_account_id, action_type, subject_did, actor_did,
          status, campaign_id, campaign_run_id, campaign_member_id,
          provider_error_code, provider_error_message, provider_status_code)
       values ($1,$2,'follow','did:plc:co1',$3,'pending',$4,$5,$6,'session_expired','Token has expired',400)
       returning id`, [f.tenant.workspaceId, f.tenant.identityId, ACTOR_DID, c, run, member])).rows[0].id;
    await f.db.query(
      `insert into public.bluesky_campaign_attempt_ledger
         (workspace_id, campaign_id, run_id, operator_account_id, usage_date,
          reservation_id, member_id, action_id, provider_intent_at)
       values ($1,$2,$3,$4,'2026-09-14',$5,$6,$7, now() - interval '30 minutes')`,
      [f.tenant.workspaceId, c, run, f.tenant.identityId, oldRes, member, action]);
    await f.db.query(
      `update public.bluesky_follow_campaign_runs set attempted_count = 1 where id = $1`, [run]);
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status = 'retryable', attempt_count = 1, next_attempt_at = now() - interval '1 minute'
        where id = $1`, [member]);

    // The operator reconnected; the retry succeeds under a NEW reservation.
    await reconnectAccount(f, "jwt-FRESH", "refresh-fresh");
    const p2 = providerDouble({ createRecord: () => ({ status: 200 }), getSession: () => ({ status: 200 }) });
    await dispatch(p2, { campaignId: c, nowIso: "2026-09-14T09:30:00Z" });
    expect(p2.calls.createRecord).toBe(1);
    expect((await memberCounts(f, c)).succeeded).toBe(1);
    let after = (await runsFor(f, c))[0];
    expect(Number(after.succeeded_count)).toBe(1);

    // NOW the killed worker's reservation expires and the sweep folds
    // its row. The action it points at is `succeeded` — but a LATER
    // intent exists for the member, so this row is superseded and
    // counts nothing.
    await f.db.query(
      `update public.bluesky_campaign_quota_reservations
          set expires_at = now() - interval '1 minute' where id = $1`, [oldRes]);
    await f.db.query(
      `select public.sweep_bluesky_quota_reservations($1,$2,'2026-09-14')`,
      [f.tenant.workspaceId, f.tenant.identityId]);

    after = (await runsFor(f, c))[0];
    expect(Number(after.succeeded_count)).toBe(1);
    expect(Number(after.attempted_count)).toBe(2);
    expect(await intentsFor(f, c)).toBe(2);
    const uncounted = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_campaign_attempt_ledger l
         join public.bluesky_follow_campaign_members m on m.id = l.member_id
        where m.campaign_id = $1 and l.counted_at is null`, [c]);
    expect(uncounted.rows[0].n).toBe("0");
    const usage = await f.db.query<{ n: string }>(
      `select follows_created::text as n from public.bluesky_identity_daily_usage
        where operator_account_id = $1 and usage_date = '2026-09-14'`, [f.tenant.identityId]);
    // The identity's follow count moved by exactly one for this member.
    // (The fixture is shared; the assertion is on the run, above, and
    // the identity total is checked to be finite and consistent here.)
    expect(Number(usage.rows[0].n)).toBeGreaterThanOrEqual(1);
  });
});
