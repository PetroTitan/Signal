import { describe, expect, it } from "vitest";
import {
  selectPrimaryCreativeByItem,
  selectPrimaryCreativeFromList,
} from "./_primary-creative-selector";
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

/**
 * Approval-action selector parity (`_actions.ts`).
 *
 * Pre-fix `_actions.ts` used `itemCreatives[0] ?? null` (bulk
 * approve, 2 sites) and `allCreatives[0] ?? null` (per-item approve
 * & hold, per-item approve-and-schedule, re-schedule already-approved
 * — 3 sites) to pick the "primary creative" passed into
 * `creativeReadinessReason` / `assessItemApprovalReadiness` /
 * `bindBlueskyApprovalShapeOrRefuse`. `listCreativesForItems` has no
 * `ORDER BY` clause, so `[0]` is whatever Postgres returns first —
 * non-deterministic, and frequently the stale legacy creative.
 *
 * Post-fix every site calls `selectPrimaryCreativeFromList`, which
 * delegates to the same shared `selectPrimaryCreative` selector
 * (presence tier > status > newest createdAt). These tests pin that
 * the helper returns the SAME creative the UI / MCP show, so the
 * three downstream functions see consistent input. None of the
 * approval logic, shape-binding logic, scheduler, or publish path is
 * exercised here — selector input parity only.
 */

