import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { schedulePublishTool } from "./schedule-tools";
import type { ToolContext } from "../tool-context";
import type { SchedulePublishArgs } from "../schemas";

// =====================================================================
// Fake Supabase client — same shape used by planning-tools.test.ts
// =====================================================================

interface FakeStore {
  weekly_plan_items: Array<Record<string, unknown>>;
  platform_connections: Array<Record<string, unknown>>;
  weekly_contracts: Array<Record<string, unknown>>;
  execution_queues: Array<Record<string, unknown>>;
  execution_items: Array<Record<string, unknown>>;
  execution_logs: Array<Record<string, unknown>>;
  activity_events: Array<Record<string, unknown>>;
}

function emptyStore(): FakeStore {
  return {
    weekly_plan_items: [],
    platform_connections: [],
    weekly_contracts: [],
    execution_queues: [],
    execution_items: [],
    execution_logs: [],
    activity_events: [],
  };
}

let idCounter = 0;
function fakeUuid(prefix = "aaaa"): string {
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
      in(field: string, values: ReadonlyArray<unknown>) {
        filters.push((r) => values.includes(r[field]));
        return api;
      },
      order(_field: string, _opts?: { ascending?: boolean }) {
        // Fake store is in-insertion-order; we don't need stable
        // ordering for the tests that touch this code path.
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
          const row = { id: fakeUuid(), ...insertRow };
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
          value: {
            data: null | Record<string, unknown>[];
            error: null;
          },
        ) => void,
      ) {
        // Terminal for update/insert without .select() — needed when
        // the handler updates execution_items without selecting back.
        if (updatePatch !== null) {
          const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
            filters.every((f) => f(r)),
          );
          for (const r of rows) Object.assign(r, updatePatch);
          resolve({ data: null, error: null });
          return;
        }
        if (insertRow !== null) {
          const row = { id: fakeUuid(), ...insertRow };
          (store[table] as Record<string, unknown>[]).push(row);
          resolve({ data: null, error: null });
          return;
        }
        // SELECT-only chain awaited directly (no .single / .maybeSingle).
        // Real Supabase JS resolves to `{ data: Row[], error }`. Mirror
        // that so handlers using `.in()` filters work in tests.
        const rows = (store[table] as Record<string, unknown>[]).filter((r) =>
          filters.every((f) => f(r)),
        );
        resolve({ data: rows, error: null });
      },
      insert(row: Record<string, unknown>) {
        // The terminal (await / .single / .then) is responsible for
        // actually pushing the row to the store; this method only
        // records the pending insert so we can resolve it later. That
        // keeps the chain's behavior identical regardless of which
        // terminal the caller uses.
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
const CONTRACT_ID = "contract-1";
const QUEUE_ID = "queue-existing";

function ctxWith(store: FakeStore): ToolContext {
  return {
    workspaceId: WS,
    operatorTokenId: TOKEN_ID,
    scopes: ["weekly_plans:write_pending", "execution:schedule"],
    token: { id: TOKEN_ID, workspaceId: WS } as unknown as ToolContext["token"],
    db: makeFakeClient(store),
  };
}

interface PlanItemSeed {
  id?: string;
  status?: string;
  platform?: string;
  account_id?: string | null;
  risk_level?: string | null;
  product_id?: string | null;
}

function seedPlanItem(store: FakeStore, overrides: PlanItemSeed = {}): string {
  const id = overrides.id ?? fakeUuid("item");
  // Differentiate "not supplied in overrides" (use default) from
  // "explicitly supplied as null" (write null) — `??` collapses both.
  const accountId = "account_id" in overrides ? overrides.account_id : "acct-1";
  const productId = "product_id" in overrides ? overrides.product_id : "prod-1";
  const riskLevel = "risk_level" in overrides ? overrides.risk_level : "low";
  store.weekly_plan_items.push({
    id,
    workspace_id: WS,
    weekly_plan_id: "plan-1",
    product_id: productId,
    account_id: accountId,
    platform: overrides.platform ?? "bluesky",
    content_type: "post",
    title: "Test draft",
    body: "Body",
    link_url: null,
    scheduled_at: null,
    status: overrides.status ?? "approved",
    risk_score: 10,
    risk_level: riskLevel,
    metadata: { platform_native_draft: { platform: "bluesky" } },
  });
  return id;
}

function seedConnection(
  store: FakeStore,
  overrides: {
    account_id?: string;
    platform?: string;
    connection_status?: string;
    provider_account_id?: string;
  } = {},
): void {
  store.platform_connections.push({
    id: fakeUuid("conn"),
    workspace_id: WS,
    account_id: overrides.account_id ?? "acct-1",
    platform: overrides.platform ?? "bluesky",
    connection_status: overrides.connection_status ?? "connected",
    provider_account_id: overrides.provider_account_id ?? "did:plc:fake-12345",
  });
}

function seedContract(
  store: FakeStore,
  overrides: {
    account_ids?: string[];
    product_ids?: string[];
    platforms?: string[];
  } = {},
): void {
  store.weekly_contracts.push({
    id: CONTRACT_ID,
    workspace_id: WS,
    status: "active",
    week_start: "2026-05-25",
    week_end: "2026-05-31",
    title: "Week of 2026-05-25",
    scope: {
      accountIds: overrides.account_ids ?? ["acct-1"],
      productIds: overrides.product_ids ?? ["prod-1"],
      platforms: overrides.platforms ?? ["bluesky"],
    },
  });
}

function seedQueue(store: FakeStore): void {
  store.execution_queues.push({
    id: QUEUE_ID,
    workspace_id: WS,
    contract_id: CONTRACT_ID,
    status: "active",
    week_start: "2026-05-25",
    week_end: "2026-05-31",
    title: "Week of 2026-05-25",
  });
}

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function validArgs(planItemId: string): SchedulePublishArgs {
  return {
    plan_item_id: planItemId,
    scheduled_at: futureIso(5 * 60 * 1000), // 5 minutes out
    confirm_schedule: true,
  };
}

beforeEach(() => {
  idCounter = 0;
});

afterEach(() => {
  // Nothing to restore.
});

// =====================================================================
// Success path
// =====================================================================

describe("schedulePublishTool — success", () => {
  it("schedules an approved Bluesky item end-to-end", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store);
    seedConnection(store);
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.requires_user_approval).toBe(true);

    // plan_item updated
    const item = store.weekly_plan_items[0];
    expect(item.status).toBe("scheduled");
    expect(typeof item.scheduled_at).toBe("string");
    const itemMeta = item.metadata as Record<string, unknown>;
    expect(itemMeta.platform_native_draft).toBeDefined();
    expect(itemMeta.source).toBe("mcp_operation");
    expect(itemMeta.scheduled_by_operator_token_id).toBe(TOKEN_ID);
    expect(typeof itemMeta.mcp_scheduled_at).toBe("string");

    // execution_item created and walked to scheduled
    expect(store.execution_items.length).toBe(1);
    const execItem = store.execution_items[0];
    expect(execItem.status).toBe("scheduled");
    expect(execItem.platform).toBe("bluesky");
    const execMeta = execItem.metadata as Record<string, unknown>;
    expect(execMeta.source).toBe("mcp_operation");
    expect(execMeta.scheduled_by_operator_token_id).toBe(TOKEN_ID);

    // activity row
    expect(store.activity_events.length).toBe(1);
    expect(store.activity_events[0].event_type).toBe("mcp.publish_scheduled");

    // response includes review_url + execution_item_id, no DID/secrets
    expect(result.data.plan_item_id).toBe(planItemId);
    expect(result.data.execution_item_id).toBe(execItem.id);
    expect(result.data.status).toBe("scheduled");
    expect(result.data.review_url).toBe(
      `/weekly-plan?focus=${encodeURIComponent(planItemId)}`,
    );
  });

  it("creates a new execution_queue when none is active", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store);
    seedConnection(store);
    seedContract(store);
    // No seedQueue() — handler should create one.

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(true);
    expect(store.execution_queues.length).toBe(1);
  });

  it("preserves existing metadata.platform_native_draft when appending scheduling fields", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store);
    // Add a richer envelope so we know preservation isn't trivial.
    store.weekly_plan_items[0].metadata = {
      platform_native_draft: {
        platform: "bluesky",
        creative_direction: { media_required: false },
        warnings: ["Identity is warming."],
      },
      generation_topic: "Test idea",
    };
    seedConnection(store);
    seedContract(store);
    seedQueue(store);

    await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    const itemMeta = store.weekly_plan_items[0].metadata as Record<string, unknown>;
    expect(itemMeta.platform_native_draft).toMatchObject({
      platform: "bluesky",
      creative_direction: { media_required: false },
    });
    expect(itemMeta.generation_topic).toBe("Test idea");
    expect(itemMeta.scheduled_by_operator_token_id).toBe(TOKEN_ID);
  });
});

