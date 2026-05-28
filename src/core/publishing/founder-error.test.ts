import { describe, expect, it } from "vitest";
import { friendlyFailure } from "./founder-error";

/**
 * Phase F9 — X publisher reason-code operator-copy regression.
 *
 * The new x-prefixed reason codes from the X publisher + media
 * upload + token refresh flows used to fall through to the generic
 * default ("X didn't publish this post"). This suite pins explicit
 * operator-facing copy per reason code.
 *
 * Only X cases are pinned here. The legacy Reddit / dev.to / Bluesky
 * cases are exercised end-to-end by the publisher suites.
 */

describe("friendlyFailure — X reason codes (Phase F9)", () => {
  it("x_media_upload_unavailable surfaces the tier/scope-specific copy the operator asked for", () => {
    const f = friendlyFailure({
      platform: "x",
      reasonCode: "x_media_upload_unavailable",
      reasonDetail: "tier not enabled",
    });
    expect(f.title).toContain("X");
    expect(f.title.toLowerCase()).toContain("media upload");
    expect(f.advice).toContain("X media upload is unavailable");
    expect(f.advice.toLowerCase()).toContain("tier");
    expect(f.advice.toLowerCase()).toContain("scope");
    expect(f.advice.toLowerCase()).toContain("text publishing may still work");
    expect(f.advice.toLowerCase()).toContain("media upload access");
  });

  it("x_media_upload_failed surfaces the X-supplied detail AND explicitly states 'not silently downgraded'", () => {
    const f = friendlyFailure({
      platform: "x",
      reasonCode: "x_media_upload_failed",
      reasonDetail: "HTTP 503",
    });
    expect(f.advice).toContain("HTTP 503");
    expect(f.advice.toLowerCase()).toContain("not published");
    expect(f.advice.toLowerCase()).toContain("silently downgrade");
  });

  it("x_token_missing / x_token_invalid → 'Reconnect this X identity'", () => {
    for (const code of ["x_token_missing", "x_token_invalid"] as const) {
      const f = friendlyFailure({
        platform: "x",
        reasonCode: code,
        reasonDetail: null,
      });
      expect(f.title).toContain("X");
      expect(f.advice.toLowerCase()).toContain("reconnect");
      expect(f.advice).toContain("Accounts");
    }
  });

  it("x_rate_limited → slow-down advice", () => {
    const f = friendlyFailure({
      platform: "x",
      reasonCode: "x_rate_limited",
      reasonDetail: null,
    });
    expect(f.title.toLowerCase()).toContain("slow down");
    expect(f.advice.toLowerCase()).toContain("wait");
  });

  it("x_validation_error surfaces the X detail", () => {
    const f = friendlyFailure({
      platform: "x",
      reasonCode: "x_validation_error",
      reasonDetail: "Text already published.",
    });
    expect(f.advice).toContain("Text already published.");
  });

  it("x_provider_unavailable / x_network_error → 'try again'", () => {
    for (const code of [
      "x_provider_unavailable",
      "x_network_error",
    ] as const) {
      const f = friendlyFailure({
        platform: "x",
        reasonCode: code,
        reasonDetail: null,
      });
      expect(f.advice.toLowerCase()).toContain("try again");
    }
  });

  it("x_token_refresh_transient → 'scheduler will retry'", () => {
    const f = friendlyFailure({
      platform: "x",
      reasonCode: "x_token_refresh_transient",
      reasonDetail: null,
    });
    expect(f.advice.toLowerCase()).toContain("retry");
  });

  it("oauth_reauthorization_required → 'reconnect this identity'", () => {
    const f = friendlyFailure({
      platform: "x",
      reasonCode: "oauth_reauthorization_required",
      reasonDetail: null,
    });
    expect(f.title.toLowerCase()).toContain("reconnect");
    expect(f.advice.toLowerCase()).toContain("reconnect");
  });
});
