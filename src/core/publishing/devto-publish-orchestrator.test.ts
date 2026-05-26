import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase F7.1 — dev.to orchestrator-level regression guards.
 *
 * Asserts:
 *   - missing per-identity key (and legacy fallback off) → token_missing
 *   - non-article intent in platform_publish_intent → refuse BEFORE
 *     network call
 *   - matching identity + token + article intent → publishToDevto is
 *     called once with the decrypted key
 *   - the api-key never appears in any returned outcome
 */

// ---- Hoisted mocks ----

const { publishToDevtoMock } = vi.hoisted(() => ({
  publishToDevtoMock: vi.fn(),
}));
vi.mock("./publish-devto", () => ({
  publishToDevto: publishToDevtoMock,
}));

const accountFixture = {
  id: "acct-1",
  workspaceId: "ws-1",
  productId: null,
  platform: "devto",
  handle: "petro",
  displayName: "Petro",
  role: null,
  voiceProfile: null,
  status: "active",
  connectionStatus: "connected",
  source: "operator",
  reviewStatus: "confirmed",
  sourceWebsiteUrl: null,
  referenceUrls: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

let connectionFixture: {
  id: string;
  hasAccessToken: boolean;
  connectionStatus: "connected" | "expired";
  providerAccountId: string;
  handle: string;
} | null = null;

vi.mock("@/repositories/account-repository", () => ({
  getAccountById: vi.fn(async () => accountFixture),
}));

let encryptedTokenFixture: { accessTokenEncrypted: string | null } | null = null;

vi.mock("@/repositories/platform-connection-repository", () => ({
  getConnectionForAccount: vi.fn(async () => connectionFixture),
  readEncryptedTokens: vi.fn(async () => encryptedTokenFixture),
}));

let cipherAvailable = true;
vi.mock("@/core/platform-oauth", () => ({
  getTokenCipher: vi.fn(() => ({ isAvailable: () => cipherAvailable })),
  decryptForOutboundUse: vi.fn(() => "DECRYPTED_DEVTO_KEY"),
}));

let legacyFallback = false;
vi.mock("./platform-credentials", () => ({
  isDevtoLegacyFallbackEnabled: vi.fn(() => legacyFallback),
  readDevtoCredentials: vi.fn(() => ({ platform: "devto", apiKey: "LEGACY_ENV_KEY" })),
}));

// Supabase mock for the intent gate (loads platform_publish_intent).
let intentRow: { platform_publish_intent: Record<string, unknown> | null } | null = null;

function makeSupabase(): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: intentRow, error: null }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: vi.fn(() => makeSupabase()),
}));

// ---- Imports under test (after vi.mock) ----

import { publishDevtoForIdentity } from "./devto-publish-orchestrator";
import type { PublishRequest } from "./publishing-types";

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "devto",
    accountId: "acct-1",
    productId: null,
    title: "An article",
    body: "Markdown body",
    linkUrl: null,
    target: null,
    mode: "live",
    creative: null,
    ...over,
  };
}

