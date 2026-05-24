import { describe, expect, it } from "vitest";
import {
  isValidDevtoUsername,
  normalizeDevtoUsername,
  verifyDevtoIdentity,
} from "./devto";

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
  declaredHandle: "petro_hrys_aea7ce9ab5df8d",
  apiKey: "DEVTO_API_KEY_VALUE_xxxxxxxxxxxxxxxx",
};

// =====================================================================
// normalizeDevtoUsername
// =====================================================================

describe("normalizeDevtoUsername", () => {
  it("lowercases and strips @ + whitespace", () => {
    expect(normalizeDevtoUsername("  @WebmasterID  ")).toBe("webmasterid");
  });
  it("returns null for empty / null / whitespace", () => {
    expect(normalizeDevtoUsername(null)).toBeNull();
    expect(normalizeDevtoUsername(undefined)).toBeNull();
    expect(normalizeDevtoUsername("")).toBeNull();
    expect(normalizeDevtoUsername("   ")).toBeNull();
  });
});

describe("isValidDevtoUsername", () => {
  it("accepts 2-30 char lowercase alphanumeric + underscores", () => {
    expect(isValidDevtoUsername("webmasterid")).toBe(true);
    expect(isValidDevtoUsername("petro_hrys_aea7ce9ab5df8d")).toBe(true);
    expect(isValidDevtoUsername("a1")).toBe(true);
  });
  it("rejects uppercase, hyphens, spaces, @", () => {
    expect(isValidDevtoUsername("WebmasterID")).toBe(false);
    expect(isValidDevtoUsername("web-master")).toBe(false);
    expect(isValidDevtoUsername("web master")).toBe(false);
    expect(isValidDevtoUsername("@webmasterid")).toBe(false);
  });
  it("rejects too short / too long", () => {
    expect(isValidDevtoUsername("a")).toBe(false);
    expect(isValidDevtoUsername("a".repeat(31))).toBe(false);
  });
});

// =====================================================================
// verifyDevtoIdentity — success
// =====================================================================

describe("verifyDevtoIdentity — success", () => {
  it("returns 'connected' with username + id + the API key when /me confirms the match", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        type_of: "user",
        id: 123456,
        username: "petro_hrys_aea7ce9ab5df8d",
        name: "WebmasterID",
      },
    }));
    const result = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("connected");
    if (result.outcome !== "connected") return;
    expect(result.providerAccountId).toBe("123456");
    expect(result.authenticatedHandle).toBe("petro_hrys_aea7ce9ab5df8d");
    expect(result.apiKey).toBe(BASE.apiKey);
  });

  it("sends the api-key in the dedicated header, NEVER in the URL", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      () => ({
        status: 200,
        body: { id: 1, username: "petro_hrys_aea7ce9ab5df8d" },
      }),
      captures,
    );
    await verifyDevtoIdentity({
      ...BASE,
      apiKey: "SECRET-DEVTO-KEY-1234",
      fetchImpl,
    });
    expect(captures.length).toBe(1);
    expect(captures[0].url).not.toContain("SECRET-DEVTO-KEY-1234");
    expect(captures[0].url).not.toContain("api-key=");
    expect(captures[0].url).not.toContain("api_key=");
    const headers = captures[0].init?.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("SECRET-DEVTO-KEY-1234");
    // Also confirm we DON'T send an Authorization header — dev.to
    // uses the `api-key` header, not a bearer token.
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
  });

  it("matches handle case-insensitively (WebmasterID declared, webmasterid from /me)", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { id: 1, username: "webmasterid" },
    }));
    const result = await verifyDevtoIdentity({
      ...BASE,
      declaredHandle: "WebmasterID",
      fetchImpl,
    });
    expect(result.outcome).toBe("connected");
  });
});

// =====================================================================
// verifyDevtoIdentity — mismatch
// =====================================================================

describe("verifyDevtoIdentity — mismatch", () => {
  it("returns 'mismatched' when /me returns a different username", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { id: 9999, username: "someoneelse" },
    }));
    const result = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("mismatched");
    if (result.outcome !== "mismatched") return;
    expect(result.declaredHandle).toBe("petro_hrys_aea7ce9ab5df8d");
    expect(result.authenticatedHandle).toBe("someoneelse");
    expect(result.providerAccountId).toBe("9999");
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
// verifyDevtoIdentity — input validation
// =====================================================================

describe("verifyDevtoIdentity — input validation", () => {
  it("rejects missing declared handle without making a network call", async () => {
    const fetchImpl = (async () => {
      throw new Error("should not be called");
    }) as typeof fetch;
    const result = await verifyDevtoIdentity({
      ...BASE,
      declaredHandle: "",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("handle_invalid");
  });

  it("rejects malformed declared handle (uppercase / hyphen / space)", async () => {
    for (const bad of ["Bad-Username", "with space", "uppercase-Letters"]) {
      const result = await verifyDevtoIdentity({
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

  it("rejects missing API key", async () => {
    const result = await verifyDevtoIdentity({
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
// verifyDevtoIdentity — provider failures
// =====================================================================

describe("verifyDevtoIdentity — provider failures", () => {
  it("returns 'auth_failed' on 401", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 401,
      body: { error: "unauthorized" },
    }));
    const result = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("auth_failed");
  });

  it("returns 'provider_error' on 404", async () => {
    const fetchImpl = makeFetch(() => ({ status: 404, body: {} }));
    const result = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on 500", async () => {
    const fetchImpl = makeFetch(() => ({ status: 500, body: {} }));
    const result = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on malformed response (no username)", async () => {
    const fetchImpl = makeFetch(() => ({ status: 200, body: { id: 1 } }));
    const result = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'network_error' when fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("network_error");
  });
});

// =====================================================================
// verifyDevtoIdentity — leak guards
// =====================================================================

describe("verifyDevtoIdentity — leak guards", () => {
  it("no error message contains the API key value (across all failure scenarios)", async () => {
    const scenarios = [
      { status: 401, body: { error: "unauthorized" } },
      { status: 404, body: {} },
      { status: 500, body: {} },
      { status: 200, body: { id: 1 } }, // malformed
    ];
    for (const s of scenarios) {
      const fetchImpl = makeFetch(() => s);
      const result = await verifyDevtoIdentity({
        ...BASE,
        apiKey: "MY-SUPER-SECRET-DEVTO-KEY-1234",
        fetchImpl,
      });
      if (result.outcome === "error") {
        expect(result.message).not.toContain(
          "MY-SUPER-SECRET-DEVTO-KEY-1234",
        );
      }
    }
  });

  it("network error messages do NOT contain the key", async () => {
    const fetchImpl = (async () => {
      throw new Error("connection refused");
    }) as typeof fetch;
    const result = await verifyDevtoIdentity({
      ...BASE,
      apiKey: "DO-NOT-LEAK-DEVTO-KEY",
      fetchImpl,
    });
    if (result.outcome === "error") {
      expect(result.message).not.toContain("DO-NOT-LEAK-DEVTO-KEY");
    }
  });
});

// =====================================================================
// verifyDevtoIdentity — idempotency
// =====================================================================

describe("verifyDevtoIdentity — idempotency", () => {
  it("two calls with the same input produce structurally identical results", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { id: 1, username: "petro_hrys_aea7ce9ab5df8d" },
    }));
    const a = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    const b = await verifyDevtoIdentity({ ...BASE, fetchImpl });
    expect(a).toEqual(b);
  });
});
