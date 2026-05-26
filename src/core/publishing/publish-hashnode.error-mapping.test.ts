import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishToHashnode } from "./publish-hashnode";
import type { PublishRequest } from "./publishing-types";

/**
 * Phase F8 — Hashnode publisher error mapping.
 *
 * Pins each HTTP / GraphQL / network failure to a stable Hashnode-
 * prefixed reason code, and asserts no API key leakage in any
 * return path. Hashnode's free GraphQL endpoint was retired
 * 2026-05-13 — the redirect-to-announcement case maps to
 * `hashnode_provider_unavailable` so operators don't chase a
 * phantom credential problem.
 */

const originalFetch = globalThis.fetch;

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "hashnode",
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

const REAL_LOOKING_KEY = "HASHNODE_super_secret_key_value_xxxxx";
const PUB_ID = "pub_abc123";

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function htmlResp(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=UTF-8" },
  });
}

function redirectResp(status: number, location: string): Response {
  return new Response(null, {
    status,
    headers: { location },
  });
}

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("publishToHashnode — pre-network refusals", () => {
  it("missing api key → hashnode_token_missing (no fetch)", async () => {
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: "",
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_token_missing");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("missing publication id → hashnode_publication_missing (no fetch)", async () => {
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: "",
    });
    expect(out.reasonCode).toBe("hashnode_publication_missing");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("missing title → hashnode_title_required (no fetch)", async () => {
    const out = await publishToHashnode({
      request: baseRequest({ title: "" }),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_title_required");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("missing body → hashnode_body_required (no fetch)", async () => {
    const out = await publishToHashnode({
      request: baseRequest({ body: "" }),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_body_required");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("publishToHashnode — provider error mapping", () => {
  it.each([301, 302, 307, 308])(
    "HTTP %i (Hashnode retired-API redirect) → hashnode_provider_unavailable (NOT token_invalid)",
    async (status) => {
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        redirectResp(status, "https://hashnode.com/announcements/graphql-api"),
      );
      const out = await publishToHashnode({
        request: baseRequest(),
        apiKey: REAL_LOOKING_KEY,
        publicationId: PUB_ID,
      });
      expect(out.reasonCode).toBe("hashnode_provider_unavailable");
      // Must not lie about the credential — the token wasn't checked.
      expect(String(out.reasonDetail).toLowerCase()).not.toContain("invalid");
      expect(String(out.reasonDetail).toLowerCase()).not.toContain("rejected");
    },
  );

  it("200 with text/html body → hashnode_provider_unavailable", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      htmlResp(200, "<html>announcement</html>"),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_provider_unavailable");
  });

  it("HTTP 401 → hashnode_token_invalid", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(401, { error: "unauthorized" }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_token_invalid");
    expect(out.metadata.http_status).toBe(401);
  });

  it("HTTP 403 → hashnode_token_invalid", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(403, { error: "forbidden" }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_token_invalid");
  });

  it("HTTP 429 → hashnode_rate_limited", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(429, { error: "too many requests" }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_rate_limited");
  });

  it("HTTP 500 → hashnode_provider_unavailable", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(500, { error: "internal" }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_provider_unavailable");
  });

  it("HTTP 503 → hashnode_provider_unavailable", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(503, { error: "unavailable" }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_provider_unavailable");
  });

  it("HTTP 418 (odd non-2xx) → hashnode_api_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(418, { error: "teapot" }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_api_error");
  });

  it("network error → hashnode_network_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNRESET"),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_network_error");
  });

  it("malformed JSON success body → hashnode_api_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_api_error");
  });
});

describe("publishToHashnode — GraphQL error envelope", () => {
  it("UNAUTHENTICATED extension code (HTTP 200 + errors[]) → hashnode_token_invalid", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(200, {
        errors: [
          { message: "Not authenticated", extensions: { code: "UNAUTHENTICATED" } },
        ],
      }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_token_invalid");
  });

  it("FORBIDDEN extension code → hashnode_token_invalid", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(200, {
        errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }],
      }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_token_invalid");
  });

  it("auth-shaped message (defense-in-depth) → hashnode_token_invalid", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(200, {
        errors: [{ message: "Invalid auth token provided" }],
      }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_token_invalid");
  });

  it("other GraphQL errors → hashnode_validation_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(200, {
        errors: [
          {
            message: "tags exceed max",
            extensions: { code: "BAD_USER_INPUT" },
          },
        ],
      }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_validation_error");
  });

  it("response missing data.publishPost.post.id → hashnode_api_error", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(200, { data: { publishPost: { post: { url: "x" } } } }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_api_error");
  });
});

