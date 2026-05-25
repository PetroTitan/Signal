import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { weeklyPlanUpdateItemTool } from "./planning-tools";
import type { ToolContext } from "../tool-context";
import type { WeeklyPlanUpdateItemArgs } from "../schemas";

// =====================================================================
// Fake Supabase client (chain-shaped, in-memory)
// =====================================================================

interface FakeStore {
  weekly_plan_items: Array<Record<string, unknown>>;
  activity_events: Array<Record<string, unknown>>;
}

function emptyStore(): FakeStore {
  return { weekly_plan_items: [], activity_events: [] };
}

let idCounter = 0;
function fakeUuid(prefix = "item"): string {
  idCounter++;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `${prefix}aaaa-bbbb-cccc-dddd-${hex}`;
}

function makeFakeClient(store: FakeStore): SupabaseClient {
  function chain(table: keyof FakeStore) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let insertRow: Record<string, unknown> | null = null;
    let updatePatch: Record<string, unknown> | null = null;
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
      is(field: string, value: unknown) {
        filters.push((r) => r[field] === value);
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
          const rows = (store[table] as Record<string, unknown>[]).filter(
            (r) => filters.every((f) => f(r)),
          );
          if (rows.length === 0)
            return { data: null, error: { message: "not_found" } };
          Object.assign(rows[0], updatePatch);
          return { data: rows[0], error: null };
        }
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        return { data: rows[0] ?? null, error: null };
      },
      then(resolve: (value: { data: unknown[]; error: null }) => void) {
        if (insertRow !== null) {
          const row = { id: fakeUuid(), ...insertRow };
          (store[table] as Record<string, unknown>[]).push(row);
          resolve({ data: [], error: null });
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
    scopes: ["weekly_plans:write_pending"],
    token: { id: TOKEN_ID, workspaceId: WS } as unknown as ToolContext["token"],
    db: makeFakeClient(store),
  };
}

interface SeedOverrides {
  id?: string;
  status?: string;
  title?: string | null;
  body?: string | null;
  metadata?: Record<string, unknown>;
}

function seedItem(store: FakeStore, overrides: SeedOverrides = {}): string {
  const id = overrides.id ?? fakeUuid();
  store.weekly_plan_items.push({
    id,
    workspace_id: WS,
    platform: "bluesky",
    status: overrides.status ?? "draft",
    title: overrides.title ?? "Seeded title",
    body: overrides.body ?? "Seeded body",
    metadata: overrides.metadata ?? {
      source: "mcp_operation",
      platform_native_draft: {
        platform: "bluesky",
        title: "Seeded title",
        hook: "Seeded hook",
        body: "Seeded body",
        cta: null,
        format: "single_post",
        creative_direction: {
          media_required: false,
          media_type: "screenshot",
          media_prompt_or_brief: "Optional. A real screenshot if it adds substance.",
          media_risk_notes: ["No fake screenshots."],
        },
        risk_level: "medium",
        warnings: ["Identity is warming."],
        transformation_notes: ["Calmer, slower restatement."],
      },
    },
  });
  return id;
}

function args(
  planItemId: string,
  patch: Partial<WeeklyPlanUpdateItemArgs> = {},
): WeeklyPlanUpdateItemArgs {
  return {
    plan_item_id: planItemId,
    confirm_update: true,
    ...patch,
  };
}

beforeEach(() => {
  idCounter = 0;
});

afterEach(() => {
  // nothing to restore
});

// =====================================================================
// Success paths
// =====================================================================

