import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishToX } from "./publish-x";
import type { PublishRequest } from "./publishing-types";

/**
 * X publisher (text-only branch) unit tests.
 *
 * Mocks `globalThis.fetch`. Pins:
 *   - POST /2/tweets request shape (URL, Bearer header, JSON body)
 *   - happy path returns the tweet id + canonical permalink
 *   - 401 → x_token_invalid (no retry)
 *   - 403 → x_token_invalid (insufficient scope)
 *   - 429 → x_rate_limited
 *   - 4xx → x_validation_error with X-supplied detail (when present)
 *   - 5xx → x_provider_unavailable
 *   - network / timeout → x_network_error
 *   - body > 280 → body_too_long (no fetch issued)
 *   - decode error / missing data.id → x_api_error
 *   - access token never appears in returned outcome
 */

const originalFetch = globalThis.fetch;

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResp(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "x",
    accountId: "acct-1",
    productId: null,
    title: null,
    body: "Hello X — short post.",
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

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// =====================================================================
// happy path
// =====================================================================

describe("publishToX — happy path", () => {
  it("POSTs to /2/tweets with Bearer auth, JSON body, and a single text field; returns the canonical permalink", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { id: "1234567890", text: "Hello X — short post." } }));
    globalThis.fetch = fetchMock;

    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk_user_context",
      username: "webmasterid_core",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twitter.com/2/tweets");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer atk_user_context",
    );
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("Hello X — short post.");
    expect("media" in body).toBe(false);

    expect(out.status).toBe("published");
    expect(out.externalId).toBe("1234567890");
    expect(out.externalUrl).toBe(
      "https://x.com/webmasterid_core/status/1234567890",
    );
    expect(out.metadata).toMatchObject({
      endpoint: "tweets",
      mode: "automated",
      media_mode: "text_only",
      media_url_present: false,
      x_media_id_present: false,
    });
  });

  it("falls back to https://x.com/i/status/<id> when username is null", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { id: "42", text: "x" } }));
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk_1",
      username: null,
    });
    expect(out.externalUrl).toBe("https://x.com/i/status/42");
  });

  it("strips a leading @ from username when building the permalink", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { id: "42", text: "x" } }));
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk_1",
      username: "@webmasterid_core",
    });
    expect(out.externalUrl).toBe(
      "https://x.com/webmasterid_core/status/42",
    );
  });

  it("attaches media when a mediaId is supplied (reserved for commit 5)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { id: "99", text: "with image" } }));
    globalThis.fetch = fetchMock;
    const out = await publishToX({
      request: baseRequest({ body: "with image" }),
      accessToken: "atk_1",
      username: "u",
      mediaId: "media_abc",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.media).toEqual({ media_ids: ["media_abc"] });
    expect(out.metadata).toMatchObject({
      mode: "automated_media",
      media_mode: "x_image",
      media_url_present: true,
      x_media_id_present: true,
      x_media_id: "media_abc",
    });
  });
});

// =====================================================================
// pre-network refusals
// =====================================================================

describe("publishToX — pre-network refusals", () => {
  it("missing access token → x_token_missing (no fetch)", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_token_missing");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("empty body → missing_body", async () => {
    const out = await publishToX({
      request: baseRequest({ body: "   " }),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("missing_body");
  });

  it("body > 280 chars → body_too_long (no fetch)", async () => {
    const longBody = "x".repeat(281);
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    const out = await publishToX({
      request: baseRequest({ body: longBody }),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("body_too_long");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// =====================================================================
// provider error mapping
// =====================================================================

describe("publishToX — provider error mapping", () => {
  it("401 → x_token_invalid (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResp(401, "unauthorized"));
    globalThis.fetch = fetchMock;
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_token_invalid");
    expect(out.metadata).toMatchObject({ http_status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("403 with detail → x_token_invalid surfacing X's description", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResp(403, {
          title: "Forbidden",
          detail: "Your client app is not configured with the appropriate scope.",
        }),
      );
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_token_invalid");
    expect(out.reasonDetail).toContain("not configured with the appropriate scope");
  });

  it("429 → x_rate_limited", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(textResp(429, ""));
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_rate_limited");
  });

  it("400 with detail → x_validation_error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResp(400, {
        detail: "Text already published.",
        title: "Forbidden",
      }),
    );
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_validation_error");
    expect(out.reasonDetail).toContain("Text already published.");
  });

  it("503 → x_provider_unavailable", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(textResp(503, "server down"));
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_provider_unavailable");
  });

  it("network error → x_network_error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("ECONNRESET"));
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk_super_secret_token_DO_NOT_LEAK",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_network_error");
    // Access token must not appear in any returned field.
    expect(JSON.stringify(out)).not.toContain(
      "atk_super_secret_token_DO_NOT_LEAK",
    );
  });

  it("non-JSON response → x_api_error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("not json", { status: 201 }));
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_api_error");
  });

  it("missing data.id → x_api_error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { text: "no id" } }));
    const out = await publishToX({
      request: baseRequest(),
      accessToken: "atk",
      username: "u",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("x_api_error");
  });
});

// =====================================================================
// secret hygiene
// =====================================================================

describe("publishToX — secret hygiene", () => {
  it("access token does not appear in any returned outcome on success or failure", async () => {
    const TOKEN = "atk_user_context_TOP_SECRET_42";
    // happy path
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsonResp(201, { data: { id: "1", text: "ok" } }));
    const okOut = await publishToX({
      request: baseRequest(),
      accessToken: TOKEN,
      username: "u",
    });
    expect(JSON.stringify(okOut)).not.toContain(TOKEN);
    // failure path
    globalThis.fetch = vi.fn().mockResolvedValue(textResp(503, "down"));
    const failOut = await publishToX({
      request: baseRequest(),
      accessToken: TOKEN,
      username: "u",
    });
    expect(JSON.stringify(failOut)).not.toContain(TOKEN);
  });
});
