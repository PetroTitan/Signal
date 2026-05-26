import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishToDevto } from "./publish-devto";
import type { PublishRequest } from "./publishing-types";

/**
 * Phase F7.1 — dev.to publisher error mapping.
 *
 * Pins each HTTP / network failure to a stable dev.to-prefixed
 * reason code, and asserts no API key leakage in any return path.
 */

const originalFetch = globalThis.fetch;

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "devto",
    accountId: "acct-1",
    productId: null,
    title: "An article",
    body: "Markdown **body**.",
    linkUrl: null,
    target: null,
    mode: "live",
    creative: null,
    summary: null,
    tags: ["webdev"],
    canonicalUrl: null,
    coverImageUrl: null,
    series: null,
    ...over,
  };
}

const REAL_LOOKING_KEY = "ABCDEF1234567890_super_secret_key_value";

function mockResp(status: number, body: unknown): Response {
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

describe("publishToDevto — pre-network refusals", () => {
  it("missing api key → devto_token_missing (no fetch)", async () => {
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: "",
      published: true,
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("devto_token_missing");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("missing title → article_title_required (no fetch)", async () => {
    const out = await publishToDevto({
      request: baseRequest({ title: "" }),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("article_title_required");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("missing body → article_body_required (no fetch)", async () => {
    const out = await publishToDevto({
      request: baseRequest({ body: "" }),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("article_body_required");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("publishToDevto — provider error mapping", () => {
  it("HTTP 401 → devto_token_invalid", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(401, { error: "unauthorized" }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_token_invalid");
    expect(out.metadata.http_status).toBe(401);
  });

  it("HTTP 403 → devto_token_invalid", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(403, { error: "forbidden" }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_token_invalid");
  });

  it("HTTP 422 → devto_validation_error with safe Forem error string", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(422, { error: "tags must be alphanumeric" }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_validation_error");
    expect(out.reasonDetail).toMatch(/tags must be alphanumeric/);
  });

  it("HTTP 429 → devto_rate_limited", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(429, { error: "too many requests" }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_rate_limited");
  });

  it("HTTP 500 → devto_provider_unavailable", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(500, { error: "internal" }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_provider_unavailable");
  });

  it("HTTP 503 → devto_provider_unavailable", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(503, { error: "unavailable" }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_provider_unavailable");
  });

  it("HTTP 418 (odd non-2xx) → devto_api_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(418, { error: "teapot" }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_api_error");
  });

  it("network error → devto_network_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNRESET"),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_network_error");
  });

  it("malformed JSON success body → devto_api_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("not json", { status: 200 }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_api_error");
  });

  it("success body missing id → devto_api_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(200, { url: "https://dev.to/x/y", slug: "y" }),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.reasonCode).toBe("devto_api_error");
  });
});

describe("publishToDevto — success path", () => {
  it("HTTP 200 with article → publishOk + safe metadata", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockResp(200, {
        id: 12345,
        url: "https://dev.to/petro/an-article-abc",
        slug: "an-article-abc",
        canonical_url: "https://example.com/an-article",
        published_at: "2026-06-15T10:00:00Z",
      }),
    );
    const out = await publishToDevto({
      request: baseRequest({ canonicalUrl: "https://example.com/an-article" }),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(out.status).toBe("published");
    expect(out.reasonCode).toBe("ok");
    expect(out.externalId).toBe("12345");
    expect(out.externalUrl).toBe("https://dev.to/petro/an-article-abc");
    expect(out.metadata.slug).toBe("an-article-abc");
    expect(out.metadata.intent).toBe("article");
    expect(out.metadata.mode).toBe("published");
  });
});

describe("publishToDevto — no API key leakage", () => {
  it("token never appears in any error path's outcome", async () => {
    const variants: Array<{ status: number; expectedCode: string }> = [
      { status: 401, expectedCode: "devto_token_invalid" },
      { status: 403, expectedCode: "devto_token_invalid" },
      { status: 422, expectedCode: "devto_validation_error" },
      { status: 429, expectedCode: "devto_rate_limited" },
      { status: 500, expectedCode: "devto_provider_unavailable" },
      { status: 418, expectedCode: "devto_api_error" },
    ];
    for (const v of variants) {
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        mockResp(v.status, { error: "boom" }),
      );
      const out = await publishToDevto({
        request: baseRequest(),
        apiKey: REAL_LOOKING_KEY,
        published: true,
      });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain(REAL_LOOKING_KEY);
      // The api-key header is set on the request, never echoed in
      // the outcome.
      expect(serialized).not.toMatch(/api-key/i);
      expect(out.reasonCode).toBe(v.expectedCode);
    }
  });

  it("network error message never includes the key", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND dev.to"),
    );
    const out = await publishToDevto({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      published: true,
    });
    expect(JSON.stringify(out)).not.toContain(REAL_LOOKING_KEY);
  });
});