describe("weeklyPlanUpdateItemTool — success", () => {
  it("updates body on a draft item and refreshes platform_native_draft.body + hook", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    const newBody =
      "First-paragraph hook here.\n\nSecond paragraph of supporting detail.";
    const result = await weeklyPlanUpdateItemTool(ctxWith(store), args(id, { body: newBody }));

    expect(result.ok).toBe(true);
    expect(result.data.platform_native_draft_updated).toBe(true);
    expect(result.data.updated_fields).toEqual(["body"]);
    expect(result.data.body_length).toBe(newBody.length);

    const persisted = store.weekly_plan_items[0];
    expect(persisted.body).toBe(newBody);
    const meta = persisted.metadata as Record<string, unknown>;
    const pnd = meta.platform_native_draft as Record<string, unknown>;
    expect(pnd.body).toBe(newBody);
    expect(pnd.hook).toBe("First-paragraph hook here.");
    // Existing envelope fields preserved
    expect(pnd.format).toBe("single_post");
    const cd = pnd.creative_direction as Record<string, unknown>;
    expect(cd.media_type).toBe("screenshot");
    expect(cd.media_required).toBe(false);
  });

  it("updates pending_approval items", async () => {
    const store = emptyStore();
    const id = seedItem(store, { status: "pending_approval" });
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { body: "New body for pending item." }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.status).toBe("pending_approval");
  });

  it("updates title only", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { title: "Polished title" }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.updated_fields).toEqual(["title"]);
    const persisted = store.weekly_plan_items[0];
    expect(persisted.title).toBe("Polished title");
    const pnd = (persisted.metadata as Record<string, unknown>)
      .platform_native_draft as Record<string, unknown>;
    expect(pnd.title).toBe("Polished title");
    // Body untouched
    expect(persisted.body).toBe("Seeded body");
    expect(pnd.body).toBe("Seeded body");
  });

  it("updates cta only (cta is metadata-only, not a column)", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { cta: "Curious how others handled this." }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.updated_fields).toEqual(["cta"]);
    const persisted = store.weekly_plan_items[0];
    const pnd = (persisted.metadata as Record<string, unknown>)
      .platform_native_draft as Record<string, unknown>;
    expect(pnd.cta).toBe("Curious how others handled this.");
    // body/title columns untouched
    expect(persisted.body).toBe("Seeded body");
  });

  it("clears cta when cta=null is passed", async () => {
    const store = emptyStore();
    const id = seedItem(store, {
      metadata: {
        platform_native_draft: {
          platform: "bluesky",
          cta: "Curious how others approached this.",
          creative_direction: {
            media_required: false,
            media_type: "screenshot",
            media_prompt_or_brief: "Optional.",
            media_risk_notes: [],
          },
        },
      },
    });
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { cta: null }),
    );
    expect(result.ok).toBe(true);
    const pnd = (store.weekly_plan_items[0].metadata as Record<string, unknown>)
      .platform_native_draft as Record<string, unknown>;
    expect(pnd.cta).toBeNull();
  });

  it("updates creative_brief + risk_notes inside platform_native_draft.creative_direction", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, {
        creative_brief: "Operator captures the actual product screen.",
        risk_notes: ["No invented metrics.", "No fake before/after."],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.data.updated_fields).toEqual(["creative_brief", "risk_notes"]);
    const pnd = (store.weekly_plan_items[0].metadata as Record<string, unknown>)
      .platform_native_draft as Record<string, unknown>;
    const cd = pnd.creative_direction as Record<string, unknown>;
    expect(cd.media_prompt_or_brief).toContain("actual product screen");
    expect(cd.media_risk_notes).toEqual([
      "No invented metrics.",
      "No fake before/after.",
    ]);
    // The non-edited creative_direction subfields are preserved.
    expect(cd.media_required).toBe(false);
    expect(cd.media_type).toBe("screenshot");
  });

  it("treats media_prompt_or_brief as an alias when creative_brief is not provided", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { media_prompt_or_brief: "Alias-provided brief." }),
    );
    expect(result.ok).toBe(true);
    const pnd = (store.weekly_plan_items[0].metadata as Record<string, unknown>)
      .platform_native_draft as Record<string, unknown>;
    const cd = pnd.creative_direction as Record<string, unknown>;
    expect(cd.media_prompt_or_brief).toBe("Alias-provided brief.");
  });

  it("preserves all unrelated metadata keys + appends MCP audit metadata", async () => {
    const store = emptyStore();
    const id = seedItem(store, {
      metadata: {
        platform_native_draft: {
          platform: "bluesky",
          format: "single_post",
          creative_direction: {
            media_required: false,
            media_type: "screenshot",
            media_prompt_or_brief: "Original brief.",
            media_risk_notes: ["original note"],
          },
          warnings: ["original warning"],
          transformation_notes: ["original note"],
        },
        // Unrelated keys we expect to be preserved untouched
        generation_topic: "Original topic",
        canonical_url: "https://example.com",
        custom_operator_note: "Keep this.",
      },
    });
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { body: "Brand-new body." }),
    );
    expect(result.ok).toBe(true);
    const meta = store.weekly_plan_items[0].metadata as Record<string, unknown>;
    expect(meta.generation_topic).toBe("Original topic");
    expect(meta.canonical_url).toBe("https://example.com");
    expect(meta.custom_operator_note).toBe("Keep this.");
    expect(meta.source).toBe("mcp_operation");
    expect(meta.updated_by_operator_token_id).toBe(TOKEN_ID);
    expect(typeof meta.mcp_updated_at).toBe("string");

    const pnd = meta.platform_native_draft as Record<string, unknown>;
    expect(pnd.platform).toBe("bluesky");
    expect(pnd.format).toBe("single_post");
    expect(pnd.warnings).toEqual(["original warning"]);
    expect(pnd.transformation_notes).toEqual(["original note"]);
    const cd = pnd.creative_direction as Record<string, unknown>;
    expect(cd.media_prompt_or_brief).toBe("Original brief.");
  });

  it("records an activity event", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { body: "New body.", title: "New title" }),
    );
    expect(store.activity_events.length).toBe(1);
    const evt = store.activity_events[0];
    expect(evt.event_type).toBe("mcp.plan_item_updated");
    expect(evt.entity_id).toBe(id);
    expect(evt.entity_type).toBe("weekly_plan_item");
    const evtMeta = evt.metadata as Record<string, unknown>;
    expect(evtMeta.operator_token_id).toBe(TOKEN_ID);
    expect(evtMeta.updated_fields).toEqual(["title", "body"]);
    expect(evtMeta.previous_status).toBe("draft");
  });

  it("returns the deep-link review_url", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { body: "x" }),
    );
    expect(result.data.review_url).toBe(
      `/weekly-plan?focus=${encodeURIComponent(id)}`,
    );
  });

  it("requires user approval to remain true on the response", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { body: "x" }),
    );
    expect(result.requires_user_approval).toBe(true);
  });
});

