import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// Every caller injects its own client. If the canonical repository ever
// falls back to a cookie-bound one, these tests fail loudly.
vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: () => {
    throw new Error("createSupabaseServerClient() must not be called here");
  },
}));

import {
  authorizationWindowEndExclusiveMs,
  classifyPublishingAuthorization,
  evaluateAuthorizationScope,
  type AuthorizationSubject,
} from "./weekly-contract-repository";

/**
 * Canonical authorization classification (P0.1b).
 *
 * The point of these tests is that the *classification* — status,
 * window, scope — is one shared reading. Callers then apply their own
 * policy on top, and those policies legitimately differ:
 *
 *   MCP scheduling  permits contract-free publishing
 *   safe-test       requires an active authorization
 *   publisher       does not re-authorize at all (PR #91)
 *
 * So this file pins the classifier, not caller outcomes.
 */

const WS = "ws-1";
const SUBJECT: AuthorizationSubject = {
  accountId: "acct-1",
  productId: "prod-1",
  platform: "bluesky",
  actionType: "publish_scheduled_post",
};

interface Row {
  id: string;
  status: string;
  week_end: string;
  accounts?: string[];
  products?: string[];
  platforms?: string[];
  actions?: string[];
}

function clientFor(rows: Row[]): SupabaseClient {
  const contracts = rows.map((r) => ({
    id: r.id,
    workspace_id: WS,
    created_by: null,
    approved_by: null,
    title: r.id,
    week_start: "2026-05-25",
    week_end: r.week_end,
    status: r.status,
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
  }));
  const join = (key: keyof Row, field: string) =>
    rows.flatMap((r) =>
      ((r[key] as string[] | undefined) ?? []).map((v) => ({
        contract_id: r.id,
        workspace_id: WS,
        [field]: v,
      })),
    );
  const store: Record<string, Array<Record<string, unknown>>> = {
    weekly_approval_contracts: contracts,
    weekly_contract_accounts: join("accounts", "account_id"),
    weekly_contract_products: join("products", "product_id"),
    weekly_contract_platforms: join("platforms", "platform"),
    weekly_contract_allowed_actions: join("actions", "action_type"),
    weekly_contract_execution_windows: [],
  };
  function chain(table: string) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    const matched = () =>
      (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const api = {
      select: () => api,
      eq(field: string, value: unknown) {
        filters.push((r) => r[field] === value);
        return api;
      },
      order: () => api,
      async maybeSingle() {
        return { data: matched()[0] ?? null, error: null };
      },
      then(resolve: (v: { data: unknown; error: unknown }) => void) {
        resolve({ data: matched(), error: null });
      },
    };
    return api;
  }
  return { from: chain } as unknown as SupabaseClient;
}

const IN_SCOPE = {
  accounts: ["acct-1"],
  products: ["prod-1"],
  platforms: ["bluesky"],
  actions: ["publish_scheduled_post"],
};

// Fixed instant well inside a 2999 window and well past a 2020 one.
const NOW = Date.UTC(2026, 4, 26, 10, 0, 0);

describe("authorizationWindowEndExclusiveMs", () => {
  it("treats week_end as inclusive — the whole end day is still covered", () => {
    const boundary = authorizationWindowEndExclusiveMs("2026-05-31");
    expect(boundary).toBe(Date.UTC(2026, 5, 1));
    // 23:59:59.999 on the end day is inside the window.
    expect(Date.UTC(2026, 4, 31, 23, 59, 59, 999) < boundary!).toBe(true);
    // Midnight the next day is outside.
    expect(Date.UTC(2026, 5, 1) >= boundary!).toBe(true);
  });

  it("rejects malformed and impossible dates rather than rolling them over", () => {
    expect(authorizationWindowEndExclusiveMs("not-a-date")).toBe(null);
    expect(authorizationWindowEndExclusiveMs("2026-13-01")).toBe(null);
    expect(authorizationWindowEndExclusiveMs("2026-02-30")).toBe(null);
    expect(authorizationWindowEndExclusiveMs("")).toBe(null);
  });
});

describe("evaluateAuthorizationScope", () => {
  const scope = {
    accountIds: ["acct-1"],
    productIds: ["prod-1"],
    platforms: ["bluesky"],
    allowedActions: ["publish_scheduled_post" as const],
    executionWindows: [],
  };

  it("allows a subject inside every axis", () => {
    expect(evaluateAuthorizationScope({ scope, ...SUBJECT })).toEqual({
      allowed: true,
    });
  });

  it("reports the first violated axis, checked account → product → platform → action", () => {
    expect(
      evaluateAuthorizationScope({ scope, ...SUBJECT, accountId: "other" }),
    ).toEqual({ allowed: false, reason: "account_out_of_scope" });
    expect(
      evaluateAuthorizationScope({ scope, ...SUBJECT, productId: "other" }),
    ).toEqual({ allowed: false, reason: "product_out_of_scope" });
    expect(
      evaluateAuthorizationScope({ scope, ...SUBJECT, platform: "telegram" }),
    ).toEqual({ allowed: false, reason: "platform_out_of_scope" });
    expect(
      evaluateAuthorizationScope({
        scope,
        ...SUBJECT,
        actionType: "publish_scheduled_comment",
      }),
    ).toEqual({ allowed: false, reason: "action_not_permitted" });
  });

  it("does not constrain a subject that carries no account or product", () => {
    expect(
      evaluateAuthorizationScope({
        scope,
        ...SUBJECT,
        accountId: null,
        productId: null,
      }),
    ).toEqual({ allowed: true });
  });
});

