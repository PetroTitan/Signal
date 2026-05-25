import { describe, expect, it } from "vitest";
import {
  ATPROTO_ERROR_BODY_MAX_CHARS,
  formatBlueskyReasonDetail,
  mapBlueskyAtprotoErrorToReasonCode,
  readBlueskyErrorBody,
  redactSensitive,
  type BlueskyErrorBody,
} from "./atproto-error-body";

/**
 * Regression guards for the AT Proto error-body capture helper.
 *
 * Pre-fix, every non-2xx response from bsky.social was rendered as
 * the opaque string "createRecord returned 400" — the actual JSON
 * body containing the structured AT Proto error/message was
 * discarded. These tests pin the capture path and the redaction
 * rules so a future cleanup can't reopen the silent-body gap.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

describe("readBlueskyErrorBody — structured JSON", () => {
  it("extracts atproto_error and atproto_message from a typical 400 body", async () => {
    const resp = jsonResponse(400, {
      error: "InvalidRequest",
      message: "Record/text must not be longer than 300 graphemes",
    });
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_error).toBe("InvalidRequest");
    expect(out.atproto_message).toBe(
      "Record/text must not be longer than 300 graphemes",
    );
    expect(out.atproto_response_body_truncated).toContain("InvalidRequest");
    expect(out.atproto_response_body_was_truncated).toBe(false);
  });

  it("extracts when only `error` is present", async () => {
    const resp = jsonResponse(400, { error: "RateLimitExceeded" });
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_error).toBe("RateLimitExceeded");
    expect(out.atproto_message).toBe(null);
  });

  it("extracts when only `message` is present", async () => {
    const resp = jsonResponse(400, { message: "Something broke" });
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_error).toBe(null);
    expect(out.atproto_message).toBe("Something broke");
  });

  it("ignores non-string error / message fields", async () => {
    const resp = jsonResponse(400, { error: 42, message: { nested: true } });
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_error).toBe(null);
    expect(out.atproto_message).toBe(null);
    // The raw body is still persisted (redacted), so the operator can
    // see whatever non-standard shape came back.
    expect(out.atproto_response_body_truncated).toContain('"error":42');
  });
});

describe("readBlueskyErrorBody — non-JSON / malformed bodies", () => {
  it("captures a plain-text body without throwing", async () => {
    const resp = textResponse(502, "Bad gateway");
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_error).toBe(null);
    expect(out.atproto_message).toBe(null);
    expect(out.atproto_response_body_truncated).toBe("Bad gateway");
  });

  it("handles malformed JSON without throwing", async () => {
    const resp = new Response("{not json", {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_error).toBe(null);
    expect(out.atproto_message).toBe(null);
    expect(out.atproto_response_body_truncated).toBe("{not json");
  });

  it("empty body yields the empty result", async () => {
    const resp = new Response("", { status: 500 });
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_error).toBe(null);
    expect(out.atproto_message).toBe(null);
    expect(out.atproto_response_body_truncated).toBe(null);
    expect(out.atproto_response_body_was_truncated).toBe(false);
  });
});

describe("readBlueskyErrorBody — truncation", () => {
  it("truncates long bodies to ATPROTO_ERROR_BODY_MAX_CHARS", async () => {
    const longBody = "x".repeat(ATPROTO_ERROR_BODY_MAX_CHARS + 500);
    const resp = textResponse(500, longBody);
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_response_body_truncated?.length).toBe(
      ATPROTO_ERROR_BODY_MAX_CHARS,
    );
    expect(out.atproto_response_body_was_truncated).toBe(true);
  });

  it("leaves short bodies untruncated", async () => {
    const resp = textResponse(500, "short error");
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_response_body_was_truncated).toBe(false);
    expect(out.atproto_response_body_truncated).toBe("short error");
  });
});

describe("readBlueskyErrorBody — redaction", () => {
  it("redacts Bearer tokens in the persisted body", async () => {
    const resp = textResponse(
      401,
      "Failed for Bearer abc.def-1234567890.signature_here",
    );
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_response_body_truncated).toContain("Bearer [REDACTED]");
    expect(out.atproto_response_body_truncated).not.toContain(
      "abc.def-1234567890.signature_here",
    );
  });

  it("redacts JWT-shaped strings (eyJ...)", async () => {
    const jwt =
      "eyJ" +
      "A".repeat(40) +
      "." +
      "B".repeat(40) +
      "." +
      "C".repeat(40);
    const resp = textResponse(500, `Some text with ${jwt} embedded`);
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_response_body_truncated).toContain("[REDACTED-JWT]");
    expect(out.atproto_response_body_truncated).not.toContain(jwt);
  });

  it("redacts accessJwt / refreshJwt JSON fields", async () => {
    const body = JSON.stringify({
      error: "InvalidToken",
      accessJwt: "shhh-secret-token",
      refreshJwt: "shhh-refresh-token",
    });
    const resp = textResponse(401, body);
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_response_body_truncated).toContain(
      '"accessJwt":"[REDACTED]"',
    );
    expect(out.atproto_response_body_truncated).toContain(
      '"refreshJwt":"[REDACTED]"',
    );
    expect(out.atproto_response_body_truncated).not.toContain(
      "shhh-secret-token",
    );
    expect(out.atproto_response_body_truncated).not.toContain(
      "shhh-refresh-token",
    );
  });

  it("redacts app_password JSON field", async () => {
    const body = JSON.stringify({
      error: "BadCreds",
      app_password: "abcd-efgh-ijkl-mnop",
    });
    const resp = textResponse(401, body);
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_response_body_truncated).toContain(
      '"app_password":"[REDACTED]"',
    );
    expect(out.atproto_response_body_truncated).not.toContain(
      "abcd-efgh-ijkl-mnop",
    );
  });

  it("redacts Bluesky app-password shape outside JSON quoting", async () => {
    const resp = textResponse(401, "Login as user with abcd-efgh-ijkl-mnop");
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_response_body_truncated).toContain(
      "[REDACTED-APP-PASSWORD]",
    );
  });

  it("redacts Cookie headers if echoed back", async () => {
    const resp = textResponse(500, "Cookie: session=abc; refresh=xyz");
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_response_body_truncated).toContain("Cookie: [REDACTED]");
    expect(out.atproto_response_body_truncated).not.toContain("session=abc");
  });

  it("redacts in extracted atproto_message too (defensive)", async () => {
    const body = {
      error: "BadAuth",
      message: "Bearer eyJabcdefghijklmnopqrstuvwxyz.long.token presented",
    };
    const resp = jsonResponse(401, body);
    const out = await readBlueskyErrorBody(resp);
    expect(out.atproto_message).toContain("Bearer [REDACTED]");
    expect(out.atproto_message).not.toContain("eyJabcdefghijkl");
  });
});

describe("redactSensitive — pure", () => {
  it("is a no-op when no patterns match", () => {
    expect(redactSensitive("plain text")).toBe("plain text");
  });

  it("returns the input unchanged for empty string", () => {
    expect(redactSensitive("")).toBe("");
  });
});

describe("formatBlueskyReasonDetail", () => {
  it("uses both error and message when present", () => {
    const out = formatBlueskyReasonDetail("createRecord", 400, {
      atproto_error: "InvalidRequest",
      atproto_message: "Record/text must not be longer than 300 graphemes",
      atproto_response_body_truncated: "{...}",
      atproto_response_body_was_truncated: false,
    });
    expect(out).toBe(
      "createRecord failed: InvalidRequest — Record/text must not be longer than 300 graphemes",
    );
  });

  it("falls back to error + HTTP status when no message", () => {
    expect(
      formatBlueskyReasonDetail("createRecord", 429, {
        atproto_error: "RateLimitExceeded",
        atproto_message: null,
        atproto_response_body_truncated: null,
        atproto_response_body_was_truncated: false,
      }),
    ).toBe("createRecord failed: RateLimitExceeded (HTTP 429)");
  });

  it("uses message-only when atproto_error is absent", () => {
    expect(
      formatBlueskyReasonDetail("createRecord", 500, {
        atproto_error: null,
        atproto_message: "PDS overloaded",
        atproto_response_body_truncated: null,
        atproto_response_body_was_truncated: false,
      }),
    ).toBe("createRecord failed: PDS overloaded (HTTP 500)");
  });

  it("falls back to the opaque shape when no structured fields", () => {
    expect(
      formatBlueskyReasonDetail("createRecord", 400, {
        atproto_error: null,
        atproto_message: null,
        atproto_response_body_truncated: null,
        atproto_response_body_was_truncated: false,
      }),
    ).toBe("createRecord returned 400");
  });

  it("works for createSession", () => {
    expect(
      formatBlueskyReasonDetail("createSession", 401, {
        atproto_error: "AuthenticationRequired",
        atproto_message: "Invalid identifier or password",
        atproto_response_body_truncated: null,
        atproto_response_body_was_truncated: false,
      }),
    ).toBe(
      "createSession failed: AuthenticationRequired — Invalid identifier or password",
    );
  });
});

// ---------------------------------------------------------------------
// mapBlueskyAtprotoErrorToReasonCode — body error trumps HTTP status
// ---------------------------------------------------------------------
//
// Production audit (2026-05-25): bsky.social returned
//   HTTP 400 {"error":"ExpiredToken","message":"Token has expired"}
// against an identity whose access JWT had aged out. The old
// HTTP-only switch mapped 400 → platform_api_error, so the
// orchestrator's refresh-and-retry path (gated on
// reasonCode === "session_expired") never fired. These tests pin the
// body-trumps-status mapping so the same regression can't reopen.

function body(over: Partial<BlueskyErrorBody> = {}): BlueskyErrorBody {
  return {
    atproto_error: null,
    atproto_message: null,
    atproto_response_body_truncated: null,
    atproto_response_body_was_truncated: false,
    ...over,
  };
}

describe("mapBlueskyAtprotoErrorToReasonCode — body error overrides HTTP status", () => {
  it("ExpiredToken on HTTP 400 → session_expired (the prod case)", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_error: "ExpiredToken" }),
        400,
        "session_expired",
      ),
    ).toBe("session_expired");
  });

  it("InvalidToken on HTTP 400 → session_expired", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_error: "InvalidToken" }),
        400,
        "session_expired",
      ),
    ).toBe("session_expired");
  });

  it("ExpiredToken on HTTP 200 still → session_expired (defensive)", () => {
    // Should never happen — but if AT Proto ever ships an oddity
    // where the status doesn't match the body, the body wins.
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_error: "ExpiredToken" }),
        200,
        "session_expired",
      ),
    ).toBe("session_expired");
  });

  it("AccountTakedown body → platform_unauthorized regardless of status", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_error: "AccountTakedown" }),
        400,
        "session_expired",
      ),
    ).toBe("platform_unauthorized");
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_error: "AccountTakedown" }),
        403,
        "session_expired",
      ),
    ).toBe("platform_unauthorized");
  });

  it("AuthFactorTokenRequired body → platform_unauthorized", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_error: "AuthFactorTokenRequired" }),
        401,
        "session_expired",
      ),
    ).toBe("platform_unauthorized");
  });

  it("generic InvalidRequest body → platform_api_error (HTTP-status fallback)", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_error: "InvalidRequest" }),
        400,
        "session_expired",
      ),
    ).toBe("platform_api_error");
  });

  it("unknown AT Proto error code on 400 falls through to platform_api_error", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_error: "SomeFutureError" }),
        400,
        "session_expired",
      ),
    ).toBe("platform_api_error");
  });
});

describe("mapBlueskyAtprotoErrorToReasonCode — HTTP-status fallback when no body error", () => {
  it("HTTP 401 with no body → default401 (identity path → session_expired)", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(null, 401, "session_expired"),
    ).toBe("session_expired");
  });

  it("HTTP 401 with no body → default401 (legacy path → platform_unauthorized)", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(null, 401, "platform_unauthorized"),
    ).toBe("platform_unauthorized");
  });

  it("HTTP 401 with body that has no error field → default401 still wins", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(
        body({ atproto_message: "Something" }),
        401,
        "session_expired",
      ),
    ).toBe("session_expired");
  });

  it("HTTP 403 → platform_unauthorized", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(null, 403, "session_expired"),
    ).toBe("platform_unauthorized");
  });

  it("HTTP 429 → platform_rate_limited (regardless of default401)", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(null, 429, "session_expired"),
    ).toBe("platform_rate_limited");
    expect(
      mapBlueskyAtprotoErrorToReasonCode(null, 429, "platform_unauthorized"),
    ).toBe("platform_rate_limited");
  });

  it("HTTP 500 with no body → platform_api_error", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(null, 500, "session_expired"),
    ).toBe("platform_api_error");
  });

  it("null errorBody behaves like a body with no error/message", () => {
    expect(
      mapBlueskyAtprotoErrorToReasonCode(null, 400, "session_expired"),
    ).toBe("platform_api_error");
  });
});
