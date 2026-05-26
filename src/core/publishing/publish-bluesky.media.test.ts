import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishToBlueskyAsIdentity } from "./publish-bluesky";
import type { PublishRequest } from "./publishing-types";

/**
 * PR 1 regression guards. The Bluesky publisher must:
 *
 *   - upload the approved creative as a blob via uploadBlob
 *   - attach the resulting embed to the FIRST thread post only
 *   - NOT attach the embed to subsequent reply posts
 *   - return media_upload_failed (not text-only) when any step of
 *     the media path breaks — image fetch, blob upload, malformed
 *     response, or missing fields on the request creative payload
 *   - keep the success path text-only when no creative is attached
 */

const originalFetch = globalThis.fetch;

interface QueueEntry {
  url: string;
  resp: Response;
  /** Optional inspection captured at call time. */
  inspect?: (init: RequestInit | undefined) => void;
}

const queue: QueueEntry[] = [];
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    expect(next.url).toBe(url);
    next.inspect?.(init);
    calls.push({ url, init });
    return next.resp;
  }) as typeof fetch;
}

function enqueue(
  url: string,
  resp: Response,
  inspect?: QueueEntry["inspect"],
) {
  queue.push({ url, resp, inspect });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function imageResponse(): Response {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": "image/jpeg" },
  });
}

function baseRequest(
  over: Partial<PublishRequest> = {},
): PublishRequest {
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
    ...over,
  };
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

// ---------------------------------------------------------------------
// Creative attached + happy path
// ---------------------------------------------------------------------

describe("publishToBlueskyAsIdentity — uploads blob and embeds image on first post", () => {
  it("single-post creative publish: fetch image, upload blob, embed on the (only) post", async () => {
    enqueue("https://example.com/image.jpg", imageResponse());
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      jsonResponse(200, {
        blob: {
          $type: "blob",
          ref: { $link: "bafyblobcid" },
          mimeType: "image/jpeg",
          size: 6,
        },
      }),
    );
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
        cid: "bafycid",
      }),
      (init) => {
        // First (and only) post — embed must be present.
        const body = JSON.parse(String(init?.body));
        expect(body.record.embed).toBeDefined();
        expect(body.record.embed.$type).toBe("app.bsky.embed.images");
        expect(body.record.embed.images).toHaveLength(1);
        expect(body.record.embed.images[0].alt).toBe("A picture of a dog");
        expect(body.record.embed.images[0].image.ref.$link).toBe(
          "bafyblobcid",
        );
      },
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({ creative: withCreative() }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("published");
    expect(outcome.metadata.media_attached).toBe(true);
  });

  it("multi-post thread: embed on first post only, subsequent posts have no embed", async () => {
    const longBody = "A. ".repeat(250); // ~750 chars → splits into ~3 posts
    enqueue("https://example.com/image.jpg", imageResponse());
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      jsonResponse(200, {
        blob: {
          $type: "blob",
          ref: { $link: "bafyblobcid" },
          mimeType: "image/jpeg",
          size: 6,
        },
      }),
    );
    const recordBodies: Array<Record<string, unknown>> = [];
    function captureRecord(init: RequestInit | undefined) {
      recordBodies.push(JSON.parse(String(init?.body)).record);
    }
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/p1",
        cid: "cid1",
      }),
      captureRecord,
    );
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/p2",
        cid: "cid2",
      }),
      captureRecord,
    );
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/p3",
        cid: "cid3",
      }),
      captureRecord,
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({
        body: longBody,
        creative: withCreative(),
      }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("published");
    expect(recordBodies.length).toBeGreaterThanOrEqual(2);
    expect(recordBodies[0].embed).toBeDefined();
    for (let i = 1; i < recordBodies.length; i++) {
      expect(recordBodies[i].embed).toBeUndefined();
    }
  });

  it("creative=null → no upload call, text-only publish (existing behavior preserved)", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
        cid: "cid",
      }),
      (init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.record.embed).toBeUndefined();
      },
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({ creative: null }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("published");
    expect(outcome.metadata.media_attached).toBe(false);
    // Exactly one createRecord call — no image fetch, no uploadBlob.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("createRecord");
  });
});

