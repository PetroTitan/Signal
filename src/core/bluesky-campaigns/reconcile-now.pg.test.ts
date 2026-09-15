import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actionsFor,
  conservation,
  createFollowFixture,
  makeFollowCampaign,
  makeMembers,
  makeUnfollowCampaign,
  makeUnfollowMembers,
  memberCounts,
  providerDouble,
  reconnectAccount,
  type FollowFixture,
} from "./test-support/pg-harness";
import { dispatchCampaigns } from "./dispatcher.server";
import { dispatchUnfollowCampaigns } from "@/core/bluesky-unfollow/dispatcher.server";

/**
 * "Reconcile now" — the read-only pass behind the operator's button.
 *
 * Both dispatchers in `reconcileOnly` mode, on embedded PostgreSQL with
 * the shipped migrations: the reservation RPC is asked for zero units,
 * hands back only reconciliation takeovers, and the worker reads
 * relationship truth. The provider double counts every request, and
 * the numbers that matter here are the ones that must stay at zero.
 */

const IN_WINDOW = "2026-09-16T12:00:00Z";
const OUT_OF_WINDOW = "2026-09-16T23:30:00Z";

let f: FollowFixture;
beforeAll(async () => {
  f = await createFollowFixture("reconcile", { backend: "server" });
  await reconnectAccount(f, "jwt-NEW", "refresh-2");
}, 300_000);
afterAll(async () => { await f?.close(); });
afterEach(async () => {
  await f.db.query(
    `update public.bluesky_follow_campaigns set status = 'cancelled'
      where workspace_id = $1 and status <> 'cancelled'`, [f.tenant.workspaceId]);
  await f.db.query(
    `update public.bluesky_identity_daily_usage
        set attempts_made = 0, follows_created = 0, unfollows_deleted = 0, delete_attempts_made = 0
      where operator_account_id = $1`, [f.tenant.identityId]);
  await f.db.query(
    `update public.bluesky_campaign_kill_switches set engaged = false, released_at = now()
      where workspace_id = $1 and engaged`, [f.tenant.workspaceId]);
});

const base = (p: ReturnType<typeof providerDouble>, nowIso: string) => ({
  db: f.client,
  nowIso,
  fetchImpl: p.fetchImpl,
  sleep: async () => undefined,
  interRequestMs: 0,
  workspaceId: f.tenant.workspaceId,
});

const usage = async () =>
  (await f.db.query<Record<string, number>>(
    `select attempts_made, follows_created, unfollows_deleted, delete_attempts_made
       from public.bluesky_identity_daily_usage where operator_account_id = $1
        and usage_date = '2026-09-16'`, [f.tenant.identityId])).rows[0] ?? {
    attempts_made: 0, follows_created: 0, unfollows_deleted: 0, delete_attempts_made: 0,
  };

/** Every member retryable-now so the read is not deferred by a backoff. */
const elapse = (campaignId: string) =>
  f.db.query(
    `update public.bluesky_follow_campaign_members
        set next_attempt_at = now() - interval '1 minute'
      where campaign_id = $1 and status = 'retryable'`, [campaignId]);

async function ambiguousUnfollow(name: string, count: number) {
  // A 09:00–13:00 window, so a later read can be shown to ignore it.
  const c = await makeUnfollowCampaign(f, name, { windowStart: 9 * 60, windowEnd: 13 * 60 });
  const dids = await makeUnfollowMembers(f, c, count, `r${Math.random().toString(36).slice(2, 5)}`);
  // Every delete answers 502: sent, outcome unknown.
  const p = providerDouble({
    following: new Set(dids),
    deleteRecord: () => ({ status: 502, body: { error: "BadGateway" } }),
  });
  await dispatchUnfollowCampaigns({ ...base(p, IN_WINDOW), campaignId: c });
  expect(p.calls.deleteRecord).toBe(count);
  const actions = await actionsFor(f, c);
  expect(actions.filter((a) => a.status === "reconciliation_required")).toHaveLength(count);
  return { c, dids, sent: p };
}

