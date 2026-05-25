import { describe, expect, it } from "vitest";
import {
  assessItemApprovalReadiness,
  describeCreativeState,
  summarizeReadiness,
} from "./approval-readiness";
import type { WeeklyPlanItem } from "@/repositories/weekly-plan-repository";
import type { WeeklyContract } from "@/core/weekly-contract/approval-contract-types";

function makeItem(
  overrides: Partial<WeeklyPlanItem> = {},
): WeeklyPlanItem {
  return {
    id: "item-1",
    workspaceId: "w1",
    weeklyPlanId: "p1",
    productId: "prod-1",
    accountId: "acc-1",
    platform: "bluesky",
    contentType: "post",
    title: "t",
    body: "b",
    linkUrl: null,
    status: "pending_approval",
    riskLevel: "low",
    riskScore: 25,
    scheduledAt: "2026-05-20T20:01:00.000Z",
    metadata: {},
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    ...overrides,
  } as WeeklyPlanItem;
}

function makeContract(
  overrides: Partial<WeeklyContract> = {},
): WeeklyContract {
  return {
    id: "c1",
    workspaceId: "w1",
    createdBy: null,
    approvedBy: null,
    title: "Test contract",
    weekStart: "2026-05-18",
    weekEnd: "2026-05-24",
    status: "active",
    rationale: null,
    notes: null,
    operatorNotes: null,
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
    activatedAt: "2026-05-17T00:00:00.000Z",
    pausedAt: null,
    archivedAt: null,
    scope: {
      accountIds: ["acc-1"],
      productIds: ["prod-1"],
      platforms: ["bluesky"],
      allowedActions: [],
      executionWindows: [],
    },
    ...overrides,
  } as WeeklyContract;
}

const readyCreative = {
  status: "approved",
  sourceType: "uploaded",
  assetUrl: "https://example.com/x.png",
  sourceUrl: null,
  altText: "WebmasterID logo on a blue and green gradient background.",
} as unknown as Parameters<typeof assessItemApprovalReadiness>[0]["primaryCreative"];

describe("assessItemApprovalReadiness — hold path (schedule not required)", () => {
  it("returns ready when all blockers are clear", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it("does not require schedule for hold path even when missing", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ scheduledAt: null }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
    });
    expect(r.ready).toBe(true);
  });

  it("blocks when status is not pending_approval", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ status: "draft" }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/pending_approval/);
  });

  it("blocks when no active contract", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/contract/i);
  });

  it("blocks when creative is missing", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: makeContract(),
      primaryCreative: null,
      requireSchedule: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/missing/i);
  });

  it("blocks when alt text is missing", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: makeContract(),
      primaryCreative: { ...readyCreative!, altText: "" },
      requireSchedule: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/alt text/i);
  });

  it("blocks when creative is rejected", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: makeContract(),
      primaryCreative: { ...readyCreative!, status: "rejected" },
      requireSchedule: false,
    });
    expect(r.ready).toBe(false);
  });

  it("blocks when QA flagged the item (riskLevel='blocked')", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ riskLevel: "blocked" }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/QA blocked/);
  });

  it("blocks when account is out of contract scope", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ accountId: "other-acc" }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/Account is out of/);
  });
});

describe("assessItemApprovalReadiness — schedule path (schedule required)", () => {
  it("blocks when scheduledAt is missing", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ scheduledAt: null }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/Schedule is required/);
  });

  it("ready when scheduledAt is set + everything else clear", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: true,
    });
    expect(r.ready).toBe(true);
  });
});

describe("summarizeReadiness", () => {
  it("returns ready copy when ready", () => {
    expect(
      summarizeReadiness({
        ready: true,
        blockers: [],
        ok: {} as never,
      }),
    ).toBe("Ready for post approval.");
  });
  it("returns first blocker + extra count when multiple", () => {
    const s = summarizeReadiness({
      ready: false,
      blockers: ["A", "B", "C"],
      ok: {} as never,
    });
    expect(s).toBe("A (+2 more)");
  });
});

describe("describeCreativeState", () => {
  it("returns 'No creative' for null", () => {
    expect(describeCreativeState(null).label).toBe("No creative");
  });
  it("returns 'Creative approved' when approved + alt + asset", () => {
    expect(
      describeCreativeState({
        status: "approved",
        sourceType: "uploaded",
        assetUrl: "https://x/y.png",
        sourceUrl: null,
        altText: "alt",
      }).label,
    ).toBe("Creative approved");
  });
  it("returns 'Alt text missing' when alt is empty", () => {
    expect(
      describeCreativeState({
        status: "approved",
        sourceType: "uploaded",
        assetUrl: "https://x/y.png",
        sourceUrl: null,
        altText: "",
      }).label,
    ).toBe("Alt text missing");
  });
  it("returns 'Creative rejected' for rejected", () => {
    expect(
      describeCreativeState({
        status: "rejected",
        sourceType: "uploaded",
        assetUrl: "https://x/y.png",
        sourceUrl: null,
        altText: "x",
      }).tone,
    ).toBe("blocked");
  });
  it("returns 'Creative pending review' for pending status with alt", () => {
    expect(
      describeCreativeState({
        status: "pending_review",
        sourceType: "uploaded",
        assetUrl: "https://x/y.png",
        sourceUrl: null,
        altText: "alt",
      }).label,
    ).toBe("Creative pending review");
  });
});
