import { describe, expect, it } from "vitest";
import {
  buildRetryMetadata,
  computeRetryBackoffMinutes,
  decidePublishRetry,
  isTransientPublishFailure,
} from "./publish-retry-policy";
import type { PublishOutcome } from "./publishing-types";

const NOW = new Date("2026-06-13T12:00:00.000Z");

function failed(
  reasonCode: string,
  metadata: Record<string, unknown> = {},
): Pick<PublishOutcome, "status" | "reasonCode" | "metadata"> {
  return { status: "failed", reasonCode: reasonCode as never, metadata };
}

describe("isTransientPublishFailure", () => {
  it("treats rate limits + network + provider-unavailable as always transient", () => {
    for (const code of [
      "platform_rate_limited",
      "x_rate_limited",
      "devto_rate_limited",
      "hashnode_rate_limited",
      "x_network_error",
      "devto_network_error",
      "hashnode_network_error",
      "x_provider_unavailable",
      "devto_provider_unavailable",
      "hashnode_provider_unavailable",
      "x_token_refresh_transient",
    ]) {
      expect(isTransientPublishFailure(code)).toBe(true);
    }
  });

  it("treats generic api_error as transient ONLY on 5xx or network (http 0)", () => {
    expect(isTransientPublishFailure("platform_api_error", { http_status: 503 })).toBe(true);
    expect(isTransientPublishFailure("x_api_error", { http_status: 500 })).toBe(true);
    expect(isTransientPublishFailure("x_api_error", { http_status: 0 })).toBe(true);
    expect(isTransientPublishFailure("x_api_error", { http_status: 400 })).toBe(false);
    expect(isTransientPublishFailure("x_api_error", {})).toBe(false); // unknown → not transient
  });

  it("treats media upload failures as transient ONLY on a clear 5xx (not http 0)", () => {
    expect(isTransientPublishFailure("media_upload_failed", { http_status: 502 })).toBe(true);
    // http 0 in the media path also means unsupported-MIME / empty body → NOT transient
    expect(isTransientPublishFailure("media_upload_failed", { http_status: 0 })).toBe(false);
    expect(isTransientPublishFailure("x_media_upload_failed", {})).toBe(false);
  });

  it("never retries credential / validation / approval / permanent-media / policy codes", () => {
    for (const code of [
      "session_missing",
      "session_expired",
      "platform_unauthorized",
      "oauth_reauthorization_required",
      "x_token_invalid",
      "devto_token_missing",
      "x_validation_error",
      "devto_validation_error",
      "body_too_long",
      "missing_body",
      "missing_title",
      "article_title_required",
      "hashnode_title_required",
      "creative_missing_asset",
      "creative_missing_alt_text",
      "approved_shape_stale",
      "media_too_large_for_platform",
      "media_format_unsupported_for_platform",
      "media_video_unsupported",
      "media_animated_gif_unsupported",
      "media_derivative_failed",
      "x_media_upload_unavailable",
      "duplicate_post",
      "platform_not_supported",
      "risk_level_blocked",
      "unknown_error",
      "scheduler_exception",
    ]) {
      expect(isTransientPublishFailure(code, { http_status: 503 })).toBe(false);
    }
  });

  it("never retries outcome-uncertain codes, even with a 5xx/network http_status (PR4)", () => {
    // A retry could duplicate a post that already published — these must
    // be terminal regardless of any metadata that would otherwise look
    // transient.
    for (const code of ["publish_outcome_unknown", "publish_partial_success"]) {
      expect(isTransientPublishFailure(code)).toBe(false);
      expect(isTransientPublishFailure(code, { http_status: 0 })).toBe(false);
      expect(isTransientPublishFailure(code, { http_status: 503 })).toBe(false);
      expect(isTransientPublishFailure(code, { http_status: 500 })).toBe(false);
    }
  });
});

describe("decidePublishRetry — outcome-uncertain codes (PR4)", () => {
  it("does not auto-retry publish_outcome_unknown", () => {
    const d = decidePublishRetry({
      outcome: failed("publish_outcome_unknown", { http_status: 0 }),
      attemptCount: 0,
      maxAttempts: 3,
      now: NOW,
    });
    expect(d.retry).toBe(false);
    // Terminal-non-transient, not "retries exhausted".
    expect(d.retry === false && d.exhausted).toBe(false);
  });

  it("does not auto-retry publish_partial_success (Bluesky partial thread)", () => {
    const d = decidePublishRetry({
      outcome: failed("publish_partial_success", { http_status: 429 }),
      attemptCount: 0,
      maxAttempts: 3,
      now: NOW,
    });
    expect(d.retry).toBe(false);
    expect(d.retry === false && d.exhausted).toBe(false);
  });
});

