import { describe, expect, it } from "vitest";
import {
  ARCHIVE_AFTER_WINDOW,
  PLANNED_WINDOWS,
  WINDOW_CLOSING_FRACTION,
  X_PRIVATE_METRIC_WINDOW_DAYS,
  planRefresh,
  planRefreshBatch,
  type PlannerPost,
} from "./refresh-planner";
import type { AgeWindow } from "./age-windows";

const NOW = "2026-08-20T12:00:00.000Z";
const OPTS = { nowIso: NOW, seedWindowDays: 14 };

function post(over: Partial<PlannerPost> = {}): PlannerPost {
  return {
    publishHistoryId: "p1",
    platform: "bluesky",
    publishedAt: "2026-08-20T11:40:00.000Z",
    hasProviderId: true,
    coveredWindows: [],
    lastReadAt: null,
    ...over,
  };
}

describe("the window ladder", () => {
  it("waits before the first window opens", () => {
    const p = planRefresh(post({ publishedAt: "2026-08-20T11:50:00Z" }), OPTS);
    expect(p.action).toBe("wait");
    expect(p.targetWindow).toBe("1h");
    expect(p.nextReadAt).toBe("2026-08-20T12:50:00.000Z");
  });

  it("reads once the 1h window is reached", () => {
    const p = planRefresh(post({ publishedAt: "2026-08-20T10:00:00Z" }), OPTS);
    expect(p.action).toBe("read_now");
    expect(p.targetWindow).toBe("1h");
  });

  it("climbs the ladder as windows fill", () => {
    const steps: Array<[AgeWindow[], string, AgeWindow]> = [
      [[], "2026-08-20T10:00:00Z", "1h"],
      [["1h"], "2026-08-20T04:00:00Z", "6h"],
      [["1h", "6h"], "2026-08-19T06:00:00Z", "24h"],
      [["1h", "6h", "24h"], "2026-08-17T00:00:00Z", "72h"],
      [["1h", "6h", "24h", "72h"], "2026-08-13T00:00:00Z", "7d"],
    ];
    for (const [covered, publishedAt, expected] of steps) {
      const p = planRefresh(post({ coveredWindows: covered, publishedAt }), OPTS);
      expect(p.action, expected).toBe("read_now");
      expect(p.targetWindow).toBe(expected);
    }
  });

  it("STOPS after the last window — no perpetual polling", () => {
    const p = planRefresh(
      post({ coveredWindows: [...PLANNED_WINDOWS], publishedAt: "2026-08-01T00:00:00Z" }),
      OPTS,
    );
    expect(p.action).toBe("complete");
    expect(p.nextReadAt).toBeNull();
    expect(p.reason).toContain("would cost without adding information");
    expect(ARCHIVE_AFTER_WINDOW).toBe("7d");
  });

  it("stops chasing windows that can no longer be obtained", () => {
    // A 1h reading cannot be taken for a month-old post at any price.
    const p = planRefresh(post({ publishedAt: "2026-06-13T16:15:00Z" }), OPTS);
    expect(p.action).toBe("complete");
    expect(p.reason).toContain("cannot be taken retrospectively");
    expect(p.nextReadAt).toBeNull();
  });
});

describe("sweep reach vs backfill", () => {
  it("marks an in-reach post read_now", () => {
    expect(planRefresh(post({ publishedAt: "2026-08-15T14:25:00Z" }), OPTS).action).toBe("read_now");
  });

  it("marks a post past the enrolment window backfill_only", () => {
    // 10 days old, missing its 7d reading, with a 7-day enrolment window.
    const p = planRefresh(
      post({ publishedAt: "2026-08-10T12:00:00Z", coveredWindows: ["1h", "6h", "24h", "72h"] }),
      { ...OPTS, seedWindowDays: 7 },
    );
    expect(p.action).toBe("backfill_only");
    expect(p.nextReadAt).toBeNull();
    expect(p.reason).toContain("bounded backfill");
  });

  it("with a 14-day window the sweep can reach every window itself", () => {
    // Worth pinning: the last window closes at 14 days and the enrolment
    // window is 14 days, so backfill_only should be rare in practice.
    const p = planRefresh(
      post({ publishedAt: "2026-08-13T12:00:00Z", coveredWindows: ["1h", "6h", "24h", "72h"] }),
      OPTS,
    );
    expect(p.action).toBe("read_now");
    expect(p.targetWindow).toBe("7d");
  });
});

