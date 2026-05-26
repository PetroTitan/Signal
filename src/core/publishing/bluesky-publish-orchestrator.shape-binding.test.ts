import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Phase F6.2 — orchestrator-level shape-binding regression guards.
 *
 * Asserts that:
 *   - a stale operatorApprovedShapeHash short-circuits the publish
 *     BEFORE any provider call (no publishToBlueskyAsIdentity, no
 *     uploadBlob, no createRecord);
 *   - a matching hash proceeds normally;
 *   - a legacy row (null platform_publish_intent) proceeds normally.
 *
 * Kept in a separate file so its module-level mocks (Supabase row
 * loader) don't affect the existing db-plumbing tests.
 */

// ---------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------

const accountFixture = {
  workspaceId: "ws-1",
  accountId: "acct-1",
  platform: "bluesky",
  handle: "h.bsky.social",
};

const connectionFixture = {
  id: "conn-1",
  hasAccessToken: true,
  connectionStatus: "connected" as const,
  providerAccountId: "did:plc:test",
  handle: "h.bsky.social",
};

vi.mock("@/repositories/account-repository", () => ({
  getAccountById: vi.fn(async () => accountFixture),
  setAccountConnectionStatus: vi.fn(async () => ({})),
}));

vi.mock("@/repositories/platform-connection-repository", () => ({
  getConnectionForAccount: vi.fn(async () => connectionFixture),
  readEncryptedTokens: vi.fn(async () => ({
    accessTokenEncrypted: "enc-access",
    refreshTokenEncrypted: null,
  })),
  markConnectionStatus: vi.fn(async () => ({})),
  upsertPlatformConnection: vi.fn(async () => ({})),
}));

vi.mock("@/core/platform-oauth", () => ({
  decryptForOutboundUse: vi.fn(() => "decrypted-jwt"),
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

const { publishToBlueskyAsIdentityMock } = vi.hoisted(() => ({
  publishToBlueskyAsIdentityMock: vi.fn(),
}));
vi.mock("./publish-bluesky", () => ({
  publishToBluesky: vi.fn(),
  publishToBlueskyAsIdentity: publishToBlueskyAsIdentityMock,
}));

// Supabase client mock used by loadAndCheckBlueskyShapeGate.
// `from("weekly_plan_items").select(...).eq(...).eq(...).maybeSingle()`
// must resolve with a row carrying the desired platform_publish_intent.
let mockRow: { title: string | null; body: string | null; platform_publish_intent: Record<string, unknown> | null } | null = null;

function makeSupabase(): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: mockRow, error: null }),
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: vi.fn(() => makeSupabase()),
}));

// ---------------------------------------------------------------------

import { publishBlueskyForIdentity } from "./bluesky-publish-orchestrator";
import { blueskyAdapter } from "@/core/platform-native/adapters/bluesky";
import {
  computeProviderPayloadHash,
  legacyPlatformNativeShape,
  serializePlatformNativeShape,
} from "@/core/platform-native";
import type { PublishRequest } from "./publishing-types";

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "bluesky",
    accountId: "acct-1",
    productId: null,
    title: "stable title",
    body: "stable body",
    linkUrl: null,
    target: null,
    mode: "live",
    creative: null,
    ...over,
  };
}

