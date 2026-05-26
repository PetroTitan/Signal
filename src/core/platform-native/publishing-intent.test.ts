import { describe, expect, it } from "vitest";
import {
  MEDIA_MODES,
  PUBLISHING_INTENTS,
  THREAD_MODES,
  isMediaMode,
  isPublishingIntent,
  isThreadMode,
  legacyPlatformNativeShape,
  parsePlatformNativeShape,
  serializePlatformNativeShape,
  type PlatformNativeShape,
} from "./publishing-intent";

describe("PublishingIntent enum", () => {
  it("contains the spec'd intent vocabulary", () => {
    expect(new Set(PUBLISHING_INTENTS)).toEqual(
      new Set([
        "new_post",
        "thread",
        "reply",
        "comment",
        "quote",
        "repost",
        "article",
        "media_post",
        "link_post",
        "video_post",
        "carousel",
        "story",
        "short_video",
        "unknown",
      ]),
    );
  });

  it("type guard accepts known intents", () => {
    for (const v of PUBLISHING_INTENTS) expect(isPublishingIntent(v)).toBe(true);
  });

  it("type guard rejects unknown / non-string", () => {
    expect(isPublishingIntent("__future__")).toBe(false);
    expect(isPublishingIntent("NEW_POST")).toBe(false); // case-sensitive
    expect(isPublishingIntent(null)).toBe(false);
    expect(isPublishingIntent(undefined)).toBe(false);
    expect(isPublishingIntent(123)).toBe(false);
  });
});

describe("ThreadMode + MediaMode enums", () => {
  it("ThreadMode contains the spec vocabulary", () => {
    expect(new Set(THREAD_MODES)).toEqual(
      new Set([
        "none",
        "single_only",
        "auto_thread_allowed",
        "manual_thread",
        "platform_default",
      ]),
    );
  });

  it("MediaMode contains the spec vocabulary", () => {
    expect(new Set(MEDIA_MODES)).toEqual(
      new Set([
        "none",
        "first_part_only",
        "every_part",
        "platform_default",
        "media_required",
      ]),
    );
  });

  it("type guards reject unknowns", () => {
    expect(isThreadMode("__future__")).toBe(false);
    expect(isMediaMode("__future__")).toBe(false);
  });
});

describe("legacyPlatformNativeShape — null intent for legacy rows", () => {
  it("returns intent='unknown' and platform_default everywhere", () => {
    const shape = legacyPlatformNativeShape("bluesky");
    expect(shape.version).toBe(1);
    expect(shape.platform).toBe("bluesky");
    expect(shape.intent).toBe("unknown");
    expect(shape.threadMode).toBe("platform_default");
    expect(shape.mediaMode).toBe("platform_default");
    expect(shape.expectedPartCount).toBeNull();
    expect(shape.replyTarget).toBeNull();
    expect(shape.quoteTarget).toBeNull();
    expect(shape.operatorApprovedShapeHash).toBeNull();
  });
});

