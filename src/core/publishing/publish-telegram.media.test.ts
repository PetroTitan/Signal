import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishToTelegram } from "./publish-telegram";
import {
  transformForTelegramCaption,
  TELEGRAM_CAPTION_LIMIT,
} from "./transformers/telegram";
import type { PublishCreative, PublishRequest } from "./publishing-types";

/**
 * Telegram media-publishing regression.
 *
 * Pre-fix the Telegram adapter was hardcoded `sendMessage` — even
 * approved uploaded creatives were silently dropped. This suite pins
 * the new `sendPhoto` branch:
 *
 *   - approved creative with asset URL → POST /sendPhoto
 *   - no creative → POST /sendMessage (existing behavior unchanged)
 *   - pending_review never reaches the adapter (scheduler filters
 *     via resolvePublishCreative's `approved`-only rule); this test
 *     simulates the post-filter shape by passing `request.creative=null`.
 *   - caption > 1024 chars → truncated with marker; `caption_truncated`
 *     surfaced in metadata
 *   - sendPhoto failure (400, 401, 429, network) → publishFail with
 *     reason; NO silent downgrade to sendMessage
 */

const originalFetch = globalThis.fetch;

function creative(
  over: Partial<PublishCreative> = {},
): PublishCreative {
  return {
    id: "creative-1",
    creativeType: "image",
    sourceType: "uploaded",
    assetUrl: "https://cdn.example.com/a.png",
    sourceUrl: null,
    altText: "alt",
    ...over,
  };
}

