import { describe, expect, it } from "vitest";
import { SCHEDULER_AUTONOMOUS_PLATFORMS } from "./publishing-scheduler";

/**
 * Regression guards for the scheduler's platform allow-list.
 *
 * Bluesky `execution_items` were previously selected every tick but
 * dropped with `platform_not_supported` because Bluesky was missing
 * from this set. The runner itself
 * (`runPublish` → `publishBlueskyForIdentity`) was already correct;
 * the scheduler's outer routing was the gap. These tests pin the
 * set so a future cleanup doesn't reopen the same regression.
 */

describe("SCHEDULER_AUTONOMOUS_PLATFORMS", () => {
  it("includes bluesky (regression: pre-fix scheduler skipped Bluesky items)", () => {
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("bluesky")).toBe(true);
  });

  it("includes the OAuth platforms (reddit, x, linkedin)", () => {
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("reddit")).toBe(true);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("x")).toBe(true);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("linkedin")).toBe(true);
  });

  it("excludes manual-confirmation-only platforms (devto, hashnode, telegram, etc.)", () => {
    // These platforms are only published via /execution/items/[id]
    // manual confirmation; the scheduler should skip them.
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("devto")).toBe(false);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("hashnode")).toBe(false);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("telegram")).toBe(false);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("youtube")).toBe(false);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("threads")).toBe(false);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("instagram")).toBe(false);
  });

  it("is exactly the four-platform set today", () => {
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.size).toBe(4);
  });
});