describe("parsePlatformNativeShape — strict on fixed fields, future-safe on enums", () => {
  it("accepts a fully valid envelope", () => {
    const raw = {
      version: 1,
      platform: "bluesky",
      intent: "thread",
      threadMode: "auto_thread_allowed",
      mediaMode: "first_part_only",
      expectedPartCount: 3,
      replyTarget: null,
      quoteTarget: null,
      operatorApprovedShapeHash: "sha256:v1:abc",
    };
    const parsed = parsePlatformNativeShape(raw, "bluesky");
    expect(parsed).toEqual({
      version: 1,
      platform: "bluesky",
      intent: "thread",
      threadMode: "auto_thread_allowed",
      mediaMode: "first_part_only",
      expectedPartCount: 3,
      replyTarget: null,
      quoteTarget: null,
      operatorApprovedShapeHash: "sha256:v1:abc",
    });
  });

  it("rejects non-object / null raw input", () => {
    expect(parsePlatformNativeShape(null, "bluesky")).toBeNull();
    expect(parsePlatformNativeShape("string", "bluesky")).toBeNull();
    expect(parsePlatformNativeShape(42, "bluesky")).toBeNull();
  });

  it("rejects mismatched version", () => {
    const raw = { version: 999, platform: "bluesky" };
    expect(parsePlatformNativeShape(raw, "bluesky")).toBeNull();
  });

  it("rejects payload that targets a different platform", () => {
    const raw = {
      version: 1,
      platform: "x",
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
    };
    expect(parsePlatformNativeShape(raw, "bluesky")).toBeNull();
  });

  it("future-safe: unknown intent → 'unknown'", () => {
    const raw = {
      version: 1,
      platform: "bluesky",
      intent: "__future_intent__",
      threadMode: "single_only",
      mediaMode: "none",
    };
    const parsed = parsePlatformNativeShape(raw, "bluesky");
    expect(parsed?.intent).toBe("unknown");
  });

  it("future-safe: unknown threadMode / mediaMode → 'platform_default'", () => {
    const raw = {
      version: 1,
      platform: "bluesky",
      intent: "new_post",
      threadMode: "__future__",
      mediaMode: "__future__",
    };
    const parsed = parsePlatformNativeShape(raw, "bluesky");
    expect(parsed?.threadMode).toBe("platform_default");
    expect(parsed?.mediaMode).toBe("platform_default");
  });

  it("expectedPartCount must be positive integer or null", () => {
    const raw = {
      version: 1,
      platform: "bluesky",
      intent: "thread",
      threadMode: "auto_thread_allowed",
      mediaMode: "none",
      expectedPartCount: 0,
    };
    expect(parsePlatformNativeShape(raw, "bluesky")?.expectedPartCount).toBeNull();

    const raw2 = { ...raw, expectedPartCount: -1 };
    expect(parsePlatformNativeShape(raw2, "bluesky")?.expectedPartCount).toBeNull();

    const raw3 = { ...raw, expectedPartCount: 1.5 };
    expect(parsePlatformNativeShape(raw3, "bluesky")?.expectedPartCount).toBeNull();

    const raw4 = { ...raw, expectedPartCount: "3" };
    expect(parsePlatformNativeShape(raw4, "bluesky")?.expectedPartCount).toBeNull();
  });

  it("parses reply/quote targets when present", () => {
    const raw = {
      version: 1,
      platform: "bluesky",
      intent: "reply",
      threadMode: "single_only",
      mediaMode: "none",
      replyTarget: { externalId: "at://did:plc:x/app.bsky.feed.post/r", url: null },
      quoteTarget: { externalId: null, url: "https://bsky.app/profile/x/post/y" },
    };
    const parsed = parsePlatformNativeShape(raw, "bluesky");
    expect(parsed?.replyTarget).toEqual({
      externalId: "at://did:plc:x/app.bsky.feed.post/r",
      url: null,
    });
    expect(parsed?.quoteTarget).toEqual({
      externalId: null,
      url: "https://bsky.app/profile/x/post/y",
    });
  });

  it("drops empty-shell reply/quote targets to null", () => {
    const raw = {
      version: 1,
      platform: "bluesky",
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
      replyTarget: { externalId: "", url: "" },
      quoteTarget: { externalId: "", url: null },
    };
    const parsed = parsePlatformNativeShape(raw, "bluesky");
    expect(parsed?.replyTarget).toBeNull();
    expect(parsed?.quoteTarget).toBeNull();
  });
});

describe("serializePlatformNativeShape — stable key order", () => {
  it("emits keys in the documented stable order", () => {
    const shape: PlatformNativeShape = {
      version: 1,
      platform: "bluesky",
      intent: "thread",
      threadMode: "auto_thread_allowed",
      mediaMode: "first_part_only",
      expectedPartCount: 3,
      replyTarget: null,
      quoteTarget: null,
      operatorApprovedShapeHash: null,
    };
    const serialized = serializePlatformNativeShape(shape);
    expect(Object.keys(serialized)).toEqual([
      "version",
      "platform",
      "intent",
      "threadMode",
      "mediaMode",
      "expectedPartCount",
      "replyTarget",
      "quoteTarget",
      "operatorApprovedShapeHash",
    ]);
  });

  it("serialize → parse round-trips for a populated shape", () => {
    const original: PlatformNativeShape = {
      version: 1,
      platform: "bluesky",
      intent: "reply",
      threadMode: "single_only",
      mediaMode: "first_part_only",
      expectedPartCount: 1,
      replyTarget: {
        externalId: "at://did:plc:x/app.bsky.feed.post/abc",
        url: "https://bsky.app/profile/handle/post/abc",
      },
      quoteTarget: null,
      operatorApprovedShapeHash: "sha256:v1:deadbeef",
    };
    const round = parsePlatformNativeShape(
      serializePlatformNativeShape(original),
      "bluesky",
    );
    expect(round).toEqual(original);
  });
});
