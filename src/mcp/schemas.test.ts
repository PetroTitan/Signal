import { describe, expect, it } from "vitest";
import { FOUNDER_PLATFORMS } from "@/core/publishing/platform-guidance";
import {
  ACCOUNTS_PREPARE_PLATFORMS,
  MULTIWEEK_MAX_TOTAL_ITEMS,
  MULTIWEEK_MAX_WEEKS,
  SCHEDULE_MIN_LEAD_MS,
  VOICE_PROFILE_MAX_CHARS,
  WEEKLY_PLAN_MAX_ITEMS,
  parseAccountsPrepare,
  parseGenerateDraft,
  parseGenerateMultiweekPlan,
  parseGenerateWeeklyPlan,
  parseIdentitiesUpdate,
  parseSchedulePublish,
} from "./schemas";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";
const VALID_UUID_2 = "22222222-3333-4444-5555-666666666666";

describe("parseAccountsPrepare — platform allowlist", () => {
  it("matches the founder UI platform list exactly (no drift)", () => {
    expect([...ACCOUNTS_PREPARE_PLATFORMS].sort()).toEqual(
      [...FOUNDER_PLATFORMS].sort(),
    );
  });

  it.each(FOUNDER_PLATFORMS)("accepts %s as a valid platform", (platform) => {
    const result = parseAccountsPrepare({
      platform,
      display_name: "Test",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unsupported platform with platform_unsupported", () => {
    const result = parseAccountsPrepare({
      platform: "myspace",
      display_name: "Test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("platform_unsupported");
  });

  it("rejects 'google' — the legacy placeholder that never matched the UI", () => {
    const result = parseAccountsPrepare({
      platform: "google",
      display_name: "Test",
    });
    expect(result.ok).toBe(false);
  });
});

describe("parseAccountsPrepare — voice_profile", () => {
  it("accepts a voice_profile under the limit and trims it", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "WebmasterID — X",
      voice_profile: "   calm, technical, operational   ",
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.voice_profile).toBe("calm, technical, operational");
  });

  it("treats an empty voice_profile as null", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
      voice_profile: "   ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voice_profile).toBeNull();
  });

  it("rejects a voice_profile longer than the UI limit", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
      voice_profile: "x".repeat(VOICE_PROFILE_MAX_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("voice_profile_too_long");
  });

  it("rejects a non-string voice_profile", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
      voice_profile: 12 as unknown as string,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain("voice_profile_must_be_string");
  });
});

describe("parseAccountsPrepare — review_status hint", () => {
  it("accepts review_status='confirmed'", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
      review_status: "confirmed",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.review_status).toBe("confirmed");
  });

  it("accepts review_status='pending_review'", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
      review_status: "pending_review",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unsupported review_status", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
      review_status: "approved" as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain("review_status_unsupported");
  });

  it("defaults review_status to undefined (handler picks safe default)", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.review_status).toBeUndefined();
  });
});

