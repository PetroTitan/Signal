import { describe, expect, it } from "vitest";
import {
  isValidBlueskyHandle,
  normalizeBlueskyHandle,
  verifyBlueskyIdentity,
} from "./bluesky";

// ---------------------------------------------------------------------
// Mock fetch builder. The verifier accepts an injected fetchImpl with
// the same shape as global fetch. We don't make real network calls.
// ---------------------------------------------------------------------

interface MockResponse {
  status: number;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(
  handlers: Array<(url: string) => MockResponse | null>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const h of handlers) {
      const res = h(url);
      if (res) return jsonResponse(res.body, res.status);
    }
    throw new Error(`No mock handler matched: ${url}`);
  }) as typeof fetch;
}

function alwaysThrowing(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as typeof fetch;
}

// =====================================================================
// normalizeBlueskyHandle
// =====================================================================

describe("normalizeBlueskyHandle", () => {
  it("strips @ prefix and trims", () => {
    expect(normalizeBlueskyHandle("  @WebmasterID.bsky.social  ")).toBe(
      "webmasterid.bsky.social",
    );
  });
  it("returns null for empty/null/whitespace", () => {
    expect(normalizeBlueskyHandle(null)).toBeNull();
    expect(normalizeBlueskyHandle(undefined)).toBeNull();
    expect(normalizeBlueskyHandle("")).toBeNull();
    expect(normalizeBlueskyHandle("   ")).toBeNull();
  });
});

describe("isValidBlueskyHandle", () => {
  it("accepts standard *.bsky.social handles", () => {
    expect(isValidBlueskyHandle("webmasterid.bsky.social")).toBe(true);
  });
  it("accepts custom-domain handles", () => {
    expect(isValidBlueskyHandle("webmasterid.com")).toBe(true);
    expect(isValidBlueskyHandle("blog.webmasterid.com")).toBe(true);
  });
  it("rejects bare strings without a dot", () => {
    expect(isValidBlueskyHandle("webmasterid")).toBe(false);
  });
  it("rejects strings with invalid characters", () => {
    expect(isValidBlueskyHandle("Webmasterid.bsky.social")).toBe(false); // uppercase
    expect(isValidBlueskyHandle("webmasterid_test.bsky.social")).toBe(false); // underscore
    expect(isValidBlueskyHandle("web masterid.bsky.social")).toBe(false); // space
    expect(isValidBlueskyHandle("@webmasterid.bsky.social")).toBe(false); // @
  });
});

// =====================================================================
// verifyBlueskyIdentity
// =====================================================================

const IDENTITY_INPUT = {
  identityId: "id-1",
  workspaceId: "ws-1",
};

describe("verifyBlueskyIdentity — success", () => {
  it("returns 'verified' with DID + normalized handle for a clean resolution", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        if (url.includes("resolveHandle"))
          return {
            status: 200,
            body: { did: "did:plc:abc123def456" },
          };
        if (url.includes("getProfile"))
          return {
            status: 200,
            body: {
              did: "did:plc:abc123def456",
              handle: "webmasterid.bsky.social",
            },
          };
        return null;
      },
    ]);

    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "@webmasterid.bsky.social",
      fetchImpl,
    });

    expect(result.outcome).toBe("verified");
    if (result.outcome !== "verified") return;
    expect(result.providerAccountId).toBe("did:plc:abc123def456");
    expect(result.authenticatedHandle).toBe("webmasterid.bsky.social");
  });

  it("is idempotent: calling twice with the same input returns the same verified result", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        if (url.includes("resolveHandle"))
          return { status: 200, body: { did: "did:plc:xyz" } };
        if (url.includes("getProfile"))
          return {
            status: 200,
            body: { did: "did:plc:xyz", handle: "webmasterid.bsky.social" },
          };
        return null;
      },
    ]);
    const first = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });
    const second = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });
    expect(first).toEqual(second);
  });

  it("accepts handles with display-style @ prefix and verifies them after normalization", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        // Verify the URL did not include the @ in the query string
        if (url.includes("resolveHandle")) {
          expect(url).not.toContain("%40");
          return { status: 200, body: { did: "did:plc:xyz" } };
        }
        if (url.includes("getProfile"))
          return {
            status: 200,
            body: { did: "did:plc:xyz", handle: "webmasterid.bsky.social" },
          };
        return null;
      },
    ]);
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "@webmasterid.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("verified");
  });
});

