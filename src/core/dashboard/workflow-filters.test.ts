import { describe, expect, it } from "vitest";
import type { WeeklyPlanItemStatus } from "@/lib/supabase/types";
import {
  WORKFLOW_TABS,
  compareOldestFirst,
  comparePublishedDesc,
  compareScheduledAsc,
  DEFAULT_PAGE_SIZE,
  isAwaitingApprovalItem,
  isFailedItem,
  isPausedItem,
  isPlanBoardItem,
  isPublishedItem,
  isQueueItem,
  isScheduledItem,
  isTerminalStatus,
  paginate,
  parsePageParam,
  parseSearchQuery,
  resolveWorkflowTab,
  searchPublishedRows,
  shouldShowDueCountdown,
  summaryCounts,
  type WorkflowItemView,
} from "./workflow-filters";

/**
 * Pure-helper regression tests for the Dashboard Organization Pass.
 *
 * These pin the workflow-bucket rules to the REAL weekly_plan_items
 * status enum so the Dashboard sections and Weekly Plan tabs can never
 * silently diverge or invent statuses.
 */

function view(overrides: Partial<WorkflowItemView> & { id: string }): WorkflowItemView {
  return {
    status: "draft",
    riskLevel: null,
    scheduledAt: null,
    effectiveAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    needsCreativeReview: false,
    hasFailure: false,
    ...overrides,
  };
}

// One representative item per real status, for exhaustiveness checks.
const ALL_STATUSES: WeeklyPlanItemStatus[] = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "scheduled",
  "published",
  "skipped",
  "backlog",
  "paused",
];

// =====================================================================
// Tab resolution
// =====================================================================

describe("resolveWorkflowTab", () => {
  it("defaults to plan when absent", () => {
    expect(resolveWorkflowTab(undefined)).toBe("plan");
  });
  it("defaults to plan for unknown values", () => {
    expect(resolveWorkflowTab("garbage")).toBe("plan");
  });
  it("accepts every known tab id", () => {
    for (const t of WORKFLOW_TABS) {
      expect(resolveWorkflowTab(t.id)).toBe(t.id);
    }
  });
  it("takes the first value of an array param", () => {
    expect(resolveWorkflowTab(["queue", "scheduled"])).toBe("queue");
  });
});

// =====================================================================
// Queue filtering
// =====================================================================

describe("isQueueItem", () => {
  it("includes awaiting approval", () => {
    expect(isQueueItem(view({ id: "a", status: "pending_approval" }))).toBe(true);
  });
  it("includes approved & hold", () => {
    expect(isQueueItem(view({ id: "b", status: "approved" }))).toBe(true);
  });
  it("includes in-flight blocked risk", () => {
    expect(
      isQueueItem(view({ id: "c", status: "draft", riskLevel: "blocked" })),
    ).toBe(true);
  });
  it("includes in-flight needs-creative-review", () => {
    expect(
      isQueueItem(view({ id: "d", status: "draft", needsCreativeReview: true })),
    ).toBe(true);
  });
  it("excludes plain drafts (no blocker, no review)", () => {
    expect(isQueueItem(view({ id: "e", status: "draft" }))).toBe(false);
  });
  it("excludes scheduled items", () => {
    expect(isQueueItem(view({ id: "f", status: "scheduled" }))).toBe(false);
  });
  it("excludes paused items", () => {
    expect(isQueueItem(view({ id: "g", status: "paused" }))).toBe(false);
  });
  it("does NOT resurface a published item carrying a stale blocked risk_level", () => {
    expect(
      isQueueItem(
        view({ id: "h", status: "published", riskLevel: "blocked" }),
      ),
    ).toBe(false);
  });
  it("does NOT resurface a published item flagged needs-review", () => {
    expect(
      isQueueItem(
        view({ id: "i", status: "published", needsCreativeReview: true }),
      ),
    ).toBe(false);
  });
});

describe("isAwaitingApprovalItem (Dashboard section, narrower than Queue)", () => {
  it("includes awaiting approval", () => {
    expect(
      isAwaitingApprovalItem(view({ id: "a", status: "pending_approval" })),
    ).toBe(true);
  });
  it("EXCLUDES approved & hold (already cleared approval)", () => {
    expect(isAwaitingApprovalItem(view({ id: "b", status: "approved" }))).toBe(false);
    // …but the broader Queue still includes it.
    expect(isQueueItem(view({ id: "b", status: "approved" }))).toBe(true);
  });
  it("includes in-flight blocked + needs-review", () => {
    expect(
      isAwaitingApprovalItem(view({ id: "c", status: "draft", riskLevel: "blocked" })),
    ).toBe(true);
    expect(
      isAwaitingApprovalItem(view({ id: "d", status: "draft", needsCreativeReview: true })),
    ).toBe(true);
  });
  it("excludes terminal items with stale flags", () => {
    expect(
      isAwaitingApprovalItem(
        view({ id: "e", status: "published", riskLevel: "blocked" }),
      ),
    ).toBe(false);
  });
});

