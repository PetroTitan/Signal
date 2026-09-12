/**
 * AT Protocol graph client — the provider boundary for relationship
 * actions.
 *
 * Pure modulo the injected `fetchImpl`: no database, no environment
 * reads, no module state, no logging. Every function returns a
 * discriminated union and NEVER throws, so a caller cannot accidentally
 * treat a network failure as an absence of data.
 *
 * Consistent with the rest of Signal's Bluesky code, this is plain
 * fetch against documented XRPC endpoints rather than `@atproto/api` —
 * see `core/publishing/publish-bluesky.ts` for the same decision and
 * the reason (the SDK brings its own auth lifecycle, and Signal already
 * has one).
 *
 * WHERE EACH CALL GOES
 * --------------------
 * Reads  → the public AppView (`public.api.bsky.app`). Unauthenticated,
 *          and crucially it does not consume the operator's PDS rate
 *          budget, so importing a 30k-follower audience cannot starve
 *          the ability to publish.
 * Writes → the operator's PDS (`bsky.social`), authenticated with the
 *          identity's access JWT.
 *
 * THE ONE THING THIS MODULE REFUSES TO DO
 * ---------------------------------------
 * It never converts "I could not find out" into "the answer is no".
 * `getRelationships` returns `unknown` for a DID the provider did not
 * answer for, and every failure path returns a `failed` variant rather
 * than an empty success. The whole relationship model downstream
 * depends on that distinction being preserved here.
 *
 * Verified semantics this file encodes (measured against the live API,
 * see docs/relationships/phase-0-audit.md):
 *
 *   - getFollowers: limit max 100; `limit` is an upper bound and short
 *     pages occur mid-list, so ONLY a missing cursor means exhausted.
 *     An invalid cursor returns 200 with wrong data rather than an
 *     error, so cursors are opaque and only ever echoed back.
 *   - getRelationships: `others` capped at 30. A result object carries
 *     `following` only when the edge exists; its value is the AT-URI of
 *     the follow record. A DID absent from the response is unknown.
 *   - createRecord for app.bsky.graph.follow is NOT idempotent.
 *   - deleteRecord is idempotent ("or ensure it doesn't exist").
 *   - The PDS returns ratelimit-limit / -remaining / -reset headers.
 */

import { mapBlueskyAtprotoErrorToReasonCode } from "@/core/publishing/atproto-error-body";

/** Public AppView. Reads only. */
export const BLUESKY_APPVIEW_DEFAULT = "https://public.api.bsky.app";
/** Operator PDS. Writes only. */
export const BLUESKY_PDS_DEFAULT = "https://bsky.social";

export const FOLLOW_COLLECTION = "app.bsky.graph.follow";

/** Provider maximum, verified: limit=101 → 400 "maximum 100, got 101". */
export const GET_FOLLOWERS_MAX_LIMIT = 100;
/** Provider maximum, verified: 31 others → 400 "maximum 30, got 31". */
export const GET_RELATIONSHIPS_MAX_OTHERS = 30;

// =====================================================================
// Shared failure shape
// =====================================================================

export type GraphFailureKind =
  /** Transport-level: DNS, TLS, connection reset, timeout. */
  | "network"
  /** HTTP 429, or a PDS response whose rate-limit headers are exhausted. */
  | "rate_limited"
  /**
   * The session was rejected.
   *
   * Deliberately no longer described as "401/403". AT Proto returns an
   * expired access token as HTTP 400 with `{"error":"ExpiredToken"}`,
   * so keying on status alone classified a refreshable session as a
   * generic provider error. See `refreshableAuth`.
   */
  | "auth"
  /** The subject could not be resolved (400 InvalidRequest). */
  | "not_found"
  /** Any other non-2xx, or a 2xx whose body did not match the lexicon. */
  | "provider_error";

export interface GraphFailure {
  ok: false;
  kind: GraphFailureKind;
  /** HTTP status, or 0 when the request never produced a response. */
  status: number;
  /** AT Protocol `error` field when the body carried one. */
  errorCode: string | null;
  /** Operator-facing. Never contains a JWT, header, or credential. */
  message: string;
  /** Present when the provider told us when it is safe to resume. */
  rateLimit: RateLimitSnapshot | null;
  /**
   * Only meaningful when `kind === "auth"`.
   *
   * True when exchanging the refresh token could plausibly clear the
   * failure: an expired or invalid access token, or a bare 401 carrying
   * no more specific AT Proto error.
   *
   * False when a refresh cannot help and retrying would be wrong — 403,
   * a taken-down account, or a second factor only the operator can
   * supply. Absent on every non-auth failure.
   */
  refreshableAuth?: boolean;
}

