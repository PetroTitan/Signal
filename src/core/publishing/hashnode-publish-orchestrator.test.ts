import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase F8 — Hashnode orchestrator-level regression guards.
 *
 * Asserts:
 *   - missing per-identity key (and legacy fallback off) →
 *     hashnode_token_missing (NO publisher call)
 *   - per-identity key present but publication id missing →
 *     hashnode_publication_missing (NO publisher call)
 *   - non-article intent in platform_publish_intent → refuse BEFORE
 *     network call with hashnode_requires_article_intent
 *   - matching identity + token + publication + article intent →
 *     publishToHashnode is called once with the decrypted key
 *   - the api-key never appears in any returned outcome
 */

// ---- Hoisted mocks ----

const { publishToHashnodeMock } = vi.hoisted(() => ({
  publishToHashnodeMock: vi.fn(),
}));
vi.mock("./publish-hashnode", () => ({
  publishToHashnode: publishToHashnodeMock,
}));

const accountFixture = {
  id: "acct-1",
  workspaceId: "ws-1",
  productId: null,
  platform: "hashnode",
  handle: "webmasterid",
  displayName: "WebmasterID",
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
  metadata: Record<string, unknown>;
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
  decryptForOutboundUse: vi.fn(() => "DECRYPTED_HASHNODE_KEY"),
}));