describe("publishToHashnode — success path", () => {
  it("HTTP 200 with publishPost.post → publishOk + safe metadata", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(200, {
        data: {
          publishPost: {
            post: {
              id: "hpost_12345",
              url: "https://webmasterid.hashnode.dev/an-article",
              slug: "an-article",
              publishedAt: "2026-06-15T10:00:00Z",
            },
          },
        },
      }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.status).toBe("published");
    expect(out.reasonCode).toBe("ok");
    expect(out.externalId).toBe("hpost_12345");
    expect(out.externalUrl).toBe("https://webmasterid.hashnode.dev/an-article");
    expect(out.metadata.slug).toBe("an-article");
    expect(out.metadata.intent).toBe("article");
    expect(out.metadata.endpoint).toBe("publishPost");
    expect(out.metadata.publication_id).toBe(PUB_ID);
  });
});

describe("publishToHashnode — no API key leakage", () => {
  it("token never appears in any error path's outcome", async () => {
    const variants: Array<{
      mock: () => Response;
      expectedCode: string;
    }> = [
      { mock: () => jsonResp(401, { error: "boom" }), expectedCode: "hashnode_token_invalid" },
      { mock: () => jsonResp(403, { error: "boom" }), expectedCode: "hashnode_token_invalid" },
      { mock: () => jsonResp(429, { error: "boom" }), expectedCode: "hashnode_rate_limited" },
      { mock: () => jsonResp(500, { error: "boom" }), expectedCode: "hashnode_provider_unavailable" },
      { mock: () => jsonResp(418, { error: "boom" }), expectedCode: "hashnode_api_error" },
      {
        mock: () => redirectResp(301, "https://hashnode.com/announcements/graphql-api"),
        expectedCode: "hashnode_provider_unavailable",
      },
      {
        mock: () => htmlResp(200, "<html>paywall</html>"),
        expectedCode: "hashnode_provider_unavailable",
      },
      {
        mock: () =>
          jsonResp(200, {
            errors: [
              { message: "Not authenticated", extensions: { code: "UNAUTHENTICATED" } },
            ],
          }),
        expectedCode: "hashnode_token_invalid",
      },
    ];
    for (const v of variants) {
      (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        v.mock(),
      );
      const out = await publishToHashnode({
        request: baseRequest(),
        apiKey: REAL_LOOKING_KEY,
        publicationId: PUB_ID,
      });
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain(REAL_LOOKING_KEY);
      // Authorization header is on the request, never the outcome.
      expect(serialized.toLowerCase()).not.toContain("authorization");
      expect(out.reasonCode).toBe(v.expectedCode);
    }
  });

  it("network error message never includes the key", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND gql.hashnode.com"),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(JSON.stringify(out)).not.toContain(REAL_LOOKING_KEY);
  });

  it("validation-error path never echoes the api key into reasonDetail", async () => {
    // Use a benign (non-auth-shaped) extensions code + message so the
    // publisher's auth heuristic doesn't fire — we want to test the
    // validation_error branch specifically and prove the key never
    // appears in the trimmed message.
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResp(200, {
        errors: [
          {
            message:
              "Internal trace: post body exceeded max length; trace-id=" +
              REAL_LOOKING_KEY,
            extensions: { code: "BAD_USER_INPUT" },
          },
        ],
      }),
    );
    const out = await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(out.reasonCode).toBe("hashnode_validation_error");
    // We DON'T strip the upstream message currently (only trim to
    // 280 chars), so the key COULD theoretically appear in the
    // detail if Hashnode echoed it back. This test is a tripwire:
    // if upstream ever echoes the api key into errors[].message
    // verbatim, the assertion fires.
    expect(String(out.reasonDetail)).not.toContain(REAL_LOOKING_KEY);
  });
});

describe("publishToHashnode — request shape", () => {
  it("sends api key as bare Authorization (no Bearer), never in the URL", async () => {
    let observedInit: RequestInit | undefined;
    let observedUrl = "";
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        observedUrl = typeof input === "string" ? input : input.toString();
        observedInit = init;
        return jsonResp(200, {
          data: {
            publishPost: {
              post: { id: "x", url: "https://example.com" },
            },
          },
        });
      },
    );
    await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(observedUrl).not.toContain(REAL_LOOKING_KEY);
    const headers = observedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(REAL_LOOKING_KEY);
    expect(headers.Authorization).not.toContain("Bearer");
  });

  it("passes redirect: 'manual' so the publisher observes 301 directly", async () => {
    let observedInit: RequestInit | undefined;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedInit = init;
        return redirectResp(
          301,
          "https://hashnode.com/announcements/graphql-api",
        );
      },
    );
    await publishToHashnode({
      request: baseRequest(),
      apiKey: REAL_LOOKING_KEY,
      publicationId: PUB_ID,
    });
    expect(observedInit?.redirect).toBe("manual");
  });
});