/**
 * Whether one session refresh could plausibly clear this failure.
 *
 * The single place callers should ask. Checking `kind === "auth"` alone
 * would retry an account takedown for ever.
 */
export function isRefreshableAuthFailure(failure: GraphFailure): boolean {
  return failure.kind === "auth" && failure.refreshableAuth === true;
}

/**
 * What the PDS told us about our budget.
 *
 * Used to stop a batch BEFORE the limit is hit rather than discovering
 * it by being refused. This is not evasion: it is respecting a limit
 * the provider publishes, and it makes Signal's request volume lower,
 * not higher.
 */
export interface RateLimitSnapshot {
  limit: number | null;
  remaining: number | null;
  /** Unix seconds, as the provider sends it. */
  resetAt: number | null;
  /** `retry-after` in seconds, when present on a 429. */
  retryAfterSeconds: number | null;
}

export function parseRateLimit(headers: Headers): RateLimitSnapshot | null {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const snapshot: RateLimitSnapshot = {
    limit: num("ratelimit-limit"),
    remaining: num("ratelimit-remaining"),
    resetAt: num("ratelimit-reset"),
    retryAfterSeconds: num("retry-after"),
  };
  const empty =
    snapshot.limit === null &&
    snapshot.remaining === null &&
    snapshot.resetAt === null &&
    snapshot.retryAfterSeconds === null;
  return empty ? null : snapshot;
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: Record<string, unknown> | null;
}

async function request(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; response: RawResponse } | GraphFailure> {
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      status: 0,
      errorCode: null,
      message: `Could not reach Bluesky: ${
        err instanceof Error ? err.message : "unknown network error"
      }.`,
      rateLimit: null,
    };
  }

  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { ok: true, response: { status: res.status, headers: res.headers, body } };
}

/**
 * The classifier, addressable from a test without a live socket.
 *
 * Exported so a regression can pin the property that matters — that the
 * verdict comes from the response BODY, not its HTTP status — by asking
 * the same question at two different statuses.
 */
export function classifyForTest(
  status: number,
  body: Record<string, unknown> | null,
  headers: Headers = new Headers(),
): GraphFailure {
  return classify({ status, headers, body }, "createRecord");
}

function classify(response: RawResponse, endpoint: string): GraphFailure {
  const rateLimit = parseRateLimit(response.headers);
  const errorCode =
    response.body && typeof response.body.error === "string"
      ? response.body.error
      : null;
  const providerMessage =
    response.body && typeof response.body.message === "string"
      ? response.body.message
      : null;

  // 429, or the AT Protocol error name, either of which means "slow
  // down". Both are honoured by stopping, never by retrying faster or
  // by rotating anything.
  if (response.status === 429 || errorCode === "RateLimitExceeded") {
    return {
      ok: false,
      kind: "rate_limited",
      status: response.status,
      errorCode,
      message:
        providerMessage ??
        "Bluesky is rate-limiting this account. Work has been stopped so progress is kept.",
      rateLimit,
    };
  }
  // AUTH, DECIDED BY THE BODY FIRST.
  //
  // Reuses the publishing subsystem's classifier rather than repeating
  // a status or message match here. That module already carries the
  // production evidence for this exact failure: bsky.social returns an
  // expired access token as
  //
  //     HTTP 400 {"error":"ExpiredToken","message":"Token has expired"}
  //
  // so a switch keyed on HTTP status routed it to `provider_error`, no
  // refresh was attempted, and the encrypted refresh token sitting in
  // `platform_connections` was never spent. The publisher hit this and
  // fixed it; relationships and campaigns carried the same bug.
  //
  // `default401: "session_expired"` is correct for every caller here —
  // these are all identity-scoped calls carrying a session JWT, so a
  // bare 401 means that JWT aged out. It is reached only when the body
  // carried no more specific AT Proto error.
  const reason = mapBlueskyAtprotoErrorToReasonCode(
    {
      atproto_error: errorCode,
      atproto_message: providerMessage,
      atproto_response_body_truncated: null,
      atproto_response_body_was_truncated: false,
    },
    response.status,
    "session_expired",
  );
  if (reason === "session_expired" || reason === "platform_unauthorized") {
    const refreshable = reason === "session_expired";
    return {
      ok: false,
      kind: "auth",
      status: response.status,
      errorCode,
      message:
        providerMessage ??
        (refreshable
          ? "Bluesky rejected the session for this identity."
          : "Bluesky refused this account. Signing in again will not clear it."),
      rateLimit,
      refreshableAuth: refreshable,
    };
  }
  // Both "no such handle" and "no such profile" arrive as 400
  // InvalidRequest on this API, not as 404.
  if (
    response.status === 400 &&
    (providerMessage === "Unable to resolve handle" ||
      providerMessage === "Profile not found" ||
      errorCode === "ActorNotFound")
  ) {
    return {
      ok: false,
      kind: "not_found",
      status: response.status,
      errorCode,
      message: providerMessage ?? "That Bluesky account could not be found.",
      rateLimit,
    };
  }
  return {
    ok: false,
    kind: "provider_error",
    status: response.status,
    errorCode,
    message: providerMessage
      ? `Bluesky ${endpoint} failed (HTTP ${response.status}): ${providerMessage}`
      : `Bluesky ${endpoint} failed (HTTP ${response.status}).`,
    rateLimit,
  };
}

