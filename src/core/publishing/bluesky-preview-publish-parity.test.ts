import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderBlueskyPreview } from "@/core/platform-preview/bluesky-preview";
import { publishToBlueskyAsIdentity } from "./publish-bluesky";
import type { PublishRequest } from "./publishing-types";
import type { PreviewInput } from "@/core/platform-preview/preview-types";

/**
 * Preview ↔ Publish parity.
 *
 * These tests are the *purpose* of PR 2. For the same content input,
 * `renderBlueskyPreview` (operator-facing) and the Bluesky publisher
 * (provider-facing) must produce the same:
 *
 *   - thread part count
 *   - per-part text (markdown stripping + thread suffix)
 *   - media placement (always part 1, never elsewhere)
 *   - creative-block reason (when present)
 *   - text-only behavior when no creative is attached
 *
 * The shared module `bluesky-payload.ts` owns all five decisions.
 * These tests assert that both consumers actually use it by
 * exercising them end-to-end against the same input.
 */

const originalFetch = globalThis.fetch;
const queue: Array<{ url: string; resp: Response; inspect?: (init: RequestInit | undefined) => void }> = [];

function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    expect(next.url).toBe(url);
    next.inspect?.(init);
    return next.resp;
  }) as typeof fetch;
}

function enqueue(
  url: string,
  resp: Response,
  inspect?: (init: RequestInit | undefined) => void,
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

function previewInput(
  over: Partial<PreviewInput> = {},
): PreviewInput {
  return {
    platform: "bluesky",
    title: null,
    body: "",
    identity: {
      displayName: "Op",
      handle: "op.bsky.social",
      avatarUrl: null,
    },
    creative: null,
    ...over,
  };
}

function publishRequest(
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
    body: "",
    linkUrl: null,
    target: null,
    mode: "live",
    creative: null,
    ...over,
  };
}