// =====================================================================
// Refusals — status gate
// =====================================================================

describe("schedulePublishTool — status gate", () => {
  it.each(["draft", "pending_approval", "published", "rejected"])(
    "refuses status=%s",
    async (status) => {
      const store = emptyStore();
      const planItemId = seedPlanItem(store, { status });
      seedConnection(store);
      seedContract(store);
      seedQueue(store);

      const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

      expect(result.ok).toBe(false);
      expect(result.summary).toContain(
        `plan_item_status_must_be_approved_paused_or_scheduled_got_${status}`,
      );
      expect(store.execution_items).toEqual([]);
      expect(store.weekly_plan_items[0].status).toBe(status); // unchanged
    },
  );

  it("accepts status=paused (retry recovery)", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { status: "paused" });
    seedConnection(store);
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(
      ctxWith(store),
      validArgs(planItemId),
    );

    expect(result.ok).toBe(true);
    expect(store.execution_items.length).toBe(1);
  });

  it("accepts status=scheduled WHEN no active execution_item exists (rescheduling a stale row)", async () => {
    // Edge case: plan_item.status drifted to "scheduled" but the
    // execution_item history is all terminal. Treat the call as a
    // fresh schedule.
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { status: "scheduled" });
    seedConnection(store);
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(
      ctxWith(store),
      validArgs(planItemId),
    );

    expect(result.ok).toBe(true);
    expect(store.execution_items.length).toBe(1);
  });

  it("refuses cross-workspace plan items", async () => {
    const store = emptyStore();
    store.weekly_plan_items.push({
      id: "cross-ws-item",
      workspace_id: "other-ws",
      platform: "bluesky",
      status: "approved",
    });

    const result = await schedulePublishTool(ctxWith(store), {
      plan_item_id: "cross-ws-item",
      scheduled_at: futureIso(5 * 60 * 1000),
      confirm_schedule: true,
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("plan_item_not_found_in_workspace");
  });
});

