import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  evaluateRetryEligibility,
  type PersistedPublishOutcome,
} from "@/core/publishing/retry-eligibility";
import { isTransientPublishFailure } from "@/core/publishing/publish-retry-policy";

/**
 * P0.2 — cross-path retry firewall coverage.
 *
 * PR4 stopped the SCHEDULER auto-retrying unknown outcomes. The audit
 * found four sibling paths that could still re-publish an item, each
 * gating on `execution_items.status` alone:
 *
 *   - the operator "Try again"           (_actions.ts)
 *   - the weekly-plan "Schedule retry"   (_actions.ts) — mints a NEW
 *     execution_item, so the scheduler's own protection never sees it
 *   - MCP signal.schedule_publish        (fresh-insert branch)
 *   - the manual publish actions
 *
 * `status = 'failed'` collapses "the provider refused before writing
 * anything" and "the provider may have published and we never heard
 * back" into one value. These tests assert that each path consults the
 * shared predicate instead, and that the scheduler's independent policy
 * agrees with it on the classes that must never auto-retry.
 */

const REPO_ROOT = process.cwd();

/** Paths that can cause an item to be published again. */
const RETRY_ENTRY_POINTS: ReadonlyArray<{ file: string; what: string }> = [
  {
    file: "src/app/(app)/execution/items/[id]/_actions.ts",
    what: 'operator "Try again"',
  },
  {
    file: "src/app/(app)/weekly-plan/_actions.ts",
    what: 'weekly-plan "Schedule retry" (mints a new execution_item)',
  },
  {
    file: "src/mcp/tools/schedule-tools.ts",
    what: "MCP signal.schedule_publish fresh-insert branch",
  },
];

describe("retry firewall — every entry point consults the shared predicate", () => {
  it.each(RETRY_ENTRY_POINTS)(
    "$what consults evaluateRetryEligibility",
    ({ file }) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(source).toContain("evaluateRetryEligibility");
    },
  );

  it("no entry point re-implements the outcome classification locally", () => {
    // A second copy of these reason codes outside the predicate is the
    // drift this milestone exists to remove — it is how PR4's fix ended
    // up on one path only.
    const offenders: string[] = [];
    for (const { file } of RETRY_ENTRY_POINTS) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
      if (
        source.includes('"publish_outcome_unknown"') ||
        source.includes('"publish_partial_success"')
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("retry firewall — agreement with the scheduler's retry policy", () => {
  const UNCERTAIN: ReadonlyArray<PersistedPublishOutcome> = [
    { status: "failed", reason_code: "publish_outcome_unknown" },
    { status: "failed", reason_code: "publish_partial_success" },
  ];

  it("the classes the predicate refuses are also non-transient to the scheduler", () => {
    // Two independent implementations must not disagree about the
    // outcomes that may never be repeated. The predicate governs WHO
    // may retry; publish-retry-policy governs backoff and budget — but
    // on C and D they must both say no.
    for (const o of UNCERTAIN) {
      const eligibility = evaluateRetryEligibility(o);
      expect(eligibility.automaticRetryAllowed).toBe(false);

      // Even with metadata that would otherwise read as transient.
      expect(
        isTransientPublishFailure(o.reason_code as never, { http_status: 0 }),
      ).toBe(false);
      expect(
        isTransientPublishFailure(o.reason_code as never, { http_status: 503 }),
      ).toBe(false);
    }
  });

  it("an ordinary transient failure is retryable under both", () => {
    const eligibility = evaluateRetryEligibility({
      status: "failed",
      reason_code: "platform_rate_limited",
    });
    expect(eligibility.automaticRetryAllowed).toBe(true);
    expect(isTransientPublishFailure("platform_rate_limited", {})).toBe(true);
  });
});

describe("unknown-outcome classification at the publishers", () => {
  /**
   * A non-idempotent CREATE whose response never arrived must emit a
   * class-C code. Before P0.2, Bluesky/Reddit/Telegram emitted
   * `platform_api_error`, which the retry policy treats as transient
   * when http_status is 0 — so the scheduler re-ran the publish and
   * could duplicate a live post.
   */
  const PUBLISHERS = [
    "publish-bluesky.ts",
    "publish-reddit.ts",
    "publish-telegram.ts",
  ] as const;

  it.each(PUBLISHERS)(
    "%s classifies a dispatched-but-unanswered request as publish_outcome_unknown",
    (file) => {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, "src", "core", "publishing", file),
        "utf8",
      );
      expect(source).toContain("publish_outcome_unknown");
    },
  );

  it("X, dev.to and Hashnode retain the class-C codes PR4 gave them", () => {
    for (const file of ["publish-x.ts", "publish-devto.ts", "publish-hashnode.ts"]) {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, "src", "core", "publishing", file),
        "utf8",
      );
      expect(source).toContain("publish_outcome_unknown");
    }
  });
});