// =====================================================================
// Scheduled / Published / Paused / Failed filtering
// =====================================================================

describe("status bucket predicates", () => {
  it("isScheduledItem only matches scheduled", () => {
    const matches = ALL_STATUSES.filter((s) =>
      isScheduledItem(view({ id: s, status: s })),
    );
    expect(matches).toEqual(["scheduled"]);
  });
  it("isPublishedItem only matches published", () => {
    const matches = ALL_STATUSES.filter((s) =>
      isPublishedItem(view({ id: s, status: s })),
    );
    expect(matches).toEqual(["published"]);
  });
  it("isPausedItem only matches paused", () => {
    const matches = ALL_STATUSES.filter((s) =>
      isPausedItem(view({ id: s, status: s })),
    );
    expect(matches).toEqual(["paused"]);
  });
  it("isFailedItem keys off the derived failure flag, not status", () => {
    expect(isFailedItem(view({ id: "x", status: "scheduled", hasFailure: true }))).toBe(
      true,
    );
    expect(isFailedItem(view({ id: "y", status: "scheduled", hasFailure: false }))).toBe(
      false,
    );
  });
});

describe("isPlanBoardItem", () => {
  it("keeps in-flight + paused, drops terminal", () => {
    const kept = ALL_STATUSES.filter((s) => isPlanBoardItem(view({ id: s, status: s })));
    expect(kept.sort()).toEqual(
      ["approved", "draft", "paused", "pending_approval", "scheduled"].sort(),
    );
  });
  it("drops published from the board (dominance fix)", () => {
    expect(isPlanBoardItem(view({ id: "p", status: "published" }))).toBe(false);
  });
});

// =====================================================================
// Overdue-countdown gate (audit fix)
// =====================================================================

describe("shouldShowDueCountdown — Published+Overdue audit fix", () => {
  it("suppresses the countdown for terminal statuses", () => {
    for (const s of ["published", "rejected", "backlog", "skipped"] as const) {
      expect(shouldShowDueCountdown(s)).toBe(false);
      expect(isTerminalStatus(s)).toBe(true);
    }
  });
  it("keeps the countdown for in-flight + paused statuses", () => {
    for (const s of [
      "draft",
      "pending_approval",
      "approved",
      "scheduled",
      "paused",
    ] as const) {
      expect(shouldShowDueCountdown(s)).toBe(true);
    }
  });
});

// =====================================================================
// Sorting
// =====================================================================

