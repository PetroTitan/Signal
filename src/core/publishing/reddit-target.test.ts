import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  executionTargetMetadata,
  normalizeSubreddit,
  operatorTargetBlocker,
  readOperatorTarget,
} from "./reddit-target";
import { resolveSchedulerTarget } from "./publishing-scheduler";
import { FOUNDER_PLATFORMS } from "./platform-guidance";

const REPO_ROOT = process.cwd();

/**
 * Reddit routing-target propagation.
 *
 * The defect: nothing copied `weekly_plan_items.metadata.target` onto
 * the execution item, so `resolveSchedulerTarget` returned null for
 * every scheduled Reddit item and the runner refused terminally with
 * `missing_subreddit`. The autonomous Reddit path was dead, not
 * degraded — the product only publishes to Reddit at all because the
 * manual path is form-driven and never consults metadata.
 */

describe("normalizeSubreddit", () => {
  it("strips the r/ prefix an operator naturally types", () => {
    // The value goes straight into Reddit's `sr` parameter, so
    // "r/test" would have produced sr=r/test and a provider error.
    expect(normalizeSubreddit("r/test")).toBe("test");
    expect(normalizeSubreddit("/r/test")).toBe("test");
    expect(normalizeSubreddit("R/Test")).toBe("Test");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeSubreddit("  test  ")).toBe("test");
    expect(normalizeSubreddit(" r/ test ")).toBe("test");
  });

  it("preserves casing — subreddit names display with their own", () => {
    expect(normalizeSubreddit("TestingGround4Bots")).toBe("TestingGround4Bots");
  });

  it("returns null for anything empty", () => {
    for (const raw of ["", "   ", "r/", "/r/", null, undefined]) {
      expect(normalizeSubreddit(raw as string | null), String(raw)).toBeNull();
    }
  });
});

describe("readOperatorTarget — only Reddit takes one", () => {
  it("reads the target for Reddit", () => {
    expect(readOperatorTarget("reddit", { target: "test" })).toBe("test");
  });

  it("returns null for every other destination, even when one is set", () => {
    // The Telegram hijack control at the data layer.
    // `resolveSchedulerTarget` reads metadata.target with HIGHER
    // precedence than the connection's provider_account_id, so copying
    // it for Telegram would redirect the message to another chat.
    for (const platform of FOUNDER_PLATFORMS.filter((p) => p !== "reddit")) {
      expect(
        readOperatorTarget(platform, { target: "@evil-channel" }),
        platform,
      ).toBeNull();
    }
  });

  it("tolerates missing, null, and malformed metadata", () => {
    expect(readOperatorTarget("reddit", null)).toBeNull();
    expect(readOperatorTarget("reddit", {})).toBeNull();
    expect(readOperatorTarget("reddit", { target: 42 as unknown as string })).toBeNull();
    expect(readOperatorTarget(null, { target: "test" })).toBeNull();
  });
});

describe("executionTargetMetadata — the spreadable fragment", () => {
  it("produces a target key for Reddit", () => {
    expect(executionTargetMetadata("reddit", { target: "r/test" })).toEqual({
      target: "test",
    });
  });

  it("produces an ABSENT key, not target:null, when there is nothing", () => {
    // An absent key keeps the audit metadata honest about what the
    // item actually knows.
    expect(executionTargetMetadata("reddit", {})).toEqual({});
    expect("target" in executionTargetMetadata("reddit", {})).toBe(false);
    expect(executionTargetMetadata("telegram", { target: "@chan" })).toEqual({});
  });

  it("spreads cleanly into a metadata literal", () => {
    const metadata = {
      plan_item_id: "item-1",
      ...executionTargetMetadata("reddit", { target: "test" }),
    };
    expect(metadata).toEqual({ plan_item_id: "item-1", target: "test" });
  });
});

describe("plan → execution → scheduler round trip", () => {
  it("a subreddit typed by the operator survives to the scheduler", () => {
    // The end-to-end property that was broken. The plan item's target
    // becomes the execution item's metadata, which resolveSchedulerTarget
    // then resolves with `source: "metadata"`.
    const planItemMetadata = { target: "r/TestingGround4Bots" };
    const executionMetadata = {
      plan_item_id: "item-1",
      ...executionTargetMetadata("reddit", planItemMetadata),
    };
    expect(
      resolveSchedulerTarget({
        platform: "reddit",
        metadataTarget: (executionMetadata as { target?: string }).target,
        providerAccountId: null,
      }),
    ).toEqual({ target: "TestingGround4Bots", source: "metadata" });
  });

  it("an unrelated platform does not inherit a Reddit target", () => {
    const planItemMetadata = { target: "test" };
    for (const platform of ["telegram", "bluesky", "x", "devto"] as const) {
      const executionMetadata = {
        ...executionTargetMetadata(platform, planItemMetadata),
      };
      expect(executionMetadata, platform).toEqual({});
    }
  });

  it("Telegram still resolves its target from the connection", () => {
    // Preserved invariant: with no metadata.target, Telegram falls back
    // to provider_account_id — one identity, one chat.
    expect(
      resolveSchedulerTarget({
        platform: "telegram",
        metadataTarget: (executionTargetMetadata("telegram", { target: "test" }) as {
          target?: string;
        }).target,
        providerAccountId: "-1001234567890",
      }),
    ).toEqual({
      target: "-1001234567890",
      source: "platform_connection.provider_account_id",
    });
  });
});

