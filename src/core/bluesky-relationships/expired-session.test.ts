import { describe, expect, it } from "vitest";
import {
  classifyForTest,
  createFollowRecord,
  deleteFollowRecord,
  isRefreshableAuthFailure,
} from "./atproto-graph";

/**
 * The exact response production returned.
 *
 * On 2026-09-12 a follow against an identity whose access JWT had aged
 * out came back as:
 *
 *     HTTP 400 {"error":"ExpiredToken","message":"Token has expired"}
 *
 * The classifier was keyed on HTTP status — 401/403 meant auth,
 * everything else meant provider_error — so an expired session was
 * reported as a generic provider failure. Nothing marked the connection
 * expired, so Accounts kept saying "Signed in", and the encrypted
 * refresh token was never spent.
 *
 * Every assertion below is written against that literal body.
 */

const EXPIRED_BODY = { error: "ExpiredToken", message: "Token has expired" };
const INVALID_BODY = { error: "InvalidToken", message: "Token could not be verified" };

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const follow = (impl: typeof fetch) =>
  createFollowRecord({
    accessJwt: "jwt-1",
    actorDid: "did:plc:actor",
    subjectDid: "did:plc:subject",
    pds: "https://bsky.social",
    fetchImpl: impl,
  });

const unfollow = (impl: typeof fetch) =>
  deleteFollowRecord({
    accessJwt: "jwt-1",
    actorDid: "did:plc:actor",
    rkey: "3kabc",
    pds: "https://bsky.social",
    fetchImpl: impl,
  });

describe("the production response is classified as a refreshable session", () => {
  it("createRecord: HTTP 400 ExpiredToken is auth, and refreshable", async () => {
    const result = await follow((async () =>
      respond(400, EXPIRED_BODY)) as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // NOT provider_error, which is what a status-keyed switch produced.
    expect(result.kind).toBe("auth");
    expect(result.errorCode).toBe("ExpiredToken");
    expect(isRefreshableAuthFailure(result)).toBe(true);
  });

  it("deleteRecord: the same body, the same verdict", async () => {
    const result = await unfollow((async () =>
      respond(400, EXPIRED_BODY)) as unknown as typeof fetch);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("auth");
    expect(isRefreshableAuthFailure(result)).toBe(true);
  });

  it("InvalidToken takes the same path", async () => {
    for (const call of [follow, unfollow]) {
      const result = await call((async () =>
        respond(400, INVALID_BODY)) as unknown as typeof fetch);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.kind).toBe("auth");
      expect(isRefreshableAuthFailure(result)).toBe(true);
    }
  });

  it("a bare 401 with no AT Proto error is refreshable", async () => {
    const result = await follow((async () =>
      respond(401, {})) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("auth");
    expect(isRefreshableAuthFailure(result)).toBe(true);
  });
});

describe("what must NOT trigger a refresh", () => {
  const cases: [string, number, unknown][] = [
    ["403", 403, {}],
    ["403 with a body", 403, { error: "Forbidden", message: "no" }],
    ["AccountTakedown", 400, { error: "AccountTakedown", message: "taken down" }],
    ["AccountTakedown on 401", 401, { error: "AccountTakedown", message: "taken down" }],
    ["AuthFactorTokenRequired", 401, { error: "AuthFactorTokenRequired", message: "2fa" }],
  ];

  it.each(cases)("%s is auth but never refreshable", async (_name, status, body) => {
    const result = await follow((async () =>
      respond(status, body)) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("auth");
    expect(isRefreshableAuthFailure(result)).toBe(false);
  });

  it("a rate limit is not an auth failure at all", async () => {
    const result = await follow((async () =>
      respond(429, { error: "RateLimitExceeded", message: "slow down" }, {
        "ratelimit-remaining": "0",
        "ratelimit-reset": "1789000000",
      })) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("rate_limited");
    expect(isRefreshableAuthFailure(result)).toBe(false);
  });

  it("a 5xx is a provider error, not a session problem", async () => {
    const result = await follow((async () =>
      respond(502, { error: "InternalServerError" })) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("provider_error");
    expect(isRefreshableAuthFailure(result)).toBe(false);
  });

  it("a transport failure is a network error, not a session problem", async () => {
    const result = await follow((async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("network");
    expect(isRefreshableAuthFailure(result)).toBe(false);
  });

  it("a 400 that is genuinely a bad subject stays not_found", async () => {
    const result = await follow((async () =>
      respond(400, {
        error: "InvalidRequest",
        message: "Unable to resolve handle",
      })) as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("not_found");
  });
});

describe("the defect itself, pinned", () => {
  it("classification is NOT decided by HTTP status", () => {
    // The regression guard the brief asks for: reverting to
    // status-only classification has to fail here. A 400 and a 401
    // carrying the same AT Proto error must reach the same verdict,
    // which is only possible if the body is read first.
    const onFourHundred = classifyForTest(400, EXPIRED_BODY);
    const onFourOhOne = classifyForTest(401, EXPIRED_BODY);
    expect(onFourHundred.kind).toBe(onFourOhOne.kind);
    expect(onFourHundred.kind).toBe("auth");
    expect(onFourHundred.refreshableAuth).toBe(true);

    // And the inverse: the same status with a non-refreshable error
    // must NOT be refreshable, so status cannot be the deciding input
    // in either direction.
    const takedown = classifyForTest(400, {
      error: "AccountTakedown",
      message: "taken down",
    });
    expect(takedown.kind).toBe("auth");
    expect(takedown.refreshableAuth).toBe(false);
  });
});