beforeEach(() => {
  publishToDevtoMock.mockReset();
  connectionFixture = null;
  encryptedTokenFixture = null;
  cipherAvailable = true;
  legacyFallback = false;
  intentRow = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("publishDevtoForIdentity — token discovery", () => {
  it("missing connection + legacy fallback OFF → devto_token_missing", async () => {
    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("devto_token_missing");
    expect(publishToDevtoMock).not.toHaveBeenCalled();
  });

  it("connection exists, encrypted blob → decrypted key handed to publisher", async () => {
    connectionFixture = {
      id: "conn-1",
      hasAccessToken: true,
      connectionStatus: "connected",
      providerAccountId: "555",
      handle: "petro",
    };
    encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
    publishToDevtoMock.mockResolvedValue({
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "999",
      externalUrl: "https://dev.to/petro/a",
      metadata: {},
    });

    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
    expect(publishToDevtoMock).toHaveBeenCalledTimes(1);
    const call = publishToDevtoMock.mock.calls[0][0];
    expect(call.apiKey).toBe("DECRYPTED_DEVTO_KEY");
    expect(call.published).toBe(true);
    // The orchestrator tags the outcome's metadata with the publish
    // path so audit can grep legacy-fallback usage.
    expect(out.metadata.devto_publish_path).toBe("identity");
  });

  it("missing connection + legacy fallback ON → env key used, path=legacy_env", async () => {
    legacyFallback = true;
    publishToDevtoMock.mockResolvedValue({
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "999",
      externalUrl: "https://dev.to/x/y",
      metadata: {},
    });

    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
    expect(publishToDevtoMock).toHaveBeenCalledTimes(1);
    expect(publishToDevtoMock.mock.calls[0][0].apiKey).toBe("LEGACY_ENV_KEY");
    expect(out.metadata.devto_publish_path).toBe("legacy_env");
  });

  it("cipher unavailable + identity blob exists → token_missing (refuse to decrypt)", async () => {
    cipherAvailable = false;
    connectionFixture = {
      id: "conn-1",
      hasAccessToken: true,
      connectionStatus: "connected",
      providerAccountId: "555",
      handle: "petro",
    };
    encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.reasonCode).toBe("devto_token_missing");
    expect(publishToDevtoMock).not.toHaveBeenCalled();
  });
});

describe("publishDevtoForIdentity — intent gate", () => {
  function withIdentityKey() {
    connectionFixture = {
      id: "conn-1",
      hasAccessToken: true,
      connectionStatus: "connected",
      providerAccountId: "555",
      handle: "petro",
    };
    encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
    publishToDevtoMock.mockResolvedValue({
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "999",
      externalUrl: "https://dev.to/x/y",
      metadata: {},
    });
  }

  it("legacy intent (envelope=null) → proceed", async () => {
    withIdentityKey();
    intentRow = { platform_publish_intent: null };
    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
    expect(publishToDevtoMock).toHaveBeenCalled();
  });

  it("intent='article' → proceed", async () => {
    withIdentityKey();
    intentRow = {
      platform_publish_intent: { version: 1, platform: "devto", intent: "article" },
    };
    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
  });

  it("intent='new_post' → REFUSE with devto_requires_article_intent (NO publisher call)", async () => {
    withIdentityKey();
    intentRow = {
      platform_publish_intent: { version: 1, platform: "devto", intent: "new_post" },
    };
    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("devto_requires_article_intent");
    expect(publishToDevtoMock).not.toHaveBeenCalled();
  });

  it("intent='thread' → REFUSE with devto_requires_article_intent", async () => {
    withIdentityKey();
    intentRow = {
      platform_publish_intent: { version: 1, platform: "devto", intent: "thread" },
    };
    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.reasonCode).toBe("devto_requires_article_intent");
  });
});

describe("publishDevtoForIdentity — secret hygiene", () => {
  it("the decrypted API key never appears in any returned outcome", async () => {
    connectionFixture = {
      id: "conn-1",
      hasAccessToken: true,
      connectionStatus: "connected",
      providerAccountId: "555",
      handle: "petro",
    };
    encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
    publishToDevtoMock.mockResolvedValue({
      status: "failed",
      reasonCode: "devto_token_invalid",
      reasonDetail: "dev.to returned 401",
      externalId: null,
      externalUrl: null,
      metadata: { http_status: 401, endpoint: "articles" },
    });

    const out = await publishDevtoForIdentity({ request: baseRequest() });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("DECRYPTED_DEVTO_KEY");
  });
});

describe("publishDevtoForIdentity — cross-platform isolation", () => {
  it("identity.platform !== 'devto' → platform_mismatch", async () => {
    // Mutate the fixture's platform; restore via beforeEach already
    // resets state for the next test in this describe.
    (accountFixture as unknown as { platform: string }).platform = "bluesky";
    const out = await publishDevtoForIdentity({ request: baseRequest() });
    expect(out.reasonCode).toBe("platform_mismatch");
    expect(publishToDevtoMock).not.toHaveBeenCalled();
    (accountFixture as unknown as { platform: string }).platform = "devto";
  });
});
