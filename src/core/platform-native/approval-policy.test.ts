import { describe, expect, it } from "vitest";
import {
  getApprovalPolicy,
  isApprovablePublishObject,
  requiresCreative,
} from "./approval-policy";
import type { PublishingIntent } from "./publishing-intent";

/**
 * Phase F7.3 — approval-policy matrix pins.
 *
 * Default is "optional". Tests assert the small explicit YES set and
 * a representative OPTIONAL set so regressions in either direction
 * fail loudly.
 */

describe("requiresCreative — required (positive) cases", () => {
  it("Instagram + any intent → required", () => {
    const intents: ReadonlyArray<PublishingIntent> = [
      "media_post",
      "carousel",
      "story",
      "short_video",
      "new_post",
      "unknown",
    ];
    for (const intent of intents) {
      expect(requiresCreative({ platform: "instagram", intent })).toBe(true);
    }
  });

  it("YouTube + video_post → required", () => {
    expect(
      requiresCreative({ platform: "youtube", intent: "video_post" }),
    ).toBe(true);
  });

  it("intent=media_post → required regardless of platform", () => {
    for (const platform of ["bluesky", "x", "linkedin", "reddit", "threads"]) {
      expect(
        requiresCreative({ platform, intent: "media_post" }),
      ).toBe(true);
    }
  });

  it("intent=carousel → required on any platform", () => {
    expect(
      requiresCreative({ platform: "instagram", intent: "carousel" }),
    ).toBe(true);
    expect(
      requiresCreative({ platform: "linkedin", intent: "carousel" }),
    ).toBe(true);
  });

  it("intent=story → required on any platform", () => {
    expect(
      requiresCreative({ platform: "instagram", intent: "story" }),
    ).toBe(true);
  });

  it("intent=short_video → required on any platform", () => {
    expect(
      requiresCreative({ platform: "youtube", intent: "short_video" }),
    ).toBe(true);
    expect(
      requiresCreative({ platform: "instagram", intent: "short_video" }),
    ).toBe(true);
  });
});

describe("requiresCreative — optional (default) cases per spec matrix", () => {
  it("dev.to article → optional", () => {
    expect(requiresCreative({ platform: "devto", intent: "article" })).toBe(
      false,
    );
  });

  it("Hashnode article → optional", () => {
    expect(
      requiresCreative({ platform: "hashnode", intent: "article" }),
    ).toBe(false);
  });

  it("Reddit text post (new_post) → optional", () => {
    expect(
      requiresCreative({ platform: "reddit", intent: "new_post" }),
    ).toBe(false);
  });

  it("Reddit link_post → optional (link is not a creative)", () => {
    expect(
      requiresCreative({ platform: "reddit", intent: "link_post" }),
    ).toBe(false);
  });

  it("LinkedIn article → optional", () => {
    expect(
      requiresCreative({ platform: "linkedin", intent: "article" }),
    ).toBe(false);
  });

  it("LinkedIn new_post (feed post) → optional", () => {
    expect(
      requiresCreative({ platform: "linkedin", intent: "new_post" }),
    ).toBe(false);
  });

  it("X text post (new_post) → optional", () => {
    expect(requiresCreative({ platform: "x", intent: "new_post" })).toBe(
      false,
    );
  });

  it("X thread → optional", () => {
    expect(requiresCreative({ platform: "x", intent: "thread" })).toBe(false);
  });

  it("Bluesky text post (new_post) → optional", () => {
    expect(
      requiresCreative({ platform: "bluesky", intent: "new_post" }),
    ).toBe(false);
  });

  it("Bluesky thread → optional", () => {
    expect(
      requiresCreative({ platform: "bluesky", intent: "thread" }),
    ).toBe(false);
  });

  it("Telegram new_post → optional", () => {
    expect(
      requiresCreative({ platform: "telegram", intent: "new_post" }),
    ).toBe(false);
  });

  it("YouTube new_post (community) → optional", () => {
    expect(
      requiresCreative({ platform: "youtube", intent: "new_post" }),
    ).toBe(false);
  });
});

