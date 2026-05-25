import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Regression guards for the scheduler / Bluesky orchestrator DB
 * plumbing. The cron-triggered scheduler tick runs without an
 * operator cookie, so a fresh `createSupabaseServerClient()` is
 * blocked by RLS on growth_accounts / platform_connections. The
 * orchestrator must accept an injected service-role client and
 * forward it to every repository call.
 *
 * Pre-fix symptom in production:
 *   execution_item.status = "failed"
 *   metadata.publish_outcome.reason_code = "missing_account"
 *   reason_detail = "Identity not found in workspace."
 * even though the growth_accounts row clearly existed under
 * service-role inspection.
 */

// ---------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------
//
// We mock the repository modules so the orchestrator runs without I/O.
// Each mock records the `db` argument it receives so the test can
// assert the plumbing without re-implementing Supabase semantics.

const calls = {
  getAccountById: [] as Array<{ db: SupabaseClient | undefined }>,
  getConnectionForAccount: [] as Array<{ db: SupabaseClient | undefined }>,
  readEncryptedTokens: [] as Array<{ db: SupabaseClient | undefined }>,
  setAccountConnectionStatus: [] as Array<{ db: SupabaseClient | undefined }>,
  markConnectionStatus: [] as Array<{ db: SupabaseClient | undefined }>,
  upsertPlatformConnection: [] as Array<{ db: SupabaseClient | undefined }>,
};

interface AccountFixture {
  workspaceId: string;
  accountId: string;
  platform: string;
  handle: string | null;
}

interface ConnectionFixture {
  id: string;
  hasAccessToken: boolean;
  connectionStatus: "connected" | "expired" | "reauthorization_required";
  providerAccountId: string | null;
  handle: string | null;
}

let accountFixture: AccountFixture | "not_found" = "not_found";
let connectionFixture: ConnectionFixture | null = null;

vi.mock("@/repositories/account-repository", () => ({
  getAccountById: vi.fn(
    async (workspaceId: string, accountId: string, db?: SupabaseClient) => {
      calls.getAccountById.push({ db });
      if (
        accountFixture === "not_found" ||
        accountFixture.workspaceId !== workspaceId ||
        accountFixture.accountId !== accountId
      ) {
        throw new Error("Account not found");
      }
      return {
        id: accountFixture.accountId,
        workspaceId: accountFixture.workspaceId,
        platform: accountFixture.platform,
        handle: accountFixture.handle,
      };
    },
  ),
  setAccountConnectionStatus: vi.fn(
    async (_input: unknown, db?: SupabaseClient) => {
      calls.setAccountConnectionStatus.push({ db });
      return {};
    },
  ),
}));

vi.mock("@/repositories/platform-connection-repository", () => ({
  getConnectionForAccount: vi.fn(
    async (
      _workspaceId: string,
      _accountId: string,
      _platform: unknown,
      db?: SupabaseClient,
    ) => {
      calls.getConnectionForAccount.push({ db });
      return connectionFixture;
    },
  ),
  readEncryptedTokens: vi.fn(
    async (_workspaceId: string, _connectionId: string, db?: SupabaseClient) => {
      calls.readEncryptedTokens.push({ db });
      return null;
    },
  ),
  markConnectionStatus: vi.fn(async (_input: unknown, db?: SupabaseClient) => {
    calls.markConnectionStatus.push({ db });
    return {};
  }),
  upsertPlatformConnection: vi.fn(
    async (_input: unknown, db?: SupabaseClient) => {
      calls.upsertPlatformConnection.push({ db });
      return {};
    },
  ),
}));

// Cipher must report available so the orchestrator picks the
// identity path and doesn't divert to the legacy fallback.
vi.mock("@/core/platform-oauth", () => ({
  decryptForOutboundUse: vi.fn(() => null),
  getTokenCipher: vi.fn(() => ({ isAvailable: () => true })),
}));

vi.mock("@/core/platform-oauth/token-storage", () => ({
  encryptTokenResponse: vi.fn(() => ({ ok: false, reason: "test" })),
}));

vi.mock("./platform-credentials", () => ({
  readBlueskyServiceUrl: vi.fn(() => "https://bsky.social"),
  isBlueskyLegacyFallbackEnabled: vi.fn(() => false),
  readBlueskyCredentials: vi.fn(() => null),
}));

vi.mock("@/core/identity-verifiers/bluesky-session", () => ({
  refreshBlueskySession: vi.fn(),
}));