// =====================================================================
// Refusals — platform allowlist
// =====================================================================

describe("schedulePublishTool — platform gate", () => {
  it.each(["x", "linkedin", "instagram", "threads", "youtube", "indie_hackers"])(
    "refuses manual/distribution platform %s",
    async (platform) => {
      const store = emptyStore();
      const planItemId = seedPlanItem(store, { platform });
      seedConnection(store, { platform });
      seedContract(store, { platforms: [platform] });
      seedQueue(store);

      const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("platform_is_manual_or_distribution_only");
    },
  );

  it.each(["devto", "telegram", "reddit", "hashnode"])(
    "refuses %s (Phase 5 publish blocker / manual mode)",
    async (platform) => {
      const store = emptyStore();
      const planItemId = seedPlanItem(store, { platform });
      seedConnection(store, { platform });
      seedContract(store, { platforms: [platform] });
      seedQueue(store);

      const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

      expect(result.ok).toBe(false);
      expect(result.summary).toContain("platform_has_unresolved_publish_blocker");
    },
  );

  it("refuses when plan_item has no platform set", async () => {
    const store = emptyStore();
    const planItemId = fakeUuid("noplatform");
    store.weekly_plan_items.push({
      id: planItemId,
      workspace_id: WS,
      platform: null,
      status: "approved",
      content_type: "post",
      account_id: "acct-1",
      risk_level: "low",
      metadata: {},
    });

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("plan_item_missing_platform");
  });
});

// =====================================================================
// Refusals — identity / connection
// =====================================================================

