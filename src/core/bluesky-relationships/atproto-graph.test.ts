import { describe, expect, it } from "vitest";
import {
  createFollowRecord,
  deleteFollowRecord,
  getFollowers,
  getRelationships,
  parseRateLimit,
  resolveProfile,
  rkeyFromAtUri,
  GET_RELATIONSHIPS_MAX_OTHERS,
} from "./atproto-graph";

/**
 * The fixtures below are shaped from responses actually observed during
 * the Phase 0 audit against the live API, not invented. Where a value
 * looks odd — `handle.invalid`, an rkey that is a mangled DID — that is
 * because the provider really returns it.
 */

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const stub = (response: Response | (() => Response | Promise<Response>)) =>
  (async () =>
    typeof response === "function" ? response() : response) as unknown as typeof fetch;

describe("parseRateLimit", () => {
  it("reads the headers the PDS actually sends", () => {
    const headers = new Headers({
      "ratelimit-limit": "3000",
      "ratelimit-remaining": "2999",
      "ratelimit-reset": "1789123613",
      "ratelimit-policy": "3000;w=300",
    });
    expect(parseRateLimit(headers)).toEqual({
      limit: 3000,
      remaining: 2999,
      resetAt: 1789123613,
      retryAfterSeconds: null,
    });
  });

  it("returns null when the response carries no limit headers (the AppView)", () => {
    expect(parseRateLimit(new Headers({ "content-type": "application/json" }))).toBeNull();
  });
});

describe("rkeyFromAtUri", () => {
  it("extracts a TID rkey", () => {
    expect(
      rkeyFromAtUri("at://did:plc:abc/app.bsky.graph.follow/zP0yDDN2oUGcWA"),
    ).toBe("zP0yDDN2oUGcWA");
  });

  it("extracts a mangled-DID rkey — the other scheme seen in one response", () => {
    expect(
      rkeyFromAtUri(
        "at://did:plc:mwvlqlznk5sumbuhkf6s7dvm/app.bsky.graph.follow/did_plc_z72i7hdynmk6r22z27h6tvur",
      ),
    ).toBe("did_plc_z72i7hdynmk6r22z27h6tvur");
  });

  it("refuses anything that is not an at:// record URI", () => {
    expect(rkeyFromAtUri("https://bsky.app/profile/x")).toBeNull();
    expect(rkeyFromAtUri("at://did:plc:abc")).toBeNull();
    expect(rkeyFromAtUri("")).toBeNull();
  });
});

