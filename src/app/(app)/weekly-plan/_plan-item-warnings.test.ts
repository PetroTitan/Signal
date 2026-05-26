import { describe, expect, it } from "vitest";
import {
  computeContinueWritingMissingParts,
  computePlanItemWarnings,
  shouldFireCreativeGate,
} from "./_plan-item-warnings";

/**
 * Pure-helper regression tests.
 *
 * Pins the core rule: "Creative missing" warns only when the central
 * policy says creative is required (Instagram, YouTube + video_post,
 * media_post / carousel / story / short_video intents). Optional-
 * creative platforms (Telegram, Bluesky text, dev.to, Hashnode, etc.)
 * don't warn when no creative is attached — but DO warn when a
 * creative IS attached and is malformed.
 *
 * The "Missing schedule" warning stays coupled to content_type ===
 * "post" (independent of creative policy) and is unchanged.
 */

// =====================================================================
// shouldFireCreativeGate — the central rule
// =====================================================================

describe("shouldFireCreativeGate — required-creative cases", () => {
  it("Instagram + any intent + no creative → fires", () => {
    expect(
      shouldFireCreativeGate({
        platform: "instagram",
        intent: null,
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(true);
  });

  it("YouTube + video_post + no creative → fires", () => {
    expect(
      shouldFireCreativeGate({
        platform: "youtube",
        intent: "video_post",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(true);
  });

  it("intent=media_post on Bluesky + no creative → fires (intent overrides platform default)", () => {
    expect(
      shouldFireCreativeGate({
        platform: "bluesky",
        intent: "media_post",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(true);
  });

  it("intent=carousel on LinkedIn + no creative → fires", () => {
    expect(
      shouldFireCreativeGate({
        platform: "linkedin",
        intent: "carousel",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(true);
  });

  it("intent=story on Instagram + no creative → fires", () => {
    expect(
      shouldFireCreativeGate({
        platform: "instagram",
        intent: "story",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(true);
  });

  it("intent=short_video on any platform + no creative → fires", () => {
    expect(
      shouldFireCreativeGate({
        platform: "youtube",
        intent: "short_video",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(true);
  });

  it("Instagram + creative present + ready (no reason) → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "instagram",
        intent: "media_post",
        creativeAttached: true,
        creativeReason: null,
      }),
    ).toBe(false);
  });
});

describe("shouldFireCreativeGate — optional-creative platforms", () => {
  it("Telegram + new_post + no creative → does NOT fire (regression: 'Creative not ready: creative missing')", () => {
    expect(
      shouldFireCreativeGate({
        platform: "telegram",
        intent: "new_post",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });

  it("Telegram + null intent + no creative → does NOT fire (legacy item)", () => {
    expect(
      shouldFireCreativeGate({
        platform: "telegram",
        intent: null,
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });

  it("Bluesky + new_post + no creative → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "bluesky",
        intent: "new_post",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });

  it("Bluesky + thread + no creative → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "bluesky",
        intent: "thread",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });

  it("dev.to + article + no creative → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "devto",
        intent: "article",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });

  it("Hashnode + article + no creative → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "hashnode",
        intent: "article",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });

  it("Reddit + new_post + no creative → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "reddit",
        intent: "new_post",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });

  it("X + thread + no creative → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "x",
        intent: "thread",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });

  it("LinkedIn + new_post + no creative → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "linkedin",
        intent: "new_post",
        creativeAttached: false,
        creativeReason: "creative_missing",
      }),
    ).toBe(false);
  });
});

describe("shouldFireCreativeGate — malformed attached creative on optional platforms", () => {
  it("Telegram + creative attached + missing asset → STILL fires (malformed warning)", () => {
    expect(
      shouldFireCreativeGate({
        platform: "telegram",
        intent: "new_post",
        creativeAttached: true,
        creativeReason: "creative_missing_asset",
      }),
    ).toBe(true);
  });

  it("Bluesky + creative attached + missing alt text → STILL fires", () => {
    expect(
      shouldFireCreativeGate({
        platform: "bluesky",
        intent: "new_post",
        creativeAttached: true,
        creativeReason: "creative_missing_alt_text",
      }),
    ).toBe(true);
  });

  it("dev.to + creative attached + only planned (no asset) → STILL fires", () => {
    expect(
      shouldFireCreativeGate({
        platform: "devto",
        intent: "article",
        creativeAttached: true,
        creativeReason: "creative_only_planned",
      }),
    ).toBe(true);
  });

  it("Reddit + creative attached + rejected → STILL fires", () => {
    expect(
      shouldFireCreativeGate({
        platform: "reddit",
        intent: "new_post",
        creativeAttached: true,
        creativeReason: "creative_rejected",
      }),
    ).toBe(true);
  });

  it("Telegram + creative attached + ready (no reason) → does NOT fire", () => {
    expect(
      shouldFireCreativeGate({
        platform: "telegram",
        intent: "new_post",
        creativeAttached: true,
        creativeReason: null,
      }),
    ).toBe(false);
  });
});

// =====================================================================
// computePlanItemWarnings — display strings for the amber banner
// =====================================================================

describe("computePlanItemWarnings — Telegram regression", () => {
  it("Telegram post + no creative + scheduled → empty warnings (regression: pre-fix banner said 'Creative not ready: creative missing')", () => {
    const warnings = computePlanItemWarnings({
      contentType: "post",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "telegram",
      intent: "new_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toEqual([]);
  });

  it("Telegram post + no creative + unscheduled → only 'Missing schedule' (no creative warning)", () => {
    const warnings = computePlanItemWarnings({
      contentType: "post",
      scheduledAt: null,
      platform: "telegram",
      intent: "new_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Missing schedule");
  });

  it("Telegram post + malformed attached creative → fires 'Creative not ready: creative missing alt text.'", () => {
    const warnings = computePlanItemWarnings({
      contentType: "post",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "telegram",
      intent: "new_post",
      creativeAttached: true,
      creativeReason: "creative_missing_alt_text",
    });
    expect(warnings).toContain(
      "Creative not ready: creative missing alt text.",
    );
  });
});

describe("computePlanItemWarnings — required-creative platforms unchanged", () => {
  it("Instagram + no creative → fires 'Creative not ready: creative missing.'", () => {
    const warnings = computePlanItemWarnings({
      contentType: "post",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "instagram",
      intent: "media_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toContain("Creative not ready: creative missing.");
  });

  it("YouTube + video_post + no creative → fires", () => {
    const warnings = computePlanItemWarnings({
      contentType: "post",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "youtube",
      intent: "video_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toContain("Creative not ready: creative missing.");
  });

  it("intent=media_post on Bluesky → fires (intent precedence)", () => {
    const warnings = computePlanItemWarnings({
      contentType: "post",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "bluesky",
      intent: "media_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toContain("Creative not ready: creative missing.");
  });

  it("intent=carousel on LinkedIn → fires", () => {
    const warnings = computePlanItemWarnings({
      contentType: "post",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "linkedin",
      intent: "carousel",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toContain("Creative not ready: creative missing.");
  });
});

describe("computePlanItemWarnings — Bluesky text-only also fixed", () => {
  it("Bluesky text post + no creative → no creative warning (mirror Telegram fix)", () => {
    const warnings = computePlanItemWarnings({
      contentType: "post",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "bluesky",
      intent: "new_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toEqual([]);
  });
});

describe("computePlanItemWarnings — articles unchanged (not 'post')", () => {
  it("dev.to article + no creative → empty warnings (content_type != post; schedule/creative don't apply)", () => {
    const warnings = computePlanItemWarnings({
      contentType: "article",
      scheduledAt: null,
      platform: "devto",
      intent: "article",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toEqual([]);
  });

  it("Hashnode article + no creative → empty warnings", () => {
    const warnings = computePlanItemWarnings({
      contentType: "article",
      scheduledAt: null,
      platform: "hashnode",
      intent: "article",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(warnings).toEqual([]);
  });
});

// =====================================================================
// computeContinueWritingMissingParts — 'Continue writing drafts'
// =====================================================================

describe("computeContinueWritingMissingParts — Telegram regression", () => {
  it("Telegram draft, has title+body+schedule, no creative → empty missingParts", () => {
    const missing = computeContinueWritingMissingParts({
      contentType: "post",
      title: "Hi",
      body: "Body",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "telegram",
      intent: "new_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(missing).toEqual([]);
  });

  it("Telegram draft, missing body → 'body' only (no 'creative')", () => {
    const missing = computeContinueWritingMissingParts({
      contentType: "post",
      title: "Hi",
      body: null,
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "telegram",
      intent: "new_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(missing).toEqual(["body"]);
  });

  it("Telegram draft, missing everything → title/body/schedule but NOT creative", () => {
    const missing = computeContinueWritingMissingParts({
      contentType: "post",
      title: null,
      body: null,
      scheduledAt: null,
      platform: "telegram",
      intent: "new_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(missing).toEqual(["title", "body", "schedule"]);
  });
});

describe("computeContinueWritingMissingParts — required-creative still gates", () => {
  it("Instagram draft, has title+body+schedule, no creative → ['creative']", () => {
    const missing = computeContinueWritingMissingParts({
      contentType: "post",
      title: "Hi",
      body: "Body",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "instagram",
      intent: "media_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(missing).toEqual(["creative"]);
  });

  it("YouTube video_post, no creative → 'creative'", () => {
    const missing = computeContinueWritingMissingParts({
      contentType: "post",
      title: "Hi",
      body: "Body",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "youtube",
      intent: "video_post",
      creativeAttached: false,
      creativeReason: "creative_missing",
    });
    expect(missing).toContain("creative");
  });
});

describe("computeContinueWritingMissingParts — malformed attached creative", () => {
  it("Bluesky text draft + attached creative missing alt text → ['creative']", () => {
    const missing = computeContinueWritingMissingParts({
      contentType: "post",
      title: "Hi",
      body: "Body",
      scheduledAt: "2026-12-01T00:00:00Z",
      platform: "bluesky",
      intent: "new_post",
      creativeAttached: true,
      creativeReason: "creative_missing_alt_text",
    });
    expect(missing).toEqual(["creative"]);
  });
});
