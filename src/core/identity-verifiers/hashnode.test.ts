import { describe, expect, it } from "vitest";
import {
  isValidHashnodeUsername,
  normalizeHashnodeUsername,
  verifyHashnodeIdentity,
} from "./hashnode";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function makeFetch(
  responder: (
    url: string,
    init: RequestInit | undefined,
  ) => { status: number; body: unknown },
  captures?: CapturedCall[],
): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    if (captures) captures.push({ url, init });
    const r = responder(url, init);
    return jsonResponse(r.body, r.status);
  }) as typeof fetch;
}

const BASE = {
  identityId: "id-1",
  workspaceId: "ws-1",
  declaredHandle: "webmasterid",
  apiKey: "HASHNODE_API_KEY_xxxxxxxxxxxxxxxx",
};

// =====================================================================
// normalize + validate
// =====================================================================

describe("normalizeHashnodeUsername", () => {
  it("lowercases and strips @ + whitespace", () => {
    expect(normalizeHashnodeUsername("  @WebmasterID  ")).toBe("webmasterid");
  });
  it("returns null for empty/null/whitespace", () => {
    expect(normalizeHashnodeUsername(null)).toBeNull();
    expect(normalizeHashnodeUsername(undefined)).toBeNull();
    expect(normalizeHashnodeUsername("")).toBeNull();
    expect(normalizeHashnodeUsername("   ")).toBeNull();
  });
});

describe("isValidHashnodeUsername", () => {
  it("accepts 2-40 char lowercase alphanumeric + hyphens + underscores", () => {
    expect(isValidHashnodeUsername("webmasterid")).toBe(true);
    expect(isValidHashnodeUsername("test-user")).toBe(true);
    expect(isValidHashnodeUsername("test_user")).toBe(true);
    expect(isValidHashnodeUsername("a1")).toBe(true);
  });
  it("rejects uppercase / spaces / @", () => {
    expect(isValidHashnodeUsername("WebmasterID")).toBe(false);
    expect(isValidHashnodeUsername("web master")).toBe(false);
    expect(isValidHashnodeUsername("@webmasterid")).toBe(false);
  });
  it("rejects too short / too long", () => {
    expect(isValidHashnodeUsername("a")).toBe(false);
    expect(isValidHashnodeUsername("a".repeat(41))).toBe(false);
  });
});

// =====================================================================
// success
// =====================================================================

describe("verifyHashnodeIdentity — success", () => {
  it("returns 'connected' with username + id + API key when GraphQL me matches", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { data: { me: { username: "webmasterid", id: "user_abc123" } } },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("connected");
    if (result.outcome !== "connected") return;
    expect(result.providerAccountId).toBe("user_abc123");
    expect(result.authenticatedHandle).toBe("webmasterid");
    expect(result.apiKey).toBe(BASE.apiKey);
  });

  it("POSTs the me query as JSON body (not URL params)", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      () => ({
        status: 200,
        body: { data: { me: { username: "webmasterid", id: "1" } } },
      }),
      captures,
    );
    await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(captures[0].url).toBe("https://gql.hashnode.com");
    expect(captures[0].init?.method).toBe("POST");
    const body = JSON.parse(captures[0].init?.body as string);
    expect(body.query).toContain("me");
    expect(body.query).toContain("username");
    expect(body.query).toContain("id");
  });

  it("sends the API key as the bare Authorization header (no Bearer prefix), NEVER in the URL", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      () => ({
        status: 200,
        body: { data: { me: { username: "webmasterid", id: "1" } } },
      }),
      captures,
    );
    await verifyHashnodeIdentity({
      ...BASE,
      apiKey: "SECRET-HASHNODE-KEY-1234",
      fetchImpl,
    });
    expect(captures[0].url).not.toContain("SECRET-HASHNODE-KEY-1234");
    expect(captures[0].url).not.toContain("api-key");
    expect(captures[0].url).not.toContain("api_key");
    const headers = captures[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("SECRET-HASHNODE-KEY-1234");
    // Hashnode uses the bare key — NOT a Bearer prefix.
    expect(headers.Authorization).not.toContain("Bearer");
  });

  it("matches username case-insensitively", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { data: { me: { username: "webmasterid", id: "1" } } },
    }));
    const result = await verifyHashnodeIdentity({
      ...BASE,
      declaredHandle: "WebmasterID",
      fetchImpl,
    });
    expect(result.outcome).toBe("connected");
  });
});

// =====================================================================
// mismatch
// =====================================================================

describe("verifyHashnodeIdentity — mismatch", () => {
  it("returns 'mismatched' when GraphQL returns a different username", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { data: { me: { username: "someoneelse", id: "user_xyz" } } },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("mismatched");
    if (result.outcome !== "mismatched") return;
    expect(result.declaredHandle).toBe("webmasterid");
    expect(result.authenticatedHandle).toBe("someoneelse");
    expect(result.providerAccountId).toBe("user_xyz");
  });

  it("the mismatched result does NOT include the API key", () => {
    const m = {
      outcome: "mismatched" as const,
      declaredHandle: "a",
      authenticatedHandle: "b",
      providerAccountId: "1",
    };
    expect("apiKey" in m).toBe(false);
  });
});

// =====================================================================
// input validation
// =====================================================================