// =====================================================================
// Profile resolution
// =====================================================================

export interface BlueskyProfile {
  did: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  followersCount: number | null;
}

export type ResolveProfileResult =
  | { ok: true; profile: BlueskyProfile; rateLimit: RateLimitSnapshot | null }
  | GraphFailure;

/**
 * Resolve a handle OR a DID to canonical profile metadata.
 *
 * `app.bsky.actor.getProfile` accepts either form for `actor` and
 * returns the DID in both cases, so this is one call rather than
 * resolveHandle-then-getProfile.
 *
 * The returned `handle` is deliberately nullable and deliberately NOT
 * validated: the provider legitimately returns the literal string
 * `handle.invalid` for accounts whose handle cannot be verified.
 * Rejecting that would discard a real, followable account. The DID is
 * what matters, and it is the only field this function insists on.
 */
export async function resolveProfile(input: {
  actor: string;
  appView?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResolveProfileResult> {
  const actor = input.actor.trim();
  if (actor.length === 0) {
    return {
      ok: false,
      kind: "not_found",
      status: 0,
      errorCode: null,
      message: "Enter a Bluesky handle or DID.",
      rateLimit: null,
    };
  }
  const appView = input.appView ?? BLUESKY_APPVIEW_DEFAULT;
  const url = `${appView}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`;

  const result = await request(url, { method: "GET" }, input.fetchImpl ?? fetch);
  if (!result.ok) return result;
  const { response } = result;
  if (response.status < 200 || response.status >= 300) {
    return classify(response, "getProfile");
  }

  const body = response.body ?? {};
  const did = typeof body.did === "string" ? body.did : null;
  if (!did || !did.startsWith("did:")) {
    return {
      ok: false,
      kind: "provider_error",
      status: response.status,
      errorCode: null,
      message: "Bluesky returned a profile with no DID.",
      rateLimit: parseRateLimit(response.headers),
    };
  }

  return {
    ok: true,
    profile: {
      did,
      handle: typeof body.handle === "string" ? body.handle : null,
      displayName:
        typeof body.displayName === "string" ? body.displayName : null,
      avatarUrl: typeof body.avatar === "string" ? body.avatar : null,
      followersCount:
        typeof body.followersCount === "number" ? body.followersCount : null,
    },
    rateLimit: parseRateLimit(response.headers),
  };
}

// =====================================================================
// Follower listing
// =====================================================================

export interface FollowerPage {
  followers: BlueskyProfile[];
  /**
   * The provider's continuation token, or null.
   *
   * `null` is the ONLY signal that the list is exhausted. It is not
   * inferable from `followers.length < limit`: walking bsky.app with
   * limit=5 returned pages of 5, 3 and 4 with more data still to come.
   */
  cursor: string | null;
}

export type GetFollowersResult =
  | { ok: true; page: FollowerPage; rateLimit: RateLimitSnapshot | null }
  | GraphFailure;

/**
 * One page of `app.bsky.graph.getFollowers`.
 *
 * `cursor` is passed through verbatim and is only ever a value this API
 * previously handed us. A malformed cursor does not error on this
 * endpoint — it returns HTTP 200 with a different slice of the list —
 * so a synthesised cursor would silently corrupt an import. There is no
 * code path here that builds one.
 */
export async function getFollowers(input: {
  actor: string;
  limit?: number;
  cursor?: string | null;
  appView?: string;
  fetchImpl?: typeof fetch;
}): Promise<GetFollowersResult> {
  const appView = input.appView ?? BLUESKY_APPVIEW_DEFAULT;
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? GET_FOLLOWERS_MAX_LIMIT), 1),
    GET_FOLLOWERS_MAX_LIMIT,
  );
  const params = new URLSearchParams({
    actor: input.actor,
    limit: String(limit),
  });
  if (input.cursor) params.set("cursor", input.cursor);

  const result = await request(
    `${appView}/xrpc/app.bsky.graph.getFollowers?${params.toString()}`,
    { method: "GET" },
    input.fetchImpl ?? fetch,
  );
  if (!result.ok) return result;
  const { response } = result;
  if (response.status < 200 || response.status >= 300) {
    return classify(response, "getFollowers");
  }

  const body = response.body ?? {};
  const raw = Array.isArray(body.followers) ? body.followers : null;
  if (raw === null) {
    return {
      ok: false,
      kind: "provider_error",
      status: response.status,
      errorCode: null,
      message: "Bluesky returned a follower page with no `followers` array.",
      rateLimit: parseRateLimit(response.headers),
    };
  }

  const followers: BlueskyProfile[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const did = typeof e.did === "string" ? e.did : null;
    // A follower with no DID has no identity we can store. Skipping is
    // the honest response; inventing a key from the handle is exactly
    // the mistake this subsystem is built to avoid.
    if (!did || !did.startsWith("did:")) continue;
    followers.push({
      did,
      handle: typeof e.handle === "string" ? e.handle : null,
      displayName: typeof e.displayName === "string" ? e.displayName : null,
      avatarUrl: typeof e.avatar === "string" ? e.avatar : null,
      followersCount: null,
    });
  }

  return {
    ok: true,
    page: {
      followers,
      cursor: typeof body.cursor === "string" && body.cursor.length > 0
        ? body.cursor
        : null,
    },
    rateLimit: parseRateLimit(response.headers),
  };
}

