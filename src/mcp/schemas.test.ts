import { describe, expect, it } from "vitest";
import { FOUNDER_PLATFORMS } from "@/core/publishing/platform-guidance";
import {
  ACCOUNTS_PREPARE_PLATFORMS,
  VOICE_PROFILE_MAX_CHARS,
  parseAccountsPrepare,
} from "./schemas";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";

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