describe("requiresCreative — legacy / null cases", () => {
  it("null platform + null intent → optional (default)", () => {
    expect(requiresCreative({ platform: null, intent: null })).toBe(false);
  });

  it("null intent on Instagram still requires (platform mandate)", () => {
    expect(requiresCreative({ platform: "instagram", intent: null })).toBe(
      true,
    );
  });

  it("unknown intent on any non-IG/YT platform → optional", () => {
    expect(
      requiresCreative({ platform: "devto", intent: "unknown" }),
    ).toBe(false);
    expect(
      requiresCreative({ platform: "bluesky", intent: "unknown" }),
    ).toBe(false);
  });

  it("intent=null on YouTube → optional (only video_post mandates)", () => {
    expect(requiresCreative({ platform: "youtube", intent: null })).toBe(
      false,
    );
  });
});

describe("getApprovalPolicy — future-extensible wrapper", () => {
  it("wraps requiresCreative in a policy object", () => {
    expect(
      getApprovalPolicy({ platform: "instagram", intent: "media_post" }),
    ).toEqual({ creativeRequired: true });
    expect(
      getApprovalPolicy({ platform: "devto", intent: "article" }),
    ).toEqual({ creativeRequired: false });
  });
});

// =====================================================================
// Phase F7.4 — isApprovablePublishObject matrix pins
// =====================================================================

describe("isApprovablePublishObject — approvable content types", () => {
  const approvableContentTypes = [
    "post",
    "article",
    "thread",
    "media_post",
    "video_post",
    "carousel",
    "reply",
    "comment",
    "quote",
    "repost",
    "link_post",
    "community_post",
    "channel_message",
    "group_message",
    "story",
    "short_video",
  ] as const;

  for (const contentType of approvableContentTypes) {
    it(`content_type='${contentType}' → approvable`, () => {
      expect(
        isApprovablePublishObject({
          platform: "devto",
          contentType,
        }),
      ).toBe(true);
    });
  }

  it("case-insensitive: 'ARTICLE' → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "devto",
        contentType: "ARTICLE",
      }),
    ).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(
      isApprovablePublishObject({
        platform: "hashnode",
        contentType: "  article  ",
      }),
    ).toBe(true);
  });
});

describe("isApprovablePublishObject — non-approvable content types", () => {
  const refusedContentTypes = [
    "",
    "  ",
    "unknown",
    "debug",
    "malformed",
    "foo",
    "random_string",
  ];

  for (const contentType of refusedContentTypes) {
    it(`content_type='${contentType}' → NOT approvable`, () => {
      expect(
        isApprovablePublishObject({
          platform: "devto",
          contentType,
        }),
      ).toBe(false);
    });
  }

  it("null contentType + null intent → NOT approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "devto",
        contentType: null,
      }),
    ).toBe(false);
  });
});

describe("isApprovablePublishObject — intent fallback when contentType is empty", () => {
  it("empty contentType + intent='article' → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "devto",
        contentType: "",
        intent: "article",
      }),
    ).toBe(true);
  });

  it("null contentType + intent='thread' → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "bluesky",
        contentType: null,
        intent: "thread",
      }),
    ).toBe(true);
  });

  it("null contentType + intent='unknown' → NOT approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "bluesky",
        contentType: null,
        intent: "unknown",
      }),
    ).toBe(false);
  });
});

describe("isApprovablePublishObject — spec lifecycle pins", () => {
  it("dev.to article → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "devto",
        contentType: "article",
      }),
    ).toBe(true);
  });

  it("Hashnode article → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "hashnode",
        contentType: "article",
      }),
    ).toBe(true);
  });

  it("Reddit link_post → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "reddit",
        contentType: "link_post",
      }),
    ).toBe(true);
  });

  it("X thread → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "x",
        contentType: "thread",
      }),
    ).toBe(true);
  });

  it("LinkedIn article → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "linkedin",
        contentType: "article",
      }),
    ).toBe(true);
  });

  it("Telegram channel_message → approvable", () => {
    expect(
      isApprovablePublishObject({
        platform: "telegram",
        contentType: "channel_message",
      }),
    ).toBe(true);
  });

  it("Instagram media_post → approvable (creative gate handled elsewhere)", () => {
    expect(
      isApprovablePublishObject({
        platform: "instagram",
        contentType: "media_post",
      }),
    ).toBe(true);
  });

  it("YouTube video_post → approvable (creative gate handled elsewhere)", () => {
    expect(
      isApprovablePublishObject({
        platform: "youtube",
        contentType: "video_post",
      }),
    ).toBe(true);
  });

  it("legacy Bluesky text post → approvable (content_type='post' default)", () => {
    expect(
      isApprovablePublishObject({
        platform: "bluesky",
        contentType: "post",
      }),
    ).toBe(true);
  });
});