function baseRequest(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "telegram",
    accountId: "acct-1",
    productId: null,
    title: null,
    body: "Hello Telegram",
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

const SEND_PHOTO_OK = {
  ok: true,
  result: {
    message_id: 42,
    chat: { id: -1001, username: "webmasterid", type: "channel" },
  },
};

const SEND_MESSAGE_OK = {
  ok: true,
  result: {
    message_id: 7,
    chat: { id: -1001, username: "webmasterid", type: "channel" },
  },
};

beforeEach(() => {
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// =====================================================================
// Caption transformer — 1024-char limit
// =====================================================================

describe("transformForTelegramCaption", () => {
  it("returns body verbatim when ≤ 1024 chars", () => {
    const caption = transformForTelegramCaption({
      id: "pi-1",
      title: null,
      bodyMarkdown: "Short body",
      summary: null,
      tags: [],
      canonicalUrl: null,
      coverImageUrl: null,
      linkUrl: null,
      series: null,
    });
    expect(caption.text).toBe("Short body");
    expect(caption.truncated).toBe(false);
  });

  it("truncates at TELEGRAM_CAPTION_LIMIT and appends marker when body is longer", () => {
    const longBody = "x".repeat(2000);
    const caption = transformForTelegramCaption({
      id: "pi-1",
      title: null,
      bodyMarkdown: longBody,
      summary: null,
      tags: [],
      canonicalUrl: null,
      coverImageUrl: null,
      linkUrl: null,
      series: null,
    });
    expect(caption.truncated).toBe(true);
    expect(caption.text.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(caption.text).toMatch(/\(truncated\)$/);
    expect(caption.warnings.some((w) => w.includes("1024"))).toBe(true);
  });

  it("appends canonical URL only when it fits within the caption limit", () => {
    const caption = transformForTelegramCaption({
      id: "pi-1",
      title: null,
      bodyMarkdown: "Hello",
      summary: null,
      tags: [],
      canonicalUrl: "https://example.com/post",
      coverImageUrl: null,
      linkUrl: null,
      series: null,
    });
    expect(caption.text).toContain("https://example.com/post");
  });

  it("drops the canonical URL when adding it would exceed 1024 chars", () => {
    const longBody = "x".repeat(TELEGRAM_CAPTION_LIMIT - 10);
    const caption = transformForTelegramCaption({
      id: "pi-1",
      title: null,
      bodyMarkdown: longBody,
      summary: null,
      tags: [],
      canonicalUrl: "https://example.com/some-really-long-url-that-wont-fit",
      coverImageUrl: null,
      linkUrl: null,
      series: null,
    });
    expect(caption.text).not.toContain("https://example.com/some-really-long-url-that-wont-fit");
    expect(caption.text.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
  });

  it("strips markdown the same way as the text transformer", () => {
    const caption = transformForTelegramCaption({
      id: "pi-1",
      title: null,
      bodyMarkdown: "**Bold** and *italic* and `code`",
      summary: null,
      tags: [],
      canonicalUrl: null,
      coverImageUrl: null,
      linkUrl: null,
      series: null,
    });
    expect(caption.text).toBe("Bold and italic and code");
  });
});

// =====================================================================
// publishToTelegram — sendPhoto branch
// =====================================================================

describe("publishToTelegram — sendPhoto branch (approved creative attached)", () => {
  it("posts to /sendPhoto with chat_id, photo, caption when creative has assetUrl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, SEND_PHOTO_OK));
    globalThis.fetch = fetchMock;

    const out = await publishToTelegram({
      request: baseRequest({
        body: "Caption body",
        creative: creative({ assetUrl: "https://cdn.example.com/a.png" }),
      }),
      botToken: "T",
      chatId: "@webmasterid",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botT/sendPhoto");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      chat_id: "@webmasterid",
      photo: "https://cdn.example.com/a.png",
      caption: expect.stringContaining("Caption body"),
      disable_notification: true,
    });

    expect(out.status).toBe("published");
    expect(out.externalId).toBe("42");
    expect(out.externalUrl).toBe("https://t.me/webmasterid/42");
    expect(out.metadata).toMatchObject({
      mode: "automated_photo",
      telegram_endpoint: "sendPhoto",
      media_mode: "telegram_photo",
      media_url_present: true,
      creative_id: "creative-1",
      caption_truncated: false,
    });
  });

  it("falls back to sourceUrl when assetUrl is null", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, SEND_PHOTO_OK));
    globalThis.fetch = fetchMock;

    await publishToTelegram({
      request: baseRequest({
        creative: creative({
          assetUrl: null,
          sourceUrl: "https://commons.wikimedia.org/foo.jpg",
        }),
      }),
      botToken: "T",
      chatId: "@webmasterid",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botT/sendPhoto");
    expect(JSON.parse(init.body as string).photo).toBe(
      "https://commons.wikimedia.org/foo.jpg",
    );
  });

  it("omits the caption field when the body strips to empty after markdown removal (e.g. only a code fence)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, SEND_PHOTO_OK));
    globalThis.fetch = fetchMock;

    await publishToTelegram({
      request: baseRequest({
        // A bare code fence is non-empty for the entry guard but the
        // caption transformer strips it to "".
        body: "```code-only-no-caption```",
        creative: creative(),
      }),
      botToken: "T",
      chatId: "@webmasterid",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect("caption" in body).toBe(false);
  });

  it("truncates long captions to ≤1024 chars and surfaces caption_truncated=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, SEND_PHOTO_OK));
    globalThis.fetch = fetchMock;

    const longBody = "y".repeat(3000);
    const out = await publishToTelegram({
      request: baseRequest({
        body: longBody,
        creative: creative(),
      }),
      botToken: "T",
      chatId: "@webmasterid",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect((sent.caption as string).length).toBeLessThanOrEqual(
      TELEGRAM_CAPTION_LIMIT,
    );
    expect(sent.caption).toMatch(/\(truncated\)$/);
    expect(out.metadata).toMatchObject({
      caption_truncated: true,
      media_mode: "telegram_photo",
    });
  });

  it("returns platform_api_error when /sendPhoto responds with ok=false (no silent downgrade)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(400, {
        ok: false,
        error_code: 400,
        description: "PHOTO_INVALID_DIMENSIONS",
      }),
    );
    globalThis.fetch = fetchMock;

    const out = await publishToTelegram({
      request: baseRequest({ creative: creative() }),
      botToken: "T",
      chatId: "@webmasterid",
    });

    // Single call only — no silent retry as sendMessage.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.telegram.org/botT/sendPhoto");

    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("platform_api_error");
    expect(out.reasonDetail).toContain("PHOTO_INVALID_DIMENSIONS");
    expect(out.metadata).toMatchObject({
      telegram_endpoint: "sendPhoto",
      media_mode: "telegram_photo",
      creative_id: "creative-1",
      telegram_error_code: 400,
    });
  });

  it("returns platform_unauthorized on 401 from /sendPhoto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(401, {}));
    globalThis.fetch = fetchMock;
    const out = await publishToTelegram({
      request: baseRequest({ creative: creative() }),
      botToken: "T",
      chatId: "@webmasterid",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("platform_unauthorized");
    expect(out.metadata).toMatchObject({
      telegram_endpoint: "sendPhoto",
      media_mode: "telegram_photo",
      creative_id: "creative-1",
      http_status: 401,
    });
  });

  it("returns platform_rate_limited on 429 from /sendPhoto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(429, {}));
    globalThis.fetch = fetchMock;
    const out = await publishToTelegram({
      request: baseRequest({ creative: creative() }),
      botToken: "T",
      chatId: "@webmasterid",
    });
    expect(out.status).toBe("failed");
    expect(out.reasonCode).toBe("platform_rate_limited");
    expect(out.metadata).toMatchObject({
      telegram_endpoint: "sendPhoto",
      media_mode: "telegram_photo",
      creative_id: "creative-1",
    });
  });
});

// =====================================================================
// publishToTelegram — sendMessage branch (no approved creative)
// =====================================================================

describe("publishToTelegram — sendMessage branch (no creative)", () => {
  it("falls through to /sendMessage when request.creative is null (existing behavior unchanged)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, SEND_MESSAGE_OK));
    globalThis.fetch = fetchMock;

    const out = await publishToTelegram({
      request: baseRequest({ creative: null }),
      botToken: "T",
      chatId: "@webmasterid",
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botT/sendMessage");
    const body = JSON.parse(init.body as string);
    expect("photo" in body).toBe(false);
    expect(body.text).toContain("Hello Telegram");

    expect(out.status).toBe("published");
    expect(out.metadata).toMatchObject({
      mode: "automated",
      telegram_endpoint: "sendMessage",
      media_mode: "text_only",
      media_url_present: false,
    });
  });

  it("falls through to /sendMessage when creative is present but has neither assetUrl nor sourceUrl", async () => {
    // Defensive: scheduler shouldn't produce this shape (resolver
    // requires at least one), but the adapter must not call sendPhoto
    // without a fetchable URL.
    const fetchMock = vi.fn().mockResolvedValue(jsonResp(200, SEND_MESSAGE_OK));
    globalThis.fetch = fetchMock;

    await publishToTelegram({
      request: baseRequest({
        creative: creative({ assetUrl: null, sourceUrl: null }),
      }),
      botToken: "T",
      chatId: "@webmasterid",
    });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.telegram.org/botT/sendMessage");
  });
});
