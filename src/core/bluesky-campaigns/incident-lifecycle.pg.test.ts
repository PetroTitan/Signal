import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
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
  type FollowFixture,
} from "./test-support/pg-harness";
import { dispatchCampaigns } from "./dispatcher.server";

/**
 * The run lifecycle after the incident fix, against the shipped
 * migrations: rate limits, per-member transport failures, crashes on
 * either side of provider intent, the execution window and the local
 * day, and the conservation equation throughout.
 */

let f: FollowFixture;

beforeAll(async () => {
  f = await createFollowFixture("lifecycle");
  await reconnectAccount(f, "jwt-NEW", "refresh-2");
}, 180_000);
afterAll(async () => { await f?.close(); });

const dispatch = (
  provider: ReturnType<typeof providerDouble>,
  over: Record<string, unknown> = {},
) =>
  dispatchCampaigns({
    nowIso: "2026-09-14T09:00:00Z",
    db: f.client,
    fetchImpl: provider.fetchImpl,
    sleep: async () => undefined,
    interRequestMs: 0,
    ...over,
  });

const elapseBackoffs = (campaignId: string) =>
  f.db.query(
    `update public.bluesky_follow_campaign_members
        set next_attempt_at = now() - interval '1 minute'
      where campaign_id = $1 and status = 'retryable'`, [campaignId]);

describe("429", () => {
  it("stops new mutations, persists the reset, resumes the SAME run no earlier than reset", async () => {
    const c = await makeFollowCampaign(f, "rate limited", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 30, "rl");
    const resetAt = Math.floor(Date.parse("2026-09-14T09:00:00Z") / 1000) + 1800;
    const limited = providerDouble({
      createRecord: ({ index }) =>
        index === 5
          ? {
              status: 429,
              body: { error: "RateLimitExceeded" },
              headers: { "ratelimit-reset": String(resetAt) },
            }
          : { status: 200 },
    });

    await dispatch(limited, { campaignId: c });

    // Five requests: four follows and the refused one. NOT one per
    // remaining member.
    expect(limited.calls.createRecord).toBe(5);
    const runs = await runsFor(f, c);
    expect(runs[0].status).toBe("rate_limited");
    expect(new Date(String(runs[0].rate_limited_until)).getTime()).toBe(resetAt * 1000);
    // The FOLLOW campaign stays `active` with the reset recorded on it —
    // the deployed, tested behaviour — and is not due again before it.
    const camp = await campaignRow(f, c);
    expect(camp.status).toBe("active");
    expect(new Date(String(camp.rate_limited_until)).getTime()).toBe(resetAt * 1000);
    expect(new Date(String(camp.next_run_at)).getTime()).toBeGreaterThanOrEqual(resetAt * 1000);

    // The refused member is RETRYABLE with a re-opened action — the
    // provider refused it before writing — not stranded in reconciliation.
    const refused = (await actionsFor(f, c)).find((a) => a.subject_did === "did:plc:rl5")!;
    expect(refused.status).toBe("pending");
    expect(refused.provider_in_flight_at).toBeNull();

    // Before the reset, on the APP clock: a tick does nothing.
    const early = providerDouble({});
    await dispatch(early, { campaignId: c, nowIso: "2026-09-14T09:10:00Z" });
    expect(early.calls.createRecord).toBe(0);

    // Before the reset, on the DATABASE clock. `resume_bluesky_campaign_
    // run` compares the stored reset with now() — the database's clock,
    // not the app's — so this control puts the stored reset ahead of
    // the real clock while the app's clock is past it. The RPC must
    // refuse and the run must stay rate_limited. (Without this control
    // the resume below would prove nothing about the guard: the fixed
    // reset epoch is in the real past, so now() passes it on any day
    // this test is run.)
    await f.db.query(
      `update public.bluesky_follow_campaign_runs
          set rate_limited_until = now() + interval '1 hour'
        where id = $1`, [runs[0].id]);
    const dbEarly = providerDouble({});
    await dispatch(dbEarly, {
      campaignId: c,
      nowIso: new Date(resetAt * 1000 + 5 * 60_000).toISOString(),
    });
    expect(dbEarly.calls.createRecord).toBe(0);
    expect((await runsFor(f, c))[0].status).toBe("rate_limited");
    // Restore the provider's reset — past on both clocks from here on.
    await f.db.query(
      `update public.bluesky_follow_campaign_runs
          set rate_limited_until = to_timestamp($2)
        where id = $1`, [runs[0].id, resetAt]);

    // At the reset: the SAME run resumes and finishes, rl5 included,
    // with exactly one more request for it.
    await elapseBackoffs(c);
    const later = providerDouble({});
    // Five minutes past the reset: the campaign's next_run_at carries a
    // small scheduling buffer beyond the reset itself.
    await dispatch(later, {
      campaignId: c,
      nowIso: new Date(resetAt * 1000 + 5 * 60_000).toISOString(),
    });
    const after = await runsFor(f, c);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(runs[0].id);
    expect((await memberCounts(f, c)).succeeded).toBe(30);
    expect(later.createRecords.filter((r) => r.subjectDid === "did:plc:rl5")).toHaveLength(1);
    expect((await campaignRow(f, c)).status).toBe("completed");
  });
});

