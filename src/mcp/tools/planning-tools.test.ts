import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// =====================================================================
// Mock the generate-draft module before importing the handlers so the
// MCP tests stay platform-engine-deterministic and don't require an
// AI provider.
// =====================================================================

const generateDraftMock = vi.fn();
vi.mock("@/core/generation/generate-draft", () => ({
  generateDraft: (...args: unknown[]) => generateDraftMock(...args),
}));

import {
  generateDraftTool,
  generateMultiweekPlanTool,
  generateWeeklyPlanTool,
  identitiesUpdateTool,
} from "./planning-tools";
import type { ToolContext } from "../tool-context";
import type {
  GenerateDraftArgs,
  GenerateMultiweekPlanArgs,
  GenerateWeeklyPlanArgs,
  IdentitiesUpdateArgs,
} from "../schemas";

// =====================================================================
// Fixtures + fake Supabase client
// =====================================================================

interface FakeStore {
  products: Array<{ id: string; workspace_id: string }>;
  growth_accounts: Array<{
    id: string;
    workspace_id: string;
    platform: string;
    handle: string | null;
    display_name: string;
    voice_profile: string | null;
    product_id: string | null;
    status: string;
    connection_status: string;
    source: string;
    review_status: string;
    created_at: string;
  }>;
  weekly_plans: Array<{ id: string; workspace_id: string; week_start: string; title: string }>;
  weekly_plan_items: Array<Record<string, unknown>>;
  activity_events: Array<Record<string, unknown>>;
}

function emptyStore(): FakeStore {
  return {
    products: [],
    growth_accounts: [],
    weekly_plans: [],
    weekly_plan_items: [],
    activity_events: [],
  };
}

let idCounter = 0;
function fakeUuid(): string {
  idCounter++;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `aaaaaaaa-bbbb-bbbb-bbbb-${hex}`;
}

function makeFakeClient(store: FakeStore): SupabaseClient {
  function chain(table: keyof FakeStore) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let insertRow: Record<string, unknown> | null = null;
    let updatePatch: Record<string, unknown> | null = null;
    const api = {
      select(_cols: string) {
        return api;
      },
      eq(field: string, value: unknown) {
        filters.push((r) => r[field] === value);
        return api;
      },
      neq(field: string, value: unknown) {
        filters.push((r) => r[field] !== value);
        return api;
      },
      is(field: string, value: unknown) {
        filters.push((r) => r[field] === value);
        return api;
      },
      in(field: string, values: unknown[]) {
        filters.push((r) => values.includes(r[field]));
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
          const row = { id: fakeUuid(), ...insertRow };
          (store[table] as Record<string, unknown>[]).push(row);
          return { data: row, error: null };
        }
        if (updatePatch !== null) {
          const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
            filters.every((f) => f(r)),
          );
          if (rows.length === 0) return { data: null, error: { message: "not_found" } };
          Object.assign(rows[0], updatePatch);
          return { data: rows[0], error: null };
        }
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        return { data: rows[0] ?? null, error: null };
      },
      // Awaitable terminal for `.in()` queries that return arrays.
      then(resolve: (value: { data: unknown[]; error: null }) => void) {
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        resolve({ data: rows, error: null });
      },
      insert(row: Record<string, unknown> | Record<string, unknown>[]) {
        if (Array.isArray(row)) {
          for (const r of row) {
            const inserted = { id: fakeUuid(), ...r };
            (store[table] as Record<string, unknown>[]).push(inserted);
          }
          return api;
        }
        insertRow = row;
        // fire-and-forget activity inserts don't await; resolve eagerly
        if (table === "activity_events") {
          const inserted = { id: fakeUuid(), ...row };
          (store[table] as Record<string, unknown>[]).push(inserted);
        }
        return api;
      },
      update(patch: Record<string, unknown>) {
        updatePatch = patch;
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
    scopes: [
      "accounts:read",
      "accounts:write_pending",
      "products:read",
      "weekly_plans:write_pending",
    ],
    token: { id: TOKEN_ID, workspaceId: WS } as unknown as ToolContext["token"],
    db: makeFakeClient(store),
  };
}

