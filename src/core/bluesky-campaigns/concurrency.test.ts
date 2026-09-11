import { describe, expect, it } from "vitest";
import { FakeDb, type Row } from "@/core/bluesky-relationships/test-support/fake-db";
import {
  claimMembers,
  ensureRun,
  getIdentityUsage,
  recordIdentityUsage,
  updateCampaign,
} from "@/repositories/bluesky-campaign-repository";

/**
 * Concurrency and idempotency.
 *
 * These are the properties that make at-least-once cron delivery safe,
 * and none of them is defended in application code — each is a database
 * constraint or a locking statement. The fake reproduces those rather
 * than mocking them, because a mock would prove the code CALLED claim()
 * and prove nothing about whether two workers can claim the same row.
 */

const WS = "ws-1";
const OTHER_WS = "ws-2";
const CAMPAIGN = "camp-1";
const IDENTITY = "acct-1";

function seedQueue(db: FakeDb, count: number, campaignId = CAMPAIGN): void {
  const rows: Row[] = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({
      id: `${campaignId}-m${i}`,
      workspace_id: WS,
      campaign_id: campaignId,
      subject_did: `did:plc:${campaignId}-${i}`,
      import_sequence: i,
      status: "queued",
      attempt_count: 0,
      next_attempt_at: null,
      claimed_at: null,
      claimed_by: null,
      lease_expires_at: null,
    });
  }
  db.tables.set("bluesky_follow_campaign_members", rows);
}

describe("two workers never claim the same member", () => {
  it("concurrent claims return disjoint sets", async () => {
    const db = new FakeDb();
    seedQueue(db, 100);

    // Interleaved, as two cron deliveries overlapping would be.
    const [a, b] = await Promise.all([
      claimMembers({
        workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 20,
        leaseSeconds: 300, claimedBy: "worker-a", db: db.client(),
      }),
      claimMembers({
        workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 20,
        leaseSeconds: 300, claimedBy: "worker-b", db: db.client(),
      }),
    ]);

    expect(a).toHaveLength(20);
    expect(b).toHaveLength(20);
    const overlap = a.filter((x) => b.some((y) => y.id === x.id));
    expect(overlap).toEqual([]);
    // 40 distinct members, each claimed by exactly one worker.
    expect(new Set([...a, ...b].map((m) => m.id)).size).toBe(40);
  });

  it("five workers racing still produce no overlap", async () => {
    const db = new FakeDb();
    seedQueue(db, 200);
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        claimMembers({
          workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 20,
          leaseSeconds: 300, claimedBy: `worker-${i}`, db: db.client(),
        }),
      ),
    );
    const all = results.flat();
    expect(all).toHaveLength(100);
    expect(new Set(all.map((m) => m.id)).size).toBe(100);
  });

  it("a claimed member is invisible to the next claim", async () => {
    const db = new FakeDb();
    seedQueue(db, 30);
    const first = await claimMembers({
      workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 20,
      leaseSeconds: 300, claimedBy: "a", db: db.client(),
    });
    const second = await claimMembers({
      workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 20,
      leaseSeconds: 300, claimedBy: "b", db: db.client(),
    });
    expect(first).toHaveLength(20);
    // Only 10 remain — not 20 again.
    expect(second).toHaveLength(10);
  });

  it("never claims across a campaign or workspace boundary", async () => {
    const db = new FakeDb();
    seedQueue(db, 10);
    db.rows("bluesky_follow_campaign_members").push(
      {
        id: "other-ws", workspace_id: OTHER_WS, campaign_id: CAMPAIGN,
        subject_did: "did:plc:foreign", import_sequence: 0, status: "queued",
        attempt_count: 0, next_attempt_at: null, lease_expires_at: null,
      },
      {
        id: "other-campaign", workspace_id: WS, campaign_id: "camp-2",
        subject_did: "did:plc:othercamp", import_sequence: 0, status: "queued",
        attempt_count: 0, next_attempt_at: null, lease_expires_at: null,
      },
    );

    const claimed = await claimMembers({
      workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 50,
      leaseSeconds: 300, claimedBy: "w", db: db.client(),
    });
    const ids = claimed.map((m) => m.id);
    expect(ids).not.toContain("other-ws");
    expect(ids).not.toContain("other-campaign");
    expect(claimed).toHaveLength(10);
  });
});

