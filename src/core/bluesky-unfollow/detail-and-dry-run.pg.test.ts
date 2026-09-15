import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import {
  loadUnfollowCampaignDetail,
  MEMBER_REASON_LABELS,
  type UnfollowCampaignDetail,
} from "./load-detail.server";

/**
 * The detail screen's data, and dry-run semantics, on the shipped
 * migrations.
 *
 * PRODUCTION: a dry-run chunk showed 20 members as "skipped". The rows
 * were correct — a dry run must never be `succeeded` — but the label
 * was not: skipped reads as a provider rejection. The loader now marks
 * every dry-run outcome `simulated`, counts them apart, and the page
 * labels them "Simulated (dry run)".
 */

let f: UnfollowFixture;
const NOW = "2026-09-16T12:00:00Z";

beforeAll(async () => {
  f = await createUnfollowFixture("detail");
}, 180_000);
afterAll(async () => { await f?.close(); });

const dispatch = (provider: ReturnType<typeof providerDouble>, over: Record<string, unknown> = {}) =>
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
    dids.map((d, i) => [d, { following: `at://${ACTOR_DID}/app.bsky.graph.follow/rk-${i + 1}` }]),
  );

const detail = (campaignId: string, over: Record<string, unknown> = {}) =>
  loadUnfollowCampaignDetail({
    workspaceId: f.tenant.workspaceId,
    campaignId,
    db: f.client,
    now: new Date(NOW),
    ...over,
  });

const usage = async () =>
  (await f.db.query<Record<string, number>>(
    `select attempts_made, follows_created, unfollows_deleted, delete_attempts_made
       from public.bluesky_identity_daily_usage where operator_account_id = $1 and usage_date = '2026-09-16'`,
    [f.tenant.identityId])).rows[0] ?? { attempts_made: 0, follows_created: 0, unfollows_deleted: 0, delete_attempts_made: 0 };

describe("dry run", () => {
  it("sends no DELETE, consumes no quota, is labelled simulated — and leaves the profiles eligible for a real campaign", async () => {
    const dids = Array.from({ length: 4 }, (_, i) => `did:plc:dry${i + 1}`);
    const dry = await makeUnfollowCampaign(f, "dry run", { dryRun: true });
    await makeMembers(f, dry, dids.map((did, i) => ({ did, sequence: i + 1 })));
    const before = await usage();

    const p = providerDouble({ relationships: following(dids) });
    await dispatch(p, { campaignId: dry });

    // ZERO provider mutations, zero quota.
    expect(p.deletes).toHaveLength(0);
    expect(p.creates).toHaveLength(0);
    expect(await usage()).toEqual(before);

    const d = (await detail(dry))!;
    expect(d.kind).toBe("unfollow");
    expect(d.dryRun).toBe(true);
    expect(d.simulated).toBe(4);
    expect(d.succeeded).toBe(0);
    expect(d.failed).toBe(0);
    expect(d.remaining).toBe(0);
    expect(d.members).toHaveLength(4);
    for (const m of d.members) {
      expect(m.status).toBe("skipped");
      expect(m.simulated).toBe(true);
      expect(m.reasonCode).toBe("dry_run");
      expect(m.reasonLabel).toBe(MEMBER_REASON_LABELS.dry_run);
      expect(m.reasonLabel).toMatch(/Simulated/);
    }
    // Reservations, leases, ledger: nothing left open.
    const open = await f.db.query<{ n: string }>(
      `select count(*)::text as n from public.bluesky_campaign_quota_reservations
        where campaign_id = $1 and status in ('open','held')`, [dry]);
    expect(Number(open.rows[0].n)).toBe(0);

    // A REAL campaign over the same profiles is not affected: every
    // one is queued, claimed and actually deleted.
    const real = await makeUnfollowCampaign(f, "real after dry", { dryRun: false });
    await makeMembers(f, real, dids.map((did, i) => ({ did, sequence: i + 1 })));
    const p2 = providerDouble({ relationships: following(dids) });
    await dispatch(p2, { campaignId: real });
    expect(p2.deletes).toHaveLength(4);
    const r = (await detail(real))!;
    expect(r.succeeded).toBe(4);
    expect(r.simulated).toBe(0);
    expect(r.members.every((m) => !m.simulated && m.status === "succeeded")).toBe(true);
  });
});