describe("parseAccountsPrepare — other fields", () => {
  it("requires display_name", () => {
    const result = parseAccountsPrepare({ platform: "x", display_name: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("display_name_required");
  });

  it("accepts a UUID product_id", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
      product_id: VALID_UUID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.product_id).toBe(VALID_UUID);
  });

  it("rejects a non-UUID product_id", () => {
    const result = parseAccountsPrepare({
      platform: "x",
      display_name: "x",
      product_id: "not-a-uuid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("product_id_invalid");
  });
});

// =====================================================================
// parseGenerateDraft
// =====================================================================

describe("parseGenerateDraft", () => {
  it("accepts minimum required inputs", () => {
    const result = parseGenerateDraft({
      identity_id: VALID_UUID,
      topic: "Calm test topic.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.identity_id).toBe(VALID_UUID);
      expect(result.value.topic).toBe("Calm test topic.");
      expect(result.value.week_start).toBeNull();
    }
  });

  it("rejects missing identity_id or topic", () => {
    const noIdentity = parseGenerateDraft({ topic: "x" });
    expect(noIdentity.ok).toBe(false);
    const noTopic = parseGenerateDraft({ identity_id: VALID_UUID });
    expect(noTopic.ok).toBe(false);
  });

  it("rejects malformed week_start", () => {
    const result = parseGenerateDraft({
      identity_id: VALID_UUID,
      topic: "x",
      week_start: "not-a-date",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("week_start_invalid");
  });

  it("trims and clamps oversized fields", () => {
    const huge = "x".repeat(2000);
    const result = parseGenerateDraft({
      identity_id: VALID_UUID,
      topic: huge,
      goal: huge,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.topic.length).toBeLessThanOrEqual(500);
      expect((result.value.goal as string).length).toBeLessThanOrEqual(1000);
    }
  });
});

// =====================================================================
// parseGenerateWeeklyPlan
// =====================================================================

describe("parseGenerateWeeklyPlan", () => {
  it("accepts a valid plan within the item cap", () => {
    const result = parseGenerateWeeklyPlan({
      product_id: VALID_UUID,
      week_start: "2026-05-25",
      identity_ids: [VALID_UUID_2],
      topics: [{ topic: "a" }, { topic: "b" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.identity_ids.length).toBe(1);
      expect(result.value.topics.length).toBe(2);
      expect(result.value.include_media_briefs).toBe(true);
    }
  });

  it("rejects empty identity_ids and empty topics", () => {
    const noIds = parseGenerateWeeklyPlan({
      product_id: VALID_UUID,
      week_start: "2026-05-25",
      identity_ids: [],
      topics: [{ topic: "x" }],
    });
    expect(noIds.ok).toBe(false);
    if (!noIds.ok) expect(noIds.errors).toContain("identity_ids_empty");

    const noTopics = parseGenerateWeeklyPlan({
      product_id: VALID_UUID,
      week_start: "2026-05-25",
      identity_ids: [VALID_UUID_2],
      topics: [],
    });
    expect(noTopics.ok).toBe(false);
    if (!noTopics.ok) expect(noTopics.errors).toContain("topics_empty");
  });

  it(`enforces ${WEEKLY_PLAN_MAX_ITEMS}-item cap (identities × topics)`, () => {
    // 4 identities × 4 topics = 16 items > 12 cap
    const identityIds = Array.from(
      { length: 4 },
      (_, i) => `11111111-2222-3333-4444-${String(i).padStart(12, "0")}`,
    );
    const topics = Array.from({ length: 4 }, () => ({ topic: "x" }));
    const result = parseGenerateWeeklyPlan({
      product_id: VALID_UUID,
      week_start: "2026-05-25",
      identity_ids: identityIds,
      topics,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((e) => e.startsWith("cap_exceeded"))).toBe(true);
  });

  it("rejects invalid week_start ISO date", () => {
    const result = parseGenerateWeeklyPlan({
      product_id: VALID_UUID,
      week_start: "2026/05/25",
      identity_ids: [VALID_UUID_2],
      topics: [{ topic: "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("week_start_invalid");
  });
});

// =====================================================================
// parseGenerateMultiweekPlan
// =====================================================================

describe("parseGenerateMultiweekPlan", () => {
  it("accepts a valid multi-week plan", () => {
    const result = parseGenerateMultiweekPlan({
      product_id: VALID_UUID,
      start_date: "2026-05-25",
      number_of_weeks: 2,
      identity_ids: [VALID_UUID_2],
      topics_per_week: [{ topic: "a" }],
      strategic_theme: "Operational publishing",
      approval_mode: "operator_review_required",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.number_of_weeks).toBe(2);
      expect(result.value.approval_mode).toBe("operator_review_required");
    }
  });

  it("requires approval_mode = operator_review_required (refuses any other value)", () => {
    const result = parseGenerateMultiweekPlan({
      product_id: VALID_UUID,
      start_date: "2026-05-25",
      number_of_weeks: 1,
      identity_ids: [VALID_UUID_2],
      topics_per_week: [{ topic: "x" }],
      strategic_theme: "x",
      approval_mode: "auto",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain(
        "approval_mode_must_be_operator_review_required",
      );
  });

  it(`enforces ${MULTIWEEK_MAX_WEEKS}-week cap`, () => {
    const result = parseGenerateMultiweekPlan({
      product_id: VALID_UUID,
      start_date: "2026-05-25",
      number_of_weeks: MULTIWEEK_MAX_WEEKS + 1,
      identity_ids: [VALID_UUID_2],
      topics_per_week: [{ topic: "x" }],
      strategic_theme: "x",
      approval_mode: "operator_review_required",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors.some((e) => e.startsWith("cap_exceeded"))).toBe(true);
  });

  it(`enforces ${MULTIWEEK_MAX_TOTAL_ITEMS}-item cap across identities × topics × weeks`, () => {
    // 4 identities × 4 topics × 4 weeks = 64 items > 40 cap
    const identityIds = Array.from(
      { length: 4 },
      (_, i) => `33333333-4444-5555-6666-${String(i).padStart(12, "0")}`,
    );
    const topics = Array.from({ length: 4 }, () => ({ topic: "x" }));
    const result = parseGenerateMultiweekPlan({
      product_id: VALID_UUID,
      start_date: "2026-05-25",
      number_of_weeks: 4,
      identity_ids: identityIds,
      topics_per_week: topics,
      strategic_theme: "x",
      approval_mode: "operator_review_required",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(
        result.errors.some(
          (e) => e.includes("cap_exceeded") && e.includes("40_items"),
        ),
      ).toBe(true);
  });

  it("requires strategic_theme", () => {
    const result = parseGenerateMultiweekPlan({
      product_id: VALID_UUID,
      start_date: "2026-05-25",
      number_of_weeks: 1,
      identity_ids: [VALID_UUID_2],
      topics_per_week: [{ topic: "x" }],
      approval_mode: "operator_review_required",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("strategic_theme_required");
  });
});

// =====================================================================
// parseIdentitiesUpdate
// =====================================================================

describe("parseIdentitiesUpdate", () => {
  it("requires at least one updatable field", () => {
    const result = parseIdentitiesUpdate({ identity_id: VALID_UUID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("at_least_one_field_required");
  });

  it("accepts a single field patch and trims it", () => {
    const result = parseIdentitiesUpdate({
      identity_id: VALID_UUID,
      voice_profile: "  Calmer voice profile.  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.voice_profile).toBe("Calmer voice profile.");
  });

  it("rejects empty display_name", () => {
    const result = parseIdentitiesUpdate({
      identity_id: VALID_UUID,
      display_name: "   ",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain("display_name_must_be_non_empty_string");
  });

  it("rejects oversized voice_profile", () => {
    const result = parseIdentitiesUpdate({
      identity_id: VALID_UUID,
      voice_profile: "x".repeat(VOICE_PROFILE_MAX_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("voice_profile_too_long");
  });

  it("preserves null vs undefined distinction (null means 'clear')", () => {
    const cleared = parseIdentitiesUpdate({
      identity_id: VALID_UUID,
      voice_profile: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.voice_profile).toBeNull();
  });
});

// =====================================================================
// parseSchedulePublish
// =====================================================================

describe("parseSchedulePublish", () => {
  const future = () =>
    new Date(Date.now() + SCHEDULE_MIN_LEAD_MS + 60_000).toISOString();

  it("accepts a valid request", () => {
    const result = parseSchedulePublish({
      plan_item_id: VALID_UUID,
      scheduled_at: future(),
      confirm_schedule: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plan_item_id).toBe(VALID_UUID);
      expect(result.value.confirm_schedule).toBe(true);
      expect(typeof result.value.scheduled_at).toBe("string");
    }
  });

  it("rejects missing / invalid plan_item_id", () => {
    expect(
      parseSchedulePublish({ scheduled_at: future(), confirm_schedule: true })
        .ok,
    ).toBe(false);
    expect(
      parseSchedulePublish({
        plan_item_id: "not-a-uuid",
        scheduled_at: future(),
        confirm_schedule: true,
      }).ok,
    ).toBe(false);
  });

  it("rejects missing scheduled_at", () => {
    const result = parseSchedulePublish({
      plan_item_id: VALID_UUID,
      confirm_schedule: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("scheduled_at_required");
  });

  it("rejects malformed scheduled_at", () => {
    const result = parseSchedulePublish({
      plan_item_id: VALID_UUID,
      scheduled_at: "not-a-date",
      confirm_schedule: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("scheduled_at_invalid");
  });

  it("rejects scheduled_at in the past", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = parseSchedulePublish({
      plan_item_id: VALID_UUID,
      scheduled_at: past,
      confirm_schedule: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("scheduled_at_too_soon");
  });

  it("rejects scheduled_at less than the 2-minute lead time", () => {
    const tooSoon = new Date(Date.now() + 30_000).toISOString();
    const result = parseSchedulePublish({
      plan_item_id: VALID_UUID,
      scheduled_at: tooSoon,
      confirm_schedule: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("scheduled_at_too_soon");
  });

  it("rejects confirm_schedule = false", () => {
    const result = parseSchedulePublish({
      plan_item_id: VALID_UUID,
      scheduled_at: future(),
      confirm_schedule: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain("confirm_schedule_must_be_true");
  });

  it("rejects confirm_schedule missing entirely", () => {
    const result = parseSchedulePublish({
      plan_item_id: VALID_UUID,
      scheduled_at: future(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.errors).toContain("confirm_schedule_must_be_true");
  });
});
