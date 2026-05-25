import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishToBluesky, publishToBlueskyAsIdentity } from "./publish-bluesky";
import type { PublishRequest } from "./publishing-types";

/**
 * Regression guards for the AT Proto error-body wiring inside
 * publish-bluesky.ts. The pure helper (`atproto-error-body.ts`) has
 * its own unit tests; these tests pin the *integration* — the
 * publisher must:
 *
 *   - read the error body on non-2xx responses (instead of discarding
 *     it)
 *   - propagate atproto_error / atproto_message / atproto_response_*
 *     fields into PublishOutcome.metadata so applyOutcome can
 *     persist them to execution_logs.metadata
 *   - build reasonDetail from the structured fields ("Bluesky
 *     createRecord failed: InvalidRequest — …") rather than the
 *     opaque "createRecord returned 400"
 *   - never leak the access JWT, app password, or Authorization
 *     header into the persisted metadata
 *   - preserve the success path unchanged
 */

const originalFetch = globalThis.fetch;

const queue: Array<{ url: string; init: RequestInit | undefined; resp: Response }> = [];

function mockFetch() {
  globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch: ${u}`);
    expect(next.url).toBe(u);
    next.init = init;
    return next.resp;
  }) as typeof fetch;
}

function enqueue(url: string, resp: Response) {
  queue.push({ url, init: undefined, resp });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function baseRequest(): PublishRequest {
  return {
    workspaceId: "ws-1",
    planItemId: "pi-1",
    executionItemId: "ei-1",
    platform: "bluesky",
    accountId: "acct-1",
    productId: null,
    title: null,
    body: "Hello world",
    linkUrl: null,
    target: null,
    mode: "live",
  };
}

beforeEach(() => {
  queue.length = 0;
  mockFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------
// publishToBlueskyAsIdentity — the cron / identity path that's
// failing in production today. createPostRecord on a multi-post thread
// receives a 400 from bsky.social; we must capture the body.
// ---------------------------------------------------------------------

describe("publishToBlueskyAsIdentity — createRecord 400 with JSON body", () => {
  it("captures atproto_error, atproto_message, and reasonDetail (the prod-shaped case)", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(400, {
        error: "InvalidRequest",
        message: "Record/text must not be longer than 300 graphemes",
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest(),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.reasonCode).toBe("platform_api_error");
    expect(outcome.reasonDetail).toBe(
      "Bluesky: createRecord failed: InvalidRequest — Record/text must not be longer than 300 graphemes",
    );
    expect(outcome.metadata.atproto_error).toBe("InvalidRequest");
    expect(outcome.metadata.atproto_message).toBe(
      "Record/text must not be longer than 300 graphemes",
    );
    expect(outcome.metadata.http_status).toBe(400);
    expect(outcome.metadata.endpoint).toBe("createRecord");
    expect(outcome.metadata.thread_position_failed).toBe(1);
  });

  it("captures a plain-text body and falls back to opaque detail when no structured fields", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      new Response("Bad gateway", {
        status: 502,
        headers: { "Content-Type": "text/plain" },
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest(),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.reasonCode).toBe("platform_api_error");
    expect(outcome.metadata.atproto_response_body_truncated).toBe("Bad gateway");
    expect(outcome.metadata.atproto_error).toBe(null);
    expect(outcome.metadata.atproto_message).toBe(null);
    expect(outcome.reasonDetail).toContain("Bluesky: createRecord returned 502");
  });

  it("malformed JSON body does not throw — body still captured", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      new Response("{not json", {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest(),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.metadata.atproto_response_body_truncated).toBe("{not json");
    expect(outcome.metadata.atproto_error).toBe(null);
  });

  it("401 returns session_expired with structured detail when AT Proto provides one", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(401, {
        error: "ExpiredToken",
        message: "Token has expired",
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest(),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.reasonCode).toBe("session_expired");
    expect(outcome.metadata.atproto_error).toBe("ExpiredToken");
    expect(outcome.metadata.atproto_message).toBe("Token has expired");
  });

  it("429 captures the rate-limit body", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(429, {
        error: "RateLimitExceeded",
        message: "Slow down",
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest(),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.reasonCode).toBe("platform_rate_limited");
    expect(outcome.metadata.atproto_error).toBe("RateLimitExceeded");
  });
});

describe("publishToBlueskyAsIdentity — no token leakage", () => {
  it("Authorization header value is never persisted in the outcome metadata", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(400, {
        error: "InvalidRequest",
        message: "Record/text must not be longer than 300 graphemes",
      }),
    );

    const accessJwt =
      "eyJtest." + "a".repeat(40) + "." + "b".repeat(40);

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest(),
      accessJwt,
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(accessJwt);
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer eyJ");
  });

  it("body field containing a Bearer-shaped token (server echo) is redacted", async () => {
    // Defensive: if a future PDS echoes the inbound Authorization
    // header (e.g. in a diagnostic message field), the redactor
    // catches it before persistence.
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(401, {
        error: "BadAuth",
        message:
          "Bearer eyJabcdefghijklmnopqrstuvwxyz.long.token presented",
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest(),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.metadata.atproto_message).toContain("Bearer [REDACTED]");
    expect(outcome.metadata.atproto_message).not.toContain(
      "eyJabcdefghijkl",
    );
  });
});

// ---------------------------------------------------------------------
// publishToBluesky (legacy fallback) — createSession failures should
// capture the body too so the operator sees AT Proto's reason.
// ---------------------------------------------------------------------

describe("publishToBluesky (legacy fallback) — createSession 400 with body", () => {
  it("captures structured error from createSession 401", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      jsonResponse(401, {
        error: "AuthenticationRequired",
        message: "Invalid identifier or password",
      }),
    );

    const outcome = await publishToBluesky({
      request: baseRequest(),
      identifier: "ident.bsky.social",
      appPassword: "abcd-efgh-ijkl-mnop",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.reasonCode).toBe("platform_unauthorized");
    expect(outcome.metadata.atproto_error).toBe("AuthenticationRequired");
    expect(outcome.metadata.atproto_message).toBe(
      "Invalid identifier or password",
    );
    expect(outcome.metadata.endpoint).toBe("createSession");
    // The app password must not appear anywhere in the outcome.
    expect(JSON.stringify(outcome)).not.toContain("abcd-efgh-ijkl-mnop");
  });
});

// ---------------------------------------------------------------------
// Success path unchanged
// ---------------------------------------------------------------------

describe("publishToBlueskyAsIdentity — success path", () => {
  it("does not consume an error body and returns the canonical published outcome", async () => {
    enqueue(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      jsonResponse(200, {
        uri: "at://did:plc:test/app.bsky.feed.post/abc",
        cid: "bafycid",
      }),
    );

    const outcome = await publishToBlueskyAsIdentity({
      request: baseRequest(),
      accessJwt: "test-jwt",
      did: "did:plc:test",
      handle: "handle.bsky.social",
      service: "https://bsky.social",
    });

    expect(outcome.status).toBe("published");
    expect(outcome.externalId).toBe("at://did:plc:test/app.bsky.feed.post/abc");
    expect(outcome.metadata.atproto_error).toBeUndefined();
    expect(outcome.metadata.atproto_response_body_truncated).toBeUndefined();
  });
});
