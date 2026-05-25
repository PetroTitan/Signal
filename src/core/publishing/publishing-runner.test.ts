import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Regression guard: the runner must forward `db` to the Bluesky
 * orchestrator and ONLY to the Bluesky orchestrator. Other platform
 * cases publish via env credentials or HTTP fetch and don't need a
 * Supabase client.
 */

const blueskyCalls: Array<{ db: SupabaseClient | undefined }> = [];
const otherPlatformCalls: Array<{ name: string }> = [];

vi.mock("./bluesky-publish-orchestrator", () => ({
  publishBlueskyForIdentity: vi.fn(
    async (input: { request: unknown; db?: SupabaseClient }) => {
      blueskyCalls.push({ db: input.db });
      return {
        status: "published",
        reasonCode: "ok",
        reasonDetail: null,
        externalId: null,
        externalUrl: null,
        metadata: {},
      };
    },
  ),
}));

vi.mock("./publish-reddit", () => ({
  publishToReddit: vi.fn(async () => {
    otherPlatformCalls.push({ name: "reddit" });
    return {
      status: "published",
      reasonCode: "ok",
      reasonDetail: null,
      externalId: null,
      externalUrl: null,
      metadata: {},
    };
  }),
}));

// All other platform handlers stay unmocked — we never reach them in
// these tests. The policy gate is bypassed by giving the runner a
// fully "green" context.

vi.mock("./publishing-policy", () => ({
  evaluatePublishingPolicy: vi.fn(() => null),
}));

import { runPublish } from "./publishing-runner";
import type { PublishRequest } from "./publishing-types";

const FAKE_DB = { __sentinel: "service-role" } as unknown as SupabaseClient;

function baseContext() {
  return {
    hasActiveContract: true,
    accountReviewStatus: "confirmed" as const,
    productReviewStatus: "confirmed" as const,
    connectionStatus: "connected" as const,
    hasStoredAccessToken: true,
    scheduledFor: "2026-05-25T19:26:00.000Z",
    nowIso: "2026-05-25T19:27:00.000Z",
    publishingEnabled: true,
    riskLevel: null,
  };
}

function blueskyRequest(): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "bluesky",
    accountId: "acct-1",
    productId: null,
    title: "t",
    body: "b",
    linkUrl: null,
    target: null,
    mode: "live",
  };
}

function redditRequest(): PublishRequest {
  return { ...blueskyRequest(), platform: "reddit", target: "test" };
}

beforeEach(() => {
  blueskyCalls.length = 0;
  otherPlatformCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runPublish — db plumbing", () => {
  it("forwards db to publishBlueskyForIdentity for the bluesky case", async () => {
    await runPublish({
      request: blueskyRequest(),
      context: baseContext(),
      accessToken: null,
      target: null,
      db: FAKE_DB,
    });
    expect(blueskyCalls).toHaveLength(1);
    expect(blueskyCalls[0].db).toBe(FAKE_DB);
  });

  it("publishes via Bluesky with no db when caller omits it (manual path preserved)", async () => {
    await runPublish({
      request: blueskyRequest(),
      context: baseContext(),
      accessToken: null,
      target: null,
    });
    expect(blueskyCalls).toHaveLength(1);
    expect(blueskyCalls[0].db).toBeUndefined();
  });

  it("does not affect the Reddit path — runner ignores db for non-bluesky cases", async () => {
    await runPublish({
      request: redditRequest(),
      context: baseContext(),
      accessToken: "tok",
      target: "test",
      db: FAKE_DB,
    });
    expect(otherPlatformCalls).toEqual([{ name: "reddit" }]);
    expect(blueskyCalls).toHaveLength(0);
  });
});