describe("schedulePublishTool — identity gate", () => {
  it("refuses when plan_item has no account_id", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { account_id: null });
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("plan_item_missing_account_id");
  });

  it("refuses when no platform_connections row exists for the identity", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store);
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("identity_has_no_bluesky_connection_signed_in");
  });

  it("refuses when connection_status is not 'connected'", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store);
    seedConnection(store, { connection_status: "revoked" });
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(false);
    expect(result.summary).toContain(
      "identity_connection_status_revoked_must_be_connected",
    );
  });

  it("refuses when provider_account_id is not a DID", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store);
    seedConnection(store, { provider_account_id: "not-a-did" });
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("identity_connection_missing_did");
  });
});

// =====================================================================
// Refusals — risk + contract scope
// =====================================================================

describe("schedulePublishTool — risk + scope gate", () => {
  it("refuses plan_items with risk_level='blocked'", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { risk_level: "blocked" });
    seedConnection(store);
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("plan_item_risk_level_blocked");
  });

  it("schedules contract-free when no active contract exists", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store);
    seedConnection(store);
    // No contract seeded — per-post scheduling now runs contract-free.

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as {
        contract_mode: string;
        contract_id: string | null;
      };
      expect(data.contract_mode).toBe("contract_free_item");
      expect(data.contract_id).toBe(null);
    }
  });

  it("refuses when plan_item's account is out of contract scope", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { account_id: "outside-acct" });
    seedConnection(store, { account_id: "outside-acct" });
    seedContract(store, { account_ids: ["different-acct"] });

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    expect(result.ok).toBe(false);
    expect(result.summary).toBe("plan_item_account_out_of_contract_scope");
  });
});

// =====================================================================
// Response safety + behavior
// =====================================================================

describe("schedulePublishTool — response safety", () => {
  it("never includes platform tokens / credentials / DID in the response", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store);
    seedConnection(store, { provider_account_id: "did:plc:LEAK-PROBE-DID" });
    seedContract(store);
    seedQueue(store);

    const result = await schedulePublishTool(ctxWith(store), validArgs(planItemId));

    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("refresh_token");
    expect(serialized).not.toContain("app_password");
    expect(serialized).not.toContain("api_key");
    expect(serialized).not.toContain("leak-probe-did");
    expect(serialized).not.toMatch(/\beyj[a-z0-9_-]+/);
  });
});

// =====================================================================
// Resync — reschedule active execution_item instead of duplicating
// =====================================================================
//
// Pre-fix the tool refused with `plan_item_has_active_execution_item`
// whenever an active execution_item existed for the plan_item. That
// meant operators couldn't shift a scheduled publish via MCP without
// first cancelling the row. These tests pin the resync behavior so
// the duplicate-prevention guard can never silently regress.

function seedExecutionItem(
  store: FakeStore,
  args: {
    plan_item_id: string;
    status?: string;
    scheduled_at?: string | null;
    queue_id?: string;
  },
): string {
  const id = fakeUuid("ei");
  store.execution_items.push({
    id,
    workspace_id: WS,
    queue_id: args.queue_id ?? QUEUE_ID,
    contract_id: CONTRACT_ID,
    source_entity_type: "weekly_plan_item",
    source_entity_id: args.plan_item_id,
    platform: "bluesky",
    status: args.status ?? "scheduled",
    scheduled_at: args.scheduled_at ?? futureIso(60 * 60 * 1000),
    metadata: { plan_item_id: args.plan_item_id },
  });
  return id;
}