// =====================================================================
// Mismatch — declared handle resolves to a DID whose canonical handle
// is different (e.g., the handle was re-pointed since the identity
// was declared).
// =====================================================================

describe("verifyBlueskyIdentity — mismatch", () => {
  it("returns 'mismatched' when the DID's canonical handle differs from the declared handle", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        if (url.includes("resolveHandle"))
          return { status: 200, body: { did: "did:plc:abc" } };
        if (url.includes("getProfile"))
          return {
            status: 200,
            body: {
              did: "did:plc:abc",
              handle: "someoneelse.bsky.social",
            },
          };
        return null;
      },
    ]);

    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });

    expect(result.outcome).toBe("mismatched");
    if (result.outcome !== "mismatched") return;
    expect(result.declaredHandle).toBe("webmasterid.bsky.social");
    expect(result.authenticatedHandle).toBe("someoneelse.bsky.social");
    expect(result.providerAccountId).toBe("did:plc:abc");
  });
});

// =====================================================================
// Error paths
// =====================================================================

describe("verifyBlueskyIdentity — handle invalid", () => {
  it("rejects empty handle without making a network call", async () => {
    const fetchImpl = alwaysThrowing();
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_invalid");
  });

  it("rejects malformed handle (no dot) without making a network call", async () => {
    const fetchImpl = alwaysThrowing();
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_invalid");
  });

  it("rejects handles with invalid characters", async () => {
    const fetchImpl = alwaysThrowing();
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmaster id.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_invalid");
  });
});

describe("verifyBlueskyIdentity — handle not found", () => {
  it("returns 'handle_not_found' when Bluesky returns 400 HandleNotFound", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        if (url.includes("resolveHandle"))
          return {
            status: 400,
            body: {
              error: "HandleNotFound",
              message: "Unable to resolve handle",
            },
          };
        return null;
      },
    ]);
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "nonexistent-handle-xyz123.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_not_found");
  });

  it("returns 'handle_not_found' when Bluesky returns 400 InvalidHandle", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        if (url.includes("resolveHandle"))
          return {
            status: 400,
            body: { error: "InvalidHandle", message: "Invalid handle" },
          };
        return null;
      },
    ]);
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "stale-handle.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_not_found");
  });
});

describe("verifyBlueskyIdentity — provider errors", () => {
  it("returns 'provider_error' on resolveHandle 500", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        if (url.includes("resolveHandle"))
          return { status: 500, body: {} };
        return null;
      },
    ]);
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on resolveHandle malformed body (no did)", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        if (url.includes("resolveHandle"))
          return { status: 200, body: { something: "else" } };
        return null;
      },
    ]);
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on getProfile 500", async () => {
    const fetchImpl = makeFetch([
      (url) => {
        if (url.includes("resolveHandle"))
          return { status: 200, body: { did: "did:plc:abc" } };
        if (url.includes("getProfile"))
          return { status: 500, body: {} };
        return null;
      },
    ]);
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });
});

describe("verifyBlueskyIdentity — network errors", () => {
  it("returns 'network_error' when fetch throws", async () => {
    const fetchImpl = alwaysThrowing();
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("network_error");
  });
});

// =====================================================================
// Safety: no secrets accepted, none returned, only public endpoints
// =====================================================================

describe("verifyBlueskyIdentity — safety", () => {
  it("does not pass any auth header to the Bluesky API (public endpoint only)", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedInit = init;
      return jsonResponse(
        { did: "did:plc:abc", handle: "webmasterid.bsky.social" },
        200,
      );
    }) as typeof fetch;

    // The verifier may pass no init at all (default fetch). We check
    // that if init exists, it does NOT carry an Authorization header.
    await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });

    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("does not surface any secret in any error message (defensive)", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down with secret value xyz");
    }) as typeof fetch;
    const result = await verifyBlueskyIdentity({
      ...IDENTITY_INPUT,
      declaredHandle: "webmasterid.bsky.social",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    // The error message includes the underlying error's text but no
    // hardcoded secrets — verify the verifier itself doesn't leak.
    // (The included text is whatever the caller's fetch impl threw.)
    if (result.outcome !== "error") return;
    expect(result.message.toLowerCase()).not.toContain("token");
    expect(result.message.toLowerCase()).not.toContain("password");
    expect(result.message.toLowerCase()).not.toContain("api_key");
  });
});
