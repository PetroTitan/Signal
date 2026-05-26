/**
 * Per-identity invariant tests for the platform_connections
 * repository.
 *
 * Decision pin: one platform_connections row belongs to exactly one
 * (workspace_id, account_id, platform) tuple. The repository must
 * NOT rebind a row across identities even if the same
 * provider_account_id (DID / dev.to user id / Hashnode user id) ends
 * up resolving to a second identity in the same workspace.
 *
 * These tests cover two layers:
 *
 *   1. Behaviour: with a mocked Supabase client, the repository
 *      surfaces the typed `PlatformConnectionAttachedToAnotherIdentityError`
 *      when the insert path hits the
 *      `platform_connections_unique_provider` 23505.
 *
 *   2. Source pins: the repository file no longer contains the
 *      cross-identity fallback lookup, and the hashnode/devto/bluesky
 *      connect routes both import the typed error AND surface a
 *      closed-list `attached_to_another_identity` JSON code.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

// =============================================================================
// Supabase mock builder
// =============================================================================

interface MockChain {
  /** What the `.maybeSingle()` lookup returns. */
  lookup: { data: { id: string } | null; error: { code: string } | null };
  /** What the `.insert(...).select(...).single()` write returns. */
  insertResult: {
    data: Record<string, unknown> | null;
    error: { code: string } | null;
  };
}

let chain: MockChain = {
  lookup: { data: null, error: null },
  insertResult: { data: null, error: null },
};

