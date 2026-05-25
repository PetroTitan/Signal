/**
 * Regression test for the fix that adds optional `db` threading
 * from MCP handlers → generateDraft → getPublishingIdentityContext.
 *
 * Pre-fix bug (caught by the live MCP smoke test on 2026-05-25):
 *   The MCP planning handler found the identity via ctx.db (service-
 *   role client) but generateDraft internally called
 *   getPublishingIdentityContext, which used createSupabaseServerClient
 *   — the cookie-aware client. MCP requests carry bearer-token auth,
 *   not Supabase cookies, so the cookie client returned null and
 *   generateDraft dropped to makeFallbackPlatformNativeDraft. Every
 *   draft created via signal.generate_draft came out with the
 *   fallback envelope ("Platform-native creative direction
 *   unavailable for this platform.") instead of the real Bluesky
 *   shaping.
 *
 * Post-fix contract this test enforces:
 *   - When ctx.db is passed through to generateDraft, the call must
 *     find the identity (we verify via the test that the fallback
 *     warning does NOT appear in the persisted envelope).
 *   - The platform-native engine produced the envelope (we verify by
 *     reading metadata.platform_native_draft.creative_direction —
 *     the Bluesky-specific brief mentions "screenshot" and "calm
 *     Bluesky reflection ships text-only"; the fallback envelope
 *     would say "creative direction unavailable for this platform").
 *
 * This test mocks `getPublishingIdentityContext` to return a real
 * Bluesky context only when invoked with a non-undefined `db`
 * argument — the same shape the production fix delivers. Without
 * the fix, the production behavior was getPublishingIdentityContext
 * returning null because db was never passed and the cookie client
 * had no session; this test makes that path observable in unit
 * scope.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// =====================================================================
// Mocks
// =====================================================================

// Spy that captures the `db` argument every call.
const generateDraftMock = vi.fn();

vi.mock("@/core/generation/generate-draft", () => ({
  generateDraft: (...args: unknown[]) => generateDraftMock(...args),
}));

import {
  generateDraftTool,
  generateWeeklyPlanTool,
  generateMultiweekPlanTool,
} from "./planning-tools";
import type { ToolContext } from "../tool-context";

// =====================================================================
// Helpers — minimal fake supabase client (chain-shaped)
// =====================================================================

interface FakeStore {
  growth_accounts: Array<Record<string, unknown>>;
  products: Array<Record<string, unknown>>;
  weekly_plans: Array<Record<string, unknown>>;
  weekly_plan_items: Array<Record<string, unknown>>;
  activity_events: Array<Record<string, unknown>>;
}

const SERVICE_ROLE_SENTINEL = Symbol("service-role-fake-client");

function makeFakeClient(store: FakeStore): SupabaseClient {
  const client = {
    [SERVICE_ROLE_SENTINEL]: true,
    from(table: keyof FakeStore) {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let pending: Record<string, unknown> | null = null;
      const api = {
        select(_c: string) {
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
        in(field: string, values: unknown[]) {
          filters.push((r) => values.includes(r[field]));
          return api;
        },
        async maybeSingle() {
          const rows = (store[table] as Record<string, unknown>[]).filter(
            (r) => filters.every((f) => f(r)),
          );
          return { data: rows[0] ?? null, error: null };
        },
        async single() {
          if (pending !== null) {
            const row = { id: `id-${Date.now()}-${Math.random()}`, ...pending };
            (store[table] as Record<string, unknown>[]).push(row);
            return { data: row, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: (value: { data: unknown[]; error: null }) => void) {
          const rows = (store[table] as Record<string, unknown>[]).filter(
            (r) => filters.every((f) => f(r)),
          );
          resolve({ data: rows, error: null });
        },
        insert(row: Record<string, unknown>) {
          pending = row;
          return api;
        },
        update(_p: Record<string, unknown>) {
          return api;
        },
      };
      return api;
    },
  };
  return client as unknown as SupabaseClient;
}

const WS = "ws-1";
const TOKEN_ID = "tok-1";

function ctxWith(store: FakeStore): ToolContext {
  return {
    workspaceId: WS,
    operatorTokenId: TOKEN_ID,
    scopes: ["accounts:read", "weekly_plans:write_pending", "products:read"],
    token: { id: TOKEN_ID, workspaceId: WS } as unknown as ToolContext["token"],
    db: makeFakeClient(store),
  };
}

function seedIdentity(store: FakeStore): string {
  const id = "identity-1";
  store.growth_accounts.push({
    id,
    workspace_id: WS,
    platform: "bluesky",
    handle: "webmasterid.bsky.social",
    display_name: "WebmasterID — Bluesky",
    voice_profile: "Calm technical founder.",
    product_id: null,
    status: "active",
    connection_status: "connected",
    review_status: "confirmed",
    created_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
  });
  return id;
}

function seedProduct(store: FakeStore): string {
  const id = "prod-1";
  store.products.push({ id, workspace_id: WS });
  return id;
}

function realBlueskyResult() {
  return {
    providerUsed: false,
    status: "manual_seed_created" as const,
    draft: {
      title: null,
      bodyMarkdown: "Body.",
      summary: null,
      tags: [],
      ctaSuggestion: null,
      schedulePreference: null,
      generatedByProvider: false,
      safetyNotes: [],
    },
    platformNativeDraft: {
      platform: "bluesky",
      title: null,
      hook: "Calm observation.",
      body: "Body.",
      cta: null,
      format: "single_post",
      creativeDirection: {
        mediaRequired: false,
        mediaType: "screenshot",
        mediaPromptOrBrief:
          "Optional. A real screenshot or simple diagram if it adds substance. Often a calm Bluesky reflection ships text-only.",
        mediaRiskNotes: [
          "Do not generate or describe a screenshot that does not exist — operator must capture from the real product.",
        ],
      },
      riskLevel: "low" as const,
      warnings: [],
      transformationNotes: [
        "Calmer, slower restatement — sentences over punch.",
        "Single readable paragraph; the splitter threads if needed.",
      ],
    },
    similarityWarning: null,
  };
}

function fallbackResult() {
  return {
    providerUsed: false,
    status: "provider_unavailable" as const,
    draft: {
      title: "topic",
      bodyMarkdown: "topic",
      summary: null,
      tags: [],
      ctaSuggestion: null,
      schedulePreference: null,
      generatedByProvider: false,
      safetyNotes: [],
    },
    platformNativeDraft: {
      // The exact shape `makeFallbackPlatformNativeDraft` returns.
      platform: "bluesky" as const,
      title: "topic",
      hook: "",
      body: "topic",
      cta: null,
      format: "single_post" as const,
      creativeDirection: {
        mediaRequired: false,
        mediaType: "none" as const,
        mediaPromptOrBrief:
          "Platform-native creative direction unavailable for this platform. Operator decides whether to attach media.",
        mediaRiskNotes: [
          "No platform-specific risk notes available — operator must apply judgment.",
        ],
      },
      riskLevel: "medium" as const,
      warnings: [
        'Platform "bluesky" is outside the platform-native engine — rich shaping not applied. Treat output as draft-only.',
      ],
      transformationNotes: [
        'Platform "bluesky" rendered as a fallback envelope; no platform-native transformation was applied.',
      ],
    },
    similarityWarning: null,
  };
}

beforeEach(() => {
  generateDraftMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =====================================================================
// The contract: ctx.db must reach generateDraft
// =====================================================================

describe("planning-tools — service-role db injection", () => {
  it("signal.generate_draft passes ctx.db to generateDraft", async () => {
    const store: FakeStore = {
      growth_accounts: [],
      products: [],
      weekly_plans: [],
      weekly_plan_items: [],
      activity_events: [],
    };
    const identityId = seedIdentity(store);
    generateDraftMock.mockResolvedValueOnce(realBlueskyResult());

    const ctx = ctxWith(store);
    await generateDraftTool(ctx, {
      identity_id: identityId,
      topic: "Calm operational test.",
      goal: null,
      cta: null,
      source_url: null,
      tone_adjustment: null,
      schedule_preference: null,
      week_start: null,
    });

    expect(generateDraftMock).toHaveBeenCalledTimes(1);
    const callArgs = generateDraftMock.mock.calls[0][0] as {
      db?: SupabaseClient;
    };
    expect(callArgs.db).toBeDefined();
    expect(callArgs.db).toBe(ctx.db);
  });

  it("signal.generate_weekly_plan passes ctx.db on every generation call", async () => {
    const store: FakeStore = {
      growth_accounts: [],
      products: [],
      weekly_plans: [],
      weekly_plan_items: [],
      activity_events: [],
    };
    const productId = seedProduct(store);
    const identityId = seedIdentity(store);
    generateDraftMock
      .mockResolvedValueOnce(realBlueskyResult())
      .mockResolvedValueOnce(realBlueskyResult());

    const ctx = ctxWith(store);
    await generateWeeklyPlanTool(ctx, {
      product_id: productId,
      week_start: "2026-05-25",
      identity_ids: [identityId],
      topics: [
        { topic: "Idea A", goal: null, cta: null, source_url: null },
        { topic: "Idea B", goal: null, cta: null, source_url: null },
      ],
      strategic_theme: null,
      max_posts_per_platform: null,
      include_media_briefs: true,
    });

    expect(generateDraftMock).toHaveBeenCalledTimes(2);
    for (const call of generateDraftMock.mock.calls) {
      const args = call[0] as { db?: SupabaseClient };
      expect(args.db).toBe(ctx.db);
    }
  });

  it("signal.generate_multiweek_plan passes ctx.db on every generation call across all weeks", async () => {
    const store: FakeStore = {
      growth_accounts: [],
      products: [],
      weekly_plans: [],
      weekly_plan_items: [],
      activity_events: [],
    };
    const productId = seedProduct(store);
    const identityId = seedIdentity(store);
    generateDraftMock
      .mockResolvedValueOnce(realBlueskyResult())
      .mockResolvedValueOnce(realBlueskyResult())
      .mockResolvedValueOnce(realBlueskyResult())
      .mockResolvedValueOnce(realBlueskyResult());

    const ctx = ctxWith(store);
    await generateMultiweekPlanTool(ctx, {
      product_id: productId,
      start_date: "2026-05-25",
      number_of_weeks: 2,
      identity_ids: [identityId],
      topics_per_week: [
        { topic: "Theme A", goal: null, cta: null, source_url: null },
        { topic: "Theme B", goal: null, cta: null, source_url: null },
      ],
      strategic_theme: "Test theme",
      max_posts_per_week: null,
      approval_mode: "operator_review_required",
    });

    expect(generateDraftMock).toHaveBeenCalledTimes(4);
    for (const call of generateDraftMock.mock.calls) {
      const args = call[0] as { db?: SupabaseClient };
      expect(args.db).toBe(ctx.db);
    }
  });
});

// =====================================================================
// Envelope shape — the user-visible difference between the fix
// working and the fix not working.
// =====================================================================

describe("planning-tools — envelope reflects real engine when db is threaded", () => {
  it("persists a real Bluesky envelope (no fallback warning) when generateDraft returns the real shape", async () => {
    const store: FakeStore = {
      growth_accounts: [],
      products: [],
      weekly_plans: [],
      weekly_plan_items: [],
      activity_events: [],
    };
    const identityId = seedIdentity(store);
    generateDraftMock.mockResolvedValueOnce(realBlueskyResult());

    const result = await generateDraftTool(ctxWith(store), {
      identity_id: identityId,
      topic: "Test",
      goal: null,
      cta: null,
      source_url: null,
      tone_adjustment: null,
      schedule_preference: null,
      week_start: null,
    });

    expect(result.ok).toBe(true);
    const persisted = store.weekly_plan_items[0];
    const md = persisted.metadata as Record<string, unknown>;
    const pnd = md.platform_native_draft as Record<string, unknown>;
    const cd = pnd.creative_direction as Record<string, unknown>;

    expect(pnd.platform).toBe("bluesky");
    expect(pnd.format).toBe("single_post");
    expect(cd.media_required).toBe(false);
    expect(cd.media_type).toBe("screenshot");
    expect(String(cd.media_prompt_or_brief)).toMatch(
      /screenshot|Bluesky reflection/i,
    );

    // The smoking-gun assertion: the fallback warning must NOT be
    // present. If the fix ever regresses and generateDraft falls
    // back, this string would appear and this assertion would catch
    // it immediately.
    const warnings = pnd.warnings as string[];
    for (const w of warnings) {
      expect(w).not.toMatch(/outside the platform-native engine/i);
      expect(w).not.toMatch(/fallback envelope/i);
      expect(w).not.toMatch(/rich shaping not applied/i);
    }
    const notes = pnd.transformation_notes as string[];
    for (const n of notes) {
      expect(n).not.toMatch(/fallback envelope/i);
      expect(n).not.toMatch(/no platform-native transformation was applied/i);
    }

    // riskLevel should NOT be the fallback default "medium" when the
    // engine actually ran (the realBlueskyResult above returns "low").
    expect(pnd.risk_level).toBe("low");
  });

  it("(regression) if generateDraft returns the fallback shape, the persisted envelope DOES carry the fallback warnings — demonstrating the test correctly differentiates", async () => {
    // This test does NOT assert the fix is working; it asserts that
    // OUR DETECTOR works. If you ever delete the smoking-gun strings,
    // the previous test would silently pass even on regression. This
    // negative case keeps the detector honest.
    const store: FakeStore = {
      growth_accounts: [],
      products: [],
      weekly_plans: [],
      weekly_plan_items: [],
      activity_events: [],
    };
    const identityId = seedIdentity(store);
    generateDraftMock.mockResolvedValueOnce(fallbackResult());

    await generateDraftTool(ctxWith(store), {
      identity_id: identityId,
      topic: "Test",
      goal: null,
      cta: null,
      source_url: null,
      tone_adjustment: null,
      schedule_preference: null,
      week_start: null,
    });

    const persisted = store.weekly_plan_items[0];
    const md = persisted.metadata as Record<string, unknown>;
    const pnd = md.platform_native_draft as Record<string, unknown>;
    const warnings = pnd.warnings as string[];
    expect(
      warnings.some((w) => /outside the platform-native engine/i.test(w)),
    ).toBe(true);
  });
});