beforeEach(() => {
  publishToBlueskyAsIdentityMock.mockReset();
  mockRow = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("publishBlueskyForIdentity — shape-binding gate", () => {
  it("legacy row (null platform_publish_intent) → gate is a no-op, publisher called", async () => {
    mockRow = {
      title: "stable title",
      body: "stable body",
      platform_publish_intent: null,
    };
    publishToBlueskyAsIdentityMock.mockResolvedValue({
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "at://x",
      externalUrl: "https://bsky.app/x",
      metadata: {},
    });

    const out = await publishBlueskyForIdentity({ request: baseRequest() });

    expect(out.status).toBe("published");
    expect(publishToBlueskyAsIdentityMock).toHaveBeenCalledTimes(1);
  });

  it("envelope present but no operatorApprovedShapeHash → proceed (MCP-prepared, not approved)", async () => {
    mockRow = {
      title: "stable title",
      body: "stable body",
      platform_publish_intent: serializePlatformNativeShape({
        ...legacyPlatformNativeShape("bluesky"),
        intent: "new_post",
        threadMode: "auto_thread_allowed",
        mediaMode: "none",
      }),
    };
    publishToBlueskyAsIdentityMock.mockResolvedValue({
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "at://x",
      externalUrl: "https://bsky.app/x",
      metadata: {},
    });

    const out = await publishBlueskyForIdentity({ request: baseRequest() });

    expect(out.status).toBe("published");
    expect(publishToBlueskyAsIdentityMock).toHaveBeenCalledTimes(1);
  });

  it("matching approved hash → publisher invoked", async () => {
    const shape = {
      ...legacyPlatformNativeShape("bluesky"),
      intent: "new_post" as const,
      threadMode: "auto_thread_allowed" as const,
      mediaMode: "none" as const,
    };
    const preview = blueskyAdapter.buildPreview({
      title: "stable title",
      body: "stable body",
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: null,
      shape,
    });
    const approvedHash = await computeProviderPayloadHash(preview);

    mockRow = {
      title: "stable title",
      body: "stable body",
      platform_publish_intent: serializePlatformNativeShape({
        ...shape,
        operatorApprovedShapeHash: approvedHash,
      }),
    };
    publishToBlueskyAsIdentityMock.mockResolvedValue({
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "at://x",
      externalUrl: "https://bsky.app/x",
      metadata: {},
    });

    const out = await publishBlueskyForIdentity({ request: baseRequest() });

    expect(out.status).toBe("published");
    expect(publishToBlueskyAsIdentityMock).toHaveBeenCalledTimes(1);
  });

  it("body drifted after approval → BLOCK with approved_shape_stale, NO publisher call", async () => {
    const shape = {
      ...legacyPlatformNativeShape("bluesky"),
      intent: "new_post" as const,
      threadMode: "auto_thread_allowed" as const,
      mediaMode: "none" as const,
    };
    // Approval was bound to "original body".
    const approvedPreview = blueskyAdapter.buildPreview({
      title: "stable title",
      body: "original body",
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: null,
      shape,
    });
    const approvedHash = await computeProviderPayloadHash(approvedPreview);

    // Row now carries "edited body" — drift.
    mockRow = {
      title: "stable title",
      body: "edited body",
      platform_publish_intent: serializePlatformNativeShape({
        ...shape,
        operatorApprovedShapeHash: approvedHash,
      }),
    };

    const out = await publishBlueskyForIdentity({
      request: baseRequest({ body: "edited body" }),
    });

    expect(out.status).toBe("blocked");
    expect(out.reasonCode).toBe("approved_shape_stale");
    expect(out.reasonDetail).toMatch(/operator-approved/i);
    // No provider call — operator safety contract.
    expect(publishToBlueskyAsIdentityMock).not.toHaveBeenCalled();
    // Metadata carries the hash pair for audit / observability.
    expect(out.metadata.approved_shape_hash).toBe(approvedHash);
    expect(out.metadata.current_shape_hash).toBeTruthy();
    expect(out.metadata.current_shape_hash).not.toBe(approvedHash);
    expect(out.metadata.endpoint).toBeNull();
  });

  it("creative attached after approval → BLOCK with approved_shape_stale, NO publisher call", async () => {
    const shape = {
      ...legacyPlatformNativeShape("bluesky"),
      intent: "new_post" as const,
      threadMode: "auto_thread_allowed" as const,
      mediaMode: "first_part_only" as const,
    };
    // Approval was bound to a creative-less version.
    const approvedPreview = blueskyAdapter.buildPreview({
      title: "stable title",
      body: "stable body",
      identity: { displayName: null, handle: null, avatarUrl: null },
      creative: null,
      shape,
    });
    const approvedHash = await computeProviderPayloadHash(approvedPreview);

    mockRow = {
      title: "stable title",
      body: "stable body",
      platform_publish_intent: serializePlatformNativeShape({
        ...shape,
        operatorApprovedShapeHash: approvedHash,
      }),
    };

    const out = await publishBlueskyForIdentity({
      request: baseRequest({
        body: "stable body",
        // Creative present in the request → drift.
        creative: {
          id: "c-1",
          creativeType: "image",
          sourceType: "uploaded",
          assetUrl: "https://example.com/x.jpg",
          sourceUrl: null,
          altText: "A picture",
        },
      }),
    });

    expect(out.status).toBe("blocked");
    expect(out.reasonCode).toBe("approved_shape_stale");
    expect(publishToBlueskyAsIdentityMock).not.toHaveBeenCalled();
  });
});
