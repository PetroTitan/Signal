import { describe, expect, it } from "vitest";
import { selectPrimaryCreativeByItem } from "./_primary-creative-selector";
import type { WeeklyPlanItemCreative } from "@/repositories/weekly-plan-creative-repository";

/**
 * UI / MCP selector-parity regression.
 *
 * Pre-fix `page.tsx` looped over `listCreativesForItems` and kept the
 * first row per `weeklyPlanItemId`. Codex confirmed that diverged
 * from `signal.weekly_plan.current`, which uses the shared
 * asset-aware selector. Example: plan_item 41354be5 had a legacy
 * `generated/approved` row (asset_url = `data:image/jpeg;base64,…`,
 * no storage_path) and a newer `uploaded/pending_review` row with
 * the canonical workspace `storage_path`. MCP picked the uploaded
 * row; the UI picked the legacy one.
 *
 * This test pins the helper to the SAME selector MCP uses.
 */

function creative(
  over: Partial<WeeklyPlanItemCreative> & {
    id: string;
    weeklyPlanItemId: string;
    createdAt: string;
  },
): WeeklyPlanItemCreative {
  return {
    workspaceId: "ws-1",
    creativeType: "image",
    sourceType: "planned",
    sourceUrl: null,
    assetUrl: null,
    storagePath: null,
    prompt: null,
    altText: null,
    license: null,
    attribution: null,
    riskNotes: null,
    status: "planned",
    mimeType: null,
    sizeBytes: null,
    uploadedBy: null,
    uploadedAt: null,
    metadata: {},
    updatedAt: over.createdAt,
    ...over,
  };
}

describe("selectPrimaryCreativeByItem", () => {
  it("returns an empty map when given no creatives", () => {
    expect(selectPrimaryCreativeByItem([]).size).toBe(0);
  });

  it("REGRESSION (plan_item 41354be5): legacy generated/approved with data: asset_url loses to uploaded/pending_review with storage_path", () => {
    // Exact production state for the Bluesky item that diverged
    // between MCP and the UI:
    //   95695e78 — generated/approved, asset_url=data:image/jpeg;base64,…, no storage_path
    //   dc03ca25 — uploaded/pending_review, asset_url=Supabase URL, storage_path=…
    const legacyApproved = creative({
      id: "95695e78-d787-484d-acfb-337facbaa509",
      weeklyPlanItemId: "41354be5-7908-4788-a760-744b0685c1b5",
      createdAt: "2026-05-26T12:33:07Z",
      status: "approved",
      sourceType: "generated",
      assetUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA...",
      prompt: "A landscape photo",
      altText: "alt",
    });
    const newUpload = creative({
      id: "dc03ca25-1f5e-4daa-bc47-aa5467edb05b",
      weeklyPlanItemId: "41354be5-7908-4788-a760-744b0685c1b5",
      createdAt: "2026-05-27T13:43:12Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl:
        "https://kcaxqzbnrxzqisewbdkf.supabase.co/storage/v1/object/public/weekly-plan-creatives/3ae3ff71/41354be5/dde690.png",
      storagePath: "3ae3ff71/41354be5/dde690.png",
      altText: "alt",
      prompt: "A landscape photo",
    });

    const byItem = selectPrimaryCreativeByItem([legacyApproved, newUpload]);

    expect(byItem.get("41354be5-7908-4788-a760-744b0685c1b5")?.id).toBe(
      "dc03ca25-1f5e-4daa-bc47-aa5467edb05b",
    );
    // Order-independent (pre-fix code relied on insertion order).
    const byItemReversed = selectPrimaryCreativeByItem([newUpload, legacyApproved]);
    expect(byItemReversed.get("41354be5-7908-4788-a760-744b0685c1b5")?.id).toBe(
      "dc03ca25-1f5e-4daa-bc47-aa5467edb05b",
    );
  });

  it("groups multiple plan_items independently", () => {
    const itemA = creative({
      id: "a1",
      weeklyPlanItemId: "item-a",
      createdAt: "2026-05-27T12:00:00Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/a.png",
      storagePath: "ws-1/item-a/a.png",
      altText: "alt",
    });
    const itemB = creative({
      id: "b1",
      weeklyPlanItemId: "item-b",
      createdAt: "2026-05-27T12:00:00Z",
      status: "approved",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/b.png",
      storagePath: "ws-1/item-b/b.png",
      altText: "alt",
    });
    const byItem = selectPrimaryCreativeByItem([itemA, itemB]);
    expect(byItem.size).toBe(2);
    expect(byItem.get("item-a")?.id).toBe("a1");
    expect(byItem.get("item-b")?.id).toBe("b1");
  });

  it("prefers storage-backed uploaded over older planned placeholder", () => {
    // The single-item base case from the previous MCP fix: a planned
    // placeholder + a real upload — upload wins.
    const planned = creative({
      id: "planned-1",
      weeklyPlanItemId: "item-1",
      createdAt: "2026-05-27T12:00:00Z",
      status: "planned",
      sourceType: "planned",
    });
    const uploaded = creative({
      id: "uploaded-1",
      weeklyPlanItemId: "item-1",
      createdAt: "2026-05-27T13:00:00Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/a.png",
      storagePath: "ws-1/item-1/a.png",
      altText: "alt",
    });
    const byItem = selectPrimaryCreativeByItem([planned, uploaded]);
    expect(byItem.get("item-1")?.id).toBe("uploaded-1");
  });

  it("returned values are the original WeeklyPlanItemCreative rows (downstream UI shape preserved)", () => {
    // Downstream PlanItemCard / CreativeCard consume the full row,
    // not a projection. Pin the shape so a future refactor that
    // changes the helper's return type fails loudly.
    const upload = creative({
      id: "u1",
      weeklyPlanItemId: "item-1",
      createdAt: "2026-05-27T13:00:00Z",
      status: "approved",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/a.png",
      storagePath: "ws-1/item-1/a.png",
      altText: "alt",
      metadata: { aspect_ratio: "16:9" },
    });
    const byItem = selectPrimaryCreativeByItem([upload]);
    const got = byItem.get("item-1");
    expect(got).toBe(upload);
    expect(got?.metadata).toEqual({ aspect_ratio: "16:9" });
  });

  it("does not mutate the input array", () => {
    const upload = creative({
      id: "u1",
      weeklyPlanItemId: "item-1",
      createdAt: "2026-05-27T13:00:00Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/a.png",
      storagePath: "ws-1/item-1/a.png",
      altText: "alt",
    });
    const planned = creative({
      id: "p1",
      weeklyPlanItemId: "item-1",
      createdAt: "2026-05-27T12:00:00Z",
      status: "planned",
      sourceType: "planned",
    });
    const input = [planned, upload];
    selectPrimaryCreativeByItem(input);
    expect(input).toHaveLength(2);
    expect(input[0].id).toBe("p1");
    expect(input[1].id).toBe("u1");
  });
});
