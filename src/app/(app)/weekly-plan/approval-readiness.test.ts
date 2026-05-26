import { describe, expect, it } from "vitest";
import { assessItemApprovalReadiness } from "./approval-readiness.server";
import {
  describeCreativeState,
  summarizeReadiness,
} from "./approval-readiness.shared";
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

// =====================================================================
// Per-item HOLD path — requireContract: false (the production fix).
// =====================================================================

describe("hold path (contract not required) — per-item approve-and-hold", () => {
  it("ready when item is otherwise valid and no contract is supplied", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it("does not surface any contract blocker even when contract is null", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.blockers.join(" ")).not.toMatch(/contract/i);
  });

  it("does not require schedule for hold path even when missing", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ scheduledAt: null }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.ready).toBe(true);
  });

  it("still blocks when status is not pending_approval", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ status: "draft" }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/pending_approval/);
  });

  it("still blocks when creative is missing AND platform-native policy requires one", () => {
    // Instagram is creative-required for every intent — pre-F7.3
    // this test asserted Bluesky also blocked, but the new policy
    // makes Bluesky text-post optional. Use Instagram to preserve
    // the regression: when the policy says required, missing
    // creative DOES still block.
    const r = assessItemApprovalReadiness({
      item: makeItem({ platform: "instagram" }),
      contract: null,
      primaryCreative: null,
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/missing/i);
  });

  it("still blocks when alt text is missing AND platform-native policy requires creative", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ platform: "instagram" }),
      contract: null,
      primaryCreative: { ...readyCreative!, altText: "" },
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/alt text/i);
  });

  // Phase F7.3 — platform-native creative-required policy.
  //
  // Article / text-first platforms no longer block approval on a
  // missing creative. The legacy "every post needs a creative"
  // assumption is replaced by the policy module's matrix.
  describe("Phase F7.3 — creative-optional platforms approve without creative", () => {
    it("dev.to article: missing creative is NOT a blocker", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "devto",
          platformPublishIntent: {
            version: 1,
            platform: "devto",
            intent: "article",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.blockers).toHaveLength(0);
      expect(r.ok.creativeRequired).toBe(false);
      expect(r.informational).toContain(
        "Creative optional for this platform/format.",
      );
    });

    it("Hashnode article: missing creative is NOT a blocker", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "hashnode",
          platformPublishIntent: {
            version: 1,
            platform: "hashnode",
            intent: "article",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.creativeRequired).toBe(false);
    });

    it("Bluesky text post (legacy, no intent set): missing creative is NOT a blocker", () => {
      const r = assessItemApprovalReadiness({
        // Default makeItem() is bluesky + no intent — the legacy row
        // shape. Pre-F7.3 this blocked on creative_missing; post-
        // F7.3 the policy default for Bluesky is optional.
        item: makeItem(),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.creativeRequired).toBe(false);
    });

    it("Reddit text post (new_post): missing creative is NOT a blocker", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "reddit",
          platformPublishIntent: {
            version: 1,
            platform: "reddit",
            intent: "new_post",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.creativeRequired).toBe(false);
    });

    it("X text post: missing creative is NOT a blocker", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "x",
          platformPublishIntent: {
            version: 1,
            platform: "x",
            intent: "new_post",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.creativeRequired).toBe(false);
    });

    it("YouTube community post (new_post): missing creative is NOT a blocker", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "youtube",
          platformPublishIntent: {
            version: 1,
            platform: "youtube",
            intent: "new_post",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.creativeRequired).toBe(false);
    });
  });

  describe("Phase F7.3 — creative-required platforms still block", () => {
    it("Instagram: blocks even when intent is null (platform-level mandate)", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({ platform: "instagram" }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(false);
      expect(r.ok.creativeRequired).toBe(true);
      expect(r.informational).not.toContain(
        "Creative optional for this platform/format.",
      );
    });

    it("Bluesky media_post: blocks (intent-level mandate)", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platformPublishIntent: {
            version: 1,
            platform: "bluesky",
            intent: "media_post",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(false);
      expect(r.ok.creativeRequired).toBe(true);
    });

    it("YouTube video_post: blocks without creative", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "youtube",
          platformPublishIntent: {
            version: 1,
            platform: "youtube",
            intent: "video_post",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(false);
      expect(r.ok.creativeRequired).toBe(true);
    });

    it("Instagram carousel with missing alt text: still blocks", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "instagram",
          platformPublishIntent: {
            version: 1,
            platform: "instagram",
            intent: "carousel",
          } as never,
        }),
        contract: null,
        primaryCreative: { ...readyCreative!, altText: "" },
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(false);
      expect(r.blockers.join(" ")).toMatch(/alt text/i);
    });
  });

  // =====================================================================
  // Phase F7.4 — approvable platform-native publish objects
  // =====================================================================
  //
  // The legacy gate refused anything where content_type !== "post".
  // The new policy accepts every recognized platform-native publish
  // object (article, thread, link_post, etc.) AND surfaces neutral
  // copy for unrecognized content types.

  describe("Phase F7.4 — approvable platform-native publish objects", () => {
    it("dev.to article (contentType='article') can approve without creative", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "devto",
          contentType: "article",
          platformPublishIntent: {
            version: 1,
            platform: "devto",
            intent: "article",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.blockers).toHaveLength(0);
      expect(r.ok.approvableObject).toBe(true);
      expect(r.ok.creativeRequired).toBe(false);
    });

    it("Hashnode article can approve without creative", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "hashnode",
          contentType: "article",
          platformPublishIntent: {
            version: 1,
            platform: "hashnode",
            intent: "article",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.approvableObject).toBe(true);
    });

    it("Reddit link_post can approve", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "reddit",
          contentType: "link_post",
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.approvableObject).toBe(true);
    });

    it("X thread can approve", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "x",
          contentType: "thread",
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.approvableObject).toBe(true);
    });

    it("LinkedIn article can approve", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "linkedin",
          contentType: "article",
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.approvableObject).toBe(true);
    });

    it("Telegram channel_message can approve", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "telegram",
          contentType: "channel_message",
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(true);
      expect(r.ok.approvableObject).toBe(true);
    });

    it("Instagram media_post still blocks WITHOUT creative (creative-required policy)", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "instagram",
          contentType: "media_post",
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      // Approvable as an object, but the creative gate blocks.
      expect(r.ok.approvableObject).toBe(true);
      expect(r.ready).toBe(false);
      expect(r.ok.creativeRequired).toBe(true);
      expect(r.blockers.join(" ")).toMatch(/creative|missing/i);
    });

    it("YouTube video_post still blocks WITHOUT video creative", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "youtube",
          contentType: "video_post",
          platformPublishIntent: {
            version: 1,
            platform: "youtube",
            intent: "video_post",
          } as never,
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ok.approvableObject).toBe(true);
      expect(r.ready).toBe(false);
      expect(r.ok.creativeRequired).toBe(true);
    });

    it("malformed contentType → neutral copy, not approvable", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "devto",
          contentType: "random_unknown_type",
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(false);
      expect(r.ok.approvableObject).toBe(false);
      expect(r.blockers).toContain(
        "This item is not a publishable platform object yet.",
      );
      // Negative: the old hostile copy is gone.
      expect(r.blockers.join(" ")).not.toMatch(/only posts can be approved/i);
    });

    it("empty contentType + no intent → neutral copy, not approvable", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "devto",
          contentType: "",
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ok.approvableObject).toBe(false);
      expect(r.blockers).toContain(
        "This item is not a publishable platform object yet.",
      );
    });

    it("published item cannot be approved (lifecycle gate still fires)", () => {
      const r = assessItemApprovalReadiness({
        item: makeItem({
          platform: "devto",
          contentType: "article",
          status: "published",
        }),
        contract: null,
        primaryCreative: null,
        requireSchedule: false,
        requireContract: false,
      });
      expect(r.ready).toBe(false);
      expect(r.blockers.join(" ")).toMatch(/pending_approval/);
    });
  });

  it("still blocks when QA flagged the item (riskLevel='blocked')", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ riskLevel: "blocked" }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/QA blocked/);
  });

  it("ignores account-out-of-scope when requireContract is false", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ accountId: "other-acc" }),
      contract: makeContract(), // contract exists but is irrelevant
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.ready).toBe(true);
    expect(r.blockers.join(" ")).not.toMatch(/scope/i);
  });
});