// ---------------------------------------------------------------------
// media_upload_failed — every failure mode short-circuits
// ---------------------------------------------------------------------

describe("publishToBlueskyAsIdentity — media_upload_failed branches", () => {
  it("image fetch returns non-2xx → media_upload_failed, NO createRecord attempted", async () => {
    enqueue(
      "https://example.com/image.jpg",
      new Response("not found", { status: 404 }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({ creative: withCreative() }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.reasonCode).toBe("media_upload_failed");
    expect(outcome.reasonDetail).toMatch(/404/);
    expect(outcome.metadata.endpoint).toBe("uploadBlob");
    expect(outcome.metadata.creative_id).toBe("c-1");
    // No createRecord attempted — silent text-only downgrade
    // explicitly prevented.
    expect(calls.find((c) => c.url.includes("createRecord"))).toBeUndefined();
  });

  it("unsupported MIME → media_upload_failed", async () => {
    enqueue(
      "https://example.com/image.svg",
      new Response("<svg/>", {
        status: 200,
        headers: { "Content-Type": "image/svg+xml" },
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({
        creative: withCreative({
          assetUrl: "https://example.com/image.svg",
        }),
      }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.reasonCode).toBe("media_upload_failed");
    expect(outcome.reasonDetail).toMatch(/Unsupported image MIME/);
  });

  it("empty image body → media_upload_failed", async () => {
    enqueue(
      "https://example.com/image.jpg",
      new Response(new ArrayBuffer(0), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({ creative: withCreative() }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.reasonCode).toBe("media_upload_failed");
    expect(outcome.reasonDetail).toMatch(/empty/i);
  });

  it("uploadBlob returns 400 → media_upload_failed with atproto detail captured", async () => {
    enqueue("https://example.com/image.jpg", imageResponse());
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      jsonResponse(400, {
        error: "InvalidRequest",
        message: "Blob size exceeds maximum",
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({ creative: withCreative() }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.reasonCode).toBe("media_upload_failed");
    expect(outcome.reasonDetail).toMatch(/Blob size exceeds maximum/);
    expect(outcome.metadata.atproto_error).toBe("InvalidRequest");
    expect(outcome.metadata.http_status).toBe(400);
    expect(outcome.metadata.endpoint).toBe("uploadBlob");
  });

  it("uploadBlob response missing blob handle → media_upload_failed", async () => {
    enqueue("https://example.com/image.jpg", imageResponse());
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      jsonResponse(200, { wrong: "shape" }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({ creative: withCreative() }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.reasonCode).toBe("media_upload_failed");
    expect(outcome.reasonDetail).toMatch(/missing blob handle/);
  });

  it("creative with no URL on the request → blocked / creative_missing_asset (shared payload validation)", async () => {
    // PR 2 routes creative validation through the shared payload
    // layer, which produces the same reasonCode as the scheduler's
    // pre-flight check (PR 1). The publisher returns `blocked` (not
    // `failed`) — `blocked` is the canonical terminal for "operator
    // must act" — and no media upload is attempted.
    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({
        creative: withCreative({ assetUrl: null, sourceUrl: null }),
      }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("creative_missing_asset");
    expect(outcome.reasonDetail).toMatch(/asset_url \/ source_url/i);
    expect(calls).toHaveLength(0);
  });

  it("creative with no alt text on the request → blocked / creative_missing_alt_text (shared payload validation)", async () => {
    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({
        creative: withCreative({ altText: "" }),
      }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("creative_missing_alt_text");
    expect(outcome.reasonDetail).toMatch(/alt text/i);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------
// No leakage
// ---------------------------------------------------------------------

describe("publishToBlueskyAsIdentity — no token leakage on media failure", () => {
  it("uploadBlob 401 does not leak the access JWT", async () => {
    enqueue("https://example.com/image.jpg", imageResponse());
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      jsonResponse(401, { error: "ExpiredToken", message: "Token has expired" }),
    );

    const accessJwt =
      "eyJtest." + "a".repeat(40) + "." + "b".repeat(40);
    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest({ creative: withCreative() }),
      accessJwt,
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    // After the uploadBlob ExpiredToken routing fix: identity-scoped
    // uploadBlob failures with an ExpiredToken body now flow through
    // the same mapper as createRecord, so the reasonCode is the
    // recoverable session_expired — orchestrator refresh-and-retry
    // gate becomes reachable.
    expect(outcome.reasonCode).toBe("session_expired");
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(accessJwt);
    expect(serialized).not.toContain("Bearer eyJ");
  });
});

// ---------------------------------------------------------------------
// uploadBlob — AT Proto body errors route through the shared mapper
// ---------------------------------------------------------------------
//
// Regression guards for the deadlock-fix PR. Before this PR the
// uploadBlob wrapper hardcoded reasonCode = "media_upload_failed" for
// every upload failure, so the bluesky-publish-orchestrator never saw
// "session_expired" and never refreshed the token — a stale access
// JWT on uploadBlob got the post stuck in `paused` forever even
// though the encrypted refresh JWT in platform_connections would
// have cleared the failure on retry.
//
// These tests pin the mapper-routed outputs at the uploadBlob caller
// level so a future refactor cannot silently revert the wiring.

describe("publishToBlueskyAsIdentity — uploadBlob AT Proto error → reasonCode mapping", () => {
  function arrangeUploadFailure(status: number, body: unknown): void {
    enqueue("https://example.com/image.jpg", imageResponse());
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      jsonResponse(status, body),
    );
  }

  async function publishOnce() {
    return publishToBlueskyAsIdentity({
      request: baseRequest({ creative: withCreative() }),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });
  }

  it("HTTP 400 + ExpiredToken body → session_expired (deadlock fix)", async () => {
    arrangeUploadFailure(400, {
      error: "ExpiredToken",
      message: "Token has expired",
    });
    const outcome = await publishOnce();
    expect(outcome.status).toBe("failed");
    expect(outcome.reasonCode).toBe("session_expired");
    expect(outcome.metadata.endpoint).toBe("uploadBlob");
    expect(outcome.metadata.http_status).toBe(400);
    expect(outcome.metadata.atproto_error).toBe("ExpiredToken");
    expect(outcome.metadata.creative_id).toBe("c-1");
  });

  it("HTTP 400 + InvalidToken body → session_expired", async () => {
    arrangeUploadFailure(400, {
      error: "InvalidToken",
      message: "Token is invalid",
    });
    const outcome = await publishOnce();
    expect(outcome.reasonCode).toBe("session_expired");
    expect(outcome.metadata.atproto_error).toBe("InvalidToken");
  });

  it("HTTP 400 + AccountTakedown body → platform_unauthorized", async () => {
    arrangeUploadFailure(400, {
      error: "AccountTakedown",
      message: "Account has been taken down",
    });
    const outcome = await publishOnce();
    expect(outcome.reasonCode).toBe("platform_unauthorized");
    expect(outcome.metadata.atproto_error).toBe("AccountTakedown");
  });

  it("HTTP 400 + AuthFactorTokenRequired body → platform_unauthorized", async () => {
    arrangeUploadFailure(400, {
      error: "AuthFactorTokenRequired",
      message: "Second factor required",
    });
    const outcome = await publishOnce();
    expect(outcome.reasonCode).toBe("platform_unauthorized");
    expect(outcome.metadata.atproto_error).toBe("AuthFactorTokenRequired");
  });

  it("HTTP 400 + generic InvalidRequest body → media_upload_failed (safe fallback preserved)", async () => {
    arrangeUploadFailure(400, {
      error: "InvalidRequest",
      message: "Blob size exceeds maximum",
    });
    const outcome = await publishOnce();
    // Non-auth body errors keep the operator-facing media-specific
    // classification — the orchestrator refresh path stays inert for
    // genuine media failures.
    expect(outcome.reasonCode).toBe("media_upload_failed");
    expect(outcome.reasonDetail).toMatch(/Blob size exceeds maximum/);
  });
});