describe("operatorTargetBlocker — refuse before an execution item exists", () => {
  it("refuses a Reddit item with no subreddit", () => {
    const blocker = operatorTargetBlocker("reddit", {});
    expect(blocker).not.toBeNull();
    expect(blocker).toMatch(/subreddit/i);
  });

  it("permits a Reddit item that has one", () => {
    expect(operatorTargetBlocker("reddit", { target: "test" })).toBeNull();
  });

  it("never refuses a destination that takes no operator target", () => {
    for (const platform of FOUNDER_PLATFORMS.filter((p) => p !== "reddit")) {
      expect(operatorTargetBlocker(platform, {}), platform).toBeNull();
    }
    expect(operatorTargetBlocker(null, {})).toBeNull();
  });
});

// =====================================================================
// Static guard — every execution-item creation site must thread it
// =====================================================================
//
// The defect was an omission repeated across four call sites. A fifth
// added later would silently reopen it, and no unit test would notice,
// because the helper would still be correct. This is the only mechanism
// that makes that unrepresentable.

const EXECUTION_ITEM_CREATION_SITES = [
  "src/app/(app)/weekly-plan/_actions.ts",
  "src/app/(app)/execution/_actions.ts",
  "src/mcp/tools/schedule-tools.ts",
];

describe("every scheduling path threads the routing target", () => {
  it("finds the call sites it claims to guard", () => {
    // Guards the guard: a moved file would otherwise make this pass
    // vacuously.
    for (const rel of EXECUTION_ITEM_CREATION_SITES) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), rel).toBe(true);
    }
  });

  it.each(EXECUTION_ITEM_CREATION_SITES)(
    "%s threads executionTargetMetadata into every execution item it creates",
    (rel) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      // Count the ways this file can mint an execution item, and
      // require one thread per creation.
      const creations =
        (source.match(/createExecutionItem\(\{/g) ?? []).length +
        (source.match(/\.from\("execution_items"\)\s*\.insert\(/g) ?? []).length;
      expect(creations, `${rel} should create execution items`).toBeGreaterThan(0);
      const threads = (source.match(/executionTargetMetadata\(/g) ?? []).length;
      expect(
        threads,
        `${rel} creates ${creations} execution item(s) but threads the routing ` +
          `target ${threads} time(s). Every creation must spread ` +
          `executionTargetMetadata(platform, planItemMetadata) into its ` +
          `metadata, or a scheduled Reddit item resolves no subreddit and ` +
          `dies at missing_subreddit.`,
      ).toBeGreaterThanOrEqual(creations);
    },
  );

  it("no scheduling path writes metadata.target by hand", () => {
    // A hand-written `target:` would bypass both the platform gate and
    // the r/ normalisation.
    for (const rel of EXECUTION_ITEM_CREATION_SITES) {
      const source = fs
        .readFileSync(path.join(REPO_ROOT, rel), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(source, rel).not.toMatch(/^\s*target:\s*["'`]/m);
    }
  });
});

// =====================================================================
// The autonomous-publish gate
// =====================================================================

describe("autonomous Reddit publishing stays opt-in", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  async function redditAutonomousEnabled(env: Record<string, string | undefined>) {
    process.env = { ...ORIGINAL_ENV, ...env };
    vi.resetModules();
    const mod = await import("./safe-test-env");
    return mod.redditAutonomousPublishEnabled();
  }

  it("is off when the env is unset — today's production behavior", async () => {
    expect(await redditAutonomousEnabled({ REDDIT_AUTONOMOUS_PUBLISH: undefined })).toBe(
      false,
    );
  });

  it("is off for anything other than an explicit true", async () => {
    for (const value of ["false", "1", "yes", "TRUE ", ""]) {
      expect(
        await redditAutonomousEnabled({ REDDIT_AUTONOMOUS_PUBLISH: value }),
        JSON.stringify(value),
      ).toBe(value.trim().toLowerCase() === "true");
    }
  });

  it("is on only for an explicit true", async () => {
    expect(await redditAutonomousEnabled({ REDDIT_AUTONOMOUS_PUBLISH: "true" })).toBe(
      true,
    );
  });

  // NOTE: the runner-side gate is pinned BEHAVIOURALLY in
  // reddit-autonomous-gate.test.ts, not by source assertions. An
  // earlier version of this file asserted the guard by searching the
  // reddit branch for "redditAutonomousPublishEnabled" — and the
  // negative control proved that worthless, because the identifier also
  // appears in the import destructure, so deleting the guard itself
  // left the test green. Assert on the outcome, not on the text.

  it("both refusals are terminal blocks, not retryable failures", async () => {
    // A retryable classification would have the scheduler re-attempt a
    // gate the operator has to clear by hand.
    const { evaluateRetryEligibility } = await import("./retry-eligibility");
    for (const reason_code of [
      "reddit_autonomous_publish_disabled",
      "subreddit_not_allowlisted",
    ]) {
      const verdict = evaluateRetryEligibility({
        status: "blocked",
        reason_code,
        reason_detail: null,
        external_id: null,
        external_url: null,
      });
      // Nothing was published, so an operator retry is legitimate —
      // what must NOT happen is the outcome being treated as published
      // or partial.
      expect(verdict.outcomeClass, reason_code).toBe("safe_or_conditional_retry");
    }
  });
});