// =====================================================================
// Relationship lookup
// =====================================================================

/**
 * What the provider said about one DID.
 *
 *   `known: false`  — the provider did not answer for this DID (it was
 *                     absent from the response, or came back as
 *                     #notFoundActor). This is NOT "no relationship".
 *   `known: true`   — the provider answered. `followingUri` is set iff
 *                     the edge exists.
 */
export type RelationshipObservation =
  | { did: string; known: false; reason: "absent" | "not_found_actor" }
  | {
      did: string;
      known: true;
      /** AT-URI of OUR follow record, when we follow them. */
      followingUri: string | null;
      /** AT-URI of THEIR follow record, when they follow us. */
      followedByUri: string | null;
    };

export type GetRelationshipsResult =
  | {
      ok: true;
      /** Keyed by DID. Every requested DID appears, possibly as unknown. */
      observations: Map<string, RelationshipObservation>;
      rateLimit: RateLimitSnapshot | null;
    }
  | GraphFailure;

/**
 * `app.bsky.graph.getRelationships` for up to 30 DIDs.
 *
 * The caller gets an entry for EVERY DID it asked about. A DID the
 * provider omitted comes back as `known: false`, because the alternative
 * — leaving it out of the map and letting the caller's `?? notFollowing`
 * fill the gap — is the exact bug that turns an outage into a wave of
 * wrong "not following" rows.
 *
 * Callers with more than 30 DIDs must chunk; this function refuses
 * rather than silently truncating, since a truncated response looks
 * identical to a complete one.
 */