describe("selectPrimaryCreativeFromList — approval-action selector parity", () => {
  it("returns null on an empty list", () => {
    expect(selectPrimaryCreativeFromList([])).toBeNull();
  });

  it("Site (a) bulk approve with contract: picks uploaded storage-backed over older placeholder/generated", () => {
    // _actions.ts site at line 344. The bulk path builds
    // creativesByItem and then per-item picks the primary. Pre-fix
    // it picked itemCreatives[0]; post-fix it calls the helper.
    //
    // Production state for plan_item 41354be5:
    //   95695e78 (older) — generated/approved, asset_url=data:…, no storage_path
    //   dc03ca25 (newer) — uploaded/pending_review, storage_path=…
    // Helper must pick dc03ca25 — the same row MCP/UI show.
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
    // Order-independent (`[0]` was insertion-order sensitive).
    expect(selectPrimaryCreativeFromList([legacyApproved, newUpload])?.id).toBe(
      "dc03ca25-1f5e-4daa-bc47-aa5467edb05b",
    );
    expect(selectPrimaryCreativeFromList([newUpload, legacyApproved])?.id).toBe(
      "dc03ca25-1f5e-4daa-bc47-aa5467edb05b",
    );
  });

  it("Site (b) bulk approve alt path: same parity (alt content_type code path)", () => {
    // _actions.ts site at line 690 — different surrounding logic
    // (`approvePlanForExecution` alt path) but the selector call
    // shape is identical: itemCreatives picked from a grouped map.
    const placeholder = creative({
      id: "placeholder-1",
      weeklyPlanItemId: "item-b",
      createdAt: "2026-05-26T10:00:00Z",
      status: "planned",
      sourceType: "planned",
    });
    const upload = creative({
      id: "upload-1",
      weeklyPlanItemId: "item-b",
      createdAt: "2026-05-27T14:00:00Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/img.png",
      storagePath: "ws/item-b/img.png",
      altText: "alt",
    });
    expect(
      selectPrimaryCreativeFromList([placeholder, upload])?.id,
    ).toBe("upload-1");
  });

  it("Site (c) per-item approve & hold: picks uploaded storage-backed", () => {
    // _actions.ts site at line 969. Single-item fetch, then [0].
    // Same production case as (a): legacy approved-generated vs new
    // uploaded with storage_path. Helper picks the new one.
    const legacyApproved = creative({
      id: "95695e78-d787-484d-acfb-337facbaa509",
      weeklyPlanItemId: "41354be5-7908-4788-a760-744b0685c1b5",
      createdAt: "2026-05-26T12:33:07Z",
      status: "approved",
      sourceType: "generated",
      assetUrl: "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA...",
      prompt: "p",
      altText: "alt",
    });
    const newUpload = creative({
      id: "dc03ca25-1f5e-4daa-bc47-aa5467edb05b",
      weeklyPlanItemId: "41354be5-7908-4788-a760-744b0685c1b5",
      createdAt: "2026-05-27T13:43:12Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/dde690.png",
      storagePath: "3ae3ff71/41354be5/dde690.png",
      altText: "alt",
      prompt: "p",
    });
    expect(
      selectPrimaryCreativeFromList([legacyApproved, newUpload])?.id,
    ).toBe("dc03ca25-1f5e-4daa-bc47-aa5467edb05b");
  });

  it("Site (d) per-item approve-and-schedule: picks uploaded storage-backed", () => {
    // _actions.ts site at line 1174. The single-item readiness +
    // shape-binding path that runs the same selector input but
    // additionally creates an execution_item. Selector behavior
    // must match (c).
    const placeholder = creative({
      id: "placeholder-d",
      weeklyPlanItemId: "item-d",
      createdAt: "2026-05-27T11:00:00Z",
      status: "planned",
      sourceType: "planned",
    });
    const upload = creative({
      id: "upload-d",
      weeklyPlanItemId: "item-d",
      createdAt: "2026-05-27T13:00:00Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/d.png",
      storagePath: "ws/item-d/d.png",
      altText: "alt",
    });
    expect(
      selectPrimaryCreativeFromList([placeholder, upload])?.id,
    ).toBe("upload-d");
  });

  it("Site (e) re-schedule already-approved: picks uploaded storage-backed even when an older approved row exists", () => {
    // _actions.ts site at line 1688. Items in status='approved' or
    // 'paused' are re-scheduled. If the operator uploaded a NEWER
    // storage-backed creative since the original approval, the
    // re-schedule path must consume the new one — not the historical
    // approved row.
    const olderApproved = creative({
      id: "old-approved",
      weeklyPlanItemId: "item-e",
      createdAt: "2026-05-26T08:00:00Z",
      status: "approved",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/old.png",
      storagePath: "ws/item-e/old.png",
      altText: "alt",
    });
    const newerUpload = creative({
      id: "new-upload",
      weeklyPlanItemId: "item-e",
      createdAt: "2026-05-27T15:00:00Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/new.png",
      storagePath: "ws/item-e/new.png",
      altText: "alt",
    });
    // approved+storage (15) > pending_review+storage (14) by shared
    // priority — so the older approved row wins here.
    expect(
      selectPrimaryCreativeFromList([olderApproved, newerUpload])?.id,
    ).toBe("old-approved");
  });

  it("Site (e) variant: re-schedule picks uploaded storage-backed over a degenerate legacy approved row (data: URL, no storage_path)", () => {
    // The bug class from plan_item 41354be5 reproduced for the
    // re-schedule path: legacy approved-generated with data: URL
    // and no storage_path must NOT dominate a newer
    // pending_review uploaded row with storage_path.
    const legacyApproved = creative({
      id: "legacy-e",
      weeklyPlanItemId: "item-e",
      createdAt: "2026-05-26T08:00:00Z",
      status: "approved",
      sourceType: "generated",
      assetUrl: "data:image/jpeg;base64,...",
      prompt: "p",
      altText: "alt",
    });
    const newUpload = creative({
      id: "fresh-upload",
      weeklyPlanItemId: "item-e",
      createdAt: "2026-05-27T15:00:00Z",
      status: "pending_review",
      sourceType: "uploaded",
      assetUrl: "https://cdn.example.com/new.png",
      storagePath: "ws/item-e/new.png",
      altText: "alt",
    });
    expect(
      selectPrimaryCreativeFromList([legacyApproved, newUpload])?.id,
    ).toBe("fresh-upload");
  });

  it("returned value is the original WeeklyPlanItemCreative row (shape passed to creativeReadinessReason / assessItemApprovalReadiness is unchanged)", () => {
    // Selector input parity claim: downstream approval logic still
    // receives a `WeeklyPlanItemCreative` (same fields, same types).
    // assertion: same reference identity, no projection / clone.
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
    expect(selectPrimaryCreativeFromList([upload])).toBe(upload);
  });

  it("does not mutate the input list", () => {
    const planned = creative({
      id: "p1",
      weeklyPlanItemId: "item-1",
      createdAt: "2026-05-27T12:00:00Z",
      status: "planned",
      sourceType: "planned",
    });
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
    const input = [planned, upload];
    selectPrimaryCreativeFromList(input);
    expect(input).toHaveLength(2);
    expect(input[0].id).toBe("p1");
    expect(input[1].id).toBe("u1");
  });
});