describe("the detail screen's facts", () => {
  it("exposes the persisted source, window, both quotas, the shared identity usage, every count and the latest run", async () => {
    const dids = Array.from({ length: 6 }, (_, i) => `did:plc:det${i + 1}`);
    const c = await makeUnfollowCampaign(f, "facts", {
      timezone: "America/New_York", windowStart: 9 * 60, windowEnd: 20 * 60, requestedDailyQuota: 300,
    });
    await f.db.query(
      `insert into public.bluesky_campaign_import_jobs
         (workspace_id, campaign_id, source_kind, status, source_exhausted, imported_count)
       values ($1,$2,'following_records','ready',true,6)`, [f.tenant.workspaceId, c]);
    await makeMembers(f, c, dids.map((did, i) => ({ did, sequence: i + 1 })));
    // One protected, one structurally failed, four to process.
    await f.db.query(
      `update public.bluesky_follow_campaign_members set status = 'protected', protected_reason = 'allowlisted'
        where campaign_id = $1 and import_sequence = 1`, [c]);
    await f.db.query(
      `update public.bluesky_follow_campaign_members set status = 'failed_structural', last_error_code = 'invalid',
              last_error_message = 'record/subject must be a valid did'
        where campaign_id = $1 and import_sequence = 2`, [c]);

    // Before the run: the day's allowance is the requested number.
    const fresh = (await detail(c, { now: new Date("2026-09-16T15:00:00Z") }))!;
    expect(fresh.effectiveDailyQuota).toBeGreaterThan(0);
    expect(fresh.effectiveDailyQuota).toBeLessThanOrEqual(300);
    expect(fresh.remaining).toBe(4);

    const p = providerDouble({ relationships: following(dids) });
    await dispatch(p, { campaignId: c, nowIso: "2026-09-16T15:00:00Z" }); // 11:00 New York
    expect(p.deletes).toHaveLength(4);

    const d = (await detail(c, { now: new Date("2026-09-16T15:00:00Z") }))!;
    expect(d.sourceKind).toBe("following_records");
    expect(d.sourceLabel).toBe("Everyone this account currently follows");
    expect(d.timezone).toBe("America/New_York");
    expect(d.windowLabel).toBe("09:00–20:00");
    expect(d.requestedDailyQuota).toBe(300);
    // Nothing left to do, so nothing more may be done today.
    expect(d.effectiveDailyQuota).toBe(0);
    expect(d.identityCeiling).toBe(1000);
    // Shared with every campaign on the identity, so it is a delta here.
    expect(d.identityUnfollowsToday - fresh.identityUnfollowsToday).toBe(4);
    expect(d.identityMutationsToday - fresh.identityMutationsToday).toBe(4);
    expect(d.total).toBe(6);
    expect(d.succeeded).toBe(4);
    expect(d.protectedCount).toBe(1);
    expect(d.failed).toBe(1);
    expect(d.queued).toBe(0);
    expect(d.remaining).toBe(0);
    expect(d.progressPercent).toBe(100);
    expect(d.latestRun).not.toBeNull();
    expect(d.latestRun!.attempted).toBe(4);
    expect(d.latestRun!.succeeded).toBe(4);
    expect(d.runs).toHaveLength(1);

    const byDid = new Map(d.members.map((m) => [m.subjectDid, m]));
    expect(byDid.get(dids[0])?.reasonCode).toBe("protected");
    expect(byDid.get(dids[0])?.reasonLabel).toMatch(/Protected/);
    expect(byDid.get(dids[1])?.reasonCode).toBe("invalid");
    expect(byDid.get(dids[1])?.reasonLabel).toBe(MEMBER_REASON_LABELS.invalid);
    expect(byDid.get(dids[2])?.status).toBe("succeeded");
    expect(byDid.get(dids[2])?.reasonCode).toBeNull();
  });

  it("pages the queue by KEYSET on import_sequence — no gaps, no repeats, no OFFSET", async () => {
    const c = await makeUnfollowCampaign(f, "paged", { status: "ready" });
    await makeMembers(f, c, Array.from({ length: 120 }, (_, i) => ({ did: `did:plc:pg${i + 1}`, sequence: i + 1 })));
    const seen: number[] = [];
    let after: number | null = null;
    for (let page = 0; page < 5; page += 1) {
      const d: UnfollowCampaignDetail = (await detail(c, { afterSequence: after }))!;
      seen.push(...d.members.map((m) => m.sequence));
      if (d.membersNextCursor === null) break;
      after = d.membersNextCursor;
    }
    expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => i + 1));
    // With a filter, the cursor still walks in sequence order.
    await f.db.query(
      `update public.bluesky_follow_campaign_members set status = 'cancelled'
        where campaign_id = $1 and import_sequence % 2 = 0`, [c]);
    const filtered = (await detail(c, { statusFilter: "cancelled" }))!;
    expect(filtered.members.every((m) => m.status === "cancelled" && m.sequence % 2 === 0)).toBe(true);
    expect(filtered.members).toHaveLength(50);
    expect(filtered.membersNextCursor).toBe(100);
  });

  it("pages run history by KEYSET on local_date, newest first", async () => {
    const c = await makeUnfollowCampaign(f, "runs", { status: "paused" });
    for (let i = 1; i <= 12; i += 1) {
      const day = String(i).padStart(2, "0");
      await f.db.query(
        `insert into public.bluesky_follow_campaign_runs
           (workspace_id, campaign_id, local_date, status, requested_daily_quota, effective_daily_quota, attempted_count)
         values ($1,$2,$3,'completed',100,100,$4)`,
        [f.tenant.workspaceId, c, `2026-08-${day}`, i]);
    }
    const first = (await detail(c))!;
    expect(first.runs.map((r) => r.localDate)).toEqual([
      "2026-08-12", "2026-08-11", "2026-08-10", "2026-08-09", "2026-08-08",
      "2026-08-07", "2026-08-06", "2026-08-05", "2026-08-04", "2026-08-03",
    ]);
    expect(first.latestRun?.localDate).toBe("2026-08-12");
    expect(first.runsNextCursor).toBe("2026-08-03");
    const older = (await detail(c, { runsBefore: first.runsNextCursor }))!;
    expect(older.runs.map((r) => r.localDate)).toEqual(["2026-08-02", "2026-08-01"]);
    expect(older.runsNextCursor).toBeNull();
  });

  it("another workspace's campaign is not found", async () => {
    const c = await makeUnfollowCampaign(f, "scoped", { status: "ready" });
    const other = await f.db.query<{ id: string }>(
      `insert into public.workspaces (name, slug, created_by) values ('o', 'o-detail', $1) returning id`,
      [f.tenant.ownerId]);
    expect(await detail(c, { workspaceId: other.rows[0].id })).toBeNull();
  });
});