function seedIdentity(
  store: FakeStore,
  overrides: Partial<FakeStore["growth_accounts"][number]> = {},
): string {
  const id = fakeUuid();
  store.growth_accounts.push({
    id,
    workspace_id: WS,
    platform: "bluesky",
    handle: "webmasterid.bsky.social",
    display_name: "WebmasterID",
    voice_profile: null,
    product_id: null,
    status: "active",
    connection_status: "connected",
    source: "operator",
    review_status: "confirmed",
    created_at: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

function seedProduct(store: FakeStore): string {
  const id = fakeUuid();
  store.products.push({ id, workspace_id: WS });
  return id;
}

/**
 * Default mocked generateDraft response — produces a deterministic
 * envelope shaped exactly like the production PlatformNativeDraft.
 */
function defaultGeneratedResult(platform = "bluesky") {
  return {
    providerUsed: false,
    status: "manual_seed_created" as const,
    draft: {
      title: null,
      bodyMarkdown: "Calm operational test body.",
      summary: null,
      tags: [],
      ctaSuggestion: null,
      schedulePreference: null,
      generatedByProvider: false,
      safetyNotes: [],
    },
    platformNativeDraft: {
      platform,
      title: null,
      hook: "Calm operational test body.",
      body: "Calm operational test body.",
      cta: null,
      format: platform === "instagram" ? "caption" : "single_post",
      creativeDirection: {
        mediaRequired: platform === "instagram" || platform === "youtube",
        mediaType:
          platform === "youtube"
            ? "thumbnail"
            : platform === "instagram"
              ? "carousel"
              : "screenshot",
        mediaPromptOrBrief: "Operator-supplied visual brief goes here.",
        mediaRiskNotes: ["Do not invent metrics, traction, or revenue numbers."],
      },
      riskLevel: "low" as const,
      warnings: [],
      transformationNotes: ["Platform-shaped."],
    },
    similarityWarning: null,
  };
}

beforeEach(() => {
  idCounter = 0;
  generateDraftMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =====================================================================
// signal.generate_draft
// =====================================================================

describe("generateDraftTool", () => {
  it("creates a draft plan_item with platform_native_draft in metadata + activity row + review_url", async () => {
    const store = emptyStore();
    const identityId = seedIdentity(store);
    generateDraftMock.mockResolvedValueOnce(defaultGeneratedResult());

    const args: GenerateDraftArgs = {
      identity_id: identityId,
      topic: "Testing identity-scoped publishing.",
      goal: null,
      cta: null,
      source_url: null,
      tone_adjustment: null,
      schedule_preference: null,
      week_start: "2026-05-25",
    };
    const result = await generateDraftTool(ctxWith(store), args);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.requires_user_approval).toBe(true);
    expect(result.data.platform).toBe("bluesky");
    expect(typeof result.data.plan_item_id).toBe("string");
    expect(result.data.review_url).toMatch(/^\/weekly-plan\?focus=/);

    // Persisted plan_item carries the envelope under metadata.
    expect(store.weekly_plan_items.length).toBe(1);
    const item = store.weekly_plan_items[0];
    expect(item.status).toBe("draft");
    const metadata = item.metadata as Record<string, unknown>;
    expect(metadata.source).toBe("mcp_operation");
    expect(metadata.operator_token_id).toBe(TOKEN_ID);
    expect(metadata.platform_native_draft).toBeDefined();
    const pnd = metadata.platform_native_draft as Record<string, unknown>;
    expect(pnd.platform).toBe("bluesky");
    expect((pnd.creative_direction as Record<string, unknown>).media_required).toBe(false);

    // Activity row recorded.
    expect(store.activity_events.length).toBe(1);
    expect(store.activity_events[0].event_type).toBe("draft.generated");
  });

  it("refuses cross-workspace identity ids", async () => {
    const store = emptyStore();
    // Identity in a different workspace.
    store.growth_accounts.push({
      id: "cross-ws-id",
      workspace_id: "different-ws",
      platform: "bluesky",
      handle: "other",
      display_name: "Other",
      voice_profile: null,
      product_id: null,
      status: "active",
      connection_status: "connected",
      source: "operator",
      review_status: "confirmed",
      created_at: new Date().toISOString(),
    });

    const result = await generateDraftTool(ctxWith(store), {
      identity_id: "cross-ws-id",
      topic: "x",
      goal: null,
      cta: null,
      source_url: null,
      tone_adjustment: null,
      schedule_preference: null,
      week_start: null,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/identity_not_found/);
    expect(store.weekly_plan_items.length).toBe(0);
    expect(generateDraftMock).not.toHaveBeenCalled();
  });

  it("never includes platform tokens / credentials in the response", async () => {
    const store = emptyStore();
    const identityId = seedIdentity(store);
    generateDraftMock.mockResolvedValueOnce(defaultGeneratedResult());

    const result = await generateDraftTool(ctxWith(store), {
      identity_id: identityId,
      topic: "calm test",
      goal: null,
      cta: null,
      source_url: null,
      tone_adjustment: null,
      schedule_preference: null,
      week_start: null,
    });

    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("app_password");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toMatch(/\beyj[a-z0-9_-]+/);
  });
});

// =====================================================================
// signal.generate_weekly_plan
// =====================================================================

describe("generateWeeklyPlanTool", () => {
  it("fans topics across identities, producing one draft per pair", async () => {
    const store = emptyStore();
    const productId = seedProduct(store);
    const blueskyId = seedIdentity(store, { platform: "bluesky" });
    const devtoId = seedIdentity(store, {
      platform: "devto",
      handle: "webmasterid",
    });

    generateDraftMock
      .mockResolvedValueOnce(defaultGeneratedResult("bluesky"))
      .mockResolvedValueOnce(defaultGeneratedResult("bluesky"))
      .mockResolvedValueOnce(defaultGeneratedResult("devto"))
      .mockResolvedValueOnce(defaultGeneratedResult("devto"));

    const args: GenerateWeeklyPlanArgs = {
      product_id: productId,
      week_start: "2026-05-25",
      identity_ids: [blueskyId, devtoId],
      topics: [
        { topic: "Token storage rewrite", goal: null, cta: null, source_url: null },
        { topic: "Manual approval flow", goal: null, cta: null, source_url: null },
      ],
      strategic_theme: null,
      max_posts_per_platform: null,
      include_media_briefs: true,
    };
    const result = await generateWeeklyPlanTool(ctxWith(store), args);

    expect(result.ok).toBe(true);
    const items = result.data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(4);
    expect(store.weekly_plan_items.length).toBe(4);
    for (const item of store.weekly_plan_items) {
      expect(item.status).toBe("draft");
      const md = item.metadata as Record<string, unknown>;
      expect(md.platform_native_draft).toBeDefined();
    }
    expect(generateDraftMock).toHaveBeenCalledTimes(4);
  });

  it("rejects products in other workspaces", async () => {
    const store = emptyStore();
    store.products.push({ id: "other-product", workspace_id: "different-ws" });
    const identityId = seedIdentity(store);

    const result = await generateWeeklyPlanTool(ctxWith(store), {
      product_id: "other-product",
      week_start: "2026-05-25",
      identity_ids: [identityId],
      topics: [{ topic: "x", goal: null, cta: null, source_url: null }],
      strategic_theme: null,
      max_posts_per_platform: null,
      include_media_briefs: true,
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("product_not_found");
    expect(generateDraftMock).not.toHaveBeenCalled();
  });

  it("rejects unknown identities (refuses cross-workspace + missing)", async () => {
    const store = emptyStore();
    const productId = seedProduct(store);

    const result = await generateWeeklyPlanTool(ctxWith(store), {
      product_id: productId,
      week_start: "2026-05-25",
      identity_ids: ["aaaaaaaa-bbbb-bbbb-bbbb-000000000999"],
      topics: [{ topic: "x", goal: null, cta: null, source_url: null }],
      strategic_theme: null,
      max_posts_per_platform: null,
      include_media_briefs: true,
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/identities_not_found/);
    expect(generateDraftMock).not.toHaveBeenCalled();
  });

  it("enforces per-platform throttle", async () => {
    const store = emptyStore();
    const productId = seedProduct(store);
    const blueskyId = seedIdentity(store, { platform: "bluesky" });

    // Mock 2 successful generations; third call should be throttled
    // by max_posts_per_platform = 2.
    generateDraftMock
      .mockResolvedValueOnce(defaultGeneratedResult("bluesky"))
      .mockResolvedValueOnce(defaultGeneratedResult("bluesky"));

    const result = await generateWeeklyPlanTool(ctxWith(store), {
      product_id: productId,
      week_start: "2026-05-25",
      identity_ids: [blueskyId],
      topics: [
        { topic: "a", goal: null, cta: null, source_url: null },
        { topic: "b", goal: null, cta: null, source_url: null },
        { topic: "c", goal: null, cta: null, source_url: null },
      ],
      strategic_theme: null,
      max_posts_per_platform: 2,
      include_media_briefs: true,
    });

    expect(result.ok).toBe(true);
    expect((result.data.items as unknown[]).length).toBe(2);
    expect(generateDraftMock).toHaveBeenCalledTimes(2);
    expect(result.warnings.some((w) => w.includes("platform_cap_reached"))).toBe(true);
  });
});

// =====================================================================
// signal.generate_multiweek_plan
// =====================================================================

describe("generateMultiweekPlanTool", () => {
  it("creates a weekly plan + drafts per week", async () => {
    const store = emptyStore();
    const productId = seedProduct(store);
    const identityId = seedIdentity(store);

    generateDraftMock
      .mockResolvedValueOnce(defaultGeneratedResult())
      .mockResolvedValueOnce(defaultGeneratedResult());

    const args: GenerateMultiweekPlanArgs = {
      product_id: productId,
      start_date: "2026-05-25",
      number_of_weeks: 2,
      identity_ids: [identityId],
      topics_per_week: [
        { topic: "a", goal: null, cta: null, source_url: null },
      ],
      strategic_theme: "Operational publishing",
      max_posts_per_week: null,
      approval_mode: "operator_review_required",
    };
    const result = await generateMultiweekPlanTool(ctxWith(store), args);

    expect(result.ok).toBe(true);
    expect((result.data.weekly_plan_ids as string[]).length).toBe(2);
    expect((result.data.items as unknown[]).length).toBe(2);
    expect((result.data.review_urls as string[]).length).toBe(2);
    expect(store.weekly_plans.length).toBe(2);
    expect(store.weekly_plan_items.length).toBe(2);
  });
});

// =====================================================================
// signal.identities.update
// =====================================================================

describe("identitiesUpdateTool", () => {
  it("patches the supplied keys and writes an activity row", async () => {
    const store = emptyStore();
    const identityId = seedIdentity(store);

    const args: IdentitiesUpdateArgs = {
      identity_id: identityId,
      voice_profile: "Updated voice — calmer.",
      display_name: undefined, // omitted on purpose
    };
    const result = await identitiesUpdateTool(ctxWith(store), args);

    expect(result.ok).toBe(true);
    expect(result.requires_user_approval).toBe(false);
    expect(store.activity_events.length).toBe(1);
    expect(store.activity_events[0].event_type).toBe("mcp.account_profile_updated");
    expect(store.growth_accounts[0].voice_profile).toBe("Updated voice — calmer.");
  });

  it("refuses cross-workspace identities", async () => {
    const store = emptyStore();
    store.growth_accounts.push({
      id: "cross-ws",
      workspace_id: "different-ws",
      platform: "bluesky",
      handle: null,
      display_name: "Other",
      voice_profile: null,
      product_id: null,
      status: "active",
      connection_status: "connected",
      source: "operator",
      review_status: "confirmed",
      created_at: new Date().toISOString(),
    });

    const result = await identitiesUpdateTool(ctxWith(store), {
      identity_id: "cross-ws",
      voice_profile: "Should not apply.",
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("identity_not_found");
    expect(store.growth_accounts[0].voice_profile).toBeNull();
  });

  it("refuses product_id from another workspace", async () => {
    const store = emptyStore();
    const identityId = seedIdentity(store);
    store.products.push({ id: "other-product", workspace_id: "different-ws" });

    const result = await identitiesUpdateTool(ctxWith(store), {
      identity_id: identityId,
      product_id: "other-product",
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("product_id_does_not_belong_to_this_workspace");
  });
});
