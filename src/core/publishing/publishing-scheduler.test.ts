import { describe, expect, it } from "vitest";
import {
  SCHEDULER_AUTONOMOUS_PLATFORMS,
  nextExecutionStatusForOutcome,
  resolvePublishMode,
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

  it("includes devto (Phase F7.6 hotfix — pre-fix scheduler short-circuited dev.to items to platform_not_supported)", () => {
    // dev.to has a real publisher (PR #118: identity-scoped
    // orchestrator + per-identity encrypted API key + dev.to-prefixed
    // reason codes), so scheduled items MUST route to runPublish.
    // The pre-hotfix scheduler refused them at the allowlist guard,
    // landing the item in execution_items.status="blocked" and
    // weekly_plan_items.status="paused" without ever calling the
    // dev.to API. This test pins the inclusion so a future cleanup
    // can't reopen the same regression for dev.to.
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("devto")).toBe(true);
  });

  it("includes hashnode (Phase F8 — identity-scoped Hashnode publishing)", () => {
    // Hashnode now has a real identity-scoped publisher
    // (hashnode-publish-orchestrator.ts: encrypted per-identity API
    // key + publication_id metadata + Hashnode-prefixed reason
    // codes), so scheduled items MUST route to runPublish. The
    // pre-PR scheduler refused them at the allowlist guard, the
    // same trap dev.to fell into pre-PR #123. This test pins the
    // inclusion so a future cleanup can't reopen the regression
    // for Hashnode.
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("hashnode")).toBe(true);
  });

  it("includes telegram (hotfix: telegram_scheduler_allowlist_missing — pre-fix scheduler short-circuited Telegram items to platform_not_supported BEFORE the runner could route them)", () => {
    // Telegram had a fully-wired publisher (publish-telegram.ts:
    // Bot API sendMessage with admin-only channel publishing) and a
    // runner branch (case "telegram" in publishing-runner.ts since
    // Phase F5.1) — but this allowlist still omitted "telegram", so
    // scheduled items hit the `platform_not_supported` guard at
    // line ~202 and never reached the runner. Same bug class as
    // dev.to (PR #123) and Hashnode (PR #124). Operator-side audits
    // surfaced this as `telegram_scheduler_allowlist_missing`.
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("telegram")).toBe(true);
  });

  it("excludes manual-confirmation-only platforms (youtube, threads, instagram)", () => {
    // These platforms are still routed through manual confirmation
    // at /execution/items/[id]; the scheduler should skip them.
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("youtube")).toBe(false);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("threads")).toBe(false);
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.has("instagram")).toBe(false);
  });

  it("is exactly the seven-platform set today (reddit, x, linkedin, bluesky, devto, hashnode, telegram)", () => {
    expect(SCHEDULER_AUTONOMOUS_PLATFORMS.size).toBe(7);
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
      // Phase F8 — Hashnode-prefixed codes round out the regression
      // matrix so no skip+hashnode_* combination can silently
      // leave the row "scheduled" forever.
      "hashnode_token_missing",
      "hashnode_token_invalid",
      "hashnode_publication_missing",
      "hashnode_requires_article_intent",
      "hashnode_title_required",
      "hashnode_body_required",
      "hashnode_validation_error",
      "hashnode_rate_limited",
      "hashnode_provider_unavailable",
      "hashnode_api_error",
      "hashnode_network_error",
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

// =====================================================================
// resolvePublishMode — workspace publish-mode resolution.
// =====================================================================
//
// Production audit (2026-05-25): the live `workspace_settings` schema
// has NO `execution_mode` column. The pre-fix scheduler treated the
// resulting `undefined` as "not live" and defaulted to dry-run mode,
// so every scheduler-tick publish silently skipped with
// `execution_mode_dry_run`. These tests pin the inverted default so
// the regression can't return.

describe("resolvePublishMode — default is live", () => {
  it("null settings row → live (workspace_settings row missing)", () => {
    expect(resolvePublishMode(null)).toBe("live");
  });

  it("undefined settings → live", () => {
    expect(resolvePublishMode(undefined)).toBe("live");
  });

  it("settings without execution_mode column/field → live (the production case)", () => {
    expect(resolvePublishMode({})).toBe("live");
  });

  it("execution_mode === undefined → live", () => {
    expect(resolvePublishMode({ execution_mode: undefined })).toBe("live");
  });

  it("execution_mode === null → live", () => {
    expect(resolvePublishMode({ execution_mode: null })).toBe("live");
  });
});

describe("resolvePublishMode — explicit dry_run opt-in", () => {
  it("execution_mode === 'dry_run' → dry_run", () => {
    expect(resolvePublishMode({ execution_mode: "dry_run" })).toBe(
      "dry_run",
    );
  });
});

describe("resolvePublishMode — only exact 'dry_run' yields dry_run", () => {
  it.each([
    "live",
    "DRY_RUN",
    "Dry-Run",
    "test",
    "preview",
    "demo",
    "off",
    "",
    " dry_run",
    "dry_run ",
  ])("execution_mode = %j → live (anything other than exact 'dry_run')", (value) => {
    expect(resolvePublishMode({ execution_mode: value })).toBe("live");
  });
});
