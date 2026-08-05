import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// The safe-test pre-flight runs behind an operator action and is given
// its Supabase client explicitly. Constructing a cookie-bound one from
// inside the canonical repository would be a bug, so any call throws.
vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: () => {
    throw new Error("createSupabaseServerClient() must not be called here");
  },
}));

import { evaluateSafeTestPolicy } from "./safe-test-policy";

/**
 * Authorization behaviour of the safe-test pre-flight (P0.1b).
 *
 * This caller is deliberately STRICTER than MCP scheduling: it does not
 * permit contract-free publishing, because it is the gate in front of a
 * manual live publish. What P0.1b changed is that it now reads the
 * authorization through the canonical classifier, so a paused or
 * time-expired envelope is no longer reported as "Active contract:
 * pass" — previously the query filtered on `status = 'active'` alone
 * and never looked at the window.
 *
 * These tests seed every upstream gate to pass and then vary only the
 * authorization state.
 */

const WS = "ws-safe-1";
const ACCOUNT_ID = "acct-safe-1";
const PRODUCT_ID = "prod-safe-1";
const CONTRACT_ID = "contract-safe-1";

interface Store {
  growth_accounts: Array<Record<string, unknown>>;
  products: Array<Record<string, unknown>>;
  weekly_approval_contracts: Array<Record<string, unknown>>;
  weekly_contract_accounts: Array<Record<string, unknown>>;
  weekly_contract_products: Array<Record<string, unknown>>;
  weekly_contract_platforms: Array<Record<string, unknown>>;
  weekly_contract_allowed_actions: Array<Record<string, unknown>>;
  weekly_contract_execution_windows: Array<Record<string, unknown>>;
  weekly_plan_item_creatives: Array<Record<string, unknown>>;
  publish_history: Array<Record<string, unknown>>;
  platform_connections: Array<Record<string, unknown>>;
}

function emptyStore(): Store {
  return {
    growth_accounts: [
      {
        id: ACCOUNT_ID,
        workspace_id: WS,
        handle: "signal_test",
        display_name: "Signal Test",
        review_status: "confirmed",
        connection_status: "connected",
      },
    ],
    products: [
      {
        id: PRODUCT_ID,
        workspace_id: WS,
        name: "Signal",
        review_status: "confirmed",
      },
    ],
    weekly_approval_contracts: [],
    weekly_contract_accounts: [],
    weekly_contract_products: [],
    weekly_contract_platforms: [],
    weekly_contract_allowed_actions: [],
    weekly_contract_execution_windows: [],
    weekly_plan_item_creatives: [],
    publish_history: [],
    platform_connections: [],
  };
}

type FailingTables = Partial<Record<keyof Store, { message: string }>>;

function makeClient(store: Store, failing: FailingTables = {}): SupabaseClient {
  function chain(table: keyof Store) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const failure = failing[table] ?? null;
    const rows = () =>
      (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const api = {
      select: () => api,
      eq(field: string, value: unknown) {
        filters.push((r) => r[field] === value);
        return api;
      },
      gte: () => api,
      order: () => api,
      limit: () => api,
      async maybeSingle() {
        if (failure) return { data: null, error: failure };
        return { data: rows()[0] ?? null, error: null };
      },
      then(resolve: (v: { data: unknown; error: unknown }) => void) {
        if (failure) {
          resolve({ data: null, error: failure });
          return;
        }
        resolve({ data: rows(), error: null });
      },
    };
    return api;
  }
  return { from: chain } as unknown as SupabaseClient;
}

function seedContract(
  store: Store,
  overrides: {
    status?: string;
    week_end?: string;
    id?: string;
    platforms?: string[];
    account_ids?: string[];
    product_ids?: string[];
    allowed_actions?: string[];
  } = {},
): void {
  const id = overrides.id ?? CONTRACT_ID;
  store.weekly_approval_contracts.push({
    id,
    workspace_id: WS,
    created_by: null,
    approved_by: null,
    title: "Safe-test contract",
    week_start: "2026-05-25",
    week_end: overrides.week_end ?? "2999-12-31",
    status: overrides.status ?? "active",
    max_risk_level: "medium",
    max_actions_total: null,
    max_actions_per_day: null,
    max_actions_per_platform_per_day: null,
    pause_on_first_failure: true,
    pause_on_risk_event: true,
    notes: null,
    approval_text_phrase: null,
    approved_at: null,
    activated_at: null,
    paused_at: null,
    expired_at: null,
    revoked_at: null,
    metadata: {},
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
  });
  for (const accountId of overrides.account_ids ?? [ACCOUNT_ID]) {
    store.weekly_contract_accounts.push({
      contract_id: id,
      workspace_id: WS,
      account_id: accountId,
    });
  }
  for (const productId of overrides.product_ids ?? [PRODUCT_ID]) {
    store.weekly_contract_products.push({
      contract_id: id,
      workspace_id: WS,
      product_id: productId,
    });
  }
  for (const platform of overrides.platforms ?? ["reddit"]) {
    store.weekly_contract_platforms.push({
      contract_id: id,
      workspace_id: WS,
      platform,
    });
  }
  for (const actionType of overrides.allowed_actions ?? [
    "publish_scheduled_post",
  ]) {
    store.weekly_contract_allowed_actions.push({
      contract_id: id,
      workspace_id: WS,
      action_type: actionType,
    });
  }
}