describe("Reconcile now — unfollow campaign", () => {
  it("reads truth, settles what it can, sends nothing, spends nothing, and ignores the window", async () => {
    const { c, dids } = await ambiguousUnfollow("ambiguous deletes", 3);
    const spent = await usage();
    await elapse(c);

    // Two of the three deletes DID land; the third record is still there.
    const truth = providerDouble({ following: new Set([dids[2]]) });
    const r = await dispatchUnfollowCampaigns({
      ...base(truth, OUT_OF_WINDOW),
      campaignId: c,
      reconcileOnly: true,
    });

    expect(truth.calls.deleteRecord).toBe(0);
    expect(truth.calls.createRecord).toBe(0);
    expect(truth.calls.getRelationships).toBeGreaterThan(0);
    expect(r.chunksProcessed).toBe(1);

    const actions = await actionsFor(f, c);
    const byDid = new Map(actions.map((a) => [a.subject_did, a]));
    expect(byDid.get(dids[0])?.status).toBe("succeeded");
    expect(byDid.get(dids[1])?.status).toBe("succeeded");
    expect(byDid.get(dids[2])?.status).toBe("reconciliation_required");
    expect(String(byDid.get(dids[2])?.reconciliation_note)).toMatch(/nothing was re-sent|not re-sent|still/i);
    // Observation, timestamp and classification are on the row.
    for (const did of dids) {
      const a = byDid.get(did)!;
      expect(a.reconciled_at).not.toBeNull();
      expect(a.reconciled_state).not.toBeNull();
    }

    // Not one unit. The identity's day is exactly as it was.
    expect(await usage()).toEqual(spent);
    const cons = await conservation(f, c);
    expect(Number(cons.open_reservations)).toBe(0);
    expect(Number(cons.open_leases)).toBe(0);
    const counts = await memberCounts(f, c);
    expect((counts.succeeded ?? 0) + (counts.already_not_following ?? 0)).toBe(2);
    expect(counts.retryable).toBe(1);
  });

  it("a still-ambiguous action is kept with a backoff — never terminal, never re-sent", async () => {
    const { c, dids } = await ambiguousUnfollow("still ambiguous", 1);
    await elapse(c);
    const truth = providerDouble({ following: new Set(dids) });
    await dispatchUnfollowCampaigns({ ...base(truth, OUT_OF_WINDOW), campaignId: c, reconcileOnly: true });
    const m = (await f.db.query<{ status: string; next_attempt_at: Date | null; reconcile_count: number }>(
      `select status, next_attempt_at, reconcile_count from public.bluesky_follow_campaign_members
        where campaign_id = $1`, [c])).rows[0];
    expect(m.status).toBe("retryable");
    expect(m.next_attempt_at).not.toBeNull();
    expect(m.reconcile_count).toBeGreaterThanOrEqual(1);
    // A second read right away is refused by the backoff: no read, no send.
    const again = providerDouble({ following: new Set(dids) });
    await dispatchUnfollowCampaigns({ ...base(again, OUT_OF_WINDOW), campaignId: c, reconcileOnly: true });
    expect(again.calls.getRelationships).toBe(0);
    expect(again.calls.deleteRecord).toBe(0);
  });

  it("the campaign is not completed while an action is unresolved", async () => {
    const { c, dids } = await ambiguousUnfollow("not complete", 1);
    await elapse(c);
    const truth = providerDouble({ following: new Set(dids) });
    await dispatchUnfollowCampaigns({ ...base(truth, OUT_OF_WINDOW), campaignId: c, reconcileOnly: true });
    const status = (await f.db.query<{ status: string }>(
      `select status from public.bluesky_follow_campaigns where id = $1`, [c])).rows[0].status;
    expect(status).toBe("active");
    const may = (await f.db.query<{ ok: boolean }>(
      `select public.bluesky_campaign_may_complete($1,$2) as ok`, [f.tenant.workspaceId, c])).rows[0].ok;
    expect(may).toBe(false);
  });

  it("a read-only pass with nothing to reconcile claims nothing and sends nothing", async () => {
    const c = await makeUnfollowCampaign(f, "nothing ambiguous");
    const dids = await makeUnfollowMembers(f, c, 5, "n");
    const truth = providerDouble({ following: new Set(dids) });
    const r = await dispatchUnfollowCampaigns({ ...base(truth, IN_WINDOW), campaignId: c, reconcileOnly: true });
    expect(r.chunksProcessed).toBe(0);
    expect(truth.calls.deleteRecord).toBe(0);
    expect((await memberCounts(f, c)).queued).toBe(5);
  });

  it("an engaged kill switch stops even a read", async () => {
    const { c, dids } = await ambiguousUnfollow("killed", 1);
    await elapse(c);
    await f.db.query(
      `insert into public.bluesky_campaign_kill_switches
         (workspace_id, operator_account_id, engaged, reason, engaged_at)
       values ($1, $2, true, 'test', now())`,
      [f.tenant.workspaceId, f.tenant.identityId]);
    const truth = providerDouble({ following: new Set(dids) });
    const r = await dispatchUnfollowCampaigns({ ...base(truth, OUT_OF_WINDOW), campaignId: c, reconcileOnly: true });
    expect(truth.calls.getRelationships).toBe(0);
    expect(r.notes.some((n) => /kill switch/.test(n))).toBe(true);
  });
});

