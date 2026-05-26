import { describe, expect, it, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { weeklyPlanPrepareItem } from "./prepare-tools";
import type { ToolContext } from "../tool-context";
import type { WeeklyPlanPrepareItemArgs } from "../schemas";

/**
 * Regression tests for the policy-aware `creative_required` default.
 *
 * Pre-fix the handler defaulted `creative_required` to
 * `content_type === "post"` — so every Telegram channel post (and
 * every Bluesky text post, etc.) created via MCP got a `planned`
 * creative placeholder auto-attached. That placeholder later
 * surfaced as "Creative not ready: creative_only_planned" in the
 * UI even though the central policy says Telegram does not require
 * a creative.
 *
 * After this PR the default consults `requiresCreative` (the same
 * source of truth the UI + server-side approval already use).
 * Explicit `creative_required: true | false` still overrides the
 * default unchanged.
 */

// =====================================================================
// In-memory Supabase fake — minimal, only the surfaces the handler
// actually touches.
// =====================================================================

interface FakeStore {
  weekly_plans: Array<{ id: string; workspace_id: string; week_start: string }>;
  weekly_plan_items: Array<Record<string, unknown>>;
  weekly_plan_item_creatives: Array<Record<string, unknown>>;
  activity_events: Array<Record<string, unknown>>;
}

function emptyStore(): FakeStore {
  return {
    weekly_plans: [],
    weekly_plan_items: [],
    weekly_plan_item_creatives: [],
    activity_events: [],
  };
}

let idCounter = 0;
function fakeId(prefix: string): string {
  idCounter++;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `${prefix}-${hex}`;
}

function makeFakeClient(store: FakeStore): SupabaseClient {
  function chain(table: keyof FakeStore) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let insertRow: Record<string, unknown> | null = null;
    const api = {
      select(_cols: string) {
        return api;
      },
      eq(field: string, value: unknown) {
        filters.push((r) => r[field] === value);
        return api;
      },
      order(_field: string, _opts?: { ascending?: boolean }) {
        return api;
      },
      limit(_n: number) {
        return api;
      },
      async maybeSingle() {
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        if (insertRow !== null) {
          const row = { id: fakeId(table), ...insertRow };
          (store[table] as Record<string, unknown>[]).push(row);
          return { data: row, error: null };
        }
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        return { data: rows[0] ?? null, error: null };
      },
      then(
        resolve: (
          value: { data: null | Record<string, unknown>[]; error: null },
        ) => void,
      ) {
        // Terminal for activity_events insert.
        if (insertRow !== null) {
          const row = { id: fakeId(table), ...insertRow };
          (store[table] as Record<string, unknown>[]).push(row);
          resolve({ data: null, error: null });
          return;
        }
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        resolve({ data: rows, error: null });
      },
      insert(row: Record<string, unknown>) {
        insertRow = row;
        return api;
      },
    };
    return api;
  }
  return { from: chain } as unknown as SupabaseClient;
}

const WS = "ws-1";
const TOKEN_ID = "tok-1";

function ctxWith(store: FakeStore): ToolContext {
  return {
    workspaceId: WS,
    operatorTokenId: TOKEN_ID,
    scopes: ["weekly_plans:write_pending"],
    token: { id: TOKEN_ID, workspaceId: WS } as unknown as ToolContext["token"],
    db: makeFakeClient(store),
  };
}

function baseArgs(
  over: Partial<WeeklyPlanPrepareItemArgs> = {},
): WeeklyPlanPrepareItemArgs {
  return {
    platform: "telegram",
    title: "Telegram channel update",
    body: "Body text.",
    content_type: "post",
    ...over,
  };
}

beforeEach(() => {
  idCounter = 0;
});

// =====================================================================
// Default creative_required — driven by requiresCreative policy
// =====================================================================

describe("weeklyPlanPrepareItem — default creative_required (policy-aware)", () => {
  it("Telegram + content_type=post + no explicit flag → NO creative row inserted (regression: pre-fix auto-attached a planned placeholder)", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(ctxWith(store), baseArgs());

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_items.length).toBe(1);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("Bluesky text + content_type=post + no explicit flag → NO creative row", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({ platform: "bluesky" }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("dev.to + content_type=article + no explicit flag → NO creative row", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({ platform: "devto", content_type: "article" }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("Reddit + content_type=post + no explicit flag → NO creative row (Reddit text posts are optional)", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({ platform: "reddit" }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("Instagram + content_type=post + no explicit flag → planned creative row IS inserted (policy still requires)", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({ platform: "instagram" }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(1);
    expect(store.weekly_plan_item_creatives[0].status).toBe("planned");
    expect(store.weekly_plan_item_creatives[0].source_type).toBe("planned");
  });

  it("YouTube + intent=video_post + no explicit flag → planned creative row IS inserted", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({
        platform: "youtube",
        platform_intent: { intent: "video_post" },
      }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(1);
  });

  it("Telegram + intent=media_post + no explicit flag → planned creative row IS inserted (intent precedence: media_post requires creative on any supporting platform)", async () => {
    // Telegram is one of the platforms whose adapter accepts the
    // media_post intent (see telegram adapter's supportedIntents).
    // We use it here to prove the intent-precedence rule in the
    // policy: even though Telegram's platform-default is
    // "creative optional", an explicit media_post intent flips that
    // to required.
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({
        platform: "telegram",
        platform_intent: { intent: "media_post" },
      }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(1);
  });
});

// =====================================================================
// Explicit overrides — unchanged
// =====================================================================

describe("weeklyPlanPrepareItem — explicit creative_required overrides", () => {
  it("Telegram + creative_required: true → planned placeholder still inserted", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({ creative_required: true }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(1);
    expect(store.weekly_plan_item_creatives[0].status).toBe("planned");
  });

  it("Instagram + creative_required: false → NO creative row (policy says required, but explicit false wins)", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({ platform: "instagram", creative_required: false }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("Telegram + creative_required: true + creative fields → real creative row (not planned)", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({
        creative_required: true,
        creative_type: "image",
        creative_source_type: "uploaded",
        creative_asset_url: "https://cdn.example.com/a.jpg",
        creative_alt_text: "Channel banner",
      }),
    );

    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(1);
    expect(store.weekly_plan_item_creatives[0].status).toBe("pending_review");
    expect(store.weekly_plan_item_creatives[0].source_type).toBe("uploaded");
  });
});

// =====================================================================
// Sanity — content_type variations don't accidentally trigger creative
// =====================================================================

describe("weeklyPlanPrepareItem — content_type variations", () => {
  it("Hashnode + content_type=article + no flag → NO creative row", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({ platform: "hashnode", content_type: "article" }),
    );
    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("X + content_type=post + intent=thread + no flag → NO creative row", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({
        platform: "x",
        platform_intent: { intent: "thread" },
      }),
    );
    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });

  it("LinkedIn + content_type=post + no flag → NO creative row", async () => {
    const store = emptyStore();
    const result = await weeklyPlanPrepareItem(
      ctxWith(store),
      baseArgs({ platform: "linkedin" }),
    );
    expect(result.ok).toBe(true);
    expect(store.weekly_plan_item_creatives.length).toBe(0);
  });
});
