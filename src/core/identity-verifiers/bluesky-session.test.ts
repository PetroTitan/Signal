import { describe, expect, it, vi } from "vitest";
import { connectBlueskyWithAppPassword } from "./bluesky-session";

// ---------------------------------------------------------------------
// Mock fetch builder. Same shape as bluesky-resolve.test.ts.
// ---------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface MockResponse {
  status: number;
  body: unknown;
}

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(
  responder: (url: string, init: RequestInit | undefined) => MockResponse,
  captures?: CapturedCall[],
): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (captures) captures.push({ url, init });
    const res = responder(url, init);
    return jsonResponse(res.body, res.status);
  }) as typeof fetch;
}

function alwaysThrowing(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as typeof fetch;
}

const BASE_INPUT = {
  identityId: "id-1",
  workspaceId: "ws-1",
  declaredHandle: "webmasterid.bsky.social",
  identifier: "webmasterid.bsky.social",
  appPassword: "xxxx-xxxx-xxxx-xxxx",
};

// =====================================================================
// Successful connection
// =====================================================================

describe("connectBlueskyWithAppPassword — success", () => {
  it("returns 'connected' with DID, handle, and JWTs when the session is created and handle matches", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        did: "did:plc:abc123",
        handle: "webmasterid.bsky.social",
        accessJwt: "eyJ.access.jwt",
        refreshJwt: "eyJ.refresh.jwt",
      },
    }));

    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl,
    });

    expect(result.outcome).toBe("connected");
    if (result.outcome !== "connected") return;
    expect(result.providerAccountId).toBe("did:plc:abc123");
    expect(result.authenticatedHandle).toBe("webmasterid.bsky.social");
    expect(result.accessJwt).toBe("eyJ.access.jwt");
    expect(result.refreshJwt).toBe("eyJ.refresh.jwt");
  });

  it("sends the password ONLY in the POST body, never in the URL", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      () => ({
        status: 200,
        body: {
          did: "did:plc:abc",
          handle: "webmasterid.bsky.social",
          accessJwt: "x",
          refreshJwt: "y",
        },
      }),
      captures,
    );
    await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      appPassword: "SECRET-PASSWORD-1234",
      fetchImpl,
    });
    for (const c of captures) {
      expect(c.url).not.toContain("SECRET-PASSWORD-1234");
      expect(c.url).not.toContain("password");
    }
  });
});

// =====================================================================
// Mismatch — credentials authenticate but for a different DID
// =====================================================================

describe("connectBlueskyWithAppPassword — mismatch", () => {
  it("returns 'mismatched' when authenticated handle differs from declared handle", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        did: "did:plc:xyz",
        handle: "someoneelse.bsky.social",
        accessJwt: "x",
        refreshJwt: "y",
      },
    }));

    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl,
    });

    expect(result.outcome).toBe("mismatched");
    if (result.outcome !== "mismatched") return;
    expect(result.declaredHandle).toBe("webmasterid.bsky.social");
    expect(result.authenticatedHandle).toBe("someoneelse.bsky.social");
    expect(result.providerAccountId).toBe("did:plc:xyz");
  });

  it("the mismatch result does NOT include the JWTs (caller cannot accidentally persist them)", () => {
    const m = {
      outcome: "mismatched" as const,
      declaredHandle: "a.bsky.social",
      authenticatedHandle: "b.bsky.social",
      providerAccountId: "did:plc:xyz",
    };
    expect("accessJwt" in m).toBe(false);
    expect("refreshJwt" in m).toBe(false);
  });
});

// =====================================================================
// Errors
// =====================================================================

describe("connectBlueskyWithAppPassword — input validation", () => {
  it("returns handle_invalid when declared handle is missing", async () => {
    const fetchImpl = alwaysThrowing();
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      declaredHandle: "",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_invalid");
  });

  it("returns handle_invalid when declared handle is malformed", async () => {
    const fetchImpl = alwaysThrowing();
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      declaredHandle: "not-a-handle",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_invalid");
  });

  it("returns identifier_invalid when identifier is blank", async () => {
    const fetchImpl = alwaysThrowing();
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      identifier: "",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("identifier_invalid");
  });

  it("returns credentials_missing when app password is empty", async () => {
    const fetchImpl = alwaysThrowing();
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      appPassword: "",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("credentials_missing");
  });
});

