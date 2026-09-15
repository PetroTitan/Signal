import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/identity/:id/bluesky/connect reports campaign recovery
 * truthfully.
 *
 * 2026-09-15: the operator reconnected, Accounts said "Signed in", and
 * the campaign did not resume. The route had called recovery inside a
 * try/catch that logged and returned a plain success. A reconnect is
 * durable the moment the row says `connected`; whether the campaigns
 * came back HERE is a separate fact that the response must state —
 * `recovery_pending: true` when it did not, so nobody reads "Signed in"
 * as "campaigns running".
 */

const calls = {
  recover: [] as unknown[],
};
let recoverImpl: () => Promise<unknown[]> = async () => [];
let serviceClientAvailable = true;

vi.mock("@/lib/supabase", () => ({
  createSupabaseServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/repositories/workspace-repository", () => ({
  getPrimaryWorkspace: async () => ({ workspace: { id: "ws-1" } }),
}));
vi.mock("@/repositories/account-repository", () => ({
  getAccountById: async () => ({ id: "acct-1", platform: "bluesky", handle: "op.bsky.social" }),
  setAccountConnectionStatus: async () => ({}),
}));
vi.mock("@/repositories/platform-connection-repository", () => ({
  PlatformConnectionAttachedToAnotherIdentityError: class extends Error {},
  upsertPlatformConnection: async () => ({ id: "conn-1" }),
}));
vi.mock("@/repositories/activity-repository", () => ({
  recordActivity: async () => undefined,
}));
vi.mock("@/lib/supabase/service-role", () => ({
  createSupabaseServiceRoleClient: () => (serviceClientAvailable ? { __service: true } : null),
}));
vi.mock("@/repositories/bluesky-campaign-repository", () => ({
  recoverReauthorizedCampaignsForConnectedIdentities: async (input: unknown) => {
    calls.recover.push(input);
    return recoverImpl();
  },
}));
vi.mock("@/core/identity-verifiers", () => ({
  connectBlueskyWithAppPassword: async () => ({
    outcome: "connected",
    providerAccountId: "did:plc:op",
    authenticatedHandle: "op.bsky.social",
    accessJwt: "never-echoed-access",
    refreshJwt: "never-echoed-refresh",
  }),
  buildBlueskySessionPlan: () => ({
    upsert: {
      workspaceId: "ws-1", accountId: "acct-1", platform: "bluesky", providerAccountId: "did:plc:op",
      handle: "op.bsky.social", displayName: "op.bsky.social", scopes: [],
      accessTokenEncrypted: "enc-a", refreshTokenEncrypted: "enc-r", expiresAt: null,
      connectionStatus: "connected", metadata: { last_message: "Connected as op.bsky.social." },
    },
    promoteGrowthAccount: true,
    response: {
      status: 200,
      body: { ok: true, platform: "bluesky", identity_id: "acct-1", authenticated_handle: "op.bsky.social", provider_account_id: "did:plc:op" },
    },
  }),
}));

import { POST } from "./route";

const request = () =>
  new Request("https://signal.test/api/identity/acct-1/bluesky/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "op.bsky.social", app_password: "xxxx-xxxx-xxxx-xxxx" }),
  });

beforeEach(() => {
  calls.recover.length = 0;
  recoverImpl = async () => [];
  serviceClientAvailable = true;
});

describe("the connect route and campaign recovery", () => {
  it("calls recovery for this identity after the connection is persisted and reports what it recovered", async () => {
    recoverImpl = async () => [
      { campaignId: "c1", kind: "follow", runId: "r1", runResumed: true, previousStatus: "active", nextRunAt: "2026-09-15T16:00:00.000Z", identityId: "acct-1", tokenGeneration: 2 },
      { campaignId: "c2", kind: "unfollow", runId: null, runResumed: false, previousStatus: "reauthorization_required", nextRunAt: "2026-09-15T16:00:00.000Z", identityId: "acct-1", tokenGeneration: 2 },
    ];
    const res = await POST(request(), { params: { identityId: "acct-1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(calls.recover).toHaveLength(1);
    expect(calls.recover[0]).toMatchObject({ workspaceId: "ws-1", accountId: "acct-1", db: { __service: true } });
    expect(body.recovered_campaigns).toBe(2);
    expect(body.resumed_runs).toBe(1);
    expect(body.recovery_pending).toBe(false);
    // Never a credential in the response.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/never-echoed|enc-a|enc-r|xxxx-xxxx/);
  });

  it("when recovery throws, the reconnect still succeeds and the response says recovery_pending: true", async () => {
    recoverImpl = async () => { throw new Error("connection reset"); };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await POST(request(), { params: { identityId: "acct-1" } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(body.recovery_pending).toBe(true);
      expect(body.recovered_campaigns).toBe(0);
      expect(body.resumed_runs).toBe(0);
      expect(String(body.recovery_message)).toMatch(/next scheduler delivery/);
    } finally {
      error.mockRestore();
    }
  });

  it("without a service client the reconnect still succeeds and recovery is reported pending", async () => {
    serviceClientAvailable = false;
    const res = await POST(request(), { params: { identityId: "acct-1" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.recovery_pending).toBe(true);
    expect(calls.recover).toHaveLength(0);
  });

  it("recovered_campaigns: 0 with recovery_pending: false means the sweep ran and found nothing — not that it was skipped", async () => {
    recoverImpl = async () => [];
    const res = await POST(request(), { params: { identityId: "acct-1" } });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.recovery_pending).toBe(false);
    expect(body.recovered_campaigns).toBe(0);
    expect(calls.recover).toHaveLength(1);
  });
});