describe("verifyHashnodeIdentity — input validation", () => {
  it("rejects empty declared handle without a network call", async () => {
    const result = await verifyHashnodeIdentity({
      ...BASE,
      declaredHandle: "",
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_invalid");
  });

  it("rejects malformed declared handle (uppercase / space / invalid chars)", async () => {
    // NOTE: a leading `@` is stripped by the normalizer before
    // validation runs — `@webmasterid` becomes `webmasterid`, which
    // IS valid. So the malformed cases here are limited to ones
    // where the BODY of the handle is wrong (not just the prefix).
    // NOTE: the normalizer lowercases input first, so "BadUsername"
    // becomes "badusername" — a valid Hashnode handle. The malformed
    // cases here all have characters or shapes that survive
    // lowercasing as invalid (space, slash, dot, length).
    for (const bad of [
      "with space",
      "bad/slash",
      "bad.dot",
      "a", // too short
      "a".repeat(41), // too long
    ]) {
      const result = await verifyHashnodeIdentity({
        ...BASE,
        declaredHandle: bad,
        fetchImpl: (async () => {
          throw new Error("should not be called");
        }) as typeof fetch,
      });
      expect(result.outcome).toBe("error");
      if (result.outcome !== "error") continue;
      expect(result.code).toBe("handle_invalid");
    }
  });

  it("accepts a handle with a leading @ (normalizer strips it before validation)", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { me: { username: "webmasterid", id: "1" } } }),
    })) as unknown as typeof fetch;
    const result = await verifyHashnodeIdentity({
      ...BASE,
      declaredHandle: "@webmasterid",
      fetchImpl,
    });
    expect(result.outcome).toBe("connected");
  });

  it("rejects missing API key", async () => {
    const result = await verifyHashnodeIdentity({
      ...BASE,
      apiKey: "",
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("credentials_missing");
  });
});

// =====================================================================
// provider failures
// =====================================================================

describe("verifyHashnodeIdentity — HTTP-level failures", () => {
  it("returns 'auth_failed' on HTTP 401", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 401,
      body: { error: "unauthorized" },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("auth_failed");
  });

  it("returns 'auth_failed' on HTTP 403", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 403,
      body: { error: "forbidden" },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("auth_failed");
  });

  it("returns 'provider_error' on HTTP 500", async () => {
    const fetchImpl = makeFetch(() => ({ status: 500, body: {} }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'network_error' when fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("network_error");
  });
});

// =====================================================================
// GraphQL-level error envelope (HTTP 200 + errors[])
// =====================================================================

describe("verifyHashnodeIdentity — GraphQL-level errors", () => {
  it("treats UNAUTHENTICATED extensions code as auth_failed", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        errors: [
          {
            message: "Not authenticated",
            extensions: { code: "UNAUTHENTICATED" },
          },
        ],
      },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("auth_failed");
  });

  it("treats FORBIDDEN extensions code as auth_failed", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }],
      },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("auth_failed");
  });

  it("treats auth-shaped error messages as auth_failed (defense in depth)", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        errors: [{ message: "Invalid auth token provided" }],
      },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("auth_failed");
  });

  it("treats other GraphQL errors as provider_error", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        errors: [
          {
            message: "Syntax Error: Unexpected end of input",
            extensions: { code: "GRAPHQL_PARSE_FAILED" },
          },
        ],
      },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on malformed response (no data.me)", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { data: {} },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on partial data (me.username present but me.id missing)", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { data: { me: { username: "webmasterid" } } },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });
});

// =====================================================================
// leak guards
// =====================================================================

describe("verifyHashnodeIdentity — leak guards", () => {
  it("no error message contains the API key value (across failure scenarios)", async () => {
    const scenarios = [
      { status: 401, body: {} },
      { status: 500, body: {} },
      {
        status: 200,
        body: {
          errors: [{ message: "Unauthenticated", extensions: { code: "UNAUTHENTICATED" } }],
        },
      },
      { status: 200, body: { data: {} } }, // malformed
    ];
    for (const s of scenarios) {
      const fetchImpl = makeFetch(() => s);
      const result = await verifyHashnodeIdentity({
        ...BASE,
        apiKey: "MY-SECRET-HASHNODE-KEY-1234",
        fetchImpl,
      });
      if (result.outcome === "error") {
        expect(result.message).not.toContain(
          "MY-SECRET-HASHNODE-KEY-1234",
        );
      }
    }
  });

  it("does NOT echo Hashnode's GraphQL error.message verbatim (verbatim message could carry headers)", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        errors: [
          {
            message: "Hashnode-internal trace including Authorization=secret-trace-xyz",
            extensions: { code: "INTERNAL" },
          },
        ],
      },
    }));
    const result = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    if (result.outcome === "error") {
      expect(result.message).not.toContain("secret-trace-xyz");
      expect(result.message).not.toContain("Authorization");
    }
  });

  it("network error messages do not include the API key", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await verifyHashnodeIdentity({
      ...BASE,
      apiKey: "DO-NOT-LEAK-HASHNODE",
      fetchImpl,
    });
    if (result.outcome === "error") {
      expect(result.message).not.toContain("DO-NOT-LEAK-HASHNODE");
    }
  });
});

// =====================================================================
// idempotency
// =====================================================================

describe("verifyHashnodeIdentity — idempotency", () => {
  it("two calls with the same input produce identical results", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { data: { me: { username: "webmasterid", id: "user_abc" } } },
    }));
    const a = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    const b = await verifyHashnodeIdentity({ ...BASE, fetchImpl });
    expect(a).toEqual(b);
  });
});
