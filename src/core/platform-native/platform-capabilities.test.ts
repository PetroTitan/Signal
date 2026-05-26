import { describe, expect, it } from "vitest";
import {
  validateShapeAgainstCapabilities,
  type PlatformCapabilities,
} from "./platform-capabilities";
import {
  legacyPlatformNativeShape,
  type PlatformNativeShape,
} from "./publishing-intent";

function blueskyLikeCaps(): PlatformCapabilities {
  return {
    platform: "bluesky",
    supportedIntents: new Set(["new_post", "thread", "unknown"]),
    supportedThreadModes: new Set([
      "single_only",
      "auto_thread_allowed",
      "platform_default",
    ]),
    supportedMediaModes: new Set(["none", "first_part_only", "platform_default"]),
    requiresMedia: false,
    requiresTarget: false,
    requiresTitle: false,
    budgets: { perPartUnit: "graphemes", perPartBudget: 300 },
    reply: { supported: false, targetKind: "uri+cid" },
    quote: { supported: false, targetKind: "uri+cid" },
    stub: false,
  };
}

function stubLikeCaps(): PlatformCapabilities {
  return {
    platform: "x",
    supportedIntents: new Set(["unknown"]),
    supportedThreadModes: new Set(["platform_default"]),
    supportedMediaModes: new Set(["platform_default"]),
    requiresMedia: false,
    requiresTarget: false,
    requiresTitle: false,
    budgets: { perPartUnit: "graphemes", perPartBudget: null },
    reply: { supported: false, targetKind: null },
    quote: { supported: false, targetKind: null },
    stub: true,
  };
}

function shape(over: Partial<PlatformNativeShape> = {}): PlatformNativeShape {
  return { ...legacyPlatformNativeShape("bluesky"), ...over };
}

describe("validateShapeAgainstCapabilities — platform mismatch is hard", () => {
  it("returns a single platform_mismatch blocker and skips further checks", () => {
    const caps = blueskyLikeCaps();
    const wrong = shape({ platform: "x" });
    const blockers = validateShapeAgainstCapabilities(caps, wrong);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].code).toBe("platform_mismatch");
  });
});

describe("validateShapeAgainstCapabilities — stub adapter only accepts unknown", () => {
  it("legacy/unknown shape passes through with no blockers", () => {
    const caps = stubLikeCaps();
    const legacy = legacyPlatformNativeShape("x");
    expect(validateShapeAgainstCapabilities(caps, legacy)).toEqual([]);
  });

  it("any non-unknown intent returns adapter_not_implemented", () => {
    const caps = stubLikeCaps();
    const realIntent = shape({
      platform: "x",
      intent: "new_post",
    });
    const blockers = validateShapeAgainstCapabilities(caps, realIntent);
    expect(blockers.map((b) => b.code)).toContain("adapter_not_implemented");
  });
});

describe("validateShapeAgainstCapabilities — real adapter checks", () => {
  it("unsupported intent → intent_not_supported", () => {
    const caps = blueskyLikeCaps();
    const replyShape = shape({ intent: "reply" });
    const blockers = validateShapeAgainstCapabilities(caps, replyShape);
    expect(blockers.map((b) => b.code)).toContain("intent_not_supported");
  });

  it("unsupported threadMode → thread_mode_not_supported", () => {
    const caps = blueskyLikeCaps();
    const s = shape({
      intent: "new_post",
      threadMode: "manual_thread",
      mediaMode: "none",
    });
    const blockers = validateShapeAgainstCapabilities(caps, s);
    expect(blockers.map((b) => b.code)).toContain("thread_mode_not_supported");
  });

  it("unsupported mediaMode → media_mode_not_supported", () => {
    const caps = blueskyLikeCaps();
    const s = shape({
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "every_part",
    });
    const blockers = validateShapeAgainstCapabilities(caps, s);
    expect(blockers.map((b) => b.code)).toContain("media_mode_not_supported");
  });

  it("requiresMedia=true blocks mediaMode=none", () => {
    const caps: PlatformCapabilities = {
      ...blueskyLikeCaps(),
      platform: "instagram",
      requiresMedia: true,
      supportedIntents: new Set(["media_post"]),
      supportedMediaModes: new Set(["first_part_only", "media_required"]),
    };
    const s = shape({
      platform: "instagram",
      intent: "media_post",
      mediaMode: "none",
    });
    const blockers = validateShapeAgainstCapabilities(caps, s);
    // Two blockers: media_mode_not_supported (none not in set) AND media_required.
    expect(blockers.map((b) => b.code)).toContain("media_required");
  });

  it("reply target with reply.supported=false → reply_not_supported", () => {
    const caps = blueskyLikeCaps();
    const s = shape({
      intent: "new_post",
      threadMode: "single_only",
      mediaMode: "none",
      replyTarget: { externalId: "at://x", url: null },
    });
    const blockers = validateShapeAgainstCapabilities(caps, s);
    expect(blockers.map((b) => b.code)).toContain("reply_not_supported");
  });

  it("intent=reply but no replyTarget → reply_target_missing (only when reply IS supported)", () => {
    const caps: PlatformCapabilities = {
      ...blueskyLikeCaps(),
      supportedIntents: new Set(["new_post", "thread", "reply", "unknown"]),
      reply: { supported: true, targetKind: "uri+cid" },
    };
    const s = shape({
      intent: "reply",
      threadMode: "single_only",
      mediaMode: "none",
      replyTarget: null,
    });
    const blockers = validateShapeAgainstCapabilities(caps, s);
    expect(blockers.map((b) => b.code)).toContain("reply_target_missing");
  });

  it("thread intent with expectedPartCount<2 → thread_part_count_invalid", () => {
    const caps = blueskyLikeCaps();
    const s = shape({
      intent: "thread",
      threadMode: "auto_thread_allowed",
      mediaMode: "none",
      expectedPartCount: 1,
    });
    const blockers = validateShapeAgainstCapabilities(caps, s);
    expect(blockers.map((b) => b.code)).toContain("thread_part_count_invalid");
  });

  it("legacy shape (intent=unknown) is accepted by a real adapter without blockers", () => {
    const caps = blueskyLikeCaps();
    const legacy = legacyPlatformNativeShape("bluesky");
    expect(validateShapeAgainstCapabilities(caps, legacy)).toEqual([]);
  });
});