describe("computeRetryBackoffMinutes", () => {
  it("doubles per attempt, capped at 60m, aligned to the 5m cadence", () => {
    expect(computeRetryBackoffMinutes(1)).toBe(5);
    expect(computeRetryBackoffMinutes(2)).toBe(10);
    expect(computeRetryBackoffMinutes(3)).toBe(20);
    expect(computeRetryBackoffMinutes(4)).toBe(40);
    expect(computeRetryBackoffMinutes(5)).toBe(60); // 80 capped
    expect(computeRetryBackoffMinutes(9)).toBe(60);
  });
});

describe("decidePublishRetry", () => {
  it("retries a transient 5xx within budget and schedules with backoff", () => {
    const d = decidePublishRetry({
      outcome: failed("x_api_error", { http_status: 503 }),
      attemptCount: 0,
      maxAttempts: 3,
      now: NOW,
    });
    expect(d.retry).toBe(true);
    if (d.retry) {
      expect(d.nextAttemptCount).toBe(1);
      expect(d.backoffMinutes).toBe(5);
      expect(d.nextRetryAtIso).toBe("2026-06-13T12:05:00.000Z");
    }
  });

  it("retries a rate limit and a network timeout", () => {
    expect(decidePublishRetry({ outcome: failed("platform_rate_limited"), attemptCount: 1, maxAttempts: 3, now: NOW }).retry).toBe(true);
    expect(decidePublishRetry({ outcome: failed("x_network_error"), attemptCount: 0, maxAttempts: 3, now: NOW }).retry).toBe(true);
  });

  it("does NOT retry invalid token (would loop forever)", () => {
    const d = decidePublishRetry({ outcome: failed("x_token_invalid"), attemptCount: 0, maxAttempts: 3, now: NOW });
    expect(d.retry).toBe(false);
    if (!d.retry) expect(d.exhausted).toBe(false);
  });

  it("does NOT retry a validation error", () => {
    expect(decidePublishRetry({ outcome: failed("x_validation_error"), attemptCount: 0, maxAttempts: 3, now: NOW }).retry).toBe(false);
  });

  it("does NOT retry permanent media-too-large", () => {
    expect(decidePublishRetry({ outcome: failed("media_too_large_for_platform"), attemptCount: 0, maxAttempts: 3, now: NOW }).retry).toBe(false);
  });

  it("retries media_upload_failed only when the failure was a 5xx", () => {
    expect(decidePublishRetry({ outcome: failed("media_upload_failed", { http_status: 502 }), attemptCount: 0, maxAttempts: 3, now: NOW }).retry).toBe(true);
    expect(decidePublishRetry({ outcome: failed("media_upload_failed", { http_status: 0 }), attemptCount: 0, maxAttempts: 3, now: NOW }).retry).toBe(false);
  });

  it("stops at max attempts and flags exhausted (transient case only)", () => {
    const d = decidePublishRetry({
      outcome: failed("platform_rate_limited"),
      attemptCount: 2, // attempt 3 just ran
      maxAttempts: 3,
      now: NOW,
    });
    expect(d.retry).toBe(false);
    if (!d.retry) {
      expect(d.exhausted).toBe(true);
      expect(d.nextAttemptCount).toBe(3);
    }
  });

  it("non-transient failure is terminal but NOT flagged exhausted", () => {
    const d = decidePublishRetry({ outcome: failed("body_too_long"), attemptCount: 0, maxAttempts: 3, now: NOW });
    expect(d.retry).toBe(false);
    if (!d.retry) expect(d.exhausted).toBe(false);
  });

  it("blocked + published + skipped never retry", () => {
    for (const status of ["blocked", "published", "skipped"] as const) {
      const d = decidePublishRetry({
        outcome: { status, reasonCode: "platform_rate_limited" as never, metadata: {} },
        attemptCount: 0,
        maxAttempts: 3,
        now: NOW,
      });
      expect(d.retry).toBe(false);
    }
  });
});

describe("buildRetryMetadata", () => {
  it("captures next_retry_at on retry", () => {
    const d = decidePublishRetry({ outcome: failed("platform_rate_limited"), attemptCount: 0, maxAttempts: 3, now: NOW });
    const m = buildRetryMetadata(d, 3);
    expect(m).toMatchObject({
      attempt_count: 1,
      max_attempts: 3,
      next_retry_at: "2026-06-13T12:05:00.000Z",
      last_reason_code: "platform_rate_limited",
    });
    expect(m.exhausted).toBeUndefined();
  });

  it("flags exhausted with null next_retry_at when budget is spent", () => {
    const d = decidePublishRetry({ outcome: failed("platform_rate_limited"), attemptCount: 2, maxAttempts: 3, now: NOW });
    const m = buildRetryMetadata(d, 3);
    expect(m.next_retry_at).toBeNull();
    expect(m.exhausted).toBe(true);
  });
});
