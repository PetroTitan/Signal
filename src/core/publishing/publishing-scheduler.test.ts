import { describe, expect, it } from "vitest";
import {
  SCHEDULER_AUTONOMOUS_PLATFORMS,
  nextExecutionStatusForOutcome,
} from "./publishing-scheduler";
import type { PublishOutcome } from "./publishing-types";

function outcome(
  overrides: Partial<PublishOutcome> = {},
): PublishOutcome {
  return {
    status: "failed",
    reasonCode: "unknown_error",
    reasonDetail: null,
    externalId: null,
    externalUrl: null,
    metadata: {},
    ...overrides,
  } as PublishOutcome;
}

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

// =====================================================================
// nextExecutionStatusForOutcome — silent-skip regression guards.
// =====================================================================
//
// Pre-fix the scheduler treated EVERY `skipped` outcome as transient:
// execution_item.status stayed "scheduled" forever. That hid
// structural skips (`execution_mode_dry_run`, etc.) from operators —
// items appeared "Scheduled" indefinitely with no surface signal.
// These tests pin the discrimination: only `scheduled_in_future` is
// genuinely transient; every other skip must transition the row to
// "blocked" so the UI can show a real status.

describe("nextExecutionStatusForOutcome — terminal outcomes", () => {
  it("published → completed", () => {
    expect(
      nextExecutionStatusForOutcome(outcome({ status: "published" })),
    ).toBe("completed");
  });

  it("blocked → blocked", () => {
    expect(
      nextExecutionStatusForOutcome(
        outcome({ status: "blocked", reasonCode: "publishing_disabled" }),
      ),
    ).toBe("blocked");
  });

  it("failed → failed", () => {
    expect(
      nextExecutionStatusForOutcome(
        outcome({ status: "failed", reasonCode: "platform_api_error" }),
      ),
    ).toBe("failed");
  });

  it("not_implemented → failed (item exits scheduled)", () => {
    expect(
      nextExecutionStatusForOutcome(
        outcome({ status: "not_implemented" }),
      ),
    ).toBe("failed");
  });

  it("blocked + platform_not_supported → blocked (was previously a silent in-memory skip)", () => {
    // Regression guard: before this PR the unsupported-platform
    // branch was an in-memory result push that left status =
    // "scheduled" forever. It now goes through applyOutcome with a
    // "blocked" terminal outcome.
    expect(
      nextExecutionStatusForOutcome(
        outcome({ status: "blocked", reasonCode: "platform_not_supported" }),
      ),
    ).toBe("blocked");
  });
});

describe("nextExecutionStatusForOutcome — skip discrimination", () => {
  it("skip + scheduled_in_future → scheduled (transient, retry next tick)", () => {
    expect(
      nextExecutionStatusForOutcome(
        outcome({ status: "skipped", reasonCode: "scheduled_in_future" }),
      ),
    ).toBe("scheduled");
  });

  it("skip + execution_mode_dry_run → blocked (structural, won't clear on retry)", () => {
    expect(
      nextExecutionStatusForOutcome(
        outcome({
          status: "skipped",
          reasonCode: "execution_mode_dry_run",
        }),
      ),
    ).toBe("blocked");
  });

  it("skip + safe_test_mode_ready_for_publish → blocked", () => {
    expect(
      nextExecutionStatusForOutcome(
        outcome({
          status: "skipped",
          reasonCode: "safe_test_mode_ready_for_publish",
        }),
      ),
    ).toBe("blocked");
  });

  it("skip with any other reasonCode → blocked (defensive default)", () => {
    expect(
      nextExecutionStatusForOutcome(
        outcome({ status: "skipped", reasonCode: "cadence_cooldown" }),
      ),
    ).toBe("blocked");
  });
});

describe("nextExecutionStatusForOutcome — silent-scheduled-forever invariant", () => {
  it("no outcome combination leaves item silently scheduled when not transient", () => {
    // Iterate every reason code; only scheduled_in_future may
    // produce a "scheduled" next-status on a skip.
    const allCodes = [
      "ok",
      "no_active_contract",
      "account_not_confirmed",
      "product_not_confirmed",
      "oauth_not_connected",
      "oauth_token_not_stored",
      "execution_mode_dry_run",
      "publishing_disabled",
      "scheduled_in_future",
      "risk_level_blocked",
      "platform_not_supported",
      "platform_api_error",
      "platform_rate_limited",
      "platform_unauthorized",
      "missing_subreddit",
      "missing_body",
      "missing_title",
      "missing_api_key",
      "missing_publication_id",
      "missing_identifier",
      "duplicate_post",
      "body_too_long",
      "cadence_cooldown",
      "safe_test_mode_ready_for_publish",
      "unknown_error",
      "session_missing",
      "session_expired",
      "handle_mismatch",
      "missing_account",
      "platform_mismatch",
      "scheduler_exception",
    ] as const;
    for (const code of allCodes) {
      const next = nextExecutionStatusForOutcome(
        outcome({ status: "skipped", reasonCode: code }),
      );
      if (code === "scheduled_in_future") {
        expect(next).toBe("scheduled");
      } else {
        expect(next).not.toBe("scheduled");
      }
    }
  });

  it("scheduler_exception synthesized outcome → failed", () => {
    expect(
      nextExecutionStatusForOutcome(
        outcome({ status: "failed", reasonCode: "scheduler_exception" }),
      ),
    ).toBe("failed");
  });
});
