import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import {
  ACTOR_DID,
  createUnfollowFixture,
  makeMembers,
  makeUnfollowCampaign,
  mockSession,
  providerDouble,
  type UnfollowFixture,
} from "./test-support/harness";

vi.mock("@/core/bluesky-relationships/session.server", () => mockSession());

import { dispatchUnfollowCampaigns } from "./dispatcher.server";
import { dispatchCampaigns } from "@/core/bluesky-campaigns/dispatcher.server";

/**
 * The dispatcher, against the REAL migration.
 *
 * Its whole contract is: be safe to re-enter. Vercel Cron is
 * at-least-once, deploys land mid-pass, and the platform can deliver
 * twice or not at all. None of that is defended in the dispatcher — it
 * is defended in the database — so these tests drive the dispatcher
 * repeatedly and count what reached the provider.
 */

let f: UnfollowFixture;
const NOW = "2026-09-14T12:00:00Z";
const TODAY = "2026-09-14";

beforeAll(async () => {
  f = await createUnfollowFixture("dispatcher");
}, 180_000);
afterAll(async () => { await f?.close(); });

const dispatch = (
  provider: ReturnType<typeof providerDouble>,
  over: Record<string, unknown> = {},
) =>
  dispatchUnfollowCampaigns({
    nowIso: NOW,
    db: f.client,
    fetchImpl: provider.fetchImpl,
    sleep: async () => undefined,
    interRequestMs: 0,
    ...over,
  });