describe("lease expiry recovers a dead worker's rows", () => {
  it("an expired lease is re-claimable; a live one is not", async () => {
    const db = new FakeDb();
    const now = Date.now();
    db.tables.set("bluesky_follow_campaign_members", [
      {
        id: "dead", workspace_id: WS, campaign_id: CAMPAIGN,
        subject_did: "did:plc:dead", import_sequence: 1, status: "claimed",
        attempt_count: 0, next_attempt_at: null,
        claimed_by: "worker-that-died",
        // Lease expired a minute ago.
        lease_expires_at: new Date(now - 60_000).toISOString(),
      },
      {
        id: "alive", workspace_id: WS, campaign_id: CAMPAIGN,
        subject_did: "did:plc:alive", import_sequence: 2, status: "claimed",
        attempt_count: 0, next_attempt_at: null,
        claimed_by: "worker-still-running",
        lease_expires_at: new Date(now + 300_000).toISOString(),
      },
    ]);

    const claimed = await claimMembers({
      workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 10,
      leaseSeconds: 300, claimedBy: "recovery-worker", db: db.client(),
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].id).toBe("dead");
    // The live worker's row is untouched — recovery must not steal work
    // that is still in flight.
    const alive = db
      .rows("bluesky_follow_campaign_members")
      .find((m) => m.id === "alive")!;
    expect(alive.claimed_by).toBe("worker-still-running");
  });

  it("a crash leaves at most the in-flight chunk, and it comes back", async () => {
    const db = new FakeDb();
    seedQueue(db, 50);
    const claimed = await claimMembers({
      workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 20,
      leaseSeconds: 300, claimedBy: "doomed", db: db.client(),
    });
    expect(claimed).toHaveLength(20);

    // The worker dies. Nothing releases the rows; the lease simply
    // lapses.
    for (const m of db.rows("bluesky_follow_campaign_members")) {
      if (m.claimed_by === "doomed") {
        m.lease_expires_at = new Date(Date.now() - 1000).toISOString();
      }
    }

    const recovered = await claimMembers({
      workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 100,
      leaseSeconds: 300, claimedBy: "next-tick", db: db.client(),
    });
    // All 50: the 20 recovered plus the 30 never touched.
    expect(recovered).toHaveLength(50);
  });

  it("respects next_attempt_at so a backoff is not bypassed", async () => {
    const db = new FakeDb();
    db.tables.set("bluesky_follow_campaign_members", [
      {
        id: "waiting", workspace_id: WS, campaign_id: CAMPAIGN,
        subject_did: "did:plc:w", import_sequence: 1, status: "retryable",
        attempt_count: 1,
        next_attempt_at: new Date(Date.now() + 600_000).toISOString(),
        lease_expires_at: null,
      },
      {
        id: "ready", workspace_id: WS, campaign_id: CAMPAIGN,
        subject_did: "did:plc:r", import_sequence: 2, status: "retryable",
        attempt_count: 1,
        next_attempt_at: new Date(Date.now() - 1000).toISOString(),
        lease_expires_at: null,
      },
    ]);
    const claimed = await claimMembers({
      workspaceId: WS, campaignId: CAMPAIGN, chunkSize: 10,
      leaseSeconds: 300, claimedBy: "w", db: db.client(),
    });
    expect(claimed.map((m) => m.id)).toEqual(["ready"]);
  });
});

describe("duplicate cron delivery does not duplicate a daily run", () => {
  it("two simultaneous ensureRun calls yield ONE run", async () => {
    const db = new FakeDb();
    const [a, b] = await Promise.all([
      ensureRun({
        workspaceId: WS, campaignId: CAMPAIGN, localDate: "2026-09-11",
        requestedQuota: 400, effectiveQuota: 400, effectiveReason: null,
        db: db.client(),
      }),
      ensureRun({
        workspaceId: WS, campaignId: CAMPAIGN, localDate: "2026-09-11",
        requestedQuota: 400, effectiveQuota: 400, effectiveReason: null,
        db: db.client(),
      }),
    ]);
    expect(a.id).toBe(b.id);
    expect(db.rows("bluesky_follow_campaign_runs")).toHaveLength(1);
  });

  it("ten deliveries in a row still yield one run", async () => {
    const db = new FakeDb();
    for (let i = 0; i < 10; i += 1) {
      await ensureRun({
        workspaceId: WS, campaignId: CAMPAIGN, localDate: "2026-09-11",
        requestedQuota: 200, effectiveQuota: 200, effectiveReason: null,
        db: db.client(),
      });
    }
    expect(db.rows("bluesky_follow_campaign_runs")).toHaveLength(1);
  });

  it("a NEW local date starts a new run — that is a different day", async () => {
    const db = new FakeDb();
    await ensureRun({
      workspaceId: WS, campaignId: CAMPAIGN, localDate: "2026-09-11",
      requestedQuota: 200, effectiveQuota: 200, effectiveReason: null,
      db: db.client(),
    });
    await ensureRun({
      workspaceId: WS, campaignId: CAMPAIGN, localDate: "2026-09-12",
      requestedQuota: 200, effectiveQuota: 200, effectiveReason: null,
      db: db.client(),
    });
    expect(db.rows("bluesky_follow_campaign_runs")).toHaveLength(2);
  });

  it("a re-delivery does NOT reset the day's progress", async () => {
    const db = new FakeDb();
    const first = await ensureRun({
      workspaceId: WS, campaignId: CAMPAIGN, localDate: "2026-09-11",
      requestedQuota: 1000, effectiveQuota: 1000, effectiveReason: null,
      db: db.client(),
    });
    // 600 follows already done today.
    db.rows("bluesky_follow_campaign_runs")[0].attempted_count = 600;
    db.rows("bluesky_follow_campaign_runs")[0].succeeded_count = 590;

    const again = await ensureRun({
      workspaceId: WS, campaignId: CAMPAIGN, localDate: "2026-09-11",
      requestedQuota: 1000, effectiveQuota: 1000, effectiveReason: null,
      db: db.client(),
    });
    expect(again.id).toBe(first.id);
    expect(again.attempted_count).toBe(600);
    expect(again.succeeded_count).toBe(590);
  });

  it("the effective quota can never exceed the requested one", async () => {
    const db = new FakeDb();
    const run = await ensureRun({
      workspaceId: WS, campaignId: CAMPAIGN, localDate: "2026-09-11",
      // A caller passing a larger effective quota is a bug; the
      // database clamps rather than trusting it.
      requestedQuota: 200, effectiveQuota: 5000, effectiveReason: null,
      db: db.client(),
    });
    expect(run.effective_daily_quota).toBe(200);
  });
});

