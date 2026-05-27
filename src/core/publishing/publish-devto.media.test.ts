import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishToDevto } from "./publish-devto";
import { transformForDevto } from "./transformers/devto";
import type { PublishRequest } from "./publishing-types";

/**
 * dev.to cover-image regression.
 *
 * Pre-fix the scheduler never populated `request.coverImageUrl`, so
 * `canonicalPostFromRequest` always produced `coverImageUrl: null`
 * and the dev.to transformer omitted `article.main_image`. This
 * suite pins:
 *
 *   - coverImageUrl set on the request → article.main_image in body
 *   - coverImageUrl null/unset → article.main_image absent (text-only,
 *     existing behavior)
 *   - dev.to publish never blocks on missing creative (cover is
 *     optional at the platform contract)
 *   - the pending_review case is implicitly covered by the scheduler:
 *     `resolvePublishCreative` filters to status='approved' only, so a
 *     pending_review creative produces a null coverImageUrl on the
 *     request, which lands here as "no main_image". This test
 *     simulates that post-filter shape.
 */

const originalFetch = globalThis.fetch;

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ARTICLE_OK = {
  id: 12345,
  url: "https://dev.to/u/article-slug",
  canonical_url: "https://dev.to/u/article-slug",
  slug: "article-slug",
  published_at: "2026-05-27T14:25:07Z",
};

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

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// =====================================================================
// transformForDevto — cover image mapping
// =====================================================================

describe("transformForDevto — main_image mapping", () => {
  it("emits article.main_image when coverImageUrl is set", () => {
    const payload = transformForDevto(
      {
        id: "pi-1",
        title: "An article",
        bodyMarkdown: "Body",
        summary: null,
        tags: [],
        canonicalUrl: null,
        coverImageUrl: "https://cdn.example.com/cover.png",
        linkUrl: null,
        series: null,
      },
      { published: true },
    );
    expect(payload.article.main_image).toBe(
      "https://cdn.example.com/cover.png",
    );
  });

  it("omits article.main_image when coverImageUrl is null (text-only article)", () => {
    const payload = transformForDevto(
      {
        id: "pi-1",
        title: "An article",
        bodyMarkdown: "Body",
        summary: null,
        tags: [],
        canonicalUrl: null,
        coverImageUrl: null,
        linkUrl: null,
        series: null,
      },
      { published: true },
    );
    expect("main_image" in payload.article).toBe(false);
  });
});

// =====================================================================
// publishToDevto — body integration
// =====================================================================

describe("publishToDevto — cover image wire-through", () => {
  it("sends article.main_image to /api/articles when request.coverImageUrl is set (approved creative path)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(201, ARTICLE_OK));
    globalThis.fetch = fetchMock;

    await publishToDevto({
      request: baseRequest({
        coverImageUrl: "https://cdn.example.com/cover.png",
      }),
      apiKey: "DEVTO_KEY",
      published: true,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.to/api/articles");
    const body = JSON.parse(init.body as string);
    expect(body.article.main_image).toBe(
      "https://cdn.example.com/cover.png",
    );
  });

  it("omits article.main_image and publishes text-only when coverImageUrl is null (no approved creative)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(201, ARTICLE_OK));
    globalThis.fetch = fetchMock;

    const out = await publishToDevto({
      request: baseRequest({ coverImageUrl: null }),
      apiKey: "DEVTO_KEY",
      published: true,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect("main_image" in body.article).toBe(false);
    expect(out.status).toBe("published");
    expect(out.externalId).toBe("12345");
  });

  it("does NOT block when coverImageUrl is null — cover image is optional at the publisher contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(201, ARTICLE_OK));
    globalThis.fetch = fetchMock;
    const out = await publishToDevto({
      request: baseRequest({ coverImageUrl: null, creative: null }),
      apiKey: "DEVTO_KEY",
      published: true,
    });
    expect(out.status).toBe("published");
  });

  it("simulated pending_review case: scheduler's resolvePublishCreative filters to approved-only, so request.coverImageUrl arrives null → text-only article", async () => {
    // This is the production-state regression for plan_item 2839b219:
    // the uploaded creative was pending_review, never approved, so
    // the scheduler must NOT propagate it as a cover image. The
    // assertion here is on the adapter's input contract: when the
    // scheduler delivers coverImageUrl=null (the only valid post-
    // filter state), the article publishes without main_image.
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(201, ARTICLE_OK));
    globalThis.fetch = fetchMock;
    await publishToDevto({
      request: baseRequest({ coverImageUrl: null }),
      apiKey: "DEVTO_KEY",
      published: true,
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect("main_image" in body.article).toBe(false);
  });
});
