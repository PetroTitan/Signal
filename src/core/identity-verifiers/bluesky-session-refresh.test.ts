import { describe, expect, it } from "vitest";
import { refreshBlueskySession } from "./bluesky-session";

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

const REFRESH_JWT = "eyJ.refresh.jwt";

describe("refreshBlueskySession — success", () => {
  it("returns fresh accessJwt + refreshJwt + did + handle on success", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        did: "did:plc:abc",
        handle: "webmasterid.bsky.social",
        accessJwt: "eyJ.new.access",
        refreshJwt: "eyJ.new.refresh",
      },
    }));
    const result = await refreshBlueskySession({
      refreshJwt: REFRESH_JWT,
      fetchImpl,
    });
    expect(result.outcome).toBe("refreshed");
    if (result.outcome !== "refreshed") return;
    expect(result.did).toBe("did:plc:abc");
    expect(result.handle).toBe("webmasterid.bsky.social");
    expect(result.accessJwt).toBe("eyJ.new.access");
    expect(result.refreshJwt).toBe("eyJ.new.refresh");
  });

  it("sends the refresh JWT as the Authorization Bearer (not the access JWT)", async () => {
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
    await refreshBlueskySession({ refreshJwt: REFRESH_JWT, fetchImpl });
    expect(captures.length).toBe(1);
    const headers = captures[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${REFRESH_JWT}`);
  });
});

describe("refreshBlueskySession — failure modes", () => {
  it("returns 'refresh_rejected' on 401", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 401,
      body: { error: "ExpiredToken" },
    }));
    const result = await refreshBlueskySession({
      refreshJwt: REFRESH_JWT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("refresh_rejected");
  });

  it("returns 'refresh_rejected' on 400", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 400,
      body: { error: "InvalidRequest" },
    }));
    const result = await refreshBlueskySession({
      refreshJwt: REFRESH_JWT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("refresh_rejected");
  });

  it("returns 'provider_error' on 500", async () => {
    const fetchImpl = makeFetch(() => ({ status: 500, body: {} }));
    const result = await refreshBlueskySession({
      refreshJwt: REFRESH_JWT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'provider_error' on malformed response (missing fields)", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: { did: "did:plc:abc" }, // missing handle/accessJwt/refreshJwt
    }));
    const result = await refreshBlueskySession({
      refreshJwt: REFRESH_JWT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("provider_error");
  });

  it("returns 'network_error' when fetch throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await refreshBlueskySession({
      refreshJwt: REFRESH_JWT,
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("network_error");
  });

  it("returns 'missing_refresh_token' when refresh JWT is empty", async () => {
    const result = await refreshBlueskySession({
      refreshJwt: "",
      fetchImpl: (async () => {
        throw new Error("should not be called");
      }) as typeof fetch,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.code).toBe("missing_refresh_token");
  });
});

describe("refreshBlueskySession — leak guards", () => {
  it("error messages do NOT contain the refresh JWT", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 401,
      body: { error: "ExpiredToken" },
    }));
    const result = await refreshBlueskySession({
      refreshJwt: "VERY-SECRET-REFRESH-JWT-1234",
      fetchImpl,
    });
    expect(result.outcome).toBe("error");
    if (result.outcome !== "error") return;
    expect(result.message).not.toContain("VERY-SECRET-REFRESH-JWT-1234");
  });
});