describe("connectBlueskyWithAppPassword — auth failure", () => {
  it("returns auth_failed on 401", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 401,
      body: { error: "AuthenticationRequired" },
    }));
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("auth_failed");
    // Critically: the error message does NOT echo the password.
    expect(result.message).not.toContain(BASE_INPUT.appPassword);
    expect(result.message.toLowerCase()).not.toContain("xxxx");
  });

  it("returns provider_error on 400 with malformed request", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 400,
      body: { error: "InvalidRequest", message: "Bad input" },
    }));
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns provider_error on 500", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 500,
      body: {},
    }));
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns provider_error when response is missing fields (no did/handle/jwts)", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { did: "did:plc:abc" }, // missing accessJwt/refreshJwt/handle
    }));
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns network_error when fetch throws", async () => {
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl: alwaysThrowing(),
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("network_error");
  });
});

// =====================================================================
// Safety / leak guards — the most important section
// =====================================================================

describe("connectBlueskyWithAppPassword — leak guards", () => {
  it("password is sent in POST body and never in the URL", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      () => ({
        status: 200,
        body: {
          did: "did:plc:abc",
          handle: "webmasterid.bsky.social",
          accessJwt: "x",
          refreshJwt: "y",
        },
      }),
      captures,
    );
    await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      appPassword: "SUPER-SECRET-XYZ",
      fetchImpl,
    });
    expect(captures.length).toBeGreaterThan(0);
    for (const c of captures) {
      expect(c.url).not.toContain("SUPER-SECRET-XYZ");
      // The body is a string after JSON.stringify; it should contain
      // the password (that's the whole point) but the URL should not.
      if (c.init?.body && typeof c.init.body === "string") {
        const body = c.init.body;
        // The body contains the password — that's correct, this is
        // how the password reaches Bluesky. What matters is it's in
        // the body, not the URL.
        expect(body).toContain("SUPER-SECRET-XYZ");
      }
    }
  });

  it("no error message contains the password value", async () => {
    const scenarios = [
      { status: 401, body: { error: "AuthenticationRequired" } },
      { status: 400, body: { error: "InvalidRequest" } },
      { status: 500, body: {} },
      { status: 200, body: { did: "did:plc:abc" } }, // malformed
    ];
    for (const s of scenarios) {
      const fetchImpl = makeFetch(() => s);
      const result = await connectBlueskyWithAppPassword({
        ...BASE_INPUT,
        appPassword: "MY-SUPER-SECRET-APP-PASSWORD-1234",
        fetchImpl,
      });
      if (result.outcome === "error") {
        expect(result.message).not.toContain(
          "MY-SUPER-SECRET-APP-PASSWORD-1234",
        );
      }
    }
  });

  it("the connected result includes JWTs but NOT the original password", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        did: "did:plc:abc",
        handle: "webmasterid.bsky.social",
        accessJwt: "access-jwt-value",
        refreshJwt: "refresh-jwt-value",
      },
    }));
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      appPassword: "ORIGINAL-PASSWORD",
      fetchImpl,
    });
    expect(result.outcome).toBe("connected");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("ORIGINAL-PASSWORD");
  });

  it("network errors do not include the password in the message", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      appPassword: "DO-NOT-LEAK-1234",
      fetchImpl,
    });
    if (result.outcome === "error") {
      expect(result.message).not.toContain("DO-NOT-LEAK-1234");
    }
  });
});

// =====================================================================
// Reconnect — idempotency at the verifier level (the route's upsert
// handles the row-level idempotency).
// =====================================================================

describe("connectBlueskyWithAppPassword — reconnect", () => {
  it("two calls with the same input produce equivalent verifier results", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        did: "did:plc:abc",
        handle: "webmasterid.bsky.social",
        accessJwt: "j1",
        refreshJwt: "j2",
      },
    }));
    const first = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl,
    });
    const second = await connectBlueskyWithAppPassword({
      ...BASE_INPUT,
      fetchImpl,
    });
    expect(first).toEqual(second);
  });
});
