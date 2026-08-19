import { describe, expect, it, vi } from "vitest";
import {
  MAX_ACCOUNTS_PER_RUN,
  collectAccountSnapshots,
  dedupeTargets,
  isSnapshottable,
  type SnapshotTarget,
} from "./account-snapshot-collector";
import { accountsDueForSnapshot, accountSnapshotSource } from "@/repositories/account-snapshot-repository";
import type { AccountSnapshot } from "./account-context";

const NOW = "2026-08-20T06:00:00.000Z";

function target(over: Partial<SnapshotTarget> = {}): SnapshotTarget {
  return {
    workspaceId: "w1",
    accountId: "acct-bsky",
    platform: "bluesky",
    handle: "webmasterid.bsky.social",
    ...over,
  };
}

function snapshot(platform: string): AccountSnapshot {
  return {
    platform,
    handle: "h",
    providerAccountId: "id",
    followers: 1,
    following: 10,
    postCount: 22,
    createdAt: null,
    fetchedAt: NOW,
    source: `${platform}_getprofile`,
  };
}

/** Minimal Supabase double recording table + operation. */
function fakeDb(over: { snapshotRows?: unknown[]; failUpsert?: boolean } = {}) {
  const upserts: Array<Record<string, unknown>> = [];
  const db = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                order() {
                  return {
                    limit: async () => ({ data: over.snapshotRows ?? [], error: null }),
                  };
                },
              };
            },
          };
        },
        async upsert(row: Record<string, unknown>) {
          upserts.push({ table, ...row });
          return { error: over.failUpsert ? { message: "write refused" } : null };
        },
      };
    },
  };
  return { db: db as never, upserts };
}

describe("cadence: daily buckets", () => {
  it("buckets the history row by calendar day", () => {
    expect(accountSnapshotSource("bluesky_getprofile", "2026-08-20T06:00:00Z")).toBe(
      "snapshot:bluesky_getprofile:2026-08-20",
    );
  });

  it("an account with today's snapshot is not due again", () => {
    const accounts = [{ accountId: "a" }, { accountId: "b" }];
    const latest = new Map([["a", { fetchedAt: "2026-08-20T01:00:00Z" }]]);
    expect(accountsDueForSnapshot(accounts, latest, NOW).map((a) => a.accountId)).toEqual(["b"]);
  });

  it("yesterday's snapshot IS due", () => {
    const latest = new Map([["a", { fetchedAt: "2026-08-19T23:59:00Z" }]]);
    expect(accountsDueForSnapshot([{ accountId: "a" }], latest, NOW)).toHaveLength(1);
  });

  it("does not re-read an account already collected today", async () => {
    const readBluesky = vi.fn();
    const { db } = fakeDb({
      snapshotRows: [
        { account_id: "acct-bsky", source: "bluesky_getprofile", fetched_at: "2026-08-20T01:00:00Z", platform: "bluesky", followers: 1, following: 1, post_count: 1, handle: "h", provider_account_id: null, provider_created_at: null, freshness: "fresh", error: null },
      ],
    });
    const r = await collectAccountSnapshots([target()], NOW, { db, readBluesky });
    expect(readBluesky).not.toHaveBeenCalled();
    expect(r.skippedNotDue).toBe(1);
    expect(r.attempted).toBe(0);
  });
});

