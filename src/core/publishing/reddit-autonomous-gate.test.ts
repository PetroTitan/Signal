import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The autonomous Reddit publish gate — behavioural, not source-shaped.
 *
 * A first attempt at this pinned the gate with source assertions
 * (`expect(branch).toContain("redditAutonomousPublishEnabled")`). The
 * negative controls exposed that as worthless: the identifier also
 * appears in the import destructure, so deleting the guard itself left
 * the test green. These call `runPublish` and assert on the OUTCOME,
 * with the provider mocked so a regression is observable as "the
 * publisher was called" rather than as a real Reddit post.
 *
 * What is being protected: threading the routing target revived a path
 * that had been fail-closed since it was written, and revived it into a
 * place with none of the manual path's protections — no typed
 * confirmation phrase, no rate limit, no duplicate fingerprint. The
 * gate is the only thing standing between a five-minute cron and a real
 * unattended Reddit post.
 */

const redditCalls: Array<{ subreddit: string }> = [];

vi.mock("./publish-reddit", () => ({
  publishToReddit: vi.fn(async (input: { subreddit: string }) => {
    redditCalls.push({ subreddit: input.subreddit });
    return {
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: "t3_abc",
      externalUrl: "https://reddit.com/r/test/comments/abc",
      metadata: {},
    };
  }),
}));

// Green policy context — this file is about the Reddit branch, not the
// policy gate, which has its own suite.
vi.mock("./publishing-policy", () => ({
  evaluatePublishingPolicy: vi.fn(() => null),
}));

import { runPublish } from "./publishing-runner";
import type { PublishRequest } from "./publishing-types";

const ORIGINAL_ENV = { ...process.env };

function redditRequest(): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "item-1",
    executionItemId: "exec-1",
    platform: "reddit",
    accountId: "acct-1",
    productId: null,
    title: "A title",
    body: "A body",
    linkUrl: null,
    target: "test",
    mode: "live",
  };
}

function context() {
  return {
    accountReviewStatus: "confirmed" as const,
    productReviewStatus: null,
    connectionStatus: "connected" as const,
    hasStoredAccessToken: true,
    scheduledFor: null,
    nowIso: new Date().toISOString(),
    publishingEnabled: true,
    riskLevel: "low" as const,
  };
}

async function run(target: string | null) {
  return runPublish({
    request: redditRequest(),
    context: context(),
    accessToken: "tok",
    target,
  });
}

beforeEach(() => {
  redditCalls.length = 0;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("autonomous Reddit publishing is off by default", () => {
  it("does not call the provider when the opt-in is unset", async () => {
    // This is today's production configuration. The assertion that
    // matters is the second one: no outbound Reddit call.
    delete process.env.REDDIT_AUTONOMOUS_PUBLISH;
    process.env.ALLOWED_TEST_SUBREDDITS = "test";

    const outcome = await run("test");

    expect(redditCalls).toEqual([]);
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("reddit_autonomous_publish_disabled");
  });

  it.each(["false", "1", "yes", ""])(
    "does not call the provider for REDDIT_AUTONOMOUS_PUBLISH=%j",
    async (value) => {
      process.env.REDDIT_AUTONOMOUS_PUBLISH = value;
      process.env.ALLOWED_TEST_SUBREDDITS = "test";

      const outcome = await run("test");

      expect(redditCalls).toEqual([]);
      expect(outcome.status).toBe("blocked");
    },
  );

  it("blocks rather than fails, so no retry budget is consumed", async () => {
    delete process.env.REDDIT_AUTONOMOUS_PUBLISH;
    const outcome = await run("test");
    // `blocked` is terminal and skips decidePublishRetry entirely; a
    // `failed` classification would have the scheduler re-attempt a
    // gate only an operator can clear.
    expect(outcome.status).toBe("blocked");
  });
});

describe("even when enabled, only allow-listed subreddits are posted to", () => {
  it("refuses a subreddit the operator has not listed", async () => {
    // The manual path has always enforced this allowlist
    // (safe-test-policy). The autonomous path now enforces the same
    // rule rather than a weaker one.
    process.env.REDDIT_AUTONOMOUS_PUBLISH = "true";
    process.env.ALLOWED_TEST_SUBREDDITS = "test";

    const outcome = await run("some-other-subreddit");

    expect(redditCalls).toEqual([]);
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasonCode).toBe("subreddit_not_allowlisted");
  });

  it("refuses everything when the allowlist is empty", async () => {
    process.env.REDDIT_AUTONOMOUS_PUBLISH = "true";
    delete process.env.ALLOWED_TEST_SUBREDDITS;

    const outcome = await run("test");

    expect(redditCalls).toEqual([]);
    expect(outcome.reasonCode).toBe("subreddit_not_allowlisted");
  });

  it("publishes when the operator has enabled it AND listed the subreddit", async () => {
    process.env.REDDIT_AUTONOMOUS_PUBLISH = "true";
    process.env.ALLOWED_TEST_SUBREDDITS = "test,testingground4bots";

    const outcome = await run("test");

    expect(redditCalls).toEqual([{ subreddit: "test" }]);
    expect(outcome.status).toBe("published");
  });

  it("matches the allowlist case-insensitively and ignores an r/ prefix", async () => {
    process.env.REDDIT_AUTONOMOUS_PUBLISH = "true";
    process.env.ALLOWED_TEST_SUBREDDITS = "TestingGround4Bots";

    const outcome = await run("testingground4bots");

    expect(outcome.status).toBe("published");
  });
});

describe("the target gate still runs first", () => {
  it("refuses a missing target before consulting the opt-in", async () => {
    // Ordering matters: a targetless item must report the real problem,
    // not "autonomous publishing is off".
    process.env.REDDIT_AUTONOMOUS_PUBLISH = "true";
    process.env.ALLOWED_TEST_SUBREDDITS = "test";

    const outcome = await run(null);

    expect(redditCalls).toEqual([]);
    expect(outcome.reasonCode).toBe("missing_subreddit");
  });
});