function makeSupabase(): SupabaseClient {
  return {
    from: () => ({
      // Lookup builder used by upsertPlatformConnection's
      // (workspace_id, account_id, platform) read.
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => chain.lookup,
            }),
          }),
        }),
      }),
      // Insert builder used when no existing row is found. Mirrors
      //   .insert(...).select("…").single()
      insert: () => ({
        select: () => ({
          single: async () => chain.insertResult,
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: vi.fn(() => makeSupabase()),
}));

import {
  PlatformConnectionAttachedToAnotherIdentityError,
  upsertPlatformConnection,
} from "./platform-connection-repository";

beforeEach(() => {
  chain = {
    lookup: { data: null, error: null },
    insertResult: { data: null, error: null },
  };
});

// =============================================================================
// 1. Behaviour
// =============================================================================

describe("upsertPlatformConnection — per-identity invariant", () => {
  it("throws PlatformConnectionAttachedToAnotherIdentityError when the insert hits a 23505 unique violation", async () => {
    // The lookup misses (no row for this identity yet) so we go to
    // INSERT. The INSERT then hits the
    // platform_connections_unique_provider 23505 because a sibling
    // identity already owns the same provider_account_id.
    chain = {
      lookup: { data: null, error: null },
      insertResult: { data: null, error: { code: "23505" } },
    };

    await expect(
      upsertPlatformConnection({
        workspaceId: "ws-1",
        accountId: "identity-B",
        platform: "hashnode",
        providerAccountId: "hashnode-uid-shared",
        handle: "@operator",
        displayName: null,
        scopes: [],
        accessTokenEncrypted: "sealed-key",
        refreshTokenEncrypted: null,
        expiresAt: null,
        connectionStatus: "connected",
      }),
    ).rejects.toBeInstanceOf(PlatformConnectionAttachedToAnotherIdentityError);
  });

  it("the typed error carries the closed-list code", () => {
    const err = new PlatformConnectionAttachedToAnotherIdentityError();
    expect(err.code).toBe("attached_to_another_identity");
    expect(err.name).toBe("PlatformConnectionAttachedToAnotherIdentityError");
  });

  it("other Postgres errors still flow through fromPostgres (not the typed error)", async () => {
    chain = {
      lookup: { data: null, error: null },
      // Some other error code — e.g. CHECK constraint violation.
      insertResult: { data: null, error: { code: "23514" } },
    };

    await expect(
      upsertPlatformConnection({
        workspaceId: "ws-1",
        accountId: "identity-A",
        platform: "devto",
        providerAccountId: "devto-uid-1",
        handle: "@op",
        displayName: null,
        scopes: [],
        accessTokenEncrypted: "sealed",
        refreshTokenEncrypted: null,
        expiresAt: null,
        connectionStatus: "connected",
      }),
    ).rejects.not.toBeInstanceOf(
      PlatformConnectionAttachedToAnotherIdentityError,
    );
  });
});

// =============================================================================
// 2. Source pins — old behaviour deleted, new behaviour wired
// =============================================================================

function readFile(rel: string): string {
  return readFileSync(path.join(__dirname, rel), "utf8");
}

describe("Repository source pin — strict per-identity lookup only", () => {
  const src = readFile("./platform-connection-repository.ts");

  it("declares the typed PlatformConnectionAttachedToAnotherIdentityError", () => {
    expect(src).toContain("class PlatformConnectionAttachedToAnotherIdentityError");
  });

  it("upsert no longer falls back to (workspace, platform, provider_account_id) lookup", () => {
    // Old code path looked up by provider_account_id when the
    // account-keyed lookup missed. The pin asserts that the
    // fallback select chain is gone — we should only see the
    // per-identity lookup pattern (`.eq("account_id"`) and the
    // sealed-token select that follows the insert.
    const accountIdLookups = src.match(/\.eq\("account_id",\s*input\.accountId\)/g) ?? [];
    const providerIdLookups =
      src.match(/\.eq\("provider_account_id",\s*input\.providerAccountId\)/g) ??
      [];
    // The per-identity lookup is still present (single occurrence
    // inside upsertPlatformConnection).
    expect(accountIdLookups.length).toBeGreaterThanOrEqual(1);
    // The cross-identity rebinding fallback is gone.
    expect(providerIdLookups.length).toBe(0);
  });

  it("upsert detects 23505 unique violation and throws the typed error", () => {
    expect(src).toMatch(/error\?\.code\s*===\s*"23505"/);
    expect(src).toContain(
      "throw new PlatformConnectionAttachedToAnotherIdentityError",
    );
  });
});

// =============================================================================
// 3. Source pins — connect routes surface the closed-list error code
// =============================================================================

const CONNECT_ROUTES = [
  "../app/(app)/../app/api/identity/[identityId]/hashnode/connect/route.ts",
  "../app/(app)/../app/api/identity/[identityId]/devto/connect/route.ts",
  "../app/(app)/../app/api/identity/[identityId]/bluesky/connect/route.ts",
] as const;

// The path above hops out of repositories/ first. Compute the
// canonical project-relative paths once for readability.
const ROUTE_FILES = [
  "../app/api/identity/[identityId]/hashnode/connect/route.ts",
  "../app/api/identity/[identityId]/devto/connect/route.ts",
  "../app/api/identity/[identityId]/bluesky/connect/route.ts",
] as const;

describe("Connect routes surface attached_to_another_identity", () => {
  for (const rel of ROUTE_FILES) {
    it(`${rel} imports the typed error AND returns the closed-list code`, () => {
      const src = readFile(rel);
      expect(src).toContain(
        "PlatformConnectionAttachedToAnotherIdentityError",
      );
      expect(src).toMatch(/attached_to_another_identity/);
      // The status code must be 409 — conflict semantics fit the
      // "another identity already owns this row" outcome.
      expect(src).toMatch(/jsonError\(\s*409,\s*"attached_to_another_identity"/);
    });
  }
});

// =============================================================================
// 4. UI source pin — _connection-controls.tsx renders the new code
// =============================================================================

describe("Identity card UI renders attached_to_another_identity", () => {
  it("_connection-controls.tsx handles the new code in BOTH api-key and app-password branches", () => {
    const src = readFile("../app/(app)/accounts/_connection-controls.tsx");
    const occurrences = src.match(/attached_to_another_identity/g) ?? [];
    // Two branches handle the code: personal_api_key submit +
    // bluesky app_password submit.
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});

// Reference the unused CONNECT_ROUTES helper so future readers can
// see the canonical list lives alongside ROUTE_FILES.
void CONNECT_ROUTES;
