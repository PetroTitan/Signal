import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishRequest } from "./publishing-types";

vi.mock("@/repositories/account-repository", () => ({
  getAccountById: vi.fn(),
}));
vi.mock("@/repositories/platform-connection-repository", () => ({
  getConnectionForAccount: vi.fn(),
}));

import { publishXForIdentity } from "./x-publish-orchestrator";
import { getAccountById } from "@/repositories/account-repository";
import { getConnectionForAccount } from "@/repositories/platform-connection-repository";

const originalFetch = globalThis.fetch;

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "x",
    accountId: "acct-1",
    productId: null,
    title: null,
    body: "Hello X.",
    linkUrl: null,
    target: null,
    mode: "live",
    creative: null,
    summary: null,
    tags: [],
    canonicalUrl: null,
    coverImageUrl: null,
    series: null,
    ...over,
  };
}

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("publishXForIdentity — preconditions", () => {
  it("missing accountId → missing_account (no DB read, no fetch)", async () => {
    const out = await publishXForIdentity({
      request: baseRequest({ accountId: "" }),
      accessToken: "atk",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("missing_account");
    expect(getAccountById).not.toHaveBeenCalled();
  });

  it("null/empty access token → x_token_missing (no DB read, no fetch)", async () => {
    const out = await publishXForIdentity({
      request: baseRequest(),
      accessToken: null,
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_token_missing");
    expect(getAccountById).not.toHaveBeenCalled();
  });
});

describe("publishXForIdentity — identity gating", () => {
  it("identity row missing → missing_account", async () => {
    vi.mocked(getAccountById).mockRejectedValueOnce(new Error("not found"));
    const out = await publishXForIdentity({
      request: baseRequest(),
      accessToken: "atk",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("missing_account");
  });

  it("identity belongs to a different platform → platform_mismatch", async () => {
    vi.mocked(getAccountById).mockResolvedValueOnce({
      id: "acct-1",
      workspaceId: "ws-1",
      platform: "bluesky",
      handle: "wrong-platform",
    } as never);
    const out = await publishXForIdentity({
      request: baseRequest(),
      accessToken: "atk",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("platform_mismatch");
    expect(out.reasonDetail).toContain("bluesky");
  });
});

describe("publishXForIdentity — happy path", () => {
  it("loads connection.handle, calls publishToX, returns published outcome tagged x_publish_path=identity", async () => {
    vi.mocked(getAccountById).mockResolvedValueOnce({
      id: "acct-1",
      workspaceId: "ws-1",
      platform: "x",
      handle: "webmasterid_core",
    } as never);
    vi.mocked(getConnectionForAccount).mockResolvedValueOnce({
      id: "conn-1",
      handle: "webmasterid_core",
      providerAccountId: "1234567890",
    } as never);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { id: "42", text: "Hello X." } }));

    const out = await publishXForIdentity({
      request: baseRequest(),
      accessToken: "atk_user_context",
    });

    expect(out.status).toBe("published");
    expect(out.externalId).toBe("42");
    expect(out.externalUrl).toBe(
      "https://x.com/webmasterid_core/status/42",
    );
    expect(out.metadata).toMatchObject({
      endpoint: "tweets",
      x_publish_path: "identity",
      mode: "automated",
      media_mode: "text_only",
    });
  });

  it("falls back to id-only permalink when the connection has no handle", async () => {
    vi.mocked(getAccountById).mockResolvedValueOnce({
      id: "acct-1",
      workspaceId: "ws-1",
      platform: "x",
      handle: null,
    } as never);
    vi.mocked(getConnectionForAccount).mockResolvedValueOnce(null as never);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { id: "42", text: "ok" } }));
    const out = await publishXForIdentity({
      request: baseRequest(),
      accessToken: "atk",
    });
    expect(out.externalUrl).toBe("https://x.com/i/status/42");
  });
});

describe("publishXForIdentity — publisher failures are tagged", () => {
  it("tags x_publish_path on failure outcomes too (operator audit)", async () => {
    vi.mocked(getAccountById).mockResolvedValueOnce({
      id: "acct-1",
      workspaceId: "ws-1",
      platform: "x",
      handle: "u",
    } as never);
    vi.mocked(getConnectionForAccount).mockResolvedValueOnce({
      id: "conn-1",
      handle: "u",
    } as never);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const out = await publishXForIdentity({
      request: baseRequest(),
      accessToken: "atk",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_token_invalid");
    expect(out.metadata).toMatchObject({ x_publish_path: "identity" });
  });
});

describe("publishXForIdentity — secret hygiene", () => {
  it("access token never appears in any returned outcome", async () => {
    const TOKEN = "atk_top_secret_value_42";
    vi.mocked(getAccountById).mockResolvedValueOnce({
      id: "acct-1",
      workspaceId: "ws-1",
      platform: "x",
      handle: "u",
    } as never);
    vi.mocked(getConnectionForAccount).mockResolvedValueOnce({
      id: "conn-1",
      handle: "u",
    } as never);
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { id: "1", text: "ok" } }));
    const out = await publishXForIdentity({
      request: baseRequest(),
      accessToken: TOKEN,
    });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});