export async function getRelationships(input: {
  actor: string;
  others: string[];
  appView?: string;
  fetchImpl?: typeof fetch;
}): Promise<GetRelationshipsResult> {
  const others = input.others.filter((d) => d.length > 0);
  if (others.length === 0) {
    return { ok: true, observations: new Map(), rateLimit: null };
  }
  if (others.length > GET_RELATIONSHIPS_MAX_OTHERS) {
    return {
      ok: false,
      kind: "provider_error",
      status: 0,
      errorCode: null,
      message: `getRelationships accepts at most ${GET_RELATIONSHIPS_MAX_OTHERS} accounts per call; ${others.length} were requested. Chunk the list.`,
      rateLimit: null,
    };
  }

  const appView = input.appView ?? BLUESKY_APPVIEW_DEFAULT;
  const params = new URLSearchParams({ actor: input.actor });
  for (const did of others) params.append("others", did);

  const result = await request(
    `${appView}/xrpc/app.bsky.graph.getRelationships?${params.toString()}`,
    { method: "GET" },
    input.fetchImpl ?? fetch,
  );
  if (!result.ok) return result;
  const { response } = result;
  if (response.status < 200 || response.status >= 300) {
    return classify(response, "getRelationships");
  }

  const body = response.body ?? {};
  const raw = Array.isArray(body.relationships) ? body.relationships : null;
  if (raw === null) {
    return {
      ok: false,
      kind: "provider_error",
      status: response.status,
      errorCode: null,
      message:
        "Bluesky returned a relationships response with no `relationships` array.",
      rateLimit: parseRateLimit(response.headers),
    };
  }

  const observations = new Map<string, RelationshipObservation>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;

    // #notFoundActor — the provider explicitly could not resolve it.
    if (e.notFound === true) {
      const actorRef = typeof e.actor === "string" ? e.actor : null;
      if (actorRef) {
        observations.set(actorRef, {
          did: actorRef,
          known: false,
          reason: "not_found_actor",
        });
      }
      continue;
    }

    const did = typeof e.did === "string" ? e.did : null;
    if (!did) continue;
    observations.set(did, {
      did,
      known: true,
      followingUri: typeof e.following === "string" ? e.following : null,
      followedByUri: typeof e.followedBy === "string" ? e.followedBy : null,
    });
  }

  // Anything we asked about and did not hear back on is unknown, and
  // says so. Never absent from the map, never defaulted.
  for (const did of others) {
    if (!observations.has(did)) {
      observations.set(did, { did, known: false, reason: "absent" });
    }
  }

  return {
    ok: true,
    observations,
    rateLimit: parseRateLimit(response.headers),
  };
}

// =====================================================================
// Follow — create a record on the operator's PDS
// =====================================================================

export interface FollowRecordIdentity {
  /** at://<actor did>/app.bsky.graph.follow/<rkey> */
  uri: string;
  /** Extracted from the URI. What deleteRecord needs. Never computed. */
  rkey: string;
  cid: string | null;
}

export type CreateFollowResult =
  | { ok: true; record: FollowRecordIdentity; rateLimit: RateLimitSnapshot | null }
  | GraphFailure;

/**
 * Extract the record key from an AT-URI.
 *
 * `at://did:plc:xyz/app.bsky.graph.follow/3kabc` → `3kabc`.
 *
 * This PARSES a provider-issued URI. It is not a derivation: there is no
 * function from a subject DID to an rkey, and observed rkeys in a single
 * provider response used incompatible schemes — `did_plc_z72i7hdy...`
 * (a mangled subject DID) alongside `zP0yDDN2oUGcWA` (a TID). Code that
 * guesses would delete the wrong record on most rows.
 */
export function rkeyFromAtUri(uri: string): string | null {
  if (!uri.startsWith("at://")) return null;
  const segments = uri.slice("at://".length).split("/");
  if (segments.length < 3) return null;
  const rkey = segments[segments.length - 1];
  return rkey.length > 0 ? rkey : null;
}

/**
 * Create an `app.bsky.graph.follow` record.
 *
 * NOT IDEMPOTENT. Each call mints a new rkey, so two calls for one
 * subject leave two live follow records. Callers must therefore never
 * retry a call whose outcome they could not read — see
 * `reconcile.ts`, which reads relationship truth instead.
 */
/**
 * Ask the PDS who this access token belongs to.
 *
 * `com.atproto.server.getSession` is the cheapest call that actually
 * EXERCISES the session: it needs the bearer token and fails the same
 * way a write does when that token has aged out. Resolving the public
 * handle proves only that the account exists — it says nothing about
 * whether Signal can still act as it, which is the question "Check
 * account access" is asking.
 *
 * Cheap on purpose: a read, no write, and no createSession, so
 * repeatedly checking access cannot eat into the account's 300
 * createSession-per-day budget.
 */
export async function getSessionInfo(input: {
  accessJwt: string;
  pds?: string;
  fetchImpl?: typeof fetch;
}): Promise<
  | { ok: true; did: string; handle: string | null; active: boolean }
  | GraphFailure