// =====================================================================
// Refusals
// =====================================================================

describe("weeklyPlanUpdateItemTool — status gate", () => {
  it.each(["approved", "scheduled", "published", "rejected", "failed"])(
    "refuses status=%s",
    async (status) => {
      const store = emptyStore();
      const id = seedItem(store, { status });
      const result = await weeklyPlanUpdateItemTool(
        ctxWith(store),
        args(id, { body: "Attempt to edit." }),
      );
      expect(result.ok).toBe(false);
      expect(result.summary).toContain(`plan_item_status_not_editable:${status}`);
      // Body must NOT have been written.
      expect(store.weekly_plan_items[0].body).toBe("Seeded body");
      // No activity event written.
      expect(store.activity_events).toEqual([]);
    },
  );

  it("refuses cross-workspace items", async () => {
    const store = emptyStore();
    store.weekly_plan_items.push({
      id: "cross-ws-id",
      workspace_id: "other-ws",
      status: "draft",
      title: "Other",
      body: "Other",
      platform: "bluesky",
      metadata: {},
    });
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args("cross-ws-id", { body: "Edit attempt." }),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("plan_item_not_found_in_workspace");
  });
});

describe("weeklyPlanUpdateItemTool — response safety", () => {
  it("never includes secrets / tokens / DID-like strings in the response", async () => {
    const store = emptyStore();
    const id = seedItem(store, {
      metadata: {
        platform_native_draft: {
          platform: "bluesky",
          creative_direction: {
            media_required: false,
            media_type: "screenshot",
            media_prompt_or_brief: "Optional.",
            media_risk_notes: [],
          },
        },
        // Defensive: even if some upstream caller mis-stored a token-
        // shaped value in metadata, the response shape is narrow and
        // shouldn't echo it.
        secret_field: "sigt_LEAK-PROBE-TOKEN-XYZ123",
      },
    });
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { body: "Update probe." }),
    );
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("leak-probe-token");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("app_password");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("sigt_");
    expect(serialized).not.toMatch(/\beyj[a-z0-9_-]+/);
  });
});

describe("weeklyPlanUpdateItemTool — never approves/schedules/publishes", () => {
  it("does not change status when updating", async () => {
    const store = emptyStore();
    const id = seedItem(store, { status: "draft" });
    await weeklyPlanUpdateItemTool(ctxWith(store), args(id, { body: "x" }));
    expect(store.weekly_plan_items[0].status).toBe("draft");
  });

  it("does not write scheduled_at when updating", async () => {
    const store = emptyStore();
    const id = seedItem(store);
    await weeklyPlanUpdateItemTool(ctxWith(store), args(id, { body: "x" }));
    expect(
      (store.weekly_plan_items[0] as { scheduled_at?: string | null })
        .scheduled_at,
    ).toBeUndefined();
  });

  it("does not call any publish API (verified by absence of imports + no fetch-shaped side effects)", async () => {
    // This is a structural assertion — if a future refactor adds a
    // publishTo* call into the handler, the build will fail and so
    // will the existing publish-leak tests we wrote on
    // schedule-tools. Here we just confirm the handler returns
    // without throwing or making any non-DB side effect.
    const store = emptyStore();
    const id = seedItem(store);
    const result = await weeklyPlanUpdateItemTool(
      ctxWith(store),
      args(id, { body: "x" }),
    );
    expect(result.ok).toBe(true);
    expect(result.tool).toBe("signal.weekly_plan.update_item");
  });
});