// =====================================================================
// Bulk + immediate-schedule paths — requireContract: true.
// =====================================================================

describe("contract-required path — bulk and immediate schedule", () => {
  it("blocks when no active contract", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/contract/i);
    expect(r.blockers.join(" ")).toMatch(/scheduling/i);
  });

  it("ready when contract is active and item is in scope", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: true,
    });
    expect(r.ready).toBe(true);
  });

  it("blocks when account is out of contract scope", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ accountId: "other-acc" }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/Account is out of/);
  });

  it("blocks when product is out of contract scope", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ productId: "other-prod" }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/Product is out of/);
  });

  it("blocks when platform is out of contract scope", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ platform: "linkedin" }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/Platform is out of/);
  });
});

describe("schedule path (schedule required + contract required)", () => {
  it("blocks when scheduledAt is missing", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ scheduledAt: null }),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: true,
      requireContract: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/Schedule is required/);
  });

  it("ready when contract + schedule + creative are all clear", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: makeContract(),
      primaryCreative: readyCreative,
      requireSchedule: true,
      requireContract: true,
    });
    expect(r.ready).toBe(true);
  });

  it("blocks when contract is missing on schedule path", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem(),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: true,
      requireContract: true,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/contract/i);
  });
});

describe("allowedStatuses (schedule-an-approved-item path)", () => {
  it("rejects status='draft' on default (pending_approval-only) allowedStatuses", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ status: "draft" }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: false,
      requireContract: false,
    });
    expect(r.ready).toBe(false);
  });

  it("accepts status='approved' when caller passes allowedStatuses=['approved']", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ status: "approved" }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: true,
      requireContract: false,
      allowedStatuses: ["approved"],
    });
    expect(r.ready).toBe(true);
  });

  it("rejects status='pending_approval' when caller specifies allowedStatuses=['approved']", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ status: "pending_approval" }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: true,
      requireContract: false,
      allowedStatuses: ["approved"],
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/allowed/);
  });

  it("accepts status='paused' when caller passes allowedStatuses=['approved','paused'] (retry path)", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ status: "paused" }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: true,
      requireContract: false,
      allowedStatuses: ["approved", "paused"],
    });
    expect(r.ready).toBe(true);
  });

  it("rejects status='published' (terminal) even when paused is allowed", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ status: "published" }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: true,
      requireContract: false,
      allowedStatuses: ["approved", "paused"],
    });
    expect(r.ready).toBe(false);
  });

  it("rejects status='draft' even when paused is allowed", () => {
    const r = assessItemApprovalReadiness({
      item: makeItem({ status: "draft" }),
      contract: null,
      primaryCreative: readyCreative,
      requireSchedule: true,
      requireContract: false,
      allowedStatuses: ["approved", "paused"],
    });
    expect(r.ready).toBe(false);
  });
});

describe("summarizeReadiness", () => {
  it("returns ready copy when ready", () => {
    expect(
      summarizeReadiness({
        ready: true,
        blockers: [],
        informational: [],
        ok: {} as never,
      }),
    ).toBe("Ready for post approval.");
  });
  it("returns first blocker + extra count when multiple", () => {
    const s = summarizeReadiness({
      ready: false,
      blockers: ["A", "B", "C"],
      informational: [],
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