let legacyFallback = false;
let envCreds: { apiKey: string; publicationId: string } | null = null;
vi.mock("./platform-credentials", () => ({
  isHashnodeLegacyFallbackEnabled: vi.fn(() => legacyFallback),
  readHashnodeCredentials: vi.fn(() =>
    envCreds ? { platform: "hashnode", ...envCreds } : null,
  ),
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

import { publishHashnodeForIdentity } from "./hashnode-publish-orchestrator";
import type { PublishRequest } from "./publishing-types";

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "hashnode",
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

function withIdentityKeyAndPublication(): void {
  connectionFixture = {
    id: "conn-1",
    hasAccessToken: true,
    connectionStatus: "connected",
    providerAccountId: "user_abc",
    handle: "webmasterid",
    metadata: { publication_id: "pub_abc123" },
  };
  encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
  publishToHashnodeMock.mockResolvedValue({
    status: "published",
    reasonCode: "ok",
    reasonDetail: null,
    externalId: "hpost_999",
    externalUrl: "https://webmasterid.hashnode.dev/post-999",
    metadata: {
      endpoint: "publishPost",
      http_status: 200,
      slug: "post-999",
      published_at: "2026-05-26T00:00:00Z",
      publication_id: "pub_abc123",
      intent: "article",
    },
  });
}

beforeEach(() => {
  publishToHashnodeMock.mockReset();
  connectionFixture = null;
  encryptedTokenFixture = null;
  cipherAvailable = true;
  legacyFallback = false;
  envCreds = null;
  intentRow = null;
  (accountFixture as unknown as { platform: string }).platform = "hashnode";
});

afterEach(() => {
  vi.clearAllMocks();
});

// =====================================================================
// Token discovery
// =====================================================================

describe("publishHashnodeForIdentity — token discovery", () => {
  it("missing connection + legacy fallback OFF → hashnode_token_missing", async () => {
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("hashnode_token_missing");
    expect(publishToHashnodeMock).not.toHaveBeenCalled();
  });

  it("connection exists with publication id → decrypted key handed to publisher", async () => {
    withIdentityKeyAndPublication();
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
    expect(publishToHashnodeMock).toHaveBeenCalledTimes(1);
    const call = publishToHashnodeMock.mock.calls[0][0];
    expect(call.apiKey).toBe("DECRYPTED_HASHNODE_KEY");
    expect(call.publicationId).toBe("pub_abc123");
    expect(out.metadata.hashnode_publish_path).toBe("identity");
  });

  it("missing connection + legacy fallback ON + env creds → env key used, path=legacy_env", async () => {
    legacyFallback = true;
    envCreds = { apiKey: "LEGACY_ENV_KEY", publicationId: "LEGACY_ENV_PUB" };
    publishToHashnodeMock.mockResolvedValue({
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "hpost_999",
      externalUrl: "https://x.hashnode.dev/y",
      metadata: { endpoint: "publishPost" },
    });
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
    expect(publishToHashnodeMock).toHaveBeenCalledTimes(1);
    expect(publishToHashnodeMock.mock.calls[0][0].apiKey).toBe("LEGACY_ENV_KEY");
    expect(publishToHashnodeMock.mock.calls[0][0].publicationId).toBe(
      "LEGACY_ENV_PUB",
    );
    expect(out.metadata.hashnode_publish_path).toBe("legacy_env");
  });

  it("missing connection + legacy fallback ON + env creds null → hashnode_token_missing", async () => {
    legacyFallback = true;
    envCreds = null;
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.reasonCode).toBe("hashnode_token_missing");
    expect(publishToHashnodeMock).not.toHaveBeenCalled();
  });

  it("cipher unavailable + identity blob exists → token_missing (refuse to decrypt)", async () => {
    cipherAvailable = false;
    connectionFixture = {
      id: "conn-1",
      hasAccessToken: true,
      connectionStatus: "connected",
      providerAccountId: "user_abc",
      handle: "webmasterid",
      metadata: { publication_id: "pub_abc123" },
    };
    encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.reasonCode).toBe("hashnode_token_missing");
    expect(publishToHashnodeMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Publication id gate
// =====================================================================

describe("publishHashnodeForIdentity — publication-id gate", () => {
  it("connection has key but no metadata.publication_id → hashnode_publication_missing", async () => {
    connectionFixture = {
      id: "conn-1",
      hasAccessToken: true,
      connectionStatus: "connected",
      providerAccountId: "user_abc",
      handle: "webmasterid",
      metadata: {}, // publication_id missing
    };
    encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("hashnode_publication_missing");
    expect(publishToHashnodeMock).not.toHaveBeenCalled();
  });

  it("metadata.publication_id present but empty string → hashnode_publication_missing", async () => {
    connectionFixture = {
      id: "conn-1",
      hasAccessToken: true,
      connectionStatus: "connected",
      providerAccountId: "user_abc",
      handle: "webmasterid",
      metadata: { publication_id: "   " },
    };
    encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.reasonCode).toBe("hashnode_publication_missing");
    expect(publishToHashnodeMock).not.toHaveBeenCalled();
  });

  it("identity path with no metadata pub id + legacy fallback ON + env pub id → publishes using env pub id", async () => {
    // Covers the workspace-migrating-from-env-to-per-identity case.
    legacyFallback = true;
    envCreds = { apiKey: "LEGACY", publicationId: "LEGACY_ENV_PUB" };
    connectionFixture = {
      id: "conn-1",
      hasAccessToken: true,
      connectionStatus: "connected",
      providerAccountId: "user_abc",
      handle: "webmasterid",
      metadata: {},
    };
    encryptedTokenFixture = { accessTokenEncrypted: "ENC:abc" };
    publishToHashnodeMock.mockResolvedValue({
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "hpost_1",
      externalUrl: null,
      metadata: { endpoint: "publishPost" },
    });
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
    // identity-path: per-identity key was decrypted (not the env one)
    expect(publishToHashnodeMock.mock.calls[0][0].apiKey).toBe(
      "DECRYPTED_HASHNODE_KEY",
    );
    expect(publishToHashnodeMock.mock.calls[0][0].publicationId).toBe(
      "LEGACY_ENV_PUB",
    );
    expect(out.metadata.hashnode_publish_path).toBe("identity");
  });
});

// =====================================================================
// Intent gate
// =====================================================================

describe("publishHashnodeForIdentity — intent gate", () => {
  it("legacy intent (envelope=null) → proceed", async () => {
    withIdentityKeyAndPublication();
    intentRow = { platform_publish_intent: null };
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
    expect(publishToHashnodeMock).toHaveBeenCalled();
  });

  it("intent='article' → proceed", async () => {
    withIdentityKeyAndPublication();
    intentRow = {
      platform_publish_intent: {
        version: 1,
        platform: "hashnode",
        intent: "article",
      },
    };
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
  });

  it("intent='unknown' → proceed (legacy bypass)", async () => {
    withIdentityKeyAndPublication();
    intentRow = {
      platform_publish_intent: {
        version: 1,
        platform: "hashnode",
        intent: "unknown",
      },
    };
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("published");
  });

  it("intent='new_post' → REFUSE with hashnode_requires_article_intent (NO publisher call)", async () => {
    withIdentityKeyAndPublication();
    intentRow = {
      platform_publish_intent: {
        version: 1,
        platform: "hashnode",
        intent: "new_post",
      },
    };
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("hashnode_requires_article_intent");
    expect(publishToHashnodeMock).not.toHaveBeenCalled();
  });

  it("intent='thread' → REFUSE with hashnode_requires_article_intent", async () => {
    withIdentityKeyAndPublication();
    intentRow = {
      platform_publish_intent: {
        version: 1,
        platform: "hashnode",
        intent: "thread",
      },
    };
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.reasonCode).toBe("hashnode_requires_article_intent");
  });
});

// =====================================================================
// Secret hygiene
// =====================================================================

describe("publishHashnodeForIdentity — secret hygiene", () => {
  it("the decrypted API key never appears in any returned outcome", async () => {
    withIdentityKeyAndPublication();
    publishToHashnodeMock.mockResolvedValue({
      status: "failed",
      reasonCode: "hashnode_token_invalid",
      reasonDetail: "Hashnode returned 401",
      externalId: null,
      externalUrl: null,
      metadata: { http_status: 401, endpoint: "publishPost" },
    });

    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("DECRYPTED_HASHNODE_KEY");
  });
});

// =====================================================================
// Cross-platform isolation
// =====================================================================

describe("publishHashnodeForIdentity — cross-platform isolation", () => {
  it("identity.platform !== 'hashnode' → platform_mismatch", async () => {
    (accountFixture as unknown as { platform: string }).platform = "bluesky";
    const out = await publishHashnodeForIdentity({ request: baseRequest() });
    expect(out.reasonCode).toBe("platform_mismatch");
    expect(publishToHashnodeMock).not.toHaveBeenCalled();
  });

  it("missing accountId on the request → missing_account", async () => {
    const out = await publishHashnodeForIdentity({
      request: baseRequest({ accountId: "" }),
    });
    expect(out.reasonCode).toBe("missing_account");
    expect(publishToHashnodeMock).not.toHaveBeenCalled();
  });
});