describe("schedulePublishTool — resync active execution_item", () => {
  it("scheduled execution_item → reschedules to new scheduled_at instead of duplicating", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { status: "scheduled" });
    seedConnection(store);
    seedContract(store);
    seedQueue(store);
    const originalIso = futureIso(60 * 60 * 1000);
    const eiId = seedExecutionItem(store, {
      plan_item_id: planItemId,
      status: "scheduled",
      scheduled_at: originalIso,
    });
    const newIso = futureIso(5 * 60 * 1000);

    const result = await schedulePublishTool(ctxWith(store), {
      plan_item_id: planItemId,
      scheduled_at: newIso,
      confirm_schedule: true,
    });

    expect(result.ok).toBe(true);
    // exactly one execution_item — no duplicate row
    expect(store.execution_items.length).toBe(1);
    const ei = store.execution_items[0];
    expect(ei.id).toBe(eiId);
    expect(ei.scheduled_at).toBe(newIso);
    const eiMeta = ei.metadata as Record<string, unknown>;
    expect(eiMeta.schedule_resynced_from_plan_item).toBe(true);
    expect(eiMeta.schedule_resynced_source).toBe("mcp");
    expect(eiMeta.schedule_resynced_previous_scheduled_at).toBe(originalIso);
    // plan_item.scheduled_at mirrors
    expect(store.weekly_plan_items[0].scheduled_at).toBe(newIso);
    // response mode advertised
    if (result.ok) {
      const data = result.data as { mode: string; execution_item_id: string };
      expect(data.mode).toBe("rescheduled_active_execution_item");
      expect(data.execution_item_id).toBe(eiId);
    }
    // activity row written under the reschedule event type
    expect(
      store.activity_events.some(
        (a) => a.event_type === "mcp.publish_rescheduled",
      ),
    ).toBe(true);
    // execution_log row written with the schedule_resynced reason_code
    const logRow = store.execution_logs.find(
      (l) => l.event_type === "item.schedule_resynced",
    );
    expect(logRow).toBeDefined();
    const logMeta = logRow?.metadata as Record<string, unknown>;
    expect(logMeta.reason_code).toBe("schedule_resynced");
    expect(logMeta.source).toBe("mcp");
    expect(logMeta.previous_scheduled_at).toBe(originalIso);
    expect(logMeta.next_scheduled_at).toBe(newIso);
  });

  it("authorized execution_item → reschedules (still in operator-controllable window)", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { status: "approved" });
    seedConnection(store);
    seedContract(store);
    seedQueue(store);
    const eiId = seedExecutionItem(store, {
      plan_item_id: planItemId,
      status: "authorized",
    });
    const newIso = futureIso(10 * 60 * 1000);

    const result = await schedulePublishTool(ctxWith(store), {
      plan_item_id: planItemId,
      scheduled_at: newIso,
      confirm_schedule: true,
    });

    expect(result.ok).toBe(true);
    expect(store.execution_items.length).toBe(1);
    expect(store.execution_items[0].id).toBe(eiId);
    expect(store.execution_items[0].scheduled_at).toBe(newIso);
  });

  it("running execution_item → refuses (would race the publisher)", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { status: "scheduled" });
    seedConnection(store);
    seedContract(store);
    seedQueue(store);
    const eiId = seedExecutionItem(store, {
      plan_item_id: planItemId,
      status: "running",
    });
    const newIso = futureIso(5 * 60 * 1000);
    const originalRow = { ...store.execution_items[0] };

    const result = await schedulePublishTool(ctxWith(store), {
      plan_item_id: planItemId,
      scheduled_at: newIso,
      confirm_schedule: true,
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain(
      "execution_item_status_running_cannot_be_resynced",
    );
    // execution_item untouched
    expect(store.execution_items.length).toBe(1);
    expect(store.execution_items[0].id).toBe(eiId);
    expect(store.execution_items[0].scheduled_at).toBe(originalRow.scheduled_at);
  });

  it("terminal-only execution_items → creates a fresh row (history preserved)", async () => {
    const store = emptyStore();
    const planItemId = seedPlanItem(store, { status: "paused" });
    seedConnection(store);
    seedContract(store);
    seedQueue(store);
    seedExecutionItem(store, { plan_item_id: planItemId, status: "blocked" });
    seedExecutionItem(store, { plan_item_id: planItemId, status: "failed" });
    const newIso = futureIso(5 * 60 * 1000);

    const result = await schedulePublishTool(ctxWith(store), {
      plan_item_id: planItemId,
      scheduled_at: newIso,
      confirm_schedule: true,
    });

    expect(result.ok).toBe(true);
    // two terminal rows preserved + one fresh row inserted
    expect(store.execution_items.length).toBe(3);
    // none of the terminal rows were mutated
    expect(
      store.execution_items.filter((r) => r.status === "blocked").length,
    ).toBe(1);
    expect(
      store.execution_items.filter((r) => r.status === "failed").length,
    ).toBe(1);
    // a new row was created with the requested scheduled_at
    expect(
      store.execution_items.some(
        (r) => r.status === "scheduled" && r.scheduled_at === newIso,
      ),
    ).toBe(true);
  });
});