vi.mock("@/core/identity-verifiers/bluesky-resolve", () => ({
  normalizeBlueskyHandle: vi.fn((s: string | null) => s),
}));

vi.mock("./publish-bluesky", () => ({
  publishToBluesky: vi.fn(),
  publishToBlueskyAsIdentity: vi.fn(),
}));

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

import { publishBlueskyForIdentity } from "./bluesky-publish-orchestrator";
import type { PublishRequest } from "./publishing-types";

const FAKE_DB = { __sentinel: "service-role" } as unknown as SupabaseClient;

function baseRequest(): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "bluesky",
    accountId: "acct-1",
    productId: null,
    title: "t",
    body: "b",
    linkUrl: null,
    target: null,
    mode: "live",
  };
}

beforeEach(() => {
  for (const k of Object.keys(calls) as Array<keyof typeof calls>) {
    calls[k].length = 0;
  }
  accountFixture = "not_found";
  connectionFixture = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("publishBlueskyForIdentity — db plumbing", () => {
  it("forwards the injected db client to getAccountById", async () => {
    accountFixture = {
      workspaceId: "ws-1",
      accountId: "acct-1",
      platform: "bluesky",
      handle: "h",
    };
    connectionFixture = null;

    await publishBlueskyForIdentity({ request: baseRequest(), db: FAKE_DB });

    expect(calls.getAccountById).toHaveLength(1);
    expect(calls.getAccountById[0].db).toBe(FAKE_DB);
  });

  it("forwards the injected db client to getConnectionForAccount once the identity loads", async () => {
    accountFixture = {
      workspaceId: "ws-1",
      accountId: "acct-1",
      platform: "bluesky",
      handle: "h",
    };
    connectionFixture = null;

    await publishBlueskyForIdentity({ request: baseRequest(), db: FAKE_DB });

    expect(calls.getConnectionForAccount).toHaveLength(1);
    expect(calls.getConnectionForAccount[0].db).toBe(FAKE_DB);
  });

  it("omits db (undefined) when the caller doesn't pass one — manual publish path stays cookie-aware", async () => {
    accountFixture = {
      workspaceId: "ws-1",
      accountId: "acct-1",
      platform: "bluesky",
      handle: "h",
    };
    connectionFixture = null;

    await publishBlueskyForIdentity({ request: baseRequest() });

    expect(calls.getAccountById[0].db).toBeUndefined();
    expect(calls.getConnectionForAccount[0].db).toBeUndefined();
  });
});

describe("publishBlueskyForIdentity — outcomes", () => {
  it("genuinely missing account still returns missing_account (the original prod symptom remains for real misses)", async () => {
    accountFixture = "not_found";

    const out = await publishBlueskyForIdentity({
      request: baseRequest(),
      db: FAKE_DB,
    });

    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("missing_account");
    expect(out.reasonDetail).toMatch(/Identity not found/);
    // The repo was actually called — we didn't short-circuit before
    // attempting the read.
    expect(calls.getAccountById).toHaveLength(1);
    // We never reached the connection lookup.
    expect(calls.getConnectionForAccount).toHaveLength(0);
  });

  it("identity exists but no platform_connections row → session_missing (no legacy fallback)", async () => {
    accountFixture = {
      workspaceId: "ws-1",
      accountId: "acct-1",
      platform: "bluesky",
      handle: "h",
    };
    connectionFixture = null;

    const out = await publishBlueskyForIdentity({
      request: baseRequest(),
      db: FAKE_DB,
    });

    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("session_missing");
    // db was forwarded all the way through — proves the false-negative
    // session_missing isn't an RLS artefact.
    expect(calls.getConnectionForAccount[0].db).toBe(FAKE_DB);
  });

  it("identity on a non-Bluesky platform → platform_mismatch", async () => {
    accountFixture = {
      workspaceId: "ws-1",
      accountId: "acct-1",
      platform: "reddit",
      handle: "h",
    };

    const out = await publishBlueskyForIdentity({
      request: baseRequest(),
      db: FAKE_DB,
    });

    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("platform_mismatch");
  });

  it("missing accountId on the request → missing_account (early refusal)", async () => {
    const req = { ...baseRequest(), accountId: "" };

    const out = await publishBlueskyForIdentity({
      request: req,
      db: FAKE_DB,
    });

    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("missing_account");
    // No repo calls when the request itself lacks accountId.
    expect(calls.getAccountById).toHaveLength(0);
    expect(calls.getConnectionForAccount).toHaveLength(0);
  });
});
