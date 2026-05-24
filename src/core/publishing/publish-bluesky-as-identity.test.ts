import { describe, expect, it } from "vitest";
import { publishToBlueskyAsIdentity } from "./publish-bluesky";
import type { PublishRequest } from "./publishing-types";

// ---------------------------------------------------------------------
// Pure-publisher tests. The publisher takes an already-decrypted
// access JWT + DID and posts. These tests verify:
//   - identity A's JWT lands on identity A's repo (DID),
//     identity B's lands on B
//   - the Bearer header carries the JWT we passed in, NEVER an
//     unrelated value
//   - 401 returns the typed `session_expired` outcome (so the
//     orchestrator can decide whether to refresh)
//   - missing inputs short-circuit without making network calls
//   - no JWT or password ever appears in the outcome metadata or
//     error messages
// ---------------------------------------------------------------------

interface CapturedCall {
  url: string;
  init: RequestInit | undefined;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function makeRequest(overrides: Partial<PublishRequest> = {}): PublishRequest {
  const defaults = {
    workspaceId: "ws-1",
    planItemId: "plan-1",
    executionItemId: "exec-1",
    platform: "bluesky",
    accountId: "id-1",
    productId: null,
    title: null,
    body: "Hello from a test.",
    linkUrl: null,
    target: null,
    mode: "live",
    coverImageUrl: null,
    series: null,
  } as PublishRequest;
  return { ...defaults, ...overrides };
}

// Vitest globalThis.fetch stub so the publisher reaches into a known
// fetch impl. The publisher uses global fetch directly — we override
// it per-test via globalThis.
function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

const BASE = {
  accessJwt: "eyJ.session.access",
  did: "did:plc:abc123",
  handle: "webmasterid.bsky.social",
  service: "https://bsky.social",
};

describe("publishToBlueskyAsIdentity — identity scoping", () => {
  it("posts to identity A's DID with identity A's JWT (Bearer header)", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      () => ({
        status: 200,
        body: {
          uri: "at://did:plc:abc123/app.bsky.feed.post/aaa",
          cid: "cid-aaa",
        },
      }),
      captures,
    );
    await withFetch(fetchImpl, () =>
      publishToBlueskyAsIdentity({
        request: makeRequest(),
        ...BASE,
      }),
    );
    expect(captures.length).toBe(1);
    expect(captures[0].url).toContain("/xrpc/com.atproto.repo.createRecord");
    const headers = captures[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${BASE.accessJwt}`);
    // Request body must reference identity A's DID as the repo.
    const body = JSON.parse(captures[0].init?.body as string);
    expect(body.repo).toBe(BASE.did);
  });

  it("identity A and identity B cannot cross-contaminate — each call uses only the (did, accessJwt) it was given", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      (url) =>
        url.includes("did:plc:bbb")
          ? {
              status: 200,
              body: {
                uri: "at://did:plc:bbb/app.bsky.feed.post/zzz",
                cid: "cid-zzz",
              },
            }
          : {
              status: 200,
              body: {
                uri: "at://did:plc:aaa/app.bsky.feed.post/yyy",
                cid: "cid-yyy",
              },
            },
      captures,
    );

    await withFetch(fetchImpl, async () => {
      await publishToBlueskyAsIdentity({
        request: makeRequest({ accountId: "id-A" }),
        accessJwt: "JWT_A",
        did: "did:plc:aaa",
        handle: "alice.bsky.social",
        service: BASE.service,
      });
      await publishToBlueskyAsIdentity({
        request: makeRequest({ accountId: "id-B" }),
        accessJwt: "JWT_B",
        did: "did:plc:bbb",
        handle: "bob.bsky.social",
        service: BASE.service,
      });
    });

    expect(captures.length).toBe(2);
    const headersA = captures[0].init?.headers as Record<string, string>;
    const headersB = captures[1].init?.headers as Record<string, string>;
    expect(headersA.Authorization).toBe("Bearer JWT_A");
    expect(headersB.Authorization).toBe("Bearer JWT_B");
    const bodyA = JSON.parse(captures[0].init?.body as string);
    const bodyB = JSON.parse(captures[1].init?.body as string);
    expect(bodyA.repo).toBe("did:plc:aaa");
    expect(bodyB.repo).toBe("did:plc:bbb");
  });
});

describe("publishToBlueskyAsIdentity — 401 surfaces as session_expired", () => {
  it("returns reasonCode='session_expired' on HTTP 401", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 401,
      body: { error: "ExpiredToken" },
    }));
    const result = await withFetch(fetchImpl, () =>
      publishToBlueskyAsIdentity({ request: makeRequest(), ...BASE }),
    );
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("session_expired");
  });

  it("returns reasonCode='platform_unauthorized' on HTTP 403 (no refresh — refresh won't help)", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 403,
      body: { error: "Forbidden" },
    }));
    const result = await withFetch(fetchImpl, () =>
      publishToBlueskyAsIdentity({ request: makeRequest(), ...BASE }),
    );
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("platform_unauthorized");
  });

  it("returns reasonCode='platform_rate_limited' on 429", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 429,
      body: {},
    }));
    const result = await withFetch(fetchImpl, () =>
      publishToBlueskyAsIdentity({ request: makeRequest(), ...BASE }),
    );
    expect(result.status).toBe("failed");
    expect(result.reasonCode).toBe("platform_rate_limited");
  });
});

describe("publishToBlueskyAsIdentity — input validation", () => {
  it("returns reasonCode='session_missing' when accessJwt is empty", async () => {
    const result = await publishToBlueskyAsIdentity({
      request: makeRequest(),
      accessJwt: "",
      did: BASE.did,
      handle: BASE.handle,
      service: BASE.service,
    });
    expect(result.reasonCode).toBe("session_missing");
  });

  it("returns reasonCode='session_missing' when did is missing", async () => {
    const result = await publishToBlueskyAsIdentity({
      request: makeRequest(),
      accessJwt: BASE.accessJwt,
      did: "",
      handle: BASE.handle,
      service: BASE.service,
    });
    expect(result.reasonCode).toBe("session_missing");
  });

  it("returns reasonCode='missing_body' when body is empty", async () => {
    const result = await publishToBlueskyAsIdentity({
      request: makeRequest({ body: "" }),
      ...BASE,
    });
    expect(result.reasonCode).toBe("missing_body");
  });
});

describe("publishToBlueskyAsIdentity — no secrets leak", () => {
  it("the outcome metadata does NOT contain the access JWT", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 200,
      body: {
        uri: "at://did:plc:abc123/app.bsky.feed.post/x",
        cid: "cid-x",
      },
    }));
    const result = await withFetch(fetchImpl, () =>
      publishToBlueskyAsIdentity({
        request: makeRequest(),
        accessJwt: "VERY-SECRET-JWT-VALUE",
        did: BASE.did,
        handle: BASE.handle,
        service: BASE.service,
      }),
    );
    expect(JSON.stringify(result)).not.toContain("VERY-SECRET-JWT-VALUE");
  });

  it("the 401 outcome metadata does NOT contain the access JWT", async () => {
    const fetchImpl = makeFetch(() => ({
      status: 401,
      body: { error: "ExpiredToken" },
    }));
    const result = await withFetch(fetchImpl, () =>
      publishToBlueskyAsIdentity({
        request: makeRequest(),
        accessJwt: "VERY-SECRET-JWT-VALUE",
        did: BASE.did,
        handle: BASE.handle,
        service: BASE.service,
      }),
    );
    expect(JSON.stringify(result)).not.toContain("VERY-SECRET-JWT-VALUE");
  });
});

describe("publishToBlueskyAsIdentity — no internal retry", () => {
  it("a single 401 results in exactly ONE createRecord call (no internal retry — orchestrator handles refresh)", async () => {
    const captures: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      () => ({ status: 401, body: { error: "ExpiredToken" } }),
      captures,
    );
    await withFetch(fetchImpl, () =>
      publishToBlueskyAsIdentity({ request: makeRequest(), ...BASE }),
    );
    expect(captures.length).toBe(1);
  });
});