describe("per-identity allowance is shared across campaigns", () => {
  it("increments atomically rather than read-modify-write", async () => {
    const db = new FakeDb();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        recordIdentityUsage({
          workspaceId: WS, operatorAccountId: IDENTITY,
          usageDate: "2026-09-11", followsCreated: 20, attemptsMade: 22,
          db: db.client(),
        }),
      ),
    );
    const usage = await getIdentityUsage({
      workspaceId: WS, operatorAccountId: IDENTITY,
      usageDate: "2026-09-11", db: db.client(),
    });
    // Ten concurrent increments of 20 — a read-modify-write would have
    // lost most of them.
    expect(usage?.follows_created).toBe(200);
    expect(usage?.attempts_made).toBe(220);
    expect(db.rows("bluesky_identity_daily_usage")).toHaveLength(1);
  });

  it("separates identities and dates", async () => {
    const db = new FakeDb();
    await recordIdentityUsage({
      workspaceId: WS, operatorAccountId: IDENTITY,
      usageDate: "2026-09-11", followsCreated: 100, attemptsMade: 100,
      db: db.client(),
    });
    await recordIdentityUsage({
      workspaceId: WS, operatorAccountId: "acct-2",
      usageDate: "2026-09-11", followsCreated: 50, attemptsMade: 50,
      db: db.client(),
    });
    await recordIdentityUsage({
      workspaceId: WS, operatorAccountId: IDENTITY,
      usageDate: "2026-09-12", followsCreated: 7, attemptsMade: 7,
      db: db.client(),
    });
    expect(db.rows("bluesky_identity_daily_usage")).toHaveLength(3);
  });
});

describe("campaign completion happens exactly once", () => {
  it("only the first compare-and-set wins", async () => {
    const db = new FakeDb();
    db.tables.set("bluesky_follow_campaigns", [
      {
        id: CAMPAIGN, workspace_id: WS, operator_account_id: IDENTITY,
        name: "c", status: "active", requested_daily_quota: 200,
        timezone: "UTC", execution_window_start_minute: 0,
        execution_window_end_minute: 1440, completed_at: null,
      },
    ]);

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        updateCampaign({
          workspaceId: WS, campaignId: CAMPAIGN, status: "completed",
          completedAt: new Date().toISOString(),
          // The guard: only a still-active campaign may complete.
          expectedStatuses: ["active"], db: db.client(),
        }),
      ),
    );
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(db.rows("bluesky_follow_campaigns")[0].status).toBe("completed");
  });

  it("a paused campaign is not completed by a late worker", async () => {
    const db = new FakeDb();
    db.tables.set("bluesky_follow_campaigns", [
      {
        id: CAMPAIGN, workspace_id: WS, operator_account_id: IDENTITY,
        name: "c", status: "paused", requested_daily_quota: 200,
        timezone: "UTC", execution_window_start_minute: 0,
        execution_window_end_minute: 1440, completed_at: null,
      },
    ]);
    const result = await updateCampaign({
      workspaceId: WS, campaignId: CAMPAIGN, status: "completed",
      expectedStatuses: ["active"], db: db.client(),
    });
    expect(result).toBeNull();
    expect(db.rows("bluesky_follow_campaigns")[0].status).toBe("paused");
  });
});

describe("a paused campaign yields no new claims", () => {
  it("the dispatcher only ever considers active campaigns", async () => {
    // listDueCampaigns filters on status='active'; a paused campaign is
    // therefore never even looked at, which is what "pause stops new
    // claims" means at the dispatcher level.
    const db = new FakeDb();
    db.tables.set("bluesky_follow_campaigns", [
      { id: "a", workspace_id: WS, operator_account_id: IDENTITY, name: "active",
        status: "active", next_run_at: null },
      { id: "p", workspace_id: WS, operator_account_id: IDENTITY, name: "paused",
        status: "paused", next_run_at: null },
      { id: "c", workspace_id: WS, operator_account_id: IDENTITY, name: "cancelled",
        status: "cancelled", next_run_at: null },
    ]);
    const { listDueCampaigns } = await import(
      "@/repositories/bluesky-campaign-repository"
    );
    const due = await listDueCampaigns({
      nowIso: new Date().toISOString(), db: db.client(),
    });
    expect(due.map((c) => c.id)).toEqual(["a"]);
  });
});