describe("a transport failure on ONE member", () => {
  it("gets a bounded backoff; every other member continues; no campaign-wide abort", async () => {
    const c = await makeFollowCampaign(f, "one 502", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 60, "tf");
    const provider = providerDouble({
      createRecord: ({ subjectDid }) =>
        subjectDid === "did:plc:tf7"
          ? { status: 502, body: { error: "BadGateway" } }
          : { status: 200 },
    });

    await dispatch(provider, { campaignId: c });

    const counts = await memberCounts(f, c);
    expect(counts.succeeded).toBe(59);
    expect(counts.retryable).toBe(1);
    expect((await campaignRow(f, c)).status).toBe("active");
    expect((await runsFor(f, c))[0].status).not.toBe("failed");

    // A 502 is AMBIGUOUS — the write may have committed — so it is
    // reconciliation, never a blind retry. One request, ever.
    expect(provider.createRecords.filter((r) => r.subjectDid === "did:plc:tf7")).toHaveLength(1);
    const a = (await actionsFor(f, c)).find((x) => x.subject_did === "did:plc:tf7")!;
    expect(a.status).toBe("reconciliation_required");

    // Its backoff is durable and in the FUTURE, in the database's clock.
    const m = await f.db.query<{ next_attempt_at: string }>(
      `select next_attempt_at from public.bluesky_follow_campaign_members
        where subject_did = 'did:plc:tf7'`);
    expect(new Date(m.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("a member that keeps failing moves to the slow lane, never to failed_structural, never tight", async () => {
    const c = await makeFollowCampaign(f, "slow lane", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 3, "sl");
    const provider = providerDouble({
      createRecord: ({ subjectDid }) =>
        subjectDid === "did:plc:sl1"
          ? { status: 502, body: { error: "BadGateway" } }
          : { status: 200 },
    });
    await dispatch(provider, { campaignId: c });

    // Thirteen reconciliation reads, each finding nothing. The clock
    // moves FORWARD each time: the previous pass schedules the next
    // one, and a tick before that moment correctly does nothing.
    for (let i = 0; i < 13; i += 1) {
      await elapseBackoffs(c);
      await dispatch(provider, {
        campaignId: c,
        nowIso: new Date(Date.parse("2026-09-14T09:00:00Z") + (i + 1) * 3600_000).toISOString(),
      });
    }
    // Still ONE request, ever. Still retryable. Still visible.
    expect(provider.createRecords.filter((r) => r.subjectDid === "did:plc:sl1")).toHaveLength(1);
    const counts = await memberCounts(f, c);
    expect(counts.retryable).toBe(1);
    expect(counts.failed_structural ?? 0).toBe(0);
    const m = await f.db.query<{ reconcile_count: number; next_attempt_at: string }>(
      `select reconcile_count, next_attempt_at from public.bluesky_follow_campaign_members
        where subject_did = 'did:plc:sl1'`);
    expect(Number(m.rows[0].reconcile_count)).toBeGreaterThanOrEqual(12);
    // The slow lane: six hours out, not ten minutes.
    expect(new Date(m.rows[0].next_attempt_at).getTime() - Date.now()).toBeGreaterThan(5 * 3600_000);
    // And the campaign is NOT completed while it is outstanding.
    expect((await campaignRow(f, c)).status).toBe("active");
  });
});

describe("crashes", () => {
  it("BEFORE provider intent: the next worker sends exactly ONE first createRecord", async () => {
    const c = await makeFollowCampaign(f, "crash before", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 1, "cb");
    // A worker reserved and claimed, then died before consuming.
    await f.db.query(
      `select * from public.ensure_bluesky_campaign_run($1,$2,'2026-09-14',400,400,null)`,
      [f.tenant.workspaceId, c]);
    const run = (await runsFor(f, c))[0];
    await f.db.query(
      `select * from public.reserve_bluesky_campaign_quota($1,$2,$3,$4,'2026-09-14',400,1000,20,300,'dead')`,
      [f.tenant.workspaceId, c, run.id, f.tenant.identityId]);
    expect(await intentsFor(f, c)).toBe(0);
    await f.db.query(
      `update public.bluesky_follow_campaign_members set lease_expires_at = now() - interval '1 hour'
        where campaign_id = $1`, [c]);
    await f.db.query(
      `update public.bluesky_campaign_quota_reservations set expires_at = now() - interval '1 hour'
        where campaign_id = $1`, [c]);

    const provider = providerDouble({});
    await dispatch(provider, { campaignId: c });
    expect(provider.calls.createRecord).toBe(1);
    expect((await memberCounts(f, c)).succeeded).toBe(1);
    expect(await intentsFor(f, c)).toBe(1);
  });

  it("AFTER provider intent: the next worker sends ZERO createRecords and reconciles", async () => {
    const c = await makeFollowCampaign(f, "crash after", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 1, "ca");
    // The provider never answered; the worker was killed with the
    // marker up.
    const hang = providerDouble({
      createRecord: () => { throw new Error("socket closed"); },
    });
    await dispatch(hang, { campaignId: c });
    expect(hang.calls.createRecord).toBe(1);
    expect(await intentsFor(f, c)).toBe(1);
    // A kill leaves the marker up and the lease held. Reproduce it.
    await f.db.query(
      `update public.bluesky_relationship_actions
          set status = 'running', provider_in_flight_at = now(), finished_at = null
        where campaign_id = $1`, [c]);
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status = 'claimed', claimed_by = 'dead', claimed_at = now(),
              lease_expires_at = now() - interval '1 hour', next_attempt_at = null
        where campaign_id = $1`, [c]);

    const next = providerDouble({});
    await dispatch(next, { campaignId: c, nowIso: "2026-09-14T09:10:00Z" });
    expect(next.calls.createRecord).toBe(0);
    expect(next.calls.getRelationships).toBeGreaterThan(0);
    const a = (await actionsFor(f, c))[0];
    expect(a.status).toBe("reconciliation_required");
    expect(a.provider_in_flight_at).toBeNull();
    expect(await intentsFor(f, c)).toBe(1);
  });
});

describe("the execution window and the local day", () => {
  it("outside the window nothing runs; inside it the run is keyed on the LOCAL date", async () => {
    const c = await makeFollowCampaign(f, "window", {
      requestedDailyQuota: 400,
      timezone: "Europe/Berlin",
      windowStart: 9 * 60,
      windowEnd: 20 * 60,
    });
    await makeMembers(f, c, 2, "wd");

    // 06:59 UTC = 08:59 Berlin: before the window.
    const early = providerDouble({});
    await dispatch(early, { campaignId: c, nowIso: "2026-09-14T06:59:00Z" });
    expect(early.calls.createRecord).toBe(0);
    expect(await runsFor(f, c)).toHaveLength(0);

    // 07:05 UTC = 09:05 Berlin: inside the window, past the scheduling
    // buffer the out-of-window tick set. The run is for LOCAL 2026-09-14.
    // wd2's write is ambiguous, so the campaign has work left tomorrow.
    const inWindow = providerDouble({
      createRecord: ({ subjectDid }) =>
        subjectDid === "did:plc:wd2" ? { status: 502, body: {} } : { status: 200 },
    });
    await dispatch(inWindow, { campaignId: c, nowIso: "2026-09-14T07:05:00Z" });
    const runs = await runsFor(f, c);
    expect(runs).toHaveLength(1);
    // `local_date` arrives as a Date at UTC midnight; read it as ISO.
    expect(new Date(String(runs[0].local_date)).toISOString().slice(0, 10)).toBe("2026-09-14");
    expect((await campaignRow(f, c)).status).toBe("active");

    // The next local day: a NEW run for it — same campaign, same queue,
    // and the unresolved member from yesterday carried into it.
    await elapseBackoffs(c);
    const nextDay = providerDouble({ following: new Set(["did:plc:wd2"]) });
    await dispatch(nextDay, { campaignId: c, nowIso: "2026-09-15T08:00:00Z" });
    const runs2 = await runsFor(f, c);
    expect(runs2).toHaveLength(2);
    expect(nextDay.calls.createRecord).toBe(0);
    expect((await memberCounts(f, c)).already_following).toBe(1);
  });
});

describe("conservation", () => {
  it("every member is in exactly one category, and completion waits for zero actionable", async () => {
    const c = await makeFollowCampaign(f, "conservation", { requestedDailyQuota: 400 });
    await makeMembers(f, c, 40, "cv");
    const provider = providerDouble({
      following: new Set(["did:plc:cv1", "did:plc:cv2"]),
      createRecord: ({ subjectDid }) => {
        if (subjectDid === "did:plc:cv3") return { status: 400, body: { error: "InvalidRequest", message: "Profile not found" } };
        if (subjectDid === "did:plc:cv4") return { status: 502, body: {} };
        if (subjectDid === "did:plc:cv5") return { status: 400, body: { error: "InvalidRequest", message: "bad record" } };
        return { status: 200 };
      },
    });
    await dispatch(provider, { campaignId: c });

    const cons = await conservation(f, c);
    const n = (k: string) => Number(cons[k]);
    expect(n("queued_total")).toBe(40);
    expect(n("categorised_total")).toBe(40);
    expect(
      n("pending") + n("running") + n("retryable") + n("reconciliation_required") +
      n("succeeded") + n("already_following") + n("protected") + n("actor_not_found") +
      n("blocked") + n("invalid") + n("failed_structural") + n("cancelled"),
    ).toBe(40);
    expect(n("already_following")).toBe(2);
    expect(n("actor_not_found")).toBe(1);
    expect(n("reconciliation_required")).toBe(1);
    expect(n("failed_structural")).toBe(1);
    expect(n("succeeded")).toBe(35);
    expect(n("actionable_remaining")).toBe(1);
    // Not completed while cv4 is unresolved.
    expect((await campaignRow(f, c)).status).toBe("active");

    // The denominator never shrinks.
    expect(n("queued_total")).toBe(40);
  });
});