describe("Reconcile now — follow campaign", () => {
  it("reads truth for ambiguous follows, sends no createRecord, spends nothing", async () => {
    const c = await makeFollowCampaign(f, "ambiguous follows", { windowStart: 9 * 60, windowEnd: 13 * 60 });
    await makeMembers(f, c, 2, "af");
    const sent = providerDouble({ createRecord: () => ({ status: 502, body: {} }) });
    await dispatchCampaigns({ ...base(sent, IN_WINDOW), campaignId: c });
    expect(sent.calls.createRecord).toBe(2);
    expect((await actionsFor(f, c)).filter((a) => a.status === "reconciliation_required")).toHaveLength(2);
    const spent = await usage();
    await elapse(c);

    // One of the two follows landed.
    const truth = providerDouble({ following: new Set(["did:plc:af1"]) });
    await dispatchCampaigns({ ...base(truth, OUT_OF_WINDOW), campaignId: c, reconcileOnly: true });
    expect(truth.calls.createRecord).toBe(0);
    expect(truth.calls.getRelationships).toBeGreaterThan(0);
    const actions = await actionsFor(f, c);
    const byDid = new Map(actions.map((a) => [a.subject_did, a]));
    expect(byDid.get("did:plc:af1")?.status).toBe("succeeded");
    expect(byDid.get("did:plc:af2")?.status).toBe("reconciliation_required");
    const counts = await memberCounts(f, c);
    expect(counts.already_following).toBe(1);
    expect(counts.retryable).toBe(1);
    expect(await usage()).toEqual(spent);
  });
});

describe("Reconcile now — follow campaign, nothing ambiguous", () => {
  it("claims nothing and sends nothing: a read-only pass cannot become a follow pass", async () => {
    const c = await makeFollowCampaign(f, "queued only");
    await makeMembers(f, c, 5, "qo");
    const truth = providerDouble({});
    const r = await dispatchCampaigns({ ...base(truth, IN_WINDOW), campaignId: c, reconcileOnly: true });
    expect(r.chunksProcessed).toBe(0);
    expect(truth.calls.createRecord).toBe(0);
    expect((await memberCounts(f, c)).queued).toBe(5);
  });
});

describe("two reconciliation workers at once", () => {
  it("send zero mutations and work each member exactly once", async () => {
    const { c, dids } = await ambiguousUnfollow("two workers", 6);
    await elapse(c);
    // Half the deletes landed, half did not.
    const truth = providerDouble({ following: new Set(dids.slice(3)) });
    const [a, b] = await Promise.all([
      dispatchUnfollowCampaigns({ ...base(truth, OUT_OF_WINDOW), campaignId: c, reconcileOnly: true }),
      dispatchUnfollowCampaigns({ ...base(truth, OUT_OF_WINDOW), campaignId: c, reconcileOnly: true }),
    ]);
    expect(truth.calls.deleteRecord).toBe(0);
    expect(truth.calls.createRecord).toBe(0);
    expect(a.chunksProcessed + b.chunksProcessed).toBeGreaterThanOrEqual(1);

    // Each member was handed to exactly one zero-unit reservation.
    const ledger = await f.db.query<{ member_id: string; n: string }>(
      `select l.member_id, count(*)::text as n
         from public.bluesky_campaign_attempt_ledger l
         join public.bluesky_follow_campaign_members m on m.id = l.member_id
        where m.campaign_id = $1 and l.provider_intent_at is null
        group by l.member_id`, [c]);
    expect(ledger.rows).toHaveLength(6);
    expect(ledger.rows.every((r) => Number(r.n) === 1)).toBe(true);

    const actions = await actionsFor(f, c);
    expect(actions.filter((x) => x.status === "succeeded")).toHaveLength(3);
    expect(actions.filter((x) => x.status === "reconciliation_required")).toHaveLength(3);
    const cons = await conservation(f, c);
    expect(Number(cons.open_leases)).toBe(0);
    expect(Number(cons.open_reservations)).toBe(0);
  });
});