describe("resolveProfile", () => {
  it("returns the canonical DID plus metadata", async () => {
    const result = await resolveProfile({
      actor: "bsky.app",
      fetchImpl: stub(
        jsonResponse({
          did: "did:plc:z72i7hdynmk6r22z27h6tvur",
          handle: "bsky.app",
          displayName: "Bluesky",
          avatar: "https://cdn.bsky.app/img/avatar/plain/x",
          followersCount: 34859649,
        }),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.did).toBe("did:plc:z72i7hdynmk6r22z27h6tvur");
    expect(result.profile.followersCount).toBe(34859649);
  });

  it("classifies the provider's 400 'Profile not found' as not_found, not a generic error", async () => {
    const result = await resolveProfile({
      actor: "nope.bsky.social",
      fetchImpl: stub(
        jsonResponse(
          { error: "InvalidRequest", message: "Profile not found" },
          { status: 400 },
        ),
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("not_found");
  });

  it("refuses a 200 that carries no DID rather than inventing one", async () => {
    const result = await resolveProfile({
      actor: "weird.example",
      fetchImpl: stub(jsonResponse({ handle: "weird.example" })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("provider_error");
  });

  it("never throws on a transport failure", async () => {
    const result = await resolveProfile({
      actor: "bsky.app",
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("network");
    expect(result.status).toBe(0);
  });
});

describe("getFollowers", () => {
  it("keeps a profile whose handle is the literal 'handle.invalid'", async () => {
    // The provider really returns this — it is the first follower of
    // bsky.app. Dropping it would discard a real, followable account.
    const result = await getFollowers({
      actor: "bsky.app",
      fetchImpl: stub(
        jsonResponse({
          followers: [
            {
              did: "did:plc:sdo6kumfbnroeho6zllkzc2z",
              handle: "handle.invalid",
              displayName: "Dev Test Account",
            },
          ],
          cursor: "bdaec45f64l2s",
        }),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.followers).toHaveLength(1);
    expect(result.page.followers[0].handle).toBe("handle.invalid");
    expect(result.page.followers[0].did).toBe("did:plc:sdo6kumfbnroeho6zllkzc2z");
  });

  it("skips an entry with no DID rather than keying it by handle", async () => {
    const result = await getFollowers({
      actor: "bsky.app",
      fetchImpl: stub(
        jsonResponse({
          followers: [
            { handle: "no-did.bsky.social", displayName: "No DID" },
            { did: "did:plc:real", handle: "real.bsky.social" },
          ],
          cursor: null,
        }),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.followers.map((f) => f.did)).toEqual(["did:plc:real"]);
  });

  it("reports cursor null when the provider omits it", async () => {
    const result = await getFollowers({
      actor: "bsky.app",
      fetchImpl: stub(jsonResponse({ followers: [] })),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.cursor).toBeNull();
  });

  it("passes the provider's cursor through verbatim and never synthesises one", async () => {
    let requestedUrl = "";
    const result = await getFollowers({
      actor: "bsky.app",
      cursor: "bdaec45f64l2s",
      limit: 5,
      fetchImpl: (async (url: string) => {
        requestedUrl = url;
        return jsonResponse({ followers: [], cursor: "5fkcnydoxrt2h" });
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(requestedUrl).toContain("cursor=bdaec45f64l2s");
    expect(requestedUrl).toContain("limit=5");
  });

  it("clamps limit to the provider's documented maximum of 100", async () => {
    let requestedUrl = "";
    await getFollowers({
      actor: "bsky.app",
      limit: 500,
      fetchImpl: (async (url: string) => {
        requestedUrl = url;
        return jsonResponse({ followers: [] });
      }) as unknown as typeof fetch,
    });
    // 101 is a verified 400 from the provider; we never send one.
    expect(requestedUrl).toContain("limit=100");
  });

  it("classifies HTTP 429 as rate_limited and captures retry-after", async () => {
    const result = await getFollowers({
      actor: "bsky.app",
      fetchImpl: stub(
        jsonResponse(
          { error: "RateLimitExceeded", message: "Rate Limit Exceeded" },
          { status: 429, headers: { "retry-after": "42" } },
        ),
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("rate_limited");
    expect(result.rateLimit?.retryAfterSeconds).toBe(42);
  });
});

describe("getRelationships", () => {
  const ACTOR = "did:plc:actor";

  it("maps `following` present to an edge and captures the record URI", async () => {
    const result = await getRelationships({
      actor: ACTOR,
      others: ["did:plc:a"],
      fetchImpl: stub(
        jsonResponse({
          actor: ACTOR,
          relationships: [
            {
              did: "did:plc:a",
              following: "at://did:plc:actor/app.bsky.graph.follow/3kabc",
              $type: "app.bsky.graph.defs#relationship",
            },
          ],
        }),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const obs = result.observations.get("did:plc:a");
    expect(obs).toMatchObject({
      known: true,
      followingUri: "at://did:plc:actor/app.bsky.graph.follow/3kabc",
      followedByUri: null,
    });
  });

  it("treats an answered object with neither key as a real 'no edge' observation", async () => {
    // Verified live: an unknown DID comes back exactly like this.
    const result = await getRelationships({
      actor: ACTOR,
      others: ["did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"],
      fetchImpl: stub(
        jsonResponse({
          actor: ACTOR,
          relationships: [
            {
              did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
              $type: "app.bsky.graph.defs#relationship",
            },
          ],
        }),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observations.get("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({
      did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
      known: true,
      followingUri: null,
      followedByUri: null,
    });
  });

  it("reports a DID the provider omitted as UNKNOWN, not as absent from the map", async () => {
    const result = await getRelationships({
      actor: ACTOR,
      others: ["did:plc:answered", "did:plc:silent"],
      fetchImpl: stub(
        jsonResponse({
          actor: ACTOR,
          relationships: [{ did: "did:plc:answered" }],
        }),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both requested DIDs are present; the silent one is explicitly
    // unknown so a caller cannot fill the gap with a default.
    expect(result.observations.size).toBe(2);
    expect(result.observations.get("did:plc:silent")).toEqual({
      did: "did:plc:silent",
      known: false,
      reason: "absent",
    });
  });

  it("maps #notFoundActor to unknown with its own reason", async () => {
    const result = await getRelationships({
      actor: ACTOR,
      others: ["gone.bsky.social"],
      fetchImpl: stub(
        jsonResponse({
          actor: ACTOR,
          relationships: [
            {
              actor: "gone.bsky.social",
              notFound: true,
              $type: "app.bsky.graph.defs#notFoundActor",
            },
          ],
        }),
      ),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observations.get("gone.bsky.social")).toEqual({
      did: "gone.bsky.social",
      known: false,
      reason: "not_found_actor",
    });
  });

  it("refuses more than 30 others rather than silently truncating", async () => {
    const others = Array.from({ length: 31 }, (_, i) => `did:plc:${i}`);
    const result = await getRelationships({
      actor: ACTOR,
      others,
      fetchImpl: stub(jsonResponse({ relationships: [] })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain(String(GET_RELATIONSHIPS_MAX_OTHERS));
  });

  it("short-circuits an empty request without contacting the provider", async () => {
    let called = false;
    const result = await getRelationships({
      actor: ACTOR,
      others: [],
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
  });
});

describe("createFollowRecord", () => {
  it("returns the provider's uri, parsed rkey and cid", async () => {
    let sentBody: Record<string, unknown> = {};
    const result = await createFollowRecord({
      accessJwt: "jwt",
      actorDid: "did:plc:actor",
      subjectDid: "did:plc:subject",
      createdAt: "2026-09-11T00:00:00.000Z",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return jsonResponse({
          uri: "at://did:plc:actor/app.bsky.graph.follow/3lmnop",
          cid: "bafyreiabc",
        });
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toEqual({
      uri: "at://did:plc:actor/app.bsky.graph.follow/3lmnop",
      rkey: "3lmnop",
      cid: "bafyreiabc",
    });
    // The record is written to the OPERATOR's repo with the target as
    // subject — never the other way round.
    expect(sentBody.repo).toBe("did:plc:actor");
    expect(sentBody.collection).toBe("app.bsky.graph.follow");
    expect((sentBody.record as Record<string, unknown>).subject).toBe(
      "did:plc:subject",
    );
  });

  it("treats a 2xx with no usable URI as a failure, not a success with a guessed rkey", async () => {
    const result = await createFollowRecord({
      accessJwt: "jwt",
      actorDid: "did:plc:actor",
      subjectDid: "did:plc:subject",
      fetchImpl: stub(jsonResponse({ ok: true })),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("reconciled");
  });

  it("sends the access JWT as a bearer and never in the body", async () => {
    let headers: Record<string, string> = {};
    let body = "";
    await createFollowRecord({
      accessJwt: "secret-jwt",
      actorDid: "did:plc:actor",
      subjectDid: "did:plc:subject",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        body = String(init.body);
        return jsonResponse({ uri: "at://did:plc:actor/app.bsky.graph.follow/x", cid: "c" });
      }) as unknown as typeof fetch,
    });
    expect(headers.Authorization).toBe("Bearer secret-jwt");
    expect(body).not.toContain("secret-jwt");
  });
});

describe("deleteFollowRecord", () => {
  it("refuses without an rkey rather than guessing one", async () => {
    let called = false;
    const result = await deleteFollowRecord({
      accessJwt: "jwt",
      actorDid: "did:plc:actor",
      rkey: "",
      fetchImpl: (async () => {
        called = true;
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Reconcile");
  });

  it("sends repo/collection/rkey and passes a cid as swapRecord", async () => {
    let sentBody: Record<string, unknown> = {};
    const result = await deleteFollowRecord({
      accessJwt: "jwt",
      actorDid: "did:plc:actor",
      rkey: "3lmnop",
      swapCid: "bafyreiabc",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(sentBody).toEqual({
      repo: "did:plc:actor",
      collection: "app.bsky.graph.follow",
      rkey: "3lmnop",
      swapRecord: "bafyreiabc",
    });
  });

  it("omits swapRecord when no cid is known", async () => {
    let sentBody: Record<string, unknown> = {};
    await deleteFollowRecord({
      accessJwt: "jwt",
      actorDid: "did:plc:actor",
      rkey: "3lmnop",
      swapCid: null,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sentBody = JSON.parse(String(init.body));
        return jsonResponse({});
      }) as unknown as typeof fetch,
    });
    expect(sentBody).not.toHaveProperty("swapRecord");
  });

  it("classifies a 401 as auth so the batch stops instead of retrying", async () => {
    const result = await deleteFollowRecord({
      accessJwt: "stale",
      actorDid: "did:plc:actor",
      rkey: "3lmnop",
      fetchImpl: stub(
        jsonResponse(
          { error: "ExpiredToken", message: "Token has expired" },
          { status: 401 },
        ),
      ),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("auth");
  });
});