function input(store: Store, failing: FailingTables = {}) {
  return {
    supabase: makeClient(store, failing),
    workspaceId: WS,
    executionItem: {
      id: "exec-1",
      accountId: ACCOUNT_ID,
      productId: PRODUCT_ID,
      platform: "reddit",
      title: "A safe test post",
      body: "Body text.",
      linkUrl: null,
      scheduledAt: "2026-05-26T10:00:00.000Z",
      actionType: "publish_scheduled_post",
      metadata: {} as Record<string, unknown>,
    },
    confirmationPhrase: "publish live reddit post",
    subreddit: "signaltest",
    nowIso: "2026-05-26T10:05:00.000Z",
  };
}

/**
 * The authorization gate sits after the creative/rate-limit gates, so a
 * fully-passing fixture is out of scope here. What each test asserts is
 * the reason code produced by the authorization gate specifically — and,
 * for the pass case, that evaluation proceeds PAST authorization rather
 * than stopping on it.
 */
const AUTHORIZATION_REASON_CODES = new Set([
  "no_active_contract",
  "contract_paused",
  "active_authorization_expired",
  "active_authorization_boundary_malformed",
  "authorization_lookup_failed",
  "authorization_scope_lookup_failed",
]);

describe("safe-test policy — publishing authorization", () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    process.env.SAFE_TEST_MODE = "true";
    process.env.ALLOWED_TEST_SUBREDDITS = "signaltest";
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it("refuses when no authorization exists — it is NOT contract-free", async () => {
    const store = emptyStore();
    const verdict = await evaluateSafeTestPolicy(input(store));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasonCode).toBe("no_active_contract");
  });

  it("passes the authorization gate for a valid active in-window authorization", async () => {
    const store = emptyStore();
    seedContract(store);
    const verdict = await evaluateSafeTestPolicy(input(store));
    // It may still fail a LATER gate (creative readiness etc.); what
    // matters is that authorization is not the blocker.
    expect(AUTHORIZATION_REASON_CODES.has(verdict.reasonCode ?? "")).toBe(false);
    expect(
      verdict.checks.some(
        (c) => c.name === "Active contract" && c.status === "pass",
      ),
    ).toBe(true);
  });

  it("refuses when a relevant paused authorization covers the item", async () => {
    const store = emptyStore();
    seedContract(store, { status: "paused" });
    const verdict = await evaluateSafeTestPolicy(input(store));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasonCode).toBe("contract_paused");
  });

  it("still refuses with no_active_contract when the only paused row is unrelated", async () => {
    const store = emptyStore();
    // Out of scope on platform: it does not govern, so it is not the
    // reason. Safe-test's stricter posture then refuses for absence.
    seedContract(store, { status: "paused", platforms: ["telegram"] });
    const verdict = await evaluateSafeTestPolicy(input(store));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasonCode).toBe("no_active_contract");
  });

  it("refuses an active authorization whose window has closed", async () => {
    const store = emptyStore();
    seedContract(store, { status: "active", week_end: "2020-01-07" });
    const verdict = await evaluateSafeTestPolicy(input(store));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasonCode).toBe("active_authorization_expired");
  });

  it("refuses an active authorization with a malformed end boundary", async () => {
    const store = emptyStore();
    seedContract(store, { status: "active", week_end: "not-a-date" });
    const verdict = await evaluateSafeTestPolicy(input(store));
    expect(verdict.ok).toBe(false);
    expect(verdict.reasonCode).toBe("active_authorization_boundary_malformed");
  });

  it("fails closed when the authorization row cannot be loaded", async () => {
    const store = emptyStore();
    seedContract(store);
    const verdict = await evaluateSafeTestPolicy(
      input(store, { weekly_approval_contracts: { message: "permission denied" } }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasonCode).toBe("authorization_lookup_failed");
  });

  it("fails closed when the scope join tables cannot be loaded", async () => {
    const store = emptyStore();
    seedContract(store);
    const verdict = await evaluateSafeTestPolicy(
      input(store, { weekly_contract_platforms: { message: "relation unavailable" } }),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reasonCode).toBe("authorization_scope_lookup_failed");
  });
});