describe("PROVIDER AND ACCOUNT ISOLATION", () => {
  it("an X failure does not prevent the Bluesky read", async () => {
    const { db, upserts } = fakeDb();
    const readX = vi.fn().mockResolvedValue({ ok: false, reason: "X 429", rateLimited: true });
    const readBluesky = vi.fn().mockResolvedValue({ ok: true, snapshot: snapshot("bluesky") });

    const r = await collectAccountSnapshots(
      [target(), target({ accountId: "acct-x", platform: "x", handle: null })],
      NOW,
      { db, readX, readBluesky },
    );

    expect(readBluesky).toHaveBeenCalledTimes(1);
    expect(r.byPlatform.bluesky.written).toBe(1);
    expect(r.byPlatform.x.failed).toBe(1);
    expect(r.written).toBe(1);
    // The Bluesky snapshot still landed.
    expect(upserts.some((u) => u.platform === "bluesky" && u.followers === 1)).toBe(true);
  });

  it("a THROWN provider client does not abandon the remaining accounts", async () => {
    const { db } = fakeDb();
    const readX = vi.fn().mockRejectedValue(new Error("socket hang up"));
    const readBluesky = vi.fn().mockResolvedValue({ ok: true, snapshot: snapshot("bluesky") });

    const r = await collectAccountSnapshots(
      [target({ accountId: "acct-x", platform: "x", handle: null }), target()],
      NOW,
      { db, readX, readBluesky },
    );
    expect(r.failed).toBe(1);
    expect(r.written).toBe(1);
  });

  it("one account failing does not stop the next account on the SAME provider", async () => {
    const { db } = fakeDb();
    const readBluesky = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "not found", rateLimited: false })
      .mockResolvedValueOnce({ ok: true, snapshot: snapshot("bluesky") });

    const r = await collectAccountSnapshots(
      [target({ accountId: "a1" }), target({ accountId: "a2" })],
      NOW,
      { db, readBluesky },
    );
    expect(r.attempted).toBe(2);
    expect(r.written).toBe(1);
    expect(r.failed).toBe(1);
  });

  it("records a failure row so an outage is not mistaken for never-collected", async () => {
    const { db, upserts } = fakeDb();
    const readBluesky = vi.fn().mockResolvedValue({ ok: false, reason: "getProfile 500", rateLimited: false });
    await collectAccountSnapshots([target()], NOW, { db, readBluesky });

    const failureRow = upserts.find((u) => u.freshness === "provider_error");
    expect(failureRow).toBeTruthy();
    expect(failureRow!.followers).toBeNull();
    expect(failureRow!.error).toContain("getProfile 500");
  });

  it("marks a rate-limited read as rate_limited, not provider_error", async () => {
    const { db, upserts } = fakeDb();
    const readBluesky = vi.fn().mockResolvedValue({ ok: false, reason: "429", rateLimited: true });
    await collectAccountSnapshots([target()], NOW, { db, readBluesky });
    expect(upserts.some((u) => u.freshness === "rate_limited")).toBe(true);
  });
});

describe("bounds", () => {
  it("deduplicates accounts so ten posts do not become ten profile reads", () => {
    const targets = Array.from({ length: 10 }, () => target());
    expect(dedupeTargets(targets)).toHaveLength(1);
  });

  it("drops targets with no account id", () => {
    expect(dedupeTargets([target({ accountId: "" })])).toHaveLength(0);
  });

  it("caps accounts per run", async () => {
    const { db } = fakeDb();
    const readBluesky = vi.fn().mockResolvedValue({ ok: true, snapshot: snapshot("bluesky") });
    const many = Array.from({ length: MAX_ACCOUNTS_PER_RUN + 5 }, (_, i) =>
      target({ accountId: `a${i}` }),
    );
    const r = await collectAccountSnapshots(many, NOW, { db, readBluesky });
    expect(r.attempted).toBe(MAX_ACCOUNTS_PER_RUN);
    expect(r.notes.join(" ")).toContain("deferred");
  });

  it("only collects platforms whose profile Signal can read", () => {
    expect(isSnapshottable("bluesky")).toBe(true);
    expect(isSnapshottable("x")).toBe(true);
    expect(isSnapshottable("telegram")).toBe(false);
    expect(isSnapshottable("devto")).toBe(false);
  });

  it("says so when nothing is collectable rather than failing", async () => {
    const { db } = fakeDb();
    const r = await collectAccountSnapshots([target({ platform: "telegram" })], NOW, { db });
    expect(r.attempted).toBe(0);
    expect(r.notes[0]).toContain("Signal can read");
  });

  it("needs a handle for Bluesky and says so", async () => {
    const { db } = fakeDb();
    const readBluesky = vi.fn();
    const r = await collectAccountSnapshots([target({ handle: null })], NOW, { db, readBluesky });
    expect(readBluesky).not.toHaveBeenCalled();
    expect(r.failed).toBe(1);
  });
});

describe("persistence failures are contained", () => {
  it("a write refusal counts as failed, not written", async () => {
    const { db } = fakeDb({ failUpsert: true });
    const readBluesky = vi.fn().mockResolvedValue({ ok: true, snapshot: snapshot("bluesky") });
    const r = await collectAccountSnapshots([target()], NOW, { db, readBluesky });
    expect(r.written).toBe(0);
    expect(r.failed).toBe(1);
  });
});
