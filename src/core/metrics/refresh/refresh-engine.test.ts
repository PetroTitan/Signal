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

describe("refreshStaleMetrics — sweep observability", () => {
  it("records a loader failure instead of reporting it as an empty backlog", async () => {
    // This is the exact ambiguity that let post_metrics sit empty for two
    // months: a thrown loader and a genuinely idle queue both produced
    // `scanned: 0` and nothing else.
    const deps: RefreshEngineDeps = {
      loadStale: vi.fn().mockRejectedValue(new Error("permission denied for table")),
      loadUnmeasured: vi.fn().mockResolvedValue([]),
      refreshOne: vi.fn(),
    };
    const r = await refreshStaleMetrics(deps);
    expect(r.scanned).toBe(0);
    expect(r.report.loaders.stale.ok).toBe(false);
    expect(r.report.loaders.stale.error).toContain("permission denied");
    expect(r.report.loaders.unmeasured.ok).toBe(true);
    expect(r.report.diagnosis).toContain("may be incomplete");
  });

  it("an idle queue is reported as idle, not as a failure", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: vi.fn().mockResolvedValue([]),
      loadUnmeasured: vi.fn().mockResolvedValue([]),
      refreshOne: vi.fn(),
    };
    const r = await refreshStaleMetrics(deps, { seedWindowDays: 14 });
    expect(r.report.loaders.stale.ok).toBe(true);
    expect(r.report.loaders.unmeasured.ok).toBe(true);
    expect(r.report.diagnosis).toContain("14-day enrolment window");
  });

  it("skips a target with no provider identifier and says so", async () => {
    const refreshOne = vi.fn();
    const deps: RefreshEngineDeps = {
      loadStale: vi.fn().mockResolvedValue([
        target({ publishHistoryId: "orphan", externalPostId: null, permalink: null }),
      ]),
      loadUnmeasured: vi.fn().mockResolvedValue([]),
      refreshOne,
    };
    const r = await refreshStaleMetrics(deps);
    expect(refreshOne).not.toHaveBeenCalled();
    expect(r.report.skipped).toBe(1);
    expect(r.report.skips[0].reason).toBe("no_provider_identifier");
    expect(r.report.diagnosis).toContain("none reached a provider");
  });

  it("classifies a 429 as rate-limited rather than as a plain unavailable", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: vi.fn().mockResolvedValue([target({ platform: "x" })]),
      loadUnmeasured: vi.fn().mockResolvedValue([]),
      refreshOne: vi.fn().mockResolvedValue({
        status: "unavailable",
        source: "x_api_v2",
        externalPostId: "1",
        metrics: {},
        error: "provider rate limit (429)",
        rateLimited: true,
      } satisfies MetricsResult),
    };
    const r = await refreshStaleMetrics(deps);
    expect(r.report.rateLimited).toBe(1);
    expect(r.report.unavailable).toBe(0);
    expect(r.report.byPlatform.x.rateLimited).toBe(1);
  });

  it("attributes candidates to every workspace the run touched", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: vi.fn().mockResolvedValue([
        target({ workspaceId: "w1", publishHistoryId: "a" }),
        target({ workspaceId: "w2", publishHistoryId: "b", platform: "reddit", externalPostId: null, permalink: "https://r/x" }),
      ]),
      loadUnmeasured: vi.fn().mockResolvedValue([]),
      refreshOne: vi.fn().mockImplementation((t: RefreshTarget) => connected(t.platform)),
    };
    const r = await refreshStaleMetrics(deps);
    expect(Object.keys(r.report.byWorkspace).sort()).toEqual(["w1", "w2"]);
    expect(r.report.byWorkspace.w1.connected).toBe(1);
    expect(r.report.byWorkspace.w2.connected).toBe(1);
  });

  it("carries the run id through so a log line and an audit row can be joined", async () => {
    const deps: RefreshEngineDeps = {
      loadStale: vi.fn().mockResolvedValue([]),
      loadUnmeasured: vi.fn().mockResolvedValue([]),
      refreshOne: vi.fn(),
    };
    const r = await refreshStaleMetrics(deps, { runId: "run-abc" });
    expect(r.report.runId).toBe("run-abc");
    expect(r.report.phase).toBe("completed");
  });
});
