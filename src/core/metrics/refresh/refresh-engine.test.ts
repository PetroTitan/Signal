import { describe, expect, it, vi } from "vitest";
import {
  refreshStaleMetrics,
  verifiedPlatforms,
  type RefreshEngineDeps,
} from "./refresh-engine";
import type { RefreshTarget } from "@/repositories/post-metrics-repository";
import type { MetricsResult } from "../metrics-provider";

function target(over: Partial<RefreshTarget> = {}): RefreshTarget {
  return {
    workspaceId: "w1",
    publishHistoryId: "ph1",
    platform: "bluesky",
    externalPostId: "at://x",
    permalink: null,
    ...over,
  };
}

function connected(platform: string): MetricsResult {
  return { status: "connected", source: `${platform}_src`, externalPostId: "id", metrics: { likes: 1 } };
}
function unavailable(platform: string): MetricsResult {
  return { status: "unavailable", source: `${platform}_src`, externalPostId: "id", metrics: {}, error: "tier" };
}

describe("verifiedPlatforms", () => {
  it("are exactly bluesky, devto, reddit (sorted)", () => {
    expect(verifiedPlatforms()).toEqual(["bluesky", "devto", "reddit"]);
  });
});

describe("refreshStaleMetrics", () => {
  it("dedupes a post that is both stale and unmeasured into one job", async () => {
    const refreshOne = vi.fn(async () => connected("bluesky"));
    const deps: RefreshEngineDeps = {
      loadStale: async () => [target({ publishHistoryId: "dup" })],
      loadUnmeasured: async () => [target({ publishHistoryId: "dup" })],
      refreshOne,
    };
    const r = await refreshStaleMetrics(deps);
    expect(r.scanned).toBe(1);
    expect(refreshOne).toHaveBeenCalledTimes(1);
    expect(r.connected).toBe(1);
  });

  it("tallies connected / unavailable per platform and overall", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: async () => [
        target({ publishHistoryId: "b1", platform: "bluesky" }),
        target({ publishHistoryId: "r1", platform: "reddit", permalink: "https://r" }),
      ],
      loadUnmeasured: async () => [
        target({ publishHistoryId: "b2", platform: "bluesky" }),
      ],
      refreshOne: async (t) =>
        t.platform === "reddit" ? unavailable("reddit") : connected("bluesky"),
    };
    const r = await refreshStaleMetrics(deps);
    expect(r.scanned).toBe(3);
    expect(r.connected).toBe(2);
    expect(r.unavailable).toBe(1);
    expect(r.byPlatform.bluesky.connected).toBe(2);
    expect(r.byPlatform.reddit.unavailable).toBe(1);
  });

  it("one failing refresh does not sink the sweep", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: async () => [
        target({ publishHistoryId: "ok" }),
        target({ publishHistoryId: "boom" }),
      ],
      loadUnmeasured: async () => [],
      refreshOne: async (t) => {
        if (t.publishHistoryId === "boom") throw new Error("network down");
        return connected("bluesky");
      },
    };
    const r = await refreshStaleMetrics(deps);
    expect(r.ok).toBe(true);
    expect(r.connected).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.results.find((x) => x.publishHistoryId === "boom")?.status).toBe("failed");
  });

  it("is deterministic — repeated runs over the same deps produce identical tallies", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: async () => [
        target({ publishHistoryId: "r1", platform: "reddit", permalink: "https://r" }),
        target({ publishHistoryId: "b1", platform: "bluesky" }),
      ],
      loadUnmeasured: async () => [],
      refreshOne: async () => connected("x"),
    };
    const a = await refreshStaleMetrics(deps, { now: new Date("2026-06-13T00:00:00Z") });
    const b = await refreshStaleMetrics(deps, { now: new Date("2026-06-13T00:00:00Z") });
    expect(a.results.map((x) => x.publishHistoryId)).toEqual(
      b.results.map((x) => x.publishHistoryId),
    );
    // Grouped/sorted: bluesky before reddit.
    expect(a.results[0].platform).toBe("bluesky");
  });

  it("skips seeding when seedLimit is 0", async () => {
    const loadUnmeasured = vi.fn(async () => [target()]);
    const deps: RefreshEngineDeps = {
      loadStale: async () => [],
      loadUnmeasured,
      refreshOne: async () => connected("bluesky"),
    };
    const r = await refreshStaleMetrics(deps, { seedLimit: 0 });
    expect(loadUnmeasured).not.toHaveBeenCalled();
    expect(r.scanned).toBe(0);
  });

  it("never invents results — only reports what refreshOne returned", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: async () => [target()],
      loadUnmeasured: async () => [],
      refreshOne: async () => unavailable("bluesky"),
    };
    const r = await refreshStaleMetrics(deps);
    expect(r.connected).toBe(0);
    expect(r.unavailable).toBe(1);
    expect(r.results[0].status).toBe("unavailable");
  });
});