describe("classifyPublishingAuthorization", () => {
  const classify = (rows: Row[], subject: AuthorizationSubject = SUBJECT) =>
    classifyPublishingAuthorization({
      workspaceId: WS,
      subject,
      nowMs: NOW,
      db: clientFor(rows),
    });

  it("returns none when nothing governs", async () => {
    expect((await classify([])).kind).toBe("none");
  });

  it("classifies an active in-window in-scope row", async () => {
    const r = await classify([
      { id: "c1", status: "active", week_end: "2999-12-31", ...IN_SCOPE },
    ]);
    expect(r.kind).toBe("active_in_scope");
  });

  it("classifies an active row out of scope, carrying the violated axis", async () => {
    const r = await classify([
      {
        id: "c1",
        status: "active",
        week_end: "2999-12-31",
        ...IN_SCOPE,
        platforms: ["telegram"],
      },
    ]);
    expect(r.kind).toBe("active_out_of_scope");
    if (r.kind === "active_out_of_scope") {
      expect(r.reason).toBe("platform_out_of_scope");
    }
  });

  it("classifies an active row past its window as expired, not in-scope", async () => {
    const r = await classify([
      { id: "c1", status: "active", week_end: "2020-01-07", ...IN_SCOPE },
    ]);
    expect(r.kind).toBe("active_expired");
  });

  it("classifies an unparseable boundary rather than guessing", async () => {
    const r = await classify([
      { id: "c1", status: "active", week_end: "nope", ...IN_SCOPE },
    ]);
    expect(r.kind).toBe("active_malformed_boundary");
  });

  it("classifies an in-window paused row covering the subject as relevant", async () => {
    const r = await classify([
      { id: "c1", status: "paused", week_end: "2999-12-31", ...IN_SCOPE },
    ]);
    expect(r.kind).toBe("paused_relevant");
  });

  it("ignores a paused row that does not cover the subject", async () => {
    const r = await classify([
      {
        id: "c1",
        status: "paused",
        week_end: "2999-12-31",
        ...IN_SCOPE,
        products: ["other-prod"],
      },
    ]);
    expect(r.kind).toBe("none");
  });

  it("ignores a paused row whose window has already closed", async () => {
    const r = await classify([
      { id: "c1", status: "paused", week_end: "2020-01-07", ...IN_SCOPE },
    ]);
    expect(r.kind).toBe("none");
  });

  it("finds a relevant paused row among several irrelevant ones", async () => {
    // Multiple paused rows can coexist: the one-active unique index is
    // partial (`where status = 'active'`), so paused is unconstrained.
    const r = await classify([
      { id: "p1", status: "paused", week_end: "2999-12-31", ...IN_SCOPE, platforms: ["telegram"] },
      { id: "p2", status: "paused", week_end: "2020-01-07", ...IN_SCOPE },
      { id: "p3", status: "paused", week_end: "2999-12-31", ...IN_SCOPE },
    ]);
    expect(r.kind).toBe("paused_relevant");
    if (r.kind === "paused_relevant") expect(r.contract.id).toBe("p3");
  });

  it("lets an active row win over a coexisting paused one", async () => {
    const r = await classify([
      { id: "a1", status: "active", week_end: "2999-12-31", ...IN_SCOPE },
      { id: "p1", status: "paused", week_end: "2999-12-31", ...IN_SCOPE },
    ]);
    expect(r.kind).toBe("active_in_scope");
    if (r.kind === "active_in_scope") expect(r.contract.id).toBe("a1");
  });

  it.each(["revoked", "expired", "draft", "approved", "pending_approval"])(
    "treats a %s row as not governing",
    async (status) => {
      const r = await classify([
        { id: "c1", status, week_end: "2999-12-31", ...IN_SCOPE },
      ]);
      expect(r.kind).toBe("none");
    },
  );

  it("produces an identical classification for identical rows across callers", async () => {
    // Two independently constructed clients — standing in for the
    // service-role client MCP injects and the client safe-test passes.
    const rows: Row[] = [
      { id: "c1", status: "paused", week_end: "2999-12-31", ...IN_SCOPE },
    ];
    const viaOne = await classifyPublishingAuthorization({
      workspaceId: WS,
      subject: SUBJECT,
      nowMs: NOW,
      db: clientFor(rows),
    });
    const viaTwo = await classifyPublishingAuthorization({
      workspaceId: WS,
      subject: SUBJECT,
      nowMs: NOW,
      db: clientFor(rows),
    });
    expect(viaOne.kind).toBe(viaTwo.kind);
    expect(JSON.stringify(viaOne)).toBe(JSON.stringify(viaTwo));
  });

  it("is stable across the same instant regardless of when it is called", async () => {
    // One captured `now` per evaluation is the contract; passing the
    // same instant twice must never straddle a boundary.
    const rows: Row[] = [
      { id: "c1", status: "active", week_end: "2026-05-26", ...IN_SCOPE },
    ];
    const endOfDay = Date.UTC(2026, 4, 26, 23, 59, 59, 999);
    const nextMidnight = Date.UTC(2026, 4, 27);
    const inside = await classifyPublishingAuthorization({
      workspaceId: WS,
      subject: SUBJECT,
      nowMs: endOfDay,
      db: clientFor(rows),
    });
    const outside = await classifyPublishingAuthorization({
      workspaceId: WS,
      subject: SUBJECT,
      nowMs: nextMidnight,
      db: clientFor(rows),
    });
    expect(inside.kind).toBe("active_in_scope");
    expect(outside.kind).toBe("active_expired");
  });
});
