import { describe, expect, it } from "vitest";
import {
  planRefreshWrite,
  snapshotSource,
  isSnapshotSource,
} from "./post-metrics-repository";

/**
 * Pure no-clobber guarantee: a non-connected refresh must NEVER overwrite
 * previously-verified connected metrics with empties.
 */
describe("planRefreshWrite", () => {
  it("connected incoming → write the new counts + snapshot", () => {
    const plan = planRefreshWrite(null, {
      status: "connected",
      metrics: { likes: 9 },
    });
    expect(plan.status).toBe("connected");
    expect(plan.metrics).toEqual({ likes: 9 });
    expect(plan.snapshot).toBe(true);
    expect(plan.preserved).toBe(false);
  });

  it("non-connected incoming WITH prior connected metrics → preserve, no clobber", () => {
    const plan = planRefreshWrite(
      { status: "connected", metrics: { likes: 12, reposts: 3 } },
      { status: "unavailable", metrics: {} },
    );
    expect(plan.status).toBe("connected");
    expect(plan.metrics).toEqual({ likes: 12, reposts: 3 });
    expect(plan.preserved).toBe(true);
    expect(plan.keepFetchedAt).toBe(true);
    expect(plan.snapshot).toBe(false);
  });

  it("non-connected incoming with NO prior data → record the honest status", () => {
    const plan = planRefreshWrite(null, { status: "unavailable", metrics: {} });
    expect(plan.status).toBe("unavailable");
    expect(plan.metrics).toEqual({});
    expect(plan.preserved).toBe(false);
    expect(plan.snapshot).toBe(false);
  });

  it("non-connected incoming with prior connected-but-EMPTY metrics → not preserved", () => {
    const plan = planRefreshWrite(
      { status: "connected", metrics: {} },
      { status: "unsupported", metrics: {} },
    );
    expect(plan.status).toBe("unsupported");
    expect(plan.preserved).toBe(false);
  });
});

describe("snapshot source helpers", () => {
  it("hour-buckets the snapshot source (idempotent within the hour)", () => {
    const a = snapshotSource("bluesky_getposts", "2026-06-13T07:14:00.000Z");
    const b = snapshotSource("bluesky_getposts", "2026-06-13T07:51:00.000Z");
    expect(a).toBe(b); // same hour bucket
    expect(isSnapshotSource(a)).toBe(true);
    expect(isSnapshotSource("bluesky_getposts")).toBe(false);
  });
});