describe("sorting comparators", () => {
  it("compareOldestFirst orders ascending by created_at", () => {
    const a = view({ id: "a", createdAt: "2026-01-03T00:00:00Z" });
    const b = view({ id: "b", createdAt: "2026-01-01T00:00:00Z" });
    const c = view({ id: "c", createdAt: "2026-01-02T00:00:00Z" });
    expect([a, b, c].sort(compareOldestFirst).map((v) => v.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
  it("compareScheduledAsc puts nearest first, unscheduled last", () => {
    const soon = view({ id: "soon", effectiveAt: "2026-01-01T01:00:00Z" });
    const later = view({ id: "later", effectiveAt: "2026-01-05T00:00:00Z" });
    const none = view({ id: "none", effectiveAt: null });
    expect([later, none, soon].sort(compareScheduledAsc).map((v) => v.id)).toEqual([
      "soon",
      "later",
      "none",
    ]);
  });
  it("comparePublishedDesc puts most recent first", () => {
    const old = view({ id: "old", effectiveAt: "2026-01-01T00:00:00Z" });
    const recent = view({ id: "recent", effectiveAt: "2026-01-09T00:00:00Z" });
    const mid = view({ id: "mid", effectiveAt: "2026-01-05T00:00:00Z" });
    expect([old, recent, mid].sort(comparePublishedDesc).map((v) => v.id)).toEqual([
      "recent",
      "mid",
      "old",
    ]);
  });
});

// =====================================================================
// Summary counts — must equal a naive GROUP BY (source-of-truth)
// =====================================================================

describe("summaryCounts", () => {
  it("counts each status exactly, with no derived arithmetic", () => {
    const items = [
      view({ id: "1", status: "published" }),
      view({ id: "2", status: "published" }),
      view({ id: "3", status: "scheduled" }),
      view({ id: "4", status: "pending_approval" }),
      view({ id: "5", status: "paused" }),
      view({ id: "6", status: "draft" }),
      view({ id: "7", status: "rejected" }),
    ];
    expect(summaryCounts(items)).toEqual({
      published: 2,
      scheduled: 1,
      awaitingApproval: 1,
      paused: 1,
    });
  });

  it("matches an independent naive group-by over the same rows", () => {
    const statuses: WeeklyPlanItemStatus[] = [
      "published",
      "published",
      "published",
      "scheduled",
      "scheduled",
      "pending_approval",
      "paused",
      "draft",
      "approved",
      "skipped",
      "backlog",
    ];
    const items = statuses.map((s, i) => view({ id: String(i), status: s }));
    const naive = items.reduce<Record<string, number>>((acc, it) => {
      acc[it.status] = (acc[it.status] ?? 0) + 1;
      return acc;
    }, {});
    const summary = summaryCounts(items);
    expect(summary.published).toBe(naive.published ?? 0);
    expect(summary.scheduled).toBe(naive.scheduled ?? 0);
    expect(summary.awaitingApproval).toBe(naive.pending_approval ?? 0);
    expect(summary.paused).toBe(naive.paused ?? 0);
  });

  it("returns all-zero for an empty workspace", () => {
    expect(summaryCounts([])).toEqual({
      published: 0,
      scheduled: 0,
      awaitingApproval: 0,
      paused: 0,
    });
  });
});

// =====================================================================
// Pagination
// =====================================================================

describe("paginate", () => {
  const rows = Array.from({ length: 45 }, (_, i) => i);

  it("defaults to a page size of 20", () => {
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    const p = paginate(rows, 1);
    expect(p.items).toHaveLength(20);
    expect(p.totalPages).toBe(3);
  });

  it("returns the correct slice for a middle page", () => {
    const p = paginate(rows, 2);
    expect(p.items[0]).toBe(20);
    expect(p.items.at(-1)).toBe(39);
    expect(p.startIndex).toBe(21);
    expect(p.endIndex).toBe(40);
    expect(p.hasPrev).toBe(true);
    expect(p.hasNext).toBe(true);
  });

  it("returns the partial last page", () => {
    const p = paginate(rows, 3);
    expect(p.items).toEqual([40, 41, 42, 43, 44]);
    expect(p.hasNext).toBe(false);
    expect(p.endIndex).toBe(45);
  });

  it("clamps an over-range page down to the last page", () => {
    const p = paginate(rows, 99);
    expect(p.page).toBe(3);
    expect(p.items[0]).toBe(40);
  });

  it("clamps a non-positive page up to 1", () => {
    const p = paginate(rows, 0);
    expect(p.page).toBe(1);
    expect(p.items[0]).toBe(0);
  });

  it("handles an empty list without dividing by zero", () => {
    const p = paginate([], 1);
    expect(p.totalPages).toBe(1);
    expect(p.total).toBe(0);
    expect(p.items).toEqual([]);
    expect(p.startIndex).toBe(0);
    expect(p.endIndex).toBe(0);
    expect(p.hasPrev).toBe(false);
    expect(p.hasNext).toBe(false);
  });

  it("respects a custom page size", () => {
    const p = paginate(rows, 1, 10);
    expect(p.items).toHaveLength(10);
    expect(p.totalPages).toBe(5);
  });
});

describe("parsePageParam", () => {
  it("defaults to 1 for absent / invalid input", () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam("nope")).toBe(1);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-3")).toBe(1);
  });
  it("parses a valid page number", () => {
    expect(parsePageParam("4")).toBe(4);
    expect(parsePageParam(["2", "5"])).toBe(2);
  });
});

// =====================================================================
// Published / Failed table search
// =====================================================================

describe("searchPublishedRows", () => {
  const rows = [
    { title: "Launch announcement", platform: "bluesky", subreddit: null },
    { title: "Weekly digest", platform: "reddit", subreddit: "startups" },
    { title: null, platform: "x", subreddit: null },
  ];

  it("returns all rows for an empty query", () => {
    expect(searchPublishedRows(rows, "")).toHaveLength(3);
    expect(searchPublishedRows(rows, "   ")).toHaveLength(3);
  });

  it("matches on title, case-insensitively", () => {
    expect(searchPublishedRows(rows, "LAUNCH").map((r) => r.platform)).toEqual([
      "bluesky",
    ]);
  });

  it("matches on platform", () => {
    expect(searchPublishedRows(rows, "reddit")).toHaveLength(1);
  });

  it("matches on subreddit", () => {
    expect(searchPublishedRows(rows, "startups")).toHaveLength(1);
  });

  it("returns nothing when there is no match", () => {
    expect(searchPublishedRows(rows, "nonexistent")).toHaveLength(0);
  });

  it("tolerates rows with a null title", () => {
    expect(searchPublishedRows(rows, "x").map((r) => r.platform)).toContain("x");
  });
});

describe("parseSearchQuery", () => {
  it("trims and defaults to empty", () => {
    expect(parseSearchQuery(undefined)).toBe("");
    expect(parseSearchQuery("  hello  ")).toBe("hello");
    expect(parseSearchQuery(["first", "second"])).toBe("first");
  });
});