const following = (dids: string[]) =>
  Object.fromEntries(
    dids.map((d, i) => [
      d,
      { following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-${i + 1}` },
    ]),
  );

async function campaignWith(name: string, dids: string[], opts = {}) {
  const c = await makeUnfollowCampaign(f, name, opts);
  await makeMembers(
    f,
    c,
    dids.map((did, i) => ({ did, sequence: i + 1 })),
  );
  return c;
}

const campaignRow = async (id: string) =>
  (await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaigns where id = $1`, [id],
  )).rows[0];

const runsFor = async (id: string) =>
  (await f.db.query<Record<string, unknown>>(
    `select * from public.bluesky_follow_campaign_runs
      where campaign_id = $1 order by local_date`, [id],
  )).rows;

// =====================================================================

describe("the FOLLOW dispatcher never sees an unfollow campaign", () => {
  it("dispatchCampaigns considers zero of them, and creates no follow", async () => {
    const c = await campaignWith("invisible to follow", ["did:plc:invisible"]);
    const provider = providerDouble({
      relationships: following(["did:plc:invisible"]),
    });

    const result = await dispatchCampaigns({
      nowIso: NOW,
      db: f.client,
      fetchImpl: provider.fetchImpl,
      sleep: async () => undefined,
      interRequestMs: 0,
      campaignId: c,
    });

    expect(result.campaignsConsidered).toBe(0);
    expect(provider.creates).toHaveLength(0);
    expect(provider.deletes).toHaveLength(0);
    // And the campaign was not touched.
    expect((await campaignRow(c)).status).toBe("active");
  });
});

describe("duplicate cron delivery", () => {
  it("two deliveries produce ONE run and ONE delete per member", async () => {
    const dids = ["did:plc:dup1", "did:plc:dup2"];
    const c = await campaignWith("duplicate delivery", dids);
    const provider = providerDouble({ relationships: following(dids) });

    await dispatch(provider, { campaignId: c });
    const afterFirst = provider.deletes.length;
    expect(afterFirst).toBe(2);

    // The platform delivers again.
    await dispatch(provider, { campaignId: c });

    expect(provider.deletes).toHaveLength(afterFirst);
    expect(await runsFor(c)).toHaveLength(1);

    const actions = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_relationship_actions
        where campaign_id = $1`, [c]);
    expect(actions.rows[0].n).toBe("2");
  });

  it("FOUR simultaneous deliveries still delete each member once", async () => {
    const dids = ["did:plc:quad1", "did:plc:quad2", "did:plc:quad3"];
    const c = await campaignWith("quad delivery", dids);
    const provider = providerDouble({ relationships: following(dids) });

    await Promise.all([
      dispatch(provider, { campaignId: c }),
      dispatch(provider, { campaignId: c }),
      dispatch(provider, { campaignId: c }),
      dispatch(provider, { campaignId: c }),
    ]);

    const byRkey = new Map<string, number>();
    for (const d of provider.deletes) {
      byRkey.set(d.rkey, (byRkey.get(d.rkey) ?? 0) + 1);
    }
    for (const [rkey, n] of byRkey) {
      expect(`${rkey}:${n}`).toBe(`${rkey}:1`);
    }
    expect(await runsFor(c)).toHaveLength(1);
  });
});

describe("rate limiting", () => {
  it("stops immediately and resumes NO EARLIER than the provider's reset", async () => {
    const dids = ["did:plc:rl1", "did:plc:rl2", "did:plc:rl3"];
    const c = await campaignWith("rate limited", dids);
    const resetAt = Math.floor(new Date(NOW).getTime() / 1000) + 3600;
    const provider = providerDouble({
      relationships: following(dids),
      defaultDelete: {
        status: 429,
        body: { error: "RateLimitExceeded", message: "slow down" },
        headers: { "ratelimit-reset": String(resetAt) },
      },
    });

    await dispatch(provider, { campaignId: c });

    // ONE request, then stop. Not one per remaining member.
    expect(provider.deletes).toHaveLength(1);

    const camp = await campaignRow(c);
    expect(camp.status).toBe("rate_limited");
    expect(new Date(String(camp.rate_limited_until)).getTime()).toBe(
      resetAt * 1000,
    );
    // And it is not due again before the reset.
    expect(new Date(String(camp.next_run_at)).getTime()).toBeGreaterThanOrEqual(
      resetAt * 1000,
    );
  });

  it("resumes the SAME run later the same day — never a second one", async () => {
    // A second run for the day would double the day's budget.
    const dids = ["did:plc:resume1", "did:plc:resume2"];
    const c = await campaignWith("same-run resume", dids);
    const past = Math.floor(new Date(NOW).getTime() / 1000) - 60;
    const provider1 = providerDouble({
      relationships: following(dids),
      defaultDelete: {
        status: 429,
        body: { error: "RateLimitExceeded" },
        headers: { "ratelimit-reset": String(past) },
      },
    });
    await dispatch(provider1, { campaignId: c });
    expect((await campaignRow(c)).status).toBe("rate_limited");
    const runsAfterLimit = await runsFor(c);
    expect(runsAfterLimit).toHaveLength(1);

    // The campaign stays visible to the scheduler — a status the
    // dispatcher cannot list is a status it cannot leave — and it is
    // scheduled AT OR AFTER the provider's own reset.
    const limited = await campaignRow(c);
    expect(limited.status).toBe("rate_limited");
    expect(
      new Date(String(limited.next_run_at)).getTime(),
    ).toBeGreaterThanOrEqual(past * 1000);

    // It is NOT due at the instant it was limited, so a tick then does
    // nothing — which is the whole point of `next_run_at`.
    const tooSoon = providerDouble({ relationships: following(dids) });
    await dispatch(tooSoon, { campaignId: c });
    expect(tooSoon.deletes).toHaveLength(0);

    // Once its scheduled time arrives, it returns to the SAME run.
    const provider2 = providerDouble({ relationships: following(dids) });
    await dispatch(provider2, {
      campaignId: c,
      nowIso: new Date(
        new Date(String(limited.next_run_at)).getTime() + 60_000,
      ).toISOString(),
    });

    const runs = await runsFor(c);
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(runsAfterLimit[0].id);
    expect((await campaignRow(c)).status).not.toBe("rate_limited");
    expect(provider2.deletes.length).toBeGreaterThan(0);
  });
});

describe("operator control", () => {
  it("AN OPERATOR PAUSE IS NEVER AUTO-RESUMED", async () => {
    const dids = ["did:plc:paused1"];
    const c = await campaignWith("operator paused", dids);
    await f.db.query(
      `update public.bluesky_follow_campaigns
          set status = 'paused', paused_at = now() where id = $1`,
      [c],
    );

    const provider = providerDouble({ relationships: following(dids) });
    // Many deliveries. None of them may restart it.
    for (let i = 0; i < 5; i += 1) await dispatch(provider, { campaignId: c });

    expect(provider.deletes).toHaveLength(0);
    expect((await campaignRow(c)).status).toBe("paused");
  });

  it("a PAUSED RUN is not resumed by the rate-limit path either", async () => {
    // The transition is guarded inside the RPC: only a `rate_limited`
    // run whose reset has elapsed may move. A `paused` run may not,
    // whatever the clock says.
    const dids = ["did:plc:pausedrun"];
    const c = await campaignWith("paused run", dids);
    await f.db.query(
      `insert into public.bluesky_follow_campaign_runs
         (workspace_id, campaign_id, local_date, status,
          requested_daily_quota, effective_daily_quota)
       values ($1,$2,$3,'paused',100,100)`,
      [f.tenant.workspaceId, c, TODAY],
    );
    const provider = providerDouble({ relationships: following(dids) });
    await dispatch(provider, { campaignId: c });

    expect(provider.deletes).toHaveLength(0);
    const runs = await runsFor(c);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("paused");
  });

  it("A CANCELLED CAMPAIGN CREATES NO FUTURE PROVIDER INTENT", async () => {
    const dids = ["did:plc:cancel1", "did:plc:cancel2", "did:plc:cancel3"];
    const c = await campaignWith("cancelled", dids);
    const provider = providerDouble({ relationships: following(dids) });

    const cancelled = await f.db.query<Record<string, number>>(
      `select * from public.cancel_bluesky_campaign_future_work($1,$2)`,
      [f.tenant.workspaceId, c],
    );
    expect(Number(cancelled.rows[0].cancelled_members)).toBe(3);

    for (let i = 0; i < 3; i += 1) await dispatch(provider, { campaignId: c });

    expect(provider.deletes).toHaveLength(0);
    const ledger = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_campaign_attempt_ledger l
         join public.bluesky_follow_campaign_members m on m.id = l.member_id
        where m.campaign_id = $1 and l.provider_intent_at is not null`,
      [c],
    );
    expect(ledger.rows[0].n).toBe("0");
    expect((await campaignRow(c)).status).toBe("cancelled");
  });

  it("cancelling does NOT re-follow anyone and rewrites no history", async () => {
    const dids = ["did:plc:donefirst", "did:plc:notyet"];
    const c = await campaignWith("cancel after progress", dids);
    const provider = providerDouble({
      relationships: following(dids),
    });

    // One member is unfollowed for real.
    await dispatch(provider, { campaignId: c, budgetMs: 1 });
    // Then the operator cancels.
    await f.db.query(
      `select * from public.cancel_bluesky_campaign_future_work($1,$2)`,
      [f.tenant.workspaceId, c],
    );

    const deletesBefore = provider.deletes.length;
    for (let i = 0; i < 2; i += 1) await dispatch(provider, { campaignId: c });

    // No follow was ever created. There is no code path that could.
    expect(provider.creates).toHaveLength(0);
    expect(provider.deletes).toHaveLength(deletesBefore);

    // Completed members keep the state they reached.
    const succeeded = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_follow_campaign_members
        where campaign_id = $1 and status = 'succeeded'`, [c]);
    expect(Number(succeeded.rows[0].n)).toBe(deletesBefore);
  });

  it("a per-identity kill switch stops the campaign before any request", async () => {
    const dids = ["did:plc:killed"];
    const c = await campaignWith("killed", dids);
    await f.db.query(
      `insert into public.bluesky_campaign_kill_switches
         (workspace_id, operator_account_id, engaged, reason)
       values ($1,$2,true,'Stop this identity')`,
      [f.tenant.workspaceId, f.tenant.identityId],
    );

    const provider = providerDouble({ relationships: following(dids) });
    const result = await dispatch(provider, { campaignId: c });

    expect(provider.deletes).toHaveLength(0);
    expect(provider.relationshipReads).toBe(0);
    expect(result.notes.join(" ")).toMatch(/kill switch/i);

    await f.db.query(
      `delete from public.bluesky_campaign_kill_switches
        where workspace_id = $1 and operator_account_id = $2`,
      [f.tenant.workspaceId, f.tenant.identityId],
    );
  });
});

describe("the execution window and the local day", () => {
  it("does nothing outside the window, and schedules the next opening", async () => {
    const dids = ["did:plc:outside"];
    const c = await campaignWith("outside window", dids, {
      // 09:00–10:00 New York. At 12:00Z that is 08:00 local — before it.
      timezone: "America/New_York",
      windowStart: 9 * 60,
      windowEnd: 10 * 60,
    });
    const provider = providerDouble({ relationships: following(dids) });
    const result = await dispatch(provider, { campaignId: c });

    expect(provider.deletes).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/outside the execution window/i);
    expect((await campaignRow(c)).next_run_at).not.toBeNull();
  });

  it("a window that does not EXIST on a spring-forward day does not strand the campaign", async () => {
    // 2026-03-08, America/New_York: 02:00–03:00 local never happens.
    // Evaluating on the instant means the window simply never matches,
    // rather than producing an invalid timestamp — and the campaign is
    // still scheduled for a day on which it does exist.
    const dids = ["did:plc:dst"];
    const c = await campaignWith("dst gap", dids, {
      timezone: "America/New_York",
      windowStart: 2 * 60,
      windowEnd: 3 * 60,
    });
    const provider = providerDouble({ relationships: following(dids) });
    const result = await dispatch(provider, {
      campaignId: c,
      nowIso: "2026-03-08T07:30:00Z", // 02:30 local — the hour that is skipped
    });

    expect(provider.deletes).toHaveLength(0);
    expect(result.notes.join(" ")).toMatch(/outside the execution window/i);
    const next = (await campaignRow(c)).next_run_at;
    expect(next).not.toBeNull();
    expect(Number.isNaN(new Date(String(next)).getTime())).toBe(false);
  });

  it("a REPEATED local hour yields one run for the day, not two", async () => {
    // 2026-11-01, America/New_York: 01:00–02:00 local happens twice.
    // The run is keyed on the LOCAL DATE, so both passes find the same
    // run and the day's budget is spent once.
    const dids = ["did:plc:fallback1", "did:plc:fallback2"];
    const c = await campaignWith("dst fallback", dids, {
      timezone: "America/New_York",
      windowStart: 60,
      windowEnd: 120,
    });
    const provider = providerDouble({ relationships: following(dids) });

    // 01:30 EDT and 01:30 EST — the same wall clock, an hour apart.
    await dispatch(provider, { campaignId: c, nowIso: "2026-11-01T05:30:00Z" });
    await dispatch(provider, { campaignId: c, nowIso: "2026-11-01T06:30:00Z" });

    const runs = await runsFor(c);
    expect(runs).toHaveLength(1);
    expect(runs[0].local_date).toBeDefined();
  });
});

describe("quota exhausted, work outstanding", () => {
  it("reconciliation still proceeds when no quota remains", async () => {
    // An unresolved action describes a delete that may have reached a
    // real person and whose outcome we never learned. Reconciling reads
    // truth and spends nothing, so closing the day would leave a public
    // ambiguity standing until tomorrow for no reason at all.
    const dids = ["did:plc:noquota"];
    const c = await campaignWith("quota spent", dids);

    const provider1 = providerDouble({
      relationships: following(dids),
      defaultDelete: { status: 502, body: { error: "BadGateway" } },
    });
    await dispatch(provider1, { campaignId: c });
    expect(provider1.deletes).toHaveLength(1);

    // Leave the action unresolved, as a kill would, and spend the day.
    await f.db.query(
      `update public.bluesky_relationship_actions
          set status = 'running', provider_in_flight_at = now(), finished_at = null
        where campaign_id = $1`, [c]);
    await f.db.query(
      `update public.bluesky_follow_campaign_members
          set status = 'claimed', next_attempt_at = null, claimed_by = 'dead',
              claimed_at = now(), lease_expires_at = now() - interval '1 hour'
        where campaign_id = $1`, [c]);
    await f.db.query(
      `update public.bluesky_follow_campaign_runs
          set effective_daily_quota = 1, attempted_count = 1
        where campaign_id = $1`, [c]);
    await f.db.query(
      `update public.bluesky_campaign_quota_reservations
          set status = 'expired', reserved_count = 0 where campaign_id = $1`, [c]);

    // Dispatch at the campaign's OWN next scheduled time. The previous
    // pass pushed `next_run_at` forward, which is correct — a campaign
    // that reconsidered itself every five minutes for the rest of the
    // day would be the defect. So the test follows the schedule rather
    // than asserting against an instant the system has moved past.
    // The run's budget is no longer capped to the queue size, so the
    // previous pass ended with `queue_empty` rather than `quota
    // exhausted` and left `next_run_at` where it was. Dispatch at the
    // scheduled time if there is one, or a minute on if there is not.
    const scheduledRaw = (await campaignRow(c)).next_run_at;
    const base = scheduledRaw ? new Date(String(scheduledRaw)).getTime() : Date.parse(NOW);
    const provider2 = providerDouble({ relationships: following(dids) });
    await dispatch(provider2, {
      campaignId: c,
      nowIso: new Date(base + 60_000).toISOString(),
    });

    // Reads happened; no delete did.
    expect(provider2.relationshipReads).toBeGreaterThan(0);
    expect(provider2.deletes).toHaveLength(0);

    // AND THE RECONCILIATION ACTUALLY RAN.
    //
    // `relationshipReads > 0` alone is too weak to be evidence: the
    // chunk reads relationship truth for its whole batch BEFORE the
    // per-member loop, so a pass that broke out of that loop
    // immediately still shows a read. A mutation that removed the
    // reconciliation chunk's exemption from the quota check — the exact
    // defect this test exists for — slipped past on that assertion.
    //
    // What only happens if the loop body ran is the ACTION being
    // settled and the member being pushed out by the reconciliation
    // backoff.
    const action = await f.db.query<Record<string, unknown>>(
      `select status, reconciliation_note, provider_in_flight_at
         from public.bluesky_relationship_actions where campaign_id = $1`,
      [c],
    );
    expect(action.rows[0].status).toBe("reconciliation_required");
    expect(String(action.rows[0].reconciliation_note)).toMatch(
      /nothing was re-sent/i,
    );
    // The in-flight marker is cleared on every terminal path, so a
    // lingering one would send the NEXT worker into reconciliation for
    // an action this pass has already settled.
    expect(action.rows[0].provider_in_flight_at).toBeNull();

    const member = await f.db.query<Record<string, unknown>>(
      `select status, next_attempt_at from public.bluesky_follow_campaign_members
        where campaign_id = $1`,
      [c],
    );
    expect(member.rows[0].status).toBe("retryable");
    expect(member.rows[0].next_attempt_at).not.toBeNull();
  });
});

describe("completion", () => {
  it("completes automatically when nothing eligible or unresolved remains", async () => {
    const dids = ["did:plc:finish1", "did:plc:finish2"];
    const c = await campaignWith("finishes", dids);
    const provider = providerDouble({ relationships: following(dids) });

    await dispatch(provider, { campaignId: c });
    await dispatch(provider, { campaignId: c });

    const camp = await campaignRow(c);
    expect(camp.status).toBe("completed");
    expect(camp.completed_at).not.toBeNull();
    expect(camp.next_run_at).toBeNull();

    // And a further delivery does nothing at all.
    const before = provider.deletes.length;
    await dispatch(provider, { campaignId: c });
    expect(provider.deletes).toHaveLength(before);
  });
});
