import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase F9 — OAuth state consumption regression.
 *
 * Pre-fix `consumeOAuthState` used the cookie-aware Supabase client.
 * The OAuth callback runs after a cross-site provider redirect
 * (X / Reddit / LinkedIn). When the SameSite=Lax session cookie is
 * dropped on that round-trip (or the session has expired), the
 * cookie client reads with `auth.uid()` null and the RLS policy on
 * `oauth_state_tokens` silently returns zero rows. Callback throws
 * `state_mismatch`, no `platform_connections` row gets written,
 * operators see "Not signed in" forever.
 *
 * Production-state confirmation: 5 `oauth_state_tokens` rows for X
 * accumulated uncosumed, zero `platform_connections` rows for any
 * OAuth-flow platform across the entire DB.
 *
 * The fix uses the service-role client for state consumption — the
 * state token's intrinsic secrecy (32-byte base64url) + one-shot
 * delete-on-read is the auth boundary; RLS is redundant here.
 *
 * These tests pin:
 *   - service-role client is preferred when available
 *   - cookie-aware client is the fallback (preserves existing
 *     behaviour in environments without SUPABASE_SERVICE_ROLE_KEY)
 *   - one-shot delete-on-read happens regardless of which client
 *     handled the read
 */

interface MockClientCalls {
  selectCalled: boolean;
  deleteCalled: boolean;
  lookupResult: { data: Record<string, unknown> | null; error: null };
}

function makeClient(calls: MockClientCalls) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            calls.selectCalled = true;
            return calls.lookupResult;
          },
        }),
      }),
      delete: () => ({
        eq: async () => {
          calls.deleteCalled = true;
          return { error: null };
        },
      }),
    }),
  };
}

let cookieCalls: MockClientCalls = {
  selectCalled: false,
  deleteCalled: false,
  lookupResult: { data: null, error: null },
};
let serviceCalls: MockClientCalls = {
  selectCalled: false,
  deleteCalled: false,
  lookupResult: { data: null, error: null },
};
let serviceRoleAvailable = true;

vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: vi.fn(() => makeClient(cookieCalls)),
}));
vi.mock("@/lib/supabase/service-role", () => ({
  createSupabaseServiceRoleClient: vi.fn(() =>
    serviceRoleAvailable ? makeClient(serviceCalls) : null,
  ),
}));

import { consumeOAuthState } from "./platform-connection-repository";

const SAMPLE_STATE_ROW = {
  state: "abc123",
  workspace_id: "ws-1",
  user_id: "user-1",
  platform: "x",
  account_id: "acct-1",
  redirect_after: "/accounts",
  code_verifier: "verifier-xyz",
  expires_at: new Date(Date.now() + 600_000).toISOString(),
};

beforeEach(() => {
  cookieCalls = {
    selectCalled: false,
    deleteCalled: false,
    lookupResult: { data: null, error: null },
  };
  serviceCalls = {
    selectCalled: false,
    deleteCalled: false,
    lookupResult: { data: null, error: null },
  };
  serviceRoleAvailable = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("consumeOAuthState — service-role client preferred", () => {
  it("reads + deletes the state row via the service-role client when available (RLS bypass — state value is the auth boundary)", async () => {
    serviceCalls.lookupResult = { data: SAMPLE_STATE_ROW, error: null };
    const row = await consumeOAuthState("abc123");
    expect(row).toEqual(SAMPLE_STATE_ROW);
    // Service-role client did the read AND the delete.
    expect(serviceCalls.selectCalled).toBe(true);
    expect(serviceCalls.deleteCalled).toBe(true);
    // Cookie client was NEVER consulted (no double-read).
    expect(cookieCalls.selectCalled).toBe(false);
    expect(cookieCalls.deleteCalled).toBe(false);
  });

  it("returns null when service-role client finds no row (one-shot prevents replay; missing state isn't a fallback trigger)", async () => {
    // Service-role client is available but the state row doesn't
    // exist (already consumed, expired, or bogus). Returns null
    // WITHOUT consulting the cookie client — failure semantics
    // unchanged from the pre-fix behavior.
    serviceCalls.lookupResult = { data: null, error: null };
    const row = await consumeOAuthState("nonexistent");
    expect(row).toBeNull();
    expect(serviceCalls.selectCalled).toBe(true);
    expect(serviceCalls.deleteCalled).toBe(false);
    expect(cookieCalls.selectCalled).toBe(false);
  });
});

describe("consumeOAuthState — cookie-aware fallback when service-role unavailable", () => {
  it("falls back to the cookie-aware client when SUPABASE_SERVICE_ROLE_KEY is not configured", async () => {
    serviceRoleAvailable = false;
    cookieCalls.lookupResult = { data: SAMPLE_STATE_ROW, error: null };
    const row = await consumeOAuthState("abc123");
    expect(row).toEqual(SAMPLE_STATE_ROW);
    expect(cookieCalls.selectCalled).toBe(true);
    expect(cookieCalls.deleteCalled).toBe(true);
    // Service-role client returned null → not used.
    expect(serviceCalls.selectCalled).toBe(false);
  });

  it("returns null when both clients miss the row", async () => {
    serviceRoleAvailable = false;
    cookieCalls.lookupResult = { data: null, error: null };
    const row = await consumeOAuthState("nonexistent");
    expect(row).toBeNull();
  });
});
