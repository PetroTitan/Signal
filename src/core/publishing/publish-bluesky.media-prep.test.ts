import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishToBlueskyAsIdentity } from "./publish-bluesky";
import type { PublishRequest } from "./publishing-types";

/**
 * Provider-media-prep regression guards for the Bluesky publisher.
 *
 * Reproduces the production failure ("blob too big. maximum 2000000,
 * got 2070497") and pins the new behaviour:
 *
 *   - an oversized image is BLOCKED before createRecord (and before
 *     uploadBlob), with reasonCode `media_too_large_for_platform`;
 *   - the provider API is never called on a blocked preparation;
 *   - a within-limit image still publishes using the original;
 *   - blocking never silently downgrades to a text-only post.
 */

const originalFetch = globalThis.fetch;

interface QueueEntry {
  url: string;
  resp: Response;
}
const queue: QueueEntry[] = [];
const calls: Array<{ url: string }> = [];

function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    expect(next.url).toBe(url);
    calls.push({ url });
    return next.resp;
  }) as typeof fetch;
}

function enqueue(url: string, resp: Response) {
  queue.push({ url, resp });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function imageResponse(byteLength: number): Response {
  const bytes = new Uint8Array(byteLength);
  // JPEG magic so guessImageMimeType is happy even without the header.
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/jpeg" },
  });
}

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "bluesky",
    accountId: "acct-1",
    productId: null,
    title: null,
    body: "Short post body that fits in a single Bluesky post.",
    linkUrl: null,
    target: null,
    mode: "live",
    creative: null,
    ...over,
  };
}

function withCreative(
  over: Partial<NonNullable<PublishRequest["creative"]>> = {},
): PublishRequest["creative"] {
  return {
    id: "c-1",
    creativeType: "image",
    sourceType: "uploaded",
    assetUrl: "https://example.com/image.jpg",
    sourceUrl: null,
    altText: "A picture of a dog",
    mimeType: "image/jpeg",
    sizeBytes: null,
    ...over,
  };
}

function publish(request: PublishRequest) {
  return publishToBlueskyAsIdentity({
    request,
    accessJwt: "test-jwt",
    did: "did:plc:test",
    handle: "handle.bsky.social",
    service: "https://bsky.social",
  });
}

beforeEach(() => {
  queue.length = 0;
  calls.length = 0;
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Bluesky provider-media-prep — oversized image", () => {
  it("in-flight guard: a 2,070,497-byte image is blocked before uploadBlob + createRecord", async () => {
    // The exact production payload size. Stored size unknown → the
    // metadata preflight passes; the in-flight byte guard catches it
    // after the fetch, before any uploadBlob/createRecord.
    enqueue("https://example.com/image.jpg", imageResponse(2_070_497));

    const outcome = await publish(
      baseRequest({ creative: withCreative({ sizeBytes: null }) }),
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("media_too_large_for_platform");
    expect(outcome.reasonDetail).toMatch(/limit/i);
    // The provider APIs were NEVER called.
    expect(calls.find((c) => c.url.includes("uploadBlob"))).toBeUndefined();
    expect(calls.find((c) => c.url.includes("createRecord"))).toBeUndefined();
  });

  it("metadata preflight: known oversized size blocks WITHOUT even fetching the image", async () => {
    // No fetch is enqueued — the preflight must short-circuit on the
    // stored size_bytes before touching the network at all.
    const outcome = await publish(
      baseRequest({ creative: withCreative({ sizeBytes: 2_070_497 }) }),
    );

    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("media_too_large_for_platform");
    expect(calls).toHaveLength(0); // not even the image fetch
    expect(outcome.metadata.media_preparation_status).toBe("blocked");
    expect(outcome.metadata.original_creative_id).toBe("c-1");
  });

  it("video creative is blocked with an explicit deferred reason", async () => {
    const outcome = await publish(
      baseRequest({
        creative: withCreative({
          creativeType: "video",
          mimeType: "video/mp4",
          sizeBytes: 4_000_000,
        }),
      }),
    );
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("media_video_unsupported");
    expect(calls).toHaveLength(0);
  });
});

describe("Bluesky provider-media-prep — within-limit image", () => {
  it("a small image publishes using the original (prep ready)", async () => {
    enqueue("https://example.com/image.jpg", imageResponse(900_000));
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      jsonResponse(200, {
        blob: {
          $type: "blob",
          ref: { $link: "bafyblobcid" },
          mimeType: "image/jpeg",
          size: 900_000,
        },
      }),
    );
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
        cid: "bafycid",
      }),
    );

    const outcome = await publish(
      baseRequest({ creative: withCreative({ sizeBytes: 900_000 }) }),
    );

    expect(outcome.status).toBe("published");
    expect(outcome.metadata.media_attached).toBe(true);
    expect(outcome.metadata.media_preparation_status).toBe("ready");
    expect(outcome.metadata.media_mode).toBe("bluesky_image");
  });
});