> {
  const base = input.pds ?? BLUESKY_PDS_DEFAULT;
  const raw = await request(
    `${base}/xrpc/com.atproto.server.getSession`,
    { headers: { authorization: `Bearer ${input.accessJwt}` } },
    input.fetchImpl ?? fetch,
  );
  if (!raw.ok) return raw;
  const { response } = raw;
  if (response.status < 200 || response.status >= 300) {
    return classify(response, "getSession");
  }
  const body = response.body ?? {};
  const did = typeof body.did === "string" ? body.did : null;
  if (!did) {
    return {
      ok: false,
      kind: "provider_error",
      status: response.status,
      errorCode: null,
      message: "Bluesky returned a session without a DID.",
      rateLimit: parseRateLimit(response.headers),
    };
  }
  return {
    ok: true,
    did,
    handle: typeof body.handle === "string" ? body.handle : null,
    // `active: false` means deactivated/taken down. Absent on older
    // PDS builds, where a 2xx is itself the answer.
    active: body.active === undefined ? true : body.active === true,
  };
}

export async function createFollowRecord(input: {
  accessJwt: string;
  /** The operator's DID. This is the repo the record is written to. */
  actorDid: string;
  subjectDid: string;
  createdAt?: string;
  pds?: string;
  fetchImpl?: typeof fetch;
}): Promise<CreateFollowResult> {
  const pds = input.pds ?? BLUESKY_PDS_DEFAULT;
  const result = await request(
    `${pds}/xrpc/com.atproto.repo.createRecord`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        repo: input.actorDid,
        collection: FOLLOW_COLLECTION,
        record: {
          $type: FOLLOW_COLLECTION,
          subject: input.subjectDid,
          createdAt: input.createdAt ?? new Date().toISOString(),
        },
      }),
    },
    input.fetchImpl ?? fetch,
  );
  if (!result.ok) return result;
  const { response } = result;
  if (response.status < 200 || response.status >= 300) {
    return classify(response, "createRecord");
  }

  const body = response.body ?? {};
  const uri = typeof body.uri === "string" ? body.uri : null;
  const rkey = uri ? rkeyFromAtUri(uri) : null;
  if (!uri || !rkey) {
    // A 2xx we cannot read is genuinely ambiguous: the record may well
    // exist. Reporting it as a provider_error (rather than success with
    // a guessed rkey) routes the caller into reconciliation.
    return {
      ok: false,
      kind: "provider_error",
      status: response.status,
      errorCode: null,
      message:
        "Bluesky accepted the follow but returned no usable record URI. The follow may exist; its state must be reconciled before acting again.",
      rateLimit: parseRateLimit(response.headers),
    };
  }

  return {
    ok: true,
    record: {
      uri,
      rkey,
      cid: typeof body.cid === "string" ? body.cid : null,
    },
    rateLimit: parseRateLimit(response.headers),
  };
}

// =====================================================================
// Unfollow — delete the record
// =====================================================================

export type DeleteFollowResult =
  | { ok: true; rateLimit: RateLimitSnapshot | null }
  | GraphFailure;

/**
 * Delete an `app.bsky.graph.follow` record by its record key.
 *
 * The lexicon describes this as "Delete a repository record, or ensure
 * it doesn't exist" — it is idempotent, and deleting an already-absent
 * record is a success.
 *
 * `rkey` is REQUIRED and must have come from the provider (a
 * createRecord response, or `getRelationships().following` parsed by
 * `rkeyFromAtUri`). There is no fallback that constructs one: an
 * idempotent delete aimed at a wrong-but-existing rkey silently removes
 * the wrong relationship, which is worse than refusing.
 *
 * `swapCid`, when supplied, is passed as `swapRecord` so the PDS
 * compare-and-swaps against the exact record Signal created and refuses
 * if it has been replaced.
 */
export async function deleteFollowRecord(input: {
  accessJwt: string;
  actorDid: string;
  rkey: string;
  swapCid?: string | null;
  pds?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeleteFollowResult> {
  if (!input.rkey || input.rkey.length === 0) {
    return {
      ok: false,
      kind: "provider_error",
      status: 0,
      errorCode: null,
      message:
        "No follow-record key is known for this account, so there is nothing safe to delete. Reconcile against Bluesky first.",
      rateLimit: null,
    };
  }

  const pds = input.pds ?? BLUESKY_PDS_DEFAULT;
  const payload: Record<string, unknown> = {
    repo: input.actorDid,
    collection: FOLLOW_COLLECTION,
    rkey: input.rkey,
  };
  if (input.swapCid) payload.swapRecord = input.swapCid;

  const result = await request(
    `${pds}/xrpc/com.atproto.repo.deleteRecord`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.accessJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    input.fetchImpl ?? fetch,
  );
  if (!result.ok) return result;
  const { response } = result;
  if (response.status < 200 || response.status >= 300) {
    return classify(response, "deleteRecord");
  }
  return { ok: true, rateLimit: parseRateLimit(response.headers) };
}
