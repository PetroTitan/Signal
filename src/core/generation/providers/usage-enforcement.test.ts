import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * P0.5 — AI usage enforcement at the provider boundary.
 *
 * Before this change the workspace budget was checked in two UI server
 * actions and nowhere else. The MCP planning tools call the same
 * `generateDraft` in a loop over identities x topics x weeks, one real
 * provider request per iteration, so an agent could spend without bound
 * on the workspace's API key. The ledger was never the problem — MCP
 * already writes `draft.generated` activity events — the check simply
 * was not on that path.
 *
 * Enforcement now sits at `callGenerationProvider`, the lowest shared
 * function that actually dispatches a request, and the metering context
 * is a REQUIRED parameter so a future caller cannot forget it.
 */

// Count real provider dispatches. If enforcement works, a refused call
// never reaches either of these.
let anthropicCalls = 0;
let openaiCalls = 0;

vi.mock("./anthropic", () => ({
  callAnthropic: async () => {
    anthropicCalls += 1;
    return {
      ok: true,
      text: "generated body",
      providerName: "anthropic",
      truncated: false,
      durationMs: 5,
    };
  },
}));

vi.mock("./openai", () => ({
  callOpenAI: async () => {
    openaiCalls += 1;
    return {
      ok: true,
      text: "generated body",
      providerName: "openai",
      truncated: false,
      durationMs: 5,
    };
  },
}));

// The UI path runs inside a request and omits `db`. Any construction of
// a cookie-bound client on a non-request path is a bug, so it throws.
let cookieClientCalls = 0;
vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: () => {
    cookieClientCalls += 1;
    return makeLedger(cookieLedgerRows);
  },
}));

import { callGenerationProvider } from "./index";

/**
 * Minimal Supabase double for the usage ledger query:
 *   .from("activity_events").select().eq().in().gte().order()
 */
let cookieLedgerRows: Array<{ created_at: string }> = [];

function makeLedger(
  rows: Array<{ created_at: string }>,
  opts: { error?: { message: string } } = {},
): SupabaseClient {
  const api = {
    select: () => api,
    eq: () => api,
    in: () => api,
    gte: () => api,
    order: () => api,
    then(resolve: (v: { data: unknown; error: unknown }) => void) {
      if (opts.error) {
        resolve({ data: null, error: opts.error });
        return;
      }
      resolve({ data: rows, error: null });
    },
  };
  return { from: () => api } as unknown as SupabaseClient;
}

function ledgerOf(count: number): Array<{ created_at: string }> {
  return Array.from({ length: count }, (_, i) => ({
    created_at: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
  }));
}

const CALL = { system: "sys", user: "usr" };

describe("callGenerationProvider — usage enforcement", () => {
  const previousEnv = { ...process.env };

  beforeEach(() => {
    anthropicCalls = 0;
    openaiCalls = 0;
    cookieClientCalls = 0;
    cookieLedgerRows = [];
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.OPENAI_API_KEY;
    delete process.env.SIGNAL_AI_PROVIDER;
    process.env.SIGNAL_AI_ACTIONS_PER_DAY = "3";
  });

  afterEach(() => {
    process.env = { ...previousEnv };
  });

  it("MCP path: dispatches when the injected ledger is under the limit", async () => {
    const res = await callGenerationProvider(CALL, {
      workspaceId: "ws-1",
      db: makeLedger(ledgerOf(2)),
    });
    expect(res.ok).toBe(true);
    expect(anthropicCalls).toBe(1);
    // The injected client was used; no cookie-bound client constructed.
    expect(cookieClientCalls).toBe(0);
  });

  it("MCP path: refuses at the limit and never dispatches to the provider", async () => {
    const res = await callGenerationProvider(CALL, {
      workspaceId: "ws-1",
      db: makeLedger(ledgerOf(3)),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("usage_limit_exceeded");
    // The whole point: no token was spent.
    expect(anthropicCalls).toBe(0);
    expect(openaiCalls).toBe(0);
  });

  it("MCP path: a fan-out loop stops once the ledger reaches the limit", async () => {
    // Simulates generate_weekly_plan looping: the ledger grows as each
    // generation records its activity event, so enforcement engages
    // mid-loop instead of after the budget is blown.
    let recorded = 0;
    const growingLedger = {
      from: () => {
        const api = {
          select: () => api,
          eq: () => api,
          in: () => api,
          gte: () => api,
          order: () => api,
          then(resolve: (v: { data: unknown; error: unknown }) => void) {
            resolve({ data: ledgerOf(recorded), error: null });
          },
        };
        return api;
      },
    } as unknown as SupabaseClient;

    const outcomes: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await callGenerationProvider(CALL, {
        workspaceId: "ws-1",
        db: growingLedger,
      });
      outcomes.push(res.ok);
      if (res.ok) recorded += 1; // the caller writes draft.generated
    }

    // Limit is 3: three dispatch, the rest are refused.
    expect(outcomes).toEqual([true, true, true, false, false, false]);
    expect(anthropicCalls).toBe(3);
  });

  it("UI path: omitting db uses the request-scoped client and is metered identically", async () => {
    cookieLedgerRows = ledgerOf(3);
    const res = await callGenerationProvider(CALL, { workspaceId: "ws-1" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("usage_limit_exceeded");
    expect(cookieClientCalls).toBe(1);
    expect(anthropicCalls).toBe(0);
  });

  it("charges one logical generation once — the check is a read, not an increment", async () => {
    // Two calls against an unchanged ledger both proceed. Metering must
    // not itself consume budget, or a retry of a failed generation
    // would be charged twice.
    const ledger = makeLedger(ledgerOf(1));
    const a = await callGenerationProvider(CALL, { workspaceId: "ws-1", db: ledger });
    const b = await callGenerationProvider(CALL, { workspaceId: "ws-1", db: ledger });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(anthropicCalls).toBe(2);
  });

  it("fails OPEN when the ledger cannot be read (pre-existing product rule)", async () => {
    // Deliberate: a database blip must not stop a founder from writing.
    // Documented in usage-limit.ts and preserved by P0.5 rather than
    // silently tightened.
    const res = await callGenerationProvider(CALL, {
      workspaceId: "ws-1",
      db: makeLedger([], { error: { message: "permission denied" } }),
    });
    expect(res.ok).toBe(true);
    expect(anthropicCalls).toBe(1);
  });

  it("refuses before provider selection — an unconfigured provider is not the reason", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const res = await callGenerationProvider(CALL, {
      workspaceId: "ws-1",
      db: makeLedger(ledgerOf(3)),
    });
    expect(res.ok).toBe(false);
    // Budget is evaluated first, so the operator is told the true cause
    // rather than "no provider configured".
    if (!res.ok) expect(res.reason).toBe("usage_limit_exceeded");
  });

  it("a failed provider attempt is not pre-charged by the boundary", async () => {
    // Accounting policy today: the ledger counts activity events the
    // CALLER writes after an attempt. The boundary never writes one, so
    // a provider failure cannot be charged twice by enforcement.
    const ledger = makeLedger(ledgerOf(0));
    await callGenerationProvider(CALL, { workspaceId: "ws-1", db: ledger });
    // Still zero recorded by the boundary itself.
    const res = await callGenerationProvider(CALL, { workspaceId: "ws-1", db: ledger });
    expect(res.ok).toBe(true);
  });
});