beforeEach(() => {
  queue.length = 0;
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------
// Text parity
// ---------------------------------------------------------------------

describe("parity — text parts", () => {
  it("short text: preview and publish render the same single part", async () => {
    const body = "We shipped a queue retry fix today.";

    const preview = renderBlueskyPreview(previewInput({ body }));

    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
        cid: "cid",
      }),
      (init) => {
        const record = JSON.parse(String(init?.body)).record;
        expect(record.text).toBe(preview.parts[0].text);
      },
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: publishRequest({ body }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("published");
    expect(preview.parts).toHaveLength(1);
    // Both surfaces produced the same text — asserted in the inspect
    // callback above. Also assert from the published metadata:
    expect(outcome.metadata.thread_length).toBe(preview.parts.length);
  });

  it("long text: preview and publish produce the same parts (texts and count)", async () => {
    const body =
      "Lots of small queue fixes shipped this week. " +
      "The biggest improvement was switching to exponential backoff with jitter. " +
      "The previous fixed-delay strategy caused thundering-herd retries when a downstream went slow. " +
      "We measured a 40% drop in 99p latency during the next incident. " +
      "Next quarter: smarter dead-lettering and a circuit-breaker layer. " +
      "Threads should fan out to multiple posts when the message genuinely exceeds the budget.";

    const preview = renderBlueskyPreview(previewInput({ body }));

    const recordedTexts: string[] = [];
    for (let i = 0; i < preview.parts.length; i++) {
      enqueue(
        "https://bsky.social/xrpc/com.atproto.repo.createRecord",
        jsonResponse(200, {
          uri: `at://did:plc:test/app.bsky.feed.post/p${i + 1}`,
          cid: `cid${i + 1}`,
        }),
        (init) => {
          recordedTexts.push(JSON.parse(String(init?.body)).record.text);
        },
      );
    }

    const outcome = await publishToBlueskyAsIdentity({
      request: publishRequest({ body }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("published");
    expect(preview.parts.length).toBeGreaterThan(1);
    expect(recordedTexts).toHaveLength(preview.parts.length);
    // The exact published texts equal the previewed texts — full
    // parity including " (N/M)" suffix.
    expect(recordedTexts).toEqual(preview.parts.map((p) => p.text));
  });

  it("markdown stripping: preview and publish strip identically", async () => {
    const body = "# Heading\n\n**bold** and *italic* — _underline_.";

    const preview = renderBlueskyPreview(previewInput({ body }));

    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
        cid: "cid",
      }),
      (init) => {
        const record = JSON.parse(String(init?.body)).record;
        expect(record.text).toBe(preview.parts[0].text);
        expect(record.text).not.toMatch(/[#*]/);
      },
    );

    await publishToBlueskyAsIdentity({
      request: publishRequest({ body }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });
  });
});

// ---------------------------------------------------------------------
// Media parity
// ---------------------------------------------------------------------

describe("parity — media placement", () => {
  it("creative present: preview shows media on part 1, publish embeds on first record only", async () => {
    const body = "A. ".repeat(180); // multi-part thread
    const preview = renderBlueskyPreview(
      previewInput({
        body,
        creative: {
          assetUrl: "https://example.com/image.jpg",
          altText: "An image",
          sourceType: "uploaded",
        },
      }),
    );

    enqueue("https://example.com/image.jpg", imageResponse());
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
      jsonResponse(200, {
        blob: {
          $type: "blob",
          ref: { $link: "blobcid" },
          mimeType: "image/jpeg",
          size: 6,
        },
      }),
    );
    const embedFlags: boolean[] = [];
    for (let i = 0; i < preview.parts.length; i++) {
      enqueue(
        "https://bsky.social/xrpc/com.atproto.repo.createRecord",
        jsonResponse(200, {
          uri: `at://did:plc:test/app.bsky.feed.post/p${i + 1}`,
          cid: `cid${i + 1}`,
        }),
        (init) => {
          const record = JSON.parse(String(init?.body)).record;
          embedFlags.push(record.embed !== undefined);
        },
      );
    }

    const outcome = await publishToBlueskyAsIdentity({
      request: publishRequest({
        body,
        creative: {
          id: "c-1",
          creativeType: "image",
          sourceType: "uploaded",
          assetUrl: "https://example.com/image.jpg",
          sourceUrl: null,
          altText: "An image",
        },
      }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("published");
    expect(outcome.metadata.media_attached).toBe(true);
    // Preview says showsCreative on part 1, false elsewhere — and the
    // published records have embed only on the first.
    expect(preview.parts[0].showsCreative).toBe(true);
    expect(embedFlags[0]).toBe(true);
    for (let i = 1; i < preview.parts.length; i++) {
      expect(preview.parts[i].showsCreative).toBe(false);
      expect(embedFlags[i]).toBe(false);
    }
  });

  it("text-only path: preview shows no creative, publish sends no embed (byte-identical to pre-PR-1)", async () => {
    const body = "Just a text-only post.";
    const preview = renderBlueskyPreview(previewInput({ body }));

    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
        cid: "cid",
      }),
      (init) => {
        const record = JSON.parse(String(init?.body)).record;
        expect(record.embed).toBeUndefined();
      },
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: publishRequest({ body }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("published");
    expect(outcome.metadata.media_attached).toBe(false);
    expect(preview.parts[0].showsCreative).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Blocked-reason parity
// ---------------------------------------------------------------------

describe("parity — blocked reasons", () => {
  it("creative_missing_asset: preview warns, publish blocks with the same reason code", async () => {
    const body = "Hi.";
    const preview = renderBlueskyPreview(
      previewInput({
        body,
        creative: {
          assetUrl: null,
          altText: "alt is here",
          sourceType: "uploaded",
        },
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: publishRequest({
        body,
        creative: {
          id: "c-1",
          creativeType: "image",
          sourceType: "uploaded",
          assetUrl: null,
          sourceUrl: null,
          altText: "alt is here",
        },
      }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("creative_missing_asset");
    expect(
      preview.warnings.some((w) => w.kind === "creative_missing_asset"),
    ).toBe(true);
    // Preview still rendered the text part — the operator can see
    // what would publish once they fix the creative.
    expect(preview.parts).toHaveLength(1);
    expect(preview.parts[0].showsCreative).toBe(false);
  });

  it("creative_missing_alt_text: preview emits both alt_text_missing and creative_blocked warnings; publish blocks with the same reason code", async () => {
    const body = "Hi.";
    const preview = renderBlueskyPreview(
      previewInput({
        body,
        creative: {
          assetUrl: "https://example.com/x.jpg",
          altText: "",
          sourceType: "uploaded",
        },
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: publishRequest({
        body,
        creative: {
          id: "c-1",
          creativeType: "image",
          sourceType: "uploaded",
          assetUrl: "https://example.com/x.jpg",
          sourceUrl: null,
          altText: "",
        },
      }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("creative_missing_alt_text");
    expect(
      preview.warnings.some((w) => w.kind === "alt_text_missing"),
    ).toBe(true);
    expect(
      preview.warnings.some(
        (w) => w.kind === "creative_blocked_missing_alt_text",
      ),
    ).toBe(true);
    expect(preview.parts[0].showsCreative).toBe(false);
  });

  it("empty body: preview renders an empty placeholder, publish refuses with missing_body", async () => {
    const preview = renderBlueskyPreview(previewInput({ body: "" }));

    const outcome = await publishToBlueskyAsIdentity({
      request: publishRequest({ body: "" }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.reasonCode).toBe("missing_body");
    // Preview always renders SOMETHING for the UI to mount; the
    // operator's autosave still has the body field.
    expect(preview.parts).toHaveLength(1);
    expect(preview.parts[0].text).toBe("");
  });
});

// ---------------------------------------------------------------------
// No-regression: existing test bodies still split into the same shape
// ---------------------------------------------------------------------

describe("parity — title handling matches", () => {
  it("non-empty title triggers the same warning + transformation note", async () => {
    const preview = renderBlueskyPreview(
      previewInput({ title: "Some headline", body: "Hi." }),
    );

    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
        cid: "cid",
      }),
      (init) => {
        const record = JSON.parse(String(init?.body)).record;
        // Publisher never writes the title field on a Bluesky record.
        expect(record.text).toBe("Hi.");
      },
    );

    await publishToBlueskyAsIdentity({
      request: publishRequest({ title: "Some headline", body: "Hi." }),
      accessJwt: "jwt",
      did: "did:plc:test",
      handle: "op.bsky.social",
      service: "https://bsky.social",
    });

    expect(
      preview.warnings.some((w) => w.kind === "title_ignored_by_platform"),
    ).toBe(true);
    expect(preview.transformationNotes).toContain(
      "Title ignored — Bluesky has no post-title concept.",
    );
  });
});