describe("urgency is about windows closing, not provider billing", () => {
  it("is urgent when the due window is about to close for good", () => {
    // 5.5h old, 1h window not recorded. The 1h bucket ends at 6h, so one
    // more daily sweep and this reading can never be taken.
    const p = planRefresh(post({ publishedAt: "2026-08-20T06:30:00Z" }), OPTS);
    expect(p.action).toBe("read_now");
    expect(p.priority).toBe("urgent");
    expect(p.reason).toContain("can never be taken");
  });

  it("is not urgent early in a window", () => {
    const p = planRefresh(post({ publishedAt: "2026-08-20T10:45:00Z" }), OPTS);
    expect(p.action).toBe("read_now");
    expect(p.priority).toBe("normal");
  });

  it("does NOT schedule around X's 30-day private-metric cliff", () => {
    // Signal reads public_metrics, which has no documented age limit, so
    // that cliff does not gate what it collects. Pretending otherwise
    // would be theatre.
    const publishedAt = new Date(
      Date.parse(NOW) - (X_PRIVATE_METRIC_WINDOW_DAYS - 2) * 86_400_000,
    ).toISOString();
    const p = planRefresh(post({ platform: "x", publishedAt }), { ...OPTS, seedWindowDays: 60 });
    expect(p.reason).not.toContain("private-metric");
    expect(p.reason).not.toContain("30-day");
  });

  it("treats both providers by the same window rules", () => {
    const publishedAt = "2026-08-20T06:30:00Z";
    const x = planRefresh(post({ platform: "x", publishedAt }), OPTS);
    const bsky = planRefresh(post({ platform: "bluesky", publishedAt }), OPTS);
    expect(x.priority).toBe(bsky.priority);
    expect(WINDOW_CLOSING_FRACTION).toBeGreaterThan(0);
  });
});

describe("unmeasurable posts", () => {
  it("never schedules a post with no provider id", () => {
    const p = planRefresh(post({ hasProviderId: false }), OPTS);
    expect(p.action).toBe("unmeasurable");
    expect(p.nextReadAt).toBeNull();
  });

  it("never schedules a post with an unusable timestamp", () => {
    expect(planRefresh(post({ publishedAt: "not-a-date" }), OPTS).action).toBe("unmeasurable");
  });
});

describe("batch planning", () => {
  it("sorts urgent reads first so a capped run spends budget correctly", () => {
    const plan = planRefreshBatch(
      [
        post({ publishHistoryId: "routine", publishedAt: "2026-08-20T10:45:00Z" }),
        post({ publishHistoryId: "urgent", publishedAt: "2026-08-20T06:30:00Z" }),
      ],
      OPTS,
    );
    expect(plan.readNow[0].publishHistoryId).toBe("urgent");
    expect(plan.urgent).toHaveLength(1);
    expect(plan.summary).toContain("1 urgent");
  });

  it("counts terminal states separately from work", () => {
    const plan = planRefreshBatch(
      [
        post({ publishHistoryId: "done", coveredWindows: [...PLANNED_WINDOWS] }),
        post({ publishHistoryId: "waiting", publishedAt: "2026-08-20T11:45:00Z" }),
        post({ publishHistoryId: "nope", hasProviderId: false }),
      ],
      OPTS,
    );
    expect(plan.complete).toBe(1);
    expect(plan.waiting).toBe(1);
    expect(plan.unmeasurable).toBe(1);
    expect(plan.readNow).toHaveLength(0);
  });

  it("is deterministic", () => {
    const posts = [post({ publishHistoryId: "a" }), post({ publishHistoryId: "b" })];
    expect(JSON.stringify(planRefreshBatch(posts, OPTS))).toBe(
      JSON.stringify(planRefreshBatch([...posts].reverse(), OPTS)),
    );
  });
});
